// Personal fork: Overture divisions places for the Localities layer, read
// from the index `npm run overture:build` writes. Not part of upstream
// God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { openIndex } from './overture/divisionsFile.js';
import { NEEDS_BUILD, overtureCacheDir } from './overture/sources.js';
import { createBuildingsTiles } from './overture/buildingsTiles.js';
import {
  createInfrastructureIndex,
  createPlacesIndex,
} from './overture/placesIndex.js';
import { createTilePool as createSharedPool } from './common/tilePool.js';
import {
  PLACE_CATEGORIES,
  PLACE_CONFIDENCE_CHOICES,
  PLACE_COUNT_RESOLUTIONS,
  PLACE_MAX_SPAN_DEGREES,
  PLACE_PIN_LIMIT,
} from '../../src/data/overturePlaces.js';
import {
  INFRASTRUCTURE_CLASSES,
  INFRASTRUCTURE_MAX_SPAN_DEGREES,
  INFRASTRUCTURE_PIN_LIMIT,
} from '../../src/data/overtureInfrastructure.js';
import { createTilePool } from './overture/buildingsTilePool.js';
import { keepTile } from './common/tileCache.js';

export { keepTile };
import { EMPTY_PNG } from './riversV2/render.js';
import {
  OVERTURE_BUILDING_INKS,
  OVERTURE_BUILDING_MODES,
  OVERTURE_BUILDINGS_MAX_ZOOM,
  OVERTURE_FOOTPRINT_ZOOM,
} from '../../src/data/overtureBuildings.js';
import {
  OVERTURE_ATTRIBUTION,
  OVERTURE_ENDPOINT,
  OVERTURE_LICENSE,
  OVERTURE_MAX_SPAN_DEGREES,
  OVERTURE_MAX_ZOOM,
  OVERTURE_PLACE_LIMIT,
  OVERTURE_RELEASE,
  OVERTURE_SAME_PLACE_KM,
} from '../../src/data/overtureDivisions.js';

/**
 * The Localities layer's places close in: Overture Maps' division points
 * (localities, neighbourhoods, municipalities), thinned here.
 *
 *   GET /api/overture/layers
 *       whether the index is built, its release, version and attribution
 *   GET /api/overture/buildings/tile/<mode>/<ink>/<z>/<x>/<y>[?v=]
 *       the Buildings layer's tile where Open Buildings has no data:
 *       COUNT, COVER or HEIGHT from Overture's footprints, their outlines
 *       in the ink from z 15 (server/providers/overture/buildingsTiles.js),
 *       kept on disk under the buildings' version
 *   GET /api/overture/places?west=&south=&east=&north=[&category=&minConfidence=]
 *       the Places layer's pins in a box under a degree: the most
 *       confident first, at most 1,500, `saturated` when more matched
 *   GET /api/overture/places/counts?res=[&west=&south=&east=&north=&category=&minConfidence=]
 *       the same places counted per H3 cell of a resolution (0–7)
 *   GET /api/overture/infrastructure?west=&south=&east=&north=[&zoom=&class=]
 *       Street assets' fire hydrants, street lamps, traffic signals or
 *       charging stations in a box under a degree (Overture's base theme,
 *       from OpenStreetMap), at most 2,000 spread over it
 *   GET /api/overture/infrastructure/counts?res=[&west=&south=&east=&north=&class=]
 *       the same counted per H3 cell of a resolution (0–7)
 *   GET /api/overture/divisions?west=&south=&east=&north=&zoom=[&v=]
 *       the places named at `zoom` in the box: those whose zoom (the
 *       build's, from prominence and kind) the view reaches, the most
 *       prominent first, one per name within 5 km, at most 800
 *
 * The version hashes the build and the answer's rules, so a rebuild never
 * answers under an old one; an answer asked under its version may be kept
 * a day. A box wider than OVERTURE_MAX_SPAN_DEGREES is refused.
 */

