#!/usr/bin/env bash
# Deploy ReadMind — one source tree onto three instances of the same host:
#
#   prod   /home/public/ReadMind        lib -> /home/protected/readmind-lib
#   test   /home/public/test/ReadMind   lib -> /home/protected/readmind-lib-test
#   dev    /home/public/dev/ReadMind    lib -> /home/protected/readmind-lib-dev
#
#   ./deploy.sh            -> TEST only (the safe default, suite-wide)
#   ./deploy.sh prod       -> production only
#   ./deploy.sh all        -> all three
#   ./deploy.sh --dry-run  -> say what would happen, change nothing
#
# The instance split rides seancheren-site's .htaccess: test./dev. subdomains
# rewrite into /test/ and /dev/, so ReadMind only has to BE there. Data dirs
# (readmind-data{,-test,-dev}) are created web-writable and never synced —
# same one-way, no-delete, no-secrets rules as every deploy in the suite.
set -euo pipefail
cd "$(dirname "$0")"

CONF="deploy.conf"
[[ -f $CONF ]] || { echo "no $CONF — copy deploy.conf.sample and set HOST" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
[[ -n ${HOST:-} ]] || { echo "$CONF sets no HOST" >&2; exit 1; }

MODE="test"; DRY=""
# BatchMode everywhere: an ssh that wants to ask a question must FAIL, not
# wait — the first deploy hung ten silent minutes on exactly that. The flag
# set is the site deploy's proven -rLptzv, verbatim: openrsync (macOS) against
# the host's rsync wedged silently under --delete-excluded, so nothing here
# deletes; stale files are removed by hand the day one exists.
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15"
for a in "$@"; do
  case "$a" in
    test|prod|all) MODE="$a" ;;
    --dry-run)     DRY="--dry-run" ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

echo "==> lint"
for f in public/*.php lib/*.php tools/*.php; do
  php -l "$f" >/dev/null || { echo "SYNTAX ERROR in $f" >&2; exit 1; }
done
echo "    all PHP OK."

push() {  # $1 public dest, $2 lib dest, $3 data dir, $4 label
  echo "==> [$4] public/ -> $1  lib/ -> $2"
  rsync -rLptzv $DRY -e "$SSH" --exclude '.DS_Store' public/ "$HOST:$1/"
  rsync -rLptzv $DRY -e "$SSH" --exclude '.DS_Store' lib/ "$HOST:$2/"
  [[ -n $DRY ]] && return 0
  # The data dir belongs to the web user; the deploy only makes sure it exists
  # and that both users can reach it. Never synced, never deleted.
  $SSH "$HOST" "mkdir -p $1 $2 $3 && chgrp -R web $3 2>/dev/null; chmod 2770 $3 2>/dev/null;
    find $1 $2 -type d -exec chmod a+rx {} + && find $1 $2 -type f -exec chmod a+r {} +"
}

case "$MODE" in
  test) push /home/public/test/ReadMind /home/protected/readmind-lib-test /home/protected/readmind-data-test TEST ;;
  prod) push /home/public/ReadMind      /home/protected/readmind-lib      /home/protected/readmind-data      PROD ;;
  all)
    push /home/public/ReadMind      /home/protected/readmind-lib      /home/protected/readmind-data      PROD
    push /home/public/test/ReadMind /home/protected/readmind-lib-test /home/protected/readmind-data-test TEST
    push /home/public/dev/ReadMind  /home/protected/readmind-lib-dev  /home/protected/readmind-data-dev  DEV
    ;;
esac
echo "==> Done ($MODE). Data dirs were not touched."
