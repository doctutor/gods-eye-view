// Personal fork: the Overture places index that `npm run overture:build --
// --places` writes and the server reads. Not part of upstream God's Eye
// View.
import { Writer, WORLD_UNITS, latOfUnitY } from './buildingsFile.js';
import { CATEGORY_SLOTS } from '../../../src/data/overturePlaces.js';

/**
 * Places are kept in bucket files (one per z 6 tile, the buildings' file
 * format: buildingsFile.js bucketWriter/openBucket), each with:
 *
 * - P: one z 12 tile's places, the most confident first, 12 bytes each:
 *   Uint32 x and y on the 2^28 web-mercator grid, Uint8 confidence × 250,
 *   Uint8 category code, Uint16 unused;
 * - T: the same places' text, in the same order: per place a varint
 *   length and UTF-8 "name\0basic category\0website\0phone\0brand\0source";
 * - H<res>: the bucket's places counted per H3 cell of a resolution
 *   (H3..H7 here, H0..H5 summed into the global counts file), per cell:
 *   its index (two Uint32), its centre (two Float32), then a varint of
 *   non-zero slots and per slot a byte (category + 12 × threshold) and a
 *   varint count. A cell on a bucket's edge is counted in each; the
 *   answers add them up.
 */

export const PLACE_KIND = Object.freeze({ P: 10, T: 11, H: 20 });
export const PLACE_BLOCK_ZOOM = 12;
export const PLACE_BUCKET_ZOOM = 6;
export const PLACE_RECORD_BYTES = 12;
/** Resolutions kept per bucket; the coarser ones go to the global file. */
export const BUCKET_RESOLUTIONS = Object.freeze([6, 7]);
export const GLOBAL_RESOLUTIONS = Object.freeze([0, 1, 2, 3, 4, 5]);

export const TEXT_FIELDS = Object.freeze([
  'name',
  'basic',
  'website',
  'phone',
  'brand',
  'source',
]);

export function encodeRecord(buf, at, { x, y, confidence, category }) {
  buf.writeUInt32LE(x, at);
  buf.writeUInt32LE(y, at + 4);
  buf.writeUInt8(
    Math.max(0, Math.min(250, Math.round(confidence * 250))),
    at + 8,
  );
  buf.writeUInt8(category, at + 9);
}

export function decodeRecord(buf, at) {
  return {
    x: buf.readUInt32LE(at),
    y: buf.readUInt32LE(at + 4),
    confidence: buf.readUInt8(at + 8) / 250,
    category: buf.readUInt8(at + 9),
  };
}

export const lonOfUnitX = (x) => (x / WORLD_UNITS) * 360 - 180;
export { latOfUnitY };

/** The text block's strings, in order: each an object of TEXT_FIELDS. */
export function decodeTexts(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let length = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      length += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const parts = buf.toString('utf8', pos, pos + length).split('\0');
    pos += length;
    out.push(
      Object.fromEntries(
        TEXT_FIELDS.map((field, i) => [field, parts[i] || '']),
      ),
    );
  }
  return out;
}

/** Append one place's text to a writer. */
export function encodeText(writer, text) {
  const body = Buffer.from(
    TEXT_FIELDS.map((field) =>
      String(text[field] || '').replace(/\0/g, ''),
    ).join('\0'),
    'utf8',
  );
  writer.varint(body.length);
  writer.bytes(body);
}

// ── H3 count tables ─────────────────────────────────────────────────────

/** A count vector's slot: category code plus 12 per threshold index. */
export const slotOf = (category, threshold) =>
  category + CATEGORY_SLOTS * threshold;

/**
 * Encode cells: Map of H3 index (hex string) → {lat, lon, counts:
 * Uint32Array(CATEGORY_SLOTS × thresholds)}.
 */
export function encodeCounts(cells) {
  const writer = new Writer(cells.size * 16 + 64);
  for (const [cell, { lat, lon, counts }] of cells) {
    const hi = parseInt(cell.slice(0, cell.length - 8) || '0', 16);
    const lo = parseInt(cell.slice(-8), 16);
    const head = Buffer.alloc(16);
    head.writeUInt32LE(hi, 0);
    head.writeUInt32LE(lo, 4);
    head.writeFloatLE(lat, 8);
    head.writeFloatLE(lon, 12);
    writer.bytes(head);
    let nonzero = 0;
    for (const v of counts) if (v) nonzero += 1;
    writer.varint(nonzero);
    counts.forEach((v, slot) => {
      if (!v) return;
      writer.byte(slot);
      writer.varint(v);
    });
  }
  return writer.done();
}

/** Visit a count table's cells: (cell, lat, lon, counts Map slot → count). */
export function eachCountCell(buf, visit) {
  let pos = 0;
  while (pos < buf.length) {
    const hi = buf.readUInt32LE(pos);
    const lo = buf.readUInt32LE(pos + 4);
    const lat = buf.readFloatLE(pos + 8);
    const lon = buf.readFloatLE(pos + 12);
    pos += 16;
    const varint = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const b = buf[pos++];
        result += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80)) return result;
        shift += 7;
      }
    };
    const n = varint();
    const counts = new Map();
    for (let i = 0; i < n; i++) {
      const slot = buf[pos++];
      counts.set(slot, varint());
    }
    const cell = hi.toString(16) + lo.toString(16).padStart(8, '0');
    visit(cell, lat, lon, counts);
  }
}

/** A cell's count for a category code (0: all) and threshold index. */
export function countFor(counts, category, threshold) {
  if (category) return counts.get(slotOf(category, threshold)) || 0;
  let sum = 0;
  for (let c = 1; c < CATEGORY_SLOTS; c++)
    sum += counts.get(slotOf(c, threshold)) || 0;
  return sum;
}
