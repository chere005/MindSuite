<?php
/**
 * The CalMind sync API — a dumb store with auth. The server executes no domain
 * logic: it merges opaque payloads by their clear metadata (id, type, updated,
 * deleted) and hands back its tail. All the product behavior lives in
 * packages/core, on the clients.
 *
 * Auth is bearer tokens (hashed at rest); passwords are password_hash() only —
 * nothing recoverable is stored, by design. Recovery is an emailed code.
 */

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/webauthn.php';
// Mail is log-only unless the instance explicitly enables SMTP.
require_once __DIR__ . '/mail.php';
// Built for .ics and wired to nothing for months; recipe_fetch is its first
// caller. The SSRF care in it is the reason a user-supplied URL can be
// fetched at all.
require_once __DIR__ . '/fetchurl.php';
require_once __DIR__ . '/caldav.php';

const USERNAME_RE   = '/^[A-Za-z0-9_-]{2,20}$/';
const REC_ID_RE     = '/^[A-Za-z0-9_-]{1,64}$/';
const REC_TYPE_RE   = '/^[a-z]{1,20}$/';   // folder|section|reminder today; events, notes, habits later without a server change
const MAX_BATCH     = 500;
const MAX_PAYLOAD   = 65536;               // bytes of JSON per record

/**
 * Do a stored record and an incoming change say the same thing?
 *
 * Only `deleted` and `payload` count — `updated` is the stamp being compared
 * around this. Keys are sorted recursively first, so a client that builds the
 * same object in a different order does not read as a difference: that would
 * make every echo of an already-stored record look like a tie worth accepting,
 * bump the sequence, and re-broadcast it to every device on every sync.
 *
 * The TypeScript twin is `sameContent` in packages/mind-core/src/sync.ts
 * (the shared TypeScript core, packages/mind-core); they
 * decide the same question on the two sides of the same tie.
 */
function canon_value($v)
{
    if (is_array($v)) {
        // ksort in place on associative arrays; lists keep their order,
        // because order IS content in a list.
        $isList = array_keys($v) === range(0, count($v) - 1);
        if (!$isList) { ksort($v); }
        foreach ($v as $k => $vv) { $v[$k] = canon_value($vv); }
    }
    return $v;
}

function rec_same(array $cur, array $incoming): bool
{
    if ((bool) ($cur['deleted'] ?? false) !== !empty($incoming['deleted'])) {
        return false;
    }
    return json_encode(canon_value($cur['payload'] ?? null))
        === json_encode(canon_value($incoming['payload'] ?? null));
}
const RECOVER_TTL   = 900;                 // a code lives fifteen minutes
const RECOVER_TRIES = 5;
// Abuse limits on the two endpoints that send mail. Recover is public, so it is
// throttled on every axis a sender could vary: per username, per address mailed,
// per client IP. meetreq_mail is authenticated but sign-up is open.
const RECOVER_COOLDOWN  = 60;   // seconds between codes for one username
const RECOVER_USER_HOUR = 3;    // codes per username per hour
const RECOVER_ADDR_HOUR = 3;    // codes per destination address per hour (any username)
const RECOVER_IP_HOUR   = 10;   // recover requests per client IP per hour, sent or not
const MEETREQ_MAIL_USER_HOUR = 30;  // answers one account may mail per hour
const MEETREQ_MAIL_IP_HOUR   = 60;  // ...and one client IP
const MEETREQ_MAIL_ADDR_HOUR = 3;   // answers mailed to one address per hour, whoever asks (sign-up takes any address)
const MEETREQ_WHEN_RE        = '/^\d{4}-\d{2}-\d{2} \d{1,2}(:\d{2})?( ?[ap]m)?$/i';  // what the app sends: '2026-11-16 4pm' / '16:00'
// Address-independent caps (cap_take, docs/api.md "Abuse caps"). On NearlyFreeSpeech the client chooses REMOTE_ADDR,
// so the per-IP rules above are a speed bump; these name no address: a counter per resource (an account) and one for
// the whole site, in fixed windows. An attacker CAN exhaust one (the documented price of having it).
const RECOVER_GLOBAL_HOUR = 30;   // recover requests, whole site, sent or not
const RECOVER_GLOBAL_DAY  = 100;
const RECOVER_ACCT_DAY    = 6;    // recover requests per username per day (the hourly 3 is abuse_take's)
const MEETREQ_GLOBAL_HOUR = 30;   // public creates, whole site
const MEETREQ_GLOBAL_DAY  = 100;
const MEETREQ_ACCT_HOUR   = 10;   // creates aimed at one account per hour
const MEETREQ_ACCT_DAY    = 30;
const MEETREQ_MAIL_GLOBAL_HOUR = 60;   // answers mailed, whole site (counted once the caller is authorised)
const MEETREQ_MAIL_GLOBAL_DAY  = 200;

function app_config(): array
{
    $cfg = is_file(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : [];
    $cfg['data_dir'] ??= getenv('CALMIND_DATA_DIR') ?: dirname(__DIR__) . '/data';
    $cfg['timezone'] ??= 'America/Chicago';
    // Whose calendar the public request page offers, and so whose account
    // gets the availability editor. The env fallback is what lets the e2e
    // harness own a request page at all: its accounts are minted per run
    // with names nothing can know in advance, so the OWNER has to be named
    // from outside instead. Deployed instances set it in config.php. There is
    // no default: an instance without one has no request page (meetreq_user()
    // is '' and the public endpoints answer 404 'not configured').
    $cfg['meetreq_user'] ??= getenv('CALMIND_MEETREQ_USER') ?: '';
    return $cfg;
}

/**
 * The clock. The server keeps UTC unless told otherwise, and anything here
 * that asks what day it is gets this answer — so without it "today" turned
 * over at 7pm Chicago, and every date the server decided was a day early all
 * evening. Found through the widget feed, which is gone; the rule outlived it
 * because repeats and dated reads still ask. The suite learned this the same
 * way and pins the same default; the config key is the one place to move it.
 */
function app_clock(): void
{
    date_default_timezone_set((string) (app_config()['timezone'] ?? 'America/Chicago'));
}
app_clock();

function reply(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $error): never
{
    reply($status, ['ok' => false, 'error' => $error]);
}

/** One tab-separated line per action — the suite's usage-log rule: never any content. */
/**
 * One line per authenticated action — time, IP, user, action, never content.
 *
 * It grew forever. Each device polls every thirty seconds, so a phone alone
 * writes a couple of thousand lines a day and three devices keep that up
 * year after year on a host with a storage quota. Nothing read the whole
 * file, so nothing ever noticed.
 *
 * One rotation at 5MB: the current log and one previous generation, about
 * 10MB in the worst case and months of history in practice. No cron, and a
 * race is harmless — rename(2) is atomic, so a second process finds no file
 * to rotate and simply appends to the fresh one.
 */
const USAGE_LOG_MAX = 5 * 1024 * 1024;

function usage_log(array $cfg, string $action, string $user): void
{
    $tok  = fn(string $s) => preg_replace('/[^\w.@-]/', '_', $s);
    $line = date('Y-m-d H:i:s') . "\t" . $tok($_SERVER['REMOTE_ADDR'] ?? '-') . "\t" . $tok($user) . "\t" . $tok($action) . "\n";
    $path = $cfg['data_dir'] . '/usage.log';
    clearstatcache(true, $path);
    if (@filesize($path) > USAGE_LOG_MAX) {
        @rename($path, $path . '.1');
    }
    @file_put_contents($path, $line, FILE_APPEND | LOCK_EX);
}

/**
 * Send the reset code and log THAT one was issued: time, user, address, outcome.
 * The code itself is never logged (it is a live credential for 15 minutes) unless
 * the host explicitly sets debug_log_codes=true in config or CALMIND_DEBUG_LOG_CODES=1
 * in the environment, for local testing with mail off. Nothing sets either.
 */
function mail_code(array $cfg, string $user, string $email, string $code): void
{
    mail_log_secure($cfg, 'mail.log');
    $how  = mail_delivery_status($cfg, $email, 'CalMind password reset', "Your CalMind reset code is: $code\n\nIt expires in 15 minutes.");
    $dbg  = (($cfg['debug_log_codes'] ?? false) === true || getenv('CALMIND_DEBUG_LOG_CODES') === '1') ? "  code=$code" : '';
    $line = date('c') . '  user=' . preg_replace('/[^\w.@-]/', '_', $user) . "  $how$dbg\n";
    mail_log_write($cfg, 'mail.log', $line);
}

/**
 * Append to a mail log in the data dir, owner-only (0600): the files say who asked
 * for a reset or an answer. A file made earlier with looser bits is tightened on write.
 */
function mail_log_write(array $cfg, string $name, string $line): void
{
    mail_log_secure($cfg, $name);
    @file_put_contents($cfg['data_dir'] . '/' . $name, $line, FILE_APPEND | LOCK_EX);
}

/** Make the log exist at 0600 BEFORE the shared transport (lib/mail.php) appends its own line to mail.log. */
function mail_log_secure(array $cfg, string $name): void
{
    $path = $cfg['data_dir'] . '/' . $name;
    if (!file_exists($path)) { @touch($path); }
    @chmod($path, 0600);
}

/**
 * The PHP binary for the detached worker, or null. Only the host's config ('php_bin',
 * an absolute path to an executable file) or PHP_BINARY when that is itself a PHP
 * command-line/CGI binary (under mod_php or php-fpm it is httpd or php-fpm, which cannot
 * run a script). Never anything from the request.
 */
function mail_php_bin(array $cfg): ?string
{
    $c = $cfg['php_bin'] ?? '';
    if (is_string($c) && $c !== '' && $c[0] === '/' && !str_contains($c, "\0") && is_file($c) && is_executable($c)) { return $c; }
    $b = PHP_BINARY;
    if ($b !== '' && is_file($b) && is_executable($b) && preg_match('/^php(\d+(\.\d+)*)?(-cgi)?$/', basename($b)) === 1) { return $b; }
    return null;
}

/** The reset code as stored: keyed to the user and the data key, never the code itself. */
function recover_code_hash(array $cfg, string $user, string $code): string
{
    return hash_hmac('sha256', $user . "\0" . $code, store_key($cfg));
}

/**
 * Hand a job to lib/mail-worker.php and return at once: a detached `php` that
 * reads the job from its stdin (a pipe: not argv, not env, not disk) and sends. Called in
 * EVERY recover branch (a {"kind":"none"} job when there is nothing to send) so
 * existing, missing and throttled names cost the request the same fork.
 * Works under CGI, FastCGI and `php -S` alike; the child's stdout/stderr go to
 * /dev/null so Apache's CGI pipe closes when the request ends.
 * If processes cannot be started the mail is not sent (and logged), never sent
 * inline: an inline send is the timing oracle this exists to prevent.
 */
function mail_spawn(array $cfg, array $job): bool
{
    $bin = mail_php_bin($cfg);
    $env = [];
    foreach (getenv() as $k => $v) {   // a CGI request env would make php-cgi think it is serving a request
        if (!preg_match('/^(GATEWAY_INTERFACE|REQUEST_METHOD|SCRIPT_(FILENAME|NAME)|PATH_(INFO|TRANSLATED)|QUERY_STRING|CONTENT_(LENGTH|TYPE)|REDIRECT_.*|HTTP_.*|REMOTE_.*|SERVER_.*|PHP_SELF|DOCUMENT_ROOT)$/', (string) $k)) { $env[$k] = $v; }
    }
    $ok = false;
    if ($bin !== null && function_exists('proc_open')) {
        $p = @proc_open(['/bin/sh', '-c', '"$@" 0<&3 3<&- >/dev/null 2>&1 &', 'sh', $bin, '-q', '-f', __DIR__ . '/mail-worker.php'],
            [3 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, '/', $env);
        if (is_resource($p)) {
            @fwrite($pipes[3], json_encode($job));
            fclose($pipes[3]);
            proc_close($p);          // only the short-lived sh: the worker is already detached
            $ok = true;
        }
    }
    if (!$ok && ($job['kind'] ?? '') === 'code') {
        $line = date('c') . '  user=' . preg_replace('/[^\w.@-]/', '_', (string) $job['user']) . "  NOT SENT (cannot start the mail worker)\n";
        mail_log_write($cfg, 'mail.log', $line);
    }
    return $ok;
}

/**
 * Sliding-window limiter over one JSON file (the meetreq-ips pattern, generalised).
 * $rules: list of ['key', 'max' per hour, optional 'gap' seconds between hits,
 * optional 'always' = count the attempt even when it is refused]. Returns true and
 * records the hit on every rule when all pass; false otherwise.
 */
function abuse_take(array $cfg, string $name, array $rules): bool
{
    return with_lock($cfg, 'abuse-' . $name, function () use ($cfg, $name, $rules) {
        $f   = $cfg['data_dir'] . '/abuse-' . $name . '.json';
        $now = time();
        $all = store_read($cfg, $f);
        foreach ($all as $k => $ts) {
            $ts = array_values(array_filter((array) $ts, fn($t) => $t > $now - 3600));
            if ($ts === []) { unset($all[$k]); } else { $all[$k] = $ts; }
        }
        $pass = true;
        foreach ($rules as $r) {
            $ts = $all[$r['key']] ?? [];
            if (count($ts) >= $r['max'] || (isset($r['gap']) && $ts && max($ts) > $now - $r['gap'])) { $pass = false; }
        }
        foreach ($rules as $r) {
            if ($pass || !empty($r['always'])) {
                $all[$r['key']] = array_slice(array_merge($all[$r['key']] ?? [], [$now]), -($r['max'] + 1));
            }
        }
        store_write($cfg, $f, $all);
        return $pass;
    });
}

/**
 * Run $fn under an exclusive lock on data/.caps-<name>.lock. The lock file is opened 'c+', never 'c': on NFS-backed
 * storage flock() is emulated with byte-range locks, and a descriptor that cannot be read behaves differently there
 * (the shared sign-in library hit this on the live host). Anything that stops the lock being taken throws.
 */
function cap_locked(array $cfg, string $name, callable $fn)
{
    \MindSuite\Files\ensure_directory($cfg['data_dir']);
    $file   = $cfg['data_dir'] . '/.caps-' . $name . '.lock';
    $stream = @fopen($file, 'c+');
    if ($stream === false) { throw new RuntimeException('Cannot open the caps lock.'); }
    try {
        if (!@chmod($file, 0600) || !flock($stream, LOCK_EX)) { throw new RuntimeException('Cannot acquire the caps lock.'); }
        return $fn();
    } finally {
        flock($stream, LOCK_UN);
        fclose($stream);
    }
}

/**
 * The counters in a caps file, ['<key>@<window>' => ['e' => window end, 'n' => count]], or [] when the file does not
 * exist. store_read() cannot tell "no file content" from "unreadable": it answers [] for a read error, an empty file,
 * text that is not JSON and an ENC1 file whose plain text is not JSON, and the write after that would reset every cap
 * to one. cap_take() never writes a file without a row, so anything that exists must read back as rows of exactly the
 * shape it wrote; anything else throws (the file stays untouched until the operator deletes it or restores it).
 */
function cap_counters(array $cfg, string $file): array
{
    if (!file_exists($file)) { return []; }
    if (!is_file($file) || !is_readable($file)) { throw new RuntimeException('caps: ' . basename($file) . ' cannot be read'); }
    $rows = store_read($cfg, $file);   // throws on an ENC1 file that is truncated or will not decrypt
    if ($rows === []) { throw new RuntimeException('caps: ' . basename($file) . ' holds no counters (empty, unreadable or not JSON)'); }
    foreach ($rows as $row) {
        if (!is_array($row) || !is_int($row['e'] ?? null) || !is_int($row['n'] ?? null) || $row['n'] < 0) {
            throw new RuntimeException('caps: ' . basename($file) . ' holds a row that is not a counter');
        }
    }
    return $rows;
}

/**
 * Address-independent caps: fixed-window counters that name no client address. On NearlyFreeSpeech REMOTE_ADDR is the
 * right-most X-Forwarded-For entry the CLIENT sent, so every per-IP rule is a speed bump; what holds is a counter
 * per resource being protected (an account) and one for the whole site.
 *
 * $caps: list of ['key' => string, 'max' => int, 'window' => seconds]. The window is the epoch-aligned slot of that
 * length containing now (a counter is reset when the slot ends, not slid), so a caller may burst up to twice a cap
 * across a boundary. All or nothing: when every counter has room each is raised by one and true is returned; one
 * full counter refuses the call and NOTHING is counted, so a refusal creates no row and the file stays as small as
 * what the caps let through (a flood of made-up keys cannot grow it past the site-wide cap).
 *
 * Stored in data/caps-<name>.json with store_write() (atomic rename, encrypted) under cap_locked(). It FAILS CLOSED:
 * a store that cannot be read, decrypted, parsed, written or locked returns false, which callers answer exactly as
 * they answer a counter at its cap (the failure is logged for the operator, never shown to the caller). A missing file
 * is the only "no counters yet": cap_counters() refuses everything else.
 *
 * Why not abuse_take(): that one is a sliding hour (the 3600 filter), keeps a row for every key it is asked about,
 * even a refused one ('always'), and has no day window or site-wide key. Widening it would change the 1.61.0 rules
 * it already serves; this one is fixed-window, all-or-nothing and writes no row for a refusal (see the lines above).
 */
function cap_take(array $cfg, string $name, array $caps): bool
{
    try {
        if ($caps === []) { throw new InvalidArgumentException('no counters asked for'); }   // cap_counters() reads an empty file as damage
        $file = $cfg['data_dir'] . '/caps-' . $name . '.json';
        return (bool) cap_locked($cfg, $name, function () use ($cfg, $file, $caps) {
            $now  = time();
            $live = [];
            foreach (cap_counters($cfg, $file) as $k => $row) {
                if ($row['e'] > $now) { $live[$k] = $row; }
            }
            $next = $live;
            foreach ($caps as $c) {
                $win = (int) $c['window'];
                $k   = $c['key'] . '@' . $win;
                $end = (intdiv($now, $win) + 1) * $win;
                $n   = ($next[$k]['e'] ?? 0) === $end ? $next[$k]['n'] : 0;
                if ($n >= (int) $c['max']) { return false; }
                $next[$k] = ['e' => $end, 'n' => $n + 1];
            }
            store_write($cfg, $file, $next);
            return true;
        });
    } catch (Throwable $e) {
        error_log('calmind caps ' . $name . ': refused, the counter store failed (' . get_class($e) . ': ' . $e->getMessage() . ')');
        return false;
    }
}

/**
 * The address an account signed up with (the one a reset code goes to), or null. Shared sign-in keeps it in the shared
 * store; otherwise it is on the account row. Never from the request.
 */
function account_email(array $cfg, string $user): ?string
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $e = msa_account_email(suite_cfg($suite), $user);
        return is_string($e) && $e !== '' ? $e : null;
    }
    $row = store_read($cfg, accounts_file($cfg))[$user] ?? null;
    $e = is_array($row) ? (string) ($row['email'] ?? '') : '';
    return $e !== '' ? $e : null;
}

