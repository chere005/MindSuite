<?php
declare(strict_types=1);
$instance = preg_match('/^(test|dev)\.seancheren\.com(?::\d+)?$/i', $_SERVER['HTTP_HOST'] ?? '', $m) ? '-' . strtolower($m[1]) : '';
header('Content-Type: application/json; charset=utf-8');
// The shared sign-in (bootstrap.php, pm_gate()) answers this API's callers with JSON, never a redirect; pm_user() below asks it, before any store is opened.
const PM_API = true;
try {
    // See index.php: the lib is bound to this release by this directory's name. The stamp is sent on every response.
    $stamp = preg_match('/^\d{14}-\d+$/', basename(__DIR__)) ? basename(__DIR__) : '';
    $lib = getenv('PLANMIND_LIB_DIR') ?: ($stamp !== '' ? '/home/protected/planmind' . $instance . '/releases/' . $stamp . '/lib' : '');
    if ($stamp !== '' && !getenv('PLANMIND_LIB_DIR')) { header('X-PlanMind-Release: ' . $stamp); }
    if ($lib === '' || !is_file($lib . '/bootstrap.php')) { http_response_code(503); echo json_encode(['error' => 'PlanMind is temporarily unavailable.']); exit; }
    require $lib . '/bootstrap.php';
    // The public health answer the release lane reads: whether the private config names the two people (yes or no, never who).
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['health'])) { echo json_encode(['peopleConfigured' => \PlanMind\pm_people_configured()], JSON_THROW_ON_ERROR); exit; }
    // Without the two people every other call is a 503 `unavailable` here, before any store is opened or written.
    \PlanMind\pm_people();
    $user = pm_user();
    if ($user === null) { throw new \PlanMind\RequestError('Sign in to open PlanMind.', empty($_SESSION['auth']) ? 401 : 403); }
    $method = $_SERVER['REQUEST_METHOD'];
    if ($method === 'GET' && isset($_GET['calmind'])) {
        // CalMind's events for a run of planner days: read from CalMind's own store, read-only (planner_calmind.php).
        session_write_close();
        $bothCalendar = \PlanMind\calmind_both_calendar($planDir);
        echo json_encode(\PlanMind\calmind_events($calmindDir, $user, $_GET['from'] ?? null, $_GET['to'] ?? null, $bothCalendar), JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
    } elseif ($method === 'GET') {
        $csrf = $_SESSION['csrf']; $theme = theme_get(); $calmind = pm_calmind_hidden() ? 'hidden' : 'shown'; $bothColor = \PlanMind\both_color_get(); session_write_close();
        $data = $planStore->transaction('tasks', fn($db) => $db);
        $snapshot = \PlanMind\snapshot($data, $user);
        // ?since=N is a poll: the same validated read, but nothing is sent when the client already holds this revision.
        $since = $_GET['since'] ?? null;
        if (is_string($since) && preg_match('/^(?:0|[1-9][0-9]{0,14})$/D', $since) === 1 && (int)$since === $snapshot['revision']) {
            echo json_encode(['unchanged' => true, 'revision' => $snapshot['revision']], JSON_THROW_ON_ERROR);
        } else {
            echo json_encode(['user' => $user, 'csrf' => $csrf, 'theme' => $theme, 'calmind' => $calmind, 'bothColor' => $bothColor, 'timezone' => app_config()['timezone'] ?? 'America/Chicago', 'people' => \PlanMind\pm_people(), ...$snapshot], JSON_THROW_ON_ERROR);
        }
    } elseif ($method === 'POST') {
        pm_csrf();
        if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) { throw new \PlanMind\RequestError('JSON required.', 415); }
        $raw = file_get_contents('php://input', false, null, 0, 65537);
        if ($raw === false || strlen($raw) > 65536) { throw new \PlanMind\RequestError('Request too large.', 413); }
        try { $input = json_decode($raw, true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \PlanMind\RequestError('Invalid JSON.'); }
        if (!is_array($input)) { throw new \PlanMind\RequestError('Invalid request.'); }
        session_write_close();
        if (($input['action'] ?? null) === 'setTheme') {
            // The person's color theme is an account preference (the site's theme_set), not planner data: the store is not opened.
            echo json_encode(\PlanMind\op_set_theme($input, $user, array_keys(THEMES), 'theme_set', 'theme_get'), JSON_THROW_ON_ERROR);
            exit;
        }
        if (($input['action'] ?? null) === 'setBothColor') {
            // The person's own color for Both: an account preference beside the theme (the household's settings.bothColor stays the default), not planner data.
            echo json_encode(\PlanMind\op_set_both_color($input, $user, 'PlanMind\both_color_set', 'PlanMind\both_color_get'), JSON_THROW_ON_ERROR);
            exit;
        }
        if (($input['action'] ?? null) === 'setCalmind') {
            // Whether the Day shows CalMind's events: an account preference beside the theme, not planner data.
            echo json_encode(\PlanMind\op_set_calmind($input, $user, 'pm_calmind_set', 'pm_calmind_hidden'), JSON_THROW_ON_ERROR);
            exit;
        }
        $today = pm_today();
        $data = $planStore->transaction('tasks', fn($db) => \PlanMind\mutate($db, $input, $user, $today));
        echo json_encode(\PlanMind\snapshot($data, $user), JSON_THROW_ON_ERROR);
    } else { header('Allow: GET, POST'); throw new \PlanMind\RequestError('Method not allowed.', 405); }
} catch (\PlanMind\RequestError $e) {
    http_response_code($e->status); echo json_encode($e->body(), JSON_INVALID_UTF8_SUBSTITUTE);
} catch (\Throwable $e) {
    header('Cache-Control: no-store'); http_response_code(503);
    error_log('PlanMind request failed: ' . get_class($e));
    echo json_encode(['error' => 'Your list could not be loaded or saved. Your last saved data is preserved.', 'code' => 'unavailable']);
}
