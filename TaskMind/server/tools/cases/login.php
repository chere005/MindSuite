<?php
declare(strict_types=1);
// The sign-in limiter. Sections 1 to 5: failures are counted per client address, where the client is the right-most address of
// X-Forwarded-For (the one NFSN's proxy added). REMOTE_ADDR on that host is the load balancer, the same for everyone,
// so counting by it let any ten failed logins lock out Alex and Sam together. That address is written by the client, so it is only a
// speed bump. Sections 6 to 9: the caps that name no address (per submitted account name and for the whole app, fixed windows, kept in
// login-caps.json under an exclusive 'c+' lock): they refuse with the answer of a wrong password, burn the cost of a checked failure,
// hold against any number of addresses, give a right password's slot back, and fail closed when the ledger cannot be read or written.
// Section 10 runs the real bootstrap's tm_login().
require_once __DIR__ . '/../../lib/login_limit.php';
use function TaskMind\{client_address, login_attempt, login_caps_key, login_caps_reserve};
use const TaskMind\{LOGIN_ACCOUNT_FAILURES_MAX, LOGIN_SITE_FAILURES_MAX, LOGIN_CAPS_WINDOW_SECONDS, LOGIN_CAPS_FILE, LOGIN_CAPS_LOCK};
use TaskMind\RequestError;

const LOGIN_LB = '10.0.0.1';
$lb = fn(string $forwarded = '') => ['REMOTE_ADDR' => LOGIN_LB] + ($forwarded === '' ? [] : ['HTTP_X_FORWARDED_FOR' => $forwarded]);

// ---- 1. Which address counts ----
check(client_address($lb('203.0.113.7')) === '203.0.113.7', 'a lone forwarded address is the client');
check(client_address($lb('198.51.100.9, 203.0.113.7')) === '203.0.113.7', 'the right-most entry is the one the proxy added');
check(client_address($lb(' 1.1.1.1 ,2.2.2.2,  203.0.113.7 ')) === '203.0.113.7', 'spaces around entries are ignored');
check(client_address($lb('2001:db8::1')) === '2001:db8::1' && client_address($lb('203.0.113.7, 2001:db8::2')) === '2001:db8::2', 'IPv6 addresses count');
check(client_address($lb('203.0.113.7, unknown')) === '203.0.113.7' && client_address($lb('203.0.113.7, <script>, 999.1.1.1, ')) === '203.0.113.7', 'entries that are not addresses are skipped, from the right');
check(client_address($lb()) === LOGIN_LB && client_address($lb('')) === LOGIN_LB && client_address($lb('garbage, ,')) === LOGIN_LB, 'no usable header falls back to REMOTE_ADDR');
check(client_address([]) === 'unknown' && client_address(['HTTP_X_FORWARDED_FOR' => '203.0.113.7']) === '203.0.113.7', 'neither header present, or only the forwarded one');

// ---- 2. One stranger cannot lock out the others ----
[$store, $dir] = harness_store();
$checked = 0;
$names = 0;
// Every call is a different account name, so only the address limit is in play here (sections 6 and after take the caps up).
$attempt = function (string $forwarded, string $password) use ($store, $lb, &$checked, &$names): bool {
    return login_attempt($store, client_address($lb($forwarded)), function () use ($password, &$checked) { ++$checked; return $password === 'right'; }, 'name-' . ++$names);
};
// The bot varies the left-most entry on every request, trying to look like someone new; its real address is 203.0.113.50.
for ($i = 1; $i <= 10; ++$i) { check($attempt("10.9.$i.1, 192.0.2.$i, 203.0.113.50", 'wrong') === false, "failure $i is counted, not refused"); }
check($checked === 10, 'ten failures were all checked');
refuses(fn() => $attempt('203.0.113.50', 'right'), 429, 'rate_limited');
refuses(fn() => $attempt('172.16.0.1, 203.0.113.50', 'right'), 429, 'rate_limited');
check($checked === 10, 'a locked-out client never reaches the password check, even with the right password');
// Alex and Sam come from other addresses, behind the same load balancer, and are unaffected.
check($attempt('198.51.100.7', 'right') === true, 'Alex signs in while the bot is locked out');
check($attempt('198.51.100.8', 'right') === true, 'Sam signs in while the bot is locked out');
// Only the right-most address decides. The bot's address on the left of Alex's request does not refuse Alex...
check($attempt('203.0.113.50, 198.51.100.7', 'right') === true, 'a forged left-most entry naming the bot does not lock a real client out');
// ...and Alex's address on the left of the bot's request does not let the bot through.
refuses(fn() => $attempt('198.51.100.7, 203.0.113.50', 'right'), 429, 'rate_limited');
check($attempt('198.51.100.7', 'right') === true, 'and Alex is still not counted');

