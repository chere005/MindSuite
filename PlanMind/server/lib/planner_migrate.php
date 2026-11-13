<?php
declare(strict_types=1);
namespace PlanMind;
require_once __DIR__ . '/planner_rules.php';

/**
 * The one-time conversion of the v1 store (PlanMind 0.1.0) to v2, in memory. Nothing here touches the disk: a read
 * converts and the file stays as it was; the first successful write stores the converted db, and Store keeps the
 * untouched v1 file as tasks.v1.enc.bak before it does. The result is a pure function of the v1 data (stamps come from
 * the records, not the clock), so every read, and every process racing for the first write, derives the same db.
 *
 * v1 held `tasks` keyed by id ({id, title, date, person, scope day|month, done, revision, createdBy, updatedAt}) and
 * `notes` keyed `scope:period` ({key, scope week|month, period, text, revision, updatedBy, updatedAt}), one shared
 * text per period. In v2:
 * - person both is the linked owners, the two people's ids sorted (ONE record, as a v2 Both item is); either person's id is a single owner.
 * - nothing is truncated, repaired or dropped. A title over today's cap, a note over docChars, a day with more than
 *   dayTodosPerList open to-dos: all kept as they were, because the structural check on read does not re-check caps.
 *   The caps apply to what is written from now on.
 * - the one shared note becomes the same text in BOTH lists' notes (a week's text is v2's week `priorities` field, a
 *   month's is its `notes` field, as the v1 screens showed them), so neither person loses it; from then on each
 *   list's text is edited alone. The keys are fixed by scope, period, list and field, so converting again, or racing
 *   another process, can only produce the same two notes, never a third.
 * - v1 order was open before done, then by id. `pos` keeps it: ids in order within each (scope, date), posGap apart.
 * - v1 recorded neither who last edited a to-do nor when it was created: updatedBy is createdBy and createdAt is
 *   updatedAt, the best that is known. The global and record revisions carry over.
 * Anything that is not exactly what the 0.1.0 writer produced fails closed (a RuntimeException, a 503 for the caller).
 */
final class MigrateV1 {
    private const TASK_KEYS = ['id', 'title', 'date', 'person', 'done', 'revision', 'createdBy', 'updatedAt'];
    private const NOTE_KEYS = ['key', 'scope', 'period', 'text', 'revision', 'updatedBy', 'updatedAt'];
    /** v1 `person` (both, or one person's id, which v1 stored as its value) to v2 owners. */
    private static function owners(): array {
        [$partner, $owner] = pm_person_lists();
        return ['both' => pm_both_owners(), $partner => [$partner], $owner => [$owner]];
    }
    private const NOTE_FIELD = ['week' => 'priorities', 'month' => 'notes'];

    /** A v1 db that has something to convert. Anything else old reads as a fresh store. */
    public static function holdsRecords(array $db): bool {
        return (is_array($db['tasks'] ?? null) && $db['tasks'] !== []) || (is_array($db['notes'] ?? null) && $db['notes'] !== []);
    }

    /** The v2 db for a well-formed v1 db with records; the caller validates the result like any other v2 db. */
    public static function convert(array $old): array {
        $tasks = $old['tasks'];
        $notes = $old['notes'] ?? [];
        $stamp = null;
        foreach ($tasks as $key => $task) { self::task($key, $task); $stamp = self::later($stamp, $task['updatedAt']); }
        foreach ($notes as $key => $note) { self::note($key, $note); $stamp = self::later($stamp, $note['updatedAt']); }

        $db = fresh_db($stamp);
        $db['revision'] = $old['revision'];

        $buckets = [];
        foreach ($tasks as $id => $task) { $buckets[($task['scope'] ?? 'day') . '|' . $task['date']][] = $id; }
        $pos = [];
        foreach ($buckets as $ids) {
            sort($ids, SORT_STRING);
            foreach ($ids as $i => $id) { $pos[$id] = ($i + 1) * LIMITS['posGap']; }
        }
        foreach ($tasks as $id => $task) {
            $fields = ['owners' => self::owners()[$task['person']], 'scope' => $task['scope'] ?? 'day', 'date' => $task['date'], 'title' => $task['title']];
            $db['tasks'][$id] = ['id' => $id] + $fields + ['done' => $task['done'], 'pos' => $pos[$id], 'revision' => $task['revision'],
                'createdBy' => $task['createdBy'], 'updatedBy' => $task['createdBy'], 'createdAt' => $task['updatedAt'], 'updatedAt' => $task['updatedAt'],
                'ak' => fingerprint(['kind' => 'todo'] + $fields)];
        }
        foreach ($notes as $note) {
            foreach (pm_person_lists() as $listId) {
                $field = self::NOTE_FIELD[$note['scope']];
                $key = "$note[scope]:$note[period]:$listId:$field";
                $db['notes'][$key] = ['key' => $key, 'scope' => $note['scope'], 'period' => $note['period'], 'listId' => $listId, 'field' => $field,
                    'text' => $note['text'], 'revision' => $note['revision'], 'updatedBy' => $note['updatedBy'], 'updatedAt' => $note['updatedAt']];
            }
        }
        return $db;
    }

