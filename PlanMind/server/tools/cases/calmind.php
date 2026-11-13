<?php
declare(strict_types=1);
// CalMind's events on the Day schedule: the read-only reader of CalMind's store (planner_calmind.php). Decryption the way CalMind
// writes, fail-closed reads, repeats as CalMind's spec has them, the 7a-to-7a planner day, and the share rules (own calendars
// whole, the other person's shared calendars only while both name each other).
use function PlanMind\{calmind_allday_pieces, calmind_both_calendar, calmind_events, calmind_pieces, calmind_records, calmind_repeat_step, op_set_calmind};

/** A CalMind data dir written as CalMind's store_write does: ENC1, a random IV, AES-256-CBC under SHA-256 of .datakey. */
$cm_write = function (string $dir, string $user, array $recs): void {
    $key = trim((string)file_get_contents($dir . '/.datakey'));
    $iv = random_bytes(16);
    $ct = openssl_encrypt(json_encode(['seq' => 1, 'recs' => $recs]), 'aes-256-cbc', hash('sha256', $key, true), OPENSSL_RAW_DATA, $iv);
    file_put_contents("$dir/records-$user.json", 'ENC1:' . base64_encode($iv . $ct));
};
$ev = fn(string $id, string $date, ?string $time, array $more = []) => [$id => ['id' => $id, 'type' => 'event', 'updated' => 1,
    'payload' => $more + ['text' => "T $id", 'date' => $date, 'time' => $time, 'repeat' => null, 'calendarId' => 'c1', 'ord' => 'a']]];
$cal = fn(string $id, string $color) => [$id => ['id' => $id, 'type' => 'calendar', 'updated' => 1, 'payload' => ['name' => $id, 'color' => $color, 'ord' => 'a']]];
$share = fn(array $partners, array $calendars, array $sel = []) => ['share' => ['id' => 'share', 'type' => 'share', 'updated' => 1,
    'payload' => ['partners' => $partners, 'calendars' => $calendars, 'folders' => [], 'notefolders' => []] + ($sel ? ['sel' => $sel] : [])]];

$dir = harness_dir();
file_put_contents("$dir/.datakey", bin2hex(random_bytes(32)) . "\n");

// ---- 1. Reading the store ----
check(calmind_records($dir, 'alex') === [], 'no store is no records');
$cm_write($dir, 'alex', $cal('c1', '#3366CC') + $ev('e1', '2026-11-10', '09:00', ['end' => '10:30']));
check(array_keys(calmind_records($dir, 'alex')) === ['c1', 'e1'], 'an ENC1 store decrypts with the .datakey');
fails(fn() => calmind_records($dir, '../alex'), 'not a person');
fails(fn() => calmind_records($dir, 'outsider'), 'not a person');
file_put_contents("$dir/records-sam.json", 'ENC1:' . base64_encode(random_bytes(33)));
fails(fn() => calmind_records($dir, 'sam'), 'decrypt');
file_put_contents("$dir/records-sam.json", 'ENC1:abc');
fails(fn() => calmind_records($dir, 'sam'), 'truncated');
$bare = harness_dir();
file_put_contents("$bare/records-alex.json", 'ENC1:' . base64_encode(random_bytes(64)));
fails(fn() => calmind_records($bare, 'alex'), 'data key missing');
file_put_contents("$bare/records-alex.json", json_encode(['recs' => $ev('p', '2026-11-10', '08:00')]));
check(array_keys(calmind_records($bare, 'alex')) === ['p'], 'a plaintext store (CalMind reads those too) is read');

// ---- 2. Repeats: CalMind's spec/repeats.json step vectors ----
foreach ([['2026-01-31', 'month', 1, 1, '2026-02-28'], ['2026-01-31', 'month', 1, 2, '2026-03-31'], ['2024-01-31', 'month', 1, 1, '2024-02-29'],
          ['2024-02-29', 'year', 1, 1, '2025-02-28'], ['2026-12-30', 'week', 1, 1, '2027-01-06'], ['2026-11-10', 'day', 3, 2, '2026-11-16'],
          ['2026-10-31', 'month', 2, 1, '2026-12-31']] as [$start, $unit, $n, $i, $want]) {
    check(calmind_repeat_step($start, $n, $unit, $i) === $want, "repeat step $start +$i×$n $unit");
}

