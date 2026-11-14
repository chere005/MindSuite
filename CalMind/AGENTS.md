# Working on CalMind

The baseline for all of the owner's repos lives in ~/GIT/AgentSuite/AGENTS.md
and is imported here; this file holds only what is true of THIS repo.
@../../AgentSuite/AGENTS.md

Calendar/reminders/notes/habits/recipes app. Docs: `ARCHITECTURE.md` (map), `TESTING.md`, `PARITY.md`, `TODO.md` (live list; holds suite counts — write no number in prose).

## Rules

- The parser and selected utilities use the monorepo's `@mind/core` package.

- **Core:** behavior lives in `packages/core`, with a test; screens hold plumbing only. **Spec:** `spec/*.json` vectors are the contract — amend a vector first, never edit a test to match new code.
- **Old suite:** the pre-split code is history; grep `git -C ~/GIT/seancheren-site grep -n '<pattern>' e9b9f28 -- calmind lib` (not the checkout). Its code, not that repo's CLAUDE.md, is the spec.
- **Web first:** deploy web BEFORE building/installing the phone or watch app (gates run in the web deploy; the app needs the server it expects).
- **Deploy = PROD:** `./server/deploy.sh prod test --yes-prod [--quick]` ships both instances off one gate run; `--yes-prod` stays mandatory and spelled out.
- **`./server/deploy-prod.sh`:** separate; the only prod `.well-known` passkey payload; `--yes` writes, `--verify` is read-only. See `tools/check-deploy-guards.sh`.
- **Lanes:** `npm run dtp` = FAST (`--quick` gates + spot test, no platform builds unless named, preflight only when `desktop/`/`.github/`/a manifest changed since the last tag, Release run not watched) / `npm run tdtp` = THOROUGH (test:dev + contract/watch/widget/deploy/simfresh, full gesture+WebKit gates, all three platforms + test:desktop, preflight, Release watched). Order is in Platforms; do not restate it. **Lane flags:** `--mac`/`--ios`/`--android` build only that one; `--web` = release, no platform builds; none = web only for dtp, all three for tdtp.
- **Status card:** each run reports start/finish to seancheren.com/status, never fatally; if `MIND_RUN_ID` is set, CoreMind's `dtp all` owns the one card and this lane defers.
- **Exit code:** the lane ends non-zero when a device build is owed (release still shipped, card closed `ok` severity 2); CoreMind's batch continues to later repos.
- **Sibling repos:** ChefMind lives at `../ChefMind`; it is a CLONE — fixes land here first, then copied down deliberately. **ChefMind sync:** ChefMind syncs through THIS server (`chef` space) and reads this checkout as `$CALMIND_REPO`; changes to `server/lib` must keep the space contract or its gates break.
- **Widget page = write:** opening the Scriptable widget feed page on the owner's account mutates his token store; treat as a write to his data.
- **App sign-in:** native and desktop sign in through `src/appsignin.ts` (+ `-browser.ts`): `/account/app/` in the system auth browser, PKCE, `signin_redeem`; the form only for a server that says it is not shared.
- **Shared-files drift gate:** `node ../tools/check-shared.mjs --app CalMind` must pass or the lane refuses and names `--fix <group>`; it fails closed if the tool is missing or errors, and the lane never rewrites source mid-release.
- Use the owner's own recipe notes/shapes (read via the app or round-tripped through core), not invented cards; every real recipe bug came from his.

## Commands

```sh
npm install                       # once, at the root — npm workspaces
npm run test:dev                  # between-runs suite: 2 typechecks, core, server, counts (~30s)
npm test                          # core + server only
npm run typecheck                 # tsc --noEmit over packages/core AND apps/app, separately
```

```sh
npm run test:core -- order               # vitest, by test-FILE substring
npm run test:core -- order -t "inverted" # …and by test name
npm run export:web && npx playwright test e2e/callist.spec.ts
npx playwright test e2e/callist.spec.ts -g "groups by day"
```

