<?php
declare(strict_types=1);

// An app that already loaded its own canon atomic.php (another path, same bytes) must not redeclare it.
if (!function_exists('MindSuite\\Files\\atomic_write') || !function_exists('MindSuite\\Files\\with_file_lock')) {
    require_once __DIR__ . '/atomic.php';
}

const MSA_SESSION_AGE = 365 * 24 * 60 * 60;
/**
 * Per-address lockout buckets kept for one account, and how long a spent bucket lingers. A bucket is only a speed bump:
 * the address it is keyed on is whatever the caller passes, and a client can choose it (on NearlyFreeSpeech REMOTE_ADDR is
 * the right-most X-Forwarded-For entry the client sent), so it slows a careless guesser and never protects the account.
 */
const MSA_LOCKOUT_BUCKETS = 200;
const MSA_LOCKOUT_KEEP = 24 * 60 * 60;
/**
 * The account-wide lock, the real defence (decided 2026-11-12, "lock fully, email reset"): this many failed guesses from any
 * addresses lock the account for EVERY client, the right password included, for 15, 60, 180, then 720 minutes. No address
 * is exempt, because any address can be forged. The ways out: the lock's end, an emailed reset (msa_reset_password) or the
 * operator's unlock (msa_admin_unlock); a passkey sign-in is not a guess and is not refused by it.
 */
const MSA_WIDE_TRIES = 30;
const MSA_DUMMY_PASSWORD = '$2y$12$O9mGwh2/svFzhHPhWyK2TOr.Ov6lAhkUPfK8oHNQwJ4ek4tL6cPtq';

/** Resolve a trusted deployment environment into its own store and cookie. */
function msa_config(
    string $environment,
    string $dataKey,
    string $storeRoot = '/home/protected',
    string $cookiePath = '/'
): array {
    $suffix = match ($environment) {
        'prod' => '',
        'test' => '-test',
        'dev' => '-dev',
        default => throw new InvalidArgumentException('Invalid MindSuite auth environment.'),
    };
    if ($dataKey === '' || $storeRoot === '' || $storeRoot[0] !== '/' || str_contains($storeRoot, "\0") ||
        ($cookiePath !== '/' && ($suffix === '' || $cookiePath !== '/' . $environment . '/'))) {
        throw new InvalidArgumentException('Invalid MindSuite auth configuration.');
    }
    return [
        'environment' => $environment,
        'data_dir' => rtrim($storeRoot, '/') . '/mindsuite-auth' . $suffix,
        'key' => hash('sha256', $dataKey, true),
        'cookie' => 'MSSESS' . strtoupper(str_replace('-', '_', $suffix)),
        'cookie_path' => $cookiePath,
    ];
}

/**
 * Is this app on hold for this instance (`mindsuite_auth_hold`: instance => list of lowercase app names)? A hold exists to
 * keep an unconverted app off the shared sign-in, so it fails closed: a hold that is present but malformed (not an array,
 * a flat list, an instance whose value is not a list of strings) holds EVERY app; names compare case-insensitively.
 */
function msa_app_held(array $siteConfig, string $env, string $app): bool
{
    if (!array_key_exists('mindsuite_auth_hold', $siteConfig) || $siteConfig['mindsuite_auth_hold'] === null) { return false; }
    $hold = $siteConfig['mindsuite_auth_hold'];
    if (!is_array($hold) || ($hold !== [] && array_is_list($hold))) { return true; }
    foreach ($hold as $names) {
        if (!is_array($names) || !array_is_list($names)) { return true; }
        foreach ($names as $name) { if (!is_string($name)) { return true; } }
    }
    return in_array(strtolower($app), array_map('strtolower', $hold[$env] ?? []), true);
}

/**
 * The auth configuration one suite app uses on this instance, or null while the instance is not switched on
 * (`mindsuite_auth_instances`) or the app is on hold (`mindsuite_auth_hold[env]`). Everything comes from the site's
 * private config: `mindsuite_auth_keys[env]` (required once switched on), optional `mindsuite_store_root`,
 * `mindsuite_host` / `mindsuite_origin` (fixtures), `mindsuite_invite_code`; `mindsuite_signup_closed` empties the invite.
 * `$ignoreSwitch` is for operator tools that fill a store before the instance is switched on.
 */
