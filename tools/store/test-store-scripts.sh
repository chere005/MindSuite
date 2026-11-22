#!/bin/sh
# Dry-run test of the store lane stubs: PATH stubs record any call; no network, no builds.
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"
LOG="$TMP/calls.log"
: > "$LOG"
for t in xcodebuild xcrun gradlew npx; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 0\n' "$t" "$LOG" > "$TMP/bin/$t"
  chmod +x "$TMP/bin/$t"
done
FAIL=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; FAIL=1; }
# run <name> <expected status> <output needle> <script> [args]; key env cleared
run() {
  name=$1; want=$2; needle=$3; shift 3
  out=$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u PLAY_SERVICE_ACCOUNT_JSON \
    PATH="$TMP/bin:$PATH" sh "$@" 2>&1); st=$?
  [ "$st" = "$want" ] && ok "$name: exit $want" || bad "$name: exit $st, wanted $want"
  case "$out" in *"$needle"*) ok "$name: output has '$needle'" ;; *) bad "$name: output lacks '$needle'" ;; esac
}
for app in CalMind MealMind; do
  run "ios dry $app" 0 "dry run" "$HERE/ios-upload.sh" $app
  run "ios plan $app" 0 "xcodebuild archive" "$HERE/ios-upload.sh" $app
  run "ios buildNumber $app" 0 "auto-increment" "$HERE/ios-upload.sh" $app
  run "ios --really no keys $app" 1 "ASC_KEY_ID is not set" "$HERE/ios-upload.sh" $app --really
  run "android dry $app" 0 "dry run" "$HERE/android-bundle.sh" $app
  run "android plan $app" 0 "bundleRelease" "$HERE/android-bundle.sh" $app
  run "android --really no keys $app" 1 "PLAY_SERVICE_ACCOUNT_JSON is not set" "$HERE/android-bundle.sh" $app --really
done
run "ios unknown app" 64 "unknown app" "$HERE/ios-upload.sh" Nope
run "android no args" 64 "usage" "$HERE/android-bundle.sh"

# --really with keys present reaches the stub branch (exit 2) and still runs nothing.
printf 'x' > "$TMP/key"
ASC_KEY_ID=K ASC_ISSUER_ID=I ASC_KEY_PATH="$TMP/key" PATH="$TMP/bin:$PATH" sh "$HERE/ios-upload.sh" CalMind --really >/dev/null 2>&1; st=$?
[ "$st" = 2 ] && ok "ios --really with keys: exit 2" || bad "ios --really with keys: exit $st"
PLAY_SERVICE_ACCOUNT_JSON="$TMP/key" PATH="$TMP/bin:$PATH" sh "$HERE/android-bundle.sh" CalMind --really >/dev/null 2>&1; st=$?
[ "$st" = 2 ] && ok "android --really with keys: exit 2" || bad "android --really with keys: exit $st"

if [ -s "$LOG" ]; then bad "stubs were invoked:"; cat "$LOG"; else ok "no stub was invoked"; fi
[ "$FAIL" = 0 ] && echo "all passed" || echo "FAILURES"
exit "$FAIL"
