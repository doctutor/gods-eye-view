// Personal fork: elevation with the Google photoreal tiles (photoreal.js):
// the `lp` URL value, each cell's lift and its packing into the texture,
// the window's ENU frame and the vertex-to-cell mapping the shader
// mirrors, the uniforms, and the controller's lifecycle on stubs (the
// shader on and off the tileset, window moves, map switches, the relief).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFT_FRAGMENT_SHADER,
  LIFT_OFFSET_M,
  LIFT_STEP_M,
  LIFT_VERTEX_SHADER,
  RELIEF_FACTORS,
  cellLifts,
  createPhotorealController,
  createPhotorealStore,
  decodePhotorealParam,
  defaultPhotorealState,
  encodePhotorealParam,
  enuToCell,
  enuToLatLon,
  exaggerate,
  frameUniforms,
  liftFrame,
  packLifts,
  toWindowEnu,
  unexaggerate,
  unpackLift,
  worldToWindowMatrix,
} from './photoreal.js';
import { ecef } from './bricks.js';
import { brickHeightM } from './model.js';
import { photorealStatusText } from './presentation.js';

const RAD = Math.PI / 180;

function windowHeader(lat, lon, halfM, cells = 447) {
  const dLat = halfM / 6371000 / RAD;
  const dLon = dLat / Math.cos(lat * RAD);
  return {
    west: lon - dLon,
    east: lon + dLon,
    south: lat - dLat,
    north: lat + dLat,
    cols: cells,
    rows: cells,
    cellSizeM: (2 * halfM) / cells,
  };
}

test('lp: relief ×1/2/3/5 and the bricks, round-tripped; anything else is off', () => {
  assert.deepEqual(defaultPhotorealState(), { relief: 1, bricks: false });
  assert.deepEqual(RELIEF_FACTORS, [1, 2, 3, 5]);
  for (const relief of RELIEF_FACTORS)
    for (const bricks of [false, true]) {
      const value = encodePhotorealParam({ relief, bricks });
      assert.match(value, relief === 1 && !bricks ? /^$/ : /^[1235](\.b)?$/);
      assert.deepEqual(decodePhotorealParam(value), { relief, bricks });
    }
  assert.equal(encodePhotorealParam({ relief: 3, bricks: true }), '3.b');
  assert.equal(encodePhotorealParam({ relief: 4 }), '', 'not a choice: off');
  for (const junk of ['', 'x', '4', '3.c', '3b', null, '33'])
    assert.deepEqual(
      decodePhotorealParam(junk),
      defaultPhotorealState(),
      String(junk),
    );

  const store = createPhotorealStore({ initial: decodePhotorealParam('1.b') });
  assert.equal(store.linkAskedForBricks(), true, 'the link turns Lego on');
  let heard = 0;
  store.subscribe(() => heard++);
  store.setRelief(4);
  store.setRelief(1);
  store.setBricks(true);
  assert.equal(heard, 0, 'nothing changed: nothing heard');
  store.setRelief(5);
  store.setBricks(false);
  assert.equal(heard, 2);
  assert.equal(store.param(), '5');
  const params = new URLSearchParams();
  params.set('lp', store.param());
  assert.deepEqual(
    decodePhotorealParam(new URLSearchParams(params.toString()).get('lp')),
    store.get(),
  );
  assert.equal(
    createPhotorealStore({
      initial: defaultPhotorealState(),
    }).linkAskedForBricks(),
    false,
  );
});

