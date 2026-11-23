<?php
declare(strict_types=1);
// The poll (`GET ?since=N`) and the write's answer skip the validation a read that sends data needs (performance, never behavior): the answers are exactly the full path's.
use function PlanMind\{fresh_db, mutate, poll_since, poll_unchanged, snapshot, validate_db};

// ---- 1. What a poll says it holds ----
foreach (['0', '7', '999999999999999'] as $text) { check(poll_since($text) === (int)$text, "since $text reads as its number"); }
foreach ([null, '', '-1', '01', '1.5', '1e3', ' 7', '7 ', '1000000000000000', 7, 7.0, true, ['7']] as $bad) { check(poll_since($bad) === null, 'since ' . json_encode($bad) . ' is no revision'); }

// ---- 2. Unchanged is answered from the stored revision, and only when the full read would have said the same ----
$db = harness_db();
check(poll_unchanged($db, 'alex', 7) && poll_unchanged($db, 'sam', 7), 'both people hold the current revision: nothing to send');
check(!poll_unchanged($db, 'alex', 6) && !poll_unchanged($db, 'alex', 8) && !poll_unchanged($db, 'alex', 0) && !poll_unchanged($db, 'alex', null), 'another revision, or none: a full read');
foreach (['outsider', '', 'Alex', 'both', 'admin'] as $who) { check(!poll_unchanged($db, $who, 7), "$who is not answered, even with the right revision"); }
check(!poll_unchanged([], 'alex', 0), 'an empty store takes the full read');
check(!poll_unchanged(['v' => 1, 'revision' => 7, 'tasks' => [], 'notes' => []], 'alex', 7), 'an old store (converted in memory by a read) takes the full read');
$older = $db; $older['v'] = PlanMind\MODEL['storeVersion'] - 1;
check(!poll_unchanged($older, 'alex', 7), 'a store of an older version takes the full read');
$odd = $db; $odd['revision'] = '7';
check(!poll_unchanged($odd, 'alex', 7), 'a revision that is not a count is not trusted');
// Whatever the shortcut says, the full path agrees on a valid store.
check(snapshot($db, 'alex')['revision'] === 7, 'the full read holds the same revision');

// ---- 3. A write's answer, built from what mutate() already validated, is the full path's answer ----
$todo = ['action' => 'add', 'kind' => 'todo', 'id' => harness_id(900), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex'], 'title' => 'Polled'];
$changed = mutate($db, $todo, 'alex', '2026-10-30');
check($changed['revision'] === 8, 'the add moved the revision');
foreach (['alex', 'sam'] as $who) {
    check(snapshot($changed, $who, true) === snapshot($changed, $who), "a changed store reads the same checked or not ($who)");
    $same = mutate($changed, ['action' => 'savePrefs', 'selection' => snapshot($changed, $who)['prefs']['selection']], $who);
    check(snapshot($same, $who, true) === snapshot($same, $who), "an unchanged store reads the same checked or not ($who)");
}
check(snapshot([], 'alex', true) === snapshot([], 'alex') && snapshot([], 'alex', true)['v'] === PlanMind\MODEL['storeVersion'], 'an empty store is still read as a fresh one when "checked"');
// A db that was not validated is never trusted because the caller said so: a damaged current-version store, when asked unchecked, still fails closed.
$damaged = $db; $damaged['tasks'] = 'nonsense';
fails(fn() => snapshot($damaged, 'alex'));
refuses(fn() => snapshot($db, 'outsider', true), 403, 'forbidden');
