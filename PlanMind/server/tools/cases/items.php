<?php
declare(strict_types=1);
// Items in general: owners, idempotent adds with their `ak`, linked (Both) behaviour, edit and delete rules, the item cap
// (spec 11.1 cases 3, 4 and 5). Events, priorities and to-dos each have a file of their own for what is specific to them.
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, snapshot};

ini_set('memory_limit', '512M');
// Ids start at 101 so they never meet the records of harness_db().
$id = fn(int $n) => harness_id(100 + $n);
$run = fn(array $db, array $input, string $user = 'alex') => mutate($db, $input, $user);
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$day = '2026-11-02';
$make = [
    'todo' => fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'todo', 'id' => $id($n), 'scope' => 'day', 'date' => $day, 'owners' => ['alex'], 'title' => "Item $n"],
    'priority' => fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'priority', 'id' => $id($n), 'date' => $day, 'owners' => ['alex'], 'slots' => ['alex' => 1], 'text' => "Line $n"],
    'event' => fn(int $n, array $more = []) => $more + ['action' => 'add', 'kind' => 'event', 'id' => $id($n), 'date' => $day, 'owners' => ['alex'], 'text' => "Event $n", 'start' => 600],
];
$edit = [
    'todo' => fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'todo', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'title' => "Edited $n"],
    'priority' => fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'priority', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'slots' => ['alex' => 2], 'text' => "Edited $n"],
    'event' => fn(int $n, int $rev, array $more = []) => $more + ['action' => 'edit', 'kind' => 'event', 'id' => $id($n), 'revision' => $rev, 'date' => $day, 'owners' => ['alex'], 'text' => "Edited $n", 'start' => 630, 'length' => 60],
];
$collection = ['todo' => 'tasks', 'priority' => 'priorities', 'event' => 'events'];
$textField = ['todo' => 'title', 'priority' => 'text', 'event' => 'text'];
// Slots for an owner vector, whatever its shape, so the owners are what a request fails or passes on.
$slotsFor = fn($owners) => is_array($owners) && $owners && array_is_list($owners) ? array_fill_keys(array_filter($owners, 'is_string'), 1) : ['alex' => 1];
$forOwners = fn(string $kind, mixed $owners) => $make[$kind](1, ['owners' => $owners] + ($kind === 'priority' ? ['slots' => $slotsFor($owners)] : []));

// ---- 3. Owners: one list, or exactly sam + alex, canonical, and the list must exist ----
foreach (array_keys($make) as $kind) {
    foreach ([[['alex'], ['alex']], [['sam'], ['sam']], [[HARNESS_CUSTOM], [HARNESS_CUSTOM]], [['alex', 'sam'], ['alex', 'sam']], [['sam', 'alex'], ['alex', 'sam']]] as [$in, $out]) {
        $db = $run(harness_db(), $forOwners($kind, $in));
        check($db[$collection[$kind]][$id(1)]['owners'] === $out, "$kind: owners " . json_encode($in) . ' are stored as ' . json_encode($out));
    }
    // The vectors canonical_owners shares with the TypeScript canonicalOwners, plus the shapes only the server rejects.
    foreach ([[], ['sam', 'sam'], ['sam', 'alex', HARNESS_CUSTOM], ['sam', HARNESS_CUSTOM], [HARNESS_CUSTOM, 'alex'], ['both'], ['all'], 'sam', null, [1],
        ['x' => 'sam'], [['sam']], ['sam', null], [HARNESS_CUSTOM, HARNESS_CUSTOM], [HARNESS_OTHER, 'sam'], '', 5] as $in) {
        refuses(fn() => $run(harness_db(), $forOwners($kind, $in)), 400, 'invalid');
    }
    $missing = $make[$kind](1);
    unset($missing['owners']);
    refuses(fn() => $run(harness_db(), $missing), 400, 'invalid');
    refuses(fn() => $run(harness_db(), $forOwners($kind, [HARNESS_OTHER])), 409, 'gone');
    refuses(fn() => $run(fresh_db(), $forOwners($kind, [HARNESS_CUSTOM])), 409, 'gone');
}

