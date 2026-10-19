// Personal fork: the self-hosted HydroSHEDS v2 rivers for the Americas,
// served from level files built by scripts/rivers/index.mjs. Not part of
// upstream God's Eye View.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { keepTile } from './common/tileCache.js';
import { createTilePool } from './common/tilePool.js';
import { defaultSourceRoot } from './common/source-root.js';
import {
  BANDS,
  INKS,
  MAX_ZOOM,
  MIN_ZOOM,
  tileVersion,
} from './riversV2/bands.js';
import { openLevel } from './riversV2/levelFile.js';
import { EMPTY_PNG, TILE_SIZE, encodePng } from './riversV2/render.js';
import { renderTileCoverage } from './riversV2/tiles.js';
import {
  boxesOverlap,
  tileWorldBox,
  validTile,
  worldBoxOfBounds,
} from './riversV2/tileMath.js';

/**
 * HydroSHEDS v2's river network (RIV_STREAMS, 21 million reaches) for North
 * and South America, drawn on demand into transparent PNG tiles and kept on
 * disk. `npm run rivers:build` writes one level file per zoom band (the
 * reaches that band draws, simplified for it, cut into cells) and
 * manifest.json; nothing is fetched at request time.
 *
 *   GET /api/rivers/v2/layers
 *       whether a build is there, when, from which files, the inks with
 *       their tile versions, the zoom bands, the extent, the attribution
 *   GET /api/rivers/v2/tile/<ink>/<z>/<x>/<y>[?v=<version>]
 *       a 256 × 256 PNG in the ink (light or dark), z 0 to 14; a tile
 *       outside the data is a cached transparent PNG and costs a box test
 *
 * Tiles are kept under RIVERS_CACHE_DIR/v2/tiles/<ink>/<version>/, the
 * version being the hash of the style and the build (bands.js), so a
 * changed style or a rebuild never serves an old tile; the client puts the
 * same version in the URL as ?v= for the browser's cache.
 */

export const RIVERS_V2_ROUTE = '/api/rivers/v2';
export const ATTRIBUTION =
  'HydroSHEDS v2 (Lehner et al. 2022; WWF, DLR, Confluvio), CC BY 4.0';
export const LICENSE = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://www.hydrosheds.org/products/hydrosheds-v2',
  citation:
    'Lehner, B., Roth, A., Huber, M., Anand, M., Thieme, M. (2022). A sharper look at the world’s rivers and catchments. Eos, 103. https://doi.org/10.1029/2022EO220167',
};
export const NEEDS_BUILD =
  'Run npm run rivers:build to build the HydroSHEDS v2 rivers';
const CACHE_DIR = path.join('.gev-cache', 'rivers');
/** The manifest is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

/** The rivers cache directory (RIVERS_CACHE_DIR, else .gev-cache/rivers). */
export function riversCacheDir(
  env = process.env,
  sourceRoot = defaultSourceRoot,
) {
  const dir = String(env.RIVERS_CACHE_DIR || '').trim();
  return dir ? path.resolve(sourceRoot, dir) : path.join(sourceRoot, CACHE_DIR);
}

/** The build's directory inside the cache. */
export const v2Dir = (cacheDir) => path.join(cacheDir, 'v2');

/** Open a manifest's level files; throws when one is missing. */
export function openBuild(dir, manifest) {
  const levels = new Map();
  try {
    for (const level of manifest.levels || []) {
      // A level is a file in the build directory or one folder below it.
      const name = String(level.file);
      if (
        !/^[\w.-]+(\/[\w.-]+)?$/.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..')
      )
        throw new Error(`bad level path ${name.slice(0, 80)}`);
      levels.set(level.level, openLevel(path.join(dir, ...name.split('/'))));
    }
  } catch (error) {
    for (const open of levels.values()) open.close();
    throw error;
  }
  return { manifest, levels };
}

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number, dir?: string,
 *   tileWorkers?: number}} [options] `tileWorkers`: draw tiles in that many
 *   worker threads (./common/tilePool.js); 0 draws them on this thread.
 */
