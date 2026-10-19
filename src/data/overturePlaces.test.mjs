// Personal fork: Overture places (scripts/overture/places*.mjs,
// server/providers/overture/places*.js, src/layers/places/): the categories,
// the index (parts → buckets → counts), the routes, and the layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';
import { latLngToCell } from 'h3-js';

import { categoryCode, placeCategory } from './overturePlaces.js';
import { appendPlace, wkbPoint } from '../../scripts/overture/placesParts.mjs';
import {
  readPartHeader,
  writePart,
} from '../../scripts/overture/buildingsParts.mjs';
import { mergePlacesBucket } from '../../scripts/overture/placesMerge.mjs';
import { writeGlobalCounts } from '../../scripts/overture/places.mjs';
import { fetchBytes } from '../../scripts/overture/buildingsPlan.mjs';
import { unitX, unitY } from '../../server/providers/overture/buildingsFile.js';
import {
  countFor,
  slotOf,
} from '../../server/providers/overture/placesFile.js';
import { createPlacesIndex } from '../../server/providers/overture/placesIndex.js';
import {
  createOvertureHandler,
  createOvertureService,
  parseCountsQuery,
  parsePlacesQuery,
} from '../../server/providers/overture.js';
import { normalizePlace, pinQueryBox } from '../layers/places/places.js';
import { placeCardDetails, statusText } from '../layers/places/presentation.js';
import { createPlacesLayer } from '../layers/places/index.js';
import { h3ResolutionForHeight } from '../maps/h3Resolution.js';

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-places-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('categories from Overture’s taxonomy: charging and worship by name, the rest by the top level', () => {
  assert.equal(categoryCode('restaurant', ['food_and_drink', 'restaurant']), 1);
  assert.equal(
    categoryCode('ev_charging_station', [
      'travel_and_transportation',
      'automotive',
      'ev_charging_station',
    ]),
    10,
  );
  assert.equal(
    categoryCode('christian_place_of_worship', [
      'cultural_and_historic',
      'place_of_worship',
    ]),
    8,
  );
  assert.equal(categoryCode('museum', ['cultural_and_historic', 'museum']), 9);
  assert.equal(categoryCode('hotel', ['lodging', 'hotel']), 6);
  assert.equal(
    categoryCode('real_estate_service', ['services_and_business']),
    11,
  );
  assert.equal(categoryCode(null, []), 11);
  assert.equal(placeCategory('food').code, 1);
  assert.equal(placeCategory('all'), null);
  const wkb = Buffer.alloc(21);
  wkb[0] = 1;
  wkb.writeUInt32LE(1, 1);
  wkb.writeDoubleLE(-76.61, 5);
  wkb.writeDoubleLE(39.29, 13);
  assert.deepEqual(wkbPoint(wkb), [-76.61, 39.29]);
  // The download a row group costs: near chunks share a range, gap and all.
  const chunks = [
    { start: 0, size: 100 },
    { start: 1000, size: 50 },
    { start: 2_000_000, size: 10 },
  ];
  assert.equal(fetchBytes({ chunks }), 1050 + 10);
});

