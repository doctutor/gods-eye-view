// Personal fork: the treemap tables (table.js) and their areas
// (geodesy.js): a node of any address over a table's dimensions.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_AREA_M2,
  lonLatRingArea,
  mercatorPolygonsArea,
  mercatorRingArea,
} from './geodesy.js';
import {
  INNER_LIMIT,
  OCEAN_KEY,
  REST_KEY,
  TABLE_ERRORS,
  encodeTable,
  openTable,
} from './table.js';

const DIMS = [
  'admin.continent',
  'admin.country',
  'admin.region',
  'locality.kind',
];
const row = (keys, value, count = 1) => ({ keys, value, count });
const fixture = () =>
  openTable(
    JSON.parse(
      JSON.stringify(
        encodeTable({
          variable: 'count/people',
          dims: DIMS,
          rows: [
            row(['europe', 'FR', 'FR-IDF', 'city'], 60),
            row(['europe', 'FR', 'FR-IDF', 'town'], 10, 4),
            row(['europe', 'FR', 'FR-NAQ', 'city'], 20),
            row(['europe', 'FR', REST_KEY, 'village'], 5, 9),
            row(['europe', 'MC', REST_KEY, 'city'], 1),
            row(['asia', 'JP', 'JP-13', 'city'], 100),
            row(['asia', 'JP', 'JP-13', 'town'], 4),
            row([OCEAN_KEY, OCEAN_KEY, OCEAN_KEY, OCEAN_KEY], 0.5, 0),
          ],
          labels: {
            'admin.country': { FR: 'France', JP: 'Japan' },
            'admin.region': { [REST_KEY]: 'No region' },
          },
          geo: { 'admin.country': { FR: 'area:fr' } },
          exact: false,
          note: 'A note.',
          attribution: 'Someone',
        }),
      ),
    ),
  );

test('a node: its total, children by value with their shares, labels and outlines', () => {
  const table = fixture();
  const root = table.node({ groupings: DIMS });
  assert.deepEqual(root.total, { value: 200.5, count: 18 });
  assert.deepEqual(
    root.children.map((c) => [c.key, c.value, c.count, c.hasChildren]),
    [
      ['asia', 104, 2, true],
      ['europe', 96, 16, true],
      [OCEAN_KEY, 0.5, 0, false],
    ],
  );
  assert.equal(root.children[0].share, Math.round((104 / 200.5) * 1e6) / 1e6);
  assert.deepEqual(root.path, []);
  assert.deepEqual(root.level, { grouping: 'admin.continent' });
  assert.equal(root.rest, null);

  const europe = table.node({ groupings: DIMS, path: ['europe'] });
  assert.deepEqual(
    europe.children.map((c) => [c.key, c.label, c.value, c.geo]),
    [
      ['FR', 'France', 95, 'area:fr'],
      ['MC', 'MC', 1, undefined],
    ],
  );
  // Monaco has no region: its only child would be the remainder.
  assert.equal(europe.children[1].hasChildren, false);
  const france = table.node({ groupings: DIMS, path: ['europe', 'FR'] });
  assert.deepEqual(
    france.children.map((c) => [c.key, c.label, c.value]),
    [
      ['FR-IDF', 'FR-IDF', 70],
      ['FR-NAQ', 'FR-NAQ', 20],
      [REST_KEY, 'No region', 5],
    ],
  );
  assert.deepEqual(france.path, [
    { key: 'europe', label: 'europe', grouping: 'admin.continent' },
    { key: 'FR', label: 'France', grouping: 'admin.country' },
  ]);
  // The table's note and attribution travel with it.
  assert.equal(table.exact, false);
  assert.equal(table.note, 'A note.');
  assert.equal(table.attribution, 'Someone');
});

test('depth 2, limit, offset and the rest', () => {
  const table = fixture();
  const two = table.node({ groupings: DIMS, depth: 2 });
  assert.deepEqual(
    two.children[1].children.map((c) => [c.key, c.value]),
    [
      ['FR', 95],
      ['MC', 1],
    ],
  );
  assert.equal(two.children[1].rest, null);
  assert.equal(two.children[2].children, undefined);
  const first = table.node({
    groupings: ['admin.region'],
    limit: 2,
  });
  assert.deepEqual(
    first.children.map((c) => c.key),
    ['JP-13', 'FR-IDF'],
  );
  assert.deepEqual(first.rest, { count: 3, value: 26.5 });
  const next = table.node({ groupings: ['admin.region'], limit: 2, offset: 2 });
  assert.deepEqual(
    next.children.map((c) => c.key),
    ['FR-NAQ', REST_KEY],
  );
  assert.deepEqual(next.rest, { count: 1, value: 0.5 });
  assert.ok(INNER_LIMIT >= 1);
});

