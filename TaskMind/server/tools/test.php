<?php
declare(strict_types=1);
// Runs every file in server/tools/cases/ (sorted by name). A case file either runs its checks at the top level
// or returns a callable that does. One failing file does not hide the others; the exit status says if any failed.
// Focus on one area: php tools/php.mjs server/tools/test.php store   (substring of the file name)
require __DIR__ . '/harness.php';
$filter = $argv[1] ?? '';
$files = array_values(array_filter(glob(__DIR__ . '/cases/*.php') ?: [], fn($f) => $filter === '' || str_contains(basename($f), $filter)));
sort($files);
if (!$files) { fwrite(STDERR, "No server case files match '$filter'.\n"); exit(1); }
$failed = 0;
foreach ($files as $file) {
    $name = basename($file, '.php');
    try {
        $result = (static fn(string $path) => require $path)($file);
        if (is_callable($result)) { $result(); }
        echo "ok   $name\n";
    } catch (Throwable $e) {
        ++$failed;
        echo "FAIL $name: {$e->getMessage()}\n     at {$e->getFile()}:{$e->getLine()}\n";
    }
}
if ($failed) { echo "$failed of " . count($files) . " server case files failed.\n"; exit(1); }
echo "TaskMind server checks passed (" . count($files) . " case files).\n";
