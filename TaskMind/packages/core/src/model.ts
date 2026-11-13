/**
 * TaskMind shared contract: roles, the permission matrix, record shapes, caps, API shapes and the signatures of the pure
 * helpers that packages/core implements. Types and constants only; no behavior, no imports, no DOM.
 *
 * Rules for this file
 * - It ports the interim page's contract (seancheren-site docs/TASKMIND.md and docs/TASKMIND-TEAM.md, lib/taskmind.php TM_*);
 *   change it deliberately, and change the PHP that mirrors it in the same commit.
 * - Keep it erasable TypeScript (no enum, namespace or parameter properties): tools/gen-limits.mjs imports it directly
 *   under Node type stripping to generate server/lib/limits.php from CAPS, MATRIX and the other shared constants.
 * - PHP in server/lib mirrors the JSON shapes below exactly. CAPS and MATRIX are the single source for both.
 * - Nothing here is exported from another file yet; implementers re-export what they need from packages/core/src/taskmind.ts.
 */

// ---------------------------------------------------------------------------------------------
// Identity and roles
// ---------------------------------------------------------------------------------------------

/** A member id is a site account username (the seancheren.com accounts); this is its shape, shared by the server's regex. */
export const ID_PATTERN = '[A-Za-z0-9_-]{1,40}';
export const ID_RE = new RegExp(`^${ID_PATTERN}$`);

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** A project is open to the whole team, or private to its owner, its members and the owners and admins. */
export const VISIBILITIES = ['team', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<Visibility, string> = { team: 'Team', private: 'Private' };

/** Storage format version inside the encrypted plaintext of the workspace file. Anything else fails closed. */
export const STORE_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// The permission matrix: one row per action, the roles that may do it. A row that needs a project or a target is narrowed
// further by access.ts (and by the server, which is the authority; a hidden button is not authorization).
// ---------------------------------------------------------------------------------------------

export const MATRIX = {
  'open': ['owner', 'admin', 'member', 'viewer'],
  'project.read': ['owner', 'admin', 'member', 'viewer'],
  'task.write': ['owner', 'admin', 'member'],
  'task.comment': ['owner', 'admin', 'member', 'viewer'],
  'project.create': ['owner', 'admin', 'member'],
  'section.write': ['owner', 'admin', 'member'],
  'template.write': ['owner', 'admin', 'member'],
  // A plain member only on a project they own.
  'project.update': ['owner', 'admin', 'member'],
  'rules.write': ['owner', 'admin'],
  'member.add': ['owner', 'admin'],
  'member.role': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
  'team.update': ['owner', 'admin'],
  'project.delete': ['owner'],
  'ownership.transfer': ['owner'],
} as const satisfies Record<string, readonly Role[]>;
export type Action = keyof typeof MATRIX;
/** The actions whose answer depends on the project they touch. */
export const PROJECT_ACTIONS: readonly Action[] = ['project.read', 'task.write', 'task.comment', 'section.write', 'project.update', 'project.delete'];

// ---------------------------------------------------------------------------------------------
// Words: statuses, priorities, kinds, health
// ---------------------------------------------------------------------------------------------

export const STATUSES = ['todo', 'doing', 'review', 'done'] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<Status, string> = { todo: 'To do', doing: 'In Progress', review: 'On Hold', done: 'Done' };

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

export const KINDS = ['task', 'bug', 'pr'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABELS: Record<Kind, string> = { task: 'Task', bug: 'Bug', pr: 'Pull request' };

export const HEALTH = ['on_track', 'at_risk', 'off_track', 'paused'] as const;
export type Health = (typeof HEALTH)[number];
export const HEALTH_LABELS: Record<Health, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', paused: 'Paused' };

/** What a synced task came from: a ticket on the owner's board or a GitHub pull request. Its title, notes, status, kind and priority belong to the source. */
export const SOURCE_TYPES = ['ticket', 'pr'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
/** Recurrence rules a task may carry (the recurring-tasks feature owns the behavior). */
export const REPEAT_FREQS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'] as const;

/** The routes the page answers: hash routes, so a reload and Back work. */
export const ROUTES = ['home', 'me', 'all', 'project', 'task'] as const;
export type RouteName = (typeof ROUTES)[number];
export const PROJECT_TABS = ['overview', 'list', 'board'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

// ---------------------------------------------------------------------------------------------
// Caps. Enforced by the server for every client; the UI only shows live counters.
// Text lengths are Unicode code points ([...s].length in TS, mb_strlen in PHP), never bytes.
// ---------------------------------------------------------------------------------------------

export const CAPS = {
  /** Task text. */
  titleChars: 200,
  notesChars: 5000,
  commentChars: 2000,
  commentsPerTask: 200,
  labelChars: 24,
  labelsPerTask: 5,
  /** Names and one-liners. */
  memberNameChars: 60,
  teamNameChars: 60,
  projectNameChars: 80,
  sectionNameChars: 60,
  sectionsPerProject: 30,
  blurbChars: 200,
  aboutChars: 1000,
  goalChars: 200,
  repoChars: 120,
  updateTextChars: 1000,
  /** How many of each the workspace holds. */
  projectsMax: 200,
  tasksMax: 3000,
  membersMax: 200,
  /** Feeds: kept in the file, and sent to each viewer. */
  activityMax: 200,
  eventsMax: 500,
  tombsMax: 500,
  updatesMax: 100,
  stateActivity: 60,
  stateEvents: 100,
  activityTextChars: 240,
  /** Recent add receipts. An older request must refresh instead of being applied twice. */
  replaysMax: 1000,
  /** One rule or template kept raw in the file, in bytes. */
  itemBytesMax: 20000,
  /** Per member: saved views and preferences. */
  meViewsMax: 50,
  mePrefsMax: 40,
  /** The workspace file, and one API request body, in bytes. */
  workspaceBytesMax: 8388608,
  requestBytesMax: 65536,
} as const;
export type CapName = keyof typeof CAPS;

// ---------------------------------------------------------------------------------------------
// Records (the interim page's contract, docs/TASKMIND.md). Timestamps are unix seconds; a due date is a calendar date
// 'YYYY-MM-DD' with no zone, or ''. PHP sends an empty object as [], so read `source`, `facts` and `origin` by property.
// ---------------------------------------------------------------------------------------------

export interface Member { id: string; role: Role; name: string; added: number; by: string }
export interface Comment { id: string; by: string; at: number; text: string }
export interface TaskSource { type: SourceType; n: number; ref: string; url: string }
export interface Repeat { freq: (typeof REPEAT_FREQS)[number]; every: number; until?: string; from: 'due' | 'done' }

export interface Task {
  id: string; n: number; project: string;
  /** Another task's id: a subtask, one level deep, same project. */
  parent: string;
  title: string; notes: string; status: Status; assignee: string; priority: Priority; kind: Kind; due: string; labels: string[];
  order: number; by: string; created: number; updated: number; done_at: number;
  source: TaskSource | Record<string, never>;
  comments: Comment[];
  start: string; depends: string[]; estimate: number; section: string; repeat: Repeat | null; followers: string[]; origin: { template?: string };
  /** The workspace revision at this task's last change (deltas use it). */
  rv: number;
}

export interface Section { id: string; name: string; order: number }
export interface ProjectUpdate { id: string; by: string; at: number; health: Health; text: string }

export interface Project {
  id: string; name: string; color: string; repo: string;
  /** The repo is private. A different field from `visibility`. */
  private: boolean;
  blurb: string; about: string; health: Health; owner: string; archived: boolean; order: number; created: number;
  facts: Record<string, unknown>;
  visibility: Visibility; members: string[]; lead: string; goal: string; start: string; due: string;
  sections: Section[]; updates: ProjectUpdate[];
  rv: number;
  /** What the viewer may do on this project. */
  can: { write: boolean; comment: boolean; settings: boolean; delete: boolean };
}

// ---------------------------------------------------------------------------------------------
// The API. api.php answers every request with JSON, never cached, and names the release that answered in X-TaskMind-Release.
// ---------------------------------------------------------------------------------------------

/** What the default GET answers a signed-in team member. */
export interface Session { ok: true; me: string; role: Role; name: string; csrf: string; theme: string }

export interface Activity { at: number; by: string; text: string; task: string; project: string }
export interface WorkspaceEvent extends Activity { n: number; type: 'task.assigned' | 'comment.added' | 'member.added' | 'member.role'; to: string[] }
export interface WorkspaceMember extends Member { rv: number }
export interface Team { name: string; rv: number }

/** Small live values and bounded feeds are replaced whole when a delta changes. */
export interface WorkspaceLive {
  can: Record<Action, boolean>;
  members: WorkspaceMember[];
  team: Team;
  activity: Activity[];
  events: WorkspaceEvent[];
}
export interface WorkspaceState extends WorkspaceLive { rev: number; me: string; projects: Project[]; tasks: Task[] }
export type WorkspaceDelta =
  | { me: string; since: number; rev: number; changed: false }
  | { me: string; since: number; rev: number; changed: true; full: true; state: WorkspaceState }
  | ({ me: string; since: number; rev: number; changed: true; full: false; projects: Project[]; tasks: Task[];
       deleted: { projects: string[]; tasks: string[] } } & WorkspaceLive);

export type WorkspaceRead = { ok: true; state: WorkspaceState } | { ok: true; delta: WorkspaceDelta };
export type WorkspaceWrite = ({ id: string } & WorkspaceRead) | { ok: true; id: string; closed: true };

type ProjectFields = Partial<Pick<Project, 'name' | 'color' | 'repo' | 'private' | 'blurb' | 'about' | 'health' |
  'archived' | 'visibility' | 'members' | 'lead' | 'goal' | 'start' | 'due'>>;
type TaskFields = Partial<Pick<Task, 'title' | 'notes' | 'status' | 'assignee' | 'priority' | 'due' | 'labels' | 'start' | 'section'>> & { kind?: 'task' | 'bug' };
type Edit = { id: string; rv: number };
type ConfirmedEdit = Edit & { confirm: true };

export interface WorkspaceOperations {
  'project.add': ProjectFields & { name: string };
  'project.update': Edit & ProjectFields & { owner?: string };
  'project.delete': ConfirmedEdit;
  'task.add': TaskFields & { project?: string; parent?: string; title: string };
  'task.update': Edit & { fields: TaskFields & { project?: string } };
  'task.move': Edit & { status?: Status; section?: string; before?: string };
  'task.delete': ConfirmedEdit;
  'task.comment': { id: string; text: string };
  'member.add': { id: string; role?: Role; name?: string };
  'member.role': Edit & { role: Role };
  'member.remove': ConfirmedEdit;
  'team.update': { name: string; rv: number };
}
export const REPLAYABLE_OPS = ['project.add', 'task.add', 'task.comment', 'member.add'] as const satisfies readonly (keyof WorkspaceOperations)[];
/** Retry an add with its original requestId, base and data. base is the revision observed before the original attempt. */
export type WorkspaceMutation = {
  [K in keyof WorkspaceOperations]: { op: K; data: WorkspaceOperations[K]; since?: number } &
    (K extends (typeof REPLAYABLE_OPS)[number] ? { requestId: string; base: number } : { requestId?: never; base?: never })
}[keyof WorkspaceOperations];

export type ApiErrorCode =
  | 'invalid' | 'unauthorized' | 'forbidden' | 'csrf' | 'payload_too_large' | 'unsupported_media' | 'method_not_allowed'
  | 'rate_limited' | 'stale' | 'store_full' | 'unavailable';
export type ApiError = { error: string; code: ApiErrorCode; cap?: CapName };

/** The HTTP status of every error code. The server's RequestError refuses a pair that disagrees with this table. */
export const ERROR_STATUS = {
  invalid: 400, unauthorized: 401, forbidden: 403, csrf: 403, method_not_allowed: 405, stale: 409, store_full: 409,
  payload_too_large: 413, unsupported_media: 415, rate_limited: 429, unavailable: 503,
} as const satisfies Record<ApiErrorCode, number>;

/** The header api.php stamps on every response with the name of the release that answered ("20261102093000-4"). */
export const RELEASE_HEADER = 'X-TaskMind-Release';

// ---------------------------------------------------------------------------------------------
// The pure helpers packages/core implements. Implementers write e.g. `export const can: CoreFunctions['can'] = ...`.
// ---------------------------------------------------------------------------------------------

/** What the shell shows for the answer to its first GET. */
export type Screen = 'signedIn' | 'signedOut' | 'denied' | 'offline';
/** What the shell was told: an HTTP status and the parsed JSON body (null when the body could not be read). */
export type Reply = { status: number; body: unknown } | null;

export interface CoreFunctions {
  /** The roles that may do an action, whatever it touches. */
  roleCan(role: Role | '', action: Action): boolean;
  /** May a viewer with this role see a project? A team project: every member; a private one: owners, admins, its owner and its members. */
  sees(role: Role | '', user: string, project: Pick<Project, 'visibility' | 'owner' | 'members'>): boolean;
  /** May `user` do `action`? `ctx` names what it touches (see access.ts). Not on the team, an unknown action, a hidden project: no. */
  can(members: readonly Member[], user: string, action: Action, ctx?: AccessContext): boolean;
  /** Which screen the first GET's answer leads to. */
  screenFor(reply: Reply): Screen;
}

/** What an action touches: a project (a record), or for member rows the target's id and the role being given. */
export interface AccessContext { project?: Pick<Project, 'visibility' | 'owner' | 'members'>; target?: string; role?: Role }