/**
 * Runs in the detached worker (lib/mail-worker.php) for the two meeting-request mails: kind `meetreq` (an answer to a
 * requester) and `meetreq_notice` (to the owner, about a new request). The request that queued the job has already
 * checked who may mail whom and spent the caps; this only builds the text from fixed words plus a validated date and
 * time, sends through the shared transport and logs the outcome. A job that fails validation again sends nothing.
 */
function mail_meetreq_job(array $cfg, array $job): void
{
    $user = (string) ($job['user'] ?? '');
    $to   = (string) ($job['to'] ?? '');
    if ($user === '' || !filter_var($to, FILTER_VALIDATE_EMAIL) || strlen($to) > 120) { return; }
    $when = (string) ($job['when'] ?? '');
    if ($job['kind'] === 'meetreq_notice') {
        if (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:00$/', $when)) { return; }
        $subject = 'New meeting request';
        $body    = "A new meeting request came in for $when. Open Requests in CalMind to answer it.\n";
        $label   = 'notice';
    } else {
        $ans = (string) ($job['answer'] ?? '');
        $lines = [
            'accepted' => "Your meeting request was accepted: $when (about an hour).",
            'declined' => 'Your meeting request was declined.',
            'newtime'  => "A different time was proposed for your meeting: $when (about an hour).",
        ];
        if (!isset($lines[$ans])) { return; }
        if ($ans !== 'declined' && (strlen($when) > 40 || !preg_match(MEETREQ_WHEN_RE, $when))) { return; }
        if ($ans === 'declined') { $when = ''; }
        $subject = 'Your meeting request';
        $body    = $lines[$ans] . "\n";
        $label   = $ans;
    }
    mail_log_secure($cfg, 'mail.log');
    $how  = mail_delivery_status($cfg, $to, $subject, $body);
    $shown = $label === 'notice' ? 'owner' : $to;   // the owner's own address is not written down again
    mail_log_write($cfg, 'meetreq-mail.log', date('c') . '  by=' . $user . "  to=$shown  kind=$label  when=$when  $how\n");
}

/** Report log-only, successful delivery to the relay, or a refused send. */
function mail_delivery_status(array $cfg, string $to, string $subject, string $body): string
{
    if (!mail_enabled($cfg)) { return 'log-only'; }
    return mail_send($cfg, $to, $subject, $body) ? 'mailed' : 'MAIL REFUSED';
}

// ---------------------------------------------------------------- accounts & tokens

function accounts_file(array $cfg): string { return $cfg['data_dir'] . '/accounts.json'; }
function tokens_file(array $cfg): string   { return $cfg['data_dir'] . '/tokens.json'; }
function recover_file(array $cfg): string  { return $cfg['data_dir'] . '/recover.json'; }
function lockouts_file(array $cfg): string { return $cfg['data_dir'] . '/lockouts.json'; }

/**
 * Login throttling — the owner's policy, 2026-08-18: five wrong guesses lock the
 * account, and each further lockout holds longer — 5m, 10m, 1h, 2h, 3h,
 * then another hour per round. A clean sign-in (or a password reset) clears
 * the slate. There is DELIBERATELY no endpoint that lifts one — "manually
 * disable from the backend only": delete the account's entry from
 * data/lockouts.json on the server (or the file itself) and the ladder
 * starts over. bcrypt already makes each guess slow; this bounds how many
 * guesses a night can hold at all.
 */
const LOCK_TRIES = 5;

function lockout_minutes(int $round): int
{
    $ladder = [5, 10, 60, 120, 180];
    return $round <= count($ladder) ? $ladder[$round - 1] : 180 + 60 * ($round - count($ladder));
}

/** '5m' under the hour, '2h' from it — the wait, sized for an error message. */
function lock_label(int $secs): string
{
    return $secs >= 3600 ? ((int) ceil($secs / 3600)) . 'h' : ((int) max(1, ceil($secs / 60))) . 'm';
}

function lockout_clear(array $cfg, string $user): void
{
    with_lock($cfg, 'lockouts', function () use ($cfg, $user) {
        $db = store_read($cfg, lockouts_file($cfg));
        if (isset($db[$user])) {
            unset($db[$user]);
            store_write($cfg, lockouts_file($cfg), $db);
        }
    });
}
/**
 * One record file per user PER SPACE.
 *
 * The default space is CalMind's and its filename is unchanged, byte for byte,
 * because every existing store is already at that path.
 *
 * ChefMind (the owner, 2026-08-21) is a second app on this same server that reuses
 * these accounts and keeps its own reminders and notes. It sends space='chef'
 * and lands in records-chef-<user>.json. Nothing else about it is different:
 * same auth, same tokens, same merge, same lock discipline — the space is only
 * WHICH FILE.
 *
 * Sharing, the meeting-request pair and the widget feed all call this with no
 * space and therefore always mean CalMind's store. That is deliberate rather
 * than an oversight: a partnership is between two CalMind accounts, and a
 * ChefMind note is not something either of them has agreed to share.
 */
function records_file(array $cfg, string $user, string $space = ''): string
{
    $prefix = $space === '' ? 'records-' : 'records-' . $space . '-';
    return $cfg['data_dir'] . '/' . $prefix . $user . '.json';
}

/**
 * The space a request names, or '' for CalMind's.
 *
 * Whitelisted rather than sanitised. `$in['space']` reaches a FILENAME, so the
 * difference between "reject anything not on the list" and "strip the
 * characters I thought of" is the difference between a closed door and a door
 * with a lock somebody has to have got right — '../' is only the first thing
 * to try. A list of the spaces that exist cannot be walked out of.
 */
const SYNC_SPACES = ['chef'];

/**
 * The spaces this build knows, said out loud and WITHOUT AUTH.
 *
 * ChefMind writes into CalMind's server. If it is ever deployed in front of an
 * API that does not know `space`, the parameter is ignored and every ChefMind
 * record lands in CalMind's own store — two apps merged into one file, found
 * only once somebody's reminders list has recipes in it.
 *
 * So the ChefMind deploy asks first, and refuses to ship if the answer does
 * not name its space. That gate needs an answer from a machine holding no
 * credentials, which is why this is public. What it discloses is the list of
 * apps this server hosts, which is already visible from the outside.
 */
function handle_spaces(): never
{
    reply(200, ['ok' => true, 'spaces' => SYNC_SPACES]);
}

/**
 * The deploy's read-only health answer: whether the detached reset-mail worker can start.
 * 'missing' only when mail is on and no usable PHP binary exists (the code would be logged
 * NOT SENT); 'ok' otherwise, including mail off. Booleans in words only: no path, no
 * config value, no hint of which key is wrong. Public like `spaces`, for the same reason:
 * the deploy holds no credentials.
 */
function mail_worker_state(array $cfg): string
{
    return (!mail_enabled($cfg) || mail_php_bin($cfg) !== null) ? 'ok' : 'missing';
}

function handle_health(array $cfg): never
{
    reply(200, ['ok' => true, 'mailWorker' => mail_worker_state($cfg)]);
}

function sync_space(array $in): string
{
    $s = (string) ($in['space'] ?? '');
    if ($s === '') { return ''; }
    if (!in_array($s, SYNC_SPACES, true)) { fail(400, 'unknown space'); }
    return $s;
}

/** A fresh bearer token for $user; only its hash is stored. */
function token_issue(array $cfg, string $user): string
{
    $token = bin2hex(random_bytes(32));
    with_lock($cfg, 'tokens', function () use ($cfg, $token, $user) {
        $t = store_read($cfg, tokens_file($cfg));
        $t[hash('sha256', $token)] = ['user' => $user, 'created' => time()];
        store_write($cfg, tokens_file($cfg), $t);
    });
    return $token;
}

/** Every token a user holds, gone — password change and reset both call this. */
function tokens_revoke(array $cfg, string $user): void
{
    with_lock($cfg, 'tokens', function () use ($cfg, $user) {
        $t = array_filter(store_read($cfg, tokens_file($cfg)), fn($v) => ($v['user'] ?? '') !== $user);
        store_write($cfg, tokens_file($cfg), $t);
    });
}

function account_exists(array $cfg, string $user): bool
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        // Exactly the canonical (lowercase) name: a record file is named by it, so 'Alex' must not pass for 'alex'.
        return msa_normalize_username($user) === $user && msa_account_exists(suite_cfg($suite), $user);
    }
    return isset(store_read($cfg, accounts_file($cfg))[$user]);
}

// ---------------------------------------------------------------- shared sign-in (MindSuite)
//
// Dual mode. The site's shared sign-in (the site repo's docs/MINDSUITE-LOGIN.md) is loaded IN-PROCESS from the site lib
// of this instance; CalMind never copies the library. While that lib is missing, its instance is not switched on, or
// calmind (chefmind, for the chef space) is on hold there (mindsuite_auth_hold), every action below runs its legacy path on accounts.json and
// tokens.json, unchanged. Once on, the shared store is the only door: tokens.json and accounts.json are never consulted
// for sign-in (no second door), native clients carry a bearer token whose session row has scope 'calmind' (a full-account
// token is refused here, and a calmind token opens nothing else in the suite), and the same-origin web build may use the
// suite cookie, with X-CSRF-Token on every action but whoami. A switched-on instance whose store or key cannot be read
// answers 503 and never falls back to legacy.
//
// The site's auth.php cannot be loaded here (it defines app_config() too), so only its three library files are, and the
// site config is read the way its app_config() reads it.

const SUITE_APP   = 'calmind';
const SUITE_SCOPE = 'calmind';
/**
 * A request for another app's space follows THAT app's switch and hold: ChefMind names space 'chef' on every action (its
 * api.ts), so 'chefmind' held keeps its calls on the legacy path while calmind is un-held, and calmind held does not hold
 * them back while chefmind is un-held. The scope does not follow: a chef-space token is still scope 'calmind' (the API it
 * opens is this one, on the same accounts; the importer made ChefMind's legacy tokens, which live in the same tokens.json,
 * calmind-scoped), so a token's scope must still be exactly SUITE_SCOPE, whichever app's hold the request follows.
 */
const SUITE_SPACE_APPS = ['chef' => 'chefmind'];
/**
 * The only actions whose `space` picks the hold: the three whose data is scoped by space, ChefMind's own recipe_fetch,
 * and the ones that carry identity only (sign-in, sign-up, recover/reset, passkey sign-in and list, change_password,
 * whoami, logout), so a held ChefMind keeps its whole legacy sign-in. Every other action (delete_account,
 * passkey_register_*, passkey_remove, meetreq_*, calsub_*, ...) reaches CalMind's own data or adds a way into the whole
 * account and always follows calmind's hold, so a body field can never open a second door into CalMind while the two
 * holds differ.
 */
