<?php
declare(strict_types=1);
// The v3 -> v4 bump (0.14.0, `doneOn`) and the data safety every store version bump now has (Alex, 2026-11-02): the first write that stores a newer
// version first keeps the old file's exact bytes once as tasks.v<old>.enc.bak and refuses to write over a different backup, and every write of
// tasks.enc leaves tasks.version (the number and a newline, plain text) beside it for tools/deploy.sh's rollback check.
// The v3 fixture, server/tools/fixtures/v3-store.json, was written by the 0.13.0 code itself (replayed through its mutate(), then given fixed stamps).
use PlanMind\Invariants;
use PlanMind\Store;
use function PlanMind\{mutate, snapshot, validate_db};

$V = PlanMind\MODEL['storeVersion'];
$v3 = json_decode((string)file_get_contents(__DIR__ . '/../fixtures/v3-store.json'), true, 64, JSON_THROW_ON_ERROR);
$v2 = json_decode((string)file_get_contents(__DIR__ . '/../fixtures/v2-store.json'), true, 64, JSON_THROW_ON_ERROR);
$bytes = fn(string $dir, string $name = 'tasks.enc') => (string)file_get_contents($dir . '/' . $name);
$listing = function (string $dir): array { $names = array_values(array_diff(scandir($dir) ?: [], ['.', '..'])); sort($names); return $names; };
$mode = fn(string $file) => substr(sprintf('%o', fileperms($file)), -3);
$addTodo = fn(int $n) => ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(900 + $n), 'scope' => 'day', 'date' => '2026-11-03', 'owners' => ['sam'], 'title' => "New $n"];
$without = fn(array $db, string ...$keys) => array_diff_key($db, array_flip($keys));
/** A data directory holding `$db` as tasks.enc exactly as an older release left it: no version marker. */
$disk = function (array $db) {
    [$store, $dir] = harness_store();
    $store->transaction('tasks', fn() => $db);
    @unlink($dir . '/tasks.version');
    return [$store, $dir, (string)file_get_contents($dir . '/tasks.enc')];
};

// ---- 1. The fixture is a v3 store as 0.13.0 wrote it ----
check($v3['v'] === 3 && $v3['revision'] === 17 && count($v3['tasks']) === 7 && count($v3['choreMarks']) === 2 && count($v3['chores']) === 21, 'the fixture is a v3 store with to-dos, chores and marks');
check(array_filter($v3['tasks'], fn($t) => array_key_exists('doneOn', $t)) === [] && count(array_filter($v3['tasks'], fn($t) => $t['done'])) === 2, 'two done to-dos and not one doneOn');

// ---- 2. A read converts in memory: every record accounted for, nothing altered ----
$db = Invariants::load($v3);
validate_db($db);
check($db['v'] === $V && $without($db, 'v') === $without($v3, 'v'), 'a v3 store reads as the current version with nothing else changed: every list, to-do, priority, event, note, chore, mark and preference');
check(Invariants::load($v3) === $db, 'converting again gives the identical db');
$s = snapshot($v3, 'alex');
check($s['v'] === $V && $s['revision'] === 17 && count($s['tasks']) === 7 && count($s['choreMarks']) === 2 && $s['prefs']['selection']['overlays'] === [HARNESS_CUSTOM], 'the snapshot of a v3 store');
check(array_diff_key(snapshot($v3, 'sam'), ['prefs' => 1]) === array_diff_key($s, ['prefs' => 1]), 'Sam and Alex see the same data');
check(mutate($v3, ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]], 'sidebar' => 'hidden'], 'alex') === $v3, 'a request that changes nothing hands back the very v3 db, so nothing is rewritten');
$ticked = mutate($v3, ['action' => 'complete', 'id' => harness_id(1), 'revision' => 1, 'done' => true, 'doneOn' => '2026-11-02'], 'alex', '2026-11-02');
check($ticked['v'] === $V && $ticked['revision'] === 18 && $ticked['tasks'][harness_id(1)]['doneOn'] === '2026-11-02' && $without($ticked['tasks'], harness_id(1)) === $without($v3['tasks'], harness_id(1)), 'the first change returns the current db at revision + 1 with every other to-do as it was');
foreach ([
    'an unknown field' => function (array $d) { $d['legacy'] = []; return $d; },
    'a missing collection' => function (array $d) { unset($d['choreMarks']); return $d; },
    'a to-do with a doneOn, which v3 never wrote' => function (array $d) { $d['tasks'][harness_id(3)]['doneOn'] = '2026-10-31'; return $d; },
    'a bad to-do' => function (array $d) { $d['tasks'][harness_id(1)]['owners'] = ['both']; return $d; },
    'a bad chore' => function (array $d) { $d['chores'][array_key_first($d['chores'])]['title'] = ''; return $d; },
] as $label => $break) {
    fails(fn() => snapshot($break($v3), 'alex'), 'Invalid planner data');
    fails(fn() => mutate($break($v3), ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => []]], 'alex'), 'Invalid planner data');
}

