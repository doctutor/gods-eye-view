// Personal fork: the Overture division areas for the Administrative
// boundaries layer: which region and county a clicked point is in, the
// units' translucent fills, and the countries' coasts, from the build
// `npm run overture:areas` writes. Not part of upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { keepTile } from './common/tileCache.js';
import { defaultSourceRoot } from './common/source-root.js';
import { overtureCacheDir } from './overture/sources.js';
import { openLevel } from './riversV2/levelFile.js';
import { EMPTY_PNG, encodePng } from './riversV2/render.js';
import { validTile, worldX, worldY } from './riversV2/tileMath.js';
import {
  BANDS,
  INKS,
  MAX_ZOOM,
  bandForZoom,
} from './overtureBoundaries/bands.js';
import { renderTileCoverage } from './overtureBoundaries/tiles.js';
import {
  AREA_INDEX_MAX_ZOOM,
  decodeAreaRecord,
  hashText,
  polygonsHold,
} from './overtureAreas/format.js';
import {
  TILE_SIZE,
  encodeRgbaPng,
  fillPolygons,
} from './overtureAreas/fill.js';
import {
  AREA_FILL_ALPHA,
  AREA_FILL_PALETTE,
  OVERTURE_AREAS_ENDPOINT,
  OVERTURE_BOUNDARIES_ATTRIBUTION,
} from '../../src/data/overtureBoundaries.js';

/**
 * Overture's division_area polygons (land; countries' and dependencies'
 * territorial seas too), read by offset from the build's areas file:
 *
 *   GET /api/boundaries/areas/layers
 *       whether a build is there, its fill and coast tile versions
 *   GET /api/boundaries/areas/identify?lat=<lat>&lon=<lon>
 *       the country (or dependency), region and county the point is in,
 *       each {id, name, nameEn, subtype, country, region}; at sea, the
 *       country whose territorial sea it is, if any
 *   GET /api/boundaries/areas/fill/<regions|districts>/<z>/<x>/<y>[?v=]
 *       the region or county units filled, one stable colour each
 *   GET /api/boundaries/areas/coast/<ink>/<z>/<x>/<y>[?v=]
 *       the countries' and dependencies' land outlines in the ink
 *
 * A point is looked up in the build's multi-level grid (one cell per zoom),
 * then tested against each candidate's finest polygons; decoded polygons
 * are kept up to a budget of points.
 */

export const NEEDS_AREAS_BUILD =
  'Run npm run overture:areas to build the Overture division areas';
/** The fill sets and the subtype each fills. */
export const FILL_SETS = Object.freeze({
  regions: 'region',
  districts: 'county',
});
const STAT_EVERY_MS = 5000;
/** Decoded polygons kept, in points (about 8 bytes each). */
const KEPT_POINTS = 12_000_000;
/** Units much smaller than a tile pixel are not drawn: zooms this far past the tile's. */
const FILL_DEPTH = 6;
export const RENDERER_VERSION = 1;

/** The build's directory: build/areas in the Overture cache. */
export const areasDir = (env = process.env, sourceRoot = defaultSourceRoot) =>
  path.join(overtureCacheDir(env, sourceRoot), 'build', 'areas');

const version = (kind, key, buildId) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        renderer: RENDERER_VERSION,
        kind,
        key,
        bands: BANDS,
        palette: kind === 'fill' ? AREA_FILL_PALETTE : undefined,
        alpha: kind === 'fill' ? AREA_FILL_ALPHA : undefined,
        ink: kind === 'coast' ? INKS[key] : undefined,
        build: String(buildId),
      }),
    )
    .digest('hex')
    .slice(0, 12);

/** A unit's fill colour: by its id, stable across builds. */
export const unitColour = (id) =>
  AREA_FILL_PALETTE[hashText(id) % AREA_FILL_PALETTE.length];

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number, dir?: string}} [options]
 */
