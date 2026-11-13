import { expect, test } from '@playwright/test';
import { THEMES, type ThemeName } from '../app/theme';
import { MIN_CONTRAST } from '../packages/core/src/planner';
import { apiLogin, farDate, isPhone, login, showHalf, showTheme, textContrast } from './helpers';
import { poll } from './release-host';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

test('a real mouse sweep follows the visible marker and clipped label as separate targets', async ({ page, baseURL }, info) => {
  test.skip(isPhone(info.project.name), 'The mouse sweep uses a compact desktop timeline.');
  await page.setViewportSize({ width: 1280, height: 680 });
  const api = await apiLogin(baseURL!, OWNER);
  const date = farDate(813);
  const previous = crypto.randomUUID(), next = crypto.randomUUID();
  const add = (id: string, owners: string[], text: string, start: number) =>
    api.post({ action: 'add', kind: 'event', id, date, owners, text, start, length: 30 });
  try {
    expect((await add(previous, [PARTNER], 'Before the switch', 1215)).status()).toBe(200);
    expect((await add(next, [OWNER, PARTNER], 'Across the switch', 1245)).status()).toBe(200);
    await login(page);
    await page.locator('#jump-date').fill(date);
    const event = (id: string) => page.locator(`button.day-ev[data-id="${id}"]`);
    await expect(event(next)).toHaveAttribute('data-clip', 'bottom');
    const endOfTimeline = () => page.locator('.day-timeline').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await endOfTimeline();
    const before = (await event(previous).boundingBox())!;
    const after = (await event(next).boundingBox())!;
    const label = (await event(next).locator('.day-ev-text').boundingBox())!;
    const rail = Math.round(before.x + 2), cross = (label.y + before.y + before.height) / 2;
    expect(label.x).toBeGreaterThan(rail);
    expect(label.y).toBeLessThan(before.y + before.height);
    const targetAt = () => page.locator('.day-ev:hover').evaluateAll(buttons => buttons.map(b => b.getAttribute('data-id')));
    const sweep = [
      [Math.floor(before.y + before.height / 2), previous], [cross, previous],
      [Math.floor(after.y + after.height / 2), next], [cross, previous],
    ] as const;
    for (const [y, id] of sweep) {
      await page.mouse.move(rail, y);
      expect(await targetAt(), `hover at ${y}`).toEqual([id]);
      await expect(page.locator('.day-preview')).toHaveCount(0);
    }
    // Pixel snapping differs by engine at the exact boundary, but neither visual inset can turn into a creation slot.
    for (const y of [before.y + before.height + 0.25, after.y - 0.25]) {
      await page.mouse.move(rail, y);
      expect([previous, next]).toContain((await targetAt())[0]);
      await expect(page.locator('.day-preview')).toHaveCount(0);
    }
    for (const x of [label.x + 2, label.x + label.width / 2, label.x + label.width - 2]) {
      for (const y of [label.y + 2, label.y + label.height - 2]) {
        await page.mouse.move(x, y);
        expect(await targetAt(), `visible label at ${x},${y}`).toEqual([next]);
        await expect(page.locator('.day-preview')).toHaveCount(0);
      }
    }
    const editor = page.locator('.day-ev.day-editing input');
    await page.mouse.click(label.x + label.width / 2, cross);
    await expect(editor).toHaveValue('Across the switch');
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
    await endOfTimeline();
    const exposed = (await event(previous).boundingBox())!;
    await event(previous).click({ position: { x: 2, y: exposed.height / 2 } });
    await expect(editor).toHaveValue('Before the switch');
  } finally {
    const snap = await api.snapshot();
    for (const e of snap.events.filter((e: { date: string }) => e.date === date)) {
      await api.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true });
    }
    await api.dispose();
  }
});

