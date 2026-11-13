<?php
declare(strict_types=1);
require_once __DIR__ . '/../../lib/operations.php';

use TaskMind\{RequestError, Store};
use function TaskMind\{change_workspace, team_workspace, workspace_state, workspace_delta};

[$store, $dir] = harness_store();
$accounts = array_fill_keys(['alex', 'sam', 'val', 'max', 'otto'], 'fixture');
$raw = harness_workspace(harness_member('alex', 'owner'), harness_member('sam', 'admin'),
    harness_member('max', 'member'), harness_member('val', 'viewer'));
$store->transaction('workspace', fn() => $raw);
$seedConfig = ['taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam'];
$read = fn(string $user = 'alex') => workspace_state(team_workspace($store, $seedConfig, $user), $user);
$delta = fn(string $user, int $since) => workspace_delta(team_workspace($store, $seedConfig, $user), $user, $since);
$change = fn(string $user, array $request) => change_workspace($store, $seedConfig, $accounts, $user, $request, 1700000000);
$seq = 0;
$addRequest = fn(string $op, array $data, string $key, int $base = 1) => ['op' => $op, 'data' => $data, 'requestId' => $key, 'base' => $base];
$add = function (string $user, string $op, array $data) use ($addRequest, $change, &$seq): string {
    return $change($user, $addRequest($op, $data, 'add-' . ++$seq))['id'];
};
$edit = fn(string $user, string $op, array $data, ?int $since = null) =>
    $change($user, ['op' => $op, 'data' => $data] + ($since === null ? [] : ['since' => $since]));
$record = function (string $kind, string $id) use ($read): array {
    $records = array_column($read()[$kind], null, 'id');
    return $records[$id] ?? throw new RuntimeException("Missing fixture $kind/$id");
};
$encoded = fn($x) => json_encode($x, JSON_THROW_ON_ERROR);

$initialBytes = file_get_contents($dir . '/workspace.enc');
check($read()['rev'] === 1 && $read()['tasks'] === [] && $read()['team'] === ['name' => 'Team', 'rv' => 1], 'team-only storage opens as the initial domain');
check(file_get_contents($dir . '/workspace.enc') === $initialBytes, 'reads never rewrite the scaffold storage');
refuses(fn() => $read('otto'), 403);
refuses(fn() => $add('val', 'project.add', ['name' => 'Rejected']), 403);
refuses(fn() => $add('sam', 'member.add', ['id' => 'otto', 'role' => 'owner']), 403);
refuses(fn() => $add('sam', 'member.add', ['id' => 'ghost']), 400);
refuses(fn() => $edit('sam', 'member.role', ['id' => 'alex', 'role' => 'member', 'rv' => 1]), 403);
refuses(fn() => $edit('alex', 'member.remove', ['id' => 'alex', 'rv' => 1, 'confirm' => true]), 400);

$request = $addRequest('project.add', ['name' => 'Public work', 'color' => '#AABBCC'], 'original-project');
$public = $change('max', $request)['id'];
$rev = $read()['rev'];
$reordered = $addRequest('project.add', ['color' => '#AABBCC', 'name' => 'Public work'], 'original-project');
check($change('max', $reordered + ['since' => $rev])['delta'] === ['me' => 'max', 'since' => $rev, 'rev' => $rev, 'changed' => false],
    'replayed add is the same id and changes no state regardless of JSON field order');
refuses(fn() => $change('max', $addRequest('project.add', ['name' => 'Different'], 'original-project')), 409, 'stale');
check($record('projects', $public)['color'] === '#aabbcc', 'add cleans project settings');
$private = $add('alex', 'project.add', ['name' => 'SECRET project', 'visibility' => 'private', 'members' => ['max']]);
$hiddenTask = $add('alex', 'task.add', ['project' => $private, 'title' => 'SECRET task', 'assignee' => 'max']);
$privateComment = $add('max', 'task.comment', ['id' => $hiddenTask, 'text' => 'SECRET comment']);
foreach ([$private, $hiddenTask, $privateComment, 'SECRET'] as $secret) {
    check(!str_contains($encoded($read('val')), $secret), 'private project, task, feed and comment are absent to a viewer');
}
check(str_contains($encoded($read('sam')), 'SECRET comment'), 'the admin sees private projects');
check(str_contains($encoded($read('max')['events']), 'task.assigned') && !str_contains($encoded($read('sam')['events']), 'task.assigned'),
    'assignment event is recipient scoped even among people who can see the task');
foreach ([$hiddenTask, 'missing'] as $id) {
    try { $add('val', 'task.comment', ['id' => $id, 'text' => 'probe']); throw new RuntimeException('hidden task accepted'); }
    catch (RequestError $e) { check($e->status === 400 && $e->getMessage() === 'That task is gone.', 'hidden and missing tasks are indistinguishable'); }
}