const SUITE_SPACE_ACTIONS = ['sync', 'shared_pull', 'shared_put', 'login', 'logout', 'whoami', 'signup', 'recover', 'reset',
    'change_password', 'passkey_login_begin', 'passkey_login_finish', 'passkey_list', 'recipe_fetch'];

/** The suite app this request follows (SUITE_SPACE_APPS by its `space`, else SUITE_APP). The API sets it once from the body. */
function suite_app(?array $in = null): string
{
    static $app = SUITE_APP;
    if ($in !== null) {
        $space = $in['space'] ?? '';
        $app = is_string($space) && isset(SUITE_SPACE_APPS[$space]) && in_array($in['action'] ?? null, SUITE_SPACE_ACTIONS, true)
            ? SUITE_SPACE_APPS[$space] : SUITE_APP;
    }
    return $app;
}
/** Every library function CalMind calls. A site lib without all of them is an older one: legacy, never half a door. */
const SUITE_FUNCS = ['mss_app_auth_config', 'mss_app_bearer_with', 'mss_client_address', 'mss_trusted_proxies',
    'msa_normalize_username', 'msa_account_exists', 'msa_account_email', 'msa_login', 'msa_lockout_until', 'msa_revoke',
    'msa_clear_cookie', 'msa_signup', 'msa_reset_password', 'msa_lock', 'msa_lock_shared', 'msa_store_read', 'msa_store_write',
    'msa_passkey_register_begin', 'msa_passkey_register_finish', 'msa_passkey_login_begin', 'msa_passkey_login_finish',
    'msa_passkey_list', 'msa_passkey_remove'];

/**
 * The directory of this instance's site lib, or '' (legacy). Config `calmind_site_lib` wins ('' turns shared sign-in off
 * for this instance whatever the site says); otherwise the deployed instance's own lib is derived from where this file
 * lives (deploy.sh's table: test, dev, prod), so an instance can only ever read its own site's switch and store. The
 * CALMIND_SITE_LIB environment variable is read only off the host (local runs and the test harness).
 */
function suite_lib_dir(array $cfg): string
{
    if (array_key_exists('calmind_site_lib', $cfg)) { return is_string($cfg['calmind_site_lib']) ? rtrim($cfg['calmind_site_lib'], '/') : ''; }
    $derived = match (__DIR__) {
        '/home/protected/calmind/lib'      => '/home/protected/lib-test',
        '/home/protected/calmind-dev/lib'  => '/home/protected/lib-dev',
        '/home/protected/calmind-prod/lib' => '/home/protected/lib',
        default => null,
    };
    if ($derived !== null) { return $derived; }
    $env = getenv('CALMIND_SITE_LIB');
    return is_string($env) ? rtrim($env, '/') : '';
}

/**
 * Which door this request uses, judged once per request:
 *  ['shared' => false, 'site' => site config or null]  legacy (lib missing or too old, instance off, calmind held)
 *  ['shared' => true,  'site' => site config, 'auth' => library config or null]  shared; a null 'auth' is a store or
 *  key that cannot be read, answered 503 by suite_cfg().
 * The site config is kept on the legacy answer too, for mindsuite_signup_closed (sign-up closes before the import).
 */
function suite_auth(array $cfg): array
{
    static $memo = [];
    $lib = suite_lib_dir($cfg);
    $key = suite_app() . "\0" . $lib;
    if (array_key_exists($key, $memo)) { return $memo[$key]; }
    $legacy = ['shared' => false, 'site' => null];
    $files = ['mindsuite-site-auth.php', 'mindsuite-auth.php', 'mindsuite-passkeys.php'];
    if ($lib === '' || $lib[0] !== '/' || str_contains($lib, "\0")) { return $memo[$key] = $legacy; }
    foreach ($files as $f) { if (!is_file($lib . '/' . $f)) { return $memo[$key] = $legacy; } }
    try {
        // The site's invite code is a constant in its auth.php, which is not loaded here. CalMind's own sign-up passes the
        // same value back (handle_signup), so a per-request random value keeps msa_signup working and leaks nothing.
        if (!defined('SIGNUP_CODE')) { define('SIGNUP_CODE', bin2hex(random_bytes(16))); }
        foreach ($files as $f) { require_once $lib . '/' . $f; }
        foreach (SUITE_FUNCS as $fn) { if (!function_exists($fn)) { return $memo[$key] = $legacy; } }
        $site = suite_site_config($cfg, $lib);
    } catch (Throwable $e) {
        // The lib is there but will not load or its config will not read: nobody can tell whether calmind is switched
        // on, so fail closed (503), never open the legacy door on a guess.
        error_log('calmind shared sign-in: ' . get_class($e) . ': ' . $e->getMessage());
        return $memo[$key] = ['shared' => true, 'site' => null, 'auth' => null];
    }
    try {
        $auth = mss_app_auth_config($site, suite_app());
        // Switched on: the store must read with this key now, under the store's own shared lock (the library opens it
        // 'c+'), so a damaged store, a lost key or a lock file that will not open read-write is one 503 here rather than
        // a library throw deep inside a handler (which would come back as a 500 with the library's words).
        if ($auth !== null) { msa_lock_shared($auth, static fn() => msa_store_read($auth)); }
    } catch (Throwable $e) {
        error_log('calmind shared sign-in: ' . get_class($e) . ': ' . $e->getMessage());
        return $memo[$key] = ['shared' => true, 'site' => $site, 'auth' => null];
    }
    return $memo[$key] = $auth === null ? ['shared' => false, 'site' => $site] : ['shared' => true, 'site' => $site, 'auth' => $auth];
}

/**
 * The site config, read as the site's own app_config() reads it: lib/config.php, else lib/config.sample.php, with
 * SUITE_DATA_DIR (a scratch test run; never in a web server's environment) as its data directory. Config
 * `calmind_site_config` (or CALMIND_SITE_CONFIG off the host) names another file, for the test harness.
 */
function suite_site_config(array $cfg, string $lib): array
{
    $file = $cfg['calmind_site_config'] ?? null;
    if (!is_string($file) || $file === '') {
        $env = getenv('CALMIND_SITE_CONFIG');
        $file = !str_starts_with(__DIR__, '/home/protected/') && is_string($env) && $env !== '' ? $env
            : (is_file($lib . '/config.php') ? $lib . '/config.php' : $lib . '/config.sample.php');
    }
    $site = require $file;
    if (!is_array($site)) { throw new RuntimeException('The site config is not an array.'); }
    $dir = getenv('SUITE_DATA_DIR');
    if (is_string($dir) && $dir !== '') { $site['data_dir'] = $dir; }
    return $site;
}

/** The library config of a shared answer, or 503 when its store or key cannot be read. */
function suite_cfg(array $suite): array
{
    if (!is_array($suite['auth'] ?? null)) { fail_shared(503, 'sign-in unavailable'); }
    return $suite['auth'];
}

/** An auth error in shared mode: `shared: true` tells the web build to send the person to /account/. */
function fail_shared(int $status, string $error): never
{
    reply($status, ['ok' => false, 'error' => $error, 'shared' => true]);
}

/** Has the operator closed sign-up (mindsuite_signup_closed in the site config)? Honoured in both modes. */
function suite_signup_closed(array $suite): bool
{
    return is_array($suite['site'] ?? null) && !empty($suite['site']['mindsuite_signup_closed']);
}

/** The lockout bucket's address: the site's rule (X-Forwarded-For only from a listed front end). A speed bump only. */
function suite_client(array $suite): string
{
    return mss_client_address($_SERVER, mss_trusted_proxies($suite['site'] ?? []));
}

/** What a session row says about its device. Never a credential. */
function suite_device(): string
{
    $ua = preg_replace('/[\x00-\x1f\x7f]/', '', (string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));
    return mb_strcut('CalMind ' . $ua, 0, 200);
}

/** A fresh calmind-scoped bearer session for a password the caller has just set or proved. */
function suite_issue(array $acfg, string $user, string $password, array $suite): string
{
    $s = msa_login($acfg, $user, $password, suite_device(), suite_client($suite), SUITE_SCOPE);
    if ($s === null) { fail_shared(503, 'sign-in unavailable'); }
    return (string) $s['token'];
}

/**
 * The shared session of this request, or the request ends: a bearer whose row has scope exactly 'calmind', or the
 * same-origin cookie (refused cross-site, and on any action but a read without the session's X-CSRF-Token). `$read`
 * is whoami only: it has no effect, so the web build can learn its CSRF secret from it.
 */
function suite_session(array $suite, bool $read = false): array
{
    suite_cfg($suite);
    $method = $_SERVER['REQUEST_METHOD'] ?? null;
    if ($read) { $_SERVER['REQUEST_METHOD'] = 'GET'; }
    try {
        $r = mss_app_bearer_with($suite['site'], suite_app(), SUITE_SCOPE);
    } finally {
        if ($read) { $_SERVER['REQUEST_METHOD'] = $method; }
    }
    if ($r === null) { fail_shared(503, 'sign-in unavailable'); }   // judged on the same config: cannot happen
    if (empty($r['ok'])) { fail_shared((int) $r['status'], (string) $r['error']); }
    return $r;
}

/** The signed-in user, from the Authorization: Bearer header, or a 401. */
function require_auth(array $cfg): string
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) { return (string) suite_session($suite)['user']; }
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/', $hdr, $m)) {
        fail(401, 'auth required');
    }
    $t = store_read($cfg, tokens_file($cfg));
    $user = $t[hash('sha256', $m[1])]['user'] ?? '';
    if ($user === '') {
        fail(401, 'bad token');
    }
    if (!account_exists($cfg, $user)) {
        fail(401, 'account no longer exists');
    }
    return $user;
}

