<?php
/**
 * Public accounts (lib/public-accounts.php) over real HTTP: `php server/tools/public-accounts-test.php`.
 * Two servers on scratch dirs: one with public accounts OFF (proves nothing changes), one ON over the database driver.
 */

$root = dirname(__DIR__);
date_default_timezone_set('America/Chicago');
require_once $root . '/lib/records.php';
if (!defined('SYNC_SPACES')) { define('SYNC_SPACES', ['chef']); }

$servers = [];
$scratchDirs = [];
register_shutdown_function(function () use (&$servers, &$scratchDirs) {
    foreach ($servers as $p) { if (is_resource($p)) { proc_terminate($p); proc_close($p); } }
    foreach ($scratchDirs as $d) { exec('rm -rf ' . escapeshellarg($d)); }
});

/** A php -S on a fresh data dir with $env; returns [port, data dir]. */
function boot(array $env): array
{
    global $root, $servers, $scratchDirs;
    $dir = sys_get_temp_dir() . '/calmind-public-test-' . getmypid() . '-' . count($servers);
    @mkdir($dir, 0700, true);
    $scratchDirs[] = $dir;
    $sock = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) explode(':', stream_socket_get_name($sock, false))[1];
    fclose($sock);
    $servers[] = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $root . '/public'],
        [1 => ['file', '/dev/null', 'w'], 2 => ['file', $dir . '/server.log', 'w']], $pipes, null,
        array_merge(getenv(), ['CALMIND_DATA_DIR' => $dir], $env));
    for ($i = 0; $i < 100; $i++) { $c = @fsockopen('127.0.0.1', $port, $x, $y, 0.2); if ($c) { fclose($c); break; } usleep(100000); }
    return [$port, $dir];
}

function call(int $port, array $body, string $token = ''): array
{
    $hdr = "Content-Type: application/json\r\n" . ($token !== '' ? "Authorization: Bearer $token\r\n" : '');
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => $hdr, 'content' => json_encode($body), 'ignore_errors' => true]]);
    $raw = (string) @file_get_contents("http://127.0.0.1:$port/api/index.php", false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) { if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) { $status = (int) $m[1]; } }
    $data = json_decode($raw, true);
    if (!is_array($data)) { throw new RuntimeException("non-JSON reply ($status): " . substr($raw, 0, 300)); }
    return ['status' => $status, 'body' => $data];
}

$pass = 0; $fail = 0;
function t(string $label, callable $fn): void
{
    global $pass, $fail;
    try { $fn(); $pass++; echo "  \033[32m✓\033[0m $label\n"; }
    catch (Throwable $e) { $fail++; echo "  \033[31m✗ $label — {$e->getMessage()}\033[0m\n"; }
}
function ok($cond, string $why): void { if (!$cond) { throw new RuntimeException($why); } }
function eq($want, $got, string $why = ''): void
{
    if ($want !== $got) { throw new RuntimeException("$why: wanted " . json_encode($want) . ', got ' . json_encode($got)); }
}
$rec = fn(string $id, $payload = ['t' => 'x'], string $type = 'note', int $updated = 1000) =>
    ['id' => $id, 'type' => $type, 'updated' => $updated, 'payload' => $payload];

echo "\n\033[1moff\033[0m\n";
[$offPort, $offDir] = boot(['CALMIND_PUBLIC_ACCOUNTS' => '0']);
t('off: public credentials are refused without opening a database or falling through to household sign-up', function () use ($offPort, $offDir) {
    $fields = ['username' => 'max', 'email' => 'max@example.com', 'password' => 'maxpassword'];
    ok(!isset(call($offPort, ['action' => 'signin_info'])['body']['public_accounts']), 'off is not advertised');
    eq(403, call($offPort, ['action' => 'public_signup'] + $fields)['status'], 'public sign-up');
    eq(403, call($offPort, ['action' => 'signup', 'public' => true] + $fields)['status'], 'earlier public sign-up');
    eq(403, call($offPort, ['action' => 'public_login'] + $fields)['status'], 'public sign-in');
    eq(200, call($offPort, ['action' => 'signup'] + $fields)['status'], 'household name remains free');
    ok(!is_file($offDir . '/records.sqlite'), 'no database was opened');
});

