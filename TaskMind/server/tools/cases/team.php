<?php
declare(strict_types=1);
// The team and its gate: who the seed team is, how a stored workspace is read into members, and that the gate fails closed.
use TaskMind\{RequestError};
use function TaskMind\{clean_members, clean_text, find_member, instance_of, release_stamp, seed_admin, seed_members, seed_owners, session_reply, team_member, valid_id};

// ---- 1. The seed team ----
check(seed_owners([]) === [], 'no configuration: no owners, and none built into the code');
check(seed_owners(['taskmind_owners' => ['ana', ' ben ', 'ana', '../x', 'a b', '', 7, null]]) === ['ana', 'ben'], 'configured owners: ids only, once each');
check(seed_owners(['taskmind_owners' => ['../x']]) === [], 'nothing usable leaves no owners');
check(seed_owners(['taskmind_owners' => 'ana']) === ['ana'], 'one owner named as a string');
check(seed_admin([], ['ana', 'ben']) === 'ana' && seed_admin([], []) === null, 'the seed admin defaults to the first owner');
check(seed_admin(['taskmind_seed_admin' => ' sam '], ['alex']) === 'sam' && seed_admin(['taskmind_seed_admin' => '../x'], ['alex']) === 'alex', 'a configured seed admin must be a member id');
$ids = fn(array $m) => array_map(fn($r) => $r['id'] . ':' . $r['role'], $m);
check($ids(seed_members(['alex'], 'sam')) === ['alex:owner', 'sam:admin'], 'the seed team: an owner and an admin');
check($ids(seed_members(['sam'], 'sam')) === ['sam:owner'], 'the admin who is an owner already is not added again');
check($ids(seed_members(['ana', 'ben'], 'sam')) === ['ana:owner', 'ben:owner', 'sam:admin'], 'two owners and an admin');
check($ids(seed_members(['alex'])) === ['alex:owner'], 'no admin named: owners only');

// ---- 2. Reading a stored workspace ----
// A stored workspace always has its members (the seed team is written when the file is made), so one without them is damage.
fails(fn() => clean_members([], ['alex']), 'no team');
fails(fn() => clean_members(['v' => 1], ['alex']), 'no team');
fails(fn() => clean_members(['v' => 1, 'members' => 'alex'], ['alex']), 'no team');
fails(fn() => clean_members(['v' => 1, 'members' => null], ['alex']), 'no team');
check(clean_members(['members' => []], ['alex']) === [['id' => 'alex', 'role' => 'owner', 'added' => 0, 'by' => '', 'name' => '']], 'members stored but empty: the seed owners come back, and only them');
$dirty = ['members' => [
    harness_member('alex', 'owner', "  Alex\tC\n"), harness_member('alex', 'viewer'), harness_member('max', 'wizard'), harness_member('../x', 'owner'),
    ['id' => 'val', 'role' => 'viewer', 'added' => '12', 'by' => 'alex', 'name' => str_repeat('n', 90)], 'junk', ['role' => 'member'], ['id' => 5, 'role' => 'owner'],
]];
$clean = clean_members($dirty, ['alex']);
check($ids($clean) === ['alex:owner', 'max:viewer', 'val:viewer'], 'bad ids and duplicates are dropped; an unknown role is a viewer, never more: ' . implode(',', $ids($clean)));
check($clean[0]['name'] === 'Alex C', 'names are one line');
check($clean[2]['added'] === 12 && $clean[2]['by'] === 'alex' && mb_strlen($clean[2]['name']) === 60, 'added is a number, by an id, names are cut at 60');
$noOwner = clean_members(['members' => [harness_member('max', 'member'), harness_member('alex', 'viewer')]], ['alex']);
check($ids($noOwner) === ['max:member', 'alex:owner'], 'with no owner left the seed owner is made owner again: ' . implode(',', $ids($noOwner)));
$many = ['members' => array_map(fn($i) => harness_member("m$i", 'member'), range(1, TaskMind\LIMITS['membersMax'] + 20))];
check(count(clean_members($many, ['alex'])) <= TaskMind\LIMITS['membersMax'] + 1, 'the number of members is capped');
check(find_member($clean, 'max')['role'] === 'viewer' && find_member($clean, 'nobody') === null, 'a member is found by id');
check(valid_id('alex') && valid_id('a-b_9') && !valid_id('') && !valid_id('a b') && !valid_id(str_repeat('x', 41)) && !valid_id(5) && !valid_id("alex\n"), 'the shape of an id');
check(clean_text("  a \n\t b\u{0007} ", 10) === 'a b' && clean_text("\u{200B}  ", 10) === '' && clean_text('abcdef', 3) === 'abc' && clean_text('☃☃☃', 2) === '☃☃', 'one line of text, counted in characters');

