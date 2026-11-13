import { test, expect, type Page, type Locator, type CDPSession } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { API } from './port';
import { ordSeq } from '../../packages/mind-core/src/order';

/**
 * Interaction-latency benchmark (tagged @perf). NOT part of the normal suite:
 * it is skipped unless CALMIND_PERF=1.
 *
 *   npm run export:web
 *   CALMIND_PERF=1 CALMIND_E2E_PORT=8910 npx playwright test e2e/perf.spec.ts
 *
 * It signs up a fresh account, pushes a realistic busy store through the real
 * API (240 reminders in 4 sections, 300 events across 3 calendars, 12 habits
 * with 90 days of ticks, 80 notes), signs in through the UI and measures, for
 * a desktop and a phone viewport, with the CPU throttled 4x (CDP
 * Emulation.setCPUThrottlingRate) the time from input to the next painted frame
 * for: ticking a reminder off and on, ticking a habit cell, dragging a reminder
 * row, a habit row and a note row (pointer down, 20 moves, up), and swiping the
 * calendar grid. Each scenario is repeated 5 times; per-move or per-click
 * latencies are pooled and reported as median and p95, with the long-task
 * count and total long-task time. Results land in perf-results/<label>.json
 * ($CALMIND_PERF_LABEL, default "run") and on stdout.
 *
 * "Next painted frame": a capture-phase listener stamps every input event, and
 * the frame is the first setTimeout that fires after a requestAnimationFrame
 * requested inside that listener (rAF runs before paint, the timer after it).
 * A move that arrives while the main thread is busy therefore pays for the
 * queue it waited in, which is what a finger feels.
 */
const ON = process.env.CALMIND_PERF === '1';
const LABEL = process.env.CALMIND_PERF_LABEL || 'run';
const RUNS = Number(process.env.CALMIND_PERF_RUNS || 5);
const ONLY = process.env.CALMIND_PERF_VIEWPORT; // 'desktop' | 'phone' to run one
const MOVES = 20;

type Fixture = { user: string; pass: string };

async function api(body: unknown, token?: string): Promise<any> {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}

