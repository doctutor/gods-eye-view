// Personal fork: the treemap window's sources (treemapSources.js): the
// service client, the records source the live layers and the sample use,
// the window's choice between them; the sample; the store and its param.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServiceSource,
  createRecordSource,
  createWindowSource,
  TreemapError,
  boxOfRef,
  refOfBox,
  boxGeoJson,
  TREEMAP_SCHEMA,
} from './treemapSources.js';
import { createSampleSource, PLANET_KM2 } from './treemapSample.js';
import {
  createTreemapStore,
  decodeTreemapParam,
  encodeTreemapParam,
  DEFAULT_TREEMAP_ADDRESS,
  formatTreemapPath,
  parseTreemapPath,
  cleanTreemapAddress,
} from './treemapStore.js';

const PLANES = [
  { cls: 'Airliner', type: 'A320', box: [0, 0, 1, 1] },
  { cls: 'Airliner', type: 'A320', box: [2, 2, 3, 3] },
  { cls: 'Airliner', type: 'B738', box: [4, 4, 5, 5] },
  { cls: 'Helicopter', type: 'EC35', box: [6, 6, 7, 7] },
  { cls: 'Light', type: 'C172', box: [8, 8, 9, 9] },
];

function planes() {
  return createRecordSource({
    id: 'live',
    variables: [
      {
        id: 'count/aircraft',
        mode: 'additive',
        records: () => PLANES,
        groupings: {
          'aircraft.class': (r) => ({ key: r.cls, label: r.cls }),
          'aircraft.type': (r) => ({ key: r.type, label: r.type }),
        },
        box: (r) => r.box,
        attribution: 'test',
      },
    ],
  });
}

test('the window’s address through the shared parser; the share link’s path round-trips', () => {
  assert.equal(
    cleanTreemapAddress(' count/aircraft://aircraft.class × aircraft.type '),
    'count/aircraft://aircraft.class*aircraft.type',
  );
  assert.equal(
    cleanTreemapAddress('count/aircraft://aircraft.class/aircraft.class'),
    null,
  );
  assert.equal(cleanTreemapAddress('not an address'), null);
  assert.deepEqual(parseTreemapPath(formatTreemapPath(['a/b', 'c d', 'x|y'])), [
    'a/b',
    'c d',
    'x|y',
  ]);
  assert.deepEqual(parseTreemapPath('%E0%A4'), []);
});

test('records source: a node cut two levels deep, with shares, counts, geo and hasChildren', async () => {
  const node = await planes().node({
    address: 'count/aircraft://aircraft.class/aircraft.type',
  });
  assert.equal(node.schema, TREEMAP_SCHEMA);
  assert.equal(node.mode, 'additive');
  assert.deepEqual(node.total, { value: 5, count: 5 });
  assert.equal(node.level.grouping, 'aircraft.class');
  assert.deepEqual(
    node.children.map((c) => [c.key, c.value, c.share]),
    [
      ['Airliner', 3, 0.6],
      ['Helicopter', 1, 0.2],
      ['Light', 1, 0.2],
    ],
  );
  const airliner = node.children[0];
  assert.equal(airliner.hasChildren, true);
  assert.deepEqual(
    airliner.children.map((c) => [c.key, c.value]),
    [
      ['A320', 2],
      ['B738', 1],
    ],
  );
  assert.equal(airliner.children[0].share, 2 / 3);
  assert.deepEqual(boxOfRef(airliner.geo), [0, 0, 5, 5]);
  assert.equal(node.rest, null);
});

test('records source: a path goes in, limit and offset page with a rest', async () => {
  const source = planes();
  const inside = await source.node({
    address: 'count/aircraft://aircraft.class/aircraft.type',
    path: ['Airliner'],
  });
  assert.deepEqual(inside.path, [
    { key: 'Airliner', label: 'Airliner', grouping: 'aircraft.class' },
  ]);
  assert.deepEqual(inside.total, { value: 3, count: 3 });
  assert.equal(inside.children[0].hasChildren, false);
  const paged = await source.node({
    address: 'count/aircraft://aircraft.class',
    limit: 1,
    offset: 1,
  });
  assert.deepEqual(
    paged.children.map((c) => c.key),
    ['Helicopter'],
  );
  assert.deepEqual(paged.rest, { count: 1, value: 1 });
});

