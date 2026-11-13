<?php
declare(strict_types=1);
// The gate, end to end: the real public/TaskMind/api.php and the real lib/bootstrap.php run in a child PHP process against a stub of the
// site's account library (a fake session naming the signed-in account) and a disposable data directory. Every request must authorize on
// its own: signed out is 401, an account that is not on the team is 403, a member gets {ok, me, role}, and removing someone or breaking
// the workspace takes effect on the very next request.

$site = harness_dir() . '/site';
mkdir($site);
// The part of the site's lib/auth.php that bootstrap.php and api.php call. GATE_USER stands for the session's signed-in account.
file_put_contents($site . '/auth.php', <<<'PHP'
<?php
function session_boot(): void { $_SESSION = (string)getenv('GATE_USER') === '' ? [] : ['auth' => true, 'user' => getenv('GATE_USER'), 'csrf' => str_repeat('c', 64)]; }
function current_user(): ?string { return $_SESSION['user'] ?? null; }
function app_config(): array { return ['users' => ['alex' => 'x', 'sam' => 'x', 'max' => 'x', 'val' => 'x', 'outsider' => 'x'], 'timezone' => 'America/Chicago', 'taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam']; }
function theme_get(): string { return 'sage'; }
function auth_password_for(array $config, string $user): ?string { return null; }
PHP);
/** php-cgi: the one PHP that reports the headers a script sets (the CLI does not), found next to this PHP or named by PHP_CGI. */
$cgi = getenv('PHP_CGI') ?: dirname(PHP_BINARY) . '/php-cgi';
check(is_executable($cgi), "php-cgi is needed to see response headers (found next to php, or set PHP_CGI); looked for $cgi");
/** One request: [status, decoded body, headers as name => value]. */
$childLog = '';
$request = function (string $dir, string $method, string $user, array $options = [], string $payload = '') use ($cgi, $site, &$childLog): array {
    $api = realpath(__DIR__ . '/../../public/TaskMind/api.php');
    $env = $options + ['CONTENT_LENGTH' => (string)strlen($payload), 'PATH' => (string)getenv('PATH'), 'REDIRECT_STATUS' => '1', 'GATEWAY_INTERFACE' => 'CGI/1.1', 'SCRIPT_FILENAME' => $api, 'SCRIPT_NAME' => '/TaskMind/api.php',
        'REQUEST_METHOD' => $method, 'HTTP_HOST' => '127.0.0.1:8870', 'REMOTE_ADDR' => '127.0.0.1', 'TASKMIND_LIB_DIR' => realpath(__DIR__ . '/../../lib'),
        'TASKMIND_SITE_LIB' => $site, 'TASKMIND_DATA_DIR' => $dir, 'GATE_USER' => $user];
    $p = proc_open([$cgi, ...harness_php_flags(), '-f', $api], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    check(is_resource($p), 'child started');
    if ($payload !== '') { fwrite($pipes[0], $payload); }
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $log = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]); proc_close($p);
    $childLog .= $log;
    [$head, $body] = explode("\r\n\r\n", $out, 2) + [1 => ''];
    $status = 200; $headers = [];
    foreach (explode("\r\n", $head) as $line) {
        [$k, $v] = explode(': ', $line, 2) + [1 => ''];
        if (strtolower($k) === 'status') { $status = (int)$v; } else { $headers[strtolower($k)] = $v; }
    }
    check($body !== '' && is_array(json_decode($body, true)), "api.php answered no JSON ($status): $out $log");
    return [$status, json_decode($body, true), $headers];
};

[$store, $dir] = harness_store();
// ---- 1. A fresh install: the seed team (Alex owner, Sam admin) is written on first use and is the team ----
[$s, $b, $h] = $request($dir, 'GET', '');
check($s === 401 && $b['code'] === 'unauthorized', "signed out: 401, got $s");
check(str_contains($h['cache-control'] ?? '', 'no-store') && ($h['x-content-type-options'] ?? '') === 'nosniff', 'the refusal is never cached');
check(!isset($b['csrf']) && !isset($b['me']), 'and tells a stranger nothing');
[$s, $b] = $request($dir, 'GET', 'alex');
check($s === 200 && $b['ok'] === true && $b['me'] === 'alex' && $b['role'] === 'owner', 'Alex is the owner');
check(array_keys($b) === ['ok', 'me', 'role', 'name', 'csrf', 'theme'] && $b['theme'] === 'sage' && strlen($b['csrf']) === 64, 'the reply is the Session and nothing more');
[$s, $b] = $request($dir, 'GET', 'sam');
check($s === 200 && $b['role'] === 'admin', 'Sam is an admin');
[$s, $b] = $request($dir, 'GET', 'outsider');
check($s === 403 && $b['code'] === 'forbidden', "an account that is not on the team: 403, got $s");
check(!isset($b['csrf']) && !isset($b['role']), 'and gets nothing about the team');
[$s, $b] = $request($dir, 'GET', 'ghost');
check($s === 403 && $b['code'] === 'forbidden', 'a session whose account no longer exists: 403');
check($store->transaction('workspace', fn($db) => $db) === harness_workspace(harness_member('alex', 'owner'), harness_member('sam', 'admin')), 'the first request wrote the seed team, once');

