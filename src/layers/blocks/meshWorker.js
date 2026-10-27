/**
 * Personal fork: the Blocks meshing worker (meshPool.js). Each message is
 * {id, job} (meshJob.js snapshotJob); the answer is {id, mesh} with the
 * mesh's typed arrays transferred, or {id, error}.
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
