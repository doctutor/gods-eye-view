// Personal fork: the treemap window's address bar state (treemapAddressBar.js)
// and its panel's registration in the rail, share link and layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  removeGrouping,
  moveGrouping,
  addGrouping,
  toggleJoin,
  addableGroupings,
  variableEntries,
} from './treemapAddressBar.js';
import { formatValue, formatShare, tileColour, hueOf } from './treemapPanel.js';
import { TREEMAP_CATALOG_PLAN } from '../data/treemapCatalogPlan.js';
import { parseAddress } from '../data/treemapWindowAddress.js';

const A = 'm2/surface-area://admin.continent/admin.country/admin.region';

test('pills: remove, reorder, add (/ within or × overlay), and flip a join', () => {
  assert.equal(
    removeGrouping(A, 1),
    'm2/surface-area://admin.continent/admin.region',
  );
  assert.equal(removeGrouping(A, 9), A);
  assert.equal(
    moveGrouping(A, 2, 0),
    'm2/surface-area://admin.region/admin.continent/admin.country',
  );
  assert.equal(moveGrouping(A, 0, 5), A);
  assert.equal(addGrouping(A, 'landcover.class', '*'), `${A}*landcover.class`);
  assert.equal(addGrouping(A, 'landcover.class'), `${A}/landcover.class`);
  assert.equal(addGrouping(A, 'admin.country'), A, 'no cut twice');
  assert.equal(
    toggleJoin(A, 2),
    'm2/surface-area://admin.continent/admin.country*admin.region',
  );
  assert.equal(toggleJoin(toggleJoin(A, 2), 2), A);
  assert.equal(toggleJoin(A, 0), A, 'the first cut has no join');
  // Every result still parses.
  for (const address of [
    removeGrouping(A, 0),
    moveGrouping(A, 1, 2),
    toggleJoin(A, 1),
  ])
    assert.ok(parseAddress(address));
});

test('add menu offers the cuts the variable takes that are not in use', () => {
  const catalog = {
    variables: [
      {
        id: 'm2/surface-area',
        groupings: [
          'admin.continent',
          'admin.country',
          'admin.region',
          'landcover.class',
        ],
      },
    ],
  };
  assert.deepEqual(addableGroupings(A, catalog), ['landcover.class']);
  assert.deepEqual(addableGroupings('x/y://a.b', catalog), []);
});

test('quantity menu: grouped quantity › unit, filtered as typed, unbuilt variables disabled with the reason', () => {
  const catalog = {
    variables: [
      { id: 'm2/surface-area', available: true, groupings: [] },
      {
        id: 'count/people',
        available: false,
        why: 'Waiting on the population table',
        groupings: [],
      },
    ],
  };
  const groups = variableEntries(TREEMAP_CATALOG_PLAN, catalog);
  const rows = groups.flatMap((group) => group.variables);
  assert.equal(rows.length, TREEMAP_CATALOG_PLAN.length);
  const area = rows.find((row) => row.id === 'm2/surface-area');
  assert.equal(area.available, true);
  const people = rows.find((row) => row.id === 'count/people');
  assert.equal(people.available, false);
  assert.equal(people.why, 'Waiting on the population table');
  const unbuilt = rows.find((row) => row.id === 'byte/wikipedia-text');
  assert.equal(unbuilt?.available, false);
  assert.equal(unbuilt.why, 'Not built yet');
  for (const group of groups)
    for (const row of group.variables) {
      assert.equal(row.quantity, group.quantity);
      assert.equal(row.unit, group.unit);
    }
  const filtered = variableEntries(TREEMAP_CATALOG_PLAN, catalog, 'PEOPLE');
  assert.deepEqual(
    filtered.flatMap((group) => group.variables.map((row) => row.id)),
    ['count/people'],
  );
  // A variable the service has that the plan does not still shows.
  const extra = variableEntries(TREEMAP_CATALOG_PLAN, {
    variables: [{ id: 'count/ships', available: true, groupings: [] }],
  });
  assert.ok(
    extra.some((group) =>
      group.variables.some((row) => row.id === 'count/ships'),
    ),
  );
});

test('every plan sequence is an address on its own variable', () => {
  for (const entry of TREEMAP_CATALOG_PLAN)
    for (const sequence of entry.sequences) {
      const parsed = parseAddress(sequence.address);
      assert.ok(parsed, sequence.address);
      assert.equal(parsed.variable, entry.id);
      assert.ok(sequence.reveals);
    }
});

test('values with a scaled unit; shares; a colour stable as the cut changes', () => {
  assert.equal(formatValue(148_940_000e6, 'm2'), '149 million km²');
  assert.equal(formatValue(2_500, 'm2'), '2,500 m²');
  assert.equal(formatValue(1.4e9, 'count'), '1.4 billion');
  assert.equal(formatValue(3e9, 'byte'), '3 GB');
  assert.equal(formatShare(0.2345), '23%');
  assert.equal(formatShare(0.004), '0.4%');
  // Colour follows the first cut's member: a child keeps its parent's hue,
  // and inside that member (the path's first key) every tile has it.
  const asia = { depth: 1, node: { key: 'AS' } };
  const china = { depth: 2, node: { key: 'CN' }, parent: asia };
  assert.equal(
    tileColour(china, []).match(/hsl\((\d+)/)[1],
    tileColour(asia, []).match(/hsl\((\d+)/)[1],
  );
  const inside = { depth: 1, node: { key: 'CN' } };
  assert.equal(
    tileColour(inside, ['AS']).match(/hsl\((\d+)/)[1],
    tileColour(asia, []).match(/hsl\((\d+)/)[1],
  );
  assert.equal(hueOf('AS'), hueOf('AS'));
  // The "…" tile is grey whatever it holds.
  assert.match(
    tileColour({ depth: 1, more: true, node: { key: 'x' } }, []),
    /^hsl\(210 10%/,
  );
});

test('the TREEMAP panel sits in the right rail with the others, share-linked and laid out', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const template = read('./templates/context.html');
  const panel = template.indexOf('id="treemap-panel"');
  assert.ok(panel > 0);
  assert.ok(panel < template.indexOf('id="global-context-panel"'));
  assert.match(template, /data-collapse-target="treemap-panel"/);
  assert.match(template, /id="treemap-popout-btn"/);
  const chrome = read('./panelChrome.js');
  assert.match(chrome, /\{ id: 'treemap-panel' \}/);
  const layout = read('./panelLayoutController.js');
  assert.match(layout, /getElementById\('treemap-panel'\)/);
  const position = read('./panelPositionControls.js');
  assert.match(position, /popOutPanel\(/);
  const share = read('../sharelink.js');
  assert.match(share, /id: 'treemap-panel', token: 'k'/);
  assert.match(share, /TREEMAP_PARAM/);
  const css = read('./styles/layers.css');
  assert.match(
    css,
    /#right-context-rail > #treemap-panel:not\(\.panel-floating\)/,
  );
  // The token is not taken by another panel.
  const tokens = [...share.matchAll(/\{ id: '[^']+', token: '([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.equal(new Set(tokens).size, tokens.length);
});
