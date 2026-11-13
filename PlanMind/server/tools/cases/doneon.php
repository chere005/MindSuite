<?php
declare(strict_types=1);
// Where a to-do was done (Alex, 2026-11-02): checking a day to-do may carry `doneOn`, the date of the page it was ticked on, which is its own date or
// the server's today (a carried row ticked on today's Day). The Day shows it checked on that day and unchecked, pointing there, on its own day.
// Unchecking removes it; moving a done to-do to another day makes it done on that day; only a done day to-do can hold one.
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, open_count, snapshot, validate_db};

$TODAY = '2026-11-02';           // a Monday
$OLD = '2026-10-27';             // an earlier day, carried onto it
$YESTERDAY = '2026-11-01';
$FUTURE = '2026-11-05';
$id = fn(int $n) => harness_id(700 + $n);
$run = fn(array $db, array $input, ?string $today = '2026-11-02', string $user = 'alex') => mutate($db, $input, $user, $today);
$put = function (array $db, int $n, string $date, array $owners = ['alex'], bool $done = false, string $scope = 'day', array $more = []) use ($id): array {
    $db['tasks'][$id($n)] = harness_stamp(['id' => $id($n), 'scope' => $scope, 'date' => $date, 'owners' => $owners, 'title' => "Item $n", 'done' => $done, 'pos' => $n * 1024] + $more);
    return $db;
};
$tick = fn(int $n, int $rev, array $more = []) => ['action' => 'complete', 'id' => $id($n), 'revision' => $rev, 'done' => true] + $more;
$untick = fn(int $n, int $rev) => ['action' => 'complete', 'id' => $id($n), 'revision' => $rev, 'done' => false];
$edit = fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'todo', 'id' => $id($n), 'revision' => $rev, 'date' => $OLD, 'owners' => ['alex'], 'title' => "Item $n"];
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};

// ---- 1. Ticking: doneOn is the page the tick came from ----
$db = $put($put($put(fresh_db(), 1, $OLD), 2, $TODAY), 3, $FUTURE);
$carried = $run($db, $tick(1, 1, ['doneOn' => $TODAY]));
$t = $carried['tasks'][$id(1)];
check($t['done'] === true && $t['doneOn'] === $TODAY && $t['date'] === $OLD && $t['revision'] === 2 && $t['updatedBy'] === 'alex', 'a carried to-do ticked on today is done, keeps its own day and records today');
check($carried['revision'] === $db['revision'] + 1, 'one global revision');
check(open_count($carried, 'alex', $TODAY, null, $TODAY) === 1 && open_count($db, 'alex', $TODAY, null, $TODAY) === 2, 'it is no longer an open row of today\'s list');
check(open_count($carried, 'alex', $OLD, null, $TODAY) === 0, 'nor of its own day: it is done');
$own = $run($db, $tick(1, 1, ['doneOn' => $OLD]));
check($own['tasks'][$id(1)]['doneOn'] === $OLD && $own['tasks'][$id(1)]['done'] === true, 'ticked on its own day it records its own day');
check($run($db, $tick(2, 1, ['doneOn' => $TODAY]), $TODAY)['tasks'][$id(2)]['doneOn'] === $TODAY, 'today\'s own to-do ticked on today: its own day is today');
$legacy = $run($db, $tick(1, 1));
check($legacy['tasks'][$id(1)]['done'] === true && !array_key_exists('doneOn', $legacy['tasks'][$id(1)]), 'ticked with no doneOn (a client of 0.13.0) it is done on its own day, as before');
check($run($db, $tick(3, 1, ['doneOn' => $FUTURE]))['tasks'][$id(3)]['doneOn'] === $FUTURE, 'a to-do of a later day ticked on its own later page records that day');
check($run($db, $tick(1, 1, ['doneOn' => $OLD]), null)['tasks'][$id(1)]['doneOn'] === $OLD, 'without a today (no clock) its own day is still allowed');
validate_db($carried);
check(snapshot($carried, 'sam')['tasks'][0]['doneOn'] === $TODAY, 'the snapshot carries it to both people');
check($carried['tasks'][$id(1)]['ak'] === $db['tasks'][$id(1)]['ak'], 'the creation fingerprint does not change');
// A linked to-do is one record.
$linked = $put(fresh_db(), 4, $OLD, ['alex', 'sam']);
check($run($linked, $tick(4, 1, ['doneOn' => $TODAY]), $TODAY, 'sam')['tasks'][$id(4)]['doneOn'] === $TODAY, 'the other person can tick a linked to-do carried onto today');

