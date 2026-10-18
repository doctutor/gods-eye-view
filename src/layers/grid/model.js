import { formatDms } from '../../ui/dms.js';

/**
 * Personal fork: the Grid layer's lines, without Cesium. The spacing follows
 * the camera's height so that about 4 to 12 lines cross the view; only the
 * lines around the view are drawn (a window of three view widths, capped),
 * never the whole planet at a fine spacing; the equator, the prime
 * meridian, the tropics and the polar circles are their own kinds.
 */

/** Grid spacings, in degrees: 30°, 10°, 5°, 2°, 1°, 30', 10', 5', 1'. */
export const GRID_STEPS_DEG = Object.freeze([
  30,
  10,
  5,
  2,
  1,
  0.5,
  1 / 6,
  1 / 12,
  1 / 60,
]);
export const MIN_LINES = 4;
export const MAX_LINES = 12;
/** The most parallels, and the most meridians, in one window. */
export const MAX_LINES_PER_AXIS = 40;
/** The window is this many view half-widths each side of the view's centre. */
export const WINDOW_FACTOR = 3;
/** Parallels stop short of the poles; meridians meet no closer than this. */
export const MAX_LAT = 85;
const METRES_PER_DEG = 111_320;
/** Tropics and polar circles (mean obliquity, 2026). */
export const TROPIC_LAT = 23.4365;
export const POLAR_CIRCLE_LAT = 66.5635;

/**
 * Half the view's width in degrees of latitude: about the camera's height
 * (a 60° field of view sees ±0.58 h straight down, more when tilted), and
 * at least 2 km.
 */
export function viewHalfDegrees(heightM) {
  const h = Number.isFinite(heightM) ? Math.max(2_000, heightM) : 20_000_000;
  return h / METRES_PER_DEG;
}

/** The spacing for a view this many degrees across: 4–12 lines, nearest 7. */
export function stepForSpan(spanDeg) {
  let best = GRID_STEPS_DEG[0];
  let bestScore = Infinity;
  for (const step of GRID_STEPS_DEG) {
    const lines = spanDeg / step;
    const inRange = lines >= MIN_LINES && lines <= MAX_LINES;
    const score = (inRange ? 0 : 10) + Math.abs(Math.log(lines / 7));
    if (score < bestScore) {
      best = step;
      bestScore = score;
    }
  }
  return best;
}

export function stepForHeight(heightM) {
  return stepForSpan(2 * viewHalfDegrees(heightM));
}

/** A longitude in [-180, 180], with 180 kept as 180 (not -180). */
export function normalizeLon(lon) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : wrapped;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
/** A multiple of `step` as an exact value (1/60° steps drift in floating point). */
const snap = (value, step) => Math.round(value / step) * step;

/**
 * The window lines are made in: three view half-widths each side of the
 * view's centre, latitudes within ±85°, longitudes unwrapped from the
 * centre's (so they may pass ±180) and widened towards the poles, up to the
 * whole circle. Shared by the graticule and the MGRS grid.
 * @returns {{half: number, south: number, north: number, west: number,
 *   east: number, fullCircle: boolean}} `half`: the view's half-width in
 *   degrees of latitude.
 */
export function gridWindow({ lat, lon, heightM }) {
  const half = viewHalfDegrees(heightM);
  const halfLat = Math.min(180, WINDOW_FACTOR * half);
  const south = Math.max(-MAX_LAT, lat - halfLat);
  const north = Math.min(MAX_LAT, lat + halfLat);
  // Longitude degrees shrink towards the poles: the window widens to match,
  // up to the whole circle.
  const widest = Math.max(Math.abs(south), Math.abs(north), Math.abs(lat));
  const cos = Math.max(
    0.05,
    Math.cos((Math.min(widest, MAX_LAT) * Math.PI) / 180),
  );
  const halfLon = (WINDOW_FACTOR * half) / Math.max(cos, 0.05);
  const fullCircle = halfLon >= 180;
  return {
    half,
    south,
    north,
    west: fullCircle ? -180 : lon - halfLon,
    east: fullCircle ? 180 : lon + halfLon,
    fullCircle,
  };
}

/** The view's own half-width in degrees of longitude, at its centre. */
export function viewHalfLon({ lat, heightM }) {
  const cos = Math.max(
    0.05,
    Math.cos((Math.min(Math.abs(lat), MAX_LAT) * Math.PI) / 180),
  );
  return Math.min(180, viewHalfDegrees(heightM) / cos);
}

