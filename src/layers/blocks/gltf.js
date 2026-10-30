// Personal fork: Blocks chunk meshes as binary glTF (docs/BLOCKS-PLAN.md,
// milestone 6 and the renderer's batches). One encoder for both: the
// renderer's in-memory Cesium Models (renderer.js) and the precomputed
// tileset's tiles (scripts/blocks-tileset.mjs), so a tile and a batch drawn
// live are the same bytes and draw with the same shader
// (BLOCKS_CUSTOM_SHADER_* in renderer.js). Pure JavaScript, no Cesium: it
// runs in Node, the page and a web worker.
//
// The layout (v2, 2026-10-30: 28 bytes a vertex, was 36):
// - glTF's Y-up: a vertex at (east, north, up) of the origin is stored at
//   (east, up, −north); Cesium's default Y-up to Z-up turns it back, for a
//   Model and a 3D Tiles tile alike. No node matrix: the Model's
//   modelMatrix, or the tile's transform, places the origin.
// - POSITION: FLOAT VEC3, with min and max.
// - NORMAL: BYTE normalized VEC3 on a 4-byte stride (KHR_mesh_quantization);
//   the faces' normals are axis unit vectors, so exact. Its fourth byte is
//   _FEATURE_ID_0: UNSIGNED_BYTE SCALAR, the vertex's row of the property
//   table (EXT_mesh_features; at most 255 rows: a tile has 16, a live
//   batch 32), the same view at byte offset 3. The table
//   (EXT_structural_metadata, class 'chunk') is what makes Cesium pick
//   features one by one.
// - COLOR_0: UNSIGNED_BYTE normalized VEC4, mesh.js's baked shade as it
//   wrote it (the shader reads it raw). Water alone is below 255 alpha.
// - _BLOCKCOORD: SHORT VEC3 on an 8-byte stride, mesh.js's block point
//   (columns east, north, the level) in half blocks (× 2, so a shaded
//   face's centre is whole), with the chunk's columns folded in modulo
//   FOLD_COLUMNS so the dither's per-block hash runs on across chunks. The
//   shader reads it × 0.5. Folded columns reach 8,192 half blocks, levels
//   ±16,383 (Everest at 1 m blocks is 17,696: a RangeError, not a wrap).
// - Indices UNSIGNED_SHORT: a kind past 65,535 vertices is split into
//   several primitives by its triangles, each gathering its own vertices.
// - One mesh: the opaque faces' primitives (material 0, OPAQUE), then the
//   water's (material 1, BLEND), all unlit (KHR_materials_unlit) and
//   double-sided, so any glTF viewer shows the baked colours.

import { CHUNK_COLUMNS } from './grid.js';

/** The block point's columns wrap at this many (a whole number of chunks). */
export const FOLD_COLUMNS = 4096;

const FOLD_CHUNKS = FOLD_COLUMNS / CHUNK_COLUMNS;

/** The most vertices one primitive holds (its indices 16-bit). */
export const PRIMITIVE_VERTICES = 65535;

const GL = Object.freeze({
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
  TRIANGLES: 4,
});

/** A property table column's glTF component type, by typed array. */
const COMPONENT_TYPES = [
  [Int8Array, 'INT8'],
  [Uint8Array, 'UINT8'],
  [Int16Array, 'INT16'],
  [Uint16Array, 'UINT16'],
  [Int32Array, 'INT32'],
  [Uint32Array, 'UINT32'],
  [Float32Array, 'FLOAT32'],
  [Float64Array, 'FLOAT64'],
];

/** A chunk index's fold: its column offset, 0 … FOLD_COLUMNS − 64. */
export const foldColumns = (index) =>
  ((((Math.trunc(index) || 0) % FOLD_CHUNKS) + FOLD_CHUNKS) % FOLD_CHUNKS) *
  CHUNK_COLUMNS;

