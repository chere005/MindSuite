<?php
declare(strict_types=1);
// The two people (server/lib/people.php). Code speaks in roles; which account holds each role comes only from the private config
// (`people`). Missing or invalid, the planner fails closed: every planner call is a 503 `unavailable` before anything is written, the
// store keeps its bytes and its mtime, and the public health answer says so without naming anyone.
require_once __DIR__ . '/../../lib/staging.php';
use function PlanMind\{allowed, fresh_db, mutate, pm_both_owners, pm_people, pm_people_configured, pm_people_use, pm_person_lists, pm_role_of, snapshot, staging_hashes};

$people = harness_people();
[$owner, $partner] = [$people['owner'], $people['partner']];

// ---- 1. The seam: roles to accounts, from the config only ----
check(pm_people_configured() && pm_people() === ['owner' => $owner, 'partner' => $partner], 'the harness names the two people, as a config would');
check(pm_person_lists() === [$partner, $owner], 'the person lists are the partner\'s, then the owner\'s (list order 0 and 1)');
$pair = [$owner, $partner];
sort($pair, SORT_STRING);
check(pm_both_owners() === $pair, 'a linked item belongs to the two ids, sorted');
check(pm_role_of($owner) === 'owner' && pm_role_of($partner) === 'partner' && pm_role_of('both') === null && pm_role_of(HARNESS_CUSTOM) === null && pm_role_of(null) === null, 'each account has its role; nothing else has one');
check(PlanMind\MODEL['personRoles'] === ['partner', 'owner'] && PlanMind\MODEL['defaultColorsByRole'] === [['owner', 'green'], ['partner', 'yellow'], ['both', 'purple']], 'the generated model holds roles');
foreach ($people as $id) { check(!str_contains(json_encode(PlanMind\MODEL + PlanMind\LIMITS), json_encode($id)), 'and never an account'); }
$fresh = fresh_db('2026-10-30T12:00:00+00:00');
check(array_keys($fresh['lists']) === [$partner, $owner] && $fresh['lists'][$partner]['name'] === ucfirst($partner) && $fresh['lists'][$owner]['color'] === 'green' && $fresh['lists'][$partner]['color'] === 'yellow',
    'a fresh store keys the permanent lists by the configured accounts, named by their ids and colored by their roles');
check($fresh['rhythm']['updatedBy'] === $owner && count(array_filter($fresh['chores'], fn($r) => $r['owners'] === $pair)) === 1, 'the seeded chart is signed by the owner, and one rule is for both');

// The same code with other accounts: nothing depends on which ids the household uses. These swap the two roles of the harness
// accounts, so a role taken for a position in the pair or a list cannot pass in both blocks.
pm_people_use(['owner' => 'sam', 'partner' => 'alex']);
try {
    check(pm_person_lists() === ['alex', 'sam'] && pm_both_owners() === ['alex', 'sam'], 'placeholder accounts: list order by role, the pair sorted');
    $db = mutate(fresh_db(), ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(80), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['sam', 'alex'], 'title' => 'Shared'], 'alex');
    $view = snapshot($db, 'sam');
    check($view['tasks'][0]['owners'] === ['alex', 'sam'] && $view['tasks'][0]['createdBy'] === 'alex' && array_column($view['lists'], 'id') === ['alex', 'sam'], 'a linked to-do of the placeholder accounts is stored canonically and read by either');
    refuses(fn() => mutate($db, ['action' => 'saveList', 'id' => HARNESS_OTHER, 'name' => 'Alex', 'color' => 'blue', 'revision' => 0], 'sam'), 409, 'name_taken');
    refuses(fn() => snapshot($db, 'outsider'), 403, 'forbidden');
} finally {
    pm_people_use($people);
}

// ---- 2. people missing or invalid: 503 and the store untouched ----
[$store, $dir] = harness_store();
$store->transaction('tasks', fn($db) => harness_db());
$file = $dir . '/tasks.enc';
touch($file, time() - 3600);
clearstatcache();
[$bytes, $mtime] = [file_get_contents($file), filemtime($file)];
file_put_contents($dir . '/staging-users.json', json_encode([$owner => password_hash('x', PASSWORD_BCRYPT, ['cost' => 4])]));
$add = ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(90), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => [$owner], 'title' => 'Never saved'];
$invalid = [
    'no people in the config' => null, 'empty' => [], 'the owner only' => ['owner' => $owner], 'one account twice' => ['owner' => $owner, 'partner' => $owner],
    'not a login name' => ['owner' => 'Not A Login', 'partner' => $partner], 'role words' => ['owner' => 'owner', 'partner' => 'partner'],
    'a view name' => ['owner' => $owner, 'partner' => 'both'], 'not text' => ['owner' => 1, 'partner' => 2], 'an unknown key' => $people + ['other' => 'x'],
    'a list, not roles' => [$owner, $partner],
];
try {
    foreach ($invalid as $name => $config) {
        pm_people_use($config);
        check(!pm_people_configured(), "$name: not configured");
        refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, $add, $owner, '2026-10-30')), 503, 'unavailable');
        refuses(fn() => snapshot($store->transaction('tasks', fn($db) => $db), $owner), 503, 'unavailable');
        refuses(fn() => fresh_db(), 503, 'unavailable');
        refuses(fn() => allowed($owner, [$owner => true]), 503, 'unavailable');
        check(staging_hashes($dir, '-test') === [], "$name: nobody signs in from the staging file");
    }
} finally {
    pm_people_use($people);
}
clearstatcache();
check(file_get_contents($file) === $bytes && filemtime($file) === $mtime, 'people missing: 503 and store bytes+mtime unchanged');
check(str_contains(harness_log(true), 'PlanMind people config missing or invalid'), 'the cause goes to the error log');
check(count(snapshot($store->transaction('tasks', fn($db) => $db), $owner)['tasks']) === 2, 'with the people back the store reads as before');

