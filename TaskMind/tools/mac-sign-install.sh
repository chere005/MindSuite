#!/bin/bash
# Sign, notarize, staple, verify and ONLY THEN install a built macOS app.
#
#   sh tools/mac-sign-install.sh [options] path/to/Built.app
#
#   --install-dir DIR           where the verified copy goes (default /Applications)
#   --no-install                stop after verification; the result is kept in --out
#   --out DIR                   keep the signed, stapled copy in DIR (default: a temp dir that is removed)
#   --entitlements FILE         entitlements for the top-level app
#   --nested-entitlements FILE  entitlements for nested apps/helpers (Electron helpers need them)
#   --identity "Developer ID Application: Name (TEAMID)"   (see below)
#   --notary-profile NAME       notarytool keychain profile (default DisplayMind)
#   --notary-timeout 30m        how long to wait for Apple
#   --no-relaunch               do not reopen the app when it was running
#   --verify-only               assert an existing app (signed, notarized, stapled, arm64) and exit
#
# WHAT IT GUARANTEES. The installed copy is Developer ID signed with the hardened runtime and a secure
# timestamp, notarized, stapled, arm64 only. Anything less stops the script BEFORE the install directory is
# touched, and the copy that was installed stays. There is no flag that installs an ad hoc or unnotarized app.
#
# THE IDENTITY is always a FULL name ("Developer ID Application: Name (TEAMID)"), never a hash and never found
# by searching: several identities coexist on the machine and codesign picks wrongly among a partial match.
# Order: --identity, $MIND_SIGN_IDENTITY, MAC_SIGN_IDENTITY in .local/machine.env; else the single
# "Developer ID Application" identity whose team is APPLE_TEAM_ID (env or .local/machine.env), passed on by its
# full name. No tracked file carries the name or the team (CoreMind/bin/check-personal-data.sh).
#
# THE INPUT IS NEVER MODIFIED: the work happens on a copy (the build's own .app stays as the build left it).
#
# THE INSTALL: the verified copy is staged beside the target (same volume), verified AGAIN, the running app is
# asked to quit (only the copy at the target path), then the two are swapped with one renamex_np(RENAME_SWAP)
# call (a plain two-step mv where the volume has no swap), the swapped-in copy is verified once more, and only
# then is the old one deleted. A failure at any step puts the old copy back and reopens it when it was running.
#
# Exit codes: 0 done, 1 refused or failed (nothing installed, or the old copy restored), 2 usage.
#
# Tests: sh tools/ci/test-mac-sign-install.sh (stubbed codesign, notarytool, stapler, spctl, lipo, security).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)

INSTALL_DIR=/Applications
DO_INSTALL=1
OUT_DIR=
ENTITLEMENTS=
NESTED_ENTITLEMENTS=
IDENTITY="${MIND_SIGN_IDENTITY:-}"
PROFILE="${MIND_NOTARY_PROFILE:-}"
NOTARY_TIMEOUT=30m
RELAUNCH=1
VERIFY_ONLY=0
APP_IN=

die() { echo "mac-sign-install: $*" >&2; exit 1; }
usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
say() { echo "mac-sign-install: $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR=${2:?}; shift 2 ;;
    --no-install) DO_INSTALL=0; shift ;;
    --out) OUT_DIR=${2:?}; shift 2 ;;
    --entitlements) ENTITLEMENTS=${2:?}; shift 2 ;;
    --nested-entitlements) NESTED_ENTITLEMENTS=${2:?}; shift 2 ;;
    --identity) IDENTITY=${2:?}; shift 2 ;;
    --notary-profile) PROFILE=${2:?}; shift 2 ;;
    --notary-timeout) NOTARY_TIMEOUT=${2:?}; shift 2 ;;
    --no-relaunch) RELAUNCH=0; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) usage ;;
    -*) echo "mac-sign-install: unknown option $1" >&2; usage ;;
    *) [ -z "$APP_IN" ] || usage; APP_IN=$1; shift ;;
  esac
done
[ -n "$APP_IN" ] || usage
[ "$(uname -s)" = Darwin ] || die 'macOS is required.'
[ -d "$APP_IN" ] && [ -f "$APP_IN/Contents/Info.plist" ] || die "not an app bundle: $APP_IN"
case "$APP_IN" in *.app|*.app/) ;; *) die "not a .app: $APP_IN" ;; esac
APP_IN=${APP_IN%/}
[ -z "$ENTITLEMENTS" ] || [ -f "$ENTITLEMENTS" ] || die "no such entitlements file: $ENTITLEMENTS"
[ -z "$NESTED_ENTITLEMENTS" ] || [ -f "$NESTED_ENTITLEMENTS" ] || die "no such entitlements file: $NESTED_ENTITLEMENTS"

