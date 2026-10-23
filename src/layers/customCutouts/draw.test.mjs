// Personal fork: drawing a Custom cutout. The draw state machine (add, undo,
// finish by Enter or on the first corner, cancel, fewer than 3 corners and
// crossings refused, the cap), and the scene input against stubs: the
// camera gives up the left drag while drawing, and the pointer, the stock
// clicks, the key listener, the preview and the camera's lists all come
// back on every way out. A click is the press and the release on the map,
// within CLICK_TOLERANCE_PX: still or wobbling it adds one corner, a drag
// none.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDrawState } from './drawState.js';
import {
  CAMERA_EVENT_PROPERTIES,
  CLICK_TOLERANCE_PX,
  createCutoutDrawer,
  drawCameraEventTypes,
} from './drawInput.js';
import { createCustomCutoutsLayer } from './index.js';
import { createCutoutStore, decodeCutoutsParam } from './store.js';
import {
  DRAW_MAX_VERTICES,
  MAX_CUTOUTS,
  decodeDrawnRing,
} from '../../data/customCutouts.js';
import {
  claimPointer,
  isPointerFree,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';

beforeEach(() => resetPointerOwnership());

// Screen pixels and degrees, one way and back: 1 px = 1e-5°.
const LON0 = -76.6;
const LAT0 = 39.3;
const toPoint = (x, y) => ({
  lon: LON0 + x * 1e-5,
  lat: LAT0 - y * 1e-5,
  height: 12,
});

const CAMERA = Object.freeze({
  LEFT_DRAG: 0,
  RIGHT_DRAG: 1,
  MIDDLE_DRAG: 2,
  WHEEL: 3,
  PINCH: 4,
});

function fakeCesium() {
  const handlers = [];
  class ScreenSpaceEventHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(action, type) {
      this.actions.set(type, action);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class PolylineCollection {
    constructor() {
      this.lines = [];
    }
    add(line) {
      const made = { ...line };
      this.lines.push(made);
      return made;
    }
  }
  class PointPrimitiveCollection {
    constructor() {
      this.points = [];
    }
    add(point) {
      this.points.push(point);
    }
    removeAll() {
      this.points = [];
    }
  }
  return {
    handlers,
    CameraEventType: CAMERA,
    ScreenSpaceEventType: {
      LEFT_DOWN: 'left-down',
      LEFT_UP: 'left-up',
      LEFT_CLICK: 'left-click',
      LEFT_DOUBLE_CLICK: 'left-double-click',
      MOUSE_MOVE: 'mouse-move',
    },
    ScreenSpaceEventHandler,
    PolylineCollection,
    PointPrimitiveCollection,
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    SceneTransforms: {
      worldToWindowCoordinates: (scene, { lon, lat }) => ({
        x: (lon - LON0) / 1e-5,
        y: (LAT0 - lat) / 1e-5,
      }),
    },
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
    Color: class {
      static WHITE = 'white';
      static BLACK = 'black';
      static YELLOW = 'yellow';
      constructor(...rgba) {
        this.rgba = rgba;
      }
    },
  };
}

function fakeViewer() {
  const stockClick = () => 'select';
  const stockDouble = () => 'track';
  const stockActions = new Map([
    ['left-click', stockClick],
    ['left-double-click', stockDouble],
  ]);
  const camera = {
    rotateEventTypes: CAMERA.LEFT_DRAG,
    translateEventTypes: CAMERA.LEFT_DRAG,
    zoomEventTypes: [CAMERA.RIGHT_DRAG, CAMERA.WHEEL, CAMERA.PINCH],
    tiltEventTypes: [
      CAMERA.MIDDLE_DRAG,
      CAMERA.PINCH,
      { eventType: CAMERA.LEFT_DRAG, modifier: 'ctrl' },
      { eventType: CAMERA.RIGHT_DRAG, modifier: 'ctrl' },
    ],
    lookEventTypes: { eventType: CAMERA.LEFT_DRAG, modifier: 'shift' },
  };
  const original = Object.fromEntries(
    CAMERA_EVENT_PROPERTIES.map((key) => [key, camera[key]]),
  );
  const primitives = [];
  return {
    original,
    stockClick,
    stockDouble,
    scene: {
      canvas: { clientWidth: 1000, clientHeight: 1000 },
      screenSpaceCameraController: camera,
      primitives: {
        list: primitives,
        add: (p) => primitives.push(p),
        remove: (p) => primitives.splice(primitives.indexOf(p), 1),
      },
      requestRender() {},
    },
    screenSpaceEventHandler: {
      getInputAction: (type) => stockActions.get(type),
      removeInputAction: (type) => stockActions.delete(type),
      setInputAction: (action, type) => stockActions.set(type, action),
      actions: stockActions,
    },
  };
}

/**
 * The left button on a stub handler as Cesium's own handler fires it: down
 * (only for a press on the canvas), up, then LEFT_CLICK when the two are
 * within its 5 px, each with an event object it reuses.
 */
function leftButton(handler) {
  const event = { position: { x: 0, y: 0 } };
  const fire = (type, x, y) => {
    event.position.x = x;
    event.position.y = y;
    handler().actions.get(type)?.(event);
  };
  let down = null;
  return {
    down(x, y) {
      down = { x, y };
      fire('left-down', x, y);
    },
    up(x, y) {
      // Cesium fires nothing on release without its own press.
      if (!down) return;
      const moved = Math.hypot(x - down.x, y - down.y);
      down = null;
      fire('left-up', x, y);
      if (moved <= 5) fire('left-click', x, y);
    },
    /** A press released `dx` px to the right. */
    click(x, y, dx = 0) {
      this.down(x, y);
      this.up(x + dx, y);
    },
  };
}

/** A drawer on stubs, with helpers to click, move and press keys. */
function fixture({ onFinish = () => {} } = {}) {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const keyListeners = [];
  const doc = {
    addEventListener: (type, fn, capture) =>
      keyListeners.push({ type, fn, capture }),
    removeEventListener: (type, fn, capture) => {
      const at = keyListeners.findIndex(
        (l) => l.type === type && l.fn === fn && l.capture === capture,
      );
      if (at >= 0) keyListeners.splice(at, 1);
    },
  };
  const finished = [];
  const drawer = createCutoutDrawer({
    viewer,
    cesium,
    doc,
    pick: (target, nx, ny) => toPoint(nx * 1000, ny * 1000),
    onFinish: (key) => {
      finished.push(key);
      onFinish(key);
    },
  });
  const handler = () => cesium.handlers.at(-1);
  const button = leftButton(handler);
  const click = (x, y, dx = 0) => button.click(x, y, dx);
  const move = (x, y) =>
    handler().actions.get('mouse-move')({ endPosition: { x, y } });
  const press = (key, target = { tagName: 'CANVAS' }) => {
    let prevented = false;
    for (const listener of [...keyListeners])
      listener.fn({ key, target, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return {
    cesium,
    viewer,
    drawer,
    finished,
    keyListeners,
    click,
    button,
    move,
    press,
    handler,
  };
}

/** Everything the drawer borrowed is back exactly as it was. */
function assertRestored(f, label) {
  const camera = f.viewer.scene.screenSpaceCameraController;
  for (const key of CAMERA_EVENT_PROPERTIES)
    assert.equal(camera[key], f.viewer.original[key], `${label}: ${key}`);
  assert.equal(
    f.viewer.screenSpaceEventHandler.actions.get('left-click'),
    f.viewer.stockClick,
    `${label}: the stock click`,
  );
  assert.equal(
    f.viewer.screenSpaceEventHandler.actions.get('left-double-click'),
    f.viewer.stockDouble,
    `${label}: the stock double click`,
  );
  assert.ok(
    f.cesium.handlers.every((h) => h.destroyed),
    `${label}: the handler`,
  );
  assert.equal(f.keyListeners.length, 0, `${label}: the key listener`);
  assert.equal(f.viewer.scene.primitives.list.length, 0, `${label}: preview`);
  assert.equal(isPointerFree(), true, `${label}: the pointer`);
  assert.equal(f.drawer.view().drawing, false, `${label}: not drawing`);
}

// ── The state machine ─────────────────────────────────────────────────

test('the state machine: corners added, undone, finished; the key holds the ring', () => {
  const state = createDrawState();
  assert.equal(state.click(toPoint(0, 0)).result, 'added');
  assert.equal(state.click(toPoint(0, 0)).result, 'ignored', 'one spot once');
  assert.equal(state.click(toPoint(100, 0)).result, 'added');
  assert.equal(state.click(toPoint(150, 150)).result, 'added');
  assert.equal(state.view().count, 3);
  assert.equal(state.undo(), true);
  assert.equal(state.view().count, 2);
  assert.deepEqual(state.finish(), { done: false, reason: 'too-few' });
  assert.equal(state.view().reason, 'too-few');
  state.click(toPoint(100, 100));
  state.click(toPoint(0, 100));
  const done = state.finish();
  assert.equal(done.done, true);
  assert.match(done.key, /^draw:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeDrawnRing(done.key), done.ring);
  assert.equal(done.ring.length, 4);
  assert.equal(state.view().status, 'finished');
  assert.equal(state.click(toPoint(5, 5)).result, 'ignored', 'closed');
  assert.equal(state.undo(), false);
});

test('the state machine: a click on the first corner closes the ring, from 3 corners', () => {
  const state = createDrawState();
  state.click(toPoint(0, 0));
  state.click(toPoint(100, 0));
  assert.deepEqual(state.click(null, { nearFirst: true }), {
    result: 'refused',
    reason: 'too-few',
  });
  state.click(toPoint(50, 80));
  const closed = state.click(null, { nearFirst: true });
  assert.equal(closed.result, 'finished');
  assert.equal(decodeDrawnRing(closed.key).length, 3);
});

test('the state machine: a crossing corner and a crossing close are refused; cancel drops it', () => {
  const state = createDrawState();
  state.click(toPoint(0, 0));
  state.click(toPoint(100, 0));
  state.click(toPoint(100, 100));
  // Back across the first edge.
  assert.deepEqual(state.click(toPoint(50, -50)), {
    result: 'refused',
    reason: 'crosses',
  });
  assert.equal(state.view().count, 3, 'not added');
  // A bow tie: the closing edge crosses the second one.
  state.click(toPoint(200, 50));
  assert.equal(state.view().count, 4);
  assert.deepEqual(state.finish(), { done: false, reason: 'crosses' });
  state.cancel();
  assert.equal(state.view().status, 'cancelled');
  assert.equal(state.view().count, 0);
  assert.equal(state.finish().done, false);
});

test('the state machine: the cap is said when reached, and holds', () => {
  const state = createDrawState({ max: 5 });
  // Corners on a convex arc never cross.
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI * i) / 6;
    assert.equal(
      state.click(toPoint(500 * Math.cos(a), 500 * Math.sin(a))).result,
      'added',
    );
  }
  assert.equal(state.view().reason, 'cap');
  assert.deepEqual(state.click(toPoint(-300, 300)), {
    result: 'refused',
    reason: 'cap',
  });
  assert.equal(state.finish().done, true);
  assert.equal(createDrawState().view().max, DRAW_MAX_VERTICES);
});

// ── The camera's lists ────────────────────────────────────────────────

test('draw mode takes the left drag from every camera list and pans on the right drag', () => {
  const { original } = fakeViewer();
  const types = drawCameraEventTypes(original, CAMERA);
  const kinds = (value) =>
    [value].flat().map((e) => (typeof e === 'object' ? e.eventType : e));
  for (const key of CAMERA_EVENT_PROPERTIES)
    assert.ok(!kinds(types[key]).includes(CAMERA.LEFT_DRAG), key);
  assert.deepEqual(types.rotateEventTypes, [CAMERA.RIGHT_DRAG]);
  assert.deepEqual(types.translateEventTypes, [CAMERA.RIGHT_DRAG]);
  assert.deepEqual(types.zoomEventTypes, [CAMERA.WHEEL, CAMERA.PINCH]);
  assert.ok(types.tiltEventTypes.includes(CAMERA.MIDDLE_DRAG));
  assert.deepEqual(types.lookEventTypes, []);
});

// ── The scene input ───────────────────────────────────────────────────

test('drawing on the scene: clicks pick corners, the camera is remapped, Enter finishes and everything comes back', () => {
  const f = fixture();
  assert.deepEqual(f.drawer.start(), { ok: true });
  const camera = f.viewer.scene.screenSpaceCameraController;
  assert.deepEqual(camera.rotateEventTypes, [CAMERA.RIGHT_DRAG]);
  assert.equal(isPointerFree(), false, 'the pointer is held');
  assert.equal(
    f.viewer.screenSpaceEventHandler.actions.has('left-click'),
    false,
    'no entity is selected by a corner',
  );
  assert.equal(f.keyListeners[0].capture, true);
  f.click(0, 0);
  f.click(100, 0);
  f.move(100, 100);
  const [lines, dots] = f.viewer.scene.primitives.list;
  assert.equal(lines.line.positions.length, 3, 'two corners and the cursor');
  assert.equal(dots.points.length, 2);
  assert.equal(dots.points[0].pixelSize > dots.points[1].pixelSize, true);
  assert.equal(dots.points[0].position.height, 12, 'on the picked surface');
  f.click(100, 100);
  assert.equal(f.drawer.view().count, 3);
  assert.equal(f.press('Backspace'), true);
  assert.equal(f.drawer.view().count, 2);
  f.press('Backspace', { tagName: 'INPUT' });
  assert.equal(f.drawer.view().count, 2, 'not while typing a name');
  f.click(100, 100);
  f.click(0, 100);
  assert.equal(f.press('Enter'), true);
  assert.equal(f.finished.length, 1);
  assert.equal(decodeDrawnRing(f.finished[0]).length, 4);
  assertRestored(f, 'Enter');
});

test('every way out restores the camera, the clicks, the keys and the pointer', () => {
  const ways = {
    'FINISH button': (f) => f.drawer.finish(),
    'first-corner click': (f) => f.click(3, 4),
    Escape: (f) => f.press('Escape'),
    'Escape while typing': (f) => f.press('Escape', { tagName: 'INPUT' }),
    'CANCEL button': (f) => f.drawer.cancel(),
    'layer off': (f) => f.drawer.stop(),
  };
  for (const [label, leave] of Object.entries(ways)) {
    resetPointerOwnership();
    const f = fixture();
    f.drawer.start();
    f.click(0, 0);
    f.click(100, 0);
    f.click(100, 100);
    leave(f);
    assertRestored(f, label);
    const finishing = label === 'FINISH button' || label.startsWith('first');
    assert.equal(f.finished.length, finishing ? 1 : 0, `${label}: added`);
    f.drawer.stop();
    assertRestored(f, `${label}, stopped again`);
  }
});

test('a refused finish keeps drawing; a second start is a no-op; a held pointer refuses to start', () => {
  const f = fixture();
  f.drawer.start();
  f.drawer.start();
  assert.equal(f.cesium.handlers.length, 1, 'one handler');
  f.click(0, 0);
  f.click(100, 0);
  assert.equal(f.press('Enter'), true);
  assert.equal(f.drawer.view().drawing, true, 'still drawing');
  assert.equal(f.drawer.view().reason, 'too-few');
  f.drawer.cancel();
  assertRestored(f, 'cancel');

  const lease = claimPointer('draw');
  const g = fixture();
  assert.deepEqual(g.drawer.start(), { ok: false, reason: 'pointer' });
  assert.equal(g.drawer.view().reason, 'pointer');
  const camera = g.viewer.scene.screenSpaceCameraController;
  for (const key of CAMERA_EVENT_PROPERTIES)
    assert.equal(camera[key], g.viewer.original[key], 'never half-started');
  assert.equal(g.cesium.handlers.length, 0);
  releasePointer(lease);
});

// ── The click: press and release on the map ──────────────────────────

test('a click is the press and the release: 0 px and an 8 px wobble add a corner, once; a 20 px drag adds none and says nothing', () => {
  const f = fixture();
  let changes = 0;
  const drawer = createCutoutDrawer({
    viewer: f.viewer,
    cesium: f.cesium,
    doc: { addEventListener() {}, removeEventListener() {} },
    pick: (target, nx, ny) => toPoint(nx * 1000, ny * 1000),
    onChange: () => changes++,
  });
  drawer.start();
  const handler = f.handler();
  assert.equal(handler.actions.has('left-click'), false, 'no click of its own');
  const button = leftButton(() => handler);

  // 0 px: Cesium fires LEFT_UP and its LEFT_CLICK; one corner.
  button.click(100, 100);
  assert.equal(drawer.view().count, 1, 'a still click: one corner');
  // 8 px: Cesium's LEFT_CLICK would drop it; the corner still comes.
  button.click(300, 100, 8);
  assert.equal(drawer.view().count, 2, 'an 8 px wobble: one corner');
  const corners = drawer._state().state.view().corners;
  assert.deepEqual(
    [corners[1].lon, corners[1].lat],
    [toPoint(300, 100).lon, toPoint(300, 100).lat].map(
      (d) => Math.round(d * 1e6) / 1e6,
    ),
    'where the button went down',
  );
  // CLICK_TOLERANCE_PX is the edge: 12 px still counts.
  button.click(300, 300, CLICK_TOLERANCE_PX);
  assert.equal(drawer.view().count, 3);
  drawer.undo();

  // 20 px: a drag; nothing added, the status untouched.
  const before = { ...drawer.view() };
  const heard = changes;
  button.click(300, 300, 20);
  assert.deepEqual(drawer.view(), before, 'a drag adds nothing');
  assert.equal(changes, heard, 'and says nothing');

  // A press that began on the panel, released on the map: no LEFT_DOWN on
  // the canvas, so nothing. Even a stray LEFT_UP alone adds nothing.
  handler.actions.get('left-up')({ position: { x: 500, y: 500 } });
  assert.deepEqual(drawer.view(), before, 'no press on the map, no corner');
  drawer.stop();
});

test('the first-corner click finishes once; a stray LEFT_CLICK after it adds nothing', () => {
  const f = fixture();
  f.drawer.start();
  const handler = f.handler();
  f.click(0, 0);
  f.click(100, 0, 4);
  f.click(100, 100, 7);
  assert.equal(f.drawer.view().count, 3);
  // 3 px from the first corner, released 3 px off: Cesium fires LEFT_UP
  // and then its own LEFT_CLICK; the ring closes on the first only.
  f.button.down(3, 0);
  f.button.up(3, 3);
  assert.equal(f.finished.length, 1, 'finished once');
  assert.equal(decodeDrawnRing(f.finished[0]).length, 3, 'no fourth corner');
  assertRestored(f, 'first corner by press and release');
  // Whatever Cesium still has queued reaches a handler that is gone.
  handler.actions.get('left-click')?.({ position: { x: 3, y: 0 } });
  handler.actions.get('left-up')?.({ position: { x: 3, y: 0 } });
  assert.equal(f.finished.length, 1, 'never twice');
  assert.ok(handler.destroyed);
});

test('a press held when the drawing ends is forgotten: no corner on the next start', () => {
  const f = fixture();
  f.drawer.start();
  f.click(0, 0);
  f.button.down(50, 50);
  f.drawer.cancel();
  assertRestored(f, 'cancel with the button down');
  f.drawer.start();
  // The release of the old press, on the new handler.
  f.handler().actions.get('left-up')({ position: { x: 50, y: 50 } });
  assert.equal(f.drawer.view().count, 0);
  f.drawer.stop();
});

// ── In the layer ──────────────────────────────────────────────────────

function layerFixture({ cutouts = [] } = {}) {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const keyListeners = [];
  const store = createCutoutStore({
    initial: { enabled: false, plate: 'black', cutouts },
  });
  const layer = createCustomCutoutsLayer({
    store,
    source: { cutout: async () => null, areasAt: async () => ({ areas: [] }) },
    cesium,
    clipping: {
      supported: () => true,
      apply() {},
      clear() {},
      state: () => ({}),
    },
    pickWorld: (target, nx, ny) => toPoint(nx * 1000, ny * 1000),
    createDrawer: (options) =>
      createCutoutDrawer({
        ...options,
        doc: {
          addEventListener: (type, fn) => keyListeners.push(fn),
          removeEventListener: (type, fn) =>
            keyListeners.splice(keyListeners.indexOf(fn), 1),
        },
      }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  const handler = () => cesium.handlers.at(-1);
  const button = leftButton(handler);
  const click = (x, y) => button.click(x, y);
  const square = (x) => {
    click(x, 0);
    click(x + 100, 0);
    click(x + 100, 100);
    click(x, 100);
  };
  return { cesium, viewer, store, layer, keyListeners, click, square };
}

test('in the layer: drawn outlines are added as Drawn 1 and Drawn 2, tagged, kept in the URL', () => {
  const f = layerFixture();
  assert.equal(f.layer.startDraw(), true);
  assert.equal(f.layer.view().draw.drawing, true);
  f.square(0);
  assert.equal(f.layer.view().draw.count, 4);
  assert.equal(f.layer.finishDraw().done, true);
  assert.equal(f.layer.view().draw.drawing, false);
  f.layer.startDraw();
  f.square(500);
  // Closed on its first corner.
  f.click(501, 1);
  const { cutouts } = f.store.get();
  assert.deepEqual(
    cutouts.map((c) => c.name),
    ['Drawn 1', 'Drawn 2'],
  );
  assert.equal(cutouts[0].rings[0].length, 4, 'the ring, not simplified');
  assert.equal(f.layer.view().cutouts[0].status, 'ready', 'nothing to fetch');
  // Through the URL and back: the same rings, no fetch needed.
  const back = decodeCutoutsParam(f.store.param()).cutouts;
  assert.deepEqual(
    back.map((c) => [c.source, c.name, c.rings]),
    cutouts.map((c) => [c.source, c.name, c.rings]),
  );
  // Renamed, hidden, deleted like any other.
  f.layer.rename(cutouts[0].source, 'Lot 12');
  f.layer.setVisible(cutouts[0].source, false);
  f.layer.remove(cutouts[1].source);
  assert.deepEqual(
    f.store.get().cutouts.map((c) => [c.name, c.visible]),
    [['Lot 12', false]],
  );
  // The next drawing counts on from the drawn names still listed.
  f.layer.startDraw();
  f.square(900);
  f.layer.finishDraw();
  assert.equal(f.store.get().cutouts.at(-1).name, 'Drawn 1');
});

test('in the layer: off or destroyed mid-drawing gives everything back; a full list refuses to draw', () => {
  for (const leave of ['disable', 'destroy']) {
    resetPointerOwnership();
    const f = layerFixture();
    f.layer.startDraw();
    f.click(0, 0);
    f.click(100, 0);
    f.layer[leave]();
    const camera = f.viewer.scene.screenSpaceCameraController;
    for (const key of CAMERA_EVENT_PROPERTIES)
      assert.equal(camera[key], f.viewer.original[key], `${leave}: ${key}`);
    assert.equal(isPointerFree(), true, `${leave}: the pointer`);
    assert.equal(f.keyListeners.length, 0, `${leave}: the keys`);
    assert.ok(f.cesium.handlers.every((h) => h.destroyed));
    assert.equal(
      f.viewer.screenSpaceEventHandler.actions.get('left-click'),
      f.viewer.stockClick,
    );
    assert.equal(f.store.get().cutouts.length, 0, `${leave}: nothing added`);
  }

  const full = layerFixture({
    cutouts: Array.from({ length: MAX_CUTOUTS }, (_, i) => ({
      source: `osm:${i + 1}`,
      name: `Area ${i + 1}`,
      visible: true,
      rings: [],
    })),
  });
  assert.equal(full.layer.startDraw(), false);
  assert.equal(full.layer.view().draw.reason, 'full');
  assert.equal(isPointerFree(), true);
});