$parent = $add('max', 'task.add', ['project' => $public, 'title' => 'Parent', 'assignee' => 'val', 'notes' => "first\r\nsecond"]);
$child = $add('max', 'task.add', ['parent' => $parent, 'title' => 'Child']);
check($record('tasks', $parent)['notes'] === "first\nsecond" && $record('tasks', $child)['project'] === $public, 'notes and same-project subtask');
refuses(fn() => $add('max', 'task.add', ['parent' => $child, 'title' => 'Too deep']), 400);
refuses(fn() => $add('max', 'task.add', ['project' => $private, 'title' => 'Blocked', 'assignee' => 'val']), 400);
refuses(fn() => $add('max', 'task.add', ['project' => $public, 'title' => 'Invalid date', 'due' => '2026-02-29']), 400);
refuses(fn() => $add('max', 'task.add', ['project' => $public, 'title' => 'Forged', 'source' => ['type' => 'ticket']]), 400);
refuses(fn() => $edit('val', 'task.update', ['id' => $parent, 'rv' => $record('tasks', $parent)['rv'], 'fields' => ['title' => 'no']]), 403);

$before = $read('val')['rev'];
$old = $record('tasks', $parent)['rv'];
$commentRequest = $addRequest('task.comment', ['id' => $parent, 'text' => "  a\r\nb "], 'comment-on-parent', $before);
$comment = $change('val', $commentRequest + ['since' => $before]);
check($comment['delta']['full'] === false && $comment['delta']['tasks'][0]['comments'][0]['text'] === "a\nb", 'viewer may append a comment and receive the delta');
check($change('val', $commentRequest)['id'] === $comment['id'] && count($record('tasks', $parent)['comments']) === 1, 'comment replay does not append twice');
check(str_contains($encoded($read('max')['events']), 'comment.added'), 'the creator receives the comment event');
refuses(fn() => $edit('max', 'task.update', ['id' => $parent, 'rv' => $old, 'fields' => ['status' => 'done']]), 409, 'stale');
$parentRv = $record('tasks', $parent)['rv'];
$updated = $edit('max', 'task.update', ['id' => $parent, 'rv' => $parentRv, 'fields' => ['status' => 'done']]);
check($record('tasks', $parent)['done_at'] === 1700000000 && $record('tasks', $child)['rv'] < $updated['state']['rev'],
    'only the changed task gets a new revision');
$latest = $updated['state']['rev'];
$noChange = $edit('max', 'task.update', ['id' => $parent, 'rv' => $latest, 'fields' => ['status' => 'done']], $latest);
check($noChange['delta']['changed'] === false, 'unchanged edit advances nothing');
$next = $add('max', 'task.add', ['project' => $public, 'title' => 'Next', 'status' => 'done']);
$edit('max', 'task.move', ['id' => $next, 'rv' => $record('tasks', $next)['rv'], 'before' => $parent]);
check($record('tasks', $next)['order'] < $record('tasks', $parent)['order'], 'drag reorders a status column');

$wasVisible = $read('val')['rev'];
refuses(fn() => $edit('max', 'task.update', ['id' => $parent, 'rv' => $latest, 'fields' => ['project' => $private]]), 400);
$edit('max', 'task.update', ['id' => $parent, 'rv' => $latest, 'fields' => ['project' => $private, 'assignee' => '']]);
check($record('tasks', $child)['project'] === $private && $record('tasks', $child)['rv'] === $read()['rev'], 'move stamps the parent and its subtasks');
$reset = $delta('val', $wasVisible);
check($reset['full'] === true && !str_contains($encoded($reset), $parent) && !str_contains($encoded($reset), $child), 'cross-project move replaces the snapshot without repeating hidden ids');
refuses(fn() => $change('val', $commentRequest), 400);
$since = $read('val')['rev'];
$edit('max', 'task.delete', ['id' => $parent, 'rv' => $record('tasks', $parent)['rv'], 'confirm' => true]);
$hiddenDeletion = $delta('val', $since);
check($hiddenDeletion['deleted']['tasks'] === [] && !str_contains($encoded($hiddenDeletion), $parent), 'private tombstone and former public feed remain hidden after deletion');
check(count($delta('max', $since)['deleted']['tasks']) === 2, 'a visible parent deletion tombstones both tasks');

