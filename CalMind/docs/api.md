# The CalMind sync API

The one HTTP surface every CalMind client talks to. This is the reference;
[ARCHITECTURE.md's "The sync model"](../ARCHITECTURE.md#the-sync-model) is the
one-paragraph version, and [`spec/protocol.json`](../spec/protocol.json) is
the machine-checked contract both the server and every client core assert
against — where a value appears in both places, that file is the source of
truth and this page is describing it.

MyCalMind speaks none of this (it has no server); ChefMind speaks all of it,
against these same accounts, kept apart by a sync **space**.

## Shape

One endpoint, one method. Actions are posted in the body rather than mapped to
REST paths, so the whole API is a single file behind any web server with no
rewrite rules.

```
POST <base>/api/index.php
Content-Type: application/json
Authorization: Bearer <64 hex>        # only where the action needs a user

{ "action": "<name>", ... }
```

- **CORS is open** and auth is the bearer token, never a cookie — a foreign
  origin holds nothing. `OPTIONS` → `204`; any non-`POST` → `405`; a body that
  is not JSON → `400`.
- **Every reply is JSON.** Success is `{ "ok": true, ... }`; failure is
  `{ "ok": false, "error": "<message>" }` with a matching HTTP status. Even an
  uncaught throw is turned into that shape, so a client never has to parse raw
  PHP.

`<base>` is the instance:

| Instance | Base |
| --- | --- |
| prod | `https://seancheren.com/CalMind` |
| test | `https://test.seancheren.com/CalMind` |
| dev  | `https://dev.seancheren.com/CalMind` |

Each instance has its own accounts and its own store; a token from one is not
valid at another. Clients pick the base in `apps/app/src/config.ts`.

## Auth

A **bearer token** is 64 hex characters, issued by `signup` and `login`, stored
only as its SHA-256 hash. Send it as `Authorization: Bearer <token>` on every
action that needs a user. `change_password` and `reset` **revoke every token**
the user holds. Passwords are `password_hash()` only — nothing recoverable is
stored.

Five wrong passwords lock an account (`429`), on a lengthening ladder (5m, then
10m, …) that holds against the *right* password too; an unknown username never
locks, because locking it would confirm the name exists.

Passkeys (WebAuthn, hand-rolled — the host has no composer) are the
`passkey_*` actions; a passkey signs in without a username and yields the same
kind of token.

### Shared sign-in (dual mode)

The suite's shared sign-in (the site repo's `docs/MINDSUITE-LOGIN.md`) is loaded
in-process from the instance's own site lib (`/home/protected/lib`, `lib-test`,
`lib-dev`, derived from where `server/lib` is deployed; config `calmind_site_lib`
overrides it, `''` keeps the instance legacy). CalMind never copies the library.

- **Legacy** — everything above, unchanged — while the site lib is missing or
  older than the entry points CalMind calls, the instance is not in
  `mindsuite_auth_instances`, or `calmind` is in `mindsuite_auth_hold[instance]`
  (a malformed hold holds every app). Holds are read on every request: rollback
  is `set-auth-hold <instance> calmind`, config only.
  A request whose body names `space: 'chef'` (ChefMind sends it on every
  action) follows `chefmind` instead, but only on the space-scoped, sign-in
  and identity actions (`SUITE_SPACE_ACTIONS` in `server/lib/app.php`:
  `sync`, `shared_*`, `recipe_fetch`, `login`, `logout`, `whoami`, `signup`,
  `recover`, `reset`, `change_password`, `passkey_login_*`, `passkey_list`);
  every other action (`delete_account`, `passkey_register_*`,
  `passkey_remove`, `meetreq_*`, `calsub_*`) follows `calmind` whatever the
  body says: `chefmind` held keeps it legacy while
  `calmind` is not, and `calmind` held does not hold it back. Its tokens keep
  scope `calmind` (one API, one set of accounts; imported ChefMind tokens are
  `calmind` rows), so the scope rule below is the same for both spaces.
  CalMind's own read-only pull of the `chef` space follows `chefmind` too:
  while the two holds differ that pull is refused and stays quiet (the last
  copy of the recipes stands, nobody is signed out) until they agree.
