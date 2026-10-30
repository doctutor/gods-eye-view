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
  CLIPPING_SIDES,
  DITHER_DEFAULTS,
  blocksClippingPlanes,
  createBlocksModel,
  parkedPlanes,
  prewarmBlocksGlb,
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
/**
 * The error a tileset whose finest level is FAR_LEVEL_M or coarser refines
 * to (Cesium has one error a tileset, not one a level): at 4 px the lower
 * 48's 480 m tiles under Lake Tahoe from 70 km wanted over a gigabyte
 * (2026-10-30); a view that needs that much is the wrong view.
 */
export const FAR_SCREEN_ERROR = 8;
/** From this finest level up, a tileset refines to FAR_SCREEN_ERROR. */
export const FAR_LEVEL_M = 480;
/**
 * Over this camera height a coarse tree refines to TILES_SCREEN_ERROR
 * again, until the camera is back under FAR_HIGH_BELOW_M (so a descent
 * does not flip it at the boundary): from 8,400 km the lower 48 at 8 px
 * stayed on its 30,720 m roots (3 px a block against the live look's 2),
 * and the tiles there are few and light.
 */
export const FAR_HIGH_ABOVE_M = 2_000_000;
export const FAR_HIGH_BELOW_M = 1_500_000;
/** Whether the camera counts as high now, given whether it did. */
export const cameraHigh = (heightM, wasHigh = false) =>
  wasHigh ? heightM > FAR_HIGH_BELOW_M : heightM > FAR_HIGH_ABOVE_M;
/** The error a box's tileset refines to, the camera high or not. */
export const screenErrorFor = (box, high = false) =>
  Number(box?.finestM) >= FAR_LEVEL_M && !high
    ? FAR_SCREEN_ERROR
    : TILES_SCREEN_ERROR;

/** The cache guard's step: the error's floor rises by this much at a time. */
export const GUARD_STEP = 1.25;

/**
 * Below this height (m above the ellipsoid) and before the live chunks'
 * hole opens, each frame asks whether the camera is inside a tile (under
 * its top): at the street the 120 m tiles draw until the live fine disc
 * is in, and the camera can stand inside one of their blocks.
 */
export const INSIDE_CHECK_M = 9000;
/** The hole opened about a camera inside a tile: this many floor blocks. */
export const INSIDE_HOLE_BLOCKS = 2;

/**
 * The cache guard. While the tiles a view wants overflow the cache
 * (cacheBytes plus Cesium's maximumCacheOverflowBytes), Cesium raises a
 * tileset's memoryAdjustedScreenSpaceError 2 % a frame, unloads tiles, and
 * lowers it again once under cacheBytes, down to maximumScreenSpaceError,
 * so the finer tiles load again: at Lake Tahoe the lower 48's 480 m tiles
 * (60 MB each decoded) and their 1,920 m parents swapped every 4 s, 207
 * requests and the main thread decoding (2026-10-30). Each time the cache
 * frees after an overflow, the guard raises the floor (the tileset's
 * maximumScreenSpaceError, which Cesium never goes under) by GUARD_STEP,
 * so the tiles settle at the finest step that fits instead of swinging;
 * held at the peak, the floor stuck at 43 px (the unloads lag the raise).
 * `release` (the camera moved or stopped) lets the tiles refine again.
 */
export function createCacheGuard(baseError = TILES_SCREEN_ERROR) {
  let floor = baseError;
  let overflowing = false;
  let last = null;
  let steps = 0;
  return {
    /** Each frame, with the shown tileset. */
    update(tileset) {
      const adjusted = Number(tileset?.memoryAdjustedScreenSpaceError);
      if (!Number.isFinite(adjusted)) return;
      if (last !== null && adjusted > last && adjusted > floor * (1 + 1e-9))
        overflowing = true;
      else if (overflowing && last !== null && adjusted < last) {
        // The cache freed: hold one step above where it overflowed.
        overflowing = false;
        floor *= GUARD_STEP;
        steps++;
        tileset.maximumScreenSpaceError = floor;
        last = floor;
        return;
      }
      last = adjusted;
    },
    /** Back to the base error on `tilesets` (the camera moved). */
    release(tilesets = []) {
      const held = floor > baseError;
      floor = baseError;
      overflowing = false;
      last = null;
      if (held)
        for (const tileset of tilesets)
          if (tileset) tileset.maximumScreenSpaceError = baseError;
      return held;
    },
    /** The floor held above the base, or null. */
    get error() {
      return floor > baseError ? floor : null;
    },
    /** How many steps it has taken since it was made. */
    get steps() {
      return steps;
    },
  };
}

