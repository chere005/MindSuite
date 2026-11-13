# ReadMind, in full

**This is a personal project to have some fun with claude code, which generated essentially all of the code, and the rest of this readme:**

[README.md](README.md) is the front door and says what ReadMind is in a
paragraph. This file is everything else: what is in the tree, how the login
works, what is on disk, how the three instances deploy, how a release goes out,
and — where it matters — why it was built that way rather than the obvious
other way. It is written for agents and humans both; nothing here is a rule you
must follow, that is [AGENTS.md](AGENTS.md)'s job, and where the two ever
disagree AGENTS.md wins.

## Where it came from

ReadMind is a clone of seancheren-site's original reading page for the partner, made on 2026-08-23 —
The owner: "make a clone of the original page that uses calmind logins and call the new
repo ReadMind". It differs from its parent in exactly two ways: anyone with a
CalMind account may sign in rather than the partner alone, and the sign-in is CalMind's,
so this repo holds no accounts at all. Books and notes are per user, so each
account gets its own shelf.

The clone owes nothing to its parent. The original page stays the partner's, on the site's
login, untouched; a fix worth both places is copied by hand and said so in the
commit. The two-press delete and the rich-text helpers were copied from the
site's lib on day one, so if those rot apart, that is drift worth a look.

## The tree

