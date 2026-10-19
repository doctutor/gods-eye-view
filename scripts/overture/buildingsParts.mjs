import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readColumnChunk, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import {
  BLOCK_ZOOM,
  BUCKET_ZOOM,
  WORLD_BITS,
  WORLD_UNITS,
  Writer,
  encodeBuilding,
  latOfUnitY,
  unitX,
  unitY,
} from '../../server/providers/overture/buildingsFile.js';
import { inOpenBuildings } from '../../src/data/openBuildingsCoverage.js';
import { openBuildingsDraws } from './openBuildingsGaps.mjs';

/**
 * The second half of the Overture buildings step: one fetched row group →
 * one part file, its buildings encoded (buildingsFile.js) and grouped by
 * bucket and z 14 tile. A building is kept when its centre is in the
 * region, in no region done before it (regions add up), and where Open
 * Buildings draws nothing: outside its boxes, or inside one but in a
 * country it has no data for (openBuildingsGaps.mjs). Its height is Overture's `height`, else 3 m a floor
 * (`num_floors`), else unknown.
 *
 * Part file: Uint32 header length, the JSON header (region, row group,
 * stats, and per bucket its section's offset and lengths), then each
 * bucket's section, zstd: per z 14 tile Uint32 key (x + 256 y within the
 * bucket), Uint32 length, the buildings' bytes.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const BLOCK_SHIFT = WORLD_BITS - BLOCK_ZOOM;
const BUCKET_SHIFT = WORLD_BITS - BUCKET_ZOOM;
const LOCAL_BLOCKS = 2 ** (BLOCK_ZOOM - BUCKET_ZOOM);
/** A floor, when only the floors are known. */
export const FLOOR_M = 3;

const inBox = (lon, lat, [west, south, east, north]) =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/** The polygons of a WKB Polygon or MultiPolygon, as rings of [x, y] units, or null. */
export function wkbPolygons(wkb) {
  if (!wkb || wkb.length < 9) return null;
  let pos = 0;
  const polygons = [];
  const readPolygon = () => {
    const little = wkb[pos] === 1;
    const type = little ? wkb.readUInt32LE(pos + 1) : wkb.readUInt32BE(pos + 1);
    pos += 5;
    if (type !== 3) return false;
    const u32 = () => {
      const v = little ? wkb.readUInt32LE(pos) : wkb.readUInt32BE(pos);
      pos += 4;
      return v;
    };
    const f64 = () => {
      const v = little ? wkb.readDoubleLE(pos) : wkb.readDoubleBE(pos);
      pos += 8;
      return v;
    };
    const rings = [];
    const ringCount = u32();
    for (let r = 0; r < ringCount; r++) {
      const n = u32();
      const ring = [];
      let lastX = -1;
      let lastY = -1;
      for (let i = 0; i < n; i++) {
        const x = unitX(f64());
        const y = unitY(f64());
        if (x === lastX && y === lastY) continue;
        ring.push(x, y);
        lastX = x;
        lastY = y;
      }
      // Not closed: the last vertex repeats the first.
      if (
        ring.length >= 4 &&
        ring[0] === ring[ring.length - 2] &&
        ring[1] === ring[ring.length - 1]
      )
        ring.length -= 2;
      if (ring.length >= 6) rings.push(ring);
      else if (r === 0) return true; // a degenerate outer ring: the polygon goes
    }
    if (rings.length) polygons.push(rings);
    return true;
  };
  const little = wkb[0] === 1;
  const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
  if (type === 3) {
    if (!readPolygon()) return null;
  } else if (type === 6) {
    pos = 5;
    const count = little ? wkb.readUInt32LE(pos) : wkb.readUInt32BE(pos);
    pos += 4;
    for (let p = 0; p < count; p++) if (!readPolygon()) return null;
  } else return null;
  return polygons.length ? polygons : null;
}

/** A building's height in metres: `height`, else floors × FLOOR_M, else 0. */
export function buildingHeight(height, floors) {
  const h = Number(height);
  if (h > 0 && h < 1000) return Math.max(1, Math.min(255, Math.round(h)));
  const f = Number(floors);
  if (f > 0 && f < 200)
    return Math.max(1, Math.min(255, Math.round(f * FLOOR_M)));
  return 0;
}

/**
 * Decode a fetched row group into a part.
 * @param {{header: object, chunk: (path: string) => Buffer}} group readRowGroupFile's
 * @param {object} footer the file's footer (leaves and chunk metadata)
 * @param {{region: number[], earlier?: number[][], outsideOpenBuildings?: boolean,
 *   gapsOnly?: boolean}} filter `gapsOnly` keeps only the buildings inside an
 *   Open Buildings box in a country it has no data for (a region built before
 *   rule 2 left them out); `outsideOpenBuildings: false` keeps buildings
 *   inside the Open Buildings
 *   boxes too (to compare the two sources)
 */
