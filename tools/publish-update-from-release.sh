#!/bin/sh
# Publish an app's auto-update feed entry from its PUBLISHED GitHub release, and (optionally) install the released app.
#
#   sh tools/publish-update-from-release.sh <App> <tag> <version> [--repo OWNER/MindSuite] [--wait SECONDS]
#                                           [--notes-file FILE] [--install] [--dry-run DIR] [--sign-with-prev-key]
#
# WHY. The release workflow (calmind-release.yml and its clones) builds the Windows installers and the signed, notarized,
# stapled dmg on GitHub runners; the update feed is signed LOCALLY (the update key never leaves the separate keychain,
# tools/updater-keygen.mjs) by tools/publish-update.mjs. This is the glue between the two, so a lane does not need the
# app built locally: it waits for the release to be published, downloads the installers and the dmg, checks every file
# against the release's SHA256SUMS.txt, takes the .app out of the dmg, and hands all of it to publish-update.mjs, which
# verifies the app (Developer ID, hardened runtime, notarized, stapled, arm64, the named version), signs, uploads
# artifacts and signatures, writes latest.json LAST, reads it back and prunes.
#
#   --wait SECONDS    how long to wait for the release to be published (default 1800; the bot's run takes about ten
#                     minutes). A release that never appears is an error, and nothing was signed or uploaded.
#   --install         after the feed is published, install the released .app over /Applications/<App>.app with
#                     <App>/tools/mac-sign-install.sh --already-signed (the same full verification, atomic swap,
#                     rollback; the running app is asked to quit and is reopened). The installed copy is then the very
#                     app the feed serves.
#   --sign-with-prev-key   sign with the PREVIOUS update key: the transitional release of a key rotation (also
#                     MIND_SIGN_WITH_PREV_KEY=1). Without it a kept previous key refuses the publish.
#   --dry-run DIR     write the feed files into DIR and touch no network upload (publish-update.mjs --dry-run); the
#                     release is still read with gh. Nothing is installed.
#
# Exit codes: 0 done, 1 refused or failed, 2 usage. Seams for the tests (sh tools/ci/test-publish-update-from-release.sh):
# MIND_GH (the gh command), MIND_PUBLISH_UPDATE (the publisher), MIND_POLL (seconds between looks).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "publish-update-from-release: $*" >&2; exit 1; }
say() { echo "publish-update-from-release: $*" >&2; }
usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

[ $# -ge 3 ] || usage
APP=$1; TAG=$2; VERSION=$3; shift 3
REPO=; WAIT=1800; NOTES=; INSTALL=0; DRY=; PREV=0
[ "${MIND_SIGN_WITH_PREV_KEY:-0}" != 1 ] || PREV=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?}; shift 2 ;;
    --wait) WAIT=${2:?}; shift 2 ;;
    --notes-file) NOTES=${2:?}; shift 2 ;;
    --install) INSTALL=1; shift ;;
    --sign-with-prev-key) PREV=1; shift ;;
    --dry-run) DRY=${2:?}; shift 2 ;;
    -h|--help) usage ;;
    *) echo "publish-update-from-release: unknown option $1" >&2; usage ;;
  esac
done
case "$APP" in *[!A-Za-z0-9]*|'') die "not an app name: $APP" ;; esac
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "not a plain version: $VERSION"
[ "$TAG" = "$APP/$VERSION" ] || die "the tag must be $APP/$VERSION, got $TAG"
case "$WAIT" in *[!0-9]*|'') die "--wait takes seconds" ;; esac

