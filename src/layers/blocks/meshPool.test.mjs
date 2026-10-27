// Personal fork: Blocks meshing off the main thread (src/layers/blocks/
// meshJob.js, meshPool.js, meshWorker.js): a chunk meshed from its snapshot
// equals the direct mesh, the in-thread fallback, and the pool running the
// real meshWorker.js under node:worker_threads (a `self` shim around
// parentPort; the worker module itself is the browser's, unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, createChunk } from './store.js';
import { buildChunkMesh } from './mesh.js';
import {
  edgeColumns,
  restoreChunk,
  runMeshJob,
  snapshotChunk,
  snapshotJob,
} from './meshJob.js';
import {
  MAX_MESH_WORKERS,
  createMeshPool,
  meshChunkAsync,
  poolSize,
} from './meshPool.js';

const N = CHUNK_COLUMNS;

/** A hilly chunk with a pond and a few edits, at chunk (ci, cj). */
function hilly(ci, cj, seed = 1) {
  const top = new Int32Array(N * N);
  const water = new Int32Array(N * N).fill(NONE);
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const x = ci * N + i;
      const y = cj * N + j;
      top[columnIndex(i, j)] = Math.round(
        8 + 4 * Math.sin(x / 7 + seed) + 3 * Math.cos(y / 5),
      );
    }
  for (let j = 20; j < 26; j += 1)
    for (let i = 30; i < 38; i += 1) {
      top[columnIndex(i, j)] = 2;
      water[columnIndex(i, j)] = 6;
    }
  const chunk = createChunk({ ci, cj, top, water });
  chunk.setBlock(0, 10, 20, MATERIALS.TERRAIN);
  chunk.setBlock(N - 1, 5, chunk.topSolid(N - 1, 5), MATERIALS.AIR);
  chunk.setBlock(40, 40, chunk.topSolid(40, 40) + 2, MATERIALS.TERRAIN);
  return chunk;
}

const OFFSETS = {
  n: [0, 1],
  s: [0, -1],
  e: [1, 0],
  w: [-1, 0],
  ne: [1, 1],
  nw: [-1, 1],
  se: [1, -1],
  sw: [-1, -1],
};
const around = (ci, cj, skip = []) =>
  Object.fromEntries(
    Object.entries(OFFSETS)
      .filter(([key]) => !skip.includes(key))
      .map(([key, [dx, dy]]) => [key, hilly(ci + dx, cj + dy, dx * 3 + dy)]),
  );

const OPTIONS = { blockM: 10, sunDir: { east: 0.3, north: -0.5, up: 0.81 } };

function assertSameMesh(actual, expected, label = '') {
  for (const key of ['positions', 'normals', 'colors', 'indices']) {
    assert.equal(actual[key].constructor, expected[key].constructor, key);
    assert.deepEqual(
      Array.from(actual[key]),
      Array.from(expected[key]),
      `${label} ${key}`,
    );
  }
  assert.equal(actual.faces, expected.faces);
  assert.equal(actual.opaqueIndexCount, expected.opaqueIndexCount);
  assert.deepEqual(actual.stats, expected.stats);
}

test('a neighbour sends only the columns touching the chunk', () => {
  assert.equal(edgeColumns('e').length, N);
  assert.ok(
    edgeColumns('e').every((c) => c % N === 0),
    'its west column',
  );
  assert.ok(
    edgeColumns('n').every((c) => c < N),
    'its south row',
  );
  assert.deepEqual(edgeColumns('ne'), [0]);
  assert.deepEqual(edgeColumns('sw'), [columnIndex(N - 1, N - 1)]);
});

test('snapshot and restore: a chunk meshed from its snapshot equals the direct mesh', () => {
  const chunk = hilly(0, 0);
  const neighbours = around(0, 0);
  // Edits on the neighbours' edges travel; others are left behind.
  neighbours.e.setBlock(0, 30, 40, MATERIALS.TERRAIN);
  neighbours.e.setBlock(10, 30, 40, MATERIALS.TERRAIN);
  for (const greedy of [true, false]) {
    const direct = buildChunkMesh(chunk, { ...OPTIONS, neighbours, greedy });
    const { job } = snapshotJob(chunk, { ...OPTIONS, neighbours, greedy });
    assertSameMesh(
      runMeshJob(structuredClone(job)),
      direct,
      `greedy ${greedy}`,
    );
  }
  // Its own edge edit (0, 10, 20) and the first above; not (10, 30, 40).
  assert.equal(
    snapshotJob(chunk, { neighbours }).job.neighbours.e.edits.length,
    2 * 4,
  );
  // Open borders stay open.
  const open = around(0, 0, ['e', 'ne', 'se']);
  assertSameMesh(
    runMeshJob(snapshotJob(chunk, { ...OPTIONS, neighbours: open }).job),
    buildChunkMesh(chunk, { ...OPTIONS, neighbours: open }),
  );
  // A restored chunk answers occupancy as the original does.
  const back = restoreChunk(snapshotChunk(chunk));
  for (const [i, j, y] of [
    [0, 10, 20],
    [N - 1, 5, chunk.topSolid(N - 1, 5) + 1],
    [33, 22, 4],
    [40, 40, chunk.topSolid(40, 40)],
  ])
    assert.equal(back.occupancy(i, j, y), chunk.occupancy(i, j, y));
});

