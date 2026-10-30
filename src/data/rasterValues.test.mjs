// Personal fork: raster values' encoding, parameters, grid and client
// (src/data/rasterValues.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CELLS,
  RASTER_VALUES_SCHEMA,
  cellAreaKm2,
  createRasterValuesClient,
  decodeRasterValues,
  encodeRasterValues,
  parseRasterValuesQuery,
  rasterValuesKey,
  rasterValuesUrl,
  valueRange,
  windowGrid,
} from './rasterValues.js';

const header = (extra = {}) => ({
  schema: RASTER_VALUES_SCHEMA,
  layer: 'ee-elevation',
  mode: '',
  cols: 3,
  rows: 2,
  west: 7.5,
  south: 45.8,
  east: 8,
  north: 46.2,
  cellSizeM: 12.5,
  units: 'm',
  nodata: NaN,
  min: -3.5,
  max: 4459,
  legendMin: 0,
  legendMax: 6400,
  source: 'FABDEM 30 m',
  version: 'abc123',
  aggregation: 'mean',
  ...extra,
});

test('the body round-trips: uint32 LE header length, JSON, Float32 LE values with NaN', () => {
  const values = new Float32Array([1028.25, NaN, -3.5, 4459, 0, NaN]);
  const body = encodeRasterValues(header(), values);
  const view = new DataView(body.buffer);
  const length = view.getUint32(0, true);
  // The values start on a 4-byte boundary and fill the rest.
  assert.equal((4 + length) % 4, 0);
  assert.equal(body.byteLength, 4 + length + values.length * 4);
  const json = JSON.parse(
    new TextDecoder().decode(body.subarray(4, 4 + length)),
  );
  assert.equal(json.nodata, 'NaN');
  assert.equal(view.getFloat32(4 + length, true), 1028.25);
  // Row-major, north row first: the second row's first value is index 3.
  assert.equal(view.getFloat32(4 + length + 12, true), 4459);

  const decoded = decodeRasterValues(body.buffer);
  assert.ok(Number.isNaN(decoded.header.nodata));
  assert.equal(decoded.header.cols, 3);
  assert.equal(decoded.header.source, 'FABDEM 30 m');
  assert.deepEqual([...decoded.values].map(String), [...values].map(String));
  // A Uint8Array view at an offset decodes the same.
  const shifted = new Uint8Array(body.byteLength + 3);
  shifted.set(body, 3);
  const again = decodeRasterValues(shifted.subarray(3));
  assert.equal(again.values[3], 4459);
});

test('an extra plane: named in the header after the values, the same layout; a reader of the values alone stops before it', () => {
  const values = new Float32Array([1, NaN, 3, 4]);
  const water = new Float32Array([0, 0.5, 1, 0.25]);
  const header = { layer: 'ee-elevation', mode: '', cols: 2, rows: 2 };
  const body = encodeRasterValues(header, values, { water });
  const decoded = decodeRasterValues(body);
  assert.deepEqual(decoded.header.planes, ['value', 'water']);
  assert.deepEqual([...decoded.water], [...water]);
  assert.ok(Number.isNaN(decoded.values[1]));
  const plain = encodeRasterValues(header, values);
  assert.equal(decodeRasterValues(plain).water, undefined);
  assert.equal(decodeRasterValues(plain).header.planes, undefined);
  // A header naming a plane the body lacks is refused.
  assert.throws(
    () => decodeRasterValues(body.subarray(0, body.byteLength - 4)),
    /fewer planes/,
  );
  // The request: water=1 is another key and URL; absent is as before.
  const request = {
    layer: 'ee-elevation',
    box: { west: 0, south: 0, east: 1, north: 1 },
    cells: 8,
  };
  assert.equal(
    rasterValuesKey({ ...request, water: true }),
    `${rasterValuesKey(request)}|water`,
  );
  assert.match(rasterValuesUrl({ ...request, water: true }), /&water=1$/);
  assert.doesNotMatch(rasterValuesUrl(request), /water/);
});

test('a body that lies about its size or schema is refused', () => {
  const body = encodeRasterValues(header(), new Float32Array(6));
  assert.throws(
    () => decodeRasterValues(body.subarray(0, body.length - 4)),
    /fewer values/,
  );
  const other = encodeRasterValues(
    header({ schema: 'raster-values/9' }),
    new Float32Array(6),
  );
  assert.throws(() => decodeRasterValues(other), /schema/);
  assert.throws(() => decodeRasterValues(new Uint8Array(2)), /no header/);
});

test('valueRange skips NaN; an empty grid has null min and max', () => {
  assert.deepEqual(valueRange(new Float32Array([NaN, 2, -1, NaN])), {
    min: -1,
    max: 2,
  });
  assert.deepEqual(valueRange(new Float32Array([NaN])), {
    min: null,
    max: null,
  });
});

