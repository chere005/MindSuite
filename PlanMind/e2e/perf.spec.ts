import { test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, isPhone, login, showTodos, today, type Api } from './helpers';
import { OWNER, PARTNER } from './people';

// The performance benchmark. It is skipped unless PLANMIND_PERF=1 (the normal suite lists it as skipped):
//
//   PLANMIND_PERF=1 PLANMIND_E2E_PORT=8900 npx playwright test e2e/perf.spec.ts --project=desktop --project=phone
//
// Knobs: PLANMIND_PERF_RUNS (default 5), PLANMIND_PERF_THROTTLE (CPU slowdown, default 4; 1 is none), PLANMIND_PERF_OUT (a JSON file stem to write; default the OS temp dir),
// PLANMIND_PERF_LATENCY (ms every write waits before it is sent, default 0), PLANMIND_PERF_SEED (days either side of the bench day, default 14).
//
// What it measures, in the page with performance.now() marks (event.timeStamp is the input's own time):
//  - a check: the click until the frame that shows the row flipped (the answer of the server and the redraw included), and how much of that was the request;
//  - a drag (press, 20 moves, release) of an entry's block, of its end handle and across the lanes: every move until the frame after it, and the release until the frame that shows the saved result;
//  - long tasks (>50 ms) during each interaction, from a PerformanceObserver.
// The store is the preview's own disposable one, so the fixture needs no clean-up. It is busy: 29 days, each with 12 to-dos, five priorities and nine entries, and 150 to-dos in the week and the month.
test.skip(!process.env.PLANMIND_PERF, 'performance benchmark: PLANMIND_PERF=1');

const RUNS = Number(process.env.PLANMIND_PERF_RUNS || 5);
const THROTTLE = Number(process.env.PLANMIND_PERF_THROTTLE || 4);
const LATENCY = Number(process.env.PLANMIND_PERF_LATENCY || 0);   // ms each write waits before it reaches the server (a phone's round trip); 0 is none
const SEED_DAYS = Number(process.env.PLANMIND_PERF_SEED || 14);
const BENCH = farDate(3);                      // 2040-01-04, a Wednesday
const WEEK = periodStart(BENCH, 'week');
const LANE_DAY = farDate(4);
const MONTH = periodStart(today(), 'month');   // chores run from the rhythm's anchor, so the Month and the chores use the real current month
const MARK = 'Perf seed';

test.describe.configure({ mode: 'serial' });

// ---- the fixture -----------------------------------------------------------------------------------------------

