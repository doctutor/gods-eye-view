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

/**
 * Metres from the camera to the rendered surface at the screen's centre:
 * the depth buffer's position there (3D tiles and terrain alike), else the
 * globe hit along the centre ray, else the camera's height above the
 * ellipsoid (looking at the sky, or nothing drawn yet).
 * @returns {{distanceM: number, hit: boolean}}
 */
export function centreDistanceM(viewer, cesium = Cesium) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  const fallback = {
    distanceM: Math.max(1, camera?.positionCartographic?.height ?? NaN),
    hit: false,
  };
  const canvas = scene?.canvas;
  if (!scene || !camera || !canvas) return fallback;
  centreScratch.x = (canvas.clientWidth || canvas.width) / 2;
  centreScratch.y = (canvas.clientHeight || canvas.height) / 2;
  let hit = null;
  try {
    if (scene.pickPositionSupported) hit = scene.pickPosition(centreScratch);
  } catch {
    hit = null;
  }
  if (!hit && scene.globe?.show !== false) {
    try {
      const ray = camera.getPickRay(centreScratch);
      hit = ray ? scene.globe.pick(ray, scene) : null;
    } catch {
      hit = null;
    }
  }
  if (!hit) return fallback;
  const distanceM = cesium.Cartesian3.distance(camera.positionWC, hit);
  return Number.isFinite(distanceM) && distanceM > 0
    ? { distanceM, hit: true }
    : fallback;
}

/**
 * The rendered surface's height above the ellipsoid at a place, as the
 * camera ground guard samples it (src/cameraGroundGuard.js): NaN until the
 * tiles there have streamed in.
 */
export function surfaceHeightM(viewer, lat, lon, cesium = Cesium) {
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
