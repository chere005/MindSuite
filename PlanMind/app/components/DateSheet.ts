import '../styles/components.css';
import '../styles/phone.css';
import { dayLabel, monthGrid, periodStart, shiftPeriod, type View } from '../../packages/core/src/planner';
import { weekRange } from '../dates';
import { esc, icons, type PanelContext } from '../panelContext';

/**
 * The phone's date selector (approved wireframes): the sheet the date in the top bar opens. A calendar on Day, a
 * Monday-to-Sunday list on Week, a month grid on Month. Picking a date closes the sheet and opens that period; the
 * sheet's own browsing (which month, which weeks) never moves the page until something is picked. Arrow keys move
 * between dates, PageUp and PageDown change month or year, Escape closes.
 */
const FIRST = '2000-01-01', LAST = '2099-12-31';
const inRange = (date: string) => date >= FIRST && date <= LAST;

type Browse = {
  heading: string; today: string; prev: string; next: string;
  title(cursor: string): string;
  /** The cursor after stepping, or null at the end of the range. */
  step(cursor: string, direction: 1 | -1): string | null;
  body(cursor: string, ctx: PanelContext): string;
  /** The cursor that puts `date` on screen. */
  reveal(cursor: string, date: string): string;
  /** The date an arrow key or page key leads to from `date`, or null. */
  key(key: string, date: string): string | null;
  cursorOf(date: string): string;
};

