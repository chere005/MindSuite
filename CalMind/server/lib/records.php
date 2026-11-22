<?php
/**
 * Where a user's synced records live: one seam, two drivers.
 *
 * Handlers never name a file or a table. They open a RecordSet: rs_tx() for a
 * read-modify-write (serialised per user and space), rs_view() to read. The
 * merge rules (validation, the tie-break, sharing scope) stay in app.php,
 * unchanged, and run the same way over either driver.
 *
 *  - 'json' — the default, and what every instance runs until its config says
 *    otherwise. One encrypted file per user per space (records_file()), read
 *    whole and written whole under a per-file lock. Every sync costs the size
 *    of the whole store: decrypt, decode, merge, encode, encrypt, rename.
 *
 *  - 'sql' — built and OFF. One row per record in a PDO database: SQLite for
 *    local runs and tests, MySQL/MariaDB on a host (docs/PUBLIC-MODEL.md says
 *    why not SQLite there). A sync reads the rows it touches and the rows past
 *    the client's cursor through an index on seq, so its cost follows the
 *    change, not the store. Clear metadata (id, type, updated, deleted, seq)
 *    sits in columns, as it already must for the merge; the payload is
 *    encrypted per row with AES-256-GCM, bound to its space, owner and id so a
 *    row cannot be moved under another name and still decrypt.
 *
 * Selected by `storage` in config.php ('json' | 'sql') or CALMIND_STORAGE;
 * the database by `storage_dsn` (+ `storage_user`, `storage_pass`) or
 * CALMIND_STORAGE_DSN, defaulting to SQLite in the data dir.
 */

require_once __DIR__ . '/store.php';

/**
 * One record file per user PER SPACE.
 *
 * The default space is CalMind's and its filename is unchanged, byte for byte,
 * because every existing store is already at that path.
 *
 * MealMind (the owner, 2026-08-21) is a second app on this same server that reuses
 * these accounts and keeps its own reminders and notes. It sends space='chef'
 * and lands in records-chef-<user>.json. Nothing else about it is different:
 * same auth, same tokens, same merge, same lock discipline — the space is only
 * WHICH FILE.
 *
 * Sharing, the meeting-request pair and the widget feed all call this with no
 * space and therefore always mean CalMind's store. That is deliberate rather
 * than an oversight: a partnership is between two CalMind accounts, and a
 * MealMind note is not something either of them has agreed to share.
 */
function records_file(array $cfg, string $user, string $space = ''): string
{
    // THE COLLISION THIS NAMING HAS. CalMind's store of `chef-alex` and the
    // chef space's store of `alex` are the same file, and both names are
    // legal, so an account called chef-<name> would sync straight into that
    // person's MealMind records. Refused here, below every handler, so no road
    // reaches it; sign-up refuses the names too (rs_name_reserved). The
    // database driver keys space and owner apart and never had it.
    if ($space === '' && rs_name_reserved($user)) {
        throw new RuntimeException('records: a name that begins with a space and a dash has no CalMind store');
    }
    $prefix = $space === '' ? 'records-' : 'records-' . $space . '-';
    return $cfg['data_dir'] . '/' . $prefix . $user . '.json';
}

/** Does $user begin `<space>-` for a sync space? Such a name's CalMind file would be another person's space store. */
function rs_name_reserved(string $user): bool
{
    foreach (defined('SYNC_SPACES') ? SYNC_SPACES : ['chef'] as $space) {
        if (stripos($user, $space . '-') === 0) { return true; }
    }
    return false;
}

interface RecordSet
{
    /** The highest sequence number handed out in this store (0 when empty). */
    public function seq(): int;
    /** The stored row, with its `seq`, or null. */
    public function get(string $id): ?array;
    /** Store a row under the next sequence number; returns it. The row is rebuilt from the record's fixed keys. */
    public function put(array $row): int;
    /** Every row with seq > $cursor, ascending by seq, each with its `seq`. */
    public function since(int $cursor): array;
    /** id => row for every row, tombstones included; one type only when $type is given. */
    public function all(?string $type = null): array;
}

/** The record's fixed shape. A key not named here does not survive a write (handle_sync explains why). */
function rs_row(array $row, int $seq): array
{
    $out = ['id' => (string) $row['id'], 'type' => (string) $row['type'], 'updated' => (int) $row['updated'],
            'deleted' => !empty($row['deleted']), 'payload' => $row['payload'] ?? null, 'seq' => $seq];
    if (!empty($row['superseded'])) { $out['superseded'] = true; }
    return $out;
}

