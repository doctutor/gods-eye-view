/**
 * Personal fork: Blocks meshing off the main thread. A pool of module Web
 * Workers (meshWorker.js) meshes chunks with mesh.js: a view at Baltimore
 * is about 320 fine and 208 coarse chunks at 4 to 60 ms each, too much to
 * mesh between frames. `meshChunkAsync(chunk, options)` takes what
 * buildChunkMesh takes (the options plain data, `neighbours` live chunks)
 * and resolves to the same mesh. The chunk and its neighbours' edge
 * columns are copied when it is called (meshJob.js), so a chunk edited
 * afterwards does not change the mesh asked for, and the mesh's arrays come
 * back transferred. Where Workers cannot be made (Node, the harness, a
 * worker that fails to start) the same call meshes in-thread, so the
 * caller has one code path.
 */
import { buildChunkMesh } from './mesh.js';
import { snapshotJob } from './meshJob.js';
import { packMesh } from './packMesh.js';

/** Workers at most: the machine runs other heavy things beside the app. */
export const MAX_MESH_WORKERS = 3;
/**
 * A job a worker has not answered in this long is taken back: the worker
 * is terminated (a mesh takes 4 to 60 ms; one stuck in a loop would hold
 * its job, and the controller's tick, forever), the job meshed in-thread,
 * and a replacement worker started when a job next needs one.
 */
export const MESH_JOB_TIMEOUT_MS = 10_000;

/** hardwareConcurrency − 1, at least 1, at most MAX_MESH_WORKERS. */
export function poolSize(
  concurrency = globalThis.navigator?.hardwareConcurrency,
) {
  const cores = Number(concurrency) || 2;
  return Math.max(1, Math.min(MAX_MESH_WORKERS, cores - 1));
}

/** A module worker running meshWorker.js, or null where there are none. */
function browserWorker() {
  if (typeof Worker !== 'function') return null;
  // Written out in full so Vite bundles the worker.
  return new Worker(new URL('./meshWorker.js', import.meta.url), {
    type: 'module',
  });
}

/**
 * A pool of `size` workers made by `createWorker` (a Worker, or anything
 * with postMessage, addEventListener('message' | 'error') and terminate;
 * null when none can be made), started as jobs arrive. One job a worker at
 * a time; jobs wait in order. A worker that errors is dropped and its job
 * meshed in-thread; with no workers left, every job is. A worker that
 * does not answer within `jobTimeoutMs` is terminated and its job meshed
 * in-thread; a replacement is started when a job next needs one.
 */
