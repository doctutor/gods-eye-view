// Personal fork: the Walk and Fly controls (src/navigation/settings.js):
// the store (kept in this browser, bounds, reset), the key bindings and
// their conflicts, the fly-speed wheel and the sprint FOV widening.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_SHORTCUT_CODES,
  BOB_M,
  BOB_STEP_M,
  BOUNDS,
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  FLY_SPEED_RANGE,
  SETTINGS_KEY,
  SPRINT_FOV_DEG,
  SPRINT_FOV_RAMP_S,
  WHEEL_NOTCH_FACTOR,
  createBobber,
  createFovEaser,
  createNavSettings,
  createSneakToggle,
  flySpeedAfterSteps,
  flySpeedAfterWheel,
} from './settings.js';

const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
};

test('the defaults: Minecraft’s, 70° vertical, the speeds as before, sprint and up/down unbound', () => {
  const settings = createNavSettings({ storage: memory() }).get();
  assert.equal(settings.fovDeg, 70);
  assert.equal(settings.sensitivity, 1);
  assert.equal(settings.invertY, false);
  assert.deepEqual(
    [settings.walk, settings.sprint, settings.fly],
    [4.3, 5.6, 10.8],
  );
  assert.equal(settings.sneakMode, 'hold');
  assert.equal(settings.sprintFov, true);
  assert.equal(settings.bobbing, false);
  assert.deepEqual(settings.bindings.forward, ['KeyW', 'ArrowUp']);
  assert.deepEqual(settings.bindings.sneak, ['ShiftLeft', 'ShiftRight']);
  assert.deepEqual(settings.bindings.jump, ['Space']);
  assert.deepEqual(settings.bindings.walkHere, ['KeyG']);
  assert.deepEqual(settings.bindings.release, ['Escape']);
  for (const free of ['sprint', 'up', 'down', 'flyHere'])
    assert.deepEqual(settings.bindings[free], [], free);
  assert.equal(
    Object.values(DEFAULT_BINDINGS)
      .flat()
      .some((c) => c.startsWith('Control')),
    false,
    'no Ctrl: Ctrl+W closes the tab',
  );
});

test('kept in this browser, never the link; numbers held within their bounds; reset', () => {
  const storage = memory();
  const store = createNavSettings({ storage });
  const heard = [];
  store.subscribe((s) => heard.push(s.fovDeg));
  assert.equal(
    store.set({
      fovDeg: 90,
      sensitivity: 5,
      invertY: true,
      sneakMode: 'toggle',
    }),
    true,
  );
  assert.equal(store.set({ fovDeg: 90 }), false, 'no change, nothing said');
  let now = store.get();
  assert.equal(now.fovDeg, 90);
  assert.equal(now.sensitivity, BOUNDS.sensitivity[1], 'clamped to 2×');
  assert.equal(now.invertY, true);
  assert.equal(now.sneakMode, 'toggle');
  store.set({
    fovDeg: 5,
    fly: 500,
    walk: 'fast',
    sneakMode: 'sometimes',
    bobbing: 'yes',
  });
  now = store.get();
  assert.equal(now.fovDeg, 30);
  assert.equal(now.fly, 50);
  assert.equal(now.walk, 4.3, 'not a number: kept');
  assert.equal(now.sneakMode, 'toggle', 'not a mode: kept');
  assert.equal(now.bobbing, false, 'not a boolean: kept');
  assert.ok(JSON.parse(storage.map.get(SETTINGS_KEY)).fovDeg === 30);
  assert.equal(SETTINGS_KEY, 'gev.nav.settings');
  // A new page reads what was kept.
  assert.equal(createNavSettings({ storage }).get().fly, 50);
  // A garbled store is the defaults.
  storage.setItem(SETTINGS_KEY, '{not json');
  assert.equal(createNavSettings({ storage }).get().fovDeg, 70);
  // Reset: everything, the bindings too.
  store.bind('jump', 'KeyJ');
  store.reset();
  assert.deepEqual(store.get(), {
    ...DEFAULT_SETTINGS,
    bindings: createNavSettings({ storage: memory() }).get().bindings,
  });
  assert.equal(heard.at(-1), 70);
  // No storage at all: it still works, keeping nothing.
  const bare = createNavSettings({ storage: null });
  bare.set({ fovDeg: 80 });
  assert.equal(bare.get().fovDeg, 80);
});