```sh
php -S 127.0.0.1:8788 -t server/public   # the API; data in server/data/ or $CALMIND_DATA_DIR
npm run web                              # Expo web on :8081, talking to :8788
npm run export:web                       # export + tools/patch-web-html.mjs — never a bare expo export
```

- Core vitest runs under `TZ=America/Chicago`, pinned in `packages/core/vitest.config.ts`, so bare `vitest` is pinned too (unpinned, date tests turn red after 7pm). `php server/tools/test.php`: all-or-nothing, boots its own `php -S` on a scratch dir; never run beside another suite.
- Playwright drives `apps/app/dist`, not source: `e2e/freshness.ts` refuses a stale export, so re-run `npm run export:web` after any edit. One worker, 420×900 Chromium, `php -S` on 8790, wiped data dir.
- Deploy shards e2e: 8790, 8793 (8794 with `CALMIND_E2E_SHARDS=3`), WebKit on 8791; each has its own server, data dir, `test-results-<port>`. Specs take ports from `e2e/port.ts`, never literals (`e2e/portguard.spec.ts` fails on one).
- Nothing else may hold 8790/8791/8793/8794 during a deploy (AcctMind's harness uses 8791); two runs on one port fight.
- No lint script; the deploy runs `find server -name '*.php' -print0 | xargs -0 -n1 php -l`. `npx playwright install webkit` once before `npm run test:webkit`.
- `test:watch`/`test:widget` need `swift` and `python3` (they lift real Swift from `apps/app/targets`).

## Architecture

- `@calmind/core` is consumed as TS SOURCE (`./src/index.ts`), no deps, no build: live in metro/tsc at once, NOT in `apps/app/dist` until export. Swift/Kotlin cores replay the same spec vectors; the 12/24-hour clock has three implementations (watch, complication, widget decode `watchFeed` JSON) plus a seam check.
- `apps/app/src/store.tsx` is the only stateful seam (context around core's `SyncEngine`); drag order is `payload.ord` (fractional key), since array position can't survive per-record merge. Server is dumb: `server/public/api/index.php` fronts `server/lib/app.php`, merges by CLEAR metadata only; `payload` is opaque, encrypted at rest (`ENC1:`). A feature needing server payload reads is client logic or new clear metadata.
- prod/test/dev differ only by path on one origin and localStorage ignores paths, so session/snapshot keys carry an `instanceTag` from the API URL; `apps/app/src/config.ts` alone picks the API (same-origin, `127.0.0.1:8788` for metro, PROD for native/desktop); `EXPO_PUBLIC_API_URL` overrides it at build time (Metro's cache key carries it; the desktop CSP follows via `desktop/tauri-build.mjs`).

## Platforms

CalMind is the origin app and the only suite repo with a full production server. Shared fixes land here (shared module bodies in `../packages/mind-core`, PHP in `../packages/mind-server`); `../tools/shared-files.json` lists the files other apps must carry byte for byte, and `node ../tools/check-shared.mjs --fix <group>` copies this origin out.

- **Web** — own production server; the only app the owner's devices, browser and public request link hit directly.
- **macOS** — Tauri bundle (`desktop/`), built by `tools/build-platforms.sh --mac` BEFORE the tag; a failed build leaves the version untagged and a re-run reuses it.
- **Version lives in FOUR files** (root `package.json` is not one): `apps/app/app.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` (`version = "x"`, not JSON). The lane writes and GREPS each (a no-match `perl -i` exits 0); lockfile syncs separately and refuses if more than version lines changed.
- **Windows, macOS dmg, Linux** — a pushed app version tag (`CalMind/1.37.0`) runs `root .github/workflows/calmind-release.yml`: msi+exe, Apple-silicon dmg and deb+AppImage land on ONE GitHub Release with `SHA256SUMS.txt`, published only when all are there. The tag must equal the version in the four files. Existing tag: `gh workflow run calmind-release.yml -f tag=<tag>`. **No `actions/upload-artifact`** (Actions artifact quota is full); ARCHITECTURE.md "Releases" has the rest.
- **iOS** — `tools/build-platforms.sh --ios` (devicectl) after the push, never fatal; installs to ALL three paired phones (`Phone 1`, Person B's, Person C's): one build, per-phone install, warn on refusal, fail only if none took it. `IOS_DEVICE` narrows to one. **iOS cap/registering:** no per-phone app cap (team TEAMID0000 is PAID, profile `TimeToLive 365`). Unregistered phone → devicectl provisioning error → run `IOS_DEVICE='Its Name' sh tools/build-platforms.sh --ios` once.
- **Android** — `tools/build-platforms.sh --android` builds, installs and launches on a local emulator.
- **Order:** drift gate → prod+test deploy → Mac bundle → `tools/preflight.sh` (the Release builds on this commit, no publish; `--skip-preflight` only if GitHub is down) → tag → push → watched Release run → device builds, one at a time. A failed Release after the tag leaves the deploy live: the lane names the failed jobs, ends non-zero, and the retry is `gh workflow run calmind-release.yml --ref <tag> -f tag=<tag>`. **Quiet CI:** every workflow hands a person's run to github-actions[bot] and never goes red (AgentSuite/ci.md); never `gh run rerun`. Each block runs under `tools/heavy-lock.sh` (the origin of the apps' copies in `../tools/shared-files.json`: source it, edit it only to change all of them); it only sees builds that take it (not other lockless builds, Test* forks, hand/Xcode builds). CoreMind's `bin/build-platforms.sh` is the fallback for a checkout predating this one; `bin/dtp.sh all` delegates to each app's lane.

App-owned, not shared: `desktop/package.json`, `desktop/src-tauri/Cargo.toml` and `desktop/src-tauri/tauri.conf.json` (own VERSION, rewritten by the release lane every ship; `node tauri-build.mjs` dev/build scripts; fixed 480-wide window; deb, rpm and appimage bundle targets) and `packages/core/src/index.ts` (the barrel naming CalMind's own module set).

## Traps

- **`click()` on a gone control** waits out the whole test budget and reads as a hang → give speculative clicks `click({ timeout: 1_500 }).catch(() => {})`.
- **Checks that cannot fail** (empty-string grep, test blind to disabled `openssl_verify`, PHP spec `json_decode`-ing an ENCRYPTED store, absence assertion on a missing container) → break the guarded thing and watch it go red first.
- **`dist` holds several `index-*.js`** (entry + async chunk); `find … | head -1` is arbitrary → read the name from `dist/index.html`; compare index.html to index.html for "did the deploy land".
- **`npm run test:deploy` can make the export look stale:** it appends a type error to `packages/core/src/types.ts` (a one-line `@mind/core` stub like `order.ts`; the probe still turns the typecheck red) and restores via `cp` (new mtime). The content digest stays fresh, but an export without `dist/.sources.json` falls back to mtimes and `e2e/freshness.ts` names `types.ts` → clean `git diff` means mtime only; re-export; run `test:deploy` last.
- **Comments state intent, code may have drifted** (widget key rotating despite "handed out once"; login page not always rendering its theme) → read both.
- **Phone-only bugs:** RN `Modal` is its own window outside the safe area, so absolute positioning sits under the clock; browsers can't show it → check on the simulator. **Tap targets:** measure from the real screenshot (`xcrun simctl io <udid> screenshot`), divide by scale; the shown image is resized. **`hitSlop` is a no-op in react-native-web** → measure the drawn box. Fix with padding + negative margin, but when border/`borderRadius` sit on the pressable, move the visual to an inner View. **Offset-from-own-edge clicks prove nothing** (pass with or without the bug) → measure from the centre outward by a justified distance.
- **Failed writes are silent** (oversized record dropped while "synced", damaged store read as empty account, unsaved snapshot) → ask what happens on write failure; triage every `.catch(() => {})` by what is lost.
