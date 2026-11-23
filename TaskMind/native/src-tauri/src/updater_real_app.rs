// The real-app update trial: the shared updater against TaskMind's own signed builds and TaskMind's own update key, served
// from a local fixture feed. Not part of `cargo test` (it is #[ignore]d: it needs two signed builds and a feed directory
// that only `tools/test-real-update.sh` makes). Nothing leaves the machine.
//
//   MIND_E2E_OLD_APP   the signed N-1 TaskMind.app (copied for every scenario; never touched itself)
//   MIND_E2E_FEED_DIR  the --dry-run directory of tools/publish-update.mjs for N: latest.json, the signed .app.tar.gz and its .sig
//   MIND_E2E_OTHER_SIG a minisign signature of the very same archive by ANOTHER key
//   MIND_E2E_OLD / MIND_E2E_NEW  the two versions (N-1 and N), e.g. 1.0.0 and 1.0.1
//
// What it proves, each on a fresh copy of the old app: N is offered, its signature and signed version are verified, it is
// downloaded, replaces the old app on disk, is Developer ID signed and passes the running app's designated requirement,
// and the app is asked to restart; and that nothing is installed (the old app stays byte for byte) for a same or older
// version, a declined offer, a tampered archive, a signature from another key, an old signed archive announced as newer,
// and a feed that cannot be reached.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

use crate::updater::{check_with, install_plugins, macos, BundleCheck, Options, Outcome, Trigger, Ui};

struct Recorder {
    confirm: bool,
    offered: Mutex<Vec<String>>,
    shown: Mutex<Vec<String>>,
    restarted: AtomicBool,
}
impl Recorder {
    fn new(confirm: bool) -> Self {
        Recorder { confirm, offered: Mutex::new(vec![]), shown: Mutex::new(vec![]), restarted: AtomicBool::new(false) }
    }
}
impl Ui for Recorder {
    fn confirm(&self, version: &str, _notes: &str) -> bool {
        self.offered.lock().unwrap().push(version.into());
        self.confirm
    }
    fn inform(&self, title: &str, message: &str) {
        self.shown.lock().unwrap().push(format!("{title}: {message}"));
    }
    fn restart(&self) {
        self.restarted.store(true, Ordering::SeqCst);
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set (run tools/test-real-update.sh)"))
}

fn run(cmd: &str, args: &[&str]) -> (bool, String) {
    let out = Command::new(cmd).args(args).output().unwrap_or_else(|e| panic!("{cmd}: {e}"));
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.success(), text)
}

fn plist_version(app: &Path) -> String {
    let (ok, v) = run("/usr/bin/plutil", &["-extract", "CFBundleShortVersionString", "raw", "-o", "-", &app.join("Contents/Info.plist").to_string_lossy()]);
    assert!(ok, "{v}");
    v.trim().to_string()
}

fn exe_digest(app: &Path) -> String {
    let (ok, d) = run("/usr/bin/shasum", &["-a", "256", &app.join("Contents/MacOS/taskmind").to_string_lossy()]);
    assert!(ok, "{d}");
    d.split_whitespace().next().unwrap().to_string()
}

/// A tiny http server over 127.0.0.1 serving fixed bodies by path.
fn serve(routes: Vec<(String, Vec<u8>)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = Arc::new(routes);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let routes = routes.clone();
            std::thread::spawn(move || {
                let mut s = stream;
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (code, body) = routes.iter().find(|r| r.0 == path).map(|r| (200, r.1.clone())).unwrap_or((404, b"nope".to_vec()));
                let head = format!("HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
            });
        }
    });
    base
}

struct Scenario {
    announce: String,
    archive: Vec<u8>,
    signature: String,
}

/// A mock app that is the OLD version, configured exactly as tauri.conf.json configures TaskMind (its real public key,
/// requireSignedVersion), except that the one endpoint is the local feed.
fn mock_app(feed_url: &str, old_version: &str) -> tauri::App<MockRuntime> {
    let conf: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap()).unwrap();
    let mut updater = conf["plugins"]["updater"].clone();
    assert_eq!(updater["requireSignedVersion"], json!(true), "the shipped config is the strict one");
    updater["endpoints"] = json!([feed_url]);
    // the plugin itself refuses plain http without this flag; the shared guard allows it only under cfg(test)
    updater["dangerousInsecureTransportProtocol"] = json!(true);
    let mut ctx = mock_context(noop_assets());
    ctx.config_mut().identifier = conf["identifier"].as_str().unwrap().into();
    ctx.config_mut().version = Some(old_version.into());
    ctx.package_info_mut().version = semver::Version::parse(old_version).unwrap();
    ctx.config_mut().plugins.0.insert("updater".into(), updater);
    mock_builder().build(ctx).expect("mock app")
}