/** current.json is stat'ed at most this often. */
const STAT_EVERY_MS = 5000;

/** The version of a build's answers. */
export function overtureVersion(buildId) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        buildId,
        limit: OVERTURE_PLACE_LIMIT,
        sameKm: OVERTURE_SAME_PLACE_KM,
        maxZoom: OVERTURE_MAX_ZOOM,
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

/** The query's box and zoom, checked; or {error}. */
export function parseDivisionsQuery(params) {
  const number = (name) => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return NaN;
    return Number(raw);
  };
  const west = number('west');
  const south = number('south');
  const east = number('east');
  const north = number('north');
  const zoom = number('zoom');
  if (![west, south, east, north, zoom].every(Number.isFinite))
    return { error: 'west, south, east, north and zoom are numbers' };
  if (
    west < -180 ||
    east > 180 ||
    west > 180 ||
    east < -180 ||
    south < -90 ||
    north > 90 ||
    south >= north
  )
    return { error: 'The box is out of range' };
  const lonSpan = west <= east ? east - west : 360 - west + east;
  if (
    north - south > OVERTURE_MAX_SPAN_DEGREES ||
    lonSpan > OVERTURE_MAX_SPAN_DEGREES
  )
    return {
      error: `The box is wider than ${OVERTURE_MAX_SPAN_DEGREES} degrees`,
    };
  if (zoom < 0 || zoom > 24) return { error: 'zoom is 0 to 24' };
  return { west, south, east, north, zoom: Math.floor(zoom) };
}

/**
 * @param {{sourceRoot?: string, env?: object, now?: () => number,
 *   dir?: string, tileWorkers?: number}} [options] `tileWorkers`: draw
 *   buildings tiles in that many worker threads (buildingsTilePool.js);
 *   0 draws them on this thread.
 */
