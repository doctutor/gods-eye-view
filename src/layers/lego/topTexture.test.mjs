// Personal fork: photo-textured brick tops (topTexture.js, and their use in
// photoreal.js): the tile zoom for a window, the stitching plan (a window
// inside one tile, across tile boundaries, at the antimeridian, across
// it), the mercator UVs, the switch between lifting and texturing, the
// build (cancelled, with failed tiles), and the controller's lifecycle:
// a window move cancels the old build, the texture goes on the bricks
// drawn now, the tiles are cut away under them, the credit shows, and all
// comes off.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_HYSTERESIS,
  AUTO_TEXTURE_HEIGHT_M,
  ESRI_TILE_URL,
  MAX_TEXTURE_SIZE,
  TILE_SIZE,
  brickRepresentation,
  buildTopTexture,
  mercBox,
  mercX,
  mercY,
  stitchPlan,
  textureBytes,
  tileUrl,
  topUv,
  zoomForWindow,
} from './topTexture.js';
import {
  createPhotorealController,
  createPhotorealStore,
} from './photoreal.js';
import { buildBrickMesh } from './bricks.js';
import { legoWindow, boxSizeM, cellsForWindow } from './model.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('mercator: x 0 to 1 from 180° W, y 0 to 1 from the north, clamped at the poles', () => {
  assert.equal(mercX(-180), 0);
  assert.equal(mercX(0), 0.5);
  assert.equal(mercX(180), 1);
  assert.ok(near(mercY(0), 0.5));
  assert.ok(mercY(60) < mercY(30) && mercY(30) < 0.5);
  assert.ok(near(mercY(90), 0, 1e-6) && near(mercY(-90), 1, 1e-6));
  const m = mercBox({ west: 170, south: -10, east: -170, north: 10 });
  assert.ok(
    m.x1 > 1 && near(m.x1 - m.x0, 20 / 360),
    'across the antimeridian: unwrapped',
  );
});

test('the tile zoom gives 4–8 texels a cell at real windows, and never more than 4,096 px a side', () => {
  const views = [
    [39.29, -76.61, 2000],
    [39.24, -76.75, 8000],
    [46.85, -121.76, 25000],
    [46.85, -121.76, 50000],
    [36.1, -112.1, 40000],
  ];
  for (const [lat, lon, h] of views) {
    const box = legoWindow(lat, lon, h);
    const { cols, rows } = cellsForWindow({ ...boxSizeM(box), nativeM: 1 });
    const cells = Math.max(cols, rows);
    const zoom = zoomForWindow(box, cells);
    const plan = stitchPlan(box, zoom);
    const texels = Math.max(plan.width, plan.height) / cells;
    assert.ok(
      texels >= 4 && texels <= 8.5,
      `${lat},${lon} at ${h} m: ${texels.toFixed(1)} texels a cell`,
    );
    assert.ok(Math.max(plan.width, plan.height) <= MAX_TEXTURE_SIZE);
  }
  // A wide window is held to the cap, even if that is fewer texels.
  const wide = { west: -100, south: 20, east: -60, north: 50 };
  const zoom = zoomForWindow(wide, 512, { texels: 8 });
  const plan = stitchPlan(wide, zoom);
  assert.ok(Math.max(plan.width, plan.height) <= MAX_TEXTURE_SIZE);
  assert.ok(
    Math.max(plan.width, plan.height) > MAX_TEXTURE_SIZE / 2,
    'the deepest that fits',
  );
  assert.equal(
    zoomForWindow(
      { west: -0.0001, south: 0, east: 0.0001, north: 0.0001 },
      447,
    ),
    18,
    'capped at Esri’s deepest',
  );
});

