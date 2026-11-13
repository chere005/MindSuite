#!/bin/sh
# One name-free root commit for the public repository (docs/PUBLISH.md, step 3).
#
#   sh tools/publish/squash-reroot.sh [options]
#
#   --repo DIR          the repository (default: the one holding the current directory)
#   --from REV          the revision whose TREE becomes the root (default: main)
#   --branch NAME       the local branch that gets the root (default: public-main)
#   --marker APP/X.Y.Z  (repeatable) the release X.Y.Z of APP was shipped before this repository existed. Creates the
#                       LOCAL annotated tag APP/legacy/X.Y.Z on the root, which the release lanes read as "taken"
#                       (they bump past it; ReadMind derives its next version from it). Not matched by the Release
#                       workflows' tag filters, never exported, never pushed.
#   --tag APP/X.Y.Z     (repeatable) a real release tag on the root. Pushing one starts that app's Release workflow, so
#                       the default is none: the lane creates the tag of each first release itself.
#   --export DIR        a new bare repository holding exactly what would be pushed: refs/heads/main and the --tag tags,
#                       nothing else (scan it with tools/publish/public-scan.sh --from DIR before any push)
#   --replace           move an existing branch, marker or tag of that name (default: refuse)
#   --rehearsal         accept a tree without CoreMind/bin/names-strict (the N7 flip). A rehearsal root is never published.
#
# The root commit:
#   - tree = the tree of REV, byte for byte; no parent.
#   - author, committer and tagger = PUBLISH_NAME / PUBLISH_EMAIL (defaults: MindSuite <noreply@users.noreply.github.com>),
#     set through the environment for every git call that makes an object, with the global and system git config switched
#     off: the machine's own identity, signing key and hooks never reach the commit. The email must be a noreply address
#     and must differ from the machine's configured identity. Timestamps are UTC (PUBLISH_DATE="<epoch> +0000" to pin one).
#   - message: "MindSuite: initial public commit".
#   - identity, message and tag messages go through CoreMind/bin/check-names.sh message first (exit 2 without a needle
#     list: fail closed).
#
# Old tags: none is carried. The seed tags (and every tag that points into the old history) stay behind; this script never
# pushes, never uses --tags and works only in a repository that has no remote.
#
# Exit: 0 done, 1 refused (the reason is printed), 2 cannot run.
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
CHECK="$ROOT/CoreMind/bin/check-names.sh"
CALLER=$(pwd -P)

REPO=
FROM=main
BRANCH=public-main
REPLACE=0
REHEARSAL=0
EXPORT=
MARKERS=
TAGS=
NL='
'
die() { echo "squash-reroot: $*" >&2; exit 1; }
cant() { echo "squash-reroot: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || cant "--repo needs a directory"; REPO=$2; shift 2 ;;
    --from) [ $# -ge 2 ] || cant "--from needs a revision"; FROM=$2; shift 2 ;;
    --branch) [ $# -ge 2 ] || cant "--branch needs a name"; BRANCH=$2; shift 2 ;;
    --marker) [ $# -ge 2 ] || cant "--marker needs APP/X.Y.Z"; MARKERS="$MARKERS$2$NL"; shift 2 ;;
    --tag) [ $# -ge 2 ] || cant "--tag needs APP/X.Y.Z"; TAGS="$TAGS$2$NL"; shift 2 ;;
    --export) [ $# -ge 2 ] || cant "--export needs a directory"; EXPORT=$2; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --rehearsal) REHEARSAL=1; shift ;;
    *) cant "unknown argument: $1" ;;
  esac
done

[ -f "$CHECK" ] || cant "CoreMind/bin/check-names.sh is missing next to this script"
. "$ROOT/CoreMind/bin/python.sh"
mind_python || cant "no Python 3"

if [ -z "$REPO" ]; then
  REPO=$(git rev-parse --show-toplevel 2>/dev/null) || cant "not inside a git repository (use --repo)"
