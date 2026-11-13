# PlanMind implementation spec

Status: final design for implementation, 2026-10-30. Source of truth for the typed contract is `packages/core/src/model.ts` (compiles under `npm run typecheck`). This spec and that file change together, through the lead only.

Inputs: `docs/ux/UX-NOTES.md`, the approved wireframes (`wireframes-day-week-month.html`, `wireframes-both-lanes.html`), the unapproved `wireframes-interactions-DRAFT.html`, `HANDOFF.md` requirement 6, `AGENTS.md`, and the current code. Two independent designs were reviewed against these. Section 1 says what was taken from each and what was corrected.

## 1. Foundation and corrections

**Foundation: the incremental design.** Keep the single encrypted `tasks.enc`, the one file lock, the global `revision`, per-record `revision`, add-id idempotency, the thin `api.php`, one `mutate()` dispatcher, and full-snapshot GET and POST. A linked "Both" item is ONE record with two owners. Both is a pure view.

Reasons: the AGENTS rules (one store, lock, revisions, add ids) already hold in that shape; `test.php`, `api.php` and `deploy.sh` keep working; and for two people with no data yet, windowed reads and delta responses (the normalized design) add a second client-side merge engine for no present benefit.

**Grafted from the normalized design**
- `ak` creation fingerprint on every record, so an add retry stays safe even after the item was edited.
- Integer `pos` with gap 1024 and renumber, instead of floats.
- Server-side data caps derived from lane width (18 per priority line; a schedule entry has the server's 500 only, since 2026-11-01).
- Picker rule "unchecking the sole custom base falls back to Both"; month cell model with up to 3 colors; one segmented lane switch for phone text areas; drafts kept in memory per note key.
- Structural validation of every record on read (fail closed on any violation), lists and settings seeded in the store, `?since=` unchanged poll, a `cap` name in limit errors, and a generated `limits.php` drift check.

**Corrected in either design**
1. *Deploy.* The normalized design says `tools/deploy.sh` must learn new lib file names. It does not: the audit allows any flat `dist/protected/lib/*.php`, and `EXPECT_PHP` is counted from `dist` (`deploy.sh` line 350). Only three files are required by name (`bootstrap.php`, `planner.php`, `atomic.php`). New PHP files must stay flat in `server/lib`. Nobody edits `tools/deploy.sh`.
2. *Day to-do cap.* Both designs counted the cap per list including done rows, or left Both view overflowing. Final: the cap counts OPEN day to-dos per list; done rows stay in the To-do list, crossed out and stacked at the bottom of it (never hidden, never behind a button or a heading); a view with more than `dayTodosPerList` open rows shows "+N more" opening a scrollable sheet. The Day phone To-do tab never scrolls.
3. *Text caps.* The incremental design accepted 36 characters anywhere and clipped in lanes, which breaks "displays properly". Final caps are data-level: 18 for a priority line (a lane can be a half lane); a schedule entry was 18 in a lane and 36 linked until 2026-11-01, when the owner asked to "remove text limitation on schedule and let text span the entire size of the block and add an ellipse if too long": `dayEventText` and `dayEventTextLinked` are both 500 (the server's bound, the field's maxlength) and the block shows as many lines as it holds (9.1). A linked priority is 18 because it splits into two half cells when its lines differ.
4. *Picker.* The incremental design disabled the base row's box. Final: the box on a custom base is live and unchecking it lands on Both (CalMind's "lands on All").
5. *Idempotency order.* The retry check runs before cap, slot and overlap checks, so a retry never fails against its own earlier write.
6. *Edit handles.* The owner's 2026-10-30 note (handles at the start and end of an event while its text is edited) is MUST. The incremental design deferred it behind unapproved drag. Final: handles ship with the Day panel, with Alt+Arrow (move) and Alt+Shift+Arrow (resize the end) as the keyboard and accessibility path; a start/length control pair was built first and removed on 2026-10-31.
7. *Both is never stored as a list.* A custom id must match the UUID pattern, so it can never equal `both`; `sam`, `alex`, `both` are reserved names.
8. *Missing record on a lost response.* Edit, complete, move and delete retries get `stale` or `gone`; the client refreshes and shows the real state (documented in 5.4).

## 2. Scope

### MUST
- Approved wireframes: desktop Day, Week, Month with sidebar; phone top bar (hamburger, ‹ date ›, round list picker; Back to month replaces the hamburger on a Day opened from the Month, 9.4); date selector sheets (calendar on Day, Monday-to-Sunday list on Week, month grid on Month); phone bottom tabs (`PHONE_TABS`); Day phone tabs fit one screen with live counters.
- Both as a VIEW over the partner and owner lists; permanent partner and owner lists; custom named lists; picker with row-tap (alone) and box-tick (overlay); Both never includes a custom list implicitly.
- Lanes: signed-in person on the left; matching by priority line and by time; linked Both items (one record) spanning both lanes, or two half cells when priority lines differ; to-do stays one list with a colored circle.
- Colors: partner yellow, owner green, Both purple by default; per-list color settings; readable tints in all four themes (AA contrast test).
- Per-person priority order (5 typed lines per list per day).
- Schedule entries with start (15-minute grid) and length (default half an hour, minimum 30) inside a planner day (7:00 to 7:00 the next morning, D16), no overlap in a lane; the schedule has two pages, AM and PM (9.3).
- Edit-mode start and end handles on a schedule entry (the owner, 2026-10-30), saved with the text in one write; keyboard path through Alt+Arrow (move) and Alt+Shift+Arrow (resize); no start or length control (the owner, 2026-10-31).
- Week and Month text and notes per list; week and month to-do scopes.
- Phone caps for Day (constants in `CAPS`), enforced by the server.
- Fail-closed storage, revisions, locking, idempotent adds, per-request authorization, no browser storage of private data.

### SHOULD (unapproved draft interactions; build after MUST, behind the interactions module)
- Desktop drag of schedule blocks (vertical, 15-minute snap, nearest free quarter-hour), drag to reorder priorities and to-dos (editing in place is built: one click, spec 9.1).
- Press-and-hold then drag on phone (about 0.4 s).
- Alt+Up and Alt+Down keyboard moves (15 minutes or one line).
- Built 2026-10-31 at the owner's request ("dragging is very awkward and/or broken"): dragging a schedule entry (mouse, pen, touch after a 0.4 s hold), its Escape and cancel rules, the stale-drop snap back, and Alt+Up and Alt+Down for schedule entries (section 9). Not built: reordering priorities and to-dos by drag.
- `GET ?since=` unchanged poll.

SHOULD items call only existing operations (`edit`, `movePriorities`, `moveTodo`), so no server work remains for them.

### Out of scope
Windowed reads, delta responses, list reordering, list sharing rules beyond alex+sam, native changes (another agent works under `native/`), data migration, deploy tooling changes.

## 3. Decisions

| # | Decision |
| --- | --- |
| D1 | `owners: ListId[]` replaces `person`. One list, or exactly `['alex','sam']` (linked). Nothing else is valid. |
| D2 | A linked item is one record. One `done`, one revision, one delete. Per-owner state exists only for priority lines (`slots`). |
| D3 | Item kinds: `todo` (day, week, month), `priority` (day), `event` (day). Week and month priorities are note text. |
| D4 | Lists: partner and owner seeded, permanent, name fixed, color editable. Custom lists: UUID id, name 1 to 24 code points, unique case-insensitively, not `sam/alex/both/all`, at most 12. |
| D5 | Both color: `settings.bothColor` (default purple) is the household DEFAULT; each person may pick their own (decided 2026-11-09, #138), kept as an account preference (see 4.1a), never in the store. Colors are palette keys, never CSS. |
| D6 | Selection `{base, overlays}` is a per-user preference stored in the encrypted store, applied at load only. |
| D7 | Overlays: custom lists only, at most 2, never the base. Lanes therefore number at most 4. |
| D8 | Text for week and month (priorities, notes) and day notes belong to one list; each lane shows its own; either signed-in person may edit any lane. |
| D9 | To-dos have one order per (scope, date) across all lists, as the approved "one list, colored circle per owner". |
| D10 | Events never overlap within a lane; a linked event must be free in both lanes. Touching (end equals next start) is fine. |
| D11 | Storage `v: 2`. A v1 file (PlanMind 0.1.0) with records is converted in memory on read and replaced by the first successful write, after its bytes are kept once as `tasks.v1.enc.bak`; nothing is truncated or dropped. A v1 file that does not decrypt or is not what 0.1.0 wrote fails closed with 503 and is never rewritten. (Amended after 0.1.0 went live.) |
| D12 | Idempotent add via client UUID plus `ak`. Moves, edits, completes, deletes use record revisions only. |
| D13 | `kind` is required on `add` and `edit`; scope and kind are immutable after create. |
| D14 | The server accepts an `edit` with new `owners`, in any direction, with all checks re-run. The UI sends one only when a schedule entry is dragged (or moved with Alt+Left / Alt+Right) across the thirds of the Both view: an edit otherwise keeps the item's owners, and to give any other item to someone else it is added again under their list (7.5). |
| D15 | Client keeps drafts in memory; failed reads never replace state; responses older than local `revision` are ignored. |
| D16 | A planner day runs 7:00 to 7:00 the next morning (the owner, 2026-10-31). `start` is minutes since midnight of the entry's `date` and may pass 1440 (2a is 1560, on the evening's date); nothing is copied onto the next date. `eventEndMin` is 1860. |

## 4. Data model

All shapes are in `model.ts`; this section states the rules.

### 4.1a The Both color is per person (#138, the owner 2026-11-09)

Storage: a key `planmindBothColor` (a palette key) in the account library's prefs file `prefs-<user>.json` beside the theme and `planmindCalmind`; the store is untouched, so it stays **v5** with no migration, nothing to roll back and an older release still opens it (a field added to `prefs[user]` in the store would be refused by an older reader, and a version bump was not needed). `GET api.php` carries it as `bothColor` (a palette key or `null`); `POST {action:'setBothColor', bothColor}` (`op_set_both_color`) validates it against the palette (400 `invalid`), accepts `null` to clear it, and claims it saved only when it reads back (503 `unavailable` otherwise), like `setTheme`. `settings.bothColor` and `saveSettings` stay as the household default and are no longer written by the app. The client: `state.settings` is the household settings with `bothColor` replaced by the person's pick (core `personalSettings`; the context's `settings`, `input.data` and `choreInput.data` all read it), `state.saveBothColor` shows a pick at once and puts the stored color back when the save fails, and a full poll answer brings a pick made on another device. Linked-priority text stays 18 (decided). The pick, like `setCalmind`, is a read-modify-write of the account's one prefs file, so both run under `prefs_locked` (a lock file `prefs-<user>.json.lock` beside it): two simultaneous requests of one account never lose each other's key (`server/tools/cases/theme.php` section 5: eight processes, four picks and four other keys, and the owner's and the partner's picks at once). `setTheme` (the site library's `theme_set`) is not under that lock; it lives in seancheren-site.

### 4.1b CalMind all-day strip (#171, the owner 2026-11-09)

