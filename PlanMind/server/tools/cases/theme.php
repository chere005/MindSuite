<?php
declare(strict_types=1);
// The setTheme action: the person's color theme, an account preference of the site library (theme_set / theme_get, the
// prefs file CalMind and the suite read), not planner data. Validation, authorization of the caller, fail-closed writes,
// then the same action against the real site library in a disposable copy, shaped like the test instance's sandbox.
require_once __DIR__ . '/../../lib/staging.php';
use PlanMind\RequestError;
use function PlanMind\{allowed, both_color_get, both_color_set, op_set_both_color, op_set_theme, staging_hashes};

$themes = ['midnight', 'sage', 'forest', 'olive'];
$ask = fn(mixed $theme) => ['action' => 'setTheme', 'theme' => $theme];

// ---- 1. Against a library of our own: what the action decides ----
$stored = 'midnight';
$set = function (string $name) use (&$stored) { $stored = $name; return true; };
$get = function () use (&$stored) { return $stored; };
foreach ($themes as $name) {
    check(op_set_theme($ask($name), 'alex', $themes, $set, $get) === ['theme' => $name] && $stored === $name, "$name is saved and answered");
}
check(op_set_theme($ask('forest'), 'sam', $themes, $set, $get) === ['theme' => 'forest'], 'Sam may set it too');
check(op_set_theme($ask('forest'), 'sam', $themes, $set, $get) === ['theme' => 'forest'], 'setting the theme already stored is a success');
foreach (['', 'Midnight', 'MIDNIGHT', 'sage ', ' sage', 'dark', 'light', 'both', 'all', '../sage', 'sage/../midnight', "sage\0", 'olive<script>', null, 5, 1.5, true, false, ['sage'], ['theme' => 'sage']] as $bad) {
    $stored = 'olive'; $calls = 0;
    // A plain closure, not an arrow fn: an arrow fn would copy $stored and $calls, and the check below could never see the stub.
    refuses(function () use ($ask, $bad, $themes, $get, &$stored, &$calls) {
        return op_set_theme($ask($bad), 'alex', $themes, function (string $n) use (&$stored, &$calls) { ++$calls; $stored = $n; return true; }, $get);
    }, 400, 'invalid');
    check($stored === 'olive' && $calls === 0, 'a refused name never reaches the library: ' . json_encode($bad));
}
refuses(fn() => op_set_theme(['action' => 'setTheme'], 'alex', $themes, $set, $get), 400, 'invalid');
check((function () use ($ask, $themes, $set, $get) { try { op_set_theme($ask('nope'), 'alex', $themes, $set, $get); } catch (RequestError $e) { return $e->body(); } return null; })() === ['error' => 'That is not one of the themes.', 'code' => 'invalid'], 'the refusal says what is wrong, in a coded body');
// Only a configured household account may change it, whatever else is signed in.
foreach (['', 'both', 'all', 'outsider', 'Alex', 'alex ', '../alex', 'admin'] as $stranger) {
    $stored = 'midnight';
    refuses(fn() => op_set_theme($ask('sage'), $stranger, $themes, $set, $get), 403, 'forbidden');
    check($stored === 'midnight', "nothing is written for '$stranger'");
}

// ---- 2. Fail closed: a theme is claimed saved only when it reads back ----
$stored = 'midnight';
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, fn() => true, $get), 503, 'unavailable');   // says it wrote, did not
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, fn() => false, $get), 503, 'unavailable');  // says no, did not
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, function () { throw new RuntimeException('disk full'); }, $get), 503, 'unavailable');
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, function () { trigger_error('file_put_contents(): Failed to open stream', E_USER_WARNING); return true; }, $get), 503, 'unavailable');
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, $set, function () { throw new RuntimeException('unreadable'); }), 503, 'unavailable');
$stored = 'midnight';
$wrong = function (string $n) use (&$stored) { $stored = 'olive'; return true; }; // writes something else than asked
refuses(fn() => op_set_theme($ask('sage'), 'alex', $themes, $wrong, $get), 503, 'unavailable');
check($stored === 'olive', 'a library that stored another theme than the one asked for is not believed');
check(set_error_handler(null) === null, 'the error handler is put back after a failed write');
restore_error_handler();
harness_log(true);
$failure = (function () use ($ask, $themes, $get) { try { op_set_theme($ask('sage'), 'alex', $themes, fn() => throw new RuntimeException('secret path /home/protected/x'), $get); } catch (RequestError $e) { return $e; } return null; })();
check($failure !== null && !str_contains($failure->getMessage(), '/home') && $failure->body() === ['error' => 'Your theme could not be saved.', 'code' => 'unavailable'], 'the client never hears the cause');
check(!str_contains(harness_log(true), '/home/protected'), 'and the log keeps the class of the failure, not its message');

