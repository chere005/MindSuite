#!/bin/sh
# Does deploy.sh's guard set still refuse what it claims to refuse?
#
# Every check here works by BREAKING a copy of the real script and watching it
# stop — never by reading it. The method is CalMind's
# tools/check-deploy-guards.sh, where two gates that could not fail printed
# reassuring output for months; no assertion here passes unless the tampered
# copy exits non-zero.
#
# EVERY copy has its ssh, rsync and curl calls replaced with echo. This is not
# belt-and-braces: the point of each case is that a guard has been removed, so
# the copy WILL reach the transfer step whenever the check is doing its job
# and finding a real hole. (curl too — the destination guards run before the
# API gate and never reach it, but a check that only works because of an
# ordering it does not state is one refactor from silently hitting the
# network.)
#
# Nothing here needs SSH_DEST, credentials or a network — the guards run
# before deploy.conf is read, deliberately, so this is runnable by anyone.
#
#   sh tools/check-deploy-guards.sh
set -e
cd "$(dirname "$0")/.."

# BSD `mktemp -t name` has no XXXXXX and GNU mktemp refuses it; this form is
# the same on both.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/chefguards.XXXXXX")
trap 'rm -rf "$TMP" ./_guardcheck-*.sh' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

# A tampered copy lives at the repo root, because deploy.sh does
# `cd "$(dirname "$0")"` to find the repo.
try() { # try <label> <sed expr> <args...>
  label="$1"; expr="$2"; shift 2
  copy="./_guardcheck-$$.sh"
  sed -e "$expr" \
      -e 's|^\( *\)ssh |\1echo "   [guardcheck] would ssh: " |' \
      -e 's|^\( *\)rsync |\1echo "   [guardcheck] would rsync: " |' \
      -e 's|^\( *\)curl |\1echo "   [guardcheck] would curl: " |' \
      deploy.sh > "$copy"
  chmod +x "$copy"
  if "$copy" "$@" >"$TMP/out" 2>&1; then
    bad "$label — it RAN (exit 0); the guard did not fire"
    sed -n '1,4p' "$TMP/out" | sed 's/^/      /'
  else
    ok "$label"
  fi
  rm -f "$copy"
}

echo "deploy.sh — destination and consent"
# ChefMind writes the PRODUCTION document root and has no test instance, so
# these guards are the only thing between a typo and seancheren.com.
# The bare form must refuse: this one is about argv, so the copy is unmodified.
try "refuses to run without --yes-prod"  's|^#unchanged$|#unchanged|'
try "refuses the site root"              's|^WEB_DEST=.*|WEB_DEST="/home/public"|'              --yes-prod
try "refuses CalMind's own area"         's|^WEB_DEST=.*|WEB_DEST="/home/public/calmind"|'      --yes-prod
try "refuses CalMind's test area"        's|^WEB_DEST=.*|WEB_DEST="/home/public/test/calmind"|' --yes-prod
try "refuses a stray destination"        's|^WEB_DEST=.*|WEB_DEST="/home/public/somewhere"|'    --yes-prod

echo "deploy.sh — the API gate"
# THE ONE PROTECTING THE OWNER'S DATA rather than his web root: ChefMind sends
# space='chef', and an API that does not know the parameter ignores it and
# merges ChefMind's records into CalMind's store. Both directions are
# checked, because a gate that always refuses would pass the negative case
# while blocking every real deploy.
try "refuses when the API does not know the space" \
  's|^  ANSWER=$(api_spaces .*|  ANSWER=\x27{"ok":true,"spaces":["something-else"]}\x27|' --yes-prod

copy="./_guardcheck-pass-$$.sh"
# `exit 0` right after the gate returns. Without it this copy ran the whole
# pipeline — both typechecks, the core suite, CalMind's server suite and a
# full expo export — to prove one thing that had already been printed by then.
sed -e 's|^check_api$|check_api; exit 0|' \
    -e 's|^  ANSWER=$(api_spaces .*|  ANSWER=\x27{"ok":true,"spaces":["chef"]}\x27|' \
    -e 's|^\( *\)ssh |\1echo "   [guardcheck] would ssh: " |' \
    -e 's|^\( *\)rsync |\1echo "   [guardcheck] would rsync: " |' \
    -e 's|^\( *\)curl |\1echo "   [guardcheck] would curl: " |' \
    deploy.sh > "$copy"
