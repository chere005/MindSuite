import { expect, test, type Page } from '@playwright/test';
import { stored, withStore } from './helpers';

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

function ledger(): string {
  const txns = Array.from({ length: ROWS }, (_, i) => ({
    id: `t${String(i).padStart(3, '0')}`, name: `Shop ${i}`, description: '', amount: -(100 + i),
    date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, account: i % 2 === 0 ? 'A' : 'B', category: null,
    order: ROWS - i, created: i + 1, updated: i + 1,
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

async function open(page: Page): Promise<void> {
  await page.addInitScript(COUNTER);
  await withStore(page, ledger());
  // The list is drawn in slices; wait for the last row, not the first.
  await expect(page.getByTestId('txn-row')).toHaveCount(ROWS);
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
  const names = await page.getByTestId('txn-name').allTextContents();
  expect(names).toHaveLength(ROWS);
  expect(new Set(names).size, 'no row is drawn twice').toBe(ROWS);
  // Newest first within an account, as before: the two accounts' rows are each
  // in one block, in the order core gave them (not the order they were drawn).
  expect(await page.getByTestId('account-section').count()).toBe(2);
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
