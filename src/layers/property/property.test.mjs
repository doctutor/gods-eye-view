// Personal fork: the Property sales layer: its colours, its answers checked
// on the way in, its card, and the layer through its lifecycle with a
// source and a viewer made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  buildingValue,
  legendValues,
  metricPosition,
  normalizeBuilding,
  normalizeBuildingDetail,
  sparkline,
} from './property.js';
import { buildingCard, rowControls, shortValue } from './presentation.js';
import { PropertyError, toStatus } from './source.js';
import {
  METRIC_STORAGE_KEY,
  PROPERTY_LAYER_ID,
  createPropertyLayer,
  readMetric,
} from './index.js';
import { LEGO_LAYER_IDS, currentMode, layerSpec } from '../lego/layerSpecs.js';

test('metrics sit on their own scales', () => {
  const domain = { min: 100_000, max: 1_000_000 };
  assert.equal(metricPosition('price', 100_000, domain), 0);
  assert.equal(metricPosition('price', 1_000_000, domain), 1);
  assert.ok(Math.abs(metricPosition('price', 316_228, domain) - 0.5) < 1e-3);
  assert.equal(metricPosition('price', 50, domain), 0);
  assert.ok(Number.isNaN(metricPosition('price', 0, domain)));
  // Years are linear.
  assert.equal(metricPosition('year', 1950, { min: 1900, max: 2000 }), 0.5);
  assert.deepEqual(
    legendValues('year', { min: 1900, max: 2000 }).map((s) => s.value),
    [1900, 1925, 1950, 1975, 2000],
  );
  assert.equal(legendValues('price', null).length, 0);
  assert.equal(shortValue('price', 1_250_000), '$1.3M');
  assert.equal(shortValue('year', 1950.4), '1950');
});

test('a building is checked on the way in, and gives each metric its value', () => {
  assert.equal(normalizeBuilding({ id: 'x', at: [0, 0] }), null);
  assert.equal(normalizeBuilding({ id: 'pr:1:2:3', at: [0, 95] }), null);
  const building = normalizeBuilding({
    id: 'pr:1:2:3',
    at: [-73.98, 40.7],
    units: 6,
    type: 'condo',
    price: 1_300_000,
    sold: '2023-05',
    recent: true,
    year: 1910,
    sqft: 1000,
    status: 'for_sale', // never read
  });
  assert.equal(building.type, 'condo');
  assert.equal('status' in building, false);
  assert.equal(buildingValue('price', building), 1_300_000);
  assert.equal(buildingValue('ppsf', building), 1300);
  assert.equal(buildingValue('year', building), 1910);
  assert.equal(buildingValue('properties', building), 6);
  // An old sale colours neither price.
  const old = { ...building, recent: false };
  assert.ok(Number.isNaN(buildingValue('price', old)));
  assert.equal(buildingValue('sales', old), 1);
});

test('a sparkline runs from the lowest bar to the highest', () => {
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([5, NaN, 5]), '▅ ▅');
  assert.equal(sparkline([5]), '');
});

const detail = (records, extra = {}) =>
  normalizeBuildingDetail({
    id: 'pr:1:2:3',
    at: [-73.98, 40.7],
    units: records.length,
    address: {
      street: '218 Plymouth St',
      city: 'Brooklyn',
      state: 'NY',
      zip: '11201',
    },
    county: { fips: '36047', name: 'Kings County', state: 'NY' },
    records,
    more: 0,
    ...extra,
  });

test('a house card has its facts, sale, assessments and parcel', () => {
  const card = buildingCard(
    detail([
      {
        type: 'single_family',
        beds: 3,
        baths: 2.5,
        sqft: 1800,
        lot: 9000,
        year: 1952,
        apn: '03-05-309-008-0000',
        sold: { price: 450_000, date: '2021-06-28' },
        sales: [
          { date: '2014-05-05', price: 300_000 },
          { date: '2021-06-28', price: 450_000 },
        ],
        tax: [
          { year: 2023, amount: 8800, assessment: 145_000 },
          { year: 2024, amount: 9100, assessment: 151_000 },
        ],
      },
    ]),
  );
  assert.equal(card.title, '218 Plymouth St, Brooklyn');
  assert.deepEqual(card.details, [
    'Single family · Kings County, NY · 11201',
    '3 bd · 2.5 ba · 1,800 sqft · lot 9,000 sqft · built 1952',
    'Last sale $450,000 on 2021-06-28',
    'Earlier sales: $300,000 (2014)',
    'Assessed $151,000 (2024) · tax $9,100',
    '▁█ 2023–2024',
    'Parcel 03-05-309-008-0000',
    'realestatedataset.com (Straply), CC0 · Public records as published by realestatedataset.com: not checked against the county',
  ]);
});

