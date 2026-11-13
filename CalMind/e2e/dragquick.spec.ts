/**
 * A QUICK drag lands where the row's centre was let go — the first drag on a
 * fresh list, and a drag straight after another.
 *
 * The grant measures every row, and react-native-web answers measureInWindow
 * from a setTimeout; a browser runs a queued pointer move before a timer, so
 * one quick move can shift the dragged row before its own measure is taken.
 * The measured midpoint then held the travel already, the drop added it
 * again, and the row overshot: one move of 2.4 rows landed three rows on, and
 * 0.6 of a row moved it one. A slow drag (the measure in long before the
 * first move) was right, which is why every slower spec passed.
 *
 * Each drag here is ONE mouse move between press and release, with no wait.
 * Distances are in row pitches (centre to centre): 2.4 passes two centres and
 * not a third; 0.6 passes none.
 */
import { test, expect, type Page } from '@playwright/test';

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `dq${Date.now()}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 20_000 });
  return user;
}

/** A fresh list a..e in General, in edit mode (where the grips are). */
async function freshList(page: Page) {
  await signup(page);
  await page.getByTestId('tab-reminders').click();
  for (const t of ['e', 'd', 'c', 'b', 'a']) {
    await page.getByTestId('secadd-General').first().click();
    await page.getByTestId('rem-add-field').fill(t);
    await page.getByTestId('rem-add-field').press('Enter');
  }
  await expect.poll(() => order(page)).toEqual(['a', 'b', 'c', 'd', 'e']);
  await editMode(page);
}

/** Hold a row: the way into edit mode, where the grips are. */
async function editMode(page: Page) {
  const body = (await page.getByTestId('rem-body').first().boundingBox())!;
  await page.mouse.move(body.x + 20, body.y + body.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect.poll(() => inEditMode(page)).toBe(true);
}

/** Out of edit mode the grips are still there, at opacity 0 and taking no pointer. */
const inEditMode = (page: Page) => page.getByTestId('row-grip').first().evaluate((e) => getComputedStyle(e).opacity !== '0');

const order = (page: Page) => page.getByTestId('rem-body').allTextContents();

/** Centre to centre of two neighbouring rows. */
async function pitch(page: Page): Promise<number> {
  const rows = page.getByTestId('rem-row');
  const a = (await rows.nth(0).boundingBox())!;
  const b = (await rows.nth(1).boundingBox())!;
  return b.y + b.height / 2 - (a.y + a.height / 2);
}

/** Press row `text`'s grip, ONE move of `rows` pitches, release at once. */
async function quickDrag(page: Page, text: string, rows: number) {
  const p = await pitch(page);
  const grip = page.getByTestId('rem-row').filter({ hasText: text }).first().getByTestId('row-grip');
  const gb = (await grip.boundingBox())!;
  const x = gb.x + gb.width / 2;
  const y = gb.y + gb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + rows * p);
  await page.mouse.up();
}

/** A drag that should move nothing: give a wrong drop time to land, then look. */
async function expectUnmoved(page: Page, want: string[], what: string) {
  await page.waitForTimeout(700);
  expect(await order(page), what).toEqual(want);
  // A press and release this short ends on the grip it began on, and that
  // click is a tap, which leaves edit mode (EditExit): enter it again.
  if (!(await inEditMode(page))) await editMode(page);
}

test('quick drags of 2.4 rows: first on a fresh list, then one straight after another, down and up', async ({ page }) => {
  test.setTimeout(120_000);
  await freshList(page);

  await quickDrag(page, 'b', 2.4); // a middle row, the list's first drag
  await expect.poll(() => order(page), { message: 'b passed c and d, not e' }).toEqual(['a', 'c', 'd', 'b', 'e']);

  await quickDrag(page, 'a', 2.4); // the first row, straight after
  await expect.poll(() => order(page), { message: 'a passed c and d, not b' }).toEqual(['c', 'd', 'a', 'b', 'e']);

  await quickDrag(page, 'e', -2.4); // the last row, up
  await expect.poll(() => order(page), { message: 'e passed b and a, not d' }).toEqual(['c', 'd', 'e', 'a', 'b']);
});

test('quick drags of 0.6 of a row move nothing: first on a fresh list, then down and up from the first, a middle and the last row', async ({ page }) => {
  test.setTimeout(120_000);
  await freshList(page);
  const all = ['a', 'b', 'c', 'd', 'e'];

  await quickDrag(page, 'c', 0.6); // the list's first drag
  await expectUnmoved(page, all, 'c down 0.6 of a row');
  await quickDrag(page, 'a', 0.6);
  await expectUnmoved(page, all, 'a (first) down 0.6');
  await quickDrag(page, 'e', -0.6);
  await expectUnmoved(page, all, 'e (last) up 0.6');
  await quickDrag(page, 'c', -0.6);
  await expectUnmoved(page, all, 'c (middle) up 0.6');

  // And the grips still drag: a real move after the no-ops.
  await quickDrag(page, 'd', -2.4);
  await expect.poll(() => order(page), { message: 'd passed c and b, not a' }).toEqual(['a', 'd', 'b', 'c', 'e']);
});
