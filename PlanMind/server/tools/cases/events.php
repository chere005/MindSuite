<?php
declare(strict_types=1);
// Schedule entries: the 15-minute grid and the 7:00 to 7:00 (next morning) window, the default length, overlap per lane, linked entries
// that need both lanes, edits that exclude themselves, handle edits in one write, text limits (spec 11.1 case 7).
use PlanMind\RequestError;
use function PlanMind\mutate;

$run = fn(array $db, array $input, string $user = 'alex') => mutate($db, $input, $user);
$id = fn(int $n) => harness_id(100 + $n);
$day = '2026-11-02';
$add = fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'event', 'id' => $id($n), 'date' => $day, 'owners' => ['alex'], 'text' => "Event $n", 'start' => 600, 'length' => 60];
$edit = fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'event', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'text' => "Event $n", 'start' => 600, 'length' => 60];
$base = fn() => harness_db();
$with = function (array $db, array ...$events) use ($run, $add): array { foreach ($events as $i => $more) { $db = $run($db, $add($i + 1, $more)); } return $db; };

// ---- Grid and window: 15-minute steps, 7:00 to 7:00 the next morning (1860), at least 30 minutes ----
foreach ([[420, 30], [435, 30], [1230, 30], [1410, 30], [1830, 30], [420, 1440], [600, 45], [1215, 45], [1815, 45], [600, 30], [600, 480]] as [$start, $length]) {
    $db = $run($base(), $add(1, ['start' => $start, 'length' => $length]));
    check($db['events'][$id(1)]['start'] === $start && $db['events'][$id(1)]['length'] === $length, "accepted: $start for $length");
}
foreach ([[605, 30], [601, 30], [600, 40], [600, 31], [405, 30], [0, 30], [-15, 30], [1845, 30], [1860, 30], [1830, 45], [420, 1455], [1875, 60], [600, 0], [600, 15], [420, 15], [1845, 15], [600, -30], [1850, 15], [1860, 15],
    [600, 20], [419, 30], [10000, 30]] as [$start, $length]) {
    refuses(fn() => $run($base(), $add(1, ['start' => $start, 'length' => $length])), 400, 'invalid');
}
foreach ([600.0, '600', null, true, [], [600], 'ten'] as $bad) { refuses(fn() => $run($base(), $add(1, ['start' => $bad])), 400, 'invalid'); }
foreach ([30.0, '30', null, true, [], [30]] as $bad) { refuses(fn() => $run($base(), $add(1, ['length' => $bad])), 400, 'invalid'); }
$noStart = $add(1); unset($noStart['start']);
refuses(fn() => $run($base(), $noStart), 400, 'invalid');
$noDate = $add(1); unset($noDate['date']);
refuses(fn() => $run($base(), $noDate), 400, 'invalid');
foreach (['2026-02-30', '1999-12-31', '2100-01-01', '2026-1-5', 20261102, null, '2026-11-02 ', '2026-11-02T00:00'] as $bad) { refuses(fn() => $run($base(), $add(1, ['date' => $bad])), 400, 'invalid'); }

// ---- The default length is half an hour ----
$noLength = $add(1); unset($noLength['length']);
$db = $run($base(), $noLength);
check($db['events'][$id(1)]['length'] === 30, 'a missing length is stored as half an hour');
$db2 = $run($base(), $add(1, ['length' => 30]));
check($db['events'][$id(1)]['ak'] === $db2['events'][$id(1)]['ak'], 'the default and an explicit 30 are the same creation request');

// ---- Overlap: per lane, half-open; touching is fine; a linked entry needs both lanes free ----
$alex = $with($base(), ['start' => 600, 'length' => 60]);
foreach ([[630, 30], [570, 60], [600, 60], [585, 105], [645, 60], [600, 30], [630, 90], [420, 600]] as [$start, $length]) {
    refuses(fn() => $run($alex, $add(9, ['start' => $start, 'length' => $length])), 409, 'overlap');
}
foreach ([[540, 60], [660, 30], [420, 180], [660, 600]] as [$start, $length]) {
    check(isset($run($alex, $add(9, ['start' => $start, 'length' => $length]))['events'][$id(9)]), "touching is not overlapping: $start for $length");
}
check(isset($run($alex, $add(9, ['date' => '2026-11-03']))['events'][$id(9)]), 'the same time on another day is free');
check(isset($run($alex, $add(9, ['owners' => ['sam']]))['events'][$id(9)]), 'the same time in another lane (sam) is free');
check(isset($run($alex, $add(9, ['owners' => [HARNESS_CUSTOM]]))['events'][$id(9)]), 'the same time in a custom lane is free');
check($run($alex, $add(9, ['owners' => ['sam']]), 'sam')['events'][$id(9)]['createdBy'] === 'sam', 'either person may add to any lane');
$e = (function () use ($run, $alex, $add) { try { $run($alex, $add(9, ['start' => 630])); } catch (RequestError $e) { return $e; } })();
check($e->getMessage() === 'That time is already taken in this list.' && $e->cap === null, 'the overlap message and no cap name');
// A to-do or a priority line never blocks the schedule.
$noise = $run($run($alex, ['action' => 'add', 'kind' => 'todo', 'id' => $id(40), 'scope' => 'day', 'date' => $day, 'owners' => ['alex'], 'title' => 'x']),
    ['action' => 'add', 'kind' => 'priority', 'id' => $id(41), 'date' => $day, 'owners' => ['alex'], 'slots' => ['alex' => 1], 'text' => 'x']);