test('stitching: one tile, a 2 × 2 across tile boundaries, the antimeridian, and across it', () => {
  // Inside one tile at zoom 2 (the tile x 1, y 1: 90° W to 0°).
  let plan = stitchPlan({ west: -60, south: 10, east: -50, north: 20 }, 2);
  assert.equal(plan.tiles.length, 1);
  assert.deepEqual([plan.tiles[0].x, plan.tiles[0].y], [1, 1]);
  assert.ok(
    plan.tiles[0].dx <= 0 && plan.tiles[0].dy <= 0,
    'the tile starts at or before the canvas',
  );
  // Across the 0° meridian and the equator at zoom 3: four tiles, placed edge to edge.
  plan = stitchPlan({ west: -5, south: -5, east: 5, north: 5 }, 3);
  assert.equal(plan.tiles.length, 4);
  const xs = [...new Set(plan.tiles.map((t) => t.x))].sort();
  const ys = [...new Set(plan.tiles.map((t) => t.y))].sort();
  assert.deepEqual(xs, [3, 4]);
  assert.deepEqual(ys, [3, 4]);
  const left = plan.tiles.find((t) => t.x === 3 && t.y === 3);
  const right = plan.tiles.find((t) => t.x === 4 && t.y === 3);
  assert.equal(right.dx - left.dx, TILE_SIZE);
  // The canvas is the window, not the tiles: the window's corners at its edges.
  const nw = topUv(-5, 5, plan);
  const se = topUv(5, -5, plan);
  assert.ok(near(nw.u, 0, 1 / plan.width) && near(nw.v, 0, 1 / plan.height));
  assert.ok(near(se.u, 1, 1 / plan.width) && near(se.v, 1, 1 / plan.height));
  assert.ok(near(topUv(0, 0, plan).u, 0.5, 1e-3), 'the middle in the middle');
  // At the antimeridian (east = 180): the last column of tiles, nothing past it.
  plan = stitchPlan({ west: 175, south: 60, east: 180, north: 65 }, 4);
  assert.ok(plan.tiles.every((t) => t.x === 15));
  // Across it: tiles from both ends of the row, in order on the canvas.
  plan = stitchPlan({ west: 178, south: -2, east: -178, north: 2 }, 5);
  const row = plan.tiles
    .filter((t) => t.y === plan.tiles[0].y)
    .sort((a, b) => a.dx - b.dx);
  assert.deepEqual(
    row.map((t) => t.x),
    [31, 0],
  );
  assert.equal(row[1].dx - row[0].dx, TILE_SIZE);
  const east = topUv(-178, 0, plan, 178);
  assert.ok(near(east.u, 1, 1 / plan.width), 'a longitude past 180 unwraps');
  assert.ok(near(topUv(180, 0, plan, 178).u, 0.5, 1e-3));
  assert.equal(
    tileUrl({ x: 31, y: 15 }, 5),
    ESRI_TILE_URL.replace('{z}', '5').replace('{y}', '15').replace('{x}', '31'),
  );
  assert.equal(textureBytes(4096, 4096), Math.round(4096 * 4096 * 4 * (4 / 3)));
  assert.equal(textureBytes(1000, 500, { mipmaps: false }), 2_000_000);
});

test('the mesh carries each vertex’s place for the tops’ UVs: tops their corners, sides their centre', () => {
  const columns = [
    {
      col: 0,
      row: 0,
      west: 10,
      east: 10.1,
      north: 50.1,
      south: 50,
      bricks: 3,
      baseM: 0,
      color: { hex: '#237841' },
    },
  ];
  const mesh = buildBrickMesh(columns, {
    cols: 1,
    rows: 1,
    cellSizeM: 7000,
    centerLon: 10.05,
    centerLat: 50.05,
  });
  assert.equal(mesh.lonLat.length, mesh.vertexCount * 2);
  assert.equal(mesh.centerLon, 10.05);
  const top = [...mesh.lonLat.slice(0, 8)].map(
    (v) => Math.round(v * 1e6) / 1e6,
  );
  assert.deepEqual(top, [-0.05, -0.05, 0.05, -0.05, 0.05, 0.05, -0.05, 0.05]);
  for (let v = 4; v < mesh.vertexCount; v++) {
    assert.ok(
      Math.abs(mesh.lonLat[v * 2]) < 1e-6 &&
        Math.abs(mesh.lonLat[v * 2 + 1]) < 1e-6,
      'a side at its centre',
    );
  }
});

