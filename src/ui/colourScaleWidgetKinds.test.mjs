// Personal fork: the colour-scale widget for diverging and circular layers
// (src/ui/colourScaleWidget.js): LOCK CENTRE and the mirrored handles, the
// centre input, the start-and-arc controls and their wrapped-bar preview;
// and Lego's columns placed by those scales.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { railFixture } from './railTestFixture.mjs';
import {
  handlePartial,
  inputPartial,
  scaleControlState,
  scaleRowControl,
  syncColourScaleWidget,
} from './colourScaleWidget.js';
import { defineScaleDefaults } from '../maps/colourScale.js';
import { createColourScaleStore } from '../maps/colourScaleStore.js';
import {
  legoScaleDefaults,
  withColourScale,
} from '../layers/lego/layerSpecs.js';
import {
  MAX_VALUE_BRICKS,
  columnColor,
  gridColumns,
} from '../layers/lego/model.js';

const water = defineScaleDefaults({
  kind: 'diverging',
  stops: ['#0000ff', '#ffffff', '#ff0000'],
  range: { min: -50, max: 50 },
  units: '%',
});
const aspect = defineScaleDefaults({
  kind: 'circular',
  stops: ['#000000', '#ffffff'],
  units: '°',
});

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
  return { ...f, container: f.document.createElement('div') };
}
const fire = (node, type) => node.dispatchEvent(new Event(type));

function mounted(key, defaults) {
  const store = createColourScaleStore({ storage: null, hashScales: {} });
  const { container } = fixture();
  let descriptor = null;
  const sync = () => {
    descriptor = scaleRowControl({ store, key, defaults });
    syncColourScaleWidget(container, descriptor, { live: () => descriptor });
    return descriptor;
  };
  sync();
  return { store, sync, parts: container._scaleWidget, now: () => descriptor };
}

test('diverging: LOCK CENTRE on by default; a handle mirrors the other about the centre', () => {
  const key = 'ee-surface-water:change';
  const { store, sync, parts } = mounted(key, water);
  const state = scaleControlState(sync());
  assert.equal(state.kind, 'diverging');
  assert.deepEqual(state.scales, []);
  assert.equal(state.locked, true);
  assert.equal(parts.root.dataset.kind, 'diverging');
  // No mapping buttons; LOCK CENTRE shown and pressed; the centre input.
  for (const button of parts.scaleButtons.values())
    assert.equal(button.hidden, true);
  assert.equal(parts.lock.hidden, false);
  assert.equal(parts.lock.textContent, 'LOCK CENTRE');
  assert.equal(parts.lock.getAttribute('aria-pressed'), 'true');
  assert.equal(parts.centreRow.hidden, false);
  assert.equal(parts.centreInput.placeholder, '0');
  // The automatic window is symmetric: the handles at the ends.
  assert.deepEqual(state.window, { floor: -50, ceiling: 50, centre: 0 });
  // Dragging the floor to a quarter (-25) mirrors the ceiling to 25.
  parts.floorRange.value = '250';
  fire(parts.floorRange, 'input');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [-25, 25]);
  assert.equal(parts.ceilingRange.value, '750');
  // A handle cannot cross the centre: it stops a hair short.
  parts.ceilingRange.value = '200';
  fire(parts.ceilingRange, 'input');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [-1, 1]);
  // Typed ends may be lopsided; the centre still keeps the middle.
  parts.ceilingInput.value = '40';
  fire(parts.ceilingInput, 'change');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [-1, 40]);
  // A centre of its own.
  parts.centreInput.value = '5';
  fire(parts.centreInput, 'change');
  sync();
  assert.equal(store.get(key).centre, 5);
  assert.equal(parts.centreInput.value, '5');
  // The floor (-1) is still below the new centre; the ceiling above it.
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [-1, 40]);
  // Unlocked: dragging one end moves only it, the centre input hides.
  parts.lock.click();
  sync();
  assert.equal(store.get(key).lockCentre, false);
  assert.equal(parts.lock.getAttribute('aria-pressed'), 'false');
  assert.equal(parts.centreRow.hidden, true);
  const before = store.get(key).ceiling;
  parts.floorRange.value = '0';
  fire(parts.floorRange, 'input');
  sync();
  assert.equal(store.get(key).floor, -50);
  assert.equal(store.get(key).ceiling, before);
  // RESET: locked again, automatic.
  parts.reset.click();
  sync();
  assert.equal(store.get(key).lockCentre, true);
  assert.equal(store.get(key).floor, null);
  assert.equal(parts.reset.disabled, true);
});

