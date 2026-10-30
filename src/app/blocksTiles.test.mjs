// Personal fork: the precomputed Blocks tilesets in the app
// (src/app/blocksTiles.js): the box the controller names shown with the
// Blocks shader, its variant by the Buildings switch, raised by the geoid,
// a hole where the live chunks draw, its tile Models fogless.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  FAR_SCREEN_ERROR,
  TILES_SCREEN_ERROR,
  GUARD_STEP,
  HOLE_SIDES,
  INSIDE_HOLE_BLOCKS,
  createBlocksTilesLayer,
  createCacheGuard,
  holePlanes,
  screenErrorFor,
} from './blocksTiles.js';

// Cesium's CustomShader asks whether a uniform is a canvas or an image.
const BROWSER_GLOBALS = [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
];
const prior = new Map();
before(() => {
  for (const key of BROWSER_GLOBALS) {
    prior.set(key, globalThis[key]);
    globalThis[key] ??= class {};
  }
});
after(() => {
  for (const [key, value] of prior)
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

const INDEX = {
  schema: 'blocks-tiles/1',
  boxes: [
    {
      name: 'harbour-30',
      built: '2026-10-30T01:13:39Z',
      anchor: { lon0: -76.64, lat0: 39.24 },
      levelsM: [120, 30],
      finestM: 30,
      variants: [
        { file: 'tileset.json', name: 'buildings' },
        { file: 'tileset-ground.json', name: 'ground' },
      ],
      groups: { 120: [[0, 0]], 30: [[0, 0]] },
    },
  ],
};

function setup({ buildings = true } = {}) {
  const viewer = {
    scene: {
      primitives: new Cesium.PrimitiveCollection(),
      preRender: new Cesium.Event(),
      requestRender() {},
      camera: {
        positionCartographic: Cesium.Cartographic.fromDegrees(
          -76.6,
          39.27,
          5000,
        ),
        viewMatrix: Cesium.Matrix4.IDENTITY,
        moveStart: new Cesium.Event(),
        moveEnd: new Cesium.Event(),
      },
    },
  };
  const made = [];
  const switches = { buildings };
  const layer = createBlocksTilesLayer({
    viewer,
    fetchIndex: async () => INDEX,
    buildings: () => switches.buildings,
    createTileset: async (url, options) => {
      // Cesium's: setting the maximum error resets the memory-adjusted one.
      let maximum = options.maximumScreenSpaceError;
      const tileset = {
        url,
        options,
        memoryAdjustedScreenSpaceError: maximum,
        get maximumScreenSpaceError() {
          return maximum;
        },
        set maximumScreenSpaceError(value) {
          maximum = value;
          tileset.memoryAdjustedScreenSpaceError = value;
        },
        show: true,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        tileLoad: new Cesium.Event(),
        update() {},
        destroy() {
          tileset.destroyed = true;
        },
        isDestroyed: () => Boolean(tileset.destroyed),
      };
      made.push(tileset);
      return tileset;
    },
  });
  return { viewer, layer, made, switches };
}

const TILES = Object.freeze({
  mode: 'hybrid',
  box: 'harbour-30',
  label: 'harbour',
  month: '2026-10',
  finestM: 30,
  floorM: 30,
  hole: { lon: -76.6, lat: 39.27, radiusM: 7680 },
  datumOffsetM: -33.5,
  fog: { startM: 30_000, endM: 40_000 },
});

test('the box the controller names: its tileset made once with the Blocks shader, shown, its variant by the Buildings switch; none when the status has no tiles', async () => {
  const { layer, made, switches, viewer } = setup();
  await layer.ready;
  assert.deepEqual(layer.getState().boxes, ['harbour-30']);
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  assert.equal(made.length, 1);
  const [tileset] = made;
  assert.equal(tileset.url, '/api/blocks/tiles/harbour-30/tileset.json');
  assert.equal(tileset.options.customShader, layer.shader);
  assert.equal(tileset.options.maximumScreenSpaceError, TILES_SCREEN_ERROR);
  assert.equal(TILES_SCREEN_ERROR, 4);
  assert.equal(tileset.options.dynamicScreenSpaceError, false);
  // Cesium's own cache: no cacheBytes of ours.
  assert.equal(tileset.options.cacheBytes, undefined);
  assert.equal(tileset.options.shadows, Cesium.ShadowMode.DISABLED);
  assert.equal(tileset.options.environmentMapOptions.enabled, false);
  assert.equal(tileset.options.imageBasedLighting.enabled, false);
  assert.ok(viewer.scene.primitives.contains(tileset));
  assert.equal(tileset.show, true);
  // The Buildings switch off: the ground variant, the other kept hidden.
  switches.buildings = false;
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  assert.equal(made.length, 2);
  assert.equal(made[1].url, '/api/blocks/tiles/harbour-30/tileset-ground.json');
  assert.equal(made[1].show, true);
  assert.equal(tileset.show, false);
  // Back on: the first again, not made anew.
  switches.buildings = true;
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  assert.equal(made.length, 2);
  assert.equal(tileset.show, true);
  // No tiles in the status (Blocks left, no box here): hidden.
  layer.apply({ state: 'ready', tiles: null });
  assert.equal(tileset.show, false);
  assert.equal(layer.getState().shown, null);
  layer.destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('raised by the geoid along the up at the camera’s ground; the hole and the fog in the shader; each tile’s Model fogless', async () => {
  const { layer, made, viewer } = setup();
  await layer.ready;
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  const [tileset] = made;
  const lift = Cesium.Matrix4.getTranslation(
    tileset.modelMatrix,
    new Cesium.Cartesian3(),
  );
  assert.ok(Math.abs(Cesium.Cartesian3.magnitude(lift) - 33.5) < 1e-9);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
    viewer.scene.camera.positionCartographic,
  );
  assert.ok(Cesium.Cartesian3.dot(lift, up) < 0, 'down, for a negative N');
  const u = (name) => layer.shader.uniforms[name].value;
  assert.equal(u('u_holeRadiusM'), 7680);
  assert.ok(
    Cesium.Cartesian3.magnitude(u('u_holeCentreEC')) > 6e6,
    'the view is the identity here',
  );
  assert.equal(u('u_fogStartM'), 30_000);
  assert.equal(u('u_fogEndM'), 40_000);
  // The live chunks' look, edges and dither faded by pixels only.
  assert.equal(u('u_edgeStrength'), 0.12);
  assert.equal(u('u_ditherAmount'), 0.03);
  assert.ok(u('u_edgeFadeStart') >= 1e9);
  // 'tiles' (no hole): none.
  layer.apply({
    state: 'tiles',
    tiles: { ...TILES, mode: 'tiles', hole: null },
  });
  assert.equal(u('u_holeRadiusM'), 0);
  // A tile's Model, once loaded, updates without Cesium's atmosphere fog.
  const seen = [];
  const model = { update: (frameState) => seen.push(frameState) };
  tileset.tileLoad.raiseEvent({ content: { _model: model } });
  model.update({ mode: Cesium.SceneMode.SCENE3D, fog: { renderable: true } });
  assert.equal(seen[0].fog.renderable, false);
  layer.destroy();
});

test('no index (the server has none): no boxes, nothing made, the plan off', async () => {
  const viewer = {
    scene: {
      primitives: new Cesium.PrimitiveCollection(),
      preRender: new Cesium.Event(),
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const layer = createBlocksTilesLayer({
      viewer,
      fetchIndex: async () => {
        throw new Error('404');
      },
      createTileset: async () => assert.fail('made'),
    });
    await layer.ready;
    assert.deepEqual(layer.plan({ lon: 0, lat: 0, wantedM: 100 }), {
      mode: 'off',
    });
    layer.apply({ state: 'tiles', tiles: TILES });
    await settle();
    assert.equal(layer.getState().loaded.length, 0);
    layer.destroy();
  } finally {
    console.warn = warn;
  }
});

/** Cesium's memory-adjusted error over frames (Cesium3DTileset processTiles). */
function cesiumErrorTileset(maximum = TILES_SCREEN_ERROR) {
  let max = maximum;
  const tileset = {
    memoryAdjustedScreenSpaceError: max,
    get maximumScreenSpaceError() {
      return max;
    },
    set maximumScreenSpaceError(value) {
      max = value;
      tileset.memoryAdjustedScreenSpaceError = value;
    },
    raise() {
      tileset.memoryAdjustedScreenSpaceError *= 1.02;
    },
    lower() {
      tileset.memoryAdjustedScreenSpaceError = Math.max(
        tileset.memoryAdjustedScreenSpaceError / 1.02,
        max,
      );
    },
  };
  return tileset;
}

test('the cache guard: each time the cache frees after an overflow the floor steps up 1.25×, so the tiles settle at the finest step that fits instead of swinging back; the camera moving lets go', () => {
  assert.equal(GUARD_STEP, 1.25);
  const guard = createCacheGuard();
  const tileset = cesiumErrorTileset();
  // A view whose tiles fit below 6 px: over the cache under that.
  const fits = () => tileset.maximumScreenSpaceError >= 6;
  let swings = 0;
  for (let frame = 0; frame < 2000; frame++) {
    guard.update(tileset);
    if (fits()) continue;
    // Overflowing for 60 frames (the unloads lag), then freed below.
    const phase = frame % 120;
    if (phase < 60) tileset.raise();
    else {
      if (phase === 60) swings++;
      tileset.lower();
    }
  }
  // 4 → 5 → 6.25: two swings, then held.
  assert.equal(guard.steps, 2);
  assert.ok(Math.abs(guard.error - 6.25) < 1e-9);
  assert.equal(tileset.maximumScreenSpaceError, guard.error);
  assert.ok(swings <= 2, `${swings} swings`);
  // Lowered by Cesium: never under the floor.
  tileset.lower();
  assert.ok(Math.abs(tileset.memoryAdjustedScreenSpaceError - 6.25) < 1e-9);
  // The camera moves: back to the base.
  assert.equal(guard.release([tileset]), true);
  assert.equal(tileset.maximumScreenSpaceError, TILES_SCREEN_ERROR);
  assert.equal(guard.error, null);
  assert.equal(guard.release([tileset]), false, 'nothing held');
});

test('in the layer: the guard on the shown tileset, released by the camera moving or stopping', async () => {
  const { viewer, layer, made } = setup();
  await layer.ready;
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  const [tileset] = made;
  const frame = () => viewer.scene.preRender.raiseEvent();
  frame();
  for (let n = 0; n < 30; n++) {
    tileset.memoryAdjustedScreenSpaceError *= 1.02;
    frame();
  }
  tileset.memoryAdjustedScreenSpaceError /= 1.02;
  frame();
  assert.equal(
    tileset.maximumScreenSpaceError,
    TILES_SCREEN_ERROR * GUARD_STEP,
  );
  assert.equal(layer.getState().heldError, TILES_SCREEN_ERROR * GUARD_STEP);
  assert.equal(layer.getState().guardHolds, 1);
  viewer.scene.camera.moveStart.raiseEvent();
  assert.equal(tileset.maximumScreenSpaceError, TILES_SCREEN_ERROR);
  assert.equal(layer.getState().heldError, null);
  layer.destroy();
});

test('the tiles inside the hole are culled before they load: clipping planes on an octagon inscribed in the hole, on with a hole, off without', async () => {
  // The planes alone, in the hole's own east-north-up frame.
  const planes = new Cesium.ClippingPlaneCollection({
    planes: holePlanes(10_000),
    unionClippingRegions: false,
  });
  assert.equal(planes.length, HOLE_SIDES);
  const sphere = (x, y, r) => ({
    intersectPlane: (plane) =>
      Cesium.BoundingSphere.intersectPlane(
        new Cesium.BoundingSphere(new Cesium.Cartesian3(x, y, 0), r),
        plane,
      ),
  });
  const { OUTSIDE, INSIDE, INTERSECTING } = Cesium.Intersect;
  // Wholly inside the inscribed octagon (apothem 9,239 m): clipped, culled.
  assert.equal(
    planes.computeIntersectionWithBoundingVolume(sphere(0, 0, 9000)),
    OUTSIDE,
  );
  assert.equal(
    planes.computeIntersectionWithBoundingVolume(sphere(3000, -2000, 5000)),
    OUTSIDE,
  );
  // Across its edge: drawn, the shader cutting the circle.
  assert.equal(
    planes.computeIntersectionWithBoundingVolume(sphere(9000, 0, 2000)),
    INTERSECTING,
  );
  // Out past it: untouched.
  assert.equal(
    planes.computeIntersectionWithBoundingVolume(sphere(20_000, 0, 5000)),
    INSIDE,
  );
  // In the layer: the shown tileset's planes about the hole in its frame.
  const { viewer, layer, made } = setup();
  await layer.ready;
  layer.apply({ state: 'ready', tiles: TILES });
  await settle();
  const [tileset] = made;
  tileset.clippingPlanesOriginMatrix =
    Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(-76.5, 39.3),
    );
  // Set again for the tileset's own clipping origin.
  layer.apply({ state: 'ready', tiles: { ...TILES, hole: null } });
  layer.apply({ state: 'ready', tiles: TILES });
  const clipping = tileset.clippingPlanes;
  assert.equal(clipping.enabled, true);
  assert.equal(clipping.unionClippingRegions, false);
  assert.equal(layer.getState().clipped, true);
  // The hole's centre (at the datum) is inside every plane, in world terms.
  const centre = Cesium.Cartesian3.fromDegrees(
    TILES.hole.lon,
    TILES.hole.lat,
    TILES.datumOffsetM,
  );
  const world = Cesium.Matrix4.multiply(
    tileset.clippingPlanesOriginMatrix,
    clipping.modelMatrix,
    new Cesium.Matrix4(),
  );
  const at = (x, y) => ({
    intersectPlane: (plane) =>
      Cesium.BoundingSphere.intersectPlane(
        new Cesium.BoundingSphere(x, y),
        plane,
      ),
  });
  assert.equal(
    clipping.computeIntersectionWithBoundingVolume(
      at(centre, 7000),
      tileset.clippingPlanesOriginMatrix,
    ),
    OUTSIDE,
  );
  const far = Cesium.Cartesian3.fromDegrees(
    TILES.hole.lon + 0.5,
    TILES.hole.lat,
    0,
  );
  assert.equal(
    clipping.computeIntersectionWithBoundingVolume(
      at(far, 1000),
      tileset.clippingPlanesOriginMatrix,
    ),
    INSIDE,
  );
  // The planes' frame is the hole's east-north-up: its origin the centre.
  const origin = Cesium.Matrix4.getTranslation(world, new Cesium.Cartesian3());
  assert.ok(Cesium.Cartesian3.distance(origin, centre) < 0.01);
  // No hole: off.
  layer.apply({ state: 'ready', tiles: { ...TILES, hole: null } });
  viewer.scene.preRender.raiseEvent();
  assert.equal(clipping.enabled, false);
  layer.destroy();
});

test('a camera inside a tile (under its top, before the live chunks’ hole opens) opens a small hole about itself the frame it is found, kept while it stays, gone when the live hole opens', async () => {
  const { viewer, layer, made } = setup();
  await layer.ready;
  const scene = viewer.scene;
  let top = 4000;
  let samples = 0;
  scene.sampleHeightSupported = true;
  scene.sampleHeight = () => {
    samples++;
    return top;
  };
  const u = (name) => layer.shader.uniforms[name].value;
  const closed = { ...TILES, hole: null };
  layer.apply({ state: 'loading', tiles: closed });
  await settle();
  const frame = () => scene.preRender.raiseEvent();
  // Over the tiles' top (5,000 m up, the top at 4,000 m): nothing opens.
  frame();
  assert.equal(u('u_holeRadiusM'), 0);
  assert.equal(layer.getState().inside, null);
  // Under it: a hole of two floor blocks about the camera, at once.
  top = 5100;
  frame();
  assert.equal(u('u_holeRadiusM'), INSIDE_HOLE_BLOCKS * 30);
  assert.equal(layer.getState().insideOpens, 1);
  assert.equal(made[0].clippingPlanes.enabled, true, 'its tiles culled too');
  // Kept while the camera stays (the hole hides the tile from the sample).
  top = undefined;
  const asked = samples;
  frame();
  assert.equal(u('u_holeRadiusM'), INSIDE_HOLE_BLOCKS * 30);
  assert.equal(samples, asked, 'not sampled again while inside');
  // The live hole opens: it takes over.
  layer.apply({ state: 'ready', tiles: TILES });
  frame();
  assert.equal(u('u_holeRadiusM'), 7680);
  assert.equal(layer.getState().inside, null);
  // High up: never sampled.
  layer.apply({ state: 'loading', tiles: closed });
  scene.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -76.6,
    39.27,
    20_000,
  );
  const before = samples;
  frame();
  assert.equal(samples, before);
  assert.equal(u('u_holeRadiusM'), 0);
  layer.destroy();
});

test('a tileset whose finest level is 480 m or coarser refines to 8 px, a finer one to 4; its guard steps from its own error', () => {
  assert.equal(FAR_SCREEN_ERROR, 8);
  assert.equal(screenErrorFor({ finestM: 30 }), TILES_SCREEN_ERROR);
  assert.equal(screenErrorFor({ finestM: 120 }), TILES_SCREEN_ERROR);
  assert.equal(screenErrorFor({ finestM: 480 }), FAR_SCREEN_ERROR);
  assert.equal(screenErrorFor({ finestM: 1920 }), FAR_SCREEN_ERROR);
  assert.equal(screenErrorFor(null), TILES_SCREEN_ERROR);
  const guard = createCacheGuard(FAR_SCREEN_ERROR);
  const tileset = cesiumErrorTileset(FAR_SCREEN_ERROR);
  guard.update(tileset);
  for (let n = 0; n < 10; n++) {
    tileset.raise();
    guard.update(tileset);
  }
  tileset.lower();
  guard.update(tileset);
  assert.equal(tileset.maximumScreenSpaceError, FAR_SCREEN_ERROR * GUARD_STEP);
  guard.release([tileset]);
  assert.equal(tileset.maximumScreenSpaceError, FAR_SCREEN_ERROR);
});