test('the exposed label of a clipped entry edits on tap and starts the same move as the marker', async ({ page, baseURL }, info) => {
  const phone = isPhone(info.project.name);
  const api = await apiLogin(baseURL!, OWNER);
  const date = farDate(814), id = crypto.randomUUID();
  try {
    expect((await api.post({ action: 'add', kind: 'event', id, date, owners: [OWNER], text: 'Before and after 9p', start: 1245, length: 30 })).status()).toBe(200);
    await login(page);
    await page.locator(phone ? '#pill-date' : '#jump-date').fill(date);
    await showHalf(page, 'pm');
    const event = page.locator(`button.day-ev[data-id="${id}"]`);
    await expect(event).toBeVisible();
    const marker = (await event.boundingBox())!, caption = (await event.locator('.day-ev-text').boundingBox())!;
    const x = caption.x + caption.width / 2, y = caption.y + 0.5;
    expect(y).toBeLessThan(marker.y - 1);
    if (phone) { await page.touchscreen.tap(x, y); } else { await page.mouse.click(x, y); }
    const editor = page.locator('.day-ev.day-editing input');
    await expect(editor).toHaveValue('Before and after 9p');
    await editor.press('Escape');
    await expect(event).toBeVisible();
    if (!phone) {
      const quarter = (await page.locator('.day-lanes').boundingBox())!.height / 56;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + quarter * 4, { steps: 10 });
      await expect(event).toHaveAttribute('data-moving', '');
      await expect(page.locator('.day-preview')).toHaveCount(0);
      await page.mouse.up();
      await expect.poll(async () => (await api.snapshot()).events.find((e: { id: string }) => e.id === id)?.start).toBe(1305);
      await expect(editor).toHaveCount(0);
    }
  } finally {
    const e = (await api.snapshot()).events.find((e: { id: string }) => e.id === id);
    if (e) { await api.post({ action: 'delete', id, revision: e.revision, confirm: true }); }
    await api.dispose();
  }
});

