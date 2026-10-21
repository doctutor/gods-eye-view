// Personal fork: /api/property and the property index's answers, on an index
// built here from a few rows by the build's own steps (scripts/property/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as h3 from 'h3-js';
import {
  compressSections,
  createSpill,
  partitionRows,
} from '../../scripts/property/parts.mjs';
import { mergePropertyBucket } from '../../scripts/property/merge.mjs';
import {
  COARSE_RESOLUTIONS,
  FINE_RESOLUTIONS,
  aggregatePartitionSpill,
  coarseRows,
  tableOf,
} from '../../scripts/property/hexes.mjs';
import { loadCounties } from './property/counties.js';
import { dayOf } from './property/file.js';
import { writeHexFile } from './property/hexFile.js';
import {
  createPropertyIndex,
  parseBuildingId,
  resolutionForCell,
} from './property/index.js';
import {
  createPropertyHandler,
  createPropertyService,
  parseBuildingsQuery,
} from './property.js';
import { createRasterValuesService } from './rasterValues.js';
import { decodeRasterValues } from '../../src/data/rasterValues.js';

const COUNTIES = loadCounties();
const OPTIONS = {
  counties: COUNTIES,
  today: dayOf('2026-10-21'),
  thisYear: 2026,
};

/** Brooklyn rows: a building of condos, sold ones among them, and a house. */
function rows() {
  const base = {
    unit: null,
    city: 'Brooklyn',
    state: 'NY',
    zip: '11201',
    county_fips: '36047',
    property_type: 'condo',
    beds: 2,
    baths: 1,
    sqft: 1000,
    lot_sqft: null,
    year_built: 1910,
    last_sold_price: null,
    last_sold_date: null,
    eventDates: [],
    events: [],
    eventPrices: [],
    taxYears: [2023, 2024],
    taxAmounts: [9000, 9500],
    taxAssessments: [100_000, 110_000],
  };
  const out = [];
  for (let i = 0; i < 6; i++)
    out.push({
      ...base,
      street: `218 Plymouth St APT ${i + 1}A`,
      lat: 40.70321,
      lng: -73.98612,
      parcel_apn: `00031100${i + 1}`,
      ...(i < 4
        ? {
            last_sold_price: 1_000_000 + i * 100_000,
            last_sold_date: `202${i}-05-01`,
          }
        : {}),
    });
  out.push({
    ...base,
    street: '52 Jay St',
    property_type: 'single_family',
    lat: 40.70299,
    lng: -73.98668,
    parcel_apn: '000300018',
    last_sold_price: 2_000_000,
    last_sold_date: '2018-12-20',
    year_built: 1899,
  });
  return out;
}

/** An index under `dir` from rows, as `npm run property:build` writes it. */
function buildIndex(dir, list = rows()) {
  const spill = createSpill(path.join(dir, 'tmp'));
  spill.add(compressSections(partitionRows(list, OPTIONS)));
  const spilled = spill.finish();
  fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true });
  const buckets = {};
  for (const [key, { file }] of spilled.buckets) {
    const name = `${key}.bin`;
    const result = mergePropertyBucket({
      spill: file,
      target: path.join(dir, 'buckets', name),
    });
    buckets[key] = { file: name, ...result };
  }
  const fine = Object.fromEntries(FINE_RESOLUTIONS.map((res) => [res, []]));
  const histograms = new Map();
  for (const [key, { file }] of spilled.cells) {
    const result = aggregatePartitionSpill(file);
    for (const res of FINE_RESOLUTIONS) fine[res].push(...result.rows[res]);
    histograms.set(Number(key), result.histograms);
  }
  const coarse = coarseRows(histograms);
  writeHexFile(path.join(dir, 'hexes.00000000.bin'), {
    header: { builtAt: 'now', priceSinceYear: 2015, priceFloorUsd: 10_000 },
    tables: [
      ...COARSE_RESOLUTIONS.map((res) => tableOf(res, coarse[res])),
      ...FINE_RESOLUTIONS.map((res) => tableOf(res, fine[res])),
    ],
  });
  const manifest = {
    version: 'abcdef012345',
    builtAt: 'now',
    records: list.length,
    buildings: Object.values(buckets).reduce((s, b) => s + b.buildings, 0),
    attribution:
      'realestatedataset.com (Straply), CC0; public-record fields only',
    buckets,
    hexes: { file: 'hexes.00000000.bin' },
  };
  fs.writeFileSync(
    path.join(dir, 'manifest-abcdef012345.json'),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(dir, 'current.json'),
    JSON.stringify({ manifest: 'manifest-abcdef012345.json' }),
  );
  return manifest;
}

