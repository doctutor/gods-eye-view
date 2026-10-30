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
  meshTransferList,
  runMeshJob,
  snapshotChunk,
  snapshotJob,
} from './meshJob.js';
import {
  MAX_MESH_WORKERS,
  MESH_JOB_SLOW_MS,
  MESH_JOB_TIMEOUT_MS,
  MESH_WORKER_START_MS,
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
    // The real worker says it is ready: no job taken back, none here.
    assert.deepEqual(pool.stats(), {
      workers: 2,
      busy: 0,
      waiting: 0,
      inThread: false,
      timeouts: 0,
      inThreadJobs: 0,
      slow: 0,
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

/** hilly() with buildings: on the chunk, on its east edge, and one broken into. */
function withBuildings(ci, cj, seed) {
  const chunk = hilly(ci, cj, seed);
  for (let i = 10; i < 14; i += 1)
    for (let j = 40; j < 45; j += 1)
      chunk.setStructure(i, j, chunk.topSolid(i, j) + 6);
  for (let j = 0; j < 3; j += 1)
    for (const i of [0, N - 1])
      chunk.setStructure(i, j, chunk.topSolid(i, j) + 4);
  // An edit over a structure wins: a window broken into the first block.
  chunk.setBlock(11, 41, chunk.top[columnIndex(11, 41)] + 3, MATERIALS.AIR);
  return chunk;
}

test('buildings travel: the structures layer of the chunk and of its neighbours’ edges, with the edits over them', async () => {
  const chunk = withBuildings(0, 0, 1);
  const neighbours = Object.fromEntries(
    Object.entries(OFFSETS).map(([key, [dx, dy]]) => [
      key,
      withBuildings(dx, dy, dx * 3 + dy),
    ]),
  );
  const direct = buildChunkMesh(chunk, { ...OPTIONS, neighbours });
  const { job } = snapshotJob(chunk, { ...OPTIONS, neighbours });
  assert.ok(job.chunk.structureTop, 'the chunk carries its structures');
  assert.ok(job.neighbours.e.structureTop, 'and the east edge its own');
  assertSameMesh(runMeshJob(structuredClone(job)), direct);
  // The buildings change the mesh: the old snapshot (no structures) would
  // have meshed the bare hill.
  const bare = buildChunkMesh(hilly(0, 0, 1), { ...OPTIONS, neighbours });
  assert.notEqual(direct.faces, bare.faces);
  assert.ok(direct.stats.up > bare.stats.up, 'roofs');
  const back = restoreChunk(snapshotChunk(chunk));
  const top = chunk.top[columnIndex(11, 41)];
  for (const y of [top + 1, top + 3, top + 6, top + 7])
    assert.equal(back.occupancy(11, 41, y), chunk.occupancy(11, 41, y), `${y}`);
  assert.equal(back.occupancy(11, 41, top + 3), MATERIALS.AIR, 'the window');
  assert.equal(back.occupancy(11, 41, top + 2), MATERIALS.BUILDING);
  // A chunk without buildings carries none.
  assert.equal(
    snapshotJob(hilly(5, 5), OPTIONS).job.chunk.structureTop,
    undefined,
  );
  // And through the real worker.
  const pool = createMeshPool({ size: 1, createWorker: nodeMeshWorker });
  try {
    assertSameMesh(
      await pool.meshChunkAsync(chunk, { ...OPTIONS, neighbours }),
      direct,
      'worker',
    );
  } finally {
    pool.destroy();
  }
});

/**
 * Fake workers for the timeout: `silent` never answers (or answers only
 * after `lateMs`); `answering` meshes the job in this process, as the real
 * worker would, and says so.
 */
function fakeWorker({ silent = false, lateMs = null, log, readyMs = null }) {
  const handlers = {};
  // Says it is ready (its modules loaded) after readyMs, as meshWorker.js.
  if (readyMs !== null)
    setTimeout(() => handlers.message?.({ data: { ready: true } }), readyMs);
  const worker = {
    terminated: false,
    answered: 0,
    postMessage({ id, job }) {
      log.posted += 1;
      if (silent && lateMs === null) return;
      setTimeout(
        () => {
          if (worker.terminated && !silent) return;
          worker.answered += 1;
          handlers.message?.({ data: { id, mesh: runMeshJob(job) } });
        },
        silent ? lateMs : 0,
      );
    },
    addEventListener: (type, listener) => (handlers[type] = listener),
    terminate() {
      worker.terminated = true;
      log.terminated += 1;
    },
  };
  return worker;
}

test('a worker that never answers is terminated after the timeout, its job meshed in-thread, and a replacement started lazily', async (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(MESH_JOB_TIMEOUT_MS, 60_000);
  const log = { posted: 0, terminated: 0 };
  const made = [];
  const pool = createMeshPool({
    size: 1,
    jobTimeoutMs: 20,
    startTimeoutMs: 20,
    // The first worker hangs; the replacement answers.
    createWorker: () => {
      const worker = fakeWorker({ silent: made.length === 0, log });
      made.push(worker);
      return worker;
    },
  });
  try {
    const chunk = hilly(0, 0);
    const neighbours = around(0, 0);
    const started = Date.now();
    const mesh = await pool.meshChunkAsync(chunk, { ...OPTIONS, neighbours });
    assertSameMesh(mesh, buildChunkMesh(chunk, { ...OPTIONS, neighbours }));
    assert.ok(Date.now() - started >= 15, 'it waited for the timeout');
    assert.equal(made[0].terminated, true);
    assert.equal(made.length, 1, 'no replacement until a job needs one');
    assert.deepEqual(pool.stats(), {
      workers: 0,
      busy: 0,
      waiting: 0,
      inThread: false,
      timeouts: 1,
      inThreadJobs: 1,
      slow: 0,
    });
    // The next job starts the replacement, which answers.
    const next = hilly(1, 0);
    assertSameMesh(
      await pool.meshChunkAsync(next, OPTIONS),
      buildChunkMesh(next, OPTIONS),
    );
    assert.equal(made.length, 2);
    assert.equal(made[1].answered, 1, 'meshed by the replacement worker');
    assert.equal(log.terminated, 1);
  } finally {
    pool.destroy();
  }
});

test('an answer in time clears the timer; a late answer after the timeout is ignored', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const log = { posted: 0, terminated: 0 };
  const quick = fakeWorker({ log });
  const pool = createMeshPool({
    size: 1,
    jobTimeoutMs: 40,
    createWorker: () => quick,
  });
  const chunk = hilly(2, 2);
  await pool.meshChunkAsync(chunk, OPTIONS);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(log.terminated, 0, 'not timed out after answering');
  assert.equal(pool.stats().workers, 1);
  pool.destroy();

  // Answers after 60 ms, the timeout at 20 ms: resolved once, in-thread.
  const lateLog = { posted: 0, terminated: 0 };
  const late = fakeWorker({ silent: true, lateMs: 60, log: lateLog });
  let resolved = 0;
  const latePool = createMeshPool({
    size: 1,
    jobTimeoutMs: 20,
    createWorker: () => late,
  });
  const mesh = await latePool.meshChunkAsync(chunk, OPTIONS).then((m) => {
    resolved += 1;
    return m;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(late.answered, 1, 'the late answer came');
  assert.equal(resolved, 1, 'and changed nothing');
  assertSameMesh(mesh, buildChunkMesh(chunk, OPTIONS));
  latePool.destroy();
});

test('destroy stops the timers of running jobs', async () => {
  const log = { posted: 0, terminated: 0 };
  const timers = new Set();
  const pool = createMeshPool({
    size: 1,
    jobTimeoutMs: 1000,
    startTimeoutMs: 5000,
    createWorker: () => fakeWorker({ silent: true, log }),
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms };
      timers.add(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => timers.delete(handle),
  });
  const pending = pool.meshChunkAsync(hilly(0, 0), OPTIONS);
  // Not ready yet: the worker's time to start.
  assert.equal(timers.size, 1);
  assert.equal([...timers][0].ms, 5000);
  pool.destroy();
  await assert.rejects(pending, /destroyed/);
  assert.equal(timers.size, 0);
});

test('the snapshot carries levelM: a 120 m block on 30 m levels meshes the same off the thread', () => {
  const chunk = hilly(0, 0);
  const neighbours = around(0, 0);
  const options = { ...OPTIONS, blockM: 120, levelM: 30 };
  const direct = buildChunkMesh(chunk, { ...options, neighbours });
  const { job } = snapshotJob(chunk, { ...options, neighbours });
  assert.equal(structuredClone(job).options.levelM, 30);
  assertSameMesh(runMeshJob(structuredClone(job)), direct, '120 m / 30 m');
  // And not the cube's mesh.
  const cube = buildChunkMesh(chunk, { ...OPTIONS, blockM: 120, neighbours });
  assert.notDeepEqual(
    [...cube.positions.slice(0, 30)],
    [...direct.positions.slice(0, 30)],
  );
});

test('the block points travel: a job’s mesh carries blockCoords as the direct one does, its buffer transferred', () => {
  const chunk = hilly(0, 0);
  const neighbours = around(0, 0);
  const direct = buildChunkMesh(chunk, { ...OPTIONS, neighbours });
  const { job } = snapshotJob(chunk, { ...OPTIONS, neighbours });
  const viaJob = runMeshJob(structuredClone(job));
  assert.deepEqual([...viaJob.blockCoords], [...direct.blockCoords]);
  assert.ok(meshTransferList(viaJob).includes(viaJob.blockCoords.buffer));
});

test('a worker is timed from when it says it is ready: a slow start (its modules loading) is not a hang', async (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(MESH_WORKER_START_MS, 60_000);
  const log = { posted: 0, terminated: 0 };
  // Ready after 60 ms and answering at 70 ms: past a 20 ms job timeout
  // counted from the post (which took the job back before), inside it
  // counted from ready.
  const pool = createMeshPool({
    size: 1,
    jobTimeoutMs: 20,
    startTimeoutMs: 1000,
    createWorker: () =>
      fakeWorker({ silent: true, lateMs: 70, log, readyMs: 60 }),
  });
  try {
    const chunk = hilly(0, 0);
    assertSameMesh(
      await pool.meshChunkAsync(chunk, OPTIONS),
      buildChunkMesh(chunk, OPTIONS),
    );
    assert.deepEqual(
      [pool.stats().timeouts, pool.stats().inThreadJobs, log.terminated],
      [0, 0, 0],
    );
  } finally {
    pool.destroy();
  }
});

test('packed (pack: true), the in-thread answer is the worker’s: with no workers, and for a job taken back', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { packMesh } = await import('./packMesh.js');
  const chunk = hilly(2, -1);
  const expected = packMesh(buildChunkMesh(chunk, OPTIONS), { chunk: [2, -1] });
  const same = (packed) => {
    for (const kind of ['opaque', 'water'])
      for (const name of [
        'positions',
        'normals',
        'colors',
        'blockCoords',
        'indices',
      ])
        assert.deepEqual(
          [...(packed.packedParts[kind]?.[name] || [])],
          [...(expected.packedParts[kind]?.[name] || [])],
          `${kind} ${name}`,
        );
  };
  const none = createMeshPool({ createWorker: null });
  same(await none.meshChunkAsync(chunk, { ...OPTIONS, pack: true }));
  assert.equal(none.stats().inThreadJobs, 1);
  const log = { posted: 0, terminated: 0 };
  const hung = createMeshPool({
    size: 1,
    jobTimeoutMs: 10,
    startTimeoutMs: 10,
    createWorker: () => fakeWorker({ silent: true, log }),
  });
  try {
    same(await hung.meshChunkAsync(chunk, { ...OPTIONS, pack: true }));
    assert.equal(hung.stats().timeouts, 1);
  } finally {
    hung.destroy();
  }
});

test('a slow worker keeps its job: past slowMs it is counted slow, not taken back (on a saturated machine a take-back meshed in-thread on the same starved CPU and restarted a worker); only past the timeout is it taken back', async (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(MESH_JOB_SLOW_MS, 10_000);
  assert.equal(MESH_JOB_TIMEOUT_MS, 60_000);
  const log = { posted: 0, terminated: 0 };
  // Ready at once, answering after 60 ms: slow at 10 ms, kept, answered.
  const slow = createMeshPool({
    size: 1,
    slowMs: 10,
    jobTimeoutMs: 500,
    startTimeoutMs: 1000,
    createWorker: () =>
      fakeWorker({ silent: true, lateMs: 60, log, readyMs: 0 }),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const chunk = hilly(3, 1);
    const mesh = await slow.meshChunkAsync(chunk, OPTIONS);
    assertSameMesh(mesh, buildChunkMesh(chunk, OPTIONS));
    const stats = slow.stats();
    assert.equal(stats.slow, 1, 'counted slow');
    assert.equal(stats.timeouts, 0, 'not taken back');
    assert.equal(stats.inThreadJobs, 0, 'nothing meshed here');
    assert.equal(log.terminated, 0, 'the worker kept');
  } finally {
    slow.destroy();
  }
  // One that never answers: slow, then taken back at the timeout.
  const stuck = createMeshPool({
    size: 1,
    slowMs: 10,
    jobTimeoutMs: 40,
    startTimeoutMs: 1000,
    createWorker: () => fakeWorker({ silent: true, log, readyMs: 0 }),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stuck.meshChunkAsync(hilly(4, 1), OPTIONS);
    const stats = stuck.stats();
    assert.equal(stats.slow, 1);
    assert.equal(stats.timeouts, 1);
    assert.equal(stats.inThreadJobs, 1);
  } finally {
    stuck.destroy();
  }
});
