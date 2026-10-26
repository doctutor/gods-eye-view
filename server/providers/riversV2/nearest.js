// Personal fork: the HydroSHEDS v2 line nearest a click, from the level
// files the Rivers layer's v2 tiles are drawn from (server/providers/
// riversV2.js), for the clicked-river highlight (server/providers/
// riverReach.js). Not part of upstream God's Eye View.
import { BANDS, MAX_ORDER } from './bands.js';
import { decodeCell } from './levelFile.js';
import {
  cellKey,
  cellRange,
  latOf,
  lonOf,
  worldX,
  worldY,
} from './tileMath.js';

/**
 * A level's pieces carry an order and a line, nothing else: no reach id,
 * no downstream link, no discharge, no name (levelFile.js). What a click
 * can have from them is the line drawn where the user clicked, so the
 * highlight lies on the river they see; HydroRIVERS v1 still gives the
 * reach's details and its path to the sea.
 *
 * A reach that crosses cells is cut at them, each cell holding the run of
 * its segments that come within the level's margin of the cell, so the
 * runs of neighbouring cells share their segments at the edge. The line is
 * put back together by those shared segments (a confluence shares only a
 * point, so two reaches are never joined).
 */

/** At most this many cells are read for one click. */
export const MAX_CELLS = 9;
/** And at most this many joins made to put a reach back together. */
const MAX_JOINS = 8;
const METRES_PER_DEGREE_LAT = 110_574;
const METRES_PER_DEGREE_LON = 111_320;

/**
 * The band a click's lookup reads: the first whose level holds every order
 * the click may pick, so a click from high up reads a coarse level's few
 * large cells, not the finest level's many.
 */
export function bandForOrder(maxOrder) {
  const order = Math.min(MAX_ORDER, Math.max(1, Number(maxOrder) || MAX_ORDER));
  return BANDS.find((band) => band.maxOrder >= order) || BANDS.at(-1);
}

/** Metres from a place to the nearest point of a line of [lon, lat]. */
export function metresToLine(points, lon, lat) {
  const kx = METRES_PER_DEGREE_LON * Math.cos((lat * Math.PI) / 180);
  const ky = METRES_PER_DEGREE_LAT;
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = (points[i][0] - lon) * kx;
    const ay = (points[i][1] - lat) * ky;
    const ux = (points[i + 1][0] - points[i][0]) * kx;
    const uy = (points[i + 1][1] - points[i][1]) * ky;
    const length2 = ux * ux + uy * uy;
    const t =
      length2 > 0
        ? Math.max(0, Math.min(1, -(ax * ux + ay * uy) / length2))
        : 0;
    best = Math.min(best, Math.hypot(ax + t * ux, ay + t * uy));
  }
  if (points.length === 1)
    best = Math.hypot((points[0][0] - lon) * kx, (points[0][1] - lat) * ky);
  return best;
}

/**
 * The longest run of points that ends `head` and begins `tail` (integer
 * world units [x, y, …]): how many points they share, 0 when fewer than a
 * segment's two.
 */
export function sharedPoints(head, tail) {
  const first = [tail[0], tail[1]];
  // Where tail's first point is in head, from the end (the shared run is
  // the margin's few segments at the cell edge).
  for (let at = head.length - 4; at >= 0; at -= 2) {
    if (head[at] !== first[0] || head[at + 1] !== first[1]) continue;
    const count = (head.length - at) / 2;
    if (count * 2 > tail.length) continue;
    let same = true;
    for (let k = 2; k < count * 2; k++)
      if (head[at + k] !== tail[k]) {
        same = false;
        break;
      }
    if (same) return count;
  }
  return 0;
}

/**
 * The v2 line nearest a click within `toleranceM`, of an order the click
 * may pick, put back together across cell edges; null when none.
 * @param {Map<string, {header: object, find: Function, readCell: Function}>} levels
 *   the build's open levels, by band level (riversV2.js openBuild)
 * @param {{lat: number, lon: number, toleranceM: number, maxOrder?: number}} query
 * @returns {{order: number, distanceM: number, level: string, cells: number,
 *   geometry: {type: 'LineString', coordinates: number[][]}}|null}
 */
