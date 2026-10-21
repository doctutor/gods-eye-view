// Personal fork: the colour-scale widget (src/ui/colourScaleWidget.js) and
// the layers it drives: its controls' state transitions on a minimal DOM,
// Wikipedia coverage and Property sales recoloured on a window change, the
// census tiles' scale token and colours, and Lego's window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { railFixture } from './railTestFixture.mjs';
import {
  handleValue,
  scaleControlState,
  scaleRowControl,
  scaleRowLegend,
  syncColourScaleWidget,
} from './colourScaleWidget.js';
import { isDefaultScale, normalizeScale } from '../maps/colourScale.js';
import { createColourScaleStore } from '../maps/colourScaleStore.js';
import {
  wikipediaColouring,
  wikipediaScaleDefaults,
  wikipediaScaleKey,
} from '../layers/wikipediaCoverage/scale.js';
import { paintTile } from '../layers/wikipediaCoverage/ramp.js';
import {
  propertyColouring,
  propertyScaleDefaults,
  propertyScaleKey,
} from '../layers/property/scale.js';
import { metricColor } from '../layers/property/property.js';
import {
  censusScaleColor,
  censusScaleDefaults,
  censusScaleFromToken,
  censusScaleToken,
} from '../data/censusScale.js';
import { censusImageryOptions } from '../layers/census/source.js';
import { censusTileScaleToken } from '../layers/census/scale.js';
import { withColourScale } from '../layers/lego/layerSpecs.js';
import { gridColumns } from '../layers/lego/model.js';

const freshStore = () =>
  createColourScaleStore({ storage: null, hashScales: {} });

/** The rail fixture with what the widget reads of real nodes. */
function fixture() {
  const f = railFixture();
  const create = f.document.createElement.bind(f.document);
  f.document.createElement = (tag) => {
    const node = create(tag);
    Object.defineProperty(node, 'parentNode', { get: () => node.parent });
    if (tag === 'select')
      Object.defineProperty(node, 'options', { get: () => node.children });
    return node;
  };
  const container = f.document.createElement('div');
  return { ...f, container };
}
const fire = (node, type) => node.dispatchEvent(new Event(type));

