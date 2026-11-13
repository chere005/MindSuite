<?php
declare(strict_types=1);
// The one-time conversion of a v1 store (PlanMind 0.1.0, live before v2) to v2. Every fixture is written by the real 0.1.0
// writer (server/tools/v1-planner.php, namespace PlanMindV1) into a disposable directory, never by hand.
// A read converts in memory and leaves the file alone; the first successful write stores v2 after saving the untouched
// v1 bytes once as tasks.v1.enc.bak; a v1 file that does not decrypt or does not look exactly like 0.1.0 wrote it fails closed.
require_once __DIR__ . '/../v1-planner.php';
use PlanMind\Invariants;
use PlanMind\Store;
use function PlanMind\{mutate, snapshot, validate_db};

$bytes = fn(string $dir, string $name = 'tasks.enc') => (string)file_get_contents($dir . '/' . $name);
$addTodo = fn(int $n, ?string $title = null) => ['action' => 'add', 'kind' => 'todo', 'id' => harness_id($n), 'scope' => 'day', 'date' => '2026-10-31',
    'owners' => ['sam'], 'title' => $title ?? "New $n"];
$listing = function (string $dir): array { $names = array_values(array_diff(scandir($dir) ?: [], ['.', '..'])); sort($names); return $names; };

/**
 * A v1 store as production could hold it, built by replaying requests through the 0.1.0 writer: linked, single-owner,
 * done, edited and deleted to-dos, a day with fifteen open to-dos for one person (two more than the 13 a list may hold), titles far over today's caps, a month
 * to-do, notes of different ages, a long one, a cleared one. Returns [dir, the v1 plaintext, the file's exact bytes].
 */
$buildV1 = function (): array {
    [, $dir] = harness_store();
    $v1 = new PlanMindV1\Store($dir);
    $send = fn(array $input, string $user) => $v1->transaction('tasks', fn($db) => PlanMindV1\mutate($db, $input, $user));
    $add = fn(int $n, string $title, string $person, string $date, string $user, string $scope = 'day') =>
        $send(['action' => 'add', 'id' => harness_id($n), 'title' => $title, 'date' => $date, 'person' => $person, 'scope' => $scope], $user);
    $add(1, 'Zebra-linked plan the trip', 'both', '2026-10-30', 'alex');
    $add(2, 'Zebra-sam buy a gift', 'sam', '2026-10-30', 'sam');
    for ($n = 3; $n <= 10; ++$n) { $add($n, "Zebra-alex errand $n", 'alex', '2026-10-30', 'alex'); }
    for ($n = 16; $n <= 21; ++$n) { $add($n, "Zebra-alex errand $n", 'alex', '2026-10-30', 'alex'); }
    $add(11, 'Zebra-long ' . str_repeat('日本語😀 ', 12), 'alex', '2026-10-31', 'alex');
    $add(12, 'Zebra-month ' . str_repeat('m', 600), 'both', '2026-11-01', 'sam', 'month');
    $add(13, 'Zebra-month sam', 'sam', '2026-11-01', 'sam', 'month');
    $add(14, "Zebra-two\nlines", 'sam', '2026-10-31', 'sam');
    $add(15, 'Zebra-deleted', 'alex', '2026-10-31', 'alex');
    $send(['action' => 'complete', 'id' => harness_id(2), 'revision' => 1, 'done' => true], 'alex');
    $send(['action' => 'edit', 'id' => harness_id(3), 'revision' => 1, 'title' => 'Zebra-alex errand 3, edited', 'date' => '2026-10-30', 'person' => 'alex'], 'sam');
    $send(['action' => 'delete', 'id' => harness_id(15), 'revision' => 1, 'confirm' => true], 'alex');
    $note = fn(string $scope, string $period, string $text, int $revision, string $user) =>
        $send(['action' => 'saveNote', 'scope' => $scope, 'period' => $period, 'text' => $text, 'revision' => $revision], $user);
    $note('week', '2026-10-26', 'Zebra-week renew passport', 0, 'alex');
    $note('week', '2026-10-26', 'Zebra-week renew passport and visa', 1, 'sam');
    $note('month', '2026-11-01', str_repeat('Zebra-month-note ', 800), 0, 'alex');
    $note('week', '2026-11-02', 'Zebra-cleared', 0, 'sam');
    $note('week', '2026-11-02', '', 1, 'sam');
    // Data this old was written days ago: fixed stamps, so nothing can pass by matching "now". Task 7 was touched last.
    $v1->transaction('tasks', function ($db) {
        foreach ($db['tasks'] as $id => $task) { $db['tasks'][$id]['updatedAt'] = $id === harness_id(7) ? '2026-10-29T09:30:00+00:00' : '2026-10-29T08:00:00+00:00'; }
        foreach ($db['notes'] as $key => $note) { $db['notes'][$key]['updatedAt'] = '2026-10-28T12:00:00+00:00'; }
        return $db;
    });
    return [$dir, $v1->transaction('tasks', fn($db) => $db), (string)file_get_contents($dir . '/tasks.enc')];
};

