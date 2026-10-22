import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { bucketWriter } from '../../server/providers/overture/buildingsFile.js';
import {
  LABEL_ZOOM,
  LINE_ZOOM,
  NAMES_BUCKET_ZOOM,
  NAMES_KIND,
  SOURCE,
  tagOf,
  writeNamesFile,
} from '../../server/providers/riverNames/namesFile.js';
import { inheritNames, nameKey } from './namesMatch.mjs';
import { createLineSpill, encodeLine, readLineSpill } from './namesSpill.mjs';
import { createWorkerPool } from '../overture/workerPool.mjs';

/**
 * `npm run rivers:names`: names for the Rivers layer's reaches from
 * OpenStreetMap's named waterways.
 *
 * 1. Extract (`--extract`, once; osmiumExtractCommands): the planet PBF's
 *    ways tagged waterway=river|stream|canal|drain|ditch, then exported as
 *    GeoJSON lines, through osmium in the Overpass image, writing only
 *    under GEV_RAW_DIR/rivers/names/.
 * 2. The named waterways read (parseWaterway), grouped by Wikidata item
 *    or name, cut into pieces of at most PIECE_POINTS, and spilled by 1°
 *    cell (with a margin for the tolerance) and by z 8 tile (the
 *    sidecar's nearest lines, for HydroRIVERS v1's cards anywhere).
 * 3. The HydroSHEDS v2 reaches (the Americas) read once: their network
 *    (id, the reach below, Strahler order, upstream area) kept in typed
 *    arrays, their lines spilled by the cell of their first point.
 * 4. Each cell matched in worker threads (namesMatch.mjs matchReach),
 *    then the names carried down the main stems (inheritNames).
 * 5. The sidecar (server/providers/riverNames/namesFile.js): names.bin,
 *    bucket files of named lines (OSM's, and the named reaches with their
 *    source: direct or inherited) and label points for Strahler 5 and up,
 *    a manifest with the match rates by order, and current.json.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const WATERWAY_TYPES = Object.freeze([
  'river',
  'stream',
  'canal',
  'drain',
  'ditch',
]);
export const PIECE_POINTS = 48;
/**
 * Degrees a waterway piece is also filed under a neighbouring cell within:
 * a reach is matched in the cell of its first point, and runs on for a
 * few km (and a big river's for tens), so its cell must see the
 * neighbours' waterways that far.
 */
export const CELL_MARGIN_DEGREES = 0.1;
export const MATCH_SAMPLES = 24;
export const LABEL_MIN_STRAHLER = 5;
export const NAMES_FORMAT = 1;

/**
 * The extract's two commands (argv arrays), osmium inside the Overpass
 * image: reads the PBF read-only, writes one file at a time under `outDir`.
 */
export function osmiumExtractCommands({
  pbfDir,
  pbf,
  outDir,
  image = 'wiktorn/overpass-api:0.7.62',
}) {
  const run = (...args) => [
    'docker',
    'run',
    '--rm',
    '-v',
    `${pbfDir}:/osm:ro`,
    '-v',
    `${outDir}:/out`,
    '--entrypoint',
    'osmium',
    image,
    ...args,
  ];
  return [
    run(
      'tags-filter',
      `/osm/${pbf}`,
      `w/waterway=${WATERWAY_TYPES.join(',')}`,
      '-o',
      '/out/waterways.osm.pbf',
      '--overwrite',
    ),
    run(
      'export',
      '/out/waterways.osm.pbf',
      '-f',
      'geojsonseq',
      '-o',
      '/out/waterways.geojsonseq',
      '--overwrite',
    ),
  ];
}

/**
 * One GeoJSON-sequence line's waterway: {name, nameEn, wikidata,
 * waterway, parts: [[lon, lat, …]]}, or null (unnamed, another kind, no
 * line).
 */
