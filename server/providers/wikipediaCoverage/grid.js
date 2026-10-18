// Personal fork: the Wikipedia coverage grid (server/providers/wikipediaCoverage.js).
// Not part of upstream God's Eye View.
import {
  createPacker,
  openArrayFile,
  readArrayFileHeader,
} from './arrayFile.js';

/**
 * Where English Wikipedia has written about the Earth, as a raster: every
 * primary geotagged article is counted into an equal-angle cell of 0.05°
 * (7200 × 3600 at the base), with the article's wikitext size when the
 * build included it. Coarser levels halve the width and height, summing
 * 2 × 2 blocks, down to 0.8° (450 × 225). Densities are per km², with each
 * row's cell area from the sphere (a cell at 60° N is half the area of one
 * on the equator).
 *
 * The grid is one file, `grid.bin`:
 *
 *   'WGRD'  uint32 header length  <JSON header>  <padding to 8>  <arrays>
 *
 * The header names every level's arrays with their byte offset into the
 * array region, so the server reads only the levels a view needs. Counts
 * are Uint32 and bytes Float32 (sums of a cell's article sizes; exact to
 * 16 M, close enough for a heat map).
 */

export const GRID_MAGIC = 'WGRD';
export const GRID_VERSION = 1;
export const BASE_CELL_DEG = 0.05;
export const BASE_WIDTH = 7200;
export const BASE_HEIGHT = 3600;
/** Levels 0–4: 0.05°, 0.1°, 0.2°, 0.4°, 0.8° (450 × 225 is the last even shape). */
export const LEVELS = 5;
export const TILE_SIZE = 256;
/** The variants a tile can be asked for. */
export const VARIANTS = Object.freeze(['articles', 'text', 'count']);
const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** A level's shape. */
export function levelShape(level) {
  if (!Number.isInteger(level) || level < 0 || level >= LEVELS)
    throw new RangeError(`No level ${level}`);
  return {
    level,
    width: BASE_WIDTH >> level,
    height: BASE_HEIGHT >> level,
    cellDeg: BASE_CELL_DEG * 2 ** level,
  };
}

/**
 * The cell a point falls in at a level: row 0 is the north edge, column 0
 * the antimeridian (180° W). The poles and 180° E fall in the last row and
 * column; anything outside ±90° / ±180° is null.
 */
export function cellOf(lat, lon, level = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const { width, height, cellDeg } = levelShape(level);
  const row = Math.min(height - 1, Math.floor((90 - lat) / cellDeg));
  const col = Math.min(width - 1, Math.floor((lon + 180) / cellDeg));
  return { row: Math.max(0, row), col: Math.max(0, col) };
}

/** The area, in km², of one cell in a row of a level (a spherical quad). */
export function rowAreaKm2(level, row) {
  const { height, cellDeg } = levelShape(level);
  if (!Number.isInteger(row) || row < 0 || row >= height)
    throw new RangeError(`No row ${row} at level ${level}`);
  const top = (90 - row * cellDeg) * RAD;
  const bottom = (90 - (row + 1) * cellDeg) * RAD;
  return (
    EARTH_RADIUS_KM *
    EARTH_RADIUS_KM *
    cellDeg *
    RAD *
    (Math.sin(top) - Math.sin(bottom))
  );
}

/** Every row's cell area at a level, once. */
const areaCache = new Map();
export function rowAreas(level) {
  if (!areaCache.has(level)) {
    const { height } = levelShape(level);
    const areas = new Float64Array(height);
    for (let row = 0; row < height; row++) areas[row] = rowAreaKm2(level, row);
    areaCache.set(level, areas);
  }
  return areaCache.get(level);
}

/**
 * A base-level accumulator: counts, and bytes when the build keeps them.
 * @param {{text?: boolean}} [options]
 */
export function createAccumulator({ text = false } = {}) {
  const cells = BASE_WIDTH * BASE_HEIGHT;
  const counts = new Uint32Array(cells);
  const bytes = text ? new Float64Array(cells) : null;
  return {
    counts,
    bytes,
    /** Count one article at a point; returns its cell index, or -1 outside. */
    add(lat, lon) {
      const cell = cellOf(lat, lon, 0);
      if (!cell) return -1;
      const index = cell.row * BASE_WIDTH + cell.col;
      counts[index] += 1;
      return index;
    },
    /** Add an article's text size to a cell already counted. */
    addBytes(index, size) {
      if (!bytes || !(index >= 0) || !(size > 0)) return;
      bytes[index] += size;
    },
  };
}

