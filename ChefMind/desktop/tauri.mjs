// `tauri dev|build` with the CSP derived from EXPO_PUBLIC_API_URL (csp.mjs).
// Other subcommands pass straight through.
import { spawnSync } from 'node:child_process';
import { configuredApiUrl, tauriConfigOverride } from './csp.mjs';

const args = process.argv.slice(2);
if (args[0] === 'dev' || args[0] === 'build') {
  const o = tauriConfigOverride(configuredApiUrl());
  if (o) args.push('--config', JSON.stringify(o));
}
const r = spawnSync('npx', ['tauri', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
