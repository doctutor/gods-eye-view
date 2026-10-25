// Personal fork: the Administrative boundaries layer's COUNTRIES (and AUTO
// from orbit) from the local Overture country lines, and LSIB without them;
// REGIONS and DISTRICTS from Overture's region and county lines below their
// heights where Overture has the level, FAO GAUL elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  EARTH_ENGINE_LAYERS,
  OVERTURE_DISTRICTS_BELOW_M,
  OVERTURE_REGIONS_BELOW_M,
} from '../../data/earthEngineLayers.js';
import { OVERTURE_BOUNDARIES_CREDIT } from '../../data/dataCredits.js';
import { LEVEL_STORAGE_PREFIX, createEarthEngineLayer } from './index.js';
import { createEarthEngineSource } from './source.js';
import {
  STATUS_TTL_MS,
  coverageCellKey,
  createOvertureBoundariesSource,
  overtureBoundariesCover,
  overtureBoundariesImageryOptions,
  overtureBoundariesReady,
  toOvertureBoundariesStatus,
} from './overtureBoundaries.js';

const RECORD = EARTH_ENGINE_LAYERS.find(
  (layer) => layer.id === 'ee-admin-boundaries',
);
const BUILT = {
  configured: true,
  attribution:
    'Country lines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL)',
  builtAt: '2026-10-22T12:00:00.000Z',
  minZoom: 0,
  maxZoom: 14,
  versions: { light: '0123456789ab', dark: 'ba9876543210' },
};

function fakeViewer(height, lon = 77, lat = 34) {
  const layers = [];
  const listeners = [];
  return {
    layers,
    setHeight: (h) => (height = h),
    setPlace: (x, y) => ((lon = x), (lat = y)),
    settle: () => listeners.forEach((fn) => fn()),
    viewer: {
      imageryLayers: {
        add: (layer) => (layers.push(layer), layer),
        remove(layer) {
          const at = layers.indexOf(layer);
          if (at >= 0) layers.splice(at, 1);
          return at >= 0;
        },
      },
      camera: {
        get positionCartographic() {
          return Cesium.Cartographic.fromDegrees(lon, lat, height);
        },
        moveEnd: {
          addEventListener(fn) {
            listeners.push(fn);
            return () => listeners.splice(listeners.indexOf(fn), 1);
          },
        },
      },
    },
  };
}

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** An Earth Engine catalog with the boundaries layer, or none set up. */
function earthEngine(configured = true) {
  return createEarthEngineSource({
    fetchImpl: async () =>
      Response.json(
        configured
          ? {
              configured: true,
              tiles: { used: 0, budget: 0 },
              layers: [
                {
                  id: RECORD.id,
                  name: RECORD.name,
                  kind: RECORD.kind,
                  inks: Object.keys(RECORD.inks),
                  maxZoom: RECORD.maxZoom,
                  variants: RECORD.variants.map((v) => ({
                    key: v.key,
                    ready: true,
                    ...(v.auto ? { auto: true } : {}),
                    ...(v.minHeightM !== undefined
                      ? { minHeightM: v.minHeightM }
                      : {}),
                    ...(v.maxHeightM !== undefined
                      ? { maxHeightM: v.maxHeightM }
                      : {}),
                  })),
                  legend: RECORD.legend,
                  attribution: RECORD.attribution,
                  error: null,
                },
              ],
            }
          : { configured: false, message: 'No Earth Engine key', layers: [] },
      ),
  });
}

const statusOf = (body) => ({ status: async () => body, last: () => null });

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

test('the status is checked on the way in; options only for a built ink', () => {
  const status = toOvertureBoundariesStatus({
    ...BUILT,
    maxZoom: 40,
    versions: {
      light: '0123456789ab',
      dark: 'not-a-hash',
      purple: 'abcdef012345',
    },
    message: '  a\n message ',
  });
  assert.deepEqual(status.versions, { light: '0123456789ab' });
  assert.equal(status.maxZoom, 18);
  assert.equal(status.message, 'a message');
  assert.equal(overtureBoundariesReady(status, 'light'), true);
  assert.equal(overtureBoundariesReady(status, 'dark'), false);
  assert.equal(overtureBoundariesReady(toOvertureBoundariesStatus({})), false);
  assert.equal(overtureBoundariesImageryOptions(status, 'dark'), null);
  assert.deepEqual(overtureBoundariesImageryOptions(status, 'light'), {
    url: '/api/boundaries/countries/tile/light/{z}/{x}/{y}?v=0123456789ab',
    minimumLevel: 0,
    maximumLevel: 18,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: BUILT.attribution,
  });
});

