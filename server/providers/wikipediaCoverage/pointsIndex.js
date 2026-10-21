// Personal fork: answers from the Wikipedia points index (pointsFile.js) for
// the Wikipedia layer's Articles mode. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { openBucket } from '../overture/buildingsFile.js';
import {
  OVERVIEW_MAX_ZOOM,
  POINT_KIND,
  FLAG_SECONDARY,
  WORLD_BITS,
  blockKey,
  bucketOfTile,
  eachBlockPoint,
  rankCompare,
  unitX,
  unitY,
} from './pointsFile.js';
import {
  WIKIPEDIA_POINTS_FULL_ZOOM,
  WIKIPEDIA_POINT_LIMIT,
  pointClassOfCode,
} from '../../../src/data/wikipediaPoints.js';

/** The most tiles one answer reads; past it, the next zoom up. */
export const MAX_TILES = 1024;
export const NEEDS_POINTS =
  'Run npm run wikipedia:build -- --points for the Wikipedia articles';

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const lonOf = (x) => (x / 2 ** WORLD_BITS) * 360 - 180;
const latOf = (y) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** WORLD_BITS))) * 180) /
  Math.PI;

/** A point as the layer reads it. */
export function pointAnswer(point) {
  return {
    id: `wp:${point.wiki}:${point.page}:${point.flags & FLAG_SECONDARY ? 's' : 'p'}:${point.x}:${point.y}`,
    page: point.page,
    ...(point.qid ? { qid: `Q${point.qid}` } : {}),
    title: point.title,
    ...(point.type ? { type: point.type } : {}),
    class: pointClassOfCode(point.cls).key,
    ...(point.dim ? { dim: point.dim } : {}),
    ...(point.bytes ? { bytes: point.bytes } : {}),
    ...(point.flags & FLAG_SECONDARY ? { secondary: true } : {}),
    at: [round6(lonOf(point.x + 0.5)), round6(latOf(point.y + 0.5))],
  };
}

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number}} options
 *   `dir`: the points directory (WIKIPEDIA_COVERAGE_DIR/points)
 */
export function createPointsIndex({
  dir,
  now = () => Date.now(),
  maxOpen = 64,
}) {
  const pointer = path.join(dir, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  const open = new Map();

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
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
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      closeAll();
      held = { manifest: value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      held = null;
      closeAll();
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Wikipedia] points not readable:', lastError);
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

  /** The file holding a tile's block at a zoom, or null. */
  function fileFor(m, tx, ty, zoom) {
    if (zoom <= OVERVIEW_MAX_ZOOM)
      return fileBucket(path.join(dir, m.overview.file));
    const entry = m.buckets[String(bucketOfTile(tx, ty, zoom))];
    return entry ? fileBucket(path.join(dir, 'buckets', entry.file)) : null;
  }

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
        builtAt: m.builtAt,
        dump: m.dump,
        points: m.points,
        secondary: m.secondary,
        wikis: m.wikis,
      };
    },

    /**
     * The articles in a box at a zoom: below the full zoom a tile's best
     * ranked, from it every one; at most `limit`, the best ranked kept.
     * @param {{west: number, south: number, east: number, north: number,
     *   zoom: number, secondary?: boolean, limit?: number}} query
     */
    points({
      west,
      south,
      east,
      north,
      zoom,
      secondary = false,
      limit = WIKIPEDIA_POINT_LIMIT,
    }) {
      const m = manifest();
      if (!m) return { status: 503, error: lastError || NEEDS_POINTS };
      const ranges =
        west <= east
          ? [[west, east]]
          : [
              [west, 180],
              [-180, east],
            ];
      const y0 = unitY(north);
      const y1 = unitY(south);
      let level = Math.max(
        0,
        Math.min(WIKIPEDIA_POINTS_FULL_ZOOM, Math.floor(zoom)),
      );
      const tilesAt = (z) => {
        const shift = WORLD_BITS - z;
        let count = 0;
        for (const [w, e] of ranges)
          count +=
            ((unitX(e) >>> shift) - (unitX(w) >>> shift) + 1) *
            ((y1 >>> shift) - (y0 >>> shift) + 1);
        return count;
      };
      while (level > 0 && tilesAt(level) > MAX_TILES) level -= 1;
      const shift = WORLD_BITS - level;
      const found = [];
      for (const [w, e] of ranges) {
        const x0 = unitX(w);
        const x1 = unitX(e);
        for (let ty = y0 >>> shift; ty <= y1 >>> shift; ty++)
          for (let tx = x0 >>> shift; tx <= x1 >>> shift; tx++) {
            const raw = fileFor(m, tx, ty, level)?.block(
              POINT_KIND + level,
              blockKey(tx, ty, level),
            );
            if (!raw) continue;
            eachBlockPoint(raw, (point) => {
              if (!secondary && point.flags & FLAG_SECONDARY) return;
              if (point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1)
                return;
              found.push(point);
            });
          }
      }
      found.sort(rankCompare);
      const kept = found.slice(0, limit);
      return {
        status: 200,
        version: m.version,
        body: {
          zoom: level,
          count: kept.length,
          candidates: found.length,
          saturated: found.length > kept.length,
          points: kept.map(pointAnswer),
        },
      };
    },

    close: closeAll,
  };
}