fi
case "$REPO" in /*) ;; *) REPO="$CALLER/$REPO" ;; esac
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || cant "$REPO is not a git repository"
case "$EXPORT" in ''|/*) ;; *) EXPORT="$CALLER/$EXPORT" ;; esac

# Plain git for everything that makes an object: no global or system config (signing, hooks, aliases, identity).
g() { GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" -c commit.gpgsign=false -c tag.gpgsign=false -c tag.forceSignAnnotated=false "$@"; }

# ------------------------------------------------------------------ preconditions
[ -z "$(git -C "$REPO" remote)" ] ||
  die "the repository has a remote; re-root in a repository that has none (a scratch clone: git remote remove <name>). A root is made where nothing can be pushed from."
SRC=$(git -C "$REPO" rev-parse --verify -q "$FROM^{commit}") || die "$FROM is not a commit in $REPO"
T=$(git -C "$REPO" rev-parse "$SRC^{tree}")

if ! git -C "$REPO" cat-file -e "$SRC:CoreMind/bin/names-strict" 2>/dev/null; then
  if [ "$REHEARSAL" = 1 ]; then
    echo "squash-reroot: REHEARSAL - $FROM has no CoreMind/bin/names-strict (the strict flip is not done); this root must not be published"
  else
    die "$FROM has no CoreMind/bin/names-strict: the strict flip (N7) is not done. Pass --rehearsal only for a dry run."
  fi
fi

NAME=${PUBLISH_NAME:-MindSuite}
EMAIL=${PUBLISH_EMAIL:-noreply@users.noreply.github.com}
case "$EMAIL" in
  *noreply*@*|*@*noreply*) ;;
  *) die "PUBLISH_EMAIL must be a noreply address" ;;
esac
case "$NAME$EMAIL" in
  *"$NL"*|*'<'*|*'>'*) die "PUBLISH_NAME / PUBLISH_EMAIL must be one line without angle brackets" ;;
esac
[ -n "$NAME" ] || die "PUBLISH_NAME is empty"
MN=$(git -C "$REPO" config --get user.name 2>/dev/null || true)
ME=$(git -C "$REPO" config --get user.email 2>/dev/null || true)
if [ -n "$ME" ] && [ "$EMAIL" = "$ME" ]; then die "PUBLISH_EMAIL equals this machine's configured git email: use a neutral address"; fi
if [ -n "$MN" ] && [ "$NAME" = "$MN" ]; then die "PUBLISH_NAME equals this machine's configured git name: use a neutral name"; fi

DATE=${PUBLISH_DATE:-"$(date -u +%s) +0000"}
printf '%s' "$DATE" | grep -Eq '^[0-9]+ \+0000$' || die "PUBLISH_DATE must look like '<epoch seconds> +0000' (UTC only)"
MSG='MindSuite: initial public commit'

if git -C "$REPO" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null && [ "$REPLACE" != 1 ]; then
  die "branch $BRANCH exists (--replace moves it)"
fi
[ "$(git -C "$REPO" symbolic-ref -q HEAD || true)" != "refs/heads/$BRANCH" ] || die "$BRANCH is the checked-out branch; check out another one first"
if [ -n "$EXPORT" ] && [ -e "$EXPORT" ]; then die "--export target $EXPORT exists"; fi

# ------------------------------------------------------------------ the version each tag claims
PYVER=$(cat <<'PY'
import json, re, subprocess, sys
repo, rev, app = sys.argv[1:4]
def show(p):
    r = subprocess.run(['git', '-C', repo, 'show', '%s:%s' % (rev, p)], capture_output=True)
    return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None
def jver(p, *keys):
    t = show(p)
    if t is None:
        return None
    d = json.loads(t)
    for k in keys:
        d = d.get(k) if isinstance(d, dict) else None
    return d
if app == 'ReadMind':
    print('-')                     # the lane counts tags; no file carries its version
    sys.exit(0)
if app == 'CalMind':                # the four files the Release workflow compares
    vs = [jver('CalMind/apps/app/app.json', 'expo', 'version'), jver('CalMind/desktop/package.json', 'version'),
          jver('CalMind/desktop/src-tauri/tauri.conf.json', 'version')]
    m = re.search(r'^version = "([^"]*)"', show('CalMind/desktop/src-tauri/Cargo.toml') or '', re.M)
    vs.append(m.group(1) if m else None)
else:
    vs = [jver('%s/package.json' % app, 'version')]
if None in vs or len(set(vs)) != 1:
    print('mismatch')
    sys.exit(1)
print(vs[0])
PY
)
APPS=' AcctMind CalMind ChefMind CoreMind PlanMind ReadMind TaskMind '

# $1 = APP/X.Y.Z -> prints "APP X.Y.Z"; refuses anything the tree does not carry
claim() {
  spec=$1
  case "$spec" in */*/*|*/|/*|'') die "bad tag name '$spec' (expected APP/X.Y.Z)" ;; esac
  app=${spec%%/*}; ver=${spec#*/}
  case "$APPS" in *" $app "*) ;; *) die "unknown app in '$spec'" ;; esac
  printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "'$spec': the version must be X.Y.Z"
  have=$($MIND_PYTHON -c "$PYVER" "$REPO" "$SRC" "$app") || die "'$spec': $app's version files disagree or are missing in $FROM (the Release workflow would refuse it too)"
  if [ "$have" != "-" ] && [ "$have" != "$ver" ]; then
    die "'$spec': $FROM carries $app $have, not $ver. Bring the version files to $ver first (docs/PUBLISH.md, Version sync)."
  fi
  echo "$app $ver"
}

