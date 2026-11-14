<?php
declare(strict_types=1);
// The suite's shared sign-in (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"), through the REAL entry points: index.php and
// api.php run under PHP's built-in server against a disposable copy of the site library, once with the shared sign-in on (the library's
// fixture switch and a disposable store of five accounts) and once per way TaskMind keeps its own sign-in: the instance is off, TaskMind is
// held, a malformed hold, another instance only, a site library older than the door. Nothing here reads a real configuration or store.
//
//   1. Off, held and an older library: the legacy sign-in, session, CSRF token and limiter, exactly as before (one run each).
//   2. On, no session: 303 to /account/?next= for the page, 401 JSON for the API, no store opened, no PHP session started.
//   3. On, an account that is not on the team: 403 with a Sign out only, nothing of the team sent.
//   4. On, a member: the page, the API, writes with the session's token only, the account the site's helpers see.
//   4b. On, member.add judges the shared store's accounts (never the legacy list), only after the permission check; an unreadable store is a 503.
//   5. On, the team gate is read on every request: a removal, a demotion and a damaged workspace take effect at once.
//   6. On, no second door: a legacy PHP session, a bearer, a scoped (CalMind) token as bearer or cookie, a post to the page: all refused.
//   7. On, but it cannot work (the store, the key, the library, the gate's answer): 503 or no page at all, never the legacy path.

$source = getenv('TASKMIND_TEST_SITE_LIB') ?: '';
if ($source === '') {
    foreach ([dirname(__DIR__, 3) . '/../seancheren-site/lib', dirname(__DIR__, 3) . '/../../seancheren-site/lib'] as $candidate) {
        $source = $candidate;
        if (is_file($candidate . '/auth.php')) break;
    }
}
check(is_file($source . '/auth.php') && is_file($source . '/mindsuite-site-auth.php'), "the site library is needed (set TASKMIND_TEST_SITE_LIB=<seancheren-site>/lib); looked in $source");

// ---- helpers (prefixed sl_: every case file shares one process) ----
function sl_php_flags(): array {
    $flags = ['-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1', '-d', 'log_errors=1'];
    foreach (['openssl', 'mbstring'] as $extension) {
        $bare = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, '-r', "echo extension_loaded('$extension') ? 'yes' : 'no';"])));
        if ($bare !== 'yes') { array_push($flags, '-d', "extension=$extension"); }
    }
    return $flags;
}
/** A PHP built-in server on a free port (nothing else is listening there; the suite's reserved ports are never asked for). Returns [process, port]. */
function sl_server(string $docroot, array $env, string $name, string $sandbox, array $more = []): array {
    $socket = stream_socket_server('tcp://127.0.0.1:0');
    check($socket !== false, 'a free port');
    $port = (int)explode(':', (string)stream_socket_get_name($socket, false))[1];
    fclose($socket);
    $flags = [...sl_php_flags(), '-d', 'error_log=' . $sandbox . "/$name-errors.log", '-d', 'session.save_path=' . $sandbox . '/sessions', ...$more];
    $process = proc_open([PHP_BINARY, ...$flags, '-S', "127.0.0.1:$port", '-t', $docroot], [0 => ['file', '/dev/null', 'r'], 1 => ['file', $sandbox . "/$name-server.log", 'w'], 2 => ['file', $sandbox . "/$name-server.log", 'a']], $pipes, null, $env + getenv());
    check(is_resource($process), "the $name server started");
    for ($i = 0; $i < 200; ++$i) {
        $c = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
        if ($c) { fclose($c); return [$process, $port]; }
        usleep(25000);
    }
    throw new RuntimeException("the $name server did not come up");
}
function sl_stop(array $servers): void { foreach ($servers as $process) { if (is_resource($process)) { proc_terminate($process); proc_close($process); } } }
/** One request without redirects: ['status', 'headers' (lowercase name => values), 'body', 'location', 'cookie' (the first Set-Cookie pair)]. */
function sl_http(int $port, string $method, string $path, array $headers = [], ?string $body = null, bool $diagnostics = false): array {
    $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $body ?? '', 'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0, 'timeout' => 60]]);
    $text = @file_get_contents("http://127.0.0.1:$port$path", false, $context);
    $lines = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
    check($text !== false && $lines !== [], "$method $path got an answer");
    preg_match('#^HTTP/\S+ (\d{3})#', (string)$lines[0], $m);
    $out = ['status' => (int)($m[1] ?? 0), 'headers' => [], 'body' => $text, 'location' => null, 'cookie' => null];
    foreach (array_slice($lines, 1) as $line) {
        if (!str_contains($line, ':')) { continue; }
        [$name, $value] = array_map('trim', explode(':', $line, 2));
        $out['headers'][strtolower($name)][] = $value;
    }
    $out['location'] = $out['headers']['location'][0] ?? null;
    $out['cookie'] = isset($out['headers']['set-cookie'][0]) ? explode(';', $out['headers']['set-cookie'][0])[0] : null;
    // A request that is expected to die on a PHP diagnostic (a missing library) says so; every other one must run clean.
    check($diagnostics || preg_match('~(?:^|\n)(?:PHP )?(?:Warning|Notice|Deprecated|Fatal error|Parse error|Uncaught \w+): ~', $text) !== 1, "$method $path ran without a PHP diagnostic: " . substr($text, 0, 300));
    return $out;
}
function sl_json(array $response): array { $j = json_decode($response['body'], true); return is_array($j) ? $j : ['_unreadable' => substr($response['body'], 0, 200)]; }
function sl_cookie(?string $pair): array { return $pair === null ? [] : ['Cookie: ' . $pair]; }
const SL_JSON = ['Content-Type: application/json', 'Accept: application/json'];
/** The hash of every file under a directory (names included), so that "nothing was written" can be said exactly. */
function sl_tree(string $dir): array {
    $out = [];
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) { if ($file->isFile()) { $out[substr($file->getPathname(), strlen($dir))] = hash_file('sha256', $file->getPathname()); } }
    ksort($out);
    return $out;
}

