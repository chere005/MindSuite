import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// A removed or renamed server/lib file must never linger in dist: start the protected side empty every time.
await rm('dist/protected', { recursive: true, force: true });
await cp('server/public', 'dist/public', { recursive: true, filter: (src) => !/(^|\/)\.DS_Store$/.test(src) });
await mkdir('dist/protected', { recursive: true });
await cp('server/lib', 'dist/protected/lib', { recursive: true, filter: (src) => !/(^|\/)\.DS_Store$/.test(src) });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
await writeFile('dist/public/PlanMind/build.txt', version + '\n');
// The store version this release reads and writes, straight from the model that limits.php is generated from. deploy.sh
// --rollback and the automatic rollback compare it with the marker the server keeps beside the data, so a release that
// cannot read what a newer one wrote is never switched to; deploy.sh's audit cross-checks it against the shipped limits.php.
const { STORE_VERSION } = await import(pathToFileURL(path.resolve('packages/core/src/model.ts')).href);
if (!Number.isSafeInteger(STORE_VERSION) || STORE_VERSION < 1) throw new Error(`STORE_VERSION must be a positive integer, got ${STORE_VERSION}`);
await writeFile('dist/protected/lib/store-version.txt', STORE_VERSION + '\n');
console.log(`Packaged PlanMind ${version} (store version ${STORE_VERSION}); only app assets and protected code.`);
