#!/bin/bash
# Fail the release before upload unless the packaged dmg AND the app inside it are what a user should run:
#   the dmg   signed by the team's Developer ID, notarized and stapled itself (spctl: Notarized Developer ID);
#   the app   Developer ID, hardened runtime, secure timestamp, notarized and stapled, every Mach-O arm64 only.
# (tools/ci/notarize-dmg.sh makes the dmg notarized and stapled; Tauri already notarizes the app inside it.)
# No Windows signature gate lives here: Windows installers are not Authenticode signed by decision.
#   bash tools/ci/verify-macos-dmg.sh <dmg> <AppName>      env: APPLE_TEAM_ID, RUNNER_TEMP (default $TMPDIR)
set -euo pipefail
dmg=${1:?dmg required}; name=${2:?app name required}; : "${APPLE_TEAM_ID:?}"
fail() { echo "verify-macos-dmg: $*" >&2; exit 1; }
base=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
mount=$(mktemp -d "$base/mindsuite-dmg.XXXXXX")
attached=0
cleanup() { if [[ $attached = 1 ]]; then hdiutil detach "$mount" -quiet || true; fi; rmdir "$mount" 2>/dev/null || true; }
trap cleanup EXIT

# Signature facts shared by the dmg and the app: Developer ID Application, this team, secure timestamp, not ad hoc.
check_identity() { # path label
  local info
  info=$(codesign -dvv "$1" 2>&1) || fail "$2: codesign -dvv failed"
  case "$info" in *"Signature=adhoc"*) fail "$2: ad hoc signature" ;; esac
  grep -q '^Authority=Developer ID Application: ' <<<"$info" || fail "$2: not signed by a Developer ID Application identity"
  grep -Fxq "TeamIdentifier=$APPLE_TEAM_ID" <<<"$info" || fail "$2: wrong or missing TeamIdentifier"
  grep -q '^Timestamp=' <<<"$info" || fail "$2: no secure timestamp"
  printf '%s\n' "$info"
}
accepted_notarized() { # spctl output
  case "$1" in *"Notarized Developer ID"*) ;; *) return 1 ;; esac
}

hdiutil verify "$dmg" >/dev/null

# --- the dmg wrapper itself
codesign --verify --strict "$dmg" >/dev/null 2>&1 || fail "the dmg signature does not verify"
check_identity "$dmg" "dmg" >/dev/null
xcrun stapler validate "$dmg" >/dev/null 2>&1 || fail "the dmg is not stapled (run tools/ci/notarize-dmg.sh before this check)"
out=$(spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg" 2>&1) || fail "spctl rejected the dmg: $out"
accepted_notarized "$out" || fail "spctl does not call the dmg Notarized Developer ID: $out"

# --- the app inside
hdiutil attach "$dmg" -nobrowse -readonly -quiet -mountpoint "$mount"
attached=1
app="$mount/$name.app"
test -d "$app" || fail "no $name.app in the dmg"
codesign --verify --deep --strict "$app" || fail "the app signature does not verify"
info=$(check_identity "$app" "app")
grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$info" || fail "app: the hardened runtime is not on"
xcrun stapler validate "$app" || fail "app: not stapled"
out=$(spctl --assess --type execute --verbose=4 "$app" 2>&1) || fail "spctl rejected the app: $out"
accepted_notarized "$out" || fail "spctl does not call the app Notarized Developer ID: $out"
# Apple Silicon only: every Mach-O in the bundle is exactly arm64.
count=0
while IFS= read -r -d '' f; do
  case "$(file -b "$f" 2>/dev/null)" in
    *Mach-O*)
      archs=$(lipo -archs "$f")
      [[ $archs = arm64 ]] || fail "$f is '$archs', not arm64"
      count=$((count + 1)) ;;
  esac
done < <(find "$app" -type f -print0)
[[ $count -gt 0 ]] || fail "no Mach-O file found in the app"
echo "$name: dmg and app are Developer ID signed, notarized, stapled and arm64 verified"
