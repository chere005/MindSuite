/**
 * Importing the same days a second time.
 *
 * The owner, 2026-09-18: "if it goes back enough days which it usually will..
 * check if any transactions no longer exist in the csv, or if any values need
 * to be modified (final amounts, whether it's cleared)."
 *
 * The matching itself is core's (`reconcileRows`, with its own vectors). What
 * is only checkable here is the WIRING: that the screen shows the three
 * counts before anything is written, that a removal takes a second press, and
 * that what lands in the store is what the screen said it would be — which is
 * the one thing a plan computed in two places can get wrong.
 */
import { expect, test, type Page } from '@playwright/test';
import { fresh, openMenu, stored } from './helpers';

type StoredTxn = { id: string; name: string; amount: number; date: string; deleted?: true; cleared?: true };
const live = async (page: Page): Promise<StoredTxn[]> =>
  ((await stored(page)) as { txns: StoredTxn[] }).txns.filter((t) => t.deleted !== true);

const HEAD = '"Date","Description","Amount","Status"';
const csv = (...lines: string[]): string => `${[HEAD, ...lines].join('\n')}\n`;

const DINNER = '09/16/2026","PURCHASE DINNER';
const APPLE = '09/15/2026","PURCHASE APPLE.COM';
const ZELLE = '09/14/2026","ZELLE FROM BOB ON 09/14 REF # WFCT0';

/** Pick the file and stop on the plan, without agreeing to it. */
async function load(page: Page, text: string): Promise<void> {
  // The import moved off the account heading into the cog menu — the owner,
  // 2026-09-21: "drop the import button next to the + button in
  // transactions."
  await openMenu(page);
  await page.getByTestId('menu-import').click();
  await expect(page.getByTestId('import-title')).toBeVisible();
  await page.setInputFiles('[data-testid="import-file"]', {
    name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('import-plan')).toBeVisible();
}

const FIRST = csv(
  `"${DINNER}","-50.00","Pending"`,
  `"${APPLE}","-8.93","Posted"`,
  `"${ZELLE}","3500.00","Posted"`,
);

async function dropFiles(page: Page, ...files: { name: string; text: string }[]): Promise<void> {
  const prevented = await page.evaluate((files) => {
    const dataTransfer = new DataTransfer();
    for (const { name, text } of files) dataTransfer.items.add(new File([text], name));
    const drag = { dataTransfer, bubbles: true, cancelable: true };
    return ['dragover', 'drop'].map((type) => {
      const event = new DragEvent(type, drag);
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }, files);
  expect(prevented).toEqual([true, true]);
}

test('dropping a CSV on the budget opens its import preview before writing anything', async ({ page }) => {
  await fresh(page);
  await page.getByTestId('tab-budget').click();
  await dropFiles(page, { name: 'statement.CSV', text: FIRST });
  await expect(page.getByTestId('import-title')).toBeVisible();
  await expect(page.getByTestId('import-filename')).toHaveText('statement.CSV');
  await expect(page.getByTestId('import-plan')).toHaveText('3 new');
  expect(await live(page)).toHaveLength(0);
  await page.getByTestId('import-replace').click();
  await expect(page.getByTestId('import-replace')).toContainText('Press again');

  await dropFiles(page, { name: 'short.csv', text: csv(`"${APPLE}","-8.93","Posted"`) });
  await expect(page.getByTestId('import-filename')).toHaveText('short.csv');
  await expect(page.getByTestId('import-plan')).toHaveText('1 new');
  await expect(page.getByTestId('import-replace')).toHaveText('Replace everything in this account');
  await page.getByTestId('import-add').click();
  await expect(page.getByTestId('import-title')).toBeHidden();
  expect((await live(page)).map(({ name }) => name)).toEqual(['Apple']);

  await openMenu(page);
  await page.getByTestId('menu-import').click();
  await expect(page.getByTestId('import-title')).toBeVisible();
  await expect(page.getByTestId('import-plan')).toBeHidden();
});

test('file drops leave a draft intact and ignore unsupported or ambiguous drops', async ({ page }) => {
  await fresh(page);
  await page.getByTestId('add-button').click();
  await page.getByTestId('name-input').fill('Unsaved draft');
  await dropFiles(page, { name: 'notes.txt', text: 'Notes' });
  await dropFiles(page, { name: 'one.csv', text: FIRST }, { name: 'two.csv', text: FIRST });
  await expect(page.getByTestId('import-title')).toBeHidden();

  await dropFiles(page, { name: 'statement.csv', text: FIRST });
  await expect(page.getByTestId('import-plan')).toHaveText('3 new');
  await page.getByTestId('import-close').click();
  await expect(page.getByTestId('import-title')).toBeHidden();
  await expect(page.getByTestId('name-input')).toHaveValue('Unsaved draft');
  expect(await live(page)).toHaveLength(0);
});

test('a second export of the same days settles, clears and removes', async ({ page }) => {
  await fresh(page);
  await load(page, FIRST);
  await expect(page.getByTestId('import-plan')).toHaveText('3 new');
  await page.getByTestId('import-add').click();
  expect(await live(page)).toHaveLength(3);

  // The bank has since: settled the dinner for more than it held, and
  // dropped the Zelle entirely. One row is new, one is untouched.
  //
  // The new row is dated the 14th on purpose — a file can only say a row is
  // gone from days it actually reaches, and without something on the 14th
  // this second export would not cover the day the Zelle sits on.
  await load(page, csv(
    `"${DINNER}","-60.00","Posted"`,
    `"${APPLE}","-8.93","Posted"`,
    '"09/14/2026","PURCHASE NEW THING","-10.00","Posted"',
  ));
  await expect(page.getByTestId('import-plan'))
    .toHaveText('1 new, 1 changed, 1 no longer in the file, 1 already here');

  // Both are LISTED, not just counted — a number on its own is something to
  // agree to blindly.
  await expect(page.getByTestId(/^import-changed-/)).toHaveText(/-\$50\.00 → -\$60\.00/);
  await expect(page.getByTestId(/^import-missing-/)).toContainText('$3,500.00');

  // A removal takes TWO presses. One press only arms it.
  await page.getByTestId('import-add').click();
  await expect(page.getByTestId('import-add')).toContainText('Press again');
  expect(await live(page)).toHaveLength(3);

  await page.getByTestId('import-add').click();
  await expect(page.getByTestId('import-title')).toBeHidden();

  const rows = await live(page);
  expect(rows.map((t) => t.name).sort()).toEqual(['Apple', 'Dinner', 'New Thing']);
  const dinner = rows.find((t) => t.name === 'Dinner');
  expect(dinner?.amount).toBe(-6000);
  expect(dinner?.cleared).toBe(true);
});

test('a plain second import with nothing to remove is still one press', async ({ page }) => {
  await fresh(page);
  await load(page, FIRST);
  await page.getByTestId('import-add').click();

  await load(page, csv(
    `"${DINNER}","-50.00","Pending"`,
    `"${APPLE}","-8.93","Posted"`,
    `"${ZELLE}","3500.00","Posted"`,
    '"09/16/2026","PURCHASE NEW THING","-10.00","Posted"',
  ));
  await expect(page.getByTestId('import-add')).toHaveText('Add 1 new transaction');
  await page.getByTestId('import-add').click();
  await expect(page.getByTestId('import-title')).toBeHidden();
  expect(await live(page)).toHaveLength(4);
});
