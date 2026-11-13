#!/bin/sh
# Deploy PlanMind to NearlyFreeSpeech.NET, one way: this Mac -> the host. Default is the TEST instance.
#
#   sh tools/deploy.sh                      test instance
#   sh tools/deploy.sh --prod --yes-prod    production (both flags are required)
#   sh tools/deploy.sh --dry-run            print the plan, audit an existing dist/, contact and write nothing
#   sh tools/deploy.sh --rollback           re-point to the previous release and verify (+ --prod --yes-prod)
#
# Remote layout ([-test] on the test instance; PUBLIC_BASE is /home/public, or /home/public/test on the test instance):
#   $PUBLIC_BASE/PlanMind -> .planmind/<UTC stamp>-<pid>   THE ONE serving pointer: a symlink with a RELATIVE target,
#                              flipped atomically by swap_link; on a first install it is created last
#   $PUBLIC_BASE/.planmind/.htaccess          exactly "Require all denied" (written by the script, not the payload)
#   $PUBLIC_BASE/.planmind/<stamp>/           one public release: index.php api.php icon.svg build.txt .htaccess assets/ release.txt
#   /home/protected/planmind[-test]/releases/<stamp>/lib/   the same release's lib (only PHP reads it)
#   /home/protected/planmind[-test]/previous  a file holding the previous release's stamp (rollback bookkeeping)
#   /home/protected/planmind[-test]/.deploy.lock/            one deploy at a time (owner file inside)
# Why the public pointer: Apache refuses (403, AH00037) any symlink whose target is under /home/protected, and a
# symlink INSIDE the docroot is served; PHP then reports the REAL release directory as __DIR__. So index.php and
# api.php bind to their own lib by that directory's name (releases/<stamp>/lib): a stale cached copy of the old
# entrypoint still pairs with the old lib, and a flip can never mix a new page with an old lib.
# Never touched: /home/protected/planmind-data[-test] (web-owned, provisioned separately; checked, never created; the only
# thing read from it is the plaintext tasks.version marker, by a rollback), the site's own lib[-test]/ (accounts and config,
# read only here) and the parent site's files. rsync never uses
# --delete and only ever writes inside the two new release directories.
#
# Order: gates -> local payload audit -> host pre-checks + lock -> upload to NEW release directories -> lint every PHP
# file on the host and stamp the release (release.txt) -> flip the public link -> verify over HTTPS that THIS release
# is the one served (page, api.php answering 401 with this release's X-PlanMind-Release, release.txt, build.txt, and
# the direct /.planmind/ URL refused; automatic rollback on failure; a failed first install is taken offline again)
# -> prune -> unlock (also on error, Ctrl-C and kill). Every phase prints when it starts and how long it took.
# A rollback (--rollback, or the automatic one) never switches to a release that cannot read the data: every release
# ships lib/store-version.txt (the store version it reads and writes) and the server keeps the version the data was last
# written at in $DATA/tasks.version; the phase that re-points the link reads that one small marker and refuses a target
# whose number is missing or lower. No marker means a store from before the marker existed: allowed as it always was.
set -eu
LC_ALL=C; export LC_ALL
cd "$(dirname "$0")/.."

PROD=0; CONSENT=0; DRY=0; ROLLBACK=0; QUICK=0
for arg in "$@"; do
  case "$arg" in
    --prod) PROD=1 ;;
    --yes-prod) CONSENT=1 ;;
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK=1 ;;
    --quick) QUICK=1 ;;
    --web) : ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done
die() { echo "deploy: $*" >&2; exit 1; }
# Each phase prints when it starts and, when the next one starts (or the run ends, well or badly), how long it took:
# the host was slow for about two minutes around the 2026-11-02 deploys and these lines say which phase it was.
PHASE=; PHASE_T0=0; RUN_T0=0
end_phase() {
  [ -n "$PHASE" ] || return 0
  printf '    took %s s: %s\n' "$(($(date +%s) - PHASE_T0))" "$PHASE"
  PHASE=
}
step() {
  end_phase
  _now=$(date '+%H:%M:%S %s')   # clock time, then epoch seconds
  PHASE_T0=${_now#* }; PHASE=$*
  [ "$RUN_T0" != 0 ] || RUN_T0=$PHASE_T0
  printf '==> [%s] %s\n' "${_now% *}" "$*"
}

if [ "$PROD" = 1 ]; then
  [ "$CONSENT" = 1 ] || die 'Production requires --prod --yes-prod.'
  PUBLIC_BASE=/home/public; PROTECTED=/home/protected/planmind; AUTH=/home/protected/lib
  DATA=/home/protected/planmind-data; URL=https://seancheren.com/PlanMind/; TARGET=PRODUCTION
else
  PUBLIC_BASE=/home/public/test; PROTECTED=/home/protected/planmind-test; AUTH=/home/protected/lib-test
  DATA=/home/protected/planmind-data-test; URL=https://test.seancheren.com/PlanMind/; TARGET=TEST
fi
PUBLIC=$PUBLIC_BASE/PlanMind       # the serving pointer: a symlink, relative target .planmind/<stamp>
PUBREL=$PUBLIC_BASE/.planmind      # the public releases; a stable .htaccess there refuses every direct URL
ORIGIN=${URL%/PlanMind/}           # scheme + host of the page URL, for the one URL that must be refused
# Newest releases kept (the live and the previous release are never pruned, even when older than these).
KEEP=5
# One verification (the new release's, or a rollback's) may spend VERIFY_WINDOW seconds waiting, shared by all its requests.
# Each wait is counted, never read off the clock: a request that got no answer waited its whole CURL_WAIT (curl's --max-time),
# and a value that is still the old release's (the api.php stamp until PHP's realpath cache, 120 s by default, lets go of the
# old entrypoint; a static release.txt or build.txt a slow host has not switched yet) is asked again once a second.
# Why one window: on 2026-11-02 the first PHP request of a new release took over 20 s three deploys in a row, then the live
# site answered in 14-31 s for about two minutes (no error logged, the same lib loading in 0.3 s from the shell).
VERIFY_WINDOW=150
CURL_WAIT=20

# The deploy target names a real login, so it is never tracked: environment, or the ignored deploy.conf.
_env_host=${PLANMIND_DEPLOY_HOST:-}
if [ -f deploy.conf ]; then . ./deploy.conf; fi
[ -z "$_env_host" ] || PLANMIND_DEPLOY_HOST=$_env_host
PLANMIND_DEPLOY_HOST=${PLANMIND_DEPLOY_HOST:-}

VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')

# ---- Payload audit: only PlanMind's public assets/entrypoints and protected lib code may travel ----------
# Deny-list (account, data, secret and build-leftover names; matched case-insensitively, the Mac volume is)
# first, then an allow-list of everything else. The lib allow-list is every flat dist/protected/lib/*.php plus
# store-version.txt: the build copies server/lib into a freshly emptied dist/protected (tools/package.mjs), so only
# real lib files can be there.
DENY_NAMES='config*.php config*.json config*.ini config*.inc config*.yml config*.yaml accounts* passwords* *.enc .key *.key *.pem *.lock .env* deploy.conf* *.map *.sqlite* *.db .htpasswd*'
DENY_DIRS='data data-* *-data planmind-data* accounts* .git .ssh node_modules'

audit_paths() (   # stdin: one dist path per line; prints one "path: reason" line per violation
  set -f
  while IFS= read -r p; do
    [ "$p" != dist ] || continue
    case $p in *[!A-Za-z0-9._/-]*) echo "$p: unexpected characters in the path"; continue ;; esac
    if [ -L "$p" ]; then echo "$p: symlinks may not ship"; continue; fi
    # Data/account locations are denied by any directory in the path (a file's own name is checked below).
    _dir=$p; [ -d "$p" ] || _dir=${p%/*}
    _dir=${_dir#dist}; _dir=${_dir#/}
    if [ -n "$_dir" ]; then
      _old=$IFS; IFS=/; set -- $_dir; IFS=$_old
      for _c in "$@"; do
        _clc=$(printf '%s' "$_c" | tr '[:upper:]' '[:lower:]')
        for _pat in $DENY_DIRS; do
          case $_clc in $_pat) echo "$p: inside a data/account directory ($_c)"; continue 3 ;; esac
        done
      done
    fi
    if [ -d "$p" ]; then
      case $p in
        dist/public|dist/public/PlanMind|dist/public/PlanMind/assets|dist/protected|dist/protected/lib) ;;
        *) echo "$p: directory is not on the PlanMind payload allow-list" ;;
      esac
      continue
    fi
    [ -f "$p" ] || { echo "$p: not a regular file"; continue; }
    _lc=$(printf '%s' "${p##*/}" | tr '[:upper:]' '[:lower:]')
    for _pat in $DENY_NAMES; do
      case $_lc in $_pat) echo "$p: denied file name ($_pat)"; continue 2 ;; esac
    done
    case $p in
      dist/public/PlanMind/index.php|dist/public/PlanMind/api.php|dist/public/PlanMind/build.txt) ;;
      dist/public/PlanMind/icon.svg|dist/public/PlanMind/.htaccess) ;;
      dist/public/PlanMind/assets/*.js|dist/public/PlanMind/assets/*.css|dist/public/PlanMind/assets/*.svg) ;;
      dist/public/PlanMind/assets/*.png|dist/public/PlanMind/assets/*.woff2) ;;
      dist/protected/lib/*.php) case ${p#dist/protected/lib/} in */*) echo "$p: nested lib path" ;; esac ;;
      dist/protected/lib/store-version.txt) ;;
      *) echo "$p: not on the PlanMind payload allow-list" ;;
    esac
  done
  exit 0   # findings are reported on stdout; the caller decides
)

