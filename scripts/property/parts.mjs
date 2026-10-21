import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as h3 from 'h3-js';
import { unitX, unitY } from '../../server/providers/overture/buildingsFile.js';
import {
  RecordReader,
  RecordWriter,
  bucketOf,
  encodeRecord,
} from '../../server/providers/property/file.js';
import { cellKey, parentKey } from '../../server/providers/property/hexFile.js';
import { cleanRow } from './rows.mjs';

/**
 * One row group's part of the property build: its records cleaned
 * (rows.mjs) and sorted two ways into zstd sections, which the main
 * thread spills (createSpill) to one file per bucket and per partition:
 *
 * - by bucket (the z 10 tile of the record): per record Uint32 x, y on the
 *   2^28 grid, then a varint-prefixed address key (the street without
 *   unit, and the ZIP) and a varint-prefixed record (file.js
 *   encodeRecord);
 * - by resolution-3 H3 cell (the hexagons' partition): per record
 *   STAT_BYTES: Float64 resolution-7 cell key, Float32 price (0: no
 *   recent sale), Float32 price per sqft (0: none), Uint16 year built (0:
 *   none), Uint8 1 when it has a sale, one unused byte.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const STAT_BYTES = 20;
export const STAT_RES = 7;
export const PARTITION_RES = 3;

const compress = (buf) =>
  zlib.zstdCompressSync(buf, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });

/**
 * Sort a row group's rows into sections: {buckets, cells: Map key →
 * {writer, count}, stats}.
 */
export function partitionRows(rows, { counties, today, thisYear }) {
  const buckets = new Map();
  const cells = new Map();
  const stats = {
    rows: rows.length,
    kept: 0,
    noCoordinates: 0,
    outside: 0,
    placeholderSales: 0,
    recentSales: 0,
    withUnit: 0,
  };
  const recordWriter = new RecordWriter();
  for (const row of rows) {
    const cleaned = cleanRow(row, { counties, today, thisYear });
    if (cleaned.drop) {
      stats[cleaned.drop] += 1;
      continue;
    }
    stats.kept += 1;
    if (cleaned.placeholder) stats.placeholderSales += 1;
    if (cleaned.stats.price) stats.recentSales += 1;
    if (cleaned.record.unit) stats.withUnit += 1;
    const x = unitX(cleaned.lon);
    const y = unitY(cleaned.lat);
    const bucket = bucketOf(x, y);
    let section = buckets.get(bucket);
    if (!section)
      buckets.set(bucket, (section = { writer: new RecordWriter(), count: 0 }));
    recordWriter.pos = 0;
    encodeRecord(recordWriter, cleaned.record);
    const body = recordWriter.done();
    section.writer.u32(x);
    section.writer.u32(y);
    section.writer.text(cleaned.key);
    section.writer.varint(body.length);
    section.writer.bytes(body);
    section.count += 1;

    const key = cellKey(h3.latLngToCell(cleaned.lat, cleaned.lon, STAT_RES));
    const partition = parentKey(key, PARTITION_RES);
    let cell = cells.get(partition);
    if (!cell)
      cells.set(partition, (cell = { writer: new RecordWriter(), count: 0 }));
    cell.writer.f64(key);
    cell.writer.f32(cleaned.stats.price);
    cell.writer.f32(cleaned.stats.ppsf);
    cell.writer.u16(cleaned.stats.year);
    cell.writer.byte(cleaned.stats.sold ? 1 : 0);
    cell.writer.byte(0);
    cell.count += 1;
  }
  return { buckets, cells, stats };
}

/**
 * A row group's sections compressed, for the main thread's spill:
 * {buckets, cells: [[key, zstd Buffer, count]], stats}.
 */
export function compressSections({ buckets, cells, stats }) {
  // Each section in its own ArrayBuffer (a small Buffer may sit in Node's
  // shared pool), so the worker can hand them over.
  const own = (buf) => {
    const out = new Uint8Array(buf.length);
    out.set(buf);
    return out;
  };
  const pack = (map) =>
    [...map].map(([key, section]) => [
      key,
      own(compress(section.writer.done())),
      section.count,
    ]);
  return { buckets: pack(buckets), cells: pack(cells), stats };
}

/**
 * The spill: every row group's sections appended to one file per bucket
 * and one per partition, as frames (Uint32 length, then the zstd
 * section). Sections are held in memory and written a file at a time, the
 * largest first, once `budgetBytes` are held, so the disk (an external
 * spinning one) takes long sequential writes from one writer, and a merge
 * later reads its bucket's file straight through.
 * @param {string} dir
 * @param {{budgetBytes?: number}} [options]
 */
export function createSpill(dir, { budgetBytes = 768 * 2 ** 20 } = {}) {
  fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cells'), { recursive: true });
  const held = new Map(); // file → {frames: Buffer[], bytes}
  const counts = { buckets: new Map(), cells: new Map() };
  let total = 0;
  let written = 0;
  const fileOf = (kind, key) => path.join(dir, kind, `${key}.spill`);

  function flushFile(file) {
    const entry = held.get(file);
    if (!entry) return;
    held.delete(file);
    fs.appendFileSync(file, Buffer.concat(entry.frames));
    total -= entry.bytes;
    written += entry.bytes;
  }

  return {
    /** Add a compressed row group ({buckets, cells, stats}). */
    add({ buckets, cells }) {
      for (const [kind, list] of [
        ['buckets', buckets],
        ['cells', cells],
      ])
        for (const [key, body, count] of list) {
          const file = fileOf(kind, key);
          counts[kind].set(
            String(key),
            (counts[kind].get(String(key)) || 0) + count,
          );
          const frame = Buffer.alloc(4 + body.length);
          frame.writeUInt32LE(body.length, 0);
          Buffer.from(body.buffer, body.byteOffset, body.length).copy(frame, 4);
          let entry = held.get(file);
          if (!entry) held.set(file, (entry = { frames: [], bytes: 0 }));
          entry.frames.push(frame);
          entry.bytes += frame.length;
          total += frame.length;
        }
      if (total <= budgetBytes) return;
      const largest = [...held].sort((a, b) => b[1].bytes - a[1].bytes);
      for (const [file] of largest) {
        if (total <= budgetBytes / 2) break;
        flushFile(file);
      }
    },
    /** Write what is held; returns {buckets, cells: Map key → {file, count}, bytes}. */
    finish() {
      for (const file of [...held.keys()]) flushFile(file);
      const files = (kind) =>
        new Map(
          [...counts[kind]].map(([key, count]) => [
            key,
            { file: fileOf(kind, key), count },
          ]),
        );
      return {
        buckets: files('buckets'),
        cells: files('cells'),
        bytes: written,
      };
    },
    held: () => total,
  };
}

/** A spill file's sections, decompressed. */
export function readSpill(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const length = buf.readUInt32LE(at);
    if (at + 4 + length > buf.length) throw new Error(`${file} is torn`);
    out.push(zlib.zstdDecompressSync(buf.subarray(at + 4, at + 4 + length)));
    at += 4 + length;
  }
  return out;
}

/** Visit a bucket section's records: (x, y, key, body Buffer). */
export function eachSectionRecord(buf, visit) {
  const reader = new RecordReader(buf);
  while (reader.pos < buf.length) {
    const x = buf.readUInt32LE(reader.pos);
    const y = buf.readUInt32LE(reader.pos + 4);
    reader.pos += 8;
    const key = reader.text();
    const length = reader.varint();
    const body = buf.subarray(reader.pos, reader.pos + length);
    reader.pos += length;
    visit(x, y, key, body);
  }
}