/** A block point's coordinate in half blocks, checked against SHORT. */
function halfBlocks(value) {
  const half = Math.round(value * 2);
  if (half < -32768 || half > 32767)
    throw new RangeError(
      `block coordinate ${value} is past a SHORT's half blocks`,
    );
  return half;
}

/**
 * One chunk's part (one kind of its faces) in the layout above, its own
 * vertices from 0: positions turned Y-up, normals as bytes on a 4-byte
 * stride (the fourth byte left for the feature id), colours as given,
 * block points in half blocks on an 8-byte stride moved by its columns
 * (`blockOffset` as given, else its chunk (ci, cj) folded), indices 16-bit
 * where they fit. What a batch copies from (encodeBatchGlb): computed once
 * a chunk, in the mesh worker. Positions are taken as they are (a tile's
 * may be dropped onto the curve); min and max are theirs, as stored.
 * @param {object|null} part {positions, normals, colors, blockCoords?,
 *   indices}, as mesh.js and splitMesh give it (block points in blocks).
 * @returns {object|null} {packed: true, positions, normals, colors,
 *   blockCoords, indices, min, max, vertexCount}, or null with no faces.
 */
export function packPart(part, { chunk, blockOffset } = {}) {
  if (!part?.indices?.length) return null;
  if (part.packed) return part;
  const n = part.positions.length / 3;
  const positions = new Float32Array(n * 3);
  const normals = new Int8Array(n * 4);
  const colors = new Uint8Array(n * 4);
  const blockCoords = new Int16Array(n * 4);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const fx = blockOffset ? blockOffset[0] || 0 : foldColumns(chunk?.[0]);
  const fy = blockOffset ? blockOffset[1] || 0 : foldColumns(chunk?.[1]);
  const scale = part.normals instanceof Int8Array ? 1 : 127;
  for (let v = 0; v < n; v++) {
    const k = v * 3;
    // (east, north, up) → glTF's (east, up, −north); 0 − never −0.
    positions[k] = part.positions[k];
    positions[k + 1] = part.positions[k + 2];
    positions[k + 2] = 0 - part.positions[k + 1];
    for (let a = 0; a < 3; a++) {
      const value = positions[k + a];
      if (value < min[a]) min[a] = value;
      if (value > max[a]) max[a] = value;
    }
    const q = v * 4;
    normals[q] = Math.round(part.normals[k] * scale);
    normals[q + 1] = Math.round(part.normals[k + 2] * scale);
    normals[q + 2] = Math.round(-part.normals[k + 1] * scale);
    if (part.blockCoords) {
      blockCoords[q] = halfBlocks(part.blockCoords[k] + fx);
      blockCoords[q + 1] = halfBlocks(part.blockCoords[k + 1] + fy);
      blockCoords[q + 2] = halfBlocks(part.blockCoords[k + 2]);
    }
  }
  colors.set(part.colors.subarray(0, n * 4));
  const indices =
    n < 65536 ? Uint16Array.from(part.indices) : Uint32Array.from(part.indices);
  return {
    packed: true,
    positions,
    normals,
    colors,
    blockCoords,
    indices,
    min,
    max,
    vertexCount: n,
  };
}

/** A packed part's buffers (to transfer between threads). */
export const packedBuffers = (packed) =>
  packed
    ? [
        packed.positions,
        packed.normals,
        packed.colors,
        packed.blockCoords,
        packed.indices,
      ].map((array) => array.buffer)
    : [];

/** A packed part's bytes. */
export const packedBytes = (packed) =>
  packed
    ? packed.positions.byteLength +
      packed.normals.byteLength +
      packed.colors.byteLength +
      packed.blockCoords.byteLength +
      packed.indices.byteLength
    : 0;

/** A primitive's arrays of `n` vertices and `indexCount` indices (in the layout). */
const newArrays = (n, indexCount, big = false) => ({
  positions: new Float32Array(n * 3),
  normals: new Int8Array(n * 4),
  colors: new Uint8Array(n * 4),
  blockCoords: new Int16Array(n * 4),
  indices: big ? new Uint32Array(indexCount) : new Uint16Array(indexCount),
});

