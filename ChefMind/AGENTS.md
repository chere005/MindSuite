# Working in ChefMind

The baseline for all of the owner's repos lives in ~/GIT/AgentSuite/AGENTS.md
and is imported here; this file holds only what is true of THIS repo.
@../../AgentSuite/AGENTS.md

CalMind's recipes + shopping list + pantry, on CalMind's server and accounts. A CLONE of CalMind's `apps/app` and `packages/core` (upstream `../CalMind`; the synced server lives THERE). See `README.md`, `ARCHITECTURE.md`.

## Rules

- The parser and selected utilities use the monorepo's `@mind/core` package.

- **Stay a clone.** Product fixes go upstream in CalMind first, then are copied down deliberately. Written-down divergences: `core/shopping.ts`, `units.ts`, `grocery.ts`, `variant.ts`, the seed profile in `core/appconfig.ts` (`APP_SEEDS`; `normalize.ts` is an app wrapper over the shared body and `types.ts` a stub of it, both in `packages/mind-core`, with the `shopping`/`pantry` flags and `variants` optional there), screens in `ARCHITECTURE.md` "what was taken out".
- **`SYNC_SPACE` (`app/src/api.ts`) is a constant, never configurable** — a build aimable at CalMind's records silently merges two stores.
- **Never point a local build at the production API.** `config.ts` derives the API from the page ORIGIN; never hardcode `https://seancheren.com/...`.
- **Reminders are removed, but the `reminder` record type stays** — shopping and pantry rows are reminder records.
- **Version bump** (`npm run dtp` / `tdtp`: tools/dtp.sh, tools/tdtp.sh) moves five files together: `app/app.json`, `package.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` (Cargo.lock follows). `node tools/release-versions.mjs [tag]` checks all five agree (the Release workflow's `prepare` runs it); a new version-bearing file goes in that script AND the lane.
- **`ios.buildNumber` / `android.versionCode` move by hand** per device build, not per dtp.
- **Tags are `ChefMind/x.y.0`**; pre-migration tags remain under `ChefMind/legacy/`.
- **Prod is the only instance** (seancheren.com/ChefMind, `/home/public/ChefMind` only); `deploy.sh` gates are not optional, no rehearsal. SSH login in gitignored `deploy.conf` (see `deploy.conf.sample`); destination is a guarded constant.
- **Server suite gates deploy when it can**: `deploy.sh` runs CalMind's PHP suite from `$CALMIND_REPO` (default `../CalMind`), says so OUT LOUD if absent (live API `spaces` gate is then the only server check). `e2e-router.php` uses the same checkout.
- **`packages/core` is platform-free, ONE barrel (`src/index.ts`).** Import `from '@calmind/core'` only, no deep paths; a new core file is unreachable until the barrel names it.
- **Records = clear `id`/`type`/`updated`/`deleted` + opaque `payload`** (`core/types.ts`); folders/sections/calendars are records, items point at them BY ID.
- **`core/sync.ts` is the one engine**: per-record last-write-wins on `updated`, a TIE KEEPS THE INCUMBENT (echo of our push = no-op), `cursor` = "have everything up to seq N". Transport-agnostic.
- **`app/src/store.tsx` persists the snapshot to AsyncStorage IMMEDIATELY; only the network round-trip is debounced (800 ms)** — debouncing the persist lost an edit to a reload.
- **Recipes screen is `screens/Notes.tsx`** (record type still `note`); `screens/Shopping.tsx` exports `Shopping()` and `Pantry()` as `<FlagList kind>` reading `folder.payload[kind]`. Storage keys prefixed `chefmind.` and tagged by instance (shared origin with CalMind).
- **Snapshot is the device's only copy between syncs**: a store that will not parse is moved aside and reported, never treated as an empty account; ask what happens when a write fails.
- **`packages/mind-core/spec/*.json` is DATA the suite reads** (`spec.test.ts`, `protocol.json`), shared with CalMind web + native cores — behaviour changes amend the vector, never the test around it.
- **Spaces/filenames**: `space` is whitelisted in `sync_space()` (CalMind `server/lib/app.php`), never sanitised.

## Commands

```
npm run test            # core (test:core, --run) then app (test:app)
npm run typecheck       # tsc --noEmit over packages/core and app
npm run test:deploy     # breaks copies of deploy.sh; no network/SSH/deploy.conf, needs npm install
npm -w @calmind/core run test -- --run test/shopping.test.ts
npm -w @calmind/core run test -- --run -t 'pantry'
```

- The core suite's `TZ=America/Chicago` is pinned in `packages/core/vitest.config.ts`, so npm and bare `vitest` both run pinned.
- No linter/formatter; typecheck + core suite are the whole static gate. npm workspaces: `packages/*`, `app`, `desktop`.
- Local run: three-line recipe in `ARCHITECTURE.md` (export web build, patch head, serve with `e2e-router.php` on 8792).

## Platforms

- **Web**: the only thing `deploy.sh` ships; no ChefMind backend — syncs to CalMind's live API in the `chef` space, and the gate refuses to ship unless that API reports `chef`.
- **macOS**: Tauri `desktop/`; `dmg` excluded from `bundle.targets` (local builds make the `.app`); the Release workflow passes `--bundles dmg` in CI args to build the Apple-silicon dmg. Unsigned.
- **Windows**: `.msi` + NSIS `.exe` (x64) built and MSI-smoke-tested in CI only (`root .github/workflows/chefmind-release.yml`, on a tag push); Tauri cannot cross-compile.
- **GitHub Releases**: pushing a app tag runs `Release` (`root .github/workflows/chefmind-release.yml`): `prepare` (tag == every version file, via `tools/release-versions.mjs`; DRAFT release) → `windows` + `mac` build and `gh release upload` into the draft → `publish` (all 3 files present, `SHA256SUMS.txt`, then published). **Never `actions/upload-artifact`/`download-artifact`** (the account's artifact quota is full); release assets are not counted.
- **iOS**: `tools/build-platforms.sh --ios` (devicectl) installs to ALL THREE paired phones (the owner, Person B, Person C); a refusing phone is warned and skipped, step fails only if none took it.
- **iOS version**: sync `expo.version` into pbxproj `MARKETING_VERSION` + Info.plist (generated `app/ios` is reused), read both back, and refuse every phone if the BUILT `CFBundleShortVersionString` != app.json's.
- **No per-phone app cap**: team TEAMID0000 is PAID.
- **watchOS**: no target. **Android**: `tools/build-platforms.sh --android` on a local emulator.

## The release lane, end to end

- **This repo ships itself**: macOS/iOS/Android via its own `tools/build-platforms.sh` (run by dtp/tdtp); the Windows and Mac installers on GitHub are the tag-triggered `Release` workflow's. Step list is `tools/dtp.sh`'s head comment.
- **Platform flags**: naming one selects only it, none = all for tdtp but web only for dtp, `--web` = release with no platform builds; `tools/dtp.sh` takes the same flags.
- **dtp is fast, tdtp thorough**: dtp skips the preflight unless `desktop/`/`.github/`/a manifest changed since the last tag, and leaves the Release run unwatched; tdtp runs both plus `test:deploy`.
- **Refuses BEFORE shipping, nothing touched**: HEAD not on `main`; uncommitted tracked changes; tree dirty after the pull (`git pull --autostash` exits 0 on a conflicted pop, so re-check); version not `x.y.z`; tag already exists.
- **A bumped-but-untagged version is SHIPPED AGAIN**, not skipped, so a failed lane re-run burns no number; verify every substitution after (a no-match substitution reports success).
- **`./deploy.sh --yes-prod`** ships the web, the only deploy; a failed deploy stops everything, never tagged around.
- **Gate key**: under tdtp, `tools/gate-key.mjs` hashes everything tsc/vitest reads (minus version fields); deploy.sh skips its typecheck + core suite only if the tree still hashes to the key the full pass handed down (and says so), else runs them. `test:deploy` proves it.
- **macOS bundle BEFORE the tag**: a broken desktop build leaves the version untagged and reusable.
- **Preflight before the tag**: `tools/preflight.sh <tag>` pushes HEAD to `preflight/<sha7>`, dispatches `Release` with `preflight=true` (builds everything in the bot's run, uploads/publishes nothing), prints PASS/FAIL and deletes the branch. A fail stops the lane before tagging (version stays untagged, reusable); `--skip-preflight` is the deliberate bypass. Run it alone before any hand-cut tag too.
- **Tag `ChefMind/x.y.0`, push main and the exact tag with `--atomic`**; the tag push starts `Release`, which hands the work to github-actions[bot]; tdtp follows the bot's runs after the device builds (`tools/gh-bot.sh release`), dtp does not, and every lane run warns at its start if the last release never published. `--follow-tags` is per-ref so a tag could land while `main` is rejected. A refused push removes the local tag.
- **A Release failure after the tag does not un-ship the deploy**: the lane prints the run, the failed jobs and `gh workflow run chefmind-release.yml --ref <tag> -f tag=<tag>`, closes the card `ok` severity 2 and ends non-zero (like a device failure). A tag with no release (a past version): `gh workflow run Release --ref main -f tag=<tag>`.
- **Quiet CI** (AgentSuite/ci.md, `npm --prefix .. run preflight`): a run a person starts only hands off to github-actions[bot] (GitHub mails a run's outcome to whoever triggered it); every job is `continue-on-error`; a release missing a platform retries itself (3 runs). Never `gh run rerun` (yours, so it only hands off again).
- **Device builds AFTER the push**, iOS then Android, one at a time never parallel; failure unpicks nothing: prints the `sh tools/build-platforms.sh --ios` to re-run, closes the status card `ok` severity 2, **ends the lane non-zero** (like CoreMind `bin/dtp.sh`).
- **Heavy-lock**: every platform block in `tools/build-platforms.sh` runs under `tools/heavy-lock.sh` (`/tmp/mind-heavy-<uid>.lock`, waits naming holder every 30 s, gives up after 30 min). It sees only builds that take it (AcctMind, CalMind, ChefMind, MyCalMind blocks, MyCalMind `tools/deploy-device.sh`, AcctMind desktop smoke, CoreMind fallback `bin/build-platforms.sh`).
- **Not locked, so serialize by hand**: TestMindSuite qdtp, `npm run desktop`, `app/` `npm run ios`/`android`, terminal xcodebuild, Xcode GUI builds.
- **The web-build tools are CalMind's bytes too** (groups in `../tools/shared-files.json`): `tools/source-digest.mjs`, `patch-web-html.mjs`, `sw.js`, `app-identity.mjs` and `desktop/stage-dist.sh`; what makes them ChefMind's is `tools/app-identity.json` (`appDir` `app`, `id` `chefmind`; app-owned, not listed) plus `app/app.json`'s `expo.name`. Fix the tools at the CalMind origin; change the JSON here.
- **The app's name on screen is `app/app.json`'s `expo.name`**, read by the shared `app/src/brand.ts` (`APP_NAME`) for `Login.tsx` and `components/ocr.ts`, all three copies of CalMind's; renaming the app is an app.json change, never an edit to those files.
- **`tools/heavy-lock.sh` is CalMind's bytes** (a group in `../tools/shared-files.json`): fix the origin in CalMind, never here.
- **Reports to seancheren.com/status** via CoreMind's `bin/report-status.sh` beside this checkout: `start` before touching the tree, `finish` with severity, EXIT/INT/TERM trap; call is `|| true` (CoreMind may be absent).
- **Under CoreMind's orchestrator `MIND_RUN_ID` is set** and the lane opens no card of its own (one card per batch); unset = it opens/closes its own.
- **No shared-files gate in this lane**; CalMind's lane gate (`--app CalMind`) covers every group ChefMind copies, and CoreMind's `bin/dtp.sh` core batch runs it too. This repo's members: `node ../tools/check-shared.mjs --app ChefMind`.
- **Suite order**: `sh bin/dtp.sh all --full --platforms` (CoreMind) runs core, then CalMind, then ChefMind (deploy needs CalMind's live API); CoreMind passes `--platforms` to apps carrying `tools/build-platforms.sh`. MyCalMind is installed by the suite lane too.

## The three lists, and the rules they keep

- **Shopping and pantry rows are both `reminder` records** in folders flagged `shopping` / `pantry`, rendered by one `<FlagList kind>`. `normalize`, under this app's `'lists'` profile (`core/appconfig.ts`), seeds exactly one of each and neither counts as an ordinary reminders folder — else the pantry is created on one load and deleted as a stray on the next. `test/seedsnapshot.test.ts` pins the seeded data byte for byte; change a seed there deliberately, never to go green.
- **The pantry SUBTRACTS**: anything on it is left off the shopping list entirely (not struck through). Matching lives in `core/shopping.ts`, on the ingredient NAME: 'flour' must never claim 'almond flour'.
- **Conversion within a DIMENSION only** (`core/units.ts`): cup = 236.588 ml, so cups + tbsp of a thing become one ml line; cup to GRAM needs per-ingredient density, so stays two lines.
- **Filed by ingredient, not measure** (`core/grocery.ts`, `ingredientAisle`) — else '3 cloves garlic' lands in the spice rack; the exception is `can`/`jar` (where it's SOLD).
- **Refresh is a LOOSER match, never a looser conversion**: `recombineLines` folds plurals/prep words, prefers bracketed metric, keeps the shortest merged name; never cross mass with volume; keep the prep-word list short ('dried', 'ground', 'whole' stay).
- **A variant names sections by TEXT, not index** (an index silently shifts); renaming a subheader detaches it visibly; `liveSections` drops names the card lacks.

## Traps

- **`simctl`/browser text injection lowercases and drops chars** (`**Ingredients**` → lowercase; a URL truncated at the first `.`) → read back what you typed before believing a failure.
- **Two-handled basket icon reads as a waste bin at tab-bar size** → use one arc over the top.
- **`␡` has no glyph in the app font** → renders a literal `DEL` box.
- **tauri.conf.json takes NO extra keys** (a `"_note"` fails the schema: `Additional properties are not allowed`). `dmg` excluded (create-dmg needs Finder/AppleScript, dies here); `msi`/`nsis` build in CI; `bundle.icon` names only `icon.icns`, `icon.ico`, `icon.png`.
- **`npx tauri icon` also writes `android/`, `ios/`, `Square*Logo.png`, `StoreLogo.png` into `icons/`** → unused, delete after.
- **Desktop `location.origin` is `tauri://localhost`** → deriving the API from it gives "server error (500)" on the login card; `config.ts` has an explicit tauri branch (CalMind's too).
- **Metro's port is not a constant** (8081 is usually CalMind's) → an allow-list of ports aimed at Metro's index.html and "server error"; `config.ts` matches the HOST.
- **`app/ios/build/` is NOT disposable** (ReactCodegen sources under `build/generated/ios/` come from `pod install`) → deleting it gives seven "Build input file cannot be found" errors; run `pod install` with the UTF-8 locale.
- **Disk-full kill leaves a Gradle LOCK** ("Cannot lock file hash cache … already been locked by this process", fails in <1 s) → `./gradlew --stop` and remove `app/android/.gradle`.
- **A Directions row must be NUMBERED or `splitRecipeBody` ends the block there** → a '- salt' fixture put half the card in `after`, looking like a variant leak; the fixture is wrong, not the parser.
- **`Modal` fades in** → a screenshot right after opening shows it half-transparent; wait.
- **The head patch IS the PWA**: `tools/patch-web-html.mjs` writes `sw.js`, `manifest.webmanifest` and injects the service-worker registration; a desktop build that skips it ships a different page (6 vs 9 staged files). `build-platforms.sh` patches; the worker can't register from `tauri://localhost` and needn't (`.catch(...)`).
- **Local run needs CalMind's dev API on 8788 as well as the router**: `config.ts` returns `http://127.0.0.1:8788/api/index.php` for ANY localhost hostname (also in the exported bundle), so the page on 8792 talks to 8788, not the router's `/calmind/api` → start `php -S 127.0.0.1:8788 -t server/public` in CalMind (CORS open) or login fails against an empty port.
