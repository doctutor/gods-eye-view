// Personal fork: the treemap catalogue (src/data/treemapCatalog.js): the
// plan's first set as data, every sequence answerable by the catalogue,
// and the groupings' hierarchies whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TREEMAP_CATALOG_ERRORS,
  TREEMAP_GROUPINGS,
  TREEMAP_MODES,
  TREEMAP_NEEDS,
  TREEMAP_QUANTITIES,
  TREEMAP_UNITS,
  TREEMAP_VARIABLES,
  checkTreemapAddress,
  treemapGrouping,
  treemapVariable,
} from './treemapCatalog.js';
import { TREEMAP_ADDRESS_ERRORS } from './treemapAddress.js';

test("the first set is the plan's table: its variables in order, their modes and first sequences", () => {
  assert.deepEqual(
    TREEMAP_VARIABLES.map((v) => [v.id, v.mode]),
    [
      ['m2/surface-area', 'additive'],
      ['count/people', 'additive'],
      ['count/places', 'additive'],
      ['count/buildings', 'additive'],
      ['m2/building-footprint', 'additive'],
      ['m3/building-volume', 'additive'],
      ['count/wikipedia-articles', 'additive'],
      ['byte/wikipedia-text', 'additive'],
      ['m2/polity-area', 'additive'],
      ['count/aircraft', 'additive'],
      ['count/vessels', 'additive'],
      ['m3/land-volume', 'product'],
    ],
  );
  const first = (id) => treemapVariable(id).sequences.map((s) => s.address);
  assert.deepEqual(first('m2/surface-area'), [
    'm2/surface-area://admin.continent/admin.country/admin.region/admin.district',
    'm2/surface-area://admin.country*landcover.class',
  ]);
  assert.deepEqual(first('count/people'), [
    'count/people://admin.continent/admin.country/admin.region/locality.place',
    'count/people://admin.country*locality.kind',
  ]);
  assert.deepEqual(first('count/places'), [
    'count/places://place.category/admin.country/admin.region',
    'count/places://admin.country/place.category',
  ]);
  for (const id of [
    'count/buildings',
    'm2/building-footprint',
    'm3/building-volume',
  ])
    assert.deepEqual(first(id), [
      `${id}://admin.continent/admin.country/admin.region`,
    ]);
  assert.deepEqual(first('count/wikipedia-articles'), [
    'count/wikipedia-articles://wikipedia.language/admin.country',
    'count/wikipedia-articles://admin.country/wikipedia.class',
  ]);
  assert.deepEqual(first('m2/polity-area'), [
    'm2/polity-area://history.period/history.polity',
  ]);
  assert.deepEqual(first('count/aircraft'), [
    'count/aircraft://aircraft.class/aircraft.type',
    'count/aircraft://admin.country/aircraft.class',
  ]);
  assert.deepEqual(first('count/vessels'), [
    'count/vessels://vessel.family/vessel.type',
  ]);
  assert.deepEqual(first('m3/land-volume'), [
    'm3/land-volume://admin.continent/admin.country',
  ]);
  // Nothing waits on a build any more: phase 2 and the label endpoint
  // are built.
  const needs = TREEMAP_VARIABLES.flatMap((v) =>
    v.sequences.filter((s) => s.needs).map((s) => [s.address, s.needs]),
  );
  assert.deepEqual(needs, []);
});

test('every sequence reads, names its own variable, uses groupings that exist and the variable supports', () => {
  for (const variable of TREEMAP_VARIABLES) {
    assert.ok(variable.sequences.length > 0, variable.id);
    for (const sequence of variable.sequences) {
      const checked = checkTreemapAddress(sequence.address);
      assert.equal(checked.ok, true, `${sequence.address}: ${checked.error}`);
      assert.equal(checked.variable, variable.id);
      assert.equal(checked.definition, variable);
      for (const id of checked.groupings) assert.ok(treemapGrouping(id), id);
      assert.equal(typeof sequence.title, 'string');
      assert.ok(sequence.title.length > 0);
      assert.ok(/\.$/.test(sequence.reveals), sequence.reveals);
      if (sequence.needs)
        assert.ok(TREEMAP_NEEDS[sequence.needs], sequence.needs);
    }
  }
});

