import {
  readColumnChunk,
  rowsOfFlat,
  rowsOfNested,
  rowsOfRepeated,
} from './parquet.mjs';
import {
  blocksPerContainer,
  blockSide,
  containerKey,
  encodeRoadBlock,
} from '../../server/providers/overture/roadsFile.js';
import {
  ROAD_FLAGS,
  ROAD_LEVELS,
  ROAD_PIECE_SHARE,
  ROAD_SUBCLASSES,
  ROAD_SURFACES,
  KMH_PER_MPH,
  roadClassByKey,
  segmentMinZoom,
} from '../../src/data/overtureRoads.js';

/**
 * The first half of the Overture roads step: one fetched row group of
 * transportation segments → one part (buildingsParts.mjs writePart), each
 * road segment whose middle is in the region (and in no region done before
 * it) put into every level that draws its class (ROAD_LEVELS): its line on
 * the level's grid, simplified to half a pixel at the level's last zoom,
 * cut into pieces no longer than a quarter of a block, each piece in the
 * block holding its ends' middle. Rail and water segments are left out.
 *
 * Attributes: the class; the flags (bridge, tunnel, link, under
 * construction from road_flags; link also from the subclass; bicycles
 * designated, allowed or denied from the access restrictions whose modes
 * name bicycles); the first road_surface; the highest max speed of the
 * speed limits (conditional ones are lower: trucks, school hours), in its
 * unit; the subclass; TomTom when a source says so, else OpenStreetMap;
 * the primary name.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const text = (v) => (v == null ? '' : Buffer.from(v).toString('utf8'));
const SUBCLASS = new Map(ROAD_SUBCLASSES.map((key, code) => [key, code]));
const SURFACE = new Map(ROAD_SURFACES.map((key, code) => [key, code]));
const FLAG_OF = {
  is_bridge: ROAD_FLAGS.bridge,
  is_tunnel: ROAD_FLAGS.tunnel,
  is_link: ROAD_FLAGS.link,
  is_under_construction: ROAD_FLAGS.construction,
};
const MAX_LATITUDE = 85.05112877980659;

/** A WKB LineString's points as Web Mercator fractions [x0, y0, …] (0 to 1), or null. */
export function wkbLine(wkb) {
  if (!wkb || wkb.length < 9) return null;
  const little = wkb[0] === 1;
  const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
  if (type !== 2) return null;
  const n = little ? wkb.readUInt32LE(5) : wkb.readUInt32BE(5);
  if (n < 2 || wkb.length < 9 + n * 16) return null;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const at = 9 + i * 16;
    const lon = little ? wkb.readDoubleLE(at) : wkb.readDoubleBE(at);
    const lat = little ? wkb.readDoubleLE(at + 8) : wkb.readDoubleBE(at + 8);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const phi =
      (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180;
    out[i * 2] = Math.min(1, Math.max(0, (lon + 180) / 360));
    out[i * 2 + 1] = Math.min(
      1,
      Math.max(
        0,
        0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI),
      ),
    );
  }
  return out;
}

/** Douglas-Peucker on [x, y, …] (integers), keeping points further than `tolerance`. */
export function simplify(points, tolerance) {
  const n = points.length / 2;
  if (n <= 2) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = points[a * 2];
    const ay = points[a * 2 + 1];
    const dx = points[b * 2] - ax;
    const dy = points[b * 2 + 1] - ay;
    const length2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2] - ax;
      const py = points[i * 2 + 1] - ay;
      let d2;
      if (length2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / length2));
        const ex = px - t * dx;
        const ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worst) {
        worst = d2;
        at = i;
      }
    }
    if (worst > t2) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++)
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/**
 * A line (Mercator fractions) on a level: on its grid, without repeated
 * points, simplified, and cut into pieces no longer than `maxLength`
 * units. [] when it falls on one grid point.
 */