// ---- 1. The fixture is genuinely what 0.1.0 wrote ----
[$dir, $raw, $original] = $buildV1();
check(!isset($raw['v']) && count($raw['tasks']) === 20 && count($raw['notes']) === 3 && $raw['revision'] === 29, 'the 0.1.0 writer made 20 tasks (one deleted), 3 notes, 29 writes');
check(str_starts_with($original, 'PM1:') && !str_contains($original, 'Zebra'), 'and an encrypted PM1 file');
check(max(array_map('mb_strlen', array_column($raw['tasks'], 'title'))) > 600 && mb_strlen($raw['notes']['month:2026-11-01']['text']) > PlanMind\LIMITS['docChars'], 'with titles and a note over today\'s caps');

// ---- 2. A read converts in memory: every task and note accounted for, nothing altered ----
$db = Invariants::load($raw);
validate_db($db);
check($db['v'] === PlanMind\MODEL['storeVersion'] && $db['revision'] === $raw['revision'] && array_keys($db['lists']) === ['sam', 'alex'] && $db['settings']['bothColor'] === 'purple'
    && $db['priorities'] === [] && $db['events'] === [] && $db['prefs'] === [], 'a current-version db with the permanent lists, default settings and the v1 revision');
check(count($db['chores']) === 21 && $db['choreMarks'] === [] && $db['rhythm']['anchor'] === '2026-11-02' && array_unique(array_column($db['chores'], 'updatedAt')) === [$db['settings']['updatedAt']], 'and the seeded chore chart, stamped from the data and not the clock');
$owners = ['both' => ['alex', 'sam'], 'sam' => ['sam'], 'alex' => ['alex']];
check(array_keys($db['tasks']) === array_keys($raw['tasks']) && count($db['tasks']) === 20, 'every task is there, under its id');
foreach ($raw['tasks'] as $id => $old) {
    $new = $db['tasks'][$id];
    check($new['id'] === $id && $new['owners'] === $owners[$old['person']] && $new['scope'] === $old['scope'] && $new['date'] === $old['date']
        && $new['title'] === $old['title'] && $new['done'] === $old['done'] && $new['revision'] === $old['revision']
        && $new['createdBy'] === $old['createdBy'] && $new['updatedAt'] === $old['updatedAt'], "task $id carried over field for field");
    check($new['updatedBy'] === $old['createdBy'] && $new['createdAt'] === $old['updatedAt'] && preg_match('/^[a-f0-9]{16}$/D', $new['ak']) === 1, "task $id: authorship and stamps from what v1 knew");
}
check($db['tasks'][harness_id(1)]['owners'] === ['alex', 'sam'] && $db['tasks'][harness_id(12)]['owners'] === ['alex', 'sam'] && $db['tasks'][harness_id(12)]['scope'] === 'month', 'a Both task is one linked record; month scope kept');
check($db['tasks'][harness_id(2)]['done'] === true && $db['tasks'][harness_id(3)]['revision'] === 2 && $db['tasks'][harness_id(3)]['title'] === 'Zebra-alex errand 3, edited', 'done flags and revisions of edited tasks');
check(!isset($db['tasks'][harness_id(15)]), 'a deleted task stays deleted');
check($db['tasks'][harness_id(11)]['title'] === $raw['tasks'][harness_id(11)]['title'] && mb_strlen($db['tasks'][harness_id(11)]['title']) > PlanMind\LIMITS['dayTodoText']
    && $db['tasks'][harness_id(12)]['title'] === $raw['tasks'][harness_id(12)]['title'] && mb_strlen($db['tasks'][harness_id(12)]['title']) > 600
    && $db['tasks'][harness_id(14)]['title'] === "Zebra-two\nlines", 'titles over the caps, with emoji or a line break, are kept as they were');