test('variables: unique ids, a known unit in its quantity, a known mode, groupings that exist', () => {
  const ids = TREEMAP_VARIABLES.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const variable of TREEMAP_VARIABLES) {
    assert.ok(TREEMAP_UNITS[variable.unit], variable.id);
    assert.equal(variable.id.split('/')[0], variable.unit);
    assert.equal(variable.quantity, TREEMAP_UNITS[variable.unit].quantity);
    const quantity = TREEMAP_QUANTITIES.find((q) => q.id === variable.quantity);
    assert.ok(quantity.units.includes(variable.unit), variable.id);
    assert.ok(
      Object.values(TREEMAP_MODES).includes(variable.mode),
      variable.id,
    );
    for (const id of variable.groupings) assert.ok(treemapGrouping(id), id);
    if (variable.firstGrouping)
      assert.ok(variable.groupings.includes(variable.firstGrouping));
    if (variable.mode === 'product') {
      assert.ok(variable.product.intensive);
      assert.ok(treemapVariable(variable.product.base), variable.product.base);
    }
    if (variable.source) assert.equal(variable.source, 'live');
  }
  // Every unit belongs to exactly the quantity that lists it.
  for (const [id, unit] of Object.entries(TREEMAP_UNITS)) {
    assert.equal(unit.id, id);
    assert.deepEqual(
      TREEMAP_QUANTITIES.filter((q) => q.units.includes(id)).map((q) => q.id),
      [unit.quantity],
    );
  }
});

test('groupings: family.level ids, hierarchies whose parents exist and end at a top, overlays without parents', () => {
  const ids = TREEMAP_GROUPINGS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const grouping of TREEMAP_GROUPINGS) {
    assert.equal(grouping.id, `${grouping.family}.${grouping.level}`);
    assert.ok(['hierarchy', 'overlay'].includes(grouping.kind), grouping.id);
    if (grouping.kind === 'overlay') assert.equal(grouping.parent, undefined);
    const seen = new Set();
    for (let at = grouping; at.parent; at = treemapGrouping(at.parent)) {
      assert.ok(treemapGrouping(at.parent), `${at.id} → ${at.parent}`);
      assert.equal(treemapGrouping(at.parent).kind, 'hierarchy');
      assert.ok(!seen.has(at.id), `a cycle through ${at.id}`);
      seen.add(at.id);
    }
  }
  assert.deepEqual(
    ['admin.district', 'admin.region', 'admin.country'].map(
      (id) => treemapGrouping(id).parent,
    ),
    ['admin.region', 'admin.country', 'admin.continent'],
  );
  assert.equal(treemapGrouping('history.polity').parent, 'history.period');
  assert.equal(treemapGrouping('nope.nope'), null);
});

test('checkTreemapAddress: unknown variables and groupings, a cut the variable does not support, a period first', () => {
  const failing = [
    ['m2/sea-area://admin.country', 'variable', { variable: 'm2/sea-area' }],
    [
      'm2/surface-area://admin.planet',
      'grouping',
      { grouping: 'admin.planet' },
    ],
    [
      'm2/surface-area://place.category',
      'unsupported',
      { variable: 'm2/surface-area', grouping: 'place.category' },
    ],
    [
      'm2/polity-area://history.polity/history.period',
      'first',
      { variable: 'm2/polity-area', grouping: 'history.period' },
    ],
  ];
  for (const [text, key, values] of failing) {
    const checked = checkTreemapAddress(text);
    assert.equal(checked.ok, false, text);
    assert.equal(checked.error, TREEMAP_CATALOG_ERRORS[key], text);
    assert.deepEqual(checked.values, values, text);
  }
  // A syntax error is the address's own.
  assert.equal(
    checkTreemapAddress('m2/surface-area').error,
    TREEMAP_ADDRESS_ERRORS.scheme,
  );
});
