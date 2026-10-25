/**
 * Personal fork: Overture's boundary lines for the Administrative
 * boundaries layer, from the local server's /api/boundaries/countries
 * (server/providers/overtureBoundaries.js, built by
 * `npm run overture:boundaries`). While the build is there, COUNTRIES (and
 * AUTO from orbit) drape `overtureBoundariesImageryOptions` in place of
 * Earth Engine's LSIB 2017 tiles; without it COUNTRIES keeps LSIB. A build
 * with region and county lines has the `regions` and `districts` sets
 * too: REGIONS and DISTRICTS drape them below their heights where the
 * view's cell has lines of the level (`overtureBoundariesCover`), FAO
 * GAUL elsewhere. Nothing here imports Cesium.
 */
import {
  BOUNDARY_INKS,
  BOUNDARY_SETS,
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

const versionsOf = (raw) =>
  Object.fromEntries(
    Object.entries(raw || {}).filter(
      ([ink, hash]) =>
        INKS.includes(ink) && /^[0-9a-f]{12}$/.test(String(hash)),
    ),
  );

/** The region and district sets of the answer: versions and covered cells. */
function setsOf(body) {
  const out = {};
  for (const set of ['regions', 'districts']) {
    const raw = body?.sets?.[set];
    if (!raw) continue;
    const cells = Array.isArray(raw.cells)
      ? raw.cells.filter((key) => Number.isSafeInteger(key) && key >= 0)
      : [];
    out[set] = { versions: versionsOf(raw.versions), cells: new Set(cells) };
  }
  return out;
}

/** The server's /layers answer, checked on the way in. */
export function toOvertureBoundariesStatus(body) {
  const gridZoom = body?.coverage?.gridZoom;
  return {
    configured: body?.configured === true,
    message: body?.message ? text(body.message) : '',
    attribution: text(body?.attribution, 300),
    builtAt: body?.builtAt ? text(body.builtAt, 40) : null,
    minZoom: Number.isInteger(body?.minZoom) ? body.minZoom : 0,
    maxZoom: Number.isInteger(body?.maxZoom) ? Math.min(18, body.maxZoom) : 14,
    versions: versionsOf(body?.versions),
    sets: setsOf(body),
    coverageZoom:
      Number.isInteger(gridZoom) && gridZoom >= 0 && gridZoom <= 12
        ? gridZoom
        : null,
  };
}

/** A set's tile versions: the country lines', or a region or district set's. */
const setVersions = (status, set) =>
  set === 'countries' ? status?.versions : status?.sets?.[set]?.versions;

/** Whether the build is there and has tiles of `set` in `ink`. */
export function overtureBoundariesReady(
  status,
  ink = 'light',
  set = 'countries',
) {
  return Boolean(
    status?.configured &&
    INKS.includes(ink) &&
    Object.hasOwn(BOUNDARY_SETS, set) &&
    setVersions(status, set)?.[ink],
  );
}

/** A cell's key, as the build writes it (server/providers/riversV2/tileMath.js cellKey). */
const cellKeyOf = (cx, cy, zoom) => cy * 2 ** zoom + cx;

/** The key of the cell of `zoom` (Web Mercator) holding a point, as the build's. */
export function coverageCellKey(lat, lon, zoom) {
  const n = 2 ** zoom;
  const clampLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const sin = Math.sin((clampLat * Math.PI) / 180);
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n),
    ),
  );
  return { x, y, n };
}

/**
 * Whether Overture has the set's own level (region or county lines) where
 * the view looks: in the cell under it or one of the eight around it (a
 * coast or a small country's view may centre on a cell its lines miss).
 * The country lines are everywhere.
 */
export function overtureBoundariesCover(status, set, lat, lon) {
  if (set === 'countries') return true;
  const cells = status?.sets?.[set]?.cells;
  const zoom = status?.coverageZoom;
  if (!cells?.size || zoom === null || zoom === undefined) return false;
  const { x, y, n } = coverageCellKey(lat, lon, zoom);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const cx = (x + dx + n) % n;
      const cy = y + dy;
      if (cy < 0 || cy >= n) continue;
      if (cells.has(cellKeyOf(cx, cy, zoom))) return true;
    }
  return false;
}

/**
 * Options for `new Cesium.UrlTemplateImageryProvider(...)` of a set in an
 * ink, or null when the build is not ready for it. The version (the
 * server's hash of the style and the build) only busts the browser's
 * cache.
 */
export function overtureBoundariesImageryOptions(
  status,
  ink,
  set = 'countries',
) {
  if (!overtureBoundariesReady(status, ink, set)) return null;
  const path = set === 'countries' ? ink : `${set}/${ink}`;
  return {
    url: `${OVERTURE_BOUNDARIES_ENDPOINT}/tile/${path}/{z}/{x}/{y}?v=${setVersions(status, set)[ink]}`,
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
