import { expect, test } from '@playwright/test';
import { applyDelta, type Session, type WorkspaceRead, type WorkspaceWrite } from '../packages/core/src/taskmind';
import { API, browserStorage, login } from './helpers';

test('an authenticated browser writes and reconciles the workspace without storing it', async ({ page }, testInfo) => {
  await login(page, 'alex');
  await expect(page.getByText('Signed in as')).toBeVisible();
  const name = 'Workspace fixture ' + testInfo.project.name;
  const wire = await page.evaluate(async ({ url, name }) => {
    const session = await fetch(url, { cache: 'no-store' });
    const { csrf } = await session.json() as Session;
    const snapshot = await fetch(url + '?view=workspace', { cache: 'no-store' });
    const before = await snapshot.json() as WorkspaceRead;
    if (!('state' in before)) throw new Error('Expected a snapshot.');
    const data = JSON.stringify({
      op: 'project.add', base: before.state.rev, requestId: crypto.randomUUID(), data: { name, visibility: 'private' },
    });
    const send = () => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data, cache: 'no-store',
    });
    const saved = await send();
    const first = await saved.json() as WorkspaceWrite;
    const replay = await send();
    const second = await replay.json() as WorkspaceWrite;
    const changes = await fetch(url + '?view=workspace&since=' + before.state.rev, { cache: 'no-store' });
    const after = await changes.json() as WorkspaceRead;
    return { before, after, first, second, statuses: [snapshot.status, saved.status, replay.status, changes.status],
      cache: changes.headers.get('cache-control') };
  }, { url: API, name });
  expect(wire.statuses).toEqual([200, 200, 200, 200]);
  expect(wire.cache).toContain('no-store');
  expect(wire.first.id).toBe(wire.second.id);
  if (!('state' in wire.before) || !('delta' in wire.after) || !('state' in wire.first)) throw new Error('Expected workspace replies.');
  expect(applyDelta(wire.before.state, wire.after.delta)).toEqual(wire.first.state);
  expect(wire.first.state.projects.filter(project => project.name === name)).toHaveLength(1);
  expect(await browserStorage(page)).toEqual({ local: 0, session: 0, indexed: 0, caches: 0 });
});
