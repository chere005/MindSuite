# CoreMind: the map and the doctrine

**This is a personal project to have some fun with claude code, which generated essentially all of the code, and the rest of this readme:**

This is the long form of [README.md](README.md), written for agents and humans
both: what is in here, how it moves, and why. How to WORK in here — the
standing rules, the traps — is [AGENTS.md](AGENTS.md); nothing below
contradicts it.

CoreMind is the suite's release orchestration (`bin/`) and its docs. It ships
to no platform and nothing imports it. The code the apps share is not here.

## Shared code

Three homes, all at the suite root:

- `packages/mind-core` (`@mind/core`): every shared TypeScript module body, the
  spec vectors (`spec/`) and the tests that pin them. Apps depend on it by a
  `file:` link and reach a module through a one-line stub in their own
  `packages/core/src` (`export * from '@mind/core/<name>'`);
  `test/facade.test.ts` pins each app's stubs and the package's closed import
  graph. It has no dependencies of its own and borrows CoreMind's tsc and
  vitest (`npm run check:mind-core` at the root).
- `packages/mind-server`: the origin of the shared PHP files and their tests.
  Never deployed from there; each app deploys its own copy.
- `tools/shared-files.json`: every other byte-identical file, as groups of one
  `origin` (CalMind unless a superset lives elsewhere) and its `copies`, plus
  `external` entries for copies in the seancheren-site checkout.
  `tools/check-shared.mjs` compares them (`npm run check:shared`; `--app <Dir>`,
  `--external`, `--fix <id|all>`, `--list`) and fails on drift, a missing file,
  or a run that compared nothing. A file an app owns is simply not listed.

A shared fix lands at the origin, `--fix` copies the same bytes over the
copies, and `check:shared` proves it. CalMind's and AcctMind's release lanes
refuse on a red group; PlanMind and TaskMind run it as `check:core`; the core
lane runs it before tagging. `bin/check-drift.sh` is a compatibility shim over
it for seancheren-site's board sync, which parses its last line
(`<N> consumer(s): <D> drifted, 0 copies owed, <F> failures`); delete it when
the site reads check-shared. The site asks per app only when
`consumers/<App>.tsv` exists, so with the manifests deleted its board gets the
CoreMind line and role `none` for the five apps until the site changes.

Per-app seams, so a shared body never forks for a value:

- `packages/core/src/appconfig.ts` (app-owned) holds `APP_SEEDS`, the seed
  profile `normalize` runs with; the body is `packages/mind-core/src/normalize.ts`
  (no profile means `SUITE_SEEDS`) and each app's `normalize.ts` is a wrapper
  defaulting to `APP_SEEDS ?? SUITE_SEEDS`. CalMind's is `null`; ChefMind's is
  its `'lists'` profile. Their `test/seedsnapshot.test.ts` files pin the seeded
  data.
- `tools/app-identity.json` (app-owned: `appDir`, `id`) is read through the
  shared `tools/app-identity.mjs` by the web-build tools (`source-digest.mjs`,
  `patch-web-html.mjs`, `sw.js`, `desktop/stage-dist.sh`), which are the same
  bytes in CalMind and ChefMind. The app's name on screen is
  `<appDir>/app.json`'s `expo.name`, exported as `APP_NAME` by the shared
  `app/src/brand.ts`.
- `packages/mind-core/spec/protocol.json` is a contract, not a copy: the
  record-id pattern and the sync batch limit. The client tests assert against
  it, and CalMind's own tests of the same terms also hold `server/lib/app.php`
  to it, so a server and a client cannot disagree about an id.

## The apps

| repo | what it is |
|---|---|
| CalMind | the origin: calendar/reminders/notes/habits/recipes, web+iOS+Android+macOS+watch, and the only full production server |
| ChefMind | recipes + shopping list on CalMind's server, kept apart by a sync space |
| AcctMind | the ledger: a sibling RE-IMPLEMENTATION of the architecture, not a clone |
| PlanMind | a private web app with a PHP server, and Tauri shells that open it |
| TaskMind | a private web app on PlanMind's pattern, with macOS, iOS and Android shells |

MyCalMind (CalMind with the server taken out) is paused and not in this
checkout; the repo-root docs/CONTINUATION.md records where its copy-down comes
from on resume.

