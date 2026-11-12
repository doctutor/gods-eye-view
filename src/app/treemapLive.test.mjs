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
  assert.deepEqual(air.groupings, ['aircraft.class', 'aircraft.type']);
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
