/**
 * A row ARRIVING above the one you are dragging (a second tab, or a
 * background pull) must not make the drop land short or vanish.
 *
 * When the dragged row's index moves, its grip is handed to the responder of
 * the new index, whose own dy counts only the movement since. The drop is
 * placed from the pointer's whole travel since the grant, against the rows as
 * they are now, so b dragged N rows down lands N rows down.
 */
import { test, expect, type Page } from '@playwright/test';

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `du${Date.now()}${seq++}`;
  await page.goto('.');
  await page.getByText('Sign up', { exact: true }).click();
  await page.getByPlaceholder('Username').fill(user);
  await page.getByPlaceholder('Email').fill(`${user}@example.com`);
  await page.getByPlaceholder('Password', { exact: true }).fill('e2epassword');
  await page.getByPlaceholder('Confirm password').fill('e2epassword');
  await page.getByText('Sign up', { exact: true }).click();
  await expect(page.getByTestId('tab-reminders')).toBeVisible({ timeout: 10_000 });
  return user;
}


test('a row arriving above mid-drag does not shorten or lose the drop', async ({ page, context }) => {
  test.setTimeout(120_000);
  await signup(page);
  await page.getByTestId('tab-reminders').click();
  for (const t of ['d', 'c', 'b', 'a']) {
    await page.getByTestId('secadd-General').first().click();
    await page.getByTestId('rem-add-field').fill(t);
    await page.getByTestId('rem-add-field').press('Enter');
  }
  const order = () => page.getByTestId('rem-body').allTextContents();
  await expect.poll(order).toEqual(['a', 'b', 'c', 'd']);
  const body = page.getByTestId('rem-body').filter({ hasText: 'c' }).first();
  const bb = (await body.boundingBox())!;
  await page.mouse.move(bb.x + 20, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const rows = page.getByTestId('rem-row');
  const rowH = (await rows.nth(1).boundingBox())!.height;
  const grip = rows.filter({ hasText: 'b' }).first().getByTestId('row-grip');
  const gb = (await grip.boundingBox())!;
  const x = gb.x + gb.width / 2;
  const y = gb.y + gb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 8);

  const other = await context.newPage();
  await other.goto('.');
  await other.getByTestId('tab-reminders').click();
  await other.getByTestId('secadd-General').first().click();
  await other.getByTestId('rem-add-field').fill('x');
  await other.getByTestId('rem-add-field').press('Enter');
  await expect.poll(order, { timeout: 15_000 }).toEqual(['x', 'a', 'b', 'c', 'd']);
  await other.close();
  await page.bringToFront();

  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (i * rowH * 2.5) / 6);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect
    .poll(order, { message: 'b moved past two rows', timeout: 10_000 })
    .toEqual(['x', 'a', 'c', 'd', 'b']);
});