function msa_app_config(string $env, array $siteConfig, string $app, string $cookiePath = '/', bool $ignoreSwitch = false): ?array
{
    if (preg_match('/\A[a-z0-9_-]{1,40}\z/', $app) !== 1) { throw new InvalidArgumentException('Invalid MindSuite app name.'); }
    if (!$ignoreSwitch) {
        if (!in_array($env, (array) ($siteConfig['mindsuite_auth_instances'] ?? []), true)) { return null; }
        if (msa_app_held($siteConfig, $env, $app)) { return null; }
    }
    $key = (string) ($siteConfig['mindsuite_auth_keys'][$env] ?? '');
    $root = (string) ($siteConfig['mindsuite_store_root'] ?? '/home/protected');
    $host = (string) ($siteConfig['mindsuite_host'] ?? (($env === 'prod' ? '' : $env . '.') . 'seancheren.com'));
    $invite = empty($siteConfig['mindsuite_signup_closed']) ? (string) ($siteConfig['mindsuite_invite_code'] ?? '') : '';
    return msa_config($env, $key, $root, $cookiePath) + [
        'invite_code' => $invite,
        'rp_id' => $host,
        'origin' => (string) ($siteConfig['mindsuite_origin'] ?? 'https://' . $host),
    ];
}

/** Canonical account name, or null when the original spelling is invalid. */
function msa_normalize_username(string $name): ?string
{
    $name = strtolower($name);
    return preg_match('/\A[a-z0-9_-]{2,20}\z/', $name) === 1 ? $name : null;
}

/** Report identities from username lists only. Keep original spellings for collision review. */
function msa_migration_report(array $sources): array
{
    $accounts = [];
    $invalid = [];
    ksort($sources, SORT_STRING);
    foreach ($sources as $source => $usernames) {
        if (!is_string($source) || !is_array($usernames) || !array_is_list($usernames)) {
            throw new InvalidArgumentException('MindSuite auth inventory requires named username lists.');
        }
        foreach ($usernames as $username) {
            if (!is_string($username)) { throw new InvalidArgumentException('MindSuite auth inventory requires usernames.'); }
        }
        sort($usernames, SORT_STRING);
        foreach (array_unique($usernames, SORT_STRING) as $username) {
            $name = msa_normalize_username($username);
            if ($name === null) {
                $invalid[] = ['source' => $source, 'username' => $username];
                continue;
            }
            $accounts[$name] ??= ['username' => $name, 'sources' => [], 'spellings' => []];
            $accounts[$name]['sources'][] = $source;
            $accounts[$name]['spellings'][] = $username;
        }
    }
    ksort($accounts, SORT_STRING);
    foreach ($accounts as &$row) {
        $row['sources'] = array_values(array_unique($row['sources']));
        $row['spellings'] = array_values(array_unique($row['spellings']));
        sort($row['spellings'], SORT_STRING);
        $row['collision'] = count($row['spellings']) > 1;
    }
    unset($row);
    return ['accounts' => array_values($accounts), 'invalid' => $invalid];
}

/** Read the complete auth store and fail closed on unreadable or damaged data. */
function msa_store_read(array $cfg): array
{
    $file = $cfg['data_dir'] . '/auth.json';
    $raw = @file_get_contents($file);
    $blob = is_string($raw) && str_starts_with($raw, 'MSA1:') ? base64_decode(substr($raw, 5), true) : false;
    $json = $blob === false || strlen($blob) <= 28 ? false : openssl_decrypt(
        substr($blob, 28), 'aes-256-gcm', $cfg['key'], OPENSSL_RAW_DATA,
        substr($blob, 0, 12), substr($blob, 12, 16), $cfg['environment']
    );
    $db = $json === false ? null : json_decode($json, true);
    if (!is_array($db) || ($db['version'] ?? null) !== 1 || !is_array($db['accounts'] ?? null) ||
        !is_array($db['sessions'] ?? null) || !is_array($db['passkeys'] ?? null) ||
        !is_array($db['challenges'] ?? null)) {
        throw new RuntimeException('MindSuite auth store could not be read.');
    }
    foreach ($db['accounts'] as $user => $account) {
        $hash = $account['hash'] ?? null;
        if (msa_normalize_username((string) $user) !== (string) $user || !is_string($hash) ||
            password_get_info($hash)['algo'] === null) {
            throw new RuntimeException('MindSuite auth store contains an invalid account.');
        }
    }
    return $db;
}