// ---- 3. The count belongs to one client, and a right password clears it ----
for ($i = 1; $i <= 9; ++$i) { $attempt('198.51.100.20', 'wrong'); }
check($attempt('198.51.100.20', 'right') === true, 'nine failures leave one more try');
for ($i = 1; $i <= 9; ++$i) { $attempt('198.51.100.20', 'wrong'); }
check($attempt('198.51.100.20', 'right') === true, 'a right password cleared the count: nine more failures are allowed');
for ($i = 1; $i <= 10; ++$i) { $attempt('198.51.100.21', 'wrong'); }
refuses(fn() => $attempt('198.51.100.21', 'right'), 429, 'rate_limited');
check($attempt('198.51.100.22', 'right') === true, 'another client is unaffected');

// ---- 4. A refusal ends with the window; the ledger holds hashes of addresses, not addresses ----
$store->transaction('attempts', function (array $rows) {
    $key = hash('sha256', '203.0.113.50');
    check(isset($rows[$key]) && $rows[$key]['count'] === 10 && $rows[$key]['until'] > time(), 'the ledger is keyed by a hash of the client address');
    check(!str_contains(json_encode($rows), '203.0.113'), 'no address is kept in the ledger');
    $rows[$key]['until'] = time() - 1;
    return $rows;
});
check($attempt('203.0.113.50', 'right') === true, 'once the window has passed the client may try again');
check(!str_contains((string)file_get_contents($dir . '/attempts.enc'), '203.0.113'), 'nothing readable in the ledger file');

// ---- 5. The check order and the credentials callback ----
[$store, $dir] = harness_store();
check(login_attempt($store, '203.0.113.9', fn() => true, 'alex') === true, 'a callback that accepts signs in');
check(login_attempt($store, '203.0.113.9', fn() => false, 'alex') === false, 'a callback that declines does not');
check(login_attempt($store, '203.0.113.9', fn() => 'yes', 'alex') === false, 'only a strict true signs in');

