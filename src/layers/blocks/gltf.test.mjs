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
  encodeBatchGlb,
  encodeBlocksGlb,
  packPart,
  packedBuffers,
  packedBytes,
  foldColumns,
  mergeParts,
  readBlocksGlb,
  readGlb,
  splitPrimitives,
} from './gltf.js';
import { buildChunkMesh } from './mesh.js';
import { createChunk } from './store.js';

/** An accessor's values as a plain array. */
const accessorValues = (json, bin, index) => [...typedValues(json, bin, index)];

/** Joined or packed block points (half blocks, a 4-short stride) in blocks, three a vertex. */
const blocksOf = ({ blockCoords }) =>
  Float32Array.from(
    { length: (blockCoords.length / 4) * 3 },
    (_, k) => blockCoords[Math.floor(k / 3) * 4 + (k % 3)] / 2,
  );

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
  // Up normals: +Y, the fourth byte the vertex's feature row.
  assert.deepEqual([...merged.normals.slice(0, 4)], [0, 127, 0, 0]);
  assert.deepEqual([...merged.normals.slice(16, 20)], [0, 127, 0, 1]);
  // Block points in half blocks on a 4-short stride: chunk (−1, 2) folds
  // to (4032, 128) columns; levels as they are.
  assert.ok(merged.blockCoords instanceof Int16Array);
  assert.deepEqual([...merged.blockCoords.slice(16, 20)], [8068, 262, 10, 0]);
  assert.deepEqual([...blocksOf(merged).slice(12, 15)], [4034, 131, 5]);
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
  assert.deepEqual([...blocksOf(offset).slice(0, 3)], [100, -7, 1]);
  // A feature row past a byte, a block point past a SHORT's half blocks: refused.
  assert.throws(
    () => mergeParts([{ part: quad(0, 0, 0), feature: 256 }]),
    RangeError,
  );
  assert.throws(
    () => mergeParts([{ part: quad(0, 0, 16_400), feature: 0 }]),
    RangeError,
  );
});

