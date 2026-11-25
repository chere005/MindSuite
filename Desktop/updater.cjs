'use strict';

// MindSuite updates itself on macOS from ONE fixed feed: the generic electron-updater provider reads latest-mac.yml from the
// `MindSuiteDesktop-updates` release of the public MindSuite repository (build.publish writes that address into the app as
// Resources/app-update.yml). The github provider is not used on purpose: it follows the repository's "Latest" release, which
// moves between the suite's apps. Windows has no installer yet, so there is no Windows updater (docs/PUBLISH.md).
//
// Updates are asked for, never pushed: a look shortly after launch and every 12 hours, one prompt per version per launch, a
// download only after "Download", and the restart only after "Restart to Update". Before the download is handed to
// Squirrel.Mac, update-guard.cjs verifies the app inside it.

const { compareVersions, readSignature, verifyUpdateZip } = require('./update-guard.cjs');

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

/** Can this copy replace itself? Only a Developer ID signed, packaged arm64 Mac install in a place it can be swapped. */
function updateEligibility({ platform, arch = 'arm64', packaged, testing, feedOverride, hasFeedFile, bundle, signature }) {
  const signed = Boolean(signature?.developerId && !signature.adhoc && signature.team && signature.hardened);
  if (testing && !feedOverride) return { ok: false, why: 'Updates are off while testing.' };
  if (!packaged) return { ok: false, why: 'Updates are off in development builds.' };
  if (platform !== 'darwin') return { ok: false, why: 'MindSuite updates itself on macOS only.' };
  if (arch !== 'arm64') return { ok: false, why: 'MindSuite updates itself on Apple silicon only.' };
  if (!feedOverride && !hasFeedFile) return { ok: false, why: 'This copy has no update feed.' };
  if (typeof bundle !== 'string' || !bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return { ok: false, why: 'Move MindSuite to the Applications folder to update it.' };
  }
  if (!signed) return { ok: false, why: 'Only the Developer ID signed build updates itself.' };
  return { ok: true };
}

/** A loopback feed for tests only; any other address is ignored. */
function loopbackFeed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

/** The feed text electron-builder wrote into the packaged app must be the one fixed https address, nothing else. */
function checkFeedFile(text, expected) {
  const provider = /^provider:\s*(\S+)\s*$/m.exec(text)?.[1];
  const url = /^url:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (provider !== 'generic' || !url || url.replace(/\/+$/, '') !== expected.replace(/\/+$/, '') || !url.startsWith('https://')) {
    throw new Error(`The packaged app's update feed is not ${expected}.`);
  }
}

/**
 * electron-updater's macOS updater with one addition: the downloaded zip is verified BEFORE it is given to Squirrel.Mac.
 * A failure rejects the download, so nothing is staged. (updateDownloaded is the hand-off point of electron-updater 6.8.12,
 * the exact version package.json pins.)
 */
function guardedMacUpdater(MacUpdater, { verify, getRunning, notarized = 'required' }) {
  return class GuardedMacUpdater extends MacUpdater {
    async updateDownloaded(zipFileInfo, event) {
      const announced = this.updateInfoAndProvider?.info?.version;
      await verify(event.downloadedFile, { announced, running: getRunning(), notarized });
      return super.updateDownloaded(zipFileInfo, event);
    }
  };
}

const oneLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 300);

function createUpdater({
  autoUpdater, dialog, getWindow, version, install, log = () => {},
  setTimer = setTimeout, setRepeat = setInterval, clear = clearTimeout, firstCheckMs = FIRST_CHECK_MS,
}) {
  const putOff = new Set();
  let busy = false, downloading = null, ready = null, timers = [];

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = { info: text => log('info', text), warn: text => log('warn', text), error: text => log('error', text), debug: () => {} };
  autoUpdater.on('error', error => log('error', oneLine(error)));
  autoUpdater.on('update-downloaded', info => { ready = info.version; downloading = null; log('info', `downloaded ${info.version}`); });

  const say = (message, detail, buttons = ['OK']) => {
    const options = { type: 'info', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true };
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  async function offerRestart(next) {
    const { response } = await say(`MindSuite ${next} is ready`, 'Restart to finish updating. Your writing is saved first. Choose Later to keep working; the update stays ready until the next check.', ['Restart to Update', 'Later']);
    if (response === 0) install();
  }

  async function download(next) {
    downloading = autoUpdater.downloadUpdate();
    try {
      await downloading;
    } catch (error) {
      downloading = null;
      log('error', `download failed: ${oneLine(error)}`);
      await say('MindSuite could not download the update', oneLine(error));
      return;
    }
    if (ready) await offerRestart(next);
  }

  async function check({ manual = false } = {}) {
    if (ready) { if (manual) await offerRestart(ready); return; }
    if (downloading) { if (manual) await say('Downloading the update', 'MindSuite will offer to restart when it finishes.'); return; }
    if (busy) return;
    busy = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      const next = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || !next || !(compareVersions(next, version) > 0)) {
        log('info', `up to date at ${version}`);
        if (manual) await say('MindSuite is up to date', `You have the latest version, ${version}.`);
        return;
      }
      if (!manual && putOff.has(next)) return;
      const { response } = await say(`MindSuite ${next} is available`, `You have ${version}. Download the update now? It installs when you restart, and your writing is saved first.`, ['Download', 'Later']);
      if (response !== 0) { putOff.add(next); return; }
      busy = false;
      await download(next);
    } catch (error) {
      log('error', `check failed: ${oneLine(error)}`);
      if (manual) await say('MindSuite could not check for updates', oneLine(error));
    } finally {
      busy = false;
    }
  }

  return {
    check,
    start() {
      timers = [setTimer(() => { void check(); }, firstCheckMs), setRepeat(() => { void check(); }, CHECK_EVERY_MS)];
      for (const timer of timers) timer?.unref?.();
    },
    quitAndInstall: (forceRunAfter = true) => autoUpdater.quitAndInstall(false, forceRunAfter),
    dispose() { for (const timer of timers) clear(timer); timers = []; },
  };
}

module.exports = {
  updateEligibility, loopbackFeed, checkFeedFile, guardedMacUpdater, createUpdater, readSignature, verifyUpdateZip,
  FIRST_CHECK_MS, CHECK_EVERY_MS,
};
