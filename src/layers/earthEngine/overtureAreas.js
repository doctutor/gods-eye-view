/**
 * Personal fork: Overture's division areas for the Administrative
 * boundaries layer, from the local server's /api/boundaries/areas
 * (server/providers/overtureAreas.js, built by `npm run overture:areas`):
 * the status, the fill and coast tiles' options, and a point's units for
 * the click card. Nothing here imports Cesium.
 */
import {
  BOUNDARY_INKS,
  OVERTURE_AREAS_ENDPOINT,
} from '../../data/overtureBoundaries.js';

/** The status is asked for again after this long. */
export const AREAS_STATUS_TTL_MS = 5 * 60 * 1000;
const INKS = Object.keys(BOUNDARY_INKS);
const FILLS = ['regions', 'districts'];
const HASH = /^[0-9a-f]{12}$/;

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const keep = (raw, keys) =>
  Object.fromEntries(
    Object.entries(raw || {}).filter(
      ([key, hash]) => keys.includes(key) && HASH.test(String(hash)),
    ),
  );

/** The server's /layers answer, checked on the way in. */
export function toOvertureAreasStatus(body) {
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message, 400) : '',
    attribution: text(body?.attribution, 300),
    maxZoom: Number.isInteger(body?.maxZoom) ? Math.min(18, body.maxZoom) : 14,
    fill: keep(body?.versions?.fill, FILLS),
    coast: keep(body?.versions?.coast, INKS),
  };
}

const imagery = (status, url) => ({
  url,
  minimumLevel: 0,
  maximumLevel: status.maxZoom,
  tileWidth: 256,
  tileHeight: 256,
  hasAlphaChannel: true,
  credit: status.attribution,
});

/** The fill tiles of a set (regions, districts), or null when not built. */
export function areaFillImageryOptions(status, set) {
  const version = status?.configured ? status.fill?.[set] : null;
  if (!version) return null;
  return imagery(
    status,
    `${OVERTURE_AREAS_ENDPOINT}/fill/${set}/{z}/{x}/{y}?v=${version}`,
  );
}

/** The coast tiles in an ink, or null when not built. */
export function areaCoastImageryOptions(status, ink) {
  const version = status?.configured ? status.coast?.[ink] : null;
  if (!version) return null;
  return imagery(
    status,
    `${OVERTURE_AREAS_ENDPOINT}/coast/${ink}/{z}/{x}/{y}?v=${version}`,
  );
}

const unitOf = (raw) =>
  raw && typeof raw === 'object' && raw.name
    ? {
        name: text(raw.name, 120),
        nameEn: raw.nameEn ? text(raw.nameEn, 120) : null,
        subtype: text(raw.subtype, 20),
        country: raw.country ? text(raw.country, 8) : null,
      }
    : null;

/** The /identify answer, checked on the way in. */
export function toIdentifyAnswer(body) {
  const units = {};
  for (const slot of ['country', 'region', 'county']) {
    const unit = unitOf(body?.units?.[slot]);
    if (unit) units[slot] = unit;
  }
  return {
    land: body?.land === true,
    units,
    sea: unitOf(body?.sea),
    attribution: text(body?.attribution, 300),
  };
}

/**
 * The status (shared, kept AREAS_STATUS_TTL_MS; a failure reads as not
 * built) and a point's units.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createOvertureAreasSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    try {
      const response = await fetchImpl(`${OVERTURE_AREAS_ENDPOINT}/layers`, {
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({}));
      return { ...toOvertureAreasStatus(response.ok ? body : {}), at: now() };
    } catch (error) {
      return {
        ...toOvertureAreasStatus({}),
        message: text(error?.message || error),
        at: now(),
      };
    }
  }

  return {
    async status({ refresh = false } = {}) {
      if (!refresh && held && now() - held.at < AREAS_STATUS_TTL_MS)
        return held;
      inflight ||= load()
        .then((status) => (held = status))
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    last: () => held,

    /** A point's units, or null when the server cannot say. */
    async identify(lat, lon) {
      try {
        const response = await fetchImpl(
          `${OVERTURE_AREAS_ENDPOINT}/identify?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`,
          { credentials: 'same-origin' },
        );
        if (!response.ok) return null;
        return toIdentifyAnswer(await response.json());
      } catch {
        return null;
      }
    },
  };
}