// ---- 6. The caps name no address: the numbers, then one account from any number of addresses ----
check(LOGIN_ACCOUNT_FAILURES_MAX === 10 && LOGIN_SITE_FAILURES_MAX === 100 && LOGIN_CAPS_WINDOW_SECONDS === 3600, 'the documented numbers: 10 per account and 100 per app, per hour');
$fresh = 0;
$from = function () use (&$fresh): string { ++$fresh; return sprintf('10.%d.%d.%d', 1 + intdiv($fresh, 62000), intdiv($fresh, 250) % 250, 1 + $fresh % 250); };
/** A sign-in as `$account` from a brand-new address (so the per-address limit never applies), with the left-most entries forged as well. */
$as = function (TaskMind\Store $s, string $account, string $password, callable $count) use ($lb, $from): bool {
    return login_attempt($s, client_address($lb('192.0.2.1, ' . $from())), function () use ($password, $count) { $count(); return $password === 'right'; }, $account);
};
[$store, $dir] = harness_store();
$ran = 0;
$count = function () use (&$ran): void { ++$ran; };
for ($i = 1; $i <= LOGIN_ACCOUNT_FAILURES_MAX; ++$i) { check($as($store, 'alex', 'wrong', $count) === false, "failure $i of one account is checked and declined"); }
check($ran === 10, 'ten failures of one account, from ten different addresses, were all checked');
// The eleventh attempt, from yet another address, with the RIGHT password: declined like any failure, and the password is never looked at.
$answer = null;
try { $answer = $as($store, 'alex', 'right', $count); } catch (Throwable $e) { $answer = get_class($e) . ': ' . $e->getMessage(); }
check($answer === false, 'a full account cap answers like a wrong password (false, no exception, no 429): ' . var_export($answer, true));
check($ran === 10, 'and the credentials were not checked');
foreach ([1, 2, 3] as $again) { check($as($store, 'alex', 'right', $count) === false && $ran === 10, "attempt $again after the cap: still declined and unchecked"); }
check($as($store, 'sam', 'right', $count) === true && $ran === 11, 'another account signs in while this one is capped');
check($as($store, ' ALEX ', 'right', $count) === false && $as($store, "Alex\t", 'right', $count) === false && $ran === 11, 'the name is trimmed and lower-cased: spelling variants share the cap');
check($as($store, 'alex2', 'right', $count) === true && $as($store, 'alex' . str_repeat('x', 300), 'right', $count) === true, 'different names do not share it');
// A name that is not an account behaves exactly the same: a full cap says nothing about which names exist.
$ran = 0;
for ($i = 1; $i <= 10; ++$i) { check($as($store, 'nobody', 'wrong', $count) === false, "an unknown name's failure $i is declined"); }
check($ran === 10, 'an unknown name is checked like any');
check($as($store, 'nobody', 'right', $count) === false && $ran === 10, 'and capped like any, with the same answer');

// ---- 7. A right password gives its slot back; windows are fixed; the ledger is hashes ----
[$store, $dir] = harness_store();
$ledger = fn() => json_decode((string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE), true);
$edit = function (callable $f) use ($dir) { $file = $dir . '/' . LOGIN_CAPS_FILE; file_put_contents($file, json_encode($f(json_decode((string)file_get_contents($file), true)))); };
$ran = 0;
for ($i = 1; $i <= 9; ++$i) { $as($store, 'alex', 'wrong', $count); }
check($as($store, 'alex', 'right', $count) === true, 'nine failures leave a try');
check($as($store, 'alex', 'right', $count) === true, 'a right password does not use the cap up: another one signs in');
$key = login_caps_key($store, 'alex');
check($ledger()['accounts'][$key]['count'] === 9 && $ledger()['site']['count'] === 9, 'only failures count: nine in the account and in the app');
check($as($store, 'alex', 'wrong', $count) === false, 'the tenth failure is checked');
check($as($store, 'alex', 'right', $count) === false, 'and now the account is full');
$until = $ledger()['accounts'][$key]['until'];
check($until > time() + LOGIN_CAPS_WINDOW_SECONDS - 60 && $until <= time() + LOGIN_CAPS_WINDOW_SECONDS, 'the window runs an hour from the first failure');
$siteUntil = $ledger()['site']['until'];
$edit(function (array $c) use ($key) { $c['accounts'][$key]['until'] = time() - 1; return $c; });
check($as($store, 'alex', 'right', $count) === true, 'when the account window ends, the account may try again');
check(!isset($ledger()['accounts'][$key]), 'and the sign-in left no failure behind');
check($ledger()['site']['until'] === $siteUntil && $ledger()['site']['count'] === 10, "the app's own window is a different one and runs on");
// Fixed: more failures do not move the end of the window (the first failure's window is moved back 100 seconds so a moved end would show).
$as($store, 'sam', 'wrong', $count);
$samKey = login_caps_key($store, 'sam');
$edit(function (array $c) use ($samKey) { $c['accounts'][$samKey]['until'] -= 100; $c['site']['until'] -= 100; return $c; });
$first = $ledger()['accounts'][$samKey]['until'];
$as($store, 'sam', 'wrong', $count); $as($store, 'sam', 'wrong', $count);
check($ledger()['accounts'][$samKey]['until'] === $first && $ledger()['accounts'][$samKey]['count'] === 3, 'a window is fixed: three failures, the end where the first put it');
check($ledger()['site']['until'] === $siteUntil - 100 && $ledger()['site']['count'] === 13, "and so is the app's");
// The ledger: keyed hashes and counts only, private.
$text = (string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE);
check(!preg_match('/alex|sam|nobody|192\.0\.2|10\.\d+\.\d+\.\d+/i', $text), 'no name and no address in the ledger');
check(preg_match('/^[0-9a-f]{64}$/D', $key) === 1 && $key !== hash('sha256', 'login-account:alex') && $key !== hash('sha256', 'alex'), 'the key is keyed: not the plain hash of the name');
check(($ledger()['v'] ?? null) === 1 && array_keys($ledger()) === ['v', 'site', 'accounts'], 'the ledger has the documented shape');
check((fileperms($dir . '/' . LOGIN_CAPS_FILE) & 0777) === 0600 && (fileperms($dir . '/' . LOGIN_CAPS_LOCK) & 0777) === 0600, 'the ledger and its lock file are private');
check(!glob($dir . '/*.tmp'), 'no partial files are left');
check(login_caps_key($store, 'alex') === $key && login_caps_key(harness_store()[0], 'alex') !== $key, 'the key is stable for a store and differs between stores');

