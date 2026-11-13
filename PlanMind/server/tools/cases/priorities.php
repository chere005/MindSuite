<?php
declare(strict_types=1);
// Day priority lines: five lines per list per day, one line per owner, slot rules, text limits, edits and the
// all-or-nothing movePriorities batch (spec 11.1 case 6).
use PlanMind\RequestError;
use function PlanMind\mutate;

$run = fn(array $db, array $input, string $user = 'alex') => mutate($db, $input, $user);
$id = fn(int $n) => harness_id(100 + $n);
$day = '2026-11-02';
$add = fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'priority', 'id' => $id($n), 'date' => $day, 'owners' => ['alex'], 'slots' => ['alex' => 1], 'text' => "Line $n"];
$edit = fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'priority', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'slots' => ['alex' => 1], 'text' => "Line $n"];
$move = fn(mixed $listId, mixed $moves, string $date = '2026-11-02') => ['action' => 'movePriorities', 'date' => $date, 'listId' => $listId, 'moves' => $moves];
$step = fn(int $n, int $rev, int $slot) => ['id' => $id($n), 'revision' => $rev, 'slot' => $slot];
$slotsOf = fn(array $db, string $list) => array_map(fn($p) => $p['slots'][$list], array_filter($db['priorities'], fn($p) => $p['date'] === '2026-11-02' && isset($p['slots'][$list])));
/** Alex's lines A, B, C (ids 1 to 3) on lines 1, 2, 3, all at revision 1, on a day the fixture does not use. */
$three = fn() => $run($run($run(harness_db(), $add(1, ['slots' => ['alex' => 1]])), $add(2, ['slots' => ['alex' => 2]])), $add(3, ['slots' => ['alex' => 3]]));
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};

// ---- Slots: a line from 1 to 5 for each owner and for no one else ----
foreach ([1, 2, 3, 4, 5] as $line) { check($run(harness_db(), $add(1, ['slots' => ['alex' => $line]]))['priorities'][$id(1)]['slots'] === ['alex' => $line], "line $line"); }
foreach ([0, 6, -1, 100, '2', 2.0, null, true, [], [2]] as $bad) { refuses(fn() => $run(harness_db(), $add(1, ['slots' => ['alex' => $bad]])), 400, 'invalid'); }
foreach ([[], [1], 'alex', null, ['sam' => 1], ['alex' => 1, 'sam' => 2], ['alex' => 1, 'both' => 1], [0 => 1], ['x' => 1]] as $bad) {
    refuses(fn() => $run(harness_db(), $add(1, ['slots' => $bad])), 400, 'invalid');
}
refuses(fn() => $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'slots' => ['alex' => 1]])), 400, 'invalid');
refuses(fn() => $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 1, HARNESS_CUSTOM => 1]])), 400, 'invalid');
refuses(fn() => $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'slots' => [1, 2]])), 400, 'invalid');
$noSlots = $add(1); unset($noSlots['slots']);
refuses(fn() => $run(harness_db(), $noSlots), 400, 'invalid');
// Slots are stored in owner order whatever order they arrive in.
$linked = $run(harness_db(), $add(1, ['owners' => ['sam', 'alex'], 'slots' => ['sam' => 2, 'alex' => 4]]));
check(array_keys($linked['priorities'][$id(1)]['slots']) === ['alex', 'sam'] && $linked['priorities'][$id(1)]['slots'] === ['alex' => 4, 'sam' => 2], 'slots are stored sorted by owner');
check(json_decode(json_encode($linked['priorities'][$id(1)]), false)->slots instanceof stdClass, 'slots encode as an object');

