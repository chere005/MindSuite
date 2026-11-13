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
if [ "$1" = attach ]; then while [ "$1" != -mountpoint ]; do shift; done; mkdir "$2/Example.app"; fi
if [ "$1" = detach ]; then rmdir "$2/Example.app"; fi
SH
cat > "$tmp/bin/codesign" <<'SH'
#!/bin/sh
if [ "$1" = -dv ]; then echo "TeamIdentifier=${TEST_TEAM:-TEAMID0000}" >&2; fi
SH
cat > "$tmp/bin/spctl" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$tmp/bin/hdiutil" "$tmp/bin/codesign" "$tmp/bin/xcrun" "$tmp/bin/spctl"
bash tools/ci/verify-macos-dmg.sh "$tmp/example.dmg" Example >/dev/null
if TEST_TEAM=OTHERTEAM0 bash tools/ci/verify-macos-dmg.sh "$tmp/example.dmg" Example >/dev/null 2>&1; then echo 'wrong signing team accepted' >&2; exit 1; fi
if TEST_STAPLE=fail bash tools/ci/verify-macos-dmg.sh "$tmp/example.dmg" Example >/dev/null 2>&1; then echo 'unstapled app accepted' >&2; exit 1; fi
echo 'macOS signing guards passed'