// ---- 3. The real site library, in a disposable copy shaped like the test instance's sandbox ----
$source = getenv('PLANMIND_TEST_SITE_LIB') ?: '';
if ($source === '') {
    // Beside PlanMind (standalone checkout) or beside the MindSuite monorepo that holds it.
    foreach ([dirname(__DIR__, 3) . '/../seancheren-site/lib', dirname(__DIR__, 3) . '/../../seancheren-site/lib'] as $candidate) {
        $source = $candidate;
        if (is_file($candidate . '/auth.php')) break;
    }
}
check(is_file($source . '/auth.php'), "the site library is needed (set PLANMIND_TEST_SITE_LIB=<seancheren-site>/lib); looked in $source");
$sandbox = harness_dir();
$lib = $sandbox . '/lib'; $data = $sandbox . '/accounts'; $planner = $sandbox . '/planner';
mkdir($lib); mkdir($planner, 0700);
foreach (scandir($source) ?: [] as $name) {
    // The live configuration never comes along: the copy has a config of its own, like the fixture of the e2e run.
    if ($name === '.' || $name === '..' || preg_match('/^config(?:\.[^\/]*)?\.php$/', $name) || !is_file($source . '/' . $name)) { continue; }
    copy($source . '/' . $name, $lib . '/' . $name);
}
$secret = password_hash('a staging secret', PASSWORD_BCRYPT, ['cost' => 4]);
// The test instance's sandbox config has no household accounts: its two come from staging-users.json in the planner's data directory.
file_put_contents($lib . '/config.php', "<?php return ['users'=>[],'data_dir'=>" . var_export($data, true) . ",'data_key'=>'disposable-fixture-key','timezone'=>'America/Chicago','base'=>'/test'];");
file_put_contents($planner . '/staging-users.json', json_encode(['alex' => $secret, 'sam' => $secret, 'outsider' => $secret]));
require_once $lib . '/auth.php';
$configured = (app_config()['users'] ?? []) + staging_hashes($planner, '-test');
check(array_keys($configured) === ['alex', 'sam'] && allowed('alex', $configured) && allowed('sam', $configured) && !allowed('outsider', $configured), 'the sandbox allows exactly Alex and Sam, from staging');
check(rtrim(app_config()['data_dir'], '/') === $data, 'the sandbox keeps its preferences in its own account directory');
$known = array_keys(THEMES);
check($known === $themes, 'the site knows exactly the four themes the app draws: ' . implode(',', $known));

$as = function (string $user) { $_SESSION = ['auth' => true, 'user' => $user]; };
$as('alex');
check(theme_get() === 'midnight', 'the default is Midnight');
foreach ($themes as $name) {
    $as('alex');
    check(op_set_theme($ask($name), 'alex', array_keys(THEMES), 'theme_set', 'theme_get') === ['theme' => $name], "the real library saves $name");
    check(theme_get() === $name, "and reads it back: $name");
}
$as('sam');
check(theme_get() === 'midnight', 'Sam has a theme of her own');
op_set_theme($ask('sage'), 'sam', array_keys(THEMES), 'theme_set', 'theme_get');
$as('alex');
check(theme_get() === 'olive', 'and Alex\'s did not move');
$file = $data . '/prefs-alex.json';
check(is_file($file) && !str_contains((string)file_get_contents($file), 'olive'), 'the preference is encrypted at rest like the rest of the account data');
check(is_file($data . '/prefs-sam.json'), 'in the file CalMind and the suite read: prefs-<user>.json');
// Other preferences of the account stay.
$prefs = store_read($file); $prefs['other'] = 'kept'; store_write($file, $prefs);
op_set_theme($ask('forest'), 'alex', array_keys(THEMES), 'theme_set', 'theme_get');
check((store_read($file)['other'] ?? null) === 'kept' && theme_get() === 'forest', 'choosing a theme leaves the account\'s other preferences alone');
refuses(fn() => op_set_theme($ask('nope'), 'alex', array_keys(THEMES), 'theme_set', 'theme_get'), 400, 'invalid');
check(theme_get() === 'forest', 'and a refused name changes nothing');

