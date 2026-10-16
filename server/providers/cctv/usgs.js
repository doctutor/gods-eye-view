import { readCappedResponseText, discardResponseBody } from '../common/http.js';
import { createDailyCachedList } from './dailyCache.js';
import { isPlausibleLatLon } from './normalize.js';

/**
 * USGS volcano webcams: the stills USGS volcano observatories publish
 * through the Alaska Volcano Observatory's "ashcam" webcam API, which serves
 * AVO (Alaska), CVO (Cascades), YVO (Yellowstone) and some HVO (Hawaii)
 * cameras in one list. (HVO's own hvoWebcamsApi answered `[]` on every
 * endpoint in 2026-10.) Each camera's current still is USGS-hosted and
 * refreshed every few minutes; US Government work, public domain.
 *
 * Only cameras with plausible coordinates, a USGS-hosted current still and
 * a picture from the last few days are kept. A few cameras re-host a third
 * party's image (a ski lodge, a state DOT); those whose external page is not
 * a government site are left out, since USGS's public-domain status does not
 * extend to them.
 *
 * Small (a couple of hundred cameras), so it joins the capped catalog like
 * any other pack. The list is fetched at most once a day (dailyCache.js).
 *
 * Personal-fork pack; not part of upstream God's Eye View.
 */

export const USGS_ASHCAM_URL =
  'https://avo-volcview.wr.usgs.gov/ashcam-api/webcamApi/webcams';
const IMAGE_HOST = 'avo-volcview.wr.usgs.gov';
/** Cameras whose newest still is older than this are left out. */
export const USGS_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 (+https://github.com/doctutor/gods-eye-view)';

const OBSERVATORIES = Object.freeze({
  AVO: 'Alaska Volcano Observatory',
  CVO: 'Cascades Volcano Observatory',
  YVO: 'Yellowstone Volcano Observatory',
  HVO: 'Hawaiian Volcano Observatory',
  USGS: 'USGS volcano webcam',
});

/** Which observatory a camera belongs to, from its code, name and place. */
export function observatoryFor(cam) {
  const code = String(cam?.webcamCode || '');
  const lat = Number(cam?.latitude);
  const lon = Number(cam?.longitude);
  if (/^ys-/i.test(code) || /yellowstone/i.test(String(cam?.vName || '')))
    return 'YVO';
  if (/^CVO\b/.test(String(cam?.webcamName || ''))) return 'CVO';
  if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) return 'HVO';
  if (lat >= 51 && lat <= 72 && (lon <= -129 || lon >= 170)) return 'AVO';
  return 'USGS';
}

const clean = (value, max = 120) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A parsed http(s) URL on a US government host, else null. */
function governmentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return /(?:^|\.)(?:gov|mil)$/i.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The USGS-hosted current still, else ''. */
function stillUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== IMAGE_HOST) return '';
    if (!/\.jpe?g$/i.test(url.pathname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * Normalize ashcam API webcams.
 * @param {Array<object>} webcams - `webcams` from the ashcam API.
 * @param {{now?: number}} [options]
 * @returns {Array<object>}
 */
export function ashcamToSources(webcams, { now = Date.now() } = {}) {
  const sources = [];
  const seen = new Set();
  for (const cam of Array.isArray(webcams) ? webcams : []) {
    const code = String(cam?.webcamCode || '');
    if (!/^[\w.-]{1,64}$/.test(code) || seen.has(code)) continue;
    const lat = Number(cam.latitude);
    const lon = Number(cam.longitude);
    if (!isPlausibleLatLon(lat, lon)) continue;
    if (cam.hasImages !== 'Y') continue;
    const still = stillUrl(cam.currentImageUrl);
    if (!still) continue;
    const lastAt = Number(cam.lastImageTimestamp) * 1000;
    if (!(lastAt >= now - USGS_FRESH_MS)) continue;
    // A re-hosted third-party image (ski lodge, state DOT page) is not
    // USGS's to put in the public domain.
    // (The FAA's Alaska aviation cams are a government source too.)
    const external = String(cam.externalUrl || '').trim();
    const government = governmentUrl(external);
    if (external && !government) continue;
    const operatorUrl =
      government?.protocol === 'https:' ? government.href : '';
    seen.add(code);
    const observatory = observatoryFor(cam);
    // An unfilled record carries bearing 0 and elevation 0 (128 of 461 in
    // 2026-10, Kilauea and Yellowstone among them): 0 means unknown.
    const bearing = Number(cam.bearingDeg);
    const hasHeading =
      Number.isFinite(bearing) && bearing > 0 && bearing <= 360;
    const elevation = Number(cam.elevationM);
    const name = clean(cam.webcamName) || code;
    sources.push({
      id: `usgs-volcano-${code}`,
      name,
      city: clean(cam.vName, 80) || OBSERVATORIES[observatory],
      cityId: 'usgs-volcano',
      provider: 'USGS',
      credit: 'USGS (public domain)',
      lat,
      lon,
      headingDeg: hasHeading ? bearing % 360 : NaN,
      headingConfidence: hasHeading ? 'high' : 'low',
      // A volcano cam looks kilometres out over open ground.
      pitchDeg: -2,
      fovDeg: 50,
      rangeM: 3000,
      mountHeightM: 3,
      ...(Number.isFinite(elevation) && elevation !== 0
        ? { groundElevationM: Math.max(-100, Math.min(6200, elevation)) }
        : {}),
      feedType: 'image',
      url: still,
      snapshotUrl: still,
      sourceKind: 'usgs-volcano-webcam',
      license: `${OBSERVATORIES[observatory]} webcam (USGS, public domain)`,
      code: code.toUpperCase(),
      category: 'volcano',
      coordinatesQuality: 'site',
      operatorUrl,
      publishSignal: 'agency-api',
      licenseClass: 'public-domain',
    });
  }
  return sources;
}

/**
 * The pack loader.
 * @param {{fetchImpl?: typeof fetch, now?: () => number,
 *   cacheDir?: string}} [options]
 */
export function createUsgsVolcanoLoader({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  cacheDir,
} = {}) {
  async function fetchList() {
    const response = await fetchImpl(USGS_ASHCAM_URL, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`USGS ashcam ${response.status}`);
    }
    const { tooLarge, text } = await readCappedResponseText(
      response,
      MAX_BYTES,
    );
    if (tooLarge) throw new Error('response too large');
    let webcams;
    try {
      webcams = JSON.parse(text)?.webcams;
    } catch {
      throw new Error('USGS ashcam returned malformed JSON');
    }
    if (!Array.isArray(webcams) || !webcams.length)
      throw new Error('USGS ashcam returned no webcams');
    return ashcamToSources(webcams, { now: now() });
  }

  const list = createDailyCachedList({
    name: 'usgs-volcano',
    fetcher: fetchList,
    now,
    cacheDir,
  });
  return async function loadUsgsVolcanoCams({ sourceRoot } = {}) {
    return list(sourceRoot);
  };
}
