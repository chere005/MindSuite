/**
 * #167: a new note's title drops or reorders letters typed fast.
 *
 * The phone report (iOS, XCUITest speed) is that "Keyboard probe title" comes
 * back as "Kyboard probe title". The cause is iOS-only (UIKit runs queued
 * keystrokes inside an attributedText setter React Native calls on the first
 * letter; titleFieldState.ts has the trace), so the native count in
 * apps/app/uitests is the reproduction. This spec holds the web side of the
 * same fix: the title is the shared TitleInput (uncontrolled, the store
 * applied only while it is closed) and must keep every letter and the caret
 * at every speed a browser can produce:
 *
 *   - Playwright keyboard.type with zero delay and with 5-20 ms per key,
 *   - a programmatic burst of input events (native value setter + 'input',
 *     the way an IME or a fast soft keyboard delivers text),
 *   - typing that starts before the new note's id has settled (no wait for the
 *     50 ms body focus),
 *   - typing with a sync round trip in flight (the server answer is delayed so
 *     the echo lands between two bursts).
 *
 * Every case checks the literal text AND the caret: after the last key the
 * selection must sit at the end, never at 0 or in the middle.
 */
import { test, expect, type Page } from '@playwright/test';

let seq = 0;
async function signup(page: Page): Promise<string> {
  const user = `tf${Date.now()}${seq++}`;
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

async function newNote(page: Page, settle: boolean): Promise<void> {
  await page.getByTestId('tab-notes').click();
  await page.getByTestId('secadd-General').first().click();
  await expect(page.getByTestId('note-title')).toBeVisible();
  // settle=true waits for the app's own "creation is done" signal (body focus).
  if (settle) await expect(page.getByTestId('note-body-edit')).toBeFocused();
}

const caret = (page: Page) =>
  page.getByTestId('note-title').evaluate((el) => {
    const i = el as HTMLInputElement;
    return [i.selectionStart, i.selectionEnd, i.value.length];
  });

async function expectTitle(page: Page, want: string): Promise<void> {
  await expect.poll(() => page.getByTestId('note-title').inputValue(), { timeout: 5_000 }).toBe(want);
  // Let any late echo land, then check nothing moved the text or the caret.
  await page.waitForTimeout(1_500);
  expect(await page.getByTestId('note-title').inputValue()).toBe(want);
  expect(await caret(page)).toEqual([want.length, want.length, want.length]);
}

const TITLE = 'Keyboard probe title 1';

/** Types per-key with the given delay range, no waiting between sends. */
async function typeKeys(page: Page, text: string, minMs: number, maxMs: number): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch);
    if (maxMs > 0) await page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
  }
}

/** One 'input' event per character, back to back inside one task, like an IME flush. */
async function burst(page: Page, text: string): Promise<void> {
  await page.getByTestId('note-title').evaluate((el, t) => {
    const i = el as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (const ch of t) {
      const v = i.value + ch;
      set.call(i, v);
      i.setSelectionRange(v.length, v.length);
      i.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    }
  }, text);
}

for (const settle of [true, false]) {
  const phase = settle ? 'after the body focus settled' : 'immediately after the new note opened';

  test(`fast title: zero-delay keyboard.type ${phase}`, async ({ page }) => {
    await signup(page);
    await newNote(page, settle);
    await page.getByTestId('note-title').click();
    await page.keyboard.type(TITLE, { delay: 0 });
    await expectTitle(page, TITLE);
  });

  test(`fast title: 5-20 ms per key ${phase}`, async ({ page }) => {
    await signup(page);
    await newNote(page, settle);
    await page.getByTestId('note-title').click();
    await typeKeys(page, TITLE, 5, 20);
    await expectTitle(page, TITLE);
  });

  test(`fast title: a burst of input events ${phase}`, async ({ page }) => {
    await signup(page);
    await newNote(page, settle);
    await page.getByTestId('note-title').focus();
    await burst(page, TITLE);
    await expectTitle(page, TITLE);
  });
}

