// Personal fork: census tract choropleth tiles, drawn from the files
// `npm run census:build` writes. Not part of upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { openTracts } from './census/tractsFile.js';
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
  'U.S. Census Bureau: 2024 cartographic boundary tracts; ACS 5-year 2020–2024 B19013 median household income (public domain); summer surface temperature from Landsat 8 and 9 Collection 2 (USGS) via Google Earth Engine. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau';
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
 *   dir?: string}} [options]
 */
export function createCensusService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = censusCacheDir(env, sourceRoot),
} = {}) {
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
      if (raster.empty)
        return {
          status: 200,
          contentType: 'image/png',
          body: EMPTY_PNG,
          empty: true,
          version,
        };
      const body = encodeRgba(raster);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, body);
        fs.renameSync(temporary, file);
      } catch {
        /* serving matters more than keeping */
      }
      return { status: 200, contentType: 'image/png', body, version };
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

/** Vite plugin: /api/census for the Census tracts layer's local modes. */
export function censusProxy({ sourceRoot = defaultSourceRoot, service } = {}) {
  function install(middlewares) {
    shared ||= createCensusService({ sourceRoot });
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
