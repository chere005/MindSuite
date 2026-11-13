/**
 * PlanMind shared contract: records, API, view models, constants and the signatures of the pure
 * helpers that packages/core implements. Types and constants only; no behavior, no imports, no DOM.
 *
 * Rules for this file
 * - It mirrors docs/ux/IMPLEMENTATION-SPEC.md. Change both together, and only through the lead.
 * - Keep it erasable TypeScript (no enum, namespace or parameter properties): tools/gen-limits.mjs
 *   imports it directly under Node 24 type stripping to generate server/lib/limits.php from CAPS.
 * - PHP in server/lib mirrors the JSON shapes below exactly. CAPS is the single source for both.
 * - Nothing here is exported from another file yet; implementers re-export what they need from
 *   packages/core/src/planner.ts.
 */

// ---------------------------------------------------------------------------------------------
// Identity, views, scopes
// ---------------------------------------------------------------------------------------------

/**
 * The account id of one of the two people: a lowercase login name, as records store it (createdBy, owners, note keys, prefs).
 * Which account holds which role comes only from the server's private config, sent with the session (`Session.people`) and set
 * once in people.ts; code never names an account. A flavor rather than a strict brand: ids arrive as plain strings from JSON.
 * Authorization only ever admits these two.
 */
export type PersonId = string & { readonly __personId?: never };
/** The two roles. Both is the two of them together (a view, and the linked owners of an item), never a third account. */
export type PersonRole = 'owner' | 'partner';
/** Which account holds each role: `people` in the server config, sent with the session. */
export type People = Readonly<Record<PersonRole, PersonId>>;
/** One of the two accounts (the name the code was written against). */
export type Person = PersonId;
/** A person's id (their permanent list) or a custom list UUID. Never 'both': Both is a view. */
export type ListId = string;
/** What the picker can select as the base: the Both view, or exactly one list. */
export type ViewBase = 'both' | ListId;
/** Which planner panel is open. */
export type View = 'day' | 'week' | 'month';
/** The period a to-do or text belongs to. Same words as View. */
export type Scope = View;
export type ItemKind = 'todo' | 'priority' | 'event';
/** The permanent lists in their order (0 and 1, ahead of every custom list), by role; people.ts resolves them to the two accounts. */
export const PERSON_ROLES = ['partner', 'owner'] as const satisfies readonly PersonRole[];
/** Storage format inside the encrypted plaintext. v5 enforces a 30-minute minimum for schedule entries. */
export const STORE_VERSION = 5;

/**
 * Owners of an item. Canonical form is sorted and unique, and only two shapes are valid:
 * exactly one existing list id, or exactly the two people's ids, sorted (a linked "Both" item: ONE record).
 */
export type Owners = ListId[];

// ---------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------

