// Personal fork: the Countries basemap's geometry, decoded from the bundled
// Natural Earth packs (src/data/local_data/natural_earth/README.md gives the
// encoding: integer rings in units of 10^-d degrees, the first vertex
// absolute, each later one a delta). Pure: no Cesium, node-testable.

/**
 * Decode one packed ring to an open ring of [lon, lat].
 * @param {number[]} encoded
 * @param {number} decimals
 * @returns {Array<[number, number]>}
 */
export function decodeRing(encoded, decimals) {
  const factor = 10 ** decimals;
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    ring.push([x / factor, y / factor]);
  }
  return ring;
}

function ringBox(ring, box) {
  for (const [lon, lat] of ring) {
    if (lon < box.west) box.west = lon;
    if (lon > box.east) box.east = lon;
    if (lat < box.south) box.south = lat;
    if (lat > box.north) box.north = lat;
  }
  return box;
}

const emptyBox = () => ({
  west: Infinity,
  south: Infinity,
  east: -Infinity,
  north: -Infinity,
});

/**
 * Decode a pack into drawable features.
 * @param {{meta?: {decimals?: number}, features?: Array<object>}} pack
 * @returns {Array<{id: string, name: string, iso2: string, country: string,
 *   polygons: Array<{outer: Array<[number, number]>, holes: Array<Array<[number, number]>>, box: object}>,
 *   box: {west: number, south: number, east: number, north: number}}>}
 */
export function decodePack(pack) {
  const decimals = pack?.meta?.decimals ?? 3;
  const features = [];
  for (const feature of pack?.features || []) {
    const d = feature.d ?? decimals;
    const polygons = (feature.polygons || []).map((parts) => {
      const [outer, ...holes] = parts.map((ring) => decodeRing(ring, d));
      return { outer, holes, box: ringBox(outer, emptyBox()) };
    });
    if (!polygons.length) continue;
    const box = emptyBox();
    for (const polygon of polygons) {
      box.west = Math.min(box.west, polygon.box.west);
      box.east = Math.max(box.east, polygon.box.east);
      box.south = Math.min(box.south, polygon.box.south);
      box.north = Math.max(box.north, polygon.box.north);
    }
    const iso2 = String(feature.iso2 || '').toUpperCase();
    features.push({
      id: feature.iso || (iso2 && iso2 !== '-99' ? iso2 : feature.name),
      name: feature.name,
      iso2: iso2 === '-99' ? '' : iso2,
      country: feature.country || feature.name,
      polygons,
      box,
    });
  }
  return features;
}

/** Even-odd ray cast; ring is open or closed [[lon, lat], …]. */
export function pointInRing(ring, lon, lat) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

const inBox = (box, lon, lat) =>
  lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;

/** Whether a decoded feature contains the point (holes excluded). */
export function featureContains(feature, lon, lat) {
  if (!inBox(feature.box, lon, lat)) return false;
  for (const polygon of feature.polygons) {
    if (!inBox(polygon.box, lon, lat)) continue;
    if (!pointInRing(polygon.outer, lon, lat)) continue;
    if (polygon.holes.some((hole) => pointInRing(hole, lon, lat))) continue;
    return true;
  }
  return false;
}

/**
 * The feature under a point, or null at sea. Features are searched in
 * order; a pack lists each country once, so the first hit is the answer.
 */
export function featureAt(features, lon, lat) {
  for (const feature of features)
    if (featureContains(feature, lon, lat)) return feature;
  return null;
}

/** Whether two lon/lat boxes overlap (boxes never span the antimeridian). */
export function boxesOverlap(a, b) {
  return (
    a.west <= b.east &&
    a.east >= b.west &&
    a.south <= b.north &&
    a.north >= b.south
  );
}

/**
 * Features whose box touches the rectangle, in pack order. A rectangle that
 * crosses the antimeridian (west > east) is tested as its two halves.
 * @param {Array<object>} features
 * @param {{west: number, south: number, east: number, north: number}} rect
 */
export function featuresInRectangle(features, rect) {
  const halves =
    rect.west > rect.east
      ? [
          { ...rect, east: 180 },
          { ...rect, west: -180 },
        ]
      : [rect];
  return features.filter((feature) =>
    halves.some((half) => boxesOverlap(feature.box, half)),
  );
}

/**
 * Every polygon of the features that touches the rectangle, flattened, with
 * the feature it belongs to. The unit of drawing: one fill and one outline
 * per polygon part.
 */
export function partsInRectangle(features, rect) {
  const parts = [];
  for (const feature of featuresInRectangle(features, rect))
    for (const polygon of feature.polygons)
      if (featuresInRectangle([{ ...feature, box: polygon.box }], rect).length)
        parts.push({ feature, polygon });
  return parts;
}
