#!/bin/sh
# Tests for tools/deploy.sh. ssh, rsync, curl, npm, date, sleep and the host's php are replaced by shims in a
# temporary PATH directory, so nothing here can reach a real host. The ssh shim records each call and then
# plays the host: it runs the script it receives on stdin against a sandbox directory tree (/home/... is
# remapped into it), so the remote logic (lint loop, link flip, rollback, prune) really executes. The curl shim
# plays the web server: it serves THROUGH the public link, refuses /.taskmind/ unless its .htaccess denies it,
# and answers api.php with the X-TaskMind-Release header of the release the link names (optionally lagging).
# The entrypoint tests run the real index.php and api.php under php-cgi against a fake host tree. dtp.sh and
# build-platforms.sh run in the same way: a bare origin and a stub deploy.sh, and shimmed npm, cargo, xcrun, adb, emulator and aapt.
#
#   sh tools/test-deploy.sh                    every test
#   sh tools/test-deploy.sh --only t_rollback  one test
#   sh tools/test-deploy.sh --mutations        break deploy.sh, the entrypoints, dtp.sh, build-platforms.sh and package.mjs one rule at a time; each break must be caught
#                                              (MUT_JOBS=n runs n mutants at once, default 4; MUT_APPLY_ONLY=1 only checks that each applies;
#                                               MUT_ONLY=regex runs only the mutants whose names match it)
#   REMOTE_SH=dash sh tools/test-deploy.sh     run the remote scripts under another shell
#   KEEP_TMP=1 ...                             keep the sandbox (calls log, remote tree) for inspection
#   PHP_BINARY / PHP_CGI                       the php and php-cgi the entrypoint tests use (default: the ones on PATH)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_SRC=${DEPLOY_SRC:-$ROOT/tools/deploy.sh}
DTP_SRC=${DTP_SRC:-$ROOT/tools/dtp.sh}
PLATFORMS_SRC=${PLATFORMS_SRC:-$ROOT/tools/build-platforms.sh}
PACKAGE_SRC=${PACKAGE_SRC:-$ROOT/tools/package.mjs}
INDEX_SRC=${INDEX_SRC:-$ROOT/server/public/TaskMind/index.php}
API_SRC=${API_SRC:-$ROOT/server/public/TaskMind/api.php}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/taskmind-deploy-test.XXXXXX") || exit 1
trap '[ -n "${KEEP_TMP:-}" ] && echo "kept: $TMP" || rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM
SHIMS=$TMP/shims
echo 0 > "$TMP/n"; : > "$TMP/results"

# ---- Shims ---------------------------------------------------------------------------------------------------
mkdir -p "$SHIMS"
cat > "$SHIMS/ssh" <<'EOF'
#!/bin/sh
[ -n "${SHIM_LOG:-}" ] || { echo 'ssh shim: SHIM_LOG not set' >&2; exit 97; }
script="$SHIM_LOG/script-$(( $(wc -l < "$SHIM_LOG/calls" | tr -d ' ') + 1 ))"
cat > "$script"
phase=$(sed -n '1s/^# taskmind-phase: //p' "$script")
printf 'ssh\t%s\t%s\n' "${phase:-?}" "$*" >> "$SHIM_LOG/calls"
[ "${SHIM_SSH_DEAD:-}" != 1 ] || { echo 'ssh: could not resolve hostname (shim)' >&2; exit 255; }
[ "${SHIM_SSH_FAIL_PHASE:-}" != "$phase" ] || { echo "ssh shim: injected failure in $phase" >&2; exit 1; }
# Hooks play "something else happens on the host": a command run just before / just after a named phase.
[ "${SHIM_BEFORE_PHASE:-}" != "$phase" ] || sh -c "$SHIM_BEFORE_CMD"
# The sandbox host: /home/... lives under SHIM_REMOTE, and its web group is SHIM_WEB_GROUP.
sed -e "s#/home/#$SHIM_REMOTE/home/#g" -e "s#^WEB_GROUP='web'#WEB_GROUP='${SHIM_WEB_GROUP:-web}'#" "$script" | ${REMOTE_SH:-sh} -s
rc=$?
[ "${SHIM_AFTER_PHASE:-}" != "$phase" ] || sh -c "$SHIM_AFTER_CMD"
exit $rc
EOF
cat > "$SHIMS/rsync" <<'EOF'
#!/bin/sh
printf 'rsync\t-\t%s\n' "$*" >> "$SHIM_LOG/calls"
[ -z "${SHIM_RSYNC_SLEEP:-}" ] || sleep "$SHIM_RSYNC_SLEEP"
src=; dest=; keep=; chm=
for a; do   # the last two arguments are source and destination; a short-option bundle with p keeps modes, like rsync -p
  src=$dest; dest=$a
  case $a in --chmod=*) chm=${a#--chmod=} ;; --*) ;; -*p*) keep=p ;; esac
done
[ -z "${SHIM_RSYNC_FAIL:-}" ] || { echo 'rsync: connection unexpectedly closed (shim)' >&2; exit 12; }
d=$SHIM_REMOTE${dest#*:}
mkdir -p "$d" && cp -R$keep "$src". "$d" || exit 1
# GNU rsync applies --chmod to what it sends; macOS's own rsync (openrsync) accepts the option and ignores it, which
# SHIM_RSYNC_IGNORE_CHMOD=1 plays (the host then has to open what stayed closed itself).
if [ -n "$chm" ] && [ -z "${SHIM_RSYNC_IGNORE_CHMOD:-}" ]; then
  [ "$chm" = 'Dgo+rx,Fgo+r' ] || { echo "rsync shim: unsupported --chmod=$chm" >&2; exit 97; }
  find "$d" -type d -exec chmod go+rx {} +; find "$d" -type f -exec chmod go+r {} +
fi
# a transfer that silently loses a file (exit status 0)
[ -z "${SHIM_RSYNC_DROP:-}" ] || find "$d" -name "$SHIM_RSYNC_DROP" -exec rm -f {} +
exit 0
EOF
# The web server. Like Apache on the host: pages are served THROUGH the public link (a relative symlink inside the
# docroot); /.taskmind/... is refused (403) while .taskmind/.htaccess is exactly "Require all denied", else served.
# api.php answers 401 with X-TaskMind-Release = the release directory the link names, except:
#   SHIM_CURL_LAG=N          the header names the OLD release for the first N polls after every flip (PHP's cache lag)
#   SHIM_CURL_STUCK=<stamp>  the header always names <stamp> (a flip that never reaches PHP)
#   SHIM_CURL_NO_API_HEADER=1  no header at all
#   SHIM_CURL_TIMEOUT_AT="N M"  requests N and M get no answer at all (curl's exit 28 after its --max-time)
#   SHIM_CURL_RESET_AT="N M"    requests N and M are reset at once (curl's exit 56: an answer that never comes, without the wait)
#   SHIM_CURL_PAGE_CODE=C [SHIM_CURL_PAGE_LOC=L]  the page answers status C (with a Location header L) instead of 200
#   SHIM_CURL_STATIC_LAG=N      release.txt and build.txt show the PREVIOUS release's value for their first N fetches after every flip
#   SHIM_CURL_BUILD_ONCE=v / SHIM_CURL_BUILD_ALWAYS=v   build.txt says v for its first fetch / for every fetch
cat > "$SHIMS/curl" <<'EOF'
#!/bin/sh
url=; fmt=; hdr=0; prev=
for a; do
  [ "$prev" != -w ] || fmt=$a
  case $a in http*) url=$a ;; -D) hdr=1 ;; esac
  prev=$a
done
printf 'curl\t-\t%s\n' "$*" >> "$SHIM_LOG/calls"
n=$(grep -c '^curl' "$SHIM_LOG/calls")
for f in ${SHIM_CURL_TIMEOUT_AT:-}; do [ "$f" != "$n" ] || { echo 'curl: (28) Operation timed out after 20000 milliseconds with 0 bytes received (shim)' >&2; exit 28; }; done
for f in ${SHIM_CURL_RESET_AT:-}; do [ "$f" != "$n" ] || { echo 'curl: (56) Recv failure: Connection reset by peer (shim)' >&2; exit 56; }; done
case $url in
  https://test.seancheren.com/*) base=$SHIM_REMOTE/home/public/test; prot=$SHIM_REMOTE/home/protected/taskmind-test ;;
  https://seancheren.com/*) base=$SHIM_REMOTE/home/public; prot=$SHIM_REMOTE/home/protected/taskmind ;;
  *) echo "curl shim: unexpected URL $url" >&2; exit 97 ;;
esac
path=/${url#*://*/}; pub=$base/TaskMind; shown=; loc=
case $path in
  /.taskmind/*)
    if [ "$(cat "$base/.taskmind/.htaccess" 2>/dev/null)" = 'Require all denied' ]; then code=403
    elif [ -f "$base$path" ]; then code=200; else code=404; fi ;;
  */api.php) code=401; [ -f "$pub/api.php" ] || code=404
    if [ -n "${SHIM_CURL_API_ONCE:-}" ] && [ ! -e "$SHIM_LOG/api-once" ]; then : > "$SHIM_LOG/api-once"; code=$SHIM_CURL_API_ONCE; fi
    if [ "$code" != 404 ]; then
      live=$(readlink "$pub" 2>/dev/null | sed 's#^.taskmind/##'); shown=$live
      if [ -n "${SHIM_CURL_LAG:-}" ]; then
        if [ "$(cat "$SHIM_LOG/lag-live" 2>/dev/null)" != "$live" ]; then echo "$live" > "$SHIM_LOG/lag-live"; echo 0 > "$SHIM_LOG/lag-used"; fi
        used=$(cat "$SHIM_LOG/lag-used")
        if [ "$used" -lt "$SHIM_CURL_LAG" ]; then
          echo $((used + 1)) > "$SHIM_LOG/lag-used"
          shown=$(head -n 1 "$prot/previous" 2>/dev/null); shown=${shown:-20250101000001-1}
        fi
      fi
      [ -z "${SHIM_CURL_STUCK:-}" ] || shown=$SHIM_CURL_STUCK
      [ -z "${SHIM_CURL_NO_API_HEADER:-}" ] || shown=
    fi ;;
  */build.txt|*/release.txt) code=200; [ -f "$pub/${path##*/}" ] || code=404 ;;
  *) code=200; [ -f "$pub/index.php" ] || code=404
     if [ -n "${SHIM_CURL_PAGE_CODE:-}" ]; then code=$SHIM_CURL_PAGE_CODE; loc=${SHIM_CURL_PAGE_LOC:-}; fi ;;
esac
for f in ${SHIM_CURL_FAIL_AT:-}; do [ "$f" != "$n" ] || code=500; done
if [ -n "$fmt" ]; then
  if [ "$hdr" = 1 ]; then
    printf 'HTTP/1.1 %s X\r\n' "$code"
    [ -z "$shown" ] || printf 'X-TaskMind-Release: %s\r\n' "$shown"
    [ -z "$loc" ] || printf 'Location: %s\r\n' "$loc"
    printf '\r\n'
  fi
  printf '%b' "$(printf '%s' "$fmt" | sed "s/%{http_code}/$code/")"
  exit 0
fi
[ "$code" -lt 400 ] || exit 22
# A static file, or (SHIM_CURL_STATIC_LAG) the previous release's value for its first N fetches since the link last changed.
static() {
  _f=$1; _live=$(readlink "$pub" 2>/dev/null | sed 's#^.taskmind/##')
  if [ -n "${SHIM_CURL_STATIC_LAG:-}" ]; then
    if [ "$(cat "$SHIM_LOG/slag-live-$_f" 2>/dev/null)" != "$_live" ]; then echo "$_live" > "$SHIM_LOG/slag-live-$_f"; echo 0 > "$SHIM_LOG/slag-used-$_f"; fi
    _used=$(cat "$SHIM_LOG/slag-used-$_f")
    if [ "$_used" -lt "$SHIM_CURL_STATIC_LAG" ]; then
      echo $((_used + 1)) > "$SHIM_LOG/slag-used-$_f"
      _old=$(head -n 1 "$prot/previous" 2>/dev/null); _old=${_old:-20250101000001-1}
      case $_f in
        release.txt) echo "$_old" ;;
        build.txt) cat "$base/.taskmind/$_old/build.txt" 2>/dev/null || echo 0.0.0 ;;
      esac
      return
    fi
  fi
  cat "$pub/$_f"
}
case $path in
  */build.txt)
    if [ -n "${SHIM_CURL_BUILD_ALWAYS:-}" ]; then echo "$SHIM_CURL_BUILD_ALWAYS"
    elif [ -n "${SHIM_CURL_BUILD_ONCE:-}" ] && [ ! -e "$SHIM_LOG/build-once" ]; then : > "$SHIM_LOG/build-once"; echo "$SHIM_CURL_BUILD_ONCE"
    else static build.txt; fi ;;
  */release.txt) static release.txt ;;
