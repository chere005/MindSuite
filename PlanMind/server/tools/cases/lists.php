<?php
declare(strict_types=1);
// Lists and the Both color: create (idempotent), names, colors, the 12-list cap, rename and recolor, the permanent
// lists, delete with its cascade, and settings. Cases 10 and 13 of the server test plan.
use PlanMind\RequestError;
use function PlanMind\{fingerprint, fresh_db, mutate, snapshot, validate_db};

$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$save = fn(array $db, array $fields, string $user = 'alex') => mutate($db, ['action' => 'saveList'] + $fields, $user);
$create = fn(array $db, mixed $id, mixed $name, string $color = 'teal', string $user = 'alex') =>
    mutate($db, ['action' => 'saveList', 'id' => $id, 'name' => $name, 'color' => $color, 'revision' => 0], $user);
$delete = fn(array $db, string $id, int $revision, string $user = 'alex') => mutate($db, ['action' => 'deleteList', 'id' => $id, 'revision' => $revision, 'confirm' => true], $user);
$setBoth = fn(array $db, mixed $color, mixed $revision, string $user = 'alex') => mutate($db, ['action' => 'saveSettings', 'bothColor' => $color, 'revision' => $revision], $user);
$without = fn(array $db, string ...$keys) => array_diff_key($db, array_flip($keys));

// ---- 1. Create ----
$base = harness_db();
$hobbies = harness_id(101);
$a = $create($base, $hobbies, '  Hobbies  ');
$list = $a['lists'][$hobbies];
check($a['revision'] === 8, 'creating a list is one revision');
check($list['id'] === $hobbies && $list['kind'] === 'custom' && $list['name'] === 'Hobbies' && $list['color'] === 'teal' && $list['revision'] === 1, 'the new list is stored trimmed, custom, revision 1');
check($list['order'] === 3 && $list['createdBy'] === 'alex' && preg_match('/^[a-f0-9]{16}$/D', $list['ak']) === 1 && is_string($list['updatedAt']), 'order is max + 1; author, ak and time are server owned');
$keys = array_keys($list); sort($keys);
check($keys === ['ak', 'color', 'createdBy', 'id', 'kind', 'name', 'order', 'revision', 'updatedAt'], 'a list holds exactly the model fields');
check($without($a['lists'], $hobbies) === $base['lists'] && $without($a, 'lists', 'revision') === $without($base, 'lists', 'revision'), 'nothing else changes');
check(array_column(snapshot($a, 'sam')['lists'], 'id') === ['sam', 'alex', HARNESS_CUSTOM, $hobbies], 'the other person sees it after Sam, Alex and the older list');
$first = $create(fresh_db(), $hobbies, 'First');
check($first['lists'][$hobbies]['order'] === 2 && $first['lists'][$hobbies]['createdBy'] === 'alex', 'the first custom list is order 2, after Sam and Alex');
$gap = harness_db(); $gap['lists'][HARNESS_CUSTOM]['order'] = 9;
check($create($gap, $hobbies, 'Next')['lists'][$hobbies]['order'] === 10, 'order is the highest order plus one');
$forged = $save($base, ['id' => $hobbies, 'name' => 'Forged', 'color' => 'red', 'revision' => 0, 'kind' => 'person', 'order' => 0, 'ak' => '0000000000000000', 'createdBy' => 'sam'], 'alex');
check($forged['lists'][$hobbies]['kind'] === 'custom' && $forged['lists'][$hobbies]['order'] === 3 && $forged['lists'][$hobbies]['createdBy'] === 'alex'
    && $forged['lists'][$hobbies]['ak'] === fingerprint(['kind' => 'list', 'name' => 'Forged']), 'a client cannot set kind, order, ak or author');
foreach (PlanMind\MODEL['colorKeys'] as $color) { check($create($base, $hobbies, 'Hobbies', $color)['lists'][$hobbies]['color'] === $color, "color $color accepted"); }

