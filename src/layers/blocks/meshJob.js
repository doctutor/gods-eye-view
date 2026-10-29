/**
 * Personal fork: a Blocks meshing job as plain data, so a chunk can be
 * meshed in a Web Worker (meshWorker.js, through meshPool.js): the chunk's
 * typed arrays and edits copied out, and of each neighbour only the
 * columns the mesher reads (those touching the chunk), restored on the far
 * side into chunks the mesher cannot tell from the originals. The mesh's
 * typed arrays come back transferred. Pure; no DOM, no Worker.
 */
import { buildChunkMesh } from './mesh.js';
import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, applyEdits, createChunk } from './store.js';

const N = CHUNK_COLUMNS;

/** The neighbours buildChunkMesh takes, by offset from the chunk. */
export const NEIGHBOUR_OFFSETS = Object.freeze({
  n: [0, 1],
  s: [0, -1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, 1],
  nw: [-1, 1],
  se: [1, -1],
  sw: [-1, -1],
});

/**
 * The columns of a neighbour the mesher reads: the row, column or corner
 * that touches the chunk (its ring of surroundings is one column wide).
 */
export function edgeColumns(key) {
  const [dx, dy] = NEIGHBOUR_OFFSETS[key];
  const is = dx > 0 ? [0] : dx < 0 ? [N - 1] : [...Array(N).keys()];
  const js = dy > 0 ? [0] : dy < 0 ? [N - 1] : [...Array(N).keys()];
  const columns = [];
  for (const j of js) for (const i of is) columns.push(columnIndex(i, j));
  return columns;
}

/** Edits as a packed Int32Array: i, j, y, material per edit. */
function packEdits(edits, keep = () => true) {
  const packed = [];
  for (const { i, j, y, material } of edits)
    if (keep(i, j)) packed.push(i, j, y, material);
  return Int32Array.from(packed);
}

function unpackEdits(packed) {
  const edits = [];
  for (let k = 0; k < (packed?.length || 0); k += 4)
    edits.push({
      i: packed[k],
      j: packed[k + 1],
      y: packed[k + 2],
      material: packed[k + 3],
    });
  return edits;
}

/**
 * The structures layer (store.js `structure`: OSM buildings) back into a
 * chunk, column by column: before the edits, which are kept or dropped
 * against what the heightfield and the structures put there.
 */
function restoreStructures(chunk, columns, tops, materials, bottoms) {
  if (!tops) return;
  columns.forEach((column, k) => {
    if (tops[k] === NONE) return;
    chunk.setStructure(
      column % N,
      Math.floor(column / N),
      tops[k],
      materials[k],
      bottoms ? bottoms[k] : NONE,
    );
  });
}

/**
 * A chunk as plain data: copies of its arrays (the live chunk keeps its
 * own, so they can be transferred), its structures layer when it has one,
 * and its edits.
 */
export function snapshotChunk(chunk) {
  const snapshot = {
    ci: chunk.ci,
    cj: chunk.cj,
    top: chunk.top.slice(),
    material: chunk.material.slice(),
    water: chunk.water.slice(),
    edits: packEdits(chunk.edits),
  };
  if (chunk.structure) {
    snapshot.structureTop = chunk.structure.top.slice();
    snapshot.structureMaterial = chunk.structure.material.slice();
    snapshot.structureBottom = chunk.structure.bottom.slice();
  }
  return snapshot;
}

/** A chunk again from its snapshot. */
export function restoreChunk(snapshot) {
  const chunk = createChunk({
    ci: snapshot.ci,
    cj: snapshot.cj,
    top: snapshot.top,
    material: snapshot.material,
    water: snapshot.water,
  });
  restoreStructures(
    chunk,
    [...Array(N * N).keys()],
    snapshot.structureTop,
    snapshot.structureMaterial,
    snapshot.structureBottom,
  );
  applyEdits(chunk, unpackEdits(snapshot.edits));
  return chunk;
}

/** Of a neighbour, only the columns touching the chunk (edgeColumns). */
export function snapshotNeighbour(chunk, key) {
  const columns = edgeColumns(key);
  const wanted = new Set(columns);
  const snapshot = {
    key,
    ci: chunk.ci,
    cj: chunk.cj,
    columns: Uint16Array.from(columns),
    top: Int32Array.from(columns, (c) => chunk.top[c]),
    material: Uint8Array.from(columns, (c) => chunk.material[c]),
    water: Int32Array.from(columns, (c) => chunk.water[c]),
    edits: packEdits(chunk.edits, (i, j) => wanted.has(columnIndex(i, j))),
  };
  const structure = chunk.structure;
  if (structure) {
    snapshot.structureTop = Int32Array.from(columns, (c) => structure.top[c]);
    snapshot.structureMaterial = Uint8Array.from(
      columns,
      (c) => structure.material[c],
    );
    snapshot.structureBottom = Int32Array.from(
      columns,
      (c) => structure.bottom[c],
    );
  }
  return snapshot;
}

/**
 * A neighbour again: its edge columns as they were, every other column
 * without data (the mesher never reads them).
 */
export function restoreNeighbour(snapshot) {
  const top = new Int32Array(N * N).fill(NONE);
  const material = new Uint8Array(N * N).fill(MATERIALS.TERRAIN);
  const water = new Int32Array(N * N).fill(NONE);
  snapshot.columns.forEach((column, k) => {
    top[column] = snapshot.top[k];
    material[column] = snapshot.material[k];
    water[column] = snapshot.water[k];
  });
  const chunk = createChunk({
    ci: snapshot.ci,
    cj: snapshot.cj,
    top,
    material,
    water,
  });
  restoreStructures(
    chunk,
    snapshot.columns,
    snapshot.structureTop,
    snapshot.structureMaterial,
    snapshot.structureBottom,
  );
  applyEdits(chunk, unpackEdits(snapshot.edits));
  return chunk;
}

const buffersOf = (snapshot) =>
  [
    'top',
    'material',
    'water',
    'edits',
    'columns',
    'structureTop',
    'structureMaterial',
    'structureBottom',
  ]
    .map((key) => snapshot[key]?.buffer)
    .filter(Boolean);

/**
 * A meshing job: the chunk, its neighbours' edges and buildChunkMesh's
 * other options (plain data: blockM, levelM, sunDir, greedy, skirt), with the
 * buffers to transfer (copies, so the live chunks are untouched).
 */
export function snapshotJob(chunk, { neighbours = {}, ...options } = {}) {
  const job = {
    chunk: snapshotChunk(chunk),
    neighbours: {},
    options,
  };
  for (const key of Object.keys(NEIGHBOUR_OFFSETS))
    if (neighbours[key])
      job.neighbours[key] = snapshotNeighbour(neighbours[key], key);
  const transfer = [
    ...buffersOf(job.chunk),
    ...Object.values(job.neighbours).flatMap(buffersOf),
  ];
  return { job, transfer };
}

/** Mesh a job: the same mesh buildChunkMesh gives for the live chunks. */
export function runMeshJob(job) {
  const neighbours = {};
  for (const [key, snapshot] of Object.entries(job.neighbours || {}))
    neighbours[key] = restoreNeighbour(snapshot);
  return buildChunkMesh(restoreChunk(job.chunk), {
    ...job.options,
    neighbours,
  });
}

/** The mesh's buffers, to transfer back. */
export const meshTransferList = (mesh) =>
  [mesh.positions, mesh.normals, mesh.colors, mesh.blockCoords, mesh.indices]
    .filter(Boolean)
    .map((array) => array.buffer);