audit_payload() {
  [ ! -L dist ] || { echo 'deploy: dist must be a real directory, not a symlink; refusing to audit through it.' >&2; return 1; }
  [ -d dist/public/PlanMind ] && [ -d dist/protected/lib ] || { echo 'deploy: dist/public/PlanMind and dist/protected/lib are required (run the build).' >&2; return 1; }
  _list=$(find -P dist -print) || { echo 'deploy: could not list all of dist/ (an unreadable entry?); refusing to ship what cannot be audited.' >&2; return 1; }
  _bad=$(printf '%s\n' "$_list" | sort | audit_paths)
  if [ -n "$_bad" ]; then
    printf 'deploy: refusing to ship; the payload holds files that are not PlanMind code or assets:\n%s\n' "$_bad" >&2
    return 1
  fi
  for _f in dist/public/PlanMind/index.php dist/public/PlanMind/api.php dist/public/PlanMind/build.txt \
            dist/public/PlanMind/assets/app.js dist/public/PlanMind/assets/app.css dist/public/PlanMind/.htaccess \
            dist/protected/lib/bootstrap.php dist/protected/lib/planner.php dist/protected/lib/atomic.php \
            dist/protected/lib/limits.php dist/protected/lib/store-version.txt; do
    [ -f "$_f" ] || { echo "deploy: payload is missing $_f" >&2; return 1; }
  done
  # The rollback checks compare store-version.txt with the version the data was written at, so it must be the store version
  # the shipped lib itself reads and writes (limits.php is generated from model.ts and drift-checked by npm run check:limits).
  _sv=$(cat dist/protected/lib/store-version.txt)
  _lv=$(sed -n "s/^  'storeVersion' => \([0-9][0-9]*\),\$/\1/p" dist/protected/lib/limits.php | head -n 1)
  case $_sv in ''|*[!0-9]*) echo 'deploy: dist/protected/lib/store-version.txt must hold just the store version number' >&2; return 1 ;; esac
  [ "$_sv" = "$_lv" ] || { echo "deploy: store-version.txt says '$_sv' but the shipped limits.php reads and writes store version '${_lv:-none}'; run the build again" >&2; return 1; }
  [ "$(cat dist/public/PlanMind/build.txt)" = "$VERSION" ] || { echo "deploy: dist/ is stale: build.txt does not equal package.json version $VERSION" >&2; return 1; }
}

if [ "$DRY" = 1 ]; then
  printf 'PlanMind deploy plan: %s (dry run; nothing is contacted, built or written)\n' "$TARGET"
  printf 'host:         %s\n' "$([ -n "$PLANMIND_DEPLOY_HOST" ] && echo 'set (PLANMIND_DEPLOY_HOST)' || echo 'NOT SET: a real run needs PLANMIND_DEPLOY_HOST or deploy.conf')"
  if [ "$ROLLBACK" = 1 ]; then
    printf 'action:       lock, re-point %s to the release named by %s/previous (only if it can read the data: its lib/store-version.txt\n' "$PUBLIC" "$PROTECTED"
    printf '              is not lower than %s/tasks.version), verify it by its own release stamp, unlock\n' "$DATA"
  else
    printf 'action:       gates (check:core, tests, build, %s), payload audit, lock, upload to a new release, lint every PHP file there (one php process),\n' "$([ "$QUICK" = 1 ] && echo 'spot e2e' || echo e2e)"
    printf '              flip the public link, verify THIS release is served, roll back automatically if verification fails\n'
    printf '              (a failed first install is taken offline again), prune, unlock\n'
    printf 'new release:  %s/<UTC stamp>-<pid>/ (public) and %s/releases/<UTC stamp>-<pid>/lib/ (protected)\n' "$PUBREL" "$PROTECTED"
    if [ -d dist ]; then
      audit_payload || exit 1
      echo 'payload:      current dist/ passes the audit'
    else
      echo 'payload:      dist/ is not built yet; a real run builds it and audits it before any upload'
    fi
  fi
  printf 'pointer:      %s -> .planmind/<stamp>  (relative symlink, the only serving pointer; the previous stamp is kept in %s/previous; newest %s releases kept)\n' "$PUBLIC" "$PROTECTED" "$KEEP"
  printf 'lock:         %s/.deploy.lock (one deploy at a time; reported as stale after 30 minutes, never broken automatically)\n' "$PROTECTED"
  printf 'public path:  %s (symlink, created last on a first install; a real directory or foreign symlink there aborts)\n' "$PUBLIC"
