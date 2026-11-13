/**
 * The availability editor's one day of hours, read from the server.
 *
 * The hours (which are in the window, which the calendar has taken) come from
 * the server, one day per call. The editor used to keep the last reply in
 * state while the date changed, so for a round trip the previous day's hours
 * were drawn under the new date and a slot tapped then wrote the NEW date's
 * availability from the OLD day's times; and replies were not sequenced, so a
 * quick run of day taps could end on an earlier day's answer.
 *
 * Here the reply is stored WITH its date and read back only for that date, a
 * new selection clears the hours at once, and a reply for a date that is no
 * longer selected is ignored.
 */

export type AvSlot = { time: string; busy: boolean };
export type AvDayReply = { owner: boolean; slots: AvSlot[] };

export type AvDay = {
  /** The date the hours below belong to. */
  date: string;
  /** null until THIS date's reply has arrived (or when it failed). */
  slots: AvSlot[] | null;
  /** The read for this date failed; the hours are not known. */
  failed: boolean;
};

export type AvOwner = boolean | null;

/** The hours to draw and tap for `date`: never another date's. */
export function slotsFor(day: AvDay, date: string): AvSlot[] | null {
  return day.date === date ? day.slots : null;
}

export class DayReader {
  private wanted: string | null = null;
  private stop = false;

  constructor(
    private readonly fetchDay: (date: string) => Promise<AvDayReply>,
    private readonly onDay: (day: AvDay) => void,
    private readonly onOwner: (owner: boolean) => void,
  ) {}

  /** Select a date: its hours are cleared now and read; older replies are void. */
  select(date: string): void {
    this.wanted = date;
    this.onDay({ date, slots: null, failed: false });
    this.fetchDay(date).then(
      (r) => {
        if (this.stop || this.wanted !== date) return;
        this.onOwner(r.owner);
        this.onDay({ date, slots: Array.isArray(r.slots) ? r.slots : [], failed: false });
      },
      () => {
        if (this.stop || this.wanted !== date) return;
        this.onDay({ date, slots: null, failed: true });
      },
    );
  }

  /** The screen is gone: nothing more is delivered. */
  dispose(): void {
    this.stop = true;
  }
}
