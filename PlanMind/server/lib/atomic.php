<?php
declare(strict_types=1);
namespace MindSuite\Files;

/** Create a private storage directory, or fail without pretending it exists. */
function ensure_directory(string $dir): void
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new \RuntimeException('Cannot create storage directory.');
    }
}

/** Publish complete bytes using a same-directory temporary file and atomic rename. */
function atomic_write(string $file, string $bytes): void
{
    ensure_directory(dirname($file));
    $tmp = $file . '.' . bin2hex(random_bytes(12)) . '.tmp';
    $stream = @fopen($tmp, 'xb');
    if ($stream === false) { throw new \RuntimeException('Cannot create temporary storage file.'); }
    try {
        if (!@chmod($tmp, 0600)) { throw new \RuntimeException('Cannot secure temporary storage file.'); }
        $offset = 0;
        while ($offset < strlen($bytes)) {
            $written = fwrite($stream, substr($bytes, $offset));
            if ($written === false || $written === 0) { throw new \RuntimeException('Cannot write storage file.'); }
            $offset += $written;
        }
        if (!fflush($stream) || !fsync($stream)) { throw new \RuntimeException('Cannot flush storage file.'); }
        fclose($stream);
        $stream = null;
        if (!@rename($tmp, $file)) { throw new \RuntimeException('Cannot publish storage file.'); }
    } finally {
        if (is_resource($stream)) { fclose($stream); }
        if (is_file($tmp)) { @unlink($tmp); }
    }
}

/** Serialize the complete read-modify-write operation; lock failures fail closed. */
function with_file_lock(string $file, callable $fn): mixed
{
    ensure_directory(dirname($file));
    $stream = @fopen($file, 'c');
    if ($stream === false) { throw new \RuntimeException('Cannot open storage lock.'); }
    try {
        if (!@chmod($file, 0600) || !flock($stream, LOCK_EX)) {
            throw new \RuntimeException('Cannot acquire storage lock.');
        }
        return $fn();
    } finally {
        flock($stream, LOCK_UN);
        fclose($stream);
    }
}