- **Shared** — otherwise. The shared store is the only door: `accounts.json` and
  `tokens.json` are never consulted for sign-in, so a legacy token gets `401`.
  - `login`, `signup`, `reset`, `change_password` and passkey sign-in return a
    bearer token whose session has scope `calmind`: valid for this API (and
    ChefMind's `chef` space through it), refused by every other suite app and as
    a browser cookie. A full-account or other-scope bearer is refused here
    (`401 bad token`). Imported legacy tokens (`tokens=1`) are such sessions.
  - The same-origin web build may use the suite cookie instead: refused when
    `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` is foreign, and
    every action but `whoami` needs `X-CSRF-Token`. `whoami` on a cookie returns
    `{ username, csrf }`.
  - Every auth error carries `shared: true` (the web build sends the person to
    `/account/?next=`). A switched-on instance whose store, key or site config
    cannot be read answers `503 sign-in unavailable`, never legacy.
  - The reply shapes and the `429` wait label are the legacy ones. The lock is the
    library's: a per-address speed bump keyed by the site's `mss_client_address`
    (no client-supplied `X-Forwarded-For` is believed) and the account-wide lock.
  - `signup` closes with `mindsuite_signup_closed` (in **both** modes, so the
    import runs on closed stores); a name that is still a legacy CalMind account,
    in any case, is never signed up to someone new.
  - `recover`/`reset`: the address is the shared store's (`msa_account_email`);
    limits and the code store are the legacy ones, keyed on the canonical
    (lowercase) name; a code remembers which mode issued it and only works in
    that mode; a good reset calls `msa_reset_password` (every session revoked,
    scoped ones too) and returns a fresh token. The legacy password is untouched.
  - `change_password` is refused (`403`, `shared: true`) for a `calmind`
    token and a cookie alike: a scoped token is not an account credential
    (MINDSUITE-LOGIN.md), so the password changes at `/account/`. Nothing
    changes and no session is revoked.
  - Passkeys: a `calmind` token may not register (`403`) or remove (`404`) one
    and lists none; a cookie session uses the library's ceremonies. A passkey
    sign-in's session is narrowed to scope `calmind` before its token leaves.
  - `delete_account` is refused (`403`): nothing deletes a suite account.
  - Settings (both apps) shows neither form in shared mode: a cookie session,
    or a `403` with `shared: true` to either action, swaps them for one
    "Manage your account" action that opens the suite's `/account/` (web: the
    same tab, `?next=` this page's path; native and desktop: the instance's
    `/account/` in the system browser). That page offers change password, sign
    out, sign out everywhere, passkeys and email reset; it has no account
    deletion.

