// Personal fork: Google Street View indoor views for the Street Level layer.
import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';

/** Identity of the Google indoor-views provider. */
export const GSV_INDOOR_PROVIDER_ID = 'gsv-indoor';
export const GSV_INDOOR_NAME = 'Google indoor views';
export const GSV_INDOOR_LABEL = 'GOOGLE INDOOR';
/** The browser key frames the Maps Embed viewer; the server key probes. */
export const GSV_INDOOR_KEY_ID = 'google-maps';
export const GSV_INDOOR_ROUTE = '/api/streetview/indoor';

/** Methods a source (./source.js or a stand-in) must have. */
export const GSV_INDOOR_SOURCE_METHODS = Object.freeze([
  'getStatus',
  'hitsNear',
  'probe',
  'embedKey',
]);

/** Stable id prefixes for picked primitives; every one starts with `gsv-indoor:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'gsv-indoor:',
  pano: 'gsv-indoor:pano:',
});

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS[GSV_INDOOR_PROVIDER_ID],
  selected: SHARED_COLORS.selected,
});

export const GSV_INDOOR_CREDIT_HTML = 'Street View imagery © Google';

/** Camera settle → refetch hits, debounced. */
export const COVERAGE_DEBOUNCE_MS = 600;
/** Hits are fetched around the view centre within camera height × this. */
export const FETCH_RADIUS_PER_HEIGHT = 1.5;
export const FETCH_RADIUS_MIN_M = 400;
export const FETCH_RADIUS_MAX_M = 8000;
/** Above this camera height no hits are drawn (they would be sub-pixel clutter). */
export const COVERAGE_MAX_HEIGHT_M = 60_000;
/** Below this camera height unprobed ground around the view centre is probed. */
export const PROBE_BELOW_HEIGHT_M = 3000;
export const PROBE_RADIUS_KM = 0.5;
/** A failed or refused probe holds further probes back this long. */
export const PROBE_BACKOFF_MS = 60_000;
/** Nearest indoor view to open from a point: hits are sparse, so wider than Mapillary's. */
export const NEAREST_INDOOR_RADIUS_M = 150;
export const PIN_SIZE_PX = 10;
export const MAX_PINS = 3000;

/** Google panorama ids, as the metadata API returns them. */
export const PANO_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

export function isPanoId(value) {
  return typeof value === 'string' && PANO_ID_PATTERN.test(value);
}

/**
 * The only URL the viewer ever frames: the free Maps Embed API Street View
 * mode for one validated panorama. Null for a bad id or no key.
 */
export function embedUrl(key, panoId) {
  const apiKey = String(key || '').trim();
  if (!apiKey || !isPanoId(panoId)) return null;
  return `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(apiKey)}&pano=${panoId}`;
}

/** Deep link to the panorama on Google Maps. */
export function panoExternalUrl(panoId) {
  if (!isPanoId(panoId)) return 'https://www.google.com/maps';
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${panoId}`;
}

/** "2019-05" → epoch ms of the month's first day (UTC), else null. */
export function panoDateMs(date) {
  const match = /^(\d{4})-(\d{2})/.exec(String(date || ''));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  return Number.isFinite(ms) ? ms : null;
}
