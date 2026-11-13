#!/bin/sh
# Does the heavy-build lock still do what CalMind/tools/heavy-lock.sh says?
#
#   sh bin/check-heavy-lock.sh
#
# Every case runs the REAL helper, under each shell the lanes might be run
# with (`sh`, which is bash here, and dash when it is installed — the helper
# claims POSIX), against a lock in a scratch directory. Never the machine's
# own: a real build may be holding it, and a proof that queued behind one, or
# made one queue behind it, would be a test with a side effect.
#
# Then each guarantee is BROKEN out of a copy and its case run again, and that
# run must FAIL. A lock that has never been seen letting two holders in looks
# exactly like one that works — the baseline's "break it before you trust it",
# and the reason CalMind's tools/check-deploy-guards.sh breaks copies too.
#
# Every case that touches a trap runs a second time under `set -e`, because
# every caller does and a trap can trip errexit where nothing else would.
#
# About two and a half minutes, most of it the holds the cases wait out.
# Run it after any change to the helper; nothing in a lane runs it.
set -e
cd "$(dirname "$0")/.."
HELPER="$(cd .. && pwd)/CalMind/tools/heavy-lock.sh"
[ -f "$HELPER" ] || { echo "check-heavy-lock: $HELPER is missing: nothing to prove" >&2; exit 1; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/heavylock.XXXXXX")
KIDS=""
# Holders a case left running (it failed half-way, or a broken copy never let
# go) are killed on the way out, so no proof outlives this script.
cleanup() {
  exec 2>/dev/null
  for p in $KIDS; do kill -9 "$p" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT

PASS=0; FAIL=0; SKIP=0
ok()  { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  - SKIP: %s (%s)\n' "$1" "$2"; }
ms()  { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
why() { printf '%s\n' "$*" >"$W/why"; return 1; }
# Wait up to $2 seconds (default 10) for file $1 to appear.
waitfor() {
  _i=0
  while [ ! -s "$1" ]; do
    sleep 0.1; _i=$((_i + 1))
    [ "$_i" -lt $((${2:-10} * 10)) ] || return 1
  done
}
# Wait up to $2 seconds for pid $1 to finish, and give back its exit status;
# 124 (and the pid killed) when it does not finish in time — a broken copy
# that waits for ever must still let this script end.
waitpid() {
  _i=0
  while kill -0 "$1" 2>/dev/null; do
    sleep 0.1; _i=$((_i + 1))
    if [ "$_i" -ge $(($2 * 10)) ]; then kill -9 "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; return 124; fi
  done
  _wrc=0; wait "$1" 2>/dev/null || _wrc=$?
  return "$_wrc"
}

# --------------------------------------------------------------- the cases
# Each takes <helper> <shell>, works in $W with the lock at $W/lock, and
# returns 0 when the helper behaved — or writes the reason to $W/why.

# Three holders asked for at once take turns, and none overlaps another.
case_serialize() {
  P=""
  for n in 1 2 3; do
    MIND_HEAVY_LOCK="$W/lock" "$2" -c '
      . "$1"
      heavy_lock "probe $2" || exit 9
      s=$(perl -MTime::HiRes=time -e "printf q{%d}, time * 1000")
      sleep 1.5
      e=$(perl -MTime::HiRes=time -e "printf q{%d}, time * 1000")
      echo "$s $e $2" >>"$3"
      heavy_unlock' _ "$1" "$n" "$W/iv" 2>>"$W/err" &
    P="$P $!"; KIDS="$KIDS $!"
  done
  for p in $P; do waitpid "$p" 20 || why "a holder ended $? — $(tail -1 "$W/err")" || return 1; done
  [ "$(wc -l <"$W/iv" | tr -d ' ')" = 3 ] || why "not all three got the lock" || return 1
  sort -n "$W/iv" | awk 'NR > 1 && $1 < e { bad = 1 } { e = $2 } END { exit bad }' \
    || why "two holders overlapped: $(sort -n "$W/iv" | tr '\n' ';')" || return 1
  grep -q 'waiting for the heavy-build lock — held by [^ ]*: probe' "$W/err" \
    || why "no waiter said who held it" || return 1
  [ ! -d "$W/lock" ] || why "the lock outlived its holders"
}

# A holder killed -9 runs no trap; its waiter takes over anyway, promptly.
case_kill9() {
  MIND_HEAVY_LOCK="$W/lock" "$2" -c '
    . "$1"
    heavy_lock holder || exit 9
    sleep 60 & echo $! >"$2.sleep"
    echo held >"$2"
    wait' _ "$1" "$W/held" 2>/dev/null &
  HP=$!; KIDS="$KIDS $HP"
  waitfor "$W/held" || why "the holder never took the lock" || return 1
  KIDS="$KIDS $(cat "$W/held.sleep")"
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=12 "$2" -c '
    . "$1"
    heavy_lock waiter || exit 9
    perl -MTime::HiRes=time -e "printf q{%d}, time * 1000" >"$2"
    heavy_unlock' _ "$1" "$W/got" 2>"$W/err" &
  WP=$!; KIDS="$KIDS $WP"
  sleep 2.5
  [ ! -f "$W/got" ] || why "the waiter took the lock while its holder was alive" || return 1
  K=$(ms)
  kill -9 "$HP"
  waitpid "$WP" 20 || why "the waiter never got the lock — $(tail -1 "$W/err")" || return 1
  G=$(cat "$W/got")
  [ $((G - K)) -lt 5000 ] || why "the takeover took $((G - K)) ms" || return 1
  grep -q 'no longer running — taking it over' "$W/err" || why "the takeover said nothing"
}

# A pid that is running but is not the process that took the lock (pids are
# reused) is a gone holder too.
case_reuse() {
  sleep 30 & SP=$!; KIDS="$KIDS $SP"
  mkdir "$W/lock"
  printf '%s\tMon Jan 1 00:00:00 2001\t0\t00:00:00\tSomeRepo\tlong ago\n' "$SP" >"$W/lock/owner"
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=6 "$2" -c '. "$1"; heavy_lock reuse && heavy_unlock' _ "$1" 2>"$W/err" &
  WP=$!; KIDS="$KIDS $WP"
  waitpid "$WP" 10 || why "it waited on a recycled pid — $(tail -1 "$W/err")" || return 1
  grep -q 'no longer running' "$W/err" || why "the takeover said nothing"
}

# Ctrl-C, typed at a real terminal: the INT reaches the whole foreground
# group, and the script ends exactly as it would have with no lock at all —
# the caller's own EXIT trap included, with the $? it would have seen. Run
# three ways: with no INT trap of the caller's (the shell dies, and the trap —
# not a takeover later — lets the lock go); with one that carries on past the
# interrupt (still in its block, so still holding the lock until it unlocks);
# and as CalMind's lane is built — a parent running the iOS step as
# `sh build-platforms.sh --ios || note it`, then the Android step, and the iOS
# block setting its own EXIT trap for a temp file. Ctrl-C there must stop the
# lane as it would have without the lock, never carry on into Android.
#
# Under `set -e` the interrupted command is guarded, as every lane's build is
# (`if ! xcodebuild …`, `… || { …; exit 1; }`). An UNGUARDED one is where bash
# itself runs no EXIT trap on its way out of a Ctrl-C, and the lock, which
# cannot see which kind it interrupted, runs the caller's anyway — the one
# difference it keeps, on purpose (_hl_on says why). The lane's child is
# CalMind's own shape, `if ! … then exit 1`, whose EXIT trap prints nothing.
case_ctrlc() {
  SLEEP='sleep 20'
  [ "$SETE" = : ] || SLEEP='sleep 20 || exit 1'
  for v in plain own lane; do
    case $v in
      plain) PRE='trap "echo caller-exit \$?" EXIT' ;;
      own)   PRE='trap "echo caller-int" INT; trap "echo caller-exit \$?" EXIT' ;;
    esac
    if [ "$v" = lane ]; then
      # The child is CalMind's iOS block in miniature; the script the pty runs
      # is the lane that calls it. Bare, the child takes no lock and its EXIT
      # trap has no unlock to do.
      for k in bare lock; do
        case $k in
          bare) L=':'; U=':' ;;
          lock) L='heavy_lock "CalMind iOS" || exit 1'; U='heavy_unlock' ;;
        esac
        printf '%s\n' "$SETE" '. "$1"' "$L" "SEEN=\"$W/seen.$k\"; : >\"\$SEEN\"" \
          "trap 'rm -f \"\$SEEN\"; $U' EXIT" 'echo held' \
          "if ! sleep 20; then echo 'the iOS build failed' >&2; exit 1; fi" 'echo after-sleep' "$U" >"$W/child.$k"
      done
      LANE="$SETE; \"$2\" \"$W/child.KIND\" \"\$1\" || echo 'lane: --ios failed, noted; going on'; echo 'lane: --android step RAN'"
      S_BARE=$(echo "$LANE" | sed 's/KIND/bare/')
      S_LOCK=$(echo "$LANE" | sed 's/KIND/lock/')
    else
      # HELD is the one line that differs: with the lock, a run that carried
      # on past its Ctrl-C must still hold it (it prints nothing when it does).
      BODY="echo held; $SLEEP; echo after-sleep; HELD; UNLOCK; echo end"
      S_LOCK="$SETE; . \"\$1\"; $PRE; heavy_lock ctrlc || exit 9; $(echo "$BODY" | sed 's/UNLOCK/heavy_unlock/; s/HELD/[ -d "$MIND_HEAVY_LOCK" ] || echo lost-the-lock/')"
      S_BARE="$SETE; . \"\$1\"; $PRE; $(echo "$BODY" | sed 's/UNLOCK/:/; s/HELD/:/')"
    fi
    MIND_HEAVY_LOCK="$W/lock" $MIND_PYTHON "$TMP/ctrlc.py" "$2" "$S_BARE" "$1" >"$W/bare.$v" 2>&1 \
      || why "the pty driver failed: $(tail -1 "$W/bare.$v")" || return 1
    MIND_HEAVY_LOCK="$W/lock" $MIND_PYTHON "$TMP/ctrlc.py" "$2" "$S_LOCK" "$1" >"$W/lock.$v" 2>&1 \
      || why "the pty driver failed: $(tail -1 "$W/lock.$v")" || return 1
    [ ! -d "$W/lock" ] || why "($v) Ctrl-C left the lock behind" || return 1
    grep -q 'released' "$W/lock.log" 2>/dev/null || why "($v) the lock was not released by its trap" || return 1
    rm -f "$W/lock.log"
    cmp -s "$W/bare.$v" "$W/lock.$v" \
      || why "($v) the run ended differently with the lock: $(tr '\n' '|' <"$W/lock.$v") vs $(tr '\n' '|' <"$W/bare.$v")" || return 1
    if [ "$v" = lane ]; then
      # Said outright rather than left to the comparison: the bare run is the
      # yardstick, and a yardstick that carried on would make the two agree.
      ! grep -q 'android step RAN' "$W/bare.$v" "$W/lock.$v" \
        || why "(lane) Ctrl-C in the iOS step carried on into Android: $(tr '\n' '|' <"$W/lock.$v")" || return 1
    fi
  done
}

