<?php
declare(strict_types=1);
// Preferences (the picker state and whether the desktop sidebar is shown): each account keeps and sees only its own,
// the server sanitises what it stores, the global revision does not move, and an unchanged state is never written.
// Case 12 of the server test plan.
use PlanMind\RequestError;
use function PlanMind\{fresh_db, mutate, snapshot, validate_db};

$caught = function (callable $fn): RequestError {
    try { $fn(); } catch (RequestError $e) { return $e; }
    throw new RuntimeException('Request unexpectedly accepted');
};
$prefs = fn(array $db, mixed $selection, string $user = 'alex') => mutate($db, ['action' => 'savePrefs', 'selection' => $selection], $user);
$sidebar = fn(array $db, mixed $value, string $user = 'alex', mixed $selection = null) => mutate($db, ['action' => 'savePrefs', 'selection' => $selection ?? ($db['prefs'][$user]['selection'] ?? ['base' => 'both', 'overlays' => []]), 'sidebar' => $value], $user);
$shownBy = fn(array $db, string $user) => snapshot($db, $user)['prefs']['sidebar'];
$pick = fn(string $base, array $overlays = []) => ['base' => $base, 'overlays' => $overlays];
$both = $pick('both');
$without = fn(array $db, string ...$keys) => array_diff_key($db, array_flip($keys));
$camping = HARNESS_CUSTOM; $garden = harness_id(501); $hobbies = harness_id(502); $school = harness_id(503);
$db = harness_db();
foreach ([$garden => 'Garden', $hobbies => 'Hobbies', $school => 'School'] as $id => $name) {
    $db = mutate($db, ['action' => 'saveList', 'id' => $id, 'name' => $name, 'color' => 'red', 'revision' => 0], 'alex');
}
check($db['revision'] === 10 && $db['prefs']['alex']['selection'] === $pick('both', [$camping]), 'the reference db: three more lists and Alex\'s picker state');

// ---- 1. Each account keeps and sees only its own ----
$a = $prefs($db, $pick('alex', [$garden]), 'sam');
check(snapshot($a, 'sam')['prefs']['selection'] === $pick('alex', [$garden]), 'Sam gets back what Sam saved');
check(snapshot($a, 'alex')['prefs']['selection'] === $pick('both', [$camping]) && $a['prefs']['alex'] === $db['prefs']['alex'], 'Alex\'s state is untouched and Sam\'s never reaches Alex');
check(snapshot($db, 'sam')['prefs']['selection'] === $both, 'an account that never saved reads the default');
$b = $prefs($a, $pick($camping), 'alex');
check(snapshot($b, 'alex')['prefs']['selection'] === $pick($camping) && snapshot($b, 'sam')['prefs']['selection'] === $pick('alex', [$garden]), 'saving is last write wins per account, independent of the other');
check(array_keys(snapshot($b, 'sam')['prefs']) === ['selection', 'sidebar'] && array_keys($b['prefs']['sam']) === ['selection'], 'a stored state holds the selection and, only when the sidebar is hidden, that; a snapshot always says both');
check($prefs($db, $pick('sam', [$camping]), 'sam')['prefs']['sam']['selection'] === $pick('sam', [$camping]), 'a person list can be the base');
validate_db($b);

// ---- 2. Nothing but the caller's state changes, and not the global revision ----
check($a['revision'] === 10 && $b['revision'] === 10, 'savePrefs does not move the global revision');
check($without($a, 'prefs') === $without($db, 'prefs'), 'no list, setting, record or note changes');
$noted = mutate($db, ['action' => 'saveSettings', 'bothColor' => 'red', 'revision' => 1], 'sam');
check($noted['revision'] === 11 && $prefs($noted, $pick('sam'))['revision'] === 11, 'it keeps whatever revision the store has');

