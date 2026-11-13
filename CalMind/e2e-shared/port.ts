/**
 * Where the shared sign-in harness lives. It has its own port (CALMIND_E2E_SHARED_PORT, default 8795), never one of the
 * gesture shards' (8790, 8793, 8794) or WebKit's (8791), so it can run beside none of them by accident.
 *
 * The scratch directories sit in the OS temp directory under a name made from the port, and the site lib is the checkout
 * named by CALMIND_SITE_LIB_TEST (the same variable server/tools/shared-login-test.php reads), else a seancheren-site
 * checkout beside this repository's. A run without one stops with an instruction: a shared sign-in spec that quietly
 * skipped would prove nothing.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const raw = process.env.CALMIND_E2E_SHARED_PORT || '8795';
if (!/^[0-9]+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
  throw new Error(`CALMIND_E2E_SHARED_PORT must be a port number, got '${raw}'`);
}
export const PORT = Number(raw);
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const BASE = `${ORIGIN}/calmind/`;
export const API = `${BASE}api/index.php`;
export const ACCOUNT = `${ORIGIN}/account/`;

/** The scratch directory of this port: CalMind's data, the site's data and the scratch site config. */
export const DIR = join(tmpdir(), `calmind-shared-e2e-${PORT}`);
export const CONFIG_FILE = join(DIR, 'site-config.php');

export const SITE_LIB = resolve(process.env.CALMIND_SITE_LIB_TEST || join(__dirname, '../../../seancheren-site/lib'));
if (!existsSync(join(SITE_LIB, 'mindsuite-site-auth.php'))) {
  throw new Error(`the shared sign-in specs need the site lib: set CALMIND_SITE_LIB_TEST to a seancheren-site lib directory (looked in ${SITE_LIB})`);
}

/** The key the app keeps its session under (the same derivation as apps/app/src/store.tsx's instanceTag). */
export const SESSION_KEY = `calmind.session@${API.replace(/^https?:\/\//, '').replace(/\/api\/index\.php$/, '').replace(/[^A-Za-z0-9.]+/g, '_')}`;
export const snapshotKey = (user: string) => SESSION_KEY.replace('calmind.session@', `calmind.snapshot.${user}@`);

/** The accounts planted in the shared store (placeholder ids). */
export const ACCOUNTS = { alex: 'alex-e2e-password', sam: 'sam-e2e-password' } as const;

/** The environment both the PHP server and the seed script run in. */
export function phpEnv(): Record<string, string> {
  return {
    CALMIND_DATA_DIR: join(DIR, 'calmind'),
    CALMIND_SITE_LIB: SITE_LIB,
    CALMIND_SITE_CONFIG: CONFIG_FILE,
    CALMIND_MEETREQ_USER: 'alex',
    SUITE_DATA_DIR: join(DIR, 'site'),
    SUITE_MINDSUITE_AUTH_TEST: '1',
  };
}