// ---- 3. Pieces: placement on the 7a-to-7a planner day ----
$one = fn(array $recs, string $from, string $to) => array_map(fn($p) => [$p['date'], $p['start'], $p['length']], calmind_pieces($recs, 'alex', null, $from, $to));
check($one($ev('a', '2026-11-10', '09:00', ['end' => '10:30']), '2026-11-01', '2026-11-30') === [['2026-11-10', 540, 90]], 'a 9a-10:30a event');
check($one($ev('a', '2026-11-10', '09:00'), '2026-11-01', '2026-11-30') === [['2026-11-10', 540, 60]], 'no end is an hour');
check($one($ev('a', '2026-11-10', null), '2026-11-01', '2026-11-30') === [], 'an all-day event is not drawn');
check($one($ev('a', '2026-11-11', '01:00', ['end' => '02:00']), '2026-11-01', '2026-11-30') === [['2026-11-10', 1500, 60]], 'an event at 1a is on the night of the evening before');
check($one($ev('a', '2026-11-11', '01:00', ['end' => '02:00']), '2026-11-10', '2026-11-10') === [['2026-11-10', 1500, 60]], 'the next date is read for the small hours of the last day asked');
check($one($ev('a', '2026-11-10', '23:00', ['end' => '01:00']), '2026-11-01', '2026-11-30') === [['2026-11-10', 1380, 120]], 'an end past midnight is the small hours');
check($one($ev('a', '2026-11-10', '06:00', ['end' => '08:00']), '2026-11-01', '2026-11-30') === [['2026-11-09', 1800, 60], ['2026-11-10', 420, 60]], 'an event across 7a is cut in two');
check($one($ev('a', '2026-11-10', '20:00', ['end' => '09:00', 'endDate' => '2026-11-12']), '2026-11-01', '2026-11-30')
    === [['2026-11-10', 1200, 660], ['2026-11-11', 420, 1440], ['2026-11-12', 420, 120]], 'a multi-day event is a piece on each planner day');
check($one($ev('a', '2026-11-10', '09:00', ['end' => '10:00']), '2026-11-11', '2026-11-30') === [], 'outside the range is left out');
check($one($ev('a', '2026-11-02', '18:00', ['end' => '19:00', 'repeat' => ['n' => 1, 'unit' => 'week']]), '2026-11-08', '2026-11-24')
    === [['2026-11-09', 1080, 60], ['2026-11-16', 1080, 60], ['2026-11-23', 1080, 60]], 'a weekly repeat is expanded over the range');
check(count($one($ev('a', '2026-11-02', '18:00', ['repeat' => ['n' => 0, 'unit' => 'week']]), '2026-11-01', '2026-11-30')) === 1, 'a rule that does not advance is a one-off');
check(count($one($ev('a', '2026-11-02', '18:00', ['repeat' => ['n' => 1, 'unit' => 'fortnight']]), '2026-11-01', '2026-11-30')) === 1, 'an unknown unit is a one-off');
check($one($ev('a', '2026-11-10', '09:00') + ['x' => ['id' => 'x', 'type' => 'event', 'deleted' => true, 'payload' => ['date' => '2026-11-10', 'time' => '10:00']]], '2026-11-01', '2026-11-30')
    === [['2026-11-10', 540, 60]], 'a deleted event is left out');
check($one($ev('a', '2026-11-10', '9:00') + $ev('b', '2026-13-01', '09:00') + $ev('c', 'soon', '09:00'), '2026-11-01', '2026-11-30') === [], 'malformed dates and times are left out');
$p = calmind_pieces($cal('c1', '#3366CC') + $ev('a', '2026-11-10', '09:00', ['text' => str_repeat('é', 600)]), 'alex', null, '2026-11-10', '2026-11-10')[0];
check($p['color'] === '#3366cc' && mb_strlen($p['text']) === 500 && $p['owner'] === 'alex' && $p['id'] === 'alex:a:2026-11-10:2026-11-10', 'color, owner, id and the text cap');
check(calmind_pieces($cal('c1', 'red;x') + $ev('a', '2026-11-10', '09:00'), 'alex', null, '2026-11-10', '2026-11-10')[0]['color'] === '', 'a color that is not #rrggbb is left out');
check(calmind_pieces($ev('a', '2026-11-10', '09:00'), 'alex', ['c2'], '2026-11-10', '2026-11-10') === [], 'only the calendars asked for');

