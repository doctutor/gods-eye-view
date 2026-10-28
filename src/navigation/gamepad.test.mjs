// Personal fork: the gamepad for Walk and Fly (src/navigation/gamepad.js):
// a pad's snapshot to the binding's intents (dead zone, tilt, look curve,
// held buttons, presses that act once, the sprint latch), the settings
// section,
// the source's connection handling (nothing polled while off), and its
// attachment to the store and an input-source registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUTTONS,
  CONNECTED_HINT_MS,
  GAMEPAD_DEFAULTS,
  GAMEPAD_SECTION,
  LOOK_PX_PER_S,
  applySpectatorPad,
  attachGamepad,
  createGamepadSource,
  deadZoned,
  gamepadIntents,
  gamepadSettings,
  idleState,
  snapshotOf,
} from './gamepad.js';
import { createNavSettings } from './settings.js';
import * as Cesium from 'cesium';

/** A Storage in memory, and what was kept in it. */
function memoryStorage() {
  const kept = new Map();
  return {
    kept,
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => kept.set(key, String(value)),
    removeItem: (key) => kept.delete(key),
  };
}

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

test("settings: whole and in range; the source follows the card's Gamepad section, kept under gev.nav.gamepad", () => {
  assert.deepEqual(gamepadSettings(), { ...GAMEPAD_DEFAULTS });
  assert.deepEqual(
    gamepadSettings({ deadZone: 0.9, sensitivity: 9, invertY: 'true' }),
    { deadZone: 0.5, sensitivity: 3, invertX: false, invertY: true },
  );
  assert.equal(gamepadSettings({ sensitivity: 0.1 }).sensitivity, 0.5);
  assert.equal(gamepadSettings({ deadZone: 'x' }).deadZone, 0.15);
  assert.equal(gamepadSettings({ deadZone: '' }).deadZone, 0.15);
  // The section's rows: the defaults and ranges above.
  assert.deepEqual(
    GAMEPAD_SECTION.rows.map((row) => row.key),
    ['deadZone', 'sensitivity', 'invertX', 'invertY'],
  );
  const storage = memoryStorage();
  const section = createNavSettings({ storage }).registerSection(
    GAMEPAD_SECTION,
  );
  assert.deepEqual(section.get(), { ...GAMEPAD_DEFAULTS });
  const source = createGamepadSource({
    section,
    hint: () => {},
    windowRef: null,
    navigatorRef: null,
    getMode: () => 'walk',
  });
  assert.deepEqual(source.getSettings(), { ...GAMEPAD_DEFAULTS });
  section.set({ sensitivity: 2, invertX: true, deadZone: 0.9 });
  assert.deepEqual(source.getSettings(), {
    deadZone: 0.5,
    sensitivity: 2,
    invertX: true,
    invertY: false,
  });
  assert.deepEqual(JSON.parse(storage.kept.get('gev.nav.gamepad')), {
    deadZone: 0.5,
    sensitivity: 2,
    invertX: true,
    invertY: false,
  });
  // Kept: a new page's section starts from them.
  const again = createNavSettings({ storage }).registerSection(GAMEPAD_SECTION);
  assert.equal(again.get().sensitivity, 2);
  // Gone after destroy: the source no longer follows.
  source.destroy();
  section.set({ sensitivity: 1 });
  assert.equal(source.getSettings().sensitivity, 2);
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

test('the source: nothing polled with no pad; a connected pad reads in each mode, with a hint', () => {
  const env = fakeEnvironment();
  let mode = 'spectator';
  const hints = [];
  const source = createGamepadSource({
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    getMode: () => mode,
    hint: (text, ms) => hints.push([text, ms]),
  });
  const pollsAtStart = env.polls(); // one look at start, for a pad already in hand
  assert.equal(source.connected(), false);
  assert.equal(source.read(1 / 60), null); // Spectator, no pad
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
  // Spectator: the camera's block, A (still held) not a fresh walkHere.
  mode = 'spectator';
  const spectator = source.read(1 / 60);
  assert.equal(spectator.spectator.panY, 1);
  assert.equal(spectator.walkHere, false);
  assert.equal(spectator.forward, undefined);
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

test("the source: the look follows the section's sensitivity and inversion, nothing compounded", () => {
  const env = fakeEnvironment();
  env.setPads([pad({ axes: [0, 0, 1, 1] })]);
  const section = createNavSettings({
    storage: memoryStorage(),
  }).registerSection(GAMEPAD_SECTION);
  const source = createGamepadSource({
    section,
    hint: () => {},
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
    getMode: () => 'fly',
  });
  const dt = 1 / 60;
  const plain = source.read(dt);
  assert.ok(plain.lookDx > 0 && plain.lookDy > 0);
  assert.ok(plain.lookDx < LOOK_PX_PER_S * dt);
  section.set({ sensitivity: 2, invertX: true, invertY: true });
  const turned = source.read(dt);
  assert.ok(Math.abs(turned.lookDx + 2 * plain.lookDx) < 1e-9);
  assert.ok(Math.abs(turned.lookDy + 2 * plain.lookDy) < 1e-9);
  source.destroy();
});

test('attachGamepad: the Gamepad section on the card, a source registered while a pad is connected, the hint; detach undoes them', () => {
  const env = fakeEnvironment();
  let mode = 'walk';
  const store = { get: () => mode };
  const registered = new Set();
  const hints = [];
  const settings = createNavSettings({ storage: memoryStorage() });
  const { source, section, detach } = attachGamepad({
    addSource: (entry) => {
      registered.add(entry);
      return () => registered.delete(entry);
    },
    store,
    settings,
    hint: (text, ms) => hints.push(ms),
    windowRef: env.windowRef,
    navigatorRef: env.navigatorRef,
  });
  assert.deepEqual(
    settings.sections().map((entry) => entry.id),
    ['gamepad'],
  );
  assert.equal(section.title, GAMEPAD_SECTION.title);
  // No pad: no source, so the binding polls nothing in Spectator.
  assert.equal(registered.size, 0);
  env.setPads([pad({ held: [BUTTONS.BACK] })]);
  env.listeners.get('gamepadconnected')({ gamepad: {} });
  assert.deepEqual(hints, [CONNECTED_HINT_MS]);
  assert.equal(registered.size, 1);
  const [entry] = registered;
  assert.equal(entry.id, 'gamepad');
  assert.equal(typeof entry.reset, 'function');
  assert.equal(entry.read(1 / 60).toggleMode, true);
  mode = 'spectator';
  assert.deepEqual(Object.keys(entry.read(1 / 60).spectator), [
    'panX',
    'panY',
    'orbitYaw',
    'orbitPitch',
    'zoom',
  ]);
  // The last pad gone: the source out; back: in again.
  env.listeners.get('gamepaddisconnected')({ gamepad: {} });
  assert.equal(registered.size, 0);
  env.listeners.get('gamepadconnected')({ gamepad: {} });
  assert.equal(registered.size, 1);
  assert.equal(source.connected(), true);
  detach();
  assert.equal(registered.size, 0);
  assert.equal(env.listeners.size, 0);
  assert.deepEqual(settings.sections(), []);
  // A pad already in hand at load: registered at once.
  const early = fakeEnvironment();
  early.setPads([pad()]);
  const added = [];
  attachGamepad({
    addSource: (one) => added.push(one),
    store,
    settings,
    hint: () => {},
    windowRef: early.windowRef,
    navigatorRef: early.navigatorRef,
  }).detach();
  assert.equal(added.length, 1);
});

test('Spectator: the left stick pans, the right orbits (curved, sensitivity, inversion), the triggers zoom; A walks here once; Start, Back and the D-pad do nothing', () => {
  const spectator = (snapshot, options = {}) =>
    gamepadIntents(snapshot, { mode: 'spectator', dt: 1 / 60, ...options });
  // At rest: a block of zeros, no walkHere.
  assert.deepEqual(spectator(pad()).intents, {
    walkHere: false,
    spectator: { panX: 0, panY: 0, orbitYaw: 0, orbitPitch: 0, zoom: 0 },
  });
  // Left stick up and right: pan forward and right, the tilt kept.
  const pan = spectator(pad({ axes: [1, -1, 0, 0] })).intents.spectator;
  assert.ok(Math.abs(pan.panX - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(pan.panY - Math.SQRT1_2) < 1e-9);
  // Right stick: the look curve, the sensitivity, the inversion.
  const half = deadZoned(0.6, 0).magnitude;
  const orbit = spectator(pad({ axes: [0, 0, 0.6, 0] })).intents.spectator;
  assert.ok(Math.abs(orbit.orbitYaw - half ** 2) < 1e-9);
  const down = spectator(pad({ axes: [0, 0, 0, 1] }), {
    settings: { sensitivity: 2, invertY: true },
  }).intents.spectator;
  assert.equal(down.orbitPitch, -2);
  // Triggers past the dead zone: RT in, LT out.
  const zoomIn = spectator(pad({ values: { [BUTTONS.RT]: 1 } })).intents;
  assert.equal(zoomIn.spectator.zoom, 1);
  const both = spectator(
    pad({ values: { [BUTTONS.RT]: 0.1, [BUTTONS.LT]: 0.575 } }),
  ).intents.spectator;
  assert.ok(Math.abs(both.zoom + 0.5) < 1e-9); // RT inside the dead zone
  // A walks here on the press frame; the rest are nothing here.
  const pressed = spectator(
    pad({ held: [BUTTONS.A, BUTTONS.START, BUTTONS.BACK, BUTTONS.RIGHT] }),
  );
  assert.equal(pressed.intents.walkHere, true);
  assert.equal(pressed.intents.release, undefined);
  assert.equal(pressed.intents.toggleMode, undefined);
  assert.equal(pressed.intents.flySpeedStep, undefined);
  const held = spectator(pad({ held: [BUTTONS.A] }), { state: pressed.state });
  assert.equal(held.intents.walkHere, false);
});

/**
 * A viewer around a real Cesium camera over Paris, `heightM` above the
 * ellipsoid, looking north at `pitchDeg`; the ground under the crosshair
 * the ellipsoid's (no globe, no pickPosition).
 */
function cameraViewer({ heightM = 1000, pitchDeg = -45 } = {}) {
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    mapProjection: new Cesium.GeographicProjection(),
    tweens: new Cesium.TweenCollection(),
    screenSpaceCameraController: {},
    mode: Cesium.SceneMode.SCENE3D,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    pickPositionSupported: false,
    renders: 0,
    requestRender() {
      this.renders++;
    },
  };
  const camera = new Cesium.Camera(scene);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(2.35, 48.85, heightM),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  });
  return { scene, camera };
}

const where = (camera) => {
  const carto = camera.positionCartographic;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
    heightM: carto.height,
    headingDeg: Cesium.Math.toDegrees(camera.heading),
    pitchDeg: Cesium.Math.toDegrees(camera.pitch),
  };
};
const M_PER_DEG_LAT = 111_200;
/** Two places from `where` the same, within float noise. */
const assertSame = (actual, expected) => {
  for (const key of Object.keys(expected))
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, key);
};
const block = (patch) => ({
  panX: 0,
  panY: 0,
  orbitYaw: 0,
  orbitPitch: 0,
  zoom: 0,
  ...patch,
});

