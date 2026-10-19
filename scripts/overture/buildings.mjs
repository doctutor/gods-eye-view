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
import { checkRawDir } from '../rawDir.mjs';
import { createWorkerPool } from './workerPool.mjs';
import { readPartHeader } from './buildingsParts.mjs';
import { gapBoxes } from './openBuildingsGaps.mjs';
import { BUCKET_ZOOM } from '../../server/providers/overture/buildingsFile.js';
import {
  BUILDINGS,
  BUILDINGS_CAP_BYTES,
  BUILDINGS_REGIONS,
  REGIONS,
} from '../../server/providers/overture/sources.js';
import { OVERTURE_LICENSE } from '../../src/data/overtureDivisions.js';
import { OVERTURE_BUILDINGS_ATTRIBUTION } from '../../src/data/overtureBuildings.js';

/**
 * The Overture buildings step of `npm run overture:build` (--buildings):
 * footprints for the Buildings layer outside Google Open Buildings.
 *
 * 1. Plan: the release's 512 building files' footers (fetched once, kept
 *    under raw/<release>/buildings/footers/), and the row groups each
 *    region needs (buildingsPlan.mjs), checked against the cap (25 GB of
 *    column chunks; --cap-gb raises it).
 * 2. Parts: each row group's columns fetched (raw/…/groups/, dropped once
 *    decoded unless --keep-raw) and decoded into a part
 *    (buildings/parts/<region>/), in worker threads. A part on disk is
 *    done: a stopped build repeats nothing finished.
 * 3. Merge: each bucket (z 6 tile) a new part reached is written again
 *    from its earlier file and the parts (buildingsMerge.mjs); then a new
 *    manifest, buildings/current.json pointing at it, and the parts and
 *    replaced files go.
 *
 * Regions add up: a later --regions europe keeps what the earlier ones
 * built, and a building in a region already built is not taken twice.
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

/** The buildings build the server reads now, or null. */
export function currentBuildings(dir) {
  const pointer = readJson(path.join(dir, 'buildings', 'current.json'));
  if (!/^manifest-[0-9a-f]{12}\.json$/.test(pointer?.manifest || ''))
    return null;
  return readJson(path.join(dir, 'buildings', pointer.manifest));
}

/**
 * What a region's buildings were chosen by: 1 everything outside the Open
 * Buildings boxes; 2 also the land inside them Google has no data for
 * (openBuildingsGaps.mjs). A region built under 1 gets a gaps pass.
 */
export const BUILDINGS_RULES = 2;
/** Buckets merged at once. */
const MERGE_CONCURRENCY = 3;

const partId = (entry) =>
  `${entry.file.slice(5, 10)}-${String(entry.group).padStart(3, '0')}`;

const mergeStats = (into, stats) => {
  for (const key of ['read', 'kept', 'withHeight', 'fromFloors', 'skipped'])
    into[key] = (into[key] || 0) + (stats[key] || 0);
  for (const key of ['byDataset', 'bySubtype']) {
    into[key] ||= {};
    for (const [k, v] of Object.entries(stats[key] || {}))
      into[key][k] = (into[key][k] || 0) + v;
  }
  return into;
};

/**
 * @param {{dir: string, regions?: string[], keepRaw?: boolean, capBytes?: number,
 *   workers?: number, userAgent?: string, log?: Function}} options
 */
