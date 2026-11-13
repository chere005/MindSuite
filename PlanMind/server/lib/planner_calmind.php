<?php
declare(strict_types=1);
namespace PlanMind;

/**
 * CalMind's events on the Day schedule (the owner, 2026-11-09: "pull events from CalMind onto our daily planner"). READ-ONLY: nothing
 * here writes to CalMind, and nothing of CalMind is copied into the planner store. CalMind runs on this same host as the same web
 * user, so its store is read where it lies: `records-<user>.json` in its data dir, an `ENC1:` file (AES-256-CBC, the IV first,
 * the key the SHA-256 of the trimmed `.datakey`), exactly CalMind's server/lib/store.php. The accounts are the same names (the two
 * people's ids from the config, people.php). What the planner shows:
 * - the viewer's own events, every calendar;
 * - the other person's events only in the calendars they share with the viewer in CalMind (a mutual partnership, their
 *   per-partner selection or else the flat list: CalMind's share_of / share_sel / share_in_scope), so the planner never shows
 *   more of someone's calendar than CalMind itself would.
 * Timed events are placed on the hour grid. An all-day event (no valid `time`) has no place there; it goes in `allDay`, a separate list of
 * whole days for the compact strip above the grid (#171, the owner, 2026-11-09): planner day D is D 7a to D+1 7a, so an all-day event dated
 * D belongs to planner day D (its small hours, 0 to 7a, are the night of D-1 on the grid only for timed events), and one with a later
 * `endDate` appears on every day from D to the end date inclusive (CalMind's own multi-day rule), at most CALMIND_ALLDAY_SPAN_MAX days.
 * A repeat is expanded like CalMind's core
 * repeats.ts (month and year steps clamp the day). Times are wall-clock in the site's zone, as CalMind stores them; a planner
 * day runs 7a to 7a, so an event at 1a is on the night of the date before, and an event that runs past a planner day's end is
 * cut into one piece per planner day.
 * A store that exists and will not decrypt throws (the request fails; the page keeps what it has), never "no events".
 */

const CALMIND_REPEAT_MAX = 400;
const CALMIND_TEXT_MAX = 500;
/** The widest window one request may ask for, in days. */
const CALMIND_RANGE_MAX = 62;
/** The most days one all-day occurrence covers (a typo for an end date must not flood the strip). */
const CALMIND_ALLDAY_SPAN_MAX = 60;

/** CalMind's data dir for this instance: production's, or the test instance's (test.seancheren.com, dev the same). */
function calmind_dir(string $instance): string {
    $env = getenv('PLANMIND_CALMIND_DIR');
    if (is_string($env) && $env !== '') { return $env; }
    return match ($instance) { '' => '/home/protected/calmind-prod/data', '-dev' => '/home/protected/calmind-dev/data', default => '/home/protected/calmind/data' };
}

/** Optional protected operator configuration for the one calendar drawn in Both. */
function calmind_both_calendar(string $planDir): ?array {
    $raw = @file_get_contents($planDir . '/calmind-both-calendar.json', false, null, 0, 1024);
    $config = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($config) || !in_array($config['owner'] ?? null, pm_person_lists(), true)) { return null; }
    $id = $config['calendarId'] ?? null;
    return is_string($id) && preg_match('/^[A-Za-z0-9_-]{1,64}$/D', $id) ? $config : null;
}

/** One account's CalMind records (keyed by id). No file is no records; a file that will not read throws. */
function calmind_records(string $dir, string $user): array {
    if (!in_array($user, pm_person_lists(), true)) { throw new \RuntimeException('calmind: not a person'); }
    $file = $dir . '/records-' . $user . '.json';
    if (!is_file($file)) { return []; }
    $raw = @file_get_contents($file);
    if ($raw === false) { throw new \RuntimeException('calmind: store unreadable'); }
    if (str_starts_with($raw, 'ENC1:')) {
        $key = trim((string)@file_get_contents($dir . '/.datakey'));
        if ($key === '') { throw new \RuntimeException('calmind: data key missing'); }
        $bin = base64_decode(substr($raw, 5), true);
        if ($bin === false || strlen($bin) <= 16) { throw new \RuntimeException('calmind: store truncated'); }
        $raw = openssl_decrypt(substr($bin, 16), 'aes-256-cbc', hash('sha256', $key, true), OPENSSL_RAW_DATA, substr($bin, 0, 16));
        if ($raw === false) { throw new \RuntimeException('calmind: store will not decrypt'); }
    }
    $db = json_decode($raw, true);
    if (!is_array($db)) { throw new \RuntimeException('calmind: store is not JSON'); }
    return is_array($db['recs'] ?? null) ? $db['recs'] : [];
}

