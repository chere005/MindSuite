<?php
declare(strict_types=1);
// Store, rules, dispatcher and drift: authorization, RequestError, the shared rules, fail-closed reads,
// snapshot shape, revisions, size cap, encryption at rest and agreement with packages/core/src/model.ts.
// Old (v1) stores: cases/migration.php.
use PlanMind\Invariants;
use PlanMind\RequestError;
use PlanMind\Store;
use function PlanMind\{allowed, canonical_owners, clean_text, cps, find_event_overlap, fingerprint, fresh_db, item_text_limit,
    mutate, open_count, snapshot, touch, valid_date, valid_id, valid_period, validate_db};

ini_set('memory_limit', '512M');
$actions = ['add', 'edit', 'complete', 'delete', 'moveTodo', 'movePriorities', 'editEvents', 'saveNote', 'saveList', 'deleteList', 'saveSettings', 'savePrefs', 'saveChore', 'deleteChore', 'markChore', 'saveRhythm'];
$todo = fn(int $n) => ['action' => 'add', 'kind' => 'todo', 'id' => harness_id($n), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex'], 'title' => "Item $n"];
$model = (string)file_get_contents(__DIR__ . '/../../../packages/core/src/model.ts');
check($model !== '', 'model.ts readable');
$bytes = fn(string $dir) => (string)file_get_contents($dir . '/tasks.enc');

// ---- 1. Authorization: only the two configured accounts, on every action, before anything is read ----
check(allowed('alex', ['alex' => 'hash']) && allowed('sam', ['sam' => 'hash']), 'configured accounts admitted');
check(!allowed('alex', []) && !allowed('outsider', ['outsider' => 'hash']) && !allowed(null, []), 'unconfigured and third-party accounts refused');
foreach (['outsider', '', 'Alex', 'both', 'admin'] as $who) {
    foreach ([...$actions, 'nonsense'] as $action) {
        refuses(fn() => mutate(harness_db(), ['action' => $action], $who), 403, 'forbidden');
        refuses(fn() => mutate([], ['action' => $action], $who), 403, 'forbidden');
    }
    refuses(fn() => snapshot(harness_db(), $who), 403, 'forbidden');
}
refuses(fn() => mutate(['v' => 9], ['action' => 'savePrefs'], 'outsider'), 403, 'forbidden');
foreach ([[], ['action' => 'nonsense'], ['action' => 7], ['action' => ['add']], ['action' => null]] as $input) {
    refuses(fn() => mutate(harness_db(), $input, 'alex'), 400, 'invalid');
}

// ---- 2. RequestError: codes default from the status and agree with ERROR_STATUS ----
preg_match('/export const ERROR_STATUS = \{(.*?)\} as const satisfies/s', $model, $block);
preg_match_all('/(\w+):\s*(\d{3})\b/', $block[1] ?? '', $pairs, PREG_SET_ORDER);
$modelStatus = array_map('intval', array_column($pairs, 2, 1));
check(count($modelStatus) >= 15, 'ERROR_STATUS parsed from model.ts');
check($modelStatus === PlanMind\MODEL['errorStatus'], 'limits.php errorStatus equals ERROR_STATUS in model.ts');
foreach ([400 => 'invalid', 401 => 'unauthorized', 403 => 'forbidden', 405 => 'method_not_allowed', 409 => 'stale',
    413 => 'payload_too_large', 415 => 'unsupported_media', 429 => 'rate_limited', 503 => 'unavailable'] as $status => $code) {
    $e = new RequestError('x', $status);
    check($e->errorCode === $code && $e->status === $status, "default code for $status is $code");
    check($modelStatus[$code] === $status, "default $code answers $status in model.ts");
}
check((new RequestError('x'))->errorCode === 'invalid' && (new RequestError('x'))->status === 400, 'status 400 and code invalid by default');
foreach ($modelStatus as $code => $status) {
    $e = new RequestError('Message', $status, $code);
    check($e->errorCode === $code && $e->status === $status && $e->cap === null, "every ApiErrorCode is constructible: $code");
}
check((new RequestError('Full', 409, 'limit', 'dayTodosPerList'))->body() === ['error' => 'Full', 'code' => 'limit', 'cap' => 'dayTodosPerList'], 'body carries code and cap');
check((new RequestError('Gone', 409, 'gone'))->body() === ['error' => 'Gone', 'code' => 'gone'], 'body omits an absent cap');
check((new RequestError('x', 403))->getCode() === 0, 'Exception::getCode untouched');
foreach ([fn() => new RequestError('x', 404), fn() => new RequestError('x', 400, 'overlap'), fn() => new RequestError('x', 409, 'nonsense'),
    fn() => new RequestError('x', 409, 'limit', 'noSuchCap')] as $bad) { fails($bad); }

// ---- 3. Drift: limits.php equals CAPS and the other shared constants of model.ts (npm run check:limits is the generator's side) ----
preg_match('/export const CAPS = \{(.*?)\n\} as const;/s', $model, $block);
preg_match_all('/^\s+(\w+):\s*(\d+),/m', $block[1] ?? '', $pairs, PREG_SET_ORDER);
$caps = array_map('intval', array_column($pairs, 2, 1));
check(count($caps) >= 24, 'CAPS parsed from model.ts');
check($caps === PlanMind\LIMITS, 'limits.php LIMITS equals CAPS in model.ts');
preg_match('/export const COLOR_KEYS = \[(.*?)\] as const/s', $model, $block);
preg_match_all("/'(\w+)'/", $block[1] ?? '', $colors);
check($colors[1] === PlanMind\MODEL['colorKeys'], 'limits.php colorKeys equals COLOR_KEYS in model.ts');
check(PlanMind\MODEL['storeVersion'] === 5 && PlanMind\MODEL['personRoles'] === ['partner', 'owner'], 'store version and person lists');

// ---- 4. Shared rules ----
check(valid_id(harness_id(1)) && valid_id('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') && !valid_id('sam') && !valid_id('both') && !valid_id(5)
    && !valid_id(str_repeat('A', 36)) && !valid_id(harness_id(1) . "\n"), 'valid_id');
check(valid_date('2026-10-30') && valid_date('2028-02-29') && valid_date('2000-01-01') && valid_date('2099-12-31')
    && !valid_date('2027-02-29') && !valid_date('2026-02-30') && !valid_date('1999-12-31') && !valid_date('2100-01-01')
    && !valid_date('2026-1-5') && !valid_date(null) && !valid_date(20261030) && !valid_date("2026-10-30\n"), 'valid_date');
check(valid_period('day', '2026-10-30') && valid_period('week', '2026-10-26') && !valid_period('week', '2026-10-27')
    && valid_period('month', '2026-10-01') && !valid_period('month', '2026-10-02') && !valid_period('year', '2026-10-01')
    && !valid_period('day', '2026-13-01'), 'valid_period');
check(cps('abc') === 3 && cps('') === 0 && cps('😀') === 1 && cps("e\u{301}") === 2 && cps('é') === 1 && cps('日本語') === 3 && cps("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}") === 5, 'cps counts code points, not bytes or graphemes');
check(clean_text("  Lunch\u{a0}", 18, true) === 'Lunch' && clean_text(str_repeat('😀', 18), 18, true) === str_repeat('😀', 18)
    && clean_text("e\u{301}e\u{301}", 4, true) === "e\u{301}e\u{301}", 'single-line text is trimmed and counted in code points');
refuses(fn() => clean_text(str_repeat('😀', 19), 18, true), 400, 'text_too_long');
refuses(fn() => clean_text(str_repeat('a', 37), 36, true), 400, 'text_too_long');
foreach (['', "   ", "a\nb", "a\tb", "a\0b", "a\u{85}b", "a\u{2028}b", "\xff\xfe", 7, null, ['a']] as $bad) { refuses(fn() => clean_text($bad, 36, true), 400, 'invalid'); }
check(clean_text("a\r\nb\rc\td\n", 20, false) === "a\nb\nc\td\n" && clean_text('', 5, false) === '' && clean_text('  x ', 5, false) === '  x ', 'multi-line text keeps spacing and normalises newlines');
refuses(fn() => clean_text("a\0b", 20, false), 400, 'invalid');
refuses(fn() => clean_text("a\x1bb", 20, false), 400, 'invalid');
refuses(fn() => clean_text(str_repeat('a', 21), 20, false), 400, 'text_too_long');
$ownerDb = harness_db();
$ownerVectors = [
    [['alex'], ['alex']], [['sam'], ['sam']], [['alex', 'sam'], ['alex', 'sam']], [['sam', 'alex'], ['alex', 'sam']], [[HARNESS_CUSTOM], [HARNESS_CUSTOM]],
];
foreach ($ownerVectors as [$in, $out]) { check(canonical_owners($ownerDb, $in) === $out, 'canonical owners ' . json_encode($in)); }
foreach ([[], ['sam', 'sam'], ['sam', 'alex', HARNESS_CUSTOM], ['sam', HARNESS_CUSTOM], [HARNESS_CUSTOM, 'alex'], ['both'], ['all'], 'sam', null, [1],
    ['x' => 'sam'], [['sam']], ['sam', null], [HARNESS_CUSTOM, HARNESS_CUSTOM], [HARNESS_OTHER, 'sam'], ['sam', 'alex', 'alex'], ['sam', 'alex', 'zzz'], ['alex', 'sam', 'alex']] as $in) {
    refuses(fn() => canonical_owners($ownerDb, $in), 400, 'invalid');
}
refuses(fn() => canonical_owners($ownerDb, [HARNESS_OTHER]), 409, 'gone');
refuses(fn() => canonical_owners(fresh_db(), [HARNESS_CUSTOM]), 409, 'gone');
check(item_text_limit('event', ['alex']) === 500 && item_text_limit('event', ['alex', 'sam']) === 500 && item_text_limit('priority', ['alex']) === 18
    && item_text_limit('priority', ['alex', 'sam']) === 18 && item_text_limit('todo', ['alex']) === 36 && item_text_limit('todo', ['alex', 'sam']) === 36
    && item_text_limit('todo', ['alex'], 'week') === 500 && item_text_limit('todo', ['alex', 'sam'], 'month') === 500
    && item_text_limit('note', [HARNESS_CUSTOM]) === 400 && item_text_limit('note', ['alex'], 'week') === 12000 && item_text_limit('note', ['alex'], 'month') === 12000, 'item_text_limit matrix');
fails(fn() => item_text_limit('song', ['alex']));
fails(fn() => item_text_limit('todo', ['alex'], 'year'));
$counts = fresh_db();
foreach ([['alex', 'sam'], ['alex'], ['alex'], [HARNESS_CUSTOM]] as $i => $owners) {
    $counts['tasks'][harness_id($i + 1)] = harness_stamp(['id' => harness_id($i + 1), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => $owners, 'title' => "T$i", 'done' => $i === 2, 'pos' => 1024 * ($i + 1)]);
}
$counts['tasks'][harness_id(9)] = harness_stamp(['id' => harness_id(9), 'scope' => 'week', 'date' => '2026-10-26', 'owners' => ['alex'], 'title' => 'W', 'done' => false, 'pos' => 1]);
$counts['tasks'][harness_id(10)] = harness_stamp(['id' => harness_id(10), 'scope' => 'day', 'date' => '2026-10-31', 'owners' => ['alex'], 'title' => 'N', 'done' => false, 'pos' => 1]);
check(open_count($counts, 'alex', '2026-10-30', null) === 2 && open_count($counts, 'sam', '2026-10-30', null) === 1 && open_count($counts, HARNESS_CUSTOM, '2026-10-30', null) === 1
    && open_count($counts, 'alex', '2026-10-30', harness_id(1)) === 1 && open_count($counts, 'alex', '2026-10-31', null) === 1 && open_count($counts, 'alex', '2026-11-01', null) === 0,
    'open_count: open day to-dos per list, a linked one counts for both, done rows and other dates do not');
$events = fresh_db();
foreach ([[1, ['alex'], 540, 60], [2, ['alex', 'sam'], 720, 30], [3, [HARNESS_CUSTOM], 540, 60]] as [$n, $owners, $start, $length]) {
    $events['events'][harness_id($n)] = harness_stamp(['id' => harness_id($n), 'date' => '2026-10-30', 'owners' => $owners, 'text' => "E$n", 'start' => $start, 'length' => $length]);
}
check(find_event_overlap($events, '2026-10-30', ['alex'], 570, 30, null)['id'] === harness_id(1), 'overlap inside an existing span');
check(find_event_overlap($events, '2026-10-30', ['alex'], 600, 30, null) === null && find_event_overlap($events, '2026-10-30', ['alex'], 510, 30, null) === null, 'touching spans do not overlap');
check(find_event_overlap($events, '2026-10-30', ['alex'], 510, 45, null)['id'] === harness_id(1), 'a span reaching into the start overlaps');
check(find_event_overlap($events, '2026-10-30', ['sam'], 540, 60, null) === null && find_event_overlap($events, '2026-10-30', ['sam'], 720, 30, null)['id'] === harness_id(2), 'only a shared lane conflicts; a linked event blocks both');
check(find_event_overlap($events, '2026-10-30', ['alex', 'sam'], 540, 30, null)['id'] === harness_id(1), 'a linked span conflicts through either lane');
check(find_event_overlap($events, '2026-10-30', ['alex', 'sam'], 540, 30, harness_id(1)) === null && find_event_overlap($events, '2026-10-31', ['alex'], 540, 30, null) === null, 'ignoring the edited event; other days are free');
check(find_event_overlap($events, '2026-10-30', ['sam', 'alex', HARNESS_CUSTOM], 500, 600, null)['id'] === harness_id(1), 'the earliest conflict is returned');
$ak = fingerprint(['kind' => 'event', 'owners' => ['alex', 'sam'], 'date' => '2026-10-30', 'text' => 'Lunch', 'start' => 720, 'length' => 30]);
check(preg_match('/^[a-f0-9]{16}$/D', $ak) === 1, 'fingerprint is 16 hex characters');
check($ak === fingerprint(['length' => 30, 'start' => 720, 'text' => 'Lunch', 'date' => '2026-10-30', 'owners' => ['sam', 'alex'], 'kind' => 'event']), 'fingerprint ignores key order and owner order');
check(fingerprint(['kind' => 'priority', 'owners' => ['alex', 'sam'], 'slots' => ['alex' => 4, 'sam' => 2]]) === fingerprint(['kind' => 'priority', 'owners' => ['alex', 'sam'], 'slots' => ['sam' => 2, 'alex' => 4]]), 'fingerprint ignores slot key order');
foreach ([['text' => 'Lunch!'], ['start' => 735], ['length' => 45], ['owners' => ['alex']], ['date' => '2026-10-31'], ['kind' => 'todo']] as $change) {
    check(fingerprint($change + ['kind' => 'event', 'owners' => ['alex', 'sam'], 'date' => '2026-10-30', 'text' => 'Lunch', 'start' => 720, 'length' => 30]) !== $ak, 'fingerprint changes with ' . key($change));
}

// ---- 5. Fail closed: structure of every record is checked on read ----
check(snapshot(harness_db(), 'alex')['revision'] === 7, 'the reference db is valid');
validate_db(harness_db());
validate_db(fresh_db());
$id1 = harness_id(1); $id2 = harness_id(2); $id3 = harness_id(3); $id4 = harness_id(4); $noteKey = 'week:2026-10-26:alex:priorities';
$custom2 = fn(string $name) => ['id' => HARNESS_OTHER, 'kind' => 'custom', 'name' => $name, 'color' => 'teal', 'order' => 3, 'revision' => 1, 'updatedAt' => 'x'];
$broken = [
    'task without owners' => function (array $d) use ($id1) { unset($d['tasks'][$id1]['owners']); return $d; },
    'owners not canonical' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = ['sam', 'alex']; return $d; },
    'owner is an unknown list' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = [harness_id(99)]; return $d; },
    'owner is the word both' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = ['both']; return $d; },
    'owners sam and a custom list' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = ['sam', HARNESS_CUSTOM]; return $d; },
    'three owners' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = ['sam', HARNESS_CUSTOM, 'alex']; return $d; },
    'no owners' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = []; return $d; },
    'owners is a string' => function (array $d) use ($id1) { $d['tasks'][$id1]['owners'] = 'alex'; return $d; },
    'old person field' => function (array $d) use ($id1) { $d['tasks'][$id1]['person'] = 'both'; return $d; },
    'task done is not a boolean' => function (array $d) use ($id1) { $d['tasks'][$id1]['done'] = 0; return $d; },
    'task title is not text' => function (array $d) use ($id1) { $d['tasks'][$id1]['title'] = 5; return $d; },
    'task revision zero' => function (array $d) use ($id1) { $d['tasks'][$id1]['revision'] = 0; return $d; },
    'task author is a stranger' => function (array $d) use ($id1) { $d['tasks'][$id1]['createdBy'] = 'outsider'; return $d; },
    'task ak malformed' => function (array $d) use ($id1) { $d['tasks'][$id1]['ak'] = 'xyz'; return $d; },
    'task id differs from its key' => function (array $d) use ($id1) { $d['tasks'][$id1]['id'] = harness_id(50); return $d; },
    'task key is not a valid id' => function (array $d) use ($id1) { $d['tasks']['not-an-id'] = $d['tasks'][$id1]; $d['tasks']['not-an-id']['id'] = 'not-an-id'; return $d; },
    'tasks stored as a list' => function (array $d) { $d['tasks'] = array_values($d['tasks']); return $d; },
    'week task not on a Monday' => function (array $d) use ($id1) { $d['tasks'][harness_id(2)]['date'] = '2026-10-27'; return $d; },
    'month task not on the first' => function (array $d) { $d['tasks'][harness_id(2)]['scope'] = 'month'; return $d; },
    'task date impossible' => function (array $d) use ($id1) { $d['tasks'][$id1]['date'] = '2026-02-30'; return $d; },
    'task scope unknown' => function (array $d) use ($id1) { $d['tasks'][$id1]['scope'] = 'year'; return $d; },
    'doneOn on an open task' => function (array $d) use ($id1) { $d['tasks'][$id1]['doneOn'] = '2026-10-31'; return $d; },
    'doneOn on a week task' => function (array $d) use ($id2) { $d['tasks'][$id2]['doneOn'] = '2026-10-27'; return $d; },
    'doneOn before the task\'s day' => function (array $d) use ($id1) { $d['tasks'][$id1]['done'] = true; $d['tasks'][$id1]['doneOn'] = '2026-10-29'; return $d; },
    'doneOn impossible' => function (array $d) use ($id1) { $d['tasks'][$id1]['done'] = true; $d['tasks'][$id1]['doneOn'] = '2026-02-30'; return $d; },
    'doneOn is not text' => function (array $d) use ($id1) { $d['tasks'][$id1]['done'] = true; $d['tasks'][$id1]['doneOn'] = 20261031; return $d; },
    'doneOn is empty' => function (array $d) use ($id1) { $d['tasks'][$id1]['done'] = true; $d['tasks'][$id1]['doneOn'] = null; return $d; },
    'id shared by two kinds of record' => function (array $d) use ($id1, $id4) { $d['events'][$id1] = ['id' => $id1] + $d['events'][$id4]; return $d; },
    'priority slots differ from owners' => function (array $d) use ($id3) { $d['priorities'][$id3]['slots'] = ['alex' => 4]; return $d; },
    'priority slots empty' => function (array $d) use ($id3) { $d['priorities'][$id3]['slots'] = []; return $d; },
    'priority slot zero' => function (array $d) use ($id3) { $d['priorities'][$id3]['slots']['sam'] = 0; return $d; },
    'priority slot six' => function (array $d) use ($id3) { $d['priorities'][$id3]['slots']['sam'] = 6; return $d; },
    'priority slot is text' => function (array $d) use ($id3) { $d['priorities'][$id3]['slots']['sam'] = '2'; return $d; },
    'priority without text' => function (array $d) use ($id3) { unset($d['priorities'][$id3]['text']); return $d; },
    'event off the grid' => function (array $d) use ($id4) { $d['events'][$id4]['start'] = 725; return $d; },
    'event length off the grid' => function (array $d) use ($id4) { $d['events'][$id4]['length'] = 20; return $d; },
    'event length zero' => function (array $d) use ($id4) { $d['events'][$id4]['length'] = 0; return $d; },
    'event before 7:00' => function (array $d) use ($id4) { $d['events'][$id4]['start'] = 405; return $d; },
    'event ends after 7:00 the next morning' => function (array $d) use ($id4) { $d['events'][$id4]['start'] = 1845; return $d; },
    'event start is text' => function (array $d) use ($id4) { $d['events'][$id4]['start'] = '720'; return $d; },
    'event date impossible' => function (array $d) use ($id4) { $d['events'][$id4]['date'] = '2026-13-01'; return $d; },
    'note key differs from its fields' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['period'] = '2026-11-02'; return $d; },
    'note for an unknown list' => function (array $d) use ($noteKey) {
        $n = ['listId' => HARNESS_OTHER, 'key' => 'week:2026-10-26:' . HARNESS_OTHER . ':priorities'] + $d['notes'][$noteKey]; unset($d['notes'][$noteKey]); $d['notes'][$n['key']] = $n; return $d; },
    'note field not allowed for its scope' => function (array $d) use ($noteKey) {
        $n = ['scope' => 'day', 'period' => '2026-10-30', 'key' => 'day:2026-10-30:alex:priorities'] + $d['notes'][$noteKey]; unset($d['notes'][$noteKey]); $d['notes'][$n['key']] = $n; return $d; },
    'note period not a Monday' => function (array $d) use ($noteKey) {
        $n = ['period' => '2026-10-27', 'key' => 'week:2026-10-27:alex:priorities'] + $d['notes'][$noteKey]; unset($d['notes'][$noteKey]); $d['notes'][$n['key']] = $n; return $d; },
    'the old shared note' => function (array $d) { $d['notes'] = ['week:2026-10-26' => ['key' => 'week:2026-10-26', 'scope' => 'week', 'period' => '2026-10-26', 'text' => 'old', 'revision' => 1, 'updatedBy' => 'sam', 'updatedAt' => 'x']]; return $d; },
    'note revision zero' => function (array $d) use ($noteKey) { $d['notes'][$noteKey]['revision'] = 0; return $d; },
    'sam list missing' => function (array $d) { unset($d['lists']['sam']); return $d; },
    'alex list missing' => function (array $d) { unset($d['lists']['alex']); return $d; },
    'person list renamed' => function (array $d) { $d['lists']['sam']['name'] = 'Mom'; return $d; },
    'person list made custom' => function (array $d) { $d['lists']['sam']['kind'] = 'custom'; return $d; },
    'list color outside the palette' => function (array $d) { $d['lists']['alex']['color'] = 'chartreuse'; return $d; },
    'list id differs from its key' => function (array $d) { $d['lists'][HARNESS_CUSTOM]['id'] = HARNESS_OTHER; return $d; },
    'list key is not an id' => function (array $d) { $d['lists']['both'] = ['id' => 'both'] + $d['lists'][HARNESS_CUSTOM]; return $d; },
    'custom list keyed by the word both, name unused' => function (array $d) use ($custom2) { $d['lists']['both'] = ['id' => 'both'] + $custom2('Hiking'); return $d; },
    'custom list id is not a uuid, name unused' => function (array $d) use ($custom2) { $d['lists']['camp-site'] = ['id' => 'camp-site'] + $custom2('Hiking'); return $d; },
    'custom list id in capitals, name unused' => function (array $d) use ($custom2) { $id = strtoupper(HARNESS_OTHER); $d['lists'][$id] = ['id' => $id] + $custom2('Hiking'); return $d; },
    'custom names equal ignoring case' => function (array $d) use ($custom2) { $d['lists'][HARNESS_OTHER] = $custom2('camping'); return $d; },
    'custom name is a reserved word' => function (array $d) use ($custom2) { $d['lists'][HARNESS_OTHER] = $custom2('All'); return $d; },
    'custom name is a person' => function (array $d) use ($custom2) { $d['lists'][HARNESS_OTHER] = $custom2('ALEX'); return $d; },
    'custom name too long' => function (array $d) use ($custom2) { $d['lists'][HARNESS_OTHER] = $custom2(str_repeat('n', 25)); return $d; },
    'custom name empty' => function (array $d) use ($custom2) { $d['lists'][HARNESS_OTHER] = $custom2(''); return $d; },
    'thirteen custom lists' => function (array $d) use ($custom2) { for ($i = 0; $i < 12; ++$i) { $d['lists'][harness_id(200 + $i)] = ['id' => harness_id(200 + $i)] + $custom2("List $i"); } return $d; },
    'settings color outside the palette' => function (array $d) { $d['settings']['bothColor'] = 'magenta'; return $d; },
    'settings revision missing' => function (array $d) { unset($d['settings']['revision']); return $d; },
    'prefs for a third account' => function (array $d) { $d['prefs']['outsider'] = $d['prefs']['alex']; return $d; },
    'prefs overlays not a list' => function (array $d) { $d['prefs']['alex']['selection']['overlays'] = 'x'; return $d; },
    'prefs with an extra field' => function (array $d) { $d['prefs']['alex']['theme'] = 'dark'; return $d; },
    'future version' => function (array $d) { $d['v'] = PlanMind\MODEL['storeVersion'] + 1; return $d; },
    'version as text' => function (array $d) { $d['v'] = '4'; return $d; },
    'version missing' => function (array $d) { unset($d['v']); $d['x'] = 1; return $d; },
    'unknown top-level field' => function (array $d) { $d['legacy'] = []; return $d; },
    'revision negative' => function (array $d) { $d['revision'] = -1; return $d; },
    'revision is text' => function (array $d) { $d['revision'] = '7'; return $d; },
    'tasks is not a collection' => function (array $d) { $d['tasks'] = 'x'; return $d; },
    'events missing' => function (array $d) { unset($d['events']); return $d; },
    'too many items' => function (array $d) {
        $template = $d['tasks'][harness_id(2)];
        for ($i = 0; $i < PlanMind\LIMITS['itemsMax'] + 1; ++$i) { $d['tasks'][harness_id(1000 + $i)] = ['id' => harness_id(1000 + $i)] + $template; }
        return $d; },
];
check(count($broken) >= 60, 'fail-closed table is populated');
// doneOn is valid on a done day to-do, on its own day or later.
foreach (['2026-10-30', '2026-10-31', '2026-11-05'] as $doneOn) {
    $ok = harness_db(); $ok['tasks'][$id1]['done'] = true; $ok['tasks'][$id1]['doneOn'] = $doneOn;
    validate_db($ok);
    check(snapshot($ok, 'sam')['tasks'][0]['doneOn'] === $doneOn, "a done day to-do with doneOn $doneOn is a valid record and the snapshot carries it");
}
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

