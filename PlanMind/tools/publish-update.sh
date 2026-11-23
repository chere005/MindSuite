#!/bin/sh
# Publish PlanMind's auto-update feed entry for the version in package.json (the local, keychain-signed step: CI has no
# update key). Run by tools/dtp.sh after the push, or by hand to retry:
#
#   sh tools/publish-update.sh [--dry-run DIR] [more publish-update.mjs options]
#
# It needs, in order: the release PlanMind/<version> PUBLISHED on GitHub with its Windows installers (the workflow
# .github/workflows/planmind-release.yml does that), and the signed, notarized PlanMind.app of exactly this version
# installed (tools/build-platforms.sh --mac does that). It downloads the two Windows installers, then
# ../tools/publish-update.mjs verifies the app, signs the archive and both installers with PlanMind's update key (from the
# separate keychain, never printed), uploads them, and writes latest.json LAST to the fixed feed release PlanMind-updates.
# Nothing here is ever fatal to a release that already shipped; the caller says what is still owed.
#
# Overrides (tests): PLANMIND_INSTALLED_APP (default /Applications/PlanMind.app), PLANMIND_UPDATE_REPO (default: origin's),
# MINDSUITE_PUBLISH_UPDATE_TOOL (default ../tools/publish-update.mjs), GH (default gh).
set -eu
cd "$(dirname "$0")/.."
GH=${GH:-gh}
TOOL=${MINDSUITE_PUBLISH_UPDATE_TOOL:-../tools/publish-update.mjs}
APP=${PLANMIND_INSTALLED_APP:-/Applications/PlanMind.app}
REPO=${PLANMIND_UPDATE_REPO:-$(git remote get-url origin | sed -e 's|\.git$||' -e 's|.*[:/]\([^/]*/[^/]*\)$|\1|')}
[ -n "$REPO" ] || { echo 'publish-update: cannot work out owner/repo from origin' >&2; exit 1; }
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "publish-update: package.json version '$VERSION' is not x.y.z" >&2; exit 1; }
TAG="PlanMind/$VERSION"
command -v "$GH" >/dev/null 2>&1 || { echo 'publish-update: gh is not installed' >&2; exit 1; }

# The release must be published (a draft has no public installer URLs, and the feed must never name a file nobody can fetch).
DRAFT=$("$GH" release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null | tr -d '\r' || true)
[ "$DRAFT" = false ] || { echo "publish-update: the release $TAG is not published (draft: ${DRAFT:-missing}); nothing was signed or uploaded" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/planmind-update.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
"$GH" release download "$TAG" --repo "$REPO" --dir "$WORK" \
  --pattern "PlanMind_${VERSION}_x64*.msi" --pattern "PlanMind_${VERSION}_x64*-setup.exe" >/dev/null
MSI=; NSIS=; NM=0; NN=0
for f in "$WORK"/*; do
  case "$f" in
    *.msi) MSI=$f; NM=$((NM + 1)) ;;
    *-setup.exe) NSIS=$f; NN=$((NN + 1)) ;;
  esac
done
[ "$NM" = 1 ] && [ "$NN" = 1 ] || { echo "publish-update: expected one PlanMind_${VERSION}_x64*.msi and one -setup.exe on $TAG, found $NM and $NN" >&2; exit 1; }

if [ -s "docs/releases/$VERSION.md" ]; then set -- --notes-file "docs/releases/$VERSION.md" "$@"; else set -- --notes "PlanMind $VERSION" "$@"; fi
node "$TOOL" --app PlanMind --version "$VERSION" --repo "$REPO" --mac-app "$APP" --win-nsis "$NSIS" --win-msi "$MSI" "$@"
