// Personal fork: a chunk mesh packed as the renderer draws it
// (src/layers/blocks/packMesh.js), and a mesh worker's job asked to pack
// (meshJob.js): the same parts either way, their buffers to transfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChunkMesh } from './mesh.js';
import { createChunk } from './store.js';
import { meshTransferList, runMeshJob, snapshotJob } from './meshJob.js';
import { packMesh, packedMeshBuffers, packedMeshHasFaces } from './packMesh.js';
import { readBlocksGlb, encodeBatchGlb } from './gltf.js';

/** A chunk of steps with a strip of water. */
function landAndSea(ci = 3, cj = -2) {
  const top = new Int32Array(64 * 64);
  const water = new Int32Array(64 * 64).fill(-2147483648);
  for (let j = 0; j < 64; j++)
    for (let i = 0; i < 64; i++) {
      const k = j * 64 + i;
      if (i < 10) {
        top[k] = -2;
        water[k] = 0;
      } else top[k] = (i - 10) >> 3;
    }
  return createChunk({ ci, cj, top, water });
}

test('packMesh: opaque and water parts packed with the chunk’s columns folded in; plain without block points', () => {
  const mesh = buildChunkMesh(landAndSea(), { blockM: 1 });
  const packed = packMesh(mesh, { chunk: [3, -2] });
  const { opaque, water } = packed.packedParts;
  assert.equal(packed.plain, false);
  assert.ok(opaque.packed && water.packed);
  assert.equal(
    opaque.indices.length + water.indices.length,
    mesh.indices.length,
  );
  // Folded: chunk 3 east is 192 columns, −2 north is 3968.
  assert.ok(opaque.blockCoords[0] >= 192 && opaque.blockCoords[0] <= 256);
  assert.ok(opaque.blockCoords[1] >= 3968);
  assert.ok(packedMeshHasFaces(packed));
  assert.equal(packedMeshBuffers(packed).length, 10);
  // A batch GLB of it reads back with both kinds.
  const glb = encodeBatchGlb({
    chunks: [{ opaque, water }],
    features: { count: 2 },
  });
  assert.deepEqual(
    readBlocksGlb(glb).primitives.map((p) => p.kind),
    ['opaque', 'water'],
  );
  // No block points: plain, its attribute zeros.
  const plain = packMesh({ ...mesh, blockCoords: null }, { blockCoords: null });
  assert.equal(plain.plain, true);
  assert.ok(plain.packedParts.opaque.blockCoords.every((v) => v === 0));
  assert.equal(packedMeshHasFaces({ packedParts: {} }), false);
});

test('a mesh job asked to pack answers with the packed mesh (its chunk folded in), the buffers to transfer back', () => {
  const chunk = landAndSea(5, 7);
  const { job } = snapshotJob(chunk, { blockM: 1, pack: true });
  const packed = runMeshJob(job);
  const expected = packMesh(buildChunkMesh(chunk, { blockM: 1 }), {
    chunk: [5, 7],
  });
  for (const kind of ['opaque', 'water'])
    for (const name of [
      'positions',
      'normals',
      'colors',
      'blockCoords',
      'indices',
    ])
      assert.deepEqual(
        [...packed.packedParts[kind][name]],
        [...expected.packedParts[kind][name]],
        `${kind} ${name}`,
      );
  assert.equal(meshTransferList(packed).length, 10);
  // Without pack: the mesh as before.
  const { job: plainJob } = snapshotJob(chunk, { blockM: 1 });
  const mesh = runMeshJob(plainJob);
  assert.ok(mesh.positions && !mesh.packedParts);
  assert.equal(meshTransferList(mesh).length, 5);
});