# kill -TERM: released by the trap, and the script dies as it would have —
# its EXIT trap run or not, as the shell itself would. Run with no TERM trap
# of the caller's and with one that carries on, as case_ctrlc does. ($? is
# left out: bash reports the interrupted `wait`'s status to a trap, and the
# status before it when it dies untrapped, and no trap can see the second.)
case_term() {
  for v in plain own; do
    case $v in
      plain) PRE=':' ;;
      own)   PRE="trap 'echo caller-term' TERM" ;;
    esac
    for k in bare lock; do
      case $k in bare) L=':' ;; lock) L='heavy_lock term || exit 9' ;; esac
      MIND_HEAVY_LOCK="$W/lock" "$2" -c "$SETE; . \"\$1\"; trap 'echo caller-exit' EXIT; $PRE; $L
        sleep 20 & echo \$! >\"\$2.sleep\"; echo held >\"\$2\"; wait \$!; echo after" _ "$1" "$W/held.$v.$k" >"$W/out.$v.$k" 2>&1 &
      HP=$!; KIDS="$KIDS $HP"
      waitfor "$W/held.$v.$k" || why "($v) the $k holder never started" || return 1
      KIDS="$KIDS $(cat "$W/held.$v.$k.sleep")"
      kill -TERM "$HP"
      _rc=0; waitpid "$HP" 10 || _rc=$?
      echo "status $_rc" >>"$W/out.$v.$k"
    done
    [ ! -d "$W/lock" ] || why "($v) TERM left the lock behind" || return 1
    grep -q 'released' "$W/lock.log" 2>/dev/null || why "($v) the lock was not released by its trap" || return 1
    rm -f "$W/lock.log"
    cmp -s "$W/out.$v.bare" "$W/out.$v.lock" \
      || why "($v) the run ended differently with the lock: $(tr '\n' '|' <"$W/out.$v.lock") vs $(tr '\n' '|' <"$W/out.$v.bare")" || return 1
  done
}