/**
 * The lines around a view.
 * @param {{lat: number, lon: number, heightM: number}} view
 * @returns {{latStep: number, lonStep: number,
 *   window: {south: number, north: number, west: number, east: number},
 *   parallels: Array<{lat: number, kind: string}>,
 *   meridians: Array<{lon: number, kind: string}>}} Longitudes in the
 *   window are unwrapped (they may pass ±180 across the antimeridian).
 */
export function gridLines({ lat, lon, heightM }) {
  const { half, south, north, west, east, fullCircle } = gridWindow({
    lat,
    lon,
    heightM,
  });
  const latStep = stepForSpan(2 * half);
  // Meridians crowd together near the poles: past the cap, a wider step.
  let lonStep = latStep;
  for (const step of [...GRID_STEPS_DEG].reverse())
    if (step >= latStep && (east - west) / step <= MAX_LINES_PER_AXIS) {
      lonStep = step;
      break;
    }
  if ((east - west) / lonStep > MAX_LINES_PER_AXIS) lonStep = GRID_STEPS_DEG[0];
  // Too many parallels for the window (never at these factors): a wider step.
  let parallelStep = latStep;
  while ((north - south) / parallelStep > MAX_LINES_PER_AXIS)
    parallelStep =
      GRID_STEPS_DEG[Math.max(0, GRID_STEPS_DEG.indexOf(parallelStep) - 1)];

  const parallels = [];
  for (
    let value = Math.ceil(south / parallelStep - 1e-9) * parallelStep;
    value <= north + 1e-9;
    value += parallelStep
  ) {
    const latValue = snap(value, parallelStep);
    parallels.push({
      lat: latValue,
      kind: near(latValue, 0) ? 'equator' : 'grid',
    });
  }
  for (const special of [TROPIC_LAT, -TROPIC_LAT])
    if (special > south && special < north)
      parallels.push({ lat: special, kind: 'tropic' });
  for (const special of [POLAR_CIRCLE_LAT, -POLAR_CIRCLE_LAT])
    if (special > south && special < north)
      parallels.push({ lat: special, kind: 'polar-circle' });

  const meridians = [];
  const lastLon = fullCircle ? east - lonStep / 2 : east + 1e-9;
  for (
    let value = Math.ceil(west / lonStep - 1e-9) * lonStep;
    value <= lastLon;
    value += lonStep
  ) {
    const lonValue = snap(value, lonStep);
    meridians.push({
      lon: lonValue,
      kind: near(normalizeLon(lonValue), 0) ? 'prime-meridian' : 'grid',
    });
  }
  parallels.sort((a, b) => a.lat - b.lat);
  return {
    latStep: parallelStep,
    lonStep,
    window: { south, north, west, east },
    parallels,
    meridians,
  };
}

/** What a step's labels show: whole degrees, or degrees and minutes. */
export function labelPrecision(step) {
  return step >= 1 ? 'degrees' : 'minutes';
}

/** A line's label in the HUD's notation: `38°N`, `76°30'W`, `180°`. */
export function labelText(value, axis, step) {
  if (axis === 'lon') {
    const lon = normalizeLon(value);
    if (near(Math.abs(lon), 180)) return '180°';
    if (near(lon, 0)) return '0°';
    return formatDms(lon, 'lon', {
      precision: labelPrecision(step),
      pad: false,
    });
  }
  if (near(value, 0)) return '0°';
  return formatDms(value, 'lat', {
    precision: labelPrecision(step),
    pad: false,
  });
}

/**
 * Where the labels go: each parallel's label near the view's west edge,
 * each meridian's near its south edge, for the lines inside the view.
 * @returns {Array<{text: string, lat: number, lon: number, axis: 'lat'|'lon', kind: string}>}
 */
export function labelPlacements(lines, { lat, lon, heightM }) {
  const half = viewHalfDegrees(heightM);
  const halfLon = viewHalfLon({ lat, heightM });
  const labelLon = lon - 0.8 * halfLon;
  const labelLat = Math.max(-MAX_LAT, lat - 0.8 * half);
  const out = [];
  for (const parallel of lines.parallels) {
    if (Math.abs(parallel.lat - lat) > half) continue;
    if (parallel.kind === 'tropic' || parallel.kind === 'polar-circle')
      continue;
    out.push({
      text: labelText(parallel.lat, 'lat', lines.latStep),
      lat: parallel.lat,
      lon: normalizeLon(labelLon),
      axis: 'lat',
      kind: parallel.kind,
    });
  }
  for (const meridian of lines.meridians) {
    if (Math.abs(meridian.lon - lon) > halfLon) continue;
    out.push({
      text: labelText(meridian.lon, 'lon', lines.lonStep),
      lat: labelLat,
      lon: normalizeLon(meridian.lon),
      axis: 'lon',
      kind: meridian.kind,
    });
  }
  return out;
}

