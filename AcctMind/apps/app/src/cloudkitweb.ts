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
 * of truth the phone never reads. Since 2026-11-21 the page SHOWS the copy as
 * it is (App.tsx `readCopy`): never merged with the browser's own ledger, and
 * nothing can be edited (core's `ledgerAccess`).
 *
 * FRESH, AND SAYS HOW OLD. The page reads again on sign-in, on a return to the
 * tab or window, and every `COPY_REFRESH_MS` while visible; each re-read first
 * asks only for the record's change tag and downloads the ledger only when it
 * moved. The record's time reaches the banner ("iPhone copy from 2 hours ago").
 *
 * Imported only by `icloudfile.web.ts`, and only used when the page is a
 * plain browser — the Tauri Mac shell reads the file itself by path.
 */
import {
  CK_APP_FIELD, CK_BYTES_FIELD, CK_ENVIRONMENT, CK_FIELD, CK_RECORD_NAME, CK_WRITTEN_FIELD, COPY_REFRESH_MS,
  UBIQUITY_CONTAINER, copyIntact, copyWrittenAt, olderFormat,
} from '@acctmind/core';
import { CK_API_TOKEN } from './cloudkitToken';

const SCRIPT = 'https://cdn.apple-cloudkit.com/ck/2/cloudkit.js';

/** Where CloudKit JS draws its own Apple ID buttons: a hidden holder, see `ensureHolder`. */
export const SIGN_IN_ID = 'acctmind-ck-sign-in';
export const SIGN_OUT_ID = 'acctmind-ck-sign-out';

/* The slice of CloudKit JS this file uses. Apple ships no types. */
type CkRecord = {
  fields: Record<string, { value: unknown } | undefined>;
  modified?: { timestamp?: number };
  recordChangeTag?: string;
};
type CkResponse = {
  hasErrors: boolean;
  errors: { ckErrorCode?: string; serverErrorCode?: string; reason?: string }[];
  records: CkRecord[];
};
type CkContainer = {
  setUpAuth(): Promise<unknown>;
  whenUserSignsIn(): Promise<unknown>;
  whenUserSignsOut(): Promise<unknown>;
  privateCloudDatabase: { fetchRecords(names: string[], options?: { desiredKeys?: string[] }): Promise<CkResponse> };
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
/** When the phone wrote the record we last read, and when we read it (ms). */
let writtenAt: number | null = null;
let readAt: number | null = null;
/** The last read reached CloudKit's answer but failed (not 'no record', not signed out). */
let failed = false;
/** CloudKit answered that there is no record: the phone has written no copy. */
let noCopy = false;
/** The app version that wrote the copy read last: undefined before one, null for a record without the field. */
let phoneApp: string | null | undefined;
/** The copy's store format when older than this page's (core's `olderFormat`). */
let older: number | null = null;
/** What the last pull saw, stamped into the state above only once the caller has read it as a ledger. */
type Seen = { written: number | null; tag: string | null; text: string; app: string | null; older: number | null };
let candidate: Seen | null = null;
/** The copy the page last read as a ledger, by change tag: an unchanged record is not downloaded again. */
let held: { tag: string; text: string } | null = null;
/** One read at a time: a poll, a focus and a Reload arriving together share it. */
let inflight: Promise<string | null> | null = null;
/** Whether CloudKit JS started at all: pending until the first answer. */
let engine: 'pending' | 'ready' | 'off' = 'pending';

const stateHandlers = new Set<() => void>();
const fireState = () => stateHandlers.forEach((h) => h());

/** What the page needs to know to decide who may edit, and what to say. */
export function state() {
  return { engine, signedIn, writtenAt, readAt, failed, noCopy, phoneApp, older };
}

/** Forget everything read under the last Apple ID. */
function forget(): void {
  lastRead = null;
  writtenAt = null;
  readAt = null;
  failed = false;
  noCopy = false;
  phoneApp = undefined;
  older = null;
  candidate = null;
  held = null;
}
export function onState(h: () => void): () => void {
  stateHandlers.add(h);
  return () => { stateHandlers.delete(h); };
}

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
 * Apple's two buttons live in a hidden holder that this file puts in <body>.
 *
 * CloudKit JS draws a fixed 218 x 40 control (inline-SVG label placed at
 * top/left 50%, tuned to that box) into the element it is given, and clicking
 * it is the only way to open the sign-in popup. The app never SHOWS it: the
 * banner and the menu draw their own buttons and forward the click here
 * (`clickSignIn` / `clickSignOut`), which keeps the user activation the popup
 * needs. An earlier version stretched Apple's control to 100% x 44 inside the
 * menu; that breaks the label's centring (it is offset by half the new width)
 * and clipped the black text in a white box, which read as a broken image.
 * It was never CSP: the control has no image, only a div and an inline SVG.
 */
function ensureHolder(): void {
  if (typeof document === 'undefined' || document.getElementById(SIGN_IN_ID)) return;
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.setAttribute('data-testid', 'ck-holder');
  holder.style.cssText = 'position:fixed;left:-1000px;top:0;width:240px;height:100px;overflow:hidden;opacity:0;pointer-events:none';
  for (const id of [SIGN_IN_ID, SIGN_OUT_ID]) {
    const slot = document.createElement('div');
    slot.id = id;
    holder.appendChild(slot);
  }
  document.body.appendChild(holder);
}

function authButton(id: string): HTMLElement | null {
  const b = document.getElementById(id)?.querySelector<HTMLElement>('.apple-auth-button') ?? null;
  return b !== null && b.style.display !== 'none' ? b : null;
}

/** Click Apple's own (hidden) sign-in control. False when it is not drawn yet. */
export function clickSignIn(): boolean {
  const b = authButton(SIGN_IN_ID);
  b?.click();
  return b !== null;
}
/** Click Apple's own (hidden) sign-out control. False when it is not drawn. */
export function clickSignOut(): boolean {
  const b = authButton(SIGN_OUT_ID);
  b?.click();
  return b !== null;
}

/** Ask CloudKit who is signed in and redraw its button after the menu mounts. */
async function auth(c: CkContainer): Promise<void> {
  try {
    signedIn = (await c.setUpAuth()) != null;
  } catch (e) {
    signedIn = false;
    loadError = `CloudKit sign-in failed: ${String(e)}`;
  } finally {
  }
}

function container(): Promise<CkContainer | null> {
  if (ready !== null) return ready;
  ready = (async () => {
    if (token() === '') return null;
    ensureHolder();
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
      engine = 'ready';
      fireState();
      return c;
    } catch (e) {
      loadError = `CloudKit would not start: ${String(e)}`;
      engine = 'off';
      fireState();
      return null;
    }
  })().then((c) => {
    if (c === null && engine === 'pending') { engine = 'off'; fireState(); }
    return c;
  });
  return ready;
}

/** Each sign-in and sign-out is news: the app re-reads on either. */
function watchSignIn(c: CkContainer): void {
  void c.whenUserSignsIn().then(() => {
    signedIn = true;
    fireState();
    fire();
    watchSignOut(c);
  }).catch(() => {});
}
function watchSignOut(c: CkContainer): void {
  void c.whenUserSignsOut().then(() => {
    signedIn = false;
    // Including `failed`: a failure from before the sign-out outranked "Sign in"
    // in the banner and said iCloud was unreachable when it was not.
    forget();
    fireState();
    fire();
    // The button comes back for the next sign-in.
    void auth(c).then(() => watchSignIn(c));
  }).catch(() => {});
}

/**
 * Resolves once CloudKit JS has answered (started, or failed), so whether a
 * session exists is known; gives up after a few seconds on a page that hangs.
 */
export async function settle(): Promise<void> {
  await Promise.race([container().then(() => undefined), new Promise<void>((r) => setTimeout(r, 3000))]);
}

/** Is there an Apple ID session that can read the record? */
export async function available(): Promise<boolean> {
  const c = await container();
  return c !== null && signedIn;
}

/** base64 → raw DEFLATE → the ledger's JSON. */
async function unpack(base64: string): Promise<{ text: string; bytes: number }> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  // The unpacked BYTES are what the phone counted (`bytes`); decoded after.
  const raw = await new Response(stream).arrayBuffer();
  return { text: new TextDecoder().decode(raw), bytes: raw.byteLength };
}

