/**
 * The wide (desktop-size) layout: sidebar left of the main pane, the table,
 * the detail pane, the Mac quick entry, and read-only mode.
 *
 * READ-ONLY IS FORCED by installing a stand-in CloudKit that is signed in and
 * holds the ledger: a signed-in plain browser is reading the phone's copy, which
 * is exactly the case core's `ledgerAccess` makes read-only. Without a
 * stand-in the harness is a plain browser on 127.0.0.1 with its own local
 * ledger, which stays editable (every older spec relies on that).
 */
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { CK_FIELD, CK_RECORD_NAME } from '@acctmind/core';
import { stored, storedTxns, withStore } from './helpers';
import { wideLedger } from './wide-data';

// Layout checks run once, at desktop size.
test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium'); });

type Copy = { record?: string | Buffer; signedIn?: boolean };

/**
 * A stand-in CloudKit: signed in (or not) and holding `record` (a ledger's JSON, or
 * any text, deflated the way the phone packs it).
 */
async function asCopy(page: Page, ledger: string, o: Copy = {}): Promise<void> {
  const record = deflateRawSync(Buffer.from(o.record ?? ledger, 'utf8')).toString('base64');
  await page.route('**/cdn.apple-cloudkit.com/**', (r) => r.abort());
  await page.addInitScript(({ record, name, field, signedIn }) => {
    (window as unknown as Record<string, unknown>).CloudKit = {
      configure() {},
      getDefaultContainer() {
        return {
          async setUpAuth() {
            const slot = document.getElementById('acctmind-ck-sign-in');
            if (slot && !signedIn && slot.childElementCount === 0) {
              const b = document.createElement('div');
              b.className = 'apple-auth-button';
              b.onclick = () => { const w = window as unknown as { __signInClicks?: number }; w.__signInClicks = (w.__signInClicks ?? 0) + 1; };
              slot.appendChild(b);
            }
            return signedIn ? { userRecordName: '_me' } : null;
          },
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
  }, { record, name: CK_RECORD_NAME, field: CK_FIELD, signedIn: o.signedIn !== false });
}

/** CloudKit cannot be reached at all: the script never loads. */
async function offline(page: Page): Promise<void> {
  await page.route('**/cdn.apple-cloudkit.com/**', (r) => r.abort());
}

/** The browser's own saved ledger, as an older session would have left it. */
async function oldBrowserData(page: Page, raw: string): Promise<void> {
  await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), ['acctmind.store.v1', raw] as const);
}

const oldLedger = (): string => {
  const l = JSON.parse(wideLedger()) as { accounts: unknown[]; txns: unknown[] };
  l.accounts.push({ id: 'a-old', name: 'Old browser account', color: '#4c8bf0', order: 9, created: 1, updated: 1 });
  l.txns.push({ id: 'told', name: 'Old browser coffee', description: '', amount: -100, date: '2026-11-01', account: 'a-old', category: null, order: 0, created: 1, updated: 1 });
  return JSON.stringify(l);
};

/** A host that is not local, so a plain browser there is always read-only. */
const REAL_HOST = { baseURL: 'http://acct.example.com:8791/AcctMind/' };   // mapped in playwright.config.ts

const noOverflow = async (page: Page) => {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    main: (() => { const m = document.querySelector('[data-testid="wide-main"]') as HTMLElement | null; return m ? m.scrollWidth - m.clientWidth : 0; })(),
  }));
  expect(over.doc).toBeLessThanOrEqual(0);
  expect(over.main).toBeLessThanOrEqual(0);
};

