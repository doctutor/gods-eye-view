// Personal fork: the gamepad for Walk and Fly (src/navigation/gamepad.js):
// a pad's snapshot to the binding's intents (dead zone, tilt, look curve,
// held buttons, presses that act once, the sprint latch), the settings,
// the source's connection handling (nothing polled while off), and its
// attachment to the store and an input-source registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUTTONS,
  CONNECTED_HINT_MS,
  GAMEPAD_DEFAULTS,
  LOOK_PX_PER_S,
  STORAGE_PREFIX,
  attachGamepad,
  createGamepadSource,
  deadZoned,
  gamepadIntents,
  gamepadSettings,
  idleState,
  readGamepadSettings,
  snapshotOf,
} from './gamepad.js';

/** A standard-mapping snapshot: axes [lx, ly, rx, ry], buttons held by index, analog values. */
function pad({ axes = [0, 0, 0, 0], held = [], values = {} } = {}) {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD)',
    mapping: 'standard',
    connected: true,
    axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: held.includes(index) || (values[index] ?? 0) > 0.5,
      value: values[index] ?? (held.includes(index) ? 1 : 0),
    })),
  };
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('deadZoned: a radial dead zone, the tilt rescaled 0 … 1 past it', () => {
  assert.deepEqual(deadZoned(0.1, 0.1, 0.15), { x: 0, y: 0, magnitude: 0 }); // 0.14 inside
  const half = deadZoned(0.575, 0, 0.15); // (0.575 − 0.15) / 0.85 = 0.5
  assert.ok(close(half.magnitude, 0.5) && close(half.x, 0.5) && half.y === 0);
  const full = deadZoned(1, 1, 0.15); // a corner is clamped to 1
  assert.ok(close(full.magnitude, 1));
  assert.ok(close(full.x, Math.SQRT1_2) && close(full.y, Math.SQRT1_2));
  assert.equal(deadZoned(0.2, 0, 0.3).magnitude, 0);
});

test('the left stick moves: forward, back, left and right past the threshold, its tilt kept', () => {
  let result = gamepadIntents(pad({ axes: [0, -1, 0, 0] }), { dt: 1 / 60 });
  assert.equal(result.intents.forward, true);
  assert.equal(result.intents.back, false);
  assert.ok(close(result.intents.analog.forward, 1));
  assert.ok(close(result.intents.analog.right, 0));
  result = gamepadIntents(pad({ axes: [0.575, 0, 0, 0] }));
  assert.equal(result.intents.right, true);
  assert.ok(close(result.intents.analog.right, 0.5));
  result = gamepadIntents(pad({ axes: [-1, 1, 0, 0] }));
  assert.equal(result.intents.left, true);
  assert.equal(result.intents.back, true);
  // A drift inside the dead zone is nothing.
  result = gamepadIntents(pad({ axes: [0.1, -0.1, 0, 0] }));
  assert.deepEqual(result.intents.analog, { forward: 0, right: 0 });
  const { forward, back, left, right } = result.intents;
  assert.equal(forward || back || left || right, false);
  // A small push past the dead zone but under the threshold: not yet a key.
  result = gamepadIntents(pad({ axes: [0, -0.3, 0, 0] }));
  assert.ok(result.intents.analog.forward > 0);
  assert.equal(result.intents.forward, false);
  // A wider dead zone from the settings.
  result = gamepadIntents(pad({ axes: [0.25, 0, 0, 0] }), {
    settings: { deadZone: 0.3 },
  });
  assert.equal(result.intents.analog.right, 0);
});

test('the right stick looks: pointer-lock pixels by the curve, sensitivity and inversion', () => {
  const dt = 0.5;
  // Full right: 600 px/s × 0.5 s.
  let { intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), { dt });
  assert.ok(close(intents.lookDx, LOOK_PX_PER_S * dt));
  assert.ok(close(intents.lookDy, 0));
  // Half tilt: the curve squares it (a quarter), so a small tilt aims finely.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0.575, 0] }), { dt }));
  assert.ok(close(intents.lookDx, LOOK_PX_PER_S * dt * 0.25));
  // Stick up looks up: −y on the stick, −y in pointer-lock pixels.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0, -1] }), { dt }));
  assert.ok(close(intents.lookDy, -LOOK_PX_PER_S * dt));
  // Inverted Y and sensitivity 2.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0, -1] }), {
    dt,
    settings: { invertY: true, sensitivity: 2 },
  }));
  assert.ok(close(intents.lookDy, LOOK_PX_PER_S * dt * 2));
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), {
    dt,
    settings: { invertX: true },
  }));
  assert.ok(close(intents.lookDx, -LOOK_PX_PER_S * dt));
  // Per frame: no time, no turn.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), { dt: 0 }));
  assert.equal(intents.lookDx, 0);
});