test('bindings: one key an action; refused on the app’s shortcuts (but for an action’s own default) and on another action’s key', () => {
  const store = createNavSettings({ storage: memory() });
  assert.deepEqual(store.bind('sprint', 'KeyR'), { ok: true });
  assert.deepEqual(store.codesFor('sprint'), ['KeyR']);
  assert.equal(store.keyMap().KeyR, 'sprint');
  // The app's shortcut table: 1–7, h, o, v, f, d, c, Esc, `.
  for (const code of [
    'Digit1',
    'Digit7',
    'KeyH',
    'KeyO',
    'KeyV',
    'KeyF',
    'KeyC',
    'Backquote',
    'Escape',
  ])
    assert.deepEqual(
      store.check('sprint', code),
      { ok: false, reason: 'app' },
      code,
    );
  assert.deepEqual(APP_SHORTCUT_CODES.length, 15);
  // D is the app's (detection) but Walk's own default right: allowed back.
  store.bind('right', 'KeyL');
  assert.deepEqual(store.check('right', 'KeyD'), { ok: true });
  assert.deepEqual(store.check('left', 'KeyD'), { ok: false, reason: 'app' });
  // Another action's key.
  assert.deepEqual(store.bind('jump', 'KeyR'), {
    ok: false,
    reason: 'taken',
    by: 'sprint',
  });
  assert.deepEqual(store.bind('jump', 'KeyW'), {
    ok: false,
    reason: 'taken',
    by: 'forward',
  });
  // Its own key again is fine; one key an action replaces the defaults' two.
  assert.deepEqual(store.bind('forward', 'KeyW'), { ok: true });
  assert.deepEqual(store.codesFor('forward'), ['KeyW']);
  assert.equal(store.keyMap().ArrowUp, undefined);
  // Backspace clears.
  assert.equal(store.unbind('sprint'), true);
  assert.deepEqual(store.codesFor('sprint'), []);
  assert.equal(store.unbind('sprint'), false);
  // walkHere and release are not held intents: not in the key map.
  assert.equal(store.keyMap().KeyG, undefined);
  assert.equal(store.keyMap().Escape, undefined);
  assert.deepEqual(store.check('bogus', 'KeyQ'), {
    ok: false,
    reason: 'invalid',
  });
});

test('the fly-speed wheel: 1.25× a notch, up faster, on a log scale between 1 and 50 m/s', () => {
  assert.equal(WHEEL_NOTCH_FACTOR, 1.25);
  assert.deepEqual(FLY_SPEED_RANGE, [1, 50]);
  assert.ok(Math.abs(flySpeedAfterWheel(10, -100) - 12.5) < 1e-9, 'wheel up');
  assert.ok(Math.abs(flySpeedAfterWheel(10, 100) - 8) < 1e-9, 'wheel down');
  assert.ok(
    Math.abs(flySpeedAfterWheel(10, -3, 1) - 12.5) < 1e-9,
    'three lines a notch',
  );
  assert.ok(Math.abs(flySpeedAfterWheel(10, -2, 2) - 15.625) < 1e-9, 'pages');
  // Equal notches, equal ratios: a log scale.
  let speed = 1;
  const seen = [];
  for (let k = 0; k < 40; k++)
    seen.push((speed = flySpeedAfterWheel(speed, -100)));
  assert.equal(seen.at(-1), 50, 'stops at 50');
  assert.equal(flySpeedAfterWheel(1.1, 500), 1, 'stops at 1');
  assert.equal(flySpeedAfterWheel(10, 0), 10);
});

test('the sprint FOV widening: +10° over 0.2 s, back over 0.2 s', () => {
  assert.equal(SPRINT_FOV_DEG, 10);
  assert.equal(SPRINT_FOV_RAMP_S, 0.2);
  const easer = createFovEaser();
  assert.ok(Math.abs(easer.update(true, 0.1) - 5) < 1e-9, 'half way at 0.1 s');
  assert.ok(
    Math.abs(easer.update(true, 0.1) - 10) < 1e-9,
    'all of it at 0.2 s',
  );
  assert.equal(easer.update(true, 0.5), 10, 'no further');
  assert.ok(Math.abs(easer.update(false, 0.05) - 7.5) < 1e-9);
  assert.equal(easer.update(false, 0.15), 0);
  assert.equal(easer.update(false, 1), 0);
  easer.update(true, 0.1);
  easer.reset();
  assert.equal(easer.boost, 0);
});

test('fly-speed steps: a gamepad’s ±1 is a wheel notch', () => {
  assert.ok(Math.abs(flySpeedAfterSteps(10, 1) - 12.5) < 1e-9);
  assert.ok(Math.abs(flySpeedAfterSteps(10, -1) - 8) < 1e-9);
  assert.equal(flySpeedAfterSteps(49, 3), 50);
  assert.equal(flySpeedAfterSteps(1, -1), 1);
  assert.equal(flySpeedAfterSteps(10, 'x'), 10);
});

