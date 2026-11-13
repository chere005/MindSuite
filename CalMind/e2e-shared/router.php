<?php
/**
 * The shared sign-in harness: ONE `php -S` that serves the exported CalMind web app, the real CalMind API and the REAL
 * /account/ page of the site checkout (public/account/index.php), against scratch directories, so a browser can go
 * app -> /account/ -> app the way it does on the test instance.
 *
 *   CALMIND_DATA_DIR      CalMind's data directory (scratch)
 *   CALMIND_SITE_LIB      the site lib (seancheren-site/lib); the site's public/ is its sibling
 *   CALMIND_SITE_CONFIG   the scratch site config the API re-reads on every request (the spec rewrites it per case)
 *   SUITE_DATA_DIR        the site's data directory (scratch): the shared store lives under it
 *   SUITE_MINDSUITE_AUTH_TEST=1   the site's fixture switch: a disposable key, and this loopback origin as the relying party
 *
 * Only /account/index.php and its script are served from the site: never the operator pages beside them.
 */

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
$root = dirname(__DIR__);
$lib = rtrim((string) getenv('CALMIND_SITE_LIB'), '/');
$sitePublic = dirname($lib) . '/public';

/** Serve one file with a type from a short list. */
function send(string $file): bool
{
    $types = ['html' => 'text/html', 'js' => 'text/javascript', 'ico' => 'image/x-icon', 'png' => 'image/png', 'json' => 'application/json', 'css' => 'text/css'];
    header('Content-Type: ' . ($types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'));
    readfile($file);
    return true;
}

if (preg_match('#^/calmind/api/#', $uri)) {
    require $root . '/server/public/api/index.php';
    return true;
}
if (str_starts_with($uri, '/calmind')) {
    $rel = substr($uri, strlen('/calmind'));
    if ($rel === '' || $rel === '/') { $rel = '/index.html'; }
    $file = $root . '/apps/app/dist' . $rel;
    if (!str_contains($rel, '..') && is_file($file)) { return send($file); }
    http_response_code(404);
    echo 'not found';
    return true;
}
if ($uri === '/account' || $uri === '/account/' || $uri === '/account/index.php') {
    chdir($sitePublic . '/account');
    require $sitePublic . '/account/index.php';
    return true;
}
if ($uri === '/account/account.js' && is_file($sitePublic . '/account/account.js')) {
    return send($sitePublic . '/account/account.js');
}
http_response_code(404);
echo 'not found';
return true;
