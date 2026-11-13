<?php
declare(strict_types=1);
// CSRF and the session, end to end: the real public/TaskMind/index.php and api.php with the real lib/bootstrap.php run under php-cgi
// against a stub of the site's account library that keeps REAL PHP sessions (files in a disposable directory, a cookie carried from
// one request to the next). Proves: a write (sign-in, sign-out) without the session's CSRF token, with a wrong one, with another
// session's, or from another origin is refused and writes nothing; the session id rotates at sign-in and at sign-out, and the old id
// is no longer signed in; a member removed from the team is refused on the next request of the session they already hold.
use TaskMind\Store;

$root = harness_dir();
$site = $root . '/site'; $sessions = $root . '/sessions'; $data = $root . '/data';
foreach ([$site, $sessions, $data] as $made) { mkdir($made); }
// The parts of the site's lib/auth.php that bootstrap.php, index.php and api.php call, with a real session like the site's session_boot().
file_put_contents($site . '/auth.php', <<<'PHP'
<?php
function session_boot(): void {
    if (session_status() === PHP_SESSION_ACTIVE) { return; }
    session_name('TASKMIND_TEST');
    session_save_path((string)getenv('SESSION_DIR'));
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => false, 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
}
function current_user(): ?string { return $_SESSION['user'] ?? null; }
function app_config(): array { return ['users' => ['alex' => 'x', 'sam' => 'x', 'max' => 'x', 'outsider' => 'x'], 'taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam']; }
function theme_get(): string { return 'sage'; }
function auth_password_for(array $config, string $user): ?string { return (string)getenv('PW_HASH'); }
PHP);
$cgi = getenv('PHP_CGI') ?: dirname(PHP_BINARY) . '/php-cgi';
check(is_executable($cgi), "php-cgi is needed to see response headers (found next to php, or set PHP_CGI); looked for $cgi");
const SESSION_PASSWORD = 'session-case-only';
$hash = password_hash(SESSION_PASSWORD, PASSWORD_BCRYPT, ['cost' => 4]);

/**
 * One request to `$script` ('index.php' or 'api.php') carrying the session cookie `$sid` ('' for none) and, for a POST, the form
 * `$form`. Returns ['status', 'body', 'headers' (lower-cased name => list of values), 'sid' (the session id a Set-Cookie gave, or '')].
 */
$request = function (string $script, string $method, string $sid, array $form = [], array $extra = []) use ($cgi, $site, $sessions, $data, $hash): array {
    $file = realpath(__DIR__ . '/../../public/TaskMind/' . $script);
    $body = http_build_query($form);
    $env = ['PATH' => (string)getenv('PATH'), 'REDIRECT_STATUS' => '1', 'GATEWAY_INTERFACE' => 'CGI/1.1', 'SCRIPT_FILENAME' => $file, 'SCRIPT_NAME' => '/TaskMind/' . $script,
        'REQUEST_METHOD' => $method, 'HTTP_HOST' => '127.0.0.1:8870', 'REMOTE_ADDR' => '127.0.0.1', 'TASKMIND_LIB_DIR' => realpath(__DIR__ . '/../../lib'),
        'TASKMIND_SITE_LIB' => $site, 'TASKMIND_DATA_DIR' => $data, 'SESSION_DIR' => $sessions, 'PW_HASH' => $hash]
        + ($sid === '' ? [] : ['HTTP_COOKIE' => 'TASKMIND_TEST=' . $sid])
        + ($method === 'POST' ? ['CONTENT_TYPE' => 'application/x-www-form-urlencoded', 'CONTENT_LENGTH' => (string)strlen($body)] : []) + $extra;
    $p = proc_open([$cgi, ...harness_php_flags(), '-f', $file], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    check(is_resource($p), 'child started');
    fwrite($pipes[0], $body); fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $log = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]); proc_close($p);
    [$head, $text] = explode("\r\n\r\n", $out, 2) + [1 => ''];
    $status = 200; $headers = []; $newSid = '';
    foreach (explode("\r\n", $head) as $line) {
        [$k, $v] = explode(': ', $line, 2) + [1 => ''];
        $k = strtolower($k);
        if ($k === 'status') { $status = (int)$v; continue; }
        $headers[$k][] = $v;
        if ($k === 'set-cookie' && preg_match('/^TASKMIND_TEST=([^;]*)/', $v, $m) === 1) { $newSid = $m[1]; }
    }
    check(!str_contains($log, 'Fatal') && !str_contains($text, 'Fatal error'), "$method $script crashed: $out $log");
    return ['status' => $status, 'body' => $text, 'headers' => $headers, 'sid' => $newSid];
};
/** The CSRF token the sign-in form of `$page` carries. */
$formToken = function (array $page): string {
    check(preg_match('/name="csrf" value="([0-9a-f]{64})"/', $page['body'], $m) === 1, 'the sign-in form carries a token: ' . $page['body']);
    return $m[1];
};
/** Who api.php says `$sid` is: [status, me or null, csrf or null]. */
$who = function (string $sid) use ($request): array {
    $r = $request('api.php', 'GET', $sid);
    $b = json_decode($r['body'], true);
    return [$r['status'], $b['me'] ?? null, $b['csrf'] ?? null];
};
/** Every file under the data and session directories with a hash of its bytes: a refused write must leave this exactly as it was. */
$snapshot = function () use ($data, $sessions): array {
    $out = [];
    foreach ([$data, $sessions] as $d) { foreach (glob($d . '/{,.}[!.]*', GLOB_BRACE) ?: [] as $f) { $out[$f] = hash_file('sha256', $f); } }
    ksort($out);
    return $out;
};
$sessionFile = fn(string $sid) => $sessions . '/sess_' . $sid;

