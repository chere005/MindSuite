/**
 * The local-first sync engine — the piece that exists exactly once for all three
 * platforms. Transport-agnostic: the app supplies a function that POSTs a
 * SyncRequest and returns the server's SyncResponse; persistence is a snapshot
 * the app stores wherever it likes (AsyncStorage, localStorage).
 *
 * Merging is per-record last-write-wins on `updated`; a tie keeps the incumbent,
 * so replays and echoes of our own pushes are no-ops. The server keeps a per-user
 * sequence number; `cursor` is "I have everything up to seq N", so a pull is only
 * ever the tail.
 */
import type { AnyRec } from './types';

/**
 * Do two versions of a record say the same thing?
 *
 * Only `deleted` and `payload` count — `updated` is the stamp being compared
 * around this, and anything else is identity. Keys are sorted so that two
 * objects built in a different order still compare equal; without that, an
 * echo of our own record would read as a difference and the two devices would
 * hand it back and forth for ever.
 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}

function sameContent(a: AnyRec, b: AnyRec): boolean {
  return !!a.deleted === !!b.deleted && canon(a.payload) === canon(b.payload);
}

export type SyncRequest = { cursor: number; changes: AnyRec[] };

/**
 * Why a record was refused — spec/protocol.json `rejectReasons`. Only
 * `too_large` is the user's to fix (shorten the note); the other three mean
 * the APP wrote a record the protocol forbids, and saying "too long" about
 * one of those sends the user hunting for a length problem that is not there.
 */
export type RejectReason = 'bad_id' | 'bad_type' | 'bad_updated' | 'too_large';

export type SyncResponse = {
  cursor: number;
  changes: AnyRec[];
  rejected?: string[];
  /** id → reason, for every id in `rejected`. Older servers send none. */
  rejectedWhy?: Record<string, string>;
  /** Rows the server could not name (no string id) — counted, not lost. */
  dropped?: number;
};
export type Transport = (req: SyncRequest) => Promise<SyncResponse>;

export type Snapshot = { cursor: number; recs: AnyRec[]; dirty: string[] };

/**
 * The most changes one sync may carry.
 *
 * The server refuses a larger batch outright — `app.php`'s MAX_BATCH, a 400
 * with "batch too large" — and the client used to send EVERY dirty record in
 * one request. Past the limit that is a deadlock rather than a slow sync:
 * the same oversized batch is retried for ever, nothing is accepted, and the
 * app reports itself offline while the network is fine.
 *
 * Reachable without doing anything strange. Deleting a folder with hundreds
 * of items re-homes them all, and normalize marks every one dirty in a single
 * refresh; so does a long spell offline, or a large import.
 *
 * The number is deliberately the SAME number as the server's rather than a
 * safer smaller one, so the two can be checked against each other —
 * `test/batchlimit.test.ts` reads app.php and fails if they drift. A quietly
 * smaller client limit would work and would hide the day the server's moved.
 */
export const SYNC_MAX_BATCH = 500;

/**
 * The server's own record rules — spec/protocol.json `recIdPattern` and
 * `recTypePattern`, held equal to it by test/protocolids.test.ts.
 *
 * Checked BEFORE a record is sent. The server refuses a malformed record by
 * id, but a row whose id is not even a string cannot be named in that reply
 * — it is only counted — so the engine would forget it as sent and it would
 * live on this device alone while the app called itself synced. Checking
 * here keeps such a record dirty and named, with its reason, the same as a
 * refusal from the server.
 */
export const REC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REC_TYPE_PATTERN = /^[a-z]{1,20}$/;

/** What is wrong with a record by the protocol's rules, or null. Size is the
 *  server's to judge: its byte count is PHP's json_encode, not ours. */
export function protocolFault(rec: AnyRec): RejectReason | null {
  const r = rec as { id?: unknown; type?: unknown; updated?: unknown };
  if (typeof r.id !== 'string' || !REC_ID_PATTERN.test(r.id)) return 'bad_id';
  if (typeof r.type !== 'string' || !REC_TYPE_PATTERN.test(r.type)) return 'bad_type';
  if (typeof r.updated !== 'number' || !Number.isInteger(r.updated) || r.updated <= 0) return 'bad_updated';
  return null;
}

/** spec/protocol.json `rejectReasons`, in its order. */
export const REJECT_REASONS: readonly RejectReason[] = ['bad_id', 'bad_type', 'bad_updated', 'too_large'];