function rs_driver(array $cfg): string
{
    $d = (string) ($cfg['storage'] ?? (getenv('CALMIND_STORAGE') ?: 'json'));
    if ($d !== 'json' && $d !== 'sql') { throw new RuntimeException('records: unknown storage driver'); }
    return $d;
}

/** Run $fn(RecordSet) as one read-modify-write of $user's store in $space; writes land only if $fn returns. */
function rs_tx(array $cfg, string $user, string $space, callable $fn): mixed
{
    return rs_driver($cfg) === 'sql'
        ? rs_sql_tx($cfg, $space, $user, $fn)
        : rs_json_tx($cfg, records_file($cfg, $user, $space), rs_json_lock($user, $space), $fn);
}

/** A read-only view of $user's store in $space. */
function rs_view(array $cfg, string $user, string $space): RecordSet
{
    return rs_driver($cfg) === 'sql'
        ? new SqlRecordSet(rs_pdo($cfg), rs_cipher($cfg), $space, $user, false)
        : JsonRecordSet::open($cfg, records_file($cfg, $user, $space));
}

/** Delete $user's whole store in $space. */
function rs_drop(array $cfg, string $user, string $space): void
{
    if (rs_driver($cfg) === 'sql') {
        rs_sql_tx($cfg, $space, $user, function (SqlRecordSet $rs) { $rs->drop(); });
        return;
    }
    $file = records_file($cfg, $user, $space);
    with_lock($cfg, rs_json_lock($user, $space), function () use ($file) {
        if (is_file($file) && !unlink($file)) { throw new RuntimeException('could not delete account records'); }
    });
}

/**
 * Run $fn(RecordSet) as a read-modify-write over every OTHER user's store
 * (any space) that holds a record of $type. Account deletion uses it to take
 * the deleted name out of everyone's share record.
 */
function rs_each_with_type(array $cfg, string $type, string $exceptUser, callable $fn): void
{
    if (rs_driver($cfg) === 'sql') {
        $q = rs_pdo($cfg)->prepare('SELECT DISTINCT space, owner FROM rs_records WHERE type = ? AND owner <> ?');
        $q->execute([$type, $exceptUser]);
        foreach ($q->fetchAll(PDO::FETCH_NUM) as [$space, $owner]) {
            rs_sql_tx($cfg, (string) $space, (string) $owner, $fn);
        }
        return;
    }
    // The files are walked rather than named: a name cannot be recovered
    // from a filename (records-chef-x.json is MealMind's x or CalMind's
    // chef-x), and the walk never needs it. The lock is the file's own name,
    // which is exactly the name handle_sync locks it under.
    $mine = array_map(fn($s) => records_file($cfg, $exceptUser, $s), array_merge([''], SYNC_SPACES));
    foreach (glob($cfg['data_dir'] . '/records-*.json') ?: [] as $file) {
        if (in_array($file, $mine, true)) { continue; }
        rs_json_tx($cfg, $file, basename($file, '.json'), function (JsonRecordSet $rs) use ($fn, $type) {
            if ($rs->missing() || $rs->all($type) === []) { return; }
            $fn($rs);
        });
    }
}

/** A whole store as {seq, recs} (rows keep their seq), or null when it does not exist. Migration and tests. */
function rs_export(array $cfg, string $user, string $space): ?array
{
    $rs = rs_view($cfg, $user, $space);
    if ($rs instanceof JsonRecordSet && $rs->missing()) { return null; }
    $recs = $rs->all();
    if ($rs instanceof SqlRecordSet && $recs === [] && $rs->seq() === 0) { return null; }
    return ['seq' => $rs->seq(), 'recs' => $recs];
}

/** Replace a whole store with {seq, recs}, keeping every row's seq. Migration and tests; never a request. */
function rs_import(array $cfg, string $user, string $space, array $db): void
{
    $seq  = (int) ($db['seq'] ?? 0);
    $recs = is_array($db['recs'] ?? null) ? $db['recs'] : [];
    if (rs_driver($cfg) === 'sql') {
        rs_sql_tx($cfg, $space, $user, function (SqlRecordSet $rs) use ($seq, $recs) { $rs->replaceAll($seq, $recs); });
        return;
    }
    with_lock($cfg, rs_json_lock($user, $space), function () use ($cfg, $user, $space, $seq, $recs) {
        store_write($cfg, records_file($cfg, $user, $space), ['seq' => $seq, 'recs' => $recs]);
    });
}

