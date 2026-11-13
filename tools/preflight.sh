#!/bin/sh
# Suite bootstrap/pre-push checks. App lanes also run their own product gates.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd -P)
AGENTSUITE_DIR="${AGENTSUITE_DIR:-$(cd .. && pwd)/AgentSuite}"
CHECK="$AGENTSUITE_DIR/tools/check-workflows.py"
[ -f "$CHECK" ] || { echo "AgentSuite workflow checker is missing; set AGENTSUITE_DIR." >&2; exit 1; }

for APP in CalMind ChefMind PlanMind TaskMind ReadMind AcctMind CoreMind; do
  [ -f "$APP/AGENTS.md" ]
  # Both sides through `pwd -P`: on Windows git prints C:/GIT/... while the
  # shell's pwd is /c/GIT/..., the same directory spelled two ways. An empty
  # TOP (git failed) must not reach `cd ""`, which some shells treat as a no-op.
  TOP=$(git -C "$APP" rev-parse --show-toplevel) && [ -n "$TOP" ] &&
    [ "$(cd "$TOP" && pwd -P)" = "$ROOT" ] ||
    { echo "$APP is not in the suite Git checkout" >&2; exit 1; }
done
if git ls-files -s | awk '$1 == 160000 { found=1 } END { exit !found }'; then
  echo "MindSuite contains a Git submodule." >&2; exit 1
fi
for APP in CalMind ChefMind PlanMind TaskMind ReadMind AcctMind; do
  sh -n "$APP/tools/dtp.sh"
done
for APP in CalMind ChefMind AcctMind; do
  sh -n "$APP/tools/preflight.sh"
done
for SCRIPT in CoreMind/bin/plan.sh CoreMind/bin/deploy.sh CoreMind/bin/dtp.sh CoreMind/bin/check-drift.sh CoreMind/bin/report-status.sh CoreMind/bin/check-personal-data.sh CoreMind/bin/check-machine-env.sh; do
  sh -n "$SCRIPT"
done
git diff --check
git diff --cached --check
. CoreMind/bin/python.sh
mind_python
$MIND_PYTHON "$CHECK" "$ROOT"
node --test tools/test-mac-architecture.mjs
node tools/check-shared.mjs
node --test tools/test-check-shared.mjs
# @mind/core has no install of its own; it borrows CoreMind's tsc and vitest.
[ -f CoreMind/node_modules/vitest/vitest.mjs ] ||
  { echo "packages/mind-core needs CoreMind's tools: run npm ci in CoreMind." >&2; exit 1; }
(cd packages/mind-core && npm run --silent check)
bash tools/ci/test-macos-signing.sh
sh CoreMind/bin/check-plan.sh
sh CoreMind/bin/check-personal-data.sh --self-test
sh CoreMind/bin/check-personal-data.sh
sh CoreMind/bin/check-names.sh --self-test
sh CoreMind/bin/check-names.sh tree
sh CoreMind/bin/check-names.sh literals
sh CoreMind/bin/check-machine-env.sh
sh CoreMind/bin/check-locked-install.sh CalMind ChefMind AcctMind PlanMind TaskMind
sh CoreMind/bin/check-retry-installs.sh CalMind ChefMind AcctMind PlanMind TaskMind
