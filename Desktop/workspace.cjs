'use strict';

const appPicker = require('./picker.js');
const apps = [
  ['calmind', 'CalMind', '/calmind/', '#34d399'],
  ['mealmind', 'MealMind', '/MealMind/', '#ff8a47'],
  ['planmind', 'PlanMind', '/PlanMind/', '#fb82a1'],
  ['taskmind', 'TaskMind', '/taskmind/', '#d58dee'],
  ['acctmind', 'AcctMind', '/AcctMind/', '#58c74e'],
  ['notemind', 'NoteMind', '/NoteMind/', '#2bc4ea'],
  ['scrollmind', 'ScrollMind', '/ScrollMind/', '#6792fe'],
].map(([key, label, path, color]) => ({ key, label, path, color }));

function known(key) { return apps.some(app => app.key === key); }
function ratioFor(value) { return Number.isFinite(value) ? Math.min(.75, Math.max(.25, value)) : .5; }

function restore(value) {
  const left = known(value?.left) ? value.left : 'calmind';
  const split = value?.split === true;
  const right = split && known(value.right) && value.right !== left ? value.right : null;
  return { left, right, split, active: value?.active === right && right ? right : left, ratio: ratioFor(value?.ratio),
    picker: appPicker.normalize(apps.map(app => app.key), value?.picker) };
}

function select(state, key, side) {
  if (!known(key)) return state;
  if (!state.split) return { ...state, left: key, active: key };
  if (side === 'left') {
    return { ...state, left: key, right: key === state.right ? state.left : state.right, active: key };
  }
  if (side === 'right') {
    return key === state.left ? state : { ...state, right: key, active: key };
  }
  if (key === state.left || key === state.right) return { ...state, active: key };
  const pane = !state.right || state.active === state.right ? 'right' : 'left';
  return { ...state, [pane]: key, active: key };
}

function toggle(state) {
  return { ...state, left: state.active, right: null, split: !state.split };
}

function paneBounds(width, height, split, ratio = .5) {
  const bar = 46, gap = 8;
  if (!split) return [{ x: 0, y: bar, width, height: Math.max(0, height - bar) }];
  const y = bar;
  if (width <= 760) {
    const available = Math.max(0, height - bar - gap);
    const first = Math.floor(available * ratio);
    return [{ x: 0, y, width, height: first },
      { x: 0, y: y + first + gap, width, height: available - first }];
  }
  const first = Math.floor((width - gap) * ratio);
  const available = Math.max(0, height - y);
  return [{ x: 0, y, width: first, height: available },
    { x: first + gap, y, width: width - first - gap, height: available }];
}

module.exports = { apps, restore, select, toggle, paneBounds, ratioFor };
