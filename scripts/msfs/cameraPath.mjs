// Personal fork: a camera path from a route, for the MSFS renderer's bridge
// (tools/msfs-renderer/bridge): great-circle legs through the route's
// points, corners rounded to a turn the speed allows, sampled at the frame
// rate, an altitude that clears the terrain by the AGL with gentle climbs
// and descents, and heading, pitch and bank from the track.
// `npm run msfs:path` (scripts/msfs/path.mjs) is its command line. Not part
// of upstream God's Eye View.
//
// The file (version 1): {version, fps, samples: [{t, lat, lon, alt_m,
// heading_deg, pitch_deg, bank_deg, fov_deg}], meta}. Angles: heading true,
// clockwise from north; pitch positive nose up; bank positive right wing
// down. alt_m above mean sea level.

export const PATH_VERSION = 1;
const R = 6_371_008.8; // mean Earth radius, m
const G = 9.80665;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const PATH_DEFAULTS = Object.freeze({
  mode: 'line',
  speed: 40, // m/s ground speed
  agl: 150, // m above the terrain
  fps: 30,
  fov: 60, // degrees, horizontal
  lookDown: 0, // degrees below the track
  maxBank: 25, // degrees
  bankScale: 0.5, // a camera banks less than the aircraft would
  maxClimb: 0.08, // rise per metre along the track (about 4.6°)
  smoothSeconds: 4, // the altitude's moving average, each side
  maxSamples: 600_000, // 5.5 h at 30 fps
});

/** The distance between two points, m. */
export function distance(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The initial bearing from a to b, degrees clockwise from north, 0–360. */
export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) *
      Math.cos(b.lat * RAD) *
      Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** The point a fraction f of the way from a to b along the great circle. */
export function interpolate(a, b, f) {
  const d = distance(a, b) / R;
  if (d < 1e-12) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const [la, oa, lb, ob] = [a.lat * RAD, a.lon * RAD, b.lat * RAD, b.lon * RAD];
  const x = A * Math.cos(la) * Math.cos(oa) + B * Math.cos(lb) * Math.cos(ob);
  const y = A * Math.cos(la) * Math.sin(oa) + B * Math.cos(lb) * Math.sin(ob);
  const z = A * Math.sin(la) + B * Math.sin(lb);
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) * DEG,
    lon: Math.atan2(y, x) * DEG,
  };
}

/** The signed difference b − a of two headings, −180 to 180. */
export const headingDelta = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** The radius a turn at this speed and bank needs (a coordinated turn), m. */
export const turnRadius = (speed, bankDeg) =>
  (speed * speed) / (G * Math.tan(bankDeg * RAD));

/**
 * A dense polyline through the points: great-circle legs every `step` m,
 * and at each inner corner a circular arc of `radius` tangent to both legs
 * (the turn a coordinated bank at the speed flies). Where the legs are too
 * short for it, the arc is tightened so its tangent points stay within 40%
 * of each leg. The corner is worked in a local flat frame around the via
 * point, fine for a few kilometres.
 */
