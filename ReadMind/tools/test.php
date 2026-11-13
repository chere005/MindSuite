<?php
/**
 * ReadMind's tests — no framework, all or nothing, same shape as the site's.
 *
 * The login is CalMind's, so the harness runs a MOCK CalMind API and points
 * the app at it: the test proves this side of the conversation — the right
 * action POSTed, ok+token believed, anything else refused — without a network
 * or a real account. The baseline rule stands: every check here was watched
 * failing first (wrong password, missing token, dead API).
 *
 * The second half drives the SHARED sign-in (seancheren-site docs/MINDSUITE-LOGIN.md, "The app entry points"):
 * the real public/index.php under PHP's built-in server against a disposable copy of the site library, with a
 * disposable store of accounts. It needs the site's lib/ directory: READMIND_TEST_SITE_LIB=<seancheren-site>/lib
 * (a seancheren-site checkout next to this repository, <parent of the repository>/seancheren-site, is found without it).
 * Without a site library the run fails loudly on its first shared check rather than skipping the half that matters.
 */

declare(strict_types=1);
$ROOT = dirname(__DIR__);
$pass = 0; $fail = 0;

/** A port nothing is listening on (asked of the OS, so the suite's reserved lane ports and a leftover run are never in the way). */
function free_port(): int
{
    $s = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) explode(':', (string) stream_socket_get_name($s, false))[1];
    fclose($s);
    return $port;
}
/** Remove a directory tree, dotfiles (the data key) included. */
function rm_rf(string $path): void
{
    if (is_link($path) || is_file($path)) { @unlink($path); return; }
    foreach (@scandir($path) ?: [] as $f) { if ($f !== '.' && $f !== '..') { rm_rf("$path/$f"); } }
    @rmdir($path);
}
$PORT = free_port();
do { $MOCK = free_port(); } while ($MOCK === $PORT);

// Everything this run makes lives under ONE directory, and every server it starts is stopped, on every way out: a failed check, an
// uncaught error, exit() (a killed process cannot run this, but nothing else leaves anything behind).
$TMP = sys_get_temp_dir() . '/readmind-run-' . getmypid();
@mkdir($TMP, 0700, true);
$p1 = $p2 = $p3 = null;
register_shutdown_function(function () use (&$p1, &$p2, &$p3, $TMP) {
    foreach ([$p1, $p2, $p3] as $p) { if (is_resource($p)) { proc_terminate($p); proc_close($p); } }
    if (function_exists('sl_stop_all')) { sl_stop_all(); }
    rm_rf($TMP);
});

function t(string $name, callable $fn): void
{
    global $pass, $fail;
    try { $fn(); $pass++; echo "  \033[32m✓\033[0m $name\n"; }
    catch (Throwable $e) { $fail++; echo "  \033[31m✗\033[0m $name\n      {$e->getMessage()}\n"; }
}
function ok(bool $c, string $why): void { if (!$c) { throw new RuntimeException($why); } }
function has(string $needle, string $hay, string $why): void
{
    ok(str_contains($hay, $needle), "$why (missing: $needle)");
}

// ------------------------------------------------------------------- lint
t('every PHP file parses', function () use ($ROOT) {
    foreach (glob("$ROOT/{public,lib,tools}/*.php", GLOB_BRACE) as $f) {
        exec('php -l ' . escapeshellarg($f) . ' 2>&1', $o, $rc);
        ok($rc === 0, "$f: " . implode(' ', $o));
    }
});

// ------------------------------------------------------------- the store
t('the store round-trips, encrypted at rest', function () use ($ROOT) {
    $dir = $GLOBALS['TMP'] . '/store';
    @mkdir($dir, 0700, true);
    // app_config() is derived, so the store is exercised directly with a
    // hand-built cfg — same functions the page calls.
    require_once "$ROOT/lib/store.php";
    if (!function_exists('app_config')) {
        function app_config(): array { return ['data_dir' => $GLOBALS['__tdir'], 'data_key' => '']; }
    }
    $GLOBALS['__tdir'] = $dir;
    store_write("$dir/books-x.json", [['id' => 'b1', 'title' => 'Dune']]);
    $raw = (string) file_get_contents("$dir/books-x.json");
    ok(str_starts_with($raw, 'ENC1:'), 'file is encrypted at rest');
    $back = store_read("$dir/books-x.json");
    ok(($back[0]['title'] ?? '') === 'Dune', 'and reads back');
    rm_rf($dir);
});

// ------------------------------------------------------ the hit-log owner lane
t('the owner lane comes from people.owner and is absent without it', function () use ($ROOT) {
    // A child process: the store test above already defined a stub app_config().
    $probe = function (string $cfgEnv, array $row) use ($ROOT): string {
        $code = 'require ' . var_export("$ROOT/lib/app.php", true) . '; echo json_encode([app_people(), hit_lane('
              . var_export($row, true) . ')]);';
        return (string) shell_exec('READMIND_CONFIG=' . escapeshellarg($cfgEnv) . ' php -r ' . escapeshellarg($code) . ' 2>&1');
    };
    $cfg = $GLOBALS['TMP'] . '/people-config.php';
    file_put_contents($cfg, "<?php return ['people' => ['owner' => 'alex']];");
    $r = $probe($cfg, ['instance' => 'prod', 'user' => 'alex']);
    ok($r === '[{"owner":"alex"},"owner"]', "configured owner is the owner lane, got $r");
    $r = $probe($cfg, ['instance' => 'prod', 'user' => 'sam']);
    ok($r === '[{"owner":"alex"},"other"]', "anyone else is other, got $r");
    file_put_contents($cfg, "<?php return ['people' => ['owner' => 'bad id!']];");
    $r = $probe($cfg, ['instance' => 'prod', 'user' => 'alex']);
    ok($r === '[[],"other"]', "invalid config: no owner lane, got $r");
    $r = $probe($cfg . '.missing', ['instance' => 'prod', 'user' => 'alex']);
    ok($r === '[[],"other"]', "missing config: no owner lane, got $r");
    @unlink($cfg);
});

// ------------------------------------------- the login conversation, mocked
$mockRoot = "$TMP/mock";
@mkdir($mockRoot, 0700, true);
file_put_contents("$mockRoot/index.php", <<<'PHP'
<?php
// Mock CalMind API: exactly one good account, answers like the real one, except that it matches the name without regard to
// case (the real CalMind matches exactly today, so this is the harder case) and the reply carries CalMind's OWN spelling of
// it ("alex"), which is what the app must file the shelf under. A
// `mode` file beside this one makes it misbehave: `other` names a different account, `none` leaves the name out,
// `bad` names something that is not a username, `any` takes any name and echoes it back. Every login attempt is counted
// in `calls`.
$in = json_decode((string) file_get_contents('php://input'), true) ?: [];
header('Content-Type: application/json');
$mode = trim((string) @file_get_contents(__DIR__ . '/mode')) ?: 'canonical';
if (($in['action'] ?? '') === 'login') { file_put_contents(__DIR__ . '/calls', "login\n", FILE_APPEND | LOCK_EX); }
if (($in['action'] ?? '') === 'login'
    && ($mode === 'any' || strcasecmp((string) ($in['username'] ?? ''), 'alex') === 0)
    && ($in['password'] ?? '') === 'readerpw') {
    $reply = ['ok' => true, 'token' => 'mock-token'];
    if ($mode === 'canonical') { $reply['username'] = 'alex'; }
    if ($mode === 'any')       { $reply['username'] = (string) ($in['username'] ?? ''); }
    if ($mode === 'other')     { $reply['username'] = 'eve'; }
    if ($mode === 'bad')       { $reply['username'] = 'a b!'; }
    echo json_encode($reply);
} else {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'bad credentials']);
}
PHP);


