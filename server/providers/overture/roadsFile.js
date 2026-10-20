// Personal fork: the Overture roads files that `npm run overture:build --
// --roads` writes and the server draws from. Not part of upstream God's
// Eye View.
import { Writer } from './buildingsFile.js';
import { ROAD_LEVELS } from '../../../src/data/overtureRoads.js';

/**
 * Roads are kept per level (ROAD_LEVELS): each level's segments on its own
 * grid (2^bits units a world side, Web Mercator), simplified for its
 * zooms, in blocks of z `block` tiles, the blocks in bucket files
 * (buildingsFile.js: "GEVB", an index, zstd blocks; kind ROADS_KIND, key
 * the block's x + y × 2^(block − container) within its z `container`
 * tile), one file per level and container tile.
 *
 * A block: varint names, each a varint length and UTF-8; varint segments,
 * each Uint8 class code, flags (ROAD_FLAGS), surface, speed limit (in its
 * unit), subclass and source codes, varint name (1 + index, 0 none),
 * varint points, then the points as zigzag varints, the first relative to
 * the block's corner and each next one to the last.
 */

export const ROADS_KIND = 1;
/** A container's key in the manifest and the parts: level × 2^24 + container y × 2^z + x. */
export const containerKey = (level, cx, cy) =>
  level * 2 ** 24 + cy * 2 ** ROAD_LEVELS[level].container + cx;
export const containerOf = (key) => {
  const level = Math.floor(key / 2 ** 24);
  const rest = key - level * 2 ** 24;
  const side = 2 ** ROAD_LEVELS[level].container;
  return { level, cx: rest % side, cy: Math.floor(rest / side) };
};
/** Blocks a container's side holds at a level. */
export const blocksPerContainer = (level) =>
  2 ** (ROAD_LEVELS[level].block - ROAD_LEVELS[level].container);
/** A block's side in its level's units. */
export const blockSide = (level) =>
  2 ** (ROAD_LEVELS[level].bits - ROAD_LEVELS[level].block);

const zigzag = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzig = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

/**
 * Encode a block's segments: [{code, flags, surface, speed, subclass,
 * source, name, points: [x0, y0, x1, y1, …] in level units}] around the
 * corner (x0, y0).
 */
export function encodeRoadBlock(segments, x0, y0) {
  const names = new Map();
  for (const segment of segments)
    if (segment.name && !names.has(segment.name))
      names.set(segment.name, names.size);
  const writer = new Writer(1024 + segments.length * 24);
  writer.varint(names.size);
  for (const name of names.keys()) {
    const bytes = Buffer.from(name, 'utf8');
    writer.varint(bytes.length);
    writer.bytes(bytes);
  }
  writer.varint(segments.length);
  for (const s of segments) {
    writer.byte(s.code);
    writer.byte(s.flags);
    writer.byte(s.surface);
    writer.byte(s.speed);
    writer.byte(s.subclass);
    writer.byte(s.source);
    writer.varint(s.name ? names.get(s.name) + 1 : 0);
    const n = s.points.length / 2;
    writer.varint(n);
    let px = x0;
    let py = y0;
    for (let i = 0; i < n; i++) {
      const x = s.points[i * 2];
      const y = s.points[i * 2 + 1];
      writer.varint(zigzag(x - px));
      writer.varint(zigzag(y - py));
      px = x;
      py = y;
    }
  }
  return writer.done();
}

/**
 * Visit a block's segments: visit({code, flags, surface, speed, subclass,
 * source, name, points: Float64Array of level units}). The record is
 * reused between calls: copy what is kept.
 */
export function eachRoad(buf, x0, y0, visit) {
  const state = { pos: 0 };
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = buf[state.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
  };
  const nameCount = varint();
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    const length = varint();
    names[i] = buf.toString('utf8', state.pos, state.pos + length);
    state.pos += length;
  }
  const count = varint();
  const record = {};
  for (let k = 0; k < count; k++) {
    record.code = buf[state.pos];
    record.flags = buf[state.pos + 1];
    record.surface = buf[state.pos + 2];
    record.speed = buf[state.pos + 3];
    record.subclass = buf[state.pos + 4];
    record.source = buf[state.pos + 5];
    state.pos += 6;
    const name = varint();
    record.name = name ? names[name - 1] : '';
    const n = varint();
    const points = new Float64Array(n * 2);
    let x = x0;
    let y = y0;
    for (let i = 0; i < n; i++) {
      x += unzig(varint());
      y += unzig(varint());
      points[i * 2] = x;
      points[i * 2 + 1] = y;
    }
    record.points = points;
    visit(record);
  }
  return count;
}

/** All of a block's segments, as plain records (points as arrays). */
export function decodeRoadBlock(buf, x0, y0) {
  const out = [];
  eachRoad(buf, x0, y0, (record) =>
    out.push({ ...record, points: Array.from(record.points) }),
  );
  return out;
}
