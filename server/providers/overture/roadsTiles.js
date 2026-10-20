// Personal fork: the Roads layer's tiles, click answers and Street assets'
// bike lanes, drawn and read from the files `npm run overture:build --
// --roads` writes. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { openBucket } from './buildingsFile.js';
import {
  ROADS_KIND,
  blockSide,
  blocksPerContainer,
  containerKey,
  eachRoad,
} from './roadsFile.js';
import { createCoverage } from '../riversV2/render.js';
import { encodeRgba } from '../census/render.js';
import {
  KMH_PER_MPH,
  OVERTURE_ROADS_MAX_ZOOM,
  ROAD_BLOCK_MARGIN,
  ROAD_FLAGS,
  ROAD_LEVELS,
  ROAD_MODES,
  ROAD_INKS,
  ROAD_SOURCES,
  ROAD_SUBCLASSES,
  ROAD_SURFACES,
  roadClassByCode,
  roadLevelForZoom,
  roadWidth,
  segmentColor,
  segmentMinZoom,
  speedLabel,
} from '../../../src/data/overtureRoads.js';

const TILE = 256;
/** current.json is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;
/** A tunnel is drawn this faint; a road under construction too. */
const UNDER_ALPHA = 0.45;
/** A click finds a road within this many pixels. */
export const NEAREST_PX = 8;
/** A path, sidewalk or crossing counts this many pixels further than it is. */
export const PATH_PENALTY_PX = 3;
/** Street assets' bike lanes: at most this many lines in a box. */
export const BIKE_LINE_LIMIT = 3000;
/** …and at most this many middle points, for the counts. */
export const BIKE_POINT_LIMIT = 12_000;
/** Path classes a bike sign makes a shared path (a road with one is not a bike lane). */
const PATH_CLASSES = new Set([
  'pedestrian',
  'footway',
  'steps',
  'path',
  'track',
  'bridleway',
]);

const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Level units → [lon, lat]. */
export function unitsToLonLat(x, y, bits) {
  const scale = 2 ** bits;
  return [
    (x / scale) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI,
  ];
}
/** [lon, lat] → level units (fractional). */
export function lonLatToUnits(lon, lat, bits) {
  const scale = 2 ** bits;
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * scale,
    (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * scale,
  ];
}

/** Whether a segment is a path, or a sidewalk or crossing of a road. */
function isPathLike(record) {
  const key = roadClassByCode(record.code)?.key;
  const sub = ROAD_SUBCLASSES[record.subclass];
  return (
    PATH_CLASSES.has(key) ||
    key === 'cycleway' ||
    sub === 'sidewalk' ||
    sub === 'crosswalk'
  );
}

/** The squared distance from (px, py) to a polyline [x, y, …]. */
function distance2(points, px, py) {
  let best = Infinity;
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2];
    const ay = points[i - 1];
    const dx = points[i] - ax;
    const dy = points[i + 1] - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2
      ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2))
      : 0;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < best) best = d2;
  }
  return best;
}

/** What a segment says on a card: words for its codes. */
export function describeSegment(record, bits) {
  const entry = roadClassByCode(record.code);
  const flags = record.flags;
  const line = [];
  for (let i = 0; i < record.points.length; i += 2)
    line.push(
      unitsToLonLat(record.points[i], record.points[i + 1], bits).map(
        (v) => Math.round(v * 1e6) / 1e6,
      ),
    );
  return {
    name: record.name || '',
    class: entry?.key || 'unknown',
    subclass: ROAD_SUBCLASSES[record.subclass] || '',
    speed: record.speed || 0,
    speedUnit: record.speed ? (flags & ROAD_FLAGS.mph ? 'mph' : 'km/h') : '',
    speedLabel: speedLabel(record.speed, flags),
    speedKmh: record.speed
      ? Math.round(
          flags & ROAD_FLAGS.mph ? record.speed * KMH_PER_MPH : record.speed,
        )
      : 0,
    surface: ROAD_SURFACES[record.surface] || '',
    bridge: Boolean(flags & ROAD_FLAGS.bridge),
    tunnel: Boolean(flags & ROAD_FLAGS.tunnel),
    link: Boolean(flags & ROAD_FLAGS.link),
    construction: Boolean(flags & ROAD_FLAGS.construction),
    bicycle:
      flags & ROAD_FLAGS.bikeDesignated
        ? 'designated'
        : flags & ROAD_FLAGS.bikeAllowed
          ? 'allowed'
          : flags & ROAD_FLAGS.bikeDenied
            ? 'denied'
            : '',
    source: ROAD_SOURCES[record.source] || 'OpenStreetMap',
    line,
  };
}

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number, maxBlocks?: number}} options
 *   `dir`: the roads build's directory (overtureRoadsDir).
 */
