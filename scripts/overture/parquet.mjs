import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * A small Parquet reader for `npm run overture:build`: enough of the format
 * to read Overture's divisions file (Thrift compact footer and page
 * headers; PLAIN, dictionary, RLE/bit-packed and DELTA encodings; data
 * pages v1 and v2; ZSTD, Snappy, gzip or no compression; nested columns
 * through their definition and repetition levels). No dependency: zstd is
 * in Node's zlib (22.15+).
 *
 * Read from a local file through `openParquet(path)`; columns come out as
 * flat arrays of leaf values with their levels, which `assemble*` helpers
 * turn into per-row values.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

// ── Thrift compact protocol ─────────────────────────────────────────────

class ThriftReader {
  constructor(buffer, offset = 0) {
    this.buf = buffer;
    this.pos = offset;
  }
  byte() {
    return this.buf[this.pos++];
  }
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  zigzag() {
    const v = this.varint();
    return Number((v >> 1n) ^ -(v & 1n));
  }
  binary() {
    const length = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
  value(type) {
    switch (type) {
      case 1:
        return true;
      case 2:
        return false;
      case 3:
        return (this.byte() << 24) >> 24;
      case 4:
      case 5:
      case 6:
        return this.zigzag();
      case 7: {
        const v = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
      }
      case 8:
        return this.binary();
      case 9:
      case 10:
        return this.list();
      case 11:
        return this.map();
      case 12:
        return this.struct();
      default:
        throw new Error(`Parquet: unknown Thrift type ${type}`);
    }
  }
  list() {
    const header = this.byte();
    let size = header >> 4;
    const type = header & 0x0f;
    if (size === 15) size = Number(this.varint());
    const out = [];
    for (let i = 0; i < size; i++)
      out.push(type === 1 || type === 2 ? this.byte() === 1 : this.value(type));
    return out;
  }
  map() {
    const size = Number(this.varint());
    const out = [];
    if (!size) return out;
    const types = this.byte();
    for (let i = 0; i < size; i++)
      out.push([this.value(types >> 4), this.value(types & 0x0f)]);
    return out;
  }
  /** A struct as {fieldId: value}. */
  struct() {
    const out = {};
    let last = 0;
    for (;;) {
      const header = this.byte();
      if (header === 0) return out;
      const delta = header >> 4;
      const type = header & 0x0f;
      const id = delta ? last + delta : this.zigzag();
      last = id;
      out[id] = this.value(type);
    }
  }
}

const text = (bytes) => (bytes ? Buffer.from(bytes).toString('utf8') : '');

// ── Footer ──────────────────────────────────────────────────────────────

const TYPES = [
  'BOOLEAN',
  'INT32',
  'INT64',
  'INT96',
  'FLOAT',
  'DOUBLE',
  'BYTE_ARRAY',
  'FIXED_LEN_BYTE_ARRAY',
];
const CODECS = [
  'UNCOMPRESSED',
  'SNAPPY',
  'GZIP',
  'LZO',
  'BROTLI',
  'LZ4',
  'ZSTD',
  'LZ4_RAW',
];

/**
 * The schema as leaf columns: each with its dotted path, physical type,
 * and the maximum definition and repetition levels along the way;
 * `repeatedDefs` the definition level at which each repeated ancestor's
 * element exists (outermost first).
 */
function leavesOf(elements) {
  const leaves = [];
  let index = 1; // 0 is the root
  function walk(path, maxDef, maxRep, repeatedDefs = []) {
    const element = elements[index++];
    const name = text(element[4]);
    const repetition = element[3] ?? 0; // 0 REQUIRED, 1 OPTIONAL, 2 REPEATED
    const def = maxDef + (repetition === 0 ? 0 : 1);
    const rep = maxRep + (repetition === 2 ? 1 : 0);
    const here = [...path, name];
    const repeated = repetition === 2 ? [...repeatedDefs, def] : repeatedDefs;
    const children = element[5] || 0;
    if (!children) {
      leaves.push({
        path: here.join('.'),
        type: TYPES[element[1]],
        typeLength: element[2] || 0,
        maxDef: def,
        maxRep: rep,
        repeatedDefs: repeated,
      });
      return;
    }
    for (let i = 0; i < children; i++) walk(here, def, rep, repeated);
  }
  const rootChildren = elements[0][5] || 0;
  for (let i = 0; i < rootChildren; i++) walk([], 0, 0);
  return leaves;
}

/** Parse the footer bytes (without the length and magic). */
export function parseFooter(bytes) {
  const meta = new ThriftReader(bytes).struct();
  const leaves = leavesOf(meta[2]);
  const rowGroups = (meta[4] || []).map((group) => ({
    rows: Number(group[3]),
    columns: group[1].map((chunk) => {
      const m = chunk[3];
      const stats = m[12] || {};
      return {
        path: m[3].map(text).join('.'),
        type: TYPES[m[1]],
        codec: CODECS[m[4]],
        values: Number(m[5]),
        compressedSize: Number(m[7]),
        start: Number(m[11] ?? m[9]),
        min: stats[6] ?? stats[2] ?? null,
        max: stats[5] ?? stats[1] ?? null,
      };
    }),
  }));
  return {
    rows: Number(meta[3]),
    leaves,
    rowGroups,
    createdBy: text(meta[6]),
    keyValues: Object.fromEntries(
      (meta[5] || []).map((kv) => [text(kv[1]), text(kv[2])]),
    ),
  };
}

/** The footer of a Parquet file whose last bytes `tail` holds. */
export function footerFromTail(tail) {
  if (text(tail.subarray(tail.length - 4)) !== 'PAR1')
    throw new Error('Parquet: no PAR1 magic at the end');
  const length = tail.readUInt32LE(tail.length - 8);
  if (length + 8 > tail.length) return { need: length + 8 };
  return parseFooter(tail.subarray(tail.length - 8 - length, tail.length - 8));
}

// ── Pages ───────────────────────────────────────────────────────────────

function decompress(codec, bytes, size) {
  switch (codec) {
    case 'UNCOMPRESSED':
      return bytes;
    case 'ZSTD':
      return zlib.zstdDecompressSync(bytes);
    case 'GZIP':
      return zlib.gunzipSync(bytes);
    case 'SNAPPY':
      return snappy(bytes, size);
    default:
      throw new Error(`Parquet: codec ${codec} is not supported`);
  }
}

/** Raw Snappy (no framing). */
function snappy(input, expected) {
  let pos = 0;
  let length = 0;
  let shift = 0;
  for (;;) {
    const b = input[pos++];
    length |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  const out = Buffer.alloc(length || expected);
  let o = 0;
  while (pos < input.length) {
    const tag = input[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      let len = tag >> 2;
      if (len >= 60) {
        const bytes = len - 59;
        len = 0;
        for (let i = 0; i < bytes; i++) len |= input[pos++] << (8 * i);
      }
      len += 1;
      input.copy(out, o, pos, pos + len);
      pos += len;
      o += len;
      continue;
    }
    let len;
    let offset;
    if (kind === 1) {
      len = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | input[pos++];
    } else if (kind === 2) {
      len = (tag >> 2) + 1;
      offset = input[pos] | (input[pos + 1] << 8);
      pos += 2;
    } else {
      len = (tag >> 2) + 1;
      offset = input.readUInt32LE(pos);
      pos += 4;
    }
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset];
  }
  return out;
}

const bitWidth = (max) => (max ? 32 - Math.clz32(max) : 0);

/** RLE/bit-packed hybrid values (levels, dictionary indices). */
function readHybrid(buf, pos, end, width, count, out) {
  let n = 0;
  const bytesPerValue = Math.ceil(width / 8);
  while (n < count && pos < end) {
    let header = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      header += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    if (header & 1) {
      const groups = Math.floor(header / 2);
      const total = groups * 8;
      let bitPos = pos * 8;
      for (let i = 0; i < total; i++) {
        let value = 0;
        for (let b = 0; b < width; b++) {
          const bit = bitPos + b;
          if (buf[bit >> 3] & (1 << (bit & 7))) value |= 1 << b;
        }
        bitPos += width;
        if (n < count) out[n++] = value >>> 0;
      }
      pos += groups * width;
    } else {
      const run = Math.floor(header / 2);
      let value = 0;
      for (let b = 0; b < bytesPerValue; b++) value |= buf[pos + b] << (8 * b);
      pos += bytesPerValue;
      for (let i = 0; i < run && n < count; i++) out[n++] = value >>> 0;
    }
  }
  return pos;
}

function readUleb(buf, state) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    const b = buf[state.pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return result;
    shift += 7n;
  }
}