export const COLOR_KEYS = ['green', 'yellow', 'purple', 'blue', 'orange', 'red', 'teal', 'pink', 'gray'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
const [green, yellow, purple] = COLOR_KEYS;
/** Defaults from the approved wireframes, by role: the partner's list yellow, the owner's green, Both purple. */
export const DEFAULT_COLORS = { owner: green, partner: yellow, both: purple } as const satisfies Record<PersonRole | 'both', ColorKey>;
/** New custom lists take the first unused entry of this cycle, then wrap around. */
export const CUSTOM_COLOR_CYCLE: readonly ColorKey[] = ['blue', 'orange', 'teal', 'pink', 'red', 'gray'];
/** Base hues. tint() mixes them with the active theme's surface and text into bg, fg and line. */
export const COLOR_HUES: Record<ColorKey, string> = {
  green: '#2fb67c', yellow: '#e0b400', purple: '#8b7cf6', blue: '#4a90e2', orange: '#f08a3c',
  red: '#e5534b', teal: '#2bb5b0', pink: '#e56fa8', gray: '#8a8f98',
};
/** WCAG AA for normal text. colors.test.ts requires it for every theme and every color key. */
export const MIN_CONTRAST = 4.5;

// ---------------------------------------------------------------------------------------------
// Caps and defaults. Enforced by the server for every client; the UI only shows live counters.
// Text lengths are Unicode code points ([...s].length in TS, mb_strlen in PHP), never bytes.
// ---------------------------------------------------------------------------------------------

export const CAPS = {
  /**
   * Day schedule entry in one lane / an entry spanning both lanes (a linked Both event). The owner, 2026-11-01: no limit that fits a row; a block
   * shows as much of its text as its size allows, with an ellipsis, so this is only the bound the server keeps on a stored text.
   */
  dayEventText: 500,
  dayEventTextLinked: 500,
  /** Day priority line. Linked priorities can show as two half-lane cells, so they use the lane width too. */
  dayPriorityText: 18,
  dayPriorityTextLinked: 18,
  /** Day to-do title, and the number of OPEN day to-dos per list (a linked to-do counts for both owners). The owner set 13 on 2026-10-31. */
  dayTodoText: 36,
  dayTodosPerList: 13,
  /** Day notes per list. */
  dayNotesChars: 400,
  /** Week and Month to-do title; sanity count of week/month to-dos per list and period (all rows). */
  periodTodoText: 500,
  periodTodosPerList: 200,
  /** Week/Month priorities and notes text per list and period. */
  docChars: 12000,
  prioritySlots: 5,
  /**
   * Schedule window in minutes since midnight of the entry's date: 7:00 to 7:00 the next morning (1860), a planner day. The AM page shows 7:00 to
   * 21:00 (the "8p" row is 8:00 to 9:00 pm); the PM page shows 21:00 to 7:00 (9p, 10p, 11p, 12a ... 6a), the night of that date.
   */
  eventStartMin: 420,
  eventEndMin: 1860,
  /** Stored times and edge adjustments keep quarter-hour precision. New appointments need at least a half hour. */
  eventStep: 15,
  eventDefaultLength: 30,
  eventMinLength: 30,
  /** Picker. */
  maxOverlays: 2,
  customListsMax: 12,
  listNameChars: 24,
  /** To-do order gap and the point where a bucket is renumbered. */
  posGap: 1024,
  /** Store. */
  itemsMax: 20000,
  notesMax: 20000,
  /** Chores: a rule's title, how many rules the household keeps, and how many marks (one per touched turn) the store holds. */
  choreTitleChars: 36,
  choresMax: 60,
  choreMarksMax: 20000,
  storeBytesMax: 8000000,
  requestBytesMax: 65536,
} as const;
export type CapName = keyof typeof CAPS;

/** Hour labels of the Day schedule rows: 7a through the 8p row (the AM page), then 9p through the 6a row (the PM page). */
export const SCHEDULE_ROWS = ['7a', '8a', '9a', '10a', '11a', '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p', '12a', '1a', '2a', '3a', '4a', '5a', '6a'] as const;

/** Phone bottom tab bars (approved). The first entry of each is the default tab. */
export const PHONE_TABS = {
  day: ['schedule', 'todo', 'notes', 'chores'],
  week: ['priorities', 'todo', 'chores'],
  month: ['calendar', 'priorities', 'todo', 'notes', 'chores'],
} as const satisfies Record<View, readonly string[]>;
export type DayTab = (typeof PHONE_TABS.day)[number];
export type WeekTab = (typeof PHONE_TABS.week)[number];
export type MonthTab = (typeof PHONE_TABS.month)[number];

// ---------------------------------------------------------------------------------------------
// Records (the decrypted store, and what the API returns)
// ---------------------------------------------------------------------------------------------

type Stamped = { revision: number; createdBy: Person; updatedBy: Person; createdAt: string; updatedAt: string };

/** The two people's lists are permanent and cannot be deleted or renamed (a person list's name is its id, capitalized); custom lists can. Both is not a list. */
export type ListRecord = {
  id: ListId;
  kind: 'person' | 'custom';
  name: string;
  color: ColorKey;
  /** Custom lists: max+1 on create. Person lists: 0 and 1, always first. */
  order: number;
  revision: number;
  /** Fingerprint of the creating request (custom lists only); server-owned, clients ignore it. */
  ak?: string;
  createdBy?: Person;
  updatedAt: string;
};

/**
 * Household-wide settings. bothColor is the DEFAULT color of every item with two owners: each person may pick their own (the account
 * preference `Session.bothColor`, the owner, 2026-11-09), and the views read that one through `personalSettings`.
 */
export type Settings = { bothColor: ColorKey; revision: number; updatedAt: string };

export type Task = Stamped & {
  id: string;
  scope: Scope;
  /** day: the date; week: the Monday; month: the first of the month. */
  date: string;
  owners: Owners;
  title: string;
  done: boolean;
  /**
   * Day to-dos only, and only while `done`: the date of the page it was checked on, which is its own date or (a carried row ticked on
   * today's Day) the day it was carried to; never before `date`. Absent means it was done on its own date (every to-do checked before
   * 0.14.0). The day it was accomplished shows it checked; its own earlier day shows it unchecked, pointing there (TodoRow.wentTo).
   * Unchecking removes it; moving a done to-do to another day makes it done on that day (it is removed).
   */
  doneOn?: string;
  /** Integer order inside (scope, date), spaced by CAPS.posGap. Server-maintained; never sent by clients. */
  pos: number;
  ak: string;
};

/** Day priority line. Week and Month priorities are note text, not records. */
export type Priority = Stamped & {
  id: string;
  date: string;
  owners: Owners;
  /** Line 1..5 PER OWNER; keys equal owners. A linked item may sit on different lines in each list. */
  slots: Record<ListId, number>;
  text: string;
  ak: string;
};

export type ScheduleEvent = Stamped & {
  id: string;
  date: string;
  owners: Owners;
  text: string;
  /** Minutes since midnight, multiple of 15, within [eventStartMin, eventEndMin - eventMinLength]. */
  start: number;
  /** Minutes, multiple of 15, at least eventMinLength, default eventDefaultLength; start + length <= eventEndMin. */
  length: number;
  ak: string;
};

export type NoteField = 'notes' | 'priorities';
/** Allowed (scope, field) pairs: day/notes, week/priorities, month/priorities, month/notes. */
export const NOTE_FIELDS = { day: ['notes'], week: ['priorities'], month: ['priorities', 'notes'] } as const satisfies Record<Scope, readonly NoteField[]>;

/** One text per list, period and field. Created with revision 0 in the request; stored from revision 1. */
export type Note = {
  /** `${scope}:${period}:${listId}:${field}` */
  key: string;
  scope: Scope;
  period: string;
  listId: ListId;
  field: NoteField;
  text: string;
  revision: number;
  updatedBy: Person;
  updatedAt: string;
};

/** The picker state. overlays are custom lists only, unique, never equal to base, at most CAPS.maxOverlays. */
export type Selection = { base: ViewBase; overlays: ListId[] };
export const DEFAULT_SELECTION: Selection = { base: 'both', overlays: [] };
/** The desktop sidebar. Anything the server does not recognise reads as 'shown'. */
export type SidebarState = 'shown' | 'hidden';
export const DEFAULT_SIDEBAR: SidebarState = 'shown';
/** Per-user preferences, stored server side in the encrypted store (never in browser storage). */
export type Prefs = { selection: Selection; sidebar: SidebarState };

// ---------------------------------------------------------------------------------------------
// Chores (the household chart). Rules recur by weekday; a mark records what happened to ONE turn of a rule.
// Weeks run Monday to Sunday; Saturday is never a chore day (a rule's day is 0 = Sunday .. 5 = Friday).
// ---------------------------------------------------------------------------------------------

/** 0 = Sunday .. 5 = Friday. Saturday (6) is never allowed. */
export const CHORE_DAYS = [0, 1, 2, 3, 4, 5] as const;
export type ChoreDay = (typeof CHORE_DAYS)[number];
/** Which weeks a weekly rule turns on: every week, or only Week A or Week B of the rhythm. */
export const CHORE_WEEKS = ['every', 'A', 'B'] as const;
export type ChoreWeeks = (typeof CHORE_WEEKS)[number];
export type WeekLetter = 'A' | 'B';
/** Which months a monthly rule turns in. Odd months are Jan, Mar, May, Jul, Sep, Nov. */
export const CHORE_MONTHS = ['every', 'odd', 'even'] as const;
export type ChoreMonths = (typeof CHORE_MONTHS)[number];
/** The nth such weekday of the month; -1 is the last. */
export const CHORE_NTHS = [1, 2, 3, 4, -1] as const;
export type ChoreNth = (typeof CHORE_NTHS)[number];
/** What a mark says about its turn. A turn without a mark is open. */
export const CHORE_MARK_STATES = ['open', 'done', 'letgo'] as const;
export type ChoreMarkState = (typeof CHORE_MARK_STATES)[number];

/** Chores belong to a person or to both of them (the two ids, sorted), never to a custom list. */
export type ChoreOwners = [PersonId] | [PersonId, PersonId];

export type ChoreCadence =
  | { kind: 'daily' }
  | { kind: 'weekly'; day: ChoreDay; weeks: ChoreWeeks }
  | { kind: 'monthly'; nth: ChoreNth; day: ChoreDay; months: ChoreMonths };

export type ChoreRule = {
  id: string;
  /** 1 to CAPS.choreTitleChars code points. */
  title: string;
  owners: ChoreOwners;
  cadence: ChoreCadence;
  /** Position among the rules: max+1 on create. Groups list their rules in this order. */
  order: number;
  revision: number;
  updatedBy: Person;
  updatedAt: string;
};

/**
 * What happened to one turn of a rule (the turn on `date`). `id` is `${ruleId}:${date}`. `moved` sends an open turn to its
 * catch-up Friday. `owners` overrides the rule's owners for this turn only. A mark that is open, not moved and has no override
 * is not stored. Deleting a rule deletes its marks. Letting go through time (superseded, expired) writes no mark.
 */
export type ChoreMark = {
  id: string;
  ruleId: string;
  date: string;
  state: ChoreMarkState;
  moved: boolean;
  owners?: ChoreOwners;
  revision: number;
  updatedBy: Person;
  updatedAt: string;
};

/** The A/B rhythm: `anchor` is a Monday whose week is Week A; no turn exists before `start`. */
export type Rhythm = { anchor: string; start: string; revision: number; updatedBy: Person; updatedAt: string };

/** What GET and every successful POST return for the signed-in caller. */
export type Snapshot = {
  v: typeof STORE_VERSION;
  /** Global revision, +1 per state-changing write. Clients ignore responses older than what they hold. */
  revision: number;
  /** The two people's lists first (the partner's, then the owner's: PERSON_ROLES), then custom lists by order. */
  lists: ListRecord[];
  settings: Settings;
  tasks: Task[];
  priorities: Priority[];
  events: ScheduleEvent[];
  notes: Note[];
  /** The household's chore rules by order, every mark, and the A/B rhythm. */
  chores: ChoreRule[];
  choreMarks: ChoreMark[];
  rhythm: Rhythm;
  /** The caller's own preferences. Applied at load only, never from a poll. */
  prefs: Prefs;
};
export type Session = Snapshot & { user: Person; csrf: string; timezone: string; /** Which account holds each role, from the server's private config (app/main.ts hands it to setPeople, and the app refuses a session without it). */ people?: People; theme: string; /** Absent from an older server: shown. */ calmind?: 'shown' | 'hidden'; /** This person's own Both color (an account preference); null or absent: the household default `settings.bothColor`. */ bothColor?: ColorKey | null };
/** GET ?since=<revision> when nothing changed. Carries no data, so a client keeps what it has. */
export type SnapshotUnchanged = { unchanged: true; revision: number };

/** The stored plaintext (what Store encrypts). Maps are keyed by id, or by note key. */
export type StoredDb = {
  v: typeof STORE_VERSION;
  revision: number;
  lists: Record<ListId, ListRecord>;
  settings: Settings;
  tasks: Record<string, Task>;
  priorities: Record<string, Priority>;
  events: Record<string, ScheduleEvent>;
  notes: Record<string, Note>;
  chores: Record<string, ChoreRule>;
  choreMarks: Record<string, ChoreMark>;
  rhythm: Rhythm;
  prefs: Partial<Record<Person, Prefs>>;
};

// ---------------------------------------------------------------------------------------------
// API: one endpoint, GET returns the snapshot, POST takes one Mutation and returns the snapshot.
// ---------------------------------------------------------------------------------------------

export type ApiErrorCode =
  | 'invalid' | 'text_too_long' | 'unauthorized' | 'forbidden' | 'csrf' | 'payload_too_large'
  | 'unsupported_media' | 'method_not_allowed' | 'rate_limited'
  | 'stale' | 'gone' | 'id_in_use' | 'limit' | 'slot_taken' | 'overlap' | 'name_taken' | 'store_full'
  | 'unavailable';
export type ApiError = { error: string; code: ApiErrorCode; cap?: CapName };
/** HTTP status for each code. server/tools cases assert this table. */
export const ERROR_STATUS = {
  invalid: 400, text_too_long: 400, unauthorized: 401, forbidden: 403, csrf: 403, payload_too_large: 413,
  unsupported_media: 415, method_not_allowed: 405, rate_limited: 429, stale: 409, gone: 409, id_in_use: 409,
  limit: 409, slot_taken: 409, overlap: 409, name_taken: 409, store_full: 409, unavailable: 503,
} as const satisfies Record<ApiErrorCode, number>;

export type AddTodo = { action: 'add'; kind: 'todo'; id: string; scope: Scope; date: string; owners: Owners; title: string };
export type AddPriority = { action: 'add'; kind: 'priority'; id: string; date: string; owners: Owners; slots: Record<ListId, number>; text: string };
export type AddEvent = { action: 'add'; kind: 'event'; id: string; date: string; owners: Owners; text: string; start: number; length?: number };
/** Edits replace all editable fields. kind, scope, done, pos, createdBy and ak are not editable here. */
export type EditTodo = { action: 'edit'; kind: 'todo'; id: string; revision: number; date: string; owners: Owners; title: string };
export type EditPriority = { action: 'edit'; kind: 'priority'; id: string; revision: number; date: string; owners: Owners; slots: Record<ListId, number>; text: string };
export type EditEvent = { action: 'edit'; kind: 'event'; id: string; revision: number; date: string; owners: Owners; text: string; start: number; length: number };

export type Mutation =
  | AddTodo | AddPriority | AddEvent
  | EditTodo | EditPriority | EditEvent
  /** `doneOn` (checking a day to-do only): the date of the page it was ticked on, its own date or the server's today; left out, it is done on its own date. */
  | { action: 'complete'; id: string; revision: number; done: boolean; doneOn?: string }
  | { action: 'delete'; id: string; revision: number; confirm: true }
  /** Place the to-do before another to-do of the same (scope, date); null means the end. Ignores the viewer's filter. */
  | { action: 'moveTodo'; id: string; revision: number; before: string | null }
  /** One list's priority lines for a day, all or nothing. Only slots[listId] changes on each record. */
  | { action: 'movePriorities'; date: string; listId: ListId; moves: { id: string; revision: number; slot: number }[] }
  /** Schedule entries of one day edited together, all or nothing (a shared boundary dragged between bordering entries); overlaps are judged on the result. One to three edits, no change of day. */
  | { action: 'editEvents'; edits: Omit<EditEvent, 'action' | 'kind'>[] }
  /** revision 0 creates the text. */
  | { action: 'saveNote'; scope: Scope; period: string; listId: ListId; field: NoteField; text: string; revision: number }
  /** revision 0 creates a custom list (name required). Person lists accept color only (name absent or fixed). */
  | { action: 'saveList'; id: ListId; name?: string; color: ColorKey; revision: number }
  | { action: 'deleteList'; id: ListId; revision: number; confirm: true }
  | { action: 'saveSettings'; bothColor: ColorKey; revision: number }
  /** revision 0 creates a chore rule (its order is the server's); an edit replaces title, owners and cadence. */
  | { action: 'saveChore'; id: string; title: string; owners: ChoreOwners; cadence: ChoreCadence; revision: number }
  /** Removes a rule and every mark of it. */
  | { action: 'deleteChore'; id: string; revision: number; confirm: true }
  /** Sets what happened to one turn: revision 0 when it has no stored mark. An open, unmoved turn without an override deletes the mark. */
  | { action: 'markChore'; ruleId: string; date: string; state: ChoreMarkState; moved: boolean; owners?: ChoreOwners; revision: number }
  /** Moves the A/B anchor; it must be a Monday. */
  | { action: 'saveRhythm'; anchor: string; revision: number }
  /** Caller's own preferences. Last write wins, no revision, does not bump the global revision. `sidebar` left out keeps the stored value. */
  | { action: 'savePrefs'; selection: Selection; sidebar?: SidebarState };
export type MutationAction = Mutation['action'];

/**
 * The person's color theme. Not a planner mutation: the store is not touched. api.php answers it with the account
 * library's theme_set(), the prefs file CalMind and the suite read, and replies `{ theme }`. A name that is not one of
 * the suite's themes is 400 `invalid`; a write that fails is 503 `unavailable` and nothing is claimed saved.
 */
export type SetThemeRequest = { action: 'setTheme'; theme: string };
export type SetThemeReply = { theme: string };

/**
 * This person's own color for Both (the owner, 2026-11-09, #138). Not a planner mutation: the store is not touched and its version
 * does not change. api.php keeps it in the account library's prefs file beside the theme (key `planmindBothColor`) and replies
 * `{ bothColor }` only once it reads back. `bothColor: null` clears the pick (back to the household default). A color outside the palette is 400 `invalid`; a failed write is 503 `unavailable`.
 */
export type SetBothColorRequest = { action: 'setBothColor'; bothColor: ColorKey | null };
export type SetBothColorReply = { bothColor: ColorKey | null };

// ---------------------------------------------------------------------------------------------
// View models (pure, computed in packages/core; views only render them)
// ---------------------------------------------------------------------------------------------

/** One column of the Day/Week/Month panels. Lane order: signed-in person, other person, then overlays. */
export type Lane = { listId: ListId; name: string; color: ColorKey; you: boolean };

export type PickerRow = {
  id: ViewBase;
  label: string;
  /** null for Both, which is drawn with its own color from settings by the UI. */
  color: ColorKey | null;
  kind: 'both' | 'person' | 'custom';
  /** This row is the base (the "selected alone" row). */
  selected: boolean;
  /**
   * The list is a lane on screen: the base, an overlay, or the two people's lists while the base is Both. The Both row is
   * checked only while Both is the base. Only custom rows show a box (`canCheck`).
   */
  checked: boolean;
  canCheck: boolean;
  /** Unchecked and the overlay limit is reached. */
  checkDisabled: boolean;
};

/** A priority cell: lane index into the lanes, span 2 only for a linked item on the same line in both lanes. */
export type PriorityCell = { item: Priority; lane: number; span: 1 | 2; line: number; color: ColorKey; linked: boolean };
export type PriorityRow = { line: number; cells: PriorityCell[] };
export type EventCell = { item: ScheduleEvent; lane: number; span: 1 | 2; start: number; end: number; color: ColorKey; linked: boolean };
/**
 * `carried`: a to-do of an earlier day that a Day view lists as well; its real record is untouched, its own date is `item.date`. Open, it is
 * the R10 row on today's list; done, it is the row that was ticked on the viewed day (`Task.doneOn`), in that day's done pile.
 * `wentTo`: the viewed day is the to-do's own and it was done on a later day: the row shows unchecked (it is in the open rows, and a view
 * only: the record is done) with a chip pointing at that day, and its circle does nothing.
 */
export type TodoRow = { item: Task; color: ColorKey; linked: boolean; carried?: true; wentTo?: string };
export type NoteLane = { lane: Lane; key: string; note: Note | null; /** 0 when not yet saved */ revision: number };
export type Counter = { used: number; max: number; over: boolean };
export type ListCaps = { todosOpen: Counter };
/** Who a new item belongs to and the color it takes. */
export type NewOwners = { owners: Owners; color: ColorKey };
/**
 * What a pointer on a blank line (a to-do slot) would make. `side` is the third it is in when the Both view cuts the line in thirds
 * (`left` the left lane's, `both` one linked item, `right` the right lane's); `only` where there are no thirds (one list shown, or more
 * lanes than the two people) and the line is for whoever the top picker says.
 */
export type BlankAim = NewOwners & { side: 'left' | 'both' | 'right' | 'only' };

export type ViewData = Pick<Snapshot, 'lists' | 'settings' | 'tasks' | 'priorities' | 'events' | 'notes'>;
/**
 * `today` is the viewer's today (the session timezone's date; core has no clock). With it, the Day view of that very date also lists
 * the open day to-dos of earlier days (see `dayView`); without it nothing is carried. Week, Month and the sidebar ignore it.
 */
export type ViewInput = { data: ViewData; selection: Selection; me: Person; today?: string };

export type DayView = {
  date: string;
  lanes: Lane[];
  schedule: EventCell[];
  /** Always CAPS.prioritySlots rows, line 1..5. */
  priorities: PriorityRow[];
  todosOpen: TodoRow[];
  todosDone: TodoRow[];
  notes: NoteLane[];
  /** Per lane list, for the live "2 of 13" counter. */
  caps: Record<ListId, ListCaps>;
};
export type WeekView = {
  monday: string;
  lanes: Lane[];
  priorities: NoteLane[];
  todosOpen: TodoRow[];
  todosDone: TodoRow[];
};
/** A day of the month grid. What is planned on it is not drawn there: the Month's days carry the chores (chores.ts `monthChoreCells`). */
export type MonthCell = { date: string; inMonth: boolean };
export type MonthView = {
  first: string;
  lanes: Lane[];
  /** 42 cells, Monday first, starting on the Monday on or before the 1st. */
  grid: MonthCell[];
  priorities: NoteLane[];
  notes: NoteLane[];
  todosOpen: TodoRow[];
  todosDone: TodoRow[];
};

/** Which edge of an event the start/end handle moves. */
export type HandleEdge = 'start' | 'end';
/** A resize of one entry, and the new spans of the entries whose bordering edge moved with it (empty when the edge borders nothing). */
export type BoundaryResize = { start: number; length: number; linked: { id: string; start: number; length: number }[] };
/** The answer of stepEvent: the new start, or why the event cannot move that way. */
export type StepResult = { ok: true; start: number } | { ok: false; reason: 'window' } | { ok: false; reason: 'overlap'; with: ScheduleEvent };

// ---------------------------------------------------------------------------------------------
// Signatures of the pure helpers (types only). Implementations live in packages/core/src.
// Implementers write e.g. `export const resolveLanes: CoreFunctions['resolveLanes'] = ...`.
// ---------------------------------------------------------------------------------------------

export interface CoreFunctions {
  // owners, selection, lanes, picker  (selection.ts)
  /**
   * Sorted; null unless it is one list or exactly the two people's ids (so a duplicate of one id twice is null).
   * Shape only: it does not check that a list exists or reject the view names 'both' and 'all'. The PHP
   * canonical_owners answers the same vectors (selection.test.ts and server/tools/cases/store.php).
   */
  canonicalOwners(owners: readonly ListId[]): Owners | null;
  /** Drops unknown/duplicate overlays and overlays equal to the base; unknown base falls back to 'both'. */
  resolveSelection(sel: Selection | null | undefined, lists: readonly ListRecord[]): Selection;
  /** Tap a row: that row alone, overlays cleared. */
  selectOnly(id: ViewBase): Selection;
  /**
   * Tick a custom list's box. Not ticked: add as overlay (base unchanged). Ticked overlay: remove.
   * Ticked base: base falls back to 'both', overlays kept. Over the limit: unchanged and rejected.
   * Person lists and Both never toggle.
   */
  toggleOverlay(sel: Selection, id: ListId, lists: readonly ListRecord[]): { selection: Selection; rejected?: 'overlay_limit' };
  pickerRows(lists: readonly ListRecord[], sel: Selection): PickerRow[];
  /**
   * Colors for the round button glyph (one color, or a pie): the base first, then the overlays by list order.
   * The base is `settings.bothColor` under Both (Both is one thing with its own color, not a pie of the two people's colors),
   * otherwise that list's color. As CalMind's PieDot: viewing one thing shows its color, several show a pie.
   */
  pickerColors(sel: Selection, lists: readonly ListRecord[], settings: Settings): ColorKey[];
  /** both -> [me, other]; otherwise [base]; then overlays by list order. */
  resolveLanes(sel: Selection, lists: readonly ListRecord[], me: Person): Lane[];
  /**
   * Who a NEW item belongs to, from the top selection alone (there is no For control): the base list, or, when the base is
   * Both, the one linked record owned by the two people. Overlays never decide. `lane` is a list the person tapped (a
   * schedule slot, a priority cell): that list, whatever the base; an id that is not a list is ignored. A base that is
   * not a list reads as Both (resolveSelection). Editing never calls this: an item keeps its owners.
   */
  newOwners(sel: Selection, lists: readonly ListRecord[], settings: Settings, lane?: ListId): NewOwners;
  /**
   * Whether a blank to-do line is cut in thirds: exactly the two people's lanes shown, from the Both view (newOwners reads as both).
   * With one list, a custom list and its overlay, or Both with an overlay (three lanes) a line is not cut.
   */
  blankThirds(sel: Selection, lists: readonly ListRecord[], settings: Settings, lanes: readonly Lane[]): boolean;
  /**
   * Whom a pointer `across` a blank to-do line (0 at its left edge, 1 at its right) makes a to-do for, the one decision the click and the
   * hover ghost both ask. With thirds: the left third is the left lane (the signed-in person), the middle third one linked to-do for both
   * (settings.bothColor), the right third the right lane; `both` forces the middle (Shift on a click, the hidden button). Without thirds
   * it is newOwners alone, whatever `across` is.
   */
  blankAim(sel: Selection, lists: readonly ListRecord[], settings: Settings, lanes: readonly Lane[], across: number, both?: boolean): BlankAim;
  /**
   * What deleting a custom list takes with it, as the server does it: the to-dos, priorities and events it owns alone
   * (linked items belong to the two people and stay) and its notes that hold text. The server removes every note of the list.
   */
  listDeleteImpact(data: Pick<ViewData, 'tasks' | 'priorities' | 'events' | 'notes'>, listId: ListId): { items: number; notes: number };

  // colors  (colors.ts)
  itemColor(owners: Owners, lists: readonly ListRecord[], settings: Settings): ColorKey;
  /** The settings this person's views read: `bothColor` is their own pick when they made one and it is in the palette, else the household default. */
  personalSettings(settings: Settings, mine: ColorKey | null | undefined): Settings;
  nextCustomColor(lists: readonly ListRecord[]): ColorKey;
  /** bg/fg/line for one hue on one theme's surface and text colors (hex in, css color strings out). */
  tint(hue: string, surface: string, text: string): { bg: string; fg: string; line: string };
  contrastRatio(fg: string, bg: string): number;

  // views  (views.ts)
  /**
   * With `input.today === date` the open list also holds the OPEN day to-dos dated before today (oldest day first, in their own
   * order), then today's own: a view only, nothing is written, they stay on their own day too. Done to-dos, week and month to-dos,
   * lists that are not lanes, any other date and any date after today never carry. A linked to-do is one row.
   * A to-do ticked on a later day than its own (`doneOn`) is a done row of that day (with `carried`) and an unchecked row of its own
   * day (`wentTo`), whatever `today` is.
   */
  dayView(input: ViewInput, date: string): DayView;
  weekView(input: ViewInput, monday: string): WeekView;
  monthView(input: ViewInput, first: string): MonthView;
  /**
   * The dates a month calendar shows, Monday first, with the days of the months on either side: `rows` weeks of 7, or
   * (omitted) as many as the month needs, 5 or 6. monthView's grid is monthGrid(first, 6).
   */
  monthGrid(first: string, rows?: 5 | 6): { date: string; inMonth: boolean }[];

  // placement  (placement.ts)
  /** The to-dos of the period in the lanes, open rows first. A day to-do done on a later day than its own is an open row here (`wentTo`), after the real open ones. */
  visibleTodos(tasks: readonly Task[], scope: Scope, date: string, lanes: readonly Lane[], lists: readonly ListRecord[], settings: Settings): TodoRow[];
  /** The rows `dayView` adds ahead of `date`'s own open to-dos when `date` is `today`: open day to-dos of earlier days in the lanes, oldest day first; else none. */
  carriedTodos(tasks: readonly Task[], date: string, today: string | undefined, lanes: readonly Lane[], lists: readonly ListRecord[], settings: Settings): TodoRow[];
  /** The rows a Day view adds to its done pile: day to-dos of earlier days that were ticked on `date` (`doneOn`), oldest day first, each with `carried`. */
  accomplishedTodos(tasks: readonly Task[], date: string, lanes: readonly Lane[], lists: readonly ListRecord[], settings: Settings): TodoRow[];
  priorityCells(items: readonly Priority[], date: string, lanes: readonly Lane[], lists: readonly ListRecord[], settings: Settings): PriorityCell[];
  eventCells(items: readonly ScheduleEvent[], date: string, lanes: readonly Lane[], lists: readonly ListRecord[], settings: Settings): EventCell[];
  noteLanes(notes: readonly Note[], scope: Scope, period: string, field: NoteField, lanes: readonly Lane[]): NoteLane[];

  // priorities  (priorities.ts)
  /** Lowest line free for every owner, else each owner's own lowest free line; null when any owner has all 5 used. */
  suggestSlots(items: readonly Priority[], date: string, owners: Owners): Record<ListId, number> | null;
  /**
   * Where a priority goes when it is added or who it is for changes: line `prefer` when it is free in every owner's list on
   * that day, otherwise suggestSlots. Null when an owner has all five lines taken. `selfId` leaves the record being edited
   * out of the count.
   */
  pickSlots(items: readonly Priority[], date: string, owners: readonly ListId[], selfId: string | null, prefer: number): Record<ListId, number> | null;
  /** Insert-move of one record within one list's five lines (array move, others shift by one). At most 5 moves. */
  arrangePriorities(items: readonly Priority[], date: string, listId: ListId, id: string, toLine: number): { id: string; revision: number; slot: number }[];

  // schedule  (schedule.ts)
  snapQuarter(minutes: number): number;
  /** Clamp into the window and to the minimum length, on the 15-minute grid. An omitted length is CAPS.eventDefaultLength. */
  clampEvent(start: number, length?: number): { start: number; length: number };
  /** The event overlapping the proposed span in any shared owner's lane (half-open: touching is fine), or null. */
  findEventOverlap(events: readonly ScheduleEvent[], date: string, owners: Owners, start: number, length: number, ignoreId?: string): ScheduleEvent | null;
  /** Nearest free quarter-hour start for a drag, or null when the day has no room. */
  freeStartNear(events: readonly ScheduleEvent[], date: string, owners: Owners, start: number, length: number, ignoreId?: string): number | null;
  /** Where a new entry goes when no place is asked for (the Add button): the nearest free start to `start` for the default half hour; null when the day has no room. */
  freeSpanNear(events: readonly ScheduleEvent[], date: string, owners: Owners, start: number): { start: number; length: number } | null;
  /**
   * Where a new entry goes for a pointer at `pointer`: in the free stretch around it, the default half
   * hour, starting at the pointer's half hour or the closest start inside that stretch. A shorter gap has no landing.
   * When the pointer is on an occupied time, use freeSpanNear. Callers wall
   * off what is not to be used (the half of the day not shown) with events of their own. Null when nothing is free.
   */
  fitNewEntry(events: readonly ScheduleEvent[], date: string, owners: Owners, pointer: number): { start: number; length: number } | null;
  /**
   * Move one handle to a target minute (snapped). The other edge stays; the result is clamped to the
   * window, the minimum length and the neighbouring events (a handle stops at a neighbour, never overlaps).
   */
  resizeEvent(events: readonly ScheduleEvent[], event: ScheduleEvent, edge: HandleEdge, targetMinute: number): { start: number; length: number };
  /**
   * Like resizeEvent, but an edge that borders other entries (this one's end is their start, or their end is this one's start) in a lane
   * this one occupies is a shared boundary: those entries' edges move with it, the other edges of all of them stay, and none gets shorter
   * than the minimum. The bordering entries still stop at their own other neighbours (a lane of theirs this one is not in). `event` is
   * the span when the drag began, `events` the day as it was then (it may hold `event` itself, which is ignored).
   */
  resizeBoundary(events: readonly ScheduleEvent[], event: ScheduleEvent, edge: HandleEdge, targetMinute: number): BoundaryResize;
  /**
   * The start minute for a tap `fraction` (0 at the top, 1 at the bottom) of the hour row `hour` (0 is the 7a row):
   * the quarter hour the tap is in. Callers use fitNewEntry for the half-hour placement and minimum.
   */
  slotStart(hour: number, fraction: number): number;
  /**
   * Where a dragged event lands: the target start (any minute) snapped to the grid and kept inside the window, then the
   * nearest free quarter-hour for its length in every lane it occupies. Its own old place counts as free. null only when
   * the day has no room for it. The lanes are the event's own unless `owners` names others (a drag across one person / Both / the other,
   * moveAim): then the start is free in all of those lanes (a linked entry needs both), and null when no start is.
   */
  moveEvent(events: readonly ScheduleEvent[], event: ScheduleEvent, targetStart: number, owners?: Owners): number | null;
  /**
   * Whom a dragged entry is for when the pointer (or the entry's centre, carried by the pointer) is `across` the width of the schedule
   * (0 at its left edge, 1 at its right): in the Both view with exactly the two people's lanes the thirds of blankAim (left third the
   * left lane's person, middle both, right the right lane's). In any other view (`side` is `only`) it is `owners`, the entry's own,
   * with their color: a drag never changes who an entry is for there.
   */
  moveAim(sel: Selection, lists: readonly ListRecord[], settings: Settings, lanes: readonly Lane[], owners: Owners, across: number): BlankAim;
  /**
   * The keyboard's move across the thirds: one third left (-1) or right (1) from the entry's owners (owner -> Both -> partner when the owner is
   * the left lane). Null where the view has no thirds, at the end of them, or when the owners are not one of the three.
   */
  stepAim(sel: Selection, lists: readonly ListRecord[], settings: Settings, lanes: readonly Lane[], owners: Owners, direction: -1 | 1): BlankAim | null;
  /**
   * A keyboard move of one 15-minute step (-1 earlier, 1 later). Unlike moveEvent it never jumps over a neighbour:
   * blocked by the edge of the window or by an event in one of its lanes, it says which.
   */
  stepEvent(events: readonly ScheduleEvent[], event: ScheduleEvent, direction: -1 | 1): StepResult;
  /** "9:15a" style label for a minute count. */
  timeLabel(minutes: number): string;

  // limits and counters  (limits.ts)
  /** Character limit for an entry, depending on kind, scope and whether it is linked (two owners). */
  textLimit(kind: ItemKind | 'note', scope: Scope, linked: boolean): number;
  /**
   * Code-point counter for the live "14 / 18" display; over blocks Save. CRLF and CR count as one line break; the
   * text is not trimmed. The server trims single-line text before counting, so callers pass the trimmed value for
   * titles, event text and priority text, and the raw value for notes.
   */
  counter(text: string, max: number): Counter;
  /**
   * Open day to-dos of a list vs CAPS.dayTodosPerList (a linked to-do counts for both owners). Here over means
   * "no room for one more" (used >= max, the point where the server answers limit), unlike counter() where over is used > max.
   * On `today` the list also counts the open to-dos of earlier days that the Day view carries over (R10); the server counts them
   * the same way for an add, a reopen or a date edit that lands on its today.
   */
  todoCounter(tasks: readonly Task[], date: string, listId: ListId, excludeId?: string, today?: string): Counter;
  /**
   * The Day To-do list is `dayTodosPerList` ruled slots: open rows fill them top-down (`filled`), the rows past the last slot wait
   * behind "+N more" (`more`), the done rows are stacked at the bottom of the same list (`done`, in the order given; they take the last
   * lines, never count against the cap of open rows and are never hidden), and what is left between the two is blank lines (`empty`: the
   * slots minus the open rows shown and the done rows, 0 once they are full). A `wentTo` row (a to-do done on another day) is in `open`
   * but is neither counted against the slots nor ever put behind "+N more": it is always in `filled`, after the real open rows.
   */
  todoSlots(open: readonly TodoRow[], done?: readonly TodoRow[]): { filled: TodoRow[]; more: TodoRow[]; done: TodoRow[]; empty: number };
  /**
   * The blank lines of a Week or Month to-do list drawn on at least `min` ruled lines: `min` less the open and the done rows (the done
   * rows are the last lines of the page, the blank ones sit between them and the open rows), and never fewer than one (the add line),
   * so the list simply grows past `min` rows.
   */
  periodBlankLines(min: number, open: number, done: number): number;
  /**
   * The first owner whose list a to-do edit would overflow, or undefined when the edit is fine. The cap blocks only a to-do
   * that is newly counted in a list on a day: a finished to-do is not counted, and an owner whose list and day are
   * unchanged already has it counted (on `today` that includes an open to-do of an earlier day, which is carried there).
   * (The server decides in the end; this is the instant answer in the editor.)
   */
  fullOwnerOnEdit(tasks: readonly Task[], task: Task, date: string, owners: readonly ListId[], today?: string): ListId | undefined;
  /** Characters of a lane cell on the phone: floor(36 / lanes); a span-2 cell gets twice that. For ellipsis decisions only. */
  laneChars(laneCount: number, span: 1 | 2): number;
}

/** Period helpers that stay in packages/core/src/planner.ts, unchanged. Listed so views know they exist. */
export interface DateFunctions {
  dateWindow(center: string, radius?: number): string[];
  periodStart(date: string, view: View): string;
  shiftPeriod(date: string, amount: number, view: View): string;
  periodWindow(center: string, view: View): string[];
  weekLabel(monday: string): string;
  dayLabel(date: string, options: Intl.DateTimeFormatOptions): string;
  todayIn(timeZone: string, now?: Date): string;
}
