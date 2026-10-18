// Personal fork: H3 cells for a view, shared by the hex surfaces. The view
// window is the Earth Engine overlays' rule (a square six camera heights
// across, at least 40 km, the whole planet past a 5,000 km half-side),
// here with longitudes that wrap, so a window across the antimeridian is
// one window (west > east) rather than a clipped one. Cells come from H3:
// every cell of the resolution for a planet-wide window, else the disk of
// cells around the one under the view that covers the window.

import {
  cellToBoundary,
  cellToChildren,
  cellToLatLng,
  getHexagonEdgeLengthAvg,
  getRes0Cells,
  gridDisk,
  latLngToCell,
} from 'h3-js';
import { clampH3Resolution } from './h3Resolution.js';

/** Half the window's side is this many camera heights… */
export const VIEW_HALF_FACTOR = 3;
/** …and at least this many metres. */
export const MIN_VIEW_HALF_M = 20_000;
/** Past this half-side, the whole planet. */
export const WORLD_HALF_M = 5_000_000;
const EARTH_RADIUS_M = 6_378_137;
/** Planet-wide cell sets stop here (resolution 2 is 5,882 cells). */
export const GLOBAL_MAX_RESOLUTION = 2;
/** The most cells one surface draws. */
export const DEFAULT_MAX_CELLS = 20_000;

const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The window's half-side in metres for a camera height. */
export function viewHalfM(heightM) {
  return Math.max(MIN_VIEW_HALF_M, VIEW_HALF_FACTOR * heightM);
}

/**
 * The view window in degrees, or null for the whole planet. `west > east`
 * when it crosses the antimeridian; a window that reaches round the pole
 * spans every longitude.
 */
export function viewWindow(lat, lon, heightM) {
  const half = viewHalfM(heightM);
  if (!Number.isFinite(half) || half >= WORLD_HALF_M) return null;
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const south = Math.max(-85, lat - dLat);
  const north = Math.min(85, lat + dLat);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLon = dLat / Math.max(0.05, cosLat);
  if (dLon >= 180 || north >= 85 || south <= -85)
    return { west: -180, south, east: 180, north };
  return { west: wrapLon(lon - dLon), south, east: wrapLon(lon + dLon), north };
}

/** Whether a view has left the window another view was made for. */
export function viewMoved(made, now) {
  if (!made) return true;
  if (!Number.isFinite(now.heightM) || !Number.isFinite(made.heightM))
    return true;
  const ratio = now.heightM / made.heightM;
  if (ratio > 2 || ratio < 0.5) return true;
  const half = viewHalfM(made.heightM);
  const dy = ((now.lat - made.lat) * Math.PI * EARTH_RADIUS_M) / 180;
  const dLon = wrapLon(now.lon - made.lon);
  const dx =
    (dLon * Math.PI * EARTH_RADIUS_M * Math.cos((made.lat * Math.PI) / 180)) /
    180;
  // Half the way to the edge: rebuilt before the view reaches it.
  return Math.max(Math.abs(dx), Math.abs(dy)) > half / 2;
}

/** A cell's boundary as an open [lon, lat] ring, continuous across ±180. */
export function cellRing(cell) {
  const ring = cellToBoundary(cell, true).map(([lon, lat]) => [lon, lat]);
  if (ring.length > 1) {
    const first = ring[0][0];
    const last = ring.at(-1);
    if (last[0] === first && last[1] === ring[0][1]) ring.pop();
  }
  const anchor = ring[0]?.[0] ?? 0;
  for (const point of ring) {
    if (point[0] - anchor > 180) point[0] -= 360;
    else if (anchor - point[0] > 180) point[0] += 360;
  }
  return ring;
}

/** A cell's centre as [lon, lat]. */
export function cellCentre(cell) {
  const [lat, lon] = cellToLatLng(cell);
  return [lon, lat];
}

/** Every cell of a resolution (planet-wide windows, low resolutions). */
export function allCells(res) {
  const resolution = clampH3Resolution(res);
  if (resolution === 0) return getRes0Cells();
  return getRes0Cells().flatMap((cell) => cellToChildren(cell, resolution));
}

/** The gridDisk radius that covers a half-side at a resolution. */
export function diskRadius(res, halfM) {
  const acrossM = Math.sqrt(3) * getHexagonEdgeLengthAvg(res, 'm');
  return Math.ceil(halfM / acrossM) + 1;
}

/** The largest disk radius whose cell count stays within a budget. */
export function diskRadiusWithin(maxCells) {
  // A disk of radius k holds 3k² + 3k + 1 cells.
  return Math.max(0, Math.floor((-3 + Math.sqrt(9 - 12 * (1 - maxCells))) / 6));
}

/**
 * The cells a surface draws for a view at a resolution.
 * @param {{ lat: number, lon: number, heightM: number }} view
 * @param {number} res
 * @param {{ maxCells?: number }} [options]
 * @returns {{ res: number, scope: 'global' | 'window', window: object | null, k: number | null, cells: string[] }}
 */
export function cellsForView(view, res, { maxCells = DEFAULT_MAX_CELLS } = {}) {
  const resolution = clampH3Resolution(res);
  const window = viewWindow(view.lat, view.lon, view.heightM);
  if (window === null && resolution <= GLOBAL_MAX_RESOLUTION)
    return {
      res: resolution,
      scope: 'global',
      window: null,
      k: null,
      cells: allCells(resolution),
    };
  const halfM = Math.min(WORLD_HALF_M, viewHalfM(view.heightM));
  const k = Math.min(diskRadius(resolution, halfM), diskRadiusWithin(maxCells));
  const centre = latLngToCell(view.lat, wrapLon(view.lon), resolution);
  return {
    res: resolution,
    scope: 'window',
    window,
    k,
    cells: gridDisk(centre, k),
  };
}
