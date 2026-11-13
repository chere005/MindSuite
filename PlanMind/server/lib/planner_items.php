<?php
declare(strict_types=1);
namespace PlanMind;
require_once __DIR__ . '/planner_rules.php';

/**
 * Handlers for to-dos, day priority lines and schedule entries (spec 6.1). Each takes the validated db, the
 * decoded input and the authorized user, and returns the new db, or the very array it was given for a no-op.
 * A handler never bumps the global revision: mutate() does, exactly once per change.
 */

function op_add(array $db, array $input, string $user, ?string $today = null): array { return ItemOps::add($db, $input, $user, $today); }
function op_edit(array $db, array $input, string $user, ?string $today = null): array { return ItemOps::edit($db, $input, $user, $today); }
function op_complete(array $db, array $input, string $user, ?string $today = null): array { return ItemOps::complete($db, $input, $user, $today); }
function op_delete(array $db, array $input, string $user): array { return ItemOps::delete($db, $input, $user); }
function op_move_todo(array $db, array $input, string $user): array { return ItemOps::moveTodo($db, $input, $user); }
function op_move_priorities(array $db, array $input, string $user): array { return ItemOps::movePriorities($db, $input, $user); }
function op_edit_events(array $db, array $input, string $user): array { return ItemOps::editEvents($db, $input, $user); }

final class ItemOps {
    private const MAP = ['todo' => 'tasks', 'priority' => 'priorities', 'event' => 'events'];
    private const SCOPES = ['day', 'week', 'month'];
    private const NOUN = ['todo' => 'a to-do', 'priority' => 'a priority', 'event' => 'a schedule entry'];
    /** The fields a kind takes after action, kind and id (an edit also takes revision, and no to-do scope). */
    private const ADD = ['todo' => ['scope', 'date', 'owners', 'title'], 'priority' => ['date', 'owners', 'slots', 'text'], 'event' => ['date', 'owners', 'text', 'start']];
    private const ADD_OPTIONAL = ['todo' => [], 'priority' => [], 'event' => ['length']];
    /** A dragged boundary between bordering entries: the dragged one and an entry in each of two lanes. */
    private const EDIT_EVENTS_MAX = 3;
    private const EDIT = ['todo' => ['date', 'owners', 'title'], 'priority' => ['date', 'owners', 'slots', 'text'], 'event' => ['date', 'owners', 'text', 'start', 'length']];

    public static function add(array $db, array $input, string $user, ?string $today = null): array {
        $id = self::id($input);
        $kind = self::kind($input);
        self::shape($input, $kind, false);
        $scope = null;
        if ($kind === 'todo') {
            $scope = $input['scope'];
            if (!is_string($scope) || !in_array($scope, self::SCOPES, true)) { throw self::bad('Choose day, week or month.'); }
        }
        $fields = self::fields($db, $kind, $input, $scope, LIMITS['eventStep']);
        // A retry of this very request succeeds before any cap, slot or overlap check can fail against its own earlier write.
        $ak = fingerprint(['kind' => $kind] + $fields);
        foreach (self::MAP as $other => $collection) {
            $existing = $db[$collection][$id] ?? null;
            if ($existing === null) { continue; }
            if ($other === $kind && $existing['createdBy'] === $user && $existing['ak'] === $ak) { return $db; }
            throw new RequestError('That ID is already in use.', 409, 'id_in_use');
        }
        if ($kind === 'event' && $fields['length'] < LIMITS['eventMinLength']) {
            throw self::bad('Choose a length of at least ' . LIMITS['eventMinLength'] . ' minutes.');
        }
        if (count($db['tasks']) + count($db['priorities']) + count($db['events']) >= LIMITS['itemsMax']) {
            throw new RequestError('The planner has reached its item limit.', 409, 'limit', 'itemsMax');
        }
        self::guard($db, $kind, $fields, null, $today);
        $now = gmdate('c');
        $extra = $kind === 'todo' ? ['done' => false, 'pos' => self::endPos($db, $fields['scope'], $fields['date'], null)] : [];
        $db[self::MAP[$kind]][$id] = ['id' => $id] + $fields + $extra
            + ['revision' => 1, 'createdBy' => $user, 'updatedBy' => $user, 'createdAt' => $now, 'updatedAt' => $now, 'ak' => $ak];
        return $db;
    }