/// One scenario against a fresh copy of the old app. Returns the outcome, the recorder and the scratch app.
fn attempt(sc: Option<&Scenario>, confirm: bool, trigger: Trigger, scratch: &Path, tag: &str) -> (Outcome, Recorder, PathBuf) {
    let old_app = PathBuf::from(env("MIND_E2E_OLD_APP"));
    let old_version = env("MIND_E2E_OLD");
    let dir = scratch.join(tag);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let app_copy = dir.join("TaskMind.app");
    let (ok, why) = run("/usr/bin/ditto", &[&old_app.to_string_lossy(), &app_copy.to_string_lossy()]);
    assert!(ok, "{why}");
    let feed_url = match sc {
        Some(sc) => {
            let base = serve(vec![("/update.tar.gz".into(), sc.archive.clone())]);
            let manifest = json!({
                "version": sc.announce, "notes": "A scratch update for the real-app trial.",
                "pub_date": "2026-11-23T00:00:00Z",
                "platforms": {"darwin-aarch64": {"url": format!("{base}/update.tar.gz"), "signature": sc.signature}},
            });
            // the manifest is served by a second tiny server that knows the archive's address
            serve(vec![("/latest.json".into(), serde_json::to_vec(&manifest).unwrap())]) + "/latest.json"
        }
        // nothing listens on this port
        None => {
            let probe = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = probe.local_addr().unwrap();
            drop(probe);
            format!("http://{addr}/latest.json")
        }
    };
    let app = mock_app(&feed_url, &old_version);
    install_plugins(app.handle()).unwrap();
    let ui = Recorder::new(confirm);
    // The strict bundle check asks the RUNNING process which app it is (std::env::current_exe), and this process is the test
    // binary, so the full flow runs with it off and the very same check is run on its own below, with the real signed old
    // app standing in as the running copy.
    let opts = Options { bundle_check: BundleCheck::Off, ..Options::default() };
    let exe = app_copy.join("Contents/MacOS/taskmind");
    let outcome = tauri::async_runtime::block_on(check_with(app.handle(), trigger, &opts, &ui, move |b| b.target("darwin-aarch64").executable_path(exe)));
    (outcome, ui, app_copy)
}

