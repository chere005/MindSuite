<?php
declare(strict_types=1);

/**
 * The AcctMind doorway — the whole server side of this app.
 *
 * AcctMind stores nothing on the server. Every transaction lives in the
 * browser's own storage, so there is no API here, no database, and no user
 * data for this file to protect. What it does is decide whether to hand over
 * the app at all, and it reuses the live suite's sign-in to decide: the same
 * accounts, the same session cookie, no second password to keep.
 *
 * Two modes, and the site's library chooses between them on every request
 * (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"):
 *
 *   · SHARED — the suite's one sign-in is switched on for this instance and
 *     AcctMind is not on hold there. `mss_app_gate('acctmind')` is asked first.
 *     No session ends the request with a 303 to /account/?next=, where the
 *     person signs in (this app has no sign-in form of its own in this mode and
 *     serves no POST); a session of the owner or the partner (the private
 *     config's `people`) opens the shell, any other account gets a 403 with only
 *     a Sign out form. A shared instance whose store
 *     cannot be read is a 503, never the legacy path, and the legacy PHP session
 *     is neither started nor read, so there is no second door.
 *   · LEGACY — the gate answers null (the instance is off, AcctMind is held, a
 *     hold is malformed) or the site library is older than the gate and has no
 *     such function. The doorway below runs exactly as it always did.
 *
 * How the legacy reuse works, and why it is only these few lines:
 *
 *   · The suite's production session cookie is set at path '/', so a page at
 *     /AcctMind is already inside its scope. Someone signed into the suite is
 *     signed in here, with nothing to hand between them.
 *   · `render_login()` posts to `_self_path()` — the URL it was rendered at —
 *     so the form submits back HERE. That is why this file handles the POST
 *     itself instead of calling `require_login()`: that function redirects a
 *     fresh sign-in to LOGIN_LANDING (/calmind/calendar/), which would bounce
 *     someone off AcctMind at the one moment they were trying to reach it.
 *     Everything else — the account store, the form, the session — is the
 *     suite's.
 *
 * What this DOES NOT gate: the JavaScript bundle under _expo/, which Apache
 * serves directly. That is deliberate and safe — the bundle is program text
 * with no data in it, and the ledger it reads is on the visitor's own device.
 * The app SHELL is not in the web root at all (see $shell below), so there is
 * no second door into the page itself.
 *
 * Credential handling is the SUITE's, not this app's. AcctMind never stores a
 * password, never hashes one, and never decides what counts as a match — it
 * hands the question to the suite's auth and does as it is told. Anything to
 * improve about how credentials are kept belongs in that repo, where one
 * change improves every app on the domain at once. Do not fork the check into
 * this file to "fix it here": a second implementation of a login is a second
 * thing to get wrong, and the two would drift.
 */

// ---------------------------------------------------------------- instance
//
// Which instance this is, derived from where the file is INSTALLED rather
// than from a config someone has to keep in step. Production and the sandbox
// get separate libs, separate data and separate app shells, exactly as the
// suite splits lib/lib-test and data/data-test — so a sandbox sign-in is not
// a production sign-in, and neither one can read the other's shell.
//
// The env vars exist for the test harness, which runs this file on a scratch
// directory with no /home/protected at all. The web server never sets them.
$isTest = str_starts_with(__DIR__, '/home/public/test/');

$lib = getenv('ACCTMIND_LIB');
if (!is_string($lib) || $lib === '') {
    $lib = $isTest ? '/home/protected/lib-test' : '/home/protected/lib';
}

$shell = getenv('ACCTMIND_SHELL');
if (!is_string($shell) || $shell === '') {
    $shell = $isTest ? '/home/protected/acctmind-test/app.html'
                     : '/home/protected/acctmind/app.html';
}

if (!is_file($lib . '/auth.php')) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit("AcctMind: the suite's auth library is not at $lib.\n"
       . "This app signs people in with the CalMind suite's accounts and cannot start without it.\n");
}
require_once $lib . '/auth.php';

/**
 * `e()` — HTML escaping, which `render_login()` calls but `auth.php` does not
 * define.
 *
 * An implicit contract of the suite, found the hard way: every app in
 * seancheren-site defines its own `e()` at the top of its page, and
 * `render_login()` simply assumes the caller did. Without this, the login
 * screen dies halfway through its own <head> with "Call to undefined
 * function e()" — a fatal that renders as a broken page rather than an error,
 * because the status line has already gone out.
 *
 * Guarded, so that a future suite version which does define it wins instead
 * of colliding.
 */