printf 'public store: %s (releases; its .htaccess is "Require all denied": Apache refuses symlinks into /home/protected, so the public code lives under the docroot)\n' "$PUBREL"
  printf 'auth library: %s (read only; must already exist)\n' "$AUTH"
  printf 'data:         %s (never touched or created; must exist, group web, group-writable)\n' "$DATA"
  printf 'verify:       %s (page 200 or the shared-login 303 to /account/, api.php 401 with X-PlanMind-Release = this release, release.txt = this release, build.txt = release version, %s/.planmind/<stamp>/ refused; every request asked again inside one %s s window)\n' "$URL" "$ORIGIN" "$VERIFY_WINDOW"
  echo 'Only PlanMind code is sent; existing account configuration and planner data are excluded.'
  exit 0
fi

[ -n "$PLANMIND_DEPLOY_HOST" ] || die 'Set PLANMIND_DEPLOY_HOST (environment or the ignored deploy.conf) to the existing NFSN SSH login.'
case $PLANMIND_DEPLOY_HOST in -*|*@-*|*@*@*|*[!A-Za-z0-9@._-]*) die 'PLANMIND_DEPLOY_HOST must look like login@host (letters, digits, . _ - and one @; no colon).' ;; esac
command -v ssh >/dev/null || die 'ssh is required.'
command -v curl >/dev/null || die 'curl is required.'
[ "$ROLLBACK" = 1 ] || command -v rsync >/dev/null || die 'rsync is required.'

# ---- Remote scripts ------------------------------------------------------------------------------------------
# Each phase is ONE script piped to `ssh host sh -s`: a generated header of quoted assignments, the shared
# functions, then the phase body. Nothing is interpolated into an ssh command line. The remote userland is
# FreeBSD: portable sh and base utilities only.
# Remote exit codes the local side acts on: 10 refused, nothing changed; 11 this run's release is not the
# live one, nothing changed; 12 switched, but the bookkeeping after the switch failed; 13 refused because the
# release to go back to cannot read the data (see store_marker), nothing changed; 75 deploy lock held;
# 76 deploy lock held and older than 30 minutes (stale); 64 unexpected paths. Anything else is "unknown".
run_phase() {
  { printf '# planmind-phase: %s\n' "$1"; remote_header; remote_lib; "phase_$1"; } | ssh -o BatchMode=yes "$PLANMIND_DEPLOY_HOST" sh -s
}

remote_header() {
  printf 'set -eu\numask 022\n'
  printf "PUBLIC='%s'\nPUBREL='%s'\nPROTECTED='%s'\nAUTH='%s'\nDATA='%s'\nSTAMP='%s'\nEXPECT_PHP='%s'\nKEEP='%s'\n" \
    "$PUBLIC" "$PUBREL" "$PROTECTED" "$AUTH" "$DATA" "${STAMP:-}" "${EXPECT_PHP:-0}" "$KEEP"
  printf "RESTORE_PREV='%s'\nPUBLIC_CREATED='%s'\nLOCK_ID='%s'\nLOCK_WHO='%s'\nWEB_GROUP='web'\n" \
    "${RESTORE_PREV:-}" "${PUBLIC_CREATED:-0}" "${RUN_ID:-}" "${LOCK_WHO:-}"
  printf 'REL="$PROTECTED/releases/$STAMP"\nPREL="$PUBREL/$STAMP"\n'
}

remote_lib() { cat <<'EOF'
fail_with() { _code=$1; shift; echo "planmind deploy: $*" >&2; exit "$_code"; }
fail() { fail_with 1 "$@"; }
# The only paths these scripts may ever work in: exactly the production or the test set.
case "$PROTECTED:$PUBLIC:$PUBREL:$AUTH:$DATA" in
  /home/protected/planmind:/home/public/PlanMind:/home/public/.planmind:/home/protected/lib:/home/protected/planmind-data) ;;
  /home/protected/planmind-test:/home/public/test/PlanMind:/home/public/test/.planmind:/home/protected/lib-test:/home/protected/planmind-data-test) ;;
  *) echo 'planmind deploy: refusing unexpected paths' >&2; exit 64 ;;
esac

# The host is shared with the live site, which answered in 14-31 s for about two minutes around the 2026-11-02 deploys:
# the walking and linting below run at low priority so the web processes keep the CPU.
if command -v nice >/dev/null 2>&1; then NICE='nice -n 10'; else NICE=; fi

# THE atomic switch: the public link goes through this one function.
# ln -s builds the new link under a temporary name beside the pointer, then mv -f renames it over the
# pointer. rename(2) replaces a symlink in a single step, so a request sees the old release or the new
# one, never neither and never a mix. The target is RELATIVE (.planmind/<stamp>): the link and its releases
# share one directory, which is what lets Apache serve it.
# -h is essential on FreeBSD (and macOS): the pointer is a symlink to a DIRECTORY, and without -h both
# ln and mv follow it, creating or moving the new link INSIDE the old release instead of replacing the
# pointer. (GNU userland spells these ln -n and mv -T; the host is FreeBSD.)
swap_link() {   # $1 = link target (relative to the pointer's directory), $2 = the pointer
  _target=$1; _link=$2; _tmp=$_link.new.$$
  rm -f "$_tmp"
  ln -sfh "$_target" "$_tmp"
  mv -fh "$_tmp" "$_link"
}

valid_stamp() {   # <digits>-<digits>, nothing else: the only names ever used as a release directory
  case $1 in ''|*[!0-9-]*|-*|*-|*-*-*) return 1 ;; esac
  case $1 in *-*) return 0 ;; esac
  return 1
}

