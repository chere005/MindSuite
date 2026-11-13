#!/bin/sh
# dtp — deploy, tag, push. The release gesture for CalMind.
# tdtp — the same lane with the full suites: tools/tdtp.sh, which calls this
# with --full. (the owner's shorthand, 2026-08-22: dtp = deploy, tag, push; tdtp =
# test, deploy, tag, push. The lanes themselves are TODO.md §4's, unchanged —
# this script just makes them one gesture instead of three.)
#
# What a run does, in order:
#   0. git pull --autostash (two sessions share this repo), then refuse a
#      tree with uncommitted TRACKED changes — the tag must name what shipped
#   1. bump the MINOR version (x.y.0 → x.(y+1).0) in the four files that move
#      together — apps/app/app.json, desktop/package.json,
#      desktop/src-tauri/tauri.conf.json, desktop/src-tauri/Cargo.toml (the
#      lock follows via cargo) — and commit the bump. UNLESS the current
#      version is still untagged: a previous run bumped and then failed
#      before tagging, and that version is reused rather than skipped past.
#      ios.buildNumber is NOT touched — it moves by hand per device build;
#      the web deploy is what this lane ships, and web first, always.
#   2. deploy: ./server/deploy.sh prod test --yes-prod [--quick]
#      · dtp is the quick lane (seconds-cost gates plus the spot test —
#        the owner: "even if it means some things could occasionally break")
#      · tdtp is the full lane: every suite, gestures and WebKit included
#      Both ship prod AND test off one run of the gates ("dtp should be
#      prod now generally" — 2026-08-21). A failed deploy stops everything:
#      nothing is tagged, nothing is pushed, never tag around a failure.
#   3. the macOS bundle, from a fresh export of what the deploy just shipped
#      — BEFORE the tag, so a broken desktop build leaves the version
#      untagged and a re-run reuses it, exactly as a failed deploy does
#   3b. PREFLIGHT (tools/preflight.sh): the Release workflow's builds
#      (Windows, macOS, Linux) run on GitHub against this very commit, in a
#      mode where a red job fails nothing and mails nobody; a red preflight
#      stops the lane BEFORE the tag, like a failed deploy. --skip-preflight
#      is the way around it, and it is said out loud.
#   4. tag CalMind/X.Y.0 (namespaced, no v) (annotated);  5. git push of main and the app tag
#   6. the tag push starts the Release workflow (.github/workflows/calmind-release.yml):
#      the lane finds that run, watches it, and reports the run's URL and the
#      published release's URL. A Release failure does not un-ship the deploy:
#      it is reported loudly with the exact re-run command and the lane ends
#      non-zero, like an owed device build (below)
#   7. the device builds — iOS on the phone (the watch companion rides
#      along), Android on an emulator — AFTER the push and reported rather
#      than fatal, because the release has already happened and an unplugged
#      phone must not read as a failed one. One at a time, never in
#      parallel: two heavy build/device processes at once has caused real
#      failures on this machine twice.
#
# THIS REPO SHIPS ITSELF. Steps 3 and 7 were CoreMind's alone
# (bin/build-platforms.sh CalMind) until 2026-08-23, and ChefMind fell into
# the hole that leaves first: a release tagged and pushed while the Mac
# bundle stayed a day behind. The owner, 2026-08-23: "all apps should have a
# deploy on their own mechanism inside their repo" — so tools/
# build-platforms.sh is this repo's, this lane runs it, and CoreMind
# orchestrates ACROSS apps by calling each app's own lane.
#
# WHICH PLATFORMS: naming one selects only it. Naming none means all three
# for tdtp and NONE for dtp. `--web` is how you say "the release and no
# platform builds" explicitly.
#
# DTP IS THE FAST LANE, TDTP THE THOROUGH ONE (the owner, 2026-11-02: "dtp needs to
# be significantly faster … make sure tdtp is thorough"). A dtp of 1.47.0 took
# 18 minutes, 14 of them waiting on GitHub: the 7-minute preflight and the
# 7-minute Release watch. So dtp now: no platform builds unless named; the
# preflight only when the commits since the last tag touch what the Release
# builds from (desktop/, .github/, a package or Cargo manifest) — a web-only
# change has already passed tsc and the export by then; and the Release run is
# started by the tag but not watched. tdtp keeps every one of those, plus the
# contract/watch/widget/deploy-guard/desktop checks the deploy never ran.
set -e
cd "$(dirname "$0")/.."
export GH_BOT_TAG_PREFIX=CalMind GH_BOT_WORKFLOW=calmind-release.yml

