/**
 * The web app reads the phone's ledger through CloudKit JS.
 *
 * The owner, 2026-11-09: "lets go with CloudKit". The phone mirrors `store.json`
 * into one CloudKit record (raw DEFLATE, base64 as CloudKit JS hands Bytes
 * over); the browser signs in with an Apple ID and merges that record into
 * its own ledger. Apple's script is never loaded here: a fake `CloudKit`
 * stands in for it, with the same calls `src/cloudkitweb.ts` makes.
 */
import { deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CK_FIELD, CK_RECORD_NAME, COPY_REFRESH_MS, STORE_VERSION, UBIQUITY_CONTAINER } from '@acctmind/core';
import { CK_API_TOKEN } from '../apps/app/src/cloudkitToken';
import { openMenu, rows } from './helpers';

const PHONE = JSON.stringify({
  v: 1,
  txns: [{ id: 'phone1', name: 'Rent', description: 'from the phone', amount: -185050, date: '2026-08-01', created: 1 }],
});
const PACKED = deflateRawSync(Buffer.from(PHONE, 'utf8')).toString('base64');
/** The same ledger after the phone added a second row. */
const PACKED2 = deflateRawSync(Buffer.from(JSON.stringify({
  v: 1,
  txns: [
    { id: 'phone1', name: 'Rent', description: 'from the phone', amount: -185050, date: '2026-08-01', created: 1 },
    { id: 'phone2', name: 'Groceries', description: 'later', amount: -4200, date: '2026-08-02', created: 2 },
  ],
}), 'utf8')).toString('base64');
/** This page's own version, which the banner compares with the iPhone's. */
const PAGE = (JSON.parse(readFileSync(join(__dirname, '../apps/app/package.json'), 'utf8')) as { version: string }).version;

type CkWindow = { __ckSet: (next: object) => void; __ckReads: { full: number; peek: number } };
const setRecord = (page: Page, next: object) => page.evaluate((n) => (window as unknown as CkWindow).__ckSet(n), next);
const reads = (page: Page) => page.evaluate(() => ({ ...(window as unknown as CkWindow).__ckReads }));

/**
 * `tag` is the record's change tag (CloudKit sends one with every record; the
 * page uses it to skip downloading an unchanged copy), `app` the iPhone app
 * that wrote it, `modified` its server time. `__ckSet` swaps the record while
 * the page is open, as the phone saving a newer one would.
 */
type Fake = { signedIn: boolean; record: string | null; tag?: string; app?: string; modified?: number; bytes?: number };

/** Install the stand-in before the app's first line runs. */
async function withCloudKit(page: Page, fake: Fake): Promise<void> {
  // Belt and braces: if the fake ever failed to install, the real script must
  // not be what answers.
  await page.route('**/cdn.apple-cloudkit.com/**', (r) => r.abort());
  await page.addInitScript(({ fake, name, field }) => {
    const w = window as unknown as Record<string, unknown>;
    let signedIn = fake.signedIn;
    let signIn: (() => void) | null = null;
    const calls: unknown[] = [];
    w.__ckCalls = calls;
    w.__ckSignIn = () => { signedIn = true; signIn?.(); };
    let current = { record: fake.record, tag: fake.tag, app: fake.app, modified: fake.modified ?? Date.UTC(2026, 10, 9), bytes: fake.bytes };
    w.__ckSet = (next: Partial<typeof current>) => { current = { ...current, ...next }; };
    const reads = { full: 0, peek: 0 };
    w.__ckReads = reads;
    w.CloudKit = {
      configure(config: unknown) { calls.push({ configure: config }); },
      getDefaultContainer() {
        return {
          async setUpAuth() {
            // CloudKit JS draws its own button into the element it was
            // given; the fake draws a stand-in so the slot can be checked.
            const slot = document.getElementById('acctmind-ck-sign-in');
            if (slot && !signedIn && slot.childElementCount === 0) {
              // Apple's real button is a fixed 218 px plus a 1 px border.
              const b = document.createElement('div');
              b.className = 'apple-auth-button';
              b.style.cssText = 'width:218px;height:40px;border:1px solid black;box-sizing:content-box';
              b.setAttribute('alt', 'Sign in with Apple ID');
              b.textContent = 'Sign in with Apple ID';
              b.setAttribute('data-testid', 'fake-apple-button');
              b.onclick = () => { signedIn = true; signIn?.(); };
              slot.appendChild(b);
            }
            return signedIn ? { userRecordName: '_me' } : null;
          },
          whenUserSignsIn() { return new Promise<void>((res) => { signIn = res; }); },
          whenUserSignsOut() { return new Promise<void>(() => {}); },
          privateCloudDatabase: {
            async fetchRecords(names: string[], options?: { desiredKeys?: string[] }) {
              calls.push({ fetch: names });
              if (names[0] !== name || current.record === null) {
                return { hasErrors: true, errors: [{ serverErrorCode: 'NOT_FOUND' }], records: [] };
              }
              // Like CloudKit: desiredKeys leaves the other fields out, never the change tag.
              const peek = options?.desiredKeys !== undefined;
              if (peek) reads.peek++; else reads.full++;
              const fields: Record<string, { value: unknown }> = peek ? {} : { [field]: { value: current.record } };
              if (current.app !== undefined) fields.app = { value: current.app };
              if (!peek && current.bytes !== undefined) fields.bytes = { value: current.bytes };
              return {
                hasErrors: false,
                errors: [],
                records: [{
                  fields, modified: { timestamp: current.modified },
                  ...(current.tag !== undefined ? { recordChangeTag: current.tag } : {}),
                }],
              };
            },
          },
        };
      },
    };
  }, { fake, name: CK_RECORD_NAME, field: CK_FIELD });
}

