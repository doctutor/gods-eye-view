// Personal fork: the point rollup — binning by resolution, the view window
// (antimeridian included), the hysteresis rule, count labels through the
// world-overlay normaliser, and the lifecycle on a fake viewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { cellToLatLng, getResolution, latLngToCell } from 'h3-js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { viewWindow } from '../../maps/h3Cells.js';
import {
  ROLLUP_ALPHA_MAX,
  ROLLUP_ALPHA_MIN,
  ROLLUP_ENTER_COUNT,
  ROLLUP_EXIT_COUNT,
  ROLLUP_ENTER_HEIGHT_M,
  ROLLUP_EXIT_HEIGHT_M,
  ROLLUP_MIN_HEIGHT_M,
  binPoints,
  cellAlpha,
  cellBox,
  countInWindow,
  countLabel,
  labelEntry,
  pointInWindow,
  rollupWanted,
} from './rollup.js';
import { attachPointRollup } from './index.js';

/** A deterministic spread of points: `n` around a centre, some far away. */
function syntheticPoints(n, { lat = 39.3, lon = -76.6, spread = 3 } = {}) {
  const points = [];
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < n; i++)
    points.push({
      id: `p${i}`,
      lat: lat + (random() - 0.5) * spread,
      lon: lon + (random() - 0.5) * spread,
    });
  return points;
}

test('binning: every located point in the window lands in one cell of the resolution', () => {
  const points = [
    ...syntheticPoints(500),
    { id: 'nan', lat: NaN, lon: 1 },
    { id: 'far', lat: -33.9, lon: 151.2 },
    { id: 'bad-lat', lat: 95, lon: 0 },
  ];
  const window = { west: -80, south: 36, east: -73, north: 42 };
  const bins = binPoints(points, 4, window);
  let total = 0;
  for (const [cell, count] of bins) {
    assert.equal(getResolution(cell), 4);
    total += count;
  }
  assert.equal(total, 500, 'the far, unlocated and impossible points stay out');
  assert.equal(countInWindow(points, window), 500);
  assert.equal(countInWindow(points, null), 501, 'the planet holds Sydney too');
  // Coarser: fewer cells, the same total.
  const coarse = binPoints(points, 2, window);
  assert.ok(coarse.size < bins.size);
  assert.equal(
    [...coarse.values()].reduce((a, b) => a + b, 0),
    500,
  );
  assert.equal(binPoints([], 3).size, 0);
  assert.equal(
    binPoints(points, 99, null).size,
    binPoints(points, 7, null).size,
    'clamped',
  );
});

test('the window: inside, outside, across the antimeridian, the planet', () => {
  const box = { west: 10, south: 40, east: 20, north: 50 };
  assert.equal(pointInWindow(box, 45, 15), true);
  assert.equal(pointInWindow(box, 45, 25), false);
  assert.equal(pointInWindow(box, 55, 15), false);
  assert.equal(pointInWindow(box, 45, 375), true, 'longitudes wrap');
  const crossing = { west: 170, south: 50, east: -170, north: 70 };
  assert.equal(pointInWindow(crossing, 60, 179), true);
  assert.equal(pointInWindow(crossing, 60, -179), true);
  assert.equal(pointInWindow(crossing, 60, 0), false);
  assert.equal(pointInWindow(null, -89, 179), true);
  const dateline = [
    { id: 'a', lat: 60, lon: 179.5 },
    { id: 'b', lat: 60, lon: -179.5 },
    { id: 'c', lat: 60, lon: 10 },
  ];
  const window = viewWindow(60, 179.8, 8e5);
  assert.ok(window.west > window.east);
  assert.equal(countInWindow(dateline, window), 2);
  const bins = binPoints(dateline, 4, window);
  assert.equal(
    [...bins.values()].reduce((a, b) => a + b, 0),
    2,
  );
});