/**
 * Packed parts of one kind side by side: each moved by its offset (m,
 * east, north and up of the origin), its feature row in each normal's
 * fourth byte, indices renumbered. Writes into `out` (the GLB's views,
 * encodeBatchGlb, under 65,536 vertices) or returns new arrays, with
 * 32-bit indices past that for splitPrimitives to cut.
 */
function joinPacked(entries, out = null) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { packed } of entries)
    if (packed) {
      vertexCount += packed.vertexCount;
      indexCount += packed.indices.length;
    }
  if (!indexCount) return null;
  const target =
    out || newArrays(vertexCount, indexCount, vertexCount >= 65536);
  const featureBytes = new Uint8Array(
    target.normals.buffer,
    target.normals.byteOffset,
    target.normals.byteLength,
  );
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let base = 0;
  let at = 0;
  for (const { packed, offset, feature } of entries) {
    if (!packed) continue;
    if (!(feature >= 0 && feature <= 255))
      throw new RangeError(`feature ${feature} is past an UNSIGNED_BYTE`);
    // In the stored frame: east, up, −north.
    const shift = [offset?.x || 0, offset?.z || 0, 0 - (offset?.y || 0)];
    const n = packed.vertexCount;
    const { positions } = target;
    if (shift[0] || shift[1] || shift[2]) {
      for (let k = 0; k < n * 3; k += 3) {
        positions[base * 3 + k] = packed.positions[k] + shift[0];
        positions[base * 3 + k + 1] = packed.positions[k + 1] + shift[1];
        positions[base * 3 + k + 2] = packed.positions[k + 2] + shift[2];
      }
    } else positions.set(packed.positions, base * 3);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], Math.fround(packed.min[a] + shift[a]));
      max[a] = Math.max(max[a], Math.fround(packed.max[a] + shift[a]));
    }
    target.normals.set(packed.normals, base * 4);
    for (let v = 0; v < n; v++) featureBytes[(base + v) * 4 + 3] = feature;
    target.colors.set(packed.colors, base * 4);
    target.blockCoords.set(packed.blockCoords, base * 4);
    const { indices } = packed;
    if (base === 0) target.indices.set(indices, at);
    else
      for (let k = 0; k < indices.length; k++)
        target.indices[at + k] = indices[k] + base;
    at += indices.length;
    base += n;
  }
  return { ...target, min, max, vertexCount };
}

/** The feature row of each vertex, from its normal's fourth byte. */
const featureIdsOf = ({ normals, vertexCount }) => {
  const bytes = new Uint8Array(
    normals.buffer,
    normals.byteOffset,
    normals.byteLength,
  );
  return Uint8Array.from({ length: vertexCount }, (_, v) => bytes[v * 4 + 3]);
};

/**
 * One kind's joined arrays as primitives of at most PRIMITIVE_VERTICES
 * vertices, 16-bit indices each: cut by its triangles in order (a fan's
 * centre vertex is not beside its face's corners), each primitive gathering
 * the vertices its triangles use, renumbered. Under 65,536 vertices: one.
 */
