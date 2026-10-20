// Personal fork: the Wikipedia coverage layer (src/layers/wikipediaCoverage/),
// served from a grid built by scripts/wikipedia/index.mjs. Not part of
// upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import {
  TILE_SIZE,
  VARIANTS,
  boxValues,
  encodeTile,
  openGrid,
  tileValues,
} from './wikipediaCoverage/grid.js';
import {
  H3_VARIANTS,
  RESOLUTIONS,
  openH3File,
  parseBbox,
  queryCells,
} from './wikipediaCoverage/h3.js';

/**
 * Where English Wikipedia has written about the Earth, from Wikimedia's
 * GeoData dump, binned by `npm run wikipedia:build` into
 * .gev-cache/wikipedia/grid.bin (or WIKIPEDIA_COVERAGE_DIR). Nothing is
 * fetched at request time: the grid is read from disk, a level at a time,
 * and read again when the file changes.
 *
 *   GET /api/wikipedia-coverage/layers
 *       whether a grid is built, when, from which dump, the variants with
 *       their colour-ramp domains, the legend's attribution
 *   GET /api/wikipedia-coverage/tile/<variant>/<z>/<x>/<y>
 *       the 256 × 256 cell values under a Web Mercator tile, resampled from
 *       the grid's pyramid: 'WCT1', width, height, dtype (uint32 each), then
 *       Float32 values; gzip when the browser accepts it
 *   GET /api/wikipedia-coverage/h3/<res>/<variant>?west=&south=&east=&north=
 *       the H3 cells (resolution 0–7, from h3.bin beside the grid) whose
 *       centres lie in the box, as [[index, value], …] with the
 *       resolution's ramp domain; west > east crosses the antimeridian;
 *       413 past H3_MAX_CELLS cells, 503 without the file
 *
 * Variants: `articles` (per km²), `text` (bytes of wikitext per km², when
 * the build included the page table), `count` (articles under each pixel
 * or in each hexagon).
 */

export const WIKIPEDIA_COVERAGE_ROUTE = '/api/wikipedia-coverage';
/** Below this the 0.05° cells are 18 px squares; Cesium upsamples deeper. */
export const MAX_ZOOM = 9;
export const ATTRIBUTION = 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData';
export const NEEDS_BUILD =
  'Run npm run wikipedia:build to build the Wikipedia coverage grid';
export const NEEDS_H3 =
  'Run npm run wikipedia:build to build the Wikipedia coverage hexagons';
/** More cells than this in one answer is a 413: ask at a coarser resolution. */
export const H3_MAX_CELLS = 20_000;
const CACHE_DIR = path.join('.gev-cache', 'wikipedia');
/** The grid file is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

/**
 * A file opened with `open` when it is first asked for, opened again when
 * it changes, and stat'ed at most every STAT_EVERY_MS.
 */
function createFileWatch(file, open, now, label) {
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;
  return {
    error: () => lastError,
    current() {
      if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
        return held?.value || null;
      checkedAt = now();
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        held = null;
        lastError = null;
        return null;
      }
      if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
        return held.value;
      try {
        held = { value: open(file), mtimeMs: stat.mtimeMs, size: stat.size };
        lastError = null;
      } catch (error) {
        held = null;
        lastError = String(error?.message || error).slice(0, 200);
        console.warn(`[WikipediaCoverage] ${label} not readable:`, lastError);
      }
      return held?.value || null;
    },
  };
}

/** The grid file the settings name (WIKIPEDIA_COVERAGE_DIR, else the cache). */
export function coverageGridFile(
  env = process.env,
  sourceRoot = defaultSourceRoot,
) {
  const dir = String(env.WIKIPEDIA_COVERAGE_DIR || '').trim();
  return path.join(
    dir ? path.resolve(sourceRoot, dir) : path.join(sourceRoot, CACHE_DIR),
    'grid.bin',
  );
}

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   gridFile?: string, h3File?: string, h3MaxCells?: number}} [options]
 */
