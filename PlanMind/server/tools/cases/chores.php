<?php
declare(strict_types=1);
// The chore chart: the v2 conversion that seeds the 21 rules and the rhythm, saveChore, deleteChore (and its cascade), markChore
// (upsert or delete one mark), saveRhythm, the fail-closed table for stored chores, and the caps. The v2 fixture is server/tools/fixtures/v2-store.json:
// a store written by the 0.12.0 code itself (replayed through its mutate(), then given fixed stamps), never by hand.
use PlanMind\Invariants;
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, snapshot, validate_db};

ini_set('memory_limit', '512M');

$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$send = fn(array $db, array $input, string $user = 'alex') => mutate($db, $input, $user);
$rid = fn(int $n) => sprintf('c0de0000-0000-4000-8000-%012x', $n);
$daily = ['kind' => 'daily'];
$weekly = fn(int $day, string $weeks = 'every') => ['kind' => 'weekly', 'day' => $day, 'weeks' => $weeks];
$monthly = fn(int $nth, int $day, string $months = 'every') => ['kind' => 'monthly', 'nth' => $nth, 'day' => $day, 'months' => $months];
$save = fn(array $db, array $fields, string $user = 'alex') => mutate($db, ['action' => 'saveChore'] + $fields, $user);
$mark = fn(array $db, array $fields, string $user = 'alex') => mutate($db, ['action' => 'markChore'] + $fields + ['moved' => false, 'revision' => 0], $user);
$without = fn(array $db, string ...$keys) => array_diff_key($db, array_flip($keys));
$v2 = json_decode((string)file_get_contents(__DIR__ . '/../fixtures/v2-store.json'), true, 64, JSON_THROW_ON_ERROR);

// ---- 1. The 21 rules, exactly as Alex's chart (A = Sam, S = Alex, AS = both) ----
[$A, $S, $AS] = [['sam'], ['alex'], ['alex', 'sam']];
$expected = [
    [$S, 'Dishes', $daily], [$A, 'Trash & recycling', $daily], [$S, 'Wipe the table', $daily],
    [$A, 'Cat bowls', $weekly(1)], [$A, 'Clutter reset', $weekly(1)], [$AS, 'Mail & papers', $weekly(2)], [$A, 'Fridge clean-out', $weekly(3)], [$A, 'Bins to the curb', $weekly(3)],
    [$A, 'Cat bowls', $weekly(4)], [$A, 'Fresh litter + liner', $weekly(4)], [$A, 'Laundry', $weekly(0)], [$S, 'Vacuum', $weekly(0)],
    [$S, 'Kitchen wipe-down', $weekly(3, 'A')], [$A, 'Kitchen towels', $weekly(0, 'A')], [$A, 'Bedding', $weekly(0, 'A')], [$A, 'Couch blankets', $weekly(0, 'A')], [$S, 'Bathroom wipe-down', $weekly(3, 'B')],
    [$A, 'Dust, then vacuum', $monthly(1, 0)], [$A, 'Litter box deep clean', $monthly(2, 4)], [$A, 'Vacuum, then mop', $monthly(3, 0)], [$S, 'Furnace filter', $monthly(1, 1, 'odd')],
];
$seeded = function (array $db) use ($expected, $rid): bool {
    $rules = array_values($db['chores']);
    usort($rules, fn($a, $b) => $a['order'] <=> $b['order']);
    if (count($rules) !== 21 || array_keys($db['chores']) !== array_map($rid, range(1, 21))) { return false; }
    foreach ($expected as $i => [$owners, $title, $cadence]) {
        $r = $rules[$i];
        if ($r['id'] !== $rid($i + 1) || $r['title'] !== $title || $r['owners'] !== $owners || $r['cadence'] !== $cadence || $r['order'] !== $i + 1
            || $r['revision'] !== 1 || $r['updatedBy'] !== 'alex' || !is_string($r['updatedAt'])) { return false; }
    }
    return true;
};
$fresh = fresh_db('2026-11-02T08:00:00+00:00');
check($seeded($fresh) && $fresh['choreMarks'] === [] && $fresh['v'] === PlanMind\MODEL['storeVersion'], 'a fresh store seeds exactly the 21 rules, in order, with their owners and cadences');
check($fresh['rhythm'] === ['anchor' => '2026-11-02', 'start' => '2026-11-02', 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => '2026-11-02T08:00:00+00:00'], 'and the rhythm: Week A starts Monday 2 November 2026, the first day');
check(array_keys(fresh_db()['chores']) === array_keys($fresh['chores']), 'the seeded ids are fixed: they do not depend on the clock');
validate_db($fresh);

// ---- 2. v2 -> current: a read converts in memory, the first write stores it ----
check($v2['v'] === 2 && !isset($v2['chores']) && count($v2['tasks']) === 5 && $v2['revision'] === 12, 'the fixture is a v2 store written by 0.12.0');
$db = Invariants::load($v2);
validate_db($db);
check($db['v'] === PlanMind\MODEL['storeVersion'] && $seeded($db) && $db['choreMarks'] === [] && $db['revision'] === 12, 'a v2 store reads as the current version with the seeded chart and its own revision');
check($without($db, 'v', 'chores', 'choreMarks', 'rhythm') === $without($v2, 'v'), 'and nothing else about it changes: lists, settings, to-dos, priorities, events, notes and picker state are as they were');
check($db['rhythm'] === ['anchor' => '2026-11-02', 'start' => '2026-11-02', 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => $v2['settings']['updatedAt']]
    && array_unique(array_column($db['chores'], 'updatedAt')) === [$v2['settings']['updatedAt']], 'stamped from the data, not the clock');
