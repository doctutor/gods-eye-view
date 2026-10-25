// Personal fork: answers from the river names sidecar (namesFile.js): the
// name of the river nearest a point, and the large named rivers' label
// points in a box. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import { openBucket } from '../overture/buildingsFile.js';

import {
  LABEL_ZOOM,
  LINE_ZOOM,
  NAMES_BUCKET_ZOOM,
  NAMES_KIND,
  SOURCE,
  SOURCE_KEYS,
  eachLine,
  openNamesFile,
  sourceOfTag,
  strahlerOfTag,
} from './namesFile.js';

export const NEEDS_NAMES = 'Run npm run rivers:names to name the rivers';
/** A small stream's line names a point within this many metres. */
export const NEAREST_MAX_M = 150;

/**
 * How far a named line may lie from a point and still name it, by the
 * river's Strahler order: a point on a wide river can be half its width
 * from the centreline OSM draws (and v2's reach sits up to 250 m from that
 * line, the sidecar matcher's tolerance from order 6). Measured from points
 * on the water, 2026-10-24: the Gwynns Falls (4) 124 m, the Potomac at
 * Georgetown (8) 84 m, the Hudson off Manhattan (8) 584 m, the Missouri at
 * St. Charles (9) 249 m, the Rio Negro at Manaus (9) 823 m, the Mississippi
 * at St. Louis (10) 100 m and at New Orleans (11) 292 m.
 */
export function nearestRadiusM(strahler) {
  const order = Number(strahler) || 0;
  if (order >= 12) return 2000;
  if (order >= 11) return 1500;
  if (order >= 9) return 1000;
  if (order >= 8) return 700;
  if (order >= 6) return 400;
  return NEAREST_MAX_M;
}
/** An OSM river with no v2 reach of its group nearby: a mid-size river's radius. */
const OSM_RIVER_RADIUS_M = 400;
/** The search reaches the largest radius. */
export const NEAREST_SEARCH_M = 2000;

/**
 * The name a point takes from the named lines near it ([{group, d, source,
 * strahler, waterway?}], `source` SOURCE.*): each name group sized by its
 * largest v2 order there (an OSM line by its group's reaches, else 400 m
 * for a river, 150 m for anything else), kept when one of its lines lies
 * within that radius, the group nearest for its size winning (distance ÷
 * radius), so a creek past 150 m never names a point in a wide river and
 * a river's centreline 800 m off does. Within the group a v2 reach's line
 * (direct or inherited) speaks before OSM's own. Returns {group, d, source,
 * strahler, radiusM} or null.
 */
export function chooseNearest(candidates, { maxM = NEAREST_SEARCH_M } = {}) {
  const groups = new Map();
  for (const c of candidates) {
    let g = groups.get(c.group);
    if (!g) groups.set(c.group, (g = { order: 0, osmRiver: false, lines: [] }));
    if (c.source !== SOURCE.osm) g.order = Math.max(g.order, c.strahler || 0);
    else if (c.waterway === 'river') g.osmRiver = true;
    g.lines.push(c);
  }
  let best = null;
  for (const [group, g] of groups) {
    const radiusM = Math.min(
      maxM,
      g.order
        ? nearestRadiusM(g.order)
        : g.osmRiver
          ? OSM_RIVER_RADIUS_M
          : NEAREST_MAX_M,
    );
    const inRange = g.lines.filter((line) => line.d <= radiusM);
    if (!inRange.length) continue;
    const reaches = inRange.filter((line) => line.source !== SOURCE.osm);
    const pick = (reaches.length ? reaches : inRange).reduce((a, b) =>
      b.d < a.d ? b : a,
    );
    const score = Math.min(...inRange.map((line) => line.d)) / radiusM;
    if (!best || score < best.score)
      best = {
        group,
        d: pick.d,
        source: pick.source,
        strahler: pick.strahler || g.order || 0,
        radiusM,
        score,
      };
  }
  if (!best) return null;
  const { score: _score, ...chosen } = best;
  return chosen;
}

const WORLD = 2 ** 28;
const mercX = (lon) =>
  Math.min(WORLD - 1, Math.max(0, Math.floor(((lon + 180) / 360) * WORLD)));
function mercY(lat) {
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
  return Math.min(WORLD - 1, Math.max(0, Math.floor(y * WORLD)));
}

/**
 * The river names' directory: names/ in the rivers cache (RIVERS_CACHE_DIR,
 * else .gev-cache/rivers), where `npm run rivers:names` writes it.
 */
export function riverNamesDir(env = process.env, sourceRoot = process.cwd()) {
  const dir = String(env.RIVERS_CACHE_DIR || '').trim();
  return path.join(
    dir
      ? path.resolve(sourceRoot, dir)
      : path.join(sourceRoot, '.gev-cache', 'rivers'),
    'names',
  );
}