export function parseWaterway(line) {
  const text = String(line || '')
    .replace(/^\x1e/, '')
    .trim();
  if (!text) return null;
  let feature;
  try {
    feature = JSON.parse(text);
  } catch {
    return null;
  }
  const props = feature?.properties || {};
  const name = String(props.name || '').trim();
  const waterway = String(props.waterway || '');
  if (!name || !WATERWAY_TYPES.includes(waterway)) return null;
  const geometry = feature.geometry || {};
  const lines =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const parts = lines
    .filter((coords) => Array.isArray(coords) && coords.length >= 2)
    .map((coords) => coords.flatMap(([lon, lat]) => [Number(lon), Number(lat)]))
    .filter((coords) => coords.every(Number.isFinite));
  if (!parts.length) return null;
  return {
    name: name.slice(0, 200),
    nameEn: String(props['name:en'] || '')
      .trim()
      .slice(0, 200),
    wikidata: /^Q\d+$/.test(String(props.wikidata || '')) ? props.wikidata : '',
    waterway,
    parts,
  };
}

/** A line cut into pieces of at most `max` points, sharing their ends. */
export function piecesOf(coords, max = PIECE_POINTS) {
  const out = [];
  for (let start = 0; start + 2 < coords.length; start += (max - 1) * 2)
    out.push(coords.slice(start, Math.min(coords.length, start + max * 2)));
  return out;
}

/** A piece's box: [west, south, east, north]. */
function boxOf(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (let k = 0; k < coords.length; k += 2) {
    w = Math.min(w, coords[k]);
    e = Math.max(e, coords[k]);
    s = Math.min(s, coords[k + 1]);
    n = Math.max(n, coords[k + 1]);
  }
  return [w, s, e, n];
}

/** 1° cell keys: "lon_lat" of the cell's south-west corner. */
export const cellKeyOf = (lon, lat) => `${Math.floor(lon)}_${Math.floor(lat)}`;

/** The 1° cells a box touches, widened by the margin. */
export function cellsOfBox([w, s, e, n], margin = CELL_MARGIN_DEGREES) {
  const keys = [];
  for (let x = Math.floor(w - margin); x <= Math.floor(e + margin); x++)
    for (let y = Math.floor(s - margin); y <= Math.floor(n + margin); y++)
      keys.push(`${x}_${y}`);
  return keys;
}

const WORLD = 2 ** 28;
const mercX = (lon) =>
  Math.min(WORLD - 1, Math.max(0, Math.floor(((lon + 180) / 360) * WORLD)));
function mercY(lat) {
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
  return Math.min(WORLD - 1, Math.max(0, Math.floor(y * WORLD)));
}
/** The tiles at a zoom a box touches: [[tx, ty]]. */
export function tilesOfBox([w, s, e, n], zoom) {
  const shift = 28 - zoom;
  const out = [];
  for (let tx = mercX(w) >>> shift; tx <= mercX(e) >>> shift; tx++)
    for (let ty = mercY(n) >>> shift; ty <= mercY(s) >>> shift; ty++)
      out.push([tx, ty]);
  return out;
}
const bucketOfTile = (tx, ty, zoom) => {
  const shift = zoom - NAMES_BUCKET_ZOOM;
  return (ty >>> shift) * 2 ** NAMES_BUCKET_ZOOM + (tx >>> shift);
};
const blockOfTile = (tx, ty, zoom) => {
  const side = 2 ** (zoom - NAMES_BUCKET_ZOOM);
  return (ty % side) * side + (tx % side);
};

/** Growable typed columns for the network. */
function networkColumns() {
  let size = 1 << 20;
  let down = new Int32Array(size).fill(-1);
  let order = new Uint8Array(size);
  let upland = new Float32Array(size);
  let n = 0;
  return {
    get n() {
      return n;
    },
    set(index, d, o, u) {
      while (index >= size) {
        const grow = (Ctor, old, fill) => {
          const next = new Ctor(size * 2);
          if (fill !== undefined) next.fill(fill);
          next.set(old);
          return next;
        };
        down = grow(Int32Array, down, -1);
        order = grow(Uint8Array, order);
        upland = grow(Float32Array, upland);
        size *= 2;
      }
      down[index] = d;
      order[index] = o;
      upland[index] = u;
      n = Math.max(n, index + 1);
    },
    arrays: () => ({
      down: down.subarray(0, n),
      order: order.subarray(0, n),
      upland: upland.subarray(0, n),
    }),
  };
}