// ---- Slot rules: one holder per (day, list, line) ----
$a = $run(harness_db(), $add(1, ['slots' => ['alex' => 1]]));
refuses(fn() => $run($a, $add(2, ['slots' => ['alex' => 1]])), 409, 'slot_taken');
refuses(fn() => $run($a, $add(2, ['slots' => ['alex' => 1]]), 'sam'), 409, 'slot_taken'); // the line is Alex's, whoever writes
check($caught(fn() => $run($a, $add(2, ['slots' => ['alex' => 1]])))->getMessage() === 'Line 1 is already taken in Alex.', 'the message names the line and the list');
check($run($a, $add(2, ['slots' => ['alex' => 2]]))['priorities'][$id(2)]['slots'] === ['alex' => 2], 'another line is free');
check(isset($run($a, $add(2, ['owners' => ['sam'], 'slots' => ['sam' => 1]]))['priorities'][$id(2)]), 'the same line for different owners is allowed');
check(isset($run($a, $add(2, ['owners' => [HARNESS_CUSTOM], 'slots' => [HARNESS_CUSTOM => 1]]))['priorities'][$id(2)]), 'a custom list has its own five lines');
check(isset($run($a, $add(2, ['date' => '2026-11-03', 'slots' => ['alex' => 1]]))['priorities'][$id(2)]), 'the same line on another day is free');
// Linked: free on the same line only if free for both; different lines per owner are allowed.
refuses(fn() => $run($a, $add(2, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 1]])), 409, 'slot_taken');
refuses(fn() => $run($a, $add(2, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 3, 'alex' => 1]])), 409, 'slot_taken');
check($run($a, $add(2, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 2]]))['priorities'][$id(2)]['slots'] === ['alex' => 2, 'sam' => 1], 'a linked item may sit on different lines');
check($run($a, $add(2, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 2, 'alex' => 2]]))['priorities'][$id(2)]['slots'] === ['alex' => 2, 'sam' => 2], 'or on the same line');
$both = $run(harness_db(), $add(1, ['owners' => ['sam', 'alex'], 'slots' => ['sam' => 2, 'alex' => 4]]));
refuses(fn() => $run($both, $add(2, ['owners' => ['sam'], 'slots' => ['sam' => 2]])), 409, 'slot_taken');
refuses(fn() => $run($both, $add(2, ['owners' => ['alex'], 'slots' => ['alex' => 4]])), 409, 'slot_taken');
check(isset($run($both, $add(2, ['owners' => ['sam'], 'slots' => ['sam' => 4]]))['priorities'][$id(2)]) && isset($run($both, $add(2, ['slots' => ['alex' => 2]]))['priorities'][$id(2)]),
    'a linked item holds a line only in the list it names');
// The fixture's linked priority (2026-10-30: alex 4, sam 2) blocks the same lines.
refuses(fn() => $run(harness_db(), $add(2, ['date' => '2026-10-30', 'slots' => ['alex' => 4]])), 409, 'slot_taken');
// A deleted line frees its place.
$freed = $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true]);
check(isset($run($freed, $add(2, ['slots' => ['alex' => 1]]))['priorities'][$id(2)]), 'deleting a line frees it');
// Five lines fill a day; there is no sixth.
$full = harness_db();
foreach ([1, 2, 3, 4, 5] as $line) { $full = $run($full, $add($line, ['slots' => ['alex' => $line]])); }
check(count($slotsOf($full, 'alex')) === 5, 'five lines');
foreach ([1, 2, 3, 4, 5] as $line) { refuses(fn() => $run($full, $add(6, ['slots' => ['alex' => $line]])), 409, 'slot_taken'); }

// ---- Text: 18 code points, linked too ----
$text = fn(int $n) => str_repeat('a', $n);
foreach ([[['alex'], 18, true], [['alex'], 19, false], [['alex', 'sam'], 18, true], [['alex', 'sam'], 19, false], [['alex', 'sam'], 36, false]] as [$owners, $n, $ok]) {
    $try = fn() => $run(harness_db(), $add(1, ['owners' => $owners, 'slots' => array_fill_keys($owners, 1), 'text' => $text($n)]));
    if ($ok) { check($try()['priorities'][$id(1)]['text'] === $text($n), "$n characters for " . json_encode($owners)); } else { refuses($try, 400, 'text_too_long'); }
}
$emoji = fn(int $n) => str_repeat("\u{1F600}", $n);
check(isset($run(harness_db(), $add(1, ['text' => $emoji(18)]))['priorities'][$id(1)]), '18 emoji are 18 characters');
refuses(fn() => $run(harness_db(), $add(1, ['text' => $emoji(19)])), 400, 'text_too_long');
$accent = fn(int $n) => str_repeat("e\u{301}", $n);
check(isset($run(harness_db(), $add(1, ['text' => $accent(9)]))['priorities'][$id(1)]), 'nine letters with a combining mark are 18 code points');
refuses(fn() => $run(harness_db(), $add(1, ['text' => $accent(10)])), 400, 'text_too_long');
foreach (['', '  ', "a\nb", "a\0", 7, null] as $bad) { refuses(fn() => $run(harness_db(), $add(1, ['text' => $bad])), 400, 'invalid'); }