/** Distance (m) from a point to a polyline [lon, lat, …], locally flat. */
export function distanceToLine(lat, lon, coords) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_574;
  let best = Infinity;
  for (let k = 0; k + 3 < coords.length; k += 2) {
    const ax = (coords[k] - lon) * kx;
    const ay = (coords[k + 1] - lat) * ky;
    const bx = (coords[k + 2] - lon) * kx;
    const by = (coords[k + 3] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * @param {{dir: string, now?: () => number, maxOpen?: number}} options
 */
export function createRiverNamesIndex({
  dir,
  now = () => Date.now(),
  maxOpen = 32,
}) {
  const pointer = path.join(dir, 'current.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  const open = new Map();

  function closeAll() {
    for (const bucket of open.values()) bucket.close();
    open.clear();
    held?.names?.close();
  }

  function current() {
    if (now() - checkedAt < 5000 && (held || lastError)) return held;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      closeAll();
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held;
    try {
      const { manifest: name } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (!/^manifest-[0-9a-f]{12}\.json$/.test(String(name)))
        throw new Error('current.json names no manifest');
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, name), 'utf8'),
      );
      closeAll();
      held = {
        manifest,
        names: openNamesFile(path.join(dir, manifest.names.file)),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      lastError = null;
    } catch (error) {
      closeAll();
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Rivers] names not readable:', lastError);
    }
    return held;
  }

  function bucket(m, key) {
    const entry = m.buckets[String(key)];
    if (!entry) return null;
    const file = path.join(dir, 'buckets', entry.file);
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

  /** The blocks of a kind at a zoom a box meets: visit(buffer). */
  function eachBlock(m, kind, zoom, [w, s, e, n], visit) {
    const shift = 28 - zoom;
    const side = 2 ** (zoom - NAMES_BUCKET_ZOOM);
    for (let tx = mercX(w) >>> shift; tx <= mercX(e) >>> shift; tx++)
      for (let ty = mercY(n) >>> shift; ty <= mercY(s) >>> shift; ty++) {
        const key =
          (ty >>> (zoom - NAMES_BUCKET_ZOOM)) * 2 ** NAMES_BUCKET_ZOOM +
          (tx >>> (zoom - NAMES_BUCKET_ZOOM));
        const raw = bucket(m, key)?.block(
          kind,
          (ty % side) * side + (tx % side),
        );
        if (raw) visit(raw);
      }
  }

  const describe = (names, group) => {
    const entry = names.name(group);
    if (!entry) return null;
    return {
      name: entry.name,
      ...(entry.nameEn && entry.nameEn !== entry.name
        ? { nameEn: entry.nameEn }
        : {}),
      ...(entry.wikidata ? { wikidata: entry.wikidata } : {}),
      ...(entry.waterway ? { waterway: entry.waterway } : {}),
    };
  };

  return {
    status() {
      const h = current();
      if (!h)
        return { built: false, ...(lastError ? { message: lastError } : {}) };
      return {
        built: true,
        version: h.manifest.version,
        builtAt: h.manifest.builtAt,
        rates: h.manifest.rates,
      };
    },

    /**
     * The name of the river at a point: the named lines within the search
     * (NEAREST_SEARCH_M, or `maxM`), each name sized by its river's order
     * (chooseNearest: a wide river's centreline far off, a creek only close
     * by), a named HydroSHEDS v2 reach (direct or inherited) before OSM's
     * own waterway of the same name; null when none.
     */
    nearest({ lat, lon, maxM = NEAREST_SEARCH_M }) {
      const h = current();
      if (!h) return null;
      const searchM = Math.min(maxM, NEAREST_SEARCH_M);
      const dLat = searchM / 110_574;
      const dLon =
        searchM / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
      const box = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
      // The nearest line of each name group and source, and the group's
      // largest order among its lines here.
      const found = new Map();
      eachBlock(h.manifest, NAMES_KIND.LINE, LINE_ZOOM, box, (raw) =>
        eachLine(raw, (group, tag, coords) => {
          const d = distanceToLine(lat, lon, coords);
          if (d > searchM) return;
          const source = sourceOfTag(tag);
          const strahler = strahlerOfTag(tag);
          const key = group * 4 + source;
          const held = found.get(key);
          if (!held) found.set(key, { group, d, source, strahler });
          else {
            if (d < held.d) held.d = d;
            if (strahler > held.strahler) held.strahler = strahler;
          }
        }),
      );
      const candidates = [...found.values()].map((c) =>
        c.source === SOURCE.osm
          ? { ...c, waterway: h.names.name(c.group)?.waterway || '' }
          : c,
      );
      const hit = chooseNearest(candidates, { maxM: searchM });
      if (!hit) return null;
      const name = describe(h.names, hit.group);
      return name
        ? {
            ...name,
            confidence: SOURCE_KEYS[hit.source],
            distanceM: Math.round(hit.d),
            radiusM: hit.radiusM,
            ...(hit.strahler ? { strahler: hit.strahler } : {}),
          }
        : null;
    },

    /** The large named rivers' label points in a box: [{name, nameEn?, at, strahler}]. */
    labels({ west, south, east, north, limit = 200 }) {
      const h = current();
      if (!h) return { status: 503, error: lastError || NEEDS_NAMES };
      const found = [];
      eachBlock(
        h.manifest,
        NAMES_KIND.LABEL,
        LABEL_ZOOM,
        [west, south, east, north],
        (raw) =>
          eachLine(raw, (group, tag, coords) => {
            const [lon, lat] = coords;
            if (lon < west || lon > east || lat < south || lat > north) return;
            found.push({ group, strahler: strahlerOfTag(tag), at: [lon, lat] });
          }),
      );
      found.sort((a, b) => b.strahler - a.strahler || a.group - b.group);
      const labels = found.slice(0, limit).map((label) => ({
        ...describe(h.names, label.group),
        strahler: label.strahler,
        at: [
          Math.round(label.at[0] * 1e5) / 1e5,
          Math.round(label.at[1] * 1e5) / 1e5,
        ],
      }));
      return {
        status: 200,
        version: h.manifest.version,
        body: { count: labels.length, labels },
      };
    },

    close: () => {
      closeAll();
      held = null;
    },
  };
}
