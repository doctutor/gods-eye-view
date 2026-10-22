/**
 * The river names' matching (scripts/rivers/names.mjs): which named
 * OpenStreetMap waterway a HydroSHEDS v2 reach follows, and which unnamed
 * reaches inherit a name down their main stem. Pure: plain arrays in, no
 * files.
 *
 * A reach is sampled along its length; each sample looks for OSM segments
 * within a tolerance that grows with the reach's Strahler order (a small
 * stream's line and OSM's agree to a few pixels of v2's 1″ grid; a large
 * river's centreline can sit a channel's width away), and counts for the
 * waterways whose nearest segment there runs within 45° of the reach's
 * own direction (digitised either way). The waterway, grouped by Wikidata
 * item or else by name, that covers the most of the reach wins when it
 * covers at least MIN_COVERAGE of it.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const MIN_COVERAGE = 0.4;
export const MAX_ANGLE_DEGREES = 45;
export const MAX_SAMPLES = 400;

/** Metres a reach may sit from its OSM line, by Strahler order. */
export function toleranceForOrder(strahler) {
  const order = Number(strahler) || 1;
  if (order <= 2) return 30;
  if (order >= 6) return 250;
  return 100;
}

/** A local metric projection around a latitude: (lon, lat) → [x, y] m. */
export function localProjector(lat0) {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  return (lon, lat) => [lon * kx, lat * ky];
}

/** The key a waterway's name groups by: its Wikidata item, else its name. */
export function nameKey({ wikidata = '', name = '' }) {
  const item = String(wikidata || '').trim();
  if (/^Q\d+$/.test(item)) return item;
  const text = String(name || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return text ? `n:${text}` : '';
}

/**
 * A grid of the waterways' segments for nearest queries: `ways` as
 * [{group: number, coords: [lon, lat, lon, lat, …]}] (group: the index of
 * the way's name group), projected with `project`.
 */
export function createWayIndex(ways, { project, cellM = 250 } = {}) {
  const x1 = [];
  const y1 = [];
  const x2 = [];
  const y2 = [];
  const groups = [];
  const buckets = new Map();
  const bucketKey = (i, j) => i * 1_000_003 + j;
  for (const way of ways) {
    const c = way.coords;
    for (let k = 0; k + 3 < c.length; k += 2) {
      const [ax, ay] = project(c[k], c[k + 1]);
      const [bx, by] = project(c[k + 2], c[k + 3]);
      const s = groups.length;
      x1.push(ax);
      y1.push(ay);
      x2.push(bx);
      y2.push(by);
      groups.push(way.group);
      const i0 = Math.floor(Math.min(ax, bx) / cellM);
      const i1 = Math.floor(Math.max(ax, bx) / cellM);
      const j0 = Math.floor(Math.min(ay, by) / cellM);
      const j1 = Math.floor(Math.max(ay, by) / cellM);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const key = bucketKey(i, j);
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          list.push(s);
        }
    }
  }
  return {
    project,
    size: groups.length,
    /**
     * For a point and a direction (unit dx, dy), the nearest segment of each
     * group within `radius` whose direction agrees within `maxAngle`:
     * Map group → distance.
     */
    near(x, y, dx, dy, radius, maxAngle = MAX_ANGLE_DEGREES) {
      const out = new Map();
      const cos = Math.cos((maxAngle * Math.PI) / 180);
      const reach = Math.ceil(radius / cellM);
      const ci = Math.floor(x / cellM);
      const cj = Math.floor(y / cellM);
      const seen = new Set();
      for (let i = ci - reach; i <= ci + reach; i++)
        for (let j = cj - reach; j <= cj + reach; j++) {
          const list = buckets.get(bucketKey(i, j));
          if (!list) continue;
          for (const s of list) {
            if (seen.has(s)) continue;
            seen.add(s);
            const sx = x2[s] - x1[s];
            const sy = y2[s] - y1[s];
            const length = Math.hypot(sx, sy);
            if (!(length > 0)) continue;
            // Undirected: a way digitised upstream agrees too.
            if (Math.abs((sx * dx + sy * dy) / length) < cos) continue;
            const t = Math.max(
              0,
              Math.min(
                1,
                ((x - x1[s]) * sx + (y - y1[s]) * sy) / (length * length),
              ),
            );
            const d = Math.hypot(x - (x1[s] + t * sx), y - (y1[s] + t * sy));
            if (d > radius) continue;
            const g = groups[s];
            const best = out.get(g);
            if (best === undefined || d < best) out.set(g, d);
          }
        }
      return out;
    },
  };
}