FULL=0; PICKED=0; WANT_MAC=0; WANT_IOS=0; WANT_ANDROID=0; SKIP_PREFLIGHT=0
for a in "$@"; do
  case "$a" in
    --full)    FULL=1 ;;
    # The preflight is the Release workflow's builds on this commit, before
    # the tag. Skipping it ships a tag whose Windows/macOS/Linux build nobody
    # has seen; the flag exists for when GitHub itself is the problem.
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --mac)     WANT_MAC=1;     PICKED=1 ;;
    --ios)     WANT_IOS=1;     PICKED=1 ;;
    --android) WANT_ANDROID=1; PICKED=1 ;;
    # The release on its own. Not the same as naming no flag at all, which
    # means every platform — this is the way to say none.
    --web)     PICKED=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done
# --full is not a platform: `tdtp` with no other flag means all three, `dtp`
# with no other flag means the web release alone.
[ "$PICKED" = 1 ] || [ "$FULL" = 0 ] || { WANT_MAC=1; WANT_IOS=1; WANT_ANDROID=1; }

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

# ------------------------------------------------------------ the drift gate
# This repo carries byte-identical copies of the shared files listed in
# ../tools/shared-files.json, and a release that ships drifted copies
# publishes bytes their origin does not have — silently, since nothing else
# in this lane reads the manifest. Auto-rewriting source mid-release is not
# allowed (`check-shared.mjs --fix` is a deliberate act that refuses on a
# dirty tree, and a lane that edits the tree it is about to tag cannot be
# trusted about what shipped), so the gate makes the dependency LOUD
# instead: any drifted, missing or unreadable member, a broken manifest, or a
# check that compared nothing refuses the release with the fix spelled out.
# The checker is tracked in this repo, so it FAILS CLOSED: a missing tool, a
# missing node or any non-zero exit refuses, and nothing is warned past.
SHARED_CHECK=../tools/check-shared.mjs
if [ ! -f "$SHARED_CHECK" ]; then
  echo "refusing: $SHARED_CHECK is missing — the shared-files gate could not run, nothing has shipped." >&2
  exit 1
fi
if ! node "$SHARED_CHECK" --app CalMind; then
  echo "" >&2
  echo "refusing: the shared files have drifted or could not be checked (the lines above) — nothing has shipped." >&2
  echo "  For a drifted group, land the copy-down first, commit it, then re-run:" >&2
  echo "    node ../tools/check-shared.mjs --fix <group>" >&2
  exit 1
fi

