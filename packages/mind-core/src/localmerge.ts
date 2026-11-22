/**
 * NO-ACCOUNT LOCAL MODE: the records a person made on this device before they
 * had an account, carried into the account they then sign in to (or sign up
 * for). Behind a build flag in each app (its src/accountmode.ts); with the flag
 * off nothing calls this module.
 *
 * The local store is an ordinary snapshot under its own key. Its user part is
 * LOCAL_USER, which no account can ever be called: usernames match
 * /^[A-Za-z0-9_-]{2,20}$/ and '~' is not in that set.
 *
 * Signing in folds the local records into the account's engine with sync's own
 * merge (SyncEngine.mergeSnapshot), every adopted record DIRTY so the next sync
 * pushes it, then writes the merged account snapshot, and only once that write
 * has landed deletes the local one. A failure at any step leaves the local
 * snapshot where it was: the device's only copy of those records is never the
 * thing a failed write costs. Re-running the whole adoption against an account
 * that already holds the result is a no-op (every local copy loses to the
 * account's same-or-newer stamp), which is what makes a crash between the steps
 * safe to recover from by simply doing it again.
 *
 * The one thing a plain merge gets wrong is the STARTERS. normalize seeds each
 * app's starter containers (the Reminders and General folders, the ride-along
 * Calendar folder, the Personal calendar, the Habits section; MealMind's
 * shopping list and pantry) with fresh random ids, so a local store and an
 * account each hold their own. Merged as they are, an account would end up with
 * two of each — and MealMind's shopping screen shows only the FIRST folder that
 * carries the flag, so the local list's rows would be on the account and on no
 * screen. foldAdopted moves what an adopted starter holds into the account's
 * own one and retires the adopted container instead.
 */
import type { AnyRec, Rec } from './types';
import { folderApp } from './types';
import { byRecOrd } from './order';
import { CALENDAR_STARTER, FOLDER_NOTES_STARTER, FOLDER_STARTER, HABIT_SECTION_STARTER } from './normalize';
import type { Snapshot, SyncEngine } from './sync';

/** The user part of the local store's keys. Never a username (see above). */
export const LOCAL_USER = '~local';

/** The server's username rule, mirrored so a test can prove LOCAL_USER is outside it. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,20}$/;

/**
 * Types that belong to an account and never to a device alone: sharing, and
 * CalMind's public meeting requests (written by the server) and the
 * availability overrides that answer them. Local mode hides every screen that
 * writes them; anything of these types in a local store is dropped rather than
 * pushed over the account's own.
 */
const ACCOUNT_ONLY: ReadonlySet<string> = new Set(['share', 'meetreq', 'meetavail']);

/**
 * The stamp a local pref record is adopted with: older than any real edit, so
 * it loses to the account's copy wherever the account has one and is taken
 * only where it does not. Prefs are ONE record per app (prefsId) merged whole,
 * so a theme picked while local would otherwise overwrite every setting the
 * account had (its partner colours, folder modes, planned recipe days).
 */
export const ADOPTED_PREF_STAMP = 1;

export type ParsedSnapshot = { kind: 'none' } | { kind: 'ok'; snap: Snapshot } | { kind: 'damaged' };

/**
 * A stored snapshot, read without trusting it. 'damaged' is not 'none': for a
 * LOCAL store the bytes on disk are the only copy there is, so the caller
 * moves them aside (or refuses to write over them) instead of starting empty
 * and saving over the top.
 */
export function parseSnapshot(raw: string | null): ParsedSnapshot {
  if (raw === null) return { kind: 'none' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { kind: 'damaged' };
  }
  const s = v as Partial<Snapshot> | null;
  if (
    !s || typeof s !== 'object'
    || typeof s.cursor !== 'number'
    || !Array.isArray(s.recs) || !Array.isArray(s.dirty)
    || !s.recs.every((r) => !!r && typeof r === 'object' && typeof (r as AnyRec).id === 'string' && typeof (r as AnyRec).type === 'string')
    || !s.dirty.every((id) => typeof id === 'string')
  ) {
    return { kind: 'damaged' };
  }
  return { kind: 'ok', snap: s as Snapshot };
}

