'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restore, select, toggle, paneBounds } = require('../workspace.cjs');
const { assetPath } = require('../calmind.cjs');
const { visible } = require('../picker.js');
const layout = ({ picker, ...state }) => state;

test('a split opens two stable slots and replaces the focused one', () => {
  const split = select(toggle(restore()), 'scrollmind');
  assert.deepEqual(layout(split), { left: 'calmind', right: 'scrollmind', split: true, active: 'scrollmind', ratio: .5 });
  const after = select(select(split, 'calmind'), 'planmind');
  assert.deepEqual(layout(after), { left: 'planmind', right: 'scrollmind', split: true, active: 'planmind', ratio: .5 });
  assert.deepEqual(layout(toggle(after)), { left: 'planmind', right: null, split: false, active: 'planmind', ratio: .5 });
  assert.equal(select(split, 'scrollmind', 'left').right, 'calmind', 'per-pane selection swaps already-open apps');
  assert.strictEqual(select(split, 'calmind', 'right'), split, 'the right picker preserves both panes and focus when the app is open on the left');
  const emptyRight = toggle(restore());
  assert.strictEqual(select(emptyRight, 'calmind', 'right'), emptyRight, 'the right pane stays empty when the app already occupies the left');
});

test('a saved split restores, including the focused side, and invalid tabs are ignored', () => {
  const state = { left: 'scrollmind', right: 'calmind', split: true, active: 'calmind', ratio: .6 };
  assert.deepEqual(layout(restore(state)), state);
  assert.equal(restore({ ...state, right: 'scrollmind' }).right, null);
  assert.equal(select(state, 'unknown'), state);
  assert.equal(restore({ ...state, ratio: 1 }).ratio, .75);
  assert.equal(visible(restore({ picker: { order: ['scrollmind', '|', 'calmind'], hidden: ['calmind'] } }).picker)[0], 'scrollmind');
});

test('wide panes share the width and narrow panes stack below the toolbar', () => {
  assert.deepEqual(paneBounds(1201, 900, true), [
    { x: 0, y: 46, width: 596, height: 854 }, { x: 604, y: 46, width: 597, height: 854 },
  ]);
  assert.deepEqual(paneBounds(700, 901, true), [
    { x: 0, y: 46, width: 700, height: 423 }, { x: 0, y: 477, width: 700, height: 424 },
  ]);
});

test('the local handler serves CalMind assets and leaves account and API routes to the server', () => {
  const asset = url => assetPath(new URL(url, 'https://seancheren.com'));
  assert.equal(asset('/calmind/?view=notes'), 'index.html');
  assert.equal(asset('/calmind/_expo/a.js'), '_expo/a.js');
  assert.equal(asset('/calmind/api/index.php'), null);
  assert.equal(asset('/account/'), null);
  assert.equal(asset('/calmind/a%2f..%2foutside'), '');
  assert.equal(asset('/calmind/a%5cb.js'), '');
  assert.equal(asset('https://example.test/calmind/'), null);
});
