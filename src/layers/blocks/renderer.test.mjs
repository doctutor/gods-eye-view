// Personal fork: the Blocks renderer (src/layers/blocks/renderer.js):
// primitives added, replaced and removed by key, model matrices for a known
// origin and the geoid lift, opaque and water split, the fog uniforms, the
// sun rule, and a real Cesium.Primitive built from a tiny mesh.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { STUDY_SUN } from './lighting.js';
import { CHUNK_COLUMNS, createRegion } from './grid.js';
import { createChunk } from './store.js';
import { buildChunkMesh } from './mesh.js';
import {
  BATCH_CHUNKS,
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
  primitive3D,
  levelChunkKey,
  parseLevelChunkKey,
  regionFrame,
  ringsFog,
  splitMesh,
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

test('upsert, replace and remove by key', async () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  assert.equal(viewer.scene.primitives.length, 1); // the blocks collection
  await renderer.setRegion(stubRegion({ lon0: -76.6, lat0: 39.3, blockM: 1 }));
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert('1:-1', tinyMesh({ water: true }));
  const collection = renderer.getCollection();
  assert.deepEqual(renderer.keys().sort(), ['0:0', '1:-1']);
  assert.equal(collection.length, 3); // one, then opaque + water
  const water = collection.get(2);
  assert.equal(water.appearance.isTranslucent(), true);
  assert.equal(water.appearance.renderState.depthMask, false);
  assert.equal(collection.get(1).appearance.isTranslucent(), false);
  // Replacing a key swaps its primitives, not adds.
  const first = collection.get(0);
  renderer.upsert('0:0', tinyMesh({ water: true }));
  assert.equal(collection.length, 4);
  assert.equal(collection.contains(first), false);
  assert.equal(first.isDestroyed(), true);
  // An empty mesh removes the chunk.
  renderer.upsert('1:-1', {
    positions: new Float32Array(),
    normals: new Float32Array(),
    colors: new Uint8Array(),
    indices: new Uint32Array(),
    faces: 0,
  });
  assert.deepEqual(renderer.keys(), ['0:0']);
  assert.equal(collection.length, 2);
  renderer.remove('0:0');
  renderer.remove('nope');
  assert.equal(collection.length, 0);
  assert.ok(viewer.renders() > 0);
  renderer.destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('model matrices: chunk origin from the key, raised by the datum offset', () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  const region = stubRegion({ lon0: 0, lat0: 0, blockM: 30 });
  const a = Cesium.Ellipsoid.WGS84.maximumRadius;
  // A flat basemap: level 0 sits on the ellipsoid. setRegion is not awaited.
  renderer.setRegion(region);
  renderer.upsert('2:-1', tinyMesh());
  const primitive = renderer.getCollection().get(0);
  let t = translation(primitive.modelMatrix);
  assert.ok(Math.abs(t.x - a) < 1e-6, 'on the ellipsoid');
  assert.ok(Math.abs(t.y - 2 * 64 * 30) < 1e-6);
  assert.ok(Math.abs(t.z - -1 * 64 * 30) < 1e-6);
  // Terrain: the controller passes the geoid's N; chunks stay and move.
  const state = renderer.setRegion(region, { datumOffsetM: 17.16 });
  assert.equal(state.datumOffsetM, 17.16);
  assert.deepEqual(renderer.keys(), ['2:-1']);
  assert.equal(renderer.getCollection().get(0), primitive);
  t = translation(primitive.modelMatrix);
  assert.ok(
    Math.abs(t.x - (a + 17.16)) < 1e-6,
    'level 0 base on mean sea level',
  );
  renderer.upsert('0:0', tinyMesh());
  t = translation(renderer.getCollection().get(1).modelMatrix);
  assert.ok(Math.abs(t.x - (a + 17.16)) < 1e-6);
  // Back to flat.
  renderer.setRegion(region, { datumOffsetM: 0 });
  assert.ok(Math.abs(translation(primitive.modelMatrix).x - a) < 1e-6);
  renderer.destroy();
});

test('setRegion: the same region keeps chunks, another drops them', async () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  await renderer.setRegion(stubRegion({ lon0: 1, lat0: 2, blockM: 10 }));
  renderer.upsert('0:0', tinyMesh());
  await renderer.setRegion(stubRegion({ lon0: 1, lat0: 2, blockM: 10 }));
  assert.deepEqual(renderer.keys(), ['0:0']);
  await renderer.setRegion(stubRegion({ lon0: 1.1, lat0: 2, blockM: 10 }));
  assert.deepEqual(renderer.keys(), []);
  assert.equal(renderer.getCollection().length, 0);
  assert.throws(
    () =>
      createBlocksRenderer({
        viewer: fakeViewer().viewer ?? fakeViewer(),
      }).upsert('0:0', tinyMesh()),
    /setRegion first/,
  );
  renderer.destroy();
});

