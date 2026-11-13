<?php
declare(strict_types=1);
require_once __DIR__ . '/planner.php';
require_once __DIR__ . '/login_limit.php';
require_once __DIR__ . '/staging.php';

// Only operator configuration can select an auth provider; request parameters cannot.
$instance = preg_match('/^(test|dev)\.seancheren\.com(?::\d+)?$/i', $_SERVER['HTTP_HOST'] ?? '', $match) ? '-' . strtolower($match[1]) : '';
$siteLib = getenv('PLANMIND_SITE_LIB') ?: '/home/protected/lib' . $instance;
require_once $siteLib . '/auth.php';
$planDir = getenv('PLANMIND_DATA_DIR') ?: '/home/protected/planmind-data' . $instance;
$planStore = new \PlanMind\Store($planDir);
$staging = \PlanMind\staging_hashes($planDir, $instance);
$calmindDir = \PlanMind\calmind_dir($instance);
$nonce = base64_encode(random_bytes(18));
header('Cache-Control: no-store, private, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
// SAMEORIGIN / 'self', not DENY / 'none': seancheren.com/MindSuite shows the suite's apps as tabs, each in a
// same-origin frame (the owner, 2026-11-09). Any other origin still cannot frame the planner.
header('X-Frame-Options: SAMEORIGIN');
header('X-Robots-Tag: noindex, nofollow, noarchive');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-$nonce'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
ini_set('session.use_strict_mode', '1');
ini_set('session.use_only_cookies', '1');
// NFSN terminates TLS ahead of PHP. Production cookies are always Secure.
if (preg_match('/^(?:(?:test|dev)\.)?seancheren\.com(?::443)?$/i', $_SERVER['HTTP_HOST'] ?? '')) { $_SERVER['HTTPS'] = 'on'; }

/**
 * The page this app is served at (its directory, from the request path only), for the return target after the account page's sign-in and
 * sign-out. mss_next() still has the last word: anything that is not a plain same-origin path falls back to the suite's home.
 */
function pm_page_path(): string {
    $path = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    $dir = substr($path, 0, (int)strrpos($path, '/') + 1);
    return $dir === '' || $dir === '/' ? '/PlanMind/' : $dir;
}
/**
 * The shared sign-in's answer for this request (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"), asked once, by the
 * first thing that needs to know who is here (pm_user(), pm_csrf(), pm_login(), or the page itself) and before any session is read or
 * started. api.php defines PM_API first: its callers get JSON, never a redirect.
 *  - null: PlanMind keeps its own sign-in, session and CSRF token. That is the case while the instance is not switched on, while
 *    PlanMind is held there, and with a site library that has no door yet (an older one): the legacy session starts here.
 *  - ['user', 'session', 'csrf']: the shared sign-in is on and this request holds a valid shared cookie session (never a bearer, scoped
 *    or not). The legacy PHP session is not started and never consulted, so there is no second door.
 * Shared and without a session the gate ends the request itself: 303 to /account/?next= for a page, 401 JSON for the API; a write without
 * the session's token (or from another origin) is a 403, and a store that cannot be read is a 503, never the legacy path. PlanMind has no
 * sign-in form of its own in this mode.
 */
function pm_gate(): ?array {
    static $done = false, $gate = null;
    if ($done) { return $gate; }
    $answer = \function_exists('mss_app_gate') ? mss_app_gate('planmind', ['json' => \defined('PM_API'), 'next' => pm_page_path()]) : null;
    if ($answer !== null && !(is_string($answer['user'] ?? null) && is_string($answer['csrf'] ?? null))) {
        error_log('PlanMind shared sign-in gave an unusable answer');
        throw new \PlanMind\RequestError('PlanMind is temporarily unavailable.', 503, 'unavailable');
    }
    if ($answer === null) {
        session_boot();
        $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    } else {
        // What the legacy session would hold for a signed-in person, built from the gate's answer alone, for this one request: a plain array,
        // no PHP session is started, so nothing the browser sends can fill it. The site's helpers (current_user(), theme_file()) and the entry
        // points read it as they always have; pm_user() below judges the account from the gate, never from `auth`.
        $_SESSION = ['auth' => true, 'user' => $answer['user'], 'csrf' => $answer['csrf']];
    }
    $done = true;
    return $gate = $answer;
}
function pm_user(): ?string {
    $gate = pm_gate();
    if ($gate !== null) { return in_array($gate['user'], \PlanMind\pm_person_lists(), true) ? $gate['user'] : null; }
    $user = !empty($_SESSION['auth']) ? current_user() : null;
    return \PlanMind\allowed($user, pm_users()) ? $user : null;
}
function pm_users(): array { global $staging; return (app_config()['users'] ?? []) + $staging; }
function pm_csrf(): void {
    pm_gate();
    $given = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf'] ?? '';
    if (!is_string($given) || !hash_equals($_SESSION['csrf'], $given)) { throw new \PlanMind\RequestError('Your session changed. Reload before saving.', 403, 'csrf'); }
    if (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && $_SERVER['HTTP_SEC_FETCH_SITE'] === 'cross-site') { throw new \PlanMind\RequestError('Cross-site request denied.', 403, 'csrf'); }
    if (isset($_SERVER['HTTP_ORIGIN'])) {
        $local = preg_match('/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/D', $_SERVER['HTTP_HOST'] ?? '') === 1;
        $expected = ($local ? 'http://' : 'https://') . ($_SERVER['HTTP_HOST'] ?? '');
        if ($_SERVER['HTTP_ORIGIN'] !== $expected) { throw new \PlanMind\RequestError('Cross-origin request denied.', 403, 'csrf'); }
    }
}
/** Whether this account hides CalMind's events on the Day schedule: a key of the account library's prefs file, beside the theme. */
function pm_calmind_hidden(): bool { return (store_read(theme_file())['planmindCalmind'] ?? '') === 'hidden'; }
function pm_calmind_set(bool $hidden): void {
    \PlanMind\prefs_locked(function () use ($hidden): void {
        $p = store_read(theme_file());
        if ($hidden) { $p['planmindCalmind'] = 'hidden'; } else { unset($p['planmindCalmind']); }
        store_write(theme_file(), $p);
    });
}
/** The date now in the site's timezone: the day whose open to-do cap counts what the Day view carries over. */
function pm_today(): string { return \PlanMind\today_in(app_config()['timezone'] ?? 'America/Chicago'); }
function pm_escape(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function pm_login(\PlanMind\Store $store): bool {
    // Under the shared sign-in the account page is the only way in: nothing here checks a password or counts a failure.
    if (pm_gate() !== null) { throw new \PlanMind\RequestError('Sign in on the account page.', 403, 'forbidden'); }
    global $staging;
    $user = strtolower(trim((string)($_POST['username'] ?? '')));
    $password = (string)($_POST['password'] ?? '');
    // Failures are counted per client address (a speed bump: the client chooses that address) and, naming no address, per submitted name
    // and for the whole app (login_limit.php, docs/LOGIN-LIMITS.md): all names alike, so nothing reveals which names exist.
    $success = \PlanMind\login_attempt($store, \PlanMind\client_address($_SERVER), function () use ($user, $password, $staging) {
        $hash = \PlanMind\allowed($user, pm_users()) ? ($staging[$user] ?? auth_password_for(app_config(), $user)) : null;
        // A real bcrypt verification also runs for unknown or disallowed names.
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
