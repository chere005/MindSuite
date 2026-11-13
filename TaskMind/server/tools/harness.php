<?php
declare(strict_types=1);
// Shared by server/tools/test.php and every file in server/tools/cases/. Contract for case files:
// check(), refuses(), fails(). Everything else here is prefixed harness_ so a case file can define its own helpers.
// The harness already loads server/lib/taskmind.php: a case file must not require it again (functions would redeclare).
require_once __DIR__ . '/../lib/taskmind.php';
use TaskMind\RequestError;

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
    $dir = sys_get_temp_dir() . '/taskmind-unit-' . bin2hex(random_bytes(8));
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
    return [new TaskMind\Store($dir), $dir];
}

/** A stored member row. */
function harness_member(string $id, string $role, string $name = ''): array {
    return ['id' => $id, 'role' => $role, 'added' => 0, 'by' => '', 'name' => $name];
}
/** A workspace of the current version holding exactly these members. */
function harness_workspace(array ...$members): array { return ['v' => TaskMind\MODEL['storeVersion'], 'members' => $members]; }

/**
 * Starts `$count` separate PHP processes at the same moment, each running `$code` with $argv = [lib dir, store dir, n (1 to
 * $count), $mode, gate file], and fails unless every one exits 0. The processes wait for a gate file, so they race for real.
 */
function harness_workers(string $code, string $dir, int $count, string $mode): void {
    $flags = harness_php_flags();
    $gate = $dir . '/go';
    $children = [];
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

/** The flags a child PHP needs: the same extensions the runner has (php.mjs adds them with -d when php.ini does not). */
function harness_php_flags(): array {
    $flags = ['-d', 'display_errors=stderr'];
    foreach (['openssl', 'mbstring'] as $extension) {
        $bare = (string)shell_exec(implode(' ', array_map('escapeshellarg', [PHP_BINARY, '-r', "echo extension_loaded('$extension') ? 'yes' : 'no';"])));
        if ($bare !== 'yes') { array_push($flags, '-d', "extension=$extension"); }
    }
    return $flags;
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
