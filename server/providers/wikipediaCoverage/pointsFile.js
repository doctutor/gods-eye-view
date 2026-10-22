// Personal fork: the Wikipedia points index (one dot per geotagged article)
// that `npm run wikipedia:build -- --points` writes under points/ and
// /api/wikipedia-coverage/points reads. Not part of upstream God's Eye View.
import {
  WORLD_BITS,
  bucketWriter,
  unitX,
  unitY,
} from '../overture/buildingsFile.js';
import {
  WIKIPEDIA_POINTS_FULL_ZOOM,
  WIKIPEDIA_POINTS_PER_TILE,
  wikiBit,
  wikiCount,
} from '../../../src/data/wikipediaPoints.js';

/**
 * Positions are on the buildings' 2^28 web-mercator grid. Each block holds
 * one tile's articles at one zoom, the best ranked first (rankCompare),
 * per article RECORD_BYTES then a varint-prefixed UTF-8 text:
 *
 *   Uint32 x, y; Uint32 page id; Uint32 Wikidata item number (Q…, 0 when
 *   none); Uint32 article bytes; Uint32 dim (GeoData's object size, m);
 *   Uint8 type class; Uint8 flags (1: a secondary coordinate); Uint8 wiki
 *   (WIKIPEDIA_POINT_WIKIS code: the record's own, whose page, title and
 *   bytes these are); one unused byte; Uint32 wikis (format 3: the mask of
 *   every wiki with an article on the item, bit code − 1)
 *   text: "title\0GeoData type"
 *
 * Zooms 0 to 11 keep a tile's best WIKIPEDIA_POINTS_PER_TILE articles, zoom
 * 12 all of them. Blocks are kind POINT_KIND + zoom, keyed by the tile
 * (x + y × 2^dz inside its file): zooms 0–6 in one overview file (the whole
 * world), zooms 7–12 in bucket files of one z 6 tile each
 * (buildingsFile.js's format).
 */

export const POINT_KIND = 40;
/** Format 3's record; format 2's had no wiki mask (RECORD_BYTES_2). */
export const RECORD_BYTES = 32;
export const RECORD_BYTES_2 = 28;
/** A manifest's record size. */
export const recordBytesOf = (format) =>
  format >= 3 ? RECORD_BYTES : RECORD_BYTES_2;
export const POINTS_BUCKET_ZOOM = 6;
export const OVERVIEW_MAX_ZOOM = POINTS_BUCKET_ZOOM;
export const FLAG_SECONDARY = 1;

/**
 * A record's weight within its class: log2 of the article's size, plus
 * log2 of the wikis with an article on its item (WIKI_BOOST bits a
 * doubling), so an article in eight languages ranks as one eight times
 * its size. One wiki adds nothing: the order is by size alone.
 */
export const WIKI_BOOST = 1;
export const rankWeight = (point) =>
  Math.log2(1 + (point.bytes || 0)) +
  WIKI_BOOST * Math.log2(Math.max(1, wikiCount(point.wikis || 0)));

/**
 * The ranking: primary coordinates before secondary ones (a lower class
 * of their own), then the type class, the article's weight (its size, the
 * better proxy for notability: GeoData's `dim` is often a template's
 * default; and its languages), then the object's size as the tiebreak.
 */
export function rankCompare(a, b) {
  return (
    ((a.flags || 0) & FLAG_SECONDARY) - ((b.flags || 0) & FLAG_SECONDARY) ||
    a.cls - b.cls ||
    rankWeight(b) - rankWeight(a) ||
    (b.dim || 0) - (a.dim || 0) ||
    a.page - b.page ||
    a.x - b.x ||
    a.y - b.y
  );
}

/** A position's tile at a zoom: [tx, ty]. */
export const tileAt = (x, y, zoom) => [
  x >>> (WORLD_BITS - zoom),
  y >>> (WORLD_BITS - zoom),
];

/** A tile's block key inside its file (the overview, or a z 6 bucket). */
export function blockKey(tx, ty, zoom) {
  if (zoom <= OVERVIEW_MAX_ZOOM) return ty * 2 ** zoom + tx;
  const side = 2 ** (zoom - POINTS_BUCKET_ZOOM);
  return (ty % side) * side + (tx % side);
}

/** The bucket (z 6 tile) a tile at a deeper zoom lies in. */
export function bucketOfTile(tx, ty, zoom) {
  const shift = zoom - POINTS_BUCKET_ZOOM;
  return (ty >>> shift) * 2 ** POINTS_BUCKET_ZOOM + (tx >>> shift);
}

