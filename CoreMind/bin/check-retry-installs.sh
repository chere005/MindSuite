#!/bin/sh
# Does retry-installs.sh record, retry, supersede and survive a bad state file?
#
#   sh bin/check-retry-installs.sh
#   sh bin/check-retry-installs.sh CalMind ChefMind AcctMind PlanMind TaskMind   (also: each carries the same bytes)
#
# Runs against a STUB devicectl (MIND_DEVICECTL) and a scratch state directory
# (MIND_OWED_DIR): no phone, no Xcode, nothing outside a scratch directory.
set -e
cd "$(dirname "$0")/.."
SCRIPT="$PWD/bin/retry-installs.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/owedcheck.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
check() { if "$@" >/dev/null 2>&1; then ok "$DESC"; else bad "$DESC"; fi; }

for consumer in "$@"; do
  case "$consumer" in
    CalMind|ChefMind|AcctMind|PlanMind|TaskMind) ;;
    *) echo "unknown consumer: $consumer" >&2; exit 1 ;;
  esac
  DESC="$consumer: carries the same retry-installs.sh"
  check cmp -s "$SCRIPT" "${MIND_DIR:-..}/$consumer/tools/retry-installs.sh"
  DESC="$consumer: platform script calls owed_installs"
  check grep -q 'owed_installs record' "${MIND_DIR:-..}/$consumer/tools/build-platforms.sh"
done

export MIND_OWED_DIR="$TMP/state"
export STUB_LOG="$TMP/calls"
U1=00000000-0000000000000001; U2=00000000-0000000000000002
PH="$U1
$U2  # a comment, not a name"
export IOS_PHONES="$PH"

# A stub devicectl. STUB_REACH: udids `list devices` reports. STUB_BAD: udids whose install fails.
# STUB_VER: what `info apps` reports as installed (default: the version just installed).
cat > "$TMP/dc" <<'STUB'
#!/bin/sh
echo "$*" >> "$STUB_LOG"
a1=$1; a2=$2; last=""
out=""; while [ $# -gt 0 ]; do [ "$1" = --json-output ] && out="$2"; [ "$1" = --device ] && dev="$2"; [ "$1" = --bundle-id ] && bid="$2"; last=$1; shift; done
case "$a1 $a2" in
  "list devices")
    printf '{"result":{"devices":[' > "$out"; sep=""
    for u in $STUB_REACH; do
      printf '%s{"hardwareProperties":{"platform":"iOS","udid":"%s"},"connectionProperties":{"tunnelState":"connected"},"deviceProperties":{"name":"x"}}' "$sep" "$u" >> "$out"; sep=","
    done
    printf ']}}' >> "$out" ;;
  "device install") case " $STUB_BAD " in *" $dev "*) exit 1 ;; esac
    echo "$last" > "$STUB_LOG.installed.$dev" ;;
  "device info")
    v=${STUB_VER:-$(sed 's/.*-\(.*\)\.app/\1/' "$STUB_LOG.installed.$dev" 2>/dev/null)}
    printf '{"result":{"apps":[{"bundleIdentifier":"%s","version":"%s"}]}}' "$bid" "$v" > "$out" ;;
esac
STUB
chmod +x "$TMP/dc"
export MIND_DEVICECTL="$TMP/dc"

mkapp() { # <dir> <version>
  mkdir -p "$1"
  printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.demo.app</string><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>' "$2" > "$1/Info.plist"
  echo payload > "$1/bin"
}
run() { sh "$SCRIPT" "$@" > "$TMP/out" 2> "$TMP/err" && RC=0 || RC=$?; }
STATEF="$MIND_OWED_DIR/owed-installs.json"
count() { python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["owed"]))' "$STATEF"; }
mkapp "$TMP/b1/Demo.app" 1.2.0

# record
run record Demo "$U2" "$TMP/b1/Demo.app"
[ "$RC" = 0 ] && ok "record: exit 0" || bad "record: rc $RC"
[ "$(count)" = 1 ] && ok "record: one entry" || bad "record: entry count"
[ -f "$MIND_OWED_DIR/builds/Demo-1.2.0.app/Info.plist" ] && ok "record: build copy kept" || bad "record: no build copy"
grep -q '"phone": 2' "$STATEF" && ok "record: phone index from the list (comment ignored)" || bad "record: phone index"
grep -q "phone 2 owes Demo 1.2.0" "$TMP/out" && ok "record: says the index" || bad "record: output"
! grep -q "comment" "$TMP/out" "$TMP/err" && ! grep -q "$TMP" "$TMP/out" "$TMP/err" && ok "record: no names or paths printed" || bad "record: printed a name or path"