check(Invariants::load($v2) === $db, 'converting again gives the identical db');
$s = snapshot($v2, 'sam');
check($s['v'] === PlanMind\MODEL['storeVersion'] && $s['revision'] === 12 && count($s['chores']) === 21 && $s['choreMarks'] === [] && $s['rhythm'] === $db['rhythm'] && array_column($s['chores'], 'order') === range(1, 21), 'the snapshot carries the chart, rules by order');
check(array_diff_key(snapshot($v2, 'alex'), ['prefs' => 1]) === array_diff_key($s, ['prefs' => 1]), 'Sam and Alex see the same chart');
check($send($v2, ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]]]) === $v2, 'a request that changes nothing hands back the very v2 db, so nothing is rewritten');
$changed = $send($v2, ['action' => 'saveSettings', 'bothColor' => 'red', 'revision' => 2]);
check($changed['v'] === PlanMind\MODEL['storeVersion'] && $changed['revision'] === 13 && $seeded($changed), 'the first change returns the current db at revision + 1');

[$store, $dir] = harness_store();
$store->transaction('tasks', fn() => $v2);
$bytes = fn() => (string)file_get_contents($dir . '/tasks.enc');
$original = $bytes();
check(snapshot($store->transaction('tasks', fn($stored) => $stored), 'alex')['v'] === PlanMind\MODEL['storeVersion'] && $bytes() === $original, 'reading a stored v2 file does not rewrite it');
$written = $store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'markChore', 'ruleId' => $rid(1), 'date' => '2026-11-03', 'state' => 'done', 'moved' => false, 'revision' => 0], 'alex'));
$after = $store->transaction('tasks', fn($stored) => $stored);
check($bytes() !== $original && $after === $written && $after['v'] === PlanMind\MODEL['storeVersion'] && $after['revision'] === 13 && count($after['choreMarks']) === 1 && $seeded($after), 'the first write stores the current version (seeded chart plus the mark)');
check($without($after, 'v', 'revision', 'chores', 'choreMarks', 'rhythm') === $without($v2, 'v', 'revision', 'chores', 'choreMarks', 'rhythm'), 'with the v2 data intact');
foreach ([
    'an unknown field' => function (array $d) { $d['legacy'] = []; return $d; },
    'a missing collection' => function (array $d) { unset($d['events']); return $d; },
    'chores already there' => function (array $d) { $d['chores'] = []; return $d; },
    'settings without a time' => function (array $d) { unset($d['settings']['updatedAt']); return $d; },
    'a bad to-do' => function (array $d) { $d['tasks'][array_key_first($d['tasks'])]['owners'] = ['both']; return $d; },
    'a bad list' => function (array $d) { $d['lists']['sam']['name'] = 'Mom'; return $d; },
] as $label => $break) {
    fails(fn() => snapshot($break($v2), 'alex'), 'Invalid planner data');
    fails(fn() => mutate($break($v2), ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => []]], 'alex'), 'Invalid planner data');
}

// ---- 3. saveChore: create ----
$base = harness_db();
$new = harness_id(301);
$a = $save($base, ['id' => $new, 'title' => '  Water the plants ', 'owners' => ['sam', 'alex'], 'cadence' => $weekly(2, 'B'), 'revision' => 0], 'sam');
$rule = $a['chores'][$new];
check($a['revision'] === $base['revision'] + 1 && count($a['chores']) === 22, 'creating a rule is one revision');
check($rule === ['id' => $new, 'title' => 'Water the plants', 'owners' => ['alex', 'sam'], 'cadence' => $weekly(2, 'B'), 'order' => 22, 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => $rule['updatedAt']]
    && is_string($rule['updatedAt']), 'the rule is stored trimmed, with canonical owners, the next order, revision 1 and its author');
