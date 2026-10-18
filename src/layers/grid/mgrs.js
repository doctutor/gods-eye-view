import {
  MAX_LINES,
  MAX_LINES_PER_AXIS,
  MIN_LINES,
  gridWindow,
  normalizeLon,
  viewHalfDegrees,
  viewHalfLon,
} from './model.js';
import {
  MGRS_NORTH,
  MGRS_SOUTH,
  bandIndex,
  bandLetter,
  bandRange,
  centralMeridian,
  bandZones,
  fromUtm,
  squareLetters,
  toMgrs,
  toUtm,
  zoneOf,
} from './utm.js';

/**
 * Personal fork: the Grid layer's MGRS mode, without Cesium. The level
 * follows the camera's height as the graticule's spacing does (about 4 to
 * 12 lines across the view): the grid zones (6° by 8°, Norway and Svalbard
 * included), then 100 km squares, then 10 km and 1 km lines. The zone
 * boundaries are always drawn; the UTM lines are traced in each zone's own
 * grid and cut where the zone ends, so they meet its edges at their true
 * slant. Only the window around the view (the graticule's) is drawn,
 * capped; MGRS stops at 80°S and 84°N (the polar caps are UPS).
 */

/** The levels, widest first; `nominalM` stands in for a zone's width. */
export const MGRS_LEVELS = Object.freeze([
  { id: 'gzd', stepM: null, nominalM: 700_000 },
  { id: '100km', stepM: 100_000, nominalM: 100_000 },
  { id: '10km', stepM: 10_000, nominalM: 10_000 },
  { id: '1km', stepM: 1_000, nominalM: 1_000 },
]);
/** The most UTM line pieces in one window, the view's zone first. */
export const MAX_MGRS_LINES = 240;
/** The most square and zone labels at once. */
export const MAX_MGRS_LABELS = 40;
const METRES_PER_DEG = 111_320;
const SAMPLES_PER_LINE = 42;
const EPS = 1e-9;

/** The level for a camera height: 4–12 lines across, nearest 7. */
export function mgrsLevelForHeight(heightM) {
  const span = 2 * viewHalfDegrees(heightM) * METRES_PER_DEG;
  let best = MGRS_LEVELS[0];
  let bestScore = Infinity;
  for (const level of MGRS_LEVELS) {
    const lines = span / level.nominalM;
    const inRange = lines >= MIN_LINES && lines <= MAX_LINES;
    const score = (inRange ? 0 : 10) + Math.abs(Math.log(lines / 7));
    if (score < bestScore) {
      best = level;
      bestScore = score;
    }
  }
  return best;
}

/** The window clipped to MGRS's latitudes, or null beyond them. */
function mgrsWindow(view) {
  const window = gridWindow(view);
  const south = Math.max(window.south, MGRS_SOUTH);
  const north = Math.min(window.north, MGRS_NORTH);
  return south < north ? { ...window, south, north } : null;
}

/** The longitude shifts (multiples of 360°) that bring a range into the window. */
function shiftsInto(west, east, window) {
  const out = [];
  for (const shift of [-360, 0, 360])
    if (west + shift < window.east - EPS && east + shift > window.west + EPS)
      out.push(shift);
  return out;
}

/**
 * The grid-zone cells inside the window, one per band and zone:
 * {zone, band, shift, west, east, south, north}, clipped to the window,
 * with longitudes unwrapped like the window's (`shift` from the zone's own).
 */
export function zoneCells(window) {
  const cells = [];
  if (!window) return cells;
  for (let band = bandIndex(window.south); band <= 19; band += 1) {
    const range = bandRange(band);
    if (range.south >= window.north - EPS) break;
    if (range.north <= window.south + EPS) continue;
    for (const zone of bandZones(band))
      for (const shift of shiftsInto(zone.west, zone.east, window))
        cells.push({
          zone: zone.zone,
          band,
          shift,
          west: Math.max(zone.west + shift, window.west),
          east: Math.min(zone.east + shift, window.east),
          south: Math.max(range.south, window.south),
          north: Math.min(range.north, window.north),
        });
  }
  return cells;
}

