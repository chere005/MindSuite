import { PHONE_TABS, type View } from '../packages/core/src/planner';

/**
 * Where the person is, so a page that reloads itself for a new release puts them back: the view, the open period, whether the Chores
 * view is on, the Month a Day was opened from and the phone tab. It travels in the URL's hash for that one reload (never in browser
 * storage) and is cleared as it is read, so a reload by hand starts on today as it always did. Nothing here touches the DOM.
 */
export type Place = { view: View; date: string; chores: boolean; back: View | null; tab: string | null };

const VIEWS: readonly View[] = ['day', 'week', 'month'];
/** A real day of 2000 to 2099 (the range the app offers), not just something shaped like one ("2041-02-30" is not). */
const isDay = (value: string) => {
  if (!/^20\d\d-\d\d-\d\d$/.test(value)) { return false; }
  const [year, month, day] = value.split('-').map(Number), at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
};

/** The hash that says where the page is ("#view=week&date=2041-03-04"). */
export function encodePlace(place: Place): string {
  const params = new URLSearchParams({ view: place.view, date: place.date });
  if (place.chores) { params.set('chores', '1'); }
  if (place.back) { params.set('back', place.back); }
  if (place.tab) { params.set('tab', place.tab); }
  return `#${params}`;
}

/** The place a hash names, or null when it names none or anything about it is off (a hand-made or an old hash is never trusted halfway). */
export function parsePlace(hash: string): Place | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const view = params.get('view') as View | null, date = params.get('date'), back = params.get('back') as View | null, tab = params.get('tab');
  if (!view || !VIEWS.includes(view) || !date || !isDay(date)) { return null; }
  // A Back exists only on a Day that was opened from another view.
  if (back !== null && (view !== 'day' || back === 'day' || !VIEWS.includes(back))) { return null; }
  if (tab !== null && !(PHONE_TABS[view] as readonly string[]).includes(tab)) { return null; }
  return { view, date, chores: params.get('chores') === '1', back, tab };
}