/** An index of these places, as the places step writes it. */
function buildIndex(t, places) {
  const dir = tmp(t);
  const root = path.join(dir, 'places');
  fs.mkdirSync(path.join(root, 'buckets'), { recursive: true });
  const buckets = new Map();
  for (const [lon, lat, confidence, category, name, extra = {}] of places)
    appendPlace(buckets, {
      x: unitX(lon),
      y: unitY(lat),
      confidence,
      category,
      text: { name, basic: 'restaurant', source: 'meta', ...extra },
    });
  const partFile = path.join(dir, 'a.part');
  writePart(partFile, { stats: {} }, buckets);
  const header = readPartHeader(partFile);
  const manifestBuckets = {};
  for (const key of Object.keys(header.buckets)) {
    const name = `${key}.bin`;
    const result = mergePlacesBucket({
      bucketKey: Number(key),
      parts: [{ file: partFile, header }],
      target: path.join(root, 'buckets', name),
    });
    manifestBuckets[key] = {
      file: name,
      places: result.places,
      bytes: result.bytes,
    };
  }
  // The global counts for resolutions 0–5, summed over the buckets.
  const counts = writeGlobalCounts(
    Object.values(manifestBuckets).map((entry) =>
      path.join(root, 'buckets', entry.file),
    ),
    path.join(root, 'counts.abcd1234.bin'),
  );
  const manifest = {
    version: 'abcdef012345',
    release: '2026-09-23.1',
    places: places.length,
    buckets: manifestBuckets,
    counts: { file: 'counts.abcd1234.bin', ...counts },
    stats: { byDataset: { meta: places.length } },
  };
  fs.writeFileSync(
    path.join(root, 'manifest-abcdef012345.json'),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(root, 'current.json'),
    JSON.stringify({ manifest: 'manifest-abcdef012345.json' }),
  );
  return dir;
}

const BALTIMORE = [
  [
    -76.6122,
    39.2904,
    0.95,
    1,
    'Faidley Seafood',
    { website: 'https://faidleyscrabcakes.com', phone: '+14107274898' },
  ],
  [-76.61, 39.291, 0.6, 1, 'Corner Diner'],
  [
    -76.615,
    39.295,
    0.9,
    10,
    'Charge Point',
    { basic: 'ev_charging_station', brand: 'ChargePoint' },
  ],
  [-76.6, 39.3, 0.85, 3, 'Clinic'],
];

test('the index: pins the most confident first, by category and confidence; counts per H3 cell', async (t) => {
  const dir = buildIndex(t, BALTIMORE);
  const index = createPlacesIndex({ dir });
  t.after(() => index.close());
  assert.equal(index.status().places, 4);
  const box = { west: -76.7, south: 39.2, east: -76.5, north: 39.4 };
  const all = index.pins({
    ...box,
    category: 'all',
    minConfidence: 0.5,
    limit: 1500,
  }).body;
  assert.deepEqual(
    all.places.map((p) => p.name),
    ['Faidley Seafood', 'Charge Point', 'Clinic', 'Corner Diner'],
  );
  assert.equal(all.places[0].website, 'https://faidleyscrabcakes.com');
  assert.equal(all.places[0].category, 'food');
  assert.equal(all.places[1].brand, 'ChargePoint');
  assert.equal(all.saturated, false);
  // ≥ 80%: the diner goes; one category; a cap.
  assert.equal(
    index.pins({ ...box, minConfidence: 0.8, limit: 1500 }).body.places.length,
    3,
  );
  assert.deepEqual(
    index
      .pins({ ...box, category: 'charging', minConfidence: 0.5, limit: 10 })
      .body.places.map((p) => p.name),
    ['Charge Point'],
  );
  const capped = index.pins({ ...box, minConfidence: 0.5, limit: 2 }).body;
  assert.equal(capped.places.length, 2);
  assert.equal(capped.saturated, true);
  // Counts: resolution 7 from the bucket, 3 from the global file.
  const r7 = index.counts({
    res: 7,
    window: box,
    category: 'all',
    minConfidence: 0.5,
  }).body;
  assert.equal(r7.total, 4);
  const cell = latLngToCell(39.2904, -76.6122, 7);
  assert.ok(r7.cells.some(([c]) => c === cell));
  const r3 = index.counts({
    res: 3,
    window: null,
    category: 'food',
    minConfidence: 0.8,
  }).body;
  assert.equal(r3.total, 1, 'one restaurant at 80%');
  assert.equal(
    index.counts({
      res: 3,
      window: { west: 0, south: 0, east: 1, north: 1 },
      category: 'all',
      minConfidence: 0.5,
    }).body.total,
    0,
  );
  // The routes.
  const service = createOvertureService({ dir });
  const handle = createOvertureHandler({ service });
  const call = async (url) => {
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(b) {
        this.body = b;
      },
    };
    await handle({ method: 'GET', url, headers: { host: 'localhost' } }, res);
    return {
      status: res.statusCode,
      json: JSON.parse(res.body || 'null'),
      cache: res.headers['cache-control'],
    };
  };
  const layers = await call('/layers');
  assert.equal(layers.json.poi.configured, true);
  const pins = await call(
    '/places?west=-76.7&south=39.2&east=-76.5&north=39.4&category=food&minConfidence=0.5&v=abcdef012345',
  );
  assert.equal(pins.status, 200);
  assert.equal(pins.cache, 'private, max-age=86400');
  assert.deepEqual(
    pins.json.places.map((p) => p.name),
    ['Faidley Seafood', 'Corner Diner'],
  );
  const counts = await call(
    '/places/counts?res=5&category=all&minConfidence=0.8',
  );
  assert.equal(counts.json.total, 3);
  for (const bad of [
    '/places?west=-78&south=39&east=-76&north=40',
    '/places?west=-76.7&south=39.2&east=-76.5&north=39.4&category=pizza',
    '/places/counts?res=9',
  ])
    assert.equal((await call(bad)).status, 400, bad);
});

