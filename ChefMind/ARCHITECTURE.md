# ChefMind — architecture and operation

**This is a personal project to have some fun with claude code, which generated essentially all of the code, and the rest of this readme:**

The long version of [README.md](README.md): what this repo is, what each screen
does, what was deliberately removed from the app it was cloned from, how
accounts and records are split, and how it is run and shipped. It is written
for whoever comes to the code next, human or agent. [AGENTS.md](AGENTS.md) is
the companion piece — the standing rules, the wiring, the release lane step by
step, and the traps that have cost real time here. Where this file summarises
something AGENTS.md sets out in full, it says so rather than repeating it.

## What it is, and where it came from

CalMind's recipes, with a shopping list and a pantry, syncing through the same
server on the same account. It is a CLONE of CalMind's `apps/app` and
`packages/core`, not a rewrite — see `AGENTS.md` for the rules that keep it
one. It has been its own repo since 2026-08-22, extracted from
[chere005/CalMind](https://github.com/chere005/CalMind) with its history.

## The tree

```
app/            The Expo app, cloned from CalMind's apps/app.
packages/core/  The brain, cloned — plus shopping.ts, units.ts, grocery.ts and
                variant.ts, which have no twins upstream.
tools/          The web export's head patch, service worker, the deploy-guard
                prover, the macOS/iOS/Android builds, and the dtp/tdtp lanes.
deploy.sh       The one deploy: the web client, to production.
spec/           The behaviour contract, copied so core's suite runs here.
```

App-owned, not shared (not listed in `tools/shared-files.json`, plus the config seam): `app/src/api.ts` (SYNC_SPACE and the space field on every sync request); `app/src/components/FolderPick.tsx` (!payload.shopping filter, FolderDot split out, button-controlled open/onClose mode); `app/src/screens/RecipeEditor.tsx` (the Shop pill, addToShopping over the page's ingredients); `app/src/screens/Search.tsx` (no Events filter, kinds read Shopping/Recipes); `app/src/config.ts` (cross-path API derivation on the same origin, host-matched local dev); `packages/core/src/appconfig.ts` (this app's seed profile seam); `tools/app-identity.json` (appDir "app", id "chefmind"); `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json` (own name, identifier, URL, fixed 480-wide window, and the VERSION the release lane rewrites; the shared origins hold the shape, never the numbers).

## Platforms

The web app at [seancheren.com/ChefMind](https://seancheren.com/ChefMind) is an
installable PWA, and production is the only instance. iOS and Android come from
Expo, the macOS desktop shell is Tauri, and Windows `.msi`/`.exe` are built by
CI. Which of those this repo can build for itself, and which it cannot, is
AGENTS.md, "Platforms — what ships where, and how".

## The screens

Three tabs: **Recipes · Pantry · Shopping**.

- **Recipes** is CalMind's Notes screen, renamed. Only the labels moved — the
  record type is still `note`, the folder's app is still `notes`, and the
  recipe card, the measure badges, the scale row and the photo import are the
  same code CalMind runs. Renaming the data to change a word on screen would be
  a migration for nothing.
- **Variants** let one card hold several things you might make from it. The
  Cheese card is four — Ricotta, Mascarpone, Mozzarella, Burrata — sharing a
  page and a shopping list. A variant is a name plus a set of the card's own
  subheaders; choosing one from the dropdown beside ½×/1×/2× hides the rest,
  and everything before the first subheader is shared and always shown.
  *Manage variants* (the gear) adds, renames, deletes and re-ticks them.
- **Edit mode** is a top-bar button, and a long press or a double tap on any
  recipe gets you there too (the owner, 2026-08-21). In it, recipes carry a tick, a
  **Select all** sits beside the pencil, and the bar at the foot offers
  *Delete* (two presses, red on the first) beside *Add to shopping list*.
- **Shopping** is the list those ticks fill. Pick several recipes, press *Add to
  shopping list*, and their ingredients arrive combined and **grouped by aisle**
  — produce, dairy, meat, dry goods, tins — in the order you walk a shop.
  Amounts are summed in ONE unit per thing: grams for mass, millilitres for
  volume, converted exactly. A cup to a tablespoon is a definition and is done;
  a cup to a gram needs a density that differs per ingredient and is refused,
  so those stay two lines. `core/shopping.ts` and `core/units.ts`, tested.
- **Pantry** is what you already have. It is the same screen as Shopping —
  same rows, same aisles — reading a different folder flag, and it
  **subtracts**: anything on it is left off the shopping list entirely rather
  than added and struck through.
- **Edit mode on both lists** is the Recipes tab's, on the same bar. *Select
  all* sits beside the pencil and is the way IN — it arrives in edit mode with
  everything picked — the tick boxes become round select circles while you are
  there, and the foot of the screen offers *Delete* (two presses, red on the
  first) beside **Refresh**. Refresh combines what is alike harder than the
  list could when the rows arrived from different places: plurals and
  preparation words folded together, a bracketed metric measure preferred to
  the cook's own — `2 cups (250 g) flour` counts as 250 g — and cups summed
  with tablespoons. It still will not turn a cup into a gram, because that
  needs a density (`core/shopping.ts`, `recombineLines`, tested).

The rules those three lists keep — why the pantry subtracts rather than strikes
through, why conversion stays within a dimension, why a row is filed by its
ingredient and not its measure, and why a variant names its sections by text
rather than by index — are AGENTS.md, "The three lists, and the rules they
keep".

## What was taken out

| Gone | Because |
|---|---|
| `Calendar`, `Habits`, `core/habit.ts`, `core/layout.ts` | not this app |
| `BalancedRow`, `CalendarPick`, `HabitEditor`, `HabitSectionManager`, `SectionPick`, `tickgrace` | the components of the Calendar, Habits and Reminders screens, which went with them |
| `Requests`, `Request`, the account badge, `core/meetreq.ts` | the public request page is CalMind's |
| `QuickTick`, `watch.ts` and `core/watch.ts`, the watch/widget targets | no watch, no widgets |
| `subs.ts`, `core/calsub.ts`, `core/ical.ts`, `core/rrule.ts` | calendar subscriptions belong to the calendar |
| the Event card on Add | an event is a calendar thing |
| `Reminders`, the Reminder card, and the general reminders FOLDER | The owner, 2026-08-21: "remove reminders from ChefMind" — a general list is CalMind's job. The screen went then; the seeded folder named *Reminders* survived until 2026-08-22 ("that should have been removed completely") because the shape pass needed somewhere to file a stray reminder. The shopping list is that somewhere now, and an account that already grew the folder has it folded in — rows first, then the folder. The `reminder` RECORD stays: the shopping rows are reminder records, and Search finds them under **Shopping** |
| `core/markdown.ts` | it exports a Reminders view as Markdown, and there is no Reminders view |
| `core/chefdate.ts` | the dates CalMind keeps about ChefMind recipes, which ChefMind never sees |
| the repeat pill on Add | what is left there makes a recipe, and a recipe does not recur |
| the time field on Add | a time belongs to a reminder |
| core's calendar and habit STARTERS | records that would sync forever and never be drawn |

## Accounts and data

The owner, 2026-08-21: *"we might as well reuse calmind logins"*, and its own store.

Both, exactly:

- **The API is CalMind's** — `https://seancheren.com/calmind/api/index.php`.
  Same users, same tokens, same passkeys. There is no ChefMind server.
- **The store is not.** Every sync sends `space: 'chef'`, and the server keeps
  one record file per user per space: `records-<user>.json` is CalMind's,
  `records-chef-<user>.json` is this one. See `records_file()` in
  `server/lib/app.php`.

The space is a CONSTANT in `app/src/api.ts`, never configurable: a ChefMind
build that could be pointed at CalMind's records would merge two apps' stores
into whichever synced last.

With the suite's shared sign-in on, the web build (this page and CalMind's API share an origin) holds no token: no
session means `/account/?next=/ChefMind/` and back on the suite cookie, with `X-CSRF-Token` on every write; native and the
desktop shell sign in through the suite's `/account/app/` in the system browser (`app/src/appsignin.ts`, PKCE, redeemed at
CalMind's `signin_redeem` with `space: 'chef'` like every call here) and keep the bearer form only against a server that is not
on shared sign-in. `app/src/api.ts` and `screens/Login.tsx` carry it, CalMind's `docs/api.md` describes it,
and `app/test/sharedlogin.test.ts` covers it.

The server endpoint can be selected for a build with `EXPO_PUBLIC_API_URL`,
for example `https://test.seancheren.com/calmind/api/index.php`. Set it in
`app/.env.local` or the build environment. Expo embeds it in web and native
bundles, so it is public configuration, not a place for secrets. When unset,
the web app keeps its origin-based routing and native builds keep their
production default. Changing this endpoint never changes the fixed `chef`
space.
`app/metro.config.js` folds every `EXPO_PUBLIC_*` into Metro's `cacheVersion`
(`app/metro-cache.js`), so changing the URL can never be answered from a warm
transform cache. The desktop shell's CSP `connect-src` follows it too:
`desktop/tauri.mjs` (what `npm -w @chefmind/desktop run dev|build` runs) swaps
the default `https://seancheren.com` origin in `tauri.conf.json` for the
configured server's (`desktop/csp.mjs`); unset leaves the config untouched.

`deploy.sh` **refuses to ship** unless the live API answers the public `spaces`
action naming `chef`. An API that does not know the parameter ignores it, and
then nothing errors while every ChefMind record lands in CalMind's own store —
found weeks later, by a reminders list with recipes in it.

How the records themselves are shaped, how `core/sync.ts` merges them, and
where the app's one stateful seam lives are AGENTS.md, "How it is wired".

## Running it locally

```
npm install
npm run export:web && node tools/patch-web-html.mjs app/dist/index.html
CALMIND_DATA_DIR=/tmp/chefmind-dev-data php -S 127.0.0.1:8792 e2e-router.php
```

…then http://127.0.0.1:8792/ChefMind/. The router serves this app at /ChefMind
and CalMind's API at /calmind/api, which is the arrangement production has —
one origin, two paths. The API itself lives in the CalMind repo: the router
assumes a sibling checkout at `../CalMind` (`CALMIND_REPO` overrides it).

That is one server short of a working login, though, and the shortfall is not
obvious from the arrangement: `config.ts` returns
`http://127.0.0.1:8788/api/index.php` for ANY localhost hostname, so the page
served on 8792 does not talk to the router's own `/calmind/api` half — it talks
to 8788. Start CalMind's dev API there as well, `php -S 127.0.0.1:8788 -t
server/public` from the sibling checkout, or the login card fails against a
port with nothing on it while the router sits answering nothing. AGENTS.md's
traps set out why at length.

## Deploying

```
./deploy.sh --dry-run     # preview
./deploy.sh --yes-prod    # do it
./deploy.sh --verify      # check what is live
```

It writes `/home/public/ChefMind` and nothing else. There is no test instance:
The owner asked for it straight at production, so the gates are the whole rehearsal.
The SSH login lives in `deploy.conf` (gitignored — see `deploy.conf.sample`).

## Releasing

A release is one gesture, and it ships every platform this repo has — the web,
then the macOS bundle, then iOS and Android:

```
npm run dtp                      # deploy, tag, push — bumps the minor version
npm run tdtp                     # the same lane with the full test run in front
npm run tdtp -- --web            # the release only, no platform builds
npm run tdtp -- --mac            # …and just the desktop bundle
```

Naming a platform selects only it; naming none means all of them. Windows is
CI's alone, since Tauri does not cross-compile (see "Releases" below).

What the lane does in what order — why the desktop bundle comes before the tag
and the device builds after the push, why a device build that fails leaves the
release standing and still ends the lane non-zero, and how a run reports itself
to seancheren.com/status — is `AGENTS.md`, "The release lane, end to end". It
is written once, there.

The platform builds live in `tools/build-platforms.sh`, runnable on their own:

```
sh tools/build-platforms.sh --mac --ios --android
```

## Releases

Pushing a namespaced version tag (`ChefMind/1.30.0`) starts the **ChefMind Release**
workflow (the suite root's `.github/workflows/chefmind-release.yml`), which builds the desktop installers on
GitHub's runners and attaches them to ONE GitHub release for that version. The
release is created as a draft and published only when every expected file is on
it:

| Platform | Files |
| --- | --- |
| Windows (x64) | `ChefMind_<version>_x64_en-US.msi`, `ChefMind_<version>_x64-setup.exe` (NSIS) |
| macOS (Apple silicon) | `ChefMind_<version>_aarch64.dmg` (built with `--bundles dmg` passed in CI; `tauri.conf.json` is unchanged) |
| Checksums | `SHA256SUMS.txt` |

There is no Linux build and no Intel Mac build. Jobs, in order: `prepare` (the
tag must equal the version in every file that carries it: `package.json`,
`app/app.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml`, checked by `tools/release-versions.mjs`; a tag
that is already a published release is refused; the notes are the tag's
annotation, else the tagged commit's message; the draft is created), then
`windows` and `mac` in parallel (typecheck, then the web export and head patch
as `deploy.sh` runs them, then `tauri build`; Windows installs the MSI on the
runner and checks it launches and opens a ChefMind window; the Mac job also
runs the test suites, which need a POSIX shell), then `publish` (every file is
there, `SHA256SUMS.txt` is attached, the release is published as Latest; a
version containing `-` is a pre-release instead). A missing file leaves the
release a draft.

**Cutting a release** is the lane: `npm run tdtp` (or `dtp`). It bumps the
version, deploys, builds the Mac bundle, runs the preflight, tags and pushes,
and after the device builds tdtp follows the release (`tools/gh-bot.sh
release`) and prints the published release's URL; dtp does not wait, and the
next lane run warns at its start if the last release never published. If the
release is not published, the deploy and tag stand; the lane reports the
failed jobs and ends non-zero, and the fix is to correct the cause and run
`gh workflow run chefmind-release.yml --ref <tag> -f tag=<tag>` (the full
namespaced tag, e.g. `ChefMind/1.30.0`).

**Quiet CI** (AgentSuite/ci.md; `python3 ../AgentSuite/tools/check-workflows.py .`).
GitHub mails a run's outcome to whoever triggered it. A run a person starts
(the tag push, a dispatch, a re-run) runs only `handoff`, which dispatches the
same workflow as github-actions[bot]; the bot's run does the builds, so no
failure, timeout or runner GitHub never provides can mail anyone. Every job is
`continue-on-error`; the scripts read each job. A release run that ends with a
platform missing dispatches itself again (input `attempt`, three runs at most),
building only what the draft lacks.

**An existing tag with no release** (a past version, or after deleting a bad
draft): `gh workflow run chefmind-release.yml --ref main -f tag=<tag>` (e.g. `ChefMind/1.30.0`). It builds the tag's
own tree with the current workflow.

**Preflight** (`sh tools/preflight.sh [tag]`, run by the lane right before the
tag, skippable with `--skip-preflight`): pushes HEAD to a throwaway
`preflight/chefmind/<sha7>` branch, dispatches the release workflow there with `preflight=true`, waits,
prints PASS or FAIL naming the failed jobs and steps, and deletes the branch.
A preflight run builds everything (in the bot's run) but creates and uploads
nothing. Release workflows are dispatched by name, so the first
preflight needs `chefmind-release.yml` on `main`.

**No `actions/upload-artifact` or `download-artifact`**, anywhere in the
workflow: the account's Actions artifact storage quota is full and every run
that used it failed. Release assets do not count against that quota, so each
build job uploads straight to the draft with `gh release upload`.

**Installing the unsigned builds.** Windows shows "Windows protected your PC"
(SmartScreen): choose *More info*, then *Run anyway*. macOS Gatekeeper stops the
first launch of the app (not notarized): right-click it and choose *Open*, or
System Settings > Privacy & Security > *Open Anyway*. The release notes carry
the same two lines.
