// Personal fork: the raster values service (server/providers/rasterValues.js):
// Earth Engine through a mocked computePixels, Wikipedia coverage from a
// tiny grid, the parameters and the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EARTH_ENGINE_LAYERS } from '../../src/data/earthEngineLayers.js';
import { decodeRasterValues, windowGrid } from '../../src/data/rasterValues.js';
import {
  latticeBox,
  latticeCells,
  latticeIndex,
} from '../../src/layers/blocks/lattice.js';
import { BLOCK_PYRAMID_M } from '../../src/layers/blocks/pyramid.js';
import {
  VALUES_RETRY_AFTER_S,
  createEarthEngineService,
  createRestBackend,
} from './earthEngine.js';
import {
  COARSE_VALUES_FROM_M,
  COARSE_VALUES_TTL_MS,
  VALUES_TTL_MS,
  createRasterValuesHandler,
  createRasterValuesService,
  valuesTtlMs,
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

test("a reduced cell's mean declares the read band's own cell, not the stack's finest: 120 m over 3DEP reads FABDEM at 30 m, not 7.5 m", async (t) => {
  const { service: values, calls } = service(t);
  // 120 m cells over Ohio (3DEP 1 m is the stack's finest there): the
  // base band, FABDEM 30 m.
  const answer = await values.values(
    query({
      west: '-82.94',
      south: '40.06',
      east: '-82.86',
      north: '40.12',
      cells: '64',
    }),
  );
  const { header } = decodeRasterValues(answer.body);
  assert.equal(header.band, 'base');
  assert.equal(header.aggregation, 'mean');
  const reduced = callsOf(calls[0].expression, 'Image.reduceResolution');
  assert.equal(reduced.length, 2); // the heights and the share with heights
  for (const { image } of reduced)
    assert.equal(
      image.functionInvocationValue.arguments.scale.constantValue,
      30,
    );
});

/** Every node of an expression graph calling `name`. */
function callsOf(node, name, out = []) {
  if (Array.isArray(node)) for (const item of node) callsOf(item, name, out);
  else if (node && typeof node === 'object') {
    if (node.functionInvocationValue?.functionName === name)
      out.push(node.functionInvocationValue.arguments);
    for (const value of Object.values(node)) callsOf(value, name, out);
  }
  return out;
}

test("a fill value never reaches a mean: each source's pixels outside −500…9,000 m masked before it is resampled", async (t) => {
  const { service: values, calls } = service(t);
  await values.values(query());
  const { expression } = calls[0];
  const resampled = callsOf(expression, 'Image.resample');
  assert.ok(resampled.length >= 2, 'every source of the far or base band');
  for (const { image } of resampled) {
    // resample(updateMask(updateMask(raw, raw ≥ −500), raw ≤ 9000))
    const outer = image.functionInvocationValue;
    assert.equal(outer.functionName, 'Image.updateMask');
    const high = outer.arguments.mask.functionInvocationValue;
    assert.equal(high.functionName, 'Image.lte');
    assert.match(JSON.stringify(high.arguments.image2), /"constantValue":9000/);
    const inner = outer.arguments.image.functionInvocationValue;
    assert.equal(inner.functionName, 'Image.updateMask');
    const low = inner.arguments.mask.functionInvocationValue;
    assert.equal(low.functionName, 'Image.gte');
    assert.match(JSON.stringify(low.arguments.image2), /"constantValue":-500/);
  }
  // The mean comes after: reduceResolution over the masked mosaic.
  // The heights and the share of pixels with heights (the sea's rule).
  assert.equal(callsOf(expression, 'Image.reduceResolution').length, 2);
});

test('the sea in a reduced cell: under half its pixels with heights, or a mean ≤ 0 m, is water at 0 m, never nodata', async (t) => {
  const { service: values, calls } = service(t);
  await values.values(query());
  const { expression } = calls[0];
  const { mn } = expression.values;
  const where = mn.functionInvocationValue;
  assert.equal(where.functionName, 'Image.where');
  // The value replaced is 0 m, and the mean is unmasked to 0 first, so a
  // cell is never masked (nodata).
  assert.match(JSON.stringify(where.arguments.value), /"constantValue":0\}/);
  assert.equal(
    where.arguments.input.functionInvocationValue.functionName,
    'Image.unmask',
  );
  const test = JSON.stringify(where.arguments.test);
  // Water: the share of pixels with heights under 0.5 …
  assert.match(test, /"Image\.mask"/);
  assert.match(test, /"Image\.lt".*"constantValue":0\.5/s);
  // … or the mean at or below 0 m (a masked mean counts as water).
  assert.match(test, /"Image\.lte".*"valueReference":"mh"/s);
  // The cached answers of the NaN sea are another version.
  const first = decodeRasterValues((await values.values(query())).body).header;
  assert.ok(first.version);
});

