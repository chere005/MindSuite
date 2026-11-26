#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d "${TMPDIR:-/tmp}/mindsuite-sign-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/security" <<'SH'
#!/bin/sh
printf '%s\n' "$1" >> "$SECURITY_CALLS"
[ "$1" != find-identity ] || printf 'Developer ID Application: Example\n'
SH
cat > "$tmp/bin/openssl" <<'SH'
#!/bin/sh
printf 'temporary-keychain-password\n'
SH
cat > "$tmp/bin/xcrun" <<'SH'
#!/bin/sh
if [ "$1" = notarytool ]; then [ "${TEST_NOTARY:-ok}" = ok ]; else [ "${TEST_STAPLE:-ok}" = ok ]; fi
SH
chmod +x "$tmp/bin/security" "$tmp/bin/openssl" "$tmp/bin/xcrun"
export PATH="$tmp/bin:$PATH" RUNNER_TEMP="$tmp" GITHUB_ENV="$tmp/env" SECURITY_CALLS="$tmp/security-calls"
export APPLE_CERTIFICATE=Y2VydA== APPLE_CERTIFICATE_PASSWORD=pass APPLE_SIGNING_IDENTITY='Developer ID Application: Example' APPLE_ID=example APPLE_PASSWORD=notary APPLE_TEAM_ID=TEAMID0000
unset APPLE_PASSWORD
if bash tools/ci/macos-signing.sh > "$tmp/out" 2>&1; then echo 'missing secret was accepted' >&2; exit 1; fi
[ ! -e "$SECURITY_CALLS" ] || { echo 'keychain touched with missing secret' >&2; exit 1; }
export APPLE_PASSWORD=notary
bash tools/ci/macos-signing.sh > "$tmp/out" 2>&1
[ ! -e "$tmp/mindsuite-signing.p12" ] || { echo 'temporary certificate not removed' >&2; exit 1; }
grep -q '^MINDSUITE_SIGNING_KEYCHAIN=' "$GITHUB_ENV"
if TEST_NOTARY=fail bash tools/ci/macos-signing.sh > "$tmp/out" 2>&1; then echo 'rejected notarization credentials were accepted' >&2; exit 1; fi
cat > "$tmp/bin/hdiutil" <<'SH'
#!/bin/sh
if [ "$1" = attach ]; then while [ "$1" != -mountpoint ]; do shift; done; mkdir -p "$2/Example.app/Contents/MacOS"; cp /bin/ls "$2/Example.app/Contents/MacOS/example"; fi
if [ "$1" = detach ]; then rm -rf "$2/Example.app"; fi
SH
# codesign stub: the dmg and the app answer from knobs; every case starts from "good"
cat > "$tmp/bin/codesign" <<'SH'
#!/bin/sh
case "$1" in
  --verify) case "$*" in *.dmg) [ "${TEST_DMG_SIGNED:-1}" = 1 ] ;; *) [ "${TEST_APP_VERIFY:-1}" = 1 ] ;; esac ;;
  -dvv)
    case "$2" in *.dmg) who=dmg ;; *) who=app ;; esac
    if [ "${TEST_ADHOC:-}" = "$who" ]; then echo "Signature=adhoc" >&2; exit 0; fi
    echo "Authority=Developer ID Application: Example (${TEST_TEAM:-TEAMID0000})" >&2
    if [ "$who" = app ]; then
      if [ "${TEST_RUNTIME:-1}" = 1 ]; then echo "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+3" >&2; else echo "CodeDirectory v=20500 size=1 flags=0x0(none) hashes=1+3" >&2; fi
    fi
    [ "${TEST_TIMESTAMP:-1}" = 1 ] && echo "Timestamp=Nov 23, 2026" >&2
    echo "TeamIdentifier=${TEST_TEAM:-TEAMID0000}" >&2 ;;
  *) echo "codesign $*" >> "${SIGN_CALLS:-/dev/null}" ;;
esac
SH
cat > "$tmp/bin/xcrun" <<'SH'
#!/bin/sh
case "$1 $2" in
  "notarytool submit") echo "notarytool $*" >> "${SIGN_CALLS:-/dev/null}"; printf '{"id":"abc","status":"%s"}\n' "${TEST_NOTARY_STATUS:-Accepted}" ;;
  "notarytool log") echo '{}' ;;
  "notarytool history") [ "${TEST_NOTARY:-ok}" = ok ] ;;
  "stapler staple") echo "staple $*" >> "${SIGN_CALLS:-/dev/null}"; [ "${TEST_STAPLE_CMD:-ok}" = ok ] ;;
  "stapler validate")
    case "$3" in *.dmg) [ "${TEST_DMG_STAPLE:-ok}" = ok ] ;; *) [ "${TEST_STAPLE:-ok}" = ok ] ;; esac ;;