/** Publish one authenticated, encrypted snapshot while the caller holds the store lock. */
function msa_store_write(array $cfg, array $db): void
{
    $json = json_encode($db, JSON_THROW_ON_ERROR);
    $iv = random_bytes(12);
    $tag = '';
    $encrypted = openssl_encrypt($json, 'aes-256-gcm', $cfg['key'], OPENSSL_RAW_DATA, $iv, $tag, $cfg['environment']);
    if ($encrypted === false) { throw new RuntimeException('MindSuite auth store could not be encrypted.'); }
    \MindSuite\Files\atomic_write($cfg['data_dir'] . '/auth.json', 'MSA1:' . base64_encode($iv . $tag . $encrypted));
}

/** Serialize each auth read-modify-write across applications. */
function msa_lock(array $cfg, callable $fn): mixed
{
    return \MindSuite\Files\with_file_lock($cfg['data_dir'] . '/auth.lock', $fn);
}

/** Bcrypt permits at most 72 bytes in a new password. */
function msa_valid_new_password(string $password): bool
{
    return strlen($password) >= 6 && strlen($password) <= 72 && !str_contains($password, "\0");
}

/** Verify an imported hash without treating any other legacy value as a password. */
function msa_verify_password(string $password, mixed $hash): bool
{
    return is_string($hash) && !str_contains($password, "\0") && password_verify($password, $hash);
}

/** Spend one bcrypt verification against a fixed dummy hash; `$count` is true to read how many ran (the test seam). */
function msa_dummy_verify(string $password, bool $count = false): int
{
    static $runs = 0;
    if ($count) { return $runs; }
    $runs++;
    msa_verify_password($password, MSA_DUMMY_PASSWORD);
    return $runs;
}

/** Create an account when the caller supplies this deployment's configured invite. */
function msa_signup(array $cfg, string $username, string $email, string $password, string $invite): bool
{
    $user = msa_normalize_username($username);
    $code = $cfg['invite_code'] ?? '';
    if ($user === null || !msa_valid_new_password($password) || !filter_var($email, FILTER_VALIDATE_EMAIL) ||
        $code === '' || !hash_equals($code, $invite)) {
        return false;
    }
    $hash = password_hash($password, PASSWORD_BCRYPT);
    return msa_lock($cfg, function () use ($cfg, $user, $email, $hash): bool {
        $db = msa_store_read($cfg);
        if (isset($db['accounts'][$user])) { return false; }
        $db['accounts'][$user] = ['email' => $email, 'hash' => $hash, 'created' => time()];
        msa_store_write($cfg, $db);
        return true;
    });
}

/** A session row lives while it was used within the session age: every authenticated use slides it forward. */
function msa_row_fresh(array $row, int $now): bool
{
    $created = $row['created'] ?? null;
    $seen = $row['last_seen'] ?? $created;
    return is_int($created) && $created <= $now && is_int($seen) && $seen > $now - MSA_SESSION_AGE;
}

/** Issue the same token shape to browsers and native clients; store only the digest. A scope limits it to bearer callers. */
function msa_issue_session(array &$db, string $user, string $device, int $now, string $scope = ''): array
{
    $token = bin2hex(random_bytes(32));
    $csrf = bin2hex(random_bytes(32));
    if (strlen($device) > 512 || preg_match('//u', $device) !== 1) { $device = ''; }
    if ($scope !== '' && preg_match('/\A[a-z0-9_-]{1,40}\z/', $scope) !== 1) { throw new InvalidArgumentException('Invalid session scope.'); }
    $db['sessions'] = array_filter($db['sessions'], static fn($row) => is_array($row) && msa_row_fresh($row, $now));
    $row = ['user' => $user, 'device' => $device, 'created' => $now, 'last_seen' => $now, 'csrf' => $csrf];
    if ($scope !== '') { $row['scope'] = $scope; }
    $db['sessions'][hash('sha256', $token)] = $row;
    return ['token' => $token, 'user' => $user, 'csrf' => $csrf];
}

/** The current password plus any legacy passwords still within their transition window. */
function msa_password_hashes(array $account, int $now): array
{
    $hashes = [$account['hash'] ?? ''];
    if (($account['transition_until'] ?? 0) > $now) {
        $hashes = array_merge($hashes, $account['transition_hashes'] ?? []);
    }
    return $hashes;
}

