// Personal fork: renders one tile of the self-hosted Overture country lines
// from the level files. Not part of upstream God's Eye View.
import { decodeCell } from '../riversV2/levelFile.js';
import { TILE_SIZE, createCoverage } from '../riversV2/render.js';
import { cellKey, cellRange, tileWorldBox } from '../riversV2/tileMath.js';
import { DASH_OFF, DASH_ON, MAX_WIDTH_PX, SETS, bandForZoom } from './bands.js';

/**
 * A line's dashes into `coverage`: along each segment's longer axis, the
 * stretches where (world pixel mod DASH_ON + DASH_OFF) < DASH_ON. `points`
 * are tile pixels; `originX`, `originY` the tile's corner in world pixels.
 */
export function dashedPolyline(
  coverage,
  points,
  width,
  originX = 0,
  originY = 0,
) {
  const period = DASH_ON + DASH_OFF;
  for (let at = 2; at < points.length; at += 2) {
    const x0 = points[at - 2];
    const y0 = points[at - 1];
    const x1 = points[at];
    const y1 = points[at + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const from = alongX ? x0 + originX : y0 + originY;
    const span = alongX ? dx : dy;
    if (span === 0) continue;
    const low = Math.min(from, from + span);
    const high = Math.max(from, from + span);
    // The dashes [k·period, k·period + DASH_ON] the segment's axis meets.
    for (
      let start = Math.floor(low / period) * period;
      start < high;
      start += period
    ) {
      const u0 = Math.max(low, start);
      const u1 = Math.min(high, start + DASH_ON);
      if (u1 <= u0) continue;
      const t0 = (u0 - from) / span;
      const t1 = (u1 - from) / span;
      coverage.polyline(
        [x0 + dx * t0, y0 + dy * t0, x0 + dx * t1, y0 + dy * t1],
        width,
      );
    }
  }
}

/**
 * The coverage of tile z/x/y in a set: every piece of the zoom's band of
 * the set's subtypes (a build's class without one is a country line),
 * from the cells under the tile, solid, or dashed where its class is
 * disputed.
 * @param {Map<string, ReturnType<import('../riversV2/levelFile.js').openLevel>>} levels by band level
 */
export function renderTileCoverage(levels, z, x, y, set = 'countries') {
  const coverage = createCoverage(TILE_SIZE);
  const band = bandForZoom(z);
  const level = band ? levels.get(band.level) : null;
  if (!level) return { coverage, cells: 0, pieces: 0 };
  const { quantBits, gridZoom, marginUnits = 0, classes = [] } = level.header;
  const disputed = classes.map((entry) => entry?.disputed === true);
  const subtypes = new Set(SETS[set] || SETS.countries);
  const drawn = classes.map((entry) =>
    subtypes.has(entry?.subtype || 'country'),
  );
  const box = tileWorldBox(z, x, y);
  // Cells built with a margin of the widest line hold every line that can
  // reach into them: read only the cells under the tile. Otherwise pad.
  const needed = (MAX_WIDTH_PX / 2 + 1) / (TILE_SIZE * 2 ** z);
  const pad = marginUnits / 2 ** quantBits >= needed ? 0 : needed;
  const inset = pad ? 0 : 1 / 2 ** (gridZoom + 20);
  const range = cellRange(
    {
      x0: box.x0 - pad,
      y0: box.y0 - pad,
      x1: box.x1 + pad - inset,
      y1: box.y1 + pad - inset,
    },
    gridZoom,
  );
  const cellUnits = 2 ** (quantBits - gridZoom);
  const scale = (TILE_SIZE * 2 ** z) / 2 ** quantBits;
  const offsetX = x * TILE_SIZE;
  const offsetY = y * TILE_SIZE;
  let pixels = new Float64Array(256);
  let cells = 0;
  let pieces = 0;
  for (let cy = range.cy0; cy <= range.cy1; cy++)
    for (let cx = range.cx0; cx <= range.cx1; cx++) {
      const index = level.find(cellKey(cx, cy, gridZoom));
      if (index < 0) continue;
      cells++;
      decodeCell(
        level.readCell(index),
        cx * cellUnits,
        cy * cellUnits,
        (kind, coords) => {
          if (drawn[kind] === false) return;
          pieces++;
          if (pixels.length < coords.length)
            pixels = new Float64Array(coords.length);
          for (let at = 0; at < coords.length; at += 2) {
            pixels[at] = coords[at] * scale - offsetX;
            pixels[at + 1] = coords[at + 1] * scale - offsetY;
          }
          const line = pixels.subarray(0, coords.length);
          if (disputed[kind])
            dashedPolyline(coverage, line, band.width, offsetX, offsetY);
          else coverage.polyline(line, band.width);
        },
      );
    }
  return { coverage, cells, pieces };
}
