// Personal fork: a PRIVATE route for Cottereau's drawn borders (extracted by
// scripts/cottereau/borders.mjs from his copyrighted video, for personal use
// only). It exists only when COTTEREAU_BORDERS_DIR names a local build
// directory: without it there is no route at all. Same-site only, GET only.
//
//   GET /api/cottereau-borders/status      the current build, its counts and quality
//   GET /api/cottereau-borders/year/<y>    the polygons shown in year y: the latest
//                                           sample at or before it (negative: BC)
//
// Nothing here is part of upstream God's Eye View, and the data it serves is
// never committed or published.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { admitSameSite } from './common/same-site.js';

export const COTTEREAU_BORDERS_ROUTE = '/api/cottereau-borders';
const SAMPLE_FILE = /^samples\/\d{4}\.json\.gz$/;
const BUILD_ID = /^[0-9a-f]{12}$/;

/** The build directory the route serves, or null (then there is no route). */
export function cottereauBordersDir(env = process.env) {
  const dir = String(env.COTTEREAU_BORDERS_DIR || '').trim();
  return dir ? path.resolve(dir) : null;
}

/** The sample a year shows: the latest at or before it (samples sorted by year), or null. */
export function sampleForYear(samples, year) {
  let lo = 0;
  let hi = samples.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].year <= year) {
      found = samples[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The current build's manifest, re-read when current.json moves to another build. */
export function createCottereauBordersService({ dir }) {
  let cached = null;
  function current() {
    let build;
    try {
      build = JSON.parse(
        fs.readFileSync(path.join(dir, 'current.json'), 'utf8'),
      ).build;
    } catch {
      return null;
    }
    if (!BUILD_ID.test(String(build))) return null;
    if (cached?.build === build) return cached;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'builds', build, 'manifest.json'), 'utf8'),
    );
    cached = { build, manifest };
    return cached;
  }
  return {
    status() {
      const now = current();
      if (!now) return { status: 200, body: { built: false } };
      const { manifest } = now;
      const samples = manifest.samples || [];
      return {
        status: 200,
        body: {
          built: true,
          build: now.build,
          builtAt: manifest.builtAt,
          complete: manifest.complete,
          years: samples.length
            ? [samples[0].year, samples.at(-1).untilYear]
            : null,
          samples: samples.length,
          counts: manifest.counts,
          framings: manifest.framings,
          quality: {
            perCentury: manifest.quality?.perCentury,
            iou: manifest.quality?.iou && {
              count: manifest.quality.iou.count,
              median: manifest.quality.iou.median,
              byArea: manifest.quality.iou.byArea,
            },
          },
        },
      };
    },
    year(year) {
      const now = current();
      if (!now) return { status: 404, body: { error: 'No borders build' } };
      const sample = sampleForYear(now.manifest.samples || [], year);
      if (!sample)
        return {
          status: 404,
          body: { error: 'No sample at or before that year' },
        };
      if (!SAMPLE_FILE.test(sample.file))
        return { status: 500, body: { error: 'Bad sample file' } };
      return {
        status: 200,
        etag: `"${now.build}-${sample.index}"`,
        sample,
        gzipped: fs.readFileSync(
          path.join(dir, 'builds', now.build, sample.file),
        ),
      };
    },
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The routes under /api/cottereau-borders (same-site only, GET only). */
export function createCottereauBordersHandler({ service }) {
  return function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/status') {
        const answer = service.status();
        return sendJson(res, answer.status, answer.body);
      }
      const match = /^\/year\/(-?\d{1,4})$/.exec(route);
      if (match) {
        const answer = service.year(Number(match[1]));
        if (answer.status !== 200)
          return sendJson(res, answer.status, answer.body);
        res.setHeader('ETag', answer.etag);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('X-Sample-Year', String(answer.sample.year));
        res.setHeader('X-Until-Year', String(answer.sample.untilYear));
        if (req.headers?.['if-none-match'] === answer.etag) {
          res.statusCode = 304;
          return res.end();
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        let body = answer.gzipped;
        if (/\bgzip\b/.test(String(req.headers?.['accept-encoding'] || '')))
          res.setHeader('Content-Encoding', 'gzip');
        else body = zlib.gunzipSync(body);
        res.setHeader('Content-Length', String(body.length));
        return res.end(body);
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[CottereauBorders] route failed:', error?.message);
      return sendJson(res, 500, { error: 'Cottereau borders unavailable' });
    }
  };
}

/**
 * Vite plugin: /api/cottereau-borders, installed only when
 * COTTEREAU_BORDERS_DIR is set (read when the server starts): absent
 * otherwise, so the private layer cannot be reached.
 */
export function cottereauBordersProxy({ env = process.env } = {}) {
  function install(middlewares) {
    const dir = cottereauBordersDir(env);
    if (!dir) return;
    middlewares.use(
      COTTEREAU_BORDERS_ROUTE,
      createCottereauBordersHandler({
        service: createCottereauBordersService({ dir }),
      }),
    );
  }
  return {
    name: 'cottereau-borders',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
