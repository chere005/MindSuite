#!/bin/sh
# dtp — deploy, tag, push. The release gesture for MealMind (ChefMind until 1.51.0).
# tdtp — the same lane with the full test run in front: tools/tdtp.sh, which
# calls this with --full. (the owner's shorthand, 2026-08-22: dtp = deploy, tag,
# push; tdtp = test, deploy, tag, push.)
#
# What a run does, in order:
#   0. refuse a tree with uncommitted TRACKED changes — the tag must name
#      exactly what shipped
#   1. (--full only) typecheck + core suite + app suite, before anything is
#      touched, and the content key of the tree they passed on
#   2. bump the MINOR version (x.y.0 → x.(y+1).0) in the five files that move
#      together, and commit the bump — UNLESS the current version is still
#      untagged, which means a previous run bumped and then failed before
#      tagging: that version is reused, not skipped past. Re-running a failed
#      dtp is therefore safe and does not burn a number.
#   3. ./deploy.sh --yes-prod       (the gates live in there; a failed deploy
#                                    stops everything — never tag around one;
#                                    its typecheck and core suite stand down
#                                    only for the very tree step 1 passed)
#   4. the macOS bundle, from the export deploy.sh just shipped — BEFORE the
#      tag, so a broken desktop build leaves the version untagged and a re-run
#      reuses it, exactly as a failed deploy does
#   5. PREFLIGHT, right before the tag: tools/preflight.sh runs the Release
#      workflow's builds (Windows .msi/.exe, macOS dmg, on GitHub) on this very
#      commit, publishing nothing. A failure stops the lane exactly as step 4
#      does: the version stays untagged and a re-run reuses it. Never tag
#      around a failed preflight; --skip-preflight is the deliberate way past.
#   6. tag MealMind/X.Y.0 (namespaced, no v) (annotated; ChefMind/X.Y.0 up to
#      1.51.0, which still count as this app's tags below)
#   7. git push --atomic — the tag push starts the Release
#      workflow (.github/workflows/mealmind-release.yml), which builds the installers
#      and publishes ONE GitHub release for the version
#   8. find the Release run the tag push started and print its URL; a run that
#      cannot be found is reported but does not un-ship the release
#   9. the device builds — iOS on the phone, Android on an emulator — AFTER
#      the push and never fatal TO THE RELEASE, because the release has
#      already happened and an unplugged phone must not un-ship it.
#  10. watch the Release run (it has been running beside the device builds) and
#      report the published release's URL. A Release failure is the same kind
#      of thing as a device build that did not finish: the deploy stands, the
#      tag stands, and the failure is reported loudly with the exact command to
#      run it again (gh workflow run mealmind-release.yml --ref <tag> -f tag=<tag>).
#      The lane still exits non-zero if a device build or the Release did not
#      finish (see the foot of this file): the release stands, the exit status
#      does not lie about it.
#
# THIS REPO SHIPS ITSELF. Steps 4 and 9 were CoreMind's alone until
# 2026-08-23, and the hole that left was invisible from inside either repo: a
# release could tag and push with the Mac bundle still built from whatever was
# lying around. It did — the .app was a day behind and had never heard of the
# Pantry tab. The owner: "This repo should be able to ship itself (and needed
# dependencies) on its own... coremind is to ship all apps simultaneously."
#
# WHICH PLATFORMS: naming one selects only it, naming none means all of them —
# tools/build-platforms.sh's own convention. `--web` is how you say "the
# release and no platform builds".
#
# A dtp bumps the MINOR version — standing rule, every app in the suite.
# ios.buildNumber / android.versionCode are NOT touched here: those move by
# hand per device build.
set -e
cd "$(dirname "$0")/.."
export GH_BOT_TAG_PREFIX=MealMind GH_BOT_WORKFLOW=mealmind-release.yml

