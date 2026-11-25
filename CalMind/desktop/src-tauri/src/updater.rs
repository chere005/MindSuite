// The shared updater for the Tauri shells (CalMind, MealMind, AcctMind, PlanMind, TaskMind).
// BYTE-IDENTICAL in every shell: edit CalMind's copy (the origin in tools/shared-files.json) and copy it out with
// `node tools/check-shared.mjs --fix desktop-src-tauri-src-updater-rs`.
//
// WHAT IT IS. A thin, strict wrapper over tauri-plugin-updater 2.14 (which does the download, the minisign check,
// the version-binding check and the app swap) that adds: a "Check for Updates..." menu item; a background check a
// few seconds after launch and every day after that (not in `manual_only` mode, which AcctMind uses); native
// confirm/inform dialogs (the remote-page shells have no IPC to draw their own); a refusal to run unless the config
// is the strict one; a download size cap; quiet failure; and, on macOS, a check of the downloaded bundle before the
// plugin installs it.
//
// WHAT IT REFUSES, whatever the feed says:
//   - a config without `requireSignedVersion: true` (a feed could otherwise re-announce an old, validly signed
//     archive as a newer version), without a pubkey, with a non-https endpoint, with `dangerous*` flags or
//     `allowDowngrades`: the updater is then simply off and says why on stderr;
//   - an announced version that is not strictly newer than the running one (checked here AND by the plugin);
//   - a download that fails the signature or the signed-version check (the plugin), or is bigger than `max_download`;
//   - macOS: a bundle whose CFBundleIdentifier is not this app's, whose version is not the announced one, or that
//     does not satisfy the running app's designated requirement. When the running copy has no usable requirement the
//     update is REFUSED (fail closed): an ad hoc copy (a dev build) accepts only a Developer ID signature of the team
//     named by the compile-time env MINDSUITE_UPDATE_TEAM_ID (unset: it accepts none); an unsigned or unreadable
//     copy accepts none. A stolen update key alone then ships nothing;
//   - a check or a download that stalls: each network request has a hard timeout (`check_timeout`, `download_timeout`),
//     so the one-check-at-a-time marker is always released and the daily check keeps running.
//
// QUIET. Network, feed, signature and install errors never interrupt a background check: they go to stderr only. A
// MANUAL check (the menu item) says what happened, in plain words.
//
// WIRING (per app; PlanMind/TaskMind put it in lib.rs, the others in main.rs):
//   #[cfg(desktop)] mod updater;
//   ...setup(|app| { #[cfg(desktop)] updater::init(app, updater::Options::default())?; ... build the window ...; Ok(()) })
//   Options { manual_only: true, ..Options::default() }   // AcctMind: the menu item only, no background check
// plus the Cargo dependencies and the `plugins.updater` block in tauri.conf.json that docs/PUBLISH.md ("Updates")
// lists. Call `init` BEFORE the window is built so the window gets the menu. Mobile builds do not compile this.
//
// Tests run against a local fixture feed and a mock app; nothing leaves the machine: `cargo test` in a shell that
// carries this file, or `bash tools/ci/test-updater.sh` at the suite root (a harness crate that includes this very
// file). The menu item needs AppKit's main thread, so only a launched app shows it.
#![allow(dead_code)]

use std::future::Future;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, MenuItemKind, HELP_SUBMENU_ID};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{UpdaterBuilder, UpdaterExt};

/// The menu item's id.
pub const MENU_ID: &str = "mindsuite-check-for-updates";
const MENU_TEXT: &str = "Check for Updates\u{2026}";

/// Only macOS and Windows have a feed entry; Linux builds keep the download page.
pub const fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trigger {
    /// The person chose the menu item: every result is reported.
    Manual,
    /// The timer: only a real update interrupts.
    Background,
}

/// How strictly the downloaded macOS bundle is inspected before the plugin installs it. `Off` exists for tests that
/// install an unsigned fixture; no config can reach it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleCheck {
    Strict,
    Off,
}

#[derive(Clone)]
pub struct Options {
    /// No background check at all (AcctMind): only the menu item asks.
    pub manual_only: bool,
    pub first_check_delay: Duration,
    pub interval: Duration,
    /// Hard cap on the bytes downloaded; the download is dropped when it is passed.
    pub max_download: u64,
    /// Total time allowed for the feed request, and for the archive download (a stalled connection ends in a failure).
    pub check_timeout: Duration,
    pub download_timeout: Duration,
    pub bundle_check: BundleCheck,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            manual_only: false,
            first_check_delay: Duration::from_secs(10),
            interval: Duration::from_secs(24 * 60 * 60),
            max_download: 256 * 1024 * 1024,
            check_timeout: Duration::from_secs(30),
            download_timeout: Duration::from_secs(10 * 60),
            bundle_check: BundleCheck::Strict,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Not supported here, or the config is not the strict one (the reason).
    Disabled(String),
    /// A background check in `manual_only` mode: nothing was requested.
    Skipped,
    /// Another check is running.
    Busy,
    UpToDate,
    /// An update exists and the person said Later.
    Declined(String),
    /// Installed (the version); the app was asked to restart.
    Installed(String),
    /// Quiet failure (the reason; shown only for a manual check).
    Failed(String),
}

/// What the person sees. The production one draws native dialogs; tests record.
pub trait Ui: Send + Sync {
    /// "Version X is available. Install and restart?" `notes` is plain text.
    fn confirm(&self, version: &str, notes: &str) -> bool;
    fn inform(&self, title: &str, message: &str);
    /// The update is installed: restart into it.
    fn restart(&self);
}

pub struct DialogUi<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> DialogUi<R> {
    pub fn new(app: &AppHandle<R>) -> Self {
        DialogUi { app: app.clone() }
    }
}

impl<R: Runtime> Ui for DialogUi<R> {
    fn confirm(&self, version: &str, notes: &str) -> bool {
        let name = self.app.package_info().name.clone();
        let mut text = format!("{name} {version} is available.");
        if !notes.is_empty() {
            text.push_str("\n\n");
            text.push_str(notes);
        }
        self.app
            .dialog()
            .message(text)
            .title("Update available")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into()))
            .blocking_show()
    }
    fn inform(&self, title: &str, message: &str) {
        self.app.dialog().message(message).title(title).kind(MessageDialogKind::Info).blocking_show();
    }
    fn restart(&self) {
        self.app.restart();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

fn parse_version(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// `candidate` is strictly newer than `current`. Either one unparsable means no.
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some(c), Some(n)) => n > c,
        _ => false,
    }
}

