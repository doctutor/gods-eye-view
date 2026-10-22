// Personal fork: the Overture buildings files that `npm run overture:build`
// writes and the server draws from. Not part of upstream God's Eye View.
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Footprints are quantized to a web-mercator grid of 2^28 units a side
 * (0.15 m at the equator) and kept by the z 14 tile of their centre, in
 * bucket files, one per z 6 tile (BUCKET_ZOOM). A bucket file holds, each
 * as a zstd block found through its index:
 *
 * - F: one z 14 tile's buildings. Per building: Uint8 height in metres
 *   (0 unknown), then varints: its polygons, per polygon its rings, per
 *   ring its vertex count and the vertices, the first relative to the
 *   tile's corner and each next one to the last (zigzag), the ring not
 *   closed.
 * - D18: one z 10 tile's density, its 256 × 256 cells (the pixels of a
 *   z 10 tile, 153 m at the equator) that hold a building's centre:
 *   Uint16 cell, then Float32 buildings, built m², Σ height × m² and the
 *   m² whose height is known. Sums, so a coarser cell is the sum of its
 *   four: every mode is the same quantity at every zoom.
 * - D14: the bucket's own 256 × 256 cells (the pixels of its z 6 tile).
 * - D19 (personal fork): one z 11 tile's 256 × 256 cells (76 m at the
 *   equator), the cells the tiles from z 11 sum, so a z 11–14 tile reads
 *   one block instead of every z 14 tile's footprints under it. A bucket
 *   the manifest marks `d19` has them for every z 11 tile with a building.
 *
 *   magic "GEVB", Uint32 version, Uint32 entries, then 24-byte entries:
 *   Uint8 kind, 3 unused, Uint32 key (the tile's x + y × 2^dz within the
 *   bucket), Uint32 offset, Uint32 length, Uint32 raw length, Uint32 count.
 */

export const WORLD_BITS = 28;
export const WORLD_UNITS = 2 ** WORLD_BITS;
export const BLOCK_ZOOM = 14;
export const DENSITY_ZOOM = 10;
export const BUCKET_ZOOM = 6;
/** The D19 blocks' tiles (personal fork). */
export const FINE_DENSITY_ZOOM = 11;
export const KIND = Object.freeze({ F: 1, D18: 2, D14: 3, D19: 4 });
const MAGIC = 0x42564547; // "GEVB"
const VERSION = 1;
const ENTRY_BYTES = 24;
/** Blocks a bucket may hold (an index position fits under it). */
const POSITION = 2 ** 18;
/** A block's key must be under this (the index packs kind and key in one number). */
const KEY_LIMIT = 2 ** 24;
const CELL_BYTES = 18;
const MAX_LATITUDE = 85.05112877980659;
/** Metres per unit at the equator. */
export const UNIT_M = 40075016.686 / WORLD_UNITS;

export const unitX = (lon) =>
  Math.min(
    WORLD_UNITS - 1,
    Math.max(0, Math.floor(((lon + 180) / 360) * WORLD_UNITS)),
  );
export function unitY(lat) {
  const phi =
    (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
  return Math.min(WORLD_UNITS - 1, Math.max(0, Math.floor(y * WORLD_UNITS)));
}
export const latOfUnitY = (y) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD_UNITS))) * 180) / Math.PI;
/** Metres per unit at a unit row (mercator's scale). */
export const metresPerUnit = (y) =>
  UNIT_M * Math.cos((latOfUnitY(y) * Math.PI) / 180);

// ── Varints ─────────────────────────────────────────────────────────────

export class Writer {
  constructor(size = 1 << 16) {
    this.buf = Buffer.alloc(size);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  byte(v) {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }
  varint(v) {
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.pos++] = v;
  }
  zigzag(v) {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
  }
  done() {
    return this.buf.subarray(0, this.pos);
  }
}

function varintAt(buf, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[state.pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return result;
    shift += 7;
  }
}
const unzig = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

// ── Buildings ───────────────────────────────────────────────────────────

/**
 * Encode one building (polygons of rings of [x, y] units, absolute) for
 * the block of the z 14 tile whose corner is (x0, y0).
 */
export function encodeBuilding(writer, { height = 0, polygons }, x0, y0) {
  writer.byte(Math.max(0, Math.min(255, Math.round(height || 0))));
  writer.varint(polygons.length);
  for (const rings of polygons) {
    writer.varint(rings.length);
    for (const ring of rings) {
      writer.varint(ring.length / 2);
      let px = x0;
      let py = y0;
      for (let i = 0; i < ring.length; i += 2) {
        writer.zigzag(ring[i] - px);
        writer.zigzag(ring[i + 1] - py);
        px = ring[i];
        py = ring[i + 1];
      }
    }
  }
}

/**
 * Walk the buildings of an F block (decompressed), calling
 * `visit({height, polygons})` with absolute units.
 */
