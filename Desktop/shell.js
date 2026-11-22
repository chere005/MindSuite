'use strict';

const nav = document.querySelector('nav');
const main = document.querySelector('main');
const split = document.querySelector('#split');
const external = document.querySelector('#external');
const divider = document.querySelector('#divider');
const narrow = window.matchMedia('(max-width: 760px)');
const buttons = new Map();
const rightButtons = new Map();
const picker = window.MindSuitePicker;
const rightBar = document.querySelector('.pane-tools');
const options = document.querySelector('#options');
const optionsDialog = document.querySelector('#options-dialog');
const slots = ['left', 'right'];
let size = .5;
let config, lastOrder;

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
    state.apps.forEach(app => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'app-' + app.key;
      button.textContent = app.label;
      button.style.setProperty('--app', app.color);
      button.setAttribute('role', 'tab');
      button.onclick = () => void window.suite.select(app.key, 'left');
      button.onkeydown = event => {
        const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!offset) return;
        event.preventDefault();
        const visible = picker.visible(config);
        const next = visible[(visible.indexOf(app.key) + offset + visible.length) % visible.length];
        buttons.get(next).focus();
        void window.suite.select(next, 'left');
      };
      nav.append(button);
      buttons.set(app.key, button);
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.dataset.app = app.key;
      pick.title = app.label;
      pick.setAttribute('aria-label', 'Open ' + app.label + ' in the right pane');
      const icon = new Image(20, 20);
      icon.alt = '';
      icon.src = 'assets/apps/' + app.key + '.svg';
      pick.append(icon);
      pick.onclick = () => void window.suite.select(app.key, 'right');
      rightButtons.set(app.key, pick);
    });
    picker.customize({ dialog: optionsDialog, trigger: options, catalog: state.apps,
      getConfig: () => config, save: next => void window.suite.picker(next) });
    const open = options.onclick;
    options.onclick = async () => { await window.suite.editing(true); open(); };
    optionsDialog.onclose = () => void window.suite.editing(false);
  }
  config = state.picker;
  const order = JSON.stringify(config);
  if (lastOrder !== order) {
    lastOrder = order;
    const visible = picker.visible(config);
    nav.replaceChildren();
    rightBar.replaceChildren();
    for (const key of config.order) {
      if (key === picker.spacer) {
        for (const bar of [nav, rightBar]) {
          const spacer = document.createElement('span');
          spacer.className = 'picker-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          bar.append(spacer);
        }
      } else {
        const tab = buttons.get(key), icon = rightButtons.get(key);
        const index = visible.indexOf(key);
        tab.hidden = icon.hidden = index < 0;
        tab.title = tab.textContent + (index < 0 ? '' : ' (Option+' + (index + 1) + ')');
        nav.append(tab);
        rightBar.append(icon);
      }
    }
  }
  const visible = picker.visible(config);
  const focusable = visible.includes(state.left) ? state.left : visible[0];
  for (const [key, button] of buttons) {
    button.dataset.active = String(key === state.left);
    button.setAttribute('aria-selected', String(key === state.left));
    button.tabIndex = key === focusable ? 0 : -1;
  }
  main.dataset.split = String(state.split);
  split.setAttribute('aria-pressed', String(state.split));
  size = state.ratio;
  document.body.dataset.split = String(state.split);
  document.body.style.setProperty('--split-size', String(size));
  divider.setAttribute('aria-valuenow', String(Math.round(size * 100)));
  divider.hidden = !state.split;
  rightBar.hidden = !state.split;
  for (const [key, button] of rightButtons) button.setAttribute('aria-pressed', String(key === state.right));
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
    ? (event.clientY - box.top - 4) / Math.max(1, box.height - 8)
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
