// Personal fork: the Wikipedia coverage grid and its server routes
// (server/providers/wikipediaCoverage.js, server/providers/wikipediaCoverage/grid.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  BASE_HEIGHT,
  BASE_WIDTH,
  LEVELS,
  TILE_MAGIC,
  buildPyramid,
  cellOf,
  createAccumulator,
  downsample,
  encodeTile,
  levelForZoom,
  levelShape,
  mercatorLat,
  openGrid,
  quantile,
  readGridHeader,
  rowAreaKm2,
  rowAreas,
  tileValues,
  variantDomains,
  writeGrid,
} from './wikipediaCoverage/grid.js';
import {
  ATTRIBUTION,
  MAX_ZOOM,
  NEEDS_BUILD,
  coverageGridFile,
  createWikipediaCoverageHandler,
  createWikipediaCoverageService,
} from './wikipediaCoverage.js';

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-wcov-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** A grid with the given articles at (lat, lon[, bytes]), written to a file. */
function writeTestGrid(file, points, { text = false, header = {} } = {}) {
  const accumulator = createAccumulator({ text });
  for (const [lat, lon, bytes = 0] of points) {
    const index = accumulator.add(lat, lon);
    accumulator.addBytes(index, bytes);
  }
  const levels = buildPyramid({
    counts: accumulator.counts,
    bytes: text ? accumulator.bytes : null,
  });
  writeGrid(file, {
    header: {
      builtAt: '2026-10-17T12:00:00.000Z',
      dump: {
        date: '2026-10-01',
        lastModified: 'Wed, 01 Oct 2026 03:14:15 GMT',
      },
      rows: { read: points.length, kept: points.length },
      text: { included: text },
      domains: variantDomains(levels[0]),
      ...header,
    },
    levels,
  });
  return accumulator;
}

const decodeTile = (buffer) => {
  assert.equal(buffer.toString('latin1', 0, 4), TILE_MAGIC);
  const width = buffer.readUInt32LE(4);
  const height = buffer.readUInt32LE(8);
  assert.equal(buffer.readUInt32LE(12), 1, 'float32');
  const values = new Float32Array(width * height);
  Buffer.from(values.buffer).set(buffer.subarray(16));
  return { width, height, values };
};

test('cells: row 0 is the north edge, the poles and 180° fall in the last cells, outside is null', () => {
  assert.deepEqual(levelShape(0), {
    level: 0,
    width: 7200,
    height: 3600,
    cellDeg: 0.05,
  });
  assert.deepEqual(levelShape(4), {
    level: 4,
    width: 450,
    height: 225,
    cellDeg: 0.8,
  });
  assert.throws(() => levelShape(LEVELS), RangeError);
  assert.deepEqual(cellOf(90, 0), { row: 0, col: 3600 });
  assert.deepEqual(cellOf(-90, 0), { row: BASE_HEIGHT - 1, col: 3600 });
  assert.deepEqual(cellOf(0, 180), { row: 1800, col: BASE_WIDTH - 1 });
  assert.deepEqual(cellOf(0, -180), { row: 1800, col: 0 });
  assert.deepEqual(cellOf(0, 0), { row: 1800, col: 3600 });
  assert.deepEqual(cellOf(39.29, -76.61), { row: 1014, col: 2067 });
  assert.deepEqual(cellOf(89.99, 179.99), { row: 0, col: 7199 });
  assert.deepEqual(cellOf(-89.99, -179.99), { row: 3599, col: 0 });
  assert.deepEqual(cellOf(39.29, -76.61, 4), { row: 63, col: 129 });
  assert.equal(cellOf(90.01, 0), null);
  assert.equal(cellOf(0, 180.01), null);
  assert.equal(cellOf(-90.5, 0), null);
  assert.equal(cellOf(NaN, 0), null);
  assert.equal(cellOf(0, undefined), null);
});

