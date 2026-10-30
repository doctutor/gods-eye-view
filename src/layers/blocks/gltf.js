// Personal fork: Blocks chunk meshes as binary glTF (docs/BLOCKS-PLAN.md,
// milestone 6 and the renderer's batches). One encoder for both: the
// renderer's in-memory Cesium Models (renderer.js) and the precomputed
// tileset's tiles (scripts/blocks-tileset.mjs), so a tile and a batch drawn
// live are the same bytes and draw with the same shader
// (BLOCKS_CUSTOM_SHADER_* in renderer.js). Pure JavaScript, no Cesium: it
// runs in Node, the page and a web worker.
//
// The layout:
// - glTF's Y-up: a vertex at (east, north, up) of the origin is stored at
//   (east, up, −north); Cesium's default Y-up to Z-up turns it back, for a
//   Model and a 3D Tiles tile alike. No node matrix: the Model's
//   modelMatrix, or the tile's transform, places the origin.
// - POSITION: FLOAT VEC3, with min and max.
// - NORMAL: BYTE normalized VEC3, a 4-byte stride (KHR_mesh_quantization);
//   the faces' normals are axis unit vectors, so exact.
// - COLOR_0: UNSIGNED_BYTE normalized VEC4, mesh.js's baked shade as it
//   wrote it (the shader reads it raw). Water alone is below 255 alpha.
// - _BLOCKCOORD: FLOAT VEC3, mesh.js's block point (columns east, north,
//   the level), with the chunk's columns folded in modulo FOLD_COLUMNS so
//   the dither's per-block hash runs on across chunks: whole numbers stay
//   whole and float stays exact.
// - _FEATURE_ID_0: FLOAT SCALAR, the vertex's row of the property table
//   (EXT_mesh_features); the table (EXT_structural_metadata, class
//   'chunk') is what makes Cesium pick features one by one.
// - Indices UNSIGNED_SHORT under 65,536 vertices a primitive, else
//   UNSIGNED_INT.
// - One mesh: the opaque faces' primitive (material 0, OPAQUE), then the
//   water's (material 1, BLEND), both unlit (KHR_materials_unlit) and
//   double-sided, so any glTF viewer shows the baked colours.

import { CHUNK_COLUMNS } from './grid.js';

/** The block point's columns wrap at this many (a whole number of chunks). */
export const FOLD_COLUMNS = 4096;

const FOLD_CHUNKS = FOLD_COLUMNS / CHUNK_COLUMNS;