$since = $read('max')['rev'];
refuses(fn() => $edit('max', 'project.delete', ['id' => $public, 'rv' => $record('projects', $public)['rv'], 'confirm' => true]), 403);
refuses(fn() => $edit('sam', 'project.update', ['id' => $private, 'rv' => $record('projects', $private)['rv'], 'owner' => 'sam']), 403);
$edit('alex', 'project.update', ['id' => $private, 'rv' => $record('projects', $private)['rv'], 'members' => []]);
check($delta('max', $since)['full'] === true && !str_contains($encoded($delta('max', $since)), 'SECRET'), 'revoked private membership resets the state and filters feeds');
check($record('tasks', $hiddenTask)['assignee'] === '', 'revocation clears assignments that lost project access');
$since = $read('val')['rev'];
$edit('alex', 'project.delete', ['id' => $private, 'rv' => $record('projects', $private)['rv'], 'confirm' => true]);
check($delta('val', $since)['full'] === true && !str_contains($encoded($delta('val', $since)), $private), 'private project deletion never exposes its id');
$since = $read('val')['rev'];
$edit('alex', 'project.delete', ['id' => $public, 'rv' => $record('projects', $public)['rv'], 'confirm' => true]);
check($delta('val', $since)['deleted']['projects'] === [$public] && $read()['tasks'] === [], 'team project deletion announces the project tombstone and cascades');

$add('sam', 'member.add', ['id' => 'otto', 'name' => 'Otto']);
check($read('otto')['me'] === 'otto', 'adding an existing site account opens its next request');
$otto = $record('members', 'otto');
$edit('sam', 'member.role', ['id' => 'otto', 'role' => 'viewer', 'rv' => $otto['rv']]);
refuses(fn() => $edit('sam', 'member.remove', ['id' => 'otto', 'rv' => $otto['rv'], 'confirm' => true]), 409);
$edit('sam', 'member.remove', ['id' => 'otto', 'rv' => $record('members', 'otto')['rv'], 'confirm' => true]);
refuses(fn() => $read('otto'), 403);
refuses(fn() => $add('otto', 'project.add', ['name' => 'Revoked']), 403);
$edit('sam', 'team.update', ['name' => 'Studio', 'rv' => $read()['team']['rv']]);
check($read()['team']['name'] === 'Studio' && $read()['team']['rv'] === $read()['rev'], 'team settings are revisioned');
check($delta('val', $read()['rev'] + 10)['full'] === true, 'future cursor gets a full replacement');
check(!str_contains((string)file_get_contents($dir . '/workspace.enc'), 'Studio'), 'the domain is encrypted at rest');
$store->transaction('workspace', fn($db) => array_diff_key($db, ['tasks' => true]));
refuses(fn() => $read('alex'), 503);
refuses(fn() => $read('sam'), 403);

// Concurrent adds with the same receipt and competing edits of one revision.
[$store, $dir] = harness_store();
$store->transaction('workspace', fn() => $raw);
$worker = <<<'WORKER'
[, $lib, $dir, $n, $mode, $gate] = $argv;
require $lib . '/operations.php';
for ($i = 0; $i < 10000 && !file_exists($gate); ++$i) { usleep(500); }
$store = new TaskMind\Store($dir);
$request = $mode === 'add'
    ? ['op' => 'project.add', 'data' => ['name' => 'Racing project'], 'requestId' => 'same', 'base' => 1]
    : ['op' => 'project.update', 'data' => ['id' => trim(file_get_contents($dir . '/target')), 'rv' => 2, 'name' => "Edit $n"]];
try {
    $reply = TaskMind\change_workspace($store, ['taskmind_owners' => ['alex'], 'taskmind_seed_admin' => 'sam'], [], 'alex', $request, 1700000000);
    file_put_contents("$dir/$mode-$n", $reply['id']);
} catch (TaskMind\RequestError $e) {
    if ($mode !== 'edit' || $e->status !== 409) { throw $e; }
    file_put_contents("$dir/$mode-$n", 'stale');
}
WORKER;
harness_workers($worker, $dir, 6, 'add');
$after = workspace_state(team_workspace($store, $seedConfig, 'alex'), 'alex');
$id = $after['projects'][0]['id'];
check($after['rev'] === 2 && count($after['projects']) === 1, 'parallel add receipt produces one commit');
check(array_unique(array_map('file_get_contents', glob("$dir/add-*"))) === [$id], 'every racing add returned the same id');
file_put_contents($dir . '/target', $id);
harness_workers($worker, $dir, 6, 'edit');
$after = workspace_state(team_workspace($store, $seedConfig, 'alex'), 'alex');
$attempts = array_count_values(array_map('file_get_contents', glob("$dir/edit-*")));
check($after['rev'] === 3 && ($attempts[$id] ?? 0) === 1 && ($attempts['stale'] ?? 0) === 5,
    'one racing edit wins and the others report a stale record');

// An expired receipt cannot be replayed as a new add, and stale tombstone cursors get a replacement.
$store->transaction('workspace', function ($db) {
    $db['replay_floor'] = 2;
    $db['tomb_floor'] = 2;
    $db['replays'] = [];
    return $db;
});
refuses(fn() => change_workspace($store, $seedConfig, [], 'alex', $addRequest('project.add', ['name' => 'Racing project'], 'same')), 409);
check(workspace_delta(team_workspace($store, $seedConfig, 'alex'), 'alex', 1)['full'], 'a cursor older than retained tombstones gets a full snapshot');