test('cell areas follow cos(lat) and sum to the sphere', () => {
  const equator = rowAreaKm2(0, 1800);
  // 0.05° of a great circle is 5.56 km; an equatorial cell is about 31 km².
  assert.ok(Math.abs(equator - 30.9) < 0.1, `${equator} km² on the equator`);
  const sixty = rowAreaKm2(0, cellOf(60.025, 0).row);
  assert.ok(
    Math.abs(sixty / equator - Math.cos((60.025 * Math.PI) / 180)) < 1e-3,
  );
  const pole = rowAreaKm2(0, 0);
  assert.ok(pole > 0 && pole < equator / 1000, 'the polar cell is a sliver');
  for (const level of [0, 2, 4]) {
    const { height, width } = levelShape(level);
    let total = 0;
    const areas = rowAreas(level);
    for (let row = 0; row < height; row++) total += areas[row] * width;
    const sphere = 4 * Math.PI * 6371.0088 ** 2;
    assert.ok(
      Math.abs(total / sphere - 1) < 1e-9,
      `level ${level}: ${total} km²`,
    );
  }
  assert.throws(() => rowAreaKm2(0, 3600), RangeError);
});

test('the pyramid sums 2 × 2 blocks and keeps the total at every level', () => {
  const small = downsample(Uint32Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 4, 2);
  assert.deepEqual([...small], [1 + 2 + 5 + 6, 3 + 4 + 7 + 8]);
  assert.throws(() => downsample(new Uint32Array(6), 3, 2), RangeError);
  const accumulator = createAccumulator({ text: true });
  let seed = 11;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  let total = 0;
  let bytes = 0;
  for (let i = 0; i < 2000; i++) {
    const index = accumulator.add(random() * 180 - 90, random() * 360 - 180);
    const size = Math.floor(random() * 5000);
    accumulator.addBytes(index, size);
    total += 1;
    bytes += size;
  }
  assert.equal(accumulator.add(91, 0), -1);
  const levels = buildPyramid({
    counts: accumulator.counts,
    bytes: accumulator.bytes,
  });
  assert.equal(levels.length, LEVELS);
  for (const level of levels) {
    assert.equal(level.counts.length, level.width * level.height);
    let sum = 0;
    let sumBytes = 0;
    for (const count of level.counts) sum += count;
    for (const size of level.bytes) sumBytes += size;
    assert.equal(sum, total, `level ${level.level}`);
    assert.ok(
      Math.abs(sumBytes - bytes) < bytes * 1e-6,
      `level ${level.level} bytes`,
    );
    assert.ok(level.bytes instanceof Float32Array);
  }
  // The coarse cell over a base cell holds at least that cell's count.
  const base = cellOf(39.29, -76.61);
  const coarse = cellOf(39.29, -76.61, 4);
  assert.ok(
    levels[4].counts[coarse.row * 450 + coarse.col] >=
      levels[0].counts[base.row * BASE_WIDTH + base.col],
  );
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5], 1), 5);
});

test('the grid file round-trips its header and arrays, reading a level only when asked', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'grid.bin');
  const accumulator = writeTestGrid(
    file,
    [
      [39.27, -76.63, 1000],
      [39.27, -76.63, 2000],
      [51.47, -0.13, 500],
      [0, 0, 1],
    ],
    { text: true },
  );
  const { header } = readGridHeader(file);
  assert.equal(header.version, 1);
  assert.equal(header.cellDeg, 0.05);
  assert.equal(header.levels.length, LEVELS);
  assert.equal(header.levels[0].arrays.counts.dtype, 'u32');
  assert.equal(header.levels[0].arrays.bytes.dtype, 'f32');
  assert.equal(header.levels[0].arrays.counts.offset % 8, 0);
  const grid = openGrid(file);
  assert.deepEqual(grid.loaded(), []);
  const base = grid.level(0);
  assert.deepEqual(grid.loaded(), [0]);
  assert.equal(base.counts[1014 * BASE_WIDTH + 2067], 2);
  assert.equal(base.bytes[1014 * BASE_WIDTH + 2067], 3000);
  assert.deepEqual([...base.counts], [...accumulator.counts]);
  assert.equal(grid.level(4).counts[63 * 450 + 129], 2);
  assert.equal(grid.level(0), base, 'kept once read');
  assert.equal(grid.hasText, true);
  assert.deepEqual(header.domains.count, {
    min: 1,
    max: 2,
    median: 1,
    cells: 3,
  });
  // Without text the arrays are absent, not empty.
  writeTestGrid(path.join(root, 'plain.bin'), [[0, 0]]);
  const plain = openGrid(path.join(root, 'plain.bin'));
  assert.equal(plain.hasText, false);
  assert.equal(plain.level(0).bytes, null);
  assert.equal(plain.header.domains.text, null);
  fs.writeFileSync(path.join(root, 'junk.bin'), 'not a grid at all');
  assert.throws(
    () => readGridHeader(path.join(root, 'junk.bin')),
    /Not a WGRD file/,
  );
});