AcctMind takes the fold rule through `@mind/core/folds` (its
`packages/core/src/folds.ts` is the one-line stub) and carries the drag rule
`packages/core/src/rowslots.ts` as a listed copy; both import nothing, which is
what lets a core whose tsconfig sets `"types": []` carry them. It also shares
the desktop shell's `build.rs` and the release helpers. Its pick bar is its own
fork of ChefMind's.

PlanMind and TaskMind are web apps first (vite and TypeScript, behaviour in
`packages/core`, a PHP server in `server/lib`) with thin Tauri shells that open
the same private HTTPS app, so they share only a few files: the themes, the
atomic storage helper and its check, the Tauri `build.rs` and the release
helpers. Neither is a private target in the `.private-targets` sense: their
lanes are tracked here, and `bin/plan.sh` orders TaskMind after PlanMind.

### Private targets

Targets the owner keeps private are listed, one name per line, in an
untracked, gitignored `.private-targets` at the checkout root (default: none;
the file is per machine). They share no file in `tools/shared-files.json`;
`bin/plan.sh` appends them after the public targets, and `bin/deploy.sh` /
`bin/dtp.sh` run their own `tools/` lane and report to the status page like the
rest.

## The map

```
bin/plan.sh       The release graph (ORDER, downstream_of); sourced, never run.
bin/deploy.sh     Deploy the suite, or one target and its downstream.
bin/dtp.sh        The suite orchestrator behind `npm run dtp` / `tdtp`.
bin/report-status.sh  How a release tells seancheren.com/status about itself:
                  a start, a beat every minute while a lane runs, a finish.
                  bin/dtp.sh calls it; it can never fail a release.
bin/check-drift.sh  Shim over ../tools/check-shared.mjs (see Shared code).
bin/check-heavy-lock.sh  The proofs of the heavy-build lock
                  (CalMind/tools/heavy-lock.sh): each guarantee shown
                  holding, then broken out of a copy and shown caught.
bin/build-platforms.sh  The fallback platform builder (see Platforms).
bin/check-*.sh    The release-plan, locked-install, machine-env,
                  personal-data and names checks.
```

## Checking

```sh
npm install
npm test          # PHP storage, auth and mail suites, then @mind/core's suite
npm run typecheck # @mind/core
npm run check     # every shared-files.json group, against its origin
sh bin/check-heavy-lock.sh   # after a change to the heavy-build lock (~2 min)
```

## Deploying

CoreMind ships to no server and no store. Its lane copies nothing into the
apps: it checks `@mind/core` and `tools/shared-files.json`, then tags itself.

```sh
npm run deploy -- all                # core's checks, then every app, in order
npm run deploy -- CalMind            # CalMind — and ChefMind, which needs it
npm run deploy -- --only ChefMind    # that one alone, cascade suppressed
npm run deploy -- all --plan         # resolve the order and stop
```

### The dependency graph, and why it cascades

```
core ──▶ CalMind, ChefMind, AcctMind, PlanMind, TaskMind
CalMind ──▶ ChefMind
```

Both edges are real, not tidy:

- **Core is the apps' checked source.** A change to `packages/mind-core` or a
  shared file changes their builds, so `dtp core` ships the downstream apps
  after core's checks (`--only core` stops at core). `deploy.sh core` runs the
  same checks, writes nothing, and drops apps that were here only by cascade.
- **ChefMind has no server.** It syncs through CalMind's API in the `chef`
  space, and its own deploy REFUSES to ship unless the live API reports that
  space. CalMind must land first. That ordering used to live in somebody's
  memory; it lives in `bin/plan.sh` now, which `bin/deploy.sh` and
  `bin/dtp.sh` both source — and that is the whole point.

`AcctMind`, `PlanMind` and `TaskMind` depend only on core, not on each other. A
private target is independent as well, for the reasons above.

## Platforms

The release lanes ship the **web** (and dispatch the Windows job in CI). The
three a web release does not ship by itself — **macOS, iOS and Android** — now
belong to the apps: every app carries its own `tools/build-platforms.sh`, and
each one's own lane runs it.

```sh
npm run dtp -- all --platforms                         # release each app, platforms and all
npm run dtp -- all                                     # the web only — the flag is the switch
(cd ../ChefMind && sh tools/build-platforms.sh --ios)  # one app, one platform, by hand
```