test('buttons: A jump and B sneak held in Walk; up and down from A/B or the triggers in Fly', () => {
  let { intents } = gamepadIntents(pad({ held: [BUTTONS.A] }), {
    mode: 'walk',
  });
  assert.equal(intents.jump, true);
  assert.equal(intents.sneak, false);
  assert.equal(intents.up, undefined);
  ({ intents } = gamepadIntents(pad({ held: [BUTTONS.B] }), { mode: 'walk' }));
  assert.equal(intents.sneak, true);
  ({ intents } = gamepadIntents(pad({ values: { [BUTTONS.RT]: 0.8 } }), {
    mode: 'fly',
  }));
  assert.equal(intents.up, true);
  assert.equal(intents.down, false);
  assert.equal(intents.jump, undefined);
  ({ intents } = gamepadIntents(pad({ values: { [BUTTONS.LT]: 0.3 } }), {
    mode: 'fly',
  }));
  assert.equal(intents.down, false); // a light squeeze is not a press
  ({ intents } = gamepadIntents(pad({ held: [BUTTONS.B] }), { mode: 'fly' }));
  assert.equal(intents.down, true);
  ({ intents } = gamepadIntents(pad({ held: [BUTTONS.A] }), { mode: 'fly' }));
  assert.equal(intents.up, true);
});

test('Start, Back and the D-pad act once a press, not while held', () => {
  let state = idleState();
  const frame = (snapshot) => {
    const result = gamepadIntents(snapshot, { state });
    state = result.state;
    return result.intents;
  };
  assert.equal(frame(pad({ held: [BUTTONS.START] })).release, true);
  assert.equal(frame(pad({ held: [BUTTONS.START] })).release, false); // still held
  assert.equal(frame(pad()).release, false);
  assert.equal(frame(pad({ held: [BUTTONS.START] })).release, true); // again
  assert.equal(frame(pad({ held: [BUTTONS.BACK] })).toggleMode, true);
  assert.equal(frame(pad({ held: [BUTTONS.BACK] })).toggleMode, false);
  assert.equal(frame(pad({ held: [BUTTONS.RIGHT] })).flySpeedStep, 1);
  assert.equal(frame(pad({ held: [BUTTONS.RIGHT] })).flySpeedStep, 0);
  assert.equal(frame(pad({ held: [BUTTONS.LEFT] })).flySpeedStep, -1);
  frame(pad());
  assert.equal(
    frame(pad({ held: [BUTTONS.LEFT, BUTTONS.RIGHT] })).flySpeedStep,
    0,
  );
});

test('sprint: a stick click starts it, and it lasts until the left stick rests', () => {
  let state = idleState();
  const frame = (snapshot) => {
    const result = gamepadIntents(snapshot, { state });
    state = result.state;
    return result.intents;
  };
  const forward = [0, -1, 0, 0];
  assert.equal(frame(pad({ axes: forward })).sprint, false);
  assert.equal(frame(pad({ axes: forward, held: [BUTTONS.RS] })).sprint, true);
  assert.equal(frame(pad({ axes: forward })).sprint, true); // released, still on
  assert.equal(frame(pad({ axes: [0.3, -0.9, 0, 0] })).sprint, true); // steering
  assert.equal(frame(pad()).sprint, false); // the stick at rest ends it
  assert.equal(frame(pad({ axes: forward })).sprint, false);
  // The left stick's click too (Bedrock's).
  assert.equal(frame(pad({ axes: forward, held: [BUTTONS.LS] })).sprint, true);
  // A click with the stick at rest does nothing.
  state = idleState();
  assert.equal(frame(pad({ held: [BUTTONS.RS] })).sprint, false);
});

test('settings: whole and in range, kept under gev.nav.gamepad.*', () => {
  assert.deepEqual(gamepadSettings(), { ...GAMEPAD_DEFAULTS });
  assert.deepEqual(
    gamepadSettings({ deadZone: 0.9, sensitivity: 9, invertY: 'true' }),
    { deadZone: 0.5, sensitivity: 3, invertX: false, invertY: true },
  );
  assert.equal(gamepadSettings({ sensitivity: 0.1 }).sensitivity, 0.5);
  assert.equal(gamepadSettings({ deadZone: 'x' }).deadZone, 0.15);
  assert.equal(gamepadSettings({ deadZone: '' }).deadZone, 0.15);
  const kept = new Map();
  const storage = {
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => kept.set(key, value),
  };
  assert.deepEqual(readGamepadSettings(storage), { ...GAMEPAD_DEFAULTS });
  const source = createGamepadSource({
    storage,
    windowRef: null,
    navigatorRef: null,
    getMode: () => 'walk',
  });
  source.setSettings({ sensitivity: 2, invertX: true });
  assert.equal(kept.get(`${STORAGE_PREFIX}sensitivity`), '2');
  assert.equal(kept.get(`${STORAGE_PREFIX}invertX`), 'true');
  assert.deepEqual(readGamepadSettings(storage), {
    deadZone: 0.15,
    sensitivity: 2,
    invertX: true,
    invertY: false,
  });
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
  };
  assert.deepEqual(readGamepadSettings(broken), { ...GAMEPAD_DEFAULTS });
});

