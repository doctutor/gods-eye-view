// Personal fork: the Blocks chunk source (src/layers/blocks/source.js):
// block size from the stack's native cell and the pyramid, heights to
// columns, sampling a chunk's answer, the lattice tiles asked, the chunk
// cache, shared requests and retries, any level.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_COLUMNS, createRegion } from './grid.js';
import { MATERIALS, NONE } from './store.js';
import {
  ELEVATION_LAYER,
  CHUNK_GROUP,
  COARSE_LEVELS_M,
  GROUP_COLUMNS,
  NATIVE_CELLS_M,
  PYRAMID_M,
  SUPERGROUP,
  coarseHeights,
  coarseLevelOf,
  columnsFromHeights,
  createChunkSource,
  groupBounds,
  groupOf,
  levelFor,
  levelMFor,
  levelOf,
  regionKey,
  supergroupBounds,
  supergroupOf,
  probeBox,
  sampleColumns,
  snapBlockM,
} from './source.js';
import { LATTICE_CELLS, latticeBox, latticeIndex } from './lattice.js';

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

/** Every call a lattice tile of `blockM` (512 cells, its exact box), none asked twice. */
function assertLatticeCalls(calls, blockM) {
  const seen = new Set();
  for (const call of calls) {
    assert.equal(call.layer, ELEVATION_LAYER);
    assert.equal(call.cells, LATTICE_CELLS);
    const { ti, tj } = latticeIndex(
      blockM,
      (call.box.west + call.box.east) / 2,
      (call.box.south + call.box.north) / 2,
    );
    assert.deepEqual(call.box, latticeBox(blockM, ti, tj));
    const key = JSON.stringify(call.box);
    assert.ok(!seen.has(key), `asked twice: ${key}`);
    seen.add(key);
  }
}

test('the pyramid: the native cells, then ×4 from 30 m; levelFor picks the smallest level at least both', () => {
  assert.deepEqual(COARSE_LEVELS_M, [120, 480, 1920, 7680, 30720]);
  for (const size of [...NATIVE_CELLS_M, ...COARSE_LEVELS_M])
    assert.ok(PYRAMID_M.includes(size), `${size}`);
  assert.deepEqual(
    [...PYRAMID_M].sort((a, b) => a - b),
    [...PYRAMID_M],
  );
  assert.equal(levelFor(1), 1);
  assert.equal(levelFor(1, 0.4), 1);
  assert.equal(levelFor(1, 3), 8);
  assert.equal(levelFor(30, 31), 120);
  assert.equal(levelFor(30, 1920), 1920);
  assert.equal(levelFor(10, 2000), 7680);
  assert.equal(levelFor(231, 100), 231); // the ocean's own cell
  assert.equal(levelFor(30, 1e9), 30720); // the top
});

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
    assert.equal(region.nativeM, blockM);
    assert.equal(region.source, `DEM ${nativeM} m`);
    assert.equal(calls[0].layer, ELEVATION_LAYER);
    assert.equal(calls[0].mode, '');
    assert.equal(calls[0].cells, CHUNK_COLUMNS);
    // One small probe resolves 1–30 m; GMTED needs the wider one.
    assert.equal(calls.length, nativeM > 64 ? 2 : 1);
  }
});

test('levelMFor: cubes at the native cells and to 30 m, then max(30 m, blockM / 32)', () => {
  for (const blockM of [1, 2, 4, 8, 10, 30, 231])
    assert.equal(levelMFor(blockM), blockM);
  assert.equal(levelMFor(120), 30);
  assert.equal(levelMFor(480), 30);
  assert.equal(levelMFor(1920), 60);
  assert.equal(levelMFor(7680), 240);
  assert.equal(levelMFor(30720), 960);
});

