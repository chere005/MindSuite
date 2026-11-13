<?php
declare(strict_types=1);
namespace PlanMind;

/**
 * The household's two accounts, by role: the one seam between the code, which speaks in roles (owner, partner, both), and the
 * accounts, which only the server's private config names: `'people' => ['owner' => <account>, 'partner' => <account>]` in the
 * site config (app_config()). Stored data stays keyed by the account ids (list ids, owners, createdBy/updatedBy, note keys, prefs,
 * CalMind's records-<id>.json); nothing here moves or renames it.
 *
 * Fail closed: without two distinct, well-formed accounts under `owner` and `partner`, pm_people() and everything built on it throws
 * a 503 `unavailable` before a store is read or written. pm_people_configured() is the public health answer (yes or no, never who).
 * Tests hand in the people their fixtures are written for through pm_people_use(); a request never calls it.
 */
final class People {
    /** What pm_people_use() handed in, when it did. */
    public static bool $given = false;
    public static mixed $value = null;
    /** The last raw value read and what it validated to, so the many checks of one request validate once. */
    public static mixed $raw = null;
    public static ?array $people = null;
    public static bool $known = false;
}

/** Test seam: use these people instead of the config's (null goes back to reading app_config()['people']). */
function pm_people_use(?array $people): void {
    People::$given = $people !== null;
    People::$value = $people;
    People::$known = false;
}

/** ['owner' => id, 'partner' => id] when the config names the two accounts correctly, else null. Never throws. */
function pm_people_read(): ?array {
    $raw = People::$given ? People::$value : (\function_exists('app_config') ? (\app_config()['people'] ?? null) : null);
    if (People::$known && People::$raw === $raw) { return People::$people; }
    $ok = fn(mixed $id): bool => is_string($id) && preg_match('/^[a-z][a-z0-9_-]{0,31}$/D', $id) === 1 && !in_array($id, ['both', 'all', 'owner', 'partner'], true);
    $people = is_array($raw) && count($raw) === 2 && $ok($raw['owner'] ?? null) && $ok($raw['partner'] ?? null) && $raw['owner'] !== $raw['partner']
        ? ['owner' => $raw['owner'], 'partner' => $raw['partner']] : null;
    [People::$raw, People::$people, People::$known] = [$raw, $people, true];
    return $people;
}

/** Whether the config names the two people (the public health flag). */
function pm_people_configured(): bool { return pm_people_read() !== null; }

/** ['owner' => id, 'partner' => id]. Throws a 503 `unavailable` when the config does not name them. */
function pm_people(): array {
    $people = pm_people_read();
    if ($people === null) {
        error_log('PlanMind people config missing or invalid');
        throw new RequestError('PlanMind is temporarily unavailable.', 503, 'unavailable');
    }
    return $people;
}

/** The two people's list ids in list order (MODEL['personRoles']: the partner's, then the owner's). */
function pm_person_lists(): array {
    $people = pm_people();
    return array_map(fn(string $role) => $people[$role], MODEL['personRoles']);
}

/** The owners of a linked item, ONE record of both people: their two ids, sorted (the canonical form). */
function pm_both_owners(): array {
    $both = pm_person_lists();
    sort($both, SORT_STRING);
    return $both;
}

/** 'owner' or 'partner' for one of the two accounts, else null. */
function pm_role_of(mixed $id): ?string {
    $role = is_string($id) ? array_search($id, pm_people(), true) : false;
    return is_string($role) ? $role : null;
}