// ---- 3. Sanitising: the server stores what is usable and drops the rest without an error ----
$gone = harness_id(777);
$table = [
    'unknown base' => [$pick($gone), $both],
    'the word all' => [$pick('all'), $both],
    'empty base' => [$pick(''), $both],
    'both stays' => [$pick('both'), $both],
    'sam stays' => [$pick('sam'), $pick('sam')],
    'alex stays' => [$pick('alex'), $pick('alex')],
    'a custom base stays' => [$pick($garden), $pick($garden)],
    'overlay over both' => [$pick('both', [$garden]), $pick('both', [$garden])],
    'overlay over a person' => [$pick('sam', [$garden, $hobbies]), $pick('sam', [$garden, $hobbies])],
    'overlay order is kept' => [$pick('both', [$hobbies, $garden]), $pick('both', [$hobbies, $garden])],
    'unknown overlay' => [$pick('both', [$gone]), $both],
    'repeated overlay' => [$pick('both', [$garden, $garden]), $pick('both', [$garden])],
    'person list as overlay' => [$pick('both', ['alex', 'sam']), $both],
    'both as overlay' => [$pick('sam', ['both']), $pick('sam')],
    'overlay equal to the base' => [$pick($garden, [$garden]), $pick($garden)],
    'overlay equal to the base among others' => [$pick($garden, [$hobbies, $garden]), $pick($garden, [$hobbies])],
    'three overlays' => [$pick('both', [$garden, $hobbies, $school]), $pick('both', [$garden, $hobbies])],
    'gone overlays do not use the allowance' => [$pick('both', [$gone, $garden, 'sam', $hobbies, $school]), $pick('both', [$garden, $hobbies])],
    'unknown base with good overlays' => [$pick($gone, [$garden]), $pick('both', [$garden])],
    'extra fields are dropped' => [$pick('sam') + ['theme' => 'dark', 'pinned' => true], $pick('sam')],
];
foreach ($table as $label => [$input, $expected]) {
    $saved = $prefs($db, $input, 'sam');
    $stored = $saved['prefs']['sam']['selection'] ?? $both;
    check($stored === $expected, "$label: stored as " . json_encode($stored));
    check(!isset($saved['prefs']['sam']) || $stored !== $both, "$label: the default is never stored");
    check(snapshot($saved, 'sam')['prefs']['selection'] === $expected, "$label: returned as " . json_encode($expected));
    check($saved['prefs']['alex'] === $db['prefs']['alex'] && $saved['revision'] === 10, "$label: only the caller's state moves");
    validate_db($saved);
}
$deleted = mutate($db, ['action' => 'deleteList', 'id' => $garden, 'revision' => 1, 'confirm' => true], 'sam');
check($prefs($deleted, $pick($garden, [$hobbies]), 'alex')['prefs']['alex']['selection'] === $pick('both', [$hobbies]), 'a list deleted on another device drops out of a late save, silently');

// ---- 4. A state of the wrong shape is a client bug and is refused ----
foreach ([null, 'both', 5, [], ['both'], ['base' => 'both'], ['overlays' => []], ['base' => null, 'overlays' => []], ['base' => 5, 'overlays' => []], ['base' => ['both'], 'overlays' => []],
    ['base' => 'both', 'overlays' => null], ['base' => 'both', 'overlays' => 'x'], ['base' => 'both', 'overlays' => [$garden => $garden]], ['base' => 'both', 'overlays' => 5],
    ['base' => 'both', 'overlays' => [5]], ['base' => 'both', 'overlays' => [null]], ['base' => 'both', 'overlays' => [[$garden]]], ['base' => 'both', 'overlays' => [$garden, true]]] as $bad) {
    refuses(fn() => $prefs($db, $bad), 400, 'invalid');
}
refuses(fn() => mutate($db, ['action' => 'savePrefs'], 'alex'), 400, 'invalid');
check($caught(fn() => $prefs($db, 'both'))->getMessage() === 'Invalid list selection.', 'the refusal message');

// ---- 5. An unchanged state is not written ----
check($prefs($db, $pick('both', [$camping])) === $db, 'saving what is stored changes nothing');
check($prefs($db, $pick($gone, [$camping, $camping, 'sam'])) === $db, 'a state that sanitises to what is stored changes nothing');
check($prefs($db, $both, 'sam') === $db, 'the default for an account with no stored state changes nothing');
check($prefs($a, $pick('alex', [$garden]), 'sam') === $a, 'saving the stored state again changes nothing');
check($prefs($db, $both) !== $db && $prefs($db, $both)['prefs']['alex']['selection'] === $both, 'but the default over a stored state is a change');