$dataDir = "$TMP/data";
@mkdir($dataDir, 0700, true);
// The app under test: READMIND_TEST reroutes config at the top of app.php.
putenv("READMIND_TEST_API=http://127.0.0.1:$MOCK/index.php");
putenv("READMIND_TEST_DATA=$dataDir");

// The servers' fds go to /dev/null, NOT inherited: a child holding this
// process's stdout keeps every pipe and log file open after the harness
// exits, and the dtp lane hung on exactly that — a release waiting forever
// on two mock servers nobody needed any more.
$sink = [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']];
$p1 = proc_open("exec php -S 127.0.0.1:$MOCK -t $mockRoot", $sink, $x1);
$sessDir = "$TMP/sessions";
@mkdir($sessDir, 0700, true);
$p2 = proc_open("READMIND_TEST_API=http://127.0.0.1:$MOCK/index.php READMIND_TEST_DATA=$dataDir "
              . "exec php -d session.save_path=" . escapeshellarg($sessDir) . " -S 127.0.0.1:$PORT -t " . escapeshellarg("$ROOT/public"), $sink, $x2);
// A third server runs the legacy gate alone, behind a router script, so a request line the file-serving server would refuse
// (a protocol-relative path) can reach it: it answers 'in:<account>' once signed in.
$PORT3 = free_port();
file_put_contents("$TMP/gate-router.php", '<?php require ' . var_export("$ROOT/lib/app.php", true) . "; require_login('ReadMind'); echo 'in:' . current_user();");
$p3 = proc_open("READMIND_TEST_API=http://127.0.0.1:$MOCK/index.php READMIND_TEST_DATA=$dataDir "
              . "exec php -d session.save_path=" . escapeshellarg($sessDir) . " -S 127.0.0.1:$PORT3 " . escapeshellarg("$TMP/gate-router.php"), $sink, $x3);
usleep(400000);

function req(string $method, string $path, array $post = [], array &$jar = [], array $extra = []): array
{
    global $PORT;
    $headers = ['Connection: close', ...$extra];
    if ($jar) {
        $bits = [];
        foreach ($jar as $k => $v) { $bits[] = "$k=$v"; }
        $headers[] = 'Cookie: ' . implode('; ', $bits);
    }
    $body = '';
    if ($method === 'POST') {
        $body = http_build_query($post);
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        $headers[] = 'Content-Length: ' . strlen($body);
    }
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers),
        'content' => $body, 'ignore_errors' => true, 'follow_location' => 0]]);
    $out = (string) @file_get_contents("http://127.0.0.1:$PORT$path", false, $ctx);
    $status = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) { $status = (int) $m[1]; }
        if (preg_match('/^Set-Cookie:\s*([^=]+)=([^;]+)/i', $h, $m)) { $jar[$m[1]] = $m[2]; }
    }
    return ['status' => $status, 'body' => $out];
}

t('signed out, the page is the login form and nothing else', function () {
    $jar = [];
    $r = req('GET', '/', [], $jar);
    has('Sign in with your CalMind account', $r['body'], 'the gate shows');
    ok(!str_contains($r['body'], 'BookShelf-grid'), 'and no shelf leaks past it');
});

t('a wrong password is refused — the mock CalMind said no', function () {
    $jar = [];
    $r = req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'nope'], $jar);
    has('Invalid username or password', $r['body'], 'refusal shown');
});

t('a CalMind account signs in and gets its own empty shelf', function () {
    $jar = [];
    $r = req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    ok($r['status'] === 302, "login should redirect (got {$r['status']})");
    $r2 = req('GET', '/', [], $jar);
    has('ReadMind', $r2['body'], 'the app renders');
    ok(!str_contains($r2['body'], 'Sign in with your CalMind account'), 'past the gate');
    has('alex', $r2['body'], 'and knows who signed in');
});

/** The CSRF token the page embeds in its first form. */
function page_csrf(string $html): string
{
    ok(preg_match('/name="csrf" value="([a-f0-9]{32,})"/', $html, $m) === 1, 'the page carries a CSRF token');
    return $m[1];
}

t('a signed-in reader can post an action: the page redirects back to itself, not a fatal', function () use ($dataDir) {
    $jar = [];
    $r = req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    ok($r['status'] === 302, 'signed in');
    $csrf = page_csrf(req('GET', '/', [], $jar)['body']);
    // A plain form post: add a book, expect POST -> redirect -> GET back to the shelf.
    $r = req('POST', '/', ['csrf' => $csrf, 'action' => 'add_book', 'title' => 'Dune', 'author' => 'F. Herbert'], $jar);
    ok($r['status'] === 302, "add_book redirects (got {$r['status']}: " . substr(strip_tags($r['body']), 0, 120) . ')');
    $shelf = req('GET', '/?shelf=library', [], $jar);
    has('Dune', $shelf['body'], 'the new book is on the shelf');
    ok(is_file("$dataDir/books-alex.json"), 'and filed under the reader');
});

t('the background theme post answers JSON', function () use ($dataDir) {
    $jar = [];
    req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    $csrf = page_csrf(req('GET', '/', [], $jar)['body']);
    $xhr = ['csrf' => $csrf, 'action' => 'set_book_theme', 'theme' => 'sage'];
    $r = req('POST', '/', $xhr, $jar, ['X-Requested-With: XMLHttpRequest']);
    ok($r['status'] === 200 && trim($r['body']) === '{"ok":true,"theme":"sage"}', "theme pick answers JSON (got {$r['status']}: " . substr($r['body'], 0, 120) . ')');
    ok(is_file("$dataDir/prefs-alex.json"), 'and is remembered in the reader\'s prefs file');
});

t('the redirect target is this page\'s own path, collapsed to a single leading slash', function () use ($ROOT) {
    $probe = function (string $uri) use ($ROOT): string {
        $code = '$_SERVER["REQUEST_URI"] = ' . var_export($uri, true) . '; require ' . var_export("$ROOT/lib/app.php", true) . '; echo bm_self_path();';
        return (string) shell_exec('php -r ' . escapeshellarg($code) . ' 2>&1');
    };
    ok($probe('/ReadMind/?book=1') === '/ReadMind/', 'query dropped');
    ok($probe('//evil.example/x?y=1') === '/evil.example/x', 'a protocol-relative request line stays on this host');
    ok($probe('/') === '/', 'root stays root');
    ok($probe('/\\evil.example/x') === '/evil.example/x' && $probe('/\\/evil.example') === '/evil.example', 'a backslash a browser reads as a slash does not make it protocol-relative');
});

/** One request over a raw socket, the target exactly as given: status, Location, and the session cookie it sets. */
function raw(int $port, string $method, string $target, string $body = '', string $cookie = ''): array
{
    $fp = @stream_socket_client("tcp://127.0.0.1:$port", $en, $es, 5);
    ok($fp !== false, "connect to $port: $es");
    $head = "$method $target HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n" . ($cookie === '' ? '' : "Cookie: $cookie\r\n")
          . ($method === 'POST' ? "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: " . strlen($body) . "\r\n" : '');
    fwrite($fp, "$head\r\n$body");
    $resp = (string) stream_get_contents($fp); fclose($fp);
    $out = ['status' => 0, 'location' => null, 'cookie' => '', 'body' => (string) (explode("\r\n\r\n", $resp, 2)[1] ?? '')];
    foreach (explode("\r\n", (string) explode("\r\n\r\n", $resp, 2)[0]) as $i => $line) {
        if ($i === 0 && preg_match('#^HTTP/\S+ (\d{3})#', $line, $m)) { $out['status'] = (int) $m[1]; }
        if (stripos($line, 'Location:') === 0) { $out['location'] = trim(substr($line, 9)); }
        if (preg_match('/^Set-Cookie:\s*(BMSESS=[^;]+)/i', $line, $m)) { $out['cookie'] = $m[1]; }
    }
    return $out;
}

