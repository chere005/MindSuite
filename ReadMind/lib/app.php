<?php
/**
 * ReadMind's one lib — config, the CalMind-backed login, and the small
 * helpers the page needs. owner request, 2026-08-23: "make a clone of the site's bookshelf
 * that uses calmind logins and call the new repo ReadMind".
 *
 * WHY CALMIND LOGINS. This app has no account store, no signup flow and no
 * password to hash, on purpose: a username and password are proven by POSTing
 * CalMind's own `login` action — the same call every CalMind client makes —
 * and the session here holds only the verdict. CalMind going down takes
 * sign-IN down and nothing else: an open session keeps working, because the
 * token is checked at login and not per request. One account system for the
 * suite (owner request, 2026-08-23: "really core should be providing authentication
 * for all apps" — until core does, CalMind's API is the nearest thing to it).
 *
 * TWO MODES, chosen on every request by the site's library (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry
 * points"). SHARED: the suite's one sign-in is switched on for this instance and ReadMind is not on hold there. The
 * site's door, mss_app_gate_with(), is asked first and either ends the request (303 to /account/?next=, 401 JSON for a
 * background call, 403 for a post that fails its checks, 503 when the store cannot be read) or names the signed-in
 * account and its CSRF token. This app then has no sign-in form, takes no password and starts no PHP session. LEGACY:
 * the door answers null (the instance is off, ReadMind is held, a malformed hold) or the site's library is older than
 * the door; everything above applies unchanged. A switched-on instance that cannot be read never falls back to legacy.
 * RELEASE ORDER: on the host this app needs that instance's site library (site 0.59.0 or later), shared sign-in on or
 * off; where the library or its configuration is missing every request is a logged 503, never the legacy form.
 *
 * THE BASELINE for how to work in this repo is ~/GIT/AgentSuite/AGENTS.md.
 */

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/hitlog.php';

/**
 * Which instance this request is — '' is production, 'test'/'dev' the
 * sandboxes. Same three signals as the site's pages: the directory the
 * code runs from, the request path, and the subdomain the rewrite serves.
 */
function bm_instance(): string
{
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    foreach (['test', 'dev'] as $i) {
        if (preg_match('#/' . $i . '/#', __DIR__ . '/') === 1
            || strncmp($_SERVER['REQUEST_URI'] ?? '', '/' . $i . '/', strlen($i) + 2) === 0
            || strncmp($host, $i . '.', strlen($i) + 1) === 0) { return $i; }
    }
    return '';
}

/**
 * Config, derived rather than kept: this app has no secrets of its own. The
 * data key lives beside the data (store.php generates data/.datakey on first
 * use), and the one thing per instance is WHERE data lives and WHICH CalMind
 * answers logins — each instance signs in against its own CalMind, so a test
 * login can never be a production login.
 */
function app_config(): array
{
    static $cfg = null;
    if ($cfg !== null) { return $cfg; }
    $inst = bm_instance();
    $suffix = $inst === '' ? '' : '-' . $inst;
    $onHost = is_dir('/home/protected');
    $cfg = [
        'base'     => $inst === '' ? '' : '/' . $inst,
        'data_dir' => $onHost ? '/home/protected/readmind-data' . $suffix
                              : dirname(__DIR__) . '/data' . $suffix,
        'data_key' => '',
        'calmind_api' => getenv('READMIND_CALMIND_API_URL') ?: 'https://' . ($inst === '' ? '' : $inst . '.') . 'seancheren.com/CalMind/api/index.php',
    ];
    // The harness reroutes both taps — tools/test.php runs a mock CalMind and
    // a scratch data dir, and this is the whole seam it needs.
    if (($api = getenv('READMIND_TEST_API')) !== false && $api !== '') { $cfg['calmind_api'] = $api; }
    if (($dd = getenv('READMIND_TEST_DATA')) !== false && $dd !== '') { $cfg['data_dir'] = $dd; }
    $cfg['people'] = app_people();
    return $cfg;
}