echo "\n\033[1mon\033[0m\n";
[$port, $dir] = boot(['CALMIND_PUBLIC_ACCOUNTS' => '1', 'CALMIND_STORAGE' => 'sql']);
$cfg = ['data_dir' => $dir, 'storage' => 'sql'];
$reset = fn() => array_map('unlink', glob($dir . '/{abuse,caps}-pa-*.json', GLOB_BRACE) ?: []);
$tok = '';

t('a household account still signs up and syncs beside them', function () use ($port, $rec) {
    $h = call($port, ['action' => 'signup', 'username' => 'sam', 'email' => 'sam@example.com', 'password' => 'sampassword']);
    eq(200, $h['status'], 'household sign-up');
    eq(401, call($port, ['action' => 'public_login', 'username' => 'sam', 'password' => 'sampassword'])['status'], 'public form cannot sign into a household account');
    eq(200, call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => [$rec('h1')]], $h['body']['token'])['status'], 'household sync');
});

t('public sign-up: a token, whoami says public, sync lands in the database in both spaces', function () use ($port, $cfg, $rec, &$tok) {
    foreach (['', 'chef'] as $space) {
        eq(true, call($port, ['action' => 'signin_info', 'space' => $space])['body']['public_accounts'] ?? null, 'public forms are advertised in both spaces');
    }
    $r = call($port, ['action' => 'public_signup', 'space' => 'chef', 'username' => 'Ana', 'email' => 'ana@example.com', 'password' => 'anapassword']);
    eq(200, $r['status'], 'sign-up');
    eq(['ana', true], [$r['body']['username'], $r['body']['public']], 'canonical name, public');
    $tok = $r['body']['token'];
    eq(['ana', true], [call($port, ['action' => 'whoami'], $tok)['body']['username'], call($port, ['action' => 'whoami'], $tok)['body']['public'] ?? null], 'whoami');
    eq(200, call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => [$rec('n1')]], $tok)['status'], 'calmind sync');
    eq(200, call($port, ['action' => 'sync', 'space' => 'chef', 'cursor' => 0, 'changes' => [$rec('soup')]], $tok)['status'], 'chef sync');
    eq(['n1'], array_keys(rs_view($cfg, 'ana', '')->all()), 'calmind store');
    eq(['soup'], array_keys(rs_view($cfg, 'ana', 'chef')->all()), 'chef store');
});

t('names: taken anywhere, reserved, or badly formed are refused; a race is decided by the key', function () use ($port, $reset) {
    $reset();
    $try = fn($u, $p = 'longenough') => call($port, ['action' => 'signup', 'public' => true, 'username' => $u, 'email' => 'x@example.com', 'password' => $p])['status'];
    eq(409, $try('sam'), 'a household name');
    eq(409, $try('ANA'), 'an existing public name, any case');
    eq(400, $try('chef-ana'), 'a name that would collide with a space store');
    eq(400, $try('a'), 'too short');
    eq(400, $try('fine', 'short'), 'password under 8');
});

t('sign-up caps: the sixth from one address in an hour is refused', function () use ($port, $reset) {
    $reset();
    $codes = [];
    for ($i = 0; $i < 6; $i++) {
        $codes[] = call($port, ['action' => 'signup', 'public' => true, 'username' => "cap$i", 'email' => 'c@example.com', 'password' => 'cappassword'])['status'];
    }
    eq([200, 200, 200, 200, 200, 429], $codes, 'five, then refused');
    $reset();
});

t('login: right, wrong, and locked after ten failures — locked answers the same for the right password', function () use ($port) {
    $public = ['action' => 'public_login', 'username' => 'ana'];
    eq(true, call($port, $public + ['password' => 'anapassword'])['body']['public'] ?? null, 'right');
    eq(401, call($port, $public + ['password' => 'nope'])['status'], 'wrong');
    $s = call($port, ['action' => 'signup', 'public' => true, 'username' => 'locky', 'email' => 'l@example.com', 'password' => 'lockypass']);
    for ($i = 0; $i < 10; $i++) { call($port, ['action' => 'login', 'username' => 'locky', 'password' => 'bad']); }
    eq(429, call($port, ['action' => 'login', 'username' => 'locky', 'password' => 'bad'])['status'], 'locked, wrong');
    eq(429, call($port, ['action' => 'login', 'username' => 'locky', 'password' => 'lockypass'])['status'], 'locked, right');
    eq(200, call($port, ['action' => 'whoami'], $s['body']['token'])['status'], 'an existing token is untouched by the lock');
});