test('setFog sets both appearances uniforms', async () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  await renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh({ water: true }));
  const fog = renderer.setFog({ startM: 300, endM: 640, color: '#a0c0e0' });
  assert.equal(fog.startM, 300);
  assert.equal(fog.endM, 640);
  for (const primitive of [
    renderer.getCollection().get(0),
    renderer.getCollection().get(1),
  ]) {
    const uniforms = primitive.appearance.material.uniforms;
    assert.equal(uniforms.fogStartM, 300);
    assert.equal(uniforms.fogEndM, 640);
    assert.ok(Math.abs(uniforms.fogColor.red - 0xa0 / 255) < 1e-6);
    assert.ok(Math.abs(uniforms.fogColor.blue - 0xe0 / 255) < 1e-6);
  }
  // The material source carries the fog; the fragment shader mixes it in.
  const fs = renderer
    .getCollection()
    .get(0)
    .appearance.getFragmentShaderSource();
  assert.match(fs, /fogStartM/);
  assert.match(fs, /mix\(v_color\.rgb \* tone, fog\.diffuse, fog\.alpha\)/);
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
  const renderer = createBlocksRenderer({
    viewer: fakeViewer(),
  });
  const sun = renderer.setSun({ east: -2, north: -2, up: 4 }, { fixed: true });
  assert.ok(
    Math.abs(Math.hypot(sun.dir.east, sun.dir.north, sun.dir.up) - 1) < 1e-12,
  );
  assert.equal(renderer.getSun().fixed, true);
  renderer.destroy();
});

test('a real Cesium.Primitive from a tiny mesh: float local positions, per-vertex colour, picking', async () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
  await renderer.setRegion(
    stubRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 }),
  );
  renderer.upsert('0:0', tinyMesh());
  const primitive = renderer.getCollection().get(0);
  assert.ok(primitive instanceof Cesium.Primitive);
  assert.equal(primitive.allowPicking, true);
  assert.equal(primitive.asynchronous, false);
  const [instance] = primitive.geometryInstances;
  assert.deepEqual(instance.id, { blocks: true, key: '0:0', water: false });
  const { attributes, indices, boundingSphere } = instance.geometry;
  assert.equal(
    attributes.position.componentDatatype,
    Cesium.ComponentDatatype.FLOAT,
  );
  assert.equal(
    attributes.color.componentDatatype,
    Cesium.ComponentDatatype.UNSIGNED_BYTE,
  );
  // Normals as normalized bytes (axis unit vectors: exact).
  assert.equal(
    attributes.normal.componentDatatype,
    Cesium.ComponentDatatype.BYTE,
  );
  assert.equal(attributes.normal.normalize, true);
  assert.deepEqual([...attributes.normal.values.slice(0, 3)], [0, 0, 127]);
  assert.equal(attributes.color.normalize, true);
  assert.ok(indices instanceof Uint16Array);
  assert.ok(boundingSphere.radius > 0 && boundingSphere.radius < 2);
  // The vertex shader reads float positions through the model matrix (no
  // high/low split, so the pipeline leaves the geometry local).
  const vs = primitive.appearance.vertexShaderSource;
  assert.match(vs, /in vec3 position;/);
  assert.doesNotMatch(vs, /position3DHigh/);
  assert.match(vs, /czm_modelView \* p/);
  // Drawn a little nearer the eye than it is, so it wins ties with terrain.
  assert.match(vs, /const float DEPTH_BIAS = 1e-4;/);
  assert.match(
    vs,
    /czm_projection \* vec4\(positionEC\.xyz \* \(1\.0 - DEPTH_BIAS\), 1\.0\)/,
  );
  // Opaque faces write depth (Cesium's default); water's do not.
  assert.notEqual(primitive.appearance.renderState.depthMask, false);
  assert.equal(primitive.appearance.renderState.depthTest.enabled, true);
  // The geometry builds as Cesium's own synchronous path would.
  const clone = Cesium.Geometry.computeNumberOfVertices(instance.geometry);
  assert.equal(clone, 4);
  renderer.destroy();
});