# The caller's traps survive: put back exactly after an unlock; one the caller
# set INSIDE a block left standing (CalMind's iOS step does that); an ignored
# signal still ignored; and an `exit 3` inside a block runs the caller's EXIT
# trap with $? = 3, exits 3, and lets the lock go. Under `set -e` the 3 comes
# from a failing command instead, which is how a lane's step usually ends.
case_traps() {
  END='exit 3'
  [ "$SETE" = : ] || END='(exit 3); echo errexit-never-fired'
  MIND_HEAVY_LOCK="$W/lock" "$2" -c "$SETE"'
    . "$1"; T=$2
    trap "echo \"caller exit \$?\"" EXIT
    trap "echo it'"'"'s
two lines" TERM
    trap "" HUP
    trap >"$T.0"
    heavy_lock one || exit 9
    heavy_unlock
    trap >"$T.1"
    heavy_lock two || exit 9
    trap "echo \"in-block exit \$?\"" EXIT
    heavy_unlock
    trap >"$T.2"
    trap "" INT
    heavy_lock three || exit 9
    trap >"$T.3"
    '"$END" _ "$1" "$W/t" >"$W/out" 2>&1 && _rc=0 || _rc=$?
  cmp -s "$W/t.0" "$W/t.1" || why "an unlock did not put the caller's traps back: $(tr '\n' '|' <"$W/t.1")" || return 1
  grep -q 'in-block exit' "$W/t.2" || why "the unlock removed a trap the caller set inside the block" || return 1
  grep -q "^trap -- '' INT" "$W/t.3" || why "an ignored INT was un-ignored by the lock" || return 1
  [ "$_rc" = 3 ] || why "exit 3 inside the block exited $_rc" || return 1
  [ "$(cat "$W/out")" = "in-block exit 3" ] || why "the caller's EXIT trap printed: $(cat "$W/out")" || return 1
  [ ! -d "$W/lock" ] || why "exit inside the block left the lock behind"
}

