<?php
/**
 * The mail transport (lib/mail.php) against a disposable fake SMTP server
 * (tools/fake-smtp.php) on a free 127.0.0.1 port with a throwaway certificate.
 * No real mail server, ever. Canon owns this file; every consumer carries it
 * byte for byte next to lib/mail.php, tools/fake-smtp.php and
 * tools/mail-harness.php.
 *
 *   php server/tools/mail-test.php
 *
 * What an app sends through the transport is that app's own test, not this one.
 */
require_once dirname(__DIR__) . '/lib/mail.php';
require_once __DIR__ . '/mail-harness.php';

area('mail');

t('mail off (flag missing, false, "true", 1) opens no connection and logs the stub line', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        foreach ([null, false, 'true', 1, 'on'] as $v) {
            $c = $cfg;
            if ($v === null) { unset($c['mail_enabled']); } else { $c['mail_enabled'] = $v; }
            eq(false, mail_send($c, 'x@example.com', 'Subject', "body\n"));
        }
        usleep(300000);
        ok(!is_file("$dir/session.1"), 'a connection was made with mail off');
        eq(5, substr_count(mt_log($dir), 'would have emailed x@example.com: Subject'));
    });
});

t('STARTTLS then AUTH PLAIN, envelope sender is mail_from, message delivered', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        eq(true, mail_send($cfg, 'alex@example.com', 'Hello there', "line one\nline two\n"));
        $s = mt_session($dir);
        has("STARTTLS\n", $s);
        eq(2, substr_count($s, 'EHLO '), 'EHLO before and after STARTTLS');
        ok(strpos($s, 'STARTTLS') < strpos($s, 'AUTH PLAIN'), 'AUTH only after STARTTLS');
        has('AUTH PLAIN user=mailer@seancheren.com pass=right', $s);
        has('MAIL FROM:<no-reply@seancheren.com>', $s);
        has('RCPT TO:<alex@example.com>', $s);
        has("From: \"seancheren.com\" <no-reply@seancheren.com>\r\n", $s);
        has("To: <alex@example.com>\r\n", $s);
        has("Subject: Hello there\r\n", $s);
        ok(preg_match('/^Date: \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000\r$/m', $s) === 1, 'Date header');
        ok(preg_match('/^Message-ID: <[0-9a-f]{24}@seancheren\.com>\r$/m', $s) === 1, 'Message-ID header');
        has("line one\r\nline two\r\n", $s);
        has('mailed alex@example.com: Hello there', mt_log($dir));
        hasnt('hunter2', mt_log($dir) . $s, 'password in the log or on the wire record');
        hasnt('line one', mt_log($dir), 'body in the log');
    });
});

t('implicit TLS (port 465 shape) with AUTH, no STARTTLS command', function () {
    mt_with('ok', 'implicit', function ($cfg, $dir) {
        $cfg['smtp_implicit_tls'] = true;
        eq(true, mail_send($cfg, 'a@example.com', 'Implicit', "hi\n"));
        $s = mt_session($dir);
        hasnt('STARTTLS', $s);
        has('AUTH PLAIN user=mailer@seancheren.com pass=right', $s);
        has("hi\r\n", $s);
    });
});

t('AUTH failure is a clear logged false and the password never appears', function () {
    mt_with('authfail', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Nope', "secret body text\n"));
        $log = mt_log($dir);
        has('SMTP failed for a@example.com: Nope: auth: 535', $log);
        hasnt('hunter2', $log);
        hasnt('secret body text', $log);
        hasnt('MAIL FROM', mt_session($dir), 'went on to send after a failed login');
    });
});

t('a certificate nobody trusts is refused before any credentials are sent', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        unset($cfg['smtp_cafile']);                 // self-signed and not in the system store
        eq(false, mail_send($cfg, 'a@example.com', 'Untrusted', "x\n"));
        has('TLS failed', mt_log($dir));
        $s = mt_session($dir);
        hasnt('AUTH', $s);
        hasnt('MAIL FROM', $s);
    });
    mt_with('ok', 'implicit', function ($cfg, $dir) {
        unset($cfg['smtp_cafile']);
        $cfg['smtp_implicit_tls'] = true;
        eq(false, mail_send($cfg, 'a@example.com', 'Untrusted', "x\n"));
        has('TLS failed', mt_log($dir));
    });
});