export function splitPrimitives(merged) {
  if (!merged) return [];
  if (merged.vertexCount <= PRIMITIVE_VERTICES)
    return [
      {
        ...merged,
        indices:
          merged.indices instanceof Uint16Array
            ? merged.indices
            : Uint16Array.from(merged.indices),
      },
    ];
  const source = merged.indices;
  const remap = new Int32Array(merged.vertexCount).fill(-1);
  const out = [];
  for (let from = 0; from < source.length;) {
    const used = [];
    let to = from;
    for (; to < source.length; to += 3) {
      let fresh = 0;
      for (let c = 0; c < 3; c++) {
        const v = source[to + c];
        if (remap[v] < 0 && source.indexOf(v, to) === to + c) fresh++;
      }
      if (used.length + fresh > PRIMITIVE_VERTICES) break;
      for (let c = 0; c < 3; c++) {
        const v = source[to + c];
        if (remap[v] < 0) {
          remap[v] = used.length;
          used.push(v);
        }
      }
    }
    const n = used.length;
    const part = newArrays(n, to - from);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    used.forEach((v, w) => {
      for (let a = 0; a < 3; a++) {
        const value = merged.positions[v * 3 + a];
        part.positions[w * 3 + a] = value;
        if (value < min[a]) min[a] = value;
        if (value > max[a]) max[a] = value;
      }
      for (let a = 0; a < 4; a++) {
        part.normals[w * 4 + a] = merged.normals[v * 4 + a];
        part.colors[w * 4 + a] = merged.colors[v * 4 + a];
        part.blockCoords[w * 4 + a] = merged.blockCoords[v * 4 + a];
      }
    });
    for (let k = from; k < to; k++) part.indices[k - from] = remap[source[k]];
    for (const v of used) remap[v] = -1;
    out.push({ ...part, min, max, vertexCount: n });
    from = to;
  }
  return out;
}

/**
 * The chunks of one kind ('opaque' or 'water') merged into one kind's
 * arrays, in the layout above: each chunk's part packed (packPart: its
 * block points moved by `blockOffset`, else its chunk folded), moved by
 * its offset (m, east, north and up of the origin), every vertex tagged
 * with its feature row. A part already packed is taken as it is. Past
 * 65,535 vertices the indices are 32-bit, for encodeBlocksGlb to split.
 * @param {Array<{part: object|null, offset?: {x, y, z}, chunk?: number[],
 *   blockOffset?: number[], feature: number}>} chunks
 * @returns {object|null} {positions, normals, colors, blockCoords,
 *   featureIds, indices, min, max, vertexCount}, or null with no faces
 *   (featureIds: the rows again, one byte a vertex, for reading).
 */
export function mergeParts(chunks) {
  const merged = joinPacked(
    chunks.map(({ part, offset, chunk, blockOffset, feature }) => ({
      packed: packPart(part, { chunk, blockOffset }),
      offset,
      feature,
    })),
  );
  return merged ? { ...merged, featureIds: featureIdsOf(merged) } : null;
}

const pad4 = (n) => (n + 3) & ~3;
const align8 = (n) => (n + 7) & ~7;

/** A property table's columns as typed arrays of `count` rows, and their glTF types. */
function tableColumns(features) {
  const count = Math.max(1, features?.count || 0);
  const properties = Object.entries(features?.properties || {});
  if (!properties.length)
    properties.push(['row', Uint32Array.from({ length: count }, (_, k) => k)]);
  return {
    count,
    columns: properties.map(([name, values]) => {
      const [Type, componentType] =
        COMPONENT_TYPES.find(([Type]) => values instanceof Type) ||
        COMPONENT_TYPES[5];
      const column =
        values instanceof Type && values.length === count
          ? values
          : Type.from({ length: count }, (_, k) => values[k] ?? 0);
      return { name, column, componentType };
    }),
  };
}

/**
 * The GLB's layout for primitives of these sizes and a property table:
 * its JSON, the binary chunk's length, and where each view starts in it.
 * Every view starts on 8 bytes (a FLOAT64 column's alignment, and more
 * than any vertex attribute needs).
 */
