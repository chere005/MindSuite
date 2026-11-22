/**
 * The app's one stateful seam: a React context wrapping core's SyncEngine.
 * Local-first — every edit lands in the engine immediately and renders from it;
 * persistence (AsyncStorage) and the server round-trip trail behind, debounced.
 * The engine, merge rules and normalization all live in @calmind/core; this file
 * only wires them to React, storage, the app lifecycle and the watch.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { watchForUpdate } from './update';
import { SyncEngine, LOCAL_USER, adoptLocalStore, foldAdopted, lastDeleted, normalize, parseSnapshot, prefsOf, folderApp, recLabel, remoteTick, shareOf, todayStr, undeleted, type AnyRec, type Rec, type Snapshot } from '@calmind/core';
import { apiPost, type Session, syncTransport, ApiError, restoreWebSession } from './api';
import { drainWatchTicks, drainWidgetTicks, onWatchTick, pushWatchIfWidgetMoved, pushWatchList } from './watch';
import { applyTheme, type ThemeName } from './theme';
import { defaultServerUrl } from './config';
import { SharedWrites, type SharedTrouble } from './sharedwrites';
import { accountOptional, damagedKey, localSnapshotKey, snapshotKey, snapshotOwner } from './accountmode';

/**
 * Storage is per-INSTANCE, because on the web it is per-ORIGIN and prod, test
 * and dev share one.
 *
 * seancheren.com/calmind, /test/calmind and /dev/calmind differ only by PATH,
 * and localStorage does not care about paths. So one `calmind.session` key was
 * read by all three: loading prod restored the session test had written, and
 * because a Session carries its own serverUrl, the prod page went on talking
 * to TEST while looking like prod. The owner, 2026-08-20: "my account seems there
 * at seancheren.com/calmind even on web" — it was, and it was test's.
 *
 * The tag is derived from the API this instance would use, so instances are
 * separated by the one thing that actually distinguishes them. Subdomains will
 * separate the origins too and make this redundant on the web; it stays
 * because NATIVE has no origin at all, and a device that switches servers
 * should not inherit the other one's snapshot either.
 */
const instanceTag = (): string => {
  const url = defaultServerUrl();
  // Host + path, minus the api filename: short, stable, and readable in a
  // storage inspector, which a hash would not be.
  return url.replace(/^https?:\/\//, '').replace(/\/api\/index\.php$/, '').replace(/[^A-Za-z0-9.]+/g, '_');
};

const SESSION_KEY = `calmind.session@${instanceTag()}`;
const snapKey = (user: string) => snapshotKey('calmind', user, instanceTag());

/**
 * No-account LOCAL MODE (account-optional builds only; see accountmode.ts):
 * the device's records under their own key, `calmind.snapshot.~local@<tag>`.
 * `~` is outside the username alphabet, so this can never be an account's.
 */
const OPTIONAL = accountOptional();
const localKey = () => localSnapshotKey('calmind', instanceTag());

/**
 * MealMind's store, read and written from here.
 *
 * MealMind keeps its recipes in a second sync SPACE of the same account —
 * `records-chef-<user>.json` on the server, reached with `space: 'chef'` on
 * the sync request (server/lib/app.php, SYNC_SPACES). The owner, 2026-09-15:
 * "sync recipes in MealMind and CalMind… recipes show up in CalMind as notes
 * sections with a chef hat icon to the right to indicate they are coming from
 * MealMind." So this app runs a SECOND engine against that space: its own
 * cursor, its own snapshot key, the same transport with the space named, and
 * never normalized here — MealMind seeds and re-homes its own store, and a
 * CalMind normalize pass over it would plant a Calendar folder and a habit
 * section in an app that has neither.
 *
 * The two engines never mix records: nothing here puts a record into the
 * chef engine, and `chefRecs` is the read model the Notes screen draws under
 * the hat. With no writes the engine is only ever pulled from — a sync with
 * nothing dirty pushes nothing.
 */
const CHEF_SPACE = 'chef';
const chefSnapKey = (user: string) => `calmind.snapshot.chef.${user}@${instanceTag()}`;

/** What the keys were before they were per-instance. */
const LEGACY_SESSION_KEY = 'calmind.session';
const legacySnapKey = (user: string) => `calmind.snapshot.${user}`;

/**
 * Adopt the old un-namespaced session — but ONLY if it belongs to this
 * instance.
 *
 * Without this every existing install signs out once, including the browser
 * tab that has been on test all along, which is a real cost for a bug that is
 * not its fault. With it, the instance whose serverUrl matches keeps its
 * session and its snapshot, and everyone else's stays where it is rather than
 * being deleted — the legacy keys are LEFT ALONE, so whichever instance owns
 * them can still claim them, and nothing is destroyed if this reasoning turns
 * out to be wrong.
 */
async function adoptLegacySession(): Promise<void> {
  const already = await AsyncStorage.getItem(SESSION_KEY).catch(() => null);
  if (already !== null) return;
  const raw = await AsyncStorage.getItem(LEGACY_SESSION_KEY).catch(() => null);
  if (!raw || raw === 'signed out') return;
  let s: { serverUrl?: string; username?: string } | null = null;
  try {
    s = JSON.parse(raw) as { serverUrl?: string; username?: string };
  } catch {
    return;
  }
  if (!s || typeof s.serverUrl !== 'string' || typeof s.username !== 'string') return;
  // The whole test: does that session belong to the instance now loading?
  if (s.serverUrl !== defaultServerUrl()) return;
  await AsyncStorage.setItem(SESSION_KEY, raw).catch(() => {});
  const snap = await AsyncStorage.getItem(legacySnapKey(s.username)).catch(() => null);
  if (snap !== null) await AsyncStorage.setItem(snapKey(s.username), snap).catch(() => {});
}

/**
 * Forget the stored session — and if storage refuses to delete it, leave
 * something behind that cannot be read as one.
 *
 * Both callers already treat the removal as allowed to fail, and say why:
 * clearing memory is what signs you out, so a refusing store must never take
 * the sign-out with it. That is right, and normally the leftover is harmless
 * because the server revokes the token on logout — proven, not assumed: with
 * removeItem throwing, the token stays on disk and the next launch still
 * lands on the login page, because the server rejects it.
 *
 * OFFLINE it does not. There is no server to reject anything, so the launch
 * path restores the session and shows that account's cached snapshot on a
 * device where Log out was pressed. Narrow — it needs a storage failure AND
 * no network — but the whole point of the rule about silent write failures
 * is that this is the shape they take.
 *
 * The launch path already drops a session that will not parse, so a value
 * that cannot parse is the answer. If the store refuses this write too we
 * are exactly where we were, which is why it is best-effort in turn.
 */
async function forgetSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SESSION_KEY);
  } catch {
    await AsyncStorage.setItem(SESSION_KEY, 'signed out').catch(() => {});
  }
}

