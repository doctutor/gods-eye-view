// Personal fork: the property index that `npm run property:build` writes
// and /api/property reads (the Property sales layer). Not part of upstream
// God's Eye View.
import { WORLD_BITS, latOfUnitY } from '../overture/buildingsFile.js';

/**
 * Positions are on the buildings' 2^28 web-mercator grid. Buildings (a
 * record or the records collapsed into one: units, or a stack at one
 * point) are kept in bucket files, one per z 10 tile, in the buildings'
 * format (buildingsFile.js bucketWriter/openBucket), each with:
 *
 * - P: one z 14 tile's buildings, PIN_BYTES each (encodePin): position,
 *   where its records are, units, type and a summary of its last sale;
 * - D: one z 16 tile's buildings' records, in the order their pins name
 *   them: per building a varint byte length, a varint record count, then
 *   the records (encodeRecord).
 *
 * The hexagons are another file (hexFile.js).
 */

export const PROPERTY_BUCKET_ZOOM = 10;
export const PIN_ZOOM = 14;
export const DETAIL_ZOOM = 16;
export const PROPERTY_KIND = Object.freeze({ P: 30, D: 31 });
export const PIN_BYTES = 28;
const PIN_SHIFT = WORLD_BITS - PIN_ZOOM;
const DETAIL_SHIFT = WORLD_BITS - DETAIL_ZOOM;
const BUCKET_SHIFT = WORLD_BITS - PROPERTY_BUCKET_ZOOM;
const PIN_SIDE = 2 ** (PIN_ZOOM - PROPERTY_BUCKET_ZOOM);
const DETAIL_SIDE = 2 ** (DETAIL_ZOOM - PROPERTY_BUCKET_ZOOM);

/** A position's bucket key (x + y × 2^10 of its z 10 tile). */
export const bucketOf = (x, y) =>
  (y >>> BUCKET_SHIFT) * 2 ** PROPERTY_BUCKET_ZOOM + (x >>> BUCKET_SHIFT);
/** A position's pins block key inside its bucket. */
export const pinBlockOf = (x, y) =>
  ((y >>> PIN_SHIFT) % PIN_SIDE) * PIN_SIDE + ((x >>> PIN_SHIFT) % PIN_SIDE);
/** A position's records block key inside its bucket. */
export const detailBlockOf = (x, y) =>
  ((y >>> DETAIL_SHIFT) % DETAIL_SIDE) * DETAIL_SIDE +
  ((x >>> DETAIL_SHIFT) % DETAIL_SIDE);
export const lonOfUnitX = (x) => (x / 2 ** WORLD_BITS) * 360 - 180;
export { latOfUnitY };

// ── Varints (exact to 2^53: prices and assessments pass 2^32) ──────────

