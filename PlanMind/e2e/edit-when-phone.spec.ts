import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { apiLogin, farDate, field, login, resetPrefs, showHalf, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

// The time pill of an entry being edited, on a phone (375x812, a finger): above the block, below it at 7a, inside the lanes, never under the tab
// bar, no room taken and nothing pressed through it, and the drag's own bubble instead of it while a finger drags a grip. Phone project.
const add = async (api: Api, body: Record<string, unknown>) => {
  const data = { id: crypto.randomUUID(), ...body };
  const response = await api.post(data);
  expect(response.status(), JSON.stringify(await response.json())).toBe(200);
  return data.id as string;
};
const event = (date: string, over: Record<string, unknown> = {}) => ({ action: 'add', kind: 'event', date, owners: [OWNER], text: 'Dentist', start: 540, length: 60, ...over });
const openDay = async (page: Page, date: string) => {
  await page.locator('#pill-date').fill(date);
  await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
};
async function clearDay(api: Api, date: string) {
  const snapshot = await api.snapshot();
  for (const item of [...snapshot.tasks, ...snapshot.priorities, ...snapshot.events].filter((i: { date: string }) => i.date === date)) {
    await api.post({ action: 'delete', id: item.id, revision: item.revision, confirm: true });
  }
}
const block = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true });
const editing = (page: Page) => page.locator('.day-ev.day-editing');
const pill = (page: Page) => page.locator('.day-when');
const bubble = (page: Page) => page.locator('.day-bubble');
const boxOf = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!;
const centre = async (locator: ReturnType<Page['locator']>) => { const box = await boxOf(locator); return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }; };
const perMinute = async (page: Page) => {
  const minutes = await page.locator('.day-lanes').evaluate(el => Number((el as HTMLElement).dataset.span));
  return (await boxOf(page.locator('.day-lanes'))).height / minutes;
};
/** The pill against the block being edited, the lanes and the tab bar. */
const where = async (page: Page) => {
  const [p, b, g] = [await boxOf(pill(page)), await boxOf(editing(page)), await boxOf(page.locator('.day-lanes'))];
  const tabs = await page.locator('.day-tabs').evaluate(el => el.getBoundingClientRect().top);
  return { pill: p, above: p.y + p.height <= b.y, below: p.y >= b.y + b.height, inside: p.x >= g.x && p.x + p.width <= g.x + g.width, clear: p.y >= 0 && p.y + p.height <= tabs };
};
function finger(cdp: CDPSession) {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  return {
    down: (x: number, y: number) => send('touchStart', x, y),
    up: () => send('touchEnd'),
    async drag(from: { x: number; y: number }, dy: number, steps = 20) { for (let i = 1; i <= steps; i++) { await send('touchMove', from.x, from.y + (dy * i) / steps); } },
  };
}

test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });

test.describe('the time pill on a phone', () => {
  test('above the block, below it at 7a, over its middle and inside the lanes (the narrow right lane too), clear of the tab bar at the bottom of the page', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1810);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Early', start: 420, length: 30 }));
    await add(owner, event(date, { text: 'Hers', start: 720, owners: [PARTNER] }));
    await add(owner, event(date, { text: 'Late', start: 1230, length: 30, owners: [PARTNER] }));
    await add(owner, event(date, { text: 'Dinner', start: 1080, owners: [OWNER, PARTNER] }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      await expect(pill(page)).toHaveCount(0);
      for (const [label, text, where_] of [
        [`Dentist, 9a to 10a, ${OWNER_NAME}`, '9a – 10a', 'above'], [`Hers, 12p to 1p, ${PARTNER_NAME}`, '12p – 1p', 'above'], ['Dinner, 6p to 7p, Both', '6p – 7p', 'above'],
        [`Late, 8:30p to 9p, ${PARTNER_NAME}`, '8:30p – 9p', 'above'], [`Early, 7a to 7:30a, ${OWNER_NAME}`, '7a – 7:30a', 'below'],
      ] as const) {
        await block(page, label).tap();
        await expect(editing(page)).toHaveCount(1);
        await expect(pill(page)).toHaveText(text);
        const at = await where(page);
        expect(at, label).toMatchObject({ [where_]: true, inside: true, clear: true });
        expect(Math.abs(at.pill.x + at.pill.width / 2 - await (async () => { const b = await boxOf(editing(page)); return b.x + b.width / 2; })()), `${label}: over the middle, as far as the lanes allow`).toBeLessThanOrEqual(2);
        await page.keyboard.press('Escape');
        await expect(pill(page)).toHaveCount(0);
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('the PM page too: an entry ending at 7a, the last row of the night, has its pill above it, over the tab bar\'s top edge never', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1811);
    await add(owner, event(date, { text: 'Dawn', start: 1830, length: 30 }));
    await add(owner, event(date, { text: 'Night', start: 1290, length: 60 }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'pm');
      for (const [label, text] of [[`Dawn, 6:30a to 7a, ${OWNER_NAME}`, '6:30a – 7a'], [`Night, 9:30p to 10:30p, ${OWNER_NAME}`, '9:30p – 10:30p']]) {
        await block(page, label).tap();
        await expect(pill(page)).toHaveText(text);
        expect(await where(page), label).toMatchObject({ inside: true, clear: true });
        await page.keyboard.press('Escape');
      }
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a short entry at the bottom of the page, where the grips are pulled in and step out for the tab bar: the pill is clear of both grips, not just of the block', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), dates = [farDate(1814), farDate(1815), farDate(1816)];
    const cases = [
      { date: dates[0], text: 'Short', start: 1245, length: 30, owners: [OWNER], label: `Short, 8:45p to 9:15p, ${OWNER_NAME}`, span: '8:45p – 9:15p', grips: 1 },
      { date: dates[1], text: 'Half', start: 1230, length: 30, owners: [PARTNER], label: `Half, 8:30p to 9p, ${PARTNER_NAME}`, span: '8:30p – 9p' },
      { date: dates[2], text: 'Three', start: 1215, length: 45, owners: [OWNER], label: `Three, 8:15p to 9p, ${OWNER_NAME}`, span: '8:15p – 9p' },
    ];
    for (const c of cases) { await add(owner, event(c.date, { text: c.text, start: c.start, length: c.length, owners: c.owners })); }
    try {
      await login(page);
      for (const c of cases) {
        await openDay(page, c.date); await showHalf(page, 'am');
        await block(page, c.label).tap();
        await expect(editing(page)).toHaveCount(1);
        await expect(pill(page)).toHaveText(c.span);
        const found = await page.evaluate(() => {
          const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; };
          return { pill: rect(document.querySelector('.day-when')!), grips: [...document.querySelectorAll('.day-ev.day-editing .day-handle i')].map(rect).filter(r => r.w > 0 && r.h > 0), tabs: document.querySelector('.day-tabs')!.getBoundingClientRect().top };
        });
        expect(found.grips.length, `${c.label}: the visible ends have grips`).toBe(c.grips ?? 2);
        for (const grip of found.grips) {
          const apart = found.pill.bottom <= grip.y || found.pill.y >= grip.bottom || found.pill.right <= grip.x || found.pill.x >= grip.right;
          expect(apart, `${c.label}: the pill ${JSON.stringify(found.pill)} is clear of the grip ${JSON.stringify(grip)}`).toBe(true);
        }
        expect(found.pill.bottom, `${c.label}: above the tab bar`).toBeLessThanOrEqual(found.tabs);
        await page.keyboard.press('Escape');
        await expect(pill(page)).toHaveCount(0);
      }
    } finally { for (const date of dates) { await clearDay(owner, date); } await owner.dispose(); }
  });

  test('it takes no room and nothing is pressed through it to the page: the start grip is still the topmost thing at its middle with the pill beside it', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1812);
    await add(owner, event(date));
    await add(owner, event(date, { text: 'Hers', start: 720, owners: [PARTNER] }));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const before = await page.evaluate(() => ({ lanes: document.querySelector('.day-lanes')!.getBoundingClientRect().toJSON(), other: (() => { const r = document.querySelector('.day-ev[aria-label^=Hers]')!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() }));
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      await expect(pill(page)).toBeVisible();
      const style = await pill(page).evaluate(el => { const c = getComputedStyle(el); return { position: c.position, events: c.pointerEvents, size: c.fontSize, hidden: el.getAttribute('aria-hidden') }; });
      expect(style).toMatchObject({ position: 'absolute', events: 'none', size: '11px', hidden: 'true' });
      const after = await page.evaluate(() => ({ lanes: document.querySelector('.day-lanes')!.getBoundingClientRect().toJSON(), other: (() => { const r = document.querySelector('.day-ev[aria-label^=Hers]')!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() }));
      expect(after, 'nothing moved').toEqual(before);
      const hits = await page.evaluate(() => {
        const p = document.querySelector('.day-when')!.getBoundingClientRect(), h = document.querySelector('.day-ev.day-editing .day-handle[data-edge=start]')!.getBoundingClientRect();
        const top = (x: number, y: number) => document.elementFromPoint(x, y) as HTMLElement | null;
        return { pill: !!top(p.left + p.width / 2, p.top + p.height / 2)?.closest('.day-when'), grip: !!top(h.left + h.width / 2, h.top + h.height / 2)?.closest('.day-handle'), gripLeft: !!top(h.left + h.width / 2, h.bottom - 2)?.closest('.day-handle') };
      });
      expect(hits).toEqual({ pill: false, grip: true, gripLeft: true });
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });

  test('a finger on the end grip: the bubble shows the span and the pill is not shown; at the release the pill says the new end', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = farDate(1813);
    await add(owner, event(date));
    try {
      await login(page); await openDay(page, date); await showHalf(page, 'am');
      const f = finger(await page.context().newCDPSession(page)), minute = await perMinute(page);
      await block(page, `Dentist, 9a to 10a, ${OWNER_NAME}`).tap();
      await expect(field(page, 'Edit entry: Dentist')).toBeFocused();
      await expect(pill(page)).toHaveText('9a – 10a');
      const grab = await centre(page.locator('.day-handle[data-edge=end]'));
      await f.down(grab.x, grab.y);
      await f.drag(grab, 30 * minute, 10);
      await expect(bubble(page)).toHaveText('9a – 10:30a');
      await expect(pill(page)).toBeHidden();
      await f.up();
      await expect(bubble(page)).toHaveCount(0);
      await expect(pill(page)).toBeVisible();
      await expect(pill(page)).toHaveText('9a – 10:30a');
      // The start grip, a finger again.
      const top = await centre(page.locator('.day-handle[data-edge=start]'));
      await f.down(top.x, top.y);
      await f.drag(top, -30 * minute, 10);
      await expect(pill(page)).toBeHidden();
      await f.up();
      await expect(pill(page)).toHaveText('8:30a – 10:30a');
    } finally { await clearDay(owner, date); await owner.dispose(); }
  });
});
