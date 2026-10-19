// Personal fork: the pure parts of the Street assets layer (index.js): the
// asset types, their height caps, the Overpass queries for a view and the
// answers as points and lines. No Cesium here.

/**
 * Level of detail, per type. These are dense (a city has tens of thousands
 * of street lamps), so each type has two heights:
 * - below `pinsBelowM`, its features for the view as pins (lines for bike
 *   lanes), at most `pinLimit`;
 * - from there up to `countsBelowM`, the same features fetched as bare
 *   points (`out skel` or `out center`: ids and coordinates, about 40 bytes
 *   each) at most `countLimit`, rolled up into H3 counts (src/layers/
 *   pointRollup/), so the layer still says where they are;
 * - above `countsBelowM`, nothing is asked for and the row says how low to
 *   go: a wider box would ask Overpass for a city's worth of features.
 * The query box is the ground a nadir view sees (half-side one camera
 * height), snapped outward to 0.05° so a small pan reuses the answer, and
 * well inside the proxy's 12° limit at every cap.
 */
const assetType = (key, fields) => Object.freeze({ key, ...fields });

export const ASSET_TYPES = Object.freeze([
  assetType('charging', {
    // Charging stations are mapped as nodes and as areas: centres for both.
    selectors: Object.freeze(['nwr["amenity"="charging_station"]']),
    geometry: 'point',
    color: '#00c2a8',
    pinsBelowM: 40_000,
    countsBelowM: 150_000,
    pinLimit: 1_500,
    countLimit: 8_000,
  }),
  assetType('bike', {
    // Separate cycleways and roads that carry a bike lane or track.
    selectors: Object.freeze([
      'way["highway"="cycleway"]',
      'way["cycleway"~"^(lane|track|shared_lane|share_busway|opposite_lane|opposite_track)$"]',
      'way["cycleway:both"~"^(lane|track)$"]',
      'way["cycleway:left"~"^(lane|track)$"]',
      'way["cycleway:right"~"^(lane|track)$"]',
    ]),
    geometry: 'line',
    color: null, // the ink
    pinsBelowM: 8_000,
    countsBelowM: 30_000,
    pinLimit: 2_500,
    countLimit: 10_000,
  }),
  assetType('hydrant', {
    selectors: Object.freeze(['node["emergency"="fire_hydrant"]']),
    geometry: 'point',
    color: '#ff3b30',
    pinsBelowM: 5_000,
    countsBelowM: 25_000,
    pinLimit: 2_000,
    countLimit: 12_000,
  }),
  assetType('lamp', {
    selectors: Object.freeze(['node["highway"="street_lamp"]']),
    geometry: 'point',
    color: '#ffd166',
    pinsBelowM: 3_000,
    countsBelowM: 15_000,
    pinLimit: 2_000,
    countLimit: 12_000,
  }),
  assetType('signals', {
    selectors: Object.freeze(['node["highway"="traffic_signals"]']),
    geometry: 'point',
    color: '#ff9f1c',
    // 2,000 signals (the limit) in Baltimore's 20 km box at 10 km: pins
    // below 5 km (live, 2026-10-19).
    pinsBelowM: 5_000,
    countsBelowM: 40_000,
    pinLimit: 2_000,
    countLimit: 12_000,
  }),
]);

export const ASSET_KEYS = Object.freeze(ASSET_TYPES.map((type) => type.key));

/** A type's record by key, else the first (charging stations). */
export function assetTypeOf(key) {
  return ASSET_TYPES.find((type) => type.key === key) || ASSET_TYPES[0];
}

/**
 * What a type draws at a camera height: 'pins' (its features), 'counts'
 * (H3 counts of them) or 'none' (above its cap).
 */
export function assetModeForHeight(type, heightM) {
  const height = Number(heightM);
  if (!Number.isFinite(height)) return 'none';
  if (height < type.pinsBelowM) return 'pins';
  if (height < type.countsBelowM) return 'counts';
  return 'none';
}

const EARTH_RADIUS_M = 6_371_000;
const SNAP = 0.05;
const snapDown = (value) =>
  Number((Math.floor(value / SNAP) * SNAP).toFixed(2));
const snapUp = (value) => Number((Math.ceil(value / SNAP) * SNAP).toFixed(2));

/** The box asked for around a view: half-side one camera height, at least 1 km, snapped outward. */
export function assetQueryBox(view) {
  const half = Math.max(1_000, Number(view.height));
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.05, Math.cos((view.lat * Math.PI) / 180));
  return {
    south: Math.max(-90, snapDown(view.lat - dLat)),
    west: Math.max(-180, snapDown(view.lon - dLon)),
    north: Math.min(90, snapUp(view.lat + dLat)),
    east: Math.min(180, snapUp(view.lon + dLon)),
  };
}

/**
 * The Overpass query for a type in a box: for pins, nodes with their tags
 * (or, for bike lanes, ways with their geometry); for counts, bare points.
 * @param {object} type An ASSET_TYPES record.
 * @param {{south: number, west: number, north: number, east: number}} box
 * @param {'pins' | 'counts'} mode
 */
export function buildAssetQuery(type, box, mode) {
  const bbox = [box.south, box.west, box.north, box.east].join(',');
  const union = type.selectors
    .map((selector) => `${selector}(${bbox});`)
    .join('');
  const limit = mode === 'pins' ? type.pinLimit : type.countLimit;
  let out;
  if (mode === 'counts') out = `out center qt ${limit};`;
  else if (type.geometry === 'line') out = `out geom qt ${limit};`;
  else out = `out center qt ${limit};`;
  // Points read as bare coordinates when counted (`skel`); nodes need no centre.
  if (mode === 'counts' && type.selectors.every((s) => s.startsWith('node')))
    out = `out skel qt ${limit};`;
  return `[out:json][timeout:25];(${union});${out}`;
}

/** An Overpass element as a point ({id, lat, lon, tags}), or null. */
export function assetPoint(element) {
  const lat = Number(element?.lat ?? element?.center?.lat);
  const lon = Number(element?.lon ?? element?.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: `${element.type}/${element.id}`,
    lat,
    lon,
    ...(element.tags ? { tags: element.tags } : {}),
  };
}

/** An Overpass way with geometry as a line ({id, coords: [lon, lat][]}), or null. */
export function assetLine(element) {
  const coords = (Array.isArray(element?.geometry) ? element.geometry : [])
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .map((p) => [p.lon, p.lat]);
  if (coords.length < 2) return null;
  return { id: `${element.type}/${element.id}`, coords };
}

/** An answer as the type's features: points, or lines for bike lanes as pins. */
export function assetFeatures(type, mode, elements) {
  const list = Array.isArray(elements) ? elements : [];
  const seen = new Set();
  const out = [];
  const make =
    mode === 'pins' && type.geometry === 'line' ? assetLine : assetPoint;
  for (const element of list) {
    const feature = make(element);
    if (!feature || seen.has(feature.id)) continue;
    seen.add(feature.id);
    out.push(feature);
  }
  return out;
}

/** Whether a box lies inside another. */
export function boxCovers(outer, inner) {
  return Boolean(
    outer &&
    inner &&
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east,
  );
}