/** DELTA_BINARY_PACKED: integers (as Numbers). */
function readDeltaBinary(buf, state, count) {
  const blockSize = Number(readUleb(buf, state));
  const miniblocks = Number(readUleb(buf, state));
  const total = Number(readUleb(buf, state));
  const zz = readUleb(buf, state);
  let value = (zz >> 1n) ^ -(zz & 1n);
  const out = [];
  if (total > 0) out.push(Number(value));
  const perMini = blockSize / miniblocks;
  while (out.length < total) {
    const zm = readUleb(buf, state);
    const minDelta = (zm >> 1n) ^ -(zm & 1n);
    const widths = buf.subarray(state.pos, state.pos + miniblocks);
    state.pos += miniblocks;
    for (let m = 0; m < miniblocks; m++) {
      const width = widths[m];
      if (out.length >= total) {
        // The remaining miniblocks of the block are not written.
        break;
      }
      let bitPos = state.pos * 8;
      for (let i = 0; i < perMini; i++) {
        let delta = 0n;
        for (let b = 0; b < width; b++) {
          const bit = bitPos + b;
          if (buf[bit >> 3] & (1 << (bit & 7))) delta |= 1n << BigInt(b);
        }
        bitPos += width;
        value += minDelta + delta;
        if (out.length < total) out.push(Number(value));
      }
      state.pos += (perMini * width) / 8;
    }
  }
  return out.slice(0, count ?? total);
}

