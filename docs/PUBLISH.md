# Publishing MindSuite

The public repository is a NEW GitHub repository whose whole history is one root commit with a neutral identity. The
current private repository is renamed `MindSuite-history`, stays private, and is never made public or force-pushed.
Nothing here deploys an app. Commands run from the root of the clean checkout unless a step says otherwise.

`[agent]` steps are local, scripted and rehearsed by `sh tools/publish/test-publish.sh`. `[owner]` steps need the
owner's GitHub login or a secret only the owner holds; the `gh` lines are the owner's commands and were not run by the
rehearsal. Placeholders: `OWNER` is the GitHub handle (the publisher identity, allowed by decision), `W` a scratch
directory outside every repository.

## Never

- `git push --mirror`, `--all` or `--tags` from any MindSuite checkout, to any remote.
- Pushing `main`, a work branch, an old tag or a `<App>/legacy/<version>` marker tag to the public remote.
- Making `MindSuite-history` or any `<App>-legacy` repository public.
- A commit made with this machine's identity after the root exists (step 9).

## 1. Preconditions `[agent]`

All of these must hold on `main` before the root is made. `squash-reroot.sh` itself checks only the strict marker, the
versions its tags claim, and that the identity and messages are name-free; the rest is yours to run.

```
sh CoreMind/bin/check-names.sh tree            # 0, strict (CoreMind/bin/names-strict is committed)
sh CoreMind/bin/check-names.sh literals        # 0
sh CoreMind/bin/check-personal-data.sh         # "N value(s) ..., N digest(s) ..., 0 finding(s)" with N > 0 for both
test -f CoreMind/bin/names-strict              # the strict flip is committed
sh tools/preflight.sh                          # green; then the full suite once, logs under ~/GIT/mono-evidence/N7/
python3 ~/GIT/AgentSuite/tools/check-workflows.py .   # "5 workflow(s) follow the quiet-CI contract"
git remote                                     # prints nothing: the checkout has no remote yet
```

The version files must already be at the last release shipped before this repository existed (section "Version sync"),
because the root's markers are checked against them.

## 2. Local files that are not in git and must be on the publishing machine

Without them the scans cannot run, and they exit 2 (nothing is claimed) rather than pass.

| File | Used by | If it is missing |
| --- | --- | --- |
| `CoreMind/.local/personal-data.sha256` (in the checkout that runs the scan, or the main checkout a worktree hangs off) | `check-personal-data.sh`, `public-scan.sh` | copy it; it is never committed (a tracked digest list is a dictionary oracle) |
| `~/Library/Application Support/MindSuite/needle-allow.sha256` | `check-names.sh` | copy it: it holds the allowlist lines (lockfile integrity hashes, the domain token, copyright and author lines) that keep the scan at zero |
| `~/Library/Application Support/MindSuite/needles.txt` (mode 600) | `check-names.sh` | rebuild: `sh CoreMind/bin/needles-init.sh` |
| `.local-scrub-rules-usernames.txt` and `.local-scrub-rules.txt` in the old checkout root (or `MIND_SCRUB_DIR`) | `needles-init.sh` | copy them BEFORE the old checkout is deleted: the needle list cannot be rebuilt without them |
| `<App>/.local/machine.env` for AcctMind, CalMind, ChefMind, PlanMind, TaskMind, and each app's `deploy.conf` (CalMind: `server/deploy.conf`) | `check-personal-data.sh` compares every tracked byte with their values | copy them from the old checkout; the clean checkout has none, so its machine-value rule reads 0 values until they are there |
| `.private-targets` (optional) | the lanes | only if private lane targets are used |

Check: `sh CoreMind/bin/check-personal-data.sh` must print `... compared, N digest(s) from 1 local hash list(s), 0 finding(s)`
with the first N above zero.

## 3. Make the root `[agent]`

The clean repository's own history (the commits since its first root) exists nowhere else: the renamed old repository
holds the older history only. Keep a bundle of it before the root replaces `main`:

```
mkdir -p "$HOME/MindSuiteMigrationBackup/$(date +%F)"
git bundle create "$HOME/MindSuiteMigrationBackup/$(date +%F)/MindSuite-clean-pre-publish.bundle" --all
```

