import { defineConfig } from '@playwright/test';
import { BASE, ORIGIN, PORT, phpEnv } from './e2e-shared/port';

/**
 * The web build against the suite's shared sign-in, in a real browser: one `php -S` serving the exported app, the real
 * CalMind API and the real /account/ page of the site checkout (e2e-shared/router.php). SEPARATE from the main config on
 * purpose, like the WebKit one: the gesture suite runs against a server with no site lib (the legacy sign-in), this one
 * against a server that follows the shared one.
 *
 *   CALMIND_SITE_LIB_TEST=<seancheren-site>/lib npm run test:e2e:shared
 */
export default defineConfig({
  testDir: './e2e-shared',
  // The same gate as the gesture suite: these specs drive apps/app/dist too.
  globalSetup: ['./e2e/freshness.ts', './e2e-shared/setup.ts'],
  outputDir: `test-results-shared-${PORT}`,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  webServer: {
    // opcache off: the API re-reads the scratch site config on every request, and the server's default of re-checking a changed
    // file every two seconds would hand a case the previous case's config.
    command: `php -d opcache.enable=0 -d opcache.enable_cli=0 -S 127.0.0.1:${PORT} e2e-shared/router.php`,
    env: { ...(process.env as Record<string, string>), ...phpEnv() },
    url: BASE,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
  use: {
    baseURL: ORIGIN,
    viewport: { width: 420, height: 900 },
    ...(process.env.CALMIND_CHROMIUM_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.CALMIND_CHROMIUM_EXECUTABLE_PATH } } : {}),
  },
});