/** An unspent lockout bucket; the legacy single bucket uses this shape too. */
function msa_bucket_blank(): array
{
    return ['tries' => 0, 'rounds' => 0, 'until' => 0];
}

/** The key a client address is stored under; '' (no address known) is one shared bucket of its own. */
function msa_client_key(string $client): string
{
    return hash('sha256', substr($client, 0, 255));
}

/** The bucket for one client address, or a blank one. */
function msa_bucket(array $account, string $client): array
{
    $row = $account['lockouts'][msa_client_key($client)] ?? null;
    return is_array($row) ? $row + msa_bucket_blank() : msa_bucket_blank();
}

/** Store a bucket, dropping spent ones (24 h after their end) and capping the table. */
function msa_bucket_put(array &$account, string $client, array $bucket, int $now): void
{
    $rows = is_array($account['lockouts'] ?? null) ? $account['lockouts'] : [];
    $rows[msa_client_key($client)] = array_replace($bucket, ['seen' => $now]);
    $rows = array_filter($rows, static fn($r) => is_array($r) && max((int) ($r['until'] ?? 0), (int) ($r['seen'] ?? 0)) > $now - MSA_LOCKOUT_KEEP);
    if (count($rows) > MSA_LOCKOUT_BUCKETS) {
        uasort($rows, static fn($a, $b) => max((int) ($a['until'] ?? 0), (int) ($a['seen'] ?? 0)) <=> max((int) ($b['until'] ?? 0), (int) ($b['seen'] ?? 0)));
        $rows = array_slice($rows, count($rows) - MSA_LOCKOUT_BUCKETS, null, true);
    }
    $account['lockouts'] = $rows;
}

/** Forget one client's bucket after a good sign-in. */
function msa_bucket_clear(array &$account, string $client): void
{
    unset($account['lockouts'][msa_client_key($client)]);
    if (($account['lockouts'] ?? null) === []) { unset($account['lockouts']); }
}

/**
 * Until when this account refuses this client (unix time, 0 = not locked): the account-wide lock, which binds every client
 * alike (no address is trusted, not even one that signed in before: the library of 2026-11-10 let those through and kept a
 * `known` list for it, which a guesser could forge; a leftover list grants nothing and is dropped on the account's next
 * good sign-in, reset, unlock or set-hash), else this address's bucket or an unexpired single bucket of the oldest library.
 */
function msa_account_locked_until(array $account, string $client, int $now): int
{
    $until = max((int) msa_bucket($account, $client)['until'], (int) ($account['lockout']['until'] ?? 0), (int) ($account['wide']['until'] ?? 0));
    return $until > $now ? $until : 0;
}

/** When this account is locked for this client address until (unix time), or 0 when it is not; the account-wide lock answers the same for every address. Reads only. */
function msa_lockout_until(array $cfg, string $username, string $client = ''): int
{
    $user = msa_normalize_username($username);
    $account = $user === null ? null : (msa_store_read($cfg)['accounts'][$user] ?? null);
    return $account === null ? 0 : msa_account_locked_until($account, $client, time());
}

/** Stamp the first successful sign-in once; a transition hash can never be attached after it. */
function msa_stamp_first_login(array &$db, string $user, int $now): void
{
    if (!isset($db['accounts'][$user]['first_login'])) { $db['accounts'][$user]['first_login'] = $now; }
}

/**
 * Verify a password and issue a session. Two locks: CalMind's escalating ladder per account and client address (5 wrong
 * guesses, then 5, 10, 60, 120, 180 minutes), a speed bump only since the address can be forged; and the account-wide lock:
 * MSA_WIDE_TRIES failures from any addresses lock the account for every client, the right password included (15, 60, 180,
 * 720 minutes), so neither varying nor forging the address makes guessing free. A good sign-in (possible only while no lock
 * holds) starts the account-wide count over. `$device` and `$client` are required on purpose: `$client` is the caller's
 * address, '' only when it truly has none (all such callers then share one bucket); `$scope` limits the session to bearer callers.
 */