export function createOvertureService({
  sourceRoot = defaultSourceRoot,
  env = process.env,
  now = () => Date.now(),
  dir = overtureCacheDir(env, sourceRoot),
  tileWorkers = 0,
} = {}) {
  const pointer = path.join(dir, 'build', 'current.json');
  const buildings = createBuildingsTiles({ dir, now });
  const pool =
    tileWorkers > 0 ? createTilePool({ dir, size: tileWorkers }) : null;
  // The Places layer's answers, off this thread too (they read and unpack
  // a few dozen blocks a view).
  const places = createPlacesIndex({ dir, now });
  const placesPool =
    tileWorkers > 0
      ? createSharedPool({
          drawer: 'overture-places',
          options: { dir },
          size: Math.min(2, tileWorkers),
        })
      : null;
  const askPlaces = (method, query) =>
    placesPool
      ? placesPool.render(method, [query], `${method}/${JSON.stringify(query)}`)
      : places[method](query);
  // Street assets' answers from the infrastructure index, likewise.
  const infrastructure = createInfrastructureIndex({ dir, now });
  const infrastructurePool =
    tileWorkers > 0
      ? createSharedPool({
          drawer: 'overture-infrastructure',
          options: { dir },
          size: Math.min(2, tileWorkers),
        })
      : null;
  const askInfrastructure = (method, query) =>
    infrastructurePool
      ? infrastructurePool.render(
          method,
          [query],
          `${method}/${JSON.stringify(query)}`,
        )
      : infrastructure[method](query);
  /** Tile file → the draw (and write) in flight. */
  const drawingTiles = new Map();
  let held = null;
  let checkedAt = -Infinity;
  let lastError = null;

  function open() {
    if (now() - checkedAt < STAT_EVERY_MS && (held || lastError))
      return held?.value || null;
    checkedAt = now();
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      held?.value.index.close();
      held = null;
      lastError = null;
      return null;
    }
    if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size)
      return held.value;
    try {
      const { buildId } = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      if (!/^[0-9a-f]{12}$/.test(String(buildId)))
        throw new Error('current.json names no build');
      const buildDir = path.join(dir, 'build', buildId);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'),
      );
      const index = openIndex(buildDir, manifest);
      held?.value.index.close();
      held = {
        value: { manifest, index, version: overtureVersion(buildId) },
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      lastError = null;
    } catch (error) {
      held?.value.index.close();
      held = null;
      lastError = String(error?.message || error).slice(0, 200);
      console.warn('[Overture] build not readable:', lastError);
    }
    return held?.value || null;
  }

  return {
    async layers() {
      const build = open();
      if (!build)
        return {
          configured: false,
          message: lastError
            ? `The Overture build is not readable: ${lastError}`
            : NEEDS_BUILD,
          release: OVERTURE_RELEASE,
          attribution: OVERTURE_ATTRIBUTION,
          license: OVERTURE_LICENSE,
          buildings: buildings.status(),
          poi: places.status(),
          infrastructure: infrastructure.status(),
        };
      const { manifest } = build;
      return {
        configured: true,
        version: build.version,
        release: manifest.release,
        builtAt: manifest.builtAt,
        regions: manifest.regions,
        places: manifest.points,
        attribution: manifest.attribution || OVERTURE_ATTRIBUTION,
        license: manifest.license || OVERTURE_LICENSE,
        limit: OVERTURE_PLACE_LIMIT,
        maxSpanDegrees: OVERTURE_MAX_SPAN_DEGREES,
        buildings: buildings.status(),
        poi: places.status(),
        infrastructure: infrastructure.status(),
      };
    },

    /** A Buildings tile from Overture's footprints, kept on disk by version. */
    async buildingTile(mode, ink, z, x, y) {
      if (
        !OVERTURE_BUILDING_MODES.includes(mode) ||
        !OVERTURE_BUILDING_INKS.includes(ink)
      )
        return { status: 404, error: 'No such mode or ink' };
      if (!(
        z >= 0 &&
        z <= OVERTURE_BUILDINGS_MAX_ZOOM &&
        x >= 0 &&
        x < 2 ** z &&
        y >= 0 &&
        y < 2 ** z
      ))
        return { status: 400, error: 'Tile out of range' };
      const status = buildings.status();
      if (!status.configured)
        return {
          status: 503,
          error: status.message || 'Overture buildings are not built',
        };
      // The ink shows only in the footprints' tiles.
      const inkKey = z >= OVERTURE_FOOTPRINT_ZOOM ? ink : 'any';
      const file = path.join(
        dir,
        'buildings',
        'tiles',
        status.version,
        mode,
        inkKey,
        String(z),
        String(x),
        `${y}.png`,
      );
      const empty = `${file}.empty`;
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
      if (fs.existsSync(empty))
        return {
          status: 200,
          version: status.version,
          body: EMPTY_PNG,
          empty: true,
          cached: true,
        };
      // One draw and one write per tile file, however many ask for it at
      // once (both inks below the footprints' zoom share a file).
      let drawing = drawingTiles.get(file);
      if (!drawing) {
        drawing = (async () => {
          const drawn = pool
            ? await pool.render(mode, inkKey === 'any' ? 'light' : ink, z, x, y)
            : buildings.tile(mode, ink, z, x, y);
          if (drawn.status === 200)
            keepTile(file, drawn.body, { label: 'Overture' });
          return drawn;
        })().finally(() => drawingTiles.delete(file));
        drawingTiles.set(file, drawing);
      }
      const answer = await drawing;
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

    /** The Places layer's pins for a box; `query` from parsePlacesQuery. */
    placePins: (query) => askPlaces('pins', query),

    /** The Places layer's H3 counts; `query` from parseCountsQuery. */
    placeCounts: (query) => askPlaces('counts', query),

    /** Street assets' pins; `query` from parseInfrastructureQuery. */
    infrastructurePins: (query) => askInfrastructure('pins', query),

    /** Street assets' H3 counts; `query` from parseInfrastructureCountsQuery. */
    infrastructureCounts: (query) => askInfrastructure('counts', query),

    /** Stop the tile workers and close the open files. */
    async close() {
      await pool?.close();
      await placesPool?.close();
      await infrastructurePool?.close();
      buildings.close();
      places.close();
      infrastructure.close();
    },

    /** The places of a view; `query` from parseDivisionsQuery. */
    async divisions(query) {
      const build = open();
      if (!build) return { status: 503, error: lastError || NEEDS_BUILD };
      const started = now();
      const answer = build.index.query({
        ...query,
        limit: OVERTURE_PLACE_LIMIT,
      });
      return {
        status: 200,
        version: build.version,
        body: {
          version: build.version,
          zoom: query.zoom,
          count: answer.places.length,
          candidates: answer.candidates,
          saturated: answer.saturated,
          ms: now() - started,
          places: answer.places,
        },
      };
    },
  };
}