/**
 * MealMind's cached snapshot, or null. A cache on the same terms as mine: an
 * unreadable one costs a resync of that space, never a login and never the
 * app (see the boot effect for the rule this follows).
 */
async function readChefSnapshot(user: string): Promise<unknown> {
  const raw = await AsyncStorage.getItem(chefSnapKey(user)).catch(() => null);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// 'refused' is not a kind of offline: the connection is fine and the server
// answered. One record is simply too big to store, and it is still sitting
// on this device only.
type SyncState = 'idle' | 'syncing' | 'offline' | 'refused';

export type PartnerBadge = { name: string; mutual: boolean };

type Store = {
  ready: boolean;
  session: Session | null;
  recs: AnyRec[];
  syncState: SyncState;
  /** This device could not write its local copy — a reload would lose work. */
  persistFailed: boolean;
  /** Names of records the server refused, so a warning can name them. */
  refusedLabels: string[];
  /** Refused notes can be opened directly from Settings so the user can fix them. */
  refusedNotes: { id: string; label: string }[];
  /** Why: too long (the user's to fix) or malformed (the app's bug). */
  refusedWhy: 'too_large' | 'invalid';
  /** A known refusal, or a lost reply still awaiting reconciliation; see sharedwrites.ts. */
  sharedTrouble: SharedTrouble;
  dismissSharedTrouble: () => void;
  signIn: (s: Session) => Promise<void>;
  signOut: () => Promise<void>;
  clearDeletedAccount: () => Promise<void>;
  setSession: (s: Session) => Promise<void>; // token refresh (password change)
  mutate: (fn: (engine: SyncEngine) => void) => void;
  syncNow: () => Promise<void>;
  /** Restore the most recently deleted reminder/event/note/habit, and say
   *  what came back. null when there is nothing to undo. */
  undoLastDelete: () => string | null;
  /** Sharing: the first mutual partner's shared records, read-only copies
   *  refreshed with every sync; writes go through sharedPut, never the
   *  engine — a partner's store is not ours to hold a cursor into. */
  partners: PartnerBadge[];
  sharedPartner: string | null;
  /** My display label for the partner (share-window rename), else the name. */
  sharedPartnerLabel: string | null;
  sharedRecs: AnyRec[];
  sharedPut: (rec: AnyRec) => Promise<void>;
  /** MealMind's records — the same account's `chef` space, see CHEF_SPACE.
   *  Drawn by Notes under the chef's hat, READ-ONLY: there is no write path
   *  into that space from here (the owner, 2026-09-15: "disable editing MealMind
   *  recipes from CalMind"). */
  chefRecs: AnyRec[];
  /** No-account local mode (account-optional builds only, always false
   *  otherwise): the records live on this device alone, `session` is null so
   *  nothing that needs a server runs, and there is no sync. */
  localMode: boolean;
  /** Local mode with the sign-in card open over it (Settings → Sign in). */
  signInOpen: boolean;
  openSignIn: () => void;
  /** Back from the sign-in card to local use. */
  closeSignIn: () => void;
};

const Ctx = createContext<Store | null>(null);
export const useStore = () => useContext(Ctx)!;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const engineRef = useRef(new SyncEngine());
  // MealMind's engine, beside mine — see CHEF_SPACE for why there are two.
  const chefRef = useRef(new SyncEngine());
  const [ready, setReady] = useState(false);
  const [session, setSessionState] = useState<Session | null>(null);
  const [recs, setRecs] = useState<AnyRec[]>([]);
  const [chefRecs, setChefRecs] = useState<AnyRec[]>([]);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [persistFailed, setPersistFailed] = useState(false);
  /** The names of records the server refused, for a message that can point. */
  const [refusedLabels, setRefusedLabels] = useState<string[]>([]);
  const [refusedNotes, setRefusedNotes] = useState<{ id: string; label: string }[]>([]);
  const [refusedWhy, setRefusedWhy] = useState<'too_large' | 'invalid'>('too_large');
  const [sharedTrouble, setSharedTrouble] = useState<SharedTrouble>(false);
  const [partners, setPartners] = useState<PartnerBadge[]>([]);
  const [sharedPartner, setSharedPartner] = useState<string | null>(null);
  const [sharedRaw, setSharedRaw] = useState<AnyRec[]>([]);
  const timers = useRef<{ persist?: ReturnType<typeof setTimeout>; sync?: ReturnType<typeof setTimeout> }>({});
  const persistQueue = useRef<Promise<void>>(Promise.resolve());

  /*
   * Local mode (OPTIONAL builds only; every one of these stays at its initial
   * value otherwise, so none of the code reading them changes anything).
   *
   * localRef is the pseudo-session: true while the engine holds the LOCAL
   * store, persisted under localKey() and never synced. `session` stays null
   * through it, which is what keeps every network path shut — each one
   * already refuses to run without a session.
   */
  const localRef = useRef(false);
  const [localMode, setLocalMode] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  /** The local key holds bytes this device could neither read nor move
   *  aside. They may be the only copy of someone's lists, so nothing writes
   *  over them (and Settings says the device cannot save). */
  const holdLocalRef = useRef(false);
  /** Ids adopted from the local store at sign-in, folded once more against
   *  the account after its first sync (localmerge.ts, foldAdopted).
   *  TODO(local mode): held in memory only, so an app closed between the
   *  sign-in and that sync skips the second fold and can keep a duplicate
   *  starter (nothing is lost; the merge-time fold still ran on the cache). */
  const pendingFoldRef = useRef<Set<string> | null>(null);
  /** The local key must go once an account snapshot holding the merge is on
   *  disk; set when that did not happen at sign-in. */
  const pendingLocalClearRef = useRef(false);

  // Seeding starters against an EMPTY engine that simply hasn't pulled yet would
  // duplicate everything the server already holds — normalize only runs once the
  // store is hydrated: a snapshot with a cursor, or one completed sync.
  const hydratedRef = useRef(false);

  /**
   * The partner's records as the watch feed wants them, in a REF.
   *
   * refresh() is a useCallback with no deps — deliberately, so every caller
   * gets the same stable function — which means it cannot read sharedRecs
   * from state without capturing a stale one. The ref is written by the
   * effect below and read here, and that effect also re-pushes, so the
   * widget's calendar picker updates when a partner's list changes rather
   * than only when one of MY records does.
   */
  const sharedForWatch = useRef<{ recs: AnyRec[]; partner: string } | null>(null);

  /** Re-render from the engine, keep the shape guarantees, feed the watch. */
  const refresh = useCallback(() => {
    const engine = engineRef.current;
    if (hydratedRef.current) {
      const { added, edited } = normalize(engine.all());
      for (const r of [...added, ...edited]) engine.put(r);
    }
    const all = engine.all();
    setRecs(all);
    // MealMind's records as they are — no normalize (see CHEF_SPACE), and the
    // watch never sees them: recipes are not a thing a wrist lists.
    setChefRecs(chefRef.current.all());
    pushWatchList(all, sharedForWatch.current);
  }, []);

  // Persist IMMEDIATELY on every change — a debounce here meant an edit made
  // just before a reload never reached the snapshot and quietly vanished
  // (caught by the e2e drag spec). Only the network round-trip is debounced.
  const persistNow = useCallback((user: string) => {
    // A failure here used to be swallowed whole. It is the quietest kind of
    // loss there is: everything keeps working, and then a reload comes back
    // to yesterday. Storage refuses for ordinary reasons — a full quota, a
    // browser wiping site data — so say it rather than carry on as if saved.
    const snapshot = JSON.stringify(engineRef.current.toSnapshot());
    if (user === LOCAL_USER) {
      // Local mode: one key, and no MealMind space (local mode does not read
      // it). On the same terms as below: a refusal is said, never swallowed.
      persistQueue.current = persistQueue.current.then(async () => {
        if (holdLocalRef.current) { setPersistFailed(true); return; }
        const ok = await AsyncStorage.setItem(localKey(), snapshot).then(() => true, () => false);
        setPersistFailed(!ok);
      });
      return persistQueue.current;
    }
    const chefSnapshot = JSON.stringify(chefRef.current.toSnapshot());
    persistQueue.current = persistQueue.current.then(async () => {
      const results = await Promise.allSettled([
        AsyncStorage.setItem(snapKey(user), snapshot),
        AsyncStorage.setItem(chefSnapKey(user), chefSnapshot),
      ]);
      setPersistFailed(results.some((result) => result.status === 'rejected'));
      // Signed in from local mode and the merged snapshot did not reach disk
      // then: this one holds the merge, so the local copy may go now.
      if (pendingLocalClearRef.current && results[0]?.status === 'fulfilled') {
        await AsyncStorage.removeItem(localKey()).then(() => { pendingLocalClearRef.current = false; }, () => {});
      }
    });
    // MealMind's snapshot under its own key, on the same terms: a failure
    // here is the same silent loss and is said the same way.
    return persistQueue.current;
  }, []);

  // The partner's lists: the pulled copy with my unsettled writes laid over it
  // (see sharedwrites.ts). The transport reads the session at call time.
  const sharedWrites = useRef<SharedWrites<AnyRec, PartnerBadge> | null>(null);
  if (!sharedWrites.current) {
    sharedWrites.current = new SharedWrites<AnyRec, PartnerBadge>(
      {
        put: async (partner, record) => {
          const s = sessionRef.current;
          if (!s) throw new Error('signed out');
          await apiPost(s.serverUrl, { action: 'shared_put', partner, record }, s.token);
        },
        pull: async () => {
          const s = sessionRef.current;
          if (!s) throw new Error('signed out');
          return apiPost<{ partners: PartnerBadge[]; partner: string | null; records: AnyRec[] }>(
            s.serverUrl, { action: 'shared_pull' }, s.token,
          );
        },
      },
      {
        onView: setSharedRaw,
        onPulled: ({ partners: p, partner }) => {
          setPartners(p);
          setSharedPartner(partner);
        },
        // Partner writes are never retried. A known refusal is kept until dismissed, a later acknowledgement or reset;
        // a lost reply stays unconfirmed until a later pull can determine whether the write landed.
        onTrouble: () => setSharedTrouble(true),
        onRecovered: () => setSharedTrouble(false),
        onUnconfirmed: () => setSharedTrouble('unconfirmed'),
      },
    );
  }

  const pullShared = useCallback(() => sharedWrites.current!.pull(), []);

  /**
   * Everything that has to let go when there is no longer a session — whether
   * you pressed Log out or the server stopped recognising your token. Both
   * roads end on the login page, and it was only ever one of them that tidied
   * up: a 401 dropped the session and left the records, the partner and the
   * theme behind, so the login card rendered in the departed user's colours
   * and contradicted the line that says it always renders midnight.
   */
  const clearSession = useCallback(() => {
    sessionRef.current = null;
    engineRef.current = new SyncEngine();
    chefRef.current = new SyncEngine();
    hydratedRef.current = false;
    setSessionState(null);
    setRecs([]);
    setChefRecs([]);
    setPartners([]);
    setSharedPartner(null);
    sharedWrites.current?.reset();
    // Whatever a sign-in from local mode left to finish belonged to that account.
    pendingFoldRef.current = null;
    pendingLocalClearRef.current = false;
    applyTheme('midnight'); // the login page always renders midnight
  }, []);

  /**
   * Open the LOCAL store (account-optional builds only): at launch with no
   * session, and on the way out of an account. Normally the key is gone after
   * a sign-in took its records, so this is an empty store growing its
   * starters. If it is still there (the merge was never confirmed on disk) it
   * is loaded, not replaced: showing those records again loses nothing, and
   * signing in again merges them as a no-op.
   *
   * Bytes that will not parse are the only copy there is, so they are moved
   * aside before an empty store is saved over the key; if they cannot be read
   * or moved, local writes are HELD and the device says it cannot save.
   */
  const enterLocal = useCallback(async () => {
    const key = localKey();
    let raw: string | null = null;
    let unreadable = false;
    try {
      raw = await AsyncStorage.getItem(key);
    } catch {
      unreadable = true;
    }
    const parsed = unreadable ? ({ kind: 'damaged' } as const) : parseSnapshot(raw);
    holdLocalRef.current = false;
    if (parsed.kind === 'damaged') {
      const moved = !unreadable && raw !== null
        && await AsyncStorage.setItem(damagedKey(key, Date.now()), raw).then(() => true, () => false);
      if (!moved) holdLocalRef.current = true;
    }
    engineRef.current = SyncEngine.fromSnapshot(parsed.kind === 'ok' ? parsed.snap : null);
    // TODO(local mode): CalMind reads MealMind's recipes from the account's
    // `chef` space; with no account there is none. A later build can read
    // MealMind's LOCAL store on the device through a shared App Group instead.
    chefRef.current = new SyncEngine();
    hydratedRef.current = true; // nothing to pull: starters are safe to seed now
    localRef.current = true;
    setLocalMode(true);
    setSignInOpen(false);
    refresh();
    persistNow(LOCAL_USER); // the starters keep their ids across launches
    flushTicksRef.current(false);
  }, [refresh, persistNow]);

  /** After an account is gone (sign-out, a dead token, deletion): local mode
   *  with whatever the local key holds — normally nothing, as the last
   *  sign-in took it. A no-op unless the build is account-optional. */
  const afterAccount = useCallback(async () => {
    if (!OPTIONAL) return;
    setReady(false); // not the Login card, not a half-loaded store: a blank page for one read
    try {
      await enterLocal();
    } finally {
      setReady(true);
    }
  }, [enterLocal]);

  // One sync at a time. The poll fires every 30 seconds regardless of whether
  // the last one finished, so a request that hangs — accepted, never answered —
  // used to have another started on top of it, and another, for as long as the
  // stall lasted: four in ninety-five seconds, measured, each holding a socket
  // and none of them ever recovering. Two concurrent syncs of one engine are
  // no use even when the network is healthy; they race the same dirty set.
  const syncing = useRef(false);
  // …but a request that arrives DURING one is remembered, not dropped. The
  // guard alone traded a pile-up for a delay: an edit made while a slow sync
  // was in flight had its debounced push skipped, and then waited for the
  // thirty-second poll, because the running sync only carries what was dirty
  // when it STARTED. One extra pass afterwards costs nothing and is what the
  // debounce was promising in the first place.
  const syncAgain = useRef(false);
  /** Applies the watch's and the widget's queued ticks — assigned below,
   *  called from the boot, signIn and a finished sync. A ref because those
   *  are defined before mutate exists. */
  const flushTicksRef = useRef<(afterSync: boolean) => void>(() => {});

  const syncNow = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    if (syncing.current) { syncAgain.current = true; return; }
    const engine = engineRef.current;
    const recipes = chefRef.current;
    syncing.current = true;
    setSyncState('syncing');
    // The OUTER try exists only for the finally: the 401 path below returns
    // early, and a flag released on some exits and not others wedges syncing
    // for the life of the page — a worse bug than the pile-up it prevents.
    try {
    try {
      await engine.sync(syncTransport(s));
      if (sessionRef.current !== s) return;
      hydratedRef.current = true; // the server has spoken — seeding is safe now
      // Signed in from local mode: only now does this device know every
      // starter the account already had, so fold the adopted ones into them
      // (localmerge.ts) before normalize sees two of each, and push the fold.
      if (pendingFoldRef.current) {
        const adopted = pendingFoldRef.current;
        pendingFoldRef.current = null;
        const puts = foldAdopted(engineRef.current.toSnapshot().recs, adopted);
        for (const r of puts) engineRef.current.put(r);
        if (puts.length > 0) syncAgain.current = true;
      }
      // A tick for a reminder made on another device waits for this pull.
      flushTicksRef.current(true);
      // WHICH record was refused, not merely that one was. "A note is too
      // long to save" in an app holding hundreds of them leaves you to find
      // it yourself, and the note is by definition not the one on screen.
      //
      // And WHY. Too long is the user's to fix, so those are named first and
      // the note can be opened from Settings; a malformed record is the app's
      // bug, and calling it "too long" sent people hunting for a length
      // problem that was not there (TODO §2).
      const refusals = engineRef.current.refusals();
      const tooLong = refusals.filter((r) => r.why === 'too_large');
      const shown = tooLong.length > 0 ? tooLong : refusals;
      const snap = engineRef.current.toSnapshot().recs;
      setRefusedLabels(shown.map(({ id }) => {
        const rec = snap.find((r) => r.id === id);
        return rec ? recLabel(rec) : id;
      }));
      setRefusedWhy(tooLong.length > 0 || refusals.length === 0 ? 'too_large' : 'invalid');
      setRefusedNotes(tooLong.flatMap(({ id }) => {
        const rec = snap.find((r) => r.id === id);
        return rec?.type === 'note' && !rec.deleted ? [{ id, label: recLabel(rec) }] : [];
      }));
      setSyncState(refusals.length > 0 ? 'refused' : 'idle');
      void pullShared();
      // MealMind's space, AFTER mine and on its own terms: a server that does
      // not know the space answers 400, and that must not paint this app
      // offline — my own records just synced fine. The last pulled copy
      // stands, as any local-first read does, and the next pass tries again.
      try {
        await recipes.sync(syncTransport(s, CHEF_SPACE));
      } catch {
        // deliberately quiet — see above
      }
    } catch (e) {
      if (sessionRef.current !== s) return;
      // Offline is normal for a local-first app; a dead token is not.
      setSyncState('offline');
      if (e instanceof ApiError && e.status === 401) {
        // The removal is allowed to fail — persistNow already documents that
        // storage refuses for ordinary reasons — but it must not take the
        // sign-out with it. Unguarded, a throw here escaped this catch
        // entirely (an unhandled rejection, since every caller does `void
        // syncNow()`) AND left the dead session on disk to be restored on the
        // next launch. Clearing memory is what actually signs you out; the
        // disk copy is a cache.
        await forgetSession();
        clearSession();
        void afterAccount();
        return;
      }
    }
    if (sessionRef.current !== s) return;
    refresh();
    persistNow(snapshotOwner(s));
    } finally {
      syncing.current = false;
      // Only if there is still a session: the 401 path above clears it and
      // returns through here, and syncing after a sign-out is both useless and
      // a way to resurrect a dead token's error.
      if (syncAgain.current && sessionRef.current) {
        syncAgain.current = false;
        void syncNow();
      } else {
        syncAgain.current = false;
      }
    }
  }, [refresh, persistNow, pullShared, afterAccount]);

  // Every caller fires this and forgets it (`void sharedPut(...)`). The write
  // is drawn at once and sent in order; a refusal (sharing ending a moment
  // earlier is a 403, a dead token a 401) takes back that change and every write
  // still queued for the partner and says it was not saved. A lost reply pauses the queue and re-pulls before deciding.
  // The re-read also drops rows that are no longer
  // ours to touch. No retry and nothing stored: see sharedwrites.ts.
  const sharedPut = useCallback(async (rec: AnyRec) => {
    if (!sessionRef.current || !sharedPartner) return;
    await sharedWrites.current!.put(sharedPartner, rec);
  }, [sharedPartner]);

  const syncSoon = useCallback(() => {
    clearTimeout(timers.current.sync);
    timers.current.sync = setTimeout(() => void syncNow(), 800);
  }, [syncNow]);

  // session in a ref so the periodic sync closure never goes stale.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  /**
   * The newest tombstone, restored.
   *
   * Read from the SNAPSHOT rather than `recs`: the engine's all() filters
   * deleted records out, so the live list this app renders from cannot see a
   * tombstone at all. Passing that list here would find nothing, for ever,
   * and the menu would look like a feature nobody had asked for.
   */
  const mutateRef = useRef<((fn: (engine: SyncEngine) => void) => void) | null>(null);
  const undoLastDelete = useCallback((): string | null => {
    const gone = lastDeleted(engineRef.current.toSnapshot().recs);
    if (!gone) return null;
    const label = recLabel(gone);
    mutateRef.current?.((e) => e.put(undeleted(gone)));
    return label;
  }, []);

  const mutate = useCallback(
    (fn: (engine: SyncEngine) => void) => {
      fn(engineRef.current);
      refresh();
      if (sessionRef.current) {
        persistNow(snapshotOwner(sessionRef.current));
        syncSoon();
      } else if (localRef.current) {
        persistNow(LOCAL_USER); // local mode: saved, never sent
      }
    },
    [refresh, persistNow, syncSoon],
  );
  mutateRef.current = mutate;


  // Check-offs from the watch and the home-screen widget. Both are queued
  // DURABLY on the native side (App Group) and drained only once the signed-in
  // store is loaded. Draining on mount was the widget bug: a tap on the home
  // screen cold-launches the app, the mount effect drained the queue while the
  // engine was still empty (the session restores asynchronously), found no
  // such reminder, and the tick was gone for good. The watch's ticks had the
  // same hole — they lived only as a JS event.
  //
  // A tick whose reminder is not here yet (made on another device since the
  // last pull) is held until the next sync lands, then dropped if still gone.
  const heldTicks = useRef<string[]>([]);
  const flushTicks = useCallback(
    (afterSync: boolean) => {
      // Local mode ticks too: the reminders are on this device.
      if (!sessionRef.current && !localRef.current) return; // the native queue keeps them until then
      const ids = [...heldTicks.current, ...drainWidgetTicks(), ...drainWatchTicks()];
      heldTicks.current = [];
      if (ids.length === 0) return;
      const missing: string[] = [];
      mutate((e) => {
        const today = todayStr();
        for (const id of ids) {
          const rec = e.all().find((r) => r.id === id && r.type === 'reminder' && !r.deleted) as Rec<'reminder'> | undefined;
          if (!rec) { missing.push(id); continue; }
          // A tick only completes: a row drawn before another device finished
          // it must not reopen it (remoteTick returns null for that).
          const next = remoteTick(rec.payload, today);
          if (next) e.put({ ...rec, payload: next });
        }
      });
      if (!afterSync) heldTicks.current = missing;
    },
    [mutate],
  );
  flushTicksRef.current = flushTicks;

  useEffect(() => onWatchTick(() => flushTicks(false)), [flushTicks]);

  useEffect(() => {
    flushTicks(false); // a no-op until the session is restored; boot calls it again
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      flushTicks(false);
      // The widget's calendar selection may have moved while the app was
      // away, and nothing notifies us when it does — so the watch mirrored
      // the OLD selection until the next unrelated push (the one-push-behind
      // bug, fixed on the owner's word 2026-08-18). A no-op when nothing moved.
      pushWatchIfWidgetMoved(engineRef.current.all(), sharedForWatch.current);
    });
    return () => sub.remove();
  }, [flushTicks]);

  /**
   * The OTHER tab's writes, folded in as they land (web only — native has one
   * JS runtime and no second tab). Two tabs share one snapshot key and each
   * used to write the whole snapshot over the other's, so offline, a reload
   * kept only the last writer's work — e2e/twotab.spec.ts, a fixme since
   * 2026-08-11. The owner's "get all of that done" (2026-08-19) unblocked it; of
   * the three options the TODO entry laid out, this is the recommended one —
   * the listener reuses machinery that already exists.
   *
   * The merge itself is core's (SyncEngine.mergeSnapshot, sync's own LWW
   * rules), so a mid-sentence arrival cannot eat the sentence any more than a
   * server pull can: the editor's draft state survives a re-render, which is
   * the protection clobber.spec pins. Persisting only when something CHANGED
   * is what stops the two tabs ping-ponging storage events forever — tab A
   * persists the union, tab B folds A's half in and persists once more, and
   * the third bounce merges nothing and writes nothing.
   *
   * The `storage` event only ever fires in the tabs that did NOT write, so
   * none of this runs in the tab whose keystroke it was.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onStorage = (ev: StorageEvent) => {
      const s = sessionRef.current;
      // Local mode is a store of its own, on the same terms (no MealMind space).
      // TODO(local mode): a second tab still in local mode after this one
      // signed in writes the local key back; the next sign-in merges it again
      // (a no-op for what already landed), so it costs a reappearance, not data.
      const user = s ? snapshotOwner(s) : localRef.current ? LOCAL_USER : null;
      if (!user || !ev.newValue) return;
      // Which engine the other tab wrote — mine or MealMind's. Anything else
      // in storage is not a snapshot of ours.
      const target =
        ev.key === (s ? snapKey(user) : localKey()) ? engineRef.current
        : s && ev.key === chefSnapKey(user) ? chefRef.current
        : null;
      if (!target) return;
      let snap: Snapshot | null = null;
      try {
        snap = JSON.parse(ev.newValue) as Snapshot;
      } catch {
        return; // a corrupt snapshot is a cache problem, not a merge input
      }
      if (!snap || !Array.isArray(snap.recs)) return;
      if (target.mergeSnapshot(snap)) {
        refresh();
        persistNow(user); // the union, so a reload right now loses neither tab
        if (s) syncSoon(); // and offer it to the server when there is one
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh, persistNow, syncSoon]);

  /**
   * The local store, into the account engine now in engineRef
   * (account-optional builds): core's adoptLocalStore merges, writes the
   * merged account snapshot, and only once that write has landed removes the
   * local one. `inMemory` is the local engine's snapshot when signing in from
   * local mode. At launch it is null, and a local key still on disk beside a
   * session means a sign-in that did not finish: it is merged again, which is
   * a no-op for whatever already landed.
   */
  const adoptLocal = useCallback(async (user: string, inMemory: Snapshot | null, keepLocal: boolean) => {
    let local = inMemory;
    if (!local) {
      const raw = await AsyncStorage.getItem(localKey()).catch(() => undefined);
      // Unreadable or damaged bytes stay exactly where they are: local mode
      // moves them aside, and this must not be the step that loses them.
      const parsed = raw === undefined ? null : parseSnapshot(raw);
      if (!parsed || parsed.kind !== 'ok') return;
      local = parsed.snap;
    }
    const out = await adoptLocalStore(engineRef.current, local, {
      writeAccount: (json) => AsyncStorage.setItem(snapKey(user), json),
      removeLocal: () => AsyncStorage.removeItem(localKey()),
    }, { keepLocal });
    pendingFoldRef.current = out.adopted.size > 0 ? out.adopted : null;
    // Not removed yet: the next account write that lands removes it (persistNow).
    pendingLocalClearRef.current = !keepLocal && !out.localCleared;
    if (!out.persisted) setPersistFailed(true);
  }, []);

  const signIn = useCallback(
    async (s: Session) => {
      const owner = snapshotOwner(s);
      // From local mode, the local store is frozen FIRST: nothing writes its
      // key from here on, and a write still in flight lands before the merge
      // below can remove the key (landing after, it would bring it back).
      const fromLocal = localRef.current;
      const localEngine = engineRef.current;
      const localSnap = fromLocal ? localEngine.toSnapshot() : null;
      const keepLocal = holdLocalRef.current;
      if (fromLocal) {
        localRef.current = false;
        await persistQueue.current;
      }
      try {
      // Signing in must not depend on the disk. Unguarded, storage refusing
      // threw before the engine was built and before setSessionState — so a
      // CORRECT password bounced you back to the login screen with no error
      // at all. persistFailed is the existing way this app says 'saved
      // nothing', and Settings already shows it; reuse that rather than fail
      // the sign-in.
      await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s))
        .then(() => setPersistFailed(false))
        .catch(() => setPersistFailed(true));
      const snap = await AsyncStorage.getItem(snapKey(owner)).catch(() => null);
      // The PARSE needs guarding as much as the read did — guarding only the
      // read was this same bug one layer in. A corrupt snapshot threw here,
      // signIn threw, and Login showed 'something went wrong' every single
      // time, forever, because the bad bytes are still on disk. You could
      // never sign in on that device again. It is a cache; drop it.
      let restored: unknown = null;
      try {
        restored = snap ? JSON.parse(snap) : null;
      } catch {
        restored = null;
      }
      engineRef.current = SyncEngine.fromSnapshot(restored as never);
      chefRef.current = SyncEngine.fromSnapshot(await readChefSnapshot(owner) as never);
      if (OPTIONAL) await adoptLocal(owner, localSnap, keepLocal);
      hydratedRef.current = engineRef.current.toSnapshot().cursor > 0;
      } catch (e) {
        if (fromLocal) {
          // Back to local mode as it was, saved again: whatever happened
          // above, the local records are never left in limbo.
          await forgetSession();
          engineRef.current = localEngine;
          chefRef.current = new SyncEngine();
          hydratedRef.current = true;
          localRef.current = true;
          refresh();
          persistNow(LOCAL_USER);
        }
        throw e;
      }
      if (fromLocal) {
        setLocalMode(false);
        setSignInOpen(false);
      }
      setSessionState(s);
      sessionRef.current = s;
      refresh();
      flushTicksRef.current(false);
      void syncNow();
    },
    [refresh, syncNow, adoptLocal, persistNow],
  );

  // The suite's folder_shared_color(): the viewer's own recolour override
  // wins over the owner's colour, resolved HERE so the picker, the shared
  // views, the All blocks, the cells and the legend all follow for free.
  const sharedPartnerLabel = React.useMemo(
    () => (sharedPartner ? shareOf(recs).labels?.[sharedPartner] ?? sharedPartner : null),
    [recs, sharedPartner],
  );

  const sharedRecs = React.useMemo(() => {
    if (!sharedPartner || sharedRaw.length === 0) return sharedRaw;
    const key = (id: string) => `@${sharedPartner}:${id}`;
    return sharedRaw.map((r) => {
      if (r.type === 'folder') {
        const over = prefsOf(recs, folderApp((r as Rec<'folder'>).payload))?.sharedColors?.[key(r.id)];
        return over ? { ...r, payload: { ...r.payload, color: over } } : r;
      }
      if (r.type === 'calendar') {
        const over = prefsOf(recs, 'calendar').sharedColors?.[key(r.id)];
        return over ? { ...r, payload: { ...r.payload, color: over } } : r;
      }
      return r;
    }) as AnyRec[];
  }, [sharedRaw, sharedPartner, recs]);

  useEffect(() => {
    // Always, even with no saved preference: applyTheme is what writes
    // theme-color and the page background, and skipping it left both to the
    // constant baked in at export time — right for midnight by luck, wrong
    // for every other theme.
    applyTheme((prefsOf(recs, 'suite').theme as ThemeName) || 'midnight');
  }, [recs]);


  const signOut = useCallback(async () => {
    // Same rule as the 401 path, and this one matters more because it is the
    // deliberate act: pressing Log out with storage refusing used to throw
    // before clearSession, so nothing happened and you stayed signed in with
    // no error at all. The disk copy is a cache; clearing memory is the
    // sign-out. Do that regardless.
    await forgetSession();
    clearSession();
    // Account-optional builds come back to local mode, empty: the local
    // records went into the account at sign-in.
    await afterAccount();
  }, [clearSession, afterAccount]);

  const clearDeletedAccount = useCallback(async () => {
    const s = sessionRef.current;
    const user = s ? snapshotOwner(s) : null;
    sessionRef.current = null;
    clearTimeout(timers.current.persist);
    clearTimeout(timers.current.sync);
    if (user) {
      await persistQueue.current;
      // These are this account's local caches. The caller invokes this only
      // after the server has confirmed account deletion.
      await Promise.all([
        AsyncStorage.removeItem(snapKey(user)).catch(() => {}),
        AsyncStorage.removeItem(chefSnapKey(user)).catch(() => {}),
      ]);
    }
    await forgetSession();
    clearSession();
    await afterAccount();
  }, [clearSession, afterAccount]);

  const setSession = useCallback(async (s: Session) => {
    // Same rule: a refreshed token must reach memory even if the disk will
    // not take it, or the app keeps using the old one it can no longer save.
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s))
      .then(() => setPersistFailed(false))
      .catch(() => setPersistFailed(true));
    setSessionState(s);
  }, []);

  // Local mode's way to the sign-in card and back (Settings, Login).
  const openSignIn = useCallback(() => { if (localRef.current) setSignInOpen(true); }, []);
  const closeSignIn = useCallback(() => setSignInOpen(false), []);

  // Boot: restore the session and its snapshot, then catch up with the server.
  useEffect(() => {
    (async () => {
      // NOTHING here may prevent setReady(true). Unguarded, this was the
      // worst failure in the app: a corrupt session or snapshot in storage —
      // or storage simply refusing — threw out of this function, setReady
      // never ran, and the app sat on its loading screen FOREVER. Not an
      // error, not a login page: a permanent blank. And it would survive
      // every relaunch, because the bad bytes are still there.
      //
      // So each step is allowed to fail on its own terms: an unreadable
      // session means signed out, an unreadable snapshot means a fresh
      // engine. Damaged data costs you a login, never the app.
      try {
        await adoptLegacySession();
        const raw = await AsyncStorage.getItem(SESSION_KEY).catch(() => null);
        let s: Session | null = null;
        try {
          s = raw ? (JSON.parse(raw) as Session) : null;
        } catch {
          // A session that will not parse is not a session. Drop it rather
          // than meet it again on every launch.
          await AsyncStorage.removeItem(SESSION_KEY).catch(() => {});
        }
        if (s) {
          s = await restoreWebSession(s);
          // Only session metadata changes. Every unsent snapshot stays on disk, and none is hydrated before identity is known.
          if (s) await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s)).catch(() => {});
          else await AsyncStorage.removeItem(SESSION_KEY).catch(() => {});
        }
        if (s) {
          const owner = snapshotOwner(s);
          const snap = await AsyncStorage.getItem(snapKey(owner)).catch(() => null);
          let parsed: unknown = null;
          try {
            parsed = snap ? JSON.parse(snap) : null;
          } catch {
            // The snapshot is a CACHE of what the server holds. Losing it
            // costs a resync, which the sync below does anyway.
            parsed = null;
          }
          engineRef.current = SyncEngine.fromSnapshot(parsed as never);
          chefRef.current = SyncEngine.fromSnapshot(await readChefSnapshot(owner) as never);
          // A local store still on disk beside a session: a sign-in from
          // local mode that did not finish. Finish it (a no-op if it had).
          if (OPTIONAL) await adoptLocal(owner, null, false);
          hydratedRef.current = engineRef.current.toSnapshot().cursor > 0;
          setSessionState(s);
          sessionRef.current = s;
          refresh();
          flushTicksRef.current(false);
          void syncNow();
        } else if (OPTIONAL) {
          // No account, and the build does not need one: local mode.
          await enterLocal();
        }
      } finally {
        setReady(true);
      }
    })();
  }, [refresh, syncNow, adoptLocal, enterLocal]);

  // The revive rule, native edition: sync when the app comes back, and every 30s.
  useEffect(() => {
    if (localMode) return; // local mode has nothing to sync: no timer at all
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void syncNow();
    });
    const iv = setInterval(() => void syncNow(), 30000);
    return () => {
      sub.remove();
      clearInterval(iv);
    };
  }, [syncNow, localMode]);

  // ...and the web edition of the same rule, for the page itself rather than
  // the data. An installed home-screen app is resumed, not reloaded, so it can
  // sit on a build from weeks ago while every deploy since passes it by. This
  // asks on return whether the server is serving something else, and takes it
  // only when nothing is still owed — the engine's own dirty count is the
  // guard, so a reload can never land on top of unsent typing.
  // OFF unless the page asks for it (2026-08-09). Wiring the updater in
  // unconditionally gave a blank screen on an installed home-screen web app —
  // reproducibly, on relaunch — while the same bundle rendered correctly in
  // Chromium, in headless WebKit and in Safari on the same simulator. It is
  // behind `?autoupdate=1` so it can be reproduced on a webclip installed at
  // that URL without any ordinary install running it. An app that shows
  // nothing is very much worse than one that is out of date.
  useEffect(() => {
    if (localMode) return; // no network at all in local mode, the page's own included
    if (typeof location === 'undefined') return;
    if (new URLSearchParams(location.search).get('autoupdate') !== '1') return;
    return watchForUpdate(() => engineRef.current.toSnapshot().dirty.length);
  }, [localMode]);

  // Keep the watch feed's view of the partner current, and push again when it
  // changes: their calendars are what the widget's picker offers, so a
  // partner sharing a new calendar has to reach the phone's widget without
  // waiting for one of my own records to change.
  useEffect(() => {
    sharedForWatch.current =
      sharedPartner && sharedRecs.length > 0
        ? { recs: sharedRecs, partner: sharedPartnerLabel ?? sharedPartner }
        : null;
    pushWatchList(engineRef.current.all(), sharedForWatch.current);
  }, [sharedRecs, sharedPartner, sharedPartnerLabel]);

  return (
    <Ctx.Provider value={{ ready, session, recs, syncState, persistFailed, refusedLabels, refusedNotes, refusedWhy, sharedTrouble, dismissSharedTrouble: () => sharedWrites.current?.dismissTrouble(), signIn, signOut, clearDeletedAccount, setSession, mutate, syncNow, undoLastDelete, partners, sharedPartner, sharedPartnerLabel, sharedRecs, sharedPut, chefRecs, localMode, signInOpen, openSignIn, closeSignIn }}>
      {children}
    </Ctx.Provider>
  );
}