function readPlain(buf, type, count, typeLength) {
  const out = new Array(count);
  let pos = 0;
  switch (type) {
    case 'BOOLEAN':
      for (let i = 0; i < count; i++)
        out[i] = Boolean(buf[i >> 3] & (1 << (i & 7)));
      return out;
    case 'INT32':
      for (let i = 0; i < count; i++) out[i] = buf.readInt32LE(i * 4);
      return out;
    case 'INT64':
      for (let i = 0; i < count; i++)
        out[i] = Number(buf.readBigInt64LE(i * 8));
      return out;
    case 'FLOAT':
      for (let i = 0; i < count; i++) out[i] = buf.readFloatLE(i * 4);
      return out;
    case 'DOUBLE':
      for (let i = 0; i < count; i++) out[i] = buf.readDoubleLE(i * 8);
      return out;
    case 'BYTE_ARRAY':
      for (let i = 0; i < count; i++) {
        const length = buf.readUInt32LE(pos);
        out[i] = buf.subarray(pos + 4, pos + 4 + length);
        pos += 4 + length;
      }
      return out;
    case 'FIXED_LEN_BYTE_ARRAY':
      for (let i = 0; i < count; i++)
        out[i] = buf.subarray(i * typeLength, (i + 1) * typeLength);
      return out;
    default:
      throw new Error(`Parquet: type ${type} is not supported`);
  }
}