function sendJson(res, status, payload, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

const CATEGORY_KEYS = new Set(['all', ...PLACE_CATEGORIES.map((c) => c.key)]);

/** The Places pins query (a box under PLACE_MAX_SPAN_DEGREES), checked; or {error}. */
export function parsePlacesQuery(params) {
  const box = parseBox(params);
  if (box.error) return box;
  const span =
    box.west <= box.east ? box.east - box.west : 360 - box.west + box.east;
  if (
    box.north - box.south > PLACE_MAX_SPAN_DEGREES ||
    span > PLACE_MAX_SPAN_DEGREES
  )
    return { error: `The box is wider than ${PLACE_MAX_SPAN_DEGREES} degree` };
  if (box.west > box.east) return { error: 'The box crosses the antimeridian' };
  const filters = parseFilters(params);
  if (filters.error) return filters;
  return { ...box, ...filters, limit: PLACE_PIN_LIMIT };
}

/** The Places counts query (a resolution, an optional window), checked; or {error}. */
export function parseCountsQuery(params) {
  const res = Number(params.get('res'));
  if (!PLACE_COUNT_RESOLUTIONS.includes(res)) return { error: 'res is 0 to 7' };
  let window = null;
  if (params.has('west')) {
    const box = parseBox(params);
    if (box.error) return box;
    window = box;
  }
  const filters = parseFilters(params);
  if (filters.error) return filters;
  return { res, window, ...filters };
}

const CLASS_KEYS = new Set([
  'all',
  ...INFRASTRUCTURE_CLASSES.map((c) => c.key),
]);

/** The infrastructure's class filter: `class`, a class key or all. */
function parseClass(params) {
  const key = params.get('class') || 'all';
  if (!CLASS_KEYS.has(key)) return { error: 'No such class' };
  // One confidence for every feature (the class is OpenStreetMap's tag).
  return { category: key, minConfidence: 0.5 };
}

/**
 * Street assets' pins query (a box under INFRASTRUCTURE_MAX_SPAN_DEGREES,
 * a class), checked; or {error}. `zoom` is checked and not used: the cap
 * and the spread by position thin a full box.
 */
export function parseInfrastructureQuery(params) {
  const box = parseBox(params);
  if (box.error) return box;
  if (params.has('zoom')) {
    const zoom = Number(params.get('zoom'));
    if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22)
      return { error: 'zoom is 0 to 22' };
  }
  if (
    box.north - box.south > INFRASTRUCTURE_MAX_SPAN_DEGREES ||
    box.east - box.west > INFRASTRUCTURE_MAX_SPAN_DEGREES
  )
    return {
      error: `The box is wider than ${INFRASTRUCTURE_MAX_SPAN_DEGREES} degree`,
    };
  if (box.west > box.east) return { error: 'The box crosses the antimeridian' };
  const filters = parseClass(params);
  if (filters.error) return filters;
  return { ...box, ...filters, limit: INFRASTRUCTURE_PIN_LIMIT };
}

