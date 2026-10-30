// Personal fork: the Blocks renderer (src/layers/blocks/renderer.js):
// Models added, replaced and removed by key (drawn once ready, what they
// replace kept until then), model matrices for a known origin and the
// geoid lift, opaque and water primitives, the shader's uniforms, the sun
// rule, batches by feature, picking, and a real Cesium.Model from a tiny
// mesh. The Models are fakes made from the GLBs (gltf.js) unless a test
// says otherwise.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { STUDY_SUN } from './lighting.js';
import { CHUNK_COLUMNS, createRegion } from './grid.js';
import { createChunk } from './store.js';
import { buildChunkMesh } from './mesh.js';
import { readBlocksGlb } from './gltf.js';
import {
  BATCH_CHUNKS,
  BLOCKS_SHADER_FRAGMENT,
  BLOCKS_SHADER_VERTEX,
  compactPart,
  batchKeyOf,
  DITHER_DEFAULTS,
  HORIZON_SKY_DAY,
  HORIZON_SKY_DUSK,
  SKY_FOG_MAX_HEIGHT_M,
  fogColorFor,
  horizonSkyColor,
  EDGE_DEFAULTS,
  REAL_SUN_MIN_ELEVATION_DEG,
  blocksSun,
  chunkMatrix,
  createBlocksRenderer,
  model3D,
  CENTRE_QUIET_MS,
  chunkIsCurved,
  derivedBlockCoords,
  levelChunkKey,
  parseLevelChunkKey,
  regionFrame,
  ringsFog,
  splitMesh,
  BATCH_QUIET_MS,
} from './renderer.js';

// Cesium's Material asks whether a uniform is a canvas or an image.
const BROWSER_GLOBALS = [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'ImageBitmap',
  'OffscreenCanvas',
];
const priorGlobals = new Map();
before(() => {
  for (const key of BROWSER_GLOBALS) {
    priorGlobals.set(key, globalThis[key]);
    globalThis[key] ??= class {};
  }
});
after(() => {
  for (const [key, prior] of priorGlobals)
    if (prior === undefined) delete globalThis[key];
    else globalThis[key] = prior;
});

const CHUNK_M = (blockM) => 64 * blockM;

function stubRegion({ lon0 = 0, lat0 = 0, blockM = 1 } = {}) {
  return {
    lon0,
    lat0,
    blockM,
    chunkOrigin: (ci, cj) => ({
      x: ci * CHUNK_M(blockM),
      y: cj * CHUNK_M(blockM),
    }),
  };
}

function fakeViewer() {
  let renders = 0;
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    requestRender: () => renders++,
  };
  return { scene, renders: () => renders };
}

/** One block's top face (a quad at z = 1) and, with water, a translucent quad beside it. */
function tinyMesh({ water = false } = {}) {
  const quads = [[0, 0, 1, [120, 160, 80, 255]]];
  if (water) quads.push([1, 0, 1, [58, 112, 190, 170]]);
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  for (const [x, y, z, rgba] of quads) {
    const base = positions.length / 3;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]) {
      positions.push(x + dx, y + dy, z);
      normals.push(0, 0, 1);
      colors.push(...rgba);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Uint8Array.from(colors),
    indices: Uint32Array.from(indices),
    faces: quads.length,
    opaqueIndexCount: 6,
  };
}

const translation = (m) =>
  Cesium.Matrix4.getTranslation(m, new Cesium.Cartesian3());

/** The Models' promises settled (they resolve on microtasks). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A GLB read back (gltf.js readBlocksGlb) as plain arrays: each
 * primitive's kind, positions in (east, north, up), block points, feature
 * ids and index count; the property table's columns and row count.
 */
function decodeGlb(glb) {
  const { primitives, properties, featureCount } = readBlocksGlb(glb);
  return {
    primitives: primitives.map((primitive) => ({
      kind: primitive.kind,
      positions: [...primitive.positions],
      blockCoords: [...primitive.blockCoords],
      featureIds: [...primitive.featureIds],
      indexCount: primitive.indices.length,
    })),
    columns: Object.fromEntries(
      Object.entries(properties).map(([name, values]) => [name, [...values]]),
    ),
    featureCount,
  };
}

/**
 * Fake Models: the GLB decoded, ready at once (or on readyAll), a feature
 * table that records what is hidden.
 */
function fakeModels({ ready = true } = {}) {
  const made = [];
  async function createModel(glb, { modelMatrix, customShader }) {
    const shown = new Map();
    const model = {
      decoded: decodeGlb(glb),
      customShader,
      modelMatrix,
      ready,
      readyEvent: new Cesium.Event(),
      featureTableId: 0,
      featureTables: [{ setShow: (id, show) => shown.set(id, show) }],
      shown,
      destroyed: false,
      update() {},
      destroy() {
        model.destroyed = true;
      },
      isDestroyed: () => model.destroyed,
    };
    made.push(model);
    return model;
  }
  return {
    createModel,
    made,
    readyAll() {
      for (const model of made)
        if (!model.ready) {
          model.ready = true;
          model.readyEvent.raiseEvent(model);
        }
    },
  };
}

/** A renderer on a fake viewer drawing fake Models. */
function setup({ ready = true, viewer = fakeViewer(), ...options } = {}) {
  const fake = fakeModels({ ready });
  const renderer = createBlocksRenderer({
    viewer,
    createModel: fake.createModel,
    ...options,
  });
  return { viewer, renderer, fake };
}

/** The Models drawn, in the order they were added. */
const drawn = (renderer) => [...renderer.getCollection()._primitives];

/** A batch Model's chunk keys by feature row (fine chunks: 'ci:cj'). */
function batchKeys(model) {
  const { columns, featureCount } = model.decoded;
  return columns.ci
    .slice(0, featureCount / 2)
    .map((ci, s) => `${ci}:${columns.cj[s]}`);
}

/** A shader's uniform value. */
const uniform = (model, name) => model.customShader.uniforms[name].value;

test('regionFrame and chunkMatrix: ENU at the origin, moved to the chunk', () => {
  const a = Cesium.Ellipsoid.WGS84.maximumRadius;
  const frame = regionFrame(stubRegion({ lon0: 0, lat0: 0 }), 0);
  // At (0°, 0°): east is +Y, north +Z, up +X.
  const m = chunkMatrix(frame, { x: 64, y: 128 });
  const t = translation(m);
  assert.ok(Math.abs(t.x - a) < 1e-6);
  assert.ok(Math.abs(t.y - 64) < 1e-6);
  assert.ok(Math.abs(t.z - 128) < 1e-6);
  // A point 1 m up from the chunk origin is 1 m further out on +X.
  const up = Cesium.Matrix4.multiplyByPoint(
    m,
    new Cesium.Cartesian3(0, 0, 1),
    new Cesium.Cartesian3(),
  );
  assert.ok(Math.abs(up.x - a - 1) < 1e-6);
  // The geoid's N lifts the origin along up.
  const lifted = translation(
    regionFrame(stubRegion({ lon0: 0, lat0: 0 }), -33.5),
  );
  assert.ok(Math.abs(lifted.x - (a - 33.5)) < 1e-6);
});

test('splitMesh: opaque and water faces apart, vertices compacted', () => {
  const { opaque, water } = splitMesh(tinyMesh({ water: true }));
  assert.equal(opaque.indices.length, 6);
  assert.equal(water.indices.length, 6);
  assert.equal(opaque.positions.length, 12);
  assert.equal(water.positions.length, 12);
  assert.ok(
    [...water.colors].filter((_, k) => k % 4 === 3).every((a) => a === 170),
  );
  assert.equal(water.positions[0], 1); // the water quad starts at x = 1
  const dry = splitMesh(tinyMesh());
  assert.equal(dry.water, null);
  assert.equal(dry.opaque.indices.length, 6);
});

