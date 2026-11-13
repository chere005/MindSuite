<?php
declare(strict_types=1);
// RequestError: every status that has a default code agrees with the table generated from model.ts, and nothing else is accepted.
use TaskMind\{RequestError};
use const TaskMind\MODEL;

foreach ([400 => 'invalid', 401 => 'unauthorized', 403 => 'forbidden', 405 => 'method_not_allowed', 409 => 'stale', 413 => 'payload_too_large',
          415 => 'unsupported_media', 429 => 'rate_limited', 503 => 'unavailable'] as $status => $code) {
    $e = new RequestError('x', $status);
    check($e->errorCode === $code, "status $status means $code, got {$e->errorCode}");
    check(MODEL['errorStatus'][$code] === $status, "ERROR_STATUS answers $code with $status");
    check($e->body() === ['error' => 'x', 'code' => $code], "the body of $status");
}
check((new RequestError('Too much.', 409, 'store_full'))->errorCode === 'store_full', 'a code named beside its status');
check((new RequestError('Too long.', 400, 'invalid', 'titleChars'))->body() === ['error' => 'Too long.', 'code' => 'invalid', 'cap' => 'titleChars'], 'a cap is named in the body');
check((new RequestError('CSRF.', 403, 'csrf'))->body()['code'] === 'csrf', 'csrf is a 403');
foreach ([[418, ''], [400, 'forbidden'], [403, 'invalid'], [409, 'unavailable']] as [$status, $code]) {
    fails(fn() => new RequestError('x', $status, $code), $code === '' ? 'No default error code' : 'does not answer with status');
}
fails(fn() => new RequestError('x', 400, 'invalid', 'noSuchCap'), 'Unknown cap');
// Every status of the table is one the error class can answer (a new code in model.ts needs its row in BY_STATUS or a named code).
foreach (MODEL['errorStatus'] as $code => $status) { check((new RequestError('x', $status, $code))->errorCode === $code, "$code can be raised"); }
