// Personal fork: diverging and circular colour scales (src/maps/colourScale.js):
// a centre that keeps the ramp's middle, an angle window that wraps, their
// painting, legends, the wrapped-bar preview and the hash fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KINDS,
  circularGradient,
  createScalePainter,
  decodeColourScaleParam,
  decodeScaleFields,
  defineScaleDefaults,
  encodeColourScaleParam,
  encodeScaleFields,
  isDefaultScale,
  normalizeScale,
  resolveWindow,
  scaleKey,
  scaleLegend,
  scalePosition,
} from './colourScale.js';
import { createColourScaleStore } from './colourScaleStore.js';

const ramp = ['#0000ff', '#ffffff', '#ff0000'];
const water = defineScaleDefaults({
  kind: 'diverging',
  scale: 'log', // ignored: diverging is linear
  stops: ramp,
  range: { min: -50, max: 50 },
  units: '%',
});
const aspect = defineScaleDefaults({
  kind: 'circular',
  stops: ['#000000', '#ffffff'],
  units: '°',
});
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('kinds: defaults carry the kind, centre and period; diverging and circular are linear', () => {
  assert.deepEqual(KINDS, ['sequential', 'diverging', 'circular']);
  assert.equal(water.kind, 'diverging');
  assert.equal(water.centre, 0);
  assert.equal(water.model.scale, 'linear');
  assert.equal(water.model.lockCentre, true);
  assert.equal(water.model.centre, null);
  assert.equal(aspect.kind, 'circular');
  assert.equal(aspect.period, 360);
  assert.deepEqual(aspect.range, { min: 0, max: 360 });
  const plain = defineScaleDefaults({ stops: ramp });
  assert.equal(plain.kind, 'sequential');
  // A sequential layer ignores the new fields; its default is untouched.
  const odd = normalizeScale({ lockCentre: false, centre: 4 }, plain);
  assert.equal(odd.lockCentre, true);
  assert.equal(odd.centre, null);
  assert.ok(isDefaultScale(odd, plain));
  assert.equal(normalizeScale({ scale: 'log' }, water).scale, 'linear');
  assert.equal(normalizeScale({ scale: 'sqrt' }, aspect).scale, 'linear');
});

test('diverging, locked: the centre keeps the ramp middle, an automatic end mirrors the other', () => {
  // Automatic: symmetric about 0 over the wider side of the data.
  const model = water.model;
  assert.deepEqual(resolveWindow(model, { min: -10, max: 40 }, water), {
    floor: -40,
    ceiling: 40,
    centre: 0,
  });
  // One end set: the other mirrors it.
  const floorOnly = normalizeScale({ floor: -20 }, water);
  assert.deepEqual(resolveWindow(floorOnly, null, water), {
    floor: -20,
    ceiling: 20,
    centre: 0,
  });
  // Both ends set, lopsided: each half stretched to its own end.
  const lopsided = normalizeScale({ floor: -10, ceiling: 40 }, water);
  close(scalePosition(lopsided, -10, null, water), 0);
  close(scalePosition(lopsided, -5, null, water), 0.25);
  close(scalePosition(lopsided, 0, null, water), 0.5);
  close(scalePosition(lopsided, 20, null, water), 0.75);
  close(scalePosition(lopsided, 40, null, water), 1);
  close(scalePosition(lopsided, 99, null, water), 1);
  // An end on the wrong side of the centre drops back to automatic.
  const wrong = normalizeScale({ floor: 5, ceiling: 40 }, water);
  assert.equal(wrong.floor, null);
  assert.equal(wrong.ceiling, 40);
  // A centre of its own.
  const moved = normalizeScale({ centre: 10, floor: 0, ceiling: 30 }, water);
  close(scalePosition(moved, 10, null, water), 0.5);
  close(scalePosition(moved, 5, null, water), 0.25);
  assert.equal(isDefaultScale(moved, water), false);
  // Hide outside.
  const hidden = normalizeScale(
    { floor: -10, ceiling: 10, outside: 'hide' },
    water,
  );
  assert.ok(Number.isNaN(scalePosition(hidden, 11, null, water)));
  assert.equal(scalePosition(hidden, 10, null, water), 1);
});

test('diverging, unlocked: plain linear over the window, the middle follows it', () => {
  const free = normalizeScale(
    { lockCentre: false, floor: -10, ceiling: 40 },
    water,
  );
  assert.equal(isDefaultScale(free, water), false);
  const window = resolveWindow(free, null, water);
  assert.equal(window.centre, undefined);
  close(scalePosition(free, 15, null, water), 0.5);
  close(scalePosition(free, 0, null, water), 0.2);
  // Unlocked, the automatic window is the data's own.
  const auto = normalizeScale({ lockCentre: false }, water);
  assert.deepEqual(resolveWindow(auto, { min: -10, max: 40 }, water), {
    floor: -10,
    ceiling: 40,
  });
});

