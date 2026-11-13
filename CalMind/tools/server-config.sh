#!/usr/bin/env bash
# THE ONLY WAY AN INSTANCE'S lib/config.php CHANGES. deploy.sh never sends that file; never edit it in place.
#
#   tools/server-config.sh pull INST                  copy the instance's config.php to tools/.server-config/INST.php (gitignored, 0600)
#   tools/server-config.sh push INST                  upload that hand-edited copy; every changed key must pass the set-* rules (no data_key or debug_log_codes change, no undocumented key); refuses a copy not pulled, or if the live file
#                                                     changed since the pull; then deletes the copy
#   tools/server-config.sh show-keys INST             key NAMES and SHAPES of the live file (type, length), never a value
#   tools/server-config.sh set-str KEY VALUE INST     a plain string (or an integer for smtp_port); VALUE "-" reads it from stdin
#                                                     (required for smtp_pass, so a secret never sits in an argument list)
#   tools/server-config.sh set-flag KEY on|off INST   a boolean (mail_enabled)
#   tools/server-config.sh unset KEY INST             remove a key
#   tools/server-config.sh where INST                 the lib path and URL this instance maps to
#
# INST = prod | test | dev. Keys are limited to the ones config.sample.php documents; data_key is refused (changing it
# makes the store unreadable). php_bin must be an absolute path and, on the server, an executable that runs.
# Every change starts from the LIVE file (never a copy left here), validates locally, uploads beside the target as
# config.php.new, validates there, keeps config.php.prev while it swaps atomically, proves the served result
# (the public `health` action: mailWorker ok|missing) and puts the old file back if that proof fails. The local
# copy is deleted on any exit. Exit 3 = applied, but the instance still reports mailWorker: missing.
#
# Why: CalMind's deploy never sends lib/config.php, so 'php_bin' (the PHP CLI the detached reset-mail worker runs;
# /usr/local/bin/php on the host) had no safe way to be set, and with mail on and no usable worker the reset mail
# is silently NOT SENT. The tool follows the site's tools/server-config.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

CONF="${CALMIND_DEPLOY_CONF:-server/deploy.conf}"   # SSH_DEST only; the test points it at a placeholder
SAMPLE=server/lib/config.sample.php
STATE="${CALMIND_SERVER_CONFIG_STATE:-tools/.server-config}"   # the test points it at a scratch dir
NOTE='// Hand-kept on the server; never deployed. Change it ONLY with tools/server-config.sh.'

die() { echo "$*" >&2; exit 1; }
usage() { sed -n '2,24p' "$0"; exit 1; }

# The TABLE: constants, one row per instance, matching server/deploy.sh (tools/test-server-config.sh proves they agree).
# Nothing here is built from an argument.
inst_paths() {
    case "$1" in
        test) LIB_DEST=/home/protected/calmind/lib;      SITE_URL=https://test.seancheren.com/calmind ;;
        dev)  LIB_DEST=/home/protected/calmind-dev/lib;  SITE_URL=https://dev.seancheren.com/calmind ;;
        prod) LIB_DEST=/home/protected/calmind-prod/lib; SITE_URL=https://seancheren.com/calmind ;;
        *) die "instance must be prod, test or dev" ;;
    esac
    REMOTE="$LIB_DEST/config.php"
}

load_conf() {
    [[ -f "$CONF" ]] || die "$CONF missing (SSH_DEST=...)"
    # shellcheck disable=SC1090
    . "$CONF"
    [[ "${SSH_DEST:-}" =~ ^[A-Za-z0-9_][A-Za-z0-9._@:-]*$ ]] || die "SSH_DEST not set (or not a plain user@host) in $CONF"
}

sum() { shasum -a 256 "$1" | cut -d' ' -f1; }

# --- one working copy per run; removed on any exit ---------------------------------------------------------
W=""
cleanup() { [[ -z "$W" ]] || rm -rf "$W"; }
trap cleanup EXIT

pull_to() {   # $1 = local file, $2 = base-sum file
    scp -q "$SSH_DEST:$REMOTE" "$1" || die "cannot read the live config; nothing changed"
    chmod 600 "$1"
    sum "$1" > "$2"
}

# The live file must still be the one we pulled: an old copy on this Mac (the site's 2026-11-10 mistake) is never uploaded.
check_not_stale() {   # $1 = base-sum file
    [[ -f "$1" ]] || die "refusing: no pull record — pull first"
    local t; t=$(mktemp "$W/live.XXXXXX")
    scp -q "$SSH_DEST:$REMOTE" "$t" || die "cannot read the live config to compare; nothing pushed"
    [[ "$(sum "$t")" == "$(cat "$1")" ]] || die "refusing: the live config changed since the pull — pull again and redo the edit"
    rm -f "$t"
}

