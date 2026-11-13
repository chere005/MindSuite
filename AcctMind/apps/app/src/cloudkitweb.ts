/**
 * The phone's ledger, read in a BROWSER through CloudKit JS.
 *
 * The owner, 2026-11-09: make the web app read his iCloud data, then "lets go
 * with CloudKit". A web page cannot reach iCloud Drive, so the phone mirrors
 * `store.json` into one record in the container's private database (see the
 * Swift module), and this file reads that record after an Apple ID sign-in.
 *
 * READ-ONLY. `push` never writes: the record is a copy of the file the
 * devices sync through, and a browser writing it would be a second source
 * of truth the phone never reads. What the browser gets goes through
 * `planSync` like every other transport, so it MERGES into the browser's
 * own ledger; changes made here stay here.
 *
 * Imported only by `icloudfile.web.ts`, and only used when the page is a
 * plain browser — the Tauri Mac shell reads the file itself by path.
 */
import {
  CK_ENVIRONMENT, CK_FIELD, CK_RECORD_NAME, UBIQUITY_CONTAINER,
} from '@acctmind/core';
import { CK_API_TOKEN } from './cloudkitToken';

const SCRIPT = 'https://cdn.apple-cloudkit.com/ck/2/cloudkit.js';

/** Where CloudKit JS draws its own Apple ID buttons; the cog menu holds them. */
export const SIGN_IN_ID = 'acctmind-ck-sign-in';
export const SIGN_OUT_ID = 'acctmind-ck-sign-out';

/* The slice of CloudKit JS this file uses. Apple ships no types. */
type CkRecord = { fields: Record<string, { value: unknown } | undefined>; modified?: { timestamp?: number } };
type CkResponse = {
  hasErrors: boolean;
  errors: { ckErrorCode?: string; serverErrorCode?: string; reason?: string }[];
  records: CkRecord[];
};
type CkContainer = {
  setUpAuth(): Promise<unknown>;
  whenUserSignsIn(): Promise<unknown>;
  whenUserSignsOut(): Promise<unknown>;
  privateCloudDatabase: { fetchRecords(names: string[]): Promise<CkResponse> };
};
type CloudKitJs = {
  configure(config: unknown): unknown;
  getDefaultContainer(): CkContainer;
};

type Win = { CloudKit?: CloudKitJs };
const win = (): Win => globalThis as unknown as Win;

function token(): string {
  return CK_API_TOKEN;
}

/** Configured once per page; null until then, or when it cannot be. */
let ready: Promise<CkContainer | null> | null = null;
let loadError: string | null = null;
let signedIn = false;
/** What the last read found, for the status line. */
let lastRead: string | null = null;

const handlers = new Set<() => void>();
const fire = () => handlers.forEach((h) => h());

function loadScript(): Promise<CloudKitJs | null> {
  const w = win();
  if (w.CloudKit) return Promise.resolve(w.CloudKit);
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = SCRIPT;
    tag.async = true;
    tag.onload = () => resolve(win().CloudKit ?? null);
    tag.onerror = () => { loadError = 'could not load CloudKit JS'; resolve(null); };
    document.head.appendChild(tag);
  });
}

/**
 * Ask CloudKit who is signed in, which is also what draws the Apple ID
 * button into `SIGN_IN_ID` when nobody is. Called again whenever the cog
 * menu opens, because the button's element only exists while it is open.
 */
async function auth(c: CkContainer): Promise<void> {
  try {
    signedIn = (await c.setUpAuth()) != null;
  } catch (e) {
    signedIn = false;
    loadError = `CloudKit sign-in failed: ${String(e)}`;
  }
}