t('a certificate for another host name is refused even when its CA is trusted', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Wrong name', "x\n"));
        has('TLS failed', mt_log($dir));
        hasnt('AUTH', mt_session($dir));
    }, 'other.example');
});

t('a server that offers no STARTTLS gets no password', function () {
    mt_with('notls', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Cleartext', "x\n"));
        has('does not offer STARTTLS', mt_log($dir));
        hasnt('AUTH', mt_session($dir));
    });
});

t('a server offering no AUTH mechanism fails cleanly', function () {
    mt_with('noauth', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'No auth', "x\n"));
        has('neither AUTH PLAIN nor AUTH LOGIN', mt_log($dir));
    });
});

t('timeouts: a silent server and a stalled TLS handshake both give up in bounded time', function () {
    mt_with('hang', 'starttls', function ($cfg, $dir) {
        $cfg['smtp_timeout'] = 1;
        $t = microtime(true);
        eq(false, mail_send($cfg, 'a@example.com', 'Hang', "x\n"));
        ok(microtime(true) - $t < 10, 'took ' . round(microtime(true) - $t, 1) . 's');
        has('SMTP failed', mt_log($dir));
    });
    mt_with('ok', 'hangtls', function ($cfg, $dir) {
        $cfg['smtp_timeout'] = 1;
        $cfg['smtp_implicit_tls'] = true;
        $t = microtime(true);
        eq(false, mail_send($cfg, 'a@example.com', 'Hang', "x\n"));
        ok(microtime(true) - $t < 10, 'took ' . round(microtime(true) - $t, 1) . 's');
        has('TLS failed', mt_log($dir));
    });
});

t('a refused recipient is false and logged', function () {
    mt_with('rcptfail', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Refused', "x\n"));
        has('550 no such user', mt_log($dir));
    });
});

t('header injection is refused before any connection is made', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $bad = [
            ["a@example.com\r\nBcc: evil@example.com", 'S', 'seancheren.com', 'no-reply@seancheren.com'],
            ["a@example.com\nRCPT TO:<evil@example.com>", 'S', 'seancheren.com', 'no-reply@seancheren.com'],
            ['a@example.com, b@example.com', 'S', 'seancheren.com', 'no-reply@seancheren.com'],
            ['Name <a@example.com>', 'S', 'seancheren.com', 'no-reply@seancheren.com'],
            ['"a b"@example.com', 'S', 'seancheren.com', 'no-reply@seancheren.com'],
            ["a@example.com", "Hi\r\nBcc: evil@example.com", 'seancheren.com', 'no-reply@seancheren.com'],
            ["a@example.com", "Hi\nX: y", 'seancheren.com', 'no-reply@seancheren.com'],
            ["a@example.com", "Hi\0there", 'seancheren.com', 'no-reply@seancheren.com'],
            ["a@example.com", 'S', "Alex\r\nBcc: evil@example.com", 'no-reply@seancheren.com'],
            ["a@example.com", 'S', 'seancheren.com', "no-reply@seancheren.com\r\nBcc: evil@example.com"],
            ["a@example.com", 'S', 'seancheren.com', 'no-reply@seancheren.com>\r\nX: y'],
        ];
        foreach ($bad as [$to, $subj, $name, $from]) {
            $c = $cfg; $c['mail_from_name'] = $name; $c['mail_from'] = $from;
            eq(false, mail_send($c, $to, $subj, "body\n"), 'accepted: ' . json_encode([$to, $subj, $name, $from]));
        }
        usleep(300000);
        ok(!is_file("$dir/session.1"), 'a connection was made for an injection attempt');
        hasnt("\nBcc", mt_log($dir), 'log line forged');
        eq(count($bad), substr_count(mt_log($dir), 'refused'));
    });
});

