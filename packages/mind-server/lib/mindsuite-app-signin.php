<?php
declare(strict_types=1);

require_once __DIR__ . '/mindsuite-auth.php';

/**
 * App sign-in: the code half (RFC 8252 for native apps, RFC 7636 PKCE S256).
 *
 * A native or desktop app opens the site's /account/app/ page in the system's authentication browser. The person signs
 * in there as on the web and confirms; the site issues ONE short-lived code (msa_app_signin_issue) bound to the app, the
 * exact return address, the PKCE challenge, the browser session that confirmed it and the account's revocation
 * generation. The app redeems the code at its own API (msa_app_signin_redeem) for the same scoped bearer token a
 * password sign-in gives. This file never mints a full-account session, and nothing in it logs a code, a verifier or a
 * token. The code exists in clear only in the issue result; the store keeps sha256(code) under `app_codes`.
 */
const MSA_APP_SIGNIN_TTL = 120;   // seconds a code lives
const MSA_APP_SIGNIN_LIVE = 5;    // unspent codes one account may hold at once
const MSA_APP_SIGNIN_ROWS = 50;   // rows the store keeps at most (live and spent)
/** The apps that may sign in through /account/app/: the name shown on the confirm screen and the private-use scheme (its bundle id). */
const MSA_APP_SIGNIN_CLIENTS = [
    'calmind' => ['name' => 'CalMind', 'scheme' => 'com.seancheren.calmind'],
    'chefmind' => ['name' => 'ChefMind', 'scheme' => 'com.seancheren.chefmind'],
];

/** A registered app (exact, lowercase key), or null. */
function msa_app_signin_client(string $app): ?array
{
    $client = MSA_APP_SIGNIN_CLIENTS[$app] ?? null;
    return $client === null ? null : ['app' => $app] + $client;
}

/** True for exactly "<scheme>:/signin" of that app, or "http://127.0.0.1:<1024..65535>/signin" (RFC 8252 sections 7.1 and 7.3). */
function msa_app_signin_redirect_ok(string $app, string $uri): bool
{
    $client = msa_app_signin_client($app);
    if ($client === null) { return false; }
    if ($uri === $client['scheme'] . ':/signin') { return true; }
    if (preg_match('#\Ahttp://127\.0\.0\.1:([1-9][0-9]{3,4})/signin\z#', $uri, $m) !== 1) { return false; }
    $port = (int) $m[1];
    return $port >= 1024 && $port <= 65535;
}

/** The S256 challenge of a verifier is 43 characters of base64url. */
function msa_app_signin_challenge_ok(string $challenge): bool
{
    return preg_match('/\A[A-Za-z0-9_-]{43}\z/', $challenge) === 1;
}

/** The app's own anti-forgery value, echoed back to it untouched. */
function msa_app_signin_state_ok(string $state): bool
{
    return preg_match('/\A[A-Za-z0-9_-]{16,128}\z/', $state) === 1;
}

/** base64url(sha256(verifier)) without padding (RFC 7636 section 4.2). */
function msa_app_signin_s256(string $verifier): string
{
    return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
}

/** The store's table with every damaged or expired row dropped: a damaged table is read as empty and rewritten clean. */
function msa_app_signin_rows(mixed $rows, int $now): array
{
    if (!is_array($rows)) { return []; }
    $keep = [];
    foreach ($rows as $id => $row) {
        if (is_string($id) && preg_match('/\A[a-f0-9]{64}\z/', $id) === 1 && is_array($row) && is_int($row['until'] ?? null) && $row['until'] > $now) {
            $keep[$id] = $row;
        }
    }
    return $keep;
}

/** Write the table back, dropping the key when it is empty so a store that never used it keeps its old shape. */
function msa_app_signin_put(array &$db, array $rows): void
{
    if ($rows === []) { unset($db['app_codes']); }
    else { $db['app_codes'] = $rows; }
}

/**
 * Issue one code for a live FULL cookie session. ['ok' => true, 'code' => 64 hex] or ['ok' => false, 'why' => ...]:
 * 'request' (not a cookie session, a scoped one, or a bad app, return address or challenge: judged before the lock),
 * 'session' (the stored row is scoped, revoked or its account is gone) or 'busy' (too many live codes or rows).
 */
