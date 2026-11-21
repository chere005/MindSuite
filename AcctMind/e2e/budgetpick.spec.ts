/**
 * Picking budget lines, and the three buttons that assign to them.
 *
 * The owner, 2026-09-21: "add the same selector for budget categories.. it
 * doesn't show a sum though, next to the all and clear buttons are '= 0'
 * which sets the category to 0, '= flag icon' which adds however much to
 * assigned to reach the amount needed, or '= up arrow' which brings the
 * amount assigned to match the sum of the transactions."
 *
 * The arrow became a green `$` the same day — "= up arrow should actually
 * just be = green $" — which changed the mark and nothing else about it.
 *
 * The ARITHMETIC of all three is core's — `assignedFor`, replayed from
 * `spec/budget.json`, and `assignMany` for where the answer lands. What is
 * only checkable here is the WIRING: that the flag button is wired to the
 * flag column, that a press writes THIS month rather than the line, that it
 * touches the picked lines and no others, and that the bar's own count is
 * about lines the screen is actually showing.
 */
import { expect, test, type Page } from '@playwright/test';
import { assignedIn, monthBudget, stored, withStore } from './helpers';

/** Today, as `YYYY-MM-DD`. The fixture's spending has to land in the month
 *  the tab opens on, because that is the only month it reads. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Three lines, each set up to answer a different button differently.
 *
 *   l1 Groceries — a target of $300, $50 assigned, $120 spent.
 *   l2 Coffee    — NO target, $25 assigned, $10 spent. The flag must leave
 *                  it exactly where it is; the other two must not.
 *   l3 Rent      — a target of $1000 and $1200 assigned, nothing spent. The
 *                  flag must not take the extra $200 away.
 */
const STORE = () => JSON.stringify({
  v: 4,
  accounts: [{ id: 'a1', name: 'Account', color: '#4c8bf0', order: 0, created: 1, updated: 1 }],
  categories: [{ id: 'c1', name: 'Food', color: '#66d695', order: 0, created: 1, updated: 1 }],
  lines: [
    { id: 'l1', name: 'Groceries', category: 'c1', budget: 0, needs: 30000, snoozed: false, order: 0, created: 1, updated: 1 },
    { id: 'l2', name: 'Coffee', category: 'c1', budget: 0, needs: 0, snoozed: false, order: 1, created: 1, updated: 1 },
    { id: 'l3', name: 'Rent', category: 'c1', budget: 0, needs: 100000, snoozed: false, order: 2, created: 1, updated: 1 },
  ],
  txns: [
    { id: 't1', name: 'Shop', amount: -12000, date: today(), account: 'a1', category: 'l1', order: 2, created: 1, updated: 1 },
    { id: 't2', name: 'Latte', amount: -1000, date: today(), account: 'a1', category: 'l2', order: 1, created: 1, updated: 1 },
  ],
  budgets: [monthBudget('l1', 5000), monthBudget('l2', 2500), monthBudget('l3', 120000)],
});

async function onBudget(page: Page): Promise<void> {
  await withStore(page, STORE());
  await page.getByTestId('tab-budget').click();
  await expect(page.getByTestId('budget-title')).toBeVisible();
}

const pick = (page: Page, id: string) => page.getByTestId(`line-pick-${id}`).click();

test('the bar is there before anything is picked, and says so', async ({ page }) => {
  // ChefMind's rule, carried over with the bar (the owner there, 2026-09-16): a
  // bar that appears only once something is picked is a count you cannot
  // read until after you have guessed at the control that produces it.
  await onBudget(page);
  await expect(page.getByTestId('budget-picked-bar')).toBeVisible();
  await expect(page.getByTestId('budget-picked-count')).toHaveText('0 selected');
});

test('the count is a COUNT — no sum, unlike the ledger', async ({ page }) => {
  // The owner, 2026-09-21: "it doesn't show a sum though." The ledger picks rows
  // in order to add them up; the budget picks them in order to assign to
  // them, and a fifth figure beside four money columns is one more number
  // to read past.
  await onBudget(page);
  await pick(page, 'l1');
  await pick(page, 'l2');
  await expect(page.getByTestId('budget-picked-count')).toHaveText('2 selected');
  await expect(page.getByTestId('budget-picked-count')).not.toContainText('$');
});