# The same three, under `set -e` — which every caller runs with, and which a
# trap that sets $? with a bare non-zero command trips: the shell exits inside
# the trap, before the caller's handler runs.
SETE=':'
sete() { SETE='set -e'; _sr=0; "$@" || _sr=$?; SETE=':'; return "$_sr"; }
case_ctrlc_e() { sete case_ctrlc "$@"; }
case_term_e()  { sete case_term "$@"; }
case_traps_e() { sete case_traps "$@"; }

# A wait that runs out fails the step, and leaves the holder's lock alone.
case_timeout() {
  MIND_HEAVY_LOCK="$W/lock" "$2" -c '. "$1"; heavy_lock holder || exit 9; echo held >"$2"; sleep 20' _ "$1" "$W/held" 2>/dev/null &
  HP=$!; KIDS="$KIDS $HP"
  waitfor "$W/held" || why "the holder never took the lock" || return 1
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=2 "$2" -c '. "$1"; heavy_lock waiter && echo GOT' _ "$1" >"$W/out" 2>&1 &
  WP=$!; KIDS="$KIDS $WP"
  _rc=0; waitpid "$WP" 9 || _rc=$?
  [ "$_rc" != 0 ] && [ "$_rc" != 124 ] || why "the wait did not give up (status $_rc)" || return 1
  grep -q 'gave up after' "$W/out" || why "the give-up said nothing" || return 1
  grep -q "holder" "$W/lock/owner" || why "giving up disturbed the holder's lock"
}

# A heavy block inside another fails at once instead of waiting for itself.
case_nested() {
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=5 "$2" -c '
    . "$1"
    heavy_lock outer || exit 9
    "$2" -c ". \"\$1\"; heavy_lock inner" _ "$1"; echo "inner $?"
    heavy_unlock' _ "$1" "$2" >"$W/out" 2>&1 &
  WP=$!; KIDS="$KIDS $WP"
  T0=$(ms); waitpid "$WP" 10 || why "the outer block never finished" || return 1
  grep -q 'inner 1' "$W/out" || why "the nested lock did not fail: $(tail -1 "$W/out")" || return 1
  grep -q "own parent" "$W/out" || why "the nested lock did not say why" || return 1
  [ $(($(ms) - T0)) -lt 3000 ] || why "the nested lock waited before failing"
}

# A background job shares $$ with its script; the script asking again while
# the job holds the lock is refused, not waved through and not left waiting.
case_shared_pid() {
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=5 "$2" -c '
    . "$1"
    ( heavy_lock bg || exit 9; echo in >"$2"; sleep 3 ) &
    while [ ! -s "$2" ]; do sleep 0.1; done
    heavy_lock fg; echo "fg $?"
    wait' _ "$1" "$W/in" >"$W/out" 2>&1 &
  WP=$!; KIDS="$KIDS $WP"
  waitpid "$WP" 10 || why "it never finished" || return 1
  grep -q 'fg 1' "$W/out" || why "the second ask was not refused: $(tail -1 "$W/out")" || return 1
  grep -q "in this shell's name" "$W/out" || why "the refusal did not say why"
}

