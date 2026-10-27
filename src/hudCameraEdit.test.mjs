// Personal fork: the HUD applies an edited camera number (src/hud.js
// _applyCameraEdit): the whole view is set so the other numbers hold, the
// field of view goes on the frustum, AGL is the sampled surface plus the
// number typed, and the share link is told.
//
// hud.js imports `mgrs`, a CommonJS package Node's ESM loader cannot see,
// so a module hook stubs that one specifier (as hudAltitudeDatum.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as Cesium from 'cesium';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL)
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function forward() { return "18SUJ6000040000"; }\nexport default { forward };\n',
      };
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const rad = (deg) => (deg * Math.PI) / 180;

/** What the scene's sampleHeight answers (12.4 m unless a test says). */
let surfaceAnswer = () => 12.4;

/** A camera over the Inner Harbor and a scene whose surface is 12.4 m up. */
function setup({ surfaceSource } = {}) {
  const views = [];
  let moveEnds = 0;
  const camera = {
    heading: rad(45),
    pitch: rad(-30),
    roll: 0,
    frustum: { fov: rad(60) },
    positionCartographic: {
      latitude: rad(39.2858),
      longitude: rad(-76.6083),
      height: 500,
    },
    get positionWC() {
      return Cesium.Cartographic.toCartesian(this.positionCartographic);
    },
    getPickRay: () => undefined,
    computeViewRectangle: () => undefined,
    moveEnd: {
      addEventListener() {},
      removeEventListener() {},
      raiseEvent: () => moveEnds++,
    },
    setView(view) {
      views.push(view);
      const carto = Cesium.Cartographic.fromCartesian(view.destination);
      this.positionCartographic = carto;
      this.heading = view.orientation.heading;
      this.pitch = view.orientation.pitch;
      this.roll = view.orientation.roll;
    },
  };
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 1000, clientHeight: 600 },
      globe: { show: true, pick: () => undefined },
      sampleHeight: () => surfaceAnswer(),
      requestRender() {},
    },
  };
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  let edited = 0;
  const hud = new IntelHUD(viewer, {
    onCameraEdited: () => edited++,
    ...(surfaceSource ? { surfaceSource } : {}),
  });
  return {
    hud,
    camera,
    views,
    moveEnds: () => moveEnds,
    edited: () => edited,
  };
}

test('an edited heading sets the whole view, the other numbers held, and tells the link', () => {
  const s = setup();
  try {
    assert.equal(s.hud._applyCameraEdit('heading', 90), true);
    assert.equal(s.views.length, 1);
    const carto = s.camera.positionCartographic;
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - 39.2858) < 1e-9);
    assert.ok(Math.abs(carto.height - 500) < 1e-6);
    assert.ok(Math.abs(Cesium.Math.toDegrees(s.camera.heading) - 90) < 1e-9);
    assert.ok(Math.abs(Cesium.Math.toDegrees(s.camera.pitch) + 30) < 1e-9);
    assert.equal(s.edited(), 1);
    assert.equal(s.moveEnds(), 0, 'a camera move reports its own moveEnd');
  } finally {
    s.hud.destroy();
  }
});

test('FOV goes on the frustum and is announced as a view change; AGL rides the surface', () => {
  const s = setup();
  try {
    assert.equal(s.hud._applyCameraEdit('fov', 40), true);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(s.camera.frustum.fov) - 40) < 1e-9,
    );
    assert.equal(s.moveEnds(), 1);
    // Eye level: 1.7 m above the 12.4 m surface.
    assert.equal(s.hud._applyCameraEdit('agl', 1.7), true);
    assert.ok(Math.abs(s.camera.positionCartographic.height - 14.1) < 1e-6);
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(s.camera.frustum.fov) - 40) < 1e-9,
    );
    // Numbers a field does not take leave the camera alone.
    const before = s.views.length;
    assert.equal(s.hud._applyCameraEdit('pitch', -120), false);
    assert.equal(s.hud._applyCameraEdit('lat', Number.NaN), false);
    assert.equal(s.views.length, before);
    assert.equal(s.edited(), 2);
  } finally {
    s.hud.destroy();
  }
});

