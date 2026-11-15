import { afterEach, expect, test, vi } from 'vitest';
import { accountMenuHtml } from './AccountMenu';
import type { PanelContext } from '../panelContext';

const ctx = { me: 'alex', lists: [{ id: 'alex', name: 'Alex', color: 'green' }], session: { csrf: 'csrf-token' } } as unknown as PanelContext;
afterEach(() => vi.unstubAllGlobals());

test('the shared account menu has Account, Settings and the real Sign out form, in that order', () => {
  vi.stubGlobal('document', { getElementById: () => ({ dataset: { signoutAction: '/test/account/', signoutNext: '/test/account/?next=%2Ftest%2FPlanMind%2F' } }) });
  const html = accountMenuHtml(ctx, 'bar');
  expect(html).toContain('href="/test/account/?next=%2Ftest%2FPlanMind%2F" role="menuitem"');
  expect(html.indexOf('>Account</a>')).toBeLessThan(html.indexOf('>Settings</button>'));
  expect(html.indexOf('>Settings</button>')).toBeLessThan(html.indexOf('>Sign out</button>'));
  expect(html).toContain('method="post" action="/test/account/"');
  expect(html).toContain('name="csrf" type="hidden" value="csrf-token"');
});

test('a legacy account menu keeps Settings and Sign out without inventing an account destination', () => {
  vi.stubGlobal('document', { getElementById: () => ({ dataset: {} }) });
  const html = accountMenuHtml(ctx, 'drawer');
  expect(html).not.toContain('>Account</a>');
  expect(html).toContain('>Settings</button>');
  expect(html).toContain('>Sign out</button>');
});
