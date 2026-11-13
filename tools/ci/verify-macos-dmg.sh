#!/bin/bash
# Fail the release before upload unless the packaged app is signed and notarized.
set -euo pipefail
dmg=${1:?dmg required}; name=${2:?app name required}; : "${APPLE_TEAM_ID:?}"
mount=$(mktemp -d "${RUNNER_TEMP:?}/mindsuite-dmg.XXXXXX")
attached=0
cleanup() { if [[ $attached = 1 ]]; then hdiutil detach "$mount" -quiet; fi; rmdir "$mount"; }
trap cleanup EXIT
hdiutil verify "$dmg" >/dev/null
hdiutil attach "$dmg" -nobrowse -readonly -quiet -mountpoint "$mount"
attached=1
app="$mount/$name.app"
test -d "$app"
codesign --verify --deep --strict "$app"
codesign -dv --verbose=4 "$app" 2>&1 | grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" >/dev/null
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
echo "$name: Developer ID signature and notarization verified"
