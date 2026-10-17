// Personal fork: screenshot-safe mode hides Windy webcams.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIDE_WINDY_STORAGE_KEY,
  createScreenshotSafe,
  hiddenForScreenshots,
  isWindyCamera,
  readHideWindy,
  writeHideWindy,
} from '../layers/cctv/screenshotSafe.js';
import {
  bindHideWindy,
  hideWindyLabels,
  panelFrameHidden,
  syncHideWindy,
} from './cctvScreenshotSafe.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const windy = { id: 'windy-1', sourceKind: 'windy', feedType: 'image' };
const traffic = { id: 'md-1', sourceKind: 'mdot', feedType: 'hls' };

test('only Windy cameras are hidden, and only while the mode is on', () => {
  assert.equal(isWindyCamera(windy), true);
  assert.equal(isWindyCamera({ sourceKind: 'WINDY' }), true);
  assert.equal(isWindyCamera(traffic), false);
  assert.equal(isWindyCamera(null), false);
  assert.equal(hiddenForScreenshots(windy, true), true);
  assert.equal(hiddenForScreenshots(windy, false), false);
  assert.equal(hiddenForScreenshots(windy, 'yes'), false);
  assert.equal(hiddenForScreenshots(traffic, true), false);
  assert.equal(panelFrameHidden({ screenshotHidden: true }), true);
  assert.equal(panelFrameHidden({ screenshotHidden: false }), false);
  assert.equal(panelFrameHidden(null), false);
});

test('the choice persists in localStorage and survives a broken storage', () => {
  const storage = memoryStorage();
  assert.equal(readHideWindy(storage), false);
  writeHideWindy(true, storage);
  assert.equal(storage.map.get(HIDE_WINDY_STORAGE_KEY), '1');
  assert.equal(readHideWindy(storage), true);
  writeHideWindy(false, storage);
  assert.equal(storage.map.has(HIDE_WINDY_STORAGE_KEY), false);
  assert.equal(readHideWindy(storage), false);
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
  assert.equal(readHideWindy(broken), false);
  assert.doesNotThrow(() => writeHideWindy(true, broken));
  assert.equal(readHideWindy(undefined), false);
});

test('switching the mode saves it, drops a Windy hover card and redraws', () => {
  const calls = [];
  const layerState = {
    _hideWindy: false,
    _hoverCardId: 'windy-1',
    _recordById: new Map([['windy-1', { camera: windy }]]),
  };
  const parts = {
    rendering: { refreshHorizonCulling: () => calls.push('pins') },
    cards: {
      refreshAmbientCards: () => calls.push('cards'),
      pushAmbientCardEntries: () => calls.push('push'),
    },
    presentation: { notifyListeners: () => calls.push('notify') },
  };
  const storage = memoryStorage();
  const { setHideWindy } = createScreenshotSafe({ state: layerState, parts });
  assert.equal(setHideWindy(true, { storage }), true);
  assert.equal(layerState._hideWindy, true);
  assert.equal(layerState._hoverCardId, null);
  assert.equal(readHideWindy(storage), true);
  assert.deepEqual(calls, ['pins', 'cards', 'push', 'notify']);
  // Setting the same value again redraws nothing.
  setHideWindy(true, { storage });
  assert.equal(calls.length, 4);
  setHideWindy(false, { storage });
  assert.equal(layerState._hideWindy, false);
  assert.equal(readHideWindy(storage), false);
  assert.equal(calls.length, 8);
});

test('the toggle flips the layer mode and shows the note while on', () => {
  const button = {
    textContent: '',
    attributes: {},
    classes: new Set(),
    classList: {
      toggle(name, on) {
        if (on) button.classes.add(name);
        else button.classes.delete(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const note = { hidden: true, textContent: '' };
  const listeners = [];
  const asked = [];
  const controls = {
    _cctvPanel: {
      querySelector: (selector) =>
        selector === '#cctv-hide-windy-btn'
          ? button
          : selector === '#cctv-windy-note'
            ? note
            : null,
    },
    _cctvState: { hideWindy: false },
    listen: (target, type, handler) =>
      listeners.push({ target, type, handler }),
    cctv: { setHideWindy: (on) => asked.push(on) },
  };
  bindHideWindy(controls);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].target, button);
  listeners[0].handler();
  assert.deepEqual(asked, [true]);

  syncHideWindy(controls, { hideWindy: true });
  assert.equal(button.textContent, 'WINDY HIDDEN');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.ok(button.classes.has('active'));
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Windy cams hidden for screenshots');

  syncHideWindy(controls, { hideWindy: false });
  assert.equal(button.textContent, 'HIDE WINDY');
  assert.equal(note.hidden, true);
  assert.deepEqual(hideWindyLabels(false), { button: 'HIDE WINDY', note: '' });
  // No markup (an embedded panel without the row): nothing to wire.
  assert.doesNotThrow(() => bindHideWindy({ _cctvPanel: null }));
  assert.doesNotThrow(() => syncHideWindy({}, { hideWindy: true }));
});

test('the layer publishes no card for a hidden Windy camera, and brings it back', async () => {
  const {
    default: cctvLayer,
    _setCctvCoverageStateForTest,
    _setCctvOverlayHostForTest,
    setCctvCardPresentationOptions,
  } = await import('../data/cctv.js');
  const publications = [];
  const windyRecord = {
    camera: {
      id: 'windy-9',
      name: 'WINDY CAM',
      city: 'Somewhere',
      sourceKind: 'windy',
      feedType: 'image',
      lat: 39.29,
      lon: -76.61,
      headingDeg: 0,
      pitchDeg: 0,
      fovDeg: 60,
      rangeM: 150,
    },
    position: { x: 1, y: 2, z: 3 },
  };
  _setCctvOverlayHostForTest({
    setEntries(sourceId, entries) {
      publications.push({ sourceId, entries });
    },
  });
  const storage = memoryStorage();
  try {
    _setCctvCoverageStateForTest({
      records: [windyRecord],
      activeCameraId: windyRecord.camera.id,
      enabled: true,
    });
    setCctvCardPresentationOptions({ activeCameraCardEnabled: true });
    assert.ok(
      publications.at(-1).entries.some(({ id }) => id === 'windy-9'),
      'shown while the mode is off',
    );
    cctvLayer.setHideWindy(true, { storage });
    assert.deepEqual(publications.at(-1).entries, []);
    assert.equal(cctvLayer.getUIState().hideWindy, true);
    cctvLayer.setHideWindy(false, { storage });
    assert.ok(publications.at(-1).entries.some(({ id }) => id === 'windy-9'));
    assert.equal(cctvLayer.getUIState().hideWindy, false);
  } finally {
    cctvLayer.setHideWindy(false, { storage });
    setCctvCardPresentationOptions({ activeCameraCardEnabled: false });
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
});
