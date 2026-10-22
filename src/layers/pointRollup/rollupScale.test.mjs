// Personal fork: the point rollup's count window (src/layers/pointRollup/
// scale.js): alpha across a user's floor and ceiling, a palette in place of
// the accent, hexes hidden outside the window, a scale change redrawing the
// hexes, the hash token, and the Cameras row's Scale control.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  decodeColourScaleParam,
  encodeColourScaleParam,
  normalizeScale,
} from '../../maps/colourScale.js';
import { createColourScaleStore } from '../../maps/colourScaleStore.js';
import { ROLLUP_ALPHA_MAX, ROLLUP_ALPHA_MIN, cellAlpha } from './rollup.js';
import {
  rollupFill,
  rollupScaleDefaults,
  rollupScaleKey,
  rollupScaleModel,
  setRollupAccent,
} from './scale.js';
import { attachPointRollup } from './index.js';
import { createRollup } from '../cctv/rollup.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const freshStore = () =>
  createColourScaleStore({ storage: null, hashScales: {} });

test('the fill: alpha across the count window, a palette for the accent, hidden outside', () => {
  setRollupAccent('test-layer', '#ff8800');
  const defaults = rollupScaleDefaults('test-layer');
  assert.equal(defaults.model.scale, 'log');
  // Log window 10 → 1,000 hexes' counts.
  const window = normalizeScale({ floor: 10, ceiling: 1000 }, defaults);
  close(rollupFill(window, defaults, 10, 5000).alpha, ROLLUP_ALPHA_MIN);
  close(
    rollupFill(window, defaults, 100, 5000).alpha,
    (ROLLUP_ALPHA_MIN + ROLLUP_ALPHA_MAX) / 2,
  );
  close(rollupFill(window, defaults, 1000, 5000).alpha, ROLLUP_ALPHA_MAX);
  // Clamped past the ends; the layer's accent as the colour.
  close(rollupFill(window, defaults, 2, 5000).alpha, ROLLUP_ALPHA_MIN);
  close(rollupFill(window, defaults, 4000, 5000).alpha, ROLLUP_ALPHA_MAX);
  assert.deepEqual(rollupFill(window, defaults, 50, 5000).rgb, [255, 136, 0]);
  // A palette: grey, dark sparse and white dense; inverted flips the colour
  // but a fuller hex stays the more opaque.
  const grey = normalizeScale({ ...window, palette: 'grey' }, defaults);
  assert.deepEqual(rollupFill(grey, defaults, 10, 5000).rgb, [0, 0, 0]);
  assert.deepEqual(rollupFill(grey, defaults, 1000, 5000).rgb, [255, 255, 255]);
  const inverted = normalizeScale({ ...grey, invert: true }, defaults);
  assert.deepEqual(rollupFill(inverted, defaults, 1000, 5000).rgb, [0, 0, 0]);
  close(rollupFill(inverted, defaults, 1000, 5000).alpha, ROLLUP_ALPHA_MAX);
  // Hide outside.
  const hidden = normalizeScale({ ...window, outside: 'hide' }, defaults);
  assert.equal(rollupFill(hidden, defaults, 5, 5000), null);
  assert.equal(rollupFill(hidden, defaults, 2000, 5000), null);
  assert.ok(rollupFill(hidden, defaults, 500, 5000));
  // The automatic window: one to the fullest hex.
  const auto = normalizeScale({ palette: 'grey' }, defaults);
  close(rollupFill(auto, defaults, 1, 100).alpha, ROLLUP_ALPHA_MIN);
  close(rollupFill(auto, defaults, 100, 100).alpha, ROLLUP_ALPHA_MAX);
  // Untouched: no model, the rollup keeps its own ramp.
  const store = freshStore();
  assert.equal(rollupScaleModel(store, 'test-layer'), null);
  store.set(rollupScaleKey('test-layer'), { floor: 10 });
  assert.equal(rollupScaleModel(store, 'test-layer').floor, 10);
});

test('the hash carries a rollup window per layer', () => {
  const defaults = rollupScaleDefaults('cctv');
  const text = encodeColourScaleParam({
    [rollupScaleKey('cctv')]: normalizeScale(
      { floor: 5, ceiling: 500, palette: 'viridis', outside: 'hide' },
      defaults,
    ),
    [rollupScaleKey('places')]: normalizeScale(
      { ceiling: 2000, scale: 'linear' },
      defaults,
    ),
    [rollupScaleKey('street-assets')]: normalizeScale({ floor: 2 }, defaults),
  });
  assert.equal(
    text,
    'cc-rollup.v.5.500.lh_pl-rollup.d..2000.n_sa-rollup.d.2..l',
  );
  const back = decodeColourScaleParam(text);
  assert.deepEqual(Object.keys(back).sort(), [
    'cctv:rollup',
    'places:rollup',
    'street-assets:rollup',
  ]);
  assert.equal(back['cctv:rollup'].outside, 'hide');
});

