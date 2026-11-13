<?php
declare(strict_types=1);
// Simultaneous writers: 6 separate PHP processes each add one distinct member to the same workspace at the same moment.
// Every member must survive and the file must still decrypt.
$worker = <<<'PHP'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/taskmind.php';
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$store = new TaskMind\Store($dir);
$store->transaction('workspace', function ($db) use ($n) {
    $db['v'] = 1;
    $db['members'][] = ['id' => "m$n", 'role' => 'member', 'added' => 0, 'by' => '', 'name' => ''];
    return $db;
});
PHP;

foreach (['one', 'two', 'three'] as $round) {
    [$store, $dir] = harness_store();
    harness_workers($worker, $dir, 6, $round);
    $db = $store->transaction('workspace', fn($db) => $db);
    $ids = array_column($db['members'], 'id');
    sort($ids);
    check($ids === ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], "$round: every concurrent write is present (lost update): " . implode(',', $ids));
    check(!glob($dir . '/*.tmp') && count(glob($dir . '/*.enc')) === 1, "$round: no partial files are left");
    check(file_get_contents($dir . '/workspace.version') === "1\n", "$round: the marker is intact");
}