check(array_keys($rule) === ['id', 'title', 'owners', 'cadence', 'order', 'revision', 'updatedBy', 'updatedAt'], 'a rule holds exactly the model fields, in order');
check($without($a['chores'], $new) === $base['chores'] && $without($a, 'chores', 'revision') === $without($base, 'chores', 'revision'), 'nothing else changes');
check(array_column(snapshot($a, 'alex')['chores'], 'id')[21] === $new, 'the other person sees it last, after the 21 seeded rules');
$forged = $save($base, ['id' => $new, 'title' => 'X', 'owners' => ['alex'], 'cadence' => $daily, 'revision' => 0, 'order' => 0, 'updatedBy' => 'sam', 'ak' => 'y'], 'alex');
check($forged['chores'][$new]['order'] === 22 && $forged['chores'][$new]['updatedBy'] === 'alex' && !isset($forged['chores'][$new]['ak']), 'a client cannot set order, author or extra fields');
$empty = $base; $empty['chores'] = [];
check($save($empty, ['id' => $new, 'title' => 'First', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0])['chores'][$new]['order'] === 0, 'the first rule of an empty chart is order 0');
$gap = $base; $gap['chores'][$rid(21)]['order'] = 40;
check($save($gap, ['id' => $new, 'title' => 'Next', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0])['chores'][$new]['order'] === 41, 'order is the highest order plus one');
foreach ([[['sam'], ['sam']], [['alex'], ['alex']], [['alex', 'sam'], ['alex', 'sam']], [['sam', 'alex'], ['alex', 'sam']]] as [$in, $out]) {
    check($save($base, ['id' => $new, 'title' => 'T', 'owners' => $in, 'cadence' => $daily, 'revision' => 0])['chores'][$new]['owners'] === $out, 'owners ' . json_encode($in));
}
foreach ([$daily, $weekly(0), $weekly(5, 'A'), $weekly(3, 'B'), $monthly(1, 1), $monthly(-1, 5, 'even'), $monthly(4, 2, 'odd')] as $cadence) {
    check($save($base, ['id' => $new, 'title' => 'T', 'owners' => ['sam'], 'cadence' => $cadence, 'revision' => 0])['chores'][$new]['cadence'] === $cadence, 'cadence ' . json_encode($cadence));
}
check($save($base, ['id' => $new, 'title' => 'T', 'owners' => ['sam'], 'cadence' => ['weeks' => 'every', 'day' => 2, 'kind' => 'weekly'], 'revision' => 0])['chores'][$new]['cadence'] === $weekly(2),
    'a cadence is stored in its canonical key order');
check($save($base, ['id' => $new, 'title' => 'Cat bowls', 'owners' => ['sam'], 'cadence' => $weekly(1), 'revision' => 0])['chores'][$new]['title'] === 'Cat bowls', 'two rules may share a title (the chart has two Cat bowls)');

// ---- 4. saveChore: refusals ----
$good = ['id' => $new, 'title' => 'T', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0];
foreach (['', '   ', "a\nb", "a\0b", "\xff\xfe", 5, null, ['T'], "\u{a0}"] as $title) { refuses(fn() => $save($base, ['title' => $title] + $good), 400, 'invalid'); }
foreach ([str_repeat('t', 37), str_repeat('😀', 37), str_repeat("e\u{301}", 19)] as $title) { refuses(fn() => $save($base, ['title' => $title] + $good), 400, 'text_too_long'); }
foreach ([str_repeat('t', 36), str_repeat('😀', 36), str_repeat("e\u{301}", 18)] as $title) { check($save($base, ['title' => $title] + $good)['chores'][$new]['title'] === $title, 'a title of 36 code points fits'); }
foreach ([[], ['both'], ['all'], [HARNESS_CUSTOM], [HARNESS_CUSTOM, 'sam'], ['sam', 'sam'], ['sam', 'alex', 'alex'], 'sam', null, [1], ['sam', null], ['x' => 'sam'], [['sam']], [HARNESS_OTHER]] as $owners) {
    refuses(fn() => $save($base, ['owners' => $owners] + $good), 400, 'invalid');
}
$badCadence = [
    'saturday' => $weekly(6), 'day seven' => $weekly(7), 'negative day' => $weekly(-1), 'day as text' => ['kind' => 'weekly', 'day' => '1', 'weeks' => 'every'], 'day as float' => ['kind' => 'weekly', 'day' => 1.0, 'weeks' => 'every'],
    'weeks C' => ['kind' => 'weekly', 'day' => 1, 'weeks' => 'C'], 'weeks lowercase' => ['kind' => 'weekly', 'day' => 1, 'weeks' => 'a'], 'weeks missing' => ['kind' => 'weekly', 'day' => 1],
    'day missing' => ['kind' => 'weekly', 'weeks' => 'every'], 'weekly with nth' => ['kind' => 'weekly', 'day' => 1, 'weeks' => 'every', 'nth' => 1], 'daily with a day' => ['kind' => 'daily', 'day' => 1],
    'nth zero' => $monthly(0, 1), 'nth five' => $monthly(5, 1), 'nth minus two' => $monthly(-2, 1), 'monthly saturday' => $monthly(1, 6), 'months odd-ish' => ['kind' => 'monthly', 'nth' => 1, 'day' => 1, 'months' => 'all'],
    'monthly without months' => ['kind' => 'monthly', 'nth' => 1, 'day' => 1], 'nth as text' => ['kind' => 'monthly', 'nth' => '1', 'day' => 1, 'months' => 'every'],
    'unknown kind' => ['kind' => 'yearly'], 'kind missing' => ['day' => 1], 'kind as list' => ['kind' => ['daily']], 'a list' => ['daily'], 'an empty list' => [], 'text' => 'daily', 'null' => null, 'a number' => 5,
];
foreach ($badCadence as $label => $cadence) { refuses(fn() => $save($base, ['cadence' => $cadence] + $good), 400, 'invalid'); }
check(count($badCadence) >= 25, 'the cadence refusal table is populated');
foreach (['both', 'all', '', 'xyz', 'Sam', 5, null, ['sam'], strtoupper($new), $new . 'x'] as $id) { refuses(fn() => $save($base, ['id' => $id] + $good), 400, 'invalid'); }
refuses(fn() => mutate($base, ['action' => 'saveChore', 'title' => 'T', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0], 'alex'), 400, 'invalid');
foreach (['0', 0.5, -1, null, true, [0]] as $revision) { refuses(fn() => $save($base, ['revision' => $revision] + $good), 400, 'invalid'); }
refuses(fn() => mutate($base, ['action' => 'saveChore', 'id' => $new, 'title' => 'T', 'owners' => ['sam'], 'cadence' => $daily], 'alex'), 400, 'invalid');
// A malformed request is 400 before the store is consulted.
refuses(fn() => $save($base, ['id' => $rid(1), 'title' => ''] + $good), 400, 'invalid');

