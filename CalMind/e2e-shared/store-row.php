<?php
/**
 * What the shared store holds for one bearer token: its scope and user, as JSON (or {} when there is no such session).
 * Never prints a secret: the token is only hashed to find its row.
 *
 *   SUITE_DATA_DIR=<scratch> SUITE_MINDSUITE_AUTH_TEST=1 CALMIND_SITE_LIB=<site>/lib php store-row.php <token>
 */
$lib = rtrim((string) getenv('CALMIND_SITE_LIB'), '/');
require $lib . '/auth.php';
$_SERVER['HTTP_HOST'] = '127.0.0.1';
$cfg = mss_config(app_config());
$row = msa_store_read($cfg)['sessions'][hash('sha256', (string) ($argv[1] ?? ''))] ?? null;
echo json_encode($row === null ? new stdClass() : ['scope' => (string) ($row['scope'] ?? ''), 'user' => (string) $row['user']]), "\n";
