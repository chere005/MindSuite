import { dayLabel, shiftPeriod } from '../packages/core/src/planner';

/**
 * A Monday-to-Sunday week the way the approved wireframes write it: "Oct 12–18" inside one month, "Oct 26–Nov 1" across two
 * (core's weekLabel writes both months with spaces around the dash). `dash` is the page header's " – ".
 */
export function weekRange(monday: string, dash = '–'): string {
  const sunday = shiftPeriod(monday, 6, 'day');
  const from = dayLabel(monday, { month: 'short', day: 'numeric' });
  const to = dayLabel(sunday, monday.slice(0, 7) === sunday.slice(0, 7) ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${from}${dash}${to}`;
}

/** The sidebar's month row and the month sheet's label: "Jun 2026". */
export const monthShort = (first: string) => dayLabel(first, { month: 'short', year: 'numeric' });