// ---- 8. The app-wide cap, and the per-address limit is still there ----
[$store, $dir] = harness_store();
$ledger = fn() => json_decode((string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE), true);
$ran = 0;
for ($i = 1; $i <= LOGIN_SITE_FAILURES_MAX; ++$i) { check($as($store, "guess-$i", 'wrong', $count) === false, "failure $i of the app, every one a different name and address"); }
check($ran === 100 && $ledger()['site']['count'] === 100 && count($ledger()['accounts']) === 100, 'a hundred failures of a hundred names were checked; the ledger holds exactly those');
check($as($store, 'alex', 'right', $count) === false && $as($store, 'sam', 'right', $count) === false && $ran === 100, 'then nobody is checked, a right password included: the same answer as a wrong one');
check($as($store, 'guess-1', 'right', $count) === false && $ran === 100, 'and a name that never failed is not different from one that did');
check(count($ledger()['accounts']) === 100, 'a refused attempt adds nothing to the ledger: it stays as big as one window of failures');
$edit = function (callable $f) use ($dir) { $file = $dir . '/' . LOGIN_CAPS_FILE; file_put_contents($file, json_encode($f(json_decode((string)file_get_contents($file), true)))); };
$edit(function (array $c) { $c['site']['until'] = time() - 1; return $c; });
check($as($store, 'alex', 'right', $count) === true && $ran === 101, "when the app's window ends, sign-in works again");
check($ledger()['site']['count'] === 0 && count($ledger()['accounts']) === 100, "the app's window is over and its count with it; the accounts' own windows run on");
$as($store, 'late', 'wrong', $count);
check($ledger()['site']['count'] === 1 && count($ledger()['accounts']) === 101, 'a new failure opens a new window');
$edit(function (array $c) { foreach ($c['accounts'] as $k => $r) { $c['accounts'][$k]['until'] = time() - 1; } return $c; });
$as($store, 'later', 'wrong', $count);
check(count($ledger()['accounts']) === 1, 'expired accounts are pruned on the next write');