// ---- 3. Reads and refused writes are read-only: no backup, no marker ----
[$store, $dir, $original] = $disk($v3);
$read = fn() => $store->transaction('tasks', fn($stored) => $stored);
check($read() === $v3 && snapshot($read(), 'alex')['v'] === $V && $bytes($dir) === $original, 'reading a stored v3 file does not rewrite it');
check($store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]], 'sidebar' => 'hidden'], 'alex')) === $v3, 'a no-op write returns the v3 db');
fails(fn() => $store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'complete', 'id' => harness_id(1), 'revision' => 9, 'done' => true], 'alex')));
fails(fn() => $store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'complete', 'id' => harness_id(1), 'revision' => 1, 'done' => true, 'doneOn' => '2026-12-24'], 'alex', '2026-11-02')));
check($bytes($dir) === $original && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc'], 'reads, no-ops and refused writes leave the v3 file as it was, with no backup and no marker');

// ---- 4. The first write: current version on disk, the v3 bytes saved once, the marker written ----
$after = $store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(1), 'sam'));
check($after['v'] === $V && $after['revision'] === 18 && count($after['tasks']) === 8, 'the write returns the current db at revision + 1');
check(array_diff_key($after['tasks'], [harness_id(901) => 1]) === $db['tasks'], 'every converted to-do is stored as the read showed it');
check($bytes($dir) !== $original && $bytes($dir, 'tasks.v3.enc.bak') === $original, 'tasks.enc is replaced; tasks.v3.enc.bak holds the original bytes exactly');
check($bytes($dir, 'tasks.version') === $V . "\n", 'tasks.version holds the number and a newline');
check($listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.v3.enc.bak', 'tasks.version'], 'the data directory gains only the backup and the marker');
check($mode($dir . '/tasks.enc') === '600' && $mode($dir . '/tasks.v3.enc.bak') === '600', 'the data and its backup are private to their owner');
check($mode($dir . '/tasks.version') === '640', 'the marker is readable by the group, so the deploy user can read it over ssh');
check($read() === $after, 'the converted file reads back');
$inodes = [fileinode($dir . '/tasks.v3.enc.bak'), fileinode($dir . '/tasks.version')];
$again = $store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(2), 'alex'));
check(count($again['tasks']) === 9 && $again['revision'] === 19, 'the next write is an ordinary current-version write');
check($bytes($dir, 'tasks.v3.enc.bak') === $original && fileinode($dir . '/tasks.v3.enc.bak') === $inodes[0], 'the backup is written once and never touched again');
check(fileinode($dir . '/tasks.version') === $inodes[1] && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.v3.enc.bak', 'tasks.version'], 'the marker is rewritten only when its number changes, and no second backup appears');
// Nothing readable in the backup.
foreach (['Plan the trip', 'Wait for the plumber', 'createdBy', '2026-10-30'] as $needle) {
    check(!str_contains($original, $needle) && !str_contains((string)base64_decode(substr($original, 4), true), $needle), "'$needle' is not readable in the backup");
}
// The backup is the genuine v3 file: put it back and the code reads the original data again.
$copy = harness_dir();
copy($dir . '/.key', $copy . '/.key');
copy($dir . '/tasks.v3.enc.bak', $copy . '/tasks.enc');
check(snapshot((new Store($copy))->transaction('tasks', fn($stored) => $stored), 'alex') === $s, 'restoring tasks.v3.enc.bak as tasks.enc gives back exactly the v3 data');

// ---- 5. An existing backup is never overwritten ----
[$store, $dir, $original] = $disk($v3);
file_put_contents($dir . '/tasks.v3.enc.bak', 'someone else\'s file');
harness_log(true);
fails(fn() => $store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(1), 'sam')), 'cannot be backed up');
check($bytes($dir) === $original && $bytes($dir, 'tasks.v3.enc.bak') === 'someone else\'s file' && !file_exists($dir . '/tasks.version'), 'a different backup is kept, the v3 file is not converted over it and no marker is written');
check(str_contains(harness_log(true), 'tasks.v3.enc.bak already exists'), 'error_log names why');
copy($dir . '/tasks.enc', $dir . '/tasks.v3.enc.bak');
$inode = fileinode($dir . '/tasks.v3.enc.bak');
$partial = $store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(1), 'sam'));
check($partial['v'] === $V && $bytes($dir, 'tasks.v3.enc.bak') === $original && fileinode($dir . '/tasks.v3.enc.bak') === $inode && $bytes($dir, 'tasks.version') === $V . "\n", 'a backup that is already this very file (an earlier write stopped half way) is kept and the write goes on');