function glbLayout(primitives, table) {
  let length = 0;
  const bufferViews = [];
  const accessors = [];
  const view = (byteLength, target, byteStride) => {
    const byteOffset = align8(length);
    length = byteOffset + byteLength;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength,
      ...(byteStride ? { byteStride } : {}),
      ...(target ? { target } : {}),
    });
    return bufferViews.length - 1;
  };
  const accessor = (bufferView, componentType, count, type, extra = {}) => {
    accessors.push({ bufferView, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const at = [];
  const meshPrimitives = primitives.map(
    ({ kind, vertexCount: n, indexCount, min, max }) => {
      const views = {
        positions: view(n * 12, GL.ARRAY_BUFFER),
        normals: view(n * 4, GL.ARRAY_BUFFER, 4),
        colors: view(n * 4, GL.ARRAY_BUFFER),
        blockCoords: view(n * 8, GL.ARRAY_BUFFER, 8),
        indices: view(indexCount * 2, GL.ELEMENT_ARRAY_BUFFER),
      };
      at.push(
        Object.fromEntries(
          Object.entries(views).map(([name, index]) => [
            name,
            bufferViews[index].byteOffset,
          ]),
        ),
      );
      return {
        attributes: {
          POSITION: accessor(views.positions, GL.FLOAT, n, 'VEC3', {
            min,
            max,
          }),
          NORMAL: accessor(views.normals, GL.BYTE, n, 'VEC3', {
            normalized: true,
          }),
          COLOR_0: accessor(views.colors, GL.UNSIGNED_BYTE, n, 'VEC4', {
            normalized: true,
          }),
          _BLOCKCOORD: accessor(views.blockCoords, GL.SHORT, n, 'VEC3'),
          // The normals' fourth byte.
          _FEATURE_ID_0: accessor(
            views.normals,
            GL.UNSIGNED_BYTE,
            n,
            'SCALAR',
            {
              byteOffset: 3,
            },
          ),
        },
        indices: accessor(
          views.indices,
          GL.UNSIGNED_SHORT,
          indexCount,
          'SCALAR',
        ),
        material: kind === 'water' ? 1 : 0,
        mode: GL.TRIANGLES,
        extensions: {
          EXT_mesh_features: {
            featureIds: [
              { featureCount: table.count, attribute: 0, propertyTable: 0 },
            ],
          },
        },
      };
    },
  );
  const classProperties = {};
  const tableProperties = {};
  const columnsAt = table.columns.map(({ name, column, componentType }) => {
    classProperties[name] = { type: 'SCALAR', componentType };
    const index = view(column.byteLength);
    tableProperties[name] = { values: index };
    return bufferViews[index].byteOffset;
  });
  const material = (name, alphaMode) => ({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    alphaMode,
    doubleSided: true,
    extensions: { KHR_materials_unlit: {} },
  });
  const json = {
    asset: { version: '2.0', generator: 'godseye blocks gltf.js' },
    extensionsUsed: [
      'KHR_mesh_quantization',
      'KHR_materials_unlit',
      'EXT_mesh_features',
      'EXT_structural_metadata',
    ],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: meshPrimitives }],
    materials: [material('blocks', 'OPAQUE'), material('water', 'BLEND')],
    accessors,
    bufferViews,
    buffers: [{ byteLength: pad4(length) }],
    extensions: {
      EXT_structural_metadata: {
        schema: {
          id: 'blocks',
          classes: { chunk: { properties: classProperties } },
        },
        propertyTables: [
          { class: 'chunk', count: table.count, properties: tableProperties },
        ],
      },
    },
  };
  return { json, binLength: pad4(length), at, columnsAt };
}

/**
 * A GLB of the layout's size, its header and JSON written: the binary
 * chunk's start, and views over the GLB for each primitive's arrays.
 */
function glbShell(layout, primitives) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(layout.json));
  const jsonLength = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonLength + 8 + layout.binLength;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonBytes, 20);
  glb.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  const bin = 20 + jsonLength;
  view.setUint32(bin, layout.binLength, true);
  view.setUint32(bin + 4, 0x004e4942, true); // 'BIN\0'
  const start = bin + 8;
  const targets = primitives.map(({ vertexCount: n, indexCount }, k) => {
    const at = layout.at[k];
    return {
      positions: new Float32Array(glb.buffer, start + at.positions, n * 3),
      normals: new Int8Array(glb.buffer, start + at.normals, n * 4),
      colors: new Uint8Array(glb.buffer, start + at.colors, n * 4),
      blockCoords: new Int16Array(glb.buffer, start + at.blockCoords, n * 4),
      indices: new Uint16Array(glb.buffer, start + at.indices, indexCount),
    };
  });
  return { glb, start, targets };
}

