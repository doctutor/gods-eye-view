// Personal fork: the Blocks chunk source (src/layers/blocks/source.js):
// block size from the stack's native cell, heights to columns, sampling a
// chunk's answer, the chunk cache, shared requests and retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_COLUMNS, createRegion } from './grid.js';
import { MATERIALS, NONE } from './store.js';
import {
  ELEVATION_LAYER,
  CHUNK_GROUP,
  GROUP_COLUMNS,
  coarseHeights,
  columnsFromHeights,
  createChunkSource,
  groupBounds,
  groupOf,
  probeBox,
  sampleColumns,
  snapBlockM,
} from './source.js';

const M_PER_DEG = 111_319.49;

/** The server's windowGrid, so the stub answers the grid the server would. */
function serverGrid({ west, south, east, north }, cells, nativeM) {
  const lat = (south + north) / 2;
  const widthM = (east - west) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const heightM = (north - south) * M_PER_DEG;
  const cell = Math.max(Math.max(widthM, heightM) / cells, nativeM);
  const side = (m) => Math.max(1, Math.min(cells, Math.floor(m / cell + 1e-6)));
  const cols = side(widthM);
  const rows = side(heightM);
  return { cols, rows, cellSizeM: widthM / cols };
}

/** A fake values endpoint: heights from heightAt(lon, lat), native cell nativeM. */
function fakeValues({ nativeM, heightAt, source = 'USGS 3DEP 1 m', fail = 0 }) {
  const calls = [];
  let failures = fail;
  const fetchValues = async (request) => {
    calls.push(request);
    if (failures > 0) {
      failures--;
      const error = new Error('Raster values: HTTP 503');
      error.status = 503;
      throw error;
    }
    const { box, cells } = request;
    const { cols, rows, cellSizeM } = serverGrid(box, cells, nativeM);
    const values = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const lon = box.west + ((c + 0.5) / cols) * (box.east - box.west);
        const lat = box.north - ((r + 0.5) / rows) * (box.north - box.south);
        values[r * cols + c] = heightAt(lon, lat);
      }
    return { header: { ...box, cols, rows, cellSizeM, source }, values };
  };
  return { fetchValues, calls };
}

const createChunk = (spec) => ({ ...spec, stub: true });

test('snapBlockM: a measured cell snaps to the stack native size', () => {
  assert.equal(snapBlockM(1), 1);
  assert.equal(snapBlockM(2), 2);
  assert.equal(snapBlockM(10.67), 10); // 64 m of 10 m cells: 6 cells
  assert.equal(snapBlockM(32), 30); // 64 m of 30 m cells: 2 cells
  assert.equal(snapBlockM(240.9), 231);
});

test('probeBox: a square of the asked side at the latitude', () => {
  const box = probeBox(-76.6, 39.3, 64);
  const widthM =
    (box.east - box.west) * M_PER_DEG * Math.cos((39.3 * Math.PI) / 180);
  const heightM = (box.north - box.south) * M_PER_DEG;
  assert.ok(Math.abs(widthM - 64) < 1e-6);
  assert.ok(Math.abs(heightM - 64) < 1e-6);
});

test('regionFor: the native cell at the point, and the source name', async () => {
  for (const [nativeM, blockM] of [
    [1, 1],
    [2, 2],
    [10, 10],
    [30, 30],
    [231, 231],
  ]) {
    const { fetchValues, calls } = fakeValues({
      nativeM,
      heightAt: () => 5,
      source: `DEM ${nativeM} m`,
    });
    const source = createChunkSource({ fetchValues, createChunk });
    const region = await source.regionFor(-76.6, 39.3, 512);
    assert.equal(region.blockM, blockM, `native ${nativeM}`);
    assert.equal(region.source, `DEM ${nativeM} m`);
    assert.equal(calls[0].layer, ELEVATION_LAYER);
    assert.equal(calls[0].mode, '');
    assert.equal(calls[0].cells, CHUNK_COLUMNS);
    // One small probe resolves 1–30 m; GMTED needs the wider one.
    assert.equal(calls.length, nativeM > 64 ? 2 : 1);
  }
});

