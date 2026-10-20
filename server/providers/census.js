// Personal fork: census tract choropleth tiles, drawn from the files
// `npm run census:build` writes. Not part of upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { keepTile } from './common/tileCache.js';
import { createTilePool } from './common/tilePool.js';
import { defaultSourceRoot } from './common/source-root.js';
import { COORD_SCALE, openTracts } from './census/tractsFile.js';
import { EMPTY_PNG } from './riversV2/render.js';
import {
  TILE_SIZE,
  encodeRgba,
  renderChoropleth,
  tileBounds,
  tileProjector,
} from './census/render.js';
import {
  ACS,
  BOUNDARIES,
  CENSUS_KEY_ENV,
  NEEDS_BUILD,
  NEEDS_KEY,
  NEEDS_LST,
  censusCacheDir,
} from './census/sources.js';
import {
  CENSUS_ENDPOINT,
  CENSUS_LOCAL_MODES,
  CENSUS_MODE_STYLES,
} from '../../src/data/censusTracts.js';

/**
 * The Census tracts layer's HOUSEHOLD INCOME and SURFACE TEMPERATURE modes,
 * drawn here: each tract of the 2024 cartographic boundaries filled by its
 * value's class (the ACS median household income, or the summer surface
 * temperature computed once in Earth Engine), with thin outlines, into
 * 256 × 256 PNG tiles kept on disk.
 *
 *   GET /api/census/layers
 *       which modes are built, when, from what, their tile versions
 *   GET /api/census/tile/<mode>/<z>/<x>/<y>[?v=<version>]
 *       a tile, z 7 to 14 (the layer draws below about 417 km)
 *
 * Tiles are kept under CENSUS_CACHE_DIR/tiles/<mode>/<version>/, the
 * version being the hash of the style and the build, so a rebuild or a
 * changed style never serves an old tile. Without the build, or without
 * the ACS values (they need CENSUS_API_KEY), the mode says what to do.
 */

export const CENSUS_MIN_ZOOM = 7;
export const CENSUS_MAX_ZOOM = 14;
export const ATTRIBUTION =
  'U.S. Census Bureau: 2024 cartographic boundary tracts; ACS 5-year 2020–2024 B19013 median household income (public domain); summer surface temperature from Landsat 8 and 9 Collection 2 (USGS), on land by JRC Global Surface Water 1.4 (Source: EC JRC/Google), via Google Earth Engine. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau';
/** The manifest is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

/** A mode's tile version: its style and the build. */
export function censusTileVersion(mode, buildId) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        mode,
        buildId,
        classes: CENSUS_MODE_STYLES[mode]?.classes,
        size: TILE_SIZE,
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   dir?: string, tileWorkers?: number}} [options] `tileWorkers`: draw
 *   tiles in that many worker threads (../common/tilePool.js); 0 draws them
 *   on this thread.
 */
