<?php
declare(strict_types=1);
namespace PlanMind;

/**
 * Handlers for the chore chart: the rules (`saveChore`, `deleteChore`), what happened to one turn of a rule (`markChore`) and the A/B
 * rhythm (`saveRhythm`). Same contract as planner_lists.php: each takes the validated db, the decoded request and the authorized user and
 * returns the new db, or the very array it was given when nothing changes; none touches the global revision (mutate() does).
 * A malformed request is 400 first, then what the store says (gone, id_in_use, stale, limit).
 */

/** Chores belong to one person or both, never to a custom list: the canonical owners of a person list or exactly the two people's ids. */
function chore_owners(array $db, mixed $owners): array {
    if (is_array($owners)) {
        foreach ($owners as $owner) {
            if (!in_array($owner, pm_person_lists(), true)) { throw new RequestError('Choose one person or Both.', 400, 'invalid'); }
        }
    }
    return canonical_owners($db, $owners);
}

/**
 * A cadence in canonical form (exactly its own keys, in a fixed order), or null: daily; weekly on a day (0 Sunday to 5 Friday, never
 * Saturday) every week or only Week A or B; monthly on the nth (or last, -1) such day in every, odd or even months.
 */
function valid_cadence(mixed $cadence): ?array {
    if (!is_array($cadence) || array_is_list($cadence)) { return null; }
    $keys = fn(string ...$names) => count($cadence) === count($names) && !array_diff($names, array_keys($cadence));
    $day = fn(string $key) => is_int($cadence[$key] ?? null) && in_array($cadence[$key], MODEL['choreDays'], true);
    $word = fn(string $key, array $allowed) => is_string($cadence[$key] ?? null) && in_array($cadence[$key], $allowed, true);
    return match ($cadence['kind'] ?? null) {
        'daily' => $keys('kind') ? ['kind' => 'daily'] : null,
        'weekly' => $keys('kind', 'day', 'weeks') && $day('day') && $word('weeks', MODEL['choreWeeks'])
            ? ['kind' => 'weekly', 'day' => $cadence['day'], 'weeks' => $cadence['weeks']] : null,
        'monthly' => $keys('kind', 'nth', 'day', 'months') && is_int($cadence['nth']) && in_array($cadence['nth'], MODEL['choreNths'], true) && $day('day') && $word('months', MODEL['choreMonths'])
            ? ['kind' => 'monthly', 'nth' => $cadence['nth'], 'day' => $cadence['day'], 'months' => $cadence['months']] : null,
        default => null,
    };
}

/**
 * Creates (`revision` 0) or edits a rule: its title, owners and cadence. A create takes the next order. A create with an id that exists is
 * a lost-response retry when the same person made it with the same fields, else id_in_use.
 */
function op_save_chore(array $db, array $input, string $user): array {
    $id = $input['id'] ?? null;
    if (!valid_id($id)) { throw new RequestError('That chore cannot be saved.', 400, 'invalid'); }
    $revision = ListOps::revision($input);
    $title = clean_text($input['title'] ?? null, LIMITS['choreTitleChars'], true);
    $owners = chore_owners($db, $input['owners'] ?? null);
    $cadence = valid_cadence($input['cadence'] ?? null) ?? throw new RequestError('Choose when the chore happens. Saturday is always off.', 400, 'invalid');
    $rule = $db['chores'][$id] ?? null;

    if ($revision === 0) {
        if ($rule !== null) {
            if ($rule['updatedBy'] === $user && $rule['title'] === $title && $rule['owners'] === $owners && $rule['cadence'] === $cadence) { return $db; }
            throw new RequestError('That chore ID is already in use.', 409, 'id_in_use');
        }
        if (count($db['chores']) >= LIMITS['choresMax']) { throw new RequestError('You can have up to ' . LIMITS['choresMax'] . ' chores.', 409, 'limit', 'choresMax'); }
        $db['chores'][$id] = ['id' => $id, 'title' => $title, 'owners' => $owners, 'cadence' => $cadence, 'order' => $db['chores'] ? 1 + max(array_column($db['chores'], 'order')) : 0,
            'revision' => 1, 'updatedBy' => $user, 'updatedAt' => ListOps::now()];
        return $db;
    }

    if ($rule === null) { throw ListOps::gone('That chore was removed.'); }
    if ($revision !== $rule['revision']) { throw ListOps::stale('This chore'); }
    if ($title === $rule['title'] && $owners === $rule['owners'] && $cadence === $rule['cadence']) { return $db; }
    $db['chores'][$id] = array_replace($rule, ['title' => $title, 'owners' => $owners, 'cadence' => $cadence,
        'revision' => $rule['revision'] + 1, 'updatedBy' => $user, 'updatedAt' => ListOps::now()]);
    return $db;
}