export function createWikipediaCoverageService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  gridFile = coverageGridFile(env, sourceRoot),
  h3File = path.join(path.dirname(gridFile), 'h3.bin'),
  h3MaxCells = H3_MAX_CELLS,
} = {}) {
  const gridWatch = createFileWatch(gridFile, openGrid, now, 'grid');
  const h3Watch = createFileWatch(h3File, openH3File, now, 'h3.bin');
  /** The grid, opened (again) when the file is new or changed; null when none. */
  const grid = () => gridWatch.current();
  const hexes = () => h3Watch.current();

  /** What /layers says about the hexagons. */
  function h3Summary() {
    const open = hexes();
    if (!open) return { built: false };
    return {
      built: true,
      resolutions: open.resolutions,
      cells: Object.fromEntries(
        open.header.resolutions.map((entry) => [entry.res, entry.cells]),
      ),
      text: open.hasText,
      maxCells: h3MaxCells,
    };
  }

  return {
    /** The catalog: one layer, its variants and the ramp domains. */
    async layers() {
      const open = grid();
      if (!open)
        return {
          configured: false,
          message: gridWatch.error()
            ? `The Wikipedia coverage grid is not readable: ${gridWatch.error()}`
            : NEEDS_BUILD,
          attribution: ATTRIBUTION,
          variants: VARIANTS.map((key) => ({ key, available: false })),
          h3: h3Summary(),
        };
      const { header } = open;
      return {
        configured: true,
        builtAt: header.builtAt,
        dump: {
          date: header.dump?.date || null,
          lastModified: header.dump?.lastModified || null,
          url: header.dump?.url || null,
        },
        rows: { kept: header.rows?.kept ?? 0, read: header.rows?.read ?? 0 },
        text: Boolean(header.text?.included),
        tileUrl: `${WIKIPEDIA_COVERAGE_ROUTE}/tile/{variant}/{z}/{x}/{y}`,
        tileSize: TILE_SIZE,
        maxZoom: MAX_ZOOM,
        attribution: ATTRIBUTION,
        variants: VARIANTS.map((key) => {
          const domain = header.domains?.[key] || null;
          const available = Boolean(domain) && (key !== 'text' || open.hasText);
          return {
            key,
            available,
            ...(available
              ? {
                  domain: {
                    min: domain.min,
                    max: domain.max,
                    median: domain.median,
                  },
                }
              : {}),
          };
        }),
        h3: h3Summary(),
      };
    },

    /**
     * The hexagons of a resolution whose centres lie in a box.
     * @returns {Promise<{status: number, body?: object, message?: string}>}
     */
    async h3(res, variant, box) {
      if (!RESOLUTIONS.includes(res))
        return { status: 400, message: 'Resolution must be 0 to 7' };
      if (!H3_VARIANTS.includes(variant))
        return { status: 400, message: 'No such variant' };
      if (!box)
        return {
          status: 400,
          message: 'west, south, east and north are degrees',
        };
      const open = hexes();
      if (!open) return { status: 503, message: NEEDS_H3 };
      if (variant === 'text' && !open.hasText)
        return {
          status: 404,
          message:
            'The hexagons were built without article sizes (npm run wikipedia:build -- --text)',
        };
      const table = open.table(res);
      const answer = queryCells(table, variant, box, { maxCells: h3MaxCells });
      if (answer.tooMany)
        return {
          status: 413,
          message: `More than ${h3MaxCells} cells at resolution ${res} in this box: ask at a coarser resolution or for a smaller box`,
        };
      const domain = table.domains?.[variant] || null;
      return {
        status: 200,
        body: {
          res,
          variant,
          dump: { date: open.header.dump?.date || null },
          domain: domain
            ? { min: domain.min, max: domain.max, median: domain.median }
            : null,
          cells: answer.cells,
        },
      };
    },

    /**
     * One tile's values.
     * @returns {Promise<{status: number, body?: Buffer, contentType?: string, error?: string}>}
     */
    async tile(variant, z, x, y) {
      if (!VARIANTS.includes(variant))
        return { status: 404, error: 'No such variant' };
      const limit = 2 ** z;
      if (
        !Number.isInteger(z) ||
        z < 0 ||
        z > MAX_ZOOM ||
        x >= limit ||
        y >= limit ||
        x < 0 ||
        y < 0
      )
        return { status: 400, error: 'Tile out of range' };
      const open = grid();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      if (variant === 'text' && !open.hasText)
        return {
          status: 404,
          error:
            'The grid was built without article sizes (npm run wikipedia:build -- --text)',
        };
      return {
        status: 200,
        contentType: 'application/octet-stream',
        body: encodeTile(tileValues(open, variant, z, x, y)),
      };
    },

    /**
     * Raster values (server/providers/rasterValues/): a variant over an
     * equal-angle box, cols × rows, as little-endian Float32.
     * @returns {{status: number, body?: Buffer, error?: string}}
     */
    values(variant, box, cols, rows) {
      if (!VARIANTS.includes(variant))
        return { status: 404, error: 'No such variant' };
      const open = grid();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      if (variant === 'text' && !open.hasText)
        return {
          status: 503,
          error:
            'The grid was built without article sizes (npm run wikipedia:build -- --text)',
        };
      const values = boxValues(open, variant, box, cols, rows);
      return {
        status: 200,
        body: Buffer.from(values.buffer, values.byteOffset, values.byteLength),
      };
    },
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const TILE_PATH = /^\/tile\/([a-z]{1,16})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/;
const H3_PATH = /^\/h3\/(\d{1,2})\/([a-z]{1,16})$/;

/** A JSON body, gzip when accepted, cached as the tiles are. */
function sendCached(req, res, payload) {
  const accepts = String(req.headers?.['accept-encoding'] || '');
  let body = Buffer.from(JSON.stringify(payload));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(accepts)) {
    body = zlib.gzipSync(body);
    res.setHeader('Content-Encoding', 'gzip');
  }
  res.setHeader('Content-Length', String(body.length));
  res.end(body);
}

/** The routes under /api/wikipedia-coverage (same-site only, GET only). */
export function createWikipediaCoverageHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const hex = H3_PATH.exec(route);
      if (hex) {
        const [, res_, variant] = hex;
        const answer = await service.h3(
          Number(res_),
          variant,
          parseBbox(Object.fromEntries(url.searchParams)),
        );
        if (answer.status !== 200)
          return sendJson(res, answer.status, { message: answer.message });
        return sendCached(req, res, answer.body);
      }
      const match = TILE_PATH.exec(route);
      if (match) {
        const [, variant, z, x, y] = match;
        const answer = await service.tile(
          variant,
          Number(z),
          Number(x),
          Number(y),
        );
        if (answer.status !== 200)
          return sendJson(res, answer.status, {
            error: answer.error || 'No tile',
          });
        const accepts = String(req.headers?.['accept-encoding'] || '');
        let body = answer.body;
        res.statusCode = 200;
        res.setHeader(
          'Content-Type',
          answer.contentType || 'application/octet-stream',
        );
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('Vary', 'Accept-Encoding');
        if (/\bgzip\b/.test(accepts)) {
          body = zlib.gzipSync(body);
          res.setHeader('Content-Encoding', 'gzip');
        }
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
        return;
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[WikipediaCoverage] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Wikipedia coverage unavailable' });
    }
  };
}

let shared = null;

/** Vite plugin: /api/wikipedia-coverage for the Wikipedia coverage layer. */
export function wikipediaCoverageProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createWikipediaCoverageService({ sourceRoot });
    middlewares.use(
      WIKIPEDIA_COVERAGE_ROUTE,
      createWikipediaCoverageHandler({ service: service || shared }),
    );
  }
  return {
    name: 'wikipedia-coverage',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