#[test]
#[ignore]
fn a_real_signed_old_build_updates_to_the_new_one_and_refuses_everything_else() {
    let feed_dir = PathBuf::from(env("MIND_E2E_FEED_DIR"));
    let (old_v, new_v) = (env("MIND_E2E_OLD"), env("MIND_E2E_NEW"));
    let old_app = PathBuf::from(env("MIND_E2E_OLD_APP"));
    let latest: Value = serde_json::from_str(&std::fs::read_to_string(feed_dir.join("latest.json")).unwrap()).unwrap();
    assert_eq!(latest["version"], json!(new_v), "the feed directory is for the new version");
    let entry = &latest["platforms"]["darwin-aarch64"];
    let archive_name = entry["url"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    let archive = std::fs::read(feed_dir.join(&archive_name)).unwrap_or_else(|e| panic!("{archive_name}: {e}"));
    let signature = entry["signature"].as_str().unwrap().to_string();
    let other_sig = std::fs::read_to_string(env("MIND_E2E_OTHER_SIG")).unwrap().trim().to_string();
    assert_ne!(signature, other_sig);
    let scratch = std::env::temp_dir().join(format!("taskmind-real-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);

    let old_digest = exe_digest(&old_app);
    let good = |announce: &str| Scenario { announce: announce.into(), archive: archive.clone(), signature: signature.clone() };
    let unchanged = |app: &Path| {
        assert_eq!(plist_version(app), old_v, "the old app must be left as it was");
        assert_eq!(exe_digest(app), old_digest, "the old executable must be left as it was");
        let (ok, out) = run("/usr/bin/codesign", &["--verify", "--deep", "--strict", &app.to_string_lossy()]);
        assert!(ok, "the old app's seal is intact: {out}");
    };

    // 0. the macOS bundle check the strict path runs before installing (same function, the real signed old app as the running copy):
    //    the new build passes; a wrong announced version, an announced version that is not newer than the running one, and a
    //    bundle id that is not this app's are refused
    let id = serde_json::from_str::<Value>(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).unwrap()).unwrap()["identifier"].as_str().unwrap().to_string();
    macos::verify_staged_bundle(&archive, &id, &new_v, &old_v, Some(&old_app)).expect("the new signed build passes the old app's check");
    assert!(macos::verify_staged_bundle(&archive, &id, "99.0.0", &old_v, Some(&old_app)).is_err(), "announced version is not the bundle's");
    assert!(macos::verify_staged_bundle(&archive, &id, &new_v, &new_v, Some(&old_app)).is_err(), "not newer than the running copy");
    assert!(macos::verify_staged_bundle(&archive, "com.example.other", &new_v, &old_v, Some(&old_app)).is_err(), "another app's bundle id");
    assert!(macos::verify_staged_bundle(&archive, &id, &new_v, &old_v, None).is_err(), "no running bundle, no requirement, no update");

    // 1. the good update: offered, verified, downloaded, installed, restarted
    let (outcome, ui, app) = attempt(Some(&good(&new_v)), true, Trigger::Manual, &scratch, "good");
    assert_eq!(outcome, Outcome::Installed(new_v.clone()), "shown: {:?}", ui.shown.lock().unwrap());
    assert_eq!(*ui.offered.lock().unwrap(), vec![new_v.clone()], "the person was offered exactly the new version");
    assert!(ui.restarted.load(Ordering::SeqCst), "the app was asked to restart into the new copy");
    assert_eq!(plist_version(&app), new_v, "the app on disk is the new version");
    assert_ne!(exe_digest(&app), old_digest, "the executable was replaced");
    let (ok, out) = run("/usr/bin/codesign", &["--verify", "--deep", "--strict", &app.to_string_lossy()]);
    assert!(ok, "the installed app's seal: {out}");
    let (_, info) = run("/usr/bin/codesign", &["-dv", "--verbose=4", &app.to_string_lossy()]);
    assert!(info.contains("flags=0x10000(runtime)"), "hardened runtime: {info}");
    assert!(info.contains("Authority=Developer ID Application:"), "{info}");
    assert!(info.contains(&format!("TeamIdentifier={}", env("MIND_E2E_TEAM"))), "{info}");
    let (ok, out) = run("/usr/sbin/spctl", &["-a", "-t", "exec", "-vv", &app.to_string_lossy()]);
    assert!(ok && out.contains("Notarized Developer ID"), "Gatekeeper on the updated app: {out}");
    let (ok, out) = run("/usr/bin/xcrun", &["stapler", "validate", &app.to_string_lossy()]);
    assert!(ok, "the ticket survived the update: {out}");
    let (_, archs) = run("/usr/bin/lipo", &["-archs", &app.join("Contents/MacOS/taskmind").to_string_lossy()]);
    assert_eq!(archs.trim(), "arm64");

    // 2. the same version and an older one are ignored (the archive is never fetched, nothing is offered)
    for (tag, announce) in [("same", old_v.as_str()), ("older", "0.0.1")] {
        let (outcome, ui, app) = attempt(Some(&good(announce)), true, Trigger::Manual, &scratch, tag);
        assert_eq!(outcome, Outcome::UpToDate, "{tag}");
        assert!(ui.offered.lock().unwrap().is_empty() && !ui.restarted.load(Ordering::SeqCst), "{tag}");
        unchanged(&app);
    }

    // 3. an offer the person declines installs nothing
    let (outcome, ui, app) = attempt(Some(&good(&new_v)), false, Trigger::Manual, &scratch, "declined");
    assert_eq!(outcome, Outcome::Declined(new_v.clone()));
    assert_eq!(ui.offered.lock().unwrap().len(), 1);
    assert!(!ui.restarted.load(Ordering::SeqCst));
    unchanged(&app);

    // 4. a tampered archive (one byte flipped in the middle) is rejected by the signature check
    let mut bad = archive.clone();
    let mid = bad.len() / 2;
    bad[mid] ^= 0xff;
    let (outcome, ui, app) = attempt(Some(&Scenario { announce: new_v.clone(), archive: bad, signature: signature.clone() }), true, Trigger::Manual, &scratch, "tampered");
    assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
    assert!(!ui.restarted.load(Ordering::SeqCst));
    unchanged(&app);

    // 5. a genuine signature by another key is rejected
    let (outcome, ui, app) = attempt(Some(&Scenario { announce: new_v.clone(), archive: archive.clone(), signature: other_sig }), true, Trigger::Manual, &scratch, "otherkey");
    assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
    assert!(!ui.restarted.load(Ordering::SeqCst));
    unchanged(&app);

    // 6. the old signed archive announced as a newer version (a rollback replay) is rejected: requireSignedVersion
    let (outcome, ui, app) = attempt(Some(&good("99.0.0")), true, Trigger::Manual, &scratch, "replay");
    assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
    assert!(!ui.restarted.load(Ordering::SeqCst));
    unchanged(&app);

    // 7. a feed that cannot be reached: nothing is shown for a background check, nothing is installed
    let (outcome, ui, app) = attempt(None, true, Trigger::Background, &scratch, "offline");
    assert!(matches!(outcome, Outcome::Failed(_)), "{outcome:?}");
    assert!(ui.shown.lock().unwrap().is_empty(), "a background failure is quiet: {:?}", ui.shown.lock().unwrap());
    unchanged(&app);

    let _ = std::fs::remove_dir_all(&scratch);
}
