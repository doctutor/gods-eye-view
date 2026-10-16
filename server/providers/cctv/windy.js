import { readResponseJsonCapped } from '../common/http.js';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * Windy Webcams (api.windy.com, API v3): the largest directory of webcams
 * their operators publish, searchable by distance from a point. Too many to
 * index (tens of thousands), so this is a dynamic source: the catalog's
 * proximity query asks it for the webcams near the view, and the cameras it
 * returns are remembered so their frames can be served.
 *
 * Windy's webcam terms (api.windy.com/webcams/terms) govern what this shows:
 * images at their original size or smaller, each linked to its Windy page,
 * credited "Webcams provided by windy.com", with the free tier's ads left in,
 * and no publishing of graphics that display the images. The maintainers of
 * God's Eye View declined this source for the public project for that last
 * reason (bilawalsidhu/gods-eye-view#349); it is enabled here only for the
 * fork owner's own use.
 *
 * API facts measured 2026-10-16: `nearby=lat,lon,radiusKm` with radius at
 * most 250, `limit` at most 50 with `offset` paging, `bbox` broken (500),
 * 300 requests a minute, preview images 400×224 on the free tier, served by
 * imgproxy.windy.com without a key and cached for 150 s.
 *
 * Personal-fork source; not part of upstream God's Eye View.
 */

const API = 'https://api.windy.com/webcams/api/v3/webcams';
export const WINDY_CREDIT = 'Webcams provided by windy.com';
export const WINDY_MAX_RADIUS_KM = 250;
const PAGE = 50;
/** Windy webcams asked for per query, at most (3 pages). */
export const DEFAULT_WINDY_MAX_PER_QUERY = 150;
/** Keep well under Windy's 300 requests a minute. */
const BUDGET_PER_MINUTE = 120;
/** A query's result is reused for this long. */
export const WINDY_CACHE_MS = 15 * 60 * 1000;
/** Remembered cameras (for frame lookups) before the oldest are forgotten. */
const KNOWN_LIMIT = 8000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ID = /^\d{1,12}$/;

/** Windy categories that are traffic cameras, ranked like other traffic cams. */
const TRAFFIC_CATEGORIES = new Set(['traffic']);

function httpsUrl(value, host) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (!host || url.hostname === host)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

/**
 * Normalize one Windy webcam record into a catalog source.
 * @param {object} webcam - One item of the v3 `webcams` array.
 * @returns {object|null}
 */
export function windyToSource(webcam) {
  const id = String(webcam?.webcamId ?? '');
  if (!ID.test(id)) return null;
  if (webcam.status && webcam.status !== 'active') return null;
  const lat = Number(webcam.location?.latitude);
  const lon = Number(webcam.location?.longitude);
  if (!isPlausibleLatLon(lat, lon)) return null;
  const preview = httpsUrl(
    webcam.images?.current?.preview,
    'imgproxy.windy.com',
  );
  if (!preview) return null;
  const detail =
    httpsUrl(webcam.urls?.detail) || `https://windy.com/webcams/${id}`;
  const categories = (Array.isArray(webcam.categories) ? webcam.categories : [])
    .map((c) => String(c?.id || '').toLowerCase())
    .filter((c) => /^[a-z]+$/i.test(c));
  const scenic = categories.find(
    (c) => !TRAFFIC_CATEGORIES.has(c) && c !== 'meteo',
  );
  const category = scenic || categories[0] || 'webcam';
  const city = String(webcam.location?.city || '').trim();
  const region = String(webcam.location?.region || '').trim();
  const country = String(webcam.location?.country_code || '').toUpperCase();
  const title = String(webcam.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return {
    id: `windy-${id}`,
    name: title || `Windy webcam ${id}`,
    city: [city, region].filter(Boolean).join(', ') || country || 'Windy',
    cityId: `windy-${country.toLowerCase() || 'xx'}`,
    provider: 'Windy.com',
    credit: WINDY_CREDIT,
    lat,
    lon,
    headingDeg: NaN,
    headingConfidence: 'low',
    rangeM: 150,
    feedType: 'image',
    url: preview,
    snapshotUrl: preview,
    sourceKind: 'windy',
    license:
      'Windy webcam, display only: original size or smaller, ads kept, no published screenshots',
    code: title.toUpperCase(),
    category,
    coordinatesQuality: 'operator-geotag',
    operatorUrl: detail,
    publishSignal: 'platform-api',
    licenseClass: 'display-only',
  };
}

/** A cache key that groups nearby queries: ~0.05° cells and radius bands. */
export function windyCacheKey(lat, lon, radiusKm) {
  const band = Math.ceil(Math.max(1, radiusKm) / 5) * 5;
  return `${Math.round(lat * 20) / 20},${Math.round(lon * 20) / 20},${band}`;
}

/**
 * The dynamic Windy source. `near` resolves to [] whenever Windy is
 * unavailable, over budget or unconfigured, so the proximity query never
 * waits on it beyond one request timeout.
 *
 * @param {{fetchImpl?: typeof fetch, apiKey?: () => string, now?: () => number,
 *   maxPerQuery?: () => number}} [options]
 */
export function createWindySource({
  fetchImpl = (...args) => fetch(...args),
  apiKey = () =>
    String(
      process.env.WINDY_WEBCAMS_API_KEY || process.env.WINDY_API_KEY || '',
    ).trim(),
  now = () => Date.now(),
  maxPerQuery = () => {
    const raw = Number(process.env.CCTV_WINDY_MAX_PER_QUERY);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_WINDY_MAX_PER_QUERY;
  },
} = {}) {
  /** cache key → {at, sources} */
  const cache = new Map();
  /** camera id → source, insertion-ordered for eviction. */
  const known = new Map();
  /** Request timestamps in the last minute. */
  let recent = [];
  let inflight = new Map();
  let warned = 0;
  /** Personal fork: the last failure, for the status readout. */
  let lastError = null;

  function remember(source) {
    known.delete(source.id);
    known.set(source.id, source);
    while (known.size > KNOWN_LIMIT) known.delete(known.keys().next().value);
  }

  function withinBudget() {
    const t = now();
    recent = recent.filter((at) => t - at < 60_000);
    return recent.length < BUDGET_PER_MINUTE;
  }

  async function page(lat, lon, radiusKm, offset, key) {
    if (!withinBudget()) return null;
    recent.push(now());
    const url = new URL(API);
    url.searchParams.set('nearby', `${lat},${lon},${radiusKm}`);
    url.searchParams.set('limit', String(PAGE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('include', 'images,location,urls,categories');
    url.searchParams.set('sortKey', 'popularity');
    url.searchParams.set('sortDirection', 'desc');
    const response = await fetchImpl(url.toString(), {
      headers: { 'x-windy-api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    const body = await readResponseJsonCapped(response, MAX_BODY_BYTES);
    if (!response.ok)
      throw new Error(
        `Windy webcams ${response.status}: ${body?.message || ''}`,
      );
    return {
      total: Number(body?.total) || 0,
      webcams: Array.isArray(body?.webcams) ? body.webcams : [],
    };
  }

  async function query(lat, lon, radiusKm, limit, key) {
    const sources = [];
    const seen = new Set();
    for (let offset = 0; offset < limit; offset += PAGE) {
      const result = await page(lat, lon, radiusKm, offset, key);
      if (!result) break;
      for (const webcam of result.webcams) {
        const source = windyToSource(webcam);
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        sources.push(source);
        remember(source);
      }
      if (offset + PAGE >= result.total || result.webcams.length < PAGE) break;
    }
    return sources;
  }

  return {
    name: 'windy',
    /** @returns {Promise<Array<object>>} Windy webcams near the point. */
    async near(lat, lon, radiusKm) {
      const key = apiKey();
      if (!key || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const radius = Math.min(
        WINDY_MAX_RADIUS_KM,
        Math.max(1, Math.ceil(radiusKm)),
      );
      const cacheKey = windyCacheKey(lat, lon, radius);
      const hit = cache.get(cacheKey);
      if (hit && now() - hit.at < WINDY_CACHE_MS) return hit.sources;
      if (inflight.has(cacheKey)) return inflight.get(cacheKey);
      const work = query(
        Math.round(lat * 20) / 20,
        Math.round(lon * 20) / 20,
        radius,
        Math.min(1000, maxPerQuery()),
        key,
      )
        .then((sources) => {
          cache.set(cacheKey, { at: now(), sources });
          if (cache.size > 500) cache.delete(cache.keys().next().value);
          return sources;
        })
        .catch((error) => {
          lastError = { at: now(), message: String(error?.message || error) };
          if (now() - warned > 60_000) {
            warned = now();
            console.warn('[CCTV] Windy webcams unavailable:', error?.message);
          }
          return hit?.sources || [];
        })
        .finally(() => inflight.delete(cacheKey));
      inflight.set(cacheKey, work);
      return work;
    },
    /** A camera this source has returned before, for frame lookups. */
    lookup(id) {
      return known.get(id) || null;
    },
    /** How many Windy requests went out in the last minute. */
    requestsLastMinute: () => {
      const t = now();
      return recent.filter((at) => t - at < 60_000).length;
    },
    /** Personal fork: counters for the status readout (cctv/status.js). */
    stats() {
      const t = now();
      return {
        configured: Boolean(apiKey()),
        requestsLastMinute: recent.filter((at) => t - at < 60_000).length,
        budgetPerMinute: BUDGET_PER_MINUTE,
        cacheEntries: cache.size,
        knownCameras: known.size,
        lastError,
      };
    },
  };
}
