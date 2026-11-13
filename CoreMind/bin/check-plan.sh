#!/bin/sh
# Does bin/plan.sh still build the release order the way its header says?
#
#   sh bin/check-plan.sh
#
# Covers the public order, the untracked `.private-targets` extension, and the
# deploy lane for a target named there. Everything runs against a scratch
# directory (PRIVATE_TARGETS_FILE, MIND_DIR) with a made-up target and a stub
# lane — no network, no deploy, nothing of the machine's own is read.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/plancheck.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
PUBLIC="core CalMind ChefMind AcctMind PlanMind TaskMind ReadMind"

# plan <file-or-empty> <args…> — the "==> plan:" line of deploy.sh --plan.
plan() {
  F="$1"; shift
  PRIVATE_TARGETS_FILE="$F" MIND_DIR="$TMP" sh bin/deploy.sh "$@" --plan 2>&1 | sed -n 's/^==> plan: *//p'
}
expect() { # name got want
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got '$2', wanted '$3'"; fi
}

printf 'SecretApp\n' > "$TMP/one"
printf '# a comment\r\n\r\n  SecretApp  # trailing\r\nOtherApp\ncalmind-not-a-dup\nCalMind\n' > "$TMP/many"
printf 'SecretApp\n../escape\n' > "$TMP/bad"

expect "no file: public order only" "$(plan "$TMP/absent" all)" "$PUBLIC"
expect "file: appended after the public targets" "$(plan "$TMP/one" all)" "$PUBLIC SecretApp"
expect "comments, blanks, CRLF ignored; a public name is not repeated" \
  "$(plan "$TMP/many" all)" "$PUBLIC SecretApp OtherApp calmind-not-a-dup"
expect "--only reaches a private target alone" "$(plan "$TMP/one" --only SecretApp)" "SecretApp"
expect "core cascades into PlanMind and TaskMind but not an unrelated private target" "$(plan "$TMP/one" core)" "core CalMind ChefMind AcctMind PlanMind TaskMind"
grep -q 'for C in \$(downstream_of core)' bin/dtp.sh \
  && ok "dtp's dirty-after-propagation guard walks downstream_of core (PlanMind included)" \
  || bad "dtp's dirty-after-propagation guard no longer walks downstream_of core"
expect "PlanMind can deploy alone" "$(plan "$TMP/absent" --only PlanMind)" "PlanMind"
expect "TaskMind can deploy alone" "$(plan "$TMP/absent" --only TaskMind)" "TaskMind"
expect "TaskMind has no downstream: naming it ships it and nothing else" "$(plan "$TMP/absent" TaskMind)" "TaskMind"

OUT=$(PRIVATE_TARGETS_FILE="$TMP/absent" sh bin/deploy.sh SecretApp --plan 2>&1) && bad "absent file: SecretApp accepted" || ok "absent file: a private name is unknown"
case "$OUT" in *", or a private target"*) ok "error names the public targets and 'a private target'" ;; *) bad "error text: $OUT" ;; esac

OUT=$(PRIVATE_TARGETS_FILE="$TMP/one" sh bin/deploy.sh bogus --plan 2>&1) && bad "bogus accepted" || true
case "$OUT" in *SecretApp*) bad "error lists a private name" ;; *) ok "error never lists a private name" ;; esac
OUT=$(PRIVATE_TARGETS_FILE="$TMP/one" sh bin/deploy.sh --plan 2>&1) && bad "no target accepted" || true
case "$OUT" in *SecretApp*) bad "usage lists a private name" ;; *) ok "usage never lists a private name" ;; esac

PRIVATE_TARGETS_FILE="$TMP/bad" sh bin/deploy.sh all --plan >/dev/null 2>&1 && bad "a path-like name was accepted" || ok "a name that is not a bare directory name is refused"

# The lane: deploy.sh runs the target's own tools/deploy.sh, with the flags.
mkdir -p "$TMP/SecretApp/tools"
printf 'echo "lane args: $*"\n' > "$TMP/SecretApp/tools/deploy.sh"
OUT=$(PRIVATE_TARGETS_FILE="$TMP/one" MIND_DIR="$TMP" sh bin/deploy.sh --only SecretApp --quick --dry-run 2>&1) || true
case "$OUT" in *"lane args: --quick --dry-run"*) ok "deploy runs the private target's own lane with --quick/--dry-run" ;; *) bad "lane not run: $OUT" ;; esac
OUT=$(PRIVATE_TARGETS_FILE="$TMP/one" MIND_DIR="$TMP/nowhere" sh bin/deploy.sh --only SecretApp --dry-run 2>&1) && bad "missing checkout accepted" || ok "a private target with no checkout is refused"

# TaskMind's lane is its own tools/deploy.sh, always with the consent flags the script refuses to run without.
mkdir -p "$TMP/TaskMind/tools"
printf 'echo "lane args: $*"\n' > "$TMP/TaskMind/tools/deploy.sh"
OUT=$(PRIVATE_TARGETS_FILE="$TMP/absent" MIND_DIR="$TMP" sh bin/deploy.sh --only TaskMind --quick --dry-run 2>&1) || true
case "$OUT" in *"lane args: --prod --yes-prod --quick --dry-run"*) ok "deploy runs TaskMind's own lane with --prod --yes-prod and --quick/--dry-run" ;; *) bad "TaskMind lane not run: $OUT" ;; esac
OUT=$(PRIVATE_TARGETS_FILE="$TMP/absent" MIND_DIR="$TMP/nowhere" sh bin/deploy.sh --only TaskMind --dry-run 2>&1) && bad "TaskMind with no checkout accepted" || ok "TaskMind with no checkout is refused"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