test('regionFor: the wanted block picks the pyramid level, never under the native cell', async () => {
  const { fetchValues } = fakeValues({
    nativeM: 30,
    heightAt: () => 5,
    source: 'FABDEM 30 m',
  });
  const source = createChunkSource({ fetchValues, createChunk });
  const coarse = await source.regionFor(-76.6, 39.3, {
    wantedM: 1500,
    windowM: 512,
  });
  assert.equal(coarse.blockM, 1920);
  assert.equal(coarse.levelM, 60);
  assert.equal(coarse.nativeM, 30);
  assert.equal(coarse.source, 'FABDEM 30 m');
  assert.ok(coarse.cellSizeM > 25 && coarse.cellSizeM < 40);
  const fine = await source.regionFor(-76.6, 39.3, { wantedM: 2 });
  assert.equal(fine.blockM, 30); // never under the native cell
  assert.equal(fine.levelM, 30);
  assert.equal((await source.regionFor(-76.6, 39.3, {})).blockM, 30);
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

test('loadChunk: a group read from lattice tiles of its level, its chunks cut from it', async () => {
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
  // A group (2,560 m) spans at most 2 × 2 tiles of 5,120 m.
  assert.ok(calls.length >= 1 && calls.length <= 4, `${calls.length}`);
  assertLatticeCalls(calls, 10);
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
  // Chunk 0 is in another group (0, 0), read from the tiles in hand or
  // the next ones: no tile asked twice.
  const east = await source.loadChunk(region, 0, 0);
  assertLatticeCalls(calls, 10);
  // 10% grade: column 63's centre is 635 m east, 63.5 m high, level 6.
  assert.equal(east.top[63], 6);
  assert.equal(east.water[63], NONE);
  // Its neighbour east in the same group came with it: column 0 of chunk
  // 1 is 645 m east, level 6; no request.
  const asked = calls.length;
  const next = await source.loadChunk(region, 1, 0);
  assert.equal(calls.length, asked);
  assert.equal(next.top[0], 6);
  assert.equal(next.top[63], 12); // 1275 m east, 127.5 m
});

test('the lattice: regions anchored apart at one level ask the same tiles', async () => {
  const heightAt = () => 40;
  const boxes = [];
  for (const lon0 of [-76.6, -76.6123, -76.587]) {
    const { fetchValues, calls } = fakeValues({ nativeM: 30, heightAt });
    const source = createChunkSource({ fetchValues, createChunk });
    await source.loadChunk(
      createRegion({ lon0, lat0: 39.3, blockM: 30 }),
      0,
      0,
    );
    boxes.push(...calls.map((call) => JSON.stringify(call.box)));
  }
  // Three anchors a kilometre or two apart: their groups overlap the same
  // 15 km tiles, so the three sources asked the same few boxes.
  assert.ok(new Set(boxes).size <= 4, `${new Set(boxes).size} boxes`);
  assert.ok(boxes.length >= 3);
});

test('loadChunk: a group built once serves its 16 chunks and the coarse one', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
  });
  const source = createChunkSource({ fetchValues, createChunk });
  // Two chunks of one group asked at once: one set of tiles, the second waits.
  const [a, b] = await Promise.all([
    source.loadChunk(region, 4, 8),
    source.loadChunk(region, 7, 11),
  ]);
  const first = calls.length;
  assert.ok(first >= 1 && first <= 4);
  assertLatticeCalls(calls, 30);
  assert.equal(a.ci, 4);
  assert.equal(b.cj, 11);
  assert.equal(source.size(), 17);
  const all = [];
  for (let ci = 4; ci < 8; ci++)
    for (let cj = 8; cj < 12; cj++) all.push(source.loadChunk(region, ci, cj));
  const chunks = await Promise.all(all);
  assert.equal(new Set(chunks).size, 16);
  const coarse = await source.loadCoarseChunk(region, 1, 2);
  assert.equal(calls.length, first);
  assert.equal(coarse.ci, 1);
  assert.equal(coarse.cj, 2);
  // The same chunk object each time.
  assert.equal(await source.loadChunk(region, 4, 8), a);
  // A coarse chunk asked while its fine group is in flight waits on that
  // group rather than asking its supergroup (whose tiles would be 120 m).
  const [, c] = await Promise.all([
    source.loadChunk(region, 3, 3),
    source.loadCoarseChunk(region, 0, 0),
  ]);
  assertLatticeCalls(calls, 30);
  assert.equal(c.ci, 0);
  // Another level is another lattice.
  const before = calls.length;
  await source.loadChunk(
    createRegion({ lon0: 0.5, lat0: 51.5, blockM: 10 }),
    4,
    8,
  );
  assert.ok(calls.length > before);
  assertLatticeCalls(calls.slice(before), 10);
});

test('loadChunk: the LRU holds at most maxChunks; an evicted chunk is rebuilt from the tiles held', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
  });
  const source = createChunkSource({ fetchValues, createChunk, maxChunks: 3 });
  const first = await source.loadChunk(region, 0, 0);
  assert.equal(source.size(), 3);
  const asked = calls.length;
  // (0, 0) was asked first, then 16 siblings and the coarse chunk went in
  // after it: rebuilt, from the tiles still held.
  const again = await source.loadChunk(region, 0, 0);
  assert.notEqual(again, first);
  assert.equal(calls.length, asked);
  // With no tiles kept, the tiles are asked again.
  const bare = fakeValues({ nativeM: 30, heightAt: () => 12 });
  const forgetful = createChunkSource({
    fetchValues: bare.fetchValues,
    createChunk,
    maxChunks: 3,
    maxTiles: 0,
  });
  await forgetful.loadChunk(region, 0, 0);
  const once = bare.calls.length;
  await forgetful.loadChunk(region, 0, 0);
  assert.equal(bare.calls.length, 2 * once);
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

