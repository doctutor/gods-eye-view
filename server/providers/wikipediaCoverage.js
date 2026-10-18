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
  encodeTile,
  openGrid,
  tileValues,
} from './wikipediaCoverage/grid.js';

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
 *
 * Variants: `articles` (per km²), `text` (bytes of wikitext per km², when
 * the build included the page table), `count` (articles under each pixel).
 */

export const WIKIPEDIA_COVERAGE_ROUTE = '/api/wikipedia-coverage';
/** Below this the 0.05° cells are 18 px squares; Cesium upsamples deeper. */
export const MAX_ZOOM = 9;
export const ATTRIBUTION = 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData';
export const NEEDS_BUILD =
  'Run npm run wikipedia:build to build the Wikipedia coverage grid';
const CACHE_DIR = path.join('.gev-cache', 'wikipedia');
/** The grid file is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

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
 *   gridFile?: string}} [options]
 */
export function createWikipediaCoverageService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  gridFile = coverageGridFile(env, sourceRoot),
} = {}) {
  /** {grid, mtimeMs, size} of the open grid, or null. */
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;

  /** The grid, opened (again) when the file is new or changed; null when none. */
  function grid() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
      return held?.grid || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(gridFile);
    } catch {
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.grid;
    try {
      held = {
        grid: openGrid(gridFile),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      lastError = null;
    } catch (error) {
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[WikipediaCoverage] grid not readable:', lastError);
    }
    return held?.grid || null;
  }

  return {
    /** The catalog: one layer, its variants and the ramp domains. */
    async layers() {
      const open = grid();
      if (!open)
        return {
          configured: false,
          message: lastError
            ? `The Wikipedia coverage grid is not readable: ${lastError}`
            : NEEDS_BUILD,
          attribution: ATTRIBUTION,
          variants: VARIANTS.map((key) => ({ key, available: false })),
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
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const TILE_PATH = /^\/tile\/([a-z]{1,16})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/;

/** The routes under /api/wikipedia-coverage (same-site only, GET only). */
export function createWikipediaCoverageHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const route =
      new URL(req.url || '/', 'http://localhost').pathname.replace(
        /\/+$/,
        '',
      ) || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
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
