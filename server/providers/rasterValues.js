// Personal fork: raster values, numbers instead of coloured tiles, for any
// raster layer over a view window (the client's "Lego" mode draws them as
// heights). Not part of upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createTilePool } from './common/tilePool.js';
import {
  BUILDINGS_MODES,
  EARTH_ENGINE_LAYERS,
} from '../../src/data/earthEngineLayers.js';
import { CENSUS_LOCAL_MODES } from '../../src/data/censusTracts.js';
import { inOpenBuildings } from '../../src/data/openBuildingsCoverage.js';
import {
  RASTER_VALUES_ROUTE,
  RASTER_VALUES_SCHEMA,
  encodeRasterValues,
  parseRasterValuesQuery,
  rasterValuesKey,
  valueRange,
  windowGrid,
} from '../../src/data/rasterValues.js';
import { sharedEarthEngineService } from './earthEngine.js';
import {
  EE_VALUE_LAYERS,
  createEarthEngineAdapter,
} from './rasterValues/earthEngineValues.js';
import {
  createSelfHostedStatus,
  createSelfHostedValues,
  selfHostedDirs,
} from './rasterValues/selfHosted.js';
import { resolutionForCell } from './property/index.js';
import { NEEDS_BUILD as NEEDS_PROPERTY } from './property/sources.js';
import {
  PROPERTY_LAYER_ID,
  PROPERTY_METRICS,
} from '../../src/data/propertySales.js';

/**
 *   GET /api/raster/values?layer=<id>&mode=<key or ''>&west&south&east&north
 *       &cells=<at most 512 a side>
 *
 * answers application/octet-stream: a little-endian uint32 header length,
 * a UTF-8 JSON header, then little-endian Float32 values, row-major, the
 * north row and west column first, NaN for nodata (the header's `nodata`
 * is the string "NaN": JSON has no NaN). The header:
 *
 *   {schema: 'raster-values/1', layer, mode, cols, rows, west, south, east,
 *    north, cellSizeM, units, nodata, min, max, legendMin, legendMax,
 *    source, version, aggregation}
 *
 * 400 bad parameters; 404 an unknown layer or mode; 413 more than 512
 * cells a side; 503 the layer's data not built or Earth Engine not set up;
 * 429 the day's Earth Engine budget used (a values request counts as one
 * tile). `?v=` is ignored. Answers are kept under
 * .gev-cache/raster-values/<layer>/<mode>/<version>/<hash of box+cells>.bin;
 * the self-hosted sources are computed in worker threads.
 */

const CACHE_DIR = path.join('.gev-cache', 'raster-values');
/** A kept answer serves this long (Earth Engine's tiles keep 30 days too). */
export const VALUES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NEEDS = {
  overture:
    'Overture buildings are not built (npm run overture:build -- --buildings)',
  census:
    'Run npm run census:build to draw the census tracts (the incomes need CENSUS_API_KEY)',
  wikipedia: 'Run npm run wikipedia:build to build the Wikipedia coverage grid',
  property: NEEDS_PROPERTY,
};

const BUILDINGS_MODE = new Map(BUILDINGS_MODES.map((mode) => [mode.key, mode]));
const BUILDINGS_UNITS = {
  count: 'buildings/km²',
  cover: 'fraction',
  height: 'm',
};

/** A Buildings mode's display range in its values' units. */
function buildingsLegend(mode) {
  const { vis, log10 } = BUILDINGS_MODE.get(mode);
  return log10 ? [10 ** vis.min, 10 ** vis.max] : [vis.min, vis.max];
}

const CENSUS_VALUES = {
  income: {
    units: 'USD',
    legend: [30_000, 160_000],
    source: 'ACS 5-year 2020–2024 median household income',
  },
  lst: {
    units: '°C',
    legend: [25, 50],
    source: 'Landsat 8 and 9 summer surface temperature 2018–2023',
  },
};

const WIKIPEDIA_VALUES = {
  articles: { units: 'articles/km²', aggregation: 'mean' },
  text: { units: 'bytes/km²', aggregation: 'mean' },
  count: { units: 'articles', aggregation: 'sum' },
};

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   earthEngine?: {computePixels: Function}, layers?: object[],
 *   dirs?: {overtureDir, censusDir, gridFile}, tileWorkers?: number,
 *   cacheDir?: string}} [options] `tileWorkers`: compute the self-hosted
 *   sources in that many worker threads; 0 on this thread.
 */