```
sh tools/publish/squash-reroot.sh \
  --marker AcctMind/0.62.0 --marker CalMind/1.62.0 --marker ChefMind/1.39.0 --marker CoreMind/1.32.0 \
  --marker PlanMind/0.28.0 --marker ReadMind/0.5.0 --marker TaskMind/0.1.0 \
  --export "$W/export.git"
```

The versions above are the ones the tree must carry; the script refuses a marker that differs (CalMind: all four files
the Release workflow compares must agree). It writes:

- branch `public-main`: one commit, no parent, the tree of `main` byte for byte, author, committer and tagger
  `MindSuite <noreply@users.noreply.github.com>` (override with `PUBLISH_NAME` / `PUBLISH_EMAIL`; the email must be a
  noreply address and must differ from this machine's git identity), UTC timestamp, message
  `MindSuite: initial public commit`. The global and system git config are switched off for every call that makes an
  object, so the machine's identity, signing key and hooks never reach it.
- the identity and messages are checked with `check-names.sh message` first; no needle list means exit 2 and nothing is created.
- one local annotated marker tag `<App>/legacy/<version>` per `--marker`. The release lanes read it as "this version is
  taken" (they bump past it; ReadMind derives its next version from it). The Release workflows' tag filters
  (`<App>/<x.y.z>*`) do not match it, and it is never exported or pushed.
- no old tag is carried: the seed tags `<App>/<version>` point into the old history and stay behind. `--tag APP/X.Y.Z`
  would add a real release tag on the root, which starts that app's Release workflow when pushed; the default is none,
  because each app's lane creates the tag of its first release.
- `--export DIR`: a bare repository holding exactly what step 5 pushes: `refs/heads/main` and any `--tag` tags.
- the N7 acceptance, locally: one commit, same tree, no parent, neutral lines.

It refuses to run in a repository that has a remote, and a rehearsal on a scratch clone passes `--rehearsal` to accept a
tree that has no `names-strict` marker yet (never publish that root).

## 4. Scan what would be pushed `[agent]`

```
sh tools/publish/public-scan.sh --from "$W/export.git" --expect-commits 1
```

Exit 0 and `RESULT: clean in every class` are required. Counts only; `--list` adds the checkers' masked file:line lines.
Classes: `refs` (any ref but `refs/heads/main`), `shape`, `identity` (name and email of every author, committer and
tagger), `history` (every commit message, ref name, tag object, path name and blob), `tree` and `literals` at HEAD, and
`personal` (check-personal-data over every blob). It always uses the checkers of this checkout, in strict mode.

## 5. GitHub, owner only `[owner]`

Rename first: creating a repository under a name that was renamed away replaces GitHub's redirect from the old name.

```
gh repo rename MindSuite-history --repo OWNER/MindSuite --yes     # stays private
gh repo view OWNER/MindSuite-history --json visibility -q .visibility          # PRIVATE
gh repo create OWNER/MindSuite --private                           # no README, licence, .gitignore or template
gh repo view OWNER/MindSuite --json visibility,defaultBranchRef -q .visibility # PRIVATE
```

Actions secrets and variables do not move. The Release workflows (`acctmind-release.yml`, `calmind-release.yml`,
`chefmind-release.yml`, macOS job) read these repository secrets, and nothing else (no variables, no environments;
`GITHUB_TOKEN` is automatic). Names only; each value comes from the owner's Apple developer account or keychain and is
entered at the prompt, never on a command line, in a file or in a chat:

```
gh secret set APPLE_CERTIFICATE            --repo OWNER/MindSuite
gh secret set APPLE_CERTIFICATE_PASSWORD   --repo OWNER/MindSuite
gh secret set APPLE_SIGNING_IDENTITY       --repo OWNER/MindSuite
gh secret set APPLE_ID                     --repo OWNER/MindSuite
gh secret set APPLE_NOTARIZATION_PASSWORD  --repo OWNER/MindSuite
gh secret set APPLE_TEAM_ID                --repo OWNER/MindSuite
gh secret list --repo OWNER/MindSuite      # the six names
```

## 6. First push `[agent]`, after step 5

The release lanes push to a remote named `origin` (`git push --atomic origin main refs/tags/<tag>`, `tools/gh-bot.sh`,
`tools/preflight.sh`), so the new repository is `origin` from the start.

```
git remote add origin https://github.com/OWNER/MindSuite.git
git config --add mindsuite.publicRemote origin
git push origin public-main:refs/heads/main
```

The pre-push hook (`tools/githooks/pre-push`) runs first because the remote is listed as public: AgentSuite's workflow
check, then `check-names.sh history public-main` over the whole ancestry with no skip when the needle list is missing,
and it refuses any remote ref outside the patterns in "Lanes and the public remote". Exactly one ref, one commit, no
tag is pushed.

## 7. Scan the pushed mirror while it is still private `[owner]` then `[agent]`

```
gh repo clone OWNER/MindSuite "$W/pub" -- --mirror
sh tools/publish/public-scan.sh --mirror "$W/pub" --expect-commits 1       # RESULT: clean in every class
git -C "$W/pub" for-each-ref --format='%(refname)'                          # exactly: refs/heads/main
gh api 'repos/OWNER/MindSuite/commits?per_page=5' -q length                 # 1
```

GitHub-side text (counts only, through the same checker):

```
{ gh api repos/OWNER/MindSuite --jq '.description, (.topics | join(" ")), .homepage'
  gh label list --repo OWNER/MindSuite --json name,description --jq '.[] | .name, .description'
  gh api repos/OWNER/MindSuite/releases --paginate --jq '.[] | .name, .tag_name, .body, (.assets[].name)'
  gh api 'repos/OWNER/MindSuite/issues?state=all&per_page=100' --paginate --jq '.[] | .title, .body'
  gh api repos/OWNER/MindSuite/actions/workflows --jq '.workflows[].name'
  gh api 'repos/OWNER/MindSuite/actions/runs?per_page=100' --jq '.workflow_runs[].display_title'
} > "$W/meta.txt"
sh CoreMind/bin/check-names.sh message "$W/meta.txt"                        # 0 hit(s)
```

## 8. Flip public and scan as a stranger `[owner]` then `[agent]`

```
gh repo edit OWNER/MindSuite --visibility public --accept-visibility-change-consequences
sh tools/publish/public-scan.sh --url https://github.com/OWNER/MindSuite.git --expect-commits 1
curl -fsS https://github.com/OWNER/MindSuite -o "$W/page.html"
curl -fsS https://raw.githubusercontent.com/OWNER/MindSuite/main/README.md -o "$W/readme.md"
sh CoreMind/bin/check-names.sh message "$W/page.html"                       # 0 hit(s)
sh CoreMind/bin/check-names.sh message "$W/readme.md"                       # 0 hit(s)
```

`--url` is an anonymous https clone (no credentials, no user git config); it exits 2 if the repository is still private.
Delete `$W` afterwards: it holds a copy of the repository.

## 9. After publication `[agent]`

```
OLD=$(git rev-parse main)
git checkout main && git status --short            # prints nothing
git reset --hard public-main                       # same tree, so only history changes: main is the public root
git rebase --onto public-main "$OLD" <branch>      # for every branch that must survive (git worktree list)
git config user.name MindSuite
git config user.email noreply@users.noreply.github.com
```

Every commit is public. Set the repository-local identity above (or another neutral one, and pass its pattern to
`public-scan.sh --allow-identity`) before the first new commit; the checkout's own git identity is a real name.

Before the first lane run after publication, read "Lanes and the public remote" below.

## Which Actions runs the pushes start

The five workflows trigger only on `push` of a tag `AcctMind|CalMind|ChefMind/<x.y.z>*` and on `workflow_dispatch`
(`planmind-native.yml` and `taskmind-native.yml`: dispatch only). So:

- The first push (`refs/heads/main`) starts no run at all.
- A release tag push starts that app's Release workflow. The run the person triggers has one job, `handoff`, which
  re-dispatches the workflow as `github-actions[bot]` with `GITHUB_TOKEN` and finishes in about ten seconds; every real
  job runs only in the bot's run. GitHub mails the outcome of a run to whoever triggered it, so a failed, cancelled or
  timed-out build mails nobody, and every job is `continue-on-error`. `python3 ~/GIT/AgentSuite/tools/check-workflows.py .`
  enforces it, and the pre-push hook runs it.
- Never `gh run rerun` (the re-run is the person's, so its bot-only jobs skip); re-dispatch with
  `gh workflow run <file> --ref <ref> -f ...`.
- The secrets of step 5 must exist before the first tag. Dry run without publishing anything:
  `gh workflow run calmind-release.yml --repo OWNER/MindSuite --ref main -f preflight=true`. Runs on a private repository
  spend billed minutes (macOS counts ten times); on a public one they are free, so do the dry run after step 8.

## Lanes and the public remote

For a remote listed in `mindsuite.publicRemote`, `tools/githooks/pre-push` accepts exactly these remote refs and
refuses everything else (fail closed):

| Ref | Who pushes it |
| --- | --- |
| `refs/heads/main` | step 6, and every lane (`git push --atomic origin main refs/tags/<tag>`) |
| `refs/tags/<App>/<x.y.z>`, App one of AcctMind, CalMind, ChefMind, CoreMind, PlanMind, ReadMind, TaskMind | the app's lane (three numeric parts, nothing after them) |
| `refs/heads/preflight/<acctmind\|calmind\|chefmind>/<sha>` (7 to 40 hex digits) | that app's `tools/preflight.sh`, which also deletes it |

A `<App>/legacy/<version>` marker, any other branch or tag, an old-style tag (`v1.2.3`, `<app>-v1.2.3`, a two-part
version) and the deletion of anything but a preflight branch are refused. Every pushed object still gets a
full-ancestry `check-names.sh history` scan, and a missing needle list refuses the push instead of skipping it.
`sh tools/publish/test-publish.sh` proves the allowed and refused cases. The old `mindsuite.publicRef` list is no
longer read.

## Version sync

The lanes decide the next version from the tags in the repository. The new repository has none: the lanes of AcctMind,
ChefMind, CalMind and CoreMind REUSE a version that is not tagged, PlanMind and TaskMind tag the version in
`package.json` (and refuse one that is already tagged), and ReadMind (version = newest tag) would start at 0.1.0. They all read `<App>/legacy/<version>` as
"taken", which is why step 3 makes the markers. They only work if the files carry what was actually shipped:

| App | Where the version lives | In the tree | Shipped before this repository | Needed first |
| --- | --- | --- | --- | --- |
| AcctMind | `package.json` | 0.62.0 | 0.62.0 | marker only |
| CalMind | `apps/app/app.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/Cargo.lock`, `package-lock.json` | 1.62.0 | 1.60.0, 1.61.0 and 1.62.0 | marker only (the six files were bumped from 1.59.0 to 1.62.0 by the commit below); the lane's first release is 1.63.0 |
| ChefMind | `package.json` | 1.39.0 | 1.39.0 | marker only |
| CoreMind | `package.json` | 1.32.0 | 1.32.0 | marker only |
| PlanMind | `package.json` | 0.28.0 | 0.28.0 | marker only |
| ReadMind | none: the newest tag | 0.5.0 | 0.5.0 | marker only |
| TaskMind | `package.json` | 0.1.0 | 0.1.0 | marker only |

The CalMind bump was the lane's own substitution, six lines in six files (the same shape as the old `CalMind 1.60.0`
commit), committed before step 3 ("CalMind: version files at 1.62.0"); for the record:

```
cd CalMind
for F in apps/app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
  perl -i -pe 's|"version": "1\.59\.0"|"version": "1.62.0"|' "$F"; done
perl -i -pe 's|^version = "1\.59\.0"|version = "1.62.0"|' desktop/src-tauri/Cargo.toml
perl -0pi -e 's/(name = "calmind-desktop"\nversion = ")1\.59\.0(")/${1}1.62.0${2}/' desktop/src-tauri/Cargo.lock
node tools/sync-lock-versions.mjs          # package-lock.json: 1 line (packages["desktop"])
git diff --stat                            # 6 files changed, 6 insertions(+), 6 deletions(-)
```

The content of the old `CalMind 1.60.0` (the iOS title-field fix), `1.61.0` and `1.62.0` (the mail work and the
address-independent caps) is already in the clean tree; nothing else shipped from the old repository after the seed. The site (a separate repository) released
0.58.0 and 0.59.0 in the same window; its `tools/mindsuite-canon.sha256` pins equal this tree's canon files, and its
canon-equality test reads the canon from `COREMIND_DIR`, which must point at the shared server package once the canon
directory is gone.