/**
 * The sides of the polygon inscribed in the hole whose tiles are culled:
 * every Blocks Model's planes (renderer.js CLIPPING_SIDES), so the tiles
 * and the live chunks share their programs.
 */
export const HOLE_SIDES = CLIPPING_SIDES;

/** The pre-warm's Models are removed after this many frames at most. */
export const PREWARM_FRAMES = 300;

/**
 * The clipping planes that cull the tiles inside the hole: HOLE_SIDES
 * vertical planes about the hole's centre (east, north, up there), each
 * facing out at the inscribed polygon's apothem, so a point inside the
 * polygon is outside every plane, which is what a collection not uniting
 * its regions clips; a tile wholly inside is culled before it loads
 * (Cesium3DTile.visibility). The shader still cuts the hole's circle.
 */
export function holePlanes(radiusM, sides = HOLE_SIDES) {
  const apothem = radiusM * Math.cos(Math.PI / sides);
  const planes = [];
  for (let k = 0; k < sides; k++) {
    const angle = (2 * Math.PI * k) / sides;
    planes.push(
      new Cesium.ClippingPlane(
        new Cesium.Cartesian3(Math.cos(angle), Math.sin(angle), 0),
        -apothem,
      ),
    );
  }
  return planes;
}

/**
 * Cesium's requests to the app's own server at most at once (its
 * RequestScheduler; it allows 18 a server, for HTTP/2). The page's server
 * speaks HTTP/1.1, where the browser opens six sockets a host, and the
 * tiles, the Earth Engine imagery and the app's own fetches share them:
 * with the tiles holding all six, the live region's values probe waited
 * 10.8 s at Lake Tahoe before it was even sent (2026-10-30). Two stay free.
 */
export const TILES_REQUESTS_PER_SERVER = 4;

