#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOWNLOADS, buildPaths, fetchDownloads, runBuild } from './build.mjs';
import { findRiverInputs, forEachReach } from './sources.mjs';
import { spawnSync } from 'node:child_process';
import { buildRiverNames, linesOf, osmiumExtractCommands } from './names.mjs';
import { checkRawDir, rawDirFor, rawDirLabel } from '../rawDir.mjs';
import { readLevelHeader } from '../../server/providers/riversV2/levelFile.js';
import { tileVersion } from '../../server/providers/riversV2/bands.js';

/**
 * HydroSHEDS v2 rivers for the Americas: the river network the Rivers layer
 * draws over North, Central and South America in place of HydroRIVERS v1.
 *
 *   node scripts/rivers/index.mjs fetch [--dir DIR]
 *   node scripts/rivers/index.mjs build [--force] [--limit N] [--dir DIR]
 *   node scripts/rivers/index.mjs status [--json] [--dir DIR]
 *   node scripts/rivers/index.mjs names [--extract --pbf FILE] [--workers N] [--dir DIR]
 *
 * `fetch` downloads the two zipped File Geodatabases of the v2 river
 * network (RIV, 4.8 GB in all) from data.hydrosheds.org, one at a time,
 * unless they are already there at their published size. `build` reads
 * their RIV_STREAMS layers straight out of the ZIPs (21 M reaches) and
 * writes one level file per zoom band plus manifest.json; an unchanged
 * input is skipped unless --force. --limit N builds from the first N
 * reaches of each region (a quick look). `status` reports the build.
 *
 * `names` (names.mjs) names the reaches from OpenStreetMap: with
 * `--extract` it first filters the planet PBF (`--pbf`) to its waterways
 * and exports them as GeoJSON lines with osmium in Docker (the Overpass
 * image), into raw/names/ (GEV_RAW_DIR/rivers/names); then it matches
 * every v2 reach to the waterway it follows, carries the names down the
 * main stems, and writes the sidecar to names/ beside v2/, with the match
 * rates by Strahler order in its manifest. The spill goes under
 * raw/names/tmp and is deleted at the end.
 *
 * Everything lives in RIVERS_CACHE_DIR (default .gev-cache/rivers in the
 * repository; a worktree can point it at the main checkout's): raw/ holds
 * the downloads, v2/ the build and the server's tile cache. Nothing there
 * is ever committed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function parseArgs(argv) {
  const [command = 'status', ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--'))
      throw new Error(`unexpected argument ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (rest[index + 1] && !rest[index + 1].startsWith('--'))
      flags[name] = rest[++index];
    else flags[name] = true;
  }
  return { command, flags };
}

/** The rivers cache directory: --dir, else RIVERS_CACHE_DIR, else .gev-cache/rivers. */
export function riversDir(env = process.env, flags = {}) {
  const configured = flags.dir || env.RIVERS_CACHE_DIR;
  return configured
    ? path.resolve(ROOT, configured)
    : path.join(ROOT, '.gev-cache', 'rivers');
}

const limitOf = (value) => {
  if (value === undefined || value === true) return Infinity;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error('--limit must be a positive integer');
  return number;
};

function directoryBytes(dir) {
  let bytes = 0;
  let files = 0;
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        bytes += fs.statSync(full).size;
        files++;
      }
    }
  };
  visit(dir);
  return { bytes, files };
}

/** What `status` reports. */
export function statusOf(dir, rawDir) {
  const paths = buildPaths(dir, rawDir);
  if (rawDir) checkRawDir(paths.raw, { write: false });
  const raw = rawDir ? rawDirLabel(paths.raw) : paths.raw;
  const inputs = findRiverInputs(paths.raw).map((input) => ({
    region: input.region,
    file: path.basename(input.file),
    kind: input.kind,
    bytes: input.bytes,
  }));
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  } catch {
    /* not built */
  }
  if (!manifest)
    return {
      built: false,
      dir,
      raw,
      inputs,
      hint: inputs.length ? 'npm run rivers:build' : 'npm run rivers:fetch',
    };
  const levels = manifest.levels.map((level) => {
    try {
      readLevelHeader(path.join(paths.v2, ...level.file.split('/')));
      return { ...level, readable: true };
    } catch (error) {
      return { ...level, readable: false, error: error.message };
    }
  });
  const versions = {
    light: tileVersion('light', manifest.buildId),
    dark: tileVersion('dark', manifest.buildId),
  };
  return {
    built: levels.every((level) => level.readable),
    dir,
    raw,
    inputs,
    builtAt: manifest.builtAt,
    buildId: manifest.buildId,
    versions,
    reaches: manifest.reaches,
    vertices: manifest.vertices,
    extent: manifest.extent,
    sources: manifest.sources,
    byOrder: manifest.byOrder,
    levels,
    bytes: manifest.bytes,
    timings: manifest.timings,
    tiles: directoryBytes(paths.tiles),
  };
}

const mb = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const number = (value) => Number(value || 0).toLocaleString('en-US');

