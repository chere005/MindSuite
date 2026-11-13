<?php
declare(strict_types=1);
require __DIR__ . '/../lib/staging.php';
use function TaskMind\staging_hashes;

$dir = sys_get_temp_dir() . '/taskmind-staging-' . bin2hex(random_bytes(8));
function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
$good = password_hash('a staging secret', PASSWORD_BCRYPT, ['cost' => 4]);
mkdir($dir, 0700);
try {
    check(staging_hashes($dir, '-test') === [], 'a missing file yields no accounts');
    file_put_contents($dir . '/staging-users.json', json_encode(['alex' => $good, 'sam' => $good, 'outsider' => $good]));
    $rows = staging_hashes($dir, '-test');
    check(array_keys($rows) === ['alex', 'sam', 'outsider'] && password_verify('a staging secret', $rows['alex']), 'test reads every member-shaped id');
    file_put_contents($dir . '/staging-users.json', json_encode(['alex' => $good, '../escape' => $good, 'two words' => $good, str_repeat('x', 41) => $good]));
    check(array_keys(staging_hashes($dir, '-test')) === ['alex'], 'an id that is not a member id shape is ignored');
    foreach (['', '-dev'] as $instance) { check(staging_hashes($dir, $instance) === [], "instance '$instance' never reads the file"); }
    file_put_contents($dir . '/staging-users.json', json_encode(['alex' => 'plain-text', 'sam' => 42]));
    check(staging_hashes($dir, '-test') === [], 'anything but a bcrypt hash is ignored');
    file_put_contents($dir . '/staging-users.json', '{not json');
    check(staging_hashes($dir, '-test') === [], 'a damaged file yields no accounts');
    echo "Staging account checks passed.\n";
} finally {
    foreach (glob($dir . '/*') ?: [] as $file) { unlink($file); }
    if (is_dir($dir)) { rmdir($dir); }
}