test('columnsFromHeights: floor levels, the sea at level 0, nodata NONE', () => {
  const { top, material, water } = columnsFromHeights(
    Float32Array.from([0.5, 1, 30.2, 0, -0.4, -12, NaN, -86]),
    1,
  );
  assert.deepEqual([...top], [0, 1, 30, -1, -1, -12, NONE, -86]);
  assert.deepEqual([...water], [NONE, NONE, NONE, 0, 0, 0, NONE, 0]);
  const { TERRAIN: T, AIR: A } = MATERIALS;
  assert.deepEqual([...material], [T, T, T, T, T, T, A, T]);
  const coarse = columnsFromHeights(
    Float32Array.from([29.9, 30, 59.9, 60]),
    30,
  );
  assert.deepEqual([...coarse.top], [0, 1, 1, 2]);
});

test('sampleColumns: each column reads the cell under its centre, even on a 63-cell answer', () => {
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 30 });
  // A ramp east: height = metres east of the region origin.
  const mPerLon = M_PER_DEG * Math.cos((39.3 * Math.PI) / 180);
  const heightAt = (lon) => (lon - region.lon0) * mPerLon;
  const box = region.chunkBounds(2, -1);
  const grid = serverGrid(box, CHUNK_COLUMNS, 30);
  const values = new Float32Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++)
      values[r * grid.cols + c] = heightAt(
        box.west + ((c + 0.5) / grid.cols) * (box.east - box.west),
      );
  // Same grid shape trimmed by a cell: the lookup is by place, not index.
  const trimmed = { cols: grid.cols - 1, rows: grid.rows };
  const trimmedValues = new Float32Array(trimmed.cols * trimmed.rows);
  for (let r = 0; r < trimmed.rows; r++)
    for (let c = 0; c < trimmed.cols; c++)
      trimmedValues[r * trimmed.cols + c] = heightAt(
        box.west + ((c + 0.5) / trimmed.cols) * (box.east - box.west),
      );
  for (const [header, vals] of [
    [{ ...box, ...grid }, values],
    [{ ...box, ...trimmed }, trimmedValues],
  ]) {
    const heights = sampleColumns(region, 2, -1, { header, values: vals });
    assert.equal(heights.length, CHUNK_COLUMNS * CHUNK_COLUMNS);
    const chunkX = 2 * CHUNK_COLUMNS * 30;
    for (const i of [0, 17, 63]) {
      const expected = chunkX + (i + 0.5) * 30;
      for (const j of [0, 40, 63])
        assert.ok(
          Math.abs(heights[j * CHUNK_COLUMNS + i] - expected) <= 31,
          `column ${i},${j}: ${heights[j * CHUNK_COLUMNS + i]} vs ${expected}`,
        );
    }
  }
});

test('groupOf and groupBounds: a 4-chunk grid, the box around the corner chunks', () => {
  assert.equal(CHUNK_GROUP, 4);
  assert.deepEqual(groupOf(5, -3), { gi: 1, gj: -1 });
  assert.deepEqual(groupOf(-1, 0), { gi: -1, gj: 0 });
  assert.deepEqual(groupOf(3, 4), { gi: 0, gj: 1 });
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 10 });
  const box = groupBounds(region, 1, -1);
  const sw = region.chunkBounds(4, -4);
  const ne = region.chunkBounds(7, -1);
  assert.ok(box.west <= sw.west && box.south <= sw.south);
  assert.ok(box.east >= ne.east && box.north >= ne.north);
  // Every chunk of the group lies inside it; the next group's do not.
  for (let ci = 4; ci < 8; ci++)
    for (let cj = -4; cj < 0; cj++) {
      const b = region.chunkBounds(ci, cj);
      assert.ok(b.west >= box.west && b.east <= box.east);
      assert.ok(b.south >= box.south && b.north <= box.north);
    }
  // Four chunks wide (the boxes overlap a hair: the squares are turned by
  // the meridians converging).
  const width = (b) => b.east - b.west;
  assert.ok(Math.abs(width(box) / width(sw) - 4) < 0.01);
});

