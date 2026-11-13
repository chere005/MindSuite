<?php
/**
 * Shared harness for the mail tests: a tiny test registry plus a disposable fake
 * SMTP server (tools/fake-smtp.php, next to this file) on a free 127.0.0.1 port
 * with a throwaway certificate. No real mail server, ever. Required by
 * mail-test.php (the transport) and by an app's own tests of what it sends.
 * It does not load lib/mail.php; the file that requires it does.
 *
 * Call mt_run() last: it prints one line per test and exits non-zero on a failure.
 * MAIL_TEST_ONLY=text runs only the tests whose name holds that text.
 */

$AREAS = []; $CUR = 'mail';
function area(string $n): void { global $CUR; $CUR = $n; }
function t(string $label, callable $fn): void { global $AREAS; $AREAS[] = [$label, $fn]; }
function ok($c, string $why = ''): void { if (!$c) { throw new RuntimeException($why !== '' ? $why : 'expected true'); } }
function eq($want, $got, string $why = ''): void
{
    if ($want !== $got) { throw new RuntimeException(($why !== '' ? $why . ': ' : '') . 'expected ' . json_encode($want) . ', got ' . json_encode($got)); }
}
function has(string $n, string $h, string $why = ''): void { if (strpos($h, $n) === false) { throw new RuntimeException(($why !== '' ? $why . ': ' : '') . 'missing ' . json_encode($n)); } }
function hasnt(string $n, string $h, string $why = ''): void { if (strpos($h, $n) !== false) { throw new RuntimeException(($why !== '' ? $why . ': ' : '') . 'unexpectedly present ' . json_encode($n)); } }


area('mail');

/** A scratch dir, a self-signed cert for $cn (SAN to match), and its paths. */
function mt_cert(string $dir, string $cn): array
{
    $conf = "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=$cn\n[v3]\nsubjectAltName=DNS:$cn\n";
    file_put_contents("$dir/$cn.cnf", $conf);
    $cmd = 'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config ' . escapeshellarg("$dir/$cn.cnf")
         . ' -keyout ' . escapeshellarg("$dir/$cn.key") . ' -out ' . escapeshellarg("$dir/$cn.crt") . ' 2>&1';
    exec($cmd, $o, $rc);
    if ($rc !== 0) { throw new RuntimeException('openssl failed: ' . implode(' ', $o)); }
    file_put_contents("$dir/$cn.pem", file_get_contents("$dir/$cn.crt") . file_get_contents("$dir/$cn.key"));
    return ['pem' => "$dir/$cn.pem", 'ca' => "$dir/$cn.crt"];
}

/** Run $fn($cfg, $dir) against a fake server in $mode/$tls; the server is always stopped. */
function mt_with(string $mode, string $tls, callable $fn, string $certcn = 'localhost'): void
{
    $dir = sys_get_temp_dir() . '/mailtest-' . getmypid() . '-' . bin2hex(random_bytes(3));
    mkdir($dir, 0700, true);
    $c = mt_cert($dir, $certcn);
    $env = array_merge(getenv(), ['FAKE_SMTP_PASS' => 'hunter2-secret']);
    $p = proc_open([PHP_BINARY, __DIR__ . '/fake-smtp.php', $dir, $mode, $tls, $c['pem']],
                   [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', "$dir/server.err", 'w']], $pipes, null, $env);
    try {
        for ($i = 0; $i < 100 && !is_file("$dir/port"); $i++) { usleep(50000); }
        ok(is_file("$dir/port"), 'fake smtp server did not start');
        $cfg = ['data_dir' => $dir, 'mail_enabled' => true, 'smtp_host' => 'localhost',
                'smtp_port' => (int) file_get_contents("$dir/port"), 'smtp_user' => 'mailer@seancheren.com',
                'smtp_pass' => 'hunter2-secret', 'mail_from' => 'no-reply@seancheren.com',
                'mail_from_name' => 'seancheren.com', 'smtp_cafile' => $c['ca'], 'smtp_timeout' => 2];
        $fn($cfg, $dir);
    } finally {
        proc_terminate($p);
        proc_close($p);
        exec('rm -rf ' . escapeshellarg($dir));
    }
}

function mt_session(string $dir, int $n = 1): string { return (string) @file_get_contents("$dir/session.$n"); }
function mt_log(string $dir): string { return (string) @file_get_contents("$dir/mail.log"); }


/** Run every registered test, print the tally, exit 1 if any failed. */
function mt_run(): void
{
    global $AREAS;
    $pass = $fail = 0;
    $only = (string) getenv('MAIL_TEST_ONLY');           // run just the tests whose name holds this text (spot checks, mutation runs)
    foreach ($AREAS as [$label, $fn]) {
        if ($only !== '' && strpos($label, $only) === false) { continue; }
        try { $fn(); $pass++; echo "  ok   $label\n"; }
        catch (Throwable $e) { $fail++; echo "  FAIL $label\n       " . $e->getMessage() . "\n"; }
    }
    echo "\n$pass passed, $fail failed\n";
    exit($fail ? 1 : 0);
}
