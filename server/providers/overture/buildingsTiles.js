// Personal fork: the Overture buildings tiles of the Buildings layer, drawn
// from the files `npm run overture:build -- --buildings` writes. Not part
// of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOCK_ZOOM,
  BUCKET_ZOOM,
  DENSITY_ZOOM,
  KIND,
  UNIT_M,
  WORLD_BITS,
  buildingSummary,
  eachBuilding,
  eachCell,
  latOfUnitY,
  openBucket,
} from './buildingsFile.js';
import { createCoverage, parseInk } from '../riversV2/render.js';
import { encodeRgba } from '../census/render.js';
import {
  BUILDINGS_MODES,
  RIVER_INKS,
} from '../../../src/data/earthEngineLayers.js';
import {
  HEIGHT_MIN_COVER,
  HEIGHT_MIN_KNOWN,
  OVERTURE_BUILDINGS_MAX_ZOOM,
  OVERTURE_DENSITY_CELL_ZOOM,
  OVERTURE_FOOTPRINT_ZOOM,
} from '../../../src/data/overtureBuildings.js';

/**
 * A tile is a density raster in the Buildings layer's own ramps
 * (BUILDINGS_MODES: COUNT per km² on a log scale, COVER, HEIGHT), from the
 * sums the build kept, so a coarse pixel is the sum of what is under it
 * divided by its ground:
 *
 * - z 0–4 from each bucket's own cells (D14) summed to 64 × 64 once and
 *   kept, z 5–6 from those cells, z 7–10 from the z 10 tiles' (D18);
 * - z 11 and closer from the footprints themselves (F), binned into cells
 *   no finer than a z 11 pixel (OVERTURE_DENSITY_CELL_ZOOM);
 * - from z 15 the footprints' outlines over it, in the ink.
 */

const TILE = 256;
const SHIFT = (zoom) => WORLD_BITS - zoom;
const BLOCKS_PER_BUCKET = 2 ** (BLOCK_ZOOM - BUCKET_ZOOM);
const DENSITY_PER_BUCKET = 2 ** (DENSITY_ZOOM - BUCKET_ZOOM);
const MODE = new Map(BUILDINGS_MODES.map((mode) => [mode.key, mode]));
/** A bucket's overview is OVERVIEW cells a side: a z 4 tile's pixels. */
const OVERVIEW = 64;
const OVERVIEW_ZOOM = BUCKET_ZOOM - Math.log2(TILE / OVERVIEW);
/** Outlines read beyond the tile by this much (units), for buildings that cross its edge. */
const EDGE_UNITS = 2 ** 10;

const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A palette as Earth Engine draws one: linear between its stops over min…max. */
export function paletteColor(palette, min, max, value) {
  const stops = palette.map(hexRgb);
  const t =
    Math.max(0, Math.min(1, (value - min) / (max - min))) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  const f = t - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

/**
 * The colour of a cell's sums in a mode, or null where the mode masks it:
 * [buildings, built m², Σ height × m², m² with a height] over `km2`.
 */
export function cellColor(mode, sums, km2) {
  const [count, area, heightArea, known] = sums;
  if (!(count > 0) || !(km2 > 0)) return null;
  const spec = MODE.get(mode);
  const { min, max, palette } = spec.vis;
  if (mode === 'count') {
    const perKm2 = count / km2;
    if (perKm2 < spec.atLeast) return null;
    return paletteColor(palette, min, max, Math.log10(perKm2));
  }
  const cover = area / (km2 * 1e6);
  if (mode === 'cover')
    return cover < spec.atLeast ? null : paletteColor(palette, min, max, cover);
  if (
    cover < HEIGHT_MIN_COVER ||
    !(known > 0) ||
    known < HEIGHT_MIN_KNOWN * area
  )
    return null;
  return paletteColor(palette, min, max, heightArea / known);
}

/** The ground of a cell of `cellZoom` pixels' size at a unit row, km². */
export function cellKm2(cellZoom, y) {
  const side =
    UNIT_M * 2 ** SHIFT(cellZoom) * Math.cos((latOfUnitY(y) * Math.PI) / 180);
  return (side * side) / 1e6;
}

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number}} options
 *   `dir`: the Overture cache directory (its buildings/).
 */