export async function buildBuildings({
  dir,
  rawRoot = null,
  regions = BUILDINGS_REGIONS,
  keepRaw = false,
  capBytes = BUILDINGS_CAP_BYTES,
  workers = Math.max(2, Math.min(12, os.cpus().length - 2)),
  userAgent,
  log = console.log,
}) {
  const started = Date.now();
  for (const name of regions)
    if (!REGIONS[name]) throw new Error(`unknown region ${name}`);
  const rawDir = path.join(
    rawRoot || path.join(dir, 'raw'),
    BUILDINGS.release,
    'buildings',
  );
  checkRawDir(rawDir);
  const outDir = path.join(dir, 'buildings');
  const previous = currentBuildings(dir);
  const order = [...(previous?.regions || [])];
  for (const name of regions) if (!order.includes(name)) order.push(name);
  const done = previous?.done || {};

  // 1. Plan.
  const files = await listBuildingFiles({ userAgent });
  const footers = [];
  for (let i = 0; i < files.length; i += 16)
    footers.push(
      ...(await Promise.all(
        files
          .slice(i, i + 16)
          .map((file) => fileFooter(file, rawDir, { userAgent })),
      )),
    );
  const tasks = [];
  let toFetch = 0;
  const gaps = gapBoxes();
  for (const name of order) {
    const index = order.indexOf(name);
    const earlier = order.slice(0, index).map((n) => REGIONS[n]);
    // A region built under rule 1 left out the land inside Open Buildings
    // boxes that Google has no data for: a gaps pass adds it.
    const oldRules =
      previous?.regions?.includes(name) &&
      (previous.regionRules?.[name] ?? 1) < BUILDINGS_RULES;
    // Its main pass keeps the plan it was built by (all done); the gaps
    // pass alone takes the gap land, so nothing is taken twice.
    const passes = [
      { key: name, gapsOnly: false, gapBoxes: oldRules ? [] : null },
    ];
    if (oldRules) passes.push({ key: `${name}.gaps`, gapsOnly: true });
    for (const pass of passes) {
      // A row group its gaps pass took is done for the main pass too.
      const doneHere = new Set([
        ...(done[pass.key] || []),
        ...(pass.gapsOnly ? [] : done[`${pass.key}.gaps`] || []),
      ]);
      for (const entry of planRowGroups(files, footers, [REGIONS[name]], {
        gapBoxes: pass.gapBoxes || gaps,
        gapsOnly: pass.gapsOnly,
      })) {
        const id = partId(entry);
        if (doneHere.has(id)) continue;
        const size = files.find((f) => f.name === entry.file).size;
        const partFile = path.join(outDir, 'parts', pass.key, `${id}.part`);
        if (
          !fs.existsSync(partFile) &&
          !fs.existsSync(rowGroupFile(rawDir, entry))
        )
          toFetch += fetchBytes(entry);
        tasks.push({
          region: name,
          pass: pass.key,
          gapsOnly: pass.gapsOnly,
          id,
          entry: { ...entry, size },
          partFile,
          earlier,
          box: REGIONS[name],
        });
      }
    }
  }
  log(
    `[overture] buildings: ${order.join(', ')}; ${tasks.length.toLocaleString('en')} row groups to decode, ${(toFetch / 1e9).toFixed(2)} GB to fetch`,
  );
  if (toFetch > capBytes)
    throw new Error(
      `The buildings need ${(toFetch / 1e9).toFixed(1)} GB of downloads, past the ${(capBytes / 1e9).toFixed(1)} GB cap (--cap-gb)`,
    );
  if (!tasks.length && previous) {
    log('[overture] buildings: nothing new to add');
    return previous;
  }

  // 2. Parts.
  const workerPool = createWorkerPool(workers);
  const t1 = Date.now();
  let fetched = 0;
  let finished = 0;
  const stats = {};
  try {
    await Promise.all(
      tasks.map(async (task) => {
        if (!fs.existsSync(task.partFile)) {
          const result = await workerPool.run('part', {
            entry: task.entry,
            rawDir,
            partFile: task.partFile,
            region: task.box,
            earlier: task.earlier,
            gapsOnly: task.gapsOnly,
            dropRaw: !keepRaw,
            userAgent,
          });
          fetched += result.fetched;
        }
        finished += 1;
        if (finished % 500 === 0)
          log(
            `[overture] buildings: ${finished.toLocaleString('en')} of ${tasks.length.toLocaleString('en')} row groups, ${(fetched / 1e9).toFixed(2)} GB fetched, ${((Date.now() - t1) / 60000).toFixed(1)} min`,
          );
      }),
    );
    const partSeconds = (Date.now() - t1) / 1000;

    // 3. Merge.
    const t2 = Date.now();
    const byBucket = new Map();
    const partsByRegion = {};
    for (const task of tasks) {
      const header = readPartHeader(task.partFile);
      mergeStats((partsByRegion[task.region] ||= {}), header.stats);
      for (const key of Object.keys(header.buckets)) {
        if (!byBucket.has(key)) byBucket.set(key, []);
        byBucket.get(key).push({ file: task.partFile, header });
      }
    }
    const runId = crypto.randomBytes(4).toString('hex');
    const buckets = { ...(previous?.buckets || {}) };
    let merged = 0;
    // A few buckets at a time: a dense one holds a few hundred MB.
    let mergeSlots = MERGE_CONCURRENCY;
    const slotWaiters = [];
    const takeSlot = () =>
      mergeSlots > 0
        ? (mergeSlots--, Promise.resolve())
        : new Promise((resolve) => slotWaiters.push(resolve));
    const giveSlot = () => {
      const next = slotWaiters.shift();
      if (next) next();
      else mergeSlots++;
    };
    await Promise.all(
      [...byBucket].map(async ([key, parts]) => {
        await takeSlot();
        try {
          const bucketKey = Number(key);
          const bx = bucketKey % 2 ** BUCKET_ZOOM;
          const by = Math.floor(bucketKey / 2 ** BUCKET_ZOOM);
          const name = `${bx}-${by}.${runId}.bin`;
          const before = buckets[key]
            ? path.join(outDir, 'buckets', buckets[key].file)
            : null;
          fs.mkdirSync(path.join(outDir, 'buckets'), { recursive: true });
          const result = await workerPool.run('merge', {
            bucketKey,
            previous: before,
            parts,
            target: path.join(outDir, 'buckets', name),
          });
          buckets[key] = {
            file: name,
            buildings: result.buildings,
            bytes: result.bytes,
          };
          merged += 1;
        } finally {
          giveSlot();
        }
        if (merged % 50 === 0)
          log(
            `[overture] buildings: ${merged} of ${byBucket.size} buckets merged`,
          );
      }),
    );
    const mergeSeconds = (Date.now() - t2) / 1000;

    // The manifest, then what it no longer names.
    const doneNext = { ...done };
    for (const task of tasks) (doneNext[task.pass] ||= []).push(task.id);
    const byRegion = { ...(previous?.byRegion || {}) };
    for (const [name, s] of Object.entries(partsByRegion))
      byRegion[name] = mergeStats({ ...(byRegion[name] || {}) }, s);
    const totals = Object.values(byRegion).reduce(
      (into, s) => mergeStats(into, s),
      {},
    );
    const version = crypto
      .createHash('sha256')
      .update(JSON.stringify(buckets))
      .digest('hex')
      .slice(0, 12);
    const manifest = {
      format: 1,
      version,
      builtAt: new Date().toISOString(),
      release: BUILDINGS.release,
      license: OVERTURE_LICENSE,
      attribution: OVERTURE_BUILDINGS_ATTRIBUTION,
      regions: order,
      regionBoxes: Object.fromEntries(order.map((n) => [n, REGIONS[n]])),
      regionRules: Object.fromEntries(order.map((n) => [n, BUILDINGS_RULES])),
      buckets,
      buildings: Object.values(buckets).reduce(
        (sum, b) => sum + b.buildings,
        0,
      ),
      bytes: Object.values(buckets).reduce((sum, b) => sum + b.bytes, 0),
      totals,
      byRegion,
      runs: [
        ...(previous?.runs || []),
        {
          at: new Date().toISOString(),
          regions,
          rowGroups: tasks.length,
          fetchedBytes: fetched,
          seconds: {
            parts: partSeconds,
            merge: mergeSeconds,
            total: (Date.now() - started) / 1000,
          },
        },
      ],
      done: doneNext,
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
    const keep = new Set(Object.values(buckets).map((b) => b.file));
    for (const name of fs.readdirSync(path.join(outDir, 'buckets')))
      if (!keep.has(name))
        try {
          fs.rmSync(path.join(outDir, 'buckets', name));
        } catch {
          /* still open by a server: the next build removes it */
        }
    for (const name of fs.readdirSync(outDir))
      if (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName)
        fs.rmSync(path.join(outDir, name), { force: true });
    for (const name of new Set(tasks.map((task) => task.pass)))
      fs.rmSync(path.join(outDir, 'parts', name), {
        recursive: true,
        force: true,
      });
    log(
      `[overture] buildings ${version}: ${manifest.buildings.toLocaleString('en')} buildings in ${Object.keys(buckets).length} buckets, ${(manifest.bytes / 1e9).toFixed(2)} GB; parts ${(partSeconds / 60).toFixed(1)} min, merge ${(mergeSeconds / 60).toFixed(1)} min`,
    );
    return manifest;
  } finally {
    await workerPool.close();
  }
}

/** What overture:status says about the buildings. */
export function buildingsStatus(dir) {
  const manifest = currentBuildings(dir);
  if (!manifest) return { built: false };
  return {
    built: true,
    version: manifest.version,
    builtAt: manifest.builtAt,
    regions: manifest.regions,
    buildings: manifest.buildings,
    bytes: manifest.bytes,
    buckets: Object.keys(manifest.buckets).length,
    withHeight: manifest.totals?.withHeight || 0,
    byDataset: manifest.totals?.byDataset || {},
    runs: manifest.runs,
  };
}
