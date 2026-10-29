import * as Cesium from 'cesium';
import {
  ANCHOR_SETTLE_MS,
  createBlocksController,
} from '../layers/blocks/index.js';
import * as grid from '../layers/blocks/grid.js';
import { buildChunkMesh } from '../layers/blocks/mesh.js';
import { meshChunkAsync, sharedMeshPool } from '../layers/blocks/meshPool.js';
import {
  applyStructures,
  createStructuresSource,
} from '../layers/blocks/structures.js';
import { createChunk } from '../layers/blocks/store.js';
import { SUPERGROUP, createChunkSource } from '../layers/blocks/source.js';
import { blocksSun, createBlocksRenderer } from '../layers/blocks/renderer.js';
import { createRasterValuesClient } from '../data/rasterValues.js';
import { governorRequestRender } from '../renderGovernor.js';
import { ensureGeoidReady, geoidHeight } from '../data/geoid.js';
import { isFlatBasemap } from '../layers/lego/renderMode.js';
import { viewFootprintM } from '../hud/cameraState.js';
import { navigationStore } from '../navigation/store.js';
// Personal fork: Walk and Fly walk on the drawn blocks (src/navigation/).
import { provideBlocksWorld } from '../navigation/blocksSource.js';

/**
 * Personal fork: Render: Blocks (docs/BLOCKS-PLAN.md), the ground around
 * the camera as chunks of cubes from the Elevation layer's values. Wires
 * the controller (src/layers/blocks/index.js) to the grid, mesher, chunk
 * source and renderer, and to the render mode the ANALYSIS heading's
 * drop-down shares with Lego.
 * @param {{viewer: object, dataManager: object, store: object,
 *   mapStackController?: object|null, reliefStore?: {subscribe: Function}
 *   |null}} scene reliefStore: the Relief control's store (photoreal.js),
 *   heard so the blocks follow it
 */
export function createApplicationBlocks({
  viewer,
  dataManager,
  store,
  mapStackController = null,
  reliefStore = null,
}) {
  const values = createRasterValuesClient();
  const chunks = createChunkSource({
    fetchValues: (request) => values.get(request),
    createChunk,
  });
  // OpenStreetMap buildings through the app's Overpass proxy (/api/overpass),
  // standing on the ground of the same chunks.
  const buildings = createStructuresSource({
    loadChunk: (region, ci, cj) => chunks.loadChunk(region, ci, cj),
  });
  const controller = createBlocksController({
    viewer,
    store,
    layers: {
      isEnabled: (id) => dataManager.isEnabled(id),
      subscribeActivity: (listener) => dataManager.subscribeActivity(listener),
    },
    source: chunks,
    renderer: lazyRenderer(() => createBlocksRenderer({ viewer })),
    grid,
    buildChunkMesh,
    // Coarse chunks come a supergroup at a time (source.js).
    supergroupGroups: SUPERGROUP,
    // Meshed off the main thread by the worker pool, its queue the brake.
    meshAsync: meshChunkAsync,
    meshBacklog: () => sharedMeshPool().stats(),
    // Buildings on the fine ring, where Overpass answers.
    structures: {
      // One Overpass query per supergroup (4 × 4 groups), not per group.
      loadChunk: (region, ci, cj) =>
        buildings.loadChunkStructures(region, ci, cj, { viaSupergroup: true }),
      groupBuildings: (region, gi, gj) =>
        buildings.loadGroupBuildings(region, gi, gj, { viaSupergroup: true }),
      apply: applyStructures,
    },
    // Anchored once the camera has been still 2 s (a link's flight starts
    // 1.5 s after the page opens).
    settleMs: ANCHOR_SETTLE_MS,
    // The block size from the HUD's PX at the view's centre (milestone 5);
    // none in Walk and Fly, where the centre is the horizon's and the
    // blocks underfoot keep their size.
    footprint: () =>
      navigationStore().get() === 'spectator'
        ? viewFootprintM(viewer)
        : Number.NaN,
    // The Relief control as the scene draws the globe with it
    // (photoreal.js applyRelief), heard through its store.
    relief: () => ({
      factor: viewer?.scene?.verticalExaggeration || 1,
      relativeM: viewer?.scene?.verticalExaggerationRelativeHeight || 0,
    }),
    subscribeRelief: reliefStore
      ? (listener) => reliefStore.subscribe(listener)
      : null,
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
    setRegions: (regions, options) => made().setRegions(regions, options),
    upsert: (key, mesh) => made().upsert(key, mesh),
    remove: (key) => renderer?.remove(key),
    setSun: (dir, options) => made().setSun?.(dir, options),
    setFog: (fog) => made().setFog?.(fog),
    setVisible: (on) => renderer?.setVisible?.(on),
    keys: () => renderer?.keys?.() ?? [],
    destroy() {
      renderer?.destroy?.();
      renderer = null;
    },
  };
}