test('the parameters: layer, mode, box and cells, else 400 (413 past 512 a side)', () => {
  const ok = {
    layer: 'ee-elevation',
    mode: '',
    west: '7.5',
    south: '45.8',
    east: '8',
    north: '46.2',
    cells: '256',
  };
  const parsed = parseRasterValuesQuery(
    new URLSearchParams({ ...ok, v: 'ignored' }),
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.box, {
    west: 7.5,
    south: 45.8,
    east: 8,
    north: 46.2,
  });
  assert.equal(parsed.cells, 256);
  assert.equal(parsed.mode, '');
  const status = (change) =>
    parseRasterValuesQuery({ ...ok, ...change }).status;
  assert.equal(status({ layer: '' }), 400);
  assert.equal(status({ layer: 'EE/../x' }), 400);
  assert.equal(status({ mode: 'a b' }), 400);
  assert.equal(status({ west: 'x' }), 400);
  assert.equal(status({ north: '' }), 400);
  assert.equal(status({ west: '8', east: '7.5' }), 400);
  assert.equal(status({ east: '181' }), 400);
  assert.equal(status({ south: '-91' }), 400);
  assert.equal(status({ cells: '0' }), 400);
  assert.equal(status({ cells: '12.5' }), 400);
  assert.equal(status({ cells: undefined }), 400);
  assert.equal(status({ cells: String(MAX_CELLS) }), undefined);
  assert.equal(status({ cells: String(MAX_CELLS + 1) }), 413);
});

test('the grid: cells on the longer side, square on the ground, never finer than the source', () => {
  // 0.5° × 0.4° at 46° N: 38.7 km × 44.5 km, so the rows are the longer side.
  const alps = { west: 7.5, south: 45.8, east: 8, north: 46.2 };
  const grid = windowGrid(alps, 256);
  assert.equal(grid.rows, 256);
  assert.equal(grid.cols, 222);
  assert.ok(Math.abs(grid.cellSizeM - 174.2) < 0.5, String(grid.cellSizeM));
  // A 2 km box over 30 m data asks 67 cells, not 512.
  const small = { west: 7.5, south: 45.8, east: 7.5258, north: 45.818 };
  const native = windowGrid(small, 512, 30);
  assert.equal(native.cols, 66);
  assert.ok(native.cellSizeM >= 29.9);
  // A sliver still has a cell.
  assert.equal(
    windowGrid({ west: 0, south: 0, east: 10, north: 0.0001 }, 64).rows,
    1,
  );
});

test('an equal-angle cell of 1° at the equator is about 12,364 km²', () => {
  assert.ok(Math.abs(cellAreaKm2(-0.5, 0.5, 1) - 12_364) < 5);
  assert.ok(cellAreaKm2(59.5, 60.5, 1) < cellAreaKm2(-0.5, 0.5, 1) / 1.9);
});

test('the client: one request per key, an LRU of answers, failures not kept', async () => {
  const body = encodeRasterValues(
    header(),
    new Float32Array([1, 2, 3, 4, 5, 6]),
  );
  const asked = [];
  let fail = false;
  const client = createRasterValuesClient({
    maxEntries: 2,
    fetchImpl: async (url) => {
      asked.push(url);
      if (fail)
        return Response.json(
          { error: 'Earth Engine is not set up' },
          { status: 503 },
        );
      return new Response(body, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    },
  });
  const box = { west: 7.5, south: 45.8, east: 8, north: 46.2 };
  const request = { layer: 'ee-elevation', mode: '', box, cells: 256 };
  const [a, b] = await Promise.all([client.get(request), client.get(request)]);
  assert.equal(asked.length, 1);
  assert.equal(a, b);
  assert.equal(a.values[5], 6);
  assert.match(
    asked[0],
    /^\/api\/raster\/values\?layer=ee-elevation&mode=&west=7\.5&south=45\.8&east=8&north=46\.2&cells=256$/,
  );
  assert.equal(asked[0], rasterValuesUrl(request));
  // The LRU drops the oldest past maxEntries.
  await client.get({ ...request, cells: 128 });
  await client.get({ ...request, cells: 64 });
  assert.equal(client.size(), 2);
  await client.get(request);
  assert.equal(asked.length, 4);
  // A failure rejects with the status and is asked again next time.
  fail = true;
  await assert.rejects(client.get({ ...request, cells: 32 }), (error) => {
    assert.equal(error.status, 503);
    assert.match(error.message, /not set up/);
    return true;
  });
  await assert.rejects(client.get({ ...request, cells: 32 }));
  assert.equal(asked.length, 6);
  assert.equal(rasterValuesKey(request), 'ee-elevation||7.5,45.8,8,46.2|256');
});

test('the client asks fetch at the priority given (none by default), and the priority is not part of what it holds', async () => {
  const seen = [];
  const body = encodeRasterValues(header(), new Float32Array(6));
  const client = createRasterValuesClient({
    fetchImpl: async (url, init) => {
      seen.push(init);
      return new Response(body, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    },
  });
  const box = { west: 0, south: 0, east: 1, north: 1 };
  await client.get({ layer: 'ee-elevation', box, cells: 2, priority: 'high' });
  assert.equal(seen[0].priority, 'high');
  // Held under the same key as without a priority: not asked again.
  await client.get({ layer: 'ee-elevation', box, cells: 2 });
  assert.equal(seen.length, 1);
  await client.get({ layer: 'ee-elevation', box, cells: 4 });
  assert.equal('priority' in seen[1], false);
});