function readValues(buf, encoding, leaf, count, dictionary) {
  if (encoding === 0) return readPlain(buf, leaf.type, count, leaf.typeLength);
  if (encoding === 2 || encoding === 8) {
    if (!dictionary)
      throw new Error(
        `Parquet: ${leaf.path} has dictionary indices but no dictionary`,
      );
    const width = buf[0];
    const indices = new Array(count);
    readHybrid(buf, 1, buf.length, width, count, indices);
    return indices.map((i) => dictionary[i]);
  }
  if (encoding === 5) return readDeltaBinary(buf, { pos: 0 }, count);
  if (encoding === 6) {
    const state = { pos: 0 };
    const lengths = readDeltaBinary(buf, state, count);
    const out = [];
    for (const length of lengths) {
      out.push(buf.subarray(state.pos, state.pos + length));
      state.pos += length;
    }
    return out;
  }
  if (encoding === 7) {
    const state = { pos: 0 };
    const prefixes = readDeltaBinary(buf, state, count);
    const suffixLengths = readDeltaBinary(buf, state, count);
    const out = [];
    let previous = Buffer.alloc(0);
    for (let i = 0; i < count; i++) {
      const suffix = buf.subarray(state.pos, state.pos + suffixLengths[i]);
      state.pos += suffixLengths[i];
      previous = Buffer.concat([previous.subarray(0, prefixes[i]), suffix]);
      out.push(previous);
    }
    return out;
  }
  throw new Error(
    `Parquet: encoding ${encoding} of ${leaf.path} is not supported`,
  );
}

/**
 * One column chunk's leaf values with their levels.
 * @returns {{values: Array, def: Uint8Array|null, rep: Uint8Array|null}}
 *   `values` holds only the defined (non-null) leaves; `def` and `rep` one
 *   entry per level slot.
 */
export function readColumnChunk(bytes, chunk, leaf) {
  let pos = 0;
  let dictionary = null;
  const values = [];
  const defs = [];
  const reps = [];
  let seen = 0;
  while (seen < chunk.values && pos < bytes.length) {
    const reader = new ThriftReader(bytes, pos);
    const header = reader.struct();
    pos = reader.pos;
    const type = header[1];
    const size = header[3];
    const page = bytes.subarray(pos, pos + size);
    pos += size;
    if (type === 2) {
      const dict = header[7];
      const raw = decompress(chunk.codec, page, header[2]);
      dictionary = readPlain(raw, leaf.type, dict[1], leaf.typeLength);
      continue;
    }
    if (type === 0) {
      const h = header[5];
      const count = h[1];
      const raw = decompress(chunk.codec, page, header[2]);
      let p = 0;
      const rep = new Uint8Array(count);
      const def = new Uint8Array(count);
      if (leaf.maxRep) {
        const length = raw.readUInt32LE(p);
        readHybrid(
          raw,
          p + 4,
          p + 4 + length,
          bitWidth(leaf.maxRep),
          count,
          rep,
        );
        p += 4 + length;
      }
      if (leaf.maxDef) {
        const length = raw.readUInt32LE(p);
        readHybrid(
          raw,
          p + 4,
          p + 4 + length,
          bitWidth(leaf.maxDef),
          count,
          def,
        );
        p += 4 + length;
      }
      let defined = count;
      if (leaf.maxDef) {
        defined = 0;
        for (let i = 0; i < count; i++) if (def[i] === leaf.maxDef) defined++;
      }
      const got = readValues(raw.subarray(p), h[2], leaf, defined, dictionary);
      for (const v of got) values.push(v);
      for (let i = 0; i < count; i++) {
        defs.push(def[i]);
        reps.push(rep[i]);
      }
      seen += count;
      continue;
    }
    if (type === 3) {
      const h = header[8];
      const count = h[1];
      const repLength = h[6] || 0;
      const defLength = h[5] || 0;
      const rep = new Uint8Array(count);
      const def = new Uint8Array(count);
      if (leaf.maxRep)
        readHybrid(page, 0, repLength, bitWidth(leaf.maxRep), count, rep);
      if (leaf.maxDef)
        readHybrid(
          page,
          repLength,
          repLength + defLength,
          bitWidth(leaf.maxDef),
          count,
          def,
        );
      const body = page.subarray(repLength + defLength);
      const compressed = h[7] !== false;
      const raw = compressed
        ? decompress(chunk.codec, body, header[2] - repLength - defLength)
        : body;
      const defined = count - (h[2] || 0);
      const got = readValues(raw, h[4], leaf, defined, dictionary);
      for (const v of got) values.push(v);
      for (let i = 0; i < count; i++) {
        defs.push(def[i]);
        reps.push(rep[i]);
      }
      seen += count;
      continue;
    }
    // Index pages and anything else: skipped.
  }
  return {
    values,
    def: leaf.maxDef ? Uint8Array.from(defs) : null,
    rep: leaf.maxRep ? Uint8Array.from(reps) : null,
  };
}

