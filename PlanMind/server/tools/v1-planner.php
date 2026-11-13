<?php
// The PlanMind 0.1.0 writer, kept only to build disposable v1 fixtures for the migration cases. Verbatim from
// `git show 0.1.0:server/lib/planner.php` (tag 0.1.0, commit 40bcd3a, the version live before v2) with two changes:
// the namespace is PlanMindV1 so it can load beside the current code, and atomic.php is found in ../lib.
// Do not edit the logic: its job is to write what production wrote. Never shipped (server/lib is the only protected payload).
declare(strict_types=1);
namespace PlanMindV1;
require_once __DIR__ . '/../lib/atomic.php';
use function MindSuite\Files\atomic_write;
use function MindSuite\Files\with_file_lock;

final class RequestError extends \RuntimeException {
    public function __construct(string $message, public readonly int $status = 400) { parent::__construct($message); }
}

/** Authenticated encryption for the shared planner and login-attempt ledger. */
final class Store {
    public function __construct(private readonly string $dir) {}
    public function transaction(string $name, callable $change): array {
        if (!in_array($name, ['tasks', 'attempts'], true)) { throw new \InvalidArgumentException('Unknown store.'); }
        return with_file_lock($this->dir . '/.' . $name . '.lock', function () use ($name, $change) {
            $file = $this->dir . '/' . $name . '.enc';
            $before = $this->read($file);
            $after = $change($before);
            if ($after !== $before) {
                $plain = json_encode($after, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                $nonce = random_bytes(12); $tag = '';
                $cipher = openssl_encrypt($plain, 'aes-256-gcm', $this->key(), OPENSSL_RAW_DATA, $nonce, $tag, 'PlanMind:' . $name, 16);
                if ($cipher === false) { throw new \RuntimeException('Encryption failed.'); }
                atomic_write($file, 'PM1:' . base64_encode($nonce . $tag . $cipher));
            }
            return $after;
        });
    }
    private function key(): string {
        return with_file_lock($this->dir . '/.key.lock', function () {
            $file = $this->dir . '/.key';
            if (!file_exists($file)) {
                // Losing a key must never silently generate a replacement for existing ciphertext.
                if (glob($this->dir . '/*.enc')) { throw new \RuntimeException('Storage key missing.'); }
                atomic_write($file, random_bytes(32));
            }
            $key = file_get_contents($file);
            if ($key === false || strlen($key) !== 32) { throw new \RuntimeException('Invalid storage key.'); }
            return $key;
        });
    }
    private function read(string $file): array {
        if (!file_exists($file)) { return []; }
        $raw = file_get_contents($file);
        if ($raw === false || !str_starts_with($raw, 'PM1:')) { throw new \RuntimeException('Unreadable storage.'); }
        $bytes = base64_decode(substr($raw, 4), true);
        if ($bytes === false || strlen($bytes) < 29) { throw new \RuntimeException('Damaged storage.'); }
        $plain = openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', $this->key(), OPENSSL_RAW_DATA,
            substr($bytes, 0, 12), substr($bytes, 12, 16), 'PlanMind:' . basename($file, '.enc'));
        if ($plain === false) { throw new \RuntimeException('Storage authentication failed.'); }
        $data = json_decode($plain, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($data)) { throw new \RuntimeException('Invalid storage.'); }
        return $data;
    }
}

