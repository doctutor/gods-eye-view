// Personal fork: the treemap address (src/data/treemapAddress.js): read,
// write, and the errors that say what is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TREEMAP_ADDRESS_ERRORS,
  formatTreemapAddress,
  parseTreemapAddress,
  treemapAddressErrorText,
  treemapGroupingParts,
} from './treemapAddress.js';

test("the plan's addresses read into a variable, its groupings and their joins", () => {
  assert.deepEqual(
    parseTreemapAddress(
      'm2/surface-area://admin.continent/admin.country/admin.region/admin.district',
    ),
    {
      ok: true,
      variable: 'm2/surface-area',
      unit: 'm2',
      name: 'surface-area',
      groupings: [
        'admin.continent',
        'admin.country',
        'admin.region',
        'admin.district',
      ],
      joins: ['/', '/', '/'],
    },
  );
  const overlay = parseTreemapAddress(
    'm2/surface-area://admin.country*landcover.class',
  );
  assert.deepEqual(overlay.groupings, ['admin.country', 'landcover.class']);
  assert.deepEqual(overlay.joins, ['*']);
  // The window shows * as ×; a pasted × reads as *. Spaces are ignored.
  assert.deepEqual(
    parseTreemapAddress(' count/people:// admin.country × locality.kind ')
      .joins,
    ['*'],
  );
  assert.deepEqual(parseTreemapAddress('count/places://h3.4').groupings, [
    'h3.4',
  ]);
  assert.deepEqual(parseTreemapAddress('count/places://h3.4').joins, []);
});

test('an address written from its parts reads back the same', () => {
  const parts = {
    variable: 'count/places',
    groupings: ['place.category', 'admin.country', 'admin.region'],
    joins: ['/', '*'],
  };
  const text = formatTreemapAddress(parts);
  assert.equal(
    text,
    'count/places://place.category/admin.country*admin.region',
  );
  const back = parseTreemapAddress(text);
  assert.deepEqual(
    { variable: back.variable, groupings: back.groupings, joins: back.joins },
    parts,
  );
  // Joins default to /.
  assert.equal(
    formatTreemapAddress({
      variable: 'm2/surface-area',
      groupings: ['admin.continent', 'admin.country'],
    }),
    'm2/surface-area://admin.continent/admin.country',
  );
  assert.throws(
    () => formatTreemapAddress({ variable: 'm2/surface-area', groupings: [] }),
    /names no grouping/,
  );
  assert.throws(
    () =>
      formatTreemapAddress({
        variable: 'm2/surface-area',
        groupings: ['Admin'],
      }),
    /"Admin" is not family\.level/,
  );
});

test('each malformed address names what is wrong', () => {
  const cases = [
    [undefined, 'empty', {}],
    ['   ', 'empty', {}],
    ['m2/surface-area/admin.country', 'scheme', {}],
    ['m2/surface-area://admin.country://admin.region', 'schemeTwice', {}],
    ['surface-area://admin.country', 'variable', {}],
    ['/surface-area://admin.country', 'variable', {}],
    ['m2/://admin.country', 'variable', {}],
    ['m2/surface/area://admin.country', 'variable', {}],
    ['M²/surface-area://admin.country', 'unit', { unit: 'M²' }],
    ['m2/Surface_Area://admin.country', 'name', { name: 'Surface_Area' }],
    ['m2/surface-area://', 'noGrouping', {}],
    [
      'm2/surface-area://admin.country//admin.region',
      'emptyGrouping',
      { index: 2 },
    ],
    ['m2/surface-area://admin.country/', 'emptyGrouping', { index: 2 }],
    ['m2/surface-area://*admin.country', 'emptyGrouping', { index: 1 }],
    ['m2/surface-area://admin', 'grouping', { grouping: 'admin' }],
    [
      'm2/surface-area://admin.Country',
      'grouping',
      { grouping: 'admin.Country' },
    ],
    [
      'm2/surface-area://admin.country/admin.country',
      'repeated',
      { grouping: 'admin.country' },
    ],
  ];
  for (const [text, key, values] of cases) {
    const parsed = parseTreemapAddress(text);
    assert.equal(parsed.ok, false, String(text));
    assert.equal(parsed.error, TREEMAP_ADDRESS_ERRORS[key], String(text));
    assert.deepEqual(parsed.values, values, String(text));
  }
  assert.equal(
    treemapAddressErrorText(
      parseTreemapAddress('m2/surface-area://admin.country//x.y'),
    ),
    'Grouping 2 is empty: two joins in a row, or one at an end',
  );
  assert.equal(
    treemapAddressErrorText(parseTreemapAddress('m2/x://admin')),
    'The grouping "admin" is not family.level, like admin.country',
  );
});

test('a grouping id splits into its family and level', () => {
  assert.deepEqual(treemapGroupingParts('admin.country'), {
    family: 'admin',
    level: 'country',
  });
  assert.deepEqual(treemapGroupingParts('h3.4'), { family: 'h3', level: '4' });
  assert.deepEqual(treemapGroupingParts('admin'), {
    family: 'admin',
    level: '',
  });
});
