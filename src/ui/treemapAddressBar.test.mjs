// Personal fork: the treemap window's address bar state (treemapAddressBar.js),
// its colours, and its panel's registration in the rail, share link and
// layout.

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
  sequenceEntries,
  readAddressText,
  addressText,
  cutsText,
} from './treemapAddressBar.js';
import {
  formatValue,
  formatShare,
  tileColour,
  hueOf,
  SIBLING_HUE_SPREAD,
} from './treemapPanel.js';
import { TREEMAP_VARIABLES } from '../data/treemapCatalog.js';
import { parseTreemapAddress } from '../data/treemapAddress.js';

const A = 'm2/surface-area://admin.continent/admin.country/admin.region';

test('pills: remove, reorder, add (/ within or × overlay), and flip a join', () => {
  assert.equal(
    removeGrouping(A, 1),
    'm2/surface-area://admin.continent/admin.region',
  );
  assert.equal(removeGrouping(A, 9), A);
  assert.equal(
    removeGrouping('m2/surface-area://admin.continent', 0),
    'm2/surface-area://admin.continent',
    'the last cut stays',
  );
  // The join goes with the cut it joined.
  const overlay = 'm2/surface-area://admin.country*landcover.class';
  assert.equal(
    removeGrouping(`${overlay}/admin.region`, 1),
    'm2/surface-area://admin.country/admin.region',
  );
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
  for (const address of [
    removeGrouping(A, 0),
    moveGrouping(A, 1, 2),
    toggleJoin(A, 1),
  ])
    assert.ok(parseTreemapAddress(address).ok);
});

test('the address as text: × shown for *, Enter reads it, a bad one says why', () => {
  const overlay = 'm2/surface-area://admin.country*landcover.class';
  assert.equal(
    addressText(overlay),
    'm2/surface-area://admin.country × landcover.class',
  );
  // What the bar shows reads back as the same address.
  assert.deepEqual(readAddressText(addressText(overlay)), {
    ok: true,
    address: overlay,
  });
  assert.equal(
    readAddressText(' m2/surface-area:// admin.continent / admin.country ')
      .address,
    'm2/surface-area://admin.continent/admin.country',
  );
  const noScheme = readAddressText('m2/surface-area admin.country');
  assert.equal(noScheme.ok, false);
  assert.match(noScheme.message, /:\/\//);
  const twice = readAddressText(
    'm2/surface-area://admin.country/admin.country',
  );
  assert.equal(twice.ok, false);
  assert.match(twice.message, /appears twice/);
  const unknown = readAddressText('m2/nothing://admin.country');
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /no variable/);
  const notTaken = readAddressText('m2/surface-area://vessel.type');
  assert.equal(notTaken.ok, false);
  assert.match(notTaken.message, /cannot be cut by vessel\.type/);
  // The service's catalogue says what a variable takes when it lists it.
  const served = {
    variables: [
      { id: 'count/people', available: true, groupings: ['admin.country'] },
    ],
  };
  assert.equal(
    readAddressText('count/people://admin.country', served).ok,
    true,
  );
  assert.equal(
    readAddressText('count/people://admin.region', served).ok,
    false,
  );
  assert.equal(cutsText(overlay), 'Country × Land cover');
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
  // With no service catalogue, the shared catalogue's list.
  assert.ok(addableGroupings(A, null).includes('admin.district'));
  assert.deepEqual(addableGroupings('not an address', catalog), []);
});

test('quantity menu: grouped quantity › unit, filtered as typed, every unavailable variable dimmed with its reason', () => {
  const catalog = {
    variables: [
      { id: 'm2/surface-area', available: true, groupings: [] },
      {
        id: 'count/people',
        available: false,
        why: 'Waiting on the population table',
        groupings: [],
      },
      { id: 'count/places', available: false, groupings: [] },
    ],
  };
  const groups = variableEntries(catalog);
  const rows = groups.flatMap((group) => group.variables);
  assert.equal(rows.length, TREEMAP_VARIABLES.length);
  assert.equal(rows.find((r) => r.id === 'm2/surface-area').available, true);
  const people = rows.find((row) => row.id === 'count/people');
  assert.equal(people.available, false);
  assert.equal(people.why, 'Waiting on the population table');
  // Unavailable with no reason given, or not listed at all: not built.
  for (const id of ['count/places', 'byte/wikipedia-text', 'count/buildings']) {
    const row = rows.find((r) => r.id === id);
    assert.equal(row.available, false, id);
    assert.equal(row.why, 'Not built yet', id);
  }
  for (const group of groups)
    for (const row of group.variables) {
      assert.equal(row.quantity, group.quantity);
      assert.equal(row.unit, group.unit);
    }
  const filtered = variableEntries(catalog, 'PEOPLE');
  assert.deepEqual(
    filtered.flatMap((group) => group.variables.map((row) => row.id)),
    ['count/people'],
  );
  assert.ok(
    variableEntries(catalog, 'm²')
      .flatMap((group) => group.variables)
      .every((row) => row.id.startsWith('m2/')),
  );
  const extra = variableEntries({
    variables: [{ id: 'count/ships', available: true, groupings: [] }],
  });
  assert.ok(
    extra.some((group) =>
      group.variables.some((row) => row.id === 'count/ships' && row.available),
    ),
  );
});