function msa_login(array $cfg, string $username, string $password, string $device, string $client, string $scope = ''): ?array
{
    $user = msa_normalize_username($username);
    if ($user === null || $password === '' || strlen($password) > 1024 || str_contains($password, "\0")) { return null; }
    $account = msa_store_read($cfg)['accounts'][$user] ?? null;
    if ($account === null) {
        msa_dummy_verify($password);
        return null;
    }
    $now = time();
    // A locked account pays the same bcrypt as an unknown name, so speed never tells them apart. The real hash is not checked.
    if (msa_account_locked_until($account, $client, $now) > 0) {
        msa_dummy_verify($password);
        return null;
    }
    $hashes = msa_password_hashes($account, $now);
    $matched = null;
    foreach ($hashes as $hash) {
        if (msa_verify_password($password, $hash)) {
            $matched = $hash;
            break;
        }
    }
    // Bcrypt stays outside the cross-app lock. Recheck credentials and lockout
    // before committing so a concurrent password change or lockout wins.
    return msa_lock($cfg, function () use ($cfg, $user, $hashes, $matched, $device, $client, $scope): ?array {
        $db = msa_store_read($cfg);
        $account = $db['accounts'][$user] ?? null;
        $now = time();
        if ($account === null || msa_password_hashes($account, $now) !== $hashes) { return null; }
        if (msa_account_locked_until($account, $client, $now) > 0) { return null; }
        $bucket = msa_bucket($account, $client);
        if ($matched !== null) {
            $account['hash'] = $matched;
            msa_bucket_clear($account, $client);
            // No lock holds here (checked above, under this lock), so the account-wide count starts over.
            unset($account['lockout'], $account['wide'], $account['known'], $account['transition_until'], $account['transition_hashes']);
            $db['accounts'][$user] = $account;
            msa_stamp_first_login($db, $user, $now);
            $session = msa_issue_session($db, $user, $device, $now, $scope);
            msa_store_write($cfg, $db);
            return $session;
        }
        if (++$bucket['tries'] >= 5) {
            $round = ++$bucket['rounds'];
            $minutes = [5, 10, 60, 120, 180][$round - 1] ?? 180 + 60 * ($round - 5);
            $bucket['tries'] = 0;
            $bucket['until'] = $now + 60 * $minutes;
        }
        msa_bucket_put($account, $client, $bucket, $now);
        $wide = is_array($account['wide'] ?? null) ? $account['wide'] + msa_bucket_blank() : msa_bucket_blank();
        if (++$wide['tries'] >= MSA_WIDE_TRIES) {
            $round = ++$wide['rounds'];
            $wide['tries'] = 0;
            $wide['until'] = $now + 60 * ([15, 60, 180][$round - 1] ?? 720);
        }
        $account['wide'] = $wide;
        $db['accounts'][$user] = $account;
        msa_store_write($cfg, $db);
        return null;
    });
}

/** A current session must have a live account, a sliding lifetime, and a CSRF secret. */
function msa_live_session(array $db, string $id, int $now): ?array
{
    $row = $db['sessions'][$id] ?? null;
    if (!is_array($row) || !msa_row_fresh($row, $now) || !is_string($row['user'] ?? null) ||
        !isset($db['accounts'][$row['user']]) || !is_string($row['csrf'] ?? null) ||
        preg_match('/\A[a-f0-9]{64}\z/', $row['csrf']) !== 1 ||
        (isset($row['scope']) && !is_string($row['scope']))) {
        return null;
    }
    return $row;
}

/** Run a read under a shared lock on the store's lock file; `$fn` may return null to ask for the exclusive path. */
function msa_lock_shared(array $cfg, callable $fn): mixed
{
    \MindSuite\Files\ensure_directory($cfg['data_dir']);
    $file = $cfg['data_dir'] . '/auth.lock';
    // 'c+', never 'c': on NFS-backed storage flock() is emulated with byte-range locks, and a shared (read) lock needs a
    // descriptor open for reading. A write-only descriptor makes LOCK_SH fail there while LOCK_EX works, so every cookie
    // check threw on the live host (test rehearsal, 2026-11-12) though the library passed on a local disk.
    $stream = @fopen($file, 'c+');
    if ($stream === false) { throw new RuntimeException('Cannot open storage lock.'); }
    try {
        if (!@chmod($file, 0600) || !flock($stream, LOCK_SH)) { throw new RuntimeException('Cannot acquire storage lock.'); }
        return $fn();
    } finally {
        flock($stream, LOCK_UN);
        fclose($stream);
    }
}

/**
 * Check a bearer header or this environment's cookie and return server-side session context.
 * A scoped row is refused on the cookie carrier and returns its `scope` to bearer callers. A cookie session slides:
 * each use extends it, and once the cookie is past half its life it is sent again with a fresh year (`renewed`).
 * The read takes only a shared lock; the exclusive lock is taken just when `last_seen` is stale or the cookie is due.
 */