esac
EOF
cat > "$SHIMS/npm" <<'EOF'
#!/bin/sh
printf 'npm\t-\t%s\n' "$*" >> "$SHIM_LOG/calls"
[ "$*" != "${SHIM_NPM_FAIL_ON:-}" ] || exit 1
EOF
cat > "$SHIMS/date" <<'EOF'
#!/bin/sh
n=$(( $(cat "$SHIM_LOG/clock" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$SHIM_LOG/clock"
printf '2026010100%04d\n' "$n"
EOF
cat > "$SHIMS/php" <<'EOF'
#!/bin/sh
[ -z "${SHIM_PHP_MISSING:-}" ] || { echo 'php: command not found (shim)' >&2; exit 127; }
if [ "$1" = -v ]; then echo 'PHP 8.2.99 (cli) (built: shim)'; exit 0; fi
[ "$1" = -l ] || { echo "php shim: unsupported: $*" >&2; exit 97; }
shift
echo "$#" >> "$SHIM_LOG/php-calls"   # one line per php -l process: how many files it was given
if [ "$#" -gt 1 ]; then
  # PHP before 8.3 takes one file. SHIM_PHP_NO_MULTI: it refuses a second one. SHIM_PHP_FIRST_ONLY: it lints the first, ignores
  # the rest and exits 0 (so a syntax error in a later file goes unseen unless the caller counts what was linted).
  [ -z "${SHIM_PHP_NO_MULTI:-}" ] || { echo 'Usage: php [options] [-f] <file> [--] [args...] (shim: one file only)' >&2; exit 1; }
  [ -z "${SHIM_PHP_FIRST_ONLY:-}" ] || set -- "$1"
fi
rc=0
for f; do
  printf '%s\n' "$f" >> "$SHIM_LOG/lint"
  if grep -q TASKMIND_SHIM_SYNTAX_ERROR "$f"; then echo "PHP Parse error: syntax error in $f" >&2; rc=255
  else echo "No syntax errors detected in $f"; fi
done
exit $rc
EOF
# mv that can pretend a link flip did nothing (SHIM_MV_NOOP=<link name>): the silent failure mode of a rename.
cat > "$SHIMS/mv" <<'EOF'
#!/bin/sh
if [ -n "${SHIM_MV_NOOP:-}" ]; then for a; do last=$a; done; case $last in */"$SHIM_MV_NOOP") exit 0 ;; esac; fi
exec /bin/mv "$@"
EOF
# sleep: the verification's one-second poll wait is counted and skipped; every other sleep is real.
cat > "$SHIMS/sleep" <<'EOF'
#!/bin/sh
if [ "$*" = 1 ]; then echo 1 >> "$SHIM_LOG/sleeps"; exit 0; fi
for s in /bin/sleep /usr/bin/sleep; do [ -x "$s" ] && exec "$s" "$@"; done
exit 1
EOF
# nice: the host runs its lint and its walks over the release at low priority; the shim notes what ran under it.
cat > "$SHIMS/nice" <<'EOF'
#!/bin/sh
[ "$1" = -n ] && [ -n "$2" ] || { echo "nice shim: unsupported: $*" >&2; exit 97; }
printf '%s\n' "$*" >> "$SHIM_LOG/nice"
shift 2
exec "$@"
EOF
chmod +x "$SHIMS"/*

# ---- Fixtures and helpers ------------------------------------------------------------------------------------
write_auth_lib() {   # same shape as the site's lib: auth.php requires its siblings by __DIR__
  mkdir -p "$1"
  cat > "$1/auth.php" <<'PHP'
<?php
require_once __DIR__ . '/store.php';    // encrypted-at-rest storage helpers
require_once __DIR__ . '/mail.php';     // sending the sign-up verification code
require_once __DIR__ . '/usagelog.php'; // per-user usage log
require_once __DIR__ . '/hitlog.php';   // one line per request
PHP
  for f in config store mail usagelog hitlog; do echo '<?php // fixture' > "$1/$f.php"; done
}

new_case() {   # fresh repo copy, fresh sandbox host, fresh shim log; exports the shim environment
  _n=$(( $(cat "$TMP/n") + 1 )); echo "$_n" > "$TMP/n"
  # T = protected tree, PB = the docroot of the instance, PL = the public link, PR = the public releases (.taskmind)
  CASE=$TMP/case-$_n; REPO=$CASE/repo; R=$CASE/remote; LOG=$CASE/log; T=$R/home/protected/taskmind-test
  PB=$R/home/public/test; PL=$PB/TaskMind; PR=$PB/.taskmind
  mkdir -p "$REPO/tools" "$REPO/dist/public/TaskMind/assets" "$REPO/dist/protected/lib" "$LOG" "$PB"
  : > "$LOG/calls"
  printf '{"name":"taskmind","version":"9.9.9"}\n' > "$REPO/package.json"
  cp "$DEPLOY_SRC" "$REPO/tools/deploy.sh"
  for f in index api; do echo '<?php // fixture' > "$REPO/dist/public/TaskMind/$f.php"; done
  for f in atomic bootstrap taskmind; do echo '<?php // fixture' > "$REPO/dist/protected/lib/$f.php"; done
  printf '9.9.9\n' > "$REPO/dist/public/TaskMind/build.txt"
  set_store 3
  echo '<svg/>' > "$REPO/dist/public/TaskMind/icon.svg"
  printf 'Options -Indexes\n' > "$REPO/dist/public/TaskMind/.htaccess"
  echo 'x' > "$REPO/dist/public/TaskMind/assets/app.js"; echo 'x' > "$REPO/dist/public/TaskMind/assets/app.css"
  # A Mac checkout with restrictive modes (the host must make the release readable itself), whatever umask runs this.
  find "$REPO/dist" -type d -exec chmod 700 {} +; find "$REPO/dist" -type f -exec chmod 600 {} +
  write_auth_lib "$R/home/protected/lib-test"; write_auth_lib "$R/home/protected/lib"
  # The data directories are provisioned by hand on a real host: group web, group-writable (here the sandbox's own group).
  for _d in taskmind-data-test taskmind-data; do mkdir -p "$R/home/protected/$_d"; chmod 2770 "$R/home/protected/$_d"; done
  SHIM_WEB_GROUP=$(ls -ld "$R/home/protected/taskmind-data-test/." | awk '{print $4}')
  SHIM_LOG=$LOG; SHIM_REMOTE=$R; TASKMIND_DEPLOY_HOST=taskmind-test@ssh.invalid
  export SHIM_LOG SHIM_REMOTE TASKMIND_DEPLOY_HOST SHIM_WEB_GROUP
  unset SHIM_CURL_PAGE_CODE SHIM_CURL_PAGE_LOC SHIM_CURL_TIMEOUT_AT SHIM_CURL_FAIL_AT SHIM_CURL_API_ONCE SHIM_CURL_BUILD_ONCE SHIM_CURL_LAG SHIM_CURL_STUCK SHIM_CURL_NO_API_HEADER \
        SHIM_NPM_FAIL_ON SHIM_RSYNC_FAIL SHIM_SSH_DEAD SHIM_SSH_FAIL_PHASE \
        SHIM_BEFORE_PHASE SHIM_BEFORE_CMD SHIM_AFTER_PHASE SHIM_AFTER_CMD SHIM_PHP_MISSING SHIM_MV_NOOP SHIM_RSYNC_SLEEP SHIM_RSYNC_DROP \
        SHIM_CURL_RESET_AT SHIM_CURL_STATIC_LAG SHIM_CURL_BUILD_ALWAYS SHIM_PHP_NO_MULTI SHIM_PHP_FIRST_ONLY SHIM_RSYNC_IGNORE_CHMOD
}
set_store() {   # set_store <n>: the store version the release in dist/ reads and writes: store-version.txt and the limits.php it must agree with
  printf '%s\n' "$1" > "$REPO/dist/protected/lib/store-version.txt"
  printf "<?php\n// fixture\nconst MODEL = [\n  'storeVersion' => %s,\n];\n" "$1" > "$REPO/dist/protected/lib/limits.php"
}
data_marker() { printf '%s\n' "$1" > "$R/home/protected/taskmind-data-test/workspace.version"; }   # the version the server last wrote the data at
with_data() { echo ciphertext > "$R/home/protected/taskmind-data-test/workspace.enc"; echo k > "$R/home/protected/taskmind-data-test/.key"; }
set_version() { printf '{"name":"taskmind","version":"%s"}\n' "$1" > "$REPO/package.json"; printf '%s\n' "$1" > "$REPO/dist/public/TaskMind/build.txt"; }
live() { readlink "$PL" 2>/dev/null | sed 's#^\.taskmind/##'; }   # the release stamp the public link names
prev() { cat "$T/previous" 2>/dev/null || true; }                 # the stamp in the protected previous file
sleeps() { cat "$LOG/sleeps" 2>/dev/null | wc -l | tr -d ' '; }  # one-second verification waits taken (the sleep shim only counts them)
api_polls() { since | grep -c '^curl.*api\.php' || true; }       # api.php requests since the last mark

# Run one phase's real script text (taken from the deploy script under test) straight on the sandbox host, with the
# variables the caller has set (PUBLIC PUBREL PROTECTED AUTH DATA KEEP, optionally STAMP and friends): for guards no deploy reaches.
host_vars_test() { PUBLIC=/home/public/test/TaskMind; PUBREL=/home/public/test/.taskmind; PROTECTED=/home/protected/taskmind-test; AUTH=/home/protected/lib-test; DATA=/home/protected/taskmind-data-test; KEEP=5; }
extract_heredoc() { sed -n "/^$1() { cat <<'EOF'\$/,/^EOF\$/p" "$DEPLOY_SRC" | sed '1d;$d'; }
remote_direct() {   # remote_direct <phase>
  ( eval "$(sed -n '/^remote_header() {/,/^}/p' "$DEPLOY_SRC")"
    { remote_header; extract_heredoc remote_lib; extract_heredoc "phase_$1"; } \
      | sed -e "s#/home/#$R/home/#g" -e "s#^WEB_GROUP='web'#WEB_GROUP='$SHIM_WEB_GROUP'#" | ${REMOTE_SH:-sh} -s )
}

deploy() { RC=0; ( cd "$REPO" && PATH="$SHIMS:$PATH" "${DEPLOY_SH:-sh}" tools/deploy.sh "$@" ) > "$CASE/out" 2>&1 || RC=$?; }
mark() { MARK=$(wc -l < "$LOG/calls" | tr -d ' '); }
since() { tail -n +$((MARK + 1)) "$LOG/calls"; }
since_has() { since | grep -q "$1"; }
calls_seq() { awk -F'\t' '$1=="ssh" { print "ssh:" $2; next } $1!="npm" { print $1 }' | tr '\n' ' ' | sed 's/ $//'; }
tree_sum() { ( cd "$1" && { find . | sort; find . -type f -exec cksum {} + | sort; } | cksum ); }
snapshot() { ( cd "$CASE" && { find repo remote | sort; find repo remote -type f -exec cksum {} + | sort; } | cksum ); }
count_dirs() { ls "$1" | wc -l | tr -d ' '; }
not() { ! "$@"; }
out_has() { grep -q -- "$1" "$CASE/out"; }
out_fixed() { grep -qF -- "$1" "$CASE/out"; }
no_network_calls() { ! grep -qE '^(ssh|rsync|curl)' "$LOG/calls"; }
VERIFY_N=5   # a verification is five requests: page, api.php (more while it lags), release.txt, build.txt, the direct /.taskmind/ URL

check() {   # check "description" command...   (passes when the command succeeds)
  _d=$1; shift
  if "$@" >/dev/null 2>&1; then echo P >> "$TMP/results"
  else
    echo F >> "$TMP/results"
    printf 'not ok - %s  [%s]\n' "$_d" "${CURRENT_TEST:-}" >&2
    # the deploy cases' output, or a build-platforms case's (those set P, not CASE)
    if [ -n "${CASE:-}" ] && [ -f "$CASE/out" ]; then sed 's/^/    | /' "$CASE/out" | tail -n 8 >&2
    elif [ -n "${P:-}" ] && [ -f "$P/out" ]; then sed 's/^/    | /' "$P/out" | tail -n 8 >&2; fi
  fi
}

# ---- Tests ---------------------------------------------------------------------------------------------------
t_dry_run() {
  new_case; with_data
  before=$(snapshot)
  deploy --dry-run; after=$(snapshot)
  check 'dry-run exits 0' test "$RC" -eq 0
  check 'dry-run shows the protected lib release directory' out_has '/home/protected/taskmind-test/releases/'
  check 'dry-run shows the public release store' out_has '/home/public/test/.taskmind'
  check 'dry-run shows the relative public link' out_has '/home/public/test/TaskMind -> .taskmind/<stamp>'
  check 'dry-run shows the test URL' out_has 'https://test.seancheren.com/TaskMind/'
  check 'dry-run mentions the deploy lock' out_has '.deploy.lock'
  check 'dry-run calls no tool at all' test ! -s "$LOG/calls"
  check 'dry-run changes no file' test "$before" = "$after"
  rm -rf "$REPO/dist"; deploy --dry-run
  check 'dry-run without dist/ exits 0' test "$RC" -eq 0
  deploy --prod --yes-prod --dry-run
  check 'prod dry-run shows prod paths' out_has '/home/protected/taskmind/releases/'
  check 'prod dry-run shows the prod public store' out_has '/home/public/.taskmind'
  check 'prod dry-run shows the prod URL' out_has 'https://seancheren.com/TaskMind/'
  check 'prod dry-run calls no tool' test ! -s "$LOG/calls"
  deploy --rollback --dry-run
  check 'rollback dry-run exits 0 and calls no tool' test "$RC" -eq 0 -a ! -s "$LOG/calls"
  new_case; echo '<?php' > "$REPO/dist/protected/lib/config.php"; deploy --dry-run
  check 'dry-run audits an existing dist/' test "$RC" -ne 0
  new_case; mv "$REPO/dist" "$REPO/real-dist"; ln -s real-dist "$REPO/dist"; deploy --dry-run
  check 'dry-run refuses a dist that is a symlink' test "$RC" -ne 0
}

t_missing_host() {
  new_case; TASKMIND_DEPLOY_HOST=; export TASKMIND_DEPLOY_HOST
  deploy
  check 'missing host fails' test "$RC" -ne 0
  check 'message names TASKMIND_DEPLOY_HOST' out_has TASKMIND_DEPLOY_HOST
  check 'missing host runs nothing (not even npm)' test ! -s "$LOG/calls"
  TASKMIND_DEPLOY_HOST='-oProxyCommand=touch-x'; export TASKMIND_DEPLOY_HOST
  deploy
  check 'option-like host is refused' test "$RC" -ne 0
  check 'option-like host runs nothing' test ! -s "$LOG/calls"
  for h in 'login@host:22' 'login@host::module' 'a@b:' 'login@-Jevil.example' 'a@b@c'; do
    TASKMIND_DEPLOY_HOST=$h; export TASKMIND_DEPLOY_HOST
    deploy
    check "host '$h' is refused" test "$RC" -ne 0
    check "host '$h' runs nothing" test ! -s "$LOG/calls"
  done
  TASKMIND_DEPLOY_HOST=ssh-alias; export TASKMIND_DEPLOY_HOST
  deploy
  check 'an ssh config alias without @ is still accepted' test "$RC" -eq 0
}

t_host_sources() {
  new_case; TASKMIND_DEPLOY_HOST=; export TASKMIND_DEPLOY_HOST
  printf 'TASKMIND_DEPLOY_HOST="conf-user@ssh.invalid"\n' > "$REPO/deploy.conf"
  deploy
  check 'host from deploy.conf deploys' test "$RC" -eq 0
  check 'deploy.conf host is the ssh target' grep -q 'conf-user@ssh.invalid sh -s' "$LOG/calls"
  new_case; TASKMIND_DEPLOY_HOST=env-user@ssh.invalid; export TASKMIND_DEPLOY_HOST
  printf 'TASKMIND_DEPLOY_HOST="conf-user@ssh.invalid"\n' > "$REPO/deploy.conf"
  deploy
  check 'environment host wins over deploy.conf' grep -q 'env-user@ssh.invalid sh -s' "$LOG/calls"
  check 'deploy.conf host is not used when the environment sets one' not grep -q 'conf-user' "$LOG/calls"
}

t_prod_consent() {
  new_case
  deploy --prod
  check '--prod without --yes-prod fails' test "$RC" -ne 0
  check 'message asks for --yes-prod' out_has 'yes-prod'
  check '--prod alone runs nothing' test ! -s "$LOG/calls"
  deploy --prod --rollback
  check '--prod --rollback without --yes-prod fails' test "$RC" -ne 0
  check 'rollback without consent runs nothing' test ! -s "$LOG/calls"
  deploy --bogus
  check 'unknown flag fails' test "$RC" -ne 0
  check 'production host paths untouched' test ! -e "$R/home/protected/taskmind"
}

t_payload_refused() {
  for rel in protected/lib/config.php protected/lib/config.local.php protected/lib/accounts.php protected/lib/passwords.php \
             protected/lib/Config.php protected/lib/ACCOUNTS.php protected/lib/Passwords.php public/TaskMind/assets/Accounts.js \
             public/TaskMind/assets/DATA/x.js public/TaskMind/.ENV \
             public/TaskMind/assets/accounts.js public/TaskMind/assets/passwords.css public/TaskMind/assets/data/app.js \
             public/TaskMind/assets/taskmind-data/x.js protected/lib/data/x.php public/TaskMind/config.php \
             public/TaskMind/accounts.json public/TaskMind/workspace.enc public/TaskMind/.key public/TaskMind/.env \
             public/TaskMind/.env.production public/TaskMind/.workspace.lock public/TaskMind/assets/app.js.map \
             public/TaskMind/deploy.conf protected/lib/secret.pem public/TaskMind/notes.txt public/TaskMind/assets/x.php \
             protected/lib/sub/extra.php protected/other/x.php public/other/index.php stray.txt protected/lib/notes.txt protected/lib/sub/store-version.txt; do
    new_case
    mkdir -p "$(dirname "$REPO/dist/$rel")"; echo '<?php // x' > "$REPO/dist/$rel"
    deploy
    check "payload with $rel is refused" test "$RC" -ne 0
    check "the offending path dist/$rel is named" out_has "dist/$rel"
    check "refusal for $rel happens before any ssh, rsync or curl" no_network_calls
  done
  new_case; ln -s /etc/hosts "$REPO/dist/public/TaskMind/assets/link.js"; deploy
  check 'a symlink in the payload is refused' test "$RC" -ne 0
  check 'the symlink path is named' out_has 'assets/link.js'
  check 'symlink refusal happens before any network tool' no_network_calls
  new_case; mv "$REPO/dist" "$REPO/real-dist"; echo '<?php' > "$REPO/real-dist/protected/lib/config.php"; ln -s real-dist "$REPO/dist"; deploy
  check 'a dist that is itself a symlink is refused' test "$RC" -ne 0
  check 'the dist symlink refusal says so' out_has 'not a symlink'
  check 'dist symlink refusal happens before any network tool' no_network_calls
  if [ "$(id -u)" != 0 ]; then
    new_case; chmod 311 "$REPO/dist/protected/lib"; deploy; chmod 700 "$REPO/dist/protected/lib"
    check 'a dist entry that cannot be listed refuses the deploy' test "$RC" -ne 0
    check 'the unlistable payload is reported as such' out_has 'could not list'
    check 'unlistable payload refusal happens before any network tool' no_network_calls
  fi
  for rel in public/TaskMind/assets/app.js public/TaskMind/assets/app.css public/TaskMind/.htaccess public/TaskMind/index.php \
             protected/lib/bootstrap.php protected/lib/taskmind.php protected/lib/atomic.php protected/lib/limits.php protected/lib/store-version.txt; do
    new_case; rm "$REPO/dist/$rel"; deploy
    check "a payload without $rel is refused" test "$RC" -ne 0
    check "the missing file $rel is named" out_has "missing dist/$rel"
    check "missing-file refusal for $rel happens before any network tool" no_network_calls
  done
  new_case
  for f in error store login_limit staging; do echo '<?php // fixture' > "$REPO/dist/protected/lib/$f.php"; done
  deploy
  check 'new flat lib files (the UX build adds several) are accepted' test "$RC" -eq 0
  check 'they reach the release' test -f "$T/releases/$(live)/lib/error.php" -a -f "$T/releases/$(live)/lib/store.php" -a -f "$T/releases/$(live)/lib/limits.php"
  check 'they are linted on the host (6 + 4 PHP files)' test "$(wc -l < "$LOG/lint" | tr -d ' ')" -eq 10
  new_case; deploy
  check 'a clean payload (with .htaccess) is accepted' test "$RC" -eq 0
  # store-version.txt must be the store version the shipped lib reads and writes (limits.php, generated from model.ts)
  new_case; printf '4\n' > "$REPO/dist/protected/lib/store-version.txt"; deploy
  check 'a store-version.txt that disagrees with the shipped limits.php is refused' test "$RC" -ne 0
  check 'the message names both numbers' out_has "store-version.txt says '4' but the shipped limits.php reads and writes store version '3'"
  check 'it is refused before any network tool' no_network_calls
  new_case; printf 'v3\n' > "$REPO/dist/protected/lib/store-version.txt"; deploy
  check 'a store-version.txt that is not just a number is refused' test "$RC" -ne 0 -a "$(grep -c '^ssh' "$LOG/calls")" -eq 0
  check 'and says so' out_has 'must hold just the store version number'
  new_case; sed 's#storeVersion#storeVersioX#' "$REPO/dist/protected/lib/limits.php" > "$CASE/l" && cat "$CASE/l" > "$REPO/dist/protected/lib/limits.php"; deploy
  check 'a limits.php without a storeVersion is refused too (nothing to agree with)' test "$RC" -ne 0 -a "$(grep -c '^ssh' "$LOG/calls")" -eq 0
  new_case; set_store 4; deploy
  check 'a store-version.txt that agrees with limits.php is accepted at any version' test "$RC" -eq 0 -a "$(cat "$T/releases/$(live)/lib/store-version.txt")" = 4
}

t_deploy_test() {
  new_case; with_data
  data_before=$(tree_sum "$R/home/protected/taskmind-data-test"); auth_before=$(tree_sum "$R/home/protected/lib-test"); prodlib_before=$(tree_sum "$R/home/protected/lib")
  deploy
  cur=$(live)
  check 'default deploy succeeds' test "$RC" -eq 0
  check 'phases run in order: prepare, upload x2, lint, flip, verify (5 requests), prune, unlock' test "$(calls_seq < "$LOG/calls")" = 'ssh:prepare rsync rsync ssh:verify ssh:activate curl curl curl curl curl ssh:prune ssh:unlock'
  check 'the four gates run before the first ssh' awk -F'\t' '$1=="npm"{n=NR} $1=="ssh"&&!s{s=NR} END{exit !(n && s && n<s)}' "$LOG/calls"
  check 'gates are check:core, test, build, test:e2e' test "$(grep '^npm' "$LOG/calls" | cut -f3 | tr '\n' '|')" = 'run check:core|test|run build|run test:e2e|'
  check 'the public link is a symlink with the RELATIVE target .taskmind/<stamp>' test -L "$PL" -a "$(readlink "$PL")" = ".taskmind/$cur"
  check 'the stamp has the <14 digits>-<pid> shape the entrypoints bind to' sh -c 'case "$1" in 2026010100[0-9][0-9][0-9][0-9]-[0-9]*) exit 0 ;; *) exit 1 ;; esac' _ "$cur"
  check 'the page entry point is served through the link from the public release' test -f "$PL/index.php" -a -f "$PR/$cur/index.php"
  check 'api.php, icon.svg and assets are in the public release' test -f "$PR/$cur/api.php" -a -f "$PR/$cur/icon.svg" -a -f "$PR/$cur/assets/app.js"
  check '.htaccess is shipped' test -f "$PL/.htaccess"
  check 'lib lives in the protected release, not in the public one' test -f "$T/releases/$cur/lib/bootstrap.php" -a ! -e "$PR/$cur/lib" -a ! -e "$T/releases/$cur/public"
  check 'the host stamps the release with its own name (release.txt)' test "$(cat "$PL/release.txt")" = "$cur"
  check 'release.txt is not part of the audited payload' test ! -e "$REPO/dist/public/TaskMind/release.txt"
  check 'the release store refuses direct URLs: .htaccess is exactly Require all denied' test "$(cat "$PR/.htaccess")" = 'Require all denied'
  check 'that .htaccess is not part of the payload' test ! -e "$REPO/dist/public/.taskmind"
  check 'there is no current pointer in protected any more' test ! -e "$T/current" -a ! -L "$T/current"
  check 'the only symlink on the whole host is the public link' test "$(find "$R/home" -type l)" = "$PL"
  check 'no symlink exists under /home/protected (Apache refuses links into it)' test -z "$(find "$R/home/protected" -type l)"
  check 'no previous release on a first install' test ! -e "$T/previous"
  check 'the host PHP version is printed' out_has 'host php: PHP 8.2.99'
  check 'the verification fetched release.txt' grep -q 'TaskMind/release.txt' "$LOG/calls"
  check 'api.php was asked for its release header' grep -q -- 'api.php' "$LOG/calls"
  check 'the direct /.taskmind/<stamp>/index.php URL was checked on the page origin' grep -qF "https://test.seancheren.com/.taskmind/$cur/index.php" "$LOG/calls"
  check 'every PHP file was linted on the host' test "$(wc -l < "$LOG/lint" | tr -d ' ')" -eq 6
  check 'all six went through ONE php -l process' test "$(cat "$LOG/php-calls")" = 6
  check 'the host says how it linted' out_has 'lint clean (in one php process)'
  check 'lib/store-version.txt reaches the release (the rollback checks read it)' test "$(cat "$T/releases/$cur/lib/store-version.txt")" = 3
  check 'rsync is asked to open what it sends (--chmod), in both transfers' test "$(grep -c -- '--chmod=Dgo+rx,Fgo+r' "$LOG/calls")" -eq 2
  check 'nothing had to be opened by the host when rsync honored --chmod' not out_has 'opening'
  check 'every phase prints its start time' test "$(grep -c '^==> \[' "$CASE/out")" -ge 6
  check 'and how long it took, once each' test "$(grep -c '^    took [0-9][0-9]* s: ' "$CASE/out")" = "$(grep -c '^==> \[' "$CASE/out")"
  check 'the run ends with its total' out_has '^Deployed in [0-9][0-9]* s\.'
  check 'every ssh call is exactly: -o BatchMode=yes HOST sh -s' awk -F'\t' '$1=="ssh" && $3!="-o BatchMode=yes taskmind-test@ssh.invalid sh -s" {bad=1} END{exit bad}' "$LOG/calls"
  check 'rsync writes only into the two new release directories' awk -F'\t' '$1=="rsync" && $3 !~ /taskmind-test@ssh.invalid:\/home\/(public\/test\/\.taskmind\/[0-9-]+\/|protected\/taskmind-test\/releases\/[0-9-]+\/lib\/)$/ {bad=1} END{exit bad}' "$LOG/calls"
  check 'no rsync destination is the public link or a protected current/public' awk -F'\t' '$1=="rsync" { n=split($3, a, " "); d=a[n]; if (d ~ /current\/public/ || d ~ /\/TaskMind\/?$/) bad=1 } END{exit bad}' "$LOG/calls"
  check 'rsync never uses --delete' not grep -q -- '--delete' "$LOG/calls"
  check 'rsync excludes account/config names as a second guard' grep -q -- "--exclude=config\*.php" "$LOG/calls"
  check 'curl touches only the test URL (its page or the direct release URL)' awk -F'\t' '$1=="curl" && $3 !~ /https:\/\/test.seancheren.com\/(TaskMind|\.taskmind)\// {bad=1} END{exit bad}' "$LOG/calls"
  check 'no one-second wait was needed when the release answers at once' test "$(sleeps)" -eq 0
  check 'data directory is untouched' test "$data_before" = "$(tree_sum "$R/home/protected/taskmind-data-test")"
  check 'the site auth library is untouched' test "$auth_before" = "$(tree_sum "$R/home/protected/lib-test")"
  check 'the production auth library is untouched' test "$prodlib_before" = "$(tree_sum "$R/home/protected/lib")"
  check 'no production path was created' test ! -e "$R/home/protected/taskmind" -a ! -e "$R/home/public/TaskMind" -a ! -e "$R/home/public/.taskmind"
  check 'no temporary link or file is left behind' test -z "$(find "$T" "$PB" -name '*.new.*')"
  check 'the deploy lock is released' test ! -e "$T/.deploy.lock"
  # The sources are mode 600/700 (a restrictive Mac checkout, kept by the shim like rsync -p): the host must open them up.
  check 'the sandbox sources really were restrictive' test -z "$(find "$REPO/dist" -type f -perm -044)"
  check 'release files are world-readable' test -z "$(find "$T/releases" "$PR" -type f ! -perm -004)"
  check 'release directories are world-searchable' test -z "$(find "$T/releases" "$PR" -type d ! -perm -005)"
  check 'the host is left with exactly one release in each tree' test "$(count_dirs "$PR")" -eq 1 -a "$(count_dirs "$T/releases")" -eq 1
}

t_data_dir() {
  new_case; rm -rf "$R/home/protected/taskmind-data-test"
  deploy
  d=$R/home/protected/taskmind-data-test
  check 'a missing data directory fails the deploy' test "$RC" -ne 0
  check 'the message says the directory does not exist' out_has "taskmind-data-test does not exist"
  check 'the message carries the exact provisioning commands' out_fixed "mkdir -p $d && chgrp $SHIM_WEB_GROUP $d && chmod 2770 $d"
  check 'nothing is uploaded' not grep -q '^rsync' "$LOG/calls"
  check 'the data directory is not created by the deploy' test ! -e "$d"
  check 'no release directory was created' test ! -e "$T/releases"
  check 'nothing public was created either' test ! -e "$PR" -a ! -L "$PL"
  new_case; chmod 2750 "$R/home/protected/taskmind-data-test"
  deploy
  check 'a data directory the group cannot write fails the deploy' test "$RC" -ne 0
  check 'the message says the group cannot write' out_has 'cannot write'
  check 'the exact commands are given for it too' out_fixed "chmod 2770 $R/home/protected/taskmind-data-test"
  check 'a read-only data directory uploads nothing' not grep -q '^rsync' "$LOG/calls"
  new_case; SHIM_WEB_GROUP=no-such-group; export SHIM_WEB_GROUP
  deploy
  check 'a data directory of the wrong group fails the deploy' test "$RC" -ne 0
  check 'the message names the group' out_has 'does not belong to group no-such-group'
  new_case; rm -rf "$R/home/protected/taskmind-data"
  deploy --prod --yes-prod
  check 'production fails the same way without its data directory' test "$RC" -ne 0
  check 'the production message carries the production path' out_fixed "mkdir -p $R/home/protected/taskmind-data &&"
  check 'production uploads nothing' not grep -q '^rsync' "$LOG/calls"
  new_case; before=$(tree_sum "$R/home/protected/taskmind-data-test")
  deploy
  check 'a provisioned data directory deploys' test "$RC" -eq 0
  check 'the provisioned data directory is not modified' test "$before" = "$(tree_sum "$R/home/protected/taskmind-data-test")"
}

t_protected_perms() {
  # the web user must be able to search the directories above the releases (lib is read through them) and the release store
  new_case; mkdir -p "$T/releases" "$PR"; chmod 700 "$T" "$T/releases" "$PR"
  deploy
  check 'a deploy onto restrictive directories succeeds' test "$RC" -eq 0
  check 'the protected directory is opened up for the web user' test -z "$(find "$T" -maxdepth 1 -type d ! -perm -005)"
  check 'the releases directory is opened up for the web user' test -z "$(find "$T/releases" -maxdepth 0 -type d ! -perm -005)"
  check 'the public release store is opened up for the web server' test -z "$(find "$PR" -maxdepth 0 -type d ! -perm -005)"
}

t_php_host() {
  new_case; SHIM_PHP_MISSING=1; export SHIM_PHP_MISSING
  deploy
  check 'a host without php fails the pre-checks' test "$RC" -ne 0
  check 'the message says php is not available' out_has 'php is not available'
  check 'nothing is uploaded' not grep -q '^rsync' "$LOG/calls"
  check 'no release directory was created' test ! -e "$T/releases" -a ! -e "$PR" -a ! -L "$PL"
}

t_prod() {
  new_case; echo ciphertext > "$R/home/protected/taskmind-data/workspace.enc"; pdata=$(tree_sum "$R/home/protected/taskmind-data")
  deploy --prod --yes-prod
  cur=$(readlink "$R/home/public/TaskMind" | sed 's#^\.taskmind/##')
  check 'prod deploy succeeds' test "$RC" -eq 0
  check 'prod public path is the relative symlink into its own .taskmind' test -L "$R/home/public/TaskMind" -a "$(readlink "$R/home/public/TaskMind")" = ".taskmind/$cur" -a -f "$R/home/public/.taskmind/$cur/index.php"
  check 'prod lib lives under /home/protected/taskmind/releases/<stamp>/lib' test -f "$R/home/protected/taskmind/releases/$cur/lib/bootstrap.php"
  check 'prod has no current pointer' test ! -e "$R/home/protected/taskmind/current"
  check 'prod release store is denied' test "$(cat "$R/home/public/.taskmind/.htaccess")" = 'Require all denied'
  check 'prod verifies the prod URL only' awk -F'\t' '$1=="curl" && $3 !~ /https:\/\/seancheren.com\/(TaskMind|\.taskmind)\// {bad=1} END{exit bad}' "$LOG/calls"
  check 'prod serves its own release stamp' test "$(cat "$R/home/public/TaskMind/release.txt")" = "$cur"
  check 'prod deploy leaves the test instance alone' test ! -e "$R/home/protected/taskmind-test" -a ! -e "$R/home/public/test/TaskMind" -a ! -e "$R/home/public/test/.taskmind"
  check 'prod data directory is untouched' test "$pdata" = "$(tree_sum "$R/home/protected/taskmind-data")"
  check 'the prod lock is released' test ! -e "$R/home/protected/taskmind/.deploy.lock"
}

t_rollback() {
  new_case; set_version 9.9.8; deploy; first=$(live)
  set_version 9.9.9; deploy; second=$(live)
  check 'two deploys succeed' test "$RC" -eq 0 -a -n "$first" -a "$first" != "$second"
  check 'previous names the first release' test "$(prev)" = "$first"
  check 'previous is a plain file written by a rename, not a link' test -f "$T/previous" -a ! -L "$T/previous" -a -z "$(find "$T" -maxdepth 1 -name 'previous.new*')"
  check 'the flip replaced the link; nothing was nested into the old release' test -z "$(find "$PR" "$PB" -name '*.new.*')" -a "$(ls "$PR/$first" | tr '\n' ' ')" = 'api.php assets build.txt icon.svg index.php release.txt '
  check 'both releases are kept in both trees' test "$(count_dirs "$T/releases")" -eq 2 -a "$(count_dirs "$PR")" -eq 2
  mark; deploy --rollback
  check '--rollback succeeds' test "$RC" -eq 0
  check '--rollback re-points the public link to the previous release' test "$(live)" = "$first" -a "$(readlink "$PL")" = ".taskmind/$first"
  check '--rollback keeps the rolled-back release as previous' test "$(prev)" = "$second"
  check '--rollback verifies the OLD version, not package.json' out_has 'Verified .*(9.9.8'
  check '--rollback verifies the old release by ITS stamp' out_has "release $first)"
  check '--rollback is lock, rollback, verification (5 requests), unlock' test "$(since | calls_seq)" = 'ssh:lock ssh:rollback curl curl curl curl curl ssh:unlock'
  check '--rollback checks the direct URL of the old release' since_has "https://test.seancheren.com/.taskmind/$first/index.php"
  check '--rollback runs no gate, build or upload' not since_has 'npm'
  check 'the public path still resolves after rollback' test -f "$PL/index.php" -a "$(cat "$PL/release.txt")" = "$first"
  check 'the rollback lock is released' test ! -e "$T/.deploy.lock"
  deploy --rollback
  check 'a second --rollback goes forward again' test "$RC" -eq 0 -a "$(live)" = "$second"
  new_case; deploy --rollback
  check '--rollback with nothing deployed fails' test "$RC" -ne 0
  check '--rollback with nothing deployed says there is nothing to roll back' out_has 'nothing to roll back'
  check '--rollback with nothing deployed creates nothing' test ! -L "$PL" -a ! -e "$T/releases" -a ! -e "$PR"
  new_case; deploy; first=$(live); deploy --rollback
  check '--rollback with no previous release fails' test "$RC" -ne 0
  check '--rollback with no previous release leaves the link alone' test "$(live)" = "$first"
  check '--rollback can never remove the only release' test -f "$PR/$first/index.php" -a -f "$T/releases/$first/lib/bootstrap.php" -a -f "$PL/index.php"
  # A previous release made without release.txt is verified by its api header and build.txt alone.
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9; deploy
  rm -f "${PR:?}/${first:?}/release.txt"
  mark; deploy --rollback
  check 'an unstamped previous release rolls back' test "$RC" -eq 0 -a "$(live)" = "$first"
  check 'it is verified without release.txt (four requests)' test "$(since | calls_seq)" = 'ssh:lock ssh:rollback curl curl curl curl ssh:unlock'
  # A previous release that cannot be verified is refused BEFORE anything is switched, and the message says so truthfully.
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9; deploy; second=$(live)
  rm -f "${PR:?}/${first:?}/build.txt"
  mark; deploy --rollback
  check 'a previous release without build.txt is refused' test "$RC" -ne 0
  check 'the refusal leaves the link alone' test "$(live)" = "$second"
  check 'the refusal leaves previous alone' test "$(prev)" = "$first"
  check 'the message says the live release is unchanged' out_has 'live release is unchanged'
  check 'nothing is verified after a refusal' not since_has '^curl'
  # the rollback target itself must be sane
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9; deploy; second=$(live)
  printf '%s\n' "$second" > "$T/previous"
  deploy --rollback
  check 'a previous that names the live release is refused' test "$RC" -ne 0 -a "$(live)" = "$second"
  check 'it says there is nothing to roll back to' out_has 'nothing to roll back to'
  printf '%s\n' "$first" > "$T/previous"; rm -rf "${T:?}/releases/${first:?}/lib"
  deploy --rollback
  check 'an incomplete previous release (lib gone) is refused' test "$RC" -ne 0 -a "$(live)" = "$second"
  check 'it says the previous release is incomplete or gone' out_has 'incomplete or gone'
  printf '../../etc\n' > "$T/previous"
  deploy --rollback
  check 'a previous that is not a release stamp records nothing' test "$RC" -ne 0 -a "$(live)" = "$second"
  check 'and the message says no previous release is recorded' out_has 'no previous release is recorded'
  printf '%s\n' "$first" > "$CASE/previous-elsewhere"; rm -f "${T:?}/previous"; ln -s "$CASE/previous-elsewhere" "$T/previous"
  deploy --rollback
  check '--rollback refuses a previous that is a symlink and changes nothing' test "$RC" -ne 0 -a "$(live)" = "$second" -a -L "$T/previous"
  check 'it says previous is not a plain file' out_has 'previous exists but is not a plain file'
}

t_activate_guards() {
  # the flip re-checks the auth library and the public path right before it happens
  new_case
  SHIM_BEFORE_PHASE=activate; SHIM_BEFORE_CMD="rm -f '$R/home/protected/lib-test/store.php'"; export SHIM_BEFORE_PHASE SHIM_BEFORE_CMD
  deploy
  check 'an auth dependency that vanishes before the flip aborts the activation' test "$RC" -ne 0 -a ! -L "$PL"
  check 'the missing file is named' out_has store.php
  new_case
  SHIM_BEFORE_PHASE=activate; SHIM_BEFORE_CMD="ln -s /tmp '$PL'"; export SHIM_BEFORE_PHASE SHIM_BEFORE_CMD
  deploy
  check 'a foreign symlink that appears at the public path before the flip aborts the activation' test "$RC" -ne 0
  check 'the foreign symlink is left alone' test "$(readlink "$PL")" = /tmp
  check 'it is the activation that refuses (not a later verification)' out_has 'activation did not complete'
  check 'nothing was verified' test "$(grep -c '^curl' "$LOG/calls")" -eq 0
  new_case
  SHIM_BEFORE_PHASE=activate; SHIM_BEFORE_CMD="mkdir '$PL' && echo hand-made > '$PL/index.php'"; export SHIM_BEFORE_PHASE SHIM_BEFORE_CMD
  deploy
  check 'a real directory that appears at the public path before the flip aborts the activation' test "$RC" -ne 0 -a ! -L "$PL" -a "$(cat "$PL/index.php")" = hand-made
  check 'and nothing was nested into it' test "$(ls "$PL" | tr '\n' ' ')" = 'index.php '
}

t_lint_failure() {
  for bad in lib/atomic.php lib/taskmind.php index.php; do
    new_case; deploy; first=$(live)
    case $bad in lib/*) f=$REPO/dist/protected/$bad ;; *) f=$REPO/dist/public/TaskMind/$bad ;; esac
    printf '<?php TASKMIND_SHIM_SYNTAX_ERROR\n' > "$f"
    mark; deploy
    check "a lint failure in $bad fails the deploy" test "$RC" -ne 0
    check "the bad file $bad is named" out_has "$bad"
    check "no flip after a lint failure in $bad" test "$(live)" = "$first"
    check "no activate script was sent after a lint failure in $bad" not since_has 'ssh.activate'
    check "no site verification after a lint failure in $bad" not since_has '^curl'
    check "the failed release is discarded in both trees ($bad)" test "$(count_dirs "$T/releases")" -eq 1 -a "$(count_dirs "$PR")" -eq 1
    check "no previous file appears ($bad)" test ! -e "$T/previous"
    check "the lock is released after a lint failure ($bad)" test ! -e "$T/.deploy.lock"
  done
}

t_lint_single() {
  # The host lints all its PHP files in ONE php -l process (PHP 8.3 takes several files). A php that refuses the second file, or
  # lints only the first and says nothing of the rest (before 8.3), falls back to a process per file, and still sees every file.
  new_case; deploy
  check 'a deploy lints all six files in one php process' test "$RC" -eq 0 -a "$(cat "$LOG/php-calls")" = 6
  check 'that is the only php -l process the host ran' test "$(wc -l < "$LOG/php-calls" | tr -d ' ')" -eq 1
  check 'the lint runs under nice' grep -q '^-n 10 php -l ' "$LOG/nice"
  check 'so does the walk over the release that checks its permissions' grep -q '^-n 10 find ' "$LOG/nice"
  new_case; SHIM_PHP_NO_MULTI=1; export SHIM_PHP_NO_MULTI
  deploy
  check 'a php that refuses several files falls back to one process per file and the release still goes out' test "$RC" -eq 0 -a -L "$PL"
  check 'one refused multi-file try, then six single-file processes' test "$(tr '\n' ' ' < "$LOG/php-calls")" = '6 1 1 1 1 1 1 '
  check 'every file was linted' test "$(wc -l < "$LOG/lint" | tr -d ' ')" -eq 6
  check 'the host says it went file by file' out_has 'lint clean (file by file)'
  new_case; SHIM_PHP_FIRST_ONLY=1; export SHIM_PHP_FIRST_ONLY
  deploy
  check 'a php that lints only the first file is not taken for a clean lint of all of them' test "$RC" -eq 0 -a "$(tr '\n' ' ' < "$LOG/php-calls")" = '6 1 1 1 1 1 1 '
  check 'the fallback linted every file (one from the first-only try, six on their own)' test "$(wc -l < "$LOG/lint" | tr -d ' ')" -eq 7
  new_case; SHIM_PHP_FIRST_ONLY=1; export SHIM_PHP_FIRST_ONLY
  printf '<?php TASKMIND_SHIM_SYNTAX_ERROR\n' > "$REPO/dist/protected/lib/taskmind.php"   # not the first file in the list
  deploy
  check 'under that php a syntax error in a later file is still caught' test "$RC" -ne 0 -a ! -L "$PL"
  check 'and the file is named' out_has 'PHP lint failed: .*taskmind.php'
  new_case; printf '<?php TASKMIND_SHIM_SYNTAX_ERROR\n' > "$REPO/dist/protected/lib/taskmind.php"
  deploy
  check 'a syntax error fails the one-process lint, and the per-file pass behind it names the file' test "$RC" -ne 0 -a ! -L "$PL" -a "$(head -n 1 "$LOG/php-calls")" = 6
  check 'the error text is shown' out_has 'PHP Parse error'
  check 'the named file is the bad one' out_has 'PHP lint failed: .*taskmind.php'
}

t_upload_modes() {
  # rsync --chmod opens what it sends (GNU rsync). macOS's own rsync (openrsync) accepts the option and ignores it: the host then
  # opens what is still closed, entry by entry, and never runs a blanket chmod -R over the release.
  new_case; SHIM_RSYNC_IGNORE_CHMOD=1; export SHIM_RSYNC_IGNORE_CHMOD
  deploy
  check 'a deploy through an rsync that ignores --chmod still succeeds' test "$RC" -eq 0
  check 'the host opened what the upload left closed, and said how many' out_has 'opening [0-9][0-9]* entries the upload left closed'
  check 'every release file is world-readable afterwards' test -z "$(find "$T/releases" "$PR" -type f ! -perm -004)"
  check 'every release directory is world-searchable afterwards' test -z "$(find "$T/releases" "$PR" -type d ! -perm -005)"
  check 'the sources were not touched' test -z "$(find "$REPO/dist" -type f -perm -044)"
  new_case; deploy
  check 'an rsync that honors --chmod leaves nothing for the host to open' test "$RC" -eq 0 -a -z "$(grep 'opening' "$CASE/out")"
}

t_store_version() {
  # A rollback never goes back to a release that cannot read the data. The server keeps the store version the data was last written
  # at in $DATA/workspace.version; every release ships lib/store-version.txt; the phase that re-points the link compares the two.
  _two() { new_case; set_version 9.9.8; set_store 3; deploy; first=$(live); set_version 9.9.9; set_store 4; deploy; second=$(live); }
  _two
  check 'two releases are deployed (store version 3, then 4)' test "$RC" -eq 0 -a "$first" != "$second" -a "$(cat "$T/releases/$first/lib/store-version.txt")" = 3 -a "$(cat "$T/releases/$second/lib/store-version.txt")" = 4
  mark; deploy --rollback
  check 'with no marker a rollback is allowed, as it always was' test "$RC" -eq 0 -a "$(live)" = "$first"
  deploy --rollback
  check 'and forward again' test "$RC" -eq 0 -a "$(live)" = "$second"
  data_marker 4
  mark; deploy --rollback
  check 'a rollback onto a release that reads store version 3 is refused when the data was written at 4' test "$RC" -ne 0 -a "$(live)" = "$second" -a "$(prev)" = "$first"
  check 'it names the release and both versions' out_has "release $first reads store version 3 but the data was written at store version 4"
  check 'it says the previous release cannot read the data and the live release is unchanged' out_has 'the previous release cannot read the data (see above); the live release is unchanged'
  check 'it is one round trip: lock, the rollback phase that reads the marker, unlock; nothing is verified' test "$(since | calls_seq)" = 'ssh:lock ssh:rollback ssh:unlock'
  check 'the deploy lock is released' test ! -e "$T/.deploy.lock"
  rollback_script=$(grep -l '^# taskmind-phase: rollback$' "$LOG"/script-* | tail -n 1)
  check 'only the rollback phase asks for the marker' test "$(grep -l '^marker=$(store_marker)' "$LOG"/script-* | sort -u | tr '\n' ' ')" = "$(grep -l '^# taskmind-phase: rollback$' "$LOG"/script-* | sort -u | tr '\n' ' ')"
  check 'no phase names the encrypted data file at all' not grep -l 'workspace\.enc' "$LOG"/script-*
  data_marker 3
  deploy --rollback
  check 'when the data was written at 3 a release reading 3 may go back' test "$RC" -eq 0 -a "$(live)" = "$first"
  deploy --rollback
  check 'and one reading 4 may go forward (a higher release than the marker is fine)' test "$RC" -eq 0 -a "$(live)" = "$second"
  data_marker 5
  deploy --rollback
  check 'a marker above every release refuses the move' test "$RC" -ne 0 -a "$(live)" = "$second"
  data_marker 3; rm -f "$T/releases/$first/lib/store-version.txt"
  deploy --rollback
  check 'a release without store-version.txt cannot be shown to read the data: refused' test "$RC" -ne 0 -a "$(live)" = "$second"
  check 'and the message says what is missing' out_has "release $first has no lib/store-version.txt"
  rm -f "$R/home/protected/taskmind-data-test/workspace.version"
  deploy --rollback
  check 'with no marker that same release is allowed (a store from before markers existed)' test "$RC" -eq 0 -a "$(live)" = "$first"
  # a marker that is there but cannot be read as a number refuses: nothing is known about the data
  for bad in abc 4x 12345678 -4; do
    _two; printf '%s\n' "$bad" > "$R/home/protected/taskmind-data-test/workspace.version"
    deploy --rollback
    check "a marker holding '$bad' refuses the rollback" test "$RC" -ne 0 -a "$(live)" = "$second"
    check "and says it holds no readable number ($bad)" out_has 'holds no readable store version number'
  done
  _two; : > "$R/home/protected/taskmind-data-test/workspace.version"
  deploy --rollback
  check 'an empty marker refuses the rollback' test "$RC" -ne 0 -a "$(live)" = "$second"
  if [ "$(id -u)" != 0 ]; then
    _two; data_marker 3; chmod 000 "$R/home/protected/taskmind-data-test/workspace.version"
    deploy --rollback; chmod 600 "$R/home/protected/taskmind-data-test/workspace.version"
    check 'a marker that exists but cannot be read refuses the rollback' test "$RC" -ne 0 -a "$(live)" = "$second"
    _two; data_marker 4; chmod 600 "$R/home/protected/taskmind-data-test"
    deploy --rollback; chmod 2770 "$R/home/protected/taskmind-data-test"
    check 'a data directory this login cannot search hides the marker: the check is skipped, loudly' test "$RC" -eq 0 -a "$(live)" = "$first"
    check 'the skipped check is said' out_has 'cannot search .*, so the data.s store version was not checked'
  fi
  # the automatic rollback after a failed verification obeys the same rule, and keeps the NEW release when it must
  new_case; set_version 9.9.8; set_store 3; deploy; first=$(live); set_version 9.9.9; set_store 4; data_marker 4
  SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  mark; deploy; second=$(live)
  check 'a release that verified badly is NOT rolled back onto one that cannot read the data' test "$RC" -ne 0 -a "$(live)" = "$second"
  check 'it says loudly that it is still live' out_has 'STILL LIVE'
  check 'and that it was not rolled back' out_has 'NOT rolled back'
  check 'and why (a release that can read the data beats one that cannot)' out_has 'verified badly but can read the data beats one that cannot read it at all'
  check 'it does not claim the previous release is serving' not out_has 'serving again'
  check 'previous still names the earlier release' test "$(prev)" = "$first"
  check 'no verification followed the refused rollback' test "$(since | calls_seq)" = 'ssh:prepare rsync rsync ssh:verify ssh:activate curl ssh:rollback ssh:unlock'
  check 'the lock is released' test ! -e "$T/.deploy.lock"
  new_case; set_version 9.9.8; set_store 3; deploy; first=$(live); set_version 9.9.9; set_store 4; data_marker 3
  SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  deploy
  check 'when the data is still at version 3 the automatic rollback goes ahead as before' test "$RC" -ne 0 -a "$(live)" = "$first"
  check 'and says the previous release is serving again' out_has 'serving again'
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  rm -f "$T/releases/$first/lib/store-version.txt"; data_marker 3
  SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  deploy
  check 'a release from before store-version.txt is not rolled back onto once the data has a marker' test "$RC" -ne 0 -a "$(live)" != "$first" -a "$(live)" != ''
  check 'the new release stays live and the message is loud' out_has 'STILL LIVE'
}

t_switch_after_lint() {
  new_case; deploy
  seq=$(calls_seq < "$LOG/calls")
  check 'lint (verify) is sent before the flip (activate)' sh -c 'case "$1" in *ssh:verify*ssh:activate*) exit 0 ;; *) exit 1 ;; esac' _ "$seq"
  check 'only the activate script holds the link flip' test "$(grep -l '^swap_link "\.taskmind/\$STAMP" "\$PUBLIC"' "$LOG"/script-* | wc -l | tr -d ' ')" -eq 1
  verify_script=$(grep -l '^# taskmind-phase: verify$' "$LOG"/script-*)
  check 'the verify script cannot switch anything' not grep -q 'swap_link "\.taskmind' "$verify_script"
  prepare_script=$(grep -l '^# taskmind-phase: prepare$' "$LOG"/script-*)
  check 'the prepare script cannot switch anything either' not grep -q 'swap_link "\.taskmind' "$prepare_script"
}

t_shared_login_page() {
  # Under the suite's shared login an app that is not held answers its page with a 303 to /account/?next=<its own path>.
  nx='%2FTaskMind%2F'
  for origin in '' 'https://test.seancheren.com'; do
    new_case; SHIM_CURL_PAGE_CODE=303; SHIM_CURL_PAGE_LOC="$origin/account/?next=$nx"; export SHIM_CURL_PAGE_CODE SHIM_CURL_PAGE_LOC
    deploy
    check "a 303 to ${origin:-the relative} /account/ with the app's own path verifies the release" test "$RC" -eq 0 -a -n "$(live)"
    check 'and says so' out_has 'Verified https://test.seancheren.com/TaskMind/'
  done
  for bad in 'https://evil.example/account/?next=%2FTaskMind%2F' 'https://test.seancheren.com.evil.example/account/?next=%2FTaskMind%2F' '/account/?next=%2FOther%2F' '/account/' '/account/?next=%2FTaskMind%2F&x=1' '/login/?next=%2FTaskMind%2F' '//evil.example/account/?next=%2FTaskMind%2F' ''; do
    new_case; set_version 9.9.8; SHIM_CURL_PAGE_CODE=; export SHIM_CURL_PAGE_CODE; deploy; first=$(live); set_version 9.9.9
    SHIM_CURL_PAGE_CODE=303; SHIM_CURL_PAGE_LOC=$bad; export SHIM_CURL_PAGE_CODE SHIM_CURL_PAGE_LOC
    deploy
    check "a 303 to '$bad' fails verification and rolls back" test "$RC" -ne 0 -a "$(live)" = "$first"
    check 'and the message says it was a redirect' out_has 'TaskMind page verification failed: HTTP 303'
  done
  for code in 302 301 307 500 404 401; do
    new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
    SHIM_CURL_PAGE_CODE=$code; SHIM_CURL_PAGE_LOC="/account/?next=$nx"; export SHIM_CURL_PAGE_CODE SHIM_CURL_PAGE_LOC
    deploy
    check "a $code (even with the right Location) fails verification and rolls back" test "$RC" -ne 0 -a "$(live)" = "$first"
    check "and the message names HTTP $code" out_has "TaskMind page verification failed: HTTP $code"
  done
}

t_verification_rolls_back() {
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  mark; deploy
  check 'failed page verification exits non-zero' test "$RC" -ne 0
  check 'the previous release is live again' test "$(live)" = "$first"
  check 'the sequence is flip, failed check, rollback, verify the old release, unlock' test "$(since | calls_seq)" = 'ssh:prepare rsync rsync ssh:verify ssh:activate curl ssh:rollback curl curl curl curl curl ssh:unlock'
  check 'the old release is verified with its own version' out_has 'Verified .*(9.9.8'
  check 'the message says it rolled back' out_has 'serving again'
  check 'nothing is pruned after a failed deploy' not since_has 'ssh.prune'
  check 'previous does not keep naming the release that failed' test ! -e "$T/previous"
  deploy --rollback
  check 'a later --rollback cannot re-activate the failed release' test "$RC" -ne 0 -a "$(live)" = "$first"
  new_case; set_version 9.9.7; deploy; a=$(live); set_version 9.9.8; deploy; b=$(live); set_version 9.9.9
  SHIM_CURL_FAIL_AT=$((2 * VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  deploy
  check 'a failed third deploy rolls back to the second' test "$RC" -ne 0 -a "$(live)" = "$b"
  check 'previous is restored to what it was before the failed deploy' test "$(prev)" = "$a"
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_API_ONCE=200; export SHIM_CURL_API_ONCE
  deploy
  check 'an API that answers 200 unauthenticated rolls back' test "$RC" -ne 0 -a "$(live)" = "$first"
  check 'a status other than 401 is final: it is not retried' test "$(sleeps)" -eq 0
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_BUILD_ALWAYS=0.0.0; export SHIM_CURL_BUILD_ALWAYS
  deploy
  check 'a served build.txt that stays different rolls back' test "$RC" -ne 0 -a "$(live)" = "$first"
  check 'it was asked again for the whole window (the rollback, which is served the same, has its own)' test "$(sleeps)" -eq 300
  check 'and says what it served' out_has "Served version '0.0.0' does not match the release '9.9.9' after 151 seconds"
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_BUILD_ONCE=0.0.0; export SHIM_CURL_BUILD_ONCE
  deploy
  check 'a build.txt that is stale once is asked again and the release verifies' test "$RC" -eq 0 -a "$(live)" != "$first" -a "$(sleeps)" -eq 1
  new_case; deploy
  SHIM_CURL_FAIL_AT="$((VERIFY_N + 1)) $((VERIFY_N + 2))"; export SHIM_CURL_FAIL_AT
  deploy
  check 'a rollback that also fails verification exits non-zero' test "$RC" -ne 0
  check 'it reports the failed rollback verification' out_has 'did not verify'
}

t_slow_answers() {
  # A verification request that gets no answer is asked again (a curl timeout has waited its 20 s), and all of a verification's
  # waits share ONE window of VERIFY_WINDOW (150) seconds; an answer that is wrong in a final way ends it at once.
  _setup() { new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9; }
  _miss() { _m=; for _i in "$@"; do _m="$_m $((VERIFY_N + _i))"; done; SHIM_CURL_TIMEOUT_AT=$_m; export SHIM_CURL_TIMEOUT_AT; }   # _miss 1 2: the 1st and 2nd request of the verification go unanswered
  _setup; _miss 2
  mark; deploy
  check 'an api.php that gives no answer once is asked again and the release verifies' test "$RC" -eq 0 -a "$(live)" != "$first"
  check 'it says it asked again, with the window used so far' out_has 'api.php request got no answer in 20 s; asking again (20 of 150 s used)'
  check 'no one-second wait is spent on it (curl already waited)' test "$(sleeps)" -eq 0
  _setup; _miss 1 2 3 4 5
  deploy
  check 'a spell of 100 s (5 unanswered requests, more than the old 80 s) verifies' test "$RC" -eq 0 -a "$(live)" != "$first"
  check 'the window used is reported (100 of 150 s)' out_has 'asking again (100 of 150 s used)'
  check 'and nothing else is waited' test "$(sleeps)" -eq 0
  _setup; _miss 1 2 3 5 6 7 8
  deploy
  check 'a spell of 140 s over the page and api.php (7 unanswered, one answered between) still verifies' test "$RC" -eq 0 -a "$(live)" != "$first"
  check 'the window is shared by the requests: 140 of 150 s used' out_has 'asking again (140 of 150 s used)'
  _setup; _miss 1 2 3 4 5 6 7 8
  deploy
  check 'a spell past the window (8 unanswered requests, 160 s) fails the check and rolls back' test "$RC" -ne 0 -a "$(live)" = "$first"
  check 'it says the page gave no response' out_has 'TaskMind page verification failed: no response'
  check 'it asked again 7 times, not 8' test "$(grep -c 'page request got no answer' "$CASE/out")" -eq 7
  _setup; _miss 5 6 7 8
  deploy
  check 'a spell at the last request (the direct URL, 4 unanswered after four good answers) verifies the same' test "$RC" -eq 0 -a "$(live)" != "$first"
  # the waits of different kinds draw on the same window: a stale api.php stamp is asked again once a second
  _setup; SHIM_CURL_LAG=130; _miss 1; export SHIM_CURL_LAG
  deploy
  check 'one unanswered request (20 s) plus a 130-poll lag (130 s) is exactly the window: verified' test "$RC" -eq 0 -a "$(live)" != "$first" -a "$(sleeps)" -eq 130
  _setup; SHIM_CURL_LAG=131; _miss 1; export SHIM_CURL_LAG
  deploy
  check 'one second more (a 131-poll lag) is past the window: the check fails and rolls back' test "$RC" -ne 0 -a "$(live)" = "$first"
  check 'it says what api.php answered as, after the 151 seconds counted' out_has "api.php answers as release '$first', not '[0-9-]*', after 151 seconds"
  # a connection that is reset comes back at once: charged, and waited, one second
  _setup; SHIM_CURL_RESET_AT="$((VERIFY_N + 1)) $((VERIFY_N + 2))"; export SHIM_CURL_RESET_AT
  deploy
  check 'two reset connections are asked again after a second each and the release verifies' test "$RC" -eq 0 -a "$(live)" != "$first" -a "$(sleeps)" -eq 2
  check 'they cost one second of the window each, not twenty' out_has 'asking again (2 of 150 s used)'
  # an answer that is wrong in a final way is never asked again
  _setup; SHIM_CURL_API_ONCE=200; export SHIM_CURL_API_ONCE
  deploy
  check 'an api.php answering 200 fails at once' test "$RC" -ne 0 -a "$(sleeps)" -eq 0 -a "$(live)" = "$first"
  _setup; SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_CURL_FAIL_AT
  deploy
  check 'a page answering 500 fails at once' test "$RC" -ne 0 -a "$(sleeps)" -eq 0 -a "$(live)" = "$first"
  # a first install is taken offline again when the window runs out
  new_case; SHIM_CURL_TIMEOUT_AT='1 2 3 4 5 6 7 8'; export SHIM_CURL_TIMEOUT_AT
  deploy
  check 'a first install whose page never answers is taken offline again' test "$RC" -ne 0 -a ! -L "$PL" -a ! -e "$PL"
  # release.txt and build.txt are static files that switch with the link: a host that is slow to serve the new ones is asked again
  _setup; SHIM_CURL_STATIC_LAG=3; export SHIM_CURL_STATIC_LAG
  mark; deploy
  check 'a release.txt and a build.txt that lag 3 fetches behind the flip still verify' test "$RC" -eq 0 -a "$(live)" != "$first"
  check 'each was fetched 4 times (3 stale, then the new one), one second between' test "$(since | grep -c 'release.txt')" -eq 4 -a "$(since | grep -c 'build.txt')" -eq 4 -a "$(sleeps)" -eq 6
  _setup; deploy; second=$(live); SHIM_CURL_STATIC_LAG=4; export SHIM_CURL_STATIC_LAG
  : > "$LOG/sleeps"; mark; deploy --rollback
  check 'a rollback onto a host that still serves the old static files verifies too' test "$RC" -eq 0 -a "$(live)" != "$second"
  check 'its release.txt was asked 5 times' test "$(since | grep -c 'release.txt')" -eq 5
  _setup; SHIM_CURL_STATIC_LAG=75; export SHIM_CURL_STATIC_LAG
  deploy
  check 'release.txt and build.txt each 75 behind (150 s together) is exactly the window: verified' test "$RC" -eq 0 -a "$(live)" != "$first" -a "$(sleeps)" -eq 150
  _setup; SHIM_CURL_STATIC_LAG=76; export SHIM_CURL_STATIC_LAG
  deploy
  check 'one more fetch each (152 s together) is past the window: the two files share it, so it fails and rolls back' test "$RC" -ne 0
  check 'it says the build.txt it got' out_has "Served version '9.9.8' does not match the release '9.9.9' after 151 seconds"
  _setup; SHIM_CURL_STATIC_LAG=151; export SHIM_CURL_STATIC_LAG
  deploy
  check 'a release.txt that lags past the whole window fails the deploy' test "$RC" -ne 0
  check 'it says which release it served' out_has "Served release '$first' is not release"
  check 'the rollback is verified inside its own window and fails the same way' out_has 'rollback did not verify either'
  check 'two windows were waited, one per verification' test "$(sleeps)" -eq 300
}

t_stamp_header() {
  # api.php must answer 401 AND name this release (X-TaskMind-Release). PHP can keep running the old entrypoint for a
  # while after the flip (its path cache lives up to 120 seconds), so a stale stamp is retried once a second inside the 150 s window.
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_LAG=3; export SHIM_CURL_LAG
  mark; deploy; second=$(live)
  check 'a release whose api.php lags behind the flip by 3 polls still verifies' test "$RC" -eq 0 -a "$second" != "$first"
  check 'api.php was polled 4 times (3 stale answers, then this release)' test "$(api_polls)" -eq 4
  check 'one second was waited between polls (3 waits)' test "$(sleeps)" -eq 3
  check 'the page, release.txt, build.txt and the direct URL were fetched once' test "$(since | calls_seq)" = 'ssh:prepare rsync rsync ssh:verify ssh:activate curl curl curl curl curl curl curl curl ssh:prune ssh:unlock'
  new_case; set_version 9.9.8; deploy; set_version 9.9.9
  SHIM_CURL_LAG=150; export SHIM_CURL_LAG
  mark; deploy
  check 'a lag of 150 polls is the whole window: 151 polls, 150 waits, verified' test "$RC" -eq 0 -a "$(api_polls)" -eq 151 -a "$(sleeps)" -eq 150
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_CURL_STUCK=$first; export SHIM_CURL_STUCK
  mark; deploy
  check 'a header that never names this release fails the deploy' test "$RC" -ne 0
  check 'the failure says what api.php answered as' out_has "api.php answers as release '$first'"
  check 'the window is 150 seconds: 151 polls for the new release, then one for the rollback check' test "$(api_polls)" -eq 152
  check 'and exactly 150 one-second waits' test "$(sleeps)" -eq 150
  check 'the previous release is live again and verified (its own header matched at once)' test "$(live)" = "$first" -a "$(since | calls_seq | tr ' ' '\n' | grep -c '^ssh:rollback')" -eq 1
  check 'the previous release stays on the host; the failed one is no longer previous' test ! -e "$T/previous" -a -d "$PR/$first"
  new_case; SHIM_CURL_STUCK=20250101000000-1; export SHIM_CURL_STUCK
  deploy
  check 'a first install whose api.php never names it is taken offline again' test "$RC" -ne 0 -a ! -L "$PL" -a ! -e "$PL"
  check 'it waited the whole window first' test "$(sleeps)" -eq 150
  check 'and the release was discarded' test "$(count_dirs "$PR")" -eq 0 -a "$(count_dirs "$T/releases")" -eq 0
  new_case; SHIM_CURL_NO_API_HEADER=1; export SHIM_CURL_NO_API_HEADER
  deploy
  check 'a missing X-TaskMind-Release header fails a first install' test "$RC" -ne 0 -a ! -L "$PL"
  check 'it says the answer had no release' out_has "api.php answers as release 'none'"
  new_case; deploy
  check 'a clean deploy never waits' test "$RC" -eq 0 -a "$(sleeps)" -eq 0
}

t_same_version() {
  # The version string does not change between runs, so only the host-written release.txt and the api header can tell the releases apart.
  new_case; deploy; first=$(live)
  deploy; second=$(live)
  check 'the same version deployed twice moves the link' test "$RC" -eq 0 -a "$first" != "$second"
  check 'the second run proves its own release by the stamp' out_has "release $second)"
  check 'the served stamp is the new release' test "$(cat "$PL/release.txt")" = "$second"
  check 'build.txt alone could not have told the two releases apart' test "$(cat "$PR/$first/build.txt")" = "$(cat "$PR/$second/build.txt")"
  # a rename that silently does nothing (the reviewer's repro)
  new_case; deploy; first=$(live)
  SHIM_MV_NOOP=TaskMind; export SHIM_MV_NOOP
  deploy
  check 'a link flip that has no effect fails the deploy' test "$RC" -ne 0
  check 'the activation itself notices' out_has 'activation did not complete'
  check 'nothing is verified after it' test "$(grep -c '^curl' "$LOG/calls")" -eq "$VERIFY_N"
  check 'the link still names the first release' test "$(live)" = "$first"
  # a host that keeps serving the old release after a clean activation: the api header shows it
  new_case; deploy; first=$(live)
  SHIM_AFTER_PHASE=activate; SHIM_AFTER_CMD="ln -sfh '.taskmind/$first' '$PL'"; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'serving the old release under an unchanged version fails the deploy' test "$RC" -ne 0
  check 'the api stamp header is what caught it' out_has 'api.php answers as release'
  check 'the link is left on the first release' test "$(live)" = "$first"
  # a host whose api.php names this release but whose static files are still the old ones: release.txt shows it
  new_case; deploy
  SHIM_AFTER_PHASE=activate; SHIM_AFTER_CMD="echo bogus > \"\$(ls -d '$PR'/[0-9]* | tail -n 1)/release.txt\""; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'a served release.txt that names another release fails the deploy' test "$RC" -ne 0
  check 'release.txt is what caught it' out_has 'is not release'
}

t_first_install() {
  new_case; SHIM_CURL_FAIL_AT=1; export SHIM_CURL_FAIL_AT
  SHIM_AFTER_PHASE=verify; SHIM_AFTER_CMD="[ -e '$PL' ] || [ -L '$PL' ] && touch '$CASE/link-early'"; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'a first install that fails verification exits non-zero' test "$RC" -ne 0
  check 'the app is reported as back to not installed' out_has "back to 'not installed'"
  check 'the public link is gone' test ! -L "$PL" -a ! -e "$PL"
  check 'the public link did not exist before the activate phase (it is created last)' test ! -e "$CASE/link-early"
  check 'both failed release directories are discarded' test "$(count_dirs "$T/releases")" -eq 0 -a "$(count_dirs "$PR")" -eq 0
  check 'the stable deny file stays' test "$(cat "$PR/.htaccess")" = 'Require all denied'
  check 'no previous file was written' test ! -e "$T/previous"
  check 'no rollback was attempted (nothing to roll back to)' not grep -q 'ssh.rollback' "$LOG/calls"
  check 'the sequence ends with unactivate, discard, unlock' test "$(calls_seq < "$LOG/calls")" = 'ssh:prepare rsync rsync ssh:verify ssh:activate curl ssh:unactivate ssh:discard ssh:unlock'
  check 'the lock is released' test ! -e "$T/.deploy.lock"
  unset SHIM_CURL_FAIL_AT SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'a retry after the unwind installs normally' test "$RC" -eq 0 -a -L "$PL" -a -f "$PL/index.php"
  new_case; SHIM_CURL_API_ONCE=200; export SHIM_CURL_API_ONCE
  deploy
  check 'an open API on a first install is not left public' test "$RC" -ne 0 -a ! -L "$PL" -a ! -e "$PL"
  # a link naming a release that is gone serves nothing: it counts as "not installed", is replaced, and goes again on a failed first install
  new_case; ln -s .taskmind/99990101000008-8 "$PL"
  SHIM_CURL_FAIL_AT=1; export SHIM_CURL_FAIL_AT
  deploy
  check 'a dangling link is treated as a first install' test "$RC" -ne 0 -a ! -L "$PL" -a ! -e "$PL"
  check 'and the failed release is discarded' test "$(count_dirs "$T/releases")" -eq 0 -a "$(count_dirs "$PR")" -eq 0
  unset SHIM_CURL_FAIL_AT
  deploy
  check 'a dangling link is replaced by a normal first install' test "$RC" -eq 0 -a -f "$PL/index.php"
  # the unwind removes the public link only when this run created it (the phase on its own)
  new_case; host_vars_test; mkdir -p "$PR/99990101000007-7"; ln -s .taskmind/99990101000007-7 "$PL"
  ( STAMP=99990101000007-7; PUBLIC_CREATED=0; remote_direct unactivate ) >/dev/null 2>&1; rc=$?
  check 'a link this run did not create is left in place' test "$rc" -eq 0 -a -L "$PL"
  ( STAMP=99990101000007-7; PUBLIC_CREATED=1; remote_direct unactivate ) >/dev/null 2>&1; rc=$?
  check 'a link this run created is removed' test "$rc" -eq 0 -a ! -L "$PL"
  ln -s .taskmind/99990101000006-6 "$PL"
  ( STAMP=99990101000007-7; PUBLIC_CREATED=1; remote_direct unactivate ) >/dev/null 2>&1; rc=$?
  check 'a link naming another release is never removed' test "$rc" -eq 11 -a -L "$PL"
  # another run took over between our flip and our verification: its release is not ours to take offline
  new_case; mkdir -p "$T/releases/99990101000009-9/lib" "$PR/99990101000009-9"
  SHIM_CURL_FAIL_AT=1; SHIM_AFTER_PHASE=activate; SHIM_AFTER_CMD="ln -sfh .taskmind/99990101000009-9 '$PL'"; export SHIM_CURL_FAIL_AT SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'the unwind refuses to remove another run'"'"'s link' test "$RC" -ne 0 -a "$(live)" = 99990101000009-9
  check 'and says the release could not be taken offline' out_has 'could not be taken offline'
}

t_cas() {
  # another run activates between our flip and our verification: our rollback must not undo ITS release
  new_case; set_version 9.9.8; deploy; first=$(live)
  mkdir -p "$T/releases/99990101000009-9/lib" "$PR/99990101000009-9"
  set_version 9.9.9
  SHIM_AFTER_PHASE=activate; SHIM_AFTER_CMD="ln -sfh .taskmind/99990101000009-9 '$PL'"; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'our verification fails (the other release is what is served)' test "$RC" -ne 0
  check 'the other run'"'"'s release stays live' test "$(live)" = 99990101000009-9
  check 'the message says our release is no longer live' out_has 'no longer the live release'
  check 'the refusal is the remote one' out_has 'refusing to roll back another run'
  check 'it does not claim the previous release is serving' not out_has 'serving again'
}

t_lock() {
  # held by another run
  new_case; mkdir -p "$T/.deploy.lock"; printf 'id=other-run\nwho=alex@othermac\n' > "$T/.deploy.lock/owner"
  deploy
  check 'a held lock stops the deploy' test "$RC" -ne 0
  check 'the holder is named' out_has 'alex@othermac'
  check 'the exact clear command is printed' out_fixed "ssh taskmind-test@ssh.invalid 'rm -rf /home/protected/taskmind-test/.deploy.lock'"
  check 'a fresh lock is not called stale' not out_has 'older than 30 minutes'
  check 'nothing is uploaded under a held lock' not grep -q '^rsync' "$LOG/calls"
  check 'no release directory is created under a held lock' test -z "$(ls "$T/releases")"
  check 'nothing public is created under a held lock' test ! -e "$PR" -a ! -L "$PL"
  check 'the other run'"'"'s lock is left alone' grep -q other-run "$T/.deploy.lock/owner"
  touch -t 202001010000 "$T/.deploy.lock"
  deploy
  check 'a lock older than 30 minutes fails the deploy' test "$RC" -ne 0
  check 'and is reported as stale' out_has 'older than 30 minutes'
  check 'a stale lock is never broken automatically' grep -q other-run "$T/.deploy.lock/owner"
  check 'the stale-lock message carries the exact clear command' out_fixed "ssh taskmind-test@ssh.invalid 'rm -rf /home/protected/taskmind-test/.deploy.lock'"
  check 'a stale lock uploads nothing' not grep -q '^rsync' "$LOG/calls"
  # a standalone rollback takes the same lock
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9; deploy; second=$(live)
  mkdir "$T/.deploy.lock"; printf 'id=other-run\nwho=alex@othermac\n' > "$T/.deploy.lock/owner"
  mark; deploy --rollback
  check 'a held lock stops --rollback' test "$RC" -ne 0 -a "$(live)" = "$second"
  check '--rollback under a held lock runs no rollback phase' not since_has 'ssh.rollback'
  check 'the other run'"'"'s lock survives --rollback' grep -q other-run "$T/.deploy.lock/owner"
  # always released: failure, success, upload failure
  new_case; SHIM_RSYNC_FAIL=1; export SHIM_RSYNC_FAIL
  deploy
  check 'the lock is released after an upload failure' test "$RC" -ne 0 -a ! -e "$T/.deploy.lock"
  # released on TERM (a killed run)
  # (dash, when there is one: bash runs its EXIT trap on a fatal signal by itself, dash does not, so only dash needs the TERM trap)
  new_case; SHIM_RSYNC_SLEEP=2; export SHIM_RSYNC_SLEEP
  sig_sh=${DEPLOY_SH:-sh}; ! command -v dash >/dev/null || sig_sh=dash
  ( cd "$REPO" && PATH="$SHIMS:$PATH" exec "$sig_sh" tools/deploy.sh ) > "$CASE/out" 2>&1 &
  pid=$!
  i=0; while ! grep -q '^rsync' "$LOG/calls" && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  check 'the lock is held while a run uploads' test -d "$T/.deploy.lock"
  kill -TERM "$pid"; rc=0; wait "$pid" || rc=$?
  check 'TERM ends the run with status 143' test "$rc" -eq 143
  check 'the lock is released after TERM' test ! -e "$T/.deploy.lock"
  check 'a killed run flipped nothing' test ! -L "$PL" -a ! -e "$PL"
}

t_phase_failures() {
  new_case; SHIM_SSH_FAIL_PHASE=prepare; export SHIM_SSH_FAIL_PHASE
  deploy
  check 'a failing prepare fails the deploy' test "$RC" -ne 0
  check 'a failing prepare uploads nothing' not grep -q '^rsync' "$LOG/calls"
  check 'a failing prepare leaves no release directory' test ! -e "$T/releases" -a ! -e "$PR"
  check 'a failing prepare says the live release is unchanged' out_has 'live release is unchanged'
  new_case; deploy; first=$(live)
  SHIM_SSH_FAIL_PHASE=activate; export SHIM_SSH_FAIL_PHASE
  mark; deploy
  check 'a failing activate fails the deploy' test "$RC" -ne 0
  check 'a failing activate says so' out_has 'activation did not complete'
  check 'a failing activate leaves the link alone' test "$(live)" = "$first"
  check 'a failing activate triggers no rollback' not since_has 'ssh.rollback'
  check 'a failing activate verifies nothing' not since_has '^curl'
  check 'a failing activate still releases the lock' test ! -e "$T/.deploy.lock"
  check 'and sends the unlock phase' since_has 'ssh.unlock'
  new_case; deploy
  SHIM_SSH_FAIL_PHASE=prune; export SHIM_SSH_FAIL_PHASE
  deploy; cur=$(live)
  check 'a failing prune does not fail a verified deploy' test "$RC" -eq 0
  check 'a failing prune only warns' out_has 'pruning old releases failed'
  check 'the verified release is live' test "$(cat "$PL/release.txt")" = "$cur"
  new_case; set_version 9.9.8; deploy; set_version 9.9.9; deploy; second=$(live)
  SHIM_SSH_FAIL_PHASE=rollback; export SHIM_SSH_FAIL_PHASE
  mark; deploy --rollback
  check 'a failing rollback phase fails --rollback' test "$RC" -ne 0
  check 'it admits the outcome is unknown' out_has 'outcome of the rollback is unknown'
  check 'the live release is as it was' test "$(live)" = "$second"
  check 'nothing is verified after it' not since_has '^curl'
  check 'the lock is released' test ! -e "$T/.deploy.lock"
  new_case; set_version 9.9.8; deploy; set_version 9.9.9
  SHIM_SSH_FAIL_PHASE=rollback; SHIM_CURL_FAIL_AT=$((VERIFY_N + 1)); export SHIM_SSH_FAIL_PHASE SHIM_CURL_FAIL_AT
  deploy
  check 'an unreachable host during the automatic rollback fails the deploy' test "$RC" -ne 0
  check 'it does not claim there is no previous release' not out_has 'no previous release'
  check 'it says the rollback could not be confirmed' out_has 'could not be confirmed'
  new_case; SHIM_SSH_FAIL_PHASE=lock; export SHIM_SSH_FAIL_PHASE
  deploy --rollback
  check 'a failing lock phase stops --rollback' test "$RC" -ne 0
  check 'it says the lock could not be taken' out_has 'could not take the deploy lock'
  new_case; SHIM_SSH_FAIL_PHASE=unlock; export SHIM_SSH_FAIL_PHASE
  deploy
  check 'a lock that cannot be released does not fail a verified deploy' test "$RC" -eq 0
  check 'it warns' out_has 'could not release the deploy lock'
  check 'the warning carries the clear command' out_fixed "rm -rf /home/protected/taskmind-test/.deploy.lock'"
}

t_path_guard() {
  new_case; host_vars_test; mkdir -p "$R/home/protected/taskmind-evil/releases/99990101000001-1"
  ( PROTECTED=/home/protected/taskmind-evil; STAMP=99990101000001-1; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'unexpected paths are refused with status 64' test "$rc" -eq 64
  check 'nothing under an unexpected path is touched' test -d "$R/home/protected/taskmind-evil/releases/99990101000001-1"
  mkdir -p "$T/releases/99990101000002-2" "$PR/99990101000002-2"
  ( PUBLIC=/home/public/TaskMind; STAMP=99990101000002-2; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'a mixed path set (prod public link, test everything else) is refused' test "$rc" -eq 64
  ( PUBREL=/home/public/.taskmind; STAMP=99990101000002-2; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'a mixed path set (prod release store, test everything else) is refused' test "$rc" -eq 64
  ( PUBREL=/home/public/test/.taskmind-evil; STAMP=99990101000002-2; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'a release store that is not .taskmind is refused' test "$rc" -eq 64
  check 'and removes nothing' test -d "$T/releases/99990101000002-2" -a -d "$PR/99990101000002-2"
  ( STAMP=99990101000002-2; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'the expected set of paths is accepted' test "$rc" -eq 0 -a ! -e "$T/releases/99990101000002-2" -a ! -e "$PR/99990101000002-2"
  ( host_vars_test; PUBLIC=/home/public/TaskMind; PUBREL=/home/public/.taskmind; PROTECTED=/home/protected/taskmind; AUTH=/home/protected/lib; DATA=/home/protected/taskmind-data
    mkdir -p "$R/home/public/.taskmind/99990101000004-4"; STAMP=99990101000004-4; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'the production set is accepted too' test "$rc" -eq 0 -a ! -e "$R/home/public/.taskmind/99990101000004-4"
}

t_discard_guards() {
  new_case; deploy; deploy; cur=$(live); pv=$(prev)
  host_vars_test
  ( STAMP=$cur; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'the live release cannot be discarded' test "$rc" -ne 0 -a -d "$PR/$cur" -a -d "$T/releases/$cur/lib"
  ( STAMP=$pv; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'the previous release cannot be discarded' test "$rc" -ne 0 -a -d "$PR/$pv" -a -d "$T/releases/$pv/lib"
  ( STAMP='../../x'; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'a path-like release name cannot be discarded' test "$rc" -ne 0
  mkdir -p "$T/releases/99990101000003-3/lib" "$PR/99990101000003-3"
  ( STAMP=99990101000003-3; remote_direct discard ) >/dev/null 2>&1; rc=$?
  check 'an unused release is discarded from both trees' test "$rc" -eq 0 -a ! -e "$T/releases/99990101000003-3" -a ! -e "$PR/99990101000003-3"
}

t_prune() {
  # Names are pruned across BOTH trees: the public release store and the protected lib releases. 3 exists only in the
  # public tree and 2 only in the protected one; both are older than the newest five and must go from where they are.
  new_case
  mkdir -p "$T/releases/keep-me" "$PR/keep-me"
  for i in 1 4 5 6 7 8; do s=$(printf '9999010100%04d' $i)-$i; mkdir -p "$T/releases/$s/lib" "$PR/$s"; done
  mkdir -p "$PR/99990101000003-3" "$T/releases/99990101000002-2/lib"
  ln -s /tmp "$T/releases/99990101000000-0"; ln -s /tmp "$PR/99990101000000-0"
  ln -s .taskmind/99990101000001-1 "$PL"; echo 99990101000002-2 > "$T/previous"
  deploy
  new=$(live)
  check 'deploy onto existing releases succeeds' test "$RC" -eq 0
  check 'the new release is live although it sorts OLDEST' sh -c 'case "$1" in 2026*) exit 0 ;; *) exit 1 ;; esac' _ "$new"
  check 'the new (live) release survives pruning in both trees' test -d "$PR/$new" -a -d "$T/releases/$new/lib"
  check 'the old live release, now previous, survives pruning in both trees' test -d "$PR/99990101000001-1" -a -d "$T/releases/99990101000001-1/lib" -a "$(prev)" = 99990101000001-1
  for i in 4 5 6 7 8; do check "newest five are kept in both trees (release $i)" test -d "$PR/9999010100000$i-$i" -a -d "$T/releases/9999010100000$i-$i"; done
  check 'a release older than the newest five is pruned from the public tree (3)' test ! -e "$PR/99990101000003-3"
  check 'a release older than the newest five is pruned from the protected tree (2)' test ! -e "$T/releases/99990101000002-2"
  check 'entries that are not releases are never touched' test -d "$T/releases/keep-me" -a -d "$PR/keep-me"
  check 'a symlink named like a release is never removed' test -L "$T/releases/99990101000000-0" -a -L "$PR/99990101000000-0"
  check 'the deny file in the release store is never pruned' test "$(cat "$PR/.htaccess")" = 'Require all denied'
  # the previous release is kept even when it is older than the newest five (the prune phase on its own)
  new_case; host_vars_test
  for i in 1 2 3 4 5 6 7; do s=$(printf '9999010100%04d' $i)-$i; mkdir -p "$T/releases/$s/lib" "$PR/$s"; done
  ln -s .taskmind/99990101000007-7 "$PL"; echo 99990101000001-1 > "$T/previous"
  remote_direct prune >/dev/null 2>&1; rc=$?
  check 'the prune phase succeeds on its own' test "$rc" -eq 0
  check 'the previous release is kept although it is older than the newest five' test -d "$PR/99990101000001-1" -a -d "$T/releases/99990101000001-1/lib"
  check 'the other old releases are gone from both trees' test ! -e "$PR/99990101000002-2" -a ! -e "$T/releases/99990101000002-2"
  check 'the newest five are kept' test -d "$PR/99990101000003-3" -a -d "$T/releases/99990101000007-7/lib"
  ln -sfh .taskmind/99990101000001-1 "$PL"; echo 99990101000007-7 > "$T/previous"
  remote_direct prune >/dev/null 2>&1
  check 'the live release is kept although it is older than the newest five' test -d "$PR/99990101000001-1" -a -d "$T/releases/99990101000001-1/lib"
}

t_public_guard() {
  new_case; mkdir -p "$PL"; echo hand-made > "$PL/index.php"
  deploy
  check 'a real directory at the public path aborts the deploy' test "$RC" -ne 0
  check 'it explains how to proceed' out_has 'move it aside'
  check 'nothing is uploaded' not grep -q '^rsync' "$LOG/calls"
  check 'the real directory is untouched' test "$(cat "$PL/index.php")" = hand-made -a ! -L "$PL"
  check 'no release directory was created, public or protected' test ! -e "$T/releases" -a ! -e "$PR"
  new_case; ln -s /tmp/elsewhere "$PL"
  deploy
  check 'a symlink to somewhere else aborts the deploy' test "$RC" -ne 0
  check 'a foreign symlink is not repointed' test "$(readlink "$PL")" = /tmp/elsewhere
  check 'it tells how to proceed' out_has 'move it aside'
  new_case; ln -s releases/99990101000001-1 "$PL"
  deploy
  check 'a symlink that does not name a .taskmind release aborts the deploy' test "$RC" -ne 0 -a "$(readlink "$PL")" = releases/99990101000001-1
  new_case; ln -s /home/protected/taskmind-test/releases/99990101000001-1 "$PL"
  deploy
  check 'a symlink into /home/protected (what Apache refuses) is not accepted as ours' test "$RC" -ne 0
  new_case; mkdir -p "$T/previous"; echo mine > "$T/previous/keep.txt"
  deploy
  check 'a real directory named previous aborts the deploy' test "$RC" -ne 0
  check 'it says previous is not a plain file' out_has 'previous exists but is not a plain file'
  check 'the real previous directory is untouched (nothing swallowed into it)' test "$(ls "$T/previous" | tr '\n' ' ')" = 'keep.txt '
  check 'nothing is uploaded when previous is a directory' not grep -q '^rsync' "$LOG/calls"
  new_case; mkdir -p "$T/elsewhere"; ln -s elsewhere "$T/previous"
  deploy
  check 'a symlinked previous aborts the deploy' test "$RC" -ne 0 -a -z "$(ls "$T/elsewhere")"
  new_case; mkdir -p "$PB"; ln -s /tmp/store "$PR"
  deploy
  check 'a release store that is a symlink aborts the deploy' test "$RC" -ne 0 -a "$(readlink "$PR")" = /tmp/store
  check 'it says so' out_has 'is not a plain directory'
  new_case; echo file > "$PR"
  deploy
  check 'a release store that is a file aborts the deploy' test "$RC" -ne 0 -a "$(cat "$PR")" = file
  new_case; mkdir -p "$PR/.htaccess"
  deploy
  check 'a deny file that is a directory fails the pre-checks' test "$RC" -ne 0 -a -d "$PR/.htaccess"
  check 'nothing is uploaded then' not grep -q '^rsync' "$LOG/calls"
  check 'and the lock is released' test ! -e "$T/.deploy.lock"
  # the deny file is rewritten when it differs, and replaced (not followed) when it is a symlink
  new_case; mkdir -p "$PR"; echo 'Require all granted' > "$PR/.htaccess"
  deploy
  check 'a wrong deny file is rewritten' test "$RC" -eq 0 -a "$(cat "$PR/.htaccess")" = 'Require all denied'
  check 'the rewrite is announced' out_has 'wrote '
  new_case; mkdir -p "$PR"; printf 'Require all denied\n' > "$CASE/outside.txt"; ln -s "$CASE/outside.txt" "$PR/.htaccess"; outside_before=$(cksum < "$CASE/outside.txt")
  deploy
  check 'a symlinked deny file (even one whose target reads right) is replaced by a real one' test "$RC" -eq 0 -a ! -L "$PR/.htaccess" -a "$(cat "$PR/.htaccess")" = 'Require all denied'
  check 'the file it pointed at is untouched' test "$(cksum < "$CASE/outside.txt")" = "$outside_before"
  new_case; deploy; deploy
  check 'a correct deny file is left alone on later deploys' test "$RC" -eq 0 -a "$(grep -c 'wrote ' "$CASE/out")" -eq 0
  # the host loses the deny file between prepare and verification: the direct URL then answers 200 and the deploy fails
  new_case; set_version 9.9.8; deploy; first=$(live); set_version 9.9.9
  SHIM_AFTER_PHASE=prepare; SHIM_AFTER_CMD="rm -f '$PR/.htaccess'"; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'a release store reachable by its direct URL fails the verification' test "$RC" -ne 0
  check 'the message names the direct URL' out_has 'reachable by its direct URL'
  check 'and the link is back on the previous release' test "$(live)" = "$first"
  new_case; SHIM_AFTER_PHASE=prepare; SHIM_AFTER_CMD="rm -f '$PR/.htaccess'"; export SHIM_AFTER_PHASE SHIM_AFTER_CMD
  deploy
  check 'a first install whose release store is open is taken offline again' test "$RC" -ne 0 -a ! -L "$PL"
}

t_auth_guard() {
  new_case; rm -f "$R/home/protected/lib-test/hitlog.php"
  deploy
  check 'a missing auth dependency aborts the deploy' test "$RC" -ne 0
  check 'the missing file is named' out_has hitlog.php
  check 'nothing is uploaded' not grep -q '^rsync' "$LOG/calls"
  check 'no release directory was created' test ! -e "$T/releases" -a ! -e "$PR"
  new_case; rm -f "$R/home/protected/lib-test/auth.php"
  deploy
  check 'a missing auth.php aborts the deploy' test "$RC" -ne 0 -a ! -e "$T/releases"
  new_case; rm -f "$R/home/protected/lib-test/config.php"
  deploy
  check 'a missing config.php aborts the deploy' test "$RC" -ne 0 -a ! -e "$T/releases"
}

t_stale_dist_and_gates() {
  new_case; printf '0.0.1\n' > "$REPO/dist/public/TaskMind/build.txt"
  deploy
  check 'a stale dist (build.txt != package.json) is refused' test "$RC" -ne 0
  check 'stale dist refusal happens before any network tool' no_network_calls
  new_case; SHIM_NPM_FAIL_ON='test'; export SHIM_NPM_FAIL_ON
  deploy
  check 'a failing npm test stops the deploy' test "$RC" -ne 0
  check 'a failing gate happens before any network tool' no_network_calls
  new_case; SHIM_SSH_DEAD=1; export SHIM_SSH_DEAD
  deploy
  check 'an unreachable host fails the deploy' test "$RC" -ne 0
  check 'an unreachable host switches nothing' test ! -e "$T"
}

t_upload_failure() {
  new_case; deploy; first=$(live)
  SHIM_RSYNC_FAIL=1; export SHIM_RSYNC_FAIL
  mark; deploy
  check 'an upload failure fails the deploy' test "$RC" -ne 0
  check 'the live release is unchanged' test "$(live)" = "$first"
  check 'the half-uploaded release is discarded from both trees' test "$(count_dirs "$T/releases")" -eq 1 -a "$(count_dirs "$PR")" -eq 1
  check 'no lint or switch after a failed upload' not since_has 'ssh.verify'
  # a transfer that exits 0 but loses a file: the host counts the PHP files it received
  new_case; echo '<?php // fixture' > "$REPO/dist/protected/lib/extra.php"
  SHIM_RSYNC_DROP=extra.php; export SHIM_RSYNC_DROP
  deploy
  check 'a silently incomplete upload fails the deploy' test "$RC" -ne 0
  check 'the host reports the file count mismatch' out_has 'expected 7 PHP files'
  check 'nothing is switched after it' test ! -L "$PL"
  check 'the incomplete release is discarded from both trees' test "$(count_dirs "$T/releases")" -eq 0 -a "$(count_dirs "$PR")" -eq 0
}

t_excludes() {
  # Decoy files in the repo root (the working directory): an unquoted deny pattern would expand to them.
  new_case
  for f in deploy.conf.sample .env.local x.lock accounts.txt config.php notes.map; do : > "$REPO/$f"; done
  mkdir -p "$REPO/data-old" "$REPO/old-data" "$REPO/taskmind-data-x"
  deploy
  ARGS=$(grep '^rsync' "$LOG/calls" | head -n 1 | cut -f3)
  has_arg() { printf ' %s ' "$ARGS" | grep -qF -- " $1 "; }
  check 'the deploy with decoys succeeds' test "$RC" -eq 0
  for pat in 'config*.php' 'config*.json' 'accounts*' 'passwords*' '*.enc' '.key' '*.key' '*.pem' '*.lock' '.env*' 'deploy.conf*' '*.map' '*.sqlite*' '*.db' '.htpasswd*'; do
    check "the name pattern '$pat' reaches rsync unexpanded" has_arg "--exclude=$pat"
  done
  for pat in 'data/' 'data-*/' '*-data/' 'taskmind-data*/' 'accounts*/' '.git/' '.ssh/' 'node_modules/'; do
    check "the directory pattern '$pat' reaches rsync" has_arg "--exclude=$pat"
  done
  for decoy in deploy.conf.sample .env.local x.lock accounts.txt config.php notes.map data-old old-data taskmind-data-x; do
    check "the decoy $decoy was not expanded into an exclude" not has_arg "--exclude=$decoy"
  done
  want=$(sed -n "s/^DENY_NAMES='\(.*\)'/\1/p;s/^DENY_DIRS='\(.*\)'/\1/p" "$DEPLOY_SRC" | wc -w | tr -d ' ')
  have=$(printf '%s\n' "$ARGS" | tr ' ' '\n' | grep -c '^--exclude=')
  check 'exactly one exclude per deny-list entry is sent' test "$want" -eq "$have"
}

t_package() {
  d=$TMP/package-$(cat "$TMP/n"); mkdir -p "$d/server/public/TaskMind" "$d/server/lib" "$d/dist/protected/lib" "$d/dist/public/TaskMind/assets"
  echo '<?php // index' > "$d/server/public/TaskMind/index.php"; : > "$d/server/public/TaskMind/.DS_Store"
  echo '<?php // bootstrap' > "$d/server/lib/bootstrap.php"; : > "$d/server/lib/.DS_Store"
  echo '<?php // stale: removed from server/lib since' > "$d/dist/protected/lib/removed_since.php"
  echo 'built' > "$d/dist/public/TaskMind/assets/app.js"
  mkdir -p "$d/packages/core/src"; printf 'export const STORE_VERSION = 7;\nexport const OTHER = 1;\n' > "$d/packages/core/src/model.ts"
  printf '{"name":"taskmind","version":"3.2.1"}\n' > "$d/package.json"
  ( cd "$d" && node "$PACKAGE_SRC" ) > "$d/out" 2>&1; rc=$?
  check 'packaging succeeds' test "$rc" -eq 0
  check 'a lib file that no longer exists in server/lib does not ship' test ! -e "$d/dist/protected/lib/removed_since.php"
  check 'the current lib files are packaged' test -f "$d/dist/protected/lib/bootstrap.php"
  check 'the public side is packaged and the vite assets are kept' test -f "$d/dist/public/TaskMind/index.php" -a -f "$d/dist/public/TaskMind/assets/app.js"
  check 'build.txt carries the package version' test "$(cat "$d/dist/public/TaskMind/build.txt")" = 3.2.1
  check '.DS_Store files are not packaged' test ! -e "$d/dist/public/TaskMind/.DS_Store" -a ! -e "$d/dist/protected/lib/.DS_Store"
  check 'lib/store-version.txt carries the model STORE_VERSION (the rollback checks read it)' test "$(cat "$d/dist/protected/lib/store-version.txt")" = 7
  check 'it is a bare number and one line' test "$(wc -l < "$d/dist/protected/lib/store-version.txt" | tr -d ' ')" -eq 1
  printf 'export const STORE_VERSION = 0;\n' > "$d/packages/core/src/model.ts"
  ( cd "$d" && node "$PACKAGE_SRC" ) > "$d/out" 2>&1; rc=$?
  check 'a STORE_VERSION that is not a positive integer stops the packaging' test "$rc" -ne 0
}

t_quick_gates() {
  new_case; with_data; deploy --quick
  check 'a --quick deploy succeeds' test "$RC" -eq 0
  check '--quick gates are check:core, test, build and the spot e2e' test "$(grep '^npm' "$LOG/calls" | cut -f3 | tr '\n' '~')" = "run check:core~test~run build~run test:e2e -- e2e/session.spec.ts --grep private API|a member opens~"
  check 'a --quick dry run names the spot e2e' sh -c 'cd "$1" && PATH="$2:$PATH" sh tools/deploy.sh --dry-run --quick | grep -q "build, spot e2e)"' _ "$REPO" "$SHIMS"
}

dtp_case() {   # a bare origin, a clone with tools/dtp.sh and a stub deploy.sh (it only records that it was called)
  _n=$(( $(cat "$TMP/n") + 1 )); echo "$_n" > "$TMP/n"
  D=$TMP/dtp-$_n; BARE=$D/origin.git; W=$D/work; DLOG=$D/deploy-calls; mkdir -p "$D"; : > "$DLOG"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  git init -q --bare -b main "$BARE"; git clone -q "$BARE" "$W" 2>/dev/null
  git -C "$W" config user.email t@example.invalid; git -C "$W" config user.name t
  mkdir -p "$W/tools"; cp "$DTP_SRC" "$W/tools/dtp.sh"
  # the stub deploy.sh stands for the real one, which runs npm test itself; dtp.sh must not run it again (npm test appends to the log)
  printf '#!/bin/sh\necho "deploy $*" >> "$DEPLOY_LOG"\n[ -z "${STUB_DEPLOY_FAIL:-}" ] || exit 1\n' > "$W/tools/deploy.sh"
  # the stub build-platforms.sh notes whether the version was already tagged and pushed when it ran
  cat > "$W/tools/build-platforms.sh" <<'EOF'
#!/bin/sh
echo "platforms tag=$(git tag -l TaskMind/5.0.0) pushed=$(git ls-remote --tags origin TaskMind/5.0.0 | wc -l | tr -d ' ')" >> "$DEPLOY_LOG"
echo "$*" > "$DEPLOY_LOG.args"
[ -z "${STUB_OWE:-}" ] || printf '%s\n' "$STUB_OWE" > "$TASKMIND_OWED_FILE"
[ -z "${STUB_FAIL:-}" ] || exit 3
EOF
  printf '{"name":"taskmind","version":"5.0.0","scripts":{"test":"echo npm-test >> \\"$DEPLOY_LOG\\""}}\n' > "$W/package.json"
  git -C "$W" add -A; git -C "$W" commit -q -m first; git -C "$W" branch -M main; git -C "$W" push -q -u origin main 2>/dev/null
}
dtp() { RC=0; ( cd "$W" && DEPLOY_LOG=$DLOG sh tools/dtp.sh --web "$@" ) > "$D/out" 2>&1 || RC=$?; }
dtp_all() { RC=0; ( cd "$W" && DEPLOY_LOG=$DLOG sh tools/dtp.sh "$@" ) > "$D/out" 2>&1 || RC=$?; }   # with the device builds

t_dtp() {
  dtp_case; dtp
  check 'dtp in sync with origin succeeds' test "$RC" -eq 0
  check 'dtp deploys production once, with the spot test (--quick)' test "$(cat "$DLOG")" = 'deploy --prod --yes-prod --quick'
  check 'dtp tags and pushes the version' test "$(git -C "$BARE" tag -l TaskMind/5.0.0)" = TaskMind/5.0.0
  dtp_case; dtp --full
  check 'tdtp (--full) deploys production with every spec (no --quick)' test "$RC" -eq 0 -a "$(cat "$DLOG")" = 'deploy --prod --yes-prod'
  dtp_case; echo more > "$W/more.txt"; git -C "$W" add -A; git -C "$W" commit -q -m local; dtp
  check 'unpushed local commits do not block dtp' test "$RC" -eq 0 -a "$(wc -l < "$DLOG" | tr -d ' ')" -eq 1
  dtp_case
  git clone -q "$BARE" "$D/other" 2>/dev/null; git -C "$D/other" config user.email o@example.invalid; git -C "$D/other" config user.name o
  echo theirs > "$D/other/theirs.txt"; git -C "$D/other" add -A; git -C "$D/other" commit -q -m theirs; git -C "$D/other" push -q origin main 2>/dev/null
  dtp
  check 'dtp refuses when origin/main is ahead' test "$RC" -ne 0
  check 'it says to pull first and that nothing was deployed' grep -q 'pull first. Nothing was deployed' "$D/out"
  check 'production was not deployed' test ! -s "$DLOG"
  check 'no tag was created locally' test -z "$(git -C "$W" tag -l)"
  dtp_case; git -C "$BARE" tag TaskMind/5.0.0 main
  dtp
  check 'dtp refuses a version that origin already has tagged' test "$RC" -ne 0
  check 'it says nothing was deployed' grep -q 'Nothing was deployed' "$D/out"
  check 'production was not deployed (tag taken on origin)' test ! -s "$DLOG"
  dtp_case; git -C "$W" remote set-url origin "$D/does-not-exist.git"
  dtp
  check 'dtp refuses when origin cannot be reached' test "$RC" -ne 0
  check 'production was not deployed (origin unreachable)' test ! -s "$DLOG"
  # the order: deploy, then tag and push at once, then the device builds
  dtp_case; dtp_all
  check 'dtp with the device builds succeeds' test "$RC" -eq 0
  check 'the order is deploy, then the device builds' test "$(cut -d' ' -f1 "$DLOG" | tr '\n' ' ')" = 'deploy platforms '
  check 'the version was already tagged and pushed when the device builds started' grep -q '^platforms tag=TaskMind/5.0.0 pushed=1$' "$DLOG"
  check 'and it is tagged and pushed afterwards too' test "$(git -C "$BARE" tag -l TaskMind/5.0.0)" = TaskMind/5.0.0
  check 'a clean run reports nothing owed' not grep -qi 'owed' "$D/out"
  dtp_case; dtp_all --full
  check 'tdtp runs npm test once: in deploy.sh, never again in dtp.sh' test "$RC" -eq 0 -a "$(cut -d' ' -f1 "$DLOG" | tr '\n' ' ')" = 'deploy platforms '
  dtp_case; STUB_FAIL=1 dtp_all
  check 'a failed device build still exits non-zero' test "$RC" -ne 0
  check 'after the push: the version is tagged on origin' test "$(git -C "$BARE" tag -l TaskMind/5.0.0)" = TaskMind/5.0.0
  check 'it says the web shipped' grep -q 'The web shipped (TaskMind 5.0.0 is live, tagged and pushed)' "$D/out"
  check 'and which device build is owed when the build did not say' grep -q 'the device builds (see the output above)' "$D/out"
  dtp_case; STUB_FAIL=1 STUB_OWE='the iOS build and its install on every phone' dtp_all
  check 'a failed device build names what it owes' grep -q -- '  - the iOS build and its install on every phone' "$D/out"
  dtp_case; STUB_OWE='the iOS install on the phone 00000000-0000000000000002 (Phone 2, Person B)' dtp_all
  check 'a skipped phone is owed but does not fail the run' test "$RC" -eq 0
  check 'it is named at the end' grep -q -- '  - the iOS install on the phone 00000000-0000000000000002 (Phone 2, Person B)' "$D/out"
  # which native builds a lane names: none (the build script's own default), the ones named, or all three with --platforms; --web none
  dtp_case; dtp_all
  check 'a bare dtp leaves the choice of builds to build-platforms.sh' test "$RC" -eq 0 -a "$(cat "$DLOG.args")" = ''
  dtp_case; dtp_all --android --windows
  check 'named builds are passed through, and only those' test "$RC" -eq 0 -a "$(cat "$DLOG.args")" = '--android --windows'
  dtp_case; dtp_all --platforms
  check '--platforms names the Mac, iOS and Android builds' test "$RC" -eq 0 -a "$(cat "$DLOG.args")" = '--mac --ios --android'
  dtp_case; dtp --android
  check '--web beside a build name still builds nothing' test "$RC" -eq 0 -a ! -e "$DLOG.args" -a "$(cut -d' ' -f1 "$DLOG" | tr '\n' ' ')" = 'deploy '
  dtp_case; dtp_all --bogus
  check 'an unknown flag stops before anything is deployed' test "$RC" -ne 0 -a ! -s "$DLOG"
  dtp_case; STUB_DEPLOY_FAIL=1 dtp_all
  check 'a failed deploy tags nothing, pushes nothing and builds nothing' test "$RC" -ne 0 -a -z "$(git -C "$BARE" tag -l)" -a -z "$(git -C "$W" tag -l)" -a "$(cat "$DLOG")" = 'deploy --prod --yes-prod --quick'
}

platforms_case() {   # a repo with build-platforms.sh and the lock, shimmed npm, cargo and xcrun, a fake home with iOS DeviceSupport
  _n=$(( $(cat "$TMP/n") + 1 )); echo "$_n" > "$TMP/n"
  P=$TMP/platforms-$_n; PLOG=$P/log; POWED=$P/owed
  mkdir -p "$P/tools" "$P/bin" "$P/native/src-tauri/icons/ios" "$P/home/Library/Developer/Xcode/iOS DeviceSupport"
  cp "$PLATFORMS_SRC" "$P/tools/build-platforms.sh"; cp "$ROOT/tools/heavy-lock.sh" "$P/tools/heavy-lock.sh"
  echo icon > "$P/native/src-tauri/icons/ios/AppIcon-512@2x.png"; : > "$PLOG"
  cp "$ROOT/tools/machine-env.sh" "$P/tools/machine-env.sh"; mkdir -p "$P/.local"
  cat > "$P/.local/machine.env" <<'MACHINE'
APPLE_TEAM_ID=TEAMID0000
PHONE1_UDID=00000000-0000000000000001
PHONE1_NAME="Phone 1"
PHONE1_PERSON="Person A"
PHONE2_UDID=00000000-0000000000000002
PHONE2_NAME="Phone 2"
PHONE2_PERSON="Person B"
TASKMIND_PHONES="1 2"
MACHINE
  printf '#!/bin/sh\nexit 0\n' > "$P/bin/cargo"
  cat > "$P/bin/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$PLOG"
case "$*" in
  *"ios init"*) mkdir -p src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset ;;
  *"ios build"*) [ -z "${STUB_IOS_BUILD_FAIL:-}" ] || exit 1; mkdir -p src-tauri/gen/apple/build/arm64; : > src-tauri/gen/apple/build/arm64/TaskMind.ipa ;;
  *"build -- --debug"*) _app=src-tauri/target/debug/bundle/macos/TaskMind.app/Contents/MacOS; mkdir -p "$_app"; printf '#!/bin/sh\n' > "$_app/taskmind"; chmod +x "$_app/taskmind" ;;
  *"android init"*) mkdir -p src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi; echo stock > src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png ;;
  *"android build --debug"*) [ -z "${STUB_ANDROID_BUILD_FAIL:-}" ] || exit 1; mkdir -p src-tauri/gen/android/app/build/outputs/apk/debug; echo "$*" > src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk ;;
  *"android build"*) [ -z "${STUB_ANDROID_BUILD_FAIL:-}" ] || exit 1; _r=src-tauri/gen/android/app/build/outputs/apk/universal/release; mkdir -p "$_r"; echo "$*" > "$_r/app-universal-release-unsigned.apk" ;;