// ---- 6. Any older version is kept under its own number ----
[$store, $dir, $original] = $disk($v2);
$first = $store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(1), 'sam'));
check($first['v'] === $V && $bytes($dir, 'tasks.v2.enc.bak') === $original && !file_exists($dir . '/tasks.v3.enc.bak') && $bytes($dir, 'tasks.version') === $V . "\n", 'a v2 file goes to the current version in one write, kept as tasks.v2.enc.bak');
check($without($first, 'v', 'revision', 'chores', 'choreMarks', 'rhythm', 'tasks') === $without($v2, 'v', 'revision', 'tasks') && count($first['chores']) === 21, 'with the seeded chart and the v2 data intact');

// ---- 7. The marker follows every write of tasks.enc, and only those ----
[$store, $dir] = harness_store();
refuses(fn() => $store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(1), 'scope' => 'day', 'date' => 'nope', 'owners' => ['sam'], 'title' => 'x'], 'sam')), 400);
check(!file_exists($dir . '/tasks.version') && !file_exists($dir . '/tasks.enc'), 'a refused write on a new store leaves neither a file nor a marker');
$store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(1), 'sam'));
check($bytes($dir, 'tasks.version') === $V . "\n" && $mode($dir . '/tasks.version') === '640' && !glob($dir . '/*.tmp') && !file_exists($dir . '/tasks.v4.enc.bak'), 'a new store gets its marker with its first write, and no backup (there is nothing to keep)');
unlink($dir . '/tasks.version');
check($store->transaction('tasks', fn($stored) => $stored) === $store->transaction('tasks', fn($stored) => $stored) && !file_exists($dir . '/tasks.version'), 'a read does not write the marker');
$store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(2), 'sam'));
check($bytes($dir, 'tasks.version') === $V . "\n", 'the next write puts back a marker that went missing');
file_put_contents($dir . '/tasks.version', "3\n");
$store->transaction('tasks', fn($stored) => mutate($stored, $addTodo(3), 'sam'));
check($bytes($dir, 'tasks.version') === $V . "\n", 'and corrects one that names a lower version than the file holds');
$store->transaction('attempts', fn($stored) => ['n' => ($stored['n'] ?? 0) + 1]);
check(!file_exists($dir . '/attempts.version'), 'the sign-in ledger gets no version marker');

// ---- 8. Six processes make the first write at the same moment ----
$worker = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/planner.php';
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$store = new PlanMind\Store($dir);
$id = sprintf('%08x-0000-4000-8000-%012x', 100 + (int)$n, 100 + (int)$n);
$store->transaction('tasks', fn($db) => PlanMind\mutate($db, ['action' => 'add', 'kind' => 'todo', 'id' => $id, 'scope' => 'day',
    'date' => '2026-12-05', 'owners' => ['sam'], 'title' => "Racer $n"], $n % 2 ? 'alex' : 'sam'));
PHP;
foreach ([1, 2, 3] as $round) {
    [$store, $dir, $original] = $disk($v3);
    harness_workers($worker, $dir, 6, 'mutate');
    $final = $store->transaction('tasks', fn($stored) => $stored);
    check($final['v'] === $V && $final['revision'] === 17 + 6 && count($final['tasks']) === 7 + 6, "round $round: six writes and all seven to-dos are there");
    check(array_intersect_key($final['tasks'], $v3['tasks']) === $db['tasks'], "round $round: converted exactly once: every v3 to-do is as the read showed it");
    check($bytes($dir, 'tasks.v3.enc.bak') === $original && $bytes($dir, 'tasks.version') === $V . "\n", "round $round: the backup is the untouched original and the marker says the current version");
    check($listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.v3.enc.bak', 'tasks.version'], "round $round: no partial or extra files");
    validate_db($final);
}
