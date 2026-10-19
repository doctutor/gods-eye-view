import fs from 'node:fs';
import path from 'node:path';
import { footerFromTail } from './parquet.mjs';
import {
  BUILDINGS,
  OVERTURE_BUCKET,
} from '../../server/providers/overture/sources.js';
import { OPEN_BUILDINGS_BOXES } from '../../src/data/openBuildingsCoverage.js';

/**
 * The first half of the Overture buildings step of `npm run
 * overture:build`: which bytes of the release's 512 building files to
 * fetch. Each file's footer (its row groups' bounding boxes and column
 * chunk offsets) is fetched once and kept under raw/<release>/buildings/
 * footers/; a row group is planned when its box meets a region asked for
 * and is not wholly inside one Open Buildings box (Google's data is used
 * there), and only the columns the step reads are fetched
 * (BUILDING_COLUMNS). The plan is checked against the download cap before
 * anything else is fetched.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/** The columns the step reads (the geometry is most of every file). */
export const BUILDING_COLUMNS = Object.freeze([
  'geometry',
  'height',
  'num_floors',
  'subtype',
  'class',
  'sources.list.element.dataset',
]);
const FILE_NAME = /^part-[0-9]{5}-[0-9a-f-]{36}-c000\.zstd\.parquet$/;

/** Every file under the buildings prefix (the listing is paged). */
export async function listBuildingFiles({ fetchImpl = fetch, userAgent } = {}) {
  const files = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const url = `${OVERTURE_BUCKET}/?list-type=2&prefix=${encodeURIComponent(BUILDINGS.prefix)}${
      token ? `&continuation-token=${encodeURIComponent(token)}` : ''
    }`;
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
    });
    if (!response.ok)
      throw new Error(`Listing ${BUILDINGS.prefix}: HTTP ${response.status}`);
    const xml = await response.text();
    for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1] || '';
      const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1]);
      const name = key.slice(BUILDINGS.prefix.length);
      if (
        key.startsWith(BUILDINGS.prefix) &&
        FILE_NAME.test(name) &&
        Number.isSafeInteger(size) &&
        size > 0
      )
        files.push({ key, name, size });
    }
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(
      xml,
    );
    if (!next) return files.sort((a, b) => a.name.localeCompare(b.name));
    token = next[1].replace(/&amp;/g, '&');
  }
  throw new Error('The buildings listing did not end');
}

/** Fetch a byte range of a bucket object. */
export async function fetchRange(
  key,
  start,
  end,
  { fetchImpl = fetch, userAgent } = {},
) {
  const response = await fetchImpl(`${OVERTURE_BUCKET}/${key}`, {
    headers: { 'User-Agent': userAgent, Range: `bytes=${start}-${end}` },
  });
  if (response.status !== 206)
    throw new Error(`${key}: HTTP ${response.status} for a range`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== end - start + 1)
    throw new Error(
      `${key}: ${body.length} bytes, expected ${end - start + 1}`,
    );
  return body;
}

/** A file's footer (fetched once, then read from footers/). */
export async function fileFooter(file, dir, options = {}) {
  const cached = path.join(dir, 'footers', `${file.name}.footer`);
  let tail = null;
  try {
    tail = fs.readFileSync(cached);
  } catch {
    /* not yet */
  }
  if (!tail) {
    const last = await fetchRange(
      file.key,
      file.size - 8,
      file.size - 1,
      options,
    );
    const length = last.readUInt32LE(0);
    if (length <= 0 || length > 64 * 1024 * 1024)
      throw new Error(`${file.name}: footer of ${length} bytes`);
    tail = await fetchRange(
      file.key,
      file.size - 8 - length,
      file.size - 1,
      options,
    );
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(`${cached}.tmp`, tail);
    fs.renameSync(`${cached}.tmp`, cached);
  }
  return footerFromTail(tail);
}

const statDouble = (bytes) =>
  bytes && bytes.length === 8 ? Buffer.from(bytes).readDoubleLE(0) : NaN;
const meets = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const within = (inner, outer) =>
  inner[0] >= outer[0] &&
  inner[2] <= outer[2] &&
  inner[1] >= outer[1] &&
  inner[3] <= outer[3];