/** Street assets' counts query (a resolution, an optional window, a class), checked; or {error}. */
export function parseInfrastructureCountsQuery(params) {
  const res = Number(params.get('res'));
  if (!PLACE_COUNT_RESOLUTIONS.includes(res)) return { error: 'res is 0 to 7' };
  let window = null;
  if (params.has('west')) {
    const box = parseBox(params);
    if (box.error) return box;
    window = box;
  }
  const filters = parseClass(params);
  if (filters.error) return filters;
  return { res, window, ...filters };
}

function parseBox(params) {
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

function parseFilters(params) {
  const category = params.get('category') || 'all';
  if (!CATEGORY_KEYS.has(category)) return { error: 'No such category' };
  const asked = Number(
    params.get('minConfidence') ?? PLACE_CONFIDENCE_CHOICES[0],
  );
  if (!Number.isFinite(asked)) return { error: 'minConfidence is a number' };
  // The thresholds the index keeps: 0.8 and up, else 0.5.
  const minConfidence =
    asked >= PLACE_CONFIDENCE_CHOICES[0]
      ? PLACE_CONFIDENCE_CHOICES[0]
      : PLACE_CONFIDENCE_CHOICES[1];
  return { category, minConfidence };
}

const BUILDING_TILE =
  /^\/buildings\/tile\/([a-z]{1,10})\/([a-z]{1,10})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/;

/** The routes under /api/overture (same-site only, GET only). */
export function createOvertureHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/layers')
        return sendJson(res, 200, await service.layers());
      const tile = BUILDING_TILE.exec(route);
      if (tile) {
        const [, mode, ink, z, x, y] = tile;
        const answer = await service.buildingTile(
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
            : 'no-store',
        );
        res.setHeader('Content-Length', String(answer.body.length));
        res.end(answer.body);
        return;
      }
      if (route === '/places' || route === '/places/counts') {
        const query =
          route === '/places'
            ? parsePlacesQuery(url.searchParams)
            : parseCountsQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        const answer = await (route === '/places'
          ? service.placePins(query)
          : service.placeCounts(query));
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        const asked = url.searchParams.get('v');
        return sendJson(
          res,
          200,
          { version: answer.version, ...answer.body },
          asked === answer.version ? 'private, max-age=86400' : 'no-store',
        );
      }
      if (route === '/infrastructure' || route === '/infrastructure/counts') {
        const query =
          route === '/infrastructure'
            ? parseInfrastructureQuery(url.searchParams)
            : parseInfrastructureCountsQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        const answer = await (route === '/infrastructure'
          ? service.infrastructurePins(query)
          : service.infrastructureCounts(query));
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        const asked = url.searchParams.get('v');
        return sendJson(
          res,
          200,
          { version: answer.version, ...answer.body },
          asked === answer.version ? 'private, max-age=86400' : 'no-store',
        );
      }
      if (route === '/divisions') {
        const query = parseDivisionsQuery(url.searchParams);
        if (query.error) return sendJson(res, 400, { error: query.error });
        const answer = await service.divisions(query);
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        const asked = url.searchParams.get('v');
        return sendJson(
          res,
          200,
          answer.body,
          asked === answer.version ? 'private, max-age=86400' : 'no-store',
        );
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Overture] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Overture places unavailable' });
    }
  };
}

let shared = null;
/** The dev server draws buildings tiles in this many worker threads. */
const TILE_WORKERS = Math.max(1, Math.min(4, os.cpus().length - 2));

/** Vite plugin: /api/overture for the Localities layer's places close in. */
export function overtureProxy({
  sourceRoot = defaultSourceRoot,
  service,
} = {}) {
  function install(middlewares) {
    shared ||= createOvertureService({
      sourceRoot,
      tileWorkers: TILE_WORKERS,
    });
    middlewares.use(
      OVERTURE_ENDPOINT,
      createOvertureHandler({ service: service || shared }),
    );
  }
  return {
    name: 'overture',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