export class SyncEngine {
  private recs = new Map<string, AnyRec>();
  private dirty = new Map<string, number>(); // id -> updated stamp when marked
  private cursor = 0;
  private rejectedIds = new Set<string>();
  private rejectedWhy = new Map<string, RejectReason>();
  private droppedCount = 0;

  /** Live records, the app's read model. */
  all(): AnyRec[] {
    return [...this.recs.values()].filter((r) => !r.deleted);
  }

  get(id: string): AnyRec | undefined {
    const r = this.recs.get(id);
    return r && !r.deleted ? r : undefined;
  }

  /** A local edit: stamp it, keep it, remember to push it. */
  put(rec: AnyRec, now = Date.now()): AnyRec {
    const stamped = { ...rec, updated: Math.max(now, (this.recs.get(rec.id)?.updated ?? 0) + 1) };
    this.recs.set(rec.id, stamped);
    this.dirty.set(rec.id, stamped.updated);
    return stamped;
  }

  /** A local delete is an edit that plants the tombstone. */
  del(id: string, now = Date.now()): void {
    const r = this.recs.get(id);
    if (r) this.put({ ...r, deleted: true }, now);
  }

  hasPending(): boolean {
    return this.dirty.size > 0;
  }

  /**
   * Ids refused on the last round trip — by the server, or by the protocol
   * check before sending. `refusals()` says why.
   * They stay dirty on purpose. A refused record is NOT saved anywhere but
   * this device, and forgetting it would leave the app claiming to be synced
   * while one note existed in exactly one place.
   */
  rejected(): string[] {
    return [...this.rejectedIds];
  }

  /**
   * The same ids, each with WHY. A server too old to say is taken to mean
   * size, which was the only refusal it made before it learned to say more.
   */
  refusals(): { id: string; why: RejectReason }[] {
    return [...this.rejectedIds].map((id) => ({ id, why: this.rejectedWhy.get(id) ?? 'too_large' }));
  }

  /** Rows the server counted but could not name on the last round trip. */
  dropped(): number {
    return this.droppedCount;
  }

  /** One round trip: push everything dirty, take the server's tail, advance. */
  async sync(transport: Transport): Promise<void> {
    // Drains in as many round trips as it takes. A backlog bigger than the
    // limit used to be permanent; now it is merely several requests, and the
    // loop stops the moment a round is not full — which is every ordinary
    // sync, where one round carries everything and the second would be empty.
    for (;;) {
      const more = await this.syncOnce(transport);
      if (!more) return;
    }
  }

  /** One round trip. Returns true when a FULL batch went out, so there may
   *  be more waiting behind it. */
  private async syncOnce(transport: Transport): Promise<boolean> {
    // A record that breaks the protocol is not sent: it is refused HERE, by
    // id and reason, and stays dirty — exactly what a server refusal does,
    // without the case where the server cannot name it.
    const local = new Map<string, RejectReason>();
    for (const id of this.dirty.keys()) {
      const rec = this.recs.get(id);
      const fault = rec ? protocolFault(rec) : null;
      if (fault) local.set(id, fault);
    }
    const batch = [...this.dirty.keys()].filter((id) => !local.has(id)).slice(0, SYNC_MAX_BATCH);
    const sent = new Map(batch.map((id) => [id, this.dirty.get(id)!]));
    const req: SyncRequest = {
      cursor: this.cursor,
      changes: batch.map((id) => this.recs.get(id)!),
    };
    const res = await transport(req);
    for (const theirs of res.changes) {
      const mine = this.recs.get(theirs.id);
      if (!mine || theirs.updated > mine.updated) {
        this.recs.set(theirs.id, theirs);
        continue;
      }
      // THE TIE. Equal stamps used to leave every party holding its own copy,
      // so two devices that stamped the same record identically stayed
      // different from each other, silently and for ever (TODO §1, and the
      // test above this one used to pin that as known-broken).
      //
      // The server is the arbiter, because it is the one thing both devices
      // agree on: it now accepts an equal-stamped write whose content differs
      // and bumps its sequence, so its copy is "whichever edit reached the
      // server last". Taking it here is what makes the two converge.
      //
      // EXCEPT when our copy is still dirty. An unsent local edit is not a
      // stale loser — it has never been offered to anyone. Overwriting it
      // here would destroy it silently AND pointlessly: the id stays in
      // `dirty`, so the very next push would send back the copy we just
      // adopted, which the server would recognise as identical and ignore.
      // Keeping it means it gets pushed, the server takes it, and the other
      // device converges on this one instead. Either way they agree; only
      // this way does nobody lose writing they never got to send.
      if (theirs.updated === mine.updated && !this.dirty.has(theirs.id) && !sameContent(mine, theirs)) {
        this.recs.set(theirs.id, theirs);
      }
    }
    this.cursor = res.cursor;
    this.rejectedIds = new Set([...(res.rejected ?? []), ...local.keys()]);
    this.rejectedWhy = new Map(local);
    for (const [id, why] of Object.entries(res.rejectedWhy ?? {})) {
      if ((REJECT_REASONS as readonly string[]).includes(why)) this.rejectedWhy.set(id, why as RejectReason);
    }
    this.droppedCount = typeof res.dropped === 'number' ? res.dropped : 0;
    // Only forget what we actually sent — an edit made mid-flight stays dirty
    // — and never forget what the server refused, or the record quietly
    // becomes local-only while the app reports everything saved.
    for (const [id, stamp] of sent) {
      if (this.rejectedIds.has(id)) continue;
      if ((this.dirty.get(id) ?? 0) <= stamp) this.dirty.delete(id);
    }
    // A full batch means there may be more behind it. Anything short — which
    // includes every ordinary sync — is the end, and a batch entirely made of
    // records the server REFUSED would otherwise loop for ever on the same
    // ones, since those stay dirty by design.
    return batch.length === SYNC_MAX_BATCH && [...this.dirty.keys()].some((id) => !sent.has(id) && !local.has(id));
  }