function statusLines(status) {
  const lines = status.inputs.length
    ? status.inputs.map(
        (input) =>
          `input: ${input.file} (${input.region}, ${(input.bytes / 1e9).toFixed(2)} GB)`,
      )
    : [`no inputs under ${status.raw}; run npm run rivers:fetch`];
  if (!status.levels) {
    lines.push(`not built; run ${status.hint}`);
    return lines;
  }
  lines.push(
    `built: ${status.builtAt} (build ${status.buildId}; tiles light ${status.versions.light}, dark ${status.versions.dark})`,
    `reaches: ${number(status.reaches)}, ${number(status.vertices)} vertices, ${status.sources.map((source) => `${source.region} ${number(source.reaches)}${source.complete ? '' : ' (partial, --limit)'}`).join(', ')}`,
    `extent: ${['west', 'south', 'east', 'north'].map((side) => status.extent?.[side]?.toFixed(3)).join(', ')}`,
    `orders: ${status.byOrder.map((entry) => `${entry.order}:${number(entry.reaches)}`).join(' ')}`,
  );
  for (const level of status.levels)
    lines.push(
      `${level.level} z${level.minZoom}–${level.maxZoom} order ≤ ${level.maxOrder}: ${number(level.cells)} cells, ${number(level.pieces)} pieces, ${number(level.vertices)} vertices, ${mb(level.bytes)}${level.readable ? '' : ` UNREADABLE (${level.error})`}`,
    );
  lines.push(
    `levels: ${mb(status.bytes)}; build took ${(status.timings.totalMs / 1000).toFixed(0)} s (read ${(status.timings.readMs / 1000).toFixed(0)} s, write ${(status.timings.writeMs / 1000).toFixed(0)} s)`,
    `tile cache: ${number(status.tiles.files)} tiles, ${mb(status.tiles.bytes)}`,
  );
  return lines;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  const dir = riversDir(process.env, flags);
  // GEV_RAW_DIR/rivers/raw when set (the environment's or .env's), else raw/.
  const rawDir = rawDirFor('rivers', null);
  const paths = buildPaths(dir, rawDir);
  const log = (line) => console.log(`[rivers] ${line}`);
  if (command === 'status') {
    const status = statusOf(dir, rawDir);
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else for (const line of statusLines(status)) console.log(line);
    return status.built ? 0 : 1;
  }
  if (command === 'fetch' || command === 'build' || command === 'names')
    checkRawDir(paths.raw);
  if (command === 'names') {
    const namesRaw = path.join(paths.raw, 'names');
    fs.mkdirSync(namesRaw, { recursive: true });
    const geojson = path.join(namesRaw, 'waterways.geojsonseq');
    if (flags.extract) {
      if (typeof flags.pbf !== 'string')
        throw new Error('--extract needs --pbf <planet .osm.pbf>');
      const pbf = path.resolve(flags.pbf);
      for (const argv of osmiumExtractCommands({
        pbfDir: path.dirname(pbf),
        pbf: path.basename(pbf),
        outDir: namesRaw,
      })) {
        log(`$ ${argv.join(' ')}`);
        const run = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
        if (run.status !== 0)
          throw new Error(
            `${argv.slice(0, 2).join(' ')} … exited ${run.status}`,
          );
      }
    }
    if (!fs.existsSync(geojson))
      throw new Error(
        `${geojson} is not there: run names --extract --pbf <planet .osm.pbf> first`,
      );
    const inputs = findRiverInputs(paths.raw);
    if (!inputs.length) throw new Error(`no river inputs under ${paths.raw}`);
    const manifest = await buildRiverNames({
      waterways: linesOf(geojson),
      regions: inputs.map((input) => ({
        name: input.region,
        forEachReach: (onReach) => forEachReach(input, onReach),
      })),
      dir: path.join(dir, 'names'),
      tmpDir: path.join(namesRaw, 'tmp'),
      workers: flags.workers ? Number(flags.workers) : 4,
      log,
      source: {
        waterways: path.basename(geojson),
        regions: inputs.map((i) => i.region),
      },
    });
    for (const [order, entry] of Object.entries(manifest.rates.byOrder))
      log(
        `Strahler ${order}: ${entry.reaches.toLocaleString('en-US')} reaches, ${((100 * entry.direct) / entry.reaches).toFixed(1)}% named from OSM, ${((100 * (entry.direct + entry.inherited)) / entry.reaches).toFixed(1)}% with the main stems`,
      );
    return 0;
  }
  if (command === 'fetch') {
    await fetchDownloads({ rawDir: paths.raw, log });
    log(
      `inputs: ${DOWNLOADS.map((download) => download.file).join(', ')} under ${paths.raw}`,
    );
    return 0;
  }
  if (command === 'build') {
    const result = await runBuild({
      cacheDir: dir,
      rawDir: paths.raw,
      force: Boolean(flags.force),
      limit: limitOf(flags.limit),
      log,
    });
    if (!result.skipped)
      for (const line of statusLines(statusOf(dir, rawDir))) log(line);
    return 0;
  }
  console.error(
    `unknown command ${command}; use fetch, build, names or status`,
  );
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[rivers] ${error?.message || error}`);
      process.exit(1);
    },
  );
}