/** Keep sockets free for the app's fetches (TILES_REQUESTS_PER_SERVER). */
export function reserveSockets(pageUrl = globalThis.location?.href) {
  if (!pageUrl) return null;
  let key;
  try {
    key = Cesium.RequestScheduler.getServerKey(pageUrl);
  } catch {
    return null;
  }
  const byServer = Cesium.RequestScheduler.requestsByServer;
  byServer[key] = Math.min(
    byServer[key] ?? Cesium.RequestScheduler.maximumRequestsPerServer,
    TILES_REQUESTS_PER_SERVER,
  );
  return key;
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
  createModel = createBlocksModel,
}) {
  const scene = viewer?.scene;
  reserveSockets();
  /** The pre-warm (prewarmPrograms): not yet, under way, or done. */
  let prewarm = 'not yet';
  /** Its Models while drawn, and their frame listener's remover. */
  let prewarmModels = [];
  let removePrewarmFrames = null;
  const endPrewarm = () => {
    removePrewarmFrames?.();
    removePrewarmFrames = null;
    for (const model of prewarmModels) scene?.primitives?.remove(model);
    prewarmModels = [];
    prewarm = 'done';
  };

  /**
   * Every Blocks program linked before the first flight: Cesium links a
   * Model's programs the first frame it draws, and waits for each link on
   * the main thread (getProgramParameter: 0.8 s at Lake Tahoe, 2026-10-30),
   * with one set for a Model its clipping planes cut (the live chunks, the
   * tiles about the hole) and one for the rest (the tiles the hole does not
   * reach), and the live batches' feature table and the tiles' apart. So at
   * the first Blocks status, three Models of a millimetre's ground and water
   * are drawn 10 m in front of the eye, and removed once they have drawn
   * (two frames after all are ready, or after PREWARM_FRAMES).
   */
  function prewarmPrograms() {
    if (prewarm !== 'not yet' || !scene?.primitives?.add) return;
    const eye = scene.camera?.positionWC;
    const ahead = scene.camera?.directionWC;
    if (!eye || !ahead) return;
    prewarm = 'under way';
    // 10 m in front of the eye: in the frustum and above the ground, so
    // nothing culls the draw (under the ground the globe occluded it, and
    // nothing was linked), and a millimetre there is a tenth of a pixel.
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.add(
        eye,
        Cesium.Cartesian3.multiplyByScalar(ahead, 10, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      ),
    );
    // The live chunks always carry the planes; the tiles with and without.
    Promise.all(
      [
        ['live', true],
        ['tile', true],
        ['tile', false],
      ].map(([schema, clipped]) =>
        createModel(prewarmBlocksGlb(schema), {
          modelMatrix,
          customShader: shader,
          clipped,
        }),
      ),
    )
      .then((models) => {
        if (destroyed) {
          for (const model of models) model.destroy?.();
          return;
        }
        for (const model of models) scene.primitives.add(model);
        prewarmModels = models;
        let frames = 0;
        let readyFrames = 0;
        removePrewarmFrames = scene.preRender?.addEventListener(() => {
          frames++;
          if (models.every((model) => model.ready !== false)) readyFrames++;
          requestRender();
          if (readyFrames >= 3 || frames >= PREWARM_FRAMES) endPrewarm();
        });
        requestRender();
      })
      .catch((error) => {
        prewarm = 'done';
        console.warn(
          '[Blocks] programs not pre-warmed:',
          error?.message || error,
        );
      });
  }
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
  let tileUnloads = 0;
  const unloadTrail = [];
  /** The hole the clipping planes were last set for, as JSON. */
  let clippedKey = null;
  /**
   * The hole about a camera found inside a tile ({lon, lat, radiusM}),
   * kept while the camera stays in it (the hole's own discard hides the
   * tile from the next sample), until the live chunks' hole opens.
   */
  let inside = null;
  let insideOpens = 0;

  /**
   * Whether the camera stands under the shown tiles' top (scene.sampleHeight
   * over the tileset), and if so the small hole that lets it see out: a wall
   * across the lens is worse than a small hole in the tiles.
   */
  function insideHole(tileset, at) {
    if (state?.mode !== 'hybrid' || !(at.height < INSIDE_CHECK_M)) {
      inside = null;
      return null;
    }
    const lon = Cesium.Math.toDegrees(at.longitude);
    const lat = Cesium.Math.toDegrees(at.latitude);
    if (inside) {
      const away = Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(lon, lat),
        Cesium.Cartesian3.fromDegrees(inside.lon, inside.lat),
      );
      if (away < inside.radiusM / 2) return inside;
      inside = null;
    }
    if (
      !scene?.sampleHeightSupported ||
      typeof scene?.sampleHeight !== 'function'
    )
      return null;
    let top;
    try {
      top = scene.sampleHeight(
        new Cesium.Cartographic(at.longitude, at.latitude),
        [tileset],
      );
    } catch {
      top = undefined;
    }
    if (!(Number.isFinite(top) && at.height < top)) return null;
    insideOpens++;
    inside = {
      lon,
      lat,
      radiusM: INSIDE_HOLE_BLOCKS * (Number(state.floorM) || 0),
    };
    return inside;
  }

  const requestRender = () => scene?.requestRender?.();

  /** Whether the camera is high (cameraHigh), with hysteresis. */
  let high = false;
  function updateHigh() {
    const heightM = scene?.camera?.positionCartographic?.height;
    if (Number.isFinite(heightM)) high = cameraHigh(heightM, high);
  }

  /** The guards let go: every tileset refines to its own error again. */
  function releaseGuard() {
    let released = false;
    for (const entry of loaded.values())
      if (entry.guard.release([entry.tileset])) released = true;
    if (released) requestRender();
  }
  const removeMoveStart =
    scene?.camera?.moveStart?.addEventListener(releaseGuard);
  const removeMoveEnd = scene?.camera?.moveEnd?.addEventListener(releaseGuard);

  function tilesetFor(url, box) {
    let entry = loaded.get(url);
    if (entry) return entry;
    updateHigh();
    const screenError = screenErrorFor(box, high);
    // Its cache guard (createCacheGuard), from its own error.
    entry = {
      tileset: null,
      box,
      screenError,
      guard: createCacheGuard(screenError),
    };
    loaded.set(url, entry);
    Promise.resolve()
      .then(() =>
        createTileset(url, {
          customShader: shader,
          maximumScreenSpaceError: entry.screenError,
          // Cesium's fog term takes up to 24 px off far tiles' error: from
          // 5,000 km the lower 48's roots then never refined, at any
          // maximumScreenSpaceError (worker1, docs/BLOCKS-PLAN.md).
          dynamicScreenSpaceError: false,
          // Cesium's own cache (512 MB, and 512 MB over it for a view).
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
        // Each tile unloaded (Cesium's cache trimming): counted, the last
        // few with the memory and error then, for the QA harness.
        tileset.tileUnload?.addEventListener(() => {
          tileUnloads++;
          unloadTrail.push({
            at: Math.round(now()),
            memoryMB: Math.round((tileset.totalMemoryUsageInBytes || 0) / 1e6),
            error: Number(tileset.memoryAdjustedScreenSpaceError) || null,
          });
          if (unloadTrail.length > 40) unloadTrail.shift();
        });
        // Culling the tiles under the live chunks (holePlanes), off until
        // there is a hole.
        tileset.clippingPlanes = blocksClippingPlanes();
        tileset.show = url === shownUrl;
        entry.tileset = tileset;
        clippedKey = null;
        scene?.primitives?.add(tileset);
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
    const place = scene?.camera?.positionCartographic;
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
    const shownEntry = loaded.get(shownUrl);
    const shown = shownEntry?.tileset;
    if (shown) {
      // A coarse tree's error by the camera's height (screenErrorFor).
      updateHigh();
      const screenError = screenErrorFor(shownEntry.box, high);
      if (screenError !== shownEntry.screenError) {
        shownEntry.screenError = screenError;
        shownEntry.guard = createCacheGuard(screenError);
        shown.maximumScreenSpaceError = screenError;
        requestRender();
      }
      shownEntry.guard.update(shown);
    }
    const at = scene?.camera?.positionCartographic;
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
    let hole = state.hole;
    if (hole?.radiusM > 0) inside = null;
    else if (shown && at) hole = insideHole(shown, at);
    const view = scene?.camera?.viewMatrix;
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
    if (shown) clip(shown, hole?.radiusM > 0 ? hole : null);
  }

  /**
   * The shown tileset's clipping planes set about the hole (holePlanes),
   * in its clipping origin's frame, or off with none; set again only when
   * the hole, the datum or the tileset changes.
   */
  function clip(tileset, hole) {
    const planes = tileset.clippingPlanes;
    if (!planes) return;
    const key = hole
      ? JSON.stringify([
          shownUrl,
          hole.lon,
          hole.lat,
          hole.radiusM,
          Number(state?.datumOffsetM) || 0,
        ])
      : null;
    if (key === clippedKey) return;
    clippedKey = key;
    // No hole: parked, not off (turning them on and off links new programs).
    planes.removeAll();
    if (!hole) {
      for (const plane of parkedPlanes()) planes.add(plane);
      planes.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
      return;
    }
    for (const plane of holePlanes(hole.radiusM)) planes.add(plane);
    const centre = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(
        hole.lon,
        hole.lat,
        Number(state?.datumOffsetM) || 0,
      ),
    );
    planes.modelMatrix = Cesium.Matrix4.multiply(
      Cesium.Matrix4.inverseTransformation(
        tileset.clippingPlanesOriginMatrix ?? Cesium.Matrix4.IDENTITY,
        new Cesium.Matrix4(),
      ),
      centre,
      new Cesium.Matrix4(),
    );
  }
  const removePreRender = scene?.preRender?.addEventListener(frame);

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
      // Blocks on (live or tiles): its programs linked before any flight.
      if (status && status.state !== 'off') prewarmPrograms();
      state = status?.tiles || null;
      const box = state ? boxes.find((each) => each.name === state.box) : null;
      shownUrl = box ? box.url({ buildings: buildings() !== false }) : null;
      if (shownUrl) tilesetFor(shownUrl, box);
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
        tileUnloads,
        unloadTrail: unloadTrail.slice(),
        // Cesium's counts this frame: the tiles drawn, and those with content.
        tilesSelected: shown?.statistics?.selected ?? null,
        tilesReady: shown?.statistics?.numberOfTilesWithContentReady ?? null,
        screenError: shown ? shown.maximumScreenSpaceError : null,
        heldError: loaded.get(shownUrl)?.guard.error ?? null,
        guardHolds: loaded.get(shownUrl)?.guard.steps ?? 0,
        // The hole about a camera inside a tile, and how often it opened.
        inside,
        insideOpens,
        // The hole's clipping planes on (the tiles inside it culled).
        clipped: clippedKey !== null,
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
      endPrewarm();
      removePreRender?.();
      removeMoveStart?.();
      removeMoveEnd?.();
      for (const entry of loaded.values())
        if (entry.tileset) scene?.primitives?.remove(entry.tileset);
      loaded.clear();
      requestRender();
    },
  };
  return api;
}