// ---- 3. The gate ----
$config = ['taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam'];
[$store, $dir] = harness_store();
harness_log(true);
check(team_member($store, $config, 'alex')['role'] === 'owner' && team_member($store, $config, 'sam')['role'] === 'admin', 'a fresh install: the seed team is let in');
refuses(fn() => team_member($store, $config, 'outsider'), 403, 'forbidden');
check($store->transaction('workspace', fn($db) => $db) === harness_workspace(harness_member('alex', 'owner'), harness_member('sam', 'admin')), 'and was written to the workspace, explicitly');
check(substr_count(harness_log(), 'TaskMind workspace created on first use with the seed team: alex, sam') === 1, 'once, and the log says so: ' . harness_log());
$seededBytes = file_get_contents($dir . '/workspace.enc');
team_member($store, $config, 'alex');
check(file_get_contents($dir . '/workspace.enc') === $seededBytes, 'a later request reads it and writes nothing');
// An empty owners configuration: the seed refuses (503) and writes nothing; no id is built into the code.
[$bare, $bareDir] = harness_store();
refuses(fn() => team_member($bare, [], 'alex'), 503, 'unavailable');
refuses(fn() => team_member($bare, ['taskmind_owners' => ['../x']], 'alex'), 503, 'unavailable');
check(!file_exists($bareDir . '/workspace.enc'), 'empty owners config: seed refuses, and nothing is written');
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'member', 'Max'), harness_member('val', 'viewer')));
check(team_member($store, $config, 'max')['name'] === 'Max' && team_member($store, $config, 'val')['role'] === 'viewer', 'the stored team is the team');
refuses(fn() => team_member($store, $config, 'sam'), 403, 'forbidden');
// Removing a person takes effect on their very next request: nothing is remembered.
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner')));
refuses(fn() => team_member($store, $config, 'max'), 403, 'forbidden');
// Changing a role takes effect at once too.
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'viewer')));
check(team_member($store, $config, 'max')['role'] === 'viewer', 'a demotion is seen on the next request');
check(team_member($store, ['taskmind_owners' => ['alex']], 'alex')['role'] === 'owner', 'the configuration names the seed owners');
harness_log(true);
// An unreadable workspace admits nobody but tells the seed owners why.
$file = $dir . '/workspace.enc';
file_put_contents($file, 'TM1:garbage-that-is-not-a-store');
refuses(fn() => team_member($store, $config, 'alex'), 503, 'unavailable');
refuses(fn() => team_member($store, $config, 'max'), 403, 'forbidden');
refuses(fn() => team_member($store, $config, 'sam'), 403, 'forbidden');
refuses(fn() => team_member($store, ['taskmind_owners' => ['ana']], 'ana'), 503, 'unavailable');
refuses(fn() => team_member($store, ['taskmind_owners' => ['ana']], 'alex'), 403, 'forbidden');
check(str_contains(harness_log(), 'TaskMind workspace unreadable'), 'the cause goes to the log');
check(!str_contains(harness_log(), 'garbage'), 'and the bytes do not');
unlink($file);
unlink($dir . '/.key');
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner')));
check(team_member($store, $config, 'alex')['role'] === 'owner', 'a fresh key and file work');
// A damaged key on a store that exists is fail-closed too.
file_put_contents($dir . '/.key', 'short');
refuses(fn() => team_member($store, $config, 'alex'), 503, 'unavailable');
refuses(fn() => team_member($store, $config, 'max'), 403, 'forbidden');

