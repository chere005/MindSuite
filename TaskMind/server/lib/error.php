<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/limits.php';

/**
 * A caller mistake or a refusal, answered with `status` and a machine-readable `errorCode` (ApiErrorCode in model.ts).
 * A code is optional when the status names it. The property is not called `code`: Exception already owns that name.
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