    public static function edit(array $db, array $input, string $user, ?string $today = null): array {
        $id = self::id($input);
        $kind = self::kind($input);
        self::shape($input, $kind, true);
        $revision = self::revision($input);
        $old = self::record($db, $id, $kind);
        if ($revision !== $old['revision']) { throw self::stale(); }
        $fields = self::fields($db, $kind, $input, $old['scope'] ?? null);
        $changed = false;
        foreach ($fields as $key => $value) {
            $was = $old[$key];
            if ($key === 'slots') { ksort($was, SORT_STRING); }
            $changed = $changed || $was !== $value;
        }
        if (!$changed) { return $db; }
        self::guard($db, $kind, $fields, $old, $today);
        $new = $fields + $old;
        // A to-do that changes day joins the end of the new day's order: its old position means nothing there. A done one is then done on that day.
        if ($kind === 'todo' && $fields['date'] !== $old['date']) {
            $new['pos'] = self::endPos($db, $old['scope'], $fields['date'], $id);
            unset($new['doneOn']);
        }
        $db[self::MAP[$kind]][$id] = self::stamp($new, $user);
        return $db;
    }

    /**
     * Checks or unchecks a to-do. `doneOn` (optional, only when checking a day to-do) is the date of the page it was ticked on: its own date,
     * or `$today` (a carried row ticked on today's Day), never anything else. Unchecking removes it. A repeat of a completion that already
     * holds changes nothing, whatever doneOn it carries.
     */
    public static function complete(array $db, array $input, string $user, ?string $today = null): array {
        self::keys($input, ['action', 'id', 'revision', 'done'], ['doneOn']);
        $id = self::id($input);
        $revision = self::revision($input);
        if (!is_bool($input['done'])) { throw self::bad('Invalid completion value.'); }
        $doneOn = $input['doneOn'] ?? null;
        $task = self::record($db, $id, 'todo');
        if (array_key_exists('doneOn', $input)) {
            if (!$input['done'] || $task['scope'] !== 'day' || !valid_date($doneOn)) { throw self::bad('Only a day to-do being checked off has a day it was done on.'); }
            if ($doneOn < $task['date'] || ($doneOn !== $task['date'] && $doneOn !== $today)) { throw self::bad('A to-do is checked off on its own day or on today.'); }
        }
        if ($revision !== $task['revision']) { throw self::stale(); }
        if ($task['done'] === $input['done']) { return $db; }
        if (!$input['done'] && $task['scope'] === 'day') {
            foreach ($task['owners'] as $owner) { self::checkOpen($db, $owner, $task['date'], $id, $today); }
        }
        $task['done'] = $input['done'];
        unset($task['doneOn']);
        if ($doneOn !== null) { $task['doneOn'] = $doneOn; }
        $db['tasks'][$id] = self::stamp($task, $user);
        return $db;
    }

    public static function delete(array $db, array $input, string $user): array {
        self::keys($input, ['action', 'id', 'revision', 'confirm'], []);
        $id = self::id($input);
        $revision = self::revision($input);
        if ($input['confirm'] !== true) { throw self::bad('Confirm removal first.'); }
        foreach (self::MAP as $collection) {
            if (!isset($db[$collection][$id])) { continue; }
            if ($revision !== $db[$collection][$id]['revision']) { throw self::stale(); }
            unset($db[$collection][$id]);
            return $db;
        }
        throw self::gone();
    }

