<?php
declare(strict_types=1);
// The suite's shared sign-in (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"), through the REAL entry points: index.php and
// api.php run under PHP's built-in server against a disposable copy of the site library, once with the shared sign-in on (the library's
// fixture switch and a disposable store of three accounts) and once per way PlanMind keeps its own sign-in: the instance is off, PlanMind is
// held, a malformed hold, another instance only, a site library older than the door. Nothing here reads a real configuration or store.
//
//   1. Off, held and an older library: the legacy sign-in, session, CSRF token and limiter, exactly as before (one run each).
//   2. On, no session: 303 to /account/?next= for the page, 401 JSON for the API, the health answer still public, no store opened.
//   3. On, a session: the page, the API, writes with the session's token only, the account the site's helpers see.
//   4. On, an account that is not one of the two people: 403 before the planner store is opened.
//   5. On, no second door: a legacy PHP session, a bearer, a scoped (CalMind) token as bearer or cookie, a post to the page: all refused.
//   6. On, but the store, the key or the people cannot be had: 503, never the legacy path.

$source = getenv('PLANMIND_TEST_SITE_LIB') ?: '';
if ($source === '') {
    foreach ([dirname(__DIR__, 3) . '/../seancheren-site/lib', dirname(__DIR__, 3) . '/../../seancheren-site/lib'] as $candidate) {
        $source = $candidate;
        if (is_file($candidate . '/auth.php')) break;
    }
}
check(is_file($source . '/auth.php') && is_file($source . '/mindsuite-site-auth.php'), "the site library is needed (set PLANMIND_TEST_SITE_LIB=<seancheren-site>/lib); looked in $source");

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
function sl_server(string $docroot, array $env, string $name, string $sandbox): array {
    $socket = stream_socket_server('tcp://127.0.0.1:0');
    check($socket !== false, 'a free port');
    $port = (int)explode(':', (string)stream_socket_get_name($socket, false))[1];
    fclose($socket);
    $flags = [...sl_php_flags(), '-d', 'error_log=' . $sandbox . "/$name-errors.log", '-d', 'session.save_path=' . $sandbox . '/sessions'];
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
function sl_http(int $port, string $method, string $path, array $headers = [], ?string $body = null): array {
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
    check(preg_match('~(?:^|\n)(?:PHP )?(?:Warning|Notice|Deprecated|Fatal error|Parse error|Uncaught \w+): ~', $text) !== 1, "$method $path ran without a PHP diagnostic: " . substr($text, 0, 300));
    return $out;
}
function sl_json(array $response): array { $j = json_decode($response['body'], true); return is_array($j) ? $j : ['_unreadable' => substr($response['body'], 0, 200)]; }
function sl_cookie(?string $pair): array { return $pair === null ? [] : ['Cookie: ' . $pair]; }
const SL_JSON = ['Content-Type: application/json', 'Accept: application/json'];

// ---- the sandbox ----
$sb = harness_dir();
$planner = $sb . '/planner'; $accounts = $sb . '/accounts'; $docroot = $sb . '/docroot';
$legacyPlanner = $sb . '/planner-legacy';       // part 1 signs people in and out with the app's own limiter; the shared parts must see a store nobody has opened
foreach ([$planner, $legacyPlanner, $accounts, $sb . '/sessions', $docroot . '/PlanMind'] as $d) { mkdir($d, 0700, true); }
$copy = function (string $to, bool $withoutDoor = false) use ($source): void {
    mkdir($to);
    foreach (scandir($source) ?: [] as $name) {
        // The live configuration never comes along: each copy gets a config of its own.
        if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file($source . '/' . $name)) { continue; }
        copy($source . '/' . $name, $to . '/' . $name);
    }
    if ($withoutDoor) {
        // A site library from before the door: the same files, the one entry point gone.
        $file = $to . '/mindsuite-site-auth.php';
        $text = (string)file_get_contents($file, false, null, 0, null);
        $count = 0;
        file_put_contents($file, str_replace('function mss_app_gate(string $app, array $opts)', 'function mss_app_gate_gone(string $app, array $opts)', $text, $count));
        check($count === 1, 'the older library lost mss_app_gate');
    }
};
$lib = $sb . '/lib'; $old = $sb . '/oldlib';
$copy($lib); $copy($old, true);
$legacyHash = password_hash('legacy-secret', PASSWORD_BCRYPT, ['cost' => 4]);
$people = ['owner' => 'alex', 'partner' => 'sam'];
$configure = function (array $extra = [], ?array $named = ['owner' => 'alex', 'partner' => 'sam'], string $dir = '') use ($lib, $old, $accounts, $legacyHash): void {
    $config = ['users' => ['alex' => $legacyHash, 'sam' => $legacyHash, 'outsider' => $legacyHash], 'data_dir' => $accounts, 'data_key' => 'disposable-fixture-key', 'timezone' => 'America/Chicago', 'base' => ''] + ($named === null ? [] : ['people' => $named]) + $extra;
    foreach ([$lib, $old] as $to) { file_put_contents($to . '/config.php', '<?php return ' . var_export($config, true) . ';'); }
};
$setCase = fn(string $which, string $data) => file_put_contents($sb . '/case.json', json_encode(['lib' => $which, 'data' => $data]));
$setCase($lib, $legacyPlanner);
foreach (['index', 'api'] as $page) {
    file_put_contents($docroot . "/PlanMind/$page.php", '<?php $case = json_decode((string)file_get_contents(getenv("SL_CASE")), true); putenv("PLANMIND_SITE_LIB=" . $case["lib"]); putenv("PLANMIND_DATA_DIR=" . $case["data"]); require ' . var_export(realpath(__DIR__ . "/../../public/PlanMind/$page.php"), true) . ';');
}
// pm_login() called directly (nothing in the entry points calls it in shared mode; this is the guard behind that): the same bootstrap, a posted
// username and password, and what the function says.
file_put_contents($docroot . '/PlanMind/direct.php', '<?php $case = json_decode((string)file_get_contents(getenv("SL_CASE")), true); putenv("PLANMIND_SITE_LIB=" . $case["lib"]); putenv("PLANMIND_DATA_DIR=" . $case["data"]); '
    . 'require getenv("PLANMIND_LIB_DIR") . "/bootstrap.php"; header("Content-Type: text/plain"); $_POST = ["username" => "alex", "password" => "legacy-secret"]; '
    . 'if (isset($_GET["session"])) { pm_gate(); echo json_encode([session_status() === PHP_SESSION_ACTIVE, $_SESSION]); exit; } '
    . 'try { echo pm_login($planStore) ? "signed in" : "declined"; } catch (\\PlanMind\\RequestError $e) { echo "refused " . $e->status . " " . $e->errorCode; }');