function fakeViewer(height = 2.2e7) {
  const primitives = [];
  return {
    primitives,
    viewer: {
      scene: {
        primitives: {
          add: (p) => (primitives.push(p), p),
          remove: (p) => {
            const i = primitives.indexOf(p);
            if (i >= 0) primitives.splice(i, 1);
            return i >= 0;
          },
        },
      },
      camera: {
        get positionCartographic() {
          return Cesium.Cartographic.fromDegrees(-76.6, 39.3, height);
        },
        moveEnd: { addEventListener: () => () => {} },
      },
    },
  };
}
function fakeOverlays() {
  const sources = new Map();
  return {
    sources,
    setEntries: (id, entries) => sources.set(id, entries),
    setVisible: () => {},
    clearSource: (id) => sources.delete(id),
  };
}
// Counts per cell, as a server would send them: 1, 10, 100, 1,000.
const COUNTS = new Map([
  ['802bfffffffffff', 1],
  ['8029fffffffffff', 10],
  ['802dfffffffffff', 100],
  ['8027fffffffffff', 1000],
]);

test('a scale change redraws the hexes: hidden ones go, with their counts', () => {
  const store = freshStore();
  const env = fakeViewer();
  const overlays = fakeOverlays();
  const updates = [];
  const rollup = attachPointRollup(
    { id: 'cctv', viewer: env.viewer, overlays },
    {
      getCounts: () => COUNTS,
      accent: '#39d5ff',
      scales: store,
      onUpdate: () => updates.push(rollup.getState().scaleToken),
      threshold: { enter: 1, exit: 1 },
    },
  );
  rollup.refresh();
  let state = rollup.getState();
  assert.equal(state.active, true);
  assert.equal(state.maxCount, 1000);
  assert.equal(state.scaleToken, '');
  assert.equal(overlays.sources.get('cctv-rollup').length, 4);
  // The row's control: the store's key, the window one to the fullest hex.
  const control = rollup.scaleControl();
  assert.equal(control.key, 'cctv:rollup');
  assert.deepEqual(control.auto, { min: 1, max: 1000 });
  // A window from 5 to 500, hidden outside: the 1 and the 1,000 go.
  control.onChange({ floor: 5, ceiling: 500, outside: 'hide' });
  state = rollup.getState();
  assert.equal(state.scaleToken, 'd.5.500.lh');
  assert.equal(updates.at(-1), 'd.5.500.lh');
  assert.equal(overlays.sources.get('cctv-rollup').length, 2);
  assert.equal(env.primitives.length, 1);
  // RESET: the accent's own ramp again, every hex.
  rollup.scaleControl().onReset();
  assert.equal(rollup.getState().scaleToken, '');
  assert.equal(overlays.sources.get('cctv-rollup').length, 4);
  // Detached: a later change draws nothing.
  rollup.detach();
  store.set('cctv:rollup', { floor: 50 });
  assert.equal(env.primitives.length, 0);
});

test('untouched, the hexes keep the log ramp of the accent', () => {
  // The default path is the rollup's own cellAlpha (unchanged).
  assert.equal(cellAlpha(1000, 1000), ROLLUP_ALPHA_MAX);
  const store = freshStore();
  const env = fakeViewer();
  const rollup = attachPointRollup(
    { id: 'places', viewer: env.viewer, overlays: fakeOverlays() },
    {
      getCounts: () => COUNTS,
      scales: store,
      threshold: { enter: 1, exit: 1 },
    },
  );
  rollup.refresh();
  assert.equal(rollup.getState().scaleToken, '');
  assert.equal(rollup.getState().cells, 4);
  rollup.detach();
});

test("the Cameras row offers the hexes' Scale only while they show", async () => {
  const env = fakeViewer();
  const overlays = fakeOverlays();
  const layerState = {
    _viewer: env.viewer,
    _cctvOverlayHost: overlays,
    _enabled: true,
    _records: Array.from({ length: 600 }, (_, i) => ({
      camera: {
        id: `c${i}`,
        lat: 39 + (i % 30) * 0.1,
        lon: -77 + Math.floor(i / 30) * 0.1,
      },
    })),
  };
  const part = createRollup({ state: layerState, parts: {}, services: {} });
  part.start();
  const controls = part.methods.getRowControls();
  assert.ok(controls.scale, 'from orbit the hexes show: a Scale control');
  assert.equal(controls.scale.key, 'cctv:rollup');
  assert.equal(controls.scale.auto.min, 1);
  part.methods.setRollupMode('off', { storage: null });
  assert.equal(part.methods.getRowControls().scale, null);
  part.stop();
});
