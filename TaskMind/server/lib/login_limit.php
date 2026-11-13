<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/error.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/atomic.php';
use function MindSuite\Files\atomic_write;
use function MindSuite\Files\ensure_directory;

/*
 * The legacy sign-in's limits (the shared sign-in at /account/ has its own and does not come through here).
 *
 * On NearlyFreeSpeech.NET the client writes the address this file sees: REMOTE_ADDR is the right-most X-Forwarded-For entry the
 * CLIENT sent, and the front end adds none. So every limit keyed on an address is a speed bump and nothing more. Two caps name no
 * address and are the real brake: one per account (the name that was submitted) and one for the whole app. Their numbers, the
 * denial-of-service price and the operator's way out are in docs/LOGIN-LIMITS.md.
 */

/** Failed sign-ins one client address may make before it is refused, and how long a refusal lasts. A speed bump: the client picks the address. */
const LOGIN_FAILURES_MAX = 10;
const LOGIN_WINDOW_SECONDS = 900;
/** Failed sign-ins per submitted account name (whoever sends them, from whatever address), and for all names together, per fixed window. */
const LOGIN_ACCOUNT_FAILURES_MAX = 10;
const LOGIN_SITE_FAILURES_MAX = 100;
const LOGIN_CAPS_WINDOW_SECONDS = 3600;
/** The caps ledger, in the store's directory (plain JSON of keyed hashes and counts, 0600). */
const LOGIN_CAPS_FILE = 'login-caps.json';
const LOGIN_CAPS_LOCK = '.login-caps.lock';
/** A bcrypt hash of nothing anyone knows: a refused attempt verifies against it, so it costs the caller what a checked failure costs. */
const LOGIN_DECOY_HASH = '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

/**
 * The address a request came from, for the sign-in limiter. On NearlyFreeSpeech.NET `REMOTE_ADDR` is the load balancer,
 * the same for every visitor, and the proxy appends the real client to X-Forwarded-For. So the RIGHT-most entry that
 * is an address is the one the proxy added. Everything to its left is whatever the client chose to send, so it is never
 * trusted: a forged left-most entry would dodge the limit, or blame someone else's address. `REMOTE_ADDR` is the
 * fallback (a local run, a request with no usable header). `$server` is `$_SERVER`, passed in so tests can vary it.
 * (The right-most entry is itself client-written when the client sends the header; the caps below do not depend on it.)
 */
function client_address(array $server): string {
    $entries = explode(',', (string)($server['HTTP_X_FORWARDED_FOR'] ?? ''));
    for ($i = count($entries) - 1; $i >= 0; --$i) {
        $entry = trim($entries[$i]);
        if (filter_var($entry, FILTER_VALIDATE_IP) !== false) { return $entry; }
    }
    return (string)($server['REMOTE_ADDR'] ?? 'unknown');
}

/** What the caps ledger holds before the first failure: no site window, no accounts. */
function login_caps_empty(): array { return ['v' => 1, 'site' => ['count' => 0, 'until' => 0], 'accounts' => []]; }

/**
 * Runs `$fn` holding an exclusive lock on the ledger's lock file. The handle is opened 'c+', never 'c': on NFS-backed storage flock()
 * is emulated with byte-range locks and a handle that cannot be read can fail to lock (canon atomic.php's with_file_lock opens 'c' and
 * is a byte-for-byte copy, so the lock is taken here and the bytes still go out through its atomic_write). Cannot open or lock: throws.
 */
function login_caps_locked(string $dir, callable $fn): mixed {
    ensure_directory($dir);
    $file = $dir . '/' . LOGIN_CAPS_LOCK;
    $stream = @fopen($file, 'c+');
    if ($stream === false) { throw new \RuntimeException('Cannot open the sign-in caps lock.'); }
    try {
        if (!@chmod($file, 0600) || !flock($stream, LOCK_EX)) { throw new \RuntimeException('Cannot acquire the sign-in caps lock.'); }
        return $fn();
    } finally {
        flock($stream, LOCK_UN);
        fclose($stream);
    }
}

/**
 * The ledger: {v: 1, site: {count, until}, accounts: {<64 hex>: {count, until}}}. Missing is empty (nothing has failed yet); anything
 * else that is not exactly this shape throws, so a damaged or unreadable ledger fails closed and is never read as a fresh start.
 */
function login_caps_read(string $file): array {
    clearstatcache(true, $file);
    if (!file_exists($file)) { return login_caps_empty(); }
    $raw = is_file($file) ? @file_get_contents($file) : false;
    $data = is_string($raw) ? json_decode($raw, true, 8) : null;
    $row = static fn(mixed $r): bool => is_array($r) && count($r) === 2 && is_int($r['count'] ?? null) && $r['count'] >= 0 && is_int($r['until'] ?? null) && $r['until'] >= 0;
    $ok = is_array($data) && count($data) === 3 && ($data['v'] ?? null) === 1 && $row($data['site'] ?? null) && is_array($data['accounts'] ?? null);
    foreach ($ok ? $data['accounts'] : [] as $key => $r) { $ok = $ok && is_string($key) && preg_match('/^[0-9a-f]{64}$/D', $key) === 1 && $row($r); }
    if (!$ok) { throw new \RuntimeException('Unreadable sign-in caps.'); }
    return $data;
}

