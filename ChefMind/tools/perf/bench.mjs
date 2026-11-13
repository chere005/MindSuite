#!/usr/bin/env node
/**
 * Interaction benchmark for the ChefMind web build (not part of the normal
 * suite; run by hand). Loads a busy fixture (hundreds of shopping rows, pantry
 * rows and recipes), then measures from an input event to the last painted
 * frame of its response for: ticking a select circle on and off, and a drag
 * (pointer down, 20 moves, up) of every draggable thing. Several runs, desktop
 * and phone viewports, CPU throttled 4x to mimic a phone.
 *
 *   npm run export:web with EXPO_PUBLIC_API_URL=http://127.0.0.1:<port>/calmind/api/index.php
 *   node tools/patch-web-html.mjs app/dist/index.html
 *   node tools/perf/bench.mjs [--port 8920] [--runs 5] [--throttle 4] [--only shopping,recipes] [--json out.json]
 *
 * Needs `playwright-core` (or @playwright/test) and a browser: resolved from this
 * checkout, else from $PERF_PLAYWRIGHT (a node_modules dir), else a sibling
 * CalMind checkout. Serves app/dist with e2e-router.php on its own scratch data
 * dir; never touches a real server.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '8920'));
const RUNS = Number(arg('runs', '5'));
const THROTTLE = Number(arg('throttle', '4'));
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const JSON_OUT = arg('json', '');
const PROFILE = arg('profile', ''); // dir: write a .cpuprofile of each drag (use with --runs 1)
const SIZE = Number(arg('size', '400'));
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/calmind/api/index.php`;

function loadPlaywright() {
  const cands = [root, process.env.PERF_PLAYWRIGHT ? dirname(process.env.PERF_PLAYWRIGHT) : null, resolve(root, '../CalMind')].filter(Boolean);
  for (const c of cands) {
    for (const name of ['playwright-core', '@playwright/test']) {
      try { return createRequire(join(c, 'x.js'))(name); } catch { /* next */ }
    }
  }
  throw new Error('playwright-core not found; set PERF_PLAYWRIGHT to a node_modules path');
}
const { chromium } = loadPlaywright();

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : NaN; };

/* ---------- fixture ---------- */
const ITEMS = ['2 cups flour', 'milk', '3 eggs', 'butter, softened', '1 lb chicken thighs', 'olive oil', 'yellow onion', 'garlic', 'canned tomatoes', 'basmati rice', 'cheddar', 'spinach', 'bananas', 'dish soap', 'black pepper', 'lemons', 'pasta', 'ground beef', 'yogurt', 'carrots'];
let idn = 0;
const rid = (p) => `${p}${String(++idn).padStart(10, '0')}`;
function fixture(snapshot) {
  const now = Date.now();
  const recs = [];
  for (const kind of ['shopping', 'pantry']) {
    // The app seeds exactly one of each flagged folder on first load; fill those.
    const f = snapshot.find((r) => r.type === 'folder' && r.payload[kind]);
    let sec = snapshot.find((r) => r.type === 'section' && r.payload.folderId === f.id);
    if (!sec) { sec = { id: rid('ls'), type: 'section', updated: now, payload: { name: kind, folderId: f.id, ord: 'V' } }; recs.push(sec); }
    for (let i = 0; i < SIZE; i++) {
      recs.push({ id: rid('lr'), type: 'reminder', updated: now, payload: {
        text: `${ITEMS[i % ITEMS.length]} ${kind} ${i}`, due: null, time: null, done: false, repeat: null,
        folderId: f.id, sectionId: sec.id, indent: 0, ord: 'a' + String(i).padStart(5, '0') } });
    }
  }
  const body = ['Ingredients', ...Array.from({ length: 30 }, (_, i) => `- ${i + 1} cup ${ITEMS[i % ITEMS.length]}`), 'Instructions', ...Array.from({ length: 20 }, (_, i) => `${i + 1}. Stir the pot for ${i + 1} minutes.`)].join('\n');
  const perSec = Math.ceil(SIZE / 8);
  for (let fi = 0; fi < 2; fi++) {
    const folder = { id: rid('nf'), type: 'folder', updated: now, payload: { name: `Cookbook ${fi}`, color: '#7dc2ed', ord: 'a' + fi, app: 'notes' } };
    recs.push(folder);
    for (let si = 0; si < 4; si++) {
      const sec = { id: rid('ns'), type: 'section', updated: now, payload: { name: `Course ${fi}${si}`, folderId: folder.id, ord: 'a' + si } };
      recs.push(sec);
      for (let ni = 0; ni < perSec; ni++) {
        recs.push({ id: rid('nn'), type: 'note', updated: now, payload: {
          title: `Dish ${fi}-${si}-${ni}`, body, date: null, folderId: folder.id, sectionId: sec.id, ord: 'a' + String(ni).padStart(4, '0') } });
      }
    }
  }
  return recs;
}

