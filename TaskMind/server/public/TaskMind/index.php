<?php
declare(strict_types=1);
$instance = preg_match('/^(test|dev)\.seancheren\.com(?::\d+)?$/i', $_SERVER['HTTP_HOST'] ?? '', $m) ? '-' . strtolower($m[1]) : '';
// This file and its lib are one release: the lib is found by THIS directory's name (.taskmind/<stamp>/ holds this
// file, releases/<stamp>/lib the lib), never through a pointer. A stale cached copy of this file therefore still
// pairs with its own lib. TASKMIND_LIB_DIR (local preview, tests) wins; with neither, fail closed without a path.
$stamp = preg_match('/^\d{14}-\d+$/', basename(__DIR__)) ? basename(__DIR__) : '';
$lib = getenv('TASKMIND_LIB_DIR') ?: ($stamp !== '' ? '/home/protected/taskmind' . $instance . '/releases/' . $stamp . '/lib' : '');
if ($lib === '' || !is_file($lib . '/bootstrap.php')) { http_response_code(503); echo 'TaskMind is temporarily unavailable.'; exit; }
require $lib . '/bootstrap.php';
// Shared sign-in (the instance is on and TaskMind is not held there): the gate has already sent a visitor with no session to the account
// page, and a write without the session's token away with a 403, so what runs below is a signed-in person. There is no form of ours.
try { $shared = tm_gate() !== null; }
catch (\TaskMind\RequestError $e) { http_response_code($e->status); echo 'TaskMind is temporarily unavailable.'; exit; }
$error = '';
if ($shared && !in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) {
    // Signing in and out happens at the account page; a post here would be a second door. The one post this page's own Sign out button
    // makes is handed on to the account page untouched (307 keeps the method and the form, token included), which signs the person out
    // there: nothing here ends a session. Anything else is refused.
    if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? null) === 'logout') { header('Location: ' . mss_url_prefix(app_config(), $_SERVER) . '/account/', true, 307); exit; }
    header('Allow: GET, HEAD'); http_response_code(405); echo 'Sign in and out on the account page.'; exit;
}
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        tm_csrf();
        if (($_POST['action'] ?? '') === 'logout') {
            // A new, empty session under a new id; the signed-in one is deleted, so its id signs in nothing again.
            session_regenerate_id(true); $_SESSION = [];
            header('Location: ./', true, 303); exit;
        }
        if (tm_login($store)) { header('Location: ./', true, 303); exit; }
        $error = 'Unable to sign in with those details.';
    } catch (\TaskMind\RequestError $e) { http_response_code($e->status); $error = $e->getMessage(); }
    catch (\Throwable $e) { error_log('TaskMind login failed: ' . get_class($e)); http_response_code(503); $error = 'Sign-in is temporarily unavailable.'; }
}
// Signed in is not enough: the person must be on the team (the gate reads the workspace on every request). Anyone else sees the
// sign-in form again, with the reason, and no app.
$member = null;
if ($error === '' && tm_user() !== null) {
    try { $member = tm_member(); }
    catch (\TaskMind\RequestError $e) { http_response_code($e->status); $error = $e->getMessage(); }
    catch (\Throwable $e) { error_log('TaskMind gate failed: ' . get_class($e)); http_response_code(503); $error = 'TaskMind is temporarily unavailable.'; }
} elseif ($error === '' && !empty($_SESSION['auth'])) { http_response_code(403); $error = 'TaskMind is for members of its team.'; }
// Where a Sign out form posts under the shared sign-in, and where the account page then sends the browser: the sign-in it asks for.
$signOut = $shared ? ['action' => mss_url_prefix(app_config(), $_SERVER) . '/account/', 'next' => mss_account_url(app_config(), $_SERVER, tm_page_path())] : null;
?><!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#111111"><meta name="robots" content="noindex,nofollow">
<title>TaskMind</title><link rel="icon" type="image/svg+xml" href="./icon.svg">
<link rel="stylesheet" href="./assets/app.css">
</head><body>
<?php if ($member === null && $shared): ?>
<main class="login"><img class="brand-mark" src="./icon.svg" alt="" width="72" height="72"><h1>TaskMind</h1>
<form method="post" action="<?= tm_escape($signOut['action']) ?>" class="login-form">
<input type="hidden" name="action" value="logout"><input type="hidden" name="next" value="<?= tm_escape($signOut['next']) ?>"><input type="hidden" name="csrf" value="<?= tm_escape($_SESSION['csrf']) ?>">
<p class="error" role="alert"><?= tm_escape($error) ?></p>
<button class="primary" type="submit">Sign out</button></form></main>
<?php elseif ($member === null): ?>
<main class="login"><img class="brand-mark" src="./icon.svg" alt="" width="72" height="72"><h1>TaskMind</h1>
<form method="post" class="login-form">
<input type="hidden" name="csrf" value="<?= tm_escape($_SESSION['csrf']) ?>">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="80">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<?php if ($error !== ''): ?><p class="error" role="alert"><?= tm_escape($error) ?></p><?php endif; ?>
<button class="primary" type="submit">Sign in</button></form></main>
<?php else: ?>
<div id="app"<?php if ($signOut !== null): ?> data-signout-action="<?= tm_escape($signOut['action']) ?>" data-signout-next="<?= tm_escape($signOut['next']) ?>"<?php endif; ?>><p class="loading" role="status">Opening TaskMind…</p></div>
<script type="module" src="./assets/app.js"></script>
<?php endif; ?>
</body></html>
