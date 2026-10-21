// Personal fork: colour scales (src/maps/colourScale.js): the palettes,
// validation, the window and its mappings, the legend, the hash and the
// store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PALETTES,
  PALETTE_IDS,
  createColourScaleStore,
  createScalePainter,
  decodeColourScaleParam,
  defineScaleDefaults,
  encodeColourScaleParam,
  isDefaultScale,
  normalizeScale,
  paletteStopsHex,
  rangeFraction,
  rangeValue,
  resolveWindow,
  samplePalette,
  scaleColour,
  scaleKey,
  scaleLegend,
  scalePosition,
} from './colourScale.js';

const ownColour = (t) => [Math.round(t * 255), 0, 0, 128];
const logDefaults = defineScaleDefaults({
  scale: 'log',
  units: 'per km²',
  colourAt: ownColour,
});

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('the catalog: the layer default first, then the fixed palettes, every one sampled end to end', () => {
  assert.deepEqual(PALETTE_IDS, [
    'default',
    'viridis',
    'inferno',
    'magma',
    'plasma',
    'cividis',
    'turbo',
    'grey',
    'hot-iron',
    'pet',
    'blue-white-red',
  ]);
  const codes = new Set(PALETTES.map((p) => p.code));
  assert.equal(codes.size, PALETTES.length, 'one code a palette');
  const grey = PALETTES.find((p) => p.id === 'grey').stops;
  assert.deepEqual(samplePalette(grey, 0), [0, 0, 0]);
  assert.deepEqual(samplePalette(grey, 0.5), [128, 128, 128]);
  assert.deepEqual(samplePalette(grey, 1), [255, 255, 255]);
  assert.deepEqual(samplePalette(grey, 7), [255, 255, 255], 'clamped');
  const hot = PALETTES.find((p) => p.id === 'hot-iron').stops;
  assert.deepEqual(samplePalette(hot, 0), [0, 0, 0]);
  assert.deepEqual(samplePalette(hot, 1), [255, 255, 255]);
});

test('validation: bad fields take the default, a crossed or non-positive log window goes back to auto', () => {
  assert.deepEqual(
    normalizeScale(
      { palette: 'sunset', scale: 'cubic', invert: 'yes', outside: 'x' },
      logDefaults,
    ),
    logDefaults.model,
  );
  assert.deepEqual(normalizeScale({ floor: 10, ceiling: 1 }, logDefaults), {
    ...logDefaults.model,
  });
  assert.equal(normalizeScale({ floor: -1 }, logDefaults).floor, null);
  assert.equal(
    normalizeScale({ floor: -1, scale: 'linear' }, logDefaults).floor,
    -1,
  );
  assert.equal(normalizeScale({ floor: '0.5' }, logDefaults).floor, 0.5);
  assert.ok(isDefaultScale(normalizeScale({}, logDefaults), logDefaults));
  assert.ok(
    !isDefaultScale(normalizeScale({ invert: true }, logDefaults), logDefaults),
  );
});

test('the window: floor and ceiling or the auto range; clamp paints the ends, hide clears them; invert flips', () => {
  const auto = { min: 1, max: 1000 };
  const base = logDefaults.model;
  assert.equal(scalePosition(base, 1, auto), 0);
  assert.ok(Math.abs(scalePosition(base, 31.6227766, auto) - 0.5) < 1e-6);
  assert.ok(Number.isNaN(scalePosition(base, 0, auto)), 'zero on a log scale');
  assert.ok(Number.isNaN(scalePosition(base, NaN, auto)));
  const window = normalizeScale({ floor: 10, ceiling: 100 }, logDefaults);
  assert.deepEqual(resolveWindow(window, auto), { floor: 10, ceiling: 100 });
  assert.equal(
    scalePosition(window, 5, auto),
    0,
    'below the floor: its colour',
  );
  assert.equal(
    scalePosition(window, 500, auto),
    1,
    'above the ceiling: its colour',
  );
  const hide = normalizeScale(
    { floor: 10, ceiling: 100, outside: 'hide' },
    logDefaults,
  );
  assert.ok(Number.isNaN(scalePosition(hide, 5, auto)));
  assert.ok(Number.isNaN(scalePosition(hide, 500, auto)));
  const inverted = normalizeScale({ invert: true }, logDefaults);
  assert.equal(scalePosition(inverted, 1, auto), 1);
  // Only the floor set, above the auto ceiling: the set end wins.
  assert.deepEqual(
    resolveWindow(normalizeScale({ floor: 5000 }, logDefaults), auto),
    { floor: 5000, ceiling: 50000 },
  );
  // Linear and square-root mappings.
  const linear = normalizeScale({ scale: 'linear' }, logDefaults);
  assert.equal(scalePosition(linear, 500.5, auto), 0.5);
  const sqrt = normalizeScale({ scale: 'sqrt' }, logDefaults);
  assert.ok(
    Math.abs(scalePosition(sqrt, 1600, { min: 0, max: 6400 }) - 0.5) < 1e-12,
  );
});

