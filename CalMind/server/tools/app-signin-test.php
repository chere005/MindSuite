<?php
/**
 * App sign-in (signin_info, signin_redeem) over real HTTP: a code issued by the site library on a planted full browser
 * session is redeemed for a calmind-scoped bearer. Modes: site lib missing, a site lib that predates the feature, on,
 * the chef space and its hold, the site-wide cap, an unreadable store, and a log scan for every secret the run made.
 *
 *   CALMIND_SITE_LIB_TEST=<seancheren-site checkout>/lib php server/tools/app-signin-test.php
 *
 * The site's library is loaded from that directory, never copied (default: a seancheren-site checkout beside this
 * repository's). Without one only the lib-missing mode runs and the run says so (exit 0, "SKIPPED" printed): a checkout without the site cannot test it.
 * The site config is a scratch file the harness rewrites between cases (the API reads it on every request), with
 * SUITE_DATA_DIR as its data directory, so nothing here reads or writes a real site config or store.
 */

$root = dirname(__DIR__);
date_default_timezone_set('America/Chicago');
$scratch = sys_get_temp_dir() . '/calmind-signin-test-' . getmypid();
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
const KEY = 'calmind-signin-test-key';
const ON = ['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => KEY]];
const CM = 'com.seancheren.calmind:/signin';
const CHEF = 'com.seancheren.chefmind:/signin';

echo "CalMind app sign-in, mode by mode\n";

// ---------------------------------------------------------------- site lib missing
$missing = boot(['CALMIND_DATA_DIR' => $scratch . '/data-missing', 'CALMIND_SITE_LIB' => $scratch . '/no-such-lib']);
$secrets = [];
t('site lib missing: signin_info says legacy, signin_redeem says it needs the shared sign-in (no shared flag)', function () use ($missing) {
    $i = call($missing, ['action' => 'signin_info']);
    eq([200, ['ok' => true, 'shared' => false, 'app_signin' => false]], [$i['status'], $i['body']], 'info');
    $r = call($missing, ['action' => 'signin_redeem', 'code' => str_repeat('a', 64), 'code_verifier' => str_repeat('v', 43), 'redirect_uri' => CM]);
    eq([400, 'app sign-in needs the shared sign-in'], [$r['status'], $r['body']['error'] ?? null], 'redeem');
    ok(!array_key_exists('shared', $r['body']), 'a legacy refusal says nothing of shared sign-in');
});

if ($siteLib === '' || !is_file($siteLib . '/mindsuite-site-auth.php') || !is_file($siteLib . '/mindsuite-app-signin.php')) {
    $skipped = true;
    echo "  SKIPPED: the on, held, capped and unreadable modes (set CALMIND_SITE_LIB_TEST to a seancheren-site lib directory that has mindsuite-app-signin.php)\n";
} else {
    require_once $siteLib . '/mindsuite-auth.php';
    require_once $siteLib . '/mindsuite-passkeys.php';
    require_once $siteLib . '/mindsuite-app-signin.php';
    $data = $scratch . '/data';
    site([]);
    // A copy of the site lib that predates app sign-in: the same files without the two new ones.
    $oldLib = $scratch . '/lib-old';
    exec('cp -R ' . escapeshellarg($siteLib) . ' ' . escapeshellarg($oldLib));
    @unlink($oldLib . '/mindsuite-app-signin.php');
    @unlink($oldLib . '/mindsuite-app-page.php');
    $env = ['CALMIND_DATA_DIR' => $data, 'CALMIND_SITE_CONFIG' => $siteConfig, 'SUITE_DATA_DIR' => $scratch . '/site'];
    $port = boot($env + ['CALMIND_SITE_LIB' => $siteLib]);
    $oldPort = boot($env + ['CALMIND_SITE_LIB' => $oldLib]);
    $acfg = msa_app_config('test', ON + ['mindsuite_store_root' => $scratch . '/site/protected'], 'calmind', '/', true);
    \MindSuite\Files\ensure_directory($acfg['data_dir']);
    msa_lock($acfg, fn() => msa_store_write($acfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]));
    msa_lock($acfg, function () use ($acfg) {
        $db = msa_store_read($acfg);
        $db['accounts']['alex'] = ['email' => 'alex@example.invalid', 'hash' => password_hash('shared-passw0rd', PASSWORD_BCRYPT, ['cost' => 4]), 'created' => time()];
        msa_store_write($acfg, $db);
    });
    $verifier = str_repeat('k', 50);
    $challenge = msa_app_signin_s256($verifier);
    /** A live FULL browser session for alex, as the site page would see it: the context the issue function takes. */
    $browser = function () use ($acfg): array {
        $tok = bin2hex(random_bytes(32));
        msa_lock($acfg, function () use ($acfg, $tok) {
            $db = msa_store_read($acfg);
            $db['sessions'][hash('sha256', $tok)] = ['user' => 'alex', 'device' => 'planted', 'created' => time(), 'last_seen' => time(), 'csrf' => bin2hex(random_bytes(32))];
            msa_store_write($acfg, $db);
        });
        $ctx = msa_session($acfg, [], ['MSSESS_TEST' => $tok]);
        if ($ctx === null) { throw new RuntimeException('fixture browser session'); }
        return $ctx;
    };
    $mint = function (string $app = 'calmind', string $redirect = CM) use ($browser, $acfg, $challenge, &$secrets): string {
        $r = msa_app_signin_issue($acfg, $browser(), $app, $redirect, $challenge, time());
        if (!$r['ok']) { throw new RuntimeException('fixture code: ' . $r['why']); }
        $secrets[] = $r['code'];
        return $r['code'];
    };
    $redeem = fn(int $p, string $code, array $over = []) => call($p, $over + ['action' => 'signin_redeem', 'code' => $code, 'code_verifier' => $verifier, 'redirect_uri' => CM], ['User-Agent' => 'CalMindTest/1']);
    $row = fn(string $tok): ?array => msa_store_read($acfg)['sessions'][hash('sha256', $tok)] ?? null;
    $secrets[] = $verifier;

    t('a site lib that predates app sign-in: signin_info says shared without app_signin, signin_redeem is a shared 503, and a password sign-in still works', function () use ($oldPort) {
        site(ON);
        $i = call($oldPort, ['action' => 'signin_info']);
        eq([200, ['ok' => true, 'shared' => true, 'app_signin' => false]], [$i['status'], $i['body']], 'info');
        $r = call($oldPort, ['action' => 'signin_redeem', 'code' => str_repeat('a', 64), 'code_verifier' => str_repeat('v', 43), 'redirect_uri' => CM]);
        eq([503, 'sign-in unavailable', true], [$r['status'], $r['body']['error'] ?? null, $r['body']['shared'] ?? null], 'redeem');
        $l = call($oldPort, ['action' => 'login', 'username' => 'alex', 'password' => 'shared-passw0rd']);
        eq(200, $l['status'], 'login still shared: ' . $l['raw']);
    });

    t('off: the instance is not switched on, so signin_info answers legacy and signin_redeem refuses', function () use ($port) {
        site([]);
        eq(['ok' => true, 'shared' => false, 'app_signin' => false], call($port, ['action' => 'signin_info'])['body'], 'info');
        eq(400, call($port, ['action' => 'signin_redeem', 'code' => str_repeat('a', 64), 'code_verifier' => str_repeat('v', 43), 'redirect_uri' => CM])['status'], 'redeem');
        site(ON);
    });

    t('on: signin_info answers shared and app_signin', function () use ($port) {
        site(ON);
        eq([200, ['ok' => true, 'shared' => true, 'app_signin' => true]], [call($port, ['action' => 'signin_info'])['status'], call($port, ['action' => 'signin_info'])['body']], 'info');
    });

    t('on: a code redeems for a calmind-scoped bearer: whoami and sync work, the cookie carrier refuses it, the row is scoped with the device', function () use ($port, $mint, $redeem, $row, &$secrets) {
        $r = $redeem($port, $mint());
        eq(200, $r['status'], 'redeem ' . $r['raw']);
        eq(['ok', 'token', 'username'], array_keys($r['body']), 'the reply is the login reply');
        eq('alex', $r['body']['username'], 'username');
        $tok = (string) $r['body']['token'];
        $secrets[] = $tok;
        ok(preg_match('/\A[a-f0-9]{64}\z/', $tok) === 1, 'token shape');
        eq('alex', call($port, ['action' => 'whoami'], bearer($tok))['body']['username'] ?? null, 'whoami');
        eq(200, call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => []], bearer($tok))['status'], 'sync');
        eq(401, call($port, ['action' => 'whoami'], ['Cookie' => 'MSSESS_TEST=' . $tok])['status'], 'as a cookie');
        eq('calmind', $row($tok)['scope'] ?? null, 'scope');
        ok(str_starts_with((string) ($row($tok)['device'] ?? ''), 'CalMind CalMindTest/1'), 'device: ' . ($row($tok)['device'] ?? ''));
    });

    t('on: a second redeem of the same code is refused and ends the session the first one made', function () use ($port, $mint, $redeem, &$secrets) {
        $code = $mint();
        $first = $redeem($port, $code);
        eq(200, $first['status'], 'first');
        $tok = (string) $first['body']['token'];
        $secrets[] = $tok;
        eq(200, call($port, ['action' => 'whoami'], bearer($tok))['status'], 'the token works');
        $again = $redeem($port, $code);
        eq([400, 'that sign-in expired; try again', true], [$again['status'], $again['body']['error'] ?? null, $again['body']['shared'] ?? null], 'second');
        eq(401, call($port, ['action' => 'whoami'], bearer($tok))['status'], 'the first token is gone');
    });

    t('on: a wrong verifier burns the code; a wrong return address is refused; missing and array fields are invalid requests', function () use ($port, $mint, $redeem, $verifier) {
        $code = $mint();
        eq(400, $redeem($port, $code, ['code_verifier' => str_repeat('w', 50)])['status'], 'wrong verifier');
        eq(400, $redeem($port, $code)['status'], 'then the right one');
        $code = $mint();
        eq(400, $redeem($port, $code, ['redirect_uri' => 'http://127.0.0.1:4000/signin'])['status'], 'wrong return address');
        foreach ([['code' => null], ['code_verifier' => null], ['redirect_uri' => null], ['code' => ['x']], ['code_verifier' => 5], ['redirect_uri' => str_repeat('r', 65)],
                  ['code' => str_repeat('a', 65)], ['code_verifier' => str_repeat('v', 129)]] as $over) {
            $r = $redeem($port, $code, $over);
            eq([400, 'invalid request', true], [$r['status'], $r['body']['error'] ?? null, $r['body']['shared'] ?? null], 'invalid ' . json_encode(array_map(fn($v) => is_string($v) ? strlen($v) : $v, $over)));
        }
        $bad = call($port, ['action' => 'signin_redeem']);
        eq('invalid request', $bad['body']['error'] ?? null, 'no fields at all');
    });

    t('on: a chefmind code needs space chef; with the chefmind hold the chef space is legacy while calmind still redeems', function () use ($port, $mint, $redeem, $row, &$secrets) {
        $code = $mint('chefmind', CHEF);
        eq(400, $redeem($port, $code, ['redirect_uri' => CHEF])['status'], 'without space the app is calmind');
        $code = $mint('chefmind', CHEF);
        $r = $redeem($port, $code, ['redirect_uri' => CHEF, 'space' => 'chef']);
        eq(200, $r['status'], 'with space chef ' . $r['raw']);
        $secrets[] = (string) $r['body']['token'];
        eq('calmind', $row((string) $r['body']['token'])['scope'] ?? null, 'a chef-space token keeps the calmind scope');
        site(ON + ['mindsuite_auth_hold' => ['test' => ['chefmind']]]);
        eq(['ok' => true, 'shared' => false, 'app_signin' => false], call($port, ['action' => 'signin_info', 'space' => 'chef'])['body'], 'chef info while chefmind is held');
        eq(true, call($port, ['action' => 'signin_info'])['body']['app_signin'], 'calmind info is unaffected');
        $code = $mint('chefmind', CHEF);
        $h = $redeem($port, $code, ['redirect_uri' => CHEF, 'space' => 'chef']);
        eq([400, false], [$h['status'], array_key_exists('shared', $h['body'])], 'chef redeem while held');
        site(ON);
        $r = $redeem($port, $mint());
        eq(200, $r['status'], 'calmind redeems');
        $secrets[] = (string) $r['body']['token'];
    });

    t('on: the site-wide cap (60 an hour) answers 429 before the code is looked at, and the code stays unspent', function () use ($port, $mint, $redeem, $data, &$secrets) {
        @unlink($data . '/caps-signin-redeem.json');
        $code = $mint();
        $bogus = str_repeat('b', 64);
        for ($i = 0; $i < 60; $i++) { eq(400, $redeem($port, $bogus)['status'], "attempt $i"); }
        $r = $redeem($port, $code);
        eq([429, 'too many sign-ins; try again later', true], [$r['status'], $r['body']['error'] ?? null, $r['body']['shared'] ?? null], 'capped');
        unlink($data . '/caps-signin-redeem.json');
        $ok = $redeem($port, $code);
        eq(200, $ok['status'], 'the valid code was not spent by the refusal');
        $secrets[] = (string) $ok['body']['token'];
        @unlink($data . '/caps-signin-redeem.json');
    });

    t('on with the wrong key: signin_info and signin_redeem are 503 shared, never legacy', function () use ($port) {
        site(['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'not-the-key']]);
        foreach ([['action' => 'signin_info'], ['action' => 'signin_redeem', 'code' => str_repeat('a', 64), 'code_verifier' => str_repeat('v', 43), 'redirect_uri' => CM]] as $body) {
            $r = call($port, $body);
            eq([503, true], [$r['status'], $r['body']['shared'] ?? null], $body['action']);
        }
        site(ON);
    });

    t('no code, verifier or token this run made is in any log, scratch file or server log', function () use ($scratch, &$secrets) {
        $secrets = array_values(array_unique(array_filter($secrets)));
        ok(count($secrets) >= 10, 'the run made secrets to look for: ' . count($secrets));
        $hits = [];
        $walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($scratch, FilesystemIterator::SKIP_DOTS));
        foreach ($walk as $file) {
            if (!$file->isFile() || $file->getSize() > 4_000_000) { continue; }
            $text = (string) file_get_contents($file->getPathname());
            foreach ($secrets as $s) { if (str_contains($text, $s)) { $hits[] = basename($file->getPathname()); } }
        }
        eq([], $hits, 'files that hold a secret');
    });
}

foreach (glob($scratch . '/server-*.log') ?: [] as $log) {
    $text = trim((string) file_get_contents($log));
    $noise = preg_replace('/^.*(Development Server|Accepted|Closing|\[\d{3}\]: POST|calmind shared sign-in: |Closed without sending a request).*$/m', '', $text);
    if (trim((string) $noise) !== '') { $fail++; echo "  \033[31m✗ server log has warnings: " . substr(trim((string) $noise), 0, 400) . "\033[0m\n"; }
}
echo "\n$pass passed, $fail failed" . ($skipped ? ' (shared modes SKIPPED)' : '') . "\n";
exit($fail > 0 ? 1 : 0);
