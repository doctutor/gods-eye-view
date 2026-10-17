/**
 * Personal fork: the Recorded Video layer's data, from the local server's
 * /api/video/recorded routes (server/providers/recordedVideo.js). Videos are
 * re-checked here on the way in: the server assembled them from Wikidata and
 * YouTube answers.
 */

export const RECORDED_VIDEO_ENDPOINT = '/api/video/recorded';
export const PRECISIONS = Object.freeze(['site', 'area', 'region']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Pin style per precision: site solid, area hollow, region faint. */
export const PRECISION_STYLE = Object.freeze({
  // i18n-ignore: internal code; shown through precisionLabel() in player.js
  site: Object.freeze({ fill: 1, outline: 1, pixelSize: 10, label: 'SITE' }),
  // i18n-ignore: internal code; shown through precisionLabel() in player.js
  area: Object.freeze({ fill: 0, outline: 1, pixelSize: 11, label: 'AREA' }),
  region: Object.freeze({
    fill: 0.3,
    outline: 0.35,
    pixelSize: 9,
    // i18n-ignore: internal code; shown through precisionLabel() in player.js
    label: 'REGION',
  }),
});
/** Wikidata pins and YouTube geotag pins in two hues. */
export const SOURCE_COLOR = Object.freeze({
  wikidata: '#ffd166',
  'youtube-geotag': '#ff5d73',
});

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** One server video → a layer record, or null. */
export function toRecord(video) {
  const videoId = String(video?.videoId || '');
  if (!VIDEO_ID.test(videoId)) return null;
  const lat = Number(video.lat);
  const lon = Number(video.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const source = video.source === 'wikidata' ? 'wikidata' : 'youtube-geotag';
  const wikidataId = /^Q\d+$/.test(String(video.wikidataId || ''))
    ? String(video.wikidataId)
    : '';
  return {
    id:
      source === 'wikidata' && wikidataId
        ? `wd-${wikidataId}-${videoId}`
        : `yt-${videoId}`,
    videoId,
    title: text(video.title) || videoId,
    place: text(video.place, 160),
    channelTitle: text(video.channelTitle, 120),
    publishedAt: text(video.publishedAt, 40),
    recordedAt: text(video.recordedAt, 40),
    durationS: Number.isFinite(Number(video.durationS))
      ? Number(video.durationS)
      : null,
    lat,
    lon,
    coordinatesQuality: PRECISIONS.includes(video.coordinatesQuality)
      ? video.coordinatesQuality
      : 'region',
    sharedBy: Number.isFinite(Number(video.sharedBy))
      ? Number(video.sharedBy)
      : 0,
    source,
    wikidataId,
  };
}

async function getJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 429)
    throw new Error(body?.error || `HTTP ${response.status}`);
  return { status: response.status, body };
}

/** Every Wikidata video with coordinates. */
export async function fetchWikidataVideos({
  fetchImpl = (...a) => fetch(...a),
  signal,
} = {}) {
  const { body } = await getJson(
    fetchImpl,
    `${RECORDED_VIDEO_ENDPOINT}/wikidata`,
    signal,
  );
  return (Array.isArray(body?.videos) ? body.videos : [])
    .map(toRecord)
    .filter(Boolean);
}

/**
 * Geotagged YouTube videos near a point.
 * @returns {Promise<{records: Array<object>, refused: boolean,
 *   configured: boolean}>}
 */
export async function fetchNearVideos(
  lat,
  lon,
  radiusKm,
  { fetchImpl = (...a) => fetch(...a), signal, refresh = false } = {},
) {
  const url = `${RECORDED_VIDEO_ENDPOINT}?near=${lat.toFixed(4)},${lon.toFixed(4)}&radiusKm=${Math.round(radiusKm)}${refresh ? '&refresh=1' : ''}`;
  const { status, body } = await getJson(fetchImpl, url, signal);
  return {
    records: (Array.isArray(body?.videos) ? body.videos : [])
      .map(toRecord)
      .filter(Boolean),
    refused: status === 429,
    configured: body?.configured !== false,
    cached: body?.cached === true,
    quota:
      body?.quota && Number.isFinite(Number(body.quota.budget))
        ? {
            used: Number(body.quota.used) || 0,
            budget: Number(body.quota.budget),
            remaining: Number.isFinite(Number(body.quota.remaining))
              ? Number(body.quota.remaining)
              : Math.max(
                  0,
                  Number(body.quota.budget) - (Number(body.quota.used) || 0),
                ),
          }
        : null,
  };
}

/**
 * The search a settled view asks for: its centre, a radius from the camera
 * height (1–50 km), and the cache cell it falls in, or null when the view is
 * too high to search.
 */
export function viewQuery(lat, lon, heightM, { maxHeightM = 50_000 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!(heightM > 0 && heightM <= maxHeightM)) return null;
  const radiusKm = Math.min(50, Math.max(2, Math.round(heightM / 1000)));
  const band = Math.ceil(radiusKm / 5) * 5;
  const cell = `${Math.round(lat * 20)},${Math.round(lon * 20)},${band}`;
  return { lat, lon, radiusKm, cell };
}
