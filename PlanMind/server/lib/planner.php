<?php
declare(strict_types=1);
namespace PlanMind;
require_once __DIR__ . '/atomic.php';
require_once __DIR__ . '/limits.php';
require_once __DIR__ . '/people.php';
require_once __DIR__ . '/planner_rules.php';
require_once __DIR__ . '/planner_items.php';
require_once __DIR__ . '/planner_lists.php';
require_once __DIR__ . '/planner_chores.php';
require_once __DIR__ . '/planner_migrate.php';
require_once __DIR__ . '/theme.php';
require_once __DIR__ . '/planner_calmind.php';
use function MindSuite\Files\atomic_write;
use function MindSuite\Files\with_file_lock;

/**
 * A caller mistake or a conflict, answered with `status` and a machine-readable `errorCode` (ApiErrorCode in
 * model.ts). A code is optional when the status names it; `cap` names the CAPS entry behind a `limit`.
 * The property is not called `code`: Exception already owns that name.
 */
final class RequestError extends \RuntimeException {
    /** What a status means when no code is given. Every pair must agree with ERROR_STATUS (a server case checks). */
    private const BY_STATUS = [400 => 'invalid', 401 => 'unauthorized', 403 => 'forbidden', 405 => 'method_not_allowed',
        409 => 'stale', 413 => 'payload_too_large', 415 => 'unsupported_media', 429 => 'rate_limited', 503 => 'unavailable'];
    public readonly string $errorCode;
    public function __construct(string $message, public readonly int $status = 400, string $code = '', public readonly ?string $cap = null) {
        parent::__construct($message);
        $code = $code !== '' ? $code : (self::BY_STATUS[$status] ?? throw new \InvalidArgumentException("No default error code for status $status."));
        if ((MODEL['errorStatus'][$code] ?? null) !== $status) { throw new \InvalidArgumentException("Error code $code does not answer with status $status."); }
        if ($cap !== null && !isset(LIMITS[$cap])) { throw new \InvalidArgumentException("Unknown cap $cap."); }
        $this->errorCode = $code;
    }
    /** The JSON body of the response. */
    public function body(): array {
        return ['error' => $this->getMessage(), 'code' => $this->errorCode] + ($this->cap === null ? [] : ['cap' => $this->cap]);
    }
}

