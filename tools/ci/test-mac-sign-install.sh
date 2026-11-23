#!/bin/bash
# Proves CalMind/tools/mac-sign-install.sh (the origin of every app's copy) with stubbed codesign, notarytool,
# stapler, spctl, lipo, security, osascript and open: nothing reaches Apple, the keychain or /Applications.
#   bash tools/ci/test-mac-sign-install.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
SCRIPT="$PWD/CalMind/tools/mac-sign-install.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/mac-sign-install-test.XXXXXX")
trap 'pkill -f "$tmp/" 2>/dev/null || true; rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
FULL='Developer ID Application: Test Person (TEAMID0000)'

# ---- stubs ---------------------------------------------------------------------------------------------------
cat > "$tmp/bin/codesign" <<'SH'
#!/bin/bash
# state lives in <bundle>/Contents/_sig: the identity ("adhoc" for ad hoc)
echo "codesign $*" >> "$CALLS"
case "$1" in
  --verify)
    p=${@: -1}
    [ "$(cat "$p/Contents/_sig" 2>/dev/null)" != broken ] || exit 1
    if [ "${TEST_FAIL_DEST:-0}" = 1 ]; then case "$p" in */install/Example.app) exit 1 ;; esac; fi
    [ -f "$p/Contents/_sig" ] || exit 1
    exit 0 ;;
  -dvv)
    p=$2; sig=$(cat "$p/Contents/_sig" 2>/dev/null || echo adhoc)
    if [ "$sig" = adhoc ]; then echo "Signature=adhoc" >&2; echo "TeamIdentifier=not set" >&2; exit 0; fi
    echo "Authority=$sig" >&2
    echo "CodeDirectory v=20500 size=1 flags=0x$([ "${TEST_NORUNTIME:-0}" = 1 ] && echo 0 || echo 10000)($([ "${TEST_NORUNTIME:-0}" = 1 ] && echo none || echo runtime)) hashes=1+3 location=embedded" >&2
    [ "${TEST_NOTS:-0}" = 1 ] || echo "Timestamp=Nov 23, 2026 at 1:00:00 AM" >&2
    echo "TeamIdentifier=${TEST_TEAM:-TEAMID0000}" >&2
    exit 0 ;;
esac
# signing call: the last argument is the path; --sign NAME gives the identity
path=${@: -1}; ident=; prev=
for a in "$@"; do [ "$prev" = --sign ] && ident=$a; prev=$a; done
[ -d "$path/Contents" ] || exit 0       # a loose file or a nested bundle: nothing to record at the top
if [ "${TEST_ADHOC:-0}" = 1 ]; then echo adhoc > "$path/Contents/_sig"; else echo "$ident" > "$path/Contents/_sig"; fi
SH
cat > "$tmp/bin/xcrun" <<'SH'
#!/bin/bash
echo "xcrun $*" >> "$CALLS"
case "$1" in
  notarytool)
    case "$2" in
      submit) [ "${TEST_NOTARY:-ok}" != error ] || { echo "network down" >&2; exit 1; }
              printf '{"id":"sub-123","status":"%s","message":"x"}\n' "$([ "${TEST_NOTARY:-ok}" = invalid ] && echo Invalid || echo Accepted)" ;;
      log) echo '{"issues":[{"message":"stub issue"}]}' ;;
    esac ;;
  stapler)
    app=${@: -1}
    case "$2" in
      staple) [ "${TEST_STAPLE:-ok}" = ok ] || exit 65; touch "$app/Contents/_stapled" ;;
      validate) [ -f "$app/Contents/_stapled" ] ;;
    esac ;;
