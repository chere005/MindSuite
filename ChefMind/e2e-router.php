<?php
/**
 * The local server for ChefMind: one `php -S` serving the EXPORTED web app
 * under /ChefMind (matching the baked baseUrl), with its api/ calls routed
 * into CalMind's real endpoint against a scratch data dir.
 *
 * TWO PREFIXES, and that is the point of the file. In production ChefMind is
 * served at /ChefMind and talks to /calmind/api/index.php — a different path
 * on the same origin — so a router that only knew one prefix would be testing
 * an arrangement the deployed app does not have.
 *
 * The API lives in the CalMind repo, not this one. A sibling checkout is
 * assumed at ../CalMind; CALMIND_REPO overrides it. No checkout means the
 * /calmind/api half 404s with a message that says why, rather than a blank
 * not-found that reads like a routing bug.
 *
 *   CALMIND_DATA_DIR=/tmp/scratch php -S 127.0.0.1:8792 e2e-router.php
 */

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$repo = __DIR__;
$calmind = getenv('CALMIND_REPO') ?: dirname(__DIR__) . '/CalMind';

if (preg_match('#^/calmind/api/#', $uri)) {
    $api = $calmind . '/server/public/api/index.php';
    if (!is_file($api)) {
        http_response_code(404);
        echo "no CalMind checkout at $calmind — set CALMIND_REPO";
        return true;
    }
    require $api;
    return true;
}
if (str_starts_with($uri, '/ChefMind')) {
    $rel = substr($uri, strlen('/ChefMind'));
    if ($rel === '' || $rel === '/') { $rel = '/index.html'; }
    $dist = $repo . '/app/dist';
    // CONTAINMENT, not string concatenation.
    //
    // Today `php -S` normalizes `..` out of REQUEST_URI before this script
    // ever runs, so the concatenated form did NOT leak — measured, both ways,
    // rather than assumed in either direction. What it did was rest the
    // containment of a server running beside deploy.conf on a normalization
    // nothing here states, tests, or controls: swap the harness, or read this
    // path out of any other source, and the guarantee is gone with no diff to
    // show for it. So the check is written down where the file is opened.
    $file = realpath($dist . $rel);
    $root = realpath($dist);
    if ($file !== false && $root !== false
        && ($file === $root || str_starts_with($file, $root . DIRECTORY_SEPARATOR))
        && is_file($file)) {
        $types = ['html' => 'text/html', 'js' => 'text/javascript', 'ico' => 'image/x-icon',
                  'png' => 'image/png', 'json' => 'application/json', 'webmanifest' => 'application/manifest+json'];
        $ext = pathinfo($file, PATHINFO_EXTENSION);
        header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
        readfile($file);
        return true;
    }
}
http_response_code(404);
echo 'not found';
return true;
