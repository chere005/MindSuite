<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/limits.php';
require_once __DIR__ . '/error.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/workspace.php';

// ---------------------------------------------------------------- the release

/**
 * The name of the release an entrypoint belongs to, from the name of the directory it runs in ("20261102093000-4"), or ''
 * for anything else (the local preview, a stray copy). A release's public code and its lib are bound by this name, and api.php
 * sends it as X-TaskMind-Release on every response. index.php and api.php run before this lib is found, so each repeats the pattern
 * below inline; a server case reads both files and fails if they disagree with it.
 */
const RELEASE_STAMP_PATTERN = '^\d{14}-\d+$';
function release_stamp(string $entryDir): string {
    $name = basename($entryDir);
    return preg_match('/' . RELEASE_STAMP_PATTERN . '/D', $name) === 1 ? $name : '';
}

/** Which host instance a request is for: '-test' or '-dev' for those subdomains of seancheren.com, '' for production. */
function instance_of(string $host): string {
    return preg_match('/^(test|dev)\.seancheren\.com(?::\d+)?$/i', $host, $m) === 1 ? '-' . strtolower($m[1]) : '';
}

// ---------------------------------------------------------------- the team

/** One line of text as a person typed it: whitespace collapsed, control characters gone, nothing visible means '', cut to `$max` characters. */
function clean_text(string $s, int $max): string {
    $s = (string)preg_replace('/\p{Cc}/u', '', (string)preg_replace('/\s+/u', ' ', $s));
    if (preg_match('/[^\p{Cc}\p{Cf}\p{Z}]/u', $s) !== 1) { return ''; }
    return mb_substr(trim($s), 0, $max);
}

/** Whether `$id` has the shape of a member id (a site username). */
function valid_id(mixed $id): bool { return is_string($id) && preg_match('/^' . MODEL['idPattern'] . '$/D', $id) === 1; }

/**
 * The people who own the workspace when it is first made, and who get back in when it cannot be read: `taskmind_owners` of the
 * site's server configuration (never a request parameter). Anything that is not a member id is dropped. With nothing configured the
 * list is empty and a fresh workspace is not created (open_workspace refuses): no id is ever built into the code.
 */
function seed_owners(array $config): array {
    $ids = [];
    foreach ((array)($config['taskmind_owners'] ?? []) as $id) {
        $id = is_string($id) ? trim($id) : '';
        if (valid_id($id) && !in_array($id, $ids, true)) { $ids[] = $id; }
    }
    return $ids;
}

/** The admin a fresh workspace starts with: `taskmind_seed_admin` of the server configuration if it is a member id, else the first owner. */
function seed_admin(array $config, array $owners): ?string {
    $id = $config['taskmind_seed_admin'] ?? null;
    $id = is_string($id) ? trim($id) : '';
    return valid_id($id) ? $id : ($owners[0] ?? null);
}

/** The team a workspace starts with: the seed owners, and the seed admin unless that person is an owner already. */
function seed_members(array $owners, ?string $admin = null): array {
    $row = fn(string $id, string $role) => ['id' => $id, 'role' => $role, 'added' => 0, 'by' => '', 'name' => ''];
    $members = array_map(fn($id) => $row($id, 'owner'), $owners);
    if ($admin !== null && !in_array($admin, $owners, true)) { $members[] = $row($admin, 'admin'); }
    return $members;
}

/**
 * The members of a stored workspace, cleaned. A stored workspace always has a `members` list (the seed team is written once, when
 * the file is first made: see open_workspace), so one without it is damaged and throws, never read as "no team yet". One that has
 * members but no owner gets the seed owners back as owners, so there is always one. An unknown role is a viewer, never more.
 */
