<?php
declare(strict_types=1);
// To-dos: scope and date rules, text limits, the open-only day cap and the week and month cap, complete and edit
// against the caps, and moveTodo ordering (spec 11.1 cases 8 and 9).
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate};

$run = fn(array $db, array $input, string $user = 'alex') => mutate($db, $input, $user);
$id = fn(int $n) => harness_id(100 + $n);
$day = '2026-11-02'; // a Monday, so it is also a valid week start
$add = fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'todo', 'id' => $id($n), 'scope' => 'day', 'date' => $day, 'owners' => ['alex'], 'title' => "Item $n"];
$edit = fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'todo', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'title' => "Item $n"];
$complete = fn(int $n, int $rev, bool $done) => ['action' => 'complete', 'id' => $id($n), 'revision' => $rev, 'done' => $done];
$move = fn(int $n, int $rev, ?int $before) => ['action' => 'moveTodo', 'id' => $id($n), 'revision' => $rev, 'before' => $before === null ? null : $id($before)];
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
/** Adds to-dos numbered $from to $to with the same extra fields. */
$many = function (array $db, int $from, int $to, array $more = []) use ($run, $add): array {
    for ($n = $from; $n <= $to; ++$n) { $db = $run($db, $add($n, $more)); }
    return $db;
};
$isLimit = fn(RequestError $e, string $cap) => $e->status === 409 && $e->errorCode === 'limit' && $e->cap === $cap;

// ---- Scope and date: a day is any real date, a week starts on a Monday, a month on the 1st ----
foreach ([['day', '2026-11-04'], ['day', '2026-02-28'], ['day', '2000-01-01'], ['day', '2099-12-31'], ['week', '2026-11-02'], ['month', '2026-11-01']] as [$scope, $date]) {
    $row = $run(harness_db(), $add(1, ['scope' => $scope, 'date' => $date]))['tasks'][$id(1)];
    check($row['scope'] === $scope && $row['date'] === $date && $row['done'] === false && $row['title'] === 'Item 1', "$scope to-do on $date");
}
foreach ([['week', '2026-11-03'], ['week', '2026-11-01'], ['month', '2026-11-02'], ['month', '2026-11-30'], ['day', '2026-02-30'], ['day', '1999-12-31'], ['day', '2100-01-01'],
    ['year', '2026-11-02'], ['', '2026-11-02'], [null, '2026-11-02'], ['Day', '2026-11-02'], [5, '2026-11-02'], ['day', null], ['day', '2026-11-2'], ['day', 20261102], ['week', '2026-13-01']] as [$scope, $date]) {
    refuses(fn() => $run(harness_db(), $add(1, ['scope' => $scope, 'date' => $date])), 400, 'invalid');
}
$noScope = $add(1); unset($noScope['scope']);
refuses(fn() => $run(harness_db(), $noScope), 400, 'invalid');
// Edit: the scope is the stored one; a week to-do can move to another Monday but not to a Tuesday.
$week = $run(harness_db(), $add(1, ['scope' => 'week']));
check($run($week, $edit(1, 1, ['date' => '2026-11-09']))['tasks'][$id(1)]['date'] === '2026-11-09', 'a week to-do moves to another Monday');
refuses(fn() => $run($week, $edit(1, 1, ['date' => '2026-11-10'])), 400, 'invalid');
refuses(fn() => $run($week, $edit(1, 1, ['scope' => 'day'])), 400, 'invalid');
$monthly = $run(harness_db(), $add(1, ['scope' => 'month', 'date' => '2026-11-01']));
refuses(fn() => $run($monthly, $edit(1, 1, ['date' => '2026-11-02'])), 400, 'invalid');
check($run($monthly, $edit(1, 1, ['date' => '2026-12-01']))['tasks'][$id(1)]['date'] === '2026-12-01', 'a month to-do moves to another 1st');

