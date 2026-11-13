<?php
declare(strict_types=1);

/**
 * The server suite: real PHP, real HTTP, real cookies, on a scratch directory.
 *
 * It drives `server/public/index.php` against the REAL suite auth library
 * from seancheren-site — not a stand-in. A stub would be testing this
 * harness's idea of how sign-in works, which is precisely the check that
 * passes whether or not the thing it guards is broken. If the suite's lib is
 * not on this machine, the run FAILS and says so rather than skipping.
 *
 *   php server/tools/test.php
 *   SUITE_LIB=/path/to/seancheren-site/lib php server/tools/test.php
 *
 * Two halves. The first is the doorway on its own legacy sign-in (the suite's
 * session and accounts). The second is the suite's shared sign-in, through the
 * same index.php and the site library's own door (mss_app_gate): off, held in
 * several spellings, malformed holds, another instance only, a library older
 * than the door; on with no session, with a session, with no second door, and
 * on but unable to work (closed, never the legacy form). Every server is a
 * PHP built-in server on a port the OS hands out, so none of the suite's
 * reserved lane ports is ever taken (PORT=<n> pins the first one).
 *
 * Nothing here touches a real data directory, a real account, or the network.
 */

$root  = dirname(__DIR__, 2);
// The suite checked out beside this repo, which is how it is usually laid
// out. SUITE_LIB overrides it; nothing here assumes a particular machine.
$lib   = getenv('SUITE_LIB') ?: dirname($root) . '/seancheren-site/lib';
$port  = (int) (getenv('PORT') ?: free_port());

if (!is_file($lib . '/auth.php')) {
    fwrite(STDERR,
        "server suite: the suite's auth library is not at $lib.\n"
      . "AcctMind's sign-in IS the suite's sign-in, so this suite tests against the real\n"
      . "thing. Point SUITE_LIB at the suite's lib/ directory, or clone it beside this\n"
      . "repo. (Refusing to stub it:\n"
      . "a mocked auth check here would pass whether or not the doorway actually works.)\n");
    exit(1);
}

// ------------------------------------------------------------ the scratch instance
$tmp = sys_get_temp_dir() . '/acctmind-test-' . getmypid();
$web = "$tmp/web";
@mkdir($web . '/_expo', 0700, true);
@mkdir("$tmp/data", 0700, true);
@mkdir("$tmp/shell", 0700, true);
register_shutdown_function(static function () use ($tmp) { rrm($tmp); });

copy("$root/server/public/index.php", "$web/index.php");
file_put_contents("$tmp/shell/app.html", "<!doctype html><title>AcctMind</title><div id=\"root\">ACCTMIND-SHELL</div>");
file_put_contents("$web/_expo/bundle.js", "console.log('bundle')");

// Seed one account through the suite's own API, so the store is written the
// way the suite writes it rather than the way this file imagines it does.
putenv("SUITE_DATA_DIR=$tmp/data");
require_once $lib . '/auth.php';
$cfg = app_config();
accounts_save($cfg, ['tester' => ['password' => 'correct horse']]);
auth_password_set($cfg, 'tester', 'correct horse');

// ------------------------------------------------------------------ the server
$env = "SUITE_DATA_DIR=$tmp/data ACCTMIND_LIB=" . escapeshellarg($lib)
     . ' ACCTMIND_SHELL=' . escapeshellarg("$tmp/shell/app.html");
