// Personal fork: the camera in the share link at the HUD's precision
// (src/sharelink.js, src/hud/precision.js), with the field of view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { ShareLinkManager, wrapRollDeg } from './sharelink.js';
import { DATA_FLOORS, viewPrecision } from './hud/precision.js';

const rad = (deg) => (deg * Math.PI) / 180;

/** A manager on a camera at a place, heading, pitch, roll and fov. */
function makeManager(camera, hash = '') {
  globalThis.window = {
    location: { hash, href: `http://localhost/${hash}` },
    setTimeout,
    clearTimeout,
  };
  globalThis.history = { replaceState() {} };
  const flown = [];
  const viewer = {
    camera: {
      changed: { addEventListener: () => () => {} },
      positionCartographic: {
        latitude: rad(camera.lat),
        longitude: rad(camera.lon),
        height: camera.heightM,
      },
      heading: rad(camera.headingDeg),
      pitch: rad(camera.pitchDeg),
      roll: rad(camera.rollDeg),
      frustum: { fov: rad(camera.fovDeg) },
      flyTo: (options) => {
        flown.push(options);
        options.complete?.();
      },
      setView() {},
      cancelFlight() {},
    },
    scene: { requestRender() {} },
  };
  const manager = new ShareLinkManager(viewer);
  return { manager, viewer, flown };
}

const HARBOR = {
  lat: 39.28587642,
  lon: -76.60838611,
  heightM: 31.23456,
  headingDeg: 45.6789,
  pitchDeg: -12.3456,
  rollDeg: 0.0049,
  fovDeg: 60,
};

test('near the ground the link carries about a metre; angles to 2 decimals', () => {
  const { manager } = makeManager(HARBOR);
  // Google's tiles, a 3 cm pixel: 0.1 m heights, six decimals.
  manager.setCameraPrecisionProvider(() =>
    viewPrecision({ footprintM: 0.03, floor: DATA_FLOORS.google }),
  );
  const params = manager._buildHashParams();
  assert.equal(params.get('lat'), '39.285876');
  assert.equal(params.get('lon'), '-76.608386');
  assert.equal(params.get('alt'), '31.2');
  assert.equal(params.get('heading'), '45.68');
  assert.equal(params.get('pitch'), '-12.35');
  assert.equal(params.get('roll'), '0');
  assert.equal(params.has('fov'), false, 'the default 60° is left out');
});

test('a heading a hair under 360° is written as 0', () => {
  const { manager } = makeManager({ ...HARBOR, headingDeg: 359.9991 });
  assert.equal(manager._buildHashParams().get('heading'), '0');
  const west = makeManager({ ...HARBOR, headingDeg: -90 }).manager;
  assert.equal(west._buildHashParams().get('heading'), '270');
});

test('roll is written in -180 … 180: a hair under 360° is 0 (Tahoe, 2026-10-27)', () => {
  // The live link read roll=360 for a 0.00° roll.
  for (const [rollDeg, written] of [
    [359.9991, '0'],
    [360 - 1e-9, '0'],
    [-0.0001, '0'],
    [190, '-170'],
    [-179.999, '180'],
    [180, '180'],
    [12.345, '12.35'],
  ])
    assert.equal(
      makeManager({ ...HARBOR, rollDeg })
        .manager._buildHashParams()
        .get('roll'),
      written,
      `${rollDeg}`,
    );
  assert.equal(wrapRollDeg(-540), 180);
});

test('from high up the link is short', () => {
  const { manager } = makeManager({ ...HARBOR, heightM: 4_123_456 });
  manager.setCameraPrecisionProvider(() =>
    viewPrecision({ footprintM: 3_400, floor: DATA_FLOORS.google }),
  );
  const params = manager._buildHashParams();
  assert.equal(params.get('lat'), '39.29');
  assert.equal(params.get('lon'), '-76.61');
  assert.equal(params.get('alt'), '4123000');
});

