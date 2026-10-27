/**
 * Personal fork: the camera's whole view state, the seven numbers that fix
 * what is on screen (lon, lat, height, heading, pitch, roll, field of
 * view), read from and written to a Cesium viewer; and what the view
 * stands over: the distance to the surface at the screen's centre and the
 * surface's height under the camera. The HUD's camera readout uses them
 * (src/hud.js, src/hud/cameraReadout.js); kept apart from the HUD so an
 * eye-level mode can set height above the surface and the field of view
 * the same way.
 */
import * as Cesium from 'cesium';
import { DEFAULT_FOV_DEG } from './precision.js';

/** The field of view a camera can be given, degrees. */
export const MIN_FOV_DEG = 1;
export const MAX_FOV_DEG = 150;

/**
 * Heights no rendered surface lies outside (the Dead Sea's shore is −430 m,
 * Everest 8,849 m): a "surface" measured outside them is a miss (a coarse
 * tile's chord, a shell or the sky), not the ground. Over Lake Tahoe a
 * camera 4 m above the water once read AGL 25,700 m from a sample at
 * −23.8 km.
 */
export const SURFACE_MIN_M = -500;
export const SURFACE_MAX_M = 9000;
export const plausibleSurfaceM = (heightM) =>
  Number.isFinite(heightM) &&
  heightM >= SURFACE_MIN_M &&
  heightM <= SURFACE_MAX_M;

const centreScratch = new Cesium.Cartesian2();
const cartoScratch = new Cesium.Cartographic();

/**
 * The view state now: degrees and metres, `heightM` above the WGS84
 * ellipsoid (what Cesium keeps), `fovDeg` across the wider side of the
 * screen (Cesium's PerspectiveFrustum.fov), null when the camera has no
 * place yet.
 */
export function readCameraView(viewer, cesium = Cesium) {
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!carto) return null;
  const fov = camera.frustum?.fov;
  return {
    lon: cesium.Math.toDegrees(carto.longitude),
    lat: cesium.Math.toDegrees(carto.latitude),
    heightM: carto.height,
    headingDeg: cesium.Math.toDegrees(camera.heading),
    pitchDeg: cesium.Math.toDegrees(camera.pitch),
    rollDeg: cesium.Math.toDegrees(camera.roll),
    fovDeg: Number.isFinite(fov) ? cesium.Math.toDegrees(fov) : DEFAULT_FOV_DEG,
  };
}

/**
 * Set the whole view at once, so the numbers not changed hold. The field
 * of view goes on the frustum (a camera move does not touch it).
 */
export function applyCameraView(viewer, view, cesium = Cesium) {
  const camera = viewer.camera;
  if (Number.isFinite(view.fovDeg) && camera.frustum && 'fov' in camera.frustum)
    camera.frustum.fov = cesium.Math.toRadians(view.fovDeg);
  camera.setView({
    destination: cesium.Cartesian3.fromDegrees(
      view.lon,
      view.lat,
      view.heightM,
    ),
    orientation: {
      heading: cesium.Math.toRadians(view.headingDeg),
      pitch: cesium.Math.toRadians(view.pitchDeg),
      roll: cesium.Math.toRadians(view.rollDeg),
    },
  });
  viewer.scene?.requestRender?.();
}

/**
 * The canvas size in CSS pixels, the wider side first: Cesium's fov spans
 * the wider side, so a pixel's footprint is measured across it.
 */
export function canvasSpanPx(viewer) {
  const canvas = viewer?.scene?.canvas;
  const width = Number(canvas?.clientWidth) || Number(canvas?.width) || 0;
  const height = Number(canvas?.clientHeight) || Number(canvas?.height) || 0;
  return Math.max(width, height);
}

const heightOf = (position, cesium) => {
  if (!position) return Number.NaN;
  try {
    return cesium.Cartographic.fromCartesian(position)?.height ?? Number.NaN;
  } catch {
    return Number.NaN;
  }
};

/** The first hit of a ray through the scene (primitives and globe), or null. */
function rayHit(scene, ray) {
  if (!ray || typeof scene?.pickFromRay !== 'function') return null;
  try {
    return scene.pickFromRay(ray, [])?.position ?? null;
  } catch {
    return null;
  }
}

/** The canvas's centre in window coordinates (CSS pixels, as picks take). */
function canvasCentre(canvas, result) {
  result.x = (canvas.clientWidth || canvas.width) / 2;
  result.y = (canvas.clientHeight || canvas.height) / 2;
  return result;
}

/** A ray straight down from the camera. */
function downRay(camera, cesium) {
  const origin = camera.positionWC;
  if (!origin) return null;
  const normal = cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    origin,
    new cesium.Cartesian3(),
  );
  if (!normal) return null;
  return new cesium.Ray(
    origin,
    cesium.Cartesian3.negate(normal, new cesium.Cartesian3()),
  );
}

/**
 * Metres from the camera to the rendered surface at the screen's centre,
 * and which way it was measured: the depth buffer there (`depth`), else a
 * ray through the scene's primitives and globe (`ray`: the Google tileset
 * is a primitive, and the globe is hidden under it), else the globe alone
 * (`globe`), else the camera's height above the ellipsoid (`height`:
 * looking at the sky, or nothing measured). A hit off every plausible
 * surface is not taken. The centre is in CSS pixels, the window
 * coordinates Cesium's picks take (they scale by the pixel ratio).
 * @returns {{distanceM: number, hit: boolean, via: string}}
 */