// The per-address speed bump is kept, and a refusal by it spends nothing from the caps.
[$store, $dir] = harness_store();
$ledger = fn() => json_decode((string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE), true);
$ran = 0;
$one = '203.0.113.77';
for ($i = 1; $i <= 10; ++$i) { check(login_attempt($store, $one, function () use ($count) { $count(); return false; }, "walker-$i") === false, "address failure $i"); }
refuses(fn() => login_attempt($store, $one, function () use ($count) { $count(); return true; }, 'alex'), 429, 'rate_limited');
check($ran === 10 && !isset($ledger()['accounts'][login_caps_key($store, 'alex')]) && $ledger()['site']['count'] === 10, 'the address limit still refuses with 429, before the caps, and spends no slot');
check(login_attempt($store, '203.0.113.78', function () use ($count) { $count(); return false; }, 'alex') === false && $ledger()['accounts'][login_caps_key($store, 'alex')]['count'] === 1, 'another address is unaffected, and a checked failure counts for its account');
// A full cap still counts against the address: the speed bump keeps biting, with its own answer.
[$store, $dir] = harness_store();
$ran = 0;
for ($i = 1; $i <= 10; ++$i) { $as($store, 'alex', 'wrong', $count); }
for ($i = 1; $i <= 10; ++$i) { check(login_attempt($store, '203.0.113.80', function () use ($count) { $count(); return true; }, 'alex') === false, "capped attempt $i from one address"); }
refuses(fn() => login_attempt($store, '203.0.113.80', fn() => true, 'sam'), 429, 'rate_limited');
check($ran === 10, 'ten declined attempts from one address and then the address is refused; nothing was checked');

// Timing: a declined attempt costs what a checked failure costs (one bcrypt check), so the cap is not a quick tell.
[$store, $dir] = harness_store();
$cost10 = password_hash('right', PASSWORD_BCRYPT, ['cost' => 10]);
$time = function (string $account) use ($store, $from, $lb, $cost10): float {
    $t = hrtime(true);
    login_attempt($store, client_address($lb($from())), fn() => password_verify('wrong', $cost10), $account);
    return (hrtime(true) - $t) / 1e9;
};
$checkedMin = min($time('timing-a'), $time('timing-b'), $time('timing-c'));
for ($i = 1; $i <= LOGIN_ACCOUNT_FAILURES_MAX; ++$i) { $time('timing-full'); }
$cappedMin = min($time('timing-full'), $time('timing-full'), $time('timing-full'));
check($checkedMin > 0.005, "the checked failure did a real bcrypt check ($checkedMin s)");
check($cappedMin > 0.5 * $checkedMin, "a declined attempt costs about what a checked failure does: $cappedMin s against $checkedMin s");

