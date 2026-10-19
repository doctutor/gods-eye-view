// Personal fork: the on-disk level files of the self-hosted HydroSHEDS v2
// rivers, written by scripts/rivers/build.mjs and read by
// server/providers/riversV2.js. Not part of upstream God's Eye View.
import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * One file per zoom band (bands.js): the band's reaches, simplified for it,
 * cut into the cells of its grid zoom. Layout:
 *
 *   'GEVRIV2\n'
 *   cell data, cell after cell, in key order
 *   index: Float64 start[n], Uint32 key[n] (ascending), Uint32 length[n]
 *   header JSON (band, counts, extent, index offset)
 *   Uint32 header length, Uint32 FORMAT_VERSION, 'GEVRIV2\n'
 *
 * A cell is pieces of line: varuint order, varuint point count, then each
 * point as zigzag varint deltas (x, y) in quantized world units (2^quantBits
 * per side), the first from the cell's corner; on disk each cell is raw
 * deflate (v2's 1″ stair steps repeat a lot: about half the size). A reach
 * crossing cells is cut at them: each cell holds the run of segments that
 * touch it.
 */

export const MAGIC = Buffer.from('GEVRIV2\n', 'latin1');
export const FORMAT_VERSION = 1;
const FOOTER_BYTES = 16;

export const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
export const unzigzag = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Append an unsigned varint to a byte array (plain JS array or pusher). */
export function pushVarUint(out, value) {
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

/**
 * One piece's bytes: order, count, zigzag deltas from (originX, originY).
 * @param {number} order
 * @param {ArrayLike<number>} coords integer world units [x, y, x, y, …]
 */
export function encodePiece(order, coords, originX, originY) {
  const out = [];
  pushVarUint(out, order);
  pushVarUint(out, coords.length / 2);
  let px = originX;
  let py = originY;
  for (let index = 0; index < coords.length; index += 2) {
    pushVarUint(out, zigzag(coords[index] - px));
    pushVarUint(out, zigzag(coords[index + 1] - py));
    px = coords[index];
    py = coords[index + 1];
  }
  return Buffer.from(out);
}

/**
 * Every piece of a cell's bytes as onPiece(order, coords), coords in
 * absolute world units. `coords` is reused between calls.
 */
export function decodeCell(buffer, originX, originY, onPiece) {
  let at = 0;
  let scratch = new Float64Array(256);
  const varuint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = buffer[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 128) return value;
      scale *= 128;
    }
  };
  while (at < buffer.length) {
    const order = varuint();
    const count = varuint();
    if (scratch.length < count * 2) scratch = new Float64Array(count * 2);
    let x = originX;
    let y = originY;
    for (let index = 0; index < count; index++) {
      x += unzigzag(varuint());
      y += unzigzag(varuint());
      scratch[index * 2] = x;
      scratch[index * 2 + 1] = y;
    }
    onPiece(order, scratch.subarray(0, count * 2));
  }
}

/**
 * Write a level file from cells given in ascending key order.
 * @returns {{addCell(key: number, bytes: Buffer): void, finish(header: object): object, abort(): void, bytes: number}}
 */
export function createLevelWriter(file) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  let position = 0;
  const write = (buffer) => {
    let done = 0;
    while (done < buffer.length)
      done += fs.writeSync(
        fd,
        buffer,
        done,
        buffer.length - done,
        position + done,
      );
    position += buffer.length;
  };
  write(MAGIC);
  const starts = [];
  const keys = [];
  const lengths = [];
  let lastKey = -1;
  let rawBytes = 0;
  return {
    /** One cell's pieces (uncompressed; compressed here). */
    addCell(key, bytes) {
      if (key <= lastKey)
        throw new Error('cells must come in ascending key order');
      lastKey = key;
      const stored = zlib.deflateRawSync(bytes, { level: 6 });
      starts.push(position);
      keys.push(key);
      lengths.push(stored.length);
      rawBytes += bytes.length;
      write(stored);
    },
    get bytes() {
      return position;
    },
    finish(header) {
      const count = keys.length;
      // Pad so the index is 8-byte aligned in the file (and when read).
      const pad = (8 - (position % 8)) % 8;
      if (pad) write(Buffer.alloc(pad));
      const indexOffset = position;
      const index = new ArrayBuffer(count * 16);
      new Float64Array(index, 0, count).set(starts);
      new Uint32Array(index, count * 8, count).set(keys);
      new Uint32Array(index, count * 12, count).set(lengths);
      write(Buffer.from(index));
      const full = {
        ...header,
        cells: count,
        compression: 'deflate-raw',
        indexOffset,
        rawBytes,
      };
      const json = Buffer.from(JSON.stringify(full));
      write(json);
      const footer = Buffer.alloc(FOOTER_BYTES);
      footer.writeUInt32LE(json.length, 0);
      footer.writeUInt32LE(FORMAT_VERSION, 4);
      MAGIC.copy(footer, 8);
      write(footer);
      fs.closeSync(fd);
      fs.renameSync(temporary, file);
      return { ...full, bytes: position };
    },
    abort() {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      fs.rmSync(temporary, { force: true });
    },
  };
}

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error('level file is truncated');
    done += read;
  }
  return buffer;
}

/** Only the header of a level file (for status). */
export function readLevelHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return readHeader(fd).header;
  } finally {
    fs.closeSync(fd);
  }
}

function readHeader(fd) {
  const size = fs.fstatSync(fd).size;
  if (size < MAGIC.length + FOOTER_BYTES) throw new Error('not a level file');
  const footer = readExactly(fd, FOOTER_BYTES, size - FOOTER_BYTES);
  if (!footer.subarray(8).equals(MAGIC)) throw new Error('not a level file');
  const version = footer.readUInt32LE(4);
  if (version !== FORMAT_VERSION)
    throw new Error(`level file format ${version}, expected ${FORMAT_VERSION}`);
  const length = footer.readUInt32LE(0);
  const json = readExactly(fd, length, size - FOOTER_BYTES - length);
  return { header: JSON.parse(json.toString('utf8')), size };
}

/**
 * Open a level file: its header and index in memory, cells read on demand.
 */
export function openLevel(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { header, size } = readHeader(fd);
    const count = header.cells;
    const index = new ArrayBuffer(count * 16);
    const view = new Uint8Array(index);
    let done = 0;
    while (done < view.length) {
      const read = fs.readSync(
        fd,
        view,
        done,
        view.length - done,
        header.indexOffset + done,
      );
      if (read === 0) throw new Error('level index is truncated');
      done += read;
    }
    const starts = new Float64Array(index, 0, count);
    const keys = new Uint32Array(index, count * 8, count);
    const lengths = new Uint32Array(index, count * 12, count);
    /** The index of a key, or -1. */
    const find = (key) => {
      let low = 0;
      let high = count - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const value = keys[middle];
        if (value === key) return middle;
        if (value < key) low = middle + 1;
        else high = middle - 1;
      }
      return -1;
    };
    return {
      header,
      size,
      count,
      find,
      /** The (inflated) bytes of the cell at index i. */
      readCell(i) {
        return zlib.inflateRawSync(readExactly(fd, lengths[i], starts[i]));
      },
      close() {
        fs.closeSync(fd);
      },
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
