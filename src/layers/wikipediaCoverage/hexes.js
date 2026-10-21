// Personal fork: the Wikipedia coverage layer's Hexes mode. Instead of the
// raster, H3 cells coloured by the chosen variant on the same inferno ramp,
// drawn as ground-clamped polygons (the shared drawer in maps/h3Surface.js)
// so they drape on terrain and on the photoreal tileset alike. The cells
// and their values come from the server's /api/wikipedia-coverage/h3
// endpoint for the view window (maps/h3Cells.js) at the resolution the
// camera height picks (maps/h3Resolution.js).

import * as Cesium from 'cesium';
import { createHexSurface as drawHexSurface } from '../../maps/h3Surface.js';
import { rampColor, rampPosition } from './ramp.js';

/** The most cells one request draws; the server refuses more with a 413. */
export const HEX_MAX_CELLS = 20_000;

/**
 * The ramp colour of a value as a Cesium colour at an opacity, or null when
 * the value draws nothing.
 */
export function cellColor(value, domain, opacity, cesium = Cesium) {
  const position = rampPosition(value, domain);
  if (!Number.isFinite(position)) return null;
  const [r, g, b, a] = rampColor(position);
  return new cesium.Color(r / 255, g / 255, b / 255, (a / 255) * opacity);
}

/**
 * One drawn hex surface: a GroundPrimitive of the cells, recoloured in
 * place for a new opacity once it is ready. `colourOf(value)` → [r, g, b,
 * a] (0–255) or null: the colour scale's (scale.js), else the ramp's.
 * @param {{ cells: Array<[string, number]>, domain: {min: number, max: number}, opacity: number, cesium?: object, colourOf?: Function }} options
 */
export function createHexSurface({
  cells,
  domain,
  opacity,
  cesium = Cesium,
  colourOf = null,
}) {
  const coloured = [];
  for (const [cell, value] of cells) {
    let colour;
    if (colourOf) {
      const rgba = colourOf(value);
      colour = rgba
        ? new cesium.Color(
            rgba[0] / 255,
            rgba[1] / 255,
            rgba[2] / 255,
            rgba[3] / 255,
          )
        : null;
    } else colour = cellColor(value, domain, 1, cesium);
    if (colour) coloured.push([cell, colour]);
  }
  return drawHexSurface({ cells: coloured, opacity, cesium });
}

/** The resolution to ask for after a 413: one step down, or none at 0. */
export function fallbackResolution(res) {
  return res > 0 ? res - 1 : null;
}
