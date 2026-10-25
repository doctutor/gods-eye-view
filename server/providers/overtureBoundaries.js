// Personal fork: the self-hosted Overture boundary lines for the
// Administrative boundaries layer's COUNTRIES, REGIONS and DISTRICTS,
// served from level files built by `npm run overture:boundaries`. Not part
// of upstream God's Eye View.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { keepTile } from './common/tileCache.js';
import { createTilePool } from './common/tilePool.js';
import { defaultSourceRoot } from './common/source-root.js';
import { overtureCacheDir } from './overture/sources.js';
import { openBuild } from './riversV2.js';
import { EMPTY_PNG, TILE_SIZE, encodePng } from './riversV2/render.js';
import { validTile } from './riversV2/tileMath.js';
import {
  BANDS,
  INKS,
  MAX_ZOOM,
  MIN_ZOOM,
  SETS,
  tileVersion,
} from './overtureBoundaries/bands.js';
import { renderTileCoverage } from './overtureBoundaries/tiles.js';
import {
  OVERTURE_BOUNDARIES_ATTRIBUTION,
  OVERTURE_BOUNDARIES_ENDPOINT,
  OVERTURE_BOUNDARIES_LICENSE,
} from '../../src/data/overtureBoundaries.js';

/**
 * Overture's division_boundary lines of the country subtype (land borders,
 * and maritime ones between neighbours: straits, bays, territorial seas),
 * drawn on demand into transparent PNG tiles and kept on disk.
 * `npm run overture:boundaries` writes one level file per zoom band and
 * manifest.json under build/boundaries/ in the Overture cache; nothing is
 * fetched at request time.
 *
 *   GET /api/boundaries/countries/layers
 *       whether a build is there, when, from which release, the inks with
 *       their tile versions, the zoom bands, the attribution; and, for a
 *       build with region and county lines, `sets`: per set its versions
 *       and the cells (of `coverage.gridZoom`) its own level has lines in
 *   GET /api/boundaries/countries/tile/[<set>/]<ink>/<z>/<x>/<y>[?v=<version>]
 *       a 256 × 256 PNG in the ink (light or dark), z 0 to 14, of the set
 *       (countries by default; regions, districts); disputed lines dashed
 *
 * Tiles are kept under build/boundaries/tiles/<ink>/<version>/, the
 * version being the hash of the style and the build (bands.js).
 */

export const NEEDS_BUILD =
  'Run npm run overture:boundaries to build the Overture boundary lines';
/** The manifest is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

/** The build's directory: build/boundaries in the Overture cache. */
export const boundariesDir = (
  env = process.env,
  sourceRoot = defaultSourceRoot,
) => path.join(overtureCacheDir(env, sourceRoot), 'build', 'boundaries');

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number, dir?: string,
 *   tileWorkers?: number}} [options] `tileWorkers`: draw tiles in that many
 *   worker threads (./common/tilePool.js); 0 draws them on this thread.
 */
