import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * A small ZIP reader for the HydroSHEDS v2 File Geodatabase archives, which
 * are ZIP64 (the North American one is 3.4 GB): the central directory is
 * read once, and an entry is streamed straight out of the archive (stored or
 * deflated), so the 5+ GB of tables inside are never extracted to disk.
 * Entry names are only matched, never used as paths.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_UINT32 = 0xffffffff;

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) break;
    done += read;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

const u64 = (buffer, offset) => Number(buffer.readBigUInt64LE(offset));

/** The ZIP64 extra field's values, in the order the spec fills them. */
function zip64Extra(extra, entry) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      if (entry.size === MAX_UINT32) {
        entry.size = u64(extra, field);
        field += 8;
      }
      if (entry.compressedSize === MAX_UINT32) {
        entry.compressedSize = u64(extra, field);
        field += 8;
      }
      if (entry.localOffset === MAX_UINT32)
        entry.localOffset = u64(extra, field);
      return;
    }
    at += 4 + size;
  }
}

/**
 * The archive's entries.
 * @returns {{name: string, method: number, size: number, compressedSize: number, localOffset: number}[]}
 */
export function listZipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const tailLength = Math.min(total, 65_557);
    const tail = readAt(fd, total - tailLength, tailLength);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--)
      if (tail.readUInt32LE(at) === EOCD) {
        eocd = at;
        break;
      }
    if (eocd < 0) throw new Error(`${file}: not a ZIP archive`);
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    const locator = eocd - 20;
    if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
      const recordOffset = u64(tail, locator + 8);
      const record = readAt(fd, recordOffset, 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD)
        throw new Error(`${file}: broken ZIP64 directory`);
      count = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
    }
    const directory = readAt(fd, directoryOffset, directorySize);
    const entries = [];
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (directory.readUInt32LE(at) !== CENTRAL)
        throw new Error(`${file}: broken central directory`);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const entry = {
        name: directory.toString('utf8', at + 46, at + 46 + nameLength),
        method: directory.readUInt16LE(at + 10),
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        localOffset: directory.readUInt32LE(at + 42),
      };
      zip64Extra(
        directory.subarray(
          at + 46 + nameLength,
          at + 46 + nameLength + extraLength,
        ),
        entry,
      );
      entries.push(entry);
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Where an entry's data starts (after its local header). */
function dataOffset(fd, entry) {
  const header = readAt(fd, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL)
    throw new Error(`${entry.name}: broken local header`);
  return (
    entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  );
}

/** A readable stream of one entry's uncompressed bytes. */
export function openZipEntry(file, entry, { highWaterMark = 1 << 22 } = {}) {
  if (![0, 8].includes(entry.method))
    throw new Error(`${entry.name}: compression method ${entry.method}`);
  const fd = fs.openSync(file, 'r');
  let start;
  try {
    start = dataOffset(fd, entry);
  } finally {
    fs.closeSync(fd);
  }
  const raw = fs.createReadStream(file, {
    start,
    end: start + entry.compressedSize - 1,
    highWaterMark,
  });
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw({ chunkSize: 1 << 20 });
  raw.on('error', (error) => inflate.destroy(error));
  return raw.pipe(inflate);
}

/** One whole (small) entry, in memory. */
export async function readZipEntry(file, entry, { maxBytes = 256 << 20 } = {}) {
  if (entry.size > maxBytes)
    throw new Error(`${entry.name}: ${entry.size} bytes is too large to hold`);
  const chunks = [];
  for await (const chunk of openZipEntry(file, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