$srv = proc_open(
    "$env exec php -d opcache.enable=0 -S 127.0.0.1:$port -t " . escapeshellarg($web) . ' 2>/dev/null',
    [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, null, null, ['bypass_shell' => false]);
register_shutdown_function(static function () use ($srv) { if (is_resource($srv)) { proc_terminate($srv, SIGKILL); } });
for ($i = 0; $i < 100 && @fsockopen('127.0.0.1', $port) === false; $i++) { usleep(50_000); }

// ------------------------------------------------------------------- the checks
$pass = 0; $fail = 0;

/** GET/POST with a cookie jar, returning [status, headers, body]. */
function req(string $path, ?array $post = null, ?string $jar = null): array {
    global $port;
    $cmd = 'curl -s -i -o - -w "\n@@%{http_code}" --max-time 10';
    if ($jar !== null) { $cmd .= ' -c ' . escapeshellarg($jar) . ' -b ' . escapeshellarg($jar); }
    if ($post !== null) {
        foreach ($post as $k => $v) { $cmd .= ' --data-urlencode ' . escapeshellarg("$k=$v"); }
    }
    $cmd .= ' ' . escapeshellarg("http://127.0.0.1:$port$path");
    $out = (string) shell_exec($cmd);
    $at = strrpos($out, "\n@@");
    $code = (int) substr($out, $at + 3);
    $raw = substr($out, 0, $at);
    // Follow-free: we assert on the redirect itself.
    [$head, $body] = array_pad(preg_split("/\r?\n\r?\n/", $raw, 2), 2, '');
    return [$code, $head, $body];
}

function check(string $what, bool $ok, string $detail = ''): void {
    global $pass, $fail;
    if ($ok) { $pass++; echo "  ok   $what\n"; }
    else { $fail++; echo "  FAIL $what" . ($detail !== '' ? "\n       $detail" : '') . "\n"; }
}

echo "server suite (real suite lib at $lib)\n";

$jar = "$tmp/cookies.txt";

// --- signed out ------------------------------------------------------------
[$code, , $body] = req('/');
check('signed out: answers 401, not 200', $code === 401, "got $code");
check('signed out: the app shell is NOT sent', !str_contains($body, 'ACCTMIND-SHELL'));
check('signed out: a login form is', str_contains($body, 'password') && str_contains($body, '<form'));

// --- wrong password --------------------------------------------------------
[$code, , $body] = req('/', ['username' => 'tester', 'password' => 'wrong'], $jar);
check('wrong password: refused', $code === 401, "got $code");
check('wrong password: no shell', !str_contains($body, 'ACCTMIND-SHELL'));
check('wrong password: says so', str_contains($body, 'Invalid username or password'));

// --- unknown user tells you nothing extra ----------------------------------
[, , $body2] = req('/', ['username' => 'nobody-at-all', 'password' => 'wrong'], "$tmp/j2.txt");
check('an unknown username gets the SAME message as a wrong password',
    str_contains($body2, 'Invalid username or password'));

// --- right password --------------------------------------------------------
[$code, $head, ] = req('/', ['username' => 'tester', 'password' => 'correct horse'], $jar);
check('right password: redirects rather than rendering', $code === 302, "got $code");
check('right password: redirects back to AcctMind, not the calendar',
    (bool) preg_match('~^Location:\s*/\s*$~mi', $head), trim($head));

// --- a PLAINTEXT stored password authenticates NOBODY ----------------------
//
// This block used to assert the opposite: plaintext signs in and upgrades to
// a hash on the way through. That was the 2026-08-20 migration's contract,
// and the migration is OVER — on 2026-08-23 every store was converted and
// verified and the suite's auth_password_check stopped accepting a non-hash
// at all (the owner: "blow away all plaintext passwords... are all auth for all
// app capable of only dealing with hashed passwords from now on?"). This door
// requires the suite's lib, so it inherits that refusal — and this test now
// proves the refusal REACHES the door, because a hand-edited plaintext line
// silently working again is exactly the regression worth an alarm.
$pwFile = auth_passwords_file($cfg);
$own = store_read($pwFile);
$own['tester'] = 'correct horse';          // as the old store held one
store_write($pwFile, $own);
$legacyJar = "$tmp/j3.txt";
[$code, , ] = req('/', ['username' => 'tester', 'password' => 'correct horse'], $legacyJar);
check('a plaintext stored password is refused, even when typed correctly', $code === 401, "got $code");
$after = (string) (store_read($pwFile)['tester'] ?? '');
check('…and the refusal is not a silent rewrite — the bad value is left for a human',
    $after === 'correct horse', 'was: ' . substr($after, 0, 12));
// Restore the account to the shape every account has now, and prove that
// shape opens the door — the pair is the whole contract.
$own = store_read($pwFile);
$own['tester'] = password_hash('correct horse', PASSWORD_DEFAULT);
store_write($pwFile, $own);
[$code, , ] = req('/', ['username' => 'tester', 'password' => 'correct horse'], $legacyJar);
check('the same password as a stored hash signs in', $code === 302, "got $code");

// --- signed in -------------------------------------------------------------
[$code, $head, $body] = req('/', null, $jar);
check('signed in: 200', $code === 200, "got $code");
check('signed in: the shell is served', str_contains($body, 'ACCTMIND-SHELL'));
check('signed in: the shell is told not to cache', (bool) preg_match('~Cache-Control:.*no-cache~i', $head));
check('signed in: nosniff is set', (bool) preg_match('~X-Content-Type-Options:\s*nosniff~i', $head));

// --- the session is what carries it ---------------------------------------
[$code, , $body] = req('/');                       // no jar: a different visitor
check('another visitor with no cookie is still signed out', $code === 401 && !str_contains($body, 'ACCTMIND-SHELL'));

// --- logout ----------------------------------------------------------------
req('/?logout=1', null, $jar);
[$code, , $body] = req('/', null, $jar);
check('after logout: signed out again', $code === 401 && !str_contains($body, 'ACCTMIND-SHELL'));

// --- no path hands out the shell to a stranger ----------------------------
//
// The status codes here are PHP's built-in server, which falls through to
// index.php for a missing file rather than 404ing as Apache would. So the
// assertion is the one that holds on BOTH: whatever the path, a signed-out
// visitor never receives the shell. That the deploy leaves no index.html in
// the web root — the DirectoryIndex bypass — is a filesystem fact, and
// tools/check-deploy-guards.sh is where it is proven.
foreach (['/app.html', '/index.html', '/../shell/app.html', '/?logout=0'] as $path) {
    [, , $body] = req($path);
    check("signed out, $path does not hand over the shell", !str_contains($body, 'ACCTMIND-SHELL'));
}
check('the shell file is not in the web root at all', !is_file("$web/app.html") && !is_file("$web/index.html"));

// --- a missing shell is loud ----------------------------------------------
// Sign back in first: the logout above emptied the jar, and a 401 here would
// pass this check for entirely the wrong reason.
req('/', ['username' => 'tester', 'password' => 'correct horse'], $jar);
rename("$tmp/shell/app.html", "$tmp/shell/app.html.moved");
[$code, , $body] = req('/', null, $jar);
check('a missing shell is a 500 that says what is missing',
    $code === 500 && str_contains($body, 'app shell is missing'), "got $code");
rename("$tmp/shell/app.html.moved", "$tmp/shell/app.html");

// =============================================================================
// The suite's shared sign-in, through the same index.php
//
// The site library's door is mss_app_gate('acctmind') (seancheren-site
// docs/MINDSUITE-LOGIN.md, "The app entry points"). It answers null while the
// instance is off or AcctMind is held there, and then the doorway above is the
// whole story; otherwise a person is signed in or the gate has already ended
// the request. Every case below runs the real index.php against a disposable
// COPY of the site library (never the live configuration or a real store).
//
//   A. Off, held (several spellings), malformed holds, another instance only,
//      a library older than the door: the legacy sign-in, exactly as before.
//   B. On, no session: a 303 to /account/?next=, nothing of ours served, no PHP
//      session, no store written; the return target is never the visitor's.
//   C. On, a session: the shell, kept out of caches; no PHP session; `?logout`
//      does not sign anyone out.
//   D. On, no second door: a legacy PHP session, a bearer (scoped or not), any
//      Authorization header, a post of any kind: none opens or signs in.
//   E. On, but it cannot work: closed (503 or no page at all), never the form.
// =============================================================================
echo "\nshared sign-in (disposable copy of the site library, five servers)\n";

$sx = "$tmp/shared";
$accounts = "$sx/accounts";               // the fixture store root for the scratch server (the shared store lives under protected/)
$legacyAccounts = "$sx/accounts-legacy";  // the plain servers' legacy data directory
$sweb = "$sx/web";
foreach ([$accounts, $legacyAccounts, "$sx/sessions", "$sweb/AcctMind", "$sweb/test/AcctMind"] as $d) { mkdir($d, 0700, true); }
foreach (["$sweb/AcctMind/index.php", "$sweb/test/AcctMind/index.php"] as $to) { copy("$root/server/public/index.php", $to); }
file_put_contents("$sx/shell.html", '<!doctype html><title>AcctMind</title><div id="root">ACCTMIND-SHELL-SHARED</div>');

// ---- library copies: the same files, one config each, never the live configuration ----
$copyLib = function (string $to, string $variant = '') use ($lib): void {
    mkdir($to);
    foreach (scandir($lib) ?: [] as $name) {
        if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file("$lib/$name")) { continue; }
        copy("$lib/$name", "$to/$name");
    }
    $file = "$to/mindsuite-site-auth.php";
    $text = (string) file_get_contents($file);
    $door = 'function mss_app_gate(string $app, array $opts)';
    if ($variant === 'older') {          // a site library from before the door: the same files, the one entry point gone
        $text = str_replace($door, 'function mss_app_gate_gone(string $app, array $opts)', $text, $n);
        expect($n === 1, 'the older library lost mss_app_gate');
        file_put_contents($file, $text);
    } elseif ($variant === 'odd') {      // a door that answers with whatever the case says (an answer this page cannot use must close it)
        $text = str_replace($door, 'function mss_app_gate_real(string $app, array $opts)', $text, $n);
        expect($n === 1, 'the odd library renamed mss_app_gate');
        file_put_contents($file, $text . "\nfunction mss_app_gate(string \$app, array \$opts): ?array { return json_decode((string) @file_get_contents((string) getenv('ACCTMIND_TEST_ANSWER')), true); }\n");
    } elseif ($variant === 'bare') {     // the door is there, the account library behind it is not
        expect(unlink("$to/mindsuite-auth.php"), 'the bare library lost mindsuite-auth.php');
    }
};
$libMain = "$sx/lib"; $libOld = "$sx/lib-older"; $libOdd = "$sx/lib-odd"; $libBare = "$sx/lib-bare";
$copyLib($libMain); $copyLib($libOld, 'older'); $copyLib($libOdd, 'odd'); $copyLib($libBare, 'bare');
$legacyHash = password_hash('legacy-secret', PASSWORD_BCRYPT, ['cost' => 4]);
$configure = function (array $extra = []) use ($libMain, $libOld, $libOdd, $libBare, $legacyAccounts, $legacyHash): void {
    $config = array_replace(['users' => ['alex' => $legacyHash, 'sam' => $legacyHash], 'data_dir' => $legacyAccounts, 'data_key' => 'disposable-fixture-key',
        'timezone' => 'America/Chicago', 'base' => '', 'people' => ['owner' => 'alex', 'partner' => 'sam']], $extra);
    $config = array_filter($config, fn($v) => $v !== null);        // a null in $extra removes the key (the people list missing)
    foreach ([$libMain, $libOld, $libOdd, $libBare] as $to) { file_put_contents("$to/config.php", '<?php return ' . var_export($config, true) . ';'); }
};
$configure();

