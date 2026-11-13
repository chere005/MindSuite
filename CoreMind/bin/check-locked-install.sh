#!/bin/sh
# Does bin/build-platforms.sh's devicectl_install name a locked phone?
#
#   sh bin/check-locked-install.sh
#   sh bin/check-locked-install.sh CalMind ChefMind AcctMind PlanMind TaskMind
#
# Extracts the marked helper block and runs it against a STUB devicectl
# (MIND_DEVICECTL) — no phone, no Xcode, nothing outside a scratch directory.
# Named consumers must carry the same block in their platform script. Set
# MIND_DIR if those checkouts are outside CoreMind's parent directory.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/lockedcheck.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
extract_helper() { sed -n '/^# >>> locked-device install/,/^# <<< locked-device install/p' "$1"; }
extract_helper bin/build-platforms.sh > "$TMP/helper.sh"
[ -s "$TMP/helper.sh" ] || { echo "helper block not found" >&2; exit 1; }
. "$TMP/helper.sh"

for consumer in "$@"; do
  case "$consumer" in
    CalMind|ChefMind|AcctMind|PlanMind|TaskMind) ;;
    *) echo "unknown locked-install consumer: $consumer" >&2; exit 1 ;;
  esac
  script="${MIND_DIR:-..}/$consumer/tools/build-platforms.sh"
  if [ ! -f "$script" ]; then
    bad "$consumer: platform script missing"
  elif ! sh -n "$script"; then
    bad "$consumer: invalid platform script"
  else
    extract_helper "$script" > "$TMP/consumer.sh"
    if ! cmp -s "$TMP/helper.sh" "$TMP/consumer.sh"; then
      bad "$consumer: helper differs from canon"
    elif ! sed '/^# >>> locked-device install/,/^# <<< locked-device install/d; /^[[:space:]]*#/d' "$script" |
        grep -Eq '(^|[[:space:](])devicectl_install[[:space:]]'; then
      bad "$consumer: platform script does not call the locked-device helper"
    else
      ok "$consumer: install uses the exact helper"
    fi
  fi
done

# stub <text> <rc> — a devicectl that prints text and exits rc; counts calls.
stub() {
  printf '#!/bin/sh\necho x >> "%s/calls"\nprintf "%%s\\n" "$STUB_TEXT"\nexit %s\n' "$TMP" "$2" > "$TMP/dc"
  chmod +x "$TMP/dc"; : > "$TMP/calls"; STUB_TEXT="$1"; export STUB_TEXT
  MIND_DEVICECTL="$TMP/dc"; export MIND_DEVICECTL
}
run() { devicectl_install UDID /x.app "Alex's iPhone" > "$TMP/out" 2> "$TMP/err" && RC=0 || RC=$?; }
has() { grep -q "$2" "$1"; }
LINE="Alex's iPhone is locked — unlock it and re-run the install step"

stub "ERROR: The device is locked. (com.apple.dt.CoreDeviceError error 1001)" 1; run
[ "$RC" = 1 ] && ok "locked: fails" || bad "locked: rc $RC"
has "$TMP/err" "$LINE" && ok "locked: one clear line" || bad "locked: no clear line"
has "$TMP/err" "CoreDeviceError" && ok "locked: original error kept" || bad "locked: original error lost"
[ "$(wc -l < "$TMP/calls" | tr -d ' ')" = 2 ] && ok "locked: retried once" || bad "locked: call count"

stub "ERROR: Device is busy (Waiting for passcode)" 1; run
has "$TMP/err" "$LINE" && ok "busy/passcode: clear line" || bad "busy/passcode: no clear line"

stub "ERROR: A provisioning profile does not include this device" 1; run
has "$TMP/err" "is locked" && bad "other failure: wrongly called locked" || ok "other failure: no locked claim"
[ "$RC" = 1 ] && ok "other failure: still fails" || bad "other failure: rc $RC"

stub "App installed" 0; run
[ "$RC" = 0 ] && ok "success: rc 0" || bad "success: rc $RC"
has "$TMP/err" "locked" && bad "success: stray line" || ok "success: quiet"
[ "$(wc -l < "$TMP/calls" | tr -d ' ')" = 1 ] && ok "success: one call" || bad "success: call count"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
