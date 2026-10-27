/**
 * Personal fork: which surface hits on 3D tiles can be trusted.
 *
 * While Google's photoreal tiles stream in, Cesium draws and picks a coarse
 * ancestor tile until its children arrive, and that tile's chord can lie
 * far off the ground: +535 m over Baltimore (2026-10-27, the camera at
 * 80 m: AGL read −455.5 m, and Cesium's camera collision lifted the eye to
 * 536 m), −23.8 km under Lake Tahoe. A hit on a tile is trusted when the
 * tile is no coarser than Cesium itself would draw at that distance from
 * the camera (TILE_SSE_SLACK times the tileset's maximum screen-space
 * error, in pixels there), and always at TRUSTED_TILE_ERROR_M or finer
 * (Google's leaves are about 0.5–2 m). A hit on anything that is not a
 * tile (the globe, a model) is trusted as before.
 *
 * The HUD's AGL and centre distance (src/hud/cameraState.js), the arrival
 * ground guard (src/cameraGroundGuard.js) and Cesium's camera collision
 * (gateCollisionOnRefinedTiles) take only trusted hits.
 */
import * as Cesium from 'cesium';

/** A tile this fine is always trusted, metres of geometric error. */
export const TRUSTED_TILE_ERROR_M = 8;
/** How much coarser than Cesium's own refinement a trusted tile may be. */
export const TILE_SSE_SLACK = 2;
/** Cesium3DTileset's default maximumScreenSpaceError, pixels. */
const DEFAULT_MAXIMUM_SSE = 16;
/** Rays from above start here: no surface is higher (sampleHeight's 9 km). */
export const ABOVE_SURFACES_M = 9000;

/** The 3D tile a pick hit, from Cesium's pick object, or null. */
export function pickedTile(object) {
  const tile = object?.content?.tile ?? object?.tile ?? null;
  return tile && Number.isFinite(tile.geometricError) ? tile : null;
}

/** A CSS pixel's footprint in metres at a distance, across the wider side. */
function footprintAtM(viewer, distanceM) {
  const fov = viewer?.camera?.frustum?.fov;
  const canvas = viewer?.scene?.canvas;
  const span = Math.max(
    Number(canvas?.clientWidth) || Number(canvas?.width) || 0,
    Number(canvas?.clientHeight) || Number(canvas?.height) || 0,
  );
  if (!(distanceM > 0) || !(fov > 0) || !(span > 0)) return 0;
  return (2 * distanceM * Math.tan(fov / 2)) / span;
}

/**
 * The coarsest geometric error trusted at a distance from the camera:
 * TILE_SSE_SLACK × the tileset's maximum screen-space error × a pixel's
 * footprint there, never below TRUSTED_TILE_ERROR_M.
 */
export function allowedTileErrorM(viewer, distanceM, tileset = null) {
  const sse = Number(tileset?.maximumScreenSpaceError);
  const maximumSse = sse > 0 ? sse : DEFAULT_MAXIMUM_SSE;
  return Math.max(
    TRUSTED_TILE_ERROR_M,
    TILE_SSE_SLACK * maximumSse * footprintAtM(viewer, distanceM),
  );
}

/**
 * Whether a tile hit `distanceM` from the camera is trusted, with the
 * tile's error and the error allowed there.
 */
export function judgeTile(viewer, tile, distanceM, tileset = tile?.tileset) {
  const tileErrorM = Number(tile?.geometricError);
  const allowedM = allowedTileErrorM(viewer, distanceM, tileset);
  return {
    tileErrorM,
    allowedM,
    trusted: Number.isFinite(tileErrorM) && tileErrorM <= allowedM,
  };
}

/**
 * A scene.pickFromRay result judged: its position, the hit tile's error
 * (null off the tiles) and whether it is trusted; null on a miss.
 */
export function judgeHit(viewer, picked, cesium = Cesium) {
  const position = picked?.position ?? null;
  if (!position) return null;
  const tile = pickedTile(picked.object);
  if (!tile)
    return { position, tileErrorM: null, allowedM: null, trusted: true };
  const origin = viewer?.camera?.positionWC;
  const distanceM = origin ? cesium.Cartesian3.distance(origin, position) : 0;
  const tileset = picked.object?.primitive ?? tile.tileset;
  return { position, ...judgeTile(viewer, tile, distanceM, tileset) };
}