// ---- the shared store: three accounts, made by the library itself in a process of its own ----
file_put_contents("$sx/seed.php", <<<'PHP'
<?php
[, $lib, $dir] = $argv;
require $lib . '/mindsuite-auth.php';
$cfg = msa_config('prod', 'disposable-site-auth-fixture', $dir . '/protected');
$cfg['invite_code'] = '5678';
@mkdir($cfg['data_dir'], 0700, true);
msa_store_write($cfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]);
$out = [];
foreach (['alex', 'sam', 'outsider'] as $name) {
    if (!msa_signup($cfg, $name, $name . '@example.invalid', $name . '-password-1', '5678')) { fwrite(STDERR, "signup $name failed\n"); exit(1); }
    $out[$name] = msa_login($cfg, $name, $name . '-password-1', 'Firefox', '203.0.113.1');
}
$out['alex-calmind'] = msa_login($cfg, 'alex', 'alex-password-1', 'phone', '203.0.113.1', 'calmind');
$out['alex-spare'] = msa_login($cfg, 'alex', 'alex-password-1', 'spare', '203.0.113.2');
echo json_encode($out);
PHP);
file_put_contents("$sx/revoke.php", '<?php [, $lib, $dir, $token] = $argv; require $lib . "/mindsuite-auth.php"; $cfg = msa_config("prod", "disposable-site-auth-fixture", $dir . "/protected"); '
    . '$s = msa_session($cfg, ["REMOTE_ADDR" => "203.0.113.1"], ["MSSESS" => $token]); msa_revoke($cfg, $s); echo "revoked";');
$php = fn(string ...$args) => trim((string) shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...php_flags(), ...$args])) . ' 2>&1'));
$seeded = $php("$sx/seed.php", $libMain, $accounts);
$session = json_decode($seeded, true);
expect(is_array($session) && isset($session['alex']['token'], $session['sam']['token'], $session['outsider']['token'], $session['alex-calmind']['token'], $session['alex-spare']['token']),
    'the shared store was seeded: ' . substr($seeded, 0, 300));
$web = fn(string $who) => 'MSSESS=' . $session[$who]['token'];     // production's cookie name (the instance is prod: base '')
$legacyId = bin2hex(random_bytes(16));
file_put_contents("$sx/sessions/sess_$legacyId", 'auth|b:1;user|s:4:"alex";');     // a legacy PHP session of alex's, written the way PHP stores one