// ---------------------------------------------------------------- json

function rs_json_lock(string $user, string $space): string
{
    return 'records-' . ($space === '' ? '' : $space . '-') . $user;
}

function rs_json_tx(array $cfg, string $file, string $lock, callable $fn): mixed
{
    return with_lock($cfg, $lock, function () use ($cfg, $file, $fn) {
        $rs  = JsonRecordSet::open($cfg, $file);
        $out = $fn($rs);
        $rs->commit();
        return $out;
    });
}

final class JsonRecordSet implements RecordSet
{
    private bool $dirty = false;

    private function __construct(
        private array $cfg,
        private string $file,
        private int $seq,
        private array $recs,
        private bool $exists,
        private bool $plain,
    ) {}

    public static function open(array $cfg, string $file): self
    {
        $exists = is_file($file);
        // A store still in legacy plaintext is rewritten on the next write
        // even when nothing changed, so it reaches encryption at rest the way
        // it always has: on its first sync.
        $plain  = $exists && (string) @file_get_contents($file, false, null, 0, 5) !== 'ENC1:';
        $db     = store_read($cfg, $file);
        return new self($cfg, $file, (int) ($db['seq'] ?? 0),
            is_array($db['recs'] ?? null) ? $db['recs'] : [], $exists, $plain);
    }

    public function missing(): bool { return !$this->exists; }
    public function seq(): int { return $this->seq; }
    public function get(string $id): ?array { return $this->recs[$id] ?? null; }

    public function put(array $row): int
    {
        $this->recs[(string) $row['id']] = rs_row($row, ++$this->seq);
        $this->dirty = true;
        return $this->seq;
    }

    public function since(int $cursor): array
    {
        $tail = array_values(array_filter($this->recs, fn($r) => (int) ($r['seq'] ?? 0) > $cursor));
        usort($tail, fn($a, $b) => $a['seq'] <=> $b['seq']);
        return $tail;
    }

    public function all(?string $type = null): array
    {
        return $type === null ? $this->recs
            : array_filter($this->recs, fn($r) => is_array($r) && ($r['type'] ?? '') === $type);
    }

    /** Written only when something changed (or the file is legacy plaintext). A no-op sync no longer rewrites the store. */
    public function commit(): void
    {
        if (!$this->dirty && !$this->plain) { return; }
        store_write($this->cfg, $this->file, ['seq' => $this->seq, 'recs' => $this->recs]);
        $this->dirty = $this->plain = false;
        $this->exists = true;
    }
}

// ---------------------------------------------------------------- sql

