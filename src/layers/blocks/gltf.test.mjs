// Personal fork: the Blocks glTF encoder (src/layers/blocks/gltf.js), the
// layout the renderer's Models and the precomputed tileset share: Y-up
// positions, byte normals, the folded block points, feature ids and their
// property table, the GLB's chunks, and Cesium's own loader taking it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  FOLD_COLUMNS,
  accessorValues as typedValues,
  encodeBlocksGlb,
  foldColumns,
  mergeParts,
  readBlocksGlb,
  readGlb,
} from './gltf.js';

/** An accessor's values as a plain array. */
const accessorValues = (json, bin, index) => [...typedValues(json, bin, index)];

/** A quad at (x, y, z) facing up, its block points the same, one colour. */
function quad(x, y, z, rgba = [200, 194, 176, 255]) {
  const positions = [];
  const blockCoords = [];
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]) {
    positions.push(x + dx, y + dy, z);
    blockCoords.push(x + dx, y + dy, z);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Int8Array.from([0, 0, 127, 0, 0, 127, 0, 0, 127, 0, 0, 127]),
    colors: Uint8Array.from([...rgba, ...rgba, ...rgba, ...rgba]),
    blockCoords: Float32Array.from(blockCoords),
    indices: Uint16Array.from([0, 1, 2, 0, 2, 3]),
  };
}

test('foldColumns: a chunk index to its columns modulo 4096, negatives too', () => {
  assert.equal(FOLD_COLUMNS, 4096);
  assert.equal(foldColumns(0), 0);
  assert.equal(foldColumns(3), 192);
  assert.equal(foldColumns(64), 0);
  assert.equal(foldColumns(-1), 4032);
  assert.equal(foldColumns(-65), 4032);
  assert.equal(foldColumns(undefined), 0);
});