// ---- Request shape: kind is required and nothing unknown is dropped silently ----
foreach (array_keys($make) as $kind) {
    $noKind = $make[$kind](1); unset($noKind['kind']);
    refuses(fn() => $run(harness_db(), $noKind), 400, 'invalid');
    foreach (['song', '', null, 5, ['todo'], 'Todo', 'tasks'] as $bad) { refuses(fn() => $run(harness_db(), $make[$kind](1, ['kind' => $bad])), 400, 'invalid'); }
    foreach ([['person' => 'alex'], ['done' => true], ['pos' => 5], ['ak' => 'abcdabcdabcdabcd'], ['revision' => 1], ['createdBy' => 'sam'], ['extra' => 1]] as $more) {
        refuses(fn() => $run(harness_db(), $make[$kind](1, $more)), 400, 'invalid');
    }
    foreach (['', 'nope', $id(1) . 'x', 5, null, ['x'], 'AAAAAAAA-0000-4000-8000-000000000001'] as $bad) { refuses(fn() => $run(harness_db(), $make[$kind](1, ['id' => $bad])), 400, 'invalid'); }
    $noId = $make[$kind](1); unset($noId['id']);
    refuses(fn() => $run(harness_db(), $noId), 400, 'invalid');
}
// An add shaped like the old API (person, no kind, no owners) is refused whole.
refuses(fn() => $run(harness_db(), ['action' => 'add', 'id' => $id(1), 'title' => 'Old', 'date' => $day, 'person' => 'alex', 'scope' => 'day']), 400, 'invalid');
refuses(fn() => $run(harness_db(), ['action' => 'add', 'kind' => 'todo', 'id' => $id(1), 'title' => 'Old', 'date' => $day, 'person' => 'alex', 'scope' => 'day']), 400, 'invalid');

// ---- 4. Add idempotency per kind ----
foreach (array_keys($make) as $kind) {
    $field = $textField[$kind];
    $input = $make[$kind](1);
    $start = harness_db();
    $a = $run($start, $input);
    $row = $a[$collection[$kind]][$id(1)];
    check($row['revision'] === 1 && $row['createdBy'] === 'alex' && $row['updatedBy'] === 'alex' && preg_match('/^[a-f0-9]{16}$/D', $row['ak']) === 1
        && $row['createdAt'] === $row['updatedAt'], "$kind: a new record starts at revision 1 with an ak");
    check($a['revision'] === $start['revision'] + 1, "$kind: the global revision moves once");
    foreach (array_diff(['tasks', 'priorities', 'events'], [$collection[$kind]]) as $other) { check($a[$other] === $start[$other], "$kind: other collections untouched"); }
    check($run($a, $input) === $a, "$kind: a retry returns the identical db");
    check($run($a, $input, 'alex')['revision'] === $a['revision'], "$kind: a retry does not move the revision");

    // After the item was edited the retry is still a no-op: the ak is the creation fingerprint, not the current content.
    $b = $run($a, $edit[$kind](1, 1));
    check($b[$collection[$kind]][$id(1)]['revision'] === 2 && $b[$collection[$kind]][$id(1)]['ak'] === $row['ak'], "$kind: an edit keeps the creation ak");
    check($run($b, $input) === $b, "$kind: a retry after an edit is still a no-op");

    refuses(fn() => $run($a, $make[$kind](1, [$field => 'Something else'])), 409, 'id_in_use');
    refuses(fn() => $run($a, $input, 'sam'), 409, 'id_in_use');
    refuses(fn() => $run($b, $make[$kind](1, [$field => 'Something else'])), 409, 'id_in_use');
    foreach (array_diff(array_keys($make), [$kind]) as $other) {
        refuses(fn() => $run($a, $make[$other](1)), 409, 'id_in_use');
    }
    // The same content under a new id is a new record, not a retry.
    $c = $run($a, $make[$kind](2, [$field => $input[$field]] + ['priority' => ['slots' => ['alex' => 2]], 'event' => ['start' => 660], 'todo' => []][$kind]));
    check(count($c[$collection[$kind]]) === count($a[$collection[$kind]]) + 1 && $c['revision'] === $a['revision'] + 1, "$kind: same content, new id is a new record");

    // Owners in another order and the default length are the same request.
    $linked = $kind === 'priority' ? ['slots' => ['alex' => 3, 'sam' => 4]] : [];
    $l = $run($start, $make[$kind](3, ['owners' => ['sam', 'alex']] + $linked));
    check($run($l, $make[$kind](3, ['owners' => ['alex', 'sam']] + (isset($linked['slots']) ? ['slots' => ['sam' => 4, 'alex' => 3]] : []))) === $l, "$kind: owner and slot order do not matter to a retry");

    // The other person deleting the fresh item leaves no trace (spec 5.4, no tombstones): the retry creates it again.
    $deleted = $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true], 'sam');
    check(!isset($deleted[$collection[$kind]][$id(1)]), "$kind: deleted");
    check(isset($run($deleted, $input)[$collection[$kind]][$id(1)]), "$kind: a retry after the other person deleted it recreates it (known gap)");
}
// An omitted length is the default of half an hour; spelling it out is the same request.
$ev = $run(harness_db(), $make['event'](1));
check($ev['events'][$id(1)]['length'] === 30 && $run($ev, $make['event'](1, ['length' => 30])) === $ev, 'event: default length retried with an explicit 30');
refuses(fn() => $run($ev, $make['event'](1, ['length' => 45])), 409, 'id_in_use');
// Ids are one namespace across the three collections, and the lists have their own.
$all = $run($run($run(harness_db(), $make['todo'](1)), $make['priority'](2)), $make['event'](3));
check(count($all['tasks']) === 3 && count($all['priorities']) === 2 && count($all['events']) === 2, 'one record of each kind added');
refuses(fn() => $run($all, $make['event'](1)), 409, 'id_in_use');
refuses(fn() => $run($all, $make['priority'](3)), 409, 'id_in_use');
// ---- Revision rules: every change is one global revision and one record revision ----
$a = $run(harness_db(), $make['todo'](1));
$b = $run($a, $edit['todo'](1, 1), 'sam');
check($b['revision'] === $a['revision'] + 1 && $b['tasks'][$id(1)]['revision'] === 2 && $b['tasks'][$id(1)]['updatedBy'] === 'sam' && $b['tasks'][$id(1)]['createdBy'] === 'alex', 'edit: one global revision, record revision + 1, editor recorded');
$c = $run($b, ['action' => 'complete', 'id' => $id(1), 'revision' => 2, 'done' => true]);
check($c['revision'] === $b['revision'] + 1 && $c['tasks'][$id(1)]['revision'] === 3 && $c['tasks'][$id(1)]['done'] === true, 'complete: one global revision, record revision + 1');
$d = $run($c, ['action' => 'delete', 'id' => $id(1), 'revision' => 3, 'confirm' => true]);
check($d['revision'] === $c['revision'] + 1 && !isset($d['tasks'][$id(1)]), 'delete: one global revision, record gone');

