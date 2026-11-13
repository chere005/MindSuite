# The suite's release graph — SOURCED, never run. bin/deploy.sh and bin/dtp.sh
# both read it (`. bin/plan.sh`, before their flag loops, because `all` reads
# $ORDER there), so the order a deploy and a dtp ship in cannot disagree. It
# used to be two identical copies held together by a same-commit rule.
#
# The caller sets WANT and ONLY from its flags, then calls
# resolve_plan, which sets PLAN — or exits 1 saying why.
#
# THE GRAPH, and why each edge is real rather than tidy:
#
#   core ──▶ CalMind, ChefMind, AcctMind, PlanMind, TaskMind
#       Canon IS those repos' source. Change it and their builds change, so
#       shipping core without shipping them means the canonical bytes are
#       live nowhere. bin/deploy.sh fires this cascade only when core
#       actually wrote something; bin/dtp.sh always ships it, because its
#       core lane refuses a propagation that wrote anything.
#
#   CalMind ──▶ ChefMind
#       ChefMind has no server. It syncs through CalMind's API in the `chef`
#       space, and its own deploy REFUSES to ship unless the live API reports
#       that space. So CalMind's server must land first; ChefMind following
#       it automatically is the whole reason this ordering is in a script
#       instead of in somebody's memory.
#
# ReadMind has no edge. A private target has its own lane and runs last.

# Deployment order for the whole suite. Every run is a subset of this list, in
# this sequence — so a cascade can never reorder itself into shipping ChefMind
# before the API it checks.
PUBLIC_ORDER="core CalMind ChefMind AcctMind PlanMind TaskMind ReadMind"

# PRIVATE TARGETS. A target its owner keeps out of this repo is named, one per
# line, in an UNTRACKED file `.private-targets` at the CoreMind checkout root
# (gitignored; blank lines and `#` comments are ignored; no file = none). Each
# is appended to the order AFTER the public targets, so a run's sequence is the
# same as if it were listed here. The file is per machine. PRIVATE_TARGETS_FILE
# points elsewhere (the tests use it); a name must be a bare directory name.
PRIVATE=""
_pf="${PRIVATE_TARGETS_FILE:-.private-targets}"
if [ -f "$_pf" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    _line=${_line%%#*}
    _line=$(printf '%s' "$_line" | tr -d ' \t\r')
    [ -n "$_line" ] || continue
    case "$_line" in
      *[!A-Za-z0-9_.-]*|.*|-*)
        echo "$_pf: a line that is not a bare target name" >&2; exit 1 ;;
    esac
    # A paused project cannot enter this suite through a local override.
    [ "$_line" != MyCalMind ] || continue
    case " $PUBLIC_ORDER $PRIVATE " in
      *" $_line "*) ;;
      *) PRIVATE="$PRIVATE $_line" ;;
    esac
  done < "$_pf"
fi
ORDER="$PUBLIC_ORDER$PRIVATE"

downstream_of() {
  case "$1" in
    core)    echo "CalMind ChefMind AcctMind PlanMind TaskMind" ;;
    CalMind) echo "ChefMind" ;;
    *)       echo "" ;;
  esac
}

resolve_plan() {
  [ -n "$WANT" ] || { echo "name a target: all, core, CalMind, ChefMind, AcctMind, PlanMind, TaskMind, and any private target" >&2; exit 1; }

  for T in $WANT; do
    case " $ORDER " in
      *" $T "*) ;;
      *) echo "unknown target '$T' — one of: $PUBLIC_ORDER, or a private target" >&2; exit 1 ;;
    esac
  done

  # ----------------------------------------------------------- the closure
  # --only suppresses the cascade; otherwise every target drags its downstream
  # in. Resolved BEFORE anything ships, so the plan can be printed and read.
  SET="$WANT"
  if [ "$ONLY" = 0 ]; then
    # One pass per node in dependency order is enough for a graph two deep, and
    # a fixed number of passes cannot loop for ever if an edge is ever added.
    for _ in 1 2 3; do
      for T in $SET; do
        for D in $(downstream_of "$T"); do
          case " $SET " in *" $D "*) ;; *) SET="$SET $D" ;; esac
        done
      done
    done
  fi

  PLAN=""
  for T in $ORDER; do
    case " $SET " in *" $T "*) ;; *) continue ;; esac
    PLAN="$PLAN $T"
  done
  [ -n "$PLAN" ] || { echo "nothing to do" >&2; exit 1; }
}