// ---- Edit: the line never collides with itself; every check runs again ----
$three2 = $three();
check($run($three2, $edit(1, 1, ['text' => 'Renamed']))['priorities'][$id(1)]['slots'] === ['alex' => 1], 'a text edit keeps the line without colliding with itself');
check($run($three2, $edit(1, 1, ['slots' => ['alex' => 5]]))['priorities'][$id(1)]['slots'] === ['alex' => 5], 'an edit may take a free line');
// A store may hold a record's slots in any key order (the fixture's linked priority has alex before sam): an edit that
// sends the same lines in the other order changes nothing, so nothing is rewritten and the revision stays.
$unsorted = harness_db();
check(array_keys($unsorted['priorities'][harness_id(3)]['slots']) === ['sam', 'alex'], 'the fixture stores the linked priority\'s slots out of order');
$sameEdit = ['action' => 'edit', 'kind' => 'priority', 'id' => harness_id(3), 'revision' => 1, 'date' => '2026-10-30', 'owners' => ['alex', 'sam'], 'slots' => ['sam' => 2, 'alex' => 4], 'text' => 'Family dinner'];
check($run($unsorted, $sameEdit) === $unsorted, 'an edit that restates the same lines in another key order is a no-op');
check($run($unsorted, ['text' => 'Family dinner!'] + $sameEdit)['priorities'][harness_id(3)]['revision'] === 2, 'while a real change still bumps the revision');
refuses(fn() => $run($three2, $edit(1, 1, ['slots' => ['alex' => 2]])), 409, 'slot_taken');
refuses(fn() => $run($three2, $edit(1, 1, ['date' => '2026-10-30', 'slots' => ['alex' => 4]])), 409, 'slot_taken');
check($run($three2, $edit(1, 1, ['date' => '2026-10-30', 'slots' => ['alex' => 1]]))['priorities'][$id(1)]['date'] === '2026-10-30', 'an edit may move to another day');
refuses(fn() => $run($three2, $edit(1, 1, ['slots' => ['sam' => 1]])), 400, 'invalid');
refuses(fn() => $run($three2, $edit(1, 1, ['slots' => ['alex' => 0]])), 400, 'invalid');
refuses(fn() => $run($three2, $edit(1, 1, ['owners' => ['alex', 'sam']])), 400, 'invalid'); // the slots must name the new owners
$becomesLinked = $run($three2, $edit(1, 1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 1]]));
check($becomesLinked['priorities'][$id(1)]['owners'] === ['alex', 'sam'] && $becomesLinked['priorities'][$id(1)]['slots'] === ['alex' => 1, 'sam' => 1], 'becoming linked');
refuses(fn() => $run($three2, $edit(1, 1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 2]])), 409, 'slot_taken');
$backToAlex = $run($becomesLinked, $edit(1, 2, ['owners' => ['alex'], 'slots' => ['alex' => 1], 'text' => 'Line 1']));
check($backToAlex['priorities'][$id(1)]['owners'] === ['alex'] && $backToAlex['priorities'][$id(1)]['slots'] === ['alex' => 1], 'Both to Alex keeps the line of the remaining owner');
$sameLine = $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 2, 'alex' => 2]]));
$splitLine = $run($sameLine, $edit(1, 1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 2, 'alex' => 3]]));
check($splitLine['priorities'][$id(1)]['slots'] === ['alex' => 3, 'sam' => 2], 'a linked item can be split onto different lines by an edit');
// The text limit follows the owners.
$longLinked = $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'slots' => ['sam' => 1, 'alex' => 1], 'text' => $text(18)]));
check($run($longLinked, $edit(1, 1, ['owners' => ['alex'], 'text' => $text(18)]))['priorities'][$id(1)]['owners'] === ['alex'], 'the same limit applies linked or single');
refuses(fn() => $run($longLinked, $edit(1, 1, ['owners' => ['alex'], 'text' => $text(19)])), 400, 'text_too_long');

