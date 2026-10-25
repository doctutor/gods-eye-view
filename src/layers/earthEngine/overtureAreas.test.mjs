// Personal fork: the Administrative boundaries layer with Overture's
// division areas: the status, a click's card, FILLS under REGIONS and
// DISTRICTS, COASTS with COUNTRIES from Overture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { OVERTURE_BOUNDARIES_CREDIT } from '../../data/dataCredits.js';
import {
  COASTS_STORAGE_PREFIX,
  FILLS_STORAGE_PREFIX,
  LEVEL_STORAGE_PREFIX,
  createEarthEngineLayer,
} from './index.js';
import { createEarthEngineSource } from './source.js';
import {
  areaCoastImageryOptions,
  areaFillImageryOptions,
  createOvertureAreasSource,
  toIdentifyAnswer,
  toOvertureAreasStatus,
} from './overtureAreas.js';
import {
  coverageCellKey,
  toOvertureBoundariesStatus,
} from './overtureBoundaries.js';
import {
  BOUNDARY_CLICKS_OVERLAY,
  createBoundaryClicks,
  identifyCard,
} from './boundaryClicks.js';

const RECORD = EARTH_ENGINE_LAYERS.find(
  (layer) => layer.id === 'ee-admin-boundaries',
);
const AREAS = {
  configured: true,
  attribution:
    'Boundary lines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL)',
  maxZoom: 14,
  versions: {
    fill: { regions: '111111111111', districts: '222222222222' },
    coast: { light: '333333333333', dark: '444444444444' },
  },
};
const cellOf = (lat, lon) => {
  const { x, y } = coverageCellKey(lat, lon, 6);
  return y * 64 + x;
};
const LINES = toOvertureBoundariesStatus({
  configured: true,
  attribution: AREAS.attribution,
  minZoom: 0,
  maxZoom: 14,
  versions: { light: '0123456789ab', dark: 'ba9876543210' },
  coverage: { gridZoom: 6 },
  sets: {
    regions: {
      versions: { light: 'aaaaaaaaaaaa', dark: 'bbbbbbbbbbbb' },
      cells: [cellOf(39.29, -76.61)],
    },
    districts: {
      versions: { light: 'cccccccccccc', dark: 'dddddddddddd' },
      cells: [cellOf(39.29, -76.61)],
    },
  },
});

test('the status is checked on the way in; fill and coast options only when built', () => {
  const status = toOvertureAreasStatus({
    ...AREAS,
    versions: {
      fill: {
        regions: '111111111111',
        towns: '555555555555',
        districts: 'nope',
      },
      coast: { light: '333333333333', purple: '666666666666' },
    },
  });
  assert.deepEqual(status.fill, { regions: '111111111111' });
  assert.deepEqual(status.coast, { light: '333333333333' });
  assert.equal(
    areaFillImageryOptions(status, 'regions').url,
    '/api/boundaries/areas/fill/regions/{z}/{x}/{y}?v=111111111111',
  );
  assert.equal(areaFillImageryOptions(status, 'districts'), null);
  assert.equal(
    areaCoastImageryOptions(status, 'light').url,
    '/api/boundaries/areas/coast/light/{z}/{x}/{y}?v=333333333333',
  );
  assert.equal(
    areaCoastImageryOptions(toOvertureAreasStatus({}), 'light'),
    null,
  );
});

