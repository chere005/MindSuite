<?php
declare(strict_types=1);
namespace PlanMind;

/**
 * Handlers for notes, lists, settings and picker preferences (section 12 of the spec). Each takes the validated db,
 * the decoded request and the authorized user and returns the new db, or the very array it was given when nothing
 * changes. They never touch the global revision (mutate() does) and never add a field beyond model.ts.
 * Order of refusals: a malformed request is 400 first, then what the store says (gone, id_in_use, stale, limit).
 */

/** Saves one list's text for a period. `revision` 0 creates it; the same text as stored is a success without a write. */
function op_save_note(array $db, array $input, string $user): array {
    $scope = ListOps::field($input, 'scope'); $period = ListOps::field($input, 'period'); $field = ListOps::field($input, 'field');
    $listId = ListOps::listId($input['listId'] ?? null);
    $revision = ListOps::revision($input);
    if (!in_array($field, MODEL['noteFields'][$scope] ?? [], true)) { throw new RequestError('That text does not exist in this view.', 400, 'invalid'); }
    if (!valid_period($scope, $period)) { throw new RequestError('Weeks start on Monday and months on the first.', 400, 'invalid'); }
    $text = clean_text($input['text'] ?? null, item_text_limit('note', [$listId], $scope), false);
    if (!isset($db['lists'][$listId])) { throw ListOps::gone('That list was removed.'); }
    $key = "$scope:$period:$listId:$field";
    $note = $db['notes'][$key] ?? null;
    if ($text === ($note['text'] ?? '')) { return $db; }
    if ($revision !== ($note['revision'] ?? 0)) {
        throw new RequestError('This note changed on another device. Your draft is preserved; reload the saved note before replacing it.', 409, 'stale');
    }
    if ($note === null && count($db['notes']) >= LIMITS['notesMax']) { throw new RequestError('The planner has too many notes.', 409, 'limit', 'notesMax'); }
    $db['notes'][$key] = ['key' => $key, 'scope' => $scope, 'period' => $period, 'listId' => $listId, 'field' => $field, 'text' => $text,
        'revision' => $revision + 1, 'updatedBy' => $user, 'updatedAt' => ListOps::now()];
    return $db;
}

/**
 * Creates (`revision` 0, name required), renames or recolors a list. The two people's lists take a color only. A create with an
 * id that exists is a lost-response retry when the same person made it from the same name, else id_in_use.
 */
function op_save_list(array $db, array $input, string $user): array {
    $id = ListOps::listId($input['id'] ?? null);
    $color = ListOps::color($input['color'] ?? null);
    $revision = ListOps::revision($input);
    $name = $input['name'] ?? null;
    if ($name !== null && !is_string($name)) { throw new RequestError('Use plain text.', 400, 'invalid'); }
    $list = $db['lists'][$id] ?? null;

    if (in_array($id, pm_person_lists(), true)) {
        if ($name !== null && $name !== $list['name']) { throw new RequestError('The two people\'s lists keep their names.', 400, 'invalid'); }
        if ($revision !== $list['revision']) { throw ListOps::stale('This list'); }
        return ListOps::write($db, $id, ['color' => $color]);
    }

    if ($revision === 0) {
        if ($name === null) { throw new RequestError('Name the list.', 400, 'invalid'); }
        $name = clean_text($name, LIMITS['listNameChars'], true);
        $ak = fingerprint(['kind' => 'list', 'name' => $name]); // the name alone, as harness_db() fingerprints its list
        if ($list !== null) {
            if (($list['createdBy'] ?? null) === $user && ($list['ak'] ?? null) === $ak) { return $db; }
            throw new RequestError('That list ID is already in use.', 409, 'id_in_use');
        }
        ListOps::nameFree($db, $name, null);
        if (count($db['lists']) - count(pm_person_lists()) >= LIMITS['customListsMax']) {
            throw new RequestError('You can have up to ' . LIMITS['customListsMax'] . ' extra lists.', 409, 'limit', 'customListsMax');
        }
        $db['lists'][$id] = ['id' => $id, 'kind' => 'custom', 'name' => $name, 'color' => $color, 'order' => 1 + max(array_column($db['lists'], 'order')),
            'revision' => 1, 'ak' => $ak, 'createdBy' => $user, 'updatedAt' => ListOps::now()];
        return $db;
    }

    if ($name !== null) { $name = clean_text($name, LIMITS['listNameChars'], true); }
    if ($list === null) { throw ListOps::gone('That list was removed.'); }
    if ($revision !== $list['revision']) { throw ListOps::stale('This list'); }
    if ($name !== null) { ListOps::nameFree($db, $name, $id); }
    return ListOps::write($db, $id, ['name' => $name ?? $list['name'], 'color' => $color]);
}

