<?php
/**
 * Abuse limits on the two mail-sending endpoints (recover, meetreq_mail) and the public meetreq_create, end to end,
 * including the address-independent caps (cap_take) that hold when the client picks its own address:
 * a real `php -S` on a COPY of lib/ and public/ with a generated config (mail on, smtp_host =
 * the local fake SMTP server, tools/fake-smtp.php) so nothing here can touch a real mail server.
 *
 *   php server/tools/abuse-test.php
 */
require_once dirname(__DIR__) . '/lib/store.php';

date_default_timezone_set('America/Chicago');
$ROOT = dirname(__DIR__);
$TESTS = []; $SERVERS = [];
function t(string $label, callable $fn): void { global $TESTS; $TESTS[] = [$label, $fn]; }
function ok($c, string $why = ''): void { if (!$c) { throw new RuntimeException($why !== '' ? $why : 'expected true'); } }
function eq($want, $got, string $why = ''): void
{
    if ($want !== $got) { throw new RuntimeException(($why !== '' ? $why . ': ' : '') . 'expected ' . json_encode($want) . ', got ' . json_encode($got)); }
}

/** A free loopback port in 18800-18860, at most one pass over the range; throws rather than spinning. */
function free_port(): int
{
    static $used = [];
    for ($p = 18800; $p <= 18860; $p++) {
        if (isset($used[$p])) { continue; }
        $s = @stream_socket_server("tcp://127.0.0.1:$p");
        if ($s) { fclose($s); $used[$p] = true; return $p; }
    }
    throw new RuntimeException('no free port in 18800-18860');
}

/** Start argv as the leader of its OWN process group (so one kill takes its workers and detached children too). */
function spawn_group(array $argv, array $fds, &$pipes, $cwd, array $env)
{
    return proc_open(array_merge(['perl', '-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV'], $argv), $fds, $pipes, $cwd, $env);
}