check(isset($run($noise, $add(9, ['start' => 660]))['events'][$id(9)]), 'only schedule entries count for overlap');

// A linked entry conflicts through either lane, and blocks both.
$sam = $with($base(), ['owners' => ['sam'], 'start' => 600, 'length' => 60]);
$both = $with($base(), ['owners' => ['alex', 'sam'], 'start' => 600, 'length' => 60, 'text' => 'Lunch together']);
foreach ([[$alex, ['alex', 'sam']], [$sam, ['alex', 'sam']], [$both, ['alex']], [$both, ['sam']], [$both, ['alex', 'sam']]] as [$db, $owners]) {
    refuses(fn() => $run($db, $add(9, ['owners' => $owners, 'start' => 630, 'length' => 30])), 409, 'overlap');
}
check(isset($run($both, $add(9, ['owners' => [HARNESS_CUSTOM]]))['events'][$id(9)]), 'a linked entry does not block a custom lane');
check(isset($run($both, $add(9, ['owners' => ['alex', 'sam'], 'start' => 660]))['events'][$id(9)]), 'a linked entry right after a linked entry');
check(isset($run($alex, $add(9, ['owners' => ['alex', 'sam'], 'start' => 660]))['events'][$id(9)]), 'a linked entry touching a lane entry');
$onlySam = $with($base(), ['owners' => ['sam'], 'start' => 660, 'length' => 30], ['owners' => ['alex'], 'start' => 540, 'length' => 60]);
check(isset($run($onlySam, $add(9, ['owners' => ['alex', 'sam'], 'start' => 600, 'length' => 60]))['events'][$id(9)]), 'a linked entry fits between entries of the two lanes');
refuses(fn() => $run($onlySam, $add(9, ['owners' => ['alex', 'sam'], 'start' => 600, 'length' => 90])), 409, 'overlap');
// The existing fixture event (custom lane, 12:00 to 12:45 on 2026-10-30) blocks only its own lane and day.
refuses(fn() => $run($base(), $add(9, ['owners' => [HARNESS_CUSTOM], 'date' => '2026-10-30', 'start' => 735, 'length' => 30])), 409, 'overlap');
check(isset($run($base(), $add(9, ['owners' => [HARNESS_CUSTOM], 'date' => '2026-10-30', 'start' => 765, 'length' => 30]))['events'][$id(9)]), 'touching the fixture event is free');

