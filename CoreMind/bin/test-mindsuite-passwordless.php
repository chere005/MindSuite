<?php
declare(strict_types=1);
require_once __DIR__ . '/../../packages/mind-server/lib/mindsuite-passkeys.php';
function assert_ok(bool $ok, string $why): void { if (!$ok) { throw new RuntimeException($why); } echo "ok - $why\n"; }
$dir = sys_get_temp_dir() . '/mindsuite-passwordless-' . bin2hex(random_bytes(8));
mkdir($dir, 0700);
$store = $dir;
if (PHP_OS_FAMILY === 'Windows' && preg_match('#\A[A-Za-z]:[/\\\\]#', $dir) === 1) {
    chdir(substr($dir, 0, 3));
    $store = str_replace('\\', '/', substr($dir, 2));
}
try {
    $cfg = msa_config('dev', 'passwordless-fixture-key', $store) + ['rp_id' => 'localhost', 'origin' => 'http://localhost'];
    $db = ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []];
    foreach (['owner', 'other'] as $user) { $db['accounts'][$user] = ['email' => "$user@example.invalid", 'hash' => password_hash('original-password', PASSWORD_BCRYPT, ['cost' => 4]), 'created' => time()]; }
    $issued = msa_issue_session($db, 'owner', 'current', time());
    $second = msa_issue_session($db, 'owner', 'other device', time(), 'calmind');
    $other = msa_issue_session($db, 'other', 'other user', time());
    $privates = [];
    foreach (['key-one' => 'owner', 'key-two' => 'owner', 'foreign' => 'other'] as $id => $user) {
        $privates[$id] = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        $db['passkeys'][$id] = ['user' => $user, 'pem' => openssl_pkey_get_details($privates[$id])['key'], 'signCount' => 0, 'label' => $id, 'created' => time()];
    }
    msa_store_write($cfg, $db);
    $session = msa_session($cfg, ['HTTP_AUTHORIZATION' => 'Bearer ' . $issued['token']], []);
    $sign = static function (array $options, string $id = 'key-one', int $flags = 0x1d, int $count = 0, string $origin = 'http://localhost') use ($privates): array {
        $json = json_encode(['type' => 'webauthn.get', 'origin' => $origin, 'challenge' => $options['challenge']]);
        $auth = hash('sha256', 'localhost', true) . chr($flags) . pack('N', $count);
        openssl_sign($auth . hash('sha256', $json, true), $sig, $privates[$id], OPENSSL_ALGO_SHA256);
        return ['id' => $id, 'clientDataJSON' => b64u_encode($json), 'authenticatorData' => b64u_encode($auth), 'signature' => b64u_encode($sig), 'userHandle' => ''];
    };
    $begin = static function (string $purpose, string $target = '') use ($cfg, &$session) { return msa_passkey_manage_begin($cfg, $session, $purpose, $target); };
    $finish = static function (string $purpose, array $answer) use ($cfg, &$session) {
        $result = msa_passkey_manage_finish($cfg, $session, $purpose, $answer + (in_array($purpose, ['password_off', 'remove'], true) ? ['confirm' => '1'] : []));
        if (isset($result['session'])) { $session = msa_session($cfg, ['HTTP_AUTHORIZATION' => 'Bearer ' . $result['session']['token']], []); }
        return $result;
    };
    assert_ok(msa_passkey_register_begin($cfg, $session) === null && !msa_passkey_remove($cfg, $session, 'key-two'), 'a cookie alone cannot enroll or remove credentials');
    assert_ok(msa_passkey_register_begin($cfg, $session, 'original-password') !== null, 'the current password authorizes enrollment');
    // Removing the key that authorized enrollment must invalidate that unfinished enrollment too.
    $pending = $finish('register', $sign($begin('register')))['options'];
    $saved = msa_store_read($cfg)['passkeys']['key-one'];
    assert_ok(msa_passkey_remove($cfg, $session, 'key-one', 'original-password'), 'the owner can revoke a key after it authorized enrollment');
    $point = openssl_pkey_get_details($privates['key-two'])['ec'];
    $cose = "\xa5\x01\x02\x03\x26\x20\x01\x21\x58\x20" . str_pad($point['x'], 32, "\0", STR_PAD_LEFT) . "\x22\x58\x20" . str_pad($point['y'], 32, "\0", STR_PAD_LEFT);
    $cred = random_bytes(16);
    $auth = hash('sha256', 'localhost', true) . "\x45" . pack('N', 0) . str_repeat("\0", 16) . pack('n', strlen($cred)) . $cred . $cose;
    $object = "\xa3\x63fmt\x64none\x67attStmt\xa0\x68authData\x58" . chr(strlen($auth)) . $auth;
    $client = json_encode(['type' => 'webauthn.create', 'challenge' => $pending['challenge'], 'origin' => 'http://localhost']);
    assert_ok(msa_passkey_register_finish($cfg, $session, ['clientDataJSON' => b64u_encode($client), 'attestationObject' => b64u_encode($object)]) === null, 'a revoked key cannot finish an earlier authorized enrollment');
    $db = msa_store_read($cfg); $db['passkeys']['key-one'] = $saved; msa_store_write($cfg, $db); // restore only this disposable fixture
    foreach (['foreign' => 0x1d, 'key-one' => 0x01] as $id => $flags) {
        assert_ok($finish('password_off', $sign($begin('password_off'), $id, $flags)) === null, 'a foreign key or missing user verification cannot remove the password');
    }
    assert_ok(msa_passkey_manage_finish($cfg, $session, 'password_off', $sign($begin('password_off'))) === null, 'removing a password needs explicit confirmation');
    assert_ok($finish('password_off', $sign(msa_passkey_login_begin($cfg))) === null, 'a sign-in challenge cannot authorize an account action');
    assert_ok($finish('password_off', $sign($begin('password_off'), 'key-one', 0x1d, 0, 'http://elsewhere.invalid')) === null, 'a foreign origin cannot authorize an account action');
    $stale = $begin('password_off');
    $db = msa_store_read($cfg); $db['accounts']['owner']['gen'] = msa_account_gen($db, 'owner') + 1; msa_store_write($cfg, $db);
    assert_ok($finish('password_off', $sign($stale)) === null, 'a proof from an earlier account generation is refused even with a live session');
    $db = msa_store_read($cfg); $db['passkeys']['key-one']['signCount'] = 3; msa_store_write($cfg, $db);
    assert_ok($finish('password_off', $sign($begin('password_off'), 'key-one', 0x1d, 2)) === null, 'a management assertion must advance a nonzero counter');
    $db = msa_store_read($cfg); $db['passkeys']['key-one']['signCount'] = 0; msa_store_write($cfg, $db);
    $o = $begin('password_off'); $a = $sign($o);
    assert_ok($finish('password', $a + ['password' => 'replacement-password']) === null, 'proof is restricted to its intended action');
    $wrong = array_replace($session, ['id' => hash('sha256', $other['token'])]);
    assert_ok(msa_passkey_manage_finish($cfg, $wrong, 'password_off', $a) === null, 'proof is bound to its session and user');
    $oldStamp = msa_reset_identity($cfg, 'owner')['stamp'];
    assert_ok($finish('password_off', $a) !== null && $finish('password_off', $a) === null, 'a verified passkey removes the password once');
    $db = msa_store_read($cfg);
    assert_ok(!msa_password_enabled($db['accounts']['owner']) && !msa_verify_password('original-password', $db['accounts']['owner']['hash']) &&
        msa_login($cfg, 'owner', 'original-password', '', '') === null && !msa_change_password($cfg, $session, 'original-password', 'guess-password'), 'the old password is erased and cannot authenticate or change credentials');
    assert_ok(!isset($db['sessions'][hash('sha256', $issued['token'])]) && !isset($db['sessions'][hash('sha256', $second['token'])]) && isset($db['sessions'][$session['id']], $db['sessions'][hash('sha256', $other['token'])]), 'switching modes rotates this session, revokes the old cookie and app tokens, and preserves other accounts');
    assert_ok(msa_passkey_login_finish($cfg, $sign(msa_passkey_login_begin($cfg))) !== null, 'a passkeys-only account still signs in with its passkey');
    assert_ok(!msa_reset_password($cfg, 'owner', 'new-password') && !msa_reset_password($cfg, 'owner', 'new-password', time(), $oldStamp), 'unstamped legacy recovery and pre-switch codes cannot restore a password');
    $one = $begin('remove', 'key-one'); $two = $begin('remove', 'key-two');
    assert_ok($finish('remove', $sign($two)) !== null && $finish('remove', $sign($one)) === null && $begin('remove', 'key-one') === null, 'concurrent removals cannot remove the last key without a password');
    $r = $finish('register', $sign($begin('register')));
    assert_ok(isset($r['options']['challenge']), 'an existing passkey authorizes adding another without a password');
    assert_ok($finish('password', $sign($begin('password')) + ['password' => 'replacement-password']) !== null &&
        msa_login($cfg, 'owner', 'replacement-password', '', '') !== null, 'a passkey can set a password and enable both sign-in methods');
    assert_ok($finish('password_off', $sign($begin('password_off'))) !== null, 'both sign-in methods can switch back to passkeys only');
    $stamp = msa_reset_identity($cfg, 'owner')['stamp'];
    assert_ok(msa_reset_password($cfg, 'owner', 'recovery-password', time(), $stamp) && msa_login($cfg, 'owner', 'recovery-password', '', '') !== null, 'fresh stamped email recovery enables a password and revokes old sessions');
    assert_ok($finish('delete', $sign($begin('delete') ?? ['challenge' => 'gone']) + ['confirm_name' => 'owner', 'confirm' => '1']) === null, 'a session revoked by recovery cannot delete an account');
    $login = msa_login($cfg, 'owner', 'recovery-password', '', '');
    $session = msa_session($cfg, ['HTTP_AUTHORIZATION' => 'Bearer ' . $login['token']], []);
    $o = msa_passkey_manage_begin($cfg, $session, 'delete');
    assert_ok(msa_passkey_manage_finish($cfg, $session, 'delete', $sign($o) + ['confirm_name' => 'other', 'confirm' => '1']) === null, 'passkey deletion still requires the exact typed username');
    assert_ok(msa_passkey_manage_finish($cfg, $session, 'delete', $sign($o) + ['confirm_name' => ' OWNER ', 'confirm' => '1']) !== null &&
        msa_account_deleted($cfg, 'owner') && msa_account_exists($cfg, 'other') && count(msa_store_read($cfg)['passkeys']) === 1, 'fresh passkey proof deletes only its own account and holds its name');
} finally {
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f) { $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname()); }
    rmdir($dir);
}
