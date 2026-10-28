// Personal fork: the walker's intents from many sources
// (src/navigation/inputs.js): merging, the mode mapping, the registry a
// gamepad joins, and the keyboard as source one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KEYS,
  EVENT_INTENTS,
  HELD_INTENTS,
  addInputSource,
  createInputRegistry,
  createIntents,
  createKeyboardSource,
  inputFromIntents,
  inputRegistry,
  mergeIntents,
} from './inputs.js';

test('intents: held OR’d, look deltas added, events OR’d; nothing asked is all off', () => {
  const none = createIntents();
  for (const name of [...HELD_INTENTS, ...EVENT_INTENTS])
    assert.equal(none[name], false, name);
  assert.deepEqual([none.lookDx, none.lookDy], [0, 0]);
  const merged = createIntents();
  mergeIntents(merged, { forward: true, lookDx: 3, lookDy: -1 });
  mergeIntents(merged, {
    forward: false,
    sneak: true,
    lookDx: 2.5,
    walkHere: true,
  });
  mergeIntents(merged, null);
  mergeIntents(merged, { lookDx: 'x' });
  assert.equal(merged.forward, true, 'one source holding is enough');
  assert.equal(merged.sneak, true);
  assert.equal(merged.walkHere, true);
  assert.equal(merged.lookDx, 5.5);
  assert.equal(merged.lookDy, -1);
});

test('by mode: Walk jumps, sneaks and sprints; Fly rises on jump or up, descends on sneak or down', () => {
  const intents = {
    ...createIntents(),
    forward: true,
    jump: true,
    sneak: true,
    sprint: true,
  };
  assert.deepEqual(inputFromIntents(intents, 'walk'), {
    forward: true,
    back: false,
    left: false,
    right: false,
    sprint: true,
    jump: true,
    sneak: true,
  });
  assert.deepEqual(inputFromIntents(intents, 'fly'), {
    forward: true,
    back: false,
    left: false,
    right: false,
    sprint: true,
    up: true,
    down: true,
  });
  const pad = { ...createIntents(), up: true };
  assert.equal(inputFromIntents(pad, 'fly').up, true);
  assert.equal(inputFromIntents(pad, 'walk').jump, false, 'up is Fly’s');
});

