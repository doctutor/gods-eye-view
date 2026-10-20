// Personal fork: the Roads layer's self-hosted tiles and click answers, and
// Street assets' bike lanes, from Overture's transportation segments
// (`npm run overture:build -- --roads`). Not part of upstream God's Eye
// View.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createTilePool } from './common/tilePool.js';
import { keepTile } from './common/tileCache.js';
import { overtureRoadsDir } from './overture/sources.js';
import { createRoadsTiles } from './overture/roadsTiles.js';
import { EMPTY_PNG } from './riversV2/render.js';
import {
  OVERTURE_ROADS_ENDPOINT,
  OVERTURE_ROADS_MAX_ZOOM,
  ROAD_INKS,
  ROAD_MODES,
} from '../../src/data/overtureRoads.js';

/**
 *   GET /api/roads/layers
 *       whether the roads are built, their version, regions and attribution
 *   GET /api/roads/tile/<mode>/<ink>/<z>/<x>/<y>[?v=]
 *       a tile: NETWORK, SPEED or SURFACE in the ink, drawn in the shared
 *       tile pool and kept on disk under the build's version
 *   GET /api/roads/nearest?lon=&lat=&zoom=
 *       the road a click at a zoom meant (within 8 px of it, among those
 *       drawn there): name, class, speed limit, surface, flags, source
 *   GET /api/roads/bike?west=&south=&east=&north=[&points=1]
 *       Street assets' bike lanes in a box under BIKE_MAX_SPAN_DEGREES:
 *       cycleways and paths signed for bikes, as lines (or with points=1
 *       each one's middle point, for the counts)
 */

/** Street assets ask for bike lanes over at most this many degrees a side. */
export const BIKE_MAX_SPAN_DEGREES = 1;
const TILE_PATH =
  /^\/tile\/([a-z]{1,10})\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;
/** The dev server draws roads tiles in this many worker threads. */
const TILE_WORKERS = Math.max(1, Math.min(4, os.cpus().length - 2));

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   dir?: string, tileWorkers?: number}} [options] `dir`: the roads build
 *   (OVERTURE_ROADS_DIR, else roads/ in the Overture cache); `tileWorkers`:
 *   draw and read in that many worker threads, 0 on this one.
 */
export function createOvertureRoadsService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = overtureRoadsDir(env, sourceRoot),
  tileWorkers = 0,
} = {}) {
  const roads = createRoadsTiles({ dir, now });
  const pool =
    tileWorkers > 0
      ? createTilePool({
          drawer: 'overture-roads',
          options: { dir },
          size: tileWorkers,
        })
      : null;
  const ask = (method, args, key) =>
    pool ? pool.render(method, args, key) : roads[method](...args);
  /** Tile file → the draw (and write) in flight. */
  const drawing = new Map();

  return {
    async layers() {
      return roads.status();
    },

    /** A tile, kept on disk by version: {status, version, body, empty?}. */
    async tile(mode, ink, z, x, y) {
      if (!ROAD_MODES.includes(mode) || !ROAD_INKS.includes(ink))
        return { status: 404, error: 'No such mode or ink' };
      if (!(
        z >= 0 &&
        z <= OVERTURE_ROADS_MAX_ZOOM &&
        x >= 0 &&
        x < 2 ** z &&
        y >= 0 &&
        y < 2 ** z
      ))
        return { status: 400, error: 'Tile out of range' };
      const status = roads.status();
      if (!status.configured)
        return {
          status: 503,
          error: status.message || 'Overture roads are not built',
        };
      const file = path.join(
        dir,
        'tiles',
        status.version,
        mode,
        ink,
        String(z),
        String(x),
        `${y}.png`,
      );
      try {
        return {
          status: 200,
          version: status.version,
          body: fs.readFileSync(file),
          cached: true,
        };
      } catch {
        /* not drawn yet */
      }
      if (fs.existsSync(`${file}.empty`))
        return {
          status: 200,
          version: status.version,
          body: EMPTY_PNG,
          empty: true,
          cached: true,
        };
      let work = drawing.get(file);
      if (!work) {
        work = (async () => {
          const drawn = await ask(
            'tile',
            [mode, ink, z, x, y],
            `${mode}/${ink}/${z}/${x}/${y}`,
          );
          if (drawn.status === 200)
            keepTile(file, drawn.body, { label: 'Roads' });
          return drawn;
        })().finally(() => drawing.delete(file));
        drawing.set(file, work);
      }
      const answer = await work;
      if (answer.status !== 200) return answer;
      return answer.body
        ? { status: 200, version: answer.version, body: answer.body }
        : {
            status: 200,
            version: answer.version,
            body: EMPTY_PNG,
            empty: true,
          };
    },

    /** The road a click meant. */
    nearest(query) {
      return ask('nearest', [query], `nearest/${JSON.stringify(query)}`);
    },

    /** Street assets' bike lanes in a box. */
    bikeLines(query) {
      return ask('bikeLines', [query], `bike/${JSON.stringify(query)}`);
    },

    async close() {
      await pool?.close();
      roads.close();
    },
  };
}