// ---- 5. Linked behaviour: one record, two owners ----
foreach (array_keys($make) as $kind) {
    $linkedInput = $make[$kind](1, ['owners' => ['alex', 'sam']] + ($kind === 'priority' ? ['slots' => ['sam' => 2, 'alex' => 4]] : []));
    $a = $run(harness_db(), $linkedInput, 'alex');
    check(count($a[$collection[$kind]]) === count(harness_db()[$collection[$kind]]) + 1, "$kind: a linked item is ONE record");
    foreach (['alex', 'sam'] as $viewer) {
        $seen = array_values(array_filter(snapshot($a, $viewer)[$collection[$kind]], fn($r) => $r['id'] === $id(1)));
        check(count($seen) === 1 && $seen[0]['owners'] === ['alex', 'sam'], "$kind: $viewer sees the same linked record");
    }
    // Stale: the other person edited first.
    $b = $run($a, $edit[$kind](1, 1, ['owners' => ['alex', 'sam']] + ($kind === 'priority' ? ['slots' => ['sam' => 2, 'alex' => 4]] : [])), 'sam');
    refuses(fn() => $run($b, $edit[$kind](1, 1, ['owners' => ['alex', 'sam']] + ($kind === 'priority' ? ['slots' => ['sam' => 2, 'alex' => 4]] : [])), 'alex'), 409, 'stale');
    refuses(fn() => $run($b, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true], 'alex'), 409, 'stale');
    // Delete removes it for both.
    $gone = $run($b, ['action' => 'delete', 'id' => $id(1), 'revision' => 2, 'confirm' => true], 'alex');
    foreach (['alex', 'sam'] as $viewer) { check(!in_array($id(1), array_column(snapshot($gone, $viewer)[$collection[$kind]], 'id'), true), "$kind: deleted for $viewer"); }
    refuses(fn() => $run($gone, ['action' => 'delete', 'id' => $id(1), 'revision' => 2, 'confirm' => true], 'sam'), 409, 'gone');
    refuses(fn() => $run($gone, $edit[$kind](1, 2), 'sam'), 409, 'gone');
}
// complete flips one record that both lists see.
$a = $run(harness_db(), $make['todo'](1, ['owners' => ['alex', 'sam']]), 'alex');
$done = $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => true], 'sam');
foreach (['alex', 'sam'] as $viewer) {
    $row = array_values(array_filter(snapshot($done, $viewer)['tasks'], fn($t) => $t['id'] === $id(1)))[0];
    check($row['done'] === true && $row['revision'] === 2 && $row['updatedBy'] === 'sam', "$viewer sees the to-do completed by the other person");
}
refuses(fn() => $run($done, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => false], 'alex'), 409, 'stale');