/** One connection per DSN per request; the schema is made on first use. */
function rs_pdo(array $cfg): PDO
{
    static $pool = [];
    $dsn = (string) ($cfg['storage_dsn'] ?? (getenv('CALMIND_STORAGE_DSN') ?: ''));
    if ($dsn === '') { $dsn = 'sqlite:' . $cfg['data_dir'] . '/records.sqlite'; }
    if (isset($pool[$dsn])) { return $pool[$dsn]; }
    if (str_starts_with($dsn, 'sqlite:')) {
        $path = substr($dsn, 7);
        if ($path !== ':memory:') { @mkdir(dirname($path), 0700, true); }
    }
    $pdo = new PDO($dsn, $cfg['storage_user'] ?? null, $cfg['storage_pass'] ?? null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    $kind = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($kind === 'sqlite') {
        if (str_starts_with($dsn, 'sqlite:/') && is_file(substr($dsn, 7))) { @chmod(substr($dsn, 7), 0600); }
        // A writer waits for another rather than failing at once. The journal
        // stays the rollback default: WAL needs shared memory on one machine,
        // and a host may serve requests from several (docs/PUBLIC-MODEL.md).
        $pdo->exec('PRAGMA busy_timeout = 10000');
        $pdo->exec('PRAGMA foreign_keys = ON');
    } elseif ($kind !== 'mysql') {
        throw new RuntimeException('records: storage supports sqlite and mysql only');
    }
    rs_schema($pdo, $kind);
    return $pool[$dsn] = $pdo;
}

/**
 * Two tables. rs_records is one row per record, keyed (space, owner, id);
 * rs_heads is each store's sequence counter — the row a writer locks, so two
 * syncs of one store queue while different stores proceed side by side.
 * Names and ids are compared byte for byte (ascii_bin on MySQL; SQLite is
 * binary already): `Alex` and `alex` are different stores, as their files were.
 */
function rs_schema(PDO $pdo, string $kind): void
{
    $key  = $kind === 'mysql' ? 'VARCHAR(%d) CHARACTER SET ascii COLLATE ascii_bin NOT NULL' : 'TEXT NOT NULL';
    $blob = $kind === 'mysql' ? 'MEDIUMTEXT CHARACTER SET ascii NOT NULL' : 'TEXT NOT NULL';
    $tail = $kind === 'mysql' ? ' ENGINE=InnoDB' : '';
    $pdo->exec('CREATE TABLE IF NOT EXISTS rs_heads (space ' . sprintf($key, 16) . ', owner ' . sprintf($key, 64)
        . ', seq BIGINT NOT NULL, PRIMARY KEY (space, owner))' . $tail);
    $pdo->exec('CREATE TABLE IF NOT EXISTS rs_records (space ' . sprintf($key, 16) . ', owner ' . sprintf($key, 64)
        . ', id ' . sprintf($key, 64) . ', type ' . sprintf($key, 20)
        . ', updated BIGINT NOT NULL, deleted SMALLINT NOT NULL, superseded SMALLINT NOT NULL DEFAULT 0'
        . ', seq BIGINT NOT NULL, payload ' . $blob . ', PRIMARY KEY (space, owner, id))' . $tail);
    // MySQL has no CREATE INDEX IF NOT EXISTS; the table's own existence is the guard.
    $has = $kind === 'mysql'
        ? (int) $pdo->query("SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'rs_records' AND index_name = 'rs_records_seq'")->fetchColumn() > 0
        : false;
    if (!$has) {
        $ine = $kind === 'mysql' ? '' : 'IF NOT EXISTS ';
        $pdo->exec('CREATE INDEX ' . $ine . 'rs_records_seq ON rs_records (space, owner, seq)');
        $pdo->exec('CREATE INDEX ' . $ine . 'rs_records_type ON rs_records (type, owner)');
    }
}

/** The payload key, derived from the store key so one secret still unlocks the instance. */
function rs_cipher(array $cfg): string
{
    return hash_hmac('sha256', 'calmind-records-v1', store_key($cfg), true);
}

/**
 * One serialised read-modify-write. SQLite takes the database's write lock up
 * front (BEGIN IMMEDIATE); MySQL locks this store's head row. Anything thrown
 * rolls back; a request that exits mid-way (fail()) drops the connection,
 * which rolls back too — nothing half-written can land.
 */
function rs_sql_tx(array $cfg, string $space, string $owner, callable $fn): mixed
{
    $pdo  = rs_pdo($cfg);
    $lite = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
    if ($lite) { $pdo->exec('BEGIN IMMEDIATE'); } else { $pdo->beginTransaction(); }
    try {
        $rs  = new SqlRecordSet($pdo, rs_cipher($cfg), $space, $owner, true);
        $out = $fn($rs);
        $rs->flushHead();
        if ($lite) { $pdo->exec('COMMIT'); } else { $pdo->commit(); }
        return $out;
    } catch (Throwable $e) {
        if ($lite) { $pdo->exec('ROLLBACK'); } elseif ($pdo->inTransaction()) { $pdo->rollBack(); }
        throw $e;
    }
}

final class SqlRecordSet implements RecordSet
{
    private int $seq;
    private int $headSeq;

    public function __construct(
        private PDO $pdo,
        private string $key,
        private string $space,
        private string $owner,
        private bool $writable,
    ) {
        $q = $this->pdo->prepare('SELECT seq FROM rs_heads WHERE space = ? AND owner = ?'
            . ($writable && $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : ''));
        $q->execute([$space, $owner]);
        $this->seq = $this->headSeq = (int) ($q->fetchColumn() ?: 0);
    }

    public function seq(): int { return $this->seq; }

    public function get(string $id): ?array
    {
        $q = $this->pdo->prepare('SELECT * FROM rs_records WHERE space = ? AND owner = ? AND id = ?');
        $q->execute([$this->space, $this->owner, $id]);
        $r = $q->fetch();
        return $r === false ? null : $this->decode($r);
    }

    public function put(array $row): int
    {
        if (!$this->writable) { throw new LogicException('records: write through a read-only view'); }
        $this->write(rs_row($row, ++$this->seq));
        return $this->seq;
    }

    public function since(int $cursor): array
    {
        $q = $this->pdo->prepare('SELECT * FROM rs_records WHERE space = ? AND owner = ? AND seq > ? ORDER BY seq');
        $q->execute([$this->space, $this->owner, $cursor]);
        return array_map(fn($r) => $this->decode($r), $q->fetchAll());
    }

    public function all(?string $type = null): array
    {
        $q = $this->pdo->prepare('SELECT * FROM rs_records WHERE space = ? AND owner = ?' . ($type === null ? '' : ' AND type = ?') . ' ORDER BY seq');
        $q->execute($type === null ? [$this->space, $this->owner] : [$this->space, $this->owner, $type]);
        $out = [];
        foreach ($q->fetchAll() as $r) { $out[(string) $r['id']] = $this->decode($r); }
        return $out;
    }

    /** Migration and tests: the store becomes exactly $recs at $seq, each row keeping its own seq. */
    public function replaceAll(int $seq, array $recs): void
    {
        $this->drop();
        foreach ($recs as $id => $r) {
            if (!is_array($r)) { continue; }
            $this->write(rs_row(['id' => (string) ($r['id'] ?? $id)] + $r, (int) ($r['seq'] ?? 0)));
        }
        $this->seq = $seq;
    }

    public function drop(): void
    {
        foreach (['rs_records', 'rs_heads'] as $t) {
            $this->pdo->prepare("DELETE FROM $t WHERE space = ? AND owner = ?")->execute([$this->space, $this->owner]);
        }
        $this->seq = $this->headSeq = 0;
    }

    /** The store's counter, written once at the end of the transaction. */
    public function flushHead(): void
    {
        if ($this->seq === $this->headSeq) { return; }
        $this->pdo->prepare('REPLACE INTO rs_heads (space, owner, seq) VALUES (?, ?, ?)')
            ->execute([$this->space, $this->owner, $this->seq]);
        $this->headSeq = $this->seq;
    }

    private function write(array $row): void
    {
        $this->pdo->prepare('REPLACE INTO rs_records (space, owner, id, type, updated, deleted, superseded, seq, payload)'
            . ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$this->space, $this->owner, $row['id'], $row['type'], $row['updated'], $row['deleted'] ? 1 : 0,
                       empty($row['superseded']) ? 0 : 1, $row['seq'], $this->seal($row['id'], $row['payload'])]);
    }

    private function decode(array $r): array
    {
        $row = ['id' => (string) $r['id'], 'type' => (string) $r['type'], 'updated' => (int) $r['updated'],
                'deleted' => (int) $r['deleted'] === 1, 'payload' => $this->open((string) $r['id'], (string) $r['payload']),
                'seq' => (int) $r['seq']];
        if ((int) $r['superseded'] === 1) { $row['superseded'] = true; }
        return $row;
    }

    private function aad(string $id): string
    {
        return $this->space . "\0" . $this->owner . "\0" . $id;
    }

    private function seal(string $id, mixed $payload): string
    {
        $json = json_encode($payload, JSON_UNESCAPED_SLASHES);
        if ($json === false) { throw new RuntimeException('records: could not encode a payload — ' . json_last_error_msg()); }
        $iv  = random_bytes(12);
        $tag = '';
        $ct  = openssl_encrypt($json, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag, $this->aad($id));
        if ($ct === false) { throw new RuntimeException('records: could not encrypt a payload'); }
        return 'ENC2:' . base64_encode($iv . $tag . $ct);
    }

    /** A row that will not decrypt is damage, never an empty payload — refused, as store_read refuses a bad file. */
    private function open(string $id, string $sealed): mixed
    {
        $bin = str_starts_with($sealed, 'ENC2:') ? base64_decode(substr($sealed, 5), true) : false;
        $json = $bin === false || strlen($bin) < 28 ? false
            : openssl_decrypt(substr($bin, 28), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA,
                substr($bin, 0, 12), substr($bin, 12, 16), $this->aad($id));
        if ($json === false) { throw new RuntimeException('records: a stored payload will not decrypt (wrong key, moved or damaged)'); }
        return json_decode($json, true);
    }
}