test('circular: start and arc sliders and inputs; the preview is one period, wrapped', () => {
  const key = 'ee-terrain-aspect';
  const { store, sync, parts } = mounted(key, aspect);
  let state = scaleControlState(sync());
  assert.equal(state.kind, 'circular');
  assert.deepEqual(state.scales, []);
  assert.equal(parts.root.dataset.kind, 'circular');
  assert.equal(parts.lock.hidden, true);
  assert.equal(parts.centreRow.hidden, true);
  assert.equal(parts.floorRange.getAttribute('aria-label'), 'Start');
  assert.equal(parts.ceilingRange.getAttribute('aria-label'), 'Arc');
  // Default: start 0, arc the whole circle.
  assert.equal(state.floorHandle, 0);
  assert.equal(state.ceilingHandle, 1000);
  assert.equal(state.ceilingPlaceholder, '360');
  // Start at 315° (the arc kept), then a 90° arc: 315° → 45° through north.
  parts.floorRange.value = '875';
  fire(parts.floorRange, 'input');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [315, 675]);
  parts.ceilingInput.value = '90';
  fire(parts.ceilingInput, 'change');
  state = scaleControlState(sync());
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [315, 405]);
  assert.equal(state.ceilingText, '90');
  assert.equal(parts.floorInput.value, '315');
  assert.equal(state.ceilingHandle, 250);
  // The preview: 0° (left edge) is mid-arc grey; 180° is past the far end.
  assert.match(
    parts.preview.style.background,
    /^linear-gradient\(to right, #808080 0\.00%/,
  );
  // Typing a start keeps the arc.
  parts.floorInput.value = '30';
  fire(parts.floorInput, 'change');
  sync();
  assert.deepEqual([store.get(key).floor, store.get(key).ceiling], [30, 120]);
  // The partials, directly.
  const descriptor = scaleRowControl({ store, key, defaults: aspect });
  assert.deepEqual(handlePartial(descriptor, 'ceiling', 500), {
    floor: 30,
    ceiling: 210,
  });
  assert.deepEqual(inputPartial(descriptor, 'ceiling', ''), {
    floor: 30,
    ceiling: null,
  });
});

test('Lego: a circular scale places each column round its arc; hidden ones raise nothing', () => {
  const store = createColourScaleStore({ storage: null, hashScales: {} });
  store.get('ee-terrain-aspect', aspect);
  store.set('ee-terrain-aspect', {
    floor: 315,
    ceiling: 405,
    outside: 'hide',
  });
  const defaults = legoScaleDefaults(store, 'ee-terrain-aspect', '');
  assert.equal(defaults.kind, 'circular');
  const spec = withColourScale(
    { palette: ['#000000', '#ffffff'], min: 0, max: 360, scale: 'linear' },
    store.getScale('ee-terrain-aspect'),
    defaults,
  );
  assert.equal(typeof spec.positionOf, 'function');
  // North (0°) is mid-arc: mid grey, half height; 180° is outside, hidden.
  assert.equal(spec.positionOf(0), 0.5);
  assert.ok(Number.isNaN(spec.positionOf(180)));
  const grid = {
    header: {
      cols: 3,
      rows: 1,
      west: 0,
      east: 3,
      south: 0,
      north: 1,
      cellSizeM: 100,
      legendMin: 0,
      legendMax: 360,
    },
    values: [0, 180, 45],
  };
  const columns = gridColumns(grid, { spec, elevation: false });
  assert.deepEqual(
    columns.map((column) => column.index),
    [0, 2],
  );
  assert.equal(columns[0].bricks, 1 + Math.round(0.5 * (MAX_VALUE_BRICKS - 1)));
  assert.equal(columns[1].bricks, MAX_VALUE_BRICKS);
  assert.equal(columnColor(spec, 45), columnColor(spec, 405));
  // A sequential layer's spec is as before (no positionOf).
  const plain = withColourScale(
    { palette: ['#000000', '#ffffff'], min: 0, max: 10, scale: 'linear' },
    {
      palette: 'default',
      floor: 2,
      ceiling: 8,
      scale: 'linear',
      invert: false,
      outside: 'clamp',
    },
    null,
  );
  assert.equal(plain.positionOf, undefined);
  assert.deepEqual([plain.min, plain.max], [2, 8]);
});
