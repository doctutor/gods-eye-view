/**
 * Personal fork: the Blocks grid (docs/BLOCKS-PLAN.md, "Region and grid").
 *
 * A region is a local east-north-up tangent frame on the WGS84 ellipsoid at
 * an origin snapped to a global graticule of the block size, with `blockM`
 * fixed for the region. Columns are integer (i, j) east and north of the
 * origin (the origin is the south-west corner of column (0, 0)); levels are
 * integer y of `levelM` metres each, y = 0 the block whose base is mean sea
 * level. `levelM` is `blockM` at native cells (a cube); at coarse cells a
 * block is flatter than wide (docs/BLOCKS-PLAN.md milestone 5: 120 m cells
 * on 30 m levels). Chunks are
 * CHUNK_COLUMNS columns a side. Plain maths, no Cesium: the frame is built
 * from the WGS84 radii, and a point's local x, y are its east and north
 * components in that frame (an orthographic projection on the tangent
 * plane), so the renderer's eastNorthUpToFixedFrame(origin) puts it back.
 */

/** Columns a chunk side (16 is Minecraft's; 64 keeps primitives few at 1 m). */
export const CHUNK_COLUMNS = 64;
/**
 * How far from its origin a region is used before a new one is anchored:
 * the tangent plane's horizontal error at 20 km is a few centimetres.
 */
export const REGION_RADIUS_M = 20_000;
/**
 * From this block size up a region is curved (docs/BLOCKS-PLAN.md
 * milestone 5, decision 5): one tangent plane is wrong at continental
 * reach (the Earth falls 300 km under it 2,000 km out, and an orthographic
 * plane has no ground past the limb), so its columns are laid out by an
 * azimuthal equidistant map from the origin (x, y: metres along the
 * ground, east and north), and the mesher stands each column on the
 * ellipsoid. Below it the flat frame stays (0.2 m off at 50 km).
 */
export const CURVED_BLOCK_M = 1920;

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const RAD = Math.PI / 180;

/** Earth-centred, Earth-fixed metres of a place on the ellipsoid. */
function ecef(lonDeg, latDeg, heightM = 0) {
  const lon = lonDeg * RAD;
  const lat = latDeg * RAD;
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + heightM) * Math.cos(lat) * Math.cos(lon),
    (n + heightM) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - WGS84_E2) + heightM) * sinLat,
  ];
}

/**
 * Metres per degree of latitude and of longitude at a latitude (the
 * meridional and prime-vertical radii of curvature).
 */
export function metresPerDegree(latDeg) {
  const sinLat = Math.sin(latDeg * RAD);
  const w = 1 - WGS84_E2 * sinLat * sinLat;
  const meridional = (WGS84_A * (1 - WGS84_E2)) / w ** 1.5;
  const primeVertical = WGS84_A / Math.sqrt(w);
  return {
    lat: meridional * RAD,
    lon: primeVertical * Math.cos(latDeg * RAD) * RAD,
  };
}

/**
 * The origin snapped to the global graticule of a block size: latitude to a
 * multiple of blockM in degrees of latitude, longitude of blockM in degrees
 * of longitude, both measured at the whole degree of latitude nearest the
 * place, so every region anchored in that band shares one graticule.
 */
export function snapOrigin(lon, lat, blockM) {
  const band = Math.max(-89, Math.min(89, Math.round(lat)));
  const perDegree = metresPerDegree(band);
  const latStep = blockM / perDegree.lat;
  const lonStep = blockM / perDegree.lon;
  return {
    lon0: Math.round(lon / lonStep) * lonStep,
    lat0: Math.round(lat / latStep) * latStep,
  };
}

/** The chunk key, 'ci:cj'. */
export const chunkKey = (ci, cj) => `${ci}:${cj}`;

/** A chunk key's indices, or null. */
export function parseChunkKey(key) {
  const match = /^(-?\d+):(-?\d+)$/.exec(String(key));
  return match ? { ci: Number(match[1]), cj: Number(match[2]) } : null;
}

/** A column's index within its chunk's arrays (rows run north). */
export const columnIndex = (i, j) => j * CHUNK_COLUMNS + i;

/**
 * A region around a place. `lon0`, `lat0` are snapped to the graticule of
 * `blockM` (snapOrigin); the frame sits on the ellipsoid there. `levelM`,
 * the metres a level, is `blockM` unless given. `curved`, the azimuthal
 * map (CURVED_BLOCK_M and up unless given): the tileset build lays every
 * level of a country-wide box out on it, so a finer level nests in the
 * curved ones above it (scripts/blocks-tileset.mjs).
 */