// ---- 2. Refusals: 400 invalid, nothing written ----
$refusals = [
    'yesterday, which is neither its day nor today' => $tick(1, 1, ['doneOn' => $YESTERDAY]),
    'a later day than today' => $tick(1, 1, ['doneOn' => $FUTURE]),
    'a day before its own' => $tick(1, 1, ['doneOn' => '2026-10-20']),
    'not a date' => $tick(1, 1, ['doneOn' => 'today']),
    'an impossible date' => $tick(1, 1, ['doneOn' => '2026-02-30']),
    'a number' => $tick(1, 1, ['doneOn' => 20261102]),
    'null' => $tick(1, 1, ['doneOn' => null]),
    'a list' => $tick(1, 1, ['doneOn' => [$TODAY]]),
    'unchecking with a day' => $untick(1, 1) + ['doneOn' => $TODAY],
    'a field it does not know' => $tick(1, 1, ['when' => $TODAY]),
];
foreach ($refusals as $what => $input) {
    $e = $caught(fn() => $run($db, $input));
    check($e->status === 400 && $e->errorCode === 'invalid', "doneOn: $what is refused as invalid");
}
$e = $caught(fn() => $run($db, $tick(1, 1, ['doneOn' => $TODAY]), $YESTERDAY));
check($e->status === 400 && $e->errorCode === 'invalid', 'today is the server\'s today: a page from a clock that is a day off is refused');
$e = $caught(fn() => $run($db, $tick(1, 1, ['doneOn' => $TODAY]), null));
check($e->status === 400, 'without a today only the to-do\'s own day is allowed');
$e = $caught(fn() => $run($db, $tick(3, 1, ['doneOn' => $TODAY])));
check($e->status === 400 && $e->errorCode === 'invalid', 'a to-do of a later day cannot be ticked on today: that is before its own day');
$byScope = $put($put(fresh_db(), 5, '2026-10-26', ['alex'], false, 'week'), 6, '2026-11-01', ['alex'], false, 'month');
foreach ([5 => '2026-10-26', 6 => '2026-11-01'] as $n => $day) {
    $e = $caught(fn() => $run($byScope, $tick($n, 1, ['doneOn' => $day])));
    check($e->status === 400 && $e->errorCode === 'invalid', 'a week or month to-do has no day it was done on');
    check($run($byScope, $tick($n, 1))['tasks'][$id($n)]['done'] === true, 'and is ticked without one as before');
}
$e = $caught(fn() => $run($db, $tick(1, 7, ['doneOn' => $TODAY])));
check($e->status === 409 && $e->errorCode === 'stale', 'a stale tick is stale');
check($caught(fn() => $run($db, $tick(404, 1, ['doneOn' => $TODAY])))->errorCode === 'gone', 'a removed to-do is gone');

