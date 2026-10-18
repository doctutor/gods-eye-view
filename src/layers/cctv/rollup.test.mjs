// Personal fork: the Cameras layer's hex rollup part — the persisted mode,
// the row chips, and the pins hidden while the rollup stands in for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  ROLLUP_STORAGE_KEY,
  cameraPoints,
  createRollup,
  readRollupMode,
  writeRollupMode,
} from './rollup.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function fakeViewer({ lat = 39.3, lon = -76.6, height = 2.2e7 } = {}) {
  const primitives = [];
  const listeners = new Set();
  return {
    primitives,
    listeners,
    moveTo(next) {
      ({ lat = lat, lon = lon, height = height } = next);
      for (const fn of [...listeners]) fn();
    },
    viewer: {
      scene: {
        primitives: {
          add: (p) => (primitives.push(p), p),
          remove: (p) => {
            const i = primitives.indexOf(p);
            if (i >= 0) primitives.splice(i, 1);
          },
        },
      },
      camera: {
        get positionCartographic() {
          return Cesium.Cartographic.fromDegrees(lon, lat, height);
        },
        flyTo() {},
        moveEnd: {
          addEventListener(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
      },
    },
  };
}

/** Records the way the layer holds them, spread round Baltimore. */
function records(n) {
  const out = [];
  for (let i = 0; i < n; i++)
    out.push({
      // A 25° × 30° spread: thousands from orbit, under a hundred in the
      // 600 km window of a 100 km view.
      camera: {
        id: `cam-${i}`,
        lat: 27 + (i % 50) * 0.5,
        lon: -90 + Math.floor(i / 50) * 0.5,
      },
      billboard: { show: true },
    });
  return out;
}

function fixture({ n = 3000, storage = memoryStorage(), view = {} } = {}) {
  const env = fakeViewer(view);
  const calls = [];
  const sources = new Map();
  const layerState = {
    _viewer: env.viewer,
    _enabled: true,
    _records: records(n),
    _billboards: { show: true },
    _rollupHidesPins: false,
    _cctvOverlayHost: {
      setEntries: (id, entries) => sources.set(id, entries),
      setVisible: (id, on) => calls.push(['visible', id, on]),
      clearSource: (id) => sources.delete(id),
    },
  };
  const parts = {
    rendering: { refreshHorizonCulling: () => calls.push(['cull']) },
    cards: { refreshAmbientCards: () => calls.push(['cards']) },
    presentation: { notifyListeners: () => calls.push(['notify']) },
  };
  const services = {
    picking: {
      resolvePickId: () => null,
      registerPickOwner: (id) => calls.push(['own', id]),
      unregisterPickOwner: (id) => calls.push(['disown', id]),
    },
    render: {
      governorRequestRender: (reason) => calls.push(['render', reason]),
    },
  };
  const part = createRollup({ state: layerState, parts, services });
  return { env, calls, sources, layerState, parts, part, storage };
}

test('the mode persists: auto by default, off saved, a broken storage tolerated', () => {
  const storage = memoryStorage();
  assert.equal(readRollupMode(storage), 'auto');
  writeRollupMode('off', storage);
  assert.equal(storage.map.get(ROLLUP_STORAGE_KEY), 'off');
  assert.equal(readRollupMode(storage), 'off');
  writeRollupMode('auto', storage);
  assert.equal(storage.map.has(ROLLUP_STORAGE_KEY), false);
  writeRollupMode('anything', storage);
  assert.equal(readRollupMode(storage), 'auto');
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readRollupMode(broken), 'auto');
  assert.doesNotThrow(() => writeRollupMode('off', broken));
  assert.equal(readRollupMode(undefined), 'auto');
  assert.deepEqual(
    cameraPoints([{ camera: { id: 'a', lat: 1, lon: 2 } }, {}, null]),
    [{ id: 'a', lat: 1, lon: 2 }],
  );
});