test('All picks every line, Clear puts them all back', async ({ page }) => {
  await onBudget(page);
  await page.getByTestId('budget-picked-all').click();
  await expect(page.getByTestId('budget-picked-count')).toHaveText('3 selected');
  await page.getByTestId('budget-picked-clear').click();
  await expect(page.getByTestId('budget-picked-count')).toHaveText('0 selected');
});

test('All reaches into a FOLDED category', async ({ page }) => {
  // The drag's flat list leaves a shut category's lines out, because a row
  // that renders nothing has no midpoint to drop against. A selection is a
  // different question, and `All` skipping whatever you happened to have
  // closed would be a button quietly doing something else.
  await onBudget(page);
  await page.getByTestId('category-head-c1').click();
  await expect(page.getByTestId('line-row-l1')).toBeHidden();
  await page.getByTestId('budget-picked-all').click();
  await expect(page.getByTestId('budget-picked-count')).toHaveText('3 selected');
});

test('nothing picked, nothing assigned — pressing the action buttons changes nothing', async ({ page }) => {
  /*
   * Delete's rule, for Delete's reason: a live control that does nothing is
   * the one that gets pressed twice.
   *
   * Asserted on BEHAVIOUR rather than on the disabled attribute. A
   * react-native-web Pressable is a div, and what `disabled` becomes on one
   * is a detail of that library — a check reading it would be about
   * react-native-web, and would keep passing if the handler started firing
   * on an empty selection anyway. What must be true is that nothing moves.
   */
  await onBudget(page);
  for (const id of ['zero', 'needs', 'spent', 'add-needs']) {
    await page.getByTestId(`budget-assign-${id}`).click({ force: true });
  }
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$50.00');
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
  await expect(page.getByTestId('line-budgeted-l3')).toHaveText('$1,200.00');
  expect(await assignedIn(page, 'l1')).toBe(5000);

  // And the aria the screen reader reads says the same.
  await expect(page.getByTestId('budget-assign-zero')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('budget-assign-add-needs')).toHaveAttribute('aria-disabled', 'true');
  await pick(page, 'l1');
  await expect(page.getByTestId('budget-assign-zero')).not.toHaveAttribute('aria-disabled', 'true');
});

function priorSet(): string {
  const prior = new Date();
  prior.setDate(1);
  prior.setMonth(prior.getMonth() - 1);
  return `m:${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}`;
}

test('= 0 adjusts the selected line until available is zero including carryover', async ({ page }) => {
  const set = priorSet();
  const store = JSON.parse(STORE());
  store.budgets.push({ ...monthBudget('l1', 2000), set, id: `${set}|l1` });
  await withStore(page, JSON.stringify(store));
  await page.getByTestId('tab-budget').click();
  await pick(page, 'l1');
  await page.getByTestId('budget-assign-zero').click();

  await expect(page.getByTestId('line-available-l1')).toHaveText('$0.00');
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$100.00');
  expect(await assignedIn(page, 'l1')).toBe(10000);
  // The other two were never picked and must not have moved.
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
  expect(await assignedIn(page, 'l3')).toBe(120000);
});

test('tapping a line opens its assignment actions independently of the selection', async ({ page }) => {
  await onBudget(page);
  await pick(page, 'l2');
  await page.getByTestId('line-name-l1').click();
  const menu = page.getByTestId('assignment-menu');
  await expect(menu.getByRole('heading')).toHaveText('Groceries');
  const scopedNeeds = page.getByTestId('scope-assign-needs');
  await expect(scopedNeeds).toHaveText('=');
  const flag = page.getByTestId('col-needs').locator('svg path').first();
  const stroke = await flag.getAttribute('stroke');
  const attribute = stroke === null ? 'fill' : 'stroke';
  await expect(scopedNeeds.locator('svg path').first()).toHaveAttribute(attribute, (await flag.getAttribute(attribute))!);
  await expect(menu.getByTestId('scope-assign-add-needs')).toHaveCount(0);
  await page.getByTestId('scope-assign-needs').click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$300.00');
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
  await expect(page.getByTestId('budget-picked-count')).toHaveText('1 selected');
});