test('records source: cuts in any order, a refused first cut, and one it lacks further down stops there', async () => {
  const source = planes();
  const flipped = await source.node({
    address: 'count/aircraft://aircraft.type/aircraft.class',
  });
  assert.equal(flipped.children[0].key, 'A320');
  await assert.rejects(
    source.node({ address: 'count/aircraft://vessel.type' }),
    (error) => error instanceof TreemapError && error.code === 'refused',
  );
  const stopped = await source.node({
    address: 'count/aircraft://aircraft.class/aircraft.type/admin.country',
  });
  assert.equal(stopped.stops, 'admin.country');
  assert.equal(stopped.children.length, 3);
});

test('records source: a relative variable answers means, not shares (“not a sum”)', async () => {
  const source = createRecordSource({
    variables: [
      {
        id: 'm/altitude',
        mode: 'relative',
        records: () => [
          { cls: 'a', alt: 100 },
          { cls: 'a', alt: 300 },
          { cls: 'b', alt: 50 },
        ],
        value: (r) => r.alt,
        groupings: { 'aircraft.class': (r) => ({ key: r.cls, label: r.cls }) },
      },
    ],
  });
  const node = await source.node({ address: 'm/altitude://aircraft.class' });
  assert.equal(node.mode, 'relative');
  assert.deepEqual(
    node.children.map((c) => [c.key, c.value, c.share]),
    [
      ['a', 200, null],
      ['b', 50, null],
    ],
  );
});

