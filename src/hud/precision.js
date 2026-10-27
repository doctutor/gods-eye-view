/**
 * Personal fork: how precisely the HUD's camera readout (src/hud.js) writes
 * each number, from what one pixel of the view covers on the ground and
 * from how fine the surface under the camera really is. Pure: the scene
 * measurements come from src/hud/cameraState.js. The share link
 * (src/sharelink.js) writes the camera at the same precision.
 *
 * The rule: a pixel's footprint is 2·d·tan(fov/2) / width, d the distance
 * from the camera to the surface at the screen's centre. A length is shown
 * to that footprint rounded down to a power of ten (10 km … 1 mm), and no
 * finer than the decimal place of the data floor, the resolution of the
 * surface under the camera (Google's 3D tiles 0.5 m, so 0.1 m; Cesium World
 * Terrain 10 m; Re:Earth's keyless terrain 30 m, so 10 m). Latitude and
 * longitude take the decimals whose step (0.1° ≈ 11 km … 0.000001° ≈
 * 0.11 m) resolves the larger of the two. Angles do not depend on height:
 * one pixel is fov / width, about 0.03° on a 2,000 px canvas, so heading,
 * pitch, roll and the field of view always show 2 decimals.
 */

import { formatNumber, t } from '../i18n/index.js';

/** Metres along a meridian per degree of latitude (WGS84, mean). */
export const METRES_PER_DEGREE = 111_320;
/** Cesium's default vertical-or-horizontal field of view. */
export const DEFAULT_FOV_DEG = 60;
/** The finest and coarsest length steps the readout uses. */
export const FINEST_STEP_M = 0.001;
export const COARSEST_STEP_M = 10_000;
/** Angles: 2 decimals, at any height. */
export const ANGLE_DECIMALS = 2;

/**
 * The surfaces a camera can stand over, by id: their resolution bounds
 * every number the readout shows. One table so a new source is one line.
 * `3dep-1m` is USGS 3DEP's 1 m lidar, for a surface made from it; today the
 * app drapes it as the Elevation layer's colours, not as the surface.
 */
export const DATA_FLOORS = Object.freeze({
  google: Object.freeze({ id: 'google', name: 'Google', floorM: 0.5 }),
  '3dep-1m': Object.freeze({ id: '3dep-1m', name: '3DEP 1 m', floorM: 1 }),
  world: Object.freeze({
    id: 'world',
    name: 'Cesium World Terrain',
    floorM: 10,
  }),
  keyless: Object.freeze({ id: 'keyless', name: 'Re:Earth', floorM: 30 }),
  flat: Object.freeze({ id: 'flat', name: 'Flat', floorM: 30 }),
});

/**
 * The surface under the camera, from what the map stack shows: Blocks'
 * cubes when Render: Blocks draws them (`blocksM`, the block size:
 * "Blocks 1 m", src/layers/blocks/); a shown 3D tileset is Google's
 * photoreal tiles; otherwise the globe's terrain, by the id
 * src/maps/terrain.js gives its providers (`world`, `keyless`), or a flat
 * ellipsoid.
 * @param {{tilesetShown?: boolean, terrainId?: string|null,
 *   blocksM?: number|null}} view
 * @returns {{id: string, name: string, floorM: number}}
 */
export function dataFloor({
  tilesetShown = false,
  terrainId = null,
  blocksM = null,
} = {}) {
  if (blocksM > 0)
    return Object.freeze({
      id: 'blocks',
      name: t('Blocks {size} m', { size: formatNumber(blocksM) }),
      floorM: blocksM,
    });
  if (tilesetShown) return DATA_FLOORS.google;
  return DATA_FLOORS[terrainId] || DATA_FLOORS.flat;
}

/**
 * What one pixel covers on the ground at the screen's centre, in metres.
 * @param {{distanceM: number, fovRad: number, widthPx: number}} view
 * @returns {number} NaN when the view cannot be measured
 */
