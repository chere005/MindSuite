# PlanMind continuation for Claude

## Current release

PlanMind 0.27.0 adds the phone Day menu, per-person Both colors and the CalMind all-day strip described below.

PlanMind 0.26.0 adds two Day changes on top of 0.25.0 (tag `PlanMind/0.25.0` is `38696c7e`). The store format is still v5 and nothing migrates: stored appointments keep their lengths.

- A new Day appointment is 30 minutes (`CAPS.eventDefaultLength`, generated into `limits.php`), where it was an hour. The 30-minute minimum, quarter-hour starts and resize precision from 0.25.0 are unchanged. A gap shorter than 30 minutes still has no landing, and the hover preview shows the half hour.
- CalMind overlay cards on the Day are placed with the planner's own `spanBox`, sit flush at page cuts, are opaque and stay readable at every height and column width (`e2e/calmind-grid.spec.ts`).
- **(0.27.0)** The Both color is each person's own (#138): an account preference (`planmindBothColor` in the prefs file beside the theme, action `setBothColor`), so the store stays v5 with no migration and an older release still opens it; `settings.bothColor` is the default until someone picks. The linked-priority text cap stays 18 (decided 2026-11-09).
- **(0.27.0)** CalMind all-day events are a read-only strip above the Day's timeline (#171): `GET ?calmind=1` also returns `allDay`; planner day D owns the all-day date D and a multi-day event is on each day it runs; two rows at most with `+N`; absent when none (`docs/ux/IMPLEMENTATION-SPEC.md` 4.1b).
- Month cells sit on the page background and Today has no accent bar (0.22.0); the specs now say so.

## Continuing from Claude or Windows

Use `main` for ongoing source work and the applicable `PlanMind/x.y.0` tag to inspect deployed source. The shared planner is TypeScript and PHP. The private Windows Tauri shell is under `native/`, with packaging documented in [README.md](../README.md#native-and-deployment). TaskMind #136 tracks the Windows installers. Its source branch is `windows/native-shell-build` at `2e61e2b2ed0af53455e52ceaa22e32c148fa8ad5`.

The schedule renderer and scroll handling live in `app/panels/day/ScheduleSection.ts` and `app/panels/day/Gesture.ts`. Sizing is in `app/styles/day.css`. The focused geometry spec is `e2e/entry-look.spec.ts`, and drag and resize checks are in `e2e/drag.spec.ts` and `e2e/boundary-drag.spec.ts`. The encrypted-store migration is in `server/lib/planner_migrate.php` with disposable coverage in `server/tools/cases/migration-v4.php`.

## Release tooling and paused state

Standalone release lanes report to the shared status page through CoreMind. The iOS installer uses the marked CoreMind helper to retry once and identify a locked or busy device. Both paths have disposable fixtures in `tools/test-deploy.sh`. Keep local `deploy.conf` and staging credentials private during checkout migration. Release gate output and the count-only migration receipt are in `.local/day-interaction-review/dtp-0.25.0.log` and `.local/day-interaction-review/migration-receipt.log`. The guarded operator apply wrapper is `.local/day-interaction-review/duration-audit.sh` with `duration-apply.php` beside it. It is for the original 0.25.0 cutover. Do not rerun it after a verified receipt.

The release lane and apply watcher both exited successfully. Status run `20261110025043` is `ok` at severity 0. The temporary endpoint is gone, and the original v4 backup has mode `0600`. Keep the v5 app paired with the v5 data. The release lane guards against rolling back to a reader that cannot open the v5 store.

Work paused after this verified release. There are no pending PlanMind device installs or background release jobs. SPACE was unmounted. The original checkout and Windows branch remain available for the separate MindSuite import. Before removing the checkout, confirm the monorepo contains the final PlanMind `main` and tag and retains `deploy.conf`, `.local/staging-login.txt`, `.local/staging-users.json`, and the local handoff evidence privately. For the next authorized standalone release, `sh tools/dtp.sh` runs the gates, deploys, tags, pushes and builds the native apps. Use the `external-drives` skill for SPACE and run one heavy build at a time.

The production calendar selection remains in the protected PlanMind data directory at `calmind-both-calendar.json`.

## Open design decisions

- #135 asks for approval to add drag-to-reorder for priorities and to-dos.
- #138 and #171 are decided (the owner, 2026-11-09): the linked-priority cap stays 18, the Both color is per person, and all-day CalMind events are a strip above the timeline. They wait for a release.

## Phone schedule choices in the menu (2026-11-10, branch fix/planmind-day-menu)

- AM/PM and CalMind moved from a row under the date into the hamburger menu (phone), a corner AM/PM mark on the lane names, and Back keeps the hamburger beside it. Spec 9.3a, UX-NOTES.
- In 0.27.0: the branch also holds the per-person Both color (#138), the all-day strip (#171) and serialized Both-color saves. A CalMind card under one of the owner's own entries ("Jose" under "Work") is correct and stays; the overlap placement is not to be changed. Added 2026-11-10: `prefs_locked` serializes `setBothColor` and `setCalmind` read-modify-writes of the account prefs file, with a parallel-process server test; a desktop grid test pinned to origin/main's boxes.
- Verified 2026-11-10 (before the release lane): `npm test` (typecheck, check:limits, vitest 551, server 18 case files, atomic, staging, test:deploy 840 checks), the Chromium desktop and phone e2e projects, and WebKit (58 passed, 9 skipped). The full Chromium run found four stale phone specs, now fixed: they still looked for the removed `.day-schedtools` row (`calmind-allday-phone`, `entry-look`), a drawer still sliding away over the hamburger (`day-phone-half`), and a finger roll of 0.7 of a quarter (8.2px at the phone's new 11.75px quarter) beyond the 8px rest rule (`drag-lift-phone`, now 0.6). No product code changed for them. The prefs-lock test fails without the lock (verified by removing it). Still for the release lane: `test:deploy:mutations`, then the bump to 0.27.0.
