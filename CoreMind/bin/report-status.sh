#!/bin/sh
# Report a dtp/tdtp run to the status page at seancheren.com/status.
#
#   sh bin/report-status.sh start  <kind> <target>      -> prints a run id
#   sh bin/report-status.sh beat   <id> <summary>       -> "still running, here"
#   sh bin/report-status.sh finish <id> <status> <severity> <summary>
#
# `kind` is dtp or tdtp, `target` the plan ("core CalMind ChefMind"), `status`
# one of running / ok / failed, `severity` 0 good, 1 deliberate, 2 small issue,
# 3 needs attention. The page colours a run by severity and paints a running
# one purple.
#
# WHY A FILE AND NOT AN ENDPOINT. The status page is a reader; giving it a
# write route would mean an authenticated POST from a shell script, a token to
# keep, and a URL that can change the page. This pushes a JSON file over the
# SAME SSH credentials the site's own deploy uses, into /home/protected — out
# of the web root, so the file is not reachable on its own and the page is its
# only reader.
#
# NOTHING HERE IS ALLOWED TO FAIL A RELEASE. Every failure path warns on
# stderr and exits 0: a dtp that shipped, tagged and pushed must not report
# itself as broken because a status page could not be told about it. That is
# also why `start` prints its id even when the push failed — the caller has a
# `finish` to make, and it should not have to care.
set -e
cd "$(dirname "$0")/.."
PARENT="${MIND_DIR:-$(cd .. && pwd)}"

SITE_PARENT="${MIND_SITES_DIR:-$(cd ../.. && pwd)}"

LOCAL=".status-history.json"     # gitignored; the local copy we edit and push
REMOTE="/home/protected/status/history.json"
KEEP=5                           # "keep the last 5 dtp's" — the owner, 2026-08-22

# The SSH login lives in the SITE's gitignored deploy.conf, never here: this
# repo has no deploy of its own and no business carrying a real account name.
host() {
  for C in "$SITE_PARENT/seancheren-site/deploy.conf" "$PARENT/CalMind/server/deploy.conf"; do
    [ -f "$C" ] || continue
    # shellcheck disable=SC1090
    H=$(. "$C" >/dev/null 2>&1; printf '%s' "${HOST:-}")
    [ -n "$H" ] && { printf '%s' "$H"; return 0; }
  done
  return 1
}

# ONE ssh, not three. This was mkdir + scp + chmod as three separate
# connections, about six seconds all told — which does not matter twice a run
# and matters a great deal sixty times an hour once the heartbeat exists. It
# also meant a "sleep 60" loop actually beat every 66 seconds and drifted.
#
# The file arrives on STDIN, so there is no scp and no temporary name: the
# remote shell writes it in one shot with the permissions it needs.
push_remote() {
  H=$(host) || { echo "  (status: no deploy.conf with a HOST — not reported)" >&2; return 0; }
  # AND SWEEP, in the same connection. The history graph is built from samples
  # recorded when the state CHANGES, and nothing was recording one at the two
  # moments that matter most: a run starting and a run ending. A sample only
  # landed if an unrelated sweep happened to fire mid-release, so a short dtp
  # could come and go leaving no purple on the graph at all.
  #
  # Sweeping here means every start, every beat and every finish writes one —
  # which is what makes the three dots (before, In Progress, after) certain
  # rather than lucky. It runs after the history file is in place, so the
  # sweep reads the run it is reporting.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$H" \
      "mkdir -p $(dirname "$REMOTE") && cat > $REMOTE && chmod a+r $REMOTE;
       php /home/protected/lib/status-sweep.php >/dev/null 2>&1 || true" \
      < "$LOCAL" >/dev/null 2>&1 \
    || { echo "  (status: could not reach the server — not reported)" >&2; return 0; }
}

case "${1:-}" in
  start)
    KIND="${2:-dtp}"; TARGET="${3:-?}"
    ID=$(date -u +%Y%m%d%H%M%S)
    # 12-hour Central, and an epoch beside it. The string is what a human
    # reads if anything ever cats this file; the epoch is what the page
    # formats from, so a display change never needs the history rewritten.
    WHEN=$(TZ=America/Chicago date '+%Y-%m-%d %I:%M %p %Z')
    python3 - "$LOCAL" "$ID" "$KIND" "$TARGET" "$WHEN" "$KEEP" <<'PY' || true
import json, os, sys
path, rid, kind, target, when, keep = sys.argv[1:7]
try:
    hist = json.load(open(path))
    if not isinstance(hist, list): hist = []
except Exception:
    hist = []
hist = [h for h in hist if h.get('id') != rid]
hist.insert(0, {'id': rid, 'kind': kind, 'target': target, 'started_at': when,
                'finished_at': None, 'status': 'running', 'severity': 0,
                'summary': 'Running now.'})
# Newest first, trimmed. A run left 'running' by a killed shell ages out of the
# list on its own rather than sitting purple for ever.
hist.sort(key=lambda h: h.get('id', ''), reverse=True)
json.dump(hist[:int(keep)], open(path, 'w'), indent=1)
PY
    push_remote
    printf '%s' "$ID"
    ;;
  beat)
    # THE HEARTBEAT. The owner, 2026-08-23: "i want an update per minute during any
    # tdtp or dtp". A suite run takes twenty minutes and used to report exactly
    # twice — at the start and at the end — so the page said "running" for the
    # whole of it and could not say running WHAT. This says which lane is in
    # flight and when it last said so, which is also how a HUNG run becomes
    # visible: the phase stops changing and the stamp stops moving.
    ID="${2:-}"; shift 2 2>/dev/null || shift $#
    SUMMARY="$*"
    [ -n "$ID" ] || exit 0
    WHEN=$(TZ=America/Chicago date '+%I:%M %p %Z')
    python3 - "$LOCAL" "$ID" "$WHEN" "$SUMMARY" <<'PY' || true
import json, sys
path, rid, when, summary = sys.argv[1:5]
try:
    hist = json.load(open(path))
    if not isinstance(hist, list): hist = []
except Exception:
    hist = []
for h in hist:
    # Only a run still marked running: a beat arriving after finish (the
    # heartbeat losing a race with the kill) must not reopen a closed run.
    if h.get('id') == rid and h.get('status') == 'running':
        h['summary'] = (summary or 'Running.') + '  (last update ' + when + ')'
        h['beat_at'] = when
        break
json.dump(hist, open(path, 'w'), indent=1)
PY
    push_remote
    ;;
  finish)
    ID="${2:-}"; STATUS="${3:-ok}"; SEV="${4:-0}"; shift 4 2>/dev/null || shift $#
    SUMMARY="$*"
    [ -n "$ID" ] || { echo "  (status: finish without an id — not reported)" >&2; exit 0; }
    WHEN=$(TZ=America/Chicago date '+%Y-%m-%d %I:%M %p %Z')
    python3 - "$LOCAL" "$ID" "$STATUS" "$SEV" "$WHEN" "$SUMMARY" <<'PY' || true
import json, sys
path, rid, status, sev, when, summary = sys.argv[1:7]
try:
    hist = json.load(open(path))
    if not isinstance(hist, list): hist = []
except Exception:
    hist = []
for h in hist:
    if h.get('id') == rid:
        h.update({'finished_at': when, 'status': status,
                  'severity': int(sev), 'summary': summary or 'No summary recorded.'})
        break
json.dump(hist, open(path, 'w'), indent=1)
PY
    push_remote
    ;;
  *)
    echo "usage: report-status.sh start <kind> <target> | finish <id> <status> <severity> <summary>" >&2
    exit 2
    ;;
esac
exit 0
