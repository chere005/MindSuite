/**
 * The Reports tab, phone and wide, editable and read-only.
 *
 * Every expected figure is DERIVED from core's own report functions over the
 * same seeded ledger, so this checks that the screen shows what core says —
 * the arithmetic itself is core's suite (packages/core/test/reports*.test.ts).
 */
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  CK_FIELD, CK_RECORD_NAME, formatAmount, incomeExpense, parseStore, periodLabel, periodRange, reportRows,
  spendingBreakdown, spendingTrend, today, type Store,
} from '@acctmind/core';
import { stored, withStore } from './helpers';
import { reportsLedger } from './reports-data';

const ledger = (): Store => {
  const r = parseStore(reportsLedger());
  if (!r.ok) throw new Error('the reports fixture does not parse');
  return r.store;
};
const figures = (accounts: string[] | null = null) => {
  const store = ledger();
  const rows = reportRows(store);
  const day = today();
  const range = periodRange('last-12', day, rows);
  const scope = { range, accounts, category: null };
  return {
    store, rows, range, label: periodLabel('last-12', range),
    breakdown: spendingBreakdown(rows, scope, store),
    trend: spendingTrend(rows, scope, store),
    flow: incomeExpense(rows, scope),
  };
};

/** Open the seeded ledger on the Reports tab; returns the ledger as saved before Reports opened. */
async function openReports(page: Page): Promise<string> {
  await withStore(page, reportsLedger());
  await expect(page.getByTestId('title')).toBeVisible();
  const before = JSON.stringify(await stored(page));
  await page.getByTestId('tab-reports').click();
  await expect(page.getByTestId('reports-title')).toBeVisible();
  return before;
}

test.describe('phone', () => {
  test('opens on Last 12 months of spending by group, and a group opens its lines', async ({ page }) => {
    const f = figures();
    const before = await openReports(page);
    await expect(page.getByTestId('report-period-label')).toHaveText(f.label);
    await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(f.breakdown.total));
    const rows = page.getByTestId('report-row');
    await expect(rows).toHaveCount(f.breakdown.groups.length);
    const top = f.breakdown.groups[0]!;
    await expect(rows.first().getByTestId('report-row-name')).toHaveText(top.name);
    await expect(rows.first().getByTestId('report-row-amount')).toHaveText(formatAmount(top.amount));

    // Drill into the biggest group: its lines, its total.
    await rows.first().click();
    await expect(page.getByTestId('report-drill-back')).toBeVisible();
    await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(top.amount));
    await expect(rows).toHaveCount(top.lines.length);
    await page.getByTestId('report-drill-back').click();
    await expect(rows).toHaveCount(f.breakdown.groups.length);
    // Reports write nothing: the ledger on the device is as it was before they opened.
    expect(JSON.stringify(await stored(page))).toBe(before);
  });

  test('trends and income vs expense, by month and by year', async ({ page }) => {
    const f = figures();
    await openReports(page);
    await page.getByTestId('report-tab-trends').click();
    await expect(page.getByTestId('report-trend-chart')).toBeVisible();
    await expect(page.getByTestId('report-trend-total')).toHaveText(formatAmount(f.trend.total));
    await expect(page.getByTestId('report-trend-average')).toHaveText(formatAmount(f.trend.average));
    await expect(page.getByTestId('report-trend-row')).toHaveCount(12);

    await page.getByTestId('report-tab-flow').click();
    await expect(page.getByTestId('report-flow-chart')).toBeVisible();
    await expect(page.getByTestId('report-flow-income')).toHaveText(formatAmount(f.flow.total.income));
    await expect(page.getByTestId('report-flow-spending')).toHaveText(formatAmount(f.flow.total.spending));
    await expect(page.getByTestId('report-flow-net')).toHaveText(formatAmount(f.flow.total.net));
    await expect(page.getByTestId('report-flow-row')).toHaveCount(12);
    await page.getByTestId('report-flow-by-year').click();
    await expect(page.getByTestId('report-flow-row')).toHaveCount(f.flow.years.length);
    await expect(page.getByTestId('report-flow-row-total')).toContainText(formatAmount(f.flow.total.net));
  });

  test('period, account and category controls narrow the figures', async ({ page }) => {
    await openReports(page);
    await page.getByTestId('report-period-this-month').click();
    const store = ledger();
    const rows = reportRows(store);
    const month = periodRange('this-month', today(), rows);
    await expect(page.getByTestId('report-period-label')).toHaveText(periodLabel('this-month', month));
    await page.getByTestId('report-period-last-12').click();

    const card = figures(['a-cc']);
    await page.getByTestId('report-account-a-cc').click();
    await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(card.breakdown.total));
    await page.getByTestId('report-account-all').click();

    await page.getByTestId('report-tab-trends').click();
    await page.getByTestId('report-category').click();
    await page.getByTestId('report-category-option').filter({ hasText: 'Food' }).click();
    const food = spendingTrend(rows, { range: card.range, accounts: null, category: { group: 'c-food' } }, store);
    await expect(page.getByTestId('report-trend-total')).toHaveText(formatAmount(food.total));
    await expect(page.getByTestId('report-category')).toContainText('Food');
  });
});