/** Remove exact-user lines from a plain-text log without disturbing other rows. */
function scrub_user_log(string $path, callable $matches): void
{
    if (!is_file($path)) { return; }
    $lock = fopen($path . '.lock', 'c');
    if ($lock === false) { throw new RuntimeException('could not lock log'); }
    flock($lock, LOCK_EX);
    try {
        $lines = file($path, FILE_IGNORE_NEW_LINES);
        if ($lines === false) { throw new RuntimeException('could not read log'); }
        $kept = array_values(array_filter($lines, fn($line) => !$matches($line)));
        $tmp = $path . '.' . getmypid() . '.tmp';
        $body = $kept === [] ? '' : implode("\n", $kept) . "\n";
        $mode = @fileperms($path);
        $wrote = file_put_contents($tmp, $body, LOCK_EX) !== false;
        if ($wrote && $mode !== false) { @chmod($tmp, $mode & 0777); }   // the rewrite keeps the log's own mode (mail.log is 0600)
        if (!$wrote || !rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException('could not rewrite log');
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Delete an account and every server-side artifact tied to it. */
function handle_delete_account(array $cfg): never
{
    $user = require_auth($cfg);
    if (suite_auth($cfg)['shared']) {
        // The account is the suite's now, and nothing deletes a suite account (not CalMind, not /account/): a CalMind
        // delete that removed only CalMind's files would leave a working sign-in behind the button that said "deleted".
        usage_log($cfg, 'delete_account_refused', $user);
        fail_shared(403, 'account deletion is not available while sign-in is shared with the suite');
    }
    $email = with_lock($cfg, 'accounts', function () use ($cfg, $user) {
        $accounts = store_read($cfg, accounts_file($cfg));
        if (!isset($accounts[$user])) { fail(401, 'account no longer exists'); }
        $email = (string) ($accounts[$user]['email'] ?? '');
        unset($accounts[$user]);
        store_write($cfg, accounts_file($cfg), $accounts);
        return $email;
    });

    tokens_revoke($cfg, $user);
    with_lock($cfg, 'recover', function () use ($cfg, $user) {
        $rows = store_read($cfg, recover_file($cfg));
        unset($rows[$user]);
        store_write($cfg, recover_file($cfg), $rows);
    });
    with_lock($cfg, 'lockouts', function () use ($cfg, $user) {
        $rows = store_read($cfg, lockouts_file($cfg));
        unset($rows[$user]);
        store_write($cfg, lockouts_file($cfg), $rows);
    });
    with_lock($cfg, 'passkeys', function () use ($cfg, $user) {
        $rows = store_read($cfg, passkeys_file($cfg));
        foreach ($rows as $id => $row) {
            if (($row['user'] ?? '') === $user) { unset($rows[$id]); }
        }
        store_write($cfg, passkeys_file($cfg), $rows);
    });
    with_lock($cfg, 'challenges', function () use ($cfg, $user) {
        $rows = store_read($cfg, challenges_file($cfg));
        foreach ($rows as $id => $row) {
            if (($row['user'] ?? '') === $user) { unset($rows[$id]); }
        }
        store_write($cfg, challenges_file($cfg), $rows);
    });

    // Calendar caches BEFORE the records go: a subscription's events are
    // fetched through this server and cached in icscache/, under a name made
    // from the URL (and for CalDAV, this account and its credentials) — so
    // the account's name is not in it, and the only map from account to
    // cache is the account's own calsub records. A secret iCal link's cache
    // is that person's calendar; it goes with them (#81).
    foreach (calsub_cache_files($cfg, $user) as $file) {
        if (is_file($file) && !unlink($file)) { throw new RuntimeException('could not delete calendar cache'); }
    }

    foreach (array_merge([''], SYNC_SPACES) as $space) {
        $file = records_file($cfg, $user, $space);
        with_lock($cfg, 'records-' . ($space === '' ? '' : $space . '-') . $user, function () use ($file) {
            if (is_file($file) && !unlink($file)) { throw new RuntimeException('could not delete account records'); }
        });
    }

    // Remove the deleted username from the other account's share settings.
    foreach (glob($cfg['data_dir'] . '/records-*.json') ?: [] as $file) {
        if (in_array($file, array_map(fn($space) => records_file($cfg, $user, $space), array_merge([''], SYNC_SPACES)), true)) { continue; }
        $name = basename($file, '.json');
        with_lock($cfg, $name, function () use ($cfg, $file, $user) {
            if (!is_file($file)) { return; }
            $db = store_read($cfg, $file);
            $changed = false;
            foreach ($db['recs'] as $id => &$record) {
                if (($record['type'] ?? '') !== 'share' || !is_array($record['payload'] ?? null)) { continue; }
                $rowChanged = false;
                $payload =& $record['payload'];
                $partners = is_array($payload['partners'] ?? null) ? $payload['partners'] : [];
                $newPartners = array_values(array_filter($partners, fn($partner) => $partner !== $user));
                if ($newPartners !== $partners) { $payload['partners'] = $newPartners; $rowChanged = true; }
                foreach (['labels', 'sel'] as $field) {
                    if (isset($payload[$field]) && is_array($payload[$field]) && array_key_exists($user, $payload[$field])) {
                        unset($payload[$field][$user]); $rowChanged = true;
                    }
                }
                unset($payload);
                if ($rowChanged) {
                    $changed = true;
                    $record['updated'] = max((int) ($record['updated'] ?? 0), time());
                    $record['seq'] = (int) ($db['seq'] ?? 0) + 1;
                    $db['seq'] = $record['seq'];
                }
            }
            unset($record);
            if ($changed) { store_write($cfg, $file, $db); }
        });
    }

    $usagePath = $cfg['data_dir'] . '/usage.log';
    $userToken = fn(string $s) => preg_replace('/[^\w.@-]/', '_', $s);
    foreach ([$usagePath, $usagePath . '.1'] as $path) {
        scrub_user_log($path, fn($line) => (explode("\t", $line)[2] ?? null) === $userToken($user));
    }
    // mail.log names the user (older lines also carried to=<address>).
    // (the shared transport also logs "mailed <address>: ..." without a user= field)
    scrub_user_log($cfg['data_dir'] . '/mail.log', fn($line) => preg_match('/(?:^|\s)user=' . preg_quote($userToken($user), '/') . '(?:\s|$)/', $line) === 1
        || ($email !== '' && preg_match('/(?<![\w.@-])' . preg_quote($email, '/') . '(?![\w.@-])/i', $line) === 1));
    // The meeting-request answers this account sent ("by=<user>").
    scrub_user_log($cfg['data_dir'] . '/meetreq-mail.log', fn($line) => preg_match('/(?:^|\s)by=' . preg_quote($user, '/') . '(?:\s|$)/', $line) === 1);
    reply(200, ['ok' => true]);
}

/**
 * Every calendar cache file this account's subscriptions can have filled —
 * the same paths handle_calsub_fetch derives, from the same payload fields,
 * tombstones included (a removed subscription keeps its payload and may have
 * left its cache behind). Read before the records file is deleted.
 */
function calsub_cache_files(array $cfg, string $user): array
{
    $db = store_read($cfg, records_file($cfg, $user));
    $files = [];
    foreach (is_array($db['recs'] ?? null) ? $db['recs'] : [] as $r) {
        if (($r['type'] ?? '') !== 'calsub' || !is_array($r['payload'] ?? null)) { continue; }
        $p = $r['payload'];
        if (($p['source'] ?? '') === 'caldav') {
            try { [$url, $username, $password] = caldav_credentials($p); }
            catch (InvalidArgumentException) { continue; }
            $files[] = caldav_cache_file($cfg, $user, $url, $username, $password);
            continue;
        }
        $url = trim(is_string($p['url'] ?? null) ? $p['url'] : '');
        if ($url === '') { continue; }
        if (stripos($url, 'webcal://') === 0) { $url = 'https://' . substr($url, 9); }
        $files[] = $cfg['data_dir'] . '/icscache/' . sha1($url) . '.json';
    }
    return array_values(array_unique($files));
}

// ---------------------------------------------------------------- action handlers

function handle_signup(array $cfg, array $in): never
{
    $user  = (string) ($in['username'] ?? '');
    $email = trim((string) ($in['email'] ?? ''));
    $pass  = (string) ($in['password'] ?? '');
    if (!preg_match(USERNAME_RE, $user))                    { fail(400, 'username: 2-20 letters, numbers, - or _'); }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL))         { fail(400, 'that email address doesn\'t look right'); }
    if (strlen($pass) < 6)                                  { fail(400, 'password: at least 6 characters'); }
    $suite = suite_auth($cfg);
    // Closed before the import, in BOTH modes, so nobody can take a legacy owner's name in either store first.
    if (suite_signup_closed($suite)) { fail(403, 'sign-up is closed'); }
    if ($suite['shared']) { handle_signup_shared($cfg, $suite, $user, $email, $pass); }
    $token = with_lock($cfg, 'accounts', function () use ($cfg, $user, $email, $pass) {
        $acc = store_read($cfg, accounts_file($cfg));
        if (isset($acc[$user])) {
            fail(409, 'that username is taken');
        }
        $acc[$user] = ['email' => $email, 'hash' => password_hash($pass, PASSWORD_DEFAULT), 'created' => time()];
        store_write($cfg, accounts_file($cfg), $acc);
        return token_issue($cfg, $user);
    });
    usage_log($cfg, 'signup', $user);
    reply(200, ['ok' => true, 'token' => $token, 'username' => $user]);
}

function handle_login(array $cfg, array $in): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) { handle_login_shared($cfg, $suite, $in); }
    $user = (string) ($in['username'] ?? '');
    $pass = (string) ($in['password'] ?? '');
    // The lockout gate comes FIRST and holds against the right password too —
    // a lockout that only stops wrong guesses throttles nothing but typos.
    $now   = time();
    $until = with_lock($cfg, 'lockouts', function () use ($cfg, $user, $now) {
        $db = store_read($cfg, lockouts_file($cfg));
        $u  = (int) ($db[$user]['until'] ?? 0);
        return $u > $now ? $u : 0;
    });
    if ($until > 0) {
        usage_log($cfg, 'login_locked', $user);
        fail(429, 'too many attempts — locked for ' . lock_label($until - $now));
    }
    $acc = store_read($cfg, accounts_file($cfg));
    if (!isset($acc[$user]) || !password_verify($pass, $acc[$user]['hash'] ?? '')) {
        // A miss counts against a REAL account only: an unknown name has
        // nothing to lock, and locking it would confirm which names exist.
        if (isset($acc[$user])) {
            with_lock($cfg, 'lockouts', function () use ($cfg, $user, $now) {
                $db = store_read($cfg, lockouts_file($cfg));
                $l  = $db[$user] ?? ['fails' => 0, 'rounds' => 0, 'until' => 0];
                $l['fails'] = (int) $l['fails'] + 1;
                if ($l['fails'] >= LOCK_TRIES) {
                    $l['rounds'] = (int) $l['rounds'] + 1;
                    $l['until']  = $now + 60 * lockout_minutes((int) $l['rounds']);
                    $l['fails']  = 0;
                }
                $db[$user] = $l;
                store_write($cfg, lockouts_file($cfg), $db);
            });
        }
        usage_log($cfg, 'login_fail', $user);
        fail(401, 'wrong username or password');
    }
    // A clean sign-in clears the slate — "consecutive" is the word in the rule.
    lockout_clear($cfg, $user);
    usage_log($cfg, 'login', $user);
    reply(200, ['ok' => true, 'token' => token_issue($cfg, $user), 'username' => $user]);
}

function handle_logout(array $cfg): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $s = suite_session($suite);
        msa_revoke(suite_cfg($suite), $s['session']);           // this token or this browser only
        if ($s['carrier'] === 'cookie') { msa_clear_cookie(suite_cfg($suite)); }
        usage_log($cfg, 'logout', (string) $s['user']);
        reply(200, ['ok' => true]);
    }
    $user = require_auth($cfg);
    $hdr  = $_SERVER['HTTP_AUTHORIZATION'];
    preg_match('/([a-f0-9]{64})$/', $hdr, $m);
    with_lock($cfg, 'tokens', function () use ($cfg, $m) {
        $t = store_read($cfg, tokens_file($cfg));
        unset($t[hash('sha256', $m[1])]);
        store_write($cfg, tokens_file($cfg), $t);
    });
    usage_log($cfg, 'logout', $user);
    reply(200, ['ok' => true]);
}

function handle_change_password(array $cfg, array $in): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) { handle_change_password_shared($cfg, $suite, $in); }
    $user = require_auth($cfg);
    $old  = (string) ($in['old'] ?? '');
    $new  = (string) ($in['new'] ?? '');
    if (strlen($new) < 6) { fail(400, 'password: at least 6 characters'); }
    with_lock($cfg, 'accounts', function () use ($cfg, $user, $old, $new) {
        $acc = store_read($cfg, accounts_file($cfg));
        if (!password_verify($old, $acc[$user]['hash'] ?? '')) {
            fail(403, 'current password is wrong');
        }
        $acc[$user]['hash'] = password_hash($new, PASSWORD_DEFAULT);
        store_write($cfg, accounts_file($cfg), $acc);
    });
    tokens_revoke($cfg, $user);   // every other device signs in again
    usage_log($cfg, 'change_password', $user);
    reply(200, ['ok' => true, 'token' => token_issue($cfg, $user)]);
}

/**
 * Public, so it is throttled (RECOVER_*) and answers `{ok:true}` with the same
 * status, body and work whether the account exists, was throttled, or is made up:
 * the throttle, the recover-file rewrite and the usage line happen in every case
 * and the mail goes out from a detached worker (mail_spawn), never inside the request. Which usernames exist is nobody's business.
 */
function handle_recover(array $cfg, array $in): never
{
    $user = substr((string) ($in['username'] ?? ''), 0, 64);
    $ip   = (string) ($_SERVER['REMOTE_ADDR'] ?? '-');
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        // The shared store holds the account and its address (msa_account_email: null for an unknown name and for one
        // without an address alike). Names are case-insensitive there, so the code and its limits key on the canonical
        // name: 'Alex' and 'alex' are one account and must not get two allowances.
        $acfg  = suite_cfg($suite);
        $canon = msa_normalize_username($user);
        $email = $canon !== null ? msa_account_email($acfg, $canon) : null;
        if ($canon !== null) { $user = $canon; }
        $row   = $email !== null ? ['email' => $email] : null;
    } else {
        $acc  = store_read($cfg, accounts_file($cfg));
        $row  = preg_match(USERNAME_RE, $user) ? ($acc[$user] ?? null) : null;
    }
    $shared = $suite['shared'];
    $addr = is_array($row) ? strtolower((string) ($row['email'] ?? '')) : '';
    $rules = [
        ['key' => 'ip:' . hash('sha256', $ip), 'max' => RECOVER_IP_HOUR, 'always' => true],
        ['key' => 'u:' . hash('sha256', $user), 'max' => RECOVER_USER_HOUR, 'gap' => RECOVER_COOLDOWN],
    ];
    if ($addr !== '') { $rules[] = ['key' => 'a:' . hash('sha256', $addr), 'max' => RECOVER_ADDR_HOUR]; }
    // The caps come first and name no address: one counter for the whole site and one for the account asked about
    // (a name that is no username shares one counter, so made-up strings add no rows). A request past a cap is
    // answered like a throttled one and never reaches the per-address tables, which keeps them from growing
    // by a row per forged address once the site-wide cap is spent.
    $capped = cap_take($cfg, 'recover', [
        ['key' => 'g', 'max' => RECOVER_GLOBAL_HOUR, 'window' => 3600],
        ['key' => 'g', 'max' => RECOVER_GLOBAL_DAY,  'window' => 86400],
        ['key' => 'u:' . (preg_match(USERNAME_RE, $user) ? hash('sha256', $user) : 'bad'), 'max' => RECOVER_ACCT_DAY, 'window' => 86400],
    ]);
    $granted = $capped && abuse_take($cfg, 'recover', $rules);
    $send    = null;
    $code    = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    with_lock($cfg, 'recover', function () use ($cfg, $user, $code, $row, $granted, $shared, &$send) {
        $r = store_read($cfg, recover_file($cfg));
        foreach ($r as $k => $p) { if ((int) ($p['expires'] ?? 0) < time()) { unset($r[$k]); } }
        if ($row !== null && $granted) {
            $r[$user] = ['hash' => recover_code_hash($cfg, $user, $code), 'expires' => time() + RECOVER_TTL, 'tries' => 0];
            // A code says which store it was mailed from: one issued for the legacy account never resets the shared
            // one, nor the other way round, across a switch or a hold.
            if ($shared) { $r[$user]['shared'] = true; }
            $send = (string) $row['email'];
        }
        store_write($cfg, recover_file($cfg), $r);   // written in every case: same work
    });
    usage_log($cfg, 'recover', $user);
    mail_spawn($cfg, $send !== null ? ['kind' => 'code', 'user' => $user, 'email' => $send, 'code' => $code] : ['kind' => 'none']);
    reply(200, ['ok' => true]);
}

function handle_reset(array $cfg, array $in): never
{
    $user = (string) ($in['username'] ?? '');
    $code = trim((string) ($in['code'] ?? ''));
    $pass = (string) ($in['password'] ?? '');
    if (strlen($pass) < 6) { fail(400, 'password: at least 6 characters'); }
    $suite  = suite_auth($cfg);
    $shared = $suite['shared'];
    if ($shared) {
        suite_cfg($suite);
        if (strlen($pass) > 72) { fail(400, 'password: at most 72 characters'); }   // msa_valid_new_password, checked before the code is spent
        $user = msa_normalize_username($user) ?? $user;
    }
    with_lock($cfg, 'recover', function () use ($cfg, $user, $code, $shared) {
        $r = store_read($cfg, recover_file($cfg));
        $p = $r[$user] ?? null;
        if (!$p || (int) $p['expires'] < time() || (int) $p['tries'] >= RECOVER_TRIES || !empty($p['shared']) !== $shared) {
            unset($r[$user]);
            store_write($cfg, recover_file($cfg), $r);
            fail(403, 'that code expired — start again');
        }
        // Codes issued before the hash-at-rest change (15 minute life) carry `code`.
        $good = isset($p['hash'])
            ? hash_equals((string) $p['hash'], recover_code_hash($cfg, $user, $code))
            : hash_equals((string) ($p['code'] ?? ''), $code);
        if (!$good) {
            $r[$user]['tries'] = (int) $p['tries'] + 1;
            store_write($cfg, recover_file($cfg), $r);
            fail(403, 'that code doesn\'t match');
        }
        unset($r[$user]);
        store_write($cfg, recover_file($cfg), $r);
    });
    if ($shared) {
        // One locked write in the library: the new hash, EVERY session of the account revoked (scoped ones, so imported
        // phone tokens too), the revocation generation raised, every lock cleared. Then one fresh token for this device.
        $acfg = suite_cfg($suite);
        if (!msa_reset_password($acfg, $user, $pass)) { fail(403, 'that account no longer exists'); }
        usage_log($cfg, 'reset', $user);
        reply(200, ['ok' => true, 'token' => suite_issue($acfg, $user, $pass, $suite), 'username' => $user]);
    }
    with_lock($cfg, 'accounts', function () use ($cfg, $user, $pass) {
        $acc = store_read($cfg, accounts_file($cfg));
        if (!isset($acc[$user])) { fail(403, 'that account no longer exists'); }
        $acc[$user]['hash'] = password_hash($pass, PASSWORD_DEFAULT);
        store_write($cfg, accounts_file($cfg), $acc);
    });
    tokens_revoke($cfg, $user);
    // A reset proves the mailbox: whoever did it IS the owner, and the owner
    // arriving through recovery should not stay locked out of the front door.
    lockout_clear($cfg, $user);
    usage_log($cfg, 'reset', $user);
    reply(200, ['ok' => true, 'token' => token_issue($cfg, $user), 'username' => $user]);
}

