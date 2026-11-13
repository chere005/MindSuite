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
import { CK_FIELD, CK_RECORD_NAME, UBIQUITY_CONTAINER } from '@acctmind/core';
import { CK_API_TOKEN } from '../apps/app/src/cloudkitToken';
import { openMenu, rows } from './helpers';

const PHONE = JSON.stringify({
  v: 1,
  txns: [{ id: 'phone1', name: 'Rent', description: 'from the phone', amount: -185050, date: '2026-08-01', created: 1 }],
});
const PACKED = deflateRawSync(Buffer.from(PHONE, 'utf8')).toString('base64');

type Fake = { signedIn: boolean; record: string | null };

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
              b.style.cssText = 'width:218px;height:40px;border:1px solid black;box-sizing:content-box';
              b.textContent = 'Sign in with Apple ID';
              b.setAttribute('data-testid', 'fake-apple-button');
              slot.appendChild(b);
            }
            return signedIn ? { userRecordName: '_me' } : null;
          },
          whenUserSignsIn() { return new Promise<void>((res) => { signIn = res; }); },
          whenUserSignsOut() { return new Promise<void>(() => {}); },
          privateCloudDatabase: {
            async fetchRecords(names: string[]) {
              calls.push({ fetch: names });
              if (names[0] !== name || fake.record === null) {
                return { hasErrors: true, errors: [{ serverErrorCode: 'NOT_FOUND' }], records: [] };
              }
              return {
                hasErrors: false,
                errors: [],
                records: [{ fields: { [field]: { value: fake.record } }, modified: { timestamp: Date.UTC(2026, 10, 9) } }],
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

test('signed out, the cog offers the Apple ID button, and signing in reads', async ({ page }) => {
  await withCloudKit(page, { signedIn: false, record: PACKED});
  await openLedger(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();

  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText('sign in with your Apple ID');
  await expect(page.getByTestId('fake-apple-button')).toBeVisible();
  // Inside the menu, not running off its right edge (it did at 212 px).
  const button = await page.getByTestId('fake-apple-button').boundingBox();
  const note = await page.getByTestId('menu-sync').boundingBox();
  expect(button!.x + button!.width).toBeLessThanOrEqual(note!.x + note!.width);

  await page.evaluate(() => (window as unknown as { __ckSignIn: () => void }).__ckSignIn());
  // The line under the button follows the sign-in without a reopen.
  await expect(page.getByTestId('menu-sync')).toContainText("reading the phone's copy");
  await page.getByTestId('app-menu-backdrop').click({ position: { x: 5, y: 5 } });
  await expect.poll(() => rows(page)).toHaveLength(1);
});

test('no copy yet is said, and the browser ledger is left alone', async ({ page }) => {
  await withCloudKit(page, { signedIn: true, record: null});
  await openLedger(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await openMenu(page);
  await expect(page.getByTestId('menu-sync')).toContainText('has not written a copy yet');
});