// ---- 2. A stored team is the team, and a change takes effect on the next request ----
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'member', 'Max Q'), harness_member('val', 'viewer')));
[$s, $b] = $request($dir, 'GET', 'max');
check($s === 200 && $b['role'] === 'member' && $b['name'] === 'Max Q', 'a member, with the name they were given');
[$s, $b] = $request($dir, 'GET', 'val');
check($s === 200 && $b['role'] === 'viewer', 'a viewer may open it');
[$s] = $request($dir, 'GET', 'sam');
check($s === 403, 'Sam is not on this stored team');
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner')));
[$s] = $request($dir, 'GET', 'max');
check($s === 403, 'a removed member is refused on their very next request');

// ---- 3. Other methods: authorized first, then refused ----
foreach (['PUT', 'DELETE'] as $method) {
    [$s, $b, $h] = $request($dir, $method, 'alex');
    check($s === 405 && $b['code'] === 'method_not_allowed' && ($h['allow'] ?? '') === 'GET, POST', "$method by a member: 405 and Allow: GET, POST");
    [$s] = $request($dir, $method, '');
    check($s === 401, "$method signed out: 401, not 405 (nothing is said to a stranger)");
    [$s] = $request($dir, $method, 'outsider');
    check($s === 403, "$method by a non-member: 403");
}

// A real CGI body exercises content type, origin, caps and the same site-account gate as GET.
$cfg = ['CONTENT_TYPE' => 'application/json', 'HTTP_X_CSRF_TOKEN' => str_repeat('c', 64)];
$query = ['QUERY_STRING' => 'view=workspace'];
$payload = '{"op":"project.add","base":1,"requestId":"gate-fixture","data":{"name":"Fixture"}}';
[$s, $b] = $request($dir, 'GET', 'alex', $query);
check($s === 200 && $b['state']['rev'] === 1, 'the authorized workspace read gets the initial snapshot');
[$s, $b] = $request($dir, 'POST', 'alex', [], $payload);
check($s === 403 && $b['code'] === 'csrf', 'the mutation requires CSRF');
[$s, $b] = $request($dir, 'POST', 'alex', ['HTTP_ORIGIN' => 'https://unrelated.example'] + $cfg, $payload);
check($s === 403 && $b['code'] === 'csrf', 'a foreign origin cannot submit a mutation with the token');
[$s, $b] = $request($dir, 'POST', 'alex', ['CONTENT_TYPE' => 'text/plain'] + $cfg, $payload);
check($s === 415 && $b['code'] === 'unsupported_media', 'the wire format is JSON');
[$s, $b] = $request($dir, 'POST', 'alex', $cfg, str_repeat(' ', TaskMind\LIMITS['requestBytesMax'] + 1));
check($s === 413 && $b['code'] === 'payload_too_large', 'the endpoint bounds its input');
[$s, $b] = $request($dir, 'POST', 'alex', $cfg, '{"op":"project.add","data":[]}');
check($s === 400 && $b['code'] === 'invalid', 'a list cannot substitute for the data object');
[$s] = $request($dir, 'POST', '', $cfg, $payload);
check($s === 401, 'the mutation refuses someone signed out');
[$s] = $request($dir, 'POST', 'outsider', $cfg, $payload);
check($s === 403, 'a configured account does not confer mutation access');
[$s, $b, $h] = $request($dir, 'POST', 'alex', $cfg, $payload);
check($s === 200 && $b['state']['projects'][0]['id'] === $b['id'] && str_contains($h['cache-control'], 'no-store'), 'a JSON write returns authoritative uncached state');
[$s, $b] = $request($dir, 'GET', 'alex', ['QUERY_STRING' => 'view=workspace&since=1']);
check($s === 200 && $b['delta']['full'] === false && $b['delta']['projects'][0]['name'] === 'Fixture', 'the delta carries the committed project');
[$s, $b] = $request($dir, 'GET', 'alex', ['QUERY_STRING' => 'view=workspace&since%5B%5D=1']);
check($s === 400 && $b['code'] === 'invalid', 'a malformed cursor is refused');

// ---- 4. A workspace that cannot be read admits nobody, and tells only the seed owner ----
$childLog = '';
file_put_contents($dir . '/workspace.enc', 'TM1:garbage');
[$s, $b] = $request($dir, 'GET', 'alex');
check($s === 503 && $b['code'] === 'unavailable' && str_contains($b['error'], 'workspace'), "the seed owner is told: 503, got $s");
check(!str_contains(json_encode($b), $dir) && !str_contains(json_encode($b), 'garbage'), 'without a path or bytes');
foreach (['sam', 'outsider'] as $who) { [$s] = $request($dir, 'GET', $who); check($s === 403, "$who is not told anything: 403"); }
check(str_contains($childLog, 'TaskMind workspace unreadable') && !str_contains($childLog, 'garbage'), 'the cause is in the server log, without the bytes');

// ---- 5. An empty workspace file, or one lost after it existed, is never a fresh install ----
foreach (['empty' => fn() => file_put_contents($dir . '/workspace.enc', ''), 'lost' => fn() => unlink($dir . '/workspace.enc')] as $what => $break) {
    $break();
    [$s, $b] = $request($dir, 'GET', 'alex');
    check($s === 503 && $b['code'] === 'unavailable', "$what: the seed owner is told, 503, got $s");
    [$s] = $request($dir, 'GET', 'sam');
    check($s === 403, "$what: the seed admin is not let in on a seed team");
    check(!str_contains($childLog, 'created on first use'), "$what: nothing was seeded");
}
check(!file_exists($dir . '/workspace.enc'), 'the lost file stays lost');
