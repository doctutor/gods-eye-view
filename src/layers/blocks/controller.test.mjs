// Personal fork: the Blocks controller (src/layers/blocks/index.js) on a
// fake grid, source, renderer and camera: the chunk ring's order, the
// per-tick budget, re-meshing when a neighbour arrives, hysteresis removal,
// re-anchoring, the Elevation-off case, the tick, and the status it gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_BUDGET,
  RENDER_DISTANCE_BLOCKS,
  REMOVE_FACTOR,
  STUDY_SUN,
  SUN_REMESH_DEG,
  SUN_TICK_MS,
  chunkDistance,
  chunkRing,
  fineRing,
  groupOf,
  createBlocksController,
  needsReanchor,
  sourceName,
} from './index.js';
import { blocksFloorM } from './floor.js';
import { createRenderModeStore } from '../lego/renderMode.js';
import { blocksStatusText } from '../lego/presentation.js';

const C = 64;
const RAD = Math.PI / 180;
const M_PER_DEG = 111_320;
const LON0 = -76.6292;
const LAT0 = 39.3214;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** grid.js as the plan has it, on a plain equirectangular frame. */
const fakeGrid = {
  CHUNK_COLUMNS: C,
  chunkKey: (ci, cj) => `${ci}:${cj}`,
  createRegion({ lon0, lat0, blockM, levelM = blockM }) {
    const cos = Math.cos(lat0 * RAD);
    return {
      lon0,
      lat0,
      blockM,
      levelM,
      toLocal: (lon, lat) => ({
        x: (lon - lon0) * M_PER_DEG * cos,
        y: (lat - lat0) * M_PER_DEG,
      }),
      columnOf: (x, y) => ({
        i: Math.floor(x / blockM),
        j: Math.floor(y / blockM),
      }),
      chunkOrigin: (ci, cj) => ({
        x: ci * C * blockM,
        y: cj * C * blockM,
        z: 0,
      }),
    };
  },
};
/** Degrees `metres` east of a longitude at LAT0. */
const east = (metres, lon = LON0) =>
  lon + metres / (M_PER_DEG * Math.cos(LAT0 * RAD));

function fakeSource({ blockM = 1, name = '3DEP 1 m', hold = false } = {}) {
  const loads = [];
  const regions = [];
  return {
    loads,
    regions,
    regionFor(lon, lat, windowM) {
      regions.push({ lon, lat, windowM });
      return Promise.resolve({ blockM, source: name });
    },
    loadChunk(region, ci, cj) {
      const chunk = { ci, cj, version: 0 };
      if (!hold) {
        loads.push({ ci, cj, region });
        return Promise.resolve(chunk);
      }
      return new Promise((resolve, reject) =>
        loads.push({ ci, cj, region, resolve: () => resolve(chunk), reject }),
      );
    },
  };
}

function fakeRenderer() {
  const shown = new Map();
  const calls = [];
  return {
    shown,
    calls,
    setRegion: (region, options) => calls.push(['region', region, options]),
    setSun: (dir, options) => calls.push(['sun', dir, options]),
    setFog: (fog) => calls.push(['fog', fog]),
    upsert(key, mesh) {
      calls.push(['upsert', key]);
      shown.set(key, mesh);
    },
    remove(key) {
      calls.push(['remove', key]);
      shown.delete(key);
    },
    destroy: () => calls.push(['destroy']),
  };
}

function fakeEvent() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raise: () => [...listeners].forEach((listener) => listener()),
    size: () => listeners.size,
  };
}

function fakeViewer(lon = LON0, lat = LAT0) {
  const camera = {
    positionCartographic: {
      longitude: lon * RAD,
      latitude: lat * RAD,
      height: 300,
    },
    moveStart: fakeEvent(),
    moveEnd: fakeEvent(),
  };
  return {
    camera,
    scene: { globe: { show: true } },
    moveTo(lonNow, latNow = lat) {
      camera.positionCartographic = {
        longitude: lonNow * RAD,
        latitude: latNow * RAD,
        height: 300,
      };
    },
  };
}

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

function fakeLayers(on = true) {
  const listeners = new Set();
  const layers = {
    on,
    isEnabled: (id) => id === 'ee-elevation' && layers.on,
    subscribeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      layers.on = next;
      for (const listener of listeners)
        listener({ type: 'visibility-settled', layerId: 'ee-elevation' });
    },
  };
  return layers;
}

function setup({
  mode = 'blocks',
  elevation = true,
  source,
  radiusBlocks,
  datum,
  flatStyle,
} = {}) {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode(mode);
  const viewer = fakeViewer();
  const layers = fakeLayers(elevation);
  const renderer = fakeRenderer();
  const meshes = [];
  const timers = { callback: null, set: 0, cleared: 0 };
  const controller = createBlocksController({
    viewer,
    store,
    layers,
    source: source || fakeSource(),
    renderer,
    grid: fakeGrid,
    buildChunkMesh(chunk, options) {
      meshes.push({ key: `${chunk.ci}:${chunk.cj}`, chunk, options });
      return { faces: 1, chunk };
    },
    ...(radiusBlocks ? { radiusBlocks } : {}),
    ...(datum ? { datum } : {}),
    ...(flatStyle ? { flatStyle } : {}),
    setIntervalImpl(callback) {
      timers.callback = callback;
      timers.set++;
      return timers.set;
    },
    clearIntervalImpl() {
      timers.callback = null;
      timers.cleared++;
    },
  });
  return { store, viewer, layers, renderer, meshes, timers, controller };
}

/** Tick until nothing is left to do (or `limit` ticks). */
async function drain(controller, limit = 200) {
  for (let n = 0; n < limit; n++) {
    await settle();
    controller.tick();
    if (!controller._state().ticking) break;
  }
  await settle();
}

test('the chunk ring: the camera’s chunk first, then by distance to each chunk’s nearest point, all within the render distance', () => {
  const ring = chunkRing({ i: 32, j: 32, radius: 512, chunkColumns: C });
  assert.deepEqual(ring[0], { ci: 0, cj: 0, distance: 0 });
  for (let n = 1; n < ring.length; n++)
    assert.ok(ring[n].distance >= ring[n - 1].distance, `sorted at ${n}`);
  assert.ok(ring.every((c) => c.distance <= 512));
  // The four edge-sharing chunks come before the diagonal ones.
  const firstFive = ring.slice(0, 5).map((c) => `${c.ci}:${c.cj}`);
  assert.deepEqual(firstFive.slice(1).sort(), ['-1:0', '0:-1', '0:1', '1:0']);
  // About π·(R/C + ½)² chunks; none missing in a straight line out.
  assert.ok(ring.length > 200 && ring.length < 260, String(ring.length));
  const keys = new Set(ring.map((c) => `${c.ci}:${c.cj}`));
  for (let k = 0; k <= 8; k++) assert.ok(keys.has(`${k}:0`), `${k}:0`);
  assert.ok(!keys.has('9:0'), 'chunk 9 starts 566 columns east');
  // In a chunk's north-east corner: its neighbours across that corner
  // first (half a column away), the diagonal next; ties by the centre, then
  // the key.
  const small = chunkRing({ i: 63, j: 63, radius: 70, chunkColumns: C });
  assert.deepEqual(
    small.slice(0, 4).map((c) => `${c.ci}:${c.cj}`),
    ['0:0', '0:1', '1:0', '1:1'],
  );
  assert.deepEqual(
    small.slice(0, 4).map((c) => c.distance),
    [0, 0.5, 0.5, Math.SQRT1_2],
  );
  assert.equal(
    small.length,
    12,
    '4 × 2 across the corner, 2 more on each far side',
  );
  assert.equal(chunkDistance({ x: 0.5, y: 0.5 }, 2, 0, C), 127.5);
});

test('re-anchoring past 20 km, or twice the render distance for coarse blocks; the source’s name', () => {
  assert.equal(needsReanchor({ x: 19_000, y: 0 }, 1, 512), false);
  assert.equal(needsReanchor({ x: 15_000, y: 15_000 }, 1, 512), true);
  assert.equal(needsReanchor({ x: 25_000, y: 0 }, 30, 512), false);
  assert.equal(needsReanchor({ x: 31_000, y: 0 }, 30, 512), true);
  assert.equal(needsReanchor({ x: NaN, y: 0 }, 1, 512), true);
  assert.equal(sourceName('3DEP 1 m'), '3DEP 1 m');
  assert.equal(sourceName({ name: 'FABDEM 30 m' }), 'FABDEM 30 m');
  assert.equal(sourceName({ id: 'glo30' }), 'glo30');
  assert.equal(sourceName(null), '');
});