test('the threshold: on past the enter count, off below the exit count, never below the floor', () => {
  assert.equal(ROLLUP_ENTER_COUNT, 400);
  assert.equal(ROLLUP_EXIT_COUNT, 250);
  assert.equal(ROLLUP_MIN_HEIGHT_M, 30_000);
  const at = (inView, active, heightM = 200_000) =>
    rollupWanted({ heightM, inView, active });
  assert.equal(at(400, false), false, 'exactly the enter count stays pins');
  assert.equal(at(401, false), true);
  assert.equal(
    at(300, true),
    true,
    'hysteresis: still on between exit and enter',
  );
  assert.equal(at(300, false), false);
  assert.equal(at(250, true), true, 'at the exit count still on');
  assert.equal(at(249, true), false);
  assert.equal(at(5000, false, 20_000), false, 'below the floor: pins');
  assert.equal(at(5000, true, 29_999), false);
  assert.equal(at(5000, false, Infinity), true, 'from orbit');
  assert.equal(at(5000, false, NaN), false);
  // The height rule: above 300 km hexes however few, held down to 250 km.
  assert.equal(ROLLUP_ENTER_HEIGHT_M, 300_000);
  assert.equal(ROLLUP_EXIT_HEIGHT_M, 250_000);
  assert.equal(at(3, false, 300_000), false, 'exactly the enter height: pins');
  assert.equal(at(3, false, 300_001), true, 'above it: hexes however few');
  assert.equal(at(3, true, 260_000), true, 'hysteresis on the height');
  assert.equal(at(3, false, 260_000), false);
  assert.equal(at(3, true, 250_000), true, 'at the exit height still on');
  assert.equal(at(3, true, 249_999), false);
  assert.equal(at(300, true, 249_999), true, 'the count still holds it');
  assert.equal(at(3, false, 2.2e7), true, 'from orbit');
  // The count alone when the height rule is off.
  const countOnly = { enterHeightM: Infinity };
  assert.equal(
    rollupWanted({ heightM: 2.2e7, inView: 3, active: false }, countOnly),
    false,
  );
  assert.equal(
    rollupWanted({ heightM: Infinity, inView: 3, active: true }, countOnly),
    false,
  );
  // A layer's own threshold.
  const custom = { enter: 100, exit: 50, minHeightM: 0 };
  assert.equal(
    rollupWanted({ heightM: 1000, inView: 101, active: false }, custom),
    true,
  );
  assert.equal(
    rollupWanted({ heightM: 1000, inView: 60, active: true }, custom),
    true,
  );
  assert.equal(
    rollupWanted({ heightM: 1000, inView: 49, active: true }, custom),
    false,
  );
});

test('the log alpha ramp, the short count and the fly-to box', () => {
  assert.equal(cellAlpha(0, 100), ROLLUP_ALPHA_MIN);
  assert.ok(Math.abs(cellAlpha(100, 100) - ROLLUP_ALPHA_MAX) < 1e-9);
  const mid = cellAlpha(10, 100);
  assert.ok(
    mid > ROLLUP_ALPHA_MIN + 0.2 && mid < ROLLUP_ALPHA_MAX,
    `log: ${mid}`,
  );
  assert.equal(cellAlpha(5, 0), ROLLUP_ALPHA_MAX, 'a single cell is full');
  assert.equal(countLabel(7), '7');
  assert.equal(countLabel(999), '999');
  assert.equal(countLabel(1000), '1k');
  assert.equal(countLabel(1234), '1.2k');
  assert.equal(countLabel(12_345), '12k');
  const cell = latLngToCell(64.1, -21.9, 3);
  const box = cellBox(cell);
  const [lat, lon] = cellToLatLng(cell);
  assert.ok(
    box.west < lon && box.east > lon && box.south < lat && box.north > lat,
  );
  assert.ok(box.east - box.west < 5);
  const dateline = cellBox(latLngToCell(66, 179.9, 3));
  assert.ok(Math.abs(dateline.west) <= 180 && Math.abs(dateline.east) <= 180);
});

test('a count label is a valid world-overlay entry that activates like a hex click', () => {
  const cell = latLngToCell(39.3, -76.6, 4);
  const flights = [];
  const entry = labelEntry({
    cell,
    count: 1234,
    accent: 'rgb(107, 232, 255)',
    cesium: Cesium,
    activate: () => flights.push(cell),
    accessibilityLabel: '1234 cameras',
  });
  const normalized = normalizeOverlayEntry('cctv-rollup', entry);
  assert.equal(normalized.id, cell);
  assert.equal(normalized.variant, 'label');
  assert.equal(normalized.title, '1.2k');
  assert.equal(normalized.accent, 'rgb(107, 232, 255)');
  assert.equal(normalized.priority, 1234);
  assert.equal(normalized.interactive, true);
  assert.equal(normalized.horizonCull, true);
  assert.equal(normalized.edgeFade, 'keyhole');
  assert.equal(normalized.accessibilityLabel, '1234 cameras');
  normalized.activate();
  assert.deepEqual(flights, [cell]);
  const carto = Cesium.Cartographic.fromCartesian(normalized.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 39.3) < 0.5);
  const passive = normalizeOverlayEntry(
    'x-rollup',
    labelEntry({ cell, count: 3, accent: '#fff', cesium: Cesium }),
  );
  assert.equal(passive.interactive, false);
  assert.equal(passive.activate, null);
});