test('primitive3D: updates with a 3D-only view of the frame state, nothing outside 3D', (t) => {
  const seen = [];
  const original = Cesium.Primitive.prototype.update;
  Cesium.Primitive.prototype.update = function (frameState) {
    seen.push(frameState);
  };
  t.after(() => {
    Cesium.Primitive.prototype.update = original;
  });
  const primitive = primitive3D({ appearance: undefined });
  const frameState = {
    mode: Cesium.SceneMode.SCENE3D,
    scene3DOnly: false,
    commandList: [],
  };
  primitive.update(frameState);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].scene3DOnly, true);
  assert.equal(seen[0].commandList, frameState.commandList);
  assert.equal(
    frameState.scene3DOnly,
    false,
    'the scene frame state is untouched',
  );
  primitive.update({ ...frameState, mode: Cesium.SceneMode.COLUMBUS_VIEW });
  primitive.update({ ...frameState, mode: Cesium.SceneMode.SCENE2D });
  assert.equal(seen.length, 1);
  const only3D = { ...frameState, scene3DOnly: true };
  primitive.update(only3D);
  assert.equal(seen[1], only3D);
});

test('fog colour follows the scene background until setFog names one', () => {
  const viewer = fakeViewer();
  viewer.scene.preRender = new Cesium.Event();
  viewer.scene.backgroundColor = Cesium.Color.BLACK.clone();
  const renderer = createBlocksRenderer({ viewer });
  const uniforms = () =>
    renderer.getCollection().get(0).appearance.material.uniforms;
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  assert.deepEqual(renderer.getState().fog.color, [0, 0, 0, 1]);
  assert.equal(renderer.getState().fog.followsBackground, true);
  // The background changes: the next frame takes it.
  viewer.scene.backgroundColor = new Cesium.Color(0.2, 0.4, 0.6, 1);
  viewer.scene.preRender.raiseEvent(viewer.scene);
  assert.ok(Math.abs(uniforms().fogColor.green - 0.4) < 1e-6);
  // A named colour holds against background changes.
  const fog = renderer.setFog({ startM: 400, endM: 512, color: [1, 0, 0, 1] });
  assert.equal(fog.followsBackground, false);
  viewer.scene.backgroundColor = Cesium.Color.WHITE.clone();
  viewer.scene.preRender.raiseEvent(viewer.scene);
  assert.equal(uniforms().fogColor.red, 1);
  assert.equal(uniforms().fogColor.green, 0);
  // 'background' follows again.
  renderer.setFog({ color: 'background' });
  assert.equal(uniforms().fogColor.green, 1);
  assert.equal(renderer.getState().fog.endM, 512);
  renderer.destroy();
  assert.equal(viewer.scene.preRender.numberOfListeners, 0);
});

test('a far chunk drops onto the ellipsoid: chunkOrigin z in the translation', () => {
  const renderer = createBlocksRenderer({ viewer: fakeViewer() });
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 30 });
  renderer.setRegion(region);
  // Chunk (8, 0) of 30 m blocks starts 15.4 km east of the origin.
  renderer.upsert('8:0', tinyMesh());
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

test('the real mesher into the renderer: land and sea chunk, opaque and water primitives', () => {
  const renderer = createBlocksRenderer({ viewer: fakeViewer() });
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
  const [opaque, sea] = [0, 1].map((k) => renderer.getCollection().get(k));
  assert.equal(opaque.appearance.isTranslucent(), false);
  assert.equal(sea.appearance.isTranslucent(), true);
  assert.equal(
    opaque.geometryInstances[0].geometry.indices.length +
      sea.geometryInstances[0].geometry.indices.length,
    mesh.indices.length,
  );
  renderer.destroy();
});

