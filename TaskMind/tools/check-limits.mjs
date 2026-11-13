// Fails when server/lib/limits.php is not exactly what tools/gen-limits.mjs writes from model.ts.
import { readFileSync } from 'node:fs';
import { render, target } from './gen-limits.mjs';

let actual = '';
try { actual = readFileSync(target, 'utf8'); } catch { /* reported below */ }
const expected = await render();
if (actual === expected) {
  console.log('server/lib/limits.php matches packages/core/src/model.ts.');
} else {
  const a = actual.split('\n'), e = expected.split('\n');
  let i = 0;
  while (i < Math.max(a.length, e.length) && a[i] === e[i]) i++;
  console.error(`Drift: server/lib/limits.php differs from model.ts at line ${i + 1}.`);
  console.error(`  file:      ${a[i] ?? '(missing)'}`);
  console.error(`  generated: ${e[i] ?? '(missing)'}`);
  console.error('Run: node tools/gen-limits.mjs');
  process.exit(1);
}