// The shared store: three accounts (the two people's and a stranger's) and what each can present, made by the library itself in a process of its own.
file_put_contents($sb . '/seed.php', <<<'PHP'
<?php
[, $lib, $dir] = $argv;
require $lib . '/mindsuite-auth.php';
$cfg = msa_config('prod', 'disposable-site-auth-fixture', $dir . '/protected');
$cfg['invite_code'] = '5678';
@mkdir($cfg['data_dir'], 0700, true);
msa_store_write($cfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]);
$out = [];
foreach (['alex', 'sam', 'outsider'] as $name) {
    if (!msa_signup($cfg, $name, $name . '@example.invalid', $name . '-password-1', '5678')) { fwrite(STDERR, "signup $name failed\n"); exit(1); }
    $out[$name] = msa_login($cfg, $name, $name . '-password-1', 'Firefox', '203.0.113.1');
}
$out['alex-calmind'] = msa_login($cfg, 'alex', 'alex-password-1', 'phone', '203.0.113.1', 'calmind');
echo json_encode($out);
PHP);
$seeded = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), $sb . '/seed.php', $lib, $accounts])) . ' 2>&1');
$session = json_decode($seeded, true);
check(is_array($session) && isset($session['alex']['token'], $session['sam']['token'], $session['outsider']['token'], $session['alex-calmind']['token']), 'the shared store was seeded: ' . substr($seeded, 0, 300));
$web = fn(string $who) => 'MSSESS=' . $session[$who]['token'];     // production's cookie name (the instance is prod: base '')
// A legacy PHP session of alex's, written the way PHP stores one: the second door a shared instance must keep shut.
$legacyId = bin2hex(random_bytes(16));
$legacyCsrf = bin2hex(random_bytes(32));
file_put_contents($sb . "/sessions/sess_$legacyId", 'auth|b:1;user|s:4:"alex";csrf|s:64:"' . $legacyCsrf . '";');

