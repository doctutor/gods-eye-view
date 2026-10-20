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
import { containerOf } from '../../server/providers/overture/roadsFile.js';
import {
  REGIONS,
  ROADS,
  ROADS_CAP_BYTES,
  ROADS_REGIONS,
  ROAD_COLUMNS,
} from '../../server/providers/overture/sources.js';
import { OVERTURE_LICENSE } from '../../src/data/overtureDivisions.js';
import {
  OVERTURE_ROADS_ATTRIBUTION,
  ROAD_LEVELS,
} from '../../src/data/overtureRoads.js';

/**
 * The Overture roads step of `npm run overture:build` (--roads): road
 * segments for the Roads layer and Street assets' bike lanes.
 *
 * 1. Plan: the release's 128 segment files' footers (fetched once, kept
 *    under raw/<release>/roads/footers/), the row groups meeting each
 *    region, and the bytes of the columns read (ROAD_COLUMNS, about half
 *    of each row group), checked against the cap (60 GB; --cap-gb).
 * 2. Parts: each row group's columns fetched (raw/<release>/roads/groups/,
 *    kept for a rebuild unless --drop-raw) and decoded into a part
 *    (roads/parts/<region>/; roadsParts.mjs), in worker threads. A part on
 *    disk is done: a stopped build repeats nothing finished.
 * 3. Merge: each container (a level's z `container` tile) a new part
 *    reached is written again from its earlier file and the parts
 *    (roadsMerge.mjs); then a new manifest, roads/current.json pointing at
 *    it, and the parts and replaced files go.
 *
 * Regions add up: a later --road-regions europe keeps what the earlier
 * ones built, and a road in a region already built is not taken twice.
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

/** The roads build the server reads now (in the roads directory), or null. */
export function currentRoads(roadsDir) {
  const pointer = readJson(path.join(roadsDir, 'current.json'));
  if (!/^manifest-[0-9a-f]{12}\.json$/.test(pointer?.manifest || ''))
    return null;
  return readJson(path.join(roadsDir, pointer.manifest));
}

/** Bumped when what a part holds changes: parts and builds of another format are redone. */
export const ROADS_FORMAT = 1;
/** Containers merged at once. */
const MERGE_CONCURRENCY = 4;

/** A fetch tried again on failure (a dropped connection), up to five times. */
async function withRetries(attempt) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (i >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
}

const partId = (entry) =>
  `${entry.file.slice(5, 10)}-${String(entry.group).padStart(3, '0')}`;

const mergeStats = (into, stats) => {
  for (const key of [
    'read',
    'kept',
    'pieces',
    'named',
    'withSpeed',
    'withSurface',
    'bikeDesignated',
    'skipped',
  ])
    into[key] = (into[key] || 0) + (stats[key] || 0);
  for (const key of ['byClass', 'byDataset']) {
    into[key] ||= {};
    for (const [k, v] of Object.entries(stats[key] || {}))
      into[key][k] = (into[key][k] || 0) + v;
  }
  return into;
};

/**
 * @param {{dir: string, roadsDir?: string, rawRoot?: string, regions?: string[],
 *   keepRaw?: boolean, capBytes?: number, workers?: number, userAgent?: string,
 *   log?: Function}} options `roadsDir`: where the build goes
 *   (overtureRoadsDir: OVERTURE_ROADS_DIR, else roads/ in `dir`).
 */