chmod +x "$copy"
# It will stop later — at a gate that needs a real export or the conf — and
# that is fine. What is proved here is that it got PAST the API gate and said
# so, which is what stops this check from being one that can only ever refuse.
"$copy" --yes-prod >"$TMP/chefpass" 2>&1 || true
if grep -q 'it does\.' "$TMP/chefpass"; then
  ok "and passes when the API names it"
else
  bad "the API gate refused an API that DOES know the space — check $TMP/chefpass"
fi
rm -f "$copy"

echo "deploy.sh — the typecheck and core suite stand down for one tree only"
# Under a tdtp they stand down when the tree still hashes to the key the
# lane's --full pass checked (tools/gate-key.mjs). That is a gate that can
# switch itself OFF, so what is proved here is every way it must stay ON.
# In each copy the API answer is canned, and tsc is replaced by `false`. A
# copy that runs the typecheck therefore REFUSES, and says which gate did
# it. A copy that skips the typecheck reaches an `exit 0` placed just past
# the gates. A refusal only counts when it is the typecheck's: a copy that
# died of something else would prove nothing about this.
gates_copy() { # gates_copy <file> [extra sed expr]
  sed -e 's|^  ANSWER=$(api_spaces .*|  ANSWER=\x27{"ok":true,"spaces":["chef"]}\x27|' \
      -e 's|if ! npx tsc --noEmit -p "$P"|if ! false|' \
      -e 's|^CALMIND_REPO=|echo "[guardcheck] past the gates"; exit 0; CALMIND_REPO=|' \
      -e "${2:-s|^#unchanged\$|#unchanged|}" \
      -e 's|^\( *\)ssh |\1echo "   [guardcheck] would ssh: " |' \
      -e 's|^\( *\)rsync |\1echo "   [guardcheck] would rsync: " |' \
      -e 's|^\( *\)curl |\1echo "   [guardcheck] would curl: " |' \
      deploy.sh > "$1"
  chmod +x "$1"
}
refuses_at_typecheck() { # <label> <CHEF_GATES_PASSED or "-" for unset> [extra sed expr]
  label="$1"; passed="$2"; copy="./_guardcheck-gates-$$.sh"
  gates_copy "$copy" "${3:-}"
  if [ "$passed" = - ]; then
    env -u CHEF_GATES_PASSED "$copy" --yes-prod >"$TMP/gates" 2>&1 && rc=0 || rc=$?
  else
    CHEF_GATES_PASSED="$passed" "$copy" --yes-prod >"$TMP/gates" 2>&1 && rc=0 || rc=$?
  fi
  if [ "$rc" != 0 ] && grep -q 'typecheck failed — not deploying' "$TMP/gates"; then
    ok "$label"
  else
    bad "$label — exit $rc, and the typecheck did not refuse"
    sed -n '1,6p' "$TMP/gates" | sed 's/^/      /'
  fi
  rm -f "$copy"
}
KEY=$(node tools/gate-key.mjs) || KEY=""
case "$KEY" in
  [0-9a-f]*) [ "${#KEY}" -eq 64 ] && ok "tools/gate-key.mjs keys this tree" || bad "gate-key printed '$KEY', not a 64-hex key" ;;
  *) bad "tools/gate-key.mjs could not key this tree" ;;
esac
refuses_at_typecheck "runs them when no lane passed a key (plain dtp, or by hand)" -
refuses_at_typecheck "runs them when the lane's key is some other tree's" \
  0000000000000000000000000000000000000000000000000000000000000000
refuses_at_typecheck "runs them when the key cannot be computed now" "$KEY" \
  's|GATES_KEY=$(node tools/gate-key.mjs)|GATES_KEY=$(false)|'
refuses_at_typecheck "runs them when the key comes back empty and the lane's is empty too" "" \
  's|GATES_KEY=$(node tools/gate-key.mjs)|GATES_KEY=$(printf "")|'

copy="./_guardcheck-gates-$$.sh"
gates_copy "$copy"
CHEF_GATES_PASSED="$KEY" "$copy" --yes-prod >"$TMP/gates" 2>&1 && rc=0 || rc=$?
if [ "$rc" = 0 ] && grep -q 'not run twice' "$TMP/gates" && ! grep -q '==> typecheck$' "$TMP/gates"; then
  ok "and stands down for the tree the lane's full run passed"
else
  bad "the matching key did not skip the repeat run — exit $rc, see $TMP/gates"
fi
rm -f "$copy"