test.describe('1280x820, editable', () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test('sidebar left of the main pane, no overflow, balance only for one account', async ({ page }) => {
    await withStore(page, wideLedger());
    await expect(page.getByTestId('wide-frame')).toBeVisible();
    const side = (await page.getByTestId('wide-sidebar').boundingBox())!;
    const main = (await page.getByTestId('wide-main').boundingBox())!;
    expect(side.x + side.width).toBeLessThanOrEqual(main.x + 0.5);
    expect(side.y).toBeLessThanOrEqual(main.y + 0.5);
    await expect(page.getByTestId('wide-sync')).toContainText('This browser only');

    // Budget is first: one compact totals line and status pills.
    await expect(page.getByTestId('wide-totals')).toContainText('Unassigned');
    await expect(page.getByTestId('wide-totals')).toContainText('Short of target');
    await expect(page.getByTestId('wide-tone').first()).toBeVisible();
    await noOverflow(page);

    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('col-account')).toBeVisible();
    await expect(page.getByTestId('col-balance')).toHaveCount(0);
    await expect(page.getByTestId('wide-foot')).toContainText('transactions');
    await noOverflow(page);

    await page.getByTestId('wide-account-a-chk').click();
    await expect(page.getByTestId('col-balance')).toBeVisible();
    await expect(page.getByTestId('col-account')).toHaveCount(0);
    await expect(page.getByTestId('wide-row-balance').first()).toBeVisible();
    await noOverflow(page);
  });

  test('a row opens in the detail pane, which saves and deletes', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    await page.getByTestId('wide-row').filter({ hasText: 'Paycheck' }).first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    const detail = (await page.getByTestId('wide-detail').boundingBox())!;
    const main = (await page.getByTestId('wide-main').boundingBox())!;
    expect(detail.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
    await expect(page.getByTestId('name-input')).toHaveValue('Paycheck');
    await page.getByTestId('name-input').fill('Salary');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Salary' })).toHaveCount(1);
    const before = (await storedTxns(page)).length;

    await page.getByTestId('wide-row').filter({ hasText: 'Salary' }).click();
    await page.getByTestId('delete-button').click();
    await page.getByTestId('delete-button').click();
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Salary' })).toHaveCount(0);
    expect((await storedTxns(page)).length).toBe(before);   // tombstoned, not removed
  });

  test('quick entry adds with Return and returns focus to the name', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('quick-name')).toBeFocused();
    await page.getByTestId('quick-name').fill('Bagel');
    await page.getByTestId('quick-category').fill('dining');
    await page.getByTestId('quick-amount').fill('3.50');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Bagel' })).toHaveCount(1);
    await expect(page.getByTestId('quick-name')).toBeFocused();
    await expect(page.getByTestId('quick-name')).toHaveValue('');
    // An invalid row says why and adds nothing.
    await page.getByTestId('quick-amount').fill('x');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('quick-error')).toBeVisible();
  });

  test('the Cleared checkbox in the table still flips and persists', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    const first = page.getByTestId('wide-row-cleared').first();
    const cleared = async () => ((await storedTxns(page)) as { name: string; date: string; cleared?: true }[])
      .filter((t) => t.name === 'Paycheck').sort((a, b) => b.date.localeCompare(a.date))[0]!.cleared === true;
    expect(await cleared()).toBe(false);
    await first.click();
    await expect.poll(cleared).toBe(true);
    await first.click();
    await expect.poll(cleared).toBe(false);
  });

  test('saving the editor keeps a Cleared tick made in the table meanwhile', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    const row = page.getByTestId('wide-row').filter({ hasText: 'Paycheck' }).first();
    await row.click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    const cleared = async () => ((await storedTxns(page)) as { name: string; date: string; cleared?: true }[])
      .filter((t) => t.name === 'Paycheck').sort((a, b) => b.date.localeCompare(a.date))[0]!.cleared === true;
    expect(await cleared()).toBe(false);
    await row.getByTestId('wide-row-cleared').click();     // beside the open editor
    await expect.poll(cleared).toBe(true);
    await page.getByTestId('name-input').fill('Salary');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Salary' })).toHaveCount(1);
    expect(await cleared.call(null)).toBe(true);           // still ticked: only the name was written
    const t = ((await storedTxns(page)) as { name: string; cleared?: true }[]).find((x) => x.name === 'Salary');
    expect(t?.cleared).toBe(true);
  });

  test('quick entry reads amounts like the editor, and refuses an unknown category', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-a-chk').click();
    const add = async (name: string, amount: string, category = '') => {
      await page.getByTestId('quick-name').fill(name);
      await page.getByTestId('quick-category').fill(category);
      await page.getByTestId('quick-amount').fill(amount);
      await page.getByTestId('quick-amount').press('Enter');
    };
    const amountOf = (name: string) => page.getByTestId('wide-row').filter({ hasText: name }).getByTestId('wide-row-amount');
    await add('Cents', '350');
    await expect(amountOf('Cents')).toHaveText('-$3.50');
    await add('Brackets', '(12.34)');
    await expect(amountOf('Brackets')).toHaveText('-$12.34');
    await add('Plus', '+350');
    await expect(amountOf('Plus')).toHaveText('+$3.50');

    // An unknown or ambiguous category adds nothing, says why, and keeps what was typed.
    await add('Lunch', '5', 'zzz');
    await expect(page.getByTestId('quick-error')).toContainText('No category matches "zzz"');
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Lunch' })).toHaveCount(0);
    await expect(page.getByTestId('quick-name')).toHaveValue('Lunch');
    await page.getByTestId('quick-category').fill('e');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('quick-error')).toContainText('matches');
    await page.getByTestId('quick-category').fill('');
    await page.getByTestId('quick-amount').press('Enter');
    await expect(page.getByTestId('wide-row-name').filter({ hasText: 'Lunch' })).toHaveCount(1);

    // Whole dollars (the cog) changes what bare digits mean, here as in the editor.
    await page.getByTestId('app-menu-button').click();
    await page.getByTestId('menu-whole').click();
    await page.getByTestId('app-menu-backdrop').click({ position: { x: 5, y: 5 } });
    await add('Whole', '350');
    await expect(amountOf('Whole')).toHaveText('-$350.00');
  });

  test('a negative target is refused, not clamped', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-line').filter({ hasText: 'Groceries' }).click();
    await page.getByTestId('line-target-input').fill('-5');
    await expect(page.getByTestId('line-target-error')).toContainText('negative');
    await page.getByTestId('line-save').click();
    await expect(page.getByTestId('line-detail')).toBeVisible();
    await page.getByTestId('line-target-input').fill('700');
    await page.getByTestId('line-save').click();
    await expect(page.getByTestId('line-detail')).toBeHidden();
    await expect(page.getByTestId('wide-line').filter({ hasText: 'Groceries' })).toContainText('$700.00');
  });

  test('a budget line opens its pane', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-line').filter({ hasText: 'Groceries' }).click();
    await expect(page.getByTestId('line-detail')).toBeVisible();
    await expect(page.getByTestId('line-name-input')).toHaveValue('Groceries');
    await expect(page.getByTestId('line-spending')).toContainText('Grocery');
    await page.getByTestId('line-cancel').click();
    await expect(page.getByTestId('line-detail')).toBeHidden();
  });
});