test('the snapshot is a copy: edits after the call and transferring it leave the live chunk alone', () => {
  const chunk = hilly(0, 0);
  const before = buildChunkMesh(chunk, OPTIONS);
  const { job, transfer } = snapshotJob(chunk, OPTIONS);
  chunk.setBlock(3, 3, 30, MATERIALS.TERRAIN);
  const moved = structuredClone(job, { transfer });
  assert.equal(chunk.top.length, N * N, 'the live arrays are not detached');
  assert.equal(job.chunk.top.length, 0, 'the snapshot copies were moved');
  assertSameMesh(runMeshJob(moved), before);
});

test('the fallback: without Workers the pool meshes in-thread, the same mesh, one code path', async () => {
  assert.equal(typeof globalThis.Worker, 'undefined', 'Node has no Web Worker');
  const chunk = hilly(2, -1);
  const neighbours = around(2, -1);
  const expected = buildChunkMesh(chunk, { ...OPTIONS, neighbours });
  const pool = createMeshPool({ createWorker: null });
  assert.equal(pool.stats().inThread, true);
  assertSameMesh(
    await pool.meshChunkAsync(chunk, { ...OPTIONS, neighbours }),
    expected,
  );
  // The page's adapter, the controller's stand-in for buildChunkMesh.
  assertSameMesh(
    await meshChunkAsync(chunk, { ...OPTIONS, neighbours }),
    expected,
  );
  pool.destroy();
  await assert.rejects(pool.meshChunkAsync(chunk, OPTIONS), /destroyed/);
});

test('the pool size: cores − 1, at least 1, at most 3', () => {
  assert.equal(MAX_MESH_WORKERS, 3);
  assert.equal(poolSize(16), 3);
  assert.equal(poolSize(4), 3);
  assert.equal(poolSize(3), 2);
  assert.equal(poolSize(2), 1);
  assert.equal(poolSize(1), 1);
  assert.equal(poolSize(Number.NaN), 1, 'unknown: two cores assumed');
});

/**
 * The real meshWorker.js in a node:worker_threads Worker: `self` is a shim
 * over parentPort, the Worker wrapped to look like a browser's.
 */
function nodeMeshWorker() {
  const url = new URL('./meshWorker.js', import.meta.url).href;
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
     globalThis.self = {
       postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
       addEventListener: (type, listener) => {
         if (type === 'message') parentPort.on('message', (data) => listener({ data }));
       },
     };
     import(${JSON.stringify(url)});`,
    { eval: true },
  );
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    addEventListener(type, listener) {
      if (type === 'message')
        worker.on('message', (data) => listener({ data }));
      if (type === 'error') worker.on('error', (error) => listener(error));
    },
    terminate: () => worker.terminate(),
  };
}

test('the pool: the real worker under node:worker_threads, jobs spread over two workers', async () => {
  let made = 0;
  const pool = createMeshPool({
    size: 2,
    createWorker: () => {
      made += 1;
      return nodeMeshWorker();
    },
  });
  try {
    const chunks = [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [3, 2],
    ];
    const jobs = chunks.map(([ci, cj]) => {
      const chunk = hilly(ci, cj);
      const neighbours = around(ci, cj, ci === 3 ? ['e'] : []);
      return {
        expected: buildChunkMesh(chunk, { ...OPTIONS, neighbours }),
        pending: pool.meshChunkAsync(chunk, { ...OPTIONS, neighbours }),
      };
    });
    assert.ok(pool.stats().waiting >= 3, 'two run, the rest wait');
    for (const [k, { expected, pending }] of jobs.entries())
      assertSameMesh(await pending, expected, `chunk ${k}`);
    assert.equal(made, 2);
    assert.equal(pool.stats().inThread, false);
    assert.deepEqual(pool.stats(), {
      workers: 2,
      busy: 0,
      waiting: 0,
      inThread: false,
    });
  } finally {
    pool.destroy();
  }
});

test('a worker that fails is dropped and its job meshed in-thread; a job that throws rejects', async () => {
  const listeners = {};
  const broken = {
    postMessage() {
      setImmediate(() => listeners.error?.(new Error('worker died')));
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    terminate() {},
  };
  const pool = createMeshPool({ size: 1, createWorker: () => broken });
  const chunk = hilly(0, 0);
  assertSameMesh(
    await pool.meshChunkAsync(chunk, OPTIONS),
    buildChunkMesh(chunk, OPTIONS),
  );
  assert.equal(pool.stats().workers, 0);
  pool.destroy();

  const failing = createMeshPool({
    size: 1,
    createWorker: () => {
      const handlers = {};
      return {
        postMessage: ({ id }) =>
          setImmediate(() =>
            handlers.message({ data: { id, error: 'bad job' } }),
          ),
        addEventListener: (type, listener) => (handlers[type] = listener),
        terminate() {},
      };
    },
  });
  await assert.rejects(failing.meshChunkAsync(chunk, OPTIONS), /bad job/);
  failing.destroy();
});