test('the budget: 8 loads in flight at most, nearest first; 8 meshes a tick at most', async () => {
  const source = fakeSource({ hold: true });
  const { controller, renderer, meshes, timers } = setup({ source });
  await settle();
  assert.equal(source.regions.length, 1, 'anchored once');
  assert.equal(source.regions[0].windowM, 1024);
  assert.equal(source.loads.length, CHUNK_BUDGET);
  const ring = chunkRing({
    i: 0,
    j: 0,
    radius: RENDER_DISTANCE_BLOCKS,
    chunkColumns: C,
  });
  assert.deepEqual(
    source.loads.map((l) => `${l.ci}:${l.cj}`),
    ring.slice(0, CHUNK_BUDGET).map((c) => `${c.ci}:${c.cj}`),
  );
  assert.ok(timers.callback, 'ticking while work remains');
  controller.tick();
  assert.equal(
    source.loads.length,
    CHUNK_BUDGET,
    'none started while 8 are in flight',
  );
  // Three arrive: three more start; the three wait for their neighbours
  // in the ring (meshed once, not again as each lands).
  source.loads.slice(0, 3).forEach((l) => l.resolve());
  await settle();
  controller.tick();
  assert.equal(source.loads.length, CHUNK_BUDGET + 3);
  assert.equal(meshes.length, 0, 'waiting for their neighbours');
  assert.equal(renderer.shown.size, 0);
  // Twenty arrive at once: at most 8 meshes in one tick.
  for (let n = 0; n < 30; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  const before = meshes.length;
  source.loads.forEach((l) => l.resolve());
  await settle();
  controller.tick();
  assert.ok(meshes.length - before <= CHUNK_BUDGET);
  assert.equal(controller.getStatus().state, 'loading');
  assert.equal(controller.getStatus().blockM, 1);
  assert.equal(controller.getStatus().source, '3DEP 1 m');
  controller.destroy();
});

test('a chunk waits for its neighbours in the ring, is meshed once with all eight, and again when its version changes; at the ring’s edge the neighbours beyond do not count', async () => {
  const source = fakeSource({ hold: true });
  const { controller, meshes } = setup({ source, radiusBlocks: 128 });
  await settle();
  const ofOrigin = () => meshes.filter((m) => m.key === '0:0');
  const around = (l) => Math.abs(l.ci) <= 1 && Math.abs(l.cj) <= 1;
  // 0:0 arrives alone: it waits.
  source.loads.find((l) => l.ci === 0 && l.cj === 0).resolve();
  await settle();
  controller.tick();
  assert.equal(ofOrigin().length, 0);
  // Its east neighbour too: still waiting for the rest.
  source.loads.find((l) => l.ci === 1 && l.cj === 0).resolve();
  await settle();
  controller.tick();
  assert.equal(ofOrigin().length, 0);
  // All eight in: meshed once, with all eight.
  for (let n = 0; n < 10; n++) {
    source.loads.filter(around).forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  assert.equal(ofOrigin().length, 1);
  assert.deepEqual(Object.keys(ofOrigin()[0].options.neighbours).sort(), [
    'e',
    'n',
    'ne',
    'nw',
    's',
    'se',
    'sw',
    'w',
  ]);
  assert.equal(ofOrigin()[0].options.blockM, 1);
  assert.deepEqual(ofOrigin()[0].options.sunDir, STUDY_SUN.dir);
  // Nothing changed: not meshed again.
  controller.tick();
  assert.equal(ofOrigin().length, 1);
  // An edit bumps its version: meshed again.
  ofOrigin()[0].chunk.version = 1;
  controller.tick();
  assert.equal(ofOrigin().length, 2);
  // The ring's edge (R1 128: chunks −4 … 3): 3:0's east neighbour is not in
  // the ring, so once its neighbours in the ring are in, it is meshed.
  for (let n = 0; n < 20; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  const edge = meshes.filter((m) => m.key === '3:0');
  assert.equal(edge.length, 1);
  assert.equal(edge[0].options.neighbours.e, undefined, 'beyond the ring');
  controller.destroy();
});

test('the budget doubles for 30 m blocks; the region says when it is left (grid.js within)', async () => {
  const { tickBudget, reanchorRadiusM } = await import('./index.js');
  assert.equal(tickBudget(8, 1), 8);
  assert.equal(tickBudget(8, 10), 8);
  assert.equal(tickBudget(8, 30), 16);
  assert.equal(reanchorRadiusM(1, 512), 20_000);
  assert.equal(reanchorRadiusM(30, 512), 30_720);
  // The flat levels as before; the curved ones (1,920 m and up, anchored
  // at the ground point) at most 2,000 km.
  assert.equal(reanchorRadiusM(480, 512), 491_520);
  assert.equal(reanchorRadiusM(1920, 512), 1_966_080);
  assert.equal(reanchorRadiusM(7680, 512), 2_000_000);
  assert.equal(reanchorRadiusM(30720, 512), 2_000_000);
  // 30 m blocks: 16 loads in flight on the first tick.
  const coarse = fakeSource({ blockM: 30, hold: true });
  const run = setup({ source: coarse });
  await settle();
  assert.equal(coarse.loads.length, 16);
  run.controller.destroy();
  // A region with within(): asked with the controller's radius.
  const asked = [];
  const grid = fakeGrid.createRegion;
  fakeGrid.createRegion = (options) => {
    const region = grid(options);
    region.within = (lon, lat, radiusM) => {
      asked.push(radiusM);
      return true; // never left, however far
    };
    return region;
  };
  try {
    const source = fakeSource();
    const { controller, viewer } = setup({ source, radiusBlocks: 64 });
    await drain(controller);
    viewer.moveTo(east(25_000));
    await drain(controller);
    assert.equal(source.regions.length, 1, 'within() said it was not left');
    assert.ok(asked.length > 0 && asked.every((r) => r === 20_000));
    controller.destroy();
  } finally {
    fakeGrid.createRegion = grid;
  }
});

test('hysteresis: fine chunks are dropped a group at a time, only beyond 1.25 × the render distance', async () => {
  const { controller, viewer, renderer } = setup();
  await drain(controller);
  const ring = fineRing({
    i: 0,
    j: 0,
    radius: RENDER_DISTANCE_BLOCKS,
    chunkColumns: C,
  });
  assert.equal(renderer.shown.size, ring.length);
  assert.equal(ring.length % 16, 0, 'whole groups');
  assert.equal(controller.getStatus().state, 'ready');
  assert.equal(controller.getStatus().chunks, ring.length);
  // 100 m east: every group is still within 640 columns; nothing dropped.
  viewer.moveTo(east(100));
  await drain(controller);
  assert.ok(
    renderer.calls.every(([kind]) => kind !== 'remove'),
    'nothing dropped yet',
  );
  for (const { ci, cj } of fineRing({
    i: 100,
    j: 0,
    radius: RENDER_DISTANCE_BLOCKS,
    chunkColumns: C,
  }))
    assert.ok(renderer.shown.has(`${ci}:${cj}`), `${ci}:${cj}`);
  // 1 km east: the western groups go whole, those within 640 columns stay.
  viewer.moveTo(east(1000));
  await drain(controller);
  const local = 1000;
  for (const key of renderer.shown.keys()) {
    const [ci, cj] = key.split(':').map(Number);
    const { gi, gj } = groupOf(ci, cj);
    assert.ok(
      chunkDistance({ x: local + 0.5, y: 0.5 }, gi, gj, C * 4) <=
        RENDER_DISTANCE_BLOCKS * REMOVE_FACTOR,
      key,
    );
  }
  const removed = renderer.calls
    .filter(([kind]) => kind === 'remove')
    .map(([, key]) => key);
  // Group −2 (columns −512 … −256) is 1,256 columns behind: all 16 go.
  for (let ci = -8; ci < -4; ci++)
    for (let cj = 0; cj < 4; cj++)
      assert.ok(removed.includes(`${ci}:${cj}`), `${ci}:${cj}`);
  assert.ok(
    renderer.shown.has('7:0'),
    'group 1 (columns 256 … 512) is 488 columns behind: kept',
  );
  for (const { ci, cj } of fineRing({
    i: local,
    j: 0,
    radius: RENDER_DISTANCE_BLOCKS,
    chunkColumns: C,
  }))
    assert.ok(renderer.shown.has(`${ci}:${cj}`), `${ci}:${cj}`);
  controller.destroy();
});

test('re-anchoring: 25 km away the region is anchored again at the camera and every chunk replaced', async () => {
  const source = fakeSource();
  const { controller, viewer, renderer } = setup({ source, radiusBlocks: 128 });
  await drain(controller);
  const before = renderer.shown.size;
  assert.ok(before > 0);
  viewer.moveTo(east(25_000));
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 2);
  assert.ok(Math.abs(source.regions[1].lon - east(25_000)) < 1e-9);
  const regions = renderer.calls.filter(([kind]) => kind === 'region');
  assert.equal(regions.length, 2);
  assert.ok(Math.abs(regions[1][1].lon0 - east(25_000)) < 1e-9);
  // The old chunks were all removed; the new set is around the new origin.
  assert.equal(
    renderer.calls.filter(([kind]) => kind === 'remove').length,
    before,
  );
  assert.ok(renderer.shown.has('0:0'));
  assert.equal(renderer.shown.size, before);
  // The chunks loaded after the re-anchor carry the new region.
  assert.equal(source.loads.at(-1).region, regions[1][1]);
  controller.destroy();
});

test('Elevation off: nothing is built and the status says so; on, it anchors; Colour clears it all', async () => {
  const source = fakeSource();
  const { controller, layers, store, renderer } = setup({
    source,
    elevation: false,
    radiusBlocks: 64,
  });
  await settle();
  assert.equal(source.regions.length, 0);
  assert.equal(controller.getStatus().state, 'no-elevation');
  assert.equal(
    blocksStatusText(controller.getStatus()),
    'Blocks needs the Elevation layer on',
  );
  layers.set(true);
  await drain(controller);
  assert.equal(source.regions.length, 1);
  assert.ok(renderer.shown.size > 0);
  assert.equal(blocksFloorM(), 1, 'the HUD floor: Blocks 1 m');
  // Elevation off again: every chunk removed.
  layers.set(false);
  assert.equal(renderer.shown.size, 0);
  assert.equal(controller.getStatus().state, 'no-elevation');
  assert.equal(blocksFloorM(), null);
  // Back on, then Colour: off, nothing drawn.
  layers.set(true);
  await drain(controller);
  assert.ok(renderer.shown.size > 0);
  store.setMode('colour');
  assert.equal(renderer.shown.size, 0);
  assert.equal(controller.getStatus().state, 'off');
  assert.equal(blocksStatusText(controller.getStatus()), '');
  // Lego is not Blocks either.
  store.setMode('lego');
  await settle();
  assert.equal(renderer.shown.size, 0);
  assert.equal(source.regions.length, 2);
  controller.destroy();
});

test('in Colour nothing is asked of the source at all', async () => {
  const source = fakeSource();
  const { controller, viewer } = setup({ source, mode: 'colour' });
  viewer.camera.moveStart.raise();
  viewer.camera.moveEnd.raise();
  await settle();
  assert.equal(source.regions.length, 0);
  assert.equal(source.loads.length, 0);
  assert.equal(controller.getStatus().state, 'off');
  controller.destroy();
});

test('the tick: runs while the camera moves and while chunks are coming, stops when settled', async () => {
  const { controller, viewer, timers } = setup({ radiusBlocks: 64 });
  await drain(controller);
  assert.equal(timers.callback, null, 'settled: no tick');
  viewer.camera.moveStart.raise();
  assert.ok(timers.callback, 'moving: ticking');
  timers.callback();
  assert.ok(timers.callback, 'still moving');
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(timers.callback, null);
  controller.destroy();
});

test('the status line and the HUD floor; destroy frees the renderer', async () => {
  const { controller, renderer } = setup({ radiusBlocks: 64 });
  await drain(controller);
  const status = controller.getStatus();
  assert.equal(status.state, 'ready');
  // The default sun is the study sun, and the line says so.
  assert.equal(status.sunFixed, true);
  assert.equal(
    blocksStatusText(status),
    `Blocks: 1 m cubes · ${status.chunks} chunks · 3DEP 1 m · study sun`,
  );
  assert.equal(
    blocksStatusText({ ...status, sunFixed: false }),
    `Blocks: 1 m cubes · ${status.chunks} chunks · 3DEP 1 m`,
  );
  assert.equal(
    blocksStatusText({ ...status, state: 'loading', pending: 3 }),
    `Blocks: 1 m cubes · ${status.chunks} chunks · 3DEP 1 m · study sun · 3 loading`,
  );
  assert.equal(
    blocksStatusText({ state: 'ready', blockM: 30, chunks: 1234, source: '' }),
    'Blocks: 30 m cubes · 1,234 chunks',
  );
  assert.equal(blocksStatusText({ state: 'failed' }), 'Blocks unavailable');
  assert.equal(
    blocksStatusText({ state: 'unavailable' }),
    'Blocks needs the raster values service (/api/raster/values)',
  );
  assert.equal(
    blocksStatusText({ state: 'anchoring' }),
    'Blocks: finding the block size…',
  );
  assert.equal(blocksFloorM(), 1);
  controller.destroy();
  assert.equal(renderer.shown.size, 0);
  assert.deepEqual(renderer.calls.at(-1), ['destroy']);
  assert.equal(blocksFloorM(), null);
  assert.equal(controller.getStatus().state, 'off');
});

test('a region that fails: unavailable without the values service, failed otherwise; a chunk that fails is skipped', async () => {
  const notFound = Object.assign(new Error('Raster values: HTTP 404'), {
    status: 404,
  });
  const source = {
    regionFor: () => Promise.reject(notFound),
    loadChunk: () => Promise.reject(new Error('never')),
  };
  const off = setup({ source });
  await settle();
  await settle();
  assert.equal(off.controller.getStatus().state, 'unavailable');
  assert.equal(off.timers.callback, null);
  off.controller.destroy();

  const warn = console.warn;
  console.warn = () => {};
  try {
    const flaky = fakeSource();
    const load = flaky.loadChunk;
    flaky.loadChunk = (region, ci, cj) =>
      ci === 1 && cj === 0
        ? Promise.reject(new Error('HTTP 500'))
        : load(region, ci, cj);
    const { controller, renderer } = setup({ source: flaky, radiusBlocks: 64 });
    await drain(controller);
    assert.ok(!renderer.shown.has('1:0'));
    assert.ok(renderer.shown.has('0:0'));
    assert.equal(controller.getStatus().state, 'ready');
    assert.equal(controller.getStatus().failed, 1);
    controller.destroy();
  } finally {
    console.warn = warn;
  }
});

/** A ground that is flat or terrain, switchable, with a geoid. */
function fakeDatum({ flat = true, undulation = -33.2, fails = false } = {}) {
  const listeners = new Set();
  const datum = {
    isFlat: flat,
    asked: [],
    flat: () => datum.isFlat,
    async undulation(lat, lon) {
      datum.asked.push({ lat, lon });
      if (fails) throw new Error('no geoid grid');
      return undulation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flip(next) {
      datum.isFlat = next;
      for (const listener of listeners) listener();
    },
  };
  return datum;
}

test('sea level: on the ellipsoid on flat ground (offset 0), lifted by the geoid on terrain', async () => {
  const flat = fakeDatum({ flat: true });
  const onFlat = setup({ datum: flat, radiusBlocks: 64 });
  await drain(onFlat.controller);
  const [, , flatOptions] = onFlat.renderer.calls.find(([k]) => k === 'region');
  assert.deepEqual(flatOptions, { datumOffsetM: 0 });
  assert.equal(flat.asked.length, 0, 'no geoid on flat ground');
  onFlat.controller.destroy();

  const terrain = fakeDatum({ flat: false, undulation: -33.2 });
  const onTerrain = setup({ datum: terrain, radiusBlocks: 64 });
  await drain(onTerrain.controller);
  const [, region, options] = onTerrain.renderer.calls.find(
    ([k]) => k === 'region',
  );
  assert.deepEqual(options, { datumOffsetM: -33.2 });
  assert.deepEqual(terrain.asked, [{ lat: region.lat0, lon: region.lon0 }]);
  assert.equal(onTerrain.controller._state().region.datumOffsetM, -33.2);
  onTerrain.controller.destroy();
});

test('the ground flipping (a new map stack) re-anchors with the new offset; a geoid that fails is 0', async () => {
  const datum = fakeDatum({ flat: true });
  const { controller, renderer } = setup({ datum, radiusBlocks: 64 });
  await drain(controller);
  const before = renderer.shown.size;
  assert.ok(before > 0);
  datum.flip(false);
  await drain(controller);
  const regions = renderer.calls.filter(([k]) => k === 'region');
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[1][2], { datumOffsetM: -33.2 });
  assert.equal(renderer.calls.filter(([k]) => k === 'remove').length, before);
  assert.equal(renderer.shown.size, before);
  // Back to flat: anchored again at 0.
  datum.flip(true);
  await drain(controller);
  assert.deepEqual(renderer.calls.filter(([k]) => k === 'region')[2][2], {
    datumOffsetM: 0,
  });
  controller.destroy();

  const warn = console.warn;
  console.warn = () => {};
  try {
    const broken = fakeDatum({ flat: false, fails: true });
    const run = setup({ datum: broken, radiusBlocks: 64 });
    await drain(run.controller);
    assert.deepEqual(run.renderer.calls.find(([k]) => k === 'region')[2], {
      datumOffsetM: 0,
    });
    assert.ok(run.renderer.shown.size > 0);
    run.controller.destroy();
  } finally {
    console.warn = warn;
  }
});

test('the globe: hidden while Blocks is on over a drawn style, shown again on leaving; kept on imagery', async () => {
  // Blank + Blocks: hidden at once, before a chunk arrives.
  let drawn = true;
  const blank = setup({ flatStyle: () => drawn, radiusBlocks: 64 });
  const globe = blank.viewer.scene.globe;
  assert.equal(globe.show, false);
  await drain(blank.controller);
  assert.equal(globe.show, false);
  // Leave Blocks (Colour): shown again.
  blank.store.setMode('colour');
  assert.equal(globe.show, true);
  // Back to Blocks, then Elevation off: shown (nothing is drawn).
  blank.store.setMode('blocks');
  assert.equal(globe.show, false);
  blank.layers.set(false);
  assert.equal(globe.show, true);
  blank.layers.set(true);
  assert.equal(globe.show, false);
  // A switch to imagery: the map stack controller shows the globe for its
  // map; Blocks leaves it so and does not hide it again.
  drawn = false;
  globe.show = true;
  blank.controller.tick();
  assert.equal(globe.show, true);
  // ...nor shows it when the new map is one that hides it (photoreal).
  drawn = true;
  blank.controller.tick();
  assert.equal(globe.show, false);
  drawn = false;
  globe.show = false; // the photoreal stack hid it
  blank.controller.tick();
  assert.equal(globe.show, false, 'the map’s choice stands');
  // Destroy on a drawn style restores it.
  drawn = true;
  globe.show = true;
  blank.controller.tick();
  assert.equal(globe.show, false);
  blank.controller.destroy();
  assert.equal(globe.show, true);

  // Satellite + Blocks: the globe stays.
  const satellite = setup({ flatStyle: () => false, radiusBlocks: 64 });
  await drain(satellite.controller);
  assert.equal(satellite.viewer.scene.globe.show, true);
  assert.ok(satellite.renderer.shown.size > 0);
  satellite.controller.destroy();
  assert.equal(satellite.viewer.scene.globe.show, true);

  // Blank in Colour: never touched.
  const colour = setup({ flatStyle: () => true, mode: 'colour' });
  assert.equal(colour.viewer.scene.globe.show, true);
  colour.controller.destroy();
  assert.equal(colour.viewer.scene.globe.show, true);
});

test('Elevation on but draped nowhere (the globe hidden): Blocks reads the toggle, not the host, so nothing flips back', async () => {
  const { resolveImageryHost } = await import('../../maps/imageryHost.js');
  const { subscribeBlocksScene, blocksScene } = await import('./floor.js');
  const { controller, viewer, layers } = setup({
    flatStyle: () => true,
    radiusBlocks: 64,
    elevation: false,
  });
  viewer.imageryLayers = { add() {}, remove() {} };
  // The Elevation layer: re-drapes on every scene change, and a re-drape
  // that finds no host is still on (its toggle), as the Earth Engine layer is.
  const hosts = [];
  const flips = [];
  let lastShow = viewer.scene.globe.show;
  const off = subscribeBlocksScene(() => {
    hosts.push(resolveImageryHost({ viewer }).kind);
    if (viewer.scene.globe.show !== lastShow)
      flips.push((lastShow = viewer.scene.globe.show));
    // The lifecycle settles it again: a visibility event, its toggle as it was.
    layers.set(layers.on);
  });
  try {
    assert.equal(viewer.scene.globe.show, true, 'Elevation off: untouched');
    layers.set(true);
    await drain(controller);
    for (let n = 0; n < 10; n++) {
      viewer.camera.moveEnd.raise();
      await drain(controller);
    }
    assert.equal(viewer.scene.globe.show, false);
    assert.equal(resolveImageryHost({ viewer }).kind, 'none');
    assert.deepEqual(hosts, ['none'], 'told once, when the globe went');
    assert.deepEqual(flips, [false], 'hidden once, never shown again');
    assert.equal(blocksScene().active, true);
    assert.equal(controller.getStatus().state, 'ready');
    // Turning the toggle off is what ends it.
    layers.set(false);
    assert.equal(viewer.scene.globe.show, true);
    assert.equal(blocksScene().active, false);
  } finally {
    off();
    controller.destroy();
  }
});

test('with the real grid, store and mesher: chunks meshed against their neighbours and handed to the renderer', async () => {
  const realGrid = await import('./grid.js');
  const { buildChunkMesh } = await import('./mesh.js');
  const { createChunk } = await import('./store.js');
  const { columnsFromHeights } = await import('./source.js');
  const N = realGrid.CHUNK_COLUMNS;
  const source = {
    regions: [],
    regionFor(lon, lat) {
      source.regions.push({ lon, lat });
      return Promise.resolve({ blockM: 10, source: 'Synthetic 10 m' });
    },
    loadChunk(region, ci, cj) {
      // A slope rising east, one block every 4 columns, continuous across chunks.
      const heights = new Float32Array(N * N);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++)
          heights[j * N + i] = 12 + ((ci * N + i) * 10) / 4;
      return Promise.resolve(
        createChunk({ ci, cj, ...columnsFromHeights(heights, region.blockM) }),
      );
    },
  };
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: realGrid,
    buildChunkMesh,
    radiusBlocks: 100,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  const region = renderer.calls.find(([k]) => k === 'region')[1];
  assert.equal(region.blockM, 10);
  // The origin snapped to the 10 m graticule near the camera.
  assert.ok(
    Math.abs(region.lon0 - LON0) < 0.001 &&
      Math.abs(region.lat0 - LAT0) < 0.001,
  );
  const ring = fineRing({ i: 0, j: 0, radius: 100, chunkColumns: N });
  assert.equal(renderer.shown.size, ring.length);
  for (const mesh of renderer.shown.values()) {
    assert.ok(mesh.indices.length > 0);
    assert.ok(mesh.opaqueIndexCount > 0);
    assert.equal(mesh.positions.length % 3, 0);
  }
  assert.equal(controller.getStatus().state, 'ready');
  assert.equal(controller.getStatus().blockM, 10);
  controller.destroy();
});

test('a chunk that fails is asked again after a backoff (2 s, 4 s, …), and given up after 6 tries', async () => {
  const { retryDelayMs, MAX_ATTEMPTS } = await import('./index.js');
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(retryDelayMs),
    [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  assert.equal(MAX_ATTEMPTS, 6);
  let clock = 1_000_000;
  let failures = 2; // 1:0 fails twice, then loads
  const source = fakeSource();
  const load = source.loadChunk;
  const asked = [];
  source.loadChunk = (region, ci, cj) => {
    if (ci === 1 && cj === 0) {
      asked.push(clock);
      if (failures-- > 0)
        return Promise.reject(
          Object.assign(new Error('busy'), { status: 503 }),
        );
    }
    return load(region, ci, cj);
  };
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  let ticking = null;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const controller = createBlocksController({
      viewer: fakeViewer(),
      store,
      layers: fakeLayers(true),
      source,
      renderer,
      grid: fakeGrid,
      buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
      radiusBlocks: 64,
      now: () => clock,
      setIntervalImpl: (fn) => (ticking = fn),
      clearIntervalImpl: () => (ticking = null),
    });
    await drain(controller);
    assert.equal(asked.length, 1);
    assert.ok(!renderer.shown.has('1:0'));
    assert.equal(controller.getStatus().failed, 1);
    assert.ok(ticking, 'a retry to come keeps the tick going');
    // Not before the backoff.
    clock += 1999;
    controller.tick();
    assert.equal(asked.length, 1);
    clock += 1;
    await drain(controller);
    assert.equal(asked.length, 2, 'asked again at 2 s');
    clock += 3999;
    controller.tick();
    assert.equal(asked.length, 2);
    clock += 1;
    await drain(controller);
    assert.equal(asked.length, 3, 'and at 4 s more');
    assert.ok(renderer.shown.has('1:0'), 'drawn once it loads');
    assert.equal(controller.getStatus().failed, 0);
    controller.destroy();

    // Always failing: given up after 6 tries, and the tick stops.
    failures = Infinity;
    asked.length = 0;
    const again = createBlocksController({
      viewer: fakeViewer(),
      store,
      layers: fakeLayers(true),
      source,
      renderer: fakeRenderer(),
      grid: fakeGrid,
      buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
      radiusBlocks: 64,
      now: () => clock,
      setIntervalImpl: (fn) => (ticking = fn),
      clearIntervalImpl: () => (ticking = null),
    });
    for (let n = 0; n < 12; n++) {
      clock += 60_000;
      await drain(again);
    }
    assert.equal(asked.length, 6);
    assert.equal(ticking, null, 'nothing left to wait for');
    again.destroy();
  } finally {
    console.warn = warn;
  }
});

/** A source with the coarse ring: loadCoarseChunk(region, gi, gj). */
function coarseSource({ hold = false, holdCoarse = false, blockM = 1 } = {}) {
  const base = fakeSource({ hold, blockM });
  const coarse = [];
  base.coarse = coarse;
  base.loadCoarseChunk = (region, gi, gj) => {
    // Its ground: lowest 5 + gi levels (coarse), a little higher inland.
    const chunk = {
      gi,
      gj,
      coarse: true,
      version: 0,
      topSolid: (i, j) => 5 + gi + ((i + j) % 3),
    };
    if (!holdCoarse) {
      coarse.push({ gi, gj });
      return Promise.resolve(chunk);
    }
    return new Promise((resolve) =>
      coarse.push({ gi, gj, resolve: () => resolve(chunk) }),
    );
  };
  return base;
}

test('the rings: fine chunks in whole 4 × 4 groups within R1, coarse groups out to R2 = 4·R1', async () => {
  const { groupRing, coarseKey, GROUP_CHUNKS, COARSE_REACH } =
    await import('./index.js');
  assert.equal(GROUP_CHUNKS, 4);
  assert.equal(COARSE_REACH, 4);
  const fine = fineRing({ i: 10, j: 20, radius: 512, chunkColumns: C });
  const groups = groupRing({ i: 10, j: 20, radius: 512, chunkColumns: C });
  // Every chunk of every group within R1, and nothing else.
  assert.equal(fine.length, groups.length * 16);
  const inGroups = new Set(groups.map(({ gi, gj }) => `${gi}:${gj}`));
  for (const { ci, cj } of fine) {
    const { gi, gj } = groupOf(ci, cj);
    assert.ok(inGroups.has(`${gi}:${gj}`), `${ci}:${cj}`);
  }
  // Nearest first, the camera's chunk at the head; a superset of chunkRing.
  assert.deepEqual(fine[0], { ci: 0, cj: 0, distance: 0 });
  for (let n = 1; n < fine.length; n++)
    assert.ok(fine[n].distance >= fine[n - 1].distance);
  const keys = new Set(fine.map(({ ci, cj }) => `${ci}:${cj}`));
  for (const { ci, cj } of chunkRing({
    i: 10,
    j: 20,
    radius: 512,
    chunkColumns: C,
  }))
    assert.ok(keys.has(`${ci}:${cj}`), `${ci}:${cj}`);
  // The coarse ring: groups (256 columns) within 2,048 columns.
  const far = groupRing({ i: 10, j: 20, radius: 2048, chunkColumns: C });
  assert.deepEqual(far[0], { gi: 0, gj: 0, distance: 0 });
  assert.ok(far.every((g) => g.distance <= 2048));
  assert.ok(far.length > 200 && far.length < 260, String(far.length));
  assert.ok(
    far.some((g) => g.gi === 8 && g.gj === 0),
    '2,048 columns east',
  );
  assert.ok(!far.some((g) => g.gi === 9 && g.gj === 0));
  assert.equal(coarseKey(-3, 2), 'c:-3:2');
  assert.deepEqual(groupOf(-1, 7), { gi: -1, gj: 1 });
});

test('the coarse ring: drawn at 4 × the block size from the group’s corner, removed when its 16 fine chunks are drawn, back when one goes', async () => {
  const source = coarseSource({ hold: true });
  const { controller, renderer, meshes, viewer } = setup({
    source,
    radiusBlocks: 128,
  });
  await settle();
  // Both pools start at once: 8 fine and 8 coarse in flight.
  assert.equal(source.loads.length, 8);
  assert.equal(source.coarse.length, 8);
  await drain(controller, 40);
  // No fine chunk has arrived: the inner groups are coarse for now.
  assert.ok(renderer.shown.has('c:0:0'));
  const coarseMesh = meshes.find(
    (m) => m.chunk.coarse && m.chunk.gi === 0 && m.chunk.gj === 0,
  );
  assert.equal(coarseMesh.options.blockM, 4, '4 × 1 m');
  assert.deepEqual(renderer.shown.get('c:0:0').origin, { x: 0, y: 0, z: 0 });
  assert.deepEqual(renderer.shown.get('c:1:-1').origin, {
    x: 256,
    y: -256,
    z: 0,
  });
  assert.equal(controller.getStatus().chunks, 0);
  assert.ok(controller.getStatus().coarse > 0);
  // The fine chunks arrive: R1 = 128 columns takes the four groups around
  // the camera (−1 … 0 each way); their coarse chunks go, the rest stay.
  for (let n = 0; n < 60; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  for (let ci = -4; ci < 4; ci++)
    for (let cj = -4; cj < 4; cj++)
      assert.ok(renderer.shown.has(`${ci}:${cj}`));
  for (const key of ['c:0:0', 'c:-1:0', 'c:0:-1', 'c:-1:-1'])
    assert.ok(!renderer.shown.has(key), `${key} covered: removed`);
  assert.ok(
    renderer.calls.some(([k, key]) => k === 'remove' && key === 'c:0:0'),
  );
  assert.ok(renderer.shown.has('c:1:0'), 'beyond R1: still coarse');
  assert.equal(controller.getStatus().chunks, 64);
  // Everything arrives; then the camera moves 500 m east: group 0:0's fine
  // chunks are dropped (244 columns behind, past 1.25 × 128 = 160) while
  // its coarse chunk is kept (within 1.25 × 512) and comes back from its
  // kept mesh, without the mesher.
  for (let n = 0; n < 60; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  await drain(controller);
  const meshedBefore = meshes.filter(
    (m) => m.chunk.coarse && m.chunk.gi === 0 && m.chunk.gj === 0,
  ).length;
  viewer.moveTo(east(500));
  for (let n = 0; n < 60; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  await drain(controller);
  assert.ok(!renderer.shown.has('0:0'), 'the fine chunk dropped');
  assert.ok(renderer.shown.has('c:0:0'), 'the coarse one back');
  // Back from its kept mesh, or meshed once more where its inputs changed:
  // the groups beside it went from fine to coarse, so its skirts and the
  // neighbours it culls against moved on.
  assert.ok(
    meshes.filter((m) => m.chunk.coarse && m.chunk.gi === 0 && m.chunk.gj === 0)
      .length <=
      meshedBefore + 1,
    'at most once more',
  );
  // No group is drawn both ways once settled.
  for (const key of renderer.shown.keys()) {
    if (!key.startsWith('c:')) continue;
    const [gi, gj] = key.slice(2).split(':').map(Number);
    let all = true;
    for (let ci = gi * 4; ci < gi * 4 + 4; ci++)
      for (let cj = gj * 4; cj < gj * 4 + 4; cj++)
        all &&= renderer.shown.has(`${ci}:${cj}`);
    assert.ok(!all, `${key} drawn over its fine chunks`);
  }
  controller.destroy();
  assert.equal(renderer.shown.size, 0);
});

test('fog from the far ring: 0.7 to 1 × R2 with the coarse ring, × R1 without; and the status line', async () => {
  const { fogFor } = await import('./index.js');
  assert.deepEqual(fogFor(512, 1, true), { startM: 0.7 * 2048, endM: 2048 });
  assert.deepEqual(fogFor(512, 1, false), { startM: 0.7 * 512, endM: 512 });
  assert.deepEqual(fogFor(512, 30, true), {
    startM: 0.7 * 61_440,
    endM: 61_440,
  });
  const withCoarse = setup({ source: coarseSource(), radiusBlocks: 64 });
  await drain(withCoarse.controller);
  const fog = withCoarse.renderer.calls.find(([k]) => k === 'fog')[1];
  assert.deepEqual(fog, { startM: 0.7 * 256, endM: 256 });
  const status = withCoarse.controller.getStatus();
  assert.ok(status.chunks > 0 && status.coarse > 0);
  assert.equal(
    blocksStatusText({ ...status, sunFixed: false }),
    `Blocks: 1 m cubes · ${status.chunks} + ${status.coarse} coarse · 3DEP 1 m`,
  );
  assert.equal(
    blocksStatusText({
      state: 'ready',
      blockM: 1,
      chunks: 274,
      coarse: 48,
      source: '3DEP 1 m',
    }),
    'Blocks: 1 m cubes · 274 + 48 coarse · 3DEP 1 m',
  );
  withCoarse.controller.destroy();
  const without = setup({ radiusBlocks: 64 });
  await drain(without.controller);
  assert.deepEqual(without.renderer.calls.find(([k]) => k === 'fog')[1], {
    startM: 0.7 * 64,
    endM: 64,
  });
  assert.equal(without.controller.getStatus().coarse, 0);
  without.controller.destroy();
});

test('the world for Walk and Fly: the region, its loaded chunks and the datum offset; none while Blocks is off', async () => {
  const terrain = fakeDatum({ flat: false, undulation: -33.2 });
  const { controller, store } = setup({ datum: terrain, radiusBlocks: 64 });
  assert.equal(controller.world(), null, 'no region yet');
  await drain(controller);
  const world = controller.world();
  assert.equal(world.region, controller._state().region.region);
  assert.equal(world.geoidM, -33.2);
  const [key, entry] = [...controller._state().chunks].find(([, e]) => e.chunk);
  assert.equal(world.chunkAt(entry.ci, entry.cj), entry.chunk, key);
  assert.equal(world.chunkAt(9999, 9999), null, 'not loaded');
  store.setMode('colour');
  assert.equal(controller.world(), null);
  controller.destroy();
});

test('skirts: a fine chunk with no fine neighbour beyond a border hangs its sides down to the lowest coarse level there (coarse chunks keep the region’s levels)', async () => {
  const { SKIRT_SIDES } = await import('./index.js');
  assert.deepEqual(
    SKIRT_SIDES.map(([name]) => name),
    ['n', 's', 'e', 'w'],
  );
  const source = coarseSource();
  const { controller, meshes } = setup({ source, radiusBlocks: 128 });
  await drain(controller);
  // R1 = 128 columns: fine groups −1 … 0 each way, chunks −4 … 3.
  const last = (key) => meshes.filter((m) => m.key === key).at(-1).options;
  // The east edge of group 0: chunk 4:0 is not fine, c:1:0 is beyond (lowest 6).
  assert.deepEqual(last('3:0').skirt, { n: null, s: null, e: 6, w: null });
  // The north-west corner: skirts on two sides, from c:-1:1 (lowest 4) and c:-2:0 (3).
  assert.deepEqual(last('-4:3').skirt, { n: 4, s: null, e: null, w: 3 });
  // Inside the fine ring: none.
  assert.equal(last('1:1').skirt, undefined);
  // Coarse chunks toward other coarse chunks: none.
  const coarse = meshes.filter((m) => m.chunk.coarse);
  assert.ok(coarse.length > 0);
  const lastCoarse = (gi, gj) =>
    meshes
      .filter((m) => m.chunk.coarse && m.chunk.gi === gi && m.chunk.gj === gj)
      .at(-1).options;
  assert.equal(lastCoarse(2, 0).skirt, undefined, 'only coarse around it');
  controller.destroy();
});

test('coarse skirts: a coarse chunk beside a group drawn fine drops that neighbour and hangs a skirt to the lowest fine ground there', async () => {
  const source = coarseSource();
  // Fine ground: level 9 everywhere (fakeSource chunks get a topSolid here).
  const load = source.loadChunk;
  source.loadChunk = (region, ci, cj) =>
    load(region, ci, cj).then((chunk) => ({ ...chunk, topSolid: () => 9 }));
  const { controller, meshes } = setup({ source, radiusBlocks: 128 });
  await drain(controller);
  const lastCoarse = (gi, gj) =>
    meshes
      .filter((m) => m.chunk.coarse && m.chunk.gi === gi && m.chunk.gj === gj)
      .at(-1).options;
  // c:1:0 has group 0:0 (drawn fine) to its west: level 9 there (the same
  // levels), and its west neighbour (the hidden c:0:0) left out.
  const east = lastCoarse(1, 0);
  assert.deepEqual(east.skirt, { n: null, s: null, e: null, w: 9 });
  assert.equal(east.neighbours.w, undefined, 'the hidden coarse chunk dropped');
  assert.ok(east.neighbours.e, 'its coarse neighbour kept');
  // c:-2:-1 has group −1:−1 to its east.
  assert.deepEqual(lastCoarse(-2, -1).skirt, {
    n: null,
    s: null,
    e: 9,
    w: null,
  });
  // c:0:1 has group 0:0 to its south.
  assert.deepEqual(lastCoarse(0, 1).skirt, { n: null, s: 9, e: null, w: null });
  // Beyond: coarse all round, none.
  assert.equal(lastCoarse(2, 0).skirt, undefined);
  controller.destroy();
});

test('skirts wait for what is coming: none toward a fine neighbour still loading; meshed again when the coarse chunk beyond arrives', async () => {
  // The coarse ring held: the fine edge is meshed bare, then again with its skirt.
  const source = coarseSource({ holdCoarse: true });
  const { controller, meshes } = setup({ source, radiusBlocks: 128 });
  await drain(controller, 40);
  const ofEdge = () => meshes.filter((m) => m.key === '3:0');
  assert.ok(ofEdge().length >= 1);
  assert.equal(ofEdge().at(-1).options.skirt, undefined, 'nothing beyond yet');
  for (let n = 0; n < 40; n++) {
    source.coarse.forEach((c) => c.resolve?.());
    await settle();
    controller.tick();
  }
  await drain(controller);
  assert.deepEqual(ofEdge().at(-1).options.skirt, {
    n: null,
    s: null,
    e: 6,
    w: null,
  });
  controller.destroy();

  // A fine neighbour loading: no skirt toward it (it will cull the border).
  const held = coarseSource({ hold: true });
  const run = setup({ source: held, radiusBlocks: 128 });
  await settle();
  // Let only chunk 0:0 arrive; its neighbours are loading or not asked.
  held.loads.find((l) => l.ci === 0 && l.cj === 0).resolve();
  for (let n = 0; n < 5; n++) {
    await settle();
    run.controller.tick();
  }
  // Its neighbours are still loading: it waits (and so hangs no skirt
  // toward them).
  assert.equal(
    run.meshes.find((m) => m.key === '0:0'),
    undefined,
    'not meshed while its neighbours load',
  );
  run.controller.destroy();
});

/** A mesher whose jobs wait until released: meshAsync for the controller. */
function deferredMesher() {
  const jobs = [];
  return {
    jobs,
    meshAsync(chunk, options) {
      return new Promise((resolve, reject) =>
        jobs.push({
          chunk,
          options,
          version: chunk.version,
          resolve: () => resolve({ faces: 1, chunk, from: chunk.version }),
          reject,
        }),
      );
    },
  };
}

function asyncSetup({ source = fakeSource(), radiusBlocks = 64 } = {}) {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const renderer = fakeRenderer();
  const mesher = deferredMesher();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: () => {
      throw new Error('in-thread mesher used');
    },
    meshAsync: mesher.meshAsync,
    radiusBlocks,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  return { controller, viewer, renderer, mesher, store, source };
}

/** What a job was asked to mesh from: the chunk, its version, neighbours and skirts. */
const inputsOf = (job) =>
  [
    `${job.chunk.ci}:${job.chunk.cj}`,
    job.version,
    Object.keys(job.options.neighbours)
      .sort()
      .map((name) => `${name}${job.options.neighbours[name].version}`)
      .join(','),
    JSON.stringify(job.options.skirt ?? null),
  ].join('|');

/** Tick until every chunk in range is loaded (the mesher holds its jobs). */
async function loadAll(controller, ticks = 40) {
  for (let n = 0; n < ticks; n++) {
    await settle();
    controller.tick();
  }
}

test('pooled meshing: at most the budget submitted a tick, none twice for the same inputs, drawn when they come back', async () => {
  const { controller, renderer, mesher } = asyncSetup({ radiusBlocks: 128 });
  await settle();
  controller.tick();
  const { ASYNC_BUDGET } = await import('./index.js');
  assert.ok(mesher.jobs.length <= ASYNC_BUDGET, 'the first tick');
  await loadAll(controller);
  // Submitted, not drawn yet; each set of inputs once (a chunk is asked
  // again when a neighbour arrives, and the older answer is then dropped).
  assert.ok(mesher.jobs.length > 0);
  assert.equal(renderer.shown.size, 0);
  const asked = mesher.jobs.map(inputsOf);
  assert.equal(new Set(asked).size, asked.length, 'no inputs twice');
  // Settled inputs: another tick submits nothing new for them.
  const before = mesher.jobs.length;
  controller.tick();
  controller.tick();
  assert.ok(mesher.jobs.length - before <= 2 * ASYNC_BUDGET);
  // Released, newest first per chunk: drawn, and the status counts them.
  const latest = new Map();
  for (const job of mesher.jobs)
    latest.set(`${job.chunk.ci}:${job.chunk.cj}`, job);
  for (const job of latest.values()) job.resolve();
  await settle();
  assert.ok(renderer.shown.has('0:0'));
  assert.ok(controller.getStatus().chunks >= 1);
  controller.destroy();
});

test('pooled meshing drops a mesh whose chunk moved on, was dropped, or whose region was anchored again', async () => {
  const { controller, renderer, mesher, viewer } = asyncSetup({
    radiusBlocks: 64,
  });
  await loadAll(controller);
  const ofOrigin = () =>
    mesher.jobs.filter((j) => j.chunk.ci === 0 && j.chunk.cj === 0);
  // Moved on: an edit after submitting; the stale mesh is not drawn and
  // the chunk is submitted again from what it is now.
  const job = ofOrigin().at(-1);
  job.chunk.version = 7;
  const asked = ofOrigin().length;
  job.resolve();
  await settle();
  assert.ok(!renderer.shown.has('0:0'), 'stale mesh dropped');
  controller.tick();
  assert.equal(ofOrigin().length, asked + 1, 'submitted again');
  assert.equal(ofOrigin().at(-1).version, 7);
  ofOrigin().at(-1).resolve();
  await settle();
  assert.ok(renderer.shown.has('0:0'));
  // Re-anchored (25 km away): everything pending is thrown away.
  const pending = mesher.jobs.filter(
    (j) => !renderer.shown.has(`${j.chunk.ci}:${j.chunk.cj}`),
  );
  assert.ok(pending.length > 0);
  viewer.moveTo(east(25_000));
  controller.tick();
  await settle();
  const upsertsBefore = renderer.calls.filter(([k]) => k === 'upsert').length;
  for (const j of pending) j.resolve();
  await settle();
  assert.equal(
    renderer.calls.filter(([k]) => k === 'upsert').length,
    upsertsBefore,
    'nothing from the old region drawn',
  );
  controller.destroy();
});

test('the pool’s worker path (snapshot, structured clone, restore) meshes a chunk with buildings as the in-thread mesher does', async () => {
  const { buildChunkMesh } = await import('./mesh.js');
  const { createChunk } = await import('./store.js');
  const { createMeshPool } = await import('./meshPool.js');
  const { runMeshJob } = await import('./meshJob.js');
  const { applyStructures } = await import('./structures.js');
  const N = 64;
  const top = new Int32Array(N * N).fill(10);
  const material = new Uint8Array(N * N).fill(1);
  const water = new Int32Array(N * N).fill(-2147483648);
  const chunk = createChunk({ ci: 0, cj: 0, top, material, water });
  const east = createChunk({
    ci: 1,
    cj: 0,
    top: top.slice(),
    material: material.slice(),
    water: water.slice(),
  });
  // A building over an 8 × 6 footprint, levels 11 to 22, with a hollow
  // under part of it (min_height: from level 16).
  const levels = {
    top: new Int32Array(N * N).fill(-2147483648),
    bottom: new Int32Array(N * N).fill(-2147483648),
  };
  for (let j = 20; j < 26; j++)
    for (let i = 30; i < 38; i++) {
      levels.top[j * N + i] = 22;
      levels.bottom[j * N + i] = i < 34 ? 11 : 16;
    }
  assert.ok(applyStructures(chunk, levels) > 0);
  assert.ok(chunk.structure, 'the store holds the buildings');
  // A worker that does what meshWorker.js does, across a structured clone.
  const fakeWorker = () => {
    const listeners = { message: [], error: [] };
    return {
      addEventListener: (type, fn) => listeners[type].push(fn),
      postMessage({ id, job }) {
        const copy = structuredClone(job);
        queueMicrotask(() => {
          const mesh = runMeshJob(copy);
          for (const fn of listeners.message) fn({ data: { id, mesh } });
        });
      },
      terminate() {},
    };
  };
  const pool = createMeshPool({ size: 1, createWorker: fakeWorker });
  const options = {
    neighbours: { e: east },
    blockM: 1,
    sunDir: STUDY_SUN.dir,
    skirt: { n: 4, s: null, e: null, w: 4 },
  };
  const pooled = await pool.meshChunkAsync(chunk, options);
  const direct = buildChunkMesh(chunk, options);
  assert.equal(pooled.faces, direct.faces);
  assert.deepEqual([...pooled.positions], [...direct.positions]);
  assert.deepEqual([...pooled.colors], [...direct.colors]);
  assert.deepEqual([...pooled.indices], [...direct.indices]);
  // And the building is in it: more faces than the bare chunk.
  const bare = createChunk({
    ci: 0,
    cj: 0,
    top: top.slice(),
    material: material.slice(),
    water: water.slice(),
  });
  assert.ok(direct.faces > buildChunkMesh(bare, options).faces);
  pool.destroy?.();
});

/** Real store chunks (flat ground at level 10) and real buildings. */
async function buildingsSetup({
  structuresError = null,
  radiusBlocks = 64,
  holdIds = false,
} = {}) {
  const idWaits = [];
  const { createChunk } = await import('./store.js');
  const { applyStructures } = await import('./structures.js');
  const N = 64;
  const source = {
    regionFor: () => Promise.resolve({ blockM: 1, source: '3DEP 1 m' }),
    loadChunk: (region, ci, cj) =>
      Promise.resolve(
        createChunk({
          ci,
          cj,
          top: new Int32Array(N * N).fill(10),
          material: new Uint8Array(N * N).fill(1),
          water: new Int32Array(N * N).fill(-2147483648),
        }),
      ),
    loadCoarseChunk: (region, gi, gj) =>
      Promise.resolve({ gi, gj, coarse: true, version: 0, topSolid: () => 2 }),
  };
  const asked = [];
  const structures = {
    loadChunk(region, ci, cj) {
      asked.push(`${ci}:${cj}`);
      if (structuresError) return Promise.reject(structuresError);
      // A 4 × 4 building, 20 blocks tall over the ground (level 10), in
      // every chunk's corner: levels 11 to 30.
      const top = new Int32Array(N * N).fill(-2147483648);
      const bottom = new Int32Array(N * N).fill(-2147483648);
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          top[j * N + i] = 30;
          bottom[j * N + i] = 11;
        }
      return Promise.resolve({ top, bottom });
    },
    groupBuildings: (region, gi, gj) => {
      const ids = [`way/${gi}:${gj}:a`, `way/${gi}:${gj}:b`, 'way/shared'];
      if (!holdIds) return Promise.resolve(ids);
      return new Promise((resolve) => idWaits.push(() => resolve(ids)));
    },
    apply: applyStructures,
  };
  const viewer = fakeViewer();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  const meshes = [];
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    structures,
    renderer,
    grid: fakeGrid,
    buildChunkMesh(chunk, options) {
      meshes.push({
        key: chunk.coarse
          ? `c:${chunk.gi}:${chunk.gj}`
          : `${chunk.ci}:${chunk.cj}`,
        chunk,
        version: chunk.version,
        options,
      });
      return { faces: 1, chunk };
    },
    radiusBlocks,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  return { controller, store, renderer, meshes, asked, idWaits, viewer };
}

test('buildings: asked for every fine chunk (never the coarse ring), put into its structures layer, the chunk meshed again; counted once each', async () => {
  const { controller, meshes, asked } = await buildingsSetup();
  await drain(controller);
  const fine = fineRing({ i: 0, j: 0, radius: 64, chunkColumns: C });
  assert.equal(new Set(asked).size, fine.length, 'every fine chunk');
  assert.ok(asked.every((key) => !key.startsWith('c:')));
  // 0:0 is drawn with its building (its version moved on when it came).
  const ofOrigin = meshes.filter((m) => m.key === '0:0');
  assert.ok(ofOrigin.length >= 1);
  assert.ok(ofOrigin.at(-1).version > 0);
  assert.equal(
    ofOrigin.at(-1).chunk.structureTop(0, 0),
    30,
    'level 10 + 20 blocks',
  );
  // Four fine groups, two buildings each and one they share: 9.
  const status = controller.getStatus();
  assert.equal(status.buildings, 9);
  assert.equal(status.buildingsOn, true);
  assert.equal(controller.getBuildings(), true, 'unchosen: on');
  assert.match(
    blocksStatusText({ ...status, sunFixed: false }),
    /· 9 buildings$/,
  );
  assert.equal(
    blocksStatusText({
      state: 'ready',
      blockM: 1,
      chunks: 274,
      coarse: 48,
      source: '3DEP 1 m',
      buildings: 1204,
    }),
    'Blocks: 1 m cubes · 274 + 48 coarse · 3DEP 1 m · 1,204 buildings',
  );
  controller.destroy();
});

test('the Buildings switch: off takes them off every chunk in place (meshed again, nothing asked); on puts them back', async () => {
  const { controller, store, meshes, asked } = await buildingsSetup();
  await drain(controller);
  const chunk = meshes.find((m) => m.key === '0:0').chunk;
  assert.equal(chunk.structureTop(0, 0), 30);
  const askedBefore = asked.length;
  const meshedBefore = meshes.filter((m) => m.key === '0:0').length;
  store.setBuildings(false);
  await drain(controller);
  assert.equal(chunk.structureTop(0, 0), -2147483648, 'cleared in place');
  assert.ok(
    meshes.filter((m) => m.key === '0:0').length > meshedBefore,
    'meshed again',
  );
  assert.equal(asked.length, askedBefore, 'nothing asked while off');
  assert.equal(controller.getStatus().buildings, 0);
  assert.equal(controller.getBuildings(), false);
  assert.equal(store.param(), '1.b0');
  store.setBuildings(true);
  await drain(controller);
  assert.equal(chunk.structureTop(0, 0), 30, 'back');
  assert.equal(controller.getStatus().buildings, 9);
  controller.destroy();
});

test('Overpass not configured: buildings end for the page, the switch says why', async () => {
  const error = Object.assign(new Error('not configured'), {
    code: 'unconfigured',
  });
  const { controller, asked } = await buildingsSetup({
    structuresError: error,
  });
  await drain(controller);
  const askedOnce = asked.length;
  assert.ok(askedOnce >= 1 && askedOnce <= CHUNK_BUDGET);
  for (let n = 0; n < 5; n++) controller.tick();
  await drain(controller);
  assert.equal(asked.length, askedOnce, 'not asked again');
  assert.equal(controller.buildingsAvailable(), false);
  assert.equal(controller.getBuildings(), false);
  assert.equal(controller.getStatus().buildingsOn, false);
  assert.equal(
    controller.getStatus().state,
    'ready',
    'the terrain still drawn',
  );
  controller.destroy();
});

test('the heading control: a Buildings switch in Blocks, disabled where Overpass is missing', async () => {
  const { createLegoHeadingControl } = await import('../lego/presentation.js');
  const store = createRenderModeStore({ storage: memoryStorage() });
  const lego = {
    getMode: () => store.getMode(),
    setMode: (mode) => store.setMode(mode),
    getExaggeration: () => 1,
    setExaggeration: () => {},
    getStatus: () => ({ state: 'off' }),
    subscribe: (listener) => store.subscribe(listener),
  };
  let available = true;
  const listeners = new Set();
  const blocks = {
    getStatus: () => ({
      state: 'ready',
      blockM: 1,
      chunks: 4,
      source: '',
      buildings: 0,
    }),
    getBuildings: () => available && store.getBuildings() !== false,
    setBuildings: (on) => store.setBuildings(on),
    buildingsAvailable: () => available,
    subscribe: (listener) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
  };
  const nodes = [];
  const element = (tag) => {
    const handlers = new Map();
    const node = {
      tag,
      children: [],
      hidden: false,
      setAttribute() {},
      append: (...kids) => node.children.push(...kids),
      appendChild: (kid) => node.children.push(kid),
      addEventListener: (type, fn) => handlers.set(type, fn),
      removeEventListener: (type) => handlers.delete(type),
      fire: (type) => handlers.get(type)?.({ stopPropagation() {} }),
    };
    nodes.push(node);
    return node;
  };
  const doc = {
    createElement: element,
    createTextNode: (text) => ({ textContent: text }),
  };
  const control = createLegoHeadingControl(doc, lego, null, blocks);
  const label = nodes.find((n) => n.className === 'blocks-buildings-toggle');
  const box = label.children[0];
  assert.equal(label.children[1].textContent, ' Buildings');
  assert.equal(label.hidden, true, 'hidden in Colour');
  store.setMode('blocks');
  assert.equal(label.hidden, false);
  assert.equal(box.checked, true, 'unchosen: on');
  box.checked = false;
  box.fire('change');
  assert.equal(store.getBuildings(), false);
  assert.equal(box.checked, false);
  // Overpass missing: unchecked and disabled, with the reason.
  available = false;
  for (const listener of listeners) listener();
  assert.equal(box.disabled, true);
  assert.equal(box.checked, false);
  assert.equal(label.title, 'Buildings need an Overpass server for this app');
  control.destroy();
});

/** The fake camera's height above the ellipsoid, metres. */
const setHeight = (viewer, height) => {
  viewer.camera.positionCartographic = {
    ...viewer.camera.positionCartographic,
    height,
  };
};

test('the ceiling: 4 × R2 × the block size (8 km at 1 m), the top level’s before a region; in flight means a Cesium flight or an arrival correction', async () => {
  const { ceilingM, cameraInFlight, TOP_LEVEL_M } = await import('./index.js');
  const { ownCameraArrival } = await import('../../data/cameraArrival.js');
  assert.equal(ceilingM(1, 512), 8192);
  assert.equal(ceilingM(30, 512), 245_760);
  assert.equal(TOP_LEVEL_M, 30_720);
  assert.equal(ceilingM(undefined, 512), 251_658_240, '251,658 km');
  const viewer = { camera: {} };
  assert.equal(cameraInFlight(viewer), false);
  viewer.camera._currentFlight = {};
  assert.equal(cameraInFlight(viewer), true);
  viewer.camera._currentFlight = undefined;
  const release = ownCameraArrival(viewer, () => {});
  assert.equal(cameraInFlight(viewer), true, 'the ground guard owns it');
  release();
  assert.equal(cameraInFlight(viewer), false);
});

test('from orbit with a source without levels and no footprint: one probe, nothing loaded, the globe kept; the region’s own ceiling holds until the camera comes down', async () => {
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  setHeight(viewer, 17_000_000);
  const renderer = fakeRenderer();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    flatStyle: () => true,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  // The pyramid's top bounds nothing on Earth, so a region is asked for;
  // it is 1 m and cannot follow the view, so its own ceiling holds it.
  assert.equal(source.regions.length, 1, 'one probe');
  assert.equal(source.loads.length, 0, 'nothing loaded');
  assert.equal(viewer.scene.globe.show, true, 'the globe stays');
  assert.equal(controller.getStatus().state, 'too-high');
  assert.equal(
    blocksStatusText(controller.getStatus()),
    'Blocks: come below 1 km to build',
  );
  // Down to 300 m and settled: building.
  setHeight(viewer, 300);
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 1);
  assert.ok(renderer.shown.size > 0);
  assert.equal(viewer.scene.globe.show, false);
  // Back up above 4 × R2 × 1 m (= 1,024 m at R1 64): nothing more asked;
  // what is drawn stays.
  const loads = source.loads.length;
  const shown = renderer.shown.size;
  viewer.moveTo(east(3000));
  setHeight(viewer, 2000);
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.loads.length, loads, 'no loads above the ceiling');
  assert.equal(renderer.shown.size, shown);
  assert.equal(controller.getStatus().state, 'too-high');
  assert.equal(controller.getStatus().ceilingM, 1024);
  assert.equal(viewer.scene.globe.show, true, 'the globe back while held');
  controller.destroy();
});

test('in flight: held however low; anchored once it lands, with or without a moveEnd; the first anchor waits for the camera to settle', async () => {
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  let flying = true;
  let ticker = null;
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    inFlight: () => flying,
    radiusBlocks: 64,
    setIntervalImpl: (fn) => (ticker = fn),
    clearIntervalImpl: () => (ticker = null),
  });
  await drain(controller);
  assert.equal(source.regions.length, 0, 'held in flight at 300 m');
  assert.equal(controller.getStatus().state, 'flying');
  assert.equal(
    blocksStatusText(controller.getStatus()),
    'Blocks: waiting for the camera to land',
  );
  assert.ok(ticker, 'ticking until it lands');
  // The arrival correction ends without moving the camera: the tick anchors.
  flying = false;
  ticker();
  await settle();
  assert.equal(source.regions.length, 1, 'anchored on landing');
  controller.destroy();

  // Not in flight but moving (a user's drag): the first region waits for
  // the camera to settle.
  const moving = fakeSource();
  const viewer2 = fakeViewer();
  const layers = fakeLayers(false);
  let ticker2 = null;
  const second = createBlocksController({
    viewer: viewer2,
    store,
    layers,
    source: moving,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    inFlight: () => false,
    radiusBlocks: 64,
    setIntervalImpl: (fn) => (ticker2 = fn),
    clearIntervalImpl: () => (ticker2 = null),
  });
  viewer2.camera.moveStart.raise();
  layers.set(true); // Elevation comes on mid-move
  ticker2?.();
  await settle();
  assert.equal(moving.regions.length, 0, 'not anchored mid-move');
  assert.ok(ticker2, 'ticking while it moves');
  viewer2.camera.moveEnd.raise();
  await settle();
  assert.equal(moving.regions.length, 1, 'anchored on moveEnd');
  second.destroy();
});