// ---- 4. Who sees what ----
$cm_write($dir, 'alex', $cal('c1', '#3366cc') + $cal('c9', '#000000') + $ev('mine', '2026-11-10', '09:00') + $ev('secret', '2026-11-10', '11:00', ['calendarId' => 'c9']) + $share(['sam'], ['c1']));
$cm_write($dir, 'sam', $cal('k1', '#aa0000') + $cal('k2', '#00aa00') + $ev('shared', '2026-11-10', '12:00', ['calendarId' => 'k1']) + $ev('private', '2026-11-10', '13:00', ['calendarId' => 'k2']) + $share(['alex'], ['k1']));
$ids = fn(string $viewer) => array_map(fn($e) => $e['owner'] . ':' . explode(':', $e['id'])[1], calmind_events($dir, $viewer, '2026-11-10', '2026-11-10')['events']);
check($ids('alex') === ['alex:mine', 'alex:secret', 'sam:shared'], 'Alex sees all of his own and what Sam shares with him: ' . json_encode($ids('alex')));
check($ids('sam') === ['sam:shared', 'sam:private', 'alex:mine'], 'Sam sees all of hers and only his shared calendar: ' . json_encode($ids('sam')));
$planDir = harness_dir();
$placement = "$planDir/calmind-both-calendar.json";
check(calmind_both_calendar($planDir) === null, 'a missing Both calendar config leaves placement unchanged');
foreach (['not json', '{"owner":"outsider","calendarId":"c1"}', '{"owner":"alex","calendarId":"../c1"}'] as $bad) {
    file_put_contents($placement, $bad);
    check(calmind_both_calendar($planDir) === null, 'invalid Both calendar config leaves placement unchanged');
}
$both = ['owner' => 'alex', 'calendarId' => 'c1'];
file_put_contents($placement, json_encode($both, JSON_THROW_ON_ERROR));
check(calmind_both_calendar($planDir) === $both, 'the protected config selects one owner and calendar ID');
$bothIds = fn(string $viewer, array $map) => array_column(array_filter(
    calmind_events($dir, $viewer, '2026-11-10', '2026-11-10', $map)['events'], fn($e) => !empty($e['both'])
), 'id');
check($bothIds('alex', $both) === ['alex:mine:2026-11-10:2026-11-10'], 'only the selected calendar spans Both for its owner');
check($bothIds('sam', $both) === ['alex:mine:2026-11-10:2026-11-10'], 'the same placement applies to an authorized partner');
check($bothIds('sam', ['owner' => 'alex', 'calendarId' => 'c9']) === [], 'Both placement never grants access to an unshared calendar');
check(!isset(calmind_pieces($ev('other', '2026-11-10', '09:00'), 'sam', null, '2026-11-10', '2026-11-10', $both)[0]['both']),
    'the same ID in a different account keeps its original lane');
$cm_write($dir, 'sam', $cal('k1', '#aa0000') + $cal('k2', '#00aa00') + $ev('shared', '2026-11-10', '12:00', ['calendarId' => 'k1']) + $ev('private', '2026-11-10', '13:00', ['calendarId' => 'k2']) + $share(['alex'], ['k1', 'k2'], ['alex' => ['calendars' => ['k2'], 'folders' => [], 'notefolders' => []]]));
check($ids('alex') === ['alex:mine', 'alex:secret', 'sam:private'], 'a per-partner selection wins over the flat list');
$cm_write($dir, 'sam', $cal('k1', '#aa0000') + $ev('shared', '2026-11-10', '12:00', ['calendarId' => 'k1']) + $share([], ['k1']));
check($ids('alex') === ['alex:mine', 'alex:secret'], 'no partnership on her side: nothing of hers');
check($ids('sam') === ['sam:shared'], 'and nothing of his for her, though he names her');
unlink("$dir/records-sam.json");
check($ids('alex') === ['alex:mine', 'alex:secret'], 'no CalMind store for the other person: only one\'s own');
refuses(fn() => calmind_events($dir, 'outsider', '2026-11-10', '2026-11-10'), 403, 'forbidden');
foreach ([[null, '2026-11-10'], ['2026-11-10', null], ['2026-11-11', '2026-11-10'], ['2026-11-01', '2027-01-15'], ['10/11/2026', '2026-11-10'], [['x'], '2026-11-10']] as [$f, $t]) {
    refuses(fn() => calmind_events($dir, 'alex', $f, $t), 400, 'invalid');
}
file_put_contents("$dir/records-alex.json", 'ENC1:' . base64_encode(random_bytes(33)));
fails(fn() => calmind_events($dir, 'alex', '2026-11-10', '2026-11-10'), 'decrypt');

