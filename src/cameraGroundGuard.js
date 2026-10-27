/**
 * Camera ground guard: never leave an arrival buried in, or pressed against,
 * the rendered surface.
 *
 * Arrival framing is computed before the destination's tiles exist, so it has
 * to predict the ground height. `globe.getHeight()` answers nothing while the
 * globe is hidden under photoreal tiles, curated `groundElevation` presets
 * cover only a few cities, and the elevation service resolves asynchronously.
 * A missing prediction used to fall back to sea level, which buried the eye by
 * roughly the local elevation (Denver ~1,600 m; Austin ~170 m).
 *
 * After the flight lands and tiles have streamed in, this module measures the
 * rendered surface under the framed target and under the camera itself, and
 * lifts the eye if it sits below a usable clearance. Heading and pitch are
 * held, so the correction reads as the shot settling.
 *
 * Personal fork: a surface measured on a tile coarser than the view trusts
 * (src/surfaceTrust.js) is not the ground: while Google's leaves stream in,
 * a coarse ancestor's chord can lie hundreds of metres off it (+535 m over
 * Baltimore, 2026-10-27). Such an answer is waited out, for up to
 * GUARD_REFINE_WAIT_MS, without spending an attempt.
 */
import * as Cesium from 'cesium';
import { ownCameraArrival } from './data/cameraArrival.js';
import { surfaceAt } from './surfaceTrust.js';

/** Minimum eye height above the rendered surface for a usable view. */
export const MIN_EYE_CLEARANCE_M = 120;
/** Retries while tiles stream in; sampling fails until the mesh exists. */
export const GUARD_ATTEMPTS = 8;
export const GUARD_INTERVAL_MS = 600;
/** Personal fork: how long coarse-tile answers are waited out. */
export const GUARD_REFINE_WAIT_MS = 15_000;
/** Ignore sub-metre noise rather than nudging the camera forever. */
const GUARD_EPSILON_M = 2;

/**
 * Highest rendered surface across a few cells, with how many cells answered
 * and how many answered from a tile too coarse to trust. A cell whose tiles
 * are not streamed yet, or only coarsely, contributes nothing.
 * @param {Cesium.Viewer} viewer Live viewer.
 * @param {Array<{lat: number, lon: number}>} cells Cells to probe.
 * @returns {{heightM: number, sampled: number, coarse: number}} Reading.
 */
function sampleSurfaceM(viewer, cells) {
  let heightM = Number.NaN;
  let sampled = 0;
  let coarse = 0;
  for (const cell of cells) {
    let reading;
    try {
      reading = surfaceAt(viewer, cell.lat, cell.lon);
    } catch {
      continue; // tiles not ready for this cell
    }
    if (reading.via && !reading.trusted) coarse += 1;
    const height = reading.heightM;
    if (!Number.isFinite(height)) continue;
    sampled += 1;
    heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
  }
  return { heightM, sampled, coarse };
}

/**
 * How far the camera must rise to clear the ground, given a measured surface.
 * Pure so the policy is testable without a scene.
 * @param {number} cameraHeightM Eye height above the ellipsoid.
 * @param {number} groundHeightM Measured surface height above the ellipsoid.
 * @param {number} [clearanceM] Desired eye height above that surface.
 * @returns {number} Metres to lift; 0 when the view is already clear.
 */
export function groundClearanceDeficitM(
  cameraHeightM,
  groundHeightM,
  clearanceM = MIN_EYE_CLEARANCE_M,
) {
  if (!Number.isFinite(cameraHeightM) || !Number.isFinite(groundHeightM))
    return 0;
  const deficit = groundHeightM + clearanceM - cameraHeightM;
  return deficit > GUARD_EPSILON_M ? deficit : 0;
}

