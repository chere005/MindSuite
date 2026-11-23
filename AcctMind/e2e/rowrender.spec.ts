import { expect, test, type Page } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';
import { CK_FIELD, CK_RECORD_NAME } from '@acctmind/core';
import { dragGrip, pickSort, stored, withStore } from './helpers';

/**
 * A tap that concerns one row must not re-render the ledger.
 *
 * Two thousand rows are some eighty thousand components, and a tap on one
 * row's pick dot used to render all of them (half a second a tap, four
 * seconds at ten thousand rows). The rows are memoised now, and what keeps
 * them memoised is an invariant nothing on the screen shows: every prop a row
 * is handed is a primitive, a shared value or a function made once. One new
 * inline function in the list's loop turns this back into a full render, with
 * the same pixels and a tenth of the speed — so this counts RENDERS, not
 * pixels, on a ledger long enough that a whole-list render is unmistakable
 * (240 rows is about ten thousand components; a memoised tap is a few hundred).
 *
 * The counter is React's own devtools hook: it reports each commit, and a
 * function component that rendered carries the `PerformedWork` flag.
 *
 * CHROMIUM ONLY: the hook and the numbers are the same in WebKit, but the
 * suite's mobile project is WebKit-shaped Chromium anyway and the numbers
 * are renderer-independent, so one project is enough to pin them.
 */
test.skip(({ browserName }, _info) => browserName !== 'chromium', 'render counts');

const ROWS = 240;
/** A whole-list render of this ledger is ~10 000; a row's own tap is a few hundred. */
const MEMOISED = 1500;

const COUNTER = `
(() => {
  const isComp = (t) => t === 0 || t === 1 || t === 11 || t === 14 || t === 15;
  const P = window.__renders = { on: false, comps: 0, commits: 0 };
  const visit = (parent) => {
    const prev = parent.alternate;
    if (prev === null || parent.child === prev.child) return 0;
    let n = 0;
    for (let c = parent.child; c; c = c.sibling) {
      if (c.alternate === null) continue;
      if ((c.flags & 1) === 1 && isComp(c.tag)) n++;
      n += visit(c);
    }
    return n;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { this.renderers.set(1, r); return 1; },
    onCommitFiberRoot(_id, root) { if (!P.on) return; P.commits++; P.comps += visit(root.current); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  };
})();
`;

/**
 * Records every distinct count of drawn rows the page passes through, so a test
 * can see the list arrive in slices rather than all at once.
 */
const SLICES = `
(() => {
  const seen = window.__counts = [];
  const note = () => {
    const n = document.querySelectorAll('[data-testid="txn-row"],[data-testid="wide-row"]').length;
    if (n > 0 && seen[seen.length - 1] !== n) seen.push(n);
  };
  new MutationObserver(note).observe(document, { childList: true, subtree: true });
})();
`;

/** The same shape of ledger the screen draws, newest first within an account (core's date order). */
function expectedNames(account: 'A' | 'B'): string[] {
  const own = (JSON.parse(ledger()) as { txns: { name: string; date: string; created: number; account: string }[] }).txns
    .filter((t) => t.account === account);
  own.sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  return own.map((t) => t.name);
}

function ledger(rows: number = ROWS): string {
  const txns = Array.from({ length: rows }, (_, i) => ({
    id: `t${String(i).padStart(3, '0')}`, name: `Shop ${i}`, description: '', amount: -(100 + i),
    date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, account: i % 2 === 0 ? 'A' : 'B', category: null,
    order: rows - i, created: i + 1, updated: i + 1,
  }));
  return JSON.stringify({
    v: 4,
    accounts: [
      { id: 'A', name: 'Checking', color: '#4c8bf0', order: 0, created: 1, updated: 1 },
      { id: 'B', name: 'Savings', color: '#66d695', order: 1, created: 1, updated: 1 },
    ],
    categories: [], lines: [], budgets: [], txns,
  });
}

async function open(page: Page, rows: number = ROWS): Promise<void> {
  await page.addInitScript(COUNTER);
  await page.addInitScript(SLICES);
  await withStore(page, ledger(rows));
  // The list is drawn in slices; wait for the last row, not the first.
  await expect(page.getByTestId('txn-row')).toHaveCount(rows);
  await page.waitForTimeout(200);
}

/** Components re-rendered by `act`, once it and anything it set off have settled. */
async function renders(page: Page, act: () => Promise<void>): Promise<number> {
  await page.evaluate(() => { const r = (window as any).__renders; r.comps = 0; r.commits = 0; r.on = true; });
  await act();
  await page.waitForTimeout(400);
  return page.evaluate(() => { const r = (window as any).__renders; r.on = false; return r.comps as number; });
}