check(count(array_filter($db['tasks'], fn($t) => $t['scope'] === 'day' && $t['date'] === '2026-10-30' && !$t['done'] && in_array('alex', $t['owners'], true))) === 15 && 15 > PlanMind\LIMITS['dayTodosPerList'],
    'a day with fifteen open to-dos for one person (over dayTodosPerList) is read as it was');
// Order: v1 showed open before done, then by id. pos keeps the id order inside each (scope, date), one gap apart.
$buckets = [];
foreach ($db['tasks'] as $t) { $buckets[$t['scope'] . $t['date']][$t['id']] = $t['pos']; }
foreach ($buckets as $bucket => $positions) {
    ksort($positions, SORT_STRING);
    check(array_values($positions) === array_map(fn($i) => ($i + 1) * PlanMind\LIMITS['posGap'], array_keys(array_values($positions))), "bucket $bucket keeps the id order, one gap apart");
}
check($db['tasks'][harness_id(1)]['pos'] === 1024 && $db['tasks'][harness_id(2)]['pos'] === 2048 && $db['tasks'][harness_id(10)]['pos'] === 10 * 1024 && $db['tasks'][harness_id(14)]['pos'] === 2048
    && $db['tasks'][harness_id(11)]['pos'] === 1024, 'positions: ids in order, 1024 apart, per day');
// Notes: the one shared text per period becomes the same text in BOTH lists; week text is the week's `priorities`, month text its `notes`.
check(count($db['notes']) === 6, 'three shared notes become six, two per period');
$expectNotes = [['week', '2026-10-26', 'priorities', 'Zebra-week renew passport and visa', 2, 'sam'], ['month', '2026-11-01', 'notes', str_repeat('Zebra-month-note ', 800), 1, 'alex'],
    ['week', '2026-11-02', 'priorities', '', 2, 'sam']];
foreach ($expectNotes as [$scope, $period, $field, $text, $revision, $by]) {
    foreach (['alex', 'sam'] as $list) {
        $key = "$scope:$period:$list:$field";
        $old = $raw['notes']["$scope:$period"];
        check(($db['notes'][$key] ?? null) === ['key' => $key, 'scope' => $scope, 'period' => $period, 'listId' => $list, 'field' => $field, 'text' => $text,
            'revision' => $revision, 'updatedBy' => $by, 'updatedAt' => $old['updatedAt']], "note $key carries the text, revision and author");
    }
}
// Idempotent: the same db every time, however many reads and whenever they happen; the stamps come from the data.
$newest = '2026-10-29T09:30:00+00:00';
check(Invariants::load($raw) === $db && Invariants::load($raw) === Invariants::load($raw), 'converting again gives the identical db');
check($raw['tasks'][harness_id(7)]['updatedAt'] === $newest && $db['lists']['sam']['updatedAt'] === $newest && $db['lists']['alex']['updatedAt'] === $newest && $db['settings']['updatedAt'] === $newest, 'list and settings stamps do not depend on the clock');
$seen = snapshot($raw, 'alex');
check($seen === snapshot($raw, 'alex') && count($seen['tasks']) === 20 && count($seen['notes']) === 6 && $seen['prefs']['selection'] === ['base' => 'both', 'overlays' => []], 'a snapshot of a v1 store');
check(array_diff_key(snapshot($raw, 'sam'), ['prefs' => 1]) === array_diff_key($seen, ['prefs' => 1]), 'Sam and Alex see the same data');
// A converted to-do is fingerprinted like one added in v2: the same request again is an idempotent retry, another person's is not.
$retry = ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(2), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['sam'], 'title' => 'Zebra-sam buy a gift'];
check(mutate($raw, $retry, 'sam') === $raw, 'repeating the request that created a v1 to-do changes nothing');
refuses(fn() => mutate($raw, $retry, 'alex'), 409, 'id_in_use');
refuses(fn() => mutate($raw, ['title' => 'Another title'] + $retry, 'sam'), 409, 'id_in_use');
$noScope = $raw; unset($noScope['tasks'][harness_id(2)]['scope']);
check(Invariants::load($noScope)['tasks'][harness_id(2)]['scope'] === 'day', 'a v1 task with no scope is a day task, as the 0.1.0 screens read it');

