import { defineConfig } from '@playwright/test';

// Each run owns one port, so several worktrees can run e2e side by side: TASKMIND_E2E_PORT=8872 npm run test:e2e
const port = Number(process.env.TASKMIND_E2E_PORT || 8871);
if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error(`TASKMIND_E2E_PORT must be a port number, got "${process.env.TASKMIND_E2E_PORT}".`); }
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1360, height: 900 } } },
    // Phone runs every spec too: the shell has to fit 375x812.
    { name: 'phone', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node tools/preview.mjs', env: { TASKMIND_PORT: String(port) }, url: `${origin}/TaskMind/`, reuseExistingServer: false, timeout: 30000 },
});
