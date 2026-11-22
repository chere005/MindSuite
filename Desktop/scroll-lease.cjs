'use strict';

const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');

const flag = '--mindsuite-scroll-lease';

// The helper uses the same Electron singleton as the standalone ScrollMind app.
// Holding it until the editor has flushed prevents two processes writing the workspace.
function runLease(app) {
  const profile = process.env.MINDSUITE_SCROLL_PROFILE;
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  if (!app.requestSingleInstanceLock()) {
    process.stdout.write('busy\n', () => app.exit(0));
    return;
  }
  process.stdout.write('locked\n');
  process.stdin.resume();
  process.stdin.once('end', () => app.exit(0));
}

function acquireLease(app, profile) {
  const args = app.isPackaged ? [flag] : [app.getAppPath(), flag];
  const child = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, MINDSUITE_SCROLL_PROFILE: profile },
  });
  child.stdin.on('error', () => {});
  return new Promise(resolve => {
    let output = '';
    function finish(result) {
      clearTimeout(timer);
      child.stdout.removeListener('data', receive);
      resolve(result);
    }
    function receive(chunk) {
      output += chunk;
      if (!output.includes('\n')) return;
      if (output.trim() === 'locked') finish(child);
      else { child.stdin.end(); finish(null); }
    }
    const timer = setTimeout(() => { child.stdin.end(); finish(null); }, 10000);
    child.stdout.on('data', receive);
    child.once('error', () => finish(null));
    child.once('exit', () => finish(null));
  });
}

module.exports = { flag, runLease, acquireLease };