const GL = Object.freeze({
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
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

/**
 * The chunks of one kind ('opaque' or 'water') merged into one primitive's
 * arrays, in the layout above: each chunk's part moved by its offset (m,
 * east, north and up of the origin), its block points moved by its
 * columns (`blockOffset` as given, else its chunk (ci, cj) folded), every
 * vertex tagged with its feature row. Positions are taken as they are
 * (a tile's may be dropped onto the curve), min and max from them.
 * @param {Array<{part: object|null, offset?: {x, y, z}, chunk?: number[],
 *   blockOffset?: number[], feature: number}>} chunks part: {positions,
 *   normals, colors, blockCoords?, indices}, as mesh.js and the renderer's
 *   splitMesh give it.
 * @returns {object|null} {positions, normals, colors, blockCoords,
 *   featureIds, indices, min, max, vertexCount}, or null with no faces.
 */
export function mergeParts(chunks) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { part } of chunks) {
    if (!part?.indices?.length) continue;
    vertexCount += part.positions.length / 3;
    indexCount += part.indices.length;
  }
  if (!indexCount) return null;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Int8Array(vertexCount * 4);
  const colors = new Uint8Array(vertexCount * 4);
  const blockCoords = new Float32Array(vertexCount * 3);
  const featureIds = new Float32Array(vertexCount);
  const indices =
    vertexCount < 65536
      ? new Uint16Array(indexCount)
      : new Uint32Array(indexCount);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let base = 0;
  let at = 0;
  for (const { part, offset, chunk, blockOffset, feature } of chunks) {
    if (!part?.indices?.length) continue;
    const ox = offset?.x || 0;
    const oy = offset?.y || 0;
    const oz = offset?.z || 0;
    const fx = blockOffset ? blockOffset[0] || 0 : foldColumns(chunk?.[0]);
    const fy = blockOffset ? blockOffset[1] || 0 : foldColumns(chunk?.[1]);
    const n = part.positions.length / 3;
    const bytes = part.normals instanceof Int8Array;
    for (let v = 0; v < n; v++) {
      const k = v * 3;
      const out = (base + v) * 3;
      // (east, north, up) → glTF's (east, up, −north); 0 − never −0.
      const e = part.positions[k] + ox;
      const u = part.positions[k + 2] + oz;
      const s = 0 - (part.positions[k + 1] + oy);
      positions[out] = e;
      positions[out + 1] = u;
      positions[out + 2] = s;
      if (e < min[0]) min[0] = e;
      if (e > max[0]) max[0] = e;
      if (u < min[1]) min[1] = u;
      if (u > max[1]) max[1] = u;
      if (s < min[2]) min[2] = s;
      if (s > max[2]) max[2] = s;
      const nOut = (base + v) * 4;
      const scale = bytes ? 1 : 127;
      normals[nOut] = Math.round(part.normals[k] * scale);
      normals[nOut + 1] = Math.round(part.normals[k + 2] * scale);
      normals[nOut + 2] = Math.round(-part.normals[k + 1] * scale);
      const c = v * 4;
      colors[nOut] = part.colors[c];
      colors[nOut + 1] = part.colors[c + 1];
      colors[nOut + 2] = part.colors[c + 2];
      colors[nOut + 3] = part.colors[c + 3];
      if (part.blockCoords) {
        blockCoords[out] = part.blockCoords[k] + fx;
        blockCoords[out + 1] = part.blockCoords[k + 1] + fy;
        blockCoords[out + 2] = part.blockCoords[k + 2];
      }
      featureIds[base + v] = feature;
    }
    const { indices: from } = part;
    for (let k = 0; k < from.length; k++) indices[at + k] = from[k] + base;
    at += from.length;
    base += n;
  }
  return {
    positions,
    normals,
    colors,
    blockCoords,
    featureIds,
    indices,
    min,
    max,
    vertexCount,
  };
}

const pad4 = (n) => (n + 3) & ~3;

/**
 * A GLB of one mesh: the opaque primitive, then the water one, each merged
 * from its chunks (mergeParts), with a property table of `features.count`
 * rows (class 'chunk') whose columns are `features.properties`.
 * @param {{opaque?: object|null, water?: object|null,
 *   features: {count: number, properties: Object<string, ArrayLike>}}} input
 *   opaque, water: mergeParts' output (null for none).
 * @returns {Uint8Array|null} null when neither kind has faces.
 */