/**
 * The role-to-id map from the private config file (config.php beside the app,
 * /home/protected/readmind-config.php on the host, READMIND_CONFIG overrides):
 * ['people' => ['owner' => '<account id>']]. Missing or invalid gives [], and
 * the owner hit-log lane then simply does not exist. This is the one seam.
 */
function app_people(): array
{
    $file = getenv('READMIND_CONFIG');
    if ($file === false || $file === '') {
        $file = is_dir('/home/protected') ? '/home/protected/readmind-config.php' : dirname(__DIR__) . '/config.php';
    }
    if (!is_file($file) || !is_readable($file)) { return []; }
    try {
        $c = (static function (string $f) { return include $f; })($file);
    } catch (\Throwable $e) {
        return [];
    }
    $o = is_array($c) ? ($c['people']['owner'] ?? null) : null;
    if (!is_string($o) || preg_match('/^[a-z0-9_-][a-z0-9_.-]{0,63}$/i', $o) !== 1) { return []; }
    return ['owner' => $o];
}

function suite_base(): string
{
    $b = trim((string) (app_config()['base'] ?? ''), '/');
    return $b === '' ? '' : '/' . $b;
}

// ------------------------------------------------------------------------------------------------ the shared sign-in
//
// Only the site's gate file is loaded, never its auth.php: that library defines app_config(), suite_base(),
// current_user(), user_data_file(), store_*() and hit_*() too, so loading both is a fatal "Cannot redeclare", and its
// app_config() (the site's data directory and key) is not this app's. The door takes the site's configuration as an
// argument (mss_app_gate_with(), a caller that already holds it), so this app reads the instance's own config.php,
// which is where the site's own app_config() reads it from, and hands it over.

/** Stop the request with a plain-text refusal that no cache may keep. */
function bm_refuse(int $status, string $text): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store, private');
    exit($text . "\n");
}

/**
 * The page this app is served at (its directory, from the request path only), for the return target after the account
 * page's sign-in and sign-out. The site's mss_next() still has the last word: anything that is not a plain path on this
 * origin and instance falls back to the suite's home.
 */
function bm_page_path(): string
{
    $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    $dir  = substr($path, 0, (int) strrpos($path, '/') + 1);
    return $dir === '' || $dir === '/' ? '/ReadMind/' : $dir;
}

/**
 * Where this instance's copy of the site library is: /home/protected/lib, lib-test or lib-dev on the host, or the
 * directory READMIND_SITE_LIB names (the test harness; the web server never sets it). Null where there is none to ask,
 * a machine that is not the host: no shared sign-in can exist there.
 */
function bm_site_lib(): ?string
{
    $env = getenv('READMIND_SITE_LIB');
    if (is_string($env) && $env !== '') { return $env; }
    if (!is_dir('/home/protected')) { return null; }
    $inst = bm_instance();
    return '/home/protected/lib' . ($inst === '' ? '' : '-' . $inst);
}

/**
 * The shared sign-in's answer for this request, asked once, before any session is read or started.
 *  - null: ReadMind keeps its own sign-in (the instance is off, ReadMind is held there, a malformed hold, a site
 *    library older than the door, or a machine with no site library).
 *  - ['user', 'csrf', 'signout' => ['action', 'next', 'account']]: the shared sign-in is on and this request holds a
 *    valid shared cookie session (never a bearer, scoped or not; never a legacy PHP session). `signout` is where the
 *    page's Log out form posts and where the account page then sends the browser (the sign-in that returns here).
 * Shared and without a session, the gate ends the request itself. A library that is there but cannot be used (the gate
 * file or the configuration missing or broken, a configuration for another instance, an answer without an account or
 * a token) is a logged 503 and never the legacy path.
 */
