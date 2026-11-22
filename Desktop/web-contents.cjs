'use strict';

const { shell } = require('electron');
const { origin } = require('./calmind.cjs');

function httpsURL(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url : null;
}

function isSuiteURL(value) { return httpsURL(value)?.origin === origin; }

function isApple(value) {
  const host = httpsURL(value)?.hostname || '';
  return ['apple.com', 'icloud.com', 'apple-cloudkit.com'].some(suffix => host === suffix || host.endsWith('.' + suffix));
}

function external(value) {
  const url = httpsURL(value);
  if (url) void shell.openExternal(url.href).catch(() => {});
}

const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

function lockWebContents(contents, { apple = false, testing = false } = {}) {
  function guard(event, mayOpen) {
    if (isSuiteURL(event.url) || (apple && isApple(event.url))) return;
    if (!event.isMainFrame && /^about:(blank|srcdoc)$/.test(event.url)) return;
    event.preventDefault();
    if (mayOpen && event.isMainFrame && !testing) external(event.url);
  }
  contents.on('will-frame-navigate', event => guard(event, true));
  contents.on('will-redirect', event => guard(event, false));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (!testing && (isSuiteURL(url) || (apple && isApple(url)))) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: preferences } };
    }
    if (!testing) external(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child, details) => lockWebContents(child.webContents, { apple: isApple(details.url) }));
}

function configurePermissions(session) {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowed.has(permission) && isSuiteURL(requestingOrigin));
  session.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowed.has(permission) && isSuiteURL(details.requestingUrl)));
}

module.exports = { configurePermissions, external, lockWebContents, preferences };