test('service source: the contract’s GETs, and its failures sorted', async () => {
  const asked = [];
  const answers = {
    catalog: { status: 200, body: { schema: TREEMAP_SCHEMA, variables: [] } },
    node: { status: 400, body: { error: 'no such cut' } },
    geo: { status: 503, body: null },
  };
  const service = createServiceSource({
    base: '/api/treemap',
    fetchImpl: async (url) => {
      asked.push(url);
      const name = url.split('/').pop().split('?')[0];
      const { status, body } = answers[name];
      return {
        ok: status < 400,
        status,
        json: async () => {
          if (body === null) throw new Error('no body');
          return body;
        },
      };
    },
  });
  assert.equal((await service.catalog()).schema, TREEMAP_SCHEMA);
  await assert.rejects(
    service.node({
      address: 'm2/surface-area://admin.country',
      path: ['US', 'US-MD', 'a b'],
      depth: 2,
      limit: 200,
      offset: 0,
    }),
    (error) => error.code === 'refused' && error.message === 'no such cut',
  );
  await assert.rejects(
    service.geo('area:US'),
    (error) => error.code === 'failed',
  );
  assert.equal(asked[0], '/api/treemap/catalog');
  const node = new URL(asked[1], 'http://x');
  assert.equal(node.pathname, '/api/treemap/node');
  assert.equal(
    node.searchParams.get('address'),
    'm2/surface-area://admin.country',
  );
  assert.equal(node.searchParams.get('path'), 'US/US-MD/a b');
  assert.equal(node.searchParams.get('depth'), '2');
  assert.equal(node.searchParams.get('limit'), '200');
  assert.equal(node.searchParams.get('offset'), '0');
  const offline = createServiceSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(offline.catalog(), (error) => error.code === 'network');
  const absent = createServiceSource({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  await assert.rejects(absent.catalog(), (error) => error.code === 'absent');
});

test('window source: the service while it answers, else the sample; live variables always local', async () => {
  const sample = createSampleSource();
  const live = planes();
  const down = {
    catalog: async () => {
      throw new TreemapError('treemap 404', { code: 'absent', status: 404 });
    },
    node: async () => assert.fail('not asked while down'),
  };
  const window = createWindowSource({
    service: down,
    fallback: sample,
    local: live,
  });
  assert.equal(window.kind(), null);
  const catalog = await window.catalog();
  assert.equal(window.kind(), 'fallback');
  const ids = catalog.variables.map((v) => v.id);
  assert.ok(ids.includes('m2/surface-area'));
  assert.ok(ids.includes('count/aircraft'));
  assert.ok(catalog.groupings.some((g) => g.id === 'aircraft.type'));
  const air = await window.node({ address: 'count/aircraft://aircraft.class' });
  assert.equal(air.total.value, 5);

  const tables = [];
  const up = {
    catalog: async () => ({
      schema: TREEMAP_SCHEMA,
      variables: [{ id: 'm2/surface-area', available: true, groupings: [] }],
      groupings: [],
    }),
    node: async (request) => {
      tables.push(request.address);
      return { schema: TREEMAP_SCHEMA, children: [] };
    },
  };
  const served = createWindowSource({
    service: up,
    fallback: sample,
    local: live,
  });
  await served.catalog();
  assert.equal(served.kind(), 'service');
  await served.node({ address: 'm2/surface-area://admin.country' });
  await served.node({ address: 'count/aircraft://aircraft.class' });
  assert.deepEqual(tables, ['m2/surface-area://admin.country']);
});

test('the sample: the planet’s area by continent, oceans included, stopping before districts', async () => {
  const sample = createSampleSource();
  const node = await sample.node({ address: DEFAULT_TREEMAP_ADDRESS });
  assert.equal(node.exact, false);
  assert.equal(node.stops, 'admin.district');
  assert.ok(Math.abs(node.total.value / 1e6 - PLANET_KM2) < 1);
  const oceans = node.children.find((c) => c.key === 'ocean');
  assert.ok(oceans.share > 0.6 && oceans.share < 0.8, `${oceans.share}`);
  const asia = node.children.find((c) => c.key === 'asia');
  assert.ok(asia?.children?.length > 5);
  const usa = await sample.node({
    address: DEFAULT_TREEMAP_ADDRESS,
    path: ['north-america', 'US'],
  });
  assert.equal(usa.path.at(-1).label, 'United States');
  assert.ok(usa.children.length > 0);
  const people = await sample.node({
    address: 'count/people://admin.continent/admin.country',
  });
  assert.ok(people.total.value > 6e9, `${people.total.value}`);
  assert.equal(await sample.geo('area:US'), null);
  assert.deepEqual(
    (await sample.geo(refOfBox([1, 2, 3, 4]))).type,
    boxGeoJson([1, 2, 3, 4]).type,
  );
});

test('store: in and out, a new address goes to its root, the share param round-trips', () => {
  const store = createTreemapStore({ initial: null });
  assert.equal(store.get().address, DEFAULT_TREEMAP_ADDRESS);
  assert.equal(store.param(), '', 'the default at its root is left out');
  const seen = [];
  store.subscribe((state) => seen.push(state.path.join('>')));
  store.enter('NA');
  store.enter('US');
  assert.deepEqual(store.get().path, ['NA', 'US']);
  assert.equal(store.param(), `${DEFAULT_TREEMAP_ADDRESS}|NA/US`);
  assert.deepEqual(decodeTreemapParam(store.param()), {
    address: DEFAULT_TREEMAP_ADDRESS,
    path: ['NA', 'US'],
  });
  store.up(1);
  assert.deepEqual(store.get().path, ['NA']);
  store.up(0);
  assert.deepEqual(store.get().path, []);
  assert.equal(store.setAddress('nonsense'), false);
  store.enter('EU');
  store.setAddress('count/people://admin.continent/admin.country', {
    keepPath: true,
  });
  assert.deepEqual(store.get().path, ['EU']);
  store.setAddress('count/people://admin.country');
  assert.deepEqual(store.get().path, []);
  assert.deepEqual(seen, ['NA', 'NA>US', 'NA', '', 'EU', 'EU', '']);
  assert.equal(
    encodeTreemapParam({ address: 'count/people://admin.country', path: [] }),
    'count/people://admin.country',
  );
  // A path longer than the address is cut to it; a bad value is none.
  assert.deepEqual(
    decodeTreemapParam('count/people://admin.country|a/b/c').path,
    ['a'],
  );
  assert.equal(decodeTreemapParam('garbage'), null);
  assert.equal(decodeTreemapParam(''), null);
});