// ---- Edit: the entry never conflicts with itself; every other check runs again ----
$two = $with($base(), ['start' => 600, 'length' => 60], ['start' => 720, 'length' => 60]);
$grown = $run($two, $edit(1, 1, ['start' => 585, 'length' => 135]));
check($grown['events'][$id(1)]['start'] === 585 && $grown['events'][$id(1)]['length'] === 135, 'an edit may cover its own old span and touch a neighbour');
refuses(fn() => $run($two, $edit(1, 1, ['length' => 135])), 409, 'overlap');
refuses(fn() => $run($two, $edit(1, 1, ['start' => 690, 'length' => 60])), 409, 'overlap');
refuses(fn() => $run($two, $edit(2, 1, ['start' => 630, 'length' => 30])), 409, 'overlap');
check($run($two, $edit(2, 1, ['start' => 660, 'length' => 60]))['events'][$id(2)]['start'] === 660, 'an edit may move up against its neighbour');
// Handles: text, start and length change in one write, one revision.
$handles = $run($two, $edit(1, 1, ['text' => 'Dentist', 'start' => 570, 'length' => 105]));
$row = $handles['events'][$id(1)];
check($row['text'] === 'Dentist' && $row['start'] === 570 && $row['length'] === 105 && $row['revision'] === 2 && $handles['revision'] === $two['revision'] + 1, 'a handle edit saves text, start and length in one write');
check($row['ak'] === $two['events'][$id(1)]['ak'] && $row['createdBy'] === 'alex', 'the creation ak and author survive');
// Owner change into an overlap is refused; into a free lane is not.
$lanes = $with($base(), ['owners' => ['alex'], 'start' => 600, 'length' => 60], ['owners' => ['sam'], 'start' => 630, 'length' => 60]);
refuses(fn() => $run($lanes, $edit(1, 1, ['owners' => ['alex', 'sam']])), 409, 'overlap');
refuses(fn() => $run($lanes, $edit(2, 1, ['owners' => ['alex'], 'start' => 630, 'length' => 60])), 409, 'overlap');
check($run($lanes, $edit(1, 1, ['owners' => [HARNESS_CUSTOM]]))['events'][$id(1)]['owners'] === [HARNESS_CUSTOM], 'moving an entry to a free lane');
check($run($lanes, $edit(1, 1, ['owners' => ['alex', 'sam'], 'start' => 540, 'length' => 60]))['events'][$id(1)]['owners'] === ['alex', 'sam'], 'becoming linked where both lanes are free');
// A change of day re-checks the new day.
$busy = $with($base(), ['start' => 600, 'length' => 60], ['start' => 600, 'length' => 60, 'date' => '2026-11-03']);
refuses(fn() => $run($busy, $edit(1, 1, ['date' => '2026-11-03'])), 409, 'overlap');
check($run($busy, $edit(1, 1, ['date' => '2026-11-03', 'start' => 660]))['events'][$id(1)]['date'] === '2026-11-03', 'moving to a free time on another day');
// Bounds apply to an edit too.
foreach ([['start' => 405], ['start' => 1845], ['length' => 15], ['length' => 10], ['length' => 0], ['start' => 602], ['length' => 61]] as $more) {
    refuses(fn() => $run($two, $edit(1, 1, $more)), 400, 'invalid');
}
refuses(fn() => $run($two, $edit(1, 1, ['length' => null])), 400, 'invalid');
$noLength = $edit(1, 1); unset($noLength['length']);
refuses(fn() => $run($two, $noLength), 400, 'invalid'); // an edit replaces every editable field
refuses(fn() => $run($two, $edit(1, 2, ['start' => 540])), 409, 'stale');

// ---- Text: 500 code points, linked or not (a block shows what fits and an ellipsis; the cap is only the server's bound) ----
$text = fn(int $n) => str_repeat('a', $n);
foreach ([['alex', 18, true], ['alex', 36, true], ['alex', 500, true], ['alex', 501, false], ['sam', 500, true], [HARNESS_CUSTOM, 501, false]] as [$owner, $n, $ok]) {
    $try = fn() => $run($base(), $add(1, ['owners' => [$owner], 'text' => $text($n)]));
    if ($ok) { check($try()['events'][$id(1)]['text'] === $text($n), "$n characters in one lane"); } else { refuses($try, 400, 'text_too_long'); }
}
foreach ([[36, true], [500, true], [501, false], [1, true]] as [$n, $ok]) {
    $try = fn() => $run($base(), $add(1, ['owners' => ['alex', 'sam'], 'text' => $text($n)]));
    if ($ok) { check($try()['events'][$id(1)]['text'] === $text($n), "$n characters when linked"); } else { refuses($try, 400, 'text_too_long'); }
}
$emoji = fn(int $n) => str_repeat("\u{1F600}", $n);
check(strlen($emoji(500)) === 2000 && $run($base(), $add(1, ['text' => $emoji(500)]))['events'][$id(1)]['text'] === $emoji(500), '500 emoji are 500 characters although 2000 bytes');
refuses(fn() => $run($base(), $add(1, ['text' => $emoji(501)])), 400, 'text_too_long');
check(isset($run($base(), $add(1, ['owners' => ['alex', 'sam'], 'text' => $emoji(500)]))['events'][$id(1)]), '500 emoji fit a linked entry');
refuses(fn() => $run($base(), $add(1, ['owners' => ['alex', 'sam'], 'text' => $emoji(501)])), 400, 'text_too_long');
$accent = fn(int $n) => str_repeat("e\u{301}", $n);
check(isset($run($base(), $add(1, ['text' => $accent(250)]))['events'][$id(1)]), '250 letters with a combining mark are 500 code points');
refuses(fn() => $run($base(), $add(1, ['text' => $accent(251)])), 400, 'text_too_long');
check($run($base(), $add(1, ['text' => "  Lunch\u{a0} "]))['events'][$id(1)]['text'] === 'Lunch', 'text is trimmed');
foreach (['', '   ', "two\nlines", "tab\there", "nul\0", 5, null, ['x'], "\xff"] as $bad) { refuses(fn() => $run($base(), $add(1, ['text' => $bad])), 400, 'invalid'); }
// The limit no longer follows the owners on an edit: a long text stays valid when a linked entry becomes single, and the other way round.
$linked = $run($base(), $add(1, ['owners' => ['alex', 'sam'], 'text' => $text(300)]));
check($run($linked, $edit(1, 1, ['owners' => ['alex'], 'text' => $text(300)]))['events'][$id(1)]['owners'] === ['alex'], 'a long linked entry can become single with its text');
$single = $run($base(), $add(1, ['text' => $text(300)]));
check($run($single, $edit(1, 1, ['owners' => ['alex', 'sam'], 'text' => $text(500)]))['events'][$id(1)]['text'] === $text(500), 'a longer text fits once linked');
refuses(fn() => $run($single, $edit(1, 1, ['text' => $text(501)])), 400, 'text_too_long');