test('supergroupOf and supergroupBounds: 4 × 4 groups, the box around their corner chunks', () => {
  assert.equal(SUPERGROUP, 4);
  assert.deepEqual(supergroupOf(5, -1), { si: 1, sj: -1 });
  assert.deepEqual(supergroupOf(-5, 3), { si: -2, sj: 0 });
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 });
  const box = supergroupBounds(region, 1, -1);
  for (const [gi, gj] of [
    [4, -4],
    [7, -4],
    [4, -1],
    [7, -1],
    [5, -2],
  ]) {
    const g = groupBounds(region, gi, gj);
    assert.ok(g.west >= box.west && g.east <= box.east, `group ${gi},${gj}`);
    assert.ok(g.south >= box.south && g.north <= box.north);
  }
  // Sixteen chunks wide: 1,024 blocks.
  const width = (b) => b.east - b.west;
  assert.ok(
    Math.abs(width(box) / width(groupBounds(region, 4, -4)) - 4) < 0.01,
  );
});

/** A ramp: metres east of the origin less 100 (the sea west of 100 m), nodata north of 200 m. */
function rampAt(region) {
  return (lon, lat) => {
    const { x, y } = region.toLocal(lon, lat);
    return y > 200 ? NaN : x - 100;
  };
}

/** Coarse column i of chunk 0 has its centre 4i + 2 m east: level floor((4i + 2 − 100) / 4). */
function assertRampLevels(coarse) {
  assert.equal(coarse.top.length, CHUNK_COLUMNS * CHUNK_COLUMNS);
  for (const i of [0, 10, 24, 25, 26, 40, 63]) {
    const h = 4 * i + 2 - 100;
    const k = 5 * CHUNK_COLUMNS + i; // row 5: 20–24 m north, inside the data
    if (h <= 0) {
      assert.equal(coarse.water[k], 0, `column ${i} is sea`);
      assert.equal(coarse.top[k], Math.min(Math.floor(h / 4), -1));
    } else {
      assert.equal(coarse.water[k], NONE);
      assert.equal(coarse.top[k], Math.floor(h / 4), `column ${i}`);
    }
  }
  // Row 63 covers 252–256 m north: no data, NONE.
  assert.equal(coarse.top[63 * CHUNK_COLUMNS + 30], NONE);
}

test("loadCoarseChunk: 16 coarse chunks at 4 × blockM from the coarse level's tiles", async () => {
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 1,
    heightAt: rampAt(region),
  });
  const source = createChunkSource({ fetchValues, createChunk });
  // Two coarse chunks of one supergroup asked at once: its tiles once.
  const [coarse, other] = await Promise.all([
    source.loadCoarseChunk(region, 0, 0),
    source.loadCoarseChunk(region, 3, 3),
  ]);
  // A supergroup (1,024 m) spans at most 2 × 2 tiles of 2,048 m at 4 m.
  assert.ok(calls.length >= 1 && calls.length <= 4);
  assertLatticeCalls(calls, 4);
  assert.equal(coarse.ci, 0);
  assert.equal(other.cj, 3);
  assertRampLevels(coarse);
  // All 16 of the supergroup are held; none costs another request.
  assert.equal(source.size(), 16);
  const asked = calls.length;
  for (let gi = 0; gi < 4; gi++)
    for (let gj = 0; gj < 4; gj++) await source.loadCoarseChunk(region, gi, gj);
  assert.equal(calls.length, asked);
  // Coarse chunk (1, 0): its column 0 is 256 + 2 m east, level floor(158 / 4).
  const east = await source.loadCoarseChunk(region, 1, 0);
  assert.equal(east.top[5 * CHUNK_COLUMNS], Math.floor((256 + 2 - 100) / 4));
  // The next supergroup reads the tiles it needs, none twice.
  await source.loadCoarseChunk(region, 4, 0);
  assertLatticeCalls(calls, 4);
});

test('loadCoarseChunk: the fine group coarse chunk, the mean of its columns, wins when loaded', async () => {
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 1,
    heightAt: rampAt(region),
  });
  const source = createChunkSource({ fetchValues, createChunk });
  // Fine group first: its coarse chunk comes free and is served as is.
  await source.loadChunk(region, 1, 0);
  const fine = calls.length;
  const exact = await source.loadCoarseChunk(region, 0, 0);
  assert.equal(calls.length, fine);
  assertRampLevels(exact);
  // Its supergroup neighbours are not held: (1, 0) reads the supergroup
  // from the coarse level's tiles.
  await source.loadCoarseChunk(region, 1, 0);
  assert.ok(calls.length > fine);
  // which leaves the fine group's (0, 0) in place.
  assert.equal(await source.loadCoarseChunk(region, 0, 0), exact);
  // A supergroup chunk is replaced once its fine group loads.
  const fromSuper = await source.loadCoarseChunk(region, 2, 0);
  await source.loadChunk(region, 8, 0); // group (2, 0)
  const replaced = await source.loadCoarseChunk(region, 2, 0);
  assert.notEqual(replaced, fromSuper);
  assert.equal(
    replaced.top[5 * CHUNK_COLUMNS],
    fromSuper.top[5 * CHUNK_COLUMNS],
  );
});

