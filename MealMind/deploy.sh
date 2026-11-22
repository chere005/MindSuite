#!/bin/sh
# Deploy MealMind — the web client, to one explicitly selected instance.
#
#   ./deploy.sh --dry-run          preview every transfer
#   ./deploy.sh --yes-prod         do it
#   ./deploy.sh --verify           check production
#   ./deploy.sh --test             deploy TEST only
#   ./deploy.sh --test --verify    check TEST
#
# THE SHAPE OF THIS SCRIPT is deploy-prod.sh's (CalMind's): MealMind writes
# ONE directory, has no API of its own, and each destination is fixed —
# so production gets a spelled-out flag and neither target takes an arbitrary
# path. A script that cannot be aimed cannot be misaimed.
#
# Production remains the default. --test selects its own fixed web root, origin and API;
# no argument or deploy.conf value can supply a destination. Both targets use the same gates.
#
# The host lives in deploy.conf (gitignored) at the repo root — see
# deploy.conf.sample.
set -e
# Resolved BEFORE the cd, because the re-entrant --verify call below needs a
# path that is still correct from the repo root — $0 as given is relative to
# wherever this was invoked from.
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
cd "$(dirname "$0")"
. tools/python.sh

DRY=""; GO=0; VERIFY_ONLY=0; TARGET=prod
for a in "$@"; do
  case "$a" in
    --dry-run)  DRY="--dry-run" ;;
    --yes-prod) GO=1 ;;
    --verify)   VERIFY_ONLY=1 ;;
    --test)     TARGET=test ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

# Constants. Nothing below builds a path from an argument.
WEB_DEST="/home/public/MealMind"
SITE_URL="https://seancheren.com/MealMind"
# The API this client talks to. CalMind's, on purpose — same accounts, and the
# data is kept apart by the sync space rather than by a second server.
API_URL="https://seancheren.com/calmind/api/index.php"
# The app's path until 1.51.0, when it was ChefMind. Once the new path is live
# and proven, the old one becomes a redirect (retire_old_path, at the foot).
OLD_DEST="/home/public/ChefMind"
OLD_URL="https://seancheren.com/ChefMind"
if [ "$TARGET" = test ]; then
WEB_DEST="/home/public/test/MealMind"
SITE_URL="https://test.seancheren.com/MealMind"
API_URL="https://test.seancheren.com/calmind/api/index.php"
OLD_DEST="/home/public/test/ChefMind"
OLD_URL="https://test.seancheren.com/ChefMind"
fi
# Where the old path's last contents go: out of the web root, never deleted.
RETIRED_DIR="/home/private/retired-web"
SPACE="chef"
if [ "$TARGET" = test ] && [ "$GO" = 1 ]; then
  echo "refusing: --test and --yes-prod select different instances" >&2; exit 1
fi

# The guards run BEFORE deploy.conf is read, so tools/check-deploy-guards.sh
# can prove them on a machine with no SSH_DEST and no network.
#
# The three named first are the ones that would be catastrophic rather than
# merely wrong: the site root, and CalMind's own two live areas. `if`, not
# `[ … ] && { … }` — under `set -e` that form is a list whose status is the
# test's, so the ordinary case (false, which is every correct run) would end
# the script.
if [ "$WEB_DEST" = "/home/public" ]; then
  echo "guard: that is the site root" >&2; exit 1
fi
if [ "$WEB_DEST" = "/home/public/calmind" ] || [ "$WEB_DEST" = "/home/public/dev/calmind" ] || [ "$WEB_DEST" = "/home/public/test/calmind" ]; then
  echo "guard: that is CalMind's area, not this app's" >&2; exit 1
fi
case "$TARGET:$WEB_DEST:$SITE_URL:$API_URL" in
  prod:/home/public/MealMind:https://seancheren.com/MealMind:https://seancheren.com/calmind/api/index.php) ;;
  test:/home/public/test/MealMind:https://test.seancheren.com/MealMind:https://test.seancheren.com/calmind/api/index.php) ;;
  *) echo "guard: MealMind destination, page and API must match the selected instance" >&2; exit 1 ;;