// ---- movePriorities ----
$b = $three();
// Swap two lines.
$swapped = $run($b, $move('alex', [$step(1, 1, 2), $step(2, 1, 1)]));
check($swapped['priorities'][$id(1)]['slots'] === ['alex' => 2] && $swapped['priorities'][$id(2)]['slots'] === ['alex' => 1] && $swapped['priorities'][$id(3)]['slots'] === ['alex' => 3], 'a swap');
check($swapped['revision'] === $b['revision'] + 1, 'a batch is one global revision');
check($swapped['priorities'][$id(1)]['revision'] === 2 && $swapped['priorities'][$id(2)]['revision'] === 2 && $swapped['priorities'][$id(3)]['revision'] === 1, 'each moved record is revision + 1; the rest are untouched');
check($swapped['priorities'][$id(1)]['updatedBy'] === 'alex' && $swapped['priorities'][$id(3)] === $b['priorities'][$id(3)], 'the updater is recorded on the moved lines only');
// Shift: the third line to the top pushes the others down.
$shifted = $run($b, $move('alex', [$step(3, 1, 1), $step(1, 1, 2), $step(2, 1, 3)]), 'sam');
check(array_map(fn($n) => $shifted['priorities'][$id($n)]['slots']['alex'], [1, 2, 3]) === [2, 3, 1] && $shifted['priorities'][$id(1)]['updatedBy'] === 'sam', 'a shift by someone else');
// Into a gap, alone.
$gap = $run($b, $move('alex', [$step(1, 1, 5)]));
check($gap['priorities'][$id(1)]['slots'] === ['alex' => 5] && $gap['revision'] === $b['revision'] + 1, 'a single move into a free line');
// Five lines rotate in one batch.
$five = $b;
foreach ([4, 5] as $n) { $five = $run($five, $add($n, ['slots' => ['alex' => $n]])); }
$rotated = $run($five, $move('alex', [$step(5, 1, 1), $step(1, 1, 2), $step(2, 1, 3), $step(3, 1, 4), $step(4, 1, 5)]));
check(array_map(fn($n) => $rotated['priorities'][$id($n)]['slots']['alex'], [1, 2, 3, 4, 5]) === [2, 3, 4, 5, 1], 'five moves in one batch');
// The text is not re-judged: a line longer than today's limit can still be moved.
$old = $b; $old['priorities'][$id(1)]['text'] = str_repeat('long ', 8);
check($run($old, $move('alex', [$step(1, 1, 4)]))['priorities'][$id(1)]['slots'] === ['alex' => 4], 'moving does not re-check the text cap');
// Stale anywhere rejects the whole batch.
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 2), $step(2, 7, 1)])), 409, 'stale');
refuses(fn() => $run($b, $move('alex', [$step(1, 7, 2), $step(2, 1, 1)])), 409, 'stale');
refuses(fn() => $run($swapped, $move('alex', [$step(3, 1, 1), $step(1, 1, 3)])), 409, 'stale'); // the second was moved since
[$store, $dir] = harness_store();
$store->transaction('tasks', fn() => $b);
$before = (string)file_get_contents($dir . '/tasks.enc');
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, $move('alex', [$step(1, 1, 2), $step(2, 7, 1)]), 'alex')), 409, 'stale');
check((string)file_get_contents($dir . '/tasks.enc') === $before, 'a rejected batch leaves the file untouched');
$store->transaction('tasks', fn($db) => mutate($db, $move('alex', [$step(1, 1, 2), $step(2, 1, 1)]), 'alex'));
check((string)file_get_contents($dir . '/tasks.enc') !== $before, 'an accepted batch is written');
// A collision at the end rejects too: a line left in place, a duplicate target, a target that was not vacated.
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 2)])), 409, 'slot_taken');
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 4), $step(2, 1, 4)])), 409, 'slot_taken');
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 3), $step(2, 1, 3)])), 409, 'slot_taken');
// A retry after a lost response finds every line at its target: success, nothing written, even with the old revisions.
check($run($swapped, $move('alex', [$step(1, 1, 2), $step(2, 1, 1)])) === $swapped, 'a retry at the target is a no-op');
check($run($gap, $move('alex', [$step(1, 1, 5)]), 'sam') === $gap, 'a single-line retry is a no-op');
// Mixed: one line already there, the other still to move, an old revision on the first: still all or nothing.
refuses(fn() => $run($gap, $move('alex', [$step(1, 1, 5), $step(2, 1, 4)])), 409, 'stale');
// A linked item moves in one list and leaves the other owner's line.
$l = $run(harness_db(), $add(1, ['owners' => ['sam', 'alex'], 'slots' => ['sam' => 2, 'alex' => 4]]));
$l = $run($l, $add(2, ['slots' => ['alex' => 1]]));
$movedAlex = $run($l, $move('alex', [$step(1, 1, 3)]));
check($movedAlex['priorities'][$id(1)]['slots'] === ['alex' => 3, 'sam' => 2] && $movedAlex['priorities'][$id(1)]['owners'] === ['alex', 'sam'] && $movedAlex['priorities'][$id(1)]['revision'] === 2,
    'a linked line moved in Alex\'s list keeps Sam\'s line');
