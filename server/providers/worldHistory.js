// Personal fork: the World history layer's routes (worldHistory/index.js),
// from the index `npm run world-history:build` writes. Not part of upstream
// God's Eye View.
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createWorldHistoryIndex } from './worldHistory/index.js';
import { NEEDS_BUILD, worldHistoryCacheDir } from './worldHistory/sources.js';
import {
  WORLD_HISTORY_FIRST_YEAR,
  WORLD_HISTORY_LAST_YEAR,
  isWorldYear,
} from '../../src/data/worldHistory.js';

export const WORLD_HISTORY_ROUTE = '/api/world-history';

/**
 *   GET /api/world-history/status
 *   GET /api/world-history/year/<year>?mode=cottereau|all&places=1&lod=0..2
 *       the year's polities with their polygons (year: negative BCE, no 0)
 *   GET /api/world-history/polity?name=<Cliopatria name>&extent=max|<year>&lod=
 *       one polity at its largest, or as at a year (404 when it has none)
 *   GET /api/world-history/names[?q=]
 *       the polities for the picker: all, or those matching q
 *
 * Same-site and GET only. Answers carry an ETag on the build id, so a
 * repeated question is a 304 until the index is rebuilt; 503 when it is
 * not built.
 */

function send(res, status, body, { etag = '', cache = 'no-store' } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  if (etag) res.setHeader('ETag', etag);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const lodParam = (params) => {
  const raw = params.get('lod');
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
};

/** The routes under /api/world-history. */
export function createWorldHistoryHandler({ history }) {
  return function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return send(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const params = url.searchParams;
    try {
      if (route === '/status') return send(res, 200, history.status());
      const id = history.id();
      const known =
        route === '/names' ||
        route === '/polity' ||
        /^\/year\/-?\d+$/.test(route);
      if (!known) {
        if (typeof next === 'function') return next();
        return send(res, 404, { error: 'Not found' });
      }
      if (!id) return send(res, 503, { error: NEEDS_BUILD });
      const etag = `"wh-${id}-${Buffer.from(route + url.search).toString('base64url')}"`;
      const cached = { etag, cache: 'private, no-cache' };
      if (req.headers?.['if-none-match'] === etag) {
        res.statusCode = 304;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', cached.cache);
        return res.end();
      }
      const lod = lodParam(params);
      if (lod === null) return send(res, 400, { error: 'lod is 0, 1 or 2' });

      if (route.startsWith('/year/')) {
        const year = Number(route.slice('/year/'.length));
        if (!isWorldYear(year))
          return send(res, 400, {
            error: `The year is ${WORLD_HISTORY_FIRST_YEAR} to ${WORLD_HISTORY_LAST_YEAR}, negative BCE, and never 0`,
          });
        const mode = params.get('mode') || 'cottereau';
        if (mode !== 'cottereau' && mode !== 'all')
          return send(res, 400, { error: 'mode is cottereau or all' });
        const body = history.year(year, {
          mode,
          places: params.get('places') === '1',
          lod,
        });
        return send(res, 200, body, cached);
      }
      if (route === '/polity') {
        const name = String(params.get('name') || '').slice(0, 200);
        if (!name) return send(res, 400, { error: 'name is a polity name' });
        const extentRaw = params.get('extent') || 'max';
        const extent = extentRaw === 'max' ? 'max' : Number(extentRaw);
        if (extent !== 'max' && !isWorldYear(extent))
          return send(res, 400, { error: 'extent is max or a year' });
        const body = history.polity(name, { extent, lod });
        if (!body)
          return send(res, 404, {
            error:
              extent === 'max'
                ? 'No such polity'
                : 'The polity has no shape in that year',
          });
        return send(res, 200, body, cached);
      }
      const q = String(params.get('q') || '').slice(0, 80);
      return send(
        res,
        200,
        history.names({ q, limit: q ? 50 : Infinity }),
        cached,
      );
    } catch (error) {
      console.warn('[World history] route failed:', error?.message);
      return send(res, 500, { error: 'World history unavailable' });
    }
  };
}

let shared = null;
/** One index for the server, read from the cache directory. */
export function sharedWorldHistory(sourceRoot = defaultSourceRoot) {
  shared ||= createWorldHistoryIndex({
    dir: worldHistoryCacheDir(process.env, sourceRoot),
  });
  return shared;
}

/** Vite plugin: /api/world-history. */
export function worldHistoryProxy({
  sourceRoot = defaultSourceRoot,
  history,
} = {}) {
  function install(middlewares) {
    middlewares.use(
      WORLD_HISTORY_ROUTE,
      createWorldHistoryHandler({
        history: history || sharedWorldHistory(sourceRoot),
      }),
    );
  }
  return {
    name: 'world-history',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
