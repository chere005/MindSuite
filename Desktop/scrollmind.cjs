'use strict';

const { app, clipboard, dialog, ipcMain, screen, session, shell, WebContentsView } = require('electron');
const { once } = require('node:events');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { acquireLease } = require('./scroll-lease.cjs');

const changesWriting = new Set(['notebook:save', 'scroll:save-changes', 'scroll:open',
  'workspace:switch', 'workspace:new', 'workspace:rename', 'workspace:delete',
  'workspace:close', 'workspace:select']);

async function openScrollMind(window, root, dataDirectory, { testing = false } = {}) {
  const lease = await acquireLease(app, join(dataDirectory, 'App'));
  if (!lease) throw new Error('ScrollMind’s workspace is unavailable. If its standalone window is open, close it and retry here.');
  const channels = [];
  let store, view, pen, copy, copyTimer, closeReply, clipboardFixture = '';
  const main = file => require(join(root, 'src/main', file));
  const hasLease = () => lease.exitCode === null && lease.signalCode === null;
  async function release() {
    if (!hasLease()) return;
    const exited = once(lease, 'exit');
    lease.stdin.end();
    await exited;
  }

  try {
    const { validateSnapshot } = await import(pathToFileURL(join(root, 'src/core/model.mjs')).href);
    const { createDocumentWorkspaces } = main('documents.cjs');
    const { createDocumentIO } = main('document-io.cjs');
    const { createICloudCopy, iCloudDriveRoot } = main('icloud-copy.cjs');
    const cloud = testing ? null : iCloudDriveRoot(app.getPath('home'));
    copy = createICloudCopy({
      dataDirectory, iCloudRoot: cloud, target: cloud && join(cloud, 'ScrollMind'),
      prefsFile: join(dataDirectory, 'App/icloud-copy.json'),
      stateFile: join(dataDirectory, 'App/icloud-copy-state.json'),
    });
    store = createDocumentWorkspaces(dataDirectory, { validate: validateSnapshot });
    const documents = createDocumentIO({ getStore: () => store, getWindow: () => window, dataDirectory, testing });
    const localSession = session.fromPartition('mindsuite-scroll');
    localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    localSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file:|data:|blob:|devtools:)/.test(details.url) });
    });
    view = new WebContentsView({ webPreferences: {
      session: localSession, preload: join(root, 'src/main/preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
    } });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());

    function handle(channel, callback) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!hasLease() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
          throw new Error('The ScrollMind workspace is unavailable.');
        }
        const result = callback(...args);
        if (changesWriting.has(channel)) Promise.resolve(result).then(() => copy.changed(), () => {});
        return result;
      });
      channels.push(channel);
    }

    handle('notebook:load', () => store.load());
    handle('notebook:save', document => store.save(document));
    handle('scroll:save-changes', changes => {
      if (changes.scrollId && changes.scrollId !== store.workspaceState().activeId) {
        throw new Error('The active scroll changed before saving.');
      }
      return store.saveChanges(changes);
    });
    handle('scroll:open', () => documents.openDocument());
    handle('scroll:export', (format, options) => documents.exportDocument(format, options));
    const workspaceCommands = {
      state: 'workspaceState', switch: 'switchWorkspace', new: 'newScroll', select: 'selectScroll',
      close: 'closeScroll', delete: 'deleteScroll', rename: 'renameScroll',
    };
    for (const [channel, method] of Object.entries(workspaceCommands)) {
      handle('workspace:' + channel, (...args) => store[method](...args));
    }
    handle('clipboard:read', () => testing ? clipboardFixture : clipboard.readText());
    handle('clipboard:write', text => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) {
        throw new Error('The selection is too large to copy.');
      }
      if (testing) clipboardFixture = text;
      else clipboard.writeText(text);
    });
    handle('window:toggle-fullscreen', () => window.setFullScreen(!window.isFullScreen()));
    handle('window:leave-fullscreen', () => window.setFullScreen(false));
    handle('app:quit', () => window.close());
    handle('window:ready-to-close', result => closeReply?.(result?.error));
    handle('notebook:open-folder', async () => {
      const error = await shell.openPath(dataDirectory);
      if (error) throw new Error(error);
    });
    const { version } = require(join(root, 'version.json'));
    handle('app:info', () => ({ version, dataPath: store.filePath, testMode: testing }));
    handle('display:list', () => {
      const current = screen.getDisplayMatching(window.getBounds());
      return screen.getAllDisplays().map(display => ({
        id: display.id, label: display.label || `Display ${display.id}`, selected: display.id === current.id,
      }));
    });
    handle('display:move', id => {
      const display = screen.getAllDisplays().find(candidate => candidate.id === Number(id));
      if (!display) throw new Error('That display is no longer connected.');
      window.setFullScreen(false);
      window.setBounds(display.workArea);
    });

    await contents.loadFile(join(root, 'src/renderer/index.html'));
    const { createNativePen, pagePoint, RELEASED } = main('native-pen.cjs');
    if (!testing) {
      const { penAccessPrompt } = main('pen-access.cjs');
      let asked = false;
      copyTimer = setTimeout(() => { void copy.sync(); }, 20000);
      copyTimer.unref();
      pen = createNativePen({
        file: join(root, 'scroll-pen'),
        onAccess(status) {
          const prompt = penAccessPrompt(status);
          if (!prompt || asked || window.isDestroyed()) return;
          asked = true;
          void dialog.showMessageBox(window, {
            type: 'info', message: prompt.message, detail: prompt.detail.replaceAll('ScrollMind', 'MindSuite'),
            buttons: prompt.buttons, defaultId: 0, cancelId: 1, noLink: true,
          }).then(async ({ response }) => {
            if (prompt.opensSettings && response === 0) {
              await pen?.requestAccess();
              await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
            }
          }).catch(() => {});
        },
        onState: state => {
          if (!view.getVisible() || !window.isFocused() || contents.isDestroyed()) return;
          let point;
          if (Number.isFinite(state?.x) && Number.isFinite(state?.y)) {
            const display = screen.getAllDisplays().find(candidate => /wacom/i.test(candidate.label))
              || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
            const content = window.getContentBounds(), bounds = view.getBounds();
            point = pagePoint(state, display, { x: content.x + bounds.x, y: content.y + bounds.y }, contents.getZoomFactor());
            const out = point.clientX < 0 || point.clientY < 0
              || point.clientX >= bounds.width / contents.getZoomFactor()
              || point.clientY >= bounds.height / contents.getZoomFactor();
            if (out) return contents.send('pen:native', RELEASED);
          }
          contents.send('pen:native', { ...state, ...point });
        },
      });
      pen.start();
      const releasePen = () => { if (!contents.isDestroyed()) contents.send('pen:native', RELEASED); };
      window.on('blur', releasePen);
      contents.on('blur', releasePen);
      contents.once('destroyed', () => window.removeListener('blur', releasePen));
    }

    async function finish() {
      if (!contents.isDestroyed() && !contents.isCrashed()) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            closeReply = null;
            reject(new Error('ScrollMind is still saving. Try closing again.'));
          }, 10000);
          closeReply = error => {
            closeReply = null;
            clearTimeout(timer);
            if (error) reject(new Error(error));
            else resolve();
          };
          contents.send('app:before-close');
        });
      }
      await store.flush();
      await store.close();
      clearTimeout(copyTimer);
      await copy.flush().catch(() => {});
      copy.dispose();
      pen?.stop();
      for (const channel of channels) ipcMain.removeHandler(channel);
      await release();
    }
    return { view, finish };
  } catch (error) {
    pen?.stop();
    clearTimeout(copyTimer);
    for (const channel of channels) ipcMain.removeHandler(channel);
    await store?.close().catch(() => {});
    await copy?.flush().catch(() => {});
    copy?.dispose();
    view?.webContents.close();
    await release();
    throw error;
  }
}

module.exports = { openScrollMind };
