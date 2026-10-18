// Personal fork: the pure parts of a point rollup. A point layer's pins,
// binned into H3 cells at the resolution the camera height implies, with
// the rule that decides when the rollup replaces the pins and the shape of
// the count labels. No Cesium here except the Cartesian3 a caller hands in.

import { latLngToCell } from 'h3-js';
import { cellCentre, cellRing } from '../../maps/h3Cells.js';
import { clampH3Resolution } from '../../maps/h3Resolution.js';

/** The rollup replaces the pins when more than this many are in the view window… */
export const ROLLUP_ENTER_COUNT = 400;
/** …and gives them back when fewer than this many are: hysteresis, no flicker. */
export const ROLLUP_EXIT_COUNT = 250;
/** Above this camera height the rollup replaces the pins however few… */
export const ROLLUP_ENTER_HEIGHT_M = 300_000;
/** …until the camera comes back below this one (hysteresis again). */
export const ROLLUP_EXIT_HEIGHT_M = 250_000;
/** Below this camera height the pins always show, however many. */
export const ROLLUP_MIN_HEIGHT_M = 30_000;
/** The faintest and the fullest cell alpha of the log ramp. */
export const ROLLUP_ALPHA_MIN = 0.25;
export const ROLLUP_ALPHA_MAX = 0.85;

/** A finite lat/lon pair. */
const located = (point) =>
  Number.isFinite(point?.lat) &&
  Number.isFinite(point?.lon) &&
  Math.abs(point.lat) <= 90;

/**
 * Whether a point lies in a view window (maps/h3Cells.js viewWindow); a
 * window with west > east crosses the antimeridian, null is the planet.
 */
export function pointInWindow(window, lat, lon) {
  if (!window) return true;
  if (lat < window.south || lat > window.north) return false;
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  return window.west <= window.east
    ? x >= window.west && x <= window.east
    : x >= window.west || x <= window.east;
}

/** How many of the points are in the window. */
export function countInWindow(points, window) {
  let count = 0;
  for (const point of points || [])
    if (located(point) && pointInWindow(window, point.lat, point.lon)) count++;
  return count;
}

/**
 * Bin the points in the window into cells of a resolution.
 * @param {Array<{lat: number, lon: number}>} points
 * @param {number} res
 * @param {object | null} window
 * @returns {Map<string, number>} cell → count, insertion order by first point.
 */
export function binPoints(points, res, window = null) {
  const resolution = clampH3Resolution(res);
  const bins = new Map();
  for (const point of points || []) {
    if (!located(point) || !pointInWindow(window, point.lat, point.lon))
      continue;
    const cell = latLngToCell(point.lat, point.lon, resolution);
    bins.set(cell, (bins.get(cell) || 0) + 1);
  }
  return bins;
}

/**
 * Whether the rollup should replace the pins: on past the enter count or
 * above the enter height, off again only below both the exit count and the
 * exit height, never below the minimum height. An `enterHeightM` of
 * Infinity leaves the decision to the count alone.
 * @param {{ heightM: number, inView: number, active: boolean }} state
 * @param {{ enter?: number, exit?: number, enterHeightM?: number, exitHeightM?: number, minHeightM?: number }} [threshold]
 */
export function rollupWanted(
  { heightM, inView, active },
  {
    enter = ROLLUP_ENTER_COUNT,
    exit = ROLLUP_EXIT_COUNT,
    enterHeightM = ROLLUP_ENTER_HEIGHT_M,
    exitHeightM = ROLLUP_EXIT_HEIGHT_M,
    minHeightM = ROLLUP_MIN_HEIGHT_M,
  } = {},
) {
  if (!(heightM >= minHeightM)) return false;
  const low = Math.min(exit, enter);
  const lowHeight = Math.min(exitHeightM, enterHeightM);
  const dense = active ? inView >= low : inView > enter;
  const high =
    Number.isFinite(enterHeightM) &&
    (active ? heightM >= lowHeight : heightM > enterHeightM);
  return dense || high;
}

/** A cell's fill alpha for its count, on a log ramp up to the fullest cell. */
export function cellAlpha(count, maxCount) {
  const top = Math.max(1, maxCount);
  const t = Math.log(1 + Math.max(0, count)) / Math.log(1 + top);
  return (
    ROLLUP_ALPHA_MIN + (ROLLUP_ALPHA_MAX - ROLLUP_ALPHA_MIN) * Math.min(1, t)
  );
}

/** A short count for a label: 1,234 → "1.2k". */
export function countLabel(count) {
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(count);
}

/** The lon/lat box of a cell, wrapped to ±180 (the fly-to destination). */
export function cellBox(cell) {
  const ring = cellRing(cell);
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  return {
    west: wrap(Math.min(...lons)),
    south: Math.min(...lats),
    east: wrap(Math.max(...lons)),
    north: Math.max(...lats),
  };
}

/**
 * A world-overlay entry for a cell's count at its centre: a label the host
 * paints (never a Cesium label), which activates like a click on the hex.
 * @param {{ cell: string, count: number, accent: string, cesium: object, activate?: Function, accessibilityLabel?: string }} input
 */
export function labelEntry({
  cell,
  count,
  accent,
  cesium,
  activate = null,
  accessibilityLabel = '',
}) {
  const [lon, lat] = cellCentre(cell);
  return {
    id: cell,
    variant: 'label',
    position: cesium.Cartesian3.fromDegrees(lon, lat, 0),
    title: countLabel(count),
    accent,
    priority: count,
    interactive: typeof activate === 'function',
    activate: typeof activate === 'function' ? activate : undefined,
    horizonCull: true,
    edgeFade: 'keyhole',
    accessibilityLabel,
  };
}
