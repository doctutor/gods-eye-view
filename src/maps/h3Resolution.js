// Personal fork: one H3 resolution for a camera height, shared by every
// hex surface (the Countries basemap's hex style, the Wikipedia coverage
// layer's Hexes mode), the way Cesium's tiles pick their level from the
// camera. Pure: no H3, no Cesium.
//
// Sizing. Looking down with Cesium's 60° field of view, a canvas about 800
// px tall shows 1.15 camera heights of ground, so one pixel is about
// height / 700 metres. A resolution's hexes are √3 × their edge across
// (H3 v4 average edges: 1281, 483, 183, 69, 26, 9.9, 3.7, 1.4 km for
// resolutions 0 to 7). Each band below starts where its resolution's hexes
// would be about 58 px across and ends where they would be about 22 px,
// one H3 step (√7 ≈ 2.65 in size) later. Orbit is the exception: the whole
// planet fits the screen there, so resolution 0's 122 cells (about 100 px
// across at 20,000 km) are the right surface.

/** √3 × the average H3 edge length, km, by resolution (flat to flat). */
export const H3_HEX_ACROSS_KM = Object.freeze([
  2219, 837, 316, 119.5, 45.2, 17.1, 6.4, 2.44,
]);

/** Camera height (m) at or above which each resolution applies, high to low. */
export const H3_RESOLUTION_TABLE = Object.freeze([
  Object.freeze({ minHeightM: 18_000_000, res: 0, note: 'orbit' }),
  Object.freeze({ minHeightM: 11_200_000, res: 1 }),
  Object.freeze({ minHeightM: 4_240_000, res: 2 }),
  Object.freeze({ minHeightM: 1_600_000, res: 3 }),
  Object.freeze({ minHeightM: 603_000, res: 4 }),
  Object.freeze({ minHeightM: 228_000, res: 5 }),
  Object.freeze({ minHeightM: 86_000, res: 6 }),
  Object.freeze({ minHeightM: 0, res: 7, note: 'city scale' }),
]);

export const H3_MIN_RESOLUTION = 0;
export const H3_MAX_RESOLUTION = 7;

/** Ground metres per screen pixel at a camera height, looking down. */
export const METRES_PER_PIXEL_PER_HEIGHT = 1 / 700;

/**
 * The H3 resolution for a camera height.
 * @param {number} heightM Camera height above the ellipsoid, metres.
 * @returns {number} 0 (orbit) to 7 (city scale).
 */
export function h3ResolutionForHeight(heightM) {
  const height = Number.isFinite(heightM) ? heightM : Infinity;
  const row =
    H3_RESOLUTION_TABLE.find((entry) => height >= entry.minHeightM) ||
    H3_RESOLUTION_TABLE.at(-1);
  return row.res;
}

/**
 * How wide a resolution's hexes are on screen at a height, in pixels: what
 * the table aims to keep between about 20 and 60.
 */
export function hexPixelsAcross(res, heightM) {
  const acrossM = (H3_HEX_ACROSS_KM[res] ?? H3_HEX_ACROSS_KM.at(-1)) * 1000;
  return acrossM / (heightM * METRES_PER_PIXEL_PER_HEIGHT);
}

/** Clamp a resolution to the supported range. */
export function clampH3Resolution(res) {
  const value = Number.isInteger(res) ? res : H3_MIN_RESOLUTION;
  return Math.min(H3_MAX_RESOLUTION, Math.max(H3_MIN_RESOLUTION, value));
}