# Asking twice without letting go is refused rather than deadlocking.
case_twice() {
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=5 "$2" -c '. "$1"; heavy_lock a || exit 9; heavy_lock b; echo "second $?"' _ "$1" >"$W/out" 2>&1 &
  WP=$!; KIDS="$KIDS $WP"
  waitpid "$WP" 4 || why "it hung" || return 1
  grep -q 'second 1' "$W/out" || why "the second ask was not refused"
}

# No /tmp to write (a sandbox), or a file in the way: a loud failure within
# seconds, not 30 minutes of waiting for a holder that does not exist.
case_blind() {
  : >"$W/afile"
  for L in "$W/no/such/dir/lock" "$W/afile"; do
    MIND_HEAVY_LOCK="$L" "$2" -c '. "$1"; heavy_lock blind && echo GOT' _ "$1" >"$W/out" 2>&1 &
    WP=$!; KIDS="$KIDS $WP"
    _rc=0; waitpid "$WP" 6 || _rc=$?
    [ "$_rc" != 0 ] && [ "$_rc" != 124 ] || why "$L: not a prompt failure (status $_rc)" || return 1
    grep -q 'cannot create' "$W/out" || why "$L: the failure did not say why" || return 1
  done
}

# Under bin/dtp.sh the status card shows the wait, and gets its phase back.
case_phase() {
  printf 'lane X' >"$W/phase"
  MIND_HEAVY_LOCK="$W/lock" "$2" -c '. "$1"; heavy_lock holder || exit 9; echo held >"$2"; sleep 3; heavy_unlock' _ "$1" "$W/held" 2>/dev/null &
  HP=$!; KIDS="$KIDS $HP"
  waitfor "$W/held" || why "the holder never took the lock" || return 1
  MIND_PHASE_FILE="$W/phase" MIND_HEAVY_LOCK="$W/lock" "$2" -c '. "$1"; heavy_lock waiter || exit 9; cat "$MIND_PHASE_FILE" >"$2"; heavy_unlock' _ "$1" "$W/after" 2>/dev/null &
  WP=$!; KIDS="$KIDS $WP"
  sleep 1
  grep -q 'waiting for the heavy-build lock, held by .*holder' "$W/phase" \
    || why "the phase did not show the wait: $(cat "$W/phase")" || return 1
  waitpid "$WP" 10 || why "the waiter never got the lock" || return 1
  [ "$(cat "$W/after")" = "lane X" ] || why "the phase was not put back: $(cat "$W/after")"
}

# A lock whose taker died between its mkdir and its owner file is taken over
# after ten seconds of nobody writing one.
case_ownerless() {
  mkdir "$W/lock"
  MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=30 "$2" -c '. "$1"; heavy_lock lone && heavy_unlock' _ "$1" 2>"$W/err" &
  WP=$!; KIDS="$KIDS $WP"
  waitpid "$WP" 16 || why "it never took the ownerless lock — $(tail -1 "$W/err")" || return 1
  grep -q 'no owner for 10s' "$W/err" || why "the takeover said nothing"
}

# A holder and a waiter in different time zones and languages still agree the
# holder is alive. ps prints a start time in its caller's TZ and LC_TIME, so
# without one fixed zone a waiter read a LIVE holder's start as some other
# process's, took its lock and built beside it. Both zones are named here,
# neither left to the machine's: a check that leaned on the local zone would
# test nothing on a machine already set to the other one.
case_tz() {
  TZ=XXX-9 LC_ALL=fr_FR.UTF-8 MIND_HEAVY_LOCK="$W/lock" "$2" -c '
    . "$1"; heavy_lock "holder in another zone" || exit 9
    echo held >"$2"; sleep 8; heavy_unlock' _ "$1" "$W/held" 2>/dev/null &
  HP=$!; KIDS="$KIDS $HP"
  waitfor "$W/held" || why "the holder never took the lock" || return 1
  TZ=YYY+5 LC_ALL=C MIND_HEAVY_LOCK="$W/lock" MIND_HEAVY_WAIT=3 "$2" -c '. "$1"; heavy_lock waiter && echo GOT' _ "$1" >"$W/out" 2>&1 &
  WP=$!; KIDS="$KIDS $WP"
  _rc=0; waitpid "$WP" 9 || _rc=$?
  ! grep -q GOT "$W/out" \
    || why "a waiter in another zone took a live holder's lock: $(grep 'taking it over' "$W/out")" || return 1
  grep -q 'gave up after' "$W/out" || why "the waiter did not wait: $(tail -1 "$W/out")" || return 1
  grep -q 'holder in another zone' "$W/lock/owner" || why "the live holder's lock was disturbed"
}