// ---- 3. Reads and failed writes are read-only ----
$store = new Store($dir);
$read = fn() => $store->transaction('tasks', fn($db) => $db);
check($read() === $raw, 'the store hands back the v1 plaintext untouched');
snapshot($read(), 'alex'); snapshot($read(), 'sam');
$noop = ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => []]];
check($store->transaction('tasks', fn($db) => mutate($db, $noop, 'sam')) === $raw, 'a no-op write returns the v1 db');
foreach ([['action' => 'complete', 'id' => harness_id(2), 'revision' => 9, 'done' => false], ['action' => 'complete', 'id' => harness_id(404), 'revision' => 1, 'done' => true],
    ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(60), 'scope' => 'day', 'date' => '2026-10-31', 'owners' => ['both'], 'title' => 'x'], ['action' => 'nonsense']] as $refused) {
    fails(fn() => $store->transaction('tasks', fn($db) => mutate($db, $refused, 'alex')));
}
check($bytes($dir) === $original && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc'], 'reads, no-ops and refused writes leave the v1 file as it was, with no backup and no temporary file');

// ---- 4. The first successful write: v2 on disk, the v1 bytes saved once ----
$after = $store->transaction('tasks', fn($db) => mutate($db, $addTodo(60), 'sam'));
check($after['v'] === PlanMind\MODEL['storeVersion'] && $after['revision'] === $raw['revision'] + 1 && count($after['tasks']) === 21 && count($after['notes']) === 6, 'the write returns the current db at revision + 1');
check(array_diff_key($after['tasks'], [harness_id(60) => 1]) === $db['tasks'], 'every converted task is stored as the read showed it');
check($bytes($dir) !== $original && $bytes($dir, 'tasks.v1.enc.bak') === $original, 'tasks.enc is replaced; tasks.v1.enc.bak holds the original bytes exactly');
check($listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.v1.enc.bak', 'tasks.version'], 'the data directory gains only the backup and the version marker');
check($bytes($dir, 'tasks.version') === PlanMind\MODEL['storeVersion'] . "\n", 'the marker names the version the file now holds');
foreach (['tasks.enc', 'tasks.v1.enc.bak'] as $name) { check(substr(sprintf('%o', fileperms($dir . '/' . $name)), -3) === '600', "$name is private to its owner like every data file"); }
check($read() === $after && count(snapshot($read(), 'sam')['tasks']) === 21, 'the stored v2 file reads back');
$inode = fileinode($dir . '/tasks.v1.enc.bak');
$again = $store->transaction('tasks', fn($db) => mutate($db, $addTodo(61), 'alex'));
check(count($again['tasks']) === 22 && count($again['notes']) === 6 && $again['revision'] === $raw['revision'] + 2, 'the next write is an ordinary v2 write: nothing converted twice, no note duplicated');
check($bytes($dir, 'tasks.v1.enc.bak') === $original && fileinode($dir . '/tasks.v1.enc.bak') === $inode, 'the backup is written once and never touched again');
// What is stored is plain v2 data from here on: caps apply to what is written now, not to what was kept.
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(62), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex'], 'title' => 'One more'], 'alex')), 409, 'limit');
$done = $store->transaction('tasks', fn($db) => mutate($db, ['action' => 'complete', 'id' => harness_id(4), 'revision' => 1, 'done' => true], 'sam'));
check($done['tasks'][harness_id(4)]['done'] === true && $done['tasks'][harness_id(4)]['revision'] === 2, 'a kept over-cap day can still have its to-dos completed');
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, ['action' => 'complete', 'id' => harness_id(4), 'revision' => 2, 'done' => false], 'alex')), 409, 'limit');
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, ['action' => 'edit', 'kind' => 'todo', 'id' => harness_id(11), 'revision' => 1, 'date' => '2026-10-31', 'owners' => ['alex'],
    'title' => $raw['tasks'][harness_id(11)]['title']], 'alex')), 400, 'text_too_long');
