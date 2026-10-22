// Personal fork: the Rivers layer's names (riverNames/index.js), from the
// sidecar `npm run rivers:names` writes. Not part of upstream God's Eye View.
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { sharedRiverNames } from './riverReach.js';

export const RIVER_NAMES_ROUTE = '/api/rivers/names';
/** A labels box is at most this many degrees a side. */
export const LABELS_MAX_SPAN_DEGREES = 20;

/**
 *   GET /api/rivers/names/labels?west=&south=&east=&north=
 *       the large named rivers (Strahler 5 and up) in a box under
 *       LABELS_MAX_SPAN_DEGREES: a label point per name and z 10 tile
 *   GET /api/rivers/names/nearest?lat=&lon=
 *       the name of the river nearest a point (within 150 m): a named v2
 *       reach (direct or inherited from its main stem), else an OSM
 *       waterway; 404 when none
 *
 * 503 when the sidecar is not built.
 */

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

/** The routes under /api/rivers/names (same-site only, GET only). */
export function createRiverNamesHandler({ names }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/labels') {
        const [west, south, east, north] = [
          'west',
          'south',
          'east',
          'north',
        ].map((name) => number(url.searchParams, name));
        if (![west, south, east, north].every(Number.isFinite))
          return sendJson(res, 400, {
            error: 'west, south, east and north are numbers',
          });
        if (
          south >= north ||
          west >= east ||
          north - south > LABELS_MAX_SPAN_DEGREES ||
          east - west > LABELS_MAX_SPAN_DEGREES
        )
          return sendJson(res, 400, {
            error: `The box is empty or wider than ${LABELS_MAX_SPAN_DEGREES} degrees`,
          });
        const answer = names.labels({ west, south, east, north });
        if (answer.status !== 200)
          return sendJson(res, answer.status, { error: answer.error });
        return sendJson(
          res,
          200,
          { version: answer.version, ...answer.body },
          'private, max-age=3600',
        );
      }
      if (route === '/nearest') {
        const lat = number(url.searchParams, 'lat');
        const lon = number(url.searchParams, 'lon');
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        )
          return sendJson(res, 400, { error: 'lat and lon are degrees' });
        if (!names.status().built)
          return sendJson(res, 503, {
            error: 'Run npm run rivers:names to name the rivers',
          });
        const name = names.nearest({ lat, lon });
        if (!name) return sendJson(res, 404, { error: 'No named river here' });
        return sendJson(res, 200, name, 'private, max-age=3600');
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Rivers] names route failed:', error?.message);
      return sendJson(res, 500, { error: 'River names unavailable' });
    }
  };
}

/** Vite plugin: /api/rivers/names. */
export function riverNamesProxy({
  sourceRoot = defaultSourceRoot,
  names,
} = {}) {
  function install(middlewares) {
    middlewares.use(
      RIVER_NAMES_ROUTE,
      createRiverNamesHandler({ names: names || sharedRiverNames(sourceRoot) }),
    );
  }
  return {
    name: 'river-names',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