/** Cells of one zone in neighbouring bands with the same edges, joined. */
function mergedCells(cells) {
  const sorted = [...cells].sort(
    (a, b) => a.zone - b.zone || a.shift - b.shift || a.south - b.south,
  );
  const out = [];
  for (const cell of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      last.zone === cell.zone &&
      last.shift === cell.shift &&
      Math.abs(last.west - cell.west) < EPS &&
      Math.abs(last.east - cell.east) < EPS &&
      Math.abs(last.north - cell.south) < EPS
    )
      last.north = cell.north;
    else out.push({ ...cell });
  }
  return out;
}

/**
 * The grid-zone boundaries in the window: meridian pieces (each zone's west
 * edge, joined across bands) and the band parallels, as
 * {kind: 'gzd', axis: 'meridian'|'parallel', points: [{lat, lon}]}.
 */
export function zoneBoundaries(window) {
  if (!window) return [];
  const pieces = new Map();
  for (const cell of zoneCells(window)) {
    const range = bandRange(cell.band);
    const zone = bandZones(cell.band).find((z) => z.zone === cell.zone);
    const lon = zone.west + cell.shift;
    if (lon < window.west - EPS || lon > window.east + EPS) continue;
    const key = window.fullCircle
      ? normalizeLon(lon).toFixed(6).replace('-180.000000', '180.000000')
      : lon.toFixed(6);
    const south = Math.max(range.south, window.south);
    const north = Math.min(range.north, window.north);
    const runs = pieces.get(key) || [];
    const joined = runs.find(
      (run) => Math.abs(run.north - south) < EPS && run.lon === lon,
    );
    if (joined) joined.north = north;
    else runs.push({ lon, south, north });
    pieces.set(key, runs);
  }
  const out = [];
  for (const runs of pieces.values())
    for (const run of runs)
      out.push({
        kind: 'gzd',
        axis: 'meridian',
        points: [
          { lat: run.south, lon: run.lon },
          { lat: run.north, lon: run.lon },
        ],
      });
  for (let band = 0; band <= 20; band += 1) {
    const lat = band === 20 ? MGRS_NORTH : MGRS_SOUTH + band * 8;
    if (lat < window.south - EPS || lat > window.north + EPS) continue;
    out.push({
      kind: 'gzd',
      axis: 'parallel',
      points: [
        { lat, lon: window.west },
        { lat, lon: window.east },
      ],
    });
  }
  return out;
}

const inside = (cell, point) =>
  point.lat >= cell.south - EPS &&
  point.lat <= cell.north + EPS &&
  point.lon >= cell.west - EPS &&
  point.lon <= cell.east + EPS;

/**
 * The pieces of one UTM line inside a cell: `at(t)` gives the point at a
 * grid coordinate t from `from` to `to`; where the line leaves the cell the
 * crossing is found by bisection, so pieces end on the zone's edge.
 */
function tracePieces(cell, at, from, to) {
  const pieces = [];
  // A sliver at a corner (one point twice) would fail the whole primitive
  // in Cesium's worker: pieces must span something.
  const spans = (piece) =>
    piece.length >= 2 &&
    Math.abs(piece[0].lat - piece[piece.length - 1].lat) +
      Math.abs(piece[0].lon - piece[piece.length - 1].lon) >
      1e-6;
  let piece = null;
  let lastT = from;
  let lastPoint = at(from);
  let lastIn = inside(cell, lastPoint);
  if (lastIn) piece = [lastPoint];
  for (let i = 1; i <= SAMPLES_PER_LINE; i += 1) {
    const t = from + ((to - from) * i) / SAMPLES_PER_LINE;
    const point = at(t);
    const isIn = inside(cell, point);
    if (isIn !== lastIn) {
      let a = lastT;
      let b = t;
      for (let k = 0; k < 30; k += 1) {
        const mid = (a + b) / 2;
        if (inside(cell, at(mid)) === lastIn) a = mid;
        else b = mid;
      }
      const edge = at(lastIn ? a : b);
      if (lastIn) {
        piece.push(edge);
        if (spans(piece)) pieces.push(piece);
        piece = null;
      } else piece = [edge];
    }
    if (isIn) piece.push(point);
    lastT = t;
    lastPoint = point;
    lastIn = isIn;
  }
  if (piece && spans(piece)) pieces.push(piece);
  return pieces;
}

