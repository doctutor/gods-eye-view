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
  createRegion({ lon0, lat0, blockM }) {
    const cos = Math.cos(lat0 * RAD);
    return {
      lon0,
      lat0,
      blockM,
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
  // Three arrive: three more start, and the three are meshed.
  source.loads.slice(0, 3).forEach((l) => l.resolve());
  await settle();
  controller.tick();
  assert.equal(source.loads.length, CHUNK_BUDGET + 3);
  assert.equal(new Set(meshes.map((m) => m.key)).size, 3);
  assert.equal(renderer.shown.size, 3);
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

test('a chunk is meshed again when a neighbour arrives (its border faces) or its version changes', async () => {
  const source = fakeSource({ hold: true });
  const { controller, meshes } = setup({ source });
  await settle();
  const first = source.loads.find((l) => l.ci === 0 && l.cj === 0);
  first.resolve();
  await settle();
  controller.tick();
  const ofOrigin = () => meshes.filter((m) => m.key === '0:0');
  assert.equal(ofOrigin().length, 1);
  assert.deepEqual(ofOrigin()[0].options.neighbours, {}, 'none loaded yet');
  assert.equal(ofOrigin()[0].options.blockM, 1);
  assert.deepEqual(ofOrigin()[0].options.sunDir, STUDY_SUN.dir);
  // Its east neighbour arrives: 0:0 is meshed again, now with it.
  source.loads.find((l) => l.ci === 1 && l.cj === 0).resolve();
  await settle();
  controller.tick();
  assert.equal(ofOrigin().length, 2);
  assert.equal(ofOrigin()[1].options.neighbours.e.ci, 1);
  // Nothing changed: not meshed again.
  controller.tick();
  assert.equal(ofOrigin().length, 2);
  // A diagonal arrives (ambient occlusion at the corner): meshed again.
  source.loads.find((l) => l.ci === -1 && l.cj === -1).resolve();
  await settle();
  controller.tick();
  assert.equal(ofOrigin().length, 3);
  assert.deepEqual(Object.keys(ofOrigin()[2].options.neighbours).sort(), [
    'e',
    'sw',
  ]);
  assert.equal(ofOrigin()[2].options.neighbours.sw.ci, -1);
  // An edit bumps its version: meshed again.
  ofOrigin()[2].chunk.version = 1;
  controller.tick();
  assert.equal(ofOrigin().length, 4);
  controller.destroy();
});

test('the budget doubles for 30 m blocks; the region says when it is left (grid.js within)', async () => {
  const { tickBudget, reanchorRadiusM } = await import('./index.js');
  assert.equal(tickBudget(8, 1), 8);
  assert.equal(tickBudget(8, 10), 8);
  assert.equal(tickBudget(8, 30), 16);
  assert.equal(reanchorRadiusM(1, 512), 20_000);
  assert.equal(reanchorRadiusM(30, 512), 30_720);
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
function coarseSource({ hold = false, holdCoarse = false } = {}) {
  const base = fakeSource({ hold });
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
  assert.equal(
    meshes.filter((m) => m.chunk.coarse && m.chunk.gi === 0 && m.chunk.gj === 0)
      .length,
    meshedBefore,
    'from its kept mesh',
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

test('skirts: a fine chunk with no fine neighbour beyond a border hangs its sides down to 4 × the lowest coarse level there', async () => {
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
  assert.deepEqual(last('3:0').skirt, { n: null, s: null, e: 24, w: null });
  // The north-west corner: skirts on two sides, from c:-1:1 (lowest 4) and c:-2:0 (3).
  assert.deepEqual(last('-4:3').skirt, { n: 16, s: null, e: null, w: 12 });
  // Inside the fine ring: none.
  assert.equal(last('1:1').skirt, undefined);
  // Coarse chunks: none.
  const coarse = meshes.filter((m) => m.chunk.coarse);
  assert.ok(coarse.length > 0);
  assert.ok(coarse.every((m) => m.options.skirt === undefined));
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
    e: 24,
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
  const first = run.meshes.find((m) => m.key === '0:0');
  assert.ok(first, 'meshed');
  // All four of 0:0's side neighbours are among the first loads, still
  // loading: they will cull its borders, so no skirt at all.
  for (const [di, dj] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ])
    assert.ok(held.loads.some((l) => l.ci === di && l.cj === dj));
  assert.equal(first.options.skirt, undefined);
  run.controller.destroy();
});