**Who builds what is a rule with one home: AGENTS.md's Platforms section.**
CoreMind owns the ORDER and the pass-through; each app owns its own artifacts.
`bin/build-platforms.sh` is still here, but as the FALLBACK for a checkout
predating 2026-08-23 — `npm run dtp` calls it for no app today.

The machinery is still shared; it just stopped being one script. Each app's
copy came down from `bin/build-platforms.sh`, comments and all, the way the
other shared tool scripts do — because a device build, unlike a production document
root (the one thing that must never be built from a variable), has no
destination to get wrong. When the fallback does run, a platform failure is
reported rather than fatal — the release has already tagged and pushed by then
— but the run still ends non-zero, so "it all worked" cannot be read off the
exit status. Inside an app's own lane the split is sharper: the desktop bundle
is built BEFORE the tag, so a broken one stops the release and the re-run
reuses the version; the device builds run after the push, where a phone that is
not plugged in is reported and nothing more.

**One heavy build at a time is enforced among the builds that take the
lock.** Every platform block in `bin/build-platforms.sh` — the Mac bundle, the
iOS build, the Android build — runs under `heavy_lock` from
`CalMind/tools/heavy-lock.sh`, a lock every app carries byte for byte as
`tools/heavy-lock.sh`.
It is a directory made with `mkdir`, which is atomic, at one per-user path
outside every repo, so two sessions, two checkouts or a lane and a hand-run
script all queue on the same one. A block that finds it held waits and says
whose it is, on the terminal and on the status card; a holder that died is
taken over; a wait past 30 minutes fails the step rather than hanging the lane.
Overlap is what turned a 246 s AcctMind lane into a 1574 s one on 2026-09-30,
the night two sessions built at once (gradle 95 s → 412 s); waiting for the
other build costs only its remaining minutes. AGENTS.md's Platforms section
has the details and the proofs.

What takes it today: every app's `tools/build-platforms.sh` (PlanMind's and
TaskMind's too, each carrying the lock byte for byte), MyCalMind's
`tools/deploy-device.sh`, AcctMind's `desktop/smoke.sh` when it builds, and
the fallback here. It looks for no build process, only for the lock, so it
does not see a build that never takes it: a private target's (in the dtp
ORDER, carrying no copy of the helper), the TestMindSuite forks', an xcodebuild, gradle or cargo typed by hand, or a
build started from Xcode's own window. Beside one of those, a lane still
builds at the same time.

**Android IS covered**, and has been since 2026-08-22 (`bf571bc`). Every app
builds `assembleRelease`, installs it, and LAUNCHES it on a reachable device —
an emulator already running, real hardware, or an AVD booted here when neither
is — and the step fails unless the process is still up afterwards. Nothing in
the suite has a release keystore; gradle signs both build types with the
auto-generated debug one, which is why the release APK installs as easily as a
debug build would. This paragraph said the opposite until 2026-08-23.

## Releasing the whole suite

```sh
npm run dtp -- all       # deploy, tag, push — every repo, core first
npm run tdtp -- all      # the same, with the full test run in each lane
npm run dtp -- CalMind   # CalMind and its downstream
```

Each repo's own `tools/dtp.sh` does the work; this adds the order and a
**pre-flight that checks every repo in the plan before the first one ships** —
a run that stopped at the third repo because it was on a branch would already
have tagged and pushed two releases, and those do not come back.

## What is deliberately NOT here

- **Each edition's seams**: the `packages/core/src/index.ts` barrels (the
  export set IS the edition), `store.tsx`, `chrome.tsx`, per-app screens that
  diverged by design.
- **Single-owner modules**: ChefMind's `shopping.ts`, MyCalMind's
  `fetchguard.ts`/`recipefetch.ts`/`peer.ts`, CalMind's request/QuickTick
  surface.
- **AcctMind's core and spec** — a re-implementation, documented above.
- **Deploy scripts and their guard provers** — three genuinely different
  scripts sharing doctrine, not code: per-app destination tables ARE the app.
- **The server** — CalMind's alone, by design; ChefMind rides it via the sync
  space. Only the PHP files in `packages/mind-server` are shared (with
  PlanMind, TaskMind and the site).
