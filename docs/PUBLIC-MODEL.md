# The public model: CalMind and MealMind for strangers

CalMind and MealMind target the App Store first and Google Play next, with sync on the suite server. Database storage, public accounts and account-optional mode default to off. The table records the status of each part and the final section gives the switch-over order.

## The model in one paragraph

The apps work with **no account**: records live on the device. **Signing in is optional** and only syncs and shares. Strangers get **public accounts** that live in their own database tables, which nothing but the CalMind API reads; one public account works in CalMind and MealMind (as household accounts do) and can never sign in to the site, PlanMind, TaskMind or AcctMind. Records move from **one encrypted JSON file per user per app** (read and rewritten whole on every sync) to **one database row per record**, so a sync costs what changed, not the size of the whole store.

## Status

| Area | Status | Switch | Where |
| --- | --- | --- | --- |
| Records storage seam (`rs_tx` / `rs_view`) | **Built** (JSON driver uses the existing files by default) | — | `CalMind/server/lib/records.php` |
| Database driver for records (SQLite / MySQL) | **Built, off** | `storage` => `'sql'`, `storage_dsn`, `storage_user`, `storage_pass` in `config.php` (or `CALMIND_STORAGE`, `CALMIND_STORAGE_DSN`) | same |
| JSON → database migration, verified per store | **Built** (dry run by default; never touches the JSON files) | run by hand | `CalMind/server/tools/records-migrate.php` |
| Public accounts (sign-up, sign-in, lock, change password, delete, caps) | **Built, off** | `public_accounts` => true (or `CALMIND_PUBLIC_ACCOUNTS=1`) | `CalMind/server/lib/public-accounts.php` |
| Per-account recipe-import limit | **Built**, only while public accounts are on | same | `handle_recipe_fetch` |
| No-account local mode in both apps | **Built, off** | build with `EXPO_PUBLIC_ACCOUNT_OPTIONAL=1` | `apps/app/src/accountmode.ts`, `store.tsx`; merge in `packages/mind-core/src/localmerge.ts` |
| iOS permission strings, export compliance | **Built** (app.json); takes effect at the next *regenerated* prebuild | — | `CalMind/apps/app/app.json`, `MealMind/app/app.json` |
| Store upload lanes | **Stub**: print the plan; `--really` exits 2 | — | `tools/store/` |
| Listing, privacy label, Play checklist, privacy policy | **Draft** | — | `docs/store/` |
| Public sign-up screen in the apps | **Not built** | — | see "Apps" |
| Email verification, reset by email, passkeys for public accounts | **Not built** (those actions answer 501) | — | see "Server" |
| Per-account storage quota | **Not built** | — | see "Server" |
| CalMind reading MealMind's recipes with no account (App Group) | **Not built** (TODO in `store.tsx`) | — | see "Apps" |
| Android photo OCR (ML Kit) | **Not built** | — | see "Android" |

Two server changes are live on the next CalMind deploy, because they fix or trim today's behaviour rather than switch anything:

- **A sync that changes nothing no longer rewrites the store.** Every device polls every 30 seconds; each poll used to decrypt, re-encrypt and rename the whole file. Clients cannot tell the difference.
- **A collision is closed.** CalMind's store of a user named `chef-<name>` was the same file as `<name>`'s MealMind store (`records-chef-<name>.json`), and both names were legal, so such an account could read and overwrite another person's recipes. Sign-up now refuses names that begin `<space>-`, and the storage layer refuses them for CalMind's space. The database driver keys space and owner apart and never had it.

## Server

### Records

- `rs_tx($cfg, $user, $space, fn(RecordSet))` is one serialised read-modify-write; `rs_view()` reads. The merge rules (validation, the tie-break, share scope) did not move: they run the same over either driver. `npm run test:server:sql` runs every API suite on the database; `tools/records-test.php` proves the seam on both drivers (sequence, rollback, sealing, real-process concurrency, JSON → database identity).
- **Database layout:** `rs_records (space, owner, id, type, updated, deleted, superseded, seq, payload)` keyed `(space, owner, id)`, indexed `(space, owner, seq)`; `rs_heads (space, owner, seq)` is each store's counter and the row a writer locks.
- **Encryption at rest:** payloads are sealed per row with AES-256-GCM, the key derived from the instance's existing data key, bound to space/owner/id so a row moved under another name refuses to open. The clear metadata (id, type, timestamps, seq) sits in columns, as the merge already requires; in the JSON files it was inside the encrypted blob. That is the one confidentiality difference: someone holding the database sees how many records of which type each user has, and when they changed, not what they say.
- **Which database on the host.** NearlyFreeSpeech offers a managed MySQL/MariaDB process (a separate, billed process; check the current price in the member panel). SQLite needs no process, but its locking over the host's storage is not guaranteed and WAL mode needs shared memory on one machine, so the driver keeps SQLite's rollback journal. Recommendation: SQLite on the TEST instance to prove the switch, MariaDB for production before strangers arrive. SQLite also serialises all writers across all users (one database lock); MariaDB locks per store.
- **Backups:** the JSON files are copied by whatever copies the data dir today; a database needs its own dump on a schedule (NFSN scheduled task) and a tested restore.