/**
 * The phone's ledger, or null when there is none to read.
 *
 * null for "no record yet" as well as for failures, which is `planSync`'s
 * absent remote: nothing merges, nothing is lost. The status line says which.
 */
export function pull(): Promise<string | null> {
  inflight ??= read().finally(() => { inflight = null; });
  return inflight;
}

async function read(): Promise<string | null> {
  const c = await container();
  if (c === null || !signedIn) return null;
  const fail = (note: string) => { lastRead = note; failed = true; candidate = null; fireState(); return null; };
  /** The answer had no record in it (handled here); null when it did. */
  const settledWithout = (res: CkResponse): true | null => {
    if (!res.hasErrors) return null;
    const err = res.errors[0];
    const code = err?.serverErrorCode ?? err?.ckErrorCode ?? 'error';
    if (code === 'NOT_FOUND' || code === 'UNKNOWN_ITEM') {
      forget();
      lastRead = 'signed in · the phone has not written a copy yet';
      readAt = Date.now();
      noCopy = true;
      fireState();
    } else if (code === 'AUTHENTICATION_REQUIRED') {
      signedIn = false;
      forget();
      fireState();
    } else {
      fail(`signed in · could not read the copy (${code})`);
    }
    return true;
  };
  const seen = (rec: CkRecord | undefined, text: string): Seen => {
    const app = rec?.fields?.[CK_APP_FIELD]?.value;
    return {
      written: copyWrittenAt(rec?.modified?.timestamp, rec?.fields?.[CK_WRITTEN_FIELD]?.value),
      tag: typeof rec?.recordChangeTag === 'string' ? rec.recordChangeTag : null,
      text,
      app: typeof app === 'string' ? app : null,
      older: olderFormat(text),
    };
  };
  const say = (s: Seen) => {
    failed = false;
    lastRead = [
      s.written !== null ? `reading the phone's copy, written ${new Date(s.written).toLocaleString()}` : "reading the phone's copy",
      ...(s.app !== null ? [`by AcctMind ${s.app}`] : []),
    ].join(' ');
  };
  try {
    // A small look first, once a copy has been read: the record's change tag
    // and its time. Unchanged, the ledger already in hand is the answer.
    if (held !== null) {
      const peek = await c.privateCloudDatabase.fetchRecords([CK_RECORD_NAME], { desiredKeys: [CK_WRITTEN_FIELD, CK_APP_FIELD] });
      if (settledWithout(peek) !== null) return null;
      const rec = peek.records[0];
      if (rec?.recordChangeTag !== undefined && rec.recordChangeTag === held.tag) {
        candidate = seen(rec, held.text);
        say(candidate);
        return held.text;
      }
    }
    const res = await c.privateCloudDatabase.fetchRecords([CK_RECORD_NAME]);
    if (settledWithout(res) !== null) return null;
    const rec = res.records[0];
    const field = rec?.fields?.[CK_FIELD]?.value;
    if (typeof field !== 'string') return fail('signed in · the copy has no ledger in it');
    const { text, bytes } = await unpack(field);
    // Raw DEFLATE has no checksum: the declared length is the only check.
    if (!copyIntact(rec?.fields?.[CK_BYTES_FIELD]?.value, bytes)) {
      return fail('signed in · the copy arrived damaged (its length is wrong)');
    }
    candidate = seen(rec, text);
    say(candidate);
    return text;
  } catch (e) {
    return fail(`signed in · reading the copy failed (${String(e)})`);
  }
}

