#!/bin/sh
# dtp the suite — deploy, tag, push, across every repo, in dependency order.
#
#   sh bin/dtp.sh all                every repo, core first
#   sh bin/dtp.sh CalMind            CalMind — and MealMind, which depends on it
#   sh bin/dtp.sh --only AcctMind    that one alone
#   sh bin/dtp.sh all --plan         resolve the order and stop
#   sh bin/dtp.sh all --full         tdtp: the full test run in each lane
#   sh bin/dtp.sh all --platforms    …and build the platforms too: the macOS
#                                    bundle and the iOS build on the phone
#
# WHERE A PLATFORM BUILD ACTUALLY HAPPENS depends on the app, and that rule has
# one home now: AGENTS.md's Platforms section. Short version — an app carrying
# its own tools/build-platforms.sh ships itself and gets --platforms passed
# through to its lane; bin/build-platforms.sh is the fallback for one that does
# not, which is none of the six apps today. Detected, not listed: see
# SELF_SHIPS in the lane below.
#
# Each repo's OWN lane does the work — tools/dtp.sh in each app, which
# already bump the minor version, refuse a dirty tree or a non-main branch,
# never tag around a failed deploy, and push atomically. (A private
# target, named in .private-targets, rides along: it carries no canon, so
# `core` never cascades into it, and its own build IS its deploy — its lane
# takes --web as a no-op rather than as "skip the platform build".) This adds exactly two
# things: the ORDER (bin/plan.sh's graph, the one bin/deploy.sh sources too) and
# the fact that stopping at a failure leaves everything after it unshipped
# rather than half-shipped in an order nobody chose.
#
# CORE's lane is different, because CoreMind ships to no server: it copies
# nothing into the apps. It runs @mind/core's own checks and the shared-files
# comparison (tools/check-shared.mjs), refuses to go on if any tracked file
# changed while it did, then tags and pushes itself. A consumer left with
# uncommitted changes stops the run — the apps below it would otherwise be
# tagged as the release that was checked while not being it.
set -e
cd "$(dirname "$0")/.."
PARENT="${MIND_DIR:-$(cd .. && pwd)}"
. bin/plan.sh

FULL=0; ONLY=0; PLANONLY=0; PLATFORMS=0; WANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full)         FULL=1 ;;
    --only)         ONLY=1 ;;
    --plan)         PLANONLY=1 ;;
    --platforms)    PLATFORMS=1 ;;
    -*)             echo "unknown flag: $1" >&2; exit 1 ;;
    all)            WANT="$ORDER" ;;
    *)              WANT="$WANT $1" ;;
  esac
  shift
done
resolve_plan

LANE=dtp; [ "$FULL" = 0 ] || LANE=tdtp
echo "==> $LANE plan:$PLAN"
[ "$ONLY" = 1 ] && echo "    (--only: downstream cascade suppressed)"
[ "$PLANONLY" = 0 ] || exit 0

# ------------------------------------------------------- look before shipping
# Every repo in the plan is checked BEFORE the first one ships. A run that
# stops on repo three because repo three was on a branch has already tagged
# and pushed two releases, and those cannot be taken back.
echo ""
echo "==> pre-flight"
for T in $PLAN; do
  # `core` is THIS checkout — resolved from the script, not by guessing a
  # directory called CoreMind next door. Those can be two different repos, and
  # then the branch and clean checks pass on one while the tag lands on the
  # other.
  case "$T" in core) R="$(pwd)" ;; *) R="$PARENT/$T" ;; esac
  [ -d "$R" ] || { echo "  no checkout at $R" >&2; exit 1; }
  B=$(git -C "$R" rev-parse --abbrev-ref HEAD)
  [ "$B" = "main" ] || { echo "  $T is on branch '$B', not main" >&2; exit 1; }
  if [ -n "$(git -C "$R" status --porcelain --untracked-files=no)" ]; then
    echo "  $T has uncommitted tracked changes:" >&2
    git -C "$R" status --porcelain --untracked-files=no | sed 's/^/    /' >&2
    exit 1
  fi
  git -C "$R" remote get-url origin >/dev/null 2>&1 \
    || { echo "  $T has no origin remote — the lane ends in a push" >&2; exit 1; }
  printf '  \033[32m✓\033[0m %-10s main, clean, has an origin\n' "$T"
done


trap 'trap - INT; kill -s INT $$; exit 130' INT
trap 'trap - TERM; kill -s TERM $$; exit 143' TERM

