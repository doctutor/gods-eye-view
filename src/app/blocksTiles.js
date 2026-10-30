// Personal fork: Render: Blocks drawn from the precomputed tilesets
// (docs/BLOCKS-PLAN.md, milestone 6, step C). The server's index says
// which boxes are built (/api/blocks/tiles/index.json); the controller
// asks plan() which of them draws the view (src/layers/blocks/tiles.js)
// and says so in its status (status.tiles); this layer shows that box's
// Cesium3DTileset with the Blocks look (renderer.js blocksShader, as the
// live chunks), the Buildings switch choosing its variant, raised by the
// geoid as the live datum is, with a hole where the live chunks draw.
// Cesium's own traversal then refines in place: no rebuild on a level
// change. Relief is Cesium's vertical exaggeration, as for the globe.

import * as Cesium from 'cesium';
import { sunPosition } from '../data/solarDaylight.js';
import {
  DITHER_DEFAULTS,
  EDGE_DEFAULTS,
  blocksShader,
  fogColorFor,
  model3D,
} from '../layers/blocks/renderer.js';
import {
  TILES_INDEX_URL,
  planTiles,
  tilesBoxes,
} from '../layers/blocks/tiles.js';

/**
 * The screen-space error the tiles refine to: 4 px matched the live
 * controller's block size (two pixels a cell, index.js FOOTPRINT_BLOCKS)
 * from 5,000 km and from 500 km at pitch −45 (worker1's frames of the
 * lower-48 tileset, docs/BLOCKS-PLAN.md).
 */