# The PHP half: validate one file, or apply one edit to it. Values arrive in the environment, never in code; a
# message never carries a value.
write_editor() {
    cat > "$W/edit.php" <<'PHP'
<?php
// argv: file sample mode [pulled-copy].  env: KEY, VAL.  Prints names/shapes only, never a value.
[$self, $f, $sample, $mode] = $argv;
$die = function (string $m): void { fwrite(STDERR, $m . "\n"); exit(1); };
$c = require $f;
if (!is_array($c)) { $die('refusing: the config does not return an array'); }
// The file is evaluated HERE: a __DIR__ in it would turn into this machine's path and ship (the site's 2026-10-18 bug).
$here = dirname($f); $real = (string) realpath($here);   // __DIR__ resolves symlinks (/var -> /private/var)
array_walk_recursive($c, function ($v, $k) use ($die, $here, $real) {
    if (is_string($v) && (strpos($v, '/Users/') === 0 || strpos($v, $here) !== false || ($real !== '' && strpos($v, $real) !== false))) {
        $die("refusing: the value of '$k' is a path on this machine (the file computes it, e.g. __DIR__); edit that file by hand on the server");
    }
});
preg_match_all("/'([a-z][a-z0-9_]*)'\\s*=>/", (string) file_get_contents($sample), $m);
// debug_log_codes is documented only as a warning ("do not set on a host"): never settable or listed here.
$allowed = array_values(array_diff(array_unique($m[1]), ['debug_log_codes']));
$key = (string) getenv('KEY'); $val = (string) getenv('VAL');
$shape = function ($v): string {
    if (is_bool($v)) { return 'bool'; }
    if (is_int($v)) { return 'int'; }
    if (is_string($v)) { return 'string[' . strlen($v) . ']'; }
    if (is_array($v)) { return 'array[' . count($v) . ']'; }
    return gettype($v);
};
if ($mode === 'show') {
    ksort($c);
    foreach ($c as $k => $v) { echo $k, ': ', $shape($v), in_array($k, $allowed, true) ? '' : ' (not a documented key)', "\n"; }
    $unset = array_values(array_diff($allowed, array_keys($c)));
    echo 'not set: ', $unset ? implode(', ', $unset) : '(none)', "\n";
    exit(0);
}
$flags = ['mail_enabled'];
$ints  = ['smtp_port' => [1, 65535]];
$paths = ['php_bin', 'data_dir', 'calmind_site_lib'];
$ctl = '/[\\x00-\\x1f\\x7f]/';
$refuse = ['data_key', 'debug_log_codes'];   // data_key encrypts the store; debug_log_codes writes reset codes to the log
$safeName = function ($k): string { return preg_match('/^[A-Za-z0-9_]{1,64}$/D', (string) $k) ? (string) $k : '(odd name)'; };
// One rule set for set-str, set-flag AND a hand-edited copy: returns an error message, or null when the value is fine.
$validate = function (string $key, $v) use ($flags, $ints, $paths, $ctl): ?string {
    if (in_array($key, $flags, true)) { return is_bool($v) ? null : $key . ' must be a boolean'; }
    if (isset($ints[$key])) {
        return (is_int($v) && $v >= $ints[$key][0] && $v <= $ints[$key][1]) ? null : $key . ' is an integer ' . $ints[$key][0] . '-' . $ints[$key][1];
    }
    if (!is_string($v)) { return $key . ' must be a string'; }
    if (preg_match($ctl, $v)) { return 'the value of ' . $key . ' has a control character'; }
    if (strlen($v) > 512) { return 'the value of ' . $key . ' is longer than 512 bytes'; }
    if ($v === '' && $key !== 'calmind_site_lib') { return 'an empty value for ' . $key . ' (use unset)'; }   // '' keeps calmind_site_lib on its legacy sign-in
    if (in_array($key, $paths, true) && $v !== '') {
        if (!preg_match('#^/[A-Za-z0-9._/+-]+$#D', $v) || strpos($v, '..') !== false) { return $key . ' must be an absolute path of [A-Za-z0-9._/+-] with no ..'; }
        if (strpos($v, '/Users/') === 0) { return $key . ' is a path on a Mac, not on the host'; }
    }
    if ($key === 'smtp_host' && !preg_match('/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/D', $v)) { return 'smtp_host must be a host name'; }
    if ($key === 'mail_from' && !filter_var($v, FILTER_VALIDATE_EMAIL)) { return 'mail_from must be an email address'; }
    if ($key === 'meetreq_user' && !preg_match('/^[A-Za-z0-9_-]{2,20}$/D', $v)) { return 'meetreq_user must be 2-20 of [A-Za-z0-9_-]'; }
    if ($key === 'timezone' && !in_array($v, DateTimeZone::listIdentifiers(), true)) { return 'timezone must be a PHP time zone identifier'; }
    return null;
};
if ($mode === 'check' || $mode === 'phpbin') {
    // Given the copy as pulled (argv[4]): every key that differs from it must pass the same rules as a set-*.
    $o = isset($argv[4]) ? require $argv[4] : null;
    if ($o !== null) {
        if (!is_array($o)) { $die('refusing: the pulled copy does not return an array'); }
        foreach ($c as $k => $v) {
            if (array_key_exists($k, $o) && $o[$k] === $v) { continue; }
            $n = $safeName($k);
            if (!is_string($k) || !in_array($k, $allowed, true)) { $die("refusing: '$n' is not a key config.sample.php documents (or may not be set)"); }
            if (in_array($k, $refuse, true)) { $die("refusing: '$n' may not be set or changed here"); }
            $e = $validate($k, $v);
            if ($e !== null) { $die('refusing: ' . $e); }
        }
        if (array_key_exists('data_key', $o) && (!array_key_exists('data_key', $c) || $c['data_key'] !== $o['data_key'])) {
            $die('refusing: data_key encrypts the store; changing or removing it makes every record unreadable');
        }
    }
    if ($mode === 'phpbin' && $o !== null && isset($c['php_bin']) && is_string($c['php_bin']) && (!array_key_exists('php_bin', $o) || $o['php_bin'] !== $c['php_bin'])) { echo $c['php_bin']; }
    exit(0);
}
if (!in_array($key, $allowed, true)) { $die('refusing: that key is not in config.sample.php (' . implode(', ', $allowed) . ')'); }
if ($key === 'data_key') { $die('refusing: data_key encrypts the store; changing or removing it makes every record unreadable'); }
if ($mode === 'unset') {
    unset($c[$key]);
} elseif ($mode === 'flag') {
    if (!in_array($key, $flags, true)) { $die('refusing: ' . $key . ' is not a boolean key (set-str)'); }
    $c[$key] = $val === 'on';
} elseif ($mode === 'str') {
    if (in_array($key, $flags, true)) { $die('refusing: ' . $key . ' is a boolean key (set-flag)'); }
    if (isset($ints[$key])) {
        if (!preg_match('/^[0-9]{1,5}$/D', $val)) { $die('refusing: ' . $key . ' is an integer ' . $ints[$key][0] . '-' . $ints[$key][1]); }
        $t = (int) $val;
    } else { $t = $val; }
    $e = $validate($key, $t);
    if ($e !== null) { $die('refusing: ' . $e); }
    $c[$key] = $t;
} else { $die('bad mode'); }
file_put_contents($f, "<?php\n" . getenv('NOTE') . "\nreturn " . var_export($c, true) . ";\n");
PHP
}