export function createRiversV2Service({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = v2Dir(riversCacheDir(env, sourceRoot)),
  tileWorkers = 0,
} = {}) {
  const pool =
    tileWorkers > 0
      ? createTilePool({
          drawer: 'rivers-v2',
          options: { dir, env: {} },
          size: tileWorkers,
        })
      : null;
  /** Tile file → the draw (and write) in flight. */
  const drawingTiles = new Map();
  const manifestFile = path.join(dir, 'manifest.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;

  /** The open build, (re)opened when manifest.json changes; null when none. */
  function build() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
      return held?.value || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(manifestFile);
    } catch {
      if (held) for (const open of held.value.levels.values()) open.close();
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.value;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const value = openBuild(dir, manifest);
      const versions = Object.fromEntries(
        Object.keys(INKS).map((ink) => [
          ink,
          tileVersion(ink, manifest.buildId),
        ]),
      );
      value.versions = versions;
      value.extentBox = manifest.extent
        ? worldBoxOfBounds(manifest.extent)
        : null;
      if (held) for (const open of held.value.levels.values()) open.close();
      held = { value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[RiversV2] build not readable:', lastError);
    }
    return held?.value || null;
  }

  const tileFile = (ink, version, z, x, y) =>
    path.join(dir, 'tiles', ink, version, String(z), String(x), `${y}.png`);

  return {
    /** Status, versions and attribution for the client. */
    async layers() {
      const open = build();
      const common = {
        attribution: ATTRIBUTION,
        license: LICENSE,
        inks: Object.keys(INKS),
        tileSize: TILE_SIZE,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        bands: BANDS.map(({ minZoom, maxZoom, maxOrder, minUplandKm2 }) => ({
          minZoom,
          maxZoom,
          maxOrder,
          minUplandKm2,
        })),
      };
      if (!open)
        return {
          configured: false,
          message: lastError
            ? `The HydroSHEDS v2 rivers build is not readable: ${lastError}`
            : NEEDS_BUILD,
          ...common,
        };
      const { manifest } = open;
      return {
        configured: true,
        builtAt: manifest.builtAt,
        buildId: manifest.buildId,
        product: manifest.product || null,
        regions: (manifest.sources || []).map((source) => source.region),
        reaches: manifest.reaches ?? null,
        extent: manifest.extent || null,
        tileUrl: `${RIVERS_V2_ROUTE}/tile/{ink}/{z}/{x}/{y}`,
        versions: open.versions,
        ...common,
      };
    },

    /** The version tiles of an ink are kept under, or null when not built. */
    version(ink) {
      return build()?.versions?.[ink] || null;
    },

    /**
     * One tile.
     * @returns {Promise<{status: number, body?: Buffer, contentType?: string,
     *   error?: string, cached?: boolean, empty?: boolean, version?: string}>}
     */
    async tile(ink, z, x, y) {
      if (!Object.hasOwn(INKS, ink))
        return { status: 404, error: 'No such ink' };
      if (!validTile(z, x, y, MAX_ZOOM))
        return { status: 400, error: 'Tile out of range' };
      const open = build();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      const version = open.versions[ink];
      const box = tileWorldBox(z, x, y);
      if (open.extentBox && !boxesOverlap(box, open.extentBox))
        return {
          status: 200,
          contentType: 'image/png',
          body: EMPTY_PNG,
          empty: true,
          version,
        };
      const file = tileFile(ink, version, z, x, y);
      try {
        return {
          status: 200,
          contentType: 'image/png',
          body: fs.readFileSync(file),
          cached: true,
          version,
        };
      } catch {
        /* not on disk */
      }
      // One draw and one write per tile, however many ask for it at once.
      let drawing = drawingTiles.get(file);
      if (!drawing) {
        drawing = (async () => {
          const drawn = pool
            ? await pool.render('draw', [ink, z, x, y])
            : this.draw(ink, z, x, y);
          if (drawn.status === 200 && drawn.body)
            keepTile(file, drawn.body, { label: 'Rivers v2', empty: false });
          return drawn;
        })().finally(() => drawingTiles.delete(file));
        drawingTiles.set(file, drawing);
      }
      const drawn = await drawing;
      if (drawn.status !== 200) return drawn;
      return drawn.body
        ? { status: 200, contentType: 'image/png', body: drawn.body, version }
        : {
            status: 200,
            contentType: 'image/png',
            body: EMPTY_PNG,
            empty: true,
            version,
          };
    },

    /**
     * Draw a tile (no disk cache): {status, version, body: Buffer|null}, a
     * null body for an empty tile. What a worker thread runs.
     */
    draw(ink, z, x, y) {
      const open = build();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      const version = open.versions[ink];
      const { coverage } = renderTileCoverage(open.levels, z, x, y);
      if (coverage.empty) return { status: 200, version, body: null };
      return { status: 200, version, body: encodePng(coverage, INKS[ink]) };
    },

    /** Stop the tile workers. */
    async close() {
      await pool?.close();
    },
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const TILE_PATH = /^\/tile\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;

/** The routes under /api/rivers/v2 (same-site only, GET only). */
export function createRiversV2Handler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const match = TILE_PATH.exec(route);
      if (match) {
        const [, ink, z, x, y] = match;
        const answer = await service.tile(ink, Number(z), Number(x), Number(y));
        if (answer.status !== 200)
          return sendJson(res, answer.status, {
            error: answer.error || 'No tile',
          });
        res.statusCode = 200;
        res.setHeader('Content-Type', answer.contentType || 'image/png');
        // A URL naming another version than the current one is not kept,
        // so the browser cannot file today's tile under yesterday's name.
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
      console.warn('[RiversV2] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Rivers unavailable' });
    }
  };
}

let shared = null;
/** The dev server draws river tiles in this many worker threads. */
const RIVERS_TILE_WORKERS = Math.max(1, Math.min(2, os.cpus().length - 4));

/** Vite plugin: /api/rivers/v2 for the Rivers layer's HydroSHEDS v2 tiles. */
export function riversV2Proxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createRiversV2Service({
      sourceRoot,
      tileWorkers: RIVERS_TILE_WORKERS,
    });
    middlewares.use(
      RIVERS_V2_ROUTE,
      createRiversV2Handler({ service: service || shared }),
    );
  }
  return {
    name: 'rivers-v2',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