function handle_whoami(array $cfg): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $s = suite_session($suite, true);
        // The web build's cookie session learns its CSRF secret here; a bearer needs none and is told none.
        reply(200, ['ok' => true, 'username' => (string) $s['user']] + ($s['carrier'] === 'cookie' ? ['csrf' => (string) $s['csrf']] : []));
    }
    reply(200, ['ok' => true, 'username' => require_auth($cfg)]);
}

/** Shared sign-up: the suite store, CalMind's open sign-up rules, a calmind-scoped token back. */
function handle_signup_shared(array $cfg, array $suite, string $user, string $email, string $pass): never
{
    $acfg = suite_cfg($suite);
    if (strlen($pass) > 72) { fail(400, 'password: at most 72 characters'); }
    $invite = (string) ($acfg['invite_code'] ?? '');
    if ($invite === '') { fail(403, 'sign-up is closed'); }
    // A name that is still a legacy CalMind account belongs to that person (their records-<name>.json is still on disk,
    // whether or not the import brought the account in): it is never handed to someone new.
    $lower = strtolower($user);
    foreach (array_keys(store_read($cfg, accounts_file($cfg))) as $legacy) {
        if (strtolower((string) $legacy) === $lower) { fail(409, 'that username is taken'); }
    }
    if (!msa_signup($acfg, $user, $email, $pass, $invite)) { fail(409, 'that username is taken'); }
    usage_log($cfg, 'signup', $lower);
    reply(200, ['ok' => true, 'token' => suite_issue($acfg, $lower, $pass, $suite), 'username' => $lower]);
}

/**
 * Shared sign-in: msa_login with scope 'calmind', so the token is a bearer for this API only. The reply and the 429's
 * wait label are the legacy ones; the lock is the library's (per address as a speed bump, account-wide for real).
 */
function handle_login_shared(array $cfg, array $suite, array $in): never
{
    $acfg   = suite_cfg($suite);
    $user   = (string) ($in['username'] ?? '');
    $pass   = (string) ($in['password'] ?? '');
    $client = suite_client($suite);
    $now    = time();
    $until  = msa_lockout_until($acfg, $user, $client);   // 0 for an unknown name, as legacy: nothing to lock
    if ($until > $now) {
        usage_log($cfg, 'login_locked', $user);
        fail(429, 'too many attempts — locked for ' . lock_label($until - $now));
    }
    $s = msa_login($acfg, $user, $pass, suite_device(), $client, SUITE_SCOPE);
    if ($s === null) {
        usage_log($cfg, 'login_fail', $user);
        fail(401, 'wrong username or password');
    }
    usage_log($cfg, 'login', (string) $s['user']);
    reply(200, ['ok' => true, 'token' => (string) $s['token'], 'username' => (string) $s['user']]);
}

/**
 * Shared password change: refused for every carrier. MINDSUITE-LOGIN.md says a scoped session is not an account
 * credential and may not change the password (msa_session_full), and the web cookie belongs to /account/ as well, so
 * both get 403 shared:true and the password changes at /account/. A request with no session still gets 401 first.
 */
function handle_change_password_shared(array $cfg, array $suite, array $in): never
{
    suite_session($suite);
    fail_shared(403, 'change your password at /account/');
}

/** The sync round trip: accept newer records, return everything past the cursor. */
function handle_sync(array $cfg, array $in): never
{
    $user    = require_auth($cfg);
    $cursor  = max(0, (int) ($in['cursor'] ?? 0));
    $changes = is_array($in['changes'] ?? null) ? $in['changes'] : [];
    if (count($changes) > MAX_BATCH) {
        fail(400, 'batch too large');
    }
    $space = sync_space($in);
    // The LOCK is per space as well as per user, and has to be: two apps
    // writing one lock name would serialise for no reason, and — worse — a
    // lock named for the wrong file protects nothing at all.
    $out = with_lock($cfg, 'records-' . ($space === '' ? '' : $space . '-') . $user, function () use ($cfg, $user, $space, $cursor, $changes) {
        if (!account_exists($cfg, $user)) { fail(401, 'account no longer exists'); }
        $db   = store_read($cfg, records_file($cfg, $user, $space));
        $seq  = (int) ($db['seq'] ?? 0);
        $recs = is_array($db['recs'] ?? null) ? $db['recs'] : [];
        $rejected = [];
        $why      = [];   // id => one of spec/protocol.json rejectReasons
        $dropped  = 0;    // rows with no string id to name them by
        foreach ($changes as $c) {
            $id = is_array($c) && is_string($c['id'] ?? null) ? $c['id'] : '';
            if ($id === '') {
                // Nothing to name it by, so it cannot go in `rejected` — but
                // it is COUNTED, so no row leaves this loop without a word in
                // the reply (spec/protocol.json droppedResponse).
                $dropped++;
                continue;
            }
            $type    = is_string($c['type'] ?? null) ? $c['type'] : '';
            $updated = $c['updated'] ?? null;
            $bad = !preg_match(REC_ID_RE, $id) ? 'bad_id'
                : (!preg_match(REC_TYPE_RE, $type) ? 'bad_type'
                : (!is_int($updated) || $updated <= 0 ? 'bad_updated' : ''));
            if ($bad !== '') {
                // The client keeps a rejected id dirty and surfaces it to the
                // user, and the reason lets it say the right thing: "too long"
                // is the user's to fix, these are the app's bug. The rest of
                // the batch still lands.
                $rejected[] = $id;
                $why[$id] = $bad;
                continue;
            }
            if (strlen(json_encode($c['payload'] ?? null)) > MAX_PAYLOAD) {
                // Say so. Dropping it and answering ok made the client forget
                // the record was ever unsent, so it lived on one device and
                // the app called itself synced.
                $rejected[] = $id;
                $why[$id] = 'too_large';
                continue;
            }
            $cur = $recs[$id] ?? null;
            // THE TIE-BREAK, and the reason this is not just `>`.
            //
            // Strictly-newer on both sides meant an equal stamp left every
            // party holding its own copy: two devices that stamped the same
            // record identically stayed different from each other, silently
            // and permanently, and neither would ever push again because
            // neither was dirty. The owner's call, 2026-08-11: the server
            // arbitrates, because it is the one thing both devices agree on.
            //
            // So an equal stamp is accepted when the CONTENT differs — the
            // winner is whichever edit reached here last — and refused when
            // it does not, which is what stops an echo of a record we already
            // hold from bumping the sequence and re-broadcasting itself to
            // every device on every sync.
            $tie = $cur !== null
                && $updated === (int) $cur['updated']
                && !rec_same($cur, $c);
            if ($cur === null || $updated > (int) $cur['updated'] || $tie) {
                $row = ['id' => $id, 'type' => $type, 'updated' => $updated,
                        'deleted' => !empty($c['deleted']), 'payload' => $c['payload'] ?? null,
                        'seq' => ++$seq];
                // A record is REBUILT from this fixed list of keys, so anything
                // else a client sends is dropped here without a word. That is
                // the right default — it is what keeps a malformed row from
                // becoming stored state — but it means a new record-level
                // field has to be named here or it will work on one device and
                // vanish on the round trip.
                //
                // `superseded` marks a tombstone left by a CONVERSION rather
                // than a deletion, so "undo last delete" does not offer to
                // resurrect something the user never deleted. Written only
                // when true, so records that predate it are untouched byte for
                // byte, and left out of rec_same() above because it says why a
                // record went, not what it holds.
                if (!empty($c['superseded'])) { $row['superseded'] = true; }
                $recs[$id] = $row;
            }
        }
        store_write($cfg, records_file($cfg, $user, $space), ['seq' => $seq, 'recs' => $recs]);
        $tail = array_values(array_filter($recs, fn($r) => (int) ($r['seq'] ?? 0) > $cursor));
        usort($tail, fn($a, $b) => $a['seq'] <=> $b['seq']);
        return ['cursor' => $seq, 'rejected' => $rejected, 'why' => $why, 'dropped' => $dropped,
            'changes' => array_map(function ($r) {
                unset($r['seq']);
                return $r;
            }, $tail)];
    });
    usage_log($cfg, 'sync', $user);
    // `rejectedWhy` is an OBJECT even when empty: json_encode([]) is `[]`, and
    // a client indexing it by id should never meet an array.
    reply(200, ['ok' => true, 'cursor' => $out['cursor'], 'rejected' => $out['rejected'],
        'rejectedWhy' => (object) $out['why'], 'dropped' => $out['dropped'], 'changes' => $out['changes']]);
}

// ---------------------------------------------------------------- sharing

/** The user's share record out of their own store — partners, the three
 *  opt-in buckets (record ids), and per-partner `sel` overrides of those
 *  buckets. Absent record = shares nothing, names nobody. */
/**
 * SHARING IS PER SPACE, all the way down.
 *
 * ChefMind (2026-08-21) reuses these accounts and keeps its own store, and the
 * first version of that made sync space-aware and left sharing alone — so
 * ChefMind pulled the partner's CALMIND folders and showed them, on the very
 * first sign-in. The owner's words: "this should be completely separate from
 * calmind... it just shares the login mechanism and users".
 *
 * So the whole chain carries the space: who you share with, what you share,
 * what a pull returns and where a write lands are all questions about ONE
 * store. A partnership in ChefMind is declared in ChefMind by both people,
 * exactly as it is in CalMind — same UX, different file. Every user's ChefMind
 * therefore starts blank, including its partner list.
 *
 * The default is '' and the behaviour at '' is unchanged, byte for byte,
 * because that is CalMind and every existing share already lives there.
 */
function share_of(array $cfg, string $user, string $space = ''): array
{
    $db  = store_read($cfg, records_file($cfg, $user, $space));
    $rec = ($db['recs'] ?? [])['share'] ?? null;
    $p   = (is_array($rec) && empty($rec['deleted']) && is_array($rec['payload'] ?? null)) ? $rec['payload'] : [];
    $names = fn($k) => array_values(array_filter((array) ($p[$k] ?? []), 'is_string'));
    $sel   = [];
    foreach ((array) ($p['sel'] ?? []) as $who => $one) {
        // int, not just string: an all-digit username ('42' passes
        // USERNAME_RE) comes back from json_decode(..., true) as an INT key —
        // PHP coerces canonical-integer keys on decode — and a string-only
        // guard silently drops that partner's entry, so share_sel falls back
        // to the flat lists and the server QUIETLY SHOWS THEM MORE than the
        // owner's ticks say. The later $share['sel'][$viewer] lookup coerces
        // the same way, so keeping the int key resolves correctly.
        if ((!is_string($who) && !is_int($who)) || !is_array($one)) { continue; }
        $pick = fn($k) => array_values(array_filter((array) ($one[$k] ?? []), 'is_string'));
        $sel[$who] = ['calendars' => $pick('calendars'), 'folders' => $pick('folders'),
                      'notefolders' => $pick('notefolders')];
    }
    return ['partners' => $names('partners'), 'calendars' => $names('calendars'),
            'folders' => $names('folders'), 'notefolders' => $names('notefolders'), 'sel' => $sel];
}

/** The buckets $viewer may see: their per-partner entry when the owner keeps
 *  one, else the flat lists — which is also every share record written before
 *  `sel` existed, so absence changes nothing. */
function share_sel(array $share, string $viewer): array
{
    return $share['sel'][$viewer]
        ?? ['calendars' => $share['calendars'], 'folders' => $share['folders'],
            'notefolders' => $share['notefolders']];
}

/** The suite's share_mutual(): a partnership exists only while BOTH stored
 *  lists name each other — re-checked from the two stores on every request,
 *  so removal on either side ends all sharing instantly, both ways. */
function share_mutual(array $cfg, string $me, string $partner, string $space = ''): bool
{
    if ($me === $partner || $partner === '') { return false; }
    // BOTH lists are read in the SAME space. Reading one side in CalMind and
    // the other in ChefMind would make a CalMind partnership authorise a
    // ChefMind read, which is the leak this parameter exists to close.
    return in_array($partner, share_of($cfg, $me, $space)['partners'], true)
        && in_array($me, share_of($cfg, $partner, $space)['partners'], true);
}

/** Is a record inside what $share opens up? Rows follow their container. */
function share_in_scope(array $share, string $type, string $id, ?array $payload): bool
{
    $cal  = array_flip($share['calendars']);
    $fold = array_flip(array_merge($share['folders'], $share['notefolders']));
    return match ($type) {
        'calendar' => isset($cal[$id]),
        'event'    => isset($cal[(string) (($payload ?? [])['calendarId'] ?? '')]),
        'folder'   => isset($fold[$id]),
        'section', 'reminder', 'note' => isset($fold[(string) (($payload ?? [])['folderId'] ?? '')]),
        default    => false,
    };
}

/** A partner's records filtered to what they share — nothing is ever copied;
 *  this reads the owner's store directly, like the suite reading their file. */
function shared_records(array $cfg, string $owner, string $space, string $viewer): array
{
    $share = share_sel(share_of($cfg, $owner, $space), $viewer);
    $db    = store_read($cfg, records_file($cfg, $owner, $space));
    $out   = [];
    foreach (($db['recs'] ?? []) as $r) {
        if (!is_array($r) || !empty($r['deleted'])) { continue; }
        $p = is_array($r['payload'] ?? null) ? $r['payload'] : null;
        if (share_in_scope($share, (string) $r['type'], (string) $r['id'], $p)) {
            unset($r['seq']);
            $out[] = $r;
        }
    }
    return $out;
}

/** Everything the first mutual partner shares, plus every named partner's
 *  handshake state for the share window's badges. */
function handle_shared_pull(array $cfg, array $in): never
{
    $me       = require_auth($cfg);
    $space    = sync_space($in);
    $partners = [];
    $from     = null;
    $records  = [];
    foreach (share_of($cfg, $me, $space)['partners'] as $p) {
        $mutual     = share_mutual($cfg, $me, $p, $space);
        $partners[] = ['name' => $p, 'mutual' => $mutual];
        if ($mutual && $from === null) {
            $from    = $p;
            $records = shared_records($cfg, $p, $space, $me);
        }
    }
    reply(200, ['ok' => true, 'partners' => $partners, 'partner' => $from, 'records' => $records]);
}

/**
 * One write into a partner's store — the shared views' live ticks, row edits
 * and adds. Structure stays theirs: container types are refused outright,
 * and a row must sit inside the shared buckets BOTH as stored and as sent,
 * so a write can neither reach a private row nor drag one into view.
 */