esac
EOF
  # the Mac app must never be installed by a test: these only record that they were called
  for cmd in ditto open pkill; do printf '#!/bin/sh\necho "%s $*" >> "$PLOG"\n' "$cmd" > "$P/bin/$cmd"; done
  # the Android SDK: adb (STUB_ADB_DEVICE names the attached device, STUB_ABI its ABI; an emulator brings one up), emulator, aapt, a JDK
  cat > "$P/bin/adb" <<'EOF'
#!/bin/sh
echo "adb $*" >> "$PLOG"
case "$*" in
  devices) printf 'List of devices attached\n'
    if [ -n "${STUB_ADB_DEVICE:-}" ]; then printf '%s\tdevice\n' "$STUB_ADB_DEVICE"; elif [ -e "$BOOTED" ]; then printf 'emulator-5554\tdevice\n'; fi ;;
  *"getprop ro.product.cpu.abi"*) echo "${STUB_ABI:-arm64-v8a}" ;;
  *"getprop sys.boot_completed"*) echo 1 ;;
  *" install -r "*) [ -z "${STUB_ADB_INSTALL_FAIL:-}" ] || { echo 'adb: failed to install (shim)' >&2; exit 1; }
    # STUB_ADB_INCOMPATIBLE: the device holds the app signed with another key until it is uninstalled
    if [ -n "${STUB_ADB_INCOMPATIBLE:-}" ] && [ ! -e "$PLOG.uninstalled" ]; then echo 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]' >&2; exit 1; fi ;;
  *" uninstall "*) : > "$PLOG.uninstalled" ;;
  *"ps -A"*) echo 'u0_a123 4242 1 com.seancheren.taskmind' ;;
