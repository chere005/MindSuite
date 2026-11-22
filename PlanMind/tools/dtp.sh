#!/bin/sh
# Release only after explicit dtp/tdtp authorization; no source commit is made here.
# Order: deploy, then tag and push at once (a live version is never left untagged), then the device builds.
set -eu
cd "$(dirname "$0")/.."
FULL=0; PLATFORMS=1
for arg in "$@"; do
  case "$arg" in --full) FULL=1 ;; --web) PLATFORMS=0 ;; --platforms) PLATFORMS=1 ;; *) echo "unknown flag: $arg" >&2; exit 1 ;; esac
done
[ "$(git branch --show-current)" = main ] || { echo 'Release main only.' >&2; exit 1; }
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
if [ "$PLATFORMS" = 1 ]; then
  # build-platforms.sh says what it still owes through this file: a failed build, or a phone that was offline or locked.
  OWED_FILE=$(mktemp "${TMPDIR:-/tmp}/planmind-owed.XXXXXX")
  _rc=0; PLANMIND_OWED_FILE=$OWED_FILE sh tools/build-platforms.sh || _rc=$?
  _owed=$(sed 's/^/  - /' "$OWED_FILE")
  if [ "$_rc" != 0 ]; then
    echo "The web shipped (PlanMind $VERSION is live, tagged and pushed), but the device build failed (exit $_rc). Still owed:" >&2
    printf '%s\n' "${_owed:-  - the device builds (see the output above)}" >&2
    echo 'Run: sh tools/build-platforms.sh' >&2
    exit 1
  fi
  if [ -n "$_owed" ]; then printf 'The device builds are done, but still owed:\n%s\nRun: sh tools/build-platforms.sh\n' "$_owed" >&2; fi

fi
[ "$SUITE_OWED" = 0 ] || exit 1