# Two waiters on a dead holder. Both see it gone; both may try to break it —
# and the second, a moment late, still holds the dead owner's line after the
# first has broken the lock and TAKEN it. Under .break the owner is read again
# and only the SAME dead owner's lock is removed, so the late breaker leaves the
# live one alone. First two real waiters, which must take turns; then that
# interleaving with its order fixed, because the real race is too narrow to
# land on demand and it is the one a broken copy is caught by.
case_late_breaker() {
  sleep 0 & D=$!; wait "$D" || true
  mkdir "$W/lock"
  printf '%s\t-\t0\t00:00:00\tGoneRepo\tdead build\n' "$D" >"$W/lock/owner"
  P=""
  for n in 1 2; do
    MIND_HEAVY_LOCK="$W/lock" "$2" -c '
      . "$1"
      heavy_lock "waiter $2" || exit 9
      s=$(perl -MTime::HiRes=time -e "printf q{%d}, time * 1000")
      sleep 1.5
      e=$(perl -MTime::HiRes=time -e "printf q{%d}, time * 1000")
      echo "$s $e $2" >>"$3"
      heavy_unlock' _ "$1" "$n" "$W/iv" 2>>"$W/err" &
    P="$P $!"; KIDS="$KIDS $!"
  done
  for p in $P; do waitpid "$p" 15 || why "a waiter ended $? — $(tail -1 "$W/err")" || return 1; done
  [ "$(wc -l <"$W/iv" | tr -d ' ')" = 2 ] || why "not both waiters got the lock" || return 1
  sort -n "$W/iv" | awk 'NR > 1 && $1 < e { bad = 1 } { e = $2 } END { exit bad }' \
    || why "the two waiters overlapped: $(sort -n "$W/iv" | tr '\n' ';')" || return 1

  # The fixed order: B reads the dead owner; A breaks it and takes the lock;
  # only then does B, its stale line in hand, break.
  mkdir "$W/lock"
  printf '%s\t-\t0\t00:00:00\tGoneRepo\tdead build\n' "$D" >"$W/lock/owner"
  MIND_HEAVY_LOCK="$W/lock" "$2" -c '
    . "$1"
    stale=$(cat "$HEAVY_LOCK/owner")
    "$3" -c ". \"\$1\"; heavy_lock \"waiter A\" || exit 9; echo held >\"\$2\"; sleep 4; heavy_unlock" _ "$1" "$2" &
    A=$!
    while [ ! -s "$2" ]; do sleep 0.1; done
    _hl_break "$stale" "$4"
    cat "$HEAVY_LOCK/owner" >"$2.after" 2>/dev/null || echo "no lock at all" >"$2.after"
    wait "$A"' _ "$1" "$W/held" "$2" "$D" 2>>"$W/err" &
  WP=$!; KIDS="$KIDS $WP"
  waitpid "$WP" 15 || why "the interleaving never finished — $(tail -1 "$W/err")" || return 1
  grep -q 'waiter A' "$W/held.after" \
    || why "a late breaker removed the lock a live waiter had taken over: $(cat "$W/held.after")" || return 1
  [ ! -d "$W/lock" ] || why "the lock outlived its holders"
}

# ---------------------------------------------------------- the Ctrl-C driver
# Ctrl-C has to be TYPED to be the real thing: a script's background job has
# INT ignored from birth, so `kill -INT` from here proves nothing about a
# terminal. This puts the script on a pseudo-terminal and types ^C into it.
cat >"$TMP/ctrlc.py" <<'PY'
import os, pty, select, sys, time
sh, script, helper = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sh, [sh, '-c', script, '_', helper])
out = b''
def pump(until, secs):
    global out
    end = time.time() + secs
    while time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            out += chunk
            if until and until in out:
                return
