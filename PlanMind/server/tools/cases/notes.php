<?php
declare(strict_types=1);
// Notes: one text per (scope, period, list, field), the allowed pairs and period rules, the caps, stale writes and
// the same-text no-op, the lane of a list that is gone, and the notes cap. Case 11 of the server test plan.
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, snapshot, validate_db};

ini_set('memory_limit', '512M');
$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$request = fn(array $over = []) => $over + ['action' => 'saveNote', 'scope' => 'week', 'period' => '2026-10-26', 'listId' => 'sam', 'field' => 'priorities', 'text' => 'Call the dentist', 'revision' => 0];
$send = fn(array $db, array $over = [], string $user = 'alex') => mutate($db, $request($over), $user);
$without = fn(array $db, string ...$keys) => array_diff_key($db, array_flip($keys));
$cps = fn(string $text) => mb_strlen($text, 'UTF-8');
$alex = 'week:2026-10-26:alex:priorities';

// ---- 1. A new note ----
$base = harness_db();
$a = $send($base);
$note = $a['notes']['week:2026-10-26:sam:priorities'];
check($a['revision'] === 8, 'a new note is one revision');
check($note === ['key' => 'week:2026-10-26:sam:priorities', 'scope' => 'week', 'period' => '2026-10-26', 'listId' => 'sam', 'field' => 'priorities',
    'text' => 'Call the dentist', 'revision' => 1, 'updatedBy' => 'alex'] + ['updatedAt' => $note['updatedAt']] && is_string($note['updatedAt']), 'a note holds exactly the model fields, from revision 1, signed by the caller');
check($without($a['notes'], 'week:2026-10-26:sam:priorities') === $base['notes'] && $without($a, 'notes', 'revision') === $without($base, 'notes', 'revision'), 'nothing else changes');
check(snapshot($a, 'sam')['notes'][1] === $note, 'the other person receives it in the snapshot');
$b = $send($a, ['text' => 'Call the vet', 'revision' => 1], 'sam');
check($b['revision'] === 9 && $b['notes'][$note['key']]['revision'] === 2 && $b['notes'][$note['key']]['text'] === 'Call the vet' && $b['notes'][$note['key']]['updatedBy'] === 'sam', 'an edit moves the note\'s revision and signature');
check($send($base, ['listId' => 'alex', 'text' => 'Edited', 'revision' => 2], 'alex')['notes'][$alex]['updatedBy'] === 'alex', 'either person may edit any list\'s text');
validate_db($a);

// ---- 2. One text per scope, period, list and field ----
$cells = [
    ['week', '2026-10-26', 'sam', 'priorities'], ['week', '2026-11-02', 'sam', 'priorities'], ['week', '2026-10-26', HARNESS_CUSTOM, 'priorities'],
    ['month', '2026-10-01', 'sam', 'priorities'], ['month', '2026-10-01', 'sam', 'notes'], ['month', '2026-11-01', 'sam', 'notes'],
    ['day', '2026-10-30', 'sam', 'notes'], ['day', '2026-10-31', 'sam', 'notes'], ['day', '2026-10-30', HARNESS_CUSTOM, 'notes'], ['day', '2026-10-30', 'alex', 'notes'],
];
$many = $base;
foreach ($cells as $i => [$scope, $period, $listId, $field]) {
    $many = $send($many, ['scope' => $scope, 'period' => $period, 'listId' => $listId, 'field' => $field, 'text' => "Text $i"]);
}
check($many['revision'] === 7 + count($cells) && count($many['notes']) === 1 + count($cells), 'every combination is its own note');
foreach ($cells as $i => [$scope, $period, $listId, $field]) {
    $n = $many['notes']["$scope:$period:$listId:$field"];
    check($n['text'] === "Text $i" && $n['revision'] === 1 && $n['listId'] === $listId && $n['field'] === $field && $n['period'] === $period, "note $scope $period $listId $field");
}
check($many['notes'][$alex] === $base['notes'][$alex], 'the note of another list is untouched');
$edit = $send($many, ['scope' => 'day', 'period' => '2026-10-30', 'listId' => 'sam', 'field' => 'notes', 'text' => 'Changed', 'revision' => 1]);
check($without($edit['notes'], 'day:2026-10-30:sam:notes') === $without($many['notes'], 'day:2026-10-30:sam:notes') && $edit['notes']['day:2026-10-30:sam:notes']['revision'] === 2
    && $edit['notes']['day:2026-10-30:sam:notes']['text'] === 'Changed', 'editing one text leaves every other untouched');
