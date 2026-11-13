<?php
declare(strict_types=1);

require_once __DIR__ . '/../../packages/mind-server/lib/mindsuite-passkeys.php';

/** Results are held until the end: the cookie renewal cases need headers not to have been sent. */
$GLOBALS['checklog'] = '';
function check(bool $ok, string $description): void
{
    if (!$ok) {
        fwrite(STDOUT, $GLOBALS['checklog']);
        throw new RuntimeException($description);
    }
    $GLOBALS['checklog'] .= "ok - $description\n";
}

/** msa_login with the two required arguments defaulted, so cases that are not about the address stay short. */
function lg(array $cfg, string $user, string $pw, string $device = '', string $client = '', string $scope = ''): ?array
{
    return msa_login($cfg, $user, $pw, $device, $client, $scope);
}

function refused(callable $operation): bool
{
    try {
        $operation();
        return false;
    } catch (RuntimeException | InvalidArgumentException) {
        return true;
    }
}

function erase(string $dir): void
{
    foreach (new FilesystemIterator($dir) as $file) {
        if ($file->isDir()) { erase($file->getPathname()); }
        else { unlink($file->getPathname()); }
    }
    rmdir($dir);
}

function bearer(string $token): array
{
    return ['HTTP_AUTHORIZATION' => 'Bearer ' . $token];
}

function client_data(string $type, string $challenge, string $origin, bool $crossOrigin = false): string
{
    return json_encode(['type' => $type, 'challenge' => $challenge, 'origin' => $origin, 'crossOrigin' => $crossOrigin], JSON_THROW_ON_ERROR);
}