export function createCensusService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = censusCacheDir(env, sourceRoot),
  tileWorkers = 0,
} = {}) {
  const pool =
    tileWorkers > 0
      ? createTilePool({
          drawer: 'census',
          options: { dir, env: {} },
          size: tileWorkers,
        })
      : null;
  /** Tile file → the draw (and write) in flight. */
  const drawingTiles = new Map();
  const buildDir = path.join(dir, 'build');
  const manifestFile = path.join(buildDir, 'manifest.json');
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;

  function build() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
      return held?.value || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(manifestFile);
    } catch {
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.value;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const tracts = openTracts(buildDir);
      const values = JSON.parse(
        fs.readFileSync(path.join(buildDir, 'values.json'), 'utf8'),
      );
      held = {
        value: { manifest, tracts, values },
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      lastError = null;
    } catch (error) {
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Census] build not readable:', lastError);
    }
    return held?.value || null;
  }

  /** Whether a mode can be drawn, and if not, why. */
  function modeStatus(open, mode) {
    if (!open)
      return {
        ready: false,
        message: lastError
          ? `The census build is not readable: ${lastError}`
          : NEEDS_BUILD,
      };
    if (mode === 'lst' && !open.manifest.values?.lst)
      return { ready: false, message: NEEDS_LST };
    if (mode === 'income' && !open.manifest.values?.income)
      return {
        ready: false,
        message: String(env[CENSUS_KEY_ENV] || '').trim()
          ? 'CENSUS_API_KEY is set: run npm run census:build again to fetch the incomes'
          : NEEDS_KEY,
      };
    return { ready: true, message: '' };
  }

  const tileFile = (mode, version, z, x, y) =>
    path.join(dir, 'tiles', mode, version, String(z), String(x), `${y}.png`);

  return {
    async layers() {
      const open = build();
      const modes = Object.fromEntries(
        CENSUS_LOCAL_MODES.map((mode) => {
          const status = modeStatus(open, mode);
          return [
            mode,
            {
              ...status,
              ...(status.ready
                ? { version: censusTileVersion(mode, open.manifest.buildId) }
                : {}),
            },
          ];
        }),
      );
      return {
        configured: Boolean(open),
        ...(open
          ? {
              builtAt: open.manifest.builtAt,
              tracts: open.manifest.boundaries?.count ?? null,
              boundariesYear: open.manifest.boundaries?.year ?? BOUNDARIES.year,
              acsYear: open.manifest.values?.income?.year ?? null,
            }
          : { message: lastError || NEEDS_BUILD }),
        modes,
        tileUrl: `${CENSUS_ENDPOINT}/tile/{mode}/{z}/{x}/{y}`,
        minZoom: CENSUS_MIN_ZOOM,
        maxZoom: CENSUS_MAX_ZOOM,
        attribution: ATTRIBUTION,
        acs: { year: ACS.year, variable: ACS.variable },
      };
    },

    /** One tile. */
    async tile(mode, z, x, y) {
      if (!CENSUS_LOCAL_MODES.includes(mode))
        return { status: 404, error: 'No such mode' };
      const limit = 2 ** z;
      if (!(
        z >= 0 &&
        z <= CENSUS_MAX_ZOOM &&
        x >= 0 &&
        x < limit &&
        y >= 0 &&
        y < limit
      ))
        return { status: 400, error: 'Tile out of range' };
      const open = build();
      const status = modeStatus(open, mode);
      if (!status.ready) return { status: 503, error: status.message };
      const version = censusTileVersion(mode, open.manifest.buildId);
      if (z < CENSUS_MIN_ZOOM)
        return {
          status: 200,
          contentType: 'image/png',
          body: EMPTY_PNG,
          empty: true,
          version,
        };
      const file = tileFile(mode, version, z, x, y);
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
            ? await pool.render('draw', [mode, z, x, y])
            : this.draw(mode, z, x, y);
          if (drawn.status === 200 && drawn.body)
            keepTile(file, drawn.body, { label: 'Census', empty: false });
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
    draw(mode, z, x, y) {
      const open = build();
      const status = modeStatus(open, mode);
      if (!status.ready) return { status: 503, error: status.message };
      const version = censusTileVersion(mode, open.manifest.buildId);
      const project = tileProjector(z, x, y);
      const values = open.values[mode] || {};
      const { color } = CENSUS_MODE_STYLES[mode];
      const tracts = open.tracts.tractsIn(tileBounds(z, x, y)).map((t) => ({
        color: color(values[open.tracts.geoids[t]] ?? NaN),
        rings: open.tracts.ringsOf(t).map((ring) => {
          const out = new Float64Array(ring.length);
          for (let i = 0; i < ring.length; i += 2) {
            const [px, py] = project(ring[i], ring[i + 1]);
            out[i] = px;
            out[i + 1] = py;
          }
          return out;
        }),
      }));
      const raster = renderChoropleth(tracts, {
        // Outlines from z 10, where tracts are tens of pixels across.
        outlineWidth: z >= 10 ? 0.6 : 0,
      });
      if (raster.empty) return { status: 200, version, body: null };
      return { status: 200, version, body: encodeRgba(raster) };
    },

    /**
     * Raster values (server/providers/rasterValues/): each cell of an
     * equal-angle box (cols × rows, north row first) takes the value of the
     * tract its centre falls in, NaN outside the tracts or where a tract has
     * none; little-endian Float32.
     * @returns {{status: number, version?: string, body?: Buffer, error?: string}}
     */
    values(mode, box, cols, rows) {
      if (!CENSUS_LOCAL_MODES.includes(mode))
        return { status: 404, error: 'No such mode' };
      const open = build();
      const status = modeStatus(open, mode);
      if (!status.ready) return { status: 503, error: status.message };
      const out = new Float32Array(cols * rows).fill(NaN);
      const values = open.values[mode] || {};
      const { west, south, east, north } = box;
      const dx = (east - west) / cols;
      const dy = (north - south) / rows;
      for (const t of open.tracts.tractsIn(box)) {
        const value = values[open.tracts.geoids[t]];
        if (!Number.isFinite(value)) continue;
        fillByCentres(open.tracts.ringsOf(t), (row, first, last) =>
          out.fill(value, row * cols + first, row * cols + last + 1),
        );
      }
      /** Even-odd fill of a tract's rings over the cells whose centres they hold. */
      function fillByCentres(rings, span) {
        let top = -Infinity;
        let bottom = Infinity;
        for (const ring of rings)
          for (let i = 1; i < ring.length; i += 2) {
            if (ring[i] > top) top = ring[i];
            if (ring[i] < bottom) bottom = ring[i];
          }
        const rowFirst = Math.max(
          0,
          Math.ceil((north - top / COORD_SCALE) / dy - 0.5),
        );
        const rowLast = Math.min(
          rows - 1,
          Math.floor((north - bottom / COORD_SCALE) / dy - 0.5),
        );
        const crossings = [];
        for (let row = rowFirst; row <= rowLast; row++) {
          const y = (north - (row + 0.5) * dy) * COORD_SCALE;
          crossings.length = 0;
          for (const ring of rings) {
            const n = ring.length / 2;
            for (let i = 0, j = n - 1; i < n; j = i++) {
              const yi = ring[i * 2 + 1];
              const yj = ring[j * 2 + 1];
              if (yi > y === yj > y) continue;
              const xi = ring[i * 2];
              const xj = ring[j * 2];
              crossings.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
            }
          }
          crossings.sort((a, b) => a - b);
          for (let k = 0; k + 1 < crossings.length; k += 2) {
            // Cells whose centre x lies in [crossings[k], crossings[k + 1]).
            const from = (crossings[k] / COORD_SCALE - west) / dx - 0.5;
            const to = (crossings[k + 1] / COORD_SCALE - west) / dx - 0.5;
            const first = Math.max(0, Math.ceil(from));
            const last = Math.min(cols - 1, Math.ceil(to) - 1);
            if (last >= first) span(row, first, last);
          }
        }
      }
      return {
        status: 200,
        version: censusTileVersion(mode, open.manifest.buildId),
        body: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
      };
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

const TILE_PATH = /^\/tile\/([a-z]{1,20})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;

/** The routes under /api/census (same-site only, GET only). */
export function createCensusHandler({ service }) {
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
        const [, mode, z, x, y] = match;
        const answer = await service.tile(
          mode,
          Number(z),
          Number(x),
          Number(y),
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
      console.warn('[Census] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Census tiles unavailable' });
    }
  };
}

let shared = null;
/** The dev server draws census tiles in this many worker threads. */
const CENSUS_TILE_WORKERS = Math.max(1, Math.min(3, os.cpus().length - 4));

/** Vite plugin: /api/census for the Census tracts layer's local modes. */
export function censusProxy({ sourceRoot = defaultSourceRoot, service } = {}) {
  function install(middlewares) {
    shared ||= createCensusService({
      sourceRoot,
      tileWorkers: CENSUS_TILE_WORKERS,
    });
    middlewares.use(
      CENSUS_ENDPOINT,
      createCensusHandler({ service: service || shared }),
    );
  }
  return {
    name: 'census',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