    private static function need(bool $ok, string $where, string $what): void {
        if (!$ok) { throw Invariants::bad("old store $where $what"); }
    }
    /** The newer of two timestamps (the writer only ever produced gmdate('c'), which sorts as text). */
    private static function later(?string $a, string $b): string { return $a === null || strcmp($b, $a) > 0 ? $b : $a; }

    /** Exactly the keys the 0.1.0 writer produced. A task with no `scope` is a day task, as the v1 screens read it. */
    private static function task(mixed $key, mixed $t): void {
        $where = "tasks.$key";
        self::need(is_array($t), $where, 'is not a record');
        $missing = array_diff(self::TASK_KEYS, array_keys($t));
        $unknown = array_diff(array_keys($t), self::TASK_KEYS, ['scope']);
        self::need(!$missing && !$unknown, $where, 'has the wrong fields (missing: ' . implode(',', $missing) . '; unknown: ' . implode(',', $unknown) . ')');
        self::need(valid_id($key) && $t['id'] === $key, $where, 'id does not match its key');
        self::need(is_string($t['title']) && is_bool($t['done']), $where, 'has a bad title or done');
        self::need(is_string($t['person']) && isset(self::owners()[$t['person']]), $where, 'person is not both or one of the two people');
        $scope = $t['scope'] ?? 'day';
        self::need(is_string($scope) && in_array($scope, ['day', 'month'], true) && is_string($t['date']) && valid_period($scope, $t['date']), $where, 'date does not start its scope');
        self::need(is_int($t['revision']) && $t['revision'] >= 1 && is_string($t['updatedAt']), $where, 'has a bad revision or timestamp');
        self::need(in_array($t['createdBy'], pm_person_lists(), true), $where, 'author is not a person');
    }
    private static function note(mixed $key, mixed $n): void {
        $where = "notes.$key";
        self::need(is_array($n), $where, 'is not a record');
        $missing = array_diff(self::NOTE_KEYS, array_keys($n));
        $unknown = array_diff(array_keys($n), self::NOTE_KEYS);
        self::need(!$missing && !$unknown, $where, 'has the wrong fields (missing: ' . implode(',', $missing) . '; unknown: ' . implode(',', $unknown) . ')');
        self::need(is_string($n['scope']) && isset(self::NOTE_FIELD[$n['scope']]) && is_string($n['period']) && valid_period($n['scope'], $n['period']), $where, 'period does not start its scope');
        self::need($key === "$n[scope]:$n[period]" && $n['key'] === $key, $where, 'key differs from its fields');
        self::need(is_string($n['text']) && is_int($n['revision']) && $n['revision'] >= 1, $where, 'has a bad text or revision');
        self::need(in_array($n['updatedBy'], pm_person_lists(), true) && is_string($n['updatedAt']), $where, 'has a bad author or timestamp');
    }
}

/**
 * The chore chart a new or converted store starts with: the owner's Gentle Chore Chart as 21 rules in this order, and the A/B rhythm
 * (Week A starts Monday 2 November 2026, and no turn exists before that day). Ids are fixed, so every read and every process racing for
 * the first write derives the same rules. Each person's own rules are single owners (by role, through people.php); Mail & papers is both.
 */
final class ChoreSeed {
    private const ANCHOR = '2026-11-02';

    /** The rules keyed by id, stamped `$now` and signed by the owner. */
    public static function rules(string $now): array {
        $people = pm_people();
        [$partner, $owner, $both] = [[$people['partner']], [$people['owner']], pm_both_owners()];
        [$sun, $mon, $tue, $wed, $thu] = [0, 1, 2, 3, 4];
        $daily = ['kind' => 'daily'];
        $weekly = fn(int $day, string $weeks = 'every') => ['kind' => 'weekly', 'day' => $day, 'weeks' => $weeks];
        $monthly = fn(int $nth, int $day, string $months = 'every') => ['kind' => 'monthly', 'nth' => $nth, 'day' => $day, 'months' => $months];
        $table = [
            [$owner, 'Dishes', $daily], [$partner, 'Trash & recycling', $daily], [$owner, 'Wipe the table', $daily],
            [$partner, 'Cat bowls', $weekly($mon)], [$partner, 'Clutter reset', $weekly($mon)], [$both, 'Mail & papers', $weekly($tue)],
            [$partner, 'Fridge clean-out', $weekly($wed)], [$partner, 'Bins to the curb', $weekly($wed)],
            [$partner, 'Cat bowls', $weekly($thu)], [$partner, 'Fresh litter + liner', $weekly($thu)],
            [$partner, 'Laundry', $weekly($sun)], [$owner, 'Vacuum', $weekly($sun)],
            [$owner, 'Kitchen wipe-down', $weekly($wed, 'A')], [$partner, 'Kitchen towels', $weekly($sun, 'A')], [$partner, 'Bedding', $weekly($sun, 'A')],
            [$partner, 'Couch blankets', $weekly($sun, 'A')], [$owner, 'Bathroom wipe-down', $weekly($wed, 'B')],
            [$partner, 'Dust, then vacuum', $monthly(1, $sun)], [$partner, 'Litter box deep clean', $monthly(2, $thu)], [$partner, 'Vacuum, then mop', $monthly(3, $sun)],
            [$owner, 'Furnace filter', $monthly(1, $mon, 'odd')],
        ];
        $rules = [];
        foreach ($table as $i => [$owners, $title, $cadence]) {
            $id = sprintf('c0de0000-0000-4000-8000-%012x', $i + 1);
            $rules[$id] = ['id' => $id, 'title' => $title, 'owners' => $owners, 'cadence' => $cadence, 'order' => $i + 1,
                'revision' => 1, 'updatedBy' => $people['owner'], 'updatedAt' => $now];
        }
        return $rules;
    }

