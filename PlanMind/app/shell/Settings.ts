import { THEMES, type ThemeName } from '../theme';
import { esc, icons, type PanelContext } from '../panelContext';

/**
 * Settings: the window behind the account menu's Settings row, the suite's (lib/chrome.php settings_modal_html) without
 * the password change. "Signed in as", the Theme row of four swatches (a theme in miniature: its page color with its
 * accent as a dot, the current one ringed) and Done. A pick applies at once and is saved as the account's theme (state.saveTheme);
 * a save that fails puts the theme and the ring back and says so here.
 */
let open: HTMLDialogElement | undefined;

export function openSettings(ctx: PanelContext, returnFocus: () => void): void {
  open?.close();
  const dialog = document.createElement('dialog');
  dialog.className = 'settings';
  dialog.setAttribute('aria-labelledby', 'settings-title');
  const me = ctx.lists.find(l => l.id === ctx.me)?.name ?? ctx.me;
  const names = Object.keys(THEMES) as ThemeName[];
  dialog.innerHTML = `<div class="settings-body"><h2 id="settings-title" class="settings-title">Settings</h2>
<p class="settings-who">Signed in as <strong>${esc(me)}</strong></p>
<p class="settings-label" id="settings-theme-label">Theme</p>
<div class="theme-row" role="group" aria-labelledby="settings-theme-label">${names.map(name => `<button type="button" class="themebtn" data-theme="${name}" title="${esc(THEMES[name].label)}" aria-label="${esc(THEMES[name].label)}" aria-pressed="false"><span class="themedot"></span></button>`).join('')}</div>
<p class="settings-msg" role="status" aria-live="polite"></p>
<div class="settings-actions"><button type="button" class="settings-done" title="Done" aria-label="Done">${icons.done}</button></div></div>`;
  document.body.append(dialog);
  open = dialog;

  const message = dialog.querySelector<HTMLElement>('.settings-msg')!;
  const swatches = [...dialog.querySelectorAll<HTMLButtonElement>('.themebtn')];
  // The swatch colors come from the theme table, set as custom properties (no inline color in the markup).
  for (const swatch of swatches) {
    const cols = THEMES[swatch.dataset.theme as ThemeName];
    swatch.style.setProperty('--sw-bg', cols.bg); swatch.style.setProperty('--sw-line', cols.line); swatch.style.setProperty('--sw-dot', cols.accent);
  }
  const mark = () => swatches.forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.theme === ctx.state.theme)));
  mark();

  dialog.addEventListener('click', async event => {
    if (event.target === dialog) { dialog.close(); return; }
    const swatch = (event.target as HTMLElement).closest<HTMLButtonElement>('.themebtn');
    if (!swatch || swatch.dataset.theme === ctx.state.theme) { return; }
    message.textContent = '';
    const saving = ctx.state.saveTheme(swatch.dataset.theme!);
    mark();
    const result = await saving;
    // Settings was closed while it saved: the theme is already back, so the banner (not a window that is gone) says why.
    if (!dialog.isConnected) { if (!result.ok) { ctx.report(result.message); } return; }
    mark();
    message.textContent = result.ok ? '' : result.message;
  });
  dialog.querySelector('.settings-done')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { dialog.remove(); if (open === dialog) { open = undefined; } returnFocus(); });
  dialog.showModal();
  // The current theme is where the keyboard starts, as on the suite's settings window the swatches come before Done.
  (dialog.querySelector<HTMLElement>('.themebtn[aria-pressed=true]') ?? dialog.querySelector<HTMLElement>('.settings-done'))?.focus();
}
