#!/bin/sh
# Exercise the keyboard probe's exit paths with a private lock and no Xcode.
#   sh tools/check-keyboard-probe-lock.sh
set -eu
cd "$(dirname "$0")/.."

TMP=$(mktemp -d "${TMPDIR:-/tmp}/calmind-keyboard-lock.XXXXXX")
REAL_RM=$(command -v rm)
trap '"$REAL_RM" -rf "$TMP"' EXIT
mkdir "$TMP/bin"

# Any command capable of starting a build, simulator, server, or request
# fails in the stub. The tested paths stop before invoking them.
for command in xcodegen xcodebuild xcrun npx php curl; do
  printf '#!/bin/sh\necho "unexpected probe command" >&2\nexit 96\n' > "$TMP/bin/$command"
done
cat > "$TMP/bin/lsof" <<'SH'
#!/bin/sh
[ "$PROBE_MODE" != term ] || kill -TERM "$PPID"
exit 0
SH
cat > "$TMP/bin/rm" <<'SH'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    "$TMPDIR/calmind-notes-keyboard/data")
      [ -f "$MIND_HEAVY_LOCK/owner" ] || exit 97
      touch "$TMPDIR/cleanup-held"
      ;;
  esac
done
exec "$REAL_RM" "$@"
SH
chmod +x "$TMP/bin/"*

export REAL_RM
export TMPDIR="$TMP" PATH="$TMP/bin:$PATH" KEEP=0
export MIND_HEAVY_LOCK="$TMP/lock" MIND_HEAVY_WAIT=0 MIND_PHASE_FILE=''
OUT="$TMP/calmind-notes-keyboard"

check_exit() {
  "$REAL_RM" -f "$TMP/cleanup-held"
  rc=0
  PROBE_MODE="$1" sh tools/notes-keyboard-regression.sh > "$TMP/probe.log" 2>&1 || rc=$?
  if [ "$rc" != "$2" ] || [ ! -f "$TMP/cleanup-held" ] || [ -d "$OUT/data" ] || [ -e "$MIND_HEAVY_LOCK" ]; then
    cat "$TMP/probe.log" >&2
    echo "keyboard probe did not clean up and release its lock after $1 (exit $rc)" >&2
    exit 1
  fi
  echo "keyboard probe cleans up under lock and releases it after $1"
}
check_exit port-exhaustion 1
grep -q 'no free port' "$TMP/probe.log"
check_exit term 143

mkdir -p "$OUT/data"
touch "$OUT/data/previous-probe"
sh -c '
  set -eu
  out=$1
  log=$2
  . tools/heavy-lock.sh
  heavy_lock "stub fixture owner"
  rc=0
  PROBE_MODE=port-exhaustion sh tools/notes-keyboard-regression.sh > "$log" 2>&1 || rc=$?
  if [ "$rc" != 1 ] || [ ! -f "$out/data/previous-probe" ]; then
    cat "$log" >&2
    echo "waiting keyboard probe changed the current owner’s scratch data" >&2
    exit 1
  fi
  heavy_unlock
' sh "$OUT" "$TMP/probe.log"
[ ! -e "$MIND_HEAVY_LOCK" ]
echo 'contended keyboard probe preserves the current owner’s scratch data'