test('the registry: sources added and removed, read and merged, a failing one skipped, reset, heard', () => {
  const registry = createInputRegistry();
  const changes = [];
  registry.subscribe(() => changes.push(registry.size));
  const pad = {
    id: 'gamepad',
    read: (dt) => ({ forward: true, lookDx: 600 * dt }),
    reset() {
      this.wasReset = true;
    },
  };
  const broken = {
    read: () => {
      throw new Error('unplugged');
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const removePad = registry.add(pad);
    const removeBroken = registry.add(broken);
    const intents = registry.read(0.5);
    assert.equal(intents.forward, true);
    assert.equal(intents.lookDx, 300);
    assert.equal(registry.hasOther(pad), true);
    registry.reset();
    assert.equal(pad.wasReset, true);
    removeBroken();
    removeBroken();
    removePad();
    assert.equal(registry.size, 0);
    assert.deepEqual(changes, [1, 2, 1, 0], 'heard once per change');
  } finally {
    console.warn = warn;
  }
  assert.throws(() => registry.add({}), TypeError);
  // The page's registry, as a gamepad joins it.
  const remove = addInputSource({ read: () => ({ jump: true }) });
  assert.equal(inputRegistry().read(0.016).jump, true);
  remove();
  assert.equal(inputRegistry().read(0.016).jump, false);
});

test('the keyboard source: the key map, the double-tap sprint, look deltas once, reset', () => {
  let time = 0;
  const keyboard = createKeyboardSource({ now: () => time });
  const key = (type, code, extra = {}) =>
    keyboard.key({ type, code, ...extra });
  assert.equal(DEFAULT_KEYS.ShiftLeft, 'sneak');
  assert.equal(DEFAULT_KEYS.Space, 'jump');
  assert.equal(
    Object.keys(DEFAULT_KEYS).some((code) => code.startsWith('Control')),
    false,
  );
  assert.equal(key('keydown', 'KeyQ'), false, 'not the walker’s');
  key('keydown', 'KeyW');
  key('keydown', 'ShiftLeft');
  keyboard.look(4, -2);
  keyboard.look(1, 0);
  let read = keyboard.read();
  assert.equal(read.forward, true);
  assert.equal(read.sneak, true);
  assert.equal(read.sprint, undefined);
  assert.deepEqual([read.lookDx, read.lookDy], [5, -2]);
  assert.deepEqual([keyboard.read().lookDx], [0], 'look deltas are read once');
  // Forward twice within 300 ms: sprint, held while forward is.
  key('keyup', 'KeyW');
  time = 200;
  key('keydown', 'KeyW');
  assert.equal(keyboard.read().sprint, true);
  key('keydown', 'KeyW', { repeat: true });
  assert.equal(keyboard.read().sprint, true, 'a key repeat is not a press');
  // The arrow and W both forward: letting one go keeps the sprint.
  key('keydown', 'ArrowUp');
  key('keyup', 'KeyW');
  assert.equal(keyboard.read().sprint, true);
  key('keyup', 'ArrowUp');
  read = keyboard.read();
  assert.equal(read.sprint, undefined);
  assert.equal(read.forward, undefined);
  keyboard.reset();
  assert.deepEqual([...keyboard.heldIntents()], []);
  // A live key map: rebinding applies at once.
  let map = { KeyI: 'forward' };
  const custom = createKeyboardSource({ keys: () => map });
  custom.key({ type: 'keydown', code: 'KeyI' });
  assert.equal(custom.read().forward, true);
  map = { KeyK: 'forward' };
  assert.equal(custom.read().forward, undefined, 'KeyI is no longer forward');
});

test('a stick: per axis the larger magnitude wins, clamped to ±1; it reaches the model', () => {
  const intents = createIntents();
  assert.deepEqual(intents.analog, { forward: 0, right: 0 });
  mergeIntents(intents, { analog: { forward: 0.4, right: -0.2 } });
  mergeIntents(intents, { analog: { forward: -0.3, right: -0.9 } });
  mergeIntents(intents, { analog: { forward: 'x' } });
  assert.deepEqual(intents.analog, { forward: 0.4, right: -0.9 });
  mergeIntents(intents, { analog: { forward: 3 } });
  assert.equal(intents.analog.forward, 1);
  const input = inputFromIntents(intents, 'walk');
  assert.deepEqual(input.analog, { forward: 1, right: -0.9 });
  assert.equal(
    inputFromIntents(createIntents(), 'walk').analog,
    undefined,
    'no stick, no analog',
  );
});

test('one-shots for a gamepad: release, toggleMode, and fly-speed steps summed', () => {
  for (const name of ['walkHere', 'flyHere', 'release', 'toggleMode'])
    assert.ok(EVENT_INTENTS.includes(name), name);
  const registry = createInputRegistry();
  registry.add({ read: () => ({ release: true, flySpeedStep: 1 }) });
  registry.add({ read: () => ({ toggleMode: true, flySpeedStep: 1 }) });
  registry.add({ read: () => ({ flySpeedStep: -1 }) });
  const intents = registry.read(0.016);
  assert.equal(intents.release, true);
  assert.equal(intents.toggleMode, true);
  assert.equal(intents.flySpeedStep, 1);
  assert.equal(createIntents().flySpeedStep, 0);
});

test("a pad's Spectator block: summed across sources, zeros by default", () => {
  assert.deepEqual(createIntents().spectator, {
    panX: 0,
    panY: 0,
    orbitYaw: 0,
    orbitPitch: 0,
    zoom: 0,
  });
  const registry = createInputRegistry();
  registry.add({ read: () => ({ spectator: { panX: 0.5, orbitYaw: 2 } }) });
  registry.add({
    read: () => ({ spectator: { panX: 0.25, zoom: -1, orbitPitch: 'x' } }),
  });
  registry.add({ read: () => null });
  assert.deepEqual(registry.read(0.016).spectator, {
    panX: 0.75,
    panY: 0,
    orbitYaw: 2,
    orbitPitch: 0,
    zoom: -1,
  });
});

test('the hint channel: a source says a line through the binding’s overlay', () => {
  const registry = createInputRegistry();
  assert.equal(
    registry.hint('controller connected', 3000),
    false,
    'no binding yet',
  );
  const said = [];
  const undo = registry.setHinter((text, ms) => said.push([text, ms]));
  assert.equal(registry.hint('controller connected', 3000), true);
  assert.deepEqual(said, [['controller connected', 3000]]);
  undo();
  assert.equal(registry.hint('again', 1), false);
});

test('a key tapped between two reads counts once (a sneak toggle, a jump)', () => {
  const keyboard = createKeyboardSource();
  keyboard.key({ type: 'keydown', code: 'ShiftLeft' });
  keyboard.key({ type: 'keyup', code: 'ShiftLeft' });
  assert.equal(keyboard.read().sneak, true, 'the tap reaches this read');
  assert.equal(keyboard.read().sneak, undefined, 'and only this one');
  keyboard.key({ type: 'keydown', code: 'Space' });
  keyboard.key({ type: 'keyup', code: 'Space' });
  keyboard.reset();
  assert.equal(keyboard.read().jump, undefined, 'a reset forgets it');
});
