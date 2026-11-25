#!/bin/sh
# The real-app update trial: two Developer ID signed (and, for the new one, notarized and stapled) TaskMind builds, the real
# TaskMind update key, a local fixture feed. Nothing leaves the machine and nothing is installed: the old app is copied
# into a scratch directory for every scenario. Not part of `npm test` (it needs the two builds, the updater keychain and
# a minute of cargo).
#
#   sh tools/test-real-update.sh --old-app DIR/TaskMind.app --new-app DIR/TaskMind.app
#
# --old-app is the N-1 build (any signed copy whose CFBundleShortVersionString is below the new one), --new-app is N, as
# tools/mac-sign-install.sh --no-install --out DIR left it (signed, notarized, stapled). The script
#   1. makes the feed files for N exactly as the release does (../tools/publish-update.mjs --dry-run, signed with
#      TaskMind's key from the updater keychain) with stand-in Windows installers (it checks the naming and the entries),
#   2. signs the same archive with a throwaway key (the "signature from another key" case),
#   3. runs the #[ignore]d test in native/src-tauri/src/updater_real_app.rs under the heavy-build lock.
# What the test shows is written in that file's header. The Windows update path is NOT run here (no Windows).
set -eu
cd "$(dirname "$0")/.."
OLD=; NEW=
while [ $# -gt 0 ]; do
  case "$1" in
    --old-app) OLD=${2:?}; shift 2 ;;
    --new-app) NEW=${2:?}; shift 2 ;;
    *) echo "usage: sh tools/test-real-update.sh --old-app APP --new-app APP" >&2; exit 2 ;;
  esac
done
[ -d "$OLD/Contents" ] && [ -d "$NEW/Contents" ] || { echo 'test-real-update: --old-app and --new-app must be .app bundles' >&2; exit 2; }
plist() { /usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$1/Contents/Info.plist"; }
OLD_V=$(plist "$OLD"); NEW_V=$(plist "$NEW")
TAURI=native/node_modules/.bin/tauri
[ -x "$TAURI" ] || { echo "test-real-update: $TAURI is missing (npm --prefix native ci)" >&2; exit 1; }
# The Apple team the signed builds must carry comes from this machine's untracked file (tools/machine-env.sh), never from a tracked literal.
if [ -z "${APPLE_TEAM_ID:-}" ]; then . tools/machine-env.sh; machine_load "$PWD"; fi
TEAM=$(. tools/machine-env.sh; machine_team) || exit 1
WORK=$(mktemp -d "${TMPDIR:-/tmp}/taskmind-real-update.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
FEED=$WORK/feed; mkdir -p "$FEED"
# stand-in Windows installers with Tauri's own file names (the feed tool refuses any other spelling)
printf 'stand-in nsis installer\n' > "$WORK/TaskMind_${NEW_V}_x64-setup.exe"
printf 'stand-in msi installer\n' > "$WORK/TaskMind_${NEW_V}_x64_en-US.msi"
TAURI_BIN=$PWD/$TAURI node ../tools/publish-update.mjs --app TaskMind --version "$NEW_V" --repo chere005/MindSuite \
  --mac-app "$NEW" --win-nsis "$WORK/TaskMind_${NEW_V}_x64-setup.exe" --win-msi "$WORK/TaskMind_${NEW_V}_x64_en-US.msi" \
  --notes "A scratch update for the real-app trial." --dry-run "$FEED"
ARCHIVE=$(ls "$FEED"/*.app.tar.gz)
# the same archive signed by another key (a copy: signing writes a .sig beside the file, and the feed's own must stay)
KEYPW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
mkdir -p "$WORK/other"; cp "$ARCHIVE" "$WORK/other/archive.tar.gz"
"$TAURI" signer generate --ci -w "$WORK/other.key" -p "$KEYPW" >/dev/null
TAURI_SIGNING_PRIVATE_KEY_PATH="$WORK/other.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$KEYPW" "$TAURI" signer sign "$WORK/other/archive.tar.gz" >/dev/null
cp "$WORK/other/archive.tar.gz.sig" "$WORK/other.sig"
. tools/heavy-lock.sh
heavy_lock 'TaskMind real-app update trial (cargo test --ignored)'
_rc=0
(cd native/src-tauri && MIND_E2E_TEAM="$TEAM" MIND_E2E_OLD_APP="$OLD" MIND_E2E_FEED_DIR="$FEED" MIND_E2E_OTHER_SIG="$WORK/other.sig" MIND_E2E_OLD="$OLD_V" MIND_E2E_NEW="$NEW_V" \
  cargo test --locked a_real_signed_old_build_updates -- --ignored --nocapture) || _rc=$?
heavy_unlock
exit "$_rc"
