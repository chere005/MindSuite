#!/bin/sh
# preflight - run the Release workflow's builds on the commit you are ABOUT to tag, before tagging it.
#
#   sh tools/preflight.sh [tag]
#
# It pushes HEAD to refs/heads/preflight/<sha7> (a branch push triggers nothing: the workflows react to tags and manual
# dispatches only), dispatches `Release` there with preflight=true, watches the run, and reports PASS or FAIL naming each
# failed job and step. Nothing is created, uploaded or published by a preflight run, and its jobs are continue-on-error, so a
# red job does not email anyone. The preflight branch is deleted at the end, always.
#
# The optional [tag] is the tag the commit is about to get; the workflow then checks that every version file carries it. Left
# out, the workflow derives the tag from the files and checks only that they agree.
#
# Exit: 0 PASS, 1 FAIL (or the run never appeared), 2 not ready to run (usage, dirty tree, no gh).
#
# One-time catch: GitHub dispatches a workflow by name only once chefmind-release.yml is on the default branch, so the very first
# preflight has to wait until that file has been merged and pushed to main.
#
# POSIX sh; runs in Git Bash on Windows and on macOS/Linux.
set -eu
cd "$(dirname "$0")/.."

TAG="${1:-}"
case "$TAG" in ChefMind/*|'') ;; -*) ;; *) TAG="ChefMind/$TAG" ;; esac
case "$TAG" in
  -*) echo "usage: sh tools/preflight.sh [tag]" >&2; exit 2 ;;
esac

command -v gh >/dev/null 2>&1 || { echo "preflight: the gh CLI is needed" >&2; exit 2; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "preflight: commit first - what is checked is the commit, and the tree has uncommitted changes" >&2
  exit 2
fi

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
SHA="$(git rev-parse HEAD)"
SHORT="$(printf '%s' "$SHA" | cut -c1-7)"
BRANCH="preflight/chefmind/${SHORT}"
PUSHED=0

cleanup() {
  if [ "$PUSHED" = 1 ]; then
    git push -q origin ":refs/heads/${BRANCH}" >/dev/null 2>&1 || echo "preflight: could not delete origin/${BRANCH} - delete it by hand" >&2
    PUSHED=0
  fi
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT
trap 'cleanup; trap - EXIT; exit 143' TERM

echo "preflight: pushing ${SHORT} to origin/${BRANCH}"
git push -q --force origin "HEAD:refs/heads/${BRANCH}"
PUSHED=1

# Two minutes of slack: this machine's clock has run ~17 s ahead of GitHub's, and a run made "before" a fast clock was never
# found. The run is still this branch, this commit and a manual dispatch.
BEFORE="$(date -u -d '-120 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-120S +%Y-%m-%dT%H:%M:%SZ)"

if [ -n "$TAG" ]; then
  gh workflow run chefmind-release.yml --repo "$REPO" --ref "$BRANCH" -f preflight=true -f "tag=${TAG}" >/dev/null
else
  gh workflow run chefmind-release.yml --repo "$REPO" --ref "$BRANCH" -f preflight=true >/dev/null
fi || {
  echo "preflight: could not dispatch Release (is .github/workflows/chefmind-release.yml on the default branch yet?)" >&2
  exit 1
}

# The dispatch above is OUR run, and it only hands the work to github-actions[bot] (quiet CI: GitHub mails the person who
# triggered a run, and the bot's run is nobody's). The bot's run is the one to wait for.
RUN=$(GH_BOT_REPO="$REPO" sh tools/gh-bot.sh run chefmind-release.yml "$BRANCH" "$SHA" "$BEFORE") || {
  echo "preflight: the bot's run did not appear (look at https://github.com/$REPO/actions)" >&2
  exit 1
}
echo "preflight: https://github.com/${REPO}/actions/runs/${RUN}"

# `gh run watch` can return early if the connection drops: wait until the run says it is completed.
gh run watch "$RUN" --repo "$REPO" --interval 30 >/dev/null 2>&1 || true
while [ "$(gh run view "$RUN" --repo "$REPO" --json status --jq .status 2>/dev/null || echo unknown)" != completed ]; do
  sleep 30
done

# One line per job: name, conclusion, and the names of its failed steps. A job-level continue-on-error job that failed can
# report a green conclusion, so the steps are read too.
JOBS="$(gh run view "$RUN" --repo "$REPO" --json jobs --jq \
  '.jobs[] | [.name, (.conclusion // "unknown"), ([.steps[]? | select(.conclusion == "failure") | .name] | join("; "))] | @tsv')"
printf '%s\n' "$JOBS" | awk -F'\t' '{ printf "  %-40s %s\n", $1, $2 }'

FAILED="$(printf '%s\n' "$JOBS" | awk -F'\t' '$3 != "" || ($2 != "success" && $2 != "skipped") { print }')"
if [ -n "$FAILED" ]; then
  echo "preflight: FAIL"
  printf '%s\n' "$FAILED" | awk -F'\t' '{ if ($3 != "") printf "  failed: %s > %s\n", $1, $3; else printf "  failed: %s (%s)\n", $1, $2 }'
  echo "  logs: gh run view ${RUN} --repo ${REPO} --log-failed"
  exit 1
fi
echo "preflight: PASS (${SHORT} may be tagged)"