export function createRegion({
  lon0,
  lat0,
  blockM,
  levelM = blockM,
  curved: curvedAsked = null,
}) {
  if (!(blockM > 0)) throw new RangeError('blockM must be positive');
  if (!(levelM > 0)) throw new RangeError('levelM must be positive');
  if (!Number.isFinite(lon0) || !Number.isFinite(lat0))
    throw new RangeError('lon0 and lat0 must be finite');
  const snapped = snapOrigin(lon0, lat0, blockM);
  const lon = snapped.lon0 * RAD;
  const lat = snapped.lat0 * RAD;
  const origin = ecef(snapped.lon0, snapped.lat0);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  ];
  const up = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const chunkM = CHUNK_COLUMNS * blockM;
  const curved =
    typeof curvedAsked === 'boolean' ? curvedAsked : blockM >= CURVED_BLOCK_M;
  // The curved regions' map is drawn on the sphere of the Gaussian mean
  // radius at the origin (its places then stood on the ellipsoid).
  const sinLat0 = Math.sin(lat);
  const w0 = 1 - WGS84_E2 * sinLat0 * sinLat0;
  const sphereR = Math.sqrt(
    ((WGS84_A * (1 - WGS84_E2)) / w0 ** 1.5) * (WGS84_A / Math.sqrt(w0)),
  );
  const wrapLon = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  /** The place `x` east and `y` north of the origin along the ground. */
  const aeqdToLonLat = (x, y) => {
    const d = Math.hypot(x, y);
    if (!(d > 0)) return { lon: snapped.lon0, lat: snapped.lat0 };
    const delta = Math.min(Math.PI, d / sphereR);
    const az = Math.atan2(x, y);
    const lat2 = Math.asin(
      Math.max(
        -1,
        Math.min(
          1,
          sinLat0 * Math.cos(delta) +
            Math.cos(lat) * Math.sin(delta) * Math.cos(az),
        ),
      ),
    );
    const lon2 =
      lon +
      Math.atan2(
        Math.sin(az) * Math.sin(delta) * Math.cos(lat),
        Math.cos(delta) - sinLat0 * Math.sin(lat2),
      );
    return { lon: wrapLon(lon2 / RAD), lat: lat2 / RAD };
  };
  /** A place's metres east and north of the origin along the ground. */
  const aeqdToLocal = (lonDeg, latDeg) => {
    const p2 = latDeg * RAD;
    const dLat = p2 - lat;
    const dLon = lonDeg * RAD - lon;
    // Haversine: exact near the origin, where acos is not.
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    const delta = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    const az = Math.atan2(
      Math.sin(dLon) * Math.cos(p2),
      Math.cos(lat) * Math.sin(p2) - sinLat0 * Math.cos(p2) * Math.cos(dLon),
    );
    const d = delta * sphereR;
    return { x: d * Math.sin(az), y: d * Math.cos(az) };
  };

  /** East, north (and up) metres of a place on the ellipsoid. */
  const enu = (lonDeg, latDeg) => {
    const p = ecef(lonDeg, latDeg);
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    return { x: dot(d, east), y: dot(d, north), z: dot(d, up) };
  };

  /**
   * The place on the ellipsoid whose east and north metres are x, y: the
   * line through the tangent-plane point along the frame's up meets it.
   */
  const ellipsoidUnder = (x, y) => {
    const p = [0, 1, 2].map((k) => origin[k] + x * east[k] + y * north[k]);
    // (X² + Y²)/a² + Z²/b² = 1 along p + t·up: a quadratic in t.
    const a2 = WGS84_A * WGS84_A;
    const b2 = WGS84_B * WGS84_B;
    const qa = (up[0] ** 2 + up[1] ** 2) / a2 + up[2] ** 2 / b2;
    const qb = 2 * ((p[0] * up[0] + p[1] * up[1]) / a2 + (p[2] * up[2]) / b2);
    const qc = (p[0] ** 2 + p[1] ** 2) / a2 + p[2] ** 2 / b2 - 1;
    const root = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc));
    // The intersection nearer the plane (the other is through the Earth).
    const t = (-qb + root) / (2 * qa);
    return { point: p.map((value, k) => value + t * up[k]), t };
  };

  const region = {
    lon0: snapped.lon0,
    lat0: snapped.lat0,
    blockM,
    levelM,
    /** Whether the columns stand on the ellipsoid (CURVED_BLOCK_M and up). */
    curved,
    /** The level a height above mean sea level lies in. */
    levelOf: (heightMslM) => Math.floor(heightMslM / levelM),
    /** East and north metres from the origin of a place. */
    toLocal(lonDeg, latDeg) {
      if (curved) return aeqdToLocal(lonDeg, latDeg);
      const { x, y } = enu(lonDeg, latDeg);
      return { x, y };
    },
    /** The place (degrees) at east and north metres from the origin. */
    toLonLat(x, y) {
      if (curved) return aeqdToLonLat(x, y);
      const { point } = ellipsoidUnder(x, y);
      const p = Math.hypot(point[0], point[1]);
      return {
        lon: Math.atan2(point[1], point[0]) / RAD,
        // On the ellipsoid, tan(lat) = Z / ((1 − e²)·p) exactly.
        lat: Math.atan2(point[2], (1 - WGS84_E2) * p) / RAD,
      };
    },
    /** The column holding east and north metres. */
    columnOf(x, y) {
      return { i: Math.floor(x / blockM), j: Math.floor(y / blockM) };
    },
    /** The chunk holding a column. */
    chunkOf(i, j) {
      return {
        ci: Math.floor(i / CHUNK_COLUMNS),
        cj: Math.floor(j / CHUNK_COLUMNS),
      };
    },
    /** A column's index within its chunk, 0 … CHUNK_COLUMNS − 1 each way. */
    localColumn(i, j) {
      return {
        li: i - Math.floor(i / CHUNK_COLUMNS) * CHUNK_COLUMNS,
        lj: j - Math.floor(j / CHUNK_COLUMNS) * CHUNK_COLUMNS,
      };
    },
    /**
     * A chunk's south-west corner in region metres; `z` is where the
     * ellipsoid lies below the tangent plane there (−d²/2R, about −18 m at
     * 15 km), for the renderer to drop the chunk onto the curve.
     */
    /**
     * Where the ellipsoid lies below the tangent plane at east and north
     * metres (flat regions): the drop a vertex there needs to stand on the
     * curve (mesh.js flatDrop).
     */
    dropAt(x, y) {
      return ellipsoidUnder(x, y).t;
    },
    chunkOrigin(ci, cj) {
      const x = ci * chunkM;
      const y = cj * chunkM;
      if (curved) {
        // How far the ground at the corner lies below the tangent plane.
        const at = aeqdToLonLat(x, y);
        return { x, y, z: region.localPoint(at.lon, at.lat, 0).z };
      }
      return { x, y, z: ellipsoidUnder(x, y).t };
    },
    /**
     * A place at an ellipsoidal height in the region's frame: metres along
     * its east, north and up axes from the origin on the ellipsoid (the
     * renderer's frame, before its datum offset).
     */
    localPoint(lonDeg, latDeg, heightM = 0) {
      const p = ecef(lonDeg, latDeg, heightM);
      const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
      return { x: dot(d, east), y: dot(d, north), z: dot(d, up) };
    },
    /** A place's own east, north and up, in the region's axes. */
    basisAt(lonDeg, latDeg) {
      const lo = lonDeg * RAD;
      const la = latDeg * RAD;
      const e = [-Math.sin(lo), Math.cos(lo), 0];
      const n = [
        -Math.sin(la) * Math.cos(lo),
        -Math.sin(la) * Math.sin(lo),
        Math.cos(la),
      ];
      const u = [
        Math.cos(la) * Math.cos(lo),
        Math.cos(la) * Math.sin(lo),
        Math.sin(la),
      ];
      const axes = (v) => [dot(v, east), dot(v, north), dot(v, up)];
      return { east: axes(e), north: axes(n), up: axes(u) };
    },
    /** A chunk's extent in degrees: the box around its four corners. */
    chunkBounds(ci, cj) {
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => region.toLonLat((ci + u) * chunkM, (cj + v) * chunkM));
      return {
        west: Math.min(...corners.map((c) => c.lon)),
        south: Math.min(...corners.map((c) => c.lat)),
        east: Math.max(...corners.map((c) => c.lon)),
        north: Math.max(...corners.map((c) => c.lat)),
      };
    },
    /** The place (degrees) at a column's centre, where it is sampled. */
    columnCentre(i, j) {
      return region.toLonLat((i + 0.5) * blockM, (j + 0.5) * blockM);
    },
    /** Whether a place is near enough the origin for this region. */
    within(lonDeg, latDeg, radiusM = REGION_RADIUS_M) {
      const { x, y } = region.toLocal(lonDeg, latDeg);
      return Math.hypot(x, y) <= radiusM;
    },
  };
  return region;
}

/** A height above mean sea level's level at `levelM` metres a level. */
export const levelOf = (heightMslM, levelM) => Math.floor(heightMslM / levelM);