// ---- Text: 36 for a day to-do, 500 for week and month, in code points ----
$text = fn(int $n) => str_repeat('a', $n);
foreach ([['day', $day, ['alex'], 36, true], ['day', $day, ['alex'], 37, false], ['day', $day, ['alex', 'sam'], 36, true], ['day', $day, ['alex', 'sam'], 37, false],
    ['day', $day, [HARNESS_CUSTOM], 36, true], ['day', $day, [HARNESS_CUSTOM], 37, false], ['day', $day, ['alex'], 1, true],
    ['week', $day, ['alex'], 500, true], ['week', $day, ['alex'], 501, false], ['week', $day, ['alex', 'sam'], 500, true], ['week', $day, ['alex', 'sam'], 501, false],
    ['month', '2026-11-01', ['sam'], 500, true], ['month', '2026-11-01', ['sam'], 501, false]] as [$scope, $date, $owners, $n, $ok]) {
    $try = fn() => $run(harness_db(), $add(1, ['scope' => $scope, 'date' => $date, 'owners' => $owners, 'title' => $text($n)]));
    if ($ok) { check($try()['tasks'][$id(1)]['title'] === $text($n), "$n characters, $scope, " . json_encode($owners)); } else { refuses($try, 400, 'text_too_long'); }
}
$emoji = fn(int $n) => str_repeat("\u{1F600}", $n);
check(strlen($emoji(36)) === 144 && $run(harness_db(), $add(1, ['title' => $emoji(36)]))['tasks'][$id(1)]['title'] === $emoji(36), '36 emoji are 36 characters although 144 bytes');
refuses(fn() => $run(harness_db(), $add(1, ['title' => $emoji(37)])), 400, 'text_too_long');
check(isset($run(harness_db(), $add(1, ['scope' => 'week', 'title' => $emoji(500)]))['tasks'][$id(1)]), '500 emoji fit a week to-do');
refuses(fn() => $run(harness_db(), $add(1, ['scope' => 'week', 'title' => $emoji(501)])), 400, 'text_too_long');
$accent = fn(int $n) => str_repeat("e\u{301}", $n);
check(isset($run(harness_db(), $add(1, ['title' => $accent(18)]))['tasks'][$id(1)]), '18 letters with a combining mark are 36 code points');
refuses(fn() => $run(harness_db(), $add(1, ['title' => $accent(19)])), 400, 'text_too_long');
check($run(harness_db(), $add(1, ['title' => "  Buy milk \u{a0}"]))['tasks'][$id(1)]['title'] === 'Buy milk', 'the title is trimmed');
foreach (['', '   ', "two\nlines", "a\tb", "nul\0", 5, null, ['x'], "\xff\xfe", "x\u{2028}y"] as $bad) { refuses(fn() => $run(harness_db(), $add(1, ['title' => $bad])), 400, 'invalid'); }
// An edit that changes who the to-do is for judges the text by the new owners only through the scope: both are 36 on a day.
$linked = $run(harness_db(), $add(1, ['owners' => ['alex', 'sam'], 'title' => $text(36)]));
check($run($linked, $edit(1, 1, ['owners' => ['alex'], 'title' => $text(36)]))['tasks'][$id(1)]['owners'] === ['alex'], 'a 36-character day to-do stays valid when it stops being linked');
refuses(fn() => $run($linked, $edit(1, 1, ['title' => $text(37)])), 400, 'text_too_long');