t('injection through SMTP credentials and the HELO name is refused', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        foreach (['smtp_user' => "u\r\nMAIL FROM:<x@x>", 'smtp_pass' => "p\r\nQUIT", 'smtp_host' => "localhost\r\nX"] as $k => $v) {
            $c = $cfg; $c[$k] = $v;
            eq(false, mail_send($c, 'a@example.com', 'S', "b\n"), $k);
        }
        ok(!is_file("$dir/session.1"), 'a connection was made');
    });
});

t('a body with leading dots is dot-stuffed and arrives intact', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $body = ".\n..x\n.hidden\nmid . dot\n.\nlast";
        eq(true, mail_send($cfg, 'a@example.com', 'Dots', $body));
        $s = mt_session($dir);
        $msg = substr($s, strpos($s, "<<DATA>>\n") + 9);
        $msg = substr($msg, 0, strpos($msg, "<<END>>"));
        $payload = substr($msg, strpos($msg, "\r\n\r\n") + 4);
        eq("..\r\n...x\r\n..hidden\r\nmid . dot\r\n..\r\nlast\r\n", $payload);
        // Undoing the stuffing, as a receiving server does, gives the original text back.
        eq(".\r\n..x\r\n.hidden\r\nmid . dot\r\n.\r\nlast\r\n", preg_replace('/^\.\./m', '.', $payload));
    });
});

t('a non-ASCII subject and body are encoded and decode back', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $subject = 'Café Zürich — 日本語のとても長い件名がここに入ります、折り返しも確認します。' . str_repeat('ü', 30);
        $cfg['mail_from_name'] = 'Álex Éxample';
        eq(true, mail_send($cfg, 'a@example.com', $subject, "Grüße, 日本\n"));
        $s = mt_session($dir);
        has('=?UTF-8?B?', $s);
        $msg = substr($s, strpos($s, "<<DATA>>\n") + 9);
        $headers = substr($msg, 0, strpos($msg, "\r\n\r\n"));
        ok(preg_match('/^Subject: (.*?)\r\n(?!\s)/ms', $headers . "\r\n", $m) === 1, 'subject header');
        eq($subject, iconv_mime_decode('Subject: ' . $m[1], 0, 'UTF-8') === false ? '' : substr(iconv_mime_decode('Subject: ' . $m[1], 0, 'UTF-8'), 9));
        has('=?UTF-8?B?', substr($headers, strpos($headers, 'From:'), 80), 'display name encoded');
        has('Content-Type: text/plain; charset=utf-8', $headers);
        has('Content-Transfer-Encoding: 8bit', $headers);   // the fake advertises 8BITMIME
        has("Grüße, 日本\r\n", $msg);
        foreach (explode("\r\n", $headers) as $l) { ok(strlen($l) <= 78, 'header line too long: ' . strlen($l)); }
    });
});

t('without 8BITMIME or with a very long line the body goes out quoted-printable', function () {
    $m = mail_build('a@example.com', 'S', "Grüße\n", 'no-reply@seancheren.com', 'x', 'seancheren.com', false);
    has('Content-Transfer-Encoding: quoted-printable', $m);
    hasnt('ü', $m);
    $m = mail_build('a@example.com', 'S', str_repeat('x', 1200) . "\n", 'no-reply@seancheren.com', 'x', 'seancheren.com', true);
    has('Content-Transfer-Encoding: quoted-printable', $m);
    foreach (explode("\r\n", $m) as $l) { ok(strlen($l) <= 998); }
    $m = mail_build('a@example.com', 'S', "plain\n", 'no-reply@seancheren.com', 'x', 'seancheren.com', true);
    has('Content-Transfer-Encoding: 7bit', $m);
});

t('enabled with no smtp_host sends nothing and says so', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $cfg['smtp_host'] = '';
        eq(false, mail_send($cfg, 'a@example.com', 'S', "b\n"));
        has('smtp_host is not set', mt_log($dir));
        ok(!is_file("$dir/session.1"));
    });
});

