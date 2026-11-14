<?php
declare(strict_types=1);
namespace TaskMind;
require_once __DIR__ . '/taskmind.php';

const PROJECT_FIELDS = ['name', 'color', 'repo', 'private', 'blurb', 'about', 'health', 'archived', 'visibility', 'members', 'lead', 'goal', 'start', 'due'];
const TASK_FIELDS = ['title', 'notes', 'status', 'assignee', 'priority', 'kind', 'due', 'labels', 'start', 'section'];

/** The workspace query accepts a decimal revision only. */
function query_revision(mixed $value): int {
    if (!is_string($value) || preg_match('/^(?:0|[1-9][0-9]*)$/D', $value) !== 1 ||
        filter_var($value, FILTER_VALIDATE_INT) === false) {
        throw new RequestError('Invalid revision.');
    }
    return (int)$value;
}

/** Bound both the advertised size and the actual read. The wire format preserves objects and lists. */
function read_mutation_body(string $contentType, string $length): array {
    $max = LIMITS['requestBytesMax'];
    if ((int)$length > $max) { throw new RequestError('The request is too large.', 413, 'payload_too_large', 'requestBytesMax'); }
    if (strtolower(trim(explode(';', $contentType, 2)[0])) !== 'application/json') {
        throw new RequestError('Send an application/json request.', 415);
    }
    $body = file_get_contents('php://input', false, null, 0, $max + 1);
    if ($body === false) { throw new RequestError('Cannot read the request.'); }
    if (strlen($body) > $max) { throw new RequestError('The request is too large.', 413, 'payload_too_large', 'requestBytesMax'); }
    try {
        $input = json_decode($body, false, 16, JSON_THROW_ON_ERROR);
    } catch (\JsonException) {
        throw new RequestError('Invalid JSON.');
    }
    if (!($input instanceof \stdClass) || !(($input->data ?? null) instanceof \stdClass)) { throw new RequestError('Expected a request object.'); }
    if (isset($input->data->fields) && !($input->data->fields instanceof \stdClass)) { throw new RequestError('Expected a fields object.'); }
    return (array)$input;
}

/** Load, re-authorize, apply and publish under one encrypted workspace lock. */
function change_workspace(Store $store, array $config, array|\Closure $accounts, string $user, array $request, ?int $now = null): array {
    $owners = seed_owners($config);
    $now ??= time();
    $applying = false;
    $id = '';
    try {
        $db = $store->transaction('workspace', function (array $stored, bool $exists) use ($owners, $user, $accounts, $request, $now, &$id, &$applying): array {
            // The request gate has already initialized a fresh store. A missing file here was lost.
            if (!$exists) { throw new WorkspaceLost('Workspace lost before the write.'); }
            $db = read_workspace($stored, $owners);
            workspace_member($db, $user);
            $applying = true;
            $before = $db;
            $id = apply_workspace_op($db, $accounts, $user, $request, $now);
            stamp_workspace($db, $before, $now);
            return $db === $before ? $stored : $db;
        });
    } catch (RequestError $e) {
        throw $e;
    } catch (\Throwable $e) {
        if (!$applying) { throw workspace_read_error($e, $owners, $user); }
        throw $e;
    }
    $db = read_workspace($db, $owners);
    if (find_member($db['members'], $user) === null) { return ['ok' => true, 'id' => $id, 'closed' => true]; }
    return ['ok' => true, 'id' => $id] + workspace_reply($db, $user, $request['since'] ?? null);
}

function workspace_reply(array $db, string $user, ?int $since): array {
    return ['ok' => true] + ($since === null
        ? ['state' => workspace_state($db, $user)]
        : ['delta' => workspace_delta($db, $user, $since)]);
}

/** Reject unexpected input fields, including client attempts to write source and audit fields. */
function only_fields(array $data, array $fields): void {
    if (array_diff(array_keys($data), $fields)) { throw new RequestError('Unknown request field.'); }
}