/** The 2 × 2 block sums of a level, as the same kind of array. */
export function downsample(array, width, height) {
  if (width % 2 || height % 2)
    throw new RangeError(`Cannot halve ${width} × ${height}`);
  const outWidth = width / 2;
  const outHeight = height / 2;
  const out = new array.constructor(outWidth * outHeight);
  for (let row = 0; row < outHeight; row++) {
    const top = row * 2 * width;
    const bottom = top + width;
    for (let col = 0; col < outWidth; col++) {
      const left = col * 2;
      out[row * outWidth + col] =
        array[top + left] +
        array[top + left + 1] +
        array[bottom + left] +
        array[bottom + left + 1];
    }
  }
  return out;
}

/**
 * Every level from the base arrays: [{level, width, height, counts, bytes}].
 * Bytes become Float32 at every level (Float64 sums are made first).
 */
export function buildPyramid({ counts, bytes = null }) {
  const levels = [];
  let currentCounts = counts;
  let currentBytes = bytes;
  for (let level = 0; level < LEVELS; level++) {
    const { width, height } = levelShape(level);
    if (currentCounts.length !== width * height)
      throw new RangeError(`Level ${level} has ${currentCounts.length} cells`);
    levels.push({
      level,
      width,
      height,
      counts: currentCounts,
      bytes: currentBytes ? Float32Array.from(currentBytes) : null,
    });
    if (level + 1 < LEVELS) {
      currentCounts = downsample(currentCounts, width, height);
      currentBytes = currentBytes
        ? downsample(currentBytes, width, height)
        : null;
    }
  }
  return levels;
}

/** A sorted array's value at a fraction (0 to 1), nearest rank, for the ramp domains. */
export function quantile(sorted, fraction) {
  if (!sorted.length) return 0;
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[at];
}

/**
 * The domain each variant's colour ramp spans, from the base level's
 * non-empty cells: articles and text per km², and raw counts. The ramp is
 * logarithmic, so the floor is a low quantile and the ceiling a high one.
 */
export function variantDomains(base) {
  const areas = rowAreas(0);
  const density = [];
  const textDensity = [];
  const counts = [];
  for (let row = 0; row < base.height; row++) {
    const area = areas[row];
    const start = row * base.width;
    for (let col = 0; col < base.width; col++) {
      const count = base.counts[start + col];
      if (!count) continue;
      counts.push(count);
      density.push(count / area);
      if (base.bytes) {
        const size = base.bytes[start + col];
        if (size > 0) textDensity.push(size / area);
      }
    }
  }
  const ascending = (a, b) => a - b;
  density.sort(ascending);
  textDensity.sort(ascending);
  counts.sort(ascending);
  const domain = (sorted) =>
    sorted.length
      ? {
          min: quantile(sorted, 0.05),
          max: quantile(sorted, 0.995),
          median: quantile(sorted, 0.5),
          cells: sorted.length,
        }
      : null;
  return {
    articles: domain(density),
    text: domain(textDensity),
    count: domain(counts),
  };
}

// --- the file ------------------------------------------------------------------

/**
 * Write the grid file atomically.
 * @param {string} file
 * @param {{header: object, levels: Array<{level: number, width: number,
 *   height: number, counts: Uint32Array, bytes: Float32Array|null}>}} grid
 */
export function writeGrid(file, { header, levels }) {
  const packer = createPacker();
  const levelHeaders = levels.map((level) => ({
    level: level.level,
    width: level.width,
    height: level.height,
    arrays: {
      counts: packer.place(level.counts, 'u32'),
      ...(level.bytes ? { bytes: packer.place(level.bytes, 'f32') } : {}),
    },
  }));
  return packer.write(file, GRID_MAGIC, {
    ...header,
    version: GRID_VERSION,
    cellDeg: BASE_CELL_DEG,
    levels: levelHeaders,
  });
}

/** The header of a grid file, without its arrays. */
export function readGridHeader(file) {
  return readArrayFileHeader(file, GRID_MAGIC, GRID_VERSION);
}

/**
 * Open a grid file: its header, and each level's arrays read when first
 * asked for and kept.
 */
export function openGrid(file) {
  const { header, readArray } = openArrayFile(file, GRID_MAGIC, GRID_VERSION);
  const held = new Map();
  return {
    header,
    hasText: header.levels.every((level) => level.arrays.bytes),
    /** @returns {{level: number, width: number, height: number, counts: Uint32Array, bytes: Float32Array|null}} */
    level(index) {
      if (!held.has(index)) {
        const entry = header.levels.find((level) => level.level === index);
        if (!entry) throw new RangeError(`No level ${index}`);
        held.set(index, {
          level: entry.level,
          width: entry.width,
          height: entry.height,
          counts: readArray(entry.arrays.counts),
          bytes: entry.arrays.bytes ? readArray(entry.arrays.bytes) : null,
        });
      }
      return held.get(index);
    },
    /** Levels read so far (for tests and the status line). */
    loaded: () => [...held.keys()].sort(),
  };
}

