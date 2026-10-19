import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchBytes,
  fileFooter,
  listBuildingFiles,
  planRowGroups,
  rowGroupFile,
} from './buildingsPlan.mjs';
import { readPartHeader } from './buildingsParts.mjs';
import { createWorkerPool } from './workerPool.mjs';
import { checkRawDir } from '../rawDir.mjs';
import {
  bucketWriter,
  openBucket,
} from '../../server/providers/overture/buildingsFile.js';
import {
  GLOBAL_RESOLUTIONS,
  PLACE_BUCKET_ZOOM,
  PLACE_KIND,
  encodeCounts,
  eachCountCell,
} from '../../server/providers/overture/placesFile.js';
import {
  PLACES,
  PLACES_CAP_BYTES,
  PLACE_COLUMNS,
  REGIONS,
} from '../../server/providers/overture/sources.js';
import {
  CATEGORY_SLOTS,
  COUNT_THRESHOLDS,
} from '../../src/data/overturePlaces.js';

/**
 * The Overture places step of `npm run overture:build` (--places): the
 * world's points of interest for the Places layer.
 *
 * 1. Plan: the 16 files' footers (fetched once, kept under
 *    raw/<release>/places/footers/), every row group, ten columns
 *    (PLACE_COLUMNS: 4.2 GB of the 11 GB), checked against a 15 GB cap.
 * 2. Parts: each row group's columns fetched and kept under
 *    raw/<release>/places/groups/ (GEV_RAW_DIR's archive when set, so a
 *    rebuild fetches nothing), decoded in worker threads into a part
 *    (placesParts.mjs). A part on disk is done.
 * 3. Merge: each bucket (z 6 tile) written from its parts
 *    (placesMerge.mjs), then the coarse counts (H3 resolutions 0–5) summed
 *    over the buckets into one file, a manifest, and places/current.json
 *    pointing at it; the parts go.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** The places build the server reads now, or null. */
export function currentPlaces(dir) {
  const pointer = readJson(path.join(dir, 'places', 'current.json'));
  if (!/^manifest-[0-9a-f]{12}\.json$/.test(pointer?.manifest || ''))
    return null;
  return readJson(path.join(dir, 'places', pointer.manifest));
}

const partId = (entry) =>
  `${entry.file.slice(5, 10)}-${String(entry.group).padStart(3, '0')}`;

function addStats(into, stats) {
  for (const key of [
    'read',
    'kept',
    'lowConfidence',
    'closed',
    'unnamed',
    'withWebsite',
    'withPhone',
  ])
    into[key] = (into[key] || 0) + (stats[key] || 0);
  for (const key of ['byDataset', 'byCategory']) {
    into[key] ||= {};
    for (const [k, v] of Object.entries(stats[key] || {}))
      into[key][k] = (into[key][k] || 0) + v;
  }
  return into;
}

/** Sum the buckets' coarse count tables into the global counts file. */
export function writeGlobalCounts(bucketFiles, target) {
  const slots = CATEGORY_SLOTS * COUNT_THRESHOLDS.length;
  const writer = bucketWriter(target, GLOBAL_RESOLUTIONS.length);
  let cellsTotal = 0;
  try {
    for (const res of GLOBAL_RESOLUTIONS) {
      const cells = new Map();
      for (const file of bucketFiles) {
        const bucket = openBucket(file);
        try {
          const raw = bucket.block(PLACE_KIND.H, res);
          if (!raw) continue;
          eachCountCell(raw, (cell, lat, lon, counts) => {
            let entry = cells.get(cell);
            if (!entry)
              cells.set(
                cell,
                (entry = { lat, lon, counts: new Uint32Array(slots) }),
              );
            for (const [slot, count] of counts) entry.counts[slot] += count;
          });
        } finally {
          bucket.close();
        }
      }
      cellsTotal += cells.size;
      writer.add(PLACE_KIND.H, res, encodeCounts(cells), cells.size);
    }
  } catch (error) {
    writer.abort();
    throw error;
  }
  return { bytes: writer.finish(), cells: cellsTotal };
}