export function centreDistanceM(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const fallback = {
    distanceM: Math.max(1, camera?.positionCartographic?.height ?? NaN),
    hit: false,
    via: 'height',
  };
  const canvas = scene?.canvas;
  if (!scene || !camera || !canvas) return fallback;
  const centre = canvasCentre(canvas, centreScratch);
  const taken = (position, via) => {
    if (!position || !plausibleSurfaceM(heightOf(position, cesium)))
      return null;
    const distanceM = cesium.Cartesian3.distance(camera.positionWC, position);
    return Number.isFinite(distanceM) && distanceM > 0
      ? { distanceM, hit: true, via }
      : null;
  };
  let found = null;
  try {
    if (scene.pickPositionSupported)
      found = taken(scene.pickPosition(centre), 'depth');
  } catch {
    found = null;
  }
  if (found) return found;
  let ray = null;
  try {
    ray = camera.getPickRay(centre);
  } catch {
    ray = null;
  }
  if (!ray) return fallback;
  found = taken(rayHit(scene, ray), 'ray');
  if (!found && scene.globe?.show !== false)
    try {
      found = taken(scene.globe.pick(ray, scene), 'globe');
    } catch {
      found = null;
    }
  return found || fallback;
}

/** Cesium's sampleHeight at a place, as the ground guard samples it. */
export function sampledHeightM(viewer, lat, lon, cesium = Cesium) {
  const scene = viewer?.scene;
  if (typeof scene?.sampleHeight !== 'function') return Number.NaN;
  if (scene.sampleHeightSupported === false) return Number.NaN;
  try {
    const height = scene.sampleHeight(
      cesium.Cartographic.fromDegrees(lon, lat, 0, cartoScratch),
    );
    return Number.isFinite(height) ? height : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** The shown globe's loaded terrain height at a place. */
export function globeHeightM(viewer, lat, lon, cesium = Cesium) {
  const globe = viewer?.scene?.globe;
  if (!globe || globe.show === false || typeof globe.getHeight !== 'function')
    return Number.NaN;
  try {
    const height = globe.getHeight(
      cesium.Cartographic.fromDegrees(lon, lat, 0, cartoScratch),
    );
    return Number.isFinite(height) ? height : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * The rendered surface's height above the ellipsoid under the camera, and
 * how it was found: a ray straight down from the camera through the scene
 * (`down`: from the camera, so it meets the tiles the view loaded near it),
 * else Cesium's sampleHeight (`sample`: its ray starts 9 km up, and can
 * meet coarser tiles), else the shown globe's terrain (`globe`). The first
 * plausible answer wins; NaN until one is.
 * @returns {{heightM: number, via: string|null}}
 */
export function surfaceUnderCamera(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!scene || !camera?.positionWC || !carto)
    return { heightM: Number.NaN, via: null };
  try {
    const heightM = heightOf(rayHit(scene, downRay(camera, cesium)), cesium);
    if (plausibleSurfaceM(heightM)) return { heightM, via: 'down' };
  } catch {
    /* no ray: the next way */
  }
  const lat = cesium.Math.toDegrees(carto.latitude);
  const lon = cesium.Math.toDegrees(carto.longitude);
  const sampled = sampledHeightM(viewer, lat, lon, cesium);
  if (plausibleSurfaceM(sampled)) return { heightM: sampled, via: 'sample' };
  const globe = globeHeightM(viewer, lat, lon, cesium);
  if (plausibleSurfaceM(globe)) return { heightM: globe, via: 'globe' };
  return { heightM: Number.NaN, via: null };
}

/**
 * Every way of measuring the view, raw and unfiltered, beside the answers
 * the readout uses: for a check in a live tab
 * (`window.__gevHudCamera.diagnostics()`, src/hud.js).
 */
export function viewDiagnostics(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!scene || !carto) return null;
  const lat = cesium.Math.toDegrees(carto.latitude);
  const lon = cesium.Math.toDegrees(carto.longitude);
  const canvas = scene.canvas;
  const centre = canvasCentre(canvas, new cesium.Cartesian2());
  const distance = (position) =>
    position ? cesium.Cartesian3.distance(camera.positionWC, position) : null;
  let picked = null;
  try {
    picked = scene.pickPositionSupported ? scene.pickPosition(centre) : null;
  } catch {
    picked = null;
  }
  let ray = null;
  try {
    ray = camera.getPickRay(centre);
  } catch {
    ray = null;
  }
  const centreHit = rayHit(scene, ray);
  const downHit = rayHit(scene, downRay(camera, cesium));
  return {
    camera: { lat, lon, heightM: carto.height },
    canvas: {
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      bufferWidth: scene.drawingBufferWidth,
      pixelRatio: scene.pixelRatio,
    },
    globeShown: scene.globe?.show !== false,
    pickPositionSupported: scene.pickPositionSupported,
    sampleHeightSupported: scene.sampleHeightSupported,
    centre: {
      pickPositionM: distance(picked),
      pickPositionHeightM: heightOf(picked, cesium),
      rayM: distance(centreHit),
      rayHeightM: heightOf(centreHit, cesium),
    },
    surface: {
      downHeightM: heightOf(downHit, cesium),
      sampleHeightM: sampledHeightM(viewer, lat, lon, cesium),
      globeHeightM: globeHeightM(viewer, lat, lon, cesium),
    },
    used: {
      centre: centreDistanceM(viewer, cesium),
      surface: surfaceUnderCamera(viewer, cesium),
    },
  };
}
