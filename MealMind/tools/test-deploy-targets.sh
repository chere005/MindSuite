#!/bin/sh
# Exercise the real deploy modes in a scratch client. Every network/build executable is a local stub.
set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/chef-targets.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
FIXTURE="$TMP/client"
mkdir -p "$FIXTURE/tools/old-path" "$FIXTURE/app/src" "$FIXTURE/app/assets" "$FIXTURE/app/dist" "$TMP/bin"
cp deploy.sh "$FIXTURE/deploy.sh"
cp tools/python.sh "$FIXTURE/tools/python.sh"
cp tools/old-path/.htaccess tools/old-path/sw.js "$FIXTURE/tools/old-path/"
printf '%s\n' 'SSH_DEST=fixture.invalid' > "$FIXTURE/deploy.conf"
printf '%s\n' "export const space = 'chef';" > "$FIXTURE/app/src/api.ts"
printf '%s\n' 'fixture' > "$FIXTURE/app/dist/favicon.ico"
printf '%s\n' 'fixture' > "$FIXTURE/tools/web.htaccess"
printf '%s\n' 'EXPO_PUBLIC_API_URL=https://seancheren.com/calmind/api/index.php' > "$FIXTURE/.env"
# The live site, as far as deploy.sh can ask it. The old /ChefMind/ path answers as
# CHEF_TARGET_OLD says until the stubbed swap (ssh mv) has run: chef = ChefMind's page,
# sandbox = the TestChefMind sandbox's page, none = 404. The staged ChefMind.next/, and
# the old path after the swap, answer as the redirect folder does — unless
# CHEF_TARGET_BROKEN_REDIRECT is set, when they serve a page instead.
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
printf 'curl %s\n' "$*" >> "$CHEF_TARGET_LOG"
url=""; for a in "$@"; do case "$a" in http*) url=$a ;; esac; done
case " $* " in
  *'"action":"spaces"'*) printf '%s\n' '{"ok":true,"spaces":["chef"]}'; exit 0 ;;
