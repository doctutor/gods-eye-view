// Personal fork: the TREEMAP window's live source (treemapLive.js): the
// aircraft and vessels already in the page, cut to the service's node shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveTreemapSource,
  LIVE_LAYER_IDS,
  aircraftTypeOf,
  vesselFamilyOf,
  vesselTypeOf,
} from './treemapLive.js';

function layersWith({ aircraft = [], vessels = [], vesselsOn = true } = {}) {
  return new Map([
    [
      LIVE_LAYER_IDS.aircraft,
      { enabled: true, module: { treemapRecords: () => aircraft } },
    ],
    [
      LIVE_LAYER_IDS.vessels,
      { enabled: vesselsOn, module: { treemapRecords: () => vessels } },
    ],
  ]);
}

test('aircraft by class > type, read from the layer now', async () => {
  let aircraft = [
    {
      klass: 'airliner',
      typeCode: 'A320',
      typeName: 'Airbus A320',
      lat: 10,
      lon: 20,
    },
    { klass: 'airliner', typeCode: 'A320', lat: 11, lon: 21 },
    { klass: 'airliner', typeCode: 'B738', lat: 12, lon: 22 },
    { klass: 'helicopter', typeCode: null, lat: 13, lon: 23 },
  ];
  const map = layersWith({ aircraft });
  const source = createLiveTreemapSource({ layers: () => map });
  const catalog = await source.catalog();
  const air = catalog.variables.find((v) => v.id === 'count/aircraft');
  assert.equal(air.available, true);
  assert.deepEqual(air.groupings, [
    'admin.continent',
    'admin.country',
    'admin.region',
    'aircraft.class',
    'aircraft.type',
  ]);
  const node = await source.node({
    address: 'count/aircraft://aircraft.class/aircraft.type',
  });
  assert.equal(node.total.value, 4);
  assert.deepEqual(
    node.children.map((c) => [c.key, c.label, c.value]),
    [
      ['airliner', 'Airliner', 3],
      ['helicopter', 'Helicopter', 1],
    ],
  );
  assert.deepEqual(
    node.children[0].children.map((c) => [c.key, c.value]),
    [
      ['A320', 2],
      ['B738', 1],
    ],
  );
  assert.equal(node.children[1].children[0].label, 'Type not known');
  assert.match(node.children[0].geo, /^box:/);
  // Read again: the layer's records now, not a copy.
  aircraft.push({ klass: 'glider', lat: 0, lon: 0 });
  const again = await source.node({
    address: 'count/aircraft://aircraft.class',
  });
  assert.equal(again.total.value, 5);
  assert.equal(
    aircraftTypeOf({ typeCode: 'C172', typeName: 'Skyhawk' }).label,
    'C172 · Skyhawk',
  );
});

test('vessels by family > type: AIS codes to their family, text types by their first word', async () => {
  const vessels = [
    { type: '70', lat: 1, lon: 1 },
    { type: '71', lat: 1, lon: 1 },
    { type: '80', lat: 1, lon: 1 },
    { type: '30', lat: 1, lon: 1 },
    { type: 'Cargo ship', lat: 1, lon: 1 },
    { type: '', lat: 1, lon: 1 },
  ];
  assert.deepEqual(vesselFamilyOf({ type: '71' }), {
    key: 'CARGO',
    label: 'CARGO',
  });
  assert.deepEqual(vesselFamilyOf({ type: '30' }).key, 'FISHING');
  assert.equal(vesselFamilyOf({ type: 'Cargo ship' }).key, 'CARGO');
  assert.equal(vesselFamilyOf({ type: '' }).key, 'unknown');
  assert.equal(vesselTypeOf({ type: '71' }).label, 'CARGO 71');
  const map = layersWith({ vessels });
  const source = createLiveTreemapSource({ layers: () => map });
  const node = await source.node({
    address: 'count/vessels://vessel.family/vessel.type',
  });
  assert.equal(node.total.value, 6);
  const cargo = node.children.find((c) => c.key === 'CARGO');
  assert.equal(cargo.value, 3);
  assert.deepEqual(cargo.children.map((c) => c.key).sort(), [
    '70',
    '71',
    'Cargo ship',
  ]);
});