export function createRoadsTiles({
  dir,
  now = () => Date.now(),
  maxOpen = 64,
  maxBlocks = 96,
}) {
  const pointer = path.join(dir, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  const open = new Map(); // file → bucket (LRU by insertion)
  const blocks = new Map(); // "level/bx/by" → records (LRU by insertion)

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
    blocks.clear();
  }

  function manifest() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
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
      console.warn('[Overture] roads not readable:', lastError);
    }
    return held?.manifest || null;
  }

  function bucket(file) {
    let b = open.get(file);
    if (b) {
      open.delete(file);
      open.set(file, b);
      return b;
    }
    b = openBucket(path.join(dir, 'containers', file));
    open.set(file, b);
    if (open.size > maxOpen) {
      const [oldest, value] = open.entries().next().value;
      value.close();
      open.delete(oldest);
    }
    return b;
  }

  /** A block's records (kept a while: neighbouring tiles share blocks). */
  function block(m, level, bx, by) {
    const key = `${level}/${bx}/${by}`;
    let records = blocks.get(key);
    if (records) {
      blocks.delete(key);
      blocks.set(key, records);
      return records;
    }
    const { block: bz, container } = ROAD_LEVELS[level];
    records = [];
    const shift = 2 ** (bz - container);
    const cx = Math.floor(bx / shift);
    const cy = Math.floor(by / shift);
    const entry = m.containers[String(containerKey(level, cx, cy))];
    if (entry) {
      const per = blocksPerContainer(level);
      const raw = bucket(entry.file).block(
        ROADS_KIND,
        (by - cy * per) * per + (bx - cx * per),
      );
      if (raw) {
        const side = blockSide(level);
        eachRoad(raw, bx * side, by * side, (record) => {
          // Each line's box, for the tests below.
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          const p = record.points;
          for (let i = 0; i < p.length; i += 2) {
            if (p[i] < x0) x0 = p[i];
            if (p[i] > x1) x1 = p[i];
            if (p[i + 1] < y0) y0 = p[i + 1];
            if (p[i + 1] > y1) y1 = p[i + 1];
          }
          records.push({ ...record, box: [x0, y0, x1, y1] });
        });
      }
    }
    blocks.set(key, records);
    if (blocks.size > maxBlocks) blocks.delete(blocks.keys().next().value);
    return records;
  }

  /** Visit the records of a level meeting a box in its units. */
  function eachIn(m, level, x0, y0, x1, y1, visit) {
    const side = blockSide(level);
    const margin = side * ROAD_BLOCK_MARGIN;
    const limit = 2 ** ROAD_LEVELS[level].block - 1;
    const bx0 = Math.max(0, Math.floor((x0 - margin) / side));
    const bx1 = Math.min(limit, Math.floor((x1 + margin) / side));
    const by0 = Math.max(0, Math.floor((y0 - margin) / side));
    const by1 = Math.min(limit, Math.floor((y1 + margin) / side));
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        for (const record of block(m, level, bx, by)) {
          const [rx0, ry0, rx1, ry1] = record.box;
          if (rx1 < x0 || rx0 > x1 || ry1 < y0 || ry0 > y1) continue;
          visit(record);
        }
  }

  /** One tile's PNG, or null when nothing is drawn on it. */
  function render(m, mode, ink, z, x, y) {
    const level = roadLevelForZoom(z);
    const span = 2 ** (level.bits - z);
    const scale = TILE / span;
    const ox = x * span;
    const oy = y * span;
    // Lines reach past the tile by half their width.
    const pad = 6 / scale;
    const groups = new Map(); // "rank|colour|width|alpha" → [pixel lines]
    eachIn(
      m,
      level.index,
      ox - pad,
      oy - pad,
      ox + span + pad,
      oy + span + pad,
      (record) => {
        if (segmentMinZoom(record.code, record.flags) > z) return;
        let color = segmentColor(mode, ink, record);
        if (mode === 'speed' && record.speed) {
          // Colours in steps of 10 km/h: fewer rasters to draw.
          const kmh =
            record.flags & ROAD_FLAGS.mph
              ? record.speed * KMH_PER_MPH
              : record.speed;
          color = segmentColor(mode, ink, {
            ...record,
            flags: record.flags & ~ROAD_FLAGS.mph,
            speed: Math.round(kmh / 10) * 10,
          });
        }
        const under =
          record.flags & (ROAD_FLAGS.tunnel | ROAD_FLAGS.construction);
        const width = Math.round(roadWidth(record.code, z) * 4) / 4;
        // Minor classes first, motorways last (on top); bridges over all.
        const rank =
          (record.flags & ROAD_FLAGS.bridge ? 100 : 0) + (40 - record.code);
        const key = `${String(rank).padStart(3, '0')}|${color}|${width}|${under ? UNDER_ALPHA : 1}`;
        const pixels = new Float64Array(record.points.length);
        for (let i = 0; i < pixels.length; i += 2) {
          pixels[i] = (record.points[i] - ox) * scale;
          pixels[i + 1] = (record.points[i + 1] - oy) * scale;
        }
        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));
        list.push(pixels);
      },
    );
    if (!groups.size) return null;
    const rgba = new Float32Array(TILE * TILE * 4);
    let drawn = false;
    for (const key of [...groups.keys()].sort()) {
      const [, color, width, alpha] = key.split('|');
      const coverage = createCoverage(TILE);
      for (const line of groups.get(key))
        coverage.polyline(line, Number(width));
      if (coverage.empty) continue;
      drawn = true;
      const [r, g, b] = hexRgb(color);
      const a = Number(alpha);
      const values = coverage.values;
      for (let i = 0; i < values.length; i++) {
        const c = values[i] * a;
        if (c <= 0) continue;
        const at = i * 4;
        const keep = 1 - c;
        rgba[at] = r * c + rgba[at] * keep;
        rgba[at + 1] = g * c + rgba[at + 1] * keep;
        rgba[at + 2] = b * c + rgba[at + 2] * keep;
        rgba[at + 3] = c + rgba[at + 3] * keep;
      }
    }
    return drawn ? encodeRgba({ rgba }) : null;
  }

  const notBuilt = () => ({
    status: 503,
    error: lastError || 'Overture roads are not built',
  });

  return {
    /** The build's status for /api/roads/layers. */
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
        segments: m.segments,
        attribution: m.attribution,
        license: m.license,
        maxZoom: OVERTURE_ROADS_MAX_ZOOM,
      };
    },

    /** One tile: {status, version, body: Buffer|null} (null: nothing drawn). */
    tile(mode, ink, z, x, y) {
      if (!ROAD_MODES.includes(mode) || !ROAD_INKS.includes(ink))
        return { status: 404, error: 'No such mode or ink' };
      const m = manifest();
      if (!m) return notBuilt();
      return {
        status: 200,
        version: m.version,
        body: render(m, mode, ink, z, x, y),
      };
    },

    /**
     * The road nearest a point among those drawn at a zoom, within
     * NEAREST_PX pixels: {status, body: {version, segment|null}}.
     */
    nearest({ lon, lat, zoom }) {
      const m = manifest();
      if (!m) return notBuilt();
      const z = Math.max(
        0,
        Math.min(OVERTURE_ROADS_MAX_ZOOM, Math.floor(zoom)),
      );
      const level = roadLevelForZoom(z);
      const [px, py] = lonLatToUnits(lon, lat, level.bits);
      const radius = NEAREST_PX * 2 ** (level.bits - z - 8);
      const penalty = PATH_PENALTY_PX * 2 ** (level.bits - z - 8);
      let best = null;
      let bestScore = radius + penalty;
      let bestD2 = Infinity;
      eachIn(
        m,
        level.index,
        px - radius,
        py - radius,
        px + radius,
        py + radius,
        (record) => {
          if (segmentMinZoom(record.code, record.flags) > z) return;
          const d2 = distance2(record.points, px, py);
          if (d2 > radius * radius) return;
          // A path or a sidewalk counts as further than it is: a click on
          // a street finds the street, not the pavement mapped beside it.
          const score = Math.sqrt(d2) + (isPathLike(record) ? penalty : 0);
          // Ties to the bigger road (a motorway over its own link).
          if (
            score < bestScore ||
            (score === bestScore && best && record.code < best.code)
          ) {
            bestScore = score;
            bestD2 = d2;
            best = { ...record, points: Array.from(record.points) };
          }
        },
      );
      if (!best)
        return { status: 200, body: { version: m.version, segment: null } };
      const unitM =
        (40075016.686 / 2 ** level.bits) * Math.cos((lat * Math.PI) / 180);
      return {
        status: 200,
        body: {
          version: m.version,
          segment: {
            ...describeSegment(best, level.bits),
            distanceM: Math.round(Math.sqrt(bestD2) * unitM * 10) / 10,
          },
        },
      };
    },

    /**
     * Street assets' bike lanes in a box: cycleways and paths signed for
     * bikes (designated or allowed), from the finest level, as lines:
     * {status, body: {version, lines: [{kind, name, surface, line}],
     * saturated}}; with `points`, each line's middle point alone, for the
     * counts: {version, points: [[lon, lat]], saturated}.
     */
    bikeLines({
      west,
      south,
      east,
      north,
      points = false,
      limit = points ? BIKE_POINT_LIMIT : BIKE_LINE_LIMIT,
    }) {
      const m = manifest();
      if (!m) return notBuilt();
      const level = ROAD_LEVELS[ROAD_LEVELS.length - 1];
      const [x0, y1] = lonLatToUnits(west, south, level.bits);
      const [x1, y0] = lonLatToUnits(east, north, level.bits);
      const lines = [];
      let saturated = false;
      eachIn(m, level.index, x0, y0, x1, y1, (record) => {
        const entry = roadClassByCode(record.code);
        const cycleway = entry?.key === 'cycleway';
        const signed =
          PATH_CLASSES.has(entry?.key) &&
          record.flags & (ROAD_FLAGS.bikeDesignated | ROAD_FLAGS.bikeAllowed);
        if (!cycleway && !signed) return;
        if (lines.length >= limit) {
          saturated = true;
          return;
        }
        if (points) {
          const p = record.points;
          const m = Math.floor(p.length / 4) * 2;
          lines.push(
            unitsToLonLat(p[m], p[m + 1], level.bits).map(
              (v) => Math.round(v * 1e6) / 1e6,
            ),
          );
          return;
        }
        const described = describeSegment(record, level.bits);
        lines.push({
          kind: cycleway ? 'cycleway' : 'shared-path',
          name: described.name,
          surface: described.surface,
          line: described.line,
        });
      });
      return {
        status: 200,
        body: points
          ? { version: m.version, points: lines, saturated }
          : { version: m.version, lines, saturated },
      };
    },

    close: closeAll,
  };
}
