/**
 * Personal fork: the Blocks renderer's GLBs made off the main thread
 * (docs/BLOCKS-PLAN.md, option 3). One worker (glbWorker.js) keeps every
 * drawn chunk's packed parts (glbStore.js), given to it by transfer, and
 * makes a chunk's own GLB when it arrives and a batch's when asked, each
 * transferred back: the page holds no geometry, only GLBs on their way to
 * Cesium. Where Workers cannot be made (Node, a worker that fails to
 * start) the same store runs in this thread behind the same promises.
 */
import { createGlbStore } from './glbStore.js';
import { packedBuffers } from './gltf.js';

/** A module worker running glbWorker.js, or null where there are none. */
function browserWorker() {
  if (typeof Worker !== 'function') return null;
  // Written out in full so Vite bundles the worker.
  return new Worker(new URL('./glbWorker.js', import.meta.url), {
    type: 'module',
  });
}

const partsBuffers = (parts) => [
  ...packedBuffers(parts?.opaque),
  ...packedBuffers(parts?.water),
];

/**
 * @param {{createWorker?: () => object|null}} options a Worker, or anything
 *   with postMessage, addEventListener('message' | 'error') and terminate.
 */
export function createGlbService({ createWorker = browserWorker } = {}) {
  let worker = null;
  try {
    worker = createWorker?.() || null;
  } catch {
    worker = null;
  }
  const store = worker ? null : createGlbStore();
  const waiting = new Map();
  let nextId = 1;
  let last = { chunks: 0, parked: 0, bytes: 0 };
  let broken = null;

  if (worker) {
    worker.addEventListener('message', (event) => {
      const { id, error, stats, ...answer } = event.data || {};
      const task = waiting.get(id);
      if (!task) return;
      waiting.delete(id);
      if (stats) last = stats;
      if (error) task.reject(new Error(error));
      else task.resolve(answer);
    });
    worker.addEventListener('error', (event) => {
      event?.preventDefault?.();
      // Its parts are gone with it: what is waiting fails (the renderer
      // keeps what it drew), and so does what is asked from now on.
      broken = new Error('Blocks GLB worker failed');
      for (const task of waiting.values()) task.reject(broken);
      waiting.clear();
    });
  }

  /** An answered op: in the worker, or the store here (still a promise). */
  function ask(message, transfer = []) {
    if (broken) return Promise.reject(broken);
    if (!worker)
      return Promise.resolve().then(() => {
        const { op, key, version, parts, chunk, members } = message;
        if (op === 'put') return { glb: store.put(key, version, parts, chunk) };
        if (op === 'revive') return { glb: store.revive(key, version) };
        return store.batch(members);
      });
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer);
    });
  }

  /** An op that needs no answer. */
  function tell(message) {
    if (broken) return;
    if (!worker) {
      if (message.op === 'forget') store.forget(message.key);
      else store.forgetAll();
      return;
    }
    worker.postMessage(message);
  }

  return {
    /**
     * A chunk's packed parts at a version, given away (their buffers are
     * transferred): a promise of its own GLB (null with no faces).
     */
    put(key, version, parts, chunk) {
      return ask(
        { op: 'put', key, version, parts, chunk },
        partsBuffers(parts),
      ).then(({ glb }) => glb);
    },
    /** A coarse chunk back with the parts it had: a promise of its GLB. */
    revive(key, version) {
      return ask({ op: 'revive', key, version }).then(({ glb }) => glb);
    },
    /** A batch's members ({key, offset}): a promise of {glb, versions}. */
    batch(members) {
      return ask({ op: 'batch', members });
    },
    forget(key) {
      tell({ op: 'forget', key });
    },
    forgetAll() {
      tell({ op: 'forgetAll' });
    },
    /** Chunks kept and their bytes (the worker's, as of its last answer). */
    stats: () => (store ? store.stats() : { ...last }),
    /** Whether the GLBs are made in a worker. */
    inWorker: () => Boolean(worker),
    destroy() {
      for (const task of waiting.values())
        task.reject(new Error('Blocks GLB service destroyed'));
      waiting.clear();
      worker?.terminate?.();
      store?.forgetAll();
      broken = new Error('Blocks GLB service destroyed');
    },
  };
}
