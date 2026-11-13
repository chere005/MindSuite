<?php
declare(strict_types=1);
// The day to-do cap with Alex's carry-over (2026-10-31): the Day view of TODAY also lists the open day to-dos of earlier days, so on
// today they count against the 13 open per list, for an add, a reopen and an edit that lands on today. Any other date counts its
// own to-dos only. The date is the caller's today in the site's timezone (`today_in`), passed to mutate().
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, open_count, today_in};

$N = PlanMind\LIMITS['dayTodosPerList'];
$TODAY = '2026-11-02';           // a Monday
$OLD = '2026-10-27';             // earlier days that carry onto it
$YESTERDAY = '2026-11-01';
$FUTURE = '2026-11-05';
$run = fn(array $db, array $input, ?string $today = '2026-11-02', string $user = 'alex') => mutate($db, $input, $user, $today);
$id = fn(int $n) => harness_id(500 + $n);
$put = function (array $db, int $n, string $date, array $owners = ['alex'], bool $done = false, string $scope = 'day') use ($id): array {
    $db['tasks'][$id($n)] = harness_stamp(['id' => $id($n), 'scope' => $scope, 'date' => $date, 'owners' => $owners, 'title' => "Item $n", 'done' => $done, 'pos' => $n * 1024]);
    return $db;
};
$add = fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'todo', 'id' => $id($n), 'scope' => 'day', 'date' => $TODAY, 'owners' => ['alex'], 'title' => "Item $n"];
$edit = fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'todo', 'id' => $id($n), 'revision' => $rev, 'date' => $TODAY, 'owners' => ['alex'], 'title' => "Item $n"];
$complete = fn(int $n, int $rev, bool $done) => ['action' => 'complete', 'id' => $id($n), 'revision' => $rev, 'done' => $done];
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$isLimit = fn(RequestError $e) => $e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'dayTodosPerList';
/** Alex's list on `$TODAY`: $carried open to-dos of an earlier day (items 1..$carried) and $own of today's own (the items after them). */
$fill = function (int $carried, int $own) use ($put, $OLD, $TODAY): array {
    $db = fresh_db();
    for ($n = 1; $n <= $carried; ++$n) { $db = $put($db, $n, $OLD); }
    for ($n = 1; $n <= $own; ++$n) { $db = $put($db, $carried + $n, $TODAY); }
    return $db;
};
/** $count open to-dos for one list spread over earlier days (none of those days is full by itself). */
$spread = function (array $db, int $first, int $count, array $owners) use ($put): array {
    for ($n = $first; $n < $first + $count; ++$n) { $db = $put($db, $n, sprintf('2026-10-%02d', 10 + $n % 17), $owners); }
    return $db;
};

// ---- today_in: the caller's date in the site's timezone ----
$instant = new DateTimeImmutable('2026-11-01T03:30:00+00:00');
check(today_in('America/Chicago', $instant) === '2026-10-31', 'it is still Saturday evening in Chicago');
check(today_in('Pacific/Auckland', $instant) === '2026-11-01', 'and already Sunday in Auckland');
check(today_in('UTC', $instant) === '2026-11-01', 'UTC');
// Chicago leaves daylight time on 2026-11-01 at 2:00: the date does not change at the switch, only at midnight.
check(today_in('America/Chicago', new DateTimeImmutable('2026-11-01T05:30:00+00:00')) === '2026-11-01'
    && today_in('America/Chicago', new DateTimeImmutable('2026-11-01T06:59:00+00:00')) === '2026-11-01', 'the daylight saving switch stays on one date');
check(today_in('America/Chicago', new DateTimeImmutable('2026-11-02T05:59:00+00:00')) === '2026-11-01'
    && today_in('America/Chicago', new DateTimeImmutable('2026-11-02T06:00:00+00:00')) === '2026-11-02', 'midnight in Chicago after the switch is 06:00 UTC');
check(preg_match('/^20\d\d-\d\d-\d\d$/D', today_in('America/Chicago')) === 1, 'without an instant it reads now');
fails(fn() => today_in('Not/AZone', $instant));

// ---- open_count: carried onto today only ----
$db = $put($put($put($put($put(fresh_db(), 1, $OLD), 2, $YESTERDAY), 3, $TODAY), 4, $FUTURE), 5, $OLD, ['alex'], true);
$db = $put($put($put($db, 6, '2026-10-26', ['alex'], false, 'week'), 7, '2026-10-01', ['alex'], false, 'month'), 8, $OLD, ['alex', 'sam']);
check(open_count($db, 'alex', $TODAY, null) === 1, 'without a today a date counts its own to-dos only');
check(open_count($db, 'alex', $TODAY, null, $TODAY) === 4, 'on today it counts the open to-dos of earlier days too: the old one, the linked one, yesterday\'s and today\'s own');
check(open_count($db, 'sam', $TODAY, null, $TODAY) === 1, 'a linked to-do carries for each of its owners');
check(open_count($db, 'alex', $TODAY, $id(1), $TODAY) === 3, 'the to-do being edited is left out');
check(open_count($db, 'alex', $YESTERDAY, null, $TODAY) === 1, 'a past day counts its own only');
check(open_count($db, 'alex', $FUTURE, null, $TODAY) === 1, 'a future day counts its own only');
check(open_count($db, 'alex', $TODAY, null, $YESTERDAY) === 1, 'a today that is not the counted date carries nothing onto it');