/** CalMind's share record of `$recs`: whom its owner names as partners, and which calendar ids `$viewer` may see. */
function calmind_share(array $recs, string $viewer): array {
    $rec = $recs['share'] ?? null;
    $p = is_array($rec) && empty($rec['deleted']) && is_array($rec['payload'] ?? null) ? $rec['payload'] : [];
    $names = fn(mixed $v) => array_values(array_filter(is_array($v) ? $v : [], 'is_string'));
    $sel = is_array($p['sel'] ?? null) && is_array($p['sel'][$viewer] ?? null) ? $p['sel'][$viewer] : null;
    return ['partners' => $names($p['partners'] ?? null), 'calendars' => $names($sel !== null ? ($sel['calendars'] ?? null) : ($p['calendars'] ?? null))];
}

/** The occurrence `i` steps after `start` (CalMind repeats.ts repeatStep: month and year steps keep the day, clamped). */
function calmind_repeat_step(string $start, int $n, string $unit, int $i): string {
    [$y, $m, $d] = array_map('intval', explode('-', $start));
    $k = $n * $i;
    $fmt = fn(int $yy, int $mm, int $dd) => (new \DateTimeImmutable('@' . gmmktime(0, 0, 0, $mm, $dd, $yy)))->format('Y-m-d');
    if ($unit === 'day') { return $fmt($y, $m, $d + $k); }
    if ($unit === 'week') { return $fmt($y, $m, $d + $k * 7); }
    $first = gmmktime(0, 0, 0, $unit === 'month' ? $m + $k : $m, 1, $unit === 'year' ? $y + $k : $y);
    $fy = (int)gmdate('Y', $first); $fm = (int)gmdate('n', $first);
    return $fmt($fy, $fm, min($d, (int)gmdate('t', $first)));
}

/** Every occurrence starting in [from, to]; a rule that does not advance (or is malformed) is a one-off, as in CalMind. */
function calmind_repeat_dates(string $start, mixed $repeat, string $from, string $to): array {
    if ($to < $from) { return []; }
    $n = is_array($repeat) && is_int($repeat['n'] ?? null) ? $repeat['n'] : 0;
    $unit = is_array($repeat) && is_string($repeat['unit'] ?? null) ? $repeat['unit'] : '';
    if ($n < 1 || !in_array($unit, ['day', 'week', 'month', 'year'], true)) { return $start >= $from && $start <= $to ? [$start] : []; }
    $out = [];
    for ($i = 0; $i < CALMIND_REPEAT_MAX; $i++) {
        $d = calmind_repeat_step($start, $n, $unit, $i);
        if ($d > $to) { break; }
        if ($d >= $from) { $out[] = $d; }
    }
    return $out;
}

function calmind_days(string $a, string $b): int { return (int)round((strtotime($b . ' 00:00:00 UTC') - strtotime($a . ' 00:00:00 UTC')) / 86400); }
function calmind_add(string $date, int $days): string { return gmdate('Y-m-d', strtotime($date . ' 00:00:00 UTC') + $days * 86400); }
function calmind_minutes(mixed $hhmm): ?int {
    return is_string($hhmm) && preg_match('/^([01]\d|2[0-3]):([0-5]\d)$/D', $hhmm, $m) ? (int)$m[1] * 60 + (int)$m[2] : null;
}

/** The #rrggbb color of each calendar record by id ('' when it has none or an unusable one). */
function calmind_colors(array $recs): array {
    $colors = [];
    foreach ($recs as $id => $r) {
        if (is_array($r) && ($r['type'] ?? '') === 'calendar' && empty($r['deleted'])) {
            $c = $r['payload']['color'] ?? '';
            $colors[(string)$id] = is_string($c) && preg_match('/^#[0-9a-fA-F]{6}$/D', $c) ? strtolower($c) : '';
        }
    }
    return $colors;
}