test('upsert, replace and remove by key: a Model a chunk, its water a second primitive', async () => {
  const { viewer, renderer } = setup();
  assert.equal(viewer.scene.primitives.length, 1); // the blocks collection
  renderer.setRegion(stubRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 }));
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert('1:-1', tinyMesh({ water: true }));
  assert.deepEqual(renderer.keys().sort(), ['0:0', '1:-1']);
  const collection = renderer.getCollection();
  assert.equal(collection.length, 0, 'Models are made asynchronously');
  await settle();
  assert.equal(collection.length, 2);
  const [dry, wet] = drawn(renderer);
  assert.deepEqual(
    dry.decoded.primitives.map((p) => p.kind),
    ['opaque'],
  );
  assert.deepEqual(
    wet.decoded.primitives.map((p) => p.kind),
    ['opaque', 'water'],
  );
  // Replacing a key swaps its Model once the new one is ready, not adds.
  renderer.upsert('0:0', tinyMesh({ water: true }));
  assert.equal(collection.contains(dry), true, 'kept until then');
  await settle();
  assert.equal(collection.length, 2);
  assert.equal(collection.contains(dry), false);
  assert.equal(dry.isDestroyed(), true);
  // An empty mesh removes the chunk.
  renderer.upsert('1:-1', {
    positions: new Float32Array(),
    normals: new Float32Array(),
    colors: new Uint8Array(),
    indices: new Uint32Array(),
    faces: 0,
  });
  assert.deepEqual(renderer.keys(), ['0:0']);
  assert.equal(collection.length, 1);
  renderer.remove('0:0');
  renderer.remove('nope');
  assert.equal(collection.length, 0);
  assert.ok(viewer.renders() > 0);
  renderer.destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('a Model not ready yet: what it replaces stays drawn until it is; one taken away before it is made is never added', async () => {
  const { renderer, fake } = setup({ ready: false });
  renderer.setRegion(stubRegion());
  const collection = renderer.getCollection();
  renderer.upsert('0:0', tinyMesh());
  await settle();
  const first = collection.get(0);
  fake.readyAll();
  renderer.upsert('0:0', tinyMesh({ water: true }));
  await settle();
  assert.equal(collection.length, 2, 'both while the new one loads');
  assert.equal(first.isDestroyed(), false);
  fake.readyAll();
  assert.equal(collection.length, 1);
  assert.equal(first.isDestroyed(), true);
  // Removed before its Model is made: never added, destroyed.
  renderer.upsert('1:0', tinyMesh());
  renderer.remove('1:0');
  await settle();
  assert.equal(collection.length, 1);
  assert.equal(fake.made.at(-1).isDestroyed(), true);
  renderer.destroy();
});

test('model matrices: chunk origin from the key, raised by the datum offset', async () => {
  const { renderer } = setup();
  const region = stubRegion({ lon0: 0, lat0: 0, blockM: 30 });
  const a = Cesium.Ellipsoid.WGS84.maximumRadius;
  // A flat basemap: level 0 sits on the ellipsoid.
  renderer.setRegion(region);
  renderer.upsert('2:-1', tinyMesh());
  await settle();
  const model = renderer.getCollection().get(0);
  let t = translation(model.modelMatrix);
  assert.ok(Math.abs(t.x - a) < 1e-6, 'on the ellipsoid');
  assert.ok(Math.abs(t.y - 2 * 64 * 30) < 1e-6);
  assert.ok(Math.abs(t.z - -1 * 64 * 30) < 1e-6);
  // Terrain: the controller passes the geoid's N; chunks stay and move.
  const state = renderer.setRegion(region, { datumOffsetM: 17.16 });
  assert.equal(state.datumOffsetM, 17.16);
  assert.deepEqual(renderer.keys(), ['2:-1']);
  assert.equal(renderer.getCollection().get(0), model);
  t = translation(model.modelMatrix);
  assert.ok(
    Math.abs(t.x - (a + 17.16)) < 1e-6,
    'level 0 base on mean sea level',
  );
  renderer.upsert('0:0', tinyMesh());
  await settle();
  t = translation(renderer.getCollection().get(1).modelMatrix);
  assert.ok(Math.abs(t.x - (a + 17.16)) < 1e-6);
  // Back to flat, with a Model still being made: it takes the new datum.
  renderer.upsert('1:0', tinyMesh());
  renderer.setRegion(region, { datumOffsetM: 0 });
  await settle();
  for (const each of drawn(renderer))
    assert.ok(Math.abs(translation(each.modelMatrix).x - a) < 1e-6);
  renderer.destroy();
});

test('setRegion: the same region keeps chunks, another drops them', async () => {
  const { renderer } = setup();
  renderer.setRegion(stubRegion({ lon0: 1, lat0: 2, blockM: 10 }));
  renderer.upsert('0:0', tinyMesh());
  await settle();
  renderer.setRegion(stubRegion({ lon0: 1, lat0: 2, blockM: 10 }));
  assert.deepEqual(renderer.keys(), ['0:0']);
  renderer.setRegion(stubRegion({ lon0: 1.1, lat0: 2, blockM: 10 }));
  assert.deepEqual(renderer.keys(), []);
  assert.equal(renderer.getCollection().length, 0);
  assert.throws(
    () => setup().renderer.upsert('0:0', tinyMesh()),
    /setRegion first/,
  );
  renderer.destroy();
});

test('setFog sets the shader’s fog uniforms', async () => {
  const { renderer } = setup();
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh({ water: true }));
  await settle();
  const fog = renderer.setFog({ startM: 300, endM: 640, color: '#a0c0e0' });
  assert.equal(fog.startM, 300);
  assert.equal(fog.endM, 640);
  const model = renderer.getCollection().get(0);
  assert.equal(uniform(model, 'u_fogStartM'), 300);
  assert.equal(uniform(model, 'u_fogEndM'), 640);
  assert.ok(Math.abs(uniform(model, 'u_fogColor').x - 0xa0 / 255) < 1e-6);
  assert.ok(Math.abs(uniform(model, 'u_fogColor').z - 0xe0 / 255) < 1e-6);
  // The fragment shader mixes it in after the tone.
  assert.match(
    BLOCKS_SHADER_FRAGMENT,
    /mix\(color\.rgb \* tone, u_fogColor\.rgb, fog\)/,
  );
  renderer.setFog({ endM: 900 });
  assert.equal(renderer.getState().fog.startM, 300);
  assert.equal(renderer.getState().fog.endM, 900);
  renderer.destroy();
});

