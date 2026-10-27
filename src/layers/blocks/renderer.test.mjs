// Personal fork: the Blocks renderer (src/layers/blocks/renderer.js):
// primitives added, replaced and removed by key, model matrices for a known
// origin and the geoid lift, opaque and water split, the fog uniforms, the
// sun rule, and a real Cesium.Primitive built from a tiny mesh.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  REAL_SUN_MIN_ELEVATION_DEG,
  STUDY_SUN,
  blocksSun,
  chunkMatrix,
  createBlocksRenderer,
  parseChunkKey,
  primitive3D,
  regionFrame,
  splitMesh,
  sunVector,
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
    pickTranslucentDepth: false,
    requestRender: () => renders++,
  };
  return { scene, renders: () => renders };
}

/** One block's top face (a quad at z = 1) and, with water, a translucent quad beside it. */
function tinyMesh({ water = false } = {}) {
  const quads = [[0, 0, 1, [120, 160, 80, 255]]];
  if (water) quads.push([1, 0, 1, [60, 110, 200, 160]]);
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

test('parseChunkKey reads ci:cj, negatives included', () => {
  assert.deepEqual(parseChunkKey('3:-2'), { ci: 3, cj: -2 });
});

test('splitMesh: opaque and water faces apart, vertices compacted', () => {
  const { opaque, water } = splitMesh(tinyMesh({ water: true }));
  assert.equal(opaque.indices.length, 6);
  assert.equal(water.indices.length, 6);
  assert.equal(opaque.positions.length, 12);
  assert.equal(water.positions.length, 12);
  assert.ok(
    [...water.colors].filter((_, k) => k % 4 === 3).every((a) => a === 160),
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
  assert.equal(viewer.scene.pickTranslucentDepth, true);
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
  assert.equal(viewer.scene.pickTranslucentDepth, false);
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
  assert.match(fs, /mix\(v_color\.rgb, fog\.diffuse, fog\.alpha\)/);
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
  assert.ok(night.dir.east < 0 && night.dir.north < 0, 'from the south-west');
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
  const v = sunVector(0, 90);
  assert.ok(Math.abs(v.east - 1) < 1e-12 && Math.abs(v.up) < 1e-12);
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
  const instance = primitive.geometryInstances;
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
