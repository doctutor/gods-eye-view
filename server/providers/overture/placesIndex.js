// Personal fork: answers from the Overture point indexes (placesFile.js):
// the Places layer's from the places (`npm run overture:build -- --places`)
// and Street assets' from the infrastructure (`-- --infrastructure`). Not
// part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { WORLD_BITS, openBucket, unitX, unitY } from './buildingsFile.js';
import {
  GLOBAL_RESOLUTIONS,
  PLACE_BLOCK_ZOOM,
  PLACE_BUCKET_ZOOM,
  PLACE_KIND,
  PLACE_RECORD_BYTES,
  decodeTexts,
  eachCountCell,
  latOfUnitY,
  lonOfUnitX,
  slotOf,
} from './placesFile.js';
import {
  CATEGORY_SLOTS,
  COUNT_THRESHOLDS,
  placeCategory,
  placeCategoryOfCode,
} from '../../../src/data/overturePlaces.js';
import {
  infrastructureClass,
  infrastructureClassOfCode,
} from '../../../src/data/overtureInfrastructure.js';

const SLOTS = CATEGORY_SLOTS * COUNT_THRESHOLDS.length;
const BLOCK_SHIFT = WORLD_BITS - PLACE_BLOCK_ZOOM;
const BLOCKS_PER_BUCKET = 2 ** (PLACE_BLOCK_ZOOM - PLACE_BUCKET_ZOOM);

/** The threshold index for a minimum confidence (0: ≥ 0.5, 1: ≥ 0.8). */
const thresholdIndex = (minConfidence) =>
  minConfidence >= COUNT_THRESHOLDS[1] ? 1 : 0;

const inWindow = (window, lat, lon) => {
  if (!window) return true;
  if (lat < window.south || lat > window.north) return false;
  return window.west <= window.east
    ? lon >= window.west && lon <= window.east
    : lon >= window.west || lon <= window.east;
};

/** A place's position hashed to a stable order (a 32-bit mix of x and y). */
export function spread(x, y) {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b) ^ y;
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The point indexes, by name: their directory under the cache, the words
 * their errors use, their ids' prefix and their categories (a key's code,
 * a code's key).
 */
export const POINT_INDEXES = Object.freeze({
  places: Object.freeze({
    name: 'places',
    words: 'Overture places',
    idPrefix: 'pl',
    codeOf: (key) => placeCategory(key)?.code || 0,
    keyOf: (code) => placeCategoryOfCode(code)?.key || 'other',
  }),
  infrastructure: Object.freeze({
    name: 'infrastructure',
    words: 'Overture infrastructure',
    idPrefix: 'in',
    codeOf: (key) => infrastructureClass(key)?.code || 0,
    keyOf: (code) => infrastructureClassOfCode(code)?.key || 'other',
  }),
});

/** The Places layer's index (dir/places). */
export const createPlacesIndex = (options) =>
  createPointIndex({ ...options, kind: POINT_INDEXES.places });
/** Street assets' index of Overture's infrastructure (dir/infrastructure). */
export const createInfrastructureIndex = (options) =>
  createPointIndex({ ...options, kind: POINT_INDEXES.infrastructure });

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number,
 *   kind?: object}} options
 *   `dir`: the Overture cache directory (its places/ or infrastructure/);
 *   `kind`: a POINT_INDEXES entry.
 */