// The compact schedule fits the viewport and half-hour entries keep full-size labels.
const DAY = farDate(812);
test('the timeline fits, short labels stay readable and cards keep their time positions', async ({ page, baseURL }, info) => {
  const resizeErrors: string[] = [];
  page.on('pageerror', error => { if (error.message.includes('ResizeObserver')) { resizeErrors.push(error.message); } });
  const owner = await apiLogin(baseURL!, OWNER);
  const add = (owners: string[], text: string, start: number, length: number) => owner.post({ action: 'add', kind: 'event', id: crypto.randomUUID(), date: DAY, owners, text, start, length });
  for (const [owners, text, start, length] of [
    [[OWNER], 'Early', 420, 30], [[OWNER], 'Work', 600, 60], [[PARTNER], 'Plants', 600, 60], [[OWNER], 'Games', 660, 30],
    [[OWNER, PARTNER], 'Lunch', 690, 30], [[OWNER], 'Tea', 720, 30], [[OWNER, PARTNER], 'Walk', 750, 30], [[PARTNER], 'Close', 1230, 30],
  ] as const) {
    expect((await add([...owners], text, start, length)).status()).toBe(200);
  }
  try {
    await login(page);
    await page.locator(isPhone(info.project.name) ? '#pill-date' : '#jump-date').fill(DAY);
    await expect(page.locator('.day-ev')).toHaveCount(8);
    const look = await page.evaluate(() => {
      const block = (t: string) => [...document.querySelectorAll<HTMLElement>('.day-ev')].find(e => e.querySelector('.day-ev-text')?.textContent === t)!;
      const r = (t: string) => block(t).getBoundingClientRect();
      const lanes = document.querySelector('.day-lanes')!.getBoundingClientRect();
      const sizes = ['Work', 'Lunch'].map(t => { const b = block(t); return [getComputedStyle(b.querySelector('.day-ev-text')!).fontSize, getComputedStyle(b.querySelector('.day-ev-time')!).fontSize]; });
      const label = (name: string) => block(name).querySelector<HTMLElement>('.day-ev-text')!;
      const lunch = r('Lunch'), title = label('Lunch'), labelBox = title.getBoundingClientRect();
      const frame = document.querySelector('.day-timeline')!.getBoundingClientRect();
      const time = getComputedStyle(block('Work').querySelector('.day-ev-time')!);
      return { across: r('Plants').left - r('Work').right, down: r('Games').top - r('Work').bottom, shared: r('Tea').top - lunch.bottom,
        sizes, distinctTime: time.color !== getComputedStyle(label('Work')).color, timeVisible: time.display !== 'none',
        halfHour: lunch.height, step: lanes.height / 56, titleHeight: labelBox.height, titleRoom: title.clientHeight - title.scrollHeight,
        titleInside: labelBox.top >= lunch.top && labelBox.bottom <= lunch.bottom,
        edgesVisible: label('Early').getBoundingClientRect().top >= frame.top && label('Close').getBoundingClientRect().bottom <= frame.bottom };
    });
    for (const gap of [look.across, look.down, look.shared]) { expect(Math.abs(gap - 2)).toBeLessThanOrEqual(0.5); }
    expect(look.sizes).toEqual([['13px', '11px'], ['13px', '11px']]);
    expect(look.distinctTime).toBe(true);
    expect(look.timeVisible).toBe(true);
    expect(look.step).toBeGreaterThanOrEqual(8);
    expect(Math.abs(look.halfHour + 2 - look.step * 2)).toBeLessThanOrEqual(0.5);
    expect(look.titleHeight).toBeGreaterThanOrEqual(14);
    expect(look.titleRoom).toBeGreaterThanOrEqual(-1); // Font ink extents can round one pixel beyond the 14px line box.
    expect(look.titleInside).toBe(true);
    expect(look.edgesVisible).toBe(true);
    for (const theme of Object.keys(THEMES) as ThemeName[]) {
      await showTheme(page, theme, { tints: true });
      for (const { text, ratio } of await textContrast(page, '.day-ev-time, .day-ev-text')) {
        expect(ratio, `${theme} ${text}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    }

    const timeline = page.getByRole('region', { name: 'Schedule timeline' });
    // The row above the timeline must not move when the scrollbar appears: the controls on a desktop, the lane names on a phone (its choices are in the menu).
    const controls = page.locator(isPhone(info.project.name) ? '.day-sched .day-lanehead' : '.day-schedtools');
    const before = await controls.boundingBox();
    expect(await timeline.evaluate(el => el.scrollHeight - el.clientHeight)).toBe(0);
    expect(await page.locator('.day-sched').getAttribute('data-overlay-scrollbar')).toBeNull();
    expect(await controls.boundingBox()).toEqual(before);
    expect(await page.locator('#period-panel').evaluate(el => el.scrollTop)).toBe(0);

    const offset = await timeline.evaluate(el => el.scrollTop);
    expect((await add([OWNER], 'Later', 960, 30)).status()).toBe(200);
    await poll(page);
    await expect(page.getByRole('button', { name: `Later, 4p to 4:30p, ${OWNER_NAME}` })).toBeAttached();
    expect(await timeline.evaluate(el => el.scrollTop)).toBe(offset);
    await showHalf(page, 'pm');
    expect(await timeline.evaluate(el => el.scrollTop)).toBe(0);
    await showHalf(page, 'am');
    expect(await timeline.evaluate(el => el.scrollTop)).toBe(0);
    if (isPhone(info.project.name)) {
      await page.setViewportSize({ width: 320, height: 568 });
      const overflow = await timeline.evaluate(el => el.scrollHeight - el.clientHeight);
      expect(overflow).toBeGreaterThan(0);
      expect(overflow).toBeLessThanOrEqual(100);
      await page.getByRole('button', { name: `Close, 8:30p to 9p, ${PARTNER_NAME}` }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: `Close, 8:30p to 9p, ${PARTNER_NAME}` })).toBeInViewport();
    }
    expect(resizeErrors).toEqual([]);
  } finally {
    const snap = await owner.snapshot();
    for (const e of snap.events.filter((x: { date: string }) => x.date === DAY)) { await owner.post({ action: 'delete', id: e.id, revision: e.revision, confirm: true }); }
    await owner.dispose();
  }
});