test('no coarse chunks asked for a supergroup whose 16 groups all lie within R1', async () => {
  const source = coarseSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  // supergroupGroups: the region is anchored 512 m south-west of the
  // camera, so the camera sits mid-supergroup (0, 0): columns 512, 512.
  const viewer = fakeViewer();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    supergroupGroups: 4,
    radiusBlocks: 512,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller, 400);
  const asked = new Set(source.coarse.map(({ gi, gj }) => `${gi}:${gj}`));
  assert.ok(asked.size > 0, 'the coarse ring is asked for');
  for (let gi = 0; gi < 4; gi++)
    for (let gj = 0; gj < 4; gj++)
      assert.ok(!asked.has(`${gi}:${gj}`), `${gi}:${gj} is all fine`);
  // A supergroup that reaches past R1 is still asked for, inner groups too.
  assert.ok(asked.has('4:0') || asked.has('4:1'));
  assert.ok(asked.has('-1:0'));
  controller.destroy();

  // Without the option, nothing is skipped.
  const plain = coarseSource();
  const again = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source: plain,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    radiusBlocks: 512,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(again, 400);
  assert.ok(plain.coarse.some(({ gi, gj }) => gi === 1 && gj === 1));
  again.destroy();
});

test('the sun is read again at the camera every minute: the study-sun flag follows the day, and a new light meshes again', async () => {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const renderer = fakeRenderer();
  const meshes = [];
  const up = (deg) => ({
    east: 0,
    north: -Math.cos(deg * RAD),
    up: Math.sin(deg * RAD),
  });
  // At anchoring the real sun is under 15°: the study sun.
  let light = { dir: up(45), fixed: true };
  const reads = [];
  const sunTimer = { callback: null, ms: 0, cleared: 0 };
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source: fakeSource(),
    renderer,
    grid: fakeGrid,
    radiusBlocks: 64,
    buildChunkMesh(chunk, options) {
      meshes.push({ key: `${chunk.ci}:${chunk.cj}`, sunDir: options.sunDir });
      return { faces: 1, chunk };
    },
    sun(lon, lat) {
      reads.push([lon, lat]);
      return light;
    },
    setIntervalImpl: () => 1,
    clearIntervalImpl() {},
    setSunIntervalImpl(callback, ms) {
      sunTimer.callback = callback;
      sunTimer.ms = ms;
      return 7;
    },
    clearSunIntervalImpl() {
      sunTimer.callback = null;
      sunTimer.cleared++;
    },
  });
  await drain(controller);
  assert.equal(controller.getStatus().sunFixed, true);
  assert.equal(sunTimer.ms, SUN_TICK_MS);
  assert.equal(SUN_TICK_MS, 60_000);
  assert.ok(
    Math.abs(reads[0][0] - LON0) < 1e-9 && Math.abs(reads[0][1] - LAT0) < 1e-9,
  );
  const meshedFirst = meshes.length;
  assert.ok(meshedFirst > 0);
  // A minute on, the same light: nothing changes.
  sunTimer.callback();
  await drain(controller);
  assert.equal(meshes.length, meshedFirst);
  // The sun has risen past 15°, and the camera moved: read at the camera,
  // the flag goes, the renderer is told, and every chunk is meshed again.
  viewer.moveTo(LON0 + 0.0001, LAT0);
  light = { dir: up(20), fixed: false };
  sunTimer.callback();
  assert.ok(Math.abs(reads.at(-1)[0] - (LON0 + 0.0001)) < 1e-9);
  assert.equal(controller.getStatus().sunFixed, false);
  assert.deepEqual(
    renderer.calls.filter(([kind]) => kind === 'sun').at(-1)[2],
    {
      fixed: false,
    },
  );
  await drain(controller);
  const remeshed = meshes.slice(meshedFirst);
  // Every chunk drawn is meshed again (the first pass meshed some twice, as
  // their neighbours arrived).
  const drawn = new Set(meshes.slice(0, meshedFirst).map((m) => m.key));
  assert.deepEqual(new Set(remeshed.map((m) => m.key)), drawn);
  assert.ok(remeshed.every((m) => m.sunDir.up === light.dir.up));
  // A degree later: under SUN_REMESH_DEG, no meshing; four degrees: again.
  const before = meshes.length;
  light = { dir: up(21), fixed: false };
  assert.equal(controller.refreshSun(), false);
  await drain(controller);
  assert.equal(meshes.length, before);
  assert.ok(SUN_REMESH_DEG >= 1 && SUN_REMESH_DEG < 4);
  light = { dir: up(24), fixed: false };
  assert.equal(controller.refreshSun(), true);
  await drain(controller);
  assert.ok(meshes.length > before);
  // Destroying stops the sun's interval.
  controller.destroy();
  assert.equal(sunTimer.callback, null);
  assert.ok(sunTimer.cleared >= 1);
});