PLAN=
for spec in $MARKERS; do
  r=$(claim "$spec"); a=${r% *}; v=${r#* }
  PLAN="${PLAN}refs/tags/$a/legacy/$v $a $v marker$NL"
done
for spec in $TAGS; do
  r=$(claim "$spec"); a=${r% *}; v=${r#* }
  PLAN="${PLAN}refs/tags/$a/$v $a $v tag$NL"
done
SEEN=
for ref in $(printf '%s' "$PLAN" | awk '{print $1}'); do
  case "$SEEN" in *" $ref "*) die "$ref is named twice" ;; esac
  SEEN="$SEEN $ref "
  if git -C "$REPO" rev-parse --verify -q "$ref" >/dev/null && [ "$REPLACE" != 1 ]; then
    die "$ref exists (--replace moves it; an old seed tag of that name stays behind otherwise)"
  fi
done

# ------------------------------------------------------------------ no needle in the identity, the message or a tag message
TMP=$(mktemp -d "${TMPDIR:-/tmp}/squash-reroot.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
{
  printf '%s\n' "$MSG"
  printf '%s <%s>\n' "$NAME" "$EMAIL"
  printf '%s' "$PLAN" | while read -r ref a v kind; do [ -n "$a" ] && printf '%s %s\n' "$a" "$v"; done
} > "$TMP/message"
set +e
MIND_NAMES_OPTIONAL=0 sh "$CHECK" message "$TMP/message" > "$TMP/check.out" 2>&1
rc=$?
set -e
if [ "$rc" = 2 ]; then cat "$TMP/check.out" >&2; cant "the name check cannot run (no needle list?); nothing was created"; fi
if [ "$rc" != 0 ]; then tail -n 1 "$TMP/check.out" >&2; die "the identity, message or tag messages carry a needle; nothing was created"; fi

# ------------------------------------------------------------------ the root
export GIT_AUTHOR_NAME=$NAME GIT_AUTHOR_EMAIL=$EMAIL GIT_AUTHOR_DATE=$DATE
export GIT_COMMITTER_NAME=$NAME GIT_COMMITTER_EMAIL=$EMAIL GIT_COMMITTER_DATE=$DATE
C=$(printf '%s\n' "$MSG" | g commit-tree "$T")
if [ "$REPLACE" = 1 ]; then g update-ref "refs/heads/$BRANCH" "$C"
else g update-ref "refs/heads/$BRANCH" "$C" 0000000000000000000000000000000000000000; fi

printf '%s' "$PLAN" | while read -r ref a v kind; do
  [ -n "$ref" ] || continue
  if [ "$REPLACE" = 1 ]; then g tag -f -a -m "$a $v" "${ref#refs/tags/}" "$C" >/dev/null
  else g tag -a -m "$a $v" "${ref#refs/tags/}" "$C"; fi
done

# ------------------------------------------------------------------ verify what was made (the N7 acceptance, locally)
[ "$(g rev-list --count "$BRANCH")" = 1 ] || die "internal: $BRANCH does not hold exactly one commit"
[ "$(g rev-parse "$BRANCH^{tree}")" = "$T" ] || die "internal: the tree changed"
OBJ=$(g cat-file -p "$C")
[ "$(printf '%s\n' "$OBJ" | grep -c '^parent ')" = 0 ] || die "internal: the root has a parent"
[ "$(printf '%s\n' "$OBJ" | grep '^author ')" = "author $NAME <$EMAIL> $DATE" ] || die "internal: author line differs"
[ "$(printf '%s\n' "$OBJ" | grep '^committer ')" = "committer $NAME <$EMAIL> $DATE" ] || die "internal: committer line differs"
NM=0; NT=0
for ref in $(printf '%s' "$PLAN" | awk '{print $1}'); do
  [ "$(g cat-file -t "$ref")" = tag ] || die "internal: $ref is not an annotated tag"
  [ "$(g rev-parse "$ref^{commit}")" = "$C" ] || die "internal: $ref does not point at the root"
  [ "$(g cat-file -p "$ref" | grep '^tagger ')" = "tagger $NAME <$EMAIL> $DATE" ] || die "internal: tagger line of $ref differs"
done
NM=$(printf '%s' "$PLAN" | awk '$4 == "marker"' | wc -l | tr -d ' ')
NT=$(printf '%s' "$PLAN" | awk '$4 == "tag"' | wc -l | tr -d ' ')

# ------------------------------------------------------------------ export: exactly what would be pushed
if [ -n "$EXPORT" ]; then
  git init --bare -q "$EXPORT"
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$EXPORT" symbolic-ref HEAD refs/heads/main
  spec="+refs/heads/$BRANCH:refs/heads/main"
  for ref in $(printf '%s' "$PLAN" | awk '$4 == "tag" {print $1}'); do spec="$spec +$ref:$ref"; done
  # shellcheck disable=SC2086
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$EXPORT" fetch -q --no-tags "$REPO" $spec
  got=$(git -C "$EXPORT" for-each-ref --format='%(refname)' | sort | tr '\n' ' ')
  want=$( { echo refs/heads/main; printf '%s' "$PLAN" | awk '$4 == "tag" {print $1}'; } | sort | tr '\n' ' ')
  [ "$got" = "$want" ] || die "internal: the export holds refs other than main and the --tag tags"
  [ "$(git -C "$EXPORT" rev-list --all --count)" = 1 ] || die "internal: the export holds more than one commit"
fi

echo "squash-reroot: from $SRC"
echo "squash-reroot: root ${C} tree ${T} on $BRANCH: 1 commit, 0 parents, author=committer=tagger neutral, 0 needle hit(s) in identity and messages"
echo "squash-reroot: $NM marker tag(s) (local only), $NT release tag(s); no old tag carried"
[ -z "$EXPORT" ] || echo "squash-reroot: exported to $EXPORT (refs/heads/main$( [ "$NT" = 0 ] || echo " + $NT tag(s)" ) only)"
[ "$REHEARSAL" != 1 ] || echo "squash-reroot: REHEARSAL root - do not publish"
exit 0