test('the switch: AUTO lifts close in and textures far out, with hysteresis; LIFT and TEXTURE stay', () => {
  const up = AUTO_TEXTURE_HEIGHT_M * (1 + AUTO_HYSTERESIS);
  const down = AUTO_TEXTURE_HEIGHT_M * (1 - AUTO_HYSTERESIS);
  assert.equal(brickRepresentation('auto', 2000), 'lift');
  assert.equal(brickRepresentation('auto', 50000), 'texture');
  assert.equal(brickRepresentation('auto', up), 'texture');
  assert.equal(brickRepresentation('auto', down), 'lift');
  assert.equal(
    brickRepresentation('auto', AUTO_TEXTURE_HEIGHT_M, 'lift'),
    'lift',
    'inside the band: as it was',
  );
  assert.equal(
    brickRepresentation('auto', AUTO_TEXTURE_HEIGHT_M, 'texture'),
    'texture',
  );
  assert.equal(brickRepresentation('auto', NaN, 'texture'), 'texture');
  assert.equal(brickRepresentation('lift', 1e6), 'lift');
  assert.equal(brickRepresentation('texture', 10), 'texture');
  assert.equal(AUTO_TEXTURE_HEIGHT_M, 20000);
});

function fakeCanvas() {
  const drawn = [];
  return (width, height) => ({
    width,
    height,
    drawn,
    getContext: () => ({
      drawImage: (image, dx, dy) => drawn.push([image.url, dx, dy]),
    }),
  });
}