export class RecordWriter {
  constructor(size = 1 << 12) {
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
  varint(value) {
    let v = Math.max(0, Math.floor(value));
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
  }
  zigzag(v) {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  u32(v) {
    this.ensure(4);
    this.buf.writeUInt32LE(v, this.pos);
    this.pos += 4;
  }
  u16(v) {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.pos);
    this.pos += 2;
  }
  f32(v) {
    this.ensure(4);
    this.buf.writeFloatLE(v, this.pos);
    this.pos += 4;
  }
  f64(v) {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.pos);
    this.pos += 8;
  }
  text(value) {
    const bytes = Buffer.from(String(value ?? ''), 'utf8');
    this.varint(bytes.length);
    this.bytes(bytes);
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

export class RecordReader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  varint() {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      if (b === undefined) throw new RangeError('Record truncated');
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) return result;
      scale *= 0x80;
    }
  }
  zigzag() {
    const v = this.varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }
  text() {
    const length = this.varint();
    const out = this.buf.toString('utf8', this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

// ── Dates: days since 1900-01-01 ───────────────────────────────────────

const DAY_MS = 86_400_000;
const EPOCH_1900 = Date.UTC(1900, 0, 1);

/** 'YYYY-MM-DD' → days since 1900-01-01, or null. */
export function dayOf(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.round((ms - EPOCH_1900) / DAY_MS) : null;
}

/** Days since 1900-01-01 → 'YYYY-MM-DD'. */
export function dateOfDay(day) {
  return new Date(EPOCH_1900 + day * DAY_MS).toISOString().slice(0, 10);
}

// ── Records ────────────────────────────────────────────────────────────

/**
 * One property record's fields, in the order a record holds them. Each
 * present field sets its bit in the record's leading varint.
 */
const FIELDS = Object.freeze([
  ['street', 'text'],
  ['unit', 'text'],
  ['city', 'text'],
  ['state', 'text'],
  ['zip', 'text'],
  ['apn', 'text'],
  ['county', 'text'],
  ['type', 'varint'],
  ['beds', 'varint'],
  ['baths2', 'varint'], // baths × 2
  ['sqft', 'varint'],
  ['lot', 'varint'],
  ['year', 'varint'],
  ['soldPrice', 'varint'],
  ['soldDay', 'varint'],
  ['tax', 'tax'],
  ['sales', 'sales'],
]);

const present = (value) =>
  Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && value !== '';

/**
 * Append one record. `tax`: [{year, amount, assessment}] newest last;
 * `sales`: [{day, price}] oldest first.
 */
export function encodeRecord(writer, record) {
  let mask = 0;
  FIELDS.forEach(([name], bit) => {
    if (present(record[name])) mask += 2 ** bit;
  });
  writer.varint(mask);
  FIELDS.forEach(([name, kind], bit) => {
    if (!(Math.floor(mask / 2 ** bit) % 2)) return;
    const value = record[name];
    if (kind === 'text') writer.text(value);
    else if (kind === 'varint') writer.varint(value);
    else if (kind === 'tax') {
      writer.varint(value.length);
      let year = 0;
      let amount = 0;
      let assessment = 0;
      for (const entry of value) {
        writer.zigzag(entry.year - year);
        writer.zigzag((entry.amount ?? -1) - amount);
        writer.zigzag((entry.assessment ?? -1) - assessment);
        year = entry.year;
        amount = entry.amount ?? -1;
        assessment = entry.assessment ?? -1;
      }
    } else {
      writer.varint(value.length);
      let day = 0;
      for (const entry of value) {
        writer.zigzag(entry.day - day);
        writer.varint(entry.price);
        day = entry.day;
      }
    }
  });
}

/** Read one record (the fields it has) at the reader's position. */
export function decodeRecord(reader) {
  const mask = reader.varint();
  const out = {};
  FIELDS.forEach(([name, kind], bit) => {
    if (!(Math.floor(mask / 2 ** bit) % 2)) return;
    if (kind === 'text') out[name] = reader.text();
    else if (kind === 'varint') out[name] = reader.varint();
    else if (kind === 'tax') {
      const n = reader.varint();
      const list = [];
      let year = 0;
      let amount = 0;
      let assessment = 0;
      for (let i = 0; i < n; i++) {
        year += reader.zigzag();
        amount += reader.zigzag();
        assessment += reader.zigzag();
        list.push({
          year,
          amount: amount < 0 ? null : amount,
          assessment: assessment < 0 ? null : assessment,
        });
      }
      out.tax = list;
    } else {
      const n = reader.varint();
      const list = [];
      let day = 0;
      for (let i = 0; i < n; i++) {
        day += reader.zigzag();
        list.push({ day, price: reader.varint() });
      }
      out.sales = list;
    }
  });
  return out;
}

// ── Pins ───────────────────────────────────────────────────────────────

/** Months since 1900-01 for a day count (0: no sale). */
export const monthOfDay = (day) => {
  if (!(day >= 0)) return 0;
  const date = new Date(EPOCH_1900 + day * DAY_MS);
  return (date.getUTCFullYear() - 1900) * 12 + date.getUTCMonth() + 1;
};
/** 'YYYY-MM' for a month count, or ''. */
export const monthText = (month) =>
  month > 0
    ? `${1900 + Math.floor((month - 1) / 12)}-${String(((month - 1) % 12) + 1).padStart(2, '0')}`
    : '';

/**
 * A building's pin: Uint32 x, y; Uint32 its place in its records block;
 * Uint16 records (units); Uint8 type; Uint8 flags (1: a sale since
 * PRICE_SINCE_YEAR at or above the floor); Uint32 last sale price; Uint16
 * its month (monthOfDay); Uint16 year built; Uint32 the sold record's sqft.
 */
export function encodePin(buf, at, pin) {
  buf.writeUInt32LE(pin.x, at);
  buf.writeUInt32LE(pin.y, at + 4);
  buf.writeUInt32LE(pin.index, at + 8);
  buf.writeUInt16LE(Math.min(65535, pin.units), at + 12);
  buf.writeUInt8(pin.type || 0, at + 14);
  buf.writeUInt8(pin.flags || 0, at + 15);
  buf.writeUInt32LE(Math.min(4294967295, pin.price || 0), at + 16);
  buf.writeUInt16LE(Math.min(65535, pin.month || 0), at + 20);
  buf.writeUInt16LE(pin.year || 0, at + 22);
  buf.writeUInt32LE(Math.min(4294967295, pin.sqft || 0), at + 24);
}

export function decodePin(buf, at) {
  return {
    x: buf.readUInt32LE(at),
    y: buf.readUInt32LE(at + 4),
    index: buf.readUInt32LE(at + 8),
    units: buf.readUInt16LE(at + 12),
    type: buf.readUInt8(at + 14),
    flags: buf.readUInt8(at + 15),
    price: buf.readUInt32LE(at + 16),
    month: buf.readUInt16LE(at + 20),
    year: buf.readUInt16LE(at + 22),
    sqft: buf.readUInt32LE(at + 24),
  };
}

/** Walk a D block's buildings: visit(index, records) until it returns true. */
export function eachBuildingRecords(buf, visit, { want = null } = {}) {
  const reader = new RecordReader(buf);
  for (let index = 0; reader.pos < buf.length; index++) {
    const length = reader.varint();
    const end = reader.pos + length;
    if (want !== null && index !== want) {
      reader.pos = end;
      continue;
    }
    const count = reader.varint();
    const records = [];
    for (let i = 0; i < count; i++) records.push(decodeRecord(reader));
    reader.pos = end;
    if (visit(index, records)) return;
  }
}
