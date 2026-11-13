import { expect, test, type Locator, type Page } from '@playwright/test';
import { periodStart } from '../packages/core/src/planner';
import { apiLogin, farDate, field, leaveField, login, pickList, resetPrefs, showTodos, todo, type Api } from './helpers';
import { OWNER, PARTNER, OWNER_NAME, PARTNER_NAME } from './people';

/**
 * Enter on a to-do keeps writing the same person's list. Under the Both view a blank line of a to-do list is aimed at the owner's side, the
 * partner's side or both; Enter adds the to-do and the keyboard lands on the add line, which is for the SAME people as the to-do just
 * entered (its color, its name, its add), not for whoever the top picker says (both of us). The people are remembered only while the person
 * keeps writing: the picker, the day or period, another blank line, Escape and the focus leaving the line all end it, and an add line nobody
 * came to by Enter follows the picker as before. Shared by the desktop spec and the phone spec; `phone` says which one is running.
 */
type Scope = 'day' | 'week' | 'month';
type Side = { name: string; across: number; owners: string[]; color: string; label: string };
// On a phone's Week and Month add line the first 15% of the line is covered by the screen reader's hidden "Add to-do for both" button (a separate,
// older layout fact, not part of this change), so the owner's side is tapped at 30%, still in the left third, over the field.
const ALL: Side[] = [
  { name: 'the owner\'s side', across: 0.12, owners: [OWNER], color: 'green', label: `New to-do for ${OWNER_NAME}` },
  { name: 'the partner\'s side', across: 0.9, owners: [PARTNER], color: 'yellow', label: `New to-do for ${PARTNER_NAME}` },
  { name: 'both', across: 0.5, owners: [OWNER, PARTNER], color: 'purple', label: `New to-do for ${OWNER_NAME} and ${PARTNER_NAME}` },
];
const BOTH = [OWNER, PARTNER];

