import { ROLE_LABELS, displayName, type Screen, type Session } from '../../packages/core/src/taskmind';
import { setTheme } from '../colors';

/** One element with text set as text, never as markup: names and usernames are untrusted. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/** The suite-style monogram: TM in one stroke. The same drawing as server/public/TaskMind/icon.svg. */
function mark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 96 96'); svg.setAttribute('class', 'brand-mark'); svg.setAttribute('aria-hidden', 'true');
  const tile = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  tile.setAttribute('width', '96'); tile.setAttribute('height', '96'); tile.setAttribute('rx', '20'); tile.setAttribute('fill', '#111111');
  const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  stroke.setAttribute('d', 'M 12 28 L 44 28 M 28 28 L 28 70 M 54 70 L 54 28 L 68 52 L 82 28 L 82 70');
  for (const [name, value] of Object.entries({ fill: 'none', stroke: '#a78bfa', 'stroke-width': '9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) stroke.setAttribute(name, value);
  svg.append(tile, stroke);
  return svg;
}

function card(root: HTMLElement, title: string, ...lines: HTMLElement[]) {
  const section = h('section', 'card');
  section.setAttribute('aria-labelledby', 'screen-title');
  const heading = h('h1', '', title);
  heading.id = 'screen-title';
  section.append(mark(), heading, ...lines);
  const main = h('main', 'stage');
  main.append(section);
  root.replaceChildren(main);
}

function link(text: string): HTMLAnchorElement {
  const a = h('a', 'primary', text);
  a.href = './';
  return a;
}

/** Signed in as a team member. The workspace views mount here once the data store exists; until then the page says who is in. */
export function renderSession(root: HTMLElement, session: Session) {
  setTheme(session.theme);
  document.title = 'TaskMind';
  const who = h('p', 'who');
  who.append('Signed in as ', h('strong', '', displayName(session.name, session.me)), ' ');
  who.append(h('span', 'role', ROLE_LABELS[session.role]));
  card(root, 'TaskMind', who, h('p', 'dim', 'Projects, tasks and the board open here when the team workspace arrives.'), signOut(session.csrf));
}

/**
 * Where Sign out posts, and what. Under the suite's shared sign-in the page (server/public/TaskMind/index.php) names the account
 * page on #app (data-signout-action, data-signout-next): the form posts there, with the sign-in to return to. Without the
 * attributes it posts to this page, as it always did.
 */
export function signOutPlan(csrf: string, at: { signoutAction?: string; signoutNext?: string } | undefined): { action: string; fields: [string, string][] } {
  const fields: [string, string][] = [['csrf', csrf], ['action', 'logout']];
  if (!at?.signoutAction) return { action: './', fields };
  if (at.signoutNext) fields.push(['next', at.signoutNext]);
  return { action: at.signoutAction, fields };
}

/** Signing out is a real form post (index.php, or the account page, ends the session and answers 303): no script is involved. */
function signOut(csrf: string): HTMLFormElement {
  const plan = signOutPlan(csrf, document.getElementById('app')?.dataset);
  const form = h('form', 'sign-out');
  form.method = 'post'; form.action = plan.action;
  for (const [name, value] of plan.fields) {
    const input = h('input', ''); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
  }
  const button = h('button', 'quiet', 'Sign out'); button.type = 'submit';
  form.append(button);
  return form;
}

/** What the page shows instead of the app. Private content is never in the DOM when one of these is. */
export function renderScreen(root: HTMLElement, screen: Exclude<Screen, 'signedIn'>) {
  document.body.classList.remove('drawer-open');
  if (screen === 'signedOut') { card(root, 'Sign in again', h('p', 'dim', 'Your session has ended.'), link('Sign in')); return; }
  if (screen === 'denied') { card(root, 'Members only', h('p', 'dim', 'TaskMind is for members of its team. Sign in as a member.'), link('Back to sign-in')); return; }
  card(root, 'Unable to open TaskMind', h('p', 'dim', 'Your saved work is preserved. Reconnect and try again.'), link('Try again'));
}