test('a building card lists its units, and a stack its addresses', () => {
  const units = Array.from({ length: 8 }, (_, i) => ({
    unit: `${i + 1}A`,
    type: 'condo',
    sqft: 900,
    ...(i < 2 ? { sold: { price: 1_000_000 + i, date: '2020-05-01' } } : {}),
  }));
  const card = buildingCard(detail(units));
  assert.equal(card.details[0], '8 units · Condo · Kings County, NY · 11201');
  assert.equal(card.details[1], '2 with a recorded sale');
  assert.equal(card.details[2], 'Unit 1A · $1,000,000 (2020) · 900 sqft');
  assert.equal(card.details[8], 'and 2 more');
  const stack = buildingCard(
    detail([{ street: '1 Water St' }, { street: '3 Water St' }], {
      stacked: true,
    }),
  );
  assert.equal(
    stack.details[0],
    '2 records at this point · Kings County, NY · 11201',
  );
  assert.equal(stack.details[1], '1 Water St');
});

test('the row: a chip per metric, the legend and the caveat', () => {
  let chosen = null;
  const row = rowControls({
    metric: 'price',
    onMetric: (key) => (chosen = key),
    domain: { min: 100_000, max: 1_000_000 },
    status: { mode: 'hexes', state: 'ready', res: 5, count: 120 },
    index: { records: 10 },
    enabled: true,
    opacity: 0.7,
    onOpacity: () => {},
  });
  assert.deepEqual(
    row.chips.map((chip) => chip.label),
    ['PRICE', '$/SQFT', 'YEAR BUILT', 'SALES', 'PROPERTIES'],
  );
  row.chips[2].onClick();
  assert.equal(chosen, 'year');
  assert.equal(row.legend.length, 5);
  assert.equal(row.legend[4].label, '$1M+');
  assert.match(row.info, /Hexes: resolution 5, 120 cells/);
  assert.match(row.info, /not checked against the county/);
  const unbuilt = rowControls({
    metric: 'price',
    onMetric: () => {},
    domain: null,
    status: { state: 'unconfigured' },
    index: null,
    enabled: true,
    opacity: 0.7,
    onOpacity: () => {},
  });
  assert.match(unbuilt.info, /npm run property:build/);
});

test('the server status is checked', () => {
  assert.deepEqual(toStatus({ configured: false, message: 'Run it' }), {
    configured: false,
    message: 'Run it',
  });
  const status = toStatus({
    configured: true,
    version: 'abcdef012345',
    records: 7,
    domains: { 7: { price: { min: 1, max: 2 }, year: { min: 5, max: 5 } } },
  });
  assert.equal(status.records, 7);
  assert.deepEqual(status.domains[7].price, { min: 1, max: 2, median: 1 });
  assert.equal(status.domains[7].year, null);
});

/** A viewer whose camera sits at a height, with the primitives it was handed. */
function fakeViewer(height) {
  const added = [];
  return {
    added,
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -73.98,
        40.7,
        height,
      ),
      moveEnd: { addEventListener: () => () => {} },
    },
    scene: {
      canvas: null,
      primitives: {
        add: (p) => added.push(p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
      pick: () => ({ id: 'property:pr:1:2:3' }),
    },
  };
}