const BOX = { west: -74.0, south: 40.69, east: -73.97, north: 40.71 };

/** The handler answering one request. */
async function call(handler, url, { method = 'GET', headers = {} } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await handler(
    {
      url,
      method,
      headers: { host: 'localhost:5173', ...headers },
      socket: {},
    },
    res,
  );
  return res;
}

test('an unbuilt index says how to build it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const service = createPropertyService({ dir });
    const handler = createPropertyHandler({ service });
    const layers = await call(handler, '/layers');
    assert.equal(layers.body.configured, false);
    const buildings = await call(
      handler,
      '/buildings?west=-74&south=40.69&east=-73.97&north=40.71',
    );
    assert.equal(buildings.statusCode, 503);
    assert.match(buildings.body.error, /npm run property:build/);
    await service.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the routes answer buildings, a building, hexagons, and refuse what they should', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    buildIndex(dir);
    const service = createPropertyService({ dir });
    const handler = createPropertyHandler({ service });
    const layers = await call(handler, '/layers');
    assert.equal(layers.body.configured, true);
    assert.equal(layers.body.version, 'abcdef012345');
    assert.equal(layers.body.buildings, 2);
    assert.ok(layers.body.domains[7].price);

    const q = new URLSearchParams(
      Object.entries(BOX).map(([k, v]) => [k, String(v)]),
    );
    const listed = await call(handler, `/buildings?${q}`);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.headers['cache-control'], 'no-store');
    assert.equal(listed.body.count, 2);
    assert.equal(listed.body.saturated, false);
    const condos = listed.body.buildings.find((b) => b.units === 6);
    assert.equal(condos.type, 'condo');
    assert.equal(condos.price, 1_300_000);
    assert.equal(condos.sold, '2023-05');
    assert.equal(condos.recent, true);
    assert.ok(Math.abs(condos.at[0] + 73.98612) < 1e-5);
    assert.ok(Math.abs(condos.at[1] - 40.70321) < 1e-5);

    const one = await call(handler, `/building?id=${condos.id}&v=abcdef012345`);
    assert.equal(one.statusCode, 200);
    assert.equal(one.headers['cache-control'], 'private, max-age=86400');
    assert.deepEqual(one.body.address, {
      street: '218 Plymouth St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11201',
    });
    assert.equal(one.body.stacked, false);
    assert.deepEqual(one.body.county, {
      fips: '36047',
      name: 'Kings County',
      state: 'NY',
    });
    assert.deepEqual(
      one.body.records.map((r) => r.unit),
      ['1A', '2A', '3A', '4A', '5A', '6A'],
    );
    const first = one.body.records[0];
    assert.equal(first.apn, '3-00031-1001');
    assert.equal(first.baths, 1);
    assert.deepEqual(first.sold, { price: 1_000_000, date: '2020-05-01' });
    assert.deepEqual(first.tax, [
      { year: 2023, amount: 9000, assessment: 100_000 },
      { year: 2024, amount: 9500, assessment: 110_000 },
    ]);
    // No listing field travels.
    for (const listing of ['status', 'list_price', 'listing_type'])
      assert.equal(listing in first, false);

    const parsed = parseBuildingId(condos.id);
    const stale = await call(
      handler,
      `/building?id=pr:${parsed.x}:${parsed.y}:${parsed.index + 5}`,
    );
    assert.equal(stale.statusCode, 404);
    assert.equal((await call(handler, '/building?id=nope')).statusCode, 400);

    const hexes = await call(handler, `/h3/7/price?${q}`);
    assert.equal(hexes.statusCode, 200);
    // One cell: four condo sales and the house, 1.0–1.3 M and 2 M.
    assert.equal(hexes.body.cells.length, 1);
    assert.equal(hexes.body.cells[0][1], 1_200_000);
    assert.equal(
      hexes.body.cells[0][0],
      h3.latLngToCell(40.70321, -73.98612, 7),
    );
    const counts = await call(handler, `/h3/7/properties?${q}`);
    assert.equal(counts.body.cells[0][1], 7);
    // A coarse cell is found by its centre: a box around the whole state.
    const years = await call(
      handler,
      '/h3/2/year?west=-80&south=38&east=-70&north=45',
    );
    assert.equal(years.body.cells[0][1], 1910);
    assert.equal((await call(handler, `/h3/9/price?${q}`)).statusCode, 400);
    assert.equal((await call(handler, `/h3/7/rent?${q}`)).statusCode, 404);
    assert.equal(
      (await call(handler, '/h3/7/price?west=x&south=1&east=2&north=3'))
        .statusCode,
      400,
    );
    assert.equal(
      (await call(handler, '/buildings?west=-75&south=40&east=-73&north=41'))
        .statusCode,
      400,
    );
    assert.equal(
      (await call(handler, '/layers', { method: 'POST' })).statusCode,
      405,
    );
    assert.equal(
      (
        await call(handler, '/layers', {
          headers: { origin: 'https://elsewhere.example' },
        })
      ).statusCode,
      403,
    );
    await service.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a full box keeps an even spread of its buildings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    const many = [];
    for (let i = 0; i < 40; i++)
      many.push({
        ...rows()[6],
        street: `${i * 2} Jay St`,
        lat: 40.7 + i * 0.0001,
        lng: -73.98 - (i % 7) * 0.0001,
      });
    buildIndex(dir, many);
    const index = createPropertyIndex({ dir, counties: COUNTIES });
    const all = index.buildings({ ...BOX });
    assert.equal(all.body.count, 40);
    const some = index.buildings({ ...BOX, limit: 10 });
    assert.equal(some.body.count, 10);
    assert.equal(some.body.candidates, 40);
    assert.equal(some.body.saturated, true);
    // The same ten again.
    assert.deepEqual(index.buildings({ ...BOX, limit: 10 }).body, some.body);
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the buildings query keeps to a small box', () => {
  const params = (box) =>
    new URLSearchParams(Object.entries(box).map(([k, v]) => [k, String(v)]));
  assert.equal(parseBuildingsQuery(params(BOX)).limit, 3000);
  assert.match(
    parseBuildingsQuery(params({ ...BOX, east: -73.5 })).error,
    /wider than 0.3/,
  );
  assert.match(
    parseBuildingsQuery(params({ ...BOX, west: 179, east: -179 })).error,
    /antimeridian/,
  );
});

