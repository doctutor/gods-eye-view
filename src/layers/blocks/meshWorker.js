/**
 * Personal fork: the Blocks meshing worker (meshPool.js). Each message is
 * {id, job} (meshJob.js snapshotJob); the answer is {id, mesh} with the
 * mesh's typed arrays transferred, or {id, error}. Once loaded it says so
 * ({ready: true}): the pool times its jobs from then (meshPool.js).
 */
import { meshTransferList, runMeshJob } from './meshJob.js';

self.addEventListener('message', (event) => {
  const { id, job } = event.data || {};
  try {
    const mesh = runMeshJob(job);
    self.postMessage({ id, mesh }, meshTransferList(mesh));
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
});

// Loaded (every module above evaluated): the pool times jobs from here.
self.postMessage({ ready: true });
