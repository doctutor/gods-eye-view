// Personal fork: the treemap navigator's routes (docs/TREEMAP-PLAN.md, "The
// service"), from the tables `npm run treemap:build` writes. Not part of
// upstream God's Eye View.
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createTreemapService } from './treemap/service.js';
import { treemapDir } from './treemap/sources.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from './treemap/table.js';

export const TREEMAP_ROUTE = '/api/treemap';

/**
 *   GET /api/treemap/catalog
 *   GET /api/treemap/node?address=&path=<key>/<key>…&depth=1|2&limit=&offset=
 *   GET /api/treemap/geo?ref=<GeoRef>
 *   POST /api/treemap/label  { points: [[lon, lat]…] } → { units: […] }
 *
 * Same-site; GET only but for /label, which reads its points and writes
 * nothing. A node carries an ETag on its table's
 * build, so a repeated question is a 304 until the table is rebuilt.
 */

function send(res, status, body, { etag = '', cache = 'no-store' } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  if (etag) res.setHeader('ETag', etag);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** The most bytes a /label body may hold (20,000 points as JSON). */
export const LABEL_BODY_LIMIT = 1_000_000;

/** A request's JSON body, at most `limit` bytes: the value, or an error. */
function readJson(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ error: `The body is over ${limit} bytes`, status: 413 });
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ error: 'The body is not JSON', status: 400 });
      }
    });
    req.on('error', () =>
      finish({ error: 'The body did not arrive', status: 400 }),
    );
  });
}

const integer = (raw, fallback, min, max) => {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** The routes under /api/treemap. */
export function createTreemapHandler({ service }) {
  return function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (!['/catalog', '/node', '/geo', '/label'].includes(route)) {
      if (typeof next === 'function') return next();
      return send(res, 404, { error: 'Not found' });
    }
    if (route === '/label') {
      if (req.method !== 'POST')
        return send(res, 405, { error: 'Method not allowed' });
      return readJson(req, LABEL_BODY_LIMIT).then((read) => {
        if (read.error) return send(res, read.status, { error: read.error });
        try {
          const answer = service.label(read.value);
          return send(res, answer.status, answer.body);
        } catch (error) {
          console.warn('[Treemap] label failed:', error?.message);
          return send(res, 500, { error: 'Treemap unavailable' });
        }
      });
    }
    if (req.method !== 'GET')
      return send(res, 405, { error: 'Method not allowed' });
    const params = url.searchParams;
    try {
      if (route === '/catalog') return send(res, 200, service.catalog());
      if (route === '/geo') {
        const answer = service.geo(params.get('ref'));
        return send(res, answer.status, answer.body, {
          cache: answer.status === 200 ? 'private, max-age=3600' : 'no-store',
        });
      }
      const depth = integer(params.get('depth'), 1, 1, 2);
      if (depth === null) return send(res, 400, { error: 'depth is 1 or 2' });
      const limit = integer(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
      if (limit === null)
        return send(res, 400, { error: `limit is 1 to ${MAX_LIMIT}` });
      const offset = integer(params.get('offset'), 0, 0, 1e9);
      if (offset === null)
        return send(res, 400, { error: 'offset is 0 or more' });
      const pathText = params.get('path') || '';
      const keys = pathText ? pathText.split('/') : [];
      if (keys.some((key) => !key))
        return send(res, 400, { error: 'path is keys joined by /' });
      const answer = service.node({
        address: params.get('address') || '',
        path: keys,
        depth,
        limit,
        offset,
      });
      if (answer.status !== 200) return send(res, answer.status, answer.body);
      const etag = `"tm-${answer.etag}-${Buffer.from(url.search).toString('base64url').slice(0, 120)}"`;
      const cached = { etag, cache: 'private, no-cache' };
      if (req.headers?.['if-none-match'] === etag) {
        res.statusCode = 304;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', cached.cache);
        return res.end();
      }
      return send(res, 200, answer.body, cached);
    } catch (error) {
      console.warn('[Treemap] route failed:', error?.message);
      return send(res, 500, { error: 'Treemap unavailable' });
    }
  };
}

let shared = null;
/** One service for the server, reading the tables' directory. */
export function sharedTreemap(sourceRoot = defaultSourceRoot) {
  shared ||= createTreemapService({
    dir: treemapDir(process.env, sourceRoot),
    sourceRoot,
  });
  return shared;
}

/** Vite plugin: /api/treemap. */
export function treemapProxy({ sourceRoot = defaultSourceRoot, service } = {}) {
  function install(middlewares) {
    middlewares.use(
      TREEMAP_ROUTE,
      createTreemapHandler({ service: service || sharedTreemap(sourceRoot) }),
    );
  }
  return {
    name: 'treemap',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