test('blocksSun: the real sun above 15°, else the study sun from the south-west', () => {
  // Baltimore, 2026-06-21 17:00 UTC (about 1 pm EDT): high in the south.
  const noon = blocksSun(Date.UTC(2026, 5, 21, 17), 39.29, -76.61);
  assert.equal(noon.fixed, false);
  assert.ok(noon.elevationDeg > 70, `elevation ${noon.elevationDeg}`);
  assert.ok(
    noon.azimuthDeg > 150 && noon.azimuthDeg < 230,
    `azimuth ${noon.azimuthDeg}`,
  );
  assert.ok(noon.dir.up > 0.9);
  // Morning: east of south.
  const morning = blocksSun(Date.UTC(2026, 5, 21, 13), 39.29, -76.61);
  assert.equal(morning.fixed, false);
  assert.ok(
    morning.azimuthDeg > 70 && morning.azimuthDeg < 130,
    `azimuth ${morning.azimuthDeg}`,
  );
  assert.ok(morning.dir.east > 0.5);
  // A Date works as well as milliseconds.
  assert.deepEqual(
    blocksSun(new Date(Date.UTC(2026, 5, 21, 13)), 39.29, -76.61),
    morning,
  );
  // Night: the study sun.
  const night = blocksSun(Date.UTC(2026, 5, 21, 5), 39.29, -76.61);
  assert.equal(night.fixed, true);
  assert.ok(night.realElevationDeg < 0);
  assert.equal(night.elevationDeg, STUDY_SUN.elevationDeg);
  assert.equal(night.azimuthDeg, STUDY_SUN.azimuthDeg);
  assert.ok(night.dir.east < 0 && night.dir.north > 0, 'from the north-west');
  // Low sun (under 15°) is study too.
  const low = blocksSun(Date.UTC(2026, 11, 21, 13, 30), 39.29, -76.61);
  assert.ok(low.realElevationDeg < REAL_SUN_MIN_ELEVATION_DEG);
  assert.equal(low.fixed, true);
});

test('setSun keeps a unit direction and which sun it is', () => {
  const { renderer } = setup();
  const sun = renderer.setSun({ east: -2, north: -2, up: 4 }, { fixed: true });
  assert.ok(
    Math.abs(Math.hypot(sun.dir.east, sun.dir.north, sun.dir.up) - 1) < 1e-12,
  );
  assert.equal(renderer.getSun().fixed, true);
  renderer.destroy();
});

test('a real Cesium.Model from a tiny mesh (the default createModel): unlit under the Blocks shader, no relief, environment or image lighting of its own, picked by feature', async () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  renderer.setRegion(stubRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 }));
  renderer.upsert('0:0', tinyMesh({ water: true }));
  const collection = renderer.getCollection();
  for (let k = 0; k < 50 && !collection.length; k++) await settle();
  const model = collection.get(0);
  assert.ok(model instanceof Cesium.Model);
  assert.equal(model.allowPicking, true);
  assert.equal(model.shadows, Cesium.ShadowMode.DISABLED);
  assert.equal(model.enableVerticalExaggeration, false);
  assert.equal(model.environmentMapManager.enabled, false);
  assert.equal(model.imageBasedLighting.enabled, false);
  const shader = model.customShader;
  assert.ok(shader instanceof Cesium.CustomShader);
  assert.equal(shader.mode, Cesium.CustomShaderMode.REPLACE_MATERIAL);
  assert.equal(shader.lightingModel, Cesium.LightingModel.UNLIT);
  assert.equal(
    shader.translucencyMode,
    Cesium.CustomShaderTranslucencyMode.INHERIT,
  );
  // A pick of its features names the chunk and whether it was its water.
  assert.deepEqual(renderer.pickedChunk({ primitive: model, featureId: 0 }), {
    key: '0:0',
    water: false,
  });
  assert.deepEqual(renderer.pickedChunk({ primitive: model, featureId: 1 }), {
    key: '0:0',
    water: true,
  });
  assert.equal(renderer.pickedChunk({ primitive: {}, featureId: 0 }), null);
  assert.equal(renderer.pickedChunk(undefined), null);
  // Drawn a little nearer the eye than it is, so it wins ties with
  // terrain; the stored Y-up normal back in the region's frame.
  assert.match(
    BLOCKS_SHADER_VERTEX,
    /vsOutput\.positionMC \+= \(eyeMC - vsOutput\.positionMC\) \* 1e-4;/,
  );
  assert.match(
    BLOCKS_SHADER_VERTEX,
    /v_localNormal = vec3\(n\.x, -n\.z, n\.y\);/,
  );
  // The baked colours go to the unlit stage as linear (it makes them sRGB again).
  assert.match(BLOCKS_SHADER_FRAGMENT, /rgb = czm_srgbToLinear\(rgb\);/);
  renderer.destroy();
  assert.equal(model.isDestroyed(), true);
});

test('model3D: updates with a fogless view of the frame state, nothing outside 3D', () => {
  const seen = [];
  const model = model3D({
    update(frameState) {
      seen.push(frameState);
    },
  });
  const fog = { enabled: true, renderable: true, density: 2e-4 };
  const frameState = { mode: Cesium.SceneMode.SCENE3D, fog, commandList: [] };
  model.update(frameState);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fog.renderable, false);
  assert.equal(seen[0].fog.density, 2e-4);
  assert.equal(seen[0].commandList, frameState.commandList);
  assert.equal(fog.renderable, true, 'the scene frame state is untouched');
  // The next frame on the same frame state: the same view, read live.
  frameState.commandList = ['next'];
  model.update(frameState);
  assert.equal(seen[1], seen[0]);
  assert.deepEqual(seen[1].commandList, ['next']);
  model.update({ ...frameState, mode: Cesium.SceneMode.COLUMBUS_VIEW });
  model.update({ ...frameState, mode: Cesium.SceneMode.SCENE2D });
  assert.equal(seen.length, 2);
});

test('fog colour follows the scene background until setFog names one', async () => {
  const viewer = fakeViewer();
  viewer.scene.preRender = new Cesium.Event();
  viewer.scene.backgroundColor = Cesium.Color.BLACK.clone();
  const { renderer } = setup({ viewer });
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  await settle();
  const color = () => uniform(renderer.getCollection().get(0), 'u_fogColor');
  assert.deepEqual(renderer.getState().fog.color, [0, 0, 0, 1]);
  assert.equal(renderer.getState().fog.followsBackground, true);
  // The background changes: the next frame takes it.
  viewer.scene.backgroundColor = new Cesium.Color(0.2, 0.4, 0.6, 1);
  viewer.scene.preRender.raiseEvent(viewer.scene);
  assert.ok(Math.abs(color().y - 0.4) < 1e-6);
  // A named colour holds against background changes.
  const fog = renderer.setFog({ startM: 400, endM: 512, color: [1, 0, 0, 1] });
  assert.equal(fog.followsBackground, false);
  viewer.scene.backgroundColor = Cesium.Color.WHITE.clone();
  viewer.scene.preRender.raiseEvent(viewer.scene);
  assert.equal(color().x, 1);
  assert.equal(color().y, 0);
  // 'background' follows again.
  renderer.setFog({ color: 'background' });
  assert.equal(color().y, 1);
  assert.equal(renderer.getState().fog.endM, 512);
  renderer.destroy();
  assert.equal(viewer.scene.preRender.numberOfListeners, 0);
});

test('a far chunk drops onto the ellipsoid: chunkOrigin z in the translation', async () => {
  const { renderer } = setup();
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 30 });
  renderer.setRegion(region);
  // Chunk (8, 0) of 30 m blocks starts 15.4 km east of the origin.
  renderer.upsert('8:0', tinyMesh());
  await settle();
  const { z } = region.chunkOrigin(8, 0);
  assert.ok(z < -15 && z > -21, `drop ${z}`);
  const corner = translation(renderer.getCollection().get(0).modelMatrix);
  const height = Cesium.Cartographic.fromCartesian(corner).height;
  assert.ok(
    Math.abs(height) < 0.01,
    `the chunk corner is ${height} m off the ellipsoid`,
  );
  // With the geoid's N the corner sits N above it.
  renderer.setRegion(region, { datumOffsetM: -33.5 });
  const lifted = translation(renderer.getCollection().get(0).modelMatrix);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(lifted).height + 33.5) < 0.01,
  );
  renderer.destroy();
});

