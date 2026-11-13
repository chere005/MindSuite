<?php
/**
 * Plants the shared-store accounts the browser specs sign in with, the way the importer would have: through the site's
 * own library and config builder, so the store, key and relying party are exactly the ones /account/ and the API open.
 *
 *   SUITE_DATA_DIR=<scratch> SUITE_MINDSUITE_AUTH_TEST=1 CALMIND_SITE_LIB=<site>/lib php seed.php <user>:<password> ...
 */
$lib = rtrim((string) getenv('CALMIND_SITE_LIB'), '/');
if ($lib === '' || !is_file($lib . '/auth.php') || !getenv('SUITE_DATA_DIR') || getenv('SUITE_MINDSUITE_AUTH_TEST') !== '1') {
    fwrite(STDERR, "seed: needs CALMIND_SITE_LIB, SUITE_DATA_DIR and SUITE_MINDSUITE_AUTH_TEST=1\n");
    exit(2);
}
require $lib . '/auth.php';
$_SERVER['HTTP_HOST'] = '127.0.0.1';
$cfg = mss_config(app_config());
\MindSuite\Files\ensure_directory($cfg['data_dir']);
msa_lock($cfg, function () use ($cfg, $argv) {
    $db = ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []];
    foreach (array_slice($argv, 1) as $pair) {
        [$user, $password] = explode(':', $pair, 2);
        $db['accounts'][$user] = ['email' => $user . '@example.invalid', 'hash' => password_hash($password, PASSWORD_BCRYPT), 'created' => time()];
    }
    msa_store_write($cfg, $db);
});
echo "seeded\n";