export function enterOwnerSuite(phone: boolean, base: number) {
  const SIDES = ALL.map((side, i) => (phone && i === 0 ? { ...side, across: 0.3 } : side));
  test.afterEach(async ({ baseURL }) => { await resetPrefs(baseURL!); });
  const jump = (page: Page, date: string) => page.locator(phone ? '#pill-date' : '#jump-date').fill(date);
  const line = (page: Page, scope: Scope, n: number) => page.locator(scope === 'day' ? `.day-tasks > li[data-slot="${n}"]` : `ul.wm-todos[aria-label="To-do"] > li[data-slot="${n}"]`);
  const addLine = (page: Page, scope: Scope) => page.locator(scope === 'day' ? '.day-free-add' : '.wm-free-add');
  const addInput = (page: Page, scope: Scope) => page.locator(scope === 'day' ? '.day-add-title' : '.wm-add-title');
  const when = (scope: Scope, n: number) => (scope === 'day' ? farDate(base + n) : periodStart(farDate(base + n), scope));
  const stored = async (api: Api, scope: Scope, date: string) => (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && t.date === date).sort((a: { pos?: number }, b: { pos?: number }) => (a.pos ?? 0) - (b.pos ?? 0));
  const owned = (tasks: { title: string; owners: string[] }[]) => Object.fromEntries(tasks.map(t => [t.title, t.owners]));
  async function clear(api: Api, scope: Scope, dates: string[]) {
    for (const task of (await api.snapshot()).tasks.filter((t: { scope: string; date: string }) => t.scope === scope && dates.includes(t.date))) {
      await api.post({ action: 'delete', id: task.id, revision: task.revision, confirm: true });
    }
  }
  /** A pointer click, or a finger's tap, `across` (0 to 1) of the way along a line. */
  async function aim(page: Page, target: Locator, across: number) {
    const box = (await target.boundingBox())!, x = box.x + box.width * across, y = box.y + box.height / 2;
    if (phone) { await page.touchscreen.tap(x, y); } else { await page.mouse.click(x, y); }
  }
  async function open(page: Page, scope: Scope, date: string) {
    if (scope === 'day') {
      await jump(page, date);
      await expect(page.locator('#sidebar .date-row.selected')).toHaveAttribute('data-date', date);
    } else {
      if (phone) { await page.getByRole('button', { name: 'Open menu', exact: true }).click(); }
      await page.getByRole('button', { name: scope === 'week' ? 'Week' : 'Month', exact: true }).click();
      if (phone) { await page.keyboard.press('Escape'); }
      await jump(page, date);
      await expect(page.locator(`.wm-panel[data-panel="${scope}"]`)).toBeVisible();
    }
    await showTodos(page);
    await expect(addLine(page, scope)).toBeVisible();
  }
  /** Types into the focused field and presses Enter. */
  async function typeEnter(page: Page, text: string) { await page.keyboard.type(text); await page.keyboard.press('Enter'); }
  const added = (page: Page, title: string) => expect(page.getByRole('button', { name: `Edit ${title}`, exact: true })).toBeVisible();
  for (const scope of ['day', 'week', 'month'] as const) {
    test.describe(`${scope} to-do: Enter keeps the people of the line`, () => {
      for (const [i, side] of SIDES.entries()) {
        test(`a line aimed at ${side.name}: a run of Enters adds every to-do for ${side.name} only`, async ({ page, baseURL }) => {
          const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 10 + i);
          try {
            await login(page); await open(page, scope, date);
            await aim(page, line(page, scope, 1), side.across);
            await expect(field(page, side.label)).toBeFocused();
            await typeEnter(page, 'First');
            await added(page, 'First');
            await expect(addInput(page, scope)).toBeFocused();
            await typeEnter(page, 'Second');
            await added(page, 'Second');
            await expect(addInput(page, scope)).toBeFocused();
            await typeEnter(page, 'Third');
            await added(page, 'Third');
            expect(owned(await stored(owner, scope, date))).toEqual({ First: side.owners, Second: side.owners, Third: side.owners });
          } finally { await clear(owner, scope, [date]); await owner.dispose(); }
        });

        test(`a line aimed at ${side.name}: the add line the keyboard lands on wears that color and name`, async ({ page, baseURL }) => {
          const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 15 + i);
          try {
            await login(page); await open(page, scope, date);
            await aim(page, line(page, scope, 1), side.across);
            await expect(field(page, side.label)).toBeFocused();
            await typeEnter(page, 'First');
            await added(page, 'First');
            await expect(addInput(page, scope)).toBeFocused();
            await expect(addLine(page, scope)).toHaveAttribute('data-c', side.color);
            await expect(addInput(page, scope)).toHaveAttribute('aria-label', side.label);
          } finally { await clear(owner, scope, [date]); await owner.dispose(); }
        });
      }

      test('an add line nobody came to by Enter follows the picker, and Both leaves nothing carried', async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 20);
        try {
          await login(page); await open(page, scope, date);
          await addInput(page, scope).focus();
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          await typeEnter(page, 'Picked both');
          await added(page, 'Picked both');
          await expect(addInput(page, scope)).toBeFocused();
          await typeEnter(page, 'Still both');
          await added(page, 'Still both');
          await pickList(page, PARTNER_NAME);
          await addInput(page, scope).focus();
          await typeEnter(page, 'Picked partner');
          await added(page, 'Picked partner');
          expect(owned(await stored(owner, scope, date))).toEqual({ 'Picked both': BOTH, 'Still both': BOTH, 'Picked partner': [PARTNER] });
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });
    });
  }

  test.describe('the people last only while the person keeps writing', () => {
    /** One to-do for the owner alone through the add line, so the line is carried. Returns with the keyboard on that line. */
    async function carried(page: Page, scope: Scope) {
      await aim(page, line(page, scope, 1), SIDES[0].across);
      await expect(field(page, SIDES[0].label)).toBeFocused();
      await typeEnter(page, 'Mine');
      await added(page, 'Mine');
      await expect(addInput(page, scope)).toBeFocused();
      await expect(addLine(page, scope)).toHaveAttribute('data-c', 'green');
    }
    /** Then writes one more through the add line, from wherever the focus is, and says who it was for. */
    async function next(page: Page, scope: Scope, owner: Api, date: string, title: string) {
      await addInput(page, scope).focus();
      await typeEnter(page, title);
      await added(page, title);
      return owned(await stored(owner, scope, date))[title];
    }

    for (const scope of ['day', 'week'] as const) {
      test(`${scope}: the picker changing drops them, and choosing the first picker again does not bring them back`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 30);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          await pickList(page, PARTNER_NAME);
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          expect(await next(page, scope, owner, date, 'For partner')).toEqual([PARTNER]);
          await pickList(page, 'Both');
          expect(await next(page, scope, owner, date, 'For both')).toEqual(BOTH);
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });

      test(`${scope}: another ${scope === 'day' ? 'day' : 'week'} drops them`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 40), other = when(scope, 60);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          await jump(page, other);
          await showTodos(page);
          await expect(addLine(page, scope)).toBeVisible();
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          expect(await next(page, scope, owner, other, 'Elsewhere')).toEqual(BOTH);
          await jump(page, date);
          await showTodos(page);
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          expect(await next(page, scope, owner, date, 'Back')).toEqual(BOTH);
        } finally { await clear(owner, scope, [date, other]); await owner.dispose(); }
      });

      test(`${scope}: aiming at another blank line drops them (the new line carries its own people)`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 50);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          await aim(page, line(page, scope, 5), SIDES[1].across);
          await expect(field(page, SIDES[1].label)).toBeFocused();
          await typeEnter(page, 'Hers');
          await added(page, 'Hers');
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          expect(await next(page, scope, owner, date, 'After')).toEqual(BOTH);
          expect(owned(await stored(owner, scope, date))).toMatchObject({ Mine: [OWNER], Hers: [PARTNER] });
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });

      test(`${scope}: aiming the add line again at both takes the new people`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 55);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          // The add line is now the second line: its middle third is for both, its outer thirds for one person.
          await aim(page, addLine(page, scope), SIDES[2].across);
          await expect(field(page, SIDES[2].label)).toBeFocused();
          await typeEnter(page, 'Together');
          await added(page, 'Together');
          await expect(addLine(page, scope)).toHaveAttribute('data-c', 'purple');
          await typeEnter(page, 'Together too');
          await added(page, 'Together too');
          await aim(page, addLine(page, scope), SIDES[1].across);
          await expect(field(page, SIDES[1].label)).toBeFocused();
          await typeEnter(page, 'Hers');
          await added(page, 'Hers');
          await expect(addLine(page, scope)).toHaveAttribute('data-c', 'yellow');
          expect(owned(await stored(owner, scope, date))).toMatchObject({ Mine: [OWNER], Together: BOTH, 'Together too': BOTH, Hers: [PARTNER] });
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });
    }

    test('day: Escape in the carried add line drops them', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = when('day', 70);
      try {
        await login(page); await open(page, 'day', date);
        await carried(page, 'day');
        await page.keyboard.press('Escape');
        await expect(addLine(page, 'day')).not.toHaveAttribute('data-c', /.+/);
        expect(await next(page, 'day', owner, date, 'After Escape')).toEqual(BOTH);
      } finally { await clear(owner, 'day', [date]); await owner.dispose(); }
    });

    test('week: Escape in the carried add line drops them', async ({ page, baseURL }) => {
      const owner = await apiLogin(baseURL!, OWNER), date = when('week', 71);
      try {
        await login(page); await open(page, 'week', date);
        await carried(page, 'week');
        await page.keyboard.press('Escape');
        await expect(addLine(page, 'week')).not.toHaveAttribute('data-c', /.+/);
        expect(await next(page, 'week', owner, date, 'After Escape')).toEqual(BOTH);
      } finally { await clear(owner, 'week', [date]); await owner.dispose(); }
    });

    for (const scope of ['day', 'week'] as const) {
      test(`${scope}: the focus leaving the line drops them`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 80);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          await leaveField(page);
          await expect(addLine(page, scope)).not.toHaveAttribute('data-c', /.+/);
          expect(await next(page, scope, owner, date, 'After leaving')).toEqual(BOTH);
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });

      test(`${scope}: the Add button is still the line: it adds for the carried people and the line stays carried`, async ({ page, baseURL }) => {
        const owner = await apiLogin(baseURL!, OWNER), date = when(scope, 85);
        try {
          await login(page); await open(page, scope, date);
          await carried(page, scope);
          await page.keyboard.type('By button');
          const go = page.getByRole('button', { name: 'Add', exact: true });
          if (phone) { await go.tap(); } else { await go.click(); }
          await added(page, 'By button');
          await expect(addInput(page, scope)).toBeFocused();
          await expect(addLine(page, scope)).toHaveAttribute('data-c', 'green');
          expect(owned(await stored(owner, scope, date))).toMatchObject({ Mine: [OWNER], 'By button': [OWNER] });
        } finally { await clear(owner, scope, [date]); await owner.dispose(); }
      });
    }
  });

  test('day: a carried line that fills the person\'s list behaves as the full add line does: it goes, with the message', async ({ page, baseURL }) => {
    const owner = await apiLogin(baseURL!, OWNER), date = when('day', 90);
    try {
      for (let i = 0; i < 11; i++) { expect((await owner.post(todo({ date, owners: [OWNER], title: `Filler ${i}` }))).ok()).toBe(true); }
      await login(page); await open(page, 'day', date);
      await aim(page, addLine(page, 'day'), SIDES[0].across);
      await expect(field(page, SIDES[0].label)).toBeFocused();
      await typeEnter(page, 'Twelfth');
      await added(page, 'Twelfth');
      // Room for one more: the carried line is still there, for the owner.
      await expect(addInput(page, 'day')).toBeFocused();
      await expect(addLine(page, 'day')).toHaveAttribute('data-c', 'green');
      await typeEnter(page, 'Thirteenth');
      await added(page, 'Thirteenth');
      await expect(addInput(page, 'day')).toHaveCount(0);
      await expect(page.locator('.day-msg')).toHaveText(`${OWNER_NAME} already has 13 things to do that day.`);
      expect((await stored(owner, 'day', date)).filter((t: { owners: string[] }) => t.owners.length === 1 && t.owners[0] === OWNER)).toHaveLength(13);
    } finally { await clear(owner, 'day', [date]); await owner.dispose(); }
  });
}