    /** Place a to-do before another of the same (scope, date), or at the end. Every to-do of the bucket takes part, whatever the viewer sees. */
    public static function moveTodo(array $db, array $input, string $user): array {
        self::keys($input, ['action', 'id', 'revision', 'before'], []);
        $id = self::id($input);
        $revision = self::revision($input);
        $before = $input['before'];
        if ($before !== null && !valid_id($before)) { throw self::bad('Invalid target.'); }
        $task = self::record($db, $id, 'todo');
        if ($before === $id) { return $db; }
        $order = self::ordered($db, $task['scope'], $task['date']);
        $others = array_values(array_diff($order, [$id]));
        $at = count($others);
        if ($before !== null) {
            $target = $db['tasks'][$before] ?? null;
            if ($target === null) { throw self::gone(); }
            if ($target['scope'] !== $task['scope'] || $target['date'] !== $task['date']) { throw self::bad('Choose a to-do from the same list.'); }
            $at = (int)array_search($before, $others, true);
        }
        $placed = [...array_slice($others, 0, $at), $id, ...array_slice($others, $at)];
        // A retry after a lost response finds the to-do where it was asked to go, with a newer revision: success, nothing to write.
        if ($placed === $order) { return $db; }
        if ($revision !== $task['revision']) { throw self::stale(); }
        if ($before === null) {
            $pos = $db['tasks'][$others[$at - 1]]['pos'] + LIMITS['posGap'];
        } else {
            $low = $at > 0 ? $db['tasks'][$others[$at - 1]]['pos'] : 0;
            $high = $db['tasks'][$before]['pos'];
            // No room between the neighbours: renumber the whole bucket in its new order. Neighbours keep their revisions.
            if ($high - $low < 2) {
                foreach ($placed as $i => $taskId) { $db['tasks'][$taskId]['pos'] = ($i + 1) * LIMITS['posGap']; }
                $pos = $db['tasks'][$id]['pos'];
            } else { $pos = intdiv($low + $high, 2); }
        }
        $task = $db['tasks'][$id];
        $task['pos'] = $pos;
        $db['tasks'][$id] = self::stamp($task, $user);
        return $db;
    }

    /** One list's priority lines for a day, all or nothing. Only slots[listId] of each moved record changes. */
    public static function movePriorities(array $db, array $input, string $user): array {
        self::keys($input, ['action', 'date', 'listId', 'moves'], []);
        $date = $input['date'];
        if (!valid_date($date)) { throw self::bad('Choose a valid date.'); }
        [$listId] = canonical_owners($db, [$input['listId']]);
        $moves = $input['moves'];
        if (!is_array($moves) || !array_is_list($moves) || !$moves || count($moves) > LIMITS['prioritySlots']) {
            throw self::bad('Move one to ' . LIMITS['prioritySlots'] . ' lines at a time.');
        }
        $targets = [];
        $current = [];
        foreach ($moves as $move) {
            if (!is_array($move)) { throw self::bad('Invalid move.'); }
            self::keys($move, ['id', 'revision', 'slot'], []);
            $id = self::id($move);
            $revision = self::revision($move);
            if (isset($targets[$id])) { throw self::bad('Move each line once.'); }
            if (!is_int($move['slot']) || $move['slot'] < 1 || $move['slot'] > LIMITS['prioritySlots']) { throw self::bad('Choose a line from 1 to ' . LIMITS['prioritySlots'] . '.'); }
            $priority = self::record($db, $id, 'priority');
            if ($priority['date'] !== $date || !in_array($listId, $priority['owners'], true)) { throw self::bad('That line is not in this list on that day.'); }
            $targets[$id] = ['slot' => $move['slot'], 'revision' => $revision];
            $current[$id] = $priority;
        }
        // A retry after a lost response finds every line where it was asked to go: success, nothing to write.
        $moving = array_filter($targets, fn($t, $id) => $current[$id]['slots'][$listId] !== $t['slot'], ARRAY_FILTER_USE_BOTH);
        if (!$moving) { return $db; }
        foreach ($targets as $id => $t) { if ($t['revision'] !== $current[$id]['revision']) { throw self::stale(); } }
        $final = [];
        foreach ($db['priorities'] as $priority) {
            if ($priority['date'] === $date && isset($priority['slots'][$listId])) { $final[$priority['id']] = $priority['slots'][$listId]; }
        }
        foreach ($targets as $id => $t) { $final[$id] = $t['slot']; }
        if (count(array_unique($final)) !== count($final)) { throw new RequestError('Two lines would share a place in this list.', 409, 'slot_taken'); }
        foreach ($moving as $id => $t) {
            $priority = $current[$id];
            $priority['slots'][$listId] = $t['slot'];
            ksort($priority['slots'], SORT_STRING);
            $db['priorities'][$id] = self::stamp($priority, $user);
        }
        return $db;
    }

