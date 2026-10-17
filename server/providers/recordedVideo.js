// Personal fork: the Recorded Video layer's routes (recordedVideo/videos.js,
// recordedVideo/landmarks.js).
import { admitSameSite } from './common/same-site.js';
import { defaultSourceRoot } from './common/source-root.js';
import { createLandmarkService } from './recordedVideo/landmarks.js';
import { createRecordedVideoService } from './recordedVideo/videos.js';

export const RECORDED_VIDEO_ROUTE = '/api/video/recorded';
export const LANDMARK_VIDEO_ROUTE = '/api/video/landmark';
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

const LAT_LON = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * The routes under /api/video/landmark (same-site only):
 *   GET ?qid=Q…[&refresh=1]           a landmark's videos (102 units uncached)
 *   GET /near?near=lat,lon&radiusKm=… landmarks around a point
 *   GET /mentions?qid=Q…&videoId=…    "mentioned at" moments (Filmot)
 */
export function createLandmarkHandler({ landmarks }) {
  return async function handle(req, res, next) {
    if (admitSameSite(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'Method not allowed' });
    try {
      let result;
      if (route === '/')
        result = await landmarks.videos(url.searchParams.get('qid'), {
          refresh: url.searchParams.get('refresh') === '1',
        });
      else if (route === '/near') {
        const match = LAT_LON.exec(String(url.searchParams.get('near') || ''));
        if (!match)
          return sendJson(res, 400, { error: 'near=lat,lon is required' });
        result = await landmarks.near(
          Number(match[1]),
          Number(match[2]),
          Number(url.searchParams.get('radiusKm')),
        );
      } else if (route === '/mentions')
        result = await landmarks.mentions(
          url.searchParams.get('qid'),
          url.searchParams.get('videoId'),
        );
      else if (typeof next === 'function') return next();
      else return sendJson(res, 404, { error: 'Not found' });
      return sendJson(res, result.status, result.body);
    } catch (error) {
      console.warn('[Video] landmark route failed:', error?.message);
      return sendJson(res, 500, { error: 'Landmark videos unavailable' });
    }
  };
}

let shared = null;
let sharedLandmarks = null;

/** Vite plugin: /api/video/recorded and /api/video/landmark for the Recorded Video layer. */
function recordedVideoProxy({
  sourceRoot = defaultSourceRoot,
  service,
  landmarks,
} = {}) {
  function install(middlewares) {
    if (!service || !landmarks) {
      shared ||= createRecordedVideoService({ sourceRoot });
      sharedLandmarks ||= createLandmarkService({ sourceRoot });
      service ||= shared;
      landmarks ||= sharedLandmarks;
      const sweep = () => {
        try {
          const removed = service.sweep() + landmarks.sweep();
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
    middlewares.use(LANDMARK_VIDEO_ROUTE, createLandmarkHandler({ landmarks }));
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