test('a saturated view keeps places all over it: ties by position, not by tile', (t) => {
  // 400 places at 100% over 0.4°, in a 20 × 20 grid (about 20 z12 tiles).
  const grid = [];
  for (let i = 0; i < 20; i++)
    for (let j = 0; j < 20; j++)
      grid.push([2.2 + i * 0.02, 48.7 + j * 0.02, 1, 1, `P${i}-${j}`]);
  const index = createPlacesIndex({ dir: buildIndex(t, grid) });
  t.after(() => index.close());
  const box = { west: 2.19, south: 48.69, east: 2.6, north: 49.1 };
  const pins = index.pins({ ...box, minConfidence: 0.8, limit: 40 }).body;
  assert.equal(pins.places.length, 40);
  assert.equal(pins.saturated, true);
  const seen = new Set(
    pins.places.map((p) => `${p.at[0] > 2.4}:${p.at[1] > 48.9}`),
  );
  assert.equal(seen.size, 4, 'every quarter of the view');
  // The same places for an overlapping view: stable as it pans.
  const again = index.pins({
    ...box,
    east: 2.61,
    minConfidence: 0.8,
    limit: 40,
  }).body;
  assert.deepEqual(
    again.places.map((p) => p.name),
    pins.places.map((p) => p.name),
  );
});

test('query parsing: a box under a degree, the two confidence floors, a resolution', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(
    parsePlacesQuery(q('west=1&south=2&east=1.5&north=2.5&minConfidence=0.6')),
    {
      west: 1,
      south: 2,
      east: 1.5,
      north: 2.5,
      category: 'all',
      minConfidence: 0.5,
      limit: 1500,
    },
  );
  assert.equal(
    parsePlacesQuery(q('west=1&south=2&east=1.5&north=2.5')).minConfidence,
    0.8,
  );
  assert.match(
    parsePlacesQuery(q('west=179.8&south=2&east=-179.8&north=2.5')).error,
    /antimeridian/,
  );
  assert.deepEqual(parseCountsQuery(q('res=4&category=health')), {
    res: 4,
    window: null,
    category: 'health',
    minConfidence: 0.8,
  });
  // Count vectors: a category's slot, and ALL as the sum over the categories.
  const counts = new Map([
    [slotOf(1, 0), 3],
    [slotOf(2, 0), 2],
    [slotOf(1, 1), 1],
  ]);
  assert.equal(countFor(counts, 1, 0), 3);
  assert.equal(countFor(counts, 0, 0), 5);
  assert.equal(countFor(counts, 0, 1), 1);
});