/** The first hit of a ray through the scene, judged; null on a miss. */
export function judgedRayHit(viewer, ray, cesium = Cesium) {
  const scene = viewer?.scene;
  if (!ray || typeof scene?.pickFromRay !== 'function') return null;
  try {
    return judgeHit(viewer, scene.pickFromRay(ray, []), cesium);
  } catch {
    return null;
  }
}

/** A ray straight down onto a place from above every surface. */
export function rayFromAbove(lat, lon, cesium = Cesium) {
  const origin = cesium.Cartesian3.fromDegrees(lon, lat, ABOVE_SURFACES_M);
  const normal = cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    origin,
    new cesium.Cartesian3(),
  );
  return new cesium.Ray(
    origin,
    cesium.Cartesian3.negate(normal, new cesium.Cartesian3()),
  );
}

const heightOf = (position, cesium) => {
  try {
    return cesium.Cartographic.fromCartesian(position)?.height ?? Number.NaN;
  } catch {
    return Number.NaN;
  }
};

const sampleScratch = new Cesium.Cartographic();

/**
 * The rendered surface's height at a place, cast from above as Cesium's
 * sampleHeight casts it but through scene.pickFromRay, so the hit's tile
 * is known and judged (`above`). Where the scene cannot pick from a ray,
 * sampleHeight itself (`sample`, unjudged). NaN on a miss or a coarse tile.
 * @returns {{heightM: number, via: string|null, trusted: boolean,
 *   tileErrorM: number|null, rawHeightM: number}}
 */
export function surfaceAt(viewer, lat, lon, cesium = Cesium) {
  const scene = viewer?.scene;
  const none = {
    heightM: Number.NaN,
    via: null,
    trusted: false,
    tileErrorM: null,
    rawHeightM: Number.NaN,
  };
  if (!scene) return none;
  if (typeof scene.pickFromRay === 'function') {
    const hit = judgedRayHit(viewer, rayFromAbove(lat, lon, cesium), cesium);
    if (!hit) return none;
    const rawHeightM = heightOf(hit.position, cesium);
    return {
      heightM: hit.trusted ? rawHeightM : Number.NaN,
      via: 'above',
      trusted: hit.trusted,
      tileErrorM: hit.tileErrorM,
      rawHeightM,
    };
  }
  if (typeof scene.sampleHeight !== 'function') return none;
  if (scene.sampleHeightSupported === false) return none;
  try {
    const height = scene.sampleHeight(
      cesium.Cartographic.fromDegrees(lon, lat, 0, sampleScratch),
    );
    if (!Number.isFinite(height)) return none;
    return {
      heightM: height,
      via: 'sample',
      trusted: true,
      tileErrorM: null,
      rawHeightM: height,
    };
  } catch {
    return none;
  }
}

/** Every shown 3D tileset Cesium's collision measures (enableCollision). */
export function collisionTilesets(primitives, found = []) {
  const length = Number(primitives?.length) || 0;
  for (let i = 0; i < length; i += 1) {
    const primitive = primitives.get(i);
    if (primitive?.isCesium3DTileset) {
      if (primitive.show && primitive.enableCollision) found.push(primitive);
    } else if (typeof primitive?.get === 'function') {
      collisionTilesets(primitive, found);
    }
  }
  return found;
}

const columnRay = new Cesium.Ray();
const columnHitScratch = new Cesium.Cartesian3();

/**
 * Where a tileset's drawn tiles meet the vertical at a place, and which
 * tile: Cesium3DTileset.getHeight's ray and its pick over the selected
 * tiles, the tile kept (Cesium returns only the point). Null on a miss.
 */