/// Release notes as plain text: tags and control characters removed, whitespace collapsed, capped.
pub fn plain_notes(notes: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in notes.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            '\n' | '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 600 {
        let cut: String = collapsed.chars().take(600).collect();
        format!("{cut}\u{2026}")
    } else {
        collapsed
    }
}

fn flag(cfg: &serde_json::Value, camel: &str, kebab: &str) -> bool {
    cfg.get(camel).or_else(|| cfg.get(kebab)).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Is `plugins.updater` the strict config this module insists on? `Err` says why not.
/// `strict_transport` is false only under `cargo test`, where the fixture feed is plain http on 127.0.0.1.
pub fn guard_config(cfg: Option<&serde_json::Value>, strict_transport: bool) -> Result<(), String> {
    let cfg = cfg.ok_or("plugins.updater is not configured")?;
    let pubkey = cfg.get("pubkey").and_then(|v| v.as_str()).unwrap_or("");
    if pubkey.trim().is_empty() {
        return Err("plugins.updater.pubkey is empty".into());
    }
    if !flag(cfg, "requireSignedVersion", "require-signed-version") {
        return Err("plugins.updater.requireSignedVersion must be true".into());
    }
    if flag(cfg, "allowDowngrades", "allow-downgrades") {
        return Err("plugins.updater.allowDowngrades must not be set".into());
    }
    if flag(cfg, "dangerousAcceptInvalidCerts", "dangerous-accept-invalid-certs")
        || flag(cfg, "dangerousAcceptInvalidHostnames", "dangerous-accept-invalid-hostnames")
    {
        return Err("plugins.updater carries a dangerous TLS flag".into());
    }
    if strict_transport && flag(cfg, "dangerousInsecureTransportProtocol", "dangerous-insecure-transport-protocol") {
        return Err("plugins.updater allows an insecure transport".into());
    }
    let endpoints = cfg.get("endpoints").and_then(|v| v.as_array()).ok_or("plugins.updater.endpoints is missing")?;
    if endpoints.is_empty() {
        return Err("plugins.updater.endpoints is empty".into());
    }
    if strict_transport && !endpoints.iter().all(|e| e.as_str().is_some_and(|s| s.starts_with("https://"))) {
        return Err("every updater endpoint must be https".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Registration, menu, background loop
// ---------------------------------------------------------------------------------------------------------------

/// Marks a check in flight, per app.
#[derive(Default)]
struct Busy(AtomicBool);

/// Clears the marker when the check ends however it ends (a panic included), so one failure cannot stop every later check.
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Register the updater and dialog plugins and the busy marker. Refuses (Err) on a config the guard rejects, so the
/// updater plugin's own config parsing never runs on a missing or lax block.
pub fn install_plugins<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    guard_config(app.config().plugins.0.get("updater"), !cfg!(test))?;
    app.plugin(tauri_plugin_updater::Builder::new().build()).map_err(|e| e.to_string())?;
    app.plugin(tauri_plugin_dialog::init()).map_err(|e| e.to_string())?;
    app.manage(Busy::default());
    Ok(())
}

/// Wire the updater into the app: plugins, the menu item, and (unless `manual_only`) the background check. A config
/// that is not the strict one leaves the updater off and the app unaffected. Call from `setup`, before the window.
pub fn init<R: Runtime>(app: &mut tauri::App<R>, options: Options) -> tauri::Result<()> {
    if !supported() {
        return Ok(());
    }
    let handle = app.handle().clone();
    if let Err(why) = install_plugins(&handle) {
        eprintln!("updater: off ({why})");
        return Ok(());
    }
    add_menu_item(&handle)?;
    let for_menu = (handle.clone(), options.clone());
    app.on_menu_event(move |_, event| {
        if event.id().as_ref() == MENU_ID {
            let (app, opts) = for_menu.clone();
            spawn_check(app, opts, Trigger::Manual);
        }
    });
    if !options.manual_only {
        let opts = options.clone();
        let app = handle.clone();
        let _ = std::thread::Builder::new().name("updater".into()).spawn(move || {
            std::thread::sleep(opts.first_check_delay);
            loop {
                let ui = DialogUi::new(&app);
                // a panic in one check must not end the daily loop
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tauri::async_runtime::block_on(check(&app, Trigger::Background, &opts, &ui))
                }));
                std::thread::sleep(opts.interval);
            }
        });
    }
    Ok(())
}

fn spawn_check<R: Runtime>(app: AppHandle<R>, opts: Options, trigger: Trigger) {
    let _ = std::thread::Builder::new().name("updater-check".into()).spawn(move || {
        let ui = DialogUi::new(&app);
        let _ = tauri::async_runtime::block_on(check(&app, trigger, &opts, &ui));
    });
}

/// Add "Check for Updates..." to the app menu on macOS (under About) and to Help elsewhere, keeping every default item.
fn add_menu_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = match app.menu() {
        Some(m) => m,
        None => Menu::default(app)?,
    };
    let item = MenuItem::with_id(app, MENU_ID, MENU_TEXT, true, None::<&str>)?;
    let mut placed = false;
    if cfg!(target_os = "macos") {
        if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
            first.insert(&item, 1)?;
            placed = true;
        }
    } else if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        help.append(&item)?;
        placed = true;
    }
    if !placed {
        menu.append(&item)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------

/// Check, offer, download, verify, install, restart. See the header for what each trigger shows.
pub async fn check<R: Runtime>(app: &AppHandle<R>, trigger: Trigger, opts: &Options, ui: &dyn Ui) -> Outcome {
    check_with(app, trigger, opts, ui, |b| b).await
}

/// `check` with a hook on the plugin's builder (tests point it at a fixture target and a fake install path).
pub async fn check_with<R: Runtime>(
    app: &AppHandle<R>,
    trigger: Trigger,
    opts: &Options,
    ui: &dyn Ui,
    tweak: impl FnOnce(UpdaterBuilder) -> UpdaterBuilder,
) -> Outcome {
    if !supported() {
        return Outcome::Disabled("updates are not offered on this platform".into());
    }
    let manual = trigger == Trigger::Manual;
    if opts.manual_only && !manual {
        return Outcome::Skipped;
    }
    if let Err(why) = guard_config(app.config().plugins.0.get("updater"), !cfg!(test)) {
        eprintln!("updater: off ({why})");
        if manual {
            ui.inform("Updates are off", "This copy of the app is not set up to update itself.");
        }
        return Outcome::Disabled(why);
    }
    // One check at a time per app.
    let busy = app.try_state::<Busy>();
    let _release = match &busy {
        Some(b) => {
            if b.0.swap(true, Ordering::SeqCst) {
                if manual {
                    ui.inform("Check for Updates", "An update check is already running.");
                }
                return Outcome::Busy;
            }
            Some(BusyGuard(&b.0))
        }
        None => None,
    };
    run(app, trigger, opts, ui, tweak).await
}

fn friendly(err: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => {
            "The update could not be verified, so it was not installed."
        }
        E::Io(_) | E::TempDirNotOnSameMountPoint | E::PreviousAppNotRestored(_) | E::FailedToDetermineExtractPath => {
            "The update could not be installed."
        }
        _ => "The update server could not be reached. Check your connection and try again.",
    }
}