// ---- 6. Fail closed on disk: corruption, keys and malformed old data never turn into empty data or a rewrite (old data with records is converted: cases/migration.php) ----
[$store, $dir] = harness_store();
$read = fn() => $store->transaction('tasks', fn($db) => $db);
check($read() === [] && !glob($dir . '/*.enc') && !file_exists($dir . '/.key'), 'a missing file reads as empty and is not created by a read');
$fresh = snapshot($read(), 'sam');
check($fresh['revision'] === 0 && $fresh['v'] === PlanMind\MODEL['storeVersion'] && array_column($fresh['lists'], 'id') === ['sam', 'alex'] && $fresh['tasks'] === [], 'an empty store reads as the seeded defaults of the current version');
foreach ([['revision' => 1, 'tasks' => [], 'notes' => ['week:2026-10-26' => ['text' => 'old note']]], ['v' => 1, 'revision' => 1, 'tasks' => [harness_id(1) => []]],
    ['revision' => 1, 'tasks' => [], 'extra' => 1], ['revision' => 'x', 'tasks' => []], ['v' => 1, 'revision' => 2], ['revision' => 2, 'tasks' => [], 'notes' => 'x']] as $db) {
    fails(fn() => snapshot($db, 'alex'), 'Invalid planner data');
    fails(fn() => mutate($db, $todo(1), 'alex'), 'Invalid planner data');
}
foreach ([['revision' => 5, 'tasks' => [], 'notes' => []], ['v' => 1, 'revision' => 5, 'tasks' => [], 'notes' => []], ['revision' => 5, 'tasks' => []]] as $emptyOld) {
    $s = snapshot($emptyOld, 'alex');
    check($s['revision'] === 5 && $s['v'] === PlanMind\MODEL['storeVersion'] && count($s['lists']) === 2 && $s['tasks'] === [] && $s['notes'] === [], 'an empty old store reads as fresh and keeps its revision');
}
$store->transaction('tasks', fn() => ['revision' => 5, 'tasks' => [], 'notes' => []]);
$before = $bytes($dir);
$s = snapshot($read(), 'alex');
check($s['revision'] === 5 && $bytes($dir) === $before, 'reading an empty old store does not rewrite it');
$db = $store->transaction('tasks', fn($db) => mutate($db, $todo(1), 'alex'));
check($db['v'] === PlanMind\MODEL['storeVersion'] && $db['revision'] === 6 && count($db['lists']) === 2 && count($db['tasks']) === 1, 'the first write replaces an empty old store with a seeded current one at revision + 1');
check(snapshot($read(), 'sam')['tasks'][0]['title'] === 'Item 1', 'the written store reads back');

