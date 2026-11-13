<?php
declare(strict_types=1);
use PlanMind\{Invariants, Store};
use function PlanMind\{fingerprint, fresh_db, mutate, snapshot};

$day = '2026-11-10';
$stamp = '2026-11-01T10:00:00+00:00';
$event = static fn(int $n, array $owners, int $start, int $length, string $date = '2026-11-10'): array => [
    'id' => harness_id(800 + $n), 'date' => $date, 'owners' => $owners, 'start' => $start, 'length' => $length,
    'text' => "Fixture appointment $n", 'revision' => 3, 'createdBy' => 'alex', 'updatedBy' => 'sam',
    'createdAt' => $stamp, 'updatedAt' => $stamp, 'ak' => 'f123456789abcdef',
];
$short = $event(1, ['alex'], 600, 15);
$shortFields = array_intersect_key($short, array_flip(['owners', 'date', 'text', 'start', 'length']));
$short['ak'] = fingerprint(['kind' => 'event'] + $shortFields);
$personal = $event(2, ['alex'], 615, 45);
$both = $event(3, ['alex', 'sam'], 660, 30);
$sam = $event(4, ['sam'], 690, 30);
$later = $event(5, ['alex'], 750, 45);
$independent = $event(6, ['sam'], 615, 30);
$otherDay = $event(7, ['sam'], 690, 30, '2026-11-11');
$old = array_replace(fresh_db($stamp), ['v' => 4, 'revision' => 11,
    'events' => array_column([$both, $later, $independent, $otherDay, $sam, $personal, $short], null, 'id')]);

$dir = harness_dir();
$store = new Store($dir);
$store->transaction('tasks', fn($db) => $old);
$bytes = file_get_contents("$dir/tasks.enc");
$read = $store->transaction('tasks', fn($db) => $db);
$projected = Invariants::load($read);
check(snapshot($read, 'alex')['revision'] === 12 && $projected['v'] === 5, 'v4 reads the converted schedule at a new revision');
check(file_get_contents("$dir/tasks.enc") === $bytes && file_get_contents("$dir/tasks.version") === "4\n", 'read leaves the old store and version marker intact');
foreach ([[$short, 600, 30], [$personal, 630, 45], [$both, 675, 30], [$sam, 705, 30]] as [$was, $start, $length]) {
    check($projected['events'][$was['id']] === array_replace($was, ['start' => $start, 'length' => $length, 'revision' => 4]),
        'each expansion or shift keeps the record and stamps, and invalidates stale edits');
}
foreach ([$later, $independent, $otherDay] as $same) {
    check($projected['events'][$same['id']] === $same, 'an unrelated appointment or one beyond the cascade stays byte-for-byte the same');
}
check($store->transaction('tasks', fn($db) => Invariants::load($db)) === $projected, 'a locked write materializes the same prospective plan');
check(file_get_contents("$dir/tasks.v4.enc.bak") === $bytes && file_get_contents("$dir/tasks.version") === "5\n", 'the exact v4 ciphertext is backed up and the marker advances');
$newBytes = file_get_contents("$dir/tasks.enc");
check($store->transaction('tasks', fn($db) => Invariants::load($db)) === $projected && file_get_contents("$dir/tasks.enc") === $newBytes, 'repeating the migration is a no-op');
check(sprintf('%o', fileperms("$dir/tasks.v4.enc.bak") & 0777) === '600', 'the backup remains private');
$retry = ['action' => 'add', 'kind' => 'event', 'id' => $short['id']] + $shortFields;
check(mutate($projected, $retry, 'alex') === $projected, 'a retry of an original 15-minute add acknowledges the same record without undoing migration');
refuses(fn() => mutate($projected, array_replace($retry, ['id' => harness_id(899)]), 'alex'), 400, 'invalid');

$blocked = array_replace($old, ['events' => array_column([$event(8, ['alex'], 1800, 15), $event(9, ['alex'], 1815, 45)], null, 'id')]);
$blockedDir = harness_dir();
$blockedStore = new Store($blockedDir);
$blockedStore->transaction('tasks', fn($db) => $blocked);
$blockedBytes = file_get_contents("$blockedDir/tasks.enc");
fails(fn() => $blockedStore->transaction('tasks', fn($db) => Invariants::load($db)), 'cannot fit an appointment');
check(file_get_contents("$blockedDir/tasks.enc") === $blockedBytes && file_get_contents("$blockedDir/tasks.version") === "4\n"
    && !file_exists("$blockedDir/tasks.v4.enc.bak"), 'an overflow leaves every record and marker unchanged');
