import { expect, request, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { COLOR_HUES, COLOR_KEYS, tint, todayIn } from '../packages/core/src/planner';
import { THEMES, type ThemeName } from '../app/theme';
import { OWNER, PARTNER } from './people';

/** Shared by every spec. The preview server and its data are disposable and shared by all projects of a run, so tests
 *  create what they need under unique names or far-away dates and remove it again. */
export const PASSWORD = 'planmind-test-only';
export const API = '/PlanMind/api.php';
/** The fixture's configured timezone (tools/fixture.mjs). */
export const TIMEZONE = 'America/Chicago';
export type User = typeof OWNER | typeof PARTNER;
export const today = () => todayIn(TIMEZONE);
export const unique = (label: string) => `${label} ${crypto.randomUUID().slice(0, 8)}`;
/** A date nobody else uses in this run: 2040-01-01 plus n days. */
export const farDate = (n: number) => new Date(Date.UTC(2040, 0, 1 + n)).toISOString().slice(0, 10);
export const isPhone = (projectName: string) => projectName === 'phone';

/** Signs in through the real form and waits until the shell has drawn. */
export async function login(page: Page, user: User = OWNER) {
  await page.goto('/PlanMind/');
  await page.getByLabel('Username', { exact: true }).fill(user);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#sidebar .date-row.selected')).toBeAttached();
}

/** A signed-in API client (cookie jar of its own) with the CSRF token of its session. */
export type Api = { request: APIRequestContext; user: User; csrf: string; snapshot(): Promise<any>; post(data: unknown): Promise<APIResponse>; dispose(): Promise<void> };
export async function apiLogin(baseURL: string, user: User): Promise<Api> {
  const client = await request.newContext({ baseURL });
  const form = await (await client.get('/PlanMind/')).text();
  const token = form.match(/name="csrf" value="([^"]+)"/)![1];
  await client.post('/PlanMind/', { form: { username: user, password: PASSWORD, csrf: token } });
  const api: Api = {
    request: client, user, csrf: '',
    snapshot: async () => (await client.get(API)).json(),
    post: data => client.post(API, { headers: { 'X-CSRF-Token': api.csrf }, data: data as object }),
    dispose: () => client.dispose(),
  };
  api.csrf = (await api.snapshot()).csrf;
  return api;
}

/** A v2 add of a to-do; override any field. */
export const todo = (over: Record<string, unknown> = {}) => ({
  action: 'add', kind: 'todo', id: crypto.randomUUID(), scope: 'day', date: today(), owners: [OWNER], title: unique('Task'), ...over,
});

/** Removes to-dos created by a test, whoever they belong to. Ignores ones already gone. */
export async function removeTodos(api: Api, ids: string[]) {
  const { tasks } = await api.snapshot();
  for (const task of tasks.filter((t: { id: string }) => ids.includes(t.id))) {
    await api.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true });
  }
}

/** The chore chart as a fresh store has it: the rhythm's anchor, which the seeded rules' Week A and Week B are counted from. */
export const CHORE_ANCHOR = '2026-11-02';
/**
 * Puts the chore chart back after a test, which works in a month nobody else uses (`month` is 'YYYY-MM'): every mark of that month gone (a turn left
 * open, unmoved and with no owner of its own has no mark), every rule the test added deleted (their titles start with "E2E ", which deletes their marks
 * too), and the rhythm's anchor back where it was. The store is shared by the whole run.
 */
export async function resetChores(api: Api, month: string, anchor = CHORE_ANCHOR) {
  const snapshot = await api.snapshot();
  for (const mark of snapshot.choreMarks.filter((m: { date: string }) => m.date.startsWith(month))) {
    await api.post({ action: 'markChore', ruleId: mark.ruleId, date: mark.date, state: 'open', moved: false, revision: mark.revision });
  }
  for (const rule of snapshot.chores.filter((r: { title: string }) => r.title.startsWith('E2E '))) {
    await api.post({ action: 'deleteChore', id: rule.id, revision: rule.revision, confirm: true });
  }
  if (snapshot.rhythm.anchor !== anchor) { await api.post({ action: 'saveRhythm', anchor, revision: snapshot.rhythm.revision }); }
}

/** What the browser keeps for this origin. The planner must keep nothing private in any of it. */
export const browserStorage = (page: Page) => page.evaluate(async () => ({
  local: localStorage.length, session: sessionStorage.length,
  indexedDB: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
}));