test('+flag on the selection bar adds the full target to each selected line', async ({ page }) => {
  await onBudget(page);
  await pick(page, 'l1');
  await pick(page, 'l3');
  const addNeeds = page.getByTestId('budget-assign-add-needs');
  await expect(addNeeds).toHaveText('+');
  await addNeeds.click();
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$350.00');
  await expect(page.getByTestId('line-budgeted-l3')).toHaveText('$2,200.00');
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
});

test('a category action applies to its folded lines and leaves other categories alone', async ({ page }) => {
  const set = priorSet();
  const store = JSON.parse(STORE());
  store.categories.push({ ...store.categories[0], id: 'c2', name: 'Bills' });
  store.lines.find((line: { id: string }) => line.id === 'l3').category = 'c2';
  store.budgets.push({ ...monthBudget('l1', 2000), set, id: `${set}|l1` });
  await withStore(page, JSON.stringify(store));
  await page.getByTestId('tab-budget').click();
  await page.getByTestId('category-head-c1').click();
  await expect(page.getByTestId('line-budgeted-l1')).toBeHidden();

  await page.getByTestId('category-action-c1').click();
  await expect(page.getByTestId('assignment-menu').getByRole('heading')).toHaveText('Food');
  await page.getByTestId('scope-assign-zero').click();
  await expect(page.getByTestId('category-available-c1')).toHaveText('$0.00');
  expect(await assignedIn(page, 'l1')).toBe(10000);
  expect(await assignedIn(page, 'l2')).toBe(1000);
  expect(await assignedIn(page, 'l3')).toBe(120000);
  await expect(page.getByTestId('budget-picked-count')).toHaveText('0 selected');
});

test('right-clicking a budget row opens its assignment menu', async ({ page }) => {
  await onBudget(page);
  await page.getByTestId('line-spent-l1').click({ button: 'right' });
  await expect(page.getByTestId('assignment-menu').getByRole('heading')).toHaveText('Groceries');
  await expect(page.getByTestId('spent-preview-title')).toBeHidden();
  await page.getByTestId('scope-assign-spent').click();
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$120.00');
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
});

test('Spent explains which transactions and carryover cover a line this month', async ({ page }) => {
  const set = priorSet();
  const store = JSON.parse(STORE());
  store.lines.find((line: { id: string }) => line.id === 'l2').needs = 1000;
  store.txns.push({ ...store.txns[0], id: 'prior', date: `${set.slice(2)}-06`, amount: -70 });
  store.budgets = [
    ...store.budgets.filter((row: { line: string }) => row.line !== 'l2'),
    { ...monthBudget('l1', 2070), set, id: `${set}|l1` },
    { ...monthBudget('l2', 1000), set, id: `${set}|l2` },
  ];
  await withStore(page, JSON.stringify(store));
  await page.getByTestId('tab-budget').click();
  await page.getByTestId('line-spent-tap-l1').click();
  await expect(page.getByTestId('spent-preview-title')).toHaveText('Groceries');
  await expect(page.getByTestId('spent-preview-txn-t1')).toContainText('Shop');
  await expect(page.getByTestId('spent-preview-txn-t2')).toBeHidden();
  await expect(page.getByTestId('spent-preview-txn-prior')).toBeHidden();
  await expect(page.getByTestId('spent-preview-carryover')).toHaveText('$20.00');
  await expect(page.getByTestId('spent-preview-spent')).toHaveText('-$120.00');
  await expect(page.getByTestId('spent-preview-assign')).toHaveText('Set Assigned to $100.00');
  await page.getByTestId('spent-preview-assign').click();
  await expect(page.getByTestId('spent-preview-available')).toHaveText('$0.00');
  await expect(page.getByTestId('spent-preview-covered')).toBeVisible();
  expect(await assignedIn(page, 'l1')).toBe(10000);
  await page.getByTestId('spent-preview-close').click();
  await expect(page.getByTestId('spent-preview-close')).toBeHidden();

  await page.getByTestId('line-spent-tap-l2').click();
  await expect(page.getByTestId('spent-preview-title')).toHaveText('Coffee');
  await expect(page.getByTestId('spent-preview-carryover')).toHaveText('$10.00');
  await expect(page.getByTestId('spent-preview-assigned')).toHaveText('$0.00');
  await expect(page.getByTestId('spent-preview-available')).toHaveText('$0.00');
  await expect(page.getByTestId('spent-preview-covered')).toBeVisible();
  await page.getByTestId('spent-preview-close').click();
  await expect(page.getByTestId('spent-preview-close')).toBeHidden();
  await expect(page.getByTestId('line-available-l2')).toHaveCSS('color', 'rgb(48, 209, 88)');
  await pick(page, 'l2');
  await page.getByTestId('budget-assign-needs').click();
  expect(await assignedIn(page, 'l2')).toBe(0);
});