// ---- Day cap: CAPS.dayTodosPerList (13, Alex 2026-10-31) OPEN to-dos per list per day ----
$N = PlanMind\LIMITS['dayTodosPerList'];
check($N === 13, 'the cap is the 13 Alex set');
$capped = $many(harness_db(), 1, $N);
check(count(array_filter($capped['tasks'], fn($t) => $t['date'] === $day && $t['owners'] === ['alex'])) === $N, "$N open to-dos fit");
$e = $caught(fn() => $run($capped, $add($N + 1)));
check($isLimit($e, 'dayTodosPerList') && $e->getMessage() === "Alex already has $N things to do that day.", 'one more is refused as a limit with its cap name and a clear message');
check($e->body() === ['error' => "Alex already has $N things to do that day.", 'code' => 'limit', 'cap' => 'dayTodosPerList'], 'the error body carries the code and the cap');
// Other days, other lists and other scopes are separate.
check(isset($run($capped, $add($N + 1, ['date' => '2026-11-03']))['tasks'][$id($N + 1)]), 'another day has room');
check(isset($run($capped, $add($N + 1, ['owners' => ['sam']]))['tasks'][$id($N + 1)]), 'another person has room');
check(isset($run($capped, $add($N + 1, ['owners' => [HARNESS_CUSTOM]]))['tasks'][$id($N + 1)]), 'a custom list has room');
check(isset($run($capped, $add($N + 1, ['scope' => 'week']))['tasks'][$id($N + 1)]), 'week to-dos are not counted against the day');
// Done rows free room.
$freed = $run($capped, $complete(1, 1, true));
check(isset($run($freed, $add($N + 1))['tasks'][$id($N + 1)]), 'completing a to-do makes room');
refuses(fn() => $run($run($freed, $add($N + 1)), $add($N + 2)), 409, 'limit');
// Un-completing into a full list is refused; into room is fine.
$full = $run($freed, $add($N + 1));
$e = $caught(fn() => $run($full, $complete(1, 2, false)));
check($isLimit($e, 'dayTodosPerList'), 'reopening into a full list is a limit');
check($run($freed, $complete(1, 2, false))['tasks'][$id(1)]['done'] === false, 'reopening with room works');
check($run($full, $complete(2, 1, true))['tasks'][$id(2)]['done'] === true, 'completing is never capped');
$reopenOther = $run($full, $complete(2, 1, true));
check($run($reopenOther, $complete(1, 2, false))['tasks'][$id(1)]['done'] === false, 'room made elsewhere in the list lets the reopen through');
// Only a DAY to-do is capped on reopening: a week or month to-do shares its date with the day it starts on, and that day being full is no reason to refuse it.
foreach ([['week', '2026-11-02'], ['month', '2026-11-01']] as [$scope, $date]) {
    foreach ([['alex'], ['alex', 'sam']] as $owners) {
        $fullDay = $many(harness_db(), 1, $N, ['date' => $date]);
        $withPeriod = $run($fullDay, $add($N + 1, ['scope' => $scope, 'date' => $date, 'owners' => $owners]));
        $closed = $run($withPeriod, $complete($N + 1, 1, true));
        check(count(array_filter($closed['tasks'], fn($t) => $t['scope'] === 'day' && $t['date'] === $date && !$t['done'] && $t['owners'] === ['alex'])) === $N, "$scope: Alex's day is full");
        $reopened = $run($closed, $complete($N + 1, 2, false))['tasks'][$id($N + 1)];
        check($reopened['done'] === false && $reopened['revision'] === 3, "$scope (" . implode('+', $owners) . "): reopening is not held against the full day that shares its date");
    }
}
// A retry of the add that filled the list is judged by the retry rule, before the cap.
check($run($capped, $add($N)) === $capped && $run($capped, $add(1)) === $capped, 'a retry of an add never fails against the cap it filled');
// Linked to-dos count for both owners.
$alex5 = $many(harness_db(), 1, $N - 1);
$withLinked = $run($alex5, $add($N, ['owners' => ['alex', 'sam']]));
check($isLimit($caught(fn() => $run($withLinked, $add($N + 1))), 'dayTodosPerList'), 'a linked to-do fills Alex\'s list');
check(isset($run($withLinked, $add($N + 1, ['owners' => ['sam']]))['tasks'][$id($N + 1)]), 'and counts once for Sam');
$e = $caught(fn() => $run($withLinked, $add($N + 1, ['owners' => ['alex', 'sam']])));
check($isLimit($e, 'dayTodosPerList') && $e->getMessage() === "Alex already has $N things to do that day.", 'a linked add needs room in both lists (Alex is full)');
$samFull = $many($alex5, $N, 2 * $N - 1, ['owners' => ['sam']]);
$e = $caught(fn() => $run($samFull, $add(2 * $N, ['owners' => ['alex', 'sam']])));
check($isLimit($e, 'dayTodosPerList') && str_starts_with($e->getMessage(), 'Sam already has'), 'a linked add needs room in both lists (Sam is full)');
check(isset($run($alex5, $add($N + 1, ['owners' => ['alex', 'sam']]))['tasks'][$id($N + 1)]), 'a linked add with room in both');
// Completing a linked to-do frees room in both lists.
$doneLinked = $run($withLinked, $complete($N, 1, true), 'sam');
check(isset($run($doneLinked, $add($N + 1))['tasks'][$id($N + 1)]) && isset($run($doneLinked, $add($N + 2, ['owners' => ['sam']]))['tasks'][$id($N + 2)]), 'completing a linked to-do frees both lists');