// --- tiles ---------------------------------------------------------------------

/** The latitude of a Web Mercator y fraction (0 = north edge, 1 = south). */
export function mercatorLat(fraction) {
  const n = Math.PI - 2 * Math.PI * fraction;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** The level a tile zoom reads: the coarsest whose cells still fit a pixel. */
export function levelForZoom(z, size = TILE_SIZE) {
  const pixelDeg = 360 / (size * 2 ** z);
  let level = 0;
  while (level + 1 < LEVELS && levelShape(level + 1).cellDeg <= pixelDeg)
    level += 1;
  return level;
}

/**
 * The cells whose centres fall in [low, high) along one axis of a level,
 * else the one cell holding the span's middle: [first, last] inclusive.
 * `offset` is the axis origin (90 for rows counting south, -180 for
 * columns counting east); `sign` is -1 for rows, +1 for columns.
 */
function cellSpan(low, high, cellDeg, cells, origin, sign) {
  // Position along the axis in cells, from the origin.
  const at = (value) => (sign * (value - origin)) / cellDeg;
  let a = at(low);
  let b = at(high);
  if (a > b) [a, b] = [b, a];
  let first = Math.ceil(a - 0.5);
  let last = Math.ceil(b - 0.5) - 1;
  if (last < first) first = last = Math.floor((a + b) / 2);
  return [
    Math.min(cells - 1, Math.max(0, first)),
    Math.min(cells - 1, Math.max(0, last)),
  ];
}

/**
 * One Web Mercator tile's values: for each pixel, the articles (or bytes)
 * per km² in the cells under it, or their raw count.
 * @param {{level: Function, hasText: boolean}} grid an opened grid
 * @param {'articles'|'text'|'count'} variant
 * @returns {Float32Array} size × size, row 0 at the north edge
 */
export function tileValues(grid, variant, z, x, y, size = TILE_SIZE) {
  if (!VARIANTS.includes(variant))
    throw new RangeError(`No variant ${variant}`);
  const limit = 2 ** z;
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= limit ||
    y >= limit
  )
    throw new RangeError(`Tile ${z}/${x}/${y} is out of range`);
  const level = grid.level(levelForZoom(z, size));
  const { width, height, counts, bytes } = level;
  const cellDeg = levelShape(level.level).cellDeg;
  if (variant === 'text' && !bytes)
    throw new RangeError('The grid was built without article sizes');
  const areas = rowAreas(level.level);
  const out = new Float32Array(size * size);
  const source = variant === 'text' ? bytes : counts;
  const span = 1 / (size * limit);
  // Column spans are the same for every pixel row.
  const cols = new Array(size);
  for (let i = 0; i < size; i++) {
    const west = -180 + 360 * (x * size + i) * span;
    const east = -180 + 360 * (x * size + i + 1) * span;
    cols[i] = cellSpan(west, east, cellDeg, width, -180, 1);
  }
  for (let j = 0; j < size; j++) {
    const top = mercatorLat((y * size + j) * span);
    const bottom = mercatorLat((y * size + j + 1) * span);
    const [rowFirst, rowLast] = cellSpan(bottom, top, cellDeg, height, 90, -1);
    for (let i = 0; i < size; i++) {
      const [colFirst, colLast] = cols[i];
      let total = 0;
      let area = 0;
      for (let row = rowFirst; row <= rowLast; row++) {
        const start = row * width;
        for (let col = colFirst; col <= colLast; col++)
          total += source[start + col];
        area += areas[row] * (colLast - colFirst + 1);
      }
      out[j * size + i] = variant === 'count' ? total : total / area;
    }
  }
  return out;
}

export const TILE_MAGIC = 'WCT1';

/** A tile's values as the bytes the client reads: magic, width, height, dtype 1 (Float32), values. */
export function encodeTile(values, size = TILE_SIZE) {
  const header = Buffer.alloc(16);
  header.write(TILE_MAGIC, 0, 'latin1');
  header.writeUInt32LE(size, 4);
  header.writeUInt32LE(size, 8);
  header.writeUInt32LE(1, 12);
  return Buffer.concat([
    header,
    Buffer.from(values.buffer, values.byteOffset, values.byteLength),
  ]);
}
