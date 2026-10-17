import path from 'node:path';
import { readResponseJsonCapped } from '../common/http.js';
import { googleServerApiKey } from '../places/google-key.js';
import { createDailyCachedList } from '../cctv/dailyCache.js';
import {
  createYoutubeClient,
  createYoutubeQuota,
  VIDEO_ID,
} from '../cctv/featuredChannels.js';
import {
  FEATURED_CACHE_DIR,
  readJsonFile,
  writeJsonAtomic,
} from '../cctv/featuredStore.js';
import { isPlausibleLatLon } from '../cctv/normalize.js';

/**
 * Recorded video: non-live videos tied to places, for the Recorded Video
 * layer. Two sources, each labelled with the precision it really has:
 *
 * - Wikidata: items with a YouTube video (P1651) and coordinates (P625).
 *   The video is about that place, so the pin is the item's own position
 *   ('site'). CC0; fetched at most weekly.
 * - YouTube's own geotags, searched on demand near the view (search.list,
 *   100 units, then videos.list, 1). Uploaders' geotags are often a place
 *   list's pin rather than where they filmed (measured 2026-10-14: of 50
 *   videos near downtown Baltimore, 18 shared one downtown point and 13 the
 *   centre of Columbia), so a coordinate shared by several videos in one
 *   answer is labelled 'area', and one that is a town's own centre
 *   'region'. Shorts (60 s or less), live streams and videos without a
 *   recording location are left out.
 *
 * YouTube API data is kept only as the terms allow: search answers are
 * reused for a week and every stored answer is swept after at most 30 days.
 * Units are counted in the featured watcher's quota file (one shared key);
 * this feature refuses to search past RECORDED_VIDEO_DAILY_BUDGET.
 *
 * Personal-fork module; not part of upstream God's Eye View.
 */