// ---- the sandbox ----
$sb = harness_dir();
$data = $sb . '/data'; $accounts = $sb . '/accounts'; $docroot = $sb . '/docroot';
$legacyData = $sb . '/data-legacy';       // part 1 signs people in and out with the app's own limiter; the shared parts must see a store nobody has opened
foreach ([$data, $legacyData, $accounts, $sb . '/sessions', $docroot . '/TaskMind'] as $d) { mkdir($d, 0700, true); }
$copy = function (string $to, string $variant = '') use ($source): void {
    mkdir($to);
    foreach (scandir($source) ?: [] as $name) {
        // The live configuration never comes along: each copy gets a config of its own.
        if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file($source . '/' . $name)) { continue; }
        copy($source . '/' . $name, $to . '/' . $name);
    }
    $file = $to . '/mindsuite-site-auth.php';
    $text = (string)file_get_contents($file);
    $count = 0;
    if ($variant === 'older') {
        // A site library from before the door: the same files, the one entry point gone.
        file_put_contents($file, str_replace('function mss_app_gate(string $app, array $opts)', 'function mss_app_gate_gone(string $app, array $opts)', $text, $count));
        check($count === 1, 'the older library lost mss_app_gate');
    } elseif ($variant === 'odd') {
        // A door that answers with whatever the case file says (an answer the app cannot use must close it, not open it).
        $text = str_replace('function mss_app_gate(string $app, array $opts)', 'function mss_app_gate_real(string $app, array $opts)', $text, $count);
        check($count === 1, 'the odd library renamed mss_app_gate');
        file_put_contents($file, $text . "\nfunction mss_app_gate(string \$app, array \$opts): ?array { return json_decode((string)getenv('SL_ODD_ANSWER'), true); }\n");
    }
};
$lib = $sb . '/lib'; $old = $sb . '/oldlib'; $odd = $sb . '/oddlib';
$copy($lib); $copy($old, 'older'); $copy($odd, 'odd');
$legacyHash = password_hash('legacy-secret', PASSWORD_BCRYPT, ['cost' => 4]);
$configure = function (array $extra = []) use ($lib, $old, $odd, $accounts, $legacyHash): void {
    // The scratch server drops taskmind_owners and the keys (a fixture run does, see auth.php): the team is made by this case, in the workspace itself.
    $config = ['users' => ['alex' => $legacyHash, 'sam' => $legacyHash, 'max' => $legacyHash, 'outsider' => $legacyHash, 'otto' => $legacyHash], 'data_dir' => $accounts, 'data_key' => 'disposable-fixture-key',
        'timezone' => 'America/Chicago', 'base' => '', 'taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam'] + $extra;
    foreach ([$lib, $old, $odd] as $to) { file_put_contents($to . '/config.php', '<?php return ' . var_export($config, true) . ';'); }
};
$setCase = fn(string $which, string $dataDir, string $answer = '') => file_put_contents($sb . '/case.json', json_encode(['lib' => $which, 'data' => $dataDir, 'answer' => $answer]));
$setCase($lib, $legacyData);
$preamble = '$case = json_decode((string)file_get_contents(getenv("SL_CASE")), true); putenv("TASKMIND_SITE_LIB=" . $case["lib"]); putenv("TASKMIND_DATA_DIR=" . $case["data"]); putenv("SL_ODD_ANSWER=" . $case["answer"]); ';
foreach (['index', 'api'] as $page) {
    file_put_contents($docroot . "/TaskMind/$page.php", '<?php ' . $preamble . 'require ' . var_export(realpath(__DIR__ . "/../../public/TaskMind/$page.php"), true) . ';');
}
// tm_login() and tm_gate() called directly (nothing in the entry points calls tm_login() in shared mode; this is the guard behind that): the same
// bootstrap, a posted username and password, and what the function says.
file_put_contents($docroot . '/TaskMind/direct.php', '<?php ' . $preamble
    . 'require getenv("TASKMIND_LIB_DIR") . "/bootstrap.php"; header("Content-Type: text/plain"); $_POST = ["username" => "alex", "password" => "legacy-secret"]; '
    . 'if (isset($_GET["session"])) { tm_gate(); echo json_encode([session_status() === PHP_SESSION_ACTIVE, $_SESSION]); exit; } '
    . 'if (isset($_GET["lazy"])) { tm_gate(); $f = $_GET["lazy"]; $kept = file_get_contents($f); file_put_contents($f, "not a store"); try { echo tm_accounts() instanceof \\Closure ? "closure" : "list"; } catch (\\Throwable $e) { echo "threw " . get_class($e); } file_put_contents($f, $kept); exit; } '
    . 'if (isset($_GET["accounts"])) { try { $names = array_keys(tm_shared_accounts()); sort($names); echo "accounts " . implode(",", $names); } catch (\\TaskMind\\RequestError $e) { echo "refused " . $e->status . " " . $e->errorCode . " " . $e->getMessage(); } exit; } '
    . 'try { echo tm_login($store) ? "signed in" : "declined"; } catch (\\TaskMind\\RequestError $e) { echo "refused " . $e->status . " " . $e->errorCode; }');
// The shared store: five accounts (the team's, a member to remove, a stranger's and one nobody has added) and what each can present, made by the library itself in a process of its own.
file_put_contents($sb . '/seed.php', <<<'PHP'
<?php
[, $lib, $dir] = $argv;
require $lib . '/mindsuite-auth.php';
$cfg = msa_config('prod', 'disposable-site-auth-fixture', $dir . '/protected');
$cfg['invite_code'] = '5678';
@mkdir($cfg['data_dir'], 0700, true);
msa_store_write($cfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]);
$out = [];
foreach (['alex', 'sam', 'max', 'outsider', 'guest'] as $name) {
    if (!msa_signup($cfg, $name, $name . '@example.invalid', $name . '-password-1', '5678')) { fwrite(STDERR, "signup $name failed\n"); exit(1); }
    $out[$name] = msa_login($cfg, $name, $name . '-password-1', 'Firefox', '203.0.113.1');
}
$out['alex-calmind'] = msa_login($cfg, 'alex', 'alex-password-1', 'phone', '203.0.113.1', 'calmind');
echo json_encode($out);
PHP);
$seeded = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), $sb . '/seed.php', $lib, $accounts])) . ' 2>&1');
$session = json_decode($seeded, true);
check(is_array($session) && isset($session['alex']['token'], $session['sam']['token'], $session['max']['token'], $session['outsider']['token'], $session['alex-calmind']['token']), 'the shared store was seeded: ' . substr($seeded, 0, 300));
$web = fn(string $who) => 'MSSESS=' . $session[$who]['token'];     // production's cookie name (the instance is prod: base '')
// A legacy PHP session of alex's, written the way PHP stores one: the second door a shared instance must keep shut.
$legacyId = bin2hex(random_bytes(16));
$legacyCsrf = bin2hex(random_bytes(32));
file_put_contents($sb . "/sessions/sess_$legacyId", 'auth|b:1;user|s:4:"alex";csrf|s:64:"' . $legacyCsrf . '";');
// The team: written the way the app writes it (the store with its own key), in the data directory a part uses.
$team = function (string $dir, array ...$members): void { (new TaskMind\Store($dir))->transaction('workspace', fn() => harness_workspace(...$members)); };
$team($legacyData, harness_member('alex', 'owner'), harness_member('sam', 'member'));
$configure([]);                 // the theme script below loads the library's auth.php, which reads the copy's config
$theme = $sb . '/theme.php';
file_put_contents($theme, '<?php [, $lib, $dir] = $argv; putenv("SUITE_DATA_DIR=$dir"); $_SESSION = ["auth" => true, "user" => "alex"]; require $lib . "/auth.php"; echo theme_set("sage") ? "set" : "refused";');
check(trim((string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), $theme, $lib, $accounts])) . ' 2>&1')) === 'set', 'alex has the sage theme in the site\'s own preference file');