edit() { NOTE="$NOTE" KEY="${KEY:-}" VAL="${VAL:-}" php "$W/edit.php" "$1" "$SAMPLE" "$2" ${3:+"$3"}; }   # $3 = the copy as pulled

# Validate a complete replacement, upload beside the target, validate there, swap atomically, prove the served result.
push_file() {   # $1 = local file, $2 = base-sum file, $3 = the file as pulled
    local f="$1" base="$2" orig="$3"
    [[ "$(head -c 5 "$f")" == "<?php" ]] || die "refusing: $f does not begin with <?php"
    php -l "$f" >/dev/null || die "refusing: $f does not lint"
    [[ -f "$orig" ]] || die "refusing: no copy as pulled to compare with — pull first"
    edit "$f" check "$orig" || exit 1   # allowlist, data_key, debug_log_codes and every changed value, as for set-*
    local pb; pb=$(edit "$f" phpbin "$orig") || exit 1
    if [[ -n "$pb" ]]; then
        ssh "$SSH_DEST" "test -f '$pb' && test -x '$pb' && '$pb' -v >/dev/null 2>&1" || die "refusing: $pb is not an executable PHP on the server"
    fi
    check_not_stale "$base"
    scp -q "$f" "$SSH_DEST:$REMOTE.new" || die "upload failed; nothing changed"
    ssh "$SSH_DEST" "php -l $REMOTE.new >/dev/null && chgrp web $REMOTE.new && chmod 640 $REMOTE.new && cp -p $REMOTE $REMOTE.prev && mv $REMOTE.new $REMOTE" \
        || { ssh "$SSH_DEST" "rm -f $REMOTE.new $REMOTE.prev" || true; die "server refused the file; nothing changed"; }
    sleep "${SERVER_CONFIG_SLEEP:-2}"
    local ans mw
    ans=$(curl -sS --max-time 20 -X POST -H 'Content-Type: application/json' -d '{"action":"health"}' "$SITE_URL/api/index.php" 2>/dev/null || true)
    mw=$(printf '%s' "$ans" | php -r '$j = json_decode(stream_get_contents(STDIN), true); echo (is_array($j) && ($j["ok"] ?? null) === true && in_array($j["mailWorker"] ?? null, ["ok", "missing"], true)) ? $j["mailWorker"] : "";' 2>/dev/null || true)
    if [[ -z "$mw" ]]; then
        ssh "$SSH_DEST" "mv -f $REMOTE.prev $REMOTE" || echo "COULD NOT RESTORE $REMOTE from $REMOTE.prev — do it by hand" >&2
        die "SERVED RESULT BROKEN: the instance did not answer health; the previous config.php was put back"
    fi
    ssh "$SSH_DEST" "rm -f $REMOTE.prev" || true
    rm -f "$f" "$base" "$orig"
    echo "pushed to $INST; the instance answers health, mailWorker: $mw."
    if [[ "$mw" == missing ]]; then
        echo "WARNING: mail is enabled but no usable worker binary — reset mail would NOT be sent. Set php_bin: tools/server-config.sh set-str php_bin /usr/local/bin/php $INST" >&2
        exit 3
    fi
}