const dayBrowse: Browse = {
  heading: 'Choose a day', today: 'Today', prev: 'Previous month', next: 'Next month',
  title: cursor => dayLabel(cursor, { month: 'long', year: 'numeric' }),
  step: (cursor, direction) => { const next = shiftPeriod(cursor, direction, 'month'); return next >= FIRST && next <= '2099-12-01' ? next : null; },
  body(cursor, ctx) {
    const heads = Array.from({ length: 7 }, (_, i) => `<span class="ds-weekday" aria-hidden="true">${dayLabel(shiftPeriod('2024-01-01', i, 'day'), { weekday: 'narrow' })}</span>`).join('');
    const days = monthGrid(cursor).map(({ date, inMonth }) => {
      const label = dayLabel(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + (date === ctx.today ? ', Today' : '');
      return `<button type="button" class="ds-day${inMonth ? '' : ' out'}" data-date="${date}" aria-label="${esc(label)}" aria-current="${date === ctx.date ? 'date' : 'false'}"${date === ctx.today ? ' data-today' : ''}${inRange(date) ? '' : ' disabled'}>${Number(date.slice(8))}</button>`;
    }).join('');
    return `<div class="ds-days" role="group" aria-label="${esc(dayLabel(cursor, { month: 'long', year: 'numeric' }))}">${heads}${days}</div>`;
  },
  reveal: (cursor, date) => date.startsWith(cursor.slice(0, 7)) ? cursor : periodStart(date, 'month'),
  key(key, date) {
    const to = key === 'ArrowLeft' ? shiftPeriod(date, -1, 'day') : key === 'ArrowRight' ? shiftPeriod(date, 1, 'day') : key === 'ArrowUp' ? shiftPeriod(date, -7, 'day') : key === 'ArrowDown' ? shiftPeriod(date, 7, 'day')
      : key === 'PageUp' ? shiftPeriod(date, -1, 'month') : key === 'PageDown' ? shiftPeriod(date, 1, 'month') : null;
    return to && inRange(to) ? to : null;
  },
  cursorOf: date => periodStart(date, 'month'),
};

const WEEKS = 5;
const weekBrowse: Browse = {
  heading: 'Choose a week', today: 'This week', prev: 'Earlier weeks', next: 'Later weeks',
  title: () => 'Choose a week',
  step: (cursor, direction) => { const next = shiftPeriod(cursor, direction * WEEKS, 'week'); return inRange(next) ? next : null; },
  body(cursor, ctx) {
    const thisWeek = periodStart(ctx.today, 'week');
    const rows = Array.from({ length: WEEKS }, (_, i) => shiftPeriod(cursor, i - Math.floor(WEEKS / 2), 'week')).map(monday => {
      const label = `${weekRange(monday)}, ${monday.slice(0, 4)}, Monday to Sunday${monday === thisWeek ? ', This week' : ''}`;
      return `<button type="button" class="ds-week" data-date="${monday}" aria-label="${esc(label)}" aria-current="${monday === ctx.date ? 'date' : 'false'}"${monday === thisWeek ? ' data-today' : ''}${inRange(monday) ? '' : ' disabled'}><span>${esc(weekRange(monday))}</span><small>${monday === thisWeek ? 'This week' : monday.slice(0, 4) === ctx.today.slice(0, 4) ? '' : monday.slice(0, 4)}</small></button>`;
    }).join('');
    return `<div class="ds-weeks" role="group" aria-label="Weeks">${rows}</div>`;
  },
  reveal(cursor, date) {
    const first = shiftPeriod(cursor, -Math.floor(WEEKS / 2), 'week'), last = shiftPeriod(cursor, Math.floor(WEEKS / 2), 'week');
    return date < first ? shiftPeriod(date, Math.floor(WEEKS / 2), 'week') : date > last ? shiftPeriod(date, -Math.floor(WEEKS / 2), 'week') : cursor;
  },
  key(key, date) {
    const to = key === 'ArrowUp' ? shiftPeriod(date, -1, 'week') : key === 'ArrowDown' ? shiftPeriod(date, 1, 'week') : null;
    return to && inRange(to) ? to : null;
  },
  cursorOf: date => periodStart(date, 'week'),
};

const monthBrowse: Browse = {
  heading: 'Choose a month', today: 'This month', prev: 'Previous year', next: 'Next year',
  title: cursor => cursor.slice(0, 4),
  step: (cursor, direction) => { const next = shiftPeriod(cursor, direction * 12, 'month'); return inRange(next) ? next : null; },
  body(cursor, ctx) {
    const months = Array.from({ length: 12 }, (_, i) => `${cursor.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-01`).map(first => {
      const label = dayLabel(first, { month: 'long', year: 'numeric' }) + (first === periodStart(ctx.today, 'month') ? ', This month' : '');
      return `<button type="button" class="ds-month" data-date="${first}" aria-label="${esc(label)}" aria-current="${first === ctx.date ? 'date' : 'false'}"${first === periodStart(ctx.today, 'month') ? ' data-today' : ''}${inRange(first) ? '' : ' disabled'}>${dayLabel(first, { month: 'short' })}</button>`;
    }).join('');
    return `<div class="ds-months" role="group" aria-label="${cursor.slice(0, 4)}">${months}</div>`;
  },
  reveal: (cursor, date) => date.startsWith(cursor.slice(0, 4)) ? cursor : `${date.slice(0, 4)}-01-01`,
  key(key, date) {
    const to = key === 'ArrowLeft' ? shiftPeriod(date, -1, 'month') : key === 'ArrowRight' ? shiftPeriod(date, 1, 'month') : key === 'ArrowUp' ? shiftPeriod(date, -3, 'month') : key === 'ArrowDown' ? shiftPeriod(date, 3, 'month')
      : key === 'PageUp' ? shiftPeriod(date, -12, 'month') : key === 'PageDown' ? shiftPeriod(date, 12, 'month') : null;
    return to && inRange(to) ? to : null;
  },
  cursorOf: date => `${date.slice(0, 4)}-01-01`,
};
const BROWSE: Record<View, Browse> = { day: dayBrowse, week: weekBrowse, month: monthBrowse };
const SYMBOLS: Record<View, { prev: string; next: string }> = {
  day: { prev: icons.left, next: icons.right }, month: { prev: icons.left, next: icons.right },
  week: { prev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>', next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg>' },
};

export function openDateSheet(ctx: PanelContext): void {
  const view = ctx.view, browse = BROWSE[view];
  let cursor = browse.cursorOf(ctx.date);
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet date-sheet';
  dialog.dataset.view = view;
  dialog.setAttribute('aria-label', browse.heading);
  dialog.innerHTML = `<div class="sheet-head"><button type="button" class="icon-button" data-step="-1" aria-label="${browse.prev}">${SYMBOLS[view].prev}</button><h2 class="sheet-title"></h2><button type="button" class="icon-button" data-step="1" aria-label="${browse.next}">${SYMBOLS[view].next}</button></div>
<div class="sheet-body"></div>
<div class="sheet-actions"><button type="button" class="quiet-button" data-today>${browse.today}</button><span class="grow"></span><button type="button" class="text-button" data-close>Close</button></div>`;
  const q = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const body = q('.sheet-body'), steps = [...dialog.querySelectorAll<HTMLButtonElement>('[data-step]')];

  function draw() {
    q('.sheet-title').textContent = browse.title(cursor);
    body.innerHTML = browse.body(cursor, ctx);
    for (const button of steps) { button.disabled = browse.step(cursor, Number(button.dataset.step) as 1 | -1) === null; }
    // One stop in the grid for Tab: the open date, else the first one that can be picked.
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('[data-date]')];
    const stop = buttons.find(b => b.getAttribute('aria-current') === 'date') ?? buttons.find(b => !b.disabled && !b.classList.contains('out'));
    for (const button of buttons) { button.tabIndex = button === stop ? 0 : -1; }
  }
  const pick = (date: string) => { dialog.close(); ctx.go(date, true); };
  const focusDate = (date: string) => {
    cursor = browse.reveal(cursor, date);
    draw();
    const target = body.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
    for (const button of body.querySelectorAll<HTMLButtonElement>('[data-date]')) { button.tabIndex = button === target ? 0 : -1; }
    target?.focus();
  };

  dialog.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const date = target.closest<HTMLElement>('[data-date]')?.dataset.date;
    if (date) { pick(date); return; }
    const step = target.closest<HTMLElement>('[data-step]');
    if (step) { cursor = browse.step(cursor, Number(step.dataset.step) as 1 | -1) ?? cursor; draw(); return; }
    if (target.closest('[data-today]')) { pick(ctx.today); return; }
    if (target.closest('[data-close]')) { dialog.close(); return; }
    // A tap on the dimmed page behind closes it.
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) { dialog.close(); }
  });
  dialog.addEventListener('keydown', event => {
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset.date;
    const to = from ? browse.key(event.key, from) : null;
    if (to) { event.preventDefault(); focusDate(to); }
  });
  dialog.addEventListener('close', () => dialog.remove());

  document.body.append(dialog);
  draw();
  dialog.showModal();
  (body.querySelector<HTMLElement>('[tabindex="0"]') ?? dialog.querySelector<HTMLElement>('[data-close]'))?.focus();
}