/** The ledger key of an account name: a keyed hash (the store's key), so the plain file never holds a name, or a password typed into the name field. */
function login_caps_key(Store $store, string $account): string {
    return hash_hmac('sha256', 'login-account:' . substr(strtolower(trim($account)), 0, 128), $store->derive('login-caps'));
}

/**
 * Spends one failure slot of `$account`'s cap and of the app-wide cap, in fixed windows (a window opens at its first failure, lasts
 * LOGIN_CAPS_WINDOW_SECONDS and is never extended). Returns null, spending nothing, when either cap is full; otherwise a token for
 * login_caps_refund(). The key is whatever name was submitted, existing or not, so a full cap says nothing about which names exist.
 * The ledger cannot be read or written: throws.
 */
function login_caps_reserve(Store $store, string $account): ?array {
    $dir = $store->directory();
    $key = login_caps_key($store, $account);
    return login_caps_locked($dir, function () use ($dir, $key): ?array {
        $file = $dir . '/' . LOGIN_CAPS_FILE;
        $now = time();
        $caps = login_caps_read($file);
        $caps['accounts'] = array_filter($caps['accounts'], fn(array $r) => $r['until'] > $now);
        $site = $caps['site']['until'] > $now ? $caps['site'] : ['count' => 0, 'until' => 0];
        $row = $caps['accounts'][$key] ?? ['count' => 0, 'until' => 0];
        if ($row['count'] >= LOGIN_ACCOUNT_FAILURES_MAX || $site['count'] >= LOGIN_SITE_FAILURES_MAX) { return null; }
        $bump = fn(array $r) => ['count' => $r['count'] + 1, 'until' => $r['count'] > 0 ? $r['until'] : $now + LOGIN_CAPS_WINDOW_SECONDS];
        $caps['accounts'][$key] = $bump($row);
        $caps['site'] = $bump($site);
        atomic_write($file, json_encode($caps, JSON_THROW_ON_ERROR));
        return ['account' => $caps['accounts'][$key]['until'], 'site' => $caps['site']['until']];
    });
}

/** Gives back the slot login_caps_reserve() spent, for a sign-in that turned out right (only failures count), if its window is still the one that spent it. */
function login_caps_refund(Store $store, string $account, array $token): void {
    $dir = $store->directory();
    $key = login_caps_key($store, $account);
    login_caps_locked($dir, function () use ($dir, $key, $token): void {
        $file = $dir . '/' . LOGIN_CAPS_FILE;
        $caps = login_caps_read($file);
        $row = $caps['accounts'][$key] ?? null;
        if ($row !== null && $row['until'] === $token['account'] && $row['count'] > 0) {
            if ($row['count'] === 1) { unset($caps['accounts'][$key]); } else { $caps['accounts'][$key]['count'] = $row['count'] - 1; }
        }
        if ($caps['site']['until'] === $token['site'] && $caps['site']['count'] > 0) {
            $caps['site'] = $caps['site']['count'] === 1 ? ['count' => 0, 'until' => 0] : ['count' => $caps['site']['count'] - 1, 'until' => $caps['site']['until']];
        }
        atomic_write($file, json_encode($caps, JSON_THROW_ON_ERROR));
    });
}

/**
 * One sign-in attempt from `$client` as `$account` (the submitted name, whether or not it exists). `$verify` checks the credentials and
 * returns whether they are right. Three limits, in this order:
 *  1. Per client address (the speed bump): ten failures in 15 minutes and the address is refused with 429 before anything else is
 *     looked at. The client chooses its address, so this stops nobody who wants not to be stopped.
 *  2. Per account and for the whole app (login_caps_reserve(): 10 and 100 failures per hour, named by no address). When either is full
 *     `$verify` never runs: the attempt gets the answer of a wrong password (false, never an exception), after one decoy bcrypt check so it
 *     is not measurably quicker, and it counts against its address like any failure. The right password is refused too: that is the price.
 *  3. The credentials, only for an attempt that got through both.
 * A right password clears the address's count and gives its slot back. The address ledger is the encrypted `attempts` store and holds
 * hashes, not addresses; the caps ledger is login-caps.json. Neither can be read or written: throws, so nobody is signed in.
 */
function login_attempt(Store $store, string $client, callable $verify, string $account): bool {
    $bucket = hash('sha256', $client);
    $success = false;
    $store->transaction('attempts', function (array $rows) use ($store, $bucket, $verify, $account, &$success) {
        $now = time();
        $rows = array_filter($rows, fn($r) => ($r['until'] ?? 0) > $now);
        if (($rows[$bucket]['count'] ?? 0) >= LOGIN_FAILURES_MAX) { throw new RequestError('Too many attempts. Try again in 15 minutes.', 429); }
        $slot = login_caps_reserve($store, $account);
        if ($slot === null) { password_verify('decoy', LOGIN_DECOY_HASH); }
        else {
            $success = $verify() === true;
            if ($success) { login_caps_refund($store, $account, $slot); }
        }
        if ($success) { unset($rows[$bucket]); }
        else { $rows[$bucket] = ['count' => ($rows[$bucket]['count'] ?? 0) + 1, 'until' => $rows[$bucket]['until'] ?? ($now + LOGIN_WINDOW_SECONDS)]; }
        return $rows;
    });
    return $success;
}