FULL=0; PICKED=0; WANT_MAC=0; WANT_IOS=0; WANT_ANDROID=0; SKIP_PREFLIGHT=0
for a in "$@"; do
  case "$a" in
    --full)    FULL=1 ;;
    # Not a platform: it does not count as picking one. Ships without the
    # Release preflight (step 5) — for when GitHub itself is the problem.
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --mac)     WANT_MAC=1;     PICKED=1 ;;
    --ios)     WANT_IOS=1;     PICKED=1 ;;
    --android) WANT_ANDROID=1; PICKED=1 ;;
    # The release on its own — what a bare dtp does anyway; a bare tdtp
    # builds every platform, and this is the way to say none.
    --web)     PICKED=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done
# --full is not a platform: `tdtp` with no other flag means all three, `dtp`
# with no other flag means the web release alone (the owner, 2026-11-02: "dtp needs
# to be significantly faster … make sure tdtp is thorough"). Name a platform
# to build it in a dtp.
[ "$PICKED" = 1 ] || [ "$FULL" = 0 ] || { WANT_MAC=1; WANT_IOS=1; WANT_ANDROID=1; }

# Set below by the --full pass and by nothing else. Inherited from a shell or a
# parent lane, it would tell deploy.sh that checks passed which THIS run never
# ran, so it goes before anything can read it.
unset CHEF_GATES_PASSED

# ---------------------------------------------------------------- the branch
# The push below names main explicitly, so a lane run from any other branch
# would deploy and tag a tree it then does not push — while printing
# "pushed" and exiting 0.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "refusing: this lane ships main, and HEAD is on '$BRANCH'" >&2
  exit 1
fi
# A release the bot could not finish mails nobody (quiet CI), so the lane is
# where it is heard about: say so before shipping another. Never fatal.
sh tools/gh-bot.sh last-release || true

trap 'trap - INT; kill -s INT $$; exit 130' INT
trap 'trap - TERM; kill -s TERM $$; exit 143' TERM

# ------------------------------------------------------- the tree, then a pull
# The dirty check runs FIRST and again AFTER the pull. `git pull --autostash`
# exits 0 even when the autostash pop CONFLICTS — proven, not assumed — so a
# pull that goes first can leave conflict markers in the tree with set -e none
# the wiser, and the lane would deploy them.
refuse_dirty() {
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "refusing: $1" >&2
    git status --porcelain --untracked-files=no | sed 's/^/  /' >&2
    exit 1
  fi
}
refuse_dirty "uncommitted tracked changes — commit your work first, so the tag names exactly what shipped"

if git remote get-url origin >/dev/null 2>&1; then
  git pull --autostash --quiet
  refuse_dirty "the pull left the tree dirty — a conflicted autostash pop exits 0, so this is the check that catches it"
fi

if [ "$FULL" = 1 ]; then
  echo "==> tdtp: the full run, before anything is touched"
  # KEYED BEFORE AND AFTER. deploy.sh runs the same typecheck and core suite
  # again a few seconds from now, on a tree the bump below changes only in
  # version fields that neither tool reads. tools/gate-key.mjs hashes
  # everything the two can read, and deploy.sh stands down only for a tree
  # that still hashes to what passed here. A key taken only AFTER the checks
  # would describe whatever a mid-run save left, not what was checked, so the
  # tree has to hash the same at both ends of the run or nothing is handed on.
  KEY_BEFORE=$(node tools/gate-key.mjs) || KEY_BEFORE=""
  for P in packages/core app; do
    npx tsc --noEmit -p "$P" || { echo "$P typecheck failed — nothing shipped" >&2; exit 1; }
  done
  npm run -s test:core -- --reporter=dot || { echo "core suite failed — nothing shipped" >&2; exit 1; }
  # The app's own suite — the row-drag maths, the one screen logic with
  # tests of its own. No lane path ran it until 2026-10-01; `npm test` did.
  npm run -s test:app -- --reporter=dot || { echo "app suite failed — nothing shipped" >&2; exit 1; }
  # The deploy script's own guards — no lane ran them (2026-11-02).
  npm run -s test:deploy || { echo "deploy-guard check failed — nothing shipped" >&2; exit 1; }
  KEY_AFTER=$(node tools/gate-key.mjs) || KEY_AFTER=""
  if [ -n "$KEY_BEFORE" ] && [ "$KEY_BEFORE" = "$KEY_AFTER" ]; then
    CHEF_GATES_PASSED="$KEY_BEFORE"
    export CHEF_GATES_PASSED
    echo "    passed on tree $(printf '%.12s' "$KEY_BEFORE")… — deploy.sh checks again unless the tree still hashes to that"
  else
    echo "    (the tree changed while they ran, or could not be keyed — deploy.sh runs its own checks)"
  fi