// Owner change keeps the content, in any direction, with the checks re-run.
$cases = [
    'todo' => [[['alex', 'sam'], ['alex']], [['alex'], ['alex', 'sam']], [['sam'], [HARNESS_CUSTOM]], [[HARNESS_CUSTOM], ['alex', 'sam']], [['alex', 'sam'], ['sam']]],
    'event' => [[['alex', 'sam'], ['alex']], [['alex'], ['alex', 'sam']], [['sam'], [HARNESS_CUSTOM]]],
    'priority' => [[['alex', 'sam'], ['alex']], [['alex'], ['alex', 'sam']], [['sam'], [HARNESS_CUSTOM]]],
];
foreach ($cases as $kind => $moves) {
    foreach ($moves as [$from, $to]) {
        $create = $make[$kind](1, ['owners' => $from] + ($kind === 'priority' ? ['slots' => array_fill_keys($from, 3)] : []));
        $a = $run(harness_db(), $create);
        if ($kind === 'todo') { $a = $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => true]); }
        $before = $a[$collection[$kind]][$id(1)];
        $change = $edit[$kind](1, $before['revision'], ['owners' => $to, $textField[$kind] => $before[$textField[$kind]]]
            + ($kind === 'priority' ? ['slots' => array_fill_keys($to, 3)] : []) + ($kind === 'event' ? ['start' => $before['start'], 'length' => $before['length']] : []));
        $b = $run($a, $change, 'sam');
        $after = $b[$collection[$kind]][$id(1)];
        check($after['owners'] === $to && $after[$textField[$kind]] === $before[$textField[$kind]] && $after['ak'] === $before['ak']
            && $after['createdBy'] === $before['createdBy'] && $after['revision'] === $before['revision'] + 1 && $after['updatedBy'] === 'sam', "$kind: owners " . json_encode($from) . ' to ' . json_encode($to));
        if ($kind === 'todo') { check($after['done'] === $before['done'] && $after['pos'] === $before['pos'] && $after['scope'] === $before['scope'], 'to-do: done, pos and scope are preserved by an owner change'); }
        check($b['revision'] === $a['revision'] + 1, "$kind: an owner change is one global revision");
    }
}

