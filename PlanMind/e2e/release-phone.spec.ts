import { expect, test } from '@playwright/test';
import { B, host, mark, poll, reloaded, still } from './release-host';
import { login } from './helpers';

// A new release on a phone (release.spec.ts has the desktop's): a finger on the screen is a pointer that is down even after the browser has
// taken its gesture for a scroll (it cancels the pointer and the touch goes on), and the phone tab the person is on survives the load.
test.describe('a new release reaches an open phone', () => {
  test('it waits while a finger is on the screen, also once its touch has become a scroll, and loads when it is lifted', async ({ page }) => {
    const served = await host(page);
    await login(page);
    await page.getByRole('tab', { name: 'To-do', exact: true }).tap();
    await expect(page.getByRole('tab', { name: 'To-do', exact: true })).toHaveAttribute('aria-selected', 'true');
    await mark(page);
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      for (const type of ['pointerdown', 'pointercancel', 'pointerup']) { document.addEventListener(type, () => seen.push(type), true); }
    });
    const cdp = await page.context().newCDPSession(page);
    const [x, y] = [187, 600];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 20 }] });
      await page.waitForTimeout(16);
    }
    // The browser took the touch for a scroll and cancelled the pointer, the finger is still down.
    await expect.poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen.join(' '))).toContain('pointercancel');
    served.stamp = B;
    await poll(page);
    await still(page, 'the finger is still on the screen');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await reloaded(page);
  });

  test('the phone tab the person is on survives the load', async ({ page }) => {
    const served = await host(page);
    await login(page);
    await page.getByRole('tab', { name: 'Notes', exact: true }).tap();
    await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveAttribute('aria-selected', 'true');
    await mark(page);
    served.stamp = B;
    await poll(page);
    await reloaded(page);
    await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).hash).toBe('');
    // A load by hand starts on the schedule, as it always did.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Schedule', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
});