export function decodeRowGroup(
  group,
  footer,
  { region, earlier = [], outsideOpenBuildings = true, gapsOnly = false },
) {
  const meta = footer.rowGroups[group.header.group];
  const column = (p) => {
    const chunk = meta.columns.find((c) => c.path === p);
    const leaf = footer.leaves.find((l) => l.path === p);
    return { values: readColumnChunk(group.chunk(p), chunk, leaf), leaf };
  };
  const flat = (p) => {
    const { values, leaf } = column(p);
    return rowsOfFlat(values, leaf);
  };
  const geometry = flat('geometry');
  const height = flat('height');
  const floors = flat('num_floors');
  const subtype = flat('subtype');
  const dataset = (() => {
    const { values, leaf } = column('sources.list.element.dataset');
    return rowsOfRepeated(values, { ...leaf, elementDef: leaf.maxDef - 1 });
  })();
  const rows = geometry.length;
  if (
    height.length !== rows ||
    floors.length !== rows ||
    subtype.length !== rows ||
    dataset.length !== rows
  )
    throw new Error(
      `${group.header.file} row group ${group.header.group}: columns disagree`,
    );
  const buckets = new Map(); // bucket key → Map(local block key → Writer)
  const stats = {
    read: rows,
    kept: 0,
    withHeight: 0,
    fromFloors: 0,
    byDataset: {},
    bySubtype: {},
    skipped: 0,
  };
  for (let i = 0; i < rows; i++) {
    const polygons = wkbPolygons(geometry[i]);
    if (!polygons) {
      stats.skipped += 1;
      continue;
    }
    const outer = polygons[0][0];
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < outer.length; k += 2) {
      cx += outer[k];
      cy += outer[k + 1];
    }
    cx = Math.floor(cx / (outer.length / 2));
    cy = Math.floor(cy / (outer.length / 2));
    const lon = (cx / WORLD_UNITS) * 360 - 180;
    const lat = latOfUnitY(cy);
    if (!inBox(lon, lat, region)) continue;
    if (earlier.some((box) => inBox(lon, lat, box))) continue;
    if (gapsOnly) {
      if (!inOpenBuildings(lat, lon) || openBuildingsDraws(lat, lon)) continue;
    } else if (outsideOpenBuildings && openBuildingsDraws(lat, lon)) continue;
    const h = buildingHeight(height[i], floors[i]);
    stats.kept += 1;
    if (h) {
      stats.withHeight += 1;
      if (!(Number(height[i]) > 0)) stats.fromFloors += 1;
    }
    const source = dataset[i]?.[0] ? String(dataset[i][0]) : 'unknown';
    stats.byDataset[source] = (stats.byDataset[source] || 0) + 1;
    const kind = subtype[i] ? String(subtype[i]) : 'none';
    stats.bySubtype[kind] = (stats.bySubtype[kind] || 0) + 1;
    const bx = cx >>> BUCKET_SHIFT;
    const by = cy >>> BUCKET_SHIFT;
    const bucketKey = by * 2 ** BUCKET_ZOOM + bx;
    const tx = cx >>> BLOCK_SHIFT;
    const ty = cy >>> BLOCK_SHIFT;
    const local = (ty % LOCAL_BLOCKS) * LOCAL_BLOCKS + (tx % LOCAL_BLOCKS);
    let blocks = buckets.get(bucketKey);
    if (!blocks) buckets.set(bucketKey, (blocks = new Map()));
    let writer = blocks.get(local);
    if (!writer) blocks.set(local, (writer = new Writer(4096)));
    encodeBuilding(
      writer,
      { height: h, polygons },
      tx << BLOCK_SHIFT,
      ty << BLOCK_SHIFT,
    );
  }
  return { buckets, stats };
}

/** Write a part file (atomically). */
export function writePart(file, header, buckets) {
  const sections = [];
  const index = {};
  let offset = 0;
  for (const [bucketKey, blocks] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const pieces = [];
    for (const [local, writer] of [...blocks].sort((a, b) => a[0] - b[0])) {
      const body = writer.done();
      const head = Buffer.alloc(8);
      head.writeUInt32LE(local, 0);
      head.writeUInt32LE(body.length, 4);
      pieces.push(head, body);
    }
    const raw = Buffer.concat(pieces);
    const section = zlib.zstdCompressSync(raw, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    });
    index[bucketKey] = {
      offset,
      length: section.length,
      rawLength: raw.length,
      blocks: blocks.size,
    };
    sections.push(section);
    offset += section.length;
  }
  const head = Buffer.from(JSON.stringify({ ...header, buckets: index }));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(head.length);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, Buffer.concat([length, head, ...sections]));
  fs.renameSync(temporary, file);
  return 4 + head.length + offset;
}

/** A part file's header (without its sections). */
export function readPartHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const length = Buffer.alloc(4);
    fs.readSync(fd, length, 0, 4, 0);
    const head = Buffer.alloc(length.readUInt32LE(0));
    fs.readSync(fd, head, 0, head.length, 4);
    return {
      ...JSON.parse(head.toString('utf8')),
      bodyOffset: 4 + head.length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** One bucket's blocks from a part: [{local, bytes}]. */
export function readPartBucket(file, header, bucketKey) {
  const entry = header.buckets[bucketKey];
  if (!entry) return [];
  const fd = fs.openSync(file, 'r');
  let raw;
  try {
    const body = Buffer.alloc(entry.length);
    fs.readSync(fd, body, 0, entry.length, header.bodyOffset + entry.offset);
    raw = zlib.zstdDecompressSync(body);
  } finally {
    fs.closeSync(fd);
  }
  const out = [];
  for (let at = 0; at < raw.length;) {
    const local = raw.readUInt32LE(at);
    const length = raw.readUInt32LE(at + 4);
    out.push({ local, bytes: raw.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  return out;
}