Web only, deliberately: there is no iOS or Android cousin here and no shared
core package. One page renders everything and one lib backs it.

    public/index.php     the whole UI — shelves, book page, notes, themes, all of it
    public/icon-*.png    the touch/app icons the page links
    lib/app.php          config, instance detection, the CalMind-backed login,
                         the settings window, two-press delete, keep-edit-mode
    lib/store.php        encrypted-at-rest JSON: store_read() / store_write()
    lib/richtext.php     the note-body allowlist sanitiser and its toolbar
    lib/hitlog.php       one line per request, host-wide (CoreMind canon's copy)
    tools/test.php       the whole test run: lint, store, the mocked login
    tools/dtp.sh         deploy, tag, push
    tools/tdtp.sh        the same lane with the full test run in front
    deploy.sh            one-way rsync onto the three instances
    deploy.conf          HOST=… , gitignored; deploy.conf.sample is the template
    data/                local dev data, gitignored, never synced

There is no package manager, no build step and no generated file anywhere in
it: what you edit is what runs.

## The login is CalMind's

This app has no account store, no signup flow and no password to hash, on
purpose. A username and password are proven by POSTing CalMind's own `login`
action — the same call every CalMind client makes — and the session keeps only
the verdict. The token that comes back is dropped at the door: this app talks
to no API afterwards, so holding a credential it never uses would be pure
liability.

Two consequences worth knowing before you debug a sign-in:

- **CalMind going down takes sign-IN down and nothing else.** The token is
  checked at login, not per request, so an open session keeps working. Equally,
  a sign-in needs that instance's CalMind reachable — the app can be perfectly
  fine and the login still refuse, for a reason that is not in this repo.
- **Each instance signs in against its own CalMind** (prod → seancheren.com,
  test → test., dev → dev.), and the session cookie is per instance
  (`BMSESS`, `BMSESS_TEST`, `BMSESS_DEV`). A sandbox login can never be a
  production one, and being signed into production says nothing about the
  sandboxes.

Password work belongs in CalMind, and the settings window says so instead of
offering a password form. One account system for the suite is the goal — the owner,
2026-08-23: "really core should be providing authentication for all apps".
Until core does, CalMind's API is the nearest thing to it, and `lib/app.php` is
the single file where that switch happens.

## Three instances, one source tree

`bm_instance()` decides which instance a request is from the same three signals
seancheren-site's pages use: the directory the code runs from, the request path,
and the subdomain the rewrite serves. Production is the empty string; `test` and
`dev` are the sandboxes. The base path and data directory are derived from the
instance. Which CalMind API answers logins can be overridden per server process
with `READMIND_CALMIND_API_URL`; if unset, each instance keeps using its matching
CalMind host. This app has no secrets of its own.

The instance split rides seancheren-site's `.htaccess`: the `test.` and `dev.`
subdomains rewrite into `/test/` and `/dev/`, so ReadMind only has to BE there.

## What is on disk

All app data goes through `store_read()` / `store_write()`, one JSON file per
user per kind, in the instance's data directory:

    books-<user>.json       the book cards, in manual order
    booknotes-<user>.json   a map of bookId => that book's notes and sections
    prefs-<user>.json       per-user preferences (the bookshelf theme lives here)

The username is squeezed to `[A-Za-z0-9_-]` for the filename, the same contract
the site uses. A book card written here carries `id`, `title`, `author`,
`cover` (an Open Library cover id), `key`, `rating`, `read_at`, `want`, `past`,
`created` and `updated`, and picks up `cover_url` when someone sets a cover by
hand. A rating IS "read": `read_at` is set when a rating is first given. Two
more fields are read but never written by this app — `isbn`, used as the last
fallback for a cover, and `folders`, the Goodreads shelves a book was imported
with — so they exist only on data that arrived from the parent bookshelf. A
note carries `id`, `title`, `body` (sanitised HTML), `created` and `updated`;
an entry with `type: section` is a header rather than a note, and one flagged
`chapter` lives in the book's separate chapters view. Deleting a book takes its
notes with it.

**Encrypted at rest, and only that.** Files are written as AES-256-CBC
ciphertext behind an `ENC1:` prefix so raw JSON is not sitting in plaintext on
disk, and reads transparently accept both encrypted files and legacy plaintext,
so existing data keeps working and re-encrypts on the next write. This is BASIC
protection: the key lives beside the data (config `data_key`, or an
auto-generated `.datakey` in the data directory). It is good enough to stop
casual reading of other people's files; real per-user security comes later.

## What the page does

`public/index.php` is the whole UI and every mutation is a CSRF-checked
POST → redirect → GET. The shelves are Library, Read and Want-to-read, plus a
Data tab that counts books read this month, read this year, wanted, and held.
Inside Library, a book's Goodreads shelves become folders. Each shelf can be
sorted (by stars, title, author, added, rated or edited) and filtered by
rating.

Books are found through the Open Library search API — an accepted Goodreads
source for covers and book data — and only matches that HAVE a cover are
offered, because that feature is about picking a cover from thumbnails. For
display, a hand-picked cover URL wins (that is what "Set cover" is for), then
the Open Library cover id, then the ISBN; a locally cached WebP under
`public/covers/` is preferred over any of them when it exists.

Notes are rich text. Bodies used to be plain text in a `<textarea>` and are now
a small subset of HTML edited in a contenteditable, mirrored into a hidden
input so the existing autosave POST did not have to change; a tagless body is
still detected and escaped. The body is rendered as HTML rather than escaped,
which makes `rt_sanitize()` the whole security story — it allowlists the tags
and drops every attribute except the app's own `rt-*` classes. Never store a
body that has not been through it.

Three interaction rules are shared with the rest of the suite and live in
`lib/app.php` so they cannot drift per page:

- **Two-press delete** instead of a `confirm()` box or an Undo button. The
  first press arms the control (it fills red), the second goes through, arming
  expires after a few seconds, and only one control is ever armed, so a stray
  tap cannot leave a landmine off screen. The press also posts a `confirm`
  field, and destructive handlers refuse without it, so a stale or broken page
  cannot delete anything on a single tap.
- **Edit mode is a gesture, never a redirect.** A form submitted while editing
  carries an `edit` flag, and the server echoes it back but never originates it
  — the only ways in are the long-press and the double-click. A handler that
  appended `edit=1` on its own once meant a swipe-delete, made from outside
  edit mode on purpose, dumped you into it.
- **The settings window is the suite's shell** with the parts that cannot be
  true here cut out: no password form, and no suite theme row.

**Themes are this app's own.** The suite's five themes swap the accent and
nothing else; ReadMind's eight repaint the whole page, so the suite's base
layer would only paint variables the next rule overwrites — `theme_css()` is
deliberately empty rather than removed, so a future diff against the parent
bookshelf stays readable. "Midnight" is the original look and the default.
Every theme's accent, muted text and gold clear roughly 4.5:1 on that theme's
background, and the rating stars, the error red and the quote purple stay
literal, because like the suite's reminder/event/note colours they say what a
thing IS, not which theme you like. The picker repaints in place and posts in
the background rather than reloading, because reloading closed the settings
window on every pick.

## Hit logging

`lib/hitlog.php` is CoreMind canon's file, copied into this repo as it is into
CalMind's and AcctMind's server libs, so every app logs the same shape into one
host-wide file (`/home/protected/logs/hits.log`); the `app` and `instance`
fields keep them apart. The owner, 2026-08-22: "show how many hits to the site in
the last hour, 12 hours, and 3 days .. make sure logging is a core mechanism
that all apps and sites inherit". A line holds the time, the instance, a coarse
app name, the method, the user and whether the caller was an agent — and no IP,
path, query string, referer or user agent, because the difference between "how
busy is this" and "who went where" is the whole reason to write the narrower
thing. Agent traffic gets its own `claudio` lane so a session of shell probes
does not read as visitors. The status page's own probes and live polls announce
themselves and are skipped, or the page would mostly be counting itself. The
file rotates once at 4 MB, and a write that fails is never fatal.

Two behaviours surprise people: the log piggybacks a background status sweep on
ordinary traffic instead of a scheduler, so an idle site quietly stops probing
itself; and locally, where `/home/protected` does not exist, the log follows
`app_config()`'s data directory — which is how a test run avoids writing into
the repo's own `data/`.

## Testing

    php tools/test.php

No framework, all or nothing, the same shape as the site's. It lints every PHP
file, round-trips the store (asserting the file on disk really starts with
`ENC1:`), and then proves this side of the login conversation — the right
action POSTed, `ok`+token believed, anything else refused — against a MOCK
CalMind, so no network and no real account are involved. The mock exists
precisely so this repo's own half can be tested when a real CalMind is not
reachable. Every check here was watched failing first (wrong password, missing
token, dead API); that is the baseline rule, and a check that cannot fail looks
exactly like one that passes.

Two things the harness learned the hard way:

- **A killed run leaves servers behind.** The harness boots the mock CalMind on
  8797 and the app on 8796 and cleans up after itself, but kill it mid-flight
  and those two survive. The NEXT run then fails to bind, and the tests report
  `the gate shows (missing: Sign in…)`, which reads as a broken login and is a
  busy port. Check `lsof -ti tcp:8796` before believing it.
- **The children's output goes to `/dev/null`, not to this process's stdout.**
  A child holding the harness's stdout keeps every pipe and log file open after
  it exits, and the release lane hung on exactly that — a release waiting for
  ever on two mock servers nobody needed any more.

## Deploying

    ./deploy.sh              # TEST only — the safe default, suite-wide
    ./deploy.sh prod
    ./deploy.sh all          # prod + test + dev
    ./deploy.sh --dry-run    # say what would happen, change nothing

It needs a `deploy.conf` with `HOST` set (copy `deploy.conf.sample`); the file
is gitignored. The script lints every PHP file first, then rsyncs `public/` and
`lib/` into the instance's two directories on the seancheren.com host:

    prod   /home/public/ReadMind        lib -> /home/protected/readmind-lib
    test   /home/public/test/ReadMind   lib -> /home/protected/readmind-lib-test
    dev    /home/public/dev/ReadMind    lib -> /home/protected/readmind-lib-dev

`lib/` sits under `/home/protected` so it is not servable; `public/index.php`
finds it by trying the local tree first and the host path second. Data
directories (`readmind-data`, `-test`, `-dev`) are created web-writable —
`chgrp web`, mode 2770 — and are never synced and never deleted; the deploy
only makes sure they exist and that both users can reach them.

- **Nothing is deleted, ever.** macOS ships openrsync and the host runs rsync,
  and with `--delete-excluded` the transfer hangs at zero CPU, for ever, with
  no error — ten silent minutes, twice, before it was found. The flag set is
  the site deploy's proven `-rLptzv`, verbatim, and stale files are removed by
  hand the day one exists.
- **`BatchMode=yes` matters on its own**, so an ssh that wants to ask a
  question fails instead of waiting. The first deploy hung ten silent minutes
  on exactly that.

## Releases: the dtp / tdtp lane

    ./tools/dtp.sh       # deploy, tag, push
    ./tools/tdtp.sh      # the same, with the full test run in front

The owner, 2026-08-23: "tdtp all apps and sites" — the apps each carried a lane and
this repo carried none, so a suite-wide release always left it to be deployed
by hand and untagged. The lane is the suite's gesture, in order: refuse a
branch that is not `main`; refuse uncommitted TRACKED changes (untracked
scratch must not block a release the way an unstaged edit must); `git pull
--autostash` and refuse again if the pull left the tree dirty, because a
conflicted autostash pop exits 0; on `--full`, run `php tools/test.php` and
stop on any failure; bump the MINOR version; `./deploy.sh all`; tag and
`push --atomic --follow-tags`, deleting the local tag again if the push is
rejected; and report to seancheren.com/status through CoreMind's
`bin/report-status.sh`, which is never fatal, because a status page must not
stop a release.

**The tag IS the version here** — there is no version file. Tags are bare
`x.y.0`, never `v`-prefixed, and the newest one is the counter; if HEAD is
already tagged, the lane refuses rather than shipping the same tree twice. A
bump whose deploy failed is reused on the re-run rather than burning a number.
There are no devices and no desktop build in this lane: what the apps spend on
platform builds, this one spends on deploying three instances.
