#!/bin/sh
# Release only after explicit dtp/tdtp authorization; no source commit is made here.
# Order: (preflight of the Release workflow's builds when the native shell changed), deploy, then tag and push at once (a live
# version is never left untagged), then the signed macOS install and the iOS builds, then the release follow-up: the tag
# starts .github/workflows/planmind-release.yml (a signed, notarized dmg and the Windows installers on the release PlanMind/<version>,
# built by github-actions[bot]); once it is published the lane signs and publishes the auto-update feed locally
# (tools/publish-update.sh: the update key lives only in this Mac's updater keychain, never in GitHub).
# Everything after the push is reported rather than fatal to the version that already shipped; the lane then ends non-zero.
set -eu
cd "$(dirname "$0")/.."
export GH_BOT_TAG_PREFIX=PlanMind GH_BOT_WORKFLOW=planmind-release.yml
FULL=0; PLATFORMS=1; SKIP_PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in --full) FULL=1 ;; --web) PLATFORMS=0 ;; --platforms) PLATFORMS=1 ;; --skip-preflight) SKIP_PREFLIGHT=1 ;; *) echo "unknown flag: $arg" >&2; exit 1 ;; esac
done
[ "$(git branch --show-current)" = main ] || { echo 'Release main only.' >&2; exit 1; }
# A release the bot could not finish mails nobody (quiet CI), so the lane is where it is heard about. Never fatal.
sh tools/gh-bot.sh last-release || true
[ -z "$(git status --porcelain)" ] || { echo 'Commit the reviewed source before releasing.' >&2; exit 1; }
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
TAG="PlanMind/$VERSION"
if git show-ref --verify --quiet "refs/tags/$TAG" ||
   git show-ref --verify --quiet "refs/tags/PlanMind/legacy-origin/$VERSION" ||
   git show-ref --verify --quiet "refs/tags/PlanMind/legacy/$VERSION"; then
  echo 'This version is already tagged; update the app and native version together.' >&2; exit 1
fi

