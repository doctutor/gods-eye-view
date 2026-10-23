/**
 * The video's map framings. The map is Miller cylindrical (fitted on the
 * coastline: equirectangular, Mercator, Gall and Robinson leave residuals
 * several times larger, and only Miller fits with equal x and y scales;
 * fitFraming.py), and its view widens a few times: each framing is a
 * pixel mapping x = sx·u + tx, y = ty − sy·v of Miller's u, v (radians).
 * A cut is found from the labels themselves: between two samples nearly
 * every label common to both moves by one zoom and shift.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import { cleanFrame } from './labels.mjs';

const DEG = 180 / Math.PI;

/** Miller cylindrical: lon, lat (degrees) → u, v (radians). */
export function millerForward(lon, lat) {
  return [
    lon / DEG,
    1.25 * Math.log(Math.tan(Math.PI / 4 + (0.4 * lat) / DEG)),
  ];
}

/** Miller cylindrical: u, v → lon, lat (degrees). */
export function millerInverse(u, v) {
  return [
    u * DEG,
    (2.5 * Math.atan(Math.exp(0.8 * v)) - 0.625 * Math.PI) * DEG,
  ];
}

/** A pixel in a framing → [lon, lat]. */
export function pixelToLonLat(framing, x, y) {
  return millerInverse(
    (x - framing.tx) / framing.sx,
    (framing.ty - y) / framing.sy,
  );
}

/** [lon, lat] → a pixel in a framing. */
export function lonLatToPixel(framing, lon, lat) {
  const [u, v] = millerForward(lon, lat);
  return [framing.sx * u + framing.tx, framing.ty - framing.sy * v];
}

/** What a framing shows: its west, east, south and north (degrees). */
export function framingExtent(framing, width = 3840, height = 1920) {
  const [west, north] = pixelToLonLat(framing, 0, 0);
  const [east, south] = pixelToLonLat(framing, width, height);
  return { west, east, south, north };
}

function lineFit(us, vs) {
  const n = us.length;
  const mu = us.reduce((s, v) => s + v, 0) / n;
  const mv = vs.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (us[i] - mu) * (vs[i] - mv);
    sxx += (us[i] - mu) ** 2;
  }
  const a = sxx ? sxy / sxx : 1;
  return { a, b: mv - a * mu };
}

/**
 * The view's change between two samples, or null when there is none: the
 * labels both share (same text, three letters or more, once in each),
 * x' = ax·x + bx and y' = ay·y + by fitted with outliers (labels that
 * moved on their own) dropped. A cut moves most of them, consistently.
 */
export function viewChange(
  before,
  after,
  { minPairs = 6, movedShare = 0.6 } = {},
) {
  const once = (labels) => {
    const seen = new Map();
    for (const l of labels) seen.set(l.text, seen.has(l.text) ? null : l);
    return seen;
  };
  const a = once(before);
  const b = once(after);
  const pairs = [];
  for (const [text, l] of a)
    if (l && text.replace(/[^\p{L}]/gu, '').length >= 3 && b.get(text))
      pairs.push([l, b.get(text)]);
  if (pairs.length < minPairs) return null;
  const moved = pairs.filter(
    ([p, q]) => Math.hypot(q.x - p.x, q.y - p.y) > 8,
  ).length;
  if (moved < movedShare * pairs.length) return null;
  // Fit, drop the worst pair (a label that moved on its own), again, until
  // every pair left agrees within 12 px.
  let kept = pairs;
  let fx;
  let fy;
  for (;;) {
    fx = lineFit(
      kept.map(([p]) => p.x),
      kept.map(([, q]) => q.x),
    );
    fy = lineFit(
      kept.map(([p]) => p.y),
      kept.map(([, q]) => q.y),
    );
    const residual = ([p, q]) =>
      Math.hypot(fx.a * p.x + fx.b - q.x, fy.a * p.y + fy.b - q.y);
    let worst = 0;
    for (let i = 1; i < kept.length; i++)
      if (residual(kept[i]) > residual(kept[worst])) worst = i;
    if (residual(kept[worst]) < 12) break;
    if (kept.length - 1 < Math.max(minPairs, movedShare * pairs.length))
      return null;
    kept = kept.filter((_, i) => i !== worst);
  }
  return {
    ax: fx.a,
    bx: fx.b,
    ay: fy.a,
    by: fy.b,
    pairs: pairs.length,
    kept: kept.length,
  };
}

/**
 * The cuts in a run of frames: [{t, year, change}], `change` mapping the
 * pixels before the cut to those after it.
 */
export function detectCuts(frames) {
  const cuts = [];
  let previous = null;
  for (const frame of frames) {
    const labels = cleanFrame(frame);
    if (previous && labels.length) {
      const change = viewChange(previous, labels);
      if (change) cuts.push({ t: frame.t, year: frame.year, change });
    }
    if (labels.length) previous = labels;
  }
  return cuts;
}

/** A framing carried across a cut: the mapping after it from the mapping before. */
export function afterCut(framing, change) {
  return {
    sx: change.ax * framing.sx,
    tx: change.ax * framing.tx + change.bx,
    sy: change.ay * framing.sy,
    ty: change.ay * framing.ty + change.by,
  };
}

/** The framing a sample at `t` was shown in (framings sorted by fromT). */
export function framingAt(framings, t) {
  let found = null;
  for (const framing of framings) if (t >= framing.fromT) found = framing;
  return found;
}

/** Candidate projections' forward maps (lon, lat in degrees → u, v), for fits on control points. */
export const PROJECTIONS = Object.freeze({
  miller: millerForward,
  equirectangular: (lon, lat) => [lon / DEG, lat / DEG],
  mercator: (lon, lat) => [
    lon / DEG,
    Math.log(Math.tan(Math.PI / 4 + lat / DEG / 2)),
  ],
});

/**
 * A framing fitted on control points ([{lon, lat, x, y}]) for one
 * projection by least squares per axis, with each point's residual in km
 * (its fitted pixel's distance from where it is drawn, at the map's scale
 * there): {sx, tx, sy, ty, aspect, residualKm: {median, max}}.
 */
export function fitControlPoints(points, projection = 'miller') {
  const forward = PROJECTIONS[projection];
  const uv = points.map((p) => forward(p.lon, p.lat));
  const fx = lineFit(
    uv.map(([u]) => u),
    points.map((p) => p.x),
  );
  const fy = lineFit(
    uv.map(([, v]) => v),
    points.map((p) => p.y),
  );
  const mapping = { sx: fx.a, tx: fx.b, sy: -fy.a, ty: fy.b };
  const kmPerRadian = 6371;
  const residuals = points.map((p, i) => {
    const [u, v] = uv[i];
    const dx = (mapping.sx * u + mapping.tx - p.x) / mapping.sx;
    const dy = (mapping.ty - mapping.sy * v - p.y) / mapping.sy;
    // Radians of u at this latitude are cos(lat) as long on the ground.
    return (
      kmPerRadian *
      Math.hypot(dx * Math.cos(p.lat / DEG), dy * Math.cos(p.lat / DEG))
    );
  });
  const sorted = [...residuals].sort((a, b) => a - b);
  return {
    ...mapping,
    aspect: mapping.sy / mapping.sx,
    residualKm: { median: sorted[sorted.length >> 1], max: sorted.at(-1) },
  };
}
