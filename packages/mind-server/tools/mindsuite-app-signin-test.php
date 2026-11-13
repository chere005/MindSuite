<?php
declare(strict_types=1);

// The code half of app sign-in (lib/mindsuite-app-signin.php). Run: php packages/mind-server/tools/mindsuite-app-signin-test.php
// A scratch store under the system temp dir, removed at the end. Accounts are the placeholders alex and sam.

require_once __DIR__ . '/../lib/mindsuite-app-signin.php';

$GLOBALS['checklog'] = '';
function check(bool $ok, string $description): void
{
    if (!$ok) {
        fwrite(STDOUT, $GLOBALS['checklog']);
        fwrite(STDERR, "FAIL - $description\n");
        exit(1);
    }
    $GLOBALS['checklog'] .= "ok - $description\n";
}

function erase(string $dir): void
{
    foreach (new FilesystemIterator($dir) as $file) {
        if ($file->isDir()) { erase($file->getPathname()); }
        else { unlink($file->getPathname()); }
    }
    rmdir($dir);
}

function threw(callable $fn, string $class): bool
{
    try { $fn(); return false; } catch (Throwable $e) { return $e instanceof $class; }
}

function bearer(string $token): array { return ['HTTP_AUTHORIZATION' => 'Bearer ' . $token]; }