    /**
     * Schedule entries of one day edited together, all or nothing: a shared boundary dragged between bordering entries (the first one's end and
     * the next one's start move as one). Each edit is a whole event edit of a stored entry on its own day (no change of day); overlaps are judged
     * on the result, so the entries may trade the minutes between them. A retry that finds every entry as asked succeeds with nothing to write.
     */
    public static function editEvents(array $db, array $input, string $user): array {
        self::keys($input, ['action', 'edits'], []);
        $edits = $input['edits'];
        if (!is_array($edits) || !array_is_list($edits) || count($edits) < 1 || count($edits) > self::EDIT_EVENTS_MAX) {
            throw self::bad('Edit one to ' . self::EDIT_EVENTS_MAX . ' schedule entries at a time.');
        }
        $date = null;
        $next = [];
        $changed = [];
        foreach ($edits as $edit) {
            if (!is_array($edit)) { throw self::bad('Invalid edit.'); }
            self::keys($edit, ['id', 'revision', ...self::EDIT['event']], []);
            $id = self::id($edit);
            $revision = self::revision($edit);
            if (isset($next[$id])) { throw self::bad('Edit each entry once.'); }
            $old = self::record($db, $id, 'event');
            $fields = self::fields($db, 'event', $edit, null);
            $date ??= $fields['date'];
            if ($fields['date'] !== $date || $old['date'] !== $date) { throw self::bad('Edit entries of one day, on that day.'); }
            $next[$id] = $fields + $old;
            foreach ($fields as $key => $value) { if ($old[$key] !== $value) { $changed[$id] = $revision; break; } }
        }
        if (!$changed) { return $db; }
        foreach ($changed as $id => $revision) { if ($revision !== $db['events'][$id]['revision']) { throw self::stale(); } }
        foreach ($changed as $id => $_) { $db['events'][$id] = self::stamp($next[$id], $user); }
        foreach ($changed as $id => $_) {
            $e = $db['events'][$id];
            if (find_event_overlap($db, $e['date'], $e['owners'], $e['start'], $e['length'], $id) !== null) {
                throw new RequestError('That time is already taken in this list.', 409, 'overlap');
            }
        }
        return $db;
    }

    // ---- validation ----

    private static function bad(string $message): RequestError { return new RequestError($message, 400, 'invalid'); }
    private static function gone(): RequestError { return new RequestError('That entry was removed. Refresh to see the latest.', 409, 'gone'); }
    private static function stale(): RequestError { return new RequestError('This entry changed on another device. Refresh to see the latest.', 409, 'stale'); }