pump(b'held', 10)
time.sleep(0.5)
os.write(fd, b'\x03')
pump(None, 10)
_, st = os.waitpid(pid, 0)
text = out.decode(errors='replace').replace('\r', '').replace('^C', '')
sys.stdout.write(text if text.endswith('\n') else text + '\n')
print('status', 'signal %d' % os.WTERMSIG(st) if os.WIFSIGNALED(st) else 'exit %d' % os.WEXITSTATUS(st))
PY
# The driver needs a Python with a Unix pty. Native Windows Python has none
# (no termios, no fork), and a case whose driver cannot run proves nothing
# either way, so there the Ctrl-C cases, and the broken copies only they can
# catch, are skipped OUT LOUD and counted. With no working Python at all the
# cases still run, and fail, as they always did.
PTY=yes
. bin/python.sh
if ! mind_python; then
  MIND_PYTHON=python3
elif ! $MIND_PYTHON -c 'import os, pty, termios; os.fork' >/dev/null 2>&1; then
  PTY=no
fi
prun() { # like run, but skipped where the Ctrl-C driver has no pty
  if [ "$PTY" = yes ]; then run "$@"
  else skip "$2" "no pty for the Ctrl-C driver: $MIND_PYTHON has no pty, termios or fork"; fi
}

N=0
run() { # run <expect: pass|fail> <label> <case> <helper> <shell>
  N=$((N + 1)); W="$TMP/w$N"; mkdir -p "$W"; rm -f "$W/why"
  # The case's stderr is the shell's own chatter about the holders it killed
  # ("Killed: 9"), which is the point of those cases rather than news.
  _res=0; "$3" "$4" "$5" 2>>"$W/chatter" || _res=$?
  if [ "$1" = pass ]; then
    if [ "$_res" = 0 ]; then ok "$2"; else bad "$2 — $(cat "$W/why" 2>/dev/null)"; fi
  else
    # A broken copy must be caught for a stated reason: an empty reason means the
    # case never ran its check (a mistyped command also exits nonzero).
    if [ "$_res" != 0 ] && [ ! -s "$W/why" ]; then bad "$2 — failed with no reason given; the case did not run its check"
    elif [ "$_res" != 0 ]; then ok "$2 — caught: $(cat "$W/why" 2>/dev/null)"; else bad "$2 — the broken copy PASSED; this case cannot fail"; fi
  fi
}

SHELLS="sh"; command -v dash >/dev/null 2>&1 && SHELLS="sh dash"
for SH in $SHELLS; do
  echo "the helper, under $SH"
  run pass "three holders take turns, none overlapping"         case_serialize   "$HELPER" "$SH"
  run pass "kill -9 the holder: the waiter takes over, promptly" case_kill9      "$HELPER" "$SH"
  run pass "a recycled pid does not hold a dead build's lock"    case_reuse       "$HELPER" "$SH"
  prun pass "Ctrl-C releases, and ends the run as it would have" case_ctrlc      "$HELPER" "$SH"
  prun pass "…under set -e too, and a lane stops at its iOS step" case_ctrlc_e   "$HELPER" "$SH"
  run pass "TERM releases, and ends the run as it would have"   case_term        "$HELPER" "$SH"
  run pass "…under set -e too"                                  case_term_e      "$HELPER" "$SH"
  run pass "the caller's traps survive, and exit 3 is exit 3"   case_traps       "$HELPER" "$SH"
  run pass "…under set -e too, a failed command included"       case_traps_e     "$HELPER" "$SH"
  run pass "a holder in another TZ and language is seen alive"  case_tz          "$HELPER" "$SH"
  run pass "a late breaker leaves a live takeover's lock alone" case_late_breaker "$HELPER" "$SH"
  run pass "a wait that runs out fails, leaving the holder be"  case_timeout     "$HELPER" "$SH"
  run pass "a heavy block nested in another fails at once"      case_nested      "$HELPER" "$SH"
  run pass "a background job holding it is not waved through"  case_shared_pid  "$HELPER" "$SH"
  run pass "asking twice without letting go is refused"        case_twice       "$HELPER" "$SH"
  run pass "no lock to create is a loud failure, not a wait"   case_blind       "$HELPER" "$SH"
  run pass "the status card shows the wait, then gets it back" case_phase       "$HELPER" "$SH"
done
run pass "an ownerless lock is taken after 10s (sh)"           case_ownerless   "$HELPER" sh

