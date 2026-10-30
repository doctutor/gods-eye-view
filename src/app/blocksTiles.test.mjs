// Personal fork: the precomputed Blocks tilesets in the app
// (src/app/blocksTiles.js): the box the controller names shown with the
// Blocks shader, its variant by the Buildings switch, raised by the geoid,
// a hole where the live chunks draw, its tile Models fogless.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  TILES_CACHE_BYTES,
  TILES_SCREEN_ERROR,
  createBlocksTilesLayer,
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
      const tileset = {
        url,
        options,
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
  assert.equal(tileset.options.cacheBytes, TILES_CACHE_BYTES);
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