PLATFORM_OK=""; PLATFORM_BAD=""
for T in $PLAN; do
  echo ""
  echo "──────────────────────────────── $LANE $T"
  case "$T" in
    core)
      # tdtp means the tests run. Without this a bare core lane tags and pushes
      # having run only the checks below.
      if [ "$FULL" = 1 ]; then
        echo "==> CoreMind's own suite"
        npm test
        npm run -s typecheck
      fi
      # Core copies nothing into the apps: the TypeScript lives once in
      # packages/mind-core and the byte-identical files are listed in
      # tools/shared-files.json. The lane CHECKS both, from the suite root one
      # directory up (check-shared resolves its own root), and `set -e` stops
      # the run on either — nothing is tagged.
      npm --prefix .. run -s check:mind-core
      node ../tools/check-shared.mjs
      # Nothing above writes a tracked file. A tree that is dirty now was dirty
      # when the checks read it, so what they proved is not what a tag names.
      if [ -n "$(git status --porcelain --untracked-files=no -- .)" ]; then
        echo "CoreMind itself is dirty after the checks — look" >&2; exit 1
      fi
      for C in $(downstream_of core); do
        [ -d "$PARENT/$C" ] || continue
        if [ -n "$(git -C "$PARENT/$C" status --porcelain --untracked-files=no -- .)" ]; then
          echo "" >&2
          echo "$C has uncommitted changes — the checks above read them." >&2
          echo "Read and commit that in $C first; a release tagged now would" >&2
          echo "name a tree that had not been checked." >&2
          git -C "$PARENT/$C" status --porcelain --untracked-files=no -- . | sed 's/^/  /' >&2
          exit 1
        fi
      done
      VER=$(node -p "require('./package.json').version")
      if git show-ref --verify --quiet "refs/tags/CoreMind/$VER" ||
         git show-ref --verify --quiet "refs/tags/CoreMind/legacy-origin/$VER" ||
         git show-ref --verify --quiet "refs/tags/CoreMind/legacy/$VER"; then
        NEW=$(echo "$VER" | awk -F. '{printf "%d.%d.0", $1, $2+1}')
        perl -i -pe "s|\"version\": \"\Q$VER\E\"|\"version\": \"$NEW\"|" package.json
        grep -q "\"version\": \"$NEW\"" package.json \
          || { echo "guard: package.json does not carry $NEW" >&2; exit 1; }
        git commit -q -m "CoreMind $NEW" --only -- package.json
        VER="$NEW"
      fi
      TAG="CoreMind/$VER"
      git tag -a "$TAG" -m "CoreMind $VER"
      if ! git push --atomic origin main "refs/tags/$TAG"; then
        git tag -d "$TAG" >/dev/null
        echo "CoreMind's push was rejected — nothing tagged. Pull and re-run." >&2
        exit 1
      fi
      echo "==> CoreMind $VER tagged and pushed"
      # MindSuite's minor follows every release here too (../tools/mindsuite-release.mjs);
      # a miss is reported at the end, and the batch goes on: CoreMind is tagged either way.
      node "${MINDSUITE_RELEASE_TOOL:-../tools/mindsuite-release.mjs}" record CoreMind "$TAG" ||
        { echo "   MindSuite does not name $TAG yet; from the suite root: node tools/mindsuite-release.mjs record CoreMind $TAG" >&2
          PLATFORM_BAD="$PLATFORM_BAD CoreMind"; }
      ;;
    *)
      R="$PARENT/$T"
      # DOES THE APP SHIP ITSELF? An app carrying its own
      # tools/build-platforms.sh owns every artifact it releases, and this
      # script's job for it is only to run its lane in the right ORDER among
      # the others — the owner, 2026-08-23: "This repo should be able to ship
      # itself (and needed dependencies) on its own... coremind is to ship all
      # apps simultaneously."
      #
      # Detected rather than listed. MealMind grew the file first
      # (2026-08-23, morning); CalMind, AcctMind and MyCalMind grew theirs the
      # same day — every app ships itself now, and bin/build-platforms.sh
      # below is the fallback for a checkout that predates that.
      SELF_SHIPS=0
      [ -f "$R/tools/build-platforms.sh" ] && SELF_SHIPS=1
      # --platforms keeps its meaning for a self-shipping app by being passed
      # THROUGH: its lane builds everything when the flag is set and takes
      # --web (the release, no platform builds) when it is not. Without this
      # the flag would silently stop controlling half the suite.
      # NAMED, not implied, when the flag is set: since 2026-11-02 a bare app
      # dtp builds no platforms (the fast lane), so "every platform" has to be
      # said; a bare tdtp still builds all three, and naming them is the same.
      # Only to a lane that takes the names — PlanMind's takes --web and
      # --platforms only, and a bare call there still means all of them.
      # TaskMind's takes them too, in one `--mac|--ios|--android|--windows)` arm
      # (hence `[|)]`), and its bare call builds only the Mac and iOS apps, so
      # leaving the names out would have skipped its Android build.
      LANE_ARGS=""
      if [ "$SELF_SHIPS" = 1 ]; then
        if [ "$PLATFORMS" = 0 ]; then LANE_ARGS="--web"
        elif grep -Eq -- '--mac[|)]' "$R/tools/dtp.sh" 2>/dev/null; then LANE_ARGS="--mac --ios --android"
        fi
      fi
      # A SELF-SHIPPING LANE ENDS NON-ZERO WHEN A DEVICE BUILD DID NOT FINISH
      # (2026-08-23) — the release still shipped, tagged and pushed; only the
      # exit status refuses to call a partial run clean. Under `set -e` that
      # would abort this batch at the first app with an unplugged phone and
      # stop every repo after it from shipping at all, which is a far worse
      # answer than the one the exit code is trying to give. So it is caught:
      # the lane's verdict is remembered and folded into THIS script's own exit
      # status at the end, and the remaining repos still run.
      LANE_RC=0
      # Every tag the repo carries BEFORE its lane runs — what the verdict
      # below measures against. See there for why HEAD's tags alone are not.
      # Origin's too: a lane's own pull fetches tags, and one that only arrived that way was
      # never this lane's (2026-11-22).
      TAGS_BEFORE=$( { git -C "$R" tag --list "$T/*"
        git -C "$R" ls-remote --tags --refs origin "refs/tags/$T/*" 2>/dev/null | sed 's|^.*refs/tags/||'; } )
      if [ "$FULL" = 1 ]; then
        ( cd "$R" && sh tools/tdtp.sh $LANE_ARGS ) || LANE_RC=$?
      else
        ( cd "$R" && sh tools/dtp.sh $LANE_ARGS ) || LANE_RC=$?
      fi
      if [ "$LANE_RC" != 0 ]; then
        # A LANE THAT WAS STOPPED did not ship with a build owed, whatever its
        # tags say. Above 128 is death by a signal (128+n) — the lane killed
        # on its own, so this shell never saw the signal and its trap never
        # fired. Read by the tag below, a lane stopped in its device builds
        # was "shipped, a platform build did not finish" and the batch went on
        # to the next repo (found 2026-10-01). A lane owing a device build
        # ends 1.
        if [ "$LANE_RC" -gt 128 ]; then
          echo "   $T was stopped by a signal (status $LANE_RC) — stopping the batch" >&2
          exit "$LANE_RC"
        fi
        # Distinguish "shipped, a device build is owed" from "did not ship".
        # A lane that failed BEFORE its tag leaves no new tag behind, so the
        # tag is the evidence, not the exit code — but only a tag THIS lane
        # made. Asking whether HEAD carries any tag at all (the test until
        # 2026-10-01) gets it backwards for an app with nothing new since its
        # last release: HEAD is still that release's bump commit, still
        # tagged, so a lane that died at the drift gate, the dirty check, the
        # tdtp tests or "tag already exists" was read as shipped — the batch
        # went on shipping the repos after it.
        # Reachable from HEAD, not AT it: after the push the lane records the tag in
        # MindSuite's version (tools/mindsuite-release.mjs), which fast-forwards the
        # checkout one commit past the tag (2026-11-22).
        SHIPPED=""
        for TG in $(git -C "$R" tag --merged HEAD --list "$T/*" 2>/dev/null); do
          printf '%s\n' "$TAGS_BEFORE" | grep -qxF "$TG" || SHIPPED="$TG"
        done
        if [ -n "$SHIPPED" ]; then
          echo "   $T shipped; something after its push did not finish (its lane said what)" >&2
          PLATFORM_BAD="$PLATFORM_BAD $T"
        else
          echo "   $T FAILED before it shipped — stopping the batch" >&2
          exit "$LANE_RC"
        fi
      fi
      if [ "$SELF_SHIPS" = 1 ] && [ "$PLATFORMS" = 1 ] && [ "$LANE_RC" = 0 ]; then
        # Its own lane already did them, in the right place: the desktop
        # bundle before its tag, the device builds after its push. ONLY when
        # the lane ended clean — a repo cannot be in both lists, which is
        # what the 2026-09-18 batch printed for all four of them.
        PLATFORM_OK="$PLATFORM_OK $T"
      fi
      # THE PLATFORMS THE RELEASE DID NOT SHIP. Run AFTER the lane, and its
      # failure is reported rather than fatal: by this point the app is
      # deployed, tagged and pushed, and none of that comes back because a
      # Rust build or a phone did not cooperate. The run still ends non-zero,
      # so "it all worked" cannot be read off the exit status.
      if [ "$PLATFORMS" = 1 ] && [ "$SELF_SHIPS" = 0 ] && [ "$T" != "MyCalMind" ]; then
        if sh bin/build-platforms.sh "$T"; then
          PLATFORM_OK="$PLATFORM_OK $T"
        else
          echo "   PLATFORM BUILD FAILED for $T — the release itself shipped" >&2
          PLATFORM_BAD="$PLATFORM_BAD $T"
        fi
      fi
      ;;
  esac
done

echo ""
echo "────────────────────────────────"
echo "$LANE complete:$PLAN"
if [ "$PLATFORMS" = 1 ]; then
  [ -z "$PLATFORM_OK" ]  || echo "platforms built:$PLATFORM_OK"
fi

trap - EXIT INT TERM

if [ -n "$PLATFORM_BAD" ]; then
  echo "unfinished after shipping:$PLATFORM_BAD (their releases shipped; see each one's report above)" >&2
  exit 1
fi