$dir = sys_get_temp_dir() . '/mindsuite-app-signin-test-' . bin2hex(random_bytes(8));
mkdir($dir, 0700);
try {
    $cfg = msa_config('prod', bin2hex(random_bytes(16)), $dir);
    $cfg['invite_code'] = 'fixture-invite';
    msa_store_write($cfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]);
    // Cost 4 keeps the fixture fast: the accounts are written straight into the store.
    $db = msa_store_read($cfg);
    foreach (['alex', 'sam'] as $u) {
        $db['accounts'][$u] = ['email' => $u . '@example.test', 'hash' => password_hash('password', PASSWORD_BCRYPT, ['cost' => 4]), 'created' => time()];
    }
    msa_store_write($cfg, $db);
    $storeFile = $cfg['data_dir'] . '/auth.json';

    /** A full cookie session context for a user, as the site page sees it. */
    $browser = static function (string $user) use ($cfg): array {
        $s = msa_login($cfg, $user, 'password', 'Browser', '127.0.0.1');
        $ctx = msa_session($cfg, [], ['MSSESS' => $s['token']]);
        if ($ctx === null) { throw new RuntimeException('fixture session'); }
        return $ctx + ['token' => $s['token']];
    };
    $verifier = str_repeat('v', 43);
    $challenge = msa_app_signin_s256($verifier);
    $cm = 'com.seancheren.calmind:/signin';
    $now = time();
    $issue = static fn(array $ctx, string $app = 'calmind', string $redirect = '', ?string $ch = null, ?int $at = null): array =>
        msa_app_signin_issue($cfg, $ctx, $app, $redirect !== '' ? $redirect : $cm, $ch ?? $challenge, $at ?? time());
    $redeem = static fn(string $code, string $app = 'calmind', ?string $v = null, string $redirect = '', string $scope = 'calmind', ?int $at = null): ?array =>
        msa_app_signin_redeem($cfg, $app, $code, $v ?? $verifier, $redirect !== '' ? $redirect : $cm, 'CalMind test', $scope, $at ?? time());

    // 1. RFC 7636 appendix B.
    check(msa_app_signin_s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        'S256 reproduces the RFC 7636 appendix B challenge');

    // 2. The return-address table.
    $good = [['calmind', 'com.seancheren.calmind:/signin'], ['chefmind', 'com.seancheren.chefmind:/signin'],
        ['calmind', 'http://127.0.0.1:1024/signin'], ['chefmind', 'http://127.0.0.1:65535/signin']];
    $bad = [['calmind', 'com.seancheren.chefmind:/signin'], ['chefmind', 'com.seancheren.calmind:/signin'],
        ['calmind', 'com.seancheren.calmind:/signin/'], ['calmind', 'com.seancheren.calmind://signin'],
        ['calmind', 'com.seancheren.calmind:/signin?x=1'], ['calmind', 'com.seancheren.calmind:/signin#x'],
        ['calmind', 'COM.SEANCHEREN.CALMIND:/signin'], ['calmind', 'http://127.0.0.1:1023/signin'],
        ['calmind', 'http://127.0.0.1:65536/signin'], ['calmind', 'http://127.0.0.1:0/signin'],
        ['calmind', 'http://127.0.0.1:08080/signin'], ['calmind', 'http://localhost:8080/signin'],
        ['calmind', 'http://[::1]:8080/signin'], ['calmind', 'https://127.0.0.1:8080/signin'],
        ['calmind', 'http://127.0.0.1:8080/other'], ['calmind', 'http://user@127.0.0.1:8080/signin'],
        ['calmind', 'http://127.0.0.1:8080/signin?a=b'], ['calmind', 'http://127.0.0.1:8080/signin#a'],
        ['calmind', 'http://127.0.0.1:8080/signin' . "\n"], ['calmind', ''], ['unknown', 'com.seancheren.calmind:/signin'],
        ['CalMind', 'com.seancheren.calmind:/signin']];
    $wrongGood = array_filter($good, static fn($r) => !msa_app_signin_redirect_ok($r[0], $r[1]));
    $wrongBad = array_filter($bad, static fn($r) => msa_app_signin_redirect_ok($r[0], $r[1]));
    check(!$wrongGood && !$wrongBad, 'the return-address table: ' . count($good) . ' allowed, ' . count($bad) . ' refused');
    check(msa_app_signin_client('calmind')['name'] === 'CalMind' && msa_app_signin_client('chefmind')['scheme'] === 'com.seancheren.chefmind' &&
        msa_app_signin_client('CalMind') === null && msa_app_signin_client('') === null, 'the client registry is exact');
    check(msa_app_signin_challenge_ok($challenge) && !msa_app_signin_challenge_ok(substr($challenge, 1)) && !msa_app_signin_challenge_ok($challenge . '=') &&
        msa_app_signin_state_ok(str_repeat('a', 16)) && !msa_app_signin_state_ok(str_repeat('a', 15)) && !msa_app_signin_state_ok(str_repeat('a', 129)) &&
        !msa_app_signin_state_ok('a+b' . str_repeat('c', 20)), 'challenge and state shapes');

    // 3. Issue needs a live FULL cookie session.
    $alex = $browser('alex');
    $scopedLogin = msa_login($cfg, 'alex', 'password', 'App', '127.0.0.1', 'calmind');
    $scopedCtx = msa_session($cfg, bearer($scopedLogin['token']), []);
    check($scopedCtx !== null && $scopedCtx['scope'] === 'calmind', 'fixture: a scoped bearer context');
    check($issue($scopedCtx) === ['ok' => false, 'why' => 'request'], 'a scoped bearer context is refused as a request');
    $forged = ['carrier' => 'cookie', 'scope' => ''] + $scopedCtx;
    check($issue($forged) === ['ok' => false, 'why' => 'session'], 'a forged context whose stored row is scoped is refused as a session');
    check($issue($alex, 'calmind', 'http://localhost:1/signin') === ['ok' => false, 'why' => 'request'] &&
        $issue($alex, 'nope') === ['ok' => false, 'why' => 'request'] &&
        $issue($alex, 'calmind', '', 'short') === ['ok' => false, 'why' => 'request'], 'a bad app, return address or challenge is refused before the lock');
    $gone = $browser('sam');
    msa_revoke($cfg, $gone);
    check($issue($gone) === ['ok' => false, 'why' => 'session'], 'a revoked browser session is refused');

    // 4. Busy: five live codes per account, fifty rows in all.
    $codes = [];
    for ($i = 0; $i < MSA_APP_SIGNIN_LIVE; $i++) {
        $r = $issue($alex);
        check($r['ok'] === true && preg_match('/\A[a-f0-9]{64}\z/', $r['code']) === 1, "issue $i answers a 64-hex code");
        $codes[] = $r['code'];
    }
    check($issue($alex) === ['ok' => false, 'why' => 'busy'], 'the sixth live code for one account is busy');
    $sam = $browser('sam');
    $r = $issue($sam);
    check($r['ok'] === true, 'another account still issues');
    check($issue($alex, 'calmind', '', null, time() + MSA_APP_SIGNIN_TTL + 1)['ok'] === true, 'expired rows do not count toward busy');
    // Fifty rows in the table answer busy for anyone.
    $db = msa_store_read($cfg);
    $db['app_codes'] = [];
    for ($i = 0; $i < MSA_APP_SIGNIN_ROWS; $i++) {
        $db['app_codes'][hash('sha256', "row$i")] = ['spent' => hash('sha256', "t$i"), 'until' => time() + 100];
    }
    msa_store_write($cfg, $db);
    check($issue($sam) === ['ok' => false, 'why' => 'busy'], 'fifty rows in the table are busy for anyone');
    $db = msa_store_read($cfg);
    unset($db['app_codes']);
    msa_store_write($cfg, $db);

    // 5. Redeem, happy path.
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    $s = $redeem($code);
    check($s !== null && preg_match('/\A[a-f0-9]{64}\z/', $s['token']) === 1 && $s['user'] === 'alex', 'a redeem answers a 64-hex token for the account');
    $row = msa_store_read($cfg)['sessions'][hash('sha256', $s['token'])] ?? null;
    check($row !== null && $row['scope'] === 'calmind' && $row['device'] === 'CalMind test' && $row['user'] === 'alex', 'the stored row is scoped, with the device');
    $ctx = msa_session($cfg, bearer($s['token']), []);
    check($ctx !== null && $ctx['scope'] === 'calmind' && msa_session($cfg, [], ['MSSESS' => $s['token']]) === null,
        'the token is a calmind bearer and the cookie carrier refuses it');

    // 6. A second redeem ends the session the first one made.
    check($redeem($code) === null && msa_session($cfg, bearer($s['token']), []) === null, 'a replay is refused and revokes the session it minted');

    // 7. A wrong verifier burns the code.
    $code = $issue($alex)['code'];
    check($redeem($code, 'calmind', str_repeat('w', 43)) === null && $redeem($code) === null, 'a wrong verifier, then the right one: both null');

    // 8. Wrong app and wrong return address.
    $code = $issue($alex)['code'];
    check($redeem($code, 'chefmind') === null && $redeem($code) === null, 'a calmind code redeemed as chefmind is refused and burned');
    $code = $issue($alex)['code'];
    check($redeem($code, 'calmind', null, 'http://127.0.0.1:5000/signin') === null && $redeem($code) === null, 'a different return address is refused and burns the code');

    // 9. Expiry.
    $code = $issue($alex)['code'];
    check($redeem($code, 'calmind', null, '', 'calmind', time() + MSA_APP_SIGNIN_TTL) === null, 'a code is dead at its expiry');

    // 10. Revocation between issue and redeem.
    $code = $issue($alex)['code'];
    msa_revoke_all($cfg, $alex);
    check($redeem($code) === null, 'sign out everywhere between issue and redeem refuses the code');
    // The generation alone (the confirming session is left alive): a code made before it is dead after it.
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    $db = msa_store_read($cfg);
    $db['accounts']['alex']['gen'] = msa_account_gen($db, 'alex') + 1;
    msa_store_write($cfg, $db);
    check(msa_session($cfg, [], ['MSSESS' => $alex['token']]) !== null && $redeem($code) === null, 'a raised revocation generation alone refuses the code while the browser session lives');
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    msa_revoke($cfg, $alex);
    check($redeem($code) === null, 'revoking the confirming browser session refuses the code');
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    $db = msa_store_read($cfg);
    $keep = $db['accounts']['alex'];
    unset($db['accounts']['alex']);
    msa_store_write($cfg, $db);
    check($redeem($code) === null, 'a removed account refuses the code');
    $db = msa_store_read($cfg);
    $db['accounts']['alex'] = $keep;
    msa_store_write($cfg, $db);

    // 11. An empty scope never mints a full-account session.
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    check(threw(static fn() => $redeem($code, 'calmind', null, '', ''), InvalidArgumentException::class) &&
        threw(static fn() => $redeem($code, 'calmind', null, '', 'Bad Scope'), InvalidArgumentException::class), 'an empty or malformed scope is an InvalidArgumentException');
    check($redeem($code) !== null, 'and the refused call burned nothing');

    // 12. Malformed input never touches the store.
    $code = $issue($alex)['code'];
    $bytes = file_get_contents($storeFile);
    clearstatcache();
    $mtime = filemtime($storeFile);
    check($redeem(substr($code, 1)) === null && $redeem($code, 'calmind', str_repeat('v', 42)) === null &&
        $redeem($code, 'calmind', str_repeat('v', 42) . '+') === null && $redeem($code, 'nope') === null &&
        $redeem(str_repeat('a', 64)) === null, 'malformed input and a code nobody issued answer null');
    clearstatcache();
    check(file_get_contents($storeFile) === $bytes && filemtime($storeFile) === $mtime, 'and the store file is byte for byte unchanged');
    check($redeem($code) !== null, 'the real code still redeems afterwards');

    // 13. A damaged table is read as empty and rewritten clean.
    foreach (['a string', [str_repeat('z', 64) => ['until' => time() + 99], 'short' => ['until' => time() + 99], str_repeat('a', 64) => 'x', str_repeat('b', 64) => ['until' => 5]]] as $damage) {
        $db = msa_store_read($cfg);
        $db['app_codes'] = $damage;
        msa_store_write($cfg, $db);
        $alex = $browser('alex');
        $r = $issue($alex);
        $table = msa_store_read($cfg)['app_codes'] ?? [];
        check($r['ok'] === true && count($table) === 1 && isset($table[hash('sha256', $r['code'])]), 'a damaged app_codes table is rewritten clean');
    }

    // 14. The code is never stored in clear.
    $alex = $browser('alex');
    $code = $issue($alex)['code'];
    check(!str_contains(json_encode(msa_store_read($cfg)), $code), 'the store holds no copy of the issued code');
    $s = $redeem($code);
    check($s !== null && !str_contains(json_encode(msa_store_read($cfg)), $code) && !str_contains(file_get_contents($storeFile), $code), 'nor after the redeem');

    // 15. An empty table drops the key.
    $db = msa_store_read($cfg);
    check(isset($db['app_codes']), 'fixture: a spent row is in the table');
    $alex = $browser('alex');
    $r = $issue($alex, 'calmind', '', null, time() + 1000);   // the spent row has expired by then, and this one is live
    $db = msa_store_read($cfg);
    check(count($db['app_codes']) === 1, 'expired and spent rows are pruned at the next issue');
    $db['app_codes'] = [hash('sha256', 'x') => ['spent' => hash('sha256', 'y'), 'until' => 1]];
    msa_store_write($cfg, $db);
    $code = $issue($alex, 'chefmind', 'com.seancheren.chefmind:/signin');
    $s = msa_app_signin_redeem($cfg, 'chefmind', $code['code'], $verifier, 'com.seancheren.chefmind:/signin', 'ChefMind test', 'calmind', time());
    $db = msa_store_read($cfg);
    check($s !== null && count($db['app_codes'] ?? []) === 1 && array_key_exists('spent', array_values($db['app_codes'])[0]), 'a redeem leaves one spent marker');
    $db['app_codes'] = [];
    msa_store_write($cfg, $db);
    $code = $issue($alex);
    $db = msa_store_read($cfg);
    unset($db['app_codes']);
    msa_store_write($cfg, $db);
    check(msa_app_signin_redeem($cfg, 'calmind', $code['code'], $verifier, $cm, '', 'calmind', time()) === null &&
        !array_key_exists('app_codes', msa_store_read($cfg)), 'a code the store no longer knows is refused and no empty table is written');
} finally {
    if (is_dir($dir)) { erase($dir); }
}
echo $GLOBALS['checklog'];
echo "mindsuite-app-signin: all checks passed\n";