test('the Lego mode gets the hexagons as values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-property-'));
  try {
    buildIndex(dir);
    assert.equal(resolutionForCell(2000), 7);
    assert.equal(resolutionForCell(40_000), 4);
    assert.equal(resolutionForCell(50_000), 3);
    assert.equal(resolutionForCell(5e6), 0);
    const root = path.join(dir, 'root');
    const service = createRasterValuesService({
      sourceRoot: root,
      env: {},
      earthEngine: { computePixels: async () => ({ status: 503 }) },
      dirs: {
        overtureDir: path.join(root, 'overture'),
        censusDir: path.join(root, 'census'),
        gridFile: path.join(root, 'grid.bin'),
        propertyDir: dir,
      },
      cacheDir: path.join(root, 'values'),
    });
    assert.ok(
      service.catalog().some((entry) => entry.layer === 'property-sales'),
    );
    const answer = await service.values(
      new URLSearchParams({
        layer: 'property-sales',
        mode: 'price',
        west: '-73.99',
        south: '40.70',
        east: '-73.98',
        north: '40.71',
        cells: '4',
      }),
    );
    assert.equal(answer.status, 200);
    const { header, values } = decodeRasterValues(answer.body);
    assert.equal(header.mode, 'price');
    assert.equal(header.units, 'USD');
    assert.ok([...values].some((v) => v === 1_200_000));
    const missing = await createRasterValuesService({
      sourceRoot: root,
      env: {},
      earthEngine: { computePixels: async () => ({ status: 503 }) },
      dirs: {
        overtureDir: path.join(root, 'overture'),
        censusDir: path.join(root, 'census'),
        gridFile: path.join(root, 'grid.bin'),
        propertyDir: path.join(root, 'nothing'),
      },
      cacheDir: path.join(root, 'values2'),
    }).values(
      new URLSearchParams({
        layer: 'property-sales',
        mode: 'year',
        west: '-73.99',
        south: '40.70',
        east: '-73.98',
        north: '40.71',
        cells: '4',
      }),
    );
    assert.equal(missing.status, 503);
    await service.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