async function openLedger(page: Page): Promise<void> {
  await page.goto('./');
  await page.getByTestId('tab-transactions').click();
}

test('a signed-in browser shows the phone\'s ledger', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: PACKED});
  await openLedger(page);
  await expect.poll(() => rows(page)).toEqual([
    { name: 'Rent', description: 'from the phone', amount: '-$1,850.50', date: expect.any(String) },
  ]);

  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText("reading the phone's copy");
});

test('it asks the right container, in development, by the token', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: PACKED});
  await openLedger(page);
  await expect.poll(() => rows(page)).toHaveLength(1);
  const calls = await page.evaluate(() => (window as unknown as { __ckCalls: unknown[] }).__ckCalls);
  expect(calls[0]).toMatchObject({
    configure: {
      containers: [{
        containerIdentifier: UBIQUITY_CONTAINER,
        environment: 'development',
        apiTokenAuth: { apiToken: CK_API_TOKEN, persist: true },
      }],
    },
  });
});

test('signed out, the cog offers the Apple ID button, and signing in reads', async ({ page }, info) => {
  await withCloudKit(page, { signedIn: false, record: PACKED});
  await openLedger(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();

  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText('sign in with your Apple ID');
  // Apple's own control stays in the DOM (CloudKit JS needs it) but is never seen.
  await expect(page.getByTestId('fake-apple-button')).toHaveCount(1);
  expect(await page.getByTestId('ck-holder').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
  // The app's own row replaces it, the same as the other menu rows.
  const row = page.getByTestId('menu-ck-sign-in');
  await expect(row).toHaveText('Sign in with Apple ID');
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByTestId('suite-account-menu').boundingBox())!.width).toBe(216);
  await page.waitForTimeout(300); // Let the modal's fade finish before the visual proof.
  await page.screenshot({ path: info.outputPath('acctmind-apple-id-common-menu.png') });

  await row.focus();
  await page.keyboard.press('Enter');
  // The press was forwarded to Apple's control: signed in, and the read follows.
  await expect.poll(() => rows(page)).toHaveLength(1);
});

test('no copy yet is said, and the browser ledger is left alone', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: null});
  await openLedger(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText('has not written a copy yet');
});

/*
 * FRESHNESS AND AGE — the owner, 2026-11-21: "acctmind readonly seems out of
 * date or wrong in the web".
 */

test('an open page shows a newer copy without a reload, and does not download an unchanged one', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: PACKED, tag: 't1' });
  await openLedger(page);
  await expect.poll(() => rows(page)).toHaveLength(1);
  const before = await reads(page);
  // Unchanged: a return to the window asks for the change tag only.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await reads(page)).peek).toBeGreaterThan(before.peek);
  expect((await reads(page)).full).toBe(before.full);
  // The phone saves a newer copy; the next return shows it.
  await setRecord(page, { record: PACKED2, tag: 't2' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => rows(page)).toHaveLength(2);
});

test('a page left open re-reads every minute, which a hidden MindSuite frame needs', async ({ page }) => {
  // The MindSuite page only hides AcctMind's iframe, so `visibilitychange` never
  // fires there: the timer is the only thing that brings a newer copy in.
  await page.clock.install();
  await withCloudKit(page, { signedIn: true, record: PACKED, tag: 't1' });
  await openLedger(page);
  await expect.poll(() => rows(page)).toHaveLength(1);
  await setRecord(page, { record: PACKED2, tag: 't2' });
  // Nothing else brings it in: not before the minute is up.
  await page.waitForTimeout(500);
  expect(await rows(page)).toHaveLength(1);
  await page.clock.fastForward(COPY_REFRESH_MS);
  await expect.poll(() => rows(page)).toHaveLength(2);
});

test('the badge opens copy age and iPhone version details', async ({ page }) => {
  // `bytes` as the phone declares it: the unpacked length must match, or the copy is refused as damaged.
  await withCloudKit(page, {
    signedIn: true, record: PACKED, tag: 't1', modified: Date.now() - 2 * 3600_000, bytes: Buffer.byteLength(PHONE, 'utf8'),
  });
  await openLedger(page);
  await page.getByTestId('readonly-badge').click();
  const text = page.getByTestId('readonly-status-text');
  await expect(text).toContainText('iPhone copy from 2 hours ago');
  await expect.poll(() => rows(page)).toHaveLength(1);
  // No `app` on the record: written by an iPhone build from before the field.
  await expect(text).toContainText(`Your iPhone's AcctMind is older than this page (${PAGE}), so budget figures can differ`);
  await setRecord(page, { app: '0.1.0', tag: 't2' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(text).toContainText(`Your iPhone has AcctMind 0.1.0 and this page is ${PAGE}`);
  await setRecord(page, { app: PAGE, tag: 't3' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(text).not.toContainText('differ');
  await expect(text).toContainText('iPhone copy from');
});

test('a copy in a newer format than the page reads says the page needs updating', async ({ page }) => {
  const newer = deflateRawSync(Buffer.from(JSON.stringify({ v: STORE_VERSION + 1, txns: [] }), 'utf8')).toString('base64');
  await withCloudKit(page, { signedIn: true, record: newer });
  await page.goto('./');
  await page.getByTestId('readonly-badge').click();
  await expect(page.getByTestId('readonly-status-text')).toContainText(`newer format (v${STORE_VERSION + 1})`);
});

test('a copy whose unpacked length is not what the phone declared is not shown', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: PACKED, bytes: Buffer.byteLength(PHONE, 'utf8') + 1 });
  await openLedger(page);
  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText('arrived damaged');
  expect(await rows(page)).toHaveLength(0);
});