/**
 * The local store as something to merge INTO an account: its live records
 * (a local tombstone deletes nothing the account holds — local ids are its
 * own), minus the account-only types, prefs demoted to ADOPTED_PREF_STAMP,
 * cursor 0 so the account's cursor never moves, and every record listed dirty
 * so mergeSnapshot marks each one it adopts for the next push.
 */
export function adoptionSnapshot(local: Snapshot): Snapshot {
  const recs: AnyRec[] = [];
  for (const r of local.recs) {
    if (r.deleted || ACCOUNT_ONLY.has(r.type)) continue;
    recs.push(r.type === 'pref' ? ({ ...r, updated: ADOPTED_PREF_STAMP } as AnyRec) : r);
  }
  return { cursor: 0, recs, dirty: recs.map((r) => r.id) };
}

/**
 * What makes a container a STARTER, for matching one store's against the
 * other's: the flag where the flag is the identity (shopping, pantry, the
 * ride-along folder), otherwise the starter's own name in the right app. A
 * renamed starter is the person's own container and matches nothing.
 */
export function seedIdentity(r: AnyRec): string | null {
  if (r.deleted) return null;
  if (r.type === 'folder') {
    const p = r.payload;
    if (p.shopping) return 'folder:shopping';
    if (p.pantry) return 'folder:pantry';
    if (p.rideAlong) return 'folder:rideAlong';
    const app = folderApp(p);
    if (app === 'reminders' && p.name === FOLDER_STARTER) return `folder:reminders:${FOLDER_STARTER}`;
    if (app === 'notes' && p.name === FOLDER_NOTES_STARTER) return `folder:notes:${FOLDER_NOTES_STARTER}`;
    return null;
  }
  if (r.type === 'calendar' && r.payload.name === CALENDAR_STARTER) return `calendar:${CALENDAR_STARTER}`;
  if (r.type === 'habitsection' && r.payload.name === HABIT_SECTION_STARTER) return `habitsection:${HABIT_SECTION_STARTER}`;
  return null;
}

type Item = Rec<'reminder'> | Rec<'note'>;

/**
 * Fold every ADOPTED starter into the account's own starter of the same
 * identity, where the account has one. Returns the records to put (the caller
 * stamps them through the engine); nothing in `recs` is modified.
 *
 *  - A flagged list (shopping, pantry): its rows move into the account list's
 *    first section, because that list's screen draws one section only.
 *  - Any other folder: a section the account's folder already has BY NAME
 *    (its 'General', say) hands its items to that one and is retired; any
 *    other section moves across whole, and every item follows (folderId).
 *  - A calendar or habit section: its events or habits are re-pointed.
 *
 * The adopted container is then tombstoned. An adopted starter with no account
 * counterpart is left alone: it simply becomes the account's (a new account).
 * Two adopted containers never fold into each other, and a counterpart is
 * chosen by order so the answer is the same on every run.
 */
