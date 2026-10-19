import { Worker } from 'node:worker_threads';

/**
 * The Overture build steps' worker threads (buildingsWorker.mjs): jobs
 * {type, job} run `size` at a time, answered in order of completion.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */
export function createWorkerPool(size) {
  const workers = Array.from(
    { length: size },
    () => new Worker(new URL('./buildingsWorker.mjs', import.meta.url)),
  );
  const waiting = new Map();
  let nextId = 0;
  const idle = [...workers];
  const queue = [];
  for (const worker of workers)
    worker.on('message', ({ id, result, error }) => {
      const { resolve, reject } = waiting.get(id);
      waiting.delete(id);
      idle.push(worker);
      pump();
      if (error) reject(new Error(error));
      else resolve(result);
    });
  function pump() {
    while (idle.length && queue.length) {
      const worker = idle.pop();
      const { message, resolve, reject } = queue.shift();
      waiting.set(message.id, { resolve, reject });
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