esac
EOF
  cat > "$P/bin/emulator" <<'EOF'
#!/bin/sh
echo "emulator $*" >> "$PLOG"
case "$1" in -list-avds) printf '%s\n' ${STUB_AVDS:-} ;; -avd) : > "$BOOTED" ;; esac
EOF
  mkdir -p "$P/sdk/ndk/26.1.0" "$P/sdk/ndk/27.0.2" "$P/sdk/build-tools/34.0.0" "$P/sdk/build-tools/35.0.0" "$P/sdk/system-images/android-35" "$P/jdk/bin" "$P/home/.android/avd/pixel.avd" "$P/native/src-tauri/icons/android/mipmap-xxxhdpi"
  printf 'image.sysdir.1=system-images/android-35/\n' > "$P/home/.android/avd/pixel.avd/config.ini"
  printf "#!/bin/sh\ncat <<EOT\npackage: name='com.seancheren.taskmind' versionCode='1'\nlaunchable-activity: name='com.seancheren.taskmind.MainActivity'  label=''\nEOT\n" > "$P/sdk/build-tools/35.0.0/aapt"
  # the release key's tools: keytool makes a keystore (never sees a password but as a file), zipalign copies, apksigner signs (marks the file
  # with the keystore) and verifies (STUB_DEBUG_CERT: the APK carries the debug certificate)
  cat > "$P/jdk/bin/keytool" <<'EOF'
