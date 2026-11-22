'use strict';

const nav = document.querySelector('nav');
const main = document.querySelector('main');
const split = document.querySelector('#split');
const external = document.querySelector('#external');
const divider = document.querySelector('#divider');
const narrow = window.matchMedia('(max-width: 760px)');
const buttons = new Map();
const slots = ['left', 'right'];
const tools = new Map(slots.map(side => [side, document.querySelector(`.pane-tools[data-side="${side}"]`)]));
let size = .5;

function showSlot(side, key, error, ready) {
  const pane = document.getElementById(side);
  if (ready) { pane.replaceChildren(); return; }
  const message = document.createElement('p');
  message.textContent = error || (key ? 'Opening app…' : 'Choose another tab for the second pane.');
  pane.replaceChildren(message);
  if (error) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.onclick = () => void window.suite.retry(key);
    pane.append(retry);
  }
}

function draw(state) {
  if (!buttons.size) {
    state.apps.forEach((app, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'app-' + app.key;
      button.textContent = app.label;
      button.title = app.label + ' (Option+' + (index + 1) + ')';
      button.style.setProperty('--app', app.color);
      button.setAttribute('role', 'tab');
      button.onclick = () => void window.suite.select(app.key);
      button.onkeydown = event => {
        const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!offset) return;
        event.preventDefault();
        const next = state.apps[(index + offset + state.apps.length) % state.apps.length].key;
        buttons.get(next).focus();
        void window.suite.select(next);
      };
      nav.append(button);
      buttons.set(app.key, button);
      for (const [side, bar] of tools) {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.dataset.app = app.key;
        pick.title = app.label;
        pick.setAttribute('aria-label', 'Open ' + app.label + ' in this pane');
        const icon = new Image(20, 20);
        icon.alt = '';
        icon.src = 'assets/apps/' + app.key + '.svg';
        pick.append(icon);
        pick.onclick = () => void window.suite.select(app.key, side);
        bar.append(pick);
      }
    });
  }
  for (const [key, button] of buttons) {
    button.dataset.active = String(key === state.active);
    button.setAttribute('aria-selected', String(key === state.left || key === state.right));
    button.tabIndex = key === state.active ? 0 : -1;
  }
  nav.setAttribute('aria-multiselectable', String(state.split));
  main.dataset.split = String(state.split);
  split.setAttribute('aria-pressed', String(state.split));
  size = state.ratio;
  main.style.setProperty('--split-size', String(size));
  divider.setAttribute('aria-valuenow', String(Math.round(size * 100)));
  divider.hidden = !state.split;
  for (const [side, bar] of tools) {
    bar.hidden = !state.split;
    for (const button of bar.children) button.setAttribute('aria-pressed', String(button.dataset.app === state[side]));
  }
  document.getElementById('right').hidden = !state.split;
  for (const side of slots) showSlot(side, state[side], state.errors[state[side]], state.ready.includes(state[side]));
}

split.onclick = () => void window.suite.split();
external.onclick = () => void window.suite.external();
divider.onpointerdown = event => {
  if (event.button !== 0) return;
  divider.setPointerCapture(event.pointerId);
  divider.dataset.dragging = 'true';
};
divider.onpointermove = event => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const box = main.getBoundingClientRect();
  const ratio = narrow.matches
    ? (event.clientY - box.top - 38) / Math.max(1, box.height - 76)
    : (event.clientX - box.left - 4) / Math.max(1, box.width - 8);
  void window.suite.resize(ratio);
};
divider.onlostpointercapture = () => { delete divider.dataset.dragging; };
divider.ondblclick = () => void window.suite.resize(.5);
divider.onkeydown = event => {
  const back = narrow.matches ? 'ArrowUp' : 'ArrowLeft';
  const forward = narrow.matches ? 'ArrowDown' : 'ArrowRight';
  const values = { Enter: .5, [back]: size - .05, [forward]: size + .05 };
  if (!Object.hasOwn(values, event.key)) return;
  event.preventDefault();
  void window.suite.resize(values[event.key]);
};
function orientDivider() { divider.setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical'); }
window.addEventListener('resize', orientDivider);
orientDivider();
window.suite.subscribe(draw);
void window.suite.state().then(draw);
