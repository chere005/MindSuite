'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, WebContentsView } = require('electron');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { origin, installCalMindProtocol } = require('./calmind.cjs');
const { openScrollMind } = require('./scrollmind.cjs');
const { openNoteMind } = require('./notemind.cjs');
const { flag, runLease } = require('./scroll-lease.cjs');
const { configurePermissions, external, lockWebContents, preferences } = require('./web-contents.cjs');
const { apps, restore, select, toggle, paneBounds, ratioFor } = require('./workspace.cjs');
const picker = require('./picker.js');

if (process.argv.includes(flag) && process.env.MINDSUITE_SCROLL_PROFILE) {
  runLease(app);
} else {
  start();
}

function start() {
  const isMac = process.platform === 'darwin';
  const fixture = process.env.MINDSUITE_SMOKE_ROOT;
  const testing = Boolean(fixture);
  if (testing) {
    for (const name of ['profile', 'documents']) mkdirSync(join(fixture, name), { recursive: true });
    app.setPath('userData', join(fixture, 'profile'));
    app.setPath('documents', join(fixture, 'documents'));
    if (isMac) app.setActivationPolicy('accessory');
  }
  app.setName('MindSuite');
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }

  const runtime = app.isPackaged ? join(process.resourcesPath, 'mindsuite-local') : join(__dirname, 'runtime');
  const icon = join(__dirname, 'assets/icon.png');
  const stateFile = join(app.getPath('userData'), 'workspace.json');
  let initial;
  try { initial = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* a new workspace */ }
  let state = restore(initial);
  let window, calmindSession, scroll, note, suiteMenu, closing = false, cleanClose = false, quitting = false;
  let saveTimer, editingPicker = false;
  const views = new Map(), pending = new Map(), errors = new Map();

  const splitMenuItem = { label: 'Split View', accelerator: 'CmdOrCtrl+Alt+S', click: () => update(toggle(state)) };
  const appFor = key => apps.find(entry => entry.key === key);
  const isOpen = key => key === state.left || key === state.right;
  const shortMessage = error => typeof error?.message === 'string' ? error.message.split('\n')[0].slice(0, 260) : 'Could not open the app.';
  const snapshot = () => ({
    ...state, apps,
    errors: Object.fromEntries(errors),
    ready: [...views.keys()].filter(key => !pending.has(key) && !errors.has(key)),
    ...(testing && { bounds: Object.fromEntries([...views].map(([key, view]) => [key, view.getBounds()])) }),
  });

  function publishMenu(noteMenu = note?.menu) {
    if (!isMac || !suiteMenu) return;
    const menu = state.active === 'notemind' && !editingPicker && noteMenu ? noteMenu : suiteMenu;
    if (Menu.getApplicationMenu() !== menu) Menu.setApplicationMenu(menu);
  }

  function publish() {
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const bounds = paneBounds(width, height, state.split, state.ratio);
    for (const [key, view] of views) {
      view.setVisible(isOpen(key) && !errors.has(key) && !editingPicker);
      if (isOpen(key)) view.setBounds(bounds[key === state.right ? 1 : 0]);
    }
    note?.layout();
    publishMenu();
    if (!window.webContents.isDestroyed()) window.webContents.send('suite:state', snapshot());
  }

  function saveState() {
    clearTimeout(saveTimer);
    try {
      const temp = stateFile + '.tmp';
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, stateFile);
    } catch { /* the open views still work */ }
  }

  function update(next) {
    if (closing || !window || window.isDestroyed()) return snapshot();
    state = next;
    saveState();
    void ensureView(state.left);
    if (state.right) void ensureView(state.right);
    publish();
    return snapshot();
  }

  function selectApp(key, side) { return update(select(state, key, side)); }

  function resizeSplit(ratio) {
    if (closing || !state.split) return;
    state = { ...state, ratio: ratioFor(ratio) };
    publish();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 150);
  }

  function keyboard(contents) {
    contents.on('before-input-event', (event, input) => {
      const match = /^Digit([1-7])$/.exec(input.code || '');
      if (input.type === 'keyDown' && input.alt && !input.control && !input.meta && !input.shift && match) {
        const key = picker.visible(state.picker)[Number(match[1]) - 1];
        if (!key) return;
        event.preventDefault();
        selectApp(key, 'left');
      }
    });
  }

  function attach(key, view) {
    const contents = view.webContents;
    view.setVisible(false);
    window.contentView.addChildView(view);
    views.set(key, view);
    keyboard(contents);
    contents.on('focus', () => {
      if (isOpen(key) && state.active !== key) selectApp(key);
    });
    contents.on('render-process-gone', () => {
      errors.set(key, 'The app stopped responding. Reopen the saved view.');
      publish();
    });
  }

  async function createView(key) {
    if (isMac && key === 'scrollmind') {
      const root = join(runtime, 'scrollmind');
      if (!existsSync(join(root, 'src/renderer/index.html'))) throw new Error('The bundled ScrollMind files are missing.');
      scroll = await openScrollMind(window, root, join(app.getPath('documents'), 'ScrollMind'), { testing });
      return attach(key, scroll.view);
    }
    if (isMac && key === 'notemind') {
      const root = join(runtime, 'notemind');
      const profile = testing ? join(fixture, 'notes-profile') : join(app.getPath('appData'), 'NoteMind');
      if (!existsSync(join(root, 'src/index.html'))) throw new Error('The bundled NoteMind files are missing.');
      note = await openNoteMind(window, root, profile, {
        attach: view => attach(key, view),
        detach: view => { views.delete(key); window.contentView.removeChildView(view); },
        activate: () => selectApp(key),
        closeSuite: () => window.close(),
        menuChanged: publishMenu,
        splitMenuItem,
        testing,
      });
      return;
    }
    const isLocalCalMind = isMac && key === 'calmind';
    if (isLocalCalMind && !existsSync(join(runtime, 'calmind/index.html'))) {
      throw new Error('The bundled CalMind export is missing.');
    }
    const view = new WebContentsView({ webPreferences: {
      ...preferences, session: isLocalCalMind ? calmindSession : session.defaultSession,
    } });
    const contents = view.webContents;
    lockWebContents(contents, { apple: key === 'notemind', testing });
    attach(key, view);
    try {
      await contents.loadURL(origin + appFor(key).path);
    } catch (error) {
      if (!contents.isDestroyed()) contents.close();
      window.contentView.removeChildView(view);
      views.delete(key);
      throw error;
    }
  }

  function ensureView(key) {
    if (views.has(key) || errors.has(key) || pending.has(key)) return;
    pending.set(key, createView(key).catch(error => {
      errors.set(key, shortMessage(error));
    }).finally(() => { pending.delete(key); publish(); }));
  }

  function retry(key) {
    if (!isOpen(key) || !errors.has(key)) return snapshot();
    const view = views.get(key);
    if (view) view.webContents.reload();
    errors.delete(key);
    return update(state);
  }

  async function finishClose() {
    if (closing) return;
    closing = true;
    try {
      await Promise.allSettled(pending.values());
      await note?.finish();
      note = null;
      await scroll?.finish();
      saveState();
      for (const view of views.values()) {
        window.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
      views.clear();
      cleanClose = true;
      window.close();
    } catch (error) {
      quitting = false;
      closing = false;
      if (testing) { console.error(error); app.exit(1); return; }
      update(state);
      await dialog.showMessageBox(window, {
        type: 'error', title: 'Writing has not been saved', message: 'MindSuite is staying open to protect your writing.',
        detail: shortMessage(error), buttons: ['Keep Writing'],
      });
    }
  }

  function showWindow() {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); return; }
    cleanClose = false;
    closing = false;
    editingPicker = false;
    window = new BrowserWindow({
      title: 'MindSuite', width: 1200, height: 820, minWidth: 600, minHeight: 440,
      icon, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181a' : '#eeeeeb',
      webPreferences: { ...preferences, preload: join(__dirname, 'shell-preload.cjs') },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    keyboard(window.webContents);
    window.on('resize', publish);
    window.on('close', event => { if (!cleanClose) { event.preventDefault(); void finishClose(); } });
    window.on('closed', () => {
      errors.clear();
      scroll = null;
      note = null;
      if (suiteMenu) Menu.setApplicationMenu(suiteMenu);
      window = null;
      if (quitting || testing) setImmediate(() => app.quit());
    });
    window.once('ready-to-show', () => { if (!testing) window.show(); });
    void window.loadFile(join(__dirname, 'shell.html')).then(() => update(state));
  }

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (!isMac) setImmediate(() => app.quit()); });
  app.on('before-quit', event => {
    if (window && !cleanClose) { event.preventDefault(); quitting = true; window.close(); }
  });

  void app.whenReady().then(() => {
    configurePermissions(session.defaultSession);
    if (testing) session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^https?:/.test(details.url) }));
    if (isMac) {
      calmindSession = session.fromPartition('persist:calmind-local');
      configurePermissions(calmindSession);
      installCalMindProtocol(calmindSession, join(runtime, 'calmind'), { offline: testing });
    }

    const actions = {
      state: snapshot, select: selectApp, split: () => update(toggle(state)), resize: resizeSplit, retry,
      picker: config => update({ ...state, picker: picker.normalize(apps.map(app => app.key), config) }),
      editing: editing => { editingPicker = editing === true; publish(); },
      external: () => { if (!testing) external(origin + appFor(state.active).path); },
    };
    for (const [verb, action] of Object.entries(actions)) {
      ipcMain.handle('suite:' + verb, (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
          throw new Error('This action is unavailable.');
        }
        return action(...args);
      });
    }

    const menu = [
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [
        splitMenuItem,
        { type: 'separator' },
        { label: 'Reload App', accelerator: 'CmdOrCtrl+R', click: () => {
          if ((state.active === 'scrollmind' && scroll) || (state.active === 'notemind' && note)) return;
          views.get(state.active)?.webContents.reload();
        } },
        { role: 'togglefullscreen' },
      ] }, { role: 'windowMenu' },
    ];
    suiteMenu = Menu.buildFromTemplate(isMac ? menu : menu.slice(1));
    Menu.setApplicationMenu(suiteMenu);
    showWindow();
  }).catch(error => { console.error(error); app.exit(1); });
}