export function columnHit(tileset, cartographic, scene, cesium = Cesium) {
  const tiles = tileset?._selectedTiles;
  const frameState = scene?.frameState;
  if (!Array.isArray(tiles) || !frameState) return null;
  const ellipsoid = scene.ellipsoid ?? cesium.Ellipsoid.WGS84;
  const surface = ellipsoid.cartographicToCartesian(
    new cesium.Cartographic(cartographic.longitude, cartographic.latitude, 0),
  );
  const ray = columnRay;
  cesium.Cartesian3.negate(
    cesium.Cartesian3.normalize(surface, ray.direction),
    ray.direction,
  );
  cesium.Cartesian3.multiplyByScalar(
    ray.direction,
    -2 * ellipsoid.maximumRadius,
    ray.origin,
  );
  const candidates = [];
  for (const tile of tiles) {
    const sphere = tile?.contentBoundingVolume?.boundingSphere;
    if (!sphere || typeof tile.content?.pick !== 'function') continue;
    if (cesium.IntersectionTests.raySphere(ray, sphere)) candidates.push(tile);
  }
  const away = (tile) =>
    cesium.BoundingSphere.distanceSquaredTo(
      tile.contentBoundingVolume.boundingSphere,
      ray.origin,
    );
  candidates.sort((a, b) => away(a) - away(b));
  for (const tile of candidates) {
    let position;
    try {
      position = tile.content.pick(ray, frameState, columnHitScratch);
    } catch {
      position = undefined;
    }
    if (position) return { position: cesium.Cartesian3.clone(position), tile };
  }
  return null;
}

/**
 * The height Cesium's camera collision may keep the eye above: the highest
 * trusted tileset surface under the camera, or the shown globe's; undefined
 * while only coarse tiles answer there.
 */
export function trustedCollisionHeightM(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  const carto = viewer?.camera?.positionCartographic;
  if (!scene || !carto) return undefined;
  let best = Number.NEGATIVE_INFINITY;
  for (const tileset of collisionTilesets(scene.primitives)) {
    const hit = columnHit(tileset, carto, scene, cesium);
    if (!hit) continue;
    const heightM = heightOf(hit.position, cesium);
    if (!Number.isFinite(heightM)) continue;
    const { trusted } = judgeTile(
      viewer,
      hit.tile,
      Math.abs(carto.height - heightM),
      tileset,
    );
    if (trusted && heightM > best) best = heightM;
  }
  const globe = scene.globe;
  if (globe?.show && typeof globe.getHeight === 'function') {
    const heightM = globe.getHeight(carto);
    if (Number.isFinite(heightM) && heightM > best) best = heightM;
  }
  return best > Number.NEGATIVE_INFINITY ? best : undefined;
}

/**
 * How many frames a still camera's collision height is kept before it is
 * measured again (a tile may have arrived under it).
 */
export const COLLISION_REFRESH_FRAMES = 10;

/** A property's descriptor from an object or the first prototype that has it. */
function findDescriptor(object, name) {
  for (let at = object; at; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor) return descriptor;
  }
  return null;
}

/**
 * Cesium's camera collision (ScreenSpaceCameraController with
 * enableCollision on the Google tileset) keeps the eye minimumZoomDistance
 * above scene.globeHeight, which it measures on whatever tile is drawn
 * under the camera: over Baltimore a coarse tile's +535 m lifted a camera
 * at 80 m to 536 m, and it stayed there. This answers globeHeight from
 * trusted tiles only (trustedCollisionHeightM: again when the camera
 * moves, else every COLLISION_REFRESH_FRAMES for tiles arriving), so the
 * collision waits for the leaves. Returns the undo.
 */
export function gateCollisionOnRefinedTiles(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  if (!scene || Object.hasOwn(scene, 'globeHeight')) return () => {};
  const cesiumHeight = findDescriptor(scene, 'globeHeight');
  if (typeof cesiumHeight?.get !== 'function') return () => {};
  let held = null;
  Object.defineProperty(scene, 'globeHeight', {
    configurable: true,
    get() {
      // Nothing measured by Cesium: nothing to gate.
      if (cesiumHeight.get.call(scene) === undefined) return undefined;
      const frame = scene.frameState?.frameNumber;
      const at = viewer.camera?.positionWC;
      if (
        held &&
        frame !== undefined &&
        at &&
        held.x === at.x &&
        held.y === at.y &&
        held.z === at.z &&
        frame >= held.frame &&
        frame - held.frame < COLLISION_REFRESH_FRAMES
      )
        return held.heightM;
      let heightM;
      try {
        heightM = trustedCollisionHeightM(viewer, cesium);
      } catch {
        heightM = cesiumHeight.get.call(scene);
      }
      held = { frame, x: at?.x, y: at?.y, z: at?.z, heightM };
      return heightM;
    },
  });
  return () => {
    if (Object.hasOwn(scene, 'globeHeight')) delete scene.globeHeight;
  };
}
