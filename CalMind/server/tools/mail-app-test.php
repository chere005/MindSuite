<?php
/**
 * What CalMind sends through lib/mail.php: the recovery code and the meeting
 * replies, against the disposable fake SMTP server of the shared mail harness.
 * The transport itself is tested by mail-test.php (canon).
 *
 *   php server/tools/mail-app-test.php
 */
require_once dirname(__DIR__) . '/lib/mail.php';
require_once dirname(__DIR__) . '/lib/app.php';
require_once __DIR__ . '/mail-harness.php';

area('mail-app');

t('recovery code is delivered when mail is enabled', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        mail_code($cfg, 'alex', 'a@example.com', '123456');
        has('Your CalMind reset code is: 123456', mt_session($dir));
        $log = mt_log($dir);
        has('user=alex  mailed', $log);
        hasnt('123456', $log, 'the code is in the mail log');
        $cfg['debug_log_codes'] = true;                 // only an explicit flag writes it
        mail_code($cfg, 'alex', 'a@example.com', '654321');
        has('code=654321', mt_log($dir));
    });
});

t('meeting replies honor enabled, disabled, and refused delivery', function () {
    mt_with('ok', 'starttls', function ($cfg, $dir) {
        $off = $cfg; $off['mail_enabled'] = false;
        eq('log-only', mail_delivery_status($off, 'a@example.com', 'Your meeting request', "Accepted\n"));
        ok(!is_file("$dir/session.1"));
        eq('mailed', mail_delivery_status($cfg, 'a@example.com', 'Your meeting request', "Accepted\n"));
        has('Accepted', mt_session($dir));
    });
    mt_with('authfail', 'starttls', function ($cfg) {
        eq('MAIL REFUSED', mail_delivery_status($cfg, 'a@example.com', 'Your meeting request', "Accepted\n"));
    });
});

mt_run();
