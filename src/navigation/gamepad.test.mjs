// Personal fork: the gamepad for Walk and Fly (src/navigation/gamepad.js):
// a pad's snapshot to the movement's intents (dead zone, tilt, look curve,
// held buttons and presses that act once, the sprint latch), the settings,
// and the source's connection handling (nothing polled while off).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUTTONS,
  CONNECTED_HINT_MS,
  GAMEPAD_DEFAULTS,
  LOOK_DEG_PER_S,
  STORAGE_PREFIX,
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

test('the left stick moves: analog forward and right, keys past the threshold', () => {
  // Stick pushed fully up: forward at full tilt.
  let { intents } = gamepadIntents(pad({ axes: [0, -1, 0, 0] }), {
    dt: 1 / 60,
  });
  assert.ok(close(intents.move.forward, 1) && close(intents.move.magnitude, 1));
  assert.equal(intents.forward, true);
  assert.equal(intents.back, false);
  // Halfway right: the share of top speed is the tilt past the dead zone.
  ({ intents } = gamepadIntents(pad({ axes: [0.575, 0, 0, 0] })));
  assert.ok(
    close(intents.move.right, 0.5) && close(intents.move.magnitude, 0.5),
  );
  assert.equal(intents.right, true);
  // A drift inside the dead zone is nothing.
  ({ intents } = gamepadIntents(pad({ axes: [0.1, -0.1, 0, 0] })));
  assert.equal(intents.move.magnitude, 0);
  assert.equal(
    intents.forward || intents.back || intents.left || intents.right,
    false,
  );
  // A wider dead zone from the settings.
  ({ intents } = gamepadIntents(pad({ axes: [0.25, 0, 0, 0] }), {
    settings: { deadZone: 0.3 },
  }));
  assert.equal(intents.move.magnitude, 0);
});

test('the right stick looks: degrees a second by the curve, sensitivity, inversion', () => {
  const dt = 0.5;
  // Full right: 180°/s × 0.5 s.
  let { intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), { dt });
  assert.ok(close(intents.look.yawDeg, LOOK_DEG_PER_S * dt));
  assert.ok(close(intents.look.pitchDeg, 0));
  // Half tilt: the curve squares it (a quarter of the rate), so a small tilt aims finely.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0.575, 0] }), { dt }));
  assert.ok(close(intents.look.yawDeg, LOOK_DEG_PER_S * dt * 0.25));
  // Stick up looks up (the axis is −1 up).
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0, -1] }), { dt }));
  assert.ok(close(intents.look.pitchDeg, LOOK_DEG_PER_S * dt));
  // Inverted Y, and sensitivity 2.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 0, -1] }), {
    dt,
    settings: { invertY: true, sensitivity: 2 },
  }));
  assert.ok(close(intents.look.pitchDeg, -LOOK_DEG_PER_S * dt * 2));
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), {
    dt,
    settings: { invertX: true },
  }));
  assert.ok(close(intents.look.yawDeg, -LOOK_DEG_PER_S * dt));
  // No time, no turn.
  ({ intents } = gamepadIntents(pad({ axes: [0, 0, 1, 0] }), { dt: 0 }));
  assert.equal(intents.look.yawDeg, 0);
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
  assert.equal(frame(pad({ held: [BUTTONS.START] })).release, true); // pressed again
  assert.equal(frame(pad({ held: [BUTTONS.BACK] })).toggleMode, true);
  assert.equal(frame(pad({ held: [BUTTONS.BACK] })).toggleMode, false);
  assert.equal(frame(pad({ held: [BUTTONS.RIGHT] })).flySpeedStep, 1);
  assert.equal(frame(pad({ held: [BUTTONS.RIGHT] })).flySpeedStep, 0);
  assert.equal(frame(pad({ held: [BUTTONS.LEFT] })).flySpeedStep, -1);
  // Both at once cancel.
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
  assert.equal(frame(pad({ axes: forward })).sprint, true); // released, still sprinting
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
    {
      deadZone: 0.5,
      sensitivity: 3,
      invertX: false,
      invertY: true,
    },
  );
  assert.equal(gamepadSettings({ sensitivity: 0.1 }).sensitivity, 0.5);
  assert.equal(gamepadSettings({ deadZone: 'x' }).deadZone, 0.15);
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
  // A storage that throws: the defaults.
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
  // Spectator: nothing, and the pad is not polled.
  assert.equal(source.read(1 / 60), null);
  mode = 'walk';
  // Walk, no pad: nothing, not polled.
  assert.equal(source.read(1 / 60), null);
  assert.equal(env.polls(), pollsAtStart);
  // A pad connects: the keys hint says so for 3 s.
  env.setPads([pad({ axes: [0, -1, 0, 0], held: [BUTTONS.A] })]);
  env.listeners.get('gamepadconnected')({ gamepad: {} });
  assert.equal(source.connected(), true);
  assert.equal(hints.length, 1);
  assert.equal(hints[0][1], CONNECTED_HINT_MS);
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
  // Fly reads Fly's intents.
  mode = 'fly';
  assert.equal(source.read(1 / 60).up, true);
  // Disconnected: nothing.
  env.listeners.get('gamepaddisconnected')({ gamepad: {} });
  assert.equal(source.connected(), false);
  assert.equal(source.read(1 / 60), null);
  source.destroy();
  assert.equal(env.listeners.size, 0);
});

test('the source: a pad already connected when the page loads counts', () => {
  const env = fakeEnvironment();
  env.setPads([pad({ axes: [0, 0, 1, 0] }), null]);
  const source = createGamepadSource({
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    storage: null,
    getMode: () => 'fly',
  });
  assert.equal(source.connected(), true);
  assert.ok(source.read(0.5).look.yawDeg > 0);
  // A held press when a pad (re)connects does not act at once twice.
  const snapshot = snapshotOf(pad({ held: [BUTTONS.START] }));
  assert.equal(snapshot.buttons[BUTTONS.START].pressed, true);
  assert.equal(
    snapshotOf({ buttons: [1, 0], axes: [0.5] }).buttons[0].pressed,
    true,
  );
});
