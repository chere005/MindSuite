<?php
declare(strict_types=1);
require __DIR__ . '/../lib/atomic.php';
use function MindSuite\Files\atomic_write;
use function MindSuite\Files\with_file_lock;

$dir = sys_get_temp_dir() . '/mind-atomic-' . bin2hex(random_bytes(8));
function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
try {
    atomic_write($dir . '/data', 'first');
    atomic_write($dir . '/data', 'second');
    check(file_get_contents($dir . '/data') === 'second', 'complete replacement');
    check(with_file_lock($dir . '/lock', fn() => 42) === 42, 'callback result');
    try { with_file_lock($dir . '/lock', fn() => throw new RuntimeException('callback')); } catch (RuntimeException $e) { check($e->getMessage() === 'callback', 'exception preserved'); }
    check(with_file_lock($dir . '/lock', fn() => true), 'lock released after exception');
    foreach ([fn() => atomic_write($dir . '/data/child', 'bad'), fn() => with_file_lock($dir . '/data/lock', fn() => null)] as $fail) {
        $threw = false; try { $fail(); } catch (RuntimeException) { $threw = true; }
        check($threw, 'unwritable storage fails closed');
    }
    check(file_get_contents($dir . '/data') === 'second', 'last good data preserved');
    check(glob($dir . '/*.tmp') === [], 'no partial files');
    echo "Atomic storage checks passed.\n";
} finally {
    foreach (glob($dir . '/*') ?: [] as $file) { unlink($file); }
    if (is_dir($dir)) { rmdir($dir); }
}