validate_db($many);

// ---- 3. Allowed pairs and malformed parts ----
foreach ([['day', 'priorities'], ['week', 'notes'], ['year', 'notes'], ['week', 'Priorities'], ['month', ''], ['', 'notes'], ['all', 'priorities']] as [$scope, $field]) {
    $period = $scope === 'day' ? '2026-10-30' : '2026-10-01';
    refuses(fn() => $send($base, ['scope' => $scope, 'period' => $period, 'field' => $field]), 400, 'invalid');
}
foreach (['scope', 'period', 'field', 'listId', 'text'] as $part) {
    foreach ([5, null, ['x'], true] as $bad) { refuses(fn() => $send($base, [$part => $bad]), 400, 'invalid'); }
    $missing = $request(); unset($missing[$part]);
    refuses(fn() => mutate($base, $missing, 'alex'), 400, 'invalid');
}
check($send($base, ['scope' => 'month', 'period' => '2026-10-01', 'field' => 'priorities'])['notes']['month:2026-10-01:sam:priorities']['field'] === 'priorities', 'month allows priorities');
check($send($base, ['scope' => 'month', 'period' => '2026-10-01', 'field' => 'notes'])['notes']['month:2026-10-01:sam:notes']['field'] === 'notes', 'and notes');

// ---- 4. Periods: a day, a Monday, the first of a month ----
foreach (['2026-10-30', '2026-10-31', '2028-02-29', '2000-01-01', '2099-12-31'] as $day) {
    check(isset($send($base, ['scope' => 'day', 'period' => $day, 'field' => 'notes'])['notes']["day:$day:sam:notes"]), "day $day");
}
foreach (['2026-02-30', '1999-12-31', '2100-01-01', '2026-10-3', '2026-10-30 ', 'tomorrow', '', '2027-02-29'] as $day) {
    refuses(fn() => $send($base, ['scope' => 'day', 'period' => $day, 'field' => 'notes']), 400, 'invalid');
}
foreach (['2026-10-27', '2026-10-25', '2026-11-01', '2026-10-28', '2026-13-01', '2026-10-26 '] as $notMonday) {
    refuses(fn() => $send($base, ['scope' => 'week', 'period' => $notMonday]), 400, 'invalid');
}
foreach (['2026-10-02', '2026-10-26', '2026-10-31', '2026-02-30'] as $notFirst) {
    refuses(fn() => $send($base, ['scope' => 'month', 'period' => $notFirst, 'field' => 'notes']), 400, 'invalid');
}
check(isset($send($base, ['scope' => 'week', 'period' => '2026-06-01'])['notes']['week:2026-06-01:sam:priorities'])
    && isset($send($base, ['scope' => 'month', 'period' => '2026-06-01', 'field' => 'notes'])['notes']['month:2026-06-01:sam:notes']), 'a Monday that is the first fits both scopes');

// ---- 5. Length: 400 code points a day, 12000 a week or month ----
$day = ['scope' => 'day', 'period' => '2026-10-30', 'field' => 'notes'];
check($send($base, $day + ['text' => str_repeat('a', 400)])['notes']['day:2026-10-30:sam:notes']['text'] === str_repeat('a', 400), 'a day note of 400 characters fits');
$e = $caught(fn() => $send($base, $day + ['text' => str_repeat('a', 401)]));
check($e->status === 400 && $e->errorCode === 'text_too_long', 'a day note of 401 is text_too_long');
check($send($base, $day + ['text' => str_repeat('😀', 400)]) !== $base, 'code points are counted, not bytes: 400 emoji fit');
refuses(fn() => $send($base, $day + ['text' => str_repeat('😀', 401)]), 400, 'text_too_long');
check($send($base, $day + ['text' => str_repeat("e\u{301}", 200)]) !== $base, '200 letters with a combining mark are 400 code points');
refuses(fn() => $send($base, $day + ['text' => str_repeat("e\u{301}", 201)]), 400, 'text_too_long');
refuses(fn() => $send($base, $day + ['text' => str_repeat("line\n", 81)]), 400, 'text_too_long');
foreach ([['week', '2026-10-26', 'priorities'], ['month', '2026-10-01', 'priorities'], ['month', '2026-10-01', 'notes']] as [$scope, $period, $field]) {
    $over = ['scope' => $scope, 'period' => $period, 'field' => $field];
    check(strlen($send($base, $over + ['text' => str_repeat('a', 12000)])['notes']["$scope:$period:sam:$field"]['text']) === 12000, "$scope $field: 12000 characters fit");
    check($cps($send($base, $over + ['text' => str_repeat('😀', 12000)])['notes']["$scope:$period:sam:$field"]['text']) === 12000, "$scope $field: 12000 emoji fit");
    refuses(fn() => $send($base, $over + ['text' => str_repeat('a', 12001)]), 400, 'text_too_long');
    refuses(fn() => $send($base, $over + ['text' => str_repeat('😀', 12001)]), 400, 'text_too_long');
}

