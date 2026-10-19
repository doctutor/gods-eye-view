// Personal fork: the "click a river reach" contract shared by the server
// (server/providers/riverReach.js) and the client
// (src/layers/rivers/reachHighlight.js). Not part of upstream God's Eye View.

/**
 * Every source of river topology answers in this shape, so the client draws
 * any of them: the HydroRIVERS v1 reaches Earth Engine holds today, and a
 * self-hosted HydroSHEDS v2 network for the Americas later
 * (docs/PERSONAL-FORK.md, "Rivers: click a reach").
 *
 *   {
 *     schema: 'river-reach/1',
 *     source: {id, name, attribution},
 *     query?: {lat, lon, heightM, toleranceM, maxOrder},   // a click only
 *     reach: {
 *       id,                       // the source's reach id (v1: NOID)
 *       distanceM,                // click to reach, when clicked
 *       properties: {RIV_ORD, DIS_AV_CMS, LENGTH_KM, UPLAND_SKM, CSI,
 *                    CSI_FF2, CSI_D, BB_ID, BB_NAME, BB_OCEAN, BAS_NAME,
 *                    COUNTRY, NDOID},
 *       geometry: {type: 'LineString', coordinates: [[lon, lat], …]},
 *     },
 *     downstream: {
 *       complete,                 // false when the trace stopped early
 *       terminal: 'ocean' | 'inland' | 'unknown',
 *       reaches, lengthKm,        // below the clicked reach
 *       distanceToMouthKm,        // from the click (else the reach's top)
 *       mouth: [lon, lat] | null,
 *       segments: [{backboneId, name, order, lengthKm, coordinates}],
 *     },
 *     upstream: null | {          // see the upstream link
 *       reaches, lengthKm, maxOrder, levels, truncated,
 *       lines: [{backboneId, name, order, coordinates}],
 *     },
 *     links: {self, upstream},    // same-site paths for this reach
 *     cached, timing: {ms, requests},
 *   }
 *
 * Coordinates run with the flow (source to mouth) and are rounded to 1e-5°.
 * A segment or line is one backbone river (a contiguous flow path).
 */
export const RIVER_REACH_SCHEMA = 'river-reach/1';
export const RIVER_REACH_ROUTE = '/api/rivers/reach';

/** Camera heights the tolerance and size rules accept. */
export const MAX_HEIGHT_M = 50_000_000;
export const DEFAULT_HEIGHT_M = 10_000;
/** The click tolerance: about a dozen screen pixels of ground. */
export const TOLERANCE_PER_HEIGHT = 0.014;
export const MIN_TOLERANCE_M = 100;
export const MAX_TOLERANCE_M = 50_000;

/**
 * How far from the click a reach may be, growing with the camera's height:
 * a 60° view across ~1,000 pixels sees about height/870 metres per pixel,
 * so 0.014 × height is about twelve pixels. Never under 100 m (a street-level
 * click still finds the channel) nor over 50 km.
 * @param {number} heightM
 * @returns {number} metres
 */
export function toleranceForHeight(heightM) {
  const height = Number.isFinite(heightM) ? Math.max(0, heightM) : 0;
  return Math.round(
    Math.min(
      MAX_TOLERANCE_M,
      Math.max(MIN_TOLERANCE_M, height * TOLERANCE_PER_HEIGHT),
    ),
  );
}

/** Camera height (m) up to which a click picks rivers of each RIV_ORD and larger. */
export const ORDER_HEIGHTS = Object.freeze([
  [20_000, 10],
  [80_000, 8],
  [250_000, 7],
  [800_000, 6],
  [2_500_000, 5],
  [8_000_000, 4],
]);

/**
 * The smallest river (largest RIV_ORD) a click at this height picks, so a
 * click on a big river seen from far away is not taken by a creek beside it.
 * RIV_ORD is HydroRIVERS' discharge order: 1 is over 100,000 m³/s, each step
 * ten times less, 10 under 0.001 m³/s. A layer that draws only some orders
 * at a height passes its own maxOrder instead (parseReachQuery).
 * @param {number} heightM
 * @returns {number}
 */
export function maxOrderForHeight(heightM) {
  const height = Number.isFinite(heightM) ? heightM : 0;
  for (const [limit, order] of ORDER_HEIGHTS) if (height <= limit) return order;
  return 3;
}

/** The upstream network: reaches up to this many orders smaller than the clicked one. */
export const UPSTREAM_ORDER_SPAN = 2;
/** At most this many upstream reaches, the largest kept. */
export const UPSTREAM_REACH_CAP = 2500;
/** Tributary levels followed upstream (a tributary of a tributary is level 2). */
export const UPSTREAM_LEVELS = 4;
/** Backbone rivers followed downstream before the trace gives up. */
export const DOWNSTREAM_HOPS = 16;

const numberParam = (params, name) => {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : NaN;
};

/**
 * A click's query (?lat=&lon=&heightM=&maxOrder=&upstream=), checked.
 * `maxOrder` (1–10) replaces the height's own (maxOrderForHeight).
 * @param {URLSearchParams} params
 * @returns {{lat: number, lon: number, heightM: number, maxOrder: number,
 *   upstream: boolean} | {error: string}}
 */
export function parseReachQuery(params) {
  const lat = numberParam(params, 'lat');
  const lon = numberParam(params, 'lon');
  const height = numberParam(params, 'heightM');
  if (lat === undefined || lon === undefined)
    return { error: 'lat and lon are required' };
  if (!(lat >= -90 && lat <= 90)) return { error: 'lat must be -90 to 90' };
  if (!(lon >= -180 && lon <= 180)) return { error: 'lon must be -180 to 180' };
  if (height !== undefined && !(height >= 0 && height <= MAX_HEIGHT_M))
    return { error: `heightM must be 0 to ${MAX_HEIGHT_M}` };
  const order = numberParam(params, 'maxOrder');
  if (
    order !== undefined &&
    !(Number.isInteger(order) && order >= 1 && order <= 10)
  )
    return { error: 'maxOrder must be a whole number 1 to 10' };
  const upstream = params.get('upstream');
  if (upstream !== null && !['0', '1', 'true', 'false'].includes(upstream))
    return { error: 'upstream must be 0 or 1' };
  const heightM = height ?? DEFAULT_HEIGHT_M;
  return {
    lat,
    lon,
    heightM,
    maxOrder: order ?? maxOrderForHeight(heightM),
    upstream: upstream === '1' || upstream === 'true',
  };
}

/** A reach id as the routes take it: a positive integer. */
export function parseReachId(raw) {
  const text = String(raw ?? '');
  if (!/^[1-9]\d{0,11}$/.test(text)) return null;
  return Number(text);
}

/** The discharge bands of RIV_ORD, in m³/s (upper bound exclusive). */
export const RIVER_ORDER_BANDS = Object.freeze({
  1: [100_000, Infinity],
  2: [10_000, 100_000],
  3: [1_000, 10_000],
  4: [100, 1_000],
  5: [10, 100],
  6: [1, 10],
  7: [0.1, 1],
  8: [0.01, 0.1],
  9: [0.001, 0.01],
  10: [0, 0.001],
});
