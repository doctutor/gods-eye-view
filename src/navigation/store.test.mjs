// Personal fork: the navigation mode's store, its link parameter and its
// drop-down (src/navigation/store.js, presentation.js), and the keys the
// binding reads (binding.js inputFromKeys).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NAV_PARAM,
  createNavigationStore,
  decodeNavParam,
  encodeNavParam,
} from './store.js';
import {
  combineHeadingControls,
  createNavigationHeadingControl,
} from './presentation.js';
import { DOUBLE_TAP_MS, createDoubleTap, inputFromKeys } from './binding.js';

test('nav= reads walk and fly; anything else, or none, is Spectator', () => {
  assert.equal(NAV_PARAM, 'nav');
  assert.equal(decodeNavParam('walk'), 'walk');
  assert.equal(decodeNavParam('FLY'), 'fly');
  for (const value of [null, undefined, '', 'spectator', 'swim', '1'])
    assert.equal(decodeNavParam(value), 'spectator', String(value));
  assert.equal(encodeNavParam('walk'), 'walk');
  assert.equal(encodeNavParam('fly'), 'fly');
  assert.equal(encodeNavParam('spectator'), null, 'old links unchanged');
});

test('the store: set, listeners told once per change, the param', () => {
  const store = createNavigationStore({ initial: 'spectator' });
  const heard = [];
  const stop = store.subscribe((mode) => heard.push(mode));
  assert.equal(store.set('walk'), true);
  assert.equal(store.set('walk'), false);
  assert.equal(store.set('swim'), false);
  assert.equal(store.param(), 'walk');
  store.set('fly');
  stop();
  store.set('spectator');
  assert.deepEqual(heard, ['walk', 'fly']);
  assert.equal(store.param(), null);
  assert.equal(createNavigationStore({ initial: 'bogus' }).get(), 'spectator');
});

test("a link's nav=walk opens in Walk", () => {
  const before = globalThis.location;
  globalThis.location = { hash: '#lat=39.3&lon=-76.6&nav=walk' };
  try {
    assert.equal(createNavigationStore().get(), 'walk');
    globalThis.location = { hash: '#lat=39.3&lon=-76.6' };
    assert.equal(createNavigationStore().get(), 'spectator');
  } finally {
    globalThis.location = before;
  }
});

/** Just enough DOM for a heading control. */
function fakeDocument() {
  const element = (tag) => {
    const listeners = {};
    return {
      tag,
      children: [],
      attributes: {},
      className: '',
      value: '',
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      appendChild(node) {
        this.children.push(node);
      },
      addEventListener(type, f) {
        (listeners[type] ||= new Set()).add(f);
      },
      removeEventListener(type, f) {
        listeners[type]?.delete(f);
      },
      fire(type, event = {}) {
        for (const f of listeners[type] || []) f(event);
      },
      blur() {
        this.blurred = true;
      },
      listeners,
    };
  };
  return { createElement: element };
}

test('the Move drop-down sets the mode and follows it', () => {
  const doc = fakeDocument();
  const store = createNavigationStore({ initial: 'spectator' });
  const control = createNavigationHeadingControl(doc, store);
  const select = control.element.children[0];
  assert.deepEqual(
    select.children.map((option) => option.value),
    ['spectator', 'walk', 'fly'],
  );
  assert.equal(select.value, 'spectator');
  select.value = 'walk';
  select.fire('change');
  assert.equal(store.get(), 'walk');
  assert.equal(select.blurred, true, 'the keys go to the walker');
  store.set('fly');
  assert.equal(select.value, 'fly');
  // Beside the Render control, in one heading.
  const render = {
    element: doc.createElement('span'),
    destroy() {
      this.gone = true;
    },
  };
  const both = combineHeadingControls(doc, render, control, undefined);
  assert.equal(both.element.children.length, 2);
  both.destroy();
  assert.equal(render.gone, true);
  store.set('spectator');
  assert.equal(select.value, 'fly', 'destroyed: no longer follows');
});

test('the keys (Minecraft’s): Space jumps in Walk and rises in Fly; Shift sneaks, or descends', () => {
  const held = new Set(['forward', 'space', 'shift']);
  assert.deepEqual(inputFromKeys(held, 'walk'), {
    forward: true,
    back: false,
    left: false,
    right: false,
    sprint: false,
    jump: true,
    sneak: true,
  });
  assert.deepEqual(inputFromKeys(held, 'fly'), {
    forward: true,
    back: false,
    left: false,
    right: false,
    sprint: false,
    up: true,
    down: true,
  });
  // No Ctrl (Ctrl+W closes the tab): forward's double-tap sprints, and
  // doubles Fly's speed; Shift no longer sprints.
  assert.equal(inputFromKeys(new Set(['control']), 'walk').sprint, false);
  assert.equal(inputFromKeys(new Set(['sprint']), 'walk').sprint, true);
  assert.equal(inputFromKeys(new Set(['sprint']), 'fly').sprint, true);
  assert.equal(inputFromKeys(new Set(['shift']), 'walk').sprint, false);
});

test('a double-tap of forward within 300 ms sprints; a slow second press does not', () => {
  assert.equal(DOUBLE_TAP_MS, 300);
  const tap = createDoubleTap();
  assert.equal(tap.press(0), false);
  assert.equal(tap.press(250), true, 'the second of two');
  assert.equal(tap.press(400), false, 'a third starts afresh');
  assert.equal(tap.press(1000), false, 'too slow');
  assert.equal(tap.press(1290), true);
});

test('Walk here: the entry request reaches the binding; the Here button asks for it in Spectator only', () => {
  const store = createNavigationStore({ initial: 'spectator' });
  const asked = [];
  assert.equal(store.requestEntry('walk'), false, 'nobody listening');
  const off = store.onEntry((mode) => asked.push(mode));
  assert.equal(store.requestEntry('walk'), true);
  assert.equal(store.requestEntry('spectator'), false);
  const doc = fakeDocument();
  const control = createNavigationHeadingControl(doc, store);
  const [, here] = control.element.children;
  assert.equal(here.tag, 'button');
  assert.equal(here.hidden, false);
  here.fire('click', {});
  here.fire('click', { shiftKey: true });
  assert.deepEqual(asked, ['walk', 'walk', 'fly']);
  store.set('walk');
  assert.equal(here.hidden, true, 'only in Spectator');
  off();
  control.destroy();
});