t('legacy: the sign-in and sign-out redirects stay on this host, whatever the request line says', function () use ($PORT3) {
    mock_mode('canonical');
    $r = raw($PORT3, 'GET', '/ReadMind/?logout');
    ok($r['status'] === 302 && $r['location'] === '/ReadMind/', 'control: the sign-out returns to the page (got ' . $r['status'] . ' ' . ($r['location'] ?? '-') . ')');
    foreach (['//evil.example/x', '///evil.example/x', '/\\evil.example/x'] as $target) {
        $r = raw($PORT3, 'GET', "$target?logout");
        ok($r['status'] === 302 && $r['location'] === '/evil.example/x', "sign-out at $target stays on this host (got {$r['status']} " . ($r['location'] ?? '-') . ')');
        $r = raw($PORT3, 'POST', $target, http_build_query(['bm_user' => 'alex', 'bm_pass' => 'readerpw']));
        ok($r['status'] === 302 && $r['location'] === '/evil.example/x' && $r['cookie'] !== '', "sign-in at $target stays on this host (got {$r['status']} " . ($r['location'] ?? '-') . ')');
        $in = raw($PORT3, 'GET', '/ReadMind/', '', $r['cookie']);
        ok($in['body'] === 'in:alex', 'and it is a real sign-in (got ' . substr($in['body'], 0, 60) . ')');
    }
});

t('a post with a wrong CSRF token is still refused', function () {
    $jar = [];
    req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    $r = req('POST', '/', ['csrf' => str_repeat('0', 32), 'action' => 'add_book', 'title' => 'Nope'], $jar);
    ok($r['status'] === 400, "refused with 400 (got {$r['status']})");
});

/** Make the mock CalMind behave in one of its modes (see the mock's header). */
function mock_mode(string $mode): void { global $mockRoot; file_put_contents("$mockRoot/mode", $mode); }
/** Empty the app's data directory of shelves and prefs (the key file stays, or nothing already written would read back). */
function reset_shelves(): void { global $dataDir; foreach (glob("$dataDir/*.json") ?: [] as $f) { unlink($f); } }
/** Write a user's shelf the way the app does, under an exact file spelling, from a process of its own. */
function seed_shelf(string $user, string $title): void
{
    global $ROOT, $dataDir;
    $code = 'require ' . var_export("$ROOT/lib/app.php", true) . '; store_write(user_data_file(app_config()["data_dir"], "books", '
          . var_export($user, true) . '), [["id" => "seed", "title" => ' . var_export($title, true) . ', "rating" => 0]]);';
    shell_exec('READMIND_TEST_DATA=' . escapeshellarg($dataDir) . ' php -r ' . escapeshellarg($code) . ' 2>&1');
}

// ----------------------------------------- the legacy login files the shelf under CalMind's own spelling
t('mixed-case input signs in as CalMind\'s spelling of the account, and the shelf is filed under it', function () use ($dataDir) {
    mock_mode('canonical'); reset_shelves();
    foreach (['ALEX', 'Alex', ' alex '] as $typed) {
        $jar = [];
        $r = req('POST', '/', ['bm_user' => $typed, 'bm_pass' => 'readerpw'], $jar);
        ok($r['status'] === 302, "'$typed' signs in (got {$r['status']})");
        $csrf = page_csrf(req('GET', '/', [], $jar)['body']);
        req('POST', '/', ['csrf' => $csrf, 'action' => 'add_book', 'title' => 'Book of ' . trim($typed)], $jar);
    }
    $files = array_map('basename', glob("$dataDir/books-*.json") ?: []);
    ok($files === ['books-alex.json'], 'one shelf file, in CalMind\'s spelling: ' . implode(',', $files));
    $jar = [];
    req('POST', '/', ['bm_user' => 'ALEX', 'bm_pass' => 'readerpw'], $jar);
    $page = req('GET', '/', [], $jar)['body'];
    foreach (['Book of ALEX', 'Book of Alex', 'Book of alex'] as $title) { has($title, $page, 'every spelling reaches the same shelf'); }
});

t('a CalMind reply that names another account, no account, or a non-username is refused', function () {
    foreach (['other', 'none', 'bad'] as $mode) {
        mock_mode($mode);
        $jar = [];
        $r = req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
        has('Invalid username or password', $r['body'], "mode $mode is refused");
        $after = req('GET', '/', [], $jar);
        has('Sign in with your CalMind account', $after['body'], "and no session was made in mode $mode");
    }
    mock_mode('canonical');
});

t('a reply that echoes a name that is not a CalMind username is refused too', function () {
    mock_mode('any');
    foreach (['a b!', 'a', str_repeat('x', 21), '../etc', 'ré'] as $typed) {
        $jar = [];
        $r = req('POST', '/', ['bm_user' => $typed, 'bm_pass' => 'readerpw'], $jar);
        has('Invalid username or password', $r['body'], "'$typed' is refused");
    }
    mock_mode('canonical');
});

// ------------------------------------------------ a shelf belongs to the exact spelling of its account, never to its case-twin
//
// CalMind matches usernames exactly, so 'Alex' and 'alex' can be two people (anyone can register the lowercase twin of an
// existing account). The shelf lookup therefore never falls back to "the file that differs only in case".
/** Does this filesystem treat `a` and `A` as one name (the default on a Mac)? Two shelves differing in case cannot exist there. */
function fs_case_insensitive(): bool
{
    global $dataDir;
    $f = "$dataDir/.case-probe-a"; touch($f); $same = is_file("$dataDir/.case-probe-A"); unlink($f);
    return $same;
}

t('the shelf file is the exact spelling of the account, whatever else the directory holds', function () use ($ROOT) {
    $pick = function (string $user, string $base = 'books') use ($ROOT): string {
        // The directory is a real one that holds every near miss: no spelling, kind or prefix of this reader may be picked up.
        $dir = $GLOBALS['TMP'] . '/names';
        @mkdir($dir, 0700, true);
        foreach (['books-Alex.json', 'books-ALEX.json', 'booknotes-Alex.json', 'books-alexs.json', 'books-alex2.json', 'books-alex-x.json', 'prefs-Alex.json'] as $f) { touch("$dir/$f"); }
        $code = 'require ' . var_export("$ROOT/lib/app.php", true) . '; echo basename(user_data_file(' . var_export($dir, true) . ', '
              . var_export($base, true) . ', ' . var_export($user, true) . '));';
        return trim((string) shell_exec('php -r ' . escapeshellarg($code) . ' 2>/dev/null'));
    };
    ok($pick('alex') === 'books-alex.json', 'the lowercase account gets its own file, not the Alex one (got ' . $pick('alex') . ')');
    ok($pick('Alex') === 'books-Alex.json' && $pick('ALEX') === 'books-ALEX.json', 'a spelling with capitals is exactly that file');
    ok($pick('alex', 'booknotes') === 'booknotes-alex.json' && $pick('alex', 'prefs') === 'prefs-alex.json', 'and so is every kind of file of that account');
    ok($pick('alex3') === 'books-alex3.json' && $pick('alexs') === 'books-alexs.json', 'another reader keeps their own file');
    ok($pick('alex/../x') === 'books-alex____x.json', 'and the name stays filename-safe (got ' . $pick('alex/../x') . ')');
    rm_rf($GLOBALS['TMP'] . '/names');
});