$dir = sys_get_temp_dir() . '/mindsuite-auth-test-' . bin2hex(random_bytes(8));
mkdir($dir, 0700);
// msa_config takes a POSIX absolute store root (the server is Linux). On
// Windows, hand it the same directory without its drive letter (a path from
// the drive root), which PHP resolves against the current drive, so stay on
// the temp dir's.
$store = $dir;
if (PHP_OS_FAMILY === 'Windows' && preg_match('#\A[A-Za-z]:[/\\\\]#', $dir) === 1) {
    chdir(substr($dir, 0, 3));
    $store = str_replace('\\', '/', substr($dir, 2));
}
try {
    // The site's copy of the shared auth library is compared by tools/check-shared.mjs --external, never by a
    // generic run and never written. The fixture is a disposable suite root holding a copy of the real checker
    // (the script derives its root from where it lives) with a manifest of one group and one external entry,
    // next to a sibling seancheren-site checkout, as the checker expects to find it.
    $shared = $dir . '/shared-check';
    $suite = $shared . '/suite';
    $siteRepo = $shared . '/seancheren-site';
    $siteCopy = $siteRepo . '/lib/mindsuite-auth.php';
    foreach ([$suite . '/tools', $suite . '/packages/mind-server/lib', $suite . '/app', $siteRepo . '/lib'] as $made) {
        mkdir($made, 0700, true);
    }
    copy(__DIR__ . '/../../tools/check-shared.mjs', $suite . '/tools/check-shared.mjs');
    file_put_contents($suite . '/tools/shared-files.json', json_encode([
        'version' => 1,
        'groups' => [['id' => 'fixture-atomic', 'origin' => 'packages/mind-server/lib/atomic.php', 'copies' => ['app/atomic.php']]],
        'external' => [['id' => 'site-lib-mindsuite-auth-php', 'origin' => 'packages/mind-server/lib/mindsuite-auth.php',
            'repo' => 'seancheren-site', 'path' => 'lib/mindsuite-auth.php']],
    ], JSON_THROW_ON_ERROR));
    file_put_contents($suite . '/packages/mind-server/lib/atomic.php', 'atomic');
    file_put_contents($suite . '/app/atomic.php', 'atomic');
    file_put_contents($suite . '/packages/mind-server/lib/mindsuite-auth.php', 'origin');
    file_put_contents($siteCopy, 'origin');

    /** An argv array and an env array, not a shell string (cmd.exe cannot parse `VAR=x`); a caller's own knobs are dropped. */
    $sharedRun = static function (array $args, array $env = []) use ($suite): array {
        $proc = proc_open(['node', $suite . '/tools/check-shared.mjs', ...$args],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]],
            $pipes, $suite, $env + array_diff_key(getenv(), ['MIND_SITE_DIR' => 1, 'SHARED_FILES' => 1]));
        if (!is_resource($proc)) { throw new RuntimeException('could not start node for check-shared.mjs'); }
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        return [proc_close($proc), $output];
    };
    /** Every path and file digest under the fixture, so "nothing written" is a comparison and not a hope. */
    $tree = static function () use ($shared): string {
        $rows = [];
        $walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($shared, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
        foreach ($walk as $entry) {
            $rows[] = substr($entry->getPathname(), strlen($shared)) . ($entry->isDir() ? '/' : ' ' . hash_file('sha256', $entry->getPathname()));
        }
        sort($rows);
        return implode("\n", $rows);
    };
    $lastLine = static fn(string $output): string => (string) array_slice(explode("\n", rtrim($output)), -1)[0];

    $before = $tree();
    [$status, $output] = $sharedRun(['--external']);
    check($status === 0 && str_contains($output, 'compared 2 file(s)') && $lastLine($output) === '1 group(s): 0 drifted, 0 failures' &&
        $tree() === $before, 'a site copy equal to its origin passes the external check');

    file_put_contents($siteCopy, 'drifted');
    $before = $tree();
    [$status, $output] = $sharedRun([]);
    check($status === 0 && str_contains($output, 'compared 1 file(s)') && !str_contains($output, 'site-lib-mindsuite-auth-php') &&
        $tree() === $before, 'a plain run leaves the site copy alone, drifted or not');
    [$status, $output] = $sharedRun(['--external']);
    check($status === 1 && str_contains($output, 'FAIL drift external site-lib-mindsuite-auth-php') &&
        $lastLine($output) === '1 group(s): 1 drifted, 1 failures' && file_get_contents($siteCopy) === 'drifted' &&
        file_get_contents($suite . '/packages/mind-server/lib/mindsuite-auth.php') === 'origin' && $tree() === $before,
        'a mismatching site copy fails the external check and is not written');

    unlink($siteCopy);
    $before = $tree();
    [$status, $output] = $sharedRun(['--external']);
    check($status === 1 && str_contains($output, 'FAIL missing external site-lib-mindsuite-auth-php') && !file_exists($siteCopy) &&
        $tree() === $before, 'a site checkout without the file fails the external check');

    // No checkout at all is reported as skipped and compares nothing for that entry; the group still has to compare.
    // MIND_SITE_DIR names the checkout when it is not a sibling, and a copy found there is compared.
    erase($siteRepo . '/lib');
    rmdir($siteRepo);
    $before = $tree();
    [$status, $output] = $sharedRun(['--external']);
    check($status === 0 && str_contains($output, 'external site-lib-mindsuite-auth-php: skipped (no checkout at ') &&
        str_contains($output, 'compared 1 file(s)') && $lastLine($output) === '1 group(s): 0 drifted, 0 failures' &&
        !file_exists($siteRepo) && $tree() === $before, 'a missing site checkout is reported as skipped and nothing is created');
    $elsewhere = $shared . '/elsewhere';
    mkdir($elsewhere . '/lib', 0700, true);
    file_put_contents($elsewhere . '/lib/mindsuite-auth.php', 'origin');
    $before = $tree();
    [$status, $output] = $sharedRun(['--external'], ['MIND_SITE_DIR' => $elsewhere]);
    check($status === 0 && str_contains($output, 'compared 2 file(s)') && !str_contains($output, 'skipped') && $tree() === $before,
        'MIND_SITE_DIR names a site checkout that is not a sibling');

    $empty = ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []];
    $key = bin2hex(random_bytes(32));
    $prod = msa_config('prod', $key, $store);
    $test = msa_config('test', $key, $store, '/test/');
    $dev = msa_config('dev', $key, $store);
    check([$prod['cookie'], $test['cookie'], $dev['cookie']] === ['MSSESS', 'MSSESS_TEST', 'MSSESS_DEV'] &&
        $test['cookie_path'] === '/test/' && $dev['cookie_path'] === '/', 'instance-specific cookies and paths');
    check(refused(fn() => msa_config('prod', '', $store)) && refused(fn() => msa_config('bogus', $key, $store)) &&
        refused(fn() => msa_config('dev', $key, $store, '/test/')), 'bad environment, key and cookie path are refused');
    check(refused(fn() => lg($prod, 'sample', 'password')), 'a missing store fails closed');
    foreach ([$prod, $test, $dev] as $cfg) { msa_store_write($cfg, $empty); }

    $prod['invite_code'] = 'sample-invite';
    $prod['rp_id'] = 'mindsuite.example';
    $prod['origin'] = 'https://mindsuite.example';
    check(!msa_signup($prod, 'sample', 'sample@example.test', 'password', 'wrong-invite'), 'invite required');
    check(msa_signup($prod, 'SaMpLe', 'sample@example.test', 'password', 'sample-invite'), 'signup normalizes the username');
    check(!msa_signup($prod, 'SAMPLE', 'sample@example.test', 'password', 'sample-invite'), 'signup refuses a normalized duplicate');
    check(lg($prod, 'sample', 'guess') === null, 'wrong password is refused');
    $web = lg($prod, 'SAMPLE', 'password', 'Browser');
    $native = lg($prod, 'sample', 'password', 'Native');
    check($web !== null && $native !== null && $web['token'] !== $native['token'], 'two logins mint distinct tokens');
    $cookies = ['MSSESS' => $web['token']];
    $cookieSession = msa_session($prod, [], $cookies);
    $nativeSession = msa_session($prod, bearer($native['token']), $cookies);
    check($cookieSession['user'] === 'sample' && $cookieSession['carrier'] === 'cookie' &&
        $nativeSession['user'] === 'sample' && $nativeSession['carrier'] === 'bearer', 'either carrier authenticates');
    check(msa_user($prod, bearer(str_repeat('0', 64)), $cookies) === null &&
        msa_user($prod, ['HTTP_AUTHORIZATION' => 'Basic broken'], $cookies) === null, 'invalid Authorization never falls back to a cookie');
    $sameSite = ['HTTP_SEC_FETCH_SITE' => 'same-origin', 'HTTP_X_CSRF_TOKEN' => $web['csrf']];
    check(msa_write_allowed($cookieSession, $sameSite) && !msa_write_allowed($cookieSession, []) &&
        !msa_write_allowed($cookieSession, array_replace($sameSite, ['HTTP_SEC_FETCH_SITE' => 'cross-site'])) &&
        !msa_write_allowed($cookieSession, array_replace($sameSite, ['HTTP_X_CSRF_TOKEN' => $native['csrf']])) &&
        msa_write_allowed($nativeSession, []) && !msa_write_allowed(null, bearer($native['token'])), 'cookie writes require same-site CSRF and valid bearer writes are exempt');
    check(msa_user($test, [], $cookies) === null && msa_user($dev, bearer($native['token']), []) === null &&
        msa_user($test, [], ['MSSESS_TEST' => $web['token']]) === null, 'tokens cannot cross instance stores');

    $db = msa_store_read($prod);
    $digest = hash('sha256', $native['token']);
    check(isset($db['sessions'][$digest]) && $db['sessions'][$digest]['device'] === 'Native' &&
        !str_contains(json_encode($db, JSON_THROW_ON_ERROR), $native['token']) &&
        !str_contains(file_get_contents($prod['data_dir'] . '/auth.json'), 'sample'), 'encrypted store holds token digests only');
    $db['sessions'][$digest]['last_seen'] = time() - 3601;
    msa_store_write($prod, $db);
    check(msa_user($prod, bearer($native['token']), []) === 'sample' &&
        msa_store_read($prod)['sessions'][$digest]['last_seen'] > time() - 20, 'successful access refreshes last seen');
    msa_revoke($prod, $cookieSession);
    check(msa_user($prod, [], $cookies) === null && msa_user($prod, bearer($native['token']), []) === 'sample', 'revocation removes only that token');
    $next = lg($prod, 'sample', 'password');
    msa_revoke_all($prod, $nativeSession);
    check(msa_user($prod, bearer($native['token']), []) === null && msa_user($prod, bearer($next['token']), []) === null, 'revoke everywhere removes other sessions too');
    check(msa_account_gen(msa_store_read($prod), 'sample') === 1, 'sign out everywhere raises the account revocation generation');

    $account = lg($prod, 'sample', 'password');
    $session = msa_session($prod, bearer($account['token']), []);
    check(msa_change_password($prod, $session, 'password', 'replacement') &&
        msa_user($prod, bearer($account['token']), []) === null && lg($prod, 'sample', 'password') === null,
        'password change replaces the old password and revokes tokens');
    check(msa_account_gen(msa_store_read($prod), 'sample') === 2, 'a password change raises the generation');
    $db = msa_store_read($prod);
    $db['accounts']['sample']['transition_hashes'] = [password_hash('transition', PASSWORD_BCRYPT, ['cost' => 4])];
    $db['accounts']['sample']['transition_until'] = time() + 60;
    msa_store_write($prod, $db);
    $account = lg($prod, 'sample', 'transition');
    check($account !== null && lg($prod, 'sample', 'replacement') === null &&
        !isset(msa_store_read($prod)['accounts']['sample']['transition_hashes']), 'first legacy sign-in consumes alternatives');
    $db = msa_store_read($prod);
    $db['accounts']['sample']['transition_hashes'] = [password_hash('expired', PASSWORD_BCRYPT, ['cost' => 4])];
    $db['accounts']['sample']['transition_until'] = time() - 1;
    msa_store_write($prod, $db);
    check(lg($prod, 'sample', 'expired') === null, 'expired legacy alternative is rejected');
    for ($attempt = 0; $attempt < 3; $attempt++) { lg($prod, 'sample', 'guess'); }
    check(lg($prod, 'sample', 'transition') === null &&
        msa_lockout_until($prod, 'sample') > time(), 'five wrong attempts block even the correct password');

    $report = msa_migration_report(['site' => ['Same', 'sample', 'invalid.name'], 'calmind' => ['same', 'sample', '12']]);
    check($report === [
        'accounts' => [
            ['username' => '12', 'sources' => ['calmind'], 'spellings' => ['12'], 'collision' => false],
            ['username' => 'same', 'sources' => ['calmind', 'site'], 'spellings' => ['Same', 'same'], 'collision' => true],
            ['username' => 'sample', 'sources' => ['calmind', 'site'], 'spellings' => ['sample'], 'collision' => false],
        ],
        'invalid' => [['source' => 'site', 'username' => 'invalid.name']],
    ], 'inventory reports collisions and source overlap without credentials');
    check(refused(fn() => msa_migration_report(['site' => [['hash' => 'bad fixture']]])),
        'inventory refuses account records rather than returning them');

    $session = msa_session($prod, bearer($account['token']), []);
    $registration = msa_passkey_register_begin($prod, $session);
    $private = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    $point = openssl_pkey_get_details($private)['ec'];
    $cose = "\xa5\x01\x02\x03\x26\x20\x01\x21\x58\x20" . str_pad($point['x'], 32, "\0", STR_PAD_LEFT) .
        "\x22\x58\x20" . str_pad($point['y'], 32, "\0", STR_PAD_LEFT);
    $rpHash = hash('sha256', $prod['rp_id'], true);
    $id = random_bytes(32);
    $auth = $rpHash . "\x45" . pack('N', 0) . str_repeat("\0", 16) . pack('n', strlen($id)) . $id . $cose;
    $attestation = "\xa3\x63fmt\x64none\x67attStmt\xa0\x68authData\x58" . chr(strlen($auth)) . $auth;
    $response = [
        'clientDataJSON' => b64u_encode(client_data('webauthn.create', $registration['challenge'], $prod['origin'])),
        'attestationObject' => b64u_encode($attestation), 'label' => 'fixture passkey',
    ];
    $passkey = b64u_encode($id);
    check(msa_passkey_register_finish($prod, array_replace($session, ['id' => str_repeat('0', 64)]), $response) === null &&
        msa_passkey_register_finish($prod, $session, $response) === $passkey &&
        msa_passkey_register_finish($prod, $session, $response) === null, 'passkey registration is session-bound and single-use');
    check(msa_passkey_list($prod, $session)[0]['label'] === 'fixture passkey', 'passkey list exposes account metadata');

    $assertion = static function (int $count, string $origin, bool $crossOrigin = false) use ($prod, $passkey, $private, $rpHash): array {
        $challenge = msa_passkey_login_begin($prod)['challenge'];
        $client = client_data('webauthn.get', $challenge, $origin, $crossOrigin);
        $auth = $rpHash . "\x05" . pack('N', $count);
        openssl_sign($auth . hash('sha256', $client, true), $signature, $private, OPENSSL_ALGO_SHA256);
        return ['id' => $passkey, 'clientDataJSON' => b64u_encode($client),
            'authenticatorData' => b64u_encode($auth), 'signature' => b64u_encode($signature), 'userHandle' => b64u_encode('sample')];
    };
    $response = $assertion(1, $prod['origin']);
    $db = msa_store_read($prod);
    unset($db['accounts']['sample']['first_login']);
    msa_store_write($prod, $db);
    $signedIn = msa_passkey_login_finish($prod, $response);
    check(isset(msa_store_read($prod)['accounts']['sample']['first_login']), 'a passkey sign-in stamps first_login too');
    check($signedIn !== null && msa_user($prod, bearer($signedIn['token']), []) === 'sample' &&
        msa_passkey_login_finish($prod, $response) === null, 'verified passkey mints a shared session and refuses replay');
    $expiredAssertion = $assertion(2, $prod['origin']);
    $expiredChallenge = json_decode(b64u_decode($expiredAssertion['clientDataJSON']), true)['challenge'];
    $db = msa_store_read($prod);
    $db['challenges'][$expiredChallenge]['created'] = time() - WEBAUTHN_CHALLENGE_TTL - 1;
    msa_store_write($prod, $db);
    check(msa_passkey_login_finish($prod, $expiredAssertion) === null, 'expired passkey challenge is refused');
    check(msa_passkey_login_finish($prod, $assertion(1, $prod['origin'])) === null &&
        msa_passkey_login_finish($prod, $assertion(2, 'https://other.example')) === null &&
        msa_passkey_login_finish($prod, $assertion(2, $prod['origin'], true)) === null &&
        msa_passkey_login_finish($prod, array_replace($assertion(2, $prod['origin']), ['signature' => b64u_encode('invalid')])) === null,
        'passkey rejects stale counters, foreign origins, cross-origin embeds and invalid signatures');
    check(msa_passkey_remove($prod, $session, $passkey) && msa_passkey_list($prod, $session) === [] &&
        msa_passkey_login_finish($prod, $assertion(2, $prod['origin'])) === null, 'removed passkey cannot sign in again');

    // A synced third-party provider (a password manager's passkeys on a phone), as a software authenticator: ES256,
    // backup-eligible and backed-up flags, a counter that is always 0, `packed` self-attestation although `none` was asked
    // for, no userHandle from the page. The owner's phone uses one; each refusal path is pinned here.
    $cborBytes = static fn(string $b): string => (strlen($b) < 24 ? chr(0x40 | strlen($b)) : (strlen($b) < 256 ? "\x58" . chr(strlen($b)) : "\x59" . pack('n', strlen($b)))) . $b;
    $provider = static function (int $flags, string $fmt) use ($prod, $session, $rpHash, $cborBytes): array {
        $options = msa_passkey_register_begin($prod, $session);
        $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $ec = openssl_pkey_get_details($key)['ec'];
        $cose = "\xa5\x01\x02\x03\x26\x20\x01\x21\x58\x20" . str_pad($ec['x'], 32, "\0", STR_PAD_LEFT) . "\x22\x58\x20" . str_pad($ec['y'], 32, "\0", STR_PAD_LEFT);
        $credId = random_bytes(16);
        $auth = $rpHash . chr($flags | 0x40) . pack('N', 0) . random_bytes(16) . pack('n', strlen($credId)) . $credId . $cose;
        $client = client_data('webauthn.create', $options['challenge'], $prod['origin']);
        $stmt = "\xa0";
        if ($fmt === 'packed') {
            openssl_sign($auth . hash('sha256', $client, true), $sig, $key, OPENSSL_ALGO_SHA256);
            $stmt = "\xa2\x63alg\x26\x63sig" . $cborBytes($sig);
        }
        $object = "\xa3\x63fmt" . chr(0x60 | strlen($fmt)) . $fmt . "\x67attStmt" . $stmt . "\x68authData" . $cborBytes($auth);
        $id = msa_passkey_register_finish($prod, $session, ['clientDataJSON' => b64u_encode($client), 'attestationObject' => b64u_encode($object), 'label' => 'provider']);
        return [$id, $key, b64u_encode($credId), $options];
    };
    $providerGet = static function (string $credId, $key, int $flags) use ($prod, $rpHash): array {
        $client = client_data('webauthn.get', msa_passkey_login_begin($prod)['challenge'], $prod['origin']);
        $auth = $rpHash . chr($flags) . pack('N', 0);
        openssl_sign($auth . hash('sha256', $client, true), $sig, $key, OPENSSL_ALGO_SHA256);
        return ['id' => $credId, 'clientDataJSON' => b64u_encode($client), 'authenticatorData' => b64u_encode($auth), 'signature' => b64u_encode($sig)];
    };
    [$pkPacked, $kPacked, $idPacked, $opts] = $provider(0x1d, 'packed');
    check($opts['attestation'] === 'none' && ($opts['authenticatorSelection']['residentKey'] ?? '') === 'required' &&
        ($opts['authenticatorSelection']['requireResidentKey'] ?? false) === true && !isset($opts['authenticatorSelection']['authenticatorAttachment']) &&
        array_column($opts['pubKeyCredParams'], 'alg') === [COSE_ES256, COSE_RS256] && b64u_decode($opts['user']['id']) === 'sample',
        'registration asks for a discoverable credential in both spellings, any attachment, ES256 and RS256, user.id the account name');
    check($pkPacked === $idPacked, 'a provider answering packed self-attestation to attestation none is registered (the statement is never trusted)');
    [$pkNone, $kNone, $idNone] = $provider(0x1d, 'none');
    check($pkNone === $idNone, 'a backed-up, backup-eligible credential with attestation none is registered');
    $zeroes = true;
    for ($i = 0; $i < 3; $i++) { $zeroes = $zeroes && msa_passkey_login_finish($prod, $providerGet($idNone, $kNone, 0x1d)) !== null; }
    check($zeroes && msa_passkey_login_finish($prod, $providerGet($idPacked, $kPacked, 0x05)) !== null,
        'a synced provider that always reports counter 0 signs in again and again, with no userHandle sent');
    check(msa_passkey_login_finish($prod, $providerGet($idNone, $kNone, 0x19)) === null && $provider(0x19, 'none')[0] === null,
        'user verification stays required: an assertion or a registration without the UV flag is refused');
    [, $kStray, $idStray] = [null, openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']), b64u_encode(random_bytes(16))];
    $stray = $providerGet($idStray, $kStray, 0x1d);
    $strayChallenge = json_decode(b64u_decode($stray['clientDataJSON']), true)['challenge'];
    check(msa_passkey_login_finish($prod, $stray) === null && !isset(msa_store_read($prod)['challenges'][$strayChallenge]),
        'a well-formed passkey for this RP that the store does not hold (one made before the shared store) is refused, its challenge spent');
    check(msa_passkey_remove($prod, $session, $pkPacked) && msa_passkey_remove($prod, $session, $pkNone) && msa_passkey_list($prod, $session) === [],
        'the provider fixtures are removed again');

    $db = msa_store_read($prod);
    $db['sessions'][hash('sha256', $signedIn['token'])]['created'] = time() - MSA_SESSION_AGE - 1;
    $db['sessions'][hash('sha256', $signedIn['token'])]['last_seen'] = time() - MSA_SESSION_AGE - 1;
    msa_store_write($prod, $db);
    check(msa_user($prod, bearer($signedIn['token']), []) === null, 'an unused bearer is refused after a year');
    $db['sessions'][hash('sha256', $signedIn['token'])]['created'] = time();
    $db['sessions'][hash('sha256', $signedIn['token'])]['last_seen'] = time();
    $db['sessions'][hash('sha256', $signedIn['token'])]['csrf'] = '';
    msa_store_write($prod, $db);
    check(msa_user($prod, bearer($signedIn['token']), []) === null, 'malformed session fails closed');
    unset($db['sessions'][hash('sha256', $signedIn['token'])]);
    msa_store_write($prod, $db);

    // ---- Step 1 additions: a fresh store per area, cheap hashes injected so the lockout ladders stay fast.
    $cheap = static fn(string $pw): string => password_hash($pw, PASSWORD_BCRYPT, ['cost' => 4]);
    $fresh = static function (array $accounts) use ($key, $dir, $empty): array {
        $cfg = msa_config('dev', $key, $dir);
        if (is_dir($cfg['data_dir'])) { erase($cfg['data_dir']); }
        msa_store_write($cfg, ['accounts' => $accounts] + $empty);
        return $cfg;
    };
    $acct = static fn(string $pw, array $more = []): array => ['email' => 'x@example.test', 'hash' => password_hash($pw, PASSWORD_BCRYPT, ['cost' => 4]), 'created' => 1] + $more;

    // guarded requires: an app that already loaded its own copies of atomic.php and webauthn.php (other paths, same bytes)
    $own = $dir . '/own-copies';
    mkdir($own, 0700);
    copy(__DIR__ . '/../../packages/mind-server/lib/atomic.php', $own . '/atomic.php');
    copy(__DIR__ . '/../../packages/mind-server/lib/webauthn.php', $own . '/webauthn.php');
    $probe = 'require ' . var_export($own . '/atomic.php', true) . '; require ' . var_export($own . '/webauthn.php', true) .
        '; require ' . var_export(__DIR__ . '/../../packages/mind-server/lib/mindsuite-passkeys.php', true) . '; echo "loaded";';
    exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($probe) . ' 2>&1', $out, $st);
    check($st === 0 && implode('', $out) === 'loaded', 'the library loads after the app loaded its own atomic.php and webauthn.php');
    $out = [];
    exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg('require ' . var_export(__DIR__ . '/../../packages/mind-server/lib/mindsuite-passkeys.php', true) . '; require ' . var_export($own . '/atomic.php', true) . ';') . ' 2>&1', $out, $st);
    check($st !== 0, 'control: a later second copy of atomic.php still redeclares (the guard is what made the case above pass)');

    // session scope
    $cfg = $fresh(['sample' => $acct('password')]);
    $scoped = lg($cfg, 'sample', 'password', 'CalMind', '', 'calmind');
    $plain = lg($cfg, 'sample', 'password', 'Browser');
    $asCookie = msa_session($cfg, [], ['MSSESS_DEV' => $scoped['token']]);
    $asBearer = msa_session($cfg, bearer($scoped['token']), []);
    check($asCookie === null && $asBearer['user'] === 'sample' && $asBearer['scope'] === 'calmind' && $asBearer['carrier'] === 'bearer',
        'a scoped row is refused on the cookie carrier and returned to bearer callers');
    check(msa_session($cfg, [], ['MSSESS_DEV' => $plain['token']])['scope'] === '' && msa_session($cfg, bearer($plain['token']), [])['scope'] === '',
        'an unscoped row works on both carriers and reports no scope');
    check(msa_store_read($cfg)['sessions'][hash('sha256', $plain['token'])] !== null && !isset(msa_store_read($cfg)['sessions'][hash('sha256', $plain['token'])]['scope']),
        'an unscoped row stores no scope key');
    check(refused(fn() => lg($cfg, 'sample', 'password', '', '', 'Bad Scope')), 'a malformed scope is refused');
    $db = msa_store_read($cfg);
    $row = &$db['sessions'][hash('sha256', $scoped['token'])];
    $row['created'] = time() - 400 * 86400;
    $row['last_seen'] = time() - 2 * 86400;
    unset($row);
    msa_store_write($cfg, $db);
    check(msa_user($cfg, bearer($scoped['token']), [], 'calmind') === 'sample', 'a scoped row older than a year lives while it is used (sliding)');
    check(msa_user($cfg, bearer($scoped['token']), []) === null && msa_user($cfg, bearer($scoped['token']), [], 'other') === null && msa_user($cfg, bearer($scoped['token']), [], 'calmind') === 'sample',
        'a scoped bearer answers msa_user only to a caller that names its scope');
    $scopedNow = msa_session($cfg, bearer($scoped['token']), []);
    check(!msa_write_allowed($scopedNow, []) && !msa_write_allowed($scopedNow, [], 'other') && msa_write_allowed($scopedNow, [], 'calmind'), 'and msa_write_allowed refuses it unless the caller names the scope');
    $db = msa_store_read($cfg);
    $db['sessions'][hash('sha256', $scoped['token'])]['last_seen'] = time() - MSA_SESSION_AGE - 5;
    msa_store_write($cfg, $db);
    check(msa_user($cfg, bearer($scoped['token']), []) === null, 'a scoped row unused for a year is dead');

    // cookie sessions slide and the cookie is re-issued once it is past half its life (over real HTTP: the CLI keeps no header list)
    file_put_contents($dir . '/session.php', '<?php require ' . var_export(__DIR__ . '/../../packages/mind-server/lib/mindsuite-auth.php', true) .
        '; $c = msa_config("dev", getenv("KEY"), getenv("DIR")); $s = msa_session($c); header("Content-Type: text/plain"); echo json_encode($s === null ? null : ["renewed" => $s["renewed"], "user" => $s["user"]]);');
    $sock = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) explode(':', stream_socket_get_name($sock, false))[1];
    fclose($sock);
    $server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $dir], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes2, null, ['KEY' => $key, 'DIR' => $dir] + $_ENV);
    for ($i = 0; $i < 100 && !($conn = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2)); $i++) { usleep(20000); }
    if (isset($conn) && $conn) { fclose($conn); }
    $http = static function (array $headers) use ($port): array {
        $body = @file_get_contents('http://127.0.0.1:' . $port . '/session.php', false, stream_context_create(['http' => ['header' => implode("\r\n", $headers), 'ignore_errors' => true]]));
        return [json_decode((string) $body, true), array_values(array_filter($http_response_header ?? [], static fn($h) => stripos($h, 'Set-Cookie: MSSESS_DEV=') === 0))];
    };
    try {
        $cfg = $fresh(['sample' => $acct('password')]);
        $web = lg($cfg, 'sample', 'password', 'Browser');
        $id = hash('sha256', $web['token']);
        $cookie = 'Cookie: MSSESS_DEV=' . $web['token'];
        [$answer, $sent] = $http([$cookie]);
        check($answer['renewed'] === false && $answer['user'] === 'sample' && $sent === [], 'a young cookie is not re-issued');
        $db = msa_store_read($cfg);
        $db['sessions'][$id]['created'] = time() - 300 * 86400;
        $db['sessions'][$id]['last_seen'] = time() - 2 * 86400;
        msa_store_write($cfg, $db);
        $db['sessions'][$id]['created'] = time() - 400 * 86400;
        $db['sessions'][$id]['cookie_at'] = time() - (intdiv(MSA_SESSION_AGE, 2) - 3600);
        msa_store_write($cfg, $db);
        [$answer, $sent] = $http([$cookie]);
        check($answer['renewed'] === false && $sent === [], 'just under half its life it is not re-issued');
        $db = msa_store_read($cfg);
        $db['sessions'][$id]['cookie_at'] = time() - (intdiv(MSA_SESSION_AGE, 2) + 3600);
        msa_store_write($cfg, $db);
        $before = time();
        [$answer, $sent] = $http([$cookie]);
        check(preg_match('/Max-Age=(\d+)/', $sent[0] ?? '', $age) === 1 && $age[1] >= MSA_SESSION_AGE - 300 && $age[1] <= MSA_SESSION_AGE, 'the re-issued cookie lasts a fresh year (Max-Age)');
        $db = msa_store_read($cfg);
        $db['sessions'][$id]['cookie_at'] = time() - (intdiv(MSA_SESSION_AGE, 2) + 3600);
        msa_store_write($cfg, $db);
        $before = time();
        [$answer, $sent] = $http([$cookie]);
        check($answer['renewed'] === true && count($sent) === 1 && str_contains($sent[0], 'HttpOnly') && str_contains($sent[0], 'SameSite=Lax') &&
            str_contains($sent[0], 'secure') && str_contains($sent[0], $web['token']), 'past half its life the cookie is sent again with a fresh year');
        $stored = msa_store_read($cfg)['sessions'][$id];
        check($stored['cookie_at'] >= $before && $stored['last_seen'] >= $before, 'renewal records the new cookie time and slides the row');
        [$answer, $sent] = $http([$cookie]);
        check($answer['renewed'] === false && $sent === [], 'and is not sent again on the next request');
        $db = msa_store_read($cfg);
        $db['sessions'][$id]['cookie_at'] = time() - 300 * 86400;
        msa_store_write($cfg, $db);
        [$answer, $sent] = $http(['Authorization: Bearer ' . $web['token']]);
        check($answer['renewed'] === false && $sent === [], 'a bearer caller never gets a cookie');
        $db['sessions'][$id]['created'] = time() - 700 * 86400;
        $db['sessions'][$id]['cookie_at'] = time() - 700 * 86400;
        $db['sessions'][$id]['last_seen'] = time() - 370 * 86400;
        msa_store_write($cfg, $db);
        check($http([$cookie])[0] === null, 'a cookie session unused for a year is dead');
    } finally {
        proc_terminate($server);
        proc_close($server);
    }

    // lockout per account and client address
    $cfg = $fresh(['sample' => $acct('password'), 'other' => $acct('password')]);
    for ($i = 0; $i < 5; $i++) { lg($cfg, 'sample', 'guess', '', '203.0.113.9'); }
    check(msa_lockout_until($cfg, 'sample', '203.0.113.9') > time() && lg($cfg, 'sample', 'password', '', '203.0.113.9') === null,
        'five wrong guesses lock the account for that address, even against the right password');
    check(lg($cfg, 'sample', 'password', '', '198.51.100.7') !== null && msa_lockout_until($cfg, 'sample', '198.51.100.7') === 0 &&
        msa_lockout_until($cfg, 'sample') === 0 && lg($cfg, 'sample', 'password') !== null, 'a second address and the old shared bucket are not locked');
    check(lg($cfg, 'other', 'password', '', '203.0.113.9') !== null, 'the lock is per account');
    $db = msa_store_read($cfg);
    check(!isset($db['accounts']['sample']['lockout']) && count($db['accounts']['sample']['lockouts']) === 1 &&
        !str_contains(json_encode($db['accounts']['sample']['lockouts']), '203.0.113.9'), 'buckets are keyed by a digest of the address');
    for ($i = 0; $i < 5; $i++) { lg($cfg, 'sample', 'guess'); }
    check(msa_lockout_until($cfg, 'sample') > time() && lg($cfg, 'sample', 'password') === null && lg($cfg, 'sample', 'password', '', '198.51.100.7') !== null,
        'client "" is the old single bucket');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['lockouts'] = array_map(static fn($b) => array_replace($b, ['until' => time() - 60]), $db['accounts']['sample']['lockouts']);
    msa_store_write($cfg, $db);
    for ($i = 0; $i < 5; $i++) { lg($cfg, 'sample', 'guess', '', '203.0.113.9'); }
    $rounds = msa_store_read($cfg)['accounts']['sample']['lockouts'][hash('sha256', '203.0.113.9')];
    check($rounds['rounds'] === 2 && $rounds['until'] > time() + 9 * 60, 'the ladder still climbs for a repeat offender (second round, ten minutes)');
    check(msa_admin_unlock($cfg, 'SAMPLE') && msa_lockout_until($cfg, 'sample', '203.0.113.9') === 0 && msa_lockout_until($cfg, 'sample') === 0 &&
        !isset(msa_store_read($cfg)['accounts']['sample']['lockouts']) && !msa_admin_unlock($cfg, 'nobody'), 'unlock clears every bucket and refuses a missing account');
    // bounds
    $db = msa_store_read($cfg);
    $old = hash('sha256', 'long-gone');
    $db['accounts']['sample']['lockouts'] = [$old => ['tries' => 0, 'rounds' => 1, 'until' => time() - 25 * 3600, 'seen' => time() - 26 * 3600]];
    msa_store_write($cfg, $db);
    lg($cfg, 'sample', 'guess', '', '192.0.2.1');
    check(!isset(msa_store_read($cfg)['accounts']['sample']['lockouts'][$old]) && isset(msa_store_read($cfg)['accounts']['sample']['lockouts'][hash('sha256', '192.0.2.1')]),
        'a bucket is dropped 24 hours after its end');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['lockouts'] = [];
    for ($i = 0; $i < MSA_LOCKOUT_BUCKETS + 40; $i++) { $db['accounts']['sample']['lockouts'][hash('sha256', "fill-$i")] = ['tries' => 1, 'rounds' => 0, 'until' => 0, 'seen' => time() - 1000 + $i]; }
    msa_store_write($cfg, $db);
    lg($cfg, 'sample', 'guess', '', '192.0.2.2');
    $rows = msa_store_read($cfg)['accounts']['sample']['lockouts'];
    check(count($rows) === MSA_LOCKOUT_BUCKETS && isset($rows[hash('sha256', '192.0.2.2')]) && !isset($rows[hash('sha256', 'fill-0')]) && isset($rows[hash('sha256', 'fill-' . (MSA_LOCKOUT_BUCKETS + 39))]),
        'at most 200 buckets per account, the oldest evicted first');

    // first_login, account_exists
    $cfg = $fresh(['sample' => $acct('password')]);
    check(!isset(msa_store_read($cfg)['accounts']['sample']['first_login']) && msa_account_exists($cfg, 'Sample') && !msa_account_exists($cfg, 'nobody') && !msa_account_exists($cfg, 'bad name'), 'account_exists normalises and answers for the store');
    lg($cfg, 'sample', 'password');
    $first = msa_store_read($cfg)['accounts']['sample']['first_login'];
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['first_login'] = $first - 500;
    msa_store_write($cfg, $db);
    lg($cfg, 'sample', 'password');
    check($first >= time() - 5 && msa_store_read($cfg)['accounts']['sample']['first_login'] === $first - 500, 'the first sign-in is stamped once and never moved');

    // password change with an in-window transition hash
    $cfg = $fresh(['sample' => $acct('unified1', ['transition_hashes' => [$cheap('legacy12')], 'transition_until' => time() + 3600])]);
    $web = lg($cfg, 'sample', 'unified1');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy12')];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    $session = msa_session($cfg, bearer($web['token']), []);
    check(!msa_change_password($cfg, $session, 'nonsense', 'replacement') && msa_change_password($cfg, $session, 'legacy12', 'replacement') &&
        lg($cfg, 'sample', 'replacement') !== null && lg($cfg, 'sample', 'legacy12') === null && lg($cfg, 'sample', 'unified1') === null &&
        !isset(msa_store_read($cfg)['accounts']['sample']['transition_hashes']), 'the old password for a change may be the in-window transition one, and the change consumes it');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy99')];
    $db['accounts']['sample']['transition_until'] = time() - 5;
    msa_store_write($cfg, $db);
    $again = lg($cfg, 'sample', 'replacement');
    check(!msa_change_password($cfg, msa_session($cfg, bearer($again['token']), []), 'legacy99', 'another1'), 'an expired transition hash cannot be the old password');

    // admin set-hash
    $cfg = $fresh(['sample' => $acct('password', ['transition_hashes' => [$cheap('legacy12')], 'transition_until' => time() + 3600]), 'other' => $acct('password')]);
    $a = lg($cfg, 'sample', 'password', 'Phone', '', 'calmind');
    $b = lg($cfg, 'sample', 'password', 'Browser');
    $c = lg($cfg, 'other', 'password');
    for ($i = 0; $i < 5; $i++) { lg($cfg, 'sample', 'guess', '', '203.0.113.9'); }
    $new = $cheap('brand-new-1');
    check(!msa_admin_set_hash($cfg, 'sample', 'plaintext-not-a-hash') && !msa_admin_set_hash($cfg, 'sample', '$2y$04$short') && !msa_admin_set_hash($cfg, 'nobody', $new),
        'set-hash refuses a non-bcrypt value and a missing account');
    check(msa_admin_set_hash($cfg, 'SAMPLE', $new) && lg($cfg, 'sample', 'brand-new-1', '', '203.0.113.9') !== null && lg($cfg, 'sample', 'password') === null &&
        msa_user($cfg, bearer($a['token']), []) === null && msa_user($cfg, bearer($b['token']), []) === null && msa_user($cfg, bearer($c['token']), []) === 'other',
        'set-hash replaces the password, clears lockouts and revokes every session of that account only');
    check(!isset(msa_store_read($cfg)['accounts']['sample']['transition_hashes']) && lg($cfg, 'sample', 'legacy12') === null, 'and closes any transition window');
    check(msa_account_gen(msa_store_read($cfg), 'sample') > 0 && msa_account_gen(msa_store_read($cfg), 'other') === 0, 'set-hash raises only that account\'s revocation generation');

    // account email (CalMind recover on the shared store)
    $withEmail = static fn(mixed $email): array => ['email' => $email, 'hash' => password_hash('password', PASSWORD_BCRYPT, ['cost' => 4]), 'created' => 1];
    $cfg = $fresh([
        'sample' => $acct('password'), 'noemail' => ['hash' => $cheap('password'), 'created' => 1], 'blank' => $withEmail(''),
        'notmail' => $withEmail('not an address'), 'inject' => $withEmail("a@example.test\r\nBcc: b@example.test"),
        'number' => $withEmail(7), 'mixed' => $withEmail('Mixed.Case@Example.Test'),
    ]);
    $before = file_get_contents($cfg['data_dir'] . '/auth.json');
    check(msa_account_email($cfg, 'sample') === 'x@example.test' && msa_account_email($cfg, 'SaMpLe') === 'x@example.test',
        'the account email is found by the normalised username');
    check(msa_account_email($cfg, 'mixed') === 'Mixed.Case@Example.Test' && msa_account_email($cfg, 'MIXED') === 'Mixed.Case@Example.Test',
        'only the username is case-insensitive: the address comes back as stored');
    check(msa_account_email($cfg, 'nobody') === null && msa_account_email($cfg, 'bad name') === null && msa_account_email($cfg, '') === null &&
        msa_account_email($cfg, 'noemail') === null && msa_account_email($cfg, 'blank') === null && msa_account_email($cfg, 'number') === null,
        'an unknown or invalid name and an account without an address all answer null');
    check(msa_account_email($cfg, 'notmail') === null && msa_account_email($cfg, 'inject') === null, 'a stored value that is not an email address is no address (and no header injection)');
    check(file_get_contents($cfg['data_dir'] . '/auth.json') === $before, 'looking up an email writes nothing');

    // password reset (CalMind recover on the shared store; the caller has already checked its own recover code)
    $cfg = $fresh([
        'sample' => $acct('password', ['transition_hashes' => [$cheap('legacy12')], 'transition_until' => time() + 3600]),
        'other' => $acct('password'), 'third' => $acct('password'),
    ]);
    $scopedRow = lg($cfg, 'sample', 'password', 'Phone', '198.51.100.1', 'calmind');
    $cookieRow = lg($cfg, 'sample', 'password', 'Browser', '198.51.100.1');
    $bearerRow = lg($cfg, 'sample', 'password', 'Native', '198.51.100.1');
    $otherScoped = lg($cfg, 'other', 'password', 'Phone', '198.51.100.2', 'calmind');
    $otherCookie = lg($cfg, 'other', 'password', 'Browser', '198.51.100.2');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy12')];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    for ($i = 0; $i < 5; $i++) { lg($cfg, 'sample', 'guess', '', '203.0.113.9'); lg($cfg, 'other', 'guess', '', '203.0.113.9'); }
    for ($i = 0; $i < MSA_WIDE_TRIES; $i++) { lg($cfg, 'sample', 'guess', '', '10.6.0.' . $i); lg($cfg, 'other', 'guess', '', '10.6.0.' . $i); }
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['lockout'] = ['tries' => 2, 'rounds' => 0, 'until' => time() + 600];
    $db['accounts']['other']['gen'] = 4;
    msa_store_write($cfg, $db);
    $acc = msa_store_read($cfg)['accounts']['sample'];
    check(msa_lockout_until($cfg, 'sample', '203.0.113.9') > time() && ($acc['wide']['until'] ?? 0) > time() && isset($acc['lockouts']) && isset($acc['transition_hashes']),
        'control: the account is locked per address and account-wide, and holds a transition hash');
    $plannedGens = ['sample' => msa_account_gen(msa_store_read($cfg), 'sample'), 'other' => msa_account_gen(msa_store_read($cfg), 'other')];
    $otherBefore = msa_store_read($cfg)['accounts']['other'];
    $thirdBefore = msa_store_read($cfg)['accounts']['third'];
    $oldHash = $acc['hash'];

    check(msa_reset_password($cfg, 'SaMpLe', 'reset-pw-1'), 'a reset with a valid password succeeds (the username is normalised)');
    $after = msa_store_read($cfg);
    $resetAccount = $after['accounts']['sample'];
    check(msa_user($cfg, bearer($scopedRow['token']), [], 'calmind') === null && msa_user($cfg, [], ['MSSESS_DEV' => $cookieRow['token']]) === null &&
        msa_user($cfg, bearer($bearerRow['token']), []) === null && !isset($after['sessions'][hash('sha256', $scopedRow['token'])]) &&
        !isset($after['sessions'][hash('sha256', $cookieRow['token'])]) && !isset($after['sessions'][hash('sha256', $bearerRow['token'])]),
        'a reset revokes a scoped bearer, a cookie session and a plain bearer');
    check(msa_account_gen($after, 'sample') === $plannedGens['sample'] + 1, 'a reset raises the revocation generation by one');
    // the legacy token import checks, under the store lock, that no account of its plan moved: the plan is refused after a reset
    $importerWouldRefuse = static function (array $db, array $plan): bool {
        foreach ($plan as $u => $gen) { if (msa_account_gen($db, (string) $u) !== $gen) { return true; } }
        return false;
    };
    check($importerWouldRefuse($after, ['sample' => $plannedGens['sample']]) && !$importerWouldRefuse($after, ['other' => $plannedGens['other']]),
        'a token import plan made before the reset no longer matches the generation (refused), and one for another account still does');
    check($resetAccount['hash'] !== $oldHash && lg($cfg, 'sample', 'reset-pw-1', '', '203.0.113.9') !== null && lg($cfg, 'sample', 'password') === null &&
        lg($cfg, 'sample', 'legacy12') === null, 'the new password signs in (from a formerly locked address); the old and the transition one do not');
    check(!isset($resetAccount['lockout']) && !isset($resetAccount['lockouts']) && !isset($resetAccount['wide']) && !isset($resetAccount['transition_hashes']) && !isset($resetAccount['transition_until']),
        'a reset clears the lockout buckets, the account-wide ceiling and any transition hash');
    check(msa_lockout_until($cfg, 'sample', '203.0.113.9') === 0 && msa_lockout_until($cfg, 'sample', '10.99.0.1') === 0 && msa_lockout_until($cfg, 'sample') === 0,
        'and the account is not locked for any address afterwards');
    $afterAll = msa_store_read($cfg);
    check($afterAll['accounts']['other'] === $otherBefore && $afterAll['accounts']['third'] === $thirdBefore &&
        msa_user($cfg, bearer($otherScoped['token']), [], 'calmind') === 'other' && msa_user($cfg, [], ['MSSESS_DEV' => $otherCookie['token']]) === 'other' &&
        msa_lockout_until($cfg, 'other', '203.0.113.9') > time() && msa_account_gen($afterAll, 'other') === 4,
        'a reset never touches another account: its hash, lockouts, generation and sessions are unchanged');
    check($resetAccount['email'] === 'x@example.test' && $resetAccount['created'] === 1 && isset($resetAccount['first_login']), 'the email and the rest of the account record are kept');

    // refusals leave the store byte for byte as it was
    $keep = lg($cfg, 'sample', 'reset-pw-1', 'x', 'a');
    $bytes = file_get_contents($cfg['data_dir'] . '/auth.json');
    check(!msa_reset_password($cfg, 'nobody', 'reset-pw-2') && !msa_reset_password($cfg, 'bad name', 'reset-pw-2') && !msa_reset_password($cfg, '', 'reset-pw-2'),
        'an unknown or invalid account returns false');
    check(!msa_reset_password($cfg, 'sample', '') && !msa_reset_password($cfg, 'sample', 'short') && !msa_reset_password($cfg, 'sample', str_repeat('a', 73)) &&
        !msa_reset_password($cfg, 'sample', "nul\0byte-password"), 'an empty, short, over-long or NUL-carrying password returns false');
    check(file_get_contents($cfg['data_dir'] . '/auth.json') === $bytes && msa_user($cfg, bearer($keep['token']), []) === 'sample' &&
        lg($cfg, 'sample', 'reset-pw-1') !== null, 'and a refused reset changes nothing: store bytes, session and password stay');
    // the input is only ever a password: what is stored is a fresh bcrypt hash, even when the input itself looks like a hash
    $lookalike = $cheap('some-other-secret');
    check(strlen($lookalike) === 60 && msa_reset_password($cfg, 'sample', $lookalike), 'a 60-character hash-shaped input is accepted as a password');
    $stored = msa_store_read($cfg)['accounts']['sample']['hash'];
    check($stored !== $lookalike && preg_match('/\A\$2y\$\d\d\$[.\/A-Za-z0-9]{53}\z/', $stored) === 1 && password_get_info($stored)['algoName'] === 'bcrypt' &&
        password_verify($lookalike, $stored) && lg($cfg, 'sample', 'some-other-secret') === null && lg($cfg, 'sample', $lookalike) !== null,
        'a non-bcrypt (or hash-shaped) input is never stored: only its fresh bcrypt hash is, and the input works as a password');
    check(msa_reset_password($cfg, 'sample', 'plain-secret-77') && !str_contains(file_get_contents($cfg['data_dir'] . '/auth.json'), 'plain-secret-77') &&
        !str_contains(json_encode(msa_store_read($cfg)), 'plain-secret-77') && password_verify('plain-secret-77', msa_store_read($cfg)['accounts']['sample']['hash']),
        'a plaintext password appears nowhere in the store');
    check(msa_account_gen(msa_store_read($cfg), 'sample') === $plannedGens['sample'] + 3, 'each successful reset raised the generation again, the refused ones did not');
    // an account that never had a gen starts from zero; a store with other users' rows and a dead row still reads
    $cfg = $fresh(['sample' => $acct('password'), 'other' => $acct('password')]);
    $db = msa_store_read($cfg);
    $db['sessions']['dead'] = 'not-a-row';
    msa_store_write($cfg, $db);
    $live = lg($cfg, 'other', 'password');
    check(msa_reset_password($cfg, 'sample', 'reset-pw-3') && msa_account_gen(msa_store_read($cfg), 'sample') === 1 && msa_account_gen(msa_store_read($cfg), 'other') === 0 &&
        msa_user($cfg, bearer($live['token']), []) === 'other', 'a first reset takes the generation from 0 to 1, leaves other sessions alone and is not stopped by a malformed session row');
    // an unreadable store fails closed, as for every other operation
    $broken = msa_config('dev', $key, $dir);
    file_put_contents($broken['data_dir'] . '/auth.json', 'MSA1:damaged');
    check(refused(fn() => msa_reset_password($broken, 'sample', 'reset-pw-4')) && refused(fn() => msa_account_email($broken, 'sample')) &&
        file_get_contents($broken['data_dir'] . '/auth.json') === 'MSA1:damaged', 'a damaged store fails closed for both functions and is preserved');

    // app config
    $site = ['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'k', 'prod' => 'p'], 'mindsuite_invite_code' => '5678', 'mindsuite_store_root' => $dir];
    $appCfg = msa_app_config('test', $site, 'calmind', '/');
    check($appCfg !== null && $appCfg['cookie'] === 'MSSESS_TEST' && $appCfg['rp_id'] === 'test.seancheren.com' && $appCfg['origin'] === 'https://test.seancheren.com' &&
        $appCfg['invite_code'] === '5678' && $appCfg['data_dir'] === $dir . '/mindsuite-auth-test', 'app config resolves key, store, cookie, relying party and invite');
    check(msa_app_config('prod', $site, 'calmind') === null && msa_app_config('dev', $site, 'calmind') === null, 'an instance that is not switched on has no config');
    check(msa_app_config('test', $site + ['mindsuite_auth_hold' => ['test' => ['calmind']]], 'calmind') === null &&
        msa_app_config('test', $site + ['mindsuite_auth_hold' => ['test' => ['calmind']]], 'readmind') !== null &&
        msa_app_config('test', $site + ['mindsuite_auth_hold' => ['prod' => ['calmind']]], 'calmind') !== null, 'a hold is per app and per instance');
    check(msa_app_config('test', $site + ['mindsuite_signup_closed' => true], 'calmind')['invite_code'] === '' &&
        !msa_signup(msa_app_config('test', $site + ['mindsuite_signup_closed' => true], 'calmind'), 'newone', 'n@example.test', 'password', ''), 'a closed sign-up empties the invite');
    check(refused(fn() => msa_app_config('dev', ['mindsuite_auth_instances' => ['dev']], 'calmind')) && refused(fn() => msa_app_config('test', $site, 'Bad App')),
        'a switched-on instance without a key, and a bad app name, are refused');
    check(msa_app_config('prod', ['mindsuite_auth_keys' => ['prod' => 'p']], 'site', '/', true)['cookie'] === 'MSSESS', 'an operator tool may read the config before the switch');

    // old stores still read: no scope, no first_login, no buckets, no cookie_at
    $cfg = $fresh(['sample' => ['email' => 'x@example.test', 'hash' => $cheap('password'), 'created' => 1, 'lockout' => ['tries' => 2, 'rounds' => 0, 'until' => 0]]]);
    $token = bin2hex(random_bytes(32));
    $db = msa_store_read($cfg);
    $db['sessions'][hash('sha256', $token)] = ['user' => 'sample', 'device' => 'old', 'created' => time() - 100, 'last_seen' => time() - 100, 'csrf' => bin2hex(random_bytes(32))];
    msa_store_write($cfg, $db);
    check(msa_user($cfg, bearer($token), []) === 'sample' && msa_session($cfg, [], ['MSSESS_DEV' => $token])['scope'] === '' && lg($cfg, 'sample', 'password') !== null &&
        !isset(msa_store_read($cfg)['accounts']['sample']['lockout']), 'a store written before these fields existed reads, signs in and clears the old bucket');

    // the read path holds only a shared lock
    $cfg = $fresh(['sample' => $acct('password')]);
    $web = lg($cfg, 'sample', 'password');
    $holder = fopen($cfg['data_dir'] . '/auth.lock', 'c');
    flock($holder, LOCK_SH);
    $child = 'require ' . var_export(__DIR__ . '/../../packages/mind-server/lib/mindsuite-auth.php', true) . '; $c = msa_config("dev", ' . var_export($key, true) . ', ' . var_export($dir, true) . ');' .
        ' echo msa_user($c, ["HTTP_AUTHORIZATION" => "Bearer ' . $web['token'] . '"], []) ?? "none";';
    $proc = proc_open([PHP_BINARY, '-r', $child], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $deadline = microtime(true) + 8;
    $status = proc_get_status($proc);
    while ($status['running'] && microtime(true) < $deadline) { usleep(50000); $status = proc_get_status($proc); }
    $finished = !$status['running'];
    if (!$finished) { proc_terminate($proc, 9); }
    $answer = stream_get_contents($pipes[1]);
    proc_close($proc);
    flock($holder, LOCK_UN);
    fclose($holder);
    check($finished && $answer === 'sample', 'an authenticated read is not blocked by another reader holding the lock');


    // ---- Account deletion (ticket #223): msa_account_delete(cfg, session, password, typed name, client)
    $params = (new ReflectionFunction('msa_account_delete'))->getParameters();
    check(count($params) === 5 && !$params[4]->isOptional(), 'msa_account_delete requires the caller\'s address, like msa_login');
    $auditFile = $dir . '/audit.log';
    $auditWas = ini_set('error_log', $auditFile);
    $delSetup = static function () use ($fresh, $acct): array {
        $cfg = $fresh(['sample' => $acct('password'), 'other' => $acct('otherpass'), 'probe-acct' => $acct('probepass')]);
        $mine = lg($cfg, 'sample', 'password', 'Browser');
        $mine2 = lg($cfg, 'sample', 'password', 'Phone');
        $scopedMine = lg($cfg, 'sample', 'password', 'CalMind', '', 'calmind');
        $theirs = lg($cfg, 'other', 'otherpass', 'Browser');
        $probe = lg($cfg, 'probe-acct', 'probepass', 'Probe');
        $db = msa_store_read($cfg);
        $db['passkeys']['pk-sample-1'] = ['user' => 'sample', 'pem' => 'x', 'signCount' => 0, 'label' => 'one', 'created' => 1];
        $db['passkeys']['pk-sample-2'] = ['user' => 'sample', 'pem' => 'x', 'signCount' => 0, 'label' => 'two', 'created' => 1];
        $db['passkeys']['pk-other-1'] = ['user' => 'other', 'pem' => 'x', 'signCount' => 0, 'label' => 'theirs', 'created' => 1];
        $db['challenges']['ch-sample'] = ['type' => 'webauthn.create', 'session' => hash('sha256', $mine['token']), 'created' => time()];
        $db['challenges']['ch-other'] = ['type' => 'webauthn.create', 'session' => hash('sha256', $theirs['token']), 'created' => time()];
        $db['import'] = ['tokens_marks' => ['sample' => 5], 'passkeys_seen' => ['pk-sample-1' => 5]];
        msa_store_write($cfg, $db);
        $cookie = static fn(string $token): ?array => msa_session($cfg, [], ['MSSESS_DEV' => $token]);
        return [$cfg, compact('mine', 'mine2', 'scopedMine', 'theirs', 'probe'), $cookie];
    };
    [$cfg, $tk, $cookie] = $delSetup();
    $me = $cookie($tk['mine']['token']);
    $before = msa_store_read($cfg);
    // a wrong password: refused, counted like a failed sign-in, nothing deleted
    check(!msa_account_delete($cfg, $me, 'wrong-guess', 'sample', '192.0.2.10'), 'a wrong password does not delete the account');
    $after = msa_store_read($cfg);
    check(isset($after['accounts']['sample']) && $after['sessions'] === $before['sessions'] && $after['passkeys'] === $before['passkeys'], 'a refused deletion leaves the sessions and passkeys alone');
    check(($after['accounts']['sample']['wide']['tries'] ?? 0) === 1 && msa_bucket($after['accounts']['sample'], '192.0.2.10')['tries'] === 1,
        'a wrong password counts as a failed sign-in: one account-wide try and one in the address bucket');
    for ($i = 0; $i < 4; $i++) { msa_account_delete($cfg, $me, 'wrong-guess', 'sample', '192.0.2.10'); }
    check(msa_lockout_until($cfg, 'sample', '192.0.2.10') > time(), 'five wrong passwords from one address lock that address, as for sign-in');
    check(!msa_account_delete($cfg, $me, 'password', 'sample', '192.0.2.10') && isset(msa_store_read($cfg)['accounts']['sample']), 'a locked account refuses the right password and is not deleted');
    // the typed name is not a guess: a mismatch is refused before any check and counts nothing
    [$cfg, $tk, $cookie] = $delSetup();
    $me = $cookie($tk['mine']['token']);
    check(!msa_account_delete($cfg, $me, 'password', 'other', '') && !msa_account_delete($cfg, $me, 'password', '', '') && !msa_account_delete($cfg, $me, 'password', 'sample ', ''),
        'another name, no name and a name with a stray space each refuse');
    check(isset(msa_store_read($cfg)['accounts']['sample']) && !isset(msa_store_read($cfg)['accounts']['sample']['wide']), 'a wrong confirmation name deletes nothing and counts nothing');
    check(!msa_account_delete($cfg, $cookie($tk['theirs']['token']), 'password', 'sample', '') && isset(msa_store_read($cfg)['accounts']['sample'], msa_store_read($cfg)['accounts']['other']),
        'a session can delete only its own account: another account\'s session with this one\'s name and password refuses');
    $scopedSession = msa_session($cfg, bearer($tk['scopedMine']['token']), []);
    check(!msa_account_delete($cfg, $scopedSession, 'password', 'sample', '') && isset(msa_store_read($cfg)['accounts']['sample']), 'a scoped (app token) session cannot delete the account');
    check(!msa_account_delete($cfg, ['user' => 'sample', 'id' => str_repeat('0', 64), 'carrier' => 'cookie', 'csrf' => 'x', 'scope' => ''], 'password', 'sample', '') && isset(msa_store_read($cfg)['accounts']['sample']),
        'a session that is not in the store (signed out meanwhile) cannot delete');
    // the deletion
    $others = msa_store_read($cfg);
    $keepOther = [$others['accounts']['other'], $others['sessions'][hash('sha256', $tk['theirs']['token'])], $others['passkeys']['pk-other-1'], $others['challenges']['ch-other'],
        $others['accounts']['probe-acct'], $others['sessions'][hash('sha256', $tk['probe']['token'])]];
    @unlink($auditFile);
    check(msa_account_delete($cfg, $me, 'password', 'sample', '192.0.2.11') === true, 'the right password and the typed name delete the account');
    $gone = msa_store_read($cfg);
    check(!isset($gone['accounts']['sample']), 'the account is gone');
    check(array_filter($gone['sessions'], static fn($r) => ($r['user'] ?? null) === 'sample') === [], 'every session of the account is gone, scoped app tokens included');
    check(array_filter($gone['passkeys'], static fn($r) => ($r['user'] ?? null) === 'sample') === [] && !isset($gone['challenges']['ch-sample']), 'its passkeys and its pending passkey challenge are gone');
    check([$gone['accounts']['other'], $gone['sessions'][hash('sha256', $tk['theirs']['token'])], $gone['passkeys']['pk-other-1'], $gone['challenges']['ch-other'],
        $gone['accounts']['probe-acct'], $gone['sessions'][hash('sha256', $tk['probe']['token'])]] === $keepOther,
        'another account, its session, passkey and challenge, and the status probe account and its session are byte for byte unchanged');
    check(array_keys($gone['accounts']) === ['other', 'probe-acct'] && count($gone['sessions']) === 2 && array_keys($gone['passkeys']) === ['pk-other-1'] && $gone['version'] === 1,
        'exactly one account, three sessions and two passkeys went');
    check(($gone['import'] ?? null) === $others['import'], 'the importer\'s records are kept, so a deleted account\'s legacy tokens and passkeys are not brought back by a later token scan');
    check(lg($cfg, 'sample', 'password', 'Browser') === null && lg($cfg, 'SAMPLE', 'password', 'Browser') === null, 'signing in afterwards fails');
    check($cookie($tk['mine']['token']) === null && $cookie($tk['mine2']['token']) === null && msa_session($cfg, bearer($tk['scopedMine']['token']), []) === null,
        'every old cookie and app token reads signed out');
    check($cookie($tk['theirs']['token'])['user'] === 'other' && lg($cfg, 'other', 'otherpass', 'x') !== null && lg($cfg, 'probe-acct', 'probepass', 'x') !== null, 'the other accounts keep working');
    check(msa_account_exists($cfg, 'sample') === false && !msa_account_delete($cfg, $me, 'password', 'sample', ''), 'a second delete of the same account does nothing');
    $audit = (string) @file_get_contents($auditFile);
    check(str_contains($audit, 'mindsuite account deleted: sample') && substr_count($audit, "\n") === 1, 'one audit line names the account');
    foreach ([$tk['mine']['token'], $tk['scopedMine']['token'], 'password', $others['accounts']['sample']['hash'], $tk['mine']['csrf']] as $secret) {
        check(!str_contains($audit, $secret), 'the audit line holds no password, hash, token or CSRF secret');
    }
    // a lockout does not stop a deletion by a person who is not locked: the transition password of a merged account is a password too
    [$cfg, $tk, $cookie] = $delSetup();
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [password_hash('legacy-pass', PASSWORD_BCRYPT, ['cost' => 4])];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    check(msa_account_delete($cfg, $cookie($tk['mine']['token']), 'legacy-pass', 'sample', '') && !isset(msa_store_read($cfg)['accounts']['sample']), 'a password still in its transition window re-authenticates, as for a password change');
    // store failures: nothing half-deleted
    [$cfg, $tk, $cookie] = $delSetup();
    $me = $cookie($tk['mine']['token']);
    $file = $cfg['data_dir'] . '/auth.json';
    $bytes = file_get_contents($file);
    if (function_exists('posix_geteuid') && posix_geteuid() !== 0 && PHP_OS_FAMILY !== 'Windows') {
        chmod($cfg['data_dir'], 0500);
        $threw = false;
        try { msa_account_delete($cfg, $me, 'password', 'sample', ''); } catch (RuntimeException) { $threw = true; }
        chmod($cfg['data_dir'], 0700);
        check($threw && file_get_contents($file) === $bytes && !glob($cfg['data_dir'] . '/*.tmp'), 'a store that cannot be written refuses the deletion and leaves the old store and no stray file');
    }
    file_put_contents($file, 'MSA1:damaged');
    $threw = false;
    try { msa_account_delete($cfg, $me, 'password', 'sample', ''); } catch (RuntimeException) { $threw = true; }
    check($threw && file_get_contents($file) === 'MSA1:damaged', 'a store that cannot be read refuses the deletion and is preserved');
    // legacy mode: an instance that is not switched on has no config, so nothing here can run
    check(msa_app_config('dev', [], 'site') === null && msa_app_config('dev', ['mindsuite_auth_instances' => ['test']], 'site') === null, 'an instance that is not switched on has no shared store to delete from');
    ini_set('error_log', $auditWas === false ? '' : $auditWas);

    // ---- Deleted names (ticket #223 follow-up): the name is held, no account can start under it, and a ceremony in flight cannot mint a session
    ini_set('error_log', $auditFile);
    [$cfg, $tk, $cookie] = $delSetup();
    $cfg += ['rp_id' => 'mindsuite.example', 'origin' => 'https://mindsuite.example', 'invite_code' => 'invite-1'];
    $me = $cookie($tk['mine']['token']);
    $wrongFirst = msa_account_delete($cfg, $me, 'wrong-guess', 'sample', '');
    check($wrongFirst === false && !isset(msa_store_read($cfg)['deleted']) && !msa_account_deleted($cfg, 'sample'), 'a refused deletion holds no name');
    $tombAt = time();
    check(msa_account_delete($cfg, $me, 'password', 'sample', '') === true, 'control: the deletion that holds the name');
    $held = msa_store_read($cfg)['deleted'];
    check(array_keys($held) === ['sample'] && array_keys($held['sample']) === ['at'] && is_int($held['sample']['at']) && $held['sample']['at'] >= $tombAt &&
        msa_account_deleted($cfg, 'sample') && msa_account_deleted($cfg, 'SAMPLE') && !msa_account_deleted($cfg, 'other') && !msa_account_deleted($cfg, 'not a name'),
        'a deleted name is held as the name and the time, nothing else');
    $heldAt = $held['sample']['at'];
    check(!msa_account_delete($cfg, $me, 'password', 'sample', '') && msa_store_read($cfg)['deleted']['sample']['at'] === $heldAt, 'a second delete leaves the held time as it was');
    // every way of creating an account under the name is refused
    $signedUp = [msa_signup($cfg, 'sample', 'new@example.test', 'new-password-1', 'invite-1'), msa_signup($cfg, 'SAMPLE', 'new@example.test', 'new-password-1', 'invite-1')];
    check($signedUp === [false, false] && !isset(msa_store_read($cfg)['accounts']['sample']) && lg($cfg, 'sample', 'new-password-1', '') === null, 'sign-up with the right invite under a deleted name is refused, in any case');
    check(msa_signup_name_deleted($cfg, 'Sample', 'invite-1') && !msa_signup_name_deleted($cfg, 'sample', 'wrong-invite') && !msa_signup_name_deleted($cfg, 'sample', '') &&
        !msa_signup_name_deleted($cfg, 'freshname', 'invite-1') && !msa_signup_name_deleted($cfg + ['invite_code' => ''], 'sample', ''),
        'the page may say so only to the holder of the invite, and only about a deleted name');
    check(msa_signup($cfg, 'freshname', 'new@example.test', 'new-password-1', 'invite-1') === true, 'control: another name signs up with the same invite');
    $aud = (string) @file_get_contents($auditFile);
    check(str_contains($aud, 'mindsuite sign-up refused: sample was deleted by its owner'), 'the refusal is in the error log with the name only');
    $db = msa_store_read($cfg);
    $db['accounts']['sample'] = ['email' => '', 'hash' => $cheap('x-password'), 'created' => time()];
    check(refused(fn() => msa_store_write($cfg, $db)) && !isset(msa_store_read($cfg)['accounts']['sample']),
        'no write of the store, from any caller, can leave an account under a deleted name');
    foreach (['sample' => 'a string', 'Sample' => ['at' => 1], 'ok-name' => 'x', 'ok-name2' => ['at' => 'soon']] as $badName => $badRow) {
        $db = msa_store_read($cfg);
        $db['deleted'] = [$badName => $badRow];
        $raw = $cfg['data_dir'] . '/auth.json';
        $iv = random_bytes(12);
        $tag = '';
        $enc = openssl_encrypt(json_encode($db), 'aes-256-gcm', $cfg['key'], OPENSSL_RAW_DATA, $iv, $tag, $cfg['environment']);
        $good = file_get_contents($raw);
        file_put_contents($raw, 'MSA1:' . base64_encode($iv . $tag . $enc));
        $threw = refused(fn() => msa_store_read($cfg));
        file_put_contents($raw, $good);
        check($threw, 'a damaged deleted-name list fails closed (' . json_encode([$badName => $badRow]) . ')');
    }
    // only the operator's explicit word lifts it
    check(msa_admin_undelete($cfg, 'nobody') === false && msa_admin_undelete($cfg, 'not a name') === false && msa_account_deleted($cfg, 'sample'), 'undelete of a name that is not held, or is no name, does nothing');
    check(msa_admin_undelete($cfg, 'Sample') === true && !msa_account_deleted($cfg, 'sample') && !isset(msa_store_read($cfg)['deleted']) && msa_admin_undelete($cfg, 'sample') === false,
        'undelete lifts the name once and removes the empty list');
    check(str_contains((string) @file_get_contents($auditFile), 'mindsuite deleted name lifted: sample'), 'the lift is in the error log');
    check(msa_signup($cfg, 'sample', 'new@example.test', 'new-password-1', 'invite-1') === true && lg($cfg, 'sample', 'new-password-1', '') !== null &&
        count(array_filter(msa_store_read($cfg)['passkeys'], static fn($r) => $r['user'] === 'sample')) === 0, 'after the lift the name is a new account: no old passkey, session or password comes with it');
    // the operator's other tools never bring an account back
    [$cfg, $tk, $cookie] = $delSetup();
    msa_account_delete($cfg, $cookie($tk['mine']['token']), 'password', 'sample', '');
    check(msa_admin_unlock($cfg, 'sample') === false && msa_admin_set_hash($cfg, 'sample', password_hash('abc-def-1', PASSWORD_BCRYPT, ['cost' => 4])) === false &&
        msa_reset_password($cfg, 'sample', 'brand-new-password') === false && !isset(msa_store_read($cfg)['accounts']['sample']), 'unlock, set-hash and a password reset never recreate a deleted account');

    // a ceremony in flight when the account is deleted
    $cfg = $fresh(['sample' => $acct('password'), 'other' => $acct('otherpass')]) + ['rp_id' => 'mindsuite.example', 'origin' => 'https://mindsuite.example'];
    $rpHash = hash('sha256', $cfg['rp_id'], true);
    $keyOf = static function (string $user) use ($cfg): array {
        $private = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $id = b64u_encode(random_bytes(32));
        $db = msa_store_read($cfg);
        $db['passkeys'][$id] = ['user' => $user, 'pem' => openssl_pkey_get_details($private)['key'], 'signCount' => 0, 'label' => 'fixture', 'created' => 1];
        msa_store_write($cfg, $db);
        return ['id' => $id, 'private' => $private, 'user' => $user];
    };
    $answer = static function (array $pk, string $challenge, int $count) use ($cfg, $rpHash): array {
        $client = client_data('webauthn.get', $challenge, $cfg['origin']);
        $auth = $rpHash . "\x05" . pack('N', $count);
        openssl_sign($auth . hash('sha256', $client, true), $signature, $pk['private'], OPENSSL_ALGO_SHA256);
        return ['id' => $pk['id'], 'clientDataJSON' => b64u_encode($client), 'authenticatorData' => b64u_encode($auth),
            'signature' => b64u_encode($signature), 'userHandle' => b64u_encode($pk['user'])];
    };
    $pk = $keyOf('sample');
    $sessionsBefore = count(msa_store_read($cfg)['sessions']);
    $challenge = msa_passkey_login_begin($cfg)['challenge'];
    $signedIn = msa_passkey_login_finish($cfg, $answer($pk, $challenge, 1), 'Browser');
    check($signedIn !== null && msa_user($cfg, bearer($signedIn['token']), []) === 'sample', 'control: the passkey ceremony signs the account in');
    // begun while the account existed, finished after its deletion: the deletion took the passkey, so nothing is minted
    $mine = msa_login($cfg, 'sample', 'password', 'Browser', '');
    $challenge = msa_passkey_login_begin($cfg)['challenge'];
    $response = $answer($pk, $challenge, 2);
    check(msa_account_delete($cfg, msa_session($cfg, bearer($mine['token']), []), 'password', 'sample', ''), 'the account is deleted between the passkey challenge and the answer');
    $sessions = count(msa_store_read($cfg)['sessions']);
    check(!isset(msa_store_read($cfg)['passkeys'][$pk['id']]) && msa_passkey_login_finish($cfg, $response, 'Browser') === null && count(msa_store_read($cfg)['sessions']) === $sessions,
        'a passkey answer for a challenge begun before the deletion mints no session');
    // the guard itself: a passkey row that outlived its account (damage, a bad restore) still signs nobody in
    $cfg2 = $fresh(['sample' => $acct('password'), 'other' => $acct('otherpass')]) + ['rp_id' => 'mindsuite.example', 'origin' => 'https://mindsuite.example'];
    $cfg = $cfg2;
    $pk = $keyOf('sample');
    $challenge = msa_passkey_login_begin($cfg)['challenge'];
    $response = $answer($pk, $challenge, 1);
    $db = msa_store_read($cfg);
    unset($db['accounts']['sample']);
    msa_store_write($cfg, $db);
    $sessions = count(msa_store_read($cfg)['sessions']);
    check(isset(msa_store_read($cfg)['passkeys'][$pk['id']]) && msa_passkey_login_finish($cfg, $response, 'Browser') === null &&
        count(msa_store_read($cfg)['sessions']) === $sessions && !isset(msa_store_read($cfg)['accounts']['sample']), 'a passkey whose account is gone signs in nobody and issues no session');
    $db = msa_store_read($cfg);
    $db['accounts']['sample'] = $acct('password');
    msa_store_write($cfg, $db);
    $challenge = msa_passkey_login_begin($cfg)['challenge'];
    check(msa_passkey_login_finish($cfg, $answer($pk, $challenge, 1), 'Browser') !== null, 'control: with the account back, the same passkey signs in (so only the account guard refused it)');
    // a registration begun by a session of the account is dead after the deletion
    [$cfg, $tk, $cookie] = $delSetup();
    $cfg += ['rp_id' => 'mindsuite.example', 'origin' => 'https://mindsuite.example'];
    $me = $cookie($tk['mine']['token']);
    $options = msa_passkey_register_begin($cfg, $me);
    check($options !== null && msa_account_delete($cfg, $me, 'password', 'sample', ''), 'a passkey registration is begun, then the account is deleted');
    $private = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
    $point = openssl_pkey_get_details($private)['ec'];
    $cose = "\xa5\x01\x02\x03\x26\x20\x01\x21\x58\x20" . str_pad($point['x'], 32, "\0", STR_PAD_LEFT) . "\x22\x58\x20" . str_pad($point['y'], 32, "\0", STR_PAD_LEFT);
    $credId = random_bytes(32);
    $authData = hash('sha256', $cfg['rp_id'], true) . "\x45" . pack('N', 0) . str_repeat("\0", 16) . pack('n', strlen($credId)) . $credId . $cose;
    $attestation = "\xa3\x63fmt\x64none\x67attStmt\xa0\x68authData\x58" . chr(strlen($authData)) . $authData;
    $registered = msa_passkey_register_finish($cfg, $me, ['clientDataJSON' => b64u_encode(client_data('webauthn.create', $options['challenge'], $cfg['origin'])),
        'attestationObject' => b64u_encode($attestation), 'label' => 'late']);
    check($registered === null && array_filter(msa_store_read($cfg)['passkeys'], static fn($r) => $r['user'] === 'sample') === [], 'the finished registration is refused and adds no passkey for the deleted account');
    check(msa_passkey_register_begin($cfg, $me) === null && msa_passkey_list($cfg, $me) === [] && !msa_passkey_remove($cfg, $me, 'pk-sample-1') &&
        !msa_change_password($cfg, $me, 'password', 'a-new-password') && !isset(msa_store_read($cfg)['accounts']['sample']), 'every other call with the old session refuses and recreates nothing');
    msa_revoke_all($cfg, $me);
    check(!isset(msa_store_read($cfg)['accounts']['sample']) && !isset(msa_store_read($cfg)['accounts']['sample']['gen']), 'sign out everywhere with the old session recreates nothing');

    // the deletion re-reads the store under the lock: another writer that held the lock first is not overwritten or ignored
    $raceChild = static function (array $session, string $client) use ($key, $dir): string {
        return 'require ' . var_export(__DIR__ . '/../../packages/mind-server/lib/mindsuite-auth.php', true) . ';' .
            '$c = msa_config("dev", ' . var_export($key, true) . ', ' . var_export($dir, true) . ');' .
            'echo msa_account_delete($c, ' . var_export($session, true) . ', "password", "sample", ' . var_export($client, true) . ') ? "deleted" : "refused";';
    };
    $race = static function (callable $whileHeld) use ($delSetup, $raceChild): array {
        [$cfg, $tk, $cookie] = $delSetup();
        $me = $cookie($tk['mine']['token']);
        $holder = fopen($cfg['data_dir'] . '/auth.lock', 'c');
        flock($holder, LOCK_EX);
        $proc = proc_open([PHP_BINARY, '-r', $raceChild($me, '192.0.2.77')], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        usleep(900000);
        $waited = proc_get_status($proc)['running'];
        $db = msa_store_read($cfg);
        $whileHeld($db, $cfg);
        msa_store_write($cfg, $db);
        flock($holder, LOCK_UN);
        fclose($holder);
        $answer = stream_get_contents($pipes[1]);
        proc_close($proc);
        return [$waited, $answer, msa_store_read($cfg)];
    };
    [$waited, $answer, $after] = $race(function (array &$db) { $db['accounts']['sample']['hash'] = password_hash('changed-meanwhile', PASSWORD_BCRYPT, ['cost' => 4]); });
    check($waited && $answer === 'refused' && isset($after['accounts']['sample']) && !isset($after['deleted']), 'a delete waiting for the lock is refused when the password was changed meanwhile, and nothing is deleted');
    [$waited, $answer, $after] = $race(function (array &$db) { $db['accounts']['sample']['wide'] = ['tries' => 0, 'rounds' => 1, 'until' => time() + 900, 'at' => time()]; });
    check($waited && $answer === 'refused' && isset($after['accounts']['sample']) && !isset($after['deleted']), 'a delete waiting for the lock is refused when the account was locked meanwhile');
    [$waited, $answer, $after] = $race(function (array &$db) { $db['accounts']['other']['email'] = 'changed-meanwhile@example.test'; });
    check($waited && $answer === 'deleted' && !isset($after['accounts']['sample']) && isset($after['deleted']['sample']) && $after['accounts']['other']['email'] === 'changed-meanwhile@example.test',
        'control: a delete that waited for the lock deletes, and keeps what the writer before it wrote to another account');
    [$waited, $answer, $after] = $race(function (array &$db) { $db['sessions'] = array_filter($db['sessions'], static fn($r) => ($r['user'] ?? '') !== 'sample' || ($r['device'] ?? '') !== 'Browser'); });
    check($waited && $answer === 'refused' && isset($after['accounts']['sample']), 'a delete waiting for the lock is refused when its session was signed out meanwhile');

    // a locked account pays the dummy bcrypt (the same time as an unknown name), a plain wrong password does not, and neither runs the real hash for a locked account
    [$cfg, $tk, $cookie] = $delSetup();
    $me = $cookie($tk['mine']['token']);
    $n0 = msa_dummy_verify('', true);
    msa_account_delete($cfg, $me, 'wrong-guess', 'sample', '192.0.2.20');
    check(msa_dummy_verify('', true) === $n0, 'a wrong password on an account that is not locked pays no dummy bcrypt (it paid the real one)');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['wide'] = ['tries' => 0, 'rounds' => 1, 'until' => time() + 900, 'at' => time()];
    msa_store_write($cfg, $db);
    $beforeLock = msa_store_read($cfg);
    msa_account_delete($cfg, $me, 'password', 'sample', '192.0.2.20');
    msa_account_delete($cfg, $me, 'wrong-guess', 'sample', '192.0.2.21');
    check(msa_dummy_verify('', true) === $n0 + 2 && msa_store_read($cfg) === $beforeLock, 'a locked account pays one dummy bcrypt per attempt, right password or wrong, and the lock count does not move');

    // ---- Review fixes
    // msa_login: the device and the address are required, scope is not
    $params = (new ReflectionFunction('msa_login'))->getParameters();
    check(!$params[3]->isOptional() && !$params[4]->isOptional() && $params[5]->isOptional(), 'msa_login requires its device and client address');
    $cfg = $fresh(['sample' => $acct('password')]);
    $threw = false;
    try { msa_login($cfg, 'sample', 'password'); } catch (ArgumentCountError) { $threw = true; }
    check($threw, 'a caller that forgets the address cannot sign in at all');

    // the lockout ladder, exactly
    $wrong = static function (array $cfg, string $client, int $n): void { for ($i = 0; $i < $n; $i++) { msa_login($cfg, 'sample', 'guess', '', $client); } };
    $ageBuckets = static function (array $cfg): void {
        $db = msa_store_read($cfg);
        foreach ($db['accounts']['sample']['lockouts'] as $k => $b) { $db['accounts']['sample']['lockouts'][$k]['until'] = time() - 60; }
        unset($db['accounts']['sample']['wide']);   // this case is about the per-address ladder, not the account-wide ceiling
        msa_store_write($cfg, $db);
    };
    $cfg = $fresh(['sample' => $acct('password')]);
    $wrong($cfg, '192.0.2.50', 4);
    check(msa_lockout_until($cfg, 'sample', '192.0.2.50') === 0 && msa_login($cfg, 'sample', 'password', '', '192.0.2.50') !== null, 'four wrong guesses do not lock');
    $wrong($cfg, '192.0.2.50', 4);
    $minutes = [];
    for ($round = 1; $round <= 6; $round++) {
        $wrong($cfg, '192.0.2.51', 5);
        $minutes[] = (int) round((msa_lockout_until($cfg, 'sample', '192.0.2.51') - time()) / 60);
        $ageBuckets($cfg);
        check(msa_lockout_until($cfg, 'sample', '192.0.2.51') === 0, 'a lockout in the past reports no lock');
    }
    check($minutes === [5, 10, 60, 120, 180, 240], 'the ladder is 5, 10, 60, 120, 180 minutes, then an hour more each round (got ' . implode(',', $minutes) . ')');
    check(MSA_LOCKOUT_BUCKETS === 200 && MSA_WIDE_TRIES === 30, 'the bucket cap is 200 and the account-wide ceiling 30');
    $cfg = $fresh(['sample' => $acct('password')]);
    for ($i = 0; $i < 5; $i++) { msa_login($cfg, 'sample', 'guess', '', '192.0.2.52'); }
    $session = msa_session($cfg, bearer(msa_login($cfg, 'sample', 'password', 'x', '192.0.2.53')['token']), []);
    check(msa_change_password($cfg, $session, 'password', 'replacement') && !isset(msa_store_read($cfg)['accounts']['sample']['lockouts']) && msa_lockout_until($cfg, 'sample', '192.0.2.52') === 0,
        'a password change clears every address bucket');

    // the account-wide lock (decided 2026-11-12, "lock fully, email reset"): rotating or forging the address does not make
    // guessing free, and it binds EVERY client, an address that signed in before included
    $cfg = $fresh(['sample' => $acct('password')]);
    check(msa_login($cfg, 'sample', 'password', 'Home', '198.51.100.1') !== null, 'a good sign-in from the usual address');
    for ($i = 0; $i < MSA_WIDE_TRIES - 1; $i++) { msa_login($cfg, 'sample', 'guess', '', '10.9.' . intdiv($i, 250) . '.' . ($i % 250)); }
    check(msa_lockout_until($cfg, 'sample', '10.200.0.9') === 0 && msa_lockout_until($cfg, 'sample', '198.51.100.1') === 0, 'twenty-nine failures from twenty-nine addresses lock nothing');
    msa_login($cfg, 'sample', 'guess', '', '10.9.9.9');
    $acc = msa_store_read($cfg)['accounts']['sample'];
    check(($acc['wide']['until'] ?? 0) > time() + 14 * 60 && $acc['wide']['until'] <= time() + 15 * 60 && $acc['wide']['rounds'] === 1, 'the thirtieth, from a thirtieth address, locks the account for fifteen minutes');
    check(msa_login($cfg, 'sample', 'password', '', '10.200.0.1') === null && msa_lockout_until($cfg, 'sample', '10.200.0.1') > time() &&
        msa_login($cfg, 'sample', 'password', '', '') === null, 'a fresh address (or none) is refused even with the right password');
    check(msa_login($cfg, 'sample', 'password', 'Home', '198.51.100.1') === null && msa_lockout_until($cfg, 'sample', '198.51.100.1') === $acc['wide']['until'],
        'an address that signed in before is refused too, until the same moment');
    // timing: a locked refusal pays the same dummy bcrypt as an unknown name, counted rather than timed, and changes nothing
    $before = msa_store_read($cfg)['accounts']['sample'];
    $runs = msa_dummy_verify('', true);
    msa_login($cfg, 'sample', 'password', 'Home', '10.200.0.2');
    check(msa_dummy_verify('', true) === $runs + 1, 'a refusal because the account is locked runs the dummy bcrypt once');
    msa_login($cfg, 'nobody', 'password', 'Home', '10.200.0.2');
    check(msa_dummy_verify('', true) === $runs + 2, 'an unknown name runs the dummy bcrypt once, the same as a locked one');
    check(msa_store_read($cfg)['accounts']['sample'] === $before, 'the locked refusal leaves every counter and lock untouched');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['known'] = [hash('sha256', '198.51.100.1'), hash('sha256', '203.0.113.77')];   // the list the 2026-11-10 library kept
    msa_store_write($cfg, $db);
    check(msa_login($cfg, 'sample', 'password', 'Home', '198.51.100.1') === null && msa_login($cfg, 'sample', 'password', 'Home', '203.0.113.77') === null,
        'a leftover known-address list from the previous library grants nothing');
    $untils = array_map(static fn(string $c): int => msa_lockout_until($cfg, 'sample', $c), ['', '198.51.100.1', '203.0.113.77', '8.8.8.8', '2001:db8::/64', '::ffff:198.51.100.1', 'not an address', str_repeat('9', 300)]);
    check(array_unique($untils) === [$acc['wide']['until']], 'whatever address a client claims (forged, empty, IPv6, mapped, junk, overlong), the lock ends at the same moment');
    $before = msa_store_read($cfg)['accounts']['sample'];
    for ($i = 0; $i < 40; $i++) { msa_login($cfg, 'sample', $i % 2 ? 'password' : 'guess', '', '172.20.0.' . $i); }
    $after = msa_store_read($cfg)['accounts']['sample'];
    check($after['wide'] === $before['wide'] && ($after['lockouts'] ?? []) === ($before['lockouts'] ?? []), 'an attempt refused by the lock is not checked and changes nothing (it neither extends nor lifts it)');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['wide']['until'] = time() - 5;
    msa_store_write($cfg, $db);
    check(msa_login($cfg, 'sample', 'password', '', '10.200.0.3') !== null, 'once the window ends the right password signs in from any address');
    $acc = msa_store_read($cfg)['accounts']['sample'];
    check(!isset($acc['wide']) && !isset($acc['known']), 'and the good sign-in starts the count over and drops the leftover list');
    for ($i = 0; $i < MSA_WIDE_TRIES; $i++) { msa_login($cfg, 'sample', 'guess', '', '10.8.0.' . $i); }
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['wide']['until'] = time() - 5;
    msa_store_write($cfg, $db);
    for ($i = 0; $i < MSA_WIDE_TRIES; $i++) { msa_login($cfg, 'sample', 'guess', '', '10.7.0.' . $i); }
    $w = msa_store_read($cfg)['accounts']['sample']['wide'];
    check($w['rounds'] === 2 && $w['until'] > time() + 59 * 60 && $w['until'] <= time() + 60 * 60, 'the second account-wide round is an hour');
    $ladder = [];
    for ($round = 3; $round <= 5; $round++) {
        $db = msa_store_read($cfg);
        $db['accounts']['sample']['wide']['until'] = time() - 5;
        msa_store_write($cfg, $db);
        for ($i = 0; $i < MSA_WIDE_TRIES; $i++) { msa_login($cfg, 'sample', 'guess', '', '10.6.' . $round . '.' . $i); }
        $ladder[] = (int) round((msa_store_read($cfg)['accounts']['sample']['wide']['until'] - time()) / 60);
    }
    check($ladder === [180, 720, 720], 'the account-wide ladder goes on to 180 minutes, then 720 every round (got ' . implode(',', $ladder) . ')');
    check(msa_login($cfg, 'sample', 'password', 'Home', '198.51.100.1') === null, 'control: locked for the address that signed in before');
    check(msa_admin_unlock($cfg, 'sample') && !isset(msa_store_read($cfg)['accounts']['sample']['wide']) && msa_lockout_until($cfg, 'sample', '10.200.0.2') === 0 &&
        msa_login($cfg, 'sample', 'password', 'Home', '198.51.100.1') !== null && msa_login($cfg, 'sample', 'password', '', '10.200.0.2') !== null,
        'the operator unlock clears the account-wide lock for every address');
    check(!isset(msa_store_read($cfg)['accounts']['sample']['known']), 'the library keeps no list of addresses that signed in');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['known'] = [hash('sha256', '198.51.100.1')];
    msa_store_write($cfg, $db);
    check(msa_admin_unlock($cfg, 'sample') && !isset(msa_store_read($cfg)['accounts']['sample']['known']), 'an unlock drops a leftover list');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['known'] = [hash('sha256', '198.51.100.1')];
    msa_store_write($cfg, $db);
    msa_admin_set_hash($cfg, 'sample', $cheap('operator-1'));
    check(!isset(msa_store_read($cfg)['accounts']['sample']['known']), 'and so does an operator set-hash');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['known'] = [hash('sha256', '198.51.100.1')];
    msa_store_write($cfg, $db);
    for ($i = 0; $i < MSA_WIDE_TRIES; $i++) { msa_login($cfg, 'sample', 'guess', '', '10.5.0.' . $i); }
    check(msa_login($cfg, 'sample', 'operator-1', 'Home', '198.51.100.1') === null && msa_reset_password($cfg, 'sample', 'after-reset-1') &&
        !isset(msa_store_read($cfg)['accounts']['sample']['known']) && msa_lockout_until($cfg, 'sample', '198.51.100.1') === 0 &&
        msa_login($cfg, 'sample', 'after-reset-1', '', '10.200.0.4') !== null, 'an emailed reset (msa_reset_password) clears the account-wide lock for every address and drops a leftover list');

    // an unexpired old single bucket (written by the previous library) still locks addressed callers
    $cfg = $fresh(['sample' => $acct('password', ['lockout' => ['tries' => 0, 'rounds' => 1, 'until' => time() + 600]])]);
    check(msa_login($cfg, 'sample', 'password', '', '203.0.113.50') === null && msa_lockout_until($cfg, 'sample', '203.0.113.50') > time(), 'an old lockout still locks an addressed caller');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['lockout']['until'] = time() - 1;
    msa_store_write($cfg, $db);
    check(msa_login($cfg, 'sample', 'password', '', '203.0.113.50') !== null && !isset(msa_store_read($cfg)['accounts']['sample']['lockout']), 'and ends with its window');

    // a scoped session is not an account credential
    $cfg = $fresh(['sample' => $acct('password')]);
    $full = msa_login($cfg, 'sample', 'password', 'Browser', 'a');
    $tok = msa_login($cfg, 'sample', 'password', 'CalMind', 'a', 'calmind');
    $fullSession = msa_session($cfg, bearer($full['token']), []);
    $scopedSession = msa_session($cfg, bearer($tok['token']), []);
    check($scopedSession['scope'] === 'calmind', 'control: the scoped session is scoped');
    $cfg2 = $cfg + ['rp_id' => 'mindsuite.example', 'origin' => 'https://mindsuite.example'];
    check(msa_passkey_register_begin($cfg2, $scopedSession) === null && msa_passkey_register_begin($cfg2, $fullSession) !== null, 'a scoped session cannot start a passkey registration');
    check(msa_passkey_register_finish($cfg2, $scopedSession, ['clientDataJSON' => 'x']) === null, 'nor finish one');
    $db = msa_store_read($cfg);
    $db['passkeys']['pk1'] = ['user' => 'sample', 'pem' => 'x', 'signCount' => 0, 'label' => 'k', 'created' => 1];
    msa_store_write($cfg, $db);
    check(msa_passkey_list($cfg2, $scopedSession) === [] && count(msa_passkey_list($cfg2, $fullSession)) === 1, 'nor list passkeys');
    check(!msa_passkey_remove($cfg2, $scopedSession, 'pk1') && isset(msa_store_read($cfg)['passkeys']['pk1']) && msa_passkey_remove($cfg2, $fullSession, 'pk1'), 'nor remove one');
    check(!msa_change_password($cfg, $scopedSession, 'password', 'replacement') && lg($cfg, 'sample', 'password') !== null, 'a scoped session cannot change the password');
    msa_revoke_all($cfg, $scopedSession);
    check(msa_user($cfg, bearer($full['token']), []) === 'sample' && msa_user($cfg, bearer($tok['token']), [], 'calmind') === 'sample', 'nor revoke every session');
    msa_revoke($cfg, $scopedSession);
    check(msa_user($cfg, bearer($tok['token']), [], 'calmind') === null && msa_user($cfg, bearer($full['token']), []) === 'sample', 'but it can sign itself out');
    $tok = msa_login($cfg, 'sample', 'password', 'CalMind', 'a', 'calmind');
    $db = msa_store_read($cfg);
    $db['sessions'][hash('sha256', $tok['token'])]['last_seen'] = time() - 2 * 3600;
    msa_store_write($cfg, $db);
    check(msa_session($cfg, [], ['MSSESS_DEV' => $tok['token']]) === null, 'a scoped row presented as a cookie is refused on the exclusive path too (stale last_seen)');
    msa_revoke_all($cfg, $fullSession);
    check(msa_user($cfg, bearer($full['token']), []) === null, 'control: a full session still revokes everything');

    // transition fields are gone the moment the password changes, before any further sign-in
    $cfg = $fresh(['sample' => $acct('unified1')]);
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy12')];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    $web = msa_login($cfg, 'sample', 'unified1', 'b', 'a');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy12')];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    msa_change_password($cfg, msa_session($cfg, bearer($web['token']), []), 'unified1', 'replacement');
    $acc = msa_store_read($cfg)['accounts']['sample'];
    check(!isset($acc['transition_hashes']) && !isset($acc['transition_until']), 'a password change leaves no transition fields behind');
    $db = msa_store_read($cfg);
    $db['accounts']['sample']['transition_hashes'] = [$cheap('legacy12')];
    $db['accounts']['sample']['transition_until'] = time() + 3600;
    msa_store_write($cfg, $db);
    msa_admin_set_hash($cfg, 'sample', $cheap('operator-1'));
    $acc = msa_store_read($cfg)['accounts']['sample'];
    check(!isset($acc['transition_hashes']) && !isset($acc['transition_until']), 'an operator set-hash leaves no transition fields behind');

    // a hold that is malformed holds everything
    $site2 = ['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'k'], 'mindsuite_store_root' => $dir];
    $held = static fn($hold) => msa_app_config('test', $site2 + ['mindsuite_auth_hold' => $hold], 'calmind') === null;
    check($held(['test' => ['calmind']]) && $held(['test' => ['CalMind']]) && $held(['test' => 'calmind']) && $held('calmind') && $held(['calmind']) && $held(['test' => [1]]) && $held(['test' => ['x'], 'prod' => 'y']),
        'a hold names an app per instance, case-insensitively, and a malformed one holds every app');
    check(!$held([]) && !$held(['test' => []]) && !$held(['prod' => ['calmind']]) && !$held(null) && !msa_app_held($site2, 'test', 'calmind') && msa_app_held(['mindsuite_auth_hold' => 7], 'test', 'zzz'), 'no hold, an empty one and another instance hold nothing');

    // the cookie path reaches the config, and the renewed cookie carries a fresh year
    check(msa_app_config('test', $site2, 'calmind', '/test/')['cookie_path'] === '/test/' && msa_app_config('test', $site2, 'calmind')['cookie_path'] === '/', 'the cookie path reaches the app config');

    copy($prod['data_dir'] . '/auth.json', $test['data_dir'] . '/auth.json');
    check(refused(fn() => msa_store_read($test)), 'ciphertext transplanted from another instance is rejected');
    $invalidAccount = $db;
    $invalidAccount['accounts']['sample']['hash'] = 'invalid password fixture';
    msa_store_write($prod, $invalidAccount);
    check(refused(fn() => msa_store_read($prod)), 'malformed account fails closed');
    $db['version'] = 2;
    msa_store_write($prod, $db);
    check(refused(fn() => msa_store_read($prod)), 'future store version fails closed');
    $broken = $prod['data_dir'] . '/auth.json';
    file_put_contents($broken, 'MSA1:damaged');
    check(refused(fn() => lg($prod, 'sample', 'transition')) && file_get_contents($broken) === 'MSA1:damaged',
        'damaged store fails closed and is preserved');
} finally {
    erase($dir);
}
// The shared lock must be taken on a descriptor open for reading: on NFS-backed storage flock(LOCK_SH) is a read lock and a
// write-only 'c' descriptor fails it while LOCK_EX works (found on the live test host, 2026-11-12). A local disk cannot
// show this, so pin the open mode in the source of both lock helpers' shared path.
$lockFn = new ReflectionFunction('msa_lock_shared');
$lockSrc = implode('', array_slice(file($lockFn->getFileName()), $lockFn->getStartLine() - 1, $lockFn->getEndLine() - $lockFn->getStartLine() + 1));
check(str_contains($lockSrc, "fopen(\$file, 'c+')") && !str_contains($lockSrc, "fopen(\$file, 'c')"),
    'the shared store lock opens its file read-write (flock LOCK_SH needs a readable descriptor on NFS)');
echo $GLOBALS['checklog'];