test("the sea in a sampled cell: Elevation's masked pixels are 0 m (water at level 0), never nodata; other layers' stay nodata", async (t) => {
  const { service: values, calls } = service(t);
  // A 1 m window over 3DEP: sampled, not reduced.
  await values.values(
    query({
      west: '-76.6125',
      south: '39.29',
      east: '-76.61',
      north: '39.2918',
      cells: '512',
    }),
  );
  const { expression } = calls[0];
  assert.doesNotMatch(JSON.stringify(expression), /reduceResolution/);
  const unmasked = expression.values.sz.functionInvocationValue;
  assert.equal(unmasked.functionName, 'Image.unmask');
  assert.match(JSON.stringify(unmasked.arguments.value), /"constantValue":0\}/);
  assert.equal(unmasked.arguments.sameFootprint.constantValue, false);
  // The value and mask bands read the unmasked heights: no nodata left.
  assert.match(JSON.stringify(expression.values.rv), /"valueReference":"sz"/);
  // Slope keeps its nodata.
  await values.values(query({ layer: 'ee-terrain-slope' }));
  assert.equal(calls[1].expression.values.sz, undefined);
});

test('the water plane (?water=1): MOD44W land 0, water 1, its mean over a reduced cell, in the same request; another version and key; Elevation only', async (t) => {
  const root = tempRoot(t);
  const calls = [];
  const ee = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: EARTH_ENGINE_LAYERS,
    backend: {
      async computePixels(expression, grid) {
        calls.push(expression);
        const { width, height } = grid.dimensions;
        const n = width * height;
        const v = new Float32Array(n).map((_, i) => 100 + i);
        const m = new Float32Array(n).fill(1);
        const fields = { v, m };
        // A band w only when the expression asks for it.
        if (expression.result === 'rw')
          fields.w = new Float32Array(n).map((_, i) => (i % 4) / 4);
        return { status: 200, body: npy(height, width, fields) };
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
  const plain = decodeRasterValues((await values.values(query())).body);
  assert.equal(plain.header.planes, undefined);
  assert.equal(plain.water, undefined);
  const wet = decodeRasterValues(
    (await values.values(query({ water: '1' }))).body,
  );
  assert.equal(calls.length, 2, 'one Earth Engine request each');
  assert.deepEqual(wet.header.planes, ['value', 'water']);
  assert.deepEqual([...wet.values], [...plain.values]);
  assert.deepEqual([...wet.water.slice(0, 4)], [0, 0.25, 0.5, 0.75]);
  // Another version: the plain answers' cache is untouched.
  assert.notEqual(wet.header.version, plain.header.version);
  const text = JSON.stringify(calls[1]);
  // MODIS MOD44W's land-water mask, valid over land (0) and water (1),
  // averaged as it is: no threshold of a band masked over dry land, whose
  // coarse pyramid would be the mean of its water pixels alone (JRC's
  // occurrence made half the US interior water at 30 km cells).
  assert.match(text, /"MODIS\/006\/MOD44W\/2015_01_01"/);
  assert.match(text, /"bandSelectors":\{"constantValue":\["water_mask"\]\}/);
  assert.doesNotMatch(text, /occurrence|GSW1_4/);
  const addBands = calls[1].values.rw.functionInvocationValue.arguments;
  assert.equal(addBands.dstImg.valueReference, 'rv');
  const [reduce] = callsOf(addBands.srcImg, 'Image.reduceResolution');
  assert.equal(
    reduce.reducer.functionInvocationValue.functionName,
    'Reducer.mean',
  );
  // 4 × 4 samples a cell: the heights' 256 made a fresh tile 2.5 × slower.
  assert.equal(reduce.maxPixels.constantValue, 16);
  assert.equal(reduce.bestEffort.constantValue, true);
  const averaged =
    reduce.image.functionInvocationValue.arguments.image
      .functionInvocationValue;
  // What is averaged: unmask(toFloat(select(load(MOD44W), water_mask)), 0).
  assert.equal(averaged.functionName, 'Image.unmask');
  assert.match(JSON.stringify(averaged.arguments.value), /"constantValue":0\}/);
  const float = averaged.arguments.input.functionInvocationValue;
  assert.equal(float.functionName, 'Image.toFloat');
  const band = float.arguments.value.functionInvocationValue;
  assert.equal(band.functionName, 'Image.select');
  assert.equal(
    band.arguments.input.functionInvocationValue.functionName,
    'Image.load',
  );
  assert.equal(callsOf(addBands.srcImg, 'Image.gte').length, 0);
  assert.equal(callsOf(addBands.srcImg, 'Image.mask').length, 0);
  assert.match(
    JSON.stringify(addBands.srcImg),
    /"names":\{"constantValue":\["w"\]\}/,
  );
  // Kept: the second ask is the disk's, the plain one too.
  assert.equal((await values.values(query({ water: '1' }))).cached, true);
  assert.equal((await values.values(query())).cached, true);
  assert.equal(calls.length, 2);
  // A sampled window: the pixel's 0 or 1, no reduction.
  await values.values(
    query({
      west: '-76.6125',
      south: '39.29',
      east: '-76.61',
      north: '39.2918',
      cells: '512',
      water: '1',
    }),
  );
  assert.doesNotMatch(JSON.stringify(calls[2]), /reduceResolution/);
  assert.match(JSON.stringify(calls[2]), /MOD44W/);
  // Only Elevation has the plane; water must be 1 or absent.
  const other = await values.values(
    query({ layer: 'ee-terrain-slope', water: '1' }),
  );
  assert.equal(other.status, 404);
  assert.equal((await values.values(query({ water: 'yes' }))).status, 400);
});

test('the values experiments: inert without GEV_VALUES_EXPERIMENTS; with it, maxPixels and scale change the mean, the answer is never read from or kept in the cache, bad values 400', async (t) => {
  // Kansas, 3.5 km cells: reduced, from the far band (GMTED), where 3DEP
  // 1 m is the stack's finest cell.
  const kansas = {
    west: '-100',
    south: '38',
    east: '-98',
    north: '40',
    cells: '64',
  };
  const binsUnder = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { recursive: true })
          .filter((name) => String(name).endsWith('.bin'))
      : [];
  // Without the flag: ignored, today's mean, kept.
  const off = service(t);
  const plain = await off.service.values(
    query({ ...kansas, maxPixels: '16', scale: 'stack' }),
  );
  assert.equal(plain.status, 200);
  assert.equal(decodeRasterValues(plain.body).header.experiment, undefined);
  // Today's mean: 256 pixels a cell, at the read band's own cell (the far
  // band's GMTED, about 231 m), never 3DEP's 1 m, the stack's finest.
  const today = callsOf(off.calls[0].expression, 'Image.reduceResolution');
  assert.ok(today.length >= 1);
  for (const { maxPixels, image } of today) {
    assert.equal(maxPixels.constantValue, 256);
    assert.ok(
      image.functionInvocationValue.arguments.scale.constantValue > 200,
    );
  }
  // A bad value is not even read without the flag.
  const ignored = await off.service.values(
    query({ ...kansas, maxPixels: '7' }),
  );
  assert.equal(ignored.cached, true);
  assert.equal(off.calls.length, 1);
  // With the flag.
  const on = service(t, { env: { GEV_VALUES_EXPERIMENTS: '1' } });
  const cacheDir = path.join(on.root, 'raster-values');
  const asked = query({ ...kansas, maxPixels: '16', scale: 'band' });
  const first = await on.service.values(asked);
  assert.equal(first.status, 200);
  assert.equal(first.cached, undefined);
  const { header } = decodeRasterValues(first.body);
  assert.equal(header.experiment.maxPixels, 16);
  assert.equal(header.experiment.scale, 'band');
  // The far band's own cell (GMTED, about 230 m), not 3DEP's 1 m.
  assert.ok(header.experiment.meanScaleM > 200, header.experiment.meanScaleM);
  for (const { maxPixels, image } of callsOf(
    on.calls[0].expression,
    'Image.reduceResolution',
  )) {
    assert.equal(maxPixels.constantValue, 16);
    assert.equal(
      image.functionInvocationValue.arguments.scale.constantValue,
      header.experiment.meanScaleM,
    );
  }
  // Never kept, never read: nothing on disk, asked again it is computed again.
  assert.deepEqual(binsUnder(cacheDir), []);
  const again = await on.service.values(asked);
  assert.equal(again.cached, undefined);
  assert.equal(on.calls.length, 2);
  // Today's request with the flag set is still kept as before.
  await on.service.values(query(kansas));
  assert.equal(binsUnder(cacheDir).length, 1);
  assert.equal((await on.service.values(query(kansas))).cached, true);
  // maxPixels alone keeps the band's scale; scale=stack is the old reading.
  await on.service.values(query({ ...kansas, maxPixels: '64' }));
  const [only] = callsOf(on.calls.at(-1).expression, 'Image.reduceResolution');
  assert.equal(only.maxPixels.constantValue, 64);
  assert.ok(
    only.image.functionInvocationValue.arguments.scale.constantValue > 200,
  );
  await on.service.values(query({ ...kansas, scale: 'stack' }));
  const [stack] = callsOf(on.calls.at(-1).expression, 'Image.reduceResolution');
  assert.equal(stack.maxPixels.constantValue, 256);
  assert.equal(
    stack.image.functionInvocationValue.arguments.scale.constantValue,
    1,
  );
  // Bad values, and other layers, are 400s.
  const status = async (extra) =>
    (await on.service.values(query({ ...kansas, ...extra }))).status;
  assert.equal(await status({ maxPixels: '100' }), 400);
  assert.equal(await status({ scale: 'fine' }), 400);
  assert.equal(
    await status({ layer: 'ee-terrain-slope', maxPixels: '16' }),
    400,
  );
});

