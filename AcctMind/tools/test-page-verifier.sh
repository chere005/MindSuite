#!/bin/sh
# Drive the real --verify branch against fixed, local curl replies. No network or credentials.
set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/acct-page-verify.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/client/tools" "$TMP/bin"
cp deploy.sh "$TMP/client/deploy.sh"
if [ -f tools/verify-page.mjs ]; then cp tools/verify-page.mjs "$TMP/client/tools/verify-page.mjs"; fi
printf '%s\n' 'SSH_DEST=fixture.invalid' 'SITE_URL=https://fixture.invalid' > "$TMP/client/deploy.conf"
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
headers=; next=
for arg do
  if [ "$next" = headers ]; then headers=$arg; next=; continue; fi
  case "$arg" in -D|--dump-header) next=headers ;; -L|--location|--location-trusted) exit 97 ;; esac
done
if [ -n "$headers" ]; then cp "$ACCT_VERIFY_RESPONSE" "$headers"; fi
case "$*" in *build.json*) printf '%s\n' '{}' ;; *) printf '%s' "$ACCT_VERIFY_STATUS" ;; esac
STUB
chmod +x "$TMP/bin/curl"
export ACCT_VERIFY_RESPONSE="$TMP/response" ACCT_VERIFY_STATUS
PATH="$TMP/bin:$PATH"; export PATH
PASS=0; FAIL=0
check() { # <label> <expected result> <code> <headers> [mode]
  label=$1; expected=$2; ACCT_VERIFY_STATUS=$3; headers=$4; mode=${5:---prod-only}
  printf 'HTTP/1.1 %s fixture\r\n%s\r\n\r\n' "$ACCT_VERIFY_STATUS" "$headers" > "$ACCT_VERIFY_RESPONSE"
  if (cd "$TMP/client" && sh deploy.sh --verify "$mode") > "$TMP/out" 2>&1; then result=pass; else result=fail; fi
  if [ "$result" = "$expected" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$label";
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$label"; cat "$TMP/out"; fi
}
check 'verify accepts legacy 401' pass 401 ''
check 'verify accepts allowed 200' pass 200 ''
check 'verify accepts the exact shared sign-in redirect' pass 303 'Location: /account/?next=%2FAcctMind%2F'
check 'TEST verify accepts its own absolute account URL' pass 303 'Location: https://test.fixture.invalid/account/?next=%2FAcctMind%2F' --test-only
check 'verify refuses a server error' fail 500 ''
check 'verify refuses an external account redirect' fail 303 'Location: https://external.invalid/account/?next=%2FAcctMind%2F'
check 'TEST verify refuses a production account redirect' fail 303 'Location: https://fixture.invalid/account/?next=%2FAcctMind%2F' --test-only
check 'verify refuses another app return path' fail 303 'Location: /account/?next=%2FMealMind%2F'
check 'verify refuses a redirect without Location' fail 303 ''
printf '%s\n' "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