/**
 * The caller has read what `pull` returned as a ledger: only now is it "read"
 * and "written at". A copy that would not parse never stamps a time.
 */
export function commitRead(): void {
  if (candidate === null) return;
  writtenAt = candidate.written;
  readAt = Date.now();
  noCopy = false;
  phoneApp = candidate.app;
  older = candidate.older;
  held = candidate.tag === null ? null : { tag: candidate.tag, text: candidate.text };
  candidate = null;
  fireState();
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
 * Re-read on sign-in or sign-out, when the tab or the window comes back, when
 * the network does, and every `COPY_REFRESH_MS` while the page is visible.
 *
 * The timer is not optional. The MindSuite page keeps AcctMind in an iframe
 * and only HIDES it on a tab switch, and a hidden iframe's document stays
 * "visible", so `visibilitychange` never fired there: a copy read in the
 * morning was on screen all day (2026-11-21). Each tick costs one small
 * request (see `read`); `pull` shares one read between triggers that coincide.
 * CloudKit JS can push notifications, but that needs setting up in Apple's
 * console and a socket per tab; a minute is fresh enough for a read-only view.
 */
export function onRemoteChange(handler: () => void): () => void {
  handlers.add(handler);
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => { handlers.delete(handler); };
  const visible = () => { if (document.visibilityState === 'visible') handler(); };
  const timer = setInterval(visible, COPY_REFRESH_MS);
  const events = ['focus', 'pageshow', 'online'] as const;
  document.addEventListener('visibilitychange', visible);
  for (const e of events) window.addEventListener(e, visible);
  return () => {
    handlers.delete(handler);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
    for (const e of events) window.removeEventListener(e, visible);
  };
}