test('a region is anchored half a supergroup south-west of the camera, so the camera stands mid-supergroup', async () => {
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    supergroupGroups: 4,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  const region = renderer.calls.find(([k]) => k === 'region')[1];
  // 4 groups × 4 chunks × 64 columns / 2 = 512 m at 1 m blocks.
  const local = region.toLocal(LON0, LAT0);
  assert.ok(Math.abs(local.x - 512) < 0.5, String(local.x));
  assert.ok(Math.abs(local.y - 512) < 0.5, String(local.y));
  // The source is still asked about the camera's own place.
  assert.ok(Math.abs(source.regions[0].lon - LON0) < 1e-12);
  // The camera's own chunk is asked for first (7 or 8 a side: the camera
  // stands on the line between them, within the rounding of a degree).
  assert.equal(source.loads[0].ci, Math.floor(local.x / 64));
  assert.equal(source.loads[0].cj, Math.floor(local.y / 64));
  assert.ok([7, 8].includes(source.loads[0].ci));
  controller.destroy();
});

test('with the pool: up to 24 loads and 24 mesh submits a tick, none while its queue is deeper than twice its workers', async () => {
  const { ASYNC_BUDGET, BACKLOG_PER_WORKER } = await import('./index.js');
  assert.equal(ASYNC_BUDGET, 24);
  assert.equal(BACKLOG_PER_WORKER, 2);
  let backlog = { waiting: 0, workers: 3 };
  const source = fakeSource({ hold: true });
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const mesher = deferredMesher();
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: () => {
      throw new Error('in-thread mesher used');
    },
    meshAsync: mesher.meshAsync,
    meshBacklog: () => backlog,
    radiusBlocks: 512,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await settle();
  assert.equal(source.loads.length, ASYNC_BUDGET, '24 loads in flight, not 8');
  // Loads arrive tick after tick: the most submitted in one tick is more
  // than the old 8 and never more than 24.
  let most = 0;
  for (let n = 0; n < 12; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    const before = mesher.jobs.length;
    controller.tick();
    most = Math.max(most, mesher.jobs.length - before);
  }
  assert.ok(most > CHUNK_BUDGET, `more than the old 8 (${most})`);
  assert.ok(most <= ASYNC_BUDGET);
  // The pool's queue deep (7 > 2 × 3): nothing submitted, loads go on.
  backlog = { waiting: 7, workers: 3 };
  const submitted = mesher.jobs.length;
  for (let n = 0; n < 3; n++) {
    source.loads.forEach((l) => l.resolve());
    await settle();
    controller.tick();
  }
  assert.equal(mesher.jobs.length, submitted, 'held back');
  assert.ok(source.loads.length > ASYNC_BUDGET, 'loading went on');
  // Drained: submits again.
  backlog = { waiting: 0, workers: 3 };
  controller.tick();
  assert.ok(mesher.jobs.length > submitted);
  controller.destroy();
});

