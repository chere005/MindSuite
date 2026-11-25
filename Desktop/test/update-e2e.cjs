'use strict';

// Real update test against a loopback feed, on scratch copies only (never /Applications):
//   node test/update-e2e.cjs --app <signed MindSuite.app> --feed <dir with latest-mac.yml and the zip> --to <x.y.z> [--reject] [--unnotarized-ok]
// Copies the app to a scratch folder, runs it hidden with MINDSUITE_SMOKE_ROOT against an http server on 127.0.0.1 that serves
// the feed folder, lets the real electron-updater and the real Squirrel.Mac do the work (answers: Download, Restart to Update),
// then reads the scratch copy back. With --reject the update must be refused by the guard and the copy must stay as it was.
// --unnotarized-ok sets MINDSUITE_UPDATE_UNNOTARIZED=1, honoured only with MINDSUITE_SMOKE_ROOT and a loopback feed.

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const appPath = resolve(option('--app') || '');
const feedDir = resolve(option('--feed') || '');
const target = option('--to');
const reject = args.includes('--reject');
if (!existsSync(appPath) || !existsSync(feedDir) || !target) { console.error('usage: update-e2e.cjs --app APP --feed DIR --to X.Y.Z [--reject] [--unnotarized-ok]'); process.exit(2); }

const version = app => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
// Squirrel.Mac's ShipIt is a launchd job named after the bundle id, with its state under the REAL ~/Library/Caches (a launchd job
// does not inherit HOME). A scratch copy has the same bundle id as the installed app, so remove exactly what this run created.
const SHIPIT_JOB = 'com.seancheren.mindsuite.ShipIt';
const shipItState = join(homedir(), 'Library/Caches', SHIPIT_JOB);
const jobExists = () => { try { return execFileSync('launchctl', ['list'], { encoding: 'utf8' }).split('\n').some(line => line.endsWith('\t' + SHIPIT_JOB)); } catch { return false; } };
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'mindsuite-update-e2e-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  mkdirSync(join(root, 'home'));
  const installed = join(root, 'Applications/MindSuite.app');
  mkdirSync(join(root, 'Applications'));
  execFileSync('ditto', [appPath, installed]);
  const from = version(installed);
  const jobBefore = jobExists(), stateBefore = existsSync(shipItState);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const file = join(feedDir, decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, ''));
    if (!readdirSync(feedDir).includes(file.slice(feedDir.length + 1))) { response.writeHead(404).end(); return; }
    const data = readFileSync(file);
    response.writeHead(200, { 'content-length': data.length }).end(data);
  });
  server.listen(18210, '127.0.0.1');
  await once(server, 'listening');
  let child;
  try {
    child = spawn(join(installed, 'Contents/MacOS/MindSuite'), [], {
      env: {
        // HOME is the scratch folder so electron-updater's download cache (~/Library/Caches) stays out of the real one
        ...process.env, HOME: join(root, 'home'), MINDSUITE_SMOKE_ROOT: root, MINDSUITE_UPDATE_FEED: 'http://127.0.0.1:18210/', MINDSUITE_UPDATE_ANSWERS: '0,0',
        ...(args.includes('--unnotarized-ok') && { MINDSUITE_UPDATE_UNNOTARIZED: '1' }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    child.stderr.on('data', chunk => { log += chunk; });
    const updateLog = () => { try { return readFileSync(join(root, 'profile/update.log'), 'utf8'); } catch { return ''; } };
    const exited = once(child, 'exit');
    if (reject) {
      for (let i = 0; i < 300 && !/download failed/.test(updateLog()); i++) await sleep(200);
      assert.match(updateLog(), /download failed: .*not notarized|download failed: .*Apple has not notarized/, 'the guard refused the download: ' + updateLog());
      child.kill('SIGTERM');
      await exited;
      assert.equal(version(installed), from, 'the copy was not touched');
      assert.doesNotMatch(updateLog(), /^\S+ info downloaded \d/m, 'nothing was handed to Squirrel.Mac');
      console.log(`The guard refused ${target} (${updateLog().split('\n').find(line => /download failed/.test(line)).split(' error ').pop()}); the copy stays ${from}.`);
    } else {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
      await exited;
      clearTimeout(timeout);
      for (let i = 0; i < 150 && version(installed) !== target; i++) await sleep(200); // ShipIt swaps after the app has quit
      assert.equal(version(installed), target, `the scratch copy is ${target} after the update; update.log:\n${updateLog()}\n${log}`);
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
      assert.match(updateLog(), /dialog MindSuite .* is available/);
      assert.match(updateLog(), /dialog MindSuite .* is ready/);
      assert.ok(requests.some(url => /latest-mac\.yml/.test(url)) && requests.some(url => /\.zip/.test(url)), requests.join(', '));
      console.log(`Real electron-updater + Squirrel.Mac update on a scratch copy: ${from} -> ${version(installed)}.`);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    server.close();
    // ShipIt may still be finishing; leave nothing of ours running or on disk
    await sleep(3000);
    if (!jobBefore && jobExists()) { try { execFileSync('launchctl', ['remove', SHIPIT_JOB]); } catch { /* already gone */ } }
    if (!stateBefore) rmSync(shipItState, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