#!/bin/sh
echo "keytool $*" >> "$PLOG"
[ -z "${STUB_KEYTOOL_FAIL:-}" ] || exit 1
while [ $# -gt 0 ]; do case "$1" in -keystore) _ks=$2; shift ;; -storepass:file) _pw=$2; shift ;; esac; shift; done
[ -s "$_pw" ] || exit 2
echo "keystore made with $(wc -c < "$_pw" | tr -d ' ') password chars" > "$_ks"
EOF
  cat > "$P/sdk/build-tools/35.0.0/zipalign" <<'EOF'
#!/bin/sh
echo "zipalign $*" >> "$PLOG"
cp "$4" "$5"
EOF
  cat > "$P/sdk/build-tools/35.0.0/apksigner" <<'EOF'
#!/bin/sh
echo "apksigner $*" >> "$PLOG"
case "$1" in
  sign) [ -s "$3" ] || exit 1; [ -s "${5#file:}" ] || exit 1; { cat "${10}"; echo "signed-with:$3"; } > "$9" ;;
  verify) grep -q '^signed-with:' "$3" || exit 1
    if [ -n "${STUB_DEBUG_CERT:-}" ]; then echo 'Signer #1 certificate DN: C=US, O=Android, CN=Android Debug'; else echo 'Signer #1 certificate DN: CN=TaskMind, O=seancheren.com'; fi ;;
