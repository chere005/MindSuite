import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Each run owns one port, so several worktrees can run e2e side by side: PLANMIND_E2E_PORT=5190 npm run test:e2e
const port = Number(process.env.PLANMIND_E2E_PORT || 5188);
if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error(`PLANMIND_E2E_PORT must be a port number, got "${process.env.PLANMIND_E2E_PORT}".`); }
const origin = `http://127.0.0.1:${port}`;
// CalMind's store the preview reads for the Day's CalMind events: a disposable directory of this run that e2e/calmind.spec.ts writes.
process.env.PLANMIND_E2E_CALMIND ??= path.join(os.tmpdir(), `planmind-e2e-calmind-${port}`);

export default defineConfig({
  testDir: './e2e', workers: 1, retries: 0, use: { baseURL: origin, browserName: 'chromium', trace: 'retain-on-failure' },
  projects: [
    // Desktop runs every spec except the phone-only ones (file names containing "phone").
    { name: 'desktop', use: { viewport: { width: 1360, height: 900 } }, testIgnore: /phone[^/]*\.spec\.ts$/ },
    // Phone runs planner.spec.ts (the shell on a phone), the account menu and dragging (which have a phone half) and the phone specs.
    { name: 'phone', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }, testMatch: /(planner|account|drag|entry-look|perf|[^/]*phone[^/]*)\.spec\.ts$/ },
    // WebKit (the engine of the iPhone app's WKWebView) covers schedule hit testing, mouse drags, the Month's scroll places and the all-day strip's grid layout. It is off unless asked for, because it needs
    // `npx playwright install webkit`: PLANMIND_E2E_WEBKIT=1 npx playwright test --project=webkit
    ...(process.env.PLANMIND_E2E_WEBKIT ? [{ name: 'webkit', use: { browserName: 'webkit' as const, viewport: { width: 1360, height: 900 } }, testMatch: /(drag|drag-owners|boundary-drag|entry-look|month-scroll|calmind-allday)\.spec\.ts$/ }] : []),
  ],
  webServer: { command: 'node tools/preview.mjs', env: { PLANMIND_PORT: String(port), PLANMIND_CALMIND_DIR: process.env.PLANMIND_E2E_CALMIND }, url: `${origin}/PlanMind/`, reuseExistingServer: false, timeout: 30000 },
});
