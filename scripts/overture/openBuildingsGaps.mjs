import fs from 'node:fs';
import { decodeRing } from '../../src/data/adminBoundaries.js';
import {
  OPEN_BUILDINGS_BOXES,
  inOpenBuildings,
} from '../../src/data/openBuildingsCoverage.js';

/**
 * The Open Buildings boxes are coarse S2 cells: some take in land Google's
 * data does not cover (the US Southwest and South Florida, southern Spain,
 * Sicily, Malta and southern Greece), where Open Buildings draws nothing.
 * A building there is Overture's to draw after all. Its country is read
 * from Natural Earth's admin-0 polygons (the bundled pack), rasterized
 * once over the boxes at GAP_CELL_DEGREES (about a kilometre), so the test
 * is a lookup.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** Countries inside Open Buildings boxes that Open Buildings has no data for. */
export const GAP_COUNTRIES = Object.freeze([
  'US',
  'ES',
  'PT',
  'IT',
  'MT',
  'GR',
  'GI',
]);
export const GAP_CELL_DEGREES = 0.01;
/** How far (cells, about 8 km) the gap countries reach past their simplified outlines. */
export const GAP_REACH_CELLS = 8;
const COUNTRIES = new URL(
  '../../src/data/local_data/natural_earth/countries.json',
  import.meta.url,
);

/**
 * A raster per Open Buildings box: 1 where a cell's centre is in a gap
 * country. Built from the countries' rings by even-odd scanlines.
 */
export function gapRasters({
  countries = JSON.parse(fs.readFileSync(COUNTRIES, 'utf8')),
  boxes = OPEN_BUILDINGS_BOXES,
} = {}) {
  const decimals = countries.meta?.decimals ?? 3;
  const gap = [];
  const other = [];
  for (const feature of countries.features || [])
    for (const polygon of feature.polygons || [])
      for (const encoded of polygon)
        (GAP_COUNTRIES.includes(feature.iso2) ? gap : other).push(
          decodeRing(encoded, decimals),
        );
  return boxes.map((box) => {
    const [west, south, east, north] = box;
    const columns = Math.ceil((east - west) / GAP_CELL_DEGREES);
    const rows = Math.ceil((north - south) / GAP_CELL_DEGREES);
    const inGap = rasterize(gap, box, columns, rows);
    if (!inGap.some(Boolean))
      return { box, columns, rows, cells: inGap, any: false };
    // The outlines are simplified (a coastal city can fall outside its
    // country's): reach GAP_REACH_CELLS further, into cells no other
    // country claims (the sea, or a border sliver nobody's outline holds).
    const claimed = rasterize(other, box, columns, rows);
    const cells = new Uint8Array(inGap);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < columns; c++) {
        if (inGap[r * columns + c]) continue;
        if (claimed[r * columns + c]) continue;
        search: for (let dr = -GAP_REACH_CELLS; dr <= GAP_REACH_CELLS; dr++)
          for (let dc = -GAP_REACH_CELLS; dc <= GAP_REACH_CELLS; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= columns) continue;
            if (inGap[rr * columns + cc]) {
              cells[r * columns + c] = 1;
              break search;
            }
          }
      }
    return { box, columns, rows, cells, any: true };
  });
}

/** Cells (of a box's grid) whose centre an even-odd scanline puts inside the rings. */
function rasterize(rings, [west, south, east, north], columns, rows) {
  const cells = new Uint8Array(columns * rows);
  const near = rings.filter((ring) => {
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [lon, lat] of ring) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
    return w <= east && e >= west && s <= north && n >= south;
  });
  if (!near.length) return cells;
  for (let r = 0; r < rows; r++) {
    const lat = south + (r + 0.5) * GAP_CELL_DEGREES;
    for (const ring of near) {
      // Each ring on its own: country rings may overlap at borders.
      const crossings = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat)
          crossings.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(
          0,
          Math.ceil((crossings[k] - west) / GAP_CELL_DEGREES - 0.5),
        );
        const to = Math.min(
          columns - 1,
          Math.floor((crossings[k + 1] - west) / GAP_CELL_DEGREES - 0.5),
        );
        for (let c = from; c <= to; c++) cells[r * columns + c] = 1;
      }
    }
  }
  return cells;
}

let shared = null;

/** Whether a point inside an Open Buildings box is in a gap country. */
export function inOpenBuildingsGap(
  lat,
  lon,
  rasters = (shared ||= gapRasters()),
) {
  for (const raster of rasters) {
    if (!raster.any) continue;
    const [west, south, east, north] = raster.box;
    if (lat < south || lat > north || lon < west || lon > east) continue;
    const c = Math.min(
      raster.columns - 1,
      Math.floor((lon - west) / GAP_CELL_DEGREES),
    );
    const r = Math.min(
      raster.rows - 1,
      Math.floor((lat - south) / GAP_CELL_DEGREES),
    );
    if (raster.cells[r * raster.columns + c]) return true;
  }
  return false;
}

/** Whether Open Buildings draws a point: inside a box and not in a gap country. */
export function openBuildingsDraws(lat, lon, rasters) {
  return inOpenBuildings(lat, lon) && !inOpenBuildingsGap(lat, lon, rasters);
}

/** The Open Buildings boxes that hold some gap country (where a gaps pass looks). */
export function gapBoxes(rasters = (shared ||= gapRasters())) {
  return rasters.filter((raster) => raster.any).map((raster) => raster.box);
}