test('leaving Blocks keeps the region’s chunks hidden for 60 s (back is instant); then they go', async () => {
  const { PARK_MS } = await import('./index.js');
  assert.equal(PARK_MS, 60_000);
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  const visible = [];
  renderer.setVisible = (on) => visible.push(on);
  const timers = [];
  const meshes = [];
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh(chunk) {
      meshes.push(chunk);
      return { faces: 1, chunk };
    },
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  await drain(controller);
  const shown = renderer.shown.size;
  const loads = source.loads.length;
  const meshed = meshes.length;
  assert.ok(shown > 0);
  // Render: Colour: hidden, not dropped.
  store.setMode('colour');
  assert.deepEqual(visible, [false]);
  assert.equal(renderer.shown.size, shown, 'kept');
  assert.equal(controller._state().parked, true);
  assert.equal(controller.getStatus().state, 'off');
  assert.equal(timers.at(-1).ms, PARK_MS);
  // Back within the minute: shown at once, nothing asked or meshed again.
  store.setMode('blocks');
  await drain(controller);
  assert.deepEqual(visible, [false, true]);
  assert.equal(timers.at(-1).cleared, true);
  assert.equal(source.loads.length, loads);
  assert.equal(meshes.length, meshed);
  assert.equal(controller.getStatus().chunks, shown);
  // Away for the minute: evicted, and the renderer shown again for next time.
  store.setMode('colour');
  timers.at(-1).fn();
  assert.equal(renderer.shown.size, 0, 'evicted');
  assert.equal(visible.at(-1), true);
  assert.equal(controller._state().parked, false);
  assert.equal(controller._state().region, null);
  // Back after that: built afresh.
  store.setMode('blocks');
  await drain(controller);
  assert.equal(source.regions.length, 2);
  assert.ok(renderer.shown.size > 0);
  controller.destroy();

  // A renderer that cannot hide: dropped at once, as before.
  const plain = setup({ radiusBlocks: 64 });
  await drain(plain.controller);
  plain.store.setMode('colour');
  assert.equal(plain.renderer.shown.size, 0);
  plain.controller.destroy();
});