/**
 * The whole build after the extract.
 * @param {{waterways: AsyncIterable<string>|Iterable<string>,
 *   regions: Array<{name: string, forEachReach: (onReach: Function) => Promise<object>}>,
 *   dir: string, tmpDir: string, workers?: number, log?: Function,
 *   now?: () => number, source?: object}} options `regions`: each region's
 *   reach reader (scripts/rivers/sources.mjs forEachReach); `waterways`:
 *   the GeoJSON-sequence lines
 */
export async function buildRiverNames({
  waterways,
  regions,
  dir,
  tmpDir,
  workers = 4,
  log = () => {},
  now = () => Date.now(),
  source = {},
}) {
  const started = now();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const spill = createLineSpill(tmpDir);
  // 2. The waterways.
  const groups = [];
  const groupOf = new Map();
  let ways = 0;
  for await (const line of waterways) {
    const way = parseWaterway(line);
    if (!way) continue;
    ways += 1;
    const key = nameKey(way);
    let group = groupOf.get(key);
    if (group === undefined) {
      group = groups.length;
      groupOf.set(key, group);
      groups.push({
        name: way.name,
        nameEn: way.nameEn,
        wikidata: way.wikidata,
        waterway: way.waterway,
      });
    }
    for (const part of way.parts)
      for (const piece of piecesOf(part)) {
        const box = boxOf(piece);
        const record = encodeLine(group, 0, piece);
        for (const cell of cellsOfBox(box)) spill.add('osm', cell, record);
        const sideRecord = encodeLine(group, tagOf(SOURCE.osm, 0), piece);
        for (const bucket of new Set(
          tilesOfBox(box, LINE_ZOOM).map(([tx, ty]) =>
            bucketOfTile(tx, ty, LINE_ZOOM),
          ),
        ))
          spill.add('side', bucket, sideRecord);
      }
  }
  log(
    `waterways: ${ways.toLocaleString('en-US')} named ways in ${groups.length.toLocaleString('en-US')} names`,
  );

  // 3. The reaches.
  const network = networkColumns();
  const offsets = [];
  let offset = 0;
  let reachCount = 0;
  for (const region of regions) {
    let maxId = 0;
    const regionOffset = offset;
    await region.forEachReach((reach) => {
      const id = Number(reach.id);
      if (!Number.isInteger(id) || id < 0) return;
      maxId = Math.max(maxId, id);
      const index = regionOffset + id;
      const down = Number(reach.down);
      network.set(
        index,
        Number.isInteger(down) && down >= 0 ? regionOffset + down : -1,
        Math.max(1, Math.min(15, Number(reach.strahler) || 1)),
        Number(reach.upland) || 0,
      );
      reachCount += 1;
      for (const part of reach.parts) {
        const coords = Array.from(part);
        if (coords.length < 4) continue;
        spill.add(
          'reach',
          cellKeyOf(coords[0], coords[1]),
          encodeLine(
            index,
            Math.max(1, Math.min(15, Number(reach.strahler) || 1)),
            coords,
          ),
        );
      }
    });
    offsets.push({ region: region.name, offset: regionOffset, maxId });
    offset = regionOffset + maxId + 1;
  }
  log(`reaches: ${reachCount.toLocaleString('en-US')}`);
  const spilled = spill.finish();

  // 4. Matching, a cell a job.
  const { down, order, upland } = network.arrays();
  const direct = new Int32Array(down.length).fill(-1);
  const coverage = new Uint16Array(down.length);
  const cells = [...spilled.files.values()].filter((f) => f.kind === 'reach');
  const pool = createWorkerPool(
    Math.max(1, workers),
    new URL('./namesWorker.mjs', import.meta.url),
  );
  try {
    let done = 0;
    await Promise.all(
      cells.map(async (cell) => {
        const osm = spilled.files.get(`osm/${cell.key}`);
        if (!osm) return;
        const lat0 = Number(cell.key.split('_')[1]) + 0.5;
        const { matches } = await pool.run('names-cell', {
          osmFile: osm.file,
          reachFile: cell.file,
          lat0,
          maxSamples: MATCH_SAMPLES,
        });
        for (let k = 0; k < matches.length; k += 3) {
          const reach = matches[k];
          // A reach in two cells' files (its parts): the better match.
          if (matches[k + 2] > coverage[reach]) {
            direct[reach] = matches[k + 1];
            coverage[reach] = matches[k + 2];
          }
        }
        done += 1;
        if (done % 500 === 0) log(`matched ${done} of ${cells.length} cells`);
      }),
    );
  } finally {
    await pool.close();
  }
  const { names, inherited } = inheritNames({ down, order, upland, direct });

  // The rates by order (only reaches that exist).
  const byOrder = {};
  const exists = new Uint8Array(down.length);
  for (const cell of cells)
    readLineSpill(cell.file, (index) => {
      exists[index] = 1;
    });
  for (let i = 0; i < down.length; i++) {
    if (!exists[i]) continue;
    const entry = (byOrder[order[i]] ||= {
      reaches: 0,
      direct: 0,
      inherited: 0,
    });
    entry.reaches += 1;
    if (direct[i] >= 0) entry.direct += 1;
    else if (names[i] >= 0) entry.inherited += 1;
  }
  const totals = Object.values(byOrder).reduce(
    (sum, e) => ({
      reaches: sum.reaches + e.reaches,
      direct: sum.direct + e.direct,
      inherited: sum.inherited + e.inherited,
    }),
    { reaches: 0, direct: 0, inherited: 0 },
  );

  // 5. The named reaches into the sidecar's spill, and their labels.
  const labels = new Map(); // "bucket/block/group" → {group, tag, at, weight}
  const side = createLineSpill(path.join(tmpDir, 'named'));
  for (const cell of cells)
    readLineSpill(cell.file, (index, strahler, coords) => {
      const group = names[index];
      if (group < 0) return;
      const tag = tagOf(
        inherited[index] ? SOURCE.inherited : SOURCE.direct,
        strahler,
      );
      const box = boxOf(coords);
      const record = encodeLine(group, tag, coords);
      for (const bucket of new Set(
        tilesOfBox(box, LINE_ZOOM).map(([tx, ty]) =>
          bucketOfTile(tx, ty, LINE_ZOOM),
        ),
      ))
        side.add('side', bucket, record);
      if (strahler < LABEL_MIN_STRAHLER) return;
      const mid = Math.floor(coords.length / 4) * 2;
      const at = [coords[mid], coords[mid + 1]];
      const [[tx, ty]] = tilesOfBox([at[0], at[1], at[0], at[1]], LABEL_ZOOM);
      const key = `${bucketOfTile(tx, ty, LABEL_ZOOM)}/${blockOfTile(tx, ty, LABEL_ZOOM)}/${group}`;
      const weight = upland[index];
      const held = labels.get(key);
      if (!held || weight > held.weight)
        labels.set(key, {
          group,
          tag: tagOf(SOURCE.direct, strahler),
          at,
          weight,
        });
    });
  const sideSpilled = side.finish();

  // The sidecar's files.
  const stamp = crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true });
  const bucketFiles = new Map();
  for (const f of [...spilled.files.values(), ...sideSpilled.files.values()])
    if (f.kind === 'side') {
      if (!bucketFiles.has(f.key)) bucketFiles.set(f.key, []);
      bucketFiles.get(f.key).push(f.file);
    }
  const labelBlocks = new Map(); // bucket → Map block → records
  for (const [key, label] of labels) {
    const [bucket, block] = key.split('/');
    if (!labelBlocks.has(bucket)) labelBlocks.set(bucket, new Map());
    const map = labelBlocks.get(bucket);
    if (!map.has(block)) map.set(block, []);
    map.get(block).push(encodeLine(label.group, label.tag, label.at));
  }
  const buckets = {};
  let bytes = 0;
  for (const bucket of new Set([
    ...bucketFiles.keys(),
    ...labelBlocks.keys(),
  ])) {
    const blocks = new Map(); // z 12 block → Buffer[]
    for (const file of bucketFiles.get(bucket) || [])
      readLineSpill(file, (group, tag, coords) => {
        const record = encodeLine(group, tag, coords);
        for (const [tx, ty] of tilesOfBox(boxOf(coords), LINE_ZOOM)) {
          if (String(bucketOfTile(tx, ty, LINE_ZOOM)) !== String(bucket))
            continue;
          const block = blockOfTile(tx, ty, LINE_ZOOM);
          if (!blocks.has(block)) blocks.set(block, []);
          blocks.get(block).push(record);
        }
      });
    const labelMap = labelBlocks.get(bucket) || new Map();
    const name = `${Number(bucket) % 256}-${Math.floor(Number(bucket) / 256)}.${stamp}.bin`;
    const writer = bucketWriter(
      path.join(dir, 'buckets', name),
      blocks.size + labelMap.size,
    );
    try {
      for (const [block, records] of blocks)
        writer.add(
          NAMES_KIND.LINE,
          block,
          Buffer.concat(records),
          records.length,
        );
      for (const [block, records] of labelMap)
        writer.add(
          NAMES_KIND.LABEL,
          Number(block),
          Buffer.concat(records),
          records.length,
        );
      const size = writer.finish();
      buckets[bucket] = { file: name, bytes: size };
      bytes += size;
    } catch (error) {
      writer.abort();
      throw error;
    }
  }
  const namesName = `names.${stamp}.bin`;
  bytes += writeNamesFile(path.join(dir, namesName), groups);
  const rate = (n) =>
    totals.reaches ? Math.round((1000 * n) / totals.reaches) / 10 : 0;
  const manifest = {
    format: NAMES_FORMAT,
    version: crypto
      .createHash('sha256')
      .update(JSON.stringify({ buckets, namesName }))
      .digest('hex')
      .slice(0, 12),
    builtAt: new Date(now()).toISOString(),
    source,
    names: { file: namesName, groups: groups.length, ways },
    regions: offsets,
    buckets,
    bytes,
    rates: {
      byOrder,
      reaches: totals.reaches,
      direct: totals.direct,
      inherited: totals.inherited,
      directPercent: rate(totals.direct),
      namedPercent: rate(totals.direct + totals.inherited),
    },
    labels: labels.size,
    spillBytes: spilled.bytes + sideSpilled.bytes,
    seconds: (now() - started) / 1000,
  };
  const manifestName = `manifest-${manifest.version}.json`;
  fs.writeFileSync(
    path.join(dir, manifestName),
    `${JSON.stringify(manifest)}\n`,
  );
  const pointer = path.join(dir, 'current.json');
  fs.writeFileSync(
    `${pointer}.tmp`,
    `${JSON.stringify({ manifest: manifestName })}\n`,
  );
  fs.renameSync(`${pointer}.tmp`, pointer);
  for (const name of fs.readdirSync(dir))
    if (
      (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName) ||
      (/^names\.[0-9a-f]{8}\.bin$/.test(name) && name !== namesName)
    )
      fs.rmSync(path.join(dir, name), { force: true });
  const keep = new Set(Object.values(buckets).map((b) => b.file));
  for (const name of fs.readdirSync(path.join(dir, 'buckets')))
    if (!keep.has(name))
      fs.rmSync(path.join(dir, 'buckets', name), { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log(
    `names ${manifest.version}: ${totals.reaches.toLocaleString('en-US')} reaches, ${manifest.rates.directPercent}% named from OSM, ${manifest.rates.namedPercent}% with the main stems; ${(bytes / 1e6).toFixed(1)} MB`,
  );
  return manifest;
}

/** Lines of a file as an async iterable (the extract's GeoJSON sequence). */
export function linesOf(file) {
  return readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}