/**
 * The all-day days of `$owner`'s events on the planner days `from` to `to`: one per event occurrence and day it covers (see the header
 * for which planner day a date belongs to), `calendars` limiting them as in calmind_pieces. Sorted by date, then words.
 *
 * @return list<array{id: string, owner: string, date: string, text: string, color: string, both?: true}>
 */
function calmind_allday_pieces(array $recs, string $owner, ?array $calendars, string $from, string $to, ?array $bothCalendar = null): array {
    $colors = calmind_colors($recs);
    $allowed = $calendars === null ? null : array_flip($calendars);
    $out = [];
    foreach ($recs as $id => $r) {
        if (!is_array($r) || ($r['type'] ?? '') !== 'event' || !empty($r['deleted']) || !is_array($r['payload'] ?? null)) { continue; }
        $p = $r['payload'];
        $date = $p['date'] ?? null;
        if (!is_string($date) || !valid_date($date) || calmind_minutes($p['time'] ?? null) !== null) { continue; }
        $cal = is_string($p['calendarId'] ?? null) ? $p['calendarId'] : '';
        if ($allowed !== null && !isset($allowed[$cal])) { continue; }
        $both = $owner === ($bothCalendar['owner'] ?? null) && $cal === ($bothCalendar['calendarId'] ?? null);
        // CalMind: a later endDate makes the event run through that day, inclusive; anything else is the one day.
        $span = is_string($p['endDate'] ?? null) && valid_date($p['endDate']) && $p['endDate'] > $date ? min(calmind_days($date, $p['endDate']), CALMIND_ALLDAY_SPAN_MAX - 1) : 0;
        $text = trim(is_string($p['text'] ?? null) ? $p['text'] : '');
        $text = mb_substr($text === '' ? 'Event' : $text, 0, CALMIND_TEXT_MAX, 'UTF-8');
        foreach (calmind_repeat_dates($date, $p['repeat'] ?? null, calmind_add($from, -$span), $to) as $on) {
            for ($k = 0; $k <= $span; $k++) {
                $day = calmind_add($on, $k);
                if ($day < $from || $day > $to) { continue; }
                $out[] = ['id' => "$owner:$id:$on:$day", 'owner' => $owner, 'date' => $day, 'text' => $text, 'color' => $colors[$cal] ?? ''] + ($both ? ['both' => true] : []);
            }
        }
    }
    usort($out, fn($x, $y) => [$x['date'], $x['text'], $x['id']] <=> [$y['date'], $y['text'], $y['id']]);
    return $out;
}

/**
 * The pieces of `$owner`'s events on the planner days `from` to `to`, as the client draws them: one piece per event occurrence and
 * planner day, `start` in planner minutes (420 is 7a, 1860 is 7a the next morning), `length` in minutes. `$calendars` limits them
 * to those calendar ids (null: every calendar).
 *
 * @return list<array{id: string, owner: string, date: string, start: int, length: int, text: string, color: string, both?: true}>
 */