/** A row group's box [west, south, east, north] from its bbox columns' statistics. */
export function rowGroupBox(group) {
  const col = (p) => group.columns.find((c) => c.path === p);
  const box = [
    statDouble(col('bbox.xmin')?.min),
    statDouble(col('bbox.ymin')?.min),
    statDouble(col('bbox.xmax')?.max),
    statDouble(col('bbox.ymax')?.max),
  ];
  return box.every(Number.isFinite) ? box : null;
}

/**
 * The row groups to fetch, with the byte ranges of their columns.
 * @returns {Array<{file, group, rows, box, chunks: Array<{path, start, size}>, bytes}>}
 */
export function planRowGroups(
  files,
  footers,
  regionBoxes,
  { openBuildings = OPEN_BUILDINGS_BOXES } = {},
) {
  const plan = [];
  files.forEach((file, f) => {
    footers[f].rowGroups.forEach((group, g) => {
      const box = rowGroupBox(group);
      if (!box || !regionBoxes.some((region) => meets(box, region))) return;
      if (openBuildings.some((ob) => within(box, ob))) return;
      const chunks = BUILDING_COLUMNS.map((p) => {
        const chunk = group.columns.find((c) => c.path === p);
        if (!chunk) throw new Error(`${file.name}: no column ${p}`);
        return { path: p, start: chunk.start, size: chunk.compressedSize };
      });
      plan.push({
        file: file.name,
        key: file.key,
        group: g,
        rows: group.rows,
        box,
        chunks,
        bytes: chunks.reduce((sum, c) => sum + c.size, 0),
      });
    });
  });
  return plan;
}

/** A planned row group's file name under raw/<release>/buildings/groups/. */
export const rowGroupFile = (dir, entry) =>
  path.join(
    dir,
    'groups',
    `${entry.file.slice(5, 10)}-${String(entry.group).padStart(3, '0')}.rg`,
  );

/**
 * Fetch a planned row group's column chunks (adjacent ones in one range)
 * into one file: a 4-byte header length, the JSON header (file, group,
 * rows, chunks with their offsets in the body), then the chunks' bytes.
 * Skipped when the file is there. Returns the bytes fetched.
 */
export async function fetchRowGroup(entry, dir, options = {}) {
  const target = rowGroupFile(dir, entry);
  if (fs.existsSync(target)) return 0;
  const sorted = [...entry.chunks].sort((a, b) => a.start - b.start);
  const ranges = [];
  for (const chunk of sorted) {
    const last = ranges.at(-1);
    if (last && chunk.start - last.end <= 512 * 1024) {
      last.end = Math.max(last.end, chunk.start + chunk.size);
      last.chunks.push(chunk);
    } else
      ranges.push({
        start: chunk.start,
        end: chunk.start + chunk.size,
        chunks: [chunk],
      });
  }
  const parts = [];
  const header = {
    file: entry.file,
    group: entry.group,
    rows: entry.rows,
    box: entry.box,
    chunks: [],
  };
  let offset = 0;
  let fetched = 0;
  for (const range of ranges) {
    const bytes = await fetchRange(
      entry.key,
      range.start,
      range.end - 1,
      options,
    );
    fetched += bytes.length;
    for (const chunk of range.chunks) {
      parts.push(
        bytes.subarray(
          chunk.start - range.start,
          chunk.start - range.start + chunk.size,
        ),
      );
      header.chunks.push({ path: chunk.path, size: chunk.size, offset });
      offset += chunk.size;
    }
  }
  const head = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(head.length);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    `${target}.partial`,
    Buffer.concat([length, head, ...parts]),
  );
  fs.renameSync(`${target}.partial`, target);
  return fetched;
}

/** A fetched row group: its header and a chunk's bytes by column path. */
export function readRowGroupFile(file) {
  const buffer = fs.readFileSync(file);
  const length = buffer.readUInt32LE(0);
  const header = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
  const body = buffer.subarray(4 + length);
  const chunks = new Map(
    header.chunks.map((c) => [
      c.path,
      body.subarray(c.offset, c.offset + c.size),
    ]),
  );
  return { header, chunk: (p) => chunks.get(p) };
}
