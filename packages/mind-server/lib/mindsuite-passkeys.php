<?php
declare(strict_types=1);

require_once __DIR__ . '/mindsuite-auth.php';
// An app that already loaded its own canon webauthn.php (another path, same bytes) must not redeclare it.
if (!function_exists('b64u_encode') || !function_exists('webauthn_origin_ok')) {
    require_once __DIR__ . '/webauthn.php';
}

/** WebAuthn identifiers come from the deployment, never from request headers. */
function msa_passkey_scope(array $cfg): array
{
    $rp = $cfg['rp_id'] ?? '';
    $origin = $cfg['origin'] ?? '';
    $parts = parse_url($origin);
    $host = $parts['host'] ?? '';
    $scheme = $parts['scheme'] ?? '';
    $loopback = $cfg['environment'] !== 'prod' && in_array($host, ['localhost', '127.0.0.1'], true);
    if (!filter_var($rp, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME) ||
        ($host !== $rp && !str_ends_with($host, '.' . $rp)) ||
        ($scheme !== 'https' && !($loopback && $scheme === 'http')) ||
        $origin !== $scheme . '://' . $host . (isset($parts['port']) ? ':' . $parts['port'] : '')) {
        throw new InvalidArgumentException('MindSuite passkeys need a valid RP ID and origin.');
    }
    return [$rp, $origin];
}

/** Decode a bounded canonical base64url field. */
function msa_passkey_bytes(mixed $encoded, int $limit): string
{
    if (!is_string($encoded) || $encoded === '' || strlen($encoded) > $limit) { return ''; }
    $bytes = b64u_decode($encoded);
    return b64u_encode($bytes) === $encoded ? $bytes : '';
}

/** Issue a short-lived challenge bound to the ceremony and registration session. */
function msa_passkey_challenge(array &$db, string $type, string $session): string
{
    $now = time();
    $challenge = b64u_encode(random_bytes(32));
    $live = array_filter($db['challenges'], static fn($row) => $row['created'] > $now - WEBAUTHN_CHALLENGE_TTL);
    $live[$challenge] = ['type' => $type, 'session' => $session, 'created' => $now];
    $db['challenges'] = array_slice($live, -WEBAUTHN_MAX_CHALLENGES, null, true);
    return $challenge;
}

/** Verify client data and consume its matching challenge once. */
function msa_passkey_take(array $cfg, array $input, string $type, string $session = ''): string
{
    [, $origin] = msa_passkey_scope($cfg);
    $json = msa_passkey_bytes($input['clientDataJSON'] ?? null, 8192);
    $client = json_decode($json, true);
    $challenge = $client['challenge'] ?? null;
    if (($client['type'] ?? null) !== $type || ($client['origin'] ?? null) !== $origin ||
        ($client['crossOrigin'] ?? false) !== false || !is_string($challenge)) {
        return '';
    }
    return msa_lock($cfg, function () use ($cfg, $json, $challenge, $type, $session): string {
        $db = msa_store_read($cfg);
        $row = $db['challenges'][$challenge] ?? null;
        if ($row === null || $row['type'] !== $type || $row['session'] !== $session) { return ''; }
        unset($db['challenges'][$challenge]);
        msa_store_write($cfg, $db);
        return $row['created'] > time() - WEBAUTHN_CHALLENGE_TTL ? $json : '';
    });
}

/** Verify RP ID, presence and user verification for either ceremony. */
function msa_passkey_authdata(array $cfg, string $bytes): ?array
{
    [$rp] = msa_passkey_scope($cfg);
    $data = authdata_parse($bytes);
    return hash_equals(hash('sha256', $rp, true), $data['rpIdHash']) && ($data['flags'] & 0x05) === 0x05 ? $data : null;
}

/** Start passkey registration for a live session. */
function msa_passkey_register_begin(array $cfg, array $session): ?array
{
    [$rp] = msa_passkey_scope($cfg);
    return msa_lock($cfg, function () use ($cfg, $rp, $session): ?array {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session)) { return null; }
        $user = $session['user'];
        $challenge = msa_passkey_challenge($db, 'webauthn.create', $session['id']);
        $mine = array_filter($db['passkeys'], static fn($row) => $row['user'] === $user);
        msa_store_write($cfg, $db);
        return [
            'challenge' => $challenge,
            'rp' => ['id' => $rp, 'name' => 'MindSuite'],
            'user' => ['id' => b64u_encode($user), 'name' => $user, 'displayName' => $user],
            'pubKeyCredParams' => [
                ['type' => 'public-key', 'alg' => COSE_ES256],
                ['type' => 'public-key', 'alg' => COSE_RS256],
            ],
            // requireResidentKey is the Level 1 spelling of residentKey: a client or third-party provider that predates
            // residentKey still makes a discoverable credential, which the username-less sign-in needs.
            'authenticatorSelection' => ['residentKey' => 'required', 'requireResidentKey' => true, 'userVerification' => 'required'],
            'attestation' => 'none',
            'excludeCredentials' => array_map(
                static fn($id) => ['type' => 'public-key', 'id' => (string) $id], array_keys($mine)
            ),
        ];
    });
}

