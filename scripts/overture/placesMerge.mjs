import { cellToLatLng, cellToParent, latLngToCell } from 'h3-js';
import {
  WORLD_BITS,
  Writer,
  bucketWriter,
  latOfUnitY,
} from '../../server/providers/overture/buildingsFile.js';
import {
  BUCKET_RESOLUTIONS,
  GLOBAL_RESOLUTIONS,
  PLACE_BLOCK_ZOOM,
  PLACE_BUCKET_ZOOM,
  PLACE_KIND,
  PLACE_RECORD_BYTES,
  encodeCounts,
  lonOfUnitX,
  slotOf,
} from '../../server/providers/overture/placesFile.js';
import {
  CATEGORY_SLOTS,
  COUNT_THRESHOLDS,
} from '../../src/data/overturePlaces.js';
import { readPartBucket } from './buildingsParts.mjs';

/**
 * The last part of the Overture places step: one bucket's file from the
 * parts that reached it (placesParts.mjs): per z 12 tile its places, most
 * confident first (P) with their text (T), and the bucket's places counted
 * per H3 cell at every resolution (H, key = resolution).
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const SLOTS = CATEGORY_SLOTS * COUNT_THRESHOLDS.length;
const MAX_RES = Math.max(...BUCKET_RESOLUTIONS, ...GLOBAL_RESOLUTIONS);

/** Parse a z 12 tile's part bytes: [{x, y, conf, category, text: Buffer}]. */
function parsePlaces(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const x = buf.readUInt32LE(pos);
    const y = buf.readUInt32LE(pos + 4);
    const conf = buf.readUInt8(pos + 8);
    const category = buf.readUInt8(pos + 9);
    pos += 10;
    const start = pos;
    let length = 0;
    let shift = 0;
    for (;;) {
      const b = buf[pos++];
      length += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    pos += length;
    out.push({ x, y, conf, category, text: buf.subarray(start, pos) });
  }
  return out;
}

/**
 * @param {{bucketKey: number, parts: Array<{file: string, header: object}>, target: string}} job
 * @returns {{places: number, bytes: number}}
 */
export function mergePlacesBucket({ bucketKey, parts, target }) {
  const pieces = new Map();
  for (const { file, header } of parts)
    for (const { local, bytes } of readPartBucket(file, header, bucketKey)) {
      if (!pieces.has(local)) pieces.set(local, []);
      pieces.get(local).push(bytes);
    }
  // Counts at the finest resolution, then summed up to the coarser ones.
  const finest = new Map(); // res-7 cell → Uint32Array(SLOTS)
  const writer = bucketWriter(
    target,
    pieces.size * 2 + BUCKET_RESOLUTIONS.length + GLOBAL_RESOLUTIONS.length,
  );
  let places = 0;
  try {
    for (const local of [...pieces.keys()].sort((a, b) => a - b)) {
      const list = pieces.get(local);
      pieces.delete(local);
      const found = parsePlaces(
        list.length === 1 ? list[0] : Buffer.concat(list),
      );
      found.sort((a, b) => b.conf - a.conf || a.x - b.x || a.y - b.y);
      const records = Buffer.alloc(found.length * PLACE_RECORD_BYTES);
      const texts = new Writer(found.length * 48 + 64);
      found.forEach((place, i) => {
        const at = i * PLACE_RECORD_BYTES;
        records.writeUInt32LE(place.x, at);
        records.writeUInt32LE(place.y, at + 4);
        records.writeUInt8(place.conf, at + 8);
        records.writeUInt8(place.category, at + 9);
        texts.bytes(place.text);
        const lat = latOfUnitY(place.y);
        const lon = lonOfUnitX(place.x);
        const cell = latLngToCell(lat, lon, MAX_RES);
        let counts = finest.get(cell);
        if (!counts) finest.set(cell, (counts = new Uint32Array(SLOTS)));
        COUNT_THRESHOLDS.forEach((threshold, t) => {
          if (place.conf >= Math.round(threshold * 250))
            counts[slotOf(place.category, t)] += 1;
        });
      });
      places += found.length;
      writer.add(PLACE_KIND.P, local, records, found.length);
      writer.add(PLACE_KIND.T, local, texts.done(), found.length);
    }
    for (let res = MAX_RES; res >= 0; res--) {
      const cells = new Map();
      for (const [cell, counts] of finest) {
        const parent = res === MAX_RES ? cell : cellToParent(cell, res);
        let entry = cells.get(parent);
        if (!entry) {
          const [lat, lon] = cellToLatLng(parent);
          cells.set(
            parent,
            (entry = { lat, lon, counts: new Uint32Array(SLOTS) }),
          );
        }
        for (let s = 0; s < SLOTS; s++) entry.counts[s] += counts[s];
      }
      writer.add(PLACE_KIND.H, res, encodeCounts(cells), cells.size);
    }
  } catch (error) {
    writer.abort();
    throw error;
  }
  return { places, bytes: writer.finish() };
}

/** The z 12 tile a place's units are in, as its key within its bucket. */
export function placeBlockKey(x, y) {
  const shift = WORLD_BITS - PLACE_BLOCK_ZOOM;
  const local = 2 ** (PLACE_BLOCK_ZOOM - PLACE_BUCKET_ZOOM);
  return ((y >>> shift) % local) * local + ((x >>> shift) % local);
}
