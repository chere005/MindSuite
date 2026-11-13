<?php
declare(strict_types=1);
// Shared by server/tools/test.php and every file in server/tools/cases/. Contract for case files:
// check(), refuses(), fails(). Everything else here is prefixed harness_ so a case file can define its own helpers.
// The harness already loads server/lib/planner.php: a case file must not require it again (functions would redeclare).
require_once __DIR__ . '/../lib/planner.php';
use PlanMind\RequestError;
use function PlanMind\fingerprint;
use function PlanMind\fresh_db;

/** The two accounts the cases are written for, as the server config would name them (fixture-people.php). A case that changes them puts these back. */
function harness_people(): array { static $people = null; return $people ??= require __DIR__ . '/fixture-people.php'; }
PlanMind\pm_people_use(harness_people());

function check(bool $ok, string $message): void { if (!$ok) { throw new RuntimeException($message); } }
/** The call must throw RequestError with this HTTP status and, when given, this error code. */
function refuses(callable $fn, int $status, ?string $code = null): void {
    try { $fn(); } catch (RequestError $e) {
        check($e->status === $status, "wrong status {$e->status} (wanted $status): {$e->getMessage()}");
        check($code === null || $e->errorCode === $code, "wrong code {$e->errorCode} (wanted $code): {$e->getMessage()}");
        return;
    }
    throw new RuntimeException('Request unexpectedly accepted');
}
/** The call must throw anything (a RequestError counts), and its message must contain $contains when given. */
function fails(callable $fn, ?string $contains = null): void {
    try { $fn(); } catch (Throwable $e) {
        check($contains === null || str_contains($e->getMessage(), $contains), "unexpected failure: {$e->getMessage()} (wanted '$contains')");
        return;
    }
    throw new RuntimeException('Operation unexpectedly accepted');
}

/** A fresh directory under the system temp dir, removed when the run ends. */
function harness_dir(): string {
    static $dirs = [];
    if (!$dirs) { register_shutdown_function(function () use (&$dirs) { foreach ($dirs as $dir) { harness_remove($dir); } }); }
    $dir = sys_get_temp_dir() . '/planmind-unit-' . bin2hex(random_bytes(8));
    mkdir($dir, 0700, true);
    return $dirs[] = $dir;
}
function harness_remove(string $path): void {
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) ?: [] as $name) { if ($name !== '.' && $name !== '..') { harness_remove($path . '/' . $name); } }
        rmdir($path);
    } elseif (file_exists($path) || is_link($path)) { unlink($path); }
}
function harness_store(): array {
    $dir = harness_dir();
    return [new PlanMind\Store($dir), $dir];
}

/**
 * Starts `$count` separate PHP processes at the same moment, each running `$code` with $argv = [lib dir, store dir, n (1 to
 * $count), $mode, gate file], and fails unless every one exits 0. The processes wait for a gate file, so they race for real.
 */
function harness_workers(string $code, string $dir, int $count, string $mode): void {
    // A child PHP needs the same extensions the runner has; php.mjs adds them with -d when php.ini does not.
    $flags = ['-d', 'display_errors=stderr'];
    foreach (['openssl', 'mbstring'] as $extension) {
        $bare = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, '-r', "echo extension_loaded('$extension') ? 'yes' : 'no';"])));
        if ($bare !== 'yes') { array_push($flags, '-d', "extension=$extension"); }
    }
    $gate = $dir . '/go';
    $children = [];
    // Each child knows the two people the parent runs with (harness_people()), before its own code loads the lib.
    $code = 'require_once $argv[1] . "/people.php"; PlanMind\\pm_people_use(' . var_export(PlanMind\pm_people_read(), true) . '); ' . $code;
    for ($n = 1; $n <= $count; ++$n) {
        $process = proc_open([PHP_BINARY, ...$flags, '-r', $code, '--', __DIR__ . '/../lib', $dir, (string)$n, $mode, $gate],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        check(is_resource($process), 'worker started');
        fclose($pipes[0]);
        $children[$n] = [$process, $pipes];
    }
    file_put_contents($gate, 'go');
    foreach ($children as $n => [$process, $pipes]) {
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]);
        check(proc_close($process) === 0, "worker $n ($mode) failed: $output");
    }
    unlink($gate);
}

/** Everything error_log has received since the last harness_log(true). The log stays out of the test output. */
function harness_log(bool $clear = false): string {
    static $file = null;
    if ($file === null) { $file = harness_dir() . '/php-errors.log'; ini_set('error_log', $file); ini_set('log_errors', '1'); }
    $text = is_file($file) ? (string)file_get_contents($file) : '';
    if ($clear && is_file($file)) { file_put_contents($file, ''); }
    return $text;
}
harness_log();

/** A distinct valid record id for any small number. */
function harness_id(int $n): string { return sprintf('%08x-0000-4000-8000-%012x', $n, $n); }
function harness_stamp(array $record, string $user = 'alex'): array {
    $now = '2026-10-30T12:00:00+00:00';
    return $record + ['revision' => 1, 'createdBy' => $user, 'updatedBy' => $user, 'createdAt' => $now, 'updatedAt' => $now, 'ak' => fingerprint($record)];
}
const HARNESS_CUSTOM = '7c7c7c7c-7c7c-47c7-87c7-7c7c7c7c7c7c';
/** A well-formed list id that exists in no harness db. */
const HARNESS_OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/**
 * A valid v2 store holding the custom list "Camping" (HARNESS_CUSTOM), a linked day to-do, a week to-do, a
 * linked priority on different lines, an event in the custom lane, one note and Alex's picker state.
 */
function harness_db(): array {
    $db = fresh_db();
    $db['revision'] = 7;
    $db['lists'][HARNESS_CUSTOM] = ['id' => HARNESS_CUSTOM, 'kind' => 'custom', 'name' => 'Camping', 'color' => 'blue', 'order' => 2, 'revision' => 1,
        'ak' => fingerprint(['kind' => 'list', 'name' => 'Camping']), 'createdBy' => 'alex', 'updatedAt' => '2026-10-30T12:00:00+00:00'];
    $db['tasks'][harness_id(1)] = harness_stamp(['id' => harness_id(1), 'scope' => 'day', 'date' => '2026-10-30', 'owners' => ['alex', 'sam'],
        'title' => 'Private shared task', 'done' => false, 'pos' => 1024]);
    $db['tasks'][harness_id(2)] = harness_stamp(['id' => harness_id(2), 'scope' => 'week', 'date' => '2026-10-26', 'owners' => ['alex'],
        'title' => 'Week task', 'done' => true, 'pos' => 1024]);
    $db['priorities'][harness_id(3)] = harness_stamp(['id' => harness_id(3), 'date' => '2026-10-30', 'owners' => ['alex', 'sam'],
        'slots' => ['sam' => 2, 'alex' => 4], 'text' => 'Family dinner']);
    $db['events'][harness_id(4)] = harness_stamp(['id' => harness_id(4), 'date' => '2026-10-30', 'owners' => [HARNESS_CUSTOM],
        'text' => 'Pack the tent', 'start' => 720, 'length' => 45]);
    $db['notes']['week:2026-10-26:alex:priorities'] = ['key' => 'week:2026-10-26:alex:priorities', 'scope' => 'week', 'period' => '2026-10-26',
        'listId' => 'alex', 'field' => 'priorities', 'text' => 'Renew passport', 'revision' => 2, 'updatedBy' => 'sam', 'updatedAt' => '2026-10-30T12:00:00+00:00'];
    $db['prefs']['alex'] = ['selection' => ['base' => 'both', 'overlays' => [HARNESS_CUSTOM]]];
    return $db;
}