// ---- 2. A create retried after a lost response ----
check($create($a, $hobbies, 'Hobbies') === $a && $create($a, $hobbies, '  Hobbies ') === $a, 'the same person retrying the same create changes nothing');
$edited = $save($a, ['id' => $hobbies, 'name' => 'Pastimes', 'color' => 'red', 'revision' => 1], 'sam');
check($create($edited, $hobbies, 'Hobbies') === $edited, 'a retry after the list was renamed is still a no-op');
refuses(fn() => $create($a, $hobbies, 'Hobbies', 'teal', 'sam'), 409, 'id_in_use');
$bySam = $create($base, $hobbies, 'Hobbies', 'teal', 'sam');
check($bySam['lists'][$hobbies]['createdBy'] === 'sam' && $create($bySam, $hobbies, 'Hobbies', 'teal', 'sam') === $bySam, 'a list is signed by whoever made it, and only they can retry it');
refuses(fn() => $create($bySam, $hobbies, 'Hobbies', 'teal', 'alex'), 409, 'id_in_use');
refuses(fn() => $create($a, $hobbies, 'Other name'), 409, 'id_in_use');
refuses(fn() => $create($a, $hobbies, 'hobbies'), 409, 'id_in_use');
refuses(fn() => $create($base, HARNESS_CUSTOM, 'Pack'), 409, 'id_in_use');
check($create($base, HARNESS_CUSTOM, 'Camping', 'blue') === $base, 'the fixture list is a retry of its own create (same person, same name)');
refuses(fn() => $create($base, HARNESS_CUSTOM, 'Camping', 'blue', 'sam'), 409, 'id_in_use');
refuses(fn() => $save($a, ['id' => $hobbies, 'color' => 'red', 'revision' => 0]), 400, 'invalid');
$full = harness_db();
for ($i = 0; $i < 11; ++$i) { $full = $create($full, harness_id(200 + $i), "List $i"); }
check($create($full, harness_id(210), 'List 10') === $full, 'a retried create does not fail the cap it already counts in');

// ---- 3. Names ----
foreach (['Camping', 'camping', 'CAMPING', ' Camping ', 'sam', 'Sam', 'SAM', 'alex', 'ALEX', 'Both', 'both', 'ALL', 'all'] as $name) {
    refuses(fn() => $create($base, $hobbies, $name), 409, 'name_taken');
}
$school = $create($base, harness_id(102), 'École');
refuses(fn() => $create($school, harness_id(103), 'école'), 409, 'name_taken');
refuses(fn() => $create($school, harness_id(103), 'ÉCOLE'), 409, 'name_taken');
check($caught(fn() => $create($base, $hobbies, 'camping'))->getMessage() === 'A list with that name already exists.', 'the duplicate message');
foreach (['', '   ', "\u{a0}", "a\nb", "a\0b", "tab\there", "\xff\xfe", 5, null, ['Camp']] as $name) { refuses(fn() => $create($base, $hobbies, $name), 400, 'invalid'); }
foreach ([str_repeat('n', 25), str_repeat('😀', 25), str_repeat("e\u{301}", 13)] as $name) { refuses(fn() => $create($base, $hobbies, $name), 400, 'text_too_long'); }
foreach ([str_repeat('n', 24), str_repeat('😀', 24), str_repeat("e\u{301}", 12)] as $name) { check($create($base, $hobbies, $name)['lists'][$hobbies]['name'] === $name, 'a name of 24 code points fits'); }
refuses(fn() => $save($base, ['id' => $hobbies, 'color' => 'teal', 'revision' => 0]), 400, 'invalid');
foreach (['chartreuse', '', 'BLUE', null, 5, ['blue']] as $color) {
    refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => $hobbies, 'name' => 'Hobbies', 'color' => $color, 'revision' => 0], 'alex'), 400, 'invalid');
    refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => 'sam', 'color' => $color, 'revision' => 1], 'alex'), 400, 'invalid');
    refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => HARNESS_CUSTOM, 'color' => $color, 'revision' => 1], 'alex'), 400, 'invalid');
    refuses(fn() => mutate($base, ['action' => 'saveSettings', 'bothColor' => $color, 'revision' => 1], 'alex'), 400, 'invalid');
}
refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => $hobbies, 'name' => 'Hobbies', 'revision' => 0], 'alex'), 400, 'invalid');
foreach (['both', 'all', '', 'xyz', 'Sam', 'SAM', 'alex ', 5, null, ['sam'], harness_id(1) . 'x', strtoupper(HARNESS_CUSTOM)] as $id) {
    refuses(fn() => $create($base, $id, 'Hobbies'), 400, 'invalid');
}
refuses(fn() => mutate($base, ['action' => 'saveList', 'name' => 'Hobbies', 'color' => 'teal', 'revision' => 0], 'alex'), 400, 'invalid');
foreach (['0', 0.5, -1, null, true, [0]] as $revision) {
    refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => $hobbies, 'name' => 'Hobbies', 'color' => 'teal', 'revision' => $revision], 'alex'), 400, 'invalid');
}
refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => $hobbies, 'name' => 'Hobbies', 'color' => 'teal'], 'alex'), 400, 'invalid');
refuses(fn() => mutate($base, ['action' => 'saveList', 'id' => HARNESS_OTHER, 'name' => 'Hobbies', 'color' => 'teal', 'revision' => 3], 'alex'), 409, 'gone');