test('the widget: SCALE opens it; palette, numbers, handles, mapping, invert, hide and reset drive the store', () => {
  const store = freshStore();
  const variant = 'articles';
  const key = wikipediaScaleKey(variant);
  const auto = { min: 0.01, max: 10 };
  const describe = () =>
    scaleRowControl({
      store,
      key,
      defaults: wikipediaScaleDefaults(variant),
      auto,
    });
  const { container } = fixture();
  let descriptor = describe();
  const sync = () => {
    descriptor = describe();
    syncColourScaleWidget(container, descriptor, { live: () => descriptor });
  };
  sync();
  const parts = container._scaleWidget;
  assert.equal(parts.toggle.textContent, 'SCALE');
  assert.equal(parts.toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(parts.root.children[1].hidden, true);
  parts.toggle.click();
  assert.equal(parts.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(parts.root.children[1].hidden, false);
  // The default: its own palette, LOG pressed, SQRT not offered, RESET off.
  assert.equal(parts.select.value, 'default');
  assert.equal(
    parts.scaleButtons.get('log').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(parts.scaleButtons.get('sqrt').hidden, true);
  assert.equal(parts.reset.disabled, true);
  assert.equal(parts.floorInput.value, '');
  assert.equal(parts.floorInput.placeholder, '0.01');
  assert.match(
    parts.preview.style.background,
    /^linear-gradient\(to right, #140b34/,
  );
  // Palette.
  parts.select.value = 'hot-iron';
  fire(parts.select, 'change');
  sync();
  assert.equal(store.get(key).palette, 'hot-iron');
  assert.equal(parts.toggle.textContent, 'SCALE •');
  assert.equal(parts.reset.disabled, false);
  assert.match(
    parts.preview.style.background,
    /^linear-gradient\(to right, #000000/,
  );
  // Numbers: a floor and a ceiling in the units; empty is automatic again.
  parts.floorInput.value = '0.1';
  fire(parts.floorInput, 'change');
  parts.ceilingInput.value = '5';
  fire(parts.ceilingInput, 'change');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [0.1, 5]);
  assert.equal(parts.floorInput.value, '0.1');
  // The handles sit on the log mapping of the data range: 0.1 is a third.
  assert.equal(parts.floorRange.value, String(333));
  parts.ceilingRange.value = '1000';
  fire(parts.ceilingRange, 'input');
  sync();
  assert.equal(store.get(key).ceiling, 10);
  // A handle never crosses the other.
  parts.floorRange.value = '1000';
  fire(parts.floorRange, 'input');
  sync();
  assert.ok(store.get(key).floor < store.get(key).ceiling);
  parts.floorInput.value = '';
  fire(parts.floorInput, 'change');
  sync();
  assert.equal(store.get(key).floor, null);
  // Mapping, invert, hide.
  parts.scaleButtons.get('linear').click();
  sync();
  assert.equal(store.get(key).scale, 'linear');
  parts.invert.click();
  parts.outside.click();
  sync();
  assert.equal(store.get(key).invert, true);
  assert.equal(store.get(key).outside, 'hide');
  assert.equal(parts.invert.getAttribute('aria-pressed'), 'true');
  // The legend follows the scale, in the variant's units.
  const legend = scaleRowLegend(descriptor);
  assert.equal(legend.length, 5);
  assert.match(legend.at(-1).label, /per km²$/);
  assert.equal(legend[0].color, '#ffffff', 'inverted hot iron starts white');
  // Reset: the layer default, the inputs automatic again.
  parts.reset.click();
  sync();
  assert.ok(isDefaultScale(store.get(key), wikipediaScaleDefaults(variant)));
  assert.equal(parts.reset.disabled, true);
  assert.equal(parts.select.value, 'default');
  // No descriptor: hidden.
  syncColourScaleWidget(container, null, { live: () => null });
  assert.equal(parts.root.hidden, true);
});

test('the controls’ state: handles on the mapping, a window set beyond the data range widens the slider', () => {
  const store = freshStore();
  const defaults = wikipediaScaleDefaults('capita');
  const key = wikipediaScaleKey('capita');
  store.get(key, defaults);
  store.set(key, { floor: 1, ceiling: 100000 });
  const descriptor = scaleRowControl({
    store,
    key,
    defaults,
    auto: { min: 3.7, max: 3200 },
  });
  assert.deepEqual(descriptor.range, { min: 1, max: 100000 });
  const state = scaleControlState(descriptor);
  assert.equal(state.floorHandle, 0);
  assert.equal(state.ceilingHandle, 1000);
  assert.equal(state.units, 'per 100k');
  assert.equal(handleValue(descriptor, 'floor', 400), 100);
});

test('Wikipedia coverage: the default paints through its ramp, byte for byte; a window recolours it', () => {
  const store = freshStore();
  const domain = { min: 0.03, max: 1.35 };
  const values = Float32Array.from([0, 0.01, 0.2, 5]);
  const before = new Uint8ClampedArray(16);
  const expected = new Uint8ClampedArray(16);
  wikipediaColouring(store, 'articles', domain).paint(values, before);
  paintTile(values, domain, expected);
  assert.deepEqual([...before], [...expected]);
  const key = wikipediaScaleKey('articles');
  store.set(key, { palette: 'grey', floor: 0.1, ceiling: 1, scale: 'linear' });
  const after = new Uint8ClampedArray(16);
  const colouring = wikipediaColouring(store, 'articles', domain);
  assert.equal(colouring.isDefault, false);
  assert.equal(
    colouring.paint(values, after),
    4,
    'zero is a value on a linear window',
  );
  assert.deepEqual([...after.slice(8, 12)], [28, 28, 28, 255]);
  assert.deepEqual(
    [...after.slice(12, 16)],
    [255, 255, 255, 255],
    'above the ceiling: its colour',
  );
  store.set(key, { outside: 'hide' });
  const hidden = new Uint8ClampedArray(16);
  assert.equal(
    wikipediaColouring(store, 'articles', domain).paint(values, hidden),
    1,
  );
});

test('Property sales: the default is the metric’s own colour; a palette recolours hexagons and buildings', () => {
  const store = freshStore();
  const domain = { min: 100000, max: 1000000 };
  const colouring = propertyColouring(store, 'price', domain);
  assert.deepEqual(
    colouring.colourOf(300000),
    metricColor('price', 300000, domain),
  );
  store.get(propertyScaleKey('price'), propertyScaleDefaults('price'));
  store.set(propertyScaleKey('price'), { palette: 'viridis' });
  assert.deepEqual(
    propertyColouring(store, 'price', domain).colourOf(100000),
    [68, 1, 84, 255],
  );
  // Year is linear by default.
  assert.equal(propertyScaleDefaults('year').model.scale, 'linear');
});

test('Census tracts: the tile URL carries a changed scale; the server colours tracts in it at the classes’ opacity', () => {
  const store = freshStore();
  const status = {
    minZoom: 7,
    maxZoom: 14,
    modes: { income: { ready: true, version: 'abc' } },
  };
  assert.equal(
    censusImageryOptions(status, 'income', {
      scaleToken: censusTileScaleToken('income', store),
    }).url,
    '/api/census/tile/income/{z}/{x}/{y}?v=abc',
  );
  const defaults = censusScaleDefaults('income');
  store.set('ee-census-tracts:income', {
    palette: 'grey',
    floor: 50000,
    ceiling: 150000,
  });
  const url = censusImageryOptions(status, 'income', {
    scaleToken: censusTileScaleToken('income', store),
  }).url;
  assert.equal(
    url,
    '/api/census/tile/income/{z}/{x}/{y}?v=abc&s=g.50000.150000.n',
  );
  const scale = censusScaleFromToken('g.50000.150000.n', 'income');
  assert.equal(scale.palette, 'grey');
  assert.equal(censusScaleColor(scale, 'income', 100000), '808080c8');
  assert.equal(
    censusScaleColor(scale, 'income', 20000),
    '000000c8',
    'below the floor',
  );
  assert.equal(
    censusScaleColor(scale, 'income', NaN),
    '9aa4ad55',
    'no estimate stays grey',
  );
  const hide = normalizeScale({ ...scale, outside: 'hide' }, defaults);
  assert.equal(censusScaleColor(hide, 'income', 20000), null);
  // The default and bad tokens draw the classed tiles.
  assert.equal(censusScaleToken(defaults.model, 'income'), '');
  assert.equal(censusScaleFromToken('', 'income'), null);
  assert.equal(censusScaleFromToken('zz.1.2.n', 'income'), null);
  assert.equal(censusScaleFromToken('g.1.2.n', 'tracts'), null);
});

test('Lego: a scale maps its window onto the bricks and the colours; hide raises nothing outside it', () => {
  const spec = {
    palette: ['#000000', '#ffffff'],
    scale: 'linear',
    min: 0,
    max: 100,
  };
  const defaults = {
    model: {
      palette: 'default',
      floor: null,
      ceiling: null,
      scale: 'linear',
      invert: false,
      outside: 'clamp',
    },
  };
  const model = normalizeScale(
    { floor: 20, ceiling: 40, invert: true, outside: 'hide', palette: 'grey' },
    defaults,
  );
  const windowed = withColourScale(spec, model);
  assert.deepEqual([windowed.min, windowed.max, windowed.hide], [20, 40, true]);
  assert.deepEqual(windowed.palette, ['#ffffff', '#000000']);
  assert.equal(withColourScale(spec, null), spec);
  const grid = {
    header: {
      cols: 3,
      rows: 1,
      west: 0,
      south: 0,
      east: 3,
      north: 1,
      cellSizeM: 100,
      legendMin: 0,
      legendMax: 100,
    },
    values: Float32Array.from([10, 30, 40]),
  };
  const columns = gridColumns(grid, { spec: windowed });
  assert.deepEqual(
    columns.map((c) => c.col),
    [1, 2],
    'below the floor: no column',
  );
  assert.ok(
    columns[1].bricks > columns[0].bricks,
    'the window spans the bricks',
  );
});