// ---- 5. saveChore: a retried create, edits, stale, gone ----
check($save($a, ['id' => $new, 'title' => 'Water the plants', 'owners' => ['alex', 'sam'], 'cadence' => $weekly(2, 'B'), 'revision' => 0], 'sam') === $a, 'the same person retrying the same create changes nothing');
refuses(fn() => $save($a, ['id' => $new, 'title' => 'Water the plants', 'owners' => ['alex', 'sam'], 'cadence' => $weekly(2, 'B'), 'revision' => 0], 'alex'), 409, 'id_in_use');
refuses(fn() => $save($a, ['id' => $new, 'title' => 'Other', 'owners' => ['alex', 'sam'], 'cadence' => $weekly(2, 'B'), 'revision' => 0], 'sam'), 409, 'id_in_use');
refuses(fn() => $save($a, ['id' => $new, 'title' => 'Water the plants', 'owners' => ['sam'], 'cadence' => $weekly(2, 'B'), 'revision' => 0], 'sam'), 409, 'id_in_use');
refuses(fn() => $save($base, ['id' => $rid(1), 'title' => 'Dishes', 'owners' => ['alex'], 'cadence' => $daily, 'revision' => 0], 'sam'), 409, 'id_in_use');
$edited = $save($a, ['id' => $new, 'title' => 'Water the ferns', 'owners' => ['alex'], 'cadence' => $monthly(-1, 5), 'revision' => 1], 'alex');
$r = $edited['chores'][$new];
check($edited['revision'] === $a['revision'] + 1 && $r['title'] === 'Water the ferns' && $r['owners'] === ['alex'] && $r['cadence'] === $monthly(-1, 5) && $r['revision'] === 2
    && $r['updatedBy'] === 'alex' && $r['order'] === 22 && array_keys($r) === array_keys($rule), 'an edit replaces title, owners and cadence, keeps the order, and moves revision and author');
check($save($a, ['id' => $new, 'title' => ' Water the plants ', 'owners' => ['sam', 'alex'], 'cadence' => $weekly(2, 'B'), 'revision' => 1], 'alex') === $a, 'saving what is stored writes nothing');
$cycled = $save($base, ['id' => $rid(4), 'title' => 'Cat bowls', 'owners' => ['alex'], 'cadence' => $weekly(1), 'revision' => 1], 'sam');
check($cycled['chores'][$rid(4)]['owners'] === ['alex'] && $cycled['chores'][$rid(4)]['revision'] === 2 && $cycled['chores'][$rid(9)] === $base['chores'][$rid(9)], 'the owner tap of The rhythm changes that rule alone');
foreach ([2, 9] as $revision) { refuses(fn() => $save($a, ['id' => $new, 'title' => 'Y', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => $revision], 'alex'), 409, 'stale'); }
refuses(fn() => $save($edited, ['id' => $new, 'title' => 'Y', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 1], 'sam'), 409, 'stale');
refuses(fn() => $save($base, ['id' => $new, 'title' => 'Y', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 3]), 409, 'gone');
check($caught(fn() => $save($edited, ['id' => $new, 'title' => 'Y', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 1]))->getMessage() === 'This chore changed on another device. Refresh to see the latest.', 'the stale message');
validate_db($edited);

// ---- 6. At most 60 rules ----
$full = $base;
for ($i = 0; $i < 39; ++$i) { $full = $save($full, ['id' => harness_id(400 + $i), 'title' => "Rule $i", 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0]); }
check(count($full['chores']) === 60, 'sixty rules fit');
$e = $caught(fn() => $save($full, ['id' => harness_id(499), 'title' => 'One too many', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0]));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'choresMax', 'the 61st rule is a limit error naming its cap');
check($save($full, ['id' => harness_id(400), 'title' => 'Rule 0', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 0]) === $full, 'a retried create does not fail the cap it already counts in');
check($save($full, ['id' => harness_id(400), 'title' => 'Renamed', 'owners' => ['sam'], 'cadence' => $daily, 'revision' => 1])['chores'][harness_id(400)]['title'] === 'Renamed', 'editing still works at the cap');