// ---- Edit rules shared by every kind ----
foreach (array_keys($make) as $kind) {
    $a = $run(harness_db(), $make[$kind](1));
    $same = $edit[$kind](1, 1, [$textField[$kind] => $a[$collection[$kind]][$id(1)][$textField[$kind]]]
        + ($kind === 'priority' ? ['slots' => ['alex' => 1]] : []) + ($kind === 'event' ? ['start' => 600, 'length' => 30] : []));
    check($run($a, $same) === $a, "$kind: an edit that changes nothing writes nothing");
    refuses(fn() => $run($a, $edit[$kind](1, 2)), 409, 'stale');
    refuses(fn() => $run($a, $edit[$kind](1, 0)), 400, 'invalid');
    refuses(fn() => $run($a, $edit[$kind](1, 1, ['revision' => '1'])), 400, 'invalid');
    refuses(fn() => $run($a, $edit[$kind](9, 1)), 409, 'gone');
    $noRevision = $edit[$kind](1, 1); unset($noRevision['revision']);
    refuses(fn() => $run($a, $noRevision), 400, 'invalid');
    $noKind = $edit[$kind](1, 1); unset($noKind['kind']);
    refuses(fn() => $run($a, $noKind), 400, 'invalid');
    foreach (array_diff(array_keys($make), [$kind]) as $other) {
        refuses(fn() => $run($a, $edit[$other](1, 1)), 400, 'invalid'); // the id belongs to another kind of entry
    }
    // scope, done, pos, createdBy and ak cannot be edited: they are not accepted at all.
    foreach ([['scope' => 'week'], ['done' => true], ['pos' => 1], ['createdBy' => 'sam'], ['ak' => 'abcdabcdabcdabcd'], ['person' => 'sam'], ['id2' => 'x']] as $more) {
        refuses(fn() => $run($a, $edit[$kind](1, 1, $more)), 400, 'invalid');
    }
    refuses(fn() => $run($a, $edit[$kind](1, 1, ['date' => '2026-02-30'])), 400, 'invalid');
    refuses(fn() => $run($a, $edit[$kind](1, 1, [$textField[$kind] => '   '])), 400, 'invalid');
    refuses(fn() => $run($a, $edit[$kind](1, 1, ['owners' => [HARNESS_OTHER]] + ($kind === 'priority' ? ['slots' => [HARNESS_OTHER => 2]] : []))), 409, 'gone');
}
// complete and delete take their documented fields only.
$a = $run(harness_db(), $make['todo'](1));
foreach ([['kind' => 'todo'], ['extra' => 1], ['scope' => 'day']] as $more) {
    refuses(fn() => $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => true] + $more), 400, 'invalid');
    refuses(fn() => $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true] + $more), 400, 'invalid');
}
foreach ([null, 0, 'true', 'yes', 1] as $bad) { refuses(fn() => $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => $bad]), 400, 'invalid'); }
foreach ([false, null, 'true', 1, 0] as $bad) { refuses(fn() => $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => $bad]), 400, 'invalid'); }
refuses(fn() => $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 1]), 400, 'invalid');
refuses(fn() => $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1]), 400, 'invalid');
refuses(fn() => $run($a, ['action' => 'complete', 'id' => $id(9), 'revision' => 1, 'done' => true]), 409, 'gone');
refuses(fn() => $run($a, ['action' => 'delete', 'id' => $id(9), 'revision' => 1, 'confirm' => true]), 409, 'gone');
refuses(fn() => $run($a, ['action' => 'delete', 'id' => $id(1), 'revision' => 9, 'confirm' => true]), 409, 'stale');
// Only to-dos complete.
$e = $run(harness_db(), $make['event'](1));
refuses(fn() => $run($e, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => true]), 400, 'invalid');
// Any kind deletes.
foreach (array_keys($make) as $kind) {
    $x = $run(harness_db(), $make[$kind](1));
    $y = $run($x, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true]);
    check(!isset($y[$collection[$kind]][$id(1)]) && $y['revision'] === $x['revision'] + 1, "$kind: delete removes the record in one revision");
}
// Completing again is a no-op even with an old revision; completing is still checked against the revision otherwise.
$done = $run($a, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => true]);
check($run($done, ['action' => 'complete', 'id' => $id(1), 'revision' => 2, 'done' => true]) === $done, 'completing a completed to-do is a no-op');
refuses(fn() => $run($done, ['action' => 'complete', 'id' => $id(1), 'revision' => 1, 'done' => false]), 409, 'stale');
$open = $run($done, ['action' => 'complete', 'id' => $id(1), 'revision' => 2, 'done' => false]);
check($open['tasks'][$id(1)]['done'] === false && $open['tasks'][$id(1)]['revision'] === 3, 'a to-do reopens');

// ---- The item cap: itemsMax records in all, then `limit` with its cap name; deleting still works ----
$full = fresh_db();
$template = ['scope' => 'week', 'date' => '2026-10-26', 'owners' => ['sam'], 'title' => 'x', 'done' => true, 'pos' => 1024];
for ($i = 1; $i <= PlanMind\LIMITS['itemsMax']; ++$i) {
    $full['tasks'][$id($i)] = ['id' => $id($i)] + $template + ['revision' => 1, 'createdBy' => 'sam', 'updatedBy' => 'sam', 'createdAt' => 'x', 'updatedAt' => 'x', 'ak' => 'aaaaaaaaaaaaaaaa'];
}
foreach (array_keys($make) as $kind) {
    $e = $caught(fn() => $run($full, $make[$kind](PlanMind\LIMITS['itemsMax'] + 1)));
    check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'itemsMax', "$kind: the item cap answers limit with the cap name");
}
refuses(fn() => $run($full, $make['todo'](1)), 409, 'id_in_use'); // the id rules come before the cap
$less = $run($full, ['action' => 'delete', 'id' => $id(1), 'revision' => 1, 'confirm' => true]);
check(count($less['tasks']) === PlanMind\LIMITS['itemsMax'] - 1 && isset($run($less, $make['todo'](PlanMind\LIMITS['itemsMax'] + 1))['tasks'][$id(PlanMind\LIMITS['itemsMax'] + 1)]), 'deleting makes room again');