export function createRasterValuesService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  earthEngine = null,
  layers = EARTH_ENGINE_LAYERS,
  dirs = selfHostedDirs(env, sourceRoot),
  tileWorkers = 0,
  cacheDir = path.join(sourceRoot, CACHE_DIR),
} = {}) {
  const engine = () => earthEngine || sharedEarthEngineService(sourceRoot);
  const status = createSelfHostedStatus(dirs, { now });
  let local = null;
  const pool =
    tileWorkers > 0
      ? createTilePool({
          drawer: 'raster-values',
          options: dirs,
          size: tileWorkers,
        })
      : null;

  /** A self-hosted source's numbers (in a worker when there are any). */
  async function selfHosted(source, mode, box, cols, rows) {
    const args = [source, mode, box, cols, rows];
    const answer = pool
      ? await pool.render('values', args, JSON.stringify(args))
      : (local ||= createSelfHostedValues(dirs)).values(...args);
    if (answer.status !== 200) return answer;
    const body = answer.body;
    return {
      status: 200,
      aggregation: answer.aggregation,
      values: new Float32Array(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      ),
    };
  }

  const eeAdapters = new Map(
    layers
      .filter((layer) => EE_VALUE_LAYERS[layer.id])
      .map((layer) => [
        layer.id,
        createEarthEngineAdapter(layer, {
          computePixels: (...args) => engine().computePixels(...args),
        }),
      ]),
  );

  /** Overture's buildings answer for a window outside Open Buildings, inside the build's regions. */
  function overturePlan(mode, box, cells) {
    const built = status.overture();
    const lat = (box.south + box.north) / 2;
    const lon = (box.west + box.east) / 2;
    if (inOpenBuildings(lat, lon) || !built) return null;
    const inside = Object.values(built.regionBoxes).some(
      ([w, s, e, n]) => lat >= s && lat <= n && lon >= w && lon <= e,
    );
    if (!inside) return null;
    const [legendMin, legendMax] = buildingsLegend(mode);
    return {
      mode,
      version: `overture-${built.version}`,
      ...windowGrid(box, cells),
      units: BUILDINGS_UNITS[mode],
      aggregation: 'mean',
      source: 'Overture Maps buildings',
      legendMin,
      legendMax,
      run() {
        return selfHosted(
          'overture-buildings',
          mode,
          box,
          this.cols,
          this.rows,
        );
      },
    };
  }

  /** layer id → {modes: string[] (the first is ''s), plan(mode, box, cells)}. */
  const adapters = new Map(eeAdapters);
  const buildings = eeAdapters.get('ee-buildings');
  if (buildings)
    adapters.set('ee-buildings', {
      id: 'ee-buildings',
      modes: buildings.modes,
      plan(mode, box, cells) {
        const key = mode || buildings.modes[0];
        return overturePlan(key, box, cells) || buildings.plan(key, box, cells);
      },
    });
  if (layers.some((layer) => layer.id === 'ee-census-tracts'))
    adapters.set('ee-census-tracts', {
      id: 'ee-census-tracts',
      modes: [...CENSUS_LOCAL_MODES],
      plan(mode, box, cells) {
        const key = mode || CENSUS_LOCAL_MODES[0];
        const built = status.census(key);
        if (!built) return { status: 503, error: NEEDS.census };
        const spec = CENSUS_VALUES[key];
        return {
          mode: key,
          version: built.version,
          ...windowGrid(box, cells),
          units: spec.units,
          aggregation: 'sample',
          source: spec.source,
          legendMin: spec.legend[0],
          legendMax: spec.legend[1],
          run() {
            return selfHosted('census', key, box, this.cols, this.rows);
          },
        };
      },
    });
  adapters.set('wikipedia-coverage', {
    id: 'wikipedia-coverage',
    modes: Object.keys(WIKIPEDIA_VALUES),
    plan(mode, box, cells) {
      const key = mode || 'articles';
      const built = status.wikipedia(key);
      if (!built) return { status: 503, error: NEEDS.wikipedia };
      return {
        mode: key,
        version: built.version,
        ...windowGrid(box, cells),
        ...WIKIPEDIA_VALUES[key],
        source: 'English Wikipedia (Wikimedia GeoData)',
        legendMin: built.domain?.min ?? null,
        legendMax: built.domain?.max ?? null,
        run() {
          return selfHosted('wikipedia', key, box, this.cols, this.rows);
        },
      };
    },
  });

  // Personal fork: the Property sales layer's hexagons, sampled.
  adapters.set(PROPERTY_LAYER_ID, {
    id: PROPERTY_LAYER_ID,
    modes: PROPERTY_METRICS.map((metric) => metric.key),
    plan(mode, box, cells) {
      const key = mode || 'price';
      const built = status.property();
      if (!built) return { status: 503, error: NEEDS.property };
      const metric = PROPERTY_METRICS.find((entry) => entry.key === key);
      const grid = windowGrid(box, cells);
      const domain =
        built.domains[resolutionForCell(grid.cellSizeM)]?.[key] || null;
      return {
        mode: key,
        version: `property-${built.version}`,
        ...grid,
        units: metric.units,
        aggregation: 'sample',
        source: 'realestatedataset.com public records',
        legendMin: domain?.min ?? null,
        legendMax: domain?.max ?? null,
        run() {
          return selfHosted('property', key, box, this.cols, this.rows);
        },
      };
    },
  });

  /** Answers in flight by file: one computation however many ask. */
  const inflight = new Map();

  return {
    /** The layers and modes with values (for docs and tests). */
    catalog() {
      return [...adapters.values()].map((adapter) => ({
        layer: adapter.id,
        modes: adapter.modes,
      }));
    },

    /**
     * One window's values.
     * @param {URLSearchParams|object} params
     * @returns {Promise<{status: number, body?: Uint8Array, error?: string,
     *   cached?: boolean}>}
     */
    async values(params) {
      const query = parseRasterValuesQuery(params);
      if (!query.ok) return { status: query.status, error: query.error };
      const adapter = adapters.get(query.layer);
      if (!adapter) return { status: 404, error: 'No values for that layer' };
      if (query.mode && !adapter.modes.includes(query.mode))
        return { status: 404, error: 'No such mode' };
      const plan = adapter.plan(query.mode, query.box, query.cells);
      if (plan.status) return { status: plan.status, error: plan.error };
      const name = crypto
        .createHash('sha256')
        .update(rasterValuesKey({ ...query, mode: plan.mode }))
        .digest('hex')
        .slice(0, 24);
      const file = path.join(
        cacheDir,
        query.layer,
        plan.mode || 'default',
        plan.version,
        `${name}.bin`,
      );
      try {
        const stat = fs.statSync(file);
        if (now() - stat.mtimeMs < VALUES_TTL_MS)
          return { status: 200, body: fs.readFileSync(file), cached: true };
      } catch {
        /* not on disk */
      }
      let work = inflight.get(file);
      if (!work) {
        work = (async () => {
          const answer = await plan.run();
          if (answer.status !== 200) return answer;
          const { min, max } = valueRange(answer.values);
          const header = {
            schema: RASTER_VALUES_SCHEMA,
            layer: query.layer,
            mode: plan.mode,
            cols: plan.cols,
            rows: plan.rows,
            ...query.box,
            cellSizeM: Math.round(plan.cellSizeM * 1000) / 1000,
            units: plan.units,
            nodata: NaN,
            min,
            max,
            legendMin: plan.legendMin,
            legendMax: plan.legendMax,
            source: plan.source,
            version: plan.version,
            aggregation: answer.aggregation || plan.aggregation,
            ...(plan.band ? { band: plan.band } : {}),
          };
          const body = encodeRasterValues(header, answer.values);
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temporary, body);
            fs.renameSync(temporary, file);
          } catch {
            /* serving matters more than keeping */
          }
          return { status: 200, body };
        })().finally(() => inflight.delete(file));
        inflight.set(file, work);
      }
      return work;
    },

    async close() {
      local?.close();
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

/** The route (same-site only, GET only). */
export function createRasterValuesHandler({ service }) {
  return async function handle(req, res) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (route !== '/') return sendJson(res, 404, { error: 'Not found' });
    try {
      const answer = await service.values(url.searchParams);
      if (answer.status !== 200)
        return sendJson(res, answer.status, { error: answer.error });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Length', String(answer.body.byteLength));
      res.end(
        Buffer.from(
          answer.body.buffer,
          answer.body.byteOffset,
          answer.body.byteLength,
        ),
      );
    } catch (error) {
      console.warn('[RasterValues] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Raster values unavailable' });
    }
  };
}

/** Worker threads for the self-hosted sources. */
const VALUE_WORKERS = Math.max(1, Math.min(2, os.cpus().length - 2));

/** Vite plugin: /api/raster/values. */
export function rasterValuesProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  let made = null;
  function install(middlewares) {
    made ||=
      service ||
      createRasterValuesService({ sourceRoot, tileWorkers: VALUE_WORKERS });
    middlewares.use(
      RASTER_VALUES_ROUTE,
      createRasterValuesHandler({ service: made }),
    );
  }
  return {
    name: 'raster-values',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
