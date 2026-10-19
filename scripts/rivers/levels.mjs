import {
  BANDS,
  MAX_WIDTH_PX,
  TOLERANCE_PX,
  orderForUpland,
  quantBitsFor,
} from '../../server/providers/riversV2/bands.js';
import { encodePiece } from '../../server/providers/riversV2/levelFile.js';
import { worldX, worldY } from '../../server/providers/riversV2/tileMath.js';

/**
 * The geometry steps of a rivers build, per reach and band: thin by order
 * (bands.js), project to Web Mercator, simplify (Douglas–Peucker at half a
 * pixel of the band's tolerance zoom), quantize, and cut into the band's
 * cells as encoded pieces.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** [lon, lat, …] → world [x, y, …] in [0, 1]. */
export function projectPart(coords) {
  const out = new Float64Array(coords.length);
  for (let index = 0; index < coords.length; index += 2) {
    out[index] = worldX(coords[index]);
    out[index + 1] = worldY(coords[index + 1]);
  }
  return out;
}

/**
 * Douglas–Peucker: which points of [x, y, …] to keep so no dropped point
 * is farther than `tolerance` from the line kept. The ends are kept.
 * @returns {Uint8Array} 1 for a kept point
 */
export function simplify(points, tolerance) {
  const count = points.length / 2;
  const keep = new Uint8Array(count);
  if (count === 0) return keep;
  keep[0] = 1;
  keep[count - 1] = 1;
  if (count < 3) return keep;
  const toleranceSquared = tolerance * tolerance;
  const stack = [0, count - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = points[first * 2];
    const ay = points[first * 2 + 1];
    const dx = points[last * 2] - ax;
    const dy = points[last * 2 + 1] - ay;
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1;
    let farthestSquared = toleranceSquared;
    for (let index = first + 1; index < last; index++) {
      const px = points[index * 2] - ax;
      const py = points[index * 2 + 1] - ay;
      let distanceSquared;
      if (lengthSquared === 0) distanceSquared = px * px + py * py;
      else {
        let t = (px * dx + py * dy) / lengthSquared;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = px - t * dx;
        const ey = py - t * dy;
        distanceSquared = ex * ex + ey * ey;
      }
      if (distanceSquared > farthestSquared) {
        farthestSquared = distanceSquared;
        farthest = index;
      }
    }
    if (farthest > 0) {
      keep[farthest] = 1;
      stack.push(first, farthest, farthest, last);
    }
  }
  return keep;
}

/**
 * The margin a band's cells take in, in its quantized units: half the
 * widest line and a pixel of antialiasing at the band's shallowest zoom
 * (deeper zooms need less).
 */
export const marginUnits = (band) =>
  Math.ceil(
    ((MAX_WIDTH_PX / 2 + 1) / 256) * 2 ** (quantBitsFor(band) - band.minZoom),
  );

/** A band's tolerance in world units. */
export const toleranceFor = (band) =>
  TOLERANCE_PX / (256 * 2 ** band.toleranceZoom);

/**
 * The kept points as integer world units at `quantBits`, consecutive
 * repeats dropped. Fewer than two distinct points → null.
 */
export function quantize(points, keep, quantBits) {
  const scale = 2 ** quantBits;
  const out = [];
  let lastX = NaN;
  let lastY = NaN;
  for (let index = 0; index < keep.length; index++) {
    if (!keep[index]) continue;
    const x = Math.round(points[index * 2] * scale);
    const y = Math.round(points[index * 2 + 1] * scale);
    if (x === lastX && y === lastY) continue;
    out.push(x, y);
    lastX = x;
    lastY = y;
  }
  return out.length >= 4 ? out : null;
}

/**
 * Cut a quantized line into the cells (2^cellShift units square) its
 * segments come within `margin` units of: each cell gets the runs of
 * consecutive segments whose box, grown by the margin, meets it. With the
 * margin of the widest line, a tile reads only the cells under it.
 * @param {(cx: number, cy: number, coords: number[]) => void} onRun
 */
export function splitIntoCells(coords, cellShift, onRun, margin = 0) {
  const size = 2 ** cellShift;
  const cellOf = (value) => Math.floor(value / size);
  const segments = coords.length / 2 - 1;
  // Fast path: the whole line (and its margin) in one cell.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < coords.length; index += 2) {
    if (coords[index] < minX) minX = coords[index];
    if (coords[index] > maxX) maxX = coords[index];
    if (coords[index + 1] < minY) minY = coords[index + 1];
    if (coords[index + 1] > maxY) maxY = coords[index + 1];
  }
  if (
    cellOf(minX - margin) === cellOf(maxX + margin) &&
    cellOf(minY - margin) === cellOf(maxY + margin)
  ) {
    onRun(cellOf(minX), cellOf(minY), coords);
    return;
  }
  /** cell key → {cx, cy, runs: number[][], lastSegment} */
  const open = new Map();
  for (let segment = 0; segment < segments; segment++) {
    const x0 = coords[segment * 2];
    const y0 = coords[segment * 2 + 1];
    const x1 = coords[segment * 2 + 2];
    const y1 = coords[segment * 2 + 3];
    const cx0 = cellOf(Math.min(x0, x1) - margin);
    const cx1 = cellOf(Math.max(x0, x1) + margin);
    const cy0 = cellOf(Math.min(y0, y1) - margin);
    const cy1 = cellOf(Math.max(y0, y1) + margin);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx},${cy}`;
        let cell = open.get(key);
        if (!cell) {
          cell = { cx, cy, runs: [], lastSegment: -2 };
          open.set(key, cell);
        }
        if (cell.lastSegment === segment - 1) {
          cell.runs[cell.runs.length - 1].push(x1, y1);
        } else {
          cell.runs.push([x0, y0, x1, y1]);
        }
        cell.lastSegment = segment;
      }
  }
  for (const cell of open.values())
    for (const run of cell.runs) onRun(cell.cx, cell.cy, run);
}

/**
 * The pieces a reach adds to every band that draws it, as
 * onPiece(band, cx, cy, order, run, originX, originY): `run` is integer
 * world units at the band's quantBits, the origin the cell's corner in the
 * same units. Returns the reach's order.
 * @param {{upland: number, parts: Float64Array[]}} reach
 */
export function reachPieces(reach, onPiece, bands = BANDS) {
  const order = orderForUpland(reach.upland);
  let projected = null;
  for (const band of bands) {
    if (order > band.maxOrder) continue;
    projected ||= reach.parts.map(projectPart);
    const quantBits = quantBitsFor(band);
    const cellShift = quantBits - band.gridZoom;
    const cellUnits = 2 ** cellShift;
    const tolerance = toleranceFor(band);
    const margin = marginUnits(band);
    for (const points of projected) {
      const coords = quantize(points, simplify(points, tolerance), quantBits);
      if (!coords) continue;
      splitIntoCells(
        coords,
        cellShift,
        (cx, cy, run) =>
          onPiece(band, cx, cy, order, run, cx * cellUnits, cy * cellUnits),
        margin,
      );
    }
  }
  return order;
}

/** reachPieces with each piece encoded (tests and small builds). */
export function encodedReachPieces(reach, onPiece, bands = BANDS) {
  return reachPieces(
    reach,
    (band, cx, cy, order, run, originX, originY) =>
      onPiece(band, cx, cy, encodePiece(order, run, originX, originY)),
    bands,
  );
}