// ---- 4. At most twelve custom lists ----
check(count($full['lists']) === 14, 'the fixture holds twelve custom lists');
$e = $caught(fn() => $create($full, harness_id(299), 'One too many'));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'customListsMax', 'the 13th list is a limit error naming its cap');
check($e->body()['cap'] === 'customListsMax' && $e->body()['code'] === 'limit', 'the cap reaches the response body');
$one = $save($full, ['id' => harness_id(200), 'name' => 'Renamed', 'color' => 'red', 'revision' => 1]);
check($one['lists'][harness_id(200)]['name'] === 'Renamed', 'renaming still works at the cap');
$room = $delete($full, harness_id(205), 1);
check($create($room, harness_id(299), 'One too many')['lists'][harness_id(299)]['order'] === 14, 'deleting one makes room again');

// ---- 5. Sam and Alex: the color is the only thing to change ----
$blue = $save($base, ['id' => 'sam', 'color' => 'blue', 'revision' => 1], 'alex');
check($blue['revision'] === 8 && $blue['lists']['sam']['color'] === 'blue' && $blue['lists']['sam']['revision'] === 2 && $blue['lists']['sam']['name'] === 'Sam'
    && $blue['lists']['sam']['kind'] === 'person' && $blue['lists']['sam']['order'] === 0 && $blue['lists']['alex'] === $base['lists']['alex'], 'either person can recolor a permanent list');
check(snapshot($blue, 'sam')['lists'][0]['color'] === 'blue', 'the new color reaches the snapshot');
check($save($blue, ['id' => 'sam', 'name' => 'Sam', 'color' => 'green', 'revision' => 2], 'sam')['lists']['sam']['color'] === 'green', 'the fixed name may be sent along');
check($save($base, ['id' => 'sam', 'color' => 'green', 'revision' => 1])['lists']['sam']['color'] === 'green', 'two lists may share a color');
check($save($base, ['id' => 'alex', 'color' => 'green', 'revision' => 1]) === $base && $save($blue, ['id' => 'sam', 'color' => 'blue', 'revision' => 2]) === $blue, 'saving the color it already has writes nothing');
foreach (['Mom', 'sam', 'SAM', ' Sam', 'Sam ', '', 5] as $name) { refuses(fn() => $save($base, ['id' => 'sam', 'name' => $name, 'color' => 'blue', 'revision' => 1]), 400, 'invalid'); }
refuses(fn() => $save($base, ['id' => 'alex', 'name' => 'Sam', 'color' => 'blue', 'revision' => 1]), 400, 'invalid');
foreach ([0, 2, 9] as $revision) { refuses(fn() => $save($base, ['id' => 'sam', 'color' => 'blue', 'revision' => $revision]), 409, 'stale'); }
refuses(fn() => $save($blue, ['id' => 'sam', 'color' => 'red', 'revision' => 1]), 409, 'stale');
foreach (['sam', 'alex', 'both', 'all', 'Sam'] as $id) {
    refuses(fn() => $delete($base, $id, 1), 400, 'invalid');
    refuses(fn() => mutate($base, ['action' => 'deleteList', 'id' => $id, 'revision' => 1, 'confirm' => true], 'sam'), 400, 'invalid');
}
validate_db($blue);