test('a water plane Earth Engine refuses: the heights alone, no plane, not kept; a 429 is not retried', async (t) => {
  const root = tempRoot(t);
  const calls = [];
  let budget = false;
  const ee = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: EARTH_ENGINE_LAYERS,
    backend: {
      async computePixels(expression, grid) {
        calls.push(expression);
        if (budget) return { status: 429, error: 'budget' };
        if (expression.result === 'rw')
          return { status: 400, error: 'Image.load: asset not found' };
        const { width, height } = grid.dimensions;
        const n = width * height;
        const v = new Float32Array(n).fill(200);
        const m = new Float32Array(n).fill(1);
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
  const first = await values.values(query({ water: '1' }));
  assert.equal(first.status, 200);
  const decoded = decodeRasterValues(first.body);
  assert.equal(decoded.water, undefined);
  assert.equal(decoded.values[0], 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].result, 'rv');
  // Not kept: asked again next time.
  const again = await values.values(query({ water: '1' }));
  assert.equal(again.cached, undefined);
  assert.equal(calls.length, 4);
  // The day's budget is not a refusal: no second request.
  budget = true;
  const spent = await values.values(query({ water: '1', cells: '32' }));
  assert.equal(spent.status, 429);
  assert.equal(calls.length, 5);
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
  // Whether the answer was the disk's: a miss, then a hit.
  assert.equal(ok.headers['x-raster-values-cache'], 'miss');
  const kept = await call(`/?${new URLSearchParams(query())}`);
  assert.equal(kept.headers['x-raster-values-cache'], 'hit');
  const bad = await call(`/?${new URLSearchParams(query({ cells: '0' }))}`);
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /cells/);
  assert.equal((await call('/', { method: 'POST' })).statusCode, 405);
  const foreign = await call(`/?${new URLSearchParams(query())}`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(foreign.statusCode, 403);
});

test('Earth Engine gives no answer: one more try (each counted), then a 503 with Retry-After, never kept', async (t) => {
  const root = tempRoot(t);
  let silent = 1;
  const asked = [];
  const ee = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: EARTH_ENGINE_LAYERS,
    sleep: async (ms) => asked.push(`sleep ${ms}`),
    backend: {
      async computePixels(expression, grid) {
        asked.push('ask');
        if (silent-- > 0)
          return {
            status: 504,
            error: 'Earth Engine gave no answer (timeout)',
          };
        const { width, height } = grid.dimensions;
        const v = new Float32Array(width * height).fill(42);
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
  // Silent once: the second try answers; both counted.
  const answer = await values.values(query());
  assert.equal(answer.status, 200);
  assert.deepEqual(asked, ['ask', 'sleep 2000', 'ask']);
  assert.equal((await ee.budget()).total, 2);
  // Silent twice: a 503 that says when to ask again, and nothing kept.
  silent = 2;
  asked.length = 0;
  const later = await values.values(query({ cells: '63' }));
  assert.equal(later.status, 503);
  assert.equal(later.retryAfterS, VALUES_RETRY_AFTER_S);
  assert.match(later.error, /ask again later/);
  assert.deepEqual(asked, ['ask', 'sleep 2000', 'ask']);
  silent = 0;
  const again = await values.values(query({ cells: '63' }));
  assert.equal(again.status, 200);
  assert.notEqual(again.cached, true);
  // The route: 503 and Retry-After, JSON, not a 500.
  silent = 2;
  const handler = createRasterValuesHandler({ service: values });
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
      url: `/?${new URLSearchParams(query({ cells: '62' }))}`,
      method: 'GET',
      headers: { host: 'localhost:4173' },
      socket: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], String(VALUES_RETRY_AFTER_S));
  assert.match(JSON.parse(res.body).error, /ask again later/);
});

test('the REST backend: a values request waits its own time, and no answer is a 504, not a throw', async () => {
  const signals = [];
  const backend = createRestBackend({
    project: 'p',
    auth: { token: async () => 't', forget() {} },
    valuesTimeoutMs: 120_000,
    fetchImpl: async (url, init) => {
      signals.push(init.signal);
      throw Object.assign(
        new Error('The operation was aborted due to timeout'),
        {
          name: 'TimeoutError',
        },
      );
    },
  });
  const answer = await backend.computePixels({}, {});
  assert.equal(answer.status, 504);
  assert.match(answer.error, /no answer .*timeout/);
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});

test('a kept answer serves 30 days, a year for cells of 100 m and wider (the Blocks lattice from 120 m up)', async (t) => {
  // Against the real lattice, at the equator, Baltimore and 70° N: every
  // tile from 120 m up is kept a year, every 30 m tile 30 days.
  for (const blockM of BLOCK_PYRAMID_M.filter((m) => m >= 30))
    for (const lat of [0.5, 39.3, 70]) {
      const { ti, tj } = latticeIndex(blockM, -76.6, lat);
      const box = latticeBox(blockM, ti, tj);
      const { cellSizeM } = windowGrid(box, latticeCells(blockM));
      assert.equal(
        valuesTtlMs(cellSizeM),
        blockM >= 120 ? COARSE_VALUES_TTL_MS : VALUES_TTL_MS,
        `${blockM} m at ${lat}°: ${cellSizeM} m cells`,
      );
    }
  assert.equal(valuesTtlMs(99.9), VALUES_TTL_MS);
  assert.equal(valuesTtlMs(COARSE_VALUES_FROM_M), COARSE_VALUES_TTL_MS);
  // The service: a 700 m answer still serves after 31 days and is asked
  // again after 366; a 35 m one is asked again after 31.
  let ahead = 0;
  const { service: values, calls } = service(t, {
    now: () => Date.now() + ahead,
  });
  const DAY = 24 * 60 * 60 * 1000;
  const fine = query({
    west: '7.5',
    south: '45.8',
    east: '7.52',
    north: '45.82',
  });
  for (const ask of [query(), fine])
    assert.equal((await values.values(ask)).status, 200);
  assert.equal(calls.length, 2);
  ahead = 31 * DAY;
  assert.equal((await values.values(query())).cached, true);
  assert.notEqual((await values.values(fine)).cached, true);
  assert.equal(calls.length, 3);
  ahead = 366 * DAY;
  assert.notEqual((await values.values(query())).cached, true);
  assert.equal(calls.length, 4);
});