test('tiles: the level follows the zoom, and a pixel sums the cells under it', async (t) => {
  assert.equal(levelForZoom(0), 4);
  assert.equal(levelForZoom(1), 3);
  assert.equal(levelForZoom(2), 2);
  assert.equal(levelForZoom(3), 1);
  assert.equal(levelForZoom(4), 0);
  assert.equal(levelForZoom(9), 0);
  assert.ok(Math.abs(mercatorLat(0.5)) < 1e-12);
  assert.ok(Math.abs(mercatorLat(0) - 85.0511287798) < 1e-6);
  assert.ok(Math.abs(mercatorLat(1) + 85.0511287798) < 1e-6);

  const root = await tempRoot(t);
  const file = path.join(root, 'grid.bin');
  // One article just north-east of (0, 0): base cell row 1799, column 3600;
  // level-4 cell row 112, column 225.
  writeTestGrid(file, [[0.025, 0.025, 4000]], { text: true });
  const grid = openGrid(file);

  // z=0: the world in one tile, 1.40625° pixels, level 4 (0.8° cells). Our
  // level-4 cell (row 112, column 225) is centred on (0.0°, 0.4°): on the
  // equator, the edge between pixel rows 127 and 128. A pixel takes the
  // cells whose centres fall in its half-open span, so the cell goes to row
  // 128, which spans longitude [0, 1.40625) and latitude [-1.4061, 0]:
  // columns 225–226 (centres 0.4°, 1.2°) and rows 112–113 (centres 0.0°,
  // -0.8°), four cells, one of them ours.
  const world = tileValues(grid, 'count', 0, 0, 0);
  assert.equal(world.length, 256 * 256);
  assert.equal(world[128 * 256 + 128], 1);
  assert.equal(world[128 * 256 + 127], 0, 'west of the origin');
  assert.equal(world[127 * 256 + 128], 0, 'north of the equator');
  assert.equal(world[129 * 256 + 128], 0, 'further south');
  let total = 0;
  for (const value of world) total += value;
  assert.equal(total, 1, 'every article is under exactly one pixel');
  // Tile values are Float32: compare to seven digits.
  const close = (actual, expected) =>
    assert.ok(
      Math.abs(actual - expected) < Math.abs(expected) * 1e-6,
      `${actual} is not ${expected}`,
    );
  const density = tileValues(grid, 'articles', 0, 0, 0);
  const fourCells = 2 * (rowAreaKm2(4, 112) + rowAreaKm2(4, 113));
  close(density[128 * 256 + 128], 1 / fourCells);
  const text = tileValues(grid, 'text', 0, 0, 0);
  close(text[128 * 256 + 128], 4000 / fourCells);

  // z=5: 0.0439° pixels, finer than a cell, level 0. The article's tile is
  // x=16, y=15; inside it the pixel at column 0, row 255 spans longitude
  // [0, 0.0439) and latitude [0, 0.0439): only base cell (1799, 3600),
  // whose centre is (0.025, 0.025), so the pixel shows that one cell.
  const deep = tileValues(grid, 'articles', 5, 16, 15);
  close(deep[255 * 256], 1 / rowAreaKm2(0, 1799));
  assert.equal(deep[254 * 256], 0, 'the cell above is empty');
  assert.equal(deep[255 * 256 + 1], 0, 'the cell to the east is empty');
  assert.equal(tileValues(grid, 'count', 5, 16, 15)[255 * 256], 1);
  // A pixel smaller than a cell inside the same cell reads the whole cell.
  const deeper = tileValues(grid, 'count', 9, 256, 255);
  let seen = 0;
  for (const value of deeper) if (value === 1) seen += 1;
  assert.ok(seen > 100, `${seen} pixels of a 0.05° cell at z=9`);

  // z=1: 0.703° pixels, level 3 (0.4° cells). Tile (1, 0) is the north-east
  // quarter; the article sits at its bottom-left pixel (column 0, row 255).
  const quarter = tileValues(grid, 'count', 1, 1, 0);
  assert.equal(quarter[255 * 256], 1);
  assert.equal(tileValues(grid, 'count', 1, 0, 0)[255 * 256 + 255], 0);
  assert.equal(tileValues(grid, 'count', 1, 1, 1)[0], 0);

  assert.throws(() => tileValues(grid, 'pages', 0, 0, 0), /No variant/);
  assert.throws(() => tileValues(grid, 'count', 1, 2, 0), /out of range/);
  const encoded = encodeTile(world);
  assert.equal(encoded.length, 16 + 256 * 256 * 4);
  const decoded = decodeTile(encoded);
  assert.equal(decoded.width, 256);
  assert.equal(decoded.values[128 * 256 + 128], 1);
});