# ------------------------------------------------------------- the status page
# A SINGLE-REPO RELEASE IS STILL A RELEASE. The owner, 2026-08-23: "i dont see the
# tdtp from ChefMind on status". CoreMind's bin/dtp.sh had reported to
# seancheren.com/status since the page existed; a repo shipping ITSELF did not,
# so the page went quiet for exactly the runs nobody else knew were coming — and
# the history graph recorded no purple for them at all.
#
# NEVER FATAL. report-status.sh exits 0 on every failure path by design, and the
# `|| true` here covers the case where CoreMind is not checked out beside this
# repo at all. A status page must never be the thing that stops a release.
# A BATCH OWNS ITS OWN CARD. When CoreMind's orchestrator runs this lane as
# part of `dtp all`, it has already opened one run for the whole plan and
# passes its id down — reporting again would draw a second card for a job that
# is one job (the owner, 2026-08-23: "there should be one card per tdtp if multiple
# jobs are triggered in one batch"). Run alone, MIND_RUN_ID is unset and this
# lane opens and closes its own, exactly as before.
REPORTER="${MIND_STATUS_REPORTER:-${MIND_DIR:-$(cd .. && pwd)}/CoreMind/bin/report-status.sh}"
RUN_ID=""
REPORT_DONE=0
# DEFINED OUT HERE, not inside the branch below. It is called at the foot
# of the lane unconditionally, and under CoreMind's batch MIND_RUN_ID is
# set so that branch never runs — "beat_stop: command not found" then made
# a lane that had shipped, tagged, pushed and installed exit non-zero, and
# the batch read that back as "a platform build did not finish" for every
# repo in the suite (2026-09-18). The sandbox lanes carried this shape
# already; this is the copy-across.
BEAT_PID=""
# ERREXIT-PROOF, and it was not. The first shape — `[ -n "$BEAT_PID" ] &&
# { kill …; wait …; }` — puts the brace group LAST in an AND list, which is
# the one place `set -e` still applies; `wait` on a process just killed
# returns 143, the lane died right there, AFTER the push and BEFORE the
# status finish, and the EXIT trap re-entered this function and died the
# same way — so every standalone lane since the beat arrived (2026-09-06)
# ended 1 with its card stuck purple at "running". Found by TestAcctMind's
# first qdtp, 2026-09-15; `|| true` on both, and `if` instead of the list.
beat_stop() {
  if [ -n "$BEAT_PID" ]; then
    kill "$BEAT_PID" >/dev/null 2>&1 || true
    wait "$BEAT_PID" 2>/dev/null || true
    BEAT_PID=""
  fi
  return 0
}
# THE LANE'S WAY OUT, on EXIT and on a signal alike, and the one place the
# card is closed `failed`. EXACTLY ONCE: REPORT_DONE goes to 1 BEFORE the
# reporter runs, so the EXIT after a signal, a second ^C, and the foot of the
# lane all find the card already closed.
lane_stopped() {
  beat_stop
  if [ -n "$RUN_ID" ] && [ "$REPORT_DONE" != 1 ]; then
    REPORT_DONE=1
    sh "$REPORTER" finish "$RUN_ID" failed 3 "stopped before finishing" >/dev/null 2>&1 || true
  fi
  return 0
}

if [ -f "$REPORTER" ] && [ -z "${MIND_RUN_ID:-}" ]; then
  KIND=dtp; [ "$FULL" = 1 ] && KIND=tdtp
  RUN_ID=$(sh "$REPORTER" start "$KIND" CalMind 2>/dev/null || true)
  # A lane that dies anywhere — a failed deploy, a refused push, a Ctrl-C —
  # must not leave this repo purple on the page for ever.
  #
  # AND A CTRL-C MUST END IT. This was one trap for EXIT, INT and TERM, and a
  # signal trap that returns RESUMES the script: ^C during the iOS build killed
  # xcodebuild, closed the card `failed`, and the lane went straight on into
  # the Android build and then closed the same card again, `ok` (found
  # 2026-10-01). So INT and TERM close the card and then die of their own
  # signal, as an untrapped shell would. A caller then sees "killed by SIGINT"
  # and stops too; `exit 130` would read to it as a child that handled the ^C,
  # and it would carry on. tools/heavy-lock.sh's handler ends the same way.
  trap 'lane_stopped' EXIT
  trap 'lane_stopped; trap - EXIT INT; kill -s INT $$; exit 130' INT
  trap 'lane_stopped; trap - EXIT TERM; kill -s TERM $$; exit 143' TERM
  # A BEAT A MINUTE — the owner, 2026-09-07: "make sure during dtp that status is
  # updated every minute at least". start/finish alone leave the card frozen at
  # "running" through a multi-minute build; a beat every 60s keeps the page
  # showing the run alive, and a hung run then shows as a stamp that stops
  # moving. Only when this lane OWNS the run — under `dtp all` the parent beats.
  if [ -n "$RUN_ID" ]; then
    ( while :; do sleep 60; sh "$REPORTER" beat "$RUN_ID" "shipping — $KIND" >/dev/null 2>&1 || true; done ) &
    BEAT_PID=$!
  fi