export function nearestV2Line(levels, { lat, lon, toleranceM, maxOrder }) {
  const band = bandForOrder(maxOrder);
  const level = levels?.get(band.level);
  if (!level || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const order = Math.min(MAX_ORDER, Number(maxOrder) || MAX_ORDER);
  const { quantBits, gridZoom } = level.header;
  const scale = 2 ** quantBits;
  const cellUnits = 2 ** (quantBits - gridZoom);
  const toDegrees = (coords) => {
    const points = [];
    for (let i = 0; i < coords.length; i += 2)
      points.push([lonOf(coords[i] / scale), latOf(coords[i + 1] / scale)]);
    return points;
  };

  /** A cell's pieces of the orders asked for, read once. */
  const cells = new Map();
  function piecesOf(cx, cy) {
    const key = cellKey(cx, cy, gridZoom);
    if (cells.has(key)) return cells.get(key);
    if (cells.size >= MAX_CELLS) return [];
    const pieces = [];
    const index = level.find(key);
    if (index >= 0)
      decodeCell(
        level.readCell(index),
        cx * cellUnits,
        cy * cellUnits,
        (pieceOrder, coords) => {
          if (pieceOrder <= order)
            pieces.push({ order: pieceOrder, coords: Array.from(coords) });
        },
      );
    cells.set(key, pieces);
    return pieces;
  }

  // The cells within the tolerance of the click.
  const dLat = toleranceM / METRES_PER_DEGREE_LAT;
  const dLon =
    toleranceM /
    (METRES_PER_DEGREE_LON * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const range = cellRange(
    {
      x0: worldX(Math.max(-180, lon - dLon)),
      y0: worldY(Math.min(85, lat + dLat)),
      x1: worldX(Math.min(180, lon + dLon)),
      y1: worldY(Math.max(-85, lat - dLat)),
    },
    gridZoom,
  );
  let best = null;
  for (let cy = range.cy0; cy <= range.cy1; cy++)
    for (let cx = range.cx0; cx <= range.cx1; cx++)
      for (const piece of piecesOf(cx, cy)) {
        const distanceM = metresToLine(toDegrees(piece.coords), lon, lat);
        if (distanceM <= toleranceM && (!best || distanceM < best.distanceM))
          best = { piece, distanceM };
      }
  if (!best) return null;

  // Join the runs of the same reach in the cells its ends lie in.
  let line = best.piece.coords;
  const cellOf = (x, y) => [
    Math.floor(x / cellUnits),
    Math.floor(y / cellUnits),
  ];
  for (let joins = 0; joins < MAX_JOINS; joins++) {
    let joined = false;
    const tail = cellOf(line[line.length - 2], line[line.length - 1]);
    for (const piece of piecesOf(...tail)) {
      if (piece.order !== best.piece.order) continue;
      const shared = sharedPoints(line, piece.coords);
      if (shared && piece.coords.length > shared * 2) {
        line = line.concat(piece.coords.slice(shared * 2));
        joined = true;
        break;
      }
    }
    const head = cellOf(line[0], line[1]);
    for (const piece of piecesOf(...head)) {
      if (piece.order !== best.piece.order) continue;
      const shared = sharedPoints(piece.coords, line);
      if (shared && piece.coords.length > shared * 2) {
        line = piece.coords
          .slice(0, piece.coords.length - shared * 2)
          .concat(line);
        joined = true;
        break;
      }
    }
    if (!joined) break;
  }
  const round = (value) => Math.round(value * 1e5) / 1e5;
  return {
    order: best.piece.order,
    distanceM: Math.round(best.distanceM),
    level: band.level,
    cells: cells.size,
    geometry: {
      type: 'LineString',
      coordinates: toDegrees(line).map(([x, y]) => [round(x), round(y)]),
    },
  };
}
