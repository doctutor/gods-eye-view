// Personal fork: the typed-array file the Wikipedia coverage grid and its H3
// tables are kept in. Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';

/**
 * One file: a 4-byte magic, a uint32 header length, a JSON header, padding
 * to 8 bytes, then typed arrays at 8-byte-aligned offsets. The header names
 * every array with its dtype, offset (into the array region) and length,
 * so a reader opens the header alone and reads an array only when asked.
 */

export const DTYPES = Object.freeze({
  u32: { ctor: Uint32Array, size: 4 },
  f32: { ctor: Float32Array, size: 4 },
  f64: { ctor: Float64Array, size: 8 },
});
const MAX_HEADER_BYTES = 1 << 22;

/** Collects arrays, hands back their header entries, writes the file atomically. */
export function createPacker() {
  const arrays = [];
  let offset = 0;
  return {
    /** @returns {{dtype: string, offset: number, length: number}} the entry to keep in the header */
    place(array, dtype) {
      if (!DTYPES[dtype]) throw new RangeError(`No dtype ${dtype}`);
      if (!(array instanceof DTYPES[dtype].ctor))
        throw new TypeError(`An ${dtype} array was expected`);
      const bytes = array.length * DTYPES[dtype].size;
      const entry = { dtype, offset, length: array.length };
      arrays.push({ array, offset, bytes });
      offset += Math.ceil(bytes / 8) * 8;
      return entry;
    },
    /** @returns {{bytes: number}} */
    write(file, magic, header) {
      if (typeof magic !== 'string' || magic.length !== 4)
        throw new RangeError('The magic is four characters');
      const headerJson = Buffer.from(JSON.stringify({ ...header, magic }));
      if (headerJson.length > MAX_HEADER_BYTES)
        throw new RangeError('Header too large');
      const dataStart = Math.ceil((8 + headerJson.length) / 8) * 8;
      const preamble = Buffer.alloc(dataStart);
      preamble.write(magic, 0, 'latin1');
      preamble.writeUInt32LE(headerJson.length, 4);
      headerJson.copy(preamble, 8);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(temporary, 'w');
      try {
        fs.writeSync(fd, preamble, 0, preamble.length, 0);
        for (const { array, offset: at, bytes } of arrays) {
          const view = Buffer.from(array.buffer, array.byteOffset, bytes);
          fs.writeSync(fd, view, 0, bytes, dataStart + at);
        }
        fs.ftruncateSync(fd, dataStart + offset);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      return { bytes: dataStart + offset };
    },
  };
}

/** The header of an array file, checked against the magic and version. */
export function readArrayFileHeader(file, magic, version) {
  const fd = fs.openSync(file, 'r');
  try {
    const lead = Buffer.alloc(8);
    if (fs.readSync(fd, lead, 0, 8, 0) !== 8)
      throw new Error(`Not a ${magic} file`);
    if (lead.toString('latin1', 0, 4) !== magic)
      throw new Error(`Not a ${magic} file`);
    const length = lead.readUInt32LE(4);
    if (length > MAX_HEADER_BYTES) throw new Error('Header too large');
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 8) !== length)
      throw new Error('Header truncated');
    const header = JSON.parse(json.toString('utf8'));
    if (header.version !== version)
      throw new Error(`${magic} version ${header.version} is not ${version}`);
    return { header, dataStart: Math.ceil((8 + length) / 8) * 8 };
  } finally {
    fs.closeSync(fd);
  }
}

/** The header, and a reader for its arrays (each read when asked). */
export function openArrayFile(file, magic, version) {
  const { header, dataStart } = readArrayFileHeader(file, magic, version);
  return {
    header,
    readArray(entry) {
      const { ctor, size } = DTYPES[entry.dtype];
      const array = new ctor(entry.length);
      const view = Buffer.from(array.buffer);
      const fd = fs.openSync(file, 'r');
      try {
        const got = fs.readSync(
          fd,
          view,
          0,
          entry.length * size,
          dataStart + entry.offset,
        );
        if (got !== entry.length * size) throw new Error('Array truncated');
      } finally {
        fs.closeSync(fd);
      }
      return array;
    },
  };
}