test('parked: a pooled mesh that lands after leaving Blocks is drawn into the hidden renderer, but Blocks stays off (no status, no HUD floor)', async () => {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  renderer.setVisible = () => {};
  const mesher = deferredMesher();
  const seen = [];
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source: fakeSource(),
    renderer,
    grid: fakeGrid,
    buildChunkMesh: () => {
      throw new Error('in-thread mesher used');
    },
    meshAsync: mesher.meshAsync,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    setTimeoutImpl: () => ({}),
    clearTimeoutImpl: () => {},
  });
  controller.subscribe((status) => seen.push(status.state));
  for (let n = 0; n < 20; n++) {
    await settle();
    controller.tick();
  }
  assert.ok(mesher.jobs.length > 0);
  // Render: Colour with the jobs still out.
  store.setMode('colour');
  assert.equal(controller.getStatus().state, 'off');
  const afterPark = seen.length;
  const upserts = renderer.calls.filter(([k]) => k === 'upsert').length;
  for (const job of mesher.jobs) job.resolve();
  await settle();
  assert.ok(
    renderer.calls.filter(([k]) => k === 'upsert').length > upserts,
    'drawn into the hidden renderer',
  );
  assert.equal(controller.getStatus().state, 'off', 'still off');
  assert.equal(seen.length, afterPark, 'no status from the late meshes');
  assert.equal(blocksFloorM(), null, 'no HUD floor in Colour');
  controller.destroy();
});

test('a failed mesh is tried again after the loads’ backoff; a rejected pooled mesh clears its job', async () => {
  let clock = 1_000_000;
  let fail = true;
  const meshes = [];
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const controller = createBlocksController({
      viewer: fakeViewer(),
      store,
      layers: fakeLayers(true),
      source: fakeSource(),
      renderer: fakeRenderer(),
      grid: fakeGrid,
      buildChunkMesh(chunk) {
        if (chunk.ci === 0 && chunk.cj === 0 && fail) {
          fail = false;
          throw new Error('mesher fell over');
        }
        meshes.push(`${chunk.ci}:${chunk.cj}`);
        return { faces: 1, chunk };
      },
      radiusBlocks: 64,
      now: () => clock,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
    });
    await drain(controller);
    const entry = controller._state().chunks.get('0:0');
    assert.equal(entry.failed, true);
    assert.equal(
      entry.retryAt,
      clock + 2000,
      'the loads’ backoff, not forever',
    );
    clock += 2000;
    await drain(controller);
    assert.ok(meshes.includes('0:0'), 'meshed on the second try');
    controller.destroy();

    // Pooled: a rejected job clears entry.meshing (no endless tick).
    const mesher = deferredMesher();
    const pooled = createBlocksController({
      viewer: fakeViewer(),
      store,
      layers: fakeLayers(true),
      source: fakeSource(),
      renderer: fakeRenderer(),
      grid: fakeGrid,
      buildChunkMesh: () => {
        throw new Error('in-thread');
      },
      meshAsync: mesher.meshAsync,
      radiusBlocks: 64,
      now: () => clock,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
    });
    for (let n = 0; n < 20; n++) {
      await settle();
      pooled.tick();
    }
    const job = mesher.jobs[0];
    const key = `${job.chunk.ci}:${job.chunk.cj}`;
    assert.ok(pooled._state().chunks.get(key).meshing);
    job.reject(new Error('worker timed out'));
    await settle();
    const after = pooled._state().chunks.get(key);
    assert.equal(after.meshing, null);
    assert.equal(after.failed, true);
    assert.ok(after.retryAt < Infinity);
    pooled.destroy();
  } finally {
    console.warn = warn;
  }
});

test('building ids go with the groups dropped behind', async () => {
  const { controller, viewer } = await buildingsSetup({ radiusBlocks: 64 });
  await drain(controller);
  const ids = controller._state().groupBuildings;
  assert.ok(ids.has('0:0') && ids.has('-1:-1'));
  // 2 km east: the old groups are dropped, their ids with them.
  viewer.moveTo(east(2000));
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.ok(!ids.has('0:0') && !ids.has('-1:-1'), [...ids.keys()].join(' '));
  assert.ok([...ids.keys()].every((key) => Number(key.split(':')[0]) >= 6));
  controller.destroy();
});

test('the globe through a flight hold: hidden on a drawn style (no colour tiles for nothing); shown while too high to build', async () => {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  let flying = true;
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source: fakeSource(),
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    inFlight: () => flying,
    flatStyle: () => true,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await settle();
  assert.equal(controller.getStatus().state, 'flying');
  assert.equal(viewer.scene.globe.show, false, 'hidden from the start');
  const { blocksScene } = await import('./floor.js');
  assert.equal(blocksScene().active, true, 'the row says Shown as blocks');
  // Too high to build: shown.
  flying = false;
  viewer.camera.positionCartographic = {
    ...viewer.camera.positionCartographic,
    height: 500_000,
  };
  controller.tick();
  // A region is asked for, and its own ceiling holds it (no footprint).
  await settle();
  controller.tick();
  assert.equal(controller.getStatus().state, 'too-high');
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(blocksScene().active, false);
  controller.destroy();
});

test('the building count waits for every drawn group’s ids: “buildings…” until then, then the same number every time', async () => {
  const { controller, idWaits } = await buildingsSetup({ holdIds: true });
  await drain(controller);
  const pending = controller.getStatus();
  assert.equal(pending.buildingsPending, true);
  assert.equal(pending.buildings, 0);
  assert.match(
    blocksStatusText({ ...pending, sunFixed: false }),
    /· buildings…$/,
  );
  // One group's ids in: still waiting for the others.
  idWaits[0]();
  await settle();
  controller.tick();
  assert.equal(controller.getStatus().buildingsPending, true);
  // All in: counted.
  for (const resolve of idWaits) resolve();
  await settle();
  controller.tick();
  const done = controller.getStatus();
  assert.equal(done.buildingsPending, false);
  assert.equal(done.buildings, 9);
  assert.match(
    blocksStatusText({ ...done, sunFixed: false }),
    /· 9 buildings$/,
  );
  controller.destroy();
});

test('just landed with the globe hidden: its stale height is not trusted, so it builds without a moveEnd', async () => {
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  setHeight(viewer, 300);
  // What a hidden globe answered in the sweep just after a landing.
  viewer.scene.globe.getHeight = () => (viewer.scene.globe.show ? 0 : -44_953);
  const renderer = fakeRenderer();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    flatStyle: () => true,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  assert.equal(viewer.scene.globe.show, false, 'hidden over a drawn style');
  assert.equal(source.regions.length, 1, 'anchored');
  assert.notEqual(controller.getStatus().state, 'too-high');
  assert.ok(renderer.shown.size > 0, 'building');
  // An implausible answer from a shown globe is not trusted either.
  viewer.scene.globe.show = true;
  viewer.scene.globe.getHeight = () => -30_000;
  setHeight(viewer, 310);
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.notEqual(controller.getStatus().state, 'too-high');
  controller.destroy();
});

// ── Milestone 5: the block size follows the view ──────────────────────

test('the pyramid: the native cells, then ×4 from 30 m to 30,720 m; the level height a cube up to 30 m, then max(30 m, blockM / 32)', async () => {
  const { drawnHeightM } = await import('./index.js');
  // The pyramid is pyramid.js's (worker2's, shared with the source).
  const { BLOCK_PYRAMID_M, pyramidLevelM, levelMFor } =
    await import('./pyramid.js');
  assert.deepEqual(
    [...BLOCK_PYRAMID_M],
    [1, 2, 8, 10, 30, 120, 480, 1920, 7680, 30_720],
  );
  // The smallest level at least max(native, wanted).
  assert.equal(pyramidLevelM(1, Number.NaN), 1, 'no footprint: native');
  assert.equal(pyramidLevelM(1, 0.6), 1, 'never finer than the data');
  assert.equal(pyramidLevelM(1, 1.5), 2);
  assert.equal(pyramidLevelM(1, 3), 8);
  assert.equal(pyramidLevelM(10, 9), 10);
  assert.equal(pyramidLevelM(10, 11), 30);
  assert.equal(pyramidLevelM(30, 31), 120);
  assert.equal(pyramidLevelM(1, 2000), 7680);
  assert.equal(pyramidLevelM(30, 1e7), 30_720, 'the top past it');
  // A native cell off the list snaps up to the next level (231 m at sea).
  assert.equal(pyramidLevelM(231, 100), 480);
  // Level heights.
  assert.deepEqual(
    [1, 2, 8, 10, 30, 120, 480, 1920, 7680, 30_720].map(levelMFor),
    [1, 2, 8, 10, 30, 30, 30, 60, 240, 960],
  );
  // The relief draws heights as Cesium draws the globe's.
  assert.equal(drawnHeightM(-33, { factor: 1, relativeM: 50 }), -33);
  assert.equal(drawnHeightM(-33, { factor: 3, relativeM: 50 }), -199);
  assert.equal(drawnHeightM(12), 12);
});

test('a level changes only ×2 past it either way, so a view near a boundary does not re-anchor', async () => {
  const { nextLevelM } = await import('./index.js');
  // At 120 m (30 m native): wanted up to 240 m stays, past it 480 m.
  assert.equal(nextLevelM(120, 200, 30), null);
  assert.equal(nextLevelM(120, 240, 30), null);
  assert.equal(nextLevelM(120, 241, 30), 480);
  // Back at 200 m from 480 m: stays (twice it still needs 480 m).
  assert.equal(nextLevelM(480, 200, 30), null);
  assert.equal(nextLevelM(480, 60, 30), 120);
  // Down to the native cell, never under it.
  assert.equal(nextLevelM(120, 10, 30), 30);
  assert.equal(nextLevelM(30, 1, 30), null);
  // Nothing measured: stay.
  assert.equal(nextLevelM(120, Number.NaN, 30), null);
  assert.equal(nextLevelM(Number.NaN, 100, 30), null);
});

/** A source with the pyramid: the level for the wanted cell, and its native one. */
function pyramidSource(nativeM = 1, name = '3DEP 1 m') {
  const base = fakeSource({ blockM: nativeM, name });
  const asked = [];
  return {
    ...base,
    asked,
    async regionFor(lon, lat, windowM, options = {}) {
      base.regions.push({ lon, lat, windowM });
      asked.push(options);
      const { levelMFor, pyramidLevelM } = await import('./pyramid.js');
      const blockM = pyramidLevelM(nativeM, options.wantedM);
      return { blockM, levelM: levelMFor(blockM), nativeM, source: name };
    },
  };
}

function footprintSetup({
  source = pyramidSource(),
  px = 0.3,
  relief = null,
  datum = null,
  structures = null,
} = {}) {
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const renderer = fakeRenderer();
  const meshes = [];
  const view = { px };
  const reliefState = { factor: 1, relativeM: 0, ...(relief || {}) };
  const reliefListeners = new Set();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh(chunk, options) {
      meshes.push({ key: `${chunk.ci}:${chunk.cj}`, options });
      return { faces: 1, chunk };
    },
    footprint: () => view.px,
    relief: () => reliefState,
    subscribeRelief(listener) {
      reliefListeners.add(listener);
      return () => reliefListeners.delete(listener);
    },
    ...(datum ? { datum } : {}),
    ...(structures ? { structures } : {}),
    flatStyle: () => true,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    setTimeoutImpl: (callback) => {
      callback();
      return 1;
    },
    clearTimeoutImpl: () => {},
  });
  const reliefChanged = (next) => {
    Object.assign(reliefState, next);
    for (const listener of reliefListeners) listener();
  };
  return { store, viewer, renderer, meshes, view, controller, reliefChanged };
}

test('the block follows the footprint: two pixels at the view’s centre up the pyramid, asked of the source; a zoom re-anchors where it settles, ×2 past a level', async () => {
  const source = pyramidSource(1);
  const { viewer, view, controller, meshes } = footprintSetup({ source });
  await drain(controller);
  assert.deepEqual(source.asked, [{ wantedM: 0.6 }]);
  let status = controller.getStatus();
  assert.equal(status.blockM, 1);
  assert.equal(status.levelM, 1);
  assert.equal(meshes.at(-1).options.levelM, 1, 'cubes');
  assert.equal(viewer.scene.globe.show, false);
  // Out to 50 km: a pixel is 40 m, the wanted cell 80 m: 120 m blocks on
  // 30 m levels, with no ceiling in the way.
  setHeight(viewer, 50_000);
  view.px = 40;
  viewer.camera.moveStart.raise();
  controller.tick();
  assert.equal(source.regions.length, 1, 'not mid-move');
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 2);
  assert.equal(source.asked.at(-1).wantedM, 80);
  status = controller.getStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.blockM, 120);
  assert.equal(status.levelM, 30);
  assert.equal(meshes.at(-1).options.blockM, 120);
  assert.equal(meshes.at(-1).options.levelM, 30);
  assert.equal(controller._state().region.region.levelM, 30, 'to the grid');
  // A little further: the wanted cell 200 m is within ×2 of 120 m: stays.
  view.px = 100;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 2, 'no flapping');
  // Past it: 480 m.
  view.px = 130;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(controller.getStatus().blockM, 480);
  // An unmeasured footprint changes nothing.
  view.px = Number.NaN;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 3);
  // 3,000 km straight down (a pixel 3.5 km at 60° over 1,000 px): 7,680 m
  // blocks on 240 m levels.
  setHeight(viewer, 3_000_000);
  view.px = 3464;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  status = controller.getStatus();
  assert.equal(status.blockM, 7680);
  assert.equal(status.levelM, 240);
  assert.notEqual(status.state, 'too-high');
  // 20,000 km: the top level, 30,720 m blocks on 960 m levels.
  setHeight(viewer, 20_000_000);
  view.px = 23_000;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  status = controller.getStatus();
  assert.equal(status.blockM, 30_720);
  assert.equal(status.levelM, 960);
  assert.notEqual(status.state, 'too-high');
  assert.equal(blocksFloorM(), 30_720, 'the HUD’s data floor');
  controller.destroy();
});