The **web build** (`apps/app/src/api.ts`, `screens/Login.tsx`; ChefMind's copy is the same) follows the server's mode:

- **Who decides:** the server. A page served from the API's own origin (not native, not the desktop shell, not metro)
  asks `whoami` with no token when it has no session. A `200` with `username` and `csrf` is the suite cookie: use it. A
  `401` with `shared: true` sends the browser to `/account/?next=<this page's path>` (path only: no origin, query or
  fragment; a fixture served under `/test` or `/dev` keeps that prefix). Any other answer (a legacy `401`, no answer at
  all) leaves the form as it was. There is no sign-in form in shared mode, and the form re-checks before it signs in, so a
  failed check at load cannot put a bearer token in a browser against a server that is shared.
- **The session** is `{ token: 'cookie:<username>', username, serverUrl }`. That string is a stand-in, never a credential:
  no request carries it and no `Authorization` header is sent. It names the person so a cookie that changed under the page
  (another tab signed in as somebody else) is noticed: the next call answers `401` and the page signs out locally instead
  of writing one account's records into another's.
- **CSRF:** every action but `whoami` carries `X-CSRF-Token`, the secret `whoami` returned, held in memory only. One
  `403 csrf` (another tab replaced the session) learns the secret again and retries once; a second is an error.
- **Loop guard:** a tab remembers (`sessionStorage`) that it sent the person to `/account/`, and a good session clears
  it. While it remembers: no second automatic redirect within five seconds, nor when the page was reached from this
  origin's `/account/` (the referrer) within ten minutes, which is the account page sending them back to an API that
  still refuses; nor when `sessionStorage` cannot say. The card then offers a "Sign in" button, and a person who presses
  it is not a loop.
- **Log out** (`logout` with the cookie session) revokes the browser's session and clears the cookie; the next check waits
  for it, so the old cookie cannot sign the person straight back in.
- **Native, the desktop shell and every build off the API's origin** keep the bearer login and its reply shapes unchanged.

Tests: `server/tools/shared-login-test.php` (every mode),
`contract-test.php --shared`, and the shared case in `abuse-test.php`; each
reads the site lib from `CALMIND_SITE_LIB_TEST` (default: a `seancheren-site`
checkout beside this repository's).

## Actions

| Action | Auth | Purpose |
| --- | --- | --- |
| `signup` | — | Create an account → `{ token, username }`. |
| `login` | — | `{ username, password }` → `{ token, username }`. |
| `logout` | Bearer | Revoke the calling token. |
| `whoami` | Bearer | `{ username }` for the token. |
| `change_password` | Bearer | Set a new password; revokes all tokens. Shared sign-in: `403`, change it at `/account/`. |
| `recover` | — | Email a 6-digit reset code (15 min, 5 tries; hashed at rest). Always `{ok:true}`; 60 s and 3/h per username, 3/h per address, 10/h per IP (a speed bump), plus the address-independent caps below; mail sent by a detached worker (never inside the request: the host is CGI). |
| `reset` | — | Code + new password; revokes all tokens. |
| `passkey_register_begin` / `_finish` | Bearer | Add a passkey. |
| `passkey_login_begin` / `_finish` | — | Sign in with a passkey → `{ token }`. |
| `passkey_list` / `passkey_remove` | Bearer | Manage passkeys. |
| `sync` | Bearer | The record round-trip — see below. |
| `shared_pull` / `shared_put` | Bearer | Read/write the caller's share record. |
| `spaces` | — | `{ spaces: [...] }` — the sync spaces this server knows. |
| `health` | — | `{ mailWorker: "ok"\|"missing" }` — `missing` only when mail is enabled and no usable worker binary exists (set `php_bin` with `tools/server-config.sh`); no paths or config values. |
| `recipe_fetch` | Bearer | Server-side fetch of a recipe URL (address-guarded). |
| `calsub_fetch` | Bearer | Fetch + cache an iCal feed or a read-only CalDAV calendar. |
| `calsub_discover` | Bearer | Discover event calendars from a CalDAV account or collection. |
| `meetreq_slots` | — | Public open/closed slots for the meeting-request page. |
| `meetreq_create` | — | Book a slot (5/h per IP as a speed bump; capped per account and for the site, below). With `mail_enabled`, a request that was written also queues a notice to the configured owner's account address (only when the named account is `meetreq_user`, never another account's unverified sign-up address; slot only, no visitor text) to the detached mail worker; the create caps are its caps. |
| `meetreq_mail` | Bearer | Owner's client mails the booking answer (only an address on one of his requests, never an account's own sign-up address; `when` must be `YYYY-MM-DD h[:mm][am|pm]`; 30/h per account, 60/h per IP, 3/h per address, and a site-wide cap below). With `mail_enabled` the mail is queued to the detached worker and the reply is `sent: "queued"` (`"not-sent"` when the worker cannot start: nothing is sent inline); with mail off it is logged and the reply is `sent: "log-only"`. |
| `meetreq_day` | Bearer | The owner's own day, clashes included. |

`spaces` is public **deliberately**: ChefMind's deploy calls it before it ships,
so a client can never go out in front of an API that would merge its records
into the wrong store.

## Abuse caps (no client address)

On NearlyFreeSpeech `REMOTE_ADDR` is the right-most `X-Forwarded-For` entry the **client** sent, so any limit keyed on it
is a speed bump: a caller picks a fresh bucket per request. The per-IP rules stay (they still stop an honest client that
loops), and `lib/app.php` adds counters that name no address, through `cap_take()`:

| Endpoint | Counter | Cap |
| --- | --- | --- |
| `recover` | whole site, every request, sent or not | 30 an hour, 100 a day |
| `recover` | one username (all strings that are no username share one) | 6 a day (the hourly 3 and 60 s cooldown are `abuse_take`'s) |
| `meetreq_create` | whole site | 30 an hour, 100 a day |
| `meetreq_create` | the account asked about, whether or not it exists | 10 an hour, 30 a day |
| `meetreq_mail` | whole site, counted only for an authorised answer about to go out | 60 an hour, 200 a day |

The per-account and per-destination parts of the mail limits (`u:` and `a:` in `abuse_take`) already named no address and
are unchanged; only their site-wide part was missing.

- **Fixed windows**, aligned to the epoch hour or day: a counter resets when its window ends, so a caller can burst up to
  twice a cap across a boundary. Every counter of one call is checked together; one full counter refuses the call and
  nothing is counted, so a refusal creates no row and the files stay as small as what the caps let through (a flood of
  made-up usernames or addresses cannot grow them, or the per-address tables behind them, past the site-wide cap).
- **Stored** in `data/caps-<endpoint>.json` with `store_write()` (encrypted, atomic rename) under an exclusive lock on
  `data/.caps-<endpoint>.lock`, opened `c+`, never `c` (NFS emulates `flock` with byte-range locks).
- **Fail closed.** The only state read as "no counters yet" is a file that does not exist. A counter file that is
  unreadable, empty, not JSON, encrypted but not JSON, will not decrypt, or holds a row that is not a counter (`e` and `n`
  integers), a file that cannot be written, or a lock that cannot be taken, refuses the request and logs
  `calmind caps <endpoint>: refused …` with the reason to the error log; the file is left as it was. (`store_read()` on
  its own answers `[]` for most of these, which would have granted the request and reset every cap to one.) The refusals
  last until the operator restores the file or deletes `caps-<endpoint>.json`, which resets the counters.
- **Not `abuse_take()`.** That limiter is a sliding hour that keeps a row for every key it is asked about, refused ones
  included (`always`), and has no day window or site-wide key; widening it would change the 1.61.0 rules it serves.
  `cap_take()` is fixed-window and all-or-nothing, and takes its own lock (`c+`; `with_file_lock()` opens `c`).
- **Same answer.** A capped `recover` is `{ok:true}` with no mail, exactly as a throttled one; a capped `meetreq_create` is
  the per-address 429 and words; a capped `meetreq_mail` is the per-account 429 and words. Whether a username exists changes
  nothing in the body, and nothing in the timing `tools/abuse-test.php` can see (it compares bytes and medians).
- **The price.** Anyone can exhaust a cap, and honest callers are then refused until the window ends: 30 `recover` requests
  spend the site's hour, 6 naming one username spend that account's day (whoever knows a username can keep its password from
  being reset by mail for a day), and 10 `meetreq_create` calls aimed at the owner's page close it for the hour. Sign-in,
  passkeys and signed-in devices are untouched, and the operator lifts a cap by deleting `caps-<endpoint>.json`. Only the
  mail cap is out of a stranger's reach: it counts answers an authorised owner is sending, never a stranger's attempts.
  The numbers fit a household's traffic (a handful of calls a day) with room for retries; they are the `RECOVER_*` and
  `MEETREQ_*` constants in `lib/app.php`, to be changed together with this table and the pinned copies in `abuse-test.php`.
- **Not changed:** the sign-in lockout is per username (not an address); `usage.log` records `REMOTE_ADDR` as attribution
  only, and any request can write any address there. `meetreq_mail`'s per-IP rule still adds a row per forged address for a
  signed-in caller's attempts (no cap sits ahead of it, or a stranger's attempts would spend the owner's allowance); that
  table is bounded by the one-hour pruning and by who can sign up, not by a cap.

## Read-only calendar imports

`calsub_fetch` accepts `{ url, source? }`, where `source` is `ical` (the default),
`google`, or `caldav`. Google uses its public or secret iCal feed URL; `webcal://`
is treated as HTTPS. Success returns `{ ok: true, ics, cached }`, with
`stale: true` when a refresh failed and the last good calendar is available.
The server caches feeds for fifteen minutes; clients refresh every twenty
minutes and on foreground. Remote events remain ICS content outside the sync
snapshot and have no remote write path.

For CalDAV, send `{ action: "calsub_discover", url, username, password }` to
receive `{ ok: true, calendars: [{ url, name, color? }] }`. The URL can identify
a server, calendar home or collection. The server follows principal/home
properties and lists collections supporting events. Fetch a selected
collection with `{ action: "calsub_fetch", source: "caldav", url, username,
password }` to receive the same ICS response as a link subscription.

CalDAV uses only `PROPFIND` and `REPORT`. Authenticated requests require HTTPS,
public IP addresses and the same origin throughout discovery and redirects;
the resolved address is pinned for the request. Providers that change hosts
need their direct calendar-home or collection URL. Requests and responses are
bounded in time and size, XML external entities are refused, and partial
failures are errors. CalDAV cache entries are encrypted and separated by
CalMind user, URL and credentials. Credentials are supplied with each request
and kept in the encrypted subscription payload, never in cache filenames.

## Sync

```
POST <base>/api/index.php    Authorization: Bearer <token>
{ "action": "sync", "cursor": N, "changes": [Rec, ...], "space": "chef"? }
  →
{ "ok": true, "cursor": M, "rejected": [id, ...], "rejectedWhy": {id: reason},
  "dropped": K, "changes": [Rec, ...] }
```

- **`cursor`** is a per-user monotonic sequence number. Send the highest you
  have seen; the reply's `changes` is only everything past it (the tail), and
  `M` is the new high-water mark to send next time.
- **`changes`** you send are your locally-dirty records; `changes` you get back
  are everyone-else's edits since your cursor (including your own from another
  device). At most **`MAX_BATCH`** ([`spec/protocol.json`](../spec/protocol.json))
  records per push.