/* ---------- in-page instrumentation ---------- */
const INIT = () => {
  const P = (window.__perf = { t0: 0, lt: [], mut: 0, lastMutFrame: 0 });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(t, (e) => { if (t.startsWith('pointer')) P.t0 = e.timeStamp; }, true);
  }
  const start = () => new MutationObserver(() => { P.mut++; }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  // Resolve with the time of the LAST frame that carried DOM changes since t0
  // (a quiet frame ends it; a frame with changes means the response was still landing).
  P.settle = () => new Promise((done) => {
    let last = P.mut, lastPainted = performance.now(), quiet = 0, guard = 0;
    const frame = () => {
      requestAnimationFrame(() => setTimeout(() => {
        const now = performance.now();
        if (P.mut !== last) { last = P.mut; lastPainted = now; quiet = 0; } else quiet++;
        if (quiet >= 2 || ++guard > 90) done(lastPainted - P.t0);
        else frame();
      }, 0));
    };
    frame();
  });
  P.takeLong = () => { const r = P.lt.slice(); P.lt.length = 0; return r; };
};

/* ---------- server ---------- */
function startServer() {
  const data = mkdtempSync(join(tmpdir(), 'chefmind-perf-'));
  const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, 'e2e-router.php'], { cwd: root, env: { ...process.env, CALMIND_DATA_DIR: data }, stdio: 'ignore' });
  return { php, data, stop() { php.kill(); try { rmSync(data, { recursive: true, force: true }); } catch {} } };
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/ChefMind/`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('server did not come up');
}

/* ---------- driving ---------- */
async function signupAndSeed(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ChefMind/`);
  const user = `perf${Date.now()}`;
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByTestId('tab-shopping').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const tok = await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('chefmind.session@')) return JSON.parse(localStorage.getItem(k)).token; });
  const post = async (changes) => (await (await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: JSON.stringify({ action: 'sync', space: 'chef', cursor: 0, changes }) })).json());
  let snap = (await post([])).changes;
  for (let i = 0; i < 30 && !(snap.some((r) => r.type === 'folder' && r.payload.pantry) && snap.some((r) => r.type === 'folder' && r.payload.shopping)); i++) { await page.waitForTimeout(1000); snap = (await post([])).changes; }
  if (process.env.PERF_DEBUG) console.log('snapshot:\n  ' + snap.map((r) => `${r.type}:${JSON.stringify(r.payload).slice(0, 90)}`).join('\n  '));
  const recs = fixture(snap);
  for (let i = 0; i < recs.length; i += 500) { const r = await post(recs.slice(i, i + 500)); if (!r.ok) throw new Error('seed failed ' + JSON.stringify(r).slice(0, 200)); }
  await page.close();
  return recs.length;
}

async function center(loc) { const b = await loc.boundingBox(); if (!b) throw new Error('no box'); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; }

async function openPage(ctx, tab, vp) {
  const page = await ctx.newPage();
  await page.setViewportSize(vp);
  await page.goto(`${BASE}/ChefMind/`);
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(600);
  if (process.env.PERF_SHOT) await page.screenshot({ path: `${process.env.PERF_SHOT}-${tab}.png` });
  const cdp = await ctx.newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  return { page, cdp };
}

/** One click on a locator, returning ms from the pointerup to the last painted frame. */
async function timedClick(page, loc) {
  const { x, y } = await center(loc);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.evaluate(() => window.__perf.settle());
  await page.evaluate(() => window.__perf.takeLong());
  await page.mouse.up();
  const lat = await page.evaluate(() => window.__perf.settle());
  const long = await page.evaluate(() => window.__perf.takeLong());
  return { lat, long };
}

