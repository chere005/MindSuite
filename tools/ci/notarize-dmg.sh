#!/bin/bash
# Notarize and staple a built dmg (the wrapper itself; Tauri notarizes only the app inside it). Run it between the
# build and tools/ci/verify-macos-dmg.sh, which refuses a dmg that is not stapled.
#   CI:    APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID  (the release workflows' secrets)
#   local: NOTARY_PROFILE=DisplayMind (or --profile NAME)  -- the notarytool keychain profile
#   bash tools/ci/notarize-dmg.sh [--profile NAME] <dmg>
# The dmg must already carry the team's Developer ID signature (Tauri signs it when APPLE_SIGNING_IDENTITY is set);
# an unsigned one is signed here only when APPLE_SIGNING_IDENTITY names the identity in full.
set -euo pipefail
fail() { echo "notarize-dmg: $*" >&2; exit 1; }
profile=${NOTARY_PROFILE:-}
if [[ ${1:-} = --profile ]]; then profile=${2:?}; shift 2; fi
dmg=${1:?dmg required}
[[ -f $dmg ]] || fail "no such file: $dmg"
if [[ -n $profile ]]; then
  auth=(--keychain-profile "$profile")
else
  for key in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do [[ -n ${!key:-} ]] || fail "missing $key (or pass --profile)"; done
  auth=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi
if ! codesign --verify --strict "$dmg" >/dev/null 2>&1; then
  [[ -n ${APPLE_SIGNING_IDENTITY:-} ]] || fail "the dmg is not signed and APPLE_SIGNING_IDENTITY is not set"
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
fi
info=$(codesign -dvv "$dmg" 2>&1) || fail "codesign -dvv failed"
grep -q '^Authority=Developer ID Application: ' <<<"$info" || fail "the dmg is not signed by a Developer ID Application identity"
result=$(mktemp "${TMPDIR:-/tmp}/notarize-dmg.XXXXXX")
trap 'rm -f "$result"' EXIT
xcrun notarytool submit "$dmg" "${auth[@]}" --wait --timeout "${NOTARY_TIMEOUT:-30m}" --output-format json > "$result" || fail "notarytool submit failed"
status=$(plutil -extract status raw -o - "$result" 2>/dev/null || echo unknown)
id=$(plutil -extract id raw -o - "$result" 2>/dev/null || echo unknown)
if [[ $status != Accepted ]]; then
  echo "notarize-dmg: Apple answered '$status' for $id; its log:" >&2
  xcrun notarytool log "$id" "${auth[@]}" >&2 || true
  exit 1
fi
n=0
until xcrun stapler staple "$dmg"; do
  n=$((n + 1)); [[ $n -lt 6 ]] || fail "stapler staple failed after 6 tries"
  sleep "${MIND_STAPLE_WAIT:-10}"
done
xcrun stapler validate "$dmg" >/dev/null || fail "the dmg does not validate after stapling"
echo "notarize-dmg: $dmg notarized ($id) and stapled"