test('applySpectatorPad: nothing at rest; the pan level over the ground, a screen a second at the height above the surface', () => {
  const ground = { surfaceHeightM: () => 0 };
  const viewer = cameraViewer();
  const before = where(viewer.camera);
  assert.equal(applySpectatorPad(viewer, block({}), 1 / 60), false);
  assert.equal(applySpectatorPad(viewer, null, 1 / 60), false);
  assert.equal(applySpectatorPad(viewer, block({ panY: 1 }), 0), false);
  assertSame(where(viewer.camera), before);
  assert.equal(viewer.scene.renders, 0);
  // A full stick forward for half a second: half a screen north, level.
  const screenM = 2 * 1000 * Math.tan(viewer.camera.frustum.fov / 2);
  assert.equal(
    applySpectatorPad(viewer, block({ panY: 1 }), 0.5, ground),
    true,
  );
  const north = where(viewer.camera);
  const movedM = (north.lat - before.lat) * M_PER_DEG_LAT;
  assert.ok(Math.abs(movedM - screenM / 2) < screenM * 0.01, `${movedM}`);
  assert.ok(Math.abs(north.heightM - 1000) < 1);
  assert.ok(Math.abs(north.pitchDeg - before.pitchDeg) < 0.1);
  assert.equal(viewer.scene.renders, 1);
  // Right: east, not north.
  applySpectatorPad(viewer, block({ panX: 1 }), 0.5, ground);
  const east = where(viewer.camera);
  assert.ok(east.lon > north.lon);
  assert.ok(Math.abs(east.lat - north.lat) * M_PER_DEG_LAT < 1);
  // The height above the surface sets the scale: 600 m over 400 m ground.
  const high = cameraViewer();
  applySpectatorPad(high, block({ panY: 1 }), 0.5, {
    surfaceHeightM: () => 400,
  });
  const highM = (where(high.camera).lat - before.lat) * M_PER_DEG_LAT;
  assert.ok(Math.abs(highM / movedM - 0.6) < 0.01, `${highM / movedM}`);
  // Looking straight down, the view's up is forward.
  const down = cameraViewer({ pitchDeg: -90 });
  applySpectatorPad(down, block({ panY: 1 }), 0.5, ground);
  assert.ok(where(down.camera).lat > before.lat);
});