fi

# What the Release workflow builds from, changed since the last tag? Read
# BEFORE the bump commit, which touches the manifests every time. A dtp skips
# the 5–10 minute preflight when the answer is no; tdtp always runs it.
# The app was ChefMind until 1.51.0 (tags ChefMind/x.y.0): with no MealMind/
# tag yet, the last ChefMind/ one is the last release.
LAST_TAG=$(git describe --tags --abbrev=0 --match 'MealMind/[0-9]*.[0-9]*.[0-9]*' 2>/dev/null ||
  git describe --tags --abbrev=0 --match 'ChefMind/[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
RELEASE_INPUTS=1
if [ -n "$LAST_TAG" ] &&
    git diff --quiet "$LAST_TAG" HEAD -- ':(top).github/workflows/mealmind-release.yml' &&
    ! git diff --name-only --relative "$LAST_TAG" HEAD -- . \
      | grep -qE '^desktop/|(^|/)package(-lock)?\.json$|(^|/)Cargo\.(toml|lock)$|(^|/)app\.config\.js$'; then
  RELEASE_INPUTS=0
fi

# ------------------------------------------------------------------ the version
CUR=$(node -p "require('./package.json').version")
# x.y.z, three digit parts, nothing else. The glob this replaces claimed to
# reject anything else and accepted '', '1', '1.2' and '1.2.3.4' — and an
# EMPTY version flowed on into `git rev-parse refs/tags/v` and a tag named `v`.
printf '%s\n' "$CUR" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "package.json version '$CUR' is not x.y.z" >&2; exit 1; }

# A version is this app's whether it shipped as MealMind/ or, up to 1.51.0,
# as ChefMind/ — else the first MealMind run would ship 1.51.0 a second time.
if git show-ref --verify --quiet "refs/tags/MealMind/$CUR" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/$CUR" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/legacy-origin/$CUR" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/legacy/$CUR"; then
  NEW=$(echo "$CUR" | awk -F. '{printf "%d.%d.0", $1, $2+1}')
  echo "==> version: $CUR (tagged) -> $NEW"
else
  # A previous run bumped, then failed before tagging. Ship THAT version
  # rather than burning a number per retry.
  NEW="$CUR"
  echo "==> version: $CUR is still untagged from an earlier run — reusing it"
fi

# A leftover $NEW would make `git tag -a` fail AFTER the deploy has already
# shipped. Checked HERE, while nothing has been touched yet.
TAG="MealMind/$NEW"
if git show-ref --verify --quiet "refs/tags/$TAG" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/$NEW" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/legacy-origin/$NEW" ||
   git show-ref --verify --quiet "refs/tags/ChefMind/legacy/$NEW"; then
  echo "refusing: the tag $NEW already exists — nothing has shipped yet." >&2
  echo "  It is the residue of an interrupted lane: look at it, then delete it" >&2
  echo "  or move the version on." >&2
  exit 1
fi

# The five files that move together (AGENTS.md). Each substitution is
# VERIFIED below — a sed that matches nothing reports success, which is
# AcctMind's hard-learned lesson, not a hypothetical.
if [ "$NEW" != "$CUR" ]; then
  for F in package.json app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
    perl -i -pe "s|\"version\": \"\Q$CUR\E\"|\"version\": \"$NEW\"|" "$F"
  done
  perl -i -pe "s|^version = \"\Q$CUR\E\"|version = \"$NEW\"|" desktop/src-tauri/Cargo.toml
fi
for F in package.json app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
  grep -q "\"version\": \"$NEW\"" "$F" || { echo "guard: $F does not carry $NEW" >&2; exit 1; }