test('loadChunk: one 256-cell request over the group, its chunks cut from it', async () => {
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 10 });
  // Sea west of the origin, land rising east of it, a nodata hole north.
  const mPerLon = M_PER_DEG * Math.cos((39.3 * Math.PI) / 180);
  const heightAt = (lon, lat) =>
    lat > region.lat0 + 500 / M_PER_DEG
      ? NaN
      : lon < region.lon0
        ? -3
        : (lon - region.lon0) * mPerLon * 0.1;
  const { fetchValues, calls } = fakeValues({ nativeM: 10, heightAt });
  const source = createChunkSource({ fetchValues, createChunk });
  const chunk = await source.loadChunk(region, -1, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].box, groupBounds(region, -1, 0));
  assert.equal(calls[0].cells, GROUP_COLUMNS);
  assert.equal(GROUP_COLUMNS, 256);
  assert.equal(chunk.stub, true);
  assert.equal(chunk.ci, -1);
  assert.equal(chunk.cj, 0);
  assert.ok(chunk.top instanceof Int32Array);
  assert.equal(chunk.top.length, CHUNK_COLUMNS * CHUNK_COLUMNS);
  // Chunk -1 is all west of the origin: seabed -1, water 0.
  assert.equal(chunk.top[0], -1);
  assert.equal(chunk.water[0], 0);
  // Row 63 is 635 m north: nodata.
  assert.equal(chunk.top[63 * CHUNK_COLUMNS], NONE);
  // Chunk 0 is in another group (0, 0): a second request.
  const east = await source.loadChunk(region, 0, 0);
  assert.equal(calls.length, 2);
  // 10% grade: column 63's centre is 635 m east, 63.5 m high, level 6.
  assert.equal(east.top[63], 6);
  assert.equal(east.water[63], NONE);
  // Its neighbour east in the same group came with it: column 0 of chunk
  // 1 is 645 m east, level 6; no request.
  const next = await source.loadChunk(region, 1, 0);
  assert.equal(calls.length, 2);
  assert.equal(next.top[0], 6);
  assert.equal(next.top[63], 12); // 1275 m east, 127.5 m
});

test('loadChunk: a group fetched once serves its 16 chunks and the coarse one', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
  });
  const source = createChunkSource({ fetchValues, createChunk });
  // Two chunks of one group asked at once: one request, the second waits on it.
  const [a, b] = await Promise.all([
    source.loadChunk(region, 4, 8),
    source.loadChunk(region, 7, 11),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(a.ci, 4);
  assert.equal(b.cj, 11);
  assert.equal(source.size(), 17);
  const all = [];
  for (let ci = 4; ci < 8; ci++)
    for (let cj = 8; cj < 12; cj++) all.push(source.loadChunk(region, ci, cj));
  const chunks = await Promise.all(all);
  assert.equal(new Set(chunks).size, 16);
  const coarse = await source.loadCoarseChunk(region, 1, 2);
  assert.equal(calls.length, 1);
  assert.equal(coarse.ci, 1);
  assert.equal(coarse.cj, 2);
  // The same chunk object each time.
  assert.equal(await source.loadChunk(region, 4, 8), a);
  // A coarse chunk asked first fetches the group and brings the fine ones.
  const [c] = await Promise.all([
    source.loadCoarseChunk(region, 0, 0),
    source.loadChunk(region, 3, 3),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(c.ci, 0);
  // Another region with the same chunk numbers is another group.
  await source.loadChunk(
    createRegion({ lon0: 0.5, lat0: 51.5, blockM: 10 }),
    4,
    8,
  );
  assert.equal(calls.length, 3);
});

test('loadChunk: the LRU holds at most maxChunks; an evicted chunk asks its group again', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
  });
  const source = createChunkSource({ fetchValues, createChunk, maxChunks: 3 });
  await source.loadChunk(region, 0, 0);
  assert.equal(source.size(), 3);
  assert.equal(calls.length, 1);
  // (0, 0) was asked first, then 16 siblings and the coarse chunk went in after it.
  await source.loadChunk(region, 0, 0);
  assert.equal(calls.length, 2);
});