/** pointer down on a grip, 20 moves of `step` px, up. Returns per-move latencies, the drop latency and long tasks. */
async function timedDrag(page, grip, step, label = 'drag') {
  const { x, y } = await center(grip);
  const cdp = PROFILE ? await page.context().newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.evaluate(() => window.__perf.settle());
  await page.evaluate(() => window.__perf.takeLong());
  if (cdp) await cdp.send('Profiler.start');
  const moves = [];
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(x, y + i * step);
    moves.push(await page.evaluate(() => window.__perf.settle()));
  }
  await page.mouse.up();
  const drop = await page.evaluate(() => window.__perf.settle());
  const long = await page.evaluate(() => window.__perf.takeLong());
  if (cdp) { const { profile } = await cdp.send('Profiler.stop'); writeFileSync(join(PROFILE, `${label}-${Date.now()}.cpuprofile`), JSON.stringify(profile)); await cdp.detach(); }
  return { moves, drop, long };
}

async function longPress(page, loc) {
  const { x, y } = await center(loc);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(600 * (THROTTLE > 1 ? 1.5 : 1));
  await page.mouse.up();
  await page.waitForTimeout(500);
}

const SCENARIOS = {
  async shopping(ctx, vp, rec) { await listScenario('shopping', ctx, vp, rec); },
  async pantry(ctx, vp, rec) { await listScenario('pantry', ctx, vp, rec); },
  async recipes(ctx, vp, rec) {
    const { page, cdp } = await openPage(ctx, 'notes', vp);
    const picks = page.locator('[data-testid^="recipe-pick-"]');
    await picks.first().waitFor();
    const n = 12;
    const tgt = picks.nth(n);
    await tgt.scrollIntoViewIfNeeded();
    for (let k = 0; k < 2; k++) {
      const a = await timedClick(page, picks.nth(n)); rec('recipes.check', a);
      await expectTick(picks.nth(n), true, 'recipes tick on');
      const b = await timedClick(page, picks.nth(n)); rec('recipes.uncheck', b);
      await expectTick(picks.nth(n), false, 'recipes tick off');
    }
    await longPress(page, page.getByTestId('note-row').nth(n));
    const grips = page.getByTestId('note-grip');
    await grips.nth(n).scrollIntoViewIfNeeded();
    const before = await page.getByTestId('note-row').allInnerTexts();
    const g = await timedDrag(page, grips.nth(n), 14, 'recipes.drag');
    rec('recipes.drag', { moves: g.moves, drop: g.drop, long: g.long });
    await page.waitForTimeout(300);
    const after = await page.getByTestId('note-row').allInnerTexts();
    if (after.join('|') === before.join('|')) throw new Error('recipes: drag did not move the recipe');
    const sg = page.locator('[data-testid^="nsec-grip-"]').first();
    await sg.scrollIntoViewIfNeeded();
    const sd = await timedDrag(page, sg, 14, 'recipes.sectiondrag');
    rec('recipes.sectiondrag', { moves: sd.moves, drop: sd.drop, long: sd.long });
    await cdp.detach(); await page.close();
  },
  async editor(ctx, vp, rec) {
    const { page, cdp } = await openPage(ctx, 'notes', vp);
    await page.getByTestId('note-row').first().click();
    await page.waitForTimeout(800);
    if (process.env.PERF_SHOT) await page.screenshot({ path: `${process.env.PERF_SHOT}-editor.png` });
    await page.getByTestId('recipe-import').click();
    await page.getByTestId('ing-grip').first().waitFor({ timeout: 10000 });
    const ing = page.getByTestId('ing-grip');
    await ing.nth(3).scrollIntoViewIfNeeded();
    const a = await timedDrag(page, ing.nth(3), 12);
    rec('editor.ingdrag', { moves: a.moves, drop: a.drop, long: a.long });
    const st = page.getByTestId('step-grip');
    await st.nth(3).scrollIntoViewIfNeeded();
    const b = await timedDrag(page, st.nth(3), 12);
    rec('editor.stepdrag', { moves: b.moves, drop: b.drop, long: b.long });
    await cdp.detach(); await page.close();
  },
};