done
grep -q "^version = \"$NEW\"" desktop/src-tauri/Cargo.toml \
  || { echo "guard: Cargo.toml does not carry $NEW" >&2; exit 1; }

# Cargo.lock follows the crate — otherwise the next desktop build dirties it.
if command -v cargo >/dev/null 2>&1; then
  (cd desktop/src-tauri && cargo update -p mealmind-desktop --quiet)
else
  echo "   (no cargo on PATH — Cargo.lock will catch up on the next desktop build)"
fi

# The lock mirrors these version numbers, and npm rewrites it on the next
# install if they disagree — which lands as "uncommitted tracked changes" in
# the NEXT lane, about a file nobody edited. The diff is bounded here because
# a script that rewrites a 300KB lock deserves a check that it changed only
# what it said it would.
echo "==> package-lock.json"
node tools/sync-lock-versions.mjs
LOCKDIFF=$(git diff --numstat -- package-lock.json | awk '{print $1 + $2}')
if [ -n "$LOCKDIFF" ] && [ "$LOCKDIFF" -gt 30 ]; then
  echo "guard: the lock sync changed $LOCKDIFF lines — that is more than version fields" >&2
  git checkout -- package-lock.json
  exit 1
fi

if ! git diff --quiet -- package.json app/app.json desktop/package.json \
    desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock package-lock.json; then
  git commit -q -m "MealMind $NEW" --only -- package.json app/app.json desktop/package.json \
    desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock package-lock.json
  echo "==> committed the bump"
fi

# ------------------------------------------------------------------- the deploy
./deploy.sh --yes-prod

# ------------------------------------------------------------------ the desktop
# It makes its OWN clean export, head patch included, rather than trusting
# whatever is in app/dist by now. See ensure_dist for why the patch matters:
# the Mac bundle had been the one build shipping an unpatched index.html.
if [ "$WANT_MAC" = 1 ]; then
  if ! sh tools/build-platforms.sh --mac; then
    echo "" >&2
    echo "THE WEB SHIPPED, but the macOS bundle failed — so nothing was tagged." >&2
    echo "  Fix it and re-run: the lane reuses ${NEW}, which is the version" >&2
    echo "  already live." >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------- preflight
# The Release workflow's builds, on the commit about to be tagged, BEFORE it is
# tagged: a Windows-only or macOS-runner-only break is found here, with the
# version still untagged and reusable, instead of after a tag has gone out.
# The preflight run publishes nothing and never fails its GitHub run (so no
# failed-job email); tools/preflight.sh reads the jobs and exits 1 on a failure.
if [ "$SKIP_PREFLIGHT" = 1 ]; then
  echo "==> preflight skipped (--skip-preflight)"
elif [ "$FULL" = 0 ] && [ "$RELEASE_INPUTS" = 0 ]; then
  echo "==> preflight: skipped (dtp; nothing the Release builds from changed since $LAST_TAG — tdtp always runs it)"
else
  echo "==> preflight: the Release builds on this commit, before the tag"
  if ! command -v gh >/dev/null 2>&1; then
    echo "" >&2
    echo "THE WEB SHIPPED, but there is no gh CLI to run the Release preflight — so nothing was tagged." >&2
    echo "  Install gh and re-run (the lane reuses ${NEW}), or pass --skip-preflight." >&2
    exit 1
  fi
  if ! sh tools/preflight.sh "$TAG"; then
    echo "" >&2
    echo "THE WEB SHIPPED, but the Release preflight failed — so nothing was tagged." >&2
    echo "  Fix what it names and re-run: the lane reuses ${NEW}, which is the version" >&2
    echo "  already live. (--skip-preflight tags anyway; the Release run then fails on GitHub instead.)" >&2
    exit 1
  fi
fi

