import type { SuiteAccount } from './suiteaccount';

/** Shared-session metadata comes only from the protected PHP doorway, never local storage. */
export function suiteAccount(): SuiteAccount | null {
  try {
    const raw: unknown = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="mindsuite-account"]')?.content ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.username !== 'string' || !/^[a-z0-9_-]{2,20}$/.test(a.username) || typeof a.csrf !== 'string' || !a.csrf) return null;
    for (const name of ['accountUrl', 'logoutAction', 'logoutNext']) {
      if (typeof a[name] !== 'string') return null;
      const url = new URL(a[name], location.href);
      if (url.origin !== location.origin || !/^\/(?:test\/|dev\/)?account\/$/.test(url.pathname)) return null;
    }
    return a as SuiteAccount;
  } catch { return null; }
}

export function openSuiteAccount(account: SuiteAccount): void { location.assign(account.accountUrl); }

/** A normal CSRF-protected form post ends the suite session and returns to the sign-in page. */
export function signOutSuiteAccount(account: SuiteAccount): void {
  const form = document.createElement('form');
  form.method = 'post'; form.action = account.logoutAction; form.hidden = true;
  for (const [name, value] of Object.entries({ action: 'logout', csrf: account.csrf, next: account.logoutNext })) {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
  }
  document.body.append(form);
  form.submit();
}