// A write that cannot happen is not claimed. The account directory is replaced by a file, so nothing can be written under it.
chmod($file, 0400);
$locked = $data . '/prefs-sam.json'; unlink($locked); mkdir($locked);
$as('sam');
refuses(fn() => op_set_theme($ask('olive'), 'sam', array_keys(THEMES), 'theme_set', 'theme_get'), 503, 'unavailable');
check(theme_get() === 'midnight', 'the failed write left Sam on the default, and the answer said so');
rmdir($locked);
chmod($file, 0600);

// ---- 4. #138: the Both color is a per-person account preference (setBothColor), not planner data ----
$colorKeys = \PlanMind\MODEL['colorKeys'];
$askColor = fn(mixed $color) => ['action' => 'setBothColor', 'bothColor' => $color];
$pick = null;
$setC = function (?string $c) use (&$pick) { $pick = $c; return true; };
$getC = function () use (&$pick) { return $pick; };
foreach ($colorKeys as $key) {
    check(op_set_both_color($askColor($key), 'alex', $setC, $getC) === ['bothColor' => $key] && $pick === $key, "Both color $key is saved and answered");
}
check(op_set_both_color($askColor('teal'), 'sam', $setC, $getC) === ['bothColor' => 'teal'], 'Sam may pick too');
foreach (['', 'Purple', 'PURPLE', 'purple ', 'mauve', '#800080', 'both', 5, true, ['purple']] as $bad) {
    $pick = 'blue'; $calls = 0;
    refuses(function () use ($askColor, $bad, $getC, &$pick, &$calls) {
        return op_set_both_color($askColor($bad), 'alex', function (?string $c) use (&$pick, &$calls) { ++$calls; $pick = $c; return true; }, $getC);
    }, 400, 'invalid');
    check($pick === 'blue' && $calls === 0, 'a color outside the palette never reaches the library: ' . json_encode($bad));
}
refuses(fn() => op_set_both_color(['action' => 'setBothColor'], 'alex', $setC, $getC), 400, 'invalid');
check(op_set_both_color($askColor(null), 'alex', $setC, $getC) === ['bothColor' => null] && $pick === null, 'null clears the pick');
foreach (['', 'both', 'all', 'outsider', 'Alex', '../alex'] as $stranger) {
    $pick = 'blue';
    refuses(fn() => op_set_both_color($askColor('red'), $stranger, $setC, $getC), 403, 'forbidden');
    check($pick === 'blue', "nothing is written for '$stranger'");
}
$pick = 'blue';
refuses(fn() => op_set_both_color($askColor('red'), 'alex', fn() => true, $getC), 503, 'unavailable');
refuses(fn() => op_set_both_color($askColor('red'), 'alex', function () { throw new RuntimeException('disk full /home/protected/x'); }, $getC), 503, 'unavailable');
refuses(fn() => op_set_both_color($askColor('red'), 'alex', function () { trigger_error('Failed to open stream', E_USER_WARNING); return true; }, $getC), 503, 'unavailable');
check(!str_contains(harness_log(true), '/home/protected/x'), 'the log keeps the class of the failure, not its message');