test('the status is shared, kept a few minutes, and a failure reads as not built', async () => {
  let clock = 0;
  const calls = [];
  let answer = () => Response.json(BUILT);
  const source = createOvertureBoundariesSource({
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(url);
      return answer();
    },
  });
  const [a, b] = await Promise.all([source.status(), source.status()]);
  assert.equal(a, b);
  assert.deepEqual(calls, ['/api/boundaries/countries/layers']);
  assert.equal(a.configured, true);
  clock = STATUS_TTL_MS - 1;
  await source.status();
  assert.equal(calls.length, 1);
  clock = STATUS_TTL_MS;
  answer = () => Response.json({ error: 'No build' }, { status: 503 });
  const failed = await source.status();
  assert.equal(failed.configured, false);
  assert.equal(failed.message, 'No build');
  answer = () => {
    throw new Error('offline');
  };
  const offline = await source.status({ refresh: true });
  assert.equal(offline.configured, false);
  assert.equal(offline.message, 'offline');
});

test('with the country lines built, COUNTRIES draws them in the ink, and AUTO does from 5,000 km', async () => {
  const fake = fakeViewer(6_000_000);
  const registered = [];
  const storage = memoryStorage();
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(),
    storage,
    credits: { register: (_viewer, credit) => registered.push(credit.key) },
    countriesSource: statusOf(BUILT),
    countriesCredit: OVERTURE_BOUNDARIES_CREDIT,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().variant, 'level0', 'AUTO from orbit');
  assert.equal(fake.layers.length, 1);
  assert.equal(
    fake.layers[0].imageryProvider.url,
    '/api/boundaries/countries/tile/light/{z}/{x}/{y}?v=0123456789ab',
  );
  assert.equal(fake.layers[0].imageryProvider.maximumLevel, 14);
  assert.ok(registered.includes('overture-boundaries'));
  assert.equal(layer.getRowControls().info, 'Countries');
  // Below 5,000 km AUTO is Earth Engine's GAUL again.
  fake.setHeight(3_000_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level1');
  assert.match(
    fake.layers[0].imageryProvider.url,
    /\/api\/earth-engine\/tile\/ee-admin-boundaries\/level1\/light\//,
  );
  // COUNTRIES forced: the local lines at any height, in the forced ink.
  const chip = (id) => layer.getRowControls().chips.find((c) => c.id === id);
  chip('level-level0').onClick();
  assert.equal(
    storage.map.get(`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`),
    'level0',
  );
  fake.setHeight(50_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level0');
  chip('ink-dark').onClick();
  assert.equal(layer._state().ink, 'dark');
  assert.equal(fake.layers.length, 1, 'one imagery layer at a time');
  assert.equal(
    fake.layers[0].imageryProvider.url,
    '/api/boundaries/countries/tile/dark/{z}/{x}/{y}?v=ba9876543210',
  );
  layer.destroy();
});

test('without the build, COUNTRIES draws LSIB from Earth Engine and AUTO never draws countries', async () => {
  const fake = fakeViewer(6_000_000);
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(),
    storage: memoryStorage(),
    countriesSource: statusOf(
      toOvertureBoundariesStatus({ configured: false }),
    ),
    countriesCredit: OVERTURE_BOUNDARIES_CREDIT,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().variant, 'level1', 'AUTO from orbit: regions');
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'level-level0')
    .onClick();
  assert.equal(layer._state().variant, 'level0');
  assert.match(
    fake.layers[0].imageryProvider.url,
    /\/api\/earth-engine\/tile\/ee-admin-boundaries\/level0\/light\//,
  );
  layer.destroy();
});

test('the country lines draw without Earth Engine set up', async () => {
  const fake = fakeViewer(6_000_000);
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(false),
    storage: memoryStorage({
      [`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`]: 'level0',
    }),
    countriesSource: statusOf(BUILT),
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 1);
  assert.match(
    fake.layers[0].imageryProvider.url,
    /^\/api\/boundaries\/countries\/tile\/light\//,
  );
  // Regions still need Earth Engine.
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'level-level1')
    .onClick();
  assert.equal(fake.layers.length, 0);
  layer.destroy();
});

/** The z 6 cell key of a place, as the build writes it. */
const cellOf = (lat, lon) => {
  const { x, y } = coverageCellKey(lat, lon, 6);
  return y * 64 + x;
};
/** A build with region and county lines: Baltimore's cell covered, Brazil's not. */
const WITH_SETS = {
  ...BUILT,
  attribution:
    'Boundary lines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL)',
  coverage: { gridZoom: 6 },
  sets: {
    regions: {
      versions: { light: 'aaaaaaaaaaaa', dark: 'bbbbbbbbbbbb' },
      cells: [cellOf(39.29, -76.61), cellOf(-15.8, -47.9)],
    },
    districts: {
      versions: { light: 'cccccccccccc', dark: 'dddddddddddd' },
      cells: [cellOf(39.29, -76.61)],
    },
  },
};