// ---- Edit against the day cap: only an edit that newly counts the to-do in a full list is refused ----
check($run($capped, $edit(1, 1, ['title' => 'Renamed']))['tasks'][$id(1)]['title'] === 'Renamed', 'editing a to-do of a full list works');
$samOne = $run($capped, $add($N + 1, ['owners' => ['sam']]));
$e = $caught(fn() => $run($samOne, $edit($N + 1, 1, ['owners' => ['alex']])));
check($isLimit($e, 'dayTodosPerList'), 'moving a to-do into a full list is a limit');
$e = $caught(fn() => $run($samOne, $edit($N + 1, 1, ['owners' => ['alex', 'sam']])));
check($isLimit($e, 'dayTodosPerList'), 'adding Alex to a to-do is a limit when Alex is full');
// The caps are tuning values: a list already over one (after a change of constant) stays editable; only newly counted entries are refused.
$over = $capped;
$over['tasks'][$id($N + 1)] = harness_stamp(['id' => $id($N + 1), 'scope' => 'day', 'date' => $day, 'owners' => ['alex'], 'title' => 'Over the cap', 'done' => false, 'pos' => 9000]);
check($run($over, $edit($N + 1, 1, ['title' => 'Renamed']))['tasks'][$id($N + 1)]['title'] === 'Renamed', 'a list over the day cap stays editable');
check($run($over, $edit(1, 1, ['title' => 'Renamed']))['tasks'][$id(1)]['title'] === 'Renamed', 'in any of its rows');
refuses(fn() => $run($over, $add($N + 2)), 409, 'limit');
$linkedFull = $run($alex5, $add($N, ['owners' => ['alex', 'sam']]));
check($run($linkedFull, $edit($N, 1, ['owners' => ['alex', 'sam'], 'title' => 'Kept both']))['tasks'][$id($N)]['title'] === 'Kept both', 'a linked to-do stays editable in full lists');
check($run($linkedFull, $edit($N, 1, ['owners' => ['sam']]))['tasks'][$id($N)]['owners'] === ['sam'], 'leaving a list is never capped');
$emptyDay = $run($capped, $add($N + 1, ['date' => '2026-11-03']));
$e = $caught(fn() => $run($emptyDay, $edit($N + 1, 1, ['date' => $day])));
check($isLimit($e, 'dayTodosPerList'), 'moving a to-do to a full day is a limit');
check($run($emptyDay, $edit(1, 1, ['date' => '2026-11-03']))['tasks'][$id(1)]['date'] === '2026-11-03', 'moving a to-do away from a full day to a free one works');
$samCapped = $many($run($capped, $complete(1, 1, true)), $N + 1, 2 * $N, ['owners' => ['sam']]);
check($run($samCapped, $edit(1, 2, ['owners' => ['sam']]))['tasks'][$id(1)]['owners'] === ['sam'], 'a done to-do changes owner into a full list: it is not counted');
$sevenDone = $run($run($capped, $complete(1, 1, true)), $add($N + 1)); // alex: the cap's worth open, 1 done
check($run($sevenDone, $edit(1, 2, ['title' => 'Still done']))['tasks'][$id(1)]['done'] === true, 'editing a done to-do in a full list works');