### Accounts

- **Why a separate store.** Household accounts are the suite's (`auth.json` on the site): one sign-in that also opens the site and the other apps. Opening that sign-up would give every stranger a key to all of them, and a bug in any one app's check would become a door into the rest. Public accounts live in `pa_accounts` / `pa_tokens` in the same database as the records and are read only by this API. The alternative (one suite store, moved to a database, with per-app scopes on every account) is cleaner on paper and needs every suite app and the site to enforce the scope correctly; it is a later option, not a prerequisite.
- **Names** are one namespace with the records (records are keyed by username). Public sign-up refuses names held by a legacy or suite account; public sign-in is refused if the suite has since created the same name (only the operator can, by invite).
- **Built:** sign-up with site-wide hourly/daily caps and a per-address bump; sign-in with a lock after ten failures that answers the same for a right and a wrong password; change password (signs out other devices); delete (account, every token, every space's records, the name in partners' share settings — the same purge legacy deletion runs). Public and household accounts can share with each other by name, mutually, as today.
- **Not built:**
  - **Email verification at sign-up.** Without it an address is unproven, so reset by email would mail strangers. Build: a pending state plus a code mailed through the existing mail worker.
  - **Password reset by email** for public accounts (`recover`/`reset` answer 501 for them).
  - **Passkeys** for public accounts (501).
  - **Storage quota per account.** A refusal needs a new reject reason in `spec/protocol.json` and client handling, so it is a protocol change, not a server-only one.
- **Household deletion.** In shared-sign-in mode CalMind refuses `delete_account` (403: a suite account is deleted on the site, not by one app). App Store guideline 5.1.1(v) requires deletion inside the app for accounts *created in the app*; public accounts have it; household accounts are not created in the store build. Confirm this reading before submission.
- **Meeting requests** are the configured owner's only; a public account can neither own a request page nor send its mail (501).

### Not changed, and why

- The suite store (`auth.json`) is still read on every shared-sign-in request and rewritten on each sign-in. Fine for a household; public accounts never touch it.
- Abuse counters and caps stay small JSON files (pruned hourly).

## Apps (CalMind and MealMind)

- **No-account local mode** (`EXPO_PUBLIC_ACCOUNT_OPTIONAL=1`): opens straight into a device-only store under `<prefix>.snapshot.~local@<instance>` (`~` is outside the username alphabet), no network at all; Settings and Login offer "Sign in to sync and share" and back. Signing in merges the local records into the account (core `localmerge.ts`: starter folders fold into the account's own, local settings only fill gaps), writes the merged snapshot, and only then removes the local key; any failure leaves the local copy. Signing out returns to an empty local store. Flag off, the apps behave exactly as before (proven by the existing sign-in/sign-out end-to-end specs).
- **Known edges (TODO in code):** CalMind shows no MealMind recipes in local mode (an App Group read would fix it); the second starter fold is held in memory, so an app closed between sign-in and the first sync can keep a duplicate starter (data kept, not lost); a second browser tab still in local mode can write the local key back; on the web, the shared sign-in redirect comes back to local mode and needs one more tap.
- **Not built: public sign-up in the apps.** The Login screen must send `public: true` on sign-up in a public build and use its own form rather than the suite's `/account/app/` page; `signin_info` needs to tell a public build which to show. Small, but it decides what strangers see first.
- **Not built: on-device sharing between CalMind and MealMind** with no account (App Group `group.com.seancheren.calmind` exists for the widget; MealMind would join it).
- **Check after a real prebuild:** Expo's config introspection shows `NSAllowsArbitraryLoads: true`; confirm what the release Info.plist carries and remove it if present. Review `PrivacyInfo.xcprivacy` required-reason entries. The lanes reuse the generated `ios/` projects, so the app.json changes need a regenerated prebuild.

## Android

- Same code and the same server. Gaps: photo OCR has no Android path (ML Kit text recognition module), no committed `android/` (prebuild generates it), Play account and its 12-tester, 14-day closed test, a web page for deletion requests (Play requires one in addition to in-app deletion). `docs/store/google-play.md`.

## Owner decisions and inputs (not code)

- Names in each store (an unrelated "MealMind - AI Recipe Generator" exists on the App Store).
- Privacy policy contact, support URL, where the policy is hosted.
- App Store Connect API key (for `tools/store/ios-upload.sh`), Play developer account and service-account key.
- Whether production records move to MariaDB (a billed process) and when.

## Switching over, in order (when decided)

1. **TEST instance, records:** back up the data dir; `records-migrate.php --data-dir <test data> --dsn <dsn>` (dry run), then `--apply`; set `storage` => `'sql'` in TEST's `config.php`; run the live suite against TEST. The JSON files stay as the fallback: setting `storage` back to `'json'` returns to them (writes made meanwhile would need copying back; the tool's reverse direction is not built).
2. **Production, records:** the same, after a backup and a quiet window, against the production database.
3. **TEST, public accounts:** `public_accounts` => true; build the apps with `EXPO_PUBLIC_ACCOUNT_OPTIONAL=1` and the public sign-up screen; TestFlight.
4. **Store:** finish the upload lanes, listings and policy; submit.