esac
SH
cat > "$tmp/bin/spctl" <<'SH'
#!/bin/bash
echo "spctl $*" >> "$CALLS"
echo "${@: -1}: accepted" >&2
echo "source=${TEST_SPCTL_SOURCE:-Notarized Developer ID}" >&2
SH
cat > "$tmp/bin/lipo" <<'SH'
#!/bin/bash
echo "${TEST_ARCHS:-arm64}"
SH
cat > "$tmp/bin/security" <<'SH'
#!/bin/bash
[ "$1" = find-identity ] || exit 0
echo '  1) 1111111111111111111111111111111111111111 "Apple Development: someone@example.com (AAAAAAAAAA)"'
echo '  2) 2222222222222222222222222222222222222222 "Developer ID Application: Test Person (TEAMID0000)"'
[ "${TEST_TWO_IDS:-0}" = 0 ] || echo '  3) 3333333333333333333333333333333333333333 "Developer ID Application: Test Person Two (TEAMID0000)"'
echo '  4) 4444444444444444444444444444444444444444 "Developer ID Application: Other Person (OTHERTEAM1)"'
echo '     4 valid identities found'
SH
cat > "$tmp/bin/osascript" <<'SH'
#!/bin/bash
echo "osascript $*" >> "$CALLS"
[ "${TEST_STUBBORN:-0}" = 1 ] || pkill -f "$INSTALL_PROBE" 2>/dev/null || true
SH
cat > "$tmp/bin/open" <<'SH'
#!/bin/bash
echo "open $*" >> "$CALLS"
SH
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" CALLS="$tmp/calls"
export MIND_STAPLE_WAIT=0 MIND_QUIT_WAIT=2
unset APPLE_TEAM_ID MIND_SIGN_IDENTITY MIND_NOTARY_PROFILE NOTARY_PROFILE MAC_SIGN_IDENTITY MIND_NO_SWAP
export MIND_MACHINE_ENV="$tmp/machine.env"
printf 'APPLE_TEAM_ID=TEAMID0000\n' > "$tmp/machine.env"

# ---- fixture app ---------------------------------------------------------------------------------------------
make_app() { # dir marker
  local d=$1/Example.app
  rm -rf "$d"; mkdir -p "$d/Contents/MacOS" "$d/Contents/Frameworks/Helper.app/Contents/MacOS" "$d/Contents/Frameworks/lib"
  cat > "$d/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>example</string>
<key>CFBundleIdentifier</key><string>com.example.fixture</string>
<key>CFBundleShortVersionString</key><string>$2</string>
</dict></plist>
PL
  cp /bin/ls "$d/Contents/MacOS/example"
  cp /bin/ls "$d/Contents/Frameworks/Helper.app/Contents/MacOS/helper"
  cp /bin/ls "$d/Contents/Frameworks/lib/libx.dylib"
  cat > "$d/Contents/Frameworks/Helper.app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>helper</string></dict></plist>
PL
}
fail() { echo "FAIL: $*" >&2; exit 1; }
expect_fail() { # name, cmd...
  local name=$1; shift
  if "$@" > "$tmp/out" 2>&1; then cat "$tmp/out" >&2; fail "$name was accepted"; fi
}
reset() { : > "$CALLS"; rm -rf "$tmp/in" "$tmp/install" "$tmp/out-dir"; mkdir -p "$tmp/in" "$tmp/install"; make_app "$tmp/in" 2.0.0; }
run() { bash "$SCRIPT" --install-dir "$tmp/install" "$@" "$tmp/in/Example.app"; }

# 1. happy path over an existing older copy, with entitlements
reset
make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
printf '<plist/>' > "$tmp/ent.plist"
run --entitlements "$tmp/ent.plist" > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'happy path failed'; }
[ -f "$tmp/install/Example.app/Contents/_stapled" ] || fail 'installed copy is not stapled'
[ "$(cat "$tmp/install/Example.app/Contents/_sig")" = "$FULL" ] || fail 'installed copy is not signed with the full name'
[ ! -e "$tmp/install/Example.app/Contents/OLDMARK" ] || fail 'the old copy was not replaced'
ls -A "$tmp/install" | grep -q '^\.' && fail "staging leftovers: $(ls -A "$tmp/install")"
[ ! -e "$tmp/in/Example.app/Contents/_sig" ] || fail 'the build output was modified'
grep -q "plutil" /dev/null || true
grep '^codesign .*--sign' "$CALLS" | grep -vF -- "--sign $FULL " | grep -vF -- "--sign $FULL" >/dev/null && fail 'a signing call did not use the full identity name'
grep -F -- '--options runtime' "$CALLS" | grep -qF -- '--timestamp' || fail 'runtime/timestamp flags missing'
grep -q 'notarytool submit .*--keychain-profile DisplayMind' "$CALLS" || fail 'notarytool did not use the DisplayMind profile'
# inside-out order: dylib and helper executable before Helper.app before the top-level app
n_lib=$(grep -n 'libx.dylib' "$CALLS" | head -1 | cut -d: -f1); n_hlp=$(grep -n 'Helper.app$' "$CALLS" | head -1 | cut -d: -f1)
n_top=$(grep -n -- "--entitlements $tmp/ent.plist" "$CALLS" | head -1 | cut -d: -f1)
[ -n "$n_lib" ] && [ -n "$n_hlp" ] && [ -n "$n_top" ] && [ "$n_lib" -lt "$n_hlp" ] && [ "$n_hlp" -lt "$n_top" ] || fail "not signed inside-out ($n_lib $n_hlp $n_top)"
grep -q -- 'staple' "$CALLS" || fail 'never stapled'
grep -q 'spctl --assess --type execute' "$CALLS" || fail 'never ran spctl'