export function createBuildingsTiles({
  dir,
  now = () => Date.now(),
  maxOpen = 48,
}) {
  const root = path.join(dir, 'buildings');
  const pointer = path.join(root, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  const open = new Map(); // file → bucket (LRU by insertion)

  /** Each bucket's cells summed to OVERVIEW × OVERVIEW, for z 0–4 (by file). */
  const overviews = new Map();

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
    overviews.clear();
  }

  /**
   * A bucket's overview: its own 256 × 256 cells summed 4 × 4, kept for the
   * build's life (64 KB a bucket), so a tile from orbit, which reads every
   * bucket, reads each only once.
   */
  function overview(m, bx, by) {
    const entry = m.buckets[String(by * 2 ** BUCKET_ZOOM + bx)];
    if (!entry) return null;
    let grid = overviews.get(entry.file);
    if (grid) return grid;
    const b = bucket(m, bx, by);
    const raw = b?.block(KIND.D14, 0);
    grid = new Float32Array(OVERVIEW * OVERVIEW * 4);
    const factor = TILE / OVERVIEW;
    if (raw)
      eachCell(raw, (cell, count, area, heightArea, known) => {
        const at =
          (Math.floor(Math.floor(cell / TILE) / factor) * OVERVIEW +
            Math.floor((cell % TILE) / factor)) *
          4;
        grid[at] += count;
        grid[at + 1] += area;
        grid[at + 2] += heightArea;
        grid[at + 3] += known;
      });
    overviews.set(entry.file, grid);
    return grid;
  }

  /** z 0–4: the buckets' overviews under the tile, summed into its pixels. */
  function fromOverviews(m, z, x, y, grid, cells) {
    const span = 2 ** (BUCKET_ZOOM - z); // buckets a side
    const factor = (span * OVERVIEW) / cells; // overview cells per pixel, a side
    for (let by = 0; by < span; by++)
      for (let bx = 0; bx < span; bx++) {
        const view = overview(m, x * span + bx, y * span + by);
        if (!view) continue;
        for (let cy = 0; cy < OVERVIEW; cy++)
          for (let cx = 0; cx < OVERVIEW; cx++) {
            const from = (cy * OVERVIEW + cx) * 4;
            if (!view[from]) continue;
            const px = Math.floor((bx * OVERVIEW + cx) / factor);
            const py = Math.floor((by * OVERVIEW + cy) / factor);
            const at = (py * cells + px) * 4;
            grid[at] += view[from];
            grid[at + 1] += view[from + 1];
            grid[at + 2] += view[from + 2];
            grid[at + 3] += view[from + 3];
          }
      }
  }

  function manifest() {
    if (now() - checkedAt < 5000 && (held || lastError))
      return held?.manifest || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      held = null;
      lastError = null;
      closeAll();
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.manifest;
    try {
      const { manifest: name } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name)))
        throw new Error('current.json names no manifest');
      const value = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
      closeAll();
      held = { manifest: value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      held = null;
      closeAll();
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Overture] buildings not readable:', lastError);
    }
    return held?.manifest || null;
  }

  function bucket(m, bx, by) {
    const entry = m.buckets[String(by * 2 ** BUCKET_ZOOM + bx)];
    if (!entry) return null;
    const file = path.join(root, 'buckets', entry.file);
    let b = open.get(file);
    if (b) {
      open.delete(file);
      open.set(file, b);
      return b;
    }
    b = openBucket(file);
    open.set(file, b);
    if (open.size > maxOpen) {
      const [oldest, value] = open.entries().next().value;
      value.close();
      open.delete(oldest);
    }
    return b;
  }

  /** Sum the cells of density blocks into the tile's grid (`cells` px a side). */
  function fromDensity(m, z, x, y, grid, cells) {
    const level = z <= BUCKET_ZOOM ? BUCKET_ZOOM : DENSITY_ZOOM;
    const kind = level === BUCKET_ZOOM ? KIND.D14 : KIND.D18;
    // Blocks of `level` under the tile, each 256 cells of zoom level + 8.
    const span = 2 ** (level - z);
    const factor = 2 ** (level - z); // block cells per tile pixel, a side
    for (let by = 0; by < span; by++)
      for (let bx = 0; bx < span; bx++) {
        const tx = x * span + bx;
        const ty = y * span + by;
        const per = level === BUCKET_ZOOM ? 1 : DENSITY_PER_BUCKET;
        const b = bucket(m, Math.floor(tx / per), Math.floor(ty / per));
        if (!b) continue;
        const key = level === BUCKET_ZOOM ? 0 : (ty % per) * per + (tx % per);
        const raw = b.block(kind, key);
        if (!raw) continue;
        eachCell(raw, (cell, count, area, heightArea, known) => {
          const px = Math.floor((bx * TILE + (cell % TILE)) / factor);
          const py = Math.floor((by * TILE + Math.floor(cell / TILE)) / factor);
          const at = (py * cells + px) * 4;
          grid[at] += count;
          grid[at + 1] += area;
          grid[at + 2] += heightArea;
          grid[at + 3] += known;
        });
      }
  }

  /** Visit the buildings of the z 14 blocks meeting a unit box. */
  function eachBuildingIn(m, x0, y0, x1, y1, visit) {
    const s = SHIFT(BLOCK_ZOOM);
    for (let ty = y0 >>> s; ty <= (y1 - 1) >>> s; ty++)
      for (let tx = x0 >>> s; tx <= (x1 - 1) >>> s; tx++) {
        const b = bucket(
          m,
          Math.floor(tx / BLOCKS_PER_BUCKET),
          Math.floor(ty / BLOCKS_PER_BUCKET),
        );
        if (!b) continue;
        const raw = b.block(
          KIND.F,
          (ty % BLOCKS_PER_BUCKET) * BLOCKS_PER_BUCKET +
            (tx % BLOCKS_PER_BUCKET),
        );
        if (raw) eachBuilding(raw, tx << s, ty << s, visit);
      }
  }

  function render(m, mode, ink, z, x, y) {
    const cellZoom = Math.min(z, OVERTURE_DENSITY_CELL_ZOOM) + 8;
    const cells = 2 ** (cellZoom - z); // grid cells a side
    const grid = new Float64Array(cells * cells * 4);
    const s = SHIFT(z);
    const ux0 = x * 2 ** s;
    const uy0 = y * 2 ** s;
    const ux1 = ux0 + 2 ** s;
    const uy1 = uy0 + 2 ** s;
    const footprints = z >= OVERTURE_FOOTPRINT_ZOOM ? [] : null;
    let any = false;
    if (z <= OVERVIEW_ZOOM) fromOverviews(m, z, x, y, grid, cells);
    else if (z <= DENSITY_ZOOM) fromDensity(m, z, x, y, grid, cells);
    else {
      const cellShift = SHIFT(cellZoom);
      const pad = footprints ? EDGE_UNITS : 0;
      eachBuildingIn(
        m,
        ux0 - pad,
        uy0 - pad,
        ux1 + pad,
        uy1 + pad,
        (building) => {
          const { x: bx, y: by, area } = buildingSummary(building);
          if (footprints) footprints.push(building);
          if (bx < ux0 || bx >= ux1 || by < uy0 || by >= uy1) return;
          const px = (bx - ux0) >>> cellShift;
          const py = (by - uy0) >>> cellShift;
          const at = (py * cells + px) * 4;
          grid[at] += 1;
          grid[at + 1] += area;
          if (building.height > 0) {
            grid[at + 2] += building.height * area;
            grid[at + 3] += area;
          }
        },
      );
    }
    // Premultiplied: colour × alpha, alpha 0 to 1 (encodeRgba's raster).
    const rgba = new Float32Array(TILE * TILE * 4);
    const pixelsPerCell = TILE / cells;
    for (let cy = 0; cy < cells; cy++) {
      const km2 = cellKm2(cellZoom, uy0 + (cy + 0.5) * 2 ** SHIFT(cellZoom));
      for (let cx = 0; cx < cells; cx++) {
        const at = (cy * cells + cx) * 4;
        if (!grid[at]) continue;
        const color = cellColor(
          mode,
          [grid[at], grid[at + 1], grid[at + 2], grid[at + 3]],
          km2,
        );
        if (!color) continue;
        any = true;
        for (let py = cy * pixelsPerCell; py < (cy + 1) * pixelsPerCell; py++)
          for (
            let px = cx * pixelsPerCell;
            px < (cx + 1) * pixelsPerCell;
            px++
          ) {
            const o = (py * TILE + px) * 4;
            rgba[o] = color[0];
            rgba[o + 1] = color[1];
            rgba[o + 2] = color[2];
            rgba[o + 3] = 1;
          }
      }
    }
    if (footprints?.length) {
      const coverage = createCoverage(TILE);
      const scale = TILE / 2 ** s;
      for (const building of footprints)
        for (const rings of building.polygons)
          for (const ring of rings) {
            const points = new Float64Array(ring.length + 2);
            for (let i = 0; i < ring.length; i += 2) {
              points[i] = (ring[i] - ux0) * scale;
              points[i + 1] = (ring[i + 1] - uy0) * scale;
            }
            points[ring.length] = points[0];
            points[ring.length + 1] = points[1];
            coverage.polyline(points, 1);
          }
      if (!coverage.empty) {
        any = true;
        const [r, g, b, a] = parseInk(RIVER_INKS[ink]);
        for (let i = 0; i < TILE * TILE; i++) {
          const cover = coverage.values[i];
          if (!(cover > 0)) continue;
          // The ink over the density, premultiplied.
          const alpha = (a / 255) * cover;
          const o = i * 4;
          rgba[o] = r * alpha + rgba[o] * (1 - alpha);
          rgba[o + 1] = g * alpha + rgba[o + 1] * (1 - alpha);
          rgba[o + 2] = b * alpha + rgba[o + 2] * (1 - alpha);
          rgba[o + 3] = alpha + rgba[o + 3] * (1 - alpha);
        }
      }
    }
    return any ? encodeRgba({ rgba }) : null;
  }

  return {
    /** The build's status for /api/overture/layers. */
    status() {
      const m = manifest();
      if (!m)
        return {
          configured: false,
          ...(lastError ? { message: lastError } : {}),
        };
      return {
        configured: true,
        version: m.version,
        release: m.release,
        builtAt: m.builtAt,
        regions: m.regions,
        regionBoxes: m.regionBoxes,
        buildings: m.buildings,
        withHeight: m.totals?.withHeight || 0,
        attribution: m.attribution,
        license: m.license,
        maxZoom: OVERTURE_BUILDINGS_MAX_ZOOM,
        footprintZoom: OVERTURE_FOOTPRINT_ZOOM,
      };
    },
    /** One tile: {status, body?, version, empty?}. */
    tile(mode, ink, z, x, y) {
      const m = manifest();
      if (!m)
        return {
          status: 503,
          error: lastError || 'Overture buildings are not built',
        };
      return {
        status: 200,
        version: m.version,
        body: render(m, mode, ink, z, x, y),
      };
    },
    close: closeAll,
  };
}