// ---- 5. The hide preference ----
$stored = false;
$set = function (bool $h) use (&$stored) { $stored = $h; };
$get = function () use (&$stored) { return $stored; };
check(op_set_calmind(['hidden' => true], 'alex', $set, $get) === ['calmind' => 'hidden'] && $stored === true, 'hidden is saved');
check(op_set_calmind(['hidden' => false], 'sam', $set, $get) === ['calmind' => 'shown'] && $stored === false, 'shown is saved');
foreach ([null, 'true', 1, 0, [], 'hidden'] as $bad) { refuses(fn() => op_set_calmind(['hidden' => $bad], 'alex', $set, $get), 400, 'invalid'); }
refuses(fn() => op_set_calmind(['hidden' => true], 'outsider', $set, $get), 403, 'forbidden');
refuses(fn() => op_set_calmind(['hidden' => true], 'alex', fn() => null, fn() => false), 503, 'unavailable');
refuses(fn() => op_set_calmind(['hidden' => true], 'alex', function () { throw new RuntimeException('disk'); }, $get), 503, 'unavailable');

// ---- 6. All-day events: a strip above the grid, not pieces of it (#171) ----
// Planner day D is D 7a to D+1 7a, so an all-day date D belongs to planner day D; a later endDate runs through that day, inclusive.
$day = fn(array $recs, string $from, string $to, ?array $cals = null) => array_map(fn($p) => [$p['date'], $p['text']], calmind_allday_pieces($recs, 'alex', $cals, $from, $to));
$ad = fn(string $id, string $date, array $more = []) => $ev($id, $date, null, $more + ['text' => "AD $id"]);
check($day($ad('a', '2026-11-10'), '2026-11-01', '2026-11-30') === [['2026-11-10', 'AD a']], 'an all-day event is on its own planner day');
check($day($ad('a', '2026-11-10'), '2026-11-11', '2026-11-30') === [] && $day($ad('a', '2026-11-10'), '2026-11-01', '2026-11-09') === [], 'and on no other day');
check($day($ad('a', '2026-11-10', ['time' => '']) + $ad('b', '2026-11-10', ['time' => 'soon']) + $ad('c', '2026-11-10', ['time' => '25:00']), '2026-11-10', '2026-11-10')
    === [['2026-11-10', 'AD a'], ['2026-11-10', 'AD b'], ['2026-11-10', 'AD c']], 'no usable time is all-day (an empty or malformed one too)');
check($day($ev('t', '2026-11-10', '09:00'), '2026-11-10', '2026-11-10') === [], 'a timed event is never in the strip');
check(calmind_pieces($ad('a', '2026-11-10'), 'alex', null, '2026-11-10', '2026-11-10') === [], 'and an all-day one never on the grid');
check($day($ad('a', '2026-11-10', ['endDate' => '2026-11-12']), '2026-11-01', '2026-11-30') === [['2026-11-10', 'AD a'], ['2026-11-11', 'AD a'], ['2026-11-12', 'AD a']], 'a multi-day event is on each day, the end date included');
check($day($ad('a', '2026-11-10', ['endDate' => '2026-11-12']), '2026-11-12', '2026-11-12') === [['2026-11-12', 'AD a']], 'its last day is found from a range that starts on it');
check($day($ad('a', '2026-11-10', ['endDate' => '2026-11-12']), '2026-11-11', '2026-11-11') === [['2026-11-11', 'AD a']], 'and a middle one');
check($day($ad('a', '2026-11-10', ['endDate' => '2026-11-10']) + $ad('b', '2026-11-10', ['endDate' => '2026-11-09']) + $ad('c', '2026-11-10', ['endDate' => 'x']), '2026-11-01', '2026-11-30')
    === [['2026-11-10', 'AD a'], ['2026-11-10', 'AD b'], ['2026-11-10', 'AD c']], 'an end date that is not after the start is the one day');
