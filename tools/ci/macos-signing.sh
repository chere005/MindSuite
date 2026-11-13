#!/bin/bash
# Import only the configured Developer ID identity into the ephemeral runner keychain.
set -euo pipefail
for key in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!key:-}" ]]; then echo "::error::Missing required signing secret: $key" >&2; exit 1; fi
done
: "${RUNNER_TEMP:?}" "${GITHUB_ENV:?}"
keychain="$RUNNER_TEMP/mindsuite-signing.keychain-db"
certificate="$RUNNER_TEMP/mindsuite-signing.p12"
password=$(openssl rand -hex 32)
echo "::add-mask::$password"
umask 077
trap 'rm -f "$certificate"' EXIT
# shellcheck source=../../CoreMind/bin/python.sh
. "$(dirname "$0")/../../CoreMind/bin/python.sh"
mind_python
$MIND_PYTHON -c 'import base64, os, sys; sys.stdout.buffer.write(base64.b64decode(os.environ["APPLE_CERTIFICATE"], validate=True))' > "$certificate"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
security default-keychain -d user -s "$keychain"
security find-identity -v -p codesigning "$keychain" | grep -F -- "$APPLE_SIGNING_IDENTITY" >/dev/null
xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --output-format json >/dev/null
printf 'MINDSUITE_SIGNING_KEYCHAIN=%s\n' "$keychain" >> "$GITHUB_ENV"
