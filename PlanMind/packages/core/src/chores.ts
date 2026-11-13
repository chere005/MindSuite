import { itemColor } from './colors';
import type {
  ChoreCadence, ChoreDay, ChoreMark, ChoreMarkState, ChoreMonths, ChoreNth, ChoreOwners, ChoreRule, ChoreWeeks, ColorKey, Mutation, Rhythm, Snapshot, WeekLetter,
} from './model';
import { dayDiff, shiftDate } from './parse';
import { bothOwners, people } from './people';
import { monthGrid } from './views';

// The chore chart: recurring rules, the turns they make, and what a turn is as of today. Pure: no clock (callers pass `today`),
// no DOM, no storage. Weeks run Monday to Sunday and Saturday is never a chore day. A "turn" is one rule on one date; the only thing
// stored about a turn is its ChoreMark (done, let go, moved to the catch-up Friday, or an owner for that turn alone).
// Chores are always shared: nothing here reads the picker, so both people see every rule, whoever it is for.

/** What the chore views read; `lists` and `settings` give the colors, the rest is the chart. */
export type ChoreData = Pick<Snapshot, 'lists' | 'settings' | 'chores' | 'choreMarks' | 'rhythm'>;
/** What every view builder takes: the chart and `today` (a turn's state is always "as of today"). There is no selection: chores ignore the picker. */
export type ChoreInput = { data: ChoreData; today: string };

/** upcoming and today are open; missed is a past turn still inside its chore week; moved is missed and sent to the catch-up Friday; letgo is let go by hand or by time. */
export type ChoreTurnState = 'upcoming' | 'today' | 'missed' | 'moved' | 'done' | 'letgo';
export type ChoreTurn = {
  /** The mark id: `${rule.id}:${date}`. */
  id: string;
  rule: ChoreRule;
  date: string;
  mark: ChoreMark | null;
  state: ChoreTurnState;
  /** A let go that is the person's own (a mark) and so can be undone; false for time passing (superseded, expired). */
  byHand: boolean;
  /** mark.owners when set, else the rule's. */
  owners: ChoreOwners;
  color: ColorKey;
};

/** How a row is drawn: open rows have a check, missed rows also "Fri" and "Let go", catch-up rows a "from Tue" chip and "Let go", moved and letgo rows are dim chips that undo, done rows are crossed out. */
export type ChoreRowKind = 'open' | 'missed' | 'catchup' | 'moved' | 'letgo' | 'done';
export type ChoreRow = ChoreTurn & {
  kind: ChoreRowKind;
  title: string;
  /** 'A' or 'B' on a Week A / Week B rule. */
  chip: WeekLetter | null;
  /** The group of The rhythm the rule is in: how often it comes. */
  cadence: RhythmGroupKey;
  /** What the Day writes at the row's right end: 'Weekly', 'Week A', 'Week B' or 'Monthly'; null for a daily rule. */
  badge: string | null;
  /** 'Tue' on a catch-up row (done ones keep it), else null. */
  from: string | null;
  /** 'Thu 12'. */
  dateLabel: string;
  done: boolean;
  /** The person's name (their list's name: the id, capitalized) or 'Both', and the one a tap on the title makes it. */
  ownerName: string;
  nextOwnerName: string;
};
export type ChoreSection = { kind: ChoreRowKind; /** Only the Missed and Catch-up groups have a label. */ label: string | null; rows: ChoreRow[] };
export type DayChores = { date: string; today: boolean; /** Saturday: draw only "Day off". */ dayOff: boolean; sections: ChoreSection[] };