/** Removes a rule and, in the same write, every mark of it. */
function op_delete_chore(array $db, array $input, string $user): array {
    if (($input['confirm'] ?? null) !== true) { throw new RequestError('Confirm removal first.', 400, 'invalid'); }
    $id = $input['id'] ?? null;
    if (!valid_id($id)) { throw new RequestError('That chore cannot be removed.', 400, 'invalid'); }
    $revision = ListOps::revision($input);
    $rule = $db['chores'][$id] ?? null;
    if ($rule === null) { throw ListOps::gone('That chore was already removed.'); }
    if ($revision !== $rule['revision']) { throw ListOps::stale('This chore'); }
    unset($db['chores'][$id]);
    foreach ($db['choreMarks'] as $key => $mark) {
        if ($mark['ruleId'] === $id) { unset($db['choreMarks'][$key]); }
    }
    return $db;
}

/**
 * Sets what happened to the turn of a rule on a date: done or let go, moved to the catch-up Friday, or handed to another owner for that
 * turn alone. `revision` is the stored mark's (0 when it has none). A turn left open, unmoved and without an owner has no mark, so that
 * request deletes it. The same state as stored is a success without a write. The date must be a real day on or after the rhythm's start and
 * not a Saturday; whether the rule actually has a turn that day is the client's rule engine's business, not the store's.
 */
function op_mark_chore(array $db, array $input, string $user): array {
    $ruleId = $input['ruleId'] ?? null;
    $date = $input['date'] ?? null;
    $state = $input['state'] ?? null;
    $moved = $input['moved'] ?? null;
    if (!valid_id($ruleId) || !valid_date($date)) { throw new RequestError('That turn does not exist.', 400, 'invalid'); }
    if (!is_string($state) || !in_array($state, MODEL['choreMarkStates'], true) || !is_bool($moved)) { throw new RequestError('Invalid request.', 400, 'invalid'); }
    $given = $input['owners'] ?? null;
    $owners = $given === null ? null : chore_owners($db, $given);
    $revision = ListOps::revision($input);
    if ($date < $db['rhythm']['start']) { throw new RequestError('The chart starts on ' . $db['rhythm']['start'] . '.', 400, 'invalid'); }
    if ((new \DateTimeImmutable($date))->format('N') === '6') { throw new RequestError('Saturday is a day off.', 400, 'invalid'); }
    if (!isset($db['chores'][$ruleId])) { throw ListOps::gone('That chore was removed.'); }

    $key = "$ruleId:$date";
    $mark = $db['choreMarks'][$key] ?? null;
    if ($state === 'open' && !$moved && $owners === null) {
        if ($mark === null) { return $db; }
        if ($revision !== $mark['revision']) { throw ListOps::stale('This chore'); }
        unset($db['choreMarks'][$key]);
        return $db;
    }
    if ($mark !== null && $mark['state'] === $state && $mark['moved'] === $moved && ($mark['owners'] ?? null) === $owners) { return $db; }
    if ($revision !== ($mark['revision'] ?? 0)) { throw ListOps::stale('This chore'); }
    if ($mark === null && count($db['choreMarks']) >= LIMITS['choreMarksMax']) { throw new RequestError('The chart has too many marks.', 409, 'limit', 'choreMarksMax'); }
    $db['choreMarks'][$key] = ['id' => $key, 'ruleId' => $ruleId, 'date' => $date, 'state' => $state, 'moved' => $moved] + ($owners === null ? [] : ['owners' => $owners])
        + ['revision' => ($mark['revision'] ?? 0) + 1, 'updatedBy' => $user, 'updatedAt' => ListOps::now()];
    return $db;
}

/** Moves the A/B anchor: a Monday whose week is Week A. */
function op_save_rhythm(array $db, array $input, string $user): array {
    $anchor = $input['anchor'] ?? null;
    if (!is_string($anchor) || !valid_period('week', $anchor)) { throw new RequestError('Week A starts on a Monday.', 400, 'invalid'); }
    $revision = ListOps::revision($input);
    $rhythm = $db['rhythm'];
    if ($revision !== $rhythm['revision']) { throw ListOps::stale('The rhythm'); }
    if ($anchor === $rhythm['anchor']) { return $db; }
    $db['rhythm'] = array_replace($rhythm, ['anchor' => $anchor, 'revision' => $rhythm['revision'] + 1, 'updatedBy' => $user, 'updatedAt' => ListOps::now()]);
    return $db;
}