/**
 * Watch an arrival and lift the camera once the real surface can be measured.
 *
 * Stops quietly on a clear view, exhausted attempts, the user taking the
 * controls (pointer or wheel on the canvas), or `isStale()` reporting that a
 * newer arrival owns the camera.
 * @param {Cesium.Viewer} viewer Live viewer.
 * @param {{lat: number, lon: number}} at Destination being framed.
 * @param {{clearanceM?: number, attempts?: number, intervalMs?: number,
 *   isStale?: () => boolean, onLift?: (liftM: number) => void}} [options]
 * @returns {() => void} Cancel function.
 */
export function guardCameraAboveGround(viewer, at, options = {}) {
  const {
    clearanceM = MIN_EYE_CLEARANCE_M,
    attempts = GUARD_ATTEMPTS,
    intervalMs = GUARD_INTERVAL_MS,
    refineWaitMs = GUARD_REFINE_WAIT_MS,
    isStale = () => false,
    onLift = null,
  } = options;
  if (!viewer?.scene || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
    return () => {};

  let timer = null;
  let done = false;
  const canvas = viewer.scene.canvas;
  const documentRef = canvas?.ownerDocument;
  const removers = [];
  let release = () => {};
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const type of ['pointerdown', 'wheel'])
      canvas?.removeEventListener?.(type, stop);
    documentRef?.removeEventListener?.('keydown', stop, true);
    for (const remove of removers) remove();
    release();
  };
  release = ownCameraArrival(viewer, stop);
  // Direct camera API callers (including duration-zero flights) must yield
  // before moving the eye. Restore the exact method ownership on completion.
  for (const name of [
    'flyTo',
    'flyToBoundingSphere',
    'setView',
    'lookAt',
    'cancelFlight',
  ]) {
    const camera = viewer.camera;
    const original = camera[name];
    if (typeof original !== 'function') continue;
    const descriptor = Object.getOwnPropertyDescriptor(camera, name);
    const wrapped = function (...args) {
      stop();
      return original.apply(this, args);
    };
    camera[name] = wrapped;
    removers.push(() => {
      if (camera[name] !== wrapped) return;
      if (descriptor) Object.defineProperty(camera, name, descriptor);
      else delete camera[name];
    });
  }
  const removeTracking = viewer.trackedEntityChanged?.addEventListener(stop);
  if (removeTracking) removers.push(removeTracking);
  documentRef?.addEventListener?.('keydown', stop, true);
  // A manual gesture ends the guard, as it interrupts camera motion elsewhere.
  for (const type of ['pointerdown', 'wheel'])
    canvas?.addEventListener?.(type, stop, { once: true, passive: true });

  let remaining = attempts;
  const startedAt = Date.now();
  const attempt = () => {
    if (done) return;
    if (isStale() || viewer.isDestroyed?.()) return stop();
    const camera = viewer.camera;
    const carto = camera.positionCartographic;
    // The eye must clear both the framed target and the ground beneath it.
    const below = {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
    const { heightM, sampled, coarse } = sampleSurfaceM(viewer, [
      { lat: at.lat, lon: at.lon },
      below,
    ]);
    // Only coarse tiles answered: wait for the leaves, not spending an
    // attempt, for up to refineWaitMs.
    if (!(coarse > 0 && Date.now() - startedAt < refineWaitMs)) remaining -= 1;
    if (sampled > 0 && Number.isFinite(heightM)) {
      const deficit = groundClearanceDeficitM(
        carto.height,
        heightM,
        clearanceM,
      );
      if (deficit > 0) {
        stop();
        camera.flyTo({
          destination: Cesium.Cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            carto.height + deficit,
          ),
          orientation: {
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll,
          },
          duration: 0.9,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        });
        try {
          onLift?.(deficit);
        } catch {
          /* observer only */
        }
      }
      // Both samples answered (from fine tiles): the surface is measured,
      // nothing left to wait for.
      if (sampled === 2 || deficit > 0) return stop();
    }
    if (remaining <= 0) return stop();
    timer = setTimeout(attempt, intervalMs);
  };
  timer = setTimeout(attempt, intervalMs);
  return stop;
}