test('a cell’s lift: the brick top less the ground the tiles draw (DEM + geoid, under the relief)', () => {
  const header = { ...windowHeader(39.29, -76.61, 5000, 4), cellSizeM: 30 };
  const brick = brickHeightM(30);
  // Population over photoreal: columns stand on their ground.
  const population = {
    layer: 'ee-population',
    header,
    columns: [
      { col: 0, row: 0, bricks: 10, baseM: 40, value: 900 },
      { col: 3, row: 2, bricks: 1, baseM: 12, value: 3 },
    ],
  };
  const lifts = cellLifts(population, { geoidM: -33 });
  assert.equal(lifts.length, 16);
  assert.ok(
    Math.abs(lifts[0] - (10 * brick + 33)) < 1e-3,
    'bricks, and the geoid',
  );
  assert.ok(Math.abs(lifts[2 * 4 + 3] - (brick + 33)) < 1e-3);
  assert.ok(Number.isNaN(lifts[1]), 'no column: not lifted');
  // Elevation's own columns rise from the ellipsoid: the lift is the top
  // less the cell's true height.
  const elevation = {
    layer: 'ee-elevation',
    header,
    columns: [{ col: 1, row: 1, bricks: 7, baseM: 0, value: 120 }],
  };
  const top = 7 * brick;
  assert.ok(Math.abs(cellLifts(elevation)[5] - (top - 120)) < 1e-3);
  // Under Relief ×3 about 50 m, the tiles draw 120 + N at (120 + N - 50)·3 + 50.
  const relief = cellLifts(elevation, {
    geoidM: -33,
    relief: 3,
    reliefHeightM: 50,
  })[5];
  assert.ok(Math.abs(relief - (top - ((120 - 33 - 50) * 3 + 50))) < 1e-3);
  assert.equal(exaggerate(100, 3, 50), 200);
  assert.equal(unexaggerate(200, 3, 50), 100);
  assert.equal(unexaggerate(200, 1, 50), 200);
  // A column off elevation with no ground under it (no elevation grid) is not lifted.
  assert.ok(
    Number.isNaN(
      cellLifts({
        ...population,
        columns: [{ col: 0, row: 0, bricks: 3, baseM: 0, value: 1 }],
      })[0],
    ),
  );
});

test('the lifts texture: RGB the lift in decimetres from -1 km, A whether lifted; round-trips', () => {
  const lifts = Float32Array.from([
    0,
    -12.34,
    456.7,
    NaN,
    -LIFT_OFFSET_M,
    35000,
    -5000,
    2e6,
  ]);
  const packed = packLifts(lifts);
  assert.equal(packed.length, lifts.length * 4);
  assert.ok(packed instanceof Uint8Array);
  assert.ok(Math.abs(unpackLift(packed, 0) - 0) < 1e-9);
  assert.ok(Math.abs(unpackLift(packed, 1) - -12.3) < 1e-6, 'to the decimetre');
  assert.ok(Math.abs(unpackLift(packed, 2) - 456.7) < 1e-6);
  assert.ok(Number.isNaN(unpackLift(packed, 3)), 'not lifted');
  assert.equal(packed[3 * 4 + 3], 0);
  assert.equal(packed[0 * 4 + 3], 255);
  assert.ok(Math.abs(unpackLift(packed, 4) - -LIFT_OFFSET_M) < 1e-6);
  assert.ok(Math.abs(unpackLift(packed, 5) - 35000) < 1e-6, 'Everest ×5 fits');
  assert.ok(
    Math.abs(unpackLift(packed, 6) - -LIFT_OFFSET_M) < 1e-6,
    'clamped below',
  );
  assert.ok(unpackLift(packed, 7) > 1.6e6, 'clamped above');
  // The shader decodes the same way.
  assert.match(
    LIFT_VERTEX_SHADER,
    /bytes\.r \* 65536\.0 \+ bytes\.g \* 256\.0 \+ bytes\.b/,
  );
  assert.match(
    LIFT_VERTEX_SHADER,
    new RegExp(`\\* ${LIFT_STEP_M.toFixed(1)} - ${LIFT_OFFSET_M.toFixed(1)}`),
  );
});