fn fail<R: Runtime>(_app: &AppHandle<R>, manual: bool, ui: &dyn Ui, title: &str, message: &str, detail: String) -> Outcome {
    eprintln!("updater: {detail}");
    if manual {
        ui.inform(title, message);
    }
    Outcome::Failed(detail)
}

async fn run<R: Runtime>(
    app: &AppHandle<R>,
    trigger: Trigger,
    opts: &Options,
    ui: &dyn Ui,
    tweak: impl FnOnce(UpdaterBuilder) -> UpdaterBuilder,
) -> Outcome {
    let manual = trigger == Trigger::Manual;
    let builder = app.updater_builder().timeout(opts.check_timeout).version_comparator(|current, release| release.version > current);
    let updater = match tweak(builder).build() {
        Ok(u) => u,
        Err(e) => return fail(app, manual, ui, "Check for Updates", friendly(&e), format!("could not build the updater: {e}")),
    };
    let mut update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            if manual {
                let name = app.package_info().name.clone();
                ui.inform("You\u{2019}re up to date", &format!("{name} {} is the newest version.", app.package_info().version));
            }
            return Outcome::UpToDate;
        }
        Err(e) => return fail(app, manual, ui, "Check for Updates", friendly(&e), format!("check failed: {e}")),
    };
    // The plugin compared already; a second, independent comparison costs nothing.
    if !is_newer(&update.current_version, &update.version) {
        if manual {
            ui.inform("You\u{2019}re up to date", "You have the newest version.");
        }
        return Outcome::UpToDate;
    }
    let version = update.version.clone();
    if !ui.confirm(&version, &plain_notes(update.body.as_deref().unwrap_or(""))) {
        return Outcome::Declined(version);
    }

    // The archive gets its own, longer deadline than the feed request.
    update.timeout = Some(opts.download_timeout);
    // Download under a hard cap: the plugin buffers the whole body, so the future is dropped once the cap is passed.
    let received = Arc::new(AtomicU64::new(0));
    let counter = received.clone();
    let cap = opts.max_download;
    let download = update.download(move |n, _| {
        counter.fetch_add(n as u64, Ordering::SeqCst);
    }, || {});
    let mut download = std::pin::pin!(download);
    let result = std::future::poll_fn(|cx| {
        use std::task::Poll;
        match download.as_mut().poll(cx) {
            Poll::Ready(r) => Poll::Ready(Some(r)),
            Poll::Pending if received.load(Ordering::SeqCst) > cap => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    })
    .await;
    let bytes = match result {
        None => return fail(app, manual, ui, "Update failed", "The update is larger than expected, so it was not installed.", format!("download passed the {cap} byte cap")),
        Some(Err(e)) => return fail(app, manual, ui, "Update failed", friendly(&e), format!("download failed: {e}")),
        // a body that arrived in one piece is over the cap too
        Some(Ok(b)) if b.len() as u64 > cap => return fail(app, manual, ui, "Update failed", "The update is larger than expected, so it was not installed.", format!("download passed the {cap} byte cap")),
        Some(Ok(b)) => b,
    };

    #[cfg(target_os = "macos")]
    if opts.bundle_check == BundleCheck::Strict {
        let running = running_bundle();
        if let Err(why) = macos::verify_staged_bundle(&bytes, &app.config().identifier, &version, &update.current_version, running.as_deref()) {
            return fail(app, manual, ui, "Update failed", "The update does not match this app, so it was not installed.", format!("bundle check failed: {why}"));
        }
    }

    // The plugin verifies the bytes again before it swaps the app (Windows: it then exits the app to run the installer).
    if let Err(e) = update.install(&bytes) {
        return fail(app, manual, ui, "Update failed", friendly(&e), format!("install failed: {e}"));
    }
    ui.restart();
    Outcome::Installed(version)
}

/// The running app's `.app` directory, when it runs from one.
#[cfg(target_os = "macos")]
fn running_bundle() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

// ---------------------------------------------------------------------------------------------------------------
// macOS: inspect the downloaded bundle before it is installed
// ---------------------------------------------------------------------------------------------------------------

#[cfg(target_os = "macos")]
pub mod macos {
    use super::{parse_version, Path};
    use std::path::PathBuf;
    use std::process::Command;

    /// Any Developer ID Application signature: the base of the requirement an ad hoc copy gives a staged bundle, which is
    /// always narrowed to one team (`team_requirement`); never used alone.
    pub const DEVELOPER_ID: &str = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

    /// The team a build of the app accepts updates from when its own running copy is ad hoc signed (a dev build), set at
    /// compile time (no tracked file carries it). Unset: such a copy accepts no update.
    const BUILD_TEAM: Option<&str> = option_env!("MINDSUITE_UPDATE_TEAM_ID");