// ---- 6. The desktop sidebar: shown unless the caller said hidden, per account, last write wins ----
check($shownBy($db, 'alex') === 'shown' && $shownBy($db, 'sam') === 'shown', 'an account that never saved reads the sidebar as shown');
$hid = $sidebar($db, 'hidden', 'alex');
check($shownBy($hid, 'alex') === 'hidden' && $shownBy($hid, 'sam') === 'shown', 'hidden is Alex\'s alone: Sam still sees the sidebar');
check($hid['prefs']['alex'] === ['selection' => $pick('both', [$camping]), 'sidebar' => 'hidden'], 'it is stored next to the selection, as the word hidden');
check($hid['revision'] === 10 && $without($hid, 'prefs') === $without($db, 'prefs'), 'it does not move the global revision or touch a record');
check($shownBy($sidebar($hid, 'hidden', 'sam'), 'alex') === 'hidden' && $shownBy($sidebar($hid, 'hidden', 'sam'), 'sam') === 'hidden', 'both people can hide it, each for themselves');
check($shownBy($sidebar($hid, 'shown'), 'alex') === 'shown' && !array_key_exists('sidebar', $sidebar($hid, 'shown')['prefs']['alex']), 'shown again: the default is not stored');
check($sidebar($db, 'shown') === $db && $sidebar($hid, 'hidden') === $hid, 'saving what is stored changes nothing');
check($shownBy($prefs($hid, $pick('sam')), 'alex') === 'hidden', 'a save without the sidebar keeps it hidden');
check($shownBy($prefs($hid, $pick('sam', [$garden])), 'alex') === 'hidden' && $prefs($hid, $pick('both', [$camping])) === $hid, 'and a selection save that changes nothing writes nothing');
check($prefs($sidebar($hid, 'shown'), $pick('both', [$camping])) !== $hid, 'once shown it stays shown through a selection save');
check($shownBy($sidebar($db, 'hidden', 'alex', $pick('sam')), 'alex') === 'hidden' && snapshot($sidebar($db, 'hidden', 'alex', $pick('sam')), 'alex')['prefs']['selection'] === $pick('sam'), 'one save can carry both');
foreach ([null, '', 'Hidden', 'HIDDEN', 'collapsed', 'off', 'true', true, 1, 0, ['hidden'], ['sidebar' => 'hidden'], 'hidden '] as $unknown) {
    check($shownBy($sidebar($db, $unknown), 'alex') === 'shown', 'an unknown value reads as shown: ' . json_encode($unknown));
    check($shownBy($sidebar($hid, $unknown), 'alex') === 'shown', 'and it un-hides a hidden sidebar, fail closed to shown: ' . json_encode($unknown));
    check($sidebar($db, $unknown) === $db, 'and a value that reads as shown, from the default, writes nothing: ' . json_encode($unknown));
}
$deletedWhileHidden = mutate($hid, ['action' => 'deleteList', 'id' => $camping, 'revision' => 1, 'confirm' => true], 'sam');
check($deletedWhileHidden['prefs']['alex'] === ['selection' => $both, 'sidebar' => 'hidden'], 'deleting a list rewrites the selection and leaves the sidebar word');
validate_db($hid); validate_db($deletedWhileHidden);
$garbled = $db; $garbled['prefs']['alex']['sidebar'] = 'collapsed';
check($shownBy($garbled, 'alex') === 'shown', 'a stored word nobody recognises reads as shown');
validate_db($garbled);
foreach ([5, true, null, ['hidden']] as $bad) { $broken = $db; $broken['prefs']['alex']['sidebar'] = $bad; fails(fn() => validate_db($broken), 'sidebar'); }
$extra = $db; $extra['prefs']['alex']['theme'] = 'dark';
fails(fn() => validate_db($extra), 'wrong fields');

[$store, $dir] = harness_store();
$run = fn(mixed $selection, string $user = 'alex') => $store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'savePrefs', 'selection' => $selection], $user));
$bytes = fn() => (string)file_get_contents($dir . '/tasks.enc');
$run($both);
check(!file_exists($dir . '/tasks.enc') && !file_exists($dir . '/.key'), 'the default on a store that does not exist yet creates nothing');
$seeded = $run($pick('sam'));
check($seeded['revision'] === 0 && $seeded['prefs']['alex']['selection'] === $pick('sam') && isset($seeded['lists']['sam']), 'the first state written seeds a v2 store at revision 0');
$written = $bytes();
$run($pick('sam')); $run($pick('sam', ['sam', $gone]));
check($bytes() === $written, 'the same state, even in dirty form, leaves the file byte for byte');
$run($pick('alex'));
check($bytes() !== $written, 'a different state rewrites it');
$run($pick('sam'), 'sam');
check(snapshot($store->transaction('tasks', fn($stored) => $stored), 'alex')['prefs']['selection'] === $pick('alex') && snapshot($store->transaction('tasks', fn($stored) => $stored), 'sam')['prefs']['selection'] === $pick('sam'), 'two accounts share the file and keep their own state');
$store->transaction('tasks', fn($stored) => mutate($stored, ['action' => 'saveSettings', 'bothColor' => 'red', 'revision' => 1], 'alex'));
$run($pick('both'));
check(snapshot($store->transaction('tasks', fn($stored) => $stored), 'alex')['revision'] === 1, 'after a real write the revision is 1, and a preference save leaves it there');
