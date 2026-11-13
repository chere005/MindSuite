<?php
/**
 * A disposable fake SMTP server for the mail tests. Binds 127.0.0.1 on a free port,
 * never talks to anything else, and records what the client said.
 *
 *   php tools/fake-smtp.php OUTDIR MODE TLS [CERT.pem]
 *
 *   MODE  ok        accept the message
 *         authfail  answer every AUTH with 535
 *         hang      accept the connection, say nothing
 *         notls     do not offer STARTTLS (starttls mode only)
 *         noauth    offer TLS but no AUTH mechanism
 *         rcptfail  refuse the recipient with 550 (rcpt550 is the same)
 *         rcpt450   answer RCPT with 450 (a temporary refusal)
 *         rcpt251   answer RCPT with 251 (a success code the client must not take for 250)
 *         final550  accept the whole message, then answer the final dot with 550
 *         final451  ... with 451
 *         badcode   answer the final dot with "250queued" (a code with no separator)
 *         mixed     answer EHLO with a multi-line reply whose lines carry two codes
 *         nodata    after the 354 read nothing for a second, then close with the message unread (a reset)
 *         no8bit    do not advertise 8BITMIME
 *         drip      send the greeting a byte every 300 ms, never a newline (24 s)
 *         inject    put extra plaintext reply lines right behind the "220" to STARTTLS
 *         f_echo    refuse AUTH PLAIN with a 535 that echoes the client's blob and decoded user and password
 *         f_echo_login  the same for AUTH LOGIN (only LOGIN offered): echoes each base64 part and its decoding
 *         longline  answer the greeting with one 3000-byte reply line
 *         nonewline answer the greeting with 5000 bytes and no newline, then wait
 *         manylines answer the greeting with 500 continuation lines
 *         tls11     TLS 1.1 only (to prove the client refuses anything below 1.2)
 *   TLS   starttls  plain greeting, STARTTLS upgrade (the 587 shape)
 *         implicit  TLS from the first byte (the 465 shape)
 *         hangtls   implicit shape that never answers the TLS handshake
 *
 * OUTDIR gets `port` (written once listening) and `session.N` (one file per
 * connection: client lines, "<<DATA>>" then the raw message). Stop it with a signal.
 */
[$_, $out, $mode, $tls] = $argv + [null, '', 'ok', 'starttls'];
$cert = $argv[4] ?? '';
$srv = stream_socket_server('tcp://127.0.0.1:0', $en, $es);
if (!$srv) { fwrite(STDERR, "listen: $es\n"); exit(1); }
$port = (int) substr(strrchr(stream_socket_get_name($srv, false), ':'), 1);
if ($mode === 'nodata' && function_exists('socket_import_stream')) {      // a tiny receive buffer, so the client's write cannot all be swallowed
    $sock = socket_import_stream($srv);
    if ($sock) { socket_set_option($sock, SOL_SOCKET, SO_RCVBUF, 4096); }
}
file_put_contents($out . '/port.tmp', (string) $port);
rename($out . '/port.tmp', $out . '/port');