test('a layer that is off is unavailable, with the reason; no layers at all is too', async () => {
  const map = layersWith({ vesselsOn: false });
  const source = createLiveTreemapSource({ layers: () => map });
  const catalog = await source.catalog();
  const vessels = catalog.variables.find((v) => v.id === 'count/vessels');
  assert.equal(vessels.available, false);
  assert.equal(vessels.why, 'Turn the layer on to count it');
  const none = createLiveTreemapSource({ layers: () => null });
  const empty = await none.catalog();
  assert.ok(empty.variables.every((v) => v.available === false));
  const node = await none.node({ address: 'count/aircraft://aircraft.class' });
  assert.equal(node.total.value, 0);
  assert.deepEqual(node.children, []);
});

test('aircraft by country: positions labelled through the service, cached, the sea its own tile', async () => {
  const { createPointLabeller, LABEL_TTL_MS, countryName } =
    await import('./treemapLabels.js');
  const posted = [];
  // The Atlantic at sea, west of it the US, east of it France.
  const where = ([lon]) =>
    lon > -60 && lon < -20
      ? null
      : lon < 0
        ? { country: 'US', region: 'US-MD' }
        : { country: 'FR', region: 'FR-IDF' };
  const service = {
    label: async (points) => {
      posted.push(points.length);
      return { units: points.map(where) };
    },
    node: async ({ path }) => ({
      children: path[1] === 'US' ? [{ key: 'US-MD', label: 'Maryland' }] : [],
    }),
  };
  let clock = 1_000_000;
  const labeller = createPointLabeller({ service, now: () => clock });
  const aircraft = [
    { icao24: 'a1', klass: 'airliner', lon: -76.6, lat: 39.3 },
    { icao24: 'a2', klass: 'airliner', lon: -77, lat: 38.9 },
    { icao24: 'a3', klass: 'helicopter', lon: 2.35, lat: 48.85 },
    { icao24: 'a4', klass: 'airliner', lon: -40, lat: 30 },
  ];
  const map = new Map([
    [
      LIVE_LAYER_IDS.aircraft,
      { enabled: true, module: { treemapRecords: () => aircraft } },
    ],
  ]);
  const source = createLiveTreemapSource({
    layers: () => map,
    service,
    labeller,
  });
  const catalog = await source.catalog();
  assert.ok(
    catalog.variables
      .find((v) => v.id === 'count/aircraft')
      .groupings.includes('admin.country'),
  );
  const node = await source.node({
    address: 'count/aircraft://admin.country/aircraft.class',
  });
  assert.deepEqual(
    node.children.map((c) => [c.key, c.label, c.value]),
    [
      ['US', countryName('US'), 2],
      ['FR', countryName('FR'), 1],
      ['ocean', 'Oceans and unclaimed', 1],
    ],
  );
  assert.equal(node.children[0].children[0].key, 'airliner');
  assert.deepEqual(posted, [4]);
  // A refresh soon after posts nothing; a far move or a stale label does.
  await source.node({ address: 'count/aircraft://admin.country' });
  assert.deepEqual(posted, [4]);
  aircraft[2].lon = 5;
  await source.node({ address: 'count/aircraft://admin.country' });
  assert.deepEqual(posted, [4, 1]);
  clock += LABEL_TTL_MS + 1;
  await source.node({ address: 'count/aircraft://admin.country' });
  assert.deepEqual(posted, [4, 1, 4]);
  // A cut without admin groupings posts nothing.
  await source.node({ address: 'count/aircraft://aircraft.class' });
  assert.deepEqual(posted, [4, 1, 4]);
  // Inside a country the regions are named from the service's area table.
  const us = await source.node({
    address: 'count/aircraft://admin.continent/admin.country/admin.region',
    path: ['north-america', 'US'],
  });
  assert.deepEqual(
    us.children.map((c) => [c.key, c.label, c.value]),
    [['US-MD', 'Maryland', 2]],
  );
});

test('points the service could not label wait in their own tile', async () => {
  const { createPointLabeller } = await import('./treemapLabels.js');
  const service = {
    label: async () => {
      throw new Error('treemap 404');
    },
    node: async () => ({ children: [] }),
  };
  const labeller = createPointLabeller({ service });
  const map = new Map([
    [
      LIVE_LAYER_IDS.vessels,
      {
        enabled: true,
        module: {
          treemapRecords: () => [{ mmsi: '1', type: '70', lon: 1, lat: 1 }],
        },
      },
    ],
  ]);
  const source = createLiveTreemapSource({
    layers: () => map,
    service,
    labeller,
  });
  const node = await source.node({
    address: 'count/vessels://admin.country/vessel.family',
  });
  assert.deepEqual(
    node.children.map((c) => [c.key, c.label]),
    [['unplaced', 'Not placed yet']],
  );
  assert.ok(labeller.failed());
});
