import { spawnSync } from 'node:child_process';
import path from 'node:path';
export const php = process.env.PHP_BINARY || 'php';
const probe = spawnSync(php, ['-r', 'echo json_encode([PHP_BINARY, get_loaded_extensions()]);'], { encoding: 'utf8' });
if (probe.status !== 0) throw new Error('PHP 8.2+ is required.');
const [binary, modules] = JSON.parse(probe.stdout);
export const phpArgs = [];
for (const extension of ['openssl', 'mbstring']) {
  if (!modules.includes(extension)) phpArgs.push('-d', `extension=${process.platform === 'win32' ? path.join(path.dirname(binary), 'ext', `php_${extension}.dll`) : extension}`);
}
phpArgs.push('-d', 'display_errors=0', '-d', 'log_errors=1');