test('the ENU mapping: ground and peaks find their cell, without trig, across the window', () => {
  const cases = [
    { lat: 39.2904, lon: -76.6122, half: 5000, h: 40 }, // Baltimore at 2 km
    { lat: 39.29, lon: -76.65, half: 25000, h: 150 }, // the region at 20 km
    { lat: 46.8523, lon: -121.7603, half: 62500, h: 4000 }, // Rainier at 50 km
    { lat: -33.9, lon: 151.2, half: 62500, h: 0 }, // southern hemisphere
  ];
  for (const { lat, lon, half, h } of cases) {
    const header = windowHeader(lat, lon, half);
    const frame = liftFrame(header);
    assert.ok(
      Math.abs(frame.rn - 6.38e6) < 3e4 && Math.abs(frame.rm - 6.36e6) < 4e4,
    );
    let worst = 0;
    for (const [a, b] of [
      [0.99, 0.99],
      [-0.99, 0.99],
      [0.99, -0.99],
      [-0.99, -0.99],
      [0.5, -0.2],
      [0, 0],
    ]) {
      const pLat = lat + (b * (header.north - header.south)) / 2;
      const pLon = lon + (a * (header.east - header.west)) / 2;
      const enu = toWindowEnu(ecef(pLon, pLat, h), frame);
      const back = enuToLatLon(enu[0], enu[1], frame, enu[2]);
      const errM = Math.hypot(
        (back.lat / RAD - pLat) * 111320,
        (back.lon / RAD - pLon) * 111320 * Math.cos(lat * RAD),
      );
      worst = Math.max(worst, errM);
    }
    assert.ok(
      worst < 0.03 * header.cellSizeM,
      `${lat}: ${worst.toFixed(2)} m of a ${header.cellSizeM.toFixed(0)} m cell`,
    );
    // Every cell's centre is in its own cell, at the ground and up high.
    for (const [col, row] of [
      [0, 0],
      [446, 0],
      [0, 446],
      [446, 446],
      [223, 100],
      [17, 390],
    ]) {
      const cLon =
        header.west + ((col + 0.5) / header.cols) * (header.east - header.west);
      const cLat =
        header.north -
        ((row + 0.5) / header.rows) * (header.north - header.south);
      for (const height of [0, h]) {
        const enu = toWindowEnu(ecef(cLon, cLat, height), frame);
        const cell = enuToCell(enu[0], enu[1], frame, enu[2]);
        assert.deepEqual(
          [cell.col, cell.row],
          [col, row],
          `${lat}: cell ${col},${row} at ${height} m`,
        );
      }
    }
    const outside = toWindowEnu(
      ecef(lon + (header.east - header.west), lat, 0),
      frame,
    );
    assert.equal(
      enuToCell(outside[0], outside[1], frame),
      null,
      'outside: no cell, no lift',
    );
  }
});

test('the uniforms: the frame, the box in radians, the cells, up, and the world-to-window matrix', () => {
  const header = windowHeader(46.85, -121.76, 62500, 300);
  const frame = liftFrame(header);
  const u = frameUniforms(frame, { edgeBand: 0.1 });
  assert.deepEqual(u.u_cells, [300, 300]);
  assert.ok(Math.abs(u.u_origin[0] - 46.85 * RAD) < 1e-12);
  assert.ok(Math.abs(u.u_origin[1] - -121.76 * RAD) < 1e-12);
  assert.ok(Math.abs(u.u_origin[2] ** 2 + u.u_origin[3] ** 2 - 1) < 1e-12);
  assert.ok(Math.abs(u.u_radii[2] - Math.tan(46.85 * RAD)) < 1e-12);
  assert.deepEqual(
    u.u_box,
    [header.west, header.south, header.east, header.north].map((d) => d * RAD),
  );
  assert.ok(Math.abs(Math.hypot(...u.u_upWorld) - 1) < 1e-12);
  assert.equal(u.u_edgeBand, 0.1);
  assert.equal(frameUniforms(frame).u_edgeBand, 0, 'hard edges by default');
  // The matrix takes ECEF to the window's ENU (column-major).
  const m = worldToWindowMatrix(frame);
  const p = ecef(-121.7, 46.9, 1000);
  const apply = (v) =>
    [0, 1, 2].map(
      (r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r],
    );
  const viaMatrix = apply(p);
  const direct = toWindowEnu(p, frame);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(viaMatrix[i] - direct[i]) < 1e-3);
  for (const name of [
    'u_lift',
    'u_origin',
    'u_radii',
    'u_box',
    'u_cells',
    'u_upWorld',
    'u_edgeBand',
    'u_ecToWindow',
  ])
    assert.ok(LIFT_VERTEX_SHADER.includes(name), name);
  assert.ok(LIFT_FRAGMENT_SHADER.includes('u_debug'));
  assert.match(LIFT_VERTEX_SHADER, /czm_inverseModel/);
});