// ---- Week and month cap: 200 rows per list and period, done or not ----
$cap = PlanMind\LIMITS['periodTodosPerList'];
$period = function (string $scope, string $date, array $owners, int $count) use ($id): array {
    $db = fresh_db();
    for ($i = 1; $i <= $count; ++$i) {
        $db['tasks'][harness_id(5000 + $i)] = harness_stamp(['id' => harness_id(5000 + $i), 'scope' => $scope, 'date' => $date, 'owners' => $owners, 'title' => "Row $i", 'done' => $i % 2 === 0, 'pos' => 1024 * $i]);
    }
    return $db;
};
foreach ([['week', '2026-11-02', 'week'], ['month', '2026-11-01', 'month']] as [$scope, $date, $word]) {
    $under = $period($scope, $date, ['alex'], $cap - 1);
    check(isset($run($under, $add(1, ['scope' => $scope, 'date' => $date]))['tasks'][$id(1)]), "$scope: the 200th row fits");
    $atCap = $period($scope, $date, ['alex'], $cap);
    $e = $caught(fn() => $run($atCap, $add(1, ['scope' => $scope, 'date' => $date])));
    check($isLimit($e, 'periodTodosPerList') && $e->getMessage() === "Alex already has 200 to-dos for that $word.", "$scope: the 201st is a limit, done rows included");
    check(isset($run($atCap, $add(1, ['scope' => $scope, 'date' => $date, 'owners' => ['sam']]))['tasks'][$id(1)]), "$scope: another list has room");
    check(isset($run($atCap, $add(1, ['scope' => $scope, 'date' => $scope === 'week' ? '2026-11-09' : '2026-12-01']))['tasks'][$id(1)]), "$scope: another period has room");
    check(isset($run($atCap, $add(1, ['scope' => 'day', 'date' => $date]))['tasks'][$id(1)]), "$scope: the day is separate");
    check($isLimit($caught(fn() => $run($atCap, $add(1, ['scope' => $scope, 'date' => $date, 'owners' => ['alex', 'sam']]))), 'periodTodosPerList'), "$scope: a linked row needs room for both");
    $rowEdit = ['action' => 'edit', 'kind' => 'todo', 'id' => harness_id(5001), 'revision' => 1, 'date' => $date, 'owners' => ['alex'], 'title' => 'Renamed'];
    check($run($atCap, $rowEdit)['tasks'][harness_id(5001)]['title'] === 'Renamed', "$scope: a full list stays editable");
    $overCap = $period($scope, $date, ['alex'], $cap + 1);
    check($run($overCap, ['action' => 'edit', 'kind' => 'todo', 'id' => harness_id(5001), 'revision' => 1, 'date' => $date, 'owners' => ['alex'], 'title' => 'Renamed'])['tasks'][harness_id(5001)]['title'] === 'Renamed', "$scope: a list over the cap stays editable");
    $samRow = $run($atCap, $add(1, ['scope' => $scope, 'date' => $date, 'owners' => ['sam']]));
    $e = $caught(fn() => $run($samRow, $edit(1, 1, ['date' => $date, 'owners' => ['alex', 'sam']])));
    check($isLimit($e, 'periodTodosPerList'), "$scope: adding a full list to a row is a limit");
    check($run($atCap, ['action' => 'complete', 'id' => harness_id(5001), 'revision' => 1, 'done' => true])['tasks'][harness_id(5001)]['done'] === true, "$scope: completing is never capped");
    $reopen = ['action' => 'complete', 'id' => harness_id(5002), 'revision' => 1, 'done' => false];
    check($run($atCap, $reopen)['tasks'][harness_id(5002)]['done'] === false, "$scope: reopening is never capped (only the day cap counts open rows)");
}
// A retry at the cap is still a retry.
$at199 = $period('week', '2026-11-02', ['alex'], $cap - 1);
$at200 = $run($at199, $add(1, ['scope' => 'week']));
check($run($at200, $add(1, ['scope' => 'week'])) === $at200, 'a retry of the add that filled a week is a no-op');