esac
EOF
  printf '#!/bin/sh\n' > "$P/jdk/bin/java"; echo taskmind-icon > "$P/native/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png"
  BOOTED=$P/booted
  # devicectl: STUB_AWAY always locks, STUB_RETRY times out once, STUB_BROKEN rejects provisioning
  cat > "$P/bin/xcrun" <<'EOF'
#!/bin/sh
echo "xcrun $*" >> "$PLOG"
[ "$1 $2 $3 $4 $5" = 'devicectl device install app --device' ] || exit 97
case " ${STUB_AWAY:-} " in *" $6 "*) echo 'ERROR: The device is locked. (com.apple.dt.CoreDeviceError error 1002)' >&2; exit 19 ;; esac
case " ${STUB_BROKEN:-} " in *" $6 "*) echo 'ERROR: The application failed to install: invalid provisioning profile.' >&2; exit 17 ;; esac
case " ${STUB_RETRY:-} " in *" $6 "*)
  if [ "$(grep -c "^xcrun devicectl device install app --device $6 " "$PLOG")" = 1 ]; then echo 'ERROR: developer disk image service timed out.' >&2; exit 23; fi ;;
esac
echo "Installed to $6"
EOF
  chmod +x "$P/bin"/* "$P/sdk/build-tools/35.0.0/aapt" "$P/sdk/build-tools/35.0.0/zipalign" "$P/sdk/build-tools/35.0.0/apksigner" "$P/jdk/bin/java" "$P/jdk/bin/keytool"
  unset IOS_PHONES STUB_AWAY STUB_RETRY STUB_BROKEN MIND_DEVICECTL STUB_IOS_BUILD_FAIL STUB_ADB_DEVICE STUB_ABI STUB_AVDS STUB_ADB_INSTALL_FAIL STUB_ANDROID_BUILD_FAIL ANDROID_AVD NDK_HOME STUB_KEYTOOL_FAIL STUB_DEBUG_CERT STUB_ADB_INCOMPATIBLE
}
platforms() { RC=0; ( cd "$P" && PLOG=$PLOG BOOTED=$BOOTED PATH="$P/bin:$PATH" HOME="$P/home" ANDROID_HOME="$P/sdk" JAVA_HOME="$P/jdk" MIND_HEAVY_LOCK="$P/heavy.lock" TASKMIND_OWED_FILE=$POWED sh tools/build-platforms.sh "$@" ) > "$P/out" 2>&1 || RC=$?; }
installed() { grep -c "^xcrun devicectl device install app --device $1 " "$PLOG" || true; }
p_out_has() { grep -q -- "$1" "$P/out"; }         # the run's output has this (a regular expression)
p_owed_has() { grep -q -- "$1" "$POWED" 2>/dev/null; }   # the owed file names this
p_log_has() { grep -q -- "$1" "$PLOG"; }          # a shimmed tool was called like this
p_log_count() { grep -c -- "$1" "$PLOG" || true; }
p_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }   # a file's permission bits, BSD or GNU stat
PHONE_A=00000000-0000000000000001; PHONE_B=00000000-0000000000000002

t_platforms() {
  [ "$(uname -s)" = Darwin ] || return 0   # the iOS step insists on macOS and Xcode
  platforms_case; rm -rf "$P/.local"; platforms --ios
  check 'without .local/machine.env the iOS step refuses' test "$RC" -ne 0
  check 'and names the missing file' grep -Fq '.local/machine.env does not exist' "$P/out"
  check 'before any build or install starts' test ! -s "$PLOG"
  platforms_case; sed -i '' '/^APPLE_TEAM_ID=/d' "$P/.local/machine.env"; platforms --ios
  check 'a machine.env without the team refuses and names APPLE_TEAM_ID' test "$RC" -ne 0 && grep -Fq 'key APPLE_TEAM_ID is missing' "$P/out"
  platforms_case; sed -i '' '/^PHONE2_UDID=/d' "$P/.local/machine.env"; platforms --ios
  check 'a listed phone without its UDID refuses and names the key' test "$RC" -ne 0 && grep -Fq 'key PHONE2_UDID is missing' "$P/out"
  platforms_case; rm -rf "$P/.local"; platforms --ios --dry-run
  check 'the dry run needs no machine.env' test "$RC" -eq 0
  platforms_case; platforms --ios
  check 'the iOS step succeeds with the default phones' test "$RC" -eq 0
  check 'by default the app is installed on the first listed phone' test "$(installed $PHONE_A)" -eq 1
  check 'and on the second' test "$(installed $PHONE_B)" -eq 1
  check 'a clean run owes nothing' test ! -s "$POWED"
  check 'and says nothing is owed' not grep -q 'owed' "$P/out"
  platforms_case; STUB_AWAY=$PHONE_B; export STUB_AWAY; platforms --ios
  check 'a phone that is locked or offline does not fail the run' test "$RC" -eq 0
  check 'the other phone still gets the app' test "$(installed $PHONE_A)" -eq 1
  check 'a warning names the skipped phone' grep -q "warning: skipped the phone $PHONE_B (Phone 2, Person B)" "$P/out"
  check 'a locked phone is retried once' test "$(installed $PHONE_B)" -eq 2
  check 'the original error is printed' p_out_has 'CoreDeviceError error 1002'
  check 'the helper names the locked phone' test "$(grep -c '^Phone 2, Person B is locked' "$P/out")" -eq 1
  check 'the warning omits the internal exit status' not p_out_has 'devicectl exit'
  check 'and its install is owed, in the output' grep -q -- "  - the iOS install on the phone $PHONE_B (Phone 2, Person B)" "$P/out"
  check 'and in the owed file dtp reads' grep -q "the iOS install on the phone $PHONE_B (Phone 2, Person B)" "$POWED"
  check 'only that phone is owed' test "$(wc -l < "$POWED" | tr -d ' ')" -eq 1
  platforms_case; STUB_RETRY=$PHONE_A; export STUB_RETRY; platforms --ios
  check 'an initial timeout is recovered' test "$RC" -eq 0 -a "$(installed $PHONE_A)" -eq 2
  check 'a recovered phone is never owed' test ! -s "$POWED"
  platforms_case; STUB_AWAY="$PHONE_A $PHONE_B"; export STUB_AWAY; platforms --ios
  check 'with both phones away the run still succeeds and owes both' test "$RC" -eq 0 -a "$(wc -l < "$POWED" | tr -d ' ')" -eq 2
  platforms_case; STUB_BROKEN=$PHONE_A; export STUB_BROKEN; platforms --ios
  check 'an install that fails for another reason fails the run' test "$RC" -ne 0
  check 'but only after the other phone got its app' test "$(installed $PHONE_B)" -eq 1
  check 'and it says the phone was not away' grep -q "the install on the phone $PHONE_A (Phone 1, Person A) failed" "$P/out"
  check 'the provisioning error is printed' p_out_has 'invalid provisioning profile'
  check 'the failed phone is owed' grep -q "the iOS install on the phone $PHONE_A" "$POWED"
  platforms_case; STUB_IOS_BUILD_FAIL=1; export STUB_IOS_BUILD_FAIL; platforms --ios
  check 'a failed iOS build fails the run' test "$RC" -ne 0
  check 'no phone was touched' test "$(grep -c '^xcrun' "$PLOG")" -eq 0
  check 'the iOS build is owed' grep -q 'the iOS build and its install on every phone' "$POWED"
  platforms_case; IOS_PHONES=$PHONE_B; export IOS_PHONES; platforms --ios
  check 'IOS_PHONES replaces the list for one run: only that phone' test "$(installed $PHONE_B)" -eq 1 -a "$(installed $PHONE_A)" -eq 0
  platforms_case; IOS_PHONES="$PHONE_A $PHONE_B"; export IOS_PHONES; platforms --ios
  check 'IOS_PHONES takes several udids on one line' test "$(installed $PHONE_B)" -eq 1 -a "$(installed $PHONE_A)" -eq 1
  platforms_case; platforms --ios --dry-run
  check 'the dry run succeeds' test "$RC" -eq 0
  check 'and names the default phones' p_out_has 'the phones listed for it in .local/machine.env'
  check 'it does not touch any phone' test "$(grep -c '^xcrun' "$PLOG")" -eq 0
  check 'the dry run builds nothing either' test ! -s "$PLOG"
  # --debug is never an iOS mode
  platforms_case; platforms --ios --debug
  check '--ios --debug is refused before anything is built' test "$RC" -ne 0 -a ! -s "$PLOG"
  # the Mac app: only the debug build is run here (the real one replaces /Applications/TaskMind.app); it installs nothing
  platforms_case; platforms --mac --debug
  check 'a debug Mac build succeeds and owes nothing' test "$RC" -eq 0 -a ! -s "$POWED"
  check 'it builds the debug bundle only' grep -q '^npm run build -- --debug --bundles app$' "$PLOG"
  check 'and quits, copies and opens nothing' not grep -Eq '^(ditto|open|pkill) ' "$PLOG"
  check 'it says where the bundle is and that it is not installed' grep -q 'target/debug/bundle/macos/TaskMind.app (debug; not installed)' "$P/out"
  platforms_case; platforms --mac --debug --dry-run
  check 'the Mac dry run builds nothing' test "$RC" -eq 0 -a ! -s "$PLOG"
  check 'and says nothing is installed' p_out_has 'nothing is installed'
  # Android: --debug builds an APK for aarch64 and touches no device
  platforms_case; platforms --android --debug
  check 'a debug Android build succeeds and owes nothing' test "$RC" -eq 0 -a ! -s "$POWED"
  check 'it regenerates the project and builds, nothing else' test "$(p_log_count '^npm run tauri -- android ')" -eq 2
  check 'a debug APK for aarch64' p_log_has '^npm run tauri -- android build --debug --apk --target aarch64 --ci$'
  check 'it uses no device: no adb, no emulator' not grep -Eq '^(adb|emulator) ' "$PLOG"
  check 'and no release key: nothing is made or signed' not grep -Eq '^(keytool|zipalign|apksigner) ' "$PLOG"
  check 'no key directory is created' test ! -e "$P/home/.config/taskmind"
  check 'the TaskMind launcher icons replace the stock ones the init wrote' test "$(cat "$P/native/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")" = taskmind-icon
  check 'and it says the APK is not installed' grep -q 'app-debug.apk (debug; not installed)' "$P/out"
  # Android: an install goes to the attached device, built for its ABI, then launches and checks the app runs
  platforms_case; STUB_ADB_DEVICE=emulator-5554; export STUB_ADB_DEVICE; platforms --android
  check 'an install onto an attached device succeeds and owes nothing' test "$RC" -eq 0 -a ! -s "$POWED"
  check 'no emulator is booted on top of an attached device' not grep -q '^emulator ' "$PLOG"
  check 'it is a RELEASE build for the device ABI (arm64-v8a is aarch64)' grep -q '^npm run tauri -- android build --apk --target aarch64 --ci$' "$PLOG"
  check 'and never a debug build' not p_log_has 'android build --debug'
  check 'installed onto that device, with -r: the signed release APK' grep -q '^adb -s emulator-5554 install -r native/src-tauri/gen/android/app/build/outputs/taskmind-release.apk$' "$PLOG"
  check 'never the unsigned one or a debug one' test "$(p_log_count ' install -r ')" -eq 1
  check 'the package and activity come from the built APK' grep -q '^adb -s emulator-5554 shell am start -n com.seancheren.taskmind/com.seancheren.taskmind.MainActivity$' "$PLOG"
  check 'and the app is looked for in the process list' grep -q '^adb -s emulator-5554 shell ps -A$' "$PLOG"
  check 'it says it is running' grep -q 'installed and running: com.seancheren.taskmind on emulator-5554 (release' "$P/out"
  # Android release: the local key, made once, outside the repo, its password never in an argument, the log or the output
  KS=$P/home/.config/taskmind/android-release.keystore
  check 'the release key is made under ~/.config/taskmind' test -s "$KS" -a -s "$KS.password"
  check 'once' test "$(p_log_count '^keytool ')" -eq 1
  check 'as a PKCS12 keystore, alias taskmind, the password given as a file' p_log_has "^keytool -genkeypair -noprompt -keystore $KS -storetype PKCS12 -storepass:file $KS.password -keypass:file $KS.password -alias taskmind "
  check 'the password is 40 generated characters' test "$(wc -c < "$KS.password" | tr -d ' ')" -eq 40
  check 'both files are 0600' test "$(p_mode "$KS")" = 600 -a "$(p_mode "$KS.password")" = 600
  check 'in a 0700 directory' test "$(p_mode "$P/home/.config/taskmind")" = 700
  check 'the password is never in the output' not grep -qF "$(cat "$KS.password")" "$P/out"
  check 'nor in any command line' not grep -qF "$(cat "$KS.password")" "$PLOG"
  check 'it says the key was made and to back it up' p_out_has 'made the Android release key .*back both up'
  check 'the unsigned APK is aligned' p_log_has '^zipalign -p -f 4 native/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk native/src-tauri/gen/android/app/build/outputs/taskmind-release.apk.aligned$'
  check 'then signed with the release key' p_log_has "^apksigner sign --ks $KS --ks-pass file:$KS.password --ks-key-alias taskmind --out native/src-tauri/gen/android/app/build/outputs/taskmind-release.apk native/src-tauri/gen/android/app/build/outputs/taskmind-release.apk.aligned$"
  check 'then verified before it is installed' test "$(grep -n '^apksigner verify --print-certs ' "$PLOG" | cut -d: -f1)" -lt "$(grep -n ' install -r ' "$PLOG" | cut -d: -f1)"
  _pw=$(cat "$KS.password"); _ks=$(cat "$KS")
  : > "$PLOG"; platforms --android
  check 'a second run uses the same key: no keytool' test "$RC" -eq 0 -a "$(p_log_count '^keytool ')" -eq 0
  check 'and changes neither file' test "$(cat "$KS.password")" = "$_pw" -a "$(cat "$KS")" = "$_ks"
  check 'and does not say it made one' not p_out_has 'made the Android release key'
  # one file without the other: refused before anything is built, and nothing is replaced
  rm "$KS.password"; : > "$PLOG"; platforms --android
  check 'a keystore without its password fails before anything is built' test "$RC" -ne 0 -a "$(p_log_count '^npm')" -eq 0 -a "$(p_log_count '^keytool ')" -eq 0
  check 'the keystore is left alone' test "$(cat "$KS")" = "$_ks" -a ! -e "$KS.password"
  check 'it says what is missing' p_out_has 'one is missing'
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  rm "$KS"; printf %s "$_pw" > "$KS.password"; : > "$PLOG"; platforms --android
  check 'a password without its keystore fails too, and makes no new key' test "$RC" -ne 0 -a "$(p_log_count '^keytool ')" -eq 0 -a ! -e "$KS"
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_KEYTOOL_FAIL=1; export STUB_ADB_DEVICE STUB_KEYTOOL_FAIL; platforms --android
  check 'a keytool that fails stops the run before the build' test "$RC" -ne 0 -a "$(p_log_count '^npm')" -eq 0
  check 'and leaves no half key behind' test ! -e "$P/home/.config/taskmind/android-release.keystore" -a ! -e "$P/home/.config/taskmind/android-release.keystore.password"
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_DEBUG_CERT=1; export STUB_ADB_DEVICE STUB_DEBUG_CERT; platforms --android
  check 'an APK that carries another certificate is never installed' test "$RC" -ne 0 -a "$(p_log_count ' install -r ')" -eq 0
  check 'it says so' p_out_has 'not signed with the TaskMind release key'
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ADB_INCOMPATIBLE=1; export STUB_ADB_DEVICE STUB_ADB_INCOMPATIBLE; platforms --android
  check 'a device holding a debug-signed TaskMind gets the release build in its place' test "$RC" -eq 0 -a ! -s "$POWED"
  check 'by uninstalling exactly that package' p_log_has '^adb -s emulator-5554 uninstall com.seancheren.taskmind$'
  check 'then installing again' test "$(p_log_count ' install -r ')" -eq 2
  check 'with a warning' p_out_has 'signed with another key; uninstalling it'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ADB_INSTALL_FAIL=1; export STUB_ADB_DEVICE STUB_ADB_INSTALL_FAIL; platforms --android
  check 'any other install failure uninstalls nothing' test "$RC" -ne 0 -a "$(p_log_count ' uninstall ')" -eq 0
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ABI=x86_64; export STUB_ADB_DEVICE STUB_ABI; platforms --android
  check 'an x86_64 emulator gets an x86_64 build' p_log_has '^npm run tauri -- android build --apk --target x86_64 --ci$'
  check 'and nothing else' test "$RC" -eq 0 -a "$(p_log_count 'android build')" -eq 1
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ABI=mips; export STUB_ADB_DEVICE STUB_ABI; platforms --android
  check 'an ABI the build cannot target fails and builds nothing' test "$RC" -ne 0 -a "$(p_log_count 'android build')" -eq 0
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  platforms_case; STUB_AVDS=pixel; export STUB_AVDS; platforms --android
  check 'with no device running a bootable AVD is booted' p_log_has '^emulator -avd pixel '
  check 'and the app installs on it and the run succeeds' test "$RC" -eq 0 -a "$(p_log_count '^adb -s emulator-5554 install -r ')" -eq 1
  platforms_case; platforms --android
  check 'no device and no AVD fails and builds nothing' test "$RC" -ne 0 -a "$(p_log_count 'android')" -eq 0
  check 'with a reason' p_out_has 'no bootable AVD found'
  check 'and no release key is made without a device to install onto' test ! -e "$P/home/.config/taskmind"
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ANDROID_BUILD_FAIL=1; export STUB_ADB_DEVICE STUB_ANDROID_BUILD_FAIL; platforms --android
  check 'a failed Android build fails the run and installs nothing' test "$RC" -ne 0 -a "$(p_log_count ' install -r ')" -eq 0
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; STUB_ADB_INSTALL_FAIL=1; export STUB_ADB_INSTALL_FAIL STUB_ADB_DEVICE; platforms --android
  check 'a failed adb install fails the run and never launches' test "$RC" -ne 0 -a "$(p_log_count 'am start')" -eq 0
  check 'it says the install failed' p_out_has 'adb install failed'
  check 'and the Android build is owed' p_owed_has 'the Android build, install and launch'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; export STUB_ADB_DEVICE; rm -rf "$P/sdk/ndk"; platforms --android
  check 'a missing NDK fails the run and nothing is built' test "$RC" -ne 0 -a "$(p_log_count '^npm')" -eq 0
  check 'and is named' p_out_has 'no Android NDK under'
  platforms_case; STUB_ADB_DEVICE=emulator-5554; export STUB_ADB_DEVICE; platforms --android --dry-run
  check 'the Android dry run builds and installs nothing' test "$RC" -eq 0 -a ! -s "$PLOG"
  check 'and names the project it would regenerate' p_out_has 'tauri android init'
  check 'a RELEASE APK signed with the local key it would make' p_out_has 'RELEASE APK.*android-release.keystore (created now'
  check 'and makes no key in a dry run' test ! -e "$P/home/.config/taskmind"
  mkdir -p "$P/home/.config/taskmind"; : > "$P/home/.config/taskmind/android-release.keystore"; platforms --android --dry-run
  check 'a dry run with only the keystore says the run would be refused' p_out_has 'REFUSED'
  : > "$P/home/.config/taskmind/android-release.keystore.password"; platforms --android --dry-run
  check 'and with both, that the key exists' p_out_has 'android-release.keystore (exists)'
  platforms --android --debug --dry-run
  check 'a --debug dry run still builds a debug APK and names no key' test "$RC" -eq 0 -a "$(grep -c 'keystore' "$P/out")" -eq 0
  platforms_case; STUB_ADB_DEVICE=emulator-5554; export STUB_ADB_DEVICE; platforms --mac --android --debug
  check 'the Mac and Android debug builds can be asked for together and owe nothing' test "$RC" -eq 0 -a ! -s "$POWED"
  check 'the Mac bundle was built' p_out_has 'built native/src-tauri/target/debug/bundle'
  check 'and the APK' p_out_has 'app-debug.apk'
}


t_static() {
  new_case
  check 'deploy.sh never calls ssh, rsync or curl by absolute path' not grep -nE '(^|[^A-Za-z0-9_./-])/(usr/)?(local/)?bin/(ssh|rsync|curl)' "$DEPLOY_SRC"
  for f in index api; do
    case $f in index) src=$INDEX_SRC ;; api) src=$API_SRC ;; esac
    check "$f.php derives the stamp from basename(__DIR__)" grep -qF 'basename(__DIR__)' "$src"
    check "$f.php accepts only the <14 digits>-<pid> directory name" grep -qF '/^\d{14}-\d+$/' "$src"
    check "$f.php binds to /home/protected/taskmind<instance>/releases/<stamp>/lib" grep -qF "'/home/protected/taskmind' . \$instance . '/releases/' . \$stamp . '/lib'" "$src"
    check "$f.php never reads a pointer (no current, realpath, readlink or is_link)" not grep -qE '/current|realpath|readlink|is_link' "$src"
    check "$f.php lets TASKMIND_LIB_DIR win first" grep -qF "\$lib = getenv('TASKMIND_LIB_DIR') ?: (" "$src"
    check "$f.php fails closed with 503 when no lib resolves" grep -qE "if \(\\\$lib === '' \|\| !is_file\(\\\$lib \. '/bootstrap.php'\)\) \{.*http_response_code\(503\)" "$src"
  done
  check 'api.php sends X-TaskMind-Release with the stamp of its own directory' grep -qF "header('X-TaskMind-Release: ' . \$stamp)" "$API_SRC"
  check 'the header is sent before the lib is loaded, so every response carries it' awk '/X-TaskMind-Release/ { h = NR } /require \$lib/ { r = NR } END { exit !(h && r && h < r) }' "$API_SRC"
  check 'deploy.sh never runs a blanket chmod -R over the release on the host' not grep -q 'chmod -R' "$DEPLOY_SRC"
  mv=$(sed -n 's/^export const STORE_VERSION = \([0-9][0-9]*\);.*/\1/p' "$ROOT/packages/core/src/model.ts")
  lv=$(sed -n "s/^  'storeVersion' => \([0-9][0-9]*\),\$/\1/p" "$ROOT/server/lib/limits.php")
  check 'the store version the shipped lib reads (limits.php, which store-version.txt is checked against) is the model STORE_VERSION' test -n "$mv" -a "$mv" = "$lv"
  check 'package.mjs takes store-version.txt from that model constant' grep -q "STORE_VERSION } = await import" "$PACKAGE_SRC"
  check 'deploy.sh has no current/public path anywhere' not grep -F 'current/public' "$DEPLOY_SRC"
  check 'deploy.sh keeps no current pointer in protected' not grep -qF '$PROTECTED/current' "$DEPLOY_SRC"
  check 'every swap_link call flips the public link to a relative .taskmind/<stamp> target' test -n "$(grep -c 'swap_link "' "$DEPLOY_SRC")" -a -z "$(grep 'swap_link "' "$DEPLOY_SRC" | grep -v 'swap_link "\.taskmind/\$[A-Za-z]*" "\$PUBLIC"')" -a "$(grep -c 'swap_link "' "$DEPLOY_SRC")" -ge 2
  rsyncs=$(grep -o 'rsync_up dist/[^ ]* "[^"]*"' "$DEPLOY_SRC")
  check 'the only rsync destinations are the two new release directories' test "$rsyncs" = 'rsync_up dist/public/TaskMind/ "$TASKMIND_DEPLOY_HOST:$PREL/"
