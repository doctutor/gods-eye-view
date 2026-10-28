// Personal fork: the raster values service (server/providers/rasterValues.js):
// Earth Engine through a mocked computePixels, Wikipedia coverage from a
// tiny grid, the parameters and the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EARTH_ENGINE_LAYERS } from '../../src/data/earthEngineLayers.js';
import { decodeRasterValues } from '../../src/data/rasterValues.js';
import { createEarthEngineService } from './earthEngine.js';
import {
  createRasterValuesHandler,
  createRasterValuesService,
} from './rasterValues.js';
import {
  legendRange,
  readNpy,
  valuesExpression,
} from './rasterValues/earthEngineValues.js';
import {
  buildPyramid,
  createAccumulator,
  variantDomains,
  writeGrid,
} from './wikipediaCoverage/grid.js';
import { writeTracts } from './census/tractsFile.js';

const record = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const ALPS = { west: 7.5, south: 45.8, east: 8, north: 46.2 };

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-rv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** An NPY structured array of float32 fields, as computePixels answers. */
function npy(rows, cols, fields) {
  const names = Object.keys(fields);
  const descr = names.map((name) => `('${name}', '<f4')`).join(', ');
  let header = `{'descr': [${descr}], 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  header += ' '.repeat(64 - ((10 + header.length + 1) % 64)) + '\n';
  const head = Buffer.alloc(10);
  head[0] = 0x93;
  head.write('NUMPY', 1, 'latin1');
  head[6] = 1;
  head.writeUInt16LE(header.length, 8);
  const body = Buffer.alloc(rows * cols * names.length * 4);
  for (let i = 0; i < rows * cols; i++)
    names.forEach((name, k) =>
      body.writeFloatLE(fields[name][i], (i * names.length + k) * 4),
    );
  return Buffer.concat([head, Buffer.from(header, 'latin1'), body]);
}

function earthEngine(root, layers, calls) {
  return createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers,
    backend: {
      async computePixels(expression, grid) {
        calls.push({ expression, grid });
        const { width, height } = grid.dimensions;
        const v = new Float32Array(width * height).map((_, i) => 1000 + i);
        const m = new Float32Array(width * height).fill(1);
        m[0] = 0; // the north-west cell is masked (sea)
        return { status: 200, body: npy(height, width, { v, m }) };
      },
    },
  });
}

function service(t, { layers = EARTH_ENGINE_LAYERS, ...options } = {}) {
  const root = tempRoot(t);
  const calls = [];
  const ee = earthEngine(root, layers, calls);
  const made = createRasterValuesService({
    sourceRoot: root,
    env: {},
    layers,
    earthEngine: ee,
    dirs: {
      overtureDir: path.join(root, 'overture'),
      censusDir: path.join(root, 'census'),
      gridFile: path.join(root, 'wikipedia', 'grid.bin'),
    },
    cacheDir: path.join(root, 'raster-values'),
    ...options,
  });
  t.after(() => made.close());
  return { service: made, calls, ee, root };
}

const query = (extra = {}) => ({
  layer: 'ee-elevation',
  mode: '',
  west: String(ALPS.west),
  south: String(ALPS.south),
  east: String(ALPS.east),
  north: String(ALPS.north),
  cells: '64',
  ...extra,
});

test('Elevation from computePixels: the DEM stack band for the cell, its heights, NaN where masked', async (t) => {
  const { service: values, calls, ee, root } = service(t);
  const answer = await values.values(query());
  assert.equal(answer.status, 200);
  const { header, values: grid } = decodeRasterValues(answer.body);
  assert.equal(header.schema, 'raster-values/1');
  assert.equal(header.layer, 'ee-elevation');
  assert.equal(header.mode, '');
  // 64 rows (the longer side), 55 columns: 700 m cells, the base band.
  assert.equal(header.rows, 64);
  assert.equal(header.cols, 55);
  assert.ok(Math.abs(header.cellSizeM - 703) < 2, String(header.cellSizeM));
  assert.equal(header.band, 'base');
  assert.equal(header.units, 'm');
  assert.equal(header.aggregation, 'mean');
  assert.equal(header.source, 'FABDEM 30 m');
  // The legend in metres: the map's √ scale (0 to 80) squared.
  assert.deepEqual([header.legendMin, header.legendMax], [0, 6400]);
  assert.ok(Number.isNaN(grid[0]));
  assert.equal(grid[1], 1001);
  assert.equal(header.min, 1001);
  assert.equal(header.max, 1000 + 64 * 55 - 1);
  // One call, on the window's grid in degrees, north row first.
  assert.equal(calls.length, 1);
  const { grid: asked, expression } = calls[0];
  assert.deepEqual(asked.dimensions, { width: 55, height: 64 });
  assert.equal(asked.crsCode, 'EPSG:4326');
  assert.equal(asked.affineTransform.translateX, 7.5);
  assert.equal(asked.affineTransform.translateY, 46.2);
  assert.ok(asked.affineTransform.scaleY < 0);
  // Heights, not the map's √: no Image.sqrt anywhere; the mask is a band.
  const text = JSON.stringify(expression);
  assert.doesNotMatch(text, /Image\.sqrt/);
  assert.match(text, /"Image\.mask"/);
  assert.equal(expression.result, 'rv');
  // Counted against the day's budget as one tile.
  assert.equal((await ee.layers()).tiles.used, 1);
  // Kept on disk under layer/mode/version: the second ask is not sent.
  const again = await values.values({ ...query(), v: 'anything' });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
  const kept = fs.readdirSync(
    path.join(root, 'raster-values', 'ee-elevation', 'default', header.version),
  );
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^[0-9a-f]{24}\.bin$/);
});

test('a close window reads the finest band, at most at the source’s own cell', async (t) => {
  const { service: values, calls } = service(t);
  // 200 m over Baltimore at 512 cells: 3DEP 1 m caps the cell at 1 m.
  const answer = await values.values(
    query({
      west: '-76.6125',
      south: '39.29',
      east: '-76.61',
      north: '39.2918',
      cells: '512',
    }),
  );
  const { header } = decodeRasterValues(answer.body);
  assert.equal(header.band, 'finest');
  assert.ok(header.cellSizeM >= 1, String(header.cellSizeM));
  assert.ok(header.cols < 512 && header.rows < 512);
  assert.match(header.source, /3DEP 1 m/);
  assert.equal(calls.length, 1);
});

test('a cell coarser than the source is the mean over it (reduceResolution), a native one is not', async (t) => {
  const { service: values, calls } = service(t);
  // 700 m cells over the Alps, FABDEM 30 m beneath: reduced.
  const coarse = decodeRasterValues((await values.values(query())).body);
  assert.equal(coarse.header.aggregation, 'mean');
  const reduced = JSON.stringify(calls[0].expression);
  assert.match(reduced, /"Image\.reduceResolution"/);
  assert.match(reduced, /"Reducer\.mean"/);
  assert.match(reduced, /"bestEffort":\{"constantValue":true\}/);
  assert.match(reduced, /"maxPixels":\{"constantValue":256\}/);
  // The mosaic given its source's 30 m cells before it is reduced.
  assert.match(reduced, /"scale":\{"constantValue":30\}/);
  // A 1 m window over 3DEP: the cells as they are, no reduction.
  await values.values(
    query({
      west: '-76.6125',
      south: '39.29',
      east: '-76.61',
      north: '39.2918',
      cells: '512',
    }),
  );
  assert.doesNotMatch(JSON.stringify(calls[1].expression), /reduceResolution/);
});

test('a reduction Earth Engine refuses: the sampled cells, said so and not kept; a 429 is not retried', async (t) => {
  const root = tempRoot(t);
  let refuse = 400;
  const calls = [];
  const ee = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: EARTH_ENGINE_LAYERS,
    backend: {
      async computePixels(expression, grid) {
        calls.push(expression);
        if (JSON.stringify(expression).includes('reduceResolution'))
          return { status: refuse, error: 'refused' };
        const { width, height } = grid.dimensions;
        const v = new Float32Array(width * height).fill(500);
        const m = new Float32Array(width * height).fill(1);
        return { status: 200, body: npy(height, width, { v, m }) };
      },
    },
  });
  const values = createRasterValuesService({
    sourceRoot: root,
    env: {},
    earthEngine: ee,
    cacheDir: path.join(root, 'raster-values'),
  });
  t.after(() => values.close());
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => (console.warn = warn));
  const answer = await values.values(query());
  assert.equal(answer.status, 200);
  const { header, values: grid } = decodeRasterValues(answer.body);
  assert.equal(header.aggregation, 'sample');
  assert.equal(grid[0], 500);
  assert.equal(calls.length, 2);
  // Not kept: asked again next time (the reduction first).
  const again = await values.values(query());
  assert.notEqual(again.cached, true);
  assert.equal(calls.length, 4);
  // The budget's 429 is the answer as it is: no sampled second try.
  refuse = 429;
  const spent = await values.values(query({ cells: '63' }));
  assert.equal(spent.status, 429);
  assert.equal(calls.length, 5);
});

test('modes: each its own expression, units and legend; the default is the first', async (t) => {
  const { service: values, calls } = service(t);
  const population = decodeRasterValues(
    (await values.values(query({ layer: 'ee-population', mode: '' }))).body,
  ).header;
  assert.equal(population.mode, 'density-2020');
  assert.equal(population.units, 'people/km²');
  assert.deepEqual([population.legendMin, population.legendMax], [1, 10_000]);
  // People per km², not their log; a field's 0 is a value, not nodata.
  const text = JSON.stringify(calls[0].expression);
  assert.doesNotMatch(text, /Image\.log10/);
  assert.doesNotMatch(text, /Image\.gte/);
  const water = decodeRasterValues(
    (
      await values.values(
        query({ layer: 'ee-surface-water', mode: 'seasonality' }),
      )
    ).body,
  ).header;
  assert.equal(water.units, 'months');
  const cover = decodeRasterValues(
    (await values.values(query({ layer: 'ee-land-cover', mode: 'v100' }))).body,
  ).header;
  assert.equal(cover.aggregation, 'mode');
  assert.equal(cover.source, 'ESA WorldCover 2020');
  assert.equal(calls.length, 3);
  assert.deepEqual(
    legendRange(record('ee-inundation'), 'duration').map(Math.round),
    [1, 316],
  );
});

test('400, 404, 413 and 503', async (t) => {
  const { service: values } = service(t);
  const status = async (extra) => (await values.values(query(extra))).status;
  assert.equal(await status({ cells: 'many' }), 400);
  assert.equal(await status({ west: '9' }), 400);
  assert.equal(await status({ cells: '600' }), 413);
  assert.equal(await status({ layer: 'no-such-layer' }), 404);
  // Lines and shading have no values.
  assert.equal(await status({ layer: 'ee-rivers' }), 404);
  assert.equal(await status({ layer: 'ee-terrain-hillshade' }), 404);
  assert.equal(await status({ layer: 'ee-elevation', mode: 'loud' }), 404);
  assert.equal(
    await status({ layer: 'ee-census-tracts', mode: 'tracts' }),
    404,
  );
  // Not built: the self-hosted sources say what to run.
  const census = await values.values(
    query({ layer: 'ee-census-tracts', mode: 'income' }),
  );
  assert.equal(census.status, 503);
  assert.match(census.error, /census:build/);
  const wiki = await values.values(query({ layer: 'wikipedia-coverage' }));
  assert.equal(wiki.status, 503);
  assert.match(wiki.error, /wikipedia:build/);
});

test('503 when Earth Engine is not set up; 429 past the day’s budget', async (t) => {
  const root = tempRoot(t);
  const values = createRasterValuesService({
    sourceRoot: root,
    env: {},
    earthEngine: createEarthEngineService({ sourceRoot: root, env: {} }),
    cacheDir: path.join(root, 'raster-values'),
  });
  const answer = await values.values(query());
  assert.equal(answer.status, 503);
  assert.match(answer.error, /EARTH_ENGINE/);

  const calls = [];
  const spent = createEarthEngineService({
    sourceRoot: root,
    env: { EARTH_ENGINE_DAILY_TILES: '1' },
    backend: {
      async computePixels(expression, grid) {
        calls.push(grid);
        const { width, height } = grid.dimensions;
        const ones = new Float32Array(width * height).fill(1);
        return { status: 200, body: npy(height, width, { v: ones, m: ones }) };
      },
    },
  });
  const capped = createRasterValuesService({
    sourceRoot: root,
    env: {},
    earthEngine: spent,
    cacheDir: path.join(root, 'capped'),
  });
  assert.equal((await capped.values(query())).status, 200);
  const over = await capped.values(query({ cells: '32' }));
  assert.equal(over.status, 429);
  assert.equal(calls.length, 1);
});

test('Wikipedia coverage from a tiny grid: articles per km², and their count summed', async (t) => {
  const root = tempRoot(t);
  const gridFile = path.join(root, 'wikipedia', 'grid.bin');
  fs.mkdirSync(path.dirname(gridFile), { recursive: true });
  const accumulator = createAccumulator();
  // Ten articles in the 0.05° cell at (0.025, 0.025), two in its neighbour east.
  for (let i = 0; i < 10; i++) accumulator.add(0.025, 0.025);
  accumulator.add(0.025, 0.075);
  accumulator.add(0.025, 0.075);
  const levels = buildPyramid({ counts: accumulator.counts });
  writeGrid(gridFile, {
    header: {
      builtAt: '2026-10-17T12:00:00.000Z',
      text: { included: false },
      domains: variantDomains(levels[0]),
    },
    levels,
  });
  const made = createRasterValuesService({
    sourceRoot: root,
    env: {},
    earthEngine: { computePixels: async () => ({ status: 503 }) },
    dirs: {
      overtureDir: path.join(root, 'overture'),
      censusDir: path.join(root, 'census'),
      gridFile,
    },
    cacheDir: path.join(root, 'raster-values'),
  });
  // Two columns of 0.05°, one row: exactly the two cells.
  const box = { west: '0', south: '0', east: '0.1', north: '0.05' };
  const articles = decodeRasterValues(
    (
      await made.values({
        layer: 'wikipedia-coverage',
        mode: '',
        cells: '2',
        ...box,
      })
    ).body,
  );
  assert.equal(articles.header.mode, 'articles');
  assert.equal(articles.header.units, 'articles/km²');
  assert.equal(articles.header.cols, 2);
  assert.equal(articles.header.rows, 1);
  // A 0.05° cell on the equator is 30.9 km².
  assert.ok(
    Math.abs(articles.values[0] - 10 / 30.91) < 0.01,
    String(articles.values[0]),
  );
  assert.ok(Math.abs(articles.values[1] - 2 / 30.91) < 0.01);
  assert.equal(articles.header.source, 'English Wikipedia (Wikimedia GeoData)');
  assert.equal(articles.header.version, '20261017T120000000Z');
  const count = decodeRasterValues(
    (
      await made.values({
        layer: 'wikipedia-coverage',
        mode: 'count',
        cells: '1',
        ...box,
      })
    ).body,
  );
  // One cell over both (0.1° × 0.05°, so level 0): the twelve articles, summed.
  assert.equal(count.header.aggregation, 'sum');
  assert.equal(count.header.cols, 1);
  assert.equal(count.values[0], 12);
  // Text was not built.
  assert.equal(
    (
      await made.values({
        layer: 'wikipedia-coverage',
        mode: 'text',
        cells: '2',
        ...box,
      })
    ).status,
    503,
  );
});

test('census tracts: each cell takes the tract under its centre, holes and gaps NaN', async (t) => {
  const root = tempRoot(t);
  const buildDir = path.join(root, 'census', 'build');
  const square = (w, s, e, n) => Float64Array.from([w, s, e, s, e, n, w, n]);
  writeTracts(buildDir, [
    { geoid: 'A', rings: [square(0, 0, 1, 1)] },
    // A tract with a hole (the hole wound the other way, as a shapefile has it).
    {
      geoid: 'B',
      rings: [
        square(2, 0, 4, 2),
        Float64Array.from([2.5, 0.5, 2.5, 1.5, 3.5, 1.5, 3.5, 0.5]),
      ],
    },
  ]);
  fs.writeFileSync(
    path.join(buildDir, 'values.json'),
    JSON.stringify({ version: 1, income: { A: 50_000, B: 90_000 } }),
  );
  fs.writeFileSync(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify({
      buildId: 'b-test',
      boundaries: { count: 2 },
      values: { income: { year: 2024, known: 2, tracts: 2 }, lst: null },
    }),
  );
  const made = createRasterValuesService({
    sourceRoot: root,
    env: {},
    earthEngine: { computePixels: async () => ({ status: 503 }) },
    dirs: {
      overtureDir: path.join(root, 'overture'),
      censusDir: path.join(root, 'census'),
      gridFile: path.join(root, 'wikipedia', 'grid.bin'),
    },
    cacheDir: path.join(root, 'raster-values'),
  });
  t.after(() => made.close());
  const answer = await made.values({
    layer: 'ee-census-tracts',
    mode: 'income',
    west: '0',
    south: '0',
    east: '4',
    north: '2',
    cells: '8',
  });
  assert.equal(answer.status, 200);
  const { header, values } = decodeRasterValues(answer.body);
  // 8 × 4 cells of 0.5°, north row first.
  assert.deepEqual([header.cols, header.rows], [8, 4]);
  assert.equal(header.units, 'USD');
  assert.equal(header.aggregation, 'sample');
  const A = 50_000;
  const B = 90_000;
  const _ = NaN;
  assert.deepEqual(
    [...values].map(String),
    [
      [_, _, _, _, B, B, B, B],
      [_, _, _, _, B, _, _, B],
      [A, A, _, _, B, _, _, B],
      [A, A, _, _, B, B, B, B],
    ]
      .flat()
      .map(String),
  );
  // LST was not computed: 503 saying how.
  const lst = await made.values({
    layer: 'ee-census-tracts',
    mode: 'lst',
    west: '0',
    south: '0',
    east: '4',
    north: '2',
    cells: '8',
  });
  assert.equal(lst.status, 503);
});

test('the NPY reader takes mixed fields and a v2 header', () => {
  const header =
    "{'descr': [('a', '<i2'), ('b', '|u1'), ('c', '>f4')], 'fortran_order': False, 'shape': (1, 2), }\n";
  const head = Buffer.alloc(12);
  head[0] = 0x93;
  head.write('NUMPY', 1, 'latin1');
  head[6] = 2;
  head.writeUInt32LE(header.length, 8);
  const body = Buffer.alloc(14);
  body.writeInt16LE(-5, 0);
  body[2] = 200;
  body.writeFloatBE(1.5, 3);
  body.writeInt16LE(7, 7);
  body[9] = 1;
  body.writeFloatBE(-2, 10);
  const { rows, cols, bands } = readNpy(
    Buffer.concat([head, Buffer.from(header, 'latin1'), body]),
  );
  assert.deepEqual([rows, cols], [1, 2]);
  assert.deepEqual([...bands.a], [-5, 7]);
  assert.deepEqual([...bands.b], [200, 1]);
  assert.deepEqual([...bands.c], [1.5, -2]);
  assert.throws(() => readNpy(Buffer.from('not npy at all')), /Not NPY/);
});

test('valuesExpression keeps the layer’s nodes and adds the value and mask bands', () => {
  const base = { values: { 0: { constantValue: 1 } }, result: '0' };
  const wrapped = valuesExpression(base);
  assert.equal(wrapped.result, 'rv');
  assert.equal(wrapped.values[0], base.values[0]);
  const text = JSON.stringify(wrapped.values.rv);
  assert.match(text, /"Image\.addBands"/);
  assert.match(text, /\["v"\]/);
  assert.match(text, /\["m"\]/);
  assert.match(text, /"sameFootprint":\{"constantValue":false\}/);
});

test('the route: octet-stream, JSON errors, same-site, GET only', async (t) => {
  const { service: values } = service(t);
  const handler = createRasterValuesHandler({ service: values });
  const call = async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4173', ...headers },
        socket: {},
      },
      res,
    );
    return res;
  };
  const ok = await call(`/?${new URLSearchParams(query())}`);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(decodeRasterValues(ok.body).header.layer, 'ee-elevation');
  assert.equal(Number(ok.headers['content-length']), ok.body.length);
  const bad = await call(`/?${new URLSearchParams(query({ cells: '0' }))}`);
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /cells/);
  assert.equal((await call('/', { method: 'POST' })).statusCode, 405);
  const foreign = await call(`/?${new URLSearchParams(query())}`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(foreign.statusCode, 403);
});
