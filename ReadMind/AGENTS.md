# Working on ReadMind

The baseline for all of the owner's repos lives in ~/GIT/AgentSuite/AGENTS.md
and is imported here; this file holds only what is true of THIS repo.
@../../AgentSuite/AGENTS.md

## Rules

- Web only: `public/index.php` renders everything, `lib/app.php` is the whole lib. This file wins over `ARCHITECTURE.md` on conflict.
- **No accounts here.** Login = POST CalMind's own `login` action, keep only the verdict; never store, hash or see a password; drop the token. Password work belongs in CalMind.
- Each instance signs in against its own CalMind (prod → seancheren.com, test → test., dev → dev.).
- The partner's original page stays untouched; a fix worth both places is copied by hand and said so in the commit. Two-press delete + rich-text helpers were copied from the site's lib; watch for drift.

## Commands

```
php -S 127.0.0.1:8795 -t public     # the app; sign-in needs a reachable CalMind
php tools/test.php                  # lint, store round-trip, login against a MOCK CalMind
./deploy.sh | prod | all            # rsync to seancheren.com subpath /ReadMind; readmind-data* never synced
```

- Release lanes `tools/dtp.sh` / `tdtp.sh`; the tag is the version (no version file). npm-free, build-free.

## Traps

- "gate shows (missing: Sign in…)" in tests → killed run left the mock CalMind (8797) / app (8796) bound → `lsof -ti tcp:8796` (and 8797), kill. Harness sends children's output to `/dev/null` and reaps them; keep it so.
- openrsync hangs forever at zero CPU on `--delete-excluded` → use `-rLptzv -e "ssh -o BatchMode=yes"` and delete nothing; BatchMode so ssh fails instead of prompting.
- Sign-in refused while the app is fine → that instance's CalMind is unreachable; test the repo's half with the mock.