// ---- 7. markChore: create, update, delete ----
$dishes = $rid(1); $trash = $rid(2); $mail = $rid(6);
$m = $mark($base, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done']);
$stored = $m['choreMarks']["$mail:2026-11-03"];
check($m['revision'] === $base['revision'] + 1 && count($m['choreMarks']) === 1, 'marking a turn is one revision');
check($stored === ['id' => "$mail:2026-11-03", 'ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'moved' => false, 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => $stored['updatedAt']]
    && is_string($stored['updatedAt']) && !array_key_exists('owners', $stored), 'the mark is keyed ruleId:date and holds the model fields');
check($without($m, 'choreMarks', 'revision') === $without($base, 'choreMarks', 'revision'), 'nothing else changes');
check(snapshot($m, 'sam')['choreMarks'] === [$stored], 'the other person sees it');
check($mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'revision' => 0], 'alex') === $m, 'a retry after a lost reply (the same state, the old revision) changes nothing');
check($mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'revision' => 1], 'sam') === $m, 'the same state from the other person changes nothing');
$moved = $mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'open', 'moved' => true, 'revision' => 1], 'sam');
$mv = $moved['choreMarks']["$mail:2026-11-03"];
check($mv['state'] === 'open' && $mv['moved'] === true && $mv['revision'] === 2 && $mv['updatedBy'] === 'sam' && $moved['revision'] === $m['revision'] + 1, 'a mark is updated in place: revision + 1 and the new author');
refuses(fn() => $mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'letgo', 'revision' => 0], 'sam'), 409, 'stale');
refuses(fn() => $mark($moved, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'letgo', 'revision' => 1], 'alex'), 409, 'stale');
refuses(fn() => $mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'letgo', 'revision' => 7]), 409, 'stale');
$hand = $mark($moved, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'letgo', 'moved' => true, 'revision' => 2]);
check($hand['choreMarks']["$mail:2026-11-03"]['state'] === 'letgo' && $hand['choreMarks']["$mail:2026-11-03"]['moved'] === true, 'let go by hand keeps moved');
// An owner for one turn.
$owned = $mark($base, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open', 'owners' => ['sam', 'alex']]);
check($owned['choreMarks']["$dishes:2026-11-04"]['owners'] === ['alex', 'sam'] && $owned['choreMarks']["$dishes:2026-11-04"]['state'] === 'open', 'an open turn handed to Both is stored with canonical owners');
check(array_keys($owned['choreMarks']["$dishes:2026-11-04"]) === ['id', 'ruleId', 'date', 'state', 'moved', 'owners', 'revision', 'updatedBy', 'updatedAt'], 'owners sit before the stamps');
$again = $mark($owned, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'done', 'owners' => ['sam'], 'revision' => 1], 'sam');
check($again['choreMarks']["$dishes:2026-11-04"]['owners'] === ['sam'] && $again['choreMarks']["$dishes:2026-11-04"]['state'] === 'done', 'owners change with the state');
$plain = $mark($owned, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'done', 'owners' => null, 'revision' => 1]);
check(!array_key_exists('owners', $plain['choreMarks']["$dishes:2026-11-04"]) && $mark($owned, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open', 'owners' => null, 'revision' => 1])['choreMarks'] === [],
    'owners left out or null is no override: saving a turn without one drops it (and an open, unmoved turn with none drops the mark)');
// Open, unmoved and without an override is not stored: the request deletes the mark.
$cleared = $mark($owned, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open', 'revision' => 1], 'sam');
check($cleared['choreMarks'] === [] && $cleared['revision'] === $owned['revision'] + 1, 'an open, unmoved turn without an override deletes its mark');
check($mark($cleared, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open', 'revision' => 1]) === $cleared, 'deleting a mark that is already gone is a success without a write');
check($mark($base, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open']) === $base, 'an open turn with no mark stays unmarked');
refuses(fn() => $mark($owned, ['ruleId' => $dishes, 'date' => '2026-11-04', 'state' => 'open', 'revision' => 0]), 409, 'stale');
$undone = $mark($m, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'open', 'revision' => 1]);
check($undone['choreMarks'] === [], 'un-doing a done turn deletes the mark');
// Marks of other turns are untouched.
$two = $mark($m, ['ruleId' => $trash, 'date' => '2026-11-03', 'state' => 'letgo']);
check(count($two['choreMarks']) === 2 && $mark($two, ['ruleId' => $trash, 'date' => '2026-11-03', 'state' => 'open', 'revision' => 1])['choreMarks'] === $m['choreMarks'], 'each turn has its own mark');
// The server does not decide whether the rule has a turn that day (core's rule engine does): any real, non-Saturday date from the start on.
check(isset($mark($base, ['ruleId' => $mail, 'date' => '2027-03-02', 'state' => 'done'])['choreMarks']["$mail:2027-03-02"]), 'a far date is accepted');
check(isset($mark($base, ['ruleId' => $mail, 'date' => '2026-11-02', 'state' => 'done'])['choreMarks']["$mail:2026-11-02"]), 'and so is the first day');
check(isset($mark($base, ['ruleId' => $mail, 'date' => '2026-11-08', 'state' => 'done'])['choreMarks']["$mail:2026-11-08"]), 'and a Sunday');

// ---- 8. markChore: refusals ----
$ok = ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'moved' => false, 'revision' => 0];
$send_ok = fn(array $over) => mutate($base, ['action' => 'markChore'] + $over + $ok, 'alex');
foreach (['2026-11-07', '2026-11-14', '2026-12-05'] as $saturday) { refuses(fn() => $send_ok(['date' => $saturday]), 400, 'invalid'); }
foreach (['2026-11-01', '2026-10-31', '2026-01-01', '2000-01-01'] as $early) { refuses(fn() => $send_ok(['date' => $early]), 400, 'invalid'); }
$rhythmLate = $base; $rhythmLate['rhythm']['start'] = '2026-11-10';
refuses(fn() => mutate($rhythmLate, ['action' => 'markChore', 'date' => '2026-11-09'] + $ok, 'alex'), 400, 'invalid');
check(isset(mutate($rhythmLate, ['action' => 'markChore', 'date' => '2026-11-10'] + $ok, 'alex')['choreMarks']["$mail:2026-11-10"]), 'the start is the rhythm\'s own');
foreach (['2026-11-31', '2026-02-30', '2026-1-5', '11/04/2026', '2026-11-03 ', "2026-11-03\n", '', 'tomorrow', null, 20261103, ['2026-11-03'], '2100-01-01'] as $date) { refuses(fn() => $send_ok(['date' => $date]), 400, 'invalid'); }
foreach (['dishes', 'both', '', null, 5, strtoupper($rid(1)), $rid(1) . 'x', [$mail]] as $ruleId) { refuses(fn() => $send_ok(['ruleId' => $ruleId]), 400, 'invalid'); }
refuses(fn() => $send_ok(['ruleId' => HARNESS_OTHER]), 409, 'gone');
refuses(fn() => $send_ok(['ruleId' => HARNESS_OTHER, 'state' => 'closed']), 400, 'invalid');
foreach (['closed', 'DONE', 'Open', '', null, 5, true, ['done'], 'missed', 'moved'] as $state) { refuses(fn() => $send_ok(['state' => $state]), 400, 'invalid'); }
foreach (['false', 'true', 0, 1, null, [], 'moved'] as $moved) { refuses(fn() => $send_ok(['moved' => $moved]), 400, 'invalid'); }
refuses(fn() => mutate($base, ['action' => 'markChore', 'ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'revision' => 0], 'alex'), 400, 'invalid');
foreach ([[], ['both'], ['all'], [HARNESS_CUSTOM], [HARNESS_CUSTOM, 'sam'], ['sam', 'sam'], ['sam', 'alex', 'alex'], 'sam', [1], ['sam', null], [HARNESS_OTHER], ['x' => 'sam']] as $owners) { refuses(fn() => $send_ok(['owners' => $owners]), 400, 'invalid'); }
foreach (['0', 0.5, -1, null, true, [0]] as $revision) { refuses(fn() => $send_ok(['revision' => $revision]), 400, 'invalid'); }
refuses(fn() => mutate($base, ['action' => 'markChore', 'ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done', 'moved' => false], 'alex'), 400, 'invalid');

// ---- 9. Deleting a rule deletes its marks ----
$marked = $mark($mark($mark($base, ['ruleId' => $mail, 'date' => '2026-11-03', 'state' => 'done']), ['ruleId' => $mail, 'date' => '2026-11-10', 'state' => 'open', 'moved' => true]), ['ruleId' => $trash, 'date' => '2026-11-03', 'state' => 'letgo']);
check(count($marked['choreMarks']) === 3, 'three marks: two of Mail & papers, one of Trash');
$delete = fn(array $db, mixed $id, mixed $revision, string $user = 'alex') => mutate($db, ['action' => 'deleteChore', 'id' => $id, 'revision' => $revision, 'confirm' => true], $user);
$gone = $delete($marked, $mail, 1, 'sam');
check(!isset($gone['chores'][$mail]) && count($gone['chores']) === 20 && array_keys($gone['choreMarks']) === ["$trash:2026-11-03"] && $gone['revision'] === $marked['revision'] + 1, 'deleting a rule removes it and every mark of it, and no other');
check($without($gone['chores'], $mail) === $without($marked['chores'], $mail), 'the other rules are untouched');
validate_db($gone);
refuses(fn() => $delete($gone, $mail, 1), 409, 'gone');
refuses(fn() => $delete($marked, $mail, 2), 409, 'stale');
refuses(fn() => $delete($marked, $mail, 0), 409, 'stale');
refuses(fn() => mutate($marked, ['action' => 'deleteChore', 'id' => $mail, 'revision' => 1], 'alex'), 400, 'invalid');
refuses(fn() => mutate($marked, ['action' => 'deleteChore', 'id' => $mail, 'revision' => 1, 'confirm' => 'yes'], 'alex'), 400, 'invalid');
refuses(fn() => mutate($marked, ['action' => 'deleteChore', 'id' => $mail, 'revision' => 1, 'confirm' => false], 'alex'), 400, 'invalid');
foreach (['both', '', null, 5, 'dishes'] as $id) { refuses(fn() => $delete($marked, $id, 1), 400, 'invalid'); }
foreach (['1', null, -1, 1.5, true] as $revision) { refuses(fn() => $delete($marked, $mail, $revision), 400, 'invalid'); }
check(count($delete($a, $new, 1)['chores']) === 21, 'a rule added later can be deleted, leaving the seeded 21');
$none = $base; $none['chores'] = [$rid(1) => $base['chores'][$rid(1)]]; $none['rhythm'] = $base['rhythm'];
check($delete($none, $rid(1), 1)['chores'] === [], 'the last rule can be deleted');

// ---- 10. saveRhythm ----
$rhythm = fn(array $db, mixed $anchor, mixed $revision, string $user = 'alex') => mutate($db, ['action' => 'saveRhythm', 'anchor' => $anchor, 'revision' => $revision], $user);
$swapped = $rhythm($base, '2026-10-26', 1, 'sam');
check($swapped['rhythm'] === ['anchor' => '2026-10-26', 'start' => '2026-11-02', 'revision' => 2, 'updatedBy' => 'sam', 'updatedAt' => $swapped['rhythm']['updatedAt']]
    && $swapped['revision'] === $base['revision'] + 1 && $without($swapped, 'rhythm', 'revision') === $without($base, 'rhythm', 'revision'), 'moving the anchor changes the anchor, revision and author, and nothing else');
check($rhythm($base, '2026-11-02', 1) === $base && $rhythm($swapped, '2026-10-26', 2) === $swapped, 'the anchor it already has writes nothing');
check($rhythm($swapped, '2026-11-09', 2)['rhythm']['anchor'] === '2026-11-09', 'any Monday, also a later one');
foreach (['2026-11-03', '2026-11-08', '2026-11-07', '2026-11-01', '2026-02-30', '2026-11-2', '', 'monday', null, 20261102, ['2026-11-02'], "2026-11-02\n", '1999-11-01'] as $anchor) { refuses(fn() => $rhythm($base, $anchor, 1), 400, 'invalid'); }
foreach (['1', null, -1, 1.5, true] as $revision) { refuses(fn() => $rhythm($base, '2026-10-26', $revision), 400, 'invalid'); }
refuses(fn() => $rhythm($base, '2026-10-26', 0), 409, 'stale');
refuses(fn() => $rhythm($swapped, '2026-11-02', 1), 409, 'stale');
refuses(fn() => mutate($base, ['action' => 'saveRhythm', 'revision' => 1], 'alex'), 400, 'invalid');
refuses(fn() => mutate($base, ['action' => 'saveRhythm', 'anchor' => '2026-10-26'], 'alex'), 400, 'invalid');

// ---- 11. Authorization: only the two accounts, before anything else, on every chore action ----
foreach (['outsider', '', 'Alex', 'both', 'admin'] as $who) {
    foreach ([['action' => 'saveChore'] + $good, ['action' => 'deleteChore', 'id' => $rid(1), 'revision' => 1, 'confirm' => true],
        ['action' => 'markChore'] + $ok, ['action' => 'saveRhythm', 'anchor' => '2026-10-26', 'revision' => 1]] as $input) {
        refuses(fn() => mutate($base, $input, $who), 403, 'forbidden');
        refuses(fn() => mutate([], $input, $who), 403, 'forbidden');
    }
}
foreach (['alex', 'sam'] as $who) {
    check(isset(mutate($base, ['action' => 'markChore'] + $ok, $who)['choreMarks']["$mail:2026-11-03"]), "$who may mark a turn");
}

// ---- 12. The marks cap, and stored chores that fail closed ----
$crowded = $base; $n = 0;
for ($day = new DateTimeImmutable('2026-11-02'); $n < PlanMind\LIMITS['choreMarksMax']; $day = $day->modify('+1 day')) {
    if ($day->format('N') === '6') { continue; }
    foreach (range(1, 21) as $r) {
        if ($n >= PlanMind\LIMITS['choreMarksMax']) { break; }
        $key = $rid($r) . ':' . $day->format('Y-m-d');
        $crowded['choreMarks'][$key] = ['id' => $key, 'ruleId' => $rid($r), 'date' => $day->format('Y-m-d'), 'state' => 'done', 'moved' => false, 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => '2026-11-02T00:00:00+00:00'];
        ++$n;
    }
}
validate_db($crowded);
$e = $caught(fn() => $mark($crowded, ['ruleId' => $mail, 'date' => '2030-01-01', 'state' => 'done']));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'choreMarksMax', 'the 20001st mark is a limit error naming its cap');
$first = array_key_first($crowded['choreMarks']);
check($mark($crowded, ['ruleId' => $rid(1), 'date' => '2026-11-02', 'state' => 'letgo', 'revision' => 1])['choreMarks'][$first]['state'] === 'letgo' && count($mark($crowded, ['ruleId' => $rid(1), 'date' => '2026-11-02', 'state' => 'open', 'revision' => 1])['choreMarks']) === 19999,
    'at the cap a mark can still be changed or cleared');
$broken = [
    'chores missing' => function (array $d) { unset($d['chores']); return $d; },
    'marks missing' => function (array $d) { unset($d['choreMarks']); return $d; },
    'rhythm missing' => function (array $d) { unset($d['rhythm']); return $d; },
    'chores not a collection' => function (array $d) { $d['chores'] = 'x'; return $d; },
    'rule id differs from its key' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['id'] = $rid(2); return $d; },
    'rule key is not an id' => function (array $d) use ($rid) { $d['chores']['dishes'] = ['id' => 'dishes'] + $d['chores'][$rid(1)]; return $d; },
    'rule title empty' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['title'] = ''; return $d; },
    'rule title too long' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['title'] = str_repeat('t', 37); return $d; },
    'rule owners custom' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['owners'] = [HARNESS_CUSTOM]; return $d; },
    'rule owners not canonical' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['owners'] = ['sam', 'alex']; return $d; },
    'rule owners empty' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['owners'] = []; return $d; },
    'rule cadence on a Saturday' => function (array $d) use ($rid) { $d['chores'][$rid(4)]['cadence']['day'] = 6; return $d; },
    'rule cadence with an extra field' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['cadence']['day'] = 1; return $d; },
    'rule cadence out of key order' => function (array $d) use ($rid) { $d['chores'][$rid(4)]['cadence'] = ['kind' => 'weekly', 'weeks' => 'every', 'day' => 1]; return $d; },
    'rule cadence unknown' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['cadence'] = ['kind' => 'yearly']; return $d; },
    'rule revision zero' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['revision'] = 0; return $d; },
    'rule author not a person' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['updatedBy'] = 'outsider'; return $d; },
    'rule with an extra field' => function (array $d) use ($rid) { $d['chores'][$rid(1)]['ak'] = 'x'; return $d; },
    'rule without an order' => function (array $d) use ($rid) { unset($d['chores'][$rid(1)]['order']); return $d; },
    'sixty-one rules' => function (array $d) { for ($i = 0; $i < 40; ++$i) { $d['chores'][harness_id(600 + $i)] = ['id' => harness_id(600 + $i), 'title' => "R$i", 'owners' => ['sam'], 'cadence' => ['kind' => 'daily'], 'order' => 100 + $i, 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => 'x']; } return $d; },
    'rhythm anchor not a Monday' => function (array $d) { $d['rhythm']['anchor'] = '2026-11-03'; return $d; },
    'rhythm start not a date' => function (array $d) { $d['rhythm']['start'] = 'soon'; return $d; },
    'rhythm with an extra field' => function (array $d) { $d['rhythm']['end'] = '2027-01-01'; return $d; },
    'rhythm author not a person' => function (array $d) { $d['rhythm']['updatedBy'] = 'both'; return $d; },
    'rhythm revision missing' => function (array $d) { unset($d['rhythm']['revision']); return $d; },
    'mark of a rule that is gone' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; unset($d['chores'][$mail]); return $d; },
    'mark id differs from its key' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['id'] = 'x'; return $d; },
    'mark key differs from its rule and date' => function (array $d) use ($m, $mail) { $d['choreMarks'] = ["$mail:2026-11-04" => $m['choreMarks']["$mail:2026-11-03"]]; return $d; },
    'mark on a Saturday' => function (array $d) use ($mail) { $d['choreMarks'] = ["$mail:2026-11-07" => ['id' => "$mail:2026-11-07", 'ruleId' => $mail, 'date' => '2026-11-07', 'state' => 'done', 'moved' => false, 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => 'x']]; return $d; },
    'mark before the start' => function (array $d) use ($mail) { $d['choreMarks'] = ["$mail:2026-11-01" => ['id' => "$mail:2026-11-01", 'ruleId' => $mail, 'date' => '2026-11-01', 'state' => 'done', 'moved' => false, 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => 'x']]; return $d; },
    'mark with an unknown state' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['state'] = 'missed'; return $d; },
    'mark moved as text' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['moved'] = 'no'; return $d; },
    'mark that is empty (open, unmoved, no owners)' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['state'] = 'open'; return $d; },
    'mark owners custom' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['owners'] = [HARNESS_CUSTOM]; return $d; },
    'mark revision zero' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['revision'] = 0; return $d; },
    'mark with an extra field' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['note'] = 'x'; return $d; },
    'mark author not a person' => function (array $d) use ($m, $mail) { $d['choreMarks'] = $m['choreMarks']; $d['choreMarks']["$mail:2026-11-03"]['updatedBy'] = 'x'; return $d; },
    'too many marks' => function (array $d) use ($crowded, $mail) { $d['choreMarks'] = $crowded['choreMarks']; $d['choreMarks']["$mail:2030-01-01"] = ['id' => "$mail:2030-01-01", 'ruleId' => $mail, 'date' => '2030-01-01', 'state' => 'done', 'moved' => false, 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => 'x']; return $d; },
    'version two with the chart already in it' => function (array $d) { $d['v'] = 2; return $d; },
];
check(count($broken) >= 35, 'the fail-closed table is populated');
harness_log(true);
foreach ($broken as $label => $break) {
    $db = $break(harness_db());
    foreach ([fn() => snapshot($db, 'alex'), fn() => mutate($db, ['action' => 'savePrefs', 'selection' => ['base' => 'both', 'overlays' => []]], 'alex'), fn() => validate_db($db)] as $via) {
        try { $via(); } catch (RequestError $e) { throw new RuntimeException("$label: a stored fault was answered as a client error"); }
        catch (RuntimeException $e) { check(str_starts_with($e->getMessage(), 'Invalid planner data') || $e->getMessage() === 'Unsupported data version', "$label: unexpected failure {$e->getMessage()}"); continue; }
        throw new RuntimeException("$label: broken store was accepted");
    }
}
check(substr_count(harness_log(true), 'PlanMind storage rejected: ') >= count($broken) * 3, 'error_log names the cause of each refusal');
validate_db($m); validate_db($owned); validate_db($crowded); validate_db($full);
