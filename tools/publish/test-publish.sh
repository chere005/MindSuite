#!/bin/sh
# Proves squash-reroot.sh, public-scan.sh and tools/githooks/pre-push on disposable repositories with SYNTHETIC needles (no real name, no network,
# no remote, nothing pushed). The scripts run from a scratch copy of the suite, so none of this checkout's untracked
# local files (needle list, digest list, machine files) take part.
#
#   sh tools/publish/test-publish.sh
#
# Exit: 0 every case passed, 1 a case failed.
set -u
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_NAMESPACE
HERE=$(cd "$(dirname "$0")/../.." && pwd -P)
T=$(mktemp -d "${TMPDIR:-/tmp}/test-publish.XXXXXX")
trap 'rm -rf "$T"' EXIT INT TERM
FAILS=0
PASS=0

ok() { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAILS=$((FAILS + 1)); echo "  FAIL $1"; }
# check NAME EXPECTED_EXIT -- command...   (output kept in $T/out)
check() {
  name=$1; want=$2; shift 3
  "$@" > "$T/out" 2>&1; rc=$?
  if [ "$rc" = "$want" ]; then ok "$name"; else bad "$name (exit $rc, wanted $want)"; sed 's/^/        /' "$T/out" | head -n 12; fi
}
yes_() { name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
no_() { name=$1; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }

# ---- the scratch suite: only the scripts and what they read
S=$T/suite
mkdir -p "$S/tools/publish" "$S/CoreMind/bin"
cp "$HERE/tools/publish/squash-reroot.sh" "$HERE/tools/publish/public-scan.sh" "$S/tools/publish/"
for f in check-names.sh check-personal-data.sh python.sh placeholder-ids.txt; do cp "$HERE/CoreMind/bin/$f" "$S/CoreMind/bin/"; done

# ---- synthetic inputs
NEEDLE=zqx
printf '%s\nquorvane\n' "$NEEDLE" > "$T/needles.txt"
: > "$T/allow.sha256"
printf '%s  synthetic\n' "$(printf 'qwertyplugh' | shasum -a 256 | cut -d' ' -f1)" > "$T/digests.sha256"
printf 'SYNTHETIC_DEVICE=Synthetic Phone Name\n' > "$T/machine.env"
export MIND_NEEDLES=$T/needles.txt MIND_NEEDLE_ALLOW=$T/allow.sha256 MIND_PERSONAL_HASHES=$T/digests.sha256 MIND_MACHINE_ENV=$T/machine.env
unset MIND_NAMES_OPTIONAL MIND_NAMES_STRICT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=tester@example.test GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=tester@example.test

SQ="sh $S/tools/publish/squash-reroot.sh"
SC="sh $S/tools/publish/public-scan.sh"

mkfix() { # DIR [extra-file-content]
  d=$1
  git init -q -b main "$d"
  mkdir -p "$d/AcctMind" "$d/PlanMind" "$d/CalMind/apps/app" "$d/CalMind/desktop/src-tauri" "$d/CoreMind/bin" "$d/ReadMind"
  echo '{"version":"0.62.0"}' > "$d/AcctMind/package.json"
  echo '{"version":"0.1.0"}' > "$d/PlanMind/package.json"
  echo '{"expo":{"version":"1.61.0"}}' > "$d/CalMind/apps/app/app.json"
  echo '{"version":"1.61.0"}' > "$d/CalMind/desktop/package.json"
  echo '{"version":"1.61.0"}' > "$d/CalMind/desktop/src-tauri/tauri.conf.json"
  printf '[package]\nversion = "1.61.0"\n' > "$d/CalMind/desktop/src-tauri/Cargo.toml"
  : > "$d/CoreMind/bin/names-strict"
  echo 'plain readme' > "$d/ReadMind/README.md"
  [ -z "${2:-}" ] || printf '%s\n' "$2" > "$d/ReadMind/notes.txt"
  git -C "$d" add -A
  git -C "$d" -c core.hooksPath=/dev/null commit -q -m 'first'
  echo second >> "$d/ReadMind/README.md"
  git -C "$d" -c core.hooksPath=/dev/null commit -q -am 'second'
  git -C "$d" tag -a AcctMind/0.62.0 -m seed
}

echo "squash-reroot.sh"
mkfix "$T/r1"
MAIN_TIP=$(git -C "$T/r1" rev-parse main)
git -C "$T/r1" remote add elsewhere "$T/nowhere.git"
check "refuses a repository that has a remote" 1 -- $SQ --repo "$T/r1"
git -C "$T/r1" remote remove elsewhere

check "refuses to run without a needle list (fail closed)" 2 -- env MIND_NEEDLES="$T/none.txt" $SQ --repo "$T/r1"
check "refuses a non-noreply email" 1 -- env PUBLISH_EMAIL=someone@example.test $SQ --repo "$T/r1"
git -C "$T/r1" config user.email noreply@machine.example.test
check "refuses the machine's own configured email" 1 -- env PUBLISH_EMAIL=noreply@machine.example.test $SQ --repo "$T/r1"
git -C "$T/r1" config --unset user.email
check "refuses a needle in the identity" 1 -- env PUBLISH_NAME="$NEEDLE bot" $SQ --repo "$T/r1"
check "refuses a non-UTC date" 1 -- env PUBLISH_DATE="1700000000 -0600" $SQ --repo "$T/r1"
check "refuses a marker the tree does not carry" 1 -- $SQ --repo "$T/r1" --marker AcctMind/9.9.9
check "refuses an unknown app" 1 -- $SQ --repo "$T/r1" --marker Nope/1.0.0
check "refuses a marker named with legacy in it" 1 -- $SQ --repo "$T/r1" --marker AcctMind/legacy/0.62.0
check "refuses the seed tag's own name without --replace" 1 -- $SQ --repo "$T/r1" --tag AcctMind/0.62.0
no_ "nothing was created by the refusals" git -C "$T/r1" rev-parse --verify -q refs/heads/public-main

mkfix "$T/r2"
printf '[package]\nversion = "1.60.0"\n' > "$T/r2/CalMind/desktop/src-tauri/Cargo.toml"
git -C "$T/r2" -c core.hooksPath=/dev/null commit -q -am 'drift'
check "refuses CalMind when its four version files disagree" 1 -- $SQ --repo "$T/r2" --marker CalMind/1.61.0

mkfix "$T/r3"
git -C "$T/r3" rm -q CoreMind/bin/names-strict
git -C "$T/r3" -c core.hooksPath=/dev/null commit -q -m 'no strict marker'
check "refuses a tree without the strict marker" 1 -- $SQ --repo "$T/r3"
check "--rehearsal accepts it and says so" 0 -- $SQ --repo "$T/r3" --rehearsal
grep -q 'REHEARSAL root - do not publish' "$T/out" && ok "a rehearsal root is announced as one" || bad "a rehearsal root is announced as one"

echo "  (building the real root in r1)"
check "makes the root, markers and the export" 0 -- $SQ --repo "$T/r1" --marker AcctMind/0.62.0 --marker CalMind/1.61.0 --marker ReadMind/0.5.0 --tag PlanMind/0.1.0 --export "$T/export.git"
[ "$(git -C "$T/r1" rev-list --count public-main)" = 1 ] && ok "one commit" || bad "one commit"
[ "$(git -C "$T/r1" rev-parse public-main^{tree})" = "$(git -C "$T/r1" rev-parse "$MAIN_TIP^{tree}")" ] && ok "same tree as the source" || bad "same tree as the source"
[ "$(git -C "$T/r1" cat-file -p public-main | grep -c '^parent ')" = 0 ] && ok "no parent" || bad "no parent"
git -C "$T/r1" cat-file -p public-main | grep -q '^author MindSuite <noreply@users.noreply.github.com> [0-9]* +0000$' && ok "neutral author in UTC" || bad "neutral author in UTC"
git -C "$T/r1" cat-file -p public-main | grep -q '^committer MindSuite <noreply@users.noreply.github.com> [0-9]* +0000$' && ok "neutral committer in UTC" || bad "neutral committer in UTC"
git -C "$T/r1" log -1 --format=%B public-main | grep -qx 'MindSuite: initial public commit' && ok "name-free message" || bad "name-free message"
git -C "$T/r1" cat-file -p AcctMind/legacy/0.62.0 | grep -q '^tagger MindSuite <noreply@users.noreply.github.com> ' && ok "marker tag carries the neutral tagger" || bad "marker tag carries the neutral tagger"
[ "$(git -C "$T/r1" rev-parse AcctMind/legacy/0.62.0^{commit})" = "$(git -C "$T/r1" rev-parse public-main)" ] && ok "marker points at the root" || bad "marker points at the root"
[ "$(git -C "$T/r1" rev-parse AcctMind/0.62.0^{commit})" = "$MAIN_TIP" ] && ok "the old seed tag is untouched (and not carried)" || bad "the old seed tag is untouched"
[ "$(git -C "$T/export.git" for-each-ref --format='%(refname)' | sort | tr '\n' ' ')" = "refs/heads/main refs/tags/PlanMind/0.1.0 " ] && ok "the export holds main and the --tag tag only (no marker, no old tag)" || bad "the export holds main and the --tag tag only"
[ "$(git -C "$T/export.git" rev-list --all --count)" = 1 ] && ok "the export holds one commit" || bad "the export holds one commit"
check "a second run refuses without --replace" 1 -- $SQ --repo "$T/r1" --marker AcctMind/0.62.0
check "--replace moves the branch and the marker" 0 -- $SQ --repo "$T/r1" --marker AcctMind/0.62.0 --replace

echo "public-scan.sh"
check "an unexpected tag is a hit (refs)" 1 -- $SC --from "$T/export.git" --expect-commits 1
grep -q 'refs: 1 outside' "$T/out" && ok "counted under refs" || bad "counted under refs"
check "a clean one-commit export scans clean" 0 -- $SC --from "$T/export.git" --expect-commits 1 --expect-ref refs/heads/main --expect-ref refs/tags/PlanMind/0.1.0
grep -q 'RESULT: clean in every class' "$T/out" && ok "RESULT says clean" || bad "RESULT says clean"
check "a mirror directory is read as it is" 0 -- sh -c "git clone -q --mirror '$T/export.git' '$T/m.git' && $SC --mirror '$T/m.git' --expect-commits 1 --expect-ref refs/heads/main --expect-ref refs/tags/PlanMind/0.1.0"
check "the wrong commit count is a hit (shape)" 1 -- $SC --from "$T/export.git" --expect-commits 2
check "a ref outside the list is a hit (refs)" 1 -- $SC --from "$T/export.git" --expect-ref refs/heads/other
check "a ref pattern with * is accepted" 0 -- $SC --from "$T/export.git" --expect-ref refs/heads/main --expect-ref 'refs/tags/*'
check "a plain history with a personal author is a hit (identity)" 1 -- $SC --from "$T/r1"
grep -q 'identity: [1-9][0-9]* of' "$T/out" && ok "identity hits are counted" || bad "identity hits are counted"

mkfix "$T/r4" "a note naming $NEEDLE in the open"
check "squash of a tree with a needle still succeeds (the tree is the scan's business)" 0 -- $SQ --repo "$T/r4" --export "$T/export4.git"
check "a needle in a blob is a hit (history and tree)" 1 -- $SC --from "$T/export4.git" --expect-commits 1
grep -Eq 'history: [1-9][0-9]* hit' "$T/out" && grep -Eq 'tree: [1-9][0-9]* hit' "$T/out" && ok "counted in history and tree" || bad "counted in history and tree"
grep -q 'ReadMind 1' "$T/out" && ok "per-app breakdown names the app" || bad "per-app breakdown names the app"
if grep -qi "$NEEDLE" "$T/out"; then bad "the report never prints the needle"; else ok "the report never prints the needle"; fi

AT='@gmail'
mkfix "$T/r5" "mail me at someone${AT}.com or look for qwertyplugh again"
check "squash r5" 0 -- $SQ --repo "$T/r5" --export "$T/export5.git"
check "a gmail address and a listed digest are personal-data hits" 1 -- $SC --from "$T/export5.git" --expect-commits 1
grep -Eq 'personal: 2 finding' "$T/out" && ok "both personal-data rules fired (gmail, digest list)" || bad "both personal-data rules fired"
grep -q 'qwertyplugh\|someone' "$T/out" && bad "the report never prints a personal value" || ok "the report never prints a personal value"

mkfix "$T/r6" "this device is called Synthetic Phone Name"
check "squash r6" 0 -- $SQ --repo "$T/r6" --export "$T/export6.git"
check "a value from a machine file is a hit" 1 -- $SC --from "$T/export6.git"
grep -Eq 'personal: [1-9]' "$T/out" && ok "counted as personal" || bad "counted as personal"

check "cannot run without a needle list (exit 2)" 2 -- env MIND_NEEDLES="$T/none.txt" $SC --from "$T/export.git"
check "cannot run without the digest list (exit 2)" 2 -- env MIND_PERSONAL_HASHES="$T/none.sha256" $SC --from "$T/export.git"
check "cannot run without machine files (exit 2)" 2 -- env MIND_MACHINE_ENV="$T/none.env" $SC --from "$T/export.git"
check "--url refuses a non-https URL" 2 -- $SC --url git@example.test:o/r.git
check "--url refuses credentials in the URL" 2 -- $SC --url https://user:pw@example.test/o/r.git
check "needs exactly one source" 2 -- $SC
check "--mirror refuses a non-bare directory" 2 -- $SC --mirror "$T/r1"

echo "pre-push (public remote)"
H=$T/hook
git init -q -b main "$H"
mkdir -p "$H/CoreMind/bin" "$H/tools/githooks" "$T/agentsuite/githooks"
for f in check-names.sh python.sh placeholder-ids.txt; do cp "$HERE/CoreMind/bin/$f" "$H/CoreMind/bin/"; done
cp "$HERE/tools/githooks/pre-push" "$H/tools/githooks/pre-push"
printf '#!/bin/sh\ncat >/dev/null\nexit 0\n' > "$T/agentsuite/githooks/pre-push"   # stands in for AgentSuite's quiet-CI hook
echo 'plain text' > "$H/README.md"
git -C "$H" add README.md   # the checker and the hook stay untracked: the self-test inside check-names.sh holds the synthetic needles
git -C "$H" -c core.hooksPath=/dev/null commit -q -m 'first'
git -C "$H" tag -a CalMind/1.63.0 -m release
git -C "$H" tag -a CalMind/legacy/1.62.0 -m marker
git -C "$H" config --add mindsuite.publicRemote pub
HS=$(git -C "$H" rev-parse HEAD)
HT=$(git -C "$H" rev-parse CalMind/1.63.0)
HL=$(git -C "$H" rev-parse CalMind/legacy/1.62.0)
Z=0000000000000000000000000000000000000000
push() { # REMOTE "local_ref sha remote_ref remote_sha"
  printf '%s\n' "$2" | (cd "$H" && AGENTSUITE_DIR="$T/agentsuite" sh tools/githooks/pre-push "$1" "https://example.test/o/r.git")
}
check "allows main" 0 -- push pub "refs/heads/main $HS refs/heads/main $Z"
check "allows a release tag <App>/<x.y.z>" 0 -- push pub "refs/tags/CalMind/1.63.0 $HT refs/tags/CalMind/1.63.0 $Z"
check "allows main and a release tag in one atomic push" 0 -- push pub "refs/heads/main $HS refs/heads/main $Z
refs/tags/CalMind/1.63.0 $HT refs/tags/CalMind/1.63.0 $Z"
check "allows a lane preflight branch" 0 -- push pub "HEAD $HS refs/heads/preflight/calmind/$(printf '%s' "$HS" | cut -c1-7) $Z"
check "allows deleting a lane preflight branch" 0 -- push pub "(delete) $Z refs/heads/preflight/chefmind/abcdef1 $HS"
check "refuses a legacy marker tag" 1 -- push pub "refs/tags/CalMind/legacy/1.62.0 $HL refs/tags/CalMind/legacy/1.62.0 $Z"
check "refuses another branch" 1 -- push pub "refs/heads/main $HS refs/heads/feature $Z"
check "refuses a preflight branch of an app without a preflight lane" 1 -- push pub "HEAD $HS refs/heads/preflight/planmind/abcdef1 $Z"
check "refuses an old-style tag (v1.2.3)" 1 -- push pub "refs/tags/v1.2.3 $HT refs/tags/v1.2.3 $Z"
check "refuses an old-style tag (lowercase app-v)" 1 -- push pub "refs/tags/calmind-v1.63.0 $HT refs/tags/calmind-v1.63.0 $Z"
check "refuses a tag of an unknown app" 1 -- push pub "refs/tags/Nope/1.0.0 $HT refs/tags/Nope/1.0.0 $Z"
check "refuses a two-part version tag" 1 -- push pub "refs/tags/CalMind/1.63 $HT refs/tags/CalMind/1.63 $Z"
check "refuses deleting main" 1 -- push pub "(delete) $Z refs/heads/main $HS"
check "refuses when the needle list is missing (no skip)" 1 -- env MIND_NEEDLES="$T/none.txt" MIND_NAMES_OPTIONAL=1 sh -c 'printf "%s\n" "refs/heads/main '"$HS"' refs/heads/main '"$Z"'" | (cd "'"$H"'" && AGENTSUITE_DIR="'"$T/agentsuite"'" sh tools/githooks/pre-push pub https://example.test/o/r.git)'
echo "a note naming $NEEDLE" > "$H/note.txt"
git -C "$H" add note.txt
git -C "$H" -c core.hooksPath=/dev/null commit -q -m 'needle'
HN=$(git -C "$H" rev-parse HEAD)
check "refuses main when its history holds a needle" 1 -- push pub "refs/heads/main $HN refs/heads/main $Z"
check "another remote takes any branch (history scan only)" 0 -- push private "refs/heads/main $HS refs/heads/feature $Z"

echo
echo "publish tests: $PASS passed, $FAILS failed"
[ "$FAILS" = 0 ]
