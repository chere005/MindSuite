'use strict';

const electron = require('electron');
const { EventEmitter, once } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, extname, join, sep } = require('node:path');
const { compileFunction } = require('node:vm');
const { acquireLease } = require('./scroll-lease.cjs');

// The native preload and renderer run unchanged. Only NoteMind's main-process
// modules receive the suite's window, application lifecycle and IPC objects.
function loadMain(root, entry, bindings) {
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const original = createRequire(filename);
    function scopedRequire(specifier) {
      if (specifier === 'electron') return bindings.electron;
      if (specifier.startsWith('.')) {
        const resolved = original.resolve(specifier);
        if (resolved.startsWith(root + sep) && extname(resolved) === '.cjs') return load(resolved);
      }
      return original(specifier);
    }
    scopedRequire.resolve = original.resolve;
    const module = { exports: {}, filename };
    modules.set(filename, module);
    const run = compileFunction(readFileSync(filename, 'utf8'),
      ['require', 'module', 'exports', '__filename', '__dirname'],
      { filename, contextExtensions: [bindings.globals] });
    run(scopedRequire, module, module.exports, filename, dirname(filename));
    return module.exports;
  }
  return load(entry);
}

function noteIPC() {
  const handlers = new Map();
  const listeners = new EventEmitter();
  const contents = new Set();
  listeners.setMaxListeners(0);
  const check = (target, run) => (event, ...args) => {
    if (event.sender !== target || !event.senderFrame || event.senderFrame !== target.mainFrame) return;
    return run(event, ...args);
  };
  function forward(target, channel) {
    target.ipc.on(channel, check(target, (event, ...args) => listeners.emit(channel, event, ...args)));
  }
  const ipc = {
    handle(channel, run) {
      if (handlers.has(channel)) throw new Error('Duplicate NoteMind IPC handler: ' + channel);
      handlers.set(channel, run);
      for (const target of contents) target.ipc.handle(channel, check(target, run));
    },
    removeHandler(channel) {
      handlers.delete(channel);
      for (const target of contents) target.ipc.removeHandler(channel);
    },
    on(channel, run) {
      if (listeners.listenerCount(channel) === 0) {
        for (const target of contents) forward(target, channel);
      }
      listeners.on(channel, run);
    },
    removeListener(channel, run) {
      listeners.removeListener(channel, run);
      if (listeners.listenerCount(channel) === 0) {
        for (const target of contents) target.ipc.removeAllListeners(channel);
      }
    },
  };
  function own(target) {
    if (contents.has(target)) return;
    contents.add(target);
    target.once('destroyed', () => contents.delete(target));
    for (const [channel, run] of handlers) target.ipc.handle(channel, check(target, run));
    for (const channel of listeners.eventNames()) forward(target, channel);
  }
  return { ipc, own };
}

function preventable(emit) {
  let prevented = false;
  emit({ preventDefault() { prevented = true; }, get defaultPrevented() { return prevented; } });
  return prevented;
}