export function densify(points, { step = 10, radius = 0 } = {}) {
  if (points.length < 2) throw new Error('a route needs at least two points');
  const fillets = points.map((c, i) => {
    if (i === 0 || i === points.length - 1 || !radius) return null;
    const inbound = (bearing(c, points[i - 1]) + 180) % 360;
    const outbound = bearing(c, points[i + 1]);
    const turn = headingDelta(inbound, outbound) * RAD; // + right, − left
    if (Math.abs(turn) < 0.5 * RAD) return null;
    const tan = Math.tan(Math.abs(turn) / 2);
    const room =
      0.4 * Math.min(distance(points[i - 1], c), distance(c, points[i + 1]));
    const trim = Math.min(radius * tan, room);
    return { c, inbound, turn, trim, radius: trim / tan };
  });
  const out = [];
  const leg = (a, b, from, to) => {
    const length = distance(a, b) * (to - from);
    const n = Math.max(1, Math.ceil(length / step));
    for (let i = 0; i < n; i++)
      out.push(interpolate(a, b, from + ((to - from) * i) / n));
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = distance(a, b);
    const from = length && fillets[i] ? fillets[i].trim / length : 0;
    const to = length && fillets[i + 1] ? 1 - fillets[i + 1].trim / length : 1;
    leg(a, b, from, to);
    const f = fillets[i + 1];
    if (!f) continue;
    // The arc, in metres east (x) and north (y) of the via point: from the
    // tangent point on the inbound leg, sweeping the turn.
    const k = Math.cos(f.c.lat * RAD);
    const toGeo = (x, y) => ({
      lat: f.c.lat + (y / R) * DEG,
      lon: f.c.lon + (x / (R * k)) * DEG,
    });
    const b0 = f.inbound * RAD;
    const sx = -f.trim * Math.sin(b0);
    const sy = -f.trim * Math.cos(b0);
    const side = Math.sign(f.turn); // the centre: right of the track for a right turn
    const cx = sx + side * f.radius * Math.cos(b0);
    const cy = sy - side * f.radius * Math.sin(b0);
    const n = Math.max(2, Math.ceil((f.radius * Math.abs(f.turn)) / step));
    const arc = (phi) =>
      toGeo(
        cx - side * f.radius * Math.cos(phi),
        cy + side * f.radius * Math.sin(phi),
      );
    // The flat frame's ends miss the legs' great-circle tangent points by
    // millimetres; spread the difference along the arc so both joins are
    // seamless.
    const next = points[i + 2];
    const start = interpolate(a, b, to);
    const end = interpolate(b, next, f.trim / distance(b, next));
    const s0 = arc(b0);
    const e0 = arc(b0 + f.turn);
    for (let j = 0; j < n; j++) {
      const u = j / n;
      const p = arc(b0 + f.turn * u);
      out.push({
        lat: p.lat + (1 - u) * (start.lat - s0.lat) + u * (end.lat - e0.lat),
        lon: p.lon + (1 - u) * (start.lon - s0.lon) + u * (end.lon - e0.lon),
      });
    }
  }
  out.push({ ...points.at(-1) });
  return out;
}

/** Points every `spacing` m along a polyline (the last one at its end). */
export function resample(line, spacing) {
  if (!(spacing > 0)) throw new Error('the spacing must be positive');
  const out = [{ ...line[0] }];
  let need = spacing; // metres still to go to the next sample
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const length = distance(a, b);
    let along = 0; // metres into this segment
    while (length - along >= need - 1e-9) {
      along += need;
      out.push(interpolate(a, b, along / length));
      need = spacing;
    }
    need -= length - along;
  }
  // The end, unless the last sample is already on it.
  const last = line.at(-1);
  if (distance(out.at(-1), last) > spacing * 0.01) out.push({ ...last });
  return out;
}

