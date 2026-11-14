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
        // Recorded at the frame callback that first sees it (the next paint shows it), not a second frame later.
        if ((box.isConnected && box.checked === flipped) || test()) { first = performance.now() - t0; return; }
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
// A reply's redraw can land between the scroll and the measure (the element is then detached once): measure again.
const centre = async (l: Locator): Promise<Pt> => {
  for (let attempt = 0; ; attempt++) {
    try { await l.scrollIntoViewIfNeeded(); const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
    catch (e) { if (attempt >= 4) { throw e; } await l.page().waitForTimeout(50); }
  }
};
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

  // ---- interactions under write latency -------------------------------------------------------------------------
  // Run with PLANMIND_PERF_LATENCY=150 (and 400) on every write. Each scenario is repeated PLANMIND_PERF_RUNS times on fresh items and reports the time from each
  // input to the frame that shows its answer (null: never shown, an input that was dropped), whether the end state is right on the screen and on the server, and the
  // time until the server holds everything. CPU throttle as above.
  let fresh = 0;
  const BASE = 40 + Math.floor(Math.random() * 3000);
  const nextDay = () => farDate(BASE + fresh++);
  // REVIEW: the page only learns of items made over the API at its next poll or reply: reload it so they are on screen.
  const freshDay = async (page: Page, date: string) => { await page.reload(); await page.locator('#sidebar .date-row.selected').waitFor({ state: 'attached' }); await openDay(page, date); };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  /** Makes `n` open to-dos on a new day for the owner; returns the day and the titles. */
  async function makeTodos(baseURL: string, n: number, label: string) {
    const owner = await apiLogin(baseURL, OWNER);
    const date = nextDay(), tag = crypto.randomUUID().slice(0, 6);
    const titles = Array.from({ length: n }, (_, i) => `${label} ${tag} ${i}`);
    for (const title of titles) { await add(owner, { kind: 'todo', scope: 'day', date, owners: [OWNER], title }); }
    return { owner, date, titles };
  }
  async function settled(api: Api, ok: (snapshot: any) => boolean, ms: number) {
    const start = Date.now();
    while (Date.now() - start < ms) { if (ok(await api.snapshot())) { return Date.now() - start; } await sleep(100); }
    return null;
  }
  /** In the page: clicks the circle of each title `gap` ms apart (a circle that is disabled or missing ignores the click) and returns the ms from each click to the frame that showed it flipped. */
  const clickCircles = (page: Page, steps: { title: string; want: boolean }[], gap: number) => page.evaluate(async ({ steps, gap }) => {
    const circle = (title: string) => document.querySelector<HTMLInputElement>(`input.day-circle[aria-label$=" ${title}"]`);
    const seen: (number | null)[] = steps.map(() => null), clicked: number[] = [];
    let stop = false;
    const watch = () => {
      steps.forEach((step, i) => { if (seen[i] === null && clicked[i] !== undefined && circle(step.title)?.checked === step.want) { seen[i] = performance.now() - clicked[i]!; } });
      if (!stop) { requestAnimationFrame(watch); }
    };
    requestAnimationFrame(watch);
    for (let i = 0; i < steps.length; i++) {
      clicked[i] = performance.now();
      circle(steps[i]!.title)?.click();
      await new Promise(r => setTimeout(r, gap));
    }
    await new Promise(r => setTimeout(r, 400));
    stop = true;
    return { seen, onScreen: steps.map(step => circle(step.title)?.checked) };
  }, { steps, gap });
  const dayRow = (name: string, rows: { visible: (number | null)[]; ok: boolean; saved: number | null }[]) => {
    const all = rows.flatMap(r => r.visible), shown = all.filter((v): v is number => v !== null);
    const row = {
      runs: rows.length, inputs: all.length, dropped: all.length - shown.length, visible_median_ms: round(quantile(shown, 0.5)), visible_p95_ms: round(quantile(shown, 0.95)), visible_max_ms: round(Math.max(...shown)),
      end_state_right: rows.filter(r => r.ok).length, server_saved_median_ms: round(quantile(rows.map(r => r.saved ?? NaN).filter(v => !Number.isNaN(v)), 0.5)), latency_ms: LATENCY,
    };
    results[`${name} @${LATENCY}ms`] = row;
    console.log(`PERF ${name} @${LATENCY}ms ${JSON.stringify(row)}`);
  };

  test('latency: five different items ticked 80 ms apart', async ({ page, baseURL }, info) => {
    await setup(page);
    const rows = [];
    for (let run = 0; run < RUNS; run++) {
      const { owner, date, titles } = await makeTodos(baseURL!, 5, 'Rapid');
      await freshDay(page, date); await showTodos(page); await page.locator(`input.day-circle[aria-label$=" ${titles[0]}"]`).waitFor();
      await throttle(THROTTLE);
      const r = await clickCircles(page, titles.map(title => ({ title, want: true })), 80);
      const saved = await settled(owner, s => titles.every(t => s.tasks.find((x: any) => x.title === t)?.done), 10_000 + 5 * LATENCY * 2);
      await throttle(1);
      const server = (await owner.snapshot()).tasks.filter((x: any) => titles.includes(x.title));
      rows.push({ visible: r.seen, ok: r.onScreen.every(Boolean) && server.every((x: any) => x.done) && saved !== null, saved });
      await owner.dispose();
    }
    dayRow(`${info.project.name} rapid check-offs`, rows);
  });

  test('latency: tick then untick the same item at once', async ({ page, baseURL }, info) => {
    await setup(page);
    const rows = [];
    for (let run = 0; run < RUNS; run++) {
      const { owner, date, titles } = await makeTodos(baseURL!, 1, 'Flip');
      await freshDay(page, date); await showTodos(page); await page.locator(`input.day-circle[aria-label$=" ${titles[0]}"]`).waitFor();
      await throttle(THROTTLE);
      const r = await clickCircles(page, [{ title: titles[0]!, want: true }, { title: titles[0]!, want: false }], 40);
      await sleep(LATENCY * 3 + 200);
      const saved = await settled(owner, s => s.tasks.find((x: any) => x.title === titles[0])?.done === false, 5000);
      await throttle(1);
      rows.push({ visible: r.seen, ok: r.onScreen[1] === false && saved !== null, saved });
      await owner.dispose();
    }
    dayRow(`${info.project.name} tick then untick`, rows);
  });

  /** In the page: taps the circle of each title `gap` ms apart and returns the ms from each tap to the frame that draws its row crossed out (want true) or open (false) in its place, among the done rows or above them (null: never drawn). */
  const tapRows = (page: Page, steps: { title: string; want: boolean }[], gap: number) => page.evaluate(async ({ steps, gap, wait }) => {
    const row = (title: string) => document.querySelector<HTMLElement>(`input.day-circle[aria-label$=" ${title}"]`)?.closest<HTMLElement>('li');
    const seen: (number | null)[] = steps.map(() => null), tapped: number[] = [], before: (boolean | undefined)[] = [];
    let stop = false;
    // A step counts as drawn only when its row changed after the tap: an untick of a row that was never drawn crossed out shows nothing.
    const watch = () => {
      steps.forEach((step, i) => { if (seen[i] === null && tapped[i] !== undefined && before[i] !== step.want && row(step.title)?.classList.contains('day-done') === step.want) { seen[i] = performance.now() - tapped[i]!; } });
      if (!stop) { requestAnimationFrame(watch); }
    };
    requestAnimationFrame(watch);
    for (let i = 0; i < steps.length; i++) {
      before[i] = row(steps[i]!.title)?.classList.contains('day-done');
      tapped[i] = performance.now();
      document.querySelector<HTMLInputElement>(`input.day-circle[aria-label$=" ${steps[i]!.title}"]`)?.click();
      await new Promise(r => setTimeout(r, gap));
    }
    // Long enough for a screen that only draws once the last save has returned (a write per tap, one at a time) to show it.
    await new Promise(r => setTimeout(r, 400 + wait));
    stop = true;
    return { seen };
  }, { steps, gap, wait: steps.length * LATENCY * 1.5 });
  /** Which of the rows are drawn crossed out now (read after the server holds everything, so the last redraw has happened). */
  const crossedOut = (page: Page, titles: string[]) => page.evaluate(titles => titles.map(title => document.querySelector<HTMLElement>(`input.day-circle[aria-label$=" ${title}"]`)?.closest('li')?.classList.contains('day-done') === true), titles);

  test('latency: a check-off to the crossed-out row in its place', async ({ page, baseURL }, info) => {
    await setup(page);
    const rows = [];
    for (let run = 0; run < RUNS; run++) {
      const { owner, date, titles } = await makeTodos(baseURL!, 3, 'Cross');
      await freshDay(page, date); await showTodos(page); await page.locator(`input.day-circle[aria-label$=" ${titles[0]}"]`).waitFor();
      await throttle(THROTTLE);
      const r = await tapRows(page, [{ title: titles[0]!, want: true }], 80);
      const saved = await settled(owner, s => s.tasks.find((x: any) => x.title === titles[0])?.done === true, 10_000 + LATENCY * 4);
      await throttle(1); await sleep(LATENCY + 300);
      rows.push({ visible: r.seen, ok: (await crossedOut(page, [titles[0]!]))[0] === true && saved !== null, saved });
      await owner.dispose();
    }
    dayRow(`${info.project.name} tap to crossed-out row`, rows);
  });

  test('latency: fifteen taps (thirteen ticks, then two unticks) 80 ms apart', async ({ page, baseURL }, info) => {
    await setup(page);
    const rows = [];
    for (let run = 0; run < RUNS; run++) {
      const { owner, date, titles } = await makeTodos(baseURL!, 13, 'Run');
      await freshDay(page, date); await showTodos(page); await page.locator(`input.day-circle[aria-label$=" ${titles[0]}"]`).waitFor();
      await throttle(THROTTLE);
      const steps = [...titles.map(title => ({ title, want: true })), { title: titles[0]!, want: false }, { title: titles[1]!, want: false }];
      const r = await tapRows(page, steps, 80);
      const saved = await settled(owner, s => titles.every((t, i) => s.tasks.find((x: any) => x.title === t)?.done === (i > 1)), 10_000 + 15 * LATENCY * 2);
      await throttle(1); await sleep(LATENCY + 300);
      rows.push({ visible: r.seen, ok: (await crossedOut(page, titles)).every((on, i) => on === (i > 1)) && saved !== null, saved });
      await owner.dispose();
    }
    dayRow(`${info.project.name} fifteen taps`, rows);
  });

  /** A press, a move of `dy` px in 20 steps, a release: a mouse, or a finger that holds first. Returns when the release has been sent. */
  async function rawDrag(page: Page, phone: boolean, from: Pt, dy: number) {
    if (phone) {
      const send = (type: string, x = 0, y = 0) => cdp!.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
      await send('touchStart', from.x, from.y);
      await page.waitForTimeout(480);
      for (let i = 1; i <= 20; i++) { await send('touchMove', from.x, from.y + (dy * i) / 20); }
      await page.waitForTimeout(40);
      await send('touchEnd');
    } else {
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      for (let i = 1; i <= 20; i++) { await page.mouse.move(from.x, from.y + (dy * i) / 20); }
      await page.mouse.up();
    }
  }
  /** A day with two entries in the owner's lane (an hour each, with room to move down by an hour) and, for the check-off scenario, to-dos. */
  async function makeDay(baseURL: string, todos = 0) {
    const day = await makeTodos(baseURL, todos, 'During');
    await add(day.owner, { kind: 'event', date: day.date, owners: [OWNER], text: 'DragA', start: 420, length: 60 });
    await add(day.owner, { kind: 'event', date: day.date, owners: [OWNER], text: 'DragB', start: 600, length: 60 });
    return day;
  }
  const minuteHeight = async (page: Page) => { const grid = (await page.locator('.day-lanes').boundingBox())!, span = Number(await page.locator('.day-lanes').getAttribute('data-span')); return grid.height / span; };
  const starts = async (api: Api, date: string) => Object.fromEntries((await api.snapshot()).events.filter((e: any) => e.date === date).map((e: any) => [e.text, e.start]));

  test('latency: a drag started 100 ms after a drop, and a check-off during the save', async ({ page, baseURL }, info) => {
    const phone = isPhone(info.project.name);
    await setup(page);
    const second: { ok: boolean; saved: number | null }[] = [], tickRows = [];
    for (let run = 0; run < RUNS; run++) {
      // Two drags in a row.
      let day = await makeDay(baseURL!);
      await freshDay(page, day.date); await page.locator('.day-ev', { hasText: 'DragA' }).first().waitFor();
      await throttle(THROTTLE);
      const hour = 60 * await minuteHeight(page);
      const a = await centre(page.locator('.day-ev', { hasText: 'DragA' }).first());
      await rawDrag(page, phone, a, hour);
      await page.waitForTimeout(100);
      const b = await centre(page.locator('.day-ev', { hasText: 'DragB' }).first());
      await rawDrag(page, phone, b, hour);
      let saved = await settled(day.owner, s => s.events.find((e: any) => e.date === day.date && e.text === 'DragA')?.start === 480 && s.events.find((e: any) => e.date === day.date && e.text === 'DragB')?.start === 660, 10_000);
      await throttle(1);
      second.push({ ok: saved !== null, saved }); 
      await day.owner.dispose();
      // A check-off in the middle of a drop's save.
      day = await makeDay(baseURL!, 1);
      await freshDay(page, day.date); await page.locator('.day-ev', { hasText: 'DragA' }).first().waitFor();
      await throttle(THROTTLE);
      const mover = await centre(page.locator('.day-ev', { hasText: 'DragA' }).first());
      await rawDrag(page, phone, mover, hour);
      const r = await page.evaluate(async ({ title, tab }) => {
        if (tab) { [...document.querySelectorAll<HTMLElement>('[role=tab]')].find(t => t.textContent?.trim() === 'To-do')?.click(); await new Promise(res => setTimeout(res, 40)); }
        const circle = () => document.querySelector<HTMLInputElement>(`input.day-circle[aria-label$=" ${title}"]`);
        const t0 = performance.now();
        let seen: number | null = null;
        const watch = () => { if (seen === null && circle()?.checked) { seen = performance.now() - t0; } if (seen === null) { requestAnimationFrame(watch); } };
        requestAnimationFrame(watch);
        circle()?.click();
        await new Promise(res => setTimeout(res, 400));
        return { seen, on: circle()?.checked ?? false };
      }, { title: day.titles[0]!, tab: phone });
      saved = await settled(day.owner, s => s.events.find((e: any) => e.date === day.date && e.text === 'DragA')?.start === 480 && s.tasks.find((t: any) => t.title === day.titles[0])?.done === true, 10_000);
      await throttle(1);
      tickRows.push({ visible: [r.seen], ok: r.on && saved !== null, saved });
      await day.owner.dispose();
    }
    const row = { runs: second.length, both_drags_landed: second.filter(x => x.ok).length, server_saved_median_ms: round(quantile(second.map(x => x.saved ?? NaN).filter(v => !Number.isNaN(v)), 0.5)), latency_ms: LATENCY };
    results[`${info.project.name} drag 100 ms after a drop @${LATENCY}ms`] = row;
    console.log(`PERF ${info.project.name} drag 100 ms after a drop @${LATENCY}ms ${JSON.stringify(row)}`);
    dayRow(`${info.project.name} check-off during a drag's save`, tickRows);
  });

  test('latency: how long a finger holds before an entry lifts', async ({ page, baseURL }, info) => {
    test.skip(!isPhone(info.project.name), 'touch only');
    await setup(page);
    const day = await makeDay(baseURL!);
    await freshDay(page, day.date); await page.locator('.day-ev', { hasText: 'DragA' }).first().waitFor();
    const a = await centre(page.locator('.day-ev', { hasText: 'DragA' }).first());
    const lifts: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const armed = page.evaluate(() => new Promise<number>(resolve => {
        const t0 = performance.now();
        const mo = new MutationObserver(() => { if (document.querySelector('[data-moving]')) { mo.disconnect(); resolve(performance.now() - t0); } });
        mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-moving'] });
        setTimeout(() => { mo.disconnect(); resolve(-1); }, 2000);
      }));
      await cdp!.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
      lifts.push(await armed);
      await cdp!.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(500);
    }
    summarise(`${info.project.name} touch hold to lift`, lifts, []);
    await day.owner.dispose();
  });
});
