# From the interim page to this app

TaskMind began as `seancheren.com/taskmind/`, a plain-PHP page inside seancheren-site (its `docs/TASKMIND.md`, `docs/TASKMIND-TEAM.md`, `docs/TASKMIND-UI.md`, `lib/taskmind*.php`, `lib/taskmind-ui/`). It keeps running there, untouched, until this app replaces it. This repo is the graduation: PlanMind's architecture (a vite + TypeScript web app with its behavior in `packages/core`, a PHP server in `server/lib`, thin Tauri shells that open the same HTTPS app) for a team task app.

## What the scaffold (0.1.0) holds

| Piece | Where | Ported from |
| --- | --- | --- |
| The contract: roles, the permission matrix, statuses, priorities, kinds, health, visibilities, record shapes (task, project, member, comment, source, section, update), caps, error codes | `packages/core/src/model.ts` | `lib/taskmind.php` `TM_*`, `docs/TASKMIND.md`, `docs/TASKMIND-TEAM.md` |
| Who may do what: `roleCan`, `sees` (private projects), `can` (member and ownership rules) | `packages/core/src/access.ts` | `tm_can()`, `tm_sees()`, `TM_MATRIX` |
| The team and its gate: seed team (the owner owner, the partner admin; `taskmind_owners` in the site config), member cleaning, the fail-closed gate | `server/lib/taskmind.php` (`team_member`) | `tm_seed_*`, `tm_clean_members()`, `taskmind_may()`, `tm_gate_ids()` |
| The encrypted workspace store, its plaintext version marker and one-time backup on a version bump | `server/lib/store.php` | PlanMind's `Store` (the interim page keeps `taskmind-shared.json` with the site's `store_write()`) |
| Session reply, sign-in page, login rate limit, test-instance staging accounts | `server/public/TaskMind/`, `server/lib/` | PlanMind's entrypoints and bootstrap |
| A shell that signs in, shows who and which role, and closes at once when the session or the membership ends | `app/` | new (the interim page's interface is not ported yet) |

`server/lib/limits.php` is generated from `model.ts`; the interim page's `TM_MATRIX` and caps exist once now, in `model.ts`.

## Workspace domain

`server/lib/operations.php` ports the core project, task, subtask, comment and membership operations to the encrypted store. `server/lib/workspace.php` owns authorization, revisions, activity, events and filtered reads. The original version-1 team-only file opens as an empty domain without a write. Each committed edit rechecks the team and permissions under the store lock.

- `GET api.php` returns the existing session. `GET api.php?view=workspace` returns `{ok, state}`. Add `&since=<rev>` for `{ok, delta}`. Membership and project access changes return a replacement snapshot when the old revision can no longer be merged safely.
- `POST api.php` takes JSON and `X-CSRF-Token`. `WorkspaceMutation` in `packages/core/src/model.ts` names the operations and fields. An edit carries the record's `rv`. Adds and comments carry a unique `requestId` and the workspace `base` revision read before the attempt. Keep those values and the same data if reconciling an add manually. The bounded receipt log refuses requests older than its replay floor.
- A successful write returns `{ok, id, state}`, or `{ok, id, delta}` when the caller sends `since`. A member removing themselves receives `{ok, id, closed: true}`. The client makes one request per write and treats a transport failure as unconfirmed.
- `applyDelta` merges changes into the caller's in-memory snapshot. It requires the same member and base revision. A full replacement drops records that member can no longer access. Activity and events about a moved task require access to its original project and its current project.

## What is not here yet, in the order it is needed

1. **The interface**: Home, My tasks, All tasks, the project page (Overview, List, Board), the task drawer, the picker and sheets for a phone. `docs/TASKMIND-UI.md` of the interim page is the standard it must meet; the four themes come from the canon `theme.ts` already.
2. **GitHub sync** (the ticket mirror and pull requests): the interim page mirrors the owner's ticket board; how that works from this app's host is a decision for the owner, not made here.
3. **Moving the data**: a one-way import of `taskmind-shared.json` and the per-person files into the new store, tested against a copy; and the cutover of `seancheren.com/taskmind/` to this app. Neither is started, and neither is allowed to touch live data without the owner's explicit scope.
4. **Ten planned features** of `docs/TASKMIND-TEAM.md` section 4 (calendar and timeline, dependencies, workload, recurring tasks, status updates, rules, mentions and inbox, sections, search and bulk edit, templates), on whatever extension points the data layer settles on.

## Decisions carried over, not to be relitigated

- Membership is the workspace's `members`, read on every request. A site account is not a member; the sign-in page and every endpoint check both.
- A hidden button is not authorization. The server answers the same matrix as the page.
- Dates are calendar dates; "today" is the viewer's date; recurrence math is server-side with the configured timezone.
- A write is never replayed by the client; an unconfirmed outcome is reported as unconfirmed.