export const TILES_SCREEN_ERROR = 4;
/** The tiles kept in memory at most (Cesium's cache; its default is 512 MB). */
export const TILES_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * The cache guard. While the tiles a view wants overflow the cache
 * (cacheBytes plus Cesium's maximumCacheOverflowBytes), Cesium raises a
 * tileset's memoryAdjustedScreenSpaceError, unloads tiles, and lowers it
 * again once under cacheBytes, so the finer tiles load again: at Lake
 * Tahoe the lower 48's 480 m tiles (60 MB each decoded) and their 1,920 m
 * parents swapped every 4 s, 207 requests and the main thread decoding
 * (2026-10-30). The guard holds the raised error as the tileset's
 * maximumScreenSpaceError, under which Cesium never lowers it, so the
 * coarser level stays until the camera next moves or stops; then the tiles
 * may refine again, and the guard holds wherever the cache overflows.
 * @returns {number|null} the error now held, or null when none is
 */
export function guardTilesCache(tileset, baseError = TILES_SCREEN_ERROR) {
  const adjusted = Number(tileset?.memoryAdjustedScreenSpaceError);
  const maximum = Number(tileset?.maximumScreenSpaceError);
  if (!(adjusted > maximum + 1e-9)) return maximum > baseError ? maximum : null;
  tileset.maximumScreenSpaceError = adjusted;
  return adjusted;
}

/** The server's index of built boxes, or none. */
async function fetchTilesIndex() {
  const answer = await fetch(TILES_INDEX_URL, { cache: 'no-cache' });
  if (!answer.ok) return { boxes: [] };
  return answer.json();
}

/** No image-based lighting on the tiles: their light is baked. */
const noImageLighting = () =>
  new Cesium.ImageBasedLighting({
    imageBasedLightingFactor: new Cesium.Cartesian2(0, 0),
  });

/**
 * @param {{viewer: object, fetchIndex?: () => Promise<object>,
 *   createTileset?: (url: string, options: object) => Promise<object>,
 *   buildings?: () => boolean, now?: () => number}} options
 *   buildings: the Buildings switch (the ground-only variant when off).
 */
export function createBlocksTilesLayer({
  viewer,
  fetchIndex = fetchTilesIndex,
  createTileset = (url, options) =>
    Cesium.Cesium3DTileset.fromUrl(url, options),
  buildings = () => true,
  now = () => Date.now(),
}) {
  const scene = viewer.scene;
  let boxes = [];
  let destroyed = false;
  const ready = Promise.resolve()
    .then(fetchIndex)
    .then(
      (index) => {
        boxes = tilesBoxes(index);
      },
      (error) =>
        console.warn('[Blocks] no tiles index:', error?.message || error),
    );
  // The live chunks' look; their edges and dither fade by pixels only (the
  // tileset's levels differ, so no one block size fades them by distance).
  const shader = blocksShader();
  shader.setUniform('u_edgeStrength', EDGE_DEFAULTS.strength);
  shader.setUniform('u_ditherAmount', DITHER_DEFAULTS.amount);
  shader.setUniform('u_edgeFadeStart', 1e9);
  shader.setUniform('u_edgeFadeEnd', 2e9);
  shader.setUniform('u_blockM', 1);
  const imageLighting = noImageLighting();
  /** url → {tileset: Cesium3DTileset|null} */
  const loaded = new Map();
  let shownUrl = null;
  /** The controller's status.tiles in force, or null. */
  let state = null;
  /** Told of each tile loaded (the QA harness times the first picture). */
  const tileLoadListeners = new Set();
  let tileLoads = 0;
  /** The screen-space error the cache guard holds (guardTilesCache), or null. */
  let heldError = null;
  let guardHolds = 0;

  const requestRender = () => scene.requestRender?.();

  /** The guard lets go: every tileset refines to TILES_SCREEN_ERROR again. */
  function releaseGuard() {
    if (heldError === null) return;
    heldError = null;
    for (const entry of loaded.values())
      if (entry.tileset)
        entry.tileset.maximumScreenSpaceError = TILES_SCREEN_ERROR;
    requestRender();
  }
  const removeMoveStart =
    scene.camera?.moveStart?.addEventListener(releaseGuard);
  const removeMoveEnd = scene.camera?.moveEnd?.addEventListener(releaseGuard);

  function tilesetFor(url) {
    let entry = loaded.get(url);
    if (entry) return entry;
    entry = { tileset: null };
    loaded.set(url, entry);
    Promise.resolve()
      .then(() =>
        createTileset(url, {
          customShader: shader,
          maximumScreenSpaceError: TILES_SCREEN_ERROR,
          // Cesium's fog term takes up to 24 px off far tiles' error: from
          // 5,000 km the lower 48's roots then never refined, at any
          // maximumScreenSpaceError (worker1, docs/BLOCKS-PLAN.md).
          dynamicScreenSpaceError: false,
          cacheBytes: TILES_CACHE_BYTES,
          shadows: Cesium.ShadowMode.DISABLED,
          imageBasedLighting: imageLighting,
          environmentMapOptions: { enabled: false },
          showCreditsOnScreen: false,
        }),
      )
      .then((tileset) => {
        if (destroyed || loaded.get(url) !== entry) {
          tileset.destroy?.();
          return;
        }
        // Each tile's Model fogless as the live chunks' (renderer.js
        // model3D): the shader fogs toward the sky, not Cesium's atmosphere.
        tileset.tileLoad?.addEventListener((tile) => {
          const model = tile?.content?._model;
          if (model && !model.blocks3D) {
            model3D(model);
            model.blocks3D = true;
          }
          tileLoads++;
          for (const listener of tileLoadListeners) listener(tile);
        });
        tileset.show = url === shownUrl;
        entry.tileset = tileset;
        scene.primitives.add(tileset);
        place();
        requestRender();
      })
      .catch((error) => {
        console.warn('[Blocks] tiles not loaded:', error?.message || error);
        if (loaded.get(url) === entry) loaded.delete(url);
      });
    return entry;
  }

  /**
   * The tiles raised by the geoid's undulation along the up at the
   * camera's ground (their heights are above sea level), as the live
   * chunks' datum offset is.
   */
  function place() {
    const offset = Number(state?.datumOffsetM) || 0;
    const place = scene.camera?.positionCartographic;
    let matrix = Cesium.Matrix4.IDENTITY;
    if (offset && place) {
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
        new Cesium.Cartographic(place.longitude, place.latitude, 0),
        new Cesium.Cartesian3(),
      );
      matrix = Cesium.Matrix4.fromTranslation(
        Cesium.Cartesian3.multiplyByScalar(up, offset, up),
      );
    }
    for (const entry of loaded.values())
      if (entry.tileset) entry.tileset.modelMatrix = matrix;
  }

  /**
   * Each frame: the fog's colour as the live chunks have it (the horizon
   * sky near the ground, else the background) and the hole about the live
   * chunks' centre in eye coordinates.
   */
  function frame() {
    if (!shownUrl || !state) return;
    const shown = loaded.get(shownUrl)?.tileset;
    if (shown) {
      const held = guardTilesCache(shown);
      if (held !== null && held !== heldError) {
        if (heldError === null) guardHolds++;
        heldError = held;
      }
    }
    const at = scene.camera?.positionCartographic;
    if (at) {
      const { color } = fogColorFor(scene, {
        heightM: at.height,
        sunElevationDeg: sunPosition(
          now(),
          Cesium.Math.toDegrees(at.latitude),
          Cesium.Math.toDegrees(at.longitude),
        ).elevation,
      });
      shader.setUniform('u_fogColor', new Cesium.Cartesian4(...color));
    }
    const hole = state.hole;
    const view = scene.camera?.viewMatrix;
    if (hole?.radiusM > 0 && view) {
      const world = Cesium.Cartesian3.fromDegrees(
        hole.lon,
        hole.lat,
        Number(state.datumOffsetM) || 0,
      );
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        world,
        new Cesium.Cartesian3(),
      );
      shader.setUniform(
        'u_holeCentreEC',
        Cesium.Matrix4.multiplyByPoint(view, world, new Cesium.Cartesian3()),
      );
      shader.setUniform(
        'u_holeUpEC',
        Cesium.Cartesian3.normalize(
          Cesium.Matrix4.multiplyByPointAsVector(view, up, up),
          up,
        ),
      );
      shader.setUniform('u_holeRadiusM', hole.radiusM);
    } else shader.setUniform('u_holeRadiusM', 0);
  }
  const removePreRender = scene.preRender?.addEventListener(frame);

  const api = {
    /** The index read (or failed): a promise. */
    ready,
    /** The plan for a view (tiles.js planTiles over the built boxes). */
    plan: (view) => planTiles(boxes, view),
    /**
     * The controller's status: its tiles shown as it says (status.tiles,
     * only while Blocks draws), the others hidden but kept.
     */
    apply(status) {
      state = status?.tiles || null;
      const box = state ? boxes.find((each) => each.name === state.box) : null;
      shownUrl = box ? box.url({ buildings: buildings() !== false }) : null;
      if (shownUrl) tilesetFor(shownUrl);
      for (const [url, entry] of loaded)
        if (entry.tileset) entry.tileset.show = url === shownUrl;
      if (state?.fog) {
        shader.setUniform('u_fogStartM', state.fog.startM);
        shader.setUniform('u_fogEndM', state.fog.endM);
      }
      place();
      frame();
      requestRender();
    },
    /** What is shown: the box's tileset URL, and the tilesets loaded. */
    getState: () => {
      const shown = shownUrl ? loaded.get(shownUrl)?.tileset : null;
      return {
        boxes: boxes.map((box) => box.name),
        shown: shownUrl,
        loaded: [...loaded.keys()],
        tiles: state,
        tileLoads,
        // The shown tileset has every tile the view wants (Cesium's own).
        tilesLoaded: shown ? Boolean(shown.tilesLoaded) : null,
        // The cache guard: the error it holds now, and how often it held.
        heldError,
        guardHolds,
        memoryMB: shown?.totalMemoryUsageInBytes
          ? Math.round(shown.totalMemoryUsageInBytes / 1e6)
          : null,
      };
    },
    /** Hear each tile loaded; returns the remover. */
    onTileLoad(listener) {
      tileLoadListeners.add(listener);
      return () => tileLoadListeners.delete(listener);
    },
    /** The tiles' shader (for tests and the harness). */
    shader,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removePreRender?.();
      removeMoveStart?.();
      removeMoveEnd?.();
      for (const entry of loaded.values())
        if (entry.tileset) scene.primitives.remove(entry.tileset);
      loaded.clear();
      requestRender();
    },
  };
  return api;
}