/** The moving average of values over ±half samples (clamped at the ends). */
export function movingAverage(values, half) {
  if (half < 1) return Float64Array.from(values);
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/**
 * The lowest profile at or above `floor` whose rise or fall per sample is
 * at most `slope × ds`: max over j of floor[j] − slope·ds·|i − j|, in two
 * passes. It climbs ahead of a ridge and descends after it.
 */
export function slopeLimit(floor, slope, ds) {
  const out = Float64Array.from(floor);
  const step = slope * ds;
  for (let i = 1; i < out.length; i++)
    out[i] = Math.max(out[i], out[i - 1] - step);
  for (let i = out.length - 2; i >= 0; i--)
    out[i] = Math.max(out[i], out[i + 1] - step);
  return out;
}

/**
 * The altitudes for samples ds apart over terrain heights: terrain + agl,
 * slope-limited, then smoothed over ±half samples and lifted by the most
 * a moving average of a slope-limited profile can sag (slope·ds·(half+1)/2),
 * so every altitude still clears the terrain by the AGL.
 */
export function clearanceProfile(terrain, { agl, maxClimb, ds, half }) {
  const floor = Float64Array.from(
    terrain,
    (h) => (Number.isFinite(h) ? h : 0) + agl,
  );
  const limited = slopeLimit(floor, maxClimb, ds);
  const smoothed = movingAverage(limited, half);
  // The average over ±half samples of a profile rising at most maxClimb·ds
  // a sample is at most maxClimb·ds·half(half+1)/(2half+1) below it, which
  // is under maxClimb·ds·(half+1)/2.
  const lift = (maxClimb * ds * (half + 1)) / 2;
  return Float64Array.from(smoothed, (z) => z + lift);
}

/** Headings along points (the last repeats the one before), degrees. */
export function trackHeadings(points) {
  const out = new Float64Array(points.length);
  for (let i = 0; i < points.length - 1; i++)
    out[i] = bearing(points[i], points[i + 1]);
  out[points.length - 1] = points.length > 1 ? out[points.length - 2] : 0;
  return out;
}

/** The bank a coordinated turn at this turn rate needs, scaled and clamped, degrees. */
export function bankFor(speed, turnRateDegPerS, { maxBank, bankScale }) {
  const bank = Math.atan((speed * turnRateDegPerS * RAD) / G) * DEG * bankScale;
  return Math.max(-maxBank, Math.min(maxBank, bank));
}

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/** A route's points, checked: [{lat, lon}], two or more. */
export function checkRoute(points) {
  if (!Array.isArray(points) || points.length < 2)
    throw new Error('a route needs a start and an end');
  for (const p of points)
    if (!(Math.abs(p?.lat) <= 90 && Math.abs(p?.lon) <= 180))
      throw new Error(`not a point: ${JSON.stringify(p)}`);
  return points.map((p) => ({ lat: +p.lat, lon: +p.lon }));
}

/**
 * The camera path for a route. `terrain` is an async function from
 * [{lat, lon}] to heights in metres (NaN where unknown), or null for none
 * (the altitude is then the AGL above sea level).
 * @param {{from: {lat, lon}, to: {lat, lon}, via?: Array<{lat, lon}>}} route
 * @param {object} [options] PATH_DEFAULTS' keys
 * @param {(points: Array<{lat: number, lon: number}>) => Promise<ArrayLike<number>>} [terrain]
 */
export async function buildCameraPath(route, options = {}, terrain = null) {
  const o = { ...PATH_DEFAULTS, ...options };
  for (const key of ['speed', 'fps', 'fov', 'maxBank', 'maxClimb'])
    if (!(Number(o[key]) > 0)) throw new Error(`${key} must be positive`);
  if (!(o.agl >= 0)) throw new Error('agl must be 0 or more');
  if (!['line', 'road'].includes(o.mode))
    throw new Error(`no mode ${o.mode} (line or road)`);
  const points = checkRoute([route.from, ...(route.via || []), route.to]);
  const warnings = [];
  if (o.mode === 'road')
    warnings.push(
      'road: no routing over the Overture roads exists yet (the roads index has no graph), so the path is great-circle legs through the via points; add via points along the road to follow it',
    );

  const ds = o.speed / o.fps; // metres a frame
  const radius = turnRadius(o.speed, o.maxBank);
  const line = densify(points, { step: Math.min(25, ds * 2), radius });
  const samples = resample(line, ds);
  if (samples.length > o.maxSamples)
    throw new Error(
      `${samples.length} frames is past ${o.maxSamples}: a lower fps, a higher speed or a shorter route`,
    );

  let heights;
  if (terrain) {
    heights = Float64Array.from(await terrain(samples), Number);
    const unknown = heights.filter((h) => !Number.isFinite(h)).length;
    if (unknown)
      warnings.push(
        `${unknown} of ${heights.length} samples had no terrain height (taken as 0 m)`,
      );
  } else {
    heights = new Float64Array(samples.length);
    warnings.push('no terrain: the altitude is the AGL above sea level');
  }
  const half = Math.max(1, Math.round(o.smoothSeconds * o.fps));
  const alt = clearanceProfile(heights, {
    agl: o.agl,
    maxClimb: o.maxClimb,
    ds,
    half,
  });

  // Heading along the track, smoothed as unit vectors over half a second.
  const raw = trackHeadings(samples);
  const hs = Math.max(1, Math.round(o.fps / 2));
  const sx = movingAverage(
    Float64Array.from(raw, (h) => Math.sin(h * RAD)),
    hs,
  );
  const cx = movingAverage(
    Float64Array.from(raw, (h) => Math.cos(h * RAD)),
    hs,
  );
  const heading = Float64Array.from(
    sx,
    (s, i) => (Math.atan2(s, cx[i]) * DEG + 360) % 360,
  );
  // Bank from the turn rate, smoothed over a second.
  const bankRaw = new Float64Array(samples.length);
  for (let i = 1; i < samples.length - 1; i++) {
    const rate = (headingDelta(heading[i - 1], heading[i + 1]) * o.fps) / 2;
    bankRaw[i] = bankFor(o.speed, rate, o);
  }
  const bank = movingAverage(bankRaw, Math.max(1, Math.round(o.fps)));

  const out = samples.map((p, i) => {
    const j = Math.min(i + 1, samples.length - 1);
    const k = j === i ? Math.max(0, i - 1) : i;
    const run = distance(samples[k], samples[j]) || ds;
    const pitch = Math.atan2(alt[j] - alt[k], run) * DEG - o.lookDown;
    return {
      t: round(i / o.fps, 4),
      lat: round(p.lat, 7),
      lon: round(p.lon, 7),
      alt_m: round(alt[i], 1),
      heading_deg: round(heading[i], 2),
      pitch_deg: round(pitch, 2),
      bank_deg: round(bank[i], 2),
      fov_deg: o.fov,
    };
  });
  const length = samples
    .slice(1)
    .reduce((sum, p, i) => sum + distance(samples[i], p), 0);
  return {
    version: PATH_VERSION,
    fps: o.fps,
    samples: out,
    meta: {
      generator: 'gods-eye-view scripts/msfs/cameraPath.mjs',
      from: points[0],
      to: points.at(-1),
      via: points.slice(1, -1),
      mode: o.mode,
      speed_mps: o.speed,
      agl_m: o.agl,
      fov_deg: o.fov,
      look_down_deg: o.lookDown,
      max_bank_deg: o.maxBank,
      turn_radius_m: round(radius, 1),
      distance_m: round(length, 1),
      duration_s: round((out.length - 1) / o.fps, 3),
      terrain: terrain ? (o.terrainName ?? 'terrain') : 'none',
      warnings,
    },
  };
}

/** A path file's problems (empty when it is valid). */
export function validatePath(path) {
  const problems = [];
  if (path?.version !== PATH_VERSION)
    problems.push(`version ${path?.version} is not ${PATH_VERSION}`);
  if (!(path?.fps > 0)) problems.push('fps must be positive');
  const samples = Array.isArray(path?.samples) ? path.samples : [];
  if (samples.length < 2) problems.push('fewer than two samples');
  let last = -Infinity;
  samples.forEach((s, i) => {
    if (problems.length > 20) return;
    if (!(s.t > last)) problems.push(`sample ${i}: t ${s.t} does not increase`);
    last = s.t;
    if (!(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180))
      problems.push(`sample ${i}: lat/lon out of range`);
    for (const key of [
      'alt_m',
      'heading_deg',
      'pitch_deg',
      'bank_deg',
      'fov_deg',
    ])
      if (!Number.isFinite(s[key]))
        problems.push(`sample ${i}: ${key} is not a number`);
    if (!(s.fov_deg > 0 && s.fov_deg < 180))
      problems.push(`sample ${i}: fov_deg out of range`);
  });
  return problems;
}

/**
 * Terrain heights from the app's raster values (GET /api/raster/values,
 * layer ee-elevation: the DEM stack): the samples grouped into windows of
 * `chunkDeg` on a side, each window fetched once at `cells` a side, each
 * sample read by bilinear interpolation between the cell centres.
 * @param {{get: Function}} client createRasterValuesClient's
 */
export function rasterTerrain(
  client,
  { layer = 'ee-elevation', chunkDeg = 0.2, cells = 256 } = {},
) {
  return async (points) => {
    const groups = new Map();
    points.forEach((p, i) => {
      const key = `${Math.floor(p.lat / chunkDeg)},${Math.floor(p.lon / chunkDeg)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const heights = new Float64Array(points.length).fill(NaN);
    for (const [key, indices] of groups) {
      const [row, col] = key.split(',').map(Number);
      const box = {
        south: Math.max(-90, row * chunkDeg),
        north: Math.min(90, (row + 1) * chunkDeg),
        west: Math.max(-180, col * chunkDeg),
        east: Math.min(180, (col + 1) * chunkDeg),
      };
      const { header, values } = await client.get({ layer, box, cells });
      for (const i of indices)
        heights[i] = sampleGrid(header, values, points[i]);
    }
    return heights;
  };
}

/** A raster values grid read at a point, bilinear between the cell centres (NaN outside). */
export function sampleGrid(header, values, { lat, lon }) {
  const { cols, rows, west, south, east, north } = header;
  const x = ((lon - west) / (east - west)) * cols - 0.5;
  const y = ((north - lat) / (north - south)) * rows - 0.5;
  if (x < -0.5 || y < -0.5 || x > cols - 0.5 || y > rows - 0.5) return NaN;
  const cx = Math.max(0, Math.min(cols - 1, x));
  const cy = Math.max(0, Math.min(rows - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const at = (c, r) => values[r * cols + c];
  const v00 = at(x0, y0);
  const v10 = at(x1, y0);
  const v01 = at(x0, y1);
  const v11 = at(x1, y1);
  const corners = [v00, v10, v01, v11];
  if (corners.some((v) => !Number.isFinite(v))) {
    const known = corners.filter(Number.isFinite);
    return known.length ? Math.max(...known) : NaN;
  }
  return (
    (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
  );
}