export function createOvertureBoundariesService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = boundariesDir(env, sourceRoot),
  tileWorkers = 0,
} = {}) {
  const pool =
    tileWorkers > 0
      ? createTilePool({
          drawer: 'overture-boundaries',
          options: { dir, env: {} },
          size: tileWorkers,
        })
      : null;
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
      const versionsOf = (set) =>
        Object.fromEntries(
          Object.keys(INKS).map((ink) => [
            ink,
            tileVersion(ink, manifest.buildId, set),
          ]),
        );
      value.versions = versionsOf('countries');
      // The region and district sets, in a build that has their lines.
      value.sets = {};
      if (manifest.coverage)
        for (const [set, level] of [
          ['regions', 'region'],
          ['districts', 'county'],
        ])
          value.sets[set] = {
            versions: versionsOf(set),
            cells: manifest.coverage[level] || [],
          };
      if (held) for (const open of held.value.levels.values()) open.close();
      held = { value, mtimeMs: stat.mtimeMs, size: stat.size };
      lastError = null;
    } catch (error) {
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Boundaries] build not readable:', lastError);
    }
    return held?.value || null;
  }

  /** A set's tile version in an ink, or null when the build has no such set. */
  const versionOf = (open, ink, set) =>
    set === 'countries'
      ? open.versions[ink]
      : open.sets?.[set]?.versions?.[ink] || null;

  const tileFile = (ink, version, z, x, y) =>
    path.join(dir, 'tiles', ink, version, String(z), String(x), `${y}.png`);
  const empty = (version) => ({
    status: 200,
    contentType: 'image/png',
    body: EMPTY_PNG,
    empty: true,
    version,
  });

  return {
    /** Status, versions and attribution for the client. */
    async layers() {
      const open = build();
      const common = {
        attribution: OVERTURE_BOUNDARIES_ATTRIBUTION,
        license: OVERTURE_BOUNDARIES_LICENSE,
        inks: Object.keys(INKS),
        tileSize: TILE_SIZE,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        bands: BANDS.map(({ minZoom, maxZoom }) => ({ minZoom, maxZoom })),
      };
      if (!open)
        return {
          configured: false,
          message: lastError
            ? `The Overture boundary lines build is not readable: ${lastError}`
            : NEEDS_BUILD,
          ...common,
        };
      const { manifest } = open;
      return {
        configured: true,
        builtAt: manifest.builtAt,
        buildId: manifest.buildId,
        release: manifest.release || null,
        lines: manifest.lines ?? null,
        disputed: manifest.disputed ?? null,
        tileUrl: `${OVERTURE_BOUNDARIES_ENDPOINT}/tile/{ink}/{z}/{x}/{y}`,
        versions: open.versions,
        ...(Object.keys(open.sets).length
          ? {
              sets: open.sets,
              coverage: { gridZoom: manifest.coverage.gridZoom },
              setTileUrl: `${OVERTURE_BOUNDARIES_ENDPOINT}/tile/{set}/{ink}/{z}/{x}/{y}`,
            }
          : {}),
        ...common,
      };
    },

    /**
     * One tile.
     * @returns {Promise<{status: number, body?: Buffer, contentType?: string,
     *   error?: string, cached?: boolean, empty?: boolean, version?: string}>}
     */
    async tile(ink, z, x, y, set = 'countries') {
      if (!Object.hasOwn(INKS, ink))
        return { status: 404, error: 'No such ink' };
      if (!Object.hasOwn(SETS, set))
        return { status: 404, error: 'No such set' };
      if (!validTile(z, x, y, MAX_ZOOM))
        return { status: 400, error: 'Tile out of range' };
      const open = build();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      const version = versionOf(open, ink, set);
      if (!version)
        return {
          status: 404,
          error: `This build has no ${set} lines: run npm run overture:boundaries`,
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
            ? await pool.render('draw', [ink, z, x, y, set])
            : this.draw(ink, z, x, y, set);
          if (drawn.status === 200 && drawn.body)
            keepTile(file, drawn.body, { label: 'Boundaries', empty: false });
          return drawn;
        })().finally(() => drawingTiles.delete(file));
        drawingTiles.set(file, drawing);
      }
      const drawn = await drawing;
      if (drawn.status !== 200) return drawn;
      return drawn.body
        ? { status: 200, contentType: 'image/png', body: drawn.body, version }
        : empty(version);
    },

    /**
     * Draw a tile (no disk cache): {status, version, body: Buffer|null}, a
     * null body for an empty tile. What a worker thread runs.
     */
    draw(ink, z, x, y, set = 'countries') {
      const open = build();
      if (!open) return { status: 503, error: NEEDS_BUILD };
      const version = versionOf(open, ink, set);
      const { coverage } = renderTileCoverage(open.levels, z, x, y, set);
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

const TILE_PATH =
  /^\/tile\/(?:(regions|districts)\/)?([a-z]{1,10})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;

/** The routes under /api/boundaries/countries (same-site only, GET only). */
export function createOvertureBoundariesHandler({ service }) {
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
        const [, set = 'countries', ink, z, x, y] = match;
        const answer = await service.tile(
          ink,
          Number(z),
          Number(x),
          Number(y),
          set,
        );
        if (answer.status !== 200)
          return sendJson(res, answer.status, {
            error: answer.error || 'No tile',
          });
        res.statusCode = 200;
        res.setHeader('Content-Type', answer.contentType || 'image/png');
        // A URL naming another version than the current one is not kept.
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
      console.warn('[Boundaries] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Boundaries unavailable' });
    }
  };
}

let shared = null;
/** The dev server draws boundary tiles in this many worker threads. */
const BOUNDARIES_TILE_WORKERS = Math.max(1, Math.min(2, os.cpus().length - 4));

/** Vite plugin: /api/boundaries/countries for the Overture country lines. */
export function overtureBoundariesProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createOvertureBoundariesService({
      sourceRoot,
      tileWorkers: BOUNDARIES_TILE_WORKERS,
    });
    middlewares.use(
      OVERTURE_BOUNDARIES_ENDPOINT,
      createOvertureBoundariesHandler({ service: service || shared }),
    );
  }
  return {
    name: 'overture-boundaries',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