test('coarseHeights: the mean of each block of finite heights; NaN where none', () => {
  // 8 × 8 field, factor 4: four blocks.
  const size = 8;
  const field = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) field[j * size + i] = i + 10 * j;
  field[0] = NaN; // one hole in the south-west block
  for (let j = 4; j < 8; j++)
    for (let i = 4; i < 8; i++) field[j * size + i] = NaN;
  const coarse = coarseHeights(field, size, 4);
  // South-west: mean of i + 10j over 0..3 less the (0, 0) cell: (1.5·16 + 15·16 − 0) / 15.
  assert.ok(Math.abs(coarse[0] - (16 * 1.5 + 16 * 15) / 15) < 1e-4);
  assert.ok(Math.abs(coarse[1] - (5.5 + 15)) < 1e-4); // south-east
  assert.ok(Math.abs(coarse[2] - (1.5 + 55)) < 1e-4); // north-west
  assert.ok(Number.isNaN(coarse[3])); // north-east: all nodata
});

test('loadCoarseChunk: 4 × blockM levels from the mean of 4 × 4 columns, water at a mean ≤ 0', async () => {
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 });
  // Height = metres east of the origin, less 100: the sea west of 100 m.
  const heightAt = (lon, lat) => {
    const { x, y } = region.toLocal(lon, lat);
    return y > 200 ? NaN : x - 100;
  };
  const { fetchValues, calls } = fakeValues({ nativeM: 1, heightAt });
  const source = createChunkSource({ fetchValues, createChunk });
  const coarse = await source.loadCoarseChunk(region, 0, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cells, GROUP_COLUMNS);
  assert.equal(coarse.ci, 0);
  assert.equal(coarse.top.length, CHUNK_COLUMNS * CHUNK_COLUMNS);
  // Coarse column i covers fine columns 4i … 4i+3, centres 4i+0.5 … 4i+3.5 m
  // east: mean height 4i + 2 − 100; level floor(that / 4).
  for (const i of [0, 10, 24, 25, 26, 40, 63]) {
    const mean = 4 * i + 2 - 100;
    const k = 5 * CHUNK_COLUMNS + i; // row 5: 20–24 m north, inside the data
    if (mean <= 0) {
      assert.equal(coarse.water[k], 0, `column ${i} is sea`);
      assert.equal(coarse.top[k], Math.min(Math.floor(mean / 4), -1));
    } else {
      assert.equal(coarse.water[k], NONE);
      assert.equal(coarse.top[k], Math.floor(mean / 4), `column ${i}`);
    }
  }
  // Row 63 covers 252–256 m north: no data, NONE.
  assert.equal(coarse.top[63 * CHUNK_COLUMNS + 30], NONE);
  // The fine chunks came with it.
  const fine = await source.loadChunk(region, 1, 0);
  assert.equal(calls.length, 1);
  assert.equal(fine.top[0], Math.floor(64.5 - 100)); // column 64, centre 64.5 m
});

test('loadChunk: a failure rejects with its status and is asked again', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
    fail: 1,
  });
  const source = createChunkSource({ fetchValues, createChunk });
  await assert.rejects(
    source.loadChunk(region, 0, 0),
    (error) => error.status === 503,
  );
  assert.equal(source.size(), 0);
  const chunk = await source.loadChunk(region, 0, 0);
  assert.equal(chunk.top[0], 0);
  assert.equal(calls.length, 2);
});

test('createChunkSource builds store chunks unless given createChunk', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues } = fakeValues({ nativeM: 30, heightAt: () => 12 });
  const chunk = await createChunkSource({ fetchValues }).loadChunk(
    region,
    0,
    0,
  );
  assert.equal(typeof chunk.occupancy, 'function');
  assert.equal(chunk.occupancy(5, 5, 0), MATERIALS.TERRAIN);
  assert.equal(chunk.occupancy(5, 5, 1), MATERIALS.AIR);
});
