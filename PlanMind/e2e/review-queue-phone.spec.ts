import { test, expect } from '@playwright/test';
import { apiLogin, farDate, login, showTodos } from './helpers';
import { OWNER } from './people';

// A phone redraw asked by a panel (a tab press) waits behind an add that is refused; the tick made behind it is then refused outright too.
// Nothing touches the screen after the add is answered, so the last picture drawn for the tick's refusal is the one that stays.
test('a tick refused after a panel-asked redraw ends unticked under the banner', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER);
  const date = farDate(990), tag = crypto.randomUUID().slice(0, 5), title = `Rqp ${tag} A`, added = `Rqp ${tag} New`;
  expect((await owner.post({ action: 'add', kind: 'todo', id: crypto.randomUUID(), scope: 'day', date, owners: [OWNER], title })).status()).toBe(200);
  await login(page);
  await page.locator('#pill-date').fill(date);
  await showTodos(page);
  const circle = page.locator(`input.day-circle[aria-label$=" ${title}"]`);
  await expect(circle).toBeVisible();
  let ticks = 0;
  const refuse = (status: number, code: string) => ({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Refused for now.', code }) });
  await page.route('**/api.php', async route => {
    const request = route.request();
    if (request.method() !== 'POST') { await route.continue(); return; }
    const action = JSON.parse(request.postData() ?? '{}').action;
    if (action === 'add') { await new Promise(r => setTimeout(r, 800)); await route.fulfill(refuse(400, 'invalid')); }
    else if (action === 'complete') { ticks++; await new Promise(r => setTimeout(r, 2500)); await route.fulfill(refuse(503, 'unavailable')); }
    else { await route.continue(); }
  });
  await page.getByLabel('New task', { exact: true }).fill(added);
  await page.getByRole('button', { name: 'Add', exact: true }).tap();       // the add is out (not optimistic: the screen is busy)
  await page.getByRole('tab', { name: 'To-do', exact: true }).tap();        // a panel asks for a redraw; it waits behind the add
  await circle.tap();                                                       // a tick behind the add, shown at once
  await expect(circle).toBeChecked();
  await expect.poll(() => ticks).toBe(1);
  // From here no pointer, touch or focus event: the add is refused, then the tick is refused.
  await expect(page.locator('#error')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#error-message')).toHaveText('Refused for now.');
  await page.waitForTimeout(3500);
  await expect(circle).not.toBeChecked();
  expect((await owner.snapshot()).tasks.find((t: any) => t.title === title).done).toBe(false);
  await owner.dispose();
});