test('fast title: typing across an in-flight sync echo keeps every letter and the caret', async ({ page }) => {
  await signup(page);
  // Every sync answer arrives 700 ms late, so the autosave echo of the first
  // half lands while the second half is being typed.
  await page.route(/\/api\//, async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await newNote(page, true);
  await page.getByTestId('note-title').click();
  await typeKeys(page, 'Keyboard probe', 5, 20);
  await page.waitForTimeout(900); // the 800 ms autosave debounce fires; its answer is in flight
  await typeKeys(page, ' title 1', 5, 20);
  await expectTitle(page, TITLE);
  // Closed, the field shows what the store settled on once the late answers
  // are in: still every letter, not an older echo.
  await page.getByTestId('note-body-view').click();
  await page.waitForTimeout(2_500);
  await expect(page.getByTestId('note-title')).toHaveValue(TITLE);
  await page.getByTestId('note-back').click();
  await expect(page.getByTestId('note-row').filter({ hasText: TITLE })).toHaveCount(1);
});

test('fast title: a window switch mid-title (blur and focus back) keeps the field, the caret and every letter', async ({ page }) => {
  await signup(page);
  await newNote(page, true);
  await page.getByTestId('note-title').click();
  await typeKeys(page, 'Keyboard', 5, 20);
  // What a browser does when its window loses focus and gets it back: the
  // field blurs, and the SAME element is focused again, its caret where it
  // was. A field that remounted on that blur would leave nothing to come back
  // to, and the rest of the title would be typed into nothing.
  const refocused = await page.getByTestId('note-title').evaluate(async (el) => {
    const input = el as HTMLInputElement;
    input.blur();
    await new Promise((r) => setTimeout(r, 150)); // let React commit whatever the blur caused
    input.focus();
    return document.activeElement === input;
  });
  expect(refocused, 'the field that blurred is still the one in the page').toBe(true);
  await typeKeys(page, ' probe title 1', 5, 20);
  await expectTitle(page, TITLE);
});

test("fast title: a partner's shared note keeps a title typed fast and the owner gets it", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const userB = await signup(pageB);
  const userA = await signup(pageA);
  await newNote(pageA, true);
  await pageA.getByTestId('note-title').click();
  await pageA.keyboard.type('the recipe', { delay: 0 });
  await expect(pageA.getByTestId('note-title')).toHaveValue('the recipe');
  await pageA.getByTestId('note-back').click();
  await pageA.getByTestId('topbar-sync').click();
  await pageA.getByText('Settings', { exact: true }).click();
  await pageA.getByTestId('open-share').click();
  await pageA.getByTestId('share-add-partner').fill(userB);
  await pageA.getByTestId('share-add-partner').press('Enter');
  await pageA.getByTestId('share-notefolders-General').click();
  await pageA.getByText('Done', { exact: true }).click();
  await pageB.getByTestId('topbar-sync').click();
  await pageB.getByText('Settings', { exact: true }).click();
  await pageB.getByTestId('open-share').click();
  await pageB.getByTestId('share-add-partner').fill(userA);
  await pageB.getByTestId('share-add-partner').press('Enter');
  await expect(pageB.getByText('sharing', { exact: true })).toBeVisible({ timeout: 10_000 });
  await pageB.getByText('Done', { exact: true }).click();
  await pageB.getByTestId('tab-notes').click();
  await pageB.getByTestId('pick-notes').click();
  await pageB.getByTestId('pick-shared-General').click();
  await pageB.getByTestId('shared-note-row').filter({ hasText: 'the recipe' }).click();

  // B types onto the end of A's title at zero delay, a trailing space last.
  const title = pageB.getByTestId('shared-note-title');
  await title.click();
  await pageB.keyboard.press('End');
  await pageB.keyboard.type(' with garlic ', { delay: 0 });
  await expect(title).toHaveValue('the recipe with garlic ');
  // Return commits it trimmed, and the closed field shows what was saved.
  await pageB.keyboard.press('Enter');
  await expect(title).toHaveValue('the recipe with garlic');
  await pageB.getByText(/← @/).click();
  await expect(pageB.getByTestId('shared-note-row').filter({ hasText: 'the recipe with garlic' })).toBeVisible({ timeout: 10_000 });

  // The owner has it, once.
  await pageA.reload();
  await pageA.getByTestId('tab-notes').click();
  await expect(pageA.getByTestId('note-row').filter({ hasText: 'the recipe with garlic' })).toHaveCount(1, { timeout: 15_000 });
  await ctxA.close();
  await ctxB.close();
});

test('fast title: a storage-event merge from another tab mid-typing does not reorder the title', async ({ page }) => {
  await signup(page);
  await newNote(page, true);
  await page.getByTestId('note-title').click();
  await typeKeys(page, 'Keyboard', 5, 20);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'x', newValue: '{}' })));
  await typeKeys(page, ' probe title 1', 5, 20);
  await expectTitle(page, TITLE);
});

/**
 * The statistics: one new note per run, a random title typed at a random
 * speed, the literal text compared after it settles. A single clean run proves
 * nothing for an intermittent bug, so this is 200 by default (TITLE_RUNS
 * overrides) and a single dropped, doubled or swapped letter fails it.
 */
test('fast title: randomized new-note runs keep every letter in order', async ({ page }) => {
  const runs = Number(process.env.TITLE_RUNS ?? 200);
  test.setTimeout(60_000 + runs * 4_000);
  await signup(page);
  await page.getByTestId('tab-notes').click();
  let seed = 167;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const words = ['Keyboard', 'probe', 'title', 'Dentist', 'groceries', 'meeting', 'Pancakes', 'q3', 'plan', 'ideas', 'trip', 'note'];
  const bad: string[] = [];
  for (let run = 0; run < runs; run++) {
    const want = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(words)).join(' ') + ` ${run}`;
    const how = pick(['zero', 'slow', 'burst', 'mixed']);
    await page.getByTestId('secadd-General').first().click();
    await expect(page.getByTestId('note-title')).toBeVisible();
    if (rnd() < 0.5) await expect(page.getByTestId('note-body-edit')).toBeFocused();
    if (how === 'burst') {
      await page.getByTestId('note-title').focus();
      await burst(page, want);
    } else {
      await page.getByTestId('note-title').click();
      if (how === 'zero') await page.keyboard.type(want, { delay: 0 });
      else if (how === 'slow') await typeKeys(page, want, 5, 20);
      else for (const part of want.match(/.{1,4}/g)!) { await page.keyboard.type(part, { delay: 0 }); await page.waitForTimeout(rnd() * 30); }
    }
    await page.waitForTimeout(60);
    const got = await page.getByTestId('note-title').inputValue();
    const at = await caret(page);
    if (got !== want || at[0] !== want.length || at[1] !== want.length) bad.push(`run ${run} (${how}) want ${JSON.stringify(want)} got ${JSON.stringify(got)} caret ${at}`);
    await page.getByTestId('note-back').click();
    await expect(page.getByTestId('secadd-General').first()).toBeVisible();
  }
  console.log(`TITLECOUNT runs=${runs} bad=${bad.length}`);
  expect(bad, `${bad.length} of ${runs} titles differ:\n${bad.slice(0, 10).join('\n')}`).toEqual([]);
});