// The real library: one key of the account's prefs file, per user, encrypted, beside the theme.
$as('alex');
check(both_color_get() === null, 'no pick reads as null (the household default applies)');
check(op_set_both_color($askColor('red'), 'alex', 'PlanMind\\both_color_set', 'PlanMind\\both_color_get') === ['bothColor' => 'red'] && both_color_get() === 'red', 'the real library saves and reads back');
$as('sam');
check(both_color_get() === null, 'Sam has none: Alex\'s pick is Alex\'s alone');
op_set_both_color($askColor('blue'), 'sam', 'PlanMind\\both_color_set', 'PlanMind\\both_color_get');
$as('alex');
check(both_color_get() === 'red', 'and Sam\'s pick did not move Alex\'s');
check(theme_get() === 'forest', 'the theme is untouched by it');
$file = $data . '/prefs-alex.json';
check(!str_contains((string)file_get_contents($file), 'red'), 'the pick is encrypted at rest');
check((store_read($file)['other'] ?? null) === 'kept', 'the account\'s other preferences stay');
op_set_both_color($askColor(null), 'alex', 'PlanMind\\both_color_set', 'PlanMind\\both_color_get');
check(both_color_get() === null && !array_key_exists('planmindBothColor', store_read($file)), 'clearing removes the key from the real file');
// A value outside the palette in the file (an edited or newer file) reads as no pick, never as a color to draw.
$p = store_read($file); $p['planmindBothColor'] = 'mauve'; store_write($file, $p);
check(both_color_get() === null, 'a stored color outside the palette reads as none');
$p['planmindBothColor'] = ['red']; store_write($file, $p);
check(both_color_get() === null, 'and so does one of the wrong type');
chmod($file, 0400);
$locked = $data . '/prefs-sam.json'; unlink($locked); mkdir($locked);
$as('sam');
refuses(fn() => op_set_both_color($askColor('pink'), 'sam', 'PlanMind\\both_color_set', 'PlanMind\\both_color_get'), 503, 'unavailable');
check(both_color_get() === null, 'a failed write is not claimed, and nothing is stored');
rmdir($locked);
chmod($file, 0600);

// ---- 5. #138: simultaneous saves of one account's prefs file ----
// Eight separate PHP processes of Alex's, at the same moment: four pick a Both color, four set another key of the same file (what the CalMind
// switch does). Every key must survive (no lost update), the file must still decrypt, and the color must be one that was really picked.
// Two more processes, Alex's and Sam's, pick at the same moment: each account keeps its own file and its own pick.
$worker = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
$site = $mode;
require_once $lib . '/planner.php';
require_once $site . '/auth.php';
$_SESSION = ['auth' => true, 'user' => (int)$n > 8 ? 'sam' : 'alex'];
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
if ((int)$n > 8) { PlanMind\both_color_set('teal'); }
elseif ($n % 2 === 1) { PlanMind\both_color_set(['red', 'blue', 'pink', 'orange'][(int)(($n - 1) / 2)] ?? 'red'); }
else { PlanMind\prefs_locked(function () use ($n) { $p = store_read(theme_file()); $p["other$n"] = true; store_write(theme_file(), $p); }); }
PHP;
array_map('unlink', glob($data . '/*.tmp') ?: []); // the refused writes of section 4 left theirs
foreach (range(1, 4) as $round) {
    $_SESSION = ['auth' => true, 'user' => 'alex'];
    store_write($file, ['theme' => 'forest', 'other' => 'kept']);
    @unlink($data . '/prefs-sam.json');
    harness_workers($worker, $data, 10, $lib);
    $p = store_read($file);
    check(($p['other2'] ?? null) === true && ($p['other4'] ?? null) === true && ($p['other6'] ?? null) === true && ($p['other8'] ?? null) === true,
        "round $round: every simultaneous save of another key survived: " . implode(',', array_keys($p)));
    check(($p['theme'] ?? null) === 'forest' && ($p['other'] ?? null) === 'kept', "round $round: and so did the theme and the account's other key");
    check(in_array($p['planmindBothColor'] ?? null, ['red', 'blue', 'pink', 'orange'], true), "round $round: the stored Both color is one that was picked: " . json_encode($p['planmindBothColor'] ?? null));
    check(both_color_get() === $p['planmindBothColor'], "round $round: and the library reads it: ");
    $_SESSION = ['auth' => true, 'user' => 'sam'];
    check(both_color_get() === 'teal', "round $round: Sam's simultaneous pick is hers alone");
}
$_SESSION = ['auth' => true, 'user' => 'alex'];
check(!glob($data . '/*.tmp') && glob($data . '/go') === [], 'no partial files or gates are left');