OWED_FILE=
cleanup() {
  if [ -n "$OWED_FILE" ]; then rm -f "$OWED_FILE" || :; fi
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT INT; kill -s INT $$; exit 130' INT
trap 'cleanup; trap - EXIT TERM; kill -s TERM $$; exit 143' TERM

# Never deploy production and then fail to push: origin must not be ahead, and the tag must be free there.
git fetch -q origin main || { echo 'Could not fetch origin/main; nothing was deployed.' >&2; exit 1; }
git merge-base --is-ancestor origin/main HEAD || { echo 'origin/main has commits this checkout lacks: pull first. Nothing was deployed.' >&2; exit 1; }
_rt=0; git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 || _rt=$?
[ "$_rt" = 2 ] || { echo "origin already has (or could not be asked about) the tag $VERSION: bump the version. Nothing was deployed." >&2; exit 1; }
# PREFLIGHT: the Release workflow's Windows and macOS builds on THIS commit, before anything ships (a throwaway preflight/ branch,
# a no-publish run of the bot; tools/preflight.sh). Only when the native shell or the workflow changed since the last tag (tdtp
# always), and only when GitHub already has the workflow on origin/main (it cannot dispatch one it does not know: the first
# release of a new workflow is its own first test, and says so). A red preflight stops the lane with nothing deployed.
LAST_TAG=$(git describe --tags --abbrev=0 --match 'PlanMind/[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
RELEASE_INPUTS=1
if [ -n "$LAST_TAG" ] &&
    git diff --quiet "$LAST_TAG" HEAD -- ':(top).github/workflows/planmind-release.yml' &&
    git diff --quiet "$LAST_TAG" HEAD -- ':(top)PlanMind/native' ':(top)tools/ci'; then
  RELEASE_INPUTS=0
fi
if [ "$SKIP_PREFLIGHT" = 1 ]; then
  echo '   WARNING: --skip-preflight: the Release builds have NOT been tried on this commit' >&2
elif [ "$PLATFORMS" = 0 ]; then
  echo '==> preflight: skipped (--web)'
elif ! git cat-file -e origin/main:.github/workflows/planmind-release.yml 2>/dev/null; then
  echo '==> preflight: skipped (planmind-release.yml is not on origin/main yet: this release is its first run)'
elif [ "$FULL" = 0 ] && [ "$RELEASE_INPUTS" = 0 ]; then
  echo "==> preflight: skipped (dtp; nothing the Release builds from changed since $LAST_TAG; tdtp always runs it)"
else
  echo '==> preflight: the Release builds on this commit (GitHub runners; takes a while)'
  sh tools/preflight.sh "$TAG" || { echo 'The preflight failed: nothing was deployed, tagged or pushed. Fix what it named and run the lane again (--skip-preflight tags anyway; it is for when GitHub itself is down).' >&2; exit 1; }
fi
# deploy.sh runs the gates itself (check:core, npm test, the build, then the spot e2e for dtp or every spec for tdtp), so
# npm test is not run here as well: tdtp used to run it twice.
if [ "$FULL" = 1 ]; then sh tools/deploy.sh --prod --yes-prod; else sh tools/deploy.sh --prod --yes-prod --quick; fi
# The version is live now: tag and push it at once, whatever the device builds do next.
git tag "$TAG"
git push --atomic origin main "refs/tags/$TAG"
echo "PlanMind $VERSION is deployed, tagged and pushed."
# MindSuite's minor follows every app release, with a note naming this tag (../tools/mindsuite-release.mjs).
# Not fatal: the version is live and tagged; a missed record is reported and ends the lane non-zero at the foot.
SUITE_OWED=0
node "${MINDSUITE_RELEASE_TOOL:-../tools/mindsuite-release.mjs}" record PlanMind "$TAG" || {
  SUITE_OWED=1; echo "MindSuite does not name $TAG yet; from the suite root: node tools/mindsuite-release.mjs record PlanMind $TAG" >&2; }
# ---- after the push: reported, never fatal to the version that is live and tagged
REPO_URL=$(gh repo view --json url --jq .url 2>/dev/null || true)
DEVICE_FAILED=0; RELEASE_FAILED=""; UPDATE_FAILED=""
if [ "$PLATFORMS" = 1 ]; then
  # build-platforms.sh says what it still owes through this file: a failed build, or a phone that was offline or locked.
  # The macOS step signs, notarizes and staples the app and installs it (tools/mac-sign-install.sh); it runs while GitHub
  # builds the installers for the tag.
  OWED_FILE=$(mktemp "${TMPDIR:-/tmp}/planmind-owed.XXXXXX")
  _rc=0; PLANMIND_OWED_FILE=$OWED_FILE sh tools/build-platforms.sh || _rc=$?
  _owed=$(sed 's/^/  - /' "$OWED_FILE")
  if [ "$_rc" != 0 ]; then
    DEVICE_FAILED=1
    echo "The web shipped (PlanMind $VERSION is live, tagged and pushed), but the device build failed (exit $_rc). Still owed:" >&2
    printf '%s\n' "${_owed:-  - the device builds (see the output above)}" >&2
    echo 'Run: sh tools/build-platforms.sh' >&2
  elif [ -n "$_owed" ]; then
    printf 'The device builds are done, but still owed:\n%s\nRun: sh tools/build-platforms.sh\n' "$_owed" >&2
  fi
fi

# The Release workflow: follow it until the release is published (the bot retries a missing platform itself, three runs at most).
if command -v gh >/dev/null 2>&1; then
  echo "==> following the release of $VERSION (built by github-actions[bot]): ${REPO_URL:+$REPO_URL/actions/workflows/planmind-release.yml}"
  sh tools/gh-bot.sh release "$TAG" || RELEASE_FAILED="the release $TAG is not published; tools/gh-bot.sh named the run and the failed jobs above. Fix, then: gh workflow run planmind-release.yml --ref $TAG -f tag=$TAG, then: sh tools/publish-update.sh"
else
  RELEASE_FAILED='gh is not installed, so the Release run was not watched and the update feed was not published; then: sh tools/publish-update.sh'
fi

# The auto-update feed: needs the published release and this version's signed app installed (a --web run installs none).
if [ -n "$RELEASE_FAILED" ]; then
  :
elif [ "$PLATFORMS" = 0 ]; then
  # A deliberate --web run: said, not a failure.
  echo '==> update feed: not published (--web installs no signed app); after sh tools/build-platforms.sh --mac, run: sh tools/publish-update.sh'
else
  echo "==> publishing the update feed for $VERSION (signs with PlanMind's key from the updater keychain)"
  sh tools/publish-update.sh || UPDATE_FAILED="the update feed for $VERSION was not published (the lines above say why); once fixed: sh tools/publish-update.sh"
fi
if [ -n "$RELEASE_FAILED" ] || [ -n "$UPDATE_FAILED" ]; then
  echo "" >&2
  echo "PlanMind $VERSION IS LIVE AND TAGGED, BUT:" >&2
  for _m in "$RELEASE_FAILED" "$UPDATE_FAILED"; do
    [ -z "$_m" ] || echo "  $_m" >&2
  done
fi
[ "$SUITE_OWED" = 0 ] && [ "$DEVICE_FAILED" = 0 ] && [ -z "$RELEASE_FAILED" ] && [ -z "$UPDATE_FAILED" ] || exit 1
