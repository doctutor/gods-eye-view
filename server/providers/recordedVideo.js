// Personal fork: the Recorded Video layer's routes (recordedVideo/videos.js).
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createRecordedVideoService } from './recordedVideo/videos.js';

export const RECORDED_VIDEO_ROUTE = '/api/video/recorded';
/** Stored YouTube answers are swept this often (and at start). */
const SWEEP_MS = 6 * 60 * 60 * 1000;

function sendJson(res, status, payload, cache = 'no-store') {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(payload));
}

/**
 * The routes under /api/video/recorded (same-site only: a search spends the
 * shared YouTube key's quota):
 *   GET /wikidata                     every Wikidata video with coordinates
 *   GET ?near=lat,lon&radiusKm=…      geotagged YouTube videos near a point
 *       &refresh=1                     ask YouTube again (SEARCH AGAIN)
 */
export function createRecordedVideoHandler({ service }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    try {
      if (route === '/wikidata')
        return sendJson(
          res,
          200,
          { videos: await service.wikidataVideos() },
          'private, max-age=3600',
        );
      if (route === '/') {
        const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
          String(url.searchParams.get('near') || ''),
        );
        if (!match)
          return sendJson(res, 400, { error: 'near=lat,lon is required' });
        const result = await service.near(
          Number(match[1]),
          Number(match[2]),
          Number(url.searchParams.get('radiusKm')),
          { refresh: url.searchParams.get('refresh') === '1' },
        );
        return sendJson(res, result.status, result.body);
      }
      if (typeof next === 'function') return next();
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.warn('[Video] recorded video route failed:', error?.message);
      return sendJson(res, 500, { error: 'Recorded video unavailable' });
    }
  };
}

let shared = null;

/** Vite plugin: /api/video/recorded for the Recorded Video layer. */
function recordedVideoProxy({ sourceRoot = defaultSourceRoot, service } = {}) {
  function install(middlewares) {
    if (!service) {
      shared ||= createRecordedVideoService({ sourceRoot });
      service = shared;
      const sweep = () => {
        try {
          const removed = service.sweep();
          if (removed)
            console.log(
              `[Video] swept ${removed} stored recorded-video answers past their age`,
            );
        } catch (error) {
          console.warn('[Video] recorded video sweep failed:', error?.message);
        }
      };
      sweep();
      setInterval(sweep, SWEEP_MS).unref?.();
    }
    middlewares.use(
      RECORDED_VIDEO_ROUTE,
      createRecordedVideoHandler({ service }),
    );
  }
  return {
    name: 'recorded-video',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { recordedVideoProxy };