[$store, $dir] = harness_store();
$store->transaction('tasks', fn() => harness_db());
$good = $bytes($dir);
$flip = $good; $flip[45] = $flip[45] === 'a' ? 'b' : 'a';
file_put_contents($dir . '/tasks.enc', $flip);
fails(fn() => $store->transaction('tasks', fn($db) => mutate($db, $todo(1), 'alex')));
check($bytes($dir) === $flip, 'corruption is never overwritten as empty');
foreach (['PM2:' . substr($good, 4), 'PM1:!!!!', 'PM1:' . base64_encode('short'), ''] as $damaged) {
    file_put_contents($dir . '/tasks.enc', $damaged);
    fails(fn() => $store->transaction('tasks', fn($db) => $db));
    check($bytes($dir) === $damaged, 'damaged storage is left alone');
}
// Characters outside the base64 alphabet are never skipped over: a lenient decoder would hand the same ciphertext to GCM and read the file.
foreach (['!', '*', '-', '_', '.', '%'] as $stray) {
    $strayed = substr($good, 0, 40) . $stray . substr($good, 40);
    file_put_contents($dir . '/tasks.enc', $strayed);
    fails(fn() => $store->transaction('tasks', fn($db) => $db), 'Damaged storage');
    check($bytes($dir) === $strayed, "a file with '$stray' inside its base64 is refused and left alone");
}
file_put_contents($dir . '/tasks.enc', $good);
copy($dir . '/tasks.enc', $dir . '/attempts.enc');
fails(fn() => $store->transaction('attempts', fn($db) => $db), 'authentication');
unlink($dir . '/attempts.enc');
check(snapshot($store->transaction('tasks', fn($db) => $db), 'alex')['tasks'][0]['title'] === 'Private shared task', 'the good file still reads');
unlink($dir . '/.key');
fails(fn() => $store->transaction('tasks', fn($db) => $db), 'key');
check(!file_exists($dir . '/.key') && $bytes($dir) === $good, 'a missing key is never regenerated for existing ciphertext');