# ---------------------------------------------------------------------------------------------------------
# Per-machine values (untracked): identity, team, notary profile.
# ---------------------------------------------------------------------------------------------------------
TEAM="${APPLE_TEAM_ID:-}"
if [ -f "$HERE/machine-env.sh" ]; then
  # shellcheck source=machine-env.sh
  . "$HERE/machine-env.sh"
  if machine_load "$ROOT" 2>/dev/null; then
    [ -n "$IDENTITY" ] || IDENTITY="${MAC_SIGN_IDENTITY:-}"
    [ -n "$PROFILE" ] || PROFILE="${NOTARY_PROFILE:-}"
    [ -n "$TEAM" ] || TEAM="${APPLE_TEAM_ID:-}"
  fi
fi
PROFILE=${PROFILE:-DisplayMind}

if [ -z "$IDENTITY" ]; then
  [ -n "$TEAM" ] || die "no signing identity: pass --identity, set MIND_SIGN_IDENTITY, or put MAC_SIGN_IDENTITY (or APPLE_TEAM_ID) in .local/machine.env"
  # Exactly one Developer ID Application identity of THIS team; its full name is what codesign gets.
  found=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) [0-9A-Fa-f]\{40\} "\(Developer ID Application: .* ('"$TEAM"')\)"$/\1/p')
  [ -n "$found" ] || die "no valid 'Developer ID Application' identity for team $TEAM in the keychain"
  [ "$(printf '%s\n' "$found" | wc -l | tr -d ' ')" = 1 ] || die "more than one 'Developer ID Application' identity for team $TEAM; set MAC_SIGN_IDENTITY to the full name"
  IDENTITY=$found
fi
case "$IDENTITY" in
  "Developer ID Application: "*" ("??????????")") ;;
  *) die "the identity must be a full 'Developer ID Application: Name (TEAMID)' name" ;;
esac
ID_TEAM=${IDENTITY##*(}; ID_TEAM=${ID_TEAM%)}
[ -z "$TEAM" ] || [ "$TEAM" = "$ID_TEAM" ] || die "the identity's team does not match APPLE_TEAM_ID"
TEAM=$ID_TEAM

# ---------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }

# Every regular file in the bundle that is Mach-O, one path per line (symlinks are never followed).
macho_files() {
  find "$1" -type f -print0 | while IFS= read -r -d '' f; do
    case "$(file -b "$f" 2>/dev/null)" in *Mach-O*) printf '%s\n' "$f" ;; esac
  done
}

# Nested code bundles (not the top-level app), one per line.
nested_bundles() {
  find "$1" -mindepth 2 -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' -o -name '*.appex' -o -name '*.plugin' -o -name '*.bundle' \) -print
}

# deepest first
by_depth() { awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-; }

assert_arm64() { # app  -> every Mach-O is exactly arm64
  _bad=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    archs=$(lipo -archs "$f" 2>/dev/null || echo unknown)
    if [ "$archs" != arm64 ]; then say "not arm64-only: ${f#"$1"/} ($archs)"; _bad=1; fi
  done <<EOF
$(macho_files "$1")
EOF
  [ "$_bad" = 0 ]
}

# The full verification: what the install and the release both promise.
verify_app() { # app
  _app=$1
  codesign --verify --deep --strict "$_app" >/dev/null 2>&1 || { say "codesign --verify --deep --strict failed: $_app"; return 1; }
  _info=$(codesign -dvv "$_app" 2>&1) || { say "codesign -dvv failed: $_app"; return 1; }
  case "$_info" in *"Signature=adhoc"*) say "ad hoc signature: $_app"; return 1 ;; esac
  grep -q '^Authority=Developer ID Application: ' <<<"$_info" || { say "not signed by a Developer ID Application identity"; return 1; }
  grep -Fxq "TeamIdentifier=$TEAM" <<<"$_info" || { say "wrong or missing TeamIdentifier (want $TEAM)"; return 1; }
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$_info" || { say "hardened runtime is not on"; return 1; }
  grep -q '^Timestamp=' <<<"$_info" || { say "no secure timestamp"; return 1; }
  xcrun stapler validate "$_app" >/dev/null 2>&1 || { say "stapler validate failed (not notarized/stapled): $_app"; return 1; }
  _spctl=$(spctl --assess --type execute --verbose=4 "$_app" 2>&1) || { say "spctl rejected: $_spctl"; return 1; }
  case "$_spctl" in *"Notarized Developer ID"*) ;; *) say "spctl does not say Notarized Developer ID: $_spctl"; return 1 ;; esac
  assert_arm64 "$_app" || return 1
  return 0
}