# 2. --out keeps a copy; --no-install touches nothing in the install dir
reset
run --no-install --out "$tmp/out-dir" > "$tmp/out" 2>&1 || fail '--no-install failed'
[ -f "$tmp/out-dir/Example.app/Contents/_stapled" ] || fail '--out copy missing'
[ -z "$(ls -A "$tmp/install")" ] || fail '--no-install touched the install dir'

# 3. the MIND_NO_SWAP path (two-step move) also replaces and cleans up
reset; make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
MIND_NO_SWAP=1 run > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'no-swap path failed'; }
[ ! -e "$tmp/install/Example.app/Contents/OLDMARK" ] && [ -f "$tmp/install/Example.app/Contents/_stapled" ] || fail 'no-swap path did not replace'
[ -z "$(ls -A "$tmp/install" | grep '^\.' || true)" ] || fail 'no-swap path left leftovers'

# 4. refusals: nothing is installed and the old copy stays
refuse() { # name, env assignment, expected leftover check
  local name=$1; shift
  reset; make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
  if env "$@" bash "$SCRIPT" --install-dir "$tmp/install" "$tmp/in/Example.app" > "$tmp/out" 2>&1; then cat "$tmp/out" >&2; fail "$name was accepted"; fi
  [ -f "$tmp/install/Example.app/Contents/OLDMARK" ] || fail "$name: the old copy was not kept"
  [ -z "$(ls -A "$tmp/install" | grep '^\.' || true)" ] || fail "$name: leftovers $(ls -A "$tmp/install")"
}
refuse 'ad hoc output' TEST_ADHOC=1
grep -q notarytool "$CALLS" && fail 'an ad hoc app reached notarytool'
refuse 'no hardened runtime' TEST_NORUNTIME=1
refuse 'no timestamp' TEST_NOTS=1
refuse 'wrong team' TEST_TEAM=OTHERTEAM1
refuse 'rejected notarization' TEST_NOTARY=invalid
grep -q 'notarytool log' "$CALLS" || fail 'a rejected submission did not fetch Apple'"'"'s log'
refuse 'notarytool error' TEST_NOTARY=error
refuse 'staple failure' TEST_STAPLE=fail
refuse 'not notarized per spctl' TEST_SPCTL_SOURCE='Developer ID'
refuse 'x86_64 slice' TEST_ARCHS='x86_64 arm64'
grep -q -- '--sign' "$CALLS" && fail 'an x86_64 app was signed'
# a failure AFTER the swap rolls back
reset; make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
if TEST_FAIL_DEST=1 bash "$SCRIPT" --install-dir "$tmp/install" "$tmp/in/Example.app" > "$tmp/out" 2>&1; then fail 'post-swap failure accepted'; fi
[ -f "$tmp/install/Example.app/Contents/OLDMARK" ] || fail 'post-swap failure did not restore the old copy'
[ -z "$(ls -A "$tmp/install" | grep '^\.' || true)" ] || fail "rollback leftovers $(ls -A "$tmp/install")"
grep -q 'rolled back' "$tmp/out" || fail 'rollback not reported'

