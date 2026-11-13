#!/bin/sh
# Compatibility shim: the old canon drift check, now a wrapper over check-shared.
#
#   sh bin/check-drift.sh                   every group in tools/shared-files.json
#   sh bin/check-drift.sh CalMind ChefMind  only groups with a member under those apps
#
# CoreMind holds no canon and no per-app manifests any more: tools/shared-files.json
# lists the byte-identical copies and tools/check-shared.mjs compares them. This
# script keeps only the interface seancheren-site's tools/taskmind-sync reads. It
# runs `node ../tools/check-shared.mjs` (one --app per name given), prints that
# output, and ends with the legacy line
#
#   <N> consumer(s): <D> drifted, 0 copies owed, <F> failures
#
# What the reader gets now: taskmind-sync calls this script with no name for
# CoreMind itself, and with an app name only for an app whose
# consumers/<App>.tsv exists. Those manifests are deleted, so until the site
# changes its board shows the CoreMind line and role "none" for the five apps.
#
# N is the number of apps checked (all five when none are named), and "copies
# owed" is always 0: there is no `owed` mode. D and F are check-shared's own
# counts; check-shared takes one --app, so naming several apps means one run per
# app, and a group that two named apps share is printed under both. Each distinct
# FAIL line is counted once, so naming every app reports what naming none does.
# The exit status is check-shared's; a run that prints no summary counts as a
# failure, and so does a nonzero exit with a clean summary. The suite root is the
# directory above this one, so MIND_DIR is not read. Delete this file once the
# site reads check-shared directly.
set -u
cd "$(dirname "$0")/.."
CHECK=../tools/check-shared.mjs
APPS="CalMind ChefMind AcctMind PlanMind TaskMind"

# A named app that is not one of the five is a typo, and a typo must not exit 0
# having compared nothing. Resolved BEFORE any work, so the message names it.
for WANT in "$@"; do
  case " $APPS " in
    *" $WANT "*) ;;
    *) echo "no such consumer '$WANT' - check-drift.sh takes: $APPS" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo "check-drift: node is required (it runs tools/check-shared.mjs)" >&2; exit 1; }
[ -f "$CHECK" ] || { echo "check-drift: $CHECK is missing" >&2; exit 1; }

OUT=$(mktemp "${TMPDIR:-/tmp}/checkdrift.XXXXXX") || { echo "check-drift: cannot create a temporary file" >&2; exit 1; }
SEEN=$(mktemp "${TMPDIR:-/tmp}/checkdrift.XXXXXX") || { rm -f "$OUT"; echo "check-drift: cannot create a temporary file" >&2; exit 1; }
trap 'rm -f "$OUT" "$SEEN"' EXIT

CHECKED=0; DRIFT=0; FAIL=0; RC=0; RUNS=0

# run_one <label> [--app <App>]: one check-shared run, folded into the totals.
run_one() {
  LABEL=$1; shift
  [ -z "$LABEL" ] || echo "== $LABEL"
  node "$CHECK" "$@" >"$OUT"; STATUS=$?
  cat "$OUT"
  RUNS=$((RUNS + 1))
  grep '^FAIL ' "$OUT" >>"$SEEN"
  SUMMARY=$(tail -n 1 "$OUT")
  case "$SUMMARY" in
    *' group(s): '*' drifted, '*' failures') ;;
    *) SUMMARY="" ;;
  esac
  if [ -n "$SUMMARY" ]; then
    D=$(printf '%s\n' "$SUMMARY" | sed -n 's/^[0-9]* group(s): \([0-9]*\) drifted, \([0-9]*\) failures$/\1/p')
    F=$(printf '%s\n' "$SUMMARY" | sed -n 's/^[0-9]* group(s): \([0-9]*\) drifted, \([0-9]*\) failures$/\2/p')
  else
    D=""; F=""
  fi
  if [ -z "$D" ] || [ -z "$F" ]; then
    echo "FAIL check-shared printed no summary line (exit $STATUS)"
    D=0; F=1
  elif [ "$STATUS" -ne 0 ] && [ "$F" -eq 0 ]; then
    echo "FAIL check-shared exited $STATUS with no failure counted"
    F=1
  fi
  DRIFT=$((DRIFT + D)); FAIL=$((FAIL + F))
  [ "$STATUS" -eq 0 ] || RC=1
}

if [ $# -eq 0 ]; then
  run_one ""
  CHECKED=5
else
  for NAME in $APPS; do
    case " $* " in *" $NAME "*) ;; *) continue ;; esac
    run_one "$NAME" --app "$NAME"
    CHECKED=$((CHECKED + 1))
  done
fi

# A group two named apps share was checked, and printed, once per app. Take the
# repeats out of the totals: they are one drifted copy, not two. (Synthetic
# failures above never reach SEEN, so they are never merged.)
if [ "$RUNS" -gt 1 ]; then
  ALL_FAIL=$(grep -c '^FAIL ' "$SEEN"); ONE_FAIL=$(LC_ALL=C sort -u "$SEEN" | grep -c '^FAIL ')
  ALL_DRIFT=$(grep -c '^FAIL drift ' "$SEEN"); ONE_DRIFT=$(LC_ALL=C sort -u "$SEEN" | grep -c '^FAIL drift ')
  DRIFT=$((DRIFT - (ALL_DRIFT - ONE_DRIFT))); FAIL=$((FAIL - (ALL_FAIL - ONE_FAIL)))
  [ "$DRIFT" -ge 0 ] || DRIFT=0
  [ "$FAIL" -ge 0 ] || FAIL=0
fi

echo
echo "--------------------------------"
echo "$CHECKED consumer(s): $DRIFT drifted, 0 copies owed, $FAIL failures"
[ "$RC" -eq 0 ] && [ "$FAIL" -eq 0 ]