// ---- 9. Fail closed: a ledger that cannot be read or written signs nobody in and is never read as empty ----
$never = 0;
$right = function () use (&$never): bool { ++$never; return true; };
$unavailable = function (callable $fn, string $why) use (&$never): void {
    try { $fn(); } catch (RequestError $e) { throw new RuntimeException("$why: a RequestError ({$e->status}) is not the unavailable answer"); } catch (Throwable $e) { check($never === 0, "$why: the credentials were never checked"); return; }
    throw new RuntimeException("$why: the attempt was accepted or declined as usual");
};
foreach ([
    'garbage' => 'not json at all',
    'empty file' => '',
    'a list' => '[]',
    'wrong version' => '{"v":2,"site":{"count":0,"until":0},"accounts":{}}',
    'no site' => '{"v":1,"accounts":{}}',
    'site row cut short' => '{"v":1,"site":{"count":0},"accounts":{}}',
    'a string count' => '{"v":1,"site":{"count":"0","until":0},"accounts":{}}',
    'a negative count' => '{"v":1,"site":{"count":-1,"until":0},"accounts":{}}',
    'accounts not a map' => '{"v":1,"site":{"count":0,"until":0},"accounts":7}',
    'an account key that is not a hash' => '{"v":1,"site":{"count":0,"until":0},"accounts":{"alex":{"count":1,"until":9999999999}}}',
    'an account row with an extra field' => '{"v":1,"site":{"count":0,"until":0},"accounts":{"' . str_repeat('a', 64) . '":{"count":1,"until":9999999999,"x":1}}}',
    'an extra top-level field' => '{"v":1,"site":{"count":0,"until":0},"accounts":{},"x":1}',
] as $why => $bytes) {
    [$store, $dir] = harness_store();
    $never = 0;
    file_put_contents($dir . '/' . LOGIN_CAPS_FILE, $bytes);
    $unavailable(fn() => login_attempt($store, '203.0.113.5', $right, 'alex'), "a ledger holding $why");
    check(file_get_contents($dir . '/' . LOGIN_CAPS_FILE) === $bytes, "a ledger holding $why is left alone, not reset");
    $unavailable(fn() => login_caps_reserve($store, 'alex'), "reserving against a ledger holding $why");
}
[$store, $dir] = harness_store();
$never = 0;
mkdir($dir . '/' . LOGIN_CAPS_FILE);
$unavailable(fn() => login_attempt($store, '203.0.113.5', $right, 'alex'), 'a ledger that is a directory');
rmdir($dir . '/' . LOGIN_CAPS_FILE);
unlink($dir . '/' . LOGIN_CAPS_LOCK);   // the attempt above made it as a file
mkdir($dir . '/' . LOGIN_CAPS_LOCK);
$unavailable(fn() => login_attempt($store, '203.0.113.5', $right, 'alex'), 'a lock file that cannot be opened');
rmdir($dir . '/' . LOGIN_CAPS_LOCK);
check(login_attempt($store, '203.0.113.5', $right, 'alex') === true, 'with the obstacle gone the same store signs in');
// Read only: the directory takes no new files, so the ledger cannot be written (skipped when the runner may write anyway, e.g. as root).
[$store, $dir] = harness_store();
$never = 0;
login_attempt($store, '203.0.113.6', fn() => false, 'alex');
$before = (string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE);
chmod($dir, 0500);
clearstatcache();
try {
    if (!is_writable($dir)) {
        $unavailable(fn() => login_caps_reserve($store, 'alex'), 'a directory that takes no writes');
        $unavailable(fn() => login_attempt($store, '203.0.113.7', $right, 'alex'), 'a sign-in in a directory that takes no writes');
    }
} finally { chmod($dir, 0700); }
check(file_get_contents($dir . '/' . LOGIN_CAPS_FILE) === $before, 'the failed writes left the ledger as it was');
// The lock handle is opened 'c+', never 'c' (NFS-emulated flock wants a readable handle), and the bytes go out through the canon atomic_write.
$source = (string)file_get_contents(__DIR__ . '/../../lib/login_limit.php');
check(str_contains($source, "fopen(\$file, 'c+')") && !str_contains($source, "fopen(\$file, 'c')") && str_contains($source, 'atomic_write($file, json_encode'), "the caps lock is opened 'c+' and the ledger written with atomic_write");

// Racing processes: the ledger's own lock, not the address ledger's, keeps the cap exact. 25 reserve a slot of one account at once.
$racer = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/login_limit.php';
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$store = new TaskMind\Store($dir);
if ($mode === 'reserve') {
    if (TaskMind\login_caps_reserve($store, 'racer') !== null) { file_put_contents($dir . '/won-' . $n, '1'); }
} else {
    TaskMind\login_attempt($store, '198.51.100.' . $n, function () use ($dir, $n) { file_put_contents($dir . '/ran-' . $n, '1'); return false; }, 'racer');
}
PHP;
foreach (['reserve', 'reserve', 'attempt'] as $mode) {
    [$store, $dir] = harness_store();
    harness_workers($racer, $dir, 25, $mode);
    $marks = count(glob($dir . '/' . ($mode === 'reserve' ? 'won-*' : 'ran-*')) ?: []);
    check($marks === LOGIN_ACCOUNT_FAILURES_MAX, "$mode: of 25 simultaneous attempts exactly ten got a slot, got $marks");
    $ledger = json_decode((string)file_get_contents($dir . '/' . LOGIN_CAPS_FILE), true);
    check($ledger['site']['count'] === 10 && $ledger['accounts'][login_caps_key($store, 'racer')]['count'] === 10, "$mode: and the ledger says ten");
    check(!glob($dir . '/*.tmp'), "$mode: no partial files are left");
}