function ymd(off: number): string {
  const d = new Date(Date.now() + off * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function buildFixture(): Promise<Fixture> {
  const user = `perf${Date.now()}`;
  const pass = 'e2epassword';
  const su = await api({ action: 'signup', username: user, email: `${user}@example.com`, password: pass });
  if (!su.ok) throw new Error('signup failed ' + JSON.stringify(su));
  const now = Date.now() + 120_000;
  const recs: { id: string; type: string; updated: number; payload: Record<string, unknown> }[] = [];
  const rec = (id: string, type: string, payload: Record<string, unknown>) => recs.push({ id, type, updated: now, payload });

  // Reminders: one folder, 4 sections x 60 rows, a spread of due dates.
  rec('pfR', 'folder', { name: 'Busy', color: '#4c8bf0', ord: 'B', app: 'reminders' });
  const secs = ['Today', 'Soon', 'Errands', 'Someday'];
  secs.forEach((n, i) => rec(`pfs${i}`, 'section', { name: n, folderId: 'pfR', ord: ordSeq(4)[i] }));
  const remOrd = ordSeq(60);
  secs.forEach((_n, si) => {
    for (let i = 0; i < 60; i++) {
      rec(`pfr${si}_${i}`, 'reminder', {
        text: `Reminder ${si}-${i} with a reasonably long line of text to elide`,
        due: i % 3 === 0 ? null : ymd((i % 20) - 5), time: i % 7 === 0 ? '14:00' : null,
        done: false, repeat: i % 11 === 0 ? { n: 1, unit: 'week' } : null, indent: i % 9 === 0 ? 1 : 0,
        folderId: 'pfR', sectionId: `pfs${si}`, ord: remOrd[i],
      });
    }
  });
  // Calendars and events.
  const cals = [['pfc0', 'Personal', '#0379f6'], ['pfc1', 'Work', '#803be7'], ['pfc2', 'Fitness', '#fa6800']];
  const calOrd = ordSeq(3);
  cals.forEach(([id, name, color], i) => rec(id!, 'calendar', { name, color, ord: calOrd[i] }));
  const evOrd = ordSeq(300);
  for (let i = 0; i < 300; i++) {
    rec(`pfe${i}`, 'event', {
      text: `Event ${i}`, date: ymd((i % 70) - 20), time: `${String(8 + (i % 12)).padStart(2, '0')}:00`,
      repeat: i % 25 === 0 ? { n: 1, unit: 'week' } : null, calendarId: `pfc${i % 3}`, ord: evOrd[i],
    });
  }
  // Habits: 2 sections x 6 habits, 90 days of ticks.
  rec('pfhs0', 'habitsection', { name: 'Health', color: '#4357ef', ord: 'B' });
  rec('pfhs1', 'habitsection', { name: 'Mind', color: '#e44525', ord: 'D' });
  const hOrd = ordSeq(6);
  for (let h = 0; h < 12; h++) {
    rec(`pfh${h}`, 'habit', { name: `Habit ${h}`, sectionId: `pfhs${h % 2}`, ord: hOrd[Math.floor(h / 2)] });
    for (let d = 1; d < 90; d++) if ((h * 7 + d * 13) % 100 < 65) rec(`t_pfh${h}_${ymd(-d).replace(/-/g, '')}`, 'tick', { habitId: `pfh${h}`, date: ymd(-d) });
  }
  // Notes.
  rec('pfnf', 'folder', { name: 'Notes', color: '#7dc2ed', ord: 'B', app: 'notes' });
  rec('pfns', 'section', { name: 'General', folderId: 'pfnf', ord: 'B' });
  const nOrd = ordSeq(80);
  for (let i = 0; i < 80; i++) {
    rec(`pfn${i}`, 'note', { title: `Note ${i}`, body: '- one\n- two\n- three', date: null, folderId: 'pfnf', sectionId: 'pfns', ord: nOrd[i] });
  }
  for (let i = 0; i < recs.length; i += 400) {
    const r = await api({ action: 'sync', cursor: 0, changes: recs.slice(i, i + 400) }, su.token);
    if (!r.ok) throw new Error('push failed ' + JSON.stringify(r));
  }
  return { user, pass };
}

const INSTRUMENT = `(() => {
  const w = window;
  w.__perf = { frames: [], longtasks: [] };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) {
    window.addEventListener(type, (e) => {
      const rec = { type, ts: e.timeStamp, t1: 0 };
      w.__perf.frames.push(rec);
      requestAnimationFrame(() => setTimeout(() => { rec.t1 = performance.now(); }, 0));
    }, true);
  }
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.longtasks.push({ start: e.startTime, dur: e.duration }); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
})();`;

type Sample = { lat: number[]; longtasks: number; longMs: number; wall: number };

async function reset(page: Page) {
  await page.evaluate(() => { (window as any).__perf.frames = []; (window as any).__perf.longtasks = []; });
}
async function collect(page: Page, types: string[], wall: number): Promise<Sample> {
  await page.waitForTimeout(500);
  const d = await page.evaluate(() => (window as any).__perf);
  const lat = d.frames.filter((f: any) => types.includes(f.type) && f.t1 > 0).map((f: any) => f.t1 - f.ts);
  const longMs = d.longtasks.reduce((a: number, t: any) => a + t.dur, 0);
  return { lat, longtasks: d.longtasks.length, longMs, wall };
}

const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

// CALMIND_PERF_PROFILE=1: wrap each scenario's gesture in a CDP CPU profile and
// print the heaviest functions by self time (the profile that found the causes).
let PROF: CDPSession | null = null;
const profTotals = new Map<string, number>();
let TRACE: { browser: import('@playwright/test').Browser; page: Page } | null = null;
async function profStart() {
  if (PROF) { await PROF.send('Profiler.enable'); await PROF.send('Profiler.start'); }
  if (TRACE) await TRACE.browser.startTracing(TRACE.page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
}
async function profStop(label: string) {
  if (TRACE) {
    const buf = await TRACE.browser.stopTracing();
    const ev = (JSON.parse(buf.toString()).traceEvents as any[]).filter((e) => e.ph === 'X' && e.dur);
    const by = new Map<string, number>();
    for (const e of ev) by.set(e.name, (by.get(e.name) || 0) + e.dur);
    console.log(`\n-- trace ${label} (inclusive ms by event, throttled)`);
    for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(Math.round(v / 1000)).padStart(7), k);
  }
  if (!PROF) return;
  const { profile } = await PROF.send('Profiler.stop') as any;
  const dt: number[] = profile.timeDeltas; const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id: number, i: number) => {
    const n = byId.get(id); const cf = n.callFrame;
    const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`;
    self.set(k, (self.get(k) || 0) + (dt[i] || 0));
  });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log(`\n-- profile ${label} (self ms, throttled)`);
  for (const [k, v] of top) console.log(String(Math.round(v / 1000)).padStart(7), k);
  void profTotals;
}

async function drag(page: Page, handle: Locator, dy: number): Promise<Sample> {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(300); // the grant measures rows asynchronously
  await reset(page);
  const t0 = Date.now();
  await profStart();
  for (let i = 1; i <= MOVES; i++) {
    await page.mouse.move(x, y + (dy * i) / MOVES);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const wall = Date.now() - t0;
  await profStop('drag');
  const s = await collect(page, ['pointermove', 'pointerup'], wall);
  await page.waitForTimeout(400);
  return s;
}

async function holdLong(page: Page, loc: Locator) {
  const box = (await loc.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

type Result = Record<string, { n: number; median: number; p95: number; longtasks: number; longMs: number; wallMedian: number }>;

function summarise(samples: Sample[]) {
  const lat = samples.flatMap((s) => s.lat);
  return {
    n: lat.length,
    median: r1(q(lat, 0.5)),
    p95: r1(q(lat, 0.95)),
    longtasks: samples.reduce((a, s) => a + s.longtasks, 0),
    longMs: Math.round(samples.reduce((a, s) => a + s.longMs, 0)),
    wallMedian: Math.round(q(samples.map((s) => s.wall), 0.5)),
  };
}

async function scenarios(page: Page, cdp: CDPSession): Promise<Result> {
  const out: Result = {};
  const phone = (page.viewportSize()?.width ?? 1000) < 600;
  void phone;
  const click = async (loc: Locator): Promise<Sample> => {
    const b = (await loc.boundingBox())!;
    await reset(page);
    const t0 = Date.now();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await profStart();
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    await profStop('click');
    return collect(page, ['pointerup', 'click'], Date.now() - t0);
  };

  // 1. Reminders: tick off and un-tick (x RUNS each), on different rows.
  await page.getByTestId('tab-reminders').click();
  await expect(page.getByTestId('rem-row').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  const tickOn: Sample[] = [];
  const tickOff: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    const tick = page.getByTestId('tick').nth(i + 1);
    tickOn.push(await click(tick));
    tickOff.push(await click(tick));
    await page.waitForTimeout(2300); // let the grace period end between runs
  }
  out['reminder tick'] = summarise(tickOn);
  out['reminder untick'] = summarise(tickOff);

  // 2. Reminder row drag, in edit mode.
  await holdLong(page, page.getByTestId('rem-body').first());
  await expect(page.getByTestId('row-grip').first()).toBeVisible();
  const remDrag: Sample[] = [];
  for (let i = 0; i < RUNS; i++) remDrag.push(await drag(page, page.getByTestId('row-grip').nth(2), i % 2 === 0 ? 90 : -60));
  out['reminder drag'] = summarise(remDrag);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 3. Habit tick, then habit row drag.
  await page.getByTestId('tab-habits').click();
  await expect(page.getByTestId('habit-name').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  const hTick: Sample[] = [];
  const cells = page.locator('[role="checkbox"]');
  for (let i = 0; i < RUNS; i++) hTick.push(await click(cells.nth(30 + i * 3)));
  out['habit tick'] = summarise(hTick);
  await holdLong(page, page.getByTestId('habit-name').first());
  await expect(page.getByTestId('habit-grip').first()).toBeVisible();
  const hDrag: Sample[] = [];
  for (let i = 0; i < RUNS; i++) hDrag.push(await drag(page, page.getByTestId('habit-grip').nth(1), i % 2 === 0 ? 70 : -50));
  out['habit drag'] = summarise(hDrag);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 4. Note row drag.
  await page.getByTestId('tab-notes').click();
  await expect(page.getByTestId('note-row').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await holdLong(page, page.getByTestId('note-row').first());
  await expect(page.getByTestId('note-grip').first()).toBeVisible();
  const nDrag: Sample[] = [];
  for (let i = 0; i < RUNS; i++) nDrag.push(await drag(page, page.getByTestId('note-grip').nth(2), i % 2 === 0 ? 90 : -60));
  out['note drag'] = summarise(nDrag);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 5. Calendar grid swipe (the pan responder): 20 moves sideways, month paging.
  await page.getByTestId('tab-calendar').click();
  await expect(page.getByTestId('cal-cell').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  const cal: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    const g = (await page.getByTestId('cal-grid').boundingBox())!;
    const x = g.x + g.width * 0.7;
    const y = g.y + g.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await reset(page);
    const t0 = Date.now();
    for (let m = 1; m <= MOVES; m++) { await page.mouse.move(x - (g.width * 0.5 * m) / MOVES, y); await page.waitForTimeout(16); }
    await page.mouse.up();
    cal.push(await collect(page, ['pointermove', 'pointerup'], Date.now() - t0));
  }
  out['calendar swipe'] = summarise(cal);
  void cdp;
  return out;
}

test.describe('@perf interaction latency', () => {
  test.skip(!ON, 'set CALMIND_PERF=1 to run the benchmark');
  test.setTimeout(600_000);

  test('latency, desktop and phone, CPU 4x', async ({ browser }) => {
    const fx = await buildFixture();
    const report: Record<string, Result> = {};
    for (const [name, vp] of ([['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]] as const).filter(([n]) => !ONLY || n === ONLY)) {
      const ctx = await browser.newContext({ viewport: vp, baseURL: API.replace(/api\/index\.php$/, '') });
      const page = await ctx.newPage();
      await page.addInitScript(INSTRUMENT);
      await page.goto('.');
      await page.getByPlaceholder('Username').fill(fx.user);
      await page.getByPlaceholder('Password', { exact: true }).fill(fx.pass);
      await page.getByText('Sign in', { exact: true }).click();
      await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('tab-reminders').click();
      await expect(page.getByTestId('rem-row').first()).toBeVisible({ timeout: 30_000 });
      console.log(vp.width, 'rows drawn:', await page.getByTestId('rem-row').count());
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      if (process.env.CALMIND_PERF_PROFILE) PROF = cdp;
      if (process.env.CALMIND_PERF_TRACE) TRACE = { browser, page };
      report[name] = await scenarios(page, cdp);
      await ctx.close();
    }
    mkdirSync('perf-results', { recursive: true });
    writeFileSync(`perf-results/${LABEL}.json`, JSON.stringify(report, null, 2));
    for (const [vp, res] of Object.entries(report)) {
      console.log(`\n== ${LABEL} / ${vp} (CPU 4x) — ms input→next frame`);
      console.log('scenario'.padEnd(18), 'n'.padStart(4), 'median'.padStart(8), 'p95'.padStart(8), 'longtasks'.padStart(10), 'longMs'.padStart(8), 'wallMed'.padStart(8));
      for (const [k, v] of Object.entries(res)) {
        console.log(k.padEnd(18), String(v.n).padStart(4), String(v.median).padStart(8), String(v.p95).padStart(8), String(v.longtasks).padStart(10), String(v.longMs).padStart(8), String(v.wallMedian).padStart(8));
      }
    }
  });
});