function sendJson(res, status, payload, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

const number = (params, name) => {
  const raw = params.get(name);
  return raw === null || raw.trim() === '' ? NaN : Number(raw);
};

/** A click's query: lon, lat and zoom, checked; or {error}. */
export function parseNearestQuery(params) {
  const lon = number(params, 'lon');
  const lat = number(params, 'lat');
  const zoom = number(params, 'zoom');
  if (![lon, lat, zoom].every(Number.isFinite))
    return { error: 'lon, lat and zoom are numbers' };
  if (Math.abs(lon) > 180 || Math.abs(lat) > 85.06)
    return { error: 'The point is out of range' };
  if (zoom < 0 || zoom > 24) return { error: 'zoom is 0 to 24' };
  return { lon, lat, zoom: Math.floor(zoom) };
}

/** Street assets' bike query: a box under BIKE_MAX_SPAN_DEGREES, checked; or {error}. */
export function parseBikeQuery(params) {
  const [west, south, east, north] = ['west', 'south', 'east', 'north'].map(
    (name) => number(params, name),
  );
  if (![west, south, east, north].every(Number.isFinite))
    return { error: 'west, south, east and north are numbers' };
  if (
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    south < -85.06 ||
    north > 85.06 ||
    south >= north ||
    west >= east
  )
    return { error: 'The box is out of range' };
  if (
    east - west > BIKE_MAX_SPAN_DEGREES ||
    north - south > BIKE_MAX_SPAN_DEGREES
  )
    return {
      error: `The box is wider than ${BIKE_MAX_SPAN_DEGREES} degrees`,
    };
  return { west, south, east, north, points: params.get('points') === '1' };
}

/** The routes under /api/roads (same-site only, GET only). */
export function createOvertureRoadsHandler({ service }) {
  return async function handle(req, res) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const tile = TILE_PATH.exec(route);
      if (tile) {
        const [, mode, ink, z, x, y] = tile;
        const answer = await service.tile(
          mode,
          ink,
          Number(z),
          Number(x),
          Number(y),
        );
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        const asked = url.searchParams.get('v');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader(
          'Cache-Control',
          asked && asked === answer.version
            ? 'private, max-age=86400'
            : 'no-cache',
        );
        res.end(answer.body);
        return;
      }
      if (route === '/nearest' || route === '/bike') {
        const query =
          route === '/nearest'
            ? parseNearestQuery(url.searchParams)
            : parseBikeQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        const answer =
          route === '/nearest'
            ? await service.nearest(query)
            : await service.bikeLines(query);
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        return sendJson(res, 200, answer.body, 'private, max-age=300');
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Roads] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Roads unavailable' });
    }
  };
}

/** Vite plugin: /api/roads. */
export function overtureRoadsProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  let made = null;
  function install(middlewares) {
    made ||=
      service ||
      createOvertureRoadsService({ sourceRoot, tileWorkers: TILE_WORKERS });
    middlewares.use(
      OVERTURE_ROADS_ENDPOINT,
      createOvertureRoadsHandler({ service: made }),
    );
  }
  return {
    name: 'overture-roads',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