// ---- 7. Snapshot shape and revisions ----
$db = harness_db();
$s = snapshot($db, 'alex');
check($s['prefs'] === ['selection' => ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]], 'sidebar' => 'shown'], 'a caller sees their own picker state, and the sidebar shown unless they hid it');
check(snapshot($db, 'sam')['prefs'] === ['selection' => ['base' => 'both', 'overlays' => []], 'sidebar' => 'shown'], 'the other account gets the default and never sees the first one\'s state');
check(array_keys($s) === ['v', 'revision', 'lists', 'settings', 'tasks', 'priorities', 'events', 'notes', 'chores', 'choreMarks', 'rhythm', 'prefs'], 'snapshot keys');
$swapped = harness_db(); $swapped['lists'] = array_reverse($swapped['lists'], true);
check(array_column(snapshot($swapped, 'alex')['lists'], 'id') === ['sam', 'alex', HARNESS_CUSTOM], 'lists come out sam, alex, then custom by order');
$json = json_decode(json_encode(snapshot($db, 'alex')), false);
foreach (['lists', 'tasks', 'priorities', 'events', 'notes', 'chores', 'choreMarks'] as $collection) { check(is_array($json->$collection), "$collection is a JSON list"); }
check(count($json->tasks) === 2 && $json->priorities[0]->slots instanceof stdClass && $json->prefs->selection->overlays === [HARNESS_CUSTOM] && $json->settings instanceof stdClass, 'maps become lists; slots stays an object');
$text = json_encode(snapshot(fresh_db(), 'alex'));
check(str_contains($text, '"tasks":[]') && str_contains($text, '"notes":[]') && str_contains($text, '"overlays":[]') && !str_contains($text, '{}'), 'empty collections encode as []');
$dirty = harness_db();
$dirty['prefs']['alex']['selection'] = ['base' => harness_id(77), 'overlays' => ['sam', HARNESS_CUSTOM, HARNESS_CUSTOM, harness_id(78)]];
check(snapshot($dirty, 'alex')['prefs']['selection'] === ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]], 'dangling base and overlays are dropped on the way out');
$dirty['prefs']['alex']['selection'] = ['base' => HARNESS_CUSTOM, 'overlays' => [HARNESS_CUSTOM]];
check(snapshot($dirty, 'alex')['prefs']['selection'] === ['base' => HARNESS_CUSTOM, 'overlays' => []], 'an overlay equal to the base is dropped');
$many = harness_db();
foreach ([HARNESS_OTHER, harness_id(31), harness_id(32)] as $i => $id) { $many['lists'][$id] = ['id' => $id, 'kind' => 'custom', 'name' => "Extra $i", 'color' => 'red', 'order' => 5 + $i, 'revision' => 1, 'updatedAt' => 'x']; }
$many['prefs']['alex']['selection'] = ['base' => 'sam', 'overlays' => [HARNESS_OTHER, HARNESS_CUSTOM, harness_id(31), harness_id(32)]];
check(snapshot($many, 'alex')['prefs']['selection'] === ['base' => 'sam', 'overlays' => [HARNESS_OTHER, HARNESS_CUSTOM]], 'at most two overlays leave the server');