test('block edges and top dither: on by default for land, never for water, blockM from the region', () => {
  const renderer = createBlocksRenderer({ viewer: fakeViewer() });
  renderer.setRegion(stubRegion({ blockM: 30 }));
  renderer.upsert('3:-2', tinyMesh({ water: true }));
  const [land, sea] = [0, 1].map((k) => renderer.getCollection().get(k));
  const u = land.appearance.material.uniforms;
  assert.equal(u.blockM, 30);
  assert.equal(u.edgeStrength, EDGE_DEFAULTS.strength);
  assert.equal(u.edgeStrength, 0.12);
  assert.equal(u.edgeFadeStart, 200);
  assert.equal(u.edgeFadeEnd, 300);
  assert.equal(u.ditherAmount, DITHER_DEFAULTS.amount);
  assert.equal(u.ditherAmount, 0.03);
  const w = sea.appearance.material.uniforms;
  assert.equal(w.edgeStrength, 0);
  assert.equal(w.ditherAmount, 0);
  // Each chunk carries its place for global dither columns.
  for (const primitive of [land, sea])
    assert.deepEqual(
      primitive.geometryInstances[0].attributes.blockChunk.value,
      [3, -2],
    );
  // The shaders: local position and normal through, lines by fwidth, the tone applied before the fog.
  const vs = land.appearance.vertexShaderSource;
  assert.match(vs, /v_chunk = czm_batchTable_blockChunk\(batchId\)/);
  assert.match(
    vs,
    /v_localPosition = position - czm_batchTable_blockOffset\(batchId\);/,
  );
  const fs = land.appearance.getFragmentShaderSource();
  assert.match(fs, /fwidth\(f\)/);
  assert.match(fs, /ditherAmount_\d+ \* ditherFade \*/);
  assert.match(
    fs,
    /blocks_tone\(v_localPosition, v_localNormal, v_chunk, length\(v_positionEC\)\)/,
  );
  assert.match(fs, /floor\(chunk \+ 0\.5\) \* 64\.0 \+ floor\(f\.xy\)/);
  assert.deepEqual(renderer.getState().style, {
    edges: { ...EDGE_DEFAULTS },
    dither: { ...DITHER_DEFAULTS },
  });
  renderer.destroy();
});