// ---- add ----
$full = $fill(6, $N - 6);
check(open_count($full, 'alex', $TODAY, null, $TODAY) === $N, 'six carried and seven of today\'s own make 13');
$e = $caught(fn() => $run($full, $add(99)));
check($isLimit($e) && $e->getMessage() === "Alex already has $N things to do that day.", 'the 14th open to-do on today is refused, carried ones counted');
check($e->body() === ['error' => "Alex already has $N things to do that day.", 'code' => 'limit', 'cap' => 'dayTodosPerList'], 'with the cap name in the body');
check(isset($run($fill(0, $N - 1), $add(99))['tasks'][$id(99)]), 'twelve of today\'s own leave room for the 13th');
$mixed = $fill(5, $N - 6);
check(isset($run($mixed, $add(99))['tasks'][$id(99)]), 'twelve in all, carried and own, leave room for the 13th');
check($isLimit($caught(fn() => $run($run($mixed, $add(99)), $add(98)))), 'and the one after is refused');
check(isset($run($full, $add(99), null)['tasks'][$id(99)]), 'a caller without a today counts own to-dos only (the carry-over needs the date)');
check(isset($run($full, $add(99), '2026-11-03', 'alex')['tasks'][$id(99)]), 'a today that is another day than the added one does not carry onto it');
// Other dates, other lists, other scopes.
foreach ([['a later day', $FUTURE], ['yesterday', $YESTERDAY], ['the day a to-do was carried from', $OLD]] as [$what, $date]) {
    check(isset($run($full, $add(99, ['date' => $date]))['tasks'][$id(99)]), "$what counts its own to-dos only");
}
check(isset($run($full, $add(99, ['owners' => ['sam']]))['tasks'][$id(99)]), 'another person has room');
check(isset($run($full, $add(99, ['scope' => 'week', 'date' => $TODAY]))['tasks'][$id(99)]), 'a week to-do is not a day to-do');
// By decision (Alex, 2026-10-31) a write is judged by the day it lands on: an add, a reopen or a date edit onto an EARLIER day does not
// look at today's count, so it can take today over 13 (today lists 13 slots and "+N more"). Only time passing did that before.
check(open_count($run($full, $add(99, ['date' => $YESTERDAY])), 'alex', $TODAY, null, $TODAY) === $N + 1, 'an add on an earlier day is carried onto a full today, which then shows +1 more');
// The carried ones alone can fill a list.
$carriedOnly = $fill($N, 0);
check($isLimit($caught(fn() => $run($carriedOnly, $add(99)))), '13 carried to-dos fill today although today has none of its own');
check(isset($run($carriedOnly, $add(99, ['date' => $YESTERDAY]))['tasks'][$id(99)]), 'yesterday is not full');
// A linked add needs room in both lists, counting the carried ones of each.
$samFull = $spread($fill(0, 3), 20, $N, ['sam']);
$e = $caught(fn() => $run($samFull, $add(99, ['owners' => ['alex', 'sam']])));
check($isLimit($e) && str_starts_with($e->getMessage(), 'Sam already has'), 'a linked add is refused when Sam\'s carried to-dos fill her list');
check(isset($run($samFull, $add(99, ['owners' => ['alex']]))['tasks'][$id(99)]), 'though Alex has room');
// A done to-do is not carried, and completing a carried one frees room.
check(isset($run($put($fill(0, $N - 1), 80, $OLD, ['alex'], true), $add(99))['tasks'][$id(99)]), 'an old done to-do is not counted on today');
check(isset($run($run($full, $complete(1, 1, true)), $add(99))['tasks'][$id(99)]), 'completing a carried to-do makes room on today');
// A retry of an add that filled the list is judged by the retry rule, before the cap.
$filled = $run($mixed, $add(99));
check($run($filled, $add(99)) === $filled, 'a retry never fails against the cap it filled');

// ---- reopen ----
$withDone = $put($full, 90, $TODAY, ['alex'], true);
check($isLimit($caught(fn() => $run($withDone, $complete(90, 1, false)))), 'reopening today\'s own done to-do is refused when carried and own fill the list');
check($run($withDone, $complete(90, 1, false), null)['tasks'][$id(90)]['done'] === false, 'without a today it counts own to-dos only');
check($run($run($withDone, $complete(1, 1, true)), $complete(90, 1, false))['tasks'][$id(90)]['done'] === false, 'room made by completing a carried one lets the reopen through');
check($run($put($full, 91, $OLD, ['alex'], true), $complete(91, 1, false))['tasks'][$id(91)]['done'] === false, 'reopening a done to-do of an earlier day is judged on its own day, not on today');
check($run($put($full, 92, $FUTURE, ['alex'], true), $complete(92, 1, false))['tasks'][$id(92)]['done'] === false, 'and one of a later day on its own');
check($run($full, $complete(1, 1, true))['tasks'][$id(1)]['done'] === true, 'completing a carried to-do is never capped');