/* ---------------- wide ---------------- */

const capped = async (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="reports"]') as HTMLElement | null;
  const main = document.querySelector('[data-testid="wide-main"]') as HTMLElement | null;
  return {
    width: el?.getBoundingClientRect().width ?? 0,
    docOver: document.documentElement.scrollWidth - window.innerWidth,
    mainOver: main ? main.scrollWidth - main.clientWidth : 0,
  };
});

test.describe('wide', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium'); });

  test.describe('1000 px', () => {
    test.use({ viewport: { width: 1000, height: 800 } });
    test('a Reports item beside Budget and Transactions opens the reports in the main pane', async ({ page }) => {
      const f = figures();
      await withStore(page, reportsLedger());
      await page.getByTestId('wide-nav-reports').click();
      await expect(page.getByTestId('wide-reports')).toBeVisible();
      await expect(page.getByTestId('wide-title')).toHaveText('Reports');
      await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(f.breakdown.total));
      await expect(page.getByTestId('report-donut')).toBeVisible();
      const o = await capped(page);
      expect(o.docOver).toBeLessThanOrEqual(0);
      expect(o.mainOver).toBeLessThanOrEqual(0);
      await page.getByTestId('report-tab-flow').click();
      await expect(page.getByTestId('report-flow-chart')).toBeVisible();
      expect((await capped(page)).mainOver).toBeLessThanOrEqual(0);
    });
  });

  test.describe('2000 px', () => {
    test.use({ viewport: { width: 2000, height: 1000 } });
    test('the reports stop at a reading width instead of stretching', async ({ page }) => {
      await withStore(page, reportsLedger());
      await page.getByTestId('wide-nav-reports').click();
      await expect(page.getByTestId('report-donut')).toBeVisible();
      expect((await capped(page)).width).toBeLessThanOrEqual(1040);
      await page.getByTestId('report-tab-trends').click();
      const chart = (await page.getByTestId('report-trend-chart').boundingBox())!;
      expect(chart.width).toBeLessThanOrEqual(920);
    });
  });
});

/* ---------------- read-only ---------------- */

/** A signed-in stand-in CloudKit holding `ledger` — the phone's copy, which a browser only reads. */
async function asCopy(page: Page, raw: string): Promise<void> {
  const record = deflateRawSync(Buffer.from(raw, 'utf8')).toString('base64');
  await page.route('**/cdn.apple-cloudkit.com/**', (r) => r.abort());
  await page.addInitScript(({ record, name, field }) => {
    (window as unknown as Record<string, unknown>).CloudKit = {
      configure() {},
      getDefaultContainer() {
        return {
          async setUpAuth() { return { userRecordName: '_me' }; },
          whenUserSignsIn() { return new Promise<void>(() => {}); },
          whenUserSignsOut() { return new Promise<void>(() => {}); },
          privateCloudDatabase: {
            async fetchRecords(names: string[]) {
              if (names[0] !== name) return { hasErrors: true, errors: [{ serverErrorCode: 'NOT_FOUND' }], records: [] };
              return { hasErrors: false, errors: [], records: [{ fields: { [field]: { value: record } }, modified: { timestamp: Date.now() - 3600_000 } }] };
            },
          },
        };
      },
    };
  }, { record, name: CK_RECORD_NAME, field: CK_FIELD });
}

test.describe('read-only (the phone\'s copy through CloudKit)', () => {
  test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium'); });
  test.use({ baseURL: 'http://acct.example.com:8791/AcctMind/' });   // mapped in playwright.config.ts

  test.describe('phone width', () => {
    test.use({ viewport: { width: 420, height: 860 } });
    test('the Reports tab reads the copy the same way, under the banner', async ({ page }) => {
      const f = figures();
      await asCopy(page, reportsLedger());
      await page.goto('./');
      await page.getByTestId('tab-reports').click();
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(f.breakdown.total));
      await page.getByTestId('report-tab-flow').click();
      await expect(page.getByTestId('report-flow-net')).toHaveText(formatAmount(f.flow.total.net));
      expect(await stored(page)).toBeNull();
    });
  });

  test.describe('wide', () => {
    test.use({ viewport: { width: 1280, height: 820 } });
    test('the sidebar Reports item works read-only', async ({ page }) => {
      const f = figures();
      await asCopy(page, reportsLedger());
      await page.goto('./');
      await page.getByTestId('wide-nav-reports').click();
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('report-spending-total')).toHaveText(formatAmount(f.breakdown.total));
      expect(await stored(page)).toBeNull();
    });
  });
});