GH=${MIND_GH:-gh}
POLL=${MIND_POLL:-30}
command -v "$GH" >/dev/null 2>&1 || die "gh is not installed"
if [ -z "$REPO" ]; then
  REPO=$($GH repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || die "no --repo and gh cannot name the repository"
fi
[ -n "$NOTES" ] || { [ -f "$HERE/../$APP/docs/releases/$VERSION.md" ] && NOTES="$HERE/../$APP/docs/releases/$VERSION.md" || true; }
[ -z "$NOTES" ] || [ -f "$NOTES" ] || die "no such notes file: $NOTES"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/publish-update-release.XXXXXX")
MNT=
cleanup() {
  trap - EXIT INT TERM
  [ -z "$MNT" ] || hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 1. the release must be PUBLISHED (a draft is not finished: files may be missing, SHA256SUMS.txt is added last)
state() { $GH release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null || echo missing; }
waited=0
while [ "$(state)" != false ]; do
  [ "$waited" -lt "$WAIT" ] || die "the release $TAG is not published after ${WAIT}s; nothing was signed or uploaded"
  say "waiting for the release $TAG to be published ($(state), ${waited}s)"
  sleep "$POLL"
  waited=$((waited + POLL))
done

# 2. the files, each checked against the release's own checksums
DL="$WORK/dl"
mkdir "$DL"
$GH release download "$TAG" --repo "$REPO" --dir "$DL" \
  --pattern "${APP}_${VERSION}_aarch64.dmg" --pattern "${APP}_${VERSION}_x64*-setup.exe" --pattern "${APP}_${VERSION}_x64*.msi" \
  --pattern SHA256SUMS.txt >/dev/null 2>&1 || die "could not download the installers of $TAG"
one() { # glob  -> exactly one file
  n=0; hit=
  for f in "$DL"/$1; do [ -f "$f" ] && { n=$((n + 1)); hit=$f; }; done
  [ "$n" = 1 ] || die "expected exactly one $1 on $TAG, found $n"
  printf '%s' "$hit"
}
DMG=$(one "${APP}_${VERSION}_aarch64.dmg")
NSIS=$(one "${APP}_${VERSION}_x64*-setup.exe")
MSI=$(one "${APP}_${VERSION}_x64*.msi")
[ -f "$DL/SHA256SUMS.txt" ] || die "$TAG has no SHA256SUMS.txt"
for f in "$DMG" "$NSIS" "$MSI"; do
  name=$(basename "$f")
  line=$(awk -v n="$name" '$2 == n || $2 == "*" n { print; exit }' "$DL/SHA256SUMS.txt")
  [ -n "$line" ] || die "SHA256SUMS.txt does not list $name"
  [ "$(printf '%s' "$line" | awk '{ print $1 }')" = "$(shasum -a 256 "$f" | awk '{ print $1 }')" ] || die "$name does not match SHA256SUMS.txt"
done
say "checksums match ($(basename "$DMG"), $(basename "$NSIS"), $(basename "$MSI"))"

# 3. the .app inside the dmg (the one Gatekeeper accepts: signed, notarized, stapled)
MNT="$WORK/mnt"
mkdir "$MNT"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null || die "could not open $(basename "$DMG")"
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -1)
[ -n "$SRC" ] && [ "$(basename "$SRC")" = "$APP.app" ] || die "the dmg does not hold $APP.app"
mkdir "$WORK/app"
ditto "$SRC" "$WORK/app/$APP.app"
hdiutil detach "$MNT" >/dev/null 2>&1 || hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
MNT=

# 4. sign, upload, write the feed
set -- --app "$APP" --version "$VERSION" --repo "$REPO" --mac-app "$WORK/app/$APP.app" --win-nsis "$NSIS" --win-msi "$MSI"
[ -z "$NOTES" ] || set -- "$@" --notes-file "$NOTES"
[ -z "$DRY" ] || set -- "$@" --dry-run "$DRY"
[ "$PREV" = 0 ] || set -- "$@" --sign-with-prev-key
if [ -n "${MIND_PUBLISH_UPDATE:-}" ]; then
  "$MIND_PUBLISH_UPDATE" "$@" || die "publish-update failed"
else
  node "$HERE/publish-update.mjs" "$@" || die "publish-update failed"
fi

# 5. the installed app becomes the released one
if [ "$INSTALL" = 1 ] && [ -z "$DRY" ]; then
  SIGN="$HERE/../$APP/tools/mac-sign-install.sh"
  [ -f "$SIGN" ] || die "no $APP/tools/mac-sign-install.sh to install with"
  sh "$SIGN" --already-signed "$WORK/app/$APP.app" >/dev/null || die "the feed is published, but the released app could not be installed"
  say "installed /Applications/$APP.app ($VERSION, the released build)"
fi
say "done: $APP $VERSION"