test('a source without levels answers its native cell: the region’s own ceiling holds above it, and coming down re-anchors at the native cell', async () => {
  const source = fakeSource({ blockM: 1 });
  const { viewer, view, controller, renderer } = footprintSetup({
    source,
    px: 2000,
  });
  setHeight(viewer, 2_000_000);
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 1);
  assert.equal(controller.getStatus().state, 'too-high');
  assert.equal(controller.getStatus().ceilingM, 1024, '4 × R2 × 1 m');
  assert.equal(source.loads.length, 0, 'nothing loaded');
  // Down to 300 m: the footprint wants 1 m now, so the region is asked again.
  setHeight(viewer, 300);
  view.px = 0.3;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(source.regions.length, 2);
  assert.ok(renderer.shown.size > 0, 'building');
  controller.destroy();
});

test('the Relief control: the level height drawn × the factor and the base exaggerated about its relative height, as the globe; a new relative height moves the region without meshing again', async () => {
  const datum = fakeDatum({ flat: false, undulation: -33 });
  const { renderer, meshes, controller, reliefChanged } = footprintSetup({
    datum,
    relief: { factor: 3, relativeM: 50 },
  });
  await drain(controller);
  const regions = () => renderer.calls.filter(([kind]) => kind === 'region');
  assert.equal(regions()[0][2].datumOffsetM, -199, '(−33 − 50) × 3 + 50');
  assert.equal(meshes.at(-1).options.levelM, 3, '1 m levels drawn 3 m');
  assert.equal(controller.getStatus().relief, 3);
  assert.equal(controller.world().geoidM, -33, 'the walker keeps metres');
  // The relative height follows the view: moved, not meshed again.
  const meshed = meshes.length;
  reliefChanged({ relativeM: 20 });
  await drain(controller);
  assert.equal(regions().at(-1)[2].datumOffsetM, -139);
  assert.equal(meshes.length, meshed, 'kept');
  // Back to ×1: true heights, meshed again.
  reliefChanged({ factor: 1 });
  await drain(controller);
  assert.equal(regions().at(-1)[2].datumOffsetM, -33);
  assert.ok(meshes.length > meshed, 'meshed again');
  assert.equal(meshes.at(-1).options.levelM, 1);
  assert.equal(controller.getStatus().relief, 1);
  controller.destroy();
});

test('the status line above the native cells: the cell, the level height, the relief, the counts and the source; cubes and ×1 say neither', async () => {
  assert.equal(
    blocksStatusText({
      state: 'ready',
      blockM: 1920,
      levelM: 60,
      relief: 3,
      chunks: 320,
      coarse: 208,
      source: 'FABDEM 30 m',
    }),
    'Blocks: 1.9 km cells · 60 m levels · relief ×3 · 320 + 208 coarse · FABDEM 30 m',
  );
  assert.equal(
    blocksStatusText({
      state: 'ready',
      blockM: 1,
      levelM: 1,
      relief: 1,
      chunks: 274,
      coarse: 48,
      source: '3DEP 1 m',
    }),
    'Blocks: 1 m cubes · 274 + 48 coarse · 3DEP 1 m',
  );
  assert.equal(
    blocksStatusText({
      state: 'ready',
      blockM: 30_720,
      levelM: 960,
      chunks: 9,
    }),
    'Blocks: 31 km cells · 960 m levels · 9 chunks',
  );
  const { dataFloor } = await import('../../hud/precision.js');
  assert.equal(dataFloor({ blocksM: 1920 }).name, 'Blocks 1.9 km');
  assert.equal(dataFloor({ blocksM: 1920 }).floorM, 1920);
  assert.equal(dataFloor({ blocksM: 30 }).name, 'Blocks 30 m');
});

test('buildings and land cover only up to 30 m blocks: none asked of Overpass at 120 m and up, where a group’s box runs to tens of kilometres', async () => {
  const asked = [];
  const structures = {
    loadChunk: (region, ci, cj) => {
      asked.push({ blockM: region.blockM, ci, cj });
      return Promise.resolve(null);
    },
    apply: () => 0,
  };
  const { viewer, view, controller } = footprintSetup({ structures });
  await drain(controller);
  assert.ok(asked.length > 0, 'at 1 m');
  assert.ok(asked.every((a) => a.blockM === 1));
  const before = asked.length;
  setHeight(viewer, 50_000);
  view.px = 40;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  assert.equal(controller.getStatus().blockM, 120);
  assert.equal(asked.length, before, 'none at 120 m');
  assert.equal(controller.getStatus().buildingsPending, false);
  assert.equal(controller.getBuildings(), true, 'the switch stays on');
  controller.destroy();
});

test('the coarse ring stops at the horizon: from 300 m over 1 km blocks, no group past 1.25 × the 62 km to it; from 50 km all of them', async () => {
  const { horizonM, HORIZON_MARGIN } = await import('./index.js');
  assert.ok(Math.abs(horizonM(300) - 61_824) < 5);
  // Along the ground, not the line of sight (2,573 km).
  assert.ok(Math.abs(horizonM(500_000) - 2_445_500) < 1000);
  const run = (height) => {
    const source = coarseSource({ blockM: 1000 });
    const { controller, viewer } = setup({ source, radiusBlocks: 128 });
    setHeight(viewer, height);
    return { source, controller, viewer };
  };
  const low = run(300);
  await drain(low.controller);
  const cut = HORIZON_MARGIN * horizonM(300);
  const far = (gi, gj) => {
    // The group's nearest point from the camera's column (0.5, 0.5), m.
    const size = 4 * C * 1000;
    const dx = Math.max(gi * size - 500, 0, 500 - (gi + 1) * size);
    const dy = Math.max(gj * size - 500, 0, 500 - (gj + 1) * size);
    return Math.hypot(dx, dy);
  };
  assert.ok(low.source.coarse.length > 0);
  assert.ok(low.source.coarse.every(({ gi, gj }) => far(gi, gj) <= cut));
  low.controller.destroy();
  const high = run(50_000);
  await drain(high.controller);
  assert.ok(high.source.coarse.length > low.source.coarse.length);
  high.controller.destroy();
});

test('settleMs: the first region waits until the camera has been still that long, and a level change too', async () => {
  let time = 0;
  const source = pyramidSource(1);
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const view = { px: 0.3 };
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    footprint: () => view.px,
    flatStyle: () => true,
    radiusBlocks: 64,
    settleMs: 2000,
    now: () => time,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  assert.equal(source.regions.length, 0, 'not yet still 2 s');
  time = 2100;
  await drain(controller);
  assert.equal(source.regions.length, 1);
  // A zoom out that rests only a moment before moving on: no level change.
  setHeight(viewer, 50_000);
  view.px = 40;
  viewer.camera.moveEnd.raise();
  time = 2500;
  await drain(controller);
  assert.equal(source.regions.length, 1, 'still settling');
  time = 4200;
  await drain(controller);
  assert.equal(source.regions.length, 2);
  assert.equal(controller.getStatus().blockM, 120);
  controller.destroy();
});

test('ringLevels: each ring the next level at least 4 × the cell before, R1 blocks in reach, to the ring that passes the horizon or the top', async () => {
  const { ringLevels } = await import('./index.js');
  // A 1 m region without a coarse ring, R1 64, from 300 m (77 km cut).
  assert.deepEqual(
    ringLevels({
      nativeM: 1,
      innerCellM: 1,
      innerReachM: 64,
      radiusBlocks: 64,
      horizonM: 77_000,
    }),
    [8, 120, 480, 1920],
  );
  // 1 m with the coarse ring (4 m to 2 km), R1 512, 300 m up: 30 m to
  // 15 km, 120 m to 61 km, 480 m to 246 km (past 77 km: the last).
  assert.deepEqual(
    ringLevels({
      nativeM: 1,
      innerCellM: 4,
      innerReachM: 2048,
      radiusBlocks: 512,
      horizonM: 77_000,
    }),
    [30, 120, 480],
  );
  // Nothing past a horizon the coarse ring already reaches.
  assert.deepEqual(
    ringLevels({
      nativeM: 1,
      innerCellM: 7680,
      innerReachM: 3.9e6,
      radiusBlocks: 512,
      horizonM: 3.2e6,
    }),
    [],
  );
  // Never past the top.
  assert.deepEqual(
    ringLevels({
      nativeM: 30,
      innerCellM: 7680,
      innerReachM: 1e6,
      radiusBlocks: 512,
      horizonM: 1e9,
    }),
    [30_720],
  );
});

test('K rings: each its own region at its own level through setRegions, keyed L<blockM>:ci:cj, meshed at its block and level, loaded after the fine ring; the fog from the outermost', async () => {
  const { ringKey } = await import('./index.js');
  const { levelMFor } = await import('./pyramid.js');
  const source = pyramidSource(1);
  const renderer = fakeRenderer();
  const sets = [];
  renderer.setRegions = (regions, options) => {
    sets.push({ levels: regions.map((r) => r.blockM), options });
  };
  renderer.holes = [];
  renderer.setRingHoles = (holes) => renderer.holes.push(holes);
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const meshes = [];
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh(chunk, options) {
      meshes.push({ chunk, options });
      return { faces: 1, chunk };
    },
    footprint: () => 0.3,
    flatStyle: () => true,
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller, 400);
  assert.deepEqual(sets.at(-1).levels, [1, 8, 120, 480, 1920]);
  assert.equal(sets.at(-1).options.fogReachBlocks, 64);
  const rings = controller._state().rings;
  assert.deepEqual([...rings.keys()], [8, 120, 480, 1920]);
  for (const [level, ring] of rings) {
    assert.equal(ring.region.blockM, level);
    assert.equal(ring.region.levelM, levelMFor(level));
    assert.ok(ring.chunks.size > 0, `ring ${level} loaded`);
    for (const entry of ring.chunks.values()) {
      assert.equal(entry.key, ringKey(level, entry.ci, entry.cj));
      assert.ok(renderer.shown.has(entry.key), entry.key);
    }
  }
  // Meshed at their own block and level.
  const ringMesh = meshes.find((m) => m.options.blockM === 480);
  assert.equal(ringMesh.options.blockM, 480);
  assert.equal(ringMesh.options.levelM, 30);
  assert.equal(ringMesh.options.skirt, undefined);
  // Loaded only after every fine chunk was in.
  const firstRing = source.loads.findIndex((l) => l.region.blockM !== 1);
  const lastFine = source.loads.findLastIndex((l) => l.region.blockM === 1);
  assert.ok(firstRing > lastFine, 'the near ground first');
  // Each ring's chunks within R1 of it, each reaching past the rings
  // inside (a chunk wider than the hole is kept, its inside left out by
  // the renderer): the camera's own chunk of every ring is there.
  const { farthestDistance } = await import('./index.js');
  let inner = 64 * 1; // the 1 m fine disc's reach (this source has no coarse ring)
  for (const [level, ring] of rings) {
    for (const entry of ring.chunks.values())
      assert.ok(
        farthestDistance({ x: 0.5, y: 0.5 }, entry.ci, entry.cj, C) >
          inner / level,
        `ring ${level} chunk ${entry.key}`,
      );
    inner = 64 * level;
  }
  for (const [level, ring] of rings)
    if (level >= 480)
      assert.ok(ring.chunks.has(ringKey(level, 0, 0)), `ring ${level} 0:0`);
  // The holes: the rings' inner reaches about the camera's ground.
  const holes = renderer.holes.at(-1);
  assert.ok(holes);
  assert.deepEqual(Object.keys(holes.reachM).map(Number), [8, 120, 480, 1920]);
  assert.equal(holes.reachM[8], 64 * 1);
  assert.equal(holes.reachM[120], 64 * 8);
  assert.equal(holes.reachM[480], 64 * 120);
  // Told on change only: a still camera ticking asks nothing more; a move
  // asks once.
  const told = renderer.holes.length;
  assert.equal(told, 1, 'once for a camera that never moved');
  for (let n = 0; n < 5; n++) controller.tick();
  assert.equal(renderer.holes.length, told);
  viewer.moveTo(east(20));
  controller.tick();
  assert.equal(renderer.holes.length, told + 1);
  assert.notEqual(renderer.holes.at(-1).lon, holes.lon);
  // The status counts them with the coarse ring.
  const status = controller.getStatus();
  const ringChunks = [...rings.values()].reduce((n, r) => n + r.chunks.size, 0);
  assert.equal(status.coarse, ringChunks);
  assert.equal(status.state, 'ready');
  controller.destroy();
});

test('the Elevation layer’s Blocks style: none over the native cells’ geometry; the footprint’s level over coarse blocks and where Blocks cannot build, the globe shown to drape it', async () => {
  const { blocksScene } = await import('./floor.js');
  const { blocksStyleLevelFor } = await import('../../data/blocksStyle.js');
  const { viewer, view, controller } = footprintSetup();
  await drain(controller);
  assert.equal(controller.getStatus().blockM, 1);
  controller.tick();
  assert.equal(blocksScene().style, null, 'no style tiles under 1 m cubes');
  assert.equal(viewer.scene.globe.show, false, 'hidden on a drawn style');
  // 120 m blocks: the style under and beyond them, on a shown globe.
  setHeight(viewer, 50_000);
  view.px = 40;
  viewer.camera.moveEnd.raise();
  await drain(controller);
  controller.tick();
  assert.equal(controller.getStatus().blockM, 120);
  assert.equal(blocksScene().style, blocksStyleLevelFor(40));
  assert.equal(viewer.scene.globe.show, true);
  // Walk and Fly (no footprint): none.
  view.px = Number.NaN;
  controller.tick();
  assert.equal(blocksScene().style, null);
  controller.destroy();
  assert.equal(blocksScene().style, null, 'gone with the controller');
  // A source without levels held above its ceiling: the style as fallback.
  const held = footprintSetup({ source: fakeSource({ blockM: 1 }), px: 2000 });
  setHeight(held.viewer, 2_000_000);
  held.viewer.camera.moveEnd.raise();
  await drain(held.controller);
  held.controller.tick();
  assert.equal(held.controller.getStatus().state, 'too-high');
  assert.equal(blocksScene().style, blocksStyleLevelFor(2000));
  held.controller.destroy();
});

test('a moveEnd that never comes: the camera still for SETTLE_MS is settled, and the first region anchors', async () => {
  const { SETTLE_MS } = await import('./index.js');
  const source = fakeSource();
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  // A camera with a pose (positionWC, direction, up) as Cesium's has.
  Object.assign(viewer.camera, {
    positionWC: { x: 1_000_000, y: -4_800_000, z: 4_000_000 },
    direction: { x: 0, y: 0.6, z: -0.8 },
    up: { x: 0, y: 0.8, z: 0.6 },
  });
  const layers = fakeLayers(false);
  let clock = 0;
  const timers = { callback: null };
  const controller = createBlocksController({
    viewer,
    store,
    layers,
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    flatStyle: () => true,
    radiusBlocks: 64,
    now: () => clock,
    setIntervalImpl(callback) {
      timers.callback = callback;
      return 1;
    },
    clearIntervalImpl() {
      timers.callback = null;
    },
  });
  // A flight lands with Blocks just turned on: Cesium said moveStart and
  // never moveEnd (its up vector churning by ~1e-16 a frame).
  viewer.camera.moveStart.raise();
  layers.set(true);
  await drain(controller, 5);
  assert.equal(source.regions.length, 0, 'not anchored mid-move');
  // The camera moves on every tick: never settled.
  for (let k = 0; k < 6; k += 1) {
    clock += 400;
    viewer.camera.positionWC = {
      ...viewer.camera.positionWC,
      x: viewer.camera.positionWC.x + 50,
    };
    timers.callback?.();
  }
  await drain(controller, 5);
  assert.equal(source.regions.length, 0, 'still moving');
  // Then still, with the up vector's last-digit churn: settled after SETTLE_MS.
  timers.callback?.();
  clock += SETTLE_MS - 100;
  viewer.camera.up = { x: 1e-16, y: 0.8, z: 0.6 };
  timers.callback?.();
  assert.equal(source.regions.length, 0, 'not yet: under SETTLE_MS');
  clock += 200;
  viewer.camera.up = { x: -1e-16, y: 0.8, z: 0.6 };
  timers.callback?.();
  await drain(controller, 20);
  assert.equal(source.regions.length, 1, 'anchored without a moveEnd');
  assert.notEqual(controller.getStatus().state, 'flying');
  controller.destroy();
});

