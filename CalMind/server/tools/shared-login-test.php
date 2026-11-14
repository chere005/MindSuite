<?php
/**
 * The CalMind API in each sign-in mode, over real HTTP (`php -S` on scratch dirs):
 *   - site lib missing        legacy, unchanged
 *   - shared sign-in off      legacy (the instance is not in mindsuite_auth_instances)
 *   - on                      the shared store only: calmind-scoped bearer tokens, same-origin cookie + CSRF
 *   - calmind held            legacy again (mindsuite_auth_hold), a malformed hold too
 *   - chef space              follows the chefmind hold instead (all four combinations)
 *   - on but unreadable       503, never legacy
 *
 *   CALMIND_SITE_LIB_TEST=<seancheren-site checkout>/lib php server/tools/shared-login-test.php
 *
 * The site's library is loaded from that directory, never copied (default: a seancheren-site checkout beside this
 * repository's). Without one only the lib-missing mode runs and the run says so (exit 0, "SKIPPED" printed): a checkout without the site cannot test it.
 * The site config is a scratch file the harness rewrites between cases (the API reads it on every request), with
 * SUITE_DATA_DIR as its data directory, so nothing here reads or writes a real site config or store.
 */

$root = dirname(__DIR__);
date_default_timezone_set('America/Chicago');
$scratch = sys_get_temp_dir() . '/calmind-shared-test-' . getmypid();
@mkdir($scratch . '/data', 0700, true);
@mkdir($scratch . '/site', 0700, true);
@mkdir($scratch . '/data-missing', 0700, true);
// The site checkout beside this repository's, when CALMIND_SITE_LIB_TEST does not name one.
$siteLib = rtrim((string) (getenv('CALMIND_SITE_LIB_TEST') ?: dirname($root, 3) . '/seancheren-site/lib'), '/');
$siteConfig = $scratch . '/site-config.php';
$servers = [];

register_shutdown_function(function () use (&$servers, $scratch) {
    foreach ($servers as $p) { if (is_resource($p)) { proc_terminate($p); proc_close($p); } }
    exec('rm -rf ' . escapeshellarg($scratch));
});

function boot(array $env): int
{
    global $root, $servers, $scratch;
    $sock = stream_socket_server('tcp://127.0.0.1:0', $e1, $e2);
    $port = (int) explode(':', stream_socket_get_name($sock, false))[1];
    fclose($sock);
    $servers[] = proc_open(
        [PHP_BINARY, '-d', 'display_errors=1', '-d', 'error_reporting=E_ALL', '-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0', '-S', '127.0.0.1:' . $port, '-t', $root . '/public'],
        [1 => ['file', '/dev/null', 'w'], 2 => ['file', $scratch . '/server-' . $port . '.log', 'w']],
        $pipes, null, array_merge(getenv(), ['CALMIND_MEETREQ_USER' => 'mrowner', 'CALMIND_DEBUG_LOG_CODES' => '1'], $env)
    );
    for ($i = 0; $i < 100; $i++) {
        $c = @fsockopen('127.0.0.1', $port, $x, $y, 0.2);
        if ($c) { fclose($c); break; }
        usleep(100000);
    }
    return $port;
}

/** POST one action; $headers are extra request headers. Returns status, decoded body, raw body and response headers. */
function call(int $port, array $body, array $headers = []): array
{
    $hdr = "Content-Type: application/json\r\n";
    foreach ($headers as $k => $v) { $hdr .= "$k: $v\r\n"; }
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => $hdr, 'content' => json_encode($body), 'ignore_errors' => true]]);
    $raw = (string) @file_get_contents("http://127.0.0.1:$port/api/index.php", false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) { if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) { $status = (int) $m[1]; } }
    $data = json_decode($raw, true);
    if (!is_array($data)) { throw new RuntimeException("non-JSON reply ($status): " . substr($raw, 0, 300)); }
    return ['status' => $status, 'body' => $data, 'raw' => $raw, 'head' => $http_response_header ?? []];
}
function bearer(string $t): array { return ['Authorization' => "Bearer $t"]; }

$pass = 0; $fail = 0; $skipped = false;
function t(string $label, callable $fn): void
{
    global $pass, $fail;
    try { $fn(); $pass++; echo "  \033[32m✓\033[0m $label\n"; }
    catch (Throwable $e) { $fail++; echo "  \033[31m✗ $label — {$e->getMessage()}\033[0m\n"; }
}
function ok($cond, string $why): void { if (!$cond) { throw new RuntimeException($why); } }
function eq($want, $got, string $why = ''): void
{
    if ($want !== $got) { throw new RuntimeException("$why: expected " . var_export($want, true) . ', got ' . var_export($got, true)); }
}