`GET api.php?calmind=1&from=&to=` answers `{events, allDay}`: `events` are the timed pieces as before, `allDay` the all-day days (`{id, owner, date, text, color, both?}`, `calmind_allday_pieces`), with the timed pieces' visibility (the viewer's own whole, the other person's only what they share, the designated Both calendar flagged). An event is all-day when its `time` is not a valid HH:MM. **Planner-day rule:** planner day D runs D 7:00 to D+1 7:00, so an all-day date D is on planner day D; one with a later `endDate` is on each day D through `endDate` inclusive (CalMind's rule, capped at 60 days); a repeat gives each occurrence its own days. An older server sends no `allDay` and the client draws none. Client: `state.calmindAllDay` (empty while CalMind is hidden); core `alldayCells(items, date, lanes)` places each item with the same lane split as `calmindCells` (`splitLanes`) and `alldayStrip(cells, laneCount, rows = ALLDAY_ROWS = 2)` lays them out: chips across both lanes take the first row and never the last while a lane has chips of its own; a lane that cannot show everything shows one fewer chip and a `+N` chip in its last free row; a lane left with no free row gives its last crossing chip to the `+N`. `ScheduleSection.alldayHtml` draws `.day-allday` (a gutter label "all day" and a grid on the lanes' columns, `data-row`, `data-lane`, `data-span` for the place, no inline style) between `kit.laneHead` and `.day-timeline`, so the grid's `spanBox` positions are untouched; nothing is drawn when there are no chips. The chips take the timed cards' colors by sharing their CSS rule (`.day-cal-in,.day-ad-in`).

### 4.1 Lists and settings
- `sam` (order 0, yellow) and `alex` (order 1, green) are written into `lists` the first time anything is written, revision 1. Until the first write a missing file reads as the same defaults without writing.
- `saveList` on a person list changes `color` only (`name` absent or equal to the fixed name). `deleteList` on `sam`, `alex`, `both` is 400.
- Custom list create: `revision: 0`, `name` required, `ak` stored. `order` is max+1. Color defaults to `nextCustomColor` in the UI; the server accepts any palette key.
- `settings` seeded `{bothColor:'purple', revision:1}`.
- `deleteList` removes in one write: every task, priority and event whose sole owner is the list; every note of that list; the id from every user's `prefs`. Linked items are untouched (custom lists cannot be linked). The global revision bumps once.

### 4.2 Items
Common: `id` (`/^[a-f0-9-]{36}$/D`), `revision` (starts 1), `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `ak`.
- Task: `scope`, `date` (day: the date; week: the Monday; month: the first), `owners`, `title`, `done`, `pos`.
- Priority: `date`, `owners`, `slots` (keys equal owners, values 1 to 5), `text`. For each (date, owner) a slot is held by at most one priority.
- Event: `date`, `owners`, `text`, `start`, `length`.
- `ak` = first 16 hex of sha256 of the canonical creation fields (kind, sorted owners, scope/date, text, start/length/slots), computed by PHP only.
- Id namespace is shared across the three maps. Total items at most `itemsMax`.

### 4.3 Notes
Key `scope:period:listId:field`. Allowed pairs from `NOTE_FIELDS`: day/notes, week/priorities, month/priorities, month/notes. Period rules: week = a Monday, month = the first, day = any valid date 2000 to 2099. Limits: day notes `dayNotesChars` code points; week and month `docChars`. Newlines normalised to `\n`; tab and newline are the only control characters. Notes at most `notesMax`.

### 4.4 Prefs
`prefs[user] = {selection}` or `{selection, sidebar: 'hidden'}`. Written by `savePrefs` only for the caller; `sidebar` (whether the desktop sidebar is shown) is stored only when hidden, any other word reads as shown, and a save that leaves it out keeps what is stored. The page sends `sidebar` only in the save that follows its own sidebar change (and again after a failed one), never with a picker change alone, so a device that has not touched the sidebar cannot put its old value over another device's choice; the value is read at load, and a poll does not adopt another device's choice. The server sanitises: unknown base becomes `both`; overlays must be existing custom lists, unique, not the base, at most `maxOverlays` (silently dropped otherwise). It does not bump the global revision; the file is rewritten only if the sanitised value changed.

### 4.5 Per list versus shared

| Per list | Shared |
| --- | --- |
| notes (every field), priority line (`slots[list]`), list name and color, lane membership | linked item content, `done`, event start and length, to-do order, `bothColor`, lock, global revision |
| per user, not per list: the picker selection | |

## 5. Store, snapshot, revisions

### 5.1 Plaintext shape (inside `tasks.enc`, same `PM1:` prefix, AAD `PlanMind:tasks`, key handling and `atomic_write` unchanged)
```json
{"v":2,"revision":41,
 "lists":{"sam":{"id":"sam","kind":"person","name":"Sam","color":"yellow","order":0,"revision":1,"updatedAt":"..."},
          "alex":{...},"<uuid>":{...,"kind":"custom","ak":"..."}},
 "settings":{"bothColor":"purple","revision":1,"updatedAt":"..."},
 "tasks":{"<id>":{...}},"priorities":{...},"events":{...},"notes":{"week:2026-10-26:alex:priorities":{...}},
 "prefs":{"alex":{"selection":{"base":"both","overlays":[]}}}}
```
`Store::transaction` adds one check: when the encoded plaintext exceeds `storeBytesMax`, throw `RequestError('The planner is full.', 409, 'store_full')` before writing.

### 5.2 Snapshot and validation (`snapshot($db, $user)`)
- `[]` (no file): a fresh current-version db (not written by a read).
- `v` missing or 1 (the 0.1.0 store): if `tasks` or `notes` holds any record, convert it in memory (`planner_migrate.php`): `person` both/sam/alex becomes `owners` (both is one linked record), scope and date carry over, `pos` keeps the v1 order (id order inside each scope and date, `posGap` apart), the one shared note of a period becomes the same text in the notes of BOTH sam and alex (week text is the `priorities` field, month text the `notes` field), revisions and the global revision carry over, over-cap titles and notes are kept untouched. Anything not exactly what 0.1.0 wrote throws (503). If both collections are empty, treat as fresh and keep the revision. A read never rewrites the file; the first successful write stores the current version, after saving the v1 bytes once as `tasks.v1.enc.bak` (never overwritten; a different existing backup refuses the write).
- `v` 2 (0.12.0 and before) and `v` 3 (0.13.0) convert in memory too (`MigrateV2` seeds the chore chart, `MigrateV3` only changes the version: v4 adds the optional `Task.doneOn`, 9.2); the first write stores the current version. Every bump keeps the old file once: the first write that stores a newer version first saves the old bytes as `tasks.v<old>.enc.bak` (never overwritten; a different existing backup refuses the write), and each write of `tasks.enc` leaves `tasks.version` (the number and a newline, mode 0640, written before the file so it is never below it) for `tools/deploy.sh`'s rollback check.
- `v` 4 converts to v5 by expanding appointments under 30 minutes. Later appointments on the same day move forward only to clear earlier events in their lanes. Both uses the later available time of its two lanes. IDs, text, ownership and longer durations carry over. A day that cannot fit refuses conversion before writing.
- `v` other than the current version after conversion, or any collection not an array: throw.
- Structural check on every read, O(n), fail closed on the first violation (no repair, no skipping): each record has the right fields and types; `owners` is canonical and each owner is a list in `lists`; `slots` keys equal owners with values 1 to 5; event `start`/`length` on the 15-minute grid and inside the window, with at least 30 minutes of duration; task `date` aligned to `scope`; note key equals its fields and its list exists; `sam` and `alex` present as person lists; custom names unique; counts under limits. Uniqueness of slots and overlaps are enforced at write time and not re-checked on read.
- Output: collections via `array_values` in a stable order (lists: sam, alex, custom by order), only the caller's `prefs` (default selection if none), never a raw map. PHP encodes an empty array as `[]`; every outward map becomes a list and `slots` is never empty, so no object/array trap reaches the client.

### 5.3 Revision rules
- Global `revision` +1 for each state-changing write; batch ops (`movePriorities`, `deleteList`) bump once. Equal-content writes (idempotent retry, same-text note) return the db unchanged, so nothing is rewritten.
- Record `revision`: create sets 1; each edit, complete, move, note save, list or settings save sets previous+1. Notes and custom-list create send `revision: 0`.
- Server-derived fields (`pos` of neighbours during a renumber) do not bump neighbours' revisions.
- Mismatch is `stale` 409; a removed record is `gone` 409.

### 5.4 Add-id idempotency and lost responses
- `add` and custom `saveList` create with an existing id: if `createdBy` is the caller and the stored `ak` equals the recomputed one, return the db unchanged (success, no write); otherwise `id_in_use`. This check runs before cap, slot and overlap checks.
- Known gap: no tombstones; a retry after the other person deleted the fresh item recreates it.
- Edit, complete, move and delete retried after a lost response get `stale` or `gone`. The client refreshes and shows the true state; the error text for these says "Refresh to see the latest" as today. Exception: `movePriorities` and `moveTodo` return success unchanged when every record is already at the target.
- A note save whose text equals the stored text succeeds as a no-op even when the revision moved.

### 5.5 Concurrency
Every write is one `Store::transaction('tasks', ...)` under `with_file_lock`; the read, validation, mutation and atomic write happen under that lock. `savePrefs` uses the same lock (a rare, small write).

## 6. API

One endpoint. GET returns the snapshot for the caller; POST takes one mutation and returns the full caller snapshot. Auth (`pm_user()`), CSRF, Content-Type, 64 KB limit, JSON depth 32 are unchanged. `api.php` edits: pass `$user` to `snapshot()` (two sites), add `code` (and `cap`) to the RequestError JSON, support `?since=`. Every request re-authorizes `alex` or `sam`, including `savePrefs`.

Session fields on GET: `user`, `csrf`, `theme`, `timezone`, plus the snapshot. `GET ?since=N`: if the stored `revision` equals N, return `{unchanged:true, revision:N}` (SHOULD).

Error body `{ "error": "<human text>", "code": "<ApiErrorCode>", "cap"?: "<CapName>" }`. Status per code is `ERROR_STATUS` in `model.ts`. `RequestError` gains optional `code` and `cap` constructor arguments (properties `status`, `errorCode`, `cap`, and `body()` for the JSON, because PHP reserves `$e->code`); `code` defaults from the status (400 invalid, 401 unauthorized, 403 forbidden, 409 stale, 413, 415, 429, 405). Non-RequestError throwables stay 503 `unavailable` with a generic message.

### 6.1 Operations (shapes in `model.ts` `Mutation`)

**add** `kind` required. The day cap on today's date counts the carried-over open to-dos too (9.2).
- todo: `{scope,date,owners,title}`. `pos` = max+posGap in (scope,date). Day scope: open to-dos of every owner list must be below `dayTodosPerList` (`limit`, cap `dayTodosPerList`); week/month: all rows below `periodTodosPerList`.
- priority: `{date,owners,slots,text}`; slot taken for any owner is `slot_taken`.
- event: `{date,owners,text,start,length?}`; length defaults to 30 (half an hour); overlap in any owner lane is `overlap`.

**edit** (full replace of the editable fields; `scope`, `done`, `pos`, `createdBy`, `ak` preserved). Checks re-run excluding the record itself. A cap only blocks an edit that adds the record to a list or day where it was not counted.

**complete** todos only. `done:false` on a day to-do re-runs the open cap for its owners (`limit`).

**delete** any item, `confirm:true` required.

**moveTodo** `before` is a to-do id or null. Placed among ALL to-dos of the same (scope,date), regardless of the viewer's filter. New `pos` = floor midpoint of predecessor and target (predecessor 0 if none, end = last+posGap). If the gap is under 2, renumber the bucket to multiples of posGap in the new order first (no neighbour revision bumps). Target in another bucket: 400. Missing target: `gone`. Already in place: no-op.

**movePriorities** up to 5 moves for one (date, listId), all or nothing. Each record must include `listId` among its owners and carry its current revision; only `slots[listId]` changes. Final slots in (date, listId) must be unique and within 1 to 5. Any stale revision rejects the whole batch. The text cap is not re-checked (priority caps do not depend on lines).

**saveNote**, **saveList**, **deleteList**, **saveSettings**, **savePrefs** as in 4.1 to 4.4. Unknown list on a note is `gone`.

**saveChore**, **deleteChore**, **markChore**, **saveRhythm** (chores, 9.9; `planner_chores.php`, revision-checked like the list operations).

**setTheme** `{theme}` is not a planner operation and never opens the store. It is the account's own color theme, written by the site library's `theme_set()` (the prefs file CalMind and the suite read; `theme_get()` is what GET already returns as `theme`). `api.php` authenticates and checks CSRF as for every write; `op_set_theme()` (`server/lib/theme.php`) authorizes `alex` or `sam` again, takes only a key of the site's `THEMES` (anything else is 400 `invalid`), and answers `{theme}` only when the theme reads back as stored (`theme_set()` cannot be trusted to say whether the write happened; a failure is 503 `unavailable` and the client puts the theme back). Case file: `server/tools/cases/theme.php` (the real site library in a disposable copy shaped like the test instance's sandbox, plus fakes that fail).

### 6.2 Validation rules the server owns
- Dates `^20\d\d-\d\d-\d\d$` and a real calendar date. Week scope: Monday. Month scope: first.
- Events: `start % 15 = 0`, `start >= 420`, `length % 15 = 0`, `length >= 30`, `start + length <= 1860` (7:00 the next morning, D16).
- Text: valid UTF-8, trimmed, 1 to limit code points, no control characters on single-line fields (`text_too_long` when only the length fails).
- Text limit for an item: event 500 (linked or not); priority 18; day to-do 36; week/month to-do 500.
- Owners: canonical, existing lists, shape per D1. Unknown or just-deleted list: `gone`. Bad shape: `invalid`.
- Names (lists): trimmed, 1 to 24 code points, unique case-insensitively among all lists and reserved words (`name_taken`).

### 6.3 JSON examples
```
POST {"action":"add","kind":"event","id":"6f1c2d3e-0000-4000-8000-000000000001","date":"2026-10-30",
      "owners":["alex","sam"],"text":"Lunch together","start":720}
200 {"v":2,"revision":42,"lists":[...],"settings":{...},"tasks":[],"priorities":[],
     "events":[{"id":"6f1c...","date":"2026-10-30","owners":["alex","sam"],"text":"Lunch together",
                "start":720,"length":30,"revision":1,...}],"notes":[],"prefs":{"selection":{"base":"both","overlays":[]}}}
409 {"error":"That time is already taken in this list.","code":"overlap"}

POST {"action":"add","kind":"priority","id":"...","date":"2026-10-30","owners":["alex","sam"],
      "slots":{"sam":2,"alex":4},"text":"Family dinner"}

POST {"action":"edit","kind":"event","id":"6f1c...","revision":1,"date":"2026-10-30",
      "owners":["alex","sam"],"text":"Lunch together","start":705,"length":60}      # handle drag, one write

POST {"action":"movePriorities","date":"2026-10-30","listId":"alex",
      "moves":[{"id":"a...","revision":2,"slot":3},{"id":"b...","revision":1,"slot":2}]}

POST {"action":"saveNote","scope":"week","period":"2026-10-26","listId":"sam","field":"priorities",
      "text":"Renew passport","revision":0}

POST {"action":"saveList","id":"<new uuid>","name":"Camping","color":"blue","revision":0}
POST {"action":"savePrefs","selection":{"base":"both","overlays":["<camping uuid>"]}}
409 {"error":"A list with that name already exists.","code":"name_taken"}
409 {"error":"the owner already has 13 things to do that day.","code":"limit","cap":"dayTodosPerList"}
```

## 7. View selection, lanes, colors

### 7.1 Selection
- `selectOnly(id)`: tap a row; base = that row, overlays cleared; the menu closes.
- `toggleOverlay(sel, id, lists)`: only custom rows have a box. Not visible: add to overlays (works over Both, the partner, the owner or a custom base); at `maxOverlays` return the same selection and `rejected:'overlay_limit'` (UI hint "Up to 2 extra lists"). Visible as an overlay: remove. It is the base: base becomes `both`, overlays kept.
- The partner, the owner and Both rows have no boxes, so Both never gains a custom list implicitly.
- `resolveSelection` runs on every snapshot, so a list deleted elsewhere heals the view without breaking a request.
- Persistence: `savePrefs`, debounced 400 ms, best effort and silent on failure (the in-memory selection still applies). No `localStorage`, `sessionStorage`, IndexedDB or cache holds anything private; an e2e test asserts all four are empty after use.
- Picker UI: round button beside the account (`pickerColors`: one color, or a pie when overlays are on, as CalMind's PieDot; under Both it is the single Both color, not an the partner + the owner pie); menu rows Both, the partner, the owner, divider, custom lists by order, "Manage lists…". Manage dialog: add (name, swatch tray), rename and recolor custom, recolor the partner and the owner, set Both color, delete with two presses and the item count.

### 7.2 Lanes (`resolveLanes`)
- `both` gives `[me, other]`; any other base gives `[base]`; overlays follow by list order. `you` marks the signed-in person.
- An item is visible when any owner is a lane.
- Linked items can have both owner lanes visible only under base `both`, where the two are adjacent at indexes 0 and 1.

### 7.3 Cell placement
- Event: a linked event with both owner lanes visible is one cell with `span 2`; otherwise one cell in the visible owner lane. Cells carry `start` and `end`.
- Priority: row = the item's line in each visible owner lane. Linked with both lanes visible and `slots.sam === slots.alex`: one `span 2` cell. Different lines: two `span 1` cells, each in its own row and lane, both in Both color ("two purple half-lane cells"). Only one owner lane visible: one cell in that lane, still Both-colored.
- To-do: no lanes. One list ordered by `pos`; open rows from the top, the blank lines, then the done rows as the last lines (the done rows stay in the list, crossed out); circle colored per item (Both color if linked).
- Each priority view has exactly 5 rows.

### 7.4 Colors
`itemColor`: two owners gives `settings.bothColor`; one owner gives that list's color. Colors are keys; `app/colors` writes CSS variables `--c-<key>-bg|fg|line` from `tint(hue, theme.surface, theme.text)` in `setTheme`, rows use `data-c="<key>"`, CSS reads the variables (no inline styles, CSP unchanged). Names always appear in lane headers and the For control. `colors.test.ts` requires `MIN_CONTRAST` for fg on bg for every theme and key.

### 7.5 Who a new item is for (no For control)
The owner, 2026-10-31: one user selector, the picker at the top. There is no For control anywhere (Day to-do add field, priority and schedule entries, Week and Month to-do add field; none of them has an editing window, 9.1). Core `newOwners(selection, lists, settings, lane?)` gives the owners and color of a NEW item: the base list, or, when the base is Both, the one linked record owned by `[sam, alex]` in the Both color. Overlays never decide. `lane` is a list the person tapped (a schedule slot, a priority cell): that list, whatever the base. Editing never calls it: an item keeps its owners, so a linked item stays linked and an edit changes both lists; its counters and text caps (36 vs 18) follow its owners. To move an item to another list, add it again under the other selection. The server still accepts an owner change (D14). Consequence: under Both a blank priority cell is a tap on one lane, so it makes a priority for that list alone, and a linked (Both) priority has no way to be made by pointer any more (the For pill was the only one; open for the owner: the smallest change is that a tap on a cell that is blank in both lanes makes the linked priority). A schedule slot is resolved for entries (section 9): in the Both view with two lanes the middle third of the schedule makes the linked entry and the outer thirds the lane's; the visually hidden Add schedule entry button gives the picker's base (linked under Both, for the keyboard and a screen reader). A to-do, by the add field, is linked under Both; a blank to-do line is cut in thirds like the schedule (9.7).

### 7.6 Week and month text follow list selection (resolves the HANDOFF question)
Each lane has its own text. Both view: two blocks, signed-in person first. Single list: one. Overlays add lanes. Both has no text of its own. Week desktop: blocks side by side. Month: the narrow side column and the phone stack colored blocks (UX-NOTES suggestion). Phone Notes with more than one lane uses a segmented lane control with one text area on screen. Drafts live in memory keyed by note key, so changing the selection never loses one; a draft shows "Unsaved". The old shared per-period note has no equivalent and is rejected by the v2 check.

## 8. Caps (named constants, `CAPS` in `model.ts`)

| Constant | Value | Meaning |
| --- | --- | --- |
| dayEventText / dayEventTextLinked | 500 / 500 | schedule entry in a lane / spanning both lanes (the server's bound; the block shows what fits and an ellipsis) |
| dayPriorityText / dayPriorityTextLinked | 18 / 18 | priority line; linked splits to half cells when lines differ (tune up only if the split case is also handled) |
| dayTodoText | 36 | day to-do title |
| dayTodosPerList | 13 | open day to-dos per list; linked counts for both (the owner set 13 on 2026-10-31; the old 6 was an example to tune) |
| dayNotesChars | 400 | day notes per list |
| periodTodoText / periodTodosPerList | 500 / 200 | week and month to-dos |
| docChars | 12000 | week and month text per list |
| prioritySlots | 5 | |
| eventStartMin / eventEndMin / eventStep / eventDefaultLength / eventMinLength | 420 / 1860 / 15 / 30 / 30 | schedule window in minutes since midnight of the entry's date: 7:00 to 7:00 the next morning (D16); AM page 7:00 to 21:00, PM page 21:00 to 7:00 |
| maxOverlays / customListsMax / listNameChars | 2 / 12 / 24 | picker |
| posGap | 1024 | to-do order spacing |
| choreTitleChars / choresMax / choreMarksMax | 36 / 60 / 20000 | a chore rule's title, rules kept, marks kept |
| itemsMax / notesMax / storeBytesMax / requestBytesMax | 20000 / 20000 / 8000000 / 65536 | store |

Numbers come from the wireframe examples and are tuning constants. Characters are code points: `[...s].length` in TS, `mb_strlen` in PHP; a test pins an emoji and a combining mark. `server/lib/limits.php` is generated from `CAPS` by `node tools/gen-limits.mjs` (Node 24 imports `model.ts` directly); `npm run check:limits` fails on any diff and runs in `npm test`. Do not hand-edit `limits.php`.

Phone fit rules (UI, tested):
- Day Schedule, To-do and Notes fit inside the phone shell. The Schedule timeline fits beneath its AM/PM controls and lane names. A quarter hour keeps at least 8px, so short screens can scroll the timeline if needed. Cards have a 1px visual inset per side and use 13px titles and 11px start times where there is room. Appointments are at least half an hour. A 15-minute fragment at the AM/PM boundary keeps its caption and exposed duration edge as targets on the same entry. A held touch can pan a scrolling timeline during a drag.
- Day To-do tab: five priority lines, then the 13 ruled slots (9.2) with the done rows crossed out as the last lines of the same list (under the blank lines), then a "+N more" row where needed. At 375x812 all 13 rows fit with rows of about 32px; on smaller phones the rows shrink to a floor of 30px (a priority line 28px), and under that (a phone under about 700px high, or with open and done rows beyond the 13 lines) only the list scrolls inside the tab (it is positioned, so the screen-reader-only owner names of the rows scrolled away do not make the panel scroll). Sheets scroll.
- Week and Month tabs scroll freely and have no caps beyond the data limits; their To-do is ruled lines of the Day's kind (9.5). The Day's Chores page (9.9) fits like the others: rows 34px shrinking to 30px, then only its list scrolls.
- Live counters (`14 / 18`, `2 of 13`) use `counter` and `todoCounter`; over the limit disables Save and shows the message.

Desktop fit rules (UI, `desktop-fit.spec.ts`): from 761px the Day panel fills the window and the schedule timeline can scroll without moving the panel. The panel itself scrolls when the window is shorter than the content's minimum.
- Day: the two columns share the height. The timeline takes what its column has left and preserves the minimum 8px quarter hour. Desktop Notes starts with a 52px writing area and grows to 124px before scrolling within the field, so longer notes leave room for the timeline. The count and the state share a line and Save drops under them when a box is narrow (three or four lanes). In a tall window the right column's rows grow (a to-do row to 44px, a priority line to 54px) so the columns end together.
- Week fits at 1360x900 and 1440x900 with up to four lists. Month fits with up to seven month to-dos; with more, the side column (Priorities and To-do) scrolls inside itself while the calendar stays put, and the weekday row keeps its own height. Month with three or four lists makes the Notes row taller than the window leaves (about 40px) and the panel scrolls; that is the content's minimum, not redesigned here.

## 9. Schedule, priorities and ordering

- Time labels `7a` to `6a` (`SCHEDULE_ROWS`, 24 rows); an entry occupies `[start, start+length)` in minutes since midnight of its date, inside the planner day (7:00 to 7:00 the next morning, `CAPS.eventEndMin` 1860, D16). The grid shows two pages behind the AM/PM switch, on a desktop and a phone (9.3): AM the 14 hourly rows 7a to 8p, PM the ten rows 9p to 6a at the same row height; entries render by start and length (30 minutes is half a row).
- Overlap: per lane, half-open. Adding, editing, handle resize and (SHOULD) drag all go through `findEventOverlap` in the UI for instant feedback and through the server for the decision.
- **Placing a new entry.** A tap targets the half hour of the hour row. Core uses the precise quarter under the pointer to determine which free stretch it is in. A new entry is 30 minutes, the default, if there is room. The closest start in that stretch can be on a quarter-hour boundary. A shorter free gap produces no preview or new entry. If the pointer is on occupied time in an intended lane, core finds the nearest free start. The hidden half of the day counts as occupied.
- **Dragging an entry** (`app/panels/day/EventDrag.ts`, core `moveEvent`, `stepEvent`). A mouse or pen: press the block and move more than 4 px; a click that does not move edits the entry where it is. A finger: press and hold 0.4 s without moving more than 8 px (more is a scroll), then drag; the page does not scroll while it drags. The block follows the pointer in 15-minute steps and lands on the nearest free quarter hour inside its own lanes (core `moveEvent`; own old place counts as free), showing "10:45a – 11:15a" in a label above the pointer. It never changes owners or lane, except in the Both view with the two people's lanes, where the third of the block's centre (carried by the pointer's sideways travel) says whom it is for (core `moveAim`, `moveEvent` with owners, `stepAim` for Alt+Left / Alt+Right). Escape, a cancelled pointer, a lost capture and the window losing focus put it back. The drop is one `edit` carrying the record's revision; a stale or refused write snaps the block back and the banner says why (as for every write). A block that is being edited is a draft: moving it changes the draft and nothing is written until Save. Alt+Up and Alt+Down on a focused entry move it one step (core `stepEvent`, which never jumps a neighbour) through the same write, with a polite live-region message. The grid's box is read on every pointer move and again on every scroll while the button is down, so a flexing or scrolling layout cannot skew the mapping or leave the label stale. A press on the block being edited keeps the focus in the editor's field (so Escape still closes it); a moved block shows its new time and spoken label at once, also while another editor is open (the page is not redrawn then); Alt+Arrow presses that come while a write is in flight wait in line (each a step from where the last landed), and a press on a block while a write is in flight says "Still saving". A drag selects no text and the editor sheet fades while it runs. Reordering priorities and to-dos is not built.
- **Edit-mode handles (MUST).** While an event's text is in edit mode, show a start handle at its top edge and an end handle at its bottom edge. Dragging uses pointer events (works with touch; `touch-action: none` on the handle). Each move calls `resizeEvent(events, event, edge, targetMinute)`: snaps to 15, clamps to the window and the 30-minute minimum, and stops at a neighbouring event in any of its lanes. A label above the pointer shows `start–end` while dragging (a cancelled drag puts the edge back). The grab area is 20px tall (44px on a touch screen), sits outside the block, and on a phone is not clipped or covered: where the place outside the block would be under the top bar (an entry at 7a) or over the tab bar (8:30p), the handle is pulled in over the block by exactly that much (`EventHandles.fit`, the `--shift` property), so it keeps its whole 44px and takes no tap from a tab. **Nothing covers a block or its handles while it is edited, and nothing hangs over the schedule** (9.1, the owner 2026-11-01): the edited block holds its time, its title field and its two handles and no strip of controls (the span, counter, Delete and notes strip of 0.7.0 and before is gone), so the handles keep their whole grab area. Enter (or the focus leaving the entry) is one `edit` carrying text, `start` and `length`. **Editing an entry is only its text (the owner, 2026-10-31):** there is no Start or Length control; the time and the length are set by dragging the block or a handle, and nothing else. Keyboard and accessibility path, in the title field: Alt+Up and Alt+Down move the draft 15 minutes (core `stepEvent`), Alt+Shift+Up and Alt+Shift+Down shorten or lengthen its end by 15 minutes (core `resizeEvent`, `ScheduleSection.lengthen`), each saying what it did or why it stopped.
- Priority reorder (SHOULD, drag) and the keyboard path (MUST, "Move up" and "Move down" buttons in the cell being edited, and Alt+Up and Alt+Down in its field) compute `arrangePriorities`: an array move over the five lines (null cells included), at most 5 records changed.
- Adding a priority as Both uses `suggestSlots`: the lowest line free for both; if none is common, each owner's own lowest free line (so the entry renders as two half cells).
- To-do reorder uses `moveTodo` with the neighbour id from the full bucket, not the filtered view.

### 9.2 The To-do slots and the carry-over (the owner, 2026-10-31)

- **Slots (R9).** The Day To-do is `CAPS.dayTodosPerList` (13) ruled lines, on a desktop and a phone, like the five priority lines. Core `todoSlots(open, done)`: the open rows fill the lines top-down (`filled`), the done rows are the last lines of the same list (`done`, 9.8), `empty` is what is left of the 13 lines between the two (0 once they are used up), `more` the open rows past the 13th ("+N more", on a desktop too; a `wentTo` row, 9.2, is not an open row: it takes a line like a done row, comes after the open rows and is never behind "+N more"). A blank line is decoration (`aria-hidden`, a faint circle); the first one is the add field (`New task`; Enter, or the Add button that shows once there is text; `n of 13` beside the label, `x / 36` while typing); a click on a blank line starts a to-do there, cut in thirds in the Both view (9.7); the add field stays the keyboard's way. There is no add row. With 13 open there is no blank line and no field, and the full message shows; when the open rows of a Both or overlay view (or the open and the done rows together) fill the 13 lines while no list is full, the field is one more line under the open rows, above the done ones. After an add the panel lets go of the field, shows the new line, and the field returns on the next blank line. Done to-dos are rows of this list (9.8): they use up blank lines, never count against the 13 open ones, and are never hidden or behind a button. (With 13 or more rows, open and done, and neither list full, the field is the one line between the last open row and the first done row: accepted, 13 is the number of ruled lines, not a second cap.)
- **Carry-over (R10).** `dayView(input, date)` with `input.today === date` lists the open day to-dos of earlier days before today's own (core `carriedTodos`, `isCarried`: oldest day first, then their own order), each row marked `carried`; nothing is written. Other dates, done, week and month to-dos, and lists outside the lanes never carry; a linked to-do is one row. `todoCounter` and `fullOwnerOnEdit` take `today` and count them, and so does the server: `mutate(db, input, user, today)` (`api.php` passes `pm_today()`, the date in the site's timezone) gives `open_count` the date for an add, a reopen and a date edit that lands on today; a to-do already carried onto today is not counted again when its day field is set to today. Any other landing day counts its own to-dos only, so time alone can leave today over 13 (nothing is refused or removed then; nothing new is added until room is made); by decision a write that lands on an earlier day (an add, a reopen or a date edit) is judged by that day alone too and can do the same (`carryover.php` pins it): today then shows "+N more". The chip reads "from Mon Oct 26"; the editor's day field holds the real date.
- **Done on a day (the owner, 2026-11-02: a carried to-do "only shows checked for the day it was accomplished, previous days show it unchanged/unchecked").** `complete` takes an optional `doneOn` when checking a day to-do: the date of the page it was ticked on, which the server accepts only as the to-do's own date or its `today` (never before the to-do's date; 400 `invalid` otherwise, and for a week or month to-do or an uncheck). It is stored as `Task.doneOn` (valid only on a done day to-do, `>= date`; absent means done on its own date, as every to-do before 0.14.0). Unchecking removes it; an edit that gives a done to-do another day removes it (it is then done on that day). Core: a day to-do ticked on a later day than its own is a done row of that day (`accomplishedTodos`, marked `carried`, in the done pile ahead of its own done rows, on any page date) and an open row of its own day with `wentTo`, after that day's real open rows (`rowDone` is false: unchecked, a "→ Tue 3" chip, an inert circle: `aria-disabled`, named "Done on Tue, Nov 3: ..."); it is not counted as open anywhere (`todoCounter`, the server's `open_count`), no longer carried, and a reopen is judged by its own day. Week and Month to-dos have none of this.

### 9.1 Editing in place (the owner, 2026-10-31: "dont bring up a window for editing events or reminders or anything, always edit in place")

No dialog, sheet or floating panel edits content, on a desktop or a phone: a to-do (Day, Week, Month), a priority, a schedule entry, a custom list's name and color. The item's text becomes a field of the same size and font in the same row, cell or block (no layout jump; 16px on a phone so iOS does not zoom). Settings, the date sheets, the picker and account menus stay popups, and "Manage lists" is an in-page panel (2026-11-09, #139: `section.manager-page` over the page under the top bar, not modal, `inert` page behind, Escape or Close, focus on its heading), the container of the list rows. "The rhythm…" is still a dialog. Code: `app/inplace/` (`session.ts` the pure state, `Inline.ts` keys, focus and the write path, `inplace.css`) and the panel sections.

- **One at a time.** A panel keeps its open edit in a module (`day/edits.ts`, `week/PeriodTodos.ts`) and `html()` draws that row as a field, so a redraw never takes it down; a day or list change that hides the item puts it away. Opening another item is the focus leaving the first: it is saved (an empty new one is dropped). What cannot be saved yet (over its cap, an overlap, a day change) waits and returns when the item is opened again, saying "Your unsaved changes are back." in the row (every kind) until the text changes; Escape, a save and Delete forget it. The shell never draws a panel under a focused text field, so a row left for one (the add box, a note) is swapped for its plain form by hand (`Host.swap`), once the focus has landed there (a focus-out event reports it before it has). A row opened while a write is in flight shows its field when the write ends (the shell never draws a panel then).
- **Opening.** Click or tap the text; the caret goes to the end. An empty priority cell, an empty schedule slot and Add schedule entry open a new draft the same way (a block on the grid, the cell itself). Nothing is written until the row is saved.
- **Leaving a row, one rule.** Enter in a field saves; Escape gives up. The focus moving to another field or control of the same row (Tab, a click on its day or Delete) keeps it open; the focus going anywhere else (Tab out of its last control, a click on the page or on another item) saves as Enter does and does not take the keyboard back. After Enter or Escape the keyboard returns to the item's button (a to-do given another day or week is not in the list any more: the keyboard goes to the add field, or the first to-do of a full list, and the live region says "Saved. Moved to …"); after Delete only if Delete had the keyboard. A press on a button or on a row's padding never takes the focus out of the field. An unchanged row writes nothing; an emptied stored item asks for text or Delete on Enter and is put back on leaving.
- **In the row.** The live character counter (`CAPS`, the linked cap for a linked item); for a to-do an inline day field (Week and Month: any day of the week or month wanted, stored as its Monday or 1st); Delete, an icon whose first press turns it red (its name becomes "Confirm delete"; there is no text and no Cancel, as in CalMind) and says "Deletes it for both of us." for a linked item; the second press deletes, and moving on, Escape or 2.5 seconds forgets the press (the owner, 2026-10-31; 9.6); Move up and Move down for a priority. A priority or entry has no day field: it belongs to the day.
- **Schedule entry.** The title is a field in its block; the handles stay; press-and-move on the block still moves the draft (on the field it must go mostly up or down; a finger needs the 0.4 s hold); there is no counter (the field stops at 500 characters, linked or not), no note for a linked entry (its block is purple over both lanes) and no Delete: a refused or stale save is said in the shell's banner and read out. Delete is a swipe on the entry (`EventDelete.ts`): a press on an entry that is not being edited, moved 28px or more mostly to the left (`SWIPE_PX`, `EventDrag.ts`; a finger before its 0.4 s hold, a mouse or pen after 4px), shows a red Delete button over the block's right end (`.day-ev-del`, at least 44px tall and 54px wide), and one tap on it deletes with the entry's revision. Delete is put away by a press elsewhere, Escape, a scroll or a click on the swiped entry (which opens nothing). The keyboard: Delete or Backspace on the focused entry shows it and focuses it, Enter deletes, Escape refocuses the entry. A linked entry stays one purple block.
- **Narrow cells.** A priority cell too narrow for its field and controls (a phone, a half lane of two lanes, three or four lanes) takes the whole line while edited, covering the other lane's cell until it is left.
- **Errors** (cap, overlap, a full list, a server answer) show in the row (hanging under a priority cell and, on a desktop, under a to-do line; and, for an entry, in the banner only, which has no row to hang them on) and in the banner, are announced in the live region, and keep what was typed. A lost reply keeps the text and the retry is the same add. A stale save keeps the text and offers "Enter saves yours over it, Escape keeps theirs" (the next Enter uses the newest revision); a record deleted meanwhile closes the row.
- **Accessibility.** The field is named "Edit task: <text>", "Edit priority 2: <text>", "Edit entry: <text>", "Edit to-do: <text>", "Edit list: <name>", or "New priority 1 for the partner" / "New entry"; "Saved." and failures go to `#live`. The phone's +N more list takes the To-do list's place ("Back to to-do"), so its rows are edited where they are. A done row is one row of the To-do list: its state is its checked circle ("Reopen <title>", an open one is "Complete <title>"); there is no "Done" text, heading or list for a screen reader either.

### 9.3 The AM and PM pages of the schedule (2026-10-31)

The schedule has two pages behind an AM and PM switch, on a desktop and a phone (the owner: "AM should be exactly as it was before, PM should start at the hours that AM ended at", then "PM should be 9pm-7am"). AM is the day as it was, 7a to 9p (840 minutes, 14 hourly rows). PM is the night, 9p to 7a the next morning (600 minutes, ten rows: 9p 10p 11p 12a 1a 2a 3a 4a 5a 6a) at the same row height: the grid box keeps AM's 14-row size and PM leaves its last four rows empty (no slots there). A planner day runs 7:00 to 7:00 the next morning (D16, `CAPS.eventEndMin` 1860): an entry at 2a is stored on the evening's date and is on that date's PM page, and on no page of the next date. Code: `ScheduleSection.ts` (`Win`, `WINDOWS`, `windowOf`, `shape`), `Gesture.ts` (`shownOf`, `minuteAt`), `day.css`. This replaced the phone-only split at noon of 0.5.0.

- **The switch.** `div.day-half`: buttons `data-half="am"` and `"pm"` with `aria-pressed`. On a desktop it is compact, at the right end of the Schedule heading's line (no room for a row of its own); on a phone it is a row of its own above the lane names, with 44px buttons. `.day-lanes` carries `data-from`, `data-to` and `data-span` (minutes: 420, 1260, 840 on AM; 1260, 1860, 840 on PM), which the pointer mapping reads: `span` is what the whole box stands for, so a fourteenth of it is an hour on both pages. `data-hour` of a slot counts from 7a (14 to 23 on PM).
- **Which page first.** Always AM, whatever the hour or the day, and again after a reload. The choice is kept while the page is open, across days, the arrows, views and the phone breakpoint.
- **Cut at 9p.** An entry across 9p is drawn on both pages, cut flat at the edge of the page it is on (`data-clip="top|bottom"`: square corners, and no handle on the cut edge, since its real edge is on the other page). An entry wholly on the other page is not on the page (one that ends at 9p is only on AM, one that starts at 9p or later only on PM). The block's `aria-label` keeps the real times.
- **New entries start on the page.** A tap, and the hidden Add button, treat the rest of the planner day as taken (`fit`), so a new entry is wholly on the page shown and never cut: a tap at 8:45p on AM gives 8p to 9p (moved up to stay on AM), one in the last PM row (6a) gives 6a to 7a. With no room, the message says "before 9p" (AM) or "after 9p" (PM), not that day. The Add button asks for 9a on AM and 9p on PM.
- **Moves stay on the page.** A body drag keeps at least a quarter hour of the entry on the page; a handle drag keeps the dragged edge inside the page (a pointer past the page's end, or in PM's empty rows, puts it at the page's end). A draft, a drag, a handle, Alt+Arrow (draft or stored block) or Alt+Shift+Arrow that would take the entry wholly off the page is refused, so an entry never vanishes from under its own editor. The pointer paths simply stop at the page edge; the keyboard says why: a move says "Cannot move later on this half of the day: switch to PM." (or "earlier", "AM"), a resize says "Cannot make it shorter on this half of the day: switch to AM." (or "longer", "PM").
- **The page never leaves the entry being edited.** Pressing AM or PM first saves the entry (as the focus leaving does); one that cannot be saved yet (over its cap, an overlap) stays open, and the page shown is then the one that has some of it.
- **Not built.** An entry that crosses 9p cannot be dragged across the page edge by a handle (a handle stops at the edge; only the keyboard resize, Alt+Shift+Arrow, reaches past 9p), and a drag cannot take an entry wholly to the other page: drag it until it crosses 9p, then switch page.

### 9.4 Back to month (2026-10-31)

A tap on a day of the Month (a muted day of a neighbouring month too) opens that day on the Day view with a Back button in the top bar, so the Month is one press away.
- **State.** `state.openDay(date, from)` sets the view to Day, `backTo = from` and centres the date list on the day (`go(day, true)`); `goBack()` sets the view to `backTo`, clears it, and shows the period that holds the day the Day is on by then (stepping from 31 March to 1 April with the arrows and pressing Back shows April); it does nothing when there is no `backTo`. The arrows, Today, the date field and `shiftCenter` keep the Back; `setView` (the sidebar's or drawer's view switch) forgets it, and so does every other way into a Day. `ctx.backTo`, `ctx.openDay` and `ctx.goBack` carry it to the panels; only the Month's day cells call `openDay`. Unit tests: the openDay/goBack block of `app/state.test.ts`.
- **Top bar.** `#back-view` (a ‹ and "Month"; its name is "Back to month") with `data-back` on the bar. A desktop shows it beside the sidebar button. A phone shows it where the hamburger is, 44px tall, and hides `#menu`, so the drawer (view switch, dates, Today, account menu) is reachable only after Back: an accepted trade-off.
- **Focus.** The button goes away with the press, so the keyboard goes to `#date-pill` on a phone and to `#sidebar-toggle` on a desktop, not to the page body.

### 9.5 The Week and Month to-do (2026-10-31)

Drawn like the Day's (9.2) by `week/PeriodTodos.ts`: ruled lines, a colored circle per open row (Both color when linked), the add field on the first blank line with `Add something for this week…` (or month), and a faint circle on each blank line down to a minimum of 13 lines for a Week and 8 for a Month; with more rows (open and done) the list simply grows, and the add line stays between the last open row and the first done row. A click on a blank line, or on the add line's faint circle, starts a to-do there, cut in thirds in the Both view (9.7); Enter in the add field adds, and the Add button shows only once there is text. The counter shows near the 500-character limit. There is no add box and no "Nothing here yet". The owner's name stays in the row for screen readers only (`sr-only`; the circle is the visible cue). Done to-dos are rows of the same list, crossed out, stacked as its last lines under the blank lines (9.8); there is no "Done (n)" heading or block. Editing a row in place is unchanged (9.1). On a phone the lines are at least 40px, the field 16px and the Add button 28px, a small inline button like the Day's (26px): the one exception to the 44px rule, while the phone's AM/PM switch keeps 44px (UX-NOTES).

### 9.6 The delete icon (2026-10-31)

Delete is the trash icon in every row that has one (to-do, priority; an entry has none in its editor, it is a swipe and a tap, see the schedule entry paragraph above; a list row in "Manage lists" looks and times the same, `ListManager.ts`). The first press arms it: the icon turns red (white on #d6453d) and its name becomes "Confirm delete"; nothing else changes (no text, no Cancel, as in CalMind). The second press deletes. The press is forgotten by the focus leaving the icon, Escape, and 2.5 seconds (`ARMED_MS`, `Inline.ts`), including when the delete did not go through (the icon stays red until the timer forgets it, and a write still running holds the timer back) and acting on the row that is on the page after a redraw, not the one pressed.

### 9.7 To-dos in thirds (2026-11-01)

Alex: "make todos have the same interface for left middle right being user 1 / both / user 2". In the Both view with exactly the two people's lanes (`blankThirds`), a blank ruled line of the Day (13 slots), Week (13 lines) and Month (8 lines) To-do is cut in thirds across its width, the same as the schedule (9) and the priorities: the left third is a to-do for the left lane's person (the signed-in one), the middle third one linked to-do for both (`settings.bothColor`), the right third the right lane's person. Core `blankAim(selection, lists, settings, lanes, across, both?)` is the one decision (`side` left, both, right or only; owners and color from `newOwners`); `app/panels/BlankSlots.ts` asks it for the click and for the hover ghost (`.day-cell.day-newcell.todo-newcell`, the owner's color, left or right half or the whole line; no hover on a touch screen), and the Day and the Week/Month only say how a new to-do is opened. A click opens it in place over the line clicked (9.1: key `todo:new:<line>`, field "New to-do for the owner and the partner", Enter or the focus leaving saves, an empty one is dropped, Escape gives the blank back); the saved to-do takes the next free line top-down. One list shown, a custom list with an overlay, and Both with an overlay have no thirds: the line is for `newOwners` alone. The add field stays the keyboard's route (linked under Both) and is the first blank line, cut in thirds too while it is empty; with words in it a click goes on typing. A press on the empty field takes the focus off whatever was being edited (it saves, as a press on any other blank line does), and Enter on a to-do written over that line returns the keyboard to the add field, not to the saved to-do, so a person who clicked the field can keep typing. Shift on a click is both, and a hidden `button[data-both]` (`tabindex=-1`, "Add to-do for the owner and the partner") in the add line is a screen reader's way. Limits (13 per list per day, text caps, revision checks, the carried-over count) are unchanged: a full list has no blank line, and a refusal stays in the row with the words kept.

### 9.8 Done to-dos stay in the list and stack at the bottom (the owner, 2026-11-01: "don't hide done todos, put crossed out items at the bottom", then "checked todos stack at the bottom of the list rather than the top of the list")
- **One list.** A done to-do is a row of the same list as the open ones (the Day's `.day-tasks`, the Week's and Month's `ul.wm-todos`), crossed out and dim (`.day-done`, `.wm-todo.done`), stacked at the bottom of the list: the open rows first, then the blank lines (the add field the first), then the done rows as the last lines of the page, in the order the core gives (`todosDone`, `pos`). (The first 0.9.0 build put them right after the open rows; the owner's "checked todos stack at the bottom of the list rather than the top" corrected it in 0.10.0.) There is no "Done (n)" button or heading, no `.day-donelist` or `.wm-done` block and no 'done' mode on the phone; the list's name is unchanged (`To do` on the Day, `To-do` on the Week and Month).
- **Lines.** Done rows use up the last blank lines: the blank lines left, between the open rows and the done rows, are `max(0, 13 - open - done)` on the Day (core `todoSlots(open, done).empty`; the add field is the first of them, and the one line between the last open row and the first done row when none is left) and `max(1, 13 or 8 - open - done)` on the Week and Month (core `periodBlankLines`; the list grows past its minimum). Done rows never count against the cap of 13 open rows per list, and "+N more" still means open rows beyond the 13th; the more list shows only that open overflow.
- **Moving.** Checking an open row (`complete`, which records `doneOn`, the page it was ticked on: 9.2) moves it to the bottom pile, among the done rows, unchecking brings it back up among the open ones at its own place (above the blank lines). The move is drawn at once, from the optimistic display (`state.session`: the snapshot with the unanswered `complete`, `markChore` and entry `edit` writes laid over it, core `predict`), in the frame of the tap or the next one, and not when the last save returns (#230); the shell's redraw decision is `app/shell/redraw.ts` (held only for a write the screen cannot answer, a refusal not yet settled, a pointer down or a focused text field; an optimistic write in flight holds nothing). `e2e/checkoff-now*.spec.ts` holds every write at the network and asserts the order before the first reply. A new to-do written on a blank line (9.7) is saved among the open rows, after the last open one and above the blank lines, wherever on the page it was started; where the list cannot be drawn again (the editor left for a text field of another section) the row is put there by hand (`seatRow`: an open row after the last open row, a row finished meanwhile among the done rows at the bottom), as the next drawing will. A linked to-do is one row; a done row keeps its owner color. Editing, the two-press delete and the "from" chips work on a done row as on an open one; a carried to-do that is ticked on today is a done row of today with its chip and unchecked, pointing at today, on its own day (9.2).
- **Height.** The Day's list keeps the height of its 13 lines. A desktop (`[data-layout=wide] .day-todo>.day-tasks`) has `overflow-y:auto` and `min-height` of 13 rows of 28px: with more rows than fit, it scrolls inside itself, no row shrinks below 28px, and the page and the panel never scroll (a window shorter than the 13 lines still scrolls the panel, as before). A phone's list already scrolled inside the tab (rows keep their 30px floor, the tab never scrolls). The Week's and Month's list has no scroll of its own and simply grows.
- **A list that scrolls keeps its rings and its place.** The Day's list is a scroll area, which clips what hangs outside it, and a redraw rebuilds the panel. So (1) `.day-todo>.day-tasks` has 3px of room on both sides (`padding-inline:3px; margin-inline:-3px`, the rows keep their places), `scroll-padding-block:3px`, and its controls draw the keyboard ring flush (`outline-offset:0` on `:focus-visible`): the whole ring of the first circle, the last title and the add field lies inside the list; (2) `Shell.render` puts back the `scrollTop` of the panel host, `.day-tasks`, `.wm-body` and `.wm-side` after every redraw of the same panel, day and tab (checking or reopening a row, opening, cancelling or saving an edit, a poll), and brings a control the panel focused while it drew (the edit field, the add field after an add, the button the keyboard returns to) into the view of those scroll areas, the nearest bit that shows it. Another day, view or tab starts at the top.


### 9.9 Chores (the owner, 2026-11-02)

Rules, marks and the rhythm are stored (store v3) and the rule engine is `packages/core/src/chores.ts` (week letters, a rule's turns on a date, a turn's state as of today, the Day, Week and Month builders, the Month's calendar, the owner cycle); the views only draw it. Chores ignore the picker (`ChoreInput` has no selection; both people see every rule). See `UX-NOTES.md` for what the owner approved; the build points are:
- **Mode:** `state.chores` (memory only; the `'chores'` change redraws the header, top bar, sidebar and page like `'nav'`) and `ctx.setChores`: one flag. At phone width the shell draws `app/panels/chores/ChoresView.ts` instead of `PANELS[state.view]` (`Shell.choresPage`: the flag on and `isPhone()`); the Day, Week and Month panels know nothing of it but the phone Chores tab, which calls `ctx.setChores(true)` (`DayPanel`, `WeekPanel`, `MonthPanel`, `week/PhoneTabs.ts`) and a `showTab` the view uses to hand the planner the tab it leaves by. On a desktop the shell never draws `ChoresView`: the flag is the Day's Chores switch, and a window crossing 760px redraws the page (a `matchMedia` listener in `Shell.ts`), so widening with the flag on lands on the planner Day with the switch on. `place.ts` carries the flag across a release reload.
- **Desktop (0.15.0):** `ListPicker.ts` ends its list rows with a Chores switch (`role=switch`, a house and a toggle) on the Day only (never the phone's menu); toggling calls `ctx.setChores(!ctx.chores)` and leaves the selection alone, the button stays the lists' pie, and "The rhythm…" is hidden on the Week. `DayPanel` draws `day/ChoresSection.ts` (the `.day-chores` section: the same rows as the phone's Chores Day, `chores/DayChores.ts`, `ChoreRow.mountRows`) in place of the To-do section while the flag is on; its box is the to-do list's (`day.css`). The Week has no chores. The Month: `monthChoreCells` (core: the 42 cells of `monthView`'s grid, each with its week's letter, whether it is a Saturday and its turns) drawn by `month/MonthGrid.ts` as `div` cells with a date button and the Chores row chips (the empty part of a cell opens the day too); `monthChoreGrid` (with `done` / `total`) remains for the phone's Chores Month eyebrow; the phone's date chip is a `data-act="day"` button that `mountRows` turns into `ctx.openDay`. `monthView`'s cells are only `{ date, inMonth }`: the planned-item dots and counts are gone.
- **Phone:** `ChoresView` (phone only) draws the period's bar (`day/DayTabs.ts` for the Day, `week/PhoneTabs.ts` for Week and Month, so it is the planner's bar with Chores chosen) under the page, and another tab calls the shell's `leave`. The picker is a locked button (`aria-disabled`, no menu) while the view is on. The rows, grid and groups are `app/panels/chores/` (`ChoreRow` is the one row and the one tap handler; `DayChores`, `WeekChores`, `MonthChores`' list; the Month's Calendar tab also draws that list under its grid with a bar for each chore in the cells, `choreBars`); styles in `styles/chores.css`.
- **The rhythm:** `app/picker/RhythmEditor.ts`, modeled on `ListManager.ts`, opened by "The rhythm…" in `ListPicker.ts`. A rule's circle, days, weeks and months save when chosen; its title on Enter or when the focus leaves the row; delete is two presses. A new rule is for both of us (`newChoreOwners`); a new weekly or monthly rule starts on today's weekday (`newChoreDay`).
- **Not listed anywhere:** turns let go by time (superseded by a later turn of the same title on or before today, or past their catch-up Friday); they show only as "–" in the Week grid.

## 10. Client architecture (plumbing only)

Behavior is in `packages/core`; modules hold DOM plumbing.

- `app/main.ts`: bootstrap only (load session, theme, mount shell).
- `app/api.ts`: `request()`, error mapping by `code`, 401 and 403 close the view (unchanged behavior), 45 s timeout (a deploy slows the host), the release stamp of every answer, uncertain-outcome message on network failure.
- `app/state.ts`: session snapshot holder, `applyResponse` (ignores `revision` lower than held; a failed read never replaces state), selection, drafts map, subscribe, polling every 12 s (pauses while hidden, skips while a write is in flight, never overwrites a focused field or a draft, applies `prefs` only at load).
- `app/colors.ts`: `setTheme` tint writer. `app/theme.ts` and `packages/core/src/parse.ts` stay exact copies; core never imports from `app/` (only `colors.test.ts` imports `../../app/theme`).
- Panels export `html(ctx): string` and `mount(root, ctx): () => void` (unmount). A panel renders only view models from core and sends writes through `ctx.send(mutation)`; panels never import each other.
- The shell imports the panels, the list picker, the date sheet, the account menu (`app/shell/AccountMenu.ts`: one button with a dropdown of Settings and Sign out, after the suite's username menu) and Settings (`app/shell/Settings.ts`: who is signed in, the four themes, Done) directly. A theme pick is `state.saveTheme`: shown at once, saved through `setTheme`, put back when the save fails. The desktop sidebar button (`state.setSidebar`, saved with the picker state in `savePrefs`) hides the sidebar with `display:none`, so it is out of the tab order and the accessibility tree. The optional SHOULD interactions module (WP-X1) has no hook until it exists; add one then (it was removed as scaffolding for a module that does not exist).
- Each UI module imports its own CSS file; `style.css` keeps shell rules only.

## 11. Test plan

Rules from `TESTING.md`: disposable fixtures only. During development run focused checks; the full `npm test` and `npm run test:e2e` run once at the end.

### 11.1 PHP (`server/tools/test.php` becomes a runner over `server/tools/cases/*.php`, shared `harness.php` with `check`, `refuses(fn,status,code)`, `fails`)
1. Authorization: a third-party or unconfigured user refused on every action (including `savePrefs`); unauthenticated and CSRF cases stay in e2e.
2. Fail closed: a v1 db that is not exactly what 0.1.0 wrote throws and file bytes are unchanged (a well-formed v1 db with records is converted, see `cases/migration.php`); empty v1 treated as fresh; v2 record missing `owners`, with a non-canonical owner set, an unknown list, slots keys different from owners, an off-grid event or a misaligned period all throw; corrupt ciphertext and missing key cases kept; the file is never rewritten by a rejected read.
3. Owners: single, linked, custom accepted; `['sam','alex']` canonicalised; duplicate, three, `['sam','<custom>']`, empty, non-array all `invalid`; unknown list `gone`.
4. Add idempotency per kind: retry returns an identical db; retry after the item was edited is still a no-op; different content or other user is `id_in_use`; a retried event does not fail its own overlap check; ids unique across kinds.
5. Linked behavior: complete flips one record seen by both lists; stale edit after the other person's edit is `stale`; delete removes for both; owner change Both to the owner keeps content.
6. Priorities: 5 slots; same slot for different owners allowed, same owner `slot_taken`; linked on different lines allowed; `movePriorities` swap, shift, partial stale rejects the whole batch with no change, final collision rejected, linked item moved in one list leaves the other owner's line, retry at target is a no-op.
7. Events: grid, bounds (before 7:00, end after 7:00 the next morning, so a start of 1830 for 30 is stored and one for 45 refused, length 0, 15 rejected as under the minimum), default half an hour, overlap same lane, touching allowed, other lane allowed, linked conflicts with either lane, edit excludes self, owner change into an overlap rejected.
8. Caps: the open day to-do after the 13th `limit` with `cap`; done to-dos free room; un-completing into a full list `limit`; linked counts for both owners; week and month capped at 200; text at the cap and one past it per kind and linked (priority 18/19, day to-do 36/37, event 500/501); emoji and combining-mark pins; day notes 401 rejected.
9. `moveTodo`: before a target, to the end, midpoint, forced renumber, cross-bucket 400, hidden neighbours ordered correctly, neighbours' revisions unchanged, no-op when in place.
10. Lists: create idempotent, duplicate and reserved names in any case `name_taken`, bad color `invalid`, 13th custom `limit`, person name immutable and color editable, stale rename, delete needs `confirm`, cascade removes sole-owner items and notes and cleans both users' prefs, `sam/alex/both` delete 400, linked items survive.
11. Notes: isolation per (scope, period, list, field); invalid pairs 400; Monday and first-of-month rules; day cap; same-text retry no-op; stale 409; unknown list `gone`.
12. Prefs: each user sees only their own; sanitisation; no global revision change; no rewrite when unchanged.
13. Settings: color validated; stale.
14. Size: oversized plaintext `store_full` and file untouched; deleting while near the cap still works.
15. Concurrency: 6 parallel PHP processes each add a distinct item; all present, global revision 6, file decrypts.
16. Drift: `limits.php` equals `CAPS` (`npm run check:limits`); `ERROR_STATUS` table matches `RequestError` defaults.
17. Encryption: titles, list names and note text absent from the `.enc` file.

### 11.2 Vitest (`packages/core/test`, one file per area)
- `selection.test.ts`: lane order for the owner and for the partner signed in; single, custom alone, overlays appended in list order; Both excludes custom unless overlaid; `selectOnly` clears overlays; `toggleOverlay` add, remove, refuse third, unchecking the custom base lands on Both, person rows never toggle; dangling overlays dropped and unknown base falls to Both; `pickerRows` states; `newOwners` (Both is linked, a list is itself, overlays never decide, a tapped lane decides).
- `placement.test.ts`: priority cells for the same line (span 2) and different lines (two cells); linked item in a single-list view stays Both-colored; overlay lane; event cells; `visibleTodos` ownership, open before done, `pos` order; `noteLanes`; `monthView` 42 cells, edge months, up to 3 colors, counts de-duplicate linked items; the open to-do rows of a period (visible lanes, a linked one once, done and other days out, week and month keys).
- `schedule.test.ts`: `snapQuarter`, `clampEvent` (default half an hour, minimum, window edges), `findEventOverlap` (touching ok, shared owner only), `freeStartNear`, `freeSpanNear`, `fitNewEntry` (half an hour, a gap too short for it, the pointer in the last quarter of a gap, a taken pointer quarter, page walls, the owner's 7:35p screenshot), `resizeEvent` (each edge, stops at neighbours, minimum, window), `timeLabel`.
- `priorities.test.ts`: `suggestSlots`, `arrangePriorities` (move up, down, into a gap, to the same line, at most 5 moves).
- `limits.test.ts`: `textLimit` matrix, `counter` with emoji, `todoCounter` (linked, done ignored), `todoSlots` with done rows, `periodBlankLines`, `laneChars` for 1 to 4 lanes and span 2, `CAPS` snapshot.
- `colors.test.ts`: defaults, custom cycling, linked uses `bothColor`, `personalSettings` (a pick replaces only `bothColor`, two people differ, a value outside the palette is ignored), AA contrast for every theme and key (imports `../../app/theme`).
- `planner.test.ts`: the existing date tests untouched; the old ownership test replaced.
- `app/state.test.ts` (navigation): `openDay(date, 'month')` shows that day on the Day view, centres the date list and remembers the Month; `goBack` returns to the period of the day the Day is on by then and forgets the Back; the arrows, `go` and `shiftCenter` keep it; `setView` forgets it; a Back with nothing to go back to changes nothing and tells nobody.

### 11.3 Playwright (disposable PHP server and two accounts as today; shared `e2e/helpers.ts`)
- `planner.spec.ts` (rewritten, API and shell): 401, CSRF, old `person`-shaped add rejected 400, v2 error codes, both accounts share one store, stale 409, failed-write draft retention, no browser storage of private data.
- `picker.spec.ts`: row tap selects alone; box adds an overlay; Both never includes a custom list implicitly; unchecking a custom base lands on Both; third overlay refused with the hint; the partner and the owner rows cannot be deleted; create, rename, recolor, delete (two presses); selection survives reload and a second context of the same user and differs for the other user; `localStorage`, `sessionStorage`, `indexedDB.databases()` and `caches` empty.
- `lanes.spec.ts`: the signed-in person is the left lane for the owner and for the partner; a Both entry spans both lanes; same line spans, different lines give two half cells; colors per list and Both color in all four themes; Both color change in the manager; `calmind-allday.spec.ts` and `calmind-allday-phone.spec.ts`: the strip above the timeline in each person's lanes, absent on a day with none, the same look as the timed cards, read-only, the timed card's `spanBox` numbers identical with and without it, +N overflow in two rows, one chip across both lanes in this person's Both color, a multi-day run, both pages, the CalMind button, 375x812, 375x667 and 320x568 with nothing scrolling sideways; `both-color.spec.ts`: no pick leaves both people on purple, two people pick different Both colors and each sees their own on the Day, the picker and a new Both to-do, also after a reload, with the store at v5 and the household setting unchanged; a color outside the palette is refused and `null` clears.
- `day-desktop.spec.ts`, `day-phone.spec.ts` (375x812, 375x667 and 320x568): tabs Schedule, To-do, Notes; every Day tab fits with no scroll, also while a row is edited, the Schedule tab on each page (AM 14 rows, PM 10 at the same row height, 9.3); live counters; Enter blocked over cap; the 13 ruled To-do slots and the add field in the first blank one (13 open: no field, the reason); the done rows crossed out in the To-do list, stacked at the bottom, and "+N more" in the To-do tab's place, their rows edited where they are; no horizontal overflow; date sheets. `done-rows.spec.ts` and `done-rows-phone.spec.ts`: 9.8 on a desktop, a phone, the Week and the Month. `inplace.spec.ts`: the rules of 9.1 (Enter, Escape, the focus leaving, Tab, one item at a time, a name for the field and the keyboard's return, stale, deleted meanwhile, a lost reply, a poll under a row, the swap by hand); `app/inplace/session.test.ts`: the pure state.
- `account.spec.ts` (both projects): the account button and its menu (keyboard, outside press, on screen, Sign out as a CSRF form), Settings (four themes, applied at once, saved, kept after a reload, reverted on a failed save), the `setTheme` API. `sidebar.spec.ts`: the sidebar button and its saved preference. `desktop-fit.spec.ts`: no scroll bar on Day (both selections, light and dark, four window sizes), Week and Month. `drag.spec.ts`: real mouse, pen and touch drags, Escape and cancel, stale and refused drops, Alt+Arrow, handle reach (also in WebKit with `PLANMIND_E2E_WEBKIT=1`).
- `day-phone-half.spec.ts` (phone project): the AM/PM switch of 9.3 on a phone (a row of its own, 44px buttons), AM the 14 rows as they were and PM the ten rows 9p to 6a at the same row height with the rest of the box empty, the page always opening on AM and the choice kept (also across the phone breakpoint), an entry across 9p cut flat with no handle on the cut edge and its real times in its label, the night belonging to its evening's date (an entry at 1a on that date's PM page, on no page of the next date) and the day ending at 7a, new entries and the hidden Add button wholly on the page shown ("before 9p" / "after 9p" when full), the Both view in thirds on both pages, drags, handles, Alt+Arrow and Alt+Shift+Arrow kept on the page (refusals announced), switching page while an entry is edited saves it first and never leaves it. `day-half.spec.ts` (desktop project): the same for a desktop, where the switch is compact at the right end of the Schedule heading's line and the hover preview follows the page. `back-to-month.spec.ts` (desktop project; its phone-sized describes set their own viewport, touch and mobile): a Month day opens the Day with Back (beside the sidebar button; on a phone in place of the hamburger, finger-sized); the arrows keep it, a view chosen by hand forgets it, Back returns to the Month of the day the Day is on, focus goes to the date (phone) or the sidebar button (desktop); also that a desktop Day opens on AM, the whole 7a to 9p day, with an entry across noon whole.
- `week-month.spec.ts`: per-lane text blocks, drafts survive a selection change, no dots on the Month grid, Week tabs and Month tabs scroll, Month side column stacks, the ruled Week and Month to-do (13 and 8 lines, the add field on the first blank line, a tap on a blank line or its circle focuses it, Add only with text, no "Nothing here yet", more rows grow the list).
- `todo-thirds.spec.ts` and `todo-thirds-phone.spec.ts`: the To-do in thirds of 9.7 on the Day, Week and Month: the hover ghost per third and its color and place, a click in the middle third saves ONE linked to-do seen in both lists, an outer third one lane's, the add field's line cut too (and typing in it kept), one list or a custom list with an overlay with no thirds, Escape gives the blank back and the keyboard returns to the add field, Shift+click and the hidden button for both, the add field as the keyboard's way, a full list with no blank line and a server refusal that keeps the words, a tap in each third on a phone with no hover and no scrolling.
- `schedule.spec.ts`: a new entry fits where the pointer is (30 minutes in the free stretch, positioned to fit; the nearest free start when the pointer's quarter is taken), the owner's 7:35p screenshot in the middle third, and the hover preview of it; a long text over as many lines as the block holds (re-fitted on a window or banner change, and after a block is put back by hand), a quarter-hour block with a fully contained title, 500 accepted and 501 refused in the banner; the Both view cut in thirds (the hover and the tap: outer thirds are the lanes, the middle one a linked entry over both); edit-mode handles resize both edges with snapping and a start–end label, stop at a neighbour, Enter saves with the text in one write; no Start or Length control, Alt+Arrow moves and Alt+Shift+Arrow resizes; overlap refused with the draft kept; a stale write keeps the draft and offers Escape or Enter again.
- `linked.spec.ts` (integration, last): add as Both, complete from the other account, edit, delete, owner change.
- SHOULD: `interactions.spec.ts` for drag, reorder, Alt+Arrow.

## 12. Server function contract (flat files in `server/lib`, namespace `PlanMind`)

WP-S1 defines these in `planner.php` and `planner_rules.php`; WP-S2 and WP-S3 implement the handlers with exactly these signatures so the three can be written in parallel. Every handler takes the decoded db (after `snapshot` validation and `fresh_db` seeding), the input, and the authorized user, and returns the new db (the same array for a no-op).

```
RequestError::__construct(string $message, int $status = 400, string $code = '', ?string $cap = null)
fresh_db(): array                                        // v2 with seeded lists and settings, revision 0
snapshot(array $db, string $user): array
validate_db(array $db): void                             // throws RuntimeException
mutate(array $db, array $input, string $user, ?string $today = null): array    // authorizes, routes by 'action', bumps revision once
touch(array $db): array                                  // ++revision
// planner_rules.php
valid_id, valid_date, valid_period(string $scope, string $date): bool, cps(string): int, clean_text(mixed, int $max, bool $single): string
canonical_owners(array $db, mixed $owners): array        // 400 invalid / 409 gone
item_text_limit(string $kind, array $owners, string $scope = 'day'): int   // kind event|priority|todo|note; scope picks 36 vs 500 (todo) and 400 vs 12000 (note)
open_count(array $db, string $listId, string $date, ?string $excludeId, ?string $today = null): int   // $today: also counts earlier days' open to-dos on that date (9.2)
find_event_overlap(array $db, string $date, array $owners, int $start, int $length, ?string $ignoreId): ?array
fingerprint(array $canonical): string                    // ak
// planner_items.php   (WP-S2)
op_add, op_edit, op_complete, op_delete, op_move_todo, op_move_priorities
// planner_lists.php   (WP-S3)
op_save_note, op_save_list, op_delete_list, op_save_settings, op_save_prefs
// limits.php (generated): const LIMITS = [...]  mirrors CAPS
```

`planner.php` `require_once`s `limits.php`, `planner_rules.php`, `planner_items.php`, `planner_lists.php` from `__DIR__`. All files stay flat so the deploy audit passes unchanged.

Conventions fixed when WP-S1 landed (S2, S3 and S4 follow them):
- `RequestError` exposes `status` (int), `errorCode` (string), `cap` (?string) and `body(): array` (`error`, `code`, `cap` when set). The constructor throws `InvalidArgumentException` for an unknown code or cap, or a code whose `ERROR_STATUS` differs from the status. `api.php` answers with `echo json_encode($e->body())`. CSRF failures in `pm_csrf()` use code `csrf`.
- `mutate()` owns the global revision: it sets exactly previous + 1 whenever the handler's db differs from the one it received (unchanged for `savePrefs`) and re-validates the result. Handlers do not bump the revision; a no-op returns the array it was given. A handler that adds a field beyond `model.ts` makes `mutate` throw a 503.
- `limits.php` also defines `PlanMind\MODEL` (`storeVersion`, `personLists`, `colorKeys`, `defaultColors`, `noteFields`, `errorStatus`) beside `LIMITS`. Read colour keys and note fields from it; never define either constant elsewhere.
- Only the section 12 functions are public in the `PlanMind` namespace (plus `allowed()`); anything else goes in a class or is prefixed so merged files never redeclare it. Case files do not `require` `planner.php`; the harness loads it. Harness helpers: `check`, `refuses($fn, $status, $code)`, `fails($fn, $messagePart)`, `harness_db/store/id/stamp/log`, `HARNESS_CUSTOM`, `HARNESS_OTHER`. Run one file with `node tools/php.mjs server/tools/test.php <part-of-name>`.
- `canonical_owners` and the TS `canonicalOwners` share vectors: sorted, a duplicate or three owners invalid, `['sam', <custom>]` invalid. The PHP also rejects ids that are not valid list ids (`both`, `all`); the TS one is shape only.

## 13. Work packages

Ownership is exclusive: no file appears in two packages. "Handed over" means the file is created by the first package, then owned by the second. `model.ts` is frozen; amendments only through the lead.

Phases: **P1** WP-C1, WP-C2, WP-S1 in parallel, then WP-S2, WP-S3 (use the section 12 signatures, integrate after WP-S1); **P2** WP-U1 alone; **P3** WP-U2, then WP-U3, WP-U4, WP-U5 in parallel; **P4** WP-X1 (SHOULD), WP-I1 integration and docs.

### WP-C1 Core selection, lanes, colors
- Files: `packages/core/src/selection.ts`, `packages/core/src/colors.ts`, `packages/core/src/planner.ts` (remove `Filter`, `Task`, `Note`, `Snapshot`, `visibleTasks`, `remaining`; re-export types and constants from `./model`; keep the date helpers unchanged), `packages/core/test/selection.test.ts`, `packages/core/test/colors.test.ts`, `packages/core/test/planner.test.ts`.
- Depends on: none (reads `model.ts`).
- Acceptance: `canonicalOwners`, `resolveSelection`, `selectOnly`, `toggleOverlay`, `pickerRows`, `pickerColors`, `resolveLanes`, `newOwners`, `itemColor`, `nextCustomColor`, `tint`, `contrastRatio` implemented per `CoreFunctions`; every selection and color item in 11.2 passes; AA contrast holds for all 4 themes x 9 keys (adjust tint percentages, not the theme); date tests unchanged and green; `parse.ts` untouched.

### WP-C2 Core placement, schedule, priorities, limits, views
- Files: `packages/core/src/placement.ts`, `schedule.ts`, `priorities.ts`, `limits.ts`, `views.ts`, and tests `placement.test.ts`, `schedule.test.ts`, `priorities.test.ts`, `limits.test.ts`.
- Depends on: none to write; `views.ts` imports `resolveLanes` and `itemColor` from `./selection` and `./colors` (never from `./planner`, which re-exports it). `planner.ts` currently re-exports `model`, `selection` and `colors`; the integrator adds `export *` lines for `placement`, `schedule`, `priorities`, `limits` and `views` when this package lands. Until then other packages import those from their own module files.
- Acceptance: all remaining `CoreFunctions` implemented; every placement, schedule, priorities, limits and month item in 11.2 passes; no DOM, clock, fetch or storage use; code-point counting pinned by an emoji test; `dayView().priorities.length === 5` and month grid length 42.

### WP-S1 Server store, rules, dispatcher, drift check
- Files: `server/lib/planner.php`, `server/lib/planner_rules.php`, `server/lib/limits.php` (generated), `tools/gen-limits.mjs`, `tools/check-limits.mjs`, `package.json` (add `check:limits`; add it to `test`; add `test:server` unchanged), `server/tools/test.php` (runner), `server/tools/harness.php`, `server/tools/cases/store.php`, `server/tools/cases/concurrency.php`.
- Depends on: none.
- Acceptance: section 12 signatures in place; store, snapshot validation and `fresh_db` behave per 5.1 to 5.3; cases 2, 14, 15, 16, 17 of 11.1 pass; `RequestError` code defaults; `store_full`; deploy audit unchanged (`sh tools/test-deploy.sh` still green with the extra flat PHP files in `dist`); `npm run check:limits` green.

### WP-S2 Server items
- Files: `server/lib/planner_items.php`, `server/tools/cases/items.php`, `cases/events.php`, `cases/priorities.php`, `cases/todos.php`.
- Depends on: WP-S1 (signatures; integrate after it lands).
- Acceptance: cases 3 to 9 of 11.1 pass, including idempotent adds after edits, per-owner slots, overlap rules, open-only caps and `moveTodo` renumber.

### WP-S3 Server lists, notes, settings, prefs
- Files: `server/lib/planner_lists.php`, `server/tools/cases/lists.php`, `cases/notes.php`, `cases/prefs.php`.
- Depends on: WP-S1.
- Acceptance: cases 10 to 13 of 11.1 pass, including cascade delete and prefs sanitisation.

### WP-S4 API entrypoint
- Files: `server/public/PlanMind/api.php`.
- Depends on: WP-S1.
- Acceptance: `snapshot($data, $user)`; error JSON carries `code` (and `cap`); `?since=`; 405 for other methods carries `code`; everything else unchanged; no edits to `index.php` or `bootstrap.php`.

### WP-U1 UI plumbing and shell
- Files: `app/main.ts`, `app/api.ts`, `app/state.ts`, `app/colors.ts`, `app/panelContext.ts`, `app/style.css`, `app/styles/tones.css`, `app/shell/Shell.ts`, `app/shell/Sidebar.ts`, `app/shell/TopBar.ts`, `app/styles/shell.css`, `e2e/helpers.ts`, `e2e/planner.spec.ts`, `playwright.config.ts`.
- Handed over after P2: initial `app/styles/components.css`, `app/styles/day.css`, `app/styles/weekmonth.css` (existing rules moved out of `style.css`, to WP-U2, WP-U3, WP-U4).
- Depends on: WP-C1 types, WP-S4 for running e2e.
- Acceptance: old behavior reproduced on the new session shape (Day with to-dos only) so the app runs end to end; selection state held in `state.ts`; polling and draft rules of section 10; `setTheme` writes tint variables for all keys; `planner.spec.ts` green with a phone project added.

### WP-U2 Shared UI components
- **As shipped:** only `DateSheet.ts` (with `components.css` and `phone.css` for the date sheet). The lane grid, tab bar, to-do list, edit dialog, For control and counters listed below were written but never mounted: the Day, Week and Month panels draw their own, so they were deleted. Moving the panels onto one shared layer is a separate change, guarded by the Day, Week and Month specs.
- Files: `app/components/Lanes.ts`, `TabBar.ts`, `DateSheet.ts`, `ForControl.ts`, `TodoList.ts`, `EditDialog.ts` (and the later dialog layer in `DayPanel.ts`, `EditorPlace.ts`, replaced by editing in place, 9.1), `Counter.ts`, `app/panels/TodoSection.ts`, `app/styles/components.css`, `app/styles/phone.css`, `e2e/phone-sheets.spec.ts`.
- Depends on: WP-U1.
- Acceptance: Lane header and cell rendering from view models; phone tab bar with `PHONE_TABS`; date sheets (calendar, week list, month grid); live counters; a "+N more" row and the done rows crossed out in the list; no inline styles.

### WP-U3 List picker and manager
- Files: `app/picker/ListPicker.ts`, `app/picker/ListManager.ts`, `app/styles/picker.css`, `e2e/picker.spec.ts`.
- Depends on: WP-U1, WP-C1.
- Acceptance: all picker items of 11.3; debounced `savePrefs`; manager covers list and Both color; no browser storage.

### WP-U4 Day panel
- Files: `app/panels/DayPanel.ts`, `app/panels/day/ScheduleSection.ts`, `PrioritiesSection.ts`, `DayNotes.ts`, `EventHandles.ts`, `app/styles/day.css`, `e2e/day-desktop.spec.ts`, `e2e/day-phone.spec.ts`, `e2e/day-phone-half.spec.ts`, `e2e/day-half.spec.ts`, `e2e/schedule.spec.ts`, `e2e/lanes.spec.ts`.
- Depends on: WP-U1, WP-U2, WP-C2.
- Acceptance: Day desktop per wireframe; phone tabs fit one screen at 375x667 and 320x568, the Schedule with two pages behind an AM/PM switch on both layouts (9.3); the Both view's schedule cut in thirds (section 9); edit-mode handles per section 9 (no start or length control, the keyboard moves and resizes); priorities in lanes with Move up/down; all Day items of 11.3.

### WP-U5 Week and Month panels
- Files: `app/panels/WeekPanel.ts`, `app/panels/MonthPanel.ts`, `app/panels/NoteSection.ts`, `app/panels/week/*.ts`, `app/panels/month/*.ts`, `app/styles/weekmonth.css`, `e2e/week-month.spec.ts`, `e2e/back-to-month.spec.ts`.
- Depends on: WP-U1, WP-U2, WP-C2.
- Acceptance: per-lane priorities and notes, week and month to-dos as ruled lines (9.5), month grid of the chores (0.15.0; it had up to 3 colored dots) and tap-to-Day with Back to month (9.4), phone tabs; drafts keyed by note key; all Week and Month items of 11.3.

### WP-X1 Draft interactions (SHOULD)
- Files: `app/interactions/index.ts`, `ScheduleDrag.ts`, `ReorderDrag.ts`, `Keys.ts`, `app/styles/interactions.css`, `e2e/interactions.spec.ts`.
- Depends on: WP-U4, WP-U5; runs only after the owner approves the DRAFT wireframe.
- Acceptance: drag with 4 px threshold, 15-minute snap, nearest free quarter-hour, Esc cancels, stale drop snaps back and refreshes, Alt+Arrow moves; drag changes owners only across the Both view's thirds.

### WP-I1 Integration and docs
- Files: `e2e/linked.spec.ts`, `README.md`, `HANDOFF.md`, `TESTING.md`, `docs/ux/UX-NOTES.md` (data model section), `package.json` version (minor bump to 0.2.0 at release, by the lead).
- Depends on: all of the above.
- Acceptance: `npm test` and `npm run test:e2e` green once at the end; HANDOFF requirement 6 marked resolved; README and TESTING describe v2, the picker, caps and the new test layout.

## 14. Risks

1. **Format break.** Production ran 0.1.0, so real v1 data may exist. It is converted on the first write with a kept backup (D11); a v1 file in any other shape fails closed. Covered by `cases/migration.php`.
2. **Full snapshot per poll.** Grows with years of data (hundreds of KB). `?since=` removes the transfer when nothing changed; date-window reads are the next step and are not in this scope.
3. **Server-wide caps.** The caps apply to every client including desktop (the schedule entry's is 500 since 2026-11-01); a roomier desktop needs different constants and a clipping rule. Cheap to change, so decided now.
4. **Overlap rule.** Two devices racing for a slot give `overlap` to the loser; the UI keeps the draft. If real meetings must overlap, relax the server rule to a UI hint.
5. **Linked-item false conflicts.** One record means a text edit and a priority-line move on the same linked item collide (409, refresh). Chosen for integrity.
6. **Batch moves.** A stale revision on any record in `movePriorities` rejects the whole drop (snap back and refresh).
7. **Canonicaliser drift.** `canonicalOwners` exists in TS and PHP; divergence would offer combinations the server rejects. Mitigated by shared test vectors in both suites (WP-C1 and WP-S2 each include the same owner cases) and by the structural check on read.
8. **Validation on read bricks on a server bug.** A bad write path would turn every read into 503 until an operator fixes it. Intentional (fail closed) and covered by write-side tests.
9. **Cascade delete.** `deleteList` is irreversible; guarded by `confirm`, a two-press UI with the item count; backups of the data directory are the recovery.
10. **Many lanes on a phone.** With two overlays the Day phone has up to 4 lanes (9 characters each); text clips with an ellipsis, rows never grow. If that is not acceptable, lower `maxOverlays` to 1 on narrow screens.
11. **Done rows and the cap.** Open-only counting lets a day hold many completed rows; they stay in the To-do list, crossed out and stacked at the bottom, and the list scrolls inside itself beyond the 13 lines (9.8).
12. **Prefs last-write-wins.** A second device may overwrite the selection chosen on the first; it is a preference, applied at next load.
13. **Colors across themes.** Enforced only by the AA test of the formula; sage and the yellow hue are likeliest to need per-theme tuning of tint percentages.
14. **Deploy.** New PHP files must remain flat in `server/lib`; `tools/test-deploy.sh` fixtures use three files but are unaffected. `limits.php` is generated and committed; `caps` JSON is not used.
15. **Immutable files.** `parse.ts`, `app/theme.ts`, `atomic.php`, `atomic-test.php`, `build.rs`, `heavy-lock.sh`, `tdtp.sh` are not touched by any package; core never imports from `app/`.
16. **Unapproved interactions.** Drag, press-and-hold and Alt+Arrow wait for the owner. The handles are MUST because of his 2026-10-30 note.
17. **No tombstones** for add retries (5.4).

## 15. Questions for the owner

See the structured list returned with this spec. Defaults chosen so work can proceed: Both color per person with the household setting as the default (2026-11-09), linked priority text 18 (decided 2026-11-09), open-only to-do cap, at most 2 overlays, minimum event length 15 (30 until 2026-11-01).

### 9.3a The phone's schedule choices (2026-11-10)

On a phone the AM/PM switch and the CalMind button are not in the Day any more: the menu behind the hamburger (Sidebar.ts, `#day-tools`, shown by Shell from `DayPanel.phoneTab()` = schedule on the Day, not the Chores view) holds a segmented AM | PM item and a CalMind events switch. `ScheduleSection.setHalf/half` are the same state the desktop switch uses (a module variable, the page opens on AM); the CalMind choice is `state.setCalmindHidden`, saved per account as before. The lane header carries `.day-corner` (AM or PM) over the hour labels on a phone and the section heading reads "Schedule, AM|PM" for screen readers. `#menu` stays beside Back. Tests: `day-menu-phone.spec.ts`, `day-menu.spec.ts`; `showHalf` in helpers opens the menu on a phone. `day-menu.spec.ts` also pins the desktop timed grid to origin/main's boxes (c342c818, 1280x800: timeline 363,141,395x509, lanes 397,146,361x498) on days with no all-day events, AM and PM, CalMind shown and hidden; a day with all-day events moves the grid down by the strip's 25px only (4.1b). Screenshots at 390x844 and 1280x800 (AM, PM, CalMind on and off, menu open, a day with all-day events) were looked at for consistency with the menu's other items on 2026-11-10.