if (!function_exists('e')) {
    function e(?string $s): string { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
}

// ------------------------------------------------------------------- shared
//
// The suite's one door for an app, asked BEFORE anything of this file's own
// runs and before any session is read or started. `null` is "keep your legacy
// sign-in" (the instance is not switched on, AcctMind is on hold there, a hold
// is malformed, or the site library is older than the door and has no such
// function), and the legacy doorway below then runs unchanged. Anything else
// is a signed-in person: the gate ENDS the request itself for everyone who is
// not (a 303 to /account/?next=, a 403 for a post that fails its checks, a 503
// when the shared store cannot be read), so a request that gets past it is
// signed in. The gate only says who; this page then admits the owner and the
// partner alone (`people` below).

/** Stop with a plain-text refusal that no cache may keep. */
function acctmind_refuse(int $status, string $text): never {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store, private');
    exit($text);
}

/**
 * Where this doorway is served: its script's own URL path, never anything the visitor chose (the query and a path
 * after the script name are not part of it), so `?next=` on the request moves nothing. It is only the page to come
 * back to; the site's mss_next() still has the last word and falls back to the suite's home for anything that is
 * not a plain path on this origin and instance. Null (no usable script name) leaves the gate its own default.
 */
function acctmind_page_path(): ?string {
    $script = $_SERVER['SCRIPT_NAME'] ?? null;
    if (!is_string($script) || !str_starts_with($script, '/')) { return null; }
    return substr($script, 0, (int) strrpos($script, '/') + 1);
}

/**
 * [owner, partner] from the private config's `'people' => ['owner' => id, 'partner' => id]` when it names two distinct,
 * well-formed accounts (PlanMind's rule, server/lib/people.php), else null.
 */
function acctmind_people(mixed $raw): ?array {
    $ok = fn(mixed $id): bool => is_string($id) && preg_match('/^[a-z][a-z0-9_-]{0,31}$/D', $id) === 1 && !in_array($id, ['both', 'all', 'owner', 'partner'], true);
    return is_array($raw) && count($raw) === 2 && $ok($raw['owner'] ?? null) && $ok($raw['partner'] ?? null) && $raw['owner'] !== $raw['partner']
        ? [$raw['owner'], $raw['partner']] : null;
}

/** A signed-in account that is neither of the two: 403, and only a Sign out form that posts to the account page. */
function acctmind_stranger(string $csrf): never {
    $cfg = app_config();
    $next = mss_account_url($cfg, $_SERVER, acctmind_page_path());
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    exit('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
       . '<meta name="robots" content="noindex,nofollow"><title>AcctMind</title></head><body><main><h1>AcctMind</h1>'
       . '<p role="alert">This ledger is private to the two people who share it.</p>'
       . '<form method="post" action="' . e(mss_url_prefix($cfg, $_SERVER) . '/account/') . '">'
       . '<input type="hidden" name="action" value="logout"><input type="hidden" name="next" value="' . e($next) . '">'
       . '<input type="hidden" name="csrf" value="' . e($csrf) . '"><button type="submit">Sign out</button></form></main></body></html>');
}

$gate = function_exists('mss_app_gate') ? mss_app_gate('acctmind', ['next' => acctmind_page_path()]) : null;

if ($gate !== null) {
    // An answer without an account or a token is not an answer: close, do not guess.
    if (!(is_string($gate['user'] ?? null) && $gate['user'] !== '' && is_string($gate['csrf'] ?? null) && $gate['csrf'] !== '')) {
        error_log('AcctMind shared sign-in gave an unusable answer');
        acctmind_refuse(503, "AcctMind: sign-in is temporarily unavailable.\n");
    }
    // This page hands over a shell and nothing else: no sign-in is posted here (that is the account page's), and
    // `?logout` is not served (a GET must not end a session; signing out is a post to the account page).
    if (!in_array(strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')), ['GET', 'HEAD'], true)) {
        header('Allow: GET, HEAD');
        acctmind_refuse(405, "AcctMind: this page takes no posts. Sign in at the account page.\n");
    }
    // Who may be here: the owner and the partner only, named by role in the site's private config (`people`, the same
    // entry PlanMind reads; config.sample.php). A list that is missing or malformed serves nothing (503, fail closed).
    $people = acctmind_people(app_config()['people'] ?? null);
    if ($people === null) {
        error_log('AcctMind people config missing or invalid');
        acctmind_refuse(503, "AcctMind is temporarily unavailable.\n");
    }
    if (!in_array($gate['user'], $people, true)) { acctmind_stranger($gate['csrf']); }
}

// ------------------------------------------------------------------- legacy
//
// The doorway as it was before the shared sign-in: the suite's own session and
// accounts. It runs only when the gate above answered null.
if ($gate === null) {
    // ----------------------------------------------------------------- session
    session_boot();

    /** This page's own URL, for redirects that must stay on AcctMind. */
    $self = strtok((string) ($_SERVER['REQUEST_URI'] ?? '/'), '?');

    if (isset($_GET['logout'])) {
        usage_log('logout');
        $_SESSION = [];
        session_destroy();
        header('Location: ' . $self);
        exit;
    }

    // ------------------------------------------------------------------- login
    //
    // The same check the suite makes, against the same store, landing back here.
    $error = '';
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST'
        && isset($_POST['username'], $_POST['password'])) {
        $cfg  = app_config();
        $user = (string) $_POST['username'];
        $pass = (string) $_POST['password'];
        $want = auth_password_for($cfg, $user);

        // auth_password_check, NOT hash_equals against the stored value.
        //
        // This door used to compare the stored string to the typed one directly,
        // which was right while the suite stored passwords as typed. The suite
        // hashed them on 2026-08-20 ("Passwords are hashed, and every existing one
        // upgrades on its next login"), so auth_password_for() now hands back a
        // bcrypt hash and that comparison is false for EVERY correct password.
        //
        // Worse than a plain break, it was a staggered one: the suite rewrites a
        // password as a hash the next time its owner signs in THERE, so each
        // account kept working here until the day its owner logged into the main
        // site, and then stopped — with the door reporting "Invalid username or
        // password", which is what a wrong password looks like.
        //
        // The lib's own function is the check, and it handles both spellings: a
        // real hash gets password_verify, a legacy plaintext a constant-time
        // compare plus the upgrade flag. Same call the suite's own login makes.
        [$ok, $needsUpgrade] = $want === null ? [false, false] : auth_password_check($want, $pass);
        if ($ok) {
            // UPGRADE ON LOGIN, as the suite does it: the one moment the plaintext
            // is in hand and known to be right. Without this an account that signs
            // in here and nowhere else would keep its plaintext for ever.
            if ($needsUpgrade) {
                auth_password_set($cfg, $user, $pass);
            }
            // A new id on sign-in, so a session id someone else already holds
            // cannot be promoted to an authenticated one.
            session_regenerate_id(true);
            $_SESSION['auth'] = true;
            $_SESSION['user'] = $user;
            usage_log('login', $user);
            // POST -> redirect -> GET: a reload after signing in must not re-post
            // the password.
            header('Location: ' . $self);
            exit;
        }

        usage_log('login_fail', $user);
        // One message for both cases. Saying "no such user" tells anyone asking
        // which usernames exist.
        $error = 'Invalid username or password.';
    }

    if (empty($_SESSION['auth'])) {
        // 401, not 200: a signed-out fetch of this page should read as refused,
        // and an uptime check should not call the login screen a healthy app.
        http_response_code(401);
        render_login('AcctMind', $error);
        exit;
    }
}

// ------------------------------------------------------------------- serve
//
// The shell lives OUTSIDE the web root, so /AcctMind/app.html is not a way
// around any of the above. It is Expo's export with the head patch applied;
// `deploy.sh` puts it there and never leaves an index.html in the web root
// (Apache's DirectoryIndex would serve that ahead of this file and skip the
// sign-in entirely — see tools/check-deploy-guards.sh, which proves it).
if (!is_file($shell)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    exit("AcctMind: the app shell is missing at $shell. Re-run deploy.sh.\n");
}

header('Content-Type: text/html; charset=utf-8');
// The shell must always revalidate. The bundle it names is content-hashed and
// cached forever, so a stale shell is a phone running last week's app. Behind
// the shared sign-in it is also kept out of every cache, shared ones included,
// as the gate does for the suite's other pages.
header('Cache-Control: ' . ($gate !== null ? 'no-store, private' : 'no-cache'));
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
readfile($shell);