// ── The lifecycle, on stubs ──────────────────────────────────────────────

function fakeCesium() {
  const shaders = [];
  class Vec {
    constructor(...v) {
      this.v = v;
    }
  }
  class CustomShader {
    constructor(options) {
      this.options = options;
      this.uniforms = Object.fromEntries(
        Object.entries(options.uniforms).map(([k, u]) => [k, u.value]),
      );
      this.set = [];
      this.destroyed = false;
      shaders.push(this);
    }
    setUniform(name, value) {
      this.uniforms[name] = value;
      this.set.push(name);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class Matrix4 {
    static fromColumnMajorArray(a) {
      return Object.assign(new Matrix4(), { a });
    }
    static multiply(a, b, out) {
      return Object.assign(out, { a: a.a, b });
    }
  }
  return {
    shaders,
    CustomShader,
    TextureUniform: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    UniformType: {
      SAMPLER_2D: 's',
      VEC4: 'v4',
      VEC3: 'v3',
      VEC2: 'v2',
      FLOAT: 'f',
      MAT4: 'm4',
    },
    VaryingType: { FLOAT: 'f' },
    LightingModel: { UNLIT: 'unlit' },
    TextureMinificationFilter: { NEAREST: 'n' },
    TextureMagnificationFilter: { NEAREST: 'n' },
    Matrix4,
    Cartesian2: Vec,
    Cartesian3: Vec,
    Cartesian4: Vec,
    Cartographic: { fromCartesian: (p) => p },
    Math: { toDegrees: (r) => r / RAD },
  };
}

function event() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function fixture({ bricks = true, relief = 1, mode = 'lego' } = {}) {
  const cesium = fakeCesium();
  const header = windowHeader(46.85, -121.76, 62500, 8);
  const built = {
    layer: 'ee-elevation',
    flat: false,
    header,
    columns: [{ col: 2, row: 3, bricks: 20, baseM: 0, value: 1500 }],
  };
  const legoListeners = new Set();
  const lego = {
    mode,
    built,
    getMode: () => lego.mode,
    getBuilt: () => lego.built,
    subscribe(fn) {
      legoListeners.add(fn);
      return () => legoListeners.delete(fn);
    },
    tell: () => legoListeners.forEach((fn) => fn()),
  };
  const ownShader = { own: true };
  const tilesets = [{ customShader: ownShader }, { customShader: undefined }];
  const mapListeners = new Set();
  const map = {
    shown: tilesets[0],
    getImageryHostTileset: () => map.shown,
    subscribe(fn) {
      mapListeners.add(fn);
      return () => mapListeners.delete(fn);
    },
    tell: () => mapListeners.forEach((fn) => fn()),
  };
  const scene = {
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
    canvas: { clientWidth: 100, clientHeight: 100 },
    pickPositionSupported: true,
    // The centre's drawn ground: 2,000 m (true, before any relief).
    pickPosition: () => ({
      latitude: 46.85 * RAD,
      longitude: -121.76 * RAD,
      height: scene.drawnM,
    }),
    drawnM: 2000,
    preRender: event(),
    postRender: event(),
  };
  const viewer = {
    scene,
    camera: {
      inverseViewMatrix: { view: true },
      positionCartographic: { height: 50000 },
      moveEnd: event(),
      pickEllipsoid: () => null,
    },
  };
  const store = createPhotorealStore({ initial: { relief, bricks } });
  const controller = createPhotorealController({
    viewer,
    lego,
    mapStackController: map,
    store,
    cesium,
    geoid: { ready: () => Promise.resolve(), height: () => -20 },
  });
  return {
    cesium,
    header,
    built,
    lego,
    tilesets,
    ownShader,
    map,
    scene,
    viewer,
    store,
    controller,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('bricks: the shader goes on the tileset with the window’s lifts, follows window moves, and comes off cleanly', async () => {
  const f = fixture();
  assert.equal(f.controller.getStatus().reason, 'geoid', 'waits for the geoid');
  await tick();
  const [shader] = f.cesium.shaders;
  assert.ok(shader, 'made');
  assert.equal(f.tilesets[0].customShader, shader, 'on the shown tileset');
  assert.equal(f.controller.getStatus().bricks, 'on');
  const texture = shader.uniforms.u_lift;
  assert.deepEqual([texture.width, texture.height], [8, 8]);
  const lift = unpackLift(texture.typedArray, 3 * 8 + 2);
  assert.ok(
    Math.abs(lift - (20 * brickHeightM(f.header.cellSizeM) - (1500 - 20))) <
      0.06,
  );
  assert.ok(
    Number.isNaN(unpackLift(texture.typedArray, 0)),
    'cells without a column stay',
  );
  assert.equal(shader.options.vertexShaderText, LIFT_VERTEX_SHADER);
  assert.equal(
    f.scene.preRender.listeners.size,
    1,
    'the eye transform follows the camera',
  );
  f.scene.preRender.raise();
  assert.ok(shader.set.includes('u_ecToWindow'));

  // The window moves: the same shader, a new texture and frame.
  f.lego.built = {
    ...f.built,
    header: windowHeader(46.9, -121.7, 62500, 8),
    columns: [{ col: 0, row: 0, bricks: 5, baseM: 0, value: 800 }],
  };
  f.lego.tell();
  assert.equal(f.cesium.shaders.length, 1, 'no new shader');
  assert.notEqual(shader.uniforms.u_lift, texture, 'a new texture');
  assert.ok(
    ['u_lift', 'u_origin', 'u_box', 'u_cells', 'u_radii', 'u_upWorld'].every(
      (n) => shader.set.includes(n),
    ),
  );
  assert.ok(!Number.isNaN(unpackLift(shader.uniforms.u_lift.typedArray, 0)));

  // Lego off: the tileset's own shader back, the shader freed after the frame.
  f.lego.mode = 'colour';
  f.lego.tell();
  assert.equal(f.tilesets[0].customShader, f.ownShader);
  assert.equal(shader.destroyed, false, 'not while this frame may draw it');
  f.scene.postRender.raise();
  assert.equal(shader.destroyed, true);
  assert.equal(f.scene.preRender.listeners.size, 0);
  assert.equal(f.controller.getStatus().reason, 'no-lego');
  // Lego back on, then the map switches tilesets, then to a globe map.
  f.lego.mode = 'lego';
  f.lego.tell();
  const second = f.cesium.shaders[1];
  assert.equal(f.tilesets[0].customShader, second);
  f.map.shown = f.tilesets[1];
  f.map.tell();
  assert.equal(
    f.tilesets[0].customShader,
    f.ownShader,
    'the old tileset given back',
  );
  assert.equal(
    f.tilesets[1].customShader,
    f.cesium.shaders[2],
    'the new one lifted',
  );
  f.map.shown = null;
  f.map.tell();
  assert.equal(f.tilesets[1].customShader, undefined);
  assert.equal(f.controller.getStatus().reason, 'no-photoreal');
  assert.equal(
    photorealStatusText(f.controller.getStatus()),
    'Photoreal on bricks needs the Google 3D map',
  );
  // Bricks turned off in the store, and the toggle's flat-map refusal.
  f.map.shown = f.tilesets[0];
  f.map.tell();
  f.store.setBricks(false);
  assert.equal(f.tilesets[0].customShader, f.ownShader);
  assert.equal(f.controller.getStatus().bricks, 'off');
  f.store.setBricks(true);
  f.lego.built = { ...f.built, flat: true };
  f.lego.tell();
  assert.equal(
    f.tilesets[0].customShader,
    f.ownShader,
    'a flat map has no tiles to lift',
  );
  assert.equal(
    photorealStatusText(f.controller.getStatus()),
    'Photoreal on bricks waits for the bricks',
  );
  f.controller.destroy();
  for (const e of [
    f.scene.preRender,
    f.scene.postRender,
    f.viewer.camera.moveEnd,
  ])
    e.raise();
  assert.ok(f.cesium.shaders.every((s) => s.destroyed));
});

test('relief: Cesium’s exaggeration about the true ground under the view, re-anchored far away, off at ×1', async () => {
  const f = fixture({ bricks: false, relief: 3 });
  assert.equal(f.scene.verticalExaggeration, 3);
  assert.equal(
    f.scene.verticalExaggerationRelativeHeight,
    2000,
    'the ground under the middle',
  );
  // Under the relief the pick reads the drawn height; it is turned back.
  f.scene.drawnM = (2500 - 2000) * 3 + 2000;
  f.viewer.camera.moveEnd.raise();
  assert.equal(
    f.scene.verticalExaggerationRelativeHeight,
    2000,
    'near: kept, so nothing jumps',
  );
  const far = f.scene.pickPosition;
  f.scene.pickPosition = () => ({ ...far(), latitude: 47.5 * RAD });
  f.viewer.camera.moveEnd.raise();
  assert.equal(
    f.scene.verticalExaggerationRelativeHeight,
    2500,
    'far: about the new ground, unexaggerated',
  );
  f.store.setRelief(5);
  assert.equal(f.scene.verticalExaggeration, 5);
  f.store.setRelief(1);
  assert.equal(f.scene.verticalExaggeration, 1);
  assert.equal(f.scene.verticalExaggerationRelativeHeight, 0);
  f.store.setRelief(2);
  f.controller.destroy();
  assert.equal(f.scene.verticalExaggeration, 1, 'destroy restores the scene');
  assert.equal(f.viewer.camera.moveEnd.listeners.size, 0);
});

test('relief and bricks together: the lift is measured from the exaggerated ground; a pick can be un-lifted', async () => {
  const f = fixture({ bricks: true, relief: 3 });
  await tick();
  const shader = f.cesium.shaders.at(-1);
  const lift = unpackLift(shader.uniforms.u_lift.typedArray, 3 * 8 + 2);
  const top = 20 * brickHeightM(f.header.cellSizeM);
  assert.ok(Math.abs(lift - (top - ((1500 - 20 - 2000) * 3 + 2000))) < 0.06);
  // The column's cell, lifted: a pick there reads the lift too high.
  const lon = f.header.west + (2.5 / 8) * (f.header.east - f.header.west);
  const lat = f.header.north - (3.5 / 8) * (f.header.north - f.header.south);
  const back = f.controller.unliftHeight(lon, lat, 1000 + lift);
  assert.ok(Math.abs(back - 1000) < 0.06);
  assert.equal(
    f.controller.unliftHeight(lon + 5, lat, 1000),
    1000,
    'outside the window: as it is',
  );
  f.store.setRelief(1);
  const after = unpackLift(
    f.cesium.shaders.at(-1).uniforms.u_lift.typedArray,
    3 * 8 + 2,
  );
  assert.ok(
    Math.abs(after - (top - (1500 - 20))) < 0.06,
    'the relief off: lifted again from the true ground',
  );
  f.controller.destroy();
});