- **`rejected`** lists the ids the server refused, and **`rejectedWhy`** (an
  object, `{}` when empty) gives each one's reason from
  [`spec/protocol.json`](../spec/protocol.json) `rejectReasons`: `bad_id`,
  `bad_type`, `bad_updated`, or `too_large` (a `payload` over `MAX_PAYLOAD`).
  A rejected record stays dirty on the client rather than being silently
  forgotten — the bug that hid was an oversized record dropped while the app
  called itself synced. Only `too_large` is the user's to fix; the app says
  "malformed" for the rest.
- **`dropped`** counts rows that carried no string id (or were not objects),
  so could not be named. Core checks id, type and `updated` before sending, so
  its own rows never land here.
- **`space`** omitted is the default CalMind store; `"chef"` is ChefMind's,
  a separate store (`records-chef-<user>.json`) under the same login. Unknown
  space → `400`.

### A record

```
{ "id": "...", "type": "...", "updated": 1723400000, "deleted": true?, "payload": {...} }
```

| Field | Rule |
| --- | --- |
| `id` | Client-minted, matches `REC_ID_RE` ([`spec/protocol.json`](../spec/protocol.json)). |
| `type` | `^[a-z]{1,20}$` — `folder`, `section`, `reminder`, … (new types need no server change). |
| `updated` | Epoch seconds, `> 0`. The merge clock. |
| `deleted` | Present + truthy is a **tombstone** — deletes propagate as records, never as absence. |
| `payload` | Opaque to the server, stored encrypted at rest (`ENC1:` AES). ≤ `MAX_PAYLOAD` (65536) bytes of JSON. |

A malformed row (bad id/type, non-positive or non-integer `updated`) and an
oversized one are both *rejected* by id, with the reason in `rejectedWhy`, and
the rest of the batch still lands. Nothing is dropped without a word: a row with
no id to name it by is counted in `dropped`.

### Merge

Per-record **last-write-wins on `updated`**. A strictly-newer incoming record
wins. An **equal** `updated` is accepted only when the content actually differs
(the server arbitrates — last edit to arrive wins) and is a no-op when it does
not, so an echo of a record the server already holds never bumps the sequence
and re-broadcasts itself. Order within a list is a fractional `payload.ord` key
**on each record**, never array position — array position cannot survive
per-record merging.

The envelope is clear metadata; the server never reads a `payload`. The E2EE
milestone (client-derived keys, wrapped DEKs, recovery codes) encrypts the
`payload` alone — **the protocol, the server, and the merge rules do not
change**, which is the whole reason they are written down here.

## Where the rules actually live

- **The contract** — record-id shape, max batch: [`spec/protocol.json`](../spec/protocol.json).
  Change a value there and both sides go red.
- **The server** — [`server/lib/app.php`](../server/lib/app.php) behind the thin
  [`server/public/api/index.php`](../server/public/api/index.php).
- **The client** — `packages/core` (the `SyncEngine`) and `apps/app/src/store.tsx`
  (the one stateful seam).

This page is prose *about* those; when it and the code disagree, the code and
`spec/protocol.json` are right.