export const RECORDED_VIDEO_DIR = path.join('.gev-cache', 'recorded-video');
export const DEFAULT_RECORDED_VIDEO_BUDGET = 1000;
/** One query: search.list (100) and one videos.list (1). */
export const QUERY_COST = 101;
export const MAX_RADIUS_KM = 50;
/** A search answer is reused this long. */
export const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Nothing from the YouTube API is kept longer than this. */
export const MAX_STORE_MS = 30 * 24 * 60 * 60 * 1000;
export const SHORTS_MAX_S = 60;
const WIKIDATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_VIDEO_QUERY =
  'SELECT ?item ?itemLabel ?video ?coord WHERE { ?item wdt:P1651 ?video; wdt:P625 ?coord . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }';
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 (+https://github.com/doctutor/gods-eye-view)';
const FEATURE = 'recordedVideo';
/** Coordinates within this of a town's own centre are that centre. */
const LOCALITY_MATCH_M = 150;

const clean = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const thumbnail = (videoId) =>
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

/**
 * Wikidata SPARQL rows → videos. One per item and video; positions on other
 * globes (the Moon, Mars) are left out.
 */
export function wikidataToVideos(bindings) {
  const videos = [];
  const seen = new Set();
  for (const row of Array.isArray(bindings) ? bindings : []) {
    const qid = /\/(Q\d+)$/.exec(String(row?.item?.value || ''))?.[1];
    const videoId = String(row?.video?.value || '').trim();
    if (!qid || !VIDEO_ID.test(videoId)) continue;
    // Earth coordinates are a bare Point; other globes carry an IRI first.
    const point = /^Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(
      String(row?.coord?.value || '').trim(),
    );
    if (!point) continue;
    const lon = Number(point[1]);
    const lat = Number(point[2]);
    if (!isPlausibleLatLon(lat, lon)) continue;
    const key = `${qid}|${videoId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const place = clean(row?.itemLabel?.value, 160) || qid;
    videos.push({
      id: `wd-${qid}-${videoId}`,
      videoId,
      title: place,
      place,
      wikidataId: qid,
      lat,
      lon,
      coordinatesQuality: 'site',
      source: 'wikidata',
      licenseClass: 'embed-only',
      thumbnailUrl: thumbnail(videoId),
    });
  }
  return videos;
}

/** ISO 8601 duration ("PT1H2M3S") → seconds, or NaN. */
export function durationSeconds(value) {
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      String(value || ''),
    );
  if (!match || value === 'P' || value === 'PT') return NaN;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * A videos.list item → a recorded video, or null with the reason.
 * @returns {{video: object}|{skip: 'short'|'live'|'no-location'|'invalid'}}
 */
export function youtubeItemToVideo(item, { keepShorts = false } = {}) {
  const videoId = String(item?.id || '');
  if (!VIDEO_ID.test(videoId)) return { skip: 'invalid' };
  const broadcast = item?.snippet?.liveBroadcastContent;
  if (broadcast === 'live' || broadcast === 'upcoming') return { skip: 'live' };
  const location = item?.recordingDetails?.location;
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (
    !location ||
    location.latitude === undefined ||
    location.longitude === undefined ||
    !isPlausibleLatLon(lat, lon)
  )
    return { skip: 'no-location' };
  const seconds = durationSeconds(item?.contentDetails?.duration);
  if (!keepShorts && Number.isFinite(seconds) && seconds <= SHORTS_MAX_S)
    return { skip: 'short' };
  const views = Number(item?.statistics?.viewCount);
  return {
    video: {
      id: `yt-${videoId}`,
      videoId,
      title: clean(item?.snippet?.title, 200) || videoId,
      channelTitle: clean(item?.snippet?.channelTitle, 120),
      publishedAt: clean(item?.snippet?.publishedAt, 40),
      recordedAt: clean(item?.recordingDetails?.recordingDate, 40),
      place: clean(item?.recordingDetails?.locationDescription, 160),
      durationS: Number.isFinite(seconds) ? seconds : null,
      views: Number.isFinite(views) ? views : null,
      lat,
      lon,
      coordinatesQuality: 'site',
      source: 'youtube-geotag',
      licenseClass: 'embed-only',
      thumbnailUrl: thumbnail(videoId),
    },
  };
}

/** The exact coordinate a geotag carries, as a grouping key. */
const coordKey = (video) => `${video.lat.toFixed(6)},${video.lon.toFixed(6)}`;

function distanceM(aLat, aLon, bLat, bLon) {
  const meanLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (bLon - aLon) * Math.cos(meanLat) * 111_320,
    (bLat - aLat) * 110_574,
  );
}

/**
 * Precision by how the geotags fall: 'site' when at most two other videos
 * share the exact coordinate, 'area' when three or more do (a place list's
 * pin), 'region' when the coordinate is a town's own centre (`isLocality`,
 * asked once per shared coordinate). Returns new objects.
 * @param {Array<object>} videos
 * @param {{isLocality?: (lat: number, lon: number) => Promise<boolean>}} [options]
 */
export async function assignPrecision(videos, { isLocality } = {}) {
  const groups = new Map();
  for (const video of videos) {
    const key = coordKey(video);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }
  const quality = new Map();
  for (const [key, members] of groups) {
    let value = members.length - 1 >= 3 ? 'area' : 'site';
    if (members.length > 1 && isLocality) {
      const [{ lat, lon }] = members;
      try {
        if (await isLocality(lat, lon)) value = 'region';
      } catch {
        /* no answer: keep what sharing says */
      }
    }
    quality.set(key, value);
  }
  return videos.map((video) => ({
    ...video,
    coordinatesQuality: quality.get(coordKey(video)),
    sharedBy: groups.get(coordKey(video)).length - 1,
  }));
}

/** The search cache key: ~0.05° cells and 5 km radius bands. */
export function searchCacheKey(lat, lon, radiusKm, order) {
  const band = Math.ceil(Math.max(1, radiusKm) / 5) * 5;
  const cell = (v) => (Math.round(v * 20) / 20).toFixed(2);
  return `${cell(lat)},${cell(lon)},${band},${order}`;
}

/**
 * A JSON store of timestamped entries under .gev-cache/recorded-video/,
 * swept of anything older than maxAgeMs whenever it is read or written.
 */
export function createEntryStore(file, { maxAgeMs, now = () => Date.now() }) {
  function load() {
    const document = readJsonFile(file, null);
    const entries =
      document?.entries && typeof document.entries === 'object'
        ? document.entries
        : {};
    const t = now();
    let swept = 0;
    for (const [key, entry] of Object.entries(entries))
      if (!(Number.isFinite(entry?.at) && t - entry.at < maxAgeMs)) {
        delete entries[key];
        swept++;
      }
    return { entries, swept };
  }
  return {
    get(key) {
      return load().entries[key] || null;
    },
    set(key, value) {
      const { entries } = load();
      entries[key] = { ...value, at: now() };
      writeJsonAtomic(file, { version: 1, entries });
    },
    /** Remove what is too old; returns how many entries went. */
    sweep() {
      const { entries, swept } = load();
      if (swept) writeJsonAtomic(file, { version: 1, entries });
      return swept;
    },
    size: () => Object.keys(load().entries).length,
  };
}

/**
 * Is a coordinate a town's own centre? Reverse geocoding with the server
 * key, answered from a 30-day store per coordinate.
 */
export function createLocalityCheck({
  store,
  fetchImpl = (...args) => fetch(...args),
  apiKey = googleServerApiKey,
  quota,
}) {
  return async function isLocality(lat, lon) {
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const held = store.get(key);
    if (held) return held.locality === true;
    const serverKey = String(apiKey() || '').trim();
    if (!serverKey || (quota && !quota.geocode())) return false;
    const url = new URL(GEOCODE_API);
    url.searchParams.set('latlng', `${lat},${lon}`);
    url.searchParams.set('result_type', 'locality');
    url.searchParams.set('key', serverKey);
    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const body = await readResponseJsonCapped(response, 1024 * 1024);
    const town = body?.status === 'OK' ? body.results?.[0] : null;
    const at = town?.geometry?.location;
    const locality =
      Boolean(at) &&
      distanceM(lat, lon, Number(at.lat), Number(at.lng)) <= LOCALITY_MATCH_M;
    store.set(key, { locality });
    return locality;
  };
}

/**
 * The recorded-video service behind /api/video/recorded.
 * @param {{sourceRoot?: string, fetchImpl?: typeof fetch,
 *   apiKey?: () => string, now?: () => number, env?: object,
 *   isLocality?: Function|null, googleApiKey?: () => string}} [options]
 */
export function createRecordedVideoService({
  sourceRoot = process.cwd(),
  fetchImpl = (...args) => fetch(...args),
  apiKey = () => String(process.env.YOUTUBE_API_KEY || '').trim(),
  now = () => Date.now(),
  env = process.env,
  isLocality,
  googleApiKey = googleServerApiKey,
} = {}) {
  const dir = path.join(sourceRoot, RECORDED_VIDEO_DIR);
  const quota = createYoutubeQuota({
    now,
    file: path.join(sourceRoot, FEATURED_CACHE_DIR, 'quota.json'),
  });
  const youtube = createYoutubeClient({
    fetchImpl,
    apiKey,
    quota,
    feature: FEATURE,
  });
  const searches = createEntryStore(path.join(dir, 'searches.json'), {
    maxAgeMs: SEARCH_TTL_MS,
    now,
  });
  const localities = createEntryStore(path.join(dir, 'localities.json'), {
    maxAgeMs: MAX_STORE_MS,
    now,
  });
  const locality =
    isLocality === undefined
      ? createLocalityCheck({
          store: localities,
          fetchImpl,
          quota,
          apiKey: googleApiKey,
        })
      : isLocality;
  const budget = () => {
    const value = Number(env.RECORDED_VIDEO_DAILY_BUDGET);
    return Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_RECORDED_VIDEO_BUDGET;
  };
  const order = () =>
    ['date', 'relevance'].includes(env.RECORDED_VIDEO_ORDER)
      ? env.RECORDED_VIDEO_ORDER
      : 'relevance';
  const inflight = new Map();

  const wikidata = createDailyCachedList({
    name: 'recorded-video-wikidata',
    cacheDir: dir,
    ttlMs: WIKIDATA_TTL_MS,
    now,
    fetcher: async () => {
      const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(WIKIDATA_VIDEO_QUERY)}`;
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/sparql-results+json',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(90_000),
        redirect: 'error',
      });
      const body = await readResponseJsonCapped(response, 16 * 1024 * 1024);
      if (!response.ok) throw new Error(`Wikidata ${response.status}`);
      const bindings = body?.results?.bindings;
      if (!Array.isArray(bindings) || !bindings.length)
        throw new Error('Wikidata returned no rows');
      return wikidataToVideos(bindings);
    },
  });

  async function search(lat, lon, radiusKm, sortOrder) {
    const ids = (
      await youtube.call('search', {
        part: 'id',
        type: 'video',
        location: `${lat.toFixed(4)},${lon.toFixed(4)}`,
        locationRadius: `${radiusKm}km`,
        maxResults: '50',
        order: sortOrder,
      })
    )
      .map((item) => String(item?.id?.videoId || ''))
      .filter((id) => VIDEO_ID.test(id));
    const items = ids.length
      ? await youtube.videos(
          ids,
          'snippet,contentDetails,recordingDetails,statistics',
        )
      : [];
    const kept = [];
    const skipped = { short: 0, live: 0, 'no-location': 0, invalid: 0 };
    for (const item of items) {
      const result = youtubeItemToVideo(item);
      if (result.video) kept.push(result.video);
      else skipped[result.skip]++;
    }
    const videos = await assignPrecision(kept, { isLocality: locality });
    return { returned: ids.length, skipped, videos };
  }

  return {
    /** Every Wikidata video (cached weekly). */
    wikidataVideos: () => wikidata(sourceRoot),

    /**
     * Geotagged videos near a point.
     * @returns {Promise<{status: number, body: object}>}
     */
    async near(lat, lon, radiusKm, { order: requested } = {}) {
      if (!isPlausibleLatLon(lat, lon))
        return { status: 400, body: { error: 'near=lat,lon is required' } };
      const radius = Math.min(
        MAX_RADIUS_KM,
        Math.max(1, Math.round(Number(radiusKm) || 10)),
      );
      const sortOrder = ['date', 'relevance'].includes(requested)
        ? requested
        : order();
      const key = searchCacheKey(lat, lon, radius, sortOrder);
      const used = () => ({ used: quota.usedBy(FEATURE), budget: budget() });
      const held = searches.get(key);
      if (held)
        return {
          status: 200,
          body: { ...held.result, cached: true, quota: used() },
        };
      if (!youtube.hasKey())
        return {
          status: 200,
          body: { videos: [], configured: false, quota: used() },
        };
      if (quota.usedBy(FEATURE) + QUERY_COST > budget())
        return {
          status: 429,
          body: {
            error: 'Recorded video search budget reached for today',
            videos: [],
            quota: used(),
          },
        };
      if (!inflight.has(key))
        inflight.set(
          key,
          search(
            Math.round(lat * 20) / 20,
            Math.round(lon * 20) / 20,
            radius,
            sortOrder,
          )
            .then((result) => {
              searches.set(key, { result });
              return result;
            })
            .finally(() => inflight.delete(key)),
        );
      try {
        const result = await inflight.get(key);
        return {
          status: 200,
          body: { ...result, cached: false, quota: used() },
        };
      } catch (error) {
        return {
          status: 502,
          body: {
            error: String(error?.message || 'YouTube search failed').slice(
              0,
              200,
            ),
            videos: [],
            quota: used(),
          },
        };
      }
    },

    /** Drop stored YouTube data past its age; returns entries removed. */
    sweep: () => searches.sweep() + localities.sweep(),
    quota: () => ({ used: quota.usedBy(FEATURE), budget: budget() }),
  };
}