esac
SH
cat > "$tmp/bin/spctl" <<'SH'
#!/bin/sh
case "$*" in
  *.dmg*) [ "${TEST_DMG_SPCTL:-ok}" = ok ] || exit 3 ;;
  *) [ "${TEST_APP_SPCTL:-ok}" = ok ] || exit 3 ;;
esac
echo "source=${TEST_SOURCE:-Notarized Developer ID}" >&2
SH
cat > "$tmp/bin/lipo" <<'SH'
#!/bin/sh
echo "${TEST_ARCHS:-arm64}"
SH
# The host's /bin/ls is PE on Windows and ELF on Linux; only this mocked app is Mach-O.
cat > "$tmp/bin/file" <<'SH'
#!/bin/sh
case "$*" in
  */Example.app/Contents/MacOS/example|*/Example.app/Contents/MacOS/example.exe) echo "${TEST_FILE_KIND:-Mach-O 64-bit executable arm64}" ;;
  *) echo data ;;
esac
SH
cat > "$tmp/bin/plutil" <<'SH'
#!/bin/sh
node -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8")); if (!(process.argv[1] in o)) process.exit(1); console.log(o[process.argv[1]]);' "$2" "$6"
SH
chmod +x "$tmp/bin/"*
verify() { bash tools/ci/verify-macos-dmg.sh "$tmp/example.dmg" Example >/dev/null 2>&1; }
must_pass() { verify || { echo "good dmg rejected: $1" >&2; exit 1; }; }
must_fail() { if env "$@" bash tools/ci/verify-macos-dmg.sh "$tmp/example.dmg" Example >/dev/null 2>&1; then echo "accepted: $*" >&2; exit 1; fi; }
must_pass baseline
must_fail TEST_TEAM=OTHERTEAM0
must_fail TEST_STAPLE=fail                # app not stapled
must_fail TEST_DMG_STAPLE=fail            # dmg wrapper not stapled
must_fail TEST_DMG_SIGNED=0               # dmg wrapper unsigned
must_fail TEST_DMG_SPCTL=fail             # dmg wrapper rejected by Gatekeeper
must_fail TEST_APP_SPCTL=fail
must_fail TEST_SOURCE='Developer ID'      # signed but not notarized
must_fail TEST_ADHOC=dmg
must_fail TEST_ADHOC=app
must_fail TEST_RUNTIME=0                  # no hardened runtime
must_fail TEST_TIMESTAMP=0
must_fail TEST_ARCHS='x86_64 arm64'       # universal slice
must_fail TEST_ARCHS=x86_64
must_fail TEST_FILE_KIND=data            # no Mach-O executable in the app
must_fail TEST_APP_VERIFY=0
# notarize-dmg.sh: CI credentials, a local profile, and the refusals
export SIGN_CALLS="$tmp/sign-calls"; : > "$SIGN_CALLS"
touch "$tmp/example.dmg"
export APPLE_ID=example APPLE_PASSWORD=notary APPLE_TEAM_ID=TEAMID0000 MIND_STAPLE_WAIT=0
bash tools/ci/notarize-dmg.sh "$tmp/example.dmg" >/dev/null
grep -q -- '--apple-id example' "$SIGN_CALLS" && grep -q '^staple' "$SIGN_CALLS" || { echo 'notarize-dmg did not submit and staple' >&2; exit 1; }
: > "$SIGN_CALLS"
(unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; bash tools/ci/notarize-dmg.sh --profile DisplayMind "$tmp/example.dmg" >/dev/null)
grep -q -- '--keychain-profile DisplayMind' "$SIGN_CALLS" || { echo 'notarize-dmg ignored --profile' >&2; exit 1; }
if (unset APPLE_ID; TEST_NOTARY_STATUS=Invalid bash tools/ci/notarize-dmg.sh "$tmp/example.dmg") >/dev/null 2>&1; then echo 'notarize-dmg without credentials was accepted' >&2; exit 1; fi
if TEST_NOTARY_STATUS=Invalid bash tools/ci/notarize-dmg.sh "$tmp/example.dmg" >/dev/null 2>&1; then echo 'a rejected dmg was accepted' >&2; exit 1; fi
if (unset APPLE_SIGNING_IDENTITY; TEST_DMG_SIGNED=0 bash tools/ci/notarize-dmg.sh "$tmp/example.dmg") >/dev/null 2>&1; then echo 'an unsigned dmg was notarized' >&2; exit 1; fi
: > "$SIGN_CALLS"
TEST_DMG_SIGNED=0 bash tools/ci/notarize-dmg.sh "$tmp/example.dmg" >/dev/null
grep -q '^codesign --force --timestamp --sign Developer ID Application: Example' "$SIGN_CALLS" || { echo 'an unsigned dmg was not signed with the full identity' >&2; exit 1; }
if TEST_STAPLE_CMD=fail bash tools/ci/notarize-dmg.sh "$tmp/example.dmg" >/dev/null 2>&1; then echo 'a dmg that cannot be stapled was accepted' >&2; exit 1; fi
echo 'macOS signing guards passed'