test('circular: a start and an arc that wrap round the period', () => {
  // Default: the whole circle from 0.
  const whole = aspect.model;
  assert.deepEqual(resolveWindow(whole, null, aspect), {
    floor: 0,
    ceiling: 360,
    period: 360,
  });
  close(scalePosition(whole, 90, null, aspect), 0.25);
  close(scalePosition(whole, 450, null, aspect), 0.25);
  close(scalePosition(whole, -90, null, aspect), 0.75);
  // A start past the period wraps; the arc keeps its length.
  const north = normalizeScale({ floor: 675, ceiling: 765 }, aspect);
  assert.equal(north.floor, 315);
  assert.equal(north.ceiling, 405);
  // 315° → 45°, through north.
  close(scalePosition(north, 315, null, aspect), 0);
  close(scalePosition(north, 0, null, aspect), 0.5);
  close(scalePosition(north, 45, null, aspect), 1);
  // Outside the arc: the nearer end round the circle (clamp), or none.
  close(scalePosition(north, 60, null, aspect), 1);
  close(scalePosition(north, 300, null, aspect), 0);
  const hidden = normalizeScale({ ...north, outside: 'hide' }, aspect);
  assert.ok(Number.isNaN(scalePosition(hidden, 180, null, aspect)));
  // A ceiling before the start is read round the circle; the arc is at
  // most one period.
  const wrapped = normalizeScale({ floor: 350, ceiling: 10 }, aspect);
  assert.deepEqual([wrapped.floor, wrapped.ceiling], [350, 370]);
  const long = normalizeScale({ floor: 10, ceiling: 900 }, aspect);
  assert.deepEqual([long.floor, long.ceiling], [10, 370]);
  // Inverted.
  const inverted = normalizeScale({ invert: true }, aspect);
  close(scalePosition(inverted, 90, null, aspect), 0.75);
});

test('painting, legends and the wrapped-bar preview follow the kind', () => {
  const lopsided = normalizeScale({ floor: -10, ceiling: 40 }, water);
  const painter = createScalePainter(lopsided, water, null);
  assert.deepEqual(painter.colourOf(0).slice(0, 3), [255, 255, 255]);
  assert.deepEqual(painter.colourOf(-10).slice(0, 3), [0, 0, 255]);
  assert.deepEqual(painter.colourOf(40).slice(0, 3), [255, 0, 0]);
  // The legend's middle swatch is the centre, an even count made odd.
  const legend = scaleLegend(lopsided, water, null, { count: 4 });
  assert.equal(legend.length, 5);
  assert.equal(legend[2].value, 0);
  assert.equal(legend[2].color, '#ffffff');
  assert.deepEqual(
    legend.map((entry) => entry.value),
    [-10, -5, 0, 20, 40],
  );
  // Circular legend: round the arc, labelled within one period.
  const north = normalizeScale({ floor: 315, ceiling: 405 }, aspect);
  assert.deepEqual(
    scaleLegend(north, aspect, null).map((entry) => entry.label),
    ['315', '338', '0', '23', '45 °'],
  );
  // The wrapped bar: 0° at the left is mid-arc (grey), transparent outside
  // the arc when hidden.
  const bar = circularGradient(north, aspect, { steps: 8 });
  assert.match(bar, /^linear-gradient\(to right, #808080 0\.00%/);
  const hidden = normalizeScale({ ...north, outside: 'hide' }, aspect);
  assert.match(
    circularGradient(hidden, aspect, { steps: 8 }),
    /rgba\(0, 0, 0, 0\) 50\.00%/,
  );
});

test('the hash: a centre unlocked (u) and a centre of its own (5th field); older links read the same', () => {
  const free = normalizeScale(
    { lockCentre: false, floor: -10, ceiling: 40 },
    water,
  );
  assert.equal(encodeScaleFields(free), 'd.-10.40.nu');
  const moved = normalizeScale(
    { centre: 2.5, palette: 'blue-white-red' },
    water,
  );
  assert.equal(encodeScaleFields(moved), 'b...n.2p5');
  assert.deepEqual(decodeScaleFields('d.-10.40.nu'.split('.')), {
    palette: 'default',
    floor: -10,
    ceiling: 40,
    scale: 'linear',
    invert: false,
    outside: 'clamp',
    lockCentre: false,
  });
  assert.deepEqual(
    normalizeScale(decodeScaleFields(['b', '', '', 'n', '2p5']), water),
    moved,
  );
  // Four fields (an older link) still decode, without the new keys.
  assert.deepEqual(Object.keys(decodeScaleFields(['g', '1', '2', 'nih'])), [
    'palette',
    'floor',
    'ceiling',
    'scale',
    'invert',
    'outside',
  ]);
  // Malformed: six fields, an empty fifth, a misplaced u.
  assert.equal(decodeScaleFields(['g', '1', '2', 'n', '3', '4']), null);
  assert.equal(decodeScaleFields(['g', '1', '2', 'n', '']), null);
  assert.equal(decodeScaleFields(['g', '1', '2', 'nuh']), null);
  // Through the share parameter and the store.
  const text = encodeColourScaleParam({
    [scaleKey('ee-surface-water', 'change')]: free,
    [scaleKey('ee-terrain-aspect')]: normalizeScale(
      { palette: 'hue', floor: 315, ceiling: 405 },
      aspect,
    ),
  });
  assert.equal(text, 'as.u.315.405.n_sw-change.d.-10.40.nu');
  const store = createColourScaleStore({
    storage: null,
    hashScales: decodeColourScaleParam(text),
  });
  assert.deepEqual(store.get('ee-surface-water:change', water), free);
  assert.equal(store.get('ee-terrain-aspect', aspect).palette, 'hue');
  assert.equal(store.get('ee-terrain-aspect', aspect).ceiling, 405);
});
