# PDO and database changes

Follow the application's chosen engine. PDO provides a common API, but SQL syntax, types, locking and migrations are not interchangeable between engines.

```php
$pdo = new PDO($dsn, $user, $password, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false, // where supported by the driver
]);
$stmt = $pdo->prepare('SELECT id, title FROM notes WHERE owner_id = ? AND id = ?');
$stmt->execute([$ownerId, $noteId]);
```

- Bind values. Table names, column names and sort directions require an explicit allowlist; placeholders cannot represent identifiers.
- Use transactions for related changes, with rollback on failure. Handle conflicts/deadlocks according to the engine and retry only when the complete operation is safe to repeat.
- Keep ordered migrations and record applied versions. Validate on the actual engine, and verify recovery before a destructive migration. Never use a production database as a test fixture.
- Enable SQLite foreign keys on every connection. WAL permits readers alongside a writer but still has a single writer and requires all processes to use the same host; do not enable it blindly on network storage. Configure a suitable busy timeout and bound retries.
- Use `utf8mb4` for MySQL text connections. For PostgreSQL generated IDs, use `INSERT ... RETURNING` when appropriate. Do not assume `lastInsertId()` has identical semantics across drivers.
- Use a least-privilege application account. Keep credentials outside the web root and Git. Log database failures without returning queries or credentials to clients.
- Add indexes from observed filter/join patterns and inspect query plans. Avoid per-row round trips when a bounded query can retrieve the required data.

Sources: [PDO prepare](https://www.php.net/manual/en/pdo.prepare.php), [PDO transactions](https://www.php.net/manual/en/pdo.transactions.php), [SQLite WAL limitations](https://sqlite.org/wal.html), [SQLite foreign keys](https://sqlite.org/foreignkeys.html). For host setup, use the [NearlyFreeSpeech database notes](../../nearlyfreespeech/references/databases.md).
