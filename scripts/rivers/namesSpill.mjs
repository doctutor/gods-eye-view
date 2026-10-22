import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  encodeLine,
  eachLine,
} from '../../server/providers/riverNames/namesFile.js';

export { encodeLine, eachLine };

/**
 * The river names build's spill: lines (OSM waterway pieces, v2 reaches,
 * named lines for the sidecar) sorted into one file per key (a 1° cell, a
 * z 8 tile), each record
 *
 *   varuint id (a name group, or a reach's dense index)
 *   varuint tag (a reach's Strahler order; 0 for an OSM piece)
 *   varuint point count, then zigzag varint deltas of the coordinates in
 *   microdegrees (lon, lat), the first from 0
 *
 * Records are held in memory and appended a file at a time, the largest
 * first, once `budgetBytes` are held: the spill's disk is an external
 * spinning one, which takes long sequential writes from one writer.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/**
 * A spill under `dir`: add(kind, key, record) and finish() → Map
 * "kind/key" → {file, count}. Files are deflated frames (Uint32 length,
 * then the frame).
 */
export function createLineSpill(dir, { budgetBytes = 256 * 2 ** 20 } = {}) {
  const held = new Map(); // file → {parts: Buffer[], bytes, count}
  const counts = new Map();
  let total = 0;
  let written = 0;
  const fileOf = (kind, key) => path.join(dir, kind, `${key}.spill`);

  function flush(file) {
    const entry = held.get(file);
    if (!entry) return;
    held.delete(file);
    const body = zlib.deflateRawSync(Buffer.concat(entry.parts), { level: 3 });
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, frame);
    total -= entry.bytes;
    written += frame.length;
  }

  return {
    add(kind, key, record) {
      const file = fileOf(kind, key);
      let entry = held.get(file);
      if (!entry) held.set(file, (entry = { parts: [], bytes: 0 }));
      entry.parts.push(record);
      entry.bytes += record.length;
      total += record.length;
      const name = `${kind}/${key}`;
      counts.set(name, (counts.get(name) || 0) + 1);
      if (total > budgetBytes) {
        const largest = [...held].sort((a, b) => b[1].bytes - a[1].bytes);
        for (const [f] of largest) {
          if (total <= budgetBytes / 2) break;
          flush(f);
        }
      }
    },
    finish() {
      for (const file of [...held.keys()]) flush(file);
      return {
        files: new Map(
          [...counts].map(([name, count]) => {
            const [kind, key] = name.split('/');
            return [name, { file: fileOf(kind, key), count, kind, key }];
          }),
        ),
        bytes: written,
      };
    },
  };
}

/** A spill file's records, all of them: visit(id, tag, coords). */
export function readLineSpill(file, visit) {
  const buf = fs.readFileSync(file);
  for (let at = 0; at + 4 <= buf.length;) {
    const length = buf.readUInt32LE(at);
    if (at + 4 + length > buf.length) throw new Error(`${file} is torn`);
    eachLine(zlib.inflateRawSync(buf.subarray(at + 4, at + 4 + length)), visit);
    at += 4 + length;
  }
}