$n = 0;
while (true) {
    $c = @stream_socket_accept($srv, 3600);
    if (!$c) { continue; }
    $n++;
    $log = fopen($out . '/session.' . $n, 'w');
    $w = function (string $s) use ($c) { fwrite($c, $s . "\r\n"); };
    if ($mode === 'hang' || $tls === 'hangtls') { sleep(30); fclose($c); continue; }
    if ($mode === 'drip') {                              // a byte every 300 ms (faster than any smtp_timeout of 1 s, so no single read times out), no newline, for 24 s
        for ($i = 0; $i < 80; $i++) { if (@fwrite($c, '2') === false) { break; } usleep(300000); }
        fclose($log); fclose($c); continue;
    }
    stream_context_set_option($c, 'ssl', 'local_cert', $cert);
    stream_context_set_option($c, 'ssl', 'verify_peer', false);
    if ($mode === 'tls11') { stream_context_set_option($c, 'ssl', 'ciphers', 'ALL:@SECLEVEL=0'); }
    $up = function () use ($c, $mode): bool {
        return (bool) @stream_socket_enable_crypto($c, true, $mode === 'tls11' ? STREAM_CRYPTO_METHOD_TLSv1_1_SERVER : STREAM_CRYPTO_METHOD_TLS_SERVER);
    };
    $secure = false;
    if ($tls === 'implicit') {
        if (!$up()) { fwrite($log, "TLSFAIL\n"); fclose($log); fclose($c); continue; }
        $secure = true;
    }
    if ($mode === 'longline') { $w('220 ' . str_repeat('x', 3000)); sleep(2); fclose($log); fclose($c); continue; }
    if ($mode === 'nonewline') { fwrite($c, '220 ' . str_repeat('x', 5000)); sleep(10); fclose($log); fclose($c); continue; }
    if ($mode === 'manylines') { for ($i = 0; $i < 500; $i++) { $w('220-line ' . $i); } $w('220 done'); fclose($log); fclose($c); continue; }
    $w('220 fake.local ESMTP');
    while (($line = fgets($c, 4096)) !== false) {
        $line = rtrim($line, "\r\n");
        $u = strtoupper($line);
        $shown = $line;
        if (strncmp($u, 'AUTH PLAIN ', 11) === 0) {       // never record the secret itself, only whether it was the expected one
            $p = explode("\0", (string) base64_decode(substr($line, 11)));
            $shown = 'AUTH PLAIN user=' . ($p[1] ?? '') . ' pass=' . (($p[2] ?? '') === getenv('FAKE_SMTP_PASS') ? 'right' : 'wrong');
        }
        fwrite($log, $shown . "\n");
        if (strncmp($u, 'EHLO', 4) === 0) {
            if ($mode === 'mixed') { $w('250-fake.local'); $w('251 other'); continue; }
            $w('250-fake.local');
            if ($mode !== 'no8bit') { $w('250-8BITMIME'); }
            if (!$secure && $mode !== 'notls') { $w('250-STARTTLS'); }
            if ($secure && $mode !== 'noauth') { $w($mode === 'f_echo_login' ? '250-AUTH LOGIN' : '250-AUTH PLAIN LOGIN'); }
            $w('250 SIZE 1000000');
        } elseif ($u === 'STARTTLS') {
            if ($mode === 'inject') { fwrite($c, "220 go ahead\r\n250-evil\r\n250 AUTH PLAIN LOGIN\r\n"); }
            else { $w('220 go ahead'); }
            if (!$up()) { fwrite($log, "TLSFAIL\n"); break; }
            $secure = true;
        } elseif (strncmp($u, 'AUTH', 4) === 0) {
            if ($mode === 'authfail') { $w('535 5.7.8 authentication failed'); }
            elseif ($mode === 'f_echo' && strncmp($u, 'AUTH PLAIN ', 11) === 0) {
                $p = explode("\0", (string) base64_decode(substr($line, 11)));
                $w('535 5.7.8 bad credentials ' . substr($line, 11) . ' user=' . ($p[1] ?? '') . ' pass=' . ($p[2] ?? ''));
            } elseif ($u === 'AUTH LOGIN') {
                $w('334 VXNlcm5hbWU6'); $ub = trim((string) fgets($c, 4096)); $uu = base64_decode($ub);
                $w('334 UGFzc3dvcmQ6'); $pb = trim((string) fgets($c, 4096)); $pp = base64_decode($pb);
                fwrite($log, 'AUTH LOGIN user=' . trim($uu) . ' pass=' . (trim($pp) === getenv('FAKE_SMTP_PASS') ? 'right' : 'wrong') . "\n");
                if ($mode === 'f_echo_login') { $w('535 5.7.8 bad ' . $ub . ' ' . $pb . ' user=' . $uu . ' pass=' . $pp); }
                else { $w('235 ok'); }
            } else { $w('235 2.7.0 ok'); }
        } elseif (strncmp($u, 'MAIL FROM:', 10) === 0) { $w('250 ok'); }
        elseif (strncmp($u, 'RCPT TO:', 8) === 0) {
            if ($mode === 'rcptfail' || $mode === 'rcpt550') { $w('550 no such user'); }
            elseif ($mode === 'rcpt450') { $w('450 try again later'); }
            elseif ($mode === 'rcpt251') { $w('251 user not local; will forward'); }
            else { $w('250 ok'); }
        } elseif ($u === 'DATA') {
            $w('354 end with .');
            if ($mode === 'nodata') { fwrite($log, "<<CLOSED>>\n"); sleep(1); break; }       // never reads the message; closing with it unread resets the connection
            fwrite($log, "<<DATA>>\n");
            while (($d = fgets($c, 4096)) !== false) {
                if ($d === ".\r\n") { break; }
                fwrite($log, $d);
            }
            fwrite($log, "<<END>>\n");
            if ($mode === 'final550') { $w('550 5.7.1 message rejected'); }
            elseif ($mode === 'final451') { $w('451 4.3.0 try later'); }
            elseif ($mode === 'badcode') { $w('250queued'); }
            else { $w('250 queued'); }
        } elseif ($u === 'QUIT') { $w('221 bye'); break; }
        else { $w('500 what'); }
    }
    fclose($log);
    fclose($c);
}