// ---- pos: appended at the end of the (scope, date) bucket across every list ----
$a = $run($run($run(harness_db(), $add(1)), $add(2, ['owners' => ['sam']])), $add(3, ['owners' => ['alex', 'sam']]));
check([$a['tasks'][$id(1)]['pos'], $a['tasks'][$id(2)]['pos'], $a['tasks'][$id(3)]['pos']] === [1024, 2048, 3072], 'new to-dos go to the end of the day, whoever they are for');
$other = $run($a, $add(4, ['date' => '2026-11-03']));
$weekly = $run($other, $add(5, ['scope' => 'week']));
check($other['tasks'][$id(4)]['pos'] === 1024 && $weekly['tasks'][$id(5)]['pos'] === 1024, 'each (scope, date) has its own order');
// A to-do that changes day joins the end of the new day.
$moved = $run($weekly, $edit(1, 1, ['date' => '2026-11-03']));
check($moved['tasks'][$id(1)]['pos'] === 2048 && $moved['tasks'][$id(4)]['pos'] === 1024 && $moved['tasks'][$id(2)]['pos'] === 2048, 'a to-do edited onto another day goes to its end');
$sameDay = $run($weekly, $edit(1, 1, ['title' => 'Renamed']));
check($sameDay['tasks'][$id(1)]['pos'] === 1024 && $sameDay['tasks'][$id(1)]['done'] === false && $sameDay['tasks'][$id(1)]['scope'] === 'day', 'an edit on the same day keeps pos, done and scope');

// ---- 9. moveTodo ----
$abcd = $many(harness_db(), 1, 4); // A, B, C, D at 1024, 2048, 3072, 4096
$order = fn(array $db, string $scope = 'day', string $date = '2026-11-02') => (function () use ($db, $scope, $date) {
    $rows = array_filter($db['tasks'], fn($t) => $t['scope'] === $scope && $t['date'] === $date);
    usort($rows, fn($x, $y) => [$x['pos'], $x['id']] <=> [$y['pos'], $y['id']]);
    return array_map(fn($t) => $t['title'], $rows);
})();
$names = fn(array $titles) => array_values($titles);
check($names($order($abcd)) === ['Item 1', 'Item 2', 'Item 3', 'Item 4'], 'the starting order');
$m = $run($abcd, $move(4, 1, 2));
check($names($order($m)) === ['Item 1', 'Item 4', 'Item 2', 'Item 3'] && $m['tasks'][$id(4)]['pos'] === 1536, 'D before B lands at the midpoint');
check($m['tasks'][$id(4)]['revision'] === 2 && $m['tasks'][$id(4)]['updatedBy'] === 'alex' && $m['revision'] === $abcd['revision'] + 1, 'the moved to-do is revision + 1 and the write is one global revision');
foreach ([1, 2, 3] as $n) { check($m['tasks'][$id($n)] === $abcd['tasks'][$id($n)], "neighbour $n is untouched"); }
$toEnd = $run($abcd, $move(1, 1, null), 'sam');
check($names($order($toEnd)) === ['Item 2', 'Item 3', 'Item 4', 'Item 1'] && $toEnd['tasks'][$id(1)]['pos'] === 5120 && $toEnd['tasks'][$id(1)]['updatedBy'] === 'sam', 'to the end: last + gap');
$toStart = $run($abcd, $move(4, 1, 1));
check($names($order($toStart)) === ['Item 4', 'Item 1', 'Item 2', 'Item 3'] && $toStart['tasks'][$id(4)]['pos'] === 512, 'to the start: half the first position');
$middle = $run($abcd, $move(1, 1, 4));
check($names($order($middle)) === ['Item 2', 'Item 3', 'Item 1', 'Item 4'] && $middle['tasks'][$id(1)]['pos'] === 3584, 'forward over two others');
// Midpoints are floored.
$odd = $abcd; $odd['tasks'][$id(1)]['pos'] = 1000; $odd['tasks'][$id(2)]['pos'] = 1003;
check($run($odd, $move(3, 1, 2))['tasks'][$id(3)]['pos'] === 1001, 'the midpoint of 1000 and 1003 is 1001');
$two = $abcd; $two['tasks'][$id(1)]['pos'] = 1000; $two['tasks'][$id(2)]['pos'] = 1002;
$r = $run($two, $move(3, 1, 2));
check($r['tasks'][$id(3)]['pos'] === 1001 && $r['tasks'][$id(1)]['pos'] === 1000 && $r['tasks'][$id(2)]['pos'] === 1002, 'a gap of 2 still has a free place');
// No room: renumber the bucket in the new order, neighbours keep their revisions.
$tight = $abcd; $tight['tasks'][$id(1)]['pos'] = 1024; $tight['tasks'][$id(2)]['pos'] = 1025; $tight['tasks'][$id(3)]['pos'] = 5000; $tight['tasks'][$id(4)]['pos'] = 6000;
$r = $run($tight, $move(3, 1, 2));
check($names($order($r)) === ['Item 1', 'Item 3', 'Item 2', 'Item 4'], 'the new order after a forced renumber');
check(array_map(fn($n) => $r['tasks'][$id($n)]['pos'], [1, 3, 2, 4]) === [1024, 2048, 3072, 4096], 'the bucket is renumbered to multiples of the gap');
check($r['tasks'][$id(3)]['revision'] === 2 && $r['tasks'][$id(1)]['revision'] === 1 && $r['tasks'][$id(2)]['revision'] === 1 && $r['tasks'][$id(4)]['revision'] === 1
    && $r['tasks'][$id(1)]['updatedAt'] === $tight['tasks'][$id(1)]['updatedAt'] && $r['revision'] === $tight['revision'] + 1, 'a renumber bumps only the moved to-do and the global revision once');