$movedSam = $run($l, $move('sam', [$step(1, 1, 5)]), 'sam');
check($movedSam['priorities'][$id(1)]['slots'] === ['alex' => 4, 'sam' => 5], 'and the other way round');
refuses(fn() => $run($l, $move('sam', [$step(1, 1, 1), $step(2, 1, 2)])), 400, 'invalid'); // line 2 is Alex's single entry: not in Sam's list
// A move into a line held by a linked item in that list is refused; the other list's lines do not matter.
refuses(fn() => $run($l, $move('alex', [$step(2, 1, 4)])), 409, 'slot_taken');
check($run($l, $move('alex', [$step(2, 1, 2)]))['priorities'][$id(2)]['slots'] === ['alex' => 2], 'another list\'s line is not in the way');
// Other days are separate.
$otherDay = $run($b, $add(7, ['date' => '2026-11-03', 'slots' => ['alex' => 5]]));
check($run($otherDay, $move('alex', [$step(1, 1, 5)]))['priorities'][$id(1)]['slots'] === ['alex' => 5], 'a line on another day does not block');
// Shape errors.
foreach ([[], [$step(1, 1, 2), $step(1, 1, 3)], array_map(fn($n) => $step($n, 1, 1), [1, 2, 3, 1, 2, 3]), array_map(fn($n) => $step($n + 10, 1, 1), [1, 2, 3, 4, 5, 6]), 'x', [['id' => $id(1), 'revision' => 1]], [['id' => $id(1), 'slot' => 2]],
    [['revision' => 1, 'slot' => 2]], [$step(1, 1, 2) + ['extra' => 1]], [$step(1, 1, 0)], [$step(1, 1, 6)], [$step(1, 0, 2)], [['id' => $id(1), 'revision' => 1, 'slot' => '2']], [5], [[]], null] as $moves) {
    refuses(fn() => $run($b, $move('alex', $moves)), 400, 'invalid');
}
refuses(fn() => $run($b, $move('alex', [['id' => $id(1), 'revision' => 1, 'slot' => 2.0]])), 400, 'invalid');
refuses(fn() => $run($b, $move('alex', [['id' => 'nope', 'revision' => 1, 'slot' => 2]])), 400, 'invalid');
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 2)], '2026-11-03')), 400, 'invalid'); // not that day
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 2)], '2026-02-30')), 400, 'invalid');
refuses(fn() => $run($b, $move('sam', [$step(1, 1, 2)])), 400, 'invalid'); // Sam is not an owner of that line
refuses(fn() => $run($b, $move('both', [$step(1, 1, 2)])), 400, 'invalid');
refuses(fn() => $run($b, $move('all', [$step(1, 1, 2)])), 400, 'invalid');
refuses(fn() => $run($b, $move(5, [$step(1, 1, 2)])), 400, 'invalid');
refuses(fn() => $run($b, $move(HARNESS_OTHER, [$step(1, 1, 2)])), 409, 'gone');
refuses(fn() => $run($b, $move('alex', [$step(9, 1, 2)])), 409, 'gone');
refuses(fn() => $run($b, ['action' => 'movePriorities', 'date' => $day, 'listId' => 'alex']), 400, 'invalid');
refuses(fn() => $run($b, $move('alex', [$step(1, 1, 2)]) + ['extra' => true]), 400, 'invalid');
// Only priorities move this way.
$mixed = $run($b, ['action' => 'add', 'kind' => 'todo', 'id' => $id(30), 'scope' => 'day', 'date' => $day, 'owners' => ['alex'], 'title' => 'x']);
refuses(fn() => $run($mixed, $move('alex', [['id' => $id(30), 'revision' => 1, 'slot' => 4]])), 400, 'invalid');