test('edges and dither options: off, settings, and setStyle', () => {
  const off = createBlocksRenderer({
    viewer: fakeViewer(),
    edges: false,
    dither: false,
  });
  off.setRegion(stubRegion());
  off.upsert('0:0', tinyMesh());
  let u = off.getCollection().get(0).appearance.material.uniforms;
  assert.equal(u.edgeStrength, 0);
  assert.equal(u.ditherAmount, 0);
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
  assert.equal(u.edgeStrength, 0.2);
  assert.equal(u.edgeFadeEnd, 150);
  assert.equal(u.ditherAmount, 0.03);
  // Leaving one out keeps it; false turns it off.
  off.setStyle({ dither: false });
  assert.equal(u.edgeStrength, 0.2);
  assert.equal(u.ditherAmount, 0);
  off.destroy();
  const custom = createBlocksRenderer({
    viewer: fakeViewer(),
    dither: { amount: 0.05 },
  });
  custom.setRegion(stubRegion({ blockM: 2 }));
  custom.upsert('0:0', tinyMesh());
  u = custom.getCollection().get(0).appearance.material.uniforms;
  assert.equal(u.ditherAmount, 0.05);
  assert.equal(u.edgeStrength, 0.12);
  assert.equal(u.blockM, 2);
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

test('the renderer fog follows the sky at eye level, the background high up, and a set colour holds', () => {
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
  const renderer = createBlocksRenderer({ viewer, now: () => clock });
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  renderer.flush();
  const uniforms = () =>
    renderer.getCollection().get(0).appearance.material.uniforms;
  let fog = renderer.getState().fog;
  assert.equal(fog.source, 'sky');
  assert.deepEqual(fog.color, [...HORIZON_SKY_DAY, 1]);
  assert.ok(Math.abs(uniforms().fogColor.blue - HORIZON_SKY_DAY[2]) < 1e-6);
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
function batchSetup() {
  const viewer = fakeViewer();
  viewer.scene.preRender = new Cesium.Event();
  let clock = 1_000_000;
  const wakes = [];
  const renderer = createBlocksRenderer({
    viewer,
    now: () => clock,
    quietMs: 1500,
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
    wakes,
    advance: (ms) => (clock += ms),
    frame: () => viewer.scene.preRender.raiseEvent(viewer.scene),
  };
}

test('a group of 16 chunks draws alone at once, then as one batch when quiet', () => {
  const { renderer, advance, frame, wakes } = batchSetup();
  const collection = renderer.getCollection();
  for (let ci = 4; ci < 8; ci++)
    for (let cj = 0; cj < 4; cj++) renderer.upsert(`${ci}:${cj}`, tinyMesh());
  // Each chunk alone first: no wait on the batch.
  assert.equal(collection.length, 16);
  assert.equal(renderer.getState().batches, 1);
  // A frame before the batch has been quiet changes nothing …
  frame();
  assert.equal(collection.length, 16);
  // … and a wake is set to draw a frame when it has been.
  assert.equal(wakes.at(-1).ms, 1500);
  advance(1500);
  frame();
  assert.equal(collection.length, 1, 'one primitive for the group');
  const batch = collection.get(0);
  assert.equal(batch.geometryInstances.length, 16);
  // Each chunk's offset in the batch (from its first chunk, 4:0) is its own place.
  const offsets = batch.geometryInstances.map((instance) => [
    instance.id.key,
    [...instance.attributes.blockOffset.value],
    [...instance.attributes.blockChunk.value],
  ]);
  const sixOne = offsets.find(([key]) => key === '6:1');
  assert.deepEqual(sixOne[1], [128, 64, 0]);
  assert.deepEqual(sixOne[2], [6, 1]);
  assert.ok(batch.geometryInstances.every((i) => i.attributes.show));
  // Positions are moved by the offset: chunk 6:1's quad starts at x 128.
  const six = batch.geometryInstances.find((i) => i.id.key === '6:1');
  assert.equal(six.geometry.attributes.position.values[0], 128);
  assert.equal(renderer.keys().length, 16);
});

test('a changed or removed chunk draws alone again and the batch takes it back when quiet', () => {
  const { renderer, advance, frame } = batchSetup();
  const collection = renderer.getCollection();
  for (let ci = 0; ci < 4; ci++) renderer.upsert(`${ci}:0`, tinyMesh());
  renderer.upsert('0:1', tinyMesh({ water: true }));
  renderer.flush({ all: true });
  // Opaque and water: two primitives for the batch.
  assert.equal(collection.length, 2);
  // A re-mesh: alone at once (its batch instance hidden, or the batch
  // rebuilt next frame when not drawn yet, as here without a GPU).
  renderer.upsert('2:0', tinyMesh());
  assert.equal(collection.length, 3);
  frame();
  assert.equal(collection.length, 2);
  // A removal: gone from the batch at the next quiet rebuild.
  renderer.remove('1:0');
  advance(1500);
  frame();
  const opaque = [...Array(collection.length).keys()]
    .map((k) => collection.get(k))
    .find((p) => !p.appearance.isTranslucent());
  assert.deepEqual(opaque.geometryInstances.map((i) => i.id.key).sort(), [
    '0:0',
    '0:1',
    '2:0',
    '3:0',
  ]);
  // Removing every chunk takes the batch away.
  for (const key of ['0:0', '0:1', '2:0', '3:0']) renderer.remove(key);
  renderer.flush({ all: true });
  assert.equal(collection.length, 0);
  assert.equal(renderer.getState().batches, 0);
});

test('one batch a frame; flush({all}) does every pending one; a new region drops them all', () => {
  const { renderer, advance, frame } = batchSetup();
  const collection = renderer.getCollection();
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert('4:0', tinyMesh()); // another group
  renderer.upsert('c:8:0', {
    ...tinyMesh(),
    origin: { x: 2048, y: 0, z: -0.3 },
  }); // a coarse chunk
  advance(1500);
  frame();
  assert.equal(
    collection.length,
    3,
    'one of three batches rebuilt (its chunk alone gone)',
  );
  frame();
  frame();
  assert.equal(collection.length, 3);
  assert.equal(renderer.getState().batches, 3);
  // The coarse batch keeps the coarse chunk's own origin (its z drop too).
  const coarse = [...Array(collection.length).keys()]
    .map((k) => collection.get(k))
    .find((p) => p.geometryInstances.some((i) => i.id.key === 'c:8:0'));
  assert.ok(
    Math.abs(
      Cesium.Matrix4.getTranslation(coarse.modelMatrix, new Cesium.Cartesian3())
        .y - 2048,
    ) < 1e-6,
  );
  // A new datum moves batches and lone chunks alike, 10 m up (+X at 0°, 0°).
  renderer.upsert('1:0', tinyMesh());
  const at = () =>
    [...Array(collection.length).keys()].map((k) =>
      Cesium.Matrix4.getTranslation(
        collection.get(k).modelMatrix,
        new Cesium.Cartesian3(),
      ),
    );
  const before = at();
  renderer.setRegion(stubRegion({ blockM: 1 }), { datumOffsetM: 10 });
  at().forEach((t, k) => {
    assert.ok(Math.abs(t.x - before[k].x - 10) < 1e-6);
    assert.ok(Math.abs(t.y - before[k].y) < 1e-6);
  });
  renderer.flush({ all: true });
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
  const renderer = createBlocksRenderer({ viewer: fakeViewer() });
  renderer.setRegion(stubRegion());
  renderer.upsert('0:0', tinyMesh());
  // 4 vertices: 48 bytes of positions, 12 of normals, 16 of colours, 12 of indices.
  assert.ok(Math.abs(renderer.getState().retainedMB - 88 / 1e6) < 1e-12);
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

test('setRegions: K rings, each its frame, block edges and chunks; a ring changed or gone drops only its own', () => {
  const viewer = fakeViewer();
  const renderer = createBlocksRenderer({ viewer });
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
  const [a, b, c] = [0, 1, 2].map((k) => renderer.getCollection().get(k));
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
  // Each with its own block edges.
  assert.equal(a.appearance.material.uniforms.blockM, 30);
  assert.equal(b.appearance.material.uniforms.blockM, 120);
  assert.equal(c.appearance.material.uniforms.blockM, 480);
  // The fog reaches every ring's appearances.
  for (const primitive of [a, b, c])
    assert.equal(primitive.appearance.material.uniforms.fogEndM, 512 * 480);
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
  const ring = renderer
    .getCollection()
    .get(renderer.getCollection().length - 1);
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

test("a ring's chunks batch apart from the primary's and keep their frame", () => {
  const { renderer, advance, frame } = batchSetup();
  const fine = renderer.getState().region;
  const mid = stubRegion({ lon0: 0.01, lat0: 0, blockM: 4 });
  renderer.setRegions([fine, mid]);
  for (let ci = 0; ci < 4; ci++)
    for (let cj = 0; cj < 4; cj++) {
      renderer.upsert(`${ci}:${cj}`, tinyMesh());
      renderer.upsert(levelChunkKey(4, ci, cj), tinyMesh());
    }
  advance(1500);
  frame();
  frame();
  const collection = renderer.getCollection();
  assert.equal(renderer.getState().batches, 2);
  assert.equal(collection.length, 2);
  const ring = [0, 1]
    .map((k) => collection.get(k))
    .find((primitive) => primitive.appearance.material.uniforms.blockM === 4);
  assert.ok(ring);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      translation(ring.modelMatrix),
      translation(chunkMatrix(regionFrame(mid), { x: 0, y: 0 })),
      1e-6,
    ),
  );
  assert.equal(ring.geometryInstances.length, 16);
});

test('levelM: the vertical edge lines at the level height, per ring; a level change is another region', () => {
  const renderer = createBlocksRenderer({ viewer: fakeViewer() });
  const fine = { ...stubRegion({ blockM: 120 }), levelM: 30 };
  const far = { ...stubRegion({ blockM: 1920 }), levelM: 60 };
  renderer.setRegions([fine, far]);
  renderer.upsert('0:0', tinyMesh());
  renderer.upsert(levelChunkKey(1920, 0, 0), tinyMesh());
  const [a, b] = [0, 1].map((k) => renderer.getCollection().get(k));
  assert.equal(a.appearance.material.uniforms.blockM, 120);
  assert.equal(a.appearance.material.uniforms.levelM, 30);
  assert.equal(b.appearance.material.uniforms.levelM, 60);
  assert.match(
    a.appearance.getFragmentShaderSource(),
    /localPosition \/ vec3\(blockM_\d+, blockM_\d+, levelM_\d+\)/,
  );
  // Cubes when a region has no levelM.
  renderer.setRegion(stubRegion({ blockM: 30 }));
  assert.equal(renderer.getState().region.levelM, undefined);
  renderer.upsert('0:0', tinyMesh());
  assert.equal(
    renderer.getCollection().get(0).appearance.material.uniforms.levelM,
    30,
  );
  // The same anchor and block on other levels: its chunks go.
  renderer.setRegion({ ...stubRegion({ blockM: 30 }), levelM: 15 });
  assert.deepEqual(renderer.keys(), []);
  renderer.destroy();
});