test('the build: every tile drawn at its place, a failed one left blank, a cancel stops it', async () => {
  const box = { west: -5, south: -5, east: 5, north: 5 };
  const createCanvas = fakeCanvas();
  const asked = [];
  const result = await buildTopTexture({
    box,
    cells: 40,
    texels: 6,
    createCanvas,
    fetchTile: async (url) => {
      asked.push(url);
      if (asked.length === 1) throw new Error('404');
      return { url, close() {} };
    },
  });
  assert.equal(result.plan.tiles.length, asked.length);
  assert.equal(result.failed, 1);
  assert.equal(result.fetched, asked.length - 1);
  assert.equal(result.canvas.drawn.length, result.fetched);
  assert.equal(
    result.bytes,
    textureBytes(result.plan.width, result.plan.height),
  );
  for (const [url, dx, dy] of result.canvas.drawn) {
    const tile = result.plan.tiles.find((t) => url.endsWith(`/${t.y}/${t.x}`));
    assert.deepEqual([dx, dy], [tile.dx, tile.dy]);
  }
  // Cancelled midway: it stops asking and rejects as an abort.
  const abort = new AbortController();
  let count = 0;
  await assert.rejects(
    buildTopTexture({
      box: { west: -60, south: -40, east: 60, north: 40 },
      cells: 400,
      concurrency: 1,
      signal: abort.signal,
      createCanvas: fakeCanvas(),
      fetchTile: async (url) => {
        if (++count === 3) abort.abort();
        return { url };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(count, 3, 'nothing asked after the cancel');
  await assert.rejects(
    buildTopTexture({
      box,
      cells: 10,
      signal: AbortSignal.abort(),
      createCanvas: fakeCanvas(),
      fetchTile: async () => ({}),
    }),
    { name: 'AbortError' },
  );
});

// ── The controller, textured ─────────────────────────────────────────────

const RAD = Math.PI / 180;

function fakeCesium() {
  const shaders = [];
  class Vec {
    constructor(...v) {
      this.v = v;
    }
  }
  class CustomShader {
    constructor(options) {
      this.uniforms = Object.fromEntries(
        Object.entries(options.uniforms).map(([k, u]) => [k, u.value]),
      );
      shaders.push(this);
    }
    setUniform(name, value) {
      this.uniforms[name] = value;
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
      return out;
    }
  }
  return {
    shaders,
    CustomShader,
    TextureUniform: class {
      constructor(o) {
        Object.assign(this, o);
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
    VaryingType: { FLOAT: 'f', VEC2: 'v2' },
    LightingModel: { UNLIT: 'u' },
    TextureMinificationFilter: { NEAREST: 'n' },
    TextureMagnificationFilter: { NEAREST: 'n' },
    Matrix4,
    Cartesian2: Vec,
    Cartesian3: Vec,
    Cartesian4: Vec,
    Cartographic: { fromCartesian: (p) => p },
    Math: { toDegrees: (r) => r / RAD },
    Credit: class {
      constructor(html) {
        this.html = html;
      }
    },
  };
}

const event = () => {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    raise: () => [...listeners].forEach((fn) => fn()),
  };
};

function builtAt(lat, lon) {
  const box = legoWindow(lat, lon, 50000);
  return {
    layer: 'ee-elevation',
    flat: false,
    header: { ...box, cols: 8, rows: 8, cellSizeM: 15000 },
    columns: [{ col: 2, row: 3, bricks: 9, baseM: 0, value: 1200 }],
  };
}

function primitive() {
  return {
    set: [],
    setTopTexture(canvas, plan, options) {
      this.set.push(canvas ? { canvas, plan, ...options } : null);
    },
    isDestroyed: () => false,
  };
}

function fixture({ mode = 'auto', height = 50000 } = {}) {
  const cesium = fakeCesium();
  const builds = [];
  const buildTexture = ({ box, cells, signal }) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    signal.addEventListener('abort', () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    });
    builds.push({ box, cells, signal, resolve, reject });
    return promise;
  };
  const lego = {
    built: builtAt(46.85, -121.76),
    primitive: primitive(),
    getMode: () => 'lego',
    getBuilt: () => lego.built,
    getPrimitive: () => lego.primitive,
    listeners: new Set(),
    subscribe(fn) {
      lego.listeners.add(fn);
      return () => lego.listeners.delete(fn);
    },
    tell: () => lego.listeners.forEach((fn) => fn()),
  };
  const tileset = { customShader: undefined };
  const credits = [];
  const scene = {
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
    canvas: { clientWidth: 10, clientHeight: 10 },
    preRender: event(),
    postRender: event(),
    frameState: {
      creditDisplay: {
        addStaticCredit: (c) => credits.push(['add', c.html]),
        removeStaticCredit: (c) => credits.push(['remove', c.html]),
      },
    },
  };
  const camera = {
    positionCartographic: { height },
    inverseViewMatrix: {},
    moveEnd: event(),
    pickEllipsoid: () => null,
  };
  const registered = [];
  const controller = createPhotorealController({
    viewer: { scene, camera },
    lego,
    mapStackController: {
      getImageryHostTileset: () => tileset,
      subscribe: () => () => {},
    },
    store: createPhotorealStore({
      initial: { relief: 1, bricks: true, mode, sides: 'tint' },
    }),
    cesium,
    buildTexture,
    registerCredit: (c) => registered.push(c.key),
  });
  return {
    cesium,
    builds,
    lego,
    tileset,
    credits,
    camera,
    controller,
    registered,
  };
}

const canvasFor = (build) => ({
  canvas: { width: 2400, height: 2400 },
  plan: stitchPlan(build.box, zoomForWindow(build.box, build.cells)),
  fetched: 110,
  failed: 0,
  bytes: textureBytes(2400, 2400),
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('far out: the tiles stay lifted until the imagery is in, then the tops carry it and the tiles are cut away', async () => {
  const f = fixture();
  assert.equal(f.builds.length, 1, 'AUTO at 50 km builds the texture');
  const shader = f.tileset.customShader;
  assert.ok(shader, 'the lift shader is on meanwhile');
  assert.equal(shader.uniforms.u_hide, 0, 'lifted until the imagery is in');
  assert.equal(f.controller.getStatus().texture, 'loading');
  f.builds[0].resolve(canvasFor(f.builds[0]));
  await tick();
  assert.equal(f.lego.primitive.set.length, 1);
  assert.equal(f.lego.primitive.set[0].sides, 'tint');
  assert.equal(f.lego.primitive.set[0].west, f.lego.built.header.west);
  assert.equal(
    shader.uniforms.u_hide,
    1,
    'the tiles cut away under the bricks',
  );
  assert.deepEqual(f.credits.at(-1)[0], 'add');
  assert.deepEqual(
    f.registered,
    ['lego-brick-tops'],
    'in the data popover too',
  );
  const status = f.controller.getStatus();
  assert.equal(status.representation, 'texture');
  assert.equal(status.texture, 'ready');
  assert.equal(status.textureSize, '2400×2400');
  assert.equal(status.textureBytes, textureBytes(2400, 2400));
  // The sides switched to their colour: the same texture, set again.
  f.controller.setSides('colour');
  assert.equal(f.lego.primitive.set.at(-1).sides, 'colour');
  assert.equal(f.builds.length, 1, 'no new build');
  // Lego rebuilt the same window's bricks (a new primitive): the texture follows.
  f.lego.primitive = primitive();
  f.lego.tell();
  assert.equal(f.lego.primitive.set.length, 1);
  assert.equal(f.builds.length, 1);
});

test('a window move cancels the build before; the camera coming down lifts again; off takes it all off', async () => {
  const f = fixture();
  const first = f.builds[0];
  f.lego.built = builtAt(46.95, -121.6);
  f.lego.tell();
  assert.equal(first.signal.aborted, true, 'the old window’s build cancelled');
  assert.equal(f.builds.length, 2);
  first.resolve(canvasFor(first));
  await tick();
  assert.equal(f.lego.primitive.set.length, 0, 'a cancelled build never lands');
  f.builds[1].resolve(canvasFor(f.builds[1]));
  await tick();
  assert.equal(f.lego.primitive.set.length, 1);
  // Down to 5 km: lifted again, the texture off the bricks, the credit gone.
  f.camera.positionCartographic.height = 5000;
  f.camera.moveEnd.raise();
  assert.equal(f.controller.getStatus().representation, 'lift');
  assert.equal(f.lego.primitive.set.at(-1), null);
  assert.equal(f.tileset.customShader.uniforms.u_hide, 0);
  assert.deepEqual(f.credits.at(-1)[0], 'remove');
  // Back up: the kept texture goes straight on (no new build).
  f.camera.positionCartographic.height = 40000;
  f.camera.moveEnd.raise();
  assert.equal(f.builds.length, 2);
  assert.ok(f.lego.primitive.set.at(-1)?.canvas);
  // A failed build: status says so, not asked again for that window.
  f.lego.built = builtAt(47.2, -121.2);
  f.lego.tell();
  f.builds[2].reject(new Error('offline'));
  await tick();
  assert.equal(f.controller.getStatus().texture, 'failed');
  f.lego.tell();
  assert.equal(f.builds.length, 3, 'not retried for the same window');
  // Off: the texture and the shader go, the build is cancelled.
  f.lego.built = builtAt(47.5, -121);
  f.lego.tell();
  const pending = f.builds.at(-1);
  f.controller.setBricks(false);
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.tileset.customShader, undefined);
  f.controller.destroy();
});

test('LIFT never builds a texture; TEXTURE builds one close in too', () => {
  const lift = fixture({ mode: 'lift', height: 80000 });
  assert.equal(lift.builds.length, 0);
  assert.equal(lift.controller.getStatus().representation, 'lift');
  lift.controller.destroy();
  const texture = fixture({ mode: 'texture', height: 1500 });
  assert.equal(texture.builds.length, 1);
  assert.equal(texture.controller.getStatus().representation, 'texture');
  texture.controller.destroy();
});