function msa_session(array $cfg, ?array $server = null, ?array $cookies = null): ?array
{
    $server ??= $_SERVER;
    $cookies ??= $_COOKIE;
    $carrier = array_key_exists('HTTP_AUTHORIZATION', $server) ? 'bearer' : 'cookie';
    if ($carrier === 'bearer') {
        $header = $server['HTTP_AUTHORIZATION'];
        if (!is_string($header) || preg_match('/\ABearer[ \t]+([a-f0-9]{64})\z/i', $header, $match) !== 1) {
            return null;
        }
        $token = $match[1];
    } else {
        $token = $cookies[$cfg['cookie']] ?? null;
        if (!is_string($token) || preg_match('/\A[a-f0-9]{64}\z/', $token) !== 1) { return null; }
    }
    $id = hash('sha256', $token);
    $canSend = $carrier === 'cookie' && !headers_sent();
    $due = static function (array $row, int $now) use ($carrier, $canSend): bool {
        return $carrier === 'cookie' && $canSend && ($row['cookie_at'] ?? $row['created']) <= $now - intdiv(MSA_SESSION_AGE, 2);
    };
    $result = static fn(array $row, bool $renewed): array => [
        'user' => $row['user'], 'carrier' => $carrier, 'csrf' => $row['csrf'], 'id' => $id,
        'scope' => (string) ($row['scope'] ?? ''), 'renewed' => $renewed,
    ];
    $seen = msa_lock_shared($cfg, function () use ($cfg, $id, $carrier, $due, $result) {
        $now = time();
        $row = msa_live_session(msa_store_read($cfg), $id, $now);
        if ($row === null || ($carrier === 'cookie' && ($row['scope'] ?? '') !== '')) { return false; }
        if (($row['last_seen'] ?? 0) > $now - 3600 && !$due($row, $now)) { return $result($row, false); }
        return true;
    });
    if (!is_bool($seen)) { return $seen; }
    if ($seen === false) { return null; }
    $out = msa_lock($cfg, function () use ($cfg, $id, $carrier, $due, $result): ?array {
        $db = msa_store_read($cfg);
        $now = time();
        $row = msa_live_session($db, $id, $now);
        if ($row === null || ($carrier === 'cookie' && ($row['scope'] ?? '') !== '')) { return null; }
        $renew = $due($row, $now);
        if (($row['last_seen'] ?? 0) <= $now - 3600 || $renew) {
            $db['sessions'][$id]['last_seen'] = $now;
            if ($renew) { $db['sessions'][$id]['cookie_at'] = $now; }
            msa_store_write($cfg, $db);
        }
        return $result($row, $renew);
    });
    if ($out !== null && $out['renewed']) { msa_set_cookie($cfg, $token); }
    return $out;
}

/**
 * The logged-in account. App authorization remains the caller's responsibility. A scoped bearer (CalMind's phone token)
 * is not an account credential: it answers only a caller that names its scope.
 */
function msa_user(array $cfg, ?array $server = null, ?array $cookies = null, ?string $scope = null): ?string
{
    $session = msa_session($cfg, $server, $cookies);
    if ($session === null || ($session['scope'] ?? '') !== ($scope ?? '')) { return null; }
    return $session['user'];
}

/** A cookie-authenticated write requires a matching header and a non-cross-site request. */
function msa_write_allowed(?array $session, ?array $server = null, ?string $scope = null): bool
{
    $server ??= $_SERVER;
    if ($session !== null && ($session['scope'] ?? '') !== ($scope ?? '')) { return false; }
    if (($session['carrier'] ?? null) === 'bearer') { return true; }
    $header = $server['HTTP_X_CSRF_TOKEN'] ?? null;
    $site = $server['HTTP_SEC_FETCH_SITE'] ?? '';
    return ($session['carrier'] ?? null) === 'cookie' &&
        is_string($site) && strcasecmp($site, 'cross-site') !== 0 &&
        is_string($session['csrf'] ?? null) && is_string($header) && hash_equals($session['csrf'], $header);
}

/** Attach a host-only, secure cookie to the response. */
function msa_set_cookie(array $cfg, string $token): bool
{
    return setcookie($cfg['cookie'], $token, [
        'expires' => time() + MSA_SESSION_AGE, 'path' => $cfg['cookie_path'],
        'secure' => true, 'httponly' => true, 'samesite' => 'Lax',
    ]);
}

