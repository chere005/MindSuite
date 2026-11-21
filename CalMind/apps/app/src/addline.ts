/**
 * Filing a typed line — the ONE place a line like "Dentist 8/3 2pm" becomes an
 * event, a reminder or a note. The Add tab (phone) and the wide layout's
 * quick-add field both call it, so the parse order, the manual-beats-parsed
 * rule, the double-tap guard and the shared-store routing cannot drift apart.
 * (Moved out of screens/Add.tsx unchanged.)
 */
import { useMemo, useRef } from 'react';
import {
  byRecOrd,
  newId,
  nowStr,
  normalizeEndDate,
  ordBetween,
  parseClockField,
  parseWhenFromText,
  prefsOf,
  showAgain,
  todayStr,
  type Rec,
  type Repeat,
} from '@calmind/core';
import { useStore } from './store';

export type AddKind = 'reminder' | 'event' | 'note';

export type AddLineInput = {
  kind: AddKind;
  text: string;
  /** A chosen calendar or section id; null = the app's default. */
  destId?: string | null;
  datePicked?: string | null;
  endDatePicked?: string | null;
  timeField?: string;
  endField?: string;
  repeat?: Repeat | null;
  /** The day the add was launched FROM — an incumbent a typed date outranks. */
  date0?: string | null;
};

/** `err` is '' when the add was swallowed by the double-tap guard. */
export type AddLineResult = { ok: true; noteId: string | null } | { ok: false; err: string };

