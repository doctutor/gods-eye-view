// Personal fork: Inundation history (Earth Engine) and the Census tracts
// layer's Earth Engine outlines and locally drawn income (server/providers/
// census.js, scripts/census/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EARTH_ENGINE_LAYERS,
  FLOOD_MODES,
  TRACT_MAX_HEIGHT_M,
  layerModes,
  layerVariants,
  modeRecord,
} from './earthEngineLayers.js';
import { mapRequestFor } from '../../server/providers/earthEngine.js';
import {
  INCOME_CLASSES,
  NO_ESTIMATE_COLOR,
  incomeColor,
} from './censusTracts.js';
import {
  openTracts,
  writeTracts,
} from '../../server/providers/census/tractsFile.js';
import {
  fillPolygon,
  renderChoropleth,
  tileBounds,
  TILE_SIZE,
} from '../../server/providers/census/render.js';
import {
  CENSUS_MIN_ZOOM,
  createCensusHandler,
  createCensusService,
} from '../../server/providers/census.js';
import {
  NEEDS_BUILD,
  NEEDS_KEY,
} from '../../server/providers/census/sources.js';
import { readDbf, readPolygons } from '../../scripts/census/shapefile.mjs';
import { fetchIncome } from '../../scripts/census/index.mjs';

const byId = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const fnOf = (node) => node.functionInvocationValue;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-census-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Inundation history: each mode sums its band over the 913 events, less permanent water, drawn from orbit', () => {
  const flood = byId('ee-inundation');
  assert.deepEqual(layerModes(flood), ['count', 'duration']);
  assert.equal(flood.modeStorageKey, 'gev.inundation.mode');
  assert.equal(flood.maxHeightM, undefined, 'it draws from orbit');
  assert.equal(flood.maxZoom, 10);
  assert.match(flood.attribution, /CC BY-NC 4\.0/);
  for (const [mode, band] of [
    ['count', 'flooded'],
    ['duration', 'duration'],
  ]) {
    const request = mapRequestFor(
      flood,
      layerVariants(flood)[0],
      'default',
      mode,
    );
    const text = JSON.stringify(request);
    assert.match(text, /GLOBAL_FLOOD_DB\/MODIS_EVENTS\/V1/);
    assert.match(text, /"Reducer\.sum"/);
    assert.match(text, new RegExp(`"${band}_sum"`));
    assert.match(text, /"jrc_perm_water"/);
    // sum × (1 − permanent water), not a mask: a coarse pixel touching a
    // lake keeps its land share.
    assert.match(text, /"Image\.subtract"/);
    assert.doesNotMatch(text, /"Image\.selfMask"/);
    assert.deepEqual(request.visualizationOptions.ranges, [
      {
        min: modeRecord(flood, mode).vis.min,
        max: modeRecord(flood, mode).vis.max,
      },
    ]);
  }
  // Counts under a tenth are not drawn; durations are drawn on a log scale.
  const count = fnOf(
    mapRequestFor(flood, layerVariants(flood)[0], 'default', 'count').expression
      .values['0'],
  );
  assert.equal(count.functionName, 'Image.updateMask');
  assert.equal(
    fnOf(count.arguments.mask).arguments.image2.functionInvocationValue
      .arguments.value.constantValue,
    0.1,
  );
  const duration = fnOf(
    mapRequestFor(flood, layerVariants(flood)[0], 'default', 'duration')
      .expression.values['0'],
  );
  assert.equal(duration.functionName, 'Image.log10');
  assert.equal(FLOOD_MODES[1].vis.max, 2.5, '300+ days');
});

test('Census tracts: TIGER 2020 outlines in the ink from z 7, below about 417 km; income is drawn locally', () => {
  const tracts = byId('ee-census-tracts');
  assert.deepEqual(
    layerModes(tracts),
    ['tracts'],
    'no Earth Engine map for income',
  );
  assert.deepEqual(
    tracts.modes.map((mode) => [mode.key, mode.local || null]),
    [
      ['tracts', null],
      ['income', 'census'],
    ],
  );
  assert.equal(tracts.maxHeightM, TRACT_MAX_HEIGHT_M);
  assert.equal(
    TRACT_MAX_HEIGHT_M,
    417_188,
    'z 9 at the middle of a 1,600 px view',
  );
  assert.equal(layerVariants(tracts)[0].minZoom, 7);
  for (const [ink, color] of [
    ['light', 'ffffffaa'],
    ['dark', '1a1a1aaa'],
  ]) {
    const request = mapRequestFor(
      tracts,
      layerVariants(tracts)[0],
      ink,
      'tracts',
    );
    const style = fnOf(request.expression.values['0']);
    assert.equal(style.functionName, 'Collection.style');
    assert.equal(style.arguments.color.constantValue, color);
    assert.equal(
      fnOf(style.arguments.collection).arguments.tableId.constantValue,
      'TIGER/2020/TRACT',
    );
    assert.equal(request.visualizationOptions, undefined);
  }
});