echo "tools/gate-key.mjs — the key moves with every input"
# The other half: the key must CHANGE whenever anything tsc or vitest reads
# changes, or "the same key" stops meaning "the same tree". Proved on a
# mirror of exactly what the key reads (the --files list, plus the
# node_modules names and npm's lock), never on this checkout. Each case
# changes one thing in a fresh clone of the mirror, and the key must move.
# The first case runs the other way round: the bump must NOT move it, or the
# reuse would never fire.
# The mirror sits one level down, as ChefMind/ under a parent, because the key
# also reads the shared @mind/core code at ../packages: it lands beside it,
# and each mutant copies the whole parent, so a mutant that edits shared code
# edits only its own copy.
T="$TMP/tree/ChefMind"
# One node process rather than one cp per file: the files the key lists, the
# two scripts the cases run, desktop/package.json (read by the lock sync,
# never keyed), and each node_modules as the key sees it: its loose files
# (npm's .package-lock.json) and its package NAMES as empty directories.
node tools/gate-key.mjs --files | node -e '
  const fs = require("fs"), path = require("path"), T = process.argv[1];
  const put = (f) => { fs.mkdirSync(path.join(T, path.dirname(f)), { recursive: true }); fs.copyFileSync(f, path.join(T, f)); };
  const list = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const f of [...list, "tools/gate-key.mjs", "tools/sync-lock-versions.mjs", "desktop/package.json"]) put(f);
  for (const d of ["node_modules", "app/node_modules", "packages/core/node_modules"]) {
    if (!fs.existsSync(d)) continue;
    // An EMPTY node_modules is still keyed (as no names), so the mirror needs it too.
    fs.mkdirSync(path.join(T, d), { recursive: true });
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (!fs.statSync(p).isDirectory()) { put(p); continue; }
      const kids = n.startsWith("@") ? fs.readdirSync(p).map((m) => path.join(p, m)) : [p];
      for (const k of kids) fs.mkdirSync(path.join(T, k), { recursive: true });
    }
  }' "$T"
K0=$( cd "$T" && node tools/gate-key.mjs ) || K0=""
if [ -n "$K0" ] && [ "$K0" = "$KEY" ]; then
  ok "the mirror keys the same as this tree (it holds everything the key reads)"
else
  bad "the mirror keys differently from this tree — the cases below would prove nothing"
fi

n=0
mutant() { # mutant <label> <same|moves|nokey> <shell run inside a fresh copy of the mirror> [env for the key]
  n=$((n + 1)); M="$TMP/m$n/ChefMind"
  cp -cR "$TMP/tree" "$TMP/m$n" 2>/dev/null || cp -R "$TMP/tree" "$TMP/m$n"
  # A change that did not apply proves nothing either way, and for the bump
  # it would make "leaves it alone" pass by doing nothing. So it is a failure.
  if ! ( cd "$M" && eval "$3" ) >/dev/null 2>&1; then
    bad "$1 — the change itself did not apply"; rm -rf "$TMP/m$n"; return 0
  fi
  K=$( cd "$M" && env ${4:-} node tools/gate-key.mjs 2>/dev/null ) && krc=0 || krc=$?
  case "$2" in
    same)  [ "$K" = "$K0" ] && ok "$1" || bad "$1 — the key moved" ;;
    moves) [ -n "$K" ] && [ "$K" != "$K0" ] && ok "$1" || bad "$1 — the key did NOT move" ;;
    nokey) [ "$krc" != 0 ] && [ -z "$K" ] && ok "$1" || bad "$1 — it still printed a key" ;;
  esac
  rm -rf "$TMP/m$n"
}
BUMP='CUR=$(node -p "require(\"./package.json\").version"); NEW=9.99.0
  for F in package.json app/app.json desktop/package.json desktop/src-tauri/tauri.conf.json; do perl -i -pe "s|\"version\": \"\Q$CUR\E\"|\"version\": \"$NEW\"|" "$F"; done
  node tools/sync-lock-versions.mjs && grep -q "\"version\": \"$NEW\"" package.json \
    && grep -q "\"version\": \"$NEW\"" app/app.json && grep -q "\"version\": \"$NEW\"" package-lock.json \
    && grep -q "\"version\": \"$NEW\"" desktop/src-tauri/tauri.conf.json'