/**
 * @param {{dir: string, rawRoot?: string|null, keepRaw?: boolean,
 *   capBytes?: number, workers?: number, userAgent?: string, log?: Function,
 *   force?: boolean}} options
 */
export async function buildPlaces({
  dir,
  rawRoot = null,
  keepRaw = true,
  capBytes = PLACES_CAP_BYTES,
  workers = Math.max(2, Math.min(12, os.cpus().length - 2)),
  userAgent,
  log = console.log,
  force = false,
}) {
  const started = Date.now();
  const rawDir = path.join(
    rawRoot || path.join(dir, 'raw'),
    PLACES.release,
    'places',
  );
  checkRawDir(rawDir);
  const outDir = path.join(dir, 'places');
  const previous = currentPlaces(dir);

  // 1. Plan.
  const files = await listBuildingFiles({ userAgent, prefix: PLACES.prefix });
  const footers = await Promise.all(
    files.map((file) => fileFooter(file, rawDir, { userAgent })),
  );
  const plan = planRowGroups(files, footers, [REGIONS.world], {
    openBuildings: [],
    columns: PLACE_COLUMNS,
  });
  const inputs = files.map(({ name, size }) => ({ name, size }));
  const runId = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        format: 1,
        release: PLACES.release,
        inputs,
        columns: PLACE_COLUMNS,
      }),
    )
    .digest('hex')
    .slice(0, 12);
  if (!force && previous?.inputsId === runId) {
    log(
      `[overture] places ${previous.version} is current (${previous.places.toLocaleString('en')} places); --force to redo it`,
    );
    return previous;
  }
  let toFetch = 0;
  const tasks = plan.map((entry) => {
    const id = partId(entry);
    const partFile = path.join(outDir, 'parts', `${id}.part`);
    const size = files.find((f) => f.name === entry.file).size;
    if (!fs.existsSync(partFile) && !fs.existsSync(rowGroupFile(rawDir, entry)))
      toFetch += fetchBytes(entry);
    return { id, entry: { ...entry, size }, partFile };
  });
  log(
    `[overture] places: ${tasks.length.toLocaleString('en')} row groups, ${(toFetch / 1e9).toFixed(2)} GB to fetch into ${rawDir}`,
  );
  if (toFetch > capBytes)
    throw new Error(
      `The places need ${(toFetch / 1e9).toFixed(1)} GB of downloads, past the ${(capBytes / 1e9).toFixed(1)} GB cap (--cap-gb)`,
    );

  // 2. Parts.
  const pool = createWorkerPool(workers);
  try {
    const t1 = Date.now();
    let fetched = 0;
    let finished = 0;
    await Promise.all(
      tasks.map(async (task) => {
        if (!fs.existsSync(task.partFile)) {
          const result = await pool.run('places-part', {
            entry: task.entry,
            rawDir,
            partFile: task.partFile,
            dropRaw: !keepRaw,
            userAgent,
          });
          fetched += result.fetched;
        }
        finished += 1;
        if (finished % 250 === 0)
          log(
            `[overture] places: ${finished.toLocaleString('en')} of ${tasks.length.toLocaleString('en')} row groups, ${(fetched / 1e9).toFixed(2)} GB fetched, ${((Date.now() - t1) / 60000).toFixed(1)} min`,
          );
      }),
    );
    const partSeconds = (Date.now() - t1) / 1000;

    // 3. Merge.
    const t2 = Date.now();
    const byBucket = new Map();
    const stats = {};
    for (const task of tasks) {
      const header = readPartHeader(task.partFile);
      addStats(stats, header.stats);
      for (const key of Object.keys(header.buckets)) {
        if (!byBucket.has(key)) byBucket.set(key, []);
        byBucket.get(key).push({ file: task.partFile, header });
      }
    }
    const stamp = crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(path.join(outDir, 'buckets'), { recursive: true });
    const buckets = {};
    let merged = 0;
    // A few buckets at a time: a dense one holds a few hundred MB.
    const keys = [...byBucket.keys()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, workers) }, async () => {
        while (next < keys.length) {
          const key = keys[next++];
          const bucketKey = Number(key);
          const bx = bucketKey % 2 ** PLACE_BUCKET_ZOOM;
          const by = Math.floor(bucketKey / 2 ** PLACE_BUCKET_ZOOM);
          const name = `${bx}-${by}.${stamp}.bin`;
          const result = await pool.run('places-merge', {
            bucketKey,
            parts: byBucket.get(key),
            target: path.join(outDir, 'buckets', name),
          });
          buckets[key] = {
            file: name,
            places: result.places,
            bytes: result.bytes,
          };
          merged += 1;
          if (merged % 100 === 0)
            log(
              `[overture] places: ${merged} of ${keys.length} buckets merged`,
            );
        }
      }),
    );
    const countsName = `counts.${stamp}.bin`;
    const counts = writeGlobalCounts(
      Object.values(buckets).map((b) => path.join(outDir, 'buckets', b.file)),
      path.join(outDir, countsName),
    );
    const mergeSeconds = (Date.now() - t2) / 1000;
    const version = crypto
      .createHash('sha256')
      .update(JSON.stringify({ buckets, countsName }))
      .digest('hex')
      .slice(0, 12);
    const manifest = {
      format: 1,
      version,
      inputsId: runId,
      builtAt: new Date().toISOString(),
      release: PLACES.release,
      places: Object.values(buckets).reduce((sum, b) => sum + b.places, 0),
      bytes:
        Object.values(buckets).reduce((sum, b) => sum + b.bytes, 0) +
        counts.bytes,
      buckets,
      counts: { file: countsName, cells: counts.cells, bytes: counts.bytes },
      stats,
      fetchedBytes: fetched,
      rawDir,
      seconds: {
        parts: partSeconds,
        merge: mergeSeconds,
        total: (Date.now() - started) / 1000,
      },
    };
    const manifestName = `manifest-${version}.json`;
    fs.writeFileSync(
      path.join(outDir, manifestName),
      `${JSON.stringify(manifest)}\n`,
    );
    const pointer = path.join(outDir, 'current.json');
    fs.writeFileSync(
      `${pointer}.tmp`,
      `${JSON.stringify({ manifest: manifestName })}\n`,
    );
    fs.renameSync(`${pointer}.tmp`, pointer);
    const keep = new Set([...Object.values(buckets).map((b) => b.file)]);
    for (const name of fs.readdirSync(path.join(outDir, 'buckets')))
      if (!keep.has(name))
        try {
          fs.rmSync(path.join(outDir, 'buckets', name));
        } catch {
          /* still open by a server: the next build removes it */
        }
    for (const name of fs.readdirSync(outDir))
      if (
        (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName) ||
        (/^counts\.[0-9a-f]{8}\.bin$/.test(name) && name !== countsName)
      )
        try {
          fs.rmSync(path.join(outDir, name));
        } catch {
          /* still open */
        }
    fs.rmSync(path.join(outDir, 'parts'), { recursive: true, force: true });
    log(
      `[overture] places ${version}: ${manifest.places.toLocaleString('en')} places in ${keys.length} buckets, ${(manifest.bytes / 1e9).toFixed(2)} GB; parts ${(partSeconds / 60).toFixed(1)} min, merge ${(mergeSeconds / 60).toFixed(1)} min`,
    );
    return manifest;
  } finally {
    await pool.close();
  }
}

/** What overture:status says about the places. */
export function placesStatus(dir) {
  const manifest = currentPlaces(dir);
  if (!manifest) return { built: false };
  return {
    built: true,
    version: manifest.version,
    builtAt: manifest.builtAt,
    places: manifest.places,
    bytes: manifest.bytes,
    buckets: Object.keys(manifest.buckets).length,
    rawDir: manifest.rawDir,
    byDataset: manifest.stats?.byDataset || {},
    seconds: manifest.seconds,
  };
}
