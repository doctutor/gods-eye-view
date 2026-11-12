// Personal fork: areas on the WGS84 ellipsoid for the treemap navigator's
// builds (scripts/treemap) and its outlines. Not part of upstream God's
// Eye View.
//
// An area is the authalic sphere's: latitude goes to the authalic latitude
// β, and a ring's area is R_a² · Σ Δλ · (sin β₁ + sin β₂) / 2, which is exact
// for edges along parallels and meridians and within a part in a million
// for the dense rings the Overture areas carry. The authalic sphere has the
// ellipsoid's total area, 510,065,622 km².

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const QP = 1 + ((1 - E2) / (2 * E)) * Math.log((1 + E) / (1 - E));
/** The authalic radius squared (m²). */
const RA2 = (A * A * QP) / 2;

/** The ellipsoid's surface (m²): 4π R_a². */
export const EARTH_AREA_M2 = 4 * Math.PI * RA2;

/** sin β, the authalic latitude's sine, of a geodetic latitude in radians. */
export function sinAuthalic(phi) {
  const s = Math.sin(phi);
  const q =
    (1 - E2) *
    (s / (1 - E2 * s * s) -
      (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
  return q / QP;
}

/** A Web Mercator y (0 at the north edge, 1 at the south) as latitude, radians. */
export const mercatorLatitude = (y) =>
  Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));

/**
 * The unsigned area (m²) of a ring of Web Mercator points, flat
 * [x, y, …] in world units × `scale` (x 0..1 west to east from −180°).
 * @param {ArrayLike<number>} ring
 * @param {number} [scale]
 */
export function mercatorRingArea(ring, scale = 1) {
  const n = ring.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  let px = ring[(n - 1) * 2] / scale;
  let pb = sinAuthalic(mercatorLatitude(ring[(n - 1) * 2 + 1] / scale));
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2] / scale;
    const b = sinAuthalic(mercatorLatitude(ring[i * 2 + 1] / scale));
    sum += (x - px) * (pb + b);
    px = x;
    pb = b;
  }
  // Δλ = 2π Δx; the trapezoid's half.
  return Math.abs(sum * Math.PI) * RA2;
}

/**
 * The area (m²) of polygons of Mercator rings: each polygon's first ring
 * less its holes.
 * @param {ArrayLike<number>[][]} polygons
 * @param {number} [scale]
 */
export function mercatorPolygonsArea(polygons, scale = 1) {
  let total = 0;
  for (const rings of polygons) {
    let area = 0;
    rings.forEach((ring, index) => {
      area += (index ? -1 : 1) * mercatorRingArea(ring, scale);
    });
    total += Math.max(0, area);
  }
  return total;
}

/**
 * The area (m²) of a ring of [lon, lat] degrees (closed or not), e.g. a
 * GeoJSON ring; unsigned.
 * @param {number[][]} ring
 */
export function lonLatRingArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  const rad = Math.PI / 180;
  let sum = 0;
  let [plon, plat] = ring[n - 1];
  let pb = sinAuthalic(plat * rad);
  for (const [lon, lat] of ring) {
    const b = sinAuthalic(lat * rad);
    let d = lon - plon;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    sum += d * rad * (pb + b);
    plon = lon;
    pb = b;
  }
  return (Math.abs(sum) / 2) * RA2;
}