/** Whether a view has left the one a line set was made for. */
export function gridViewMoved(made, now) {
  if (!made) return true;
  if (stepForHeight(made.heightM) !== stepForHeight(now.heightM)) return true;
  const half = viewHalfDegrees(made.heightM);
  const cos = Math.max(
    0.05,
    Math.cos((Math.min(Math.abs(made.lat), MAX_LAT) * Math.PI) / 180),
  );
  const dLon = Math.abs(normalizeLon(now.lon - made.lon)) * cos;
  // A third of the way to the window's edge: rebuilt before it shows.
  return Math.max(Math.abs(now.lat - made.lat), dLon) > half;
}

// --- Tissot's indicatrix --------------------------------------------------------

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * The point `distanceM` from a start along `azimuthDeg` on the WGS84
 * ellipsoid (Vincenty's direct formula), as {lat, lon}; the longitude is
 * unwrapped from the start's, so a circle across the antimeridian stays
 * continuous.
 */
export function geodesicDestination(lat, lon, azimuthDeg, distanceM) {
  const alpha1 = toRad(azimuthDeg);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - WGS84_F) * Math.tan(toRad(lat));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cosSqAlpha = 1 - sinAlpha * sinAlpha;
  const uSq =
    (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) /
    (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = distanceM / (WGS84_B * A);
  let cos2SigmaM;
  let sinSigma;
  let cosSigma;
  for (let i = 0; i < 100; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = distanceM / (WGS84_B * A) + deltaSigma;
    const settled = Math.abs(next - sigma) < 1e-12;
    sigma = next;
    if (settled) break;
  }
  cos2SigmaM = Math.cos(2 * sigma1 + sigma);
  sinSigma = Math.sin(sigma);
  cosSigma = Math.cos(sigma);
  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - WGS84_F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp),
  );
  const lambda = Math.atan2(
    sinSigma * sinAlpha1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1,
  );
  const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
  const L =
    lambda -
    (1 - C) *
      WGS84_F *
      sinAlpha *
      (sigma +
        C *
          sinSigma *
          (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return { lat: toDeg(lat2), lon: lon + toDeg(L) };
}

/** The points of a circle of real radius `radiusM` on the ellipsoid (closed: the first point repeats). */
export function geodesicCircle(lat, lon, radiusM, segments = 48) {
  const points = [];
  for (let i = 0; i <= segments; i++)
    points.push(
      geodesicDestination(lat, lon, (360 * (i % segments)) / segments, radiusM),
    );
  return points;
}

/** The most indicatrix circles drawn at once (the nearest the view first). */
export const MAX_CIRCLES = 150;
/** A circle's radius, as a share of the spacing (a third: they never touch). */
export const TISSOT_RADIUS_SHARE = 1 / 3;

/**
 * Tissot's indicatrix for a line set: one circle of the same real radius at
 * each graticule intersection in the window, nearest the view first, at
 * most MAX_CIRCLES. Equal circles on the ground: the view's own
 * foreshortening is what makes them look unequal.
 * @returns {{radiusM: number, circles: Array<{lat: number, lon: number}>}}
 */
export function tissotCircles(lines, { lat, lon }) {
  const step = Math.min(lines.latStep, lines.lonStep);
  const radiusM = step * METRES_PER_DEG * TISSOT_RADIUS_SHARE;
  const radiusDeg = radiusM / METRES_PER_DEG;
  const centres = [];
  for (const parallel of lines.parallels) {
    if (parallel.kind === 'tropic' || parallel.kind === 'polar-circle')
      continue;
    // No circle may reach a pole: past MAX_LAT less its radius, none.
    if (Math.abs(parallel.lat) + radiusDeg > 89) continue;
    for (const meridian of lines.meridians)
      centres.push({ lat: parallel.lat, lon: meridian.lon });
  }
  const cos = Math.cos(toRad(lat));
  const distance = (centre) =>
    Math.hypot(centre.lat - lat, normalizeLon(centre.lon - lon) * cos);
  centres.sort((a, b) => distance(a) - distance(b));
  return { radiusM, circles: centres.slice(0, MAX_CIRCLES) };
}
