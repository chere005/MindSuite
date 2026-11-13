<?php
declare(strict_types=1);
namespace TaskMind;

/** The initial domain is additive to the scaffold's version-1 team-only file. */
const WORKSPACE_DEFAULTS = [
    'rev' => 1, 'seq' => 0, 'event_seq' => 0, 'acl_rev' => 0, 'tomb_floor' => 0, 'replay_floor' => 0,
    'team' => ['name' => 'Team', 'rv' => 1], 'projects' => [], 'tasks' => [],
    'activity' => [], 'events' => [], 'tombstones' => [], 'replays' => [],
];

/** Read the scaffold format or a complete domain. Never turn a partial domain into an empty workspace. */
function read_workspace(array $stored, array $owners): array {
    if (($stored['v'] ?? null) !== MODEL['storeVersion']) { throw new WorkspaceDamaged('Unknown workspace version.'); }
    $members = clean_members($stored, $owners);
    $domain = array_intersect_key($stored, WORKSPACE_DEFAULTS);
    if ($domain === []) {
        return ['v' => $stored['v'], 'members' => array_map(fn($m) => $m + ['rv' => 1], $members)] + WORKSPACE_DEFAULTS;
    }
    $rev = $domain['rev'] ?? null;
    if (!is_int($rev) || $rev < 1 || count($domain) !== count(WORKSPACE_DEFAULTS)) { throw new WorkspaceDamaged('Incomplete workspace domain.'); }
    foreach (WORKSPACE_DEFAULTS as $key => $default) {
        $value = $domain[$key];
        if ((is_int($default) && (!is_int($value) || $value < $default)) || (is_array($default) && !is_array($value))) {
            throw new WorkspaceDamaged('Invalid workspace domain.');
        }
    }
    foreach (['acl_rev', 'tomb_floor', 'replay_floor'] as $key) {
        if ($domain[$key] > $rev) { throw new WorkspaceDamaged('Invalid workspace cursor.'); }
    }
    if (!is_string($domain['team']['name'] ?? null)) { throw new WorkspaceDamaged('Invalid team name.'); }
    require_record_revision($domain['team'], $rev);
    $roles = array_column($stored['members'], 'role');
    if (!in_array('owner', $roles, true) || array_diff($roles, MODEL['roles'])) {
        throw new WorkspaceDamaged('Invalid workspace roles.');
    }
    $memberRevs = array_column($stored['members'], 'rv', 'id');
    if (count($members) !== count($stored['members']) || count($memberRevs) !== count($members)) {
        throw new WorkspaceDamaged('Invalid workspace members.');
    }
    foreach ($members as &$m) {
        $m['rv'] = $memberRevs[$m['id']] ?? null;
        require_record_revision($m, $rev);
    }
    unset($m);
    foreach (['projects', 'tasks'] as $kind) {
        foreach ($domain[$kind] as $key => $row) {
            if (!is_array($row) || !valid_id($row['id'] ?? null) || $row['id'] !== (string)$key) {
                throw new WorkspaceDamaged('Invalid workspace record id.');
            }
            require_record_revision($row, $rev);
        }
    }
    foreach ($domain['projects'] as $p) {
        if (!in_array($p['visibility'] ?? null, MODEL['visibilities'], true) || !is_string($p['owner'] ?? null) ||
            !is_array($p['members'] ?? null) || !is_array($p['facts'] ?? null)) {
            throw new WorkspaceDamaged('Invalid project access.');
        }
    }
    foreach ($domain['tasks'] as $t) {
        if (!valid_id($t['project'] ?? null) || !isset($domain['projects'][$t['project']]) ||
            !is_string($t['parent'] ?? null) || !is_array($t['comments'] ?? null) || !is_array($t['depends'] ?? null) ||
            !is_array($t['source'] ?? null) || !is_array($t['origin'] ?? null)) {
            throw new WorkspaceDamaged('Invalid task scope.');
        }
        $parent = $domain['tasks'][$t['parent']] ?? null;
        if ($t['parent'] !== '' && (($parent['project'] ?? null) !== $t['project'] || ($parent['parent'] ?? null) !== '')) {
            throw new WorkspaceDamaged('Invalid subtask scope.');
        }
    }
    foreach (['activity', 'events'] as $kind) {
        if (!array_is_list($domain[$kind])) { throw new WorkspaceDamaged('Invalid workspace feed.'); }
        foreach ($domain[$kind] as $row) {
            if (!is_array($row) || !is_string($row['project'] ?? null) || !is_string($row['task'] ?? null) ||
                ($row['task'] !== '' && $row['project'] === '') || ($kind === 'events' && !is_array($row['to'] ?? null))) {
                throw new WorkspaceDamaged('Invalid workspace feed scope.');
            }
        }
    }
    foreach ($domain['tombstones'] as $tomb) {
        if (!is_array($tomb) || !valid_id($tomb['id'] ?? null) || !in_array($tomb['kind'] ?? null, ['projects', 'tasks'], true)
            || ($tomb['kind'] === 'tasks' && !valid_id($tomb['project'] ?? null))) {
            throw new WorkspaceDamaged('Invalid tombstone scope.');
        }
        require_record_revision($tomb, $rev);
    }
    foreach ($domain['replays'] as $receipt) {
        if (!is_array($receipt) || !valid_id($receipt['id'] ?? null) || !valid_id($receipt['target'] ?? null) ||
            !in_array($receipt['op'] ?? null, MODEL['replayableOps'], true) || !is_string($receipt['hash'] ?? null)) {
            throw new WorkspaceDamaged('Invalid replay receipt.');
        }
        require_record_revision($receipt, $rev);
    }
    return ['v' => $stored['v'], 'members' => $members] + $domain;
}