test('splitMesh cuts at opaqueIndexCount and renumbers each part', () => {
  const mesh = tinyMesh({ water: true });
  const { opaque, water } = splitMesh(mesh);
  assert.deepEqual([...opaque.indices], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...water.indices], [0, 1, 2, 0, 2, 3]);
  assert.equal(water.colors[3], 170);
  // No water: the mesh's own arrays, no copy.
  const dry = tinyMesh();
  const parts = splitMesh(dry);
  assert.equal(parts.opaque.positions, dry.positions);
  assert.equal(parts.water, null);
  // All water.
  const wet = { ...mesh, opaqueIndexCount: 0 };
  assert.equal(splitMesh(wet).opaque, null);
});

test('the real mesher into the renderer: a land and sea chunk, its opaque and water primitives', async () => {
  const { renderer } = setup();
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  renderer.setRegion(region);
  const top = new Int32Array(CHUNK_COLUMNS * CHUNK_COLUMNS);
  const water = new Int32Array(CHUNK_COLUMNS * CHUNK_COLUMNS).fill(-2147483648);
  for (let j = 0; j < CHUNK_COLUMNS; j++)
    for (let i = 0; i < CHUNK_COLUMNS; i++) {
      const k = j * CHUNK_COLUMNS + i;
      if (i < 20) {
        top[k] = -2;
        water[k] = 0;
      } else top[k] = Math.floor((i - 20) / 4);
    }
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  const mesh = buildChunkMesh(chunk, { blockM: 1 });
  assert.ok(
    mesh.opaqueIndexCount > 0 && mesh.opaqueIndexCount < mesh.indices.length,
  );
  renderer.upsert('0:0', mesh);
  await settle();
  const [opaque, sea] = renderer.getCollection().get(0).decoded.primitives;
  assert.equal(opaque.kind, 'opaque');
  assert.equal(sea.kind, 'water');
  assert.equal(opaque.indexCount + sea.indexCount, mesh.indices.length);
  renderer.destroy();
});

test('block edges and top dither: on by default for land, never for water (the shader keys on full alpha), blockM from the region', async () => {
  const { renderer } = setup();
  renderer.setRegion(stubRegion({ blockM: 30 }));
  renderer.upsert('3:-2', tinyMesh({ water: true }));
  await settle();
  const model = renderer.getCollection().get(0);
  assert.equal(uniform(model, 'u_blockM'), 30);
  assert.equal(uniform(model, 'u_edgeStrength'), EDGE_DEFAULTS.strength);
  assert.equal(uniform(model, 'u_edgeStrength'), 0.12);
  assert.equal(uniform(model, 'u_edgeFadeStart'), 200);
  assert.equal(uniform(model, 'u_edgeFadeEnd'), 300);
  assert.equal(uniform(model, 'u_ditherAmount'), DITHER_DEFAULTS.amount);
  assert.equal(uniform(model, 'u_ditherAmount'), 0.03);
  assert.match(
    BLOCKS_SHADER_FRAGMENT,
    /float land = step\(0\.999, color\.a\);/,
  );
  assert.match(
    BLOCKS_SHADER_FRAGMENT,
    /u_edgeStrength \* land \* line \* fade/,
  );
  assert.match(BLOCKS_SHADER_FRAGMENT, /u_ditherAmount \* land \* ditherFade/);
  // Each chunk's columns are folded into its block points (3 × 64 east,
  // −2 → 62 × 64 north), so the dither's hash of floor(f.xy) runs on
  // across chunks; the derived ones are positions over 30 m.
  const [land] = model.decoded.primitives;
  assert.equal(land.blockCoords[0], 192);
  assert.equal(land.blockCoords[1], 3968);
  assert.ok(Math.abs(land.blockCoords[2] - 1 / 30) < 1e-6);
  assert.match(BLOCKS_SHADER_FRAGMENT, /blocks_hash\(floor\(f\.xy\)\)/);
  assert.match(BLOCKS_SHADER_FRAGMENT, /fwidth\(f\)/);
  assert.deepEqual(renderer.getState().style, {
    edges: { ...EDGE_DEFAULTS },
    dither: { ...DITHER_DEFAULTS },
  });
  renderer.destroy();
});

test('edges and dither options: off, settings, and setStyle', async () => {
  const off = setup({ edges: false, dither: false }).renderer;
  off.setRegion(stubRegion());
  off.upsert('0:0', tinyMesh());
  await settle();
  const model = off.getCollection().get(0);
  assert.equal(uniform(model, 'u_edgeStrength'), 0);
  assert.equal(uniform(model, 'u_ditherAmount'), 0);
  assert.deepEqual(off.getState().style, { edges: null, dither: null });
  // setStyle turns them on, with settings merged over the defaults.
  const style = off.setStyle({
    edges: { strength: 0.2, fadeEndBlocks: 150 },
    dither: true,
  });
  assert.deepEqual(style.edges, {
    strength: 0.2,
    fadeStartBlocks: 200,
    fadeEndBlocks: 150,
  });
  assert.equal(uniform(model, 'u_edgeStrength'), 0.2);
  assert.equal(uniform(model, 'u_edgeFadeEnd'), 150);
  assert.equal(uniform(model, 'u_ditherAmount'), 0.03);
  // Leaving one out keeps it; false turns it off.
  off.setStyle({ dither: false });
  assert.equal(uniform(model, 'u_edgeStrength'), 0.2);
  assert.equal(uniform(model, 'u_ditherAmount'), 0);
  off.destroy();
  const custom = setup({ dither: { amount: 0.05 } }).renderer;
  custom.setRegion(stubRegion({ blockM: 2 }));
  custom.upsert('0:0', tinyMesh());
  await settle();
  const other = custom.getCollection().get(0);
  assert.equal(uniform(other, 'u_ditherAmount'), 0.05);
  assert.equal(uniform(other, 'u_edgeStrength'), 0.12);
  assert.equal(uniform(other, 'u_blockM'), 2);
  custom.destroy();
});

test('horizonSkyColor: day blue by day, dusk blue after twilight, a blend between', () => {
  assert.deepEqual(horizonSkyColor(30), [...HORIZON_SKY_DAY]);
  assert.deepEqual(horizonSkyColor(10), [...HORIZON_SKY_DAY]);
  assert.deepEqual(horizonSkyColor(-10), [...HORIZON_SKY_DUSK]);
  const mid = horizonSkyColor(2); // halfway from −6° to 10°
  for (let k = 0; k < 3; k++) {
    assert.ok(mid[k] > HORIZON_SKY_DUSK[k] && mid[k] < HORIZON_SKY_DAY[k]);
    assert.ok(
      Math.abs(mid[k] - (HORIZON_SKY_DUSK[k] + HORIZON_SKY_DAY[k]) / 2) < 1e-9,
    );
  }
  // The atmosphere's brightness shift darkens or brightens it, within 0…1.
  const dim = horizonSkyColor(30, -0.5);
  assert.ok(Math.abs(dim[2] - HORIZON_SKY_DAY[2] / 2) < 1e-9);
  assert.equal(horizonSkyColor(30, 1)[2], 1);
});