function handle_shared_put(array $cfg, array $in): never
{
    $me      = require_auth($cfg);
    $space   = sync_space($in);
    $partner = (string) ($in['partner'] ?? '');
    if (!share_mutual($cfg, $me, $partner, $space)) {
        fail(403, 'not sharing');
    }
    $c = is_array($in['record'] ?? null) ? $in['record'] : null;
    if ($c === null) {
        fail(400, 'record required');
    }
    $id      = (string) ($c['id'] ?? '');
    $type    = (string) ($c['type'] ?? '');
    $updated = (int) ($c['updated'] ?? 0);
    if (!preg_match(REC_ID_RE, $id) || !preg_match(REC_TYPE_RE, $type) || $updated <= 0) {
        fail(400, 'malformed record');
    }
    if (!in_array($type, ['reminder', 'note', 'event'], true)) {
        fail(403, 'structure is theirs');
    }
    if (strlen(json_encode($c['payload'] ?? null)) > MAX_PAYLOAD) {
        fail(400, 'payload too large');
    }
    $share   = share_sel(share_of($cfg, $partner, $space), $me);
    $payload = is_array($c['payload'] ?? null) ? $c['payload'] : null;
    // The lock name carries the space for the same reason handle_sync's does:
    // a lock named for the wrong file protects nothing.
    with_lock($cfg, 'records-' . ($space === '' ? '' : $space . '-') . $partner, function () use ($cfg, $me, $partner, $space, $share, $c, $id, $type, $updated, $payload) {
        if (!account_exists($cfg, $me) || !account_exists($cfg, $partner)) { fail(401, 'account no longer exists'); }
        $db   = store_read($cfg, records_file($cfg, $partner, $space));
        $recs = is_array($db['recs'] ?? null) ? $db['recs'] : [];
        $cur  = $recs[$id] ?? null;
        $curPayload = is_array($cur['payload'] ?? null) ? $cur['payload'] : null;
        if ($cur !== null && !share_in_scope($share, (string) $cur['type'], $id, $curPayload)) {
            fail(403, 'outside what they share');
        }
        if ($payload !== null && !share_in_scope($share, $type, $id, $payload)) {
            fail(403, 'outside what they share');
        }
        if ($cur === null && $payload === null) {
            fail(400, 'nothing to write');
        }
        // THE SAME TIE-BREAK AS sync, and it was missing here.
        //
        // The owner's call, 2026-08-11: on an equal stamp the server arbitrates,
        // because it is the one thing both devices agree on. That went into
        // the sync handler and not into this one, so the identical tie
        // resolved two different ways depending on whose store was being
        // written. A tick on a partner's row that stamped equal to their own
        // last edit was dropped while this replied ok, and the reconcile then
        // pulled back their untouched copy — a tap that did nothing, said
        // nothing, and looked like the app ignoring you.
        //
        // Compared against what would actually be STORED ($payload, already
        // sanitised) rather than against the raw request, so the answer cannot
        // depend on a shape that is about to be thrown away.
        $tie = $cur !== null
            && $updated === (int) $cur['updated']
            && !rec_same($cur, ['deleted' => !empty($c['deleted']), 'payload' => $payload]);
        if ($cur === null || $updated > (int) $cur['updated'] || $tie) {
            $seq       = (int) ($db['seq'] ?? 0) + 1;
            $recs[$id] = ['id' => $id, 'type' => $type, 'updated' => $updated,
                          'deleted' => !empty($c['deleted']), 'payload' => $payload, 'seq' => $seq];
            store_write($cfg, records_file($cfg, $partner, $space), ['seq' => $seq, 'recs' => $recs]);
        }
    });
    usage_log($cfg, 'shared_put', $me);
    reply(200, ['ok' => true]);
}

// ---------------------------------------------------------------- passkeys

function passkeys_file(array $cfg): string   { return $cfg['data_dir'] . '/passkeys.json'; }
function challenges_file(array $cfg): string { return $cfg['data_dir'] . '/challenges.json'; }

/**
 * A challenge is one-time and short-lived. Storing it server-side is the whole
 * point of the ceremony: without it a replayed signature is as good as a
 * fresh one.
 */
function challenge_issue(array $cfg, string $user = ''): string
{
    $c = b64u_encode(random_bytes(32));
    with_lock($cfg, 'challenges', function () use ($cfg, $c, $user) {
        $all = store_read($cfg, challenges_file($cfg));
        $now = time();
        $all = array_filter($all, fn($v) => ($v['created'] ?? 0) > $now - WEBAUTHN_CHALLENGE_TTL);
        $all[$c] = ['user' => $user, 'created' => $now];
        // Keep the newest by ARRIVAL, not by timestamp. A burst arrives inside
        // the same second, so sorting on `created` orders equal keys
        // arbitrarily and can evict the challenge issued a microsecond ago —
        // which is the one belonging to the person actually signing in. PHP
        // keeps insertion order, and this row was just appended.
        if (count($all) > WEBAUTHN_MAX_CHALLENGES) {
            $all = array_slice($all, -WEBAUTHN_MAX_CHALLENGES, null, true);
        }
        store_write($cfg, challenges_file($cfg), $all);
    });
    return $c;
}

/** Reads a challenge and burns it; null if it never existed or has expired. */
function challenge_take(array $cfg, string $c): ?array
{
    return with_lock($cfg, 'challenges', function () use ($cfg, $c): ?array {
        $all = store_read($cfg, challenges_file($cfg));
        $row = $all[$c] ?? null;
        unset($all[$c]);
        store_write($cfg, challenges_file($cfg), $all);
        if ($row === null || ($row['created'] ?? 0) <= time() - WEBAUTHN_CHALLENGE_TTL) {
            return null;
        }
        return $row;
    });
}

/** The checks both ceremonies share: the browser's own account of what it did. */
function client_data_check(array $cfg, string $json, string $wantType): array
{
    $d = json_decode($json, true);
    if (!is_array($d))                              { fail(400, 'passkey: unreadable client data'); }
    if (($d['type'] ?? '') !== $wantType)           { fail(400, 'passkey: wrong ceremony'); }
    if (!webauthn_origin_ok((string) ($d['origin'] ?? ''), webauthn_origin($cfg))) {
        fail(400, 'passkey: wrong origin');
    }
    if (($d['crossOrigin'] ?? false) !== false)     { fail(400, 'passkey: cross-origin ceremony'); }
    return $d;
}

function handle_passkey_register_begin(array $cfg): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $s = suite_passkey_owner($suite);
        $opts = msa_passkey_register_begin(suite_cfg($suite), $s['session']);
        if ($opts === null) { fail_shared(403, 'passkey: add passkeys at /account/'); }
        reply(200, ['ok' => true] + $opts);
    }
    $user = require_auth($cfg);
    $mine = array_filter(store_read($cfg, passkeys_file($cfg)), fn($v) => ($v['user'] ?? '') === $user);
    reply(200, [
        'ok'        => true,
        'challenge' => challenge_issue($cfg, $user),
        'rp'        => ['id' => webauthn_rp_id($cfg), 'name' => 'CalMind'],
        // The user handle is the username: this is a single-account-per-name
        // app, and it is what a passkey login has to resolve back to.
        'user'      => ['id' => b64u_encode($user), 'name' => $user, 'displayName' => $user],
        'pubKeyCredParams' => [
            ['type' => 'public-key', 'alg' => COSE_ES256],
            ['type' => 'public-key', 'alg' => COSE_RS256],
        ],
        'authenticatorSelection' => ['residentKey' => 'required', 'userVerification' => 'required'],
        'attestation'        => 'none',
        'excludeCredentials' => array_values(array_map(
            fn($id) => ['type' => 'public-key', 'id' => $id],
            array_keys($mine),
        )),
    ]);
}

function handle_passkey_register_finish(array $cfg, array $in): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $s  = suite_passkey_owner($suite);
        $id = msa_passkey_register_finish(suite_cfg($suite), $s['session'], $in);
        if ($id === null) { fail(400, 'passkey: not accepted'); }
        usage_log($cfg, 'passkey_add', (string) $s['user']);
        reply(200, ['ok' => true, 'id' => $id]);
    }
    $user = require_auth($cfg);
    $clientJson = b64u_decode((string) ($in['clientDataJSON'] ?? ''));
    $d = client_data_check($cfg, $clientJson, 'webauthn.create');
    $row = challenge_take($cfg, (string) ($d['challenge'] ?? ''));
    if ($row === null || ($row['user'] ?? '') !== $user) { fail(400, 'passkey: stale challenge'); }

    try {
        $att = cbor_decode(b64u_decode((string) ($in['attestationObject'] ?? '')));
        if (!is_array($att) || !isset($att['authData'])) { fail(400, 'passkey: no authenticator data'); }
        $auth = authdata_parse((string) $att['authData']);
        $pem  = $auth['cose'] === null ? '' : cose_to_pem($auth['cose']);
    } catch (RuntimeException $e) {
        fail(400, 'passkey: ' . $e->getMessage());
    }
    if (!hash_equals(hash('sha256', webauthn_rp_id($cfg), true), $auth['rpIdHash'])) {
        fail(400, 'passkey: wrong relying party');
    }
    // User presence AND user verification: we asked for a fingerprint or a
    // face, and a passkey that skipped it is not the login we offered.
    if (($auth['flags'] & 0x01) === 0 || ($auth['flags'] & 0x04) === 0) {
        fail(400, 'passkey: not verified on the device');
    }
    if ($pem === '') { fail(400, 'passkey: no public key'); }

    $id = b64u_encode($auth['credId']);
    with_lock($cfg, 'passkeys', function () use ($cfg, $id, $user, $pem, $auth, $in) {
        if (!account_exists($cfg, $user)) { fail(401, 'account no longer exists'); }
        $all = store_read($cfg, passkeys_file($cfg));
        if (isset($all[$id])) { fail(409, 'passkey: already registered'); }
        $all[$id] = [
            'user'      => $user,
            'pem'       => $pem,
            'signCount' => $auth['signCount'],
            'label'     => substr(trim((string) ($in['label'] ?? 'passkey')), 0, 40),
            'created'   => time(),
        ];
        store_write($cfg, passkeys_file($cfg), $all);
    });
    usage_log($cfg, 'passkey_add', $user);
    reply(200, ['ok' => true, 'id' => $id]);
}

function handle_passkey_login_begin(array $cfg): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        try { $opts = msa_passkey_login_begin(suite_cfg($suite)); }
        catch (InvalidArgumentException) { fail_shared(503, 'sign-in unavailable'); }   // no valid relying party configured
        reply(200, ['ok' => true] + $opts);
    }
    // No username: the passkey is discoverable, so the authenticator tells us
    // who it is. Asking who they are first would leak which names exist.
    reply(200, [
        'ok'               => true,
        'challenge'        => challenge_issue($cfg),
        'rpId'             => webauthn_rp_id($cfg),
        'userVerification' => 'required',
    ]);
}

function handle_passkey_login_finish(array $cfg, array $in): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) { handle_passkey_login_finish_shared($cfg, $suite, $in); }
    $clientJson = b64u_decode((string) ($in['clientDataJSON'] ?? ''));
    $d = client_data_check($cfg, $clientJson, 'webauthn.get');
    if (challenge_take($cfg, (string) ($d['challenge'] ?? '')) === null) {
        fail(400, 'passkey: stale challenge');
    }

    $id  = (string) ($in['id'] ?? '');
    $all = store_read($cfg, passkeys_file($cfg));
    $key = $all[$id] ?? null;
    if ($key === null) {
        usage_log($cfg, 'passkey_fail', '');
        fail(401, 'passkey: not recognised');
    }

    $authRaw = b64u_decode((string) ($in['authenticatorData'] ?? ''));
    try {
        $auth = authdata_parse($authRaw);
    } catch (RuntimeException $e) {
        fail(400, 'passkey: ' . $e->getMessage());
    }
    if (!hash_equals(hash('sha256', webauthn_rp_id($cfg), true), $auth['rpIdHash'])) {
        fail(400, 'passkey: wrong relying party');
    }
    if (($auth['flags'] & 0x01) === 0 || ($auth['flags'] & 0x04) === 0) {
        fail(401, 'passkey: not verified on the device');
    }

    $signed = $authRaw . hash('sha256', $clientJson, true);
    $ok = openssl_verify($signed, b64u_decode((string) ($in['signature'] ?? '')), $key['pem'], OPENSSL_ALGO_SHA256);
    if ($ok !== 1) {
        usage_log($cfg, 'passkey_fail', (string) $key['user']);
        fail(401, 'passkey: signature did not verify');
    }

    // A counter that goes backwards means two authenticators are answering for
    // one credential. Plenty of passkeys report 0 forever, and 0 vs 0 is not
    // evidence of anything. But once a credential has reported a counter, a
    // zero or a repeat is a replay or a clone, as in the shared library.
    $stored = (int) ($key['signCount'] ?? 0);
    if ($stored > 0 && $auth['signCount'] <= $stored) {
        usage_log($cfg, 'passkey_clone', (string) $key['user']);
        fail(401, 'passkey: refused, counter went backwards');
    }
    with_lock($cfg, 'passkeys', function () use ($cfg, $id, $auth) {
        $all = store_read($cfg, passkeys_file($cfg));
        if (isset($all[$id])) {
            $all[$id]['signCount'] = $auth['signCount'];
            $all[$id]['used']      = time();
            store_write($cfg, passkeys_file($cfg), $all);
        }
    });

    $user = (string) $key['user'];
    usage_log($cfg, 'passkey_login', $user);
    reply(200, ['ok' => true, 'token' => token_issue($cfg, $user), 'username' => $user]);
}

function handle_passkey_list(array $cfg): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        // The library lists nothing to a calmind token: it is not an account credential.
        reply(200, ['ok' => true, 'passkeys' => msa_passkey_list(suite_cfg($suite), suite_session($suite)['session'])]);
    }
    $user = require_auth($cfg);
    $out  = [];
    foreach (store_read($cfg, passkeys_file($cfg)) as $id => $v) {
        if (($v['user'] ?? '') === $user) {
            $out[] = ['id' => $id, 'label' => $v['label'] ?? 'passkey', 'created' => $v['created'] ?? 0, 'used' => $v['used'] ?? 0];
        }
    }
    reply(200, ['ok' => true, 'passkeys' => $out]);
}

function handle_passkey_remove(array $cfg, array $in): never
{
    $suite = suite_auth($cfg);
    if ($suite['shared']) {
        $s = suite_session($suite);
        // False for a calmind token (msa_session_full), for an unknown id and for someone else's: one answer for all.
        if (!msa_passkey_remove(suite_cfg($suite), $s['session'], (string) ($in['id'] ?? ''))) { fail(404, 'passkey: not yours'); }
        usage_log($cfg, 'passkey_remove', (string) $s['user']);
        reply(200, ['ok' => true]);
    }
    $user = require_auth($cfg);
    $id   = (string) ($in['id'] ?? '');
    with_lock($cfg, 'passkeys', function () use ($cfg, $id, $user) {
        $all = store_read($cfg, passkeys_file($cfg));
        if (($all[$id]['user'] ?? '') !== $user) { fail(404, 'passkey: not yours'); }
        unset($all[$id]);
        store_write($cfg, passkeys_file($cfg), $all);
    });
    usage_log($cfg, 'passkey_remove', $user);
    reply(200, ['ok' => true]);
}