export function encodeBlocksGlb({ opaque = null, water = null, features }) {
  const kinds = [
    ['opaque', opaque],
    ['water', water],
  ].filter(([, merged]) => merged);
  if (!kinds.length) return null;
  const count = Math.max(1, features?.count || 0);
  const properties = Object.entries(features?.properties || {});
  if (!properties.length)
    properties.push(['row', Uint32Array.from({ length: count }, (_, k) => k)]);

  const views = [];
  const pieces = [];
  let length = 0;
  const addView = (array, target, byteStride) => {
    const bytes = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength,
    );
    // Every view starts on 8 bytes: a FLOAT64 column's alignment, and more
    // than any vertex attribute needs.
    const offset = (length + 7) & ~7;
    if (offset > length) pieces.push(new Uint8Array(offset - length));
    pieces.push(bytes);
    length = offset + bytes.byteLength;
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      ...(byteStride ? { byteStride } : {}),
      ...(target ? { target } : {}),
    });
    return views.length - 1;
  };

  const accessors = [];
  const addAccessor = (view, componentType, countOf, type, extra = {}) => {
    accessors.push({
      bufferView: view,
      componentType,
      count: countOf,
      type,
      ...extra,
    });
    return accessors.length - 1;
  };

  const primitives = kinds.map(([kind, merged]) => {
    const n = merged.vertexCount;
    const position = addAccessor(
      addView(merged.positions, GL.ARRAY_BUFFER),
      GL.FLOAT,
      n,
      'VEC3',
      { min: merged.min, max: merged.max },
    );
    const normal = addAccessor(
      addView(merged.normals, GL.ARRAY_BUFFER, 4),
      GL.BYTE,
      n,
      'VEC3',
      { normalized: true },
    );
    const color = addAccessor(
      addView(merged.colors, GL.ARRAY_BUFFER),
      GL.UNSIGNED_BYTE,
      n,
      'VEC4',
      { normalized: true },
    );
    const blockCoord = addAccessor(
      addView(merged.blockCoords, GL.ARRAY_BUFFER),
      GL.FLOAT,
      n,
      'VEC3',
    );
    const featureId = addAccessor(
      addView(merged.featureIds, GL.ARRAY_BUFFER),
      GL.FLOAT,
      n,
      'SCALAR',
    );
    const indices = addAccessor(
      addView(merged.indices, GL.ELEMENT_ARRAY_BUFFER),
      merged.indices instanceof Uint16Array
        ? GL.UNSIGNED_SHORT
        : GL.UNSIGNED_INT,
      merged.indices.length,
      'SCALAR',
    );
    return {
      attributes: {
        POSITION: position,
        NORMAL: normal,
        COLOR_0: color,
        _BLOCKCOORD: blockCoord,
        _FEATURE_ID_0: featureId,
      },
      indices,
      material: kind === 'water' ? 1 : 0,
      mode: GL.TRIANGLES,
      extensions: {
        EXT_mesh_features: {
          featureIds: [{ featureCount: count, attribute: 0, propertyTable: 0 }],
        },
      },
    };
  });

  const classProperties = {};
  const tableProperties = {};
  for (const [name, values] of properties) {
    const [Type, componentType] =
      COMPONENT_TYPES.find(([Type]) => values instanceof Type) ||
      COMPONENT_TYPES[5];
    const column =
      values instanceof Type && values.length === count
        ? values
        : Type.from({ length: count }, (_, k) => values[k] ?? 0);
    classProperties[name] = { type: 'SCALAR', componentType };
    tableProperties[name] = { values: addView(column) };
  }

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
    meshes: [{ primitives }],
    materials: [material('blocks', 'OPAQUE'), material('water', 'BLEND')],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: pad4(length) }],
    extensions: {
      EXT_structural_metadata: {
        schema: {
          id: 'blocks',
          classes: { chunk: { properties: classProperties } },
        },
        propertyTables: [
          { class: 'chunk', count, properties: tableProperties },
        ],
      },
    },
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.byteLength);
  const binLength = pad4(length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  glb.set(jsonBytes, 20);
  glb.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  const binAt = 20 + jsonLength;
  view.setUint32(binAt, binLength, true);
  view.setUint32(binAt + 4, 0x004e4942, true); // 'BIN\0'
  let at = binAt + 8;
  for (const piece of pieces) {
    glb.set(piece, at);
    at += piece.byteLength;
  }
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
    (view.byteLength - (accessor.byteOffset || 0)) / Type.BYTES_PER_ELEMENT,
  );
  const out = new Type(accessor.count * size);
  for (let k = 0; k < accessor.count; k++)
    for (let c = 0; c < size; c++) out[k * size + c] = all[k * stride + c];
  return out;
}

/**
 * A Blocks GLB read back (encodeBlocksGlb's inverse, for tests and tools):
 * each primitive's kind ('opaque' or 'water' by its material's alpha mode),
 * positions in (east, north, up) again, normals as stored (Y-up bytes),
 * colours, block points, feature ids and indices; the property table's
 * columns by name and its row count.
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
    return {
      kind:
        json.materials[primitive.material].alphaMode === 'BLEND'
          ? 'water'
          : 'opaque',
      positions,
      normals: accessorValues(json, bin, attributes.NORMAL),
      colors: accessorValues(json, bin, attributes.COLOR_0),
      blockCoords: accessorValues(json, bin, attributes._BLOCKCOORD),
      featureIds: accessorValues(json, bin, attributes._FEATURE_ID_0),
      indices: accessorValues(json, bin, primitive.indices),
    };
  });
  return { json, primitives, properties, featureCount: table?.count ?? 0 };
}