/** The property table's columns into their views. */
function writeColumns(glb, start, layout, table) {
  table.columns.forEach(({ column }, k) =>
    glb.set(
      new Uint8Array(column.buffer, column.byteOffset, column.byteLength),
      start + layout.columnsAt[k],
    ),
  );
}

/** A primitive's description for the layout, from its arrays. */
const primitiveOf = (kind, arrays) => ({
  kind,
  arrays,
  vertexCount: arrays.vertexCount,
  indexCount: arrays.indices.length,
  min: arrays.min.map(Math.fround),
  max: arrays.max.map(Math.fround),
});

/** Write primitives' arrays into their views. */
function writePrimitives(targets, primitives) {
  primitives.forEach(({ arrays }, k) => {
    for (const name of [
      'positions',
      'normals',
      'colors',
      'blockCoords',
      'indices',
    ])
      targets[k][name].set(arrays[name]);
  });
}

/**
 * A GLB of one mesh: the opaque primitives, then the water ones, each kind
 * merged from its chunks (mergeParts) and split at 65,535 vertices
 * (splitPrimitives), with a property table of `features.count` rows (class
 * 'chunk') whose columns are `features.properties`.
 * @param {{opaque?: object|null, water?: object|null,
 *   features: {count: number, properties: Object<string, ArrayLike>}}} input
 *   opaque, water: mergeParts' output (null for none).
 * @returns {Uint8Array|null} null when neither kind has faces.
 */
export function encodeBlocksGlb({ opaque = null, water = null, features }) {
  const primitives = [
    ['opaque', opaque],
    ['water', water],
  ].flatMap(([kind, merged]) =>
    splitPrimitives(merged).map((arrays) => primitiveOf(kind, arrays)),
  );
  if (!primitives.length) return null;
  const table = tableColumns(features);
  const layout = glbLayout(primitives, table);
  const { glb, start, targets } = glbShell(layout, primitives);
  writePrimitives(targets, primitives);
  writeColumns(glb, start, layout, table);
  return glb;
}

/**
 * A batch's GLB straight from its chunks' packed parts (packPart): a kind
 * under 65,536 vertices joined straight into the GLB's views, one past it
 * joined and split (splitPrimitives). Each chunk's opaque faces feature
 * `features.opaque` (else its index s), its water `features.water` (else
 * n + s), moved by its offset (m, east, north and up of the GLB's origin).
 * The same bytes as encodeBlocksGlb of mergeParts of the same chunks.
 * @param {{chunks: Array<{opaque?: object|null, water?: object|null,
 *   offset?: {x, y, z}, features?: {opaque?: number, water?: number}}>,
 *   features: {count: number, properties: Object<string, ArrayLike>}}} input
 * @returns {Uint8Array|null} null when no chunk has faces.
 */
export function encodeBatchGlb({ chunks, features }) {
  const n = chunks.length;
  const entriesOf = (kind) =>
    chunks.map((chunk, s) => ({
      packed: chunk[kind] || null,
      offset: chunk.offset,
      feature: chunk.features?.[kind] ?? (kind === 'water' ? n + s : s),
    }));
  const primitives = [];
  for (const kind of ['opaque', 'water']) {
    const entries = entriesOf(kind);
    let vertexCount = 0;
    let indexCount = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const { packed, offset } of entries) {
      if (!packed) continue;
      vertexCount += packed.vertexCount;
      indexCount += packed.indices.length;
      const shift = [offset?.x || 0, offset?.z || 0, 0 - (offset?.y || 0)];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], Math.fround(packed.min[a] + shift[a]));
        max[a] = Math.max(max[a], Math.fround(packed.max[a] + shift[a]));
      }
    }
    if (!indexCount) continue;
    if (vertexCount <= PRIMITIVE_VERTICES)
      primitives.push({ kind, entries, vertexCount, indexCount, min, max });
    else
      for (const arrays of splitPrimitives(joinPacked(entries)))
        primitives.push(primitiveOf(kind, arrays));
  }
  if (!primitives.length) return null;
  const table = tableColumns(features);
  const layout = glbLayout(primitives, table);
  const { glb, start, targets } = glbShell(layout, primitives);
  primitives.forEach((primitive, k) => {
    if (primitive.entries) joinPacked(primitive.entries, targets[k]);
    else writePrimitives([targets[k]], [primitive]);
  });
  writeColumns(glb, start, layout, table);
  return glb;
}