$short = $store->transaction('tasks', fn($db) => mutate($db, ['action' => 'edit', 'kind' => 'todo', 'id' => harness_id(11), 'revision' => 1, 'date' => '2026-10-31', 'owners' => ['alex'], 'title' => 'Short now'], 'alex'));
check($short['tasks'][harness_id(11)]['title'] === 'Short now', 'an over-cap title can be replaced by one that fits');
$monthNote = fn(string $list, string $text, int $revision) => ['action' => 'saveNote', 'scope' => 'month', 'period' => '2026-11-01', 'listId' => $list, 'field' => 'notes', 'text' => $text, 'revision' => $revision];
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, $monthNote('sam', str_repeat('Zebra-month-note ', 800), 1), 'sam')), 400, 'text_too_long');
$note = $store->transaction('tasks', fn($db) => mutate($db, $monthNote('sam', 'Sam rewrote her month', 1), 'sam'));
check($note['notes']['month:2026-11-01:sam:notes']['text'] === 'Sam rewrote her month' && $note['notes']['month:2026-11-01:sam:notes']['revision'] === 2
    && $note['notes']['month:2026-11-01:alex:notes']['text'] === str_repeat('Zebra-month-note ', 800), 'each list\'s copy of a migrated note is edited alone');

// ---- 5. Nothing readable in either file ----
foreach (['tasks.enc', 'tasks.v1.enc.bak'] as $name) {
    $file = $bytes($dir, $name);
    $blob = (string)base64_decode(substr($file, 4), true);
    foreach (['Zebra', 'Sam rewrote', 'passport', 'createdBy', 'updatedAt', 'person', '2026-10-30'] as $needle) {
        check(!str_contains($file, $needle) && !str_contains($blob, $needle), "'$needle' is not readable in $name");
    }
}

// ---- 6. The backup is the genuine v1 file: put it back and 0.1.0's own reader gets the original data ----
$copy = harness_dir();
foreach (['.key', '.key.lock'] as $name) { copy($dir . '/' . $name, $copy . '/' . $name); }
copy($dir . '/tasks.v1.enc.bak', $copy . '/tasks.enc');
check((new PlanMindV1\Store($copy))->transaction('tasks', fn($db) => $db) === $raw, 'restoring tasks.v1.enc.bak as tasks.enc gives back exactly the v1 data');
check(snapshot((new Store($copy))->transaction('tasks', fn($db) => $db), 'alex') === $seen, 'and the v2 code converts it to the same snapshot again');

// ---- 7. An existing backup is never overwritten ----
[$dir, $raw, $original] = $buildV1();
$store = new Store($dir);
file_put_contents($dir . '/tasks.v1.enc.bak', 'someone else\'s file');
harness_log(true);
fails(fn() => $store->transaction('tasks', fn($db) => mutate($db, $addTodo(60), 'sam')), 'cannot be backed up');
check($bytes($dir) === $original && $bytes($dir, 'tasks.v1.enc.bak') === 'someone else\'s file', 'a different backup is kept and the v1 file is not converted over it');
check(str_contains(harness_log(true), 'tasks.v1.enc.bak already exists'), 'error_log names why');
copy($dir . '/tasks.enc', $dir . '/tasks.v1.enc.bak');
$inode = fileinode($dir . '/tasks.v1.enc.bak');
$partial = $store->transaction('tasks', fn($db) => mutate($db, $addTodo(60), 'sam'));
check($partial['v'] === PlanMind\MODEL['storeVersion'] && $bytes($dir, 'tasks.v1.enc.bak') === $original && fileinode($dir . '/tasks.v1.enc.bak') === $inode, 'a backup that is already this very file (an earlier write stopped half way) is kept and the write goes on');

