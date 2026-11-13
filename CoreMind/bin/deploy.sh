#!/bin/sh
# Deploy the suite — one target, or all of it, with DOWNSTREAM CASCADE.
#
#   sh bin/deploy.sh all                 core, then every app, in order
#   sh bin/deploy.sh core                core's checks; the apps only if named
#   sh bin/deploy.sh CalMind             CalMind — and then ChefMind, which needs it
#   sh bin/deploy.sh --only ChefMind     ChefMind alone, cascade suppressed
#   sh bin/deploy.sh all --dry-run       every step, writing nothing
#   sh bin/deploy.sh all --plan          resolve the order and stop
#
# CORE copies nothing: its step runs @mind/core's own checks and the
# shared-files comparison (the same two the dtp core lane runs), so a bare
# `core` never cascades into the apps by itself.
#
# THE GRAPH — its edges, and why each one is real rather than tidy — lives in
# bin/plan.sh, which this script and bin/dtp.sh both source.
#
# Flags: --quick (the fast gates where an app has them) · --dry-run
#        --only <target> (no cascade)
set -e
cd "$(dirname "$0")/.."
PARENT="${MIND_DIR:-$(cd .. && pwd)}"
. bin/plan.sh

QUICK=""; DRY=0; ONLY=0; PLANONLY=0; WANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick)        QUICK="--quick" ;;
    --dry-run)      DRY=1 ;;
    # --plan resolves the cascade and stops. --dry-run still RUNS every app's
    # deploy script (in its own dry mode), which costs a full export and gate
    # run per app; this is for reading the order back.
    --plan)         PLANONLY=1 ;;
    --only)         ONLY=1 ;;
    -*)             echo "unknown flag: $1" >&2; exit 1 ;;
    all)            WANT="$ORDER" ;;
    *)              WANT="$WANT $1" ;;
  esac
  shift
done
resolve_plan

echo "==> plan:$PLAN"
[ "$ONLY" = 1 ] && echo "    (--only: downstream cascade suppressed)"
[ "$PLANONLY" = 0 ] || exit 0
echo ""

repo_at() {
  R="$PARENT/$1"
  [ -d "$R" ] || { echo "no checkout at $R" >&2; exit 1; }
  echo "$R"
}

DRYFLAG=""
[ "$DRY" = 1 ] && DRYFLAG="--dry-run"

CORE_CASCADE=1; SHIPPED=""; SKIPPED=""
for T in $PLAN; do
  # THE GATE the header promises: the cascade fires only when core actually
  # wrote something. It was computed and printed and never consulted, so an
  # in-sync `deploy.sh core` shipped three apps to production while saying
  # nothing had propagated. Core now writes nothing at all, so this gate is
  # always shut after the core step.
  #
  # It drops only what came in BY CASCADE. A target the operator named — and
  # `all` names every one of them — ships on its own merit, which is what
  # they asked for.
  if [ "$CORE_CASCADE" = 0 ] && [ "$T" != "core" ]; then
    case " $WANT " in
      *" $T "*) ;;
      *) echo "──────────────────────────────── $T"
         echo "    skipped: here only because core is, and core copies nothing"
         echo ""
         SKIPPED="$SKIPPED $T"
         continue ;;
    esac
  fi
  echo "──────────────────────────────── $T"
  case "$T" in
    core)
      # The same two checks as the dtp core lane, from the suite root one
      # directory up. Both only read, so --dry-run runs them as they are; under
      # `set -e` either failing stops the deploy before any app is reached.
      npm --prefix .. run -s check:mind-core
      node ../tools/check-shared.mjs
      # Core wrote nothing (CORE_WROTE=0 in the old protocol), so every consumer
      # is exactly as it was and the apps that follow are here on their own
      # merit or not at all.
      CORE_CASCADE=0
      echo "    core wrote nothing — anything here ONLY because core is, drops out"
      ;;
    CalMind)
      R=$(repo_at CalMind)
      ( cd "$R" && ./server/deploy.sh prod test --yes-prod $QUICK $DRYFLAG )
      ;;
    ChefMind)
      R=$(repo_at ChefMind)
      # --yes-prod even on a dry run: the flag is the consent, and the script
      # refuses a bare run. --dry-run is what makes it write nothing.
      ( cd "$R" && ./deploy.sh --yes-prod $DRYFLAG )
      ;;
    AcctMind)
      R=$(repo_at AcctMind)
      ( cd "$R" && ./deploy.sh $QUICK $DRYFLAG )
      ;;
    PlanMind)
      R=$(repo_at PlanMind)
      ( cd "$R" && sh tools/deploy.sh --prod --yes-prod $QUICK $DRYFLAG )
      ;;
    TaskMind)
      R=$(repo_at TaskMind)
      ( cd "$R" && sh tools/deploy.sh --prod --yes-prod $QUICK $DRYFLAG )
      ;;
    ReadMind)
      R=$(repo_at ReadMind)
      ( cd "$R" && ./deploy.sh all $DRYFLAG )
      ;;
    *)
      # A private target (.private-targets, read by bin/plan.sh); anything
      # else is refused. No server and no store: the local install IS the
      # deploy. --quick is accepted there and does nothing if it has no fast
      # gate to skip.
      case " $PRIVATE " in
        *" $T "*) ;;
        *) echo "no deploy lane for '$T'" >&2; exit 1 ;;
      esac
      R=$(repo_at "$T")
      ( cd "$R" && sh tools/deploy.sh $QUICK $DRYFLAG )
      ;;
  esac
  SHIPPED="$SHIPPED $T"
  echo ""
done

echo "────────────────────────────────"
# What RAN, not what was planned. The old ending named the whole plan even
# when the cascade gate had dropped most of it — a summary that reads as three
# production deploys that did not happen.
if [ "$DRY" = 1 ]; then
  echo "dry run complete:${SHIPPED:- nothing}"
else
  echo "deployed:${SHIPPED:- nothing}"
fi
[ -z "$SKIPPED" ] || echo "skipped (core copies nothing, and these were here only for it):$SKIPPED"