export async function buildRoads({
  dir,
  roadsDir = path.join(dir, 'roads'),
  rawRoot = null,
  regions = ROADS_REGIONS,
  keepRaw = true,
  capBytes = ROADS_CAP_BYTES,
  workers = Math.max(2, Math.min(12, os.cpus().length - 2)),
  userAgent,
  log = console.log,
}) {
  const started = Date.now();
  for (const name of regions)
    if (!REGIONS[name]) throw new Error(`unknown region ${name}`);
  const rawDir = path.join(
    rawRoot || path.join(dir, 'raw'),
    ROADS.release,
    'roads',
  );
  checkRawDir(rawDir);
  const outDir = roadsDir;
  const previous = currentRoads(outDir);
  if (previous && previous.format !== ROADS_FORMAT)
    throw new Error(
      `The roads build is format ${previous.format}, not ${ROADS_FORMAT}: remove ${outDir} and build again`,
    );
  const order = [...(previous?.regions || [])];
  for (const name of regions) if (!order.includes(name)) order.push(name);
  const done = previous?.done || {};

  // 1. Plan.
  const files = await withRetries(() =>
    listBuildingFiles({ userAgent, prefix: ROADS.prefix }),
  );
  const footers = [];
  for (let i = 0; i < files.length; i += 16)
    footers.push(
      ...(await Promise.all(
        files
          .slice(i, i + 16)
          .map((file) =>
            withRetries(() => fileFooter(file, rawDir, { userAgent })),
          ),
      )),
    );
  const tasks = [];
  let toFetch = 0;
  for (const name of order) {
    const earlier = order.slice(0, order.indexOf(name)).map((n) => REGIONS[n]);
    const doneHere = new Set(done[name] || []);
    for (const entry of planRowGroups(files, footers, [REGIONS[name]], {
      openBuildings: [],
      columns: ROAD_COLUMNS,
    })) {
      const id = partId(entry);
      if (doneHere.has(id)) continue;
      const size = files.find((f) => f.name === entry.file).size;
      const partFile = path.join(outDir, 'parts', name, `${id}.part`);
      if (
        !fs.existsSync(partFile) &&
        !fs.existsSync(rowGroupFile(rawDir, entry))
      )
        toFetch += fetchBytes(entry);
      tasks.push({
        region: name,
        id,
        entry: { ...entry, size },
        partFile,
        earlier,
        box: REGIONS[name],
      });
    }
  }
  log(
    `[overture] roads: ${order.join(', ')}; ${tasks.length.toLocaleString('en')} row groups to decode, ${(toFetch / 1e9).toFixed(2)} GB to fetch`,
  );
  if (toFetch > capBytes)
    throw new Error(
      `The roads need ${(toFetch / 1e9).toFixed(1)} GB of downloads, past the ${(capBytes / 1e9).toFixed(1)} GB cap (--cap-gb)`,
    );
  if (!tasks.length && previous) {
    log('[overture] roads: nothing new to add');
    return previous;
  }

  // 2. Parts.
  const workerPool = createWorkerPool(workers);
  const t1 = Date.now();
  let fetched = 0;
  let finished = 0;
  try {
    await Promise.all(
      tasks.map(async (task) => {
        if (!fs.existsSync(task.partFile)) {
          const result = await workerPool.run('roads-part', {
            entry: task.entry,
            rawDir,
            partFile: task.partFile,
            region: task.box,
            earlier: task.earlier,
            dropRaw: !keepRaw,
            userAgent,
          });
          fetched += result.fetched;
        }
        finished += 1;
        if (finished % 200 === 0)
          log(
            `[overture] roads: ${finished.toLocaleString('en')} of ${tasks.length.toLocaleString('en')} row groups, ${(fetched / 1e9).toFixed(2)} GB fetched, ${((Date.now() - t1) / 60000).toFixed(1)} min`,
          );
      }),
    );
    const partSeconds = (Date.now() - t1) / 1000;

    // 3. Merge.
    const t2 = Date.now();
    const byContainer = new Map();
    const partsByRegion = {};
    for (const task of tasks) {
      const header = readPartHeader(task.partFile);
      mergeStats((partsByRegion[task.region] ||= {}), header.stats);
      for (const key of Object.keys(header.buckets)) {
        if (!byContainer.has(key)) byContainer.set(key, []);
        byContainer.get(key).push({ file: task.partFile, header });
      }
    }
    const runId = crypto.randomBytes(4).toString('hex');
    const containers = { ...(previous?.containers || {}) };
    let merged = 0;
    let slots = MERGE_CONCURRENCY;
    const waiters = [];
    const take = () =>
      slots > 0
        ? (slots--, Promise.resolve())
        : new Promise((resolve) => waiters.push(resolve));
    const give = () => {
      const next = waiters.shift();
      if (next) next();
      else slots++;
    };
    await Promise.all(
      [...byContainer].map(async ([key, parts]) => {
        await take();
        try {
          const { level, cx, cy } = containerOf(Number(key));
          const folder = path.join(outDir, 'containers', String(level));
          const name = `${cx}-${cy}.${runId}.bin`;
          const before = containers[key]
            ? path.join(outDir, 'containers', containers[key].file)
            : null;
          fs.mkdirSync(folder, { recursive: true });
          const result = await workerPool.run('roads-merge', {
            key: Number(key),
            previous: before,
            parts,
            target: path.join(folder, name),
          });
          containers[key] = {
            file: `${level}/${name}`,
            segments: result.segments,
            bytes: result.bytes,
          };
          merged += 1;
        } finally {
          give();
        }
        if (merged % 100 === 0)
          log(
            `[overture] roads: ${merged} of ${byContainer.size} containers merged`,
          );
      }),
    );
    const mergeSeconds = (Date.now() - t2) / 1000;

    const doneNext = { ...done };
    for (const task of tasks) (doneNext[task.region] ||= []).push(task.id);
    const byRegion = { ...(previous?.byRegion || {}) };
    for (const [name, s] of Object.entries(partsByRegion))
      byRegion[name] = mergeStats({ ...(byRegion[name] || {}) }, s);
    const totals = Object.values(byRegion).reduce(
      (into, s) => mergeStats(into, s),
      {},
    );
    const byLevel = ROAD_LEVELS.map(() => ({ segments: 0, bytes: 0 }));
    for (const [key, entry] of Object.entries(containers)) {
      const { level } = containerOf(Number(key));
      byLevel[level].segments += entry.segments;
      byLevel[level].bytes += entry.bytes;
    }
    const version = crypto
      .createHash('sha256')
      .update(JSON.stringify(containers))
      .digest('hex')
      .slice(0, 12);
    const manifest = {
      format: ROADS_FORMAT,
      version,
      builtAt: new Date().toISOString(),
      release: ROADS.release,
      license: OVERTURE_LICENSE,
      attribution: OVERTURE_ROADS_ATTRIBUTION,
      regions: order,
      regionBoxes: Object.fromEntries(order.map((n) => [n, REGIONS[n]])),
      levels: ROAD_LEVELS,
      containers,
      segments: totals.kept || 0,
      bytes: byLevel.reduce((sum, l) => sum + l.bytes, 0),
      byLevel,
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
    const keep = new Set(Object.values(containers).map((c) => c.file));
    for (const level of fs.readdirSync(path.join(outDir, 'containers')))
      for (const name of fs.readdirSync(path.join(outDir, 'containers', level)))
        if (!keep.has(`${level}/${name}`))
          try {
            fs.rmSync(path.join(outDir, 'containers', level, name));
          } catch {
            /* still open by a server: the next build removes it */
          }
    for (const name of fs.readdirSync(outDir))
      if (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName)
        fs.rmSync(path.join(outDir, name), { force: true });
    // Tiles drawn from an older build are never asked for again.
    const tilesDir = path.join(outDir, 'tiles');
    if (fs.existsSync(tilesDir))
      for (const name of fs.readdirSync(tilesDir))
        if (name !== version)
          fs.rmSync(path.join(tilesDir, name), {
            recursive: true,
            force: true,
          });
    for (const name of new Set(tasks.map((task) => task.region)))
      fs.rmSync(path.join(outDir, 'parts', name), {
        recursive: true,
        force: true,
      });
    log(
      `[overture] roads ${version}: ${manifest.segments.toLocaleString('en')} segments in ${Object.keys(containers).length} containers, ${(manifest.bytes / 1e9).toFixed(2)} GB; parts ${(partSeconds / 60).toFixed(1)} min, merge ${(mergeSeconds / 60).toFixed(1)} min`,
    );
    return manifest;
  } finally {
    await workerPool.close();
  }
}

/** What overture:status says about the roads. */
export function roadsStatus(roadsDir) {
  const manifest = currentRoads(roadsDir);
  if (!manifest) return { built: false };
  return {
    built: true,
    version: manifest.version,
    builtAt: manifest.builtAt,
    regions: manifest.regions,
    segments: manifest.segments,
    bytes: manifest.bytes,
    containers: Object.keys(manifest.containers).length,
    byLevel: manifest.byLevel,
    byClass: manifest.totals?.byClass || {},
    runs: manifest.runs,
  };
}