# ------------------------------------------------------- broken copies
# Each sed must actually change the copy; a break that matched nothing would
# "pass" its case by testing the real thing.
broken() { # broken <name> <sed expr>
  sed -e "$2" "$HELPER" >"$TMP/$1.sh"
  if cmp -s "$HELPER" "$TMP/$1.sh"; then
    bad "the '$1' break matched nothing — fix this script"; return 1
  fi
}
echo "broken copies (each must be caught)"
broken mkdir-p 's/_hl_err=$(mkdir "$HEAVY_LOCK"/_hl_err=$(mkdir -p "$HEAVY_LOCK"/' \
  && run fail "a lock taken with mkdir -p lets holders overlap"   case_serialize "$TMP/mkdir-p.sh" sh
broken no-stale '/^_hl_alive() {$/a\
  return 0' \
  && run fail "a lock that never sees its holder gone waits on a corpse" case_kill9 "$TMP/no-stale.sh" sh \
  && run fail "…and on a recycled pid"                              case_reuse "$TMP/no-stale.sh" sh
broken no-trap 's/^    trap "_hl_on $_hl_sig" "$_hl_sig"$/    :/' \
  && prun fail "with no trap, Ctrl-C leaves the lock behind"        case_ctrlc "$TMP/no-trap.sh" sh \
  && run fail "…and so does TERM"                                   case_term  "$TMP/no-trap.sh" sh
broken blind-traps '/^_hl_rec() {$/a\
  return 0' \
  && run fail "not reading the caller's traps clobbers them"        case_traps "$TMP/blind-traps.sh" sh
broken no-timeout 's/if \[ "$_hl_waited" -ge "$HEAVY_WAIT" \]; then/if false; then/' \
  && run fail "with no bound, a wait never gives up"                case_timeout "$TMP/no-timeout.sh" sh
broken no-nesting '/^_hl_ancestor() {$/a\
  return 1' \
  && run fail "with no ancestor check, a nested block waits for itself" case_nested "$TMP/no-nesting.sh" sh
# The bare `_hl_return "$_hl_rc"` that 3a44ef0 shipped, put back at each of
# its three places in _hl_on in turn: a handled INT or TERM, the EXIT, and
# bash's EXIT on the way out of an unhandled signal.
broken bare-rc-handled '/^  if \[ "\$1" != EXIT \]/,/^  fi$/s/^    if _hl_return "\$_hl_rc"; then eval "\$_hl_ht"; else eval "\$_hl_ht"; fi$/    _hl_return "$_hl_rc"; eval "$_hl_ht"/' \
  && prun fail "a bare \$? under set -e skips a handled Ctrl-C's handler" case_ctrlc_e "$TMP/bare-rc-handled.sh" sh \
  && run fail "…and a handled TERM's"                               case_term_e  "$TMP/bare-rc-handled.sh" sh
broken bare-rc-exit '/^  if \[ "\$1" = EXIT \]/,/^  fi$/s/^    if _hl_return "\$_hl_rc"; then eval "\$_hl_ht"; else eval "\$_hl_ht"; fi$/    _hl_return "$_hl_rc"; eval "$_hl_ht"/' \
  && run fail "a bare \$? under set -e skips the caller's EXIT trap"  case_traps_e "$TMP/bare-rc-exit.sh" sh
broken bare-rc-raise 's/^    if _hl_return "\$_hl_rc"; then eval "\$_hl_t_EXIT"; else eval "\$_hl_t_EXIT"; fi$/    _hl_return "$_hl_rc"; eval "$_hl_t_EXIT"/' \
  && prun fail "…and turns a Ctrl-C into exit 130, so the lane goes on" case_ctrlc_e "$TMP/bare-rc-raise.sh" sh \
  && run fail "…and TERM's EXIT trap with it"                       case_term_e  "$TMP/bare-rc-raise.sh" sh
# The zone pin lives on the `ps -o lstart=` line; where ps has no -o (Git Bash
# on Windows) the helper reads /proc instead, which has no zone, and breaking
# a line that never runs proves nothing — so it is skipped there, out loud.
if ps -o pid= -p $$ >/dev/null 2>&1; then
  broken local-start 's/LC_ALL=C TZ=UTC0 ps -o lstart=/ps -o lstart=/' \
    && run fail "a start time in the caller's zone breaks a live lock" case_tz "$TMP/local-start.sh" sh
else
  skip "a start time in the caller's zone breaks a live lock" "this ps has no -o; the helper reads /proc"
fi
broken no-reread 's/if \[ -d "\$HEAVY_LOCK" \] && \[ "\$_hl_bline" = "\$1" \]; then/if [ -d "$HEAVY_LOCK" ]; then/' \
  && run fail "a breaker that does not re-read the owner breaks a live one" case_late_breaker "$TMP/no-reread.sh" sh

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