esac
case "$TARGET:$OLD_DEST:$OLD_URL:$RETIRED_DIR" in
  prod:/home/public/ChefMind:https://seancheren.com/ChefMind:/home/private/retired-web) ;;
  test:/home/public/test/ChefMind:https://test.seancheren.com/ChefMind:/home/private/retired-web) ;;
  *) echo "guard: the old ChefMind path and its retirement folder must match the selected instance" >&2; exit 1 ;;
esac

# A local config supplies the SSH login only; it cannot alter the checked target or consent flags.
readonly TARGET WEB_DEST SITE_URL API_URL SPACE DRY GO VERIFY_ONLY OLD_DEST OLD_URL RETIRED_DIR

# ---------------------------------------------------------------- the API gate
#
# THE ONE THAT PROTECTS THE OWNER'S DATA, and the reason it runs before anything
# else that costs time.
#
# MealMind syncs into CalMind's server and is kept separate by sending
# space='chef'. An API that does not know that parameter IGNORES it — and then
# every MealMind record lands in CalMind's own store, and every CalMind record
# comes back into MealMind. Nothing errors. It would be found weeks later, by
# a reminders list with recipes in it, and by then the two are one file.
#
# So: ask the live API what spaces it knows, and refuse to ship if the answer
# does not name ours. `spaces` is public for exactly this, because a deploy
# holds no credentials.
api_spaces() {
  curl -sS --max-time 20 -X POST "$API_URL" \
    -H 'Content-Type: application/json' -d '{"action":"spaces"}' 2>/dev/null
}
check_api() {
  echo "==> API gate: does $API_URL know the '$SPACE' space?"
  ANSWER=$(api_spaces || true)
  # A missing Python must stop the deploy, not read as "the API refused".
  mind_python || exit 1
  if ! printf '%s' "$ANSWER" | $MIND_PYTHON -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if '$SPACE' in (d.get('spaces') or []) else 1)
"; then
    echo "" >&2
    echo "REFUSING: the live API does not report the '$SPACE' space." >&2
    echo "  answered: ${ANSWER:-<nothing>}" >&2
    echo "" >&2
    echo "MealMind sends space='$SPACE' on every sync. An API that does not know it" >&2
    echo "ignores the parameter and writes MealMind's records into CalMind's store." >&2
    echo "Update this instance's CalMind API before deploying the client." >&2
    exit 1
  fi
  echo "    it does."
}

if [ "$VERIFY_ONLY" = 1 ]; then
  check_api
  echo "==> verifying what is live at $SITE_URL"
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE_URL/index.html")
  [ "$CODE" = "200" ] || { echo "the page answers $CODE" >&2; exit 1; }
  HEAD=$(curl -sS "$SITE_URL/index.html")
  FAIL=0
  for NEEDLE in 'viewport-fit=cover' 'black-translucent' 'manifest.webmanifest' 'mealmind-bg' 'navigator.serviceWorker.register'; do
    case "$HEAD" in
      *"$NEEDLE"*) printf '  \033[32m✓\033[0m %s\n' "$NEEDLE" ;;
      *) printf '  \033[31m✗\033[0m %s\n' "$NEEDLE"; FAIL=1 ;;
    esac
  done
  # It must NOT be CalMind. One origin, two apps, and an index.html copied to
  # the wrong directory would look entirely healthy above.
  case "$HEAD" in
    *'<title>MealMind</title>'*) printf '  \033[32m✓\033[0m it is MealMind\n' ;;
    *) printf '  \033[31m✗\033[0m that is not MealMind'"'"'s page\n'; FAIL=1 ;;
  esac
  [ "$FAIL" -eq 0 ] || exit 1
  echo "live and correct."
  exit 0
fi

if [ "$TARGET" = prod ] && [ "$GO" != 1 ] && [ -z "$DRY" ]; then
  echo "refusing: this writes the production document root. --yes-prod, spelled out." >&2
  echo "  (--dry-run previews; --verify checks what is already there)" >&2
  exit 1
fi

# Every web export must resolve its API from the page origin. An inherited build override could otherwise send TEST data to production.
if [ -n "${EXPO_PUBLIC_API_URL:-}" ]; then
  echo "refusing: web deployment requires EXPO_PUBLIC_API_URL unset so the API follows the selected origin" >&2; exit 1