test('sequence menu: the catalogue’s order with titles, filtered as typed, waiting ones disabled', () => {
  const catalog = {
    variables: [
      {
        id: 'm2/surface-area',
        available: true,
        groupings: ['admin.continent', 'admin.country', 'admin.region'],
      },
    ],
  };
  const all = sequenceEntries('m2/surface-area', catalog);
  assert.equal(all.length, 2);
  assert.equal(all[0].why, '', 'a deeper cut not built only stops the view');
  assert.ok(all[0].title && all[0].reveals);
  assert.match(all[1].why, /^Waits on /);
  const filtered = sequenceEntries('m2/surface-area', catalog, 'land cover');
  assert.deepEqual(
    filtered.map((entry) => entry.address),
    ['m2/surface-area://admin.country*landcover.class'],
  );
  assert.deepEqual(sequenceEntries('m2/surface-area', catalog, 'zzz'), []);
  for (const variable of TREEMAP_VARIABLES)
    for (const sequence of variable.sequences) {
      const parsed = parseTreemapAddress(sequence.address);
      assert.ok(parsed.ok, sequence.address);
      assert.equal(parsed.variable, variable.id);
    }
});

test('values with a scaled unit; shares', () => {
  assert.equal(formatValue(148_940_000e6, 'm2'), '149 million km²');
  assert.equal(formatValue(2_500, 'm2'), '2,500 m²');
  assert.equal(formatValue(1.4e9, 'count'), '1.4 billion');
  assert.equal(formatValue(3e9, 'byte'), '3 GB');
  assert.equal(formatShare(0.2345), '23%');
  assert.equal(formatShare(0.004), '0.4%');
});

const hsl = (text) =>
  text
    .match(/hsl\((\d+) (\d+)% (\d+)%\)/)
    .slice(1)
    .map(Number);
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test('colour: the first cut’s member sets the family, siblings inside it part at a glance, stable per key', () => {
  const asia = { depth: 1, node: { key: 'asia' } };
  const china = { depth: 2, node: { key: 'CN' }, parent: asia };
  // At the root a continent and its countries share its family.
  assert.equal(hsl(tileColour(asia, []))[0], hueOf('asia'));
  assert.ok(hueGap(hsl(tileColour(china, []))[0], hueOf('asia')) <= 12);
  // Inside Asia the countries (ranked by size) fan out about Asia's hue.
  const keys = ['CN', 'IN', 'KZ', 'SA', 'IR', 'MN', 'PK', 'TR', 'MM', 'AF'];
  const shades = keys.map((key, rank) =>
    hsl(tileColour({ depth: 1, rank, node: { key } }, ['asia'])),
  );
  for (const [hue] of shades)
    assert.ok(hueGap(hue, hueOf('asia')) <= SIBLING_HUE_SPREAD);
  // Neighbours in size (side by side in squarify) part clearly...
  for (let i = 0; i + 1 < shades.length; i++)
    assert.ok(
      hueGap(shades[i][0], shades[i + 1][0]) >= 20,
      `${keys[i]} and ${keys[i + 1]} look alike`,
    );
  // ...and no two siblings are alike: hue or lightness apart.
  for (let i = 0; i < shades.length; i++)
    for (let j = i + 1; j < shades.length; j++)
      assert.ok(
        hueGap(shades[i][0], shades[j][0]) >= 3 ||
          Math.abs(shades[i][2] - shades[j][2]) >= 4,
        `${keys[i]} and ${keys[j]} look alike`,
      );
  // Stable: the same tile, the same colour, every draw.
  assert.equal(
    tileColour({ depth: 1, rank: 1, node: { key: 'IN' } }, ['asia']),
    tileColour({ depth: 1, rank: 1, node: { key: 'IN' } }, ['asia']),
  );
  // A child stays near its parent's hue.
  const india = { depth: 1, rank: 1, node: { key: 'IN' } };
  const maharashtra = {
    depth: 2,
    rank: 2,
    node: { key: 'IN-MH' },
    parent: india,
  };
  assert.ok(
    hueGap(
      hsl(tileColour(maharashtra, ['asia']))[0],
      hsl(tileColour(india, ['asia']))[0],
    ) <= 8,
  );
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
  assert.match(share, /id: 'treemap-panel', token: 'tm'/);
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

test('time cuts: periods draw in order with a gradient from early to late', async () => {
  const { isOrderedGrouping, orderHue } = await import('./treemapPanel.js');
  assert.equal(isOrderedGrouping('history.period'), true);
  assert.equal(isOrderedGrouping('time.year'), true);
  assert.equal(isOrderedGrouping('history.polity'), false);
  assert.equal(isOrderedGrouping('admin.country'), false);
  const early = { depth: 1, order: 0, node: { key: '-3000' } };
  const late = { depth: 1, order: 1, node: { key: '2000' } };
  assert.equal(hsl(tileColour(early, []))[0], orderHue(0));
  assert.equal(hsl(tileColour(late, []))[0], orderHue(1));
  assert.ok(hueGap(orderHue(0), orderHue(1)) > 120);
});

test('a product tile shows its intensive value: its mean, or total ÷ base', async () => {
  const { productMean, productUnit } = await import('./treemapPanel.js');
  assert.equal(productMean({ value: 4.1e15, base: 1e13 }), 410);
  assert.equal(productMean({ value: 1, mean: 7 }), 7);
  assert.equal(productMean({ value: 5 }), null);
  assert.equal(productMean({ value: 5, base: 0 }), null);
  assert.equal(productUnit('m3', { base: 'm2/surface-area' }), 'm');
  assert.equal(
    formatValue(410, productUnit('m3', { base: 'm2/surface-area' })),
    '410 m',
  );
});