function bm_gate(): ?array
{
    static $done = false, $gate = null;
    if ($done) { return $gate; }
    $dir = bm_site_lib();
    if ($dir === null) { $done = true; return null; }
    try {
        $door = $dir . '/mindsuite-site-auth.php';
        if (!is_file($door)) { throw new RuntimeException("the site library has no gate file at $dir"); }
        // mss_auth_input() reads the site's sign-up code from auth.php's constant. This app never signs anyone up, so an
        // empty code (sign-up refused) is exactly right, and the real one is not loaded here.
        if (!defined('SIGNUP_CODE')) { define('SIGNUP_CODE', ''); }
        require_once $door;
        // Older than the door: the shared sign-in cannot be on for any app, so the legacy sign-in stays.
        if (!function_exists('mss_app_gate_with')) { $done = true; return null; }
        $file = $dir . '/config.php';
        if (!is_file($file)) { throw new RuntimeException("the site library has no configuration at $dir"); }
        $site = (static function (string $f) { return require $f; })($file);
        if (!is_array($site)) { throw new RuntimeException('the site configuration is not an array'); }
        $inst = bm_instance();
        // The instance this app thinks it is serving must be the instance the configuration is for: the switch, the hold,
        // the store and the cookie all come from it.
        if (mss_instance($site) !== ($inst === '' ? 'prod' : $inst)) { throw new RuntimeException('the site configuration is for another instance'); }
        $answer = mss_app_gate_with($site, 'readmind', ['next' => bm_page_path()]);
    } catch (Throwable $e) {
        error_log('ReadMind sign-in unavailable: ' . get_class($e) . ': ' . $e->getMessage());
        bm_refuse(503, 'ReadMind: sign-in is temporarily unavailable.');
    }
    $done = true;
    if ($answer === null) { return null; }
    $user = $answer['user'] ?? null;
    $csrf = $answer['csrf'] ?? null;
    if (!is_string($user) || preg_match('/\A[a-z0-9_-]{2,20}\z/', $user) !== 1 || !is_string($csrf) || $csrf === '') {
        error_log('ReadMind shared sign-in gave an unusable answer');
        bm_refuse(503, 'ReadMind: sign-in is temporarily unavailable.');
    }
    $account = mss_url_prefix($site, $_SERVER) . '/account/';
    return $gate = ['user' => $user, 'csrf' => $csrf, 'signout' => [
        'action' => $account, 'next' => mss_account_url($site, $_SERVER, bm_page_path()), 'account' => $account]];
}

/** Where Log out posts under the shared sign-in (see bm_gate()), or null while ReadMind keeps its own sign-in. */
function bm_signout(): ?array
{
    $gate = bm_gate();
    return $gate === null ? null : $gate['signout'];
}

/**
 * This request's path without its query, for the redirects that must come back to this page (after a post, a sign-in or
 * a sign-out). The page was cloned from the site's bookshelf, which had this helper in its auth library; this app has
 * no such library, so the call in public/index.php was left without a function and every post action ended in a fatal
 * error. Leading slashes and backslashes collapse to one slash (a browser reads `/\host` as `//host`), so a request line
 * like `//host/x` can never turn the redirect into a protocol-relative one.
 */
function bm_self_path(): string
{
    $uri  = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $q    = strpos($uri, '?');
    $path = $q === false ? $uri : substr($uri, 0, $q);
    return '/' . ltrim($path, "/\\");
}

function current_user(): ?string
{
    return $_SESSION['user'] ?? null;
}

/**
 * Per-user data file, filename-safe. The name is squeezed to [A-Za-z0-9_-], the same contract as the site's.
 *
 * ONE name, ONE file, spelled exactly. A reader is filed under the spelling their account has (CalMind's reply while
 * ReadMind keeps its own sign-in, the shared account's lowercase id under the shared one) and nothing is looked up by
 * case: CalMind matches usernames exactly, so 'Alex' and 'alex' can be two people, and a lookup that fell back to "the
 * one file that differs only in case" would hand one of them the other's shelf (anyone can register the lowercase twin
 * of an existing account). A shelf filed under another case therefore stays unseen, never merged, renamed or deleted;
 * the shared importer refuses mixed-case CalMind names for the same reason, and moving such a shelf is the operator's
 * word, not a guess made here on every request.
 */
function user_data_file(string $dir, string $base, ?string $user = null): string
{
    $u    = $user ?? (current_user() ?? 'default');
    $safe = preg_replace('/[^A-Za-z0-9_-]/', '_', $u);
    return rtrim($dir, '/') . "/{$base}-{$safe}.json";
}