# Every change starts from the LIVE file in a private working copy; nothing is left on this machine afterwards.
change() {   # mode (flag|str|unset)
    W=$(mktemp -d "${TMPDIR:-/tmp}/calmind-server-config.XXXXXX")
    write_editor
    pull_to "$W/config.php" "$W/base"
    edit "$W/config.php" check || exit 1
    cp -p "$W/config.php" "$W/orig.php"
    edit "$W/config.php" "$1" || exit 1
    push_file "$W/config.php" "$W/base" "$W/orig.php"
}

[[ $# -ge 1 ]] || usage
CMD="$1"; shift
case "$CMD" in
    where)    [[ $# -eq 1 ]] || usage; INST="$1"; inst_paths "$INST"; echo "$LIB_DEST/config.php $SITE_URL" ;;
    pull)     [[ $# -eq 1 ]] || usage; INST="$1"; inst_paths "$INST"; load_conf
              W=$(mktemp -d "${TMPDIR:-/tmp}/calmind-server-config.XXXXXX"); write_editor
              mkdir -p -m 700 "$STATE"
              pull_to "$STATE/$INST.php" "$STATE/$INST.base"
              cp -p "$STATE/$INST.php" "$STATE/$INST.orig"
              edit "$STATE/$INST.php" check || { rm -f "$STATE/$INST.php" "$STATE/$INST.base" "$STATE/$INST.orig"; exit 1; }
              echo "pulled -> $STATE/$INST.php" ;;
    push)     [[ $# -eq 1 ]] || usage; INST="$1"; inst_paths "$INST"; load_conf
              [[ -f "$STATE/$INST.php" && -f "$STATE/$INST.base" && -f "$STATE/$INST.orig" ]] || die "refusing: $STATE/$INST.php has no pull record — run pull, edit, then push"
              W=$(mktemp -d "${TMPDIR:-/tmp}/calmind-server-config.XXXXXX"); write_editor
              push_file "$STATE/$INST.php" "$STATE/$INST.base" "$STATE/$INST.orig" ;;
    show-keys) [[ $# -eq 1 ]] || usage; INST="$1"; inst_paths "$INST"; load_conf
              W=$(mktemp -d "${TMPDIR:-/tmp}/calmind-server-config.XXXXXX"); write_editor
              pull_to "$W/config.php" "$W/base"
              edit "$W/config.php" show ;;
    set-str)  [[ $# -eq 3 ]] || usage; KEY="$1"; VAL="$2"; INST="$3"; inst_paths "$INST"; load_conf
              if [[ "$VAL" == "-" ]]; then IFS= read -rs VAL || true; fi
              [[ "$KEY" != smtp_pass || "$2" == "-" ]] || die "refusing: smtp_pass is a secret — pass VALUE as - and give it on stdin"
              export KEY VAL; change str ;;
    set-flag) [[ $# -eq 3 && ( "$2" == on || "$2" == off ) ]] || die "set-flag KEY on|off INST"
              KEY="$1"; VAL="$2"; INST="$3"; inst_paths "$INST"; load_conf; export KEY VAL; change flag ;;
    unset)    [[ $# -eq 2 ]] || usage; KEY="$1"; VAL=""; INST="$2"; inst_paths "$INST"; load_conf; export KEY VAL; change unset ;;
    *) usage ;;
esac
