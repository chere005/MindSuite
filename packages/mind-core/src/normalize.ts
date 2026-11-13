/**
 * The shape guarantees for the whole suite, run on every load: each app's
 * starter records exist, every folder holds at least one section, and every
 * item sits in a real container of the right app. Pure — returns what to add
 * and what it edited; the caller stamps and persists (so a partner's shared
 * data could one day be normalized in memory only, exactly as the suite does).
 *
 * WHICH starters an app grows is its SEED PROFILE, and the profile is the only
 * thing the apps differ in here. Each app's own `appconfig.ts` (app-owned)
 * names it and the app's `normalize.ts` wrapper passes it in; called with no
 * profile, this shared body runs SUITE_SEEDS (CalMind's). ChefMind's swaps the
 * Reminders tab for its shopping list and pantry and grows no calendar or
 * habit starters. The profile decides seeds and where strays land, never the
 * record shapes: every payload written here is the one each app wrote before
 * the seam existed (pinned by each app's test/seedsnapshot.test.ts).
 */
import type { AnyRec, Rec } from './types';
import { folderApp, newId } from './types';
import { ordBetween, byRecOrd } from './order';

export const FOLDER_STARTER = 'Reminders';
export const FOLDER_CALENDAR = 'Calendar'; // seeded WITH rideAlong — the name is a label, the flag is the identity
export const FOLDER_NOTES_STARTER = 'General';
export const SECTION_DEFAULT = 'General';
export const CALENDAR_STARTER = 'Personal';
export const HABIT_SECTION_STARTER = 'Habits';

// Seed colors, one per app tier as in lib/palette.php: reminders' vivid blue,
// the event blue (deliberately a blue, never a cyan), notes' sky, habits' indigo.
const C_REMINDERS = '#4c8bf0';
const C_CALENDAR_FOLDER = '#66d695';
const C_NOTES = '#7dc2ed';
const C_CAL = '#0379f6';
const C_HABITS = '#4357ef';

/** A folder a profile seeds by name and colour; the flag is its identity. */
export type SeedFolder = { name: string; color: string };

export type SeedProfile = {
  /**
   * The reminders side.
   *  'tab'   — a general Reminders folder plus the ride-along Calendar folder,
   *            and strays land in the first reminders folder (CalMind).
   *  'lists' — the folders flagged `shopping` and `pantry` ARE the reminders
   *            side: one of each is seeded, neither counts as an ordinary
   *            reminders folder, any general reminders folder is folded away
   *            (tombstoned, its rows moved) and strays land on the shopping
   *            list, never the pantry (ChefMind).
   */
  reminders: { kind: 'tab' } | { kind: 'lists'; shopping: SeedFolder; pantry: SeedFolder };
  /** A starter calendar, and events with a dead calendar re-homed to the first. */
  calendar: boolean;
  /** A starter habit section, and habits with a dead section re-homed to the first. */
  habits: boolean;
};

/** The suite default: CalMind's starters. */
export const SUITE_SEEDS: SeedProfile = { reminders: { kind: 'tab' }, calendar: true, habits: true };

const live = (r: { deleted?: boolean }) => !r.deleted;