test.describe('1000x800: the pane opens over the main pane', () => {
  test.use({ viewport: { width: 1000, height: 800 } });
  test('backdrop and Esc close it', async ({ page }) => {
    await withStore(page, wideLedger());
    await page.getByTestId('wide-account-all').click();
    await page.getByTestId('wide-row').first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    await page.getByTestId('wide-detail-backdrop').click({ position: { x: 20, y: 300 } });
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await page.getByTestId('wide-row').first().click();
    await expect(page.getByTestId('txn-detail')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('txn-detail')).toBeHidden();
    await noOverflow(page);
  });
});

test.describe('read-only (the phone\'s copy through CloudKit)', () => {
  test.use(REAL_HOST);
  test.describe('wide', () => {
    test.use({ viewport: { width: 1280, height: 820 } });
    test('no add or edit controls, a banner, and a text detail pane', async ({ page }) => {
      await asCopy(page, wideLedger());
      await page.goto('./');
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('readonly-banner')).toContainText('Read-only');
      await expect(page.getByTestId('readonly-banner')).toContainText('iPhone');
      await expect(page.getByTestId('readonly-reload')).toBeVisible();
      // Read-only never seeds and never writes: only the copy's three accounts, no default
      // "Account", and nothing at all saved into the browser's ledger.
      await page.getByTestId('wide-account-all').click();
      await expect(page.locator('[data-testid^="wide-account-"]')).toHaveCount(4);
      const names = (await page.locator('[data-testid^="wide-account-"]').allInnerTexts()).map((t) => t.split('\n')[0]);
      expect(names).toEqual(['All accounts', 'Checking', 'Savings', 'Credit card']);
      expect(await stored(page)).toBeNull();
      await expect(page.getByTestId('wide-add-line')).toHaveCount(0);
      await page.getByTestId('wide-account-all').click();
      await expect(page.getByTestId('wide-row').first()).toBeVisible();
      await expect(page.getByTestId('quick-entry')).toHaveCount(0);
      await expect(page.getByTestId('wide-new')).toHaveCount(0);
      await expect(page.getByTestId('wide-row-cleared')).toHaveCount(0);
      await expect(page.getByTestId('wide-more-import')).toHaveCount(0);
      await page.getByTestId('wide-row').first().click();
      await expect(page.getByTestId('txn-detail-readonly')).toBeVisible();
      await expect(page.getByTestId('save-button')).toHaveCount(0);
      await expect(page.getByTestId('delete-button')).toHaveCount(0);
      await page.getByTestId('detail-close').click();
      await page.getByTestId('wide-nav-budget').click();
      await page.getByTestId('wide-line').first().click();
      await expect(page.getByTestId('line-detail-readonly')).toBeVisible();
      await expect(page.getByTestId('line-save')).toHaveCount(0);
    });
  });

  test.describe('phone width', () => {
    test.use({ viewport: { width: 420, height: 860 } });
    test('banner under the bar, no + and no pencil', async ({ page }) => {
      await asCopy(page, wideLedger());
      await page.goto('./');
      await expect(page.getByTestId('wide-frame')).toHaveCount(0);
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('add-button')).toHaveCount(0);
      await expect(page.getByTestId('budget-edit-toggle')).toHaveCount(0);
      await expect(page.getByTestId('undo-button')).toHaveCount(0);
      await page.getByTestId('tab-transactions').click();
      await expect(page.getByTestId('readonly-banner')).toBeVisible();
      await expect(page.getByTestId('edit-toggle')).toHaveCount(0);
      await expect(page.getByTestId('account-add-a-chk')).toHaveCount(0);
      // No selection circles, no pick bar, and Cleared is a plain tick, not a checkbox.
      await expect(page.getByTestId('txn-row').first()).toBeVisible();
      await expect(page.locator('[data-testid^="txn-pick-"]')).toHaveCount(0);
      await expect(page.getByTestId('picked-bar')).toHaveCount(0);
      await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await expect(page.getByText('Account', { exact: true })).toHaveCount(0);
      await page.getByTestId('tab-budget').click();
      await expect(page.getByTestId('budget-title')).toBeVisible();
      await expect(page.locator('[data-testid^="line-pick-"]')).toHaveCount(0);
      await expect(page.getByText(/\d+ selected/)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
    });
  });
});