/** The scratch site config the API reads on its next request. */
function site(array $cfg): void
{
    global $siteConfig;
    file_put_contents($siteConfig . '.tmp', '<?php return ' . var_export(['base' => 'test'] + $cfg, true) . ';');
    rename($siteConfig . '.tmp', $siteConfig);
    clearstatcache();
}
const KEY = 'calmind-shared-test-key';
const ON = ['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => KEY]];

/** The legacy store, read the way the server reads it (encrypted at rest). */
function legacy(string $dir, string $file): array
{
    return store_read(['data_dir' => $dir], $dir . '/' . $file);
}

function codes(string $dir): array
{
    preg_match_all('/code=(\d{6})/', (string) @file_get_contents($dir . '/mail.log'), $m);
    return $m[1];
}
function wait_code(string $dir, int $before): string
{
    for ($i = 0; $i < 100; $i++) { $c = codes($dir); if (count($c) > $before) { return (string) end($c); } usleep(50000); }
    return '';
}

require_once $root . '/lib/store.php';

echo "CalMind shared sign-in, mode by mode\n";

// ---------------------------------------------------------------- site lib missing
$missing = boot(['CALMIND_DATA_DIR' => $scratch . '/data-missing', 'CALMIND_SITE_LIB' => $scratch . '/no-such-lib']);
t('site lib missing: legacy sign-up, sign-in and sync, tokens in the legacy store', function () use ($missing, $scratch) {
    $s = call($missing, ['action' => 'signup', 'username' => 'Alex', 'email' => 'alex@example.invalid', 'password' => 'passw0rd']);
    eq(200, $s['status'], 'signup');
    eq('Alex', $s['body']['username'] ?? null, 'legacy keeps the spelling');
    $l = call($missing, ['action' => 'login', 'username' => 'Alex', 'password' => 'passw0rd']);
    eq(200, $l['status'], 'login');
    eq(200, call($missing, ['action' => 'whoami'], bearer($l['body']['token']))['status'], 'whoami');
    eq(200, call($missing, ['action' => 'sync', 'cursor' => 0, 'changes' => []], bearer($l['body']['token']))['status'], 'sync');
    ok(isset(legacy($scratch . '/data-missing', 'tokens.json')[hash('sha256', $l['body']['token'])]), 'the token is in tokens.json');
    $who = call($missing, ['action' => 'whoami']);
    eq(401, $who['status'], 'anonymous');
    ok(!array_key_exists('shared', $who['body']), 'a legacy 401 says nothing of shared sign-in');
});

if ($siteLib === '' || !is_file($siteLib . '/mindsuite-site-auth.php')) {
    $skipped = true;
    echo "  SKIPPED: off, on, held and unreadable modes (set CALMIND_SITE_LIB_TEST to a seancheren-site lib directory)\n";
} else {
    require_once $siteLib . '/mindsuite-auth.php';
    require_once $siteLib . '/mindsuite-passkeys.php';
    $data = $scratch . '/data';
    site([]);
    $port = boot(['CALMIND_DATA_DIR' => $data, 'CALMIND_SITE_LIB' => $siteLib, 'CALMIND_SITE_CONFIG' => $siteConfig,
        'SUITE_DATA_DIR' => $scratch . '/site']);
    // The store the API opens on: the same instance, key and root, so the harness can plant what the importer plants.
    $acfg = msa_app_config('test', ON + ['mindsuite_store_root' => $scratch . '/site/protected'], 'calmind', '/', true);
    // An instance is switched on only over an initialised store (the importer makes it); an empty one here.
    \MindSuite\Files\ensure_directory($acfg['data_dir']);
    msa_lock($acfg, fn() => msa_store_write($acfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]));
    $account = function (string $user, string $password) use ($acfg): void {
        msa_lock($acfg, function () use ($acfg, $user, $password) {
            $db = msa_store_read($acfg);
            $db['accounts'][$user] = ['email' => $user . '@example.invalid', 'hash' => password_hash($password, PASSWORD_BCRYPT), 'created' => time()];
            msa_store_write($acfg, $db);
        });
    };
    $plant = function (string $user, string $scope) use ($acfg): string {
        $tok = bin2hex(random_bytes(32));
        msa_lock($acfg, function () use ($acfg, $tok, $user, $scope) {
            $db = msa_store_read($acfg);
            $row = ['user' => $user, 'device' => 'planted', 'created' => time() - 86400 * 400, 'last_seen' => time(), 'csrf' => bin2hex(random_bytes(32))];
            if ($scope !== '') { $row['scope'] = $scope; }
            $db['sessions'][hash('sha256', $tok)] = $row;
            msa_store_write($acfg, $db);
        });
        return $tok;
    };
    $row = function (string $tok) use ($acfg): ?array { return msa_store_read($acfg)['sessions'][hash('sha256', $tok)] ?? null; };
    $csrfOf = function (string $tok) use ($row): string { return (string) ($row($tok)['csrf'] ?? ''); };
    $legacyTok = '';

    // ------------------------------------------------------------ off
    t('off: the site lib is there but the instance is not switched on: legacy, unchanged', function () use ($port, $data, &$legacyTok) {
        site([]);
        $s = call($port, ['action' => 'signup', 'username' => 'Sam', 'email' => 'sam@example.invalid', 'password' => 'passw0rd']);
        eq(200, $s['status'], 'signup');
        $legacyTok = (string) $s['body']['token'];
        eq('Sam', call($port, ['action' => 'whoami'], bearer($legacyTok))['body']['username'] ?? null, 'whoami');
        ok(isset(legacy($data, 'accounts.json')['Sam']), 'legacy account');
    });

    t('off: mindsuite_signup_closed closes CalMind\'s legacy sign-up too (closed before the import)', function () use ($port) {
        site(['mindsuite_signup_closed' => true]);
        $r = call($port, ['action' => 'signup', 'username' => 'max', 'email' => 'max@example.invalid', 'password' => 'passw0rd']);
        eq(403, $r['status'], 'closed');
        eq('sign-up is closed', $r['body']['error'] ?? null, 'message');
        site([]);
    });

    // ------------------------------------------------------------ on
    $alex = ''; $alexPw = 'shared-passw0rd';
    t('on: a legacy token is refused (no second door) and every 401 says shared', function () use ($port, &$legacyTok) {
        site(ON);
        $r = call($port, ['action' => 'whoami'], bearer($legacyTok));
        eq(401, $r['status'], 'legacy token');
        eq(['ok' => false, 'error' => 'bad token', 'shared' => true], $r['body'], 'reply');
        eq(['ok' => false, 'error' => 'auth required', 'shared' => true], call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => []])['body'], 'anonymous');
        eq(401, call($port, ['action' => 'login', 'username' => 'Sam', 'password' => 'passw0rd'])['status'], 'a legacy-only password does not sign in');
    });

    t('on: sign-up writes the shared store (canonical name) and returns a calmind-scoped token', function () use ($port, $data, $row, &$alex, $alexPw) {
        $s = call($port, ['action' => 'signup', 'username' => 'Alex', 'email' => 'alex@example.invalid', 'password' => $alexPw]);
        eq(200, $s['status'], 'signup ' . $s['raw']);
        eq('alex', $s['body']['username'] ?? null, 'canonical name');
        $alex = (string) $s['body']['token'];
        eq(64, strlen($alex), 'token shape');
        eq('calmind', $row($alex)['scope'] ?? null, 'scoped row');
        ok(!isset(legacy($data, 'accounts.json')['alex']) && !isset(legacy($data, 'tokens.json')[hash('sha256', $alex)]), 'nothing legacy written');
        eq('alex', call($port, ['action' => 'whoami'], bearer($alex))['body']['username'] ?? null, 'whoami');
        $sync = call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => [['id' => 'r1', 'type' => 'reminder', 'updated' => 5, 'payload' => ['t' => 1]]]], bearer($alex));
        eq(200, $sync['status'], 'sync');
        ok(is_file($data . '/records-alex.json'), 'records under the canonical name');
    });

    t('on: a name still held by a legacy CalMind account (any case) is never signed up to someone new', function () use ($port) {
        eq(409, call($port, ['action' => 'signup', 'username' => 'sam', 'email' => 'x@example.invalid', 'password' => 'passw0rd'])['status'], 'legacy Sam');
        eq(409, call($port, ['action' => 'signup', 'username' => 'ALEX', 'email' => 'x@example.invalid', 'password' => 'passw0rd'])['status'], 'shared alex');
    });

    t('on: sign-up closed answers 403 and creates nothing', function () use ($port, $acfg) {
        site(ON + ['mindsuite_signup_closed' => true]);
        eq(403, call($port, ['action' => 'signup', 'username' => 'val', 'email' => 'n@example.invalid', 'password' => 'passw0rd'])['status'], 'closed');
        ok(!msa_account_exists($acfg, 'val'), 'no account');
        site(ON);
    });

    t('on: login is msa_login with scope calmind; wrong password 401; unknown name the same 401', function () use ($port, $row, $alexPw) {
        $l = call($port, ['action' => 'login', 'username' => 'ALEX', 'password' => $alexPw]);
        eq(200, $l['status'], 'login');
        eq('alex', $l['body']['username'] ?? null, 'canonical');
        eq('calmind', $row((string) $l['body']['token'])['scope'] ?? null, 'scoped');
        $w = call($port, ['action' => 'login', 'username' => 'alex', 'password' => 'nope-nope']);
        $u = call($port, ['action' => 'login', 'username' => 'nobody-here', 'password' => 'nope-nope']);
        eq([401, 'wrong username or password'], [$w['status'], $w['body']['error'] ?? null], 'wrong');
        eq($w['raw'], $u['raw'], 'unknown name answers byte for byte the same');
    });

    t('on: the lock ignores a forged X-Forwarded-For: five wrong from "different" addresses lock, 429 keeps the wait label', function () use ($port, $account) {
        $account('otto', 'right-passw0rd');
        for ($i = 0; $i < 5; $i++) {
            eq(401, call($port, ['action' => 'login', 'username' => 'otto', 'password' => 'wrong-' . $i], ['X-Forwarded-For' => "203.0.113.$i"])['status'], "wrong $i");
        }
        $r = call($port, ['action' => 'login', 'username' => 'otto', 'password' => 'right-passw0rd'], ['X-Forwarded-For' => '198.51.100.7']);
        eq(429, $r['status'], 'locked whatever the header says');
        ok(preg_match('/^too many attempts — locked for \d+m$/u', (string) ($r['body']['error'] ?? '')) === 1, 'label: ' . ($r['body']['error'] ?? ''));
    });

    t('on: imported tokens: a calmind row is a bearer here; a full-account row, another app\'s row and a calmind row as a cookie are not', function () use ($port, $plant) {
        $imp = $plant('alex', 'calmind');
        eq('alex', call($port, ['action' => 'whoami'], bearer($imp))['body']['username'] ?? null, 'imported calmind token');
        eq(200, call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => []], bearer($imp))['status'], 'imported token syncs');
        eq(401, call($port, ['action' => 'whoami'], bearer($plant('alex', '')))['status'], 'full-account bearer');
        eq(401, call($port, ['action' => 'whoami'], bearer($plant('alex', 'planmind')))['status'], 'another app\'s bearer');
        eq(401, call($port, ['action' => 'whoami'], ['Cookie' => 'MSSESS_TEST=' . $imp])['status'], 'calmind token as a cookie');
    });

    t('on: same-origin cookie: whoami hands its CSRF secret; every other action needs X-CSRF-Token; cross-site refused', function () use ($port, $plant, $csrfOf, $row) {
        $c = $plant('alex', '');
        $ck = ['Cookie' => 'MSSESS_TEST=' . $c];
        $who = call($port, ['action' => 'whoami'], $ck);
        eq(200, $who['status'], 'whoami');
        eq($csrfOf($c), $who['body']['csrf'] ?? null, 'csrf');
        $sync = ['action' => 'sync', 'cursor' => 0, 'changes' => []];
        eq([403, 'csrf'], [call($port, $sync, $ck)['status'], call($port, $sync, $ck)['body']['error'] ?? null], 'no header');
        eq(200, call($port, $sync, $ck + ['X-CSRF-Token' => $csrfOf($c)])['status'], 'with header');
        eq(403, call($port, $sync, $ck + ['X-CSRF-Token' => $csrfOf($c), 'Sec-Fetch-Site' => 'cross-site'])['status'], 'cross-site');
        eq(403, call($port, $sync, $ck + ['X-CSRF-Token' => $csrfOf($c), 'Origin' => 'https://evil.example'])['status'], 'foreign Origin');
        eq(403, call($port, ['action' => 'whoami'], $ck + ['Sec-Fetch-Site' => 'cross-site'])['status'], 'cross-site whoami');
        ok(!isset(call($port, ['action' => 'whoami'], bearer($plant('alex', 'calmind')))['body']['csrf']), 'a bearer is told no csrf');
        eq(403, call($port, ['action' => 'logout'], $ck)['status'], 'logout without csrf');
        $out = call($port, ['action' => 'logout'], $ck + ['X-CSRF-Token' => $csrfOf($c)]);
        eq(200, $out['status'], 'logout');
        ok($row($c) === null, 'the cookie session is gone');
        ok((bool) preg_grep('/^Set-Cookie: MSSESS_TEST=deleted|^Set-Cookie: MSSESS_TEST=;/i', $out['head']), 'the cookie is cleared');
    });

    t('on: logout revokes only that token', function () use ($port, $plant, $row) {
        $a = $plant('alex', 'calmind'); $b = $plant('alex', 'calmind');
        eq(200, call($port, ['action' => 'logout'], bearer($a))['status'], 'logout');
        eq(401, call($port, ['action' => 'whoami'], bearer($a))['status'], 'gone');
        eq(200, call($port, ['action' => 'whoami'], bearer($b))['status'], 'the other device stays');
    });

    t('on: change_password is refused for a calmind token and a cookie alike (403 shared, change it at /account/); nothing changes', function () use ($port, $plant, $csrfOf, $alexPw, &$alex) {
        eq(401, call($port, ['action' => 'change_password', 'old' => $alexPw, 'new' => 'new-passw0rd'])['status'], 'no session: 401');
        $imp = $plant('alex', 'calmind');
        $r = call($port, ['action' => 'change_password', 'old' => $alexPw, 'new' => 'new-passw0rd'], bearer($alex));
        eq([403, true], [$r['status'], $r['body']['shared'] ?? null], 'calmind token refused');
        $c = $plant('alex', '');
        $r = call($port, ['action' => 'change_password', 'old' => $alexPw, 'new' => 'new-passw0rd'], ['Cookie' => 'MSSESS_TEST=' . $c, 'X-CSRF-Token' => $csrfOf($c)]);
        eq([403, true], [$r['status'], $r['body']['shared'] ?? null], 'cookie refused');
        eq(200, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'the token still works');
        eq(200, call($port, ['action' => 'whoami'], bearer($imp))['status'], 'the imported token still works');
        eq(200, call($port, ['action' => 'whoami'], ['Cookie' => 'MSSESS_TEST=' . $c])['status'], 'the browser session still works');
        eq(401, call($port, ['action' => 'login', 'username' => 'alex', 'password' => 'new-passw0rd'])['status'], 'the new password was not set');
        eq(200, call($port, ['action' => 'login', 'username' => 'alex', 'password' => $alexPw])['status'], 'the current password still signs in');
    });

    t('on: recover mails the shared store\'s address; reset revokes every session and signs this device in', function () use ($port, $data, $plant, &$alex) {
        $imp = $plant('alex', 'calmind');
        $before = count(codes($data));
        $known = call($port, ['action' => 'recover', 'username' => 'ALEX']);
        $unknown = call($port, ['action' => 'recover', 'username' => 'outsider']);
        eq([200, $known['raw']], [$unknown['status'], $unknown['raw']], 'identical replies');
        $code = wait_code($data, $before);
        ok($code !== '', 'a code was issued for the shared account');
        ok(str_contains((string) file_get_contents($data . '/mail.log'), 'user=alex '), 'keyed on the canonical name');
        eq(403, call($port, ['action' => 'reset', 'username' => 'alex', 'code' => '000000', 'password' => 'reset-passw0rd'])['status'], 'wrong code');
        $r = call($port, ['action' => 'reset', 'username' => 'Alex', 'code' => $code, 'password' => 'reset-passw0rd']);
        eq(200, $r['status'], 'reset ' . $r['raw']);
        eq('alex', $r['body']['username'] ?? null, 'canonical');
        eq(401, call($port, ['action' => 'whoami'], bearer($imp))['status'], 'imported token revoked');
        eq(401, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'earlier token revoked');
        $alex = (string) $r['body']['token'];
        eq(200, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'the reset token works');
        eq(403, call($port, ['action' => 'reset', 'username' => 'alex', 'code' => $code, 'password' => 'again-passw0rd'])['status'], 'a code works once');
    });

    t('a reset code mailed for the legacy account never resets the shared one', function () use ($port, $data, $account) {
        site([]);                                            // off: a lowercase legacy account, so only the code's mode can tell
        eq(200, call($port, ['action' => 'signup', 'username' => 'ben', 'email' => 'ben@example.invalid', 'password' => 'ben-legacy-pw'])['status'], 'legacy ben');
        $before = count(codes($data));
        eq(200, call($port, ['action' => 'recover', 'username' => 'ben'])['status'], 'legacy recover');
        $code = wait_code($data, $before);
        ok($code !== '', 'legacy code');
        site(ON);
        $account('ben', 'ben-shared-pw');
        eq(403, call($port, ['action' => 'reset', 'username' => 'ben', 'code' => $code, 'password' => 'hijack-passw0rd'])['status'], 'legacy code in shared mode');
        eq(401, call($port, ['action' => 'login', 'username' => 'ben', 'password' => 'hijack-passw0rd'])['status'], 'password unchanged');
        eq(200, call($port, ['action' => 'login', 'username' => 'ben', 'password' => 'ben-shared-pw'])['status'], 'the shared password still signs in');
    });

    t('on: neither a calmind token nor a browser cookie alone can enroll a shared-account passkey', function () use ($port, $plant, $csrfOf, &$alex) {
        eq([403, true], [call($port, ['action' => 'passkey_register_begin'], bearer($alex))['status'], call($port, ['action' => 'passkey_register_begin'], bearer($alex))['body']['shared'] ?? null], 'register begin');
        eq(403, call($port, ['action' => 'passkey_register_finish', 'clientDataJSON' => 'x', 'attestationObject' => 'y'], bearer($alex))['status'], 'register finish');
        $l = call($port, ['action' => 'passkey_list'], bearer($alex));
        eq([200, []], [$l['status'], $l['body']['passkeys'] ?? null], 'list');
        eq(404, call($port, ['action' => 'passkey_remove', 'id' => 'whatever'], bearer($alex))['status'], 'remove');
        $c = $plant('alex', '');
        $b = call($port, ['action' => 'passkey_register_begin'], ['Cookie' => 'MSSESS_TEST=' . $c, 'X-CSRF-Token' => $csrfOf($c)]);
        eq(403, $b['status'], 'cookie-only enrollment must use fresh verification at /account/: ' . $b['raw']);
        ok(!isset($b['body']['challenge']), 'no unverified registration challenge is issued');
    });

    t('on: a passkey sign-in hands a phone a calmind-scoped token, never a full-account one', function () use ($port, $acfg, $row) {
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $pem = openssl_pkey_get_details($key)['key'];
        $id = rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
        msa_lock($acfg, function () use ($acfg, $id, $pem) { $db = msa_store_read($acfg); $db['passkeys'][$id] = ['user' => 'alex', 'pem' => $pem, 'signCount' => 0, 'label' => 'k', 'created' => time()]; msa_store_write($acfg, $db); });
        $b64u = fn(string $s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
        $begin = call($port, ['action' => 'passkey_login_begin']);
        eq(200, $begin['status'], 'begin');
        $cd = json_encode(['type' => 'webauthn.get', 'challenge' => $begin['body']['challenge'], 'origin' => 'https://test.seancheren.com', 'crossOrigin' => false]);
        $ad = hash('sha256', 'test.seancheren.com', true) . chr(0x05) . pack('N', 1);
        openssl_sign($ad . hash('sha256', $cd, true), $sig, $key, OPENSSL_ALGO_SHA256);
        $f = call($port, ['action' => 'passkey_login_finish', 'id' => $id, 'clientDataJSON' => $b64u($cd), 'authenticatorData' => $b64u($ad), 'signature' => $b64u($sig)]);
        eq(200, $f['status'], 'finish ' . $f['raw']);
        $tok = (string) $f['body']['token'];
        eq('calmind', $row($tok)['scope'] ?? null, 'scoped before it left the server');
        eq('alex', call($port, ['action' => 'whoami'], bearer($tok))['body']['username'] ?? null, 'works here');
        eq(401, call($port, ['action' => 'whoami'], ['Cookie' => 'MSSESS_TEST=' . $tok])['status'], 'and not as a browser session');
        eq(401, call($port, ['action' => 'passkey_login_finish', 'id' => $id, 'clientDataJSON' => $b64u($cd), 'authenticatorData' => $b64u($ad), 'signature' => $b64u($sig)])['status'], 'replay');
    });

    t('on: delete_account is refused (no suite account is deleted from CalMind) and the account keeps working', function () use ($port, &$alex) {
        $r = call($port, ['action' => 'delete_account'], bearer($alex));
        eq([403, true], [$r['status'], $r['body']['shared'] ?? null], 'refused');
        eq(200, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'still signed in');
    });

    t('on: the public request page only knows the canonical owner name', function () use ($port, $account, $data) {
        $account('mrowner', 'owner-pw-123');
        $date = date('Y-m-d', strtotime('next monday'));
        eq(200, call($port, ['action' => 'meetreq_create', 'user' => 'MROWNER', 'name' => 'A', 'email' => 'a@example.invalid', 'date' => $date, 'time' => '11:00'])['status'], 'quiet ok');
        ok(!is_file($data . '/records-MROWNER.json'), 'no record file for a spelling that is not the account');
        eq(200, call($port, ['action' => 'meetreq_create', 'user' => 'mrowner', 'name' => 'A', 'email' => 'a@example.invalid', 'date' => $date, 'time' => '11:00'])['status'], 'owner');
        ok(is_file($data . '/records-mrowner.json'), 'stored for the owner');
    });

    // ------------------------------------------------------------ held
    t('held: calmind on hold is legacy again: the legacy token works, a shared one does not', function () use ($port, &$legacyTok, &$alex) {
        site(ON + ['mindsuite_auth_hold' => ['test' => ['calmind', 'chefmind']]]);
        eq('Sam', call($port, ['action' => 'whoami'], bearer($legacyTok))['body']['username'] ?? null, 'legacy');
        $r = call($port, ['action' => 'whoami'], bearer($alex));
        eq(401, $r['status'], 'shared token');
        ok(!array_key_exists('shared', $r['body']), 'a legacy 401');
        site(ON + ['mindsuite_auth_hold' => ['test' => ['planmind']]]);
        eq(401, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'another app\'s hold does not hold calmind');
    });

    t('held: a malformed hold holds every app, calmind included (fails closed to legacy)', function () use ($port, &$legacyTok) {
        site(ON + ['mindsuite_auth_hold' => ['calmind']]);   // a flat list: malformed
        eq(200, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'legacy');
        site(ON + ['mindsuite_auth_hold' => 'calmind']);
        eq(200, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'legacy (string)');
    });

    // ChefMind's calls name space 'chef' on every action and follow the chefmind hold; CalMind's follow the calmind hold.
    t('held: the chef space follows the chefmind hold and the calmind space the calmind hold, in all four combinations', function () use ($port, $plant, $row, $data, &$legacyTok) {
        $shared = $plant('alex', 'calmind');
        $chef = ['space' => 'chef'];
        $sync = ['cursor' => 0, 'changes' => []];
        foreach ([
            'neither held' => [['planmind'], true, true],
            'calmind held' => [['calmind'], false, true],
            'chefmind held' => [['chefmind'], true, false],
            'both held' => [['calmind', 'chefmind'], false, false],
        ] as $why => [$hold, $calShared, $chefShared]) {
            site(ON + ['mindsuite_auth_hold' => ['test' => $hold]]);
            foreach (['calmind' => [[], $calShared], 'chef' => [$chef, $chefShared]] as $space => [$extra, $isShared]) {
                foreach (['whoami' => [], 'sync' => $sync] as $action => $more) {
                    $s = call($port, ['action' => $action] + $extra + $more, bearer($shared));
                    $l = call($port, ['action' => $action] + $extra + $more, bearer($legacyTok));
                    if ($isShared) {
                        eq(200, $s['status'], "$why, $space $action: the shared token");
                        eq([401, true], [$l['status'], $l['body']['shared'] ?? null], "$why, $space $action: the legacy token is a shared 401");
                    } else {
                        eq([401, false], [$s['status'], array_key_exists('shared', $s['body'])], "$why, $space $action: the shared token is a legacy 401");
                        eq(200, $l['status'], "$why, $space $action: the legacy token");
                    }
                }
                // ChefMind's own recipe import, change_password and passkey sign-in follow the same hold as sync (nothing changes).
                $s = call($port, ['action' => 'recipe_fetch'] + $extra, bearer($shared));
                $l = call($port, ['action' => 'recipe_fetch'] + $extra, bearer($legacyTok));
                eq($isShared ? [400, 401, true] : [401, 400, false], [$s['status'], $l['status'], $isShared ? ($l['body']['shared'] ?? null) : array_key_exists('shared', $s['body'])], "$why, $space recipe_fetch on its own path");
                $pw = ['action' => 'change_password', 'old' => 'not-the-passw0rd', 'new' => 'other-passw0rd'] + $extra;
                $s = call($port, $pw, bearer($shared));
                $l = call($port, $pw, bearer($legacyTok));
                eq($isShared ? [[403, true], [401, true]] : [[401, null], [403, null]],
                    [[$s['status'], $s['body']['shared'] ?? null], [$l['status'], $l['body']['shared'] ?? null]], "$why, $space change_password on its own path");
                $pk = call($port, ['action' => 'passkey_login_begin'] + $extra);
                eq([200, !$isShared], [$pk['status'], ($pk['body']['rpId'] ?? '') === '127.0.0.1'], "$why, $space passkey_login_begin on its own path " . $pk['raw']);
                $in = call($port, ['action' => 'login', 'username' => $isShared ? 'alex' : 'Sam', 'password' => $isShared ? 'reset-passw0rd' : 'passw0rd'] + $extra);
                eq(200, $in['status'], "$why, $space login on its own path " . $in['raw']);
                $tok = (string) ($in['body']['token'] ?? '');
                if ($isShared) {
                    eq('calmind', $row($tok)['scope'] ?? null, "$why, $space login: a calmind-scoped session (chef-space tokens keep the calmind scope)");
                    ok(!isset(legacy($data, 'tokens.json')[hash('sha256', $tok)]), "$why, $space login: nothing legacy written");
                } else {
                    ok($row($tok) === null && isset(legacy($data, 'tokens.json')[hash('sha256', $tok)]), "$why, $space login: a legacy token, not a shared session");
                }
            }
        }
        // C5's scope rule is intact on the chef space: only a row scoped exactly 'calmind' opens it.
        site(ON);
        foreach (['a chefmind-scoped row' => $plant('alex', 'chefmind'), 'a full-account row' => $plant('alex', ''), 'another app\'s row' => $plant('alex', 'planmind')] as $what => $tok) {
            $r = call($port, ['action' => 'whoami'] + $chef, bearer($tok));
            eq([401, 'bad token', true], [$r['status'], $r['body']['error'] ?? null, $r['body']['shared'] ?? null], "chef space, $what");
        }
        eq(200, call($port, ['action' => 'sync'] + $chef + $sync, bearer($shared))['status'], 'chef space, the calmind-scoped row');
        ok(is_file($data . '/records-chef-alex.json'), 'chef records under the canonical name');
        // An unknown space follows calmind's hold (and sync still refuses it).
        site(ON + ['mindsuite_auth_hold' => ['test' => ['chefmind']]]);
        eq(200, call($port, ['action' => 'whoami', 'space' => 'Chef'], bearer($shared))['status'], 'an unknown space is calmind\'s');
        eq(400, call($port, ['action' => 'sync', 'space' => 'Chef'] + $sync, bearer($shared))['status'], 'and sync refuses it');
        // space 'chef' picks the hold only for sync/shared_*/login/logout/whoami: CalMind's own and account-wide actions
        // follow calmind's hold whatever the body says, so the chef space is never a second door into CalMind.
        $day = ['action' => 'meetreq_day', 'date' => '2026-01-05'];
        $del = ['action' => 'delete_account'];
        $reg = ['action' => 'passkey_register_begin'];
        $rm = ['action' => 'passkey_remove', 'id' => 'none'];
        site(ON + ['mindsuite_auth_hold' => ['test' => ['chefmind']]]);
        foreach ([$day, $del, $reg, $rm] as $body) {
            $r = call($port, $body + $chef, bearer($legacyTok));
            eq([401, true], [$r['status'], $r['body']['shared'] ?? null], "calmind on, chefmind held: a legacy token on {$body['action']} with space chef is a shared 401 " . $r['raw']);
        }
        eq(200, call($port, ['action' => 'whoami'] + $chef, bearer($legacyTok))['status'], 'and the legacy token still opens the chef space itself');
        site(ON + ['mindsuite_auth_hold' => ['test' => ['calmind']]]);
        $r = call($port, $day + $chef, bearer($shared));
        eq([401, false], [$r['status'], array_key_exists('shared', $r['body'])], 'calmind held, chefmind on: a shared token on meetreq_day with space chef is a legacy 401 ' . $r['raw']);
        foreach ([$del, $reg, $rm] as $body) {
            $r = call($port, $body + $chef, bearer($shared));
            eq([401, false], [$r['status'], array_key_exists('shared', $r['body'])], "calmind held, chefmind on: a shared token on {$body['action']} with space chef is a legacy 401 " . $r['raw']);
        }
        // Sign-up from ChefMind's Login screen lands on chefmind's path: legacy while it is held, shared while it is not.
        foreach ([[['chefmind'], 'cid', false], [['calmind'], 'cia', true]] as [$hold, $name, $isShared]) {
            site(ON + ['mindsuite_auth_hold' => ['test' => $hold]]);
            $r = call($port, ['action' => 'signup', 'username' => $name, 'email' => $name . '@example.invalid', 'password' => 'passw0rd'] + $chef);
            $tok = (string) ($r['body']['token'] ?? '');
            eq([200, $isShared, !$isShared], [$r['status'], $row($tok) !== null, isset(legacy($data, 'tokens.json')[hash('sha256', $tok)])], 'chef sign-up with ' . $hold[0] . ' held ' . $r['raw']);
        }
        site(ON);
        eq(200, call($port, ['action' => 'whoami'], bearer($shared))['status'], 'the shared account survived');
        site(['mindsuite_auth_instances' => []]);
        eq(200, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'the legacy account survived');
        site(ON);
    });

    // ------------------------------------------------------------ on but unreadable
    t('on with no key for the instance: 503 for every door, never the legacy one', function () use ($port, &$legacyTok) {
        site(['mindsuite_auth_instances' => ['test']]);
        foreach ([['action' => 'whoami'], ['action' => 'login', 'username' => 'Sam', 'password' => 'passw0rd'],
                  ['action' => 'signup', 'username' => 'cee', 'email' => 'z@example.invalid', 'password' => 'passw0rd'],
                  ['action' => 'recover', 'username' => 'Sam']] as $body) {
            $r = call($port, $body, bearer($legacyTok));
            eq([503, 'sign-in unavailable'], [$r['status'], $r['body']['error'] ?? null], $body['action']);
        }
    });

    t('on with the wrong key: the store will not decrypt, 503, never legacy', function () use ($port, &$legacyTok) {
        site(['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'not-the-key']]);
        eq(503, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'whoami');
        eq(503, call($port, ['action' => 'login', 'username' => 'Sam', 'password' => 'passw0rd'])['status'], 'login');
        site(ON);
    });

    t('a site config that will not load: 503, never legacy', function () use ($port, &$legacyTok, $siteConfig) {
        file_put_contents($siteConfig, '<?php return "not an array";');
        eq(503, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'whoami');
        site([]);
        eq(200, call($port, ['action' => 'whoami'], bearer($legacyTok))['status'], 'off again: legacy');
    });

    // The c+ open itself lives in the site library (msa_lock_shared); CalMind opens no lock of the shared store. What
    // C5 owns is the outcome: a lock file the request cannot open read-write fails closed (503 shared), never legacy and
    // never a 500, and the same token works again once the file is writable. A read-only open ('r') would pass the
    // 0444 step and turn this red. Telling 'c+' from 'c' needs NFS byte-range locks; the library's own test pins that.
    t('on: a store lock file that cannot be opened read-write fails closed (503), then recovers', function () use ($port, $scratch, &$alex) {
        $lock = $scratch . '/site/protected/mindsuite-auth-test/auth.lock';
        site(ON);
        eq(200, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'before');
        ok(is_file($lock), 'lock file exists');
        chmod($lock, 0444);
        try {
            $r = call($port, ['action' => 'whoami'], bearer($alex));
            eq([503, true], [$r['status'], $r['body']['shared'] ?? null], 'read-only lock: whoami');
            $r = call($port, ['action' => 'login', 'username' => 'alex', 'password' => 'reset-passw0rd']);
            eq([503, true], [$r['status'], $r['body']['shared'] ?? null], 'read-only lock: login');
        } finally {
            chmod($lock, 0600);
        }
        eq(200, call($port, ['action' => 'whoami'], bearer($alex))['status'], 'writable again');
        site([]);
    });
}

foreach (glob($scratch . '/server-*.log') ?: [] as $log) {
    $text = trim((string) file_get_contents($log));
    // The unreadable-store cases log their reason on purpose (one line each, class and message, no secret).
    $noise = preg_replace('/^.*(Development Server|Accepted|Closing|\[\d{3}\]: POST|calmind shared sign-in: |Closed without sending a request).*$/m', '', $text);
    if (trim((string) $noise) !== '') { $fail++; echo "  \033[31m✗ server log has warnings: " . substr(trim((string) $noise), 0, 400) . "\033[0m\n"; }
}
echo "\n$pass passed, $fail failed" . ($skipped ? ' (shared modes SKIPPED)' : '') . "\n";
exit($fail > 0 ? 1 : 0);