test('mergeParts: Y-up positions moved by their offsets, byte normals on a 4-byte stride, folded block points, a feature a chunk, indices renumbered', () => {
  const merged = mergeParts([
    { part: quad(0, 0, 1), chunk: [0, 0], feature: 0 },
    { part: null, feature: 9 },
    {
      part: quad(2, 3, 5),
      offset: { x: 128, y: 64, z: -2 },
      chunk: [-1, 2],
      feature: 1,
    },
  ]);
  assert.equal(merged.vertexCount, 8);
  // (east, north, up) → (east, up, −north).
  // 0 − north: no −0 in the data (JSON's min and max would print it as 0).
  assert.ok(Object.is(merged.positions[2], 0));
  assert.deepEqual([...merged.positions.slice(0, 3)], [0, 1, 0]);
  assert.deepEqual([...merged.positions.slice(12, 15)], [130, 3, -67]);
  assert.deepEqual(merged.min, [0, 1, -68]);
  assert.deepEqual(merged.max, [131, 3, 0]);
  // Up normals: +Y, the fourth byte padding.
  assert.deepEqual([...merged.normals.slice(0, 4)], [0, 127, 0, 0]);
  // Block points: chunk (−1, 2) folds to (4032, 128) columns; levels as they are.
  assert.deepEqual([...merged.blockCoords.slice(12, 15)], [4034, 131, 5]);
  assert.deepEqual([...merged.featureIds], [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.ok(merged.indices instanceof Uint16Array);
  assert.deepEqual([...merged.indices.slice(6)], [4, 5, 6, 4, 6, 7]);
  // Float normals are taken too.
  const floats = { ...quad(0, 0, 0), normals: new Float32Array(12).fill(0) };
  floats.normals[0] = 1;
  assert.deepEqual(
    [...mergeParts([{ part: floats, feature: 0 }]).normals.slice(0, 4)],
    [127, 0, 0, 0],
  );
  assert.equal(mergeParts([{ part: null, feature: 0 }]), null);
  // A caller's own column offset instead of the fold (the tileset's
  // anchor-relative columns).
  const offset = mergeParts([
    { part: quad(0, 0, 1), chunk: [-1, 2], blockOffset: [100, -7], feature: 0 },
  ]);
  assert.deepEqual([...offset.blockCoords.slice(0, 3)], [100, -7, 1]);
});

test('mergeParts: 32-bit indices past 65,536 vertices', () => {
  const big = quad(0, 0, 0);
  const many = Array.from({ length: 16_385 }, (_, k) => ({
    part: big,
    feature: k,
  }));
  const merged = mergeParts(many);
  assert.equal(merged.vertexCount, 65_540);
  assert.ok(merged.indices instanceof Uint32Array);
  assert.equal(merged.indices.at(-1), 65_539);
});

test('encodeBlocksGlb: one mesh, opaque then water, the shared attribute layout, a property table of features', () => {
  const opaque = mergeParts([
    { part: quad(0, 0, 1), chunk: [3, 4], feature: 0 },
  ]);
  const water = mergeParts([
    {
      part: quad(1, 0, 1, [58, 112, 190, 170]),
      chunk: [3, 4],
      feature: 1,
    },
  ]);
  const glb = encodeBlocksGlb({
    opaque,
    water,
    features: {
      count: 2,
      properties: { ci: Int32Array.of(3, 3), water: Uint8Array.of(0, 1) },
    },
  });
  // The GLB header: magic, version 2, its length; JSON then BIN, 4-aligned.
  const view = new DataView(glb.buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  assert.equal(glb.byteLength % 4, 0);
  const { json, bin } = readGlb(glb);
  assert.equal(json.asset.version, '2.0');
  assert.deepEqual(json.extensionsRequired, ['KHR_mesh_quantization']);
  const [land, sea] = json.meshes[0].primitives;
  assert.deepEqual(Object.keys(land.attributes), [
    'POSITION',
    'NORMAL',
    'COLOR_0',
    '_BLOCKCOORD',
    '_FEATURE_ID_0',
  ]);
  assert.equal(json.materials[land.material].alphaMode, 'OPAQUE');
  assert.equal(json.materials[sea.material].alphaMode, 'BLEND');
  for (const material of json.materials) {
    assert.equal(material.doubleSided, true);
    assert.ok(material.extensions.KHR_materials_unlit);
  }
  const a = (name) => json.accessors[land.attributes[name]];
  assert.deepEqual(
    [a('POSITION').componentType, a('POSITION').type],
    [5126, 'VEC3'],
  );
  assert.deepEqual(a('POSITION').min, [0, 1, -1]);
  assert.equal(a('NORMAL').componentType, 5120);
  assert.equal(a('NORMAL').normalized, true);
  assert.equal(json.bufferViews[a('NORMAL').bufferView].byteStride, 4);
  assert.equal(a('COLOR_0').componentType, 5121);
  assert.equal(a('COLOR_0').normalized, true);
  assert.equal(a('_FEATURE_ID_0').type, 'SCALAR');
  assert.equal(json.accessors[land.indices].componentType, 5123);
  for (const v of json.bufferViews) assert.equal(v.byteOffset % 8, 0);
  // Feature ids name rows of the property table.
  assert.deepEqual(land.extensions.EXT_mesh_features.featureIds, [
    { featureCount: 2, attribute: 0, propertyTable: 0 },
  ]);
  const metadata = json.extensions.EXT_structural_metadata;
  assert.deepEqual(metadata.schema.classes.chunk.properties, {
    ci: { type: 'SCALAR', componentType: 'INT32' },
    water: { type: 'SCALAR', componentType: 'UINT8' },
  });
  const table = metadata.propertyTables[0];
  assert.equal(table.class, 'chunk');
  assert.equal(table.count, 2);
  const column = json.bufferViews[table.properties.water.values];
  assert.deepEqual(
    [...bin.subarray(column.byteOffset, column.byteOffset + 2)],
    [0, 1],
  );
  // The bytes read back: water's colour, the folded block point, its feature.
  assert.deepEqual(
    accessorValues(json, bin, sea.attributes.COLOR_0).slice(0, 4),
    [58, 112, 190, 170],
  );
  assert.deepEqual(
    accessorValues(json, bin, sea.attributes._BLOCKCOORD).slice(0, 3),
    [193, 256, 1],
  );
  assert.deepEqual(
    accessorValues(json, bin, sea.attributes._FEATURE_ID_0),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    accessorValues(json, bin, land.attributes.NORMAL).slice(0, 3),
    [0, 127, 0],
  );
  // No faces: no GLB. No columns: a row index.
  assert.equal(encodeBlocksGlb({ features: { count: 1 } }), null);
  const plain = readGlb(encodeBlocksGlb({ opaque, features: { count: 1 } }));
  assert.deepEqual(
    Object.keys(
      plain.json.extensions.EXT_structural_metadata.propertyTables[0]
        .properties,
    ),
    ['row'],
  );
  assert.equal(plain.json.meshes[0].primitives.length, 1);
});

test("Cesium's glTF loader takes the GLB, and a Model is made from it", async () => {
  const glb = encodeBlocksGlb({
    opaque: mergeParts([{ part: quad(0, 0, 1), feature: 0 }]),
    water: mergeParts([
      { part: quad(1, 0, 1, [58, 112, 190, 170]), feature: 1 },
    ]),
    features: { count: 2, properties: { water: Uint8Array.of(0, 1) } },
  });
  const resource = Cesium.Resource.createIfNeeded('');
  const loader = new Cesium.GltfLoader({
    typedArray: glb,
    gltfResource: resource,
    baseResource: resource,
  });
  await loader.load();
  assert.ok(loader.gltfJson.extensions.EXT_structural_metadata);
  loader.destroy();
  const model = await Cesium.Model.fromGltfAsync({ gltf: glb });
  assert.ok(model instanceof Cesium.Model);
  model.destroy();
});

test('readBlocksGlb: the GLB read back, kinds, positions in (east, north, up), feature ids, indices and the property table', () => {
  const glb = encodeBlocksGlb({
    opaque: mergeParts([
      {
        part: quad(0, 0, 1),
        offset: { x: 64, y: 128, z: 2 },
        chunk: [1, 2],
        feature: 0,
      },
    ]),
    water: mergeParts([
      { part: quad(1, 0, 1, [58, 112, 190, 170]), chunk: [1, 2], feature: 1 },
    ]),
    features: {
      count: 2,
      properties: { ci: Int32Array.of(1, 1), cj: Int32Array.of(2, 2) },
    },
  });
  const { primitives, properties, featureCount, json } = readBlocksGlb(glb);
  assert.equal(json.asset.version, '2.0');
  assert.equal(featureCount, 2);
  assert.deepEqual([...properties.cj], [2, 2]);
  assert.ok(properties.ci instanceof Int32Array);
  const [land, sea] = primitives;
  assert.deepEqual([land.kind, sea.kind], ['opaque', 'water']);
  assert.deepEqual([...land.positions.slice(0, 3)], [64, 128, 3]);
  assert.deepEqual([...land.indices], [0, 1, 2, 0, 2, 3]);
  assert.ok(land.indices.every((i) => i < land.positions.length / 3));
  assert.deepEqual([...sea.featureIds], [1, 1, 1, 1]);
  assert.deepEqual([...sea.colors.slice(0, 4)], [58, 112, 190, 170]);
  assert.deepEqual([...land.normals.slice(0, 3)], [0, 127, 0]);
  assert.deepEqual([...land.blockCoords.slice(0, 3)], [64, 128, 1]);
});