async function add(api: Api, body: Record<string, unknown>) {
  const response = await api.post({ id: crypto.randomUUID(), action: 'add', ...body });
  if (response.status() !== 200) { throw new Error(`seed ${JSON.stringify(body)} -> ${response.status()} ${await response.text()}`); }
}
async function seed(baseURL: string) {
  const owner = await apiLogin(baseURL, OWNER);
  const have = (await owner.snapshot()).tasks.some((t: { title: string }) => t.title === MARK);
  if (have) { await owner.dispose(); return; }
  const started = Date.now();
  const both = [OWNER, PARTNER];
  let n = 0;
  for (let d = -SEED_DAYS; d <= SEED_DAYS; d++) {
    const date = farDate(3 + d);
    for (let i = 0; i < 12; i++) { await add(owner, { kind: 'todo', scope: 'day', date, owners: i % 4 === 3 ? both : [OWNER], title: `Task ${d} ${i}` }); n++; }
    for (let i = 0; i < 5; i++) { await add(owner, { kind: 'priority', date, owners: [i === 4 ? PARTNER : OWNER], slots: { [i === 4 ? PARTNER : OWNER]: i === 4 ? 1 : i + 1 }, text: `Pri ${i}` }); n++; }
    // Entries at 7:00, 8:30 ... in the owner's lane and the partner's, one hour each; 16:00 stays free for the entry the bench moves.
    for (let i = 0; i < 5; i++) { await add(owner, { kind: 'event', date, owners: [OWNER], text: `Meeting ${i}`, start: 420 + 90 * i, length: 60 }); n++; }
    for (let i = 0; i < 4; i++) { await add(owner, { kind: 'event', date, owners: [PARTNER], text: `Call ${i}`, start: 450 + 120 * i, length: 60 }); n++; }
  }
  for (let i = 0; i < 150; i++) {
    await add(owner, { kind: 'todo', scope: 'week', date: WEEK, owners: [OWNER], title: `Week item ${i}` });
    await add(owner, { kind: 'todo', scope: 'month', date: MONTH, owners: [OWNER], title: `Month item ${i}` });
    n += 2;
  }
  await add(owner, { kind: 'todo', scope: 'day', date: BENCH, owners: [OWNER], title: 'Perf check' });
  await add(owner, { kind: 'todo', scope: 'week', date: WEEK, owners: [OWNER], title: 'Perf week check' });
  await add(owner, { kind: 'event', date: BENCH, owners: [OWNER], text: 'Perf move', start: 960, length: 60 });
  // Fourteen half-hour entries in the owner's lane for the lane drags, each dragged once into Both (a drag back is its own scenario, not needed to measure a drop).
  for (let i = 0; i < 14; i++) { await add(owner, { kind: 'event', date: LANE_DAY, owners: [OWNER], text: `Perf lane ${i}`, start: 870 + 30 * i, length: 30 }); n++; }
  await add(owner, { kind: 'todo', scope: 'day', date: farDate(-400), owners: [OWNER], title: MARK });
  console.log(`seeded ${n + 4} items in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await owner.dispose().catch(() => {});
}

// ---- in-page instruments -----------------------------------------------------------------------------------------

const INSTRUMENTS = () => {
  const w = window as any;
  const perf = { long: [] as number[], moves: [] as number[] };
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) { perf.long.push(e.duration); } }).observe({ type: 'longtask' }); } catch { /* no long-task support */ }
  /** After the frame that follows the current work has been painted (a rAF callback runs before it; the task after it is once it is out). */
  const painted = (fn: () => void) => requestAnimationFrame(() => setTimeout(fn, 0));
  w.__armCheck = (predicate: string) => new Promise(resolve => {
    perf.long.length = 0;
    let t0 = 0, done = false;
    const test = new Function(`return (${predicate})`) as () => boolean;
    const finish = () => {
      if (done) { return; } done = true; mo.disconnect();
      painted(() => {
        const t1 = performance.now();
        const post = performance.getEntriesByType('resource').filter(e => (e as PerformanceResourceTiming).initiatorType === 'fetch' && e.name.includes('api.php')).pop() as PerformanceResourceTiming | undefined;
        resolve({ total: t1 - t0, first, net: post ? post.responseEnd - post.startTime : 0, long: perf.long.slice() });
      });
    };
    const mo = new MutationObserver(() => { if (t0 && test()) { finish(); } });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
    // The first frame that shows the tick: the clicked box itself changed (the browser pre-toggles it before the click is dispatched), or the redrawn row is already there.
    let first = -1;
    document.addEventListener('click', e => {
      t0 = e.timeStamp;
      const box = e.target as HTMLInputElement, flipped = box.checked;
      const look = () => {
        if (first >= 0 || done) { return; }
        if ((box.isConnected && box.checked === flipped) || test()) { painted(() => { if (first < 0) { first = performance.now() - t0; } }); return; }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
      if (test()) { finish(); }
    }, { capture: true, once: true });
  });
  w.__armDrag = () => new Promise(resolve => {
    perf.long.length = 0; perf.moves = [];
    const move = (e: PointerEvent) => { const t0 = e.timeStamp; painted(() => perf.moves.push(performance.now() - t0)); };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, { capture: true, once: true });
    function up(e: PointerEvent) {
      document.removeEventListener('pointermove', move, true);
      const t0 = e.timeStamp;
      let saw = false;
      const status = document.querySelector('#sync-status');
      const check = () => {
        const text = status?.textContent ?? '';
        if (text === 'Saving…') { saw = true; }
        if (saw && text === 'Saved') { mo.disconnect(); painted(() => painted(() => resolve({ moves: perf.moves.slice(), drop: performance.now() - t0, long: perf.long.slice() }))); }
      };
      const mo = new MutationObserver(check);
      if (status) { mo.observe(status, { subtree: true, childList: true, characterData: true }); }
      // A release that writes nothing (a drag that ends where it began, a resize that only drafts) is over one frame later.
      setTimeout(() => { if (!saw) { mo.disconnect(); painted(() => resolve({ moves: perf.moves.slice(), drop: null, long: perf.long.slice() })); } }, 600);
      check();
    }
  });
};

// ---- numbers -----------------------------------------------------------------------------------------------------

type Sample = { total: number; first?: number; net?: number; long: number[] };
const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : NaN; };
const round = (v: number) => Math.round(v * 10) / 10;
const results: Record<string, unknown> = {};
function summarise(name: string, totals: number[], longs: number[][], extra: Record<string, unknown> = {}) {
  const row = {
    n: totals.length, median_ms: round(quantile(totals, 0.5)), p95_ms: round(quantile(totals, 0.95)), max_ms: round(Math.max(...totals)),
    long_tasks: longs.reduce((a, l) => a + l.length, 0), long_ms: round(longs.reduce((a, l) => a + l.reduce((x, y) => x + y, 0), 0)), ...extra,
  };
  results[name] = row;
  console.log(`PERF ${name} ${JSON.stringify(row)}`);
}

let cdp: CDPSession | undefined;
let profiles = 0;
async function setup(page: Page) {
  await page.addInitScript(INSTRUMENTS);
  await login(page);
  if (LATENCY) { await page.route('**/api.php', async route => { if (route.request().method() === 'POST') { await new Promise(r => setTimeout(r, LATENCY)); } await route.continue(); }); }
  cdp = await page.context().newCDPSession(page);
}
const throttle = (rate: number) => cdp!.send('Emulation.setCPUThrottlingRate', { rate });

const openDay = async (page: Page, date: string) => {
  const phone = (page.viewportSize()?.width ?? 1000) <= 760;
  await page.locator(phone ? '#pill-date' : '#jump-date').fill(date);
  await page.waitForTimeout(400);
};

/** Ticks one checkbox and back, RUNS times each way; returns one sample per click. */
async function toggles(page: Page, circle: () => Locator, labelOf: (open: boolean) => string, scope = ''): Promise<Sample[]> {
  const samples: Sample[] = [];
  await throttle(THROTTLE);
  const profile = process.env.PLANMIND_PERF_PROFILE;   // a file stem: the CPU profile of this series (build with `vite build --minify false` to read it)
  if (profile) { await cdp!.send('Profiler.enable'); await cdp!.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp!.send('Profiler.start'); }
  for (let i = 0; i < RUNS * 2; i++) {
    const closing = i % 2 === 0;          // an open row is ticked, then reopened
    const want = labelOf(!closing);
    const armed = page.evaluate(sel => (window as any).__armCheck(sel), `!!document.querySelector('${scope}input[aria-label="${want.replaceAll('"', '\\"')}"]')`);
    await circle().click();
    const r = await armed as { total: number; first: number; net: number; long: number[] };
    samples.push({ total: r.total, first: r.first >= 0 ? r.first : r.total, net: r.net, long: r.long });
    await page.waitForTimeout(250);
  }
  if (profile) { const { profile: data } = await cdp!.send('Profiler.stop'); writeFileSync(`${profile}-${++profiles}.cpuprofile`, JSON.stringify(data)); }
  await throttle(1);
  return samples;
}
const report = (name: string, samples: Sample[]) => summarise(name, samples.map(s => s.total), samples.map(s => s.long), {
  first_tick_median_ms: round(quantile(samples.map(s => s.first ?? s.total), 0.5)), first_tick_p95_ms: round(quantile(samples.map(s => s.first ?? s.total), 0.95)), net_median_ms: round(quantile(samples.map(s => s.net ?? 0), 0.5)), client_median_ms: round(quantile(samples.map(s => s.total - (s.net ?? 0)), 0.5)),
});

// ---- pointer drags, mouse and finger ----------------------------------------------------------------------------

type Pt = { x: number; y: number };
const centre = async (l: Locator): Promise<Pt> => { await l.scrollIntoViewIfNeeded(); const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
async function drag(page: Page, phone: boolean, from: Pt, dx: number, dy: number, steps = 20) {
  const armed = page.evaluate(() => (window as any).__armDrag());
  if (phone) {
    const send = (type: string, x = 0, y = 0) => cdp!.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await send('touchStart', from.x, from.y);
    await page.waitForTimeout(480);                                   // the hold that lifts the block
    for (let i = 1; i <= steps; i++) { await send('touchMove', from.x + (dx * i) / steps, from.y + (dy * i) / steps); }
    await page.waitForTimeout(120);
    await send('touchEnd');
  } else {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps); }
    await page.mouse.up();
  }
  return await armed as { moves: number[]; drop: number | null; long: number[] };
}
/** `where` says where the thing is NOW and how far to take it; every other run takes it back the same distance. */
async function dragSeries(page: Page, name: string, phone: boolean, where: (i: number) => Promise<{ from: Pt; dx: number; dy: number }>, alternate = true, count = RUNS * 2) {
  const moves: number[] = [], drops: number[] = [], longs: number[][] = [];
  await throttle(THROTTLE);
  const profile = process.env.PLANMIND_PERF_PROFILE;
  if (profile) { await cdp!.send('Profiler.enable'); await cdp!.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp!.send('Profiler.start'); }
  for (let i = 0; i < count; i++) {
    const { from, dx, dy } = await where(i);
    const sign = alternate && i % 2 === 1 ? -1 : 1;
    const r = await drag(page, phone, from, sign * dx, sign * dy);
    moves.push(...r.moves); if (r.drop !== null) { drops.push(r.drop); } longs.push(r.long);
    await page.waitForTimeout(300);
  }
  if (profile) { const { profile: data } = await cdp!.send('Profiler.stop'); writeFileSync(`${profile}-${++profiles}.cpuprofile`, JSON.stringify(data)); }
  await throttle(1);
  if (!moves.length) { console.log(`PERF ${name}: no pointer moves reached the page`); return; }
  summarise(`${name} move-to-frame`, moves, longs);
  if (drops.length) { summarise(`${name} release-to-saved-frame`, drops, []); }
}

// ---- the bench ---------------------------------------------------------------------------------------------------

test.describe('performance', { tag: '@perf' }, () => {
  test.setTimeout(Number(process.env.PLANMIND_PERF_TIMEOUT_MS || 30 * 60_000));
  test.beforeAll(async ({ baseURL }) => { await seed(baseURL!); });
  test.afterAll(async ({}, info) => {
    const stem = process.env.PLANMIND_PERF_OUT?.replace(/\.json$/, '');
    const file = stem ? `${stem}-${info.project.name}.json` : path.join(os.tmpdir(), `planmind-perf-${info.project.name}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ project: info.project.name, throttle: THROTTLE, runs: RUNS, results }, null, 1));
    console.log(`PERF written ${file}`);
  });

  test('checking off', async ({ page }, info) => {
    const phone = isPhone(info.project.name);
    await setup(page);
    // The Day's to-do.
    await openDay(page, BENCH);
    await showTodos(page);
    report(`${info.project.name} day to-do check/uncheck`, await toggles(page, () => page.locator('input.day-circle[aria-label$="Perf check"]'), open => `${open ? 'Complete' : 'Reopen'} Perf check`));

    // Today's chores: the Day's Chores switch (desktop) or the Chores tab (phone).
    await openDay(page, today());
    const flip = async () => { await page.getByRole('button', { name: /^Lists: / }).click(); await page.getByRole('group', { name: 'Lists', exact: true }).getByRole('switch', { name: 'Chores', exact: true }).click(); };
    if (phone) { await page.getByRole('tab', { name: 'Chores', exact: true }).tap(); } else { await flip(); }
    await page.locator('.ch-row .ch-circle').first().waitFor();
    const label = (await page.locator('.ch-row:not(.ch-done) .ch-circle').first().getAttribute('aria-label'))!.replace(/^Complete /, '');
    report(`${info.project.name} day chore check/uncheck`, await toggles(page, () => page.locator(`input.ch-circle[aria-label$="${label}"]`).first(), open => `${open ? 'Complete' : 'Reopen'} ${label}`));

    if (!phone) {
      // The Week's to-do, with 150 rows.
      await flip();
      await openDay(page, WEEK);
      await page.locator('.view-switch button[data-view=week]').click();
      await page.locator('.wm-check').first().waitFor();
      report(`${info.project.name} week to-do check/uncheck (150 rows)`, await toggles(page, () => page.locator('input.wm-check[aria-label$="Perf week check"]'), open => `${open ? 'Complete' : 'Reopen'} Perf week check`));
      // The Month's chore chips.
      await openDay(page, today());
      await page.locator('.view-switch button[data-view=month]').click();
      await page.locator('.wm-day .ch-row .ch-circle').first().waitFor();
      const first = page.locator('.wm-day .ch-row:not(.ch-done) .ch-circle').first();
      const name = (await first.getAttribute('aria-label'))!.replace(/^Complete /, '');
      const date = await first.evaluate(el => el.closest('.wm-day')!.getAttribute('data-date')!);
      report(`${info.project.name} month chore chip check/uncheck`, await toggles(page, () => page.locator(`.wm-day[data-date="${date}"] input.ch-circle[aria-label$="${name}"]`).first(), open => `${open ? 'Complete' : 'Reopen'} ${name}`, `.wm-day[data-date="${date}"] `));
    }
  });

  test('dragging', async ({ page }, info) => {
    const phone = isPhone(info.project.name);
    await setup(page);
    await openDay(page, BENCH);
    const block = () => page.locator('.day-ev', { hasText: 'Perf move' }).first();
    const minute = async () => { const grid = (await page.locator('.day-lanes').boundingBox())!, span = Number(await page.locator('.day-lanes').getAttribute('data-span')); return grid.height / span; };
    // Move: an hour down, then back.
    await dragSeries(page, `${info.project.name} move entry`, phone, async () => ({ from: await centre(block()), dx: 0, dy: 60 * await minute() }));
    // Resize: the entry is opened, its end handle dragged by an hour and back; Escape drops the draft.
    const pos = { position: { x: 30, y: 8 } };
    if (phone) { await block().tap(pos); } else { await block().click(pos); }
    await page.locator('.day-ev.day-editing').waitFor();
    await dragSeries(page, `${info.project.name} resize handle`, phone, async () => ({ from: await centre(page.locator('.day-handle[data-edge=end]')), dx: 0, dy: 60 * await minute() }));
    // Lanes: an entry of the owner's lane dragged into Both (the middle third of the grid), one fresh entry per run.
    await page.keyboard.press('Escape');
    await openDay(page, LANE_DAY);
    await dragSeries(page, `${info.project.name} lane drag`, phone, async i => {
      const box = (await page.locator('.day-lanes').boundingBox())!, from = await centre(page.locator('.day-ev', { hasText: `Perf lane ${i}` }).first());
      return { from, dx: box.x + box.width * 0.5 - from.x, dy: 0 };
    }, false, RUNS);
  });
});