// ---- the servers: one docroot, a library each ----
$serverEnv = fn(array $extra): array => $extra + array_filter(getenv(), fn($k) => !str_starts_with($k, 'SUITE_') && !str_starts_with($k, 'ACCTMIND_'), ARRAY_FILTER_USE_KEY);
$servers = [];
try {
    $shell = "$sx/shell.html";
    // plain: reads the instance list and the hold from the config, like the host (no fixture switch, so the library has no store root)
    [$servers[], $plain] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => $libMain, 'ACCTMIND_SHELL' => $shell]), 'plain', $sx);
    // scratch: the library's fixture switch and a disposable store root, the only way to give it a store here
    [$servers[], $scratch] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => $libMain, 'ACCTMIND_SHELL' => $shell, 'SUITE_DATA_DIR' => $accounts, 'SUITE_MINDSUITE_AUTH_TEST' => '1']), 'scratch', $sx);
    [$servers[], $older] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => $libOld, 'ACCTMIND_SHELL' => $shell]), 'older', $sx);
    $answerFile = "$sx/answer.json";
    file_put_contents($answerFile, 'null');
    [$servers[], $odd] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => $libOdd, 'ACCTMIND_SHELL' => $shell, 'ACCTMIND_TEST_ANSWER' => $answerFile]), 'odd', $sx);

    $on = ['mindsuite_auth_instances' => ['prod'], 'mindsuite_auth_keys' => ['prod' => 'held-fixture-key']];
    $nextUrl = '/account/?next=%2FAcctMind%2F';
    $form = ['Content-Type: application/x-www-form-urlencoded'];

    // ==== A. Legacy, in every way AcctMind keeps it ====
    $legacy = function (string $why, int $port) use ($legacyId, $form): void {
        $page = http($port, 'GET', '/AcctMind/');
        expect($page['status'] === 401 && str_contains($page['body'], 'name="password"') && str_contains($page['body'], '<form') && !str_contains($page['body'], 'ACCTMIND-SHELL-SHARED') && $page['location'] === null,
            "$why: the page is the sign-in form, 401, no redirect and no shell (got {$page['status']})");
        $wrong = http($port, 'POST', '/AcctMind/', $form, http_build_query(['username' => 'alex', 'password' => 'not-it']));
        expect($wrong['status'] === 401 && str_contains($wrong['body'], 'Invalid username or password.') && !str_contains($wrong['body'], 'ACCTMIND-SHELL-SHARED'), "$why: a wrong password is refused by the doorway's own form");
        $in = http($port, 'POST', '/AcctMind/', $form, http_build_query(['username' => 'alex', 'password' => 'legacy-secret']));
        expect($in['status'] === 302 && $in['location'] === '/AcctMind/' && $in['cookies'] !== [], "$why: the right password signs in with a redirect back to the page and a PHP session cookie (got {$in['status']})");
        $app = http($port, 'GET', '/AcctMind/', cookie_header($in['cookies']));
        expect($app['status'] === 200 && str_contains($app['body'], 'ACCTMIND-SHELL-SHARED') && ($app['headers']['cache-control'][0] ?? '') === 'no-cache', "$why: the shell opens, told to revalidate (no-cache, not the shared mode's no-store)");
        $out = http($port, 'GET', '/AcctMind/?logout=1', cookie_header($in['cookies']));
        expect($out['status'] === 302 && $out['location'] === '/AcctMind/', "$why: ?logout=1 ends the PHP session and goes back to the page");
        expect(http($port, 'GET', '/AcctMind/', cookie_header($in['cookies']))['status'] === 401, "$why: and the session is gone");
        // The control for part D: a PHP session on disk opens the legacy door and only the legacy door.
        $disk = http($port, 'GET', '/AcctMind/', ['Cookie: PHPSESSID=' . $legacyId]);
        expect($disk['status'] === 200 && str_contains($disk['body'], 'ACCTMIND-SHELL-SHARED'), "$why: a PHP session on disk opens the page, as it always did");
    };
    $configure();
    $legacy('shared sign-in off (no instance list)', $plain);
    foreach ([
        'held' => ['mindsuite_auth_hold' => ['prod' => ['acctmind']]],
        'held, name in another case beside another app' => ['mindsuite_auth_hold' => ['prod' => ['AcctMind', 'planmind']]],
        'a malformed hold (a string) holds every app' => ['mindsuite_auth_hold' => 'planmind'],
        'a malformed hold (a flat list) holds every app' => ['mindsuite_auth_hold' => ['planmind']],
        'a malformed hold (an instance holding a string)' => ['mindsuite_auth_hold' => ['prod' => 'planmind']],
    ] as $why => $extra) { $configure($on + $extra); $legacy("shared sign-in on, $why", $plain); }
    $configure(['mindsuite_auth_instances' => ['test', 'dev'], 'mindsuite_auth_keys' => ['test' => 'k', 'dev' => 'k']]);
    $legacy('only other instances are on', $plain);
    $configure($on);
    $legacy('on, but the site library has no door yet (an older library)', $older);

    // ==== B. On, no session ====
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['planmind']], ]);      // a hold for another app leaves AcctMind on: the real config path
    $sessionsBefore = scandir("$sx/sessions");
    $storeBefore = tree($accounts);
    foreach (['plain server, real instance list' => $plain, 'scratch server, fixture switch' => $scratch] as $via => $port) {
        $page = http($port, 'GET', '/AcctMind/');
        expect($page['status'] === 303 && $page['location'] === $nextUrl && $page['body'] === '', "$via: a page request with no session is a 303 to $nextUrl, with no page behind it (got {$page['status']} to " . var_export($page['location'], true) . ')');
        expect(str_contains(implode(',', $page['headers']['cache-control'] ?? []), 'no-store') && $page['cookies'] === [], "$via: not cacheable, and no PHP session is started for it");
        expect(http($port, 'HEAD', '/AcctMind/')['location'] === $nextUrl, "$via: a HEAD request (curl -I) gets the same Location");
        foreach ([
            '?next=https://evil.example/' => '/AcctMind/?next=https://evil.example/',
            '?next=//evil.example/' => '/AcctMind/?next=//evil.example/&view=1',
            '?next= an encoded host' => '/AcctMind/?next=%2F%2Fevil.example%2F',
            '?next= a backslash path' => '/AcctMind/?next=%5Cevil.example',
            '?logout=1' => '/AcctMind/?logout=1',
            'the script name' => '/AcctMind/index.php',
            'a path after the script name' => '/AcctMind/index.php/%2e%2e/evil',
        ] as $what => $path) {
            expect(http($port, 'GET', $path)['location'] === $nextUrl, "$via: the return target is the page's own path, whatever the request says ($what)");
        }
        $forged = http($port, 'GET', '/AcctMind/', ['Host: evil.example', 'X-Forwarded-Host: evil.example', 'X-Forwarded-Prefix: /evil']);
        expect($forged['location'] === $nextUrl, "$via: and a forged Host or forwarding header changes nothing: the Location is a path on this origin (" . var_export($forged['location'], true) . ')');
        $post = http($port, 'POST', '/AcctMind/', $form, http_build_query(['username' => 'alex', 'password' => 'legacy-secret']));
        expect($post['status'] === 303 && $post['location'] === $nextUrl && $post['cookies'] === [] && !str_contains($post['body'], 'ACCTMIND-SHELL-SHARED'), "$via: the old sign-in form posted here (the right legacy password) gets the account page and nothing is checked");
        expect(http($port, 'PUT', '/AcctMind/')['status'] === 303, "$via: and so does any other method");
        foreach (['', '?logout=1', '/index.php', '?next=//evil.example/'] as $q) {
            $body = http($port, 'GET', '/AcctMind/' . ltrim($q, '/'))['body'];
            expect($body === '', "$via: nothing at all is sent to a visitor with no session (" . ($q === '' ? 'the page' : $q) . ')');
        }
    }
    expect(scandir("$sx/sessions") === $sessionsBefore && tree($accounts) === $storeBefore, 'no PHP session file and no byte of the store (shared or legacy) was written by any of those');
    // Where the sandbox mirror and the subdomain put the page: the account page and the return path stay in the instance.
    $configure(['base' => 'test', 'mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'held-fixture-key']]);
    $mirror = http($plain, 'GET', '/test/AcctMind/');
    expect($mirror['status'] === 303 && $mirror['location'] === '/test/account/?next=%2Ftest%2FAcctMind%2F', 'the /test/ mirror: the account page and the way back are in the mirror (got ' . $mirror['status'] . ' to ' . var_export($mirror['location'], true) . ')');
    $subdomain = http($plain, 'GET', '/AcctMind/', ['Host: test.seancheren.com']);
    expect($subdomain['status'] === 303 && $subdomain['location'] === $nextUrl, 'the test subdomain: root-relative, as the site\'s own pages (got ' . $subdomain['status'] . ' to ' . var_export($subdomain['location'], true) . ')');
    $configure($on + ['mindsuite_auth_hold' => ['test' => ['acctmind']]]);
    expect(http($plain, 'GET', '/AcctMind/')['location'] === $nextUrl, 'a hold for another instance does not hold this one');
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['planmind']]]);

    // ==== C. On, a session ====
    $alex = cookie_header(['MSSESS' => $session['alex']['token']]);
    $page = http($scratch, 'GET', '/AcctMind/', $alex);
    expect($page['status'] === 200 && str_contains($page['body'], 'ACCTMIND-SHELL-SHARED') && !str_contains($page['body'], 'name="password"'), 'a shared session opens the shell, with no form of ours');
    expect(($page['headers']['cache-control'][0] ?? '') === 'no-store, private' && ($page['headers']['x-content-type-options'][0] ?? '') === 'nosniff' && ($page['headers']['referrer-policy'][0] ?? '') === 'same-origin'
        && str_contains($page['headers']['content-type'][0] ?? '', 'text/html'), 'kept out of every cache, and still nosniff, same-origin referrer, html');
    expect($page['cookies'] === [], 'and no PHP session cookie: the legacy session is never started');
    $head = http($scratch, 'HEAD', '/AcctMind/', $alex);
    expect($head['status'] === 200 && $head['body'] === '', 'a HEAD request is let through');
    // The gate says who is signed in; the page admits the owner and the partner alone (the private config's `people`).
    expect(http($scratch, 'GET', '/AcctMind/', cookie_header(['MSSESS' => $session['sam']['token']]))['status'] === 200, "the partner's shared session opens the shell too");
    $stranger = http($scratch, 'GET', '/AcctMind/', cookie_header(['MSSESS' => $session['outsider']['token']]));
    expect($stranger['status'] === 403 && !str_contains($stranger['body'], 'ACCTMIND-SHELL-SHARED') && !str_contains($stranger['body'], 'name="password"') && $stranger['cookies'] === []
        && ($stranger['headers']['cache-control'][0] ?? '') === 'no-store, private', "a signed-in account that is neither of the two: 403, no shell, no form of ours, not cacheable (got {$stranger['status']})");
    expect(substr_count($stranger['body'], '<form') === 1 && substr_count($stranger['body'], '<button') === 1 && str_contains($stranger['body'], '<form method="post" action="/account/">')
        && str_contains($stranger['body'], 'name="action" value="logout"') && str_contains($stranger['body'], 'name="next" value="' . htmlspecialchars($nextUrl, ENT_QUOTES) . '"')
        && str_contains($stranger['body'], 'name="csrf" value="' . $session['outsider']['csrf'] . '"') && str_contains($stranger['body'], '>Sign out</button>'),
        'and its one control is a Sign out form posting to the account page, with that session\'s own token and the way back here');
    expect(http($scratch, 'HEAD', '/AcctMind/', cookie_header(['MSSESS' => $session['outsider']['token']]))['status'] === 403, 'a HEAD from the stranger is the 403 too');
    expect(http($scratch, 'POST', '/AcctMind/', [...$form, ...cookie_header(['MSSESS' => $session['outsider']['token']]), "X-CSRF-Token: {$session['outsider']['csrf']}"], 'x=1')['status'] === 405, 'and a post from the stranger is still the 405 (this page takes no posts)');
    foreach ([
        'missing' => ['people' => null],
        'empty' => ['people' => []],
        'one person' => ['people' => ['owner' => 'alex']],
        'the same person twice' => ['people' => ['owner' => 'alex', 'partner' => 'alex']],
        'a malformed id' => ['people' => ['owner' => 'Alex!', 'partner' => 'sam']],
        'a role word' => ['people' => ['owner' => 'alex', 'partner' => 'owner']],
        'a flat list' => ['people' => ['alex', 'sam']],
        'not a list' => ['people' => 'alex,sam'],
    ] as $why => $extra) {
        $configure($on + ['mindsuite_auth_hold' => ['prod' => ['planmind']]] + $extra);
        foreach (['alex' => 'the owner', 'outsider' => 'a stranger'] as $who => $role) {
            $r = http($scratch, 'GET', '/AcctMind/', cookie_header(['MSSESS' => $session[$who]['token']]));
            expect($r['status'] === 503 && $r['body'] === "AcctMind is temporarily unavailable.\n" && $r['cookies'] === [], "the people list $why: $role gets a 503 and nothing else (got {$r['status']})");
        }
    }
    expect(str_contains((string) @file_get_contents("$sx/scratch-errors.log"), 'AcctMind people config missing or invalid'), 'and the refusal is logged');
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['planmind']]]);
    expect(http($scratch, 'GET', '/AcctMind/', $alex)['status'] === 200, 'the list put back, the owner is in again');
    $out = http($scratch, 'GET', '/AcctMind/?logout=1', $alex);
    expect($out['status'] === 200 && str_contains($out['body'], 'ACCTMIND-SHELL-SHARED') && $out['location'] === null, '?logout=1 is not served in this mode: a GET sends the shell like any other and signs nobody out');
    expect(http($scratch, 'GET', '/AcctMind/', $alex)['status'] === 200, 'and the session is still good afterwards');
    $both = http($scratch, 'GET', '/AcctMind/', cookie_header(['MSSESS' => $session['alex']['token'], 'PHPSESSID' => 'stale']));
    expect($both['status'] === 200 && $both['cookies'] === [], 'a PHP session cookie beside the shared one changes nothing');
    expect(http($scratch, 'GET', '/AcctMind/?next=https://evil.example/', $alex)['status'] === 200, 'a ?next= on a signed-in request is just a query: the shell');
    expect(scandir("$sx/sessions") === $sessionsBefore, 'no PHP session file exists after any of the shared requests so far');
    // A session the account page signed out is gone: revoke it in the store the way /account/ does, then ask again.
    $spare = cookie_header(['MSSESS' => $session['alex-spare']['token']]);
    expect(http($scratch, 'GET', '/AcctMind/', $spare)['status'] === 200, 'a spare session for alex opens the shell');
    expect($php("$sx/revoke.php", $libMain, $accounts, $session['alex-spare']['token']) === 'revoked', 'and is revoked (what Sign out at the account page does)');
    $gone = http($scratch, 'GET', '/AcctMind/', $spare);
    expect($gone['status'] === 303 && $gone['location'] === $nextUrl, 'a revoked session opens nothing: it is a 303 to sign in');
    expect(http($scratch, 'GET', '/AcctMind/', $alex)['status'] === 200, 'while the session beside it is untouched');
    // The shell file is still the doorway's own business behind the gate.
    rename($shell, "$shell.moved");
    $missing = http($scratch, 'GET', '/AcctMind/', $alex);
    expect($missing['status'] === 500 && str_contains($missing['body'], 'app shell is missing'), 'a missing shell is a 500 that says what is missing, behind the gate too');
    expect(http($scratch, 'GET', '/AcctMind/')['status'] === 303, '...and a visitor with no session never learns that: it is the 303');
    rename("$shell.moved", $shell);

    // ==== D. On, no second door ====
    $pre = http($scratch, 'GET', '/AcctMind/', ['Cookie: PHPSESSID=' . $legacyId]);
    expect($pre['status'] === 303 && $pre['location'] === $nextUrl && !str_contains($pre['body'], 'ACCTMIND-SHELL-SHARED'), 'the legacy PHP session that opens the page on a legacy instance (part A) opens nothing here');
    $scoped = $session['alex-calmind']['token'];
    foreach ([
        'a scoped (CalMind) token as the bearer' => ['Authorization: Bearer ' . $scoped],
        'a scoped token as the cookie' => ['Cookie: MSSESS=' . $scoped],
        'a full account token as a bearer' => ['Authorization: Bearer ' . $session['alex']['token']],
        'the right cookie with any Authorization header beside it' => [...$alex, 'Authorization: Bearer ' . str_repeat('0', 64)],
        'the right cookie with a Basic Authorization header' => [...$alex, 'Authorization: Basic YTpi'],
        'a made-up cookie' => ['Cookie: MSSESS=' . str_repeat('0', 64)],
        'an empty cookie' => ['Cookie: MSSESS='],
    ] as $why => $headers) {
        $p = http($scratch, 'GET', '/AcctMind/', $headers);
        expect($p['status'] === 303 && $p['location'] === $nextUrl && !str_contains($p['body'], 'ACCTMIND-SHELL-SHARED'), "$why: the page sends to sign in (got {$p['status']})");
    }
    // The page takes no sign-in and no other post, from anyone: only GET and HEAD are served.
    $csrf = $session['alex']['csrf'];
    $origin = "http://127.0.0.1:$scratch";
    $beforePost = tree($accounts);
    foreach ([['action' => 'login'], ['username' => 'alex', 'password' => 'legacy-secret'], ['username' => 'alex', 'password' => 'alex-password-1'], []] as $n => $fields) {
        $r = http($scratch, 'POST', '/AcctMind/', [...$form, ...$alex, "Origin: $origin"], http_build_query(['csrf' => $csrf] + $fields));
        expect($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD' && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED') && $r['cookies'] === [], "a post to the page ($n) with the session's own token is a 405: sign in at the account page (got {$r['status']})");
    }
    $r = http($scratch, 'PUT', '/AcctMind/', [...$alex, "X-CSRF-Token: $csrf", "Origin: $origin"]);
    expect($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD', 'and so is any other method with the token');
    $r = http($scratch, 'OPTIONS', '/AcctMind/', $alex);
    expect($r['status'] === 405 && ($r['headers']['allow'][0] ?? '') === 'GET, HEAD', 'OPTIONS too: only GET and HEAD are served');
    foreach ([
        'no token' => [...$form, ...$alex],
        'a wrong token' => [...$form, ...$alex, 'X-CSRF-Token: ' . str_repeat('0', 64)],
        'another session\'s token' => [...$form, ...$alex, 'X-CSRF-Token: ' . $session['sam']['csrf']],
        'the right token from another origin' => [...$form, ...$alex, "X-CSRF-Token: $csrf", 'Origin: https://evil.example'],
        'the right token from another site' => [...$form, ...$alex, "X-CSRF-Token: $csrf", 'Sec-Fetch-Site: cross-site'],
    ] as $why => $headers) {
        $r = http($scratch, 'POST', '/AcctMind/', $headers, http_build_query(['username' => 'alex', 'password' => 'legacy-secret']));
        expect($r['status'] === 403 && $r['location'] === null && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED'), "a post with $why never gets that far: the gate's 403 (got {$r['status']})");
    }
    expect(tree($accounts) === $beforePost && !is_file("$accounts/passwords.json") && !is_file("$accounts/accounts.json"), 'none of those posts wrote a byte: no legacy password was checked or upgraded, no account made');
    expect(scandir("$sx/sessions") === $sessionsBefore, 'and no PHP session was started for any of them');
    expect(http($scratch, 'GET', '/AcctMind/', $alex)['status'] === 200, 'nothing here ended the session: signing out is the account page\'s act');

    // ==== E. On, but it cannot work: closed, never the legacy form ====
    $store = "$accounts/protected/mindsuite-auth/auth.json";
    expect(is_file($store), 'the shared store file is where the fixture puts it');
    $kept = (string) file_get_contents($store);
    file_put_contents($store, 'not a store');
    foreach (['GET' => null, 'POST' => http_build_query(['username' => 'alex', 'password' => 'legacy-secret'])] as $method => $body) {
        $r = http($scratch, $method, '/AcctMind/', [...$alex, ...($body === null ? [] : [...$form, "X-CSRF-Token: $csrf"])], $body);
        expect($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.' && $r['cookies'] === [], "an unreadable shared store: a $method answers 503 and says nothing else (got {$r['status']})");
    }
    $r = http($scratch, 'GET', '/AcctMind/');
    expect(in_array($r['status'], [303, 503], true) && !str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED'), "and a visitor with no cookie gets no form of ours and no shell (got {$r['status']})");
    file_put_contents($store, $kept);
    expect(http($scratch, 'GET', '/AcctMind/', $alex)['status'] === 200, 'the store put back, alex is in again');
    $configure(array_replace($on, ['mindsuite_auth_keys' => []]));          // switched on, but no key for the instance: the real config path
    $r = http($plain, 'GET', '/AcctMind/');
    expect($r['status'] === 503 && $r['body'] === 'MindSuite sign-in is temporarily unavailable.', "switched on with no key: 503, even to a visitor with no session (got {$r['status']}: " . substr($r['body'], 0, 120) . ')');
    expect(!str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED') && $r['cookies'] === [], 'and no password form, no shell, no cookie');
    $configure($on);
    // A door that answers with something this page cannot use closes it: no session, no legacy form, no shell.
    foreach ([
        'no CSRF token' => ['user' => 'alex'],
        'an empty CSRF token' => ['user' => 'alex', 'csrf' => ''],
        'no account' => ['csrf' => str_repeat('a', 64)],
        'an empty account' => ['user' => '', 'csrf' => str_repeat('a', 64)],
        'an account that is not text' => ['user' => ['alex'], 'csrf' => str_repeat('a', 64)],
        'a token that is not text' => ['user' => 'alex', 'csrf' => 7],
        'nothing at all' => [],
    ] as $why => $answer) {
        file_put_contents($answerFile, json_encode($answer));
        foreach (['GET', 'POST', 'HEAD'] as $method) {
            $r = http($odd, $method, '/AcctMind/', $method === 'POST' ? $form : [], $method === 'POST' ? 'x=1' : null);
            expect($r['status'] === 503 && !str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED') && $r['cookies'] === [] && str_contains(implode(',', $r['headers']['cache-control'] ?? []), 'no-store'),
                "a door that gives $why: a $method is a 503, no form, no shell, no cookie (got {$r['status']}: " . substr($r['body'], 0, 100) . ')');
        }
    }
    expect(str_contains((string) @file_get_contents("$sx/odd-errors.log"), 'AcctMind shared sign-in gave an unusable answer'), 'and the refusal is logged, so a mystery 503 can be told from an outage');
    file_put_contents($answerFile, json_encode(['user' => 'alex', 'csrf' => str_repeat('c', 64)]));
    $r = http($odd, 'GET', '/AcctMind/');
    expect($r['status'] === 200 && str_contains($r['body'], 'ACCTMIND-SHELL-SHARED') && ($r['headers']['cache-control'][0] ?? '') === 'no-store, private', 'with a sound answer the same library opens the shell (control)');
    file_put_contents($answerFile, 'null');
    $r = http($odd, 'GET', '/AcctMind/');
    expect($r['status'] === 401 && str_contains($r['body'], 'name="password"'), 'a door that answers null is the legacy sign-in (control)');
    // The account library behind the door is gone while the instance is on: a fatal, which the host shows as a 500 with no text.
    [$servers[], $bare] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => $libBare, 'ACCTMIND_SHELL' => $shell]), 'bare', $sx, ['-d', 'display_errors=0']);
    $r = http($bare, 'GET', '/AcctMind/', [], null, true);
    expect(in_array($r['status'], [500, 503], true) && !str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED') && $r['cookies'] === [], "the instance is on but its account library is missing: closed, no form, no shell (got {$r['status']})");
    $configure();
    $r = http($bare, 'GET', '/AcctMind/', [], null, true);
    expect($r['status'] === 401 && str_contains($r['body'], 'name="password"'), 'the same library with the instance off never reaches for it: the legacy form (control)');
    $configure($on);
    // No site library at all: the doorway cannot start and says so (this was already so), and never offers a form of its own.
    [$servers[], $nolib] = start_server($sweb, $serverEnv(['ACCTMIND_LIB' => "$sx/nowhere", 'ACCTMIND_SHELL' => $shell]), 'nolib', $sx);
    $r = http($nolib, 'GET', '/AcctMind/');
    expect($r['status'] === 500 && str_contains($r['body'], 'auth library is not at') && !str_contains($r['body'], 'name="password"') && !str_contains($r['body'], 'ACCTMIND-SHELL-SHARED'), "no site library: 500 that says what is missing, no form, no shell (got {$r['status']})");
    // Legacy never reads the people list: off or held, a missing list changes nothing.
    $configure(['people' => null]);
    $legacy('shared sign-in off and the people list missing (legacy is untouched by it)', $plain);
    $configure($on + ['mindsuite_auth_hold' => ['prod' => ['acctmind']], 'people' => null]);
    $legacy('held and the people list missing', $plain);
    $configure($on);
    // Whatever the run logged on purpose, no server that should have been quiet died with a fatal.
    foreach (['plain', 'scratch', 'older', 'odd'] as $name) {
        expect(!preg_match('~Fatal error|Uncaught|Stack trace~', (string) @file_get_contents("$sx/$name-errors.log") . (string) @file_get_contents("$sx/$name-server.log")), "the $name server logged no fatal error");
    }
} finally {
    foreach ($servers as $process) { if (is_resource($process)) { proc_terminate($process); proc_close($process); } }
}

echo "\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);

/** The shared half reads condition first, then what it means (check() above is the other way round). */
function expect(bool $ok, string $what): void { check($what, $ok); }

/** A port nothing is listening on, from the OS's ephemeral range: never one of the suite's reserved lane ports. */
function free_port(): int {
    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if ($socket === false) { fwrite(STDERR, "server suite: no free port ($errstr)\n"); exit(1); }
    $port = (int) explode(':', (string) stream_socket_get_name($socket, false))[1];
    fclose($socket);
    return $port;
}

/**
 * The ini flags a scratch PHP gets: every diagnostic visible, the extensions the library needs even on a PHP that does not load them,
 * and opcache off. A built-in server keeps running while $configure rewrites each library copy's config.php between cases, and a
 * stock opcache (on for the cli-server SAPI, revalidating every 2 s) would keep serving the previous config for a moment: a case
 * could fail on a stale config, or pass on one. Every case must read the file as it is now.
 */
function php_flags(): array {
    $flags = ['-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1', '-d', 'log_errors=1', '-d', 'opcache.enable=0'];
    foreach (['openssl', 'mbstring'] as $extension) {
        $bare = (string) shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, '-r', "echo extension_loaded('$extension') ? 'yes' : 'no';"])));
        if ($bare !== 'yes') { array_push($flags, '-d', "extension=$extension"); }
    }
    return $flags;
}