t('missing SMTP credentials fail before connecting', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        foreach (['smtp_user', 'smtp_pass'] as $key) {
            $c = $cfg; $c[$key] = '';
            eq(false, mail_send($c, 'a@example.com', 'S', "b\n"));
        }
        ok(!is_file("$dir/session.1"));
    });
});

// ---------------------------------------------------------------- hardening: one test per finding and per defence

/** The data between "<<DATA>>" and "<<END>>" in a fake-server session record. */
function mt_data(string $session): string
{
    $m = substr($session, (int) strpos($session, "<<DATA>>\n") + 9);
    $e = strpos($m, '<<END>>');
    return $e === false ? $m : substr($m, 0, $e);
}

t('[deadline] a server dripping a byte every 300 ms cannot hold the send past the overall deadline', function () {
    mt_with('drip', 'starttls', function ($cfg, $dir) {
        $cfg['smtp_timeout'] = 1;                      // overall deadline 6 s; the drip server keeps going for 24 s
        $t = microtime(true);
        eq(false, mail_send($cfg, 'a@example.com', 'Drip', "x\n"));
        $el = microtime(true) - $t;
        ok($el < 10, 'a dripping server held the send for ' . round($el, 1) . ' s');
        has('SMTP failed', mt_log($dir));
        has('timed out', mt_log($dir));
    });
});

t('[deadline] mail_deadline is six steps out, and short of max_execution_time when the SAPI has one', function () {
    eq(160.0, mail_deadline(100.0, 10, 0, 100.0), 'CLI, no limit');
    eq(106.0, mail_deadline(100.0, 1, 0, 100.0));
    eq(127.0, mail_deadline(100.0, 10, 30, 100.0), 'web: request began at 100 with a 30 s limit: 100 + 30 - 3');
    eq(106.0, mail_deadline(100.0, 1, 30, 100.0), 'the step bound wins when it is sooner');
    eq(129.0, mail_deadline(128.0, 10, 30, 100.0), 'late in the request there is still one second');
});

t('[reply] an over-long reply line and a flood of reply lines are refused', function () {
    mt_with('longline', 'starttls', function ($cfg, $dir) {                  // a whole line, longer than the cap
        eq(false, mail_send($cfg, 'a@example.com', 'Long', "x\n"));
        has('reply line too long', mt_log($dir));
    });
    mt_with('nonewline', 'starttls', function ($cfg, $dir) {                 // never ends: refused at the cap, not at the deadline
        $t = microtime(true);
        eq(false, mail_send($cfg, 'a@example.com', 'Endless', "x\n"));
        has('reply line too long', mt_log($dir));
        ok(microtime(true) - $t < 3, 'waited for the deadline instead of refusing the endless line');
    });
    mt_with('manylines', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Many', "x\n"));
        has('reply too long', mt_log($dir));
    });
});

t('[reply] a malformed code, or lines of one reply with two codes, is not a reply', function () {
    mt_with('badcode', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Bad', "x\n"), '"250queued" taken for a 250');
        has('not an SMTP reply', mt_log($dir));
    });
    mt_with('mixed', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Mixed', "x\n"));
        has('different codes', mt_log($dir));
    });
});

t('[reply] only an exact 250 accepts RCPT: 450, 550 and 251 all fail', function () {
    foreach (['rcpt450' => '450', 'rcpt550' => '550', 'rcpt251' => '251'] as $mode => $code) {
        mt_with($mode, 'starttls', function ($cfg, $dir) use ($code, $mode) {
            eq(false, mail_send($cfg, 'a@example.com', 'Rcpt', "x\n"), $mode);
            has($code, mt_log($dir), $mode);
            hasnt('<<DATA>>', mt_session($dir), "$mode went on to DATA");
        });
    }
});

t('[reply] the answer to the final dot is checked: 550 and 451 are failures, not sent', function () {
    foreach (['final550' => '550', 'final451' => '451'] as $mode => $code) {
        mt_with($mode, 'starttls', function ($cfg, $dir) use ($code, $mode) {
            eq(false, mail_send($cfg, 'a@example.com', 'Final', "x\n"), $mode);
            has("SMTP failed for a@example.com: Final: $code", mt_log($dir), $mode);
            hasnt('mailed a@example.com', mt_log($dir), $mode);
        });
    }
});