// ---- 3. A repeat of a tick, and unchecking ----
check($run($carried, $tick(1, 2, ['doneOn' => $TODAY])) === $carried, 'ticking what is done changes nothing (a retry)');
check($run($carried, $tick(1, 2, ['doneOn' => $OLD])) === $carried, 'whatever day the repeat names: the first one stands');
check($run($carried, $tick(1, 2)) === $carried, 'and a repeat with none');
$open = $run($carried, $untick(1, 2));
check($open['tasks'][$id(1)]['done'] === false && !array_key_exists('doneOn', $open['tasks'][$id(1)]) && $open['tasks'][$id(1)]['revision'] === 3, 'unchecking removes doneOn');
check(array_diff_key($open['tasks'][$id(1)], ['revision' => 1, 'updatedAt' => 1]) === array_diff_key($db['tasks'][$id(1)], ['revision' => 1, 'updatedAt' => 1]), 'and leaves the record as it was before the tick');
check(open_count($open, 'alex', $TODAY, null, $TODAY) === 2, 'the to-do is carried onto today again');
check($run($open, $untick(1, 3)) === $open, 'unchecking what is open changes nothing');
$again = $run($open, $tick(1, 3, ['doneOn' => $TODAY]));
check($again['tasks'][$id(1)]['doneOn'] === $TODAY && $again['tasks'][$id(1)]['revision'] === 4, 'and it can be ticked again');
// A reopened to-do lands on its own day, and that day's count decides (as for any to-do of an earlier day).
$full = fresh_db();
for ($n = 10; $n < 10 + PlanMind\LIMITS['dayTodosPerList']; ++$n) { $full = $put($full, $n, $OLD); }
$full = $put($full, 1, $OLD, ['alex'], true, 'day', ['doneOn' => $TODAY]);
$e = $caught(fn() => $run($full, $untick(1, 1)));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'dayTodosPerList', 'reopening a to-do ticked on today is refused when its own day already has 13 open');
$spare = $full; unset($spare['tasks'][$id(10)]);
check($run($spare, $untick(1, 1))['tasks'][$id(1)]['done'] === false, 'and goes through with room');

// ---- 4. Editing a done to-do ----
$renamedDb = $run($carried, $edit(1, 2, ['title' => 'Renamed']));
$renamed = $renamedDb['tasks'][$id(1)];
check($renamed['title'] === 'Renamed' && $renamed['doneOn'] === $TODAY && $renamed['done'] === true && $renamed['date'] === $OLD, 'renaming it keeps the day it was done on');
$movedDb = $run($carried, $edit(1, 2, ['date' => '2026-10-29']));
$moved = $movedDb['tasks'][$id(1)];
check($moved['date'] === '2026-10-29' && $moved['done'] === true && !array_key_exists('doneOn', $moved), 'giving it another day makes it done on that day: doneOn goes');
$laterDb = $run($own, $edit(1, 2, ['date' => $YESTERDAY]));
$later = $laterDb['tasks'][$id(1)];
check($later['date'] === $YESTERDAY && !array_key_exists('doneOn', $later), 'also when the new day is after the day it was ticked on');
$sameDay = $run($carried, $edit(1, 2, ['date' => $OLD, 'owners' => ['alex'], 'title' => 'Item 1']), $TODAY);
check($sameDay === $carried, 'an edit that changes nothing writes nothing');
validate_db($renamedDb); validate_db($movedDb); validate_db($laterDb);
// A to-do without doneOn that changes day stays without one.
$plain = $put(fresh_db(), 8, $OLD, ['alex'], true);
check(!array_key_exists('doneOn', $run($plain, $edit(8, 1, ['date' => '2026-10-29']))['tasks'][$id(8)]), 'a legacy done to-do given another day is still done on its own');
// Delete takes the record.
check(!isset($run($carried, ['action' => 'delete', 'id' => $id(1), 'revision' => 2, 'confirm' => true])['tasks'][$id(1)]), 'deleting a done to-do removes it');

// ---- 5. Only a done day to-do holds one, whatever writes it ----
$bad = $carried; $bad['tasks'][$id(1)]['done'] = false;
fails(fn() => snapshot($bad, 'alex'), 'Invalid planner data');
$bad = $carried; $bad['tasks'][$id(1)]['doneOn'] = '2026-10-20';
fails(fn() => snapshot($bad, 'alex'), 'Invalid planner data');
$bad = $carried; $bad['tasks'][$id(1)]['scope'] = 'week'; $bad['tasks'][$id(1)]['date'] = '2026-10-26';
fails(fn() => snapshot($bad, 'alex'), 'Invalid planner data');