export function createOvertureAreasService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = areasDir(env, sourceRoot),
} = {}) {
  const manifestFile = path.join(dir, 'manifest.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  /** `${unit}:${level}` → decoded polygons, least recently used first. */
  const decoded = new Map();
  let decodedPoints = 0;
  const drawing = new Map();

  function close(open) {
    if (!open) return;
    try {
      fs.closeSync(open.fd);
    } catch {
      /* closed */
    }
    for (const level of open.coasts.values()) level.close();
  }

  function build() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
      return held?.value || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(manifestFile);
    } catch {
      close(held?.value);
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.value;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const units = JSON.parse(
        fs.readFileSync(path.join(dir, manifest.files.units), 'utf8'),
      );
      const rawIndex = JSON.parse(
        fs.readFileSync(path.join(dir, manifest.files.index), 'utf8'),
      );
      const index = new Map(
        Object.entries(rawIndex).map(([zoom, cells]) => [
          Number(zoom),
          new Map(
            Object.entries(cells).map(([cell, list]) => [Number(cell), list]),
          ),
        ]),
      );
      const coasts = new Map(
        (manifest.coasts || []).map((entry) => [
          entry.level,
          openLevel(path.join(dir, ...entry.file.split('/'))),
        ]),
      );
      const value = {
        manifest,
        units,
        index,
        coasts,
        fd: fs.openSync(path.join(dir, manifest.files.areas), 'r'),
        versions: {
          fill: Object.fromEntries(
            Object.keys(FILL_SETS).map((set) => [
              set,
              version('fill', set, manifest.buildId),
            ]),
          ),
          coast: Object.fromEntries(
            Object.keys(INKS).map((ink) => [
              ink,
              version('coast', ink, manifest.buildId),
            ]),
          ),
        },
      };
      close(held?.value);
      decoded.clear();
      decodedPoints = 0;
      held = { value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      close(held?.value);
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Areas] build not readable:', lastError);
    }
    return held?.value || null;
  }

  /** A unit's polygons at a band level (index into BANDS), decoded and kept. */
  function polygonsOf(open, unit, level) {
    const key = `${unit}:${level}`;
    const known = decoded.get(key);
    if (known) {
      decoded.delete(key);
      decoded.set(key, known);
      return known.polygons;
    }
    const entry = open.units[unit];
    const bytes = Buffer.alloc(entry.lengths[level]);
    fs.readSync(open.fd, bytes, 0, bytes.length, entry.offsets[level]);
    const polygons = decodeAreaRecord(bytes);
    let points = 0;
    for (const rings of polygons)
      for (const ring of rings) points += ring.length / 2;
    decoded.set(key, { polygons, points });
    decodedPoints += points;
    for (const [old, value] of decoded) {
      if (decodedPoints <= KEPT_POINTS || old === key) break;
      decoded.delete(old);
      decodedPoints -= value.points;
    }
    return polygons;
  }

  /** The units whose index cells hold a world point, any zoom. */
  function candidatesAt(open, x, y) {
    const out = new Set();
    for (let zoom = 0; zoom <= AREA_INDEX_MAX_ZOOM; zoom++) {
      const cells = open.index.get(zoom);
      if (!cells) continue;
      const n = 2 ** zoom;
      const cell =
        Math.min(n - 1, Math.floor(y * n)) * n +
        Math.min(n - 1, Math.floor(x * n));
      for (const unit of cells.get(cell) || []) out.add(unit);
    }
    return out;
  }

  /** The units whose boxes meet a tile's world box, down to `maxZoom` of the index. */
  function candidatesIn(open, box, maxZoom) {
    const out = new Set();
    for (let zoom = 0; zoom <= Math.min(AREA_INDEX_MAX_ZOOM, maxZoom); zoom++) {
      const cells = open.index.get(zoom);
      if (!cells) continue;
      const n = 2 ** zoom;
      // A unit is filed in up to 2 × 2 cells from its box's corner: look one
      // cell back as well.
      const cx0 = Math.max(0, Math.floor(box.x0 * n) - 1);
      const cx1 = Math.min(n - 1, Math.floor(box.x1 * n));
      const cy0 = Math.max(0, Math.floor(box.y0 * n) - 1);
      const cy1 = Math.min(n - 1, Math.floor(box.y1 * n));
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++)
          for (const unit of cells.get(cy * n + cx) || []) out.add(unit);
    }
    return out;
  }

  const describe = (entry) => ({
    id: entry.id,
    name: entry.name,
    nameEn: entry.nameEn || null,
    subtype: entry.subtype,
    country: entry.country,
    region: entry.region,
  });

  const tileBox = (z, x, y) => ({
    x0: x / 2 ** z,
    y0: y / 2 ** z,
    x1: (x + 1) / 2 ** z,
    y1: (y + 1) / 2 ** z,
  });

  async function cachedTile(file, draw, label) {
    try {
      return { status: 200, body: fs.readFileSync(file), cached: true };
    } catch {
      /* not on disk */
    }
    let pending = drawing.get(file);
    if (!pending) {
      pending = Promise.resolve()
        .then(draw)
        .then((body) => {
          if (body) keepTile(file, body, { label, empty: false });
          return body;
        })
        .finally(() => drawing.delete(file));
      drawing.set(file, pending);
    }
    const body = await pending;
    return { status: 200, body: body || EMPTY_PNG, empty: !body };
  }

  return {
    async layers() {
      const open = build();
      if (!open)
        return {
          configured: false,
          message: lastError
            ? `The Overture division areas build is not readable: ${lastError}`
            : NEEDS_AREAS_BUILD,
          attribution: OVERTURE_BOUNDARIES_ATTRIBUTION,
        };
      const { manifest } = open;
      return {
        configured: true,
        builtAt: manifest.builtAt,
        buildId: manifest.buildId,
        release: manifest.release || null,
        units: manifest.units,
        attribution: OVERTURE_BOUNDARIES_ATTRIBUTION,
        versions: open.versions,
        maxZoom: MAX_ZOOM,
      };
    },

    /** The units a point is in, by subtype; the territorial sea at sea. */
    identify(lat, lon) {
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 85.05 ||
        Math.abs(lon) > 180
      )
        return { status: 400, body: { error: 'Bad point' } };
      const open = build();
      if (!open) return { status: 503, body: { error: NEEDS_AREAS_BUILD } };
      const x = worldX(lon);
      const y = worldY(lat);
      const finest = BANDS.length - 1;
      const bits = open.manifest.levels[finest].quantBits;
      const qx = x * 2 ** bits;
      const qy = y * 2 ** bits;
      /** subtype → {entry, area} (the smallest box wins) */
      const found = {};
      let sea = null;
      for (const unit of candidatesAt(open, x, y)) {
        const entry = open.units[unit];
        const [x0, y0, x1, y1] = entry.box;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (!polygonsHold(polygonsOf(open, unit, finest), qx, qy)) continue;
        const area = (x1 - x0) * (y1 - y0);
        if (entry.kind === 'sea') {
          if (!sea || area < sea.area) sea = { entry, area };
          continue;
        }
        const slot = entry.subtype === 'dependency' ? 'country' : entry.subtype;
        if (!found[slot] || area < found[slot].area)
          found[slot] = { entry, area };
      }
      const units = Object.fromEntries(
        Object.entries(found).map(([slot, { entry }]) => [
          slot,
          describe(entry),
        ]),
      );
      const land = Object.keys(units).length > 0;
      return {
        status: 200,
        body: {
          lat,
          lon,
          land,
          units,
          sea: !land && sea ? describe(sea.entry) : null,
          buildId: open.manifest.buildId,
          attribution: OVERTURE_BOUNDARIES_ATTRIBUTION,
        },
      };
    },

    /** A fill tile: the set's units, one colour each. */
    async fill(set, z, x, y) {
      if (!Object.hasOwn(FILL_SETS, set))
        return { status: 404, error: 'No such set' };
      if (!validTile(z, x, y, MAX_ZOOM))
        return { status: 400, error: 'Tile out of range' };
      const open = build();
      if (!open) return { status: 503, error: NEEDS_AREAS_BUILD };
      const tileVersion = open.versions.fill[set];
      const file = path.join(
        dir,
        'tiles',
        'fill',
        set,
        tileVersion,
        String(z),
        String(x),
        `${y}.png`,
      );
      const answer = await cachedTile(
        file,
        () => this.drawFill(set, z, x, y),
        'Areas',
      );
      return { ...answer, contentType: 'image/png', version: tileVersion };
    },

    /** Draw a fill tile (no disk cache): a PNG, or null when empty. */
    drawFill(set, z, x, y) {
      const open = build();
      if (!open) return null;
      const band = bandForZoom(z);
      const level = BANDS.indexOf(band);
      const bits = open.manifest.levels[level].quantBits;
      const box = tileBox(z, x, y);
      const subtype = FILL_SETS[set];
      const scale = (TILE_SIZE * 2 ** z) / 2 ** bits;
      const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
      const alpha = Math.round(AREA_FILL_ALPHA * 255);
      let filled = 0;
      const units = [...candidatesIn(open, box, z + FILL_DEPTH)].filter(
        (unit) => {
          const entry = open.units[unit];
          if (entry.subtype !== subtype || entry.kind !== 'land') return false;
          const [x0, y0, x1, y1] = entry.box;
          return x1 >= box.x0 && x0 <= box.x1 && y1 >= box.y0 && y0 <= box.y1;
        },
      );
      for (const unit of units.sort((a, b) => a - b)) {
        const polygons = polygonsOf(open, unit, level).map((rings) =>
          rings.map((ring) => {
            const out = new Float64Array(ring.length);
            for (let k = 0; k < ring.length; k += 2) {
              out[k] = ring[k] * scale - x * TILE_SIZE;
              out[k + 1] = ring[k + 1] * scale - y * TILE_SIZE;
            }
            return out;
          }),
        );
        filled += fillPolygons(
          rgba,
          polygons,
          unitColour(open.units[unit].id),
          alpha,
        );
      }
      return filled ? encodeRgbaPng(rgba) : null;
    },

    /** A coast tile: the countries' and dependencies' land outlines in an ink. */
    async coast(ink, z, x, y) {
      if (!Object.hasOwn(INKS, ink))
        return { status: 404, error: 'No such ink' };
      if (!validTile(z, x, y, MAX_ZOOM))
        return { status: 400, error: 'Tile out of range' };
      const open = build();
      if (!open) return { status: 503, error: NEEDS_AREAS_BUILD };
      const tileVersion = open.versions.coast[ink];
      const file = path.join(
        dir,
        'tiles',
        'coast',
        ink,
        tileVersion,
        String(z),
        String(x),
        `${y}.png`,
      );
      const answer = await cachedTile(
        file,
        () => this.drawCoast(ink, z, x, y),
        'Areas',
      );
      return { ...answer, contentType: 'image/png', version: tileVersion };
    },

    /** Draw a coast tile (no disk cache): a PNG, or null when empty. */
    drawCoast(ink, z, x, y) {
      const open = build();
      if (!open) return null;
      const { coverage } = renderTileCoverage(open.coasts, z, x, y, 'coasts');
      return coverage.empty ? null : encodePng(coverage, INKS[ink]);
    },

    close() {
      close(held?.value);
      held = null;
    },
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const FILL_PATH =
  /^\/fill\/(regions|districts)\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;
