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
    $encoded = msa_passkey_unpad($encoded);
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
    $ceremony = $type === 'webauthn.create' ? 'register' : 'login';
    $json = msa_passkey_bytes($input['clientDataJSON'] ?? null, 8192);
    $client = json_decode($json, true);
    if (!is_array($client)) { return msa_passkey_refuse($cfg, $ceremony, 'client-data') ?? ''; }
    if (($client['type'] ?? null) !== $type) { return msa_passkey_refuse($cfg, $ceremony, 'type') ?? ''; }
    if (($client['origin'] ?? null) !== $origin) {
        return msa_passkey_refuse($cfg, $ceremony, 'origin', ['origin' => msa_passkey_origin_fact($client['origin'] ?? null)]) ?? '';
    }
    if (($client['crossOrigin'] ?? false) !== false) { return msa_passkey_refuse($cfg, $ceremony, 'cross-origin') ?? ''; }
    // A provider that writes its own client data may pad the challenge or use the standard alphabet; the bytes are the same.
    $challenge = is_string($client['challenge'] ?? null) ? msa_passkey_unpad($client['challenge']) : null;
    if ($challenge === null) { return msa_passkey_refuse($cfg, $ceremony, 'challenge-unknown') ?? ''; }
    return msa_lock($cfg, function () use ($cfg, $json, $challenge, $type, $session, $ceremony): string {
        $db = msa_store_read($cfg);
        $row = $db['challenges'][$challenge] ?? null;
        if ($row === null) { return msa_passkey_refuse($cfg, $ceremony, 'challenge-unknown') ?? ''; }
        if ($row['type'] !== $type) { return msa_passkey_refuse($cfg, $ceremony, 'challenge-ceremony') ?? ''; }
        if ($row['session'] !== $session) { return msa_passkey_refuse($cfg, $ceremony, 'challenge-session') ?? ''; }
        unset($db['challenges'][$challenge]);
        msa_store_write($cfg, $db);
        if ($row['created'] <= time() - WEBAUTHN_CHALLENGE_TTL) { return msa_passkey_refuse($cfg, $ceremony, 'challenge-expired') ?? ''; }
        return $json;
    });
}