/**
 * Passkeys change the ACCOUNT, so only a full session may add one (the library's msa_session_full): in shared mode
 * that is the web build's cookie. A calmind token is refused before any challenge is spent.
 */
function suite_passkey_owner(array $suite): array
{
    $s = suite_session($suite);
    if ($s['carrier'] !== 'cookie') { fail_shared(403, 'passkey: add passkeys at /account/'); }
    return $s;
}

/**
 * Shared passkey sign-in for a native client. The library's ceremony issues a FULL-account session, which must never
 * reach a phone as a bearer (it would open every suite app and, as a cookie, every page). So the row is narrowed to
 * scope 'calmind' under the store lock before its token leaves this process; if that cannot be done the session is
 * revoked and the sign-in fails.
 */
function handle_passkey_login_finish_shared(array $cfg, array $suite, array $in): never
{
    $acfg = suite_cfg($suite);
    try { $s = msa_passkey_login_finish($acfg, $in, suite_device()); }
    catch (InvalidArgumentException) { fail_shared(503, 'sign-in unavailable'); }
    if ($s === null) {
        usage_log($cfg, 'passkey_fail', '');
        fail(401, 'passkey: not recognised');
    }
    $id = hash('sha256', (string) $s['token']);
    $scoped = msa_lock($acfg, function () use ($acfg, $id, $s): bool {
        $db = msa_store_read($acfg);
        if (($db['sessions'][$id]['user'] ?? null) !== $s['user']) { return false; }
        $db['sessions'][$id]['scope'] = SUITE_SCOPE;
        msa_store_write($acfg, $db);
        return true;
    });
    if (!$scoped) {
        msa_revoke($acfg, ['id' => $id, 'user' => (string) $s['user']]);
        fail_shared(503, 'sign-in unavailable');
    }
    usage_log($cfg, 'passkey_login', (string) $s['user']);
    reply(200, ['ok' => true, 'token' => (string) $s['token'], 'username' => (string) $s['user']]);
}

/**
 * Fetch a recipe page so the client can read its structured data.
 *
 * The browser cannot do this itself — a recipe site does not send CORS
 * headers to a web app, and a native build fetching arbitrary pages has the
 * same SSRF problem from the phone's network. So the server fetches, through
 * fetchurl.php, which was built carefully for exactly this and wired to
 * nothing until now: public addresses only, checked on every redirect hop,
 * bounded in time and size.
 *
 * Returns the HTML and nothing else. The PARSING lives in core
 * (recipeFromHtml), where it is tested — the server has no opinion about
 * what a recipe is, and a change to the parser must not need a deploy.
 *
 * Authed: it makes the server issue requests, so it is not an open proxy.
 */
/**
 * A subscribed calendar's ICS, fetched by the server. The owner's call,
 * 2026-08-18: "subscribe-by-link first, i just want read only access to
 * other calendar system" — and the fetch HAS to be server-side, because
 * calendar hosts do not answer CORS and a browser cannot read them.
 *
 * The server stays dumb, the suite's way: it hands back the ICS TEXT and
 * core's parseIcal (234 lines, tested, zone-aware) decides what it means on
 * the client — a parser change must not need a deploy. fetch_url does the
 * SSRF work; it was built for exactly this file type and waited months for
 * this caller.
 *
 * Cached briefly, keyed by the URL's hash, through store_read/store_write —
 * which buys ENC1 at rest (a private feed URL's CONTENT is someone's
 * calendar) and the atomic temp-file write, for free. Fifteen minutes keeps
 * a four-device account from hammering a host on every foreground; a fetch
 * that FAILS falls back to the stale copy when one exists, because last
 * week's calendar beats an error on a train.
 *
 * Authed, like recipe_fetch and for the same reason: this makes the server
 * issue requests, so it is not an open proxy.
 */
const CALSUB_CACHE_TTL = 900;

function handle_calsub_fetch(array $cfg, array $in): never
{
    $user = require_auth($cfg);
    $source = is_string($in['source'] ?? null) ? $in['source'] : '';
    if (!in_array($source, ['', 'ical', 'ics', 'google', 'caldav'], true)) {
        fail(400, 'unknown calendar source');
    }
    if ($source === 'caldav') {
        try { [$url, $username, $password] = caldav_credentials($in); }
        catch (InvalidArgumentException $e) { fail(400, $e->getMessage()); }
        $file = caldav_cache_file($cfg, $user, $url, $username, $password);
    } else {
        $url = trim((string) ($in['url'] ?? ''));
        if ($url === '') {
            fail(400, 'no url');
        }
        // webcal:// is how calendar apps hand these links out; it MEANS https.
        if (stripos($url, 'webcal://') === 0) {
            $url = 'https://' . substr($url, 9);
        }
        $file = $cfg['data_dir'] . '/icscache/' . sha1($url) . '.json';
    }
    // A cache that will not decrypt is a cache miss, not an outage — unlike
    // the record store, everything here can be fetched again.
    try {
        $cached = store_read($cfg, $file);
    } catch (Throwable) {
        $cached = [];
    }
    $ics = (string) ($cached['ics'] ?? '');
    if ($ics !== '' && (int) ($cached['at'] ?? 0) > time() - CALSUB_CACHE_TTL) {
        reply(200, ['ok' => true, 'ics' => $ics, 'cached' => true]);
    }
    if ($source === 'caldav') {
        try { $res = ['ok' => true, 'body' => caldav_fetch($url, $username, $password)]; }
        catch (RuntimeException | InvalidArgumentException $e) { $res = ['ok' => false, 'error' => $e->getMessage()]; }
    } else {
        $res = fetch_url($url);
    }
    if (!$res['ok']) {
        if ($ics !== '') {
            reply(200, ['ok' => true, 'ics' => $ics, 'cached' => true, 'stale' => true]);
        }
        // The reason travels, recipe_fetch's lesson: 'not a public address'
        // and 'took too long' are different problems for whoever pasted it.
        $why = trim((string) ($res['error'] ?? ''));
        if ($why === '') {
            $code = (int) ($res['status'] ?? 0);
            $why = $code > 0 ? "that calendar's host answered $code" : 'could not reach that calendar';
        }
        fail(400, $why);
    }
    $body = (string) $res['body'];
    if (stripos($body, 'BEGIN:VCALENDAR') === false) {
        fail(400, 'that link is not a calendar (.ics) feed');
    }
    store_write($cfg, $file, ['at' => time(), 'ics' => $body]);
    reply(200, ['ok' => true, 'ics' => $body, 'cached' => false]);
}

function handle_calsub_discover(array $cfg, array $in): never
{
    require_auth($cfg);
    try {
        [$url, $username, $password] = caldav_credentials($in);
        $calendars = caldav_discover($url, $username, $password);
    } catch (RuntimeException | InvalidArgumentException $e) {
        fail(400, $e->getMessage());
    }
    reply(200, ['ok' => true, 'calendars' => $calendars]);
}

function handle_recipe_fetch(array $cfg, array $in): never
{
    require_auth($cfg);
    $url = trim((string) ($in['url'] ?? ''));
    if ($url === '') {
        fail(400, 'no url');
    }
    $res = fetch_url($url);
    if (!$res['ok']) {
        // The reason travels: 'that is not a public address' and 'the page
        // took too long' are different problems for whoever pasted the link.
        //
        // `?:` not `??`. With `??` an EMPTY error string passed straight
        // through, and the app showed a blank message — which is how a real
        // failure (allrecipes.com refuses this server outright) looked like
        // nothing happening at all. A message that says nothing is worse than
        // a generic one that says something.
        $why = trim((string) ($res['error'] ?? ''));
        if ($why === '') {
            $code = (int) ($res['status'] ?? 0);
            $why = $code > 0
                ? "that site answered $code — some block servers like this one"
                : 'could not reach that page';
        }
        fail(400, $why);
    }
    // A recipe page is HTML. Anything else — a PDF, an image, a 4MB video —
    // has no JSON-LD to find and is not worth carrying back to the client.
    $body = (string) $res['body'];
    if (stripos($body, '<html') === false && stripos($body, '<script') === false) {
        fail(400, 'that page does not look like a web page');
    }
    reply(200, ['ok' => true, 'html' => $body]);
}

// ---------------------------------------------------------------- meeting requests
//
// The public request page (the owner, 2026-08-19): anyone with the link may ask
// for ~1 hour inside the day's open window, on any day his calendar leaves
// open. The window is HIS WEEK, not one number — see meetreq_window(). The
// slot arithmetic lives HERE rather than in core — a deliberate exception to
// "behavior lives in core": an anonymous create must be validated by the
// server against the same rule the page drew, and a rule the server cannot
// run is a rule it cannot enforce. core/src/meetreq.ts owns the client half
// (what accepting builds) and says the same thing from its side.
//
// A granted request is appended to the OWNER'S OWN STORE as a `meetreq`
// record, so it reaches every device through ordinary sync — no new channel,
// no polling endpoint, and accept/decline/new-time are ordinary record edits
// made by his client.

const MEETREQ_IP_MAX = 5;      // creates per IP per hour — it is a public write
const MEETREQ_PENDING_MAX = 200; // a flood must not balloon the store

/** The day's requestable window as [startHour, endHourExclusive) — the owner's
 *  hours (2026-08-19, settled on the third pass): every day 10am–8pm, except
 *  Tuesday opens at 2pm and Friday/Saturday run to 11pm. The end is
 *  exclusive, so the last ~1h slot starts one hour before close. */
function meetreq_window(string $date): array
{
    $dow = (int) date('N', strtotime($date)); // 1 = Monday … 7 = Sunday
    if ($dow === 2) { return [14, 20]; }
    if ($dow === 5 || $dow === 6) { return [10, 23]; }
    return [10, 20];
}

/** '10am', '2pm', '11pm' — how a window edge reads in a refusal. */
function meetreq_hour_label(int $h): string
{
    $h12 = $h % 12 === 0 ? 12 : $h % 12;
    return $h12 . ($h < 12 ? 'am' : 'pm');
}

function meetreq_user(array $cfg): string
{
    // Whose calendar the public page offers. One account per instance is the
    // reality; app_config() takes it from config.php or the env, and a missing
    // key stays '' (the page is off), never a built-in account. A value that
    // is not a plausible username (an array, a number, a malformed string)
    // counts as missing: a broken config closes the page, it does not open it
    // onto whatever the value happens to cast to.
    $u = $cfg['meetreq_user'] ?? '';
    return is_string($u) && preg_match(USERNAME_RE, $u) ? $u : '';
}

/**
 * PUBLIC: whose calendar a request-page call is about. Ends the request itself
 * when there is no answer: an instance with no usable meetreq_user has no
 * request page at all (404 'not configured'), whatever account the caller
 * names, so a missing config can never be bypassed with the `user` parameter.
 * On a configured instance that parameter still picks the account, which is how
 * the e2e harness points the page at the accounts it mints per run.
 */
function meetreq_public_user(array $cfg, array $in): string
{
    $owner = meetreq_user($cfg);
    if ($owner === '') { fail(404, 'not configured'); }
    $asked = $in['user'] ?? '';
    if (!is_string($asked)) { fail(400, 'bad user'); }
    $user = $asked !== '' ? $asked : $owner;
    if (!preg_match(USERNAME_RE, $user)) { fail(400, 'bad user'); }
    return $user;
}

/** The owner's records, read ONCE per request.
 *
 *  handle_meetreq_slots asks about up to 45 days in a row and every one of
 *  them used to decrypt and parse the whole store again — 45 reads to answer
 *  one page load, and the availability lookup added below would have made it
 *  90. The store cannot change underneath a single request, so the second
 *  read never had anything to learn. */
function meetreq_recs(array $cfg, string $user): array
{
    static $cache = [];
    if (!array_key_exists($user, $cache)) {
        $db = store_read($cfg, records_file($cfg, $user));
        $cache[$user] = is_array($db['recs'] ?? null) ? $db['recs'] : [];
    }
    return $cache[$user];
}

/**
 * One day's availability overrides — the owner's answer on top of the rules
 * (2026-08-21), and the final say over both the window and his calendar.
 *
 * The record is written by his own client (core's slotSet builds it) and
 * arrives here through ordinary sync, which is why this reads the store
 * rather than a settings file: there is no second channel to keep honest.
 * core/src/meetreq.ts holds the same arithmetic for the screen; the two are
 * pinned separately, in meetavail.test.ts and in server/tools/test.php.
 */
function meetreq_avail(array $cfg, string $user, string $date): array
{
    $want = 'meetavail_' . $date;
    foreach (meetreq_recs($cfg, $user) as $r) {
        if (($r['id'] ?? '') !== $want || !empty($r['deleted'])) { continue; }
        $p = $r['payload'] ?? [];
        // Anything that is not a list of strings is treated as no override.
        // A damaged payload must not decide that a day is wide open.
        $clean = static fn($v) => is_array($v)
            ? array_values(array_filter($v, static fn($x) => is_string($x)))
            : [];
        return ['off' => $clean($p['off'] ?? null), 'on' => $clean($p['on'] ?? null)];
    }
    return ['off' => [], 'on' => []];
}

/** The day's busy windows as [startMin, endMin), from the owner's events.
 *  Timeless events do not block — a day-marker ("Recycling") is not a
 *  meeting — and neither do pending requests: only an ACCEPTED one has
 *  become an event, and letting raw requests block slots would let anyone
 *  squat the calendar by asking. */
function meetreq_busy(array $cfg, string $user, string $date): array
{
    $busy = [];
    foreach (meetreq_recs($cfg, $user) as $r) {
        if (($r['type'] ?? '') !== 'event' || !empty($r['deleted'])) { continue; }
        $p = $r['payload'] ?? [];
        if (($p['date'] ?? '') !== $date) { continue; }
        $t = (string) ($p['time'] ?? '');
        if (!preg_match('/^(\d{2}):(\d{2})$/', $t, $m)) { continue; }
        $s = (int) $m[1] * 60 + (int) $m[2];
        $e = $s + 60;
        $endRaw = (string) ($p['end'] ?? '');
        if (preg_match('/^(\d{2}):(\d{2})$/', $endRaw, $me)) {
            $em = (int) $me[1] * 60 + (int) $me[2];
            // An end past midnight reads as the small hours (the event model's
            // own rule); for blocking purposes that is "until the day ends".
            $e = $em > $s ? $em : 24 * 60;
        }
        $busy[] = [$s, $e];
    }
    return $busy;
}