// ---- 1. Signing in needs the token of this very session ----
$page = $request('index.php', 'GET', '');
$a = $page['sid'];
check($page['status'] === 200 && $a !== '', 'a first visit gets a session');
$tokenA = $formToken($page);
$pageB = $request('index.php', 'GET', '');
$b = $pageB['sid']; $tokenB = $formToken($pageB);
check($b !== '' && $b !== $a && $tokenB !== $tokenA, 'another visitor has another session and another token');
$login = ['username' => 'alex', 'password' => SESSION_PASSWORD];
$refusals = [
    'no token' => [$login, []],
    'an empty token' => [$login + ['csrf' => ''], []],
    'a wrong token' => [$login + ['csrf' => str_repeat('0', 64)], []],
    'the token cut short' => [$login + ['csrf' => substr($tokenA, 0, 32)], []],
    "another session's token" => [$login + ['csrf' => $tokenB], []],
    'the right token from another origin' => [$login + ['csrf' => $tokenA], ['HTTP_ORIGIN' => 'https://evil.example']],
    'the right token, cross-site' => [$login + ['csrf' => $tokenA], ['HTTP_SEC_FETCH_SITE' => 'cross-site']],
];
foreach ($refusals as $what => [$form, $extra]) {
    $before = $snapshot();
    $r = $request('index.php', 'POST', $a, $form, $extra);
    check($r['status'] === 403, "sign-in with $what: 403, got {$r['status']}");
    check(!isset($r['headers']['location']), "sign-in with $what: not signed in and sent on");
    check($r['sid'] === '' || $r['sid'] === $a, "sign-in with $what: the session id is not changed");
    check($snapshot() === $before, "sign-in with $what: nothing is written (no session, no ledger, no workspace)");
    check($who($a)[0] === 401, "sign-in with $what: the session is still signed out");
}
check(!glob($data . '/*.enc'), 'none of the refused sign-ins reached the store');

// ---- 2. Signing in rotates the session id ----
$r = $request('index.php', 'POST', $a, $login + ['csrf' => $tokenA]);
check($r['status'] === 303 && ($r['headers']['location'][0] ?? '') === './', "sign-in with the right token: 303, got {$r['status']}");
$a2 = $r['sid'];
check($a2 !== '' && $a2 !== $a, 'signing in gives a new session id');
check(!is_file($sessionFile($a)), 'and the old session is gone');
[$s, $me] = $who($a);
check($s === 401 && $me === null, "the old id is not signed in: $s");
[$s, $me, $csrf2] = $who($a2);
check($s === 200 && $me === 'alex', "the new id is: $s");
check(is_string($csrf2) && $csrf2 !== $tokenA, 'and its CSRF token is new too');

// ---- 3. Signing out needs this session's token too ----
$logout = ['action' => 'logout'];
foreach (['no token' => $logout, 'a wrong token' => $logout + ['csrf' => str_repeat('f', 64)], 'the token from before sign-in' => $logout + ['csrf' => $tokenA],
    "another session's token" => $logout + ['csrf' => $tokenB]] as $what => $form) {
    $before = $snapshot();
    $r = $request('index.php', 'POST', $a2, $form);
    check($r['status'] === 403, "sign-out with $what: 403, got {$r['status']}");
    check($snapshot() === $before, "sign-out with $what: nothing is written");
    check($who($a2)[1] === 'alex', "sign-out with $what: still signed in");
}
// A forged sign-in with a token of B's session does not sign B in either.
check($who($b)[0] === 401, "B's session was never signed in");

// ---- 4. Signing out rotates the session id and ends the old one ----
$r = $request('index.php', 'POST', $a2, $logout + ['csrf' => $csrf2]);
check($r['status'] === 303, "sign-out with the right token: 303, got {$r['status']}");
$a3 = $r['sid'];
check($a3 !== '' && $a3 !== $a2, 'signing out gives a new session id');
check(!is_file($sessionFile($a2)), 'and the signed-in session is gone');
check($who($a2)[0] === 401, 'the signed-in id is no longer signed in');
check($who($a3)[0] === 401, 'nor is the new one');
// Strict mode: an id the server never issued is not adopted.
$r = $request('index.php', 'GET', 'forgedsessionid0123456789abcdefg');
check($r['sid'] !== '' && $r['sid'] !== 'forgedsessionid0123456789abcdefg', 'an unknown session id is replaced, never adopted');

// ---- 5. A member removed from the team is refused on the next request of the session they already hold ----
$store = new Store($data);
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'member')));
$page = $request('index.php', 'GET', '');
$r = $request('index.php', 'POST', $page['sid'], ['username' => 'max', 'password' => SESSION_PASSWORD, 'csrf' => $formToken($page)]);
$m = $r['sid'];
check($r['status'] === 303 && $m !== '', 'Max signs in');
[$s, $me] = $who($m);
check($s === 200 && $me === 'max', "Max's session opens TaskMind: $s");
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner')));
[$s, $me, $csrf] = $who($m);
check($s === 403 && $me === null && $csrf === null, "removed, the same session is refused on the next request: $s");
$r = $request('index.php', 'GET', $m);
check($r['status'] === 403 && str_contains($r['body'], 'members of its team') && !str_contains($r['body'], 'app.js'), 'and the page shows the sign-in form with the reason, no app');
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'viewer')));
[$s, $me] = $who($m);
check($s === 200 && $me === 'max', 'added back, the session works again: nothing was remembered in it');
