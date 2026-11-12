// Personal fork: the treemap's cell labelling (docs/TREEMAP-PLAN.md, table
// 2): which country, region and district a point is in, from the Overture
// division areas build. Not part of upstream God's Eye View.
//
// The areas are drawn into label rasters, one z 6 tile at a time, at
// LABEL_PIXELS a side (a pixel is 2^-16 of the world: about 610 m at the
// equator, less toward the poles), from the finest band; a point reads its
// pixel. Exact point-in-polygon against a country of a million points is
// milliseconds a point; a tile's raster is drawn once for every point in
// it, so millions of points cost seconds. A point on a pixel no land unit
// covers (a coast, a harbour) takes the nearest labelled pixel within
// NEAR_PIXELS, else it is at sea (null).
import fs from 'node:fs';
import path from 'node:path';
import {
  AREA_INDEX_MAX_ZOOM,
  decodeAreaRecord,
} from '../overtureAreas/format.js';

/** Bumped when the labelling's rules change: the tables it labels rebuild. */
export const LABELLER_VERSION = 1;
export const LABEL_TILE_ZOOM = 6;
export const LABEL_PIXELS = 1024;
const NEAR_PIXELS = 2;
/** Tile rasters kept (each 3 × 2 MB). */
const KEPT_TILES = 24;
/** Decoded polygons kept, in points (about 8 bytes each). */
const KEPT_POINTS = 16_000_000;

const LAYERS = ['country', 'region', 'district'];
const layerOf = (unit) =>
  unit.subtype === 'country' || unit.subtype === 'dependency'
    ? 'country'
    : unit.subtype === 'region'
      ? 'region'
      : unit.subtype === 'county'
        ? 'district'
        : null;
const keyOf = (unit, layer) =>
  layer === 'country'
    ? unit.country
    : layer === 'region'
      ? unit.region || unit.id
      : unit.id;

/**
 * Fill a raster with a value inside polygons (even-odd), pixel centres.
 * @param {Uint16Array} raster size × size, row-major, row 0 north
 * @param {Int32Array[][]} polygons rings of [x, y, …] in world units × 2^bits
 * @param {{x0: number, y0: number, step: number, size: number}} frame
 *   the raster's corner and pixel size in the same units
 * @param {number} value
 */
export function fillRaster(raster, polygons, { x0, y0, step, size }, value) {
  for (const rings of polygons) {
    const rows = new Map();
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = ring[j * 2];
        const ay = ring[j * 2 + 1];
        const bx = ring[i * 2];
        const by = ring[i * 2 + 1];
        if (ay === by) continue;
        const low = Math.min(ay, by);
        const high = Math.max(ay, by);
        // Rows whose centre y (y0 + (r + 0.5) step) is in [low, high).
        const first = Math.max(0, Math.ceil((low - y0) / step - 0.5));
        const last = Math.min(
          size - 1,
          Math.ceil((high - y0) / step - 0.5) - 1,
        );
        for (let r = first; r <= last; r++) {
          const y = y0 + (r + 0.5) * step;
          const x = ax + ((y - ay) / (by - ay)) * (bx - ax);
          let list = rows.get(r);
          if (!list) rows.set(r, (list = []));
          list.push(x);
        }
      }
    }
    for (const [r, list] of rows) {
      list.sort((a, b) => a - b);
      const base = r * size;
      for (let k = 0; k + 1 < list.length; k += 2) {
        const from = Math.max(0, Math.ceil((list[k] - x0) / step - 0.5));
        const to = Math.min(
          size - 1,
          Math.ceil((list[k + 1] - x0) / step - 0.5) - 1,
        );
        for (let c = from; c <= to; c++) raster[base + c] = value;
      }
    }
  }
}

/**
 * @param {{areasDir: string}} options the Overture areas build
 */