/** One block's bytes from its points (already in rank order). */
export function encodeBlock(points) {
  const texts = points.map((p) =>
    Buffer.from(
      `${String(p.title || '').replace(/\0/g, '')}\0${String(p.type || '').replace(/\0/g, '')}`,
      'utf8',
    ),
  );
  let size = 0;
  for (const text of texts) size += RECORD_BYTES + 5 + text.length;
  const out = Buffer.alloc(size);
  let at = 0;
  points.forEach((p, i) => {
    out.writeUInt32LE(p.x, at);
    out.writeUInt32LE(p.y, at + 4);
    out.writeUInt32LE(p.page >>> 0, at + 8);
    out.writeUInt32LE(Math.min(4294967295, p.qid || 0), at + 12);
    out.writeUInt32LE(Math.min(4294967295, p.bytes || 0), at + 16);
    out.writeUInt32LE(Math.min(4294967295, Math.round(p.dim || 0)), at + 20);
    out.writeUInt8(p.cls, at + 24);
    out.writeUInt8(p.flags || 0, at + 25);
    out.writeUInt8(p.wiki || 1, at + 26);
    out.writeUInt32LE((p.wikis || wikiBit(p.wiki || 1)) >>> 0, at + 28);
    at += RECORD_BYTES;
    let n = texts[i].length;
    while (n >= 0x80) {
      out[at++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    out[at++] = n;
    texts[i].copy(out, at);
    at += texts[i].length;
  });
  return out.subarray(0, at);
}

/**
 * Visit a block's points: visit(point) with the fields encodeBlock wrote;
 * `recordBytes` RECORD_BYTES_2 for a format 2 index (its records' wiki
 * mask is their own wiki).
 */
export function eachBlockPoint(buf, visit, recordBytes = RECORD_BYTES) {
  let at = 0;
  while (at + recordBytes <= buf.length) {
    const point = {
      x: buf.readUInt32LE(at),
      y: buf.readUInt32LE(at + 4),
      page: buf.readUInt32LE(at + 8),
      qid: buf.readUInt32LE(at + 12),
      bytes: buf.readUInt32LE(at + 16),
      dim: buf.readUInt32LE(at + 20),
      cls: buf.readUInt8(at + 24),
      flags: buf.readUInt8(at + 25),
      wiki: buf.readUInt8(at + 26),
    };
    point.wikis =
      recordBytes >= RECORD_BYTES
        ? buf.readUInt32LE(at + 28)
        : wikiBit(point.wiki || 1);
    at += recordBytes;
    let length = 0;
    let shift = 0;
    for (;;) {
      const b = buf[at++];
      length += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const [title = '', type = ''] = buf
      .toString('utf8', at, at + length)
      .split('\0');
    at += length;
    point.title = title;
    point.type = type;
    if (visit(point) === false) return;
  }
}

/**
 * Every zoom's blocks from the points (each with x, y on the grid, cls,
 * dim, bytes, page): Map zoom → Map "tx,ty" → points, best first; a tile
 * below the full zoom keeps its best `perTile`.
 */
export function thinPoints(
  points,
  {
    fullZoom = WIKIPEDIA_POINTS_FULL_ZOOM,
    perTile = WIKIPEDIA_POINTS_PER_TILE,
  } = {},
) {
  const ranked = [...points].sort(rankCompare);
  const levels = new Map();
  for (let zoom = 0; zoom <= fullZoom; zoom++) {
    const tiles = new Map();
    const cap = zoom === fullZoom ? Infinity : perTile;
    for (const point of ranked) {
      const [tx, ty] = tileAt(point.x, point.y, zoom);
      const key = ty * 2 ** zoom + tx;
      let list = tiles.get(key);
      if (!list) tiles.set(key, (list = []));
      if (list.length < cap) list.push(point);
    }
    levels.set(zoom, tiles);
  }
  return levels;
}

/**
 * Write the index's files from thinPoints' levels: the overview (zooms
 * 0–6) and one bucket per z 6 tile (zooms 7–12). `fileOf(bucketKey)`
 * names a bucket's file; returns {overview: bytes, buckets: Map key →
 * {bytes, points}}.
 */
export function writePointsFiles(levels, { overviewFile, fileOf }) {
  const overviewBlocks = [];
  const bucketBlocks = new Map();
  for (const [zoom, tiles] of levels)
    for (const [key, list] of tiles) {
      const tx = key % 2 ** zoom;
      const ty = Math.floor(key / 2 ** zoom);
      const block = { zoom, key: blockKey(tx, ty, zoom), list };
      if (zoom <= OVERVIEW_MAX_ZOOM) overviewBlocks.push(block);
      else {
        const bucket = bucketOfTile(tx, ty, zoom);
        if (!bucketBlocks.has(bucket)) bucketBlocks.set(bucket, []);
        bucketBlocks.get(bucket).push(block);
      }
    }
  const write = (file, blocks) => writeBlocksFile(file, blocks);
  const overview = write(overviewFile, overviewBlocks);
  const buckets = new Map();
  for (const [bucket, blocks] of bucketBlocks) {
    const points = blocks
      .filter((block) => block.zoom === WIKIPEDIA_POINTS_FULL_ZOOM)
      .reduce((sum, block) => sum + block.list.length, 0);
    buckets.set(bucket, { bytes: write(fileOf(bucket), blocks), points });
  }
  return { overview, buckets };
}

/**
 * One file of blocks [{zoom, key, list}] in their order, each list's
 * bytes from `encode` (encodeBlock; the build passes its own for records
 * kept as columns); returns the file's size.
 */
export function writeBlocksFile(file, blocks, encode = encodeBlock) {
  // Synced: the index's pointer moves to it only once it is on disk.
  const writer = bucketWriter(file, blocks.length, { sync: true });
  try {
    for (const { zoom, key, list } of blocks)
      writer.add(POINT_KIND + zoom, key, encode(list), list.length);
    return writer.finish();
  } catch (error) {
    writer.abort();
    throw error;
  }
}

export { unitX, unitY, WORLD_BITS };