test('without the HUD, the precision links always had; a set fov is written', () => {
  const { manager } = makeManager({ ...HARBOR, fovDeg: 40.123 });
  const params = manager._buildHashParams();
  assert.equal(params.get('lat'), '39.2859');
  assert.equal(params.get('alt'), '31');
  assert.equal(params.get('fov'), '40.12');
  // A provider that throws is the same as none.
  manager.setCameraPrecisionProvider(() => {
    throw new Error('no scene');
  });
  assert.equal(manager._buildHashParams().get('lat'), '39.2859');
});

test('round trip: what is written is read back, at both precisions, with fov', async () => {
  for (const [footprintM, camera] of [
    [0.03, { ...HARBOR, fovDeg: 35.5 }],
    [3_400, { ...HARBOR, heightM: 4_123_456, fovDeg: 60 }],
  ]) {
    const writer = makeManager(camera).manager;
    writer.setCameraPrecisionProvider(() =>
      viewPrecision({ footprintM, floor: DATA_FLOORS.google }),
    );
    const hash = `#${writer._buildHashParams().toString()}`;
    const { manager: reader, viewer, flown } = makeManager(HARBOR, hash);
    const state = reader.parseInitialHash();
    const precision = viewPrecision({ footprintM, floor: DATA_FLOORS.google });
    const degreeStep = 10 ** -precision.degreeDecimals;
    assert.ok(Math.abs(state.lat - camera.lat) <= degreeStep / 2 + 1e-12);
    assert.ok(Math.abs(state.lon - camera.lon) <= degreeStep / 2 + 1e-12);
    assert.ok(
      Math.abs(state.alt - camera.heightM) <= precision.stepM / 2 + 1e-9,
    );
    assert.ok(Math.abs(state.heading - camera.headingDeg) <= 0.005);
    assert.ok(Math.abs(state.pitch - camera.pitchDeg) <= 0.005);
    assert.ok(Math.abs(state.fov - camera.fovDeg) <= 0.005);
    // Applying the link sets the field of view and flies to the place.
    await reader.applyState(state);
    assert.ok(
      Math.abs(
        Cesium.Math.toDegrees(viewer.camera.frustum.fov) - camera.fovDeg,
      ) <= 0.005,
    );
    assert.equal(flown.length, 1);
  }
});

test('older links (integers, 4 decimals, no fov) still read, at 60°', () => {
  const { manager } = makeManager(
    HARBOR,
    '#v=2&lat=39.2859&lon=-76.6084&alt=1500&heading=45&pitch=-35&roll=0',
  );
  const state = manager.parseInitialHash();
  assert.equal(state.lat, 39.2859);
  assert.equal(state.alt, 1500);
  assert.equal(state.heading, 45);
  assert.equal(state.fov, 60);
  // A field of view out of range is clamped, not passed to Cesium.
  const wide = makeManager(HARBOR, '#v=2&lat=1&lon=2&fov=400').manager;
  assert.equal(wide.parseInitialHash().fov, 150);
});

test('nav=walk or fly rides the link; Spectator leaves it out', async () => {
  const { navigationStore } = await import('./navigation/store.js');
  const { manager } = makeManager(HARBOR);
  assert.equal(manager._buildHashParams().has('nav'), false);
  navigationStore().set('walk');
  try {
    assert.equal(manager._buildHashParams().get('nav'), 'walk');
    navigationStore().set('fly');
    assert.equal(manager._buildHashParams().get('nav'), 'fly');
  } finally {
    navigationStore().set('spectator');
  }
  assert.equal(manager._buildHashParams().has('nav'), false);
});

test('Render: Blocks is in the link as bk=1, and only then', async () => {
  const { renderModeStore } = await import('./layers/lego/renderMode.js');
  const { manager } = makeManager(HARBOR);
  const mode = renderModeStore();
  try {
    assert.equal(manager._buildHashParams().has('bk'), false);
    mode.setMode('blocks');
    assert.equal(manager._buildHashParams().get('bk'), '1');
    mode.setMode('lego');
    assert.equal(manager._buildHashParams().has('bk'), false);
  } finally {
    mode.setMode('colour');
    manager.destroy?.();
  }
});