esac
case "$url" in
  */ChefMind/*|*/ChefMind.next/*)
    origin=${url%%/ChefMind*}; rest=${url#*/ChefMind/}
    [ "$rest" != "$url" ] || rest=${url#*/ChefMind.next/}
    mode=redirect
    case "$url" in */ChefMind/*) [ -f "$CHEF_TARGET_SWAPPED" ] || mode=${CHEF_TARGET_OLD:-chef} ;; esac
    [ -z "${CHEF_TARGET_BROKEN_REDIRECT:-}" ] || [ "$mode" != redirect ] || mode=chef
    case "$mode:$*" in
      redirect:*'%{redirect_url}'*) printf '302 %s/MealMind/%s' "$origin" "$rest" ;;
      redirect:*'-D -'*) printf 'HTTP/2 200 \r\ncache-control: no-cache\r\ncontent-type: text/javascript\r\n\r\n' ;;
      redirect:*) cat "$CHEF_TARGET_FIXTURE/tools/old-path/sw.js" ;;
      none:*' -o /dev/null '*) printf '404 ' ;;
      *:*'%{redirect_url}'*|*:*' -o /dev/null '*) printf '200 ' ;;
      *:*'-D -'*) printf 'HTTP/2 200 \r\ncache-control: max-age=31536000\r\n\r\n' ;;
      sandbox:*) printf '%s\n' '<!doctype html><head><title>TestChefMind</title></head>' ;;
      *) printf '%s\n' '<!doctype html><head><title>ChefMind</title></head>' ;;
    esac ;;
  *)
    case " $* " in
      *' -o /dev/null '*) printf 200 ;;
      *) if [ -n "${CHEF_TARGET_WRONG_PAGE:-}" ]; then sed 's|<title>MealMind</title>|<title>CalMind</title>|' "$CHEF_TARGET_FIXTURE/app/dist/index.html"
         else cat "$CHEF_TARGET_FIXTURE/app/dist/index.html"; fi ;;
    esac ;;
esac
STUB
# The server's side: a `cat` of the old path's files answers with the redirect
# folder's when CHEF_TARGET_OLD=redirect (it is already in place); the swap (the
# call that runs mv) marks the old path swapped for the curl stub.
cat > "$TMP/bin/ssh" <<'STUB'
#!/bin/sh
printf 'ssh %s\n' "$*" >> "$CHEF_TARGET_LOG"
case "$*" in
  *"cat '"*) [ "${CHEF_TARGET_OLD:-}" != redirect ] || cat "$CHEF_TARGET_FIXTURE/tools/old-path/.htaccess" "$CHEF_TARGET_FIXTURE/tools/old-path/sw.js" ;;
  *"mv '"*) : > "$CHEF_TARGET_SWAPPED" ;;
esac
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
export CHEF_TARGET_FIXTURE="$FIXTURE" CHEF_TARGET_LOG="$TMP/calls" CHEF_TARGET_SWAPPED="$TMP/swapped"
PATH="$TMP/bin:$PATH"; export PATH
unset CHEF_GATES_PASSED EXPO_PUBLIC_API_URL CHEF_TARGET_OLD CHEF_TARGET_BROKEN_REDIRECT CHEF_TARGET_WRONG_PAGE
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; cat "$TMP/output"; }
run() { : > "$CHEF_TARGET_LOG"; rm -f "$CHEF_TARGET_SWAPPED"; (cd "$FIXTURE" && sh deploy.sh "$@") > "$TMP/output" 2>&1; }
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
printf '%s\n' 'SSH_DEST=fixture.invalid' 'OLD_DEST=/home/public/ChefMind' > "$FIXTURE/deploy.conf"
if run --test; then bad 'config cannot replace the guarded TEST old path'; else
  if ! grep -Eq '^(rsync|ssh) ' "$CHEF_TARGET_LOG"; then ok 'config cannot replace the guarded TEST old path'; else bad 'config old-path guard'; fi
fi
printf '%s\n' 'SSH_DEST=fixture.invalid' > "$FIXTURE/deploy.conf"

# The old /ChefMind/ path becomes a redirect only after /MealMind/ is live and proven.
# Each case sets the stubs' state and unsets it after (see the unset above for why).
line() { grep -n -- "$1" "$CHEF_TARGET_LOG" | head -n 1 | cut -d: -f1; }
retired() { # <label> <origin> <old root> <mode...>: staged, proven, swapped, moved out, proven again
  label=$1; origin=$2; old=$3; shift 3
  parent=${old%/*}
  if run "$@"; then
    proof=$(line "^curl .*${origin}/MealMind/index.html"); stage=$(line "^rsync .*tools/old-path/ fixture.invalid:${old}.next/")
    probe=$(line "^curl .*${origin}/ChefMind.next/sw.js"); swap=$(line "^ssh .*cd '${parent}'.*mv 'ChefMind.next' 'ChefMind'")
    after=$(line "^curl .*${origin}/ChefMind/sw.js")
    if [ -n "$proof" ] && [ -n "$stage" ] && [ -n "$probe" ] && [ -n "$swap" ] && [ -n "$after" ] &&
        [ "$proof" -lt "$stage" ] && [ "$stage" -lt "$probe" ] && [ "$probe" -lt "$swap" ] && [ "$swap" -lt "$after" ] &&
        grep -q "^ssh .*mv 'ChefMind.old' '/home/private/retired-web/" "$CHEF_TARGET_LOG"; then ok "$label"; else bad "$label"; fi
  else bad "$label (exit non-zero)"; fi
}
retired 'production: the old path is staged, proven, swapped and moved out, after the new one is proven' https://seancheren.com /home/public/ChefMind --yes-prod
retired 'TEST: the same, on TEST only' https://test.seancheren.com /home/public/test/ChefMind --test
if ! grep -q 'https://seancheren.com/\|/home/public/ChefMind' "$CHEF_TARGET_LOG"; then ok 'TEST retirement never touches the production old path'; else bad 'TEST retirement target'; fi
export CHEF_TARGET_OLD=none
retired 'an old path with nothing there gets the redirect' https://seancheren.com /home/public/ChefMind --yes-prod
CHEF_TARGET_OLD=redirect
if run --yes-prod && grep -q 'already the redirect' "$TMP/output" &&
    ! grep -Eq '^rsync .*old-path|^ssh .*mv ' "$CHEF_TARGET_LOG"; then ok 'an old path that is already the redirect is left as it is (idempotent)'; else bad 'idempotent retirement'; fi
CHEF_TARGET_OLD=sandbox
if run --test && grep -q 'left alone' "$TMP/output" &&
    ! grep -Eq '^rsync .*old-path|^ssh .*mv ' "$CHEF_TARGET_LOG"; then ok "TEST's /ChefMind/ holding the TestChefMind sandbox is left alone"; else bad 'sandbox left alone'; fi
unset CHEF_TARGET_OLD
export CHEF_TARGET_BROKEN_REDIRECT=1
if run --yes-prod; then bad 'a staged redirect that does not redirect stops the deploy'; else
  if grep -q '^rsync .*ChefMind.next/' "$CHEF_TARGET_LOG" && ! grep -q '^ssh .*mv ' "$CHEF_TARGET_LOG"; then ok 'a staged redirect that does not redirect stops the deploy before any swap'; else bad 'broken staged redirect'; fi
fi
unset CHEF_TARGET_BROKEN_REDIRECT
export CHEF_TARGET_WRONG_PAGE=1
if run --yes-prod; then bad 'a wrong page at /MealMind/ stops the deploy'; else
  if ! grep -Eq '^rsync .*old-path|^ssh .*mv |ChefMind' "$CHEF_TARGET_LOG"; then ok 'the old path is not touched (or even asked) unless the new page is proven'; else bad 'retirement ran before the new page was proven'; fi
fi
unset CHEF_TARGET_WRONG_PAGE
if run --dry-run && grep -q '^rsync .*--dry-run.*tools/old-path/ fixture.invalid:/home/public/ChefMind.next/' "$CHEF_TARGET_LOG" &&
    ! grep -q '^ssh .*mv ' "$CHEF_TARGET_LOG" && ! grep -q '/ChefMind.next/sw.js' "$CHEF_TARGET_LOG"; then ok 'a dry run previews the old-path upload and swaps nothing'; else bad 'dry-run retirement'; fi
printf '%s\n' "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
