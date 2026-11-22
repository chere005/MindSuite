#!/bin/sh
# Exercise the real deploy modes in a scratch client. Every network/build executable is a local stub.
set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/chef-targets.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
FIXTURE="$TMP/client"
mkdir -p "$FIXTURE/tools" "$FIXTURE/app/src" "$FIXTURE/app/assets" "$FIXTURE/app/dist" "$TMP/bin"
cp deploy.sh "$FIXTURE/deploy.sh"
cp tools/python.sh "$FIXTURE/tools/python.sh"
printf '%s\n' 'SSH_DEST=fixture.invalid' > "$FIXTURE/deploy.conf"
printf '%s\n' "export const space = 'chef';" > "$FIXTURE/app/src/api.ts"
printf '%s\n' 'fixture' > "$FIXTURE/app/dist/favicon.ico"
printf '%s\n' 'fixture' > "$FIXTURE/tools/web.htaccess"
printf '%s\n' 'EXPO_PUBLIC_API_URL=https://seancheren.com/calmind/api/index.php' > "$FIXTURE/.env"
# The live site, as far as deploy.sh can ask it.
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$CHEF_TARGET_LOG"
url=""; for a in "$@"; do case "$a" in http*) url=$a ;; esac; done
case " $* " in
  *'"action":"spaces"'*) printf '%s\n' '{"ok":true,"spaces":["chef"]}'; exit 0 ;;
esac
case "$url" in
  *)
    case " $* " in
      *' -o /dev/null '*) printf 200 ;;
      *) if [ -n "${CHEF_TARGET_WRONG_PAGE:-}" ]; then sed 's|<title>MealMind</title>|<title>CalMind</title>|' "$CHEF_TARGET_FIXTURE/app/dist/index.html"
         else cat "$CHEF_TARGET_FIXTURE/app/dist/index.html"; fi ;;
    esac ;;
esac
STUB
cat > "$TMP/bin/ssh" <<'STUB'
#!/bin/sh
printf 'ssh %s\n' "$*" >> "$CHEF_TARGET_LOG"
exit 0
STUB
cat > "$TMP/bin/npm" <<'STUB'
#!/bin/sh
printf 'npm %s\n' "$*" >> "$CHEF_TARGET_LOG"
case "$*" in
  'run export:web')
    printf 'export-env dotenv=%s api=%s\n' "${EXPO_NO_DOTENV:-missing}" "${EXPO_PUBLIC_API_URL:-}" >> "$CHEF_TARGET_LOG"
    mkdir -p app/dist/_expo/static/js/web
    printf '%s\n' '<!doctype html><head><title>MealMind</title><meta name="viewport" content="viewport-fit=cover"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><link rel="manifest" href="manifest.webmanifest"><script src="_expo/static/js/web/index-fixture.js"></script></head><body>mealmind-bg navigator.serviceWorker.register</body>' > app/dist/index.html
    printf '%s\n' "const space = 'chef';" > app/dist/_expo/static/js/web/index-fixture.js ;;
esac
STUB
for cmd in npx node rsync sips sleep; do
  cat > "$TMP/bin/$cmd" <<'STUB'
#!/bin/sh
printf '%s %s\n' "${0##*/}" "$*" >> "$CHEF_TARGET_LOG"
exit 0
STUB
  chmod +x "$TMP/bin/$cmd"
