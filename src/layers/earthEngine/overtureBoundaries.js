/**
 * Personal fork: Overture's country lines for the Administrative boundaries
 * layer, from the local server's /api/boundaries/countries
 * (server/providers/overtureBoundaries.js, built by
 * `npm run overture:boundaries`). While the build is there, COUNTRIES (and
 * AUTO from orbit) drape `overtureBoundariesImageryOptions` in place of
 * Earth Engine's LSIB 2017 tiles; without it COUNTRIES keeps LSIB. Nothing
 * here imports Cesium.
 */
import {
  BOUNDARY_INKS,
  OVERTURE_BOUNDARIES_ENDPOINT,
} from '../../data/overtureBoundaries.js';

/** The status is asked for again after this long. */
export const STATUS_TTL_MS = 5 * 60 * 1000;
const INKS = Object.keys(BOUNDARY_INKS);

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The server's /layers answer, checked on the way in. */
export function toOvertureBoundariesStatus(body) {
  const versions = Object.fromEntries(
    Object.entries(body?.versions || {}).filter(
      ([ink, hash]) =>
        INKS.includes(ink) && /^[0-9a-f]{12}$/.test(String(hash)),
    ),
  );
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message) : '',
    attribution: text(body?.attribution, 300),
    builtAt: body?.builtAt ? text(body.builtAt, 40) : null,
    minZoom: Number.isInteger(body?.minZoom) ? body.minZoom : 0,
    maxZoom: Number.isInteger(body?.maxZoom) ? Math.min(18, body.maxZoom) : 14,
    versions,
  };
}

/** Whether the build is there and has tiles in `ink`. */
export function overtureBoundariesReady(status, ink = 'light') {
  return Boolean(
    status?.configured && INKS.includes(ink) && status.versions?.[ink],
  );
}

/**
 * Options for `new Cesium.UrlTemplateImageryProvider(...)` in an ink, or
 * null when the build is not ready. The version (the server's hash of the
 * style and the build) only busts the browser's cache.
 */
export function overtureBoundariesImageryOptions(status, ink) {
  if (!overtureBoundariesReady(status, ink)) return null;
  return {
    url: `${OVERTURE_BOUNDARIES_ENDPOINT}/tile/${ink}/{z}/{x}/{y}?v=${status.versions[ink]}`,
    minimumLevel: status.minZoom,
    maximumLevel: status.maxZoom,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: status.attribution,
  };
}

/**
 * The status, shared and kept STATUS_TTL_MS; a failed request reads as not
 * built (COUNTRIES then draws LSIB 2017 from Earth Engine).
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createOvertureBoundariesSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    try {
      const response = await fetchImpl(
        `${OVERTURE_BOUNDARIES_ENDPOINT}/layers`,
        { credentials: 'same-origin' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        return {
          ...toOvertureBoundariesStatus({}),
          message: text(body?.error || `HTTP ${response.status}`),
          at: now(),
        };
      return { ...toOvertureBoundariesStatus(body), at: now() };
    } catch (error) {
      return {
        ...toOvertureBoundariesStatus({}),
        message: text(error?.message || error),
        at: now(),
      };
    }
  }

  return {
    async status({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < STATUS_TTL_MS) return held;
      inflight ||= load()
        .then((status) => (held = status))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    last: () => held,
  };
}
