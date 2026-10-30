// Personal fork: a Blocks chunk mesh in the form the renderer draws from
// (docs/BLOCKS-PLAN.md, option 3): its faces split into opaque and water,
// each packed once in the GLB's layout (gltf.js packPart), so a batch is
// assembled by copying and no thread converts a chunk twice. Pure: the
// mesh workers run it after meshing (meshJob.js), the renderer for a mesh
// meshed in this thread.

import { packPart, packedBuffers } from './gltf.js';

/**
 * A mesh's faces split into opaque and water: mesh.js puts the opaque
 * faces first, [0, opaqueIndexCount) of the indices, and water after.
 * A part that uses only some of the vertices gets just those, renumbered;
 * a mesh without water is drawn from its own arrays.
 * @returns {{opaque: object|null, water: object|null}}
 */
export function splitMesh({
  positions,
  normals,
  colors,
  blockCoords = null,
  indices,
  opaqueIndexCount,
}) {
  const cut = Number.isInteger(opaqueIndexCount)
    ? opaqueIndexCount
    : indices.length;
  const vertexCount = positions.length / 3;
  const remap = new Int32Array(vertexCount);
  const part = (from, to) => {
    if (from >= to) return null;
    if (from === 0 && to === indices.length)
      return { positions, normals, colors, blockCoords, indices };
    remap.fill(-1);
    const out = new Uint32Array(to - from);
    let used = 0;
    for (let k = from; k < to; k++) {
      const v = indices[k];
      if (remap[v] < 0) remap[v] = used++;
      out[k - from] = remap[v];
    }
    const p = new Float32Array(used * 3);
    const n = new Float32Array(used * 3);
    const c = new Uint8Array(used * 4);
    const b = blockCoords ? new Float32Array(used * 3) : null;
    for (let v = 0; v < vertexCount; v++) {
      const at = remap[v];
      if (at < 0) continue;
      if (b) {
        b[at * 3] = blockCoords[v * 3];
        b[at * 3 + 1] = blockCoords[v * 3 + 1];
        b[at * 3 + 2] = blockCoords[v * 3 + 2];
      }
      p[at * 3] = positions[v * 3];
      p[at * 3 + 1] = positions[v * 3 + 1];
      p[at * 3 + 2] = positions[v * 3 + 2];
      n[at * 3] = normals[v * 3];
      n[at * 3 + 1] = normals[v * 3 + 1];
      n[at * 3 + 2] = normals[v * 3 + 2];
      c[at * 4] = colors[v * 4];
      c[at * 4 + 1] = colors[v * 4 + 1];
      c[at * 4 + 2] = colors[v * 4 + 2];
      c[at * 4 + 3] = colors[v * 4 + 3];
    }
    return {
      positions: p,
      normals: n,
      colors: c,
      blockCoords: b,
      indices: out,
    };
  };
  return { opaque: part(0, cut), water: part(cut, indices.length) };
}

/**
 * A mesh as the renderer draws it: {packedParts: {opaque, water}, plain,
 * origin?, curved?}, each part packed (gltf.js packPart) with the chunk's
 * columns folded into its block points. `blockCoords` stands in for the
 * mesh's own (the renderer derives them for a flat mesh without); none
 * makes it plain (no edges or dither). The mesh's own arrays are not kept.
 */
export function packMesh(
  mesh,
  { chunk, blockCoords = mesh?.blockCoords } = {},
) {
  const parts = splitMesh({ ...mesh, blockCoords: blockCoords || null });
  const packed = {
    packedParts: {
      opaque: packPart(parts.opaque, { chunk }),
      water: packPart(parts.water, { chunk }),
    },
    plain: !blockCoords,
  };
  if (mesh.origin) packed.origin = mesh.origin;
  if (typeof mesh.curved === 'boolean') packed.curved = mesh.curved;
  return packed;
}

/** A packed mesh's buffers, to transfer. */
export const packedMeshBuffers = (packed) => [
  ...packedBuffers(packed?.packedParts?.opaque),
  ...packedBuffers(packed?.packedParts?.water),
];

/** Whether a packed mesh has faces. */
export const packedMeshHasFaces = (packed) =>
  Boolean(
    packed?.packedParts?.opaque?.vertexCount ||
    packed?.packedParts?.water?.vertexCount,
  );