function fakeViewer({ lat = 39.3, lon = -76.6, height = 2.2e7 } = {}) {
  const primitives = [];
  const listeners = new Set();
  const flights = [];
  const viewer = {
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
        return Cesium.Cartographic.fromDegrees(lon, lat, height);
      },
      flyTo: (options) => flights.push(options),
      moveEnd: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
  };
  return {
    viewer,
    primitives,
    flights,
    listeners,
    moveTo(next) {
      ({ lat = lat, lon = lon, height = height } = next);
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeOverlays() {
  const sources = new Map();
  const visible = new Map();
  return {
    sources,
    visible,
    setEntries: (sourceId, entries) => {
      // The real host would normalise each entry; do the same here.
      sources.set(
        sourceId,
        entries.map((e) => normalizeOverlayEntry(sourceId, e)),
      );
    },
    setVisible: (sourceId, on) => visible.set(sourceId, on),
    clearSource: (sourceId) => sources.delete(sourceId),
  };
}

function fakePicking() {
  const owners = new Map();
  return {
    owners,
    resolvePickId: (picked) => (picked?.id ? String(picked.id) : null),
    registerPickOwner: (id, predicate) => owners.set(id, predicate),
    unregisterPickOwner: (id) => owners.delete(id),
  };
}

test('from orbit 3,000 pins become hexes with counts; at 100 km the pins return; rollup off clears', () => {
  // 3,000 pins over 40° × 40°: a few hundred thousand km² per hex from
  // orbit, under a hundred pins in the 600 km window of a 100 km view.
  const points = syntheticPoints(3000, { spread: 40 });
  const env = fakeViewer({ height: 2.2e7 });
  const overlays = fakeOverlays();
  const picking = fakePicking();
  const modes = [];
  const renders = [];
  const rollup = attachPointRollup(
    {
      id: 'cams',
      viewer: env.viewer,
      overlays,
      picking,
      requestRender: (reason) => renders.push(reason),
    },
    {
      getPoints: () => points,
      accent: '#ff8800',
      onModeChange: (on) => modes.push(on),
    },
  );
  assert.equal(env.listeners.size, 1, 'listens for the camera to settle');
  assert.ok(picking.owners.has('cams-rollup'));
  assert.equal(picking.owners.get('cams-rollup')('rollup:cams:abc'), true);
  assert.equal(picking.owners.get('cams-rollup')('p12'), false);

  rollup.refresh();
  let state = rollup.getState();
  assert.deepEqual(modes, [true]);
  assert.equal(state.active, true);
  assert.equal(state.res, 0, 'orbit: resolution 0');
  assert.equal(state.inView, 3000);
  assert.equal(state.points, 3000);
  assert.ok(
    state.cells >= 1 && state.cells <= 12,
    `${state.cells} cells of 2,200 km`,
  );
  assert.equal(env.primitives.length, 1);
  assert.ok(env.primitives[0] instanceof Cesium.GroundPrimitive);
  assert.equal(
    env.primitives[0].classificationType,
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(env.primitives[0].allowPicking, true);
  const instances = env.primitives[0].geometryInstances;
  assert.ok(instances.every((i) => i.id.startsWith('rollup:cams:')));
  const labels = overlays.sources.get('cams-rollup');
  assert.equal(labels.length, state.cells);
  assert.equal(
    labels.reduce((sum, l) => sum + l.priority, 0),
    3000,
    'the labels count every pin',
  );
  assert.equal(overlays.visible.get('cams-rollup'), true);
  assert.ok(renders.includes('point-rollup'));

  // A settle at the same view changes nothing; a far move redraws.
  const primitive = env.primitives[0];
  env.moveTo({ height: 2.1e7 });
  assert.equal(env.primitives[0], primitive);
  env.moveTo({ lat: 39.3, lon: -76.6, height: 3e6 });
  state = rollup.getState();
  assert.equal(state.res, 3);
  assert.notEqual(env.primitives[0], primitive);
  assert.ok(state.cells > 20, `${state.cells} cells at resolution 3`);
  assert.deepEqual(modes, [true], 'still on: no flicker');

  // A click on a hex flies to its bounds; other picks are not ours.
  const first = instances[0]?.id || env.primitives[0].geometryInstances[0].id;
  assert.equal(rollup.handlePickedId('p12'), false);
  assert.equal(rollup.handlePickedId('rollup:cams:nothere'), false);
  const cellId = env.primitives[0].geometryInstances[0].id;
  assert.equal(rollup.handlePickedId(cellId), true);
  assert.equal(env.flights.length, 1);
  assert.ok(env.flights[0].destination instanceof Cesium.Rectangle);
  assert.ok(first);
  // The label activates the same flight.
  overlays.sources.get('cams-rollup')[0].activate();
  assert.equal(env.flights.length, 2);

  // In to 100 km: fewer than the exit count in the window, pins return.
  env.moveTo({ lat: 39.3, lon: -76.6, height: 1e5 });
  state = rollup.getState();
  assert.equal(state.active, false);
  assert.equal(env.primitives.length, 0);
  assert.equal(overlays.sources.has('cams-rollup'), false);
  assert.equal(overlays.visible.get('cams-rollup'), false);
  assert.deepEqual(modes, [true, false]);
  assert.ok(
    state.inView < ROLLUP_EXIT_COUNT,
    `${state.inView} in the 600 km window`,
  );

  // Back out: on again. Rollup off: cleared and ignored until on again.
  env.moveTo({ height: 2.2e7 });
  assert.equal(rollup.getState().active, true);
  rollup.setEnabled(false);
  assert.equal(rollup.getState().active, false);
  assert.equal(env.primitives.length, 0);
  env.moveTo({ height: 2.1e7 });
  assert.equal(env.primitives.length, 0, 'off stays off across moves');
  rollup.setEnabled(true);
  assert.equal(env.primitives.length, 1);
  assert.deepEqual(modes, [true, false, true, false, true]);

  rollup.detach();
  assert.equal(env.primitives.length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(picking.owners.has('cams-rollup'), false);
  rollup.refresh();
  assert.equal(env.primitives.length, 0, 'detached: inert');
  assert.deepEqual(modes, [true, false, true, false, true, false]);
});

test('hysteresis across the threshold: the rollup neither flickers nor lags more than one band', () => {
  const points = syntheticPoints(300, { spread: 2 });
  const env = fakeViewer({ height: 5e5 });
  const overlays = fakeOverlays();
  const modes = [];
  const rollup = attachPointRollup(
    { id: 'few', viewer: env.viewer, overlays },
    {
      getPoints: () => points,
      // The count alone: the height rule would hold it on to 250 km.
      threshold: {
        enter: 200,
        exit: 100,
        enterHeightM: Infinity,
        minHeightM: 30_000,
      },
      onModeChange: (on) => modes.push(on),
    },
  );
  rollup.refresh();
  assert.equal(
    rollup.getState().active,
    true,
    '300 > 200 in a 3,000 km window',
  );
  // Shrinking the window takes points out gradually: between 100 and 200
  // the rollup holds; below 100 it lets go; it comes back only past 200.
  const counts = [];
  for (const height of [3e5, 2e5, 1.5e5, 1e5, 7e4, 5e4, 4e4]) {
    env.moveTo({ height });
    counts.push([height, rollup.getState().inView, rollup.getState().active]);
  }
  const transitions = modes.length;
  assert.ok(
    transitions <= 2,
    `${transitions} transitions for ${JSON.stringify(counts)}`,
  );
  const lastOn = counts.filter(([, , on]) => on).at(-1);
  const firstOff = counts.find(([, , on]) => !on);
  if (lastOn && firstOff)
    assert.ok(lastOn[1] >= 100 && firstOff[1] < 100, JSON.stringify(counts));
  // Below the floor the pins always win, whatever the count.
  env.moveTo({ height: 2e4 });
  assert.equal(rollup.getState().active, false);
  rollup.detach();
});

test('a missing viewer, host or points list is tolerated', () => {
  assert.throws(() => attachPointRollup({ id: 'x' }, {}), /getPoints/);
  const rollup = attachPointRollup(
    { id: 'bare', viewer: null, overlays: null },
    { getPoints: () => null },
  );
  assert.doesNotThrow(() => rollup.refresh());
  assert.equal(rollup.getState().active, false);
  assert.doesNotThrow(() => rollup.detach());
  assert.doesNotThrow(() => rollup.detach());
});