export type ChoreGridCell = {
  date: string;
  /** ✓ done, ○ today or missed, – let go or Saturday, · upcoming. */
  symbol: '✓' | '○' | '–' | '·';
  state: ChoreTurnState | 'off';
  today: boolean;
  /** Today or a past day with a turn: a tap toggles done. */
  canToggle: boolean;
  turn: ChoreTurn | null;
};
export type ChoreGridRow = { rule: ChoreRule; title: string; owners: ChoreOwners; color: ColorKey; cells: ChoreGridCell[] };
/** One day of the Week: its non-daily turns. Friday is always there ("Fri 6 · Catch-up"), and so is Saturday ("Day off"); other days only with rows. */
export type ChoreDayGroup = { date: string; label: string; today: boolean; dayOff: boolean; sections: ChoreSection[] };
export type WeekChores = {
  monday: string;
  letter: WeekLetter;
  /** 'Week A'. */
  label: string;
  /** M T W T F S S, Monday first. */
  columns: { date: string; label: string; today: boolean }[];
  grid: ChoreGridRow[];
  days: ChoreDayGroup[];
};
export type MonthChoreWeek = { monday: string; /** 'Nov 2–8 · Week A' */ label: string; letter: WeekLetter; rows: ChoreRow[] };
export type MonthChores = { first: string; monthly: ChoreRow[]; weeks: MonthChoreWeek[] };
export type MonthChoreDay = {
  date: string; inMonth: boolean; /** The day of the month. */ day: number; today: boolean; /** A Saturday of the month. */ dayOff: boolean;
  /** A day of the month before the rhythm starts: no turns, drawn muted. */ beforeStart: boolean; rows: ChoreRow[];
};
export type MonthChoreGridWeek = { monday: string; /** null for a week that ends before the rhythm starts. */ letter: WeekLetter | null; days: MonthChoreDay[] };
/**
 * A day of the planner's Month: one of its 42 cells, in monthView's order, with the letter of its week (A rows are the highlighted ones; null before the
 * rhythm starts), whether it is a Saturday (a quiet hatch in or out of the month; `dayOff` is only for a Saturday of the month) and, on a day of the month, its turns.
 */
export type MonthChoreCell = MonthChoreDay & { letter: WeekLetter | null; saturday: boolean };
/** The cell of a phone's calendar draws a bar for each of a day's first `CHORE_BARS` turns and "+n" for the rest. */
export const CHORE_BARS = 3;
/** `done` of `total` is the page's "1 of 11 done": every turn the calendar shows on the month's days (monthly and Week A / Week B only), those let go by hand included. */
export type MonthChoreGrid = { first: string; done: number; total: number; weeks: MonthChoreGridWeek[] };

export type RhythmGroupKey = 'daily' | 'weekly' | 'weekA' | 'weekB' | 'monthly';
export type RhythmGroup = { key: RhythmGroupKey; label: string; rules: ChoreRule[] };