t('[write] a connection reset while the message is going out is a write failure', function () {
    // The fake reads nothing, then closes with the message unread (a reset). smtp_send() is called directly with
    // a message far bigger than any socket buffer (mail_send() would refuse it at 256 KiB), so the write has to wait
    // and then fail; a few tries in case the stack absorbed it anyway.
    $seen = false;
    for ($try = 0; $try < 4 && !$seen; $try++) {
        mt_with('nodata', 'starttls', function ($cfg, $dir) use (&$seen) {
            $body = str_repeat(str_repeat('x', 70) . "\n", 60000);      // 4.2 MB
            $err = '';
            eq(false, smtp_send($cfg, 'a@example.com', 'Closed', $body, 'no-reply@seancheren.com', 'x', $err));
            $seen = strpos($err, 'write failed') !== false;
        });
    }
    ok($seen, 'four resets in a row and the transport never reported a write failure');
});

t('[starttls] plaintext slipped in behind the 220 to STARTTLS is refused before TLS starts', function () {
    mt_with('inject', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Inject', "x\n"));
        has('unexpected data after the STARTTLS reply', mt_log($dir));
        hasnt('AUTH', mt_session($dir), 'credentials sent after an injected capability list');
    });
});

t('[scrub] a server echoing the AUTH blob, user and password leaves none of them in the log', function () {
    $blob = base64_encode("\0mailer@seancheren.com\0hunter2-secret");
    mt_with('f_echo', 'starttls', function ($cfg, $dir) use ($blob) {
        eq(false, mail_send($cfg, 'a@example.com', 'Echo', "x\n"));
        $log = mt_log($dir);
        has('SMTP failed for a@example.com: Echo: auth: 535', $log);
        foreach ([$blob, rtrim($blob, '='), 'hunter2-secret', 'mailer@seancheren.com', base64_encode('hunter2-secret')] as $leak) {
            hasnt($leak, $log, 'the log holds ' . $leak);
        }
        has('***', $log);
    });
    mt_with('f_echo_login', 'starttls', function ($cfg, $dir) {
        eq(false, mail_send($cfg, 'a@example.com', 'Echo', "x\n"));
        $log = mt_log($dir);
        has('auth: 535', $log);
        foreach ([base64_encode('mailer@seancheren.com'), base64_encode('hunter2-secret'), 'hunter2-secret', 'mailer@seancheren.com'] as $leak) {
            hasnt($leak, $log, 'the log holds ' . $leak);
        }
    });
});

t('[scrub] mail_scrub and mail_log take out secrets of any length in every encoding', function () {
    $cfg = ['data_dir' => sys_get_temp_dir(), 'smtp_user' => 'u', 'smtp_pass' => 'p'];
    $forms = ['u', 'p', base64_encode("\0u\0p"), base64_encode('u'), base64_encode('p'), rtrim(base64_encode("\0u\0p"), '=')];
    foreach ($forms as $f) {
        $out = mail_scrub($cfg, "535 bad [$f] end");
        hasnt($f, $out, 'form ' . $f);
        has('***', $out);
    }
    $out = mail_scrub(['smtp_user' => 'alice@example.com', 'smtp_pass' => 'hunter2'], 'x ' . base64_encode("\0alice@example.com\0hunter2") . ' y alice@example.com hunter2 ' . base64_encode('hunter2'));
    eq('x *** y *** *** ***', $out);
    // The log: the password in any form never lands in a line; the user name is kept (a recipient may be the account's own address).
    $dir = sys_get_temp_dir() . '/mailscrub-' . getmypid() . '-' . bin2hex(random_bytes(3));
    mkdir($dir, 0700, true);
    $c = ['data_dir' => $dir, 'smtp_user' => 'alice@example.com', 'smtp_pass' => 'hunter2'];
    mail_log($c, 'mailed alice@example.com: pw hunter2 b64 ' . base64_encode('hunter2'));
    $log = mt_log($dir);
    exec('rm -rf ' . escapeshellarg($dir));
    hasnt('hunter2', $log);
    hasnt(base64_encode('hunter2'), $log);
    has('mailed alice@example.com', $log);
});