t('change password: the old one is checked, other devices are signed out, this one stays', function () use ($port) {
    $a = call($port, ['action' => 'login', 'username' => 'ana', 'password' => 'anapassword'])['body']['token'];
    $b = call($port, ['action' => 'login', 'username' => 'ana', 'password' => 'anapassword'])['body']['token'];
    eq(403, call($port, ['action' => 'change_password', 'old' => 'wrong', 'new' => 'newanapass'], $a)['status'], 'wrong old');
    eq(200, call($port, ['action' => 'change_password', 'old' => 'anapassword', 'new' => 'newanapass'], $a)['status'], 'changed');
    eq(200, call($port, ['action' => 'whoami'], $a)['status'], 'this device');
    eq(401, call($port, ['action' => 'whoami'], $b)['status'], 'the other device');
    eq(200, call($port, ['action' => 'login', 'username' => 'ana', 'password' => 'newanapass'])['status'], 'the new password');
});

t('what is not built yet answers 501 for a public account, never a household path', function () use ($port, &$tok) {
    $tok = call($port, ['action' => 'login', 'username' => 'ana', 'password' => 'newanapass'])['body']['token'];
    foreach (['passkey_list', 'passkey_register_begin', 'meetreq_mail'] as $a) {
        eq(501, call($port, ['action' => $a], $tok)['status'], $a);
    }
});

t('sharing works between a public account and a household one, by name, both ways mutual', function () use ($port, $rec, &$tok) {
    $house = call($port, ['action' => 'login', 'username' => 'sam', 'password' => 'sampassword'])['body']['token'];
    $share = fn($partner) => $rec('share', ['partners' => [$partner], 'calendars' => [], 'folders' => ['f1'], 'notefolders' => []], 'share', 2000);
    call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => [$share('sam'), $rec('f1', ['name' => 'Groceries'], 'folder')]], $tok);
    call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => [$share('ana')]], $house);
    $pull = call($port, ['action' => 'shared_pull'], $house);
    eq('ana', $pull['body']['partner'] ?? null, 'the household side sees the public partner');
    ok(in_array('f1', array_column($pull['body']['records'], 'id'), true), 'and the shared folder');
});

t('recipe import: an account is held to an hour of PA_FETCH_HOUR fetches', function () use ($port, $dir) {
    $t = call($port, ['action' => 'signup', 'public' => true, 'username' => 'otto', 'email' => 'otto@example.com', 'password' => 'ottopassword'])['body']['token'];
    // A private address is refused before any network, after the limiter: 400 until the hour is spent, then 429.
    $codes = [];
    for ($i = 0; $i < 61; $i++) { $codes[] = call($port, ['action' => 'recipe_fetch', 'url' => 'http://127.0.0.1/'], $t)['status']; }
    eq([400, 429], [$codes[0], $codes[60]], 'the first is judged, the sixty-first is not');
    eq(60, count(array_filter($codes, fn($c) => $c === 400)), 'sixty judged');
});

t('delete: tokens dead, every space gone, partners scrubbed, the name free and empty', function () use ($port, $cfg, $rec, &$tok) {
    eq(200, call($port, ['action' => 'delete_account'], $tok)['status'], 'deleted');
    eq(401, call($port, ['action' => 'whoami'], $tok)['status'], 'token dead');
    eq(401, call($port, ['action' => 'login', 'username' => 'ana', 'password' => 'newanapass'])['status'], 'no sign-in');
    eq([null, null], [rs_export($cfg, 'ana', ''), rs_export($cfg, 'ana', 'chef')], 'both spaces');
    eq([], rs_view($cfg, 'sam', '')->get('share')['payload']['partners'], "the household account's share no longer names it");
    $again = call($port, ['action' => 'signup', 'public' => true, 'username' => 'ana', 'email' => 'ana2@example.com', 'password' => 'secondana']);
    eq(200, $again['status'], 'the name can be taken again');
    eq([], call($port, ['action' => 'sync', 'cursor' => 0, 'changes' => []], $again['body']['token'])['body']['changes'], '…and starts empty');
});

echo "\n────────────────────────────────\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
