<?php
/**
 * Sending mail — OFF unless the instance's config says `'mail_enabled' => true`.
 *
 * With the flag off (the default, and what every instance is today) mail_send()
 * is the old stub: one line "would have emailed …" in data/mail.log, return
 * false, and NOT A SINGLE SOCKET opened. Turning mail on is a host's decision
 * made by the owner, never a side effect of a fix: it is one flag in the instance's
 * server config, set on the host by hand through that instance's own tool.
 *
 * With the flag on, mail_send() talks authenticated SMTP to smtp_host:
 * STARTTLS on 587 (any port but 465) or implicit TLS on 465, certificate AND
 * host name verified (there is no switch to turn that off; a private CA goes
 * in `smtp_cafile`), AUTH PLAIN or LOGIN only after TLS, the envelope sender
 * equal to mail_from. There is no mail() fallback: an unauthenticated hand-off
 * to the host's sendmail is how a code ends up silently discarded.
 *
 * Config keys: mail_enabled (bool, strictly true), smtp_host, smtp_port (587),
 * smtp_user, smtp_pass, mail_from, mail_from_name, and optionally smtp_helo,
 * smtp_timeout (seconds, default 10: the connect step; the WHOLE send, reads,
 * writes and TLS included, is bounded by six times it, and by what is left of
 * the SAPI's max_execution_time), smtp_cafile (a private CA, for tests),
 * smtp_implicit_tls (true = TLS from the first byte on a port other than 465).
 * TLS is 1.2 or 1.3 only. Limits: body 256 KiB, subject and display name 255
 * bytes, host, user, password and HELO name 255 bytes; over a limit the send
 * is refused and logged without the body.
 *
 * This is the CoreMind canon copy. CalMind carries it byte for byte
 * (server/lib/mail.php, an `exact` row); seancheren-site keeps the same file
 * in lib/mail.php (a check-only consumer, not a CoreMind clone: it copies and
 * proves canon in its own repo, by hand). The transport below the "transport" rule is the
 * whole file's behaviour; a change lands in canon first, then in both.
 *
 * Never logged: the password in ANY encoding (plain, the base64 of the AUTH blob
 * or of each LOGIN step), the user name in a failure reason, the message body.
 * mail.log gets the recipient, the subject and the failure reason, nothing else.
 */

// ------------------------------------------------------------ transport (identical in both copies)

/** Largest body, in bytes, mail_send() takes; the reset codes and replies it carries are a few lines. */
const MAIL_MAX_BODY = 262144;
/** Largest subject, display name, host, user, password or HELO name, in bytes. */
const MAIL_MAX_FIELD = 255;
/** One reply from the server: at most this many bytes a line, lines, bytes in all. */
const MAIL_MAX_REPLY_LINE = 2048;
const MAIL_MAX_REPLY_LINES = 64;
const MAIL_MAX_REPLY_BYTES = 16384;

/** True only when the config says so, in so many words. */
function mail_enabled(array $cfg): bool
{
    return ($cfg['mail_enabled'] ?? false) === true;
}

/**
 * Send one plain-text message to one recipient. Returns true only if the
 * server accepted it for delivery. Disabled, malformed or failed: false, one
 * line in data/mail.log, never an exception.
 */
function mail_send(array $cfg, string $to, string $subject, string $body): bool
{
    if (!mail_enabled($cfg)) {
        mail_log($cfg, "would have emailed $to: $subject");
        return false;
    }
    $from = (string) ($cfg['mail_from'] ?? 'no-reply@seancheren.com');
    $name = (string) ($cfg['mail_from_name'] ?? 'seancheren.com');
    if (!mail_addr_ok($to))   { mail_log($cfg, 'refused: recipient is not a plain address'); return false; }
    if (!mail_addr_ok($from)) { mail_log($cfg, 'refused: mail_from is not a plain address'); return false; }
    if (!mail_header_ok($subject) || !mail_header_ok($name)) {
        mail_log($cfg, "refused for $to: a header value holds a line break or control character");
        return false;
    }
    if (strlen($subject) > MAIL_MAX_FIELD || strlen($name) > MAIL_MAX_FIELD) {
        mail_log($cfg, "refused for $to: the subject or sender name is over " . MAIL_MAX_FIELD . ' bytes');
        return false;
    }
    if (strlen($body) > MAIL_MAX_BODY) {
        mail_log($cfg, "refused for $to: the body is " . strlen($body) . ' bytes, over the ' . MAIL_MAX_BODY . ' byte limit');
        return false;
    }
    if (trim((string) ($cfg['smtp_host'] ?? '')) === '') {
        mail_log($cfg, "mail_enabled is on but smtp_host is not set; nothing sent to $to");
        return false;
    }
    $err = '';
    try {
        $sent = smtp_send($cfg, $to, $subject, $body, $from, $name, $err);
    } catch (Throwable $e) {                                   // a transport fault is a false, never a fatal in the page
        $sent = false;
        $err = 'internal error: ' . get_class($e);
    }
    if ($sent) {
        mail_log($cfg, "mailed $to: $subject");
        return true;
    }
    mail_log($cfg, "SMTP failed for $to: $subject: " . mail_scrub($cfg, $err));
    return false;
}