/** On a phone the Day panel shows one tab at a time and opens on Schedule (it does so again after every load): this
 *  opens the To-do tab, where the add form and the rows are. A no-op where there is no tab bar. */
export async function showTodos(page: Page) {
  const tab = page.getByRole('tab', { name: 'To-do', exact: true });
  if (!(await tab.isVisible())) { return; }
  if ((await tab.getAttribute('aria-selected')) !== 'true') { await tab.click(); }
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Opens the top picker's menu, runs `choose` inside it and waits until the page has saved the selection (it does so a
 *  moment after the last change), so a test that resets the selection afterwards cannot be overwritten by a late save. */
async function inPicker(page: Page, choose: (menu: Locator) => Promise<void>) {
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && (response.request().postData() ?? '').includes('"savePrefs"'));
  await page.getByRole('button', { name: /^Lists: / }).click();
  const menu = page.getByRole('group', { name: 'Lists', exact: true });
  await expect(menu).toBeVisible();
  await choose(menu);
  await saved;
}

/** Chooses what the top picker shows alone (a row of the menu: Both, the partner, the owner or a custom list). The one place a person
 *  says who new items are for: the base list, or both of us under Both. */
export async function pickList(page: Page, name: string) {
  await inPicker(page, menu => menu.getByRole('button', { name, exact: true }).click());
  await expect(page.getByRole('button', { name: `Lists: ${name}`, exact: true })).toBeVisible();
}

/** Ticks a custom list's box in the picker, so it shows on top of the base. It never decides who new items are for. */
export async function overlayList(page: Page, name: string) {
  await inPicker(page, async menu => { await menu.getByRole('checkbox', { name: `Show ${name}`, exact: true }).check(); await page.keyboard.press('Escape'); });
}

/** Puts both people's selection back on Both with the sidebar shown and their own Both color back to the household default: the selection is a saved preference and the accounts are shared by the whole run. */
export async function resetPrefs(baseURL: string) {
  for (const user of [OWNER, PARTNER] as const) {
    const api = await apiLogin(baseURL, user);
    await api.post({ action: 'savePrefs', selection: { base: 'both', overlays: [] }, sidebar: 'shown' });
    await api.post({ action: 'setBothColor', bothColor: null });
    await api.dispose();
  }
}

/** Adds a day to-do through the form. It is for whoever the top picker shows (the base list, both of us under Both);
 *  `who` first chooses that in the picker ('alex', 'sam', 'Both', a list's name). */