// ── Assembly ────────────────────────────────────────────────────────────

/**
 * Per-row values of a column that is not repeated: null where the leaf is
 * not defined.
 */
export function rowsOfFlat({ values, def }, leaf, rows) {
  if (!leaf.maxDef) return values.slice(0, rows);
  const out = new Array(def.length);
  let v = 0;
  for (let i = 0; i < def.length; i++)
    out[i] = def[i] === leaf.maxDef ? values[v++] : null;
  return out;
}

/**
 * Per-row lists of a column repeated once (a list or a map's keys or
 * values): [] for an empty or null list, `null` entries for null elements.
 */
export function rowsOfRepeated({ values, def, rep }, leaf) {
  const out = [];
  let v = 0;
  // A slot at def >= the list's own level (maxDef - 1 for an optional
  // leaf, maxDef for a required one) is an element.
  const elementDef = leaf.elementDef ?? leaf.maxDef - 1;
  for (let i = 0; i < rep.length; i++) {
    if (rep[i] === 0) out.push([]);
    const row = out[out.length - 1];
    if (def[i] === leaf.maxDef) row.push(values[v++]);
    else if (def[i] >= elementDef) row.push(null);
  }
  return out;
}

/**
 * Per-row lists of lists of a column repeated twice (a list inside a list's
 * elements): each row's outer elements, each the list of its defined
 * inner values.
 */
export function rowsOfNested({ values, def, rep }, leaf) {
  const [outerDef] = leaf.repeatedDefs;
  const out = [];
  let v = 0;
  for (let i = 0; i < rep.length; i++) {
    if (rep[i] === 0) out.push([]);
    const row = out[out.length - 1];
    if (rep[i] <= 1 && def[i] >= outerDef) row.push([]);
    if (def[i] === leaf.maxDef) row[row.length - 1].push(values[v++]);
  }
  return out;
}

// ── Files ───────────────────────────────────────────────────────────────

/** A local Parquet file: its footer, and its column chunks on demand. */
export function openParquet(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (start, length) => {
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(fd, out, done, length - done, start + done);
      if (!n) throw new Error(`Parquet: ${file} ended early`);
      done += n;
    }
    return out;
  };
  let tail = read(size - Math.min(size, 1 << 20), Math.min(size, 1 << 20));
  let footer = footerFromTail(tail);
  if (footer.need) {
    tail = read(size - footer.need, footer.need);
    footer = footerFromTail(Buffer.concat([tail, Buffer.from('')]));
  }
  const leafByPath = new Map(footer.leaves.map((leaf) => [leaf.path, leaf]));
  return {
    ...footer,
    size,
    leaf: (path) => leafByPath.get(path),
    /** One column of one row group, raw (values and levels). */
    column(group, path) {
      const chunk = footer.rowGroups[group].columns.find(
        (c) => c.path === path,
      );
      if (!chunk) throw new Error(`Parquet: no column ${path}`);
      return readColumnChunk(
        read(chunk.start, chunk.compressedSize),
        chunk,
        leafByPath.get(path),
      );
    },
    close: () => fs.closeSync(fd),
  };
}