function allowed(?string $user, array $configured): bool {
    return in_array($user, ['alex', 'sam'], true) && isset($configured[$user]);
}
function valid_date(mixed $date): bool {
    if (!is_string($date) || !preg_match('/^(20\d{2})-(\d{2})-(\d{2})$/D', $date, $m)) { return false; }
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}
function task_fields(array $input): array {
    $title = $input['title'] ?? null;
    if (!is_string($title) || trim($title) === '' || strlen($title) > 2000 || !preg_match('//u', $title)) {
        throw new RequestError('Use a task title of 1–2,000 bytes.');
    }
    if (!valid_date($input['date'] ?? null)) { throw new RequestError('Choose a valid date between 2000 and 2099.'); }
    if (!in_array($input['person'] ?? null, ['both', 'sam', 'alex'], true)) { throw new RequestError('Choose Both, Sam, or Alex.'); }
    $scope = $input['scope'] ?? 'day';
    if (!in_array($scope, ['day','month'], true) || ($scope === 'month' && substr($input['date'], -2) !== '01')) { throw new RequestError('Invalid task period.'); }
    return ['title' => trim($title), 'date' => $input['date'], 'person' => $input['person'], 'scope' => $scope];
}
function snapshot(array $db): array {
    if ($db === []) { return ['revision' => 0, 'tasks' => [], 'notes' => []]; }
    if (!is_int($db['revision'] ?? null) || !is_array($db['tasks'] ?? null)) { throw new \RuntimeException('Invalid planner data.'); }
    if (isset($db['notes']) && !is_array($db['notes'])) { throw new \RuntimeException('Invalid notes data.'); }
    return ['revision' => $db['revision'], 'tasks' => array_values($db['tasks']), 'notes' => array_values($db['notes'] ?? [])];
}
function save_note(array $db, array $input, string $user): array {
    $scope = $input['scope'] ?? ''; $period = $input['period'] ?? '';
    if (!in_array($scope, ['week','month'], true) || !valid_date($period)) { throw new RequestError('Invalid note period.'); }
    if (($scope === 'month' && substr($period, -2) !== '01') || ($scope === 'week' && (new \DateTimeImmutable($period))->format('N') !== '1')) { throw new RequestError('Weeks start Monday; months start on the first.'); }
    $text = $input['text'] ?? null;
    if (!is_string($text) || strlen($text) > 50000 || !preg_match('//u', $text)) { throw new RequestError('The note is too long or contains invalid text.'); }
    $key = $scope . ':' . $period; $before = $db['notes'][$key] ?? null;
    if (($input['revision'] ?? null) !== ($before['revision'] ?? 0)) { throw new RequestError('This note changed on another device. Your draft is preserved; reload the saved note before replacing it.', 409); }
    if ($before !== null && $before['text'] === $text) { return $db; }
    $db['notes'][$key] = ['key'=>$key,'scope'=>$scope,'period'=>$period,'text'=>$text,'revision'=>($before['revision'] ?? 0)+1,'updatedBy'=>$user,'updatedAt'=>gmdate('c')];
    ++$db['revision']; return $db;
}
/** Record revisions protect simultaneous edits; an add ID makes a lost-response retry safe. */
function mutate(array $db, array $input, string $user): array {
    if (!in_array($user, ['alex', 'sam'], true)) { throw new RequestError('Access denied.', 403); }
    snapshot($db);
    $db = $db ?: ['revision' => 0, 'tasks' => []];
    if (($input['action'] ?? '') === 'saveNote') { return save_note($db, $input, $user); }
    $id = $input['id'] ?? '';
    if (!is_string($id) || !preg_match('/^[a-f0-9-]{36}$/D', $id)) { throw new RequestError('Invalid task ID.'); }
    $action = $input['action'] ?? '';
    $task = $db['tasks'][$id] ?? null;
    if ($action === 'add') {
        $fields = task_fields($input);
        if ($task !== null) {
            if ($task['createdBy'] === $user && array_intersect_key($task, $fields) === $fields) { return $db; }
            throw new RequestError('That task ID is already in use.', 409);
        }
        if (count($db['tasks']) >= 20000) { throw new RequestError('The planner has reached its task limit.', 409); }
        $task = ['id' => $id, ...$fields, 'done' => false, 'revision' => 0, 'createdBy' => $user];
    } else {
        if ($task === null) { throw new RequestError('This task was removed. Refresh to see the latest list.', 409); }
        if (($input['revision'] ?? null) !== $task['revision']) { throw new RequestError('This task changed on another device. Refresh and try again.', 409); }
        if ($action === 'edit') { $task = [...$task, ...task_fields($input)]; }
        elseif ($action === 'complete') {
            if (!is_bool($input['done'] ?? null)) { throw new RequestError('Invalid completion value.'); }
            $task['done'] = $input['done'];
        } elseif ($action === 'delete') {
            if (($input['confirm'] ?? false) !== true) { throw new RequestError('Confirm removal first.'); }
            unset($db['tasks'][$id]); ++$db['revision']; return $db;
        } else { throw new RequestError('Unknown action.'); }
    }
    ++$task['revision']; $task['updatedAt'] = gmdate('c');
    $db['tasks'][$id] = $task; ++$db['revision'];
    return $db;
}
