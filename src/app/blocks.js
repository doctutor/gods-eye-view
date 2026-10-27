import { createBlocksController } from '../layers/blocks/index.js';
import * as grid from '../layers/blocks/grid.js';
import { buildChunkMesh } from '../layers/blocks/mesh.js';
import { createChunk } from '../layers/blocks/store.js';
import { createChunkSource } from '../layers/blocks/source.js';
import { blocksSun, createBlocksRenderer } from '../layers/blocks/renderer.js';
import { createRasterValuesClient } from '../data/rasterValues.js';
import { governorRequestRender } from '../renderGovernor.js';

/**
 * Personal fork: Render: Blocks (docs/BLOCKS-PLAN.md), the ground around
 * the camera as chunks of cubes from the Elevation layer's values. Wires
 * the controller (src/layers/blocks/index.js) to the grid, mesher, chunk
 * source and renderer, and to the render mode the ANALYSIS heading's
 * drop-down shares with Lego.
 * @param {{viewer: object, dataManager: object, store: object}} scene
 */
export function createApplicationBlocks({ viewer, dataManager, store }) {
  const values = createRasterValuesClient();
  return createBlocksController({
    viewer,
    store,
    layers: {
      isEnabled: (id) => dataManager.isEnabled(id),
      subscribeActivity: (listener) => dataManager.subscribeActivity(listener),
    },
    source: createChunkSource({
      fetchValues: (request) => values.get(request),
      createChunk,
    }),
    renderer: lazyRenderer(() => createBlocksRenderer({ viewer })),
    grid,
    buildChunkMesh,
    // The real sun when it is above 15°, else the study sun.
    sun: (lon, lat) => blocksSun(Date.now(), lat, lon),
    requestRender: governorRequestRender,
  });
}

/**
 * The renderer made the first time Blocks anchors a region, so a page that
 * never picks Blocks adds nothing to the scene.
 */
export function lazyRenderer(make) {
  let renderer = null;
  const made = () => (renderer ||= make());
  return {
    setRegion: (region) => made().setRegion(region),
    upsert: (key, mesh) => made().upsert(key, mesh),
    remove: (key) => renderer?.remove(key),
    setSun: (dir, options) => made().setSun?.(dir, options),
    setFog: (fog) => made().setFog?.(fog),
    keys: () => renderer?.keys?.() ?? [],
    destroy() {
      renderer?.destroy?.();
      renderer = null;
    },
  };
}