// ---- edit ----
// A to-do already counted on today (carried or its own) is editable in a full list, and keeps the date it has.
$renamed = $run($full, $edit(1, 1, ['date' => $OLD, 'title' => 'Renamed']))['tasks'][$id(1)];
check($renamed['title'] === 'Renamed' && $renamed['date'] === $OLD, 'a carried to-do can be renamed in a full list and stays on its own day');
check($run($full, $edit(7, 1, ['title' => 'Renamed']))['tasks'][$id(7)]['title'] === 'Renamed', 'so can one of today\'s own');
// Dating a carried to-do to today in place changes nothing about the count.
$moved = $run($full, $edit(1, 1, ['date' => $TODAY]))['tasks'][$id(1)];
check($moved['date'] === $TODAY && $moved['revision'] === 2, 'a carried to-do dated to today in place is allowed in a full list');
// Time alone can leave today over the cap (yesterday's 13 open plus a few of today's own): such a list stays editable, and a carried
// to-do can still be dated to today, since today already shows it.
$over = $fill(7, $N - 6);
check(open_count($over, 'alex', $TODAY, null, $TODAY) === $N + 1, 'carried and own can add up to more than 13 without any write');
check($run($over, $edit(1, 1, ['date' => $TODAY]))['tasks'][$id(1)]['date'] === $TODAY, 'a carried to-do dated to today in an over-full list');
check($run($over, $edit(1, 1, ['date' => $OLD, 'title' => 'Renamed']))['tasks'][$id(1)]['title'] === 'Renamed', 'and renamed there');
check($isLimit($caught(fn() => $run($over, $add(99)))), 'but no new one is added');
// A to-do from a day that does not carry (a later one) landing on today is newly counted there.
$future = $put($full, 93, $FUTURE);
check($isLimit($caught(fn() => $run($future, $edit(93, 1, ['date' => $TODAY])))), 'moving a to-do of a later day onto a full today is refused');
check(isset($run($future, $edit(93, 1, ['date' => $TODAY]), null)['tasks'][$id(93)]), 'without a today the carried to-dos are not counted');
check($run($run($future, $complete(2, 1, true)), $edit(93, 1, ['date' => $TODAY]))['tasks'][$id(93)]['date'] === $TODAY, 'with room it lands');
check($run($put($full, 95, $FUTURE, ['alex'], true), $edit(95, 1, ['date' => $TODAY]))['tasks'][$id(95)]['date'] === $TODAY, 'a done to-do is not counted, so it lands too');
// Any other landing day is judged by that day alone.
check($run($full, $edit(1, 1, ['date' => $YESTERDAY]))['tasks'][$id(1)]['date'] === $YESTERDAY, 'a carried to-do moved to another earlier day');
check($run($full, $edit(7, 1, ['date' => $FUTURE]))['tasks'][$id(7)]['date'] === $FUTURE, 'one of today\'s own moved to a later day');
// A to-do given a second owner is newly counted in that list, carried ones included.
$alex = $put($samFull, 94, $TODAY, ['alex']);
$e = $caught(fn() => $run($alex, $edit(94, 1, ['owners' => ['alex', 'sam']])));
check($isLimit($e) && str_starts_with($e->getMessage(), 'Sam already has'), 'adding Sam to a to-do of today is refused when her carried to-dos fill her list');
check($run($alex, $edit(94, 1, ['owners' => ['alex', 'sam']]), null)['tasks'][$id(94)]['owners'] === ['alex', 'sam'], 'though without a today she has room');
// A carried linked to-do is counted for both lists already: it can be edited and dated to today when both are full.
$both = $put(fresh_db(), 1, $OLD, ['alex', 'sam']);
for ($n = 2; $n <= $N; ++$n) { $both = $put($both, $n, $OLD, ['alex']); $both = $put($both, 100 + $n, $OLD, ['sam']); }
check(open_count($both, 'alex', $TODAY, null, $TODAY) === $N && open_count($both, 'sam', $TODAY, null, $TODAY) === $N, 'both lists are full on today');
$linked = $run($both, $edit(1, 1, ['owners' => ['alex', 'sam'], 'date' => $TODAY, 'title' => 'Both, here']))['tasks'][$id(1)];
check($linked['date'] === $TODAY && $linked['title'] === 'Both, here', 'a carried linked to-do dated to today in two full lists');

// ---- week and month to-dos are never carried: a week to-do of last week edited onto this week is judged by that week's count ----
$weekFull = fresh_db();
for ($n = 1; $n <= PlanMind\LIMITS['periodTodosPerList']; ++$n) { $weekFull = $put($weekFull, $n, $TODAY, ['alex'], false, 'week'); }
$weekFull = $put($weekFull, 300, '2026-10-26', ['alex'], false, 'week');
$e = $caught(fn() => $run($weekFull, $edit(300, 1, ['date' => $TODAY])));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'periodTodosPerList', 'a week to-do of last week moved onto a full this week is refused, though today is that Monday');
