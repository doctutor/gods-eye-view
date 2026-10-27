import * as Cesium from 'cesium';
import { createBlocksController } from '../layers/blocks/index.js';
import * as grid from '../layers/blocks/grid.js';
import { buildChunkMesh } from '../layers/blocks/mesh.js';
import { createChunk } from '../layers/blocks/store.js';
import { createChunkSource } from '../layers/blocks/source.js';
import { blocksSun, createBlocksRenderer } from '../layers/blocks/renderer.js';
import { createRasterValuesClient } from '../data/rasterValues.js';
import { governorRequestRender } from '../renderGovernor.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { isFlatBasemap } from '../layers/lego/renderMode.js';
// Personal fork: Walk and Fly walk on the drawn blocks (src/navigation/).
import { provideBlocksWorld } from '../navigation/blocksSource.js';

/**
 * Personal fork: Render: Blocks (docs/BLOCKS-PLAN.md), the ground around
 * the camera as chunks of cubes from the Elevation layer's values. Wires
 * the controller (src/layers/blocks/index.js) to the grid, mesher, chunk
 * source and renderer, and to the render mode the ANALYSIS heading's
 * drop-down shares with Lego.
 * @param {{viewer: object, dataManager: object, store: object,
 *   mapStackController?: object|null}} scene
 */
export function createApplicationBlocks({
  viewer,
  dataManager,
  store,
  mapStackController = null,
}) {
  const values = createRasterValuesClient();
  const controller = createBlocksController({
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
    datum: blocksDatum({ viewer, mapStackController }),
    // On a drawn style the blocks are the world: the globe is hidden.
    flatStyle: () =>
      isFlatBasemap(mapStackController?.getActiveStack?.()) === true,
    requestRender: governorRequestRender,
  });
  const unprovide = provideBlocksWorld(() => controller.world());
  const destroy = controller.destroy;
  controller.destroy = () => {
    unprovide();
    destroy();
  };
  return controller;
}

/**
 * Where sea level sits for Blocks. Flat ground (no photoreal tileset and
 * the globe on Cesium's ellipsoid terrain: Lego's test for columns on the
 * ellipsoid) draws level 0 on the ellipsoid. On terrain or the photoreal
 * tiles, whose heights are ellipsoidal, the region is lifted by the EGM96
 * undulation so level 0 lands on the sea surface. Most basemaps, the blank
 * ones too, keep the globe's terrain (World Terrain, or Re:Earth's
 * keyless terrain), so they are terrain here, not flat.
 */
export function blocksDatum({ viewer, mapStackController, cesium = Cesium }) {
  return {
    flat() {
      if (mapStackController?.getImageryHostTileset?.()) return false;
      const terrain = viewer?.terrainProvider;
      return !terrain || terrain instanceof cesium.EllipsoidTerrainProvider;
    },
    async undulation(lat, lon) {
      await ensureGeoidReady();
      return geoidHeight(lat, lon);
    },
    subscribe: (listener) => mapStackController?.subscribe?.(listener),
  };
}

/**
 * The renderer made the first time Blocks anchors a region, so a page that
 * never picks Blocks adds nothing to the scene.
 */
export function lazyRenderer(make) {
  let renderer = null;
  const made = () => (renderer ||= make());
  return {
    setRegion: (region, options) => made().setRegion(region, options),
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