check(count($day($ad('a', '2026-01-01', ['endDate' => '2030-01-01']), '2026-01-01', '2026-03-31')) === 60 && count($day($ad('a', '2026-01-01', ['endDate' => '2030-01-01']), '2026-04-01', '2026-04-30')) === 0, 'a span is cut at 60 days');
check($day($ad('a', '2026-11-02', ['endDate' => '2026-11-03', 'repeat' => ['n' => 1, 'unit' => 'week']]), '2026-11-08', '2026-11-24')
    === [['2026-11-09', 'AD a'], ['2026-11-10', 'AD a'], ['2026-11-16', 'AD a'], ['2026-11-17', 'AD a'], ['2026-11-23', 'AD a'], ['2026-11-24', 'AD a']], 'a repeating multi-day event covers each occurrence\'s days');
check($day($ad('a', '2026-11-08', ['endDate' => '2026-11-10', 'repeat' => ['n' => 1, 'unit' => 'week']]), '2026-11-10', '2026-11-10') === [['2026-11-10', 'AD a']], 'an occurrence that began before the range still reaches into it');
check($day($ad('a', '2026-11-10', ['text' => '  ']), '2026-11-10', '2026-11-10') === [['2026-11-10', 'Event']], 'no words read Event');
check($day($ad('a', '2026-11-10') + ['x' => ['id' => 'x', 'type' => 'event', 'deleted' => true, 'payload' => ['date' => '2026-11-10', 'text' => 'gone']]], '2026-11-10', '2026-11-10') === [['2026-11-10', 'AD a']], 'a deleted one is left out');
$p = calmind_allday_pieces($cal('c1', '#3366CC') + $ad('a', '2026-11-10', ['text' => str_repeat('é', 600)]), 'alex', null, '2026-11-10', '2026-11-10')[0];
check($p === ['id' => 'alex:a:2026-11-10:2026-11-10', 'owner' => 'alex', 'date' => '2026-11-10', 'text' => str_repeat('é', 500), 'color' => '#3366cc'], 'owner, id, color and the text cap');
check($day($ad('a', '2026-11-10'), '2026-11-10', '2026-11-10', ['c2']) === [], 'only the calendars asked for');
$both = ['owner' => 'alex', 'calendarId' => 'c1'];
check(!empty(calmind_allday_pieces($ad('a', '2026-11-10'), 'alex', null, '2026-11-10', '2026-11-10', $both)[0]['both']) && !isset(calmind_allday_pieces($ad('a', '2026-11-10'), 'sam', null, '2026-11-10', '2026-11-10', $both)[0]['both']), 'the designated Both calendar marks its owner\'s all-day events');
// Visibility is the timed events\': the viewer\'s own whole, the other person\'s only what they share with the viewer.
$cm_write($dir, 'alex', $cal('c1', '#3366cc') + $cal('c9', '#000000') + $ad('mine', '2026-11-10') + $ad('secret', '2026-11-10', ['calendarId' => 'c9']) + $share(['sam'], ['c1']));
$cm_write($dir, 'sam', $cal('k1', '#aa0000') + $cal('k2', '#00aa00') + $ad('shared', '2026-11-10', ['calendarId' => 'k1']) + $ad('private', '2026-11-10', ['calendarId' => 'k2']) + $share(['alex'], ['k1']));
$adIds = fn(string $viewer) => array_map(fn($e) => $e['owner'] . ':' . explode(':', $e['id'])[1], calmind_events($dir, $viewer, '2026-11-10', '2026-11-10')['allDay']);
check($adIds('alex') === ['alex:mine', 'alex:secret', 'sam:shared'], 'Alex sees his own and what Sam shares: ' . json_encode($adIds('alex')));
check($adIds('sam') === ['sam:private', 'sam:shared', 'alex:mine'], 'Sam sees hers and only his shared calendar: ' . json_encode($adIds('sam')));
check(calmind_events($dir, 'alex', '2026-11-10', '2026-11-10')['events'] === [], 'and the grid\'s list has none of them');
$cm_write($dir, 'sam', $cal('k1', '#aa0000') + $ad('shared', '2026-11-10', ['calendarId' => 'k1']) + $share([], ['k1']));
check($adIds('alex') === ['alex:mine', 'alex:secret'] && $adIds('sam') === ['sam:shared'], 'no partnership on her side: nothing crosses');