export function levelPieces(line, bits, tolerance, maxLength) {
  const scale = 2 ** bits;
  const grid = [];
  for (let i = 0; i < line.length; i += 2) {
    const x = Math.min(scale - 1, Math.floor(line[i] * scale));
    const y = Math.min(scale - 1, Math.floor(line[i + 1] * scale));
    const n = grid.length;
    if (n && grid[n - 2] === x && grid[n - 1] === y) continue;
    grid.push(x, y);
  }
  if (grid.length < 4) return [];
  const points = simplify(grid, tolerance);
  const pieces = [];
  let piece = [points[0], points[1]];
  let length = 0;
  for (let i = 2; i < points.length; i += 2) {
    let x0 = piece[piece.length - 2];
    let y0 = piece[piece.length - 1];
    const x1 = points[i];
    const y1 = points[i + 1];
    let edge = Math.hypot(x1 - x0, y1 - y0);
    // An edge that would carry the piece past maxLength is cut where it does.
    while (length + edge > maxLength) {
      const t = (maxLength - length) / edge;
      const cx = Math.round(x0 + (x1 - x0) * t);
      const cy = Math.round(y0 + (y1 - y0) * t);
      if (cx === x0 && cy === y0) break;
      piece.push(cx, cy);
      pieces.push(piece);
      piece = [cx, cy];
      length = 0;
      x0 = cx;
      y0 = cy;
      edge = Math.hypot(x1 - x0, y1 - y0);
    }
    piece.push(x1, y1);
    length += edge;
  }
  if (piece.length >= 4) pieces.push(piece);
  return pieces;
}

/** Add a segment to a part's buckets: container key → local block → its list. */
function addToBlock(buckets, level, bx, by, segment) {
  const { container, block } = ROAD_LEVELS[level];
  const per = blocksPerContainer(level);
  const shift = 2 ** (block - container);
  const cx = Math.floor(bx / shift);
  const cy = Math.floor(by / shift);
  const key = containerKey(level, cx, cy);
  let blocks = buckets.get(key);
  if (!blocks) buckets.set(key, (blocks = new Map()));
  const local = (by - cy * per) * per + (bx - cx * per);
  let entry = blocks.get(local);
  if (!entry) {
    const side = blockSide(level);
    const list = [];
    entry = { list, done: () => encodeRoadBlock(list, bx * side, by * side) };
    blocks.set(local, entry);
  }
  entry.list.push(segment);
}

/**
 * Put a road (its line as Web Mercator fractions, its attributes: code,
 * flags, surface, speed, subclass, source, name) into every level that
 * draws it, as that level's pieces, each in the block holding its ends'
 * middle (no point of a piece is further from it than half the piece's
 * length: ROAD_BLOCK_MARGIN). Returns the pieces added.
 */
export function placeRoad(buckets, line, attributes) {
  const minZoom = segmentMinZoom(attributes.code, attributes.flags);
  let pieces = 0;
  for (const level of ROAD_LEVELS) {
    if (minZoom > level.to) continue;
    const side = blockSide(level.index);
    const tolerance = 2 ** (level.bits - level.to - 8) / 2;
    for (const points of levelPieces(
      line,
      level.bits,
      tolerance,
      side * ROAD_PIECE_SHARE,
    )) {
      const bx = Math.floor((points[0] + points[points.length - 2]) / 2 / side);
      const by = Math.floor((points[1] + points[points.length - 1]) / 2 / side);
      addToBlock(buckets, level.index, bx, by, { ...attributes, points });
      pieces += 1;
    }
  }
  return pieces;
}

const inBox = (lon, lat, [west, south, east, north]) =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/**
 * Decode a fetched row group (buildingsPlan.mjs readRowGroupFile) into a
 * part's buckets (container key → local block → writer) and its stats.
 */
