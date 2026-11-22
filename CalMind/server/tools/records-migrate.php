<?php
/**
 * Copy every JSON records store of an instance into the database driver, and prove each copy.
 *
 *   php server/tools/records-migrate.php --data-dir <dir> [--dsn <pdo dsn>] [--db-user U] [--db-pass-env VAR] [--apply]
 *
 * Without --apply it only reads: it lists every store it found, the space and owner it maps to, the record counts, and
 * any file it refuses to map. With --apply it writes each store into the database (refusing a store that already holds
 * rows there), then reads both back and compares them byte for byte; any difference stops the run with a non-zero exit.
 * The JSON files are never modified or removed — switching an instance over (config `storage` => 'sql') is a separate,
 * deliberate step, and the files stay as the fallback (docs/PUBLIC-MODEL.md, "Switching over").
 *
 * The database password is read from the environment variable --db-pass-env names, never from the command line.
 * The data key comes from the instance's config.php when it sets one, else the data dir's .datakey (store.php).
 */

$root = dirname(__DIR__);
require_once $root . '/lib/records.php';
if (!defined('SYNC_SPACES')) {
    // app.php's list of spaces, read rather than repeated, so a new space cannot be missed here.
    preg_match("/const SYNC_SPACES\s*=\s*\[([^\]]*)\]/", (string) file_get_contents($root . '/lib/app.php'), $m);
    define('SYNC_SPACES', array_map(fn($s) => trim($s, " '\""), array_filter(explode(',', $m[1] ?? ''))));
}

$opt = getopt('', ['data-dir:', 'dsn:', 'db-user:', 'db-pass-env:', 'apply', 'config:']);
$dir = rtrim((string) ($opt['data-dir'] ?? ''), '/');
if ($dir === '' || !is_dir($dir)) { fwrite(STDERR, "usage: --data-dir <instance data dir> [--dsn …] [--apply]\n"); exit(64); }
$base = isset($opt['config']) ? (array) require $opt['config'] : [];
$json = ['data_dir' => $dir, 'storage' => 'json'] + $base;
$sql  = ['storage' => 'sql', 'data_dir' => $dir] + $base;
if (isset($opt['dsn'])) { $sql['storage_dsn'] = (string) $opt['dsn']; }
if (isset($opt['db-user'])) { $sql['storage_user'] = (string) $opt['db-user']; }
if (isset($opt['db-pass-env'])) { $sql['storage_pass'] = (string) getenv((string) $opt['db-pass-env']); }
$apply = isset($opt['apply']);

/**
 * File name → [space, owner]. `records-<x>.json` is CalMind's store of x, and `records-<space>-<y>.json` is y's store
 * in that space — except that a CalMind name may itself begin `<space>-`, and then the one file is both. That collision
 * is real in the JSON layout (the database keys space and owner apart); the tool refuses such a file rather than guess.
 */
function map_store(string $file, array $accounts): array
{
    $stem = substr(basename($file, '.json'), strlen('records-'));
    foreach (SYNC_SPACES as $space) {
        if (str_starts_with($stem, $space . '-')) {
            $owner = substr($stem, strlen($space) + 1);
            if (isset($accounts[$stem])) { return ['error' => "ambiguous: CalMind account '$stem' and $space space of '$owner'"]; }
            return ['space' => $space, 'owner' => $owner];
        }
    }
    return ['space' => '', 'owner' => $stem];
}

// The legacy account list is the only one this tool can see; a shared-sign-in instance's accounts live in the site store.
$accounts = is_file($dir . '/accounts.json') ? store_read($json, $dir . '/accounts.json') : [];
$files = glob($dir . '/records-*.json') ?: [];
$moved = 0; $bad = 0;
echo ($apply ? 'APPLY' : 'DRY RUN') . ': ' . count($files) . " store file(s) in $dir\n";
foreach ($files as $file) {
    $m = map_store($file, $accounts);
    if (isset($m['error'])) { $bad++; echo "  REFUSED  " . basename($file) . " — {$m['error']}\n"; continue; }
    $space = $m['space'];
    $owner = $m['owner'];
    $db = rs_export($json, $owner, $space);
    $label = sprintf('%-28s → space %-6s owner %-20s %5d records, seq %d', basename($file), $space === '' ? "''" : $space,
        $owner, count($db['recs'] ?? []), (int) ($db['seq'] ?? 0));
    if (!$apply) { echo "  $label\n"; continue; }
    if (rs_export($sql, $owner, $space) !== null) { $bad++; echo "  REFUSED  $label — the database already holds this store\n"; continue; }
    rs_import($sql, $owner, $space, $db);
    if (json_encode(rs_export($sql, $owner, $space)) !== json_encode($db)) { $bad++; echo "  MISMATCH $label\n"; continue; }
    $moved++;
    echo "  copied   $label\n";
}
echo $apply ? "$moved copied and verified, $bad refused or mismatched\n" : "$bad file(s) would be refused\n";
exit($bad === 0 ? 0 : 1);
