// Personal fork: HTTP routes for the Street View indoor provider.
import { admitSameSite } from '../common/same-site.js';
import { readRequestBody } from '../common/request.js';
import { clientKey } from '../common/rate-limit.js';

export const INDOOR_ROUTE = '/api/streetview/indoor';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** `lat,lon` → {lat, lon}, or null. */
export function parseNear(value) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * The indoor routes under /api/streetview/indoor:
 *   GET  /status                       configured, caps, today's usage
 *   GET  ?near=lat,lon&radiusKm=…      database hits in a radius
 *   POST /probe {lat, lon, radiusKm}   probe the area, return new and all hits
 * Every route refuses cross-site callers: a probe spends the server key's quota.
 * `allowPlaces(clientKey)` is the shared Google Places limiter (null = none).
 */
export function createIndoorHandler({ service, allowPlaces = null }) {
  return async function handle(req, res) {
    if (admitSameSite(req, res)) return;
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (route === '/status') {
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        return sendJson(res, 200, await service.status());
      }
      if (route === '/probe') {
        if (req.method !== 'POST')
          return sendJson(res, 405, { error: 'Method not allowed' });
        let body;
        try {
          body = JSON.parse((await readRequestBody(req, 4096)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'Body must be JSON' });
        }
        const abandoned = new AbortController();
        res.on?.('close', () => {
          if (!res.writableEnded) abandoned.abort();
        });
        const key = clientKey(req);
        const result = await service.probe(
          {
            lat: Number(body?.lat),
            lon: Number(body?.lon),
            radiusKm: Number(body?.radiusKm),
          },
          {
            signal: abandoned.signal,
            allowPlaces: allowPlaces ? () => allowPlaces(key) : null,
          },
        );
        if (res.writableEnded) return;
        return sendJson(res, result.status || 200, result);
      }
      if (route === '/') {
        if (req.method !== 'GET')
          return sendJson(res, 405, { error: 'Method not allowed' });
        const near = parseNear(url.searchParams.get('near'));
        if (!near)
          return sendJson(res, 400, {
            error: 'near=lat,lon is required',
            hits: [],
          });
        return sendJson(
          res,
          200,
          await service.hitsNear({
            ...near,
            radiusKm: Number(url.searchParams.get('radiusKm')),
          }),
        );
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.writableEnded) return;
      sendJson(res, 500, {
        error: error?.message || 'Indoor views request failed',
      });
    }
  };
}