fi

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
  echo "==> tdtp: the between-runs suite first (the deploy runs the browser gates itself)"
  sh tools/test-dev.sh || { echo "test:dev failed — nothing shipped" >&2; exit 1; }
  # The checks nothing else in the lane ran. test:widget sat red for six weeks
  # (2ade327 changed the feed, the check still expected the old one) because no
  # lane called it. test:desktop runs after the Mac bundle, below, since it
  # reads the stage that build makes.
  for S in test:contract test:watch test:widget test:deploy test:simfresh; do
    echo "==> tdtp: $S"
    npm run -s "$S" || { echo "$S failed — nothing shipped" >&2; exit 1; }
  done
fi

# What the Release workflow builds from, changed since the last tag? Read
# BEFORE the bump commit, which touches those manifests every time.
LAST_TAG=$(git describe --tags --abbrev=0 --match 'CalMind/[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
RELEASE_INPUTS=1
if [ -n "$LAST_TAG" ] &&
    git diff --quiet "$LAST_TAG" HEAD -- ':(top).github/workflows/calmind-release.yml' &&
    ! git diff --name-only --relative "$LAST_TAG" HEAD -- . \
      | grep -qE '^desktop/|(^|/)package(-lock)?\.json$|(^|/)Cargo\.(toml|lock)$|(^|/)app\.config\.js$'; then
  RELEASE_INPUTS=0
fi

# ------------------------------------------------------------------ the version
CUR=$(node -p "require('./apps/app/app.json').expo.version")
# x.y.z, three digit parts, nothing else. The glob this replaces claimed to
# reject anything else and accepted '', '1', '1.2' and '1.2.3.4' — and an
# EMPTY version flowed on into `git rev-parse refs/tags/v` and a tag named `v`.
printf '%s\n' "$CUR" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "app.json version '$CUR' is not x.y.z" >&2; exit 1; }

if git show-ref --verify --quiet "refs/tags/CalMind/$CUR" ||
   git show-ref --verify --quiet "refs/tags/CalMind/legacy-origin/$CUR" ||
   git show-ref --verify --quiet "refs/tags/CalMind/legacy/$CUR"; then
  NEW=$(echo "$CUR" | awk -F. '{printf "%d.%d.0", $1, $2+1}')
  echo "==> version: $CUR (tagged) -> $NEW"
else
  NEW="$CUR"
  echo "==> version: $CUR is still untagged from an earlier run — reusing it"
fi

# A leftover $NEW would make `git tag -a` fail AFTER the deploy has already
# shipped. Checked HERE, while nothing has been touched yet.
TAG="CalMind/$NEW"
if git show-ref --verify --quiet "refs/tags/$TAG" ||
   git show-ref --verify --quiet "refs/tags/CalMind/legacy-origin/$NEW" ||
   git show-ref --verify --quiet "refs/tags/CalMind/legacy/$NEW"; then
  echo "refusing: the tag $NEW already exists — nothing has shipped yet." >&2
  echo "  It is the residue of an interrupted lane: look at it, then delete it" >&2
  echo "  or move the version on." >&2
  exit 1
fi

# Each substitution is VERIFIED — a sed that matches nothing reports success
# (AcctMind's hard-learned lesson, and tools/check-version.mjs is its scar).
if [ "$NEW" != "$CUR" ]; then
  for F in apps/app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
    perl -i -pe "s|\"version\": \"\Q$CUR\E\"|\"version\": \"$NEW\"|" "$F"
  done
  perl -i -pe "s|^version = \"\Q$CUR\E\"|version = \"$NEW\"|" desktop/src-tauri/Cargo.toml
