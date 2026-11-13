<?php
/**
 * Detached mail sender for the reset code, started by mail_spawn() in app.php.
 *
 * Why a process and not "send after the reply": NearlyFreeSpeech runs PHP as CGI,
 * where fastcgi_finish_request() does not exist and Apache keeps the client
 * waiting until the script ends. A send inside the request would make an existing
 * account's reply as slow as SMTP and a missing one's instant, a username oracle.
 * The request therefore only forks this worker (the same work whether there is a
 * mail to send or not) and answers; the SMTP round trip happens here, unseen.
 *
 * The job (JSON: {"kind":"code","user","email","code"}, {"kind":"meetreq"|"meetreq_notice","user","to","when"[,"answer"]} or {"kind":"none"}) arrives
 * on stdin (php://stdin works in every SAPI; php://fd does not in php-cgi), never in argv or the environment, and is never written to disk.
 */
if (PHP_SAPI === 'cli' || PHP_SAPI === 'cgi' || PHP_SAPI === 'cgi-fcgi') {
    require_once __DIR__ . '/app.php';
    $job = json_decode((string) @file_get_contents('php://stdin'), true);
    if (is_array($job) && ($job['kind'] ?? '') === 'code') {
        app_clock();
        mail_code(app_config(), (string) $job['user'], (string) $job['email'], (string) $job['code']);
    }
    elseif (is_array($job) && in_array($job['kind'] ?? '', ['meetreq', 'meetreq_notice'], true)) {
        app_clock();
        mail_meetreq_job(app_config(), $job);
    }
}
