<?php
declare(strict_types=1);
namespace PlanMind;
require_once __DIR__ . '/people.php';

/**
 * Test instance only. Its sandbox config has no household accounts, so it may read test-only bcrypt hashes for the two
 * people its config names (`people`, people.php) from its own data directory. The allow-list is unchanged; production and dev never
 * read the file. A config that does not name the two people allows nobody from it (and the planner answers 503 anyway).
 */
function staging_hashes(string $dir, string $instance): array {
    if ($instance !== '-test') { return []; }
    $raw = @file_get_contents($dir . '/staging-users.json');
    $rows = is_string($raw) ? json_decode($raw, true) : null;
    $out = [];
    $people = pm_people_read();
    $allowed = $people === null ? [] : array_values($people);
    foreach (is_array($rows) ? $rows : [] as $user => $hash) {
        if (in_array($user, $allowed, true) && is_string($hash) && preg_match('/^\$2y\$\d\d\$[.\/A-Za-z0-9]{53}$/D', $hash) === 1) { $out[$user] = $hash; }
    }
    return $out;
}