test('= flag ADDS up to the target, and never takes away', async ({ page }) => {
  await onBudget(page);
  await page.getByTestId('budget-picked-all').click();
  await page.getByTestId('budget-assign-needs').click();

  // Short of its $300 target: topped up to it.
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$300.00');
  // NO target at all. Zero is not a target, and a button that wiped this
  // line would be reading "no target" as "a target of nothing".
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$25.00');
  // Funded PAST its target. The flag adds; it does not level down.
  await expect(page.getByTestId('line-budgeted-l3')).toHaveText('$1,200.00');
});

test('= $ brings assigned to what actually moved', async ({ page }) => {
  await onBudget(page);
  await page.getByTestId('budget-picked-all').click();
  await page.getByTestId('budget-assign-spent').click();

  // Money out is negative in this ledger, so $120 spent is -12000 and the
  // assignment that matches it is 12000 — and the line is then exactly
  // level: nothing left, nothing over.
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$120.00');
  await expect(page.getByTestId('line-available-l1')).toHaveText('$0.00');
  await expect(page.getByTestId('line-budgeted-l2')).toHaveText('$10.00');
  // Nothing has moved through Rent, so matching it assigns nothing.
  await expect(page.getByTestId('line-budgeted-l3')).toHaveText('$0.00');
});

test('a press writes THIS MONTH, never the line', async ({ page }) => {
  // The whole of "budget changes are unique to that view only", from the
  // bulk side. `line.budget` is the All Time number and nothing on this
  // screen has drawn it since the view dropdown went; a bulk assign that
  // wrote there would look right on screen and be invisible next month.
  await onBudget(page);
  await pick(page, 'l1');
  await page.getByTestId('budget-assign-spent').click();
  await expect(page.getByTestId('line-budgeted-l1')).toHaveText('$120.00');

  const s = await stored(page) as { lines: { id: string; budget: number }[] };
  expect(s.lines.find((l) => l.id === 'l1')?.budget).toBe(0);
  expect(await assignedIn(page, 'l1')).toBe(12000);
});

test('there is NO Delete here — the ledger has one, this bar does not', async ({ page }) => {
  /*
   * The owner, 2026-09-21: "remove the delete button from the selection bar in
   * the budget page, but not the transactions page."
   *
   * Both halves, in one test, because the claim is a DIFFERENCE between two
   * screens sharing one component — and a change that removed the control
   * from the shared bar outright would satisfy half of it while breaking
   * the ledger, which nothing else here would notice.
   */
  await onBudget(page);
  await page.getByTestId('budget-picked-all').click();
  await expect(page.getByTestId('budget-picked-bar')).toBeVisible();
  await expect(page.getByTestId('budget-picked-all')).toBeVisible();
  // Not merely hidden: react-native-web leaves plenty in the DOM, so this
  // asks whether it was rendered at all.
  await expect(page.getByTestId('budget-picked-delete')).toHaveCount(0);

  // A line is still deletable one at a time, behind the pencil — the bar
  // was the bulk of it, not the only way.
  await page.getByTestId('budget-edit-toggle').click();
  await expect(page.getByTestId('line-delete-l1')).toBeVisible();

  await page.getByTestId('tab-transactions').click();
  await expect(page.getByTestId('picked-delete')).toBeVisible();
});

