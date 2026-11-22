#!/bin/sh
# dtp — deploy, tag, push, for ReadMind. tdtp — the same with the full test
# run in front: tools/tdtp.sh, which calls this with --full.
#
# Owner request, 2026-08-23: "tdtp all apps and sites" — the apps each carry a lane and
# this repo carried none, so a suite-wide release always left the site to be
# deployed by hand and untagged. Same gesture as everywhere else now:
#
#   0. refuse a tree with uncommitted TRACKED changes
#   1. (--full only) php tools/test.php — all or nothing
#   2. bump the MINOR version tag (--major: the MAJOR; x.y.0; this repo has no version FILE — the
#      tag is the version, so a previous bare tag is the counter). A bump that
#      failed to deploy is reused, not skipped past, same as the apps.
#   3. ./deploy.sh all   (prod + test + dev; the lint gate lives in there)
#   4. tag, push the app tag and main atomically
#   5. record the tag in MindSuite's version (../tools/mindsuite-release.mjs)
#
# No devices, no desktop: this is a website. What the apps' lanes spend on
# platform builds this one spends on deploying three instances.
set -e
cd "$(dirname "$0")/.."

FULL=0; MAJOR=0
for a in "$@"; do
  case "$a" in
    --full) FULL=1 ;;
    --major) MAJOR=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "refusing: this lane ships main, and HEAD is on '$BRANCH'" >&2
  exit 1
fi

# ------------------------------------------------------------------- the tree
# TRACKED changes only: two sessions share this repo, and untracked scratch
# must not block a release the way an unstaged edit must.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "refusing: uncommitted tracked changes — the tag must name exactly what shipped" >&2
  exit 1
fi
git pull --autostash --quiet
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "refusing: the pull left the tree dirty (a conflicted autostash pop exits 0)" >&2
  exit 1
fi

# -------------------------------------------------------------------- the gate
if [ "$FULL" = 1 ]; then
  echo "==> tdtp: the full run, before anything is touched"
  php tools/test.php || { echo "tests failed — nothing shipped" >&2; exit 1; }
fi

# ---------------------------------------------------------------- the version
# The tag IS the version here. Start with imported tags, and count
# future releases from the newest version in the ReadMind namespace.
CUR_TAG=$(git tag --list 'ReadMind/[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
if [ -z "$CUR_TAG" ]; then
  CUR_TAG=$(git tag --list 'ReadMind/legacy/[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
fi
CUR=${CUR_TAG##*/}; CUR=${CUR:-0.0.0}
if [ -n "$CUR_TAG" ] && git diff --quiet "$CUR_TAG" HEAD -- .; then
  echo "refusing: ReadMind has no changes since $CUR_TAG" >&2
  exit 1
fi
MAJ=${CUR%%.*}; REST=${CUR#*.}; MIN=${REST%%.*}
# --major: the next MAJOR instead (x+1.0.0), for a suite-wide major release (MindSuite 1.0.0, 2026-11-22).
if [ "$MAJOR" = 1 ]; then NEW="$((MAJ + 1)).0.0"; else NEW="$MAJ.$((MIN + 1)).0"; fi

# ----------------------------------------------------------------- the deploy
./deploy.sh all

# --------------------------------------------------------------- tag and push
TAG="ReadMind/$NEW"
git tag -a "$TAG" -m "ReadMind $NEW"
git push --atomic origin main "refs/tags/$TAG" || {
  git tag -d "$TAG" >/dev/null 2>&1 || true
  echo "push rejected — main moved on the remote. Pull and re-run; the deploy already landed." >&2
  exit 1
}

# MindSuite's minor follows every app release, with a note naming this tag. Not
# fatal: the site is live and tagged; a missed record is reported, ending non-zero.
if ! node "${MINDSUITE_RELEASE_TOOL:-../tools/mindsuite-release.mjs}" record ReadMind "$TAG"; then
  echo "$NEW IS LIVE AND TAGGED, BUT MindSuite does not name $TAG yet; from the suite root: node tools/mindsuite-release.mjs record ReadMind $TAG" >&2
  exit 1
fi

echo "==> dtp done: $NEW is live on prod, test and dev"
