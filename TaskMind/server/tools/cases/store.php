<?php
declare(strict_types=1);
// The encrypted store: round trips, fails closed on anything it cannot authenticate, the plaintext version marker, and the
// backup of the old file that a version bump keeps exactly once.
use TaskMind\Store;

// ---- 1. A round trip, a file nobody else can read, and a store that is not there yet reading as empty ----
[$store, $dir] = harness_store();
check($store->transaction('workspace', fn($db) => $db) === [], 'a missing file reads as empty');
check(!file_exists($dir . '/workspace.enc') && !file_exists($dir . '/.key'), 'a read writes nothing');
$doc = harness_workspace(harness_member('alex', 'owner', 'Alex ☃'));
check($store->transaction('workspace', fn($db) => $doc) === $doc, 'a transaction returns what it stored');
check($store->transaction('workspace', fn($db) => $db) === $doc, 'and a later read gives it back, unicode included');
check(str_starts_with((string)file_get_contents($dir . '/workspace.enc'), 'TM1:'), 'the file carries the format tag');
check(!str_contains((string)file_get_contents($dir . '/workspace.enc'), 'alex'), 'and no plaintext');
foreach (['workspace.enc', '.key'] as $name) { check((fileperms($dir . '/' . $name) & 0777) === 0600, "$name is private to its owner"); }
check(!glob($dir . '/*.tmp'), 'no partial files are left');
fails(fn() => $store->transaction('tasks', fn($db) => $db), 'Unknown store');

// ---- 2. It fails closed ----
$file = $dir . '/workspace.enc';
$good = (string)file_get_contents($file);
foreach (['junk' => 'not a store', 'bad base64' => 'TM1:%%%%', 'short' => 'TM1:' . base64_encode('tiny')] as $what => $bytes) {
    file_put_contents($file, $bytes);
    fails(fn() => $store->transaction('workspace', fn($db) => $db));
}
$raw = base64_decode(substr($good, 4));
$flipped = $raw; $flipped[strlen($flipped) - 1] = chr(ord($flipped[strlen($flipped) - 1]) ^ 1);
file_put_contents($file, 'TM1:' . base64_encode($flipped));
fails(fn() => $store->transaction('workspace', fn($db) => $db), 'authentication failed');
// One file's bytes are not accepted as another's: the store name is part of what is authenticated.
file_put_contents($file, $good);
$store->transaction('attempts', fn($db) => ['x' => 1]);
copy($dir . '/attempts.enc', $file);
fails(fn() => $store->transaction('workspace', fn($db) => $db), 'authentication failed');
file_put_contents($file, $good);
check($store->transaction('workspace', fn($db) => $db) === $doc, 'putting the good bytes back reads them again');
// A lost key never makes a new one for ciphertext that exists.
unlink($dir . '/.key');
fails(fn() => $store->transaction('workspace', fn($db) => $db), 'Storage key missing');
check(!file_exists($dir . '/.key'), 'and generates no replacement');
// A failed write leaves the last good file.
[$store, $dir] = harness_store();
$store->transaction('workspace', fn($db) => $doc);
$before = file_get_contents($dir . '/workspace.enc');
fails(fn() => $store->transaction('workspace', fn($db) => throw new RuntimeException('boom')), 'boom');
check(file_get_contents($dir . '/workspace.enc') === $before, 'a failed change leaves the last good data');
$huge = ['v' => 1, 'members' => [], 'blob' => str_repeat('x', TaskMind\LIMITS['workspaceBytesMax'])];
refuses(fn() => $store->transaction('workspace', fn($db) => $huge), 409, 'store_full');
check(file_get_contents($dir . '/workspace.enc') === $before, 'a workspace over its cap is refused and nothing is written');

// ---- 3. The version marker ----
[$store, $dir] = harness_store();
$store->transaction('workspace', fn($db) => $doc);
check(file_get_contents($dir . '/workspace.version') === "1\n", 'the marker names the version the file holds');
check((fileperms($dir . '/workspace.version') & 0777) === 0640, 'and is readable by the group (the deploy user), unlike the data');
$store->transaction('attempts', fn($db) => ['x' => 1]);
check(!file_exists($dir . '/attempts.version'), 'only the workspace has a marker');
$store->transaction('workspace', fn($db) => $doc + ['note' => 'same version']);
check(!glob($dir . '/*.bak'), 'a write at the same version keeps no backup');

// ---- 4. A version bump keeps the old file once ----
$old = (string)file_get_contents($dir . '/workspace.enc');
$next = $doc; $next['v'] = 2;
$store->transaction('workspace', fn($db) => $next);
check(file_get_contents($dir . '/workspace.v1.enc.bak') === $old, 'the old file is kept byte for byte');
check(file_get_contents($dir . '/workspace.version') === "2\n", 'the marker follows the bump');
$kept = (string)file_get_contents($dir . '/workspace.v1.enc.bak');
$store->transaction('workspace', fn($db) => $next + ['n' => 1]);
check(file_get_contents($dir . '/workspace.v1.enc.bak') === $kept, 'a later write at the new version does not touch the backup');
// Putting the backup back undoes the conversion for a store of the old version.
[$store, $dir] = harness_store();
$store->transaction('workspace', fn($db) => $doc);
$was = (string)file_get_contents($dir . '/workspace.enc');
file_put_contents($dir . '/workspace.v1.enc.bak', 'something else entirely');
fails(fn() => $store->transaction('workspace', fn($db) => $next), 'already exists and is not the old store');
check(file_get_contents($dir . '/workspace.enc') === $was, 'a different backup refuses the write and the file is untouched');
file_put_contents($dir . '/workspace.v1.enc.bak', $was);
$store->transaction('workspace', fn($db) => $next);
check(file_get_contents($dir . '/workspace.v1.enc.bak') === $was, 'the very same file already backed up is accepted');
