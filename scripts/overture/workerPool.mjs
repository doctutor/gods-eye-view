import { Worker } from 'node:worker_threads';

/**
 * The Overture build steps' worker threads (buildingsWorker.mjs, or
 * another build's `worker` module): jobs {type, job} run `size` at a
 * time, answered in order of completion.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */
export function createWorkerPool(
  size,
  worker = new URL('./buildingsWorker.mjs', import.meta.url),
  options = {},
) {
  const workers = Array.from(
    { length: size },
    () => new Worker(worker, options),
  );
  const waiting = new Map();
  let nextId = 0;
  const idle = [...workers];
  const queue = [];
  for (const worker of workers) {
    worker.on('message', ({ id, result, error }) => {
      const { resolve, reject } = waiting.get(id);
      waiting.delete(id);
      idle.push(worker);
      pump();
      if (error) reject(new Error(error));
      else resolve(result);
    });
    // A worker that dies (out of its heap, say) fails its job rather than
    // leaving it waiting forever.
    worker.on('error', (error) => {
      for (const [id, job] of waiting)
        if (job.worker === worker) {
          waiting.delete(id);
          job.reject(error);
        }
    });
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
    run: (type, job) =>
      new Promise((resolve, reject) => {
        queue.push({ message: { id: nextId++, type, job }, resolve, reject });
        pump();
      }),
    close: () => Promise.all(workers.map((worker) => worker.terminate())),
  };
}