test('fogColorFor: the horizon sky near the ground with the atmosphere shown, else the background', () => {
  const scene = {
    skyAtmosphere: { show: true, brightnessShift: 0 },
    backgroundColor: Cesium.Color.BLACK,
  };
  const low = fogColorFor(scene, { heightM: 300, sunElevationDeg: 40 });
  assert.equal(low.source, 'sky');
  assert.deepEqual(low.color, [...HORIZON_SKY_DAY, 1]);
  const high = fogColorFor(scene, {
    heightM: SKY_FOG_MAX_HEIGHT_M + 1,
    sunElevationDeg: 40,
  });
  assert.deepEqual(high, { color: [0, 0, 0, 1], source: 'background' });
  scene.skyAtmosphere.show = false;
  assert.equal(
    fogColorFor(scene, { heightM: 300, sunElevationDeg: 40 }).source,
    'background',
  );
  assert.equal(
    fogColorFor({}, { heightM: 300, sunElevationDeg: 40 }).color.length,
    4,
  );
  // Dusk at the ground: dark, not black.
  scene.skyAtmosphere.show = true;
  const dusk = fogColorFor(scene, { heightM: 2, sunElevationDeg: -12 });
  assert.deepEqual(dusk.color, [...HORIZON_SKY_DUSK, 1]);
});

test('the renderer fog follows the sky at eye level, the background high up, and a set colour holds', async () => {
  const viewer = fakeViewer();
  const scene = viewer.scene;
  scene.preRender = new Cesium.Event();
  scene.backgroundColor = Cesium.Color.BLACK.clone();
  scene.skyAtmosphere = { show: true, brightnessShift: 0 };
  // Baltimore at 1.7 m, early afternoon local time (the sun high).
  scene.camera = {
    positionCartographic: Cesium.Cartographic.fromDegrees(-76.61, 39.29, 1.7),
  };
  // The wall clock the renderer reads (the HUD's SUN reads the same).
  let clock = Date.UTC(2026, 5, 21, 17);
  // A frozen scene clock (the app never animates it) is not what it reads.
  viewer.clock = {
    currentTime: Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 5, 21, 5))),
  };
  const { renderer } = setup({ viewer, now: () => clock });
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  renderer.flush();
  await settle();
  const color = () => uniform(renderer.getCollection().get(0), 'u_fogColor');
  let fog = renderer.getState().fog;
  assert.equal(fog.source, 'sky');
  assert.deepEqual(fog.color, [...HORIZON_SKY_DAY, 1]);
  assert.ok(Math.abs(color().z - HORIZON_SKY_DAY[2]) < 1e-6);
  // At night the horizon is dusk blue.
  clock = Date.UTC(2026, 5, 21, 5);
  scene.preRender.raiseEvent(scene);
  assert.deepEqual(renderer.getState().fog.color, [...HORIZON_SKY_DUSK, 1]);
  // High up the fog meets the background again.
  scene.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -76.61,
    39.29,
    50_000,
  );
  scene.preRender.raiseEvent(scene);
  fog = renderer.getState().fog;
  assert.equal(fog.source, 'background');
  assert.deepEqual(fog.color, [0, 0, 0, 1]);
  // A named colour holds wherever the camera goes.
  renderer.setFog({ color: [1, 0, 0, 1] });
  scene.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -76.61,
    39.29,
    2,
  );
  scene.preRender.raiseEvent(scene);
  fog = renderer.getState().fog;
  assert.equal(fog.source, 'set');
  assert.deepEqual(fog.color, [1, 0, 0, 1]);
  // 'background' follows again: the sky, at eye level.
  renderer.setFog({ color: 'background' });
  assert.equal(renderer.getState().fog.source, 'sky');
  renderer.destroy();
});

test('batchKeyOf: fine chunks by 4 × 4 group, coarse chunks by 4 × 4 coarse chunks', () => {
  assert.equal(batchKeyOf('0:0'), 'g:0:0');
  assert.equal(batchKeyOf('3:3'), 'g:0:0');
  assert.equal(batchKeyOf('4:-1'), 'g:1:-1');
  assert.equal(batchKeyOf('-5:7'), 'g:-2:1');
  assert.equal(batchKeyOf('c:2:-3'), 's:0:-1');
  assert.equal(batchKeyOf('c:-4:8'), 's:-1:2');
  assert.equal(batchKeyOf('odd'), 'k:odd');
  assert.equal(BATCH_CHUNKS, 4);
});

/** A renderer on a fake scene with frames (preRender), a clock and a captured wake timer. */
function batchSetup({ quietMs = 1500, ready = true } = {}) {
  const viewer = fakeViewer();
  viewer.scene.preRender = new Cesium.Event();
  let clock = 1_000_000;
  const wakes = [];
  const { renderer, fake } = setup({
    viewer,
    ready,
    now: () => clock,
    // null: the renderer's own BATCH_QUIET_MS.
    ...(quietMs === null ? {} : { quietMs }),
    setTimeoutImpl(callback, ms) {
      wakes.push({ callback, ms });
      return wakes.length;
    },
    clearTimeoutImpl() {},
  });
  renderer.setRegion(stubRegion({ blockM: 1 }));
  return {
    viewer,
    renderer,
    fake,
    wakes,
    advance: (ms) => (clock += ms),
    frame: () => viewer.scene.preRender.raiseEvent(viewer.scene),
  };
}

test('a group of 16 chunks draws alone at once, then as one batch Model when quiet', async () => {
  const { renderer, advance, frame, wakes } = batchSetup();
  const collection = renderer.getCollection();
  for (let ci = 4; ci < 8; ci++)
    for (let cj = 0; cj < 4; cj++) renderer.upsert(`${ci}:${cj}`, tinyMesh());
  await settle();
  // Each chunk alone first: no wait on the batch.
  assert.equal(collection.length, 16);
  assert.equal(renderer.getState().batches, 1);
  // A frame before the batch has been quiet changes nothing …
  frame();
  await settle();
  assert.equal(collection.length, 16);
  // … and a wake is set to draw a frame when it has been.
  assert.equal(wakes.at(-1).ms, 1500);
  advance(1500);
  frame();
  await settle();
  assert.equal(collection.length, 1, 'one Model for the group');
  const batch = collection.get(0);
  // A feature a chunk and kind: 16 opaque rows, then 16 water rows.
  assert.equal(batch.decoded.featureCount, 32);
  assert.deepEqual(batch.decoded.columns.water, [
    ...Array(16).fill(0),
    ...Array(16).fill(1),
  ]);
  const keys = batchKeys(batch);
  assert.equal(new Set(keys).size, 16);
  // Positions are moved by each chunk's offset from the batch's first
  // chunk (4:0): chunk 6:1's quad starts at (128, 64).
  const s = keys.indexOf('6:1');
  const [opaque] = batch.decoded.primitives;
  const at = opaque.featureIds.indexOf(s);
  assert.deepEqual(opaque.positions.slice(at * 3, at * 3 + 3), [128, 64, 1]);
  // A pick of a feature names its chunk.
  assert.deepEqual(renderer.pickedChunk({ primitive: batch, featureId: s }), {
    key: '6:1',
    water: false,
  });
  assert.deepEqual(
    renderer.pickedChunk({ primitive: batch, featureId: 16 + s }),
    { key: '6:1', water: true },
  );
  assert.equal(renderer.keys().length, 16);
});

