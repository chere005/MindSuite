<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/atomic.php';
require_once __DIR__ . '/limits.php';
require_once __DIR__ . '/error.php';
use function MindSuite\Files\atomic_write;
use function MindSuite\Files\with_file_lock;

/** Authenticated encryption for the team workspace and the login-attempt ledger. */
final class Store {
    public function __construct(private readonly string $dir) {}
    /** The private directory the store keeps its files in; the sign-in caps ledger (login_limit.php) sits beside the encrypted stores. */
    public function directory(): string { return $this->dir; }
    /** A key for `$purpose` derived from the store key, so a plain file can keep hashes that cannot be guessed back from a name alone. */
    public function derive(string $purpose): string { return hash_hmac('sha256', $purpose, $this->key(), true); }
    /**
     * Runs `$change($stored, $exists)` under the store's lock and writes what it returns when that differs. `$stored` is [] and
     * `$exists` false only when the file is not there at all; a file that is there but cannot be read or authenticated throws.
     */
    public function transaction(string $name, callable $change): array {
        if (!in_array($name, ['workspace', 'attempts'], true)) { throw new \InvalidArgumentException('Unknown store.'); }
        return with_file_lock($this->dir . '/.' . $name . '.lock', function () use ($name, $change) {
            $file = $this->dir . '/' . $name . '.enc';
            $exists = file_exists($file);
            $before = $exists ? $this->read($file) : [];
            $after = $change($before, $exists);
            if ($after !== $before) {
                $plain = json_encode($after, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                if (strlen($plain) > LIMITS['workspaceBytesMax']) { throw new RequestError('The workspace is full.', 409, 'store_full'); }
                $nonce = random_bytes(12); $tag = '';
                $cipher = openssl_encrypt($plain, 'aes-256-gcm', $this->key(), OPENSSL_RAW_DATA, $nonce, $tag, 'TaskMind:' . $name, 16);
                if ($cipher === false) { throw new \RuntimeException('Encryption failed.'); }
                // The first write that stores a newer version than the file holds: the old file's bytes are saved untouched before they are replaced.
                if ($name === 'workspace') {
                    [$was, $now] = [self::storedVersion($before), self::storedVersion($after)];
                    if ($was !== null && $now !== null && $was < $now) { $this->keepOldFile($file, $was); }
                    if ($now !== null) { $this->markVersion($now); }
                }
                atomic_write($file, 'TM1:' . base64_encode($nonce . $tag . $cipher));
            }
            return $after;
        });
    }
    /**
     * Whether this data directory has ever held a workspace: its version marker or a version backup is there. A workspace file that
     * is missing where these exist was lost, not never made, and must not be seeded over.
     */
    public function hadWorkspace(): bool {
        return file_exists($this->dir . '/workspace.version') || (bool)glob($this->dir . '/workspace.v*.enc.bak');
    }
    /** The format version a stored workspace names (`v`), or null when it names none (nothing stored yet). */
    private static function storedVersion(array $db): ?int { return is_int($db['v'] ?? null) ? $db['v'] : null; }
    /**
     * Saves the old file's exact bytes once as workspace.v<version>.enc.bak (private like every file here), so a conversion can always be
     * undone by putting them back as workspace.enc (and deleting workspace.version, which names the newer version). An existing backup is
     * never overwritten: it may be the very same file (an earlier write that stopped after this step), otherwise the write is refused
     * rather than lose the only copy.
     */
    private function keepOldFile(string $file, int $version): void {
        $name = "workspace.v$version.enc.bak";
        $backup = $this->dir . '/' . $name;
        $original = file_get_contents($file);
        if ($original === false) { throw new \RuntimeException('Cannot read the old storage to back it up.'); }
        if (file_exists($backup)) {
            if (file_get_contents($backup) !== $original) { throw new \RuntimeException("$name already exists and is not the old store; move it aside."); }
            return;
        }
        atomic_write($backup, $original);
    }
    /**
     * workspace.version: the version number and a newline, in plain text, so tools/deploy.sh can read over ssh (no key, no data) which store
     * format the data directory holds before it points the site at an older release. It is written before the file it describes, so it is
     * never below the file's version: a write that stops between the two leaves it ahead, which only refuses a rollback that could have
     * been allowed, never allows one that cannot read the data. Rewritten only when the number changes. Unlike every other file here it is
     * readable by the group (0640): the deploy user is in group web, not the web user that writes it, and a number is no secret.
     */
    private function markVersion(int $version): void {
        $marker = $this->dir . '/workspace.version';
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
        $raw = file_get_contents($file);
        if ($raw === false || !str_starts_with($raw, 'TM1:')) { throw new \RuntimeException('Unreadable storage.'); }
        $bytes = base64_decode(substr($raw, 4), true);
        if ($bytes === false || strlen($bytes) < 29) { throw new \RuntimeException('Damaged storage.'); }
        $plain = openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', $this->key(), OPENSSL_RAW_DATA,
            substr($bytes, 0, 12), substr($bytes, 12, 16), 'TaskMind:' . basename($file, '.enc'));
        if ($plain === false) { throw new \RuntimeException('Storage authentication failed.'); }
        $data = json_decode($plain, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($data)) { throw new \RuntimeException('Invalid storage.'); }
        return $data;
    }
}