fi
for F in apps/app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
  grep -q "\"version\": \"$NEW\"" "$F" || { echo "guard: $F does not carry $NEW" >&2; exit 1; }
done
grep -q "^version = \"$NEW\"" desktop/src-tauri/Cargo.toml \
  || { echo "guard: Cargo.toml does not carry $NEW" >&2; exit 1; }

# Cargo.lock follows the crate — otherwise the next desktop build dirties it.
if command -v cargo >/dev/null 2>&1; then
  (cd desktop/src-tauri && cargo update -p calmind-desktop --quiet)
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

if ! git diff --quiet -- apps/app/app.json desktop/package.json \
    desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock package-lock.json; then
  git commit -q -m "CalMind $NEW" --only -- apps/app/app.json desktop/package.json \
    desktop/src-tauri/tauri.conf.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock package-lock.json
  echo "==> committed the bump"
fi

# ------------------------------------------------------------------- the deploy
if [ "$FULL" = 1 ]; then
  ./server/deploy.sh prod test --yes-prod
else
  ./server/deploy.sh prod test --yes-prod --quick
fi

# ------------------------------------------------------------------ the desktop
# A fresh export of exactly what the deploy just shipped, then the Tauri
# bundle — build-platforms.sh makes its own clean dist rather than trusting
# whatever is in apps/app/dist by now. BEFORE the tag, so a broken desktop
# build leaves the version untagged and a re-run reuses it, exactly as a
# failed deploy does.
if [ "$WANT_MAC" = 1 ]; then
  if ! sh tools/build-platforms.sh --mac; then
    echo "" >&2
    echo "THE WEB SHIPPED, but the macOS bundle failed — so nothing was tagged." >&2
    echo "  Fix it and re-run: the lane reuses ${NEW}, which is the version" >&2
    echo "  already live." >&2
    exit 1
  fi
  if [ "$FULL" = 1 ] && ! npm run -s test:desktop; then
    echo "THE WEB SHIPPED, but the desktop asset check failed — so nothing was tagged." >&2
    exit 1
  fi
fi

# ------------------------------------------------------------------- preflight
# The Release workflow's Windows, macOS and Linux builds, run on GitHub against
# THIS commit before it is tagged (tools/preflight.sh pushes it to a throwaway
# preflight/<sha> branch, which triggers nothing, and dispatches the workflow in
# its no-publish, no-email mode). It runs after the Mac bundle and before the
# tag, so a red result leaves the version untagged and a re-run reuses it,
# exactly as a failed deploy does. NEVER tag around a failed preflight.
if [ "$SKIP_PREFLIGHT" = 1 ]; then
  echo "   WARNING: --skip-preflight — the Release builds have NOT been tried on this commit" >&2
elif [ "$FULL" = 0 ] && [ "$RELEASE_INPUTS" = 0 ]; then
  echo "==> preflight: skipped (dtp; nothing the Release builds from changed since $LAST_TAG — tdtp always runs it)"
else
  echo "==> preflight: the Release builds on this commit (GitHub runners; takes a while)"
  if ! sh tools/preflight.sh "$TAG"; then
    echo "" >&2
    echo "THE WEB SHIPPED, but the preflight failed — so nothing was tagged." >&2
    echo "  Fix what it named, commit, and re-run: the lane reuses ${NEW}, which is the" >&2
    echo "  version already live. (--skip-preflight tags anyway; it is for when GitHub" >&2
    echo "  itself is down, not for a red build.)" >&2
    exit 1
  fi
fi

# --------------------------------------------------------------- tag, push, CI
git tag -a "$TAG" -m "CalMind $NEW"
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