t('[scrub] mail_log flattens control characters so a value cannot forge a line', function () {
    $dir = sys_get_temp_dir() . '/maillog-' . getmypid() . '-' . bin2hex(random_bytes(3));
    mkdir($dir, 0700, true);
    mail_log(['data_dir' => $dir], "first\r\n2026-01-01T00:00:00+00:00 forged line\x00\x1b[31m");
    $log = mt_log($dir);
    exec('rm -rf ' . escapeshellarg($dir));
    eq(1, substr_count($log, "\n"), 'one line only');
    ok(preg_match('/[\x00-\x09\x0b-\x1f\x7f]/', $log) !== 1, 'a control character reached the log');
    has('first', $log);
    $s = mail_scrub(['smtp_user' => 'x', 'smtp_pass' => 'y'], "a\nb\x00c");
    ok(preg_match('/[\x00-\x1f\x7f]/', $s) !== 1, 'mail_scrub left a control character');
});

t('[limits] a body over 256 KiB, an over-long subject or sender name is refused and logged without the body', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $big = str_repeat('BODYMARK ', 29100);                       // 261900 bytes: just under the limit
        eq(true, mail_send($cfg, 'a@example.com', 'Big but fine', $big));
        $log = mt_log($dir);
        $before = substr_count($log, "\n");
        $over = str_repeat('BODYMARK ', 29100) . str_repeat('x', MAIL_MAX_BODY - strlen($big) + 1);
        eq(MAIL_MAX_BODY + 1, strlen($over));
        eq(false, mail_send($cfg, 'a@example.com', 'Too big', $over));
        eq(false, mail_send($cfg, 'a@example.com', str_repeat('s', 256), "x\n"));
        $c = $cfg; $c['mail_from_name'] = str_repeat('n', 256);
        eq(false, mail_send($c, 'a@example.com', 'Name', "x\n"));
        $log = mt_log($dir);
        eq(3, substr_count($log, 'refused'), 'three refusals logged');
        has('over the 262144 byte limit', $log);
        hasnt('BODYMARK', $log, 'the body reached the log');
        ok(!is_file("$dir/session.2"), 'a connection was made for an oversize message');
        $c = $cfg; $c['smtp_pass'] = str_repeat('p', 256);
        eq(false, mail_send($c, 'a@example.com', 'Pass', "x\n"));
        ok(!is_file("$dir/session.2"), 'a connection was made with an oversize credential');
    });
});

t('[tls] only TLS 1.2 and 1.3 are negotiated: the method excludes 1.1, and a 1.1-only server is refused', function () {
    $m = mail_tls_method();
    eq(STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT, $m);
    mt_with('tls11', 'starttls', function ($cfg, $dir) {
        // Control: the fake really speaks 1.1, so the refusal below is the client's doing.
        $ctx = stream_context_create(['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'ciphers' => 'ALL:@SECLEVEL=0', 'security_level' => 0]]);
        $fp = stream_socket_client('tcp://localhost:' . $cfg['smtp_port'], $en, $es, 3, STREAM_CLIENT_CONNECT, $ctx);
        ok((bool) $fp, 'control connect');
        fgets($fp); fwrite($fp, "EHLO x\r\n");
        while (($l = fgets($fp)) !== false && ($l[3] ?? ' ') === '-');
        fwrite($fp, "STARTTLS\r\n"); fgets($fp);
        ok(@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT) === true, 'control: the fake does not speak TLS 1.1');
        fclose($fp);
        eq(false, mail_send($cfg, 'a@example.com', 'Old TLS', "x\n"));
        has('TLS failed', mt_log($dir));
        hasnt('AUTH', mt_session($dir, 2));
    });
});

t('[tls] a host name with a trailing dot is verified as the name without it', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $cfg['smtp_host'] = 'localhost.';
        eq(true, mail_send($cfg, 'a@example.com', 'Dot', "x\n"));
        has('AUTH PLAIN user=mailer@seancheren.com pass=right', mt_session($dir));
    });
});