/** Authenticated encryption for the shared planner and login-attempt ledger. */
final class Store {
    public function __construct(private readonly string $dir) {}
    /** The private directory the store keeps its files in; the sign-in caps ledger (login_limit.php) sits beside the encrypted stores. */
    public function directory(): string { return $this->dir; }
    /** A key for `$purpose` derived from the store key, so a plain file can keep hashes that cannot be guessed back from a name alone. */
    public function derive(string $purpose): string { return hash_hmac('sha256', $purpose, $this->key(), true); }
    public function transaction(string $name, callable $change): array {
        if (!in_array($name, ['tasks', 'attempts'], true)) { throw new \InvalidArgumentException('Unknown store.'); }
        return with_file_lock($this->dir . '/.' . $name . '.lock', function () use ($name, $change) {
            $file = $this->dir . '/' . $name . '.enc';
            $before = $this->read($file);
            $after = $change($before);
            if ($after !== $before) {
                $plain = json_encode($after, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                if (strlen($plain) > LIMITS['storeBytesMax']) { throw new RequestError('The planner is full.', 409, 'store_full'); }
                $nonce = random_bytes(12); $tag = '';
                $cipher = openssl_encrypt($plain, 'aes-256-gcm', $this->key(), OPENSSL_RAW_DATA, $nonce, $tag, 'PlanMind:' . $name, 16);
                if ($cipher === false) { throw new \RuntimeException('Encryption failed.'); }
                // The first write that stores a newer version than the file holds: the old file's bytes are saved untouched before they are replaced.
                if ($name === 'tasks') {
                    [$was, $now] = [Invariants::storedVersion($before), Invariants::storedVersion($after)];
                    if ($was !== null && $now !== null && $was < $now && ($was > 1 || MigrateV1::holdsRecords($before))) { $this->keepOldFile($file, $was); }
                    if ($now !== null) { $this->markVersion($now); }
                }
                atomic_write($file, 'PM1:' . base64_encode($nonce . $tag . $cipher));
            }
            return $after;
        });
    }
    /**
     * Saves the old file's exact bytes once as tasks.v<version>.enc.bak (private like every file here), so the conversion can always
     * be undone by putting them back as tasks.enc (and deleting tasks.version, which names the newer version). An existing backup is
     * never overwritten: it may be the very same file (an earlier write that stopped after this step), otherwise the write is refused
     * rather than lose the only copy.
     */
    private function keepOldFile(string $file, int $version): void {
        $name = "tasks.v$version.enc.bak";
        $backup = $this->dir . '/' . $name;
        $original = file_get_contents($file);
        if ($original === false) { throw new \RuntimeException('Cannot read the old storage to back it up.'); }
        if (file_exists($backup)) {
            if (file_get_contents($backup) !== $original) { throw Invariants::bad("$name already exists and is not the old store; move it aside", 'The old storage cannot be backed up.'); }
            return;
        }
        atomic_write($backup, $original);
    }
    /**
     * tasks.version: the version number and a newline, in plain text, so tools/deploy.sh can read over ssh (no key, no data) which store
     * format the data directory holds before it points the site at an older release. It is written before the file it describes, so it is
     * never below the file's version: a write that stops between the two leaves it ahead, which only refuses a rollback that could have
     * been allowed, never allows one that cannot read the data. Rewritten only when the number changes. Unlike every other file here it is
     * readable by the group (0640): the deploy user is in group web, not the web user that writes it, and a number is no secret.
     */
    private function markVersion(int $version): void {
        $marker = $this->dir . '/tasks.version';
        $text = $version . "\n";
        if (@file_get_contents($marker) === $text) { return; }
        atomic_write($marker, $text);
        if (!@chmod($marker, 0640)) { throw new \RuntimeException('Cannot share the storage version marker.'); }
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
    return in_array($user, pm_person_lists(), true) && isset($configured[$user]);
}

/**
 * A current-version store with nothing in it but the permanent lists, the settings and the seeded chore chart; what a missing file reads as. `$now` stamps them.
 * The permanent lists are the two people's, in MODEL['personRoles'] order, each named by its id capitalized and colored by its role.
 */
function fresh_db(?string $now = null): array {
    $now ??= gmdate('c');
    $people = pm_people();
    $colors = array_column(MODEL['defaultColorsByRole'], 1, 0);
    $lists = [];
    foreach (MODEL['personRoles'] as $order => $role) {
        $id = $people[$role];
        $lists[$id] = ['id' => $id, 'kind' => 'person', 'name' => ucfirst($id), 'color' => $colors[$role], 'order' => $order, 'revision' => 1, 'updatedAt' => $now];
    }
    return ['v' => MODEL['storeVersion'], 'revision' => 0,
        'lists' => $lists,
        'settings' => ['bothColor' => $colors['both'], 'revision' => 1, 'updatedAt' => $now],
        'tasks' => [], 'priorities' => [], 'events' => [], 'notes' => [],
        'chores' => ChoreSeed::rules($now), 'choreMarks' => [], 'rhythm' => ChoreSeed::rhythm($now), 'prefs' => []];
}
function touch(array $db): array { ++$db['revision']; return $db; }

/** Throws RuntimeException (a 503 whose cause goes to error_log) unless the db is a complete, consistent store of the current version. */
function validate_db(array $db): void { Invariants::validate($db); }

/**
 * What GET and every successful POST return for `$user`: lists, records and notes as lists (never a raw map),
 * and only that user's own preferences (the picker state and whether the desktop sidebar is shown). Validates first, so corrupt or old data fails closed.
 */
function snapshot(array $db, string $user): array {
    if (!in_array($user, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    $db = Invariants::load($db);
    $lists = array_values($db['lists']);
    usort($lists, fn($a, $b) => [$a['order'], $a['id']] <=> [$b['order'], $b['id']]);
    $chores = array_values($db['chores']);
    usort($chores, fn($a, $b) => [$a['order'], $a['id']] <=> [$b['order'], $b['id']]);
    return ['v' => $db['v'], 'revision' => $db['revision'], 'lists' => $lists, 'settings' => $db['settings'],
        'tasks' => array_values($db['tasks']), 'priorities' => array_values($db['priorities']),
        'events' => array_values($db['events']), 'notes' => array_values($db['notes']),
        'chores' => $chores, 'choreMarks' => array_values($db['choreMarks']), 'rhythm' => $db['rhythm'],
        'prefs' => ['selection' => Invariants::selection($db, $db['prefs'][$user]['selection'] ?? null), 'sidebar' => Invariants::sidebar($db['prefs'][$user]['sidebar'] ?? null)]];
}

/**
 * Authorizes the caller, validates the stored db, routes by `action` and returns the db to store (the very
 * array it was given when nothing changed, so nothing is rewritten). The global revision is decided here:
 * +1 for a change, unchanged for savePrefs, whether or not a handler called touch(). `$today` is the caller's date in the site's
 * timezone: with it, the day to-do cap on that date counts the earlier days' open to-dos the Day view carries onto it; without it
 * (a tool that has no clock) nothing is carried.
 */
function mutate(array $db, array $input, string $user, ?string $today = null): array {
    static $routes = ['add' => 'op_add', 'edit' => 'op_edit', 'complete' => 'op_complete', 'delete' => 'op_delete',
        'moveTodo' => 'op_move_todo', 'movePriorities' => 'op_move_priorities', 'editEvents' => 'op_edit_events', 'saveNote' => 'op_save_note',
        'saveList' => 'op_save_list', 'deleteList' => 'op_delete_list', 'saveSettings' => 'op_save_settings', 'savePrefs' => 'op_save_prefs',
        'saveChore' => 'op_save_chore', 'deleteChore' => 'op_delete_chore', 'markChore' => 'op_mark_chore', 'saveRhythm' => 'op_save_rhythm'];
    if (!in_array($user, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    $action = $input['action'] ?? null;
    $handler = is_string($action) ? ($routes[$action] ?? null) : null;
    if ($handler === null) { throw new RequestError('Unknown action.', 400, 'invalid'); }
    $handler = __NAMESPACE__ . '\\' . $handler;
    if (!function_exists($handler)) { throw new \RuntimeException("Missing handler $handler."); }
    $before = Invariants::load($db);
    // Only the three that judge the day cap take the date.
    $after = in_array($action, ['add', 'edit', 'complete'], true) ? $handler($before, $input, $user, $today) : $handler($before, $input, $user);
    return Invariants::settle($db, $before, $after, $action);
}

/** Structural checks of the stored db. Fail closed on the first violation: nothing is repaired or skipped. */
final class Invariants {
    private const STAMPED = ['revision' => 1, 'createdBy' => 1, 'updatedBy' => 1, 'createdAt' => 1, 'updatedAt' => 1, 'ak' => 1];
    private const SHAPE = [
        'db' => ['v' => 1, 'revision' => 1, 'lists' => 1, 'settings' => 1, 'tasks' => 1, 'priorities' => 1, 'events' => 1, 'notes' => 1, 'chores' => 1, 'choreMarks' => 1, 'rhythm' => 1, 'prefs' => 1],
        'task' => ['id' => 1, 'scope' => 1, 'date' => 1, 'owners' => 1, 'title' => 1, 'done' => 1, 'pos' => 1] + self::STAMPED,
        'priority' => ['id' => 1, 'date' => 1, 'owners' => 1, 'slots' => 1, 'text' => 1] + self::STAMPED,
        'event' => ['id' => 1, 'date' => 1, 'owners' => 1, 'text' => 1, 'start' => 1, 'length' => 1] + self::STAMPED,
        'note' => ['key' => 1, 'scope' => 1, 'period' => 1, 'listId' => 1, 'field' => 1, 'text' => 1, 'revision' => 1, 'updatedBy' => 1, 'updatedAt' => 1],
        'list' => ['id' => 1, 'kind' => 1, 'name' => 1, 'color' => 1, 'order' => 1, 'revision' => 1, 'updatedAt' => 1],
        'settings' => ['bothColor' => 1, 'revision' => 1, 'updatedAt' => 1],
        'chore' => ['id' => 1, 'title' => 1, 'owners' => 1, 'cadence' => 1, 'order' => 1, 'revision' => 1, 'updatedBy' => 1, 'updatedAt' => 1],
        'choreMark' => ['id' => 1, 'ruleId' => 1, 'date' => 1, 'state' => 1, 'moved' => 1, 'revision' => 1, 'updatedBy' => 1, 'updatedAt' => 1],
        'rhythm' => ['anchor' => 1, 'start' => 1, 'revision' => 1, 'updatedBy' => 1, 'updatedAt' => 1],
    ];
    private const LIST_OPTIONAL = ['ak' => 1, 'createdBy' => 1];
    private const TASK_OPTIONAL = ['doneOn' => 1];
    /** Names a custom list may not take, in any case: the two people's list ids and the views. */
    private static function reserved(): array { return [...pm_person_lists(), 'both', 'all']; }
    /** What a chore or a turn may belong to: one person, or both (their ids, sorted). */
    private static function choreOwners(): array { $p = pm_person_lists(); return [[$p[0]], [$p[1]], pm_both_owners()]; }

    /** The cause goes to error_log; the exception is a 503 with a generic client message. */
    public static function bad(string $cause, string $message = ''): \RuntimeException {
        error_log('PlanMind storage rejected: ' . $cause);
        return new \RuntimeException($message !== '' ? $message : 'Invalid planner data: ' . $cause);
    }
    private static function need(bool $ok, string $where, string $what): void {
        if (!$ok) { throw self::bad("$where $what"); }
    }

    /**
     * The db a request works on. A missing or empty old (v1) file reads as fresh; an old file with records is converted
     * in memory by MigrateV1 and checked like any v2 db (the file itself is only replaced by the first successful write,
     * see Store). Anything that is not exactly a v1 store fails closed.
     */
    public static function load(array $db): array {
        if ($db === []) { return fresh_db(); }
        if (self::isOld($db)) {
            $keys = array_diff_key($db, ['v' => 1, 'revision' => 1, 'tasks' => 1, 'notes' => 1]);
            self::need(!$keys && is_int($db['revision'] ?? null) && $db['revision'] >= 0 && is_array($db['tasks'] ?? null)
                && is_array($db['notes'] ?? []), 'db', 'is not a recognised old store');
            if (!MigrateV1::holdsRecords($db)) { return ['revision' => $db['revision']] + fresh_db(); }
            $db = MigrateV1::convert($db);
        }
        // A v2 store (0.12.0 and before) gets the seeded chore chart, in memory like the v1 conversion: the first write stores it. A v3 store
        // (0.13.0) only gains the optional `doneOn` of its to-dos, which it has none of. Each step hands the next one its version.
        if (($db['v'] ?? null) === 2) { $db = MigrateV2::convert($db); }
        if (($db['v'] ?? null) === 3) { $db = MigrateV3::convert($db); }
        if (($db['v'] ?? null) === 4) { $db = MigrateV4::convert($db); }
        self::validate($db);
        return $db;
    }
    /** A non-empty db that is not marked v2: what the 0.1.0 version wrote (no `v`, or `v` 1). */
    public static function isOld(array $db): bool { return $db !== [] && (!array_key_exists('v', $db) || $db['v'] === 1); }
    /** The format version a stored db declares: null for no db at all (or a `v` that is no count), 1 for what 0.1.0 wrote, else its `v`. */
    public static function storedVersion(array $db): ?int {
        if ($db === []) { return null; }
        if (self::isOld($db)) { return 1; }
        return is_int($db['v']) ? $db['v'] : null;
    }

    public static function validate(array $db, int $version = MODEL['storeVersion']): void {
        if (($db['v'] ?? null) !== $version) { throw self::bad('the store version is not ' . $version, 'Unsupported data version'); }
        self::fields($db, self::SHAPE['db'], [], 'db');
        self::need(is_int($db['revision']) && $db['revision'] >= 0, 'db', 'revision is not a count');
        foreach (['lists', 'settings', 'tasks', 'priorities', 'events', 'notes', 'chores', 'choreMarks', 'rhythm', 'prefs'] as $collection) {
            self::need(is_array($db[$collection]), 'db', "$collection is not a collection");
        }
        self::need(count($db['tasks']) + count($db['priorities']) + count($db['events']) <= LIMITS['itemsMax'], 'db', 'holds too many items');
        self::need(count($db['notes']) <= LIMITS['notesMax'], 'db', 'holds too many notes');
        self::need(count($db['chores']) <= LIMITS['choresMax'] && count($db['choreMarks']) <= LIMITS['choreMarksMax'], 'db', 'holds too many chores or marks');
        $lists = $db['lists'];
        self::lists($lists);
        self::settings($db['settings']);
        $ids = [];
        foreach (['tasks' => 'task', 'priorities' => 'priority', 'events' => 'event'] as $collection => $kind) {
            foreach ($db[$collection] as $key => $item) {
                $where = "$collection.$key";
                self::fields($item, self::SHAPE[$kind], $kind === 'task' ? self::TASK_OPTIONAL : [], $where);
                self::need(valid_id($item['id']) && $item['id'] === (string)$key, $where, 'id does not match its key');
                self::need(!isset($ids[$item['id']]), $where, 'id is used by another record');
                $ids[$item['id']] = true;
                self::stamped($item, $where);
                self::owners($lists, $item['owners'], $where);
                if ($kind === 'event') { self::event($item, $where, $version === 4 ? LIMITS['eventStep'] : LIMITS['eventMinLength']); }
                else { self::$kind($item, $where); }
            }
        }
        foreach ($db['notes'] as $key => $note) { self::note($lists, $key, $note); }
        self::rhythm($db['rhythm']);
        foreach ($db['chores'] as $key => $rule) { self::chore($key, $rule); }
        foreach ($db['choreMarks'] as $key => $mark) { self::choreMark($db, $key, $mark); }
        self::prefs($db['prefs']);
    }

    /**
     * What a handler's result becomes: the db as given when nothing changed (so nothing is rewritten), else the
     * result with the revision set to exactly +1 (savePrefs: unchanged), whether or not the handler called touch().
     * A handler bug must never reach the file: a store the next read would reject is refused here instead.
     */
    public static function settle(array $given, array $before, array $after, string $action): array {
        if ($after === $before) { return $given; }
        $after['revision'] = $before['revision'] + ($action === 'savePrefs' ? 0 : 1);
        self::validate($after);
        return $after;
    }

    /** The picker state as it may leave the server: dangling lists dropped, overlays unique, custom, capped. */
    public static function selection(array $db, mixed $selection): array {
        $base = is_array($selection) && is_string($selection['base'] ?? null) ? $selection['base'] : 'both';
        if ($base !== 'both' && !isset($db['lists'][$base])) { $base = 'both'; }
        $overlays = [];
        foreach (is_array($selection) && is_array($selection['overlays'] ?? null) ? $selection['overlays'] : [] as $id) {
            if (is_string($id) && $id !== $base && ($db['lists'][$id]['kind'] ?? null) === 'custom' && !in_array($id, $overlays, true)
                && count($overlays) < LIMITS['maxOverlays']) { $overlays[] = $id; }
        }
        return ['base' => $base, 'overlays' => $overlays];
    }

    /** The desktop sidebar as it may leave the server: only the word 'hidden' hides it, anything else reads as shown. */
    public static function sidebar(mixed $value): string { return $value === 'hidden' ? 'hidden' : 'shown'; }

    private static function fields(mixed $record, array $required, array $optional, string $where): void {
        self::need(is_array($record), $where, 'is not a record');
        $missing = array_keys(array_diff_key($required, $record));
        $unknown = array_keys(array_diff_key($record, $required + $optional));
        self::need(!$missing && !$unknown, $where, 'has the wrong fields (missing: ' . implode(',', $missing) . '; unknown: ' . implode(',', $unknown) . ')');
    }
    private static function stamped(array $r, string $where): void {
        self::need(is_int($r['revision']) && $r['revision'] >= 1, $where, 'revision is not a count');
        self::need(in_array($r['createdBy'], pm_person_lists(), true) && in_array($r['updatedBy'], pm_person_lists(), true), $where, 'author is not a person');
        self::need(is_string($r['createdAt']) && is_string($r['updatedAt']), $where, 'timestamps are not text');
        self::need(is_string($r['ak']) && preg_match('/^[a-f0-9]{16}$/D', $r['ak']) === 1, $where, 'ak is malformed');
    }
    /** Canonical owners: one existing list, or exactly the two people's ids, sorted. */
    private static function owners(array $lists, mixed $owners, string $where): void {
        self::need(is_array($owners) && array_is_list($owners), $where, 'owners is not a list');
        if (count($owners) === 1) { self::need(is_string($owners[0]) && isset($lists[$owners[0]]), $where, 'owner is not a list'); }
        else { self::need($owners === pm_both_owners(), $where, 'owners are not canonical'); }
    }
    private static function task(array $t, string $where): void {
        self::need(is_string($t['scope']) && is_string($t['date']) && valid_period($t['scope'], $t['date']), $where, 'date does not start its scope');
        self::need(is_string($t['title']) && is_bool($t['done']) && is_int($t['pos']) && $t['pos'] >= 0, $where, 'has a bad title, done or pos');
        // doneOn: the page a day to-do was ticked on, its own date or a later one; only a done day to-do has one.
        self::need(!array_key_exists('doneOn', $t) || (valid_date($t['doneOn']) && $t['done'] && $t['scope'] === 'day' && $t['doneOn'] >= $t['date']), $where, 'has a bad doneOn');
    }
    private static function priority(array $p, string $where): void {
        self::need(valid_date($p['date']) && is_string($p['text']), $where, 'has a bad date or text');
        $slots = $p['slots'];
        self::need(is_array($slots) && $slots && !array_is_list($slots), $where, 'slots is not a map');
        $keys = array_map('strval', array_keys($slots));
        sort($keys, SORT_STRING);
        self::need($keys === $p['owners'], $where, 'slots keys differ from owners');
        foreach ($slots as $slot) { self::need(is_int($slot) && $slot >= 1 && $slot <= LIMITS['prioritySlots'], $where, 'has a slot outside 1 to ' . LIMITS['prioritySlots']); }
    }
    private static function event(array $e, string $where, int $minimum): void {
        self::need(valid_date($e['date']) && is_string($e['text']), $where, 'has a bad date or text');
        self::need(is_int($e['start']) && is_int($e['length']), $where, 'start and length are not minutes');
        self::need($e['start'] % LIMITS['eventStep'] === 0 && $e['length'] % LIMITS['eventStep'] === 0 && $e['length'] >= $minimum, $where, 'has an invalid start or length');
        self::need($e['start'] >= LIMITS['eventStartMin'] && $e['start'] + $e['length'] <= LIMITS['eventEndMin'], $where, 'is outside the schedule window');
    }
    private static function note(array $lists, mixed $key, mixed $n): void {
        $where = "notes.$key";
        self::fields($n, self::SHAPE['note'], [], $where);
        self::need(is_string($n['scope']) && is_string($n['period']) && is_string($n['listId']) && is_string($n['field']), $where, 'has non-text key parts');
        self::need($key === "$n[scope]:$n[period]:$n[listId]:$n[field]", $where, 'key differs from its fields');
        self::need(valid_period($n['scope'], $n['period']), $where, 'period does not start its scope');
        self::need(in_array($n['field'], MODEL['noteFields'][$n['scope']], true), $where, 'field is not allowed for the scope');
        self::need(isset($lists[$n['listId']]), $where, 'list does not exist');
        self::need(is_string($n['text']) && is_int($n['revision']) && $n['revision'] >= 1, $where, 'has a bad text or revision');
        self::need(in_array($n['updatedBy'], pm_person_lists(), true) && is_string($n['updatedAt']), $where, 'has a bad author or timestamp');
    }
    private static function lists(array $lists): void {
        $people = pm_person_lists();
        self::need(isset($lists[$people[0]], $lists[$people[1]]), 'lists', 'lack a permanent list');
        $names = []; $custom = 0;
        foreach ($lists as $id => $list) {
            $where = "lists.$id";
            self::fields($list, self::SHAPE['list'], self::LIST_OPTIONAL, $where);
            self::need($list['id'] === (string)$id, $where, 'id does not match its key');
            self::need(in_array($list['color'], MODEL['colorKeys'], true), $where, 'color is not in the palette');
            self::need(is_int($list['order']) && is_int($list['revision']) && $list['revision'] >= 1 && is_string($list['updatedAt']), $where, 'has a bad order, revision or timestamp');
            self::need(!isset($list['ak']) || (is_string($list['ak']) && preg_match('/^[a-f0-9]{16}$/D', $list['ak']) === 1), $where, 'ak is malformed');
            self::need(!isset($list['createdBy']) || in_array($list['createdBy'], $people, true), $where, 'author is not a person');
            if (in_array($id, $people, true)) {
                self::need($list['kind'] === 'person' && $list['name'] === ucfirst($id), $where, 'permanent list was changed');
                continue;
            }
            self::need(valid_id($id) && $list['kind'] === 'custom', $where, 'is not a custom list');
            self::need(is_string($list['name']) && $list['name'] !== '' && cps($list['name']) <= LIMITS['listNameChars'], $where, 'name is not 1 to ' . LIMITS['listNameChars'] . ' characters');
            $lower = mb_strtolower($list['name'], 'UTF-8');
            self::need(!in_array($lower, self::reserved(), true) && !isset($names[$lower]), $where, 'name is reserved or used twice');
            $names[$lower] = true;
            self::need(++$custom <= LIMITS['customListsMax'], 'lists', 'hold too many custom lists');
        }
    }
    private static function settings(mixed $settings): void {
        self::fields($settings, self::SHAPE['settings'], [], 'settings');
        self::need(in_array($settings['bothColor'], MODEL['colorKeys'], true), 'settings', 'color is not in the palette');
        self::need(is_int($settings['revision']) && $settings['revision'] >= 1 && is_string($settings['updatedAt']), 'settings', 'has a bad revision or timestamp');
    }
    private static function rhythm(mixed $r): void {
        self::fields($r, self::SHAPE['rhythm'], [], 'rhythm');
        self::need(is_string($r['anchor']) && valid_period('week', $r['anchor']), 'rhythm', 'anchor is not a Monday');
        self::need(valid_date($r['start']) && is_int($r['revision']) && $r['revision'] >= 1, 'rhythm', 'has a bad start or revision');
        self::need(in_array($r['updatedBy'], pm_person_lists(), true) && is_string($r['updatedAt']), 'rhythm', 'has a bad author or timestamp');
    }
    private static function chore(mixed $key, mixed $r): void {
        $where = "chores.$key";
        self::fields($r, self::SHAPE['chore'], [], $where);
        self::need(valid_id($r['id']) && $r['id'] === (string)$key, $where, 'id does not match its key');
        self::need(is_string($r['title']) && $r['title'] !== '' && cps($r['title']) <= LIMITS['choreTitleChars'], $where, 'title is not 1 to ' . LIMITS['choreTitleChars'] . ' characters');
        self::need(is_array($r['owners']) && in_array($r['owners'], self::choreOwners(), true), $where, 'owners are not one person or both');
        self::need(valid_cadence($r['cadence']) === $r['cadence'], $where, 'cadence is malformed');
        self::need(is_int($r['order']) && is_int($r['revision']) && $r['revision'] >= 1, $where, 'has a bad order or revision');
        self::need(in_array($r['updatedBy'], pm_person_lists(), true) && is_string($r['updatedAt']), $where, 'has a bad author or timestamp');
    }
    private static function choreMark(array $db, mixed $key, mixed $m): void {
        $where = "choreMarks.$key";
        self::fields($m, self::SHAPE['choreMark'], ['owners' => 1], $where);
        self::need(is_string($m['ruleId']) && is_string($m['date']) && $m['id'] === $key && $key === "$m[ruleId]:$m[date]", $where, 'id differs from its rule and date');
        self::need(isset($db['chores'][$m['ruleId']]), $where, 'rule does not exist');
        self::need(valid_date($m['date']) && $m['date'] >= $db['rhythm']['start'] && (new \DateTimeImmutable($m['date']))->format('N') !== '6', $where, 'date is before the start or a Saturday');
        self::need(in_array($m['state'], MODEL['choreMarkStates'], true) && is_bool($m['moved']), $where, 'has a bad state or moved');
        self::need(!array_key_exists('owners', $m) || (is_array($m['owners']) && in_array($m['owners'], self::choreOwners(), true)), $where, 'owners are not one person or both');
        self::need($m['state'] !== 'open' || $m['moved'] || array_key_exists('owners', $m), $where, 'is an empty mark');
        self::need(is_int($m['revision']) && $m['revision'] >= 1 && in_array($m['updatedBy'], pm_person_lists(), true) && is_string($m['updatedAt']), $where, 'has a bad revision, author or timestamp');
    }
    private static function prefs(array $prefs): void {
        foreach ($prefs as $user => $pref) {
            $where = "prefs.$user";
            self::need(in_array($user, pm_person_lists(), true), $where, 'is not a person');
            self::fields($pref, ['selection' => 1], ['sidebar' => 1], $where);
            self::need(!array_key_exists('sidebar', $pref) || is_string($pref['sidebar']), $where, 'sidebar is not text');
            $selection = $pref['selection'];
            self::need(is_array($selection) && count($selection) === 2 && is_string($selection['base'] ?? null)
                && is_array($selection['overlays'] ?? null) && array_is_list($selection['overlays']), $where, 'selection is malformed');
            foreach ($selection['overlays'] as $id) { self::need(is_string($id), $where, 'overlay is not an id'); }
        }
    }
}