/** A cell's extent in its zone's grid, from points around and across it. */
function gridExtent(cell) {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  const lonOf = (lon) => lon - cell.shift;
  const add = (lat, lon) => {
    const { easting, northing } = toUtm(lat, lonOf(lon), cell.zone);
    minE = Math.min(minE, easting);
    maxE = Math.max(maxE, easting);
    minN = Math.min(minN, northing);
    maxN = Math.max(maxN, northing);
  };
  for (let i = 0; i <= 4; i += 1)
    for (let j = 0; j <= 4; j += 1)
      add(
        cell.south + ((cell.north - cell.south) * i) / 4,
        cell.west + ((cell.east - cell.west) * j) / 4,
      );
  // Parallels bow towards the pole in the grid: their extreme northing is
  // on the central meridian.
  const centre = centralMeridian(cell.zone) + cell.shift;
  if (centre > cell.west && centre < cell.east) {
    add(cell.south, centre);
    add(cell.north, centre);
  }
  return { minE, maxE, minN, maxN };
}

/** Multiples of `step` in [min, max], the nearest to `near` first, capped. */
function valuesIn(min, max, step, near) {
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + EPS; v += step)
    out.push(Math.round(v / step) * step);
  out.sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
  return out.slice(0, MAX_LINES_PER_AXIS);
}

/** The cell the view is in sorts first, then the nearest. */
function cellDistance(cell, view) {
  const lat = Math.max(cell.south, Math.min(cell.north, view.lat));
  const lon = Math.max(cell.west, Math.min(cell.east, view.lon));
  return Math.hypot(lat - view.lat, lon - view.lon);
}

/**
 * The MGRS lines around a view.
 * @param {{lat: number, lon: number, heightM: number}} view
 * @returns {{level: object, window: object|null, boundaries: Array,
 *   lines: Array<{kind: 'mgrs'|'mgrs-100k', axis: 'e'|'n', zone: number,
 *   value: number, points: Array<{lat: number, lon: number}>}>}} `value`:
 *   the line's easting, or its signed northing (negative south of the
 *   equator).
 */
export function mgrsLines(view) {
  const level = mgrsLevelForHeight(view.heightM);
  const window = mgrsWindow(view);
  const boundaries = zoneBoundaries(window);
  const lines = [];
  if (!window || !level.stepM) return { level, window, boundaries, lines };
  const step = level.stepM;
  const cells = mergedCells(zoneCells(window)).sort(
    (a, b) => cellDistance(a, view) - cellDistance(b, view),
  );
  for (const cell of cells) {
    if (lines.length >= MAX_MGRS_LINES) break;
    const { minE, maxE, minN, maxN } = gridExtent(cell);
    const centre = toUtm(
      Math.max(cell.south, Math.min(cell.north, view.lat)),
      Math.max(cell.west, Math.min(cell.east, view.lon)) - cell.shift,
      cell.zone,
    );
    const point = (easting, northing) => {
      const p = fromUtm(easting, northing, cell.zone);
      return { lat: p.lat, lon: p.lon + cell.shift };
    };
    const kindOf = (value) =>
      Math.abs(value / 100_000 - Math.round(value / 100_000)) < EPS
        ? 'mgrs-100k'
        : 'mgrs';
    const add = (axis, value, pieces) => {
      for (const points of pieces)
        if (lines.length < MAX_MGRS_LINES)
          lines.push({
            kind: kindOf(value),
            axis,
            zone: cell.zone,
            value,
            points,
          });
    };
    for (const easting of valuesIn(minE, maxE, step, centre.easting))
      add(
        'e',
        easting,
        tracePieces(cell, (n) => point(easting, n), minN, maxN),
      );
    for (const northing of valuesIn(minN, maxN, step, centre.northing))
      add(
        'n',
        northing,
        tracePieces(cell, (e) => point(e, northing), minE, maxE),
      );
  }
  return { level, window, boundaries, lines };
}

/** A line's label: its kilometres within the 100 km square, two digits. */
export function lineDigits(value) {
  const km = Math.floor((((value % 100_000) + 100_000) % 100_000) / 1_000);
  return String(km).padStart(2, '0');
}

/** The view centre's reference at the level's precision ("18S UJ 23 06"). */
export function viewReference(view, level = mgrsLevelForHeight(view.heightM)) {
  if (!(view.lat >= MGRS_SOUTH && view.lat <= MGRS_NORTH)) return null;
  if (!level.stepM)
    return `${zoneOf(view.lat, view.lon)}${bandLetter(view.lat)}`;
  return toMgrs(view.lat, view.lon, level.stepM);
}