# --------------------------------------------------------------- tag, push, CI
git tag -a "$TAG" -m "MealMind $NEW"
# Push only this app's tag. --atomic keeps it from landing if origin/main
# moved under a long deploy and rejects our update.
#
# And if it is neither, the local tag comes straight back off. The version is
# then still untagged, so a re-run REUSES it — which is right, because the
# deploy above already shipped exactly these bytes under that number.
if ! git push --atomic origin main "refs/tags/$TAG"; then
  git tag -d "$TAG" >/dev/null
  echo "" >&2
  echo "THE DEPLOY SHIPPED, but the push was rejected — so nothing was tagged." >&2
  echo "  main has moved on the remote. Pull, then re-run: the lane reuses ${NEW}." >&2
  exit 1
fi
echo "==> pushed, tagged $NEW"

# The tag push started the Release workflow (builds the installers on GitHub's
# Windows and macOS runners and publishes ONE release). Found here so its URL is
# on screen at once; watched at the foot of the lane, after the device builds,
# so a 20-minute CI run does not hold the phone builds up.
RELEASE_FAILED=""
# Quiet CI (AgentSuite/ci.md): the tag push's own run only hands the release to
# github-actions[bot]; the bot's runs build it (and retry a missing platform
# themselves), and nothing they do mails anyone. tools/gh-bot.sh follows them.
if command -v gh >/dev/null 2>&1; then
  echo "==> Release for $NEW handed to github-actions[bot]: $(gh repo view --json url --jq .url 2>/dev/null)/actions/workflows/mealmind-release.yml"
else
  echo "   WARNING: no gh CLI — the Release (installers, GitHub release) is not watched; see the Actions tab" >&2
fi

# ------------------------------------------------------------- the device builds
# After the push, and never fatal TO THE RELEASE. The release is done by here
# — the web is live, the tag is on the remote — so a phone that is not plugged
# in is a thing to be told about, not a failed release to unpick. It is still
# collected and carried to the exit status at the foot of this file; the two
# are different questions and were run together until 2026-08-23.
#
# One at a time, never in parallel: two heavy build/device processes at once
# has caused real failures on this machine twice (AGENTS.md). These two calls
# are sequential by construction; what keeps ANOTHER session's build off them
# is the heavy-build lock each block of build-platforms.sh takes.
DEVICE_FAILED=""
if [ "$WANT_IOS" = 1 ]; then
  sh tools/build-platforms.sh --ios || DEVICE_FAILED="$DEVICE_FAILED --ios"
fi
if [ "$WANT_ANDROID" = 1 ]; then
  sh tools/build-platforms.sh --android || DEVICE_FAILED="$DEVICE_FAILED --android"
fi
if [ -n "$DEVICE_FAILED" ]; then
  echo "" >&2
  echo "$NEW IS LIVE AND TAGGED. These device builds did not finish:$DEVICE_FAILED" >&2
  echo "  Re-run just those, once the device is ready:" >&2
  echo "    sh tools/build-platforms.sh$DEVICE_FAILED" >&2
fi


# ----------------------------------------------------------- the Release run
# It has been running beside the device builds. Watched to the end, then the
# published release's URL is printed — or, if it failed, the loud version, with
# the exact command to run it again. The deploy and the tag stand either way.
# dtp does not wait for it (GitHub mails a red run; tdtp is the lane that
# watches) — that wait was most of a dtp's wall clock.
if [ "$FULL" = 0 ]; then
  # The next lane run says so at its start if it never published (gh-bot.sh last-release).
  echo "==> Release left to the bot (dtp does not watch it)"
elif command -v gh >/dev/null 2>&1; then
  echo "==> following the release of $NEW (installers built on GitHub by the bot)"
  if ! sh tools/gh-bot.sh release "$TAG"; then
    RELEASE_FAILED=1
    echo "" >&2
    echo "$NEW IS LIVE AND TAGGED, but the GitHub release was NOT published (tools/gh-bot.sh named the run and jobs above)." >&2
    echo "  Fix the cause, then:  gh workflow run mealmind-release.yml --ref $TAG -f tag=$TAG" >&2
  fi
fi

# A release or build failure after the push still makes the lane exit non-zero.
if [ -n "$DEVICE_FAILED" ] || [ -n "$RELEASE_FAILED" ]; then
  echo "==> $NEW is live and tagged; the lane ends non-zero for the failures above"
  exit 1
fi
echo "==> dtp done: $NEW is live"