done
chmod +x "$TMP/bin/curl" "$TMP/bin/npm" "$TMP/bin/ssh"
export CHEF_TARGET_FIXTURE="$FIXTURE" CHEF_TARGET_LOG="$TMP/calls"
PATH="$TMP/bin:$PATH"; export PATH
unset CHEF_GATES_PASSED EXPO_PUBLIC_API_URL CHEF_TARGET_WRONG_PAGE
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; cat "$TMP/output"; }
run() { : > "$CHEF_TARGET_LOG"; (cd "$FIXTURE" && sh deploy.sh "$@") > "$TMP/output" 2>&1; }
selected() { # <label> <origin> <root> <mode...>
  label=$1; origin=$2; root=$3; shift 3
  if run "$@" && grep -q "curl .*${origin}/calmind/api/index.php" "$CHEF_TARGET_LOG" &&
      grep -q "rsync .*fixture.invalid:${root}/" "$CHEF_TARGET_LOG"; then ok "$label"; else bad "$label"; fi
}
selected 'production is the default dry-run target' https://seancheren.com /home/public/MealMind --dry-run
if grep -q '^rsync .*--dry-run' "$CHEF_TARGET_LOG" && ! grep -q '^curl .*test.seancheren.com' "$CHEF_TARGET_LOG"; then ok 'production dry-run stays dry and never asks TEST'; else bad 'production dry-run mode'; fi
selected 'explicit TEST dry-run uses only the TEST root and API' https://test.seancheren.com /home/public/test/MealMind --test --dry-run
if grep -q '^rsync .*--dry-run' "$CHEF_TARGET_LOG" && ! grep -q 'https://seancheren.com/' "$CHEF_TARGET_LOG"; then ok 'TEST dry-run stays dry and never asks production'; else bad 'TEST dry-run mode'; fi
if grep -q '^export-env dotenv=1 api=$' "$CHEF_TARGET_LOG"; then ok 'web export disables dotenv so a local production override cannot enter TEST'; else bad 'web export dotenv guard'; fi
selected 'TEST deployment verifies the same TEST origin after transfer' https://test.seancheren.com /home/public/test/MealMind --test
if grep -q '^curl .*https://test.seancheren.com/MealMind/index.html' "$CHEF_TARGET_LOG" && ! grep -q 'https://seancheren.com/' "$CHEF_TARGET_LOG"; then ok 're-entrant TEST verification never falls back to production'; else bad 'TEST verification target'; fi
if ! grep -Eq -- '--delete|/home/protected/' "$CHEF_TARGET_LOG"; then ok 'TEST refresh never deletes files or touches protected data'; else bad 'TEST preserves data and prior files'; fi
selected 'explicit production deployment retains its target' https://seancheren.com /home/public/MealMind --yes-prod
for target in prod test; do
  if [ "$target" = test ]; then args=--test; origin=https://test.seancheren.com; else args=; origin=https://seancheren.com; fi
  if run $args --verify && grep -q "^curl .*${origin}/MealMind/index.html" "$CHEF_TARGET_LOG" && ! grep -Eq '^(npm|npx|node|rsync|ssh) ' "$CHEF_TARGET_LOG"; then ok "$target verification performs no build or transfer"; else bad "$target verification mode"; fi
done
if run --test --yes-prod; then bad 'conflicting instance flags are refused'; else ok 'conflicting instance flags are refused'; fi
if run; then bad 'production still requires explicit consent'; else ok 'production still requires explicit consent'; fi
if EXPO_PUBLIC_API_URL=https://seancheren.com/calmind/api/index.php run --test --dry-run; then bad 'TEST refuses an inherited production API override'; else
  if grep -q 'EXPO_PUBLIC_API_URL unset' "$TMP/output" && ! grep -Eq '^(npm|npx|node|rsync|ssh) ' "$CHEF_TARGET_LOG"; then ok 'TEST refuses an inherited production API override before any build or transfer'; else bad 'TEST inherited API override guard'; fi
fi
# sh keeps an assignment made in front of a FUNCTION call (POSIX), so the one above is still set.
unset EXPO_PUBLIC_API_URL
printf '%s\n' 'SSH_DEST=fixture.invalid' 'WEB_DEST=/home/public/MealMind' > "$FIXTURE/deploy.conf"
if run --test; then bad 'config cannot replace the guarded TEST destination'; else
  if ! grep -q '^rsync ' "$CHEF_TARGET_LOG"; then ok 'config cannot replace the guarded TEST destination'; else bad 'config destination guard'; fi
fi
printf '%s\n' 'SSH_DEST=fixture.invalid' > "$FIXTURE/deploy.conf"

export CHEF_TARGET_WRONG_PAGE=1
if run --yes-prod; then bad 'a wrong page at /MealMind/ stops the deploy'; else ok 'a wrong page at /MealMind/ stops the deploy'; fi
unset CHEF_TARGET_WRONG_PAGE
printf '%s\n' "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