async function openNoteMind(parent, root, profile, { attach, detach, activate, closeSuite, menuChanged, splitMenuItem, updateMenuItem, testing }) {
  const { app, BrowserWindow, dialog, Menu, globalShortcut, session, WebContentsView } = electron;
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lease = await acquireLease(app, profile);
  if (!lease) throw new Error('NoteMind’s workspace is open in another window. Close it there and retry here.');

  const notesSession = session.fromPartition('persist:notemind-local');
  if (testing) notesSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: /^https?:/.test(details.url) }));
  const readyTasks = [];
  const shortcuts = new Set();
  const windows = new Map();
  const { ipc, own } = noteIPC();
  const scopedApp = new EventEmitter();
  scopedApp.setMaxListeners(0);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('NOTEMIND_')) delete env[key];
  if (testing) Object.assign(env, { NOTEMIND_DATA: profile, NOTEMIND_TEST_NO_PAD: '1', NOTEMIND_PEN: 'off' });
  const noteProcess = Object.create(process, {
    env: { value: env }, argv: { value: [process.execPath, '--workspace'] },
    execPath: { value: '/Applications/NoteMind.app/Contents/MacOS/NoteMind' },
  });

  let workspace, noteMenu, finishRequest, cleanupStarted = false, cleaned = false;
  const timers = new Set();
  const globals = {
    process: noteProcess,
    setTimeout(run, delay, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); run(...args); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  };
  const finished = Promise.withResolvers();

  function clearShortcuts() {
    for (const shortcut of shortcuts) globalShortcut.unregister(shortcut);
    shortcuts.clear();
  }
  function allowQuit() {
    if (cleaned) return;
    if (preventable(event => scopedApp.emit('before-quit', event))) return;
    cleanupStarted = true;
    if (preventable(event => scopedApp.emit('will-quit', event))) return;
    cleaned = true;
    clearShortcuts();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
    const exited = lease.exitCode === null && lease.signalCode === null ? once(lease, 'exit') : Promise.resolve();
    lease.stdin.end();
    exited.then(finished.resolve, finished.reject);
  }
  Object.assign(scopedApp, {
    getPath: key => key === 'userData' ? profile : app.getPath(key),
    setPath(key, path) {
      if (key !== 'userData' || path !== profile) throw new Error('The hosted NoteMind profile cannot change.');
    },
    getVersion: () => version,
    getAppPath: () => root,
    getAppMetrics: () => app.getAppMetrics(),
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => ({
      then(launch, onError) {
        const ready = app.whenReady().then(launch, onError);
        readyTasks.push(ready);
        return ready;
      },
    }),
    quit: allowQuit,
  });

  function track(window) {
    const contents = window.webContents;
    own(contents);
    windows.set(contents.id, window);
    const id = contents.id;
    window.once('closed', () => windows.delete(id));
    return window;
  }

  class NoteWorkspace extends EventEmitter {
    constructor(options) {
      super();
      this.view = new WebContentsView({ webPreferences: { ...options.webPreferences, session: notesSession } });
      this.webContents = this.view.webContents;
      this.id = this.webContents.id;
      this.view.setBackgroundColor(options.backgroundColor);
      this.events = [];
      const { x, y, width, height } = options;
      if ([x, y, width, height].every(Number.isFinite)) this.originalBounds = { x, y, width, height };
      for (const name of ['focus', 'blur']) this.forward(this.webContents, name);
      for (const name of ['move', 'resize', 'show', 'hide', 'minimize', 'restore']) this.forward(parent, name);
      this.webContents.on('did-create-window', child => track(child));
      attach(this.view);
    }
    forward(target, event) {
      const listener = () => this.emit(event);
      target.on(event, listener);
      this.events.push(() => target.removeListener(event, listener));
    }
    loadFile(file) {
      const loading = this.webContents.loadFile(file);
      loading.catch(() => {});
      return (this.loading = loading);
    }
    getContentBounds() {
      const area = parent.getContentBounds();
      const pane = this.view.getBounds();
      return { ...pane, x: area.x + pane.x, y: area.y + pane.y };
    }
    getBounds() { return this.getContentBounds(); }
    getNormalBounds() {
      return this.originalBounds || parent.getNormalBounds();
    }
    setBounds(bounds) {
      const pane = this.view.getBounds();
      parent.setPosition(bounds.x - pane.x, bounds.y - pane.y);
    }
    isDestroyed() { return this.destroyed === true || this.webContents.isDestroyed(); }
    isFocused() { return this.isVisible() && parent.isFocused() && this.webContents.isFocused(); }
    isVisible() { return parent.isVisible() && this.view.getVisible(); }
    isMinimized() { return parent.isMinimized(); }
    isMaximized() { return parent.isMaximized(); }
    minimize() { parent.minimize(); }
    maximize() { parent.maximize(); }
    unmaximize() { parent.unmaximize(); }
    restore() { parent.restore(); }
    setAutoHideMenuBar() {}
    setMenuBarVisibility() {}
    show() { if (!testing) { activate(); parent.show(); } }
    focus() { if (!testing) { activate(); parent.focus(); this.webContents.focus(); } }
    close() {
      if (!finishRequest) { closeSuite(); return; }
      if (this.isDestroyed()) return;
      this.webContents.setBackgroundThrottling(false);
      if (!preventable(event => this.emit('close', event))) this.destroy();
    }
    destroy() {
      if (this.isDestroyed()) return;
      this.destroyed = true;
      for (const stop of this.events) stop();
      detach(this.view);
      this.webContents.close();
      this.emit('closed');
      scopedApp.emit('window-all-closed');
    }
  }

  class NoteWindow {
    constructor(options) {
      if (!workspace && options.title === 'NoteMind') {
        workspace = track(new NoteWorkspace(options));
        return workspace;
      }
      const settings = { ...options, webPreferences: { ...options.webPreferences } };
      if (settings.parent === workspace) settings.parent = parent;
      if (!settings.webPreferences.partition) settings.webPreferences.session = notesSession;
      if (testing) settings.show = false;
      return track(new BrowserWindow(settings));
    }
    static fromWebContents(contents) { return windows.get(contents.id); }
    static getAllWindows() { return [...windows.values()]; }
  }

  const scopedDialog = Object.fromEntries(
    ['showMessageBox', 'showMessageBoxSync', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']
      .map(method => [method, (first, ...args) => {
        const closeWarning = method === 'showMessageBoxSync' && first === workspace && args[0]?.buttons?.[0] === 'Keep editing';
        if (testing && closeWarning) console.error('NoteMind fixture:', args[0]?.detail);
        const result = testing && closeWarning ? 0 : dialog[method](first instanceof NoteWorkspace ? parent : first, ...args);
        if (closeWarning && result === 0) {
          finishRequest?.reject(new Error('NoteMind is still saving.'));
          finishRequest = null;
        }
        return result;
      }]),
  );

  scopedDialog.showErrorBox = (title, content) => dialog.showErrorBox(title, content);

  try {
    loadMain(join(root, 'src'), join(root, 'src/main.cjs'), {
      globals,
      electron: {
        ...electron, app: scopedApp, BrowserWindow: NoteWindow, dialog: scopedDialog, ipcMain: ipc,
        session: { defaultSession: notesSession },
        Menu: {
          // NoteMind's own update items belong to the standalone app; here MindSuite updates as a whole.
          buildFromTemplate: template => Menu.buildFromTemplate(template.map(item => {
            if (item.label === 'Window') return { ...item, submenu: [splitMenuItem, { type: 'separator' }, ...item.submenu] };
            if (item.label === 'Help') {
              return { ...item, submenu: [...item.submenu.filter(entry => !/^Check for Updates/.test(entry.label || '')), updateMenuItem] };
            }
            return item;
          })),
          setApplicationMenu: menu => { noteMenu = menu; menuChanged(menu); },
          getApplicationMenu: () => noteMenu,
        },
        globalShortcut: {
          register(shortcut, fn) {
            if (testing || !globalShortcut.register(shortcut, fn)) return false;
            shortcuts.add(shortcut);
            return true;
          },
          unregisterAll: clearShortcuts,
        },
      },
    });
    await Promise.all(readyTasks);
    if (!workspace) throw new Error('The local NoteMind window did not initialize.');
    await workspace.loading;
  } catch (error) {
    clearShortcuts();
    if (workspace) workspace.destroy();
    else allowQuit();
    await finished.promise;
    throw error;
  }

  async function finish() {
    if (!finishRequest) {
      finishRequest = Promise.withResolvers();
      const resolve = finishRequest.resolve, reject = finishRequest.reject;
      finished.promise.then(resolve, reject);
    }
    const result = finishRequest.promise;
    if (workspace.isDestroyed() || cleanupStarted) allowQuit();
    else workspace.close();
    await result;
  }
  let lastLayout;
  function layout() {
    const visible = workspace.isVisible();
    const bounds = workspace.getBounds();
    if (lastLayout) {
      if (lastLayout.visible !== visible) workspace.emit(visible ? 'show' : 'hide');
      if (lastLayout.width !== bounds.width || lastLayout.height !== bounds.height) workspace.emit('resize');
      if (lastLayout.x !== bounds.x || lastLayout.y !== bounds.y) workspace.emit('move');
    }
    lastLayout = { ...bounds, visible };
  }
  return { view: workspace.view, finish, layout, get menu() { return noteMenu; } };
}

module.exports = { openNoteMind };
