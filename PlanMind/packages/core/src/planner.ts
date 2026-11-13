import { shiftDate } from './parse';
import type { View } from './model';

/** The shared contract and the pure helpers written against it; other modules import from here. */
export * from './model';
export * from './people';
export * from './selection';
export * from './colors';
export * from './placement';
export * from './schedule';
export * from './priorities';
export * from './limits';
export * from './views';
export * from './chores';
export * from './calmind';

/** The selected window starts with seven dates on either side of today. */
export function dateWindow(center: string, radius = 7): string[] {
  return Array.from({ length: radius * 2 + 1 }, (_, i) => shiftDate(center, i - radius, 'day'));
}
/** PlanMind's weeks always start Monday, independent of locale preferences. */
export function periodStart(date: string, view: View): string {
  if (view === 'month') return date.slice(0, 7) + '-01';
  if (view === 'week') return shiftDate(date, -(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7, 'day');
  return date;
}
export function shiftPeriod(date: string, amount: number, view: View): string {
  return shiftDate(date, amount, view === 'month' ? 'month' : view === 'week' ? 'week' : 'day');
}
export function periodWindow(center: string, view: View): string[] {
  return Array.from({ length: 15 }, (_, i) => shiftPeriod(periodStart(center, view), i - 7, view));
}
export function weekLabel(monday: string): string {
  return `${dayLabel(monday, { month: 'short', day: 'numeric' })} – ${dayLabel(shiftDate(monday, 6, 'day'), { month: 'short', day: 'numeric' })}`;
}
export function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
