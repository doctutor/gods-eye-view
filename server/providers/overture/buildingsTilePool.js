// Personal fork: a small pool of worker threads drawing Overture buildings
// tiles (buildingsTileWorker.js). Not part of upstream God's Eye View.
import { Worker } from 'node:worker_threads';

/**
 * Tiles are drawn synchronously (a z 0 tile reads every bucket), so drawn
 * on the server's own thread one slow tile held every other request: a
 * San Diego tile that draws in 75 ms answered in 24–30 s behind a view
 * loading. The pool draws them off that thread, `size` at a time, each
 * worker keeping its own open buckets and overviews; the same tile asked
 * twice while drawing is drawn once. Workers do not keep the process alive.
 *
 * @param {{dir: string, size?: number}} options
 */
export function createTilePool({ dir, size = 4 }) {
  const url = new URL('./buildingsTileWorker.js', import.meta.url);
  const idle = [];
  const all = [];
  const queue = [];
  const waiting = new Map(); // id → {resolve, reject, worker}
  const drawing = new Map(); // tile key → promise
  let nextId = 0;

  function spawn() {
    const worker = new Worker(url, { workerData: { dir } });
    worker.unref();
    worker.on('message', ({ id, status, error, version, body }) => {
      const job = waiting.get(id);
      waiting.delete(id);
      idle.push(worker);
      pump();
      job?.resolve({
        status,
        error,
        version,
        body: body ? Buffer.from(body) : null,
      });
    });
    worker.on('error', (error) => {
      // A crashed worker fails its tile and is replaced.
      for (const [id, job] of waiting)
        if (job.worker === worker) {
          waiting.delete(id);
          job.reject(error);
        }
      all.splice(all.indexOf(worker), 1);
      const at = idle.indexOf(worker);
      if (at >= 0) idle.splice(at, 1);
      spawn();
      pump();
    });
    all.push(worker);
    idle.push(worker);
  }

  function pump() {
    while (idle.length && queue.length) {
      const worker = idle.pop();
      const { message, resolve, reject } = queue.shift();
      waiting.set(message.id, { resolve, reject, worker });
      worker.postMessage(message);
    }
  }

  return {
    /** Draw a tile: {status, error?, version, body: Buffer|null}. */
    render(mode, ink, z, x, y) {
      const key = `${mode}/${ink}/${z}/${x}/${y}`;
      const already = drawing.get(key);
      if (already) return already;
      if (!all.length) for (let i = 0; i < Math.max(1, size); i++) spawn();
      const promise = new Promise((resolve, reject) => {
        queue.push({
          message: { id: nextId++, mode, ink, z, x, y },
          resolve,
          reject,
        });
        pump();
      }).finally(() => drawing.delete(key));
      drawing.set(key, promise);
      return promise;
    },
    close: () => Promise.all(all.splice(0).map((worker) => worker.terminate())),
  };
}