test('applySpectatorPad: the orbit turns about the ground under the crosshair, its pitch clamped; the zoom keeps above the surface', () => {
  const ground = { surfaceHeightM: () => 0 };
  const viewer = cameraViewer();
  const pivot = viewer.camera.pickEllipsoid(new Cesium.Cartesian2(400, 300));
  const range = () => Cesium.Cartesian3.distance(viewer.camera.position, pivot);
  const startRange = range();
  const before = where(viewer.camera);
  // A right push: the view turns right, the camera keeps its distance.
  applySpectatorPad(viewer, block({ orbitYaw: 1 }), 0.1, ground);
  const turned = where(viewer.camera);
  assert.ok(
    turned.headingDeg > 0 && turned.headingDeg < 20,
    `${turned.headingDeg}`,
  );
  assert.ok(Math.abs(range() - startRange) < 1);
  // A push down: steeper, the camera higher over the point.
  applySpectatorPad(viewer, block({ orbitPitch: 1 }), 0.1, ground);
  const steeper = where(viewer.camera);
  assert.ok(steeper.pitchDeg < before.pitchDeg - 5, `${steeper.pitchDeg}`);
  assert.ok(steeper.heightM > before.heightM);
  // Clamped: never past straight down, never level with the ground.
  const top = cameraViewer({ pitchDeg: -88 });
  applySpectatorPad(top, block({ orbitPitch: 3 }), 0.1, ground);
  assert.ok(where(top.camera).pitchDeg >= -89.5);
  const low = cameraViewer({ heightM: 50, pitchDeg: -2 });
  applySpectatorPad(low, block({ orbitPitch: -3 }), 0.1, ground);
  assert.ok(where(low.camera).pitchDeg <= -1);
  assert.ok(where(low.camera).heightM >= 2);
  // Zoom: RT in by a share of the height, LT out; never under the surface.
  const zoom = cameraViewer();
  applySpectatorPad(zoom, block({ zoom: 1 }), 0.1, ground);
  const inM = where(zoom.camera).heightM;
  assert.ok(inM < 1000 && inM > 900, `${inM}`);
  applySpectatorPad(zoom, block({ zoom: -1 }), 0.1, ground);
  assert.ok(where(zoom.camera).heightM > inM);
  const close = cameraViewer({ heightM: 3, pitchDeg: -89 });
  for (let frame = 0; frame < 60; frame++)
    applySpectatorPad(close, block({ zoom: 1 }), 0.1, ground);
  assert.ok(where(close.camera).heightM >= 2);
  // The sky under the crosshair: no orbit.
  const sky = cameraViewer({ pitchDeg: 10 });
  const skyBefore = where(sky.camera);
  applySpectatorPad(sky, block({ orbitYaw: 1 }), 0.1, ground);
  assertSame(where(sky.camera), skyBefore);
});