export async function addTodo(page: Page, title: string, who?: string) {
  await showTodos(page);
  if (who) { await pickList(page, who); }
  await page.getByLabel('New task', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeVisible();
}

/** Opens the account menu and chooses an item. On a phone the account is in the drawer, so the drawer opens first. */
export async function accountMenu(page: Page, item?: 'Settings' | 'Sign out') {
  const phone = !(await page.locator('#account-button-bar').isVisible());
  if (phone && !(await page.locator('#sidebar').isVisible())) { await page.getByRole('button', { name: 'Open menu', exact: true }).click(); }
  const button = page.locator(phone ? '#account-button-drawer' : '#account-button-bar');
  await button.click();
  await expect(page.getByRole('menu')).toBeVisible();
  if (item) { await page.getByRole('menuitem', { name: item, exact: true }).click(); }
  return button;
}

/** The field that takes an item's text while it is edited where it stands ("Edit task: Buy milk", "New priority 1 for the partner", "Edit entry: Dentist"). */
export const field = (page: Page, name: string | RegExp) => page.getByRole('textbox', { name, exact: typeof name === 'string' });

/** Editing opens no window for content, whatever is being edited: there is no dialog on the page. */
export const noWindow = (page: Page) => expect(page.getByRole('dialog')).toHaveCount(0);

/** Takes focus out of any field, so the shell is free to redraw (it never redraws under a focused field). */
export const leaveField = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** Puts one of the four palettes on the open page the way setTheme does (page variables and the page background; the tint
 *  variables of the color keys stay unless `tints` asks for them too, for what is painted in an owner's color), so one session
 *  can be looked at in every theme. */
export const showTheme = (page: Page, name: ThemeName, { tints = false } = {}) => page.evaluate(({ cols, tones }) => {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(cols)) {
    if (key !== 'label') { root.style.setProperty('--' + key.replace(/[A-Z0-9]/g, m => '-' + m.toLowerCase()), value); }
  }
  for (const [key, { bg, fg, line }] of Object.entries(tones)) { root.style.setProperty(`--c-${key}-bg`, bg); root.style.setProperty(`--c-${key}-fg`, fg); root.style.setProperty(`--c-${key}-line`, line); }
  root.style.backgroundColor = cols.bg; document.body.style.backgroundColor = cols.bg;
}, { cols: THEMES[name], tones: tints ? Object.fromEntries(COLOR_KEYS.map(key => [key, tint(COLOR_HUES[key], THEMES[name].surface, THEMES[name].text)])) : {} });

/** The least contrast (WCAG 1.4.11) a control's outline needs against what is drawn behind it. */
export const MIN_NON_TEXT_CONTRAST = 3;

/** The contrast ratio (WCAG) of the text of every element matching `selector` over what is drawn behind it, with the
 *  opacity of the element and of its ancestors counted. `paint` 'borderTopColor' measures an outline (a check circle's ring) instead of the words,
 *  'backgroundColor' an element's own fill (a bar) over what is behind it. */
export const textContrast = (page: Page, selector: string, paint: 'color' | 'borderTopColor' | 'backgroundColor' = 'color') => page.locator(selector).evaluateAll((elements, paint) => elements.map(el => {
  // getComputedStyle gives rgb()/rgba(), or color(srgb r g b / a) with channels in 0..1 for a color-mix() value.
  const rgba = (c: string) => { const unit = c.startsWith('color(srgb') ? 255 : 1; const [r, g, b, a = 1] = (c.match(/[\d.]+/g) ?? []).map(Number); return [r * unit, g * unit, b * unit, a]; };
  const channel = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3]));
  let opacity = 1;
  const layers: number[][] = [];
  let behind = true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    opacity *= Number(style.opacity);
    const layer = rgba(style.backgroundColor);
    if (behind && layer[3] > 0 && !(paint === 'backgroundColor' && node === el)) { layers.push(layer); if (layer[3] === 1) { behind = false; } }
  }
  const background = layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255]);
  const text = rgba(getComputedStyle(el)[paint]);
  const foreground = over([text[0], text[1], text[2], text[3] * opacity], background);
  const [a, b] = [luminance(foreground), luminance(background)];
  return { text: (el.textContent ?? '').trim().slice(0, 24) || (el.getAttribute('aria-label') ?? ''), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
}), paint);

/** How big the target of each element matching `selector` really is: from the middle of the element, the pixels around it
 *  that still hit it (or something inside it), so a ::before that widens a hit area counts and a neighbour that covers part
 *  of it does not. Reports { name, width, height } for each one that is drawn, with `name` the accessible name or text. */
export const hitSizes = (page: Page, target: string | Locator) => (typeof target === 'string' ? page.locator(target) : target).evaluateAll(elements => elements.filter(el => el.getClientRects().length > 0).map(el => {
  const box = el.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const owns = (px: number, py: number) => { const hit = document.elementFromPoint(px, py); return !!hit && (hit === el || el.contains(hit)); };
  let top = y, bottom = y, left = x, right = x;
  while (top > y - 80 && owns(x, top - 1)) { top--; }
  while (bottom < y + 80 && owns(x, bottom + 1)) { bottom++; }
  while (left > x - 120 && owns(left - 1, y)) { left--; }
  while (right < x + 120 && owns(right + 1, y)) { right++; }
  return { name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), width: right - left + 1, height: bottom - top + 1 };
}));

/**
 * The span of the schedule entry being edited, read from its block (data-q is its first quarter-hour row of the grid, counted from the shown half's start (data-from on .day-lanes: 7:00 on the AM page, 9p on the PM page), data-n the rows it
 * covers; a block a half cuts off reads as its shown part), so it works whatever the strip shows. There is no Start or Length control: the time is set by dragging the block or a handle, and the
 * keyboard does the same in quarter hours (Alt+Up and Alt+Down move it, Alt+Shift+Up and Alt+Shift+Down change its end).
 */
export const draftSpan = (page: Page) => page.locator('.day-ev.day-editing[data-primary]').evaluate(el => {
  const { q, n } = (el as HTMLElement).dataset, from = Number((el.closest('.day-lanes') as HTMLElement | null)?.dataset.from) || 420;
  return { start: from + (Number(q) - 1) * 15, length: Number(n) * 15 };
});