fi
check_api

# ONCE PER TREE, NOT ONCE PER SCRIPT. Under a tdtp, tools/dtp.sh's --full pass
# has just run this same typecheck and this same core suite. It hands down,
# in CHEF_GATES_PASSED, the content key of the tree they passed on
# (tools/gate-key.mjs: everything tsc and vitest can read, minus only the
# version fields the bump rewrites). When the tree here still hashes to
# exactly that, running them again would check identical bytes twice, so
# they stand down and say so. Every other case runs them as always: a plain
# dtp, this script run by hand, a file saved mid-lane, a key that cannot be
# computed. Those runs can still fail and refuse the deploy.
GATES_KEY=""
if [ -n "${CHEF_GATES_PASSED:-}" ]; then
  GATES_KEY=$(node tools/gate-key.mjs) || GATES_KEY=""
fi
if [ -n "$GATES_KEY" ] && [ "$GATES_KEY" = "$CHEF_GATES_PASSED" ]; then
  echo "==> typecheck + core tests: passed in this lane's full run, on this exact tree (key $(printf '%.12s' "$GATES_KEY")…) — not run twice"
else
  if [ -n "${CHEF_GATES_PASSED:-}" ]; then
    echo "==> this is not the tree the lane's full run checked — checking it here"
  fi
  echo "==> typecheck"
  TSLOG=$(mktemp)
  for P in packages/core app; do
    if ! npx tsc --noEmit -p "$P" >"$TSLOG" 2>&1; then
      cat "$TSLOG" >&2; rm -f "$TSLOG"
      echo "$P typecheck failed — not deploying" >&2; exit 1
    fi
  done
  rm -f "$TSLOG"

  echo "==> core tests"
  npm run test:core --silent >/dev/null 2>&1 \
    || { echo "core tests failed — not deploying" >&2; exit 1; }
fi

# The API is CalMind's, so ITS suite is the one that gates the behaviour this
# client depends on — the sync space above all. That server lives in the
# CalMind repo, not this one; when a checkout is present its suite runs and
# gates the deploy. When it is not, this says so OUT LOUD rather than skipping
# silently — the live API gate above is then the only server check.
CALMIND_REPO="${CALMIND_REPO:-$(cd .. && pwd)/CalMind}"
if [ -f "$CALMIND_REPO/server/tools/test.php" ]; then
  echo "==> server tests (the API this client talks to is CalMind's, at $CALMIND_REPO)"
  php "$CALMIND_REPO/server/tools/test.php" >/dev/null \
    || { echo "CalMind's server tests failed — not deploying" >&2; exit 1; }
else
  echo "==> server tests SKIPPED — no CalMind checkout at $CALMIND_REPO;"
  echo "    the API gate above is the only server check this run has"
fi

echo "==> web export"
EXPO_NO_DOTENV=1 npm run export:web >/dev/null \
  || { echo "the export failed — not deploying" >&2; exit 1; }
node tools/patch-web-html.mjs app/dist/index.html

[ -f app/dist/index.html ] || { echo "the export produced no dist/index.html — not deploying" >&2; exit 1; }
# Read the bundle out of index.html rather than globbing: dist holds more than
# one index-*.js (the entry bundle and an async chunk) and `find | head -1`
# picks between them arbitrarily.
BUNDLE=$(grep -o 'index-[a-zA-Z0-9]*\.js' app/dist/index.html | head -1)
[ -n "$BUNDLE" ] || { echo "dist/index.html names no bundle — not deploying" >&2; exit 1; }
echo "    bundle: $BUNDLE"

# The client must be the one that sends the space. A build that lost the line
# would pass every check above and still merge two stores.
grep -q "space" app/src/api.ts || { echo "api.ts no longer sends a space — not deploying" >&2; exit 1; }
if ! grep -q "\"$SPACE\"\|'$SPACE'" "app/dist/_expo/static/js/web/$BUNDLE"; then
  echo "the exported bundle does not contain the space string — not deploying" >&2
  exit 1
fi
echo "    the bundle carries space='$SPACE'"

