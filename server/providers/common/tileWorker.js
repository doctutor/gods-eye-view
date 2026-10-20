// Personal fork: a tile pool's worker (tilePool.js): makes the named
// drawer once and answers its jobs. Not part of upstream God's Eye View.
import { parentPort, workerData } from 'node:worker_threads';

/** The drawers a pool can name: each a factory taking the pool's options. */
const DRAWERS = Object.freeze({
  'overture-buildings': () =>
    import('../overture/buildingsTiles.js').then((m) => m.createBuildingsTiles),
  census: () => import('../census.js').then((m) => m.createCensusService),
  'overture-places': () =>
    import('../overture/placesIndex.js').then((m) => m.createPlacesIndex),
  'overture-infrastructure': () =>
    import('../overture/placesIndex.js').then(
      (m) => m.createInfrastructureIndex,
    ),
  'rivers-v2': () =>
    import('../riversV2.js').then((m) => m.createRiversV2Service),
  'raster-values': () =>
    import('../rasterValues/selfHosted.js').then(
      (m) => m.createSelfHostedValues,
    ),
});

const drawerReady = (async () => {
  const load = DRAWERS[workerData.drawer];
  if (!load) throw new Error(`no tile drawer ${workerData.drawer}`);
  return (await load())(workerData.options || {});
})();

parentPort.on('message', async ({ id, method, args }) => {
  try {
    const drawer = await drawerReady;
    if (typeof drawer[method] !== 'function')
      throw new Error(`the drawer has no ${method}`);
    const result = await drawer[method](...args);
    const body = result?.body;
    if (body && Buffer.isBuffer(body)) {
      const copy = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      );
      parentPort.postMessage({ id, result: { ...result, body: copy } }, [copy]);
    } else parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
