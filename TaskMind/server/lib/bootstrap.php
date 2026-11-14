<?php
declare(strict_types=1);
require_once __DIR__ . '/taskmind.php';
require_once __DIR__ . '/operations.php';
require_once __DIR__ . '/login_limit.php';
require_once __DIR__ . '/staging.php';

// Only operator configuration can select an auth provider; request parameters cannot.
$instance = \TaskMind\instance_of($_SERVER['HTTP_HOST'] ?? '');
$siteLib = getenv('TASKMIND_SITE_LIB') ?: '/home/protected/lib' . $instance;
require_once $siteLib . '/auth.php';
$dataDir = getenv('TASKMIND_DATA_DIR') ?: '/home/protected/taskmind-data' . $instance;
$store = new \TaskMind\Store($dataDir);
$staging = \TaskMind\staging_hashes($dataDir, $instance);
$nonce = base64_encode(random_bytes(18));
header('Cache-Control: no-store, private, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('X-Frame-Options: DENY');
header('X-Robots-Tag: noindex, nofollow, noarchive');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-$nonce'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
ini_set('session.use_strict_mode', '1');
ini_set('session.use_only_cookies', '1');
// NFSN terminates TLS ahead of PHP. Production cookies are always Secure.
if (preg_match('/^(?:(?:test|dev)\.)?seancheren\.com(?::443)?$/i', $_SERVER['HTTP_HOST'] ?? '')) { $_SERVER['HTTPS'] = 'on'; }

/**
 * The page this app is served at (its directory, from the request path only), for the return target after the account page's sign-in and
 * sign-out. mss_next() still has the last word: anything that is not a plain same-origin path falls back to the suite's home.
 */
function tm_page_path(): string {
    $path = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    $dir = substr($path, 0, (int)strrpos($path, '/') + 1);
    return $dir === '' || $dir === '/' ? '/TaskMind/' : $dir;
}
/**
 * The shared sign-in's answer for this request (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"), asked once, by the
 * first thing that needs to know who is here (tm_user(), tm_csrf(), tm_login(), or the page itself) and before any session is read or
 * started. api.php defines TM_API first: its callers get JSON, never a redirect.
 *  - null: TaskMind keeps its own sign-in, session and CSRF token. That is the case while the instance is not switched on, while
 *    TaskMind is held there, and with a site library that has no door yet (an older one): the legacy session starts here.
 *  - ['user', 'session', 'csrf']: the shared sign-in is on and this request holds a valid shared cookie session (never a bearer, scoped
 *    or not). The legacy PHP session is not started and never consulted, so there is no second door.
 * Shared and without a session the gate ends the request itself: 303 to /account/?next= for a page, 401 JSON for the API; a write without
 * the session's token (or from another origin) is a 403, and a store that cannot be read is a 503, never the legacy path. TaskMind has no
 * sign-in form of its own in this mode. The gate says who the person is, never that they may be here: tm_member() still asks the team.
 */
function tm_gate(): ?array {
    static $done = false, $gate = null;
    if ($done) { return $gate; }
    $answer = \function_exists('mss_app_gate') ? mss_app_gate('taskmind', ['json' => \defined('TM_API'), 'next' => tm_page_path()]) : null;
    if ($answer !== null && !(is_string($answer['user'] ?? null) && is_string($answer['csrf'] ?? null) && $answer['csrf'] !== '')) {
        error_log('TaskMind shared sign-in gave an unusable answer');
        throw new \TaskMind\RequestError('TaskMind is temporarily unavailable.', 503, 'unavailable');
    }
    if ($answer === null) {
        session_boot();
        $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    } else {
        // What the legacy session would hold for a signed-in person, built from the gate's answer alone, for this one request: a plain array,
        // no PHP session is started, so nothing the browser sends can fill it. The site's helpers (current_user(), theme_file()) and the entry
        // points read it as they always have; tm_user() below judges the account from the gate, never from `auth`.
        $_SESSION = ['auth' => true, 'user' => $answer['user'], 'csrf' => $answer['csrf']];
    }
    $done = true;
    return $gate = $answer;
}

/** The signed-in site account, or null. An account is not a membership: tm_member() asks the team gate. */
function tm_user(): ?string {
    $gate = tm_gate();
    // Shared: the session proves the account (the shared store holds it, with a name that is already a member id's shape); whether it may be
    // here is the team's to say, in tm_member(), on every request.
    if ($gate !== null) { return $gate['user']; }
    $user = !empty($_SESSION['auth']) ? current_user() : null;
    return is_string($user) && isset(tm_users()[$user]) ? $user : null;
}
/** The site's configured accounts, plus the test instance's staging accounts. */
function tm_users(): array { global $staging; return (app_config()['users'] ?? []) + $staging; }
/**
 * What "an existing account" means when a member is added: the legacy list, or, under the shared sign-in, a lookup into the shared store
 * (read only when asked). Nothing lists the accounts to anyone: the answer is only whether one id is there.
 */
function tm_accounts(): array|\Closure {
    return tm_gate() === null ? tm_users() : static fn(): array => tm_shared_accounts();
}
/** The shared store's accounts, keyed by name. A store that cannot be read is a 503 refusal: never an empty list, never the legacy one. */
function tm_shared_accounts(): array {
    try {
        $cfg = mss_config(app_config());     // loads the store functions: ask for them only after, never as one expression
        return msa_store_read($cfg)['accounts'];
    }
    catch (\Throwable $e) {
        error_log('TaskMind could not read the shared accounts: ' . get_class($e));
        throw new \TaskMind\RequestError('Accounts cannot be checked right now. Try again in a moment.', 503, 'unavailable');
    }
}
/** The signed-in person's team membership (the gate, read from the workspace on every call), or a RequestError: 401 not signed in, 403 not on the team, 503 unreadable. */
function tm_member(?array &$workspace = null): array {
    global $store;
    $user = tm_user();
    if ($user === null) { throw new \TaskMind\RequestError('Sign in to open TaskMind.', empty($_SESSION['auth']) ? 401 : 403); }
    $workspace = \TaskMind\team_workspace($store, app_config(), $user);
    return \TaskMind\workspace_member($workspace, $user);
}
function tm_csrf(): void {
    tm_gate();
    $given = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf'] ?? '';
    if (!is_string($given) || !hash_equals($_SESSION['csrf'], $given)) { throw new \TaskMind\RequestError('Your session changed. Reload before saving.', 403, 'csrf'); }
    if (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && $_SERVER['HTTP_SEC_FETCH_SITE'] === 'cross-site') { throw new \TaskMind\RequestError('Cross-site request denied.', 403, 'csrf'); }
    if (isset($_SERVER['HTTP_ORIGIN'])) {
        $local = preg_match('/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/D', $_SERVER['HTTP_HOST'] ?? '') === 1;
        $expected = ($local ? 'http://' : 'https://') . ($_SERVER['HTTP_HOST'] ?? '');
        if ($_SERVER['HTTP_ORIGIN'] !== $expected) { throw new \TaskMind\RequestError('Cross-origin request denied.', 403, 'csrf'); }
    }
}
function tm_escape(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function tm_login(\TaskMind\Store $store): bool {
    // Under the shared sign-in the account page is the only way in: nothing here checks a password or counts a failure.
    if (tm_gate() !== null) { throw new \TaskMind\RequestError('Sign in on the account page.', 403, 'forbidden'); }
    global $staging;
    $user = strtolower(trim((string)($_POST['username'] ?? '')));
    $password = (string)($_POST['password'] ?? '');
    // Failures are counted per client address (a speed bump: the client chooses that address) and, naming no address, per submitted name
    // and for the whole app (login_limit.php, docs/LOGIN-LIMITS.md): all names alike, so nothing reveals which names exist.
    $success = \TaskMind\login_attempt($store, \TaskMind\client_address($_SERVER), function () use ($user, $password, $staging) {
        $hash = isset(tm_users()[$user]) ? ($staging[$user] ?? auth_password_for(app_config(), $user)) : null;
        // A real bcrypt verification also runs for unknown names.
        $matched = password_verify($password, $hash ?: '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.');
        return $hash !== null && $matched;
    }, $user);
    if ($success) {
        session_regenerate_id(true);
        $_SESSION['auth'] = true; $_SESSION['user'] = $user;
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $success;
}