t('[addr] the address shape allows no angle brackets, quotes, spaces or trailing newline; the validator also stops ".." and bad domains', function () {
    foreach (['<a@example.com>', 'a<b@example.com', 'a>b@example.com', 'a@example.com>', "a@example.com\n", "a@example.com\r\n", 'a b@example.com', '"a"@example.com', 'a@exa mple.com', '', str_repeat('a', 250) . '@example.com'] as $bad) {
        eq(false, mail_addr_shape($bad), 'shape accepted ' . json_encode($bad));
        eq(false, mail_addr_ok($bad), 'accepted ' . json_encode($bad));
    }
    foreach (['a..b@example.com', '.a@example.com', 'a.@example.com', 'a@example..com', 'a@-example.com', 'a@example', 'a@.example.com'] as $bad) {
        eq(true, mail_addr_shape($bad), 'the shape layer is expected to pass ' . json_encode($bad));
        eq(false, mail_addr_ok($bad), 'the validator let through ' . json_encode($bad));
    }
    foreach (['a@example.com', 'first.last+tag@sub.example.co', "o'brien@example.com"] as $good) { eq(true, mail_addr_ok($good), $good); }
});

t('[addr] mail_header_text encodes a value with a trailing newline instead of passing it as plain ASCII', function () {
    has('=?UTF-8?B?', mail_header_text("Hi\n"));
    eq('Hi', mail_header_text('Hi'));
});

t('[port] port 465 is implicit TLS by itself; any other port only when asked', function () {
    eq(true, mail_implicit_tls(['smtp_port' => 465]));
    eq(true, mail_implicit_tls(['smtp_port' => '465']));
    eq(false, mail_implicit_tls(['smtp_port' => 587]));
    eq(false, mail_implicit_tls([]));
    eq(false, mail_implicit_tls(['smtp_port' => 2525, 'smtp_implicit_tls' => 'yes']));
    eq(true, mail_implicit_tls(['smtp_port' => 2525, 'smtp_implicit_tls' => true]));
});

t('[build] NUL bytes are stripped from the body', function () {
    $m = mail_build('a@example.com', 'S', "ab\0cd\n", 'no-reply@seancheren.com', 'x', 'seancheren.com', true);
    hasnt("\0", $m);
    has("abcd\r\n", $m);
});

t('[helo] a smtp_helo with a control character falls back to the sender domain and injects nothing', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $cfg['smtp_helo'] = "evil.example\r\nMAIL FROM:<x@x>";
        eq(true, mail_send($cfg, 'a@example.com', 'Helo', "x\n"));
        $s = mt_session($dir);
        eq(2, substr_count($s, 'EHLO seancheren.com'), 'fell back to the sender domain');
        hasnt('evil.example', $s);
        hasnt('MAIL FROM:<x@x>', $s);
    });
});

t('[8bit] 8bit goes out only when the server advertised 8BITMIME', function () {
    mt_with('no8bit', 'starttls', function ($cfg, $dir) {
        eq(true, mail_send($cfg, 'a@example.com', 'Eight', "Grüße\n"));
        $d = mt_data(mt_session($dir));
        has('Content-Transfer-Encoding: quoted-printable', $d);
        hasnt('ü', $d);
    });
});

t('[never-throws] a warning turned into an exception inside the transport still ends in false', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $srv = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr(stream_socket_get_name($srv, false), ':'), 1);
        fclose($srv);                                              // nothing listens on $port now
        $cfg['smtp_host'] = '127.0.0.1';
        $cfg['smtp_port'] = $port;
        set_error_handler(function ($no, $str) { throw new ErrorException($str, 0, $no); });
        try { $r = mail_send($cfg, 'a@example.com', 'Refused', "x\n"); } finally { restore_error_handler(); }
        eq(false, $r);
        has('SMTP failed', mt_log($dir));
    });
});


mt_run();