link_stamp() {   # the release the public link names (.planmind/<stamp>), or nothing
  _t=$(readlink "$PUBLIC" 2>/dev/null) || return 0
  case $_t in
    .planmind/*) if valid_stamp "${_t#.planmind/}"; then echo "${_t#.planmind/}"; fi ;;
  esac
}

read_previous() {   # the stamp in $PROTECTED/previous, or nothing
  [ -f "$PROTECTED/previous" ] || return 0   # (deploy and rollback refuse a previous that is not a plain file before they get here)
  _p=$(head -n 1 "$PROTECTED/previous" 2>/dev/null) || return 0
  if valid_stamp "$_p"; then echo "$_p"; fi
}

write_previous() {   # $1 = stamp; a temporary file beside it, then one rename
  _tmp=$PROTECTED/previous.new.$$
  printf '%s\n' "$1" > "$_tmp" && mv -f "$_tmp" "$PROTECTED/previous"
}

store_number() {   # the store version in file $1 (digits only, at most six); returns 1 when there is no such number
  [ -f "$1" ] || return 1
  _n=$(head -n 1 "$1" 2>/dev/null | tr -d ' \r') || return 1
  case $_n in ''|*[!0-9]*|???????*) return 1 ;; esac
  echo "$_n"
}

# The version the data was last written at, from the plaintext marker the server leaves beside the encrypted store (just the
# number; nothing encrypted is read). Prints nothing when there is no marker: a store from before the marker existed, which every
# release can read. Returns 1 when a marker is there but is no number or cannot be read: then nothing is known, so the
# caller refuses. A data directory this login cannot search hides the marker, so the check is skipped, loudly.
store_marker() {
  if [ -d "$DATA" ] && [ ! -x "$DATA" ]; then
    echo "planmind deploy: note: this login cannot search $DATA, so the data's store version was not checked" >&2
    return 0
  fi
  [ -e "$DATA/tasks.version" ] || [ -L "$DATA/tasks.version" ] || return 0
  store_number "$DATA/tasks.version"
}

# One deploy (or rollback) at a time: a directory is the lock (mkdir is atomic), its owner file names the run.
# It is never broken automatically; a lock older than 30 minutes is reported as stale (exit 76) so a human decides.
take_lock() {
  [ -n "$LOCK_ID" ] || fail 'internal error: no lock id'
  _lock=$PROTECTED/.deploy.lock
  if mkdir "$_lock" 2>/dev/null; then
    printf 'id=%s\nwho=%s\n' "$LOCK_ID" "$LOCK_WHO" > "$_lock/owner"
    return 0
  fi
  _who=$(sed -n 's/^who=//p' "$_lock/owner" 2>/dev/null | head -n 1)
  _when=$(ls -ld "$_lock" 2>/dev/null | awk '{print $6, $7, $8}')
  if [ -n "$(find "$_lock" -prune -mmin +30 2>/dev/null)" ]; then
    fail_with 76 "the deploy lock $_lock is older than 30 minutes (taken by ${_who:-unknown}, ${_when:-time unknown}); it looks stale"
  fi
  fail_with 75 "another deploy holds the lock $_lock (taken by ${_who:-unknown}, ${_when:-time unknown})"
}

release_lock() {   # removes the lock only when this run owns it
  _lock=$PROTECTED/.deploy.lock
  [ -n "$LOCK_ID" ] || return 0
  [ -d "$_lock" ] || { echo 'no deploy lock to release'; return 0; }
  [ "$(sed -n 's/^id=//p' "$_lock/owner" 2>/dev/null | head -n 1)" = "$LOCK_ID" ] || { echo 'the deploy lock belongs to another run; left alone'; return 0; }
  rm -rf "$_lock"
  echo 'deploy lock released'
}

check_auth() {   # the site's account library is reused, read only; it must already be there
  [ -f "$AUTH/auth.php" ] || fail "$AUTH/auth.php is missing; PlanMind reuses the site's account library"
  [ -f "$AUTH/config.php" ] || fail "$AUTH/config.php is missing"
  for _dep in $(sed -n "s#^require_once __DIR__ \. '/\([A-Za-z0-9_.-]*\)'.*#\1#p" "$AUTH/auth.php"); do
    [ -f "$AUTH/$_dep" ] || fail "$AUTH/$_dep is missing (required by auth.php)"
  done
}

check_public() {   # the public path must be absent or already our symlink; a real directory is never replaced
  if [ -L "$PUBLIC" ]; then
    [ -n "$(link_stamp)" ] || fail "$PUBLIC is a symlink to somewhere other than a $PUBREL release ($(readlink "$PUBLIC")); move it aside by hand once, the deploy never repoints it"
  elif [ -e "$PUBLIC" ]; then
    fail "$PUBLIC exists and is not the release symlink; move it aside by hand once, the deploy never replaces it"
  else
    [ -d "$(dirname "$PUBLIC")" ] || fail "$(dirname "$PUBLIC") does not exist"
  fi
  # the release store must be a real directory (a symlink or file there would redirect or block every release)
  if [ -L "$PUBREL" ] || { [ -e "$PUBREL" ] && [ ! -d "$PUBREL" ]; }; then fail "$PUBREL exists but is not a plain directory; refusing"; fi
  # previous is a plain file: it is replaced by a rename, which would swallow the new file if this were a directory
  if [ -e "$PROTECTED/previous" ] || [ -L "$PROTECTED/previous" ]; then
    { [ -f "$PROTECTED/previous" ] && [ ! -L "$PROTECTED/previous" ]; } || fail "$PROTECTED/previous exists but is not a plain file; refusing"
  fi
}

check_data() {   # the app stores its encrypted data there as the web user; it is never created or changed here
  _why=
  if [ ! -d "$DATA" ]; then _why="$DATA does not exist"
  elif [ "$(ls -ld "$DATA/." | awk '{print $4}')" != "$WEB_GROUP" ]; then _why="$DATA does not belong to group $WEB_GROUP"
  elif [ -z "$(find "$DATA/." -prune -perm -070)" ]; then _why="group $WEB_GROUP cannot write in $DATA"
  fi
  [ -z "$_why" ] || fail "the data directory is not ready: $_why.
The app is unusable without it. Provision it once, on the host:
  mkdir -p $DATA && chgrp $WEB_GROUP $DATA && chmod 2770 $DATA
(the deploy never creates or changes it)"
}

write_deny() {   # $PUBREL/.htaccess is exactly "Require all denied": no release is ever reachable by its direct URL
  [ ! -d "$PUBREL/.htaccess" ] || fail "$PUBREL/.htaccess is a directory; refusing"
  _tmp=$PUBREL/.htaccess.new.$$
  printf 'Require all denied\n' > "$_tmp"
  chmod 644 "$_tmp"
  if [ -f "$PUBREL/.htaccess" ] && [ ! -L "$PUBREL/.htaccess" ] && cmp -s "$_tmp" "$PUBREL/.htaccess"; then
    rm -f "$_tmp"
  else
    mv -f "$_tmp" "$PUBREL/.htaccess"
    echo "wrote $PUBREL/.htaccess"
  fi
}
EOF
}

phase_prepare() { cat <<'EOF'
# Read-only checks of everything the app depends on, then the lock and empty release directories beside the live paths.
valid_stamp "$STAMP" || fail "bad release name"
check_auth
check_public
check_data
_phpv=$(php -v 2>/dev/null </dev/null | head -n 1)
[ -n "$_phpv" ] || fail "php is not available to this SSH login (php -v printed nothing); the lint step needs the CLI"
echo "host php: $_phpv"
mkdir -p "$PROTECTED/releases"
chmod a+rx "$PROTECTED" "$PROTECTED/releases"
take_lock
mkdir -p "$PUBREL"
chmod a+rx "$PUBREL"
write_deny
mkdir "$REL" "$PREL"
mkdir "$REL/lib"
echo "prepared $PREL and $REL"
EOF
}

phase_lock() { cat <<'EOF'
# A standalone rollback takes the same lock a deploy does. Nothing is created when nothing is deployed.
[ -d "$PROTECTED/releases" ] || fail_with 10 "nothing is deployed in $PROTECTED; there is nothing to roll back"
take_lock
echo "locked"
EOF
}

phase_unlock() { cat <<'EOF'
release_lock
EOF
}

phase_verify() { cat <<'EOF'
# Nothing live changes here. Every uploaded PHP file must lint; the first bad one fails the whole deploy.
[ -d "$PREL" ] && [ -d "$REL/lib" ] || fail "release $STAMP was not uploaded"
files=$(find "$PREL" "$REL" -type f -name '*.php' | sort)
count=$(printf '%s\n' "$files" | grep -c . || true)
[ "$count" = "$EXPECT_PHP" ] || fail "expected $EXPECT_PHP PHP files in the release, found $count"
# One php process lints them all (PHP 8.3 takes several files): a process per file was most of this phase's cost on a host
# that was already slow. Older PHP lints only the first file and says nothing about the rest, so the one call counts as done
# only when it reported every file clean; anything else (an error, an older PHP) falls back to a process per file, which also
# names the file that fails. Release file names are digits, letters and . _ - only (the audit), so $files splits cleanly.
linted=
if _out=$($NICE php -l $files 2>&1 </dev/null) && [ "$(printf '%s\n' "$_out" | grep -c '^No syntax errors detected in ')" = "$count" ]; then
  linted="in one php process"
else
  for f in $files; do
    $NICE php -l "$f" >/dev/null 2>&1 </dev/null || { echo "planmind deploy: PHP lint failed: $f" >&2; php -l "$f" >&2 </dev/null || true; exit 1; }
  done
  linted="file by file"
fi
for f in "$PREL/index.php" "$PREL/api.php" "$PREL/build.txt" "$PREL/assets/app.js" "$PREL/assets/app.css" "$PREL/.htaccess" \
         "$REL/lib/bootstrap.php" "$REL/lib/planner.php" "$REL/lib/atomic.php" "$REL/lib/store-version.txt"; do
  [ -f "$f" ] || fail "the uploaded release is missing $f"
done
# The host stamps the release with its own name: HTTPS verification then proves WHICH release is served, even when
# the version string did not change. Written here, so it is never part of the audited payload.
printf '%s\n' "$STAMP" > "$PREL/release.txt"
# The web server must be able to read all of it. rsync's --chmod does that for what it sends (GNU rsync); macOS's own rsync
# (openrsync) accepts the option and ignores it. So look once, and open only what is still closed, entry by entry: no blanket
# recursive chmod over the whole release on every deploy.
closed=$($NICE find "$PREL" "$REL" \( -type f ! -perm -004 \) -o \( -type d ! -perm -005 \))
if [ -n "$closed" ]; then
  echo "opening $(printf '%s\n' "$closed" | wc -l | tr -d ' ') entries the upload left closed (this rsync ignores --chmod)"
  $NICE find "$PREL" "$REL" \( \( -type f ! -perm -004 \) -o \( -type d ! -perm -005 \) \) -exec chmod a+rX {} +
  unreadable=$($NICE find "$PREL" "$REL" \( \( -type f ! -perm -004 \) -o \( -type d ! -perm -005 \) \) | head -n 1)
  [ -z "$unreadable" ] || fail "not world-readable after chmod: $unreadable"
fi
echo "release $STAMP: $count PHP files lint clean ($linted), stamped, permissions set"
EOF
}

phase_activate() { cat <<'EOF'
# The only phase that changes what is served. Everything above has passed; the flip is the last write.
valid_stamp "$STAMP" || fail "bad release name"
[ -d "$PREL" ] && [ -d "$REL/lib" ] || fail "release $STAMP is missing"
check_auth
check_public
old=$(link_stamp)
if [ -n "$old" ] && [ ! -d "$PUBREL/$old" ]; then old=; fi   # a link naming a release that is gone serves nothing: not a live release
prev_before=$(read_previous)
# First install only: nothing exists at the public path (checked above), or only a link to a release that is gone,
# so flipping it overwrites nothing that was serving.
created=0; if [ ! -L "$PUBLIC" ] || [ -z "$old" ]; then created=1; fi
if [ -n "$old" ] && [ "$old" != "$STAMP" ]; then write_previous "$old"; fi
swap_link ".planmind/$STAMP" "$PUBLIC"
[ "$(link_stamp)" = "$STAMP" ] || fail "the public link does not name $STAMP after the switch"
echo "activated $STAMP (previous: ${old:-none})"
[ -n "$old" ] || echo "PLANMIND_FIRST_INSTALL=1"
echo "PLANMIND_PUBLIC_CREATED=$created"
echo "PLANMIND_PREVIOUS_BEFORE=$prev_before"
EOF
}

phase_unactivate() { cat <<'EOF'
# A first install that failed verification goes back to "not installed": nothing was live before it. Only this
# run's own release is taken offline, and the public link only if this run created it.
cur=$(link_stamp)
[ "$cur" = "$STAMP" ] || fail_with 11 "the public link names '${cur:-none}', not $STAMP; refusing to take another run's release offline"
if [ "$PUBLIC_CREATED" = 1 ] && [ -L "$PUBLIC" ]; then rm -f "$PUBLIC"; fi
echo "taken offline: $STAMP (not installed)"
EOF
}

phase_rollback() { cat <<'EOF'
# Manual (STAMP empty): swap the live and the previous release. Automatic (STAMP = the release this run just
# activated): only when that release is still live (compare-and-swap), and previous is restored to what it was before it.
( check_public ) || exit 10   # a link, release store or previous file of the wrong kind: refused, nothing changed
cur=$(link_stamp)
prev=$(read_previous)
[ -n "$cur" ] || fail_with 10 "no live release"
if [ -n "$STAMP" ]; then
  [ "$cur" = "$STAMP" ] || fail_with 11 "the live release is $cur, no longer $STAMP; refusing to roll back another run's release"
fi
[ -n "$prev" ] || fail_with 10 "no previous release is recorded"
[ "$cur" != "$prev" ] || fail_with 10 "the previous release is the live one; nothing to roll back to"
[ -f "$PUBREL/$prev/index.php" ] && [ -f "$PROTECTED/releases/$prev/lib/bootstrap.php" ] || fail_with 10 "previous release $prev is incomplete or gone"
build=$(cat "$PUBREL/$prev/build.txt" 2>/dev/null || true)
[ -n "$build" ] || fail_with 10 "previous release $prev has no readable build.txt, so it could not be verified"
# Never switch to a release that cannot read the data: one small plaintext marker is read here, in the phase that re-points the
# link (no other round trip, nothing encrypted is opened). Its store version must not be lower than the one the data was last
# written at. No marker: a store from before markers existed, which any release reads (the behavior until now).
marker=$(store_marker) || fail_with 13 "$DATA/tasks.version exists but holds no readable store version number; refusing to switch to a release that may not be able to read the data"
if [ -n "$marker" ]; then
  have=$(store_number "$PROTECTED/releases/$prev/lib/store-version.txt") || have=
  [ -n "$have" ] || fail_with 13 "release $prev has no lib/store-version.txt, so it cannot be shown to read the data (written at store version $marker); refusing to switch to it"
  [ "$have" -ge "$marker" ] || fail_with 13 "release $prev reads store version $have but the data was written at store version $marker; refusing to switch to a release that cannot read it"
fi
stamped=0; [ ! -f "$PUBREL/$prev/release.txt" ] || stamped=1
swap_link ".planmind/$prev" "$PUBLIC"
echo "PLANMIND_SWITCHED=1"
echo "PLANMIND_RELEASE=$prev"
echo "PLANMIND_STAMPED=$stamped"
echo "PLANMIND_BUILD=$build"
if [ -n "$STAMP" ]; then
  if [ -n "$RESTORE_PREV" ] && [ "$RESTORE_PREV" != "$prev" ] && [ -f "$PUBREL/$RESTORE_PREV/index.php" ] && [ -f "$PROTECTED/releases/$RESTORE_PREV/lib/bootstrap.php" ]; then
    write_previous "$RESTORE_PREV" || fail_with 12 "the public link was switched, but previous could not be restored"
  else
    rm -f "$PROTECTED/previous" || fail_with 12 "the public link was switched, but previous could not be cleared"
  fi
else
  write_previous "$cur" || fail_with 12 "the public link was switched, but previous could not be updated"
fi
echo "rolled back $cur -> $prev"
EOF
}

phase_prune() { cat <<'EOF'
# Runs only after the new release verified. Across BOTH trees (the public releases and the protected lib releases) it
# keeps the newest $KEEP release names, and never the live or the previous release. Only <digits>-<digits> real
# directories are ever removed.
live=$(link_stamp)
prev=$(read_previous)
n=0
for d in $( { ls -1 "$PROTECTED/releases" || :; ls -1 "$PUBREL" || :; } 2>/dev/null | sort -ur ); do
  valid_stamp "$d" || continue
  n=$((n + 1))
  [ "$n" -gt "$KEEP" ] || continue
  [ "$d" != "$live" ] || continue
  [ "$d" != "$prev" ] || continue
  for _dir in "$PUBREL/$d" "$PROTECTED/releases/$d"; do
    [ -d "$_dir" ] && [ ! -L "$_dir" ] || continue
    rm -rf "$_dir"
    echo "pruned release $_dir"
  done
done
EOF
}

phase_discard() { cat <<'EOF'
# Remove the release (both directories) this run created but never activated.
valid_stamp "$STAMP" || fail "bad release name"
[ "$(link_stamp)" != "$STAMP" ] || fail "refusing to discard the live release"
[ "$(read_previous)" != "$STAMP" ] || fail "refusing to discard the previous release"
rm -rf "$PREL" "$REL"
EOF
}

# ---- Local helpers -------------------------------------------------------------------------------------------
rsync_up() (   # $1 = local dir/, $2 = host:release dir/. Adds only; --delete is never used.
  set -f   # the deny patterns stay literal: never expanded against the working directory
  _src=$1; _dest=$2; shift 2
  set --
  for _pat in $DENY_NAMES; do set -- "$@" "--exclude=$_pat"; done
  for _pat in $DENY_DIRS; do set -- "$@" "--exclude=$_pat/"; done
  # --chmod opens what is sent to the web server (GNU rsync). macOS's own rsync accepts it and ignores it; the verify phase
  # opens whatever is left closed. Symbolic on purpose: openrsync rejects the numeric D755,F644 form outright.
  rsync -rptz --chmod=Dgo+rx,Fgo+r -e 'ssh -o BatchMode=yes' "$@" "$_src" "$_dest"
)

discard_release() {
  run_phase discard >/dev/null 2>&1 || echo "warning: could not remove the unused release $STAMP; it is harmless and is pruned later" >&2
}

marker() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }   # value of a PLANMIND_* line in a phase's output

new_run_id() { printf '%s-%s' "$(date -u +%Y%m%d%H%M%S)" "$$"; }

_spent=0
spend() {   # spend <seconds>: adds a wait to this verification's total; fails once the window is used up
  _spent=$((_spent + $1))
  [ "$_spent" -le "$VERIFY_WINDOW" ]
}

# One verification request. 0 = answered, the answer is in $_ans; 22 = answered with an HTTP error (curl -f); 1 = no answer
# for as long as the window lasts (said on stderr). A request that gets no answer is asked again: a timeout has waited its
# whole CURL_WAIT; any other failure (a reset, a refusal) comes back at once, so it is charged a second and waits it.
ask() {   # ask <what> <curl args...>
  _what=$1; shift
  while :; do
    _crc=0; _ans=$(curl -sS --max-time "$CURL_WAIT" "$@") || _crc=$?
    case $_crc in 0|22) return "$_crc" ;; esac
    if [ "$_crc" = 28 ]; then _cost=$CURL_WAIT; else _cost=1; fi
    spend "$_cost" || { echo "PlanMind $_what verification failed: no response from $URL within $VERIFY_WINDOW s" >&2; return 1; }
    echo "the $_what request got no answer in $_cost s; asking again ($_spent of $VERIFY_WINDOW s used)" >&2
    [ "$_crc" = 28 ] || sleep 1
  done
}

# release.txt and build.txt are plain files that switch with the link, but a slow host can serve the old ones for a while:
# a value that is not the expected one yet is asked again once a second. 0 = it matches; 1 = failed (said); 3 = still the
# wrong value when the window ran out (it is in $_ans, the caller says what that means).
fetch_fresh() {   # fetch_fresh <file> <expected value>
  while :; do
    _arc=0; ask "$1" -f "${URL}$1" || _arc=$?
    [ "$_arc" != 22 ] || { echo "Served $1 could not be fetched." >&2; return 1; }
    [ "$_arc" = 0 ] || return 1
    [ "$_ans" != "$2" ] || return 0
    spend 1 || return 3
    sleep 1
  done
}

verify_site() {   # $1 = build.txt the live release serves; $2 = its release stamp; $3 = 0 when it has no release.txt (default 1)
  _expect=$1; _stamp=$2; _has_txt=${3:-1}
  # Every request is asked again when it gets no answer, inside the one window this verification has (see VERIFY_WINDOW).
  # An answer that is wrong in a final way (the page not 200, api.php not 401, the direct URL served) ends it at once.
  _spent=0
  # The page answers 200 (a legacy sign-in, or an app still held), or, once the suite's shared login is on and the app is not
  # held, exactly one 303: to this instance's /account/ with next = the app's own path, URL-encoded (no redirect is followed).
  # Anything else, including another 303, a 302 and a 500, is final.
  ask page -o /dev/null -D - -w 'HTTP_CODE=%{http_code}\n' "$URL" || return 1
  _pcode=$(printf '%s\n' "$_ans" | sed -n 's/^HTTP_CODE=//p' | tail -n 1)
  if [ "$_pcode" != 200 ]; then
    _ploc=$(printf '%s\n' "$_ans" | tr -d '\r' | awk 'tolower($1) == "location:" { print $2; exit }')
    _pnext=$(printf '%s' "${URL#"$ORIGIN"}" | sed 's#/#%2F#g')   # the app's own path, /PlanMind/, URL-encoded
    case $_pcode:$_ploc in
      "303:/account/?next=$_pnext"|"303:$ORIGIN/account/?next=$_pnext") ;;
      *) echo "PlanMind page verification failed: HTTP $_pcode${_ploc:+ to $_ploc}" >&2; return 1 ;;
    esac
  fi
  # api.php must refuse AND name the release that answered (X-PlanMind-Release). Right after a flip PHP can keep running
  # the OLD entrypoint for a moment (it caches by the link's path), still paired with its own lib; static files switch
  # at once. So a stale stamp is asked again once a second inside the window; any status but 401 is final.
  while :; do
    ask api.php -o /dev/null -D - -w 'HTTP_CODE=%{http_code}\n' "${URL}api.php" || return 1
    _code=$(printf '%s\n' "$_ans" | sed -n 's/^HTTP_CODE=//p' | tail -n 1)
    _rel=$(printf '%s\n' "$_ans" | tr -d '\r' | awk 'tolower($1) == "x-planmind-release:" { print $2; exit }')
    [ "$_code" = 401 ] || { echo "Unauthenticated API did not deny access: HTTP $_code" >&2; return 1; }
    [ "$_rel" != "$_stamp" ] || break
    spend 1 || { echo "api.php answers as release '${_rel:-none}', not '$_stamp', after $_spent seconds: the release being checked is not what PHP runs." >&2; return 1; }
    sleep 1
  done
  if [ "$_has_txt" = 1 ]; then
    _vrc=0; fetch_fresh release.txt "$_stamp" || _vrc=$?
    [ "$_vrc" = 0 ] || { [ "$_vrc" != 3 ] || echo "Served release '$_ans' is not release '$_stamp' after $_spent seconds: the release being checked is not what is live." >&2; return 1; }
  fi
  _vrc=0; fetch_fresh build.txt "$_expect" || _vrc=$?
  [ "$_vrc" = 0 ] || { [ "$_vrc" != 3 ] || echo "Served version '$_ans' does not match the release '$_expect' after $_spent seconds." >&2; return 1; }
  # the release store must never be reachable by its direct URL (only through the public link)
  ask 'direct URL' -o /dev/null -w '%{http_code}' "$ORIGIN/.planmind/$_stamp/index.php" || return 1
  case $_ans in 403|404) ;; *) echo "$ORIGIN/.planmind/$_stamp/index.php answered HTTP $_ans: the release store is reachable by its direct URL." >&2; return 1 ;; esac
  printf 'Verified %s (%s, release %s)\n' "$URL" "$_expect" "$_stamp"
}

roll_back_and_verify() {
  # 0 = the previous release is back and verified; 1 = switched, but it did not verify; 10 = refused, nothing changed;
  # 11 = this run's release is no longer the live one, nothing changed; 12 = outcome unknown (no clean answer from the host);
  # 13 = refused because the previous release cannot read the data, nothing changed
  _rrc=0; _out=$(run_phase rollback) || _rrc=$?
  printf '%s\n' "$_out"
  case $_out in
    *PLANMIND_SWITCHED=1*) ;;
    *) case $_rrc in 10|11|13) return "$_rrc" ;; *) return 12 ;; esac ;;
  esac
  _prev_build=$(marker "$_out" PLANMIND_BUILD)
  _prev_stamp=$(marker "$_out" PLANMIND_RELEASE)
  [ -n "$_prev_build" ] && [ -n "$_prev_stamp" ] || return 1
  verify_site "$_prev_build" "$_prev_stamp" "$(marker "$_out" PLANMIND_STAMPED)" || return 1
}

# ---- The deploy lock (on the host) and its release -------------------------------------------------------------
LOCK_TRIED=0
LOCK_WHO=$(printf '%s@%s' "$(id -un 2>/dev/null || echo user)" "$(hostname 2>/dev/null || echo mac)" | tr -c 'A-Za-z0-9@._-' '_')
lock_clear_cmd() { printf "ssh %s 'rm -rf %s/.deploy.lock'" "$PLANMIND_DEPLOY_HOST" "$PROTECTED"; }
release_lock() {   # sent on every way out once a lock was tried; the host removes it only if this run owns it
  [ "$LOCK_TRIED" = 1 ] || return 0
  LOCK_TRIED=0
  run_phase unlock >/dev/null 2>&1 || echo "warning: could not release the deploy lock on the host; clear it with: $(lock_clear_cmd)" >&2
  return 0
}
loud() {   # a failure that leaves the site in a state a person must look at: one line each, boxed in asterisks
  printf 'deploy: %s\n' '************************************************************************' >&2
  for _l in "$@"; do printf 'deploy: %s\n' "$_l" >&2; done
  printf 'deploy: %s\n' '************************************************************************' >&2
  exit 1
}
lock_busy() {   # $1 = remote exit code (75 held, 76 held and stale)
  if [ "$1" = 76 ]; then
    echo 'deploy: that lock is older than 30 minutes: the run that took it has probably died.' >&2
  else
    echo 'deploy: another deploy or rollback is running against this host; wait for it to finish.' >&2
  fi
  echo "deploy: nothing was changed. If you are sure no deploy is running, clear the lock with: $(lock_clear_cmd)" >&2
  exit 1
}
leave() { end_phase; release_lock; }   # every way out: the open phase's duration, then the lock
trap leave EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- Rollback only -------------------------------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  step "Rolling $TARGET back to its previous release"
  RUN_ID=$(new_run_id)
  LOCK_TRIED=1
  _rc=0; run_phase lock || _rc=$?
  case $_rc in
    0) ;;
    10) die 'nothing is deployed here, so there is nothing to roll back; nothing was changed.' ;;
    75|76) lock_busy "$_rc" ;;
    *) die 'could not take the deploy lock on the host; nothing was changed.' ;;
  esac
  _rc=0; roll_back_and_verify || _rc=$?
  case $_rc in
    0) exit 0 ;;
    10) die 'rollback refused (see above); the live release is unchanged.' ;;
    13) die 'rollback refused: the previous release cannot read the data (see above); the live release is unchanged.' ;;
    12) die 'the host did not answer cleanly, so the outcome of the rollback is unknown; the live release may have changed. Check the site, then run --rollback again if needed.' ;;
    *) die 'the previous release is live again but failed verification; investigate before deploying.' ;;
  esac
fi

# ---- Gates and payload ---------------------------------------------------------------------------------------
step "Gates: check:core, tests, build$([ "$QUICK" = 1 ] && echo ', spot e2e' || echo ', e2e')"
npm run check:core
npm test
npm run build
# --quick is dtp's (the owner, 2026-11-02: dtp is the fast lane, tdtp the thorough one): the whole browser suite was 16 of a dtp's 18
# minutes, so dtp runs the spot test instead. It proves the bundle boots against the real API on both projects, the API refuses
# without a session, and one account's write reaches the other's open page. tdtp runs every spec.
if [ "$QUICK" = 1 ]; then
  npm run test:e2e -- e2e/planner.spec.ts --grep 'private API|a poll brings in'
else
  npm run test:e2e
fi
step 'Auditing the payload'
audit_payload || exit 1
EXPECT_PHP=$(find -P dist -type f -name '*.php' | wc -l | tr -d ' ')
STAMP=$(new_run_id); RUN_ID=$STAMP
_sd=${STAMP%%-*}; _sp=${STAMP#*-}   # <14 digits>-<pid>: index.php and api.php bind to their lib by exactly this shape
case $_sd$_sp in ''|*[!0-9]*) die 'could not form a release name.' ;; esac
[ "${#_sd}" = 14 ] && [ -n "$_sp" ] || die 'could not form a release name.'
REL=$PROTECTED/releases/$STAMP
PREL=$PUBREL/$STAMP

# ---- Release ---------------------------------------------------------------------------------------------------
step "Pre-checking the host, taking the deploy lock and creating release $STAMP ($TARGET)"
LOCK_TRIED=1
_rc=0; run_phase prepare || _rc=$?
case $_rc in
  0) ;;
  75|76) lock_busy "$_rc" ;;
  *) die 'host pre-checks failed; nothing was uploaded and the live release is unchanged.' ;;
esac
step 'Uploading into the two new release directories (no live path is written)'
{ rsync_up dist/public/PlanMind/ "$PLANMIND_DEPLOY_HOST:$PREL/" && rsync_up dist/protected/lib/ "$PLANMIND_DEPLOY_HOST:$REL/lib/"; } \
  || { discard_release; die 'upload failed; the live release is unchanged.'; }
step 'Linting every PHP file on the host'
run_phase verify || { discard_release; die 'checks on the host failed; the live release is unchanged.'; }
step 'Flipping the public link'
_rc=0; _act=$(run_phase activate) || _rc=$?
printf '%s\n' "$_act"
[ "$_rc" = 0 ] || die "activation did not complete; the switch may or may not have happened. Look at where $PUBLIC points on the host (ls -l); if the new release is live and an older one existed, run: sh tools/deploy.sh --rollback"
FIRST=$(marker "$_act" PLANMIND_FIRST_INSTALL)
PUBLIC_CREATED=$(marker "$_act" PLANMIND_PUBLIC_CREATED)
RESTORE_PREV=$(marker "$_act" PLANMIND_PREVIOUS_BEFORE)
case $PUBLIC_CREATED in 1) ;; *) PUBLIC_CREATED=0 ;; esac
case $RESTORE_PREV in *[!0-9-]*) RESTORE_PREV= ;; esac

step 'Verifying the served site'
if ! verify_site "$VERSION" "$STAMP"; then
  if [ "$FIRST" = 1 ]; then
    echo 'Verification failed on a first install; taking it offline again.' >&2
    if run_phase unactivate; then
      discard_release
      die "release $STAMP failed verification on a first install; it was taken offline again and discarded, so the app is back to 'not installed'."
    fi
    die "release $STAMP failed verification on a first install and could not be taken offline; it is still live. On the host remove the public link: ssh $PLANMIND_DEPLOY_HOST 'rm -f $PUBLIC'"
  fi
  step 'Rolling back to the previous release'
  echo 'Verification failed; rolling back to the previous release.' >&2
  _rc=0; roll_back_and_verify || _rc=$?
  case $_rc in
    0) die "release $STAMP failed verification; the previous release is serving again (it stays on the host for inspection; 'previous' no longer points at it)." ;;
    10) die "release $STAMP failed verification and could not be rolled back (see above; nothing was changed); it is still live." ;;
    13) loud "release $STAMP FAILED verification and is STILL LIVE: it was NOT rolled back." \
             "The previous release cannot read the data (see above). A release that verified badly but can read the data beats one that cannot read it at all." \
             "Nothing changed after the flip. Fix forward with a new release; going back would also need the older data file (tasks.v<N>.enc.bak beside tasks.enc)." ;;
    11) die "release $STAMP failed verification, but it is no longer the live release (another run flipped the public link); nothing was changed." ;;
    12) die "release $STAMP failed verification and the rollback could not be confirmed (no clean answer from the host); check where $PUBLIC points there and run: sh tools/deploy.sh --rollback if needed." ;;
    *) die "release $STAMP failed verification and the rollback did not verify either; fix the host by hand." ;;
  esac
fi
step 'Pruning old releases'
run_phase prune || echo 'warning: pruning old releases failed; they are harmless.' >&2
printf 'Verified %s (release %s)\n' "$URL" "$STAMP"
end_phase
printf 'Deployed in %s s.\n' "$(($(date +%s) - RUN_T0))"