test('a changed or removed chunk is hidden in its batch once drawn alone, and the batch takes it back when quiet', async () => {
  const { renderer, advance, frame } = batchSetup();
  const collection = renderer.getCollection();
  for (let ci = 0; ci < 4; ci++) renderer.upsert(`${ci}:0`, tinyMesh());
  renderer.upsert('0:1', tinyMesh({ water: true }));
  renderer.flush({ all: true });
  await settle();
  // Opaque and water: one Model, two primitives.
  assert.equal(collection.length, 1);
  const batch = collection.get(0);
  assert.deepEqual(
    batch.decoded.primitives.map((p) => p.kind),
    ['opaque', 'water'],
  );
  const keys = batchKeys(batch);
  // A re-mesh: alone, and once that draws its features hidden in the batch.
  renderer.upsert('2:0', tinyMesh());
  await settle();
  assert.equal(collection.length, 2);
  const two = keys.indexOf('2:0');
  assert.equal(batch.shown.get(two), false);
  assert.equal(batch.shown.get(keys.length + two), false);
  // A removal: hidden at once, gone from the batch at the next quiet rebuild.
  renderer.remove('1:0');
  assert.equal(batch.shown.get(keys.indexOf('1:0')), false);
  advance(1500);
  frame();
  await settle();
  assert.equal(collection.length, 1);
  assert.equal(batch.isDestroyed(), true);
  assert.deepEqual(batchKeys(collection.get(0)).sort(), [
    '0:0',
    '0:1',
    '2:0',
    '3:0',
  ]);
  // Removing every chunk takes the batch away.
  for (const key of ['0:0', '0:1', '2:0', '3:0']) renderer.remove(key);
  renderer.flush({ all: true });
  await settle();
  assert.equal(collection.length, 0);
  assert.equal(renderer.getState().batches, 0);
});

test('a chunk changed while its batch is being made: hidden in the new batch, its lone Models kept until its own is ready', async () => {
  const { renderer, advance, frame, fake } = batchSetup({ ready: false });
  const collection = renderer.getCollection();
  for (let ci = 0; ci < 4; ci++) renderer.upsert(`${ci}:0`, tinyMesh());
  await settle();
  fake.readyAll();
  advance(1500);
  frame();
  await settle();
  assert.equal(collection.length, 5, 'four alone, the batch loading');
  renderer.upsert('2:0', tinyMesh({ water: true }));
  await settle();
  assert.equal(collection.length, 6);
  const batch = fake.made[4];
  fake.readyAll();
  // The batch draws: three lone Models go; 2:0 changed, so it is hidden in
  // the batch and drawn by its newest lone Model.
  assert.equal(collection.length, 2);
  assert.ok(collection.contains(batch));
  const two = batchKeys(batch).indexOf('2:0');
  assert.equal(batch.shown.get(two), false);
  assert.equal(batch.shown.get(4 + two), false);
  assert.equal(batch.shown.get(batchKeys(batch).indexOf('0:0')), undefined);
});

test('one batch a frame; flush({all}) does every pending one; a new region drops them all', async () => {
  const { renderer, advance, frame } = batchSetup();
  const collection = renderer.getCollection();
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert('4:0', tinyMesh()); // another group
  renderer.upsert('c:8:0', {
    ...tinyMesh(),
    origin: { x: 2048, y: 0, z: -0.3 },
  }); // a coarse chunk
  await settle();
  advance(1500);
  frame();
  await settle();
  assert.equal(
    collection.length,
    3,
    'one of three batches rebuilt (its chunk alone gone)',
  );
  assert.equal(renderer.getState().stats.rebuilds, 1);
  frame();
  frame();
  await settle();
  assert.equal(collection.length, 3);
  assert.equal(renderer.getState().batches, 3);
  assert.equal(renderer.getState().stats.rebuilds, 3);
  // The coarse batch keeps the coarse chunk's own origin (its z drop too).
  const ys = drawn(renderer).map((model) => translation(model.modelMatrix).y);
  assert.ok(ys.some((y) => Math.abs(y - 2048) < 1e-6));
  // A new datum moves batches and lone chunks alike, 10 m up (+X at 0°, 0°).
  renderer.upsert('1:0', tinyMesh());
  await settle();
  const at = () =>
    drawn(renderer).map((model) => translation(model.modelMatrix));
  const before = at();
  renderer.setRegion(stubRegion({ blockM: 1 }), { datumOffsetM: 10 });
  at().forEach((t, k) => {
    assert.ok(Math.abs(t.x - before[k].x - 10) < 1e-6);
    assert.ok(Math.abs(t.y - before[k].y) < 1e-6);
  });
  renderer.flush({ all: true });
  await settle();
  // Another region: nothing left.
  renderer.setRegion(stubRegion({ lon0: 1, blockM: 1 }));
  assert.equal(collection.length, 0);
  assert.deepEqual(renderer.keys(), []);
  renderer.destroy();
});

test('compactPart: byte normals and 16-bit indices, kept and counted', () => {
  const part = compactPart(tinyMesh());
  assert.ok(part.normals instanceof Int8Array);
  assert.deepEqual([...part.normals.slice(0, 3)], [0, 0, 127]);
  assert.ok(part.indices instanceof Uint16Array);
  assert.equal(compactPart(null), null);
  const { renderer } = setup();
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  // 4 vertices: 48 bytes of positions, 12 of normals, 16 of colours, 48
  // of block points (from the positions: a flat mesh without them), 12 of
  // indices.
  assert.ok(Math.abs(renderer.getState().retainedMB - 136 / 1e6) < 1e-12);
  renderer.destroy();
});

test('level chunk keys and their batches: one lattice of chunks a ring', () => {
  assert.equal(levelChunkKey(1920, -3, 7), 'L1920:-3:7');
  assert.deepEqual(parseLevelChunkKey('L1920:-3:7'), {
    blockM: 1920,
    ci: -3,
    cj: 7,
  });
  assert.equal(parseLevelChunkKey('3:7'), null);
  assert.equal(parseLevelChunkKey('c:3:7'), null);
  assert.equal(batchKeyOf('L1920:-3:7'), 'L1920:g:-1:1');
  assert.notEqual(batchKeyOf('L480:5:5'), batchKeyOf('L1920:5:5'));
  assert.notEqual(batchKeyOf('L480:5:5'), batchKeyOf('5:5'));
});

test("ringsFog: from 70% of the outermost ring's reach to it", () => {
  const regions = [{ blockM: 30 }, { blockM: 120 }, { blockM: 480 }];
  assert.deepEqual(ringsFog(regions, 512), {
    startM: 0.7 * 512 * 480,
    endM: 512 * 480,
  });
});