/** One line in data/mail.log. Control characters are flattened so a value cannot forge a second line; the credentials never get in. */
function mail_log(array $cfg, string $line): void
{
    $line = mail_secrets_out($cfg, $line, false);       // the password in any form; a recipient may be the account's own address
    $line = preg_replace('/[\x00-\x1f\x7f]+/', ' ', $line) ?? '';
    @file_put_contents(rtrim((string) $cfg['data_dir'], '/') . '/mail.log',
                       date('c') . ' ' . $line . "\n", FILE_APPEND);
}

/**
 * Every form the password (and, with $user, the user name) can take on the wire
 * or in a server's echo: plain, and the base64 of what AUTH sends (the PLAIN
 * blob, each LOGIN step), with and without padding. Longest first, so a blob
 * goes before the parts inside it.
 */
function mail_secret_forms(array $cfg, bool $user = true): array
{
    $u = (string) ($cfg['smtp_user'] ?? '');
    $p = (string) ($cfg['smtp_pass'] ?? '');
    $raw = [$p, "\0$u\0$p", "$u\0$p", "$u:$p"];
    if ($user) { $raw[] = $u; }
    $forms = [];
    foreach ($raw as $r) {
        if (trim($r, "\0:") === '') { continue; }
        $b = base64_encode($r);
        array_push($forms, $r, $b, rtrim($b, '='));
    }
    $forms = array_values(array_unique(array_filter($forms, fn($f) => $f !== '')));
    usort($forms, fn($x, $y) => strlen($y) <=> strlen($x));
    return $forms;
}

/** The text with the password (and user name) in every encoding and of any length replaced by ***. */
function mail_secrets_out(array $cfg, string $s, bool $user = true): string
{
    foreach (mail_secret_forms($cfg, $user) as $f) { $s = str_replace($f, '***', $s); }
    return $s;
}

/** A failure reason fit for the log: one line, bounded, with the password and user name taken out. */
function mail_scrub(array $cfg, string $s): string
{
    $s = mail_secrets_out($cfg, $s);
    $s = preg_replace('/[\x00-\x1f\x7f]+/', ' ', $s) ?? '';
    return substr($s, 0, 300);
}

/** The shape of a bare ASCII address: no display name, no list, no quoting, no control characters, spaces or angle brackets. */
function mail_addr_shape(string $a): bool
{
    return strlen($a) <= 254
        && preg_match('/^[A-Za-z0-9.!#$%&\'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/D', $a) === 1;
}

/** A bare address that has the right shape AND passes PHP's address validator (no "..", no leading dot, a real domain). */
function mail_addr_ok(string $a): bool
{
    return mail_addr_shape($a) && filter_var($a, FILTER_VALIDATE_EMAIL) !== false;
}

/** A header value (or SMTP credential) with no CR, LF, NUL or other control character. */
function mail_header_ok(string $v): bool
{
    return preg_match('/[\x00-\x1f\x7f]/', $v) !== 1;
}

/** TLS from the first byte: always on 465, and on any other port only when the config says so. */
function mail_implicit_tls(array $cfg): bool
{
    return (int) ($cfg['smtp_port'] ?? 587) === 465 || ($cfg['smtp_implicit_tls'] ?? false) === true;
}

/** The only TLS versions the client will negotiate: 1.2 and 1.3 (never SSLv3, 1.0 or 1.1, whatever the system's OpenSSL allows). */
function mail_tls_method(): int
{
    return STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT;
}