rsync_up dist/protected/lib/ "$TASKMIND_DEPLOY_HOST:$REL/lib/"'
  check 'previous is written through a temporary file and one rename' grep -qF 'mv -f "$_tmp" "$PROTECTED/previous"' "$DEPLOY_SRC"
  check 'the release store deny file is exactly Require all denied' grep -qF "printf 'Require all denied\\n' > \"\$_tmp\"" "$DEPLOY_SRC"
  check 'the remote scripts only ever name the two known path sets' grep -q "refusing unexpected paths" "$DEPLOY_SRC"
  pat=$(sed -n 's/^<FilesMatch "\(.*\)">$/\1/p' "$ROOT/server/public/TaskMind/.htaccess" | head -n 1)
  check 'the .htaccess deny pattern was found' test -n "$pat"
  check '.htaccess serves release.txt (the verification fetches it over HTTPS)' not sh -c 'printf "%s\n" release.txt | grep -Eq "$1"' _ "$pat"
  check '.htaccess serves build.txt' not sh -c 'printf "%s\n" build.txt | grep -Eq "$1"' _ "$pat"
  check '.htaccess still denies dot files and data files' sh -c 'printf "%s\n" .key | grep -Eq "$1" && printf "%s\n" workspace.enc | grep -Eq "$1"' _ "$pat"
}

# ---- The real entrypoints under php-cgi, against a fake host tree --------------------------------------------------
# index.php and api.php bind to THEIR OWN lib by the name of the directory they run from, so a flip can never pair a
# new page with an old lib, and a stale cached copy of the old entrypoint still runs with the old lib.
find_php_cgi() {
  PHPB=${PHP_BINARY:-$(command -v php 2>/dev/null || true)}
  CGIB=${PHP_CGI:-}
  if [ -z "$CGIB" ] && [ -n "$PHPB" ] && [ -x "$(dirname "$PHPB")/php-cgi" ]; then CGIB=$(dirname "$PHPB")/php-cgi; fi
  [ -n "$CGIB" ] || CGIB=$(command -v php-cgi 2>/dev/null || true)
}
fake_bootstrap() {   # a stand-in lib that names the release it lives in (X-Fake-Lib) and answers like the real one would
  cat <<'PHP'
<?php
namespace TaskMind { class RequestError extends \Exception { public int $status; public function __construct(string $m, int $s = 400) { parent::__construct($m); $this->status = $s; } public function body(): array { return ['error' => $this->getMessage()]; } } }
namespace {
    header('X-Fake-Lib: ' . basename(dirname(__DIR__)));
    if (getenv('FAKE_EXIT')) { exit; }
    function tm_member() {
        if (getenv('FAKE_THROW')) { throw new \RuntimeException('x'); }
        if (!getenv('FAKE_USER')) { throw new \TaskMind\RequestError('Sign in to open TaskMind.', 401); }
        return ['id' => getenv('FAKE_USER'), 'role' => 'owner', 'name' => ''];
    }
}
PHP
}
fake_entries() {   # fake_entries <public base> <directory name>: the real index.php and api.php, pointed into the fake protected tree
  mkdir -p "$1/.taskmind/$2"
  sed "s#/home/protected/#$F/home/protected/#g" "$INDEX_SRC" > "$1/.taskmind/$2/index.php"
  sed "s#/home/protected/#$F/home/protected/#g" "$API_SRC" > "$1/.taskmind/$2/api.php"
}
fake_lib() {   # fake_lib <protected dir> <directory name>
  mkdir -p "$1/releases/$2/lib"; fake_bootstrap > "$1/releases/$2/lib/bootstrap.php"
}
run_entry() {   # run_entry <file> <HTTP_HOST> <METHOD> [VAR=value ...]: headers and body, CRs removed
  _f=$1; _h=$2; _m=$3; shift 3
  env -i PATH="$PATH" REDIRECT_STATUS=1 GATEWAY_INTERFACE=CGI/1.1 SERVER_PROTOCOL=HTTP/1.1 REQUEST_METHOD="$_m" \
    SCRIPT_FILENAME="$_f" SCRIPT_NAME="/TaskMind/${_f##*/}" HTTP_HOST="$_h" "$@" \
    "$CGIB" -d display_errors=0 -d log_errors=0 </dev/null 2>/dev/null | tr -d '\r'
}
h_status() { sed -n 's/^Status: \([0-9][0-9]*\).*/\1/p' | head -n 1; }   # php-cgi omits Status for a plain 200
h_get() { sed -n "s/^$1: //p" | head -n 1; }

t_entrypoints() {
  new_case; find_php_cgi
  check 'php-cgi is available (these tests run the real index.php and api.php)' test -n "$CGIB" -a -x "${CGIB:-/nonexistent}"
  [ -n "$CGIB" ] && [ -x "$CGIB" ] || return 0
  F=$CASE/fake; PUB=$F/home/public/test; PROT=$F/home/protected/taskmind-test; PPUB=$F/home/public; PPROT=$F/home/protected/taskmind
  s1=20260101000001-1; s2=20260101000002-2; s3=20260101000003-3; s4=20260101000004-4
  for s in $s1 $s2; do fake_entries "$PUB" $s; fake_lib "$PROT" $s; done
  fake_entries "$PUB" $s3                       # a release whose lib is not there
  fake_entries "$PPUB" $s4; fake_lib "$PPROT" $s4   # a production-only release
  T_H=test.seancheren.com
  # each release runs with its own lib, whatever any pointer says
  ln -s ".taskmind/$s2" "$PUB/TaskMind"; ln -s "releases/$s2" "$PROT/current"; echo "$s2" > "$PROT/previous"
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" $T_H GET)
  check 'api.php of release 1 answers 401' test "$(printf '%s\n' "$o" | h_status)" = 401
  check 'api.php of release 1 runs the lib of release 1' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s1
  check 'api.php of release 1 names release 1' test "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s1
  check 'a pointer naming release 2 (link, current, previous) does not change that: the pair is the directory' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s1
  o=$(run_entry "$PUB/.taskmind/$s2/api.php" $T_H GET)
  check 'api.php of release 2 runs the lib of release 2 and names release 2' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s2 -a "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s2
  o=$(run_entry "$PUB/TaskMind/api.php" $T_H GET)
  check 'reached through the public link, PHP reports the real release directory: lib and stamp are the linked release' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s2 -a "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s2
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" $T_H PUT FAKE_USER=alex)
  check 'a 405 response carries X-TaskMind-Release' test "$(printf '%s\n' "$o" | h_status)" = 405 -a "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s1
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" $T_H GET FAKE_THROW=1)
  check 'an internal-error 503 carries X-TaskMind-Release' test "$(printf '%s\n' "$o" | h_status)" = 503 -a "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s1
  o=$(run_entry "$PUB/.taskmind/$s3/api.php" $T_H GET)
  check 'a release without its lib fails closed with 503' test "$(printf '%s\n' "$o" | h_status)" = 503
  check 'the fail-closed answer reveals no path' not sh -c 'printf "%s\n" "$1" | grep -iE "/home|protected|releases|bootstrap|\.php|/tmp|/var"' _ "$o"
  check 'api.php says it in its own words (not through the generic save-error handler)' sh -c 'printf "%s\n" "$1" | grep -q "temporarily unavailable"' _ "$o"
  check 'it still names the release that answered' test "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)" = $s3
  # the instance comes from the host name
  o=$(run_entry "$PPUB/.taskmind/$s4/api.php" seancheren.com GET)
  check 'a production release uses /home/protected/taskmind (no -test)' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s4 -a "$(printf '%s\n' "$o" | h_status)" = 401
  o=$(run_entry "$PPUB/.taskmind/$s4/api.php" $T_H GET)
  check 'the same release asked as the test host looks in taskmind-test and fails closed' test "$(printf '%s\n' "$o" | h_status)" = 503
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" dev.seancheren.com GET)
  check 'the dev host looks in taskmind-dev (absent here) and fails closed' test "$(printf '%s\n' "$o" | h_status)" = 503
  # a directory name that is not exactly <14 digits>-<pid> never resolves a lib, even when a lib of that name exists
  for bad in TaskMind 20260101000001-1x 2026010100001-1 x20260101000001-1 20260101000001-; do
    fake_entries "$PUB" "$bad"; fake_lib "$PROT" "$bad"
    o=$(run_entry "$PUB/.taskmind/$bad/api.php" $T_H GET)
    check "api.php in a directory named '$bad' fails closed" test "$(printf '%s\n' "$o" | h_status)" = 503
    check "in its own words" sh -c 'printf "%s\n" "$1" | grep -q "temporarily unavailable"' _ "$o"
    check "and sends no X-TaskMind-Release for it" test -z "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)"
    o=$(run_entry "$PUB/.taskmind/$bad/index.php" $T_H GET FAKE_EXIT=1)
    check "index.php in a directory named '$bad' fails closed" test "$(printf '%s\n' "$o" | h_status)" = 503
    check "and shows no path" not sh -c 'printf "%s\n" "$1" | grep -iE "/home|protected|releases|bootstrap|\.php|/tmp|/var"' _ "$o"
  done
  # TASKMIND_LIB_DIR (the local preview and the e2e) wins, and then there is no release header
  mkdir -p "$F/envlib"; fake_bootstrap | sed "s#basename(dirname(__DIR__))#'ENV'#" > "$F/envlib/bootstrap.php"
  o=$(run_entry "$PUB/.taskmind/$bad/api.php" $T_H GET TASKMIND_LIB_DIR="$F/envlib")
  check 'TASKMIND_LIB_DIR is used in any directory' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = ENV -a "$(printf '%s\n' "$o" | h_status)" = 401
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" $T_H GET TASKMIND_LIB_DIR="$F/envlib")
  check 'TASKMIND_LIB_DIR wins over the lib of a stamp-named directory' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = ENV
  check 'and then api.php sends no X-TaskMind-Release' test -z "$(printf '%s\n' "$o" | h_get X-TaskMind-Release)"
  o=$(run_entry "$PUB/.taskmind/$s1/api.php" $T_H GET TASKMIND_LIB_DIR="$F/missing")
  check 'a TASKMIND_LIB_DIR without a bootstrap fails closed' test "$(printf '%s\n' "$o" | h_status)" = 503
  # index.php binds the same way
  o=$(run_entry "$PUB/.taskmind/$s1/index.php" $T_H GET FAKE_EXIT=1)
  check 'index.php of release 1 runs the lib of release 1' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s1
  o=$(run_entry "$PUB/.taskmind/$s2/index.php" $T_H GET FAKE_EXIT=1)
  check 'index.php of release 2 runs the lib of release 2' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = $s2
  o=$(run_entry "$PUB/.taskmind/$s3/index.php" $T_H GET FAKE_EXIT=1)
  check 'index.php of a release without its lib fails closed' test "$(printf '%s\n' "$o" | h_status)" = 503
  check 'and its answer shows no path and no page' not sh -c 'printf "%s\n" "$1" | grep -iE "/home|protected|releases|bootstrap|\.php|/tmp|/var|<html"' _ "$o"
  o=$(run_entry "$PUB/.taskmind/$s1/index.php" $T_H GET FAKE_EXIT=1 TASKMIND_LIB_DIR="$F/envlib")
  check 'index.php honours TASKMIND_LIB_DIR first' test "$(printf '%s\n' "$o" | h_get X-Fake-Lib)" = ENV
}

ALL_TESTS='t_dry_run t_missing_host t_host_sources t_prod_consent t_payload_refused t_deploy_test t_data_dir t_protected_perms t_php_host t_prod
  t_rollback t_lint_failure t_switch_after_lint t_verification_rolls_back t_shared_login_page t_stamp_header t_same_version t_first_install t_cas t_lock
  t_phase_failures t_path_guard t_discard_guards t_prune t_public_guard t_activate_guards t_auth_guard t_stale_dist_and_gates
  t_upload_failure t_excludes t_package t_dtp t_static t_entrypoints t_quick_gates t_slow_answers t_lint_single t_upload_modes
  t_store_version t_platforms'

