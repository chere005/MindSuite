<?php
/**
 * Copy to config.php (gitignored) and adjust. Without one, the data dir defaults
 * to server/data/ (or $CALMIND_DATA_DIR). Mail is off unless 'mail_enabled' is true
 * (lib/mail.php). data/mail.log records that a reset code was issued, never the
 * code; 'debug_log_codes' => true (or CALMIND_DEBUG_LOG_CODES=1) adds it, for
 * local testing with mail off only. Do not set either on a host.
 */
return [
    // 'data_dir'  => '/home/protected/data-calmind-test',
    // 'data_key'  => '',          // empty = auto-generate .datakey in the data dir
    // 'mail_enabled' => false,    // OFF by default: mail_send() only logs. true = real authenticated SMTP
    // 'smtp_host' => '', 'smtp_port' => 587, 'smtp_user' => '', 'smtp_pass' => '',
    // 'php_bin' => '/usr/local/bin/php',  // absolute path to the PHP CLI (or php-cgi) that runs the detached reset-mail worker.
                                   // Set it when the web server runs PHP as mod_php/php-fpm (PHP_BINARY is then httpd/php-fpm
                                   // and the code is logged NOT SENT). Config only; never taken from a request.
    // 'mail_from' => 'no-reply@seancheren.com', 'mail_from_name' => 'CalMind',
                                   // TLS is required and verified.
    // 'meetreq_user' => 'alex',   // whose calendar the public /request page offers: the account that owns it.
                                   // No default: without it (or CALMIND_MEETREQ_USER) the page is off and answers 404.
    // 'calmind_site_lib' => '/home/protected/lib-test',  // the site lib whose shared sign-in this instance follows.
                                   // Unset: derived from where server/lib is deployed (test, dev, prod each their own);
                                   // '' keeps this instance on its legacy sign-in whatever the site says (docs/api.md).
    // 'timezone'  => 'America/Chicago',  // the server's day. Without it PHP keeps
                                   // UTC and the feed's "today" turns over at 7pm
                                   // Chicago — the widget calls tomorrow today.
];