test('setRegions: K rings, each its frame, shader and chunks; a ring changed or gone drops only its own', async () => {
  const { renderer } = setup();
  const fine = stubRegion({ lon0: 1, lat0: 2, blockM: 30 });
  const mid = stubRegion({ lon0: 1.01, lat0: 2, blockM: 120 });
  const far = stubRegion({ lon0: 1.2, lat0: 2.1, blockM: 480 });
  // Any order, an array or a Map: the finest is the primary region.
  let state = renderer.setRegions(
    new Map([
      [480, far],
      [30, fine],
      [120, mid],
    ]),
    { fogReachBlocks: 512 },
  );
  assert.equal(state.region, fine);
  assert.deepEqual(
    state.regions.map((entry) => entry.blockM),
    [30, 120, 480],
  );
  assert.equal(state.fog.endM, 512 * 480);
  assert.equal(state.fog.startM, 0.7 * 512 * 480);
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert(levelChunkKey(120, 2, -1), tinyMesh());
  renderer.upsert(levelChunkKey(480, 0, 0), tinyMesh());
  await settle();
  const [a, b, c] = drawn(renderer);
  // Each in its own frame: a ring's chunk at its region's chunk origin.
  const expect = (region, origin) =>
    translation(chunkMatrix(regionFrame(region), origin));
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      translation(b.modelMatrix),
      expect(mid, { x: 2 * 64 * 120, y: -64 * 120 }),
      1e-6,
    ),
  );
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      translation(c.modelMatrix),
      expect(far, { x: 0, y: 0 }),
      1e-6,
    ),
  );
  // Each with its own shader and block edges.
  assert.equal(new Set([a, b, c].map((m) => m.customShader)).size, 3);
  assert.equal(uniform(a, 'u_blockM'), 30);
  assert.equal(uniform(b, 'u_blockM'), 120);
  assert.equal(uniform(c, 'u_blockM'), 480);
  // The fog reaches every ring's shader.
  for (const model of [a, b, c])
    assert.equal(uniform(model, 'u_fogEndM'), 512 * 480);
  assert.deepEqual(
    renderer.getState().regions.map((entry) => entry.chunks),
    [1, 1, 1],
  );
  // The 120 m ring moves: only its chunk goes.
  state = renderer.setRegions([
    fine,
    stubRegion({ lon0: 1.02, lat0: 2, blockM: 120 }),
    far,
  ]);
  assert.deepEqual(renderer.keys().sort(), ['0:0', 'L480:0:0']);
  // The 480 m ring is no longer asked for: its chunk and frame go.
  state = renderer.setRegions([fine, mid]);
  assert.deepEqual(renderer.keys(), ['0:0']);
  assert.throws(
    () => renderer.upsert(levelChunkKey(480, 0, 0), tinyMesh()),
    /no ring of 480 m/,
  );
  // The datum offset moves every ring's chunks too.
  renderer.upsert(levelChunkKey(120, 0, 0), tinyMesh());
  await settle();
  const ring = drawn(renderer).at(-1);
  const before = translation(ring.modelMatrix);
  renderer.setRegions([fine, mid], { datumOffsetM: 20 });
  const raised = translation(ring.modelMatrix);
  assert.ok(Math.abs(Cesium.Cartesian3.distance(before, raised) - 20) < 1e-6);
  // K = 1 as before: setRegion alone, a new primary drops the rings.
  renderer.setRegion(stubRegion({ lon0: 5, lat0: 5, blockM: 30 }));
  assert.deepEqual(renderer.keys(), []);
  assert.deepEqual(
    renderer.getState().regions.map((entry) => entry.blockM),
    [30],
  );
  renderer.destroy();
});

test("a ring's chunks batch apart from the primary's and keep their frame", async () => {
  const { renderer, advance, frame } = batchSetup();
  const fine = renderer.getState().region;
  const mid = stubRegion({ lon0: 0.01, lat0: 0, blockM: 4 });
  renderer.setRegions([fine, mid]);
  for (let ci = 0; ci < 4; ci++)
    for (let cj = 0; cj < 4; cj++) {
      renderer.upsert(`${ci}:${cj}`, tinyMesh());
      renderer.upsert(levelChunkKey(4, ci, cj), tinyMesh());
    }
  await settle();
  advance(1500);
  frame();
  frame();
  await settle();
  const collection = renderer.getCollection();
  assert.equal(renderer.getState().batches, 2);
  assert.equal(collection.length, 2);
  const ring = drawn(renderer).find(
    (model) => uniform(model, 'u_blockM') === 4,
  );
  assert.ok(ring);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      translation(ring.modelMatrix),
      translation(chunkMatrix(regionFrame(mid), { x: 0, y: 0 })),
      1e-6,
    ),
  );
  assert.equal(ring.decoded.featureCount, 32);
});

test('levelM: the block points count levels of levelM, per ring; a level change is another region', async () => {
  const { renderer } = setup();
  const fine = { ...stubRegion({ blockM: 120 }), levelM: 30 };
  const far = { ...stubRegion({ blockM: 480 }), levelM: 15 };
  renderer.setRegions([fine, far]);
  // tinyMesh's top is 1 m up: 1/30 of a 30 m level, 1/15 of a 15 m one.
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert(levelChunkKey(480, 0, 0), tinyMesh());
  await settle();
  const [a, b] = drawn(renderer);
  assert.equal(uniform(a, 'u_blockM'), 120);
  const level = (model) => model.decoded.primitives[0].blockCoords[2];
  assert.ok(Math.abs(level(a) - 1 / 30) < 1e-6);
  assert.ok(Math.abs(level(b) - 1 / 15) < 1e-6);
  // Cubes when a region has no levelM.
  renderer.setRegion(stubRegion({ blockM: 30 }));
  assert.equal(renderer.getState().region.levelM, undefined);
  renderer.upsert('0:0', tinyMesh());
  await settle();
  assert.ok(Math.abs(level(renderer.getCollection().get(0)) - 1 / 30) < 1e-6);
  // The same anchor and block on other levels: its chunks go.
  renderer.setRegion({ ...stubRegion({ blockM: 30 }), levelM: 15 });
  assert.deepEqual(renderer.keys(), []);
  renderer.destroy();
});

test('curved chunks (1,920 m and up) draw without block edges or dither; flat ones keep them', async () => {
  assert.equal(chunkIsCurved('0:0', null, 480), false);
  assert.equal(chunkIsCurved('c:0:0', null, 480), true); // 4 × 480 m
  assert.equal(chunkIsCurved('0:0', null, 1920), true);
  assert.equal(chunkIsCurved('L7680:0:0', null, 30), true);
  assert.equal(chunkIsCurved('L480:0:0', null, 30), false);
  assert.equal(chunkIsCurved('0:0', { curved: false }, 1920), false);
  const { renderer } = setup();
  renderer.setRegions([
    stubRegion({ blockM: 480 }),
    stubRegion({ blockM: 1920 }),
  ]);
  renderer.upsert('0:0', tinyMesh());
  // A coarse chunk carries its origin (the controller sets it).
  renderer.upsert('c:0:0', { ...tinyMesh(), origin: { x: 0, y: 0, z: 0 } });
  renderer.upsert(levelChunkKey(1920, 0, 0), tinyMesh());
  await settle();
  const [flat, coarse, ring] = drawn(renderer);
  assert.equal(uniform(flat, 'u_edgeStrength'), EDGE_DEFAULTS.strength);
  assert.equal(uniform(flat, 'u_ditherAmount'), DITHER_DEFAULTS.amount);
  for (const curved of [coarse, ring]) {
    assert.equal(uniform(curved, 'u_edgeStrength'), 0);
    assert.equal(uniform(curved, 'u_ditherAmount'), 0);
  }
  // The fog still reaches them.
  renderer.setFog({ startM: 10, endM: 20 });
  assert.equal(uniform(ring, 'u_fogEndM'), 20);
  // setStyle never turns them back on.
  renderer.setStyle({ edges: true, dither: true });
  assert.equal(uniform(coarse, 'u_edgeStrength'), 0);
  renderer.destroy();
});

test('batches are built nearest the view centre first, and one covering the centre after 250 ms, not 1.5 s', async () => {
  const viewer = fakeViewer();
  viewer.scene.preRender = new Cesium.Event();
  let clock = 1_000_000;
  let centre = null;
  const { renderer } = setup({
    viewer,
    now: () => clock,
    quietMs: 1500,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl() {},
    viewCentre: () => centre,
  });
  const region = stubRegion({ lon0: 0, lat0: 0, blockM: 30 });
  renderer.setRegion(region);
  // Three batches 4 × 4 chunks of 1,920 m: groups (0, 0), (5, 0), (10, 0).
  for (const gi of [0, 5, 10])
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++)
        renderer.upsert(`${gi * 4 + a}:${b}`, tinyMesh());
  const frame = async () => {
    viewer.scene.preRender.raiseEvent(viewer.scene);
    await settle();
  };
  const batched = () =>
    drawn(renderer)
      .filter((model) => model.decoded.featureCount === 32)
      .map((model) => batchKeys(model)[0]);
  // The centre over group (10, 0): the frame after quiet builds it first.
  const world = (x, y) =>
    Cesium.Matrix4.multiplyByPoint(
      regionFrame(region),
      new Cesium.Cartesian3(x, y, 0),
      new Cesium.Cartesian3(),
    );
  centre = world(10 * 4 * 64 * 30 + 3840, 3840);
  // Covering it, 250 ms is enough; the others still wait.
  clock += CENTRE_QUIET_MS;
  await frame();
  assert.deepEqual(batched(), ['40:0']);
  await frame();
  assert.deepEqual(batched(), ['40:0']);
  // Quiet: the nearer of the rest next (group 5, then 0).
  clock += 1500;
  await frame();
  assert.deepEqual(batched().sort(), ['20:0', '40:0']);
  await frame();
  assert.deepEqual(batched().sort(), ['0:0', '20:0', '40:0']);
  renderer.destroy();
});