/**
 * The day's whole window, each hour flagged with whether his calendar has
 * something in it — what the OWNER sees, overrides not yet applied.
 *
 * The owner, 2026-08-21: "times where i already have something on the calendar
 * default to red, they aren't omitted in my view so i can override". So the
 * busy hours have to survive this far and be filtered out later; a function
 * that dropped them here could not answer his screen.
 *
 * Two things are NOT overridable and so are settled here rather than left to
 * the caller: a day already past, and an hour already gone today. No setting
 * makes yesterday requestable.
 */
function meetreq_day_slots(array $cfg, string $user, string $date): array
{
    $today = date('Y-m-d');
    if ($date < $today) { return []; }
    $nowMin = $date === $today ? ((int) date('G')) * 60 + (int) date('i') : -1;
    $busy = meetreq_busy($cfg, $user, $date);
    [$open, $close] = meetreq_window($date);
    $out = [];
    for ($h = $open; $h < $close; $h++) {
        $s = $h * 60;
        if ($s <= $nowMin) { continue; }
        $blocked = false;
        foreach ($busy as [$bs, $be]) {
            if ($bs < $s + 60 && $be > $s) { $blocked = true; break; }
        }
        $out[] = ['time' => sprintf('%02d:00', $h), 'busy' => $blocked];
    }
    return $out;
}

/** Which 'HH:00' starts are open on one day — the window, minus his
 *  calendar, with his own overrides on top and having the last word. */
function meetreq_slots_for(array $cfg, string $user, string $date): array
{
    $av  = meetreq_avail($cfg, $user, $date);
    $out = [];
    foreach (meetreq_day_slots($cfg, $user, $date) as $slot) {
        $t = $slot['time'];
        // The same three lines core's slotOpen runs, in the same order.
        $open = in_array($t, $av['on'], true) ? true
            : (in_array($t, $av['off'], true) ? false : !$slot['busy']);
        if ($open) { $out[] = $t; }
    }
    return $out;
}

/** PUBLIC: the open slots for a run of days — what the request page draws.
 *  Only open/closed leaves here: no titles, no ids, no exact busy times. */
function handle_meetreq_slots(array $cfg, array $in): never
{
    $user = meetreq_public_user($cfg, $in);
    $from = (string) ($in['from'] ?? date('Y-m-d'));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) { fail(400, 'bad from'); }
    $days = min(45, max(1, (int) ($in['days'] ?? 31)));
    $out = [];
    for ($i = 0; $i < $days; $i++) {
        $d = date('Y-m-d', strtotime("$from +$i day"));
        $out[$d] = meetreq_slots_for($cfg, $user, $d);
    }
    usage_log($cfg, 'meetreq_slots', $user);
    reply(200, ['ok' => true, 'days' => $out]);
}

/**
 * OWNER-ONLY: one day's whole window, busy hours included, for the
 * availability editor under the Requests menu (the owner, 2026-08-21).
 *
 * This is the public endpoint's mirror image and deliberately so: that one
 * leaks nothing (open starts only, no titles, no clash times), and this one
 * has to show the clashes, because a slot he cannot see is a slot he cannot
 * override. It is behind require_auth and answers about the signed-in
 * account's OWN calendar — the `user` parameter the public pair accepts is
 * not read here at all, so no token can ask about anyone else's day.
 *
 * `owner` is what decides whether the editor appears. It is the server's
 * answer rather than a name compiled into the app: the account whose
 * availability the public page actually serves is a fact only this instance
 * holds, and an editor drawn for anyone else would write records that
 * nothing on the internet would ever read.
 */
function handle_meetreq_day(array $cfg, array $in): never
{
    $user = require_auth($cfg);
    $date = (string) ($in['date'] ?? '');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) { fail(400, 'bad date'); }
    if ($user !== meetreq_user($cfg)) {
        // Not a refusal: there is simply no request page behind this account.
        reply(200, ['ok' => true, 'owner' => false, 'slots' => []]);
    }
    usage_log($cfg, 'meetreq_day', $user);
    reply(200, ['ok' => true, 'owner' => true, 'slots' => meetreq_day_slots($cfg, $user, $date)]);
}

/** PUBLIC: create a request. Validated against the same slot rule the page
 *  drew — never trust the client's idea of "open". */
function handle_meetreq_create(array $cfg, array $in): never
{
    $user  = meetreq_public_user($cfg, $in);
    $name  = trim(preg_replace('/[\x00-\x1f\x7f]/', '', (string) ($in['name'] ?? '')));
    $email = trim((string) ($in['email'] ?? ''));
    $date  = (string) ($in['date'] ?? '');
    $time  = (string) ($in['time'] ?? '');
    if ($name === '' || mb_strlen($name) > 80) { fail(400, 'a name is required (up to 80 characters)'); }
    if (strlen($email) > 120 || !filter_var($email, FILTER_VALIDATE_EMAIL)) { fail(400, 'a real email is required'); }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) { fail(400, 'bad date'); }
    if (!preg_match('/^(\d{2}):00$/', $time, $m)) { fail(400, 'meetings start on the hour'); }
    [$open, $close] = meetreq_window($date);
    if ((int) $m[1] < $open || (int) $m[1] >= $close) {
        fail(400, sprintf('meetings run %s to %s that day, on the hour',
            meetreq_hour_label($open), meetreq_hour_label($close)));
    }

    // Caps first, and they name no address: the site-wide ones and one for the account asked about, whether or not it
    // exists (a made-up name costs the same counter and gets the same answer). Refused with the per-IP words.
    if (!cap_take($cfg, 'meetreq', [
        ['key' => 'g', 'max' => MEETREQ_GLOBAL_HOUR, 'window' => 3600],
        ['key' => 'g', 'max' => MEETREQ_GLOBAL_DAY,  'window' => 86400],
        ['key' => 'u:' . hash('sha256', $user), 'max' => MEETREQ_ACCT_HOUR, 'window' => 3600],
        ['key' => 'u:' . hash('sha256', $user), 'max' => MEETREQ_ACCT_DAY,  'window' => 86400],
    ])) {
        fail(429, 'too many requests from here — try again in an hour');
    }

    // A public write gets a per-IP throttle — the same posture as login's
    // lockouts, sized for a human politely rescheduling, not a script. The client picks that address on
    // NearlyFreeSpeech, so it is a speed bump; the caps above are the limit.
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '-');
    $now = time();
    $granted = with_lock($cfg, 'meetreq-ips', function () use ($cfg, $ip, $now) {
        $f = $cfg['data_dir'] . '/meetreq-ips.json';
        $all = store_read($cfg, $f);
        $mine = array_values(array_filter($all[$ip] ?? [], fn($t) => $t > $now - 3600));
        if (count($mine) >= MEETREQ_IP_MAX) { return false; }
        $mine[] = $now;
        $all[$ip] = $mine;
        // Prune dead IPs so the file cannot grow without bound.
        foreach ($all as $k => $ts) {
            $ts = array_values(array_filter($ts, fn($t) => $t > $now - 3600));
            if ($ts === []) { unset($all[$k]); } else { $all[$k] = $ts; }
        }
        store_write($cfg, $f, $all);
        return true;
    });
    if (!$granted) { fail(429, 'too many requests from here — try again in an hour'); }

    // An account that does not exist gets a quiet ok and no write: which
    // usernames exist is nobody's business (recover's rule), and the real
    // page always carries a real user.
    if (!account_exists($cfg, $user)) {   // the shared store's accounts once sign-in is shared
        usage_log($cfg, 'meetreq_create_orphan', $user);
        reply(200, ['ok' => true]);
    }

    if (!in_array($time, meetreq_slots_for($cfg, $user, $date), true)) {
        fail(409, 'that time is no longer open — pick another');
    }

    with_lock($cfg, 'records-' . $user, function () use ($cfg, $user, $name, $email, $date, $time) {
        $db   = store_read($cfg, records_file($cfg, $user));
        $seq  = (int) ($db['seq'] ?? 0);
        $recs = is_array($db['recs'] ?? null) ? $db['recs'] : [];
        $pending = 0;
        foreach ($recs as $r) {
            if (($r['type'] ?? '') === 'meetreq' && empty($r['deleted'])) { $pending++; }
        }
        if ($pending >= MEETREQ_PENDING_MAX) { fail(429, 'the calendar is not taking requests right now'); }
        $id = 'mr' . bin2hex(random_bytes(5));
        $recs[$id] = [
            'id' => $id, 'type' => 'meetreq',
            'updated' => (int) (microtime(true) * 1000), 'deleted' => false,
            'payload' => ['name' => $name, 'email' => $email, 'date' => $date, 'time' => $time, 'status' => 'new'],
            'seq' => ++$seq,
        ];
        store_write($cfg, records_file($cfg, $user), ['seq' => $seq, 'recs' => $recs]);
    });
    // The owner's heads-up, only with mail on and only to the configured owner's own account address (never to anything the visitor
    // typed, and the text names no visitor: just the slot). It follows a request that was actually written, so the
    // create caps above (site-wide and per account) are also the notice's caps. Sent by the detached worker.
    // Only the configured owner's account: the public `user` parameter can name any account, and a sign-up address is
    // unverified (anyone can register a victim's), so no other account's address is ever mailed.
    if (mail_enabled($cfg) && $user === meetreq_user($cfg)) {
        $ownerTo = account_email($cfg, $user);
        if ($ownerTo !== null
            && !mail_spawn($cfg, ['kind' => 'meetreq_notice', 'user' => $user, 'to' => $ownerTo, 'when' => "$date $time"])) {
            mail_log_write($cfg, 'meetreq-mail.log', date('c') . '  by=' . $user . "  to=owner  kind=notice  when=$date $time  NOT SENT (cannot start the mail worker)\n");
        }
    }
    usage_log($cfg, 'meetreq_create', $user);
    reply(200, ['ok' => true]);
}

/**
 * Log the meeting response and send it when SMTP is enabled.
 * Authenticated, and bounded: sign-up is open, so this must not be a mail relay.
 * The recipient is never a free value: only the request-page owner may use it, and only
 * for the address stored on one of his meetreq records, optionally pinned by `id`. An
 * account's own sign-up address is NOT allowed (it is unverified: anyone can register a victim's). `when` must be a date and clock time (MEETREQ_WHEN_RE), so no
 * caller-chosen text reaches the mail. Per-user and per-IP hourly limits apply to every
 * well-formed attempt, and a per-address limit to every authorised one (MEETREQ_MAIL_*).
 */
function handle_meetreq_mail(array $cfg, array $in): never
{
    $user = require_auth($cfg);
    $to   = trim((string) ($in['to'] ?? ''));
    $kind = (string) ($in['kind'] ?? '');
    $when = trim((string) ($in['when'] ?? ''));
    $id   = (string) ($in['id'] ?? '');
    if (strlen($to) > 120 || !filter_var($to, FILTER_VALIDATE_EMAIL)) { fail(400, 'bad to'); }
    if (!in_array($kind, ['accepted', 'declined', 'newtime'], true)) { fail(400, 'bad kind'); }
    if ($id !== '' && !preg_match(REC_ID_RE, $id)) { fail(400, 'bad id'); }
    // `when` is never free text: a date and a clock time, as the app writes them, or the
    // mail has no way to carry an attacker's words or links. Declined mails carry none.
    if ($kind === 'declined') { $when = ''; }
    elseif (strlen($when) > 40 || !preg_match(MEETREQ_WHEN_RE, $when)) { fail(400, 'bad when'); }
    $ok = abuse_take($cfg, 'meetreq-mail', [
        ['key' => 'u:' . hash('sha256', $user), 'max' => MEETREQ_MAIL_USER_HOUR, 'always' => true],
        ['key' => 'ip:' . hash('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? '-')), 'max' => MEETREQ_MAIL_IP_HOUR, 'always' => true],
    ]);
    if (!$ok) { fail(429, 'too many answers sent — try again later'); }

    $allow = false;
    if ($user === meetreq_user($cfg)) {
        $db = store_read($cfg, records_file($cfg, $user));
        foreach ((array) ($db['recs'] ?? []) as $r) {
            if (($r['type'] ?? '') !== 'meetreq' || ($id !== '' && ($r['id'] ?? '') !== $id)) { continue; }
            if (strtolower((string) ($r['payload']['email'] ?? '')) === strtolower($to)) { $allow = true; break; }
        }
    }
    if (!$allow) { fail(403, 'that address is not on one of your requests'); }
    // Per destination address, checked once the caller is authorised (so a stranger cannot
    // spend a guest's allowance): a guest's address is one the visitor typed on the public form,
    // so a cap per address keeps even the owner's client from being a relay.
    if (!abuse_take($cfg, 'meetreq-mail-addr', [['key' => 'a:' . hash('sha256', strtolower($to)), 'max' => MEETREQ_MAIL_ADDR_HOUR]])) {
        fail(429, 'too many answers sent to that address — try again later');
    }
    // Site-wide, address-independent, and counted only here, for an authorised answer about to go out: a stranger's
    // attempts (any number of accounts) cannot spend it, so they cannot take the owner's answers away.
    if (!cap_take($cfg, 'meetreq-mail', [
        ['key' => 'g', 'max' => MEETREQ_MAIL_GLOBAL_HOUR, 'window' => 3600],
        ['key' => 'g', 'max' => MEETREQ_MAIL_GLOBAL_DAY,  'window' => 86400],
    ])) {
        fail(429, 'too many answers sent — try again later');
    }

    $lines = [
        'accepted' => "Your meeting request was accepted: $when (about an hour).",
        'declined' => 'Your meeting request was declined.',
        'newtime'  => "A different time was proposed for your meeting: $when (about an hour).",
    ];
    if (mail_enabled($cfg)) {
        // Real mail goes out from the detached worker, never inside the request (the SMTP round trip would hold the
        // reply, and a host that cannot start the worker sends nothing). The worker logs the outcome.
        $queued = mail_spawn($cfg, ['kind' => 'meetreq', 'answer' => $kind, 'user' => $user, 'to' => $to, 'when' => $when]);
        if (!$queued) {
            mail_log_write($cfg, 'meetreq-mail.log', date('c') . "  by=$user  to=$to  kind=$kind  when=$when  NOT SENT (cannot start the mail worker)\n");
        }
        usage_log($cfg, 'meetreq_mail', $user);
        reply(200, ['ok' => true, 'sent' => $queued ? 'queued' : 'not-sent']);
    }
    mail_log_secure($cfg, 'mail.log');
    $how = mail_delivery_status($cfg, $to, 'Your meeting request', $lines[$kind] . "\n");
    $line = date('c') . "  by=$user  to=$to  kind=$kind  when=$when  $how\n";
    mail_log_write($cfg, 'meetreq-mail.log', $line);
    usage_log($cfg, 'meetreq_mail', $user);
    reply(200, ['ok' => true, 'sent' => $how]);
}