test('a grid built without article sizes refuses the text variant', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'grid.bin');
  writeTestGrid(file, [[10, 10]]);
  const grid = openGrid(file);
  assert.throws(
    () => tileValues(grid, 'text', 0, 0, 0),
    /without article sizes/,
  );
});

test('the service says to build the grid when there is none, then serves it and sees a rebuild', async (t) => {
  const root = await tempRoot(t);
  assert.match(
    coverageGridFile({}, root).replace(/\\/g, '/'),
    /\.gev-cache\/wikipedia\/grid\.bin$/,
  );
  assert.match(
    coverageGridFile({ WIKIPEDIA_COVERAGE_DIR: 'elsewhere' }, root).replace(
      /\\/g,
      '/',
    ),
    /\/elsewhere\/grid\.bin$/,
  );
  let clock = 0;
  const service = createWikipediaCoverageService({
    sourceRoot: root,
    env: {},
    now: () => clock,
  });
  const empty = await service.layers();
  assert.equal(empty.configured, false);
  assert.equal(empty.message, NEEDS_BUILD);
  assert.equal(empty.attribution, ATTRIBUTION);
  assert.deepEqual(
    empty.variants.map((variant) => [variant.key, variant.available]),
    [
      ['articles', false],
      ['text', false],
      ['count', false],
      ['capita', false],
      ['textcapita', false],
    ],
  );
  assert.equal((await service.tile('articles', 0, 0, 0)).status, 503);

  const file = coverageGridFile({}, root);
  writeTestGrid(file, [
    [39.27, -76.63],
    [39.27, -76.63],
    [51.47, -0.13],
  ]);
  clock += 10_000;
  const built = await service.layers();
  assert.equal(built.configured, true);
  assert.equal(built.builtAt, '2026-10-17T12:00:00.000Z');
  assert.equal(built.dump.date, '2026-10-01');
  assert.deepEqual(built.rows, { kept: 3, read: 3 });
  assert.equal(built.text, false);
  assert.equal(built.maxZoom, MAX_ZOOM);
  assert.equal(
    built.tileUrl,
    '/api/wikipedia-coverage/tile/{variant}/{z}/{x}/{y}',
  );
  assert.equal(built.attribution, ATTRIBUTION);
  const byKey = Object.fromEntries(
    built.variants.map((variant) => [variant.key, variant]),
  );
  assert.equal(byKey.articles.available, true);
  assert.ok(byKey.articles.domain.max > byKey.articles.domain.min);
  assert.deepEqual(byKey.count.domain, { min: 1, max: 2, median: 1 });
  assert.deepEqual(byKey.text, { key: 'text', available: false });

  const tile = await service.tile('count', 0, 0, 0);
  assert.equal(tile.status, 200);
  assert.equal(tile.contentType, 'application/octet-stream');
  const { values } = decodeTile(tile.body);
  let total = 0;
  for (const value of values) total += value;
  assert.equal(total, 3);
  assert.equal((await service.tile('text', 0, 0, 0)).status, 404);
  assert.equal((await service.tile('pages', 0, 0, 0)).status, 404);
  assert.equal((await service.tile('count', 1, 2, 0)).status, 400);
  assert.equal((await service.tile('count', MAX_ZOOM + 1, 0, 0)).status, 400);
  assert.equal((await service.tile('count', MAX_ZOOM, 0, 0)).status, 200);

  // A rebuild with article sizes is picked up once the file is stat'ed again.
  writeTestGrid(file, [[39.27, -76.63, 2500]], {
    text: true,
    header: { builtAt: '2026-11-17T12:00:00.000Z' },
  });
  clock += 10_000;
  const rebuilt = await service.layers();
  assert.equal(rebuilt.builtAt, '2026-11-17T12:00:00.000Z');
  assert.equal(rebuilt.text, true);
  assert.equal(rebuilt.variants.find((v) => v.key === 'text').available, true);
  assert.equal((await service.tile('text', 0, 0, 0)).status, 200);

  // An unreadable file is reported, not thrown.
  fs.writeFileSync(file, 'garbage');
  clock += 10_000;
  const broken = await service.layers();
  assert.equal(broken.configured, false);
  assert.match(broken.message, /not readable: Not a WGRD file/);
});

