<?php
declare(strict_types=1);
// Simultaneous writers: 6 separate PHP processes each add one distinct item to the same store at the same moment.
// Every item must survive, the global revision must be exactly 6 and the file must still decrypt and validate.
// The first rounds go through Store::transaction alone (the lock, the atomic write, the revision); the last rounds
// go through mutate() and the real add handler.
use PlanMind\Store;
use function PlanMind\snapshot;

$worker = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/planner.php';
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$store = new PlanMind\Store($dir);
$id = sprintf('%08x-0000-4000-8000-%012x', (int)$n, (int)$n);
if ($mode === 'mutate') {
    $store->transaction('tasks', fn($db) => PlanMind\mutate($db, ['action' => 'add', 'kind' => 'todo', 'id' => $id, 'scope' => 'day',
        'date' => '2026-10-30', 'owners' => ['alex'], 'title' => "Item $n"], 'alex'));
} else {
    $store->transaction('tasks', function ($db) use ($id, $n) {
        $db = PlanMind\Invariants::load($db);
        $now = gmdate('c');
        $record = ['id' => $id, 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex'], 'title' => "Item $n", 'done' => false, 'pos' => 1024 * (int)$n];
        $db['tasks'][$id] = $record + ['revision' => 1, 'createdBy' => 'alex', 'updatedBy' => 'alex', 'createdAt' => $now, 'updatedAt' => $now, 'ak' => PlanMind\fingerprint($record)];
        return PlanMind\touch($db);
    });
}
PHP;

$round = function (string $mode) use ($worker): void {
    [$store, $dir] = harness_store();
    harness_workers($worker, $dir, 6, $mode);
    $db = $store->transaction('tasks', fn($db) => $db);
    $snapshot = snapshot($db, 'sam');
    $titles = array_column($snapshot['tasks'], 'title');
    sort($titles);
    check($titles === ['Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5', 'Item 6'], "$mode: every concurrent add is present (lost update): " . implode(',', $titles));
    check($snapshot['revision'] === 6, "$mode: the global revision counts each write once, got {$snapshot['revision']}");
    check(count($snapshot['lists']) === 2 && $snapshot['lists'][0]['revision'] === 1, "$mode: the permanent lists are seeded once");
    check(!glob($dir . '/*.tmp') && count(glob($dir . '/*.enc')) === 1, "$mode: no partial files are left");
};
foreach (['store', 'store', 'mutate', 'mutate'] as $mode) { $round($mode); }