/**
 * CalMind's verdict on a username and password, and the account's name as CalMind spells it. Returns that name when
 * CalMind's login action answers ok with a token, else null; the token is then dropped: this app talks to no API
 * afterwards, so holding a credential it never uses would be pure liability.
 *
 * The shelf is filed under CalMind's spelling, never the typed one, so an account never gets a second shelf for another
 * way of typing its name (CalMind matches usernames exactly today, so the two are equal; the rule holds if that ever
 * changes). The reply is believed only as far as it can be checked: a name that is not a CalMind username, or that is
 * not the typed name apart from case, is another account's and makes the sign-in fail rather than open someone else's
 * shelf.
 */
function calmind_login(string $user, string $pass): ?string
{
    $ctx = stream_context_create(['http' => [
        'method'  => 'POST', 'timeout' => 8, 'ignore_errors' => true,
        'header'  => "Content-Type: application/json\r\nX-Status-Probe: 1\r\n",
        'content' => json_encode(['action' => 'login', 'username' => $user, 'password' => $pass]),
    ], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $body = @file_get_contents(app_config()['calmind_api'], false, $ctx);
    $j = json_decode((string) $body, true);
    if (!is_array($j) || empty($j['ok']) || empty($j['token'])) { return null; }
    $name = $j['username'] ?? null;
    if (!is_string($name) || preg_match('/\A[A-Za-z0-9_-]{2,20}\z/', $name) !== 1 || strcasecmp($name, $user) !== 0) { return null; }
    return $name;
}

/**
 * The gate. Under the shared sign-in (bm_gate()) it returns for a signed-in reader and the site's door ends the request
 * for anyone else. Otherwise, the legacy gate: renders a login form and exits until a CalMind account signs in;
 * the session cookie is per instance, so being signed into production's
 * ReadMind says nothing about the sandboxes'.
 */
function require_login(string $area): void
{
    // The shared sign-in first (see bm_gate()). In that mode this app has no form and no session of its own: what the
    // legacy session would hold for a signed-in reader is a plain array for this one request, built from the gate's
    // answer alone, so nothing the browser sends can fill it, and the page and its helpers read it as they always have.
    $gate = bm_gate();
    if ($gate !== null) {
        $_SESSION = ['user' => $gate['user'], 'csrf' => $gate['csrf']];
        hit_log('ReadMind', $gate['user']);
        return;
    }

    $inst = bm_instance();
    session_name('BMSESS' . ($inst === '' ? '' : '_' . strtoupper($inst)));
    session_set_cookie_params(['lifetime' => 365 * 24 * 3600, 'path' => '/',
                               'secure' => !empty($_SERVER['HTTPS']), 'httponly' => true, 'samesite' => 'Lax']);
    session_start();

    if (isset($_GET['logout'])) {
        session_destroy();
        header('Location: ' . bm_self_path());
        exit;
    }
    if (!empty($_SESSION['user'])) { hit_log('ReadMind'); return; }

    $err = '';
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['bm_user'], $_POST['bm_pass'])) {
        $u = trim((string) $_POST['bm_user']);
        $name = $u === '' ? null : calmind_login($u, (string) $_POST['bm_pass']);
        if ($name !== null) {
            session_regenerate_id(true);
            $_SESSION['user'] = $name;
            hit_log('ReadMind', $name);
            header('Location: ' . bm_self_path());
            exit;
        }
        $err = 'Invalid username or password.';
        hit_log('ReadMind');
    } else {
        hit_log('ReadMind');
    }

    $area = htmlspecialchars($area, ENT_QUOTES);
    $msg  = $err === '' ? '' : '<p class="err">' . htmlspecialchars($err, ENT_QUOTES) . '</p>';
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8">'
       . '<meta name="viewport" content="width=device-width, initial-scale=1">'
       . '<title>Sign in — ' . $area . '</title><style>'
       . 'body{font-family:system-ui,sans-serif;background:#15181a;color:#ece9e2;display:flex;'
       . 'min-height:100vh;align-items:center;justify-content:center;margin:0}'
       . 'form{background:#1d2124;border:1px solid #32383c;border-radius:14px;padding:30px 34px;width:min(320px,86vw)}'
       . 'h1{font-size:1.1rem;margin:0 0 4px} p.sub{margin:0 0 18px;color:#a9a59a;font-size:.85rem}'
       . 'label{display:block;font-size:.8rem;color:#a9a59a;margin:12px 0 4px}'
       . 'input{width:100%;box-sizing:border-box;background:#23282b;border:1px solid #32383c;border-radius:8px;'
       . 'color:#ece9e2;padding:9px 11px;font-size:.95rem}'
       . 'button{margin-top:18px;width:100%;background:#5fb6ac;color:#0d1f1d;border:0;border-radius:999px;'
       . 'padding:10px;font-weight:600;font-size:.95rem;cursor:pointer}'
       . '.err{color:#f0605c;font-size:.85rem;margin:12px 0 0}'
       . '</style></head><body><form method="post">'
       . '<h1>' . $area . '</h1><p class="sub">Sign in with your CalMind account.</p>'
       . '<label for="bm_user">Username</label><input id="bm_user" name="bm_user" autocomplete="username" required>'
       . '<label for="bm_pass">Password</label><input id="bm_pass" name="bm_pass" type="password" autocomplete="current-password" required>'
       . $msg . '<button>Sign in</button></form></body></html>';
    exit;
}

