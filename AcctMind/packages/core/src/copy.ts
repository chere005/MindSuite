/**
 * The read-only web copy: how old it is, whether it arrived whole, what
 * format it is in, and whether the iPhone that wrote it runs older rules.
 *
 * A plain browser on a real host shows the CloudKit record the iPhone mirrors
 * (`cloudkitweb.ts`, `ubiquity.ts`), and the owner, 2026-11-21: "acctmind
 * readonly seems out of date or wrong in the web". Every answer below is one
 * of the ways that page could show an old copy, or the right copy with the
 * wrong figures, without saying so. The screens only plumb.
 */
import { STORE_VERSION } from './types';

/**
 * How often an open page checks the copy again while it is visible.
 *
 * `visibilitychange` alone never fires for the MindSuite page, which keeps
 * AcctMind in an iframe and only hides it (a hidden iframe's document is still
 * "visible"), so a tab opened in the morning showed the morning's copy all
 * day. The check asks for the record's change tag only and downloads the
 * ledger only when it moved, so a minute costs one tiny request.
 */
export const COPY_REFRESH_MS = 60_000;

/**
 * When the copy was written, in ms: the server's save time first (one clock
 * for every reader), else the phone's own `written` stamp; null when neither
 * is a time. Null must never be read as "there is no copy".
 */
export function copyWrittenAt(modified: unknown, written: unknown): number | null {
  for (const t of [modified, written]) {
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

/**
 * Did the copy arrive whole? The phone declares the ledger's length in UTF-8
 * bytes beside it (`bytes`). Raw DEFLATE carries no checksum, so a length that
 * disagrees is the only sign of a damaged copy. No declaration is trusted.
 */
export function copyIntact(declared: unknown, actualBytes: number): boolean {
  return typeof declared !== 'number' || declared === actualBytes;
}

/**
 * The store-format version a copy declares, read from its first key without
 * parsing a megabyte of JSON again (`serialize` always writes `v` first).
 * Null when the text does not start that way.
 */
export function copyVersion(text: string): number | null {
  const m = /^\s*\{\s*"v"\s*:\s*(\d{1,6})\s*[,}]/.exec(text);
  return m === null ? null : Number(m[1]);
}

/**
 * Why a copy could not be read, in words for the banner.
 *
 * A copy NEWER than this page reads says so plainly: the page is what needs
 * updating, and the phone's ledger is fine. Anything else keeps the parser's
 * own reason.
 */
export function copyProblem(text: string, parseError: string): string {
  const v = copyVersion(text);
  return v !== null && v > STORE_VERSION
    ? `it is in a newer format (v${v}) than this page reads (v${STORE_VERSION}); this page needs the newer AcctMind`
    : parseError;
}

/** An older format the page upgraded to show, or null for the current one. */
export function olderFormat(text: string): number | null {
  const v = copyVersion(text);
  return v !== null && v < STORE_VERSION ? v : null;
}

/** `just now`, `5 minutes ago`, `3 hours ago`, `2 days ago`. Never negative. */
export function copyAge(ms: number, now: number): string {
  const s = Math.max(0, now - ms) / 1000;
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return say(Math.floor(s / 60), 'minute');
  if (s < 86_400) return say(Math.floor(s / 3600), 'hour');
  return say(Math.floor(s / 86_400), 'day');
}

/** `0.63.0` → [0, 63, 0]; anything that is not dotted numbers → null. */
function parts(v: string): number[] | null {
  return /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
}

/**
 * Is the iPhone's AcctMind older than this page, so the same ledger can show
 * different budget figures here (the page computes with its own, newer rules)?
 *
 *   phone undefined  — no copy read yet: nothing to say.
 *   phone null       — the record has no `app` field: written by a build from
 *                      before the field existed, which is older than any page
 *                      that reads it. (0.63.0 on 2026-11-21, against 0.71.0.)
 *   phone a version  — compared numerically with the page's.
 */
export function phoneOlder(phone: string | null | undefined, page: string | null | undefined): boolean {
  if (phone === undefined || page === undefined || page === null) return false;
  if (phone === null) return true;
  const a = parts(phone);
  const b = parts(page);
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}
