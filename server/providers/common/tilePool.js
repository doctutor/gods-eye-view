// Personal fork: a small pool of worker threads that draw tiles for the
// local tile servers (Overture buildings, census tracts, HydroSHEDS v2
// rivers), so a slow tile never holds the dev server's thread. Not part of
// upstream God's Eye View.
import { Worker } from 'node:worker_threads';

/**
 * Drawn on the server's own thread, one slow tile held every other request
 * (a 75 ms Overture tile answered in 24–30 s behind a view loading, and
 * every other route waited too). Each worker makes the named drawer
 * (tileWorker.js's DRAWERS: its factory called with `options`) once, then
 * answers `render(method, args)` with `drawer[method](...args)` (a
 * result's `body` Buffer is transferred).
 *
 * - The same `key` asked again while drawing is drawn once.
 * - `lane(args) === 'low'` sends a job to the first worker alone, ahead of
 *   its other work (Overture's tiles from orbit read every bucket, which
 *   that worker then reads once).
 * - A crashed worker fails its job and is replaced. Workers do not keep the
 *   process alive; `close()` stops them.
 *
 * @param {{drawer: string, options?: object, size?: number,
 *   lane?: (args: any[]) => string}} config
 */
export function createTilePool({
  drawer,
  options = {},
  size = 2,
  lane = () => 'any',
}) {
  const worker = new URL('./tileWorker.js', import.meta.url);
  const workerData = { drawer, options };
  const idle = [];
  const all = [];
  const low = [];
  const queue = [];
  const waiting = new Map(); // id → {resolve, reject, worker}
  const drawing = new Map(); // key → promise
  let nextId = 0;

  function spawn() {
    const thread = new Worker(worker, { workerData });
    thread.unref();
    thread.on('message', ({ id, result, error }) => {
      const job = waiting.get(id);
      waiting.delete(id);
      idle.push(thread);
      pump();
      if (!job) return;
      if (error) job.reject(new Error(error));
      else
        job.resolve(
          result && result.body instanceof ArrayBuffer
            ? { ...result, body: Buffer.from(result.body) }
            : result,
        );
    });
    thread.on('error', (error) => {
      for (const [id, job] of waiting)
        if (job.worker === thread) {
          waiting.delete(id);
          job.reject(error);
        }
      all.splice(all.indexOf(thread), 1);
      const at = idle.indexOf(thread);
      if (at >= 0) idle.splice(at, 1);
      spawn();
      pump();
    });
    all.push(thread);
    idle.push(thread);
  }

  function pump() {
    for (let i = idle.length - 1; i >= 0; i--) {
      const thread = idle[i];
      // The first worker draws the low lane first, then helps with the
      // rest; the others never take a low job.
      const job =
        thread === all[0] ? low.shift() || queue.shift() : queue.shift();
      if (!job) continue;
      idle.splice(i, 1);
      waiting.set(job.message.id, {
        resolve: job.resolve,
        reject: job.reject,
        worker: thread,
      });
      thread.postMessage(job.message);
    }
  }

  return {
    /** Ask a worker: `drawer[method](...args)`, once per `key` in flight. */
    render(method, args, key = `${method}/${args.join('/')}`) {
      const already = drawing.get(key);
      if (already) return already;
      if (!all.length) for (let i = 0; i < Math.max(1, size); i++) spawn();
      const promise = new Promise((resolve, reject) => {
        (lane(args) === 'low' ? low : queue).push({
          message: { id: nextId++, method, args },
          resolve,
          reject,
        });
        pump();
      }).finally(() => drawing.delete(key));
      drawing.set(key, promise);
      return promise;
    },
    /** Workers started (for status and tests). */
    size: () => all.length,
    close: () => Promise.all(all.splice(0).map((thread) => thread.terminate())),
  };
}
