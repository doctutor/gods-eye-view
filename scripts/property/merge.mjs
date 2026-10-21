import { bucketWriter } from '../../server/providers/overture/buildingsFile.js';
import {
  PIN_BYTES,
  PROPERTY_KIND,
  RecordReader,
  RecordWriter,
  dayOf,
  decodeRecord,
  detailBlockOf,
  encodePin,
  monthOfDay,
  pinBlockOf,
} from '../../server/providers/property/file.js';
import {
  PRICE_FLOOR_USD,
  PRICE_SINCE_YEAR,
} from '../../src/data/propertySales.js';
import { eachSectionRecord, readSpill } from './parts.mjs';

/**
 * The property build's merge: one bucket file (z 10 tile) from its
 * sections in every part. Records are grouped into buildings inside each
 * z 14 tile: records at the same point, or at the same street address
 * without unit (and ZIP), are one building, its records the units (New
 * York's apartments and condos, a building's flats) or a stack of
 * addresses the source put at one point.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const PRICE_SINCE_DAY = dayOf(`${PRICE_SINCE_YEAR}-01-01`);
const unitOrder = new Intl.Collator('en', { numeric: true });

/**
 * Group one tile's entries ({x, y, key, record}) into buildings: indices
 * of entries that share a point or a non-empty address key, transitively.
 * @returns {number[][]} each building's entries, in first-seen order
 */
export function collapseBuildings(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byPoint = new Map();
  const byKey = new Map();
  entries.forEach((entry, i) => {
    const point = entry.y * 2 ** 28 + entry.x;
    const seen = byPoint.get(point);
    if (seen === undefined) byPoint.set(point, i);
    else union(i, seen);
    if (entry.key) {
      const same = byKey.get(entry.key);
      if (same === undefined) byKey.set(entry.key, i);
      else union(i, same);
    }
  });
  const groups = new Map();
  entries.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  return [...groups.values()];
}

/** The median of the finite values given, or 0. */
function median(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * A building's pin summary from its records ({x, y, record}): the most
 * common point, the most common type, the latest sale, the median year
 * built. The records come back in the order the building keeps them: the
 * record without a unit first, then the units in natural order.
 */
export function summarizeBuilding(entries) {
  const sorted = [...entries].sort(
    (a, b) =>
      Number(Boolean(a.record.unit)) - Number(Boolean(b.record.unit)) ||
      unitOrder.compare(a.record.unit || '', b.record.unit || ''),
  );
  const points = new Map();
  const types = new Map();
  let latest = null;
  for (const entry of sorted) {
    const point = entry.y * 2 ** 28 + entry.x;
    points.set(point, (points.get(point) || 0) + 1);
    const { type, soldDay } = entry.record;
    if (type) types.set(type, (types.get(type) || 0) + 1);
    if (soldDay >= 0 && (!latest || soldDay > latest.record.soldDay))
      latest = entry;
  }
  const most = (map) => {
    let best = null;
    let count = 0;
    for (const [key, n] of map)
      if (n > count) {
        best = key;
        count = n;
      }
    return best;
  };
  const point = most(points);
  const sold = latest?.record || null;
  return {
    entries: sorted,
    x: point % 2 ** 28,
    y: Math.floor(point / 2 ** 28),
    units: sorted.length,
    type: most(types) || 0,
    price: sold?.soldPrice || 0,
    month: sold ? monthOfDay(sold.soldDay) : 0,
    sqft: sold?.sqft || 0,
    flags:
      sold &&
      sold.soldDay >= PRICE_SINCE_DAY &&
      sold.soldPrice >= PRICE_FLOOR_USD
        ? 1
        : 0,
    year: median(sorted.map((entry) => entry.record.year || 0)),
  };
}

/** A 52-bit hash of an address key (0: no key), FNV-1a twice. */
export function keyHash(key) {
  if (!key) return 0;
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return ((a >>> 0) & 0xfffff) * 2 ** 32 + (b >>> 0) + 1;
}

/**
 * Write one bucket file from its spill file (parts.mjs createSpill). The
 * records stay in the spill's sections, found through typed arrays; a z 14
 * tile's are decoded only while its buildings are made, and its blocks
 * written then.
 * @returns {{buildings: number, records: number, bytes: number, blocks: number}}
 */
export function mergePropertyBucket({ spill, target }) {
  const frames = readSpill(spill);
  let records = 0;
  for (const buf of frames) eachSectionRecord(buf, () => (records += 1));
  const frame = new Uint32Array(records);
  const offset = new Uint32Array(records);
  const length = new Uint32Array(records);
  const xs = new Uint32Array(records);
  const ys = new Uint32Array(records);
  const keys = new Float64Array(records);
  const blocks = new Uint32Array(records);
  let n = 0;
  frames.forEach((buf, f) => {
    eachSectionRecord(buf, (x, y, key, body) => {
      frame[n] = f;
      offset[n] = body.byteOffset - buf.byteOffset;
      length[n] = body.length;
      xs[n] = x;
      ys[n] = y;
      keys[n] = keyHash(key);
      blocks[n] = pinBlockOf(x, y);
      n += 1;
    });
  });
  const order = new Uint32Array(records);
  for (let i = 0; i < records; i++) order[i] = i;
  order.sort((a, b) => blocks[a] - blocks[b] || a - b);
  const bodyOf = (i) =>
    frames[frame[i]].subarray(offset[i], offset[i] + length[i]);

  // Every z 14 tile holds at most 16 z 16 tiles of records.
  let pinBlockCount = 0;
  for (let i = 0; i < records; i++)
    if (i === 0 || blocks[order[i]] !== blocks[order[i - 1]])
      pinBlockCount += 1;
  const writer = bucketWriter(target, pinBlockCount * 17, { atMost: true });
  let buildings = 0;
  let written = 0;
  try {
    for (let start = 0; start < records;) {
      const block = blocks[order[start]];
      let end = start;
      while (end < records && blocks[order[end]] === block) end += 1;
      const entries = [];
      for (let k = start; k < end; k++) {
        const i = order[k];
        entries.push({
          x: xs[i],
          y: ys[i],
          key: keys[i],
          body: bodyOf(i),
          record: decodeRecord(new RecordReader(bodyOf(i))),
        });
      }
      const pins = [];
      const details = new Map();
      for (const group of collapseBuildings(entries)) {
        const building = summarizeBuilding(group.map((i) => entries[i]));
        const detail = detailBlockOf(building.x, building.y);
        let list = details.get(detail);
        if (!list) details.set(detail, (list = []));
        building.index = list.length;
        list.push(building.entries.map((entry) => entry.body));
        pins.push(building);
      }
      const raw = Buffer.alloc(pins.length * PIN_BYTES);
      pins.forEach((pin, i) => encodePin(raw, i * PIN_BYTES, pin));
      writer.add(PROPERTY_KIND.P, block, raw, pins.length);
      const out = new RecordWriter(1 << 16);
      const one = new RecordWriter(1 << 12);
      for (const [key, list] of details) {
        out.pos = 0;
        for (const bodies of list) {
          one.pos = 0;
          one.varint(bodies.length);
          for (const body of bodies) one.bytes(body);
          const content = one.done();
          out.varint(content.length);
          out.bytes(content);
        }
        writer.add(PROPERTY_KIND.D, key, out.done(), list.length);
      }
      buildings += pins.length;
      written += 1 + details.size;
      start = end;
    }
    return { buildings, records, blocks: written, bytes: writer.finish() };
  } catch (error) {
    writer.abort();
    throw error;
  }
}