test('the client: places checked on the way in, the card in words', () => {
  assert.equal(normalizePlace({ id: 'x', name: 'A', at: [0, 0] }), null);
  const place = normalizePlace({
    id: 'pl:1:2:3',
    name: 'Faidley Seafood',
    category: 'food',
    basic: 'seafood_restaurant',
    website: 'javascript:alert(1)',
    phone: '+14107274898',
    source: 'meta',
    confidence: 0.95,
    at: [-76.61, 39.29],
  });
  assert.equal(place.website, undefined, 'only http(s) websites');
  assert.deepEqual(placeCardDetails(place), [
    'Food & drink · Seafood restaurant',
    '+14107274898',
    'Overture Maps · meta · confidence 95%',
  ]);
  assert.match(
    statusText({ state: 'ready', mode: 'pins', count: 1500, saturated: true }),
    /^1,500 places · the most confident/,
  );
  assert.match(
    statusText({ state: 'ready', mode: 'counts', count: 12 }),
    /12 places in view · Counts per hexagon; pins below 20 km/,
  );
  const box = pinQueryBox({ lat: 39.29, lon: -76.61, height: 3000 });
  assert.ok(box.north - box.south < 0.1);
});

function fakeViewer(height) {
  const added = [];
  return {
    added,
    camera: {
      positionCartographic: {
        latitude: Cesium.Math.toRadians(39.29),
        longitude: Cesium.Math.toRadians(-76.61),
        height,
      },
      moveEnd: { addEventListener: () => () => {} },
    },
    scene: {
      canvas: null,
      primitives: { add: (p) => added.push(p), remove: () => {} },
      pick: () => null,
    },
  };
}

test('the layer: counts above 20 km through the rollup, pins below, a card on click, chips refilter', async () => {
  const asked = [];
  const source = {
    status: async () => ({
      configured: true,
      version: 'abcdef012345',
      places: 4,
    }),
    pins: async (q) => {
      asked.push(['pins', q.category, q.minConfidence]);
      return {
        places: [
          normalizePlace({
            id: 'pl:1:2:3',
            name: 'Faidley Seafood',
            category: 'food',
            confidence: 0.95,
            at: [-76.61, 39.29],
          }),
        ],
        count: 1,
        saturated: false,
      };
    },
    counts: async (q) => {
      asked.push(['counts', q.res, q.category]);
      return new Map([[latLngToCell(39.29, -76.61, q.res), 42]]);
    },
    abort: () => {},
  };
  let rollupOptions = null;
  const rollup = { refresh: () => {}, detach: () => {}, isActive: () => false };
  const entries = new Map();
  const layer = createPlacesLayer({
    overlayHost: {
      setEntries: (id, e) => entries.set(id, e),
      setVisible: () => {},
      clearSource: (id) => entries.delete(id),
    },
    source,
    storage: null,
    attachRollup: (_layer, options) => ((rollupOptions = options), rollup),
    setTimeoutImpl: (fn) => (fn(), 0),
    clearTimeoutImpl: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const viewer = fakeViewer(200_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  const res = h3ResolutionForHeight(200_000);
  assert.deepEqual(asked[0], ['counts', res, 'all']);
  assert.equal(
    rollupOptions.getCounts(res).get(latLngToCell(39.29, -76.61, res)),
    42,
  );
  assert.equal(
    rollupOptions.getCounts(res - 1),
    null,
    'another resolution: not held',
  );
  assert.match(layer.getRowControls().info, /42 places in view/);
  // Close in: pins.
  viewer.camera.positionCartographic.height = 3_000;
  layer._settle();
  await flush();
  assert.deepEqual(asked.at(-1), ['pins', 'all', 0.8]);
  assert.equal(layer._state().points.length, 1);
  // A click on the pin: its card.
  viewer.scene.pick = () => ({ id: 'place:pl:1:2:3' });
  layer._onClick({ x: 1, y: 1 });
  assert.equal(entries.get('places')[0].title, 'Faidley Seafood');
  // Chips: a category, a confidence floor.
  const chips = layer.getRowControls().chips;
  assert.equal(chips.length, 13);
  chips.find((c) => c.id === 'category-charging').onClick();
  chips.find((c) => c.id === 'confidence-50').onClick();
  await flush();
  assert.deepEqual(asked.at(-1), ['pins', 'charging', 0.5]);
  layer.disable();
});
