// Personal fork: the Blocks chunk source (src/layers/blocks/source.js):
// block size from the stack's native cell, heights to columns, sampling a
// chunk's answer, the chunk cache, shared requests and retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_COLUMNS,
  ELEVATION_LAYER,
  MATERIAL,
  NONE,
  columnsFromHeights,
  createChunkSource,
  probeBox,
  sampleColumns,
  snapBlockM,
} from './source.js';

const M_PER_DEG = 111_319.49;

/** A tangent-plane region per the plan's grid.js contract (enough for tests). */
function stubRegion({ lon0, lat0, blockM }) {
  const mPerLon = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const chunkM = CHUNK_COLUMNS * blockM;
  const toLonLat = (x, y) => ({
    lon: lon0 + x / mPerLon,
    lat: lat0 + y / M_PER_DEG,
  });
  return {
    lon0,
    lat0,
    blockM,
    toLonLat,
    chunkOrigin: (ci, cj) => ({ x: ci * chunkM, y: cj * chunkM }),
    chunkBounds(ci, cj) {
      const sw = toLonLat(ci * chunkM, cj * chunkM);
      const ne = toLonLat((ci + 1) * chunkM, (cj + 1) * chunkM);
      return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
    },
  };
}

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
  const { TERRAIN: T, AIR: A } = MATERIAL;
  assert.deepEqual([...material], [T, T, T, T, T, T, A, T]);
  const coarse = columnsFromHeights(
    Float32Array.from([29.9, 30, 59.9, 60]),
    30,
  );
  assert.deepEqual([...coarse.top], [0, 1, 1, 2]);
});

test('sampleColumns: each column reads the cell under its centre, even on a 63-cell answer', () => {
  const region = stubRegion({ lon0: -76.6, lat0: 39.3, blockM: 30 });
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

test('loadChunk: one request over the chunk bounds, columns into createChunk', async () => {
  const region = stubRegion({ lon0: -76.6, lat0: 39.3, blockM: 10 });
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
  assert.deepEqual(calls[0].box, region.chunkBounds(-1, 0));
  assert.equal(calls[0].cells, CHUNK_COLUMNS);
  assert.equal(chunk.stub, true);
  assert.equal(chunk.ci, -1);
  assert.equal(chunk.cj, 0);
  assert.ok(chunk.top instanceof Int32Array);
  assert.ok(chunk.material instanceof Uint8Array);
  assert.ok(chunk.water instanceof Int32Array);
  // West half sea (chunk -1 is all west of the origin): seabed -1, water 0.
  assert.equal(chunk.top[0], -1);
  assert.equal(chunk.water[0], 0);
  // Row 63 is 635 m north: nodata.
  assert.equal(chunk.top[63 * CHUNK_COLUMNS], NONE);

  const east = await source.loadChunk(region, 0, 0);
  // 10% grade: column 63's centre is 635 m east, 63.5 m high, level 6.
  assert.equal(east.top[63], 6);
  assert.equal(east.water[63], NONE);
});

test('loadChunk: shared in flight, kept by key, LRU-bounded', async () => {
  const region = stubRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
  });
  const source = createChunkSource({ fetchValues, createChunk, maxChunks: 3 });
  const [a, b] = await Promise.all([
    source.loadChunk(region, 0, 0),
    source.loadChunk(region, 0, 0),
  ]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  await source.loadChunk(region, 0, 0);
  assert.equal(calls.length, 1);
  // Another region with the same chunk numbers is another chunk.
  await source.loadChunk(
    stubRegion({ lon0: 0.5, lat0: 51.5, blockM: 10 }),
    0,
    0,
  );
  assert.equal(calls.length, 2);
  await source.loadChunk(region, 1, 0);
  await source.loadChunk(region, 2, 0);
  assert.equal(source.size(), 3);
  // (0, 0) of the 30 m region was the least recently used: asked again.
  await source.loadChunk(region, 0, 0);
  assert.equal(calls.length, 5);
});

test('loadChunk: a failure rejects with its status and is asked again', async () => {
  const region = stubRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
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

test('createChunkSource needs the store createChunk', () => {
  assert.throws(
    () => createChunkSource({ fetchValues: async () => ({}) }),
    TypeError,
  );
});