    public static function rhythm(string $now): array {
        return ['anchor' => self::ANCHOR, 'start' => self::ANCHOR, 'revision' => 1, 'updatedBy' => pm_people()['owner'], 'updatedAt' => $now];
    }
}

/**
 * The conversion of a v2 store (PlanMind 0.12.0 and before) to v3, in memory like MigrateV1: nothing touches the disk on a read, and the
 * first successful write stores the db (converted on to the current version by MigrateV3). v3 only adds the chore chart, so the result is the v2 db as it was plus the seeded rules, no
 * marks and the rhythm, stamped with the settings' own time so every read, and every process racing for the first write, derives the
 * same db. Anything that is not exactly a v2 store fails closed.
 */
final class MigrateV2 {
    private const KEYS = ['events', 'lists', 'notes', 'prefs', 'priorities', 'revision', 'settings', 'tasks', 'v'];

    public static function convert(array $old): array {
        $keys = array_keys($old);
        sort($keys, SORT_STRING);
        $stamp = is_array($old['settings'] ?? null) ? ($old['settings']['updatedAt'] ?? null) : null;
        if ($keys !== self::KEYS || $old['v'] !== 2 || !is_string($stamp)) { throw Invariants::bad('old store is not a recognised v2 store'); }
        return array_replace($old, ['v' => 3, 'chores' => ChoreSeed::rules($stamp), 'choreMarks' => [], 'rhythm' => ChoreSeed::rhythm($stamp)]);
    }
}

/**
 * The conversion of a v3 store (PlanMind 0.13.0) to v4, in memory like the others: nothing touches the disk on a read, and the first
 * successful write stores v4 after Store has kept the v3 file's bytes as tasks.v3.enc.bak. v4 only lets a done day to-do carry `doneOn`,
 * and a v3 to-do has none, so there is nothing to convert but the version. Anything that is not exactly a v3 store fails closed, and so
 * does a v3 to-do that already has a doneOn (a v3 reader would not know what to do with it, so v3 never wrote one).
 */
final class MigrateV3 {
    private const KEYS = ['choreMarks', 'chores', 'events', 'lists', 'notes', 'prefs', 'priorities', 'revision', 'rhythm', 'settings', 'tasks', 'v'];

    public static function convert(array $old): array {
        $keys = array_keys($old);
        sort($keys, SORT_STRING);
        if ($keys !== self::KEYS || $old['v'] !== 3 || !is_array($old['tasks'])) { throw Invariants::bad('old store is not a recognised v3 store'); }
        foreach ($old['tasks'] as $key => $task) {
            if (is_array($task) && array_key_exists('doneOn', $task)) { throw Invariants::bad("old store tasks.$key has a doneOn, which v3 never wrote"); }
        }
        return array_replace($old, ['v' => 4]);
    }
}

/** Expand short appointments and push only the later appointments that need room. Store backs up the v4 file on write. */
final class MigrateV4 {
    private const MIN_LENGTH = 30;

    public static function convert(array $old): array {
        Invariants::validate($old, 4);
        $db = $old;
        $ordered = array_values($old['events']);
        usort($ordered, fn($a, $b) => [$a['date'], $a['start'], $a['id']] <=> [$b['date'], $b['start'], $b['id']]);
        $day = null;
        $oldEnds = $ends = [];
        $changed = false;
        foreach ($ordered as $event) {
            if ($event['date'] !== $day) {
                $day = $event['date'];
                $oldEnds = $ends = [];
            }
            $start = $event['start'];
            $length = max(self::MIN_LENGTH, $event['length']);
            foreach ($event['owners'] as $owner) {
                if (($oldEnds[$owner] ?? 0) > $event['start']) { throw Invariants::bad('schedule migration found a preexisting overlap'); }
                $start = max($start, $ends[$owner] ?? 0);
            }
            if ($start + $length > LIMITS['eventEndMin']) { throw Invariants::bad('schedule migration cannot fit an appointment before the end of its day'); }
            foreach ($event['owners'] as $owner) {
                $oldEnds[$owner] = $event['start'] + $event['length'];
                $ends[$owner] = $start + $length;
            }
            if ($start === $event['start'] && $length === $event['length']) { continue; }
            $db['events'][$event['id']] = array_replace($event, ['start' => $start, 'length' => $length, 'revision' => $event['revision'] + 1]);
            $changed = true;
        }
        if ($changed) { ++$db['revision']; }
        $db['v'] = 5;
        return $db;
    }
}