// ---- 8. A v1 file that does not decrypt, or is not what 0.1.0 wrote, fails closed with its bytes untouched ----
[$dir, $raw, $original] = $buildV1();
$store = new Store($dir);
$flip = $original; $flip[45] = $flip[45] === 'a' ? 'b' : 'a';
foreach ([$flip, substr($original, 0, 60), 'PM2:' . substr($original, 4), $original . '!', ''] as $damaged) {
    file_put_contents($dir . '/tasks.enc', $damaged);
    foreach ([fn($db) => $db, fn($db) => mutate($db, $addTodo(60), 'sam')] as $change) { fails(fn() => $store->transaction('tasks', $change)); }
    check($bytes($dir) === $damaged && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc'], 'a damaged v1 file is left alone, converted to nothing and backed up as nothing');
}
file_put_contents($dir . '/tasks.enc', $original);
$task = harness_id(3); $noteKey = 'week:2026-10-26';
$faulty = [
    'a task with an unknown field' => function (array $d) use ($task) { $d['tasks'][$task]['owners'] = ['alex']; return $d; },
    'a task without a title' => function (array $d) use ($task) { unset($d['tasks'][$task]['title']); return $d; },
    'a task without a timestamp' => function (array $d) use ($task) { unset($d['tasks'][$task]['updatedAt']); return $d; },
    'a task whose person is not one of three' => function (array $d) use ($task) { $d['tasks'][$task]['person'] = 'nobody'; return $d; },
    'a task whose person is a list' => function (array $d) use ($task) { $d['tasks'][$task]['person'] = ['alex']; return $d; },
    'a task on an impossible date' => function (array $d) use ($task) { $d['tasks'][$task]['date'] = '2026-02-30'; return $d; },
    'a month task not on the first' => function (array $d) { $d['tasks'][harness_id(13)]['date'] = '2026-11-15'; return $d; },
    'a task of a week scope' => function (array $d) use ($task) { $d['tasks'][$task]['scope'] = 'week'; return $d; },
    'a task whose done is a number' => function (array $d) use ($task) { $d['tasks'][$task]['done'] = 1; return $d; },
    'a task with revision zero' => function (array $d) use ($task) { $d['tasks'][$task]['revision'] = 0; return $d; },
    'a task by a stranger' => function (array $d) use ($task) { $d['tasks'][$task]['createdBy'] = 'outsider'; return $d; },
    'a task whose title is not text' => function (array $d) use ($task) { $d['tasks'][$task]['title'] = ['x']; return $d; },
    'a task whose id differs from its key' => function (array $d) use ($task) { $d['tasks'][$task]['id'] = harness_id(99); return $d; },
    'a task under a key that is no id' => function (array $d) use ($task) { $d['tasks']['not-an-id'] = ['id' => 'not-an-id'] + $d['tasks'][$task]; return $d; },
    'tasks stored as a list' => function (array $d) { $d['tasks'] = array_values($d['tasks']); return $d; },
    'a note with a field v1 never wrote' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['listId'] = 'alex'; return $d; },
    'a note without text' => function (array $d) use ($noteKey) { unset($d['notes'][$noteKey]['text']); return $d; },
    'a note of a day scope' => function (array $d) { $d['notes']['day:2026-10-30'] = ['key' => 'day:2026-10-30', 'scope' => 'day', 'period' => '2026-10-30', 'text' => 'x', 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => 'x']; return $d; },
    'a week note not on a Monday' => function (array $d) { $d['notes']['week:2026-10-27'] = ['key' => 'week:2026-10-27', 'scope' => 'week', 'period' => '2026-10-27', 'text' => 'x', 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => 'x']; return $d; },
    'a note whose key differs from its fields' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['period'] = '2026-11-02'; return $d; },
    'a note with revision zero' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['revision'] = 0; return $d; },
    'a note by a stranger' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['updatedBy'] = 'outsider'; return $d; },
    'a note whose text is not text' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['text'] = 5; return $d; },
    'notes stored as text' => function (array $d) { $d['notes'] = 'x'; return $d; },
    'a field v1 never wrote at the top' => function (array $d) { $d['lists'] = []; return $d; },
    'a negative revision' => function (array $d) { $d['revision'] = -1; return $d; },
    'a revision that is text' => function (array $d) { $d['revision'] = '18'; return $d; },
];
harness_log(true);
foreach ($faulty as $label => $break) {
    $bad = $break($raw);
    foreach ([fn() => snapshot($bad, 'alex'), fn() => mutate($bad, $addTodo(60), 'sam'), fn() => validate_db(Invariants::load($bad))] as $via) {
        try { $via(); } catch (PlanMind\RequestError $e) { throw new RuntimeException("$label: a stored fault was answered as a client error"); }
        catch (RuntimeException $e) { check(str_starts_with($e->getMessage(), 'Invalid planner data'), "$label: unexpected failure {$e->getMessage()}"); continue; }
        throw new RuntimeException("$label: a faulty v1 store was converted");
    }
}
check(substr_count(harness_log(true), 'PlanMind storage rejected: ') >= count($faulty) * 3, 'error_log names the cause of each refusal');
// The same through the store: a v1 file that decrypts but is not a v1 store is refused, left alone and not backed up.
$v1 = new PlanMindV1\Store($dir);
$wrong = $faulty['a task whose person is not one of three']($raw);
$v1->transaction('tasks', fn() => $wrong);
$wrongBytes = $bytes($dir);
fails(fn() => $store->transaction('tasks', fn($db) => mutate($db, $addTodo(60), 'sam')), 'Invalid planner data');
fails(fn() => snapshot($store->transaction('tasks', fn($db) => $db), 'sam'), 'Invalid planner data');
check($bytes($dir) === $wrongBytes && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc'], 'a v1 file in the wrong shape is never converted, rewritten or backed up');

// ---- 9. An empty v1 store is just a fresh one: nothing to convert, nothing to keep ----
[, $dir] = harness_store();
$v1 = new PlanMindV1\Store($dir);
$v1->transaction('tasks', fn() => ['revision' => 5, 'tasks' => [], 'notes' => []]);
$store = new Store($dir);
$first = $store->transaction('tasks', fn($db) => mutate($db, $addTodo(60), 'sam'));
check($first['v'] === PlanMind\MODEL['storeVersion'] && $first['revision'] === 6 && count($first['tasks']) === 1 && $listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.version'], 'an empty v1 store becomes the current version at revision + 1 with no backup');

// ---- 10. Six processes make the first write at the same moment ----
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
    [$dir, $raw, $original] = $buildV1();
    harness_workers($worker, $dir, 6, 'mutate');
    $store = new Store($dir);
    $final = $store->transaction('tasks', fn($db) => $db);
    $titles = array_column($final['tasks'], 'title');
    sort($titles);
    check(count(array_intersect($titles, ['Racer 1', 'Racer 2', 'Racer 3', 'Racer 4', 'Racer 5', 'Racer 6'])) === 6 && count($final['tasks']) === 20 + 6, "round $round: all six writes and all twenty v1 tasks are there");
    check($final['v'] === PlanMind\MODEL['storeVersion'] && $final['revision'] === $raw['revision'] + 6, "round $round: six writes, six revisions on top of the v1 revision, got {$final['revision']}");
    check(array_intersect_key($final['tasks'], $raw['tasks']) === Invariants::load($raw)['tasks'] && $final['notes'] === Invariants::load($raw)['notes'],
        "round $round: converted exactly once: every v1 task and note is as the read showed it, no note duplicated");
    check($bytes($dir, 'tasks.v1.enc.bak') === $original, "round $round: the backup is the untouched original");
    check($listing($dir) === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.v1.enc.bak', 'tasks.version'], "round $round: no partial or extra files");
    validate_db($final);
}
