#!/bin/sh
# gh-bot — find and follow the runs github-actions[bot] does for this repo (CoreMind canon; copy, never edit a copy).
#
# Quiet CI (AgentSuite/ci.md): a run a person starts only hands the work to the bot, so the run that builds anything is
# the bot's. These are the two questions a lane asks about it.
#
#   sh tools/gh-bot.sh run <workflow.yml> <ref> <sha> <since>
#       Wait (up to ~5 min) for the bot's run of <workflow> on <ref> at commit <sha>, created at or after <since>
#       (UTC, 2026-11-09T18:31:02Z), and print its id. Exit 1 when none appears.
#   sh tools/gh-bot.sh release <tag>
#       Follow the release of <tag>: the bot's Release runs on that tag (a run that leaves a platform missing dispatches
#       the next one itself), until the release is published (exit 0) or no run is left and it is still a draft (exit 1,
#       naming the failed jobs). Up to ~3 hours.
#   sh tools/gh-bot.sh last-release
#       Is the newest version tag's release published? Exit 0 yes (or nothing to say), 1 when it is a draft (or missing)
#       and no run is working on it - say so loudly; the lane goes on.
#
# Needs gh (logged in). POSIX sh; macOS, Linux and Git Bash.
set -eu
cd "$(dirname "$0")/.."
BOT='github-actions[bot]'
WORKFLOW="${GH_BOT_WORKFLOW:-release.yml}"
PREFIX="${GH_BOT_TAG_PREFIX:+$GH_BOT_TAG_PREFIX/}"
REPO="${GH_BOT_REPO:-$(git remote get-url origin | sed -e 's|\.git$||' -e 's|.*[:/]\([^/]*/[^/]*\)$|\1|')}"

# The bot's runs of $1 at commit $2 (newest first): id<TAB>status<TAB>conclusion<TAB>head_branch<TAB>created_at
bot_runs() {
  gh api "repos/$REPO/actions/workflows/$1/runs?head_sha=$2&per_page=50" \
    --jq ".workflow_runs[] | select(.triggering_actor.login == \"$BOT\") | [.id, .status, (.conclusion // \"\"), .head_branch, .created_at] | @tsv" \
    2>/dev/null | tr -d '\r' || true
}

case "${1:-}" in
  run)
    [ $# -eq 5 ] || { echo "usage: sh tools/gh-bot.sh run <workflow.yml> <ref> <sha> <since>" >&2; exit 2; }
    WF=$2; REF=$3; SHA=$4; SINCE=$5
    i=0
    while [ "$i" -lt 60 ]; do
      ID=$(bot_runs "$WF" "$SHA" | awk -F'\t' -v ref="$REF" -v since="$SINCE" '$4 == ref && $5 >= since { id = $1 } END { if (id) print id }')
      [ -n "$ID" ] && { echo "$ID"; exit 0; }
      i=$((i + 1)); sleep 5
    done
    echo "gh-bot: no run of $WF by $BOT on $REF ($SHA) appeared; the person's run (Actions tab) says why its handoff failed" >&2
    exit 1 ;;

  release)
    [ $# -eq 2 ] || { echo "usage: sh tools/gh-bot.sh release <tag>" >&2; exit 2; }
    TAG=$2
    SHA=$(git rev-parse "$TAG^{commit}")
    SEEN=""; IDLE=0; n=0
    while [ "$n" -lt 360 ]; do
      DRAFT=$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null | tr -d '\r' || echo missing)
      if [ "$DRAFT" = false ]; then
        echo "gh-bot: $TAG is published: $(gh release view "$TAG" --repo "$REPO" --json url --jq .url 2>/dev/null)"
        exit 0
      fi
      RUNS=$(bot_runs "$WORKFLOW" "$SHA" | awk -F'\t' -v tag="$TAG" '$4 == tag')
      ACTIVE=$(printf '%s\n' "$RUNS" | awk -F'\t' 'NF && $2 != "completed"' | wc -l | tr -d ' ')
      LATEST=$(printf '%s\n' "$RUNS" | awk -F'\t' 'NF { print $1; exit }')
      if [ -n "$LATEST" ] && [ "$LATEST" != "$SEEN" ]; then
        SEEN=$LATEST
        echo "gh-bot: Release run https://github.com/$REPO/actions/runs/$LATEST"
      fi
      if [ "$ACTIVE" -gt 0 ]; then
        IDLE=0
      else
        IDLE=$((IDLE + 1))
        # Nothing running: before the first run (the handoff) or between a run and the retry it dispatched, briefly.
        if { [ -n "$LATEST" ] && [ "$IDLE" -ge 4 ]; } || [ "$IDLE" -ge 12 ]; then
          echo "gh-bot: $TAG is NOT published (draft: $DRAFT) and no Release run is left working on it." >&2
          if [ -n "$LATEST" ]; then
            echo "  last run: https://github.com/$REPO/actions/runs/$LATEST" >&2
            gh run view "$LATEST" --repo "$REPO" --json jobs \
              --jq '.jobs[] | .name as $j | (.steps[]? | select(.conclusion == "failure") | "  failed: \($j) > \(.name)"), (select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null) | "  job: \($j) = \(.conclusion)")' >&2 2>/dev/null || true
          fi
          echo "  Fix it, then: gh workflow run $WORKFLOW --ref $TAG -f tag=$TAG   (hands off to the bot; mails nobody)" >&2
          exit 1
        fi
      fi
      n=$((n + 1)); sleep 30
    done
    echo "gh-bot: gave up following $TAG after 3 hours (draft: $DRAFT)" >&2
    exit 1 ;;

  last-release)
    TAG=$(git describe --tags --abbrev=0 --match "${PREFIX}[0-9]*.[0-9]*.[0-9]*" 2>/dev/null || true)
    [ -n "$TAG" ] || exit 0
    command -v gh >/dev/null 2>&1 || exit 0
    DRAFT=$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null | tr -d '\r' || echo missing)
    [ "$DRAFT" = false ] && exit 0
    SHA=$(git rev-parse "$TAG^{commit}")
    ACTIVE=$(bot_runs "$WORKFLOW" "$SHA" | awk -F'\t' -v tag="$TAG" '$4 == tag && $2 != "completed"' | wc -l | tr -d ' ')
    [ "$ACTIVE" -gt 0 ] && { echo "==> $TAG's release is still being built (a Release run is working on it)"; exit 0; }
    echo "" >&2
    echo "   WARNING: the last release, $TAG, is NOT published (draft: ${DRAFT:-missing}) and nothing is building it." >&2
    echo "   See https://github.com/$REPO/actions/workflows/$WORKFLOW - fix, then:" >&2
    echo "     gh workflow run $WORKFLOW --ref $TAG -f tag=$TAG" >&2
    exit 1 ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2 ;;
esac
