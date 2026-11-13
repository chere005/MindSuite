# Working in TaskMind

@../../AgentSuite/AGENTS.md

Private team task app (projects, tasks, subtasks, assignees, list and board, My tasks, comments, GitHub sync) for the owner and the partner now and a full team later. It graduates the interim page at seancheren.com/taskmind/. Read `README.md` for architecture and commands, `docs/GRADUATION.md` for what is ported and what is next.

- Behavior lives in `packages/core` and `server/lib`, with disposable regression fixtures. Views contain plumbing.
- The parser uses `@mind/core`; other CoreMind files are copied byte for byte; `tools/shared-files.json` is the contract.
- Reuse seancheren-site's configured accounts and session. A site account is not a membership: every data request independently authorizes a workspace member (`team_member`, read on every call). Never add signup, public sharing, or a client-side-only access gate.
- Roles, the permission matrix and caps have one source, `packages/core/src/model.ts`; `server/lib/limits.php` is generated (`node tools/gen-limits.mjs`, `npm run check:limits`), never hand-edited.
- A hidden button is not authorization: the server answers the same matrix. A private project, its tasks, comments and events are never sent to someone not on it, and an id the viewer cannot see answers like one that does not exist.
- Never cache private responses, credentials, or task data in browser storage or a service worker. A failed read is never an empty workspace; an unreadable workspace fails closed (only the seed owners are told why).
- Deploy touches only `$PUBLIC_BASE/TaskMind` (a symlink), `$PUBLIC_BASE/.taskmind/` (public release dirs, denied to direct URLs) and `/home/protected/taskmind[-test]/` (lib releases). The data dir `/home/protected/taskmind-data[-test]`, credentials and the parent site's source never ride a deploy.
- Default deploy is test. Production needs `--prod --yes-prod`. Follow AgentSuite's existing authorization rules for commits/releases.
- Native Tauri shells for macOS, iOS and Android (Windows optional) open the same private HTTPS app. No native IPC capabilities or public app-store listing.
- Heavy builds (cargo/Tauri, Xcode, Gradle) run only through `tools/build-platforms.sh`, under `tools/heavy-lock.sh`; `--debug` builds the Mac app and the Android APK without installing them.
- The interim page lives in seancheren-site and keeps running until this app replaces it; read it, never edit it from here.
- Ports: 8870 for `npm run dev` and the native debug build's local preview, 8871 for e2e (`TASKMIND_PORT`, `TASKMIND_E2E_PORT`). Stop what you start.

## Traps

- **`tauri android init` runs rustup** and adds the four Rust Android targets, and writes Tauri's stock launcher icons into `gen/android` (the same as iOS) → `build-platforms.sh` copies `icons/android` over them; `gen/` is generated and ignored, never edit it.
- **A first Android build needs the network** (Gradle and Maven dependencies, crates only Android uses: `cargo metadata --offline` fails on them); the Mac build runs offline from the crate cache.
- **`headers_list()` is empty under the CLI** → the gate case (`server/tools/cases/gate.php`) runs the real `api.php` under php-cgi; `PHP_CGI` names it when it is not next to `php`.
- **`check 'name' test A && grep B` in `tools/test-deploy.sh` runs the grep outside the check** → it asserts nothing. One condition per check, or the `p_*` helpers.
- **`index.php` and `api.php` run before the lib is found**, so each repeats the release-stamp and host-instance patterns inline → `team.php` (server case) fails if they disagree with `taskmind.php`.
- **`tauri.conf.json` takes no extra keys**, and `dmg` is never built locally (create-dmg needs Finder: `--bundles app`).
- **`npm test` never runs `test:deploy:mutations`** (minutes); run it after changing `deploy.sh`, `dtp.sh`, `build-platforms.sh` or `package.mjs`.
- **The Android release key lives in `~/.config/taskmind/`, not the repo** → `t_platforms` runs with `HOME` set to a fake home so a test never makes or reads the real one; never point a test at the real `$HOME`.
- **A mutant of the Mac install path would `rm -rf /Applications/TaskMind.app` for real** (the shims cannot catch a literal path) → no mutant of the non-debug Mac block, and `t_platforms` runs `--mac` only with `--debug`.