/** A GLB's JSON and binary chunk (for tests and tools). */
export function readGlb(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)),
  );
  const binAt = 20 + jsonLength;
  const binLength = view.getUint32(binAt, true);
  const bin = glb.subarray(binAt + 8, binAt + 8 + binLength);
  return { json, bin };
}

const COMPONENTS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** An accessor's values, as a new typed array of its component type (strides undone). */
export function accessorValues(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Type = COMPONENTS[accessor.componentType];
  const size = SIZES[accessor.type];
  const stride = view.byteStride
    ? view.byteStride / Type.BYTES_PER_ELEMENT
    : size;
  const all = new Type(
    bin.buffer,
    bin.byteOffset + view.byteOffset + (accessor.byteOffset || 0),
    Math.floor(
      (view.byteLength - (accessor.byteOffset || 0)) / Type.BYTES_PER_ELEMENT,
    ),
  );
  const out = new Type(accessor.count * size);
  for (let k = 0; k < accessor.count; k++)
    for (let c = 0; c < size; c++) out[k * size + c] = all[k * stride + c];
  return out;
}

/**
 * A Blocks GLB read back (encodeBlocksGlb's inverse, for tests and tools):
 * each primitive's kind ('opaque' or 'water' by its material's alpha mode;
 * a kind past 65,535 vertices comes as several), positions in (east,
 * north, up) again, normals as stored (Y-up bytes), colours, block points
 * in blocks again (the stored half blocks × 0.5), feature ids and indices;
 * the property table's columns by name and its row count.
 */
export function readBlocksGlb(glb) {
  const { json, bin } = readGlb(glb);
  const metadata = json.extensions?.EXT_structural_metadata;
  const table = metadata?.propertyTables?.[0];
  const properties = {};
  for (const [name, { values }] of Object.entries(table?.properties || {})) {
    const view = json.bufferViews[values];
    const Type = COMPONENT_TYPES.find(
      ([, type]) =>
        type ===
        metadata.schema.classes[table.class].properties[name].componentType,
    )[0];
    properties[name] = new Type(
      bin.buffer.slice(
        bin.byteOffset + view.byteOffset,
        bin.byteOffset + view.byteOffset + table.count * Type.BYTES_PER_ELEMENT,
      ),
    );
  }
  const primitives = json.meshes[0].primitives.map((primitive) => {
    const { attributes } = primitive;
    const yUp = accessorValues(json, bin, attributes.POSITION);
    const positions = new Float32Array(yUp.length);
    for (let k = 0; k < yUp.length; k += 3) {
      positions[k] = yUp[k];
      positions[k + 1] = 0 - yUp[k + 2];
      positions[k + 2] = yUp[k + 1];
    }
    const half = accessorValues(json, bin, attributes._BLOCKCOORD);
    return {
      kind:
        json.materials[primitive.material].alphaMode === 'BLEND'
          ? 'water'
          : 'opaque',
      positions,
      normals: accessorValues(json, bin, attributes.NORMAL),
      colors: accessorValues(json, bin, attributes.COLOR_0),
      blockCoords: Float32Array.from(half, (value) => value / 2),
      featureIds: accessorValues(json, bin, attributes._FEATURE_ID_0),
      indices: accessorValues(json, bin, primitive.indices),
    };
  });
  return { json, primitives, properties, featureCount: table?.count ?? 0 };
}