function require_record_revision(array $record, int $rev): void {
    if (!is_int($record['rv'] ?? null) || $record['rv'] < 1 || $record['rv'] > $rev) {
        throw new WorkspaceDamaged('Invalid record revision.');
    }
}

/** The stored team is authoritative, including for direct domain callers. */
function workspace_member(array $db, string $user): array {
    return find_member($db['members'], $user) ?? throw new RequestError('TaskMind is for members of its team.', 403);
}

function role_can(string $role, string $action): bool {
    return in_array($role, MODEL['matrix'][$action] ?? [], true);
}

function project_visible(string $role, string $user, array $p): bool {
    return $role !== '' && ($role === 'owner' || $role === 'admin' || $p['visibility'] === 'team' ||
        $p['owner'] === $user || in_array($user, $p['members'], true));
}

/** Mirrors core's can() over the generated matrix. */
function can(array $db, string $user, string $action, ?array $project = null, ?string $target = null, ?string $nextRole = null): bool {
    $role = find_member($db['members'], $user)['role'] ?? '';
    if (!role_can($role, $action)) { return false; }
    if ($project !== null ? !project_visible($role, $user, $project) : in_array($action, MODEL['projectActions'], true)) { return false; }
    $targetRole = $target === null ? '' : (find_member($db['members'], $target)['role'] ?? '');
    return match ($action) {
        'project.update' => $role !== 'member' || $project['owner'] === $user,
        'member.add' => $role === 'owner' || $nextRole !== 'owner',
        'member.role' => $role === 'owner' || ($targetRole !== 'owner' && $nextRole !== 'owner'),
        'member.remove' => $role === 'owner' || $targetRole !== 'owner',
        default => true,
    };
}

function require_action(array $db, string $user, string $action, ?array $project = null, ?string $target = null, ?string $nextRole = null): void {
    if (!can($db, $user, $action, $project, $target, $nextRole)) {
        throw new RequestError('You cannot do that with your current access.', 403);
    }
}

/** A hidden id answers exactly like a missing one, including in references. */
function visible_project(array $db, string $user, string $id): array {
    $p = $db['projects'][$id] ?? null;
    if ($p === null || !can($db, $user, 'project.read', $p)) { throw new RequestError('That project is gone.'); }
    return $p;
}

function visible_task(array $db, string $user, string $id): array {
    $t = $db['tasks'][$id] ?? null;
    if ($t === null || !can($db, $user, 'project.read', $db['projects'][$t['project']])) {
        throw new RequestError('That task is gone.');
    }
    return $t;
}

/** Both the source project and the task's current project must permit a feed row. */
function workspace_feed(array $rows, array $visible, array $tasks, string $user, bool $events): array {
    $out = [];
    foreach ($rows as $row) {
        $origin = $row['project'];
        $current = $tasks[$row['task']]['project'] ?? $row['scope'] ?? $origin;
        if (($origin !== '' && !isset($visible[$origin])) || ($current !== '' && !isset($visible[$current]))) { continue; }
        if ($events && $row['to'] !== [] && !in_array($user, $row['to'], true)) { continue; }
        $row['project'] = $current;
        unset($row['scope']);
        $out[] = $row;
    }
    return array_slice($out, -LIMITS[$events ? 'stateEvents' : 'stateActivity']);
}

function workspace_live(array $db, array $member, array $visible): array {
    $can = [];
    foreach (array_keys(MODEL['matrix']) as $action) { $can[$action] = role_can($member['role'], $action); }
    return [
        'can' => $can, 'members' => $db['members'], 'team' => $db['team'],
        'activity' => workspace_feed($db['activity'], $visible, $db['tasks'], $member['id'], false),
        'events' => workspace_feed($db['events'], $visible, $db['tasks'], $member['id'], true),
    ];
}

function visible_projects(array $db, array $member): array {
    return array_filter($db['projects'], fn($p) => project_visible($member['role'], $member['id'], $p));
}