function clean_members(array $db, array $owners): array {
    if (!is_array($db['members'] ?? null)) { throw new WorkspaceDamaged('The workspace has no team.'); }
    $out = []; $seen = [];
    foreach ($db['members'] as $m) {
        if (!is_array($m) || count($out) >= LIMITS['membersMax']) { continue; }
        $id = $m['id'] ?? null;
        if (!valid_id($id) || isset($seen[$id])) { continue; }
        $seen[$id] = true;
        $role = $m['role'] ?? '';
        $by = $m['by'] ?? '';
        $out[] = ['id' => $id, 'role' => in_array($role, MODEL['roles'], true) ? $role : 'viewer', 'added' => (int)($m['added'] ?? 0),
            'by' => valid_id($by) ? $by : '', 'name' => clean_text(is_string($m['name'] ?? null) ? $m['name'] : '', LIMITS['memberNameChars'])];
    }
    if (!array_filter($out, fn($m) => $m['role'] === 'owner')) {
        foreach ($owners as $id) {
            $at = array_search($id, array_column($out, 'id'), true);
            if ($at === false) { $out[] = ['id' => $id, 'role' => 'owner', 'added' => 0, 'by' => '', 'name' => '']; }
            else { $out[$at]['role'] = 'owner'; }
        }
    }
    return $out;
}

/** The member row of `$user`, or null when they are not on the team. */
function find_member(array $members, string $user): ?array {
    foreach ($members as $m) { if ($m['id'] === $user) { return $m; } }
    return null;
}

/** A workspace that is there but cannot be used (damaged, no team, or lost after it existed). The gate fails closed on it. */
class WorkspaceDamaged extends \RuntimeException {}
/** The workspace file is gone from a data directory that has held one (its version marker or a backup is still there). */
final class WorkspaceLost extends WorkspaceDamaged {}

/**
 * The stored workspace. On a fresh install (no workspace file, and no version marker or backup saying there ever was one) the seed
 * team is written once, under the store's lock, and the log says so; a second request finds the file. A file that is there but
 * cannot be read, decrypted or authenticated throws, and so does a missing file in a directory that held one (WorkspaceLost):
 * neither is ever treated as a fresh install.
 */
function open_workspace(Store $store, array $owners, ?string $admin = null): array {
    $seeded = false;
    $db = $store->transaction('workspace', function (array $stored, bool $exists) use ($store, $owners, $admin, &$seeded): array {
        if ($exists) { return $stored; }
        if ($store->hadWorkspace()) { throw new WorkspaceLost('workspace.enc is missing but this data directory has held one.'); }
        if ($owners === []) { throw new RequestError('TaskMind has no owners configured, so it cannot create its team.', 503); }
        $seeded = true;
        return ['v' => MODEL['storeVersion'], 'members' => seed_members($owners, $admin)];
    });
    if ($seeded) { error_log('TaskMind workspace created on first use with the seed team: ' . implode(', ', array_column($db['members'], 'id'))); }
    return $db;
}

/**
 * THE GATE: who may open TaskMind, decided from the workspace file on every request (removing someone takes effect at once) and
 * independently by every endpoint, never remembered in the session. It FAILS CLOSED: a workspace that cannot be read, has no team or
 * was lost admits no one, except that the seed owners are told why (503) so the owner can still see the error. Returns the member's
 * row; throws RequestError 403 for a person who is not on the team and 503 when the workspace cannot be used.
 */
function team_member(Store $store, array $config, string $user): array {
    return workspace_member(team_workspace($store, $config, $user), $user);
}

/** Load an authorized snapshot, with no domain writes on a read. */
function team_workspace(Store $store, array $config, string $user): array {
    $owners = seed_owners($config);
    try {
        $db = read_workspace(open_workspace($store, $owners, seed_admin($config, $owners)), $owners);
    } catch (RequestError $e) {
        throw $e;
    } catch (\Throwable $e) {
        throw workspace_read_error($e, $owners, $user);
    }
    workspace_member($db, $user);
    return $db;
}

/** A broken workspace's details are visible only to the configured seed owners. */
function workspace_read_error(\Throwable $e, array $owners, string $user): RequestError {
    error_log('TaskMind workspace unreadable: ' . get_class($e));
    if (in_array($user, $owners, true)) {
        return new RequestError($e instanceof WorkspaceLost
            ? 'TaskMind\'s workspace file is missing, but this install has held one. Nothing has been changed; restore it from a backup.'
            : 'TaskMind could not read its workspace. Nothing has been changed.', 503);
    }
    return new RequestError('TaskMind is for members of its team.', 403);
}

/** What GET answers a signed-in team member (the Session of model.ts). */
function session_reply(array $member, string $csrf, string $theme): array {
    return ['ok' => true, 'me' => $member['id'], 'role' => $member['role'], 'name' => $member['name'], 'csrf' => $csrf, 'theme' => $theme];
}