[ -f deploy.conf ] || { echo "deploy.conf missing (SSH_DEST=...)" >&2; exit 1; }
. ./deploy.conf
[ -n "$SSH_DEST" ] || { echo "SSH_DEST not set in deploy.conf" >&2; exit 1; }

# ONE SSH CONNECTION FOR THE WHOLE UPLOAD — CalMind's server/deploy.sh shape,
# same names. The upload is two rsyncs, and each used to open its own
# connection to NFSN, a couple of seconds of handshake apiece. Now the
# preflight below opens a master and every later call rides it
# (ControlPersist keeps it up between calls; mux_close ends it with the run).
# Same commands, same files, same order: only how the session is opened
# changed, and the served-page proof is HTTPS and never touches it.
#
# The socket sits in a private mktemp dir (0700: nobody else on this machine
# rides the connection) and its path stays short, because macOS refuses a
# socket path over 104 bytes and ssh adds 17 of its own while it sets the
# master up. A $TMPDIR long or odd enough to break that — a sandboxed
# session's can be — gets no multiplexing rather than a broken one: RSH is
# then plain ssh, which is exactly the old deploy.
#
# Every call still starts its line with `ssh ` or `rsync `, the spelling
# tools/check-deploy-guards.sh rewrites to echo in its tampered copies. Keep
# it that way: a call spelled any other way would reach the server from a
# guard check.
SSHMUX=""
MUX_TMP=${TMPDIR:-/tmp}
MUX_DIR=$(mktemp -d "${MUX_TMP%/}/mealmind-ssh.XXXXXX" 2>/dev/null) || MUX_DIR=""
case "$MUX_DIR" in
  ''|*[!A-Za-z0-9._/-]*) ;;
  *)
    if [ ${#MUX_DIR} -le 80 ]; then
      SSHMUX="-o ControlMaster=auto -o ControlPath=$MUX_DIR/m -o ControlPersist=120"
    fi ;;
esac
RSH="ssh${SSHMUX:+ $SSHMUX}"
mux_close() {
  if [ -n "$SSHMUX" ]; then
    ssh -O exit $SSHMUX "$SSH_DEST" >/dev/null 2>&1 || true
  fi
  if [ -n "$MUX_DIR" ]; then rm -rf "$MUX_DIR"; fi
}
# However this run ends. On INT or TERM the master is closed and then the
# signal is raised again, so whoever ran this still sees an interrupt rather
# than an ordinary failure.
on_signal() {
  mux_close
  trap - EXIT "$1"
  kill -s "$1" $$
  exit 1
}
trap mux_close EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

echo "==> icons"
# iOS reads apple-touch-icon, which expo does not emit; the manifest names the
# other two.
sips -z 180 180 app/assets/icon.png --out app/dist/apple-touch-icon.png >/dev/null 2>&1
sips -z 192 192 app/assets/icon.png --out app/dist/icon-192.png >/dev/null 2>&1
sips -z 512 512 app/assets/icon.png --out app/dist/icon-512.png >/dev/null 2>&1
perl -i -pe "s|<link rel=\"apple-touch-icon\"[^>]*/?>||g" app/dist/index.html
perl -i -pe "s|</head>|<link rel=\"apple-touch-icon\" href=\"/MealMind/apple-touch-icon.png\"/></head>|" app/dist/index.html
ICOV=$(shasum app/dist/favicon.ico | cut -c1-8)
perl -i -pe "s|favicon\.ico(\?v=[0-9a-f]*)?|favicon.ico?v=$ICOV|" app/dist/index.html

# PREFLIGHT, before anything is written: open the shared connection and use
# it twice. A host that will not run a second session over one connection
# (sshd's MaxSessions) is found HERE, not between the two rsyncs, with new
# bundles live behind an old .htaccess. Where CalMind stops on that, this
# falls back to a connection per call, which is the deploy as it was before
# the master existed: the master is a saving, and it must never be the reason
# a deploy that worked yesterday cannot run today. If plain ssh fails too, the
# host is unreachable and nothing has been uploaded. Read-only, so a dry run
# makes it too; its rsyncs connect anyway.
if [ -n "$SSHMUX" ]; then
  echo "==> one ssh connection for the upload"
  MUX_OK=1
  ssh $SSHMUX "$SSH_DEST" true || MUX_OK=0
  if [ "$MUX_OK" = 1 ]; then
    ssh $SSHMUX "$SSH_DEST" true || MUX_OK=0
  fi
  if [ "$MUX_OK" = 0 ]; then
    mux_close
    SSHMUX=""; MUX_DIR=""; RSH="ssh"
    echo "   the shared connection failed — trying one connection per call, as before" >&2
    ssh "$SSH_DEST" true \
      || { echo "cannot reach $SSH_DEST over ssh — nothing uploaded" >&2; exit 1; }
  fi
fi

echo "==> web client -> $WEB_DEST/"
# No --delete, ever. .sources.json is this machine's record of what the export
# was built from and has no business being served.
rsync -avL $DRY -e "$RSH" --exclude '.sources.json' app/dist/ "$SSH_DEST:$WEB_DEST/"
# index.html must revalidate; the hashed bundles cache forever. CalMind's
# htaccess, because the rule is about the shape of the files and both apps
# have the same shape.
rsync -avL $DRY -e "$RSH" tools/web.htaccess "$SSH_DEST:$WEB_DEST/.htaccess"

if [ -z "$DRY" ]; then
  echo "==> proving the served page"
  # Retried once: an upload that has just finished can serve a moment of
  # inconsistency, and a gate that cries wolf is one people learn to ignore.
  # A second failure still stops the deploy.
  verify_live() {
    if [ "$TARGET" = test ]; then sh "$SELF" --test --verify; else sh "$SELF" --verify; fi
  }
  if ! verify_live; then
    echo "   first pass failed — giving the upload a moment and re-checking once" >&2
    sleep 5
    verify_live || { echo "the deployed page is wrong" >&2; exit 1; }
  fi
fi

# ------------------------------------------------------- the old /ChefMind/ path
#
# The app was ChefMind, at /ChefMind/, until 1.51.0. Bookmarks, home-screen
# installs and a service worker that serves the old shell offline all still
# point there. So once the new path is live AND PROVEN (above: a failed proof
# has already stopped the script), the old directory is replaced by
# tools/old-path/: an .htaccess that 302s every request to the same place
# under /MealMind/, and an sw.js that deletes ChefMind's caches (only those:
# one origin holds every app's) and unregisters ChefMind's worker.
#
# The swap is staged: upload as ChefMind.next, prove it serves the redirect
# and the worker there, then two renames (ChefMind -> ChefMind.old, .next ->
# ChefMind) and the old folder moves OUT of the web root to $RETIRED_DIR —
# moved, never deleted.
#
# Idempotent: when the old path already holds exactly these files, there is
# nothing to do. And it touches only what it recognises: the old ChefMind page
# (its <title>), an earlier redirect of this script's, or nothing at all. The
# TEST instance's /ChefMind/ is also where the TestChefMind sandbox deploys
# (its page is titled TestChefMind), and that is left exactly as it is.
#
# Every ssh and rsync starts its line, so tools/check-deploy-guards.sh's
# tampered copies echo them rather than reach the server.
probe_old_path() { # probe_old_path <base URL> — does it redirect and serve the kill worker?
  P_OK=1
  for P in "" "index.html?retired=1"; do
    GOT=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$1/$P") || GOT="no answer"
    if [ "$GOT" = "302 $SITE_URL/$P" ]; then
      printf '  \033[32m✓\033[0m %s -> 302 %s\n' "$1/$P" "$SITE_URL/$P"
    else
      printf '  \033[31m✗\033[0m %s answers "%s", not a 302 to %s\n' "$1/$P" "$GOT" "$SITE_URL/$P"; P_OK=0
    fi
  done
  HDRS=$(curl -sS -D - -o /dev/null "$1/sw.js") || HDRS=""
  BODY=$(curl -sS "$1/sw.js") || BODY=""
  if printf '%s\n' "$HDRS" | head -n 1 | grep -q ' 200' &&
      printf '%s\n' "$HDRS" | grep -qi '^cache-control:.*no-cache' &&
      case "$BODY" in *"startsWith('chefmind-')"*unregister*) true ;; *) false ;; esac; then
    printf '  \033[32m✓\033[0m %s/sw.js is the kill worker, 200, no-cache\n' "$1"
  else
    printf '  \033[31m✗\033[0m %s/sw.js is not the kill worker served 200 no-cache\n' "$1"; P_OK=0
  fi
  [ "$P_OK" = 1 ]
}
retire_old_path() {
  OLD_PARENT=${OLD_DEST%/*}; OLD_NAME=${OLD_DEST##*/}
  echo "==> the old path: $OLD_URL/ -> $SITE_URL/"
  WANT=$(cat tools/old-path/.htaccess tools/old-path/sw.js)
  HAVE=$(
    ssh $SSHMUX "$SSH_DEST" "cat '$OLD_DEST/.htaccess' '$OLD_DEST/sw.js' 2>/dev/null"
  ) || HAVE=""
  if [ -n "$HAVE" ] && [ "$HAVE" = "$WANT" ]; then
    echo "    already the redirect — nothing to change"
    return 0
  fi
  OLD_SEEN=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$OLD_URL/index.html") || OLD_SEEN="no answer"
  case "$OLD_SEEN" in
    "200 "*)
      OLD_PAGE=$(curl -sS "$OLD_URL/index.html") || OLD_PAGE=""
      case "$OLD_PAGE" in
        *'<title>ChefMind</title>'*) echo "    it still serves ChefMind's page — replacing it with the redirect" ;;
        *) echo "    it serves some other page (the TestChefMind sandbox's, on TEST?) — left alone"; return 0 ;;
      esac ;;
    "302 $SITE_URL/index.html") echo "    an earlier redirect — replacing it with this one" ;;
    "404 "*) echo "    nothing there — putting the redirect in place" ;;
    *) echo "    it answers \"$OLD_SEEN\": not something this script put there — left alone; a re-run tries again"; return 0 ;;
  esac
  # (Called as `retire_old_path || exit 1`, so set -e is off in here: every
  # step that can fail says so itself.)
  rsync -avL $DRY -e "$RSH" tools/old-path/ "$SSH_DEST:$OLD_DEST.next/" \
    || { echo "could not upload the redirect to $OLD_DEST.next — the old path is unchanged" >&2; return 1; }
  if [ -n "$DRY" ]; then
    echo "    (dry run: would prove $OLD_URL.next/, swap it in for $OLD_DEST and move the old folder to $RETIRED_DIR/)"
    return 0
  fi
  echo "    proving the staged copy at $OLD_URL.next/"
  # Retried once after a moment, like the served-page proof above.
  probe_old_path "$OLD_URL.next" || { sleep 5; probe_old_path "$OLD_URL.next"; } || {
    echo "the staged redirect at $OLD_DEST.next does not answer as it must — the old path is unchanged" >&2
    return 1
  }
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  RETIRED_AS="$TARGET-$OLD_NAME-$STAMP"
  ssh $SSHMUX "$SSH_DEST" "set -e; cd '$OLD_PARENT'; test -f '$OLD_NAME.next/.htaccess'; test -f '$OLD_NAME.next/sw.js'; mkdir -p '$RETIRED_DIR'; if [ -e '$OLD_NAME.old' ]; then mv '$OLD_NAME.old' '$RETIRED_DIR/$RETIRED_AS.earlier'; fi; if [ -e '$OLD_NAME' ]; then mv '$OLD_NAME' '$OLD_NAME.old'; fi; mv '$OLD_NAME.next' '$OLD_NAME'; if [ -e '$OLD_NAME.old' ]; then mv '$OLD_NAME.old' '$RETIRED_DIR/$RETIRED_AS'; fi" \
    || { echo "the swap at $OLD_PARENT failed part-way — look at $OLD_NAME, $OLD_NAME.next and $OLD_NAME.old there" >&2; return 1; }
  echo "    swapped in; whatever was there is now $RETIRED_DIR/$RETIRED_AS"
  echo "    proving the old path"
  probe_old_path "$OLD_URL" || { sleep 5; probe_old_path "$OLD_URL"; } || {
    echo "the old path does not redirect as it must after the swap — look at $OLD_DEST" >&2
    return 1
  }
}
retire_old_path || exit 1

echo "==> Done. $SITE_URL"