check(touch(fresh_db())['revision'] === 1, 'touch adds one to the revision');
$a = mutate([], $todo(1), 'alex');
check($a['revision'] === 1 && $a['v'] === PlanMind\MODEL['storeVersion'] && isset($a['lists']['sam'], $a['lists']['alex']) && $a['lists']['sam']['revision'] === 1 && $a['settings']['revision'] === 1, 'first write seeds the permanent lists');
check($a['lists']['sam']['name'] === 'Sam' && $a['lists']['alex']['color'] === 'green' && $a['settings']['bothColor'] === 'purple', 'seeded lists and settings');
$b = mutate($a, $todo(2), 'sam');
check($b['revision'] === 2 && count($b['tasks']) === 2, 'one write is exactly one revision');
check(mutate($b, $todo(2), 'sam') === $b && mutate($b, $todo(1), 'alex') === $b, 'an idempotent retry returns the very same db: nothing is rewritten');
$c = mutate($b, ['action' => 'savePrefs', 'selection' => ['base' => 'sam', 'overlays' => []]], 'alex');
check($c['revision'] === 2 && $c['prefs']['alex']['selection']['base'] === 'sam' && !isset($c['prefs']['sam']), 'savePrefs changes only the caller\'s state and not the revision');
$snapshotBefore = snapshot($b, 'alex');
mutate($b, $todo(3), 'alex');
check(snapshot($b, 'alex') === $snapshotBefore, 'mutate does not alter the array it was given');
// What becomes of a handler's result: exactly one revision per change, nothing for a no-op, nothing invalid.
$base = harness_db();
$grown = $base; $grown['tasks'][harness_id(8)] = harness_stamp(['id' => harness_id(8), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['sam'], 'title' => 'New', 'done' => false, 'pos' => 2048]);
check(Invariants::settle(['given'], $base, $base, 'add') === ['given'], 'a no-op returns the db as it was given');
check(Invariants::settle([], $base, $grown, 'add')['revision'] === 8, 'a handler that forgot touch() still moves the revision by one');
check(Invariants::settle([], $base, touch($grown), 'add')['revision'] === 8 && Invariants::settle([], $base, touch(touch($grown)), 'add')['revision'] === 8, 'touching once or twice moves it by one');
$prefs = $base; $prefs['prefs']['sam'] = ['selection' => ['base' => 'alex', 'overlays' => []]];
check(Invariants::settle([], $base, $prefs, 'savePrefs')['revision'] === 7 && Invariants::settle([], $base, touch($prefs), 'savePrefs')['revision'] === 7, 'savePrefs never moves the revision');
$invalid = $grown; $invalid['tasks'][harness_id(8)]['extra'] = true;
fails(fn() => Invariants::settle([], $base, $invalid, 'add'), 'Invalid planner data');
$invalid = $grown; $invalid['tasks'][harness_id(8)]['owners'] = ['both'];
fails(fn() => Invariants::settle([], $base, $invalid, 'add'), 'Invalid planner data');