function workspace_records(array $db, string $user, array $visible, int $since): array {
    $projects = [];
    foreach ($visible as $p) {
        if ($p['rv'] <= $since) { continue; }
        $p['facts'] = (object)$p['facts'];
        $p['can'] = [
            'write' => can($db, $user, 'task.write', $p), 'comment' => can($db, $user, 'task.comment', $p),
            'settings' => can($db, $user, 'project.update', $p), 'delete' => can($db, $user, 'project.delete', $p),
        ];
        $projects[] = $p;
    }
    usort($projects, fn($a, $b) => $a['order'] <=> $b['order'] ?: strcmp($a['id'], $b['id']));
    $tasks = [];
    foreach ($db['tasks'] as $t) {
        if ($t['rv'] <= $since || !isset($visible[$t['project']])) { continue; }
        $t['source'] = (object)$t['source'];
        $t['origin'] = (object)$t['origin'];
        $t['depends'] = array_values(array_filter($t['depends'], fn($id) => isset($visible[$db['tasks'][$id]['project'] ?? ''])));
        $tasks[] = $t;
    }
    return ['projects' => $projects, 'tasks' => $tasks];
}

function workspace_state(array $db, string $user): array {
    $member = workspace_member($db, $user);
    $visible = visible_projects($db, $member);
    return ['rev' => $db['rev'], 'me' => $user] + workspace_records($db, $user, $visible, 0) + workspace_live($db, $member, $visible);
}

function workspace_delta(array $db, string $user, int $since): array {
    $member = workspace_member($db, $user);
    $rev = $db['rev'];
    $result = ['me' => $user, 'since' => $since, 'rev' => $rev, 'changed' => $since !== $rev];
    if ($since === $rev) { return $result; }
    if ($since < max(1, $db['acl_rev'], $db['tomb_floor']) || $since > $rev) {
        return $result + ['full' => true, 'state' => workspace_state($db, $user)];
    }
    $visible = visible_projects($db, $member);
    $deleted = ['projects' => [], 'tasks' => []];
    foreach ($db['tombstones'] as $tomb) {
        if ($tomb['rv'] <= $since) { continue; }
        if ($tomb['kind'] === 'projects' || isset($visible[$tomb['project']])) {
            $deleted[$tomb['kind']][] = $tomb['id'];
        }
    }
    return $result + ['full' => false, 'deleted' => $deleted] + workspace_records($db, $user, $visible, $since)
        + workspace_live($db, $member, $visible);
}

/** A private deletion, access change or task move can remove ids the server must not repeat. Force a filtered replacement. */
function stamp_workspace(array &$db, array $before, int $now): void {
    if ($db === $before) { return; }
    $rev = ++$db['rev'];
    $beforeMembers = array_column($before['members'], null, 'id');
    $aclChanged = array_column($before['members'], 'role', 'id') !== array_column($db['members'], 'role', 'id');
    foreach ($db['members'] as &$member) {
        if ($member !== ($beforeMembers[$member['id']] ?? null)) { $member['rv'] = $rev; }
    }
    unset($member);
    if ($db['team'] !== $before['team']) { $db['team']['rv'] = $rev; }
    foreach ($db['projects'] as $id => &$p) {
        $old = $before['projects'][$id] ?? null;
        if ($p !== $old) {
            $p['rv'] = $rev;
            // An added project has no old clients to evict. A change to an existing project's audience does.
            foreach (['visibility', 'owner', 'members'] as $key) {
                if ($old !== null && $p[$key] !== $old[$key]) { $aclChanged = true; }
            }
        }
    }
    unset($p);
    foreach ($db['tasks'] as $id => &$t) {
        $old = $before['tasks'][$id] ?? null;
        if ($t !== $old) {
            $t['rv'] = $rev;
            $t['updated'] = $now;
            if ($old !== null && $t['project'] !== $old['project']) { $aclChanged = true; }
        }
    }
    unset($t);
    foreach (array_diff_key($before['projects'], $db['projects']) as $p) {
        if ($p['visibility'] === 'private') { $aclChanged = true; }
        else { $db['tombstones'][] = ['kind' => 'projects', 'id' => $p['id'], 'rv' => $rev]; }
    }
    foreach (array_diff_key($before['tasks'], $db['tasks']) as $t) {
        if (isset($db['projects'][$t['project']])) {
            $db['tombstones'][] = ['kind' => 'tasks', 'id' => $t['id'], 'project' => $t['project'], 'rv' => $rev];
        }
    }
    if ($aclChanged) { $db['acl_rev'] = $rev; }
    if (count($db['tombstones']) > LIMITS['tombsMax']) {
        $dropped = array_splice($db['tombstones'], 0, count($db['tombstones']) - LIMITS['tombsMax']);
        $db['tomb_floor'] = end($dropped)['rv'];
    }
}