/** Expire the current environment's cookie at its original path. */
function msa_clear_cookie(array $cfg): bool
{
    return setcookie($cfg['cookie'], '', [
        'expires' => time() - 3600, 'path' => $cfg['cookie_path'],
        'secure' => true, 'httponly' => true, 'samesite' => 'Lax',
    ]);
}

/** Confirm an authenticated context is still current under the store lock. */
function msa_session_current(array $db, array $session): bool
{
    $id = $session['id'] ?? null;
    $row = is_string($id) ? msa_live_session($db, $id, time()) : null;
    return $row !== null && $row['user'] === ($session['user'] ?? null);
}

/** Revoke just this browser or native token. */
function msa_revoke(array $cfg, array $session): void
{
    msa_lock($cfg, function () use ($cfg, $session): void {
        $db = msa_store_read($cfg);
        if (!msa_session_current($db, $session)) { return; }
        unset($db['sessions'][$session['id']]);
        msa_store_write($cfg, $db);
    });
}

/**
 * Is this context a full account credential? A scoped (bearer-only) session may use its app and sign itself out, but may
 * not change the account's credentials or sessions: passkeys, password, sign-out-everywhere. Judged from the stored row.
 */
function msa_session_full(array $db, array $session): bool
{
    if (!msa_session_current($db, $session)) { return false; }
    return ($db['sessions'][$session['id']]['scope'] ?? '') === '';
}

/**
 * An account's revocation generation: it rises each time every session of the account is revoked at once (sign out
 * everywhere, a password change, an operator set-hash). A plan made earlier that would add sessions for the account
 * (the legacy token import) checks it under the store lock and refuses when it moved, so a revocation between the
 * plan and the write is never undone by tokens the plan had not seen.
 */
function msa_account_gen(array $db, string $user): int
{
    return (int) ($db['accounts'][$user]['gen'] ?? 0);
}

/** Revoke every session for this account in one atomic write. A scoped session is refused. */
function msa_revoke_all(array $cfg, array $session): void
{
    msa_lock($cfg, function () use ($cfg, $session): void {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session)) { return; }
        $db['sessions'] = array_filter($db['sessions'], static fn($row) => $row['user'] !== $session['user']);
        $db['accounts'][$session['user']]['gen'] = msa_account_gen($db, $session['user']) + 1;
        msa_store_write($cfg, $db);
    });
}

/** Change a password and invalidate every old session in the same transaction. The old password may be an in-window transition one. */
function msa_change_password(array $cfg, array $session, string $old, string $new): bool
{
    if (!msa_valid_new_password($new)) { return false; }
    $db = msa_store_read($cfg);
    if (!msa_session_full($db, $session)) { return false; }
    $hashes = msa_password_hashes($db['accounts'][$session['user']] ?? [], time());
    $matched = null;
    foreach ($hashes as $hash) {
        if (msa_verify_password($old, $hash)) { $matched = $hash; break; }
    }
    if ($matched === null) { return false; }
    $newHash = password_hash($new, PASSWORD_BCRYPT);
    return msa_lock($cfg, function () use ($cfg, $session, $hashes, $newHash): bool {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session)) { return false; }
        $user = $session['user'];
        $account = &$db['accounts'][$user];
        if (msa_password_hashes($account, time()) !== $hashes) { return false; }
        $account['hash'] = $newHash;
        unset($account['lockout'], $account['lockouts'], $account['wide'], $account['known'], $account['transition_hashes'], $account['transition_until']);
        $db['sessions'] = array_filter($db['sessions'], static fn($row) => $row['user'] !== $user);
        $account['gen'] = (int) ($account['gen'] ?? 0) + 1;
        msa_store_write($cfg, $db);
        return true;
    });
}

/** Whether the shared store holds this account (the name is normalised first). */
function msa_account_exists(array $cfg, string $username): bool
{
    $user = msa_normalize_username($username);
    return $user !== null && isset(msa_store_read($cfg)['accounts'][$user]);
}

/**
 * The email address the shared store holds for an account (the username is normalised first, so only the username is
 * case-insensitive: the address comes back exactly as stored), or null when there is none. Null covers every way of
 * having none: an unknown or invalid name, a missing or blank field, a value that is not an email address. An unknown
 * account and one without an address are indistinguishable to the caller. Reads only.
 */
