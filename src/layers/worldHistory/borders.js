/**
 * Personal fork: the World history layer's PRIVATE Cottereau borders
 * overlay, the client side. His drawn borders, extracted from his video
 * for personal use only, come from /api/cottereau-borders
 * (server/providers/cottereauBorders.js), which exists only when the
 * server was started with COTTEREAU_BORDERS_DIR. Without it the overlay is
 * absent: no control, nothing in the share link.
 *
 * - status(): whether the route answers (a JSON status, not the dev
 *   server's page for an unknown path).
 * - year(y): the sample shown in year y (the latest at or before it), its
 *   polygons decoded, or null before the first.
 * - The shapes for each mode, the pairs the differences view paints, what
 *   is under a click, and the IoU a Cliopatria polity has with his.
 */
import {
  decodePolygons,
  polygonsBox,
  polygonsContain,
} from '../../data/worldHistory.js';

export const COTTEREAU_BORDERS_ROUTE = '/api/cottereau-borders';
/** Samples kept at most. */
const MAX_KEPT = 24;
/** The light ink of the outlines, over a dark halo: they read on either plate. */
export const BORDERS_INK = Object.freeze([255, 255, 255]);
export const BORDERS_HALO = Object.freeze([20, 20, 20]);
/** The fills' alpha (before the overlay's opacity). */
export const BORDERS_FILL_ALPHA = 0.55;
/** The differences view: only Cottereau (orange), only Cliopatria (blue). */
export const COTTEREAU_ONLY = Object.freeze([255, 140, 0]);
export const CLIOPATRIA_ONLY = Object.freeze([0, 114, 255]);
export const DIFFERENCE_ALPHA = 0.7;

/** '#rrggbb' as [r, g, b] (grey when it is not one). */
export function hexColour(text) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(text || ''));
  if (!match) return [128, 128, 128];
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Twice a ring's signed area (lon, lat pairs), and its centroid. */
function ringCentroid(ring) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    area += cross;
    cx += (ring[j * 2] + ring[i * 2]) * cross;
    cy += (ring[j * 2 + 1] + ring[i * 2 + 1]) * cross;
  }
  return area
    ? { area: Math.abs(area), at: [cx / (3 * area), cy / (3 * area)] }
    : { area: 0, at: null };
}

/**
 * Where a polity's name goes: its largest part's centroid, or the middle
 * of that part's box when the centroid falls outside it.
 */
export function labelPoint(polygons) {
  let best = null;
  for (const rings of polygons) {
    if (!rings[0]) continue;
    const c = ringCentroid(rings[0]);
    if (!best || c.area > best.area) best = { ...c, polygon: rings };
  }
  if (!best) return null;
  if (best.at && polygonsContain([best.polygon], best.at[0], best.at[1]))
    return best.at;
  const [w, s, e, n] = polygonsBox([best.polygon]);
  return [(w + e) / 2, (s + n) / 2];
}

/** A served region (polity or unlabelled) with its polygons decoded. */
function decodeRegion(region, unlabelled) {
  const polygons = decodePolygons(region.polygons);
  return {
    ...region,
    unlabelled,
    flags: unlabelled ? ['unlabelled'] : region.flags || [],
    polygons,
    box: polygonsBox(polygons),
    at: labelPoint(polygons),
  };
}

/** A served sample: its polities and unlabelled regions, decoded. */
export function decodeSample(body) {
  return {
    index: body.index,
    year: body.year,
    polities: (body.polygons || []).map((p) => decodeRegion(p, false)),
    unlabelled: (body.unlabelled || []).map((u) => decodeRegion(u, true)),
  };
}

