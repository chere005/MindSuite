/**
 * Writes into a PARTNER's shared lists, answered at once and settled in order.
 *
 * My own lists are local-first: the engine takes the edit, the screen draws it
 * in the same task, and the network trails behind. A partner's records are not
 * mine to hold in an engine, so a write used to be POST, then a re-pull, and
 * only the pull changed what was drawn — two round trips of a tick that did
 * nothing, a second tap acting on the stale record, and pulls whose replies
 * could land out of order and put an old copy back.
 *
 * This keeps the pulled copy (`base`) apart from what I have written since
 * (`writes`) and draws base with those writes laid over it:
 *
 *  - A write is in the drawn view the moment it is made (put() calls onView
 *    before it returns), and goes out later, one at a time, in the order it was
 *    made, so the server sees the same history the screen did.
 *  - A pull replaces `base`, never a write. A write stays over the pulled copy
 *    until a pull that was SENT AFTER the server acknowledged it has landed —
 *    only that pull is guaranteed to contain it. A pull sent earlier can land
 *    late and is simply laid under the write; a pull older than one already
 *    applied is dropped.
 *  - A write the server refuses (or that never arrives) is taken back, and so
 *    is every write still QUEUED for that partner: a later write may be built
 *    on the failed one (a reminder added into a section that was never
 *    created), and the realistic causes (sharing ended = 403, dead token =
 *    401, network down) make every later write into that list fail too, so
 *    sending them would only land fragments. Writes already acknowledged stay,
 *    and writes made after the take-back go out normally. The person is told
 *    once (onTrouble) that the change to the partner's list was not saved; the
 *    telling stands until a later write to that partner is acknowledged, the
 *    partner changes, or reset() (onRecovered) — it is not the own-list
 *    offline state, and no timer clears it.
 *
 * Nothing here is stored: a write that has not reached the server when the app
 * closes is gone, exactly as it was when the POST was awaited. No outbox.
 *
 * Pure of React and of the transport, so the sequencing can be tested with a
 * fake API that controls latency, failure and the order replies arrive in.
 */

export type SharedRec = { id: string; deleted?: boolean; updated?: number };

export type PullReply<R extends SharedRec, P> = { partners: P[]; partner: string | null; records: R[] };

export type SharedApi<R extends SharedRec, P> = {
  put(partner: string, record: R): Promise<void>;
  pull(): Promise<PullReply<R, P>>;
};

export type SharedHooks<R extends SharedRec, P> = {
  /** What the screens draw: the pulled copy with my unsettled writes over it. */
  onView(records: R[]): void;
  /** The partner list of an applied pull. */
  onPulled(meta: { partners: P[]; partner: string | null }): void;
  /** A write was refused or failed and has been taken back. */
  onTrouble(): void;
  /** The trouble is over: a write was acknowledged, the partner changed, or reset. */
  onRecovered(): void;
};

type State = 'queued' | 'sent' | 'acked';

type Write<R extends SharedRec> = {
  partner: string;
  rec: R;
  state: State;
  /** The clock value when the server acknowledged it. */
  ackedAt: number;
  settle: () => void;
};

export class SharedWrites<R extends SharedRec, P = unknown> {
  private base: R[] = [];
  private partner: string | null = null;
  private writes: Write<R>[] = [];
  /** Ticks on every pull sent and every write acknowledged: the order of events. */
  private clock = 0;
  private appliedPullSent = 0;
  private lastStamp = 0;
  private pumping = false;
  private reconcileDue = false;
  /** A take-back has been reported and nothing has cleared it yet. */
  private troubled = false;
  /** Bumped by reset(): replies to requests from before it belong to nobody. */
  private epoch = 0;