/**
 * ReadMind's settings window — the shell of the suite's (same ids, so the
 * page's own theme-picker script binds unchanged) with the parts that cannot
 * be true here cut out. No password form: the password is a CalMind account's
 * (or, under the shared sign-in, the suite account's), and the one place to
 * change it is CalMind (or the account page). No suite theme row: this app's
 * themes are the book themes the $extra slot carries.
 */
function settings_modal_html(string $extra = ''): string
{
    $u = htmlspecialchars(current_user() ?? '', ENT_QUOTES);
    $so = bm_signout();
    $kind = $so === null ? 'a CalMind account' : 'your MindSuite account';
    $note = $so === null
        ? 'Password changes live in CalMind — this app checks yours there and stores nothing.'
        : 'Password and sign-in changes live on the <a href="' . htmlspecialchars($so['account'], ENT_QUOTES) . '">account page</a> — this app stores no password.';
    return <<<HTML
<div class="setmodal-backdrop" id="setBackdrop">
  <div class="setmodal">
    <h2>Settings</h2>
    <p class="setwho">Signed in as <strong>{$u}</strong> &middot; {$kind}</p>
    <p class="setnote">{$note}</p>
    {$extra}
    <div class="setactions">
      <button type="button" class="setact setdone" id="setDone" title="Done" aria-label="Done">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>
      </button>
    </div>
  </div>
</div>
HTML;
}

