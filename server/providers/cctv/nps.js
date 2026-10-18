import { readCappedResponseText, discardResponseBody } from '../common/http.js';
import { createDailyCachedList } from './dailyCache.js';
import { classifyWebcamUrl } from './linked.js';
import { isPlausibleLatLon } from './normalize.js';
import { withObservations } from './observed.js';

/**
 * US National Park Service webcams, from the NPS Data API
 * (developer.nps.gov/api/v1/webcams). The API needs a free key
 * (NPS_API_KEY, sent as X-Api-Key); without one the pack logs once and
 * contributes nothing. NPS content is a US Government work, public domain.
 *
 * Only webcams with status Active and plausible coordinates are kept, and
 * none whose whole title is a content-system placeholder ("Question 5",
 * "Test": records the API lists as Active with no park and no camera). Links
 * are classified like linked.js: a direct image or HTTPS HLS stream plays in
 * the app, a YouTube link embeds, and anything else (most of them: the
 * park's webcam page) is a pin that opens the page.
 *
 * The list is paged (50 a page, at most MAX_PAGES pages) and fetched at most
 * once a day (dailyCache.js); a failed refresh serves the old copy.
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export const NPS_WEBCAMS_URL = 'https://developer.nps.gov/api/v1/webcams';
export const NPS_PAGE_SIZE = 50;
/** At most this many pages (1,000 webcams; the API lists a few hundred). */
export const NPS_MAX_PAGES = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 (+https://github.com/doctutor/gods-eye-view)';

const clean = (value, max = 120) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A category word from a webcam's title; 'nature' when nothing fits. */
export function npsCategory(title) {
  const t = String(title || '');
  if (/volcan|crater|lava|caldera|kīlauea|kilauea|halema/i.test(t))
    return 'volcano';
  if (/beach|coast|shore|ocean|\bbay\b|harbor|harbour|lighthouse/i.test(t))
    return 'beach';
  if (/\b(?:mount|mt\.?|peak|summit|ridge|glacier)\b/i.test(t))
    return 'mountain';
  if (/bear|eagle|falcon|osprey|\bnest|bison|elk|wildlife|bird/i.test(t))
    return 'wildlife';
  return 'nature';
}

/** The pose and playback fields for one classified link (as linked.js). */
function feedFields(classified) {
  switch (classified.kind) {
    case 'image':
      return {
        feedType: 'image',
        url: classified.url,
        snapshotUrl: classified.url,
      };
    case 'hls':
      return { feedType: 'hls', url: classified.url, snapshotUrl: '' };
    case 'youtube':
      return {
        feedType: 'youtube',
        url: classified.url,
        snapshotUrl: `https://i.ytimg.com/vi/${classified.videoId}/hqdefault.jpg`,
        embed: { provider: 'youtube', videoId: classified.videoId },
        liveStatus: 'unknown',
      };
    default:
      return { feedType: 'link', url: '', snapshotUrl: '' };
  }
}

/** Titles the NPS content system leaves on records that are not webcams. */
export const NPS_PLACEHOLDER_TITLE =
  /^\s*(?:question\s*\d+|test(?:\s*\d+)?|untitled|new webcam)\s*$/i;

const coordinate = (value) =>
  value === null || value === undefined || String(value).trim() === ''
    ? NaN
    : Number(value);

/**
 * Normalize NPS API webcams.
 * @param {Array<object>} webcams - `data` from /webcams pages.
 * @returns {Array<object>}
 */
export function npsToSources(webcams) {
  const sources = [];
  const seen = new Set();
  for (const cam of Array.isArray(webcams) ? webcams : []) {
    const id = String(cam?.id || '');
    if (!/^[\w-]{1,64}$/.test(id) || seen.has(id)) continue;
    if (String(cam.status || '').toLowerCase() !== 'active') continue;
    if (NPS_PLACEHOLDER_TITLE.test(String(cam.title || ''))) continue;
    const lat = coordinate(cam.latitude);
    const lon = coordinate(cam.longitude);
    if (!isPlausibleLatLon(lat, lon)) continue;
    const classified = classifyWebcamUrl(cam.url);
    if (!classified) continue;
    seen.add(id);
    const park = Array.isArray(cam.relatedParks) ? cam.relatedParks[0] : null;
    const name =
      clean(cam.title) || clean(park?.fullName) || `NPS webcam ${id}`;
    sources.push({
      id: `nps-webcam-${id}`,
      name,
      city: clean(park?.fullName, 80) || 'National Park Service',
      cityId: 'nps-webcams',
      provider: 'National Park Service',
      credit: 'NPS (public domain)',
      lat,
      lon,
      headingDeg: NaN,
      headingConfidence: 'low',
      rangeM: 400,
      sourceKind: 'nps-webcam',
      license: 'National Park Service webcam (US Government, public domain)',
      code: name.toUpperCase(),
      category: npsCategory(cam.title),
      coordinatesQuality: 'site',
      operatorUrl: classified.url,
      publishSignal: 'agency-api',
      licenseClass:
        classified.kind === 'youtube' ? 'embed-only' : 'public-domain',
      ...feedFields(classified),
    });
  }
  return sources;
}

/**
 * The pack loader. Reads NPS_API_KEY at each load, so a key added to .env
 * takes effect on the next catalog refresh after a restart.
 * @param {{fetchImpl?: typeof fetch, now?: () => number, cacheDir?: string,
 *   env?: object}} [options]
 */
export function createNpsLoader({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  cacheDir,
  env = process.env,
} = {}) {
  let warnedKeyless = false;

  async function fetchPage(apiKey, start) {
    const url = `${NPS_WEBCAMS_URL}?limit=${NPS_PAGE_SIZE}&start=${start}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Api-Key': apiKey,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`NPS ${response.status}`);
    }
    const { tooLarge, text } = await readCappedResponseText(
      response,
      MAX_BYTES,
    );
    if (tooLarge) throw new Error('response too large');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('NPS returned malformed JSON');
    }
    if (!Array.isArray(parsed?.data)) throw new Error('NPS returned no data');
    return parsed;
  }

  async function fetchAll(apiKey) {
    const webcams = [];
    for (let page = 0; page < NPS_MAX_PAGES; page++) {
      const parsed = await fetchPage(apiKey, page * NPS_PAGE_SIZE);
      webcams.push(...parsed.data);
      const total = Number(parsed.total);
      if (!parsed.data.length) break;
      if (Number.isFinite(total) && webcams.length >= total) break;
    }
    if (!webcams.length) throw new Error('NPS returned no webcams');
    return npsToSources(webcams);
  }

  let currentKey = '';
  const list = createDailyCachedList({
    name: 'nps',
    fetcher: () => fetchAll(currentKey),
    now,
    cacheDir,
  });

  return async function loadNpsWebcams({ sourceRoot } = {}) {
    const apiKey = String(env.NPS_API_KEY || '').trim();
    if (!apiKey) {
      if (!warnedKeyless) {
        warnedKeyless = true;
        console.log('[CCTV] NPS webcams skipped: NPS_API_KEY is not set');
      }
      // Personal fork: why it is empty, for the status readout.
      return Object.assign([], { skipped: 'NPS_API_KEY is not set' });
    }
    currentKey = apiKey;
    // Personal fork: what viewers' frame fetches saw (observed.js).
    return withObservations(await list(sourceRoot), sourceRoot);
  };
}