# ---- Mutations: break a script one rule at a time; the named test must then fail ----------------------------------
# Mutants run a few at a time (each is its own harness run in its own sandbox) and are reported in a fixed order.
MUT_FAIL=0; MUT_N=0; MUT_JOBS=${MUT_JOBS:-4}
mutf() {   # mutf name test ENVVAR source-file 'sed expression'   (ENVVAR points the harness at the mutated copy)
  [ -z "${MUT_ONLY:-}" ] || printf '%s\n' "$1" | grep -Eq "$MUT_ONLY" || return 0
  MUT_N=$((MUT_N + 1))
  _ext=${4##*.}; _m=$TMP/mutant-$1.$_ext
  sed -e "$5" "$4" > "$_m"
  if cmp -s "$_m" "$4"; then printf '%s\t%s\n' "$MUT_N" "mutation did not apply: $1" >> "$TMP/mut-results"; return; fi
  [ -z "${MUT_APPLY_ONLY:-}" ] || { printf '%s\t%s\n' "$MUT_N" "applies: $1" >> "$TMP/mut-results"; return; }
  ( if env "$3=$_m" sh "$0" --only "$2" >/dev/null 2>&1; then _r="SURVIVED: $1 ($2)"; else _r="caught: $1 ($2)"; fi
    printf '%s\t%s\n' "$MUT_N" "$_r" >> "$TMP/mut-results" ) &
  [ $((MUT_N % MUT_JOBS)) -ne 0 ] || wait
}
mut() { mutf "$1" "$2" DEPLOY_SRC "$ROOT/tools/deploy.sh" "$3"; }   # mut name test 'sed expression' (on deploy.sh)
run_mutations() {
  : > "$TMP/mut-results"
  mut dry-run-ignored t_dry_run 's#^if \[ "$DRY" = 1 \]; then$#if false; then#'
  mut host-check-removed t_missing_host 's#^\[ -n "$TASKMIND_DEPLOY_HOST" \] || die .*#:#'
  mut host-shape-check-removed t_missing_host 's#^case $TASKMIND_DEPLOY_HOST in -\*.*#:#'
  mut host-colon-allowed t_missing_host 's#\[!A-Za-z0-9@._-\]#[!A-Za-z0-9@._:-]#'
  mut host-dash-after-at-allowed t_missing_host 's#\*@-\*|##'
  mut host-two-at-allowed t_missing_host 's#|\*@\*@\*##'
  mut host-conf-ignored t_host_sources 's#^if \[ -f deploy.conf \]; then . ./deploy.conf; fi#:#'
  mut env-host-loses t_host_sources 's#^\[ -z "$_env_host" \] || TASKMIND_DEPLOY_HOST=$_env_host#:#'
  mut prod-consent-removed t_prod_consent 's#\[ "$CONSENT" = 1 \] || die#true || die#'
  # payload audit
  mut payload-audit-off t_payload_refused 's#^audit_payload || exit 1$#:#'
  mut deny-list-emptied t_payload_refused 's#^DENY_NAMES=.*#DENY_NAMES=#'
  mut allow-list-off t_payload_refused 's#^      \*) echo "$p: not on the TaskMind payload allow-list" ;;#      *) ;;#'
  mut symlink-check-off t_payload_refused 's#^    if \[ -L "$p" \]; then echo.*#    :#'
  mut dry-run-audit-off t_dry_run 's#^      audit_payload || exit 1#      :#'
  mut dist-symlink-allowed t_payload_refused 's#^  \[ ! -L dist \] || {.*#  :#'
  mut dist-symlink-allowed-dry-run t_dry_run 's#^  \[ ! -L dist \] || {.*#  :#'
  mut find-failure-ignored t_payload_refused 's#^  _list=$(find -P dist -print) || {#  _list=$(find -P dist -print || :) || {#'
  mut deny-names-case-sensitive t_payload_refused 's|^    _lc=.*|    _lc=${p##*/}|'
  mut deny-dirs-case-sensitive t_payload_refused 's|^        _clc=.*|        _clc=$_c|'
  mut lib-allow-list-narrowed t_payload_refused 's#^      dist/protected/lib/\*\.php) case#      dist/protected/lib/bootstrap.php|dist/protected/lib/taskmind.php|dist/protected/lib/atomic.php) case#'
  mut required-app-js-dropped t_payload_refused 's# dist/public/TaskMind/assets/app.js##'
  mut required-app-css-dropped t_payload_refused 's# dist/public/TaskMind/assets/app.css##'
  mut required-htaccess-dropped t_payload_refused 's# dist/public/TaskMind/.htaccess##'
  mut required-atomic-dropped t_payload_refused 's# dist/protected/lib/atomic.php \\$# \\#'
  mut required-limits-dropped t_payload_refused 's# dist/protected/lib/limits.php dist/protected/lib/store-version.txt; do# dist/protected/lib/store-version.txt; do#'
  mut required-store-version-dropped t_payload_refused 's# dist/protected/lib/store-version.txt; do#; do#'
  mut stale-dist-check-off t_stale_dist_and_gates 's#\[ "$(cat dist/public/TaskMind/build.txt)" = "$VERSION" \] ||#true ||#'
  mut gate-skipped t_stale_dist_and_gates 's#^npm test$#:#'
  mut silent-request-not-asked-again t_slow_answers 's#^    echo "the $_what request got no answer in $_cost s; asking again.*#    return 1#'
  mut silent-request-cost-wrong t_slow_answers 's#^CURL_WAIT=20#CURL_WAIT=10#'
  mut reset-costs-a-timeout t_slow_answers 's#if \[ "$_crc" = 28 \]; then _cost=$CURL_WAIT; else _cost=1; fi#_cost=$CURL_WAIT#'
  mut reset-not-waited t_slow_answers 's#^    \[ "$_crc" = 28 \] || sleep 1#    :#'
  mut stale-static-final t_slow_answers 's#^    spend 1 || return 3#    return 3#'
  mut static-windows-not-shared t_slow_answers '/^fetch_fresh() {/a\
  _spent=0'
  mut window-too-small t_slow_answers 's#^VERIFY_WINDOW=150#VERIFY_WINDOW=70#'
  mut window-too-large t_slow_answers 's#^VERIFY_WINDOW=150#VERIFY_WINDOW=300#'
  mut window-per-request t_slow_answers 's#^    _crc=0; _ans=$(curl#    _spent=0; _crc=0; _ans=$(curl#'
  mut quick-ignored t_quick_gates 's#^if \[ "$QUICK" = 1 \]; then$#if false; then#'
  mut quick-always t_deploy_test 's#^if \[ "$QUICK" = 1 \]; then$#if true; then#'
  # upload
  mut lint-off t_lint_failure 's#php -l "$f" >/dev/null 2>\&1 </dev/null#true#; s#^if _out=$($NICE php -l $files .*; then$#if true; then#'
  mut lint-count-unchecked t_lint_single 's#= "$count" \]; then$#-ge 0 ]; then#'
  mut lint-fallback-lints-nothing t_lint_single 's#^  for f in $files; do#  for f in; do#'
  mut lint-one-process-per-file t_lint_single 's#^if _out=$($NICE php -l $files .*; then$#if false; then#'
  mut lint-not-niced t_lint_single 's#^if command -v nice .*#NICE=#'
  mut lint-failure-not-fatal t_lint_failure 's#^run_phase verify || {.*#run_phase verify || :#'
  mut failed-release-kept t_lint_failure 's#^run_phase verify || { discard_release; die#run_phase verify || { die#'
  mut upload-failure-kept t_upload_failure 's#|| { discard_release; die .upload failed#|| { die '"'"'upload failed#'
  mut rsync-delete t_deploy_test 's#rsync -rptz --chmod#rsync -rptz --delete --chmod#'
  mut rsync-to-live-path t_deploy_test 's#"$TASKMIND_DEPLOY_HOST:$PREL/"#"$TASKMIND_DEPLOY_HOST:$PUBLIC/"#'
  mut rsync-to-protected-current-public t_deploy_test 's#"$TASKMIND_DEPLOY_HOST:$PREL/"#"$TASKMIND_DEPLOY_HOST:$PROTECTED/current/public/"#'
  mut rsync-to-protected-current-public-static t_static 's#"$TASKMIND_DEPLOY_HOST:$PREL/"#"$TASKMIND_DEPLOY_HOST:$PROTECTED/current/public/"#'
  mut rsync-lib-to-wrong-dir t_deploy_test 's#"$TASKMIND_DEPLOY_HOST:$REL/lib/"#"$TASKMIND_DEPLOY_HOST:$PROTECTED/lib/"#'
  mut rsync-pattern-globbing t_excludes '/^rsync_up()/,/^)/ s#^  set -f#  :#'
  mut deny-dir-excludes-removed t_excludes 's#^  for _pat in $DENY_DIRS; do set -- "$@" "--exclude=$_pat/"; done#  :#'
  mut deny-name-excludes-removed t_excludes 's#^  for _pat in $DENY_NAMES; do set -- "$@" "--exclude=$_pat"; done#  :#'
  mut closed-entries-not-opened t_upload_modes 's#-exec chmod a+rX {} +#-exec true {} +#'
  mut rsync-chmod-option-removed t_deploy_test 's# --chmod=Dgo+rx,Fgo+r##'
  mut rsync-chmod-numeric t_deploy_test 's#--chmod=Dgo+rx,Fgo+r#--chmod=D755,F644#'
  mut blanket-chmod-back t_static 's#^  echo "opening #  chmod -R a+rX "$PREL" "$REL"; echo "opening #'
  mut protected-chmod-removed t_protected_perms '/^chmod a+rx "$PROTECTED" "$PROTECTED\/releases"$/d'
  mut public-store-chmod-removed t_protected_perms '/^chmod a+rx "$PUBREL"$/d'
  mut release-txt-not-written t_deploy_test '/release\.txt"$/d'
  # switch, verification, rollback
  mut non-atomic-mv t_rollback 's#mv -fh#mv -f#'
  mut rollback-target t_rollback 's#swap_link ".taskmind/$prev" "$PUBLIC"#swap_link ".taskmind/$cur" "$PUBLIC"#'
  mut rollback-build-check-removed t_rollback 's#^\[ -n "$build" \] || fail_with 10.*#:#'
  mut rollback-stamped-flag-ignored t_rollback 's#"$(marker "$_out" TASKMIND_STAMPED)" || return 1#1 || return 1#'
  mut rollback-verifies-wrong-stamp t_rollback 's#^  _prev_stamp=$(marker "$_out" TASKMIND_RELEASE)#  _prev_stamp=20250101000001-1#'
  mut auto-rollback-off t_verification_rolls_back 's#^if ! verify_site "$VERSION" "$STAMP"; then#if false; then#'
  mut page-status-unchecked t_shared_login_page 's#^  if \[ "$_pcode" != 200 \]; then#  if false; then#'
  mut page-any-303 t_shared_login_page 's#^      "303:/account/?next=$_pnext"|"303:$ORIGIN/account/?next=$_pnext") ;;#      303:*) ;;#'
  mut api-check-off t_verification_rolls_back 's#\[ "$_code" = 401 \]#true#'
  mut build-check-off t_verification_rolls_back 's#^  _vrc=0; fetch_fresh build.txt "$_expect" || _vrc=$?#  _vrc=0#'
  mut previous-not-restored t_verification_rolls_back '/^echo "TASKMIND_BUILD=\$build"$/{n;s#^if \[ -n "$STAMP" \]; then#if false; then#;}'
  mut release-txt-not-checked t_same_version 's#^  if \[ "$_has_txt" = 1 \]; then#  if false; then#'
  mut activate-guard-removed t_same_version 's#^\[ "$(link_stamp)" = "$STAMP" \] || fail "the public link does not name.*#:#'
  mut cas-removed t_cas 's#^  \[ "$cur" = "$STAMP" \] || fail_with 11 "the live release is $cur, no longer.*#  :#'
  mut switch-before-lint t_switch_after_lint '/^# Nothing live changes here/a\
swap_link ".taskmind/$STAMP" "$PUBLIC"'
  mut link-created-in-prepare t_first_install 's#^write_deny$#write_deny; ln -s ".taskmind/$STAMP" "$PUBLIC"#'
  mut link-target-under-protected t_deploy_test 's#^swap_link ".taskmind/$STAMP" "$PUBLIC"#swap_link "$REL" "$PUBLIC"#'
  mut link-target-absolute t_deploy_test 's#^swap_link ".taskmind/$STAMP" "$PUBLIC"#swap_link "$PUBREL/$STAMP" "$PUBLIC"#'
  mut previous-written-in-place t_static 's#printf .%s\\n. "$1" > "$_tmp" \&\& mv -f "$_tmp" "$PROTECTED/previous"#printf "%s\\n" "$1" > "$PROTECTED/previous"#'
  # the stamp header, its retry window, the direct-URL refusal, the deny file
  mut api-stamp-check-off t_stamp_header 's#^    \[ "$_rel" != "$_stamp" \] || break#    break#'
  mut api-no-retry t_stamp_header 's#^    spend 1 || { echo "api.php answers as release#    false || { echo "api.php answers as release#'
  mut api-window-too-long t_stamp_header 's#^VERIFY_WINDOW=150#VERIFY_WINDOW=300#'
  mut api-window-too-short t_stamp_header 's#^VERIFY_WINDOW=150#VERIFY_WINDOW=75#'
  mut stale-retry-without-sleep t_stamp_header '/^  while :; do$/,/^  done$/ s#^    sleep 1$#    :#'
  mut stale-retry-sleeps-longer t_stamp_header 's#^    sleep 1$#    sleep 2#'
  mut api-header-name-ignored t_stamp_header 's#tolower($1) == "x-taskmind-release:"#tolower($1) == "x-powered-by:"#'
  mut api-nonzero-status-retried t_verification_rolls_back 's#^    \[ "$_code" = 401 \] || { echo "Unauthenticated API did not deny access: HTTP $_code" >\&2; return 1; }#    [ "$_code" = 401 ] || [ "$_spent" -lt 1 ] || { echo "Unauthenticated API did not deny access: HTTP $_code" >\&2; return 1; }#'
  mut direct-url-check-removed t_public_guard 's#^  case $_ans in 403|404) ;; .*#  :#'
  mut direct-url-accepts-200 t_public_guard 's#case $_ans in 403|404) ;;#case $_ans in 200|403|404) ;;#'
  mut direct-url-wrong-stamp t_deploy_test 's#/.taskmind/$_stamp/index.php" || return 1#/.taskmind/00000000000000-0/index.php" || return 1#'
  mut direct-url-wrong-origin t_deploy_test 's#^ORIGIN=${URL%/TaskMind/}#ORIGIN=${URL%/}#'
  mut deny-file-not-written t_deploy_test 's#^write_deny$#:#'
  mut deny-file-wrong-content t_deploy_test 's#Require all denied#Require all granted#g'
  mut deny-file-not-repaired t_public_guard 's# [&][&] cmp -s "$_tmp" "$PUBREL/.htaccess"##'
  mut deny-file-through-symlink t_public_guard 's# [&][&] \[ ! -L "$PUBREL/.htaccess" \]##'
  mut deny-file-dir-guard-removed t_public_guard 's#^  \[ ! -d "$PUBREL/.htaccess" \] || fail .*#  :#'
  mut public-store-guard-off t_public_guard 's#^  if \[ -L "$PUBREL" \].*#  :#'
  mut public-link-shape-unchecked t_public_guard 's#\[ -n "$(link_stamp)" \] || fail "$PUBLIC is a symlink#true || fail "$PUBLIC is a symlink#'
  mut dangling-link-not-first-install t_first_install 's#^if \[ -n "$old" \] \&\& \[ ! -d "$PUBREL/$old" \]; then old=; fi.*#:#'
  # first install
  mut first-install-stays-live t_first_install 's#^  if \[ "$FIRST" = 1 \]; then#  if false; then#'
  mut unactivate-keeps-public-link t_first_install 's#; then rm -f "$PUBLIC"; fi#; then :; fi#'
  mut unactivate-removes-preexisting-link t_first_install 's#if \[ "$PUBLIC_CREATED" = 1 \] && \[ -L#if [ -L#'
  mut unactivate-cas-removed t_first_install 's#^\[ "$cur" = "$STAMP" \] || fail_with 11 "the public link names.*#:#'
  mut first-release-not-discarded t_first_install 's#^      discard_release$#      :#'
  # lock
  mut lock-not-taken t_lock 's#^take_lock$#:#'
  mut stale-lock-undetected t_lock 's#^  if \[ -n "$(find "$_lock" -prune -mmin +30 2>/dev/null)" \]; then#  if false; then#'
  mut lock-never-released t_deploy_test 's#^trap leave EXIT$#:#'
  mut phase-durations-not-printed t_deploy_test "s#^  printf '    took.*#  :#"
  mut phase-starts-not-timestamped t_deploy_test 's#==> \[%s\] %s#==> %s %s#'
  mut term-not-trapped t_lock 's#^trap .exit 143. TERM$#:#'
  mut foreign-lock-removed t_lock 's#^  \[ "$(sed -n .s/^id=.*belongs to another run; left alone.; return 0; }#  :#'
  mut unlock-failure-fatal t_phase_failures 's#^  run_phase unlock >/dev/null 2>&1 || echo .*#  run_phase unlock >/dev/null 2>\&1 || exit 1#'
  # phase failures
  mut activate-failure-ignored t_phase_failures 's#^\[ "$_rc" = 0 \] || die "activation did not complete.*#:#'
  mut prune-failure-fatal t_phase_failures 's#^run_phase prune || echo .*#run_phase prune#'
  mut prepare-failure-ignored t_phase_failures 's#^  \*) die .host pre-checks failed.*#  *) : ;;#'
  mut rollback-failure-ignored t_phase_failures 's#^  _rc=0; roll_back_and_verify || _rc=\$?#  _rc=0; roll_back_and_verify || _rc=0#'
  mut rollback-unknown-reported-as-refused t_phase_failures 's#10|11|13) return "$_rrc" ;; \*) return 12 ;;#*) return 10 ;;#'
  mut lock-phase-failure-ignored t_phase_failures 's#^    \*) die .could not take the deploy lock.*#    *) : ;;#'
  # host guards
  mut path-guard-exit-removed t_path_guard 's#exit 64 ;;#: ;;#'
  mut path-guard-store-unchecked t_path_guard 's#^case "$PROTECTED:$PUBLIC:$PUBREL:$AUTH:$DATA" in#case "$PROTECTED:$PUBLIC:$AUTH:$DATA" in#; s#:/home/public/TaskMind:/home/public/.taskmind:#:/home/public/TaskMind:#; s#:/home/public/test/TaskMind:/home/public/test/.taskmind:#:/home/public/test/TaskMind:#'
  mut discard-live-guard-removed t_discard_guards 's#^\[ "$(link_stamp)" != "$STAMP" \] || fail "refusing to discard the live release"#:#'
  mut discard-previous-guard-removed t_discard_guards 's#^\[ "$(read_previous)" != "$STAMP" \] || fail "refusing to discard the previous release"#:#'
  mut discard-removes-only-protected t_discard_guards 's#^rm -rf "$PREL" "$REL"#rm -rf "$REL"#'
  mut discard-removes-only-public t_discard_guards 's#^rm -rf "$PREL" "$REL"#rm -rf "$PREL"#'
  mut prune-keeps-no-previous t_prune 's#^  \[ "$d" != "$prev" \] || continue$#  :#'
  mut prune-keeps-no-live t_prune 's#^  \[ "$d" != "$live" \] || continue$#  :#'
  mut prune-follows-symlinks t_prune 's#^    \[ -d "$_dir" \] && \[ ! -L "$_dir" \] || continue#    [ -d "$_dir" ] || continue#'
  mut prune-keep-count-ignored t_prune 's#^  \[ "$n" -gt "$KEEP" \] || continue#  :#'
  mut prune-skips-public-tree t_prune 's#for _dir in "$PUBREL/$d" "$PROTECTED/releases/$d"; do#for _dir in "$PROTECTED/releases/$d"; do#'
  mut prune-skips-protected-tree t_prune 's#for _dir in "$PUBREL/$d" "$PROTECTED/releases/$d"; do#for _dir in "$PUBREL/$d"; do#'
  mut prune-ignores-public-names t_prune 's#ls -1 "$PUBREL" || :;#:;#'
  mut prune-ignores-protected-names t_prune 's#ls -1 "$PROTECTED/releases" || :;#:;#'
  mut prune-removes-non-releases t_prune 's#^  valid_stamp "$d" || continue#  :#'
  mut data-dir-created t_data_dir 's#^check_data$#[ -d "$DATA" ] || mkdir -p "$DATA"; check_data#'
  mut data-dir-check-removed t_data_dir 's#^check_data$#:#'
  mut data-group-check-removed t_data_dir 's#elif \[ "$(ls .* \]; then _why="$DATA does not belong#elif false; then _why="$DATA does not belong#'
  mut data-write-check-removed t_data_dir 's#elif \[ -z "$(find .* \]; then _why="group#elif false; then _why="group#'
  mut php-check-removed t_php_host 's#^\[ -n "$_phpv" \] || fail .*#:#'
  mut php-version-not-printed t_deploy_test 's#^echo "host php: $_phpv"$#:#'
  mut public-guard-off t_public_guard 's#^  elif \[ -e "$PUBLIC" \]; then#  elif false; then#'
  mut previous-dir-guard-off t_public_guard 's#^    { \[ -f "$PROTECTED/previous" \].*|| fail .*#    :#'
  mut previous-stamp-unvalidated t_rollback 's#^  if valid_stamp "$_p"; then echo "$_p"; fi#  echo "$_p"#'
  mut auth-check-off t_auth_guard 's#^check_auth$#:#'
  mut activate-auth-recheck-off t_activate_guards '/^phase_activate() {/,/^EOF$/ s#^check_auth$#:#'
  mut activate-public-recheck-off t_activate_guards '/^phase_activate() {/,/^EOF$/ s#^check_public$#:#'
  mut rollback-same-release-guard-off t_rollback 's#^\[ "$cur" != "$prev" \] || fail_with 10 .*#:#'
  mut rollback-incomplete-guard-off t_rollback 's#^\[ -f "$PUBREL/$prev/index.php" \].*#:#'
  mut rollback-public-recheck-off t_rollback '/^phase_rollback() {/,/^EOF$/ s#^( check_public ) || exit 10.*#:#'
  mut partial-upload-undetected t_upload_failure 's#^\[ "$count" = "$EXPECT_PHP" \] || fail .*#:#'
  # the other scripts
  # the entrypoints (php-cgi against a fake host tree)
  for e in index api; do
    case $e in index) var=INDEX_SRC ;; api) var=API_SRC ;; esac
    f=$ROOT/server/public/TaskMind/$e.php
    mutf "$e-lib-by-pointer" t_entrypoints $var "$f" "s#'/releases/' \. \$stamp \. '/lib'#'/current/lib'#"
    mutf "$e-lib-by-pointer-static" t_static $var "$f" "s#'/releases/' \. \$stamp \. '/lib'#'/current/lib'#"
    mutf "$e-stamp-from-wrong-source" t_entrypoints $var "$f" "s#basename(__DIR__)#'20260101000001-1'#g"
    mutf "$e-stamp-from-realpath" t_static $var "$f" "s#basename(__DIR__)#basename(realpath(__DIR__))#g"
    mutf "$e-stamp-shape-loosened" t_entrypoints $var "$f" 's#\\d{14}-\\d+#.*#'
    mutf "$e-env-override-removed" t_entrypoints $var "$f" "s#getenv('TASKMIND_LIB_DIR') ?: ##"
    mutf "$e-env-override-last" t_entrypoints $var "$f" "s#getenv('TASKMIND_LIB_DIR') ?: (\(.*\));\$#(\1) ?: getenv('TASKMIND_LIB_DIR');#"
    mutf "$e-fails-open" t_entrypoints $var "$f" '/^ *if (\$lib === /d'
    mutf "$e-503-becomes-500" t_entrypoints $var "$f" 's#http_response_code(503); echo#http_response_code(500); echo#'
    mutf "$e-leaks-the-path" t_entrypoints $var "$f" "s#echo 'TaskMind is temporarily unavailable.'#echo \$lib#; s#echo json_encode(\['error' => 'TaskMind is temporarily unavailable.'\])#echo json_encode(['error' => \$lib])#"
  done
  mutf api-release-header-removed t_entrypoints API_SRC "$ROOT/server/public/TaskMind/api.php" '/X-TaskMind-Release/d'
  mutf api-release-header-removed-static t_static API_SRC "$ROOT/server/public/TaskMind/api.php" '/X-TaskMind-Release/d'
  mutf api-release-header-late t_entrypoints API_SRC "$ROOT/server/public/TaskMind/api.php" '/X-TaskMind-Release/d; /\$user = pm_user();/a\
    if (\$stamp !== "" \&\& !getenv("TASKMIND_LIB_DIR")) { header("X-TaskMind-Release: " . \$stamp); }'
  mutf api-release-header-wrong-value t_entrypoints API_SRC "$ROOT/server/public/TaskMind/api.php" "s#'X-TaskMind-Release: ' \. \$stamp#'X-TaskMind-Release: ' . strrev(\$stamp)#"
  mutf api-release-header-with-env t_entrypoints API_SRC "$ROOT/server/public/TaskMind/api.php" "s# \&\& !getenv('TASKMIND_LIB_DIR')##"
  mutf api-release-header-only-when-lib-found t_entrypoints API_SRC "$ROOT/server/public/TaskMind/api.php" "s#^    if (\$stamp !== '' \&\& !getenv('TASKMIND_LIB_DIR')) { header(\(.*\)); }#    if (is_file(\$lib . '/bootstrap.php') \&\& !getenv('TASKMIND_LIB_DIR')) { header(\1); }#"
  mutf package-keeps-stale-lib t_package PACKAGE_SRC "$ROOT/tools/package.mjs" 's#^await rm(.dist/protected., { recursive: true, force: true });#//#'
  mutf package-ships-ds-store t_package PACKAGE_SRC "$ROOT/tools/package.mjs" 's#DS_Store#DS_Storx#g'
  mutf dtp-ancestor-check-removed t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^git merge-base --is-ancestor.*#:#'
  mutf dtp-fetch-removed t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^git fetch -q origin main || .*#:#'
  mutf dtp-remote-tag-check-removed t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^\[ "$_rt" = 2 \] || .*#:#'
  mutf dtp-not-quick t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#--yes-prod --quick; fi#--yes-prod; fi#'
  mutf tdtp-quick t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^if \[ "$FULL" = 1 \]; then sh tools/deploy.sh --prod --yes-prod; else#if false; then :; else#'
  mutf dtp-platforms-before-tag t_dtp DTP_SRC "$ROOT/tools/dtp.sh" '/^git tag "$TAG"$/d; /^git push --atomic origin main/d; $a\
git tag "$TAG"\
git push --atomic origin main "refs/tags/$TAG"'
  mutf dtp-failed-platforms-exit-0 t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^    exit 1$#    :#'
  mutf dtp-web-shipped-not-said t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#The web shipped#Done#'
  mutf dtp-skipped-phone-not-reported t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^  if \[ -n "$_owed" \]; then printf#  if false; then printf#'
  mutf dtp-owed-file-not-passed t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#TASKMIND_OWED_FILE=$OWED_FILE ##'
  mutf tdtp-npm-test-twice t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^\# deploy.sh runs the gates itself.*#[ "$FULL" = 0 ] || npm test#'
  # build-platforms.sh: both phones by default, a phone that is away is owed and skipped, anything else fails the run
  mutf platforms-no-retry t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/^     || devicectl_run/c\
     ; then'
  mutf platforms-no-unlock-advice t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/^    echo "${3:-the phone} is locked/d'
  mutf platforms-first-phone-only t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^  \[ -n "${IOS_PHONES:-}" \] || IOS_PHONES=$(machine_phones taskmind)#  [ -n "${IOS_PHONES:-}" ] || IOS_PHONES=$(machine_phones taskmind | head -1)#'
  mutf platforms-away-not-recognized t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" "s#^PHONE_AWAY=.*#PHONE_AWAY='zzz-never'#"
  mutf platforms-hard-failure-ignored t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^  \[ "$HARD" = 0 \] || exit 1#  :#'
  mutf platforms-owed-file-not-written t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#if \[ -n "${TASKMIND_OWED_FILE:-}" \]; then#if false; then#'
  mutf platforms-skipped-phone-not-owed t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^      PHONES_OWED=$PHONES_OWED"the iOS install#      : "the iOS install#'
  mutf platforms-build-never-paid t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^  IOS_BUILT=1$#  :#'
  mutf platforms-build-failure-not-owed t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" "s#^  \[ \"\$IOS\" = 0 \] || \[ \"\$IOS_BUILT\" = 1 \] || echo .*#  :#"
  mutf platforms-ios-debug-allowed t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/^\[ "$DEBUG" = 0 \] || \[ "$IOS" = 0 \] ||/d'
  mutf platforms-android-icons-not-copied t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/^  cp -R native\/src-tauri\/icons\/android/d'
  mutf platforms-android-x86-built-as-arm t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#x86_64) ARCH=x86_64 ;;#x86_64) ARCH=aarch64 ;;#'
  mutf platforms-android-unknown-abi-built t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^      \*) fail "the ABI of .*#      *) ARCH=aarch64 ;;#'
  mutf platforms-android-debug-installs t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^    echo "built $APK (debug; not installed)"#    adb install -r "$APK"#'
  mutf platforms-android-boots-over-device t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^    if \[ -z "$SERIAL" \]; then#    if true; then#'
  mutf platforms-android-install-failure-ignored t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" "s#\[ \"\$_rc\" = 0 \] || fail 'adb install failed'#:#"
  mutf platforms-android-release-built-as-debug t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#android build --apk --target#android build --debug --apk --target#'
  mutf platforms-android-unsigned-installed t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#install -r "$APK" 2>&1#install -r "$UNSIGNED" 2>\&1#'
  mutf platforms-android-certificate-unchecked t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/certificate DN: $ANDROID_KEY_DN/d'
  mutf platforms-android-signature-unverified t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^    CERTS=$("$APKSIGNER" verify --print-certs "$APK") || fail .*#    CERTS="certificate DN: $ANDROID_KEY_DN"#'
  mutf platforms-android-half-key-remade t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#if \[ -e "$ANDROID_KEYSTORE" \] || \[ -e "$ANDROID_KEYPASS" \]; then#if false; then#; s#if \[ ! -e "$ANDROID_KEYSTORE" \] \&\& \[ ! -e "$ANDROID_KEYPASS" \]; then#if [ ! -e "$ANDROID_KEYPASS" ]; then#'
  mutf platforms-android-key-made-every-run t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#if \[ ! -e "$ANDROID_KEYSTORE" \] \&\& \[ ! -e "$ANDROID_KEYPASS" \]; then#if true; then#'
  mutf platforms-android-password-on-command-line t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#--ks-pass "file:$ANDROID_KEYPASS"#--ks-pass "pass:$(cat "$ANDROID_KEYPASS")"#'
  mutf platforms-android-key-dir-open t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#chmod 700 "$ANDROID_KEY_DIR"#chmod 755 "$ANDROID_KEY_DIR"#'
  mutf platforms-android-uninstall-on-any-failure t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" "s#grep -q 'INSTALL_FAILED_UPDATE_INCOMPATIBLE'#true#"
  mutf platforms-android-half-key-left t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#rm -f "$ANDROID_KEYSTORE" "$ANDROID_KEYPASS"; fail#fail#'
  mutf platforms-android-ndk-unchecked t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" '/^  \[ -n "$NDK_HOME" \] && \[ -d "$NDK_HOME" \] ||/d'
  mutf platforms-android-never-paid t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#^  ANDROID_DONE=1$#  :#'
  mutf platforms-mac-debug-not-flagged t_platforms PLATFORMS_SRC "$PLATFORMS_SRC" 's#npm run build -- --debug --bundles app#npm run build -- --bundles app#'
  mutf dtp-platform-names-dropped t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#tools/build-platforms.sh $PICKED#tools/build-platforms.sh#'
  mutf dtp-platforms-flag-too-small t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#--platforms) PICKED="--mac --ios --android"#--platforms) PICKED="--mac --ios"#'
  mutf dtp-web-still-builds t_dtp DTP_SRC "$ROOT/tools/dtp.sh" 's#^if \[ "$WEB" = 0 \]; then#if true; then#'
  # the store version a release reads, and the rollback that must not go back to a release that cannot read the data
  mut store-marker-check-removed t_store_version '/^if \[ -n "$marker" \]; then$/,/^fi$/d'
  mut store-lower-version-allowed t_store_version '/^  \[ "$have" -ge "$marker" \] || fail_with 13/d'
  mut store-missing-version-file-allowed t_store_version '/^  \[ -n "$have" \] || fail_with 13/d'
  mut store-unreadable-marker-allowed t_store_version 's#^marker=$(store_marker) || fail_with 13 .*#marker=$(store_marker) || marker=#'
  mut store-refusal-reported-as-unknown t_store_version 's#10|11|13) return "$_rrc" ;;#10|11) return "$_rrc" ;;#'
  mut store-marker-file-wrong t_store_version 's#workspace\.version#workspace.versionx#g'
  mut store-refusal-not-loud t_store_version 's#STILL LIVE#live#'
  mut store-version-number-unvalidated t_store_version '/^  case $_n in ..|\*\[!0-9\]\*|???????\*) return 1 ;; esac$/d'
  mut store-version-crosscheck-off t_payload_refused 's#^  \[ "$_sv" = "$_lv" \] || {.*#  :#'
  mut store-version-not-allow-listed t_deploy_test '/^      dist\/protected\/lib\/store-version.txt) ;;$/d'
  mutf package-store-version-not-written t_package PACKAGE_SRC "$ROOT/tools/package.mjs" 's#^await writeFile(.dist/protected/lib/store-version.txt.*#//#'
  mutf package-store-version-hardcoded t_package PACKAGE_SRC "$ROOT/tools/package.mjs" 's#store-version.txt., STORE_VERSION#store-version.txt., 3#'
  mutf package-store-version-unvalidated t_package PACKAGE_SRC "$ROOT/tools/package.mjs" '/^if (!Number.isSafeInteger/d'
  wait
  sort -n "$TMP/mut-results" | cut -f2- | tee "$TMP/mut-report"
  if grep -qE '^(SURVIVED|mutation did not apply)' "$TMP/mut-report"; then echo 'Some mutations were not caught.' >&2; exit 1; fi
  echo 'All mutations were caught.'
}
# ---- Main ----------------------------------------------------------------------------------------------------
case "${1:-}" in
  --mutations) run_mutations; exit $? ;;
  --only) TESTS=${2:?test name} ;;
  '') TESTS=$ALL_TESTS ;;
  *) echo "usage: $0 [--only TEST | --mutations]" >&2; exit 2 ;;
esac
for t in $TESTS; do ( CURRENT_TEST=$t; "$t" ); done
PASSED=$(grep -c '^P' "$TMP/results" || true); FAILED=$(grep -c '^F' "$TMP/results" || true)
printf 'test-deploy: %s checks passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ] && [ "$PASSED" -gt 0 ]