export function createPointIndex({
  dir,
  now = () => Date.now(),
  maxOpen = 64,
  kind = POINT_INDEXES.places,
}) {
  const root = path.join(dir, kind.name);
  const pointer = path.join(root, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  const open = new Map();
  /** res → {cells: string[], lat, lon: Float32Array, counts: Uint32Array}. */
  const global = new Map();

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
    global.clear();
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
      console.warn(`[Overture] ${kind.name} not readable:`, lastError);
    }
    return held?.manifest || null;
  }

  function fileBucket(file) {
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

  function bucket(m, bx, by) {
    const entry = m.buckets[String(by * 2 ** PLACE_BUCKET_ZOOM + bx)];
    return entry ? fileBucket(path.join(root, 'buckets', entry.file)) : null;
  }

  /** A coarse resolution's counts, decoded once. */
  function globalCounts(m, res) {
    let table = global.get(res);
    if (table) return table;
    const raw = fileBucket(path.join(root, m.counts.file)).block(
      PLACE_KIND.H,
      res,
    );
    const cells = [];
    const lats = [];
    const lons = [];
    const vectors = [];
    if (raw)
      eachCountCell(raw, (cell, lat, lon, counts) => {
        cells.push(cell);
        lats.push(lat);
        lons.push(lon);
        const vector = new Uint32Array(SLOTS);
        for (const [slot, count] of counts) vector[slot] = count;
        vectors.push(vector);
      });
    table = {
      cells,
      lat: Float32Array.from(lats),
      lon: Float32Array.from(lons),
      counts: vectors,
    };
    global.set(res, table);
    return table;
  }

  const countOf = (vector, category, t) => {
    if (category) return vector[slotOf(category, t)];
    let sum = 0;
    for (let c = 1; c < CATEGORY_SLOTS; c++) sum += vector[slotOf(c, t)];
    return sum;
  };

  return {
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
        places: m.places,
        sources: m.stats?.byDataset || {},
        ...(m.stats?.byClass ? { byClass: m.stats.byClass } : {}),
      };
    },

    /**
     * H3 counts for a view: {cells: [[cell, count]], res, total}.
     * @param {{res: number, window: object|null, category?: string, minConfidence?: number}} query
     */
    counts({ res, window, category = 'all', minConfidence = 0.8 }) {
      const m = manifest();
      if (!m)
        return {
          status: 503,
          error: lastError || `${kind.words} are not built`,
        };
      const code = kind.codeOf(category);
      const t = thresholdIndex(minConfidence);
      const out = new Map();
      if (GLOBAL_RESOLUTIONS.includes(res)) {
        const table = globalCounts(m, res);
        for (let i = 0; i < table.cells.length; i++) {
          if (!inWindow(window, table.lat[i], table.lon[i])) continue;
          const count = countOf(table.counts[i], code, t);
          if (count) out.set(table.cells[i], count);
        }
      } else {
        // The buckets the window meets (each holds its own cells' counts).
        const w = window || { west: -180, south: -85, east: 180, north: 85 };
        const ranges =
          w.west <= w.east
            ? [[w.west, w.east]]
            : [
                [w.west, 180],
                [-180, w.east],
              ];
        const shift = WORLD_BITS - PLACE_BUCKET_ZOOM;
        for (const [west, east] of ranges)
          for (
            let by = unitY(w.north) >>> shift;
            by <= unitY(w.south) >>> shift;
            by++
          )
            for (
              let bx = unitX(west) >>> shift;
              bx <= unitX(east) >>> shift;
              bx++
            ) {
              const raw = bucket(m, bx, by)?.block(PLACE_KIND.H, res);
              if (!raw) continue;
              eachCountCell(raw, (cell, lat, lon, counts) => {
                if (!inWindow(window, lat, lon)) return;
                const count = code
                  ? counts.get(slotOf(code, t)) || 0
                  : [...counts].reduce(
                      (sum, [slot, n]) =>
                        Math.floor(slot / CATEGORY_SLOTS) === t ? sum + n : sum,
                      0,
                    );
                if (count) out.set(cell, (out.get(cell) || 0) + count);
              });
            }
      }
      let total = 0;
      for (const count of out.values()) total += count;
      return {
        status: 200,
        version: m.version,
        body: { res, total, cells: [...out] },
      };
    },

    /**
     * The places in a box: the most confident first, at most `limit`.
     * @param {{west: number, south: number, east: number, north: number,
     *   category?: string, minConfidence?: number, limit?: number}} query
     */
    pins({
      west,
      south,
      east,
      north,
      category = 'all',
      minConfidence = 0.8,
      limit = 1500,
    }) {
      const m = manifest();
      if (!m)
        return {
          status: 503,
          error: lastError || `${kind.words} are not built`,
        };
      const code = kind.codeOf(category);
      const floor = Math.round(minConfidence * 250);
      const x0 = unitX(west);
      const x1 = unitX(east);
      const y0 = unitY(north);
      const y1 = unitY(south);
      const candidates = [];
      const blocks = [];
      for (let ty = y0 >>> BLOCK_SHIFT; ty <= y1 >>> BLOCK_SHIFT; ty++)
        for (let tx = x0 >>> BLOCK_SHIFT; tx <= x1 >>> BLOCK_SHIFT; tx++) {
          const b = bucket(
            m,
            Math.floor(tx / BLOCKS_PER_BUCKET),
            Math.floor(ty / BLOCKS_PER_BUCKET),
          );
          if (!b) continue;
          const local =
            (ty % BLOCKS_PER_BUCKET) * BLOCKS_PER_BUCKET +
            (tx % BLOCKS_PER_BUCKET);
          const records = b.block(PLACE_KIND.P, local);
          if (!records) continue;
          const block = blocks.push({ b, local, texts: null }) - 1;
          for (
            let at = 0, i = 0;
            at < records.length;
            at += PLACE_RECORD_BYTES, i++
          ) {
            const confidence = records.readUInt8(at + 8);
            if (confidence < floor) break; // the most confident first
            const cat = records.readUInt8(at + 9);
            if (code && cat !== code) continue;
            const x = records.readUInt32LE(at);
            const y = records.readUInt32LE(at + 4);
            if (x < x0 || x > x1 || y < y0 || y > y1) continue;
            candidates.push({
              block,
              i,
              x,
              y,
              confidence,
              cat,
              rank: spread(x, y),
            });
          }
        }
      // The most confident first; ties (most of a city is at 100%) by a
      // hash of the position, so a saturated view keeps places all over it
      // rather than its north-west tiles, and the same ones as it pans.
      candidates.sort(
        (a, b) =>
          b.confidence - a.confidence ||
          a.rank - b.rank ||
          a.block - b.block ||
          a.i - b.i,
      );
      const kept = candidates.slice(0, limit);
      const places = kept.map((place) => {
        const block = blocks[place.block];
        block.texts ||= decodeTexts(block.b.block(PLACE_KIND.T, block.local));
        const text = block.texts[place.i] || {};
        return {
          id: `${kind.idPrefix}:${block.local}:${place.x}:${place.y}`,
          name: text.name,
          category: kind.keyOf(place.cat),
          ...(text.basic ? { basic: text.basic } : {}),
          ...(text.website ? { website: text.website } : {}),
          ...(text.phone ? { phone: text.phone } : {}),
          ...(text.brand ? { brand: text.brand } : {}),
          ...(text.source ? { source: text.source } : {}),
          confidence: Math.round(place.confidence * 4) / 1000,
          at: [
            Math.round(lonOfUnitX(place.x) * 1e6) / 1e6,
            Math.round(latOfUnitY(place.y) * 1e6) / 1e6,
          ],
        };
      });
      return {
        status: 200,
        version: m.version,
        body: {
          count: places.length,
          candidates: candidates.length,
          saturated: candidates.length > places.length,
          places,
        },
      };
    },

    close: closeAll,
  };
}