test('a surface sampled at -23.8 km is not the ground: AGL waits, then takes a sane one', () => {
  surfaceAnswer = () => -23_800;
  const s = setup();
  try {
    s.hud._updateCameraData();
    assert.ok(Number.isNaN(s.hud._latestMetrics.aglM), 'not 25,700 m');
    // Asked again a second later, with a sane answer this time.
    surfaceAnswer = () => 12.4;
    s.hud._updateCameraData();
    assert.ok(Number.isNaN(s.hud._latestMetrics.aglM), 'not before the retry');
    s.hud._surface.at -= 1000;
    s.hud._updateCameraData();
    assert.ok(Math.abs(s.hud._latestMetrics.aglM - (500 - 12.4)) < 1e-6);
    // An AGL edit needs a sane surface too.
    surfaceAnswer = () => -23_800;
    assert.equal(s.hud._applyCameraEdit('agl', 1.7), false);
  } finally {
    surfaceAnswer = () => 12.4;
    s.hud.destroy();
  }
});

test('a tile load re-samples a missing surface at once: AGL resolves as the leaves arrive', () => {
  // The tileset under the view, with Cesium's tileLoad and allTilesLoaded.
  const listeners = { tileLoad: new Set(), allTilesLoaded: new Set() };
  const event = (name) => ({
    addEventListener: (f) => listeners[name].add(f),
    removeEventListener: (f) => listeners[name].delete(f),
  });
  const tileset = {
    tileLoad: event('tileLoad'),
    allTilesLoaded: event('allTilesLoaded'),
  };
  surfaceAnswer = () => Number.NaN;
  const s = setup({
    surfaceSource: () => ({ tilesetShown: true, tileset }),
  });
  try {
    s.hud._updateCameraData();
    assert.ok(Number.isNaN(s.hud._latestMetrics.aglM));
    assert.equal(listeners.tileLoad.size, 1);
    assert.equal(listeners.allTilesLoaded.size, 1);
    // The leaves load: the next tick samples again, not a second later.
    surfaceAnswer = () => 12.4;
    s.hud._updateCameraData();
    assert.ok(Number.isNaN(s.hud._latestMetrics.aglM), 'no load, no retry yet');
    for (const f of listeners.tileLoad) f({});
    s.hud._updateCameraData();
    assert.ok(Math.abs(s.hud._latestMetrics.aglM - (500 - 12.4)) < 1e-6);
  } finally {
    surfaceAnswer = () => 12.4;
    s.hud.destroy();
  }
  assert.equal(listeners.tileLoad.size, 0, 'destroy stops listening');
  assert.equal(listeners.allTilesLoaded.size, 0);
});

test('the live diagnostics handle comes and goes with the HUD', () => {
  globalThis.window = {};
  const s = setup();
  try {
    const report = globalThis.window.__gevHudCamera.diagnostics();
    assert.equal(report.surface.sampleHeightM, 12.4);
    assert.equal(report.used.surface.via, 'sample');
  } finally {
    s.hud.destroy();
  }
  assert.equal(globalThis.window.__gevHudCamera, undefined);
  delete globalThis.window;
});

test('the precision the link gets: the floor of the surface under the camera', () => {
  const s = setup();
  try {
    // No hit at the centre: the camera's height stands in for the distance.
    const precision = s.hud.cameraPrecision();
    assert.ok(precision.footprintM > 0.5 && precision.footprintM < 0.6);
    assert.equal(precision.floor.id, 'flat', 'untagged terrain: the ellipsoid');
    assert.equal(precision.stepM, 10, 'its 30 m floor: heights to 10 m');
  } finally {
    s.hud.destroy();
  }
});