test('a section for another source: kept under gev.nav.<id>, bounded, reset with the rest', () => {
  const storage = memory();
  const store = createNavSettings({ storage });
  const heard = [];
  store.subscribe(() => heard.push('store'));
  const spec = {
    id: 'gamepad',
    title: 'Gamepad',
    rows: [
      {
        key: 'deadZone',
        label: 'Dead zone',
        type: 'range',
        min: 0,
        max: 0.5,
        step: 0.01,
        default: 0.15,
      },
      {
        key: 'sensitivity',
        label: 'Sensitivity',
        type: 'range',
        min: 0.5,
        max: 3,
        step: 0.1,
        default: 1,
      },
      { key: 'invertX', label: 'Invert X', type: 'toggle' },
      { key: 'invertY', label: 'Invert Y', type: 'toggle' },
      { key: 'bad', type: 'range', min: 2, max: 1 },
    ],
  };
  const pad = store.registerSection(spec);
  assert.deepEqual(
    store.sections().map((s) => s.id),
    ['gamepad'],
  );
  assert.deepEqual(
    pad.rows.map((r) => r.key),
    ['deadZone', 'sensitivity', 'invertX', 'invertY'],
  );
  assert.deepEqual(pad.get(), {
    deadZone: 0.15,
    sensitivity: 1,
    invertX: false,
    invertY: false,
  });
  const values = [];
  pad.subscribe((v) => values.push(v.deadZone));
  assert.equal(
    pad.set({ deadZone: 0.9, invertY: true, sensitivity: 'fast', other: 1 }),
    true,
  );
  assert.deepEqual(pad.get(), {
    deadZone: 0.5,
    sensitivity: 1,
    invertX: false,
    invertY: true,
  });
  assert.equal(pad.set({ deadZone: 0.5 }), false, 'no change');
  assert.deepEqual(values, [0.5]);
  assert.ok(heard.length >= 2, 'the card hears it');
  assert.deepEqual(JSON.parse(storage.map.get('gev.nav.gamepad')), pad.get());
  // A new page reads it back once the source registers again.
  const again = createNavSettings({ storage }).registerSection(spec);
  assert.equal(again.get().deadZone, 0.5);
  assert.equal(again.get().invertY, true);
  // Reset: the section too.
  store.reset();
  assert.deepEqual(pad.get(), {
    deadZone: 0.15,
    sensitivity: 1,
    invertX: false,
    invertY: false,
  });
  // Registering again replaces; unregister removes.
  const replaced = store.registerSection({ ...spec, title: 'Controller' });
  assert.deepEqual(
    store.sections().map((s) => s.title),
    ['Controller'],
  );
  replaced.unregister();
  assert.deepEqual(store.sections(), []);
  assert.throws(() => store.registerSection({ id: 'settings' }), TypeError);
  assert.throws(() => store.registerSection({ id: 'Bad id' }), TypeError);
});

test('the browser’s keys are never bound: Ctrl, the system key, F1–F12', () => {
  const store = createNavSettings({ storage: memory() });
  for (const code of ['ControlLeft', 'ControlRight', 'MetaLeft', 'F5', 'F12'])
    assert.deepEqual(store.check('sprint', code), {
      ok: false,
      reason: 'browser',
    });
  assert.deepEqual(store.check('sprint', 'KeyF'), { ok: false, reason: 'app' });
});

test('sneak as a toggle: a press flips it, holding changes nothing', () => {
  const toggle = createSneakToggle();
  assert.equal(toggle.update(false), false);
  assert.equal(toggle.update(true), true, 'pressed: on');
  assert.equal(toggle.update(true), true, 'held: still on');
  assert.equal(toggle.update(false), true, 'let go: still on');
  assert.equal(toggle.update(true), false, 'pressed again: off');
  assert.equal(toggle.update(false), false);
  toggle.update(true);
  toggle.reset();
  assert.equal(toggle.on, false);
});

test('view bobbing: 0.05 m at each footfall, none mid-stride, fading in and out', () => {
  assert.equal(BOB_M, 0.05);
  const bob = createBobber({ fadeS: 0.15 });
  assert.equal(bob.update(0, false, 0.016), 0, 'standing: none');
  // Walking at 4.3 m/s for 0.3 s: fully in.
  for (let k = 0; k < 30; k++) bob.update(0.043, true, 0.01);
  assert.ok(bob.offset <= 0 && bob.offset >= -BOB_M);
  // Over a stride the dip reaches the full 0.05 m and comes back to 0.
  let low = 0;
  let high = -1;
  for (let k = 0; k < 100; k++) {
    const offset = bob.update(BOB_STEP_M / 100, true, 0.01);
    low = Math.min(low, offset);
    high = Math.max(high, offset);
  }
  assert.ok(Math.abs(low + BOB_M) < 1e-3, `the footfall: ${low}`);
  assert.ok(high > -1e-3, `mid-stride: ${high}`);
  // About 2.6 footfalls a second at the walk's 4.3 m/s.
  assert.ok(Math.abs(4.3 / BOB_STEP_M - 2.58) < 0.01);
  // Stopping: gone within the fade.
  bob.update(0, false, 0.1);
  assert.equal(bob.update(0, false, 0.1), 0);
  bob.reset();
  assert.equal(bob.offset, 0);
});

test('worker3’s view and home keys: T and B by default, checked like the rest', () => {
  const store = createNavSettings({ storage: memory() });
  assert.deepEqual(store.codesFor('view'), ['KeyT']);
  assert.deepEqual(store.codesFor('home'), ['KeyB']);
  assert.deepEqual(store.check('jump', 'KeyT'), {
    ok: false,
    reason: 'taken',
    by: 'view',
  });
  assert.deepEqual(store.check('home', 'KeyH'), { ok: false, reason: 'app' });
  assert.deepEqual(store.bind('home', 'KeyN'), { ok: true });
  assert.equal(store.keyMap().KeyN, undefined, 'fired, not held');
});