export function useAddLine(kind: AddKind) {
  const { recs, mutate, sharedRecs, sharedPut, sharedPartner, sharedPartnerLabel } = useStore();
  const lastFiled = useRef<{ text: string; at: number } | null>(null);

  /**
   * Mine, then the partner's shared containers, each of theirs labelled
   * @partner — the same menu ItemModal draws, for the same reason (the owner,
   * 2026-09-15: "allow users to… add events/reminders/notes to shared
   * events/reminders/notes"). Picking one of theirs sends the add through
   * sharedPut into THEIR store; `sharedIds` is how the save knows.
   */
  const { sectionChoices, calendars, sharedIds } = useMemo(() => {
    const app = kind === 'note' ? 'notes' : 'reminders';
    const choicesOf = (pool: typeof recs, prefix: string) => {
      const folders = pool.filter((r): r is Rec<'folder'> => r.type === 'folder').sort(byRecOrd);
      const sections = pool.filter((r): r is Rec<'section'> => r.type === 'section').sort(byRecOrd);
      return {
        sectionChoices: folders
          .filter((f) => (f.payload.app ?? 'reminders') === app)
          .flatMap((f) => sections.filter((x) => x.payload.folderId === f.id).map((x) => ({ sec: x, label: `${prefix}${f.payload.name} · ${x.payload.name}`, color: f.payload.color }))),
        calendars: pool.filter((r): r is Rec<'calendar'> => r.type === 'calendar').sort(byRecOrd)
          .map((c) => ({ cal: c, label: `${prefix}${c.payload.name}` })),
      };
    };
    const mine = choicesOf(recs, '');
    const theirs = sharedPartner ? choicesOf(sharedRecs, `@${sharedPartnerLabel ?? sharedPartner} · `) : { sectionChoices: [], calendars: [] };
    return {
      sectionChoices: [...mine.sectionChoices, ...theirs.sectionChoices],
      calendars: [...mine.calendars, ...theirs.calendars],
      sharedIds: new Set([...theirs.calendars.map((c) => c.cal.id), ...theirs.sectionChoices.map((c) => c.sec.id)]),
    };
  }, [recs, sharedRecs, sharedPartner, sharedPartnerLabel, kind]);

  const file = (input: AddLineInput): AddLineResult => {
    const { kind, destId = null, datePicked = null, endDatePicked = null, timeField = '', endField = '', repeat = null, date0 = null } = input;
    const today = todayStr();
    const raw = input.text.trim();
    if (!raw) return { ok: false, err: 'type the line first' };
    // A deliberate guard, because the accidental one is a race. Nothing here
    // stopped a second press except the screen navigating away and the field
    // clearing, and both of those happen a render later — so two taps inside
    // one frame filed the line twice. Adding the same words twice within a
    // second and a half is a thumb, not an intention; wait, or change a
    // character, and it files again.
    const now = Date.now();
    if (lastFiled.current && lastFiled.current.text === raw && now - lastFiled.current.at < 1500) {
      return { ok: false, err: '' };
    }
    lastFiled.current = { text: raw, at: now };
    const fd = datePicked;
    const ft = parseClockField(timeField);
    // Manual-beats-parsed (the owner, 2026-08-18): a category the fields settled
    // is not lifted from the line — the token stays, unused.
    const [clean, pd, pt, pe, pEndDate] = parseWhenFromText(raw, today, nowStr(), { date: fd === null, time: ft === null });
    // The launch day (date0) is an INCUMBENT, ranked as ItemModal ranks its
    // own: an explicit typed token beats it, but a bare "2pm" only IMPLIES a
    // day and that implication is a fallback, not an instruction — it must
    // not drag an add made from Aug 25 back to today. The time-less parse
    // cannot imply, so its date is the explicit token alone.
    const [, pdExplicit] = parseWhenFromText(raw, today, nowStr(), { date: fd === null, time: false });
    const date = fd ?? pdExplicit ?? date0 ?? pd;
    const time = ft ?? pt;
    // Only events carry an end, and only after a start (the owner, 2026-08-18). The
    // end-time field is always in view now (no +End reveal), so an empty field
    // means no end; a typed RANGE ("lunch 12-1pm") still fills it via pe, and
    // an end put in BY HAND wins, like every other manual-beats-parsed pair.
    const fe = parseClockField(endField);
    const end = kind === 'event' && time !== null ? fe ?? pe : null;
    // The end DAY (events only), kept only when it is after the start day —
    // core drops an equal-or-earlier one back to same-day. A day picked by
    // hand outranks one written in the line ("conference mon-wed"), the same
    // order every other pair here follows.
    const endDate = kind === 'event' ? normalizeEndDate(date ?? today, endDatePicked ?? pEndDate) : null;
    const title = clean || raw;
    let createdNoteId: string | null = null;
    // The record is built once and handed to the store it belongs to — mine
    // through the engine, the partner's through sharedPut when the chosen
    // container is one of theirs. Un-hiding the destination is a preference
    // of MINE, so it happens only on my side.
    let out: Rec<'event'> | Rec<'reminder'> | Rec<'note'>;
    let toShared = false;
    if (kind === 'event') {
      const cal =
        calendars.find((c) => c.cal.id === destId)?.cal ??
        calendars.find((c) => c.cal.id === prefsOf(recs, 'calendar').defaultCalendarId)?.cal ??
        calendars[0]!.cal;
      toShared = sharedIds.has(cal.id);
      out = { id: newId(), type: 'event', updated: 0, payload: { text: title, date: date ?? today, time, end, endDate, repeat, calendarId: cal.id, ord: ordBetween(null, null) } };
      if (!toShared) {
        // Whatever you just added has to be visible afterwards.
        const widen = showAgain(recs, 'calendar', cal.id);
        if (widen) mutate((e) => e.put(widen));
      }
    } else {
      const app = kind === 'note' ? ('notes' as const) : ('reminders' as const);
      const pick =
        sectionChoices.find((c) => c.sec.id === destId) ??
        sectionChoices.find((c) => c.sec.id === prefsOf(recs, app).defaultSectionId) ??
        sectionChoices[0]!;
      const { folderId } = pick.sec.payload;
      toShared = sharedIds.has(pick.sec.id);
      if (!toShared) {
        const widen = showAgain(recs, kind === 'reminder' ? 'reminders' : 'notes', folderId);
        if (widen) mutate((e) => e.put(widen));
      }
      if (kind === 'reminder') {
        // `date ?? today`, matching what the event above has always done.
        // A reminder filed from here with no date landed undated, which puts
        // it in the all-view and on no day — the owner asked for today, which is
        // also the only day this button can mean.
        out = { id: newId(), type: 'reminder', updated: 0, payload: { text: title, due: date ?? today, time, done: false, repeat, folderId, sectionId: pick.sec.id, indent: 0, ord: ordBetween(null, null) } };
      } else {
        const noteId = newId();
        out = { id: noteId, type: 'note', updated: 0, payload: { title, body: '', date, folderId, sectionId: pick.sec.id, ord: ordBetween(null, null) } };
        // A note of MINE opens in the editor; one filed into the partner's
        // folder stays where it landed — the editor is for my store.
        if (!toShared) createdNoteId = noteId;
      }
    }
    if (toShared) void sharedPut(out);
    else mutate((e) => e.put(out));
    return { ok: true, noteId: createdNoteId };
  };

  return { calendars, sectionChoices, sharedIds, file };
}