test('block points: carried through splitMesh and compactPart into the GLB, opaque and water; a flat mesh without them derives them from its positions', async () => {
  // A mesh with block points: (i, j, level), here a quad at level 1 and a
  // water quad beside it.
  const mesh = tinyMesh({ water: true });
  mesh.blockCoords = Float32Array.from([
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 2, 0, 1, 2, 1, 1, 1, 1, 1,
  ]);
  mesh.opaqueIndexCount = 6;
  const { opaque, water } = splitMesh(mesh);
  assert.deepEqual([...opaque.blockCoords], [...mesh.blockCoords.slice(0, 12)]);
  assert.deepEqual([...water.blockCoords], [...mesh.blockCoords.slice(12)]);
  assert.equal(compactPart(water).blockCoords, water.blockCoords);
  // A flat mesh without them: positions over (blockM, blockM, levelM).
  const derived = derivedBlockCoords(
    { positions: Float32Array.from([30, 60, 90]) },
    30,
    15,
  );
  assert.deepEqual([...derived], [1, 2, 6]);
  assert.equal(derivedBlockCoords(mesh, 30), mesh.blockCoords);
  // Drawn: the GLB's _BLOCKCOORD, the water primitive's too (chunk 0:0
  // folds nothing in).
  const { renderer } = setup();
  renderer.setRegion(stubRegion({ blockM: 30 }));
  renderer.upsert('0:0', mesh);
  await settle();
  const [land, sea] = renderer.getCollection().get(0).decoded.primitives;
  assert.deepEqual(land.blockCoords, [...mesh.blockCoords.slice(0, 12)]);
  assert.deepEqual(sea.blockCoords, [...mesh.blockCoords.slice(12)]);
  renderer.destroy();
});

test('curved chunks with block points draw with edges and dither again; one without them stays plain', async () => {
  const { renderer } = setup();
  renderer.setRegions([
    stubRegion({ blockM: 480 }),
    stubRegion({ blockM: 1920 }),
  ]);
  const withCoords = {
    ...tinyMesh(),
    blockCoords: Float32Array.from([0, 0, 3, 1, 0, 3, 1, 1, 3, 0, 1, 3]),
  };
  renderer.upsert(levelChunkKey(1920, 0, 0), withCoords);
  renderer.upsert(levelChunkKey(1920, 1, 0), tinyMesh());
  await settle();
  const [lined, plain] = drawn(renderer);
  assert.equal(uniform(lined, 'u_edgeStrength'), EDGE_DEFAULTS.strength);
  assert.equal(uniform(lined, 'u_ditherAmount'), DITHER_DEFAULTS.amount);
  assert.deepEqual(lined.decoded.primitives[0].blockCoords, [
    ...withCoords.blockCoords,
  ]);
  assert.equal(uniform(plain, 'u_edgeStrength'), 0);
  assert.equal(uniform(plain, 'u_ditherAmount'), 0);
  // Its attribute is there, zeros: the shader reads it.
  assert.ok(plain.decoded.primitives[0].blockCoords.every((v) => v === 0));
  renderer.destroy();
});

test("a ring's hole: setRingHoles gives each ring's shader the inner rings' reach about a centre, and its fragments inside are discarded", async () => {
  const viewer = fakeViewer();
  viewer.scene.camera = { viewMatrix: Cesium.Matrix4.IDENTITY };
  const { renderer } = setup({ viewer });
  renderer.setRegions([
    stubRegion({ blockM: 8 }),
    stubRegion({ blockM: 480 }),
    stubRegion({ blockM: 1920 }),
  ]);
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert(levelChunkKey(480, 0, 0), tinyMesh());
  // A curved ring's chunk carries its block points (mesh.js), so it draws
  // with its ring's shader (and its hole).
  renderer.upsert(levelChunkKey(1920, 0, 0), {
    ...tinyMesh(),
    blockCoords: Float32Array.from([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
  });
  await settle();
  const [fine, mid, far] = drawn(renderer);
  assert.equal(uniform(mid, 'u_holeRadiusM'), 0); // none until told
  renderer.setRingHoles({
    lon: -76.6,
    lat: 39.3,
    reachM: { 480: 16_384, 1920: 30_720 },
  });
  assert.equal(uniform(mid, 'u_holeRadiusM'), 16_384);
  assert.equal(uniform(far, 'u_holeRadiusM'), 30_720);
  assert.equal(uniform(fine, 'u_holeRadiusM'), 0); // the primary region has none
  // The centre in eye coordinates (here the view is the identity: world),
  // the up its ground's normal.
  const world = Cesium.Cartesian3.fromDegrees(-76.6, 39.3, 0);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      uniform(mid, 'u_holeCentreEC'),
      world,
      1e-6,
    ),
  );
  assert.ok(
    Math.abs(Cesium.Cartesian3.magnitude(uniform(mid, 'u_holeUpEC')) - 1) <
      1e-12,
  );
  assert.deepEqual(renderer.getState().holes.reachM, {
    480: 16_384,
    1920: 30_720,
  });
  // The shader leaves out what is inside, across the ground.
  assert.match(
    BLOCKS_SHADER_FRAGMENT,
    /if \(blocks_inHole\(positionEC\)\) discard;/,
  );
  assert.match(
    BLOCKS_SHADER_FRAGMENT,
    /d - dot\(d, u_holeUpEC\) \* u_holeUpEC/,
  );
  // null: no holes.
  renderer.setRingHoles(null);
  assert.equal(uniform(mid, 'u_holeRadiusM'), 0);
  renderer.destroy();
});

test('a batch whose chunks stream in two seconds apart is rebuilt once at the default quiet, not after every chunk (each rebuild encodes all its chunks again)', async () => {
  assert.equal(BATCH_QUIET_MS, 3000);
  const stream = async (quietMs) => {
    const { renderer, advance, frame } = batchSetup({ quietMs });
    for (let ci = 4; ci < 8; ci++)
      for (let cj = 0; cj < 4; cj++) {
        renderer.upsert(`${ci}:${cj}`, tinyMesh());
        advance(2000);
        frame();
        await settle();
      }
    advance(3000);
    frame();
    await settle();
    const { stats, batches } = renderer.getState();
    assert.equal(batches, 1);
    return stats;
  };
  const now = await stream(null);
  assert.equal(now.rebuilds, 1, 'once, when the group is quiet');
  assert.equal(now.rebuiltChunks, 16);
  assert.equal(now.alone, 16, 'each drawn alone meanwhile (a draw call each)');
  assert.equal(now.models, 17);
  assert.ok(now.encodeMs >= 0);
  // At the old 1.5 s, a rebuild after every chunk.
  const before = await stream(1500);
  assert.equal(before.rebuilds, 16);
  assert.equal(before.rebuiltChunks, 136);
});