/**
 * Samples along a polyline ([lon, lat, …], projected): {x, y, dx, dy, w},
 * about one every `step` metres, at most `maxSamples`, each weighing the
 * length it stands for.
 */
export function sampleLine(coords, project, step, maxSamples = MAX_SAMPLES) {
  const points = [];
  for (let k = 0; k + 1 < coords.length; k += 2)
    points.push(project(coords[k], coords[k + 1]));
  let total = 0;
  for (let k = 1; k < points.length; k++)
    total += Math.hypot(
      points[k][0] - points[k - 1][0],
      points[k][1] - points[k - 1][1],
    );
  if (!(total > 0)) return { samples: [], length: 0 };
  const spacing = Math.max(step, total / maxSamples);
  const samples = [];
  let carried = spacing / 2;
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1];
    const [bx, by] = points[k];
    const length = Math.hypot(bx - ax, by - ay);
    if (!(length > 0)) continue;
    const dx = (bx - ax) / length;
    const dy = (by - ay) / length;
    let at = carried;
    while (at <= length) {
      samples.push({ x: ax + dx * at, y: ay + dy * at, dx, dy });
      at += spacing;
    }
    carried = at - length;
  }
  const w = samples.length ? total / samples.length : 0;
  for (const sample of samples) sample.w = w;
  return { samples, length: total };
}

/**
 * The name group a reach follows: {group, coverage, distance} for the
 * group covering the most of it, or null under MIN_COVERAGE (`best` then
 * says how close the nearest came).
 * @param {number[]} coords the reach's [lon, lat, …]
 */
export function matchReach(
  coords,
  index,
  { tolerance, minCoverage = MIN_COVERAGE, maxSamples = MAX_SAMPLES } = {},
) {
  const { samples, length } = sampleLine(
    coords,
    index.project,
    Math.max(10, tolerance / 2),
    maxSamples,
  );
  if (!samples.length) return null;
  const covered = new Map(); // group → [length, Σ distance × length]
  for (const s of samples) {
    for (const [group, d] of index.near(s.x, s.y, s.dx, s.dy, tolerance)) {
      const entry = covered.get(group) || [0, 0];
      entry[0] += s.w;
      entry[1] += d * s.w;
      covered.set(group, entry);
    }
  }
  let best = null;
  for (const [group, [len, dsum]] of covered) {
    const coverage = Math.min(1, len / length);
    const distance = dsum / len;
    if (
      !best ||
      coverage > best.coverage + 1e-9 ||
      (Math.abs(coverage - best.coverage) <= 1e-9 && distance < best.distance)
    )
      best = { group, coverage, distance };
  }
  if (!best || best.coverage < minCoverage) return null;
  return best;
}

/**
 * Names down the main stem: a reach without a name of its own takes the
 * name of the reach above it of the same Strahler order (the stem goes on;
 * a confluence of two equal orders raises the order and ends it), the
 * largest such reach when there are several, walking down until a reach
 * has its own name or the order changes.
 * @param {{down: Int32Array, order: Uint8Array, upland: Float32Array,
 *   direct: Int32Array}} network dense indexes: `down` the downstream
 *   reach's index or -1, `direct` the reach's own name group or -1
 * @returns {{names: Int32Array, inherited: Uint8Array}}
 */
export function inheritNames({ down, order, upland, direct }) {
  const n = direct.length;
  const names = Int32Array.from(direct);
  const inherited = new Uint8Array(n);
  /** The upland of the reach a name was carried from (the stem's size). */
  const carriedUpland = new Float32Array(n).fill(-1);
  // Largest first, so the main stem's name wins where stems meet.
  const starts = [];
  for (let i = 0; i < n; i++) if (direct[i] >= 0) starts.push(i);
  starts.sort((a, b) => upland[b] - upland[a]);
  for (const start of starts) {
    let cur = start;
    for (let hops = 0; hops < n; hops++) {
      const next = down[cur];
      if (next < 0 || direct[next] >= 0) break;
      if (order[next] !== order[cur]) break;
      if (names[next] >= 0 && carriedUpland[next] >= upland[start]) break;
      names[next] = direct[start];
      inherited[next] = 1;
      carriedUpland[next] = upland[start];
      cur = next;
    }
  }
  return { names, inherited };
}