test('every row is drawn, in order, though the list is drawn in slices', async ({ page }) => {
  await open(page);
  const sections = page.getByTestId('account-section');
  expect(await sections.count()).toBe(2);
  // Each account holds exactly its own rows, in core's date order — the slices
  // must not put a row in the wrong account or shuffle the order they arrive in.
  expect(await sections.nth(0).getByTestId('txn-name').allTextContents()).toEqual(expectedNames('A'));
  expect(await sections.nth(1).getByTestId('txn-name').allTextContents()).toEqual(expectedNames('B'));

  // And the list really arrived in pieces: a first slice well short of the
  // whole, then more, ending at all of it. Returning `total` from
  // useProgressive would draw it in one go and fail here.
  const counts = await page.evaluate(() => (window as any).__counts as number[]);
  expect(counts[0], 'the first paint is a slice').toBeLessThan(ROWS / 2);
  expect(counts.length, 'more than one slice').toBeGreaterThan(1);
  expect(counts[counts.length - 1]).toBe(ROWS);
  expect([...counts].sort((a, b) => a - b), 'the count only grows').toEqual(counts);
});

test('picking, clearing and filing one row render a handful of components, not the ledger', async ({ page }) => {
  await open(page);

  const pick = await renders(page, () => page.getByTestId('txn-pick-t003').click());
  expect(pick, 'the pick dot').toBeLessThan(MEMOISED);
  await expect(page.getByTestId('txn-pick-t003')).toHaveAttribute('aria-label', 'Shop 3 selected');

  const clear = await renders(page, () => page.getByTestId('txn-cleared-t003').click());
  expect(clear, 'the cleared box').toBeLessThan(MEMOISED);
  expect(((await stored(page)) as { txns: { id: string; cleared?: boolean }[] }).txns.find((t) => t.id === 't003')!.cleared).toBe(true);

  const sortMenu = await renders(page, async () => {
    await page.getByTestId('sort-pick').click();
    await expect(page.getByTestId('sort-menu-backdrop')).toBeVisible();
  });
  expect(sortMenu, 'opening the sort menu').toBeLessThan(MEMOISED);
});

test('a long ledger is drawn in a few bounded slices, not one per hundred rows', async ({ page }) => {
  // A fixed step made the browser lay out everything drawn so far once per
  // slice: ten thousand rows spent more time in layout than drawing them in
  // one go. Slices grow with the list (to a cap), so the count of them grows
  // with its logarithm, and none is bigger than the cap.
  const LONG = 2000;
  await open(page, LONG);
  const counts = await page.evaluate(() => (window as any).__counts as number[]);
  expect(counts[counts.length - 1]).toBe(LONG);
  expect(counts[0], 'the first paint is a slice').toBeLessThan(150);
  // 2000 rows in steps of 150 would be 14 slices; growing steps are fewer.
  expect(counts.length, 'slices').toBeLessThanOrEqual(11);
  expect(counts.length, 'slices').toBeGreaterThan(2);
  const steps = counts.slice(1).map((n, i) => n - counts[i]!);
  expect(Math.max(...steps), 'no slice is bigger than the cap').toBeLessThanOrEqual(500);
});

/**
 * Edit mode shows controls on every row, so flipping it renders every row: a
 * second of work on a long ledger. That work is a transition (the page stays
 * alive), but the page must never SHOW a mixed state: the pencil's label, the
 * rows' controls and what a tap on a row does all change in one commit, and a
 * tap that lands while the rows are still the old mode's is dropped rather than
 * taken for the new one's.
 */
