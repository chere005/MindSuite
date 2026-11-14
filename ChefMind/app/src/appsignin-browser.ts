/**
 * App sign-in, the platform half: which browser shows the suite's /account/app/ page and how it comes back.
 *
 *  - iOS: ASWebAuthenticationSession, Android: Custom Tabs, both through expo-web-browser's auth session. The return is
 *    the app's own private-use scheme (its bundle id), `<scheme>:/signin`.
 *  - The desktop shell (a Tauri webview): the system browser, and a one-shot listener on 127.0.0.1 that the shell runs
 *    (desktop/src-tauri/src/signin.rs) for the return, `http://127.0.0.1:<port>/signin` (RFC 8252 section 7.3).
 *  - The web build uses neither: it signs in with the suite cookie (api.ts).
 */
import { Linking, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { getRandomBytes } from 'expo-crypto';
import { APP_SCHEME } from './brand';
import type { ReturnBrowser } from './appsignin';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The desktop shell's IPC (tauri.conf.json withGlobalTauri), or null. */
export function tauriInvoke(): Invoke | null {
  const t = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const f = t?.core?.invoke;
  return typeof f === 'function' ? (f as Invoke) : null;
}

export function inDesktopShell(): boolean {
  return tauriInvoke() !== null;
}

/** iOS: ASWebAuthenticationSession (not ephemeral: Safari's cookies and password managers apply); Android: a Custom Tab. */
export function nativeBrowser(scheme: string): ReturnBrowser {
  return {
    prepare: async () => `${scheme}:/signin`,
    open: async (url, returnTo) => {
      const r = await WebBrowser.openAuthSessionAsync(url, returnTo, { preferEphemeralSession: false });
      return r.type === 'success' ? r.url : null;
    },
    cancel: async () => {
      try { WebBrowser.dismissAuthSession(); } catch { /* nothing to dismiss */ }
    },
  };
}

/** The desktop shell: the system browser, and the shell's loopback listener for the return. */
export function desktopBrowser(invoke: Invoke): ReturnBrowser {
  return {
    prepare: async (state) => {
      const port = await invoke('signin_listen', { state });
      return `http://127.0.0.1:${String(port)}/signin`;
    },
    open: async (url, returnTo) => {
      try {
        await invoke('open_in_browser', { url });
      } catch {
        throw new Error('Could not open your browser.');
      }
      let q: unknown;
      try {
        q = await invoke('signin_wait');
      } catch (e) {
        throw new Error(String(e) === 'timeout' || (e as { message?: string } | null)?.message === 'timeout'
          ? 'The browser did not come back. Press Sign in to try again.'
          : 'Could not sign in. Try again.');
      }
      return typeof q === 'string' ? `${returnTo}?${q}` : null;
    },
    cancel: async () => {
      try { await invoke('signin_cancel'); } catch { /* nothing was waiting */ }
    },
  };
}

/** Which browser this build signs in with: the desktop shell first, then iOS/Android with a scheme, else null (the web build). */
export function returnBrowser(): ReturnBrowser | null {
  const invoke = tauriInvoke();
  if (invoke) return desktopBrowser(invoke);
  if ((Platform.OS === 'ios' || Platform.OS === 'android') && APP_SCHEME) return nativeBrowser(APP_SCHEME);
  return null;
}

/** The platform's secure random bytes. */
export function randomBytes(n: number): Uint8Array {
  return getRandomBytes(n);
}

/** "Manage your account": the desktop shell's system browser (the page cannot open one itself), else the platform's link opener. */
export async function openInBrowser(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke('open_in_browser', { url });
    return;
  }
  await Linking.openURL(url);
}