// ---- 6. Rename and recolor a custom list ----
$trips = $save($base, ['id' => HARNESS_CUSTOM, 'name' => 'Trips', 'color' => 'red', 'revision' => 1], 'sam');
$l = $trips['lists'][HARNESS_CUSTOM];
check($trips['revision'] === 8 && $l['name'] === 'Trips' && $l['color'] === 'red' && $l['revision'] === 2 && $l['createdBy'] === 'alex'
    && $l['ak'] === $base['lists'][HARNESS_CUSTOM]['ak'] && $l['order'] === 2 && $l['id'] === HARNESS_CUSTOM, 'rename and recolor in one write keep the creation facts');
check(array_keys($l) === array_keys($base['lists'][HARNESS_CUSTOM]), 'the record keeps its field order');
check($save($base, ['id' => HARNESS_CUSTOM, 'color' => 'red', 'revision' => 1])['lists'][HARNESS_CUSTOM]['name'] === 'Camping', 'leaving the name out keeps it');
check($save($base, ['id' => HARNESS_CUSTOM, 'name' => ' CAMPING ', 'color' => 'blue', 'revision' => 1])['lists'][HARNESS_CUSTOM]['name'] === 'CAMPING', 'a list may change only the case of its own name');
check($save($base, ['id' => HARNESS_CUSTOM, 'name' => 'Camping', 'color' => 'blue', 'revision' => 1]) === $base, 'saving what is stored writes nothing');
refuses(fn() => $save($trips, ['id' => HARNESS_CUSTOM, 'name' => 'Again', 'color' => 'red', 'revision' => 1]), 409, 'stale');
refuses(fn() => $save($trips, ['id' => HARNESS_CUSTOM, 'name' => 'Again', 'color' => 'red', 'revision' => 3]), 409, 'stale');
check($caught(fn() => $save($trips, ['id' => HARNESS_CUSTOM, 'color' => 'red', 'revision' => 1]))->getMessage() === 'This list changed on another device. Refresh to see the latest.', 'the stale message');
$two = $create($base, $hobbies, 'Hobbies');
foreach (['Hobbies', 'hobbies', 'Sam', 'ALEX', 'both', 'All'] as $name) { refuses(fn() => $save($two, ['id' => HARNESS_CUSTOM, 'name' => $name, 'color' => 'blue', 'revision' => 1]), 409, 'name_taken'); }
refuses(fn() => $save($base, ['id' => HARNESS_CUSTOM, 'name' => str_repeat('n', 25), 'color' => 'blue', 'revision' => 1]), 400, 'text_too_long');
foreach (['', '  ', 7, "a\nb"] as $name) { refuses(fn() => $save($base, ['id' => HARNESS_CUSTOM, 'name' => $name, 'color' => 'blue', 'revision' => 1]), 400, 'invalid'); }
refuses(fn() => $save($base, ['id' => HARNESS_OTHER, 'name' => 'Ghost', 'color' => 'blue', 'revision' => 1]), 409, 'gone');

