/**
 * Personal fork: the self-hosted HydroSHEDS v2 rivers for the Americas, from
 * the local server's /api/rivers/v2 (server/providers/riversV2.js, built by
 * `npm run rivers:build`). The Rivers layer asks `riversV2Ready` whether the
 * build is there and, when it is, draws `riversV2ImageryOptions` with
 * Cesium's UrlTemplateImageryProvider over the Americas instead of
 * HydroRIVERS v1. Nothing here imports Cesium.
 */

export const RIVERS_V2_ENDPOINT = '/api/rivers/v2';
/** The status is asked for again after this long. */
export const STATUS_TTL_MS = 5 * 60 * 1000;
/** The inks the server draws (the Rivers layer's LIGHT and DARK). */
export const RIVERS_V2_INKS = Object.freeze(['light', 'dark']);

const text = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const finite = (value) => Number.isFinite(value);

/** The server's /layers answer, checked on the way in. */
export function toRiversV2Status(body) {
  const versions = Object.fromEntries(
    Object.entries(body?.versions || {}).filter(
      ([ink, hash]) =>
        RIVERS_V2_INKS.includes(ink) && /^[0-9a-f]{12}$/.test(String(hash)),
    ),
  );
  const extent = body?.extent;
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message) : '',
    attribution: text(body?.attribution, 300),
    builtAt: body?.builtAt ? text(body.builtAt, 40) : null,
    minZoom: Number.isInteger(body?.minZoom) ? body.minZoom : 0,
    maxZoom: Number.isInteger(body?.maxZoom) ? Math.min(18, body.maxZoom) : 14,
    versions,
    extent:
      extent &&
      ['west', 'south', 'east', 'north'].every((k) => finite(extent[k]))
        ? {
            west: extent.west,
            south: extent.south,
            east: extent.east,
            north: extent.north,
          }
        : null,
    bands: (Array.isArray(body?.bands) ? body.bands : [])
      .filter(
        (band) =>
          Number.isInteger(band?.minZoom) &&
          Number.isInteger(band?.maxZoom) &&
          Number.isInteger(band?.maxOrder),
      )
      .map(({ minZoom, maxZoom, maxOrder, minUplandKm2 }) => ({
        minZoom,
        maxZoom,
        maxOrder,
        ...(finite(minUplandKm2) ? { minUplandKm2 } : {}),
      })),
  };
}

/** Whether the v2 build is there and has tiles in `ink`. */
export function riversV2Ready(status, ink = 'light') {
  return Boolean(
    status?.configured &&
    RIVERS_V2_INKS.includes(ink) &&
    status.versions?.[ink],
  );
}

/**
 * The tile URL template in an ink. `version` (the server's hash of the style
 * and the build) only busts the browser's cache: the server reads the path.
 */
export function riversV2TileTemplate(ink, version) {
  if (!RIVERS_V2_INKS.includes(ink)) throw new Error(`No rivers ink ${ink}`);
  const query = /^[0-9a-f]{12}$/.test(String(version || ''))
    ? `?v=${version}`
    : '';
  return `${RIVERS_V2_ENDPOINT}/tile/${ink}/{z}/{x}/{y}${query}`;
}

/**
 * Options for `new Cesium.UrlTemplateImageryProvider(...)` in an ink, or
 * null when the build is not ready. `rectangleDegrees` is the data's
 * extent: pass it as `rectangle: Rectangle.fromDegrees(west, south, east,
 * north)` so Cesium asks for no tile outside the Americas.
 */
export function riversV2ImageryOptions(status, ink) {
  if (!riversV2Ready(status, ink)) return null;
  return {
    url: riversV2TileTemplate(ink, status.versions[ink]),
    minimumLevel: status.minZoom,
    maximumLevel: status.maxZoom,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: status.attribution,
    rectangleDegrees: status.extent,
  };
}

/**
 * The status, shared and kept STATUS_TTL_MS; a failed request reads as
 * not ready (the Rivers layer then keeps HydroRIVERS v1 everywhere).
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createRiversV2Source({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    try {
      const response = await fetchImpl(`${RIVERS_V2_ENDPOINT}/layers`, {
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        return {
          ...toRiversV2Status({}),
          message: text(body?.error || `HTTP ${response.status}`),
          at: now(),
        };
      return { ...toRiversV2Status(body), at: now() };
    } catch (error) {
      return {
        ...toRiversV2Status({}),
        message: text(error?.message || error),
        at: now(),
      };
    }
  }

  return {
    /** @returns {Promise<ReturnType<typeof toRiversV2Status>>} */
    async status({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < STATUS_TTL_MS) return held;
      inflight ||= load()
        .then((status) => (held = status))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    /** The last status seen, if any. */
    last: () => held,
  };
}
