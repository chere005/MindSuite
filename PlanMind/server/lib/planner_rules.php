<?php
declare(strict_types=1);
namespace PlanMind;
require_once __DIR__ . '/limits.php';

/** Rules every handler shares. Throw RequestError for caller mistakes; nothing here touches storage. */

function valid_id(mixed $id): bool {
    return is_string($id) && preg_match('/^[a-f0-9-]{36}$/D', $id) === 1;
}
function valid_date(mixed $date): bool {
    if (!is_string($date) || !preg_match('/^(20\d{2})-(\d{2})-(\d{2})$/D', $date, $m)) { return false; }
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}
/** A real date that starts its period: any day, a Monday for week, the first for month. */
function valid_period(string $scope, string $date): bool {
    if (!valid_date($date)) { return false; }
    return match ($scope) {
        'day' => true,
        'week' => (new \DateTimeImmutable($date))->format('N') === '1',
        'month' => substr($date, 8) === '01',
        default => false,
    };
}
/** Length in Unicode code points, the unit of every text cap. */
function cps(string $text): int { return mb_strlen($text, 'UTF-8'); }

/**
 * Valid UTF-8 text. Single-line fields are trimmed, non-empty and free of control and line-separator
 * characters. Multi-line text (notes) keeps its spacing, turns CRLF and CR into LF, allows only tab and
 * newline as control characters, and may be empty (clearing a note). `text_too_long` means only the length failed.
 */
function clean_text(mixed $text, int $max, bool $single): string {
    if (!is_string($text) || preg_match('//u', $text) !== 1) { throw new RequestError('Use plain text.', 400, 'invalid'); }
    if ($single) {
        $text = preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $text) ?? '';
        if ($text === '') { throw new RequestError('Enter some text.', 400, 'invalid'); }
        if (preg_match('/[\p{Cc}\p{Zl}\p{Zp}]/u', $text) === 1) { throw new RequestError('Use a single line of text.', 400, 'invalid'); }
    } else {
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        if (preg_match('/(?![\t\n])\p{Cc}/u', $text) === 1) { throw new RequestError('That text contains characters PlanMind cannot store.', 400, 'invalid'); }
    }
    if (cps($text) > $max) { throw new RequestError("Use at most $max characters.", 400, 'text_too_long'); }
    return $text;
}

/**
 * The owners of a new or edited item in canonical form: sorted, unique, and either one list or exactly
 * the two people's ids. A bad shape is 400 invalid; a well-formed list id that is not in the store is 409 gone.
 */
function canonical_owners(array $db, mixed $owners): array {
    $bad = fn() => new RequestError('Choose one list, or Both.', 400, 'invalid');
    if (!is_array($owners) || !array_is_list($owners) || count($owners) < 1 || count($owners) > 2) { throw $bad(); }
    foreach ($owners as $owner) {
        if (!is_string($owner) || !(in_array($owner, pm_person_lists(), true) || valid_id($owner))) { throw $bad(); }
    }
    if (count(array_unique($owners)) !== count($owners)) { throw $bad(); }
    sort($owners, SORT_STRING);
    if (count($owners) === 2 && $owners !== pm_both_owners()) { throw $bad(); }
    foreach ($owners as $owner) {
        if (!isset($db['lists'][$owner])) { throw new RequestError('That list was removed. Refresh to see the latest.', 409, 'gone'); }
    }
    return $owners;
}

/** Character limit of an entry. `todo` and `note` depend on the scope; the rest only on whether it is linked. */
function item_text_limit(string $kind, array $owners, string $scope = 'day'): int {
    if (!in_array($scope, ['day', 'week', 'month'], true)) { throw new \InvalidArgumentException('Unknown scope.'); }
    $linked = count($owners) === 2;
    return match ($kind) {
        'event' => LIMITS[$linked ? 'dayEventTextLinked' : 'dayEventText'],
        'priority' => LIMITS[$linked ? 'dayPriorityTextLinked' : 'dayPriorityText'],
        'todo' => LIMITS[$scope === 'day' ? 'dayTodoText' : 'periodTodoText'],
        'note' => LIMITS[$scope === 'day' ? 'dayNotesChars' : 'docChars'],
        default => throw new \InvalidArgumentException('Unknown item kind.'),
    };
}

/**
 * Open day to-dos of one list on one date. A linked to-do counts for both of its owners. On `$today` the list also holds the
 * open to-dos dated before it, which the Day view carries over (the owner, 2026-10-31), so they count against the cap there too.
 */
function open_count(array $db, string $listId, string $date, ?string $excludeId, ?string $today = null): int {
    $count = 0;
    foreach ($db['tasks'] as $task) {
        if ($task['scope'] === 'day' && !$task['done'] && $task['id'] !== $excludeId && in_array($listId, $task['owners'], true)
            && ($task['date'] === $date || carried_to($task, $date, $today))) { ++$count; }
    }
    return $count;
}
/** An open day to-do dated before `$today` is listed on today's Day view as well (core's isCarried): `$date` is the day being counted. */
function carried_to(array $task, string $date, ?string $today): bool {
    return $today !== null && $today === $date && $task['scope'] === 'day' && !$task['done'] && $task['date'] < $date;
}
/** The date in a timezone, as the client's todayIn gives it: the day that decides which to-dos are carried. */
function today_in(string $timezone, ?\DateTimeInterface $now = null): string {
    return \DateTimeImmutable::createFromInterface($now ?? new \DateTimeImmutable())->setTimezone(new \DateTimeZone($timezone))->format('Y-m-d');
}

/** The earliest event that shares an owner's lane with the span [start, start + length); touching is fine. */
function find_event_overlap(array $db, string $date, array $owners, int $start, int $length, ?string $ignoreId): ?array {
    $found = null;
    foreach ($db['events'] as $event) {
        if ($event['date'] !== $date || $event['id'] === $ignoreId || !array_intersect($event['owners'], $owners)) { continue; }
        if ($event['start'] < $start + $length && $start < $event['start'] + $event['length']
            && ($found === null || $event['start'] < $found['start'])) { $found = $event; }
    }
    return $found;
}

/**
 * `ak`: 16 hex characters identifying a creation request by its canonical fields (kind, owners, scope/date,
 * text, start/length/slots, and for a custom list its kind and name; the colour is not part of it). PHP computes it and no client sends it.
 */
function fingerprint(array $canonical): string {
    $order = function (mixed $value) use (&$order) {
        if (!is_array($value)) { return $value; }
        $value = array_map($order, $value);
        if (!array_is_list($value)) { ksort($value, SORT_STRING); }
        return $value;
    };
    $canonical = $order($canonical);
    if (isset($canonical['owners']) && is_array($canonical['owners'])) { sort($canonical['owners'], SORT_STRING); }
    return substr(hash('sha256', json_encode($canonical, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)), 0, 16);
}