function settings_modal_styles(): string
{
    return <<<'CSS'
    .setmodal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: none;
                         align-items: center; justify-content: center; z-index: 60; }
    .setmodal-backdrop.open { display: flex; }
    .setmodal { background: var(--surface, #1d2124); border: 1px solid var(--line, #32383c);
                border-radius: 14px; padding: 1.4rem 1.6rem; width: min(340px, 88vw); }
    .setmodal h2 { margin: 0 0 0.3rem; font-size: 1.05rem; }
    .setmodal .setwho { margin: 0; color: var(--text-dim, #a9a59a); font-size: 0.85rem; }
    .setmodal .setnote { margin: 0.5rem 0 0; color: var(--muted, #726e64); font-size: 0.78rem; }
    .setmodal .setnote a { color: var(--accent, #5fb6ac); }
    .setmodal .setactions { display: flex; justify-content: flex-end; margin-top: 1.2rem; }
    .setmodal .setact { background: var(--accent, #5fb6ac); color: var(--accent-ink, #0d1f1d);
                        border: 0; border-radius: 999px; padding: 0.5rem 0.9rem; cursor: pointer;
                        display: inline-flex; align-items: center; }
CSS;
}

function settings_modal_script(): string
{
    return <<<'JS'
<script>(function () {
  var btn = document.getElementById('setBtn'), back = document.getElementById('setBackdrop');
  if (!btn || !back) { return; }
  var close = function () { back.classList.remove('open'); };
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = document.getElementById('userMenu'); if (menu) { menu.hidden = true; }
    back.classList.add('open');
  });
  document.getElementById('setDone').addEventListener('click', close);
  back.addEventListener('click', function (e) { if (e.target === back) { close(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { close(); } });
})();</script>
JS;
}

/** Per-user prefs file — the book theme lives in it, same as the bookshelf's. */
function theme_file(): string
{
    return user_data_file(app_config()['data_dir'], 'prefs');
}

/**
 * The suite theme layer, deliberately empty. The book themes are COMPLETE
 * palettes — every variable the page reads — so the suite's base layer would
 * only paint variables the very next rule overwrites. The page hides the
 * suite theme row for the same reason; this keeps the same call sites as the
 * bookshelf so a future diff between the two stays readable.
 */
function theme_css(): string { return ''; }

/**
 * Two-press delete, used everywhere instead of a confirm() box or an Undo button.
 * Mark any delete control `needs-confirm`: the first press arms it (fills red), the
 * second goes through. Arming disarms itself after a few seconds, and only one
 * control is ever armed, so a stray tap can't leave a landmine somewhere off screen.
 *
 * Emit these in pages that don't already use chrome_styles()/chrome_script().
 */
function confirm_delete_styles(): string
{
    return <<<CSS
    .needs-confirm.armed {
      background: #b3261e; border-color: #f66; color: #fff; font-weight: 700;
    }
    .needs-confirm.armed:hover { background: #d0342c; border-color: #f88; color: #fff; }
    CSS;
}

function confirm_delete_script(): string
{
    // Capture phase, so this runs before the page's own submit/click handlers.
    return <<<'JS'
<script>(function () {
  var armed = null, timer = null;
  // Tell the server this was confirmed. Destructive handlers refuse without it, so a
  // stale or broken page can't delete anything on a single tap.
  function confirmed(b) {
    if (b.form && !b.form.querySelector('input[name="confirm"]')) {
      var c = document.createElement('input');
      c.type = 'hidden'; c.name = 'confirm'; c.value = '1';
      b.form.appendChild(c);
    }
    disarm();
  }
  function disarm() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (armed) { armed.classList.remove('armed'); armed = null; }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.needs-confirm');
    if (!b) { disarm(); return; }          // tapping anything else calls it off
    if (b === armed) { confirmed(b); return; }   // second press: let the click through
    if (b.closest('.swiped')) { confirmed(b); return; }   // the swipe was the first press
    e.preventDefault();
    e.stopPropagation();
    disarm();
    armed = b;
    // The button keeps its own label — arming just fills it red. A × that turned into
    // the word "Delete?" resized the row it sat in and read as a different control.
    b.classList.add('armed');
    timer = setTimeout(disarm, 4000);
  }, true);
})();</script>
JS;
}

/**
 * Carry edit mode through a POST. Any form submitted while editing picks up an
 * `edit` field, so the handler's redirect can hand edit mode back and you aren't
 * dropped out of it just for adding something.
 *
 * This posted flag is the ONLY thing that may put edit mode in a redirect: the
 * server echoes it and never originates it, so the sole ways into edit mode are the
 * gestures (long-press / double-click). A handler that appended edit=1 on its own
 * meant a swipe-delete — made from outside edit mode on purpose — dumped you into it.
 */
function keep_edit_script(): string
{
    // Both halves are needed: the submit listener covers real submits, and the patched
    // prototype covers programmatic form.submit() (the rename fields' Enter/blur, the
    // pencil window's Save), which fires no submit event at all — without it, gating
    // the server on the posted flag would kick you out of edit mode on every rename.
    return <<<'JS'
<script>(function () {
  function stamp(f) {
    if (!f || f.tagName !== 'FORM') { return; }
    if (!document.body.classList.contains('editing')) { return; }
    if (f.querySelector('input[name="edit"]')) { return; }
    var i = document.createElement('input');
    i.type = 'hidden'; i.name = 'edit'; i.value = '1';
    f.appendChild(i);
  }
  document.addEventListener('submit', function (e) { stamp(e.target); }, true);
  var native = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { stamp(this); return native.apply(this, arguments); };
})();</script>
JS;
}