async function listScenario(kind, ctx, vp, rec) {
  const { page, cdp } = await openPage(ctx, kind, vp);
  const picks = page.getByTestId(`${kind}-pick`);
  await picks.first().waitFor();
  const n = 12;
  await picks.nth(n).scrollIntoViewIfNeeded();
  for (let k = 0; k < 2; k++) {
    rec(`${kind}.check`, await timedClick(page, picks.nth(n)));
    await expectTick(picks.nth(n), true, `${kind} tick on`);
    rec(`${kind}.uncheck`, await timedClick(page, picks.nth(n)));
    await expectTick(picks.nth(n), false, `${kind} tick off`);
  }
  await longPress(page, page.getByTestId(`${kind}-row`).nth(n));
  const grips = page.getByTestId(`${kind}-grip`);
  await grips.nth(n).scrollIntoViewIfNeeded();
  const before = await page.getByTestId(`${kind}-row`).allInnerTexts();
  const g = await timedDrag(page, grips.nth(n), 12, `${kind}.drag`);
  rec(`${kind}.drag`, { moves: g.moves, drop: g.drop, long: g.long });
  // Behaviour check: the drop really reordered the list (the lists sort by aisle, so only within an aisle).
  await page.waitForTimeout(300);
  const after = await page.getByTestId(`${kind}-row`).allInnerTexts();
  if (after.join('|') === before.join('|')) throw new Error(`${kind}: drag did not reorder the list`);
  if ([...after].sort().join('|') !== [...before].sort().join('|')) throw new Error(`${kind}: drag changed the set of rows`);
  await cdp.detach(); await page.close();
}

/** The select circle shows a ✓ glyph when picked (RN-web emits no aria-checked for it). */
async function expectTick(loc, want, what) {
  for (let i = 0; i < 20; i++) { if ((await loc.innerText()).includes('✓') === want) return; await loc.page().waitForTimeout(50); }
  throw new Error(`${what}: tick never became ${want ? 'visible' : 'hidden'}`);
}

(async () => {
  if (!existsSync(join(root, 'app/dist/index.html'))) throw new Error('app/dist missing: export the web build first');
  const srv = startServer();
  const results = {};
  try {
    await waitUp();
    const browser = await chromium.launch(process.env.PERF_CHROMIUM ? { executablePath: process.env.PERF_CHROMIUM } : {});
    const ctx = await browser.newContext();
    await ctx.addInitScript(INIT);
    const total = await signupAndSeed(ctx);
    console.log(`fixture: ${total} records seeded, throttle ${THROTTLE}x, ${RUNS} runs, port ${PORT}`);
    const viewports = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
    const names = Object.keys(SCENARIOS).filter((n) => !ONLY.length || ONLY.includes(n));
    for (const [vname, vp] of Object.entries(viewports)) {
      for (let run = 0; run < RUNS; run++) {
        for (const name of names) {
          const rec = (key, m) => {
            const r = ((results[vname] ??= {})[key] ??= { lat: [], moves: [], drops: [], longCount: [], longMs: [] });
            if (m.lat !== undefined) r.lat.push(m.lat);
            if (m.moves) { r.moves.push(...m.moves); r.drops.push(m.drop); }
            r.longCount.push(m.long.length); r.longMs.push(m.long.reduce((a, b) => a + b, 0));
          };
          try { await SCENARIOS[name](ctx, vp, rec); } catch (e) { console.error(`  ! ${vname} ${name} run ${run}: ${String(e.message).split('\n')[0]}`); }
        }
      }
    }
    await browser.close();
  } finally { srv.stop(); }

  const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const out = {};
  console.log('\nscenario                 viewport  n     median   p95    | drop med  p95 | longtasks/op  longms/op');
  for (const [v, keys] of Object.entries(results)) for (const [k, r] of Object.entries(keys)) {
    const main = r.lat.length ? r.lat : r.moves;
    const row = { n: main.length, median: median(main), p95: p95(main), dropMedian: median(r.drops), dropP95: p95(r.drops), longPerOp: sum(r.longCount) / r.longCount.length, longMsPerOp: sum(r.longMs) / r.longMs.length };
    (out[v] ??= {})[k] = row;
    console.log(`${k.padEnd(24)} ${v.padEnd(8)} ${String(row.n).padEnd(5)} ${f(row.median).padStart(7)} ${f(row.p95).padStart(7)}  | ${f(row.dropMedian).padStart(7)} ${f(row.dropP95).padStart(7)} | ${f(row.longPerOp).padStart(6)}  ${f(row.longMsPerOp).padStart(8)}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