test('mergeParts: 32-bit indices past 65,536 vertices, for encodeBlocksGlb to split', () => {
  const big = quad(0, 0, 0);
  const many = Array.from({ length: 16_385 }, (_, k) => ({
    part: big,
    feature: k % 256,
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
  // The feature id: an UNSIGNED_BYTE in the normals' fourth byte.
  assert.equal(a('_FEATURE_ID_0').type, 'SCALAR');
  assert.equal(a('_FEATURE_ID_0').componentType, 5121);
  assert.equal(a('_FEATURE_ID_0').bufferView, a('NORMAL').bufferView);
  assert.equal(a('_FEATURE_ID_0').byteOffset, 3);
  // The block point: SHORT half blocks on an 8-byte stride.
  assert.deepEqual(
    [a('_BLOCKCOORD').componentType, a('_BLOCKCOORD').type],
    [5122, 'VEC3'],
  );
  assert.equal(json.bufferViews[a('_BLOCKCOORD').bufferView].byteStride, 8);
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
    [386, 512, 2],
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

// The shader's per-block functions in float32 (renderer.js
// BLOCKS_SHADER_FRAGMENT's blocks_hash, and blocks_line's distance to the
// nearest whole number), to compare the folded block points with the
// renderer before the fold.
const f32 = Math.fround;
const fract = (x) => f32(x - Math.floor(x));
function blocksHash(px, py) {
  let [x, y, z] = [px, py, px].map((v) => fract(f32(v * f32(0.1031))));
  const d = f32(
    f32(x * f32(y + f32(33.33))) +
      f32(f32(y * f32(z + f32(33.33))) + f32(z * f32(x + f32(33.33)))),
  );
  x = f32(x + d);
  y = f32(y + d);
  z = f32(z + d);
  return fract(f32(f32(x + y) * z));
}
const lineDistance = (f) => Math.abs(f - Math.floor(f + 0.5));

test('the fold at a chunk seam: edges on whole numbers both sides, and the dither the renderer drew before it, column for column, within 4096 of the origin; past it the same hash a fold of 4096 away, never repeating across a seam', () => {
  // Two chunks side by side east, as a batch merges them: a top quad on
  // the last column of the first and the first column of the second.
  const seam = (ci) =>
    mergeParts([
      {
        part: quad(63, 5, 2),
        chunk: [ci, 7],
        feature: 0,
      },
      {
        part: quad(0, 5, 2),
        offset: { x: 64, y: 0, z: 0 },
        chunk: [ci + 1, 7],
        feature: 1,
      },
    ]);
  // Before the fold the renderer's column was chunk × 64 + floor(f.xy).
  const before = (ci, x) => ci * 64 + x;
  for (const ci of [0, 5, 62, 63, -1, -64, 200]) {
    const blockCoords = blocksOf(seam(ci));
    // The east edge of the first quad and the west edge of the second sit
    // on the seam: both whole numbers, so the edge line falls on it.
    const westEast = blockCoords[1 * 3]; // first quad, corner (1, 0)
    const eastWest = blockCoords[4 * 3]; // second quad, corner (0, 0)
    assert.equal(lineDistance(westEast), 0);
    assert.equal(lineDistance(eastWest), 0);
    // The two blocks either side of the seam: their columns.
    const left = Math.floor(blockCoords[0]);
    const right = Math.floor(eastWest);
    assert.equal(right, (left + 1) % FOLD_COLUMNS, 'next column, folded');
    assert.notEqual(
      blocksHash(left, 7 * 64 + 5),
      blocksHash(right, 7 * 64 + 5),
    );
    const unfolded = [before(ci, 63), before(ci + 1, 0)];
    if (unfolded.every((c) => c >= 0 && c < FOLD_COLUMNS))
      // Within the fold: the very columns, so the very tones.
      assert.deepEqual([left, right], unfolded);
    else
      // Past it: the same columns a whole number of folds away.
      assert.deepEqual(
        [left, right].map(
          (c, k) =>
            (((unfolded[k] - c) % FOLD_COLUMNS) + FOLD_COLUMNS) % FOLD_COLUMNS,
        ),
        [0, 0],
      );
  }
  // Across the fold's own boundary (chunk 63 to 64): column 4095 then 0,
  // two different tones, the edge on the seam.
  const blockCoords = blocksOf(seam(63));
  assert.equal(Math.floor(blockCoords[0]), 4095);
  assert.equal(blockCoords[4 * 3], 4096 % FOLD_COLUMNS);
});

test('a real chunk round-trips: the mesher’s faces, positions, colours and block points back from the GLB', () => {
  const top = new Int32Array(64 * 64).map((_, k) => (k % 64) >> 3);
  const mesh = buildChunkMesh(createChunk({ ci: 2, cj: -1, top }), {
    blockM: 1,
  });
  const glb = encodeBlocksGlb({
    opaque: mergeParts([{ part: mesh, chunk: [2, -1], feature: 0 }]),
    features: { count: 1, properties: { ci: Int32Array.of(2) } },
  });
  const [land] = readBlocksGlb(glb).primitives;
  assert.equal(land.indices.length, mesh.indices.length);
  assert.deepEqual([...land.indices], [...mesh.indices]);
  assert.deepEqual([...land.positions], [...mesh.positions]);
  assert.deepEqual([...land.colors], [...mesh.colors]);
  const fold = [foldColumns(2), foldColumns(-1), 0];
  assert.deepEqual(
    [...land.blockCoords],
    [...mesh.blockCoords].map((v, k) => v + fold[k % 3]),
  );
  // Byte normals, Y-up: (east, north, up) n → (n.e, n.u, −n.n) × 127.
  for (let v = 0; v < mesh.normals.length / 3; v++) {
    const [e, n, u] = mesh.normals.slice(v * 3, v * 3 + 3);
    assert.deepEqual(
      [...land.normals.slice(v * 3, v * 3 + 3)],
      [Math.round(e * 127), Math.round(u * 127), Math.round(-n * 127)].map(
        (x) => x + 0,
      ),
    );
  }
});

test('packPart: one chunk’s part in the layout once, its own vertices from 0; mergeParts takes it as it is', () => {
  const packed = packPart(quad(2, 3, 5), { chunk: [1, -1] });
  assert.equal(packed.packed, true);
  assert.equal(packed.vertexCount, 4);
  assert.deepEqual([...packed.positions.slice(0, 3)], [2, 5, -3]);
  assert.deepEqual([...packed.normals.slice(0, 4)], [0, 127, 0, 0]);
  assert.deepEqual([...packed.blockCoords.slice(0, 4)], [132, 8070, 10, 0]);
  assert.ok(packed.indices instanceof Uint16Array);
  assert.deepEqual(packed.min, [2, 5, -4]);
  assert.deepEqual(packed.max, [3, 5, -3]);
  assert.equal(packPart(packed), packed);
  assert.equal(packPart(null), null);
  // 4 vertices: 48 + 16 + 16 + 32 bytes, and 6 16-bit indices.
  assert.equal(packedBytes(packed), 124);
  assert.equal(packedBuffers(packed).length, 5);
  assert.equal(packedBytes(null), 0);
  // Merged as packed or as raw: the same arrays.
  const raw = mergeParts([
    { part: quad(2, 3, 5), chunk: [1, -1], offset: { x: 64 }, feature: 2 },
  ]);
  const fromPacked = mergeParts([
    { part: packed, offset: { x: 64 }, feature: 2 },
  ]);
  for (const name of ['positions', 'normals', 'blockCoords', 'indices'])
    assert.deepEqual([...fromPacked[name]], [...raw[name]], name);
});

test('encodeBatchGlb: a batch from packed parts in one allocation, the same bytes as encodeBlocksGlb of mergeParts', () => {
  const water = (x) => quad(x, 0, 1, [58, 112, 190, 170]);
  const chunks = [
    { opaque: quad(0, 0, 1), water: water(1), chunk: [4, 0], offset: null },
    { opaque: quad(5, 7, 2), water: null, chunk: [5, 0], offset: { x: 64 } },
    {
      opaque: quad(1, 1, 3),
      water: water(2),
      chunk: [4, 1],
      offset: { x: 0, y: 64, z: -0.25 },
    },
  ];
  const features = {
    count: 6,
    properties: { ci: Int32Array.of(4, 5, 4, 4, 5, 4) },
  };
  const merged = (kind, base) =>
    mergeParts(
      chunks.map((c, s) => ({
        part: c[kind],
        chunk: c.chunk,
        offset: c.offset,
        feature: base + s,
      })),
    );
  const expected = encodeBlocksGlb({
    opaque: merged('opaque', 0),
    water: merged('water', 3),
    features,
  });
  const batch = encodeBatchGlb({
    chunks: chunks.map((c) => ({
      opaque: packPart(c.opaque, { chunk: c.chunk }),
      water: packPart(c.water, { chunk: c.chunk }),
      offset: c.offset,
    })),
    features,
  });
  assert.deepEqual(batch, expected);
  const { primitives } = readBlocksGlb(batch);
  assert.deepEqual([...primitives[1].featureIds], [3, 3, 3, 3, 5, 5, 5, 5]);
  assert.deepEqual([...primitives[0].positions.slice(12, 15)], [69, 7, 2]);
  assert.equal(encodeBatchGlb({ chunks: [{ opaque: null }] }), null);
});

test('encodeBatchGlb: a kind past 65,535 vertices split into 16-bit primitives, the same bytes as encodeBlocksGlb', () => {
  const part = packPart(quad(0, 0, 0));
  const chunks = Array.from({ length: 16_385 }, () => ({
    opaque: part,
    features: { opaque: 0 },
  }));
  const glb = encodeBatchGlb({ chunks, features: { count: 1 } });
  const { primitives, json } = readBlocksGlb(glb);
  assert.equal(primitives.length, 2);
  for (const primitive of json.meshes[0].primitives)
    assert.equal(json.accessors[primitive.indices].componentType, 5123);
  assert.deepEqual(
    primitives.map((p) => p.positions.length / 3),
    // Cut by triangles: the second triangle of the quad at the cut opens
    // the next primitive with its corners again.
    [65_535, 7],
  );
  assert.equal(
    primitives.reduce((n, p) => n + p.indices.length, 0),
    16_385 * 6,
  );
  assert.deepEqual(
    glb,
    encodeBlocksGlb({
      opaque: mergeParts(
        chunks.map(({ opaque }) => ({ part: opaque, feature: 0 })),
      ),
      features: { count: 1 },
    }),
  );
});

test('splitPrimitives: a fanned mesh past 65,535 vertices cut by its triangles, every triangle kept with its own vertices', () => {
  // Steps every column: unevenly shaded faces, fanned round centre
  // vertices written after every quad's corners (mesh.js).
  const top = new Int32Array(64 * 64).map((_, k) => ((k % 64) + (k >> 6)) % 5);
  const mesh = buildChunkMesh(createChunk({ ci: 0, cj: 0, top }), {
    blockM: 1,
  });
  assert.ok(
    mesh.blockCoords.some((v) => !Number.isInteger(v)),
    'fans',
  );
  const copies = Math.ceil(70_000 / (mesh.positions.length / 3));
  const merged = mergeParts(
    Array.from({ length: copies }, (_, k) => ({
      part: mesh,
      offset: { x: 64 * k, y: 0, z: 0 },
      feature: k % 256,
    })),
  );
  assert.ok(merged.vertexCount > 65_535);
  const parts = splitPrimitives(merged);
  assert.ok(parts.length > 1);
  const triangles = (positions, indices) => {
    const out = [];
    for (let k = 0; k < indices.length; k += 3)
      out.push(
        [0, 1, 2]
          .map((c) =>
            [
              ...positions.slice(indices[k + c] * 3, indices[k + c] * 3 + 3),
            ].join(','),
          )
          .join(' / '),
      );
    return out;
  };
  const all = [];
  for (const part of parts) {
    assert.ok(part.vertexCount <= 65_535);
    assert.ok(part.indices instanceof Uint16Array);
    for (const index of part.indices) assert.ok(index < part.vertexCount);
    all.push(...triangles(part.positions, part.indices));
  }
  assert.deepEqual(
    all,
    triangles(merged.positions, merged.indices),
    'every triangle, in order',
  );
});