test('the region and district sets: their versions, their cells, and where they cover', () => {
  const status = toOvertureBoundariesStatus({
    ...WITH_SETS,
    sets: {
      ...WITH_SETS.sets,
      districts: {
        ...WITH_SETS.sets.districts,
        cells: [cellOf(39.29, -76.61), -1, 'x', 1.5],
      },
      towns: { versions: { light: 'eeeeeeeeeeee' }, cells: [1] },
    },
  });
  assert.deepEqual(Object.keys(status.sets), ['regions', 'districts']);
  assert.equal(status.sets.districts.cells.size, 1, 'only cell keys');
  assert.equal(status.coverageZoom, 6);
  assert.equal(overtureBoundariesReady(status, 'light', 'districts'), true);
  assert.equal(overtureBoundariesReady(status, 'light', 'towns'), false);
  assert.equal(
    overtureBoundariesReady(
      toOvertureBoundariesStatus(BUILT),
      'light',
      'regions',
    ),
    false,
    'a country-only build',
  );
  assert.equal(
    overtureBoundariesImageryOptions(status, 'dark', 'districts').url,
    '/api/boundaries/countries/tile/districts/dark/{z}/{x}/{y}?v=dddddddddddd',
  );
  // Baltimore, and a view a cell away (its neighbours count); Rio and the
  // open Atlantic not.
  assert.equal(
    overtureBoundariesCover(status, 'districts', 39.29, -76.61),
    true,
  );
  assert.equal(
    overtureBoundariesCover(status, 'districts', 39.29, -76.61 + 5.6),
    true,
  );
  assert.equal(
    overtureBoundariesCover(status, 'districts', -22.9, -43.2),
    false,
  );
  assert.equal(overtureBoundariesCover(status, 'districts', 35, -40), false);
  assert.equal(
    overtureBoundariesCover(status, 'regions', -15.8, -47.9),
    true,
    'Brazil has regions',
  );
  assert.equal(overtureBoundariesCover(status, 'countries', 35, -40), true);
  assert.equal(
    overtureBoundariesCover(
      toOvertureBoundariesStatus(BUILT),
      'regions',
      39.29,
      -76.61,
    ),
    false,
  );
  // The antimeridian wraps.
  const fiji = toOvertureBoundariesStatus({
    ...WITH_SETS,
    sets: {
      regions: {
        versions: WITH_SETS.sets.regions.versions,
        cells: [cellOf(-17, 179.9)],
      },
    },
  });
  assert.equal(overtureBoundariesCover(fiji, 'regions', -17, -179.9), true);
});

test('REGIONS and DISTRICTS draw Overture below their heights where it has the level, GAUL above and elsewhere', async () => {
  assert.ok(OVERTURE_DISTRICTS_BELOW_M < OVERTURE_REGIONS_BELOW_M);
  const fake = fakeViewer(3_000_000, -76.61, 39.29);
  const registered = [];
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(),
    storage: memoryStorage(),
    credits: { register: (_viewer, credit) => registered.push(credit.key) },
    countriesSource: statusOf(toOvertureBoundariesStatus(WITH_SETS)),
    countriesCredit: OVERTURE_BOUNDARIES_CREDIT,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  const url = () => fake.layers[0]?.imageryProvider.url || '';
  // AUTO over Baltimore at 3,000 km: regions, Overture's.
  assert.equal(layer._state().variant, 'level1');
  assert.equal(
    url(),
    '/api/boundaries/countries/tile/regions/light/{z}/{x}/{y}?v=aaaaaaaaaaaa',
  );
  assert.ok(registered.includes('overture-boundaries'), 'its credit');
  // Below 800 km: districts, Overture's.
  fake.setHeight(500_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level2');
  assert.match(url(), /\/tile\/districts\/light\//);
  // Over Rio: no county lines there, so GAUL's districts.
  fake.setPlace(-43.2, -22.9);
  fake.settle();
  assert.match(
    url(),
    /\/api\/earth-engine\/tile\/ee-admin-boundaries\/level2\/light\//,
  );
  // DISTRICTS forced from 2,000 km over Baltimore: GAUL (counties start at z 7).
  const chip = (id) => layer.getRowControls().chips.find((c) => c.id === id);
  chip('level-level2').onClick();
  fake.setPlace(-76.61, 39.29);
  fake.setHeight(2_000_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level2');
  assert.match(
    url(),
    /\/api\/earth-engine\/tile\/ee-admin-boundaries\/level2\//,
  );
  fake.setHeight(OVERTURE_DISTRICTS_BELOW_M - 1);
  fake.settle();
  assert.match(url(), /\/tile\/districts\/light\//);
  // REGIONS forced from above 5,000 km: GAUL; below, Overture's, in the ink.
  chip('level-level1').onClick();
  fake.setHeight(OVERTURE_REGIONS_BELOW_M + 1);
  fake.settle();
  assert.match(
    url(),
    /\/api\/earth-engine\/tile\/ee-admin-boundaries\/level1\//,
  );
  fake.setHeight(OVERTURE_REGIONS_BELOW_M - 1);
  fake.settle();
  chip('ink-dark').onClick();
  assert.equal(fake.layers.length, 1, 'one imagery layer at a time');
  assert.equal(
    url(),
    '/api/boundaries/countries/tile/regions/dark/{z}/{x}/{y}?v=bbbbbbbbbbbb',
  );
  layer.destroy();
});