export function eachBuilding(buf, x0, y0, visit) {
  const state = { pos: 0 };
  while (state.pos < buf.length) {
    const height = buf[state.pos++];
    const polygonCount = varintAt(buf, state);
    const polygons = new Array(polygonCount);
    for (let p = 0; p < polygonCount; p++) {
      const ringCount = varintAt(buf, state);
      const rings = new Array(ringCount);
      for (let r = 0; r < ringCount; r++) {
        const n = varintAt(buf, state);
        const ring = new Float64Array(n * 2);
        let x = x0;
        let y = y0;
        for (let i = 0; i < n; i++) {
          x += unzig(varintAt(buf, state));
          y += unzig(varintAt(buf, state));
          ring[2 * i] = x;
          ring[2 * i + 1] = y;
        }
        rings[r] = ring;
      }
      polygons[p] = rings;
    }
    visit({ height, polygons });
  }
}

/** A ring's signed area in units² (shoelace). */
export function ringArea(ring) {
  let sum = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2)
    sum += (ring[j] + ring[i]) * (ring[i + 1] - ring[j + 1]);
  return sum / 2;
}

/** A building's footprint (outer rings less holes, m²) and centre (units). */
export function buildingSummary({ polygons }) {
  let units = 0;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const rings of polygons) {
    rings.forEach((ring, r) => {
      const a = Math.abs(ringArea(ring));
      units += r === 0 ? a : -a;
      if (r === 0)
        for (let i = 0; i < ring.length; i += 2) {
          cx += ring[i];
          cy += ring[i + 1];
          n += 1;
        }
    });
  }
  cx /= n || 1;
  cy /= n || 1;
  const m = metresPerUnit(cy);
  return { x: cx, y: cy, area: Math.max(0, units) * m * m };
}

// ── Density cells ───────────────────────────────────────────────────────

/** Density cells: a Map of cell index → [buildings, m², Σh·m², known m²]. */
export function addToCells(cells, cell, area, height) {
  let entry = cells.get(cell);
  if (!entry) {
    entry = new Float64Array(4);
    cells.set(cell, entry);
  }
  entry[0] += 1;
  entry[1] += area;
  if (height > 0) {
    entry[2] += height * area;
    entry[3] += area;
  }
}

export function encodeCells(cells) {
  const out = Buffer.alloc(cells.size * CELL_BYTES);
  let at = 0;
  for (const [cell, v] of [...cells].sort((a, b) => a[0] - b[0])) {
    out.writeUInt16LE(cell, at);
    out.writeFloatLE(v[0], at + 2);
    out.writeFloatLE(v[1], at + 6);
    out.writeFloatLE(v[2], at + 10);
    out.writeFloatLE(v[3], at + 14);
    at += CELL_BYTES;
  }
  return out;
}

/** Dense density sums (256 × 256 cells × 4) for one tile, reused. */
export const denseCells = () => new Float64Array(256 * 256 * 4);

export function addToDense(dense, cell, area, height) {
  const at = cell * 4;
  dense[at] += 1;
  dense[at + 1] += area;
  if (height > 0) {
    dense[at + 2] += height * area;
    dense[at + 3] += area;
  }
}

/** A dense tile's non-empty cells as a density block; returns [bytes, cells]. */
export function encodeDense(dense) {
  let cells = 0;
  for (let c = 0; c < 65536; c++) if (dense[c * 4]) cells += 1;
  const out = Buffer.alloc(cells * CELL_BYTES);
  let at = 0;
  for (let c = 0; c < 65536; c++) {
    const i = c * 4;
    if (!dense[i]) continue;
    out.writeUInt16LE(c, at);
    out.writeFloatLE(dense[i], at + 2);
    out.writeFloatLE(dense[i + 1], at + 6);
    out.writeFloatLE(dense[i + 2], at + 10);
    out.writeFloatLE(dense[i + 3], at + 14);
    at += CELL_BYTES;
  }
  return [out, cells];
}

/** Visit the cells of a density block: (cell, buildings, m², Σh·m², known m²). */
export function eachCell(buf, visit) {
  for (let at = 0; at + CELL_BYTES <= buf.length; at += CELL_BYTES)
    visit(
      buf.readUInt16LE(at),
      buf.readFloatLE(at + 2),
      buf.readFloatLE(at + 6),
      buf.readFloatLE(at + 10),
      buf.readFloatLE(at + 14),
    );
}

// ── Bucket files ────────────────────────────────────────────────────────

/**
 * Write a bucket file from its blocks: [{kind, key, raw: Buffer, count}].
 * @returns {number} the file's size
 */
export function writeBucket(file, blocks) {
  const sorted = [...blocks].sort((a, b) => a.kind - b.kind || a.key - b.key);
  const compressed = sorted.map((block) =>
    zlib.zstdCompressSync(block.raw, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 },
    }),
  );
  const head = Buffer.alloc(12 + sorted.length * ENTRY_BYTES);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(sorted.length, 8);
  let offset = head.length;
  sorted.forEach((block, i) => {
    const at = 12 + i * ENTRY_BYTES;
    head.writeUInt8(block.kind, at);
    head.writeUInt32LE(block.key, at + 4);
    head.writeUInt32LE(offset, at + 8);
    head.writeUInt32LE(compressed[i].length, at + 12);
    head.writeUInt32LE(block.raw.length, at + 16);
    head.writeUInt32LE(block.count, at + 20);
    offset += compressed[i].length;
  });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(fd, head);
    for (const body of compressed) fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  return offset;
}

