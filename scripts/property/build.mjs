import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openParquet } from '../overture/parquet.mjs';
import { createWorkerPool } from '../overture/workerPool.mjs';
import { writeHexFile } from '../../server/providers/property/hexFile.js';
import { PROPERTY_BUCKET_ZOOM } from '../../server/providers/property/file.js';
import {
  PRICE_FLOOR_USD,
  PRICE_SINCE_YEAR,
  PROPERTY_CREDIT_TEXT,
  PROPERTY_LICENSE,
  PROPERTY_SOURCE,
} from '../../src/data/propertySales.js';
import { createSpill } from './parts.mjs';
import {
  COARSE_RESOLUTIONS,
  FINE_RESOLUTIONS,
  coarseRows,
  tableOf,
} from './hexes.mjs';

/**
 * `npm run property:build`: the Property sales layer's index from
 * realestatedataset.com's Parquet file (146.6 M rows in 1,184 row groups),
 * streamed a row group at a time:
 *
 * 1. Parts: each row group read (the public-record columns only), cleaned
 *    and sorted (parts.mjs) by worker threads, and spilled by this thread
 *    to one file per bucket and per hexagon partition (under `tmpDir`).
 * 2. Buckets: each z 10 tile's buildings and records (merge.mjs).
 * 3. Hexagons: each resolution-3 cell's medians, then the coarse
 *    resolutions from histograms (hexes.mjs), into one file.
 * 4. A manifest, and current.json naming it; the spill goes.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const BUILD_FORMAT = 1;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** The build the server reads now, or null. */
export function currentProperty(dir) {
  const pointer = readJson(path.join(dir, 'current.json'));
  if (!/^manifest-[0-9a-f]{12}\.json$/.test(pointer?.manifest || ''))
    return null;
  return readJson(path.join(dir, pointer.manifest));
}

/** Row groups from "a-b,c" (or all of them). */
export function parseGroups(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i);
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const [a, b = a] = part.split('-').map((v) => Number(v.trim()));
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a)
      throw new Error(`bad row groups ${spec}`);
    for (let g = a; g <= Math.min(b, total - 1); g++) out.add(g);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * @param {{file: string, dir: string, tmpDir?: string, groups?: string,
 *   workers?: number, merges?: number, workerHeapMb?: number,
 *   spillBudgetMb?: number, force?: boolean, keepSpill?: boolean,
 *   log?: Function, today?: string}} options `tmpDir`: where the spill
 *   goes (default dir/tmp); `merges`: buckets merged at once
 */