function input_object(mixed $value): array {
    if ($value instanceof \stdClass) { return (array)$value; }
    if (!is_array($value) || ($value !== [] && array_is_list($value))) { throw new RequestError('Expected an object.'); }
    return $value;
}

function input_string(mixed $value): string {
    if (!is_string($value)) { throw new RequestError('Expected text.'); }
    return $value;
}

function input_id(mixed $id, bool $optional = false): string {
    if (($optional && $id === '') || valid_id($id)) { return $id; }
    throw new RequestError('Invalid id.');
}

function input_enum(mixed $value, array $values): string {
    if (!in_array($value, $values, true)) { throw new RequestError('Invalid choice.'); }
    return $value;
}

function input_bool(mixed $value): bool {
    if (!is_bool($value)) { throw new RequestError('Expected true or false.'); }
    return $value;
}

function input_text(mixed $value, string $cap, bool $multiline = false): string {
    $text = input_string($value);
    if (!$multiline) { return clean_text($text, LIMITS[$cap]); }
    // Keep LF, drop other control characters and the bidirectional embedding and isolate controls.
    $text = str_replace(["\r\n", "\r"], "\n", $text);
    $text = (string)preg_replace('/[^\S\n]+/u', ' ', $text);
    $text = (string)preg_replace('/[\x{0000}-\x{0009}\x{000B}-\x{001F}\x{007F}-\x{009F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $text);
    return clean_text($text, 1) === '' ? '' : mb_substr(trim($text), 0, LIMITS[$cap]);
}

function input_date(mixed $value): string {
    if ($value === '') { return ''; }
    if (!is_string($value) || preg_match('/^(\d{4})-(\d{2})-(\d{2})$/D', $value, $m) !== 1 ||
        !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
        throw new RequestError('That is not a calendar date.');
    }
    return $value;
}

function input_list(mixed $value, string $cap): array {
    if (!is_array($value) || !array_is_list($value)) { throw new RequestError('Expected a list.'); }
    if (count($value) > LIMITS[$cap]) { throw new RequestError('Too many items.', 400, 'invalid', $cap); }
    return $value;
}

function input_revision(mixed $value, int $min = 0): int {
    if (!is_int($value) || $value < $min) { throw new RequestError('Invalid revision.'); }
    return $value;
}

function require_current(array $record, array $data): void {
    if (input_revision($data['rv'] ?? null, 1) !== $record['rv']) {
        throw new RequestError('This record has changed. Refresh before saving.', 409);
    }
}

function require_confirm(array $data): void {
    if (($data['confirm'] ?? null) !== true) { throw new RequestError('Confirm deletion to continue.'); }
}

function require_capacity(array $rows, string $cap): void {
    if (count($rows) >= LIMITS[$cap]) { throw new RequestError('The workspace is full.', 409, 'store_full', $cap); }
}

/** Canonical order for object keys in a replay fingerprint, preserving the order of lists. */
function canonical_request(array $data): array {
    if (!array_is_list($data)) { ksort($data, SORT_STRING); }
    foreach ($data as &$value) {
        if (is_array($value)) { $value = canonical_request($value); }
        elseif ($value instanceof \stdClass) { $value = (object)canonical_request((array)$value); }
    }
    unset($value);
    return $data;
}

function replay_result(array $db, string $user, array $receipt): string {
    $id = $receipt['id'];
    switch ($receipt['op']) {
        case 'project.add':
            visible_project($db, $user, $id);
            require_action($db, $user, 'project.create');
            break;
        case 'task.add':
        case 'task.comment':
            $task = visible_task($db, $user, $receipt['target']);
            require_action($db, $user, $receipt['op'] === 'task.add' ? 'task.write' : 'task.comment', $db['projects'][$task['project']]);
            break;
        case 'member.add':
            require_action($db, $user, 'member.add', null, $id, $receipt['role']);
            workspace_member($db, $id);
            break;
    }
    return $id;
}

/** Apply one supported operation. Any refusal discards the candidate in the caller's transaction. */
function apply_workspace_op(array &$db, array|\Closure $accounts, string $user, array $request, int $now): string {
    workspace_member($db, $user);
    $op = input_string($request['op'] ?? null);
    $data = input_object($request['data'] ?? null);
    $replayable = in_array($op, MODEL['replayableOps'], true);
    only_fields($request, $replayable ? ['op', 'data', 'since', 'requestId', 'base'] : ['op', 'data', 'since']);
    if (array_key_exists('since', $request)) { input_revision($request['since']); }
    if ($replayable) {
        $token = input_id($request['requestId'] ?? null);
        $base = input_revision($request['base'] ?? null, 1);
        $key = $user . ':' . $token;
        $hash = hash('sha256', json_encode([$op, $base, canonical_request($data)], JSON_THROW_ON_ERROR));
        if (isset($db['replays'][$key])) {
            $receipt = $db['replays'][$key];
            $id = replay_result($db, $user, $receipt);
            if ($receipt['hash'] !== $hash) { throw new RequestError('That request id was already used.', 409); }
            return $id;
        }
        if ($base < $db['replay_floor'] || $base > $db['rev']) {
            throw new RequestError('This add is too old or from a different workspace revision. Refresh to reconcile it.', 409);
        }
    }
    $id = match ($op) {
        'project.add', 'project.update', 'project.delete' => change_project($db, $user, $op, $data, $now),
        'task.add', 'task.update', 'task.move', 'task.delete', 'task.comment' => change_task($db, $user, $op, $data, $now),
        'member.add', 'member.role', 'member.remove', 'team.update' => change_team($db, $accounts, $user, $op, $data, $now),
        default => throw new RequestError('Unknown operation.'),
    };
    if ($replayable) {
        $db['replays'][$key] = ['op' => $op, 'hash' => $hash, 'id' => $id, 'rv' => $db['rev'] + 1,
            'target' => $op === 'task.comment' ? $data['id'] : $id, 'role' => $op === 'member.add' ? ($data['role'] ?? 'member') : ''];
        if (count($db['replays']) > LIMITS['replaysMax']) {
            $db['replay_floor'] = array_shift($db['replays'])['rv'];
        }
    }
    return $id;
}

function member_name(array $db, string $user): string {
    return (find_member($db['members'], $user)['name'] ?? '') ?: $user;
}

function record_activity(array &$db, string $user, int $now, string $text, string $project = '', string $task = ''): void {
    $db['activity'][] = ['at' => $now, 'by' => $user, 'text' => clean_text($text, LIMITS['activityTextChars']), 'task' => $task, 'project' => $project];
    $db['activity'] = array_slice($db['activity'], -LIMITS['activityMax']);
}

function record_event(array &$db, string $user, int $now, string $type, array $to, string $text, string $project = '', string $task = ''): void {
    if (!$to) { return; }
    $db['events'][] = ['n' => ++$db['event_seq'], 'at' => $now, 'type' => $type, 'by' => $user, 'to' => $to,
        'task' => $task, 'project' => $project, 'text' => clean_text($text, LIMITS['activityTextChars'])];
    $db['events'] = array_slice($db['events'], -LIMITS['eventsMax']);
}

function next_order(array $records): float {
    return $records === [] ? 1.0 : max(array_column($records, 'order')) + 1.0;
}

/** Discard assignments and follows the current audience can no longer use. */
function enforce_project_access(array &$db, ?string $projectId = null): void {
    $roles = array_column($db['members'], 'role', 'id');
    foreach ($db['tasks'] as &$t) {
        if ($projectId !== null && $t['project'] !== $projectId) { continue; }
        $p = $db['projects'][$t['project']];
        $sees = fn(string $user): bool => project_visible($roles[$user] ?? '', $user, $p);
        if ($t['assignee'] !== '' && !$sees($t['assignee'])) { $t['assignee'] = ''; }
        $t['followers'] = array_values(array_filter($t['followers'], $sees));
    }
    unset($t);
}

function project_fields(array $db, array $p, array $data): array {
    foreach (['name' => 'projectNameChars', 'repo' => 'repoChars', 'blurb' => 'blurbChars', 'about' => 'aboutChars', 'goal' => 'goalChars'] as $key => $cap) {
        if (array_key_exists($key, $data)) { $p[$key] = input_text($data[$key], $cap, $key === 'about'); }
    }
    if ($p['name'] === '') { throw new RequestError('A project needs a name.'); }
    foreach (['visibility' => 'visibilities', 'health' => 'health'] as $key => $choices) {
        if (array_key_exists($key, $data)) { $p[$key] = input_enum($data[$key], MODEL[$choices]); }
    }
    foreach (['private', 'archived'] as $key) {
        if (array_key_exists($key, $data)) { $p[$key] = input_bool($data[$key]); }
    }
    foreach (['start', 'due'] as $key) {
        if (array_key_exists($key, $data)) { $p[$key] = input_date($data[$key]); }
    }
    if ((isset($data['start']) || isset($data['due'])) && $p['start'] !== '' && $p['due'] !== '' && $p['start'] > $p['due']) {
        throw new RequestError('The start cannot be after the due date.');
    }
    if (array_key_exists('color', $data)) {
        $color = input_string($data['color']);
        if (preg_match('/^#[0-9a-f]{6}$/iD', $color) !== 1) { throw new RequestError('Invalid project color.'); }
        $p['color'] = strtolower($color);
    }
    if (array_key_exists('members', $data)) {
        $ids = input_list($data['members'], 'membersMax');
        foreach ($ids as $id) {
            if (!find_member($db['members'], input_id($id))) { throw new RequestError('Project members must be on the team.'); }
        }
        $p['members'] = array_values(array_unique($ids));
        sort($p['members'], SORT_STRING);
    }
    if (array_key_exists('lead', $data)) {
        $lead = input_id($data['lead'], true);
        if ($lead !== '' && !find_member($db['members'], $lead)) { throw new RequestError('The lead must be on the team.'); }
        $p['lead'] = $lead;
    }
    if ($p['visibility'] === 'private' && $p['lead'] !== '' && !in_array($p['lead'], $p['members'], true)) {
        $p['members'][] = $p['lead'];
        sort($p['members'], SORT_STRING);
    }
    return $p;
}

function require_project_name(array $db, string $user, array $project): void {
    foreach ($db['projects'] as $p) {
        if ($p['id'] !== $project['id'] && can($db, $user, 'project.read', $p) &&
            mb_strtolower($p['name']) === mb_strtolower($project['name'])) {
            throw new RequestError('There is already a project with that name.');
        }
    }
}

function change_project(array &$db, string $user, string $op, array $data, int $now): string {
    $who = member_name($db, $user);
    if ($op === 'project.add') {
        require_action($db, $user, 'project.create');
        only_fields($data, PROJECT_FIELDS);
        require_capacity($db['projects'], 'projectsMax');
        $id = bin2hex(random_bytes(16));
        $p = project_fields($db, [
            'id' => $id, 'name' => '', 'color' => '#7d8590', 'repo' => '', 'private' => false, 'blurb' => '', 'about' => '',
            'health' => 'on_track', 'owner' => $user, 'archived' => false, 'order' => next_order($db['projects']), 'created' => $now,
            'facts' => [], 'visibility' => 'team', 'members' => [], 'lead' => '', 'goal' => '', 'start' => '', 'due' => '',
            'sections' => [], 'updates' => [],
        ], $data);
        require_project_name($db, $user, $p);
        $db['projects'][$id] = $p;
        record_activity($db, $user, $now, "$who started the project {$p['name']}", $id);
        return $id;
    }
    $id = input_id($data['id'] ?? null);
    $p = visible_project($db, $user, $id);
    require_action($db, $user, $op, $p);
    require_current($p, $data);
    if ($op === 'project.delete') {
        only_fields($data, ['id', 'rv', 'confirm']);
        require_confirm($data);
        $gone = array_column(array_filter($db['tasks'], fn($t) => $t['project'] === $id), 'id');
        delete_tasks($db, $gone);
        unset($db['projects'][$id]);
        foreach (['activity', 'events'] as $feed) {
            $db[$feed] = array_values(array_filter($db[$feed], fn($r) => $r['project'] !== $id && ($r['scope'] ?? '') !== $id));
        }
        if ($p['visibility'] === 'team') { record_activity($db, $user, $now, "$who deleted the project {$p['name']}"); }
        return $id;
    }
    only_fields($data, [...PROJECT_FIELDS, 'id', 'rv', 'owner']);
    $after = project_fields($db, $p, $data);
    if (array_key_exists('owner', $data) && $data['owner'] !== $p['owner']) {
        require_action($db, $user, 'ownership.transfer', $p);
        $owner = input_id($data['owner']);
        if (!find_member($db['members'], $owner)) { throw new RequestError('The project owner must be on the team.'); }
        $after['owner'] = $owner;
    }
    if ($after['name'] !== $p['name']) { require_project_name($db, $user, $after); }
    if ($after !== $p) {
        $db['projects'][$id] = $after;
        enforce_project_access($db, $id);
        record_activity($db, $user, $now, "$who updated the project {$after['name']}", $id);
    }
    return $id;
}

function require_assignee(array $db, string $id, array $project): void {
    if ($id !== '' && !can($db, $id, 'project.read', $project)) {
        throw new RequestError('The assignee must be a team member who can see the project.');
    }
}

function task_fields(array $task, array $project, array $fields, int $now): array {
    $before = $task;
    foreach (['title' => 'titleChars', 'notes' => 'notesChars'] as $key => $cap) {
        if (array_key_exists($key, $fields)) { $task[$key] = input_text($fields[$key], $cap, $key === 'notes'); }
    }
    if ($task['title'] === '') { throw new RequestError('A task needs a title.'); }
    foreach (['status' => MODEL['statuses'], 'priority' => MODEL['priorities'], 'kind' => ['task', 'bug']] as $key => $choices) {
        if (array_key_exists($key, $fields)) { $task[$key] = input_enum($fields[$key], $choices); }
    }
    if (array_key_exists('assignee', $fields)) { $task['assignee'] = input_id($fields['assignee'], true); }
    foreach (['due', 'start'] as $key) {
        if (array_key_exists($key, $fields)) { $task[$key] = input_date($fields[$key]); }
    }
    if ((isset($fields['start']) || isset($fields['due'])) && $task['start'] !== '' && $task['due'] !== '' && $task['start'] > $task['due']) {
        throw new RequestError('The start cannot be after the due date.');
    }
    if (array_key_exists('labels', $fields)) {
        $labels = array_map(fn($label) => input_text($label, 'labelChars'), input_list($fields['labels'], 'labelsPerTask'));
        $task['labels'] = array_values(array_unique(array_filter($labels, fn($label) => $label !== '')));
    }
    if (array_key_exists('section', $fields)) {
        $section = input_id($fields['section'], true);
        if ($section !== '' && ($task['parent'] !== '' || !in_array($section, array_column($project['sections'], 'id'), true))) {
            throw new RequestError('That section is gone.');
        }
        $task['section'] = $section;
    }
    if ($task['status'] !== $before['status']) { $task['done_at'] = $task['status'] === 'done' ? $now : 0; }
    if ($task['source']) {
        foreach (['title', 'status', 'kind', 'priority', 'notes', 'project'] as $key) {
            if ($task[$key] !== $before[$key]) { throw new RequestError('That field belongs to the synced source.'); }
        }
    }
    return $task;
}

/** Keep the source scope on deleted tasks even after a move. Clear references to the removed ids. */
function delete_tasks(array &$db, array $ids): void {
    $gone = array_fill_keys($ids, true);
    foreach (['activity', 'events'] as $kind) {
        foreach ($db[$kind] as &$row) {
            if (isset($gone[$row['task']])) { $row['scope'] = $db['tasks'][$row['task']]['project']; }
        }
        unset($row);
    }
    $db['tasks'] = array_diff_key($db['tasks'], $gone);
    foreach ($db['tasks'] as &$t) {
        $t['depends'] = array_values(array_filter($t['depends'], fn($id) => !isset($gone[$id])));
    }
    unset($t);
}

function note_assignment(array &$db, array $task, string $previous, string $user, int $now): void {
    $assignee = $task['assignee'];
    if ($assignee !== '' && $assignee !== $previous && $assignee !== $user) {
        $who = member_name($db, $user);
        record_event($db, $user, $now, 'task.assigned', [$assignee], "$who assigned you “{$task['title']}”", $task['project'], $task['id']);
    }
}

function add_task(array &$db, string $user, array $data, int $now): string {
    only_fields($data, [...TASK_FIELDS, 'project', 'parent']);
    $parent = array_key_exists('parent', $data) ? input_id($data['parent'], true) : '';
    $projectId = array_key_exists('project', $data) ? input_id($data['project']) : '';
    if ($parent !== '') {
        $p = visible_task($db, $user, $parent);
        if ($p['parent'] !== '' || ($projectId !== '' && $projectId !== $p['project'])) {
            throw new RequestError('A subtask belongs to a top-level task in the same project.');
        }
        $projectId = $p['project'];
    }
    $project = visible_project($db, $user, $projectId);
    require_action($db, $user, 'task.write', $project);
    require_capacity($db['tasks'], 'tasksMax');
    $id = bin2hex(random_bytes(16));
    $task = task_fields([
        'id' => $id, 'n' => ++$db['seq'], 'project' => $projectId, 'parent' => $parent, 'title' => '', 'notes' => '', 'status' => 'todo',
        'assignee' => '', 'priority' => 'normal', 'kind' => 'task', 'due' => '', 'labels' => [], 'order' => next_order($db['tasks']),
        'by' => $user, 'created' => $now, 'updated' => $now, 'done_at' => 0, 'source' => [], 'comments' => [],
        'start' => '', 'depends' => [], 'estimate' => 0, 'section' => '', 'repeat' => null, 'followers' => [], 'origin' => [],
    ], $project, $data, $now);
    require_assignee($db, $task['assignee'], $project);
    $db['tasks'][$id] = $task;
    $who = member_name($db, $user);
    record_activity($db, $user, $now, "$who added “{$task['title']}”", $projectId, $id);
    note_assignment($db, $task, '', $user, $now);
    return $id;
}

function add_comment(array &$db, array $task, array $project, string $user, array $data, int $now): string {
    only_fields($data, ['id', 'text']);
    $text = input_text($data['text'] ?? null, 'commentChars', true);
    if ($text === '') { throw new RequestError('Write something first.'); }
    $id = bin2hex(random_bytes(16));
    $task['comments'][] = ['id' => $id, 'by' => $user, 'at' => $now, 'text' => $text];
    $task['comments'] = array_slice($task['comments'], -LIMITS['commentsPerTask']);
    $db['tasks'][$task['id']] = $task;
    $who = member_name($db, $user);
    $line = "$who commented on “{$task['title']}”";
    record_activity($db, $user, $now, $line, $task['project'], $task['id']);
    $to = array_values(array_filter(array_unique([$task['assignee'], $task['by'], ...$task['followers']]),
        fn($id) => $id !== $user && can($db, $id, 'project.read', $project)));
    record_event($db, $user, $now, 'comment.added', $to, "$line: " . mb_substr($text, 0, 120), $task['project'], $task['id']);
    return $id;
}

/** One shared order underlies list, status and section columns. Renumber only if a gap cannot represent the drop. */
function place_task(array &$db, array $task, array $after, string $before, bool $sectionColumn): array {
    $siblings = array_filter($db['tasks'], fn($t) => $t['project'] === $task['project'] && $t['parent'] === $task['parent']);
    uasort($siblings, fn($a, $b) => $a['order'] <=> $b['order'] ?: strcmp($a['id'], $b['id']));
    $inColumn = fn($t) => $sectionColumn ? $t['section'] === $after['section'] : ($task['parent'] !== '' || $t['status'] === $after['status']);
    $column = array_keys(array_filter($siblings, $inColumn));
    if ($before === $task['id']) { return $after; }
    if ($before !== '' && !in_array($before, $column, true)) { throw new RequestError('That task is gone from this column.'); }
    $at = array_search($task['id'], $column, true);
    if ($after === $task && $at !== false && ($column[$at + 1] ?? '') === $before) { return $task; }
    if ($before === '') { $after['order'] = next_order($db['tasks']); return $after; }
    unset($siblings[$task['id']]);
    $ids = array_keys($siblings);
    $i = array_search($before, $ids, true);
    $next = $siblings[$before]['order'];
    $prev = $i === 0 ? $next - 2 : $siblings[$ids[$i - 1]]['order'];
    $mid = $prev + ($next - $prev) / 2;
    if ($mid > $prev && $mid < $next) { $after['order'] = $mid; return $after; }
    foreach ($ids as $i => $id) {
        $db['tasks'][$id]['order'] = 2 * ($i + 1);
        if ($id === $before) { $after['order'] = 2 * $i + 1; }
    }
    return $after;
}

function change_task(array &$db, string $user, string $op, array $data, int $now): string {
    if ($op === 'task.add') { return add_task($db, $user, $data, $now); }
    $id = input_id($data['id'] ?? null);
    $task = visible_task($db, $user, $id);
    $project = $db['projects'][$task['project']];
    require_action($db, $user, $op === 'task.comment' ? 'task.comment' : 'task.write', $project);
    if ($op === 'task.comment') { return add_comment($db, $task, $project, $user, $data, $now); }
    require_current($task, $data);
    $who = member_name($db, $user);
    if ($op === 'task.delete') {
        only_fields($data, ['id', 'rv', 'confirm']);
        require_confirm($data);
        if ($task['source']) { throw new RequestError('Remove this task at its synced source.'); }
        $kids = array_filter($db['tasks'], fn($t) => $t['parent'] === $id);
        if (array_filter($kids, fn($t) => (bool)$t['source'])) { throw new RequestError('A subtask belongs to a synced source.'); }
        delete_tasks($db, [$id, ...array_column($kids, 'id')]);
        record_activity($db, $user, $now, "$who deleted “{$task['title']}”", $task['project']);
        return $id;
    }
    if ($op === 'task.move') {
        only_fields($data, ['id', 'rv', 'status', 'section', 'before']);
        $after = task_fields($task, $project, array_intersect_key($data, ['status' => true, 'section' => true]), $now);
        $before = array_key_exists('before', $data) ? input_id($data['before'], true) : '';
        if ($before !== '') { visible_task($db, $user, $before); }
        $after = place_task($db, $task, $after, $before, array_key_exists('section', $data));
    } else {
        only_fields($data, ['id', 'rv', 'fields']);
        $fields = input_object($data['fields'] ?? null);
        only_fields($fields, [...TASK_FIELDS, 'project']);
        $to = array_key_exists('project', $fields) ? input_id($fields['project']) : $task['project'];
        $after = $task;
        if ($to !== $task['project']) {
            $project = visible_project($db, $user, $to);
            require_action($db, $user, 'task.write', $project);
            if ($task['parent'] !== '') { throw new RequestError('Move the parent task to move its subtasks.'); }
            if ($task['source']) { throw new RequestError('The project belongs to the synced source.'); }
            $after['project'] = $to;
            $after['section'] = '';
        }
        $after = task_fields($after, $project, $fields, $now);
        require_assignee($db, $after['assignee'], $project);
        if ($to !== $task['project']) {
            foreach ($db['tasks'] as &$kid) {
                if ($kid['parent'] !== $id) { continue; }
                if ($kid['source']) { throw new RequestError('A subtask belongs to a synced source.'); }
                require_assignee($db, $kid['assignee'], $project);
                $kid['project'] = $to;
                $kid['section'] = '';
            }
            unset($kid);
        }
    }
    if ($after !== $task) {
        $db['tasks'][$id] = $after;
        if ($after['project'] !== $task['project']) { enforce_project_access($db, $after['project']); }
        $verb = $op === 'task.move' || $after['project'] !== $task['project'] ? 'moved' : ($after['status'] === 'done' && $task['status'] !== 'done' ? 'completed' : 'updated');
        record_activity($db, $user, $now, "$who $verb “{$after['title']}”", $after['project'], $id);
        note_assignment($db, $after, $task['assignee'], $user, $now);
    }
    return $id;
}

function change_team(array &$db, array|\Closure $accounts, string $user, string $op, array $data, int $now): string {
    $who = member_name($db, $user);
    if ($op === 'team.update') {
        require_action($db, $user, $op);
        only_fields($data, ['name', 'rv']);
        require_current($db['team'], $data);
        $name = input_text($data['name'] ?? null, 'teamNameChars');
        if ($name === '') { throw new RequestError('The team needs a name.'); }
        if ($name !== $db['team']['name']) {
            $db['team']['name'] = $name;
            record_activity($db, $user, $now, "$who renamed the team $name");
        }
        return 'team';
    }
    $id = input_id($data['id'] ?? null);
    $role = match ($op) {
        'member.add' => array_key_exists('role', $data) ? input_enum($data['role'], MODEL['roles']) : 'member',
        'member.role' => input_enum($data['role'] ?? null, MODEL['roles']),
        default => null,
    };
    require_action($db, $user, $op, null, $id, $role);
    $at = array_search($id, array_column($db['members'], 'id'), true);
    if ($op === 'member.add') {
        only_fields($data, ['id', 'role', 'name']);
        // A closure is the shared sign-in's store, read only now (it throws a 503 refusal when it cannot answer).
        if (!isset(($accounts instanceof \Closure ? $accounts() : $accounts)[$id])) { throw new RequestError('Choose an existing site account.'); }
        if ($at !== false) { throw new RequestError('That person is already on the team.'); }
        require_capacity($db['members'], 'membersMax');
        $name = array_key_exists('name', $data) ? input_text($data['name'], 'memberNameChars') : '';
        $db['members'][] = ['id' => $id, 'role' => $role, 'name' => $name, 'added' => $now, 'by' => $user];
        $name = member_name($db, $id);
        record_activity($db, $user, $now, "$who added $name to the team");
        record_event($db, $user, $now, 'member.added', [$id], "$who added you to the team");
        return $id;
    }
    if ($at === false) { throw new RequestError('That person is not on the team.'); }
    $member = $db['members'][$at];
    require_current($member, $data);
    only_fields($data, ['id', 'rv', $op === 'member.role' ? 'role' : 'confirm']);
    if ($role === $member['role']) { return $id; }
    if ($member['role'] === 'owner' && count(array_keys(array_column($db['members'], 'role'), 'owner', true)) === 1) {
        throw new RequestError('The team must keep an owner.');
    }
    if ($op === 'member.role') {
        $db['members'][$at]['role'] = $role;
        record_activity($db, $user, $now, "$who made " . member_name($db, $id) . " $role");
        record_event($db, $user, $now, 'member.role', [$id], "$who made you $role");
    } else {
        require_confirm($data);
        record_activity($db, $user, $now, "$who removed " . member_name($db, $id) . ' from the team');
        array_splice($db['members'], $at, 1);
        foreach ($db['projects'] as &$p) {
            foreach (['owner', 'lead'] as $key) { if ($p[$key] === $id) { $p[$key] = ''; } }
            $p['members'] = array_values(array_diff($p['members'], [$id]));
        }
        unset($p);
        $events = [];
        foreach ($db['events'] as $e) {
            if ($e['to'] !== []) {
                $e['to'] = array_values(array_diff($e['to'], [$id]));
                if ($e['to'] === []) { continue; }
            }
            $events[] = $e;
        }
        $db['events'] = $events;
    }
    enforce_project_access($db);
    return $id;
}