test('income classes: the YlGnBu ramp at 78%, the no-estimate grey', () => {
  assert.equal(incomeColor(12_000), 'ffffccc8');
  assert.equal(incomeColor(30_000), 'c7e9b4c8');
  assert.equal(incomeColor(250_001), '0c2c84c8');
  assert.equal(incomeColor(NaN), NO_ESTIMATE_COLOR);
  assert.equal(INCOME_CLASSES.length, 7);
});

/** A one-polygon shapefile and its .dbf, as the Census Bureau writes them. */
function shapefileOf(rings, geoid) {
  const points = rings.flat();
  const recordBytes = 44 + rings.length * 4 + points.length * 8;
  const shp = Buffer.alloc(100 + 8 + recordBytes);
  shp.writeInt32BE(9994, 0);
  shp.writeInt32BE(shp.length / 2, 24);
  shp.writeInt32LE(5, 32);
  shp.writeInt32BE(1, 100);
  shp.writeInt32BE(recordBytes / 2, 104);
  let at = 108;
  shp.writeInt32LE(5, at);
  shp.writeInt32LE(rings.length, at + 36);
  shp.writeInt32LE(points.length / 2, at + 40);
  let first = 0;
  rings.forEach((ring, i) => {
    shp.writeInt32LE(first, at + 44 + i * 4);
    first += ring.length / 2;
  });
  points.forEach((value, i) =>
    shp.writeDoubleLE(value, at + 44 + rings.length * 4 + i * 8),
  );
  const dbf = Buffer.alloc(32 + 32 + 1 + 1 + 11);
  dbf.writeUInt32LE(1, 4);
  dbf.writeUInt16LE(65, 8);
  dbf.writeUInt16LE(12, 10);
  dbf.write('GEOID', 32, 'latin1');
  dbf[32 + 11] = 0x43;
  dbf[32 + 16] = 11;
  dbf[64] = 0x0d;
  dbf.write(` ${geoid}`, 65, 'latin1');
  return { shp, dbf };
}

// A tract around (−74.0, 40.75), 0.02° square, with a 0.004° hole.
const SQUARE = [
  -74.01, 40.74, -74.01, 40.76, -73.99, 40.76, -73.99, 40.74, -74.01, 40.74,
];
const HOLE = [
  -74.002, 40.748, -73.998, 40.748, -73.998, 40.752, -74.002, 40.752, -74.002,
  40.748,
];
const GEOID = '36061000100';

test('the build reads the cartographic boundaries and writes tract files the server indexes', (t) => {
  const { shp, dbf } = shapefileOf([SQUARE, HOLE], GEOID);
  const shapes = readPolygons(shp);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].rings.length, 2);
  assert.deepEqual(readDbf(dbf, ['GEOID']), [{ GEOID }]);
  const dir = tempDir(t);
  const counts = writeTracts(dir, [{ geoid: GEOID, rings: shapes[0].rings }]);
  assert.deepEqual(counts, { count: 1, rings: 2, points: 10 });
  const open = openTracts(dir);
  assert.deepEqual(open.geoids, [GEOID]);
  assert.deepEqual(
    open.tractsIn({ west: -74.1, south: 40.7, east: -73.9, north: 40.8 }),
    [0],
  );
  assert.deepEqual(
    open.tractsIn({ west: -100, south: 30, east: -99, north: 31 }),
    [],
  );
  assert.equal(open.ringsOf(0)[0][0], -74_010_000);
});

test('the income step asks the ACS per state with the key, and keeps no-estimate codes as none', async () => {
  const asked = [];
  const values = await fetchIncome(['36'], 'test-key', {
    pace: 0,
    fetchImpl: async (url) => {
      asked.push(new URL(url));
      return Response.json([
        ['B19013_001E', 'state', 'county', 'tract'],
        ['87500', '36', '061', '000100'],
        ['-666666666', '36', '061', '000201'],
      ]);
    },
  });
  assert.deepEqual(values, { 36061000100: 87500, 36061000201: null });
  assert.equal(asked[0].searchParams.get('get'), 'B19013_001E');
  assert.equal(asked[0].searchParams.get('in'), 'state:36');
  assert.equal(asked[0].searchParams.get('key'), 'test-key');
  assert.match(asked[0].pathname, /^\/data\/2024\/acs\/acs5$/);
  // A refused key redirects to the Census API's key page.
  await assert.rejects(
    fetchIncome(['36'], 'bad', {
      pace: 0,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'missing_key.html' },
        }),
    }),
    /refused the key/,
  );
});

