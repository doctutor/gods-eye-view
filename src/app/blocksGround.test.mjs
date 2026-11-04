// Personal fork: the ground an arrival is lifted to while Render: Blocks
// hides the globe (src/app/blocks.js pointGroundM, the camera guard's
// fallback): one values probe, its plausible heights' mean, on the
// region's datum.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKS_TILES_SUPPRESSION,
  memoizeFootprint,
  pointGroundM,
  suppressBaseUnderTiles,
  tilesDrawWorld,
} from './blocks.js';

const valuesAnswering = (heights) => {
  const asked = [];
  return {
    asked,
    get: async (request) => {
      asked.push(request);
      return { header: {}, values: Float32Array.from(heights) };
    },
  };
};

test('the point probe: one 4-cell request about the point, the mean of its plausible heights, plus the geoid on terrain', async () => {
  const values = valuesAnswering([1890, 1900, Number.NaN, -9999]);
  const terrain = { flat: () => false, undulation: async () => -30 };
  const groundM = await pointGroundM(
    { values, datum: terrain },
    39.0885,
    -120.0504,
  );
  assert.equal(groundM, 1895 - 30);
  assert.equal(values.asked.length, 1);
  assert.equal(values.asked[0].layer, 'ee-elevation');
  assert.equal(values.asked[0].cells, 4);
  const { west, east, south, north } = values.asked[0].box;
  assert.ok(
    west < -120.0504 && east > -120.0504 && south < 39.0885 && north > 39.0885,
  );
  // Flat ground: the blocks stand on the ellipsoid, no geoid.
  const flat = { flat: () => true, undulation: async () => -30 };
  assert.equal(
    await pointGroundM({ values, datum: flat }, 39.0885, -120.0504),
    1895,
  );
  // Nothing plausible: unknown.
  const empty = valuesAnswering([Number.NaN, -9999]);
  assert.ok(
    Number.isNaN(await pointGroundM({ values: empty, datum: flat }, 0, 0)),
  );
});

test('the footprint is read once a second for a camera that has not moved, and again when it moves (each read is a depth pick)', () => {
  let time = 0;
  let pose = 'a';
  let reads = 0;
  const footprint = memoizeFootprint(
    () => {
      reads++;
      return reads;
    },
    () => pose,
    { now: () => time, maxAgeMs: 1000 },
  );
  assert.equal(footprint(), 1);
  time = 400;
  assert.equal(footprint(), 1, 'the level and the style in one tick');
  assert.equal(reads, 1);
  time = 1000;
  assert.equal(footprint(), 2, 'a second later, read again');
  pose = 'b';
  time = 1100;
  assert.equal(footprint(), 3, 'the camera moved: read again');
  assert.equal(reads, 3);
});

test('the base map’s 3D tileset is suppressed while Blocks’ tiles draw the world (tiles, hybrid), released when they stop and on teardown', () => {
  assert.equal(tilesDrawWorld({ tiles: { mode: 'tiles' } }), true);
  assert.equal(tilesDrawWorld({ tiles: { mode: 'hybrid' } }), true);
  assert.equal(tilesDrawWorld({ tiles: null }), false);
  assert.equal(tilesDrawWorld(null), false);
  const listeners = new Set();
  let status = { state: 'loading', tiles: null };
  const controller = {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const calls = [];
  const mapStackController = {
    setTilesetSuppressed(reason, on) {
      assert.equal(this, mapStackController);
      calls.push([reason, on]);
      return on;
    },
  };
  const emit = (next) => {
    status = next;
    for (const listener of [...listeners]) listener(next);
  };
  const off = suppressBaseUnderTiles({ controller, mapStackController });
  assert.deepEqual(calls, [[BLOCKS_TILES_SUPPRESSION, false]], 'live only');
  emit({ state: 'loading', tiles: { mode: 'hybrid' } });
  emit({ state: 'ready', tiles: { mode: 'hybrid', hole: {} } });
  emit({ state: 'tiles', tiles: { mode: 'tiles' } });
  assert.deepEqual(calls.at(-1), [BLOCKS_TILES_SUPPRESSION, true]);
  assert.equal(calls.length, 2, 'told once while it holds');
  emit({ state: 'off', tiles: null });
  assert.deepEqual(calls.at(-1), [BLOCKS_TILES_SUPPRESSION, false]);
  emit({ state: 'tiles', tiles: { mode: 'tiles' } });
  off();
  assert.deepEqual(calls.at(-1), [BLOCKS_TILES_SUPPRESSION, false]);
  assert.equal(listeners.size, 0);
  // A map controller without the flag: nothing to do.
  const none = suppressBaseUnderTiles({ controller, mapStackController: {} });
  none();
});