# ------------------------------------------------------------ the Release run
# The tag push started .github/workflows/calmind-release.yml, whose run only hands the
# work to github-actions[bot] (quiet CI: nothing it does can mail anyone). The
# bot's run builds; one that leaves a platform missing dispatches the next
# itself (3 runs at most). NOT fatal to the lane's work: the deploy has shipped
# and the tag is on the remote, so an unpublished release is reported loudly
# with the command that retries it, and the lane ends non-zero for it (below).
RELEASE_FAILED=""
if [ "$FULL" = 0 ]; then
  # dtp does not wait on it (seven minutes of the old dtp were spent here); the
  # next lane run says so at its start if it never published (gh-bot.sh last-release).
  echo "==> Release for $NEW handed to the bot (not watched by dtp): $(gh repo view --json url --jq .url 2>/dev/null)/actions/workflows/calmind-release.yml"
elif command -v gh >/dev/null 2>&1; then
  echo "==> following the release of $NEW (built by github-actions[bot])"
  if ! sh tools/gh-bot.sh release "$TAG"; then
    RELEASE_FAILED="$NEW was not published; tools/gh-bot.sh named the run and the failed jobs above. Fix, then: gh workflow run calmind-release.yml --ref $TAG -f tag=$TAG"
  fi
else
  RELEASE_FAILED="gh is not installed, so the Release run was not watched — see the Actions tab; the release is only published when every installer is on it"
fi
if [ -n "$RELEASE_FAILED" ]; then
  echo "" >&2
  echo "$NEW IS LIVE AND TAGGED, BUT THE RELEASE IS NOT DONE:" >&2
  echo "  $RELEASE_FAILED" >&2
fi

# ------------------------------------------------------------- the device builds
# After the push, and NOT fatal. The release is done by here — the web is
# live, the tag is on the remote — so a phone that is not plugged in is a
# thing to be told about, not a failed release to unpick. The iOS install
# carries the watch companion onto a paired Apple Watch when one is
# reachable.
#
# One at a time, never in parallel: two heavy build/device processes at once
# has caused real failures on this machine twice.
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

# The page is told how it ended, and with what severity: a live, tagged release
# whose phone build did not run is not a failure, but it is not a clean 0 either.
beat_stop
REPORT_DONE=1
if [ -n "$RUN_ID" ]; then
  if [ -n "$DEVICE_FAILED" ] || [ -n "$RELEASE_FAILED" ]; then
    OWED=""
    [ -z "$RELEASE_FAILED" ] || OWED=" GitHub Release not published;"
    [ -z "$DEVICE_FAILED" ] || OWED="$OWED device builds pending:$DEVICE_FAILED"
    sh "$REPORTER" finish "$RUN_ID" ok 2 "$NEW live;$OWED" >/dev/null 2>&1 || true
  else
    sh "$REPORTER" finish "$RUN_ID" ok 0 "$NEW live" >/dev/null 2>&1 || true
  fi
fi

# AND YET THE LANE ENDS NON-ZERO. Nothing above is undone by this: the release
# is live, the tag is on the remote, and the status card was closed `ok`
# severity 2 a few lines up on purpose. What changes is only the one summary a
# caller reads without being told — a run that skipped a device build for want
# of a phone handed back a clean 0, so "it all worked" could be read off an
# exit status that had not checked. CoreMind's bin/dtp.sh has ended non-zero on
# exactly this since it existed, and catches this one so a batch still ships
# every repo after it; ChefMind carried it from 2026-08-23 and the other three
# did not, which meant the SAME condition reported differently per repo.
#
# LAST IN THE FILE, deliberately. REPORT_DONE is already 1 and the `finish`
# call above has run by the time control reaches here, so the exit cannot jump
# the status report and the EXIT trap's failed-3 fallback stays suppressed.
if [ -n "$DEVICE_FAILED" ] || [ -n "$RELEASE_FAILED" ]; then
  echo "==> $NEW is live and tagged; the lane ends non-zero for the release/device work reported above"
  exit 1
fi

echo "==> dtp done: $NEW is live on prod and test"