t('legacy: the lowercase account does not read, write or touch the shelf of its mixed-case twin (needs a case-sensitive filesystem)', function () use ($dataDir) {
    if (fs_case_insensitive()) { echo "      (skipped: this filesystem cannot hold both spellings; the file name rule is covered above)\n"; return; }
    mock_mode('canonical');
    reset_shelves(); seed_shelf('Alex', 'Twin shelf');
    $before = md5_file("$dataDir/books-Alex.json");
    $jar = [];
    req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    $page = req('GET', '/', [], $jar)['body'];
    ok(!str_contains($page, 'Twin shelf'), 'the other account\'s book is not shown to the lowercase account');
    req('POST', '/', ['csrf' => page_csrf($page), 'action' => 'add_book', 'title' => 'Mine'], $jar);
    ok(md5_file("$dataDir/books-Alex.json") === $before, 'the twin\'s file was not written');
    ok(is_file("$dataDir/books-alex.json") && str_contains(req('GET', '/', [], $jar)['body'], 'Mine'), 'the lowercase account has a shelf of its own');
    reset_shelves(); seed_shelf('Alex', 'Shelf zq-one'); seed_shelf('alex', 'Lower shelf'); seed_shelf('ALEX', 'Shelf zq-two');
    $jar = [];
    req('POST', '/', ['bm_user' => 'alex', 'bm_pass' => 'readerpw'], $jar);
    $page = req('GET', '/', [], $jar)['body'];
    has('Lower shelf', $page, 'with three spellings, the exact one is the shelf');
    ok(!str_contains($page, 'Shelf zq-one') && !str_contains($page, 'Shelf zq-two'), 'and the others are not merged in');
    reset_shelves();
});

t('legacy: a sign-in under a spelling with capitals reaches its own shelf, not the lowercase one (needs a case-sensitive filesystem)', function () use ($dataDir) {
    if (fs_case_insensitive()) { echo "      (skipped: this filesystem cannot hold both spellings)\n"; return; }
    mock_mode('any'); reset_shelves(); seed_shelf('Alex', 'Capital shelf'); seed_shelf('alex', 'Lower shelf');
    $jar = [];
    req('POST', '/', ['bm_user' => 'Alex', 'bm_pass' => 'readerpw'], $jar);
    $page = req('GET', '/', [], $jar)['body'];
    ok(str_contains($page, 'Capital shelf') && !str_contains($page, 'Lower shelf'), 'Alex sees the Alex shelf only');
    mock_mode('canonical'); reset_shelves();
});

// ============================================================================================ the shared sign-in
//
//   1. Legacy, exactly as before, in every way ReadMind keeps it: the instance is off, ReadMind is held (several spellings), a
//      malformed hold, another instance only, a site library older than the door.
//   2. Shared, no session: 303 to /account/?next= for a page, 401 JSON for a background call, nothing of ours behind it: no form,
//      no PHP session, no CalMind call, no data written. A password posted to the page is never looked at.
//   3. Shared, a session: the page, posts that carry the session's token (form field, or the X-CSRF-Token header for a background
//      post), the shelf under the account's name, Log out as a post to the account page.
//   4. Shared, no second door: a legacy PHP session, a bearer (scoped or not), a scoped token as a cookie, a GET ?logout.
//   5. Shared but unable to work (store, key, library, configuration, the door's answer): 503 and nothing else, never legacy.
//   6. The sandbox instances: where the redirect and the Log out form point under a test subdomain and a /test/ path.

$SITE_LIB = getenv('READMIND_TEST_SITE_LIB') ?: '';
if ($SITE_LIB === '') {
    foreach ([dirname($ROOT, 2) . '/seancheren-site/lib', dirname($ROOT, 3) . '/seancheren-site/lib'] as $c) {
        if (is_file("$c/mindsuite-site-auth.php")) { $SITE_LIB = $c; break; }
    }
}
$haveSiteLib = $SITE_LIB !== '' && is_file("$SITE_LIB/mindsuite-site-auth.php") && is_file("$SITE_LIB/mindsuite-auth.php")
    && str_contains((string) file_get_contents("$SITE_LIB/mindsuite-site-auth.php"), 'function mss_app_gate_with(');
t('the site library is there to test the shared sign-in against (set READMIND_TEST_SITE_LIB=<seancheren-site>/lib)', function () use ($haveSiteLib, $SITE_LIB) {
    ok($haveSiteLib, "no site library with mss_app_gate_with() at '$SITE_LIB'");
});

if ($haveSiteLib) {
$sb = "$TMP/shared";
$F = ['sb' => $sb, 'key' => 'disposable-readmind-fixture-key', 'procs' => [], 'port' => 0];
foreach (['', '/acct', '/sessions', '/data', '/data-main'] as $d) { @mkdir($sb . $d, 0700, true); }

function sl_php_flags(string $errLog): array
{
    $flags = ['-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1', '-d', 'log_errors=1', '-d', "error_log=$errLog",
              '-d', 'opcache.enable=0', '-d', 'opcache.enable_cli=0', '-d', 'session.save_path=' . $GLOBALS['F']['sb'] . '/sessions'];
    foreach (['openssl', 'mbstring'] as $extension) {
        if (!extension_loaded($extension)) { array_push($flags, '-d', "extension=$extension"); }
    }
    return $flags;
}
/** The real public/index.php under PHP's built-in server, on a free port, with its own site library and data directory. */
function sl_start(string $name, string $lib, string $data, ?string $router = null): int
{
    global $F, $ROOT, $MOCK;
    $port = free_port();
    // SUITE_DATA_DIR is the site library's own fixture switch: it puts the account store under <the configuration's data_dir>/protected
    // instead of /home/protected, and nothing else (the instance switch, the hold and the key still come from the configuration).
    $env = ['READMIND_TEST_API' => "http://127.0.0.1:$MOCK/index.php", 'READMIND_TEST_DATA' => $data, 'READMIND_SITE_LIB' => $lib,
            'SUITE_DATA_DIR' => $F['sb'] . '/acct'] + getenv();
    if ($lib === '') { unset($env['READMIND_SITE_LIB']); }
    $log = $F['sb'] . "/$name.out";
    $serve = $router === null ? ['-t', "$ROOT/public"] : [$router];
    $proc = proc_open([PHP_BINARY, ...sl_php_flags($F['sb'] . "/$name.err"), '-S', "127.0.0.1:$port", ...$serve],
        [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'w'], 2 => ['file', $log, 'a']], $pipes, null, $env);
    ok(is_resource($proc), "the $name server started");
    $F['procs'][] = $proc;
    for ($i = 0; $i < 200; ++$i) {
        $c = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
        if ($c) { fclose($c); return $port; }
        usleep(25000);
    }
    throw new RuntimeException("the $name server did not come up");
}
function sl_stop_all(): void { global $F; foreach ($F['procs'] as $p) { if (is_resource($p)) { proc_terminate($p); proc_close($p); } } $F['procs'] = []; }
/** One request, no redirects: status, lowercase header lists, every Set-Cookie as name => value, body, location. */
function sh(int $port, string $method, string $path, array $headers = [], ?string $body = null): array
{
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", ['Connection: close', ...$headers]),
        'content' => $body ?? '', 'ignore_errors' => true, 'follow_location' => 0, 'max_redirects' => 0, 'timeout' => 30]]);
    $text = @file_get_contents("http://127.0.0.1:$port$path", false, $ctx);
    $lines = function_exists('http_get_last_response_headers') ? (http_get_last_response_headers() ?? []) : ($http_response_header ?? []);
    ok($text !== false && $lines !== [], "$method $path got an answer");
    preg_match('#^HTTP/\S+ (\d{3})#', (string) $lines[0], $m);
    $out = ['status' => (int) ($m[1] ?? 0), 'headers' => [], 'cookies' => [], 'body' => $text, 'location' => null];
    foreach (array_slice($lines, 1) as $line) {
        if (!str_contains($line, ':')) { continue; }
        [$n, $v] = array_map('trim', explode(':', $line, 2));
        $out['headers'][strtolower($n)][] = $v;
        if (strtolower($n) === 'set-cookie' && preg_match('/^([^=]+)=([^;]*)/', $v, $c)) { $out['cookies'][$c[1]] = $c[2]; }
    }
    $out['location'] = $out['headers']['location'][0] ?? null;
    ok(preg_match('~(?:^|\n)(?:PHP )?(?:Warning|Notice|Deprecated|Fatal error|Parse error|Uncaught \w+): ~', $text) !== 1,
       "$method $path ran without a PHP diagnostic: " . substr($text, 0, 300));
    return $out;
}
define('FORM', 'Content-Type: application/x-www-form-urlencoded');
function mock_calls(): int { global $mockRoot; return substr_count((string) @file_get_contents("$mockRoot/calls"), "\n"); }