/** A PHP built-in server on a free port, its errors in <sandbox>/<name>-errors.log. Returns [process, port]. */
function start_server(string $docroot, array $env, string $name, string $sandbox, array $more = []): array {
    $port = free_port();
    $flags = [...php_flags(), '-d', "error_log=$sandbox/$name-errors.log", '-d', "session.save_path=$sandbox/sessions", ...$more];
    $out = ['file', "$sandbox/$name-server.log", 'a'];
    $process = proc_open([PHP_BINARY, ...$flags, '-S', "127.0.0.1:$port", '-t', $docroot], [0 => ['file', '/dev/null', 'r'], 1 => $out, 2 => $out], $pipes, null, $env);
    if (!is_resource($process)) { expect(false, "the $name server started"); }
    for ($i = 0; $i < 200; $i++) {
        $c = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
        if ($c) { fclose($c); return [$process, $port]; }
        usleep(25_000);
    }
    throw new RuntimeException("the $name server did not come up");
}

/**
 * One request, no redirects followed: ['status', 'headers' (lowercase name => values), 'body', 'location', 'cookies' (name => value, every Set-Cookie of the answer)].
 * A request that is not expected to die on a PHP diagnostic must come back without one.
 */
function http(int $port, string $method, string $path, array $headers = [], ?string $body = null, bool $diagnostics = false): array {
    $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $body ?? '', 'ignore_errors' => true,
        'follow_location' => 0, 'max_redirects' => 0, 'timeout' => 60]]);
    $text = @file_get_contents("http://127.0.0.1:$port$path", false, $context);
    $lines = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
    if ($text === false || $lines === []) { expect(false, "$method $path got an answer"); }
    preg_match('#^HTTP/\S+ (\d{3})#', (string) ($lines[0] ?? ''), $m);
    $out = ['status' => (int) ($m[1] ?? 0), 'headers' => [], 'body' => (string) $text, 'location' => null, 'cookies' => []];
    foreach (array_slice($lines, 1) as $line) {
        if (!str_contains($line, ':')) { continue; }
        [$name, $value] = array_map('trim', explode(':', $line, 2));
        $out['headers'][strtolower($name)][] = $value;
        if (strtolower($name) === 'set-cookie') { [$k, $v] = array_pad(explode('=', explode(';', $value)[0], 2), 2, ''); $out['cookies'][$k] = $v; }
    }
    $out['location'] = $out['headers']['location'][0] ?? null;
    if (!$diagnostics && preg_match('~(?:^|\n)(?:PHP )?(?:Warning|Notice|Deprecated|Fatal error|Parse error|Uncaught \w+): ~', (string) $text) === 1) { expect(false, "$method $path ran without a PHP diagnostic: " . substr((string) $text, 0, 300)); }
    return $out;
}

/** A Cookie request header from name => value pairs. */
function cookie_header(array $cookies): array {
    return $cookies === [] ? [] : ['Cookie: ' . implode('; ', array_map(fn($k, $v) => "$k=$v", array_keys($cookies), $cookies))];
}

/** The hash of every file under a directory (names included), so that "nothing was written" can be said exactly. */
function tree(string $dir): array {
    $out = [];
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) {
        if ($file->isFile()) { $out[substr($file->getPathname(), strlen($dir))] = hash_file('sha256', $file->getPathname()); }
    }
    ksort($out);
    return $out;
}

function rrm(string $p): void {
    if (!file_exists($p)) return;
    if (is_dir($p)) { foreach (scandir($p) as $f) { if ($f !== '.' && $f !== '..') rrm("$p/$f"); } @rmdir($p); }
    else @unlink($p);
}
