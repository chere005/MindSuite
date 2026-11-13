import '../styles/account.css';
import { esc, icons, type PanelContext } from '../panelContext';
import { openSettings } from './Settings';

/**
 * The account: one button (a dot in the list's color, the name, a chevron) that opens a small menu with Settings and Sign out,
 * the suite's username dropdown (seancheren-site lib/chrome.php) drawn with PlanMind's own markup. It sits in the desktop
 * top bar and, on a phone, in the drawer's account row, so Settings is reachable on both. Each copy has its own `where`
 * (it makes the ids unique). Sign out stays a real CSRF form.
 */
export const accountWho = (ctx: PanelContext) => `<span class="account-who" data-c="${ctx.lists.find(l => l.id === ctx.me)?.color ?? 'gray'}"><i class="owner-dot" aria-hidden="true"></i><span class="account-name">${esc(ctx.lists.find(l => l.id === ctx.me)?.name ?? ctx.me)}</span></span>`;

/**
 * Under the suite's shared sign-in the page (server/public/PlanMind/index.php) names the account page on #app: Sign out posts there, and the
 * account page then sends the browser to the sign-in it asks for. Without it the form posts to this page, as it always did.
 */
const signOutAt = () => { const at = document.getElementById('app')?.dataset; return at?.signoutAction ? { action: at.signoutAction, next: at.signoutNext ?? '' } : null; };

const logoutForm = (csrf: string) => {
  const at = signOutAt();
  return `<form method="post"${at ? ` action="${esc(at.action)}"` : ''} class="logout" role="none"><input name="action" type="hidden" value="logout">${at?.next ? `<input name="next" type="hidden" value="${esc(at.next)}">` : ''}<input name="csrf" type="hidden" value="${esc(csrf)}"><button type="submit" role="menuitem" tabindex="-1">Sign out</button></form>`;
};

export const accountMenuHtml = (ctx: PanelContext, where: 'bar' | 'drawer') => `<div class="account-menu" data-where="${where}">
  <button type="button" class="account-button" id="account-button-${where}" aria-haspopup="menu" aria-expanded="false" aria-controls="account-pop-${where}">${accountWho(ctx)}<span class="account-chevron">${icons.chevronDown}</span></button>
  <div class="account-pop" id="account-pop-${where}" role="menu" aria-labelledby="account-button-${where}" hidden>
    <button type="button" role="menuitem" tabindex="-1" data-act="settings">Settings</button>
    ${logoutForm(ctx.session.csrf)}
  </div>
</div>`;

/** Wires every account menu under `root`. Returns what takes the listeners off again. */
export function mountAccountMenus(root: HTMLElement, ctx: PanelContext): () => void {
  const abort = new AbortController();
  const on = { signal: abort.signal };
  const menus = [...root.querySelectorAll<HTMLElement>('.account-menu')];

  for (const menu of menus) {
    const button = menu.querySelector<HTMLButtonElement>('.account-button')!, pop = menu.querySelector<HTMLElement>('.account-pop')!;
    const items = () => [...pop.querySelectorAll<HTMLElement>('[role=menuitem]')];
    const isOpen = () => !pop.hidden;
    function setOpen(next: boolean, focus: 'first' | 'last' | 'button' | false = false) {
      if (next) { for (const other of menus) { if (other !== menu) { other.querySelector<HTMLElement>('.account-pop')!.hidden = true; other.querySelector('.account-button')!.setAttribute('aria-expanded', 'false'); } } }
      pop.hidden = !next;
      button.setAttribute('aria-expanded', String(next));
      if (next && focus === 'first') { items()[0]?.focus(); }
      else if (next && focus === 'last') { items().at(-1)?.focus(); }
      else if (!next && focus === 'button') { button.focus(); }
    }

    button.addEventListener('click', () => setOpen(!isOpen(), 'first'), on);
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true, 'first'); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true, 'last'); }
      else if (event.key === 'Escape' && isOpen()) { event.preventDefault(); setOpen(false, 'button'); }
    }, on);
    pop.addEventListener('keydown', event => {
      const list = items(), at = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false, 'button'); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); list[(at + 1) % list.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
      else if (event.key === 'Home') { event.preventDefault(); list[0].focus(); }
      else if (event.key === 'End') { event.preventDefault(); list.at(-1)!.focus(); }
      // Tab leaves the menu and closes it; the focus goes on from the button, so the next Tab is the next control after it.
      else if (event.key === 'Tab') { setOpen(false, 'button'); }
    }, on);
    pop.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('[data-act=settings]')) { return; }
      setOpen(false);
      openSettings(ctx, () => button.focus());
    }, on);
    // A press outside, by mouse, pen or finger, and focus leaving the menu by any other way, close it without moving the focus.
    document.addEventListener('pointerdown', event => { if (isOpen() && !menu.contains(event.target as Node)) { setOpen(false); } }, { capture: true, signal: abort.signal });
    menu.addEventListener('focusout', event => { const to = event.relatedTarget as Node | null; if (isOpen() && to && !menu.contains(to)) { setOpen(false); } }, on);
  }

  return () => abort.abort();
}

/** The dot follows the list's color (it can be changed in the manager) and the name follows a rename. */
export function drawAccount(root: HTMLElement, ctx: PanelContext) {
  const me = ctx.lists.find(l => l.id === ctx.me);
  root.querySelectorAll<HTMLElement>('.account-who').forEach(who => { who.dataset.c = me?.color ?? 'gray'; who.querySelector('.account-name')!.textContent = me?.name ?? ctx.me; });
}