function fakeSource({ configured = true, tooManyAbove = 99 } = {}) {
  const asked = [];
  return {
    asked,
    status: async () =>
      configured
        ? {
            configured: true,
            version: 'abcdef012345',
            records: 7,
            domains: { 7: { price: { min: 100_000, max: 2_000_000 } } },
          }
        : { configured: false },
    hexes: async ({ res, metric }) => {
      asked.push(['hexes', res, metric]);
      if (res > tooManyAbove)
        throw new PropertyError('tooMany', 'too many', 413);
      return {
        res,
        metric,
        domain: { min: 100_000, max: 2_000_000 },
        cells: new Map([['872a1072bffffff', 500_000]]),
      };
    },
    buildings: async () => {
      asked.push(['buildings']);
      return {
        count: 1,
        saturated: false,
        buildings: [
          normalizeBuilding({
            id: 'pr:1:2:3',
            at: [-73.98, 40.7],
            units: 1,
            price: 450_000,
            recent: true,
          }),
        ],
      };
    },
    building: async () => {
      asked.push(['building']);
      return detail([
        { type: 'condo', sold: { price: 450_000, date: '2021-06-28' } },
      ]);
    },
    abort: () => {},
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const immediate = (fn) => {
  fn();
  return 0;
};

test('the layer draws hexagons from afar, stepping coarser past 413', async () => {
  const source = fakeSource({ tooManyAbove: 4 });
  const storage = new Map();
  const layer = createPropertyLayer({
    cesium: Cesium,
    source,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeoutImpl: immediate,
    clearTimeoutImpl: () => {},
  });
  const viewer = fakeViewer(300_000);
  layer.enable(viewer);
  await flush();
  await flush();
  assert.deepEqual(source.asked, [
    ['hexes', 5, 'price'],
    ['hexes', 4, 'price'],
  ]);
  const state = layer._state();
  assert.equal(state.status.mode, 'hexes');
  assert.equal(state.status.res, 4);
  assert.ok(state.surface?.primitive);
  assert.equal(viewer.added.length, 1);
  layer.setMetric('year');
  assert.equal(storage.get(METRIC_STORAGE_KEY), 'year');
  assert.equal(readMetric({ getItem: () => 'year' }), 'year');
  assert.equal(readMetric({ getItem: () => 'rent' }), 'price');
  layer.disable();
  assert.equal(viewer.added.length, 0);
});

test('close in, buildings as points; a click opens the card', async () => {
  const source = fakeSource();
  const entries = [];
  const layer = createPropertyLayer({
    cesium: Cesium,
    source,
    storage: null,
    overlayHost: {
      setEntries: (key, list) => entries.push([key, list]),
      setVisible: () => {},
      clearSource: () => {},
    },
    setTimeoutImpl: immediate,
    clearTimeoutImpl: () => {},
  });
  const viewer = fakeViewer(2_000);
  layer.enable(viewer);
  await flush();
  await flush();
  assert.deepEqual(source.asked, [['buildings']]);
  assert.equal(layer._state().points.length, 1);
  await layer._onClick({ x: 1, y: 1 });
  const [key, list] = entries.at(-1);
  assert.equal(key, 'property');
  assert.equal(list[0].title, '218 Plymouth St, Brooklyn');
  assert.match(list[0].details.join('\n'), /Last sale \$450,000/);
  layer.disable();
});

test('an unbuilt index says how to build it', async () => {
  const layer = createPropertyLayer({
    cesium: Cesium,
    source: fakeSource({ configured: false }),
    storage: null,
    setTimeoutImpl: immediate,
    clearTimeoutImpl: () => {},
  });
  layer.enable(fakeViewer(300_000));
  await flush();
  assert.match(layer.getRowControls().info, /npm run property:build/);
  layer.disable();
});

test('the Lego mode builds the layer, by its metric', () => {
  assert.ok(LEGO_LAYER_IDS.includes(PROPERTY_LAYER_ID));
  assert.equal(currentMode(PROPERTY_LAYER_ID, null), 'price');
  assert.equal(
    currentMode(PROPERTY_LAYER_ID, { getItem: () => 'year' }),
    'year',
  );
  assert.equal(layerSpec(PROPERTY_LAYER_ID, 'price').scale, 'log');
  assert.equal(layerSpec(PROPERTY_LAYER_ID, 'year').scale, 'linear');
  assert.equal(layerSpec(PROPERTY_LAYER_ID, 'year').nativeM, 2000);
});