test.describe('edit mode never shows controls that disagree with the mode', () => {
  const WATCH = `
  (() => {
    const bad = window.__mixed = [];
    const check = () => {
      const label = document.querySelector('[data-testid="edit-toggle"]')?.getAttribute('aria-label');
      const actions = document.querySelectorAll('[data-testid="row-actions"]').length;
      const rows = document.querySelectorAll('[data-testid="txn-row"]').length;
      if (!label || rows === 0) return;
      const editing = label === 'Done editing';
      if (editing !== (actions > 0) || (actions > 0 && actions !== rows)) bad.push({ label, actions, rows });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  })();`;

  test('the label, the controls and the rows change in one commit, both ways', async ({ page }) => {
    await page.addInitScript(WATCH);
    await open(page);
    await page.getByTestId('edit-toggle').click();
    await expect(page.getByTestId('row-actions')).toHaveCount(ROWS);
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-label', 'Done editing');
    await page.getByTestId('edit-toggle').click();
    await expect(page.getByTestId('row-actions')).toHaveCount(0);
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-label', 'Edit rows');
    // And pressed twice at once, the last press wins and nothing is half done.
    await page.getByTestId('edit-toggle').dblclick();
    await page.waitForTimeout(600);
    await expect(page.getByTestId('row-actions')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__mixed), 'no frame mixed the two modes').toEqual([]);
  });

  test('a tap on a row while the rows still show the old mode is dropped', async ({ page }) => {
    await open(page);
    await page.getByTestId('edit-toggle').click();
    await expect(page.getByTestId('row-actions')).toHaveCount(ROWS);
    await page.waitForTimeout(300);
    const del = await page.getByTestId('row-delete').first().boundingBox();
    const clr = await page.getByTestId('txn-cleared-t000').boundingBox();
    expect(del).not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 25 });
    // Done is pressed; the rows go on showing delete buttons for a good while
    // (25x slower), and a tap on one of them lands in that window.
    await page.getByTestId('edit-toggle').click();
    await page.mouse.click(del!.x + del!.width / 2, del!.y + del!.height / 2);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-label', 'Edit rows');
    await expect(page.getByTestId('row-actions')).toHaveCount(0);
    await page.waitForTimeout(300);
    const txns = ((await stored(page)) as { txns: { deleted?: boolean }[] }).txns;
    expect(txns.filter((t) => t.deleted === true), 'nothing was deleted by the stale tap').toHaveLength(0);
    await expect(page.getByTestId('txn-row')).toHaveCount(ROWS);

    // The same window the other way: Edit is pressed and a tap on a cleared
    // box (what a tap does OUTSIDE edit mode) must not toggle it.
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 25 });
    await page.getByTestId('edit-toggle').click();
    if (clr !== null) await page.mouse.click(clr.x + clr.width / 2, clr.y + clr.height / 2);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await expect(page.getByTestId('row-actions')).toHaveCount(ROWS);
    const after = ((await stored(page)) as { txns: { id: string; cleared?: boolean }[] }).txns;
    expect(after.filter((t) => t.cleared === true), 'no row was cleared by the stale tap').toHaveLength(0);
  });

  test('choosing a row action still ends edit mode and does the action', async ({ page }) => {
    await open(page);
    await page.getByTestId('edit-toggle').click();
    await expect(page.getByTestId('row-actions')).toHaveCount(ROWS);
    await page.getByTestId('txn-row').filter({ has: page.getByText('Shop 5', { exact: true }) }).getByTestId('row-delete').click();
    await expect(page.getByTestId('txn-row')).toHaveCount(ROWS - 1);
    await expect(page.getByTestId('row-actions')).toHaveCount(0);
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-label', 'Edit rows');
    const deleted = ((await stored(page)) as { txns: { name: string; deleted?: boolean }[] }).txns.filter((t) => t.deleted === true);
    expect(deleted.map((t) => t.name)).toEqual(['Shop 5']);
  });
});

test('folding and unfolding an account does not re-render the other account', async ({ page }) => {
  await open(page);
  const head = page.getByTestId('account-head-A');

  const fold = await renders(page, () => head.click());
  expect(fold, 'folding Checking: its rows leave, Savings is not touched').toBeLessThan(MEMOISED);
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS / 2);

  // Unfolding MOUNTS the account's rows (that work is real); what must not
  // happen is a second render of the 120 rows that never moved.
  await head.click();
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS);
});

test('a new transaction at the top does not re-render the rows below it', async ({ page }) => {
  await open(page);
  const saved = await renders(page, async () => {
    await page.getByTestId('add-button').click();
    await page.getByTestId('name-input').fill('Newest');
    await page.getByTestId('amount-input').fill('450');
    await page.getByTestId('save-button').click();
    await expect(page.getByTestId('save-button')).toBeHidden();
  });
  expect(saved, 'save: the form, the new row and the totals, not every row').toBeLessThan(MEMOISED * 2);
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS + 1);
});

test('a search narrows the drawn list and clearing it brings every row back', async ({ page }) => {
  await open(page);
  await page.getByTestId('txn-search').fill('Shop 239');
  // Deferred: the box answers at once and the list follows.
  await expect(page.getByTestId('txn-search')).toHaveValue('Shop 239');
  await expect(page.getByTestId('txn-row')).toHaveCount(1);
  await page.getByTestId('txn-search-clear').click();
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS);
});