// ---- 7. Delete a list and everything that belongs to it alone ----
$garden = harness_id(401);
$world = $create(harness_db(), $garden, 'Garden', 'orange');
$put = function (array $db, string $collection, int $n, array $record) { $db[$collection][harness_id($n)] = harness_stamp(['id' => harness_id($n)] + $record); return $db; };
$todo = fn(array $owners, string $scope = 'day', string $date = '2026-10-30') => ['scope' => $scope, 'date' => $date, 'owners' => $owners, 'title' => 'T', 'done' => false, 'pos' => 1024];
$line = fn(array $slots) => ['date' => '2026-10-30', 'owners' => array_keys($slots), 'slots' => $slots, 'text' => 'P'];
$event = fn(array $owners, int $start) => ['date' => '2026-10-30', 'owners' => $owners, 'text' => 'E', 'start' => $start, 'length' => 30];
foreach ([[10, 'tasks', $todo([HARNESS_CUSTOM])], [11, 'tasks', $todo([HARNESS_CUSTOM], 'week', '2026-10-26')], [12, 'tasks', $todo([HARNESS_CUSTOM], 'month', '2026-10-01')],
    [13, 'priorities', $line([HARNESS_CUSTOM => 1])], [14, 'events', $event([HARNESS_CUSTOM], 540)],
    [20, 'tasks', $todo([$garden])], [21, 'priorities', $line([$garden => 1])], [22, 'events', $event([$garden], 540)],
    [23, 'tasks', $todo(['alex'])], [24, 'tasks', $todo(['alex', 'sam'], 'week', '2026-10-26')], [25, 'priorities', $line(['alex' => 1])], [26, 'priorities', $line(['alex' => 1, 'sam' => 1])],
    [27, 'events', $event(['alex', 'sam'], 600)], [28, 'events', $event(['sam'], 600)]] as [$n, $collection, $record]) { $world = $put($world, $collection, $n, $record); }
$noteRow = fn(string $scope, string $period, string $listId, string $field) => ["$scope:$period:$listId:$field" =>
    ['key' => "$scope:$period:$listId:$field", 'scope' => $scope, 'period' => $period, 'listId' => $listId, 'field' => $field, 'text' => "$listId $scope $field", 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => 'x']];
$world['notes'] += $noteRow('day', '2026-10-30', HARNESS_CUSTOM, 'notes') + $noteRow('week', '2026-10-26', HARNESS_CUSTOM, 'priorities')
    + $noteRow('month', '2026-10-01', HARNESS_CUSTOM, 'priorities') + $noteRow('month', '2026-10-01', HARNESS_CUSTOM, 'notes')
    + $noteRow('week', '2026-11-02', HARNESS_CUSTOM, 'priorities') + $noteRow('week', '2026-10-26', $garden, 'priorities') + $noteRow('day', '2026-10-30', 'sam', 'notes')
    + $noteRow('month', '2026-10-01', 'alex', 'notes');
$world['prefs']['alex'] = ['selection' => ['base' => HARNESS_CUSTOM, 'overlays' => [$garden]]];
$world['prefs']['sam'] = ['selection' => ['base' => 'sam', 'overlays' => [HARNESS_CUSTOM, $garden]]];
validate_db($world);
check($world['revision'] === 8 && count($world['notes']) === 9 && count($world['lists']) === 4, 'the world before the delete');