    /** Exactly these keys: all of $required, and none beyond them and $optional. Nothing unknown is ever dropped silently. */
    private static function keys(array $input, array $required, array $optional): void {
        $given = array_map('strval', array_keys($input));
        if (array_diff($required, $given) || array_diff($given, $required, $optional)) { throw self::bad('The request has missing or unknown fields.'); }
    }
    private static function shape(array $input, string $kind, bool $edit): void {
        $head = ['action', 'kind', 'id'];
        self::keys($input, $edit ? [...$head, 'revision', ...self::EDIT[$kind]] : [...$head, ...self::ADD[$kind]], $edit ? [] : self::ADD_OPTIONAL[$kind]);
    }
    private static function id(array $input): string {
        $id = $input['id'] ?? null;
        if (!valid_id($id)) { throw self::bad('Invalid ID.'); }
        return $id;
    }
    private static function kind(array $input): string {
        $kind = $input['kind'] ?? null;
        if (!is_string($kind) || !isset(self::MAP[$kind])) { throw self::bad('Choose a to-do, priority or schedule entry.'); }
        return $kind;
    }
    private static function revision(array $input): int {
        $revision = $input['revision'] ?? null;
        if (!is_int($revision) || $revision < 1) { throw self::bad('Invalid revision.'); }
        return $revision;
    }

    /** The stored record, or `gone`; an id that belongs to another kind of entry is the caller's mistake. */
    private static function record(array $db, string $id, string $kind): array {
        $record = $db[self::MAP[$kind]][$id] ?? null;
        if ($record !== null) { return $record; }
        foreach (self::MAP as $collection) {
            if (isset($db[$collection][$id])) { throw self::bad('That entry is not ' . self::NOUN[$kind] . '.'); }
        }
        throw self::gone();
    }

    /** The editable fields of a kind, validated and canonical. `$scope` is the to-do's scope: given on add, stored on edit. */
    private static function fields(array $db, string $kind, array $input, ?string $scope, int $minimum = LIMITS['eventMinLength']): array {
        $owners = canonical_owners($db, $input['owners'] ?? null);
        $date = $input['date'] ?? null;
        if ($kind === 'todo') {
            if (!is_string($date) || !valid_period($scope, $date)) {
                throw self::bad(match ($scope) { 'week' => 'A week starts on a Monday.', 'month' => 'A month starts on the 1st.', default => 'Choose a valid date.' });
            }
            return ['owners' => $owners, 'scope' => $scope, 'date' => $date,
                'title' => clean_text($input['title'] ?? null, item_text_limit('todo', $owners, $scope), true)];
        }
        if (!is_string($date) || !valid_date($date)) { throw self::bad('Choose a valid date.'); }
        if ($kind === 'priority') {
            return ['owners' => $owners, 'date' => $date, 'slots' => self::slots($input['slots'] ?? null, $owners),
                'text' => clean_text($input['text'] ?? null, item_text_limit('priority', $owners), true)];
        }
        $start = $input['start'] ?? null;
        $length = array_key_exists('length', $input) ? $input['length'] : LIMITS['eventDefaultLength'];
        $step = LIMITS['eventStep'];
        if (!is_int($start) || !is_int($length) || $start % $step !== 0 || $length % $step !== 0
            || $start < LIMITS['eventStartMin'] || $length < $minimum || $start + $length > LIMITS['eventEndMin']) {
            throw self::bad('Choose a start and length in ' . $step . '-minute steps, from 7:00 am to 7:00 am the next morning, at least ' . $minimum . ' minutes.');
        }
        return ['owners' => $owners, 'date' => $date, 'text' => clean_text($input['text'] ?? null, item_text_limit('event', $owners), true),
            'start' => $start, 'length' => $length];
    }
    /** A line (1 to 5) for every owner and for no one else, in owner order. */
    private static function slots(mixed $slots, array $owners): array {
        if (!is_array($slots) || array_is_list($slots)) { throw self::bad('Choose a line for each list.'); }
        $named = array_map('strval', array_keys($slots));
        sort($named, SORT_STRING);
        if ($named !== $owners) { throw self::bad('Choose a line for each list.'); }
        foreach ($slots as $slot) {
            if (!is_int($slot) || $slot < 1 || $slot > LIMITS['prioritySlots']) { throw self::bad('Choose a line from 1 to ' . LIMITS['prioritySlots'] . '.'); }
        }
        ksort($slots, SORT_STRING);
        return $slots;
    }