export function createLabeller({ areasDir }) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(areasDir, 'manifest.json'), 'utf8'),
  );
  const units = JSON.parse(
    fs.readFileSync(path.join(areasDir, manifest.files.units), 'utf8'),
  );
  const rawIndex = JSON.parse(
    fs.readFileSync(path.join(areasDir, manifest.files.index), 'utf8'),
  );
  const index = new Map(
    Object.entries(rawIndex).map(([zoom, cells]) => [
      Number(zoom),
      new Map(
        Object.entries(cells).map(([cell, list]) => [Number(cell), list]),
      ),
    ]),
  );
  const finest = manifest.levels.length - 1;
  const bits = manifest.levels[finest].quantBits;
  const fd = fs.openSync(path.join(areasDir, manifest.files.areas), 'r');
  // Each layer's keys: raster value v is keys[layer][v - 1].
  const keys = Object.fromEntries(LAYERS.map((layer) => [layer, []]));
  const valueOf = new Map();
  units.forEach((unit, u) => {
    const layer = unit.kind === 'land' && unit.country ? layerOf(unit) : null;
    if (!layer) return;
    keys[layer].push(keyOf(unit, layer));
    valueOf.set(u, keys[layer].length);
  });
  const tiles = new Map();
  const decoded = new Map();
  let decodedPoints = 0;
  let drawn = 0;

  function polygonsOf(u) {
    const known = decoded.get(u);
    if (known) {
      decoded.delete(u);
      decoded.set(u, known);
      return known.polygons;
    }
    const unit = units[u];
    const bytes = Buffer.alloc(unit.lengths[finest]);
    fs.readSync(fd, bytes, 0, bytes.length, unit.offsets[finest]);
    const polygons = decodeAreaRecord(bytes);
    let points = 0;
    for (const rings of polygons)
      for (const ring of rings) points += ring.length / 2;
    decoded.set(u, { polygons, points });
    decodedPoints += points;
    for (const [old, value] of decoded) {
      if (decodedPoints <= KEPT_POINTS || old === u) break;
      decoded.delete(old);
      decodedPoints -= value.points;
    }
    return polygons;
  }

  /** The land units whose index cells meet a z 6 tile. */
  function candidates(tx, ty) {
    const out = new Set();
    const n6 = 2 ** LABEL_TILE_ZOOM;
    for (let zoom = 0; zoom <= AREA_INDEX_MAX_ZOOM; zoom++) {
      const cells = index.get(zoom);
      if (!cells) continue;
      const n = 2 ** zoom;
      const x0 = tx / n6;
      const y0 = ty / n6;
      const x1 = (tx + 1) / n6;
      const y1 = (ty + 1) / n6;
      // A unit is filed in up to 2 × 2 cells from its box's corner.
      const cx0 = Math.max(0, Math.floor(x0 * n) - 1);
      const cx1 = Math.min(n - 1, Math.ceil(x1 * n) - 1);
      const cy0 = Math.max(0, Math.floor(y0 * n) - 1);
      const cy1 = Math.min(n - 1, Math.ceil(y1 * n) - 1);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++)
          for (const u of cells.get(cy * n + cx) || []) {
            if (!valueOf.has(u)) continue;
            const box = units[u].box;
            if (box[2] < x0 || box[0] > x1 || box[3] < y0 || box[1] > y1)
              continue;
            out.add(u);
          }
    }
    return out;
  }

  function tile(tx, ty) {
    const key = ty * 2 ** LABEL_TILE_ZOOM + tx;
    const known = tiles.get(key);
    if (known !== undefined) {
      tiles.delete(key);
      tiles.set(key, known);
      return known;
    }
    const found = [...candidates(tx, ty)];
    let rasters = null;
    if (found.length) {
      // Larger units first, so an enclave or a disputed area lies on top.
      const size = (u) =>
        (units[u].box[2] - units[u].box[0]) *
        (units[u].box[3] - units[u].box[1]);
      found.sort((a, b) => size(b) - size(a));
      rasters = Object.fromEntries(
        LAYERS.map((layer) => [
          layer,
          new Uint16Array(LABEL_PIXELS * LABEL_PIXELS),
        ]),
      );
      const tileUnits = 2 ** (bits - LABEL_TILE_ZOOM);
      const frame = {
        x0: tx * tileUnits,
        y0: ty * tileUnits,
        step: tileUnits / LABEL_PIXELS,
        size: LABEL_PIXELS,
      };
      for (const u of found)
        fillRaster(
          rasters[layerOf(units[u])],
          polygonsOf(u),
          frame,
          valueOf.get(u),
        );
      drawn++;
    }
    tiles.set(key, rasters);
    for (const old of tiles.keys()) {
      if (tiles.size <= KEPT_TILES) break;
      tiles.delete(old);
    }
    return rasters;
  }

  /**
   * A point's units, by world position (x, y in 0..1, Web Mercator, y down).
   * @returns {{country: string, region: string|null, district: string|null} | null}
   */
  function labelWorld(x, y) {
    if (!(x >= 0 && x < 1 && y >= 0 && y < 1)) return null;
    const n = 2 ** LABEL_TILE_ZOOM;
    const tx = Math.floor(x * n);
    const ty = Math.floor(y * n);
    const rasters = tile(tx, ty);
    if (!rasters) return null;
    const col = Math.min(
      LABEL_PIXELS - 1,
      Math.floor((x * n - tx) * LABEL_PIXELS),
    );
    const row = Math.min(
      LABEL_PIXELS - 1,
      Math.floor((y * n - ty) * LABEL_PIXELS),
    );
    let at = row * LABEL_PIXELS + col;
    if (!rasters.country[at]) {
      at = -1;
      for (let d = 1; d <= NEAR_PIXELS && at < 0; d++)
        for (let dr = -d; dr <= d && at < 0; dr++)
          for (let dc = -d; dc <= d; dc++) {
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || c < 0 || r >= LABEL_PIXELS || c >= LABEL_PIXELS)
              continue;
            if (rasters.country[r * LABEL_PIXELS + c]) {
              at = r * LABEL_PIXELS + c;
              break;
            }
          }
      if (at < 0) return null;
    }
    const pick = (layer) => {
      const v = rasters[layer][at];
      return v ? keys[layer][v - 1] : null;
    };
    return {
      country: pick('country'),
      region: pick('region'),
      district: pick('district'),
    };
  }

  return {
    buildId: manifest.buildId,
    units,
    labelWorld,
    /** A point's units by longitude and latitude (degrees). */
    label(lon, lat) {
      if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 85.0511)) return null;
      const x = (lon + 180) / 360;
      const s = Math.sin((lat * Math.PI) / 180);
      const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      return labelWorld(Math.min(x, 1 - 1e-12), y);
    },
    stats: () => ({ tilesDrawn: drawn, decodedPoints }),
    close: () => fs.closeSync(fd),
  };
}