$after = $delete($world, HARNESS_CUSTOM, 1, 'sam');
validate_db($after);
check($after['revision'] === 9, 'the whole cascade is one revision');
check(array_keys($after['lists']) === ['sam', 'alex', $garden] && $after['lists']['sam'] === $world['lists']['sam'] && $after['lists'][$garden] === $world['lists'][$garden], 'only that list leaves the lists');
check(array_map('strval', array_keys($after['tasks'])) === array_map('harness_id', [1, 2, 20, 23, 24]), 'its to-dos of every scope are gone, everyone else\'s stay: ' . implode(',', array_keys($after['tasks'])));
check(array_map('strval', array_keys($after['priorities'])) === array_map('harness_id', [3, 21, 25, 26]), 'its priority lines are gone; the linked ones stay');
check(array_map('strval', array_keys($after['events'])) === array_map('harness_id', [22, 27, 28]), 'its events are gone; the linked one stays');
check(array_keys($after['notes']) === ["week:2026-10-26:alex:priorities", "week:2026-10-26:$garden:priorities", 'day:2026-10-30:sam:notes', 'month:2026-10-01:alex:notes'], 'all of its notes are gone: ' . implode(',', array_keys($after['notes'])));
check($after['prefs']['alex']['selection'] === ['base' => 'both', 'overlays' => [$garden]], 'a deleted base falls back to Both and keeps the other overlay');
check($after['prefs']['sam']['selection'] === ['base' => 'sam', 'overlays' => [$garden]], 'a deleted overlay leaves the picker of the other person too');
check($after['tasks'][harness_id(1)] === $world['tasks'][harness_id(1)] && $after['priorities'][harness_id(3)] === $world['priorities'][harness_id(3)]
    && $after['tasks'][harness_id(1)]['revision'] === 1, 'linked items are untouched, revision included');
check($after['settings'] === $world['settings'] && !str_contains(json_encode($after), HARNESS_CUSTOM), 'nothing refers to the deleted list any more');
check(snapshot($after, 'alex')['prefs']['selection'] === ['base' => 'both', 'overlays' => [$garden]], 'the snapshot of the caller shows the cleaned selection');
check(snapshot($after, 'sam')['lists'] === array_values($after['lists']), 'and the lists');
refuses(fn() => $delete($after, HARNESS_CUSTOM, 1), 409, 'gone');
check($create($after, HARNESS_CUSTOM, 'Trips', 'blue', 'sam')['lists'][HARNESS_CUSTOM]['name'] === 'Trips', 'no tombstones: a deleted id can be created again');
$gardenOnly = $delete($after, $garden, 1);
check($gardenOnly['lists'] === ['sam' => $world['lists']['sam'], 'alex' => $world['lists']['alex']] && $gardenOnly['tasks'] === array_diff_key($after['tasks'], [harness_id(20) => 1]), 'the next delete takes only its own');
check($gardenOnly['prefs']['alex']['selection'] === ['base' => 'both', 'overlays' => []] && $gardenOnly['revision'] === 10, 'prefs end empty, one revision per delete');
check($create($gardenOnly, harness_id(402), 'Camping')['lists'][harness_id(402)]['order'] === 2, 'a deleted list\'s name and order are free again');
$bare = $delete($create(fresh_db(), $hobbies, 'Bare'), $hobbies, 1);
check(array_keys($bare['lists']) === ['sam', 'alex'] && $bare['revision'] === 2, 'a list without items is just removed');

// ---- 8. Delete needs confirm, a real id and the current revision ----
foreach ([null, false, 'true', 1, 'yes', 0, []] as $confirm) {
    refuses(fn() => mutate($world, ['action' => 'deleteList', 'id' => HARNESS_CUSTOM, 'revision' => 1, 'confirm' => $confirm], 'alex'), 400, 'invalid');
}
refuses(fn() => mutate($world, ['action' => 'deleteList', 'id' => HARNESS_CUSTOM, 'revision' => 1], 'alex'), 400, 'invalid');
foreach ([null, 5, '', 'xyz', ['sam']] as $id) { refuses(fn() => mutate($world, ['action' => 'deleteList', 'id' => $id, 'revision' => 1, 'confirm' => true], 'alex'), 400, 'invalid'); }
refuses(fn() => mutate($world, ['action' => 'deleteList', 'id' => HARNESS_CUSTOM, 'confirm' => true], 'alex'), 400, 'invalid');
refuses(fn() => $delete($world, HARNESS_OTHER, 1), 409, 'gone');
$renamed = $save($world, ['id' => HARNESS_CUSTOM, 'name' => 'Trips', 'color' => 'blue', 'revision' => 1]);
foreach ([1, 0, 3] as $revision) { refuses(fn() => $delete($renamed, HARNESS_CUSTOM, $revision), 409, 'stale'); }
check(isset($delete($renamed, HARNESS_CUSTOM, 2)['lists']) && !isset($delete($renamed, HARNESS_CUSTOM, 2)['lists'][HARNESS_CUSTOM]), 'the current revision deletes');