/**
 * Chooses the AM or the PM page of the Day schedule (the AM and PM switch: on the Schedule heading's line on a desktop, in the menu behind the hamburger on
 * a phone). AM is the old day, 7a to 9p; PM is the night, 9p to 7a. The page opens on AM; a test that taps an hour of the other page calls this
 * first. The choice is kept while the page is open.
 */
export async function showHalf(page: Page, half: 'am' | 'pm') {
  // A phone has the switch in the menu behind the hamburger (choosing closes it); a desktop has it on the Schedule heading.
  if (await page.locator('#menu').isVisible()) {
    const sched = page.locator('.day-sched');
    if ((await sched.getAttribute('data-half')) !== half) {
      await page.locator('#menu').click();
      await page.locator(`#sidebar [data-half=${half}]`).click();
    }
    await expect(sched).toHaveAttribute('data-half', half);
    await expect(page.locator('#sidebar')).toBeHidden();
    return;
  }
  const button = page.locator(`.day-half button[data-half=${half}]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') { await button.click(); }
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

// ---- a list that scrolls inside a panel: its keyboard rings and its place ----

/** Where the focused control's keyboard ring is against its frame: its box grown by the outline's offset and width, how far inside the frame on each side (below 0: cut off). Null outside the frame. */
export type Ring = { name: string; left: number; top: number; right: number; bottom: number };
export const ring = (page: Page, frame: string) => page.evaluate((selector): Ring | null => {
  const el = document.activeElement as HTMLElement | null, area = document.querySelector(selector);
  if (!el || !area?.contains(el)) { return null; }
  const [box, edge, style] = [el.getBoundingClientRect(), area.getBoundingClientRect(), getComputedStyle(el)];
  const grow = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
  return { name: `${el.tagName.toLowerCase()}.${el.className} "${el.getAttribute('aria-label') ?? ''}"`, left: box.left - grow - edge.left, top: box.top - grow - edge.top, right: edge.right - (box.right + grow), bottom: edge.bottom - (box.bottom + grow) };
}, frame);
/** Tab through what the frame holds from where the focus is; every stop must show its whole ring inside the frame. Returns the names of the stops. */
export async function walkRings(page: Page, frame: string, max: number) {
  const stops: string[] = [];
  for (let i = 0; i < max; i++) {
    const at = await ring(page, frame);
    if (!at) { break; }
    stops.push(at.name);
    expect(Math.min(at.left, at.top, at.right, at.bottom), `the ring of ${at.name} is whole inside the list (${JSON.stringify(at)})`).toBeGreaterThanOrEqual(-0.5);
    await page.keyboard.press('Tab');
  }
  return stops;
}
export const listTop = (page: Page, frame = '.day-tasks') => page.locator(frame).evaluate(el => el.scrollTop);
export const scrollList = (page: Page, to: number | 'end', frame = '.day-tasks') => page.locator(frame).evaluate((el, at) => { el.scrollTop = at === 'end' ? el.scrollHeight : at; return el.scrollTop; }, to);
/** Inside the list's own box, whole (not under its edge). */
export async function inside(page: Page, target: Locator, frame = '.day-tasks') {
  const [box, edge] = [(await target.boundingBox())!, (await page.locator(frame).boundingBox())!];
  expect(box.y, 'inside the list, top').toBeGreaterThanOrEqual(edge.y - 1);
  expect(box.y + box.height, 'inside the list, bottom').toBeLessThanOrEqual(edge.y + edge.height + 1);
}
/** The title of the done row nearest the middle of the frame's view (a row that is whole on screen), `skip` rows further down when asked. */
export const middleRow = (page: Page, frame: string, row: string, title: string, skip = 0) => page.locator(frame).evaluate((area, [rowSelector, titleSelector, below]) => {
  const edge = area.getBoundingClientRect(), mid = edge.top + edge.height / 2;
  const rows = [...area.querySelectorAll<HTMLElement>(rowSelector as string)].filter(el => { const r = el.getBoundingClientRect(); return r.top >= edge.top && r.bottom <= edge.bottom; });
  rows.sort((a, b) => Math.abs(a.getBoundingClientRect().top - mid) - Math.abs(b.getBoundingClientRect().top - mid));
  const first = rows[0], index = [...area.querySelectorAll<HTMLElement>(rowSelector as string)].indexOf(first) + (below as number);
  return area.querySelectorAll<HTMLElement>(rowSelector as string)[index].querySelector(titleSelector as string)!.textContent!.trim();
}, [row, title, skip]);
