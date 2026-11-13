import { expect, test } from '@playwright/test';
import { apiLogin, farDate, field, login, showHalf } from './helpers';
import { OWNER } from './people';

// A half-hour title remains a 44px touch target and the start and end grips stay clear of it.
const DAY = farDate(830);
test('phone: the half-hour entry field and both resize grips stay reachable', async ({ page, baseURL }) => {
  const owner = await apiLogin(baseURL!, OWNER);
  const created = await owner.post({ action: 'add', kind: 'event', id: crypto.randomUUID(), date: DAY, owners: [OWNER], text: 'Short', start: 720, length: 30 });
  expect(created.status()).toBe(200);
  try {
    await login(page);
    await page.locator('#pill-date').fill(DAY);
    await showHalf(page, 'am');
    await page.locator('.day-ev').first().tap();
    await expect(field(page, 'Edit entry: Short')).toBeFocused();
    const m = await page.evaluate(() => {
      const ev = document.querySelector('.day-ev.day-editing')!;
      const r = (e: Element) => e.getBoundingClientRect();
      const input = r(ev.querySelector('input')!);
      const handle = (edge: string) => ev.querySelector<HTMLElement>(`.day-handle[data-edge=${edge}]`)!;
      const owner = (edge: string) => { const h = r(handle(edge)); return (document.elementFromPoint(h.left + h.width / 2, edge === 'start' ? h.bottom - 2 : h.top + 2) as HTMLElement | null)?.closest<HTMLElement>('.day-handle')?.dataset.edge ?? null; };
      const [s, e] = [r(handle('start')), r(handle('end'))];
      return { height: input.height, startOverlap: Math.min(input.bottom, s.bottom) - Math.max(input.top, s.top), endOverlap: Math.min(input.bottom, e.bottom) - Math.max(input.top, e.top),
        startNear: owner('start'), endNear: owner('end') };
    });
    // The grab areas are the handles' wherever they touch the field's box.
    expect(m.startNear).toBe('start');
    expect(m.endNear).toBe('end');
    expect(m.height).toBeGreaterThanOrEqual(44);
    expect(m.startOverlap).toBeLessThanOrEqual(0.5);
    expect(m.endOverlap).toBeLessThanOrEqual(0.5);
  } finally {
    const snap = await owner.snapshot();
    for (const e of snap.events.filter((x: { date: string }) => x.date === DAY)) { await owner.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true }); }
    await owner.dispose();
  }
});