// ---- 9. Through the encrypted file ----
[$store, $dir] = harness_store();
$run = fn(callable $change) => $store->transaction('tasks', fn($db) => $change($db));
$run(fn($db) => $create($db, $hobbies, 'Hobbies'));
$run(fn($db) => mutate($db, ['action' => 'saveNote', 'scope' => 'week', 'period' => '2026-10-26', 'listId' => $hobbies, 'field' => 'priorities', 'text' => 'Climb', 'revision' => 0], 'sam'));
$run(fn($db) => mutate($db, ['action' => 'savePrefs', 'selection' => ['base' => $hobbies, 'overlays' => []]], 'alex'));
$kept = snapshot($run(fn($db) => $db), 'alex');
check($kept['revision'] === 2 && $kept['notes'][0]['text'] === 'Climb' && $kept['prefs']['selection']['base'] === $hobbies && $kept['lists'][2]['name'] === 'Hobbies', 'create, note and prefs survive the file');
$gone = snapshot($run(fn($db) => $delete($db, $hobbies, 1)), 'alex');
check($gone['revision'] === 3 && $gone['notes'] === [] && count($gone['lists']) === 2 && $gone['prefs']['selection'] === ['base' => 'both', 'overlays' => []], 'the delete reaches the file as one write');
check(snapshot($run(fn($db) => $db), 'sam') === $gone, 'and reads back identically');

// ---- 10. Settings: the Both color ----
$red = $setBoth($base, 'red', 1, 'sam');
check($red['revision'] === 8 && $red['settings']['bothColor'] === 'red' && $red['settings']['revision'] === 2 && is_string($red['settings']['updatedAt']), 'the Both color is one revision');
check(array_keys($red['settings']) === ['bothColor', 'revision', 'updatedAt'] && $without($red, 'settings', 'revision') === $without($base, 'settings', 'revision'), 'only the settings change');
check(snapshot($red, 'alex')['settings']['bothColor'] === 'red' && snapshot($red, 'sam')['settings']['bothColor'] === 'red', 'both people see the same Both color');
check($setBoth($base, 'purple', 1) === $base && $setBoth($red, 'red', 2) === $red, 'saving the color it already has writes nothing');
foreach (PlanMind\MODEL['colorKeys'] as $color) { check($setBoth($base, $color, 1)['settings']['bothColor'] === $color, "Both color $color accepted"); }
foreach ([0, 2, 9] as $revision) { refuses(fn() => $setBoth($base, 'red', $revision), 409, 'stale'); }
refuses(fn() => $setBoth($red, 'blue', 1), 409, 'stale');
check($setBoth($red, 'blue', 2)['settings']['revision'] === 3, 'the next save moves on from the new revision');
foreach (['chartreuse', 'Red', '', null, 5] as $color) { refuses(fn() => $setBoth($base, $color, 1), 400, 'invalid'); }
foreach (['1', 1.5, -1, null, true] as $revision) { refuses(fn() => mutate($base, ['action' => 'saveSettings', 'bothColor' => 'red', 'revision' => $revision], 'alex'), 400, 'invalid'); }
refuses(fn() => mutate($base, ['action' => 'saveSettings', 'revision' => 1], 'alex'), 400, 'invalid');
refuses(fn() => mutate($base, ['action' => 'saveSettings', 'bothColor' => 'red'], 'alex'), 400, 'invalid');