test('colours: the layer default is its own ramp (alpha and all); a palette is opaque; the painter matches', () => {
  const auto = { min: 1, max: 100 };
  assert.deepEqual(
    scaleColour(logDefaults.model, logDefaults, 100, auto),
    [255, 0, 0, 128],
  );
  const grey = normalizeScale({ palette: 'grey' }, logDefaults);
  assert.deepEqual(
    scaleColour(grey, logDefaults, 10, auto),
    [128, 128, 128, 255],
  );
  assert.deepEqual(scaleColour(grey, logDefaults, 0, auto), [0, 0, 0, 0]);
  const painter = createScalePainter(grey, logDefaults, auto);
  const out = new Uint8Array(12);
  assert.equal(painter.paint(Float32Array.from([1, 0, 100]), out), 2);
  assert.deepEqual([...out], [0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  assert.deepEqual(paletteStopsHex(grey, logDefaults), ['#000000', '#ffffff']);
  // A layer declared by hex stops alone (the Earth Engine layers).
  const stops = defineScaleDefaults({
    stops: ['#000000', 'ffffff'],
    range: { min: 0, max: 10 },
  });
  assert.deepEqual(stops.colourAt(1), [255, 255, 255, 255]);
  assert.deepEqual(stops.range, { min: 0, max: 10 });
  assert.deepEqual(paletteStopsHex(stops.model, stops), ['#000000', '#ffffff']);
});

test('the legend: stops across the window in the layer units, the clamped ends marked', () => {
  const model = normalizeScale(
    { palette: 'grey', floor: 10, ceiling: 1000 },
    logDefaults,
  );
  assert.deepEqual(
    scaleLegend(model, logDefaults, { min: 1, max: 1e4 }, { count: 3 }).map(
      (s) => [s.label, s.color],
    ),
    [
      ['≤10', '#000000'],
      ['100', '#808080'],
      ['1000+ per km²', '#ffffff'],
    ],
  );
});

test('the slider maps the data range on the scale’s own mapping, and back', () => {
  const range = { min: 1, max: 10000 };
  assert.equal(rangeFraction(100, range, 'log'), 0.5);
  assert.ok(Math.abs(rangeValue(0.5, range, 'log') - 100) < 1e-9);
  assert.equal(rangeFraction(5000.5, range, 'linear'), 0.5);
  assert.equal(rangeValue(0.5, { min: 0, max: 6400 }, 'sqrt'), 1600);
});

test('the hash: compact lo-style entries, round-tripped; malformed and unknown entries skipped', () => {
  const capita = normalizeScale(
    {
      palette: 'hot-iron',
      floor: 0.5,
      ceiling: 3200,
      invert: true,
      outside: 'hide',
    },
    logDefaults,
  );
  const property = normalizeScale(
    { scale: 'linear', floor: -2.5 },
    logDefaults,
  );
  const text = encodeColourScaleParam({
    [scaleKey('wikipedia-coverage', 'capita')]: capita,
    property,
    'not-a-layer': capita,
  });
  assert.equal(text, 'p.d.-2p5..n_w-capita.h.0p5.3200.lih');
  const back = decodeColourScaleParam(text);
  assert.deepEqual(back['wikipedia-coverage:capita'], { ...capita });
  assert.deepEqual(normalizeScale(back.property, logDefaults), property);
  assert.deepEqual(
    decodeColourScaleParam(
      'w.zz.1.2.l_w.h.1.x.l_q.h.1.2.l_w.h.1.2.lq_w-ok.g.1.2.n',
    ),
    {
      'wikipedia-coverage:ok': {
        palette: 'grey',
        floor: 1,
        ceiling: 2,
        scale: 'linear',
        invert: false,
        outside: 'clamp',
      },
    },
  );
  assert.deepEqual(decodeColourScaleParam('x'.repeat(2000)), {});
});

test('the store: storage per key, the hash winning, defaults removed from storage, listeners told', () => {
  const storage = memoryStorage({
    'gev.colourScale.property': JSON.stringify({ palette: 'viridis' }),
    'gev.colourScale.wikipedia-coverage:capita': JSON.stringify({
      palette: 'viridis',
    }),
  });
  const store = createColourScaleStore({
    storage,
    hashScales: {
      'wikipedia-coverage:capita': {
        palette: 'pet',
        floor: 1,
        ceiling: 10,
        scale: 'log',
        invert: false,
        outside: 'clamp',
      },
    },
  });
  const heard = [];
  store.subscribe((key) => heard.push(key));
  assert.equal(store.get('property', logDefaults).palette, 'viridis');
  assert.equal(
    store.get('wikipedia-coverage:capita', logDefaults).palette,
    'pet',
    'the hash wins',
  );
  assert.equal(store.getScale('wikipedia-coverage', 'capita').palette, 'pet');
  store.set('property', { invert: true });
  assert.deepEqual(
    JSON.parse(storage.map.get('gev.colourScale.property')).invert,
    true,
  );
  assert.deepEqual(heard, ['property']);
  store.reset('property');
  assert.equal(storage.map.has('gev.colourScale.property'), false);
  assert.equal(store.getScale('property'), null, 'untouched reads as null');
  assert.ok(store.isDefault('property'));
  assert.deepEqual(Object.keys(store.snapshot()), [
    'wikipedia-coverage:capita',
  ]);
  assert.throws(() => store.set('unknown', {}), /No colour scale defaults/);
});