export function normalize(recs: AnyRec[], profile: SeedProfile = SUITE_SEEDS): { added: AnyRec[]; edited: AnyRec[] } {
  const added: AnyRec[] = [];
  const edited: AnyRec[] = [];
  const of = <T extends AnyRec['type']>(t: T) => recs.filter((r) => r.type === t && live(r)) as Rec<T>[];
  const lists = profile.reminders.kind === 'lists' ? profile.reminders : null;

  const folders = of('folder');
  const sections = of('section');

  const put = (r: AnyRec) => {
    added.push(r);
    return r;
  };
  const folder = (
    name: string, color: string, app: 'reminders' | 'notes',
    rideAlong = false, after?: string,
    flag?: 'shopping' | 'pantry',
  ): Rec<'folder'> => {
    const f: Rec<'folder'> = {
      id: newId(),
      type: 'folder',
      updated: 0,
      payload: {
        name, color, ord: ordBetween(after ?? null, null), app,
        ...(rideAlong ? { rideAlong: true } : {}),
        ...(flag === 'shopping' ? { shopping: true } : {}),
        ...(flag === 'pantry' ? { pantry: true } : {}),
      },
    };
    folders.push(f);
    return put(f) as Rec<'folder'>;
  };

  // An app's ordinary folders. Under 'lists' the flagged folders are not
  // ordinary: else the pantry is created on one load and folded away as a
  // stray reminders folder on the next, for ever.
  const appFolders = (app: 'reminders' | 'notes') =>
    folders.filter((f) => folderApp(f.payload) === app && !(lists && (f.payload.shopping || f.payload.pantry))).sort(byRecOrd);

  // Starters. 'tab': Reminders opens with its general folder plus the
  // ride-along Calendar folder. Notes always opens with General.
  if (!lists) {
    if (appFolders('reminders').length === 0) {
      folder(FOLDER_STARTER, C_REMINDERS, 'reminders');
    }
    // The ride-along folder always exists — folders_fixed()'s guarantee carried
    // over: it's the flag that's permanent, and an account from before the flag
    // (milestone 1) grows one on its next load.
    if (!appFolders('reminders').some((f) => f.payload.rideAlong)) {
      const last = appFolders('reminders').slice(-1)[0];
      folder(FOLDER_CALENDAR, C_CALENDAR_FOLDER, 'reminders', true, last?.payload.ord);
    }
  }
  if (appFolders('notes').length === 0) {
    folder(FOLDER_NOTES_STARTER, C_NOTES, 'notes');
  }
  if (lists) {
    // Permanent the way rideAlong is permanent: the flag is the identity, so an
    // account that predates a list grows it on its next load, and renaming the
    // folder never makes a second appear.
    if (!folders.some((f) => f.payload.shopping)) {
      const last = appFolders('reminders').slice(-1)[0];
      folder(lists.shopping.name, lists.shopping.color, 'reminders', false, last?.payload.ord, 'shopping');
    }
    if (!folders.some((f) => f.payload.pantry)) {
      const last = folders.filter((f) => f.payload.shopping).sort(byRecOrd).slice(-1)[0];
      folder(lists.pantry.name, lists.pantry.color, 'reminders', false, last?.payload.ord, 'pantry');
    }
    // FOLD ANY GENERAL REMINDERS FOLDER INTO THE SHOPPING LIST. Its rows move
    // first (the rehome pass below, once the folder is gone), then the folder
    // and its sections are tombstoned — the only place in the suite that
    // removes a container someone could have filed into. It runs only under a
    // 'lists' profile, against that app's own store (ChefMind: space 'chef'),
    // never CalMind's.
    for (const f of appFolders('reminders')) {
      f.deleted = true;
      edited.push(f);
      for (const s of sections.filter((x) => x.payload.folderId === f.id)) {
        s.deleted = true;
        edited.push(s);
      }
    }
  }
  const calendars = of('calendar');
  if (profile.calendar && calendars.length === 0) {
    calendars.push(
      put({ id: newId(), type: 'calendar', updated: 0, payload: { name: CALENDAR_STARTER, color: C_CAL, ord: ordBetween(null, null) } }) as Rec<'calendar'>,
    );
  }
  const habitSections = of('habitsection');
  if (profile.habits && habitSections.length === 0) {
    habitSections.push(
      put({ id: newId(), type: 'habitsection', updated: 0, payload: { name: HABIT_SECTION_STARTER, color: C_HABITS, ord: ordBetween(null, null) } }) as Rec<'habitsection'>,
    );
  }

  // Every folder keeps at least one section, so nothing can land loose.
  const secsOf = (fid: string) =>
    sections.filter((s) => live(s) && s.payload.folderId === fid).sort(byRecOrd);
  for (const f of folders.filter(live)) {
    if (secsOf(f.id).length === 0) {
      sections.push(
        put({ id: newId(), type: 'section', updated: 0, payload: { name: SECTION_DEFAULT, folderId: f.id, ord: ordBetween(null, null) } }) as Rec<'section'>,
      );
    }
  }

  // Re-home strays into their own app's containers. Ids make this cheap.
  // Under 'lists' a stray reminder lands on the SHOPPING list, deliberately
  // not the pantry: a stray is something to do, and the pantry is a claim
  // about what you already have.
  const secById = new Map(sections.filter(live).map((s) => [s.id, s]));
  const folderById = new Map(folders.filter(live).map((f) => [f.id, f]));
  const home = (app: 'reminders' | 'notes') =>
    lists && app === 'reminders'
      ? folders.filter((f) => f.payload.shopping).sort(byRecOrd)[0]!
      : appFolders(app)[0]!;
  const rehome = (r: Rec<'reminder'> | Rec<'note'>, app: 'reminders' | 'notes') => {
    let { folderId, sectionId } = r.payload;
    const f = folderById.get(folderId);
    if (!f || folderApp(f.payload) !== app) folderId = home(app).id;
    const sec = secById.get(sectionId);
    if (!sec || sec.payload.folderId !== folderId) sectionId = secsOf(folderId)[0]!.id;
    if (folderId !== r.payload.folderId || sectionId !== r.payload.sectionId) {
      r.payload = { ...r.payload, folderId, sectionId };
      edited.push(r);
    }
  };
  for (const r of of('reminder')) rehome(r, 'reminders');
  for (const n of of('note')) rehome(n, 'notes');

  // Events with a dead calendar fall to the first one; habits likewise. A
  // profile that seeds no calendar (or habit section) has nowhere to re-home
  // them TO, and its app writes neither.
  if (profile.calendar) {
    const calIds = new Set(calendars.map((c) => c.id));
    const firstCal = calendars.sort(byRecOrd)[0]!;
    for (const e of of('event')) {
      if (!calIds.has(e.payload.calendarId)) {
        e.payload = { ...e.payload, calendarId: firstCal.id };
        edited.push(e);
      }
    }
  }
  if (profile.habits) {
    const hsIds = new Set(habitSections.map((s) => s.id));
    const firstHs = habitSections.sort(byRecOrd)[0]!;
    for (const h of of('habit')) {
      if (!hsIds.has(h.payload.sectionId)) {
        h.payload = { ...h.payload, sectionId: firstHs.id };
        edited.push(h);
      }
    }
  }

  return { added, edited };
}