    // ---- limits, slots and overlaps ----

    /**
     * The checks that depend on the rest of the store, with the record itself excluded. A cap blocks only an entry
     * that is newly counted in a list on a day: an edit that leaves it where it was always passes, and so does one that moves an
     * open to-do onto today from an earlier day, where today's list already carries it.
     */
    private static function guard(array $db, string $kind, array $f, ?array $old, ?string $today): void {
        $self = $old['id'] ?? null;
        if ($kind === 'todo') {
            foreach ($f['owners'] as $owner) {
                if ($old !== null && in_array($owner, $old['owners'], true) && ($old['date'] === $f['date'] || carried_to($old, $f['date'], $today))) { continue; }
                if ($f['scope'] === 'day') {
                    if ($old === null || !$old['done']) { self::checkOpen($db, $owner, $f['date'], $self, $today); }
                    continue;
                }
                $rows = 0;
                foreach ($db['tasks'] as $task) {
                    if ($task['scope'] === $f['scope'] && $task['date'] === $f['date'] && $task['id'] !== $self && in_array($owner, $task['owners'], true)) { ++$rows; }
                }
                if ($rows >= LIMITS['periodTodosPerList']) {
                    throw new RequestError(self::name($db, $owner) . ' already has ' . LIMITS['periodTodosPerList'] . ' to-dos for that ' . $f['scope'] . '.', 409, 'limit', 'periodTodosPerList');
                }
            }
        } elseif ($kind === 'priority') {
            foreach ($f['owners'] as $owner) {
                foreach ($db['priorities'] as $other) {
                    if ($other['id'] !== $self && $other['date'] === $f['date'] && ($other['slots'][$owner] ?? null) === $f['slots'][$owner]) {
                        throw new RequestError('Line ' . $f['slots'][$owner] . ' is already taken in ' . self::name($db, $owner) . '.', 409, 'slot_taken');
                    }
                }
            }
        } elseif (find_event_overlap($db, $f['date'], $f['owners'], $f['start'], $f['length'], $self) !== null) {
            throw new RequestError('That time is already taken in this list.', 409, 'overlap');
        }
    }
    /** One more open day to-do for `$listId` on `$date` must fit under the cap (on `$today`, with the carried-over ones counted). */
    private static function checkOpen(array $db, string $listId, string $date, ?string $excludeId, ?string $today): void {
        if (open_count($db, $listId, $date, $excludeId, $today) >= LIMITS['dayTodosPerList']) {
            throw new RequestError(self::name($db, $listId) . ' already has ' . LIMITS['dayTodosPerList'] . ' things to do that day.', 409, 'limit', 'dayTodosPerList');
        }
    }
    private static function name(array $db, string $listId): string { return $db['lists'][$listId]['name'] ?? 'That list'; }

    // ---- to-do order ----

    /** The ids of a (scope, date) bucket in display order: by pos, ties by id. */
    private static function ordered(array $db, string $scope, string $date): array {
        $rows = [];
        foreach ($db['tasks'] as $task) {
            if ($task['scope'] === $scope && $task['date'] === $date) { $rows[] = [$task['pos'], $task['id']]; }
        }
        usort($rows, fn($a, $b) => $a <=> $b);
        return array_column($rows, 1);
    }
    private static function endPos(array $db, string $scope, string $date, ?string $excludeId): int {
        $end = 0;
        foreach ($db['tasks'] as $task) {
            if ($task['scope'] === $scope && $task['date'] === $date && $task['id'] !== $excludeId) { $end = max($end, $task['pos']); }
        }
        return $end + LIMITS['posGap'];
    }

    private static function stamp(array $record, string $user): array {
        $record['revision'] += 1;
        $record['updatedBy'] = $user;
        $record['updatedAt'] = gmdate('c');
        return $record;
    }
}