// ---- 6. Which characters a note may hold ----
$saved = $send($base, ['text' => "  Indented\r\n\tTabbed\rlines\n\n"])['notes']['week:2026-10-26:sam:priorities']['text'];
check($saved === "  Indented\n\tTabbed\nlines\n\n", 'spacing and tabs stay, every line ending becomes a newline');
foreach (["a\0b", "a\x1bb", "a\x7fb", "a\u{85}b", "\xff\xfe", "a\xc0\xafb"] as $bad) { refuses(fn() => $send($base, ['text' => $bad]), 400, 'invalid'); }
check($send($base, ['text' => "Ünïcödé 日本語 😀 e\u{301}"])['notes']['week:2026-10-26:sam:priorities']['text'] === "Ünïcödé 日本語 😀 e\u{301}", 'Unicode is stored as it is');

// ---- 7. Clearing a note ----
$cleared = $send($base, ['listId' => 'alex', 'text' => '', 'revision' => 2]);
check($cleared['revision'] === 8 && $cleared['notes'][$alex]['text'] === '' && $cleared['notes'][$alex]['revision'] === 3 && count($cleared['notes']) === 1, 'an empty text clears a note but keeps its revision line');
check($send($cleared, ['listId' => 'alex', 'text' => '', 'revision' => 3]) === $cleared, 'clearing a cleared note writes nothing');
check($send($cleared, ['listId' => 'alex', 'text' => 'Again', 'revision' => 3])['notes'][$alex]['revision'] === 4, 'and it can be written again');
check($send($base, ['text' => '']) === $base && $send($base, ['text' => '', 'revision' => 4]) === $base, 'an empty text for a note that does not exist is a no-op');

// ---- 8. Same text is a success, a different text on an old revision is stale ----
check($send($a) === $a, 'the same create retried changes nothing');
check($send($a, ['revision' => 1]) === $a, 'the same text on the current revision changes nothing');
check($send($b, ['text' => 'Call the vet', 'revision' => 1]) === $b && $send($b, ['text' => 'Call the vet', 'revision' => 0]) === $b && $send($b, ['text' => 'Call the vet', 'revision' => 9]) === $b,
    'the same text as stored succeeds whatever revision the writer held');
$crlf = $send($base, ['text' => "a\nb"]);
check($send($crlf, ['text' => "a\r\nb"]) === $crlf, 'line endings are normalised before the text is compared');
$e = $caught(fn() => $send($b, ['text' => 'Third', 'revision' => 1]));
check($e->status === 409 && $e->errorCode === 'stale', 'another text on a revision that moved is stale');
check(str_contains($e->getMessage(), 'Your draft is preserved'), 'the stale message tells the writer the draft is kept');
refuses(fn() => $send($a, ['text' => 'Other', 'revision' => 0]), 409, 'stale');
refuses(fn() => $send($a, ['text' => 'Other', 'revision' => 2]), 409, 'stale');
refuses(fn() => $send($base, ['listId' => 'alex', 'text' => 'Other', 'revision' => 1]), 409, 'stale');
refuses(fn() => $send($base, ['listId' => 'alex', 'text' => 'Other', 'revision' => 0]), 409, 'stale');
refuses(fn() => $send($base, ['listId' => 'alex', 'text' => 'Other', 'revision' => 3]), 409, 'stale');
refuses(fn() => $send($base, ['text' => 'Other', 'revision' => 1]), 409, 'stale');
foreach (['0', 0.0, 0.5, -1, null, true, [0]] as $revision) { refuses(fn() => $send($base, ['revision' => $revision]), 400, 'invalid'); }
$missing = $request(); unset($missing['revision']);
refuses(fn() => mutate($base, $missing, 'alex'), 400, 'invalid');