export function createMeshPool({
  size = poolSize(),
  createWorker = browserWorker,
  jobTimeoutMs = MESH_JOB_TIMEOUT_MS,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
} = {}) {
  const workers = [];
  const idle = [];
  const queue = [];
  const running = new Map();
  let nextId = 1;
  let unavailable = typeof createWorker !== 'function';
  let destroyed = false;

  // The same answer a worker gives: packed with `pack` (meshJob.js).
  const inThread = (chunk, { pack = false, ...options } = {}) =>
    Promise.resolve().then(() => {
      const mesh = buildChunkMesh(chunk, options);
      return pack ? packMesh(mesh, { chunk: [chunk.ci, chunk.cj] }) : mesh;
    });

  /** A running task's timer, stopped. */
  const settle = (task) => {
    if (task.timer !== undefined) clearTimeoutImpl(task.timer);
    task.timer = undefined;
  };

  /**
   * Drop a worker. `replace`: it was stuck, not broken, so the pool goes on
   * with workers (a new one is started when a job needs it); otherwise,
   * with none left and jobs waiting, the pool meshes in-thread from now on.
   */
  const retire = (worker, { replace = false } = {}) => {
    const at = workers.indexOf(worker);
    if (at >= 0) workers.splice(at, 1);
    const free = idle.indexOf(worker);
    if (free >= 0) idle.splice(free, 1);
    try {
      worker.terminate?.();
    } catch {
      /* already gone */
    }
    if (!replace && !workers.length && running.size === 0 && queue.length) {
      // None left to run the waiting jobs: run them here.
      unavailable = true;
      for (const task of queue.splice(0))
        inThread(task.chunk, task.options).then(task.resolve, task.reject);
    }
  };

  const spawn = () => {
    let worker;
    try {
      worker = createWorker();
    } catch {
      worker = null;
    }
    if (!worker) {
      if (!workers.length) unavailable = true;
      return null;
    }
    worker.addEventListener('message', (event) => {
      const { id, mesh, error } = event.data || {};
      const task = running.get(id);
      if (!task) return;
      running.delete(id);
      settle(task);
      if (error) task.reject(new Error(error));
      else task.resolve(mesh);
      idle.push(worker);
      pump();
    });
    worker.addEventListener('error', (event) => {
      event?.preventDefault?.();
      for (const [id, task] of running)
        if (task.worker === worker) {
          running.delete(id);
          settle(task);
          inThread(task.chunk, task.options).then(task.resolve, task.reject);
        }
      retire(worker);
      pump();
    });
    workers.push(worker);
    return worker;
  };

  /** A job not answered in time: taken back, its worker replaced. */
  const timedOut = (worker, id) => {
    const task = running.get(id);
    if (!task) return;
    running.delete(id);
    task.timer = undefined;
    console.warn(
      `[Blocks] a mesh worker did not answer in ${jobTimeoutMs} ms; meshing in-thread and replacing it`,
    );
    // Its other jobs (one a worker, but to be sure) go the same way.
    for (const [other, held] of running)
      if (held.worker === worker) {
        running.delete(other);
        settle(held);
        inThread(held.chunk, held.options).then(held.resolve, held.reject);
      }
    inThread(task.chunk, task.options).then(task.resolve, task.reject);
    retire(worker, { replace: true });
    pump();
  };

  function pump() {
    while (queue.length && !destroyed) {
      let worker = idle.pop();
      if (!worker && workers.length < size) worker = spawn();
      if (!worker) {
        if (unavailable) {
          for (const task of queue.splice(0))
            inThread(task.chunk, task.options).then(task.resolve, task.reject);
        }
        return;
      }
      const task = queue.shift();
      const id = nextId++;
      task.worker = worker;
      running.set(id, task);
      try {
        worker.postMessage({ id, job: task.job }, task.transfer);
        if (jobTimeoutMs > 0)
          task.timer = setTimeoutImpl(() => timedOut(worker, id), jobTimeoutMs);
      } catch (error) {
        running.delete(id);
        task.reject(error);
        idle.push(worker);
      }
    }
  }

  return {
    /** The same mesh as buildChunkMesh(chunk, options), off the main thread. */
    meshChunkAsync(chunk, options = {}) {
      if (destroyed) return Promise.reject(new Error('mesh pool destroyed'));
      if (unavailable) return inThread(chunk, options);
      const { job, transfer } = snapshotJob(chunk, options);
      return new Promise((resolve, reject) => {
        // The live chunk is kept for an in-thread retry if a worker fails.
        queue.push({ job, transfer, chunk, options, resolve, reject });
        pump();
      });
    },
    /** Workers running, jobs waiting, and whether it meshes in-thread. */
    stats: () => ({
      workers: workers.length,
      busy: running.size,
      waiting: queue.length,
      inThread: unavailable,
    }),
    destroy() {
      destroyed = true;
      for (const task of queue.splice(0))
        task.reject(new Error('mesh pool destroyed'));
      for (const task of running.values()) {
        settle(task);
        task.reject(new Error('mesh pool destroyed'));
      }
      running.clear();
      for (const worker of workers.splice(0)) worker.terminate?.();
      idle.length = 0;
    },
  };
}

let shared = null;
/** The page's pool, made the first time a chunk is meshed. */
export function sharedMeshPool() {
  shared ||= createMeshPool();
  return shared;
}

/**
 * The controller's mesher in place of buildChunkMesh: the same arguments,
 * a promise of the same mesh, meshed by the page's pool.
 */
export const meshChunkAsync = (chunk, options) =>
  sharedMeshPool().meshChunkAsync(chunk, options);
