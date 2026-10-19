/**
 * Personal fork: Overture Maps buildings for the Buildings layer where
 * Google Open Buildings has no data, from the local server's
 * /api/overture (server/providers/overture.js, built by
 * `npm run overture:build -- --buildings`). The Buildings layer asks
 * `overtureBuildingsReady` whether the build is there and, when it is,
 * drapes `overtureBuildingsImageryOptions` beside Earth Engine's tiles:
 * the build leaves out every building inside an Open Buildings box, so the
 * two never draw the same place. Nothing here imports Cesium.
 */
import {
  OVERTURE_BUILDING_INKS,
  OVERTURE_BUILDING_MODES,
  OVERTURE_BUILDINGS_ENDPOINT,
  OVERTURE_BUILDINGS_MAX_ZOOM,
} from '../../data/overtureBuildings.js';

/** The status is asked for again after this long. */
export const STATUS_TTL_MS = 5 * 60 * 1000;

const text = (value, max = 600) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const isBox = (box) =>
  Array.isArray(box) &&
  box.length === 4 &&
  box.every(Number.isFinite) &&
  box[0] < box[2] &&
  box[1] < box[3];

/** The buildings part of /api/overture/layers, checked on the way in. */
export function toOvertureBuildingsStatus(body) {
  const b = body?.buildings;
  const ready =
    b?.configured === true && /^[0-9a-f]{12}$/.test(String(b?.version || ''));
  return {
    configured: ready,
    version: ready ? b.version : '',
    message: b?.message ? text(b.message, 300) : '',
    attribution: text(b?.attribution),
    buildings: Number.isSafeInteger(b?.buildings) ? b.buildings : 0,
    maxZoom: Number.isInteger(b?.maxZoom)
      ? Math.min(OVERTURE_BUILDINGS_MAX_ZOOM, b.maxZoom)
      : OVERTURE_BUILDINGS_MAX_ZOOM,
    boxes: Object.values(b?.regionBoxes || {}).filter(isBox),
  };
}

/** Whether the build is there (and draws this mode and ink). */
export function overtureBuildingsReady(status, mode = 'count', ink = 'light') {
  return Boolean(
    status?.configured &&
    status.boxes?.length &&
    OVERTURE_BUILDING_MODES.includes(mode) &&
    OVERTURE_BUILDING_INKS.includes(ink),
  );
}

/** Whether a point (°) is in one of the build's regions. */
export function inOvertureBuildings(status, lat, lon) {
  return Boolean(
    status?.boxes?.some(
      ([west, south, east, north]) =>
        lat >= south && lat <= north && lon >= west && lon <= east,
    ),
  );
}

/**
 * Options for `new Cesium.UrlTemplateImageryProvider(...)`, or null when
 * the build cannot draw the mode. `boxes` are the build's regions: the
 * layer drapes it only where one meets the view.
 */
export function overtureBuildingsImageryOptions(status, mode, ink) {
  if (!overtureBuildingsReady(status, mode, ink)) return null;
  return {
    url: `${OVERTURE_BUILDINGS_ENDPOINT}/tile/${mode}/${ink}/{z}/{x}/{y}?v=${status.version}`,
    maximumLevel: status.maxZoom,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: status.attribution,
    boxes: status.boxes,
  };
}

/**
 * The status, shared and kept STATUS_TTL_MS; a failed request reads as not
 * built (the row then says Open Buildings has no data outside its cells).
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createOvertureBuildingsSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
} = {}) {
  let held = null;
  let inflight = null;

  async function load() {
    try {
      const response = await fetchImpl('/api/overture/layers', {
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({}));
      return {
        ...toOvertureBuildingsStatus(response.ok ? body : {}),
        at: now(),
      };
    } catch {
      return { ...toOvertureBuildingsStatus({}), at: now() };
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
