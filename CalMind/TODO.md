# TODO — what is still owed

`ARCHITECTURE.md` is the map (`README.md` is the short front door in front of
it), `TESTING.md` is what the tests are worth, `PARITY.md` is the ledger of
what shipped. This is the live list, highest first.
Standing rules live in `CLAUDE.md`, not here.

Compressed 2026-08-19 (1,400 → this), on the owner's word: "cut any old dead
stuff out." The full pre-compression file, with every resolved entry's
history, is the parent of the compressing commit — `git show 7eefa6c:TODO.md`
— and the closed stories live in PARITY.md and the commit log.

**Every compression of this file has tried to lose an open item — three for
three.** The 2026-08-10 rewrite dropped five (recovered 08-12) and the
device-profile expiry with them; the 08-12 compression dropped the
login-throttling decision; and the loss-check before THIS one caught the
store-pruning note, dropped 08-10 and missed by the 08-12 recovery — two
generations lost, found only because the check runs against the OLDEST
file, not the previous one. An item sitting in the wrong section is what a
compression deletes, because compressing is done by section. So the check
is the second half of the job, not optional housekeeping:

```sh
git show 29686f2:TODO.md | grep -n "^\s*- \[ \]"   # the oldest full file
git show 7eefa6c:TODO.md                            # the newest full file
```

Verify every unchecked hit against the source before trusting a compressed
file, and run this as part of ANY future compression.

## Suite counts, as of this commit

core **1039** · app **241** · gesture **337** (+3 skipped: two live specs and the opt-in benchmark) · WebKit **26** · server **85** ·
live **19** with the API · desktop **7** (+3 and the 11 Rust cases of `desktop/test-signin.sh` in `npm run test:desktop`) · deploy guards **15** · plus the four
native seam checkers no browser can reach: `npm run test:watch`,
`npm run test:widget`, `npm run test:deploy`.

`npm run test:counts` checks this line against the suites, so it cannot
drift silently; `live` needs the deployed server and is the one figure still
on trust. ARCHITECTURE.md points here rather than carrying its own numbers.
`npm run test:dev` is the between-runs mini-suite (typechecks, core, server,
counts — ~40s, no browser).

## 1 · Parked on the owner

Each is blocked on his word, not on work.

- **Google OAuth sign-in** needs a Google Cloud project. Read-only Google
  calendar imports now use secret/public iCal links without that setup;
  CalDAV discovery and read-only imports are implemented too. OAuth account
  sign-in and remote write-back remain separate work.