export async function buildProperty({
  file,
  dir,
  groups: groupSpec = '',
  workers = Math.max(2, Math.min(10, os.cpus().length - 2)),
  merges = 2,
  workerHeapMb = 768,
  spillBudgetMb = 256,
  tmpDir = '',
  force = false,
  keepSpill = false,
  log = console.log,
  today = new Date().toISOString().slice(0, 10),
}) {
  const started = Date.now();
  const stat = fs.statSync(file);
  const parquet = openParquet(file);
  const total = parquet.rowGroups.length;
  const rows = parquet.rows;
  parquet.close();
  const groups = parseGroups(groupSpec, total);
  const inputsId = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        format: BUILD_FORMAT,
        name: path.basename(file),
        size: stat.size,
        rows,
        groups: groupSpec ? groups : 'all',
      }),
    )
    .digest('hex')
    .slice(0, 12);
  const previous = currentProperty(dir);
  if (!force && previous?.inputsId === inputsId) {
    log(
      `[property] ${previous.version} is current (${previous.buildings.toLocaleString('en')} buildings); --force to redo it`,
    );
    return previous;
  }
  fs.mkdirSync(dir, { recursive: true });
  // The spill starts empty: its files are appended to.
  const spillDir = path.join(
    tmpDir || path.join(dir, 'tmp'),
    `spill-${inputsId}`,
  );
  fs.rmSync(spillDir, { recursive: true, force: true });
  const spill = createSpill(spillDir, { budgetBytes: spillBudgetMb * 2 ** 20 });
  log(
    `[property] ${groups.length.toLocaleString('en')} of ${total.toLocaleString('en')} row groups of ${path.basename(file)} (${(stat.size / 1e9).toFixed(1)} GB) with ${workers} workers into ${dir}, spilling to ${spillDir}`,
  );

  // A worker's heap is capped: a row group's columns are a few hundred MB,
  // and the machine is shared (Docker's VM holds half of it).
  const pool = createWorkerPool(
    workers,
    new URL('./worker.mjs', import.meta.url),
    {
      resourceLimits: { maxOldGenerationSizeMb: workerHeapMb },
    },
  );
  try {
    // 1. Parts, spilled as they come (one writer: the spill's disk may be
    // an external spinning one).
    const t1 = Date.now();
    const stats = {};
    let done = 0;
    await Promise.all(
      groups.map(async (group) => {
        const part = await pool.run('property-part', { file, group, today });
        for (const [key, value] of Object.entries(part.stats))
          stats[key] = (stats[key] || 0) + value;
        spill.add(part);
        done += 1;
        if (done % 50 === 0 || done === groups.length)
          log(
            `[property] parts: ${done} of ${groups.length}, ${((Date.now() - t1) / 60000).toFixed(1)} min`,
          );
      }),
    );
    const spilled = spill.finish();
    const partSeconds = (Date.now() - t1) / 1000;
    log(
      `[property] ${stats.kept.toLocaleString('en')} of ${stats.rows.toLocaleString('en')} records kept (${stats.noCoordinates.toLocaleString('en')} without coordinates, ${stats.outside.toLocaleString('en')} outside their state); spill ${(spilled.bytes / 1e9).toFixed(2)} GB in ${(partSeconds / 60).toFixed(1)} min`,
    );

    // 2. Buckets, the largest first (a few at a time: one holds a city).
    const t2 = Date.now();
    const stamp = crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true });
    const keys = [...spilled.buckets.keys()].sort(
      (a, b) => spilled.buckets.get(b).count - spilled.buckets.get(a).count,
    );
    const buckets = {};
    let next = 0;
    let merged = 0;
    await Promise.all(
      Array.from({ length: Math.min(merges, workers) }, async () => {
        while (next < keys.length) {
          const key = keys[next++];
          const bx = Number(key) % 2 ** PROPERTY_BUCKET_ZOOM;
          const by = Math.floor(Number(key) / 2 ** PROPERTY_BUCKET_ZOOM);
          const name = `${bx}-${by}.${stamp}.bin`;
          const result = await pool.run('property-merge', {
            spill: spilled.buckets.get(key).file,
            target: path.join(dir, 'buckets', name),
          });
          buckets[key] = {
            file: name,
            buildings: result.buildings,
            records: result.records,
            bytes: result.bytes,
          };
          merged += 1;
          if (merged % 50 === 0 || merged === keys.length)
            log(
              `[property] buckets: ${merged} of ${keys.length}, ${((Date.now() - t2) / 60000).toFixed(1)} min`,
            );
        }
      }),
    );
    const mergeSeconds = (Date.now() - t2) / 1000;

    // 3. Hexagons.
    const t3 = Date.now();
    const fine = Object.fromEntries(FINE_RESOLUTIONS.map((res) => [res, []]));
    const histograms = new Map();
    await Promise.all(
      [...spilled.cells].map(async ([key, { file: cells }]) => {
        const result = await pool.run('property-hexes', { spill: cells });
        for (const res of FINE_RESOLUTIONS)
          for (const row of result.rows[res]) fine[res].push(row);
        histograms.set(Number(key), result.histograms);
      }),
    );
    const coarse = coarseRows(histograms);
    const tables = [
      ...COARSE_RESOLUTIONS.map((res) => tableOf(res, coarse[res])),
      ...FINE_RESOLUTIONS.map((res) => tableOf(res, fine[res])),
    ];
    const hexName = `hexes.${stamp}.bin`;
    const hex = writeHexFile(path.join(dir, hexName), {
      header: {
        builtAt: new Date().toISOString(),
        priceSinceYear: PRICE_SINCE_YEAR,
        priceFloorUsd: PRICE_FLOOR_USD,
      },
      tables,
    });
    const hexSeconds = (Date.now() - t3) / 1000;

    // 4. The manifest.
    const version = crypto
      .createHash('sha256')
      .update(JSON.stringify({ buckets, hexName }))
      .digest('hex')
      .slice(0, 12);
    const bucketBytes = Object.values(buckets).reduce((s, b) => s + b.bytes, 0);
    const manifest = {
      format: BUILD_FORMAT,
      version,
      inputsId,
      builtAt: new Date().toISOString(),
      source: {
        name: path.basename(file),
        size: stat.size,
        rows,
        rowGroups: total,
        groups: groupSpec ? groups.length : total,
        publisher: PROPERTY_SOURCE,
        license: PROPERTY_LICENSE,
      },
      attribution: PROPERTY_CREDIT_TEXT,
      records: Object.values(buckets).reduce((s, b) => s + b.records, 0),
      buildings: Object.values(buckets).reduce((s, b) => s + b.buildings, 0),
      bytes: bucketBytes + hex.bytes,
      buckets,
      hexes: {
        file: hexName,
        bytes: hex.bytes,
        cells: Object.fromEntries(
          hex.header.resolutions.map((entry) => [entry.res, entry.cells]),
        ),
      },
      stats,
      spillBytes: spilled.bytes,
      seconds: {
        parts: partSeconds,
        merge: mergeSeconds,
        hexes: hexSeconds,
        total: (Date.now() - started) / 1000,
      },
    };
    const manifestName = `manifest-${version}.json`;
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
    // What the earlier builds left.
    const keep = new Set(Object.values(buckets).map((b) => b.file));
    for (const name of fs.readdirSync(path.join(dir, 'buckets')))
      if (!keep.has(name))
        try {
          fs.rmSync(path.join(dir, 'buckets', name));
        } catch {
          /* still open by a server: the next build removes it */
        }
    for (const name of fs.readdirSync(dir))
      if (
        (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName) ||
        (/^hexes\.[0-9a-f]{8}\.bin$/.test(name) && name !== hexName)
      )
        try {
          fs.rmSync(path.join(dir, name));
        } catch {
          /* still open */
        }
    if (!keepSpill) fs.rmSync(spillDir, { recursive: true, force: true });
    log(
      `[property] ${version}: ${manifest.buildings.toLocaleString('en')} buildings of ${manifest.records.toLocaleString('en')} records in ${keys.length} buckets, ${(bucketBytes / 1e9).toFixed(2)} GB; hexagons ${(hex.bytes / 1e6).toFixed(1)} MB; parts ${(partSeconds / 60).toFixed(1)} min, buckets ${(mergeSeconds / 60).toFixed(1)} min, hexagons ${(hexSeconds / 60).toFixed(1)} min`,
    );
    return manifest;
  } finally {
    await pool.close();
  }
}

/** What property:status says. */
export function propertyStatus(dir) {
  const manifest = currentProperty(dir);
  if (!manifest) return { built: false };
  return {
    built: true,
    version: manifest.version,
    builtAt: manifest.builtAt,
    source: manifest.source,
    records: manifest.records,
    buildings: manifest.buildings,
    bytes: manifest.bytes,
    buckets: Object.keys(manifest.buckets).length,
    hexes: manifest.hexes,
    stats: manifest.stats,
    seconds: manifest.seconds,
  };
}