  constructor(
    private readonly api: SharedApi<R, P>,
    private readonly hooks: SharedHooks<R, P>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The drawn list: the pulled copy, with the writes in force laid over it. */
  view(): R[] {
    const byId = new Map<string, R>();
    for (const r of this.base) byId.set(r.id, r);
    for (const w of this.writes) {
      if (w.partner !== this.partner) continue;
      if (w.rec.deleted) byId.delete(w.rec.id);
      else byId.set(w.rec.id, w.rec);
    }
    return Array.from(byId.values());
  }

  /** A take-back has been reported and not yet cleared. */
  inTrouble(): boolean {
    return this.troubled;
  }

  /** Writes made and not yet acknowledged by the server. */
  unsettled(): number {
    return this.writes.filter((w) => w.state !== 'acked').length;
  }

  /**
   * Make a write: it is drawn before this returns. The promise settles when the
   * server has answered (or the write was taken back); callers fire and forget.
   */
  put(partner: string, rec: R): Promise<void> {
    // Strictly increasing, so two taps in one millisecond still go out as an
    // older and a newer write: the server keeps the larger stamp.
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1);
    if (this.partner === null) this.partner = partner;
    return new Promise<void>((settle) => {
      this.writes.push({ partner, rec: { ...rec, updated: this.lastStamp }, state: 'queued', ackedAt: 0, settle });
      this.emit();
      void this.pump();
    });
  }

  /**
   * Re-read the partner's lists. false when the read failed (the last copy
   * stands). A reply that is older than one already applied is dropped.
   */
  async pull(): Promise<boolean> {
    const epoch = this.epoch;
    const sent = ++this.clock;
    let r: PullReply<R, P>;
    try {
      r = await this.api.pull();
    } catch {
      return false;
    }
    if (epoch !== this.epoch) return false;
    if (sent < this.appliedPullSent) return true;
    this.appliedPullSent = sent;
    if (r.partner !== this.partner) {
      // The partner changed: writes into the old one are not this list's.
      this.dropWhere((w) => w.partner !== r.partner);
      this.partner = r.partner;
      // A partner appearing is a fresh list. A partner going to null is how
      // sharing ending looks to the re-read the failed write itself caused
      // (a 403): that is the change being lost, not the trouble being over.
      if (r.partner !== null) this.recover();
    }
    this.base = r.records;
    // A pull sent after an acknowledgement contains that write: it can go.
    this.dropWhere((w) => w.state === 'acked' && w.ackedAt < sent);
    this.hooks.onPulled({ partners: r.partners, partner: r.partner });
    this.emit();
    return true;
  }

  /** Forget everything: signed out, or a different account. */
  reset(): void {
    this.epoch++;
    this.base = [];
    this.partner = null;
    this.reconcileDue = false;
    this.recover();
    const gone = this.writes;
    this.writes = [];
    for (const w of gone) w.settle();
    this.emit();
  }

  private emit(): void {
    this.hooks.onView(this.view());
  }

  private dropWhere(test: (w: Write<R>) => boolean): void {
    const keep: Write<R>[] = [];
    for (const w of this.writes) {
      if (test(w)) w.settle();
      else keep.push(w);
    }
    this.writes = keep;
  }

  /** Send the queue, one write at a time, oldest first. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const w = this.writes.find((x) => x.state === 'queued');
        if (!w) break;
        const epoch = this.epoch;
        w.state = 'sent';
        let wrote = true;
        try {
          await this.api.put(w.partner, w.rec);
        } catch {
          wrote = false;
        }
        if (epoch !== this.epoch) continue; // reset() already settled it
        if (wrote) {
          w.state = 'acked';
          w.ackedAt = ++this.clock;
          // Two acknowledged writes on one record: the older is covered.
          this.dropWhere((x) => x !== w && x.state === 'acked' && x.rec.id === w.rec.id && x.partner === w.partner);
          w.settle();
          this.reconcileDue = true;
          this.recover();
        } else {
          this.takeBack(w);
          this.reconcileDue = true;
          this.troubled = true;
          this.hooks.onTrouble();
        }
      }
    } finally {
      this.pumping = false;
    }
    // One re-read once the queue has drained, not one per write: it is what
    // lets acknowledged writes go and what shows a partner's own change.
    if (this.reconcileDue) {
      this.reconcileDue = false;
      void this.pull();
    }
  }

  private recover(): void {
    if (!this.troubled) return;
    this.troubled = false;
    this.hooks.onRecovered();
  }

  /** The write failed: its change, and every write still queued for that partner, goes. */
  private takeBack(failed: Write<R>): void {
    this.dropWhere((w) => w === failed || (w.state === 'queued' && w.partner === failed.partner));
    this.emit();
  }
}