# 5. a running app is quit before the swap and reopened afterwards; a stubborn one blocks the install
reset; make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
printf '#!/bin/sh\nexec sleep 300\n' > "$tmp/install/Example.app/Contents/MacOS/example"
INSTALL_PROBE="$tmp/install/Example.app/Contents/MacOS/" ; export INSTALL_PROBE
( exec -a "$INSTALL_PROBE/example" sleep 300 ) >/dev/null 2>&1 &
sleep 1
pgrep -f -- "$INSTALL_PROBE" >/dev/null || fail 'test process did not start'
run > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'install over a running app failed'; }
grep -q '^osascript' "$CALLS" || fail 'the running app was not asked to quit'
grep -q "^open $tmp/install/Example.app" "$CALLS" || fail 'the app was not reopened'
[ -f "$tmp/install/Example.app/Contents/_stapled" ] || fail 'running-app install did not replace'
reset; make_app "$tmp/install" 1.0.0; echo old > "$tmp/install/Example.app/Contents/OLDMARK"
( trap '' TERM; exec -a "$INSTALL_PROBE/example" sleep 300 ) >/dev/null 2>&1 &
sleep 1
if TEST_STUBBORN=1 run > "$tmp/out" 2>&1; then fail 'a stubborn running app was replaced'; fi
[ -f "$tmp/install/Example.app/Contents/OLDMARK" ] || fail 'the stubborn app lost its old copy'
pkill -9 -f -- "$INSTALL_PROBE" 2>/dev/null || true

# 6. identity resolution
reset
bash "$SCRIPT" --no-install --out "$tmp/out-dir" "$tmp/in/Example.app" > "$tmp/out" 2>&1 || { cat "$tmp/out" >&2; fail 'team lookup failed'; }
grep -qF -- "--sign $FULL" "$CALLS" || fail 'the team lookup did not pass the full name'
grep -qE 'sign (Apple|Other)' "$CALLS" && fail 'another identity was used'
reset; expect_fail 'two identities for one team' env TEST_TWO_IDS=1 bash "$SCRIPT" --no-install --out "$tmp/out-dir" "$tmp/in/Example.app"
grep -q 'more than one' "$tmp/out" || fail 'ambiguity not reported'
reset; expect_fail 'a partial identity name' bash "$SCRIPT" --identity 'Developer ID Application' --no-install --out "$tmp/out-dir" "$tmp/in/Example.app"
reset; expect_fail 'a hash' bash "$SCRIPT" --identity 1111111111111111111111111111111111111111 --no-install --out "$tmp/out-dir" "$tmp/in/Example.app"
reset; expect_fail 'no identity and no team' env MIND_MACHINE_ENV="$tmp/missing.env" bash "$SCRIPT" --no-install --out "$tmp/out-dir" "$tmp/in/Example.app"
reset; expect_fail 'identity of another team' env APPLE_TEAM_ID=OTHERTEAM1 bash "$SCRIPT" --identity "$FULL" --no-install --out "$tmp/out-dir" "$tmp/in/Example.app"
reset; printf 'MAC_SIGN_IDENTITY="%s"\nNOTARY_PROFILE=Other\n' "$FULL" > "$tmp/machine2.env"
env MIND_MACHINE_ENV="$tmp/machine2.env" bash "$SCRIPT" --no-install --out "$tmp/out-dir" "$tmp/in/Example.app" > "$tmp/out" 2>&1 || fail 'machine.env identity failed'
grep -q -- '--keychain-profile Other' "$CALLS" || fail 'NOTARY_PROFILE from machine.env was ignored'

# 7. --verify-only
reset; run --no-install --out "$tmp/out-dir" >/dev/null 2>&1
bash "$SCRIPT" --verify-only "$tmp/out-dir/Example.app" > "$tmp/out" 2>&1 || fail '--verify-only rejected a good app'
expect_fail '--verify-only on an unsigned app' bash "$SCRIPT" --verify-only "$tmp/in/Example.app"
expect_fail 'a non-app' bash "$SCRIPT" --no-install "$tmp/machine.env"

echo 'mac-sign-install guards passed'
