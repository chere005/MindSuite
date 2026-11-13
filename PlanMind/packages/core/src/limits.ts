import { CAPS, type CoreFunctions } from './model';
import { isCarried } from './placement';

/** One phone row in characters at the smallest supported phone; lanes share it (a priority line is one lane of it: dayPriorityText). */
const PHONE_ROW_CHARS = 36;

export const textLimit: CoreFunctions['textLimit'] = (kind, scope, linked) => {
  switch (kind) {
    case 'event': return linked ? CAPS.dayEventTextLinked : CAPS.dayEventText;
    case 'priority': return linked ? CAPS.dayPriorityTextLinked : CAPS.dayPriorityText;
    case 'todo': return scope === 'day' ? CAPS.dayTodoText : CAPS.periodTodoText;
    case 'note': return scope === 'day' ? CAPS.dayNotesChars : CAPS.docChars;
  }
};

/**
 * Unicode code points, as the server counts them ([...s].length here, mb_strlen there): an emoji is 1,
 * a letter plus a combining mark is 2. Line breaks count as one, as the server stores them. The server trims
 * single-line text before counting and keeps notes as typed, so a caller counting a title passes it trimmed.
 */
export const counter: CoreFunctions['counter'] = (text, max) => {
  const used = [...text.replace(/\r\n?/g, '\n')].length;
  return { used, max, over: used > max };
};

/**
 * Open day to-dos of a list; `over` means there is no room for one more (used has reached the cap), which is
 * when the server answers `limit`. Pass the id of a to-do being edited so it does not count against itself.
 */
export const todoCounter: CoreFunctions['todoCounter'] = (tasks, date, listId, excludeId, today) => {
  const used = tasks.filter(t => t.scope === 'day' && !t.done && t.id !== excludeId && t.owners.includes(listId) && (t.date === date || isCarried(t, date, today))).length;
  return { used, max: CAPS.dayTodosPerList, over: used >= CAPS.dayTodosPerList };
};

export const todoSlots: CoreFunctions['todoSlots'] = (open, done = []) => {
  // A row pointing at the day its to-do was ticked on (`wentTo`) is a done to-do, so like a done row it takes a line but never counts against
  // the cap or hides a real open one behind "+N more"; visibleTodos puts those rows last, so the order of the open rows is unchanged.
  const real = open.filter(row => row.wentTo === undefined);
  const filled = [...real.slice(0, CAPS.dayTodosPerList), ...open.filter(row => row.wentTo !== undefined)];
  // Done rows are stacked at the bottom of the same lines and use up blank lines, but never count against the cap of open ones.
  return { filled, more: real.slice(CAPS.dayTodosPerList), done: [...done], empty: Math.max(0, CAPS.dayTodosPerList - filled.length - done.length) };
};

export const periodBlankLines: CoreFunctions['periodBlankLines'] = (min, open, done) => Math.max(1, min - open - done);

export const fullOwnerOnEdit: CoreFunctions['fullOwnerOnEdit'] = (tasks, task, date, owners, today) => {
  if (task.done) return undefined;
  const counted = (owner: string) => task.owners.includes(owner) && (task.date === date || isCarried(task, date, today));
  return owners.find(owner => !counted(owner) && todoCounter(tasks, date, owner, task.id, today).over);
};

export const laneChars: CoreFunctions['laneChars'] = (laneCount, span) => Math.floor(PHONE_ROW_CHARS / Math.max(1, laneCount)) * span;