test('continental levels: the fine ring to the horizon, not R1 (15,700 km at 30,720 m, past the antipode); every ring within it; the camera’s own ground covered', async () => {
  const { horizonM, HORIZON_MARGIN, fineRadiusBlocks, ANTIPODE_M } =
    await import('./index.js');
  // The ground to the horizon: 5,245 km from 3,000 km, 8,453 km from
  // 20,000 km, never past a quarter of the way round.
  assert.ok(Math.abs(horizonM(3_000_000) - 5_245_000) < 2000);
  assert.ok(Math.abs(horizonM(20_000_000) - 8_453_000) < 2000);
  assert.ok(horizonM(1e12) < ANTIPODE_M / 2 + 1);
  const cut = (h) => HORIZON_MARGIN * horizonM(h);
  assert.equal(fineRadiusBlocks(512, 30_720, cut(3_000_000), 64), 213);
  assert.equal(fineRadiusBlocks(512, 30_720, cut(20_000_000), 64), 343);
  assert.equal(fineRadiusBlocks(512, 7680, cut(3_000_000), 64), 512);
  assert.equal(
    fineRadiusBlocks(512, 1, cut(300), 64),
    512,
    'R1 near the ground',
  );
  assert.equal(fineRadiusBlocks(512, 30_720, 1000, 64), 64, 'at least a chunk');
  // The controller at 30,720 m and 7,680 m, from 3,000 km and 20,000 km.
  for (const [height, px, level] of [
    [3_000_000, 3464, 7680],
    [3_000_000, 5000, 30_720],
    [20_000_000, 23_000, 30_720],
  ]) {
    const source = pyramidSource(30, 'FABDEM 30 m');
    // R1 512 as in the app.
    const store = createRenderModeStore({ storage: memoryStorage() });
    store.setMode('blocks');
    const view = fakeViewer();
    setHeight(view, height);
    const real = createBlocksController({
      viewer: view,
      store,
      layers: fakeLayers(true),
      source,
      renderer: fakeRenderer(),
      grid: fakeGrid,
      buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
      footprint: () => px,
      flatStyle: () => true,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => {},
    });
    await drain(real, 600);
    assert.equal(real.getStatus().blockM, level, `${height} m`);
    const radius = fineRadiusBlocks(512, level, cut(height), 64);
    const loaded = source.loads.filter((l) => l.region.blockM === level);
    assert.ok(loaded.length > 0);
    // Every fine chunk in a whole 4 × 4 group within the capped radius of
    // the camera's column, so within the horizon.
    const far = Math.max(
      ...loaded.map(({ ci, cj }) => {
        const { gi, gj } = groupOf(ci, cj);
        return chunkDistance({ x: 0.5, y: 0.5 }, gi, gj, 4 * 64);
      }),
    );
    assert.ok(far <= radius, `${far} ≤ ${radius} at ${level} m`);
    assert.ok(far * level <= cut(height), 'within the horizon');
    // The camera's own chunk is among them.
    assert.ok(loaded.some(({ ci, cj }) => ci === 0 && cj === 0));
    real.destroy();
  }
});

test('the anchor: on the ground point at the curved levels, half a supergroup south and west along the ground below them, never past 1,000 km, a pole or the antimeridian', async () => {
  const { anchorFor, shiftAlongGround, ANCHOR_MAX_SHIFT_M } =
    await import('./index.js');
  const { createRegion } = await import('./grid.js');
  const R = 6_378_137;
  const RAD = Math.PI / 180;
  // Great-circle metres between two places.
  const between = (a, b) => {
    const dLat = (b.lat - a.lat) * RAD;
    const dLon = (b.lon - a.lon) * RAD;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const options = { supergroupGroups: 4, curvedBlockM: 1920, chunkColumns: 64 };
  const onGlobe = ({ lon0, lat0 }) =>
    lat0 > -90 && lat0 < 90 && lon0 >= -180 && lon0 <= 180;
  assert.equal(ANCHOR_MAX_SHIFT_M, 1_000_000);
  // The curved levels: the ground point itself, at both cameras.
  for (const camera of [
    { lon: -93, lat: 41 },
    { lon: 10, lat: 60 },
  ])
    for (const blockM of [1920, 7680, 30720]) {
      const anchor = anchorFor(camera, blockM, options);
      assert.ok(onGlobe(anchor), `${blockM} at ${camera.lat}`);
      assert.equal(between(camera, { lon: anchor.lon0, lat: anchor.lat0 }), 0);
    }
  // Below them, the flat levels as before: half a supergroup (at 480 m,
  // 4 × 4 × 64 × 480 / 2 = 245,760 m) south and west, the old degrees to
  // a metre, and the camera mid-supergroup in the region's own metres.
  for (const camera of [
    { lon: -93, lat: 41 },
    { lon: 10, lat: 60 },
  ]) {
    const halfM = (4 * 4 * 64 * 480) / 2;
    const flat = anchorFor(camera, 480, options);
    const old = {
      lon: camera.lon - halfM / (111_320 * Math.cos(camera.lat * RAD)),
      lat: camera.lat - halfM / 111_320,
    };
    // (The degree here is 111,319.5 m, the old one 111,320: 2 m apart.)
    assert.ok(between({ lon: flat.lon0, lat: flat.lat0 }, old) < 5);
    const local = createRegion({ ...flat, blockM: 480 }).toLocal(
      camera.lon,
      camera.lat,
    );
    // As centred as the old shift: within 4% (3.3% north at 60° N).
    assert.ok(Math.abs(local.x / halfM - 1) < 0.04, String(local.x / halfM));
    assert.ok(Math.abs(local.y / halfM - 1) < 0.04, String(local.y / halfM));
    assert.ok(
      between(camera, { lon: flat.lon0, lat: flat.lat0 }) < ANCHOR_MAX_SHIFT_M,
    );
  }
  // No supergroups: the ground point.
  assert.deepEqual(anchorFor({ lon: -93, lat: 41 }, 30, {}), {
    lon0: -93,
    lat0: 41,
  });
  // The cap: 30,720 m as if it were flat (the old degrees put it at 99.8°
  // S) stays within 1,000 km of the ground point.
  const camera = { lon: -93.51, lat: 41.37 };
  const capped = anchorFor(camera, 30720, {
    supergroupGroups: 4,
    chunkColumns: 64,
  });
  assert.ok(onGlobe(capped));
  assert.ok(
    between(camera, { lon: capped.lon0, lat: capped.lat0 }) <=
      ANCHOR_MAX_SHIFT_M,
  );
  // Near a pole and across the antimeridian, a capped shift never wraps.
  const leg = ANCHOR_MAX_SHIFT_M / Math.SQRT2;
  for (const from of [
    { lon: 179.9, lat: 89.95 },
    { lon: -179.95, lat: -89.95 },
    { lon: -179.99, lat: 0 },
    { lon: 179.99, lat: -10 },
  ]) {
    const to = shiftAlongGround(from, leg, leg);
    assert.ok(to.lat > -90 && to.lat < 90, JSON.stringify(to));
    assert.ok(to.lon >= -180 && to.lon <= 180, JSON.stringify(to));
  }
});

test('a cached view at a fine altitude after a coarse one changes level within the settle window: the ticker keeps running while the camera settles', async () => {
  let time = 0;
  const source = pyramidSource(1);
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const viewer = fakeViewer();
  const view = { px: 40 };
  setHeight(viewer, 50_000);
  const timer = { callback: null };
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    footprint: () => view.px,
    flatStyle: () => true,
    radiusBlocks: 64,
    settleMs: 2000,
    now: () => time,
    // Ticks come only from this interval, as in the app.
    setIntervalImpl(callback) {
      timer.callback = callback;
      return 1;
    },
    clearIntervalImpl() {
      timer.callback = null;
    },
  });
  // Run the interval as the app would, until it stops of itself.
  const runTicks = async (until) => {
    while (timer.callback && time < until) {
      await settle();
      time += 500;
      timer.callback?.();
    }
    await settle();
  };
  await runTicks(10_000);
  assert.equal(controller.getStatus().blockM, 120);
  assert.equal(timer.callback, null, 'settled: the ticker stopped');
  // Down to 300 m over ground already loaded: the flight ends, nothing to
  // load, and only the settle stands between it and 1 m blocks.
  setHeight(viewer, 300);
  view.px = 0.3;
  viewer.camera.moveStart.raise();
  viewer.camera.moveEnd.raise();
  assert.notEqual(timer.callback, null, 'ticking while it settles');
  await runTicks(time + 3000);
  assert.equal(controller.getStatus().blockM, 1, 'not stuck at 120 m');
  assert.equal(source.regions.length, 2);
  controller.destroy();
});

test('chunks that land outside the ring after the camera moves on are dropped, not left loading: the status clears and the tick stops', async () => {
  const source = fakeSource({ hold: true });
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  const viewer = fakeViewer();
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    radiusBlocks: 128,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  // Anchored at the camera; the first loads asked and held.
  for (let n = 0; n < 6; n++) {
    await settle();
    controller.tick();
  }
  const asked = source.loads.length;
  assert.ok(asked > 0, 'loads asked');
  // The camera moves 396 columns east within the region (1 m blocks): the
  // chunks asked west of it are no longer in the ring, but within the
  // removal distance (1.25 × R1) they are kept.
  viewer.moveTo(LON0 + 396 / (M_PER_DEG * Math.cos(LAT0 * RAD)));
  controller.tick();
  // Now every held load answers.
  for (const load of source.loads.splice(0)) load.resolve?.();
  // Release the rest as they come, and run until the controller rests.
  for (let n = 0; n < 200; n++) {
    await settle();
    for (const load of source.loads.splice(0)) load.resolve?.();
    controller.tick();
    if (!controller._state().ticking) break;
  }
  await settle();
  controller.tick();
  const status = controller.getStatus();
  assert.equal(status.pending, 0, `pending ${status.pending}`);
  assert.equal(status.state, 'ready');
  // Every chunk held is drawn: none sits unshown, waiting on nothing.
  const { chunks } = controller._state();
  const unshown = [...chunks.values()].filter((e) => !e.shown && !e.loading);
  assert.deepEqual(
    unshown.map((e) => e.key),
    [],
  );
  controller.destroy();
});

test('a 30,720 m region re-anchors when the camera flies to another continent (2,000 km, not 31,457), and settles with nothing loading', async () => {
  const source = fakeSource({ blockM: 30720, name: 'GMTED2010 230 m' });
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const renderer = fakeRenderer();
  // The opening view: over 30° N 40° W.
  const viewer = fakeViewer(-40, 30);
  const controller = createBlocksController({
    viewer,
    store,
    layers: fakeLayers(true),
    source,
    renderer,
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    // R1 = 512: the old radius was 2 × 512 × 30,720 m = 31,457 km.
    radiusBlocks: 512,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  const regions = () => renderer.calls.filter(([kind]) => kind === 'region');
  assert.equal(regions().length, 1);
  assert.equal(controller.getStatus().state, 'ready');
  // A search flies the camera to Europe (51° N 10° E), about 4,500 km off.
  viewer.moveTo(10, 51);
  await drain(controller);
  assert.equal(regions().length, 2, 'anchored again');
  const region = regions().at(-1)[1];
  assert.ok(Math.abs(region.lon0 - 10) < 1 && Math.abs(region.lat0 - 51) < 1);
  const status = controller.getStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.pending, 0);
  assert.equal(controller._state().ticking, false);
  controller.destroy();
});

test('the Buildings switch takes the land cover off too, from chunks the source holds: no paint cut off along the chunk grid', async () => {
  const { createChunk, MATERIALS } = await import('./store.js');
  const { applyStructures } = await import('./structures.js');
  const N = 64;
  // The source hands out the same chunk object every time (source.js
  // keeps its chunks), as a chunk dropped and asked again comes back.
  const held = new Map();
  const source = {
    regionFor: () => Promise.resolve({ blockM: 1, source: '3DEP 1 m' }),
    loadChunk: (region, ci, cj) => {
      const key = `${ci}:${cj}`;
      if (!held.has(key))
        held.set(
          key,
          createChunk({
            ci,
            cj,
            top: new Int32Array(N * N).fill(10),
            water: new Int32Array(N * N).fill(-2147483648),
          }),
        );
      return Promise.resolve(held.get(key));
    },
  };
  // Land cover only (no buildings): a road down column 5, a park in the
  // corner, an OSM pond at (20, 20).
  const structures = {
    loadChunk() {
      const top = new Int32Array(N * N).fill(-2147483648);
      const bottom = new Int32Array(N * N).fill(-2147483648);
      const material = new Uint8Array(N * N);
      for (let j = 0; j < N; j++) material[j * N + 5] = MATERIALS.ROAD;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) material[j * N + i] = MATERIALS.GRASS;
      material[20 * N + 20] = MATERIALS.WATER;
      return Promise.resolve({ top, bottom, material });
    },
    apply: applyStructures,
  };
  const store = createRenderModeStore({ storage: memoryStorage() });
  store.setMode('blocks');
  const controller = createBlocksController({
    viewer: fakeViewer(),
    store,
    layers: fakeLayers(true),
    source,
    structures,
    renderer: fakeRenderer(),
    grid: fakeGrid,
    buildChunkMesh: (chunk) => ({ faces: 1, chunk }),
    radiusBlocks: 64,
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  await drain(controller);
  const paint = () =>
    [...held.values()].filter((chunk) =>
      chunk.material.some((m) => m !== MATERIALS.TERRAIN),
    ).length;
  assert.ok(held.size > 1);
  assert.equal(paint(), held.size, 'on: every fine chunk painted');
  const origin = held.get('0:0');
  assert.equal(origin.material[5], MATERIALS.ROAD);
  assert.equal(origin.top[20 * N + 20], 9, 'the pond');
  // Off: the paint comes off every chunk, the pond's ground back.
  store.setBuildings(false);
  await drain(controller);
  assert.equal(paint(), 0, 'off: no chunk keeps its paint');
  assert.equal(origin.top[20 * N + 20], 10);
  assert.equal(origin.water[20 * N + 20], -2147483648);
  // A chunk that still carries an earlier pass's paint (the source's
  // cache handing it back) is cleared too while the switch is off.
  origin.setSurface(7, 7, MATERIALS.FOREST);
  await drain(controller);
  assert.equal(origin.material[7 * N + 7], MATERIALS.TERRAIN);
  // On again: painted again everywhere.
  store.setBuildings(true);
  await drain(controller);
  assert.equal(paint(), held.size);
  controller.destroy();
});