/** Fake SMTP + a copy of the app on its own data dir. $mode: ok|hang|off (off = mail_enabled false). */
function start(string $mode, array $env = [], string $web_kind = 'builtin', array $opts = []): array
{
    global $ROOT, $SERVERS;
    $dir = sys_get_temp_dir() . '/abusetest-' . getmypid() . '-' . bin2hex(random_bytes(3));
    mkdir("$dir/data", 0700, true);
    mkdir("$dir/smtp", 0700, true);
    exec('cp -R ' . escapeshellarg("$ROOT/lib") . ' ' . escapeshellarg("$dir/lib") . ' && cp -R ' . escapeshellarg("$ROOT/public") . ' ' . escapeshellarg("$dir/public"));
    @unlink("$dir/lib/config.php");
    // Stands in for NearlyFreeSpeech, where REMOTE_ADDR is whatever address the client wrote at the right-hand end of
    // its X-Forwarded-For: a request that sends X-Test-Addr (call()'s $ip) is served as if it came from that address.
    file_put_contents("$dir/prepend.php", "<?php if (isset(\$_SERVER['HTTP_X_TEST_ADDR'])) { \$_SERVER['REMOTE_ADDR'] = (string) \$_SERVER['HTTP_X_TEST_ADDR']; }\n");
    // Throwaway certificate for the fake server; the config trusts exactly that file.
    file_put_contents("$dir/smtp/c.cnf", "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\n");
    exec('openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config ' . escapeshellarg("$dir/smtp/c.cnf") . ' -keyout ' . escapeshellarg("$dir/smtp/c.key") . ' -out ' . escapeshellarg("$dir/smtp/c.crt") . ' 2>&1', $o, $rc);
    ok($rc === 0, 'openssl failed');
    file_put_contents("$dir/smtp/c.pem", file_get_contents("$dir/smtp/c.crt") . file_get_contents("$dir/smtp/c.key"));
    $SERVERS[] = ['dir' => $dir, 'procs' => []];
    $slot = array_key_last($SERVERS);
    $smtp = spawn_group([PHP_BINARY, "$ROOT/tools/fake-smtp.php", "$dir/smtp", $mode === 'hang' ? 'hang' : 'ok', 'starttls', "$dir/smtp/c.pem"],
        [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', "$dir/smtp.err", 'w']], $p1,
        null, array_merge(getenv(), ['FAKE_SMTP_PASS' => 'pw']));
    for ($i = 0; $i < 100 && !is_file("$dir/smtp/port"); $i++) { usleep(50000); }
    ok(is_file("$dir/smtp/port"), 'fake smtp did not start');
    $cfg = ['data_dir' => "$dir/data", 'mail_enabled' => $mode !== 'off', 'smtp_host' => 'localhost',
            'smtp_port' => (int) file_get_contents("$dir/smtp/port"), 'smtp_user' => 'mailer@example.com', 'smtp_pass' => 'pw',
            'mail_from' => 'no-reply@example.com', 'smtp_cafile' => "$dir/smtp/c.crt", 'smtp_timeout' => 2];
    $cfg = array_merge($cfg, $opts['cfg'] ?? []);
    $webBin = $opts['bin'] ?? PHP_BINARY;
    file_put_contents("$dir/lib/config.php", '<?php return ' . var_export($cfg, true) . ';');
    $port = free_port();
    if ($web_kind === 'apache') {
        // The host's model: Apache + mod_cgi + php-cgi (no fastcgi_finish_request, no early release of the client).
        $cgi = trim((string) shell_exec('command -v php-cgi'));
        $mods = '/usr/libexec/apache2';
        ok($cgi !== '' && is_dir($mods), 'apache + php-cgi needed for the CGI test');
        mkdir("$dir/cgi-bin", 0755, true); mkdir("$dir/run", 0755, true);
        file_put_contents("$dir/cgi-bin/php", "#!/bin/sh\nexec " . escapeshellarg($cgi) . " -d cgi.force_redirect=0 -d display_errors=1 \"\$@\"\n");
        chmod("$dir/cgi-bin/php", 0755);
        $conf = "ServerRoot \"$dir/run\"\nListen 127.0.0.1:$port\nServerName localhost\nPidFile \"$dir/run/httpd.pid\"\n"
              . "ErrorLog \"$dir/web.log\"\nLogLevel warn\nDocumentRoot \"$dir/public\"\n"
              . "StartServers 4\nMinSpareServers 4\nMaxSpareServers 8\nMaxRequestWorkers 12\n";
        foreach (['mpm_prefork', 'authz_core', 'unixd', 'alias', 'mime', 'actions', 'cgi', 'dir', 'env', 'log_config'] as $m) {
            $conf .= "LoadModule {$m}_module $mods/mod_$m.so\n";
        }
        $conf .= "ScriptAlias /cgi-bin/ \"$dir/cgi-bin/\"\n<Directory \"$dir/cgi-bin\">\nRequire all granted\nOptions +ExecCGI\n</Directory>\n"
               . "<Directory \"$dir/public\">\nRequire all granted\nAllowOverride None\nAddHandler application/x-php .php\nAction application/x-php /cgi-bin/php\nCGIPassAuth On\n</Directory>\n";
        file_put_contents("$dir/httpd.conf", $conf);
        // Own session: Apache's shutdown signals its whole process group, which would otherwise be this runner.
        $web = spawn_group(['/usr/sbin/httpd', '-D', 'FOREGROUND', '-f', "$dir/httpd.conf"],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', "$dir/web.err", 'w']], $p2, null,
            array_merge(getenv(), $env, ['CALMIND_MEETREQ_USER' => 'alex']));
    } else {
    $web = spawn_group([$webBin, '-d', 'display_errors=1', '-d', 'error_reporting=E_ALL', '-d', "auto_prepend_file=$dir/prepend.php", '-S', "127.0.0.1:$port", '-t', "$dir/public"],
        [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', "$dir/web.log", 'w']], $p2, null,
        array_merge(getenv(), $env, ['PHP_CLI_SERVER_WORKERS' => '4', 'CALMIND_MEETREQ_USER' => 'alex']));
    }
    for ($i = 0; $i < 100; $i++) {
        $c = @fsockopen('127.0.0.1', $port, $x, $y, 0.2);
        if ($c) { fclose($c); break; }
        usleep(100000);
    }
    $srv = ['dir' => $dir, 'data' => "$dir/data", 'smtp' => "$dir/smtp", 'port' => $port, 'cfg' => $cfg, 'procs' => [$smtp, $web]];
    $SERVERS[$slot] = $srv;
    return $srv;
}

function stop_all(): void
{
    global $SERVERS;
    foreach ($SERVERS as $s) {
        if (is_file($s['dir'] . '/run/httpd.pid')) { exec('kill ' . (int) file_get_contents($s['dir'] . '/run/httpd.pid') . ' 2>/dev/null'); usleep(300000); }
        // Every process was started as its own group leader: kill the whole group (php -S workers, detached mail workers).
        foreach ($s['procs'] as $p) {
            if (!is_resource($p)) { continue; }
            $pid = (int) (proc_get_status($p)['pid'] ?? 0);
            if ($pid > 1) { exec('kill -9 -- -' . $pid . ' 2>/dev/null'); exec('kill -9 ' . $pid . ' 2>/dev/null'); }
            proc_close($p);
        }
        if (getenv('ABUSE_KEEP') !== '1') { exec('rm -rf ' . escapeshellarg($s['dir'])); }
    }
    $SERVERS = [];
}
register_shutdown_function('stop_all');
if (function_exists('pcntl_async_signals')) {
    pcntl_async_signals(true);
    foreach ([SIGINT, SIGTERM, SIGHUP] as $sig) { pcntl_signal($sig, function () { stop_all(); exit(130); }); }
}

/** POST to the app over a raw socket: returns status, raw headers, body, and the time until the body was complete. */
function call(array $s, array $body, string $token = '', string $ip = ''): array
{
    $json = json_encode($body);
    $req = "POST /api/index.php HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: " . strlen($json) . "\r\nConnection: close\r\n"
         . ($token !== '' ? "Authorization: Bearer $token\r\n" : '') . ($ip !== '' ? "X-Test-Addr: $ip\r\n" : '') . "\r\n" . $json;
    $t0 = microtime(true);
    $c = stream_socket_client('tcp://127.0.0.1:' . $s['port'], $en, $es, 5);
    fwrite($c, $req);
    stream_set_timeout($c, 20);
    $buf = '';
    $len = null; $hdrEnd = null;
    while (!feof($c)) {
        $chunk = fread($c, 8192);
        if ($chunk === '' || $chunk === false) { break; }
        $buf .= $chunk;
        if ($hdrEnd === null && ($i = strpos($buf, "\r\n\r\n")) !== false) {
            $hdrEnd = $i + 4;
            preg_match('/^Content-Length: (\d+)/mi', substr($buf, 0, $i), $m);
            $len = isset($m[1]) ? (int) $m[1] : null;
        }
        // Done when the declared body is in: the client does NOT wait for the connection to close.
        if ($hdrEnd !== null && $len !== null && strlen($buf) - $hdrEnd >= $len) { break; }
        if ($hdrEnd !== null && $len === null && preg_match('/^Transfer-Encoding:\s*chunked/mi', substr($buf, 0, $hdrEnd)) && str_ends_with($buf, "0\r\n\r\n")) { break; }
    }
    $dt = microtime(true) - $t0;
    fclose($c);
    preg_match('#^HTTP/\S+ (\d{3})#', $buf, $m);
    $head = substr($buf, 0, $hdrEnd ?? 0);
    $raw = substr($buf, $hdrEnd ?? 0);
    if ($len === null && preg_match('/^Transfer-Encoding:\s*chunked/mi', $head)) {   // Apache/CGI: no Content-Length
        $dec = ''; $rest = $raw;
        while (preg_match('/^([0-9a-f]+)\r\n/i', $rest, $cm) && ($n = hexdec($cm[1])) > 0) { $dec .= substr($rest, strlen($cm[0]), $n); $rest = substr($rest, strlen($cm[0]) + $n + 2); }
        $raw = $dec;
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) { throw new RuntimeException("non-JSON reply ({$m[1]}): " . substr($raw, 0, 200)); }
    $head = preg_replace('/^(Date|X-Powered-By):.*\r\n/mi', '', $head);
    return ['status' => (int) $m[1], 'body' => $data, 'raw' => $raw, 'head' => $head, 'secs' => $dt];
}

function signup(array $s, string $u, string $email): string
{
    $r = call($s, ['action' => 'signup', 'username' => $u, 'email' => $email, 'password' => 'passw0rd-' . $u]);
    eq(200, $r['status'], "signup $u");
    return (string) $r['body']['token'];
}
function login(array $s, string $u): string { return (string) call($s, ['action' => 'login', 'username' => $u, 'password' => 'passw0rd-' . $u])['body']['token']; }

function sessions(array $s): array
{
    $out = [];
    foreach (glob($s['smtp'] . '/session.*') ?: [] as $f) { $out[] = (string) file_get_contents($f); }
    return $out;
}
function wait_to(array $s, string $to, int $n, float $secs = 6.0): int
{
    $end = microtime(true) + $secs;
    do { $c = delivered($s)[$to] ?? 0; if ($c >= $n) { return $c; } usleep(50000); } while (microtime(true) < $end);
    return $c;
}
function wait_sessions(array $s, int $n, float $secs = 6.0): int
{
    $end = microtime(true) + $secs;
    while (microtime(true) < $end) {
        $c = 0;
        foreach (sessions($s) as $x) { if (str_contains($x, '<<END>>')) { $c++; } }
        if ($c >= $n) { return $c; }
        usleep(50000);
    }
    return $c;
}
/** Messages actually handed to the SMTP server, as recipient => count. */
function delivered(array $s): array
{
    $to = [];
    foreach (sessions($s) as $x) {
        if (preg_match('/RCPT TO:<([^>]+)>/', $x, $m) && str_contains($x, '<<END>>')) { $k = strtolower($m[1]); $to[$k] = ($to[$k] ?? 0) + 1; }
    }
    return $to;
}
function code_from(array $s, string $to): ?string
{
    $found = null;
    foreach (sessions($s) as $x) {
        if (str_contains($x, "RCPT TO:<$to>") && preg_match('/reset code is: (\d{6})/', $x, $m)) { $found = $m[1]; }
    }
    return $found;
}
function throttle_reset(array $s): void { @unlink($s['data'] . '/abuse-recover.json'); @unlink($s['data'] . '/caps-recover.json'); }   // the per-address rules' tests start without the caps' counts
/** Move the recover limiter's clock back; $drop = key prefixes to forget outright (isolate one rule from the others). */
function throttle_backdate(array $s, int $secs, array $drop = []): void
{
    $f = $s['data'] . '/abuse-recover.json';
    $db = store_read($s['cfg'], $f);
    foreach ($db as $k => $ts) {
        foreach ($drop as $pre) { if (str_starts_with($k, $pre)) { unset($db[$k]); continue 2; } }
        $db[$k] = array_map(fn($t) => $t - $secs, $ts);
    }
    store_write($s['cfg'], $f, $db);
}

$S = start('ok');

// ---------------------------------------------------------------- recover

t('recover mails a code that resets the password once; the code is hashed at rest and in no log', function () use ($S) {
    signup($S, 'eve', 'eve@example.com');
    $r = call($S, ['action' => 'recover', 'username' => 'eve']);
    eq(200, $r['status']); eq(['ok' => true], $r['body']);
    eq(1, wait_sessions($S, 1), 'one message reached the fake SMTP server');
    $code = code_from($S, 'eve@example.com');
    ok($code !== null, 'the mail carries a 6-digit code');
    // The code is nowhere on disk in the clear: not the logs, not recover.json (ENC1 but decrypted here).
    $log = (string) file_get_contents($S['data'] . '/mail.log');
    ok(!str_contains($log, $code), 'mail.log holds the code');
    ok(preg_match('/user=eve  mailed/', $log) === 1, "mail.log says a code was issued: $log");
    foreach (glob($S['data'] . '/*.log*') as $f) { ok(!str_contains((string) file_get_contents($f), $code), "$f holds the code"); }
    $rec = store_read($S['cfg'], $S['data'] . '/recover.json');
    ok(isset($rec['eve']['hash']) && !isset($rec['eve']['code']), 'recover.json stores a hash, not the code');
    ok(!str_contains(json_encode($rec), $code), 'and not the code anywhere in the record');
    $bad = $code === '000000' ? '111111' : '000000';
    eq(403, call($S, ['action' => 'reset', 'username' => 'eve', 'code' => $bad, 'password' => 'newpass-1'])['status'], 'wrong code');
    eq(200, call($S, ['action' => 'reset', 'username' => 'eve', 'code' => $code, 'password' => 'newpass-1'])['status'], 'right code resets');
    eq(403, call($S, ['action' => 'reset', 'username' => 'eve', 'code' => $code, 'password' => 'newpass-2'])['status'], 'single use');
    eq(200, call($S, ['action' => 'login', 'username' => 'eve', 'password' => 'newpass-1'])['status'], 'new password works');
});

t('a code issued before the hash-at-rest change (plaintext record) still resets once', function () use ($S) {
    signup($S, 'cee', 'cee@example.com');
    $f = $S['data'] . '/recover.json';
    $db = store_read($S['cfg'], $f);
    $db['cee'] = ['code' => '424242', 'expires' => time() + 600, 'tries' => 0];
    store_write($S['cfg'], $f, $db);
    eq(200, call($S, ['action' => 'reset', 'username' => 'cee', 'code' => '424242', 'password' => 'legacy-pw-1'])['status']);
    eq(403, call($S, ['action' => 'reset', 'username' => 'cee', 'code' => '424242', 'password' => 'legacy-pw-2'])['status'], 'and only once');
});

t('an expired code is refused (15 minute life kept)', function () use ($S) {
    throttle_reset($S);
    signup($S, 'ben', 'ben@example.com');
    call($S, ['action' => 'recover', 'username' => 'ben']);
    wait_sessions($S, 3);
    $code = code_from($S, 'ben@example.com');
    $f = $S['data'] . '/recover.json';
    $db = store_read($S['cfg'], $f);
    $db['ben']['expires'] = time() - 1;
    store_write($S['cfg'], $f, $db);
    eq(403, call($S, ['action' => 'reset', 'username' => 'ben', 'code' => $code, 'password' => 'expired-pw-1'])['status']);
});

t('no mail for a missing user; the reply is byte-identical for existing, missing, throttled and malformed names', function () use ($S) {
    throttle_reset($S);
    signup($S, 'sam', 'sam@example.com');
    $before = delivered($S);
    $replies = [
        'existing'  => call($S, ['action' => 'recover', 'username' => 'sam']),
        'throttled' => call($S, ['action' => 'recover', 'username' => 'sam']),       // inside the 60 s cooldown
        'missing'   => call($S, ['action' => 'recover', 'username' => 'nobody-here']),
        'malformed' => call($S, ['action' => 'recover', 'username' => str_repeat('x', 300)]),
        'empty'     => call($S, ['action' => 'recover']),
    ];
    $ref = $replies['existing'];
    foreach ($replies as $k => $r) {
        eq($ref['status'], $r['status'], "$k status");
        eq($ref['raw'], $r['raw'], "$k body");
        eq($ref['head'], $r['head'], "$k headers");
    }
    wait_sessions($S, count($before) + 1);
    usleep(500000);
    $after = delivered($S);
    eq(1, ($after['sam@example.com'] ?? 0) - ($before['sam@example.com'] ?? 0), 'exactly one mail to sam (the cooldown stopped the second)');
    eq($before + ['sam@example.com' => 1], $after + [], 'and none to anyone else');
});

t('cooldown: a second request inside 60 s sends nothing and leaves the first code valid', function () use ($S) {
    throttle_reset($S);
    signup($S, 'val', 'val@example.com');
    call($S, ['action' => 'recover', 'username' => 'val']);
    wait_to($S, 'val@example.com', 1);
    $n = delivered($S)['val@example.com'];
    $code = code_from($S, 'val@example.com');
    eq(200, call($S, ['action' => 'recover', 'username' => 'val'])['status']);
    usleep(700000);
    eq($n, delivered($S)['val@example.com'], 'no second mail');
    eq($code, code_from($S, 'val@example.com'), 'no new code mailed');
    eq(200, call($S, ['action' => 'reset', 'username' => 'val', 'code' => $code, 'password' => 'val-new-1'])['status'], 'the first code still resets');
    // After the cooldown (clock moved back 61 s) a new request is served again.
    throttle_backdate($S, 61);
    call($S, ['action' => 'recover', 'username' => 'val']);
    usleep(1200000);
    eq($n + 1, delivered($S)['val@example.com'], 'cooldown over: mailed again');
});

t('3 per hour per username: the 4th, even past the cooldown, sends nothing', function () use ($S) {
    throttle_reset($S);
    signup($S, 'bob', 'bob@example.com');
    $base = delivered($S)['bob@example.com'] ?? 0;
    for ($i = 1; $i <= 4; $i++) {
        call($S, ['action' => 'recover', 'username' => 'bob']);
        throttle_backdate($S, 61, ['a:']);  // past the 60 s cooldown, inside the hour; forget the address rule so ONLY the per-username cap can stop #4
        usleep(250000);
    }
    usleep(1500000);
    eq($base + 3, delivered($S)['bob@example.com'] ?? 0, 'three mails, not four');
});

t('3 per hour per destination address, whatever the username (register-with-a-victim\'s-address attack)', function () use ($S) {
    throttle_reset($S);
    $base = delivered($S)['victim@example.com'] ?? 0;
    foreach (['v1', 'v2', 'v3', 'v4', 'v5'] as $u) { signup($S, $u, 'victim@example.com'); }
    foreach (['v1', 'v2', 'v3', 'v4', 'v5'] as $u) { eq(200, call($S, ['action' => 'recover', 'username' => $u])['status']); }
    usleep(2000000);
    eq($base + 3, delivered($S)['victim@example.com'] ?? 0, 'the victim got three, not five');
});

t('10 per hour per client IP: past it, even a first request for a real account sends nothing', function () use ($S) {
    throttle_reset($S);
    signup($S, 'otto', 'otto@example.com');
    for ($i = 0; $i < 10; $i++) { eq(200, call($S, ['action' => 'recover', 'username' => "ghost$i"])['status']); }
    $r = call($S, ['action' => 'recover', 'username' => 'otto']);
    eq(200, $r['status']); eq(['ok' => true], $r['body']);
    usleep(1500000);
    eq(0, delivered($S)['otto@example.com'] ?? 0, 'the 11th request from one IP sent no mail');
    throttle_backdate($S, 3601);
    call($S, ['action' => 'recover', 'username' => 'otto']);
    usleep(1500000);
    eq(1, delivered($S)['otto@example.com'] ?? 0, 'an hour later it works again');
});

t('the IP rule counts refused attempts too (`always`): eight refusals plus two sends exhaust 10/hour', function () use ($S) {
    throttle_reset($S);
    signup($S, 'buddy', 'buddy@example.com'); signup($S, 'max', 'max@example.com'); signup($S, 'ana', 'ana@example.com');
    // Two accounts, five asks each: 1 sent and 4 refused by the cooldown apiece, and neither reaches its daily cap (6),
    // which would refuse before the per-address tables are touched.
    for ($i = 0; $i < 10; $i++) { eq(200, call($S, ['action' => 'recover', 'username' => $i % 2 ? 'max' : 'buddy'])['status']); }
    throttle_backdate($S, 0, ['u:', 'a:']);          // forget every rule except the IP's
    call($S, ['action' => 'recover', 'username' => 'ana']);
    usleep(1500000);
    eq(0, delivered($S)['ana@example.com'] ?? 0, 'the IP had already spent its ten, refusals included');
});

t('a reset code lives fifteen minutes, not longer', function () use ($S) {
    throttle_reset($S);
    signup($S, 'ttl', 'ttl@example.com');
    call($S, ['action' => 'recover', 'username' => 'ttl']);
    $left = (int) (store_read($S['cfg'], $S['data'] . '/recover.json')['ttl']['expires'] ?? 0) - time();
    ok($left > 800 && $left <= 900, "expiry is $left s ahead; want at most 900");
});

t('the reset code never appears in the mail worker\'s command line (stdin only)', function () {
    $H = start('hang');                      // the worker lingers on the hung SMTP for its whole timeout
    signup($H, 'argv', 'argv@example.com');
    call($H, ['action' => 'recover', 'username' => 'argv']);
    $seen = [];
    for ($i = 0; $i < 40; $i++) {
        foreach (explode("\n", (string) shell_exec('ps -axww -o command=')) as $c) {
            if (str_contains($c, $H['dir']) && str_contains($c, 'mail-worker.php')) { $seen[$c] = true; }
        }
        if ($seen) { break; }
        usleep(50000);
    }
    ok($seen !== [], 'the worker process was observed');
    foreach (array_keys($seen) as $c) { ok(preg_match('/ -q -f \S+mail-worker\.php$/', $c) === 1, "worker argv carries more than the script: $c"); }
});

t('worker binary: config php_bin wins when PHP_BINARY is not PHP; with neither usable the code is logged NOT SENT and the reply is identical', function () {
    $fake = sys_get_temp_dir() . '/abusetest-notphp-' . getmypid();
    @mkdir($fake, 0700, true);
    $odd = "$fake/httpd";                      // what PHP_BINARY looks like under mod_php / php-fpm
    @unlink($odd); @link(PHP_BINARY, $odd) || copy(PHP_BINARY, $odd);   // a link keeps its own name in PHP_BINARY (a symlink would resolve back)
    chmod($odd, 0755);
    try {
        $A = start('ok', [], 'builtin', ['bin' => $odd, 'cfg' => ['php_bin' => PHP_BINARY]]);
        signup($A, 'pb', 'pb@example.com');
        eq(['ok' => true], call($A, ['action' => 'recover', 'username' => 'pb'])['body']);
        eq(1, wait_sessions($A, 1), 'sent through php_bin');
        $B = start('ok', [], 'builtin', ['bin' => $odd, 'cfg' => ['php_bin' => 'php']]);   // relative: refused, never searched on PATH
        signup($B, 'pb', 'pb@example.com');
        $ref = call($A, ['action' => 'recover', 'username' => 'nobody']);
        $r = call($B, ['action' => 'recover', 'username' => 'pb']);
        eq($ref['body'], $r['body']); eq($ref['status'], $r['status']);
        usleep(800000);
        eq(0, count(sessions($B)), 'nothing sent without a usable binary');
        $log = (string) file_get_contents($B['data'] . '/mail.log');
        ok(preg_match('/user=pb  NOT SENT[^\n]*\n/', $log) === 1 && preg_match('/\d{6}/', $log) !== 1, "log: $log");
    } finally { @unlink($odd); @rmdir($fake); }
});

t('mail.log is owner-only (0600) and carries no address; a loose existing file is tightened', function () {
    $O = start('off');
    file_put_contents($O['data'] . '/mail.log', "old line\n"); chmod($O['data'] . '/mail.log', 0644);
    signup($O, 'perm', 'perm@example.com');
    call($O, ['action' => 'recover', 'username' => 'perm']);
    usleep(800000);
    clearstatcache();
    eq('0600', substr(sprintf('%o', fileperms($O['data'] . '/mail.log')), -4), 'mail.log mode');
    $log = (string) file_get_contents($O['data'] . '/mail.log');
    ok(str_contains($log, 'user=perm') && !str_contains($log, 'perm@example.com'), "no address in: $log");
});

t('a meeting answer sent with mail on: the shared transport\'s line lands in a mail.log that is 0600', function () {
    $M = start('ok');
    signup($M, 'alex', 'alex@example.com');
    owner_request($M, 'guestp@example.com');
    eq(200, call($M, ['action' => 'meetreq_mail', 'to' => 'guestp@example.com', 'kind' => 'declined'], login($M, 'alex'))['status']);
    wait_sessions($M, 1);
    clearstatcache();
    ok(preg_match('/mailed/', (string) file_get_contents($M['data'] . '/mail.log')) === 1, 'the transport logged its line');
    eq('0600', substr(sprintf('%o', fileperms($M['data'] . '/mail.log')), -4), 'mail.log mode');
    eq('0600', substr(sprintf('%o', fileperms($M['data'] . '/meetreq-mail.log')), -4), 'meetreq-mail.log mode');
});

t('a new public request mails the owner\'s own address from the worker: slot only, no visitor text; the answer is queued, not sent inline', function () {
    $M = start('ok');
    signup($M, 'alex', 'alex@example.com');
    owner_request($M, 'guest7@example.com');
    eq(1, wait_to($M, 'alex@example.com', 1), 'the owner got one notice');
    usleep(500000);
    eq(0, delivered($M)['guest7@example.com'] ?? 0, 'the visitor was not mailed by creating a request');
    $texts = '';
    foreach (sessions($M) as $x) { if (str_contains($x, 'RCPT TO:<alex@example.com>')) { $texts .= $x; } }
    ok(preg_match('/\d{4}-\d{2}-\d{2} 16:00/', $texts) === 1, 'the slot is in the notice');
    ok(!str_contains($texts, 'Guest') && !str_contains($texts, 'guest7@example.com'), 'nothing the visitor typed is in it');
    $r = call($M, ['action' => 'meetreq_mail', 'to' => 'guest7@example.com', 'kind' => 'declined'], login($M, 'alex'));
    eq(200, $r['status']);
    eq('queued', $r['body']['sent'], 'handed to the worker');
    eq(1, wait_to($M, 'guest7@example.com', 1), 'and delivered by it');
    $log = (string) file_get_contents($M['data'] . '/meetreq-mail.log');
    ok(str_contains($log, 'kind=notice') && !str_contains($log, 'alex@example.com') && str_contains($log, 'kind=declined') && str_contains($log, 'mailed'), "log: $log");
});

t('a request that names a non-owner account mails nobody (a sign-up address is unverified)', function () {
    $M = start('ok');
    signup($M, 'alex', 'alex@example.com');
    signup($M, 'eve', 'victim7@example.com');
    @unlink($M['data'] . '/meetreq-ips.json'); @unlink($M['data'] . '/caps-meetreq.json');
    $d = date('Y-m-d', strtotime('next monday'));
    $r = call($M, ['action' => 'meetreq_create', 'user' => 'eve', 'name' => 'Guest', 'email' => 'guest7@example.com', 'date' => $d, 'time' => '16:00']);
    ok(in_array($r['status'], [200, 409], true), 'the call is answered the same either way');
    usleep(800000);
    eq(0, count(sessions($M)), 'no SMTP session: nothing to the non-owner account address');
});

t('mail off: a new request sends no notice and an answer is logged inline as log-only', function () {
    $O = start('off');
    signup($O, 'alex', 'alex@example.com');
    owner_request($O, 'guest8@example.com');
    $r = call($O, ['action' => 'meetreq_mail', 'to' => 'guest8@example.com', 'kind' => 'declined'], login($O, 'alex'));
    eq('log-only', $r['body']['sent']);
    usleep(500000);
    eq(0, count(sessions($O)), 'no SMTP session at all');
    ok(!str_contains((string) file_get_contents($O['data'] . '/meetreq-mail.log'), 'notice'), 'no notice line');
});

t('meeting mail with no usable worker binary sends nothing and says NOT SENT (fails closed, never inline)', function () {
    $fake = sys_get_temp_dir() . '/abusetest-notphp2-' . getmypid();
    @mkdir($fake, 0700, true);
    $odd = "$fake/httpd";
    @unlink($odd); @link(PHP_BINARY, $odd) || copy(PHP_BINARY, $odd);
    chmod($odd, 0755);
    try {
        $B = start('ok', [], 'builtin', ['bin' => $odd, 'cfg' => ['php_bin' => 'php']]);
        signup($B, 'alex', 'alex@example.com');
        owner_request($B, 'guest9@example.com');
        $r = call($B, ['action' => 'meetreq_mail', 'to' => 'guest9@example.com', 'kind' => 'declined'], login($B, 'alex'));
        eq(200, $r['status']);
        eq('not-sent', $r['body']['sent']);
        usleep(800000);
        eq(0, count(sessions($B)), 'nothing reached SMTP');
        ok(str_contains((string) file_get_contents($B['data'] . '/meetreq-mail.log'), 'NOT SENT'), 'the log says so');
    } finally { @unlink($odd); @rmdir($fake); }
});

t('mail off: the log says a code was issued, never the code', function () {
    $O = start('off');
    signup($O, 'outsider', 'outsider@example.com');
    call($O, ['action' => 'recover', 'username' => 'outsider']);
    usleep(800000);
    $log = (string) file_get_contents($O['data'] . '/mail.log');
    ok(preg_match('/user=outsider  log-only\n/', $log) === 1, "log line: $log");
    ok(preg_match('/\d{6}/', preg_replace('/^\S+/m', '', $log)) !== 1 || !str_contains($log, 'code='), 'no code= in the log');
    ok(!str_contains($log, 'code='), 'no code= in the log');
});

t('the debug flag (CALMIND_DEBUG_LOG_CODES=1) is the only way a code reaches the log', function () {
    $D = start('off', ['CALMIND_DEBUG_LOG_CODES' => '1']);
    signup($D, 'max', 'max@example.com');
    call($D, ['action' => 'recover', 'username' => 'max']);
    usleep(800000);
    ok(preg_match('/user=max  log-only  code=\d{6}\n/', (string) file_get_contents($D['data'] . '/mail.log')) === 1);
});

t('timing: a slow SMTP hand-off never shows; existing, missing and throttled answer within the same margin', function () {
    $H = start('hang');                       // the fake server never answers: a send takes the whole 2 s deadline and more
    signup($H, 'alice', 'alice@example.com');
    $samples = ['existing' => [], 'missing' => [], 'throttled' => []];
    for ($i = 0; $i < 6; $i++) {
        throttle_reset($H);
        $samples['existing'][]  = call($H, ['action' => 'recover', 'username' => 'alice'])['secs'];
        $samples['throttled'][] = call($H, ['action' => 'recover', 'username' => 'alice'])['secs'];
        throttle_reset($H);
        $samples['missing'][]   = call($H, ['action' => 'recover', 'username' => "nobody$i"])['secs'];
    }
    $med = function (array $a) { sort($a); return $a[intdiv(count($a), 2)]; };
    $m = array_map($med, $samples);
    fwrite(STDERR, sprintf("       medians ms: existing %.1f  missing %.1f  throttled %.1f  (max existing %.1f)\n",
        $m['existing'] * 1000, $m['missing'] * 1000, $m['throttled'] * 1000, max($samples['existing']) * 1000));
    ok(max($samples['existing']) < 1.0, 'an existing account\'s reply waited on SMTP: ' . round(max($samples['existing']), 2) . 's');
    ok(abs($m['existing'] - $m['missing']) < 0.05, 'existing vs missing differ by ' . round(abs($m['existing'] - $m['missing']) * 1000) . ' ms');
    ok(abs($m['existing'] - $m['throttled']) < 0.05, 'existing vs throttled differ by ' . round(abs($m['existing'] - $m['throttled']) * 1000) . ' ms');
});

t('CGI host model (Apache + mod_cgi + php-cgi): a hung SMTP never shows in the reply; existing = missing = throttled', function () {
    $A = start('hang', [], 'apache');
    $r = call($A, ['action' => 'signup', 'username' => 'cgi', 'email' => 'cgi@example.com', 'password' => 'passw0rd-cgi']);
    eq(200, $r['status'], 'signup through Apache');
    file_put_contents($A['dir'] . '/probe.php', '<?php echo function_exists("fastcgi_finish_request") ? "yes" : "no", " ", PHP_SAPI;');
    $pr = trim((string) shell_exec('php-cgi -q -f ' . escapeshellarg($A['dir'] . '/probe.php')));
    ok(str_starts_with($pr, 'no') || str_contains($pr, 'no cgi'), "php-cgi must lack fastcgi_finish_request (the host's model): $pr");
    $samples = ['existing' => [], 'missing' => [], 'throttled' => []];
    for ($i = 0; $i < 8; $i++) {
        throttle_reset($A);
        $samples['existing'][]  = call($A, ['action' => 'recover', 'username' => 'cgi'])['secs'];
        $samples['throttled'][] = call($A, ['action' => 'recover', 'username' => 'cgi'])['secs'];
        throttle_reset($A);
        $samples['missing'][]   = call($A, ['action' => 'recover', 'username' => "nobody$i"])['secs'];
    }
    $med = function (array $a) { sort($a); return $a[intdiv(count($a), 2)]; };
    $m = array_map($med, $samples);
    fwrite(STDERR, sprintf("       CGI medians ms: existing %.1f  missing %.1f  throttled %.1f  (max existing %.1f)\n",
        $m['existing'] * 1000, $m['missing'] * 1000, $m['throttled'] * 1000, max($samples['existing']) * 1000));
    ok(max($samples['existing']) < 1.0, 'an existing account\'s reply waited on SMTP: ' . round(max($samples['existing']), 2) . 's');
    ok(abs($m['existing'] - $m['missing']) < 0.05, 'existing vs missing differ by ' . round(abs($m['existing'] - $m['missing']) * 1000) . ' ms');
    ok(abs($m['existing'] - $m['throttled']) < 0.05, 'existing vs throttled differ by ' . round(abs($m['existing'] - $m['throttled']) * 1000) . ' ms');
});

t('CGI host model: the mail still goes out (detached worker) and its code resets the password', function () {
    $A = start('ok', [], 'apache');
    signup($A, 'cgi2', 'cgi2@example.com');
    $r = call($A, ['action' => 'recover', 'username' => 'cgi2']);
    eq(200, $r['status']); eq(['ok' => true], $r['body']);
    eq(1, wait_sessions($A, 1), 'the worker delivered one message');
    $code = code_from($A, 'cgi2@example.com');
    ok($code !== null, 'with a code');
    eq(200, call($A, ['action' => 'reset', 'username' => 'cgi2', 'code' => $code, 'password' => 'cgi-new-1'])['status']);
    $log = (string) file_get_contents($A['data'] . '/mail.log');
    ok(preg_match('/user=cgi2  mailed/', $log) === 1 && !str_contains($log, $code), "log: $log");
});

// ---------------------------------------------------------------- meetreq_mail

function owner_request(array $S, string $email, string $time = '16:00'): void
{
    @unlink($S['data'] . '/meetreq-ips.json'); @unlink($S['data'] . '/caps-meetreq.json');
    $d = date('Y-m-d', strtotime('next monday'));
    eq(200, call($S, ['action' => 'meetreq_create', 'user' => 'alex', 'name' => 'Guest', 'email' => $email, 'date' => $d, 'time' => $time])['status'], "request from $email");
}
function abuse_reset(array $S, string $name): void { @unlink($S['data'] . "/abuse-$name.json"); @unlink($S['data'] . "/caps-$name.json"); }

t('meetreq_mail: only the request owner mails a request\'s address; nobody may mail their own (unverified) sign-up address', function () use ($S) {
    $own = signup($S, 'alex', 'alex@example.com');
    $mal = signup($S, 'mal', 'mal@example.com');
    owner_request($S, 'guest1@example.com', '16:00');
    owner_request($S, 'guest2@example.com', '17:00');
    $base = delivered($S);
    $mail = fn(string $tok, array $x) => call($S, array_merge(['action' => 'meetreq_mail', 'kind' => 'declined', 'when' => ''], $x), $tok);
    eq(401, call($S, ['action' => 'meetreq_mail', 'to' => 'guest1@example.com', 'kind' => 'declined'])['status'], 'anonymous');
    eq(403, $mail($mal, ['to' => 'target@example.com'])['status'], 'a stranger account cannot mail a free address');
    eq(403, $mail($mal, ['to' => 'guest1@example.com'])['status'], 'nor an address on someone else\'s request');
    eq(403, $mail($mal, ['to' => 'mal@example.com'])['status'], 'not even its own sign-up address (unverified: could be a victim\'s)');
    $vic = signup($S, 'vicreg', 'victim0@example.com');
    eq(403, $mail($vic, ['to' => 'victim0@example.com'])['status'], 'registering a victim\'s address does not make it mailable');
    eq(403, $mail($own, ['to' => 'alex@example.com'])['status'], 'the owner\'s own address is not a licence either');
    eq(403, $mail($own, ['to' => 'target@example.com'])['status'], 'the owner cannot mail a free address either');
    eq(200, $mail($own, ['to' => 'guest1@example.com'])['status'], 'the owner mails a requester');
    eq(200, $mail($own, ['to' => 'GUEST2@example.com', 'id' => ''])['status'], 'case-insensitive match');
    eq(403, $mail($own, ['to' => 'guest2@example.com', 'id' => 'mr-not-a-record'])['status'], 'an id pins the record');
    eq(400, $mail($own, ['to' => 'guest1@example.com', 'id' => 'bad id!'])['status'], 'bad id');
    eq(400, $mail($own, ['to' => 'not an address'])['status'], 'bad address');
    eq(400, $mail($own, ['to' => 'guest1@example.com', 'kind' => 'shout'])['status'], 'bad kind');
    // A request forged through sync by a stranger does not authorise anything.
    call($S, ['action' => 'sync', 'cursor' => 0, 'changes' => [['id' => 'mrforged', 'type' => 'meetreq', 'updated' => 1, 'deleted' => false,
        'payload' => ['name' => 'x', 'email' => 'target@example.com', 'date' => '2030-01-01', 'time' => '10:00', 'status' => 'new']]]], $mal);
    eq(403, $mail($mal, ['to' => 'target@example.com', 'id' => 'mrforged'])['status'], 'a self-made meetreq record is not a licence');
    wait_to($S, 'guest2@example.com', 1);
    usleep(500000);
    $after = delivered($S);
    eq(0, ($after['mal@example.com'] ?? 0) - ($base['mal@example.com'] ?? 0), 'mal ' . json_encode($after));
    eq(0, $after['victim0@example.com'] ?? 0, 'nothing to the registered victim address');
    eq(2, $after['alex@example.com'] ?? 0, 'the owner\'s own address got only the two new-request notices, no answer');
    eq(1, ($after['guest1@example.com'] ?? 0) - ($base['guest1@example.com'] ?? 0), 'g1 ' . json_encode($after));
    eq(1, ($after['guest2@example.com'] ?? 0) - ($base['guest2@example.com'] ?? 0), 'g2 ' . json_encode($after));
    eq(0, $after['target@example.com'] ?? 0, 'nothing ever went to the victim');
});

t('meetreq_mail: `when` is a date and clock time or nothing; no caller text reaches the mail', function () use ($S) {
    abuse_reset($S, 'meetreq-mail'); abuse_reset($S, 'meetreq-mail-addr');
    $own = login($S, 'alex');
    $base = delivered($S)['guest1@example.com'] ?? 0;
    $mail = fn(string $kind, string $when) => call($S, ['action' => 'meetreq_mail', 'to' => 'guest1@example.com', 'kind' => $kind, 'when' => $when], $own);
    $bad = ["Tue\r\nBcc: evil@example.com", 'CLICK http://evil.example/x', '2026-11-16 4pm http://evil.example', str_repeat('A', 400),
            '', 'tomorrow'];
    foreach ($bad as $w) { eq(400, $mail('accepted', $w)['status'], 'rejected: ' . json_encode(substr($w, 0, 30))); }
    foreach ($bad as $w) { eq(400, $mail('newtime', $w)['status'], 'newtime rejected: ' . json_encode(substr($w, 0, 30))); }
    usleep(500000);
    eq($base, delivered($S)['guest1@example.com'] ?? 0, 'nothing sent for any of them');
    eq(200, $mail('accepted', '2026-11-16 4pm')['status'], 'the app\'s own format 12h');
    eq(200, $mail('newtime', '2026-11-16 16:00')['status'], 'the app\'s own format 24h');
    eq(200, $mail('declined', 'CLICK http://evil.example/x')['status'], 'declined carries no when at all');
    wait_to($S, 'guest1@example.com', $base + 3);
    $texts = '';
    foreach (sessions($S) as $x) { if (str_contains($x, 'RCPT TO:<guest1@example.com>')) { $texts .= $x; } }
    ok(!str_contains($texts, 'evil') && !str_contains($texts, 'CLICK') && preg_match('/^Bcc:/mi', $texts) === 0, 'no attacker text in any mail');
    ok(str_contains($texts, '2026-11-16 4pm'), 'the legitimate when is in the mail');
    $log = (string) file_get_contents($S['data'] . '/meetreq-mail.log');
    ok(!str_contains($log, 'evil'), 'nor in the log');
});

t('meetreq_mail: 3 per destination address per hour, however fast the owner\'s client asks', function () use ($S) {
    abuse_reset($S, 'meetreq-mail'); abuse_reset($S, 'meetreq-mail-addr');
    owner_request($S, 'guest3@example.com', '18:00');
    $own = login($S, 'alex');
    $base = delivered($S)['guest3@example.com'] ?? 0;
    $codes = [];
    for ($j = 0; $j < 6; $j++) { $codes[] = call($S, ['action' => 'meetreq_mail', 'to' => 'guest3@example.com', 'kind' => 'accepted', 'when' => '2026-11-16 4pm'], $own)['status']; }
    eq([200, 200, 200, 429, 429, 429], $codes);
    usleep(1500000);
    eq($base + 3, delivered($S)['guest3@example.com'] ?? 0, 'the guest got three, not six');
});

t('meetreq_mail: a stranger\'s refused attempt does not spend a guest\'s per-address allowance', function () use ($S) {
    abuse_reset($S, 'meetreq-mail'); abuse_reset($S, 'meetreq-mail-addr');
    $mal = login($S, 'mal'); $own = login($S, 'alex');
    for ($i = 0; $i < 6; $i++) { eq(403, call($S, ['action' => 'meetreq_mail', 'to' => 'guest2@example.com', 'kind' => 'declined'], $mal)['status']); }
    eq(200, call($S, ['action' => 'meetreq_mail', 'to' => 'guest2@example.com', 'kind' => 'declined'], $own)['status'], 'the owner can still answer the guest');
});

t('meetreq_mail: 30 per account per hour, then 429 and no mail', function () use ($S) {
    abuse_reset($S, 'meetreq-mail');
    $own = login($S, 'alex');
    $base = delivered($S)['guest1@example.com'] ?? 0;
    $codes = [];
    for ($i = 0; $i < 32; $i++) { abuse_reset($S, 'meetreq-mail-addr'); $codes[] = call($S, ['action' => 'meetreq_mail', 'to' => 'guest1@example.com', 'kind' => 'declined'], $own)['status']; }
    eq(array_merge(array_fill(0, 30, 200), [429, 429]), $codes);
    wait_to($S, 'guest1@example.com', $base + 30);
    usleep(1000000);
    eq($base + 30, delivered($S)['guest1@example.com'] ?? 0, 'exactly 30 mails left');
});

t('meetreq_mail: 60 per client IP per hour across accounts, refused attempts included', function () use ($S) {
    abuse_reset($S, 'meetreq-mail');
    $own = login($S, 'alex'); $mal = login($S, 'mal'); $oth = signup($S, 'ipx', 'ipx@example.com');
    $send = function (string $tok) use ($S) { abuse_reset($S, 'meetreq-mail-addr'); return call($S, ['action' => 'meetreq_mail', 'to' => 'guest1@example.com', 'kind' => 'declined'], $tok)['status']; };
    // Spend the IP's 60 with 20 real sends and 40 refused strangers (two accounts, so no per-account cap interferes).
    $first = []; for ($i = 0; $i < 20; $i++) { $first[] = $send($own); }
    eq(array_fill(0, 20, 200), $first);
    for ($i = 0; $i < 20; $i++) { eq(403, $send($mal)); eq(403, $send($oth)); }
    eq(429, $send($own), 'the 61st from this IP is refused although every account is under its own cap');
});

// ---------------------------------------------------------------- address-independent caps
//
// On NearlyFreeSpeech the client chooses REMOTE_ADDR, so these tests send every request from an address of its own
// (X-Test-Addr, see start()) and show that the per-address rules never bite while the caps do.

// The policy numbers, pinned here as docs/api.md lists them (lib/app.php is not loaded into this process).
const RECOVER_GLOBAL_HOUR = 30;
const RECOVER_ACCT_DAY = 6;
const MEETREQ_ACCT_HOUR = 10;
const MEETREQ_ACCT_DAY = 30;
const MEETREQ_GLOBAL_DAY = 100;
const MEETREQ_MAIL_GLOBAL_HOUR = 60;
const MEETREQ_MAIL_GLOBAL_DAY = 200;

/** What store_write() would put on disk for this plain text (ENC1: + base64 of IV and AES-256-CBC), JSON or not. */
function enc1(array $cfg, string $plain): string
{
    $iv = random_bytes(16);
    return 'ENC1:' . base64_encode($iv . openssl_encrypt($plain, 'aes-256-cbc', store_key($cfg), OPENSSL_RAW_DATA, $iv));
}
function fake_addr(int $i): string { return sprintf('198.51.%d.%d', intdiv($i, 200), $i % 200 + 1); }
/** Set one cap counter (as cap_take stores it) to $n in the window that is open now. */
function cap_preset(array $s, string $name, string $key, int $window, int $n): void
{
    $f = $s['data'] . "/caps-$name.json";
    $db = store_read($s['cfg'], $f);
    $db["$key@$window"] = ['e' => (intdiv(time(), $window) + 1) * $window, 'n' => $n];
    store_write($s['cfg'], $f, $db);
}
function cap_rows(array $s, string $name): array { return store_read($s['cfg'], $s['data'] . "/caps-$name.json"); }
function same_answer(array $want, array $got, string $why): void
{
    eq($want['status'], $got['status'], "$why: status");
    eq($want['raw'], $got['raw'], "$why: body");
    eq($want['head'], $got['head'], "$why: headers");
}
function mr_create(array $s, string $user, string $addr, string $time = '16:00'): array
{
    return call($s, ['action' => 'meetreq_create', 'user' => $user, 'name' => 'Guest', 'email' => 'guest@example.com',
        'date' => date('Y-m-d', strtotime('next monday')), 'time' => $time], '', $addr);
}
function record_count(array $s, string $user): int
{
    return count((array) (store_read($s['cfg'], $s['data'] . "/records-$user.json")['recs'] ?? []));
}

t('caps: recover is capped for the whole site (30 an hour) however many addresses the requests claim', function () {
    $C = start('ok');
    signup($C, 'ana', 'ana@example.com');
    $first = [];
    for ($i = 0; $i < 30; $i++) { $first[] = call($C, ['action' => 'recover', 'username' => "ghost$i"], '', fake_addr($i)); }
    foreach ($first as $i => $r) { eq(200, $r['status'], "request $i"); eq(['ok' => true], $r['body']); }
    $rowsBefore = [count(store_read($C['cfg'], $C['data'] . '/abuse-recover.json')), count(cap_rows($C, 'recover'))];
    // The 31st asks for a REAL account from an address nothing has seen: the per-address rules have room, the cap does not.
    $over = call($C, ['action' => 'recover', 'username' => 'ana'], '', fake_addr(500));
    same_answer($first[0], $over, 'a capped request answers like any other');
    usleep(1500000);
    eq(0, delivered($C)['ana@example.com'] ?? 0, 'past the site-wide cap a real account gets no code');
    eq(30, cap_rows($C, 'recover')['g@3600']['n'] ?? null, 'the hour counter stopped at its cap');
    // A flood of made-up names and addresses past the cap adds no row to either table.
    for ($i = 0; $i < 40; $i++) { call($C, ['action' => 'recover', 'username' => "flood$i"], '', fake_addr(600 + $i)); }
    eq($rowsBefore, [count(store_read($C['cfg'], $C['data'] . '/abuse-recover.json')), count(cap_rows($C, 'recover'))], 'rows after the flood');
    // A new window starts the count over.
    $db = cap_rows($C, 'recover');
    $db['g@3600']['e'] = time() - 1;
    store_write($C['cfg'], $C['data'] . '/caps-recover.json', $db);
    call($C, ['action' => 'recover', 'username' => 'ana'], '', fake_addr(501));
    eq(1, wait_to($C, 'ana@example.com', 1), 'the next window serves a real account again');
});

t('caps: recover is capped per account per day (6), however the hourly rule and the addresses vary', function () {
    $C = start('ok');
    signup($C, 'ben', 'ben@example.com'); signup($C, 'bob', 'bob@example.com');
    for ($i = 0; $i < 8; $i++) {
        @unlink($C['data'] . '/abuse-recover.json');   // only the caps may stop these: no cooldown, no hourly 3, no per-address rule
        eq(200, call($C, ['action' => 'recover', 'username' => 'ben'], '', fake_addr($i))['status']);
        usleep(150000);
    }
    usleep(1500000);
    eq(6, delivered($C)['ben@example.com'] ?? 0, 'six codes in a day, not eight');
    @unlink($C['data'] . '/abuse-recover.json');
    call($C, ['action' => 'recover', 'username' => 'bob'], '', fake_addr(9));
    eq(1, wait_to($C, 'bob@example.com', 1), 'another account is not affected');
    // Strings that are no username share one counter: they add no rows of their own.
    foreach (['x!', 'a b', str_repeat('z', 70), '', 'q/q'] as $j => $bad) { call($C, ['action' => 'recover', 'username' => $bad], '', fake_addr(20 + $j)); }
    $keys = array_keys(cap_rows($C, 'recover'));
    sort($keys);
    eq(['g@3600', 'g@86400', 'u:' . hash('sha256', 'ben') . '@86400', 'u:' . hash('sha256', 'bob') . '@86400', 'u:bad@86400'], $keys, 'counter keys');
});

t('caps: a request refused by a cap answers like an accepted one and takes as long (existing = missing = capped)', function () {
    $C = start('ok');
    signup($C, 'cee', 'cee@example.com');
    $samples = ['existing' => [], 'missing' => [], 'capped' => []];
    for ($i = 0; $i < 6; $i++) {
        throttle_reset($C);
        $samples['existing'][] = call($C, ['action' => 'recover', 'username' => 'cee'], '', fake_addr($i))['secs'];
        throttle_reset($C);
        $samples['missing'][]  = call($C, ['action' => 'recover', 'username' => "nobody$i"], '', fake_addr(50 + $i))['secs'];
        throttle_reset($C);
        cap_preset($C, 'recover', 'g', 3600, RECOVER_GLOBAL_HOUR);
        $samples['capped'][]   = call($C, ['action' => 'recover', 'username' => 'cee'], '', fake_addr(80 + $i))['secs'];
    }
    $med = function (array $a) { sort($a); return $a[intdiv(count($a), 2)]; };
    $m = array_map($med, $samples);
    fwrite(STDERR, sprintf("       medians ms: existing %.1f  missing %.1f  capped %.1f\n", $m['existing'] * 1000, $m['missing'] * 1000, $m['capped'] * 1000));
    ok(abs($m['existing'] - $m['capped']) < 0.05, 'existing vs capped differ by ' . round(abs($m['existing'] - $m['capped']) * 1000) . ' ms');
    ok(abs($m['missing'] - $m['capped']) < 0.05, 'missing vs capped differ by ' . round(abs($m['missing'] - $m['capped']) * 1000) . ' ms');
});

t('caps: a counter store that cannot be read, locked or written refuses (recover answers as ever, sends nothing)', function () {
    $C = start('ok');
    signup($C, 'val', 'val@example.com');
    $ref = call($C, ['action' => 'recover', 'username' => 'nobody-at-all'], '', fake_addr(1));
    $mails = fn() => delivered($C)['val@example.com'] ?? 0;
    $caps = $C['data'] . '/caps-recover.json';
    $lock = $C['data'] . '/.caps-recover.lock';
    $try = function (string $why, ?string $was = null) use ($C, $ref, $mails, $caps) {
        @unlink($C['data'] . '/abuse-recover.json');   // the per-address rules must not be what refuses these
        $was ??= is_file($caps) ? md5_file($caps) : 'none';
        $n = $mails();
        $r = call($C, ['action' => 'recover', 'username' => 'val'], '', fake_addr(rand(100, 900)));
        same_answer($ref, $r, $why);
        usleep(1200000);
        eq($n, $mails(), "$why: nothing was sent");
        @chmod($caps, 0600);
        eq($was, is_file($caps) ? md5_file($caps) : 'none', "$why: the counter file was not rewritten");
    };
    file_put_contents($caps, 'ENC1:' . base64_encode(str_repeat('x', 40)));            // undecryptable
    $try('a damaged counter file');
    ok(str_contains((string) @file_get_contents($C['dir'] . '/web.log'), 'calmind caps recover: refused'), 'the operator\'s log says why');
    // store_read() answers [] for each of these, which once read as "no counters yet" and was granted, then reset every cap.
    foreach ([
        'a counter file that is not JSON'          => 'garbage-not-json',
        'an empty counter file'                    => '',
        'a counter file with no counters'          => '{}',
        'a counter file whose row is no counter'   => '{"g@3600":"x"}',
        'a counter file with a row lacking its count' => '{"g@3600":{"e":' . (time() + 3000) . '}}',
        'an encrypted counter file that is not JSON' => enc1($C['cfg'], 'not json'),
    ] as $why => $bytes) {
        file_put_contents($caps, $bytes);
        $try($why);
    }
    if (function_exists('posix_geteuid') && posix_geteuid() !== 0) {
        file_put_contents($caps, enc1($C['cfg'], json_encode(['g@3600' => ['e' => time() + 3000, 'n' => 1]])));
        $was = md5_file($caps);
        chmod($caps, 0000);
        $try('a counter file nobody may read', $was);
    }
    @unlink($caps);
    mkdir($caps, 0700);                                                                  // a counter file that cannot be replaced
    $try('a counter file that cannot be written');
    rmdir($caps);
    if (function_exists('posix_geteuid') && posix_geteuid() !== 0) {
        chmod($lock, 0400); $try('a lock file nobody may write');
        chmod($lock, 0200); $try('a lock file that opens write-only (the NFS case; c+ refuses it)');
        chmod($lock, 0600);
    }
    $n = $mails();
    throttle_reset($C);
    call($C, ['action' => 'recover', 'username' => 'val'], '', fake_addr(7));
    eq($n + 1, wait_to($C, 'val@example.com', $n + 1), 'with the store healthy again the same request is served');
});

t('caps: public requests are capped per account (10 an hour), existing or not, and the answer is the per-address one', function () {
    $C = start('ok');
    signup($C, 'alex', 'alex@example.com');
    $seq = fn(string $u, int $base) => array_map(fn($i) => mr_create($C, $u, fake_addr($base + $i)), range(0, 11));
    $real = $seq('alex', 0);
    $ghost = $seq('ghost', 100);
    $want = array_merge(array_fill(0, 10, 200), [429, 429]);
    eq($want, array_map(fn($r) => $r['status'], $real), 'real account');
    eq($want, array_map(fn($r) => $r['status'], $ghost), 'made-up account');
    same_answer($real[10], $ghost[11], 'a capped request for a real and a made-up account');
    eq(10, record_count($C, 'alex'), 'ten requests landed, two did not');
    // The per-address speed bump still stands, and says the same words.
    $P = start('ok');
    signup($P, 'alex', 'alex@example.com');
    $same = [];
    for ($i = 0; $i < 6; $i++) { $same[] = mr_create($P, 'alex', '203.0.113.9'); }
    eq([200, 200, 200, 200, 200, 429], array_map(fn($r) => $r['status'], $same), 'five from one address, then the per-address refusal');
    same_answer($same[5], $real[10], 'per-address refusal vs cap refusal');
});

t('caps: public requests are capped for the whole site (30 an hour, 100 a day) and a daily account cap holds', function () {
    $G = start('ok');
    signup($G, 'alex', 'alex@example.com');
    for ($i = 0; $i < 30; $i++) { eq(200, mr_create($G, "ghost$i", fake_addr($i))['status'], "request $i"); }
    $rows = [count(store_read($G['cfg'], $G['data'] . '/meetreq-ips.json')), count(cap_rows($G, 'meetreq'))];
    $over = mr_create($G, 'alex', fake_addr(300));
    eq(429, $over['status'], 'the 31st, for an account with room, from an address that is new');
    eq(0, record_count($G, 'alex'), 'and nothing was written for it');
    for ($i = 0; $i < 40; $i++) { mr_create($G, "flood$i", fake_addr(400 + $i)); }
    eq($rows, [count(store_read($G['cfg'], $G['data'] . '/meetreq-ips.json')), count(cap_rows($G, 'meetreq'))], 'a flood past the cap adds no row to either table');
    // Daily counters, each alone (the hour counters are empty in a fresh window).
    $D = start('ok');
    signup($D, 'alex', 'alex@example.com');
    cap_preset($D, 'meetreq', 'u:' . hash('sha256', 'alex'), 86400, MEETREQ_ACCT_DAY);
    eq(429, mr_create($D, 'alex', fake_addr(1))['status'], 'one account, a day\'s worth');
    eq(200, mr_create($D, 'other1', fake_addr(2))['status'], 'another account is not affected');
    cap_preset($D, 'meetreq', 'g', 86400, MEETREQ_GLOBAL_DAY);
    eq(429, mr_create($D, 'other1', fake_addr(3))['status'], 'the site, a day\'s worth');
});

t('caps: a damaged counter store refuses a public request with the ordinary words and writes nothing', function () {
    $F = start('ok');
    signup($F, 'alex', 'alex@example.com');
    eq(200, mr_create($F, 'alex', fake_addr(1))['status']);
    eq(1, record_count($F, 'alex'));
    for ($i = 0; $i < 6; $i++) { $ref = mr_create($F, 'alex', '203.0.113.9'); }   // the sixth from one address is the per-address refusal
    eq(429, $ref['status']);
    $caps = $F['data'] . '/caps-meetreq.json';
    $n = record_count($F, 'alex');
    foreach ([
        'undecryptable'        => 'ENC1:' . base64_encode(str_repeat('y', 40)),
        'not JSON'             => 'garbage-not-json',
        'empty'                => '',
        'encrypted, not JSON'  => enc1($F['cfg'], 'not json'),
        'no counters'          => '{}',
    ] as $why => $bytes) {
        file_put_contents($caps, $bytes);
        $r = mr_create($F, 'alex', fake_addr(2));
        same_answer($ref, $r, "damaged store ($why) vs per-address refusal");
        eq($n, record_count($F, 'alex'), "$why: no record was written");
        eq($bytes, (string) file_get_contents($caps), "$why: the counter file was not rewritten");
    }
    @unlink($caps);
    eq(200, mr_create($F, 'alex', fake_addr(3))['status'], 'healthy again');
});

t('caps: answers mailed are capped for the whole site once the caller is authorised, and strangers cannot spend it', function () {
    $M = start('ok');
    $own = signup($M, 'alex', 'alex@example.com');
    $mal = signup($M, 'mal', 'mal@example.com');
    owner_request($M, 'guestp@example.com');
    $send = fn(string $tok, int $i) => call($M, ['action' => 'meetreq_mail', 'to' => 'guestp@example.com', 'kind' => 'declined'], $tok, fake_addr($i));
    cap_preset($M, 'meetreq-mail', 'g', 3600, MEETREQ_MAIL_GLOBAL_HOUR - 1);
    for ($i = 0; $i < 6; $i++) { eq(403, $send($mal, $i)['status'], 'a stranger is refused'); }
    eq(MEETREQ_MAIL_GLOBAL_HOUR - 1, cap_rows($M, 'meetreq-mail')['g@3600']['n'], 'and spent none of it');
    eq(200, $send($own, 10)['status'], 'the owner\'s last answer of the hour goes');
    $rowsBefore = cap_rows($M, 'meetreq-mail');
    $over = $send($own, 11);
    eq(429, $over['status'], 'the next is refused');
    eq('too many answers sent — try again later', $over['body']['error'] ?? null, 'with the per-account words');
    eq($rowsBefore, cap_rows($M, 'meetreq-mail'), 'the hour counter was full: the day counter listed after it was not spent');
    wait_to($M, 'guestp@example.com', 1);
    usleep(800000);
    eq(1, delivered($M)['guestp@example.com'] ?? 0, 'one mail left');
    @unlink($M['data'] . '/caps-meetreq-mail.json');          // hour counter gone: only the day's can refuse now
    cap_preset($M, 'meetreq-mail', 'g', 86400, MEETREQ_MAIL_GLOBAL_DAY);
    eq(429, $send($own, 12)['status'], 'a day\'s worth also stops it');
    // A counter file that is not JSON refuses the owner's answer too, with the same words, and is not reset.
    $capsFile = $M['data'] . '/caps-meetreq-mail.json';
    file_put_contents($capsFile, 'garbage-not-json');
    @unlink($M['data'] . '/abuse-meetreq-mail-addr.json');    // three answers went to this address already: let the cap be what refuses
    $sent = delivered($M)['guestp@example.com'] ?? 0;
    $dam = $send($own, 13);
    eq([429, 'too many answers sent — try again later'], [$dam['status'], $dam['body']['error'] ?? null], 'a damaged counter store');
    usleep(800000);
    eq($sent, delivered($M)['guestp@example.com'] ?? 0, 'and nothing was mailed');
    eq('garbage-not-json', (string) file_get_contents($capsFile), 'the counter file was not rewritten');
});

t('caps: a refused call counts nothing, whichever counter is the full one', function () {
    $R = start('ok');
    signup($R, 'ana', 'ana@example.com');
    foreach (['ghost1', 'ghost2'] as $i => $g) { call($R, ['action' => 'recover', 'username' => $g], '', fake_addr($i)); }
    eq(2, cap_rows($R, 'recover')['g@3600']['n'], 'two requests counted so far');
    $ref = call($R, ['action' => 'recover', 'username' => 'nobody-at-all'], '', fake_addr(8));   // an ordinary answer, counted
    // recover: the account's day is the LAST counter in the call, the two site-wide ones come before it.
    cap_preset($R, 'recover', 'u:' . hash('sha256', 'ana'), 86400, RECOVER_ACCT_DAY);
    $caps = cap_rows($R, 'recover');
    $addr = store_read($R['cfg'], $R['data'] . '/abuse-recover.json');
    $r = call($R, ['action' => 'recover', 'username' => 'ana'], '', fake_addr(9));
    same_answer($ref, $r, 'recover past the account\'s day');
    eq($caps, cap_rows($R, 'recover'), 'recover: no counter moved, the site-wide hour and day included');
    eq($addr, store_read($R['cfg'], $R['data'] . '/abuse-recover.json'), 'recover: the per-address tables were not reached');
    usleep(1200000);
    eq(0, delivered($R)['ana@example.com'] ?? 0, 'recover: no code was sent');

    // meetreq_create: the account's hour (third in the call), then its day (fourth), each full on its own.
    $M = start('ok');
    signup($M, 'alex', 'alex@example.com');
    foreach (['ghost1', 'ghost2'] as $i => $g) { eq(200, mr_create($M, $g, fake_addr($i))['status']); }
    foreach ([['hour', 3600, MEETREQ_ACCT_HOUR], ['day', 86400, MEETREQ_ACCT_DAY]] as [$which, $win, $max]) {
        cap_preset($M, 'meetreq', 'u:' . hash('sha256', 'alex'), $win === 3600 ? 86400 : 3600, 0);   // the other of the two has room
        cap_preset($M, 'meetreq', 'u:' . hash('sha256', 'alex'), $win, $max);
        $caps = cap_rows($M, 'meetreq');
        $ips  = store_read($M['cfg'], $M['data'] . '/meetreq-ips.json');
        eq(429, mr_create($M, 'alex', fake_addr(20))['status'], "meetreq_create: the account's $which is full");
        eq($caps, cap_rows($M, 'meetreq'), "meetreq_create: no counter moved (the account's $which was full; the site-wide and the other one are listed around it)");
        eq($ips, store_read($M['cfg'], $M['data'] . '/meetreq-ips.json'), "meetreq_create: the per-address table was not reached ($which)");
        eq(0, record_count($M, 'alex'), "meetreq_create: nothing was written ($which)");
    }
});

// ---------------------------------------------------------------- recover with shared sign-in on

/**
 * The same app with the site's shared sign-in switched on (CALMIND_SITE_LIB_TEST names a seancheren-site lib; its library
 * is loaded in-process as on the host, over a scratch store and config). Returns [server, library config], or null.
 */
function start_shared(): ?array
{
    global $ROOT;
    $lib = rtrim((string) (getenv('CALMIND_SITE_LIB_TEST') ?: dirname($ROOT, 3) . '/seancheren-site/lib'), '/');   // default: the site checkout beside this repository's
    if ($lib === '' || !is_file($lib . '/mindsuite-auth.php')) { return null; }
    $site = sys_get_temp_dir() . '/abusetest-site-' . getmypid() . '-' . bin2hex(random_bytes(3));
    mkdir($site . '/protected', 0700, true);
    file_put_contents("$site/config.php", '<?php return ' . var_export(['base' => 'test', 'mindsuite_auth_instances' => ['test'],
        'mindsuite_auth_keys' => ['test' => 'abuse-test-key']], true) . ';');
    require_once $lib . '/mindsuite-auth.php';
    $acfg = msa_app_config('test', ['mindsuite_auth_instances' => ['test'], 'mindsuite_auth_keys' => ['test' => 'abuse-test-key'],
        'mindsuite_store_root' => "$site/protected"], 'calmind', '/', true);
    \MindSuite\Files\ensure_directory($acfg['data_dir']);
    msa_lock($acfg, fn() => msa_store_write($acfg, ['version' => 1, 'accounts' => [], 'sessions' => [], 'passkeys' => [], 'challenges' => []]));
    $s = start('ok', ['CALMIND_SITE_LIB' => $lib, 'CALMIND_SITE_CONFIG' => "$site/config.php", 'SUITE_DATA_DIR' => $site]);
    global $SERVERS;
    $SERVERS[array_key_last($SERVERS)]['extra'] = $site;
    register_shutdown_function(fn() => exec('rm -rf ' . escapeshellarg($site)));
    return [$s, $acfg];
}
function shared_account(array $acfg, string $user, string $email, string $password): void
{
    msa_lock($acfg, function () use ($acfg, $user, $email, $password) {
        $db = msa_store_read($acfg);
        $db['accounts'][$user] = ['email' => $email, 'hash' => password_hash($password, PASSWORD_BCRYPT), 'created' => time()];
        msa_store_write($acfg, $db);
    });
}
function shared_token(array $acfg, string $user): string
{
    $tok = bin2hex(random_bytes(32));
    msa_lock($acfg, function () use ($acfg, $tok, $user) {
        $db = msa_store_read($acfg);
        $db['sessions'][hash('sha256', $tok)] = ['user' => $user, 'device' => 'imported', 'created' => time(), 'last_seen' => time(), 'scope' => 'calmind', 'csrf' => bin2hex(random_bytes(32))];
        msa_store_write($acfg, $db);
    });
    return $tok;
}

t('shared: recover mails the shared store\'s address (never the legacy one); the code resets once and revokes every session', function () {
    $st = start_shared();
    if ($st === null) { echo "       SKIPPED (set CALMIND_SITE_LIB_TEST)\n"; return; }
    [$S, $acfg] = $st;
    // A legacy CalMind account of the same name with another address: shared mode must not read it.
    $legacy = store_read($S['cfg'], $S['data'] . '/accounts.json');
    $legacy['ana'] = ['email' => 'ana2@example.com', 'hash' => password_hash('legacy-pw-1', PASSWORD_DEFAULT), 'created' => time()];
    store_write($S['cfg'], $S['data'] . '/accounts.json', $legacy);
    shared_account($acfg, 'ana', 'ana@example.com', 'shared-pw-1');
    $imported = shared_token($acfg, 'ana');
    eq(200, call($S, ['action' => 'whoami'], $imported)['status'], 'an imported calmind token works');
    $r = call($S, ['action' => 'recover', 'username' => 'ANA']);
    $miss = call($S, ['action' => 'recover', 'username' => 'outsider']);
    eq([200, ['ok' => true]], [$r['status'], $r['body']]);
    eq($r['raw'], $miss['raw'], 'an unknown name answers byte for byte the same');
    eq(1, wait_to($S, 'ana@example.com', 1), 'mailed to the shared address');
    eq(0, delivered($S)['ana2@example.com'] ?? 0, 'never the legacy address');
    $code = code_from($S, 'ana@example.com');
    ok($code !== null, 'code in the mail');
    eq(403, call($S, ['action' => 'reset', 'username' => 'ana', 'code' => $code === '000000' ? '111111' : '000000', 'password' => 'reset-pw-1'])['status'], 'wrong code');
    $ok = call($S, ['action' => 'reset', 'username' => 'Ana', 'code' => $code, 'password' => 'reset-pw-1']);
    eq(200, $ok['status'], 'reset ' . $ok['raw']);
    eq(401, call($S, ['action' => 'whoami'], $imported)['status'], 'the imported token is revoked');
    eq(200, call($S, ['action' => 'whoami'], (string) $ok['body']['token'])['status'], 'the reset token works');
    eq(403, call($S, ['action' => 'reset', 'username' => 'ana', 'code' => $code, 'password' => 'reset-pw-2'])['status'], 'single use');
    eq(200, call($S, ['action' => 'login', 'username' => 'ana', 'password' => 'reset-pw-1'])['status'], 'the new password signs in');
    ok(password_verify('legacy-pw-1', store_read($S['cfg'], $S['data'] . '/accounts.json')['ana']['hash']), 'the legacy password is untouched (a rollback falls back to it)');

    // The per-username cap keys on the canonical name: three spellings are one account and get one allowance.
    throttle_reset($S);
    shared_account($acfg, 'bob', 'bob@example.com', 'shared-pw-2');
    foreach (['bob', 'BOB', 'Bob', 'bOb'] as $spelling) {
        call($S, ['action' => 'recover', 'username' => $spelling]);
        throttle_backdate($S, 61, ['a:']);
        usleep(250000);
    }
    usleep(1500000);
    eq(3, delivered($S)['bob@example.com'] ?? 0, 'three mails, not four, across spellings');
});

$pass = $fail = 0;
try {
foreach ($TESTS as [$label, $fn]) {
    if (getenv('ABUSE_ONLY') !== false && getenv('ABUSE_ONLY') !== '' && !str_contains($label, (string) getenv('ABUSE_ONLY'))) { continue; }
    try { $fn(); $pass++; echo "  ok   $label\n"; }
    catch (Throwable $e) { $fail++; echo "  FAIL $label\n       " . $e->getMessage() . "\n"; }
}
} finally { stop_all(); }
echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