// ---- editEvents: a shared boundary dragged between bordering entries, all or nothing ----
$batch = fn(array ...$edits) => ['action' => 'editEvents', 'edits' => $edits];
$one = fn(int $n, int $rev, array $more = []) => $more + ['id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'text' => "Event $n", 'start' => 600, 'length' => 60];
$pair = $with($base(), ['start' => 540, 'length' => 60], ['start' => 600, 'length' => 60]);   // 9-10 and 10-11
// Later: the first grows into the second's old start. The same pair as two single edits is refused either way round.
refuses(fn() => $run($pair, $edit(1, 1, ['start' => 540, 'length' => 90])), 409, 'overlap');
$later = $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(2, 1, ['start' => 630, 'length' => 30])));
check($later['events'][$id(1)]['length'] === 90 && $later['events'][$id(2)]['start'] === 630 && $later['events'][$id(2)]['length'] === 30, 'a boundary moves later in one write');
check($later['events'][$id(1)]['revision'] === 2 && $later['events'][$id(2)]['revision'] === 2 && $later['revision'] === $pair['revision'] + 1, 'each entry one revision, the store one');
// Earlier, listed in either order; the first entry's words change in the same write.
$earlier = $run($pair, $batch($one(2, 1, ['start' => 570, 'length' => 90]), $one(1, 1, ['start' => 540, 'length' => 30, 'text' => 'Gym'])));
check($earlier['events'][$id(1)]['length'] === 30 && $earlier['events'][$id(1)]['text'] === 'Gym' && $earlier['events'][$id(2)]['start'] === 570, 'a boundary moves earlier, with the words');
// A retry of the same write finds everything as asked: nothing written, even with the old revisions.
check($run($later, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(2, 1, ['start' => 630, 'length' => 30]))) === $later, 'a retry writes nothing');
// All or nothing: a result that overlaps, a stale revision, a removed entry, bad shapes.
refuses(fn() => $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(2, 1, ['start' => 615, 'length' => 45]))), 409, 'overlap');
refuses(fn() => $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]))), 409, 'overlap');
refuses(fn() => $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(2, 2, ['start' => 630, 'length' => 30]))), 409, 'stale');
refuses(fn() => $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(9, 1, ['start' => 630, 'length' => 30]))), 409, 'gone');
refuses(fn() => $run($pair, $batch($one(1, 1, ['start' => 540, 'length' => 90]), $one(2, 1, ['start' => 630, 'length' => 10]))), 400, 'invalid');
refuses(fn() => $run($pair, $batch($one(1, 1), $one(1, 1))), 400, 'invalid');
refuses(fn() => $run($pair, $batch($one(1, 1, ['date' => '2026-11-03']))), 400, 'invalid');
refuses(fn() => $run($pair, $batch($one(1, 1, ['kind' => 'event']))), 400, 'invalid');
refuses(fn() => $run($pair, $batch()), 400, 'invalid');
refuses(fn() => $run($pair, $batch($one(1, 1), $one(2, 1), $one(3, 1), $one(4, 1))), 400, 'invalid');
refuses(fn() => $run($pair, ['action' => 'editEvents', 'edits' => ['x' => $one(1, 1)]]), 400, 'invalid');
refuses(fn() => $run($pair, ['action' => 'editEvents', 'edits' => [$one(1, 1)], 'date' => $day]), 400, 'invalid');
refuses(fn() => $run($run($base(), $add(1, ['owners' => ['sam']])), $batch($one(1, 1, ['owners' => ['sam'], 'start' => 540])), 'outsider'), 403, 'forbidden');
// A linked entry and the two lanes' entries after it move together.
$three = $with($base(), ['owners' => ['alex', 'sam'], 'start' => 540, 'length' => 60], ['owners' => ['alex'], 'start' => 600, 'length' => 45], ['owners' => ['sam'], 'start' => 600, 'length' => 60]);
$moved = $run($three, $batch($one(1, 1, ['owners' => ['alex', 'sam'], 'length' => 75, 'start' => 540]), $one(2, 1, ['start' => 615, 'length' => 30]), $one(3, 1, ['owners' => ['sam'], 'start' => 615, 'length' => 45])));
check($moved['events'][$id(1)]['length'] === 75 && $moved['events'][$id(2)]['start'] === 615 && $moved['events'][$id(3)]['start'] === 615, 'a linked entry and both lanes\' neighbours move together');