# ---------------------------------------------------------------------------------------------------------
if [ "$VERIFY_ONLY" = 1 ]; then
  verify_app "$APP_IN" || die "verification failed: $APP_IN"
  say "verified (Developer ID, hardened runtime, timestamp, notarized, stapled, arm64): $APP_IN"
  exit 0
fi

NAME=$(basename "$APP_IN")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mac-sign-install.XXXXXX")
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
APP="$WORK/$NAME"

say "copying $NAME for signing (the build output stays untouched)"
ditto "$APP_IN" "$APP"
# Resource forks, Finder info and quarantine are "detritus" to codesign.
xattr -cr "$APP"

EXEC=$(plist "$APP" CFBundleExecutable) || die 'Info.plist has no CFBundleExecutable'
[ -f "$APP/Contents/MacOS/$EXEC" ] || die "the bundle has no Contents/MacOS/$EXEC"
BUNDLE_ID=$(plist "$APP" CFBundleIdentifier) || die 'Info.plist has no CFBundleIdentifier'
VERSION=$(plist "$APP" CFBundleShortVersionString || true)

# arm64-only, before anything is signed: an x86_64 or universal slice never ships.
assert_arm64 "$APP" || die 'the app is not arm64 only; macOS builds here are Apple Silicon only'

sign_one() { # path  [entitlements]
  _out=$(if [ -n "${2:-}" ]; then
    codesign --force --timestamp --options runtime --entitlements "$2" --sign "$IDENTITY" "$1" 2>&1
  else
    codesign --force --timestamp --options runtime --sign "$IDENTITY" "$1" 2>&1
  fi) || { printf '%s\n' "$_out" >&2; die "codesign failed on ${1#"$WORK"/}"; }
}

say "signing inside-out as $IDENTITY"
# 1. every Mach-O file, deepest first (dylibs, .node addons, helper executables)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # the main executable of the top-level app is sealed by the final signing of the bundle
  [ "$f" = "$APP/Contents/MacOS/$EXEC" ] && continue
  sign_one "$f"
done <<EOF
$(macho_files "$APP" | by_depth)
EOF
# 2. nested bundles, deepest first
while IFS= read -r b; do
  [ -n "$b" ] || continue
  case "$b" in
    *.app|*.xpc|*.appex) sign_one "$b" "$NESTED_ENTITLEMENTS" ;;
    *) sign_one "$b" ;;
  esac
done <<EOF
$(nested_bundles "$APP" | by_depth)
EOF
# 3. the app itself
sign_one "$APP" "$ENTITLEMENTS"

# Refuse an ad hoc or otherwise wrong signature BEFORE Apple sees it or the install directory does.
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || die 'the signed app fails codesign --verify --deep --strict'
INFO=$(codesign -dvv "$APP" 2>&1)
case "$INFO" in *"Signature=adhoc"*) die 'the result is ad hoc signed; refusing' ;; esac
grep -q '^Authority=Developer ID Application: ' <<<"$INFO" || die 'the result is not signed by a Developer ID Application identity; refusing'
grep -Fxq "TeamIdentifier=$TEAM" <<<"$INFO" || die 'the result has the wrong team identifier; refusing'
grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' <<<"$INFO" || die 'the result has no hardened runtime; refusing'
grep -q '^Timestamp=' <<<"$INFO" || die 'the result has no secure timestamp; refusing'

# ---------------------------------------------------------------------------------------------------------
# Notarize and staple
# ---------------------------------------------------------------------------------------------------------
say "notarizing with the keychain profile '$PROFILE' (this waits for Apple)"
ZIP="$WORK/notarize.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
RESULT="$WORK/notary.json"
if ! xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait --timeout "$NOTARY_TIMEOUT" --output-format json > "$RESULT" 2> "$WORK/notary.err"; then
  sed 's/^/  /' "$WORK/notary.err" >&2 || true
  die 'notarytool submit failed'
fi
STATUS=$(plutil -extract status raw -o - "$RESULT" 2>/dev/null || echo unknown)
SUB_ID=$(plutil -extract id raw -o - "$RESULT" 2>/dev/null || echo unknown)
if [ "$STATUS" != Accepted ]; then
  say "Apple answered '$STATUS' for submission $SUB_ID; its log:"
  xcrun notarytool log "$SUB_ID" --keychain-profile "$PROFILE" 2>&1 | sed 's/^/  /' >&2 || true
  die 'notarization was not accepted'
fi
say "notarization accepted ($SUB_ID); stapling"
n=0
until xcrun stapler staple "$APP" >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -lt 6 ] || die 'stapler staple failed after 6 tries (the ticket may not be published yet)'
  sleep "${MIND_STAPLE_WAIT:-10}"