test('loadCoarseChunk: a failed supergroup rejects its waiting chunks and is asked again', async () => {
  const region = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 30 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 12,
    fail: 1,
  });
  const source = createChunkSource({ fetchValues, createChunk });
  const results = await Promise.allSettled([
    source.loadCoarseChunk(region, 0, 0),
    source.loadCoarseChunk(region, 1, 1),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(results[0].reason.status, 503);
  assert.equal(calls.length, 1);
  assert.equal(source.size(), 0);
  const coarse = await source.loadCoarseChunk(region, 1, 1);
  assert.equal(calls.length, 2);
  assert.equal(coarse.top[0], 0); // 12 m in 120 m blocks
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
  const first = calls.length;
  const chunk = await source.loadChunk(region, 0, 0);
  assert.equal(chunk.top[0], 0);
  // Only the failed tile is asked again; the others were kept.
  assert.equal(calls.length, first + 1);
});

test('any level: a region at 1,920 m is served like one at 1 m, its coarse ring at 7,680 m', async () => {
  const region = createRegion({ lon0: -95, lat0: 39, blockM: 1920 });
  // Heights rise 1 m a kilometre east of 100° W.
  const heightAt = (lon) => (lon + 100) * 85;
  const { fetchValues, calls } = fakeValues({ nativeM: 30, heightAt });
  const source = createChunkSource({ fetchValues, createChunk });
  const chunk = await source.loadChunk(region, 0, 0);
  assertLatticeCalls(calls, 1920);
  for (const call of calls) {
    assert.ok(call.box.west >= -180 && call.box.east <= 180);
    assert.ok(call.box.south >= -90 && call.box.north <= 90);
  }
  // Column 0's centre: 960 m east of 95° W, about 425 m high: level 0 of
  // 1,920 m cubes.
  assert.equal(
    chunk.top[0],
    Math.floor(heightAt(region.columnCentre(0, 0).lon) / 1920),
  );
  const asked = calls.length;
  const coarse = await source.loadCoarseChunk(region, 4, 0);
  assertLatticeCalls(calls.slice(asked), 7680);
  assert.equal(coarse.top.length, CHUNK_COLUMNS * CHUNK_COLUMNS);
});

test("the top level: places past the tangent plane's reach are nodata, and every box is on the globe", async () => {
  const region = createRegion({ lon0: 10, lat0: 50, blockM: 30720 });
  const { fetchValues, calls } = fakeValues({
    nativeM: 30,
    heightAt: () => 300,
  });
  const source = createChunkSource({ fetchValues, createChunk });
  const chunk = await source.loadCoarseChunk(region, 0, 0);
  for (const call of calls) {
    assert.ok(call.box.west >= -180 && call.box.east <= 180);
    assert.ok(call.box.south >= -90 && call.box.north <= 90);
  }
  // A coarse chunk of 122,880 m columns runs 7,864 km east: past the
  // Earth's radius the frame meets no ground, so its far columns are NONE.
  assert.equal(chunk.top[CHUNK_COLUMNS - 1], NONE);
  assert.equal(chunk.top[0], 0);
});

test("levels apart from blocks: a region's levelM sets its columns' levels, 4 × for its coarse chunks", async () => {
  const flat = createRegion({ lon0: 0.5, lat0: 51.5, blockM: 120 });
  assert.equal(levelOf(flat), 120);
  assert.equal(coarseLevelOf(flat), 480);
  const region = { ...flat, levelM: 30 };
  assert.equal(levelOf(region), 30);
  assert.equal(coarseLevelOf(region), 120);
  assert.equal(coarseLevelOf({ ...region, coarseLevelM: 60 }), 60);
  assert.notEqual(regionKey(region), regionKey(flat));
  const { fetchValues } = fakeValues({ nativeM: 30, heightAt: () => 95 });
  const source = createChunkSource({ fetchValues, createChunk });
  const chunk = await source.loadChunk(region, 0, 0);
  assert.equal(chunk.top[0], 3); // 95 m on 30 m levels
  const coarse = await source.loadCoarseChunk(region, 0, 0);
  assert.equal(coarse.top[0], 0); // 95 m on 120 m levels
  const cubes = await createChunkSource({ fetchValues, createChunk }).loadChunk(
    flat,
    0,
    0,
  );
  assert.equal(cubes.top[0], 0); // 95 m in 120 m cubes
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