$env = ['SL_CASE' => $sb . '/case.json', 'TASKMIND_LIB_DIR' => (string)realpath(__DIR__ . '/../../lib')];
$servers = [];
try {
    // The plain server reads the instance switch and the hold from the config, like the host; the scratch one has the library's fixture switch
    // (SUITE_MINDSUITE_AUTH_TEST) and the disposable store root a fixture run gets, which is the only way to give the library a store here.
    [$servers[], $plain] = sl_server($docroot, $env, 'plain', $sb);
    [$servers[], $scratch] = sl_server($docroot, $env + ['SUITE_DATA_DIR' => $accounts, 'SUITE_MINDSUITE_AUTH_TEST' => '1'], 'scratch', $sb);

    // ==== 1. The legacy sign-in, unchanged, in every way TaskMind keeps it ====
    $legacy = function (string $why, int $port) use ($legacyId, $legacyCsrf, $team, $legacyData) {
        $page = sl_http($port, 'GET', '/TaskMind/');
        check($page['status'] === 200 && str_contains($page['body'], 'name="password"') && !str_contains($page['body'], 'id="app"'), "$why: the page asks for a password, as before");
        check($page['location'] === null && preg_match('/^PHPSESSID=/', (string)$page['cookie']) === 1, "$why: and starts the PHP session, as before");
        check(preg_match('/name="csrf" value="([a-f0-9]{64})"/', $page['body'], $m) === 1, "$why: the form carries the session's token");
        $cookie = $page['cookie']; $csrf = $m[1];
        $api = sl_http($port, 'GET', '/TaskMind/api.php', SL_JSON);
        check($api['status'] === 401 && (sl_json($api)['error'] ?? '') === 'Sign in to open TaskMind.' && (sl_json($api)['code'] ?? '') === 'unauthorized', "$why: the API asks to sign in in its own words (401 unauthorized)");
        $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($cookie)];
        $wrong = sl_http($port, 'POST', '/TaskMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'alex', 'password' => 'not-it']));
        check($wrong['status'] === 200 && str_contains($wrong['body'], 'Unable to sign in with those details.'), "$why: a wrong password is refused by the app's own form");
        $missing = sl_http($port, 'POST', '/TaskMind/', $form, http_build_query(['csrf' => ($csrf[0] === 'a' ? 'b' : 'a') . substr($csrf, 1), 'username' => 'alex', 'password' => 'legacy-secret']));
        check($missing['status'] === 403 && str_contains($missing['body'], 'Your session changed. Reload before saving.'), "$why: a post with the wrong token is a 403 (got {$missing['status']}: " . substr(strip_tags($missing['body']), 0, 200) . ')');
        // An account that is not on the team: the password is right, the team gate says no, and no app is sent.
        $out = sl_http($port, 'POST', '/TaskMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'outsider', 'password' => 'legacy-secret']));
        check($out['status'] === 303 && $out['location'] === './', "$why: an account off the team signs in with its password, as before");
        $stranger = sl_http($port, 'GET', '/TaskMind/', sl_cookie($out['cookie'] ?? $cookie));
        check($stranger['status'] === 403 && str_contains($stranger['body'], 'TaskMind is for members of its team.') && !str_contains($stranger['body'], 'id="app"') && !str_contains($stranger['body'], 'app.js'), "$why: and the team gate shows it the form with the reason, no app");
        check(sl_http($port, 'GET', '/TaskMind/api.php', sl_cookie($out['cookie'] ?? $cookie))['status'] === 403, "$why: the API says 403 to it");
        $page = sl_http($port, 'GET', '/TaskMind/');
        $cookie = $page['cookie']; preg_match('/name="csrf" value="([a-f0-9]{64})"/', $page['body'], $m); $csrf = $m[1];
        $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($cookie)];
        $in = sl_http($port, 'POST', '/TaskMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'Alex ', 'password' => 'legacy-secret']));
        check($in['status'] === 303 && $in['location'] === './', "$why: the right password signs in with a 303 back to the page");
        $cookie = $in['cookie'] ?? $cookie;
        $app = sl_http($port, 'GET', '/TaskMind/', sl_cookie($cookie));
        check($app['status'] === 200 && str_contains($app['body'], 'id="app"') && !str_contains($app['body'], 'data-signout-action') && !str_contains($app['body'], 'name="password"'), "$why: the app opens, and Sign out stays a post to this page (no account-page attributes)");
        $data = sl_http($port, 'GET', '/TaskMind/api.php', sl_cookie($cookie));
        $token = sl_json($data)['csrf'] ?? '';
        check($data['status'] === 200 && (sl_json($data)['me'] ?? '') === 'alex' && (sl_json($data)['role'] ?? '') === 'owner' && preg_match('/^[a-f0-9]{64}$/', $token) === 1, "$why: the API answers for alex, the owner");
        // Legacy mode checks the legacy account list: an account only the shared store holds is unknown here (and never added).
        $addGuest = sl_http($port, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($cookie), 'X-CSRF-Token: ' . $token], json_encode(['op' => 'member.add', 'data' => ['id' => 'guest'], 'requestId' => 'legacy-guest', 'base' => 1]));
        check($addGuest['status'] === 400 && (sl_json($addGuest)['error'] ?? '') === 'Choose an existing site account.', "$why: adding an account only the shared store has is refused by the legacy list (got {$addGuest['status']}: " . substr($addGuest['body'], 0, 120) . ')');
        // ...while an account the legacy list holds is added, as before (then the team is put back for the next run).
        $addLegacy = sl_http($port, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($cookie), 'X-CSRF-Token: ' . $token], json_encode(['op' => 'member.add', 'data' => ['id' => 'otto'], 'requestId' => 'legacy-otto', 'base' => sl_json(sl_http($port, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($cookie)))['state']['rev']]));
        check($addLegacy['status'] === 200 && (sl_json($addLegacy)['ok'] ?? null) === true, "$why: an account the legacy list holds is added (got {$addLegacy['status']}: " . substr($addLegacy['body'], 0, 120) . ')');
        $team($legacyData, harness_member('alex', 'owner'), harness_member('sam', 'member'));
        $noToken = sl_http($port, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($cookie)], json_encode(['op' => 'project.add', 'data' => ['name' => 'X']]));
        check($noToken['status'] === 403 && (sl_json($noToken)['code'] ?? '') === 'csrf', "$why: a write without the token is refused in the app's own shape (403 csrf)");
        $bye = sl_http($port, 'POST', '/TaskMind/', ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($cookie)], http_build_query(['csrf' => $token, 'action' => 'logout']));
        check($bye['status'] === 303 && $bye['location'] === './', "$why: Sign out ends the PHP session");
        check(sl_http($port, 'GET', '/TaskMind/api.php', sl_cookie($cookie))['status'] === 401, "$why: and the API refuses it afterwards");
        $inside = sl_http($port, 'GET', '/TaskMind/direct.php?session=1');
        $held = json_decode($inside['body'], true);
        check(($held[0] ?? null) === true && array_keys($held[1] ?? []) === ['csrf'] && preg_match('/^[a-f0-9]{64}$/', (string)$held[1]['csrf']) === 1, "$why: the PHP session is active and holds its own token only, nobody signed in: " . $inside['body']);
        check(sl_http($port, 'GET', '/TaskMind/direct.php')['body'] === 'signed in', "$why: tm_login() itself still checks a password and signs in");
        // The session file written above: alex's, with auth and the right token: the legacy door itself still opens (the control for part 6).
        $pre = sl_http($port, 'GET', '/TaskMind/api.php', ['Cookie: PHPSESSID=' . $legacyId]);
        check($pre['status'] === 200 && (sl_json($pre)['me'] ?? '') === 'alex' && sl_json($pre)['csrf'] === $legacyCsrf, "$why: a PHP session on disk opens the API as its account, with its own token");
    };
    $configure([]);
    $legacy('shared sign-in off (no instance list)', $plain);
    $on = ['mindsuite_auth_instances' => ['prod'], 'mindsuite_auth_keys' => ['prod' => 'held-fixture-key']];
    foreach ([
        'held' => ['mindsuite_auth_hold' => ['prod' => ['taskmind']]],
        'held, name in another case' => ['mindsuite_auth_hold' => ['prod' => ['TaskMind', 'planmind']]],
        'a malformed hold (a string) holds every app' => ['mindsuite_auth_hold' => 'planmind'],
        'a malformed hold (a flat list) holds every app' => ['mindsuite_auth_hold' => ['planmind']],
        'a malformed hold (an instance holding a string)' => ['mindsuite_auth_hold' => ['prod' => 'planmind']],
    ] as $why => $extra) { $configure($on + $extra); $legacy("shared sign-in on, $why", $plain); }
    $configure(['mindsuite_auth_instances' => ['test', 'dev'], 'mindsuite_auth_keys' => ['test' => 'k', 'dev' => 'k']]);
    $legacy('only another instance is on', $plain);
    $configure($on);
    $setCase($old, $legacyData);
    $legacy('on, but the site library has no door yet (an older library)', $plain);
    $setCase($lib, $data);

    // ==== 2. On, no session ====
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['planmind']]]);     // a hold for another app leaves TaskMind on: the real config path, no fixture switch
    $nextUrl = '/account/?next=%2FTaskMind%2F';
    foreach (['plain server, real instance list' => $plain, 'scratch server, fixture switch' => $scratch] as $via => $port) {
        $page = sl_http($port, 'GET', '/TaskMind/');
        check($page['status'] === 303 && $page['location'] === $nextUrl && $page['body'] === '', "$via: a page request with no session is a 303 to $nextUrl, with no page behind it");
        check(str_contains(implode(',', $page['headers']['cache-control'] ?? []), 'no-store') && !isset($page['headers']['set-cookie']), "$via: not cacheable, and no PHP session is started for it");
        check(sl_http($port, 'HEAD', '/TaskMind/')['location'] === $nextUrl, "$via: a HEAD request (curl -I) gets the same Location");
        $deep = sl_http($port, 'GET', '/TaskMind/?next=https://evil.example/&view=workspace');
        check($deep['location'] === $nextUrl, "$via: the return target is the page's own path, whatever the query says");
        check(sl_http($port, 'GET', '/TaskMind/index.php')['location'] === $nextUrl, "$via: and the same for the page's file name");
        $api = sl_http($port, 'GET', '/TaskMind/api.php');
        check($api['status'] === 401 && (sl_json($api)['ok'] ?? null) === false && (sl_json($api)['signin'] ?? '') === $nextUrl && $api['location'] === null, "$via: the API answers 401 JSON with where to sign in, never a redirect (even for a caller that did not say it wants JSON)");
        check(str_contains(implode(',', $api['headers']['content-type'] ?? []), 'application/json') && !isset($api['headers']['set-cookie']), "$via: as JSON, with no cookie");
        check(sl_http($port, 'GET', '/TaskMind/api.php?view=workspace', ['X-Requested-With: XMLHttpRequest'])['status'] === 401, "$via: and so is the workspace read");
        $post = sl_http($port, 'POST', '/TaskMind/api.php', SL_JSON, json_encode(['op' => 'project.add', 'data' => ['name' => 'X']]));
        check($post['status'] === 401, "$via: a write with no session is a 401 too");
        $form = sl_http($port, 'POST', '/TaskMind/', ['Content-Type: application/x-www-form-urlencoded'], http_build_query(['username' => 'alex', 'password' => 'legacy-secret']));
        check($form['status'] === 303 && $form['location'] === $nextUrl, "$via: a sign-in posted to the page (the old form) gets the account page, nothing is checked");
    }
    check(scandir($data) === ['.', '..'], 'no store was opened or made for any of those: ' . implode(',', scandir($data)));
    check(!is_file($accounts . '/prefs-default.json'), 'and no preference file for a nameless account');

    // ==== 3. On, an account that is not on the team ====
    $team($data, harness_member('alex', 'owner'), harness_member('sam', 'member'), harness_member('max', 'member'));
    $workspaceBytes = fn() => (string)file_get_contents($data . '/workspace.enc');
    $before = $workspaceBytes();
    $stranger = $web('outsider');
    $page = sl_http($scratch, 'GET', '/TaskMind/', sl_cookie($stranger));
    check($page['status'] === 403 && str_contains($page['body'], 'TaskMind is for members of its team.'), 'an account with a valid shared session that is not on the team gets the 403 page');
    check(!str_contains($page['body'], 'name="password"') && !str_contains($page['body'], 'id="app"') && !str_contains($page['body'], 'app.js'), 'with no form of ours and no app');
    check(str_contains($page['body'], 'action="/account/"') && str_contains($page['body'], 'name="action" value="logout"') && str_contains($page['body'], 'name="next" value="/account/?next=%2FTaskMind%2F"')
        && str_contains($page['body'], 'name="csrf" value="' . $session['outsider']['csrf'] . '"'), 'only a Sign out that posts to the account page with the session\'s token');
    $api = sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($stranger));
    check($api['status'] === 403 && (sl_json($api)['code'] ?? '') === 'forbidden' && (sl_json($api)['error'] ?? '') === 'TaskMind is for members of its team.' && !str_contains($api['body'], '"team"'), 'the API answers it 403 forbidden, not 401, and says nothing of the team');
    $view = sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($stranger));
    check($view['status'] === 403 && !str_contains($view['body'], '"members"') && !str_contains($view['body'], 'alex'), 'and so is the workspace read');
    $write = sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($stranger), 'X-CSRF-Token: ' . $session['outsider']['csrf']], json_encode(['op' => 'project.add', 'data' => ['name' => 'Not allowed', 'color' => '#AABBCC'], 'requestId' => 'sl-stranger', 'base' => 1]));
    check($write['status'] === 403 && $workspaceBytes() === $before, 'a write with its own valid token is a 403 and the workspace is byte for byte what it was');

    // ==== 4. On, a member ====
    $alex = $web('alex');
    $page = sl_http($scratch, 'GET', '/TaskMind/', sl_cookie($alex));
    check($page['status'] === 200 && str_contains($page['body'], 'id="app"') && str_contains($page['body'], 'app.js') && !str_contains($page['body'], 'name="password"'), 'alex\'s shared session opens the app');
    check(str_contains($page['body'], 'id="app" data-signout-action="/account/" data-signout-next="/account/?next=%2FTaskMind%2F"'), 'the page names the account page for Sign out, and the sign-in it returns to');
    check(!isset($page['headers']['set-cookie']) && str_contains(implode(',', $page['headers']['cache-control'] ?? []), 'no-store'), 'with no PHP session cookie and nothing cacheable');
    check(sl_http($scratch, 'HEAD', '/TaskMind/', sl_cookie($alex))['status'] === 200, 'a HEAD request is let through too');
    $api = sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($alex));
    $j = sl_json($api);
    check($api['status'] === 200 && ($j['me'] ?? '') === 'alex' && ($j['role'] ?? '') === 'owner' && ($j['csrf'] ?? '') === $session['alex']['csrf'], 'the API answers for alex, the owner, with the shared session\'s own token');
    check(($j['theme'] ?? '') === 'sage' && !isset($api['headers']['set-cookie']), 'with alex\'s own theme (the site\'s helpers see the shared account), and no PHP session cookie');
    $sam = sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($web('sam'))));
    check(($sam['me'] ?? '') === 'sam' && ($sam['role'] ?? '') === 'member' && $sam['csrf'] === $session['sam']['csrf'] && $sam['csrf'] !== $j['csrf'] && ($sam['theme'] ?? '') === 'midnight', 'sam is sam, a member, with a token and a theme of its own');
    $state = sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($alex)));
    check(($state['ok'] ?? null) === true && ($state['state']['me'] ?? '') === 'alex' && $state['state']['projects'] === [], 'the workspace read answers for alex, from the team store');
    // Writes: the session's token, from this origin, never from another.
    $origin = "http://127.0.0.1:$scratch";
    $project = ['op' => 'project.add', 'data' => ['name' => 'Written through the shared sign-in', 'color' => '#AABBCC'], 'requestId' => 'sl-1', 'base' => $state['state']['rev']];
    $send = fn(string $as, array $headers, ?array $body = null) => sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($web($as)), ...$headers], json_encode($body ?? $project));
    $before = $workspaceBytes();
    check($send('alex', [])['status'] === 403, 'a write with no token is a 403');
    check($send('alex', ['X-CSRF-Token: ' . $session['sam']['csrf']])['status'] === 403, 'with another session\'s token');
    check($send('alex', ['X-CSRF-Token: ' . $session['alex']['csrf'] . 'x'])['status'] === 403, 'with a token one character too long');
    check($send('alex', ['X-CSRF-Token: ' . substr($session['alex']['csrf'], 0, 63) . 'x'])['status'] === 403, 'with a token off by one character');
    check($send('alex', ['X-CSRF-Token: ' . $session['alex']['csrf'], 'Sec-Fetch-Site: cross-site'])['status'] === 403, 'with the right token from another site');
    check($send('alex', ['X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: https://evil.example'])['status'] === 403, 'with the right token and another origin');
    check($workspaceBytes() === $before, 'and none of them wrote anything');
    $ok = $send('alex', ['X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: ' . $origin]);
    check($ok['status'] === 200 && ($written = sl_json($ok)) && ($written['ok'] ?? null) === true && is_string($written['id'] ?? null), 'the session\'s token from this origin writes (' . $ok['status'] . ': ' . substr($ok['body'], 0, 160) . ')');
    $seen = sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($web('sam'))));
    check(count($seen['state']['projects'] ?? []) === 1 && ($seen['state']['projects'][0]['name'] ?? '') === 'Written through the shared sign-in', 'and the other member sees it (one shared store)');
    check(!isset($ok['headers']['set-cookie']) && !is_file($data . '/attempts.enc') && !is_file($accounts . '/prefs-default.json'), 'no PHP session cookie and no sign-in ledger entry came of any of it');

    // ==== 4b. On, adding a member judges the SHARED store's accounts, never the legacy list ====
    $addAs = fn(string $id, string $reqId) => sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($alex), 'X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: ' . $origin],
        json_encode(['op' => 'member.add', 'data' => ['id' => $id], 'requestId' => $reqId, 'base' => sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($alex)))['state']['rev']]));
    $before = $workspaceBytes();
    foreach (['otto' => 'a legacy-list account the shared store does not hold', 'ghost' => 'an account nobody holds'] as $id => $why) {
        $r = $addAs($id, "sl-add-$id");
        check($r['status'] === 400 && (sl_json($r)['error'] ?? '') === 'Choose an existing site account.' && !preg_match('/sign.?up|create an account|register/i', $r['body']), "$why is refused in shared mode, without a sign-up hint (got {$r['status']}: " . substr($r['body'], 0, 120) . ')');
    }
    check($workspaceBytes() === $before, 'and neither wrote anything');
    $r = $addAs('guest', 'sl-add-guest');
    check($r['status'] === 200 && (sl_json($r)['ok'] ?? null) === true, 'an account only the shared store holds is added (got ' . $r['status'] . ': ' . substr($r['body'], 0, 160) . ')');
    $members = array_column(sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($alex)))['state']['members'] ?? [], 'role', 'id');
    check(($members['guest'] ?? null) === 'member', 'and is a member afterwards');
    check(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($web('guest')))['status'] === 200, 'whose shared session opens the app');
    // The permission check comes first: a member who may not add anyone learns nothing about which accounts exist.
    $samSend = fn(string $id, string $reqId) => sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($web('sam')), 'X-CSRF-Token: ' . $session['sam']['csrf'], 'Origin: ' . $origin],
        json_encode(['op' => 'member.add', 'data' => ['id' => $id], 'requestId' => $reqId, 'base' => sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php?view=workspace', sl_cookie($alex)))['state']['rev']]));
    $held = $samSend('outsider', 'sl-sam-1'); $nobody = $samSend('nobodyhere', 'sl-sam-2');
    check($held['status'] === 403 && $nobody['status'] === 403 && $held['body'] === $nobody['body'], 'a member who may not add anyone gets the same 403 for a real and an invented account');
    $r = $addAs('Guest', 'sl-add-case');
    check($r['status'] === 400, 'an id that is not the account\'s own spelling is refused (got ' . $r['status'] . ')');
    // The lookup itself: it reads the shared store, and a store it cannot read is a refusal, never an empty or a legacy list.
    $probe = sl_http($scratch, 'GET', '/TaskMind/direct.php?accounts=1')['body'];
    check($probe === 'accounts alex,guest,max,outsider,sam', 'the lookup lists what the shared store holds (a probe of the function, not an endpoint): ' . $probe);
    $storeFile = $accounts . '/protected/mindsuite-auth/auth.json';
    $kept = (string)file_get_contents($storeFile);
    file_put_contents($storeFile, 'not a store');
    file_put_contents($storeFile, $kept);
    $lz = sl_http($scratch, 'GET', '/TaskMind/direct.php?lazy=' . urlencode($storeFile), sl_cookie($alex))['body'];
    check($lz === 'closure', 'tm_accounts() reads nothing until asked (the store damaged after the gate: it still answers): ' . substr($lz, 0, 200));
    file_put_contents($storeFile, 'not a store');
    $probe = sl_http($scratch, 'GET', '/TaskMind/direct.php?accounts=1')['body'];
    check(str_starts_with($probe, 'refused 503 unavailable ') && !str_contains($probe, 'alex') && !str_contains($probe, 'otto'), 'an unreadable shared store is a 503 refusal with a plain message: ' . $probe);
    file_put_contents($storeFile, $kept);

    // ==== 5. On, the team gate is read on every request ====
    $max = $web('max');
    check((sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($max)))['role'] ?? '') === 'member', 'max, a member, is let in');
    $team($data, harness_member('alex', 'owner'), harness_member('sam', 'member'));
    $r = sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($max));
    check($r['status'] === 403 && !str_contains($r['body'], '"csrf"') && !str_contains($r['body'], '"me"'), 'removed from the team, the same shared session is refused on the next request: ' . $r['status']);
    $r = sl_http($scratch, 'GET', '/TaskMind/', sl_cookie($max));
    check($r['status'] === 403 && str_contains($r['body'], 'members of its team') && !str_contains($r['body'], 'app.js'), 'and the page shows the reason, no app');
    check(sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($max), 'X-CSRF-Token: ' . $session['max']['csrf'], 'Origin: ' . $origin], json_encode($project))['status'] === 403, 'and a write with its own valid token is refused');
    $team($data, harness_member('alex', 'owner'), harness_member('sam', 'member'), harness_member('max', 'viewer'));
    $r = sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($max)));
    check(($r['me'] ?? '') === 'max' && ($r['role'] ?? '') === 'viewer', 'added back as a viewer, the session works again with the new role: nothing was remembered in it');
    check(sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...sl_cookie($max), 'X-CSRF-Token: ' . $session['max']['csrf'], 'Origin: ' . $origin], json_encode($project))['status'] === 403, 'and a viewer\'s write is still the permission matrix\'s 403');
    $team($data, harness_member('alex', 'owner'), harness_member('sam', 'member'), harness_member('max', 'member'));
    $good = $workspaceBytes();
    file_put_contents($data . '/workspace.enc', 'TM1:' . base64_encode(random_bytes(64)));
    foreach (['alex' => $alex, 'sam' => $web('sam')] as $who => $cookie) {
        $r = sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($cookie));
        check(in_array($r['status'], [403, 503], true) && !str_contains($r['body'], '"csrf"') && !str_contains($r['body'], '"me"'), "a damaged workspace admits nobody ($who): {$r['status']}");
        check(!str_contains(sl_http($scratch, 'GET', '/TaskMind/', sl_cookie($cookie))['body'], 'app.js'), "and the page sends no app ($who)");
    }
    file_put_contents($data . '/workspace.enc', $good);
    check((sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($alex)))['me'] ?? '') === 'alex', 'the workspace put back, alex is in again');

    // ==== 6. On, no second door ====
    $pre = sl_http($scratch, 'GET', '/TaskMind/api.php', ['Cookie: PHPSESSID=' . $legacyId]);
    check($pre['status'] === 401, 'the legacy PHP session that opens the API on a legacy instance (part 1) opens nothing here');
    $pre = sl_http($scratch, 'GET', '/TaskMind/', ['Cookie: PHPSESSID=' . $legacyId]);
    check($pre['status'] === 303 && $pre['location'] === $nextUrl, 'nor the page');
    check(sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, 'Cookie: PHPSESSID=' . $legacyId, 'X-CSRF-Token: ' . $legacyCsrf], json_encode($project))['status'] === 401, 'nor a write with that session\'s own token');
    $both = sl_json(sl_http($scratch, 'GET', '/TaskMind/api.php', ['Cookie: ' . $alex . '; PHPSESSID=' . $legacyId]));
    check(($both['me'] ?? '') === 'alex' && ($both['csrf'] ?? '') === $session['alex']['csrf'], 'a request that carries both is judged on the shared cookie alone (its token, not the PHP session\'s)');
    $scoped = $session['alex-calmind']['token'];
    $before = $workspaceBytes();
    foreach ([
        'a scoped (CalMind) token as the bearer' => ['Authorization: Bearer ' . $scoped],
        'a scoped token as the cookie' => ['Cookie: MSSESS=' . $scoped],
        'a full account token as a bearer' => ['Authorization: Bearer ' . $session['alex']['token']],
        'the right cookie with any Authorization header beside it' => [...sl_cookie($alex), 'Authorization: Bearer ' . str_repeat('0', 64)],
        'the right cookie with a Basic Authorization header' => [...sl_cookie($alex), 'Authorization: Basic YTpi'],
    ] as $why => $headers) {
        $p = sl_http($scratch, 'GET', '/TaskMind/', $headers);
        check($p['status'] === 303 && $p['location'] === $nextUrl, "$why: the page sends to sign in");
        $a = sl_http($scratch, 'GET', '/TaskMind/api.php', $headers);
        check($a['status'] === 401 && !str_contains($a['body'], '"me"'), "$why: the API answers 401");
        $w = sl_http($scratch, 'POST', '/TaskMind/api.php', [...SL_JSON, ...$headers, 'X-CSRF-Token: ' . $session['alex-calmind']['csrf']], json_encode($project));
        check($w['status'] === 401, "$why: a write answers 401");
    }
    check($workspaceBytes() === $before, 'none of those wrote anything');
    // The page takes no sign-in and no password: every post but its own Sign out is refused, and that one is only handed on.
    $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($alex)];
    foreach ([['action' => 'login'], ['username' => 'alex', 'password' => 'legacy-secret'], ['username' => 'alex', 'password' => 'alex-password-1'], []] as $n => $fields) {
        $r = sl_http($scratch, 'POST', '/TaskMind/', $form, http_build_query(['csrf' => $session['alex']['csrf']] + $fields));
        check($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD' && !str_contains($r['body'], 'id="app"') && !isset($r['headers']['set-cookie']), "a post to the page ($n) is a 405: sign in at the account page");
    }
    $r = sl_http($scratch, 'PUT', '/TaskMind/', [...sl_cookie($alex), 'X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: ' . $origin]);
    check($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD', 'and so is any other method with the token');
    $r = sl_http($scratch, 'POST', '/TaskMind/', $form, http_build_query(['action' => 'logout']));
    check($r['status'] === 403 && !isset($r['headers']['location']), 'a Sign out without the session\'s token never gets that far (the gate\'s 403)');
    $r = sl_http($scratch, 'POST', '/TaskMind/', $form, http_build_query(['action' => 'logout', 'csrf' => str_repeat('0', 64)]));
    check($r['status'] === 403 && !isset($r['headers']['location']), 'nor with a wrong one');
    $r = sl_http($scratch, 'POST', '/TaskMind/', [...$form, 'Origin: https://evil.example'], http_build_query(['action' => 'logout', 'csrf' => $session['alex']['csrf']]));
    check($r['status'] === 403 && !isset($r['headers']['location']), 'nor from another origin');
    $r = sl_http($scratch, 'POST', '/TaskMind/', [...$form, 'Sec-Fetch-Site: cross-site'], http_build_query(['action' => 'logout', 'csrf' => $session['alex']['csrf']]));
    check($r['status'] === 403 && !isset($r['headers']['location']), 'nor from another site');
    $r = sl_http($scratch, 'POST', '/TaskMind/', $form, http_build_query(['action' => 'logout', 'csrf' => $session['alex']['csrf']]));
    check($r['status'] === 307 && $r['location'] === '/account/' && !isset($r['headers']['set-cookie']), 'the page\'s own Sign out (the right token) is handed on to the account page with a 307, which keeps the post: ' . $r['status']);
    check(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($alex))['status'] === 200, 'and nothing here ended the session: signing out is the account page\'s act');
    $inside = sl_http($scratch, 'GET', '/TaskMind/direct.php?session=1', sl_cookie($alex));
    check($inside['body'] === json_encode([false, ['auth' => true, 'user' => 'alex', 'csrf' => $session['alex']['csrf']]]), 'in shared mode no PHP session is active: the request\'s signed-in state is a plain array built from the gate\'s answer (alex and the shared session\'s token): ' . $inside['body']);
    $direct = sl_http($scratch, 'GET', '/TaskMind/direct.php', sl_cookie($alex));
    check($direct['body'] === 'refused 403 forbidden', 'and tm_login() itself refuses to check a password: ' . $direct['body']);
    check(!is_file($data . '/attempts.enc'), 'the app\'s password limiter was never reached');
    // A session the account page signed out is gone: revoke it in the store the way /account/ does, then ask again.
    file_put_contents($sb . '/revoke.php', '<?php [, $lib, $dir, $token] = $argv; require $lib . "/mindsuite-auth.php"; $cfg = msa_config("prod", "disposable-site-auth-fixture", $dir . "/protected"); $s = msa_session($cfg, ["REMOTE_ADDR" => "203.0.113.1"], ["MSSESS" => $token]); msa_revoke($cfg, $s); echo "revoked";');
    $spare = json_decode((string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), '-r', 'require $argv[1] . "/mindsuite-auth.php"; $c = msa_config("prod", "disposable-site-auth-fixture", $argv[2] . "/protected"); echo json_encode(msa_login($c, "alex", "alex-password-1", "spare", "203.0.113.2"));', $lib, $accounts])) . ' 2>&1'), true);
    check(is_array($spare) && isset($spare['token']), 'a spare session for alex');
    check(sl_http($scratch, 'GET', '/TaskMind/api.php', ['Cookie: MSSESS=' . $spare['token']])['status'] === 200, 'the spare session opens the API');
    check(trim((string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), $sb . '/revoke.php', $lib, $accounts, $spare['token']])) . ' 2>&1')) === 'revoked', 'and is revoked (what Sign out at the account page does)');
    check(sl_http($scratch, 'GET', '/TaskMind/api.php', ['Cookie: MSSESS=' . $spare['token']])['status'] === 401 && sl_http($scratch, 'GET', '/TaskMind/', ['Cookie: MSSESS=' . $spare['token']])['status'] === 303, 'a revoked session opens neither the API nor the page');

    // ==== 7. On, but it cannot work: fail closed, never legacy ====
    $store = $accounts . '/protected/mindsuite-auth/auth.json';
    $kept = (string)file_get_contents($store);
    file_put_contents($store, 'not a store');
    foreach (['page' => '/TaskMind/', 'API' => '/TaskMind/api.php'] as $what => $path) {
        $r = sl_http($scratch, 'GET', $path, sl_cookie($alex));
        check($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.' && !isset($r['headers']['set-cookie']), "an unreadable shared store: the $what answers 503 and says nothing else");
        check(sl_http($scratch, 'POST', $path, [...SL_JSON, ...sl_cookie($alex), 'X-CSRF-Token: ' . $session['alex']['csrf']], json_encode($project))['status'] === 503, "and a write to the $what too");
    }
    check(!str_contains(sl_http($scratch, 'GET', '/TaskMind/', sl_cookie($alex))['body'], 'name="password"'), 'with no sign-in form of ours to fall back to');
    file_put_contents($store, $kept);
    check(sl_http($scratch, 'GET', '/TaskMind/api.php', sl_cookie($alex))['status'] === 200, 'the store put back, alex is in again');
    $configure(array_replace($on, ['mindsuite_auth_keys' => []]));                 // switched on, but no key for the instance: the real config path
    foreach (['page' => '/TaskMind/', 'API' => '/TaskMind/api.php'] as $what => $path) {
        $r = sl_http($plain, 'GET', $path);
        check($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.', "switched on with no key: the $what answers 503, even to a visitor with no session (got {$r['status']}: " . substr($r['body'], 0, 200) . ')');
    }
    check(!str_contains(sl_http($plain, 'GET', '/TaskMind/')['body'], 'name="password"'), 'and shows no password form');
    $configure($on);
    // A door that answers with something the app cannot use closes it: no session, no legacy form, no data.
    foreach ([
        'no CSRF token' => ['user' => 'alex'],
        'an empty CSRF token' => ['user' => 'alex', 'csrf' => ''],
        'no account' => ['csrf' => str_repeat('a', 64)],
        'an account that is not text' => ['user' => ['alex'], 'csrf' => str_repeat('a', 64)],
    ] as $why => $answer) {
        $setCase($odd, $data, json_encode($answer));
        foreach (['page' => ['GET', '/TaskMind/', []], 'API' => ['GET', '/TaskMind/api.php', []], 'write' => ['POST', '/TaskMind/api.php', [...SL_JSON, 'X-CSRF-Token: ']]] as $what => [$method, $path, $headers]) {
            $r = sl_http($plain, $method, $path, $headers, $method === 'POST' ? json_encode($project) : null);
            check($r['status'] === 503 && !str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'app.js') && !str_contains($r['body'], '"me"') && !isset($r['headers']['set-cookie']), "a door that gives $why: the $what is a 503 (got {$r['status']}: " . substr($r['body'], 0, 120) . ')');
        }
    }
    // The odd door with a sound answer is the control: the same files, a usable answer, the app opens.
    $setCase($odd, $data, json_encode(['user' => 'alex', 'csrf' => str_repeat('c', 64)]));
    $r = sl_http($plain, 'GET', '/TaskMind/api.php');
    check($r['status'] === 200 && (sl_json($r)['me'] ?? '') === 'alex' && sl_json($r)['csrf'] === str_repeat('c', 64), 'with a sound answer the same library opens the app (control)');
    $setCase($odd, $data, json_encode(['user' => 'not a name!', 'csrf' => str_repeat('c', 64)]));
    $r = sl_http($plain, 'GET', '/TaskMind/api.php');
    check($r['status'] === 403 && !str_contains($r['body'], '"me"'), 'a gate user that no team holds gets a 403, whatever its name looks like');
    $setCase($lib, $data);
    // No site library at all: nothing is served (the page, the API), and no legacy form appears.
    [$servers[], $nolib] = sl_server($docroot, $env, 'nolib', $sb, ['-d', 'display_errors=0']);     // like the host: a fatal error is a 500 with no text
    $setCase($sb . '/nowhere', $data);
    foreach (['page' => '/TaskMind/', 'API' => '/TaskMind/api.php'] as $what => $path) {
        $r = sl_http($nolib, 'GET', $path, [], null, true);
        check(($what === 'page' ? $r['status'] === 500 && trim($r['body']) === '' : $r['status'] === 503 && (sl_json($r)['code'] ?? '') === 'unavailable')
            && !str_contains($r['body'], '"me"') && !str_contains($r['body'], 'name="password"') && !isset($r['headers']['set-cookie']), "no site library: the $what says it is unavailable and nothing else: no form, no app, no cookie (got {$r['status']}: " . substr($r['body'], 0, 120) . ')');
    }
    $setCase($lib, $data);
    $configure($on);
    // Whatever the run logged on purpose, no process died with a diagnostic of its own.
    foreach (['plain', 'scratch'] as $name) { check(!preg_match('~Fatal error|Uncaught|Stack trace~', (string)@file_get_contents($sb . "/$name-errors.log") . (string)@file_get_contents($sb . "/$name-server.log")), "the $name server logged no fatal error"); }
} finally {
    sl_stop($servers);
}