/** A fake window with events, and a navigator whose pads the test sets. */
function fakeEnvironment() {
  const listeners = new Map();
  const windowRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  let pads = [];
  let polls = 0;
  const navigatorRef = {
    getGamepads: () => {
      polls++;
      return pads;
    },
  };
  return {
    windowRef,
    navigatorRef,
    listeners,
    setPads: (next) => (pads = next),
    polls: () => polls,
  };
}

test('the source: nothing polled while off or with no pad; a connected pad reads, with a hint', () => {
  const env = fakeEnvironment();
  let mode = 'spectator';
  const hints = [];
  const source = createGamepadSource({
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    storage: null,
    getMode: () => mode,
    onHint: (text, ms) => hints.push([text, ms]),
  });
  const pollsAtStart = env.polls(); // one look at start, for a pad already in hand
  assert.equal(source.connected(), false);
  assert.equal(source.read(1 / 60), null); // Spectator
  mode = 'walk';
  assert.equal(source.read(1 / 60), null); // no pad
  assert.equal(env.polls(), pollsAtStart);
  // A pad connects: the keys hint says so for 3 s.
  env.setPads([pad({ axes: [0, -1, 0, 0], held: [BUTTONS.A] })]);
  env.listeners.get('gamepadconnected')({ gamepad: {} });
  assert.equal(source.connected(), true);
  assert.deepEqual(
    hints.map(([, ms]) => ms),
    [CONNECTED_HINT_MS],
  );
  assert.match(hints[0][0], /controller connected/);
  const intents = source.read(1 / 60);
  assert.equal(intents.forward, true);
  assert.equal(intents.jump, true);
  assert.ok(env.polls() > pollsAtStart);
  // Back in Spectator: nothing again, not polled.
  mode = 'spectator';
  const polls = env.polls();
  assert.equal(source.read(1 / 60), null);
  assert.equal(env.polls(), polls);
  mode = 'fly';
  assert.equal(source.read(1 / 60).up, true);
  env.listeners.get('gamepaddisconnected')({ gamepad: {} });
  assert.equal(source.connected(), false);
  assert.equal(source.read(1 / 60), null);
  source.destroy();
  assert.equal(env.listeners.size, 0);
});

test('the source: one-shot presses on their frame only; reset forgets what was held', () => {
  const env = fakeEnvironment();
  env.setPads([pad({ held: [BUTTONS.START] })]);
  const source = createGamepadSource({
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    storage: null,
    getMode: () => 'walk',
  });
  assert.equal(source.connected(), true); // a pad already connected at load
  assert.equal(source.read(1 / 60).release, true);
  assert.equal(source.read(1 / 60).release, false); // still held
  env.setPads([pad({ held: [BUTTONS.BACK, BUTTONS.RIGHT] })]);
  let intents = source.read(1 / 60);
  assert.equal(intents.toggleMode, true);
  assert.equal(intents.flySpeedStep, 1);
  assert.equal(source.read(1 / 60).toggleMode, false);
  // reset: a button still held counts as a fresh press after it (a new mode).
  source.reset();
  intents = source.read(1 / 60);
  assert.equal(intents.toggleMode, true);
  assert.equal(intents.flySpeedStep, 1);
  source.destroy();
  // Plain data from a pad, numbers for buttons too.
  assert.equal(
    snapshotOf({ buttons: [1, 0], axes: [0.5] }).buttons[0].pressed,
    true,
  );
});

test('attachGamepad: registered as a source, reading the mode from the store, the hint through onHint', () => {
  const env = fakeEnvironment();
  let mode = 'walk';
  const store = { get: () => mode };
  const registered = [];
  let removed = 0;
  const hints = [];
  const { source, detach } = attachGamepad({
    addInputSource: (entry) => {
      registered.push(entry);
      return () => removed++;
    },
    store,
    onHint: (text, ms) => hints.push(ms),
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    storage: null,
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'gamepad');
  assert.equal(typeof registered[0].reset, 'function');
  assert.equal(registered[0].read(1 / 60), null); // no pad yet
  env.setPads([pad({ held: [BUTTONS.BACK] })]);
  env.listeners.get('gamepadconnected')({ gamepad: {} });
  assert.deepEqual(hints, [CONNECTED_HINT_MS]);
  assert.equal(registered[0].read(1 / 60).toggleMode, true);
  mode = 'spectator';
  assert.equal(registered[0].read(1 / 60), null);
  assert.equal(source.connected(), true);
  detach();
  assert.equal(removed, 1);
  assert.equal(env.listeners.size, 0);
});