- **E2EE envelopes** (P2, 2026-08-19 — "lets discuss e2ee and larger notes
  later"). Design settled, build gated: X25519 + Argon2id-wrapped private
  key, per-container content keys, per-recipient wraps, passkey unwrap via
  WebAuthn PRF, recovery codes required. Changes the password-recovery
  contract, so it does not start until he says go. Today the server
  encrypts payloads at rest and holds the key, which is not the same
  promise.

- **Larger notes, with images** (P2, same word). Not a bigger cap — the
  shape cannot carry it: client and server are both O(whole store) per
  operation, and one 200KB photo inlined base64 costs the snapshot the same
  room as ~187 long recipes, re-serialised on every save, re-sent on every
  sync, on every device, for ever. Ten of them is the entire ~5MB web
  budget. What it needs instead: content-addressed blobs OUTSIDE the record
  set, references in records, upload/download off the sync path, lazy
  fetch + cache, a collection rule, ENC1 at rest — and probably IndexedDB
  on the web. Its own design pass, WITH him, before any code. (The 64KB
  record cap question folds into this conversation.)

- **Meeting-request mail is wired and OFF unless `mail_enabled` is true**
  (`server/lib/mail.php`). Answers (accept, decline, new time) and the
  owner's new-request notice both go from the detached worker
  (`lib/mail-worker.php`), never inline; a host that cannot start it sends
  nothing and logs NOT SENT. Both log to `meetreq-mail.log`; recovery codes
  go the same way. Abuse limits: recover is throttled
  (60 s and 3/hour per username, 3/hour per address, 10/hour per IP) and
  mails from a detached worker (`lib/mail-worker.php`; the host runs PHP as
  CGI, so "after the reply" is impossible and an inline send would be a
  username-timing oracle); meetreq_mail is for the request-page owner only, to an address
  on one of his requests (never a sign-up address: unverified), with
  `when` a strict date + clock time, 30/hour per account, 60/hour per IP and
  3/hour per destination address. The per-IP rules are a speed bump (the
  host lets a client choose its address): `docs/api.md` "Abuse caps" lists the
  address-independent site-wide and per-account caps beside them. The pending-requests badge is
  drawn (`meetreqBadgeCount`, account button and Requests row, web and native); the owner's
  notice is mailed to the configured owner's account address (only that account) (slot only) under the create caps. No OS app-icon badge.

## 2 · Open bugs

Nothing known right now. Before believing a new intermittent WebKit failure,
read the note-focus flake's twelve-occurrence history first
(`git show 7eefa6c:TODO.md`, §2) — it died of a design decision on
2026-08-18, and two rate claims about it were made and retracted on the way.

## 3 · Deliberate non-fixes, recorded so nobody reopens them as gaps

- **Nothing PRUNES the store.** A deleted record keeps its payload as a
  tombstone forever, so deleting a long note frees nothing. Dropping the
  payload on delete looks obvious and is not — the shared-write scope check
  reads the STORED payload, so a null one may refuse a legitimate write.
  Left alone deliberately rather than optimised into a sharing bug.
  (Written 2026-08-09; dropped by the 08-10 rewrite; recovered 08-19 by
  this compression's own loss-check.)
- **Two devices editing from the same starting point** resolve by whichever
  clock is higher, not by who was actually later. Inherent to wall-clock
  LWW; only a server-assigned receipt time would change it, a
  protocol-sized change. The owner's call if it ever shows up in practice —
  `clockdrift.test.ts` pins that the ALARMING cases (stickiness, an
  hour-fast clock beating a later edit) do not exist.
- **`clear_done` stays unported** ("bless hiding", 2026-08-18): the ☑
  toggle is the answer; the suite's clear-completed footer is deliberately
  not wanted.
- **The circular complication shows a bare time for an event days away**
  ("a bare 5 is ok", 2026-08-18). `whenShort` stays; check-watch-format
  pins it.
- **A bare 'COUNT SIZE NOUN' line ('1 2kg whole chicken') still scales
  wrong** ('2 4 kg'). Recognising it means calling every such line a count
  of sized items — a guess about lines that are not in the owner's recipes,
  re-verified against every ingredient line in them 2026-08-19: the shape
  appears in none. Pinned as current behaviour in `tinsize.test.ts`. New
  evidence in a card of his is a question for him, not a green light.
- **Ingredient names keep their adjectives** ('large free range egg' is
  what the thing is called) and **'chili' pluralises to 'chilis'** (real
  English, nothing broken). The pluralisation-through-adjectives bug itself
  was fixed 2026-08-19.
- **Reminders and events will never notify.** The owner, 2026-08-20: "i don't
  want notifications for reminders or events." Not a gap, not deferred, and
  not a thing to re-propose — it was suggested as the biggest functional
  hole in the app and answered directly. This is a calendar you LOOK at:
  the widget, the complication and the day panel are the surfaces, which is
  why they get the care they do. Note the scope — it is reminders and
  events. The MEETING-REQUEST notification is separate (§1) and
  stays on its own switch (`mail_enabled`); its badge shipped 2026-08-20.
- **Three suggested features, answered no** (the owner, 2026-08-21): a global
  search — there already is one; **scaling a recipe by servings** — not
  wanted; a **habits widget/complication** — "the widget and complication
  are already sufficient". Recorded because all three read as obvious gaps
  from the code and are not.
- **The native toast eats one tap at worst** while showing (its window
  dismisses on first touch). The cost of "always on top" on a surface where
  nothing else draws over a Modal; the web keeps full click-through.

## 4 · Steady state, every iteration

- `git pull --autostash` first; stage explicit paths; never `git add -A`.
  Two sessions share this repo.
- **Web first, always**: deploy the web before any device build. Two lanes
  since 2026-08-20, and both mean PROD since 2026-08-21 ("dtp should be prod
  now generally"): **dtp** = `./server/deploy.sh prod test --yes-prod
  --quick` (seconds-cost gates plus a spot test; his word: "even if it means
  some things could occasionally break"), then tag and push; **tdtp** = the
  same command without `--quick`, so every suite runs. One gesture each
  since 2026-08-22: `npm run dtp` / `npm run tdtp` (tools/dtp.sh bumps the
  minor, deploys, tags vx.y.0, pushes, the tag push starts the Release workflow). Test ships in the
  same command rather than in a second run — the gates are what cost the
  time, and they run once for both. `deploy-test.sh` still exists and is
  still test-only; nothing routine uses it now. A failed deploy in either lane gets fixed BEFORE tagging and
  pushing, never tagged around. Both lanes run `tools/preflight.sh` (the Release builds on this
  commit, no publish) BEFORE the tag, then watch the Release workflow the tag
  push starts. Windows stays
  untested by hand on his word: "i just want it to stay up to date."
- Keep every suite in the counts above green, including the native four.
  `npm run test:dev` between runs; the deploy runs the browser gates
  itself. Never two Playwright runs on one port (the deploy's shards each
  have their own: 8790, 8793, 8794).
- Before trusting a new check, break the thing it guards and watch it go
  red.
- Confirm live test == local dist by comparing `index.html` to
  `index.html` — `dist` holds more than one `index-*.js`.
- Keep `PARITY.md` honest; act on the owner's steering the moment it arrives.
- **Free-team profiles expire every 7 days** (current ones run to
  2026-08-26). A rebuild only renews AFTER expiry — installing early buys
  nothing — and renewal needs the Apple ID session in Xcode (it has been
  lost once: "No Accounts"). A renewal DROPPED the watch from its own
  profile once (0xe8008012): check `ProvisionedDevices` in the embedded
  profile before blaming the tunnel.
- **The watch is installed DIRECTLY, always** — `devicectl device install`
  of `CalMind.app/Watch/CalMindWatch.app` to the watch UDID over Wi-Fi;
  the companion path has never once worked here. Retry loops must log the
  MESSAGE, not the code: tunnel noise (4000, 1011, 3002, NWError 60,
  RemotePairingError 1001) is patience; "device was still locked" (10003 /
  1016) needs the owner's wrist and retrying never fixes it. Prove any install
  by asking the device: `devicectl device info apps`.
- **A device build eats gigabytes of derived data** — delete the previous
  `apps/app/ios/build/dd<N>` once an install lands. Three of them filled
  the disk once, and a full disk kills every shell command including the
  cleanup. Bump `ios.buildNumber` in app.json AND
  `CURRENT_PROJECT_VERSION` (8 places in the pbxproj) or the install is
  unprovable.

## 5 · Back burner — recipes

- OCR keeps improving pattern-wise: pull name + quantity + unit where a
  pattern is visible. Imperfect text is fine (the user fixes it); junk
  non-letter characters are not — `scrubLine()` in
  `packages/mind-core/src/recipe.ts` is the gate (this repo's
  copy is a one-line @mind/core stub): extend it there and propagate.
- Keep `recipe-incnotes` honored on every save path if the editor grows
  new ones.
- **His recipes' layout, settled 2026-08-19**: both sets stay — originals
  raw in Recipes·General (never touched; the recipe FLAG is what un-dressed
  them), curated copies flagged `recipe: true` in Recipe Form. The empty
  "Aug 18, 2026 at 5:50pm" note stays on his word. Don't reopen these as
  anomalies.