test('on enable the rollup draws from orbit and hides the pins; on disable both go', async () => {
  const { env, calls, sources, layerState, part } = fixture();
  let rowUpdates = 0;
  part.methods.setRowControlsListener(() => rowUpdates++);
  part.start();
  await Promise.resolve();
  assert.equal(part.getRollupMode(), 'auto');
  const state = part.getRollupState();
  assert.equal(state.active, true);
  assert.equal(state.res, 0);
  assert.equal(state.inView, 3000);
  assert.equal(layerState._rollupHidesPins, true);
  assert.equal(layerState._billboards.show, false, 'the pin collection hides');
  assert.ok(
    calls.some(([kind]) => kind === 'cull'),
    'per-pin visibility re-run',
  );
  assert.ok(calls.some(([kind]) => kind === 'notify'));
  assert.ok(
    calls.some(([kind]) => kind === 'cards'),
    'the ambient cards re-run (none while the hexes show)',
  );
  assert.ok(rowUpdates >= 1, 'the row readout repaints');
  assert.ok(calls.some(([kind, id]) => kind === 'own' && id === 'cctv-rollup'));
  assert.equal(env.primitives.length, 1);
  assert.ok(sources.get('cctv-rollup').length >= 1, 'count labels published');
  assert.ok(calls.some(([k, , on]) => k === 'visible' && on === true));

  const controls = part.methods.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => [chip.id, chip.label, chip.active]),
    [
      ['rollup-auto', 'ROLLUP AUTO', true],
      ['rollup-off', 'OFF', false],
    ],
  );
  assert.match(controls.info, /^3000 cameras in \d+ hexes at resolution 0$/);

  // In to 100 km: the pins are back and the row says nothing.
  env.moveTo({ height: 1e5 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(part.getRollupState().active, false);
  assert.equal(layerState._rollupHidesPins, false);
  assert.equal(layerState._billboards.show, true);
  assert.equal(env.primitives.length, 0);
  assert.equal(part.methods.getRowControls().info, '');
  assert.ok(rowUpdates >= 2, 'and repaints again when the pins return');

  // Out again, then the layer is disabled: everything is released.
  env.moveTo({ height: 2.2e7 });
  assert.equal(part.getRollupState().active, true);
  layerState._enabled = false;
  part.stop();
  assert.equal(env.primitives.length, 0);
  assert.equal(layerState._rollupHidesPins, false);
  assert.equal(
    layerState._billboards.show,
    false,
    'disabled: the layer keeps them hidden',
  );
  assert.ok(
    calls.some(([kind, id]) => kind === 'disown' && id === 'cctv-rollup'),
  );
  assert.equal(part.getRollupState(), null);
  assert.doesNotThrow(() => part.stop());
});

test('OFF clears the hexes and shows the pins, is saved, and AUTO brings them back', async () => {
  const { env, layerState, part, storage } = fixture();
  part.start();
  assert.equal(env.primitives.length, 1);
  part.methods.getRowControls().chips[1].onClick();
  // The chip's click saves to the default storage; a test storage is
  // passed explicitly here to read the same value back.
  part.methods.setRollupMode('off', { storage });
  assert.equal(storage.map.get(ROLLUP_STORAGE_KEY), 'off');
  assert.equal(part.getRollupMode(), 'off');
  assert.equal(env.primitives.length, 0);
  assert.equal(layerState._rollupHidesPins, false);
  assert.equal(layerState._billboards.show, true);
  assert.deepEqual(
    part.methods.getRowControls().chips.map((chip) => chip.active),
    [false, true],
  );
  env.moveTo({ height: 2e7 });
  assert.equal(env.primitives.length, 0, 'off stays off across moves');
  part.methods.setRollupMode('auto', { storage });
  assert.equal(storage.map.has(ROLLUP_STORAGE_KEY), false);
  assert.equal(env.primitives.length, 1);
  assert.equal(layerState._rollupHidesPins, true);
  part.stop();
});

test('a load of more cameras is noticed through the next horizon-cull pass', async () => {
  // 200 km up (below the height rule): the count alone decides.
  const { env, layerState, part } = fixture({
    n: 100,
    view: { lat: 39, lon: -89.75, height: 2e5 },
  });
  part.start();
  assert.equal(part.getRollupState().active, false, 'a few dozen: no rollup');
  assert.equal(env.primitives.length, 0);
  // A proximity load packs 2,000 more under the view.
  for (let i = 0; i < 2000; i++)
    layerState._records.push({
      camera: {
        id: `near-${i}`,
        lat: 39 + (i % 50) * 0.01,
        lon: -89.75 + Math.floor(i / 50) * 0.01,
      },
      billboard: { show: true },
    });
  part.scheduleRefresh();
  part.scheduleRefresh();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(part.getRollupState().active, true);
  assert.ok(part.getRollupState().inView > 2000);
  assert.equal(env.primitives.length, 1);
  part.stop();
});

test('without a viewer the part is inert', () => {
  const { layerState, part } = fixture();
  layerState._viewer = null;
  assert.doesNotThrow(() => part.start());
  assert.equal(part.getRollupState(), null);
  assert.doesNotThrow(() => part.scheduleRefresh());
  assert.equal(part.methods.getRowControls().chips.length, 2);
});
