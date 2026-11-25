'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, mkdir, realpath, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const directory = resolve(__dirname, '..');
const supplied = process.argv[2];
const electron = supplied ? resolve(supplied) : require('electron');
const appArgs = supplied ? [] : [directory];

async function waitFor(fn, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + description);
}

async function evaluate(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluation timed out: ' + expression)), 10000);
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new Error('CDP target closed: ' + expression));
      }, { once: true });
      ws.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        clearTimeout(timer);
        const error = response.error || response.result.exceptionDetails;
        if (error) reject(new Error(JSON.stringify(error)));
        else resolve(response.result.result.value);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, returnByValue: true,
      } }));
    });
  } finally { ws.close(); }
}

async function launch(root) {
  const args = [...appArgs, '--remote-debugging-port=0', '--user-data-dir=' + join(root, 'profile')];
  const child = spawn(electron, args, {
    env: { ...process.env, MINDSUITE_SMOKE_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  try {
    const port = await waitFor(() => {
      if (child.exitCode !== null) throw new Error('MindSuite exited early: ' + log);
      return log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1];
    }, 'the hidden window');
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    const page = name => waitFor(async () => (await targets()).find(target => target.url.endsWith(name)), name);
    return { child, page, log: () => log };
  } catch (error) { child.kill(); throw error; }
}

async function proveExclusive(root, profile = 'documents/ScrollMind/App') {
  const child = spawn(electron, [...appArgs, '--mindsuite-scroll-lease'], {
    env: { ...process.env, MINDSUITE_SCROLL_PROFILE: join(root, profile) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    const [answer] = await once(child.stdout, 'data');
    assert.equal(answer.toString().trim(), 'busy', 'a second editor uses the same exclusive lock');
  } finally { child.stdin.end(); }
}

async function closeAndCheck(running, scroll) {
  const exited = once(running.child, 'exit', { signal: AbortSignal.timeout(15000) });
  const [, result] = await Promise.all([evaluate(scroll, 'setTimeout(() => window.scrollmind.quit(), 150); true'), exited]);
  assert.equal(result[0], 0, 'the bundled app closed after flushing ScrollMind');
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mindsuite-mac-smoke-'));
  let running;
  try {
    await mkdir(join(root, 'profile'));
    running = await launch(root);
    const shell = await running.page('/shell.html');
    const cal = await running.page('/calmind/');
    const ui = await waitFor(() => evaluate(cal, 'document.querySelector("#root")?.textContent?.trim()'), 'the local CalMind title');
    assert.match(ui, /CalMind|Reminders|Calendar/i);
    assert.equal(await evaluate(cal, 'typeof window.scrollmind'), 'undefined');
    await evaluate(shell, 'window.suite.split()');
    await waitFor(() => evaluate(shell, '!document.querySelector("header .pane-tools").hidden'), 'the pane icon row');
    await evaluate(shell, 'document.querySelector("header .pane-tools button[data-app=scrollmind]").click()');
    const scroll = await running.page('/scrollmind/src/renderer/index.html');
    await waitFor(() => evaluate(scroll, 'window.scrollmind?.workspaceState().then(s => s.scrolls?.length)'), 'the local ScrollMind workspace');
    assert(await evaluate(scroll, 'document.querySelector("#canvas") instanceof HTMLCanvasElement'));
    await proveExclusive(root);
    assert.equal(await evaluate(shell, 'document.querySelectorAll("header nav [aria-selected=true]").length'), 1);
    await evaluate(shell, 'window.suite.picker({order: ["calmind", "|", "scrollmind"], hidden: ["acctmind"]})');
    await waitFor(() => evaluate(shell, 'document.getElementById("app-acctmind").hidden'), 'the hidden picker entry');
    const alignment = 'Math.abs(document.querySelector("header .pane-tools").getBoundingClientRect().left - document.querySelector("#divider").getBoundingClientRect().right) <= 1';
    assert.equal(await evaluate(shell, alignment), true);
    const { bounds } = await evaluate(shell, 'window.suite.state()');
    assert(Math.abs(bounds.calmind.width - bounds.scrollmind.width) <= 1);
    assert(bounds.calmind.width > 300 && bounds.scrollmind.x > bounds.calmind.x);
    await evaluate(shell, 'window.suite.resize(.65)');
    const resized = await evaluate(shell, 'window.suite.state()');
    assert.equal(resized.ratio, .65);
    await waitFor(() => evaluate(shell, alignment), 'the icon row following the divider');
    assert(resized.bounds.calmind.width > resized.bounds.scrollmind.width, JSON.stringify(resized.bounds));
    await evaluate(shell, 'document.getElementById("divider").dispatchEvent(new MouseEvent("dblclick"))');
    await waitFor(async () => (await evaluate(shell, 'window.suite.state()')).ratio === .5, 'a double-click reset');
    assert.equal(await evaluate(shell, alignment), true);
    await evaluate(shell, 'window.suite.resize(.6)');
    await evaluate(scroll, 'document.getElementById("new-scroll").click()');
    await waitFor(() => evaluate(scroll, 'window.scrollmind.workspaceState().then(s => s.scrolls.length === 2)'), 'a saved second scroll');
    const info = await evaluate(scroll, 'window.scrollmind.getAppInfo()');
    assert(info.dataPath.startsWith(join(root, 'documents/ScrollMind') + '/'));
    await stat(info.dataPath);
    console.log('The bundled panes share a split view and the ScrollMind editor wrote a local document.');
    await evaluate(shell, 'window.suite.select("notemind", "right")');
    const note = await running.page('/notemind/src/index.html');
    await waitFor(() => evaluate(note, 'window.notemind?.start.info().then(info => info.version)'), 'the local NoteMind editor');
    await waitFor(() => evaluate(note, 'localStorage.getItem("notemind.inputSource")'), 'the drawing workspace to finish loading');
    // MindSuite's own update item is in the menu bar of the active tab: the suite menu, and NoteMind's Help menu in place of its own.
    const suiteMenu = await waitFor(async () => (await evaluate(shell, 'window.suite.state()')).menu, 'the menu bar');
    const labelsIn = (menu, title) => (menu.find(([name]) => name === title)?.[1] ?? []);
    await waitFor(async () => {
      const { menu } = await evaluate(shell, 'window.suite.state()');
      return labelsIn(menu, 'Help').includes('Check for Updates…');
    }, 'MindSuite\'s update item in NoteMind\'s Help menu');
    const { menu: noteMenu } = await evaluate(shell, 'window.suite.state()');
    assert.deepEqual(labelsIn(noteMenu, 'Help').filter(label => /Check for Updates/.test(label)), ['Check for Updates…']);
    assert.equal(noteMenu.some(([, labels]) => labels.includes('Check for Updates Automatically')), false);
    assert(Array.isArray(suiteMenu));
    await evaluate(shell, 'window.suite.select("scrollmind", "right")');
    await waitFor(async () => (await evaluate(shell, 'window.suite.state()')).menu?.some(([, labels]) => labels.includes('Check for Updates…') && !labels.includes('Split View')), 'the suite menu with its update item');
    await evaluate(shell, 'window.suite.select("notemind", "right")');
    await waitFor(() => evaluate(note, 'window.notemind?.start.info().then(info => info.version)'), 'NoteMind again');
    const catalog = await evaluate(note, 'window.notemind.listSheets()');
    assert(Array.isArray(catalog.pages));
    await proveExclusive(root, 'notes-profile');
    const file = join(root, 'documents/Fixture.nm');
    const doc = { path: file, text: '# Local NoteMind fixture', title: 'Fixture', assets: {} };
    const saved = await evaluate(note, 'window.notemind.save(' + JSON.stringify(doc) + ')');
    assert.equal(saved.path, await realpath(file));
    assert.equal(saved.recoverySaved, true);
    await stat(file);
    assert.equal(await evaluate(note, 'typeof window.scrollmind'), 'undefined');
    assert.equal(await evaluate(note, 'typeof window.suite'), 'undefined');
    assert.match(await evaluate(note, 'typeof window.wm?.pen?.buttons'), /^function$/);
    assert.equal(await evaluate(shell, 'typeof window.notemind'), 'undefined');
    console.log('The bundled note editor wrote a local notepad.');
    await evaluate(shell, 'window.suite.select("scrollmind", "right")');
    await closeAndCheck(running, scroll);
    console.log('The first window saved and closed.');
    running = await launch(root);
    const restored = await running.page('/shell.html');
    await waitFor(async () => {
      const state = await evaluate(restored, 'window.suite?.state()');
      return state?.right === 'scrollmind' && state?.ratio === .6 && state.picker.hidden.includes('acctmind');
    }, 'both restored panes and their saved size');
    await running.page('/calmind/');
    const reopened = await running.page('/scrollmind/src/renderer/index.html');
    await waitFor(() => evaluate(reopened, 'window.scrollmind?.workspaceState().then(s => s.scrolls?.length === 2)'), 'the reopened scroll');
    console.log('The second window restored the saved split proportions and the local scroll.');
    await evaluate(restored, 'window.suite.select("notemind", "right")');
    const reopenedNote = await running.page('/notemind/src/index.html');
    await waitFor(() => evaluate(reopenedNote, 'Boolean(window.notemind)'), 'the restarted NoteMind bridge');
    await waitFor(() => evaluate(reopenedNote, 'document.querySelector(".sheet-tabs") !== null && localStorage.getItem("notemind.inputSource")'), 'the restarted drawing workspace');
    const reopenedDocument = await evaluate(reopenedNote, 'window.notemind.openPath(' + JSON.stringify(file) + ')');
    assert.match(reopenedDocument.text, /Local NoteMind fixture/);
    await closeAndCheck(running, reopened);
    console.log('Hidden Mac smoke passed: three local apps, exclusive workspaces, split layout and restart.');
  } catch (error) {
    if (running) console.error(running.log());
    throw error;
  } finally {
    if (running && running.child.exitCode === null && running.child.signalCode === null) {
      const exited = once(running.child, 'exit');
      running.child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