done

verify_app "$APP" || die 'the finished app fails verification; nothing was installed'
say "verified: Developer ID, hardened runtime, timestamp, notarized, stapled, arm64${VERSION:+ ($NAME $VERSION)}"

if [ -n "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR"
  rm -rf "${OUT_DIR:?}/$NAME"
  ditto "$APP" "$OUT_DIR/$NAME"
  say "kept the signed copy at $OUT_DIR/$NAME"
fi
[ "$DO_INSTALL" = 1 ] || { [ -n "$OUT_DIR" ] || say 'nothing kept: --no-install without --out'; exit 0; }

# ---------------------------------------------------------------------------------------------------------
# Install: stage, verify, quit, swap, verify, delete the old one. The old copy stays on any failure.
# ---------------------------------------------------------------------------------------------------------
[ -d "$INSTALL_DIR" ] || die "no such install directory: $INSTALL_DIR"
DEST="$INSTALL_DIR/$NAME"
STAGE="$INSTALL_DIR/.${NAME}.new.$$"
OLD=
WAS_RUNNING=0
rm -rf "$STAGE"
ditto "$APP" "$STAGE" || { rm -rf "$STAGE"; die "could not stage the new copy in $INSTALL_DIR"; }
if ! verify_app "$STAGE"; then rm -rf "$STAGE"; die 'the staged copy fails verification; the installed copy was not touched'; fi

running_pids() { pgrep -f -- "$DEST/Contents/MacOS/" 2>/dev/null || true; }

reopen_old() { [ "$WAS_RUNNING" = 1 ] && [ "$RELAUNCH" = 1 ] && [ -d "$DEST" ] && open "$DEST" >/dev/null 2>&1 || true; }

if [ -d "$DEST" ] && [ -n "$(running_pids)" ]; then
  WAS_RUNNING=1
  say "$NAME is running from $DEST; asking it to quit"
  osascript -e "tell application \"$DEST\" to quit" >/dev/null 2>&1 || true
  i=0; while [ -n "$(running_pids)" ] && [ "$i" -lt "${MIND_QUIT_WAIT:-20}" ]; do sleep 1; i=$((i + 1)); done
  if [ -n "$(running_pids)" ]; then
    # shellcheck disable=SC2046
    kill -TERM $(running_pids) 2>/dev/null || true
    i=0; while [ -n "$(running_pids)" ] && [ "$i" -lt 5 ]; do sleep 1; i=$((i + 1)); done
  fi
  if [ -n "$(running_pids)" ]; then
    rm -rf "$STAGE"
    die "$NAME would not quit; the installed copy was not replaced"
  fi
fi

swap_dirs() { # a b : exchange two directories atomically; non-zero when the volume has no swap
  [ "${MIND_NO_SWAP:-0}" = 1 ] && return 1
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1" "$2" <<'PY'
import ctypes, ctypes.util, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
fn = libc.renamex_np
fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
RENAME_SWAP = 2
sys.exit(0 if fn(sys.argv[1].encode(), sys.argv[2].encode(), RENAME_SWAP) == 0 else 1)
PY
}

if [ -d "$DEST" ]; then
  if swap_dirs "$DEST" "$STAGE"; then
    OLD=$STAGE          # after the swap the staging name holds the OLD copy
  else
    OLD="$INSTALL_DIR/.${NAME}.old.$$"
    mv "$DEST" "$OLD" || { rm -rf "$STAGE"; reopen_old; die 'could not move the installed copy aside'; }
    if ! mv "$STAGE" "$DEST"; then mv "$OLD" "$DEST" || true; rm -rf "$STAGE"; reopen_old; die 'could not move the new copy into place; the old one is back'; fi
  fi
else
  mv "$STAGE" "$DEST" || { rm -rf "$STAGE"; die 'could not move the new copy into place'; }
fi

if ! verify_app "$DEST"; then
  say 'the installed copy fails verification; putting the old one back'
  if [ -n "$OLD" ] && [ -d "$OLD" ]; then
    rm -rf "$DEST.bad.$$" && mv "$DEST" "$DEST.bad.$$" && mv "$OLD" "$DEST" && rm -rf "$DEST.bad.$$"
  else
    rm -rf "$DEST"
  fi
  reopen_old
  die 'install rolled back'
fi
[ -z "$OLD" ] || rm -rf "$OLD"
say "installed $DEST${VERSION:+ ($VERSION)}"
if [ "$WAS_RUNNING" = 1 ] && [ "$RELAUNCH" = 1 ]; then open "$DEST" >/dev/null 2>&1 || say 'could not reopen the app'; fi
echo "$DEST"