export function pixelFootprintM({ distanceM, fovRad, widthPx }) {
  if (!(distanceM > 0) || !(fovRad > 0) || !(widthPx > 0)) return Number.NaN;
  return (2 * distanceM * Math.tan(fovRad / 2)) / widthPx;
}

/** A positive number rounded down to a power of ten. */
export function powerOfTenBelow(value) {
  return 10 ** Math.floor(Math.log10(value) + 1e-9);
}

/**
 * The step lengths are shown to: the footprint rounded down to a power of
 * ten, no finer than the floor's own decimal place, within 1 mm … 10 km.
 * An unmeasured footprint takes the floor's step.
 */
export function lengthStepM(footprintM, floorM = 0) {
  const floorStep = floorM > 0 ? powerOfTenBelow(floorM) : FINEST_STEP_M;
  const step =
    footprintM > 0
      ? Math.max(powerOfTenBelow(footprintM), floorStep)
      : floorStep;
  return Math.min(COARSEST_STEP_M, Math.max(FINEST_STEP_M, step));
}

/** Decimals a length step needs: 0 at 1 m and coarser, 1 at 0.1 m, … */
export function lengthDecimals(stepM) {
  return Math.max(0, Math.round(-Math.log10(stepM)));
}

/**
 * Decimals of a degree that resolve a length: the fewest whose step
 * (111 km × 10^-d) is no longer than it, 0 to 7.
 */
export function degreeDecimals(lengthM) {
  if (!(lengthM > 0)) return 4;
  for (let d = 0; d < 7; d++)
    if (METRES_PER_DEGREE * 10 ** -d <= lengthM) return d;
  return 7;
}

/**
 * MGRS digits per axis for a length step: 2 at 1 km (and coarser), 3 at
 * 100 m, 4 at 10 m, 5 at 1 m (and finer: MGRS stops at the metre).
 */
export function mgrsDigits(stepM) {
  return Math.min(
    5,
    Math.max(2, 5 - Math.round(Math.log10(Math.max(1, stepM)))),
  );
}

/** Decimals of an arcsecond (≈ 30.9 m) that resolve a length, 0 to 3. */
export function dmsSecondDecimals(lengthM) {
  const second = METRES_PER_DEGREE / 3600;
  for (let d = 0; d < 3; d++) if (second * 10 ** -d <= lengthM) return d;
  return 3;
}

/**
 * Everything the readout needs to write the camera at this view.
 * @param {{footprintM: number, floor?: {floorM: number}}} view
 * @returns {{footprintM: number, stepM: number, lengthDecimals: number,
 *   degreeDecimals: number, mgrsDigits: number, secondDecimals: number,
 *   angleDecimals: number, floor: object|null}}
 */
export function viewPrecision({ footprintM, floor = null }) {
  const floorM = floor?.floorM > 0 ? floor.floorM : 0;
  const stepM = lengthStepM(footprintM, floorM);
  const resolved = Math.max(footprintM > 0 ? footprintM : stepM, floorM);
  return {
    footprintM,
    stepM,
    lengthDecimals: lengthDecimals(stepM),
    degreeDecimals: degreeDecimals(resolved),
    mgrsDigits: mgrsDigits(stepM),
    secondDecimals: dmsSecondDecimals(resolved),
    angleDecimals: ANGLE_DECIMALS,
    floor,
  };
}

/** A length rounded to a step, written with the step's decimals. */
export function formatLength(valueM, stepM) {
  if (!Number.isFinite(valueM)) return '—';
  const rounded = Math.round(valueM / stepM) * stepM;
  return rounded.toFixed(lengthDecimals(stepM));
}

/** Two significant figures, in metres or kilometres: "0.42 m", "1.2 km". */
export function formatFootprint(metres) {
  if (!(metres > 0)) return '—';
  const km = metres >= 1000;
  const value = km ? metres / 1000 : metres;
  return `${Number(value.toPrecision(2))} ${km ? 'km' : 'm'}`;
}