/**
 * Where the MGRS labels go, as {text, lat, lon, axis, kind, key?}; `key`
 * tells apart lines 100 km apart, whose digits are the same:
 * - zones: each grid zone's designator ("18S") at its centre in view;
 * - 100 km: each square's reference ("18S UJ") at its centre in view;
 * - 10 km and 1 km: in the view's zone, each line's kilometre digits near
 *   the view's west and south edges, and the square's reference at the
 *   south-west corner.
 */
export function mgrsLabelPlacements(set, view) {
  const out = [];
  if (!set?.window) return out;
  const half = viewHalfDegrees(view.heightM);
  const halfLon = viewHalfLon(view);
  const inView = (p) =>
    Math.abs(p.lat - view.lat) <= half &&
    Math.abs(normalizeLon(p.lon - view.lon)) <= halfLon;
  const nearest = (items) =>
    items
      .sort(
        (a, b) =>
          Math.hypot(a.lat - view.lat, normalizeLon(a.lon - view.lon)) -
          Math.hypot(b.lat - view.lat, normalizeLon(b.lon - view.lon)),
      )
      .slice(0, MAX_MGRS_LABELS);
  if (set.level.id === 'gzd') {
    const items = [];
    for (const cell of zoneCells(set.window)) {
      const centre = {
        lat: (cell.south + cell.north) / 2,
        lon: (cell.west + cell.east) / 2,
      };
      if (inView(centre))
        items.push({
          text: `${cell.zone}${bandLetter(centre.lat)}`,
          lat: centre.lat,
          lon: normalizeLon(centre.lon),
          axis: 'zone',
          kind: 'gzd',
        });
    }
    return nearest(items);
  }
  if (set.level.id === '100km') {
    const items = [];
    for (const cell of mergedCells(zoneCells(set.window))) {
      const { minE, maxE, minN, maxN } = gridExtent(cell);
      for (let e = Math.floor(minE / 100_000) * 100_000; e < maxE; e += 100_000)
        for (
          let n = Math.floor(minN / 100_000) * 100_000;
          n < maxN;
          n += 100_000
        ) {
          const p = fromUtm(e + 50_000, n + 50_000, cell.zone);
          const centre = { lat: p.lat, lon: p.lon + cell.shift };
          if (!inside(cell, centre) || !inView(centre)) continue;
          items.push({
            text: `${cell.zone}${bandLetter(centre.lat)} ${squareLetters(cell.zone, e + 50_000, n + 50_000)}`,
            lat: centre.lat,
            lon: normalizeLon(centre.lon),
            axis: 'square',
            kind: 'square',
          });
        }
    }
    return nearest(items);
  }
  if (!(view.lat >= MGRS_SOUTH && view.lat <= MGRS_NORTH)) return out;
  const zone = zoneOf(view.lat, view.lon);
  const edgeLat = Math.max(MGRS_SOUTH, view.lat - 0.8 * half);
  const edgeLon = view.lon - 0.8 * halfLon;
  const southEdge = toUtm(edgeLat, view.lon, zone).northing;
  const westEdge = toUtm(view.lat, edgeLon, zone).easting;
  const seen = new Set();
  for (const line of set.lines) {
    if (line.zone !== zone || seen.has(`${line.axis}:${line.value}`)) continue;
    seen.add(`${line.axis}:${line.value}`);
    const p =
      line.axis === 'e'
        ? fromUtm(line.value, southEdge, zone)
        : fromUtm(westEdge, line.value, zone);
    const at = { lat: p.lat, lon: normalizeLon(p.lon) };
    if (!inView(at)) continue;
    out.push({
      key: `${line.axis}:${line.value}`,
      text: lineDigits(line.value),
      ...at,
      axis: line.axis,
      kind: line.kind,
    });
  }
  const corner = toMgrs(edgeLat, normalizeLon(edgeLon), 100_000);
  if (corner)
    out.push({
      text: corner,
      lat: edgeLat,
      lon: normalizeLon(edgeLon),
      axis: 'square',
      kind: 'square',
    });
  return out;
}

/** Whether a settled view needs new MGRS lines: another level, or moved off. */
export function mgrsLevelChanged(made, now) {
  return (
    !made ||
    mgrsLevelForHeight(made.heightM).id !== mgrsLevelForHeight(now.heightM).id
  );
}