  /**
   * Another engine's snapshot of the SAME account, folded into this one.
   *
   * This exists for two browser TABS sharing one localStorage key: each held
   * its own engine and wrote the whole snapshot over the other's on every
   * mutate, so offline, the last tab to write was the only one whose work
   * survived a reload (e2e/twotab.spec.ts held that pinned as a fixme).
   * The `storage` event tells the other tab a write happened; this is what
   * it does with it.
   *
   * The rules are sync's own, not new ones: a strictly newer stamp wins, a
   * missing record is taken, and an EQUAL stamp keeps ours — between two
   * tabs an equal stamp with equal content is the ordinary shared-ancestry
   * case, and with different content it is the two-devices tie, which the
   * SERVER arbitrates when both sides push (adopting here would pick a winner
   * the server never saw). Ours never loses to an older stamp, so nothing an
   * unsent edit says is eaten.
   *
   * A record adopted from the other tab's DIRTY set becomes dirty here too.
   * The other tab would push it eventually — but "eventually" assumes the
   * other tab survives, and the whole reason this record is only in a
   * snapshot is that the network was away. If that tab closes first, this
   * tab is the record's only way to the server. Both tabs pushing the same
   * content is a no-op on the server side.
   *
   * The cursor advances to the higher of the two: the further tab has
   * consumed more of the server's tail, and its snapshot carries what it
   * consumed.
   *
   * Returns whether anything changed, so the caller can persist the union
   * exactly when there is one — persisting unconditionally would ping-pong
   * storage events between the tabs forever.
   */
  mergeSnapshot(s: Snapshot): boolean {
    let changed = false;
    const theirDirty = new Set(s.dirty);
    for (const theirs of s.recs) {
      const mine = this.recs.get(theirs.id);
      if (mine && theirs.updated <= mine.updated) continue;
      this.recs.set(theirs.id, theirs);
      changed = true;
      if (theirDirty.has(theirs.id)) this.dirty.set(theirs.id, theirs.updated);
      // Adopting a SERVER-BORNE record (not dirty over there) over our own
      // dirty older copy: the dirty entry stays, and the next push offers the
      // adopted content back — which the server recognises as identical and
      // ignores. Harmless, and clearing it here would be wrong the moment a
      // keystroke lands between this merge and that push.
    }
    if (s.cursor > this.cursor) {
      this.cursor = s.cursor;
      changed = true;
    }
    return changed;
  }

  toSnapshot(): Snapshot {
    return { cursor: this.cursor, recs: [...this.recs.values()], dirty: [...this.dirty.keys()] };
  }

  static fromSnapshot(s: Snapshot | null): SyncEngine {
    const e = new SyncEngine();
    if (!s) return e;
    e.cursor = s.cursor;
    for (const r of s.recs) e.recs.set(r.id, r);
    for (const id of s.dirty) e.dirty.set(id, e.recs.get(id)?.updated ?? 0);
    return e;
  }
}