    /// A Developer ID requirement bound to one team: `team` must be a ten-character Apple team id.
    pub fn team_requirement(team: &str) -> Result<String, String> {
        if team.len() == 10 && team.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
            Ok(format!("{DEVELOPER_ID} and certificate leaf[subject.OU] = \"{team}\""))
        } else {
            Err("the update team id is not a ten-character Apple team id".into())
        }
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
        let out = Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        if out.status.success() {
            Ok(text)
        } else {
            Err(format!("{cmd} failed: {}", text.trim()))
        }
    }

    fn plist_value(plist: &Path, key: &str) -> Result<String, String> {
        run("/usr/bin/plutil", &["-extract", key, "raw", "-o", "-", &plist.to_string_lossy()]).map(|s| s.trim().to_string())
    }

    /// The `designated => ...` line of `codesign -d -r-`, if the app has one.
    pub fn designated_requirement(app: &Path) -> Option<String> {
        let text = run("/usr/bin/codesign", &["-d", "-r-", &app.to_string_lossy()]).ok()?;
        // newer codesign prints it as "# designated => ..."; older as "designated => ..."
        text.lines().find_map(|l| l.trim().trim_start_matches('#').trim_start().strip_prefix("designated => ").map(|r| r.trim().to_string()))
    }

    /// The requirement the staged bundle has to satisfy for a given running app, or the reason there is none (the update
    /// is then refused). A signed app's own designated requirement; for an ad hoc copy (its designated requirement is
    /// its own cdhash, which says nothing about who may update it) a Developer ID signature of the build's team, if the
    /// build names one; nothing for an unsigned or unreadable copy, or one that is not an app bundle: a Developer ID
    /// signed copy whose requirement cannot be read must never fall back to "any Developer ID".
    pub fn requirement_for(running: Option<&Path>) -> Result<String, String> {
        requirement_with(running, BUILD_TEAM)
    }

    pub fn requirement_with(running: Option<&Path>, build_team: Option<&str>) -> Result<String, String> {
        let app = running.ok_or("the running copy is not an app bundle, so there is no requirement to hold the update to")?;
        match designated_requirement(app) {
            Some(r) if !r.contains("cdhash") => Ok(r),
            Some(_) => match build_team {
                Some(team) => team_requirement(team),
                None => Err("the running copy is ad hoc signed and this build names no update team, so there is no requirement to hold the update to".into()),
            },
            None => Err("the running copy's designated requirement cannot be read, so there is no requirement to hold the update to".into()),
        }
    }

    /// Unpack the update archive into a private temp dir and check the app inside: its identifier is `expect_id`, its
    /// version is the announced one and newer than the running one, its signature verifies deep and strict, and it
    /// satisfies the running app's designated requirement.
    pub fn verify_staged_bundle(archive: &[u8], expect_id: &str, announced: &str, current: &str, running: Option<&Path>) -> Result<(), String> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = TempDir(std::env::temp_dir().join(format!("mindsuite-update-{}-{nanos}", std::process::id())));
        std::fs::create_dir_all(&dir.0).map_err(|e| e.to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let tarball = dir.0.join("update.tar.gz");
        std::fs::write(&tarball, archive).map_err(|e| e.to_string())?;
        let out = dir.0.join("out");
        std::fs::create_dir(&out).map_err(|e| e.to_string())?;
        run("/usr/bin/tar", &["-xzf", &tarball.to_string_lossy(), "-C", &out.to_string_lossy()])?;
        let mut apps: Vec<PathBuf> = std::fs::read_dir(&out)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "app"))
            .collect();
        if apps.len() != 1 {
            return Err(format!("the archive holds {} apps, expected 1", apps.len()));
        }
        let app = apps.remove(0);
        let info = app.join("Contents/Info.plist");
        let id = plist_value(&info, "CFBundleIdentifier")?;
        if id != expect_id {
            return Err(format!("bundle identifier {id} is not {expect_id}"));
        }
        let version = plist_value(&info, "CFBundleShortVersionString")?;
        match (parse_version(&version), parse_version(announced), parse_version(current)) {
            (Some(v), Some(a), Some(c)) if v == a && v > c => {}
            _ => return Err(format!("bundle version {version} is not the announced {announced} or not newer than {current}")),
        }
        let requirement = requirement_for(running)?;
        run("/usr/bin/codesign", &["--verify", "--deep", "--strict", &format!("-R={requirement}"), &app.to_string_lossy()])
            .map_err(|e| format!("the bundle's signature does not satisfy the requirement: {e}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests: a local fixture feed, a mock app, no network
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::net::TcpListener;
    use std::sync::Mutex;

    // A throwaway minisign key pair (nothing else is signed by it) and an archive of a fixture app, version 2.0.0,
    // signed by `tauri signer sign --app-version 2.0.0`. Regenerate with tools/ci/updater-fixtures.sh.
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDdFNDhGMThEMUNFMEY2OEMKUldTTTl1QWNqZkZJZnFsM0xPem5QWGljYkMrT251YUY1a0I4MUtXK2MxeXFsVXY2S0JXT08xQUkK";
    const SIG_2_0_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTTl1QWNqZkZJZmk1RjdSblpPQ2xRaHp6aHBUUDFsWlpyLy84Y2VkQSt4Wmxyc1BwRDJGa2RTQTltdFdndkc2cnVZQjlPNndtZFhySityLzlmTkZsdWRoUnNwL2lFYUFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NDE4NTMyCWZpbGU6Rml4dHVyZS5hcHAudGFyLmd6CXZlcnNpb246Mi4wLjAKTlZpNTBOeWlQaUJSN1lpWXFJUXdpNWQxc2loQi9sUUxHNllUeDZzVEcra0xMVVAwcklaWGNRMTI5VnhMcGRyaUJNd09iVUxTbG9MSkthQjZrcEd1QUE9PQo=";
    const ARCHIVE_B64: &str = "H4sIAKPpA2sAA+1U3W6CMBj12qeo7FpapeCyIGaiJiZukohLdolQBxkCgTLY26+AS8Q5jRm6JePcNG2/n9Oe006clMYh4Y0ggI0LASHUE0WQj1IxMnyOxaQjCtkulrAAUKcr9YQGEC9FaBdxRI2QUYlOxCU2Ie6R/fKhQIUML4rJjv6q71Hi0ahqI5yvP8Y9VOt/DRzU/8Ew54vqXHC+/iIWurX+18BB/afe2ucD14loJT3YfUgYf6+/KEp7+rNwqQFQJd1P4J/rLw/SjQveSBg5vtfnOjziAPFM33K8lz631CftW26gNOXWaK7qz9oY5LYA2nI4m6qAa0N4HwQugXCkj4A2my50wGpAOH7kAGdTGtxBmCRJ5i+X8Ka/yQIjqIV+QEL6PmPF2iyBt6jFsTZF9RIdRbYck7K9V/KuqJNh7FkuGafEjKmxcokMs3U5oiFjrKwLO8twOy9nTS1mb2ftkLCcxWjxJDU2GcXjFRa2H9Kngt4iDyhX6rKjoJ1cmHOXYX4upfnban/Fkf9/exM/73Hy/xfEvfffQxjX7/8auGnBlePByG4S0/bBVnOQ+/gP2rVGjRo1alSED5Nr2d4AEgAA";

    fn b64_decode(s: &str) -> Vec<u8> {
        // tiny decoder: the test needs no extra dependency
        let table = |c: u8| -> Option<u32> {
            match c {
                b'A'..=b'Z' => Some((c - b'A') as u32),
                b'a'..=b'z' => Some((c - b'a') as u32 + 26),
                b'0'..=b'9' => Some((c - b'0') as u32 + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        };
        let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
        for c in s.bytes() {
            if let Some(v) = table(c) {
                acc = (acc << 6) | v;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    out.push((acc >> bits) as u8);
                    acc &= (1 << bits) - 1;
                }
            }
        }
        out
    }

    /// A one-thread-per-connection HTTP server over 127.0.0.1 serving fixed bodies by path; counts requests.
    struct Feed {
        base: String,
        hits: Arc<Mutex<Vec<String>>>,
    }
    impl Feed {
        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }
        fn requests(&self) -> usize {
            self.hits.lock().unwrap().len()
        }
    }

    fn manifest(version: &str, archive_url: &str, sig: &str) -> Vec<u8> {
        json!({"version": version, "notes": "<b>Fixes</b> things", "pub_date": "2026-11-23T00:00:00Z",
               "platforms": {"darwin-aarch64": {"signature": sig, "url": archive_url},
                             "windows-x86_64": {"signature": sig, "url": archive_url}}})
        .to_string()
        .into_bytes()
    }

    #[derive(Default)]
    struct Recorder {
        confirm: bool,
        shown: Mutex<Vec<(String, String)>>,
        asked: Mutex<Vec<String>>,
        restarted: AtomicBool,
    }
    impl Ui for Recorder {
        fn confirm(&self, version: &str, notes: &str) -> bool {
            self.asked.lock().unwrap().push(format!("{version}|{notes}"));
            self.confirm
        }
        fn inform(&self, title: &str, message: &str) {
            self.shown.lock().unwrap().push((title.into(), message.into()));
        }
        fn restart(&self) {
            self.restarted.store(true, Ordering::SeqCst);
        }
    }
    fn ui(confirm: bool) -> Recorder {
        Recorder { confirm, ..Default::default() }
    }

    fn updater_config(feed_url: &str) -> serde_json::Value {
        json!({"pubkey": PUBKEY, "endpoints": [feed_url], "requireSignedVersion": true,
               "dangerousInsecureTransportProtocol": true})
    }

    /// A mock app at version 1.0.0 with the given `plugins.updater` block.
    fn mock_app(cfg: Option<serde_json::Value>) -> tauri::App<tauri::test::MockRuntime> {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = "com.example.fixture".into();
        ctx.config_mut().version = Some("1.0.0".into());
        ctx.package_info_mut().version = semver::Version::new(1, 0, 0);
        if let Some(c) = cfg {
            ctx.config_mut().plugins.0.insert("updater".into(), c);
        }
        tauri::test::mock_builder().build(ctx).expect("mock app")
    }

    fn fixture_target(b: UpdaterBuilder) -> UpdaterBuilder {
        b.target("darwin-aarch64")
    }

    fn run_check(app: &tauri::App<tauri::test::MockRuntime>, trigger: Trigger, opts: &Options, ui: &Recorder, exe: Option<&Path>) -> Outcome {
        let exe = exe.map(Path::to_path_buf);
        tauri::async_runtime::block_on(check_with(app.handle(), trigger, opts, ui, move |b| {
            let b = fixture_target(b);
            match exe {
                Some(p) => b.executable_path(p),
                None => b.executable_path("/tmp/Fixture.app/Contents/MacOS/fixture"),
            }
        }))
    }

    fn opts() -> Options {
        Options { bundle_check: BundleCheck::Off, ..Options::default() }
    }

    /// Start a feed announcing `announce` for the archive `archive`, signed as `sig`.
    fn feed_for(announce: &str, sig: &str, archive: Vec<u8>) -> Feed {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let archive_url = format!("http://{addr}/update.tar.gz");
        let routes = vec![
            ("/latest.json", 200u16, manifest(announce, &archive_url, sig)),
            ("/update.tar.gz", 200u16, archive),
        ];
        Feed::start_on(listener, routes)
    }

    impl Feed {
        fn start_on(listener: TcpListener, routes: Vec<(&'static str, u16, Vec<u8>)>) -> Feed {
            let base = format!("http://{}", listener.local_addr().unwrap());
            let hits = Arc::new(Mutex::new(Vec::new()));
            let h = hits.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut s) = stream else { continue };
                    let routes = routes.clone();
                    let h = h.clone();
                    std::thread::spawn(move || {
                        let mut buf = [0u8; 4096];
                        let n = s.read(&mut buf).unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]).to_string();
                        let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                        h.lock().unwrap().push(path.clone());
                        let (code, body) = routes.iter().find(|r| r.0 == path).map(|r| (r.1, r.2.clone())).unwrap_or((404, b"nope".to_vec()));
                        let head = format!("HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = s.write_all(head.as_bytes());
                        let _ = s.write_all(&body);
                    });
                }
            });
            Feed { base, hits }
        }
    }

    // ---- pure helpers ---------------------------------------------------------------------------------------

    #[test]
    fn version_compare_is_newer_only() {
        assert!(is_newer("1.0.0", "1.0.1"));
        assert!(is_newer("1.9.0", "1.10.0"));
        assert!(is_newer("1.0.0", "v2.0.0"));
        assert!(is_newer("2.0.0-beta.1", "2.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("2.0.0", "1.9.9"));
        assert!(!is_newer("2.0.0", "2.0.0-beta.1"));
        assert!(!is_newer("1.0.0", "not-a-version"));
        assert!(!is_newer("garbage", "2.0.0"));
    }

    #[test]
    fn notes_are_plain_text() {
        assert_eq!(plain_notes("<b>Hi</b>\n\t there <img src=x onerror=alert(1)> end"), "Hi there end");
        assert_eq!(plain_notes("a\u{0007}b"), "ab");
        let long = "x".repeat(2000);
        assert_eq!(plain_notes(&long).chars().count(), 601);
    }

    #[test]
    fn guard_demands_the_strict_config() {
        let good = json!({"pubkey": "k", "endpoints": ["https://example.com/latest.json"], "requireSignedVersion": true});
        assert!(guard_config(Some(&good), true).is_ok());
        assert!(guard_config(None, true).is_err());
        let no_rsv = json!({"pubkey": "k", "endpoints": ["https://example.com/x"]});
        assert!(guard_config(Some(&no_rsv), true).unwrap_err().contains("requireSignedVersion"));
        let rsv_false = json!({"pubkey": "k", "endpoints": ["https://example.com/x"], "requireSignedVersion": false});
        assert!(guard_config(Some(&rsv_false), false).is_err());
        let kebab = json!({"pubkey": "k", "endpoints": ["https://example.com/x"], "require-signed-version": true});
        assert!(guard_config(Some(&kebab), true).is_ok());
        let no_key = json!({"pubkey": " ", "endpoints": ["https://example.com/x"], "requireSignedVersion": true});
        assert!(guard_config(Some(&no_key), true).is_err());
        let http = json!({"pubkey": "k", "endpoints": ["http://example.com/x"], "requireSignedVersion": true});
        assert!(guard_config(Some(&http), true).is_err());
        assert!(guard_config(Some(&http), false).is_ok());
        let insecure = json!({"pubkey": "k", "endpoints": ["https://example.com/x"], "requireSignedVersion": true, "dangerousInsecureTransportProtocol": true});
        assert!(guard_config(Some(&insecure), true).is_err());
        let certs = json!({"pubkey": "k", "endpoints": ["https://example.com/x"], "requireSignedVersion": true, "dangerousAcceptInvalidCerts": true});
        assert!(guard_config(Some(&certs), false).is_err());
        let down = json!({"pubkey": "k", "endpoints": ["https://example.com/x"], "requireSignedVersion": true, "allowDowngrades": true});
        assert!(guard_config(Some(&down), false).is_err());
        let none = json!({"pubkey": "k", "endpoints": [], "requireSignedVersion": true});
        assert!(guard_config(Some(&none), true).is_err());
    }

    // ---- the check against a fixture feed -------------------------------------------------------------------

    #[test]
    fn a_missing_or_lax_config_leaves_the_updater_off() {
        let app = mock_app(None);
        assert!(install_plugins(app.handle()).is_err());
        let lax = mock_app(Some(json!({"pubkey": PUBKEY, "endpoints": ["http://127.0.0.1:1/x"]})));
        assert!(install_plugins(lax.handle()).is_err());
        let u = ui(true);
        let out = tauri::async_runtime::block_on(check(lax.handle(), Trigger::Manual, &opts(), &u));
        assert!(matches!(out, Outcome::Disabled(_)));
        assert_eq!(u.shown.lock().unwrap().len(), 1, "a manual check says the updater is off");
    }

    #[test]
    fn a_newer_version_is_offered_and_declining_installs_nothing() {
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(false);
        let out = run_check(&app, Trigger::Background, &opts(), &u, None);
        assert_eq!(out, Outcome::Declined("2.0.0".into()));
        assert_eq!(u.asked.lock().unwrap().as_slice(), ["2.0.0|Fixes things"], "notes arrive as plain text");
        assert!(u.shown.lock().unwrap().is_empty(), "a background check shows nothing but the offer");
        assert!(!u.restarted.load(Ordering::SeqCst));
        assert_eq!(feed.requests(), 1, "declining must not download");
    }

    #[test]
    fn same_and_older_versions_are_ignored() {
        for announced in ["1.0.0", "0.9.0"] {
            let feed = feed_for(announced, SIG_2_0_0, b64_decode(ARCHIVE_B64));
            let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
            install_plugins(app.handle()).unwrap();
            let u = ui(true);
            assert_eq!(run_check(&app, Trigger::Background, &opts(), &u, None), Outcome::UpToDate, "{announced}");
            assert!(u.asked.lock().unwrap().is_empty() && u.shown.lock().unwrap().is_empty());
            // a manual check reports it
            let u = ui(true);
            assert_eq!(run_check(&app, Trigger::Manual, &opts(), &u, None), Outcome::UpToDate);
            assert!(u.shown.lock().unwrap()[0].0.contains("up to date"));
        }
    }

    #[test]
    fn network_and_feed_failures_are_quiet_unless_manual() {
        // nothing is listening
        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = dead.local_addr().unwrap();
        drop(dead);
        let app = mock_app(Some(updater_config(&format!("http://{addr}/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        assert!(matches!(run_check(&app, Trigger::Background, &opts(), &u, None), Outcome::Failed(_)));
        assert!(u.shown.lock().unwrap().is_empty() && u.asked.lock().unwrap().is_empty(), "a background failure is silent");
        let u = ui(true);
        assert!(matches!(run_check(&app, Trigger::Manual, &opts(), &u, None), Outcome::Failed(_)));
        assert_eq!(u.shown.lock().unwrap().len(), 1, "a manual failure is explained");
        assert!(!u.shown.lock().unwrap()[0].1.contains("127.0.0.1"), "the message carries no internals");

        // 404, 500, and garbage JSON
        for (code, body) in [(404u16, b"no".to_vec()), (500, b"boom".to_vec()), (200, b"{not json".to_vec())] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let feed = Feed::start_on(listener, vec![("/latest.json", code, body)]);
            let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
            install_plugins(app.handle()).unwrap();
            let u = ui(true);
            let out = run_check(&app, Trigger::Background, &opts(), &u, None);
            assert!(matches!(out, Outcome::Failed(_)), "{code}: {out:?}");
            assert!(u.shown.lock().unwrap().is_empty() && u.asked.lock().unwrap().is_empty());
        }
    }

    /// A server that accepts connections and never answers: a stalled network.
    fn stall_server() -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream);
            }
        });
        addr
    }

    #[test]
    fn a_stalled_feed_or_download_times_out_and_frees_the_next_check() {
        let quick = Options { check_timeout: Duration::from_secs(1), download_timeout: Duration::from_secs(1), ..opts() };
        // the feed never answers
        let app = mock_app(Some(updater_config(&format!("http://{}/latest.json", stall_server()))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        let started = std::time::Instant::now();
        assert!(matches!(run_check(&app, Trigger::Background, &quick, &u, None), Outcome::Failed(_)));
        assert!(started.elapsed() < Duration::from_secs(20), "the check did not time out");
        // the marker was released: the next check runs (and fails the same way), it is not "already running"
        assert!(matches!(run_check(&app, Trigger::Manual, &quick, &u, None), Outcome::Failed(_)));

        // the feed answers, the archive never arrives
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let routes = vec![("/latest.json", 200u16, manifest("2.0.0", &format!("http://{}/update.tar.gz", stall_server()), SIG_2_0_0))];
        let feed = Feed::start_on(listener, routes);
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        let started = std::time::Instant::now();
        assert!(matches!(run_check(&app, Trigger::Manual, &quick, &u, None), Outcome::Failed(_)));
        assert!(started.elapsed() < Duration::from_secs(20), "the download did not time out");
        assert!(!u.restarted.load(Ordering::SeqCst));
        assert!(matches!(run_check(&app, Trigger::Manual, &quick, &u, None), Outcome::Failed(_)), "the marker is free again");
    }

    #[test]
    fn the_busy_marker_is_released_when_a_check_panics() {
        struct Panics;
        impl Ui for Panics {
            fn confirm(&self, _: &str, _: &str) -> bool { panic!("ui blew up") }
            fn inform(&self, _: &str, _: &str) {}
            fn restart(&self) {}
        }
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            tauri::async_runtime::block_on(check_with(app.handle(), Trigger::Manual, &opts(), &Panics, fixture_target))
        }));
        assert!(caught.is_err(), "the fixture UI panics inside the check");
        let u = ui(false);
        assert_eq!(run_check(&app, Trigger::Manual, &opts(), &u, None), Outcome::Declined("2.0.0".into()), "a later check still runs");
    }

    #[test]
    fn manual_only_mode_makes_no_background_request() {
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let manual_only = Options { manual_only: true, ..opts() };
        let u = ui(false);
        assert_eq!(run_check(&app, Trigger::Background, &manual_only, &u, None), Outcome::Skipped);
        assert_eq!(feed.requests(), 0, "no request in manual-only mode");
        assert_eq!(run_check(&app, Trigger::Manual, &manual_only, &u, None), Outcome::Declined("2.0.0".into()));
        assert_eq!(feed.requests(), 1);
    }

    #[test]
    fn a_tampered_archive_is_rejected() {
        let mut bytes = b64_decode(ARCHIVE_B64);
        let last = bytes.len() - 20;
        bytes[last] ^= 0xff;
        let feed = feed_for("2.0.0", SIG_2_0_0, bytes);
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        let out = run_check(&app, Trigger::Manual, &opts(), &u, None);
        assert!(matches!(out, Outcome::Failed(_)), "{out:?}");
        assert!(!u.restarted.load(Ordering::SeqCst));
        assert!(u.shown.lock().unwrap()[0].1.contains("could not be verified"));
    }

    #[test]
    fn a_signature_from_another_key_is_rejected() {
        // a valid minisign signature, but by a different key than the config's pubkey
        const OTHER_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY0REJENEQwREFGQjA4QjgKUldTNENQdmEwTlRiOUJTaXRoSHlZRU85VWJabUc1V3N2cEFnb3JxcG8wTU12by9YVHBDVWtRc1IK";
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(json!({"pubkey": OTHER_PUB, "endpoints": [feed.url("/latest.json")], "requireSignedVersion": true, "dangerousInsecureTransportProtocol": true})));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        assert!(matches!(run_check(&app, Trigger::Background, &opts(), &u, None), Outcome::Failed(_)));
        assert!(!u.restarted.load(Ordering::SeqCst));
    }

    #[test]
    fn an_old_signed_archive_announced_as_newer_is_rejected() {
        // requireSignedVersion: the archive was signed for 2.0.0, the feed claims 9.9.9
        let feed = feed_for("9.9.9", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        let out = run_check(&app, Trigger::Manual, &opts(), &u, None);
        match out {
            Outcome::Failed(why) => assert!(why.contains("9.9.9") || why.to_lowercase().contains("version"), "{why}"),
            other => panic!("accepted: {other:?}"),
        }
        assert!(!u.restarted.load(Ordering::SeqCst));
    }

    #[test]
    fn an_oversize_download_is_dropped() {
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let u = ui(true);
        let tiny = Options { max_download: 10, ..opts() };
        let out = run_check(&app, Trigger::Manual, &tiny, &u, None);
        match out {
            Outcome::Failed(why) => assert!(why.contains("cap"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(!u.restarted.load(Ordering::SeqCst));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_good_update_replaces_the_app_and_restarts() {
        let feed = feed_for("2.0.0", SIG_2_0_0, b64_decode(ARCHIVE_B64));
        let app = mock_app(Some(updater_config(&feed.url("/latest.json"))));
        install_plugins(app.handle()).unwrap();
        let root = std::env::temp_dir().join(format!("mindsuite-updater-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("Fixture.app/Contents/MacOS");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("fixture"), "old").unwrap();
        std::fs::write(root.join("Fixture.app/Contents/Info.plist"), "old").unwrap();
        let u = ui(true);
        let out = run_check(&app, Trigger::Manual, &opts(), &u, Some(&bundle.join("fixture")));
        assert_eq!(out, Outcome::Installed("2.0.0".into()));
        assert!(u.restarted.load(Ordering::SeqCst));
        let plist = std::fs::read_to_string(root.join("Fixture.app/Contents/Info.plist")).unwrap();
        assert!(plist.contains("2.0.0"), "the app was replaced");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- macOS bundle inspection ----------------------------------------------------------------------------

    #[cfg(target_os = "macos")]
    mod bundle {
        use super::*;

        fn archive_bytes() -> Vec<u8> {
            b64_decode(ARCHIVE_B64)
        }

        #[test]
        fn the_fixture_is_refused_unless_it_matches_the_app() {
            // ad hoc / unsigned fixture + Developer ID requirement: every case is refused, each for its own reason
            let a = archive_bytes();
            let wrong_id = macos::verify_staged_bundle(&a, "com.example.other", "2.0.0", "1.0.0", None).unwrap_err();
            assert!(wrong_id.contains("identifier"), "{wrong_id}");
            let wrong_version = macos::verify_staged_bundle(&a, "com.example.fixture", "3.0.0", "1.0.0", None).unwrap_err();
            assert!(wrong_version.contains("version"), "{wrong_version}");
            let not_newer = macos::verify_staged_bundle(&a, "com.example.fixture", "2.0.0", "2.0.0", None).unwrap_err();
            assert!(not_newer.contains("version"), "{not_newer}");
            let unsigned = macos::verify_staged_bundle(&a, "com.example.fixture", "2.0.0", "1.0.0", None).unwrap_err();
            assert!(unsigned.contains("signature") || unsigned.contains("requirement"), "{unsigned}");
            // an ad hoc fixture meets no Developer ID requirement of any team
            let team = macos::team_requirement("ABCDE12345").unwrap();
            let tmp = std::env::temp_dir().join(format!("mindsuite-fixture-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&tmp);
            std::fs::create_dir_all(&tmp).unwrap();
            std::fs::write(tmp.join("f.tar.gz"), &a).unwrap();
            assert!(std::process::Command::new("/usr/bin/tar").arg("-xzf").arg(tmp.join("f.tar.gz")).arg("-C").arg(&tmp).status().unwrap().success());
            let fixture = std::fs::read_dir(&tmp).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "app")).unwrap();
            let met = std::process::Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict", &format!("-R={team}")]).arg(&fixture).output().unwrap();
            assert!(!met.status.success(), "the fixture must not meet a team requirement");
            let _ = std::fs::remove_dir_all(&tmp);
            assert!(macos::verify_staged_bundle(b"not a tarball", "com.example.fixture", "2.0.0", "1.0.0", None).is_err());
        }

        #[test]
        fn a_running_copy_without_a_real_requirement_gets_no_update_unless_the_team_is_named() {
            // not an app bundle: nothing to hold the update to
            assert!(macos::requirement_for(None).unwrap_err().contains("requirement"));
            assert!(macos::requirement_with(None, Some("ABCDE12345")).is_err());
            // the team id is checked: a malformed one never reaches codesign
            for bad in ["", "abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE1234\"", "ABCDE 2345"] {
                assert!(macos::team_requirement(bad).is_err(), "{bad}");
            }
            let team = macos::team_requirement("ABCDE12345").unwrap();
            assert!(team.starts_with(macos::DEVELOPER_ID) && team.ends_with("certificate leaf[subject.OU] = \"ABCDE12345\""), "{team}");
            // an ad hoc signed app's designated requirement is a cdhash, which says nothing about the author
            let root = std::env::temp_dir().join(format!("mindsuite-adhoc-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let app = root.join("A.app/Contents/MacOS");
            std::fs::create_dir_all(&app).unwrap();
            std::fs::copy("/bin/ls", app.join("a")).unwrap();
            std::fs::write(root.join("A.app/Contents/Info.plist"),
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleExecutable</key><string>a</string><key>CFBundleIdentifier</key><string>com.example.a</string></dict></plist>").unwrap();
            let signed = std::process::Command::new("/usr/bin/codesign").args(["--force", "--sign", "-"]).arg(root.join("A.app")).output().unwrap().status.success();
            if signed {
                let a = root.join("A.app");
                // ad hoc and no team named: refused; ad hoc and a team named: that team's Developer ID, never "any"
                let why = macos::requirement_with(Some(&a), None).unwrap_err();
                assert!(why.contains("ad hoc"), "{why}");
                assert_eq!(macos::requirement_with(Some(&a), Some("ABCDE12345")).unwrap(), team);
                assert!(macos::requirement_with(Some(&a), Some("bad")).is_err());
            }
            // an unsigned app, or a path that is no app: the requirement cannot be read, so nothing is accepted
            let unsigned = root.join("U.app/Contents");
            std::fs::create_dir_all(&unsigned).unwrap();
            assert!(macos::requirement_with(Some(&root.join("U.app")), Some("ABCDE12345")).unwrap_err().contains("cannot be read"));
            assert!(macos::requirement_with(Some(&root.join("missing.app")), Some("ABCDE12345")).is_err());
            let _ = std::fs::remove_dir_all(&root);
        }

        /// Needs a real Developer ID app: MIND_TEST_SIGNED_APP=/path/App.app (not run in CI).
        #[test]
        #[ignore]
        fn a_developer_id_app_satisfies_its_own_requirement() {
            let app = std::env::var("MIND_TEST_SIGNED_APP").expect("MIND_TEST_SIGNED_APP");
            let app = Path::new(&app);
            let req = macos::requirement_with(Some(app), None).expect("the app has a real designated requirement");
            assert!(!req.contains("cdhash"), "{req}");
            let out = std::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict", &format!("-R={req}")]).arg(app).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            // and another app's requirement refuses it
            let other = std::process::Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict", "-R=identifier \"com.example.nobody\""]).arg(app).output().unwrap();
            assert!(!other.status.success());

            // the whole staged-bundle check on the real thing: the app updating itself passes, another app's
            // running requirement refuses it
            let tar = std::env::temp_dir().join(format!("mindsuite-signed-test-{}.tar.gz", std::process::id()));
            let parent = app.parent().unwrap();
            let made = std::process::Command::new("/usr/bin/tar")
                .args(["-czf"]).arg(&tar).arg("-C").arg(parent).arg(app.file_name().unwrap()).status().unwrap();
            assert!(made.success());
            let bytes = std::fs::read(&tar).unwrap();
            let _ = std::fs::remove_file(&tar);
            let plist = app.join("Contents/Info.plist");
            let id = std::process::Command::new("/usr/bin/plutil").args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"]).arg(&plist).output().unwrap();
            let ver = std::process::Command::new("/usr/bin/plutil").args(["-extract", "CFBundleShortVersionString", "raw", "-o", "-"]).arg(&plist).output().unwrap();
            let (id, ver) = (String::from_utf8_lossy(&id.stdout).trim().to_string(), String::from_utf8_lossy(&ver.stdout).trim().to_string());
            macos::verify_staged_bundle(&bytes, &id, &ver, "0.0.1", Some(app)).expect("a signed app must pass its own check");
            // a fixture running app whose requirement this bundle cannot meet
            if let Ok(other) = std::env::var("MIND_TEST_OTHER_APP") {
                let why = macos::verify_staged_bundle(&bytes, &id, &ver, "0.0.1", Some(Path::new(&other))).unwrap_err();
                assert!(why.contains("requirement"), "{why}");
            }
        }
    }
}