test('a polygon fills its area, its hole left out, edges antialiased', () => {
  const cover = new Float32Array(TILE_SIZE * TILE_SIZE);
  const square = [10, 10, 110, 10, 110, 110, 10, 110];
  const hole = [40, 40, 80, 40, 80, 80, 40, 80];
  assert.equal(fillPolygon([square, hole], cover), true);
  const area = cover.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(area - (100 * 100 - 40 * 40)) < 1, `area ${area}`);
  assert.equal(cover[60 * TILE_SIZE + 60], 0, 'the hole');
  assert.equal(cover[20 * TILE_SIZE + 20], 1);
  const half = new Float32Array(TILE_SIZE * TILE_SIZE);
  fillPolygon([[0.5, 0, 10, 0, 10, 10, 0.5, 10]], half);
  assert.ok(Math.abs(half[5 * TILE_SIZE] - 0.5) < 1e-6, 'a half-covered pixel');
  assert.equal(renderChoropleth([]).empty, true);
});

async function built(t, { income } = {}) {
  const dir = tempDir(t);
  const buildDir = path.join(dir, 'build');
  writeTracts(buildDir, [{ geoid: GEOID, rings: [Float64Array.from(SQUARE)] }]);
  fs.writeFileSync(
    path.join(buildDir, 'values.json'),
    JSON.stringify({ version: 1, ...(income ? { income } : {}) }),
  );
  fs.writeFileSync(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify({
      builtAt: '2026-10-19T00:00:00Z',
      buildId: income ? 'b-income' : 'b-tracts',
      boundaries: { year: 2024, count: 1 },
      values: { income: income ? { year: 2024, known: 1, tracts: 1 } : null },
    }),
  );
  return dir;
}

test('the census server says what each mode lacks, then draws income tiles and keeps them', async (t) => {
  const none = createCensusService({ dir: tempDir(t), env: {} });
  const empty = await none.layers();
  assert.equal(empty.configured, false);
  assert.equal(empty.modes.income.ready, false);
  assert.equal(empty.modes.income.message, NEEDS_BUILD);
  assert.equal((await none.tile('income', 9, 150, 192)).status, 503);
  // Tracts but no incomes: the key is what is missing.
  const keyless = createCensusService({ dir: await built(t), env: {} });
  const noKey = await keyless.layers();
  assert.equal(noKey.configured, true);
  assert.equal(noKey.modes.income.message, NEEDS_KEY);
  // With the incomes: tiles.
  const dir = await built(t, { income: { [GEOID]: 87_500 } });
  const service = createCensusService({ dir, env: {} });
  const status = await service.layers();
  assert.equal(status.modes.income.ready, true);
  assert.match(status.modes.income.version, /^[0-9a-f]{12}$/);
  const n = 2 ** 12;
  const x = Math.floor(((-74.0 + 180) / 360) * n);
  const lat = (40.75 * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  );
  const tile = await service.tile('income', 12, x, y);
  assert.equal(tile.status, 200);
  assert.ok(!tile.empty, 'the tract is drawn');
  assert.equal(tile.version, status.modes.income.version);
  assert.ok(
    fs.existsSync(
      path.join(
        dir,
        'tiles',
        'income',
        tile.version,
        '12',
        String(x),
        `${y}.png`,
      ),
    ),
  );
  assert.equal((await service.tile('income', 12, x, y)).cached, true);
  assert.equal(
    (await service.tile('income', 12, 0, 0)).empty,
    true,
    'far from it',
  );
  assert.equal(
    (await service.tile('income', CENSUS_MIN_ZOOM - 1, 0, 0)).empty,
    true,
    'coarser than z 7',
  );
  assert.equal(
    (await service.tile('lst', 12, x, y)).status,
    404,
    'not yet a mode',
  );
  const bounds = tileBounds(12, x, y);
  assert.ok(bounds.west < -74.0 && bounds.east > -74.0);
  // The route.
  const handle = createCensusHandler({ service });
  const call = (url) =>
    new Promise((resolve) => {
      const res = {
        headers: {},
        statusCode: 0,
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(body) {
          resolve({ status: this.statusCode, headers: this.headers, body });
        },
      };
      handle(
        { method: 'GET', url, headers: { host: 'localhost:4176' }, socket: {} },
        res,
        () => resolve({ nexted: true }),
      );
    });
  const routed = await call(`/tile/income/12/${x}/${y}?v=${tile.version}`);
  assert.equal(routed.status, 200);
  assert.equal(routed.headers['cache-control'], 'private, max-age=86400');
  assert.equal(
    (await call(`/tile/income/12/${x}/${y}?v=000000000000`)).headers[
      'cache-control'
    ],
    'no-store',
  );
  assert.equal((await call('/tile/../etc/1/1/1')).nexted, true);
});