/**
 * The moment the whole send must be over: $step * 6 seconds from $now, and,
 * when the SAPI has a max_execution_time ($limit > 0, $started = when the
 * request began), no later than 3 seconds short of it, so the answer is false
 * and not a fatal. Never less than 1 second from now.
 */
function mail_deadline(float $now, int $step, int $limit, float $started): float
{
    $end = $now + max(1, $step) * 6;
    if ($limit > 0) { $end = min($end, $started + $limit - 3); }
    return max($end, $now + 1);
}

/** RFC 2047 encoded words ("=?UTF-8?B?…?="), each at most 36 raw bytes, never splitting a character. */
function mail_encode_words(string $s): string
{
    $words = [];
    $cur = '';
    foreach (preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $ch) {
        if (strlen($cur) + strlen($ch) > 36) { $words[] = $cur; $cur = ''; }
        $cur .= $ch;
    }
    if ($cur !== '') { $words[] = $cur; }
    return implode("\r\n ", array_map(fn($w) => '=?UTF-8?B?' . base64_encode($w) . '?=', $words));
}

/** A subject or display name as a header value: as is when plain ASCII, encoded words otherwise. */
function mail_header_text(string $s): string
{
    if ($s === '') { return ''; }
    if (preg_match('/^[\x20-\x7e]*$/D', $s) === 1) { return $s; }
    if (!mb_check_encoding($s, 'UTF-8')) { $s = mb_convert_encoding($s, 'UTF-8', 'UTF-8'); }
    return mail_encode_words($s);
}

/**
 * The whole message, headers and body, CRLF throughout, dot-stuffed, ready to
 * follow DATA (the terminating "." line is added by the caller).
 */
function mail_build(string $to, string $subject, string $body, string $from, string $name,
                    string $helo, bool $eightbit): string
{
    $body = str_replace("\0", '', $body);
    $body = (string) preg_replace('/\r\n|\r|\n/', "\r\n", $body);
    if ($body === '' || substr($body, -2) !== "\r\n") { $body .= "\r\n"; }

    $ascii = preg_match('/^[\x00-\x7f]*$/D', $body) === 1;
    $long  = false;
    foreach (explode("\r\n", $body) as $line) { if (strlen($line) > 998) { $long = true; break; } }
    if ($ascii && !$long)    { $cte = '7bit'; }
    elseif ($eightbit && !$long) { $cte = '8bit'; }
    else {
        $cte  = 'quoted-printable';
        $body = quoted_printable_encode($body);
        $body = (string) preg_replace('/\r\n|\r|\n/', "\r\n", $body);
    }

    $display = mail_header_text($name);
    if ($display !== '' && substr($display, 0, 2) !== '=?') {
        $display = '"' . addcslashes($display, "\"\\") . '"';
    }
    $head = [
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'From: ' . ($display !== '' ? $display . ' ' : '') . '<' . $from . '>',
        'To: <' . $to . '>',
        'Subject: ' . mail_header_text($subject),
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $helo . '>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: ' . $cte,
    ];
    $msg = implode("\r\n", $head) . "\r\n\r\n" . $body;
    // A lone dot on a line ends DATA, so every line that starts with one gets a second.
    return (string) preg_replace('/^\./m', '..', $msg);
}

/**
 * One SMTP conversation: greet, (STARTTLS), AUTH, then the message. Hand-rolled
 * because the suite has no dependencies and this is all the protocol we need.
 * Credentials are sent only inside TLS 1.2 or newer. Every read and write is
 * non-blocking and waits with stream_select() on what is LEFT of one overall
 * deadline, so a server that drips a byte a second cannot hold the request
 * past it. $err gets a one-line reason on failure; the answer is false, never
 * an exception, on every failure including a timeout.
 */
