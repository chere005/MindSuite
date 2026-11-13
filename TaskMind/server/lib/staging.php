<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/limits.php';

/**
 * Test instance only. Its sandbox config has no team accounts, so it may read test-only bcrypt hashes for member ids from its own
 * data directory. The team gate is unchanged (a hash is an account, not a membership); production and dev never read the file.
 */
function staging_hashes(string $dir, string $instance): array {
    if ($instance !== '-test') { return []; }
    $raw = @file_get_contents($dir . '/staging-users.json');
    $rows = is_string($raw) ? json_decode($raw, true) : null;
    $out = [];
    foreach (is_array($rows) ? $rows : [] as $user => $hash) {
        if (is_string($user) && preg_match('/^' . MODEL['idPattern'] . '$/D', $user) === 1
            && is_string($hash) && preg_match('/^\$2y\$\d\d\$[.\/A-Za-z0-9]{53}$/D', $hash) === 1) { $out[$user] = $hash; }
    }
    return $out;
}