export function foldAdopted(recs: readonly AnyRec[], adopted: ReadonlySet<string>): AnyRec[] {
  const live = recs.filter((r) => !r.deleted);
  const out = new Map<string, AnyRec>();
  const cur = <T extends AnyRec>(r: T): T => (out.get(r.id) as T | undefined) ?? r;
  const put = (r: AnyRec) => out.set(r.id, r);

  const counterpart = new Map<string, AnyRec>();
  const containers = live
    .filter((r): r is Rec<'folder'> | Rec<'calendar'> | Rec<'habitsection'> =>
      r.type === 'folder' || r.type === 'calendar' || r.type === 'habitsection')
    .sort(byRecOrd);
  for (const r of containers) {
    if (adopted.has(r.id)) continue;
    const id = seedIdentity(r);
    if (id && !counterpart.has(id)) counterpart.set(id, r);
  }

  const sectionsOf = (folderId: string) =>
    live.filter((r): r is Rec<'section'> => r.type === 'section' && r.payload.folderId === folderId).sort(byRecOrd);
  const items = live.filter((r): r is Item => r.type === 'reminder' || r.type === 'note');

  for (const c of containers) {
    if (!adopted.has(c.id)) continue;
    const ident = seedIdentity(c);
    const k = ident ? counterpart.get(ident) : undefined;
    if (!k) continue;
    if (c.type === 'folder') {
      const flagged = !!(c.payload.shopping || c.payload.pantry);
      const mine = sectionsOf(c.id);
      if (flagged) {
        const target = sectionsOf(k.id)[0];
        if (!target) continue; // nowhere to put the rows: keep the folder, lose nothing
        for (const it of items) {
          if (it.payload.folderId !== c.id) continue;
          const now = cur(it);
          put({ ...now, payload: { ...now.payload, folderId: k.id, sectionId: target.id } } as AnyRec);
        }
        for (const sec of mine) put({ ...cur(sec), deleted: true });
      } else {
        // A section the account's folder already has by name takes this
        // one's items; any other section moves across whole.
        const theirs = new Map<string, Rec<'section'>>();
        for (const sec of sectionsOf(k.id)) if (!theirs.has(sec.payload.name)) theirs.set(sec.payload.name, sec);
        const into = new Map<string, string>();
        for (const sec of mine) {
          const now = cur(sec);
          const same = theirs.get(sec.payload.name);
          if (same) {
            into.set(sec.id, same.id);
            put({ ...now, deleted: true });
          } else {
            put({ ...now, payload: { ...now.payload, folderId: k.id } });
          }
        }
        for (const it of items) {
          if (it.payload.folderId !== c.id) continue;
          const now = cur(it);
          const sectionId = into.get(it.payload.sectionId) ?? it.payload.sectionId;
          put({ ...now, payload: { ...now.payload, folderId: k.id, sectionId } } as AnyRec);
        }
      }
    } else if (c.type === 'calendar') {
      for (const ev of live) {
        if (ev.type !== 'event' || ev.payload.calendarId !== c.id) continue;
        const now = cur(ev);
        put({ ...now, payload: { ...now.payload, calendarId: k.id } });
      }
    } else {
      for (const h of live) {
        if (h.type !== 'habit' || h.payload.sectionId !== c.id) continue;
        const now = cur(h);
        put({ ...now, payload: { ...now.payload, sectionId: k.id } });
      }
    }
    put({ ...cur(c), deleted: true } as AnyRec);
  }
  return [...out.values()];
}

/**
 * The merge, in memory: the local store into the account's engine. Returns
 * the ids that were ADOPTED (taken from the local store, not lost to an
 * account copy), which the caller keeps to fold once more after its first
 * sync — an account whose cached snapshot was empty or stale has only then
 * shown which starters it already had.
 */
export function mergeLocalInto(engine: SyncEngine, local: Snapshot): { adopted: Set<string>; folded: number } {
  const adoption = adoptionSnapshot(local);
  const before = new Map(engine.toSnapshot().recs.map((r) => [r.id, r.updated]));
  const adopted = new Set(
    adoption.recs.filter((r) => !(before.has(r.id) && before.get(r.id)! >= r.updated)).map((r) => r.id),
  );
  engine.mergeSnapshot(adoption);
  const puts = foldAdopted(engine.toSnapshot().recs, adopted);
  for (const r of puts) engine.put(r);
  return { adopted, folded: puts.length };
}

/** The two writes the adoption needs, each REJECTING when it did not happen. */
export type AdoptIo = {
  writeAccount: (snapshotJson: string) => Promise<void>;
  removeLocal: () => Promise<void>;
};

export type AdoptOutcome = {
  adopted: Set<string>;
  /** The merged account snapshot is on disk. */
  persisted: boolean;
  /** The local snapshot is gone. False whenever it was not safe to remove (or
   *  removing failed): the caller retries after a later account write. */
  localCleared: boolean;
};

/**
 * The sign-in sequence, in the only safe order: merge, write the merged
 * account snapshot, and only once that write has landed remove the local one.
 * `keepLocal` (the local key holds bytes this device could not read or move
 * aside) merges what is in memory but never removes the key.
 */
export async function adoptLocalStore(
  engine: SyncEngine,
  local: Snapshot,
  io: AdoptIo,
  opts: { keepLocal?: boolean } = {},
): Promise<AdoptOutcome> {
  const { adopted } = mergeLocalInto(engine, local);
  try {
    await io.writeAccount(JSON.stringify(engine.toSnapshot()));
  } catch {
    return { adopted, persisted: false, localCleared: false };
  }
  if (opts.keepLocal) return { adopted, persisted: true, localCleared: false };
  try {
    await io.removeLocal();
  } catch {
    return { adopted, persisted: true, localCleared: false };
  }
  return { adopted, persisted: true, localCleared: true };
}