$env = ['SL_CASE' => $sb . '/case.json', 'PLANMIND_LIB_DIR' => (string)realpath(__DIR__ . '/../../lib')];
$servers = [];
try {
    // The plain server reads the instance switch and the hold from the config, like the host; the scratch one has the library's fixture switch
    // (SUITE_MINDSUITE_AUTH_TEST) and the disposable store root a fixture run gets, which is the only way to give the library a store here.
    [$servers[], $plain] = sl_server($docroot, $env, 'plain', $sb);
    [$servers[], $scratch] = sl_server($docroot, $env + ['SUITE_DATA_DIR' => $accounts, 'SUITE_MINDSUITE_AUTH_TEST' => '1'], 'scratch', $sb);
    $login = fn(int $port, ?string $cookie = null, array $more = [], string $path = '/PlanMind/') => sl_http($port, 'GET', $path, [...sl_cookie($cookie), ...$more]);

    // ==== 1. The legacy sign-in, unchanged, in every way PlanMind keeps it ====
    $legacy = function (string $why, int $port) use ($legacyId, $legacyCsrf, $planner) {
        $page = sl_http($port, 'GET', '/PlanMind/');
        check($page['status'] === 200 && str_contains($page['body'], 'name="password"') && !str_contains($page['body'], 'id="app"'), "$why: the page asks for a password, as before");
        check($page['location'] === null && preg_match('/^PHPSESSID=/', (string)$page['cookie']) === 1, "$why: and starts the PHP session, as before");
        check(preg_match('/name="csrf" value="([a-f0-9]{64})"/', $page['body'], $m) === 1, "$why: the form carries the session's token");
        $cookie = $page['cookie']; $csrf = $m[1];
        $api = sl_http($port, 'GET', '/PlanMind/api.php', SL_JSON);
        check($api['status'] === 401 && (sl_json($api)['error'] ?? '') === 'Sign in to open PlanMind.' && (sl_json($api)['code'] ?? '') === 'unauthorized', "$why: the API asks to sign in in its own words (401 unauthorized)");
        $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($cookie)];
        $wrong = sl_http($port, 'POST', '/PlanMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'alex', 'password' => 'not-it']));
        check($wrong['status'] === 200 && str_contains($wrong['body'], 'Unable to sign in with those details.'), "$why: a wrong password is refused by the app's own form");
        $outsider = sl_http($port, 'POST', '/PlanMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'outsider', 'password' => 'legacy-secret']));
        check($outsider['status'] === 200 && str_contains($outsider['body'], 'Unable to sign in with those details.'), "$why: and so is a right password of someone who is not one of the two people");
        $missing = sl_http($port, 'POST', '/PlanMind/', $form, http_build_query(['csrf' => ($csrf[0] === 'a' ? 'b' : 'a') . substr($csrf, 1), 'username' => 'alex', 'password' => 'legacy-secret']));
        check($missing['status'] === 403 && str_contains($missing['body'], 'Your session changed. Reload before saving.'), "$why: a post with the wrong token is a 403 (got {$missing['status']}: " . substr(strip_tags($missing['body']), 0, 200) . ')');
        $in = sl_http($port, 'POST', '/PlanMind/', $form, http_build_query(['csrf' => $csrf, 'username' => 'Alex ', 'password' => 'legacy-secret']));
        check($in['status'] === 303 && $in['location'] === './', "$why: the right password signs in with a 303 back to the page");
        $cookie = $in['cookie'] ?? $cookie;
        $app = sl_http($port, 'GET', '/PlanMind/', sl_cookie($cookie));
        check($app['status'] === 200 && str_contains($app['body'], 'id="app"') && !str_contains($app['body'], 'data-signout-action') && !str_contains($app['body'], 'name="password"'), "$why: the app opens, and Sign out stays a post to this page (no account-page attributes)");
        $data = sl_http($port, 'GET', '/PlanMind/api.php', sl_cookie($cookie));
        $token = sl_json($data)['csrf'];
        check($data['status'] === 200 && sl_json($data)['user'] === 'alex' && preg_match('/^[a-f0-9]{64}$/', $token) === 1, "$why: the API answers for alex");
        $noToken = sl_http($port, 'POST', '/PlanMind/api.php', [...SL_JSON, ...sl_cookie($cookie)], json_encode(['action' => 'savePrefs']));
        check($noToken['status'] === 403 && (sl_json($noToken)['code'] ?? '') === 'csrf', "$why: a write without the token is refused in the app's own shape (403 csrf)");
        $out = sl_http($port, 'POST', '/PlanMind/', $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($cookie)], http_build_query(['csrf' => $token, 'action' => 'logout']));
        check($out['status'] === 303 && $out['location'] === './', "$why: Sign out ends the PHP session");
        check(sl_http($port, 'GET', '/PlanMind/api.php', sl_cookie($cookie))['status'] === 401, "$why: and the API refuses it afterwards");
        $inside = sl_http($port, 'GET', '/PlanMind/direct.php?session=1');
        $held = json_decode($inside['body'], true);
        check(($held[0] ?? null) === true && array_keys($held[1] ?? []) === ['csrf'] && preg_match('/^[a-f0-9]{64}$/', (string)$held[1]['csrf']) === 1, "$why: the PHP session is active and holds its own token only, nobody signed in: " . $inside['body']);
        $direct = sl_http($port, 'GET', '/PlanMind/direct.php');
        check($direct['body'] === 'signed in', "$why: pm_login() itself still checks a password and signs in");
        // The session file written above: alex's, with auth and the right token: the legacy door itself still opens (the control for part 5).
        $pre = sl_http($port, 'GET', '/PlanMind/api.php', ['Cookie: PHPSESSID=' . $legacyId]);
        check($pre['status'] === 200 && (sl_json($pre)['user'] ?? '') === 'alex' && sl_json($pre)['csrf'] === $legacyCsrf, "$why: a PHP session on disk opens the API as its account, with its own token");
    };
    $configure([]);
    $legacy('shared sign-in off (no instance list)', $plain);
    $on = ['mindsuite_auth_instances' => ['prod'], 'mindsuite_auth_keys' => ['prod' => 'held-fixture-key']];
    foreach ([
        'held' => ['mindsuite_auth_hold' => ['prod' => ['planmind']]],
        'held, name in another case' => ['mindsuite_auth_hold' => ['prod' => ['PlanMind', 'taskmind']]],
        'a malformed hold (a string) holds every app' => ['mindsuite_auth_hold' => 'taskmind'],
        'a malformed hold (a flat list) holds every app' => ['mindsuite_auth_hold' => ['taskmind']],
        'a malformed hold (an instance holding a string)' => ['mindsuite_auth_hold' => ['prod' => 'taskmind']],
    ] as $why => $extra) { $configure($on + $extra); $legacy("shared sign-in on, $why", $plain); }
    $configure(['mindsuite_auth_instances' => ['test', 'dev'], 'mindsuite_auth_keys' => ['test' => 'k', 'dev' => 'k']]);
    $legacy('only another instance is on', $plain);
    $configure($on);
    $setCase($old, $legacyPlanner);
    $legacy('on, but the site library has no door yet (an older library)', $plain);
    $setCase($lib, $planner);

    // ==== 2. On, no session ====
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['taskmind']]]);     // a hold for another app leaves PlanMind on: the real config path, no fixture switch
    foreach (['plain server, real instance list' => $plain, 'scratch server, fixture switch' => $scratch] as $via => $port) {
        $page = sl_http($port, 'GET', '/PlanMind/');
        check($page['status'] === 303 && $page['location'] === '/account/?next=%2FPlanMind%2F' && $page['body'] === '', "$via: a page request with no session is a 303 to /account/?next=%2FPlanMind%2F, with no page behind it");
        check(str_contains(implode(',', $page['headers']['cache-control'] ?? []), 'no-store') && !isset($page['headers']['set-cookie']), "$via: not cacheable, and no PHP session is started for it");
        check(sl_http($port, 'HEAD', '/PlanMind/')['location'] === '/account/?next=%2FPlanMind%2F', "$via: a HEAD request (curl -I) gets the same Location");
        $deep = sl_http($port, 'GET', '/PlanMind/?next=https://evil.example/&day=2026-11-12');
        check($deep['location'] === '/account/?next=%2FPlanMind%2F', "$via: the return target is the page's own path, whatever the query says");
        $api = sl_http($port, 'GET', '/PlanMind/api.php');
        check($api['status'] === 401 && (sl_json($api)['ok'] ?? null) === false && (sl_json($api)['signin'] ?? '') === '/account/?next=%2FPlanMind%2F' && $api['location'] === null, "$via: the API answers 401 JSON with where to sign in, never a redirect (even for a caller that did not say it wants JSON)");
        check(str_contains(implode(',', $api['headers']['content-type'] ?? []), 'application/json'), "$via: as JSON");
        $post = sl_http($port, 'POST', '/PlanMind/api.php', SL_JSON, json_encode(['action' => 'savePrefs']));
        check($post['status'] === 401, "$via: a write with no session is a 401 too");
        check(sl_http($port, 'GET', '/PlanMind/api.php?calmind=1&from=2026-11-12&to=2026-11-13', ['X-Requested-With: XMLHttpRequest'])['status'] === 401, "$via: and so is CalMind's events call");
        $health = sl_http($port, 'GET', '/PlanMind/api.php?health=1');
        check($health['status'] === 200 && $health['body'] === '{"peopleConfigured":true}', "$via: the public health answer stays public");
    }
    check(glob($planner . '/*.enc') === [] && !is_file($planner . '/.key'), 'no planner store was opened or made for any of those');
    check(!is_file($sb . '/accounts/prefs-default.json'), 'and no preference file for a nameless account');

    // ==== 4 (first, before alex opens the store). On, an account that is not one of the two people ====
    $stranger = $web('outsider');
    $page = sl_http($scratch, 'GET', '/PlanMind/', sl_cookie($stranger));
    check($page['status'] === 403 && str_contains($page['body'], 'This planner is private to the two people who share it.'), 'a stranger with a valid shared session gets the 403 page');
    check(!str_contains($page['body'], 'name="password"') && !str_contains($page['body'], 'id="app"') && !str_contains($page['body'], 'app.js'), 'with no form of ours and no app');
    check(str_contains($page['body'], 'action="/account/"') && str_contains($page['body'], 'name="action" value="logout"') && str_contains($page['body'], 'name="next" value="/account/?next=%2FPlanMind%2F"')
        && str_contains($page['body'], 'name="csrf" value="' . $session['outsider']['csrf'] . '"'), 'only a Sign out that posts to the account page with the session\'s token');
    $api = sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($stranger));
    check($api['status'] === 403 && (sl_json($api)['code'] ?? '') === 'forbidden' && (sl_json($api)['error'] ?? '') === 'Sign in to open PlanMind.', 'the API answers a stranger 403 forbidden, not 401');
    $write = sl_http($scratch, 'POST', '/PlanMind/api.php', [...SL_JSON, ...sl_cookie($stranger), 'X-CSRF-Token: ' . $session['outsider']['csrf']], json_encode(['action' => 'savePrefs']));
    check($write['status'] === 403, 'and a write with the stranger\'s own valid token');
    check(sl_http($scratch, 'GET', '/PlanMind/api.php?calmind=1&from=2026-11-12&to=2026-11-13', sl_cookie($stranger))['status'] === 403, 'and CalMind\'s events');
    check(glob($planner . '/*.enc') === [], 'the planner store was never opened for the stranger');

    // ==== 3. On, a session ====
    $alex = $web('alex');
    $page = sl_http($scratch, 'GET', '/PlanMind/', sl_cookie($alex));
    check($page['status'] === 200 && str_contains($page['body'], 'id="app"') && str_contains($page['body'], 'app.js') && !str_contains($page['body'], 'name="password"'), 'alex\'s shared session opens the app');
    check(str_contains($page['body'], 'id="app" data-signout-action="/account/" data-signout-next="/account/?next=%2FPlanMind%2F"'), 'the page names the account page for Sign out, and the sign-in it returns to');
    check(!isset($page['headers']['set-cookie']) && str_contains(implode(',', $page['headers']['cache-control'] ?? []), 'no-store'), 'with no PHP session cookie and nothing cacheable');
    $data = sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex));
    $j = sl_json($data);
    check($data['status'] === 200 && ($j['user'] ?? '') === 'alex' && ($j['csrf'] ?? '') === $session['alex']['csrf'] && ($j['people'] ?? null) === $people, 'the API answers for alex, with the shared session\'s own token and the two people');
    check(($j['theme'] ?? '') === 'midnight' && count($j['tasks'] ?? ['x']) === 0, 'from the planner store, created by that call');
    check(!isset($data['headers']['set-cookie']), 'no PHP session cookie from the API either');
    $sam = sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($web('sam'))));
    check(($sam['user'] ?? '') === 'sam' && $sam['csrf'] === $session['sam']['csrf'] && $sam['csrf'] !== $j['csrf'], 'sam is sam, with a token of her own');
    check((sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php?since=' . $j['revision'], sl_cookie($alex)))['unchanged'] ?? false) === true, 'the poll is answered "unchanged" as before');
    // Writes: the session's token, from this origin, never from another.
    $origin = "http://127.0.0.1:$scratch";
    $todo = ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(901), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex'], 'title' => 'Written through the shared sign-in'];
    $send = fn(array $headers, array $body = null) => sl_http($scratch, 'POST', '/PlanMind/api.php', [...SL_JSON, ...sl_cookie($alex), ...$headers], json_encode($body ?? $todo));
    check($send([])['status'] === 403, 'a write with no token is a 403');
    check($send(['X-CSRF-Token: ' . $session['sam']['csrf']])['status'] === 403, 'with another session\'s token');
    check($send(['X-CSRF-Token: ' . substr($session['alex']['csrf'], 0, 63) . 'x'])['status'] === 403, 'with a token off by one character');
    check($send(['X-CSRF-Token: ' . $session['alex']['csrf'], 'Sec-Fetch-Site: cross-site'])['status'] === 403, 'with the right token from another site');
    check($send(['X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: https://evil.example'])['status'] === 403, 'with the right token and another origin');
    check(count(sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex)))['tasks']) === 0, 'and none of them wrote anything');
    $ok = $send(['X-CSRF-Token: ' . $session['alex']['csrf'], 'Origin: ' . $origin]);
    $written = sl_json($ok);
    check($ok['status'] === 200 && count($written['tasks'] ?? []) === 1 && ($written['tasks'][0]['createdBy'] ?? '') === 'alex' && ($written['tasks'][0]['title'] ?? '') === 'Written through the shared sign-in', 'the session\'s token from this origin writes, as alex');
    check(count(sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($web('sam'))))['tasks']) === 1, 'and the other person sees it (one shared store)');
    $theme = $send(['X-CSRF-Token: ' . $session['alex']['csrf']], ['action' => 'setTheme', 'theme' => 'sage']);
    check($theme['status'] === 200 && sl_json($theme) === ['theme' => 'sage'], 'the theme is saved');
    check(is_file($accounts . '/prefs-alex.json') && !is_file($accounts . '/prefs-default.json') && !is_file($accounts . '/prefs-sam.json'), 'in alex\'s own preference file (the site\'s helpers see the shared account), not a nameless one');
    check((sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex)))['theme'] ?? '') === 'sage' && (sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($web('sam'))))['theme'] ?? '') === 'midnight', 'and read back for alex only');
    check(!isset($ok['headers']['set-cookie']) && !is_file($sb . '/accounts/attempts.enc') && !is_file($planner . '/attempts.enc'), 'no PHP session cookie and no sign-in ledger entry came of any of it');

    // ==== 5. On, no second door ====
    $pre = sl_http($scratch, 'GET', '/PlanMind/api.php', ['Cookie: PHPSESSID=' . $legacyId]);
    check($pre['status'] === 401, 'the legacy PHP session that opens the API on a legacy instance (part 1) opens nothing here');
    $pre = sl_http($scratch, 'GET', '/PlanMind/', ['Cookie: PHPSESSID=' . $legacyId]);
    check($pre['status'] === 303 && $pre['location'] === '/account/?next=%2FPlanMind%2F', 'nor the page');
    check(sl_http($scratch, 'POST', '/PlanMind/api.php', [...SL_JSON, 'Cookie: PHPSESSID=' . $legacyId, 'X-CSRF-Token: ' . $legacyCsrf], json_encode(['action' => 'savePrefs']))['status'] === 401, 'nor a write with that session\'s own token');
    $scoped = $session['alex-calmind']['token'];
    foreach ([
        'a scoped (CalMind) token as the bearer' => ['Authorization: Bearer ' . $scoped],
        'a scoped token as the cookie' => ['Cookie: MSSESS=' . $scoped],
        'a full account token as a bearer' => ['Authorization: Bearer ' . $session['alex']['token']],
        'the right cookie with any Authorization header beside it' => [...sl_cookie($alex), 'Authorization: Bearer ' . str_repeat('0', 64)],
        'the right cookie with a Basic Authorization header' => [...sl_cookie($alex), 'Authorization: Basic YTpi'],
    ] as $why => $headers) {
        $p = sl_http($scratch, 'GET', '/PlanMind/', $headers);
        check($p['status'] === 303 && $p['location'] === '/account/?next=%2FPlanMind%2F', "$why: the page sends to sign in");
        $a = sl_http($scratch, 'GET', '/PlanMind/api.php', $headers);
        check($a['status'] === 401 && !str_contains($a['body'], '"user"'), "$why: the API answers 401");
        $w = sl_http($scratch, 'POST', '/PlanMind/api.php', [...SL_JSON, ...$headers, 'X-CSRF-Token: ' . $session['alex-calmind']['csrf']], json_encode($todo));
        check($w['status'] === 401, "$why: a write answers 401");
    }
    check(count(sl_json(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex)))['tasks']) === 1, 'none of those wrote anything');
    // The page takes only reads: the sign-in form, the legacy sign-out and everything else posted to it are refused, and the session stays.
    $form = ['Content-Type: application/x-www-form-urlencoded', ...sl_cookie($alex)];
    foreach ([['action' => 'logout'], ['username' => 'alex', 'password' => 'legacy-secret'], ['username' => 'alex', 'password' => 'alex-password-1']] as $n => $fields) {
        $r = sl_http($scratch, 'POST', '/PlanMind/', $form, http_build_query(['csrf' => $session['alex']['csrf']] + $fields));
        check($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD' && !str_contains($r['body'], 'id="app"') && !isset($r['headers']['set-cookie']), "a post to the page ($n) is a 405: sign in and out at the account page");
    }
    check(sl_http($scratch, 'POST', '/PlanMind/', $form, http_build_query(['action' => 'logout']))['status'] === 403, 'a post without the token never gets that far (the gate\'s 403)');
    check(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex))['status'] === 200, 'and alex is still signed in');
    $inside = sl_http($scratch, 'GET', '/PlanMind/direct.php?session=1', sl_cookie($alex));
    check($inside['body'] === json_encode([false, ['auth' => true, 'user' => 'alex', 'csrf' => $session['alex']['csrf']]]), 'in shared mode no PHP session is active: the request\'s signed-in state is a plain array built from the gate\'s answer (alex and the shared session\'s token): ' . $inside['body']);
    $direct = sl_http($scratch, 'GET', '/PlanMind/direct.php', sl_cookie($alex));
    check($direct['body'] === 'refused 403 forbidden', 'and pm_login() itself refuses to check a password: ' . $direct['body']);
    check(!is_file($planner . '/attempts.enc'), 'the app\'s password limiter was never reached');
    // A session the account page signed out is gone: revoke it in the store the way /account/ does, then ask again.
    file_put_contents($sb . '/revoke.php', '<?php [, $lib, $dir, $token] = $argv; require $lib . "/mindsuite-auth.php"; $cfg = msa_config("prod", "disposable-site-auth-fixture", $dir . "/protected"); $s = msa_session($cfg, ["REMOTE_ADDR" => "203.0.113.1"], ["MSSESS" => $token]); msa_revoke($cfg, $s); echo "revoked";');
    $spare = json_decode((string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), '-r', 'require $argv[1] . "/mindsuite-auth.php"; $c = msa_config("prod", "disposable-site-auth-fixture", $argv[2] . "/protected"); echo json_encode(msa_login($c, "alex", "alex-password-1", "spare", "203.0.113.2"));', $lib, $accounts])) . ' 2>&1'), true);
    check(is_array($spare) && isset($spare['token']), 'a spare session for alex');
    check(sl_http($scratch, 'GET', '/PlanMind/api.php', ['Cookie: MSSESS=' . $spare['token']])['status'] === 200, 'the spare session opens the API');
    check(trim((string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags(), $sb . '/revoke.php', $lib, $accounts, $spare['token']])) . ' 2>&1')) === 'revoked', 'and is revoked (what Sign out at the account page does)');
    check(sl_http($scratch, 'GET', '/PlanMind/api.php', ['Cookie: MSSESS=' . $spare['token']])['status'] === 401 && sl_http($scratch, 'GET', '/PlanMind/', ['Cookie: MSSESS=' . $spare['token']])['status'] === 303, 'a revoked session opens neither the API nor the page');

    // ==== 6. On, but it cannot work: fail closed, never legacy ====
    $store = $accounts . '/protected/mindsuite-auth/auth.json';
    $kept = (string)file_get_contents($store);
    file_put_contents($store, 'not a store');
    foreach (['page' => '/PlanMind/', 'API' => '/PlanMind/api.php'] as $what => $path) {
        $r = sl_http($scratch, 'GET', $path, sl_cookie($alex));
        check($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.' && !isset($r['headers']['set-cookie']), "an unreadable shared store: the $what answers 503 and says nothing else");
        check(sl_http($scratch, 'POST', $path, [...SL_JSON, ...sl_cookie($alex), 'X-CSRF-Token: ' . $session['alex']['csrf']], json_encode($todo))['status'] === 503, "and a write to the $what too");
    }
    check(!str_contains(sl_http($scratch, 'GET', '/PlanMind/', sl_cookie($alex))['body'], 'name="password"'), 'with no sign-in form of ours to fall back to');
    file_put_contents($store, $kept);
    check(sl_http($scratch, 'GET', '/PlanMind/api.php', sl_cookie($alex))['status'] === 200, 'the store put back, alex is in again');
    $configure(array_replace($on, ['mindsuite_auth_keys' => []]));                 // switched on, but no key for the instance: the real config path
    foreach (['page' => '/PlanMind/', 'API' => '/PlanMind/api.php'] as $what => $path) {
        $r = sl_http($plain, 'GET', $path);
        check($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.', "switched on with no key: the $what answers 503, even to a visitor with no session (got {$r['status']}: " . substr($r['body'], 0, 200) . ')');
    }
    check(!str_contains(sl_http($plain, 'GET', '/PlanMind/')['body'], 'name="password"'), 'and shows no password form');
    $configure($on, null);                                           // the two people are not configured: the seam answers first, before the gate
    foreach ([$plain, $scratch] as $port) {
        $r = sl_http($port, 'GET', '/PlanMind/');
        check($r['status'] === 503 && $r['body'] === 'PlanMind is temporarily unavailable.' && $r['location'] === null, 'no people configured: the page is a 503, not a redirect to sign in');
        $r = sl_http($port, 'GET', '/PlanMind/api.php', SL_JSON);
        check($r['status'] === 503 && (sl_json($r)['code'] ?? '') === 'unavailable', 'and so is the API');
        check(sl_http($port, 'GET', '/PlanMind/api.php?health=1')['body'] === '{"peopleConfigured":false}', 'the health answer says so');
    }
    $configure($on);
    // Whatever the run logged on purpose, no process died with a diagnostic of its own.
    foreach (['plain', 'scratch'] as $name) { check(!preg_match('~Fatal error|Uncaught|Stack trace~', (string)@file_get_contents($sb . "/$name-errors.log") . (string)@file_get_contents($sb . "/$name-server.log")), "the $name server logged no fatal error"); }
} finally {
    sl_stop($servers);
}