// ---- the disposable site library: a copy of the real files with a configuration of its own
function sl_copy_lib(string $source, string $to, string $variant = ''): void
{
    mkdir($to);
    foreach (scandir($source) ?: [] as $name) {
        if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file("$source/$name")) { continue; }
        copy("$source/$name", "$to/$name");
    }
    $file = "$to/mindsuite-site-auth.php";
    $text = (string) file_get_contents($file);
    $door = 'function mss_app_gate_with(array $site, string $app, array $opts): ?array';
    ok(substr_count($text, $door) === 1, 'the door has the signature this app calls');
    if ($variant === 'older') {          // a library from before the door: the same files, the one entry point gone
        file_put_contents($file, str_replace($door, 'function mss_app_gate_with_gone(array $site, string $app, array $opts): ?array', $text));
    } elseif ($variant === 'odd') {      // a door that answers whatever odd-answer.json says
        file_put_contents($file, str_replace($door, 'function mss_app_gate_with_real(array $site, string $app, array $opts): ?array', $text)
            . "\nfunction mss_app_gate_with(array \$site, string \$app, array \$opts): ?array { return json_decode((string) file_get_contents(__DIR__ . '/odd-answer.json'), true); }\n");
    }
}
/** Write the library's configuration (read on every request): the standard one with $extra laid over it and $drop removed. */
function sl_config(string $lib, array $extra = [], array $drop = []): void
{
    global $F;
    $c = array_replace(['base' => '', 'timezone' => 'America/Chicago', 'mindsuite_auth_instances' => ['prod'],
        'mindsuite_auth_keys' => ['prod' => $F['key'], 'test' => $F['key'], 'dev' => $F['key']], 'data_dir' => $F['sb'] . '/acct'], $extra);
    foreach ($drop as $k) { unset($c[$k]); }
    file_put_contents("$lib/config.php", '<?php return ' . var_export($c, true) . ';');
}
$lib = "$sb/lib"; $oldLib = "$sb/oldlib"; $oddLib = "$sb/oddlib"; $noDoorLib = "$sb/nodoorlib"; $noConfLib = "$sb/noconflib";
sl_copy_lib($SITE_LIB, $lib); sl_copy_lib($SITE_LIB, $oldLib, 'older'); sl_copy_lib($SITE_LIB, $oddLib, 'odd');
sl_copy_lib($SITE_LIB, $noDoorLib); unlink("$noDoorLib/mindsuite-site-auth.php");
sl_copy_lib($SITE_LIB, $noConfLib);
file_put_contents("$oddLib/odd-answer.json", 'null');

// ---- the shared store: two readers in each of production's and the test instance's, made by the library itself in a process of its own
file_put_contents("$sb/seed.php", <<<'PHP'
<?php
[, $lib, $root, $key] = $argv;
require $lib . '/mindsuite-auth.php';
$out = [];
foreach (['prod', 'test'] as $env) {
    $cfg = msa_config($env, $key, $root);
    $cfg['invite_code'] = '5678';
    @mkdir($cfg['data_dir'], 0700, true);
    msa_store_write($cfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]);
    foreach (['alex', 'sam'] as $name) {
        if (!msa_signup($cfg, $name, $name . '@example.invalid', $name . '-password-1', '5678')) { fwrite(STDERR, "signup $name failed\n"); exit(1); }
        $out[$env][$name] = msa_login($cfg, $name, $name . '-password-1', 'Firefox', '203.0.113.1');
    }
    // What a phone holds: a token scoped to CalMind. It must never open this app, as a bearer or as a cookie.
    $out[$env]['alex-calmind'] = msa_login($cfg, 'alex', 'alex-password-1', 'phone', '203.0.113.1', 'calmind');
}
echo json_encode($out);
PHP);
$seeded = (string) shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, ...sl_php_flags("$sb/seed.err"), "$sb/seed.php", $lib, "$sb/acct/protected", $F['key']])) . ' 2>&1');
$tok = json_decode($seeded, true);
$haveTokens = is_array($tok) && isset($tok['prod']['alex']['token'], $tok['prod']['sam']['token'], $tok['prod']['alex-calmind']['token'], $tok['test']['alex']['token']);
t('the shared store is seeded by the library (two readers, a phone token, a test instance)', function () use ($haveTokens, $seeded) { ok($haveTokens, 'seed said: ' . substr($seeded, 0, 300)); });