[$store, $dir] = harness_store();
$store->transaction('tasks', fn($db) => mutate($db, $todo(1), 'alex'));
$one = $bytes($dir);
$store->transaction('tasks', fn($db) => mutate($db, $todo(1), 'alex'));
check($bytes($dir) === $one, 'a retried add never rewrites the file');

// ---- 8. Size: the encoded plaintext may not exceed storeBytesMax ----
[$store, $dir] = harness_store();
$cap = PlanMind\LIMITS['storeBytesMax'];
$size = fn(array $d) => strlen(json_encode($d, JSON_UNESCAPED_UNICODE));
$near = harness_db();
$near['notes'][$noteKey]['text'] = str_repeat('x', $cap - $size($near) + strlen($near['notes'][$noteKey]['text']));
check($size($near) === $cap, 'the fixture is exactly at the cap');
$store->transaction('tasks', fn() => $near);
$atCap = $bytes($dir);
check(snapshot($store->transaction('tasks', fn($db) => $db), 'alex')['notes'][0]['text'] === $near['notes'][$noteKey]['text'], 'a store exactly at the cap is written and read');
$over = $near; $over['notes'][$noteKey]['text'] .= 'x';
refuses(fn() => $store->transaction('tasks', fn() => $over), 409, 'store_full');
check($bytes($dir) === $atCap, 'a refused oversized write leaves the file untouched');
refuses(fn() => $store->transaction('tasks', fn($db) => mutate($db, $todo(5), 'alex')), 409, 'store_full');
check($bytes($dir) === $atCap && !glob($dir . '/*.tmp'), 'a refused add near the cap leaves the file and the directory untouched');
$smaller = $store->transaction('tasks', function ($db) use ($id1) { unset($db['tasks'][$id1]); ++$db['revision']; return $db; });
check($bytes($dir) !== $atCap && count($smaller['tasks']) === 1, 'deleting while near the cap still works');
$store->transaction('tasks', function ($db) use ($noteKey) { $db['notes'][$noteKey]['text'] = 'short'; return $db; });
check(strlen($bytes($dir)) < 100000, 'shrinking the big text frees the room');
$store->transaction('tasks', fn($db) => mutate($db, $todo(5), 'alex'));
check(count(snapshot($store->transaction('tasks', fn($db) => $db), 'alex')['tasks']) === 2, 'writes work again once there is room');