function calmind_pieces(array $recs, string $owner, ?array $calendars, string $from, string $to, ?array $bothCalendar = null): array {
    $colors = calmind_colors($recs);
    $allowed = $calendars === null ? null : array_flip($calendars);
    $dayStart = LIMITS['eventStartMin'];
    $out = [];
    foreach ($recs as $id => $r) {
        if (!is_array($r) || ($r['type'] ?? '') !== 'event' || !empty($r['deleted']) || !is_array($r['payload'] ?? null)) { continue; }
        $p = $r['payload'];
        $date = $p['date'] ?? null;
        $time = calmind_minutes($p['time'] ?? null);
        if (!is_string($date) || !valid_date($date) || $time === null) { continue; }
        $cal = is_string($p['calendarId'] ?? null) ? $p['calendarId'] : '';
        if ($allowed !== null && !isset($allowed[$cal])) { continue; }
        $both = $owner === ($bothCalendar['owner'] ?? null) && $cal === ($bothCalendar['calendarId'] ?? null);
        // The span from the occurrence's midnight: an end at or before the start is in the small hours after it, unless an end date says when.
        $endDays = is_string($p['endDate'] ?? null) && valid_date($p['endDate']) && $p['endDate'] > $date ? calmind_days($date, $p['endDate']) : 0;
        $endTime = calmind_minutes($p['end'] ?? null);
        $end = $endTime === null ? $time + 60 : $endDays * 1440 + $endTime;
        if ($endTime !== null && $endDays === 0 && $end <= $time) { $end += 1440; }
        if ($end <= $time) { $end = $time + 60; }
        $text = trim(is_string($p['text'] ?? null) ? $p['text'] : '');
        $text = mb_substr($text === '' ? 'Event' : $text, 0, CALMIND_TEXT_MAX, 'UTF-8');
        $spanDays = intdiv($end, 1440) + 1;
        foreach (calmind_repeat_dates($date, $p['repeat'] ?? null, calmind_add($from, -$spanDays), calmind_add($to, 1)) as $on) {
            // Planner day P covers [P 7a, P+1 7a): minutes measured from this occurrence's midnight, k days later.
            for ($k = -1; $k <= $spanDays; $k++) {
                $planDay = calmind_add($on, $k);
                if ($planDay < $from || $planDay > $to) { continue; }
                $winFrom = $k * 1440 + $dayStart; $winTo = $winFrom + 1440;
                $a = max($time, $winFrom); $b = min($end, $winTo);
                if ($b <= $a) { continue; }
                $out[] = ['id' => "$owner:$id:$on:$planDay", 'owner' => $owner, 'date' => $planDay, 'start' => $a - $k * 1440, 'length' => $b - $a,
                    'text' => $text, 'color' => $colors[$cal] ?? ''] + ($both ? ['both' => true] : []);
            }
        }
    }
    usort($out, fn($x, $y) => [$x['date'], $x['start'], $x['id']] <=> [$y['date'], $y['start'], $y['id']]);
    return $out;
}

/**
 * GET ?calmind=1&from=&to=: the CalMind pieces `$viewer` may see on those planner days (at most CALMIND_RANGE_MAX of them). The
 * viewer's own calendars whole; the other person's only what they share with the viewer, while both name each other as partners.
 */
function calmind_events(string $dir, string $viewer, mixed $from, mixed $to, ?array $bothCalendar = null): array {
    if (!in_array($viewer, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    if (!is_string($from) || !is_string($to) || !valid_date($from) || !valid_date($to) || $to < $from || calmind_days($from, $to) >= CALMIND_RANGE_MAX) {
        throw new RequestError('Invalid date range.', 400, 'invalid');
    }
    $mine = calmind_records($dir, $viewer);
    $events = calmind_pieces($mine, $viewer, null, $from, $to, $bothCalendar);
    $allDay = calmind_allday_pieces($mine, $viewer, null, $from, $to, $bothCalendar);
    foreach (pm_person_lists() as $other) {
        if ($other === $viewer) { continue; }
        $theirs = calmind_records($dir, $other);
        $share = calmind_share($theirs, $viewer);
        if (!in_array($viewer, $share['partners'], true) || !in_array($other, calmind_share($mine, $other)['partners'], true)) { continue; }
        $events = [...$events, ...calmind_pieces($theirs, $other, $share['calendars'], $from, $to, $bothCalendar)];
        $allDay = [...$allDay, ...calmind_allday_pieces($theirs, $other, $share['calendars'], $from, $to, $bothCalendar)];
    }
    return ['events' => $events, 'allDay' => $allDay];
}

/**
 * The setCalmind action: whether the Day schedule shows CalMind's events, a per-account preference kept beside the theme in the
 * account library's prefs file (not the planner store, so no store version changes). Like op_set_theme it is claimed saved only when
 * it reads back.
 *
 * @param callable(bool): mixed $set
 * @param callable(): bool $get
 * @return array{calmind: 'shown'|'hidden'}
 */
function op_set_calmind(array $input, string $user, callable $set, callable $get): array {
    if (!in_array($user, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    $hidden = $input['hidden'] ?? null;
    if (!is_bool($hidden)) { throw new RequestError('Invalid request.', 400, 'invalid'); }
    set_error_handler(static function (int $level, string $message): bool { throw new \ErrorException($message, 0, $level); });
    try { $set($hidden); $saved = $get() === $hidden; }
    catch (\Throwable $e) { error_log('PlanMind CalMind preference write failed: ' . get_class($e)); $saved = false; }
    finally { restore_error_handler(); }
    if (!$saved) { throw new RequestError('That could not be saved.', 503, 'unavailable'); }
    return ['calmind' => $hidden ? 'hidden' : 'shown'];
}