test('any order of the dimensions answers: an overlay first, then a hierarchy', () => {
  const table = fixture();
  const kinds = table.node({ groupings: ['locality.kind', 'admin.country'] });
  assert.deepEqual(
    kinds.children.map((c) => [c.key, c.value]),
    [
      ['city', 181],
      ['town', 14],
      ['village', 5],
      [OCEAN_KEY, 0.5],
    ],
  );
  const cities = table.node({
    groupings: ['locality.kind', 'admin.country'],
    path: ['city'],
  });
  assert.deepEqual(
    cities.children.map((c) => [c.key, c.value]),
    [
      ['JP', 100],
      ['FR', 80],
      ['MC', 1],
    ],
  );
  const crossed = table.node({
    groupings: ['admin.country', 'locality.kind'],
    path: ['FR'],
  });
  assert.equal(crossed.total.value, 95);
  assert.equal(crossed.level.grouping, 'locality.kind');
});

test('what a table cannot answer says why', () => {
  const table = fixture();
  const cut = table.node({ groupings: ['place.category'] });
  assert.equal(cut.template, TABLE_ERRORS.unsupported);
  assert.equal(cut.error, 'count/people cannot be cut by place.category');
  const deep = table.node({ groupings: ['admin.country'], path: ['FR'] });
  assert.equal(deep.template, TABLE_ERRORS.deep);
  const missing = table.node({ groupings: DIMS, path: ['europe', 'XX'] });
  assert.equal(missing.error, 'There is no "XX" in admin.country here');
  // A key that exists but not under this path.
  const elsewhere = table.node({ groupings: DIMS, path: ['asia', 'FR'] });
  assert.equal(elsewhere.error, 'There is no "FR" in admin.country here');
  assert.throws(
    () =>
      encodeTable({
        variable: 'x/y',
        dims: ['a.b'],
        rows: [row(['a/b'], 1)],
        attribution: '',
      }),
    /holds "\/"/,
  );
});

test('areas on the ellipsoid: a degree square, the same box in Mercator, and the whole Earth', () => {
  // A 1° square at the equator: 12,308 km² on WGS84.
  const square = lonLatRingArea([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  assert.ok(Math.abs(square / 1e6 - 12308) < 5, String(square / 1e6));
  const x = (lon) => (lon + 180) / 360;
  const y = (lat) =>
    (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const mercator = [x(0), y(0), x(1), y(0), x(1), y(1), x(0), y(1)];
  assert.ok(Math.abs(mercatorRingArea(mercator) - square) < 1e3);
  // A hole comes off its polygon; a scale divides quantized points.
  const scale = 2 ** 24;
  const quantized = mercator.map((v) => Math.round(v * scale));
  const hole = [
    x(0.25),
    y(0.25),
    x(0.75),
    y(0.25),
    x(0.75),
    y(0.75),
    x(0.25),
    y(0.75),
  ];
  const holed = mercatorPolygonsArea(
    [[quantized, hole.map((v) => Math.round(v * scale))]],
    scale,
  );
  assert.ok(Math.abs(holed / square - 0.75) < 0.001, String(holed / square));
  assert.ok(Math.abs(EARTH_AREA_M2 / 1e6 - 510065622) < 1);
  // Across the antimeridian a lon/lat ring takes the short way.
  const across = lonLatRingArea([
    [179.5, 0],
    [-179.5, 0],
    [-179.5, 1],
    [179.5, 1],
  ]);
  assert.ok(Math.abs(across - square) < 1e3);
});

test('a product table carries its base: each tile and the total its base and mean, value over base', () => {
  const table = openTable(
    JSON.parse(
      JSON.stringify(
        encodeTable({
          variable: 'm3/land-volume',
          dims: ['admin.continent', 'admin.country'],
          rows: [
            { keys: ['asia', 'NP'], value: 3000 * 10, count: 0, base: 10 },
            { keys: ['asia', 'BD'], value: 10 * 50, count: 0, base: 50 },
            { keys: ['europe', 'NL'], value: 0, count: 0, base: 4 },
          ],
          base: {
            label: 'land area',
            unit: 'm2',
            intensive: 'mean elevation',
            intensiveUnit: 'm',
          },
          attribution: '',
        }),
      ),
    ),
  );
  const asia = table.node({
    groupings: ['admin.continent', 'admin.country'],
    path: ['asia'],
  });
  assert.deepEqual(
    asia.children.map((c) => [c.key, c.value, c.base, c.mean]),
    [
      ['NP', 30000, 10, 3000],
      ['BD', 500, 50, 10],
    ],
  );
  assert.deepEqual(asia.total, {
    value: 30500,
    count: 0,
    base: 60,
    mean: Math.round((30500 / 60) * 10) / 10,
  });
  const root = table.node({ groupings: ['admin.continent'] });
  assert.equal(root.children.find((c) => c.key === 'europe').mean, 0);
  // A table without a base has neither field.
  const plain = fixture().node({ groupings: DIMS });
  assert.deepEqual(Object.keys(plain.total), ['value', 'count']);
  assert.equal(plain.children[0].base, undefined);
  assert.equal(plain.children[0].mean, undefined);
});
