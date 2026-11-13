<?php
declare(strict_types=1);
$instance = preg_match('/^(test|dev)\.seancheren\.com(?::\d+)?$/i', $_SERVER['HTTP_HOST'] ?? '', $m) ? '-' . strtolower($m[1]) : '';
header('Content-Type: application/json; charset=utf-8');
// The shared sign-in (bootstrap.php, tm_gate()) answers this API's callers with JSON, never a redirect; tm_member() below asks it, before any store is opened.
const TM_API = true;
try {
    // See index.php: the lib is bound to this release by this directory's name. The stamp is sent on every response.
    $stamp = preg_match('/^\d{14}-\d+$/', basename(__DIR__)) ? basename(__DIR__) : '';
    $lib = getenv('TASKMIND_LIB_DIR') ?: ($stamp !== '' ? '/home/protected/taskmind' . $instance . '/releases/' . $stamp . '/lib' : '');
    if ($stamp !== '' && !getenv('TASKMIND_LIB_DIR')) { header('X-TaskMind-Release: ' . $stamp); }
    if ($lib === '' || !is_file($lib . '/bootstrap.php')) { http_response_code(503); echo json_encode(['error' => 'TaskMind is temporarily unavailable.']); exit; }
    require $lib . '/bootstrap.php';
    // The gate runs on every request, before anything else is looked at: 401 signed out, 403 not on the team, 503 workspace unreadable.
    $member = tm_member($workspace);
    switch ($_SERVER['REQUEST_METHOD']) {
        case 'GET':
            $view = $_GET['view'] ?? 'session';
            if ($view === 'session' && !array_key_exists('since', $_GET)) {
                $reply = \TaskMind\session_reply($member, $_SESSION['csrf'], theme_get());
            } elseif ($view === 'workspace') {
                $since = array_key_exists('since', $_GET) ? \TaskMind\query_revision($_GET['since']) : null;
                $reply = \TaskMind\workspace_reply($workspace, $member['id'], $since);
            } else {
                throw new \TaskMind\RequestError('Unknown API view.');
            }
            session_write_close();
            break;
        case 'POST':
            tm_csrf();
            session_write_close();
            unset($workspace);
            $request = \TaskMind\read_mutation_body($_SERVER['CONTENT_TYPE'] ?? '', $_SERVER['CONTENT_LENGTH'] ?? '');
            $reply = \TaskMind\change_workspace($store, app_config(), tm_users(), $member['id'], $request);
            break;
        default:
            header('Allow: GET, POST');
            throw new \TaskMind\RequestError('Method not allowed.', 405);
    }
    echo json_encode($reply, JSON_THROW_ON_ERROR);
} catch (\TaskMind\RequestError $e) {
    http_response_code($e->status); echo json_encode($e->body(), JSON_INVALID_UTF8_SUBSTITUTE);
} catch (\Throwable $e) {
    header('Cache-Control: no-store'); http_response_code(503);
    error_log('TaskMind request failed: ' . get_class($e));
    echo json_encode(['error' => 'TaskMind could not be loaded. Your last saved data is preserved.', 'code' => 'unavailable']);
}
