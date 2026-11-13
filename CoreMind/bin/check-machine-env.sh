#!/bin/sh
# Do the lanes refuse, naming the file or key, when .local/machine.env is absent or incomplete?
#
#   sh bin/check-machine-env.sh
#
# Runs each app's tools/build-platforms.sh from a scratch copy against a made-up
# machine.env (MIND_MACHINE_ENV). Nothing is built: the lane must stop before any build.
set -e
cd "$(dirname "$0")/.."
PARENT="${MIND_DIR:-$(cd .. && pwd)}"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/machineenv.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  SKIP %s\n' "$1"; }

# the library itself
[ -f "$PARENT/CalMind/tools/machine-env.sh" ] || { echo "check-machine-env: $PARENT/CalMind/tools/machine-env.sh is missing (MIND_DIR names the directory holding the apps)" >&2; exit 1; }
. "$PARENT/CalMind/tools/machine-env.sh"
cat > "$TMP/full.env" <<'ENV'
APPLE_TEAM_ID=TEAMID0000
PHONE1_UDID=00000000-0000000000000001
PHONE1_NAME="Phone 1"
PHONE1_PERSON="Person A"
PHONE2_UDID=00000000-0000000000000002
PHONE2_NAME="Phone 2"
PHONE2_PERSON="Person B"
DEMOAPP_PHONES="1 2"
ENV
( MIND_MACHINE_ENV="$TMP/full.env"; machine_load x && [ "$(machine_phones demoapp | wc -l | tr -d ' ')" = 2 ] \
  && machine_phones demoapp | head -1 | grep -q '^00000000-0000000000000001  # Phone 1, Person A$' ) \
  && ok "machine_phones lists udid and a label per listed phone" || bad "machine_phones output"
grep -v '^PHONE2_NAME' "$TMP/full.env" > "$TMP/nophonename.env"
( MIND_MACHINE_ENV="$TMP/nophonename.env"; machine_load x && machine_phones demoapp >/dev/null ) 2>"$TMP/err" \
  && bad "a missing PHONE2_NAME was accepted" || { grep -q 'key PHONE2_NAME is missing' "$TMP/err" && ok "a missing phone key is named" || bad "missing key not named"; }
( MIND_MACHINE_ENV="$TMP/absent.env"; machine_load x ) 2>"$TMP/err" \
  && bad "an absent file was accepted" || { grep -q 'absent.env does not exist' "$TMP/err" && ok "an absent file is named" || bad "absent file not named"; }

# every lane, from a scratch copy
for APP in CalMind ChefMind AcctMind PlanMind TaskMind; do
  [ -f "$PARENT/$APP/tools/build-platforms.sh" ] || { echo "== $APP — no checkout, skipped"; continue; }
  echo "== $APP"
  D="$TMP/$APP"; mkdir -p "$D/tools" "$D/home/Library/Developer/Xcode/iOS DeviceSupport"
  cp "$PARENT/$APP/tools/"*.sh "$D/tools/"
  run() { ( cd "$D" && HOME="$D/home" MIND_HEAVY_LOCK="$D/lock" "$@" ) ; }
  run env MIND_MACHINE_ENV="$TMP/absent.env" sh tools/build-platforms.sh --ios >"$TMP/out" 2>&1 \
    && bad "$APP --ios ran without a machine file" \
    || { grep -q 'absent.env does not exist' "$TMP/out" && ok "$APP --ios names the missing file and stops" || bad "$APP --ios: wrong refusal: $(head -3 "$TMP/out")"; }
  grep -v '^APPLE_TEAM_ID' "$TMP/full.env" > "$TMP/noteam.env"
  run env MIND_MACHINE_ENV="$TMP/noteam.env" sh tools/build-platforms.sh --ios >"$TMP/out" 2>&1 \
    && bad "$APP --ios ran without a team" \
    || { grep -q 'key APPLE_TEAM_ID is missing' "$TMP/out" && ok "$APP --ios names the missing team key" || bad "$APP --ios: team refusal: $(head -3 "$TMP/out")"; }
  UP=$(printf %s "$APP" | tr a-z A-Z)
  run env MIND_MACHINE_ENV="$TMP/full.env" sh tools/build-platforms.sh --ios >"$TMP/out" 2>&1 \
    && bad "$APP --ios ran without its phone list" \
    || { grep -q "key ${UP}_PHONES is missing" "$TMP/out" && ok "$APP --ios names the missing ${UP}_PHONES" || bad "$APP --ios: list refusal: $(head -3 "$TMP/out")"; }
  run env MIND_MACHINE_ENV="$TMP/absent.env" sh tools/build-platforms.sh --ios --dry-run >/dev/null 2>&1 \
    && ok "$APP --ios --dry-run needs no machine file" || bad "$APP dry run failed without a machine file"
done
# the CoreMind fallback lane refuses before its macOS stage, not after it
echo "== CoreMind fallback lane"
# macOS targets Apple Silicon only: off an arm64 host the lane refuses --mac
# ("macOS builds require Apple Silicon.") before it reads the machine file, so
# this ordering can only be proved where `uname -m` says arm64, as the lane checks.
if [ "$(uname -m)" != arm64 ]; then
  skip "fallback lane names the missing file before the macOS stage (host is $(uname -m), not arm64; --mac is Apple Silicon only)"
else
C="$TMP/coremind"; mkdir -p "$C/bin" "$TMP/suite/CalMind/tools"
cp bin/build-platforms.sh "$C/bin/"; for F in gh-bot heavy-lock machine-env tdtp; do cp "$PARENT/CalMind/tools/$F.sh" "$TMP/suite/CalMind/tools/"; done
( cd "$C" && MIND_DIR="$TMP/suite" HOME="$TMP/home" MIND_HEAVY_LOCK="$TMP/lock" MIND_MACHINE_ENV="$TMP/absent.env" \
  sh bin/build-platforms.sh CalMind --mac --ios ) >"$TMP/out" 2>&1 \
  && bad "fallback lane ran without a machine file" \
  || { grep -q 'absent.env does not exist' "$TMP/out" && ! grep -q 'macOS' "$TMP/out" \
       && ok "fallback lane names the missing file before the macOS stage" || bad "fallback lane: $(head -3 "$TMP/out")"; }
fi

# CalMind strips the "# name, person" label before it loops over the udids
grep -q "_mp=\$(machine_phones calmind)" "$PARENT/CalMind/tools/build-platforms.sh" \
  && grep -q "sed 's/\[\[:space:\]\]\*#\.\*//'" "$PARENT/CalMind/tools/build-platforms.sh" \
  && ok "CalMind strips phone labels from IOS_PHONES" || bad "CalMind IOS_PHONES keeps the labels"
printf '%d ok, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" = 0 ]
