# Working in CoreMind

The baseline for all of the owner's repos lives in ~/GIT/AgentSuite/AGENTS.md
and is imported here; this file holds only what is true of THIS repo.
@../../AgentSuite/AGENTS.md

## Rules

- **CoreMind holds no shared code.** TypeScript bodies live in `../packages/mind-core` (`@mind/core`; apps reach them through one-line `packages/core/src/<m>.ts` stubs, pinned byte for byte by its `test/facade.test.ts`), PHP origins in `../packages/mind-server`, and every other byte-identical app file is a group in `../tools/shared-files.json`; there is no canon tree and no per-app manifest.
- **A shared file changes at its origin.** Edit the group's `origin` (CalMind unless a superset lives elsewhere), then copy the SAME BYTES over its `copies` (`npm run check:shared -- --fix <id|all>` from the suite root, clean tree only); never edit one copy alone.
- **`shared-files.json` is hand-kept** (version 1: `groups` of `origin` plus `copies`, and `external` entries for the site's copies). `check-shared` fails on a missing or non-plain file, drift, or a run that compared nothing; a file an app owns is simply not listed. Never drop a group or a copy to go green.
- **The site's copies are `external` entries,** compared only by `npm run check:shared -- --external` against a sibling `seancheren-site` checkout (`MIND_SITE_DIR` names another; an absent one prints `skipped`). The site owns its copy-down and proof.
- **The deploy graph lives only in `bin/plan.sh`** (`ORDER`, `downstream_of()`, `resolve_plan`); `bin/deploy.sh` and `bin/dtp.sh` source it before reading flags; a new edge goes there. Deploys CASCADE; `--only` ships one thing.
- **`npm run dtp` / `tdtp` wrap `bin/dtp.sh`**, the suite orchestrator (not a per-repo release script). No default target: pass one after `--`. tdtp (`--full`) runs each repo's tests first. Core's lane bumps its minor only on a tag collision, else tags what `package.json` says.
- **`bin/report-status.sh` is this repo's.** Every failure path warns on stderr and exits 0; `start` prints its run id even if the push failed (caller still owes a `finish`).
  `bin/dtp.sh` calls it at five points (start, a beat each minute, three finishes: failed / shipped-with-platform-build-down / clean) and exports `MIND_RUN_ID`; a lane that sees it reports nothing.
- **A lane's non-zero exit means "shipped, a build is owed", not "stopped".** `bin/dtp.sh` folds it into `PLATFORM_BAD`, continues, and ends non-zero itself at the finish.
- **The TAG is the evidence, never the exit code:** a tag the lane itself made, absent before it ran. HEAD still carrying the PREVIOUS release's tag proves nothing. A lane that failed BEFORE its tag stops everything; so does one killed by a signal (exit >128), whatever its tags say; ^C/TERM at the batch ends it, card closed once, dying of that signal.
- **The core lane copies nothing:** `bin/dtp.sh` and `bin/deploy.sh` run `check:mind-core` and `node ../tools/check-shared.mjs`, and the lane refuses to tag if a tracked file changed under them. `deploy.sh core` drops the apps that were here only by cascade; `dtp.sh core` still ships `downstream_of core` after it unless `--only`.
- **`bin/check-drift.sh` is a shim** for seancheren-site's `tools/taskmind-sync`: it runs `check-shared` (an app name becomes `--app`) and ends with the legacy `<N> consumer(s): <D> drifted, 0 copies owed, <F> failures` line, which that reader parses; delete it with the reader. The reader asks per app only when `consumers/<App>.tsv` exists, so with the manifests gone it gets the CoreMind line and role `none` for the five apps until the site changes.
- **Mail is off by default:** `../packages/mind-server/lib/mail.php` is the one SMTP transport (strict `mail_enabled` flag), tested here by `../packages/mind-server/tools/mail-test.php` against a fake local SMTP server; CalMind carries it byte for byte (a `shared-files.json` group), seancheren-site keeps a hand-copied twin that is not listed (identical below the "transport" rule: bounded non-blocking I/O under one deadline, TLS 1.2+, scrubbed logs, size limits); live sending requires the host's configuration.

## Commands

Before committing run all: `npm test` (storage, auth and mail suites, then `@mind/core`'s suite), `npm run typecheck` (`@mind/core`), `npm run check` (`tools/check-shared.mjs`: every `shared-files.json` group). `npm ci` here also installs the tsc and vitest `packages/mind-core` borrows (exact versions, no workspaces).

```
npm run dtp -- --only core        # CoreMind alone: check @mind/core and shared-files.json, tag, push
npm run dtp -- all                # every repo, core first
npm run tdtp -- all --platforms   # test-first, whole suite, plus each app's macOS/iOS/Android builds
sh bin/check-heavy-lock.sh        # also required after any change to CalMind/tools/heavy-lock.sh (the origin)
sh bin/check-plan.sh              # the release order and the .private-targets extension (seconds)
sh bin/check-locked-install.sh    # devicectl_install names a locked phone (stubbed devicectl)
sh bin/check-retry-installs.sh    # owed installs: record, retry, supersede, corrupt state (stubbed devicectl)
```

- `downstream_of core` in `bin/plan.sh` lists CalMind, ChefMind, AcctMind, PlanMind, TaskMind; the core lane's dirty-after-checks guard in `bin/dtp.sh` loops over that same list, so a new app is added in one place. PlanMind and TaskMind check their copies through `tools/check-core.mjs` (`check:core`), which runs `check-shared --app` for them. `check-heavy-lock.sh` stays out of `npm test` (waits ~2 min; core lane runs `npm test` every tdtp).

## Platforms

CoreMind ships nothing of its own; it tags the suite as `CoreMind/x.y.0` and stops. Platform builds belong to the app.

- Each app carries `tools/build-platforms.sh`; `bin/dtp.sh` DETECTS it and passes `--platforms` through as `--mac --ios --android` to lanes that take those names, in a `--mac)` arm or a `--mac|…)` one (else bare), since a bare app dtp builds no platforms (`--web` = release with no platform builds, when unset). CoreMind owns the ORDER and the pass-through only. Private targets ride along: name them, one per line, in the untracked, gitignored `.private-targets` at the checkout root (default none, per machine); `bin/plan.sh` appends them last and `bin/deploy.sh`/`bin/dtp.sh` run their own `tools/` lane, taking `--web` as a no-op.
- `bin/build-platforms.sh` is the **fallback**, run only for an app with no script of its own (today none) and the ORIGIN of the copies; keep it complete. Flags: `--mac`/`--ios`/`--android` subset, `--dry-run` plan only, none = all three.
- **macOS:** Tauri bundle for CalMind, ChefMind, AcctMind; Mac Catalyst app for MyCalMind (no Tauri). Copied into `/Applications` and verified.
- **Catalyst:** MyCalMind's `withMacCatalyst` plugin plus the script cover: widget target needs `SUPPORTS_MACCATALYST`; arm64 only (no x86_64 slice); builds from source (`EXPO_USE_PRECOMPILED_MODULES=0 RCT_USE_PREBUILT_RNCORE=0`); vendored ReactNativeDependencies malformed for that slice.
- **RNDeps repair not durable:** `[CP-User] [RNDeps]` phase is `alwaysOutOfDate`, re-extracts the pristine bundle mid-build → repair is PATCHED INTO that phase by `bin/patch-rndeps-catalyst.js` (idempotent; the copy that runs is MyCalMind's `tools/patch-rndeps-catalyst.js`). `expo prebuild` rewrites the pbxproj → rerun.
- **Android:** build, install, launch on local emulator or hardware for CalMind, ChefMind, AcctMind, MyCalMind.
- **TaskMind:** its own `tools/build-platforms.sh` builds macOS, iOS and Android Tauri shells that open the private HTTPS app; a bare run builds Mac and iOS only, so `--platforms` must name all three (see `bin/dtp.sh`). iOS targets are the phones listed for it in the untracked `.local/machine.env` (the script decides, not CoreMind).
- **Per-machine values:** devices, the Apple team and the people the lanes install for live in the untracked `<app>/.local/machine.env` (`CalMind/tools/machine-env.sh`, shape in `CalMind/tools/machine.env.sample`; every app carries both byte for byte); lanes stop naming the missing key. `bin/check-personal-data.sh` fails on a UDID, team id, gmail address, `/Users/<name>/` path or any machine-file value in a tracked file; `bin/check-machine-env.sh` proves the refusals. A list of SHA-256 digests of scrubbed values may sit untracked in `CoreMind/.local/personal-data.sha256` (the check loads it when present); never commit one, short names are guessable from their digests.
- **iOS:** builds once, installs via `devicectl` to every phone the app belongs on: CalMind to the owner's, Person B's, Person C's; ChefMind to the owner's and Person B's; AcctMind to the owner's; nothing else on Person B's or Person C's.
  `devicectl_install` (marked block in `bin/build-platforms.sh`) prints devicectl's own error and, when it says locked/passcode/busy, one line "<phone> is locked — unlock it and re-run the install step".
  Off phone: skipped with a note; refusing phone: warned; fails only if NONE took it. CalMind also installs its watch companion when a paired Watch is reachable.
- **Owed installs:** a phone that was away or refused the install is recorded (app, version, bundle id, device id, phone index, saved copy under `~/Library/Application Support/MindSuite/{owed-installs.json,builds/}`; `MIND_OWED_DIR` overrides). `bin/retry-installs.sh` (origin; every app carries it as `tools/retry-installs.sh`, a `shared-files.json` group) installs the saved copy on each reachable owed phone, checks the version with `devicectl device info apps`, and drops the entry; an unreachable phone keeps it quietly, nothing is prompted, output names the phone by its 1-based index only. Every lane's iOS step runs it first and calls `record`/`clear` per phone; a newer install clears older entries. A state file that does not parse is kept as `.corrupt-<time>` and never fails a lane. Run it by hand any time: `sh tools/retry-installs.sh`.
- **No per-phone app cap:** team TEAMID0000 is PAID (`TimeToLive 365`); notes about freeing a slot are obsolete.
- MyCalMind iOS is BUILD ONLY, never installs: its `tools/deploy-device.sh` owns its device deploy (two lanes on one phone disagree).
- **Heavy builds are serialized by a lock, not memory:** every platform block in `bin/build-platforms.sh` runs in `heavy_lock "<app> <platform>"` … `heavy_unlock` from `CalMind/tools/heavy-lock.sh` (each app carries it byte for byte as `tools/heavy-lock.sh`; adopting it in their build script is each app's change).
- Lock: `mkdir` at `/tmp/mind-heavy-<uid>.lock` (per machine user, outside repos; `$TMPDIR` is not shared).
- A waiter prints the holder (repo, step, pid, since) every 30 s, reports to the card via `MIND_PHASE_FILE`, fails after 30 min (`MIND_HEAVY_WAIT`). Dead/recycled holder pid is taken over; uncreatable lock or nested heavy block fails at once.
- Released on EXIT, INT, TERM via traps that WRAP the caller's. `check-heavy-lock.sh` uses its own scratch lock (`MIND_HEAVY_LOCK`, nothing else may set it).
- derivedData and gradle cache stay on the internal disk: `/Volumes/SPACE` is exFAT (no codesign xattrs, no atomic dir writes for gradle; see `BUILD_SCRATCH` note in `bin/build-platforms.sh`).

## Traps

- `CalMind/tsconfig.base.json` is the origin of ChefMind's copy; `packages/mind-core/tsconfig.json` inlines the same options and extends nothing, so a config outside that package never changes what its tsc or vitest reads (ChefMind's gate key keys the package whole).
- `check-shared` resolves every path from the suite root (the directory above `tools/`), so it needs no `MIND_DIR`; with `--external` a missing `seancheren-site` sibling is `skipped`, not compared: read the output, not the exit code.