function container(): Promise<CkContainer | null> {
  if (ready !== null) return ready;
  ready = (async () => {
    if (token() === '') return null;
    const ck = await loadScript();
    if (ck === null) return null;
    try {
      ck.configure({
        containers: [{
          containerIdentifier: UBIQUITY_CONTAINER,
          apiTokenAuth: {
            apiToken: token(),
            persist: true,
            signInButton: { id: SIGN_IN_ID, theme: 'white-with-outline' },
            signOutButton: { id: SIGN_OUT_ID, theme: 'white-with-outline' },
          },
          environment: CK_ENVIRONMENT,
        }],
      });
      const c = ck.getDefaultContainer();
      await auth(c);
      watchSignIn(c);
      return c;
    } catch (e) {
      loadError = `CloudKit would not start: ${String(e)}`;
      return null;
    }
  })();
  return ready;
}

/** Each sign-in and sign-out is news: the app re-reads on either. */
function watchSignIn(c: CkContainer): void {
  void c.whenUserSignsIn().then(() => {
    signedIn = true;
    fire();
    watchSignOut(c);
  }).catch(() => {});
}
function watchSignOut(c: CkContainer): void {
  void c.whenUserSignsOut().then(() => {
    signedIn = false;
    lastRead = null;
    fire();
    // The button comes back for the next sign-in.
    void auth(c).then(() => watchSignIn(c));
  }).catch(() => {});
}

/** Is there an Apple ID session that can read the record? */
export async function available(): Promise<boolean> {
  const c = await container();
  return c !== null && signedIn;
}

/** base64 → raw DEFLATE → the ledger's JSON. */
async function unpack(base64: string): Promise<string> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/**
 * The phone's ledger, or null when there is none to read.
 *
 * null for "no record yet" as well as for failures, which is `planSync`'s
 * absent remote: nothing merges, nothing is lost. The status line says which.
 */
export async function pull(): Promise<string | null> {
  const c = await container();
  if (c === null || !signedIn) return null;
  try {
    const res = await c.privateCloudDatabase.fetchRecords([CK_RECORD_NAME]);
    if (res.hasErrors) {
      const err = res.errors[0];
      const code = err?.serverErrorCode ?? err?.ckErrorCode ?? 'error';
      if (code === 'NOT_FOUND' || code === 'UNKNOWN_ITEM') {
        lastRead = 'signed in · the phone has not written a copy yet';
      } else if (code === 'AUTHENTICATION_REQUIRED') {
        signedIn = false;
        lastRead = null;
      } else {
        lastRead = `signed in · could not read the copy (${code})`;
      }
      return null;
    }
    const rec = res.records[0];
    const field = rec?.fields[CK_FIELD]?.value;
    if (typeof field !== 'string') {
      lastRead = 'signed in · the copy has no ledger in it';
      return null;
    }
    const text = await unpack(field);
    const when = rec?.modified?.timestamp;
    lastRead = when
      ? `reading the phone's copy, written ${new Date(when).toLocaleString()}`
      : "reading the phone's copy";
    return text;
  } catch (e) {
    lastRead = `signed in · reading the copy failed (${String(e)})`;
    return null;
  }
}

/** Never writes. See the header. */
export async function push(_value: string): Promise<boolean> {
  return false;
}

/** One line for the cog menu, which is also where the Apple ID button is. */
export async function status(): Promise<string> {
  if (token() === '') return 'the web copy is not set up (no CloudKit token)';
  const c = await container();
  if (c === null) return loadError ?? 'CloudKit is not available';
  // The menu has just opened; give the button's element a frame to exist,
  // then ask again so CloudKit draws into it.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await auth(c);
  if (!signedIn) return "sign in with your Apple ID to read the phone's ledger";
  // Just signed in from this menu, and the app's own read may not have
  // answered yet: read once here so the line says what is there.
  if (lastRead === null) await pull();
  return lastRead ?? 'signed in';
}

/**
 * Re-read when the tab comes back, and on sign-in or sign-out. CloudKit JS
 * can push notifications, but a tab you are looking at again is the moment
 * a fresh read is wanted, and it needs nothing set up in Apple's console.
 */
export function onRemoteChange(handler: () => void): () => void {
  handlers.add(handler);
  const visible = () => { if (document.visibilityState === 'visible') handler(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
  return () => {
    handlers.delete(handler);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible);
  };
}