mutant "the version bump leaves it alone"                       same  "$BUMP"
mutant "an edited core test moves it"                           moves 'printf "\n// x\n" >> packages/core/test/shopping.test.ts'
mutant "an edited shared mind-core test moves it"               moves 'printf "\n// x\n" >> ../packages/mind-core/test/order.test.ts'
mutant "a test fixture moves it"                                moves 'printf "x" >> ../packages/mind-core/test/fixtures/bbcgoodfood-scones.html'
mutant "a new file outside app/src and app/test moves it"       moves 'mkdir -p app/e2e && echo "export const x: number = \"no\"" > app/e2e/stray.ts'
mutant "a new test in a dot-dir moves it (vitest globs dot files)" moves 'mkdir -p app/.hidden && echo "x" > app/.hidden/x.test.ts'
mutant "a deleted test moves it"                                moves 'rm app/test/rowslots.test.ts'
mutant "a generated dist bundle moves it (tsc reads app/dist)"  moves 'mkdir -p app/dist && printf "export {};" > app/dist/guardcheck.js'
mutant "desktop CSP source moves it"                            moves 'printf "\n// x\n" >> desktop/csp.mjs'
mutant "desktop CSP configuration moves it"                     moves 'perl -i -pe "s|connect-src|guardcheck-src|" desktop/src-tauri/tauri.conf.json'
mutant "a spec vector moves it"                                 moves 'printf " " >> ../packages/mind-core/spec/parse.json'
mutant "tsconfig.base.json moves it"                            moves 'printf " " >> tsconfig.base.json'
mutant "app/tsconfig.json moves it"                             moves 'printf " " >> app/tsconfig.json'
mutant "app.json beyond its version moves it"                   moves 'perl -i -pe "s|\"name\": \"ChefMind\"|\"name\": \"ChefMind2\"|" app/app.json'
mutant "a root script moves it"                                 moves 'perl -i -pe "s|\"test:core\": \"|\"test:core\": \"true; |" package.json'
mutant "a root vitest config appearing moves it"                moves 'echo "export default {}" > vitest.config.ts'
mutant "a dependency version in package-lock.json moves it"     moves 'perl -0 -i -pe "s|(\"node_modules/vitest\": \\{\\s*\"version\": \")[^\"]*|\${1}0.0.1|" package-lock.json'
mutant "an npm install (node_modules/.package-lock.json) moves it" moves 'printf " " >> node_modules/.package-lock.json'
mutant "a package dropped into node_modules by hand moves it"   moves 'mkdir -p node_modules/@types/stray'
mutant "another TZ in the environment moves it"                 moves ':' TZ=Pacific/Chatham
mutant "a shared @mind/core stub moves it"                      moves 'printf "\n// x\n" >> packages/core/src/parse.ts'
mutant "the @mind/core code a stub re-exports moves it"         moves 'printf "\n// x\n" >> ../packages/mind-core/src/parse.ts'
mutant "the @mind/core tsconfig.json moves it (vitest reads it)" moves 'printf " " >> ../packages/mind-core/tsconfig.json'
mutant "a symlinked directory gives NO key, so the checks run"  nokey 'ln -s ../packages app/linked'

# And the key's reach, checked against tsc's own list: every file either
# project reads, outside node_modules, must be one the key read. That
# includes files OUTSIDE this repo: tsc follows the @mind/core link to its
# real path (../packages/mind-core, where the bodies its stubs re-export sit), so
# node makes each path relative to here; stripping "$(pwd)/" kept those
# absolute (and on Windows missed tsc's C:/ form of every path).
LISTED="$TMP/tsc-listed"; KEYED="$TMP/keyed"
{ npx tsc --listFilesOnly -p packages/core; npx tsc --listFilesOnly -p app; } 2>/dev/null \
  | grep -v '/node_modules/' \
  | node -e 'const path = require("path"); for (const l of require("fs").readFileSync(0, "utf8").split(/\r?\n/)) if (l.trim()) console.log(path.relative(process.cwd(), l.trim()).split(path.sep).join("/"))' \
  | sort -u > "$LISTED"
node tools/gate-key.mjs --files | sort > "$KEYED"
MISSED=$(comm -23 "$LISTED" "$KEYED")
if [ -s "$LISTED" ] && [ -z "$MISSED" ]; then
  ok "every file tsc reads in this repo ($(wc -l < "$LISTED" | tr -d ' ')) is in the key"
else
  bad "tsc reads files the key does not:"; printf '%s\n' "$MISSED" | sed 's/^/      /'
fi

echo
echo "────────────────────────────────"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