export function decodeRoadsRowGroup(group, footer, { region, earlier = [] }) {
  const meta = footer.rowGroups[group.header.group];
  const column = (p) => {
    const chunk = meta.columns.find((c) => c.path === p);
    const leaf = footer.leaves.find((l) => l.path === p);
    if (!chunk || !leaf) throw new Error(`no column ${p}`);
    return { raw: readColumnChunk(group.chunk(p), chunk, leaf), leaf };
  };
  const flat = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfFlat(raw, leaf);
  };
  const list = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfRepeated(raw, leaf);
  };
  const nested = (p) => {
    const { raw, leaf } = column(p);
    return rowsOfNested(raw, leaf);
  };
  const subtype = flat('subtype');
  const rows = subtype.length;
  const columns = {
    geometry: flat('geometry'),
    klass: flat('class'),
    subclass: flat('subclass'),
    name: flat('names.primary'),
    surface: list('road_surface.list.element.value'),
    flags: nested('road_flags.list.element.values.list.element'),
    speed: list('speed_limits.list.element.max_speed.value'),
    speedUnit: list('speed_limits.list.element.max_speed.unit'),
    access: list('access_restrictions.list.element.access_type'),
    accessModes: nested(
      'access_restrictions.list.element.when.mode.list.element',
    ),
    datasets: list('sources.list.element.dataset'),
  };
  for (const [key, values] of Object.entries(columns))
    if (values.length !== rows)
      throw new Error(
        `${group.header.file} row group ${group.header.group}: ${key} has ${values.length} of ${rows} rows`,
      );
  const stats = {
    read: rows,
    kept: 0,
    pieces: 0,
    named: 0,
    withSpeed: 0,
    withSurface: 0,
    bikeDesignated: 0,
    skipped: 0,
    byClass: {},
    byDataset: {},
  };
  const buckets = new Map();
  for (let i = 0; i < rows; i++) {
    if (text(subtype[i]) !== 'road') continue;
    const className = text(columns.klass[i]);
    const entry = roadClassByKey(className);
    if (!entry) {
      stats.skipped += 1;
      continue;
    }
    const line = wkbLine(columns.geometry[i]);
    if (!line) {
      stats.skipped += 1;
      continue;
    }
    // In the region by the line's middle point (as a road's pieces stay
    // with it, a road crossing a region's edge is taken once).
    const mid = Math.floor(line.length / 4) * 2;
    const lon = line[mid] * 360 - 180;
    const lat =
      (Math.atan(Math.sinh(Math.PI * (1 - 2 * line[mid + 1]))) * 180) / Math.PI;
    if (!inBox(lon, lat, region) || earlier.some((box) => inBox(lon, lat, box)))
      continue;
    let flags = 0;
    for (const values of columns.flags[i])
      for (const value of values) flags |= FLAG_OF[text(value)] || 0;
    const subclassCode = SUBCLASS.get(text(columns.subclass[i])) || 0;
    if (subclassCode === 1) flags |= ROAD_FLAGS.link;
    // Bicycles: each access restriction's type with its own modes.
    const types = columns.access[i];
    const modes = columns.accessModes[i];
    if (modes.length === types.length)
      types.forEach((type, k) => {
        if (!modes[k].some((m) => text(m) === 'bicycle')) return;
        const kind = text(type);
        if (kind === 'designated') flags |= ROAD_FLAGS.bikeDesignated;
        else if (kind === 'allowed') flags |= ROAD_FLAGS.bikeAllowed;
        else if (kind === 'denied') flags |= ROAD_FLAGS.bikeDenied;
      });
    if (entry.key === 'cycleway') flags |= ROAD_FLAGS.bikeDesignated;
    if (flags & (ROAD_FLAGS.bikeDesignated | ROAD_FLAGS.bikeAllowed))
      flags &= ~ROAD_FLAGS.bikeDenied;
    // The highest speed limit, in its own unit.
    let speed = 0;
    let best = 0;
    columns.speed[i].forEach((value, k) => {
      const v = Number(value);
      if (!(v > 0)) return;
      const mph = text(columns.speedUnit[i][k]) === 'mph';
      const kmh = mph ? v * KMH_PER_MPH : v;
      if (kmh > best) {
        best = kmh;
        speed = Math.min(255, Math.round(v));
        flags = mph ? flags | ROAD_FLAGS.mph : flags & ~ROAD_FLAGS.mph;
      }
    });
    const surface = SURFACE.get(text(columns.surface[i][0])) || 0;
    const datasets = columns.datasets[i].map(text);
    const source = datasets.some((d) => /tomtom/i.test(d))
      ? 1
      : datasets.some((d) => /openstreetmap/i.test(d)) || !datasets.length
        ? 0
        : 2;
    const name = text(columns.name[i]).trim().slice(0, 100);
    stats.kept += 1;
    if (name) stats.named += 1;
    if (speed) stats.withSpeed += 1;
    if (surface) stats.withSurface += 1;
    if (flags & ROAD_FLAGS.bikeDesignated) stats.bikeDesignated += 1;
    stats.byClass[className] = (stats.byClass[className] || 0) + 1;
    for (const d of new Set(datasets))
      stats.byDataset[d] = (stats.byDataset[d] || 0) + 1;
    stats.pieces += placeRoad(buckets, line, {
      code: entry.code,
      flags,
      surface,
      speed,
      subclass: subclassCode,
      source,
      name,
    });
  }
  return { buckets, stats };
}