test('the No Category row has no selector, because there is no record', async ({ page }) => {
  // Every other control on that row is already withheld for the same
  // reason — no rename, no delete, no grip, no snooze, no pad.
  await withStore(page, JSON.stringify({
    v: 4,
    accounts: [{ id: 'a1', name: 'Account', color: '#4c8bf0', order: 0, created: 1, updated: 1 }],
    categories: [{ id: 'c1', name: 'Food', color: '#66d695', order: 0, created: 1, updated: 1 }],
    lines: [{ id: 'l1', name: 'Groceries', category: 'c1', budget: 0, needs: 0, snoozed: false, order: 0, created: 1, updated: 1 }],
    txns: [{ id: 't9', name: 'Unfiled', amount: -500, date: today(), account: 'a1', category: null, order: 1, created: 1, updated: 1 }],
    budgets: [],
  }));
  await page.getByTestId('tab-budget').click();
  await expect(page.getByTestId('line-row-none')).toBeVisible();
  await expect(page.getByTestId('line-pick-none')).toHaveCount(0);
  // And All still only picks the real line.
  await page.getByTestId('budget-picked-all').click();
  await expect(page.getByTestId('budget-picked-count')).toHaveText('1 selected');
});

test('the count and all four assignment buttons fit on a narrow screen', async ({ page }) => {
  /*
   * The bar carried three more controls than the ledger's and on a
   * 393-point phone it overran: the fixed widths and gaps came to 374, the
   * count is the one thing in there that shrinks, and what it shrank to was
   * `2…`. Delete went later the same day, which bought back 74 points — so
   * this now has room to spare rather than none, and it is kept because the
   * spacing that makes it fit still lives in two files (the bar's gap and
   * padding, the buttons' own) and a Delete could come back.
   *
   * Pinned at TWELVE selected, the widest count a budget realistically
   * shows — every digit is tabular, so 12 and 99 are the same width.
   */
  await page.setViewportSize({ width: 360, height: 800 });
  await withStore(page, JSON.stringify({
    v: 4,
    accounts: [{ id: 'a1', name: 'Account', color: '#4c8bf0', order: 0, created: 1, updated: 1 }],
    categories: [{ id: 'c1', name: 'Food', color: '#66d695', order: 0, created: 1, updated: 1 }],
    lines: Array.from({ length: 12 }, (_, i) => ({
      id: `l${i}`, name: `Line ${i}`, category: 'c1', budget: 0, needs: 0,
      snoozed: false, order: i, created: 1, updated: 1,
    })),
    txns: [], budgets: [],
  }));
  await page.getByTestId('tab-budget').click();
  await page.getByTestId('budget-picked-all').click();

  const count = page.getByTestId('budget-picked-count');
  await expect(count).toHaveText('12 selected');
  // Its own width against the width it was given. NOT scrollWidth: react-
  // native-web clamps a single-line Text, so those two stay equal whether or
  // not an ellipsis is drawn — see "A check that was DELETED" in TESTING.md.
  const { drawn, wanted } = await count.evaluate((el) => {
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.style.cssText = 'position:fixed;left:-9999px;width:auto;max-width:none;white-space:pre';
    document.body.appendChild(ghost);
    const w = ghost.getBoundingClientRect().width;
    ghost.remove();
    return { drawn: el.getBoundingClientRect().width, wanted: w };
  });
  expect(drawn).toBeGreaterThanOrEqual(wanted - 0.5);
  // The fourth assignment button fits beside the count.
  const bar = (await page.getByTestId('budget-picked-bar').boundingBox())!;
  const last = (await page.getByTestId('budget-assign-add-needs').boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
});

test("the bar's assignment buttons wear the marks of their respective columns", async ({ page }) => {
  /*
   * The owner named two of them by their column mark — "= flag icon", then "= up
   * arrow should actually just be = green $" — so the flag here has to be
   * the flag from the NEEDS head and the dollar the green one from
   * AVAILABLE, or the buttons stop saying what they do.
   *
   * Compared against the COLUMN HEADS rather than against a hex, because
   * the claim is that the two agree: repaint a column and this goes red
   * until the button is repainted with it.
   */
  await onBudget(page);
  const ink = (id: string) => page.locator(`[data-testid="${id}"] svg path`).first()
    .evaluate((el) => el.getAttribute('stroke') ?? el.getAttribute('fill'));

  expect(await ink('budget-assign-needs')).toBe(await ink('col-needs'));
  expect(await ink('budget-assign-add-needs')).toBe(await ink('col-needs'));
  expect(await ink('budget-assign-spent')).toBe(await ink('col-available'));
  // And NOT the red one, which is the mistake the pair of dollars invites.
  expect(await ink('budget-assign-spent')).not.toBe(await ink('col-spent'));
});