test.describe('read-only states on a real host', () => {
  test.use({ ...REAL_HOST, viewport: { width: 1280, height: 820 } });

  test('old browser data neither shows nor gets written', async ({ page }) => {
    const old = oldLedger();
    await oldBrowserData(page, old);
    await asCopy(page, wideLedger());
    await page.goto('./');
    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('wide-row').first()).toBeVisible();
    await expect(page.getByText('Old browser coffee')).toHaveCount(0);
    await expect(page.getByText('Old browser account')).toHaveCount(0);
    await expect(page.getByTestId('wide-foot')).toContainText('36 transactions');
    // The editable ledger key is exactly what the old session left.
    expect(await page.evaluate(() => localStorage.getItem('acctmind.store.v1'))).toBe(old);
  });

  test('offline with a cached copy: amber banner, the cached copy, still read-only', async ({ page }) => {
    const written = Date.now() - 2 * 86_400_000;
    await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string),
      ['acctmind.copycache.v1', JSON.stringify({ text: wideLedger(), writtenAt: written, cachedAt: written })] as const);
    await offline(page);
    await page.goto('./');
    await expect(page.getByTestId('readonly-banner-text')).toContainText("Couldn't reach iCloud; showing the copy from");
    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('wide-row').first()).toBeVisible();
    await expect(page.getByTestId('quick-entry')).toHaveCount(0);
    await expect(page.getByTestId('wide-new')).toHaveCount(0);
    await expect(page.getByTestId('readonly-reload')).toBeVisible();
    expect(await stored(page)).toBeNull();
    // Phone width: the same banner, no + button.
    await page.setViewportSize({ width: 420, height: 860 });
    await expect(page.getByTestId('readonly-banner-text')).toContainText("Couldn't reach iCloud");
    await expect(page.getByTestId('add-button')).toHaveCount(0);
  });

  test('offline with nothing cached: an empty read-only state that says so', async ({ page }) => {
    await oldBrowserData(page, oldLedger());
    await offline(page);
    await page.goto('./');
    await expect(page.getByTestId('readonly-banner-text')).toContainText('no saved copy');
    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('wide-empty')).toBeVisible();
    await expect(page.getByText('Old browser coffee')).toHaveCount(0);
    await expect(page.getByTestId('quick-entry')).toHaveCount(0);
    await page.setViewportSize({ width: 420, height: 860 });
    await expect(page.getByTestId('add-button')).toHaveCount(0);
  });

  test('an unparseable copy is an error, not an empty ledger "being read"', async ({ page }) => {
    await asCopy(page, '', { record: 'this is not a ledger' });
    await page.goto('./');
    const text = page.getByTestId('readonly-banner-text');
    await expect(text).toContainText("Your iPhone's copy couldn't be read (");
    await expect(text).not.toContainText("Reading your iPhone's copy");
    await expect(page.getByTestId('wide-sync')).toContainText('could not be read');
    await expect(page.getByTestId('readonly-reload')).toBeVisible();
    await page.setViewportSize({ width: 420, height: 860 });
    await expect(page.getByTestId('readonly-banner-text')).toContainText("couldn't be read");
    await expect(page.getByTestId('add-button')).toHaveCount(0);
  });

  test('Sign in starts Apple sign-in directly, without opening the menu', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await asCopy(page, wideLedger(), { signedIn: false });
    await page.goto('./');
    await page.getByTestId('readonly-signin').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __signInClicks?: number }).__signInClicks ?? 0)).toBe(1);
    await expect(page.getByTestId('menu-whole')).toHaveCount(0);
  });

  test('the wide menu does not repeat the sidebar, and offers an Apple ID row', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await asCopy(page, wideLedger(), { signedIn: false });
    await page.goto('./');
    await page.getByTestId('app-menu-button').click();
    await expect(page.getByTestId('menu-ck-sign-in')).toBeVisible();
    await expect(page.getByTestId('menu-export')).toHaveCount(0);
  });

  test('the budget table keeps its columns near the names at any width', async ({ page }) => {
    await asCopy(page, wideLedger());
    await page.goto('./');
    for (const width of [2000, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.getByTestId('wide-line').first()).toBeVisible();
      const t = await page.getByTestId('wide-table').boundingBox();
      const tone = await page.getByTestId('wide-tone').first().boundingBox();
      expect(t!.width).toBeLessThanOrEqual(900);
      expect(tone!.x + tone!.width).toBeLessThanOrEqual(t!.x + t!.width);
    }
  });

  test('the transactions table is capped too', async ({ page }) => {
    await page.setViewportSize({ width: 2000, height: 800 });
    await asCopy(page, wideLedger());
    await page.goto('./');
    await page.getByTestId('wide-nav-transactions').click();
    await expect(page.getByTestId('wide-row').first()).toBeVisible();
    expect((await page.getByTestId('wide-table').boundingBox())!.width).toBeLessThanOrEqual(1000);
  });

  test('the cog stays closed once it is closed, across tab switches', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await asCopy(page, wideLedger(), { signedIn: false });
    await page.goto('./');
    await page.getByTestId('app-menu-button').click();
    await expect(page.getByTestId('menu-whole')).toBeVisible();
    await page.getByTestId('app-menu-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('menu-whole')).toBeHidden();
    await page.getByTestId('tab-transactions').click();
    await expect(page.getByTestId('txn-scroll')).toBeVisible();
    await expect(page.getByTestId('menu-whole')).toBeHidden();
    await page.getByTestId('tab-budget').click();
    await expect(page.getByTestId('budget-title')).toBeVisible();
    await expect(page.getByTestId('menu-whole')).toBeHidden();
  });
});

test.describe('420 wide, editable: the phone layout is unchanged', () => {
  test.use({ viewport: { width: 420, height: 860 } });
  test('tab bar, + button and top bar, no wide frame', async ({ page }) => {
    await withStore(page, wideLedger());
    await expect(page.getByTestId('wide-frame')).toHaveCount(0);
    await expect(page.getByTestId('tab-budget')).toBeVisible();
    await expect(page.getByTestId('tab-transactions')).toBeVisible();
    await expect(page.getByTestId('add-button')).toBeVisible();
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
    await expect(page.getByTestId('edit-toggle')).toBeVisible();
    await page.getByTestId('tab-budget').click();
    await expect(page.getByTestId('budget-edit-toggle')).toBeVisible();
    await page.getByTestId('add-button').click();
    await expect(page.getByTestId('save-button')).toBeVisible();
    await expect(page.getByTestId('name-input')).toBeVisible();
  });
});