/** Verify RP ID, presence and user verification for either ceremony. */
function msa_passkey_authdata(array $cfg, string $bytes, string $ceremony = ''): ?array
{
    [$rp] = msa_passkey_scope($cfg);
    $data = authdata_parse($bytes);
    if (!hash_equals(hash('sha256', $rp, true), $data['rpIdHash'])) {
        return msa_passkey_refuse($cfg, $ceremony, 'rp', ['host' => msa_passkey_host_fact($rp, $data['rpIdHash']), 'flags' => msa_passkey_flag_names($data['flags'])]);
    }
    if (($data['flags'] & 0x05) !== 0x05) {
        return msa_passkey_refuse($cfg, $ceremony, 'flags', ['flags' => msa_passkey_flag_names($data['flags'])]);
    }
    return $data;
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
    if ($sessionId === '') { return msa_passkey_refuse($cfg, 'register', 'session'); }
    if (msa_passkey_take($cfg, $input, 'webauthn.create', $sessionId) === '') { return null; }
    try {
        $bytes = msa_passkey_bytes($input['attestationObject'] ?? null, 32768);
        $attestation = cbor_decode($bytes);
        if (!is_array($attestation) || !is_string($attestation['fmt'] ?? null) || $attestation['fmt'] === '' ||
            !is_array($attestation['attStmt'] ?? null) || !is_string($attestation['authData'] ?? null)) {
            return msa_passkey_refuse($cfg, 'register', 'attestation');
        }
        $data = msa_passkey_authdata($cfg, $attestation['authData'], 'register');
        if ($data === null) { return null; }
        if ($data['credId'] === '' || $data['cose'] === null) { return msa_passkey_refuse($cfg, 'register', 'attested-data', ['fmt' => $attestation['fmt']]); }
        $pem = cose_to_pem($data['cose']);
        if (openssl_pkey_get_public($pem) === false) { return msa_passkey_refuse($cfg, 'register', 'pem', msa_passkey_cose_facts($data['cose'])); }
    } catch (RuntimeException | TypeError $e) {
        return msa_passkey_refuse($cfg, 'register', msa_passkey_step_of($e), ['reason' => $e->getMessage()] + (isset($data['cose']) && is_array($data['cose']) ? msa_passkey_cose_facts($data['cose']) : []));
    }
    $id = b64u_encode($data['credId']);
    $label = $input['label'] ?? '';
    if (!is_string($label) || trim($label) === '' || strlen($label) > 120 || preg_match('//u', $label) !== 1) { $label = 'passkey'; }
    return msa_lock($cfg, function () use ($cfg, $session, $id, $pem, $data, $label, $attestation): ?string {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session)) { return msa_passkey_refuse($cfg, 'register', 'session'); }
        if (isset($db['passkeys'][$id])) { return msa_passkey_refuse($cfg, 'register', 'duplicate', msa_passkey_id_facts($id)); }
        $db['passkeys'][$id] = [
            'user' => $session['user'], 'pem' => $pem, 'signCount' => $data['signCount'],
            'label' => trim($label), 'created' => time(),
        ];
        msa_store_write($cfg, $db);
        $aaguid = msa_passkey_aaguid($attestation['authData']);
        msa_passkey_note($cfg, 'register', 'ok', [
            'flags' => msa_passkey_flag_names($data['flags']), 'counter' => $data['signCount'], 'fmt' => $attestation['fmt'],
            'aaguid' => $aaguid, 'provider' => msa_passkey_provider($aaguid), 'user' => $session['user'],
        ] + msa_passkey_id_facts($id) + msa_passkey_cose_facts($data['cose']));
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
    if ($json === '') { return null; }
    // A hand-built credential object may pad its id or use the standard alphabet; the store keys the canonical form.
    $id = is_string($input['id'] ?? null) ? msa_passkey_unpad($input['id']) : null;
    $bytes = msa_passkey_bytes($input['authenticatorData'] ?? null, 8192);
    $signature = msa_passkey_bytes($input['signature'] ?? null, 4096);
    if ($id === null || $id === '' || $bytes === '' || $signature === '') {
        return msa_passkey_refuse($cfg, 'login', 'fields', ['field' => $id === null || $id === '' ? 'id' : ($bytes === '' ? 'authenticatorData' : 'signature')]);
    }
    try {
        $data = msa_passkey_authdata($cfg, $bytes, 'login');
    } catch (RuntimeException | TypeError $e) {
        return msa_passkey_refuse($cfg, 'login', 'authdata', ['reason' => $e->getMessage()]);
    }
    if ($data === null) { return null; }
    if (($data['flags'] & 0x40) !== 0) { return msa_passkey_refuse($cfg, 'login', 'attested-on-assertion', ['flags' => msa_passkey_flag_names($data['flags'])]); }
    return msa_lock($cfg, function () use ($cfg, $id, $bytes, $json, $signature, $data, $input, $device): ?array {
        $db = msa_store_read($cfg);
        $key = $db['passkeys'][$id] ?? null;
        $facts = ['flags' => msa_passkey_flag_names($data['flags'])] + msa_passkey_id_facts($id);
        if ($key === null) { return msa_passkey_refuse($cfg, 'login', 'unknown-credential', $facts); }
        if (!isset($db['accounts'][$key['user']])) { return msa_passkey_refuse($cfg, 'login', 'account-gone', $facts); }
        $user = $key['user'];
        $handle = $input['userHandle'] ?? null;
        // Older CalMind clients send the credential ID without a user handle, and a provider may send an empty one (or null): none is a claim.
        if ($handle === '') { $handle = null; }
        if ($handle !== null && !hash_equals($key['user_handle'] ?? $user, msa_passkey_bytes($handle, 128))) { return msa_passkey_refuse($cfg, 'login', 'user-handle', $facts); }
        if (openssl_verify($bytes . hash('sha256', $json, true), $signature, $key['pem'], OPENSSL_ALGO_SHA256) !== 1) { return msa_passkey_refuse($cfg, 'login', 'signature', $facts); }
        $counter = $data['signCount'];
        $stored = $key['signCount'];
        if ($stored > 0 && $counter <= $stored) { return msa_passkey_refuse($cfg, 'login', 'counter', $facts + ['stored' => $stored, 'counter' => $counter]); }
        $now = time();
        $db['passkeys'][$id]['signCount'] = $counter;
        $db['passkeys'][$id]['used'] = $now;
        msa_stamp_first_login($db, $user, $now);
        $result = msa_issue_session($db, $user, $device, $now);
        msa_store_write($cfg, $db);
        msa_passkey_note($cfg, 'login', 'ok', $facts + ['stored' => $stored, 'counter' => $counter]);
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

// ---- Diagnostics: why a passkey ceremony was refused, for the operator. Nothing here is a credential. ----------------

/** Strip base64 padding and the standard alphabet from a field a hand-built provider object may have written that way. */
function msa_passkey_unpad(string $value): string
{
    return rtrim(strtr($value, '+/', '-_'), '=');
}

/** The names of the authenticator-data flag bits that are set, for the log (UP UV BE BS AT ED). */
function msa_passkey_flag_names(int $flags): string
{
    $names = [];
    foreach ([0x01 => 'UP', 0x04 => 'UV', 0x08 => 'BE', 0x10 => 'BS', 0x40 => 'AT', 0x80 => 'ED'] as $bit => $name) {
        if (($flags & $bit) !== 0) { $names[] = $name; }
    }
    return $names === [] ? 'none' : implode('+', $names);
}

/** Which of this deployment's own hosts an rpIdHash is the hash of (rp, www, test, dev), or other. */
function msa_passkey_host_fact(string $rp, string $hash): string
{
    $bare = preg_replace('/^(?:www|test|dev)\./', '', $rp) ?? $rp;
    foreach (['rp' => $rp, 'apex' => $bare, 'www' => "www.$bare", 'test' => "test.$bare", 'dev' => "dev.$bare"] as $name => $host) {
        if (hash_equals(hash('sha256', $host, true), $hash)) { return $name; }
    }
    return 'other';
}

/** A claimed origin reduced to scheme, host and port, or 'invalid'. */
function msa_passkey_origin_fact(mixed $origin): string
{
    $parts = is_string($origin) ? parse_url($origin) : false;
    if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) { return 'invalid'; }
    return $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
}

/** A credential id reduced to a short fingerprint and its length: enough to match two rows, nothing to replay. */
function msa_passkey_id_facts(string $id): array
{
    return ['fp' => substr(hash('sha256', $id), 0, 12), 'idlen' => strlen($id)];
}

/** The algorithm facts of a COSE key (key type, algorithm, curve), no key material. */
function msa_passkey_cose_facts(array $cose): array
{
    $facts = [];
    foreach (['kty' => 1, 'alg' => 3, 'crv' => -1] as $name => $label) {
        if (isset($cose[$label]) && is_int($cose[$label])) { $facts[$name] = $cose[$label]; }
    }
    return $facts;
}

/** The authenticator model id (AAGUID) in attested credential data, as the usual dashed hex. */
function msa_passkey_aaguid(string $authData): string
{
    return strlen($authData) < 55 ? '' : (string) preg_replace('/^(.{8})(.{4})(.{4})(.{4})(.{12})$/', '$1-$2-$3-$4-$5', bin2hex(substr($authData, 37, 16)));
}

/** A provider name for an AAGUID the operator would recognise, or 'other'. */
function msa_passkey_provider(string $aaguid): string
{
    return [
        'b78a0a55-6ef8-d246-a042-ba0f6d55050c' => 'LastPass',
        'fbfc3007-154e-4ecc-8c0b-6e020557d7bd' => 'Apple Passwords',
        'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4' => 'Google Password Manager',
        'bada5566-a7aa-401f-bd96-45619a55120d' => '1Password',
        'd548826e-79b4-db40-a3d8-11116f7e8349' => 'Bitwarden',
        '00000000-0000-0000-0000-000000000000' => 'none',
    ][$aaguid] ?? 'other';
}

/** The step a decoder exception belongs to: its message starts with the decoder's name. */
function msa_passkey_step_of(Throwable $e): string
{
    $m = $e->getMessage();
    return str_starts_with($m, 'authData') ? 'authdata' : (str_starts_with($m, 'cose') ? 'cose' : 'attestation');
}

/**
 * Tell the deployment's sink (cfg `passkey_note`, a callable taking ceremony, step and facts) which step of a ceremony
 * ended it. Facts are limited to a fixed list and cleaned to short printable text, so a note can neither carry a
 * secret nor forge a log line. A sink that throws changes nothing.
 */
function msa_passkey_note(array $cfg, string $ceremony, string $step, array $facts = []): void
{
    $sink = $cfg['passkey_note'] ?? null;
    if (!is_callable($sink)) { return; }
    $allowed = ['flags', 'host', 'origin', 'fp', 'idlen', 'stored', 'counter', 'fmt', 'aaguid', 'provider', 'kty', 'alg', 'crv',
        'reason', 'user', 'field', 'name', 'message', 'native', 'attachment', 'mediation', 'age'];
    $clean = [];
    foreach ($facts as $name => $value) {
        if (!in_array($name, $allowed, true) || !(is_scalar($value) || $value === null)) { continue; }
        $text = is_bool($value) ? ($value ? 'yes' : 'no') : (string) $value;
        $clean[$name] = substr((string) preg_replace('/[^A-Za-z0-9._:\/ +=(),\'-]/', '?', $text), 0, 160);
    }
    try {
        $sink($ceremony === '' ? 'unknown' : $ceremony, preg_replace('/[^a-z-]/', '', $step) ?: 'unknown', $clean);
    } catch (Throwable) {
        // diagnostics never change an answer
    }
}

/** Note a refusal and return null, so a refusal site reads `return msa_passkey_refuse(...)`. Typed loosely: it stands in for ?array, ?string and string. */
function msa_passkey_refuse(array $cfg, string $ceremony, string $step, array $facts = []): mixed
{
    msa_passkey_note($cfg, $ceremony, $step, $facts);
    return null;
}

/**
 * What the sign-in page reports about a ceremony that failed in the browser, reduced to the facts the log allows:
 * the step (options, prompt, answer, server), the error name and a short message, and the shape of what the provider
 * returned. Returns null for a report that names no valid ceremony or step.
 */
function msa_passkey_report_facts(array $in): ?array
{
    $ceremony = $in['ceremony'] ?? null;
    $step = $in['step'] ?? null;
    if (!in_array($ceremony, ['login', 'register', 'conditional'], true) || !in_array($step, ['options', 'prompt', 'answer', 'server'], true)) { return null; }
    $facts = [];
    $name = $in['name'] ?? null;
    if (is_string($name) && preg_match('/^[A-Za-z]{1,40}$/', $name) === 1) { $facts['name'] = $name; }
    if (is_string($in['message'] ?? null)) { $facts['message'] = substr($in['message'], 0, 160); }
    if (is_bool($in['native'] ?? null)) { $facts['native'] = $in['native']; }
    if (in_array($in['attachment'] ?? null, ['platform', 'cross-platform'], true)) { $facts['attachment'] = $in['attachment']; }
    if (is_string($in['field'] ?? null) && preg_match('/^[A-Za-z]{1,24}$/', $in['field']) === 1) { $facts['field'] = $in['field']; }
    if (is_int($in['flags'] ?? null) && $in['flags'] >= 0 && $in['flags'] <= 255) { $facts['flags'] = msa_passkey_flag_names($in['flags']); }
    if (is_int($in['counter'] ?? null) && $in['counter'] >= 0) { $facts['counter'] = $in['counter']; }
    if (is_int($in['age'] ?? null) && $in['age'] >= 0) { $facts['age'] = $in['age']; }
    return [$ceremony === 'conditional' ? 'login' : $ceremony, 'page-' . $step, $facts + ($ceremony === 'conditional' ? ['mediation' => 'conditional'] : [])];
}