const COAST_PATH = /^\/coast\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;

/** The routes under /api/boundaries/areas (same-site only, GET only). */
export function createOvertureAreasHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      if (route === '/identify') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        const answer = service.identify(lat, lon);
        return sendJson(res, answer.status, answer.body);
      }
      const fill = FILL_PATH.exec(route);
      const coast = COAST_PATH.exec(route);
      if (fill || coast) {
        const answer = fill
          ? await service.fill(
              fill[1],
              Number(fill[2]),
              Number(fill[3]),
              Number(fill[4]),
            )
          : await service.coast(
              coast[1],
              Number(coast[2]),
              Number(coast[3]),
              Number(coast[4]),
            );
        if (answer.status !== 200)
          return sendJson(res, answer.status, {
            error: answer.error || 'No tile',
          });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        const asked = url.searchParams.get('v');
        res.setHeader(
          'Cache-Control',
          asked && asked !== answer.version
            ? 'no-store'
            : 'private, max-age=86400',
        );
        res.setHeader('Content-Length', String(answer.body.length));
        res.end(answer.body);
        return;
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Areas] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Areas unavailable' });
    }
  };
}

let shared = null;

/** Vite plugin: /api/boundaries/areas for the Overture division areas. */
export function overtureAreasProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createOvertureAreasService({ sourceRoot });
    middlewares.use(
      OVERTURE_AREAS_ENDPOINT,
      createOvertureAreasHandler({ service: service || shared }),
    );
  }
  return {
    name: 'overture-areas',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