$front = $abcd; $front['tasks'][$id(1)]['pos'] = 1;
$r = $run($front, $move(4, 1, 1));
check($names($order($r)) === ['Item 4', 'Item 1', 'Item 2', 'Item 3'] && $r['tasks'][$id(4)]['pos'] === 1024 && $r['tasks'][$id(1)]['pos'] === 2048, 'no room before position 1: renumber');
$tied = $abcd; $tied['tasks'][$id(1)]['pos'] = 1000; $tied['tasks'][$id(2)]['pos'] = 1000;
$r = $run($tied, $move(3, 1, 2));
check($names($order($r)) === ['Item 1', 'Item 3', 'Item 2', 'Item 4'] && $r['tasks'][$id(1)]['pos'] === 1024 && $r['tasks'][$id(2)]['pos'] === 3072, 'tied positions are renumbered');
// The order covers every to-do of the bucket, whatever list it is for and whatever the viewer filters.
$mixed = $run($run($run($run($run(harness_db(), $add(1, ['owners' => ['alex']])), $add(2, ['owners' => ['sam']])), $add(3, ['owners' => ['alex']])), $add(4, ['owners' => ['sam']])), $add(5, ['owners' => ['alex', 'sam']]));
$r = $run($mixed, $move(5, 1, 3), 'alex');
check($names($order($r)) === ['Item 1', 'Item 2', 'Item 5', 'Item 3', 'Item 4'], 'placed before Alex\'s second to-do but after Sam\'s in between');
check($r['tasks'][$id(5)]['pos'] === intdiv($mixed['tasks'][$id(2)]['pos'] + $mixed['tasks'][$id(3)]['pos'], 2), 'the predecessor is the neighbour in the whole bucket');
// Done to-dos take part too.
$withDone = $run($abcd, $complete(2, 1, true));
$r = $run($withDone, $move(4, 1, 2));
check($names($order($r)) === ['Item 1', 'Item 4', 'Item 2', 'Item 3'], 'a to-do can be placed before a done one');
// Already in place: success, nothing written, whatever the revision.
check($run($abcd, $move(2, 1, 3)) === $abcd && $run($abcd, $move(4, 1, null)) === $abcd && $run($abcd, $move(2, 1, 2)) === $abcd, 'in place, last to the end, before itself: no-ops');
check($run($abcd, $move(1, 1, 2)) === $abcd, 'the first before the second is in place');
check($run($m, $move(4, 1, 2)) === $m && $run($toEnd, $move(1, 1, null), 'alex') === $toEnd, 'a retry after a lost response is a no-op');
// Stale and invalid.
refuses(fn() => $run($abcd, $move(4, 7, 2)), 409, 'stale');
refuses(fn() => $run($m, $move(4, 1, 3)), 409, 'stale');
foreach ([0, -1] as $bad) { refuses(fn() => $run($abcd, $move(4, $bad, 2)), 400, 'invalid'); }
refuses(fn() => $run($abcd, ['action' => 'moveTodo', 'id' => $id(4), 'revision' => '1', 'before' => $id(2)]), 400, 'invalid');
foreach (['abc', '', 5, [], true, $id(2) . 'x'] as $bad) { refuses(fn() => $run($abcd, ['action' => 'moveTodo', 'id' => $id(4), 'revision' => 1, 'before' => $bad]), 400, 'invalid'); }
refuses(fn() => $run($abcd, ['action' => 'moveTodo', 'id' => $id(4), 'revision' => 1]), 400, 'invalid');
refuses(fn() => $run($abcd, $move(4, 1, 2) + ['extra' => 1]), 400, 'invalid');
refuses(fn() => $run($abcd, ['action' => 'moveTodo', 'revision' => 1, 'before' => null]), 400, 'invalid');
// Another bucket is a mistake of the caller; a removed to-do is gone.
$buckets = $run($run($run($abcd, $add(5, ['date' => '2026-11-03'])), $add(6, ['scope' => 'week'])), $add(7, ['scope' => 'month', 'date' => '2026-11-01']));
refuses(fn() => $run($buckets, $move(4, 1, 5)), 400, 'invalid');
refuses(fn() => $run($buckets, $move(4, 1, 6)), 400, 'invalid');
refuses(fn() => $run($buckets, $move(4, 1, 7)), 400, 'invalid');
refuses(fn() => $run($buckets, $move(5, 1, 1)), 400, 'invalid');
refuses(fn() => $run($abcd, $move(4, 1, 9)), 409, 'gone');
refuses(fn() => $run($abcd, $move(9, 1, 1)), 409, 'gone');
// Only to-dos have this order.
$ev = $run($abcd, ['action' => 'add', 'kind' => 'event', 'id' => $id(20), 'date' => $day, 'owners' => ['alex'], 'text' => 'x', 'start' => 600]);
refuses(fn() => $run($ev, ['action' => 'moveTodo', 'id' => $id(20), 'revision' => 1, 'before' => $id(1)]), 400, 'invalid');
// The other buckets keep their order when one moves.
check($order($run($buckets, $move(4, 1, 1)), 'week') === $order($buckets, 'week') && $order($run($buckets, $move(4, 1, 1)), 'day', '2026-11-03') === $order($buckets, 'day', '2026-11-03'), 'other buckets are untouched');
// Repeated moves to the front halve the gap and then renumber without losing the order.
$deck = $abcd;
for ($i = 0; $i < 14; ++$i) {
    $rows = array_values(array_filter($deck['tasks'], fn($t) => $t['date'] === $day));
    usort($rows, fn($x, $y) => [$x['pos'], $x['id']] <=> [$y['pos'], $y['id']]);
    $last = $rows[3];
    $deck = $run($deck, ['action' => 'moveTodo', 'id' => $last['id'], 'revision' => $last['revision'], 'before' => $rows[0]['id']]);
    $positions = array_map(fn($t) => $t['pos'], array_filter($deck['tasks'], fn($t) => $t['date'] === $day));
    check(count(array_unique($positions)) === 4, "move $i keeps four distinct positions");
}
check($names($order($deck)) === ['Item 3', 'Item 4', 'Item 1', 'Item 2'], 'fourteen last-to-front moves rotate the order by two');

// ---- Complete: revision, no-op, input shape ----
$c = $run($abcd, $complete(1, 1, true));
check($c['tasks'][$id(1)]['done'] === true && $c['tasks'][$id(1)]['revision'] === 2 && $c['tasks'][$id(1)]['pos'] === 1024, 'completing keeps the position');
check($run($c, $complete(1, 2, true)) === $c, 'completing a done to-do changes nothing');
refuses(fn() => $run($c, $complete(1, 1, false)), 409, 'stale');