// ---- 9. Encryption at rest ----
[$store, $dir] = harness_store();
$secret = harness_db();
$secret['tasks'][$id1]['title'] = 'Zebra-title-4411';
$secret['lists'][HARNESS_CUSTOM]['name'] = 'Zebra-list-4412';
$secret['notes'][$noteKey]['text'] = 'Zebra-note-4413';
$secret['events'][$id4]['text'] = 'Zebra-event-4414';
$secret['priorities'][$id3]['text'] = 'Zebra-line-4415';
$store->transaction('tasks', fn() => $secret);
$file = $bytes($dir);
check(str_starts_with($file, 'PM1:'), 'ciphertext carries the PM1 prefix');
$blob = base64_decode(substr($file, 4), true);
foreach (['Zebra-title-4411', 'Zebra-list-4412', 'Zebra-note-4413', 'Zebra-event-4414', 'Zebra-line-4415', 'Zebra', 'Week task', 'createdBy', '2026-10-30'] as $needle) {
    check(!str_contains($file, $needle) && !str_contains((string)$blob, $needle), "'$needle' is not readable in the file");
}
$names = array_values(array_diff(scandir($dir) ?: [], ['.', '..'])); sort($names);
check($names === ['.key', '.key.lock', '.tasks.lock', 'tasks.enc', 'tasks.version'] && filesize($dir . '/.tasks.lock') === 0, 'the data directory holds only the key, the locks, one ciphertext and the version marker');
$back = snapshot($store->transaction('tasks', fn($db) => $db), 'alex');
check($back['tasks'][0]['title'] === 'Zebra-title-4411' && $back['lists'][2]['name'] === 'Zebra-list-4412' && $back['notes'][0]['text'] === 'Zebra-note-4413', 'the same content decrypts');
check(substr(sprintf('%o', fileperms($dir . '/tasks.enc')), -3) === '600', 'the data file is private to its owner');