// ---- 3. The real entry points, in a separate PHP process with a disposable copy of the site library ----
$source = getenv('PLANMIND_TEST_SITE_LIB') ?: '';
if ($source === '') {
    foreach ([dirname(__DIR__, 3) . '/../seancheren-site/lib', dirname(__DIR__, 3) . '/../../seancheren-site/lib'] as $candidate) {
        $source = $candidate;
        if (is_file($candidate . '/auth.php')) break;
    }
}
check(is_file($source . '/auth.php'), "the site library is needed (set PLANMIND_TEST_SITE_LIB=<seancheren-site>/lib); looked in $source");
$sandbox = harness_dir();
$site = $sandbox . '/lib';
mkdir($site); mkdir($sandbox . '/accounts', 0700); mkdir($sandbox . '/sessions', 0700);
foreach (scandir($source) ?: [] as $name) {
    // The live configuration never comes along: the copy gets a config of its own.
    if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file($source . '/' . $name)) { continue; }
    copy($source . '/' . $name, $site . '/' . $name);
}
$configure = function (?array $named) use ($site, $sandbox): void {
    $config = ['users' => [], 'data_dir' => $sandbox . '/accounts', 'data_key' => 'disposable-fixture-key', 'timezone' => 'America/Chicago', 'base' => ''] + ($named === null ? [] : ['people' => $named]);
    file_put_contents($site . '/config.php', '<?php return ' . var_export($config, true) . ';');
};
// Warnings show on stderr (which must stay empty); what the code logs on purpose goes to a file of the sandbox.
$flags = ['-d', 'display_errors=stderr', '-d', 'log_errors=1', '-d', 'error_log=' . $sandbox . '/errors.log', '-d', 'session.save_path=' . $sandbox . '/sessions'];
foreach (['openssl', 'mbstring'] as $extension) {
    $bare = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, '-r', "echo extension_loaded('$extension') ? 'yes' : 'no';"])));
    if ($bare !== 'yes') { array_push($flags, '-d', "extension=$extension"); }
}
$request = function (string $page, string $method, string $query = '') use ($flags, $site, $dir): string {
    $code = '[, $page, $method, $query] = $argv; $_SERVER = ["REQUEST_METHOD" => $method, "HTTP_HOST" => "127.0.0.1", "REMOTE_ADDR" => "127.0.0.1", '
        . '"CONTENT_TYPE" => "application/json", "HTTP_X_STATUS_PROBE" => "1"] + $_SERVER; parse_str($query, $_GET); require $page;';
    $env = ['PLANMIND_LIB_DIR' => realpath(__DIR__ . '/../../lib'), 'PLANMIND_SITE_LIB' => $site, 'PLANMIND_DATA_DIR' => $dir] + getenv();
    $process = proc_open([PHP_BINARY, ...$flags, '-r', $code, '--', realpath(__DIR__ . '/../../public/PlanMind/' . $page), $method, $query],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    check(is_resource($process), 'the request process started');
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    check(proc_close($process) === 0 && trim($err) === '', "$method $page?$query ran cleanly: $err");
    return $out;
};
$errorCode = fn(string $body) => json_decode($body, true)['code'] ?? null;

$configure(null);
check($request('api.php', 'GET', 'health=1') === '{"peopleConfigured":false}', 'health without people: false, and nothing else');
foreach (['GET', 'POST'] as $method) { check($errorCode($request('api.php', $method)) === 'unavailable', "api.php $method without people: 503 unavailable, before sign-in or the store"); }
check($errorCode($request('api.php', 'GET', 'calmind=1&from=2026-10-30&to=2026-10-31')) === 'unavailable', 'api.php CalMind events without people: unavailable');
check($request('index.php', 'GET') === 'PlanMind is temporarily unavailable.', 'the page without people: unavailable, no sign-in form');
$configure(['owner' => $owner]);
check($request('api.php', 'GET', 'health=1') === '{"peopleConfigured":false}' && $errorCode($request('api.php', 'POST')) === 'unavailable', 'an invalid people config is the same as none');
clearstatcache();
check(file_get_contents($file) === $bytes && filemtime($file) === $mtime, 'the store behind the entry points was not touched');
check(str_contains((string)file_get_contents($sandbox . '/errors.log'), 'PlanMind people config missing or invalid'), 'and each refusal logged its cause');

$configure(['owner' => 'alex', 'partner' => 'sam']);
check($request('api.php', 'GET', 'health=1') === '{"peopleConfigured":true}', 'health with people: true, naming nobody');
check($errorCode($request('api.php', 'GET')) === 'unauthorized', 'with people, an anonymous call is asked to sign in as before');
check(str_contains($request('index.php', 'GET'), 'name="password"'), 'and the page shows the sign-in form');