test('the routes are same-site only and GET only, and gzip tiles for a browser that accepts it', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'grid.bin');
  writeTestGrid(file, [[0.025, 0.025]]);
  const service = createWikipediaCoverageService({
    sourceRoot: root,
    env: {},
    gridFile: file,
  });
  const handler = createWikipediaCoverageHandler({ service });
  const call = async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.raw = body;
        this.body =
          Buffer.isBuffer(body) &&
          !/json/.test(this.headers['content-type'] || '')
            ? body
            : JSON.parse(body);
      },
    };
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
      },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  assert.equal(
    (await call('/layers', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  assert.equal((await call('/layers', { method: 'POST' })).statusCode, 405);
  const layers = await call('/layers');
  assert.equal(layers.statusCode, 200);
  assert.equal(layers.body.configured, true);
  assert.equal(layers.headers['cache-control'], 'no-store');

  const raw = await call('/tile/count/0/0/0');
  assert.equal(raw.statusCode, 200);
  assert.equal(raw.headers['content-type'], 'application/octet-stream');
  assert.equal(raw.headers['content-encoding'], undefined);
  assert.equal(raw.headers['cache-control'], 'private, max-age=86400');
  assert.equal(Number(raw.headers['content-length']), raw.body.length);
  assert.equal(decodeTile(raw.body).values[128 * 256 + 128], 1);

  const zipped = await call('/tile/count/0/0/0', {
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.vary, 'Accept-Encoding');
  assert.ok(
    zipped.body.length < raw.body.length / 10,
    'a sparse tile packs small',
  );
  assert.deepEqual(zlib.gunzipSync(zipped.body), raw.body);

  const unknown = await call('/tile/pages/0/0/0');
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.body, { error: 'No such variant' });
  assert.equal((await call('/tile/text/0/0/0')).statusCode, 404);
  assert.equal((await call('/tile/count/1/2/0')).statusCode, 400);
  assert.equal((await call('/tile/../../etc/0/0')).nexted, true);
  assert.equal((await call('/tile/count/x/0/0')).nexted, true);
  assert.equal((await call('/nothing')).nexted, true);

  const none = createWikipediaCoverageHandler({
    service: createWikipediaCoverageService({
      sourceRoot: root,
      env: {},
      gridFile: path.join(root, 'missing.bin'),
    }),
  });
  const res = {
    headers: {},
    setHeader(n, v) {
      this.headers[n] = v;
    },
    end(b) {
      this.body = JSON.parse(b);
    },
  };
  await none(
    {
      url: '/tile/articles/0/0/0',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, NEEDS_BUILD);
});