function msa_account_email(array $cfg, string $username): ?string
{
    $user = msa_normalize_username($username);
    $account = $user === null ? null : (msa_store_read($cfg)['accounts'][$user] ?? null);
    $email = is_array($account) ? ($account['email'] ?? null) : null;
    return is_string($email) && $email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL) !== false ? $email : null;
}

/** Operator action: clear every lockout of one account, the account-wide lock included, for every client. False when it does not exist. */
function msa_admin_unlock(array $cfg, string $username): bool
{
    $user = msa_normalize_username($username);
    if ($user === null) { return false; }
    return msa_lock($cfg, function () use ($cfg, $user): bool {
        $db = msa_store_read($cfg);
        if (!isset($db['accounts'][$user])) { return false; }
        unset($db['accounts'][$user]['lockout'], $db['accounts'][$user]['lockouts'], $db['accounts'][$user]['wide'], $db['accounts'][$user]['known']);
        msa_store_write($cfg, $db);
        return true;
    });
}

/**
 * Operator action: replace an account's password with a bcrypt hash computed elsewhere. Revokes every session of the
 * account (scoped ones too) and clears its lockouts and any transition in the same write. False when the hash is not
 * a usable bcrypt hash or the account does not exist.
 */
function msa_admin_set_hash(array $cfg, string $username, string $hash): bool
{
    $user = msa_normalize_username($username);
    if ($user === null || preg_match('/\A\$2y\$\d\d\$[.\/A-Za-z0-9]{53}\z/', $hash) !== 1 ||
        (password_get_info($hash)['algo'] ?? null) === null) {
        return false;
    }
    return msa_lock($cfg, function () use ($cfg, $user, $hash): bool {
        $db = msa_store_read($cfg);
        if (!isset($db['accounts'][$user])) { return false; }
        $db['accounts'][$user]['hash'] = $hash;
        unset($db['accounts'][$user]['lockout'], $db['accounts'][$user]['lockouts'], $db['accounts'][$user]['wide'], $db['accounts'][$user]['known'],
            $db['accounts'][$user]['transition_hashes'], $db['accounts'][$user]['transition_until']);
        $db['sessions'] = array_filter($db['sessions'], static fn($row) => ($row['user'] ?? null) !== $user);
        $db['accounts'][$user]['gen'] = msa_account_gen($db, $user) + 1;
        msa_store_write($cfg, $db);
        return true;
    });
}

/**
 * Set a new password for an account whose owner has proved themselves some other way (an emailed code: CalMind's recover,
 * the site's /account/ reset). It is the owner's way out of the account-wide lock.
 * This function authenticates nobody: the caller keeps its own code store, mail and rate limits, and calls this only after
 * its own check passed. The new password must pass msa_valid_new_password; it is hashed with bcrypt here, so nothing the
 * caller hands in is ever stored as the hash. In one locked write it replaces the hash, revokes every session of the
 * account (scoped ones too), raises the account's revocation generation (so a token import planned earlier is refused),
 * and clears its lockout buckets, the account-wide lock and any transition hash. Other accounts are never touched.
 * False for an invalid password, an invalid name or an unknown account; an unknown account costs the same bcrypt hash
 * as a known one and returns the same false.
 */
function msa_reset_password(array $cfg, string $username, string $newPassword): bool
{
    if (!msa_valid_new_password($newPassword)) { return false; }
    $hash = password_hash($newPassword, PASSWORD_BCRYPT);
    $user = msa_normalize_username($username);
    if ($user === null || !is_string($hash) || (password_get_info($hash)['algoName'] ?? null) !== 'bcrypt') { return false; }
    return msa_lock($cfg, function () use ($cfg, $user, $hash): bool {
        $db = msa_store_read($cfg);
        if (!isset($db['accounts'][$user])) { return false; }
        $account = &$db['accounts'][$user];
        $account['hash'] = $hash;
        unset($account['lockout'], $account['lockouts'], $account['wide'], $account['known'], $account['transition_hashes'], $account['transition_until']);
        $db['sessions'] = array_filter($db['sessions'], static fn($row) => ($row['user'] ?? null) !== $user);
        $account['gen'] = (int) ($account['gen'] ?? 0) + 1;
        unset($account);
        msa_store_write($cfg, $db);
        return true;
    });
}