if ($haveTokens) {
$web = fn(string $who) => 'MSSESS=' . $tok['prod'][$who]['token'];

// A legacy PHP session of the reader's, written the way PHP stores one: the second door a shared instance must keep shut.
$legacyId = bin2hex(random_bytes(16));
file_put_contents("$sb/sessions/sess_$legacyId", 'user|s:4:"alex";csrf|s:32:"' . bin2hex(random_bytes(16)) . '";rm_greeted|b:1;');

try {
    $main = sl_start('main', $lib, "$sb/data-main"); $F['port'] = $main;
    $dataMain = "$sb/data-main";
    $legacyData = "$sb/data";
    $old = sl_start('older', $oldLib, "$sb/data"); $odd = sl_start('odd', $oddLib, "$sb/data");
    $nolib = sl_start('nolib', "$sb/no-such-library", "$sb/data"); $nodoor = sl_start('nodoor', $noDoorLib, "$sb/data"); $noconf = sl_start('noconf', $noConfLib, "$sb/data");
    sl_config($lib); sl_config($oldLib); sl_config($oddLib); sl_config($noDoorLib);       // $noConfLib gets none

    // The legacy sign-in, end to end, on one server.
    $legacy = function (string $why, int $port) {
        $r = sh($port, 'GET', '/');
        ok($r['status'] === 200 && $r['location'] === null && str_contains($r['body'], 'Sign in with your CalMind account'), "$why: the page is the legacy form (got {$r['status']})");
        ok(isset($r['cookies']['BMSESS']), "$why: and starts its own PHP session");
        $in = sh($port, 'POST', '/', [FORM, 'Cookie: BMSESS=' . $r['cookies']['BMSESS']], http_build_query(['bm_user' => 'alex', 'bm_pass' => 'readerpw']));
        ok($in['status'] === 302, "$why: a CalMind sign-in is accepted (got {$in['status']})");
        $page = sh($port, 'GET', '/', ['Cookie: BMSESS=' . ($in['cookies']['BMSESS'] ?? $r['cookies']['BMSESS'])]);
        ok($page['status'] === 200 && str_contains($page['body'], '?logout') && !str_contains($page['body'], 'name="action" value="logout"'), "$why: the shelf opens with the legacy Log out link");
        $wrong = sh($port, 'POST', '/', [FORM], http_build_query(['bm_user' => 'alex', 'bm_pass' => 'nope']));
        ok(str_contains($wrong['body'], 'Invalid username or password'), "$why: and a wrong password is refused by the CalMind answer");
    };
    t('legacy: the instance is off (no instance is switched on)', function () use ($legacy, $lib, $main) { sl_config($lib, ['mindsuite_auth_instances' => []]); $legacy('off', $main); });
    t('legacy: ReadMind is held (the list, mixed case, among other apps)', function () use ($legacy, $lib, $main) {
        foreach ([['readmind'], ['ReadMind'], ['planmind', 'readmind', 'calmind']] as $held) {
            sl_config($lib, ['mindsuite_auth_hold' => ['prod' => $held]]);
            $legacy('held ' . implode(',', $held), $main);
        }
    });
    t('legacy: a malformed hold holds every app', function () use ($legacy, $lib, $main) {
        foreach (['readmind', ['readmind'], ['prod' => 'readmind'], ['prod' => [1]]] as $bad) {
            sl_config($lib, ['mindsuite_auth_hold' => $bad]);
            $legacy('malformed hold ' . json_encode($bad), $main);
        }
    });
    t('legacy: only another instance is switched on', function () use ($legacy, $lib, $main) { sl_config($lib, ['mindsuite_auth_instances' => ['test', 'dev']]); $legacy('another instance', $main); });
    t('legacy: a site library older than the door', function () use ($legacy, $old) { $legacy('older library', $old); });

    // ---- 2. shared, no session
    t('shared, no session: a page redirects to the account page, with nothing of ours behind it', function () use ($lib, $main, $dataMain) {
        sl_config($lib);
        $before = mock_calls();
        foreach (['/', '/?book=abc&shelf=want', '/index.php', '/?action=search&q=x', '/?logout'] as $path) {
            $r = sh($main, 'GET', $path);
            ok($r['status'] === 303 && $r['location'] === '/account/?next=%2FReadMind%2F', "GET $path: 303 to the account page (got {$r['status']} " . ($r['location'] ?? '-') . ')');
            ok($r['cookies'] === [] && !str_contains($r['body'], 'bm_pass') && !str_contains($r['body'], 'Sign in with your CalMind') && !str_contains($r['body'], '"results"'),
               "GET $path: no cookie, no form, no search result");
            ok(str_contains(implode(',', $r['headers']['cache-control'] ?? []), 'no-store'), "GET $path: kept out of caches");
        }
        $r = sh($main, 'GET', '/ReadMind/deep/page?x=1', ['Host: attacker.example', 'X-Forwarded-Host: attacker.example']);
        ok($r['location'] === '/account/?next=%2FReadMind%2Fdeep%2F', 'the return target is this site\'s own path, whatever Host says (got ' . ($r['location'] ?? '-') . ')');
        $r = sh($main, 'GET', '/%2e%2e/x/');
        ok(!str_starts_with((string) $r['location'], '//') && ($r['status'] === 303 || $r['status'] === 404), 'an odd path never makes a protocol-relative target');
        ok(mock_calls() === $before, 'CalMind was not asked anything');
        ok(glob("$dataMain/*.json") === [] && !is_file("$dataMain/.datakey"), 'and no data was read or written');
    });
    t('shared, no session: a background call gets 401 JSON, never a redirect', function () use ($main) {
        $r = sh($main, 'POST', '/', [FORM, 'X-Requested-With: XMLHttpRequest'], http_build_query(['action' => 'set_book_theme', 'theme' => 'sage', 'csrf' => 'x']));
        $j = json_decode($r['body'], true);
        ok($r['status'] === 401 && is_array($j) && ($j['ok'] ?? null) === false && ($j['signin'] ?? '') === '/account/?next=%2FReadMind%2F' && $r['location'] === null, "got {$r['status']}: " . substr($r['body'], 0, 150));
        $r = sh($main, 'GET', '/?action=search&q=dune', ['Accept: application/json']);
        ok($r['status'] === 401 && !str_contains($r['body'], '"results"'), 'the search is behind the gate too');
    });
    t('shared: a password posted to the page is never looked at', function () use ($main, $lib) {
        $before = mock_calls();
        $r = sh($main, 'POST', '/', [FORM], http_build_query(['bm_user' => 'alex', 'bm_pass' => 'readerpw']));
        ok($r['status'] === 303 && $r['cookies'] === [] && mock_calls() === $before, "no sign-in here, CalMind not asked (got {$r['status']}, calls " . (mock_calls() - $before) . ')');
        $r = sh($main, 'POST', '/', [FORM, 'Cookie: ' . 'MSSESS=' . str_repeat('a', 64)], http_build_query(['bm_user' => 'alex', 'bm_pass' => 'readerpw']));
        ok($r['status'] === 303 && mock_calls() === $before, 'nor with a made-up session cookie');
    });

    // ---- 3. shared, a session
    t('shared, a session: the shelf opens for the account, with the shared Log out and no PHP session of ours', function () use ($main, $web) {
        $r = sh($main, 'GET', '/', ["Cookie: {$web('alex')}"]);
        ok($r['status'] === 200 && str_contains($r['body'], '<span>alex</span>'), "the page opens for alex (got {$r['status']})");
        ok(!isset($r['cookies']['BMSESS']) && !preg_grep('/^BMSESS|^PHPSESSID/', array_keys($r['cookies'])), 'no PHP session cookie of ours');
        ok(str_contains(implode(',', $r['headers']['cache-control'] ?? []), 'no-store') && !str_contains($r['body'], 'Sign in with your CalMind'), 'kept out of caches, no form');
        ok(!str_contains($r['body'], '?logout') && preg_match('#<form method="post" action="/account/">\s*<input type="hidden" name="action" value="logout">\s*<input type="hidden" name="next" value="/account/\?next=%2FReadMind%2F">\s*<input type="hidden" name="csrf" value="[a-f0-9]{32,}">#', $r['body']) === 1,
           'Log out is a post to the account page, returning to the sign-in that comes back here');
        ok(str_contains($r['body'], 'your MindSuite account') && !str_contains($r['body'], 'Password changes live in CalMind'), 'and the settings window says whose account it is');
        $xhrs = substr_count($r['body'], "'X-Requested-With': 'XMLHttpRequest'");
        ok($xhrs >= 4 && substr_count($r['body'], "'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': ") === $xhrs, "every background post the page makes ($xhrs) sends the token header");
        ok(str_contains($r['body'], 'id="loveBanner"') && ($r['cookies']['RMGREET'] ?? '') !== '', 'the one-time greeting shows and is remembered by the browser');
        $again = sh($main, 'GET', '/', ["Cookie: {$web('alex')}; RMGREET={$r['cookies']['RMGREET']}"]);
        ok($again['status'] === 200 && !str_contains($again['body'], 'id="loveBanner"'), 'and does not show again');
        $other = sh($main, 'GET', '/', ["Cookie: {$web('sam')}; RMGREET={$r['cookies']['RMGREET']}"]);
        ok(str_contains($other['body'], 'id="loveBanner"'), 'but is each reader\'s own');
    });
    t('shared, a session: posts need the session\'s token, from the form field or (background posts) the header', function () use ($main, $web, $dataMain) {
        $cookie = "Cookie: {$web('alex')}"; $origin = 'Origin: https://seancheren.com';
        $csrf = page_csrf(sh($main, 'GET', '/', [$cookie])['body']);
        $form = fn(array $f) => http_build_query($f);
        // A form post: POST -> redirect -> GET, filed under the account.
        $r = sh($main, 'POST', '/', [FORM, $cookie, $origin], $form(['csrf' => $csrf, 'action' => 'add_book', 'title' => 'Dune']));
        ok($r['status'] === 302 && $r['location'] === '/?shelf=library', "add_book redirects back to the shelf (got {$r['status']} " . ($r['location'] ?? '-') . ': ' . substr(strip_tags($r['body']), 0, 100) . ')');
        ok(is_file("$dataMain/books-alex.json") && str_contains(sh($main, 'GET', '/?shelf=library', [$cookie])['body'], 'Dune'), 'the book is on alex\'s shelf');
        ok(!str_contains(sh($main, 'GET', '/', ["Cookie: {$web('sam')}"])['body'], 'Dune') && !is_file("$dataMain/books-sam.json"), 'and not on anyone else\'s');
        // A background post: the page\'s script sends the header.
        $xhr = [FORM, $cookie, $origin, 'X-Requested-With: XMLHttpRequest'];
        $r = sh($main, 'POST', '/', [...$xhr, "X-CSRF-Token: $csrf"], $form(['csrf' => $csrf, 'action' => 'set_book_theme', 'theme' => 'sage']));
        ok($r['status'] === 200 && trim($r['body']) === '{"ok":true,"theme":"sage"}', "theme pick with the header answers JSON (got {$r['status']}: " . substr($r['body'], 0, 100) . ')');
        ok(is_file("$dataMain/prefs-alex.json"), 'and is remembered');
        // A multipart post (the note autosave): the form field is enough.
        $boundary = 'b' . bin2hex(random_bytes(6));
        $multi = "--$boundary\r\nContent-Disposition: form-data; name=\"csrf\"\r\n\r\n$csrf\r\n--$boundary\r\nContent-Disposition: form-data; name=\"action\"\r\n\r\nset_book_theme\r\n--$boundary\r\nContent-Disposition: form-data; name=\"theme\"\r\n\r\nplum\r\n--$boundary--\r\n";
        $r = sh($main, 'POST', '/', ["Content-Type: multipart/form-data; boundary=$boundary", $cookie, $origin], $multi);
        ok($r['status'] === 302, "a multipart post with the token field goes through (got {$r['status']}: " . substr($r['body'], 0, 100) . ')');
        // What must be refused, each on its own.
        $bad = [
            'a form post with no token'                  => [[FORM, $cookie, $origin], $form(['action' => 'add_book', 'title' => 'X1'])],
            'a form post with another token'             => [[FORM, $cookie, $origin], $form(['csrf' => str_repeat('0', 64), 'action' => 'add_book', 'title' => 'X2'])],
            'a background post with the token only in the body' => [[...$xhr], $form(['csrf' => $csrf, 'action' => 'set_book_theme', 'theme' => 'dusk'])],
            'a background post with another token'       => [[...$xhr, 'X-CSRF-Token: ' . str_repeat('1', 64)], $form(['action' => 'set_book_theme', 'theme' => 'dusk'])],
            'a post from another origin'                 => [[FORM, $cookie, 'Origin: https://attacker.example'], $form(['csrf' => $csrf, 'action' => 'add_book', 'title' => 'X3'])],
            'a cross-site post'                          => [[FORM, $cookie, $origin, 'Sec-Fetch-Site: cross-site'], $form(['csrf' => $csrf, 'action' => 'add_book', 'title' => 'X4'])],
        ];
        foreach ($bad as $why => [$headers, $body]) {
            $r = sh($main, 'POST', '/', $headers, $body);
            ok($r['status'] === 403, "$why is refused with 403 (got {$r['status']})");
        }
        $page = sh($main, 'GET', '/?shelf=library', [$cookie])['body'];
        ok(!preg_match('/X[1-4]/', strip_tags($page)) && trim((string) sh($main, 'GET', '/', [$cookie])['status']) === '200', 'and none of them changed anything');
    });
    t('shared, a session: the search is behind the gate and answers once signed in', function () use ($main, $web) {
        $r = sh($main, 'GET', '/?action=search&q=', ["Cookie: {$web('alex')}"]);
        ok($r['status'] === 200 && trim($r['body']) === '{"ok":true,"results":[]}', "got {$r['status']}: " . substr($r['body'], 0, 100));
    });
    t('shared: a shelf filed under another case belongs to another account and is not shown (needs a case-sensitive filesystem)', function () use ($main, $web, $dataMain, $ROOT) {
        if (fs_case_insensitive()) { echo "      (skipped: this filesystem cannot hold both spellings; the file name rule is covered above)\n"; return; }
        foreach (glob("$dataMain/*.json") ?: [] as $f) { unlink($f); }
        $code = 'require ' . var_export("$ROOT/lib/app.php", true) . '; store_write(user_data_file(app_config()["data_dir"], "books", "Alex"), [["id" => "s", "title" => "Old Dune", "rating" => 0]]);';
        shell_exec('READMIND_TEST_DATA=' . escapeshellarg($dataMain) . ' php -r ' . escapeshellarg($code) . ' 2>&1');
        $before = md5_file("$dataMain/books-Alex.json");
        $cookie = "Cookie: {$web('alex')}";
        $page = sh($main, 'GET', '/', [$cookie])['body'];
        ok(!str_contains($page, 'Old Dune'), 'alex (lowercase) does not see the mixed-case twin\'s shelf');
        sh($main, 'POST', '/', [FORM, $cookie, 'Origin: https://seancheren.com'], http_build_query(['csrf' => page_csrf($page), 'action' => 'add_book', 'title' => 'Fresh Emma']));
        ok(md5_file("$dataMain/books-Alex.json") === $before, 'and the twin\'s file is untouched by alex\'s writes');
        ok(is_file("$dataMain/books-alex.json") && str_contains(sh($main, 'GET', '/', [$cookie])['body'], 'Fresh Emma'), 'alex has a shelf of its own');
        ok(!str_contains(sh($main, 'GET', '/', ["Cookie: {$web('sam')}"])['body'], 'Old Dune'), 'and sam sees neither');
        foreach (glob("$dataMain/*.json") ?: [] as $f) { unlink($f); }
    });
    t('shared: Log out is a post, so a GET ?logout ends nothing', function () use ($main, $web) {
        $r = sh($main, 'GET', '/?logout', ["Cookie: {$web('alex')}"]);
        ok($r['status'] === 200 && str_contains($r['body'], '<span>alex</span>'), 'still signed in after ?logout');
    });
    t('shared: a hold on other apps does not hold ReadMind', function () use ($main, $lib) {
        sl_config($lib, ['mindsuite_auth_hold' => ['prod' => ['calmind', 'planmind'], 'test' => ['readmind']]]);
        ok(sh($main, 'GET', '/')['status'] === 303, 'still the shared sign-in');
        sl_config($lib);
    });

    // ---- 4. shared, no second door
    t('shared: nothing but the shared cookie opens the shelf (a legacy session, bearers, a scoped token, an odd header)', function () use ($main, $tok, $web, $legacyId, $dataMain) {
        $before = mock_calls();
        $attempts = [
            'a legacy PHP session cookie'                  => ["Cookie: BMSESS=$legacyId"],
            'a PHP session cookie on the default name'     => ["Cookie: PHPSESSID=$legacyId"],
            'a CalMind-scoped token as a bearer'           => ['Authorization: Bearer ' . $tok['prod']['alex-calmind']['token']],
            'a full-account token as a bearer'             => ['Authorization: Bearer ' . $tok['prod']['alex']['token']],
            'a scoped token as the cookie'                 => ['Cookie: MSSESS=' . $tok['prod']['alex-calmind']['token']],
            'the shared cookie with an Authorization header' => ["Cookie: {$web('alex')}", 'Authorization: Bearer ' . str_repeat('a', 64)],
            'the test instance\'s cookie'                  => ['Cookie: MSSESS_TEST=' . $tok['test']['alex']['token']],
            'the test instance\'s token as the prod cookie' => ['Cookie: MSSESS=' . $tok['test']['alex']['token']],
        ];
        foreach ($attempts as $why => $headers) {
            $r = sh($main, 'GET', '/', $headers);
            ok($r['status'] === 303 && $r['location'] === '/account/?next=%2FReadMind%2F' && !str_contains($r['body'], 'ReadMind</title>'), "$why opens nothing (got {$r['status']})");
            $p = sh($main, 'POST', '/', [FORM, ...$headers], http_build_query(['csrf' => 'x', 'action' => 'add_book', 'title' => 'Sneaked']));
            ok($p['status'] === 303 || $p['status'] === 401 || $p['status'] === 403, "$why cannot post either (got {$p['status']})");
        }
        ok(mock_calls() === $before, 'CalMind was not asked anything');
        ok(!str_contains((string) json_encode(array_map('file_get_contents', glob("$dataMain/books-*.json") ?: [])), 'Sneaked'), 'and nothing was written');
    });

    // ---- 5. shared, but unable to work
    $closed = function (string $why, int $port, array $headers = [], bool $post = false) {
        $r = $post ? sh($port, 'POST', '/', [FORM, ...$headers], http_build_query(['bm_user' => 'alex', 'bm_pass' => 'readerpw', 'csrf' => 'x', 'action' => 'add_book', 'title' => 'T']))
                   : sh($port, 'GET', '/', $headers);
        ok($r['status'] === 503 && str_contains($r['body'], 'temporarily unavailable'), "$why: 503, unavailable (got {$r['status']}: " . substr($r['body'], 0, 80) . ')');
        ok(!str_contains($r['body'], 'bm_pass') && !str_contains($r['body'], 'Sign in with your CalMind') && !str_contains($r['body'], 'ReadMind</title>') && $r['cookies'] === [] && $r['location'] === null,
           "$why: no form, no shelf, no cookie, no redirect");
    };
    t('shared but unable to work: closed with a logged 503, never the legacy sign-in', function () use ($closed, $main, $lib, $odd, $oddLib, $nolib, $nodoor, $noconf, $web, $sb, $tok) {
        $before = mock_calls();
        // The store is unreadable (damaged), so a presented session cannot be judged.
        $store = "$sb/acct/protected/mindsuite-auth/auth.json"; $keep = file_get_contents($store);
        file_put_contents($store, 'not a store');
        sl_config($lib);
        $closed('damaged store', $main, ["Cookie: {$web('alex')}"]);
        $closed('damaged store, a post', $main, ["Cookie: {$web('alex')}"], true);
        file_put_contents($store, $keep);
        ok(sh($main, 'GET', '/', ["Cookie: {$web('alex')}"])['status'] === 200, 'the restored store opens again (control)');
        // No key for the instance.
        sl_config($lib, [], ['mindsuite_auth_keys']);
        $closed('no key', $main); $closed('no key, with a session', $main, ["Cookie: {$web('alex')}"]);
        sl_config($lib, ['mindsuite_auth_keys' => ['prod' => '']]);
        $closed('an empty key', $main);
        // A configuration for another instance, or one that is not a configuration.
        sl_config($lib, ['base' => '/test']);
        $closed('a configuration for the test instance', $main);
        file_put_contents("$lib/config.php", '<?php return "nope";');
        $closed('a configuration that is not an array', $main);
        file_put_contents("$lib/config.php", '<?php throw new RuntimeException("broken config");');
        $closed('a configuration that throws', $main);
        file_put_contents("$lib/config.php", '<?php this is not php');
        $closed('a configuration that does not parse', $main);
        sl_config($lib);
        // The library is not usable.
        $closed('no site library at the named directory', $nolib);
        $closed('no gate file in the library', $nodoor);
        $closed('no configuration in the library', $noconf);
        // The door answers with something this app cannot use.
        sl_config($oddLib);
        foreach (['{"user":"","csrf":"x"}', '{"user":"alex"}', '{"user":"alex","csrf":""}', '{"user":"Bad Name!","csrf":"x"}', '{"user":"R","csrf":"x"}', '{"csrf":"x"}', '[]', '{"user":["alex"],"csrf":"x"}', '{"user":"alex","csrf":7}'] as $answer) {
            file_put_contents("$oddLib/odd-answer.json", $answer);
            $closed("an unusable door answer $answer", $odd);
        }
        file_put_contents("$oddLib/odd-answer.json", '{"user":"alex","csrf":"' . str_repeat('c', 64) . '"}');
        $r = sh($odd, 'GET', '/');
        ok($r['status'] === 200 && str_contains($r['body'], '<span>alex</span>'), 'a usable answer opens the shelf (control)');
        file_put_contents("$oddLib/odd-answer.json", 'null');
        ok(str_contains(sh($odd, 'GET', '/')['body'], 'Sign in with your CalMind account'), 'and a door that says null is the legacy sign-in (control)');
        ok(mock_calls() === $before, 'CalMind was never asked while closed');
        $errors = (string) @file_get_contents("$sb/main.err");
        ok(str_contains($errors, 'ReadMind sign-in unavailable: RuntimeException: the site configuration is for another instance')
            && str_contains($errors, 'broken config') && str_contains($errors, 'not an array'), 'and each refusal is logged with its reason');
    });

    // ---- 6. the sandbox instances. The test mirror finds its lib the host's way, so the instance is driven through the gate alone: a router
    //         script that runs require_login() and says who is signed in, asked with real Host headers and paths.
    t('the sandbox instances: where the redirect and the Log out form point', function () use ($ROOT, $lib, $tok, $sb) {
        file_put_contents("$sb/router.php", '<?php require ' . var_export("$ROOT/lib/app.php", true) . "; require_login('ReadMind'); header('Content-Type: application/json'); echo json_encode(['user' => current_user(), 'signout' => bm_signout()]);");
        $srv = sl_start('probe', $lib, "$sb/data", "$sb/router.php");
        $ask = fn(string $host, string $uri, array $cookies = []) => sh($srv, 'GET', $uri, ["Host: $host", ...($cookies ? ['Cookie: ' . implode('; ', $cookies)] : [])]);
        $test = ['mindsuite_auth_instances' => ['test'], 'base' => '/test'];
        sl_config($lib, $test);
        $r = $ask('test.seancheren.com', '/ReadMind/');
        ok($r['status'] === 303 && $r['location'] === '/account/?next=%2FReadMind%2F', 'test subdomain, no session: ' . $r['status'] . ' ' . ($r['location'] ?? '-'));
        $r = $ask('seancheren.com', '/test/ReadMind/?book=1');
        ok($r['status'] === 303 && $r['location'] === '/test/account/?next=%2Ftest%2FReadMind%2F', 'test path, no session: ' . $r['status'] . ' ' . ($r['location'] ?? '-'));
        $r = $ask('test.seancheren.com', '/ReadMind/', ['MSSESS_TEST=' . $tok['test']['alex']['token']]);
        $j = json_decode($r['body'], true);
        ok(($j['user'] ?? '') === 'alex' && ($j['signout']['action'] ?? '') === '/account/' && ($j['signout']['next'] ?? '') === '/account/?next=%2FReadMind%2F',
           'test subdomain, a session: ' . substr($r['body'], 0, 200));
        $r = $ask('seancheren.com', '/test/ReadMind/', ['MSSESS_TEST=' . $tok['test']['alex']['token']]);
        $j = json_decode($r['body'], true);
        ok(($j['user'] ?? '') === 'alex' && ($j['signout']['action'] ?? '') === '/test/account/' && ($j['signout']['next'] ?? '') === '/test/account/?next=%2Ftest%2FReadMind%2F',
           'test path, a session: ' . substr($r['body'], 0, 200));
        // Production's cookie opens nothing on the test instance (another store, another key, another cookie name).
        $r = $ask('test.seancheren.com', '/ReadMind/', ['MSSESS=' . $tok['prod']['alex']['token'], 'MSSESS_TEST=' . $tok['prod']['alex']['token']]);
        ok($r['status'] === 303, 'production\'s token opens nothing on test (got ' . $r['status'] . ')');
        sl_config($lib, ['mindsuite_auth_instances' => ['dev'], 'base' => '/dev']);
        $r = $ask('dev.seancheren.com', '/ReadMind/');
        ok($r['status'] === 303 && $r['location'] === '/account/?next=%2FReadMind%2F', 'dev subdomain, no session: ' . $r['status'] . ' ' . ($r['location'] ?? '-'));
        // A production configuration answering for the test host is not believed.
        sl_config($lib);
        $r = $ask('test.seancheren.com', '/ReadMind/');
        ok($r['status'] === 503 && str_contains($r['body'], 'temporarily unavailable'), 'a prod configuration under the test host is refused (got ' . $r['status'] . ')');
        sl_config($lib);
    });
} finally {
    sl_stop_all();
}
}   // $haveTokens
}   // $haveSiteLib

// The shutdown function above stops every server and removes the run directory, on this way out and on every other.

echo "\n────────────────────────────────\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
