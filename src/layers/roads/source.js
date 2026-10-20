import {
  OVERTURE_ROADS_ENDPOINT,
  OVERTURE_ROADS_MAX_ZOOM,
  ROAD_INKS,
  ROAD_MODES,
} from '../../data/overtureRoads.js';

/**
 * Personal fork: the Roads layer's server (/api/roads, server/providers/
 * overtureRoads.js, built by `npm run overture:build -- --roads`): its
 * status, the tiles' URL, the road under a click, and Street assets' bike
 * lanes. Nothing here imports Cesium.
 */

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

/** /api/roads/layers, checked on the way in. */
export function toRoadsStatus(body) {
  const ready =
    body?.configured === true &&
    /^[0-9a-f]{12}$/.test(String(body?.version || ''));
  return {
    configured: ready,
    version: ready ? body.version : '',
    message: body?.message ? text(body.message, 300) : '',
    attribution: text(body?.attribution),
    segments: Number.isSafeInteger(body?.segments) ? body.segments : 0,
    regions: Array.isArray(body?.regions)
      ? body.regions.map((r) => text(r, 40))
      : [],
    maxZoom: Number.isInteger(body?.maxZoom)
      ? Math.min(OVERTURE_ROADS_MAX_ZOOM, body.maxZoom)
      : OVERTURE_ROADS_MAX_ZOOM,
    boxes: Object.values(body?.regionBoxes || {}).filter(isBox),
  };
}

/** Options for `new Cesium.UrlTemplateImageryProvider(...)` (and the build's boxes), or null. */
export function roadsImageryOptions(status, mode, ink) {
  if (
    !status?.configured ||
    !status.boxes?.length ||
    !ROAD_MODES.includes(mode) ||
    !ROAD_INKS.includes(ink)
  )
    return null;
  return {
    url: `${OVERTURE_ROADS_ENDPOINT}/tile/${mode}/${ink}/{z}/{x}/{y}?v=${status.version}`,
    maximumLevel: status.maxZoom,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    boxes: status.boxes,
  };
}

/** A road from /api/roads/nearest, checked; or null. */
export function toRoadSegment(body) {
  const s = body?.segment;
  if (!s || typeof s !== 'object') return null;
  const line = Array.isArray(s.line)
    ? s.line
        .filter(
          (p) =>
            Array.isArray(p) &&
            p.length === 2 &&
            p.every(Number.isFinite) &&
            Math.abs(p[0]) <= 180 &&
            Math.abs(p[1]) <= 90,
        )
        .slice(0, 5000)
    : [];
  if (line.length < 2) return null;
  const speed = Number.isInteger(s.speed) && s.speed > 0 ? s.speed : 0;
  return {
    name: text(s.name, 200),
    class: text(s.class, 40),
    subclass: text(s.subclass, 40),
    speed,
    speedUnit: speed ? (s.speedUnit === 'mph' ? 'mph' : 'km/h') : '',
    surface: text(s.surface, 40),
    bridge: s.bridge === true,
    tunnel: s.tunnel === true,
    link: s.link === true,
    construction: s.construction === true,
    bicycle: ['designated', 'allowed', 'denied'].includes(s.bicycle)
      ? s.bicycle
      : '',
    source: text(s.source, 40) || 'OpenStreetMap',
    distanceM: Number.isFinite(s.distanceM) ? s.distanceM : null,
    line,
  };
}

export class RoadsError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'RoadsError';
    this.status = status;
  }
}

/**
 * @param {{fetchImpl?: typeof fetch, now?: () => number, endpoint?: string}} [options]
 */
export function createRoadsSource({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  endpoint = OVERTURE_ROADS_ENDPOINT,
} = {}) {
  let held = null;
  let heldAt = -Infinity;
  let asking = null;
  let clickController = null;

  async function getJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new RoadsError(
        text(body?.error, 300) || `HTTP ${response.status}`,
        response.status,
      );
    }
    return response.json();
  }

  return {
    /** The build's status (kept STATUS_TTL_MS). A failure reads as not built. */
    async status({ refresh = false } = {}) {
      if (!refresh && held && now() - heldAt < STATUS_TTL_MS) return held;
      asking ||= (async () => {
        try {
          held = toRoadsStatus(await getJson(`${endpoint}/layers`));
        } catch (error) {
          held = {
            ...toRoadsStatus(null),
            message: text(error?.message, 300),
            failed: true,
          };
        }
        heldAt = now();
        return held;
      })().finally(() => {
        asking = null;
      });
      return asking;
    },
    /** The last status, without asking. */
    last: () => held,

    /** The road a click meant, or null; a newer click aborts an older one. */
    async nearest({ lon, lat, zoom }) {
      clickController?.abort();
      clickController = new AbortController();
      const query = new URLSearchParams({
        lon: lon.toFixed(6),
        lat: lat.toFixed(6),
        zoom: String(Math.max(0, Math.round(zoom))),
      });
      return toRoadSegment(
        await getJson(`${endpoint}/nearest?${query}`, clickController.signal),
      );
    },

    /**
     * Street assets' bike lanes in a box: {lines, saturated}; with
     * `points`, each one's middle point: {points: [[lon, lat]], saturated}.
     */
    async bikeLines(
      { west, south, east, north },
      { points = false, signal } = {},
    ) {
      const query = new URLSearchParams(
        Object.entries({ west, south, east, north }).map(([k, v]) => [
          k,
          v.toFixed(5),
        ]),
      );
      if (points) query.set('points', '1');
      const body = await getJson(`${endpoint}/bike?${query}`, signal);
      if (points)
        return {
          points: Array.isArray(body?.points)
            ? body.points.filter(
                (p) =>
                  Array.isArray(p) &&
                  p.length === 2 &&
                  p.every(Number.isFinite),
              )
            : [],
          saturated: body?.saturated === true,
        };
      const lines = Array.isArray(body?.lines)
        ? body.lines
            .map((entry) => ({
              kind: entry?.kind === 'cycleway' ? 'cycleway' : 'shared-path',
              name: text(entry?.name, 200),
              surface: text(entry?.surface, 40),
              line: Array.isArray(entry?.line)
                ? entry.line.filter(
                    (p) =>
                      Array.isArray(p) &&
                      p.length === 2 &&
                      p.every(Number.isFinite),
                  )
                : [],
            }))
            .filter((entry) => entry.line.length >= 2)
        : [];
      return { lines, saturated: body?.saturated === true };
    },

    abort() {
      clickController?.abort();
      clickController = null;
    },
  };
}