// ---- 10. The real bootstrap: tm_login() hands the submitted name to the limiter ----
// A child PHP loads lib/bootstrap.php against a stub of the site's account library and posts sign-ins, each from a different forged address.
$sb = harness_dir();
$siteLib = $sb . '/site'; $data = $sb . '/data'; $sessions = $sb . '/sessions';
foreach ([$siteLib, $data, $sessions] as $made) { mkdir($made, 0700); }
file_put_contents($siteLib . '/auth.php', <<<'PHP'
<?php
function session_boot(): void { if (session_status() !== PHP_SESSION_ACTIVE) { session_start(); } }
function current_user(): ?string { return $_SESSION['user'] ?? null; }
function app_config(): array { return ['users' => ['alex' => 'x', 'sam' => 'x']]; }
function auth_password_for(array $config, string $user): ?string { return (string)getenv('PW_HASH'); }
PHP);
$driver = <<<'PHP'
[, $lib, $attempts] = $argv;
$_SERVER['HTTP_HOST'] = '127.0.0.1'; $_SERVER['REMOTE_ADDR'] = '10.0.0.1';
require $lib . '/bootstrap.php';
$out = [];
foreach (json_decode($attempts, true) as [$user, $password, $forwarded]) {
    $_POST = ['username' => $user, 'password' => $password];
    $_SERVER['HTTP_X_FORWARDED_FOR'] = $forwarded;
    try { $out[] = tm_login($store) ? 'in' : 'declined'; } catch (\TaskMind\RequestError $e) { $out[] = 'refused ' . $e->status; }
}
echo json_encode($out);
PHP;
$secret = 'wiring-secret-only';
$run = function (array $attempts) use ($driver, $siteLib, $data, $sessions, $secret): array {
    $env = ['TASKMIND_SITE_LIB' => $siteLib, 'TASKMIND_DATA_DIR' => $data, 'PW_HASH' => password_hash($secret, PASSWORD_BCRYPT, ['cost' => 4])] + getenv();
    $process = proc_open([PHP_BINARY, ...harness_php_flags(), '-d', 'session.save_path=' . $sessions, '-r', $driver, '--', realpath(__DIR__ . '/../../lib'), json_encode($attempts)],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
    check(is_resource($process), 'the sign-in process started');
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]); $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    check(proc_close($process) === 0 && trim($err) === '', "the sign-ins ran cleanly: $err");
    $answers = json_decode($out, true);
    check(is_array($answers) && count($answers) === count($attempts), "the sign-ins answered: $out");
    return $answers;
};
$wrong = [];
for ($i = 1; $i <= 10; ++$i) { $wrong[] = ['alex', 'not-the-password', "198.51.100.9, 203.0.113.$i"]; }
check($run($wrong) === array_fill(0, 10, 'declined'), 'ten wrong passwords for one name, each from a different address: declined, none refused');
check($run([['alex', $secret, '203.0.113.100']]) === ['declined'], 'the eleventh attempt, with the right password, from a new address: the same "declined", not a 429');
check($run([[' ALEX ', $secret, '203.0.113.101'], ['Alex', $secret, '203.0.113.102']]) === ['declined', 'declined'], 'the name is normalised before it is counted');
check($run([['sam', $secret, '203.0.113.103']]) === ['in'], 'the other person signs in');
check($run([['nobody', 'x', '203.0.113.104']]) === ['declined'], 'an unknown name is declined like a wrong password');
check(is_file($data . '/' . LOGIN_CAPS_FILE) && (fileperms($data . '/' . LOGIN_CAPS_FILE) & 0777) === 0600, 'the app wrote its caps ledger, private');
check(!preg_match('/alex|sam|nobody|203\.0\.113/i', (string)file_get_contents($data . '/' . LOGIN_CAPS_FILE)), 'which holds no name and no address');