/**
 * Removes a custom list and, in one write, everything that belongs to it alone: its sole-owner to-dos, priorities and
 * events, its notes, and its id in every account's picker state. Linked items belong to the two people and stay.
 */
function op_delete_list(array $db, array $input, string $user): array {
    if (($input['confirm'] ?? null) !== true) { throw new RequestError('Confirm removal first.', 400, 'invalid'); }
    $id = $input['id'] ?? null;
    if (!valid_id($id)) { throw new RequestError('That list cannot be removed.', 400, 'invalid'); }
    $revision = ListOps::revision($input);
    $list = $db['lists'][$id] ?? null;
    if ($list === null) { throw ListOps::gone('That list was already removed.'); }
    if ($revision !== $list['revision']) { throw ListOps::stale('This list'); }
    foreach (['tasks', 'priorities', 'events'] as $collection) {
        foreach ($db[$collection] as $key => $item) {
            if ($item['owners'] === [$id]) { unset($db[$collection][$key]); }
        }
    }
    foreach ($db['notes'] as $key => $note) {
        if ($note['listId'] === $id) { unset($db['notes'][$key]); }
    }
    unset($db['lists'][$id]);
    foreach ($db['prefs'] as $person => $prefs) {
        $selection = $prefs['selection'];
        $db['prefs'][$person]['selection'] = ['base' => $selection['base'] === $id ? 'both' : $selection['base'],
            'overlays' => array_values(array_filter($selection['overlays'], fn($overlay) => $overlay !== $id))];
    }
    return $db;
}

/** Sets the household's Both color. */
function op_save_settings(array $db, array $input, string $user): array {
    $color = ListOps::color($input['bothColor'] ?? null);
    $revision = ListOps::revision($input);
    $settings = $db['settings'];
    if ($revision !== $settings['revision']) { throw ListOps::stale('This setting'); }
    if ($color === $settings['bothColor']) { return $db; }
    $db['settings'] = ['bothColor' => $color, 'revision' => $settings['revision'] + 1, 'updatedAt' => ListOps::now()];
    return $db;
}

/**
 * The setBothColor action (the owner, 2026-11-09, #138): the color of Both is per person. It is the caller's own account preference,
 * a key of the account library's prefs file beside the theme and the CalMind switch, not planner data, so the store stays v5 and
 * an older release still opens it (a pick leaves nothing an older reader would refuse). The household's `settings.bothColor`
 * is the default for a person who has not picked, and is never rewritten by a pick. Like op_set_theme the pick is claimed saved
 * only when it reads back.
 *
 * `bothColor: null` clears the pick, back to the household default (the e2e specs and a future "use the default" control).
 *
 * @param callable(?string): mixed $set
 * @param callable(): ?string $get
 * @return array{bothColor: ?string}
 */
function op_set_both_color(array $input, string $user, callable $set, callable $get): array {
    if (!in_array($user, pm_person_lists(), true)) { throw new RequestError('Access denied.', 403, 'forbidden'); }
    $color = array_key_exists('bothColor', $input) && $input['bothColor'] === null ? null : ListOps::color($input['bothColor'] ?? null);
    set_error_handler(static function (int $level, string $message): bool { throw new \ErrorException($message, 0, $level); });
    try { $set($color); $saved = $get() === $color; }
    catch (\Throwable $e) { error_log('PlanMind Both color write failed: ' . get_class($e)); $saved = false; }
    finally { restore_error_handler(); }
    if (!$saved) { throw new RequestError('That color could not be saved.', 503, 'unavailable'); }
    return ['bothColor' => $color];
}

/** The caller's own Both color from the account library's prefs file, or null (none picked, or a value outside the palette). */
function both_color_get(): ?string {
    $c = \store_read(\theme_file())['planmindBothColor'] ?? null;
    return is_string($c) && in_array($c, MODEL['colorKeys'], true) ? $c : null;
}
/** Writes the caller's Both color (null: none, the household default again), leaving the account's other preferences as they are. */
function both_color_set(?string $color): void {
    // Read, change and write under one lock beside the file, so two requests of the same account (a second pick, the CalMind switch) never lose each other's key.
    prefs_locked(function () use ($color): void {
        $p = \store_read(\theme_file());
        if ($color === null) { unset($p['planmindBothColor']); } else { $p['planmindBothColor'] = $color; }
        \store_write(\theme_file(), $p);
    });
}
/** Runs a read-modify-write of the caller's prefs file (the account library's, beside the theme) holding the lock PlanMind's own keys of it share. */
function prefs_locked(callable $change): void {
    \MindSuite\Files\with_file_lock(\theme_file() . '.lock', $change);
}

