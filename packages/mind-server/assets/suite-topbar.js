/* Shared account-menu interaction for the DOM app bars. */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var mounted = new WeakMap();
  function mount(root) {
    var button = root.querySelector('#userBtn'), menu = root.querySelector('#userMenu');
    if (!button || !menu || !button.closest('.ms-app-bar') || !menu.classList.contains('ms-app-menu')) return function () {};
    if (mounted.has(button)) return mounted.get(button);
    var user = button.parentElement;
    var abort = new AbortController(), on = { signal: abort.signal };
    function rows() {
      return Array.from(menu.querySelectorAll('.ms-app-menu-row')).filter(function (item) {
        return !item.disabled && item.getAttribute('aria-disabled') !== 'true' && item.getClientRects().length;
      });
    }
    function setOpen(open, focus) {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (focus === 'button') button.focus();
      else if (open && focus) {
        var items = rows();
        var item = focus === 'last' ? items[items.length - 1] : items[0];
        if (item) item.focus();
      }
    }
    button.setAttribute('aria-haspopup', 'menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', button.id);
    menu.querySelectorAll('.ms-app-menu-row').forEach(function (item) {
      item.setAttribute('role', 'menuitem'); item.setAttribute('tabindex', '-1');
    });
    button.addEventListener('click', function (event) { event.stopPropagation(); setOpen(menu.hidden, menu.hidden ? 'first' : 'button'); }, on);
    button.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); setOpen(true, event.key === 'ArrowDown' ? 'first' : 'last');
      }
    }, on);
    menu.addEventListener('keydown', function (event) {
      var items = rows(), index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false, 'button'); }
      else if (event.key === 'Tab') setOpen(false, 'button');
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
        event.preventDefault();
        var next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length : index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        items[next].focus();
      }
    }, on);
    document.addEventListener('pointerdown', function (event) { if (!menu.hidden && !user.contains(event.target)) setOpen(false); }, { capture: true, signal: abort.signal });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); setOpen(false, 'button'); } }, on);
    user.addEventListener('focusout', function (event) { if (!menu.hidden && event.relatedTarget && !user.contains(event.relatedTarget)) setOpen(false); }, on);
    var cleanup = function () { abort.abort(); mounted.delete(button); };
    mounted.set(button, cleanup);
    return cleanup;
  }
  window.MindSuiteTopBar = { mountAccountMenu: mount };
  function start() { mount(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
