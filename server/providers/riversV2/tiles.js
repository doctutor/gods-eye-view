// Personal fork: renders one tile of the self-hosted HydroSHEDS v2 rivers
// from the level files. Not part of upstream God's Eye View.
import { MAX_WIDTH_PX, bandForZoom, widthFor } from './bands.js';
import { decodeCell } from './levelFile.js';
import { TILE_SIZE, createCoverage } from './render.js';
import { cellKey, cellRange, tileWorldBox } from './tileMath.js';

/**
 * The coverage of tile z/x/y: every piece of the zoom's band (from the
 * cells under the tile, padded by half the widest line) of an order the
 * zoom draws, in the width its order gets.
 * @param {Map<string, ReturnType<import('./levelFile.js').openLevel>>} levels by band level
 * @returns {{coverage: ReturnType<typeof createCoverage>, cells: number, pieces: number}}
 */
export function renderTileCoverage(levels, z, x, y) {
  const coverage = createCoverage(TILE_SIZE);
  const band = bandForZoom(z);
  const level = band ? levels.get(band.level) : null;
  if (!level) return { coverage, cells: 0, pieces: 0 };
  const { quantBits, gridZoom, marginUnits = 0 } = level.header;
  const box = tileWorldBox(z, x, y);
  // Cells built with a margin of the widest line hold every line that can
  // reach into them: read only the cells under the tile. Otherwise pad.
  const needed = (MAX_WIDTH_PX / 2 + 1) / (TILE_SIZE * 2 ** z);
  const pad = marginUnits / 2 ** quantBits >= needed ? 0 : needed;
  // A cell is under the tile when it overlaps it, not when it only touches.
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
  const widths = new Map();
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
        (order, coords) => {
          if (order > band.maxOrder) return;
          pieces++;
          if (pixels.length < coords.length)
            pixels = new Float64Array(coords.length);
          for (let at = 0; at < coords.length; at += 2) {
            pixels[at] = coords[at] * scale - offsetX;
            pixels[at + 1] = coords[at + 1] * scale - offsetY;
          }
          if (!widths.has(order)) widths.set(order, widthFor(order, z));
          coverage.polyline(
            pixels.subarray(0, coords.length),
            widths.get(order),
          );
        },
      );
    }
  return { coverage, cells, pieces };
}