/**
 * Stores the caller's own preferences, last write wins: the picker state and, when `sidebar` is sent, whether the desktop
 * sidebar is shown. Lists that are gone, repeats, the two people's lists, the base itself and overlays beyond the limit are dropped
 * silently (another device may have just deleted a list); a state of the wrong shape is a client bug and refused. A sidebar
 * word other than 'hidden' means shown (it is stored only when hidden), and a missing one keeps what is stored. Nothing is
 * written when the sanitised preferences are what is already stored.
 */
function op_save_prefs(array $db, array $input, string $user): array {
    $selection = $input['selection'] ?? null;
    if (!is_array($selection) || !is_string($selection['base'] ?? null) || !is_array($selection['overlays'] ?? null) || !array_is_list($selection['overlays'])
        || array_filter($selection['overlays'], fn($overlay) => !is_string($overlay))) {
        throw new RequestError('Invalid list selection.', 400, 'invalid');
    }
    $selection = Invariants::selection($db, $selection);
    $stored = $db['prefs'][$user] ?? ['selection' => ['base' => 'both', 'overlays' => []]];
    $sidebar = array_key_exists('sidebar', $input) ? Invariants::sidebar($input['sidebar']) : Invariants::sidebar($stored['sidebar'] ?? null);
    $next = ['selection' => $selection] + ($sidebar === 'hidden' ? ['sidebar' => 'hidden'] : []);
    if ($next !== $stored) { $db['prefs'][$user] = $next; }
    return $db;
}

/** Helpers of the handlers above; a class so they cannot collide with another file's functions. */
final class ListOps {
    /** Names a custom list may not take, in any case (the views and the two permanent lists). */
    private static function reserved(): array { return [...pm_person_lists(), 'both', 'all']; }

    public static function now(): string { return gmdate('c'); }
    public static function field(array $input, string $field): string {
        $value = $input[$field] ?? null;
        if (!is_string($value)) { throw new RequestError('Invalid request.', 400, 'invalid'); }
        return $value;
    }
    public static function revision(array $input): int {
        $revision = $input['revision'] ?? null;
        if (!is_int($revision) || $revision < 0) { throw new RequestError('Invalid request.', 400, 'invalid'); }
        return $revision;
    }
    public static function color(mixed $color): string {
        if (!is_string($color) || !in_array($color, MODEL['colorKeys'], true)) { throw new RequestError('Choose a color from the palette.', 400, 'invalid'); }
        return $color;
    }
    /** One of the two people's list ids or a custom list's UUID. The view names (both, all) and anything else are not lists. */
    public static function listId(mixed $id): string {
        if (!is_string($id) || !(in_array($id, pm_person_lists(), true) || valid_id($id))) { throw new RequestError('Choose one list.', 400, 'invalid'); }
        return $id;
    }
    public static function stale(string $what): RequestError {
        return new RequestError("$what changed on another device. Refresh to see the latest.", 409, 'stale');
    }
    public static function gone(string $message): RequestError {
        return new RequestError("$message Refresh to see the latest.", 409, 'gone');
    }
    /** A custom name must differ, ignoring case, from every other list and from the reserved words. */
    public static function nameFree(array $db, string $name, ?string $exceptId): void {
        $lower = mb_strtolower($name, 'UTF-8');
        if (in_array($lower, self::reserved(), true)) { throw new RequestError('That name is reserved.', 409, 'name_taken'); }
        foreach ($db['lists'] as $list) {
            if ($list['id'] !== $exceptId && mb_strtolower($list['name'], 'UTF-8') === $lower) { throw new RequestError('A list with that name already exists.', 409, 'name_taken'); }
        }
    }
    /** Stores the edited fields of a list with its revision moved on; an edit that changes nothing writes nothing. */
    public static function write(array $db, string $id, array $edited): array {
        $before = $db['lists'][$id];
        $list = array_replace($before, $edited);
        if ($list === $before) { return $db; }
        $db['lists'][$id] = array_replace($list, ['revision' => $before['revision'] + 1, 'updatedAt' => self::now()]);
        return $db;
    }
}
