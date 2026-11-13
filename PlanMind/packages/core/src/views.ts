import { todoCounter } from './limits';
import { CAPS, type CoreFunctions, type TodoRow, type ViewInput } from './model';
import { shiftDate } from './parse';
import { accomplishedTodos, carriedTodos, eventCells, inLanes, noteLanes, priorityCells, rowDone, visibleTodos } from './placement';
import { resolveLanes } from './selection';

const lanesOf = ({ data, selection, me }: ViewInput) => resolveLanes(selection, data.lists, me);
/** visibleTodos lists open rows first, so the split keeps each part in pos order. A row pointing at the day its to-do was ticked on is an open one. */
const split = (rows: TodoRow[]) => ({ todosOpen: rows.filter(r => !rowDone(r)), todosDone: rows.filter(rowDone) });

export const dayView: CoreFunctions['dayView'] = (input, date) => {
  const { data, today } = input;
  const lanes = lanesOf(input);
  const cells = priorityCells(data.priorities, date, lanes, data.lists, data.settings);
  return {
    date,
    lanes,
    schedule: eventCells(data.events, date, lanes, data.lists, data.settings),
    priorities: Array.from({ length: CAPS.prioritySlots }, (_, i) => ({ line: i + 1, cells: cells.filter(c => c.line === i + 1) })),
    // Earlier days' open to-dos come first on today's list (R10); split keeps them ahead of today's own. The ones ticked on this very day
    // are done rows of it, carried ones first, ahead of this day's own done rows.
    ...split([...carriedTodos(data.tasks, date, today, lanes, data.lists, data.settings), ...accomplishedTodos(data.tasks, date, lanes, data.lists, data.settings),
      ...visibleTodos(data.tasks, 'day', date, lanes, data.lists, data.settings)]),
    notes: noteLanes(data.notes, 'day', date, 'notes', lanes),
    caps: Object.fromEntries(lanes.map(lane => [lane.listId, { todosOpen: todoCounter(data.tasks, date, lane.listId, undefined, today) }])),
  };
};

export const weekView: CoreFunctions['weekView'] = (input, monday) => {
  const { data } = input;
  const lanes = lanesOf(input);
  return {
    monday,
    lanes,
    priorities: noteLanes(data.notes, 'week', monday, 'priorities', lanes),
    ...split(visibleTodos(data.tasks, 'week', monday, lanes, data.lists, data.settings)),
  };
};

/** Rows of 7 from the Monday on or before the 1st; omitted rows means 5 or 6, whatever the month needs. */
export const monthGrid: CoreFunctions['monthGrid'] = (first, rows) => {
  const month = first.slice(0, 7);
  const start = shiftDate(first, -((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7), 'day');
  const cells = Array.from({ length: 42 }, (_, i) => { const date = shiftDate(start, i, 'day'); return { date, inMonth: date.startsWith(month) }; });
  return cells.slice(0, (rows ?? (cells.slice(35).some(c => c.inMonth) ? 6 : 5)) * 7);
};

/** The grid is 6 Monday-first weeks from the Monday on or before the 1st. The days carry no marks (the chores are what the calendar shows); Priorities, Notes and To-do are the month's own. */
export const monthView: CoreFunctions['monthView'] = (input, first) => {
  const { data } = input;
  const lanes = lanesOf(input);
  return {
    first,
    lanes,
    grid: monthGrid(first, 6),
    priorities: noteLanes(data.notes, 'month', first, 'priorities', lanes),
    notes: noteLanes(data.notes, 'month', first, 'notes', lanes),
    ...split(visibleTodos(data.tasks, 'month', first, lanes, data.lists, data.settings)),
  };
};