function msa_app_signin_issue(array $cfg, array $session, string $app, string $redirect, string $challenge, int $now): array
{
    if (($session['carrier'] ?? null) !== 'cookie' || ($session['scope'] ?? null) !== '' || !is_string($session['id'] ?? null) ||
        !is_string($session['user'] ?? null) || !msa_app_signin_redirect_ok($app, $redirect) || !msa_app_signin_challenge_ok($challenge)) {
        return ['ok' => false, 'why' => 'request'];
    }
    return msa_lock($cfg, function () use ($cfg, $session, $app, $redirect, $challenge, $now): array {
        $db = msa_store_read($cfg);
        if (!msa_session_full($db, $session)) { return ['ok' => false, 'why' => 'session']; }
        $user = (string) $session['user'];
        $rows = msa_app_signin_rows($db['app_codes'] ?? [], $now);
        $mine = 0;
        foreach ($rows as $row) {
            if (($row['user'] ?? null) === $user && !isset($row['spent'])) { $mine++; }
        }
        if ($mine >= MSA_APP_SIGNIN_LIVE || count($rows) >= MSA_APP_SIGNIN_ROWS) { return ['ok' => false, 'why' => 'busy']; }
        $code = bin2hex(random_bytes(32));
        $rows[hash('sha256', $code)] = [
            'user' => $user, 'app' => $app, 'redirect' => $redirect, 'challenge' => $challenge, 'sid' => (string) $session['id'],
            'gen' => msa_account_gen($db, $user), 'created' => $now, 'until' => $now + MSA_APP_SIGNIN_TTL,
        ];
        msa_app_signin_put($db, $rows);
        msa_store_write($cfg, $db);
        return ['ok' => true, 'code' => $code];
    });
}

/**
 * Redeem a code for a scoped session ['token', 'user', 'csrf'], or null. One attempt per code: the row is removed before
 * anything is checked. A second redemption of a spent code revokes the session the first one minted. `$scope` must be a
 * real scope: a code never mints a full-account session. `$now` is the code clock only; session rows use the real clock.
 */
function msa_app_signin_redeem(array $cfg, string $app, string $code, string $verifier, string $redirect, string $device, string $scope, int $now): ?array
{
    if (preg_match('/\A[a-z0-9_-]{1,40}\z/', $scope) !== 1) { throw new InvalidArgumentException('Invalid session scope.'); }
    if (preg_match('/\A[a-f0-9]{64}\z/', $code) !== 1 || preg_match('/\A[A-Za-z0-9._~-]{43,128}\z/', $verifier) !== 1 ||
        msa_app_signin_client($app) === null) {
        return null;
    }
    $id = hash('sha256', $code);
    // A code nobody issued never takes the exclusive lock.
    $known = msa_lock_shared($cfg, static fn(): bool => isset(msa_app_signin_rows(msa_store_read($cfg)['app_codes'] ?? [], $now)[$id]));
    if (!$known) { return null; }
    return msa_lock($cfg, function () use ($cfg, $app, $verifier, $redirect, $device, $scope, $now, $id): ?array {
        $db = msa_store_read($cfg);
        $rows = msa_app_signin_rows($db['app_codes'] ?? [], $now);
        $row = $rows[$id] ?? null;
        if ($row === null) { return null; }
        unset($rows[$id]);   // one attempt per code, whatever happens next
        msa_app_signin_put($db, $rows);
        if (isset($row['spent'])) {
            if (is_string($row['spent'])) { unset($db['sessions'][$row['spent']]); }
            msa_store_write($cfg, $db);
            return null;
        }
        $live = is_string($row['sid'] ?? null) ? msa_live_session($db, $row['sid'], time()) : null;
        $ok = ($row['app'] ?? null) === $app
            && is_string($row['redirect'] ?? null) && hash_equals($row['redirect'], $redirect)
            && is_string($row['challenge'] ?? null) && hash_equals($row['challenge'], msa_app_signin_s256($verifier))
            && is_string($row['user'] ?? null) && isset($db['accounts'][$row['user']])
            && msa_account_gen($db, $row['user']) === (int) ($row['gen'] ?? -1)
            && $live !== null && $live['user'] === $row['user'] && ($live['scope'] ?? '') === '';
        if (!$ok) {
            msa_store_write($cfg, $db);
            return null;
        }
        $s = msa_issue_session($db, $row['user'], $device, time(), $scope);
        $rows[$id] = ['spent' => hash('sha256', $s['token']), 'until' => $row['until']];
        msa_app_signin_put($db, $rows);
        msa_store_write($cfg, $db);
        return $s;
    });
}
