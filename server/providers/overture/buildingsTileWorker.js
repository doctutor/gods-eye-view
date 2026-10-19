// Personal fork: draws Overture buildings tiles in a worker thread, so a
// slow tile never holds the dev server's event loop (every other route
// waits behind a synchronous draw). Not part of upstream God's Eye View.
import { parentPort, workerData } from 'node:worker_threads';
import { createBuildingsTiles } from './buildingsTiles.js';

const tiles = createBuildingsTiles({ dir: workerData.dir });

parentPort.on('message', ({ id, mode, ink, z, x, y }) => {
  try {
    const answer = tiles.tile(mode, ink, z, x, y);
    const body = answer.body
      ? answer.body.buffer.slice(
          answer.body.byteOffset,
          answer.body.byteOffset + answer.body.byteLength,
        )
      : null;
    parentPort.postMessage(
      {
        id,
        status: answer.status,
        error: answer.error,
        version: answer.version,
        body,
      },
      body ? [body] : [],
    );
  } catch (error) {
    parentPort.postMessage({
      id,
      status: 500,
      error: String(error?.message || error),
    });
  }
});