const GROUP_LABELS: Record<RhythmGroupKey, string> = { daily: 'Daily', weekly: 'Weekly', weekA: 'Week A', weekB: 'Week B', monthly: 'Monthly' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const GRID_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 0 = Sunday .. 6 = Saturday. */
const weekday = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();
const monthLength = (date: string): number => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
const byOrder = (a: ChoreRule, b: ChoreRule) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const titleKey = (title: string) => title.trim().toLowerCase();

/** The Monday of `date`'s Monday-to-Sunday week. */
export const mondayOf = (date: string): string => shiftDate(date, -((weekday(date) + 6) % 7), 'day');
/** 'A' when the weeks between the Monday of `date` and the anchor's are even, else 'B'. */
export function weekLetter(date: string, anchor: string): WeekLetter {
  return Math.round(dayDiff(mondayOf(anchor), mondayOf(date)) / 7) % 2 === 0 ? 'A' : 'B';
}
/** The first Friday on or after `date`: the last day a turn can be made up. */
export const catchUpFriday = (date: string): string => shiftDate(date, (5 - weekday(date) + 7) % 7, 'day');
/** The Sunday on or before `date`: a chore week runs from it to the catch-up Friday. */
export const choreWeekStart = (date: string): string => shiftDate(date, -weekday(date), 'day');
/** 'Thu 12'. */
export const choreDayLabel = (date: string): string => `${DAY_NAMES[weekday(date)]} ${Number(date.slice(8))}`;

/** Whether one rule has a turn on `date`: never on a Saturday or before the rhythm's start. */
export function ruleTurnsOn(rule: ChoreRule, rhythm: Rhythm, date: string): boolean {
  const day = weekday(date);
  if (day === 6 || date < rhythm.start) return false;
  const c = rule.cadence;
  if (c.kind === 'daily') return true;
  if (c.day !== day) return false;
  if (c.kind === 'weekly') return c.weeks === 'every' || c.weeks === weekLetter(date, rhythm.anchor);
  const dom = Number(date.slice(8));
  const nth = c.nth === -1 ? dom + 7 > monthLength(date) : Math.ceil(dom / 7) === c.nth;
  return nth && (c.months === 'every' || (Number(date.slice(5, 7)) % 2 === 1) === (c.months === 'odd'));
}
/** The rules that have a turn on `date`, in rule order. */
export const turnsOn = (rules: readonly ChoreRule[], rhythm: Rhythm, date: string): ChoreRule[] =>
  [...rules].sort(byOrder).filter(rule => ruleTurnsOn(rule, rhythm, date));

/** The group of The rhythm a cadence is in: Weekly is every week, Week A and Week B every other. */
export const cadenceGroup = (cadence: ChoreCadence): RhythmGroupKey =>
  cadence.kind === 'daily' ? 'daily' : cadence.kind === 'monthly' ? 'monthly' : cadence.weeks === 'every' ? 'weekly' : cadence.weeks === 'A' ? 'weekA' : 'weekB';

/** Owner cycle on a tap: the partner, the owner, Both, then the partner again. */
export function nextOwners(owners: readonly string[]): ChoreOwners {
  const { owner, partner } = people();
  if (owners.length === 2) return [partner];
  return owners[0] === partner ? [owner] : owners[0] === owner ? newChoreOwners() : [partner];
}
const sameOwners = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
/** A person list's name is its id, capitalized (the server keeps it so), so a chore's owner reads as the picker writes that list. */
const ownerName = (owners: readonly string[]) => (owners.length === 2 ? 'Both' : (owners[0] ?? '').charAt(0).toUpperCase() + (owners[0] ?? '').slice(1));
/** What a tap on a turn's title makes its owners: null when that is the rule's own owners (the override goes away). */
export const nextTurnOwners = (turn: Pick<ChoreTurn, 'owners' | 'rule'>): ChoreOwners | null => {
  const next = nextOwners(turn.owners);
  return sameOwners(next, turn.rule.owners) ? null : next;
};

// ---------------------------------------------------------------------------------------------
// Turns and their state
// ---------------------------------------------------------------------------------------------

type Index = { rules: ChoreRule[]; rhythm: Rhythm; marks: Map<string, ChoreMark>; today: string; byTitle: Map<string, ChoreRule[]>; lists: ChoreData['lists']; settings: ChoreData['settings'] };

function indexOf(data: ChoreData, today: string): Index {
  const rules = [...data.chores].sort(byOrder);
  const byTitle = new Map<string, ChoreRule[]>();
  for (const rule of rules) byTitle.set(titleKey(rule.title), [...(byTitle.get(titleKey(rule.title)) ?? []), rule]);
  return { rules, rhythm: data.rhythm, marks: new Map(data.choreMarks.map(m => [m.id, m])), today, byTitle, lists: data.lists, settings: data.settings };
}

/** A later turn of this rule, or of any rule with the same title (trimmed, any case), on or before today and still inside the chore week: "nothing is worth doubling up for". */
function superseded(ix: Index, rule: ChoreRule, date: string): boolean {
  const same = ix.byTitle.get(titleKey(rule.title)) ?? [rule];
  const stop = ix.today < catchUpFriday(date) ? ix.today : catchUpFriday(date);
  for (let day = shiftDate(date, 1, 'day'); day <= stop; day = shiftDate(day, 1, 'day')) {
    if (same.some(other => ruleTurnsOn(other, ix.rhythm, day))) return true;
  }
  return false;
}

function stateOf(ix: Index, rule: ChoreRule, date: string, mark: ChoreMark | null): ChoreTurnState {
  if (mark?.state === 'done') return 'done';
  if (mark?.state === 'letgo' || superseded(ix, rule, date) || ix.today > catchUpFriday(date)) return 'letgo';
  if (date < ix.today) return mark?.moved ? 'moved' : 'missed';
  return date === ix.today ? 'today' : 'upcoming';
}

function turnOf(ix: Index, rule: ChoreRule, date: string): ChoreTurn {
  const id = `${rule.id}:${date}`;
  const mark = ix.marks.get(id) ?? null;
  const owners = mark?.owners ?? rule.owners;
  return { id, rule, date, mark, state: stateOf(ix, rule, date, mark), byHand: mark?.state === 'letgo', owners, color: itemColor(owners, ix.lists, ix.settings) };
}
const turnsAt = (ix: Index, date: string): ChoreTurn[] => turnsOn(ix.rules, ix.rhythm, date).map(rule => turnOf(ix, rule, date));

/** Every turn on `date` as of `today`, whoever it is for. */
export const choreTurns = (data: ChoreData, today: string, date: string): ChoreTurn[] => turnsAt(indexOf(data, today), date);

// ---------------------------------------------------------------------------------------------
// Rows and sections
// ---------------------------------------------------------------------------------------------

function rowOf(turn: ChoreTurn, kind: ChoreRowKind, from: string | null = null): ChoreRow {
  const c = turn.rule.cadence, cadence = cadenceGroup(c);
  return {
    ...turn, kind, title: turn.rule.title, from, dateLabel: choreDayLabel(turn.date), done: turn.state === 'done',
    chip: c.kind === 'weekly' && c.weeks !== 'every' ? c.weeks : null,
    cadence, badge: cadence === 'daily' ? null : GROUP_LABELS[cadence],
    ownerName: ownerName(turn.owners), nextOwnerName: ownerName(nextOwners(turn.owners)),
  };
}
/** The row of a turn on its own day, or null when nothing lists it (let go by time). */
function ownRow(turn: ChoreTurn): ChoreRow | null {
  switch (turn.state) {
    case 'done': return rowOf(turn, 'done');
    case 'moved': return rowOf(turn, 'moved');
    case 'letgo': return turn.byHand ? rowOf(turn, 'letgo') : null;
    default: return rowOf(turn, 'open');
  }
}

/** What a view lists: the daily chores (the Day lists them, the Week has them in its grid) and the looking-back group (the Day of today). */
type Scope = { daily: boolean; missedGroup: boolean };

/** The turns of the chore week that run Sunday up to the day before `date`, for the groups that look back. */
function earlier(ix: Index, date: string, scope: Scope): ChoreTurn[] {
  const turns: ChoreTurn[] = [];
  for (let day = choreWeekStart(date); day < date; day = shiftDate(day, 1, 'day')) turns.push(...turnsAt(ix, day).filter(t => scope.daily || t.rule.cadence.kind !== 'daily'));
  return turns;
}

function sectionsOf(ix: Index, date: string, scope: Scope): ChoreSection[] {
  const day = weekday(date);
  if (day === 6) return [];
  const own = turnsAt(ix, date).filter(t => scope.daily || t.rule.cadence.kind !== 'daily');
  const rows = own.flatMap(t => ownRow(t) ?? []);
  const of = (kind: ChoreRowKind) => rows.filter(r => r.kind === kind);
  const sections: ChoreSection[] = [];
  const add = (kind: ChoreRowKind, label: string | null, list: ChoreRow[]) => { if (list.length) sections.push({ kind, label, rows: list }); };
  add('open', null, of('open'));
  // Looking back: today (not a Friday) lists what this chore week missed; a Friday, today or ahead, lists what can still be made up.
  const back = day === 5 || (date === ix.today && scope.missedGroup) ? earlier(ix, date, scope) : [];
  if (day === 5 && date >= ix.today) add('catchup', 'Catch-up', back.filter(t => t.state === 'missed' || t.state === 'moved').map(t => rowOf(t, 'catchup', DAY_NAMES[weekday(t.date)])));
  else if (day !== 5 && date === ix.today && scope.missedGroup) add('missed', 'Missed', back.filter(t => t.state === 'missed').map(t => rowOf(t, 'missed')));
  add('moved', null, of('moved'));
  add('letgo', null, of('letgo'));
  // Made up on this Friday: a done turn of an earlier day that was moved here.
  const madeUp = day === 5 ? back.filter(t => t.state === 'done' && t.mark?.moved).map(t => rowOf(t, 'done', DAY_NAMES[weekday(t.date)])) : [];
  add('done', null, [...of('done'), ...madeUp]);
  return sections;
}

/**
 * The Chores of a day, in the order it draws: the day's open turns; then, on today (not a Friday), a labelled "Missed" group
 * (this chore week's missed turns that were not moved), or, on a Friday that is today or ahead, a labelled "Catch-up" group (this
 * chore week's missed or moved turns); then rows moved away from this day, rows let go by hand, and one pile of done rows (turns
 * made up on this Friday keep their `from`). An empty group is left out. Saturday is a day off with nothing else.
 */
export function dayChores(input: ChoreInput, date: string): DayChores {
  const ix = indexOf(input.data, input.today);
  return { date, today: date === input.today, dayOff: weekday(date) === 6, sections: sectionsOf(ix, date, { daily: true, missedGroup: true }) };
}

const cellOf = (turn: ChoreTurn | null, date: string, today: string): ChoreGridCell => {
  if (!turn) return { date, symbol: '–', state: 'off', today: date === today, canToggle: false, turn };
  const symbol = turn.state === 'done' ? '✓' : turn.state === 'letgo' ? '–' : turn.state === 'upcoming' ? '·' : '○';
  return { date, symbol, state: turn.state, today: date === today, canToggle: date <= today, turn };
};

/**
 * The Chores of a week: "Week A" or "Week B", the grid of the daily rules (one cell per day, Monday to Sunday), then a
 * group for each day with that day's non-daily turns. Past misses stay in their own day; Friday's group also lists the catch-up rows.
 */
export function weekChores(input: ChoreInput, monday: string): WeekChores {
  const ix = indexOf(input.data, input.today);
  const letter = weekLetter(monday, ix.rhythm.anchor);
  const dates = Array.from({ length: 7 }, (_, i) => shiftDate(monday, i, 'day'));
  const scope: Scope = { daily: false, missedGroup: false };
  const turns = new Map(dates.map(date => [date, turnsAt(ix, date)]));
  const grid = ix.rules.filter(rule => rule.cadence.kind === 'daily').map(rule => ({
    rule, title: rule.title, owners: rule.owners, color: itemColor(rule.owners, ix.lists, ix.settings),
    cells: dates.map(date => cellOf(turns.get(date)!.find(t => t.rule.id === rule.id) ?? null, date, input.today)),
  }));
  const days = dates.flatMap((date): ChoreDayGroup[] => {
    const day = weekday(date);
    const sections = sectionsOf(ix, date, scope);
    if (!sections.length && day !== 5 && day !== 6) return [];
    return [{ date, label: day === 5 ? `${choreDayLabel(date)} · Catch-up` : choreDayLabel(date), today: date === input.today, dayOff: day === 6, sections }];
  });
  return {
    monday, letter, label: `Week ${letter}`,
    columns: dates.map((date, i) => ({ date, label: GRID_LETTERS[i], today: date === input.today })),
    grid, days,
  };
}

/** 'Nov 2–8' within a month, 'Nov 30–Dec 6' across two. */
function rangeLabel(monday: string): string {
  const sunday = shiftDate(monday, 6, 'day');
  const start = `${MONTH_NAMES[Number(monday.slice(5, 7)) - 1]} ${Number(monday.slice(8))}`;
  return monday.slice(5, 7) === sunday.slice(5, 7) ? `${start}–${Number(sunday.slice(8))}` : `${start}–${MONTH_NAMES[Number(sunday.slice(5, 7)) - 1]} ${Number(sunday.slice(8))}`;
}

/** The rows a day has on the Month: its monthly and Week A / Week B turns (every-day and every-week chores live on the Day and the Week), as the day itself lists them. */
function monthRows(ix: Index, date: string): ChoreRow[] {
  return turnsAt(ix, date).filter(t => t.rule.cadence.kind === 'monthly' || (t.rule.cadence.kind === 'weekly' && t.rule.cadence.weeks !== 'every')).flatMap(t => ownRow(t) ?? []);
}

/**
 * The Chores of a month as a list: the month's monthly turns (each with its date label), then a group for each Monday-to-Sunday week
 * that touches the month with that week's Week A / Week B turns that fall in the month. A week with none to show has no group.
 */
export function monthChores(input: ChoreInput, first: string): MonthChores {
  const ix = indexOf(input.data, input.today);
  const monthly: ChoreRow[] = [];
  const weeks = new Map<string, ChoreRow[]>();
  for (let i = 0; i < monthLength(first); i++) {
    const date = shiftDate(first, i, 'day');
    for (const row of monthRows(ix, date)) {
      if (row.rule.cadence.kind === 'monthly') monthly.push(row);
      else weeks.set(mondayOf(date), [...(weeks.get(mondayOf(date)) ?? []), row]);
    }
  }
  return {
    first, monthly,
    weeks: [...weeks].map(([monday, rows]): MonthChoreWeek => {
      const letter = weekLetter(monday, ix.rhythm.anchor);
      return { monday, label: `${rangeLabel(monday)} · Week ${letter}`, letter, rows };
    }),
  };
}

/**
 * The Chores of a month as a calendar: its Monday-first weeks (four to six; a week with no day of the month is left out), each with its
 * letter (A or B, none before the rhythm starts) for the gutter, and in each day of the month that day's monthly and Week A / Week B
 * turns. A day outside the month is empty, a Saturday is a day off, a day before the rhythm starts has nothing and is muted.
 */
export function monthChoreGrid(input: ChoreInput, first: string): MonthChoreGrid {
  const weeks = monthWeeks(indexOf(input.data, input.today), first).filter(week => week.days.some(day => day.inMonth));
  const shown = weeks.flatMap(week => week.days.flatMap(day => day.rows));
  return { first, done: shown.filter(row => row.done).length, total: shown.length, weeks };
}

/** Every one of the six Monday-first weeks of monthView's grid, whether or not it holds a day of the month. */
function monthWeeks(ix: Index, first: string): MonthChoreGridWeek[] {
  const cells = monthGrid(first, 6).map(({ date, inMonth }): MonthChoreDay => ({
    date, inMonth, day: Number(date.slice(8)), today: date === ix.today, dayOff: inMonth && weekday(date) === 6, beforeStart: inMonth && date < ix.rhythm.start, rows: inMonth ? monthRows(ix, date) : [],
  }));
  return Array.from({ length: 6 }, (_, i) => {
    const days = cells.slice(i * 7, i * 7 + 7), monday = days[0].date;
    return { monday, letter: shiftDate(monday, 6, 'day') < ix.rhythm.start ? null : weekLetter(monday, ix.rhythm.anchor), days };
  });
}

/**
 * The Chores of a month for the planner's calendar: the 42 cells of monthView's grid (same dates, same order), each with its turns (the same monthly
 * and Week A / Week B turns the Chores Month page shows, whatever the picker shows) and what the Month draws around them: its week's letter and a Saturday's hatch.
 */
export const monthChoreCells = (input: ChoreInput, first: string): MonthChoreCell[] =>
  monthWeeks(indexOf(input.data, input.today), first).flatMap(week => week.days.map(day => ({ ...day, letter: week.letter, saturday: weekday(day.date) === 6 })));

/** What a phone's cell draws for a day's turns: a bar for each of the first `CHORE_BARS` and how many more there are ("+2"). */
export const choreBars = (rows: readonly ChoreRow[]): { bars: ChoreRow[]; more: number } =>
  ({ bars: rows.slice(0, CHORE_BARS), more: Math.max(0, rows.length - CHORE_BARS) });

// ---------------------------------------------------------------------------------------------
// Writes: the mutation a tap makes, and the editor's groups and defaults
// ---------------------------------------------------------------------------------------------

export type MarkChore = Extract<Mutation, { action: 'markChore' }>;
export type SaveChore = Extract<Mutation, { action: 'saveChore' }>;
export type ChoreTap = 'check' | 'move' | 'unmove' | 'letgo' | 'unletgo' | 'owner';

/**
 * What a tap on a turn writes. check toggles done (made up on its Friday, a catch-up row also keeps `moved`); move and unmove set
 * and clear the catch-up Friday; letgo and unletgo let it go by hand and take that back; owner cycles who it is for on this turn alone.
 * The server drops a mark that ends up open, unmoved and without an override.
 */
export function choreMark(turn: ChoreTurn & { kind?: ChoreRowKind }, tap: ChoreTap): MarkChore {
  const mark = turn.mark;
  let state: ChoreMarkState = mark?.state ?? 'open', moved = mark?.moved ?? false, owners = mark?.owners;
  if (tap === 'check') { state = turn.state === 'done' ? 'open' : 'done'; if (state === 'done' && turn.kind === 'catchup') moved = true; }
  else if (tap === 'move') { state = 'open'; moved = true; }
  else if (tap === 'unmove') { state = 'open'; moved = false; }
  else if (tap === 'letgo') state = 'letgo';
  else if (tap === 'unletgo') state = 'open';
  else owners = nextTurnOwners(turn) ?? undefined;
  return { action: 'markChore', ruleId: turn.rule.id, date: turn.date, state, moved, ...(owners ? { owners } : {}), revision: mark?.revision ?? 0 };
}

/** Saves a rule with some fields changed; the owner tap in The rhythm is `{ owners: nextOwners(rule.owners) }`. */
export const choreEdit = (rule: ChoreRule, patch: Partial<Pick<ChoreRule, 'title' | 'owners' | 'cadence'>>): SaveChore =>
  ({ action: 'saveChore', id: rule.id, title: patch.title ?? rule.title, owners: patch.owners ?? rule.owners, cadence: patch.cadence ?? rule.cadence, revision: rule.revision });
export const choreAdd = (id: string, fields: Pick<ChoreRule, 'title' | 'owners' | 'cadence'>): SaveChore => ({ action: 'saveChore', id, ...fields, revision: 0 });

/** The Monday that makes the week of `today` Week A or Week B. */
export const rhythmAnchor = (week: WeekLetter, today: string): string => (week === 'A' ? mondayOf(today) : shiftDate(mondayOf(today), -7, 'day'));

/** Daily, Weekly (every week), Week A, Week B, Monthly: each group's rules in rule order, empty groups kept so each can end with its add line. */
export function rhythmGroups(rules: readonly ChoreRule[]): RhythmGroup[] {
  const sorted = [...rules].sort(byOrder);
  return (Object.keys(GROUP_LABELS) as RhythmGroupKey[]).map(key => ({ key, label: GROUP_LABELS[key], rules: sorted.filter(rule => cadenceGroup(rule.cadence) === key) }));
}
/** A new rule is for both of us, whatever the picker shows (a tap on its circle in The rhythm hands it to one of us). */
export const newChoreOwners = (): ChoreOwners => bothOwners() as ChoreOwners;
/** A new weekly rule starts on today's weekday: Sunday when today is Saturday. */
export const newChoreDay = (today: string): 0 | 1 | 2 | 3 | 4 | 5 => (weekday(today) % 6) as 0 | 1 | 2 | 3 | 4 | 5;

/** The cadence a new rule of a group starts with: its day is today's weekday (Sunday on a Saturday); a monthly rule starts on the 1st such day of every month. */
export function choreStart(group: RhythmGroupKey, today: string): ChoreCadence {
  const day = newChoreDay(today);
  switch (group) {
    case 'daily': return { kind: 'daily' };
    case 'weekly': return { kind: 'weekly', day, weeks: 'every' };
    case 'weekA': return { kind: 'weekly', day, weeks: 'A' };
    case 'weekB': return { kind: 'weekly', day, weeks: 'B' };
    case 'monthly': return { kind: 'monthly', nth: 1, day, months: 'every' };
  }
}

/** One thing a rule's when-controls change: the weekday, the weeks (weekly rules), or the nth and the months (monthly rules). */
export type CadenceChange = { day: ChoreDay } | { weeks: ChoreWeeks } | { nth: ChoreNth } | { months: ChoreMonths };
/** A cadence with that one thing changed; a change that does not belong to the cadence's kind (a daily rule has none) leaves it as it is. */
export function cadenceWith(cadence: ChoreCadence, change: CadenceChange): ChoreCadence {
  if (cadence.kind === 'daily') return cadence;
  if ('day' in change) return { ...cadence, day: change.day };
  if ('weeks' in change) return cadence.kind === 'weekly' ? { ...cadence, weeks: change.weeks } : cadence;
  if ('nth' in change) return cadence.kind === 'monthly' ? { ...cadence, nth: change.nth } : cadence;
  return cadence.kind === 'monthly' ? { ...cadence, months: change.months } : cadence;
}

/** What a closed row of The rhythm says about when: 'Mon', '1st Mon', 'Last Fri · odd'; nothing for a daily rule (its group says it). */
export function cadenceText(cadence: ChoreCadence): string {
  if (cadence.kind === 'daily') return '';
  const day = DAY_NAMES[cadence.day];
  if (cadence.kind === 'weekly') return day;
  return `${cadence.nth === -1 ? 'Last' : ['1st', '2nd', '3rd', '4th'][cadence.nth - 1]} ${day}${cadence.months === 'every' ? '' : ` · ${cadence.months}`}`;
}