/**
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createCottereauBordersSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const byYear = new Map();
  const byIndex = new Map();
  const keep = (map, key, value) => {
    map.set(key, value);
    while (map.size > MAX_KEPT) map.delete(map.keys().next().value);
  };
  return {
    /**
     * {available, built, years}: available when the route answers its own
     * JSON (an unknown path gets the dev server's page, or nothing).
     */
    async status() {
      try {
        const response = await fetchImpl(`${COTTEREAU_BORDERS_ROUTE}/status`);
        const type = String(response.headers?.get?.('content-type') || '');
        if (!response.ok || !type.includes('json')) return { available: false };
        const body = await response.json();
        if (typeof body?.built !== 'boolean') return { available: false };
        return {
          available: true,
          built: body.built,
          years: body.years || null,
        };
      } catch {
        return { available: false };
      }
    },

    /** The sample shown in `year`, decoded; null before the first. */
    year(year) {
      if (byYear.has(year)) return byYear.get(year);
      const promise = (async () => {
        const response = await fetchImpl(
          `${COTTEREAU_BORDERS_ROUTE}/year/${year}`,
        );
        if (response.status === 404) return null;
        if (!response.ok) {
          const failure = new Error(`HTTP ${response.status}`);
          failure.status = response.status;
          throw failure;
        }
        const body = await response.json();
        const known = byIndex.get(body.index);
        if (known) return known;
        const sample = decodeSample(body);
        keep(byIndex, sample.index, sample);
        return sample;
      })().catch((error) => {
        byYear.delete(year);
        throw error;
      });
      keep(byYear, year, promise);
      return promise;
    },
  };
}

/** Every region of a sample, his polities first. */
export const sampleRegions = (sample) =>
  sample ? [...sample.polities, ...sample.unlabelled] : [];

/**
 * The shapes the outlines and fills modes paint: each region outlined in
 * the light ink over its halo; filled, in fills mode, with its own colour.
 */
export function bordersShapes(sample, mode) {
  const fills = mode === 'fills';
  return sampleRegions(sample).map((region) => ({
    polygons: region.polygons,
    box: region.box,
    fill: hexColour(region.colour),
    fillAlpha: fills ? BORDERS_FILL_ALPHA : 0,
    halo: { color: BORDERS_HALO, alpha: 0.55, width: fills ? 2 : 3 },
    stroke: BORDERS_INK,
    strokeAlpha: 0.95,
    strokeWidth: fills ? 0.75 : 1.25,
  }));
}

/**
 * The differences view's pairs: for each Cliopatria polity Cottereau's
 * polities are matched to (several of his may share one), his polygons
 * against Cliopatria's that year.
 * @param {object} sample decodeSample's
 * @param {object[]} cliopatria the year's decoded Cliopatria records
 */
export function differencePairs(sample, cliopatria) {
  const his = new Map();
  for (const polity of sample?.polities || []) {
    if (!polity.cliopatria) continue;
    const list = his.get(polity.cliopatria) || [];
    list.push(...polity.polygons);
    his.set(polity.cliopatria, list);
  }
  const theirs = new Map();
  for (const record of cliopatria || []) {
    if (!his.has(record.name)) continue;
    const list = theirs.get(record.name) || [];
    list.push(...record.polygons);
    theirs.set(record.name, list);
  }
  const pairs = [];
  for (const [name, b] of theirs) {
    const a = his.get(name);
    const ba = polygonsBox(a);
    const bb = polygonsBox(b);
    pairs.push({
      name,
      a,
      b,
      box: [
        Math.min(ba[0], bb[0]),
        Math.min(ba[1], bb[1]),
        Math.max(ba[2], bb[2]),
        Math.max(ba[3], bb[3]),
      ],
    });
  }
  return pairs;
}

/** The region under a point: the smallest holding it, or null. */
export function regionAt(sample, lon, lat) {
  const hits = sampleRegions(sample).filter(
    (region) =>
      region.box[0] <= lon &&
      lon <= region.box[2] &&
      region.box[1] <= lat &&
      lat <= region.box[3] &&
      polygonsContain(region.polygons, lon, lat),
  );
  hits.sort((a, b) => (a.areaKm2 || 0) - (b.areaKm2 || 0));
  return hits[0] || null;
}

/** Cottereau's polities matched to a Cliopatria name, with their IoU. */
export const matchesFor = (sample, name) =>
  (sample?.polities || [])
    .filter((p) => p.cliopatria === name && Number.isFinite(p.iou))
    .map((p) => ({ label: p.label, iou: p.iou }));