/**
 * Write a bucket file block by block, each compressed and written as it
 * comes, so a dense bucket is never all in memory; the index is written
 * last over the space kept for it.
 * @param {string} file
 * @param {number} blockCount how many blocks will be added (with
 *   `atMost`, the most that may be: the index keeps room for them and
 *   says how many came)
 * @param {{atMost?: boolean}} [options]
 */
export function bucketWriter(file, blockCount, { atMost = false } = {}) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  const head = Buffer.alloc(12 + blockCount * ENTRY_BYTES);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(VERSION, 4);
  head.writeUInt32LE(blockCount, 8);
  let offset = head.length;
  let n = 0;
  return {
    add(kind, key, raw, count) {
      if (n >= blockCount) throw new Error('More blocks than announced');
      if (!(key >= 0 && key < KEY_LIMIT))
        throw new Error(`block key ${key} out of range`);
      const body = zlib.zstdCompressSync(raw, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 },
      });
      fs.writeSync(fd, body, 0, body.length, offset);
      const at = 12 + n * ENTRY_BYTES;
      head.writeUInt8(kind, at);
      head.writeUInt32LE(key, at + 4);
      head.writeUInt32LE(offset, at + 8);
      head.writeUInt32LE(body.length, at + 12);
      head.writeUInt32LE(raw.length, at + 16);
      head.writeUInt32LE(count, at + 20);
      offset += body.length;
      n += 1;
    },
    /** @returns {number} the file's size */
    finish() {
      if (n !== blockCount && !atMost)
        throw new Error(`${n} of ${blockCount} blocks written`);
      head.writeUInt32LE(n, 8);
      fs.writeSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      fs.renameSync(temporary, file);
      return offset;
    },
    abort() {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
      fs.rmSync(temporary, { force: true });
    },
  };
}

/**
 * Open a bucket file: its blocks by kind and key, read on demand. The index
 * stays a buffer, found through one natively sorted Float64Array of
 * (kind × 2^24 + key) × 2^18 + position (under 2^50, exact for every kind
 * byte and key under KEY_LIMIT): a dense bucket has tens of
 * thousands of blocks, and building a Map of them for every open cost more
 * than the tile (2.8 s to open the 191 buckets of a world tile).
 */
export function openBucket(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.readUInt32LE(0) !== MAGIC || head.readUInt32LE(4) !== VERSION)
      throw new Error(`${file} is not a buildings bucket`);
    const count = head.readUInt32LE(8);
    if (count >= POSITION) throw new Error(`${file} has too many blocks`);
    const index = Buffer.alloc(count * ENTRY_BYTES);
    fs.readSync(fd, index, 0, index.length, 12);
    const sorted = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const at = i * ENTRY_BYTES;
      sorted[i] =
        (index.readUInt8(at) * KEY_LIMIT + index.readUInt32LE(at + 4)) *
          POSITION +
        i;
    }
    sorted.sort();
    const entryAt = (i) => {
      const at = i * ENTRY_BYTES;
      return {
        kind: index.readUInt8(at),
        key: index.readUInt32LE(at + 4),
        offset: index.readUInt32LE(at + 8),
        length: index.readUInt32LE(at + 12),
        rawLength: index.readUInt32LE(at + 16),
        count: index.readUInt32LE(at + 20),
      };
    };
    /** The position of a block in the index, or -1. */
    const find = (kind, key) => {
      const want = kind * KEY_LIMIT + key;
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const at = Math.floor(sorted[mid] / POSITION);
        if (at === want) return sorted[mid] - at * POSITION;
        if (at < want) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };
    let entries = null;
    return {
      /** Every block's entry by kind × 2^32 + key (built when first asked). */
      get entries() {
        if (!entries) {
          entries = new Map();
          for (let i = 0; i < count; i++) {
            const entry = entryAt(i);
            entries.set(entry.kind * 2 ** 32 + entry.key, entry);
          }
        }
        return entries;
      },
      has: (kind, key) => find(kind, key) >= 0,
      /** A block's entry (offset, lengths, count), or null. */
      entry(kind, key) {
        const i = find(kind, key);
        return i < 0 ? null : entryAt(i);
      },
      /** A block's bytes, decompressed, or null. */
      block(kind, key) {
        const i = find(kind, key);
        if (i < 0) return null;
        const entry = entryAt(i);
        const body = Buffer.alloc(entry.length);
        fs.readSync(fd, body, 0, entry.length, entry.offset);
        return zlib.zstdDecompressSync(body);
      },
      close: () => fs.closeSync(fd),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