// ---- 9. A list that is not there ----
$e = $caught(fn() => $send($base, ['listId' => HARNESS_OTHER]));
check($e->status === 409 && $e->errorCode === 'gone', 'a well-formed list that does not exist is gone');
foreach (['both', 'all', '', 'Sam', 'SAM', 'xyz', strtoupper(HARNESS_CUSTOM)] as $listId) { refuses(fn() => $send($base, ['listId' => $listId]), 400, 'invalid'); }
check(isset($send($base, ['listId' => HARNESS_CUSTOM])['notes']['week:2026-10-26:' . HARNESS_CUSTOM . ':priorities']), 'a custom list takes notes');
$removed = mutate($base, ['action' => 'deleteList', 'id' => HARNESS_CUSTOM, 'revision' => 1, 'confirm' => true], 'sam');
refuses(fn() => $send($removed, ['listId' => HARNESS_CUSTOM]), 409, 'gone');
refuses(fn() => $send($removed, ['listId' => HARNESS_CUSTOM, 'text' => '']), 409, 'gone');
check($send(fresh_db(), ['listId' => 'alex'])['notes']['week:2026-10-26:alex:priorities']['revision'] === 1, 'the permanent lists always exist');

// ---- 10. At most notesMax notes ----
$full = fresh_db();
$date = new DateTimeImmutable('2000-01-01');
for ($i = 0; $i < PlanMind\LIMITS['notesMax']; ++$i) {
    $period = $date->modify("+$i days")->format('Y-m-d');
    $full['notes']["day:$period:alex:notes"] = ['key' => "day:$period:alex:notes", 'scope' => 'day', 'period' => $period, 'listId' => 'alex', 'field' => 'notes',
        'text' => "N$i", 'revision' => 1, 'updatedBy' => 'alex', 'updatedAt' => 'x'];
}
validate_db($full);
$e = $caught(fn() => $send($full, ['scope' => 'day', 'period' => '2026-10-30', 'field' => 'notes']));
check($e->status === 409 && $e->errorCode === 'limit' && $e->cap === 'notesMax', 'the note after the last one is a limit error naming its cap');
check($send($full, ['scope' => 'day', 'period' => '2000-01-01', 'listId' => 'alex', 'field' => 'notes', 'text' => 'Edited', 'revision' => 1])['notes']['day:2000-01-01:alex:notes']['text'] === 'Edited', 'an existing note can still be edited at the cap');
check($send($full, ['scope' => 'day', 'period' => '2026-10-30', 'field' => 'notes', 'text' => '']) === $full, 'and an empty text creates nothing');
unset($full['notes']['day:2000-01-01:alex:notes']);
check(isset($send($full, ['scope' => 'day', 'period' => '2026-10-30', 'field' => 'notes'])['notes']['day:2026-10-30:sam:notes']), 'one note fewer makes room');

// ---- 11. Through the encrypted file ----
[$store, $dir] = harness_store();
$run = fn(array $over, string $user = 'alex') => $store->transaction('tasks', fn($db) => mutate($db, $request($over), $user));
$run(['listId' => 'alex']);
$bytes = (string)file_get_contents($dir . '/tasks.enc');
$run(['listId' => 'alex']);
check((string)file_get_contents($dir . '/tasks.enc') === $bytes, 'a retried save never rewrites the file');
$run(['listId' => 'alex', 'text' => 'Changed', 'revision' => 1], 'sam');
$s = snapshot($store->transaction('tasks', fn($db) => $db), 'alex');
check($s['revision'] === 2 && $s['notes'][0]['text'] === 'Changed' && $s['notes'][0]['updatedBy'] === 'sam' && $s['notes'][0]['revision'] === 2, 'the note reads back');
refuses(fn() => $run(['listId' => 'alex', 'text' => 'Stale', 'revision' => 1]), 409, 'stale');
