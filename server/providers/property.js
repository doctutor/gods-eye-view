// Personal fork: the Property sales layer's answers, read from the index
// `npm run property:build` writes. Not part of upstream God's Eye View.
import os from 'node:os';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createTilePool } from './common/tilePool.js';
import { createPropertyIndex } from './property/index.js';
import { propertyCacheDir } from './property/sources.js';
import {
  PROPERTY_ENDPOINT,
  PROPERTY_MAX_SPAN_DEGREES,
  PROPERTY_METRIC_KEYS,
  PROPERTY_POINT_LIMIT,
  PROPERTY_RESOLUTIONS,
} from '../../src/data/propertySales.js';

/**
 * US property records (realestatedataset.com's public-record fields):
 *
 *   GET /api/property/layers
 *       whether the index is built, its version, counts, source and each
 *       resolution's ramp domains
 *   GET /api/property/h3/<res>/<metric>?west=&south=&east=&north=[&v=]
 *       a metric's hexagons (resolution 0–7) whose centres lie in the box
 *       (west > east crosses the antimeridian): median sale price or price
 *       per sqft since 2015, median year built, sales, properties; 413 past
 *       20,000
 *   GET /api/property/buildings?west=&south=&east=&north=[&v=]
 *       the buildings in a box under PROPERTY_MAX_SPAN_DEGREES: units
 *       collapsed, at most 3,000 spread over it, `saturated` when more
 *   GET /api/property/building?id=[&v=]
 *       one building's records for its card
 *
 * The answers are drawn in the shared tile pool's workers when there are
 * any (they read and unpack blocks). An answer asked under its version may
 * be kept a day. 503 when the index is not built.
 */

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   dir?: string, workers?: number}} [options] `workers`: answer in that
 *   many worker threads; 0 on this thread.
 */
export function createPropertyService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = propertyCacheDir(env, sourceRoot),
  workers = 0,
} = {}) {
  const index = createPropertyIndex({ dir, now });
  const pool =
    workers > 0
      ? createTilePool({ drawer: 'property', options: { dir }, size: workers })
      : null;
  const ask = (method, query) =>
    pool
      ? pool.render(method, [query], `${method}/${JSON.stringify(query)}`)
      : index[method](query);
  return {
    layers: () => index.status(),
    hexes: (query) => ask('hexes', query),
    buildings: (query) => ask('buildings', query),
    building: (query) => ask('building', query),
    async close() {
      await pool?.close();
      index.close();
    },
  };
}

function sendJson(res, status, payload, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

/** A box from the query, checked; or {error}. */
export function parseBox(params) {
  const number = (name) => {
    const raw = params.get(name);
    return raw === null || raw.trim() === '' ? NaN : Number(raw);
  };
  const [west, south, east, north] = ['west', 'south', 'east', 'north'].map(
    number,
  );
  if (![west, south, east, north].every(Number.isFinite))
    return { error: 'west, south, east and north are numbers' };
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    south < -90 ||
    north > 90 ||
    south >= north
  )
    return { error: 'The box is out of range' };
  return { west, south, east, north };
}

/** The buildings query (a box under PROPERTY_MAX_SPAN_DEGREES), checked; or {error}. */
export function parseBuildingsQuery(params) {
  const box = parseBox(params);
  if (box.error) return box;
  if (box.west > box.east) return { error: 'The box crosses the antimeridian' };
  if (
    box.north - box.south > PROPERTY_MAX_SPAN_DEGREES ||
    box.east - box.west > PROPERTY_MAX_SPAN_DEGREES
  )
    return {
      error: `The box is wider than ${PROPERTY_MAX_SPAN_DEGREES} degrees`,
    };
  return { ...box, limit: PROPERTY_POINT_LIMIT };
}

const HEXES = /^\/h3\/(\d{1,2})\/([a-z]{1,12})$/;

/** The routes under /api/property (same-site only, GET only). */
export function createPropertyHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const asked = url.searchParams.get('v');
    const answer = async (pending) => {
      const result = await pending;
      if (result.status !== 200)
        return sendJson(res, result.status, { error: result.error });
      return sendJson(
        res,
        200,
        { version: result.version, ...result.body },
        asked && asked === result.version
          ? 'private, max-age=86400'
          : 'no-store',
      );
    };
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const hexes = HEXES.exec(route);
      if (hexes) {
        const res_ = Number(hexes[1]);
        const metric = hexes[2];
        if (!PROPERTY_RESOLUTIONS.includes(res_))
          return sendJson(res, 400, { error: 'res is 0 to 7' });
        if (!PROPERTY_METRIC_KEYS.includes(metric))
          return sendJson(res, 404, { error: 'No such metric' });
        const box = parseBox(url.searchParams);
        if (box.error) return sendJson(res, 400, { error: box.error });
        return answer(service.hexes({ res: res_, metric, box }));
      }
      if (route === '/buildings') {
        const query = parseBuildingsQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        return answer(service.buildings(query));
      }
      if (route === '/building') {
        const id = url.searchParams.get('id') || '';
        if (!/^pr:\d{1,9}:\d{1,9}:\d{1,6}$/.test(id))
          return sendJson(res, 400, { error: 'Not a building id' });
        return answer(service.building({ id }));
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Property] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Property records unavailable' });
    }
  };
}

let shared = null;
/** The dev server answers in this many worker threads. */
const WORKERS = Math.max(1, Math.min(2, os.cpus().length - 2));

/** Vite plugin: /api/property for the Property sales layer. */
export function propertyProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createPropertyService({ sourceRoot, workers: WORKERS });
    middlewares.use(
      PROPERTY_ENDPOINT,
      createPropertyHandler({ service: service || shared }),
    );
  }
  return {
    name: 'property',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