test('the identify answer is checked; the card names the county, region and country, or the sea', async () => {
  const answer = toIdentifyAnswer({
    land: true,
    units: {
      county: { name: 'Baltimore', subtype: 'county', country: 'US' },
      region: { name: 'Maryland', subtype: 'region', country: 'US' },
      country: {
        name: 'United States',
        nameEn: 'United States',
        subtype: 'country',
        country: 'US',
      },
      bogus: { name: 'x' },
    },
    attribution: AREAS.attribution,
  });
  assert.deepEqual(Object.keys(answer.units), ['country', 'region', 'county']);
  assert.deepEqual(identifyCard(answer), {
    title: 'Baltimore',
    details: [
      'County: Baltimore',
      'Region: Maryland',
      'Country: United States (US)',
      AREAS.attribution,
    ],
  });
  const qingdao = identifyCard(
    toIdentifyAnswer({
      land: true,
      units: {
        county: {
          name: '青岛市',
          nameEn: 'Qingdao',
          subtype: 'county',
          country: 'CN',
        },
        region: {
          name: '山东省',
          nameEn: 'Shandong',
          subtype: 'region',
          country: 'CN',
        },
        country: {
          name: '中国',
          nameEn: 'China',
          subtype: 'country',
          country: 'CN',
        },
      },
    }),
  );
  assert.equal(qingdao.title, '青岛市 (Qingdao)');
  assert.ok(qingdao.details.includes('Country: 中国 (China) (CN)'));
  const rio = identifyCard(
    toIdentifyAnswer({
      land: true,
      units: {
        region: { name: 'Rio de Janeiro', subtype: 'region', country: 'BR' },
      },
    }),
  );
  assert.ok(rio.details.includes('No county in Overture here'));
  assert.deepEqual(identifyCard(toIdentifyAnswer({ land: false, sea: null })), {
    title: 'At sea',
    details: [],
  });
  assert.deepEqual(
    identifyCard(
      toIdentifyAnswer({
        land: false,
        sea: { name: 'United States', subtype: 'country', country: 'US' },
      }),
    ).details,
    ['In the territorial sea of United States'],
  );
  // The source asks the route with the point.
  const asked = [];
  const source = createOvertureAreasSource({
    fetchImpl: async (url) => {
      asked.push(url);
      return Response.json({
        land: true,
        units: { country: { name: 'A', subtype: 'country' } },
      });
    },
  });
  assert.equal((await source.identify(39.29, -76.61)).units.country.name, 'A');
  assert.deepEqual(asked, [
    '/api/boundaries/areas/identify?lat=39.290000&lon=-76.610000',
  ]);
  const failing = createOvertureAreasSource({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  assert.equal(await failing.identify(1, 1), null);
});

/** A fake Cesium enough for the click companion: picks map pixels to degrees. */
function fakeCesium() {
  const handlers = [];
  return {
    handlers,
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartographic: {
      fromCartesian: ({ lon, lat }) => ({
        longitude: (lon * Math.PI) / 180,
        latitude: (lat * Math.PI) / 180,
      }),
    },
    Math: { toDegrees: (r) => (r * 180) / Math.PI },
    ScreenSpaceEventHandler: class {
      constructor() {
        this.destroyed = false;
        handlers.push(this);
      }
      setInputAction(action) {
        this.action = action;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    ScreenSpaceEventType: { LEFT_CLICK: 'click' },
  };
}

test('a click asks only while REGIONS or DISTRICTS shows; its card is on the world overlay; off, it goes', async () => {
  const cesium = fakeCesium();
  const drawn = [];
  const asked = [];
  let active = false;
  const clicks = createBoundaryClicks({
    source: {
      identify: async (lat, lon) => {
        asked.push([lat, lon]);
        return toIdentifyAnswer({
          land: true,
          units: { county: { name: 'Baltimore', subtype: 'county' } },
        });
      },
    },
    overlayHost: {
      setEntries: (sourceId, entries) => drawn.push({ sourceId, entries }),
      setVisible: () => {},
      clearSource: (sourceId) => drawn.push({ sourceId, cleared: true }),
    },
    hitTest: (x) => (x === 999 ? { entryId: 'card' } : null),
    cesium,
  });
  const viewer = {
    scene: { canvas: {} },
    // A click at (x, y) px is at lon x/10, lat y/10.
    camera: {
      pickEllipsoid: ({ x, y }) =>
        x < 0 ? null : { lon: x / 10, lat: y / 10 },
    },
  };
  clicks.enable(viewer, { active: () => active });
  assert.equal(clicks.attached(), true);
  await clicks._onClick({ x: -766, y: 392 });
  assert.equal(asked.length, 0, 'COUNTRIES showing: no question');
  active = true;
  await clicks._onClick({ x: -766.1, y: 392.9 });
  // Off the globe: nothing asked (the fake picks nothing left of 0).
  assert.equal(asked.length, 0);
  await clicks._onClick({ x: 766, y: 392 });
  assert.deepEqual(asked, [[39.2, 76.6]], 'lat, lon');
  const card = drawn.at(-1);
  assert.equal(card.sourceId, BOUNDARY_CLICKS_OVERLAY);
  assert.equal(card.entries[0].title, 'Baltimore');
  assert.equal(card.entries[0].variant, 'card');
  await clicks._onClick({ x: 999, y: 1 });
  assert.equal(asked.length, 1, 'a click on the card itself');
  // The level changes to COUNTRIES: the card closes.
  active = false;
  clicks.update();
  assert.equal(clicks._card(), null);
  assert.deepEqual(drawn.at(-1).entries, []);
  clicks.disable();
  assert.ok(cesium.handlers.every((h) => h.destroyed));
  assert.equal(drawn.at(-1).cleared, true);
});

function fakeViewer(height, lon = -76.61, lat = 39.29) {
  const layers = [];
  const listeners = [];
  return {
    layers,
    setHeight: (h) => (height = h),
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

const earthEngine = () =>
  createEarthEngineSource({
    fetchImpl: async () =>
      Response.json({
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
      }),
  });

const statusOf = (body) => ({ status: async () => body, last: () => null });
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

test('FILLS draws the units under REGIONS and DISTRICTS (off by default); COASTS draws the countries’ coasts with COUNTRIES from Overture', async () => {
  const fake = fakeViewer(3_000_000);
  const storage = memoryStorage();
  let active = null;
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(),
    storage,
    credits: { register: () => {} },
    countriesSource: statusOf(LINES),
    countriesCredit: OVERTURE_BOUNDARIES_CREDIT,
    areasSource: statusOf(toOvertureAreasStatus(AREAS)),
    clicks: {
      enable: (_viewer, options) => (active = options.active),
      disable: () => {},
      update: () => {},
    },
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  const urls = () => fake.layers.map((l) => l.imageryProvider.url);
  const chip = (id) => layer.getRowControls().chips.find((c) => c.id === id);
  assert.ok(chip('areas-fills') && chip('areas-coasts'), 'the two toggles');
  assert.equal(chip('areas-fills').active, false);
  assert.equal(chip('areas-coasts').active, true);
  // AUTO at 3,000 km over Baltimore: Overture's regions, no fill yet.
  assert.equal(urls().length, 1);
  assert.equal(active(), true, 'REGIONS showing: a click identifies');
  chip('areas-fills').onClick();
  assert.equal(storage.map.get(`${FILLS_STORAGE_PREFIX}${RECORD.id}`), '1');
  assert.deepEqual(urls().sort(), [
    '/api/boundaries/areas/fill/regions/{z}/{x}/{y}?v=111111111111',
    '/api/boundaries/countries/tile/regions/light/{z}/{x}/{y}?v=aaaaaaaaaaaa',
  ]);
  // Districts below 800 km: their fills.
  fake.setHeight(500_000);
  fake.settle();
  assert.ok(
    urls().includes(
      '/api/boundaries/areas/fill/districts/{z}/{x}/{y}?v=222222222222',
    ),
  );
  layer.setOpacity?.(0.4);
  // COUNTRIES from Overture: the coasts over its lines, no fills, no clicks.
  chip('level-level0').onClick();
  assert.equal(
    storage.map.get(`${LEVEL_STORAGE_PREFIX}${RECORD.id}`),
    'level0',
  );
  assert.deepEqual(urls().sort(), [
    '/api/boundaries/areas/coast/light/{z}/{x}/{y}?v=333333333333',
    '/api/boundaries/countries/tile/light/{z}/{x}/{y}?v=0123456789ab',
  ]);
  assert.equal(active(), false);
  chip('areas-coasts').onClick();
  assert.equal(storage.map.get(`${COASTS_STORAGE_PREFIX}${RECORD.id}`), '0');
  assert.deepEqual(urls(), [
    '/api/boundaries/countries/tile/light/{z}/{x}/{y}?v=0123456789ab',
  ]);
  layer.disable();
  assert.equal(fake.layers.length, 0, 'every layer goes');
  layer.destroy();
});

test('without the areas build: no toggles, no fills, and a click does not identify', async () => {
  const fake = fakeViewer(3_000_000);
  let active = null;
  const layer = createEarthEngineLayer({
    record: RECORD,
    source: earthEngine(),
    storage: memoryStorage({ [`${FILLS_STORAGE_PREFIX}${RECORD.id}`]: '1' }),
    countriesSource: statusOf(LINES),
    areasSource: statusOf(toOvertureAreasStatus({ configured: false })),
    clicks: {
      enable: (_v, options) => (active = options.active),
      disable: () => {},
      update: () => {},
    },
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(
    layer.getRowControls().chips.some((c) => c.id.startsWith('areas-')),
    false,
  );
  assert.equal(fake.layers.length, 1, 'the lines only');
  assert.equal(active(), false);
  layer.destroy();
});