# still unreachable: kept quietly, nothing installed
export STUB_REACH="$U1"; : > "$STUB_LOG"
run
[ "$RC" = 0 ] && [ ! -s "$TMP/out" ] && ok "unreachable: exit 0, silent" || bad "unreachable: rc $RC / output"
[ "$(count)" = 1 ] && ok "unreachable: entry kept" || bad "unreachable: entry lost"
! grep -q "device install" "$STUB_LOG" && ok "unreachable: no install attempted" || bad "unreachable: install attempted"

# reachable but the install fails: kept, exit 1
export STUB_REACH="$U1 $U2" STUB_BAD="$U2"; : > "$STUB_LOG"
run
[ "$RC" = 1 ] && [ "$(count)" = 1 ] && ok "failing install: exit 1, entry kept" || bad "failing install: rc $RC"

# reachable, install ok, version read back: dropped, copy pruned
export STUB_BAD=""
run
[ "$RC" = 0 ] && [ "$(count)" = 0 ] && ok "retry success: exit 0, entry dropped" || bad "retry success: rc $RC count $(count)"
grep -q "phone 2 took Demo 1.2.0" "$TMP/out" && ok "retry success: says the index" || bad "retry success: output"
[ ! -e "$MIND_OWED_DIR/builds/Demo-1.2.0.app" ] && ok "retry success: saved copy pruned" || bad "retry success: copy left"

# verification mismatch keeps the entry
run record Demo "$U2" "$TMP/b1/Demo.app"; export STUB_VER=9.9.9
run
[ "$RC" = 1 ] && [ "$(count)" = 1 ] && ok "wrong installed version: entry kept" || bad "wrong installed version: rc $RC"
unset STUB_VER

# superseded: a newer record replaces the older; a newer successful install clears older owed
mkapp "$TMP/b2/Demo.app" 1.3.0
run record Demo "$U2" "$TMP/b2/Demo.app"
[ "$(count)" = 1 ] && grep -q '"version": "1.3.0"' "$STATEF" && ok "superseded: newer record replaces older" || bad "superseded: record"
[ ! -e "$MIND_OWED_DIR/builds/Demo-1.2.0.app" ] && [ -d "$MIND_OWED_DIR/builds/Demo-1.3.0.app" ] && ok "superseded: old copy pruned, new kept" || bad "superseded: pruning"
run record Demo "$U1" "$TMP/b1/Demo.app"
mkapp "$TMP/b3/Demo.app" 1.4.0
run clear Demo "$U1" "$TMP/b3/Demo.app"
[ "$(count)" = 1 ] && ! grep -q "$U1" "$STATEF" && grep -q "$U2" "$STATEF" && ok "clear: older entry for that phone dropped, other phone kept" || bad "clear: wrong entries"
mkapp "$TMP/b4/Demo.app" 1.0.0
run clear Demo "$U2" "$TMP/b4/Demo.app"
[ "$(count)" = 1 ] && ok "clear: an older install does not clear a newer owed one" || bad "clear: cleared a newer entry"
run record Other "$U2" "$TMP/b3/Demo.app"
run clear Demo "$U2" "$TMP/b3/Demo.app"
[ "$(count)" = 1 ] && grep -q '"app": "Other"' "$STATEF" && ok "clear: other apps untouched" || bad "clear: touched another app"

# corrupt state: backup kept, no crash, fresh list
printf '{"owed": [ not json' > "$STATEF"
run record Demo "$U1" "$TMP/b3/Demo.app"
[ "$RC" = 0 ] && ok "corrupt: record exits 0" || bad "corrupt: record rc $RC"
ls "$STATEF".corrupt-* >/dev/null 2>&1 && grep -q "not json" "$STATEF".corrupt-* && ok "corrupt: backup kept" || bad "corrupt: no backup"
[ "$(count)" = 1 ] && ok "corrupt: list restarted with the new entry" || bad "corrupt: list"
printf '[1,2]' > "$STATEF"
run
[ "$RC" = 0 ] && ok "corrupt (wrong shape): retry exits 0" || bad "corrupt (wrong shape): rc $RC"
printf 'garbage' > "$STATEF"
run clear Demo "$U1" "$TMP/b3/Demo.app"
[ "$RC" = 0 ] && ok "corrupt: clear exits 0" || bad "corrupt: clear rc $RC"

# refusals: nothing odd reaches the state dir or exits non-zero
run record "../x" "$U1" "$TMP/b3/Demo.app"
[ "$RC" = 0 ] && ok "unsafe app name: refused, exit 0" || bad "unsafe app name: rc $RC"
run record Demo "$U1" "$TMP/nothing.app"
[ "$RC" = 0 ] && ok "missing bundle: exit 0" || bad "missing bundle: rc $RC"
rm -rf "$MIND_OWED_DIR"
run
[ "$RC" = 0 ] && [ ! -s "$TMP/out" ] && ok "nothing owed: exit 0, silent" || bad "nothing owed: rc $RC"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