// ---- 3b. Missing, empty, damaged, undecryptable: only a fresh install is seeded; everything else fails closed ----
// $setup gets a data directory that holds a good workspace (alex owner, max member) and breaks it.
$broken = [
    'missing after it existed (the version marker is left)' => fn(string $d) => unlink($d . '/workspace.enc'),
    'missing, only a version backup left' => function (string $d) { rename($d . '/workspace.enc', $d . '/workspace.v1.enc.bak'); unlink($d . '/workspace.version'); },
    'empty' => fn(string $d) => file_put_contents($d . '/workspace.enc', ''),
    'damaged: not a store' => fn(string $d) => file_put_contents($d . '/workspace.enc', '{"members":[]}'),
    'damaged: cut short' => fn(string $d) => file_put_contents($d . '/workspace.enc', substr((string)file_get_contents($d . '/workspace.enc'), 0, 20)),
    'damaged: no team in it' => fn(string $d) => (new TaskMind\Store($d))->transaction('workspace', fn($db) => ['v' => 1]),
    'damaged: the team is not a list' => fn(string $d) => (new TaskMind\Store($d))->transaction('workspace', fn($db) => ['v' => 1, 'members' => 'alex']),
    'undecryptable: a flipped bit' => function (string $d) { $raw = base64_decode(substr((string)file_get_contents($d . '/workspace.enc'), 4)); $raw[40] = chr(ord($raw[40]) ^ 1); file_put_contents($d . '/workspace.enc', 'TM1:' . base64_encode($raw)); },
    'undecryptable: another key' => fn(string $d) => file_put_contents($d . '/.key', random_bytes(32)),
    'undecryptable: the key is lost' => fn(string $d) => unlink($d . '/.key'),
];
foreach ($broken as $what => $break) {
    [$store, $dir] = harness_store();
    $store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner'), harness_member('max', 'member')));
    $break($dir);
    $snapshot = fn() => array_map(fn($f) => is_file($f) ? hash_file('sha256', $f) : 'dir', array_combine(glob($dir . '/{,.}[!.]*', GLOB_BRACE) ?: [], glob($dir . '/{,.}[!.]*', GLOB_BRACE) ?: []));
    $before = $snapshot();
    harness_log(true);
    refuses(fn() => team_member($store, $config, 'alex'), 503, 'unavailable');
    foreach (['max', 'sam', 'outsider'] as $who) { refuses(fn() => team_member($store, $config, $who), 403, 'forbidden'); }
    check(!str_contains(harness_log(), 'created on first use'), "$what: not seeded");
    check(str_contains(harness_log(), 'TaskMind workspace unreadable'), "$what: the cause is logged");
    $after = $snapshot();
    unset($before[$dir . '/.workspace.lock'], $after[$dir . '/.workspace.lock'], $before[$dir . '/.key.lock'], $after[$dir . '/.key.lock']);
    check($after === $before, "$what: nothing in the data directory was written");
}
// The seed owner is told which: a lost file is not "could not read".
[$store, $dir] = harness_store();
$store->transaction('workspace', fn($db) => harness_workspace(harness_member('alex', 'owner')));
unlink($dir . '/workspace.enc');
try { team_member($store, $config, 'alex'); check(false, 'a lost workspace let Alex in'); }
catch (RequestError $e) { check($e->status === 503 && str_contains($e->getMessage(), 'missing') && str_contains($e->getMessage(), 'restore'), 'a lost workspace says it is missing: ' . $e->getMessage()); }
// A fresh install whose directory holds only the sign-in ledger (someone tried to sign in first) is still a fresh install.
[$store, $dir] = harness_store();
$store->transaction('attempts', fn($db) => ['x' => ['count' => 1, 'until' => time() + 60]]);
check(team_member($store, $config, 'sam')['role'] === 'admin', 'a directory with only the ledger and its key is seeded');

// ---- 3c. Seeding happens once, even when the first requests race ----
$seedWorker = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/taskmind.php';
ini_set('log_errors', '1'); ini_set('error_log', $dir . '/seed.log');
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$member = TaskMind\team_member(new TaskMind\Store($dir), ['taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam'], $n % 2 ? 'alex' : 'sam');
exit($member['role'] === ($n % 2 ? 'owner' : 'admin') ? 0 : 1);
PHP;
[$store, $dir] = harness_store();
harness_workers($seedWorker, $dir, 6, 'seed');
check(substr_count((string)file_get_contents($dir . '/seed.log'), 'created on first use') === 1, 'six racing first requests seed exactly once');
check(count($store->transaction('workspace', fn($db) => $db)['members']) === 2, 'and the team is the seed team');

// ---- 4. The reply ----
check(session_reply(harness_member('alex', 'owner', 'Alex'), 'tok', 'sage') === ['ok' => true, 'me' => 'alex', 'role' => 'owner', 'name' => 'Alex', 'csrf' => 'tok', 'theme' => 'sage'], 'the session reply is exactly the Session of model.ts');

// ---- 5. The release stamp and the host's instance ----
check(release_stamp('/home/public/.taskmind/20261102093000-4') === '20261102093000-4', 'a release directory names its release');
foreach (['/home/public/TaskMind', '/x/20261102093000-4x', '/x/2026110209300-4', '/x/20261102093000-', '/x/x20261102093000-4', '/x/20261102093000-4/'] as $bad) {
    check(release_stamp($bad) === ($bad === '/x/20261102093000-4/' ? '20261102093000-4' : ''), "no release in $bad");
}
check(instance_of('seancheren.com') === '' && instance_of('test.seancheren.com') === '-test' && instance_of('DEV.seancheren.com:8080') === '-dev'
    && instance_of('test.seancheren.com.evil.example') === '' && instance_of('evil-test.seancheren.com') === '' && instance_of('') === '', 'the instance comes from the host name');
// index.php and api.php run before the lib is found, so each repeats the stamp pattern; they must say what the lib says.
$pattern = TaskMind\RELEASE_STAMP_PATTERN;
foreach (['index.php', 'api.php'] as $entry) {
    $source = (string)file_get_contents(__DIR__ . '/../../public/TaskMind/' . $entry);
    check(str_contains($source, "preg_match('/$pattern/', basename(__DIR__))"), "$entry repeats the release stamp pattern of taskmind.php");
    check(str_contains($source, "/^(test|dev)\\.seancheren\\.com(?::\\d+)?\$/i"), "$entry reads the instance from the host the way instance_of does");
}