test('a search shows exactly the matching rows, and All then Delete takes exactly those', async ({ page }) => {
  await open(page);
  await page.getByTestId('txn-search').pressSequentially('Shop 17');
  // "Shop 17" and "Shop 170" to "Shop 179"; the deferred list must settle on the
  // final text, not an earlier keystroke's.
  await expect(page.getByTestId('txn-row')).toHaveCount(11);
  const names = await page.getByTestId('txn-name').allTextContents();
  expect(names.every((n) => n.startsWith('Shop 17'))).toBe(true);

  await page.getByTestId('picked-all').click();
  await expect(page.getByTestId('picked-count')).toContainText('11 selected');
  await page.getByTestId('picked-delete').click();
  await page.getByTestId('picked-delete').click();
  await expect(page.getByTestId('txn-row')).toHaveCount(0);
  const left = ((await stored(page)) as { txns: { name: string; deleted?: boolean }[] }).txns
    .filter((t) => t.deleted !== true);
  expect(left, 'only the eleven matches went').toHaveLength(ROWS - 11);
  expect(left.some((t) => t.name.startsWith('Shop 17'))).toBe(false);
  await page.getByTestId('txn-search-clear').click();
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS - 11);
});

test('the sort changes the drawn order, and a pick or edit toggle keeps it', async ({ page }) => {
  await open(page);
  const first = async () => page.getByTestId('account-section').nth(0).getByTestId('txn-name').first().textContent();
  expect(await first()).toBe(expectedNames('A')[0]);
  await pickSort(page, 'amount');
  // Largest absolute amount first: Shop 238 is the biggest in Checking.
  await expect(page.getByTestId('account-section').nth(0).getByTestId('txn-name').first()).toHaveText('Shop 238');
  await page.getByTestId('txn-pick-t003').click();
  await expect(page.getByTestId('account-section').nth(0).getByTestId('txn-name').first()).toHaveText('Shop 238');
});

test.describe('a ledger longer than the first slice can still be dragged', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP touch events');

  test('a grip drag in custom order re-files the row once every row is drawn', async ({ page }) => {
    await open(page);
    await pickSort(page, 'custom');
    await page.getByTestId('edit-toggle').click();
    await expect(page.getByTestId('row-actions')).toHaveCount(ROWS);
    const grip = page.getByTestId('txn-row').filter({ hasText: 'Shop 0' }).first().getByTestId('row-grip');
    const onto = page.getByTestId('txn-row').filter({ hasText: 'Shop 4' }).first();
    // Custom order here is the stored order, biggest first: Shop 0, 2, 4, 6 in Checking.
    await dragGrip(page, grip, onto, 8);
    const orders = new Map(((await stored(page)) as { txns: { name: string; order: number }[] }).txns
      .map((t) => [t.name, t.order] as const));
    expect(orders.get('Shop 0')!, 'below Shop 4').toBeLessThan(orders.get('Shop 4')!);
    expect(orders.get('Shop 0')!, 'above Shop 6').toBeGreaterThan(orders.get('Shop 6')!);
  });
});

test.describe('read-only (a signed-in browser reading the phone\'s copy)', () => {
  test.use({ baseURL: 'http://acct.example.com:8791/AcctMind/' });   // mapped in playwright.config.ts

  test('an app-level change does not re-render the ledger', async ({ page }) => {
    const record = deflateRawSync(Buffer.from(ledger(), 'utf8')).toString('base64');
    await page.addInitScript(COUNTER);
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
    await page.goto('./');
    await page.getByTestId('tab-transactions').click();
    await expect(page.getByTestId('readonly-badge')).toBeVisible();
    await expect(page.getByTestId('txn-row')).toHaveCount(ROWS);
    await page.waitForTimeout(200);

    // Folding writes a preference in App: App renders, and the badge element it
    // builds is new. The rows read only the flag, so none of them follows.
    const fold = await renders(page, () => page.getByTestId('account-head-A').click());
    expect(fold, 'folding Checking in read-only mode').toBeLessThan(MEMOISED);
    await expect(page.getByTestId('txn-row')).toHaveCount(ROWS / 2);
  });
});

test.describe('the wide table', () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test('is drawn in slices, in order, and selecting a row does not re-render the table', async ({ page }) => {
    await page.addInitScript(COUNTER);
    await page.addInitScript(SLICES);
    await withStore(page, ledger());
    await page.getByTestId('wide-account-all').click();
    await expect(page.getByTestId('wide-row')).toHaveCount(ROWS);
    await page.waitForTimeout(200);
    const names = await page.getByTestId('wide-row-name').allTextContents();
    expect(new Set(names).size).toBe(ROWS);
    const expected = (JSON.parse(ledger()) as { txns: { name: string; date: string; created: number }[] }).txns
      .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created).map((t) => t.name);
    expect(names).toEqual(expected);
    const counts = await page.evaluate(() => (window as any).__counts as number[]);
    expect(counts[0], 'the first paint is a slice').toBeLessThan(ROWS / 2);
    expect(counts.length, 'more than one slice').toBeGreaterThan(1);

    const select = await renders(page, () => page.getByTestId('wide-row').nth(5).click());
    expect(select, 'selecting one row').toBeLessThan(MEMOISED);
  });
});