function smtp_send(array $cfg, string $to, string $subject, string $body,
                   string $from, string $name, string &$err = ''): bool
{
    $host = (string) ($cfg['smtp_host'] ?? '');
    $port = (int) ($cfg['smtp_port'] ?? 587);
    $user = (string) ($cfg['smtp_user'] ?? '');
    $pass = (string) ($cfg['smtp_pass'] ?? '');
    $step = max(1, (int) ($cfg['smtp_timeout'] ?? 10));
    $now = microtime(true);
    $deadline = mail_deadline($now, $step, (int) ini_get('max_execution_time'),
                              (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? $now));
    $implicit = mail_implicit_tls($cfg);
    $result = (function () use ($cfg, $to, $subject, $body, $from, $name, &$err, $host, $port, $user, $pass, $step, $deadline, $implicit): bool {
        if ($user === '' || $pass === '') {
            $err = 'smtp credentials are missing';
            return false;
        }
        if (!mail_header_ok($host) || !mail_header_ok($user) || !mail_header_ok($pass)) {
            $err = 'smtp settings hold a control character';
            return false;
        }
        if (strlen($host) > MAIL_MAX_FIELD || strlen($user) > MAIL_MAX_FIELD || strlen($pass) > MAIL_MAX_FIELD) {
            $err = 'smtp settings are over ' . MAIL_MAX_FIELD . ' bytes';
            return false;
        }

        $peer = strtolower(rtrim($host, '.'));                  // the name the certificate must carry ("mail.example.com." is mail.example.com)
        $ssl = ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $peer,
                'SNI_enabled' => true, 'SNI_server_name' => $peer, 'allow_self_signed' => false,
                'disable_compression' => true];
        if (!empty($cfg['smtp_cafile'])) { $ssl['cafile'] = (string) $cfg['smtp_cafile']; }
        $ctx = stream_context_create(['ssl' => $ssl]);
        // Resolve once and connect to that address; the certificate is still checked against the NAME (peer_name), not the address.
        $addr = filter_var($host, FILTER_VALIDATE_IP) !== false ? $host : gethostbyname($host);
        if ($addr === '' || $addr === $host) { $addr = $host; }
        if (strpos($addr, ':') !== false && $addr[0] !== '[') { $addr = '[' . $addr . ']'; }
        $fp = @stream_socket_client('tcp://' . $addr . ':' . $port, $eno, $estr,
                                    max(1, min($step, $deadline - microtime(true))), STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) { $err = "connect: $estr"; return false; }
        stream_set_blocking($fp, false);                        // from here on only stream_select() waits, and only until $deadline
        $buf = '';

        // Wait until $fp is readable (or writable) or the overall deadline passes.
        $wait = function (bool $write) use ($fp, $deadline, &$err): bool {
            $left = $deadline - microtime(true);
            if ($left <= 0) { $err = 'timed out'; return false; }
            $r = $write ? null : [$fp];
            $w = $write ? [$fp] : null;
            $e = null;
            $sec = (int) $left;
            @stream_select($r, $w, $e, $sec, (int) (($left - $sec) * 1000000));
            return true;
        };
        $tls = function (bool $starttls) use ($fp, $deadline, &$err, &$buf): bool {
            if ($starttls) {                                    // plaintext the peer sent behind its 220 would be read, after the handshake, as TLS-protected replies
                if ($buf !== '') {
                    $err = 'unexpected data after the STARTTLS reply; refusing to start TLS';
                    return false;
                }
            }
            $method = mail_tls_method();
            do {
                $r = @stream_socket_enable_crypto($fp, true, $method);
                if ($r === 0) { usleep(20000); }
            } while ($r === 0 && microtime(true) < $deadline);
            if ($r !== true) {
                $e = error_get_last();
                $err = 'TLS failed' . ($r === 0 ? ': timed out' : '') . ($e ? ': ' . $e['message'] : '');
                return false;
            }
            return true;
        };
        $put = function (string $data) use ($fp, $wait, &$err): bool {
            while ($data !== '') {
                $n = @fwrite($fp, $data);
                if ($n === false || ($n === 0 && feof($fp))) { $err = 'write failed'; return false; }
                if ($n === 0) {
                    if (!$wait(true)) { return false; }
                    continue;
                }
                $data = (string) substr($data, $n);
            }
            return true;
        };
        // One line from the buffer, reading as needed; null with $err set on timeout, close or an over-long line.
        $line = function () use ($fp, $wait, &$buf, &$err): ?string {
            while (($nl = strpos($buf, "\n")) === false) {
                if (strlen($buf) > MAIL_MAX_REPLY_LINE) { $err = 'reply line too long'; return null; }
                $chunk = @fread($fp, 4096);
                if (is_string($chunk) && $chunk !== '') { $buf .= $chunk; continue; }
                if ($chunk === false || feof($fp)) { $err = 'connection closed'; return null; }
                if (!$wait(false)) { return null; }
            }
            if ($nl > MAIL_MAX_REPLY_LINE) { $err = 'reply line too long'; return null; }
            $l = rtrim(substr($buf, 0, $nl), "\r");
            $buf = (string) substr($buf, $nl + 1);
            return $l;
        };
        // One reply, multi-line "250-…" form included, strictly "ddd text" / "ddd-text" / "ddd":
        // [code, lines] or [0, []] with $err set. At most MAIL_MAX_REPLY_LINES lines and MAIL_MAX_REPLY_BYTES bytes.
        $reply = function () use ($line, &$err): array {
            $lines = [];
            $code = 0;
            $bytes = 0;
            while (true) {
                $l = $line();
                if ($l === null) { return [0, []]; }
                $bytes += strlen($l);
                if (count($lines) >= MAIL_MAX_REPLY_LINES || $bytes > MAIL_MAX_REPLY_BYTES) { $err = 'reply too long'; return [0, []]; }
                if (preg_match('/^([2-5][0-9]{2})(?:([ -])|$)/D', $l, $m) !== 1) { $err = 'not an SMTP reply'; return [0, []]; }
                if ($lines && (int) $m[1] !== $code) { $err = 'reply lines carry different codes'; return [0, []]; }
                $code = (int) $m[1];
                $lines[] = $l;
                if (($m[2] ?? ' ') !== '-') { return [$code, $lines]; }
            }
        };
        $expect = function (int $want, ?array &$got = null) use ($reply, &$err): bool {
            [$code, $lines] = $reply();
            $got = $lines;
            if ($code === 0) { return false; }
            if ($code !== $want) { $err = trim((string) end($lines)); return false; }
            return true;
        };
        $caps = function (array $lines): array {
            $c = [];
            foreach (array_slice($lines, 1) as $l) { $c[] = strtoupper(trim(substr($l, 4))); }
            return $c;
        };
        $cmd = fn(string $c, int $want, ?array &$got = null): bool => $put($c . "\r\n") && $expect($want, $got);

        $helo = (string) ($cfg['smtp_helo'] ?? '');
        if ($helo === '' || !mail_header_ok($helo) || strlen($helo) > MAIL_MAX_FIELD) {
            $helo = substr($from, strpos($from, '@') + 1) ?: 'localhost';
        }

        $ok = true;
        if ($implicit) { $ok = $tls(false); }
        $ok = $ok && $expect(220);
        $ehlo = [];
        if ($ok) { $ok = $cmd('EHLO ' . $helo, 250, $ehlo); }
        if ($ok && !$implicit) {                                // STARTTLS or nothing: no credentials in the clear
            if (!in_array('STARTTLS', $caps($ehlo), true)) { $err = 'server does not offer STARTTLS'; $ok = false; }
            if ($ok) { $ok = $cmd('STARTTLS', 220) && $tls(true); }
            if ($ok) { $ok = $cmd('EHLO ' . $helo, 250, $ehlo); }
        }
        if ($ok && $user !== '') {
            $auth = '';
            foreach ($caps($ehlo) as $c) { if (strncmp($c, 'AUTH ', 5) === 0 || strncmp($c, 'AUTH=', 5) === 0) { $auth .= ' ' . substr($c, 5); } }
            $mechs = preg_split('/[\s]+/', trim($auth)) ?: [];
            if (in_array('PLAIN', $mechs, true)) {
                $ok = $cmd('AUTH PLAIN ' . base64_encode("\0" . $user . "\0" . $pass), 235);
            } elseif (in_array('LOGIN', $mechs, true)) {
                $ok = $cmd('AUTH LOGIN', 334);
                if ($ok) { $ok = $cmd(base64_encode($user), 334); }
                if ($ok) { $ok = $cmd(base64_encode($pass), 235); }
            } else {
                $err = 'server offers neither AUTH PLAIN nor AUTH LOGIN';
                $ok = false;
            }
            if (!$ok) { $err = 'auth: ' . $err; }
        }
        if ($ok) { $ok = $cmd('MAIL FROM:<' . $from . '>', 250); }
        if ($ok) { $ok = $cmd('RCPT TO:<' . $to . '>', 250); }
        if ($ok) { $ok = $cmd('DATA', 354); }
        if ($ok) {
            $msg = mail_build($to, $subject, $body, $from, $name, $helo, in_array('8BITMIME', $caps($ehlo), true));
            $ok = $put($msg . ".\r\n");
            if ($ok) { $ok = $expect(250); }
        }
        if (is_resource($fp)) { $put("QUIT\r\n"); }
        @fclose($fp);
        return $ok;
    })();
    $err = mail_scrub($cfg, $err);
    return $result;
}
