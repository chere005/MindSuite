# Legacy sign-in limits

PlanMind keeps its own sign-in form only while the suite's shared sign-in (`/account/` on the site) is off for the instance; when it is
on, nothing here runs. This is the limiter behind the legacy form (`server/lib/login_limit.php`, called from `pm_login()`).

## Why the address is not enough

On NearlyFreeSpeech.NET `REMOTE_ADDR` is the right-most entry of the `X-Forwarded-For` the client sent, and the front end adds none
(rehearsal B2, recorded in seancheren-site `docs/MINDSUITE-LOGIN.md`, "Decision: address-keyed limits on NearlyFreeSpeech"). A
limit keyed on that address is keyed on text the client picks per request: a new header value is a fresh bucket. The
per-address limit stays, as a speed bump against a careless client, and nothing relies on it.

## The limits

| Limit | Keyed on | Number | Window | When full |
| --- | --- | --- | --- | --- |
| Per address (speed bump) | the right-most forwarded address, hashed | 10 failures | 15 minutes from the first | `429` "Too many attempts", before anything else is looked at |
| Per account | the submitted name (first 128 bytes), trimmed and lower-cased, whether or not it exists | 10 failures | 1 hour from the first | the answer of a wrong password |
| App-wide | nothing | 100 failures | 1 hour from the first | the answer of a wrong password |

- **Fixed windows.** A window opens at its first counted failure and ends an hour (15 minutes for the address) later; further failures
  do not move its end. When it ends the count starts again.
- **Only failures count.** A sign-in spends a slot before the password is checked (so racing requests cannot overshoot) and gives it back
  if the password was right.
- **Same answer.** A full account or app cap never says so: the credentials are not checked, one decoy bcrypt verification is run so the
  attempt costs what a checked failure costs, and the caller gets the answer of a wrong password (the form's "Unable to sign in with
  those details", status 200). The key is the name that was typed, existing or not, so a full cap tells a stranger nothing about
  which names exist. The one visibly different answer is the per-address `429`, which depends on the address alone.
- **Fail closed.** The caps live in `login-caps.json` beside the encrypted stores in the data directory (plain JSON, mode 0600: keyed
  hashes of names, counts and window ends; the key is derived from the store's key, so a name, or a password typed into the name field,
  cannot be guessed back from the file). It is changed under an exclusive lock on `.login-caps.lock`, opened `c+` (NFS emulates
  `flock` with byte-range locks), and written through the atomic-write helper. A file that is missing is empty; one that cannot be read,
  parsed to exactly this shape, locked or written fails the attempt as unavailable (503): nobody is signed in and nothing is reset.
- **Bounded.** The file holds at most one entry per failure of the last two hours' windows (about 200 at these numbers); entries whose
  window has ended are dropped at the next write.

## The price: denial of service

The caps stop guessing without naming an address, so they can be spent by anyone:

- Anyone who knows or guesses a name can hold that account's sign-in shut for up to an hour with ten wrong passwords, and again when the
  window ends. The right password is refused too while a cap is full.
- Anyone can hold the whole app's sign-in shut for up to an hour with a hundred wrong passwords (spread over names and addresses at will).
- The person locked out sees the ordinary "Unable to sign in" and cannot tell a cap from a typo. A browser already signed in is not
  affected: sessions are not checked against the caps.

The numbers leave a household room to mistype a few times an hour and keep guessing slow: at most 10 guesses an hour per
account (240 a day) and 100 an hour overall (2,400 a day), against bcrypt-hashed passwords. They match the shared sign-in's email reset
limits (ten wrong codes per name and a hundred site-wide an hour). Without the caps the number of guesses was bounded only by bcrypt's
cost. The alternative that avoids the denial of service is the shared sign-in, which replaces this form.

**The way out.** Wait: every window ends by itself, at most an hour after its first failure. Or, as the operator, delete
`login-caps.json` from the app's data directory (as the web user, which owns it); a missing file is an empty
ledger. Nothing else needs resetting.

## Tests

`server/tools/cases/login.php` (area `login`): the numbers; one account from any number of forged addresses; unknown names; spelling
variants; the right password's slot given back; fixed and expired windows; the app cap and pruning; the address limit still refusing
first and spending no slot; timing of a declined attempt against a checked failure; the ledger holding hashes only and private;
damaged, wrong-shaped, unreadable, unlockable and unwritable ledgers failing closed without being reset; the `c+` lock; 25 racing
processes sharing exactly ten slots; and the real `bootstrap.php`'s `pm_login()` end to end.