/**
 * Accept a verified credential for the exact session that began registration. The attestation statement is never
 * trusted, so its format is not either: `attestation: none` asks the client to strip it, but a third-party provider
 * (a password manager's passkeys) may still answer `packed` self-attestation, and refusing that refused the passkey.
 */
function msa_passkey_register_finish(array $cfg, array $session, array $input): ?string
{
    $sessionId = $session['id'] ?? '';
    if ($sessionId === '' || msa_passkey_take($cfg, $input, 'webauthn.create', $sessionId) === '') { return null; }
    try {
        $bytes = msa_passkey_bytes($input['attestationObject'] ?? null, 32768);
        $attestation = cbor_decode($bytes);
        if (!is_array($attestation) || !is_string($attestation['fmt'] ?? null) || $attestation['fmt'] === '' ||
            !is_array($attestation['attStmt'] ?? null) || !is_string($attestation['authData'] ?? null)) {
            return null;
        }
        $data = msa_passkey_authdata($cfg, $attestation['authData']);
        if ($data === null || $data['credId'] === '' || $data['cose'] === null) { return null; }
        $pem = cose_to_pem($data['cose']);
        if (openssl_pkey_get_public($pem) === false) { return null; }
    } catch (RuntimeException | TypeError) {
        return null;
    }
    $id = b64u_encode($data['credId']);
    $label = $input['label'] ?? '';
    if (!is_string($label) || trim($label) === '' || strlen($label) > 120 || preg_match('//u', $label) !== 1) { $label = 'passkey'; }
    return msa_lock($cfg, function () use ($cfg, $session, $id, $pem, $data, $label): ?string {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session) || isset($db['passkeys'][$id])) { return null; }
        $db['passkeys'][$id] = [
            'user' => $session['user'], 'pem' => $pem, 'signCount' => $data['signCount'],
            'label' => trim($label), 'created' => time(),
        ];
        msa_store_write($cfg, $db);
        return $id;
    });
}

/** Start sign-in with a discoverable passkey. */
function msa_passkey_login_begin(array $cfg): array
{
    [$rp] = msa_passkey_scope($cfg);
    return msa_lock($cfg, function () use ($cfg, $rp): array {
        $db = msa_store_read($cfg);
        $challenge = msa_passkey_challenge($db, 'webauthn.get', '');
        msa_store_write($cfg, $db);
        return ['challenge' => $challenge, 'rpId' => $rp, 'userVerification' => 'required'];
    });
}

/** Verify a signed assertion and advance its counter atomically with session creation. */
function msa_passkey_login_finish(array $cfg, array $input, string $device = ''): ?array
{
    $json = msa_passkey_take($cfg, $input, 'webauthn.get');
    $id = $input['id'] ?? null;
    $bytes = msa_passkey_bytes($input['authenticatorData'] ?? null, 8192);
    $signature = msa_passkey_bytes($input['signature'] ?? null, 4096);
    if ($json === '' || !is_string($id) || $signature === '') { return null; }
    try {
        $data = msa_passkey_authdata($cfg, $bytes);
    } catch (RuntimeException | TypeError) {
        return null;
    }
    if ($data === null || ($data['flags'] & 0x40) !== 0) { return null; }
    return msa_lock($cfg, function () use ($cfg, $id, $bytes, $json, $signature, $data, $input, $device): ?array {
        $db = msa_store_read($cfg);
        $key = $db['passkeys'][$id] ?? null;
        if ($key === null || !isset($db['accounts'][$key['user']])) { return null; }
        $user = $key['user'];
        $handle = $input['userHandle'] ?? null;
        // Older CalMind clients send the credential ID without a user handle.
        if ($handle !== null && !hash_equals($key['user_handle'] ?? $user, msa_passkey_bytes($handle, 128))) { return null; }
        if (openssl_verify($bytes . hash('sha256', $json, true), $signature, $key['pem'], OPENSSL_ALGO_SHA256) !== 1) { return null; }
        $counter = $data['signCount'];
        $stored = $key['signCount'];
        if ($stored > 0 && $counter <= $stored) { return null; }
        $now = time();
        $db['passkeys'][$id]['signCount'] = $counter;
        $db['passkeys'][$id]['used'] = $now;
        msa_stamp_first_login($db, $user, $now);
        $result = msa_issue_session($db, $user, $device, $now);
        msa_store_write($cfg, $db);
        return $result;
    });
}

/** List only this authenticated user's passkey metadata. */
function msa_passkey_list(array $cfg, array $session): array
{
    $db = msa_store_read($cfg);
    if (!msa_session_full($db, $session)) { return []; }
    $keys = [];
    foreach ($db['passkeys'] as $id => $key) {
        if ($key['user'] === $session['user']) {
            $keys[] = ['id' => (string) $id, 'label' => $key['label'], 'created' => $key['created'], 'used' => $key['used'] ?? 0];
        }
    }
    return $keys;
}

/** Remove only a passkey owned by the authenticated user. */
function msa_passkey_remove(array $cfg, array $session, string $id): bool
{
    return msa_lock($cfg, function () use ($cfg, $session, $id): bool {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session) || ($db['passkeys'][$id]['user'] ?? null) !== $session['user']) { return false; }
        unset($db['passkeys'][$id]);
        msa_store_write($cfg, $db);
        return true;
    });
}
