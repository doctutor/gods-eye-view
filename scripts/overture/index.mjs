#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openParquet, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import { checkRawDir, rawDirFor, rawDirLabel } from '../rawDir.mjs';
import {
  buildBuildings,
  buildingsStatus,
  relevelBuildings,
} from './buildings.mjs';
import { buildInfrastructure, buildPlaces, placesStatus } from './places.mjs';
import { buildRoads, roadsStatus } from './roads.mjs';
import {
  boundariesStatus,
  findBoundaryInputs,
  runBoundariesBuild,
} from './boundaries.mjs';
import { areasStatus, findAreaInputs, runAreasBuild } from './areas.mjs';
import {
  INDEX_FORMAT,
  CELL_DEGREES,
  writeIndex,
} from '../../server/providers/overture/divisionsFile.js';
import {
  DIVISIONS,
  BUILDINGS_REGIONS,
  DOWNLOAD_CAP_BYTES,
  OVERTURE_BUCKET,
  REGIONS,
  ROADS_REGIONS,
  overtureCacheDir,
  overtureRoadsDir,
} from '../../server/providers/overture/sources.js';
import {
  OVERTURE_ATTRIBUTION,
  OVERTURE_KINDS,
  OVERTURE_LICENSE,
  OVERTURE_MAX_ZOOM,
  overtureKind,
  overtureMinZoom,
} from '../../src/data/overtureDivisions.js';

/**
 * Overture Maps divisions for the Localities layer: the populated places
 * the local server names close in (server/providers/overture.js), in
 * place of OpenStreetMap through Overpass.
 *
 *   node scripts/overture/index.mjs build [--force] [--regions a,b] [--dir DIR]
 *     [--buildings] [--places] [--infrastructure] [--roads]
 *     [--road-regions a,b] [--drop-raw] [--cap-gb N]
 *   node scripts/overture/index.mjs status [--json] [--dir DIR]
 *   node scripts/overture/index.mjs levels [--workers N] [--dir DIR]
 *   node scripts/overture/index.mjs boundaries [--force] [--input FILE] [--dir DIR]
 *   node scripts/overture/index.mjs areas [--force] [--dir DIR]
 *
 * `build` lists the release's division point files in Overture's public
 * bucket (one GeoParquet file of 4.69 M points, 582 MB, ODbL), downloads
 * them once (resumable; refused past DOWNLOAD_CAP_BYTES), and reads them
 * with a small Parquet reader (scripts/overture/parquet.mjs; no
 * dependency). It keeps localities, neighbourhoods (macro, micro) and
 * municipalities and counties with a population, in the regions asked
 * (--regions world, the default, or north-america,europe), each with the
 * zoom it is named from (src/data/overtureDivisions.js), and writes the
 * index (server/providers/overture/divisionsFile.js) into
 * build/<buildId>/, then points build/current.json at it. An unchanged
 * input and rule set is skipped unless --force.
 *
 * `boundaries` builds the country, region and county lines of the
 * Administrative boundaries layer from the release's division_boundary
 * file, already downloaded
 * into raw/<release>/divisions/division_boundary/ (or --input), into
 * build/boundaries/ (scripts/overture/boundaries.mjs).
 *
 * Everything lives in OVERTURE_CACHE_DIR (default .gev-cache/overture in
 * the repository; a worktree can point --dir at the main checkout's):
 * raw/<release>/ the downloads, build/ the index. Nothing is committed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

/**
 * The Overture downloads (the divisions file, the buildings footers and any
 * --keep-raw row groups): raw/ in the cache, or GEV_RAW_DIR/overture/raw.
 */
export const overtureRawDir = (dir, env) =>
  rawDirFor('overture', path.join(dir, 'raw'), env);

/**
 * The roads build's directory: OVERTURE_ROADS_DIR when set, else roads/ in
 * the Overture cache this run uses (`--dir`), like the other builds.
 */
export const roadsDirFor = (dir, env = process.env) =>
  String(env.OVERTURE_ROADS_DIR || '').trim()
    ? overtureRoadsDir(env, ROOT)
    : path.join(dir, 'roads');

/** The boundary lines' build: build/boundaries in the Overture cache. */
export const boundariesDirFor = (dir) => path.join(dir, 'build', 'boundaries');
/** The division areas' build: build/areas in the Overture cache. */
export const areasDirFor = (dir) => path.join(dir, 'build', 'areas');

/** A file's path for the manifest: relative inside the cache, else absolute. */
export function cachePath(dir, file) {
  const relative = path.relative(dir, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : path.resolve(file);
}

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 overture:build (+https://github.com/doctutor/gods-eye-view)';
/** Bumped when what is kept or how it is ranked changes, so a build is redone. */
export const RULES_VERSION = 1;
const FILE_NAME = /^part-[0-9]{5}-[0-9a-f-]{36}-c000\.zstd\.parquet$/;

export function parseArgs(argv) {
  const flags = { command: argv[0] || 'status', force: false, json: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--force') flags.force = true;
    else if (argv[i] === '--json') flags.json = true;
    else if (argv[i] === '--dir') flags.dir = argv[++i];
    else if (argv[i] === '--regions') flags.regions = argv[++i];
    else if (argv[i] === '--buildings') flags.buildings = true;
    else if (argv[i] === '--building-regions')
      flags.buildingRegions = argv[++i];
    else if (argv[i] === '--keep-raw') flags.keepRaw = true;
    else if (argv[i] === '--places') flags.places = true;
    else if (argv[i] === '--infrastructure') flags.infrastructure = true;
    else if (argv[i] === '--roads') flags.roads = true;
    else if (argv[i] === '--road-regions') flags.roadRegions = argv[++i];
    else if (argv[i] === '--drop-raw') flags.dropRaw = true;
    else if (argv[i] === '--cap-gb') flags.capGb = Number(argv[++i]);
    else if (argv[i] === '--workers') flags.workers = Number(argv[++i]);
    else if (argv[i] === '--input') flags.input = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return flags;
}

/** The regions asked for, by name (REGIONS), as [west, south, east, north] boxes. */
export function regionBoxes(names = 'world') {
  const list = String(names || 'world')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of list)
    if (!REGIONS[name])
      throw new Error(
        `unknown region ${name} (${Object.keys(REGIONS).join(', ')})`,
      );
  return { names: list, boxes: list.map((name) => REGIONS[name]) };
}

/** The files of a ListObjectsV2 answer under the divisions prefix, checked. */
export function parseListing(xml, prefix = DIVISIONS.prefix) {
  const files = [];
  for (const [, body] of String(xml).matchAll(
    /<Contents>([\s\S]*?)<\/Contents>/g,
  )) {
    const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1] || '';
    const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1]);
    const etag = (/<ETag>([^<]*)<\/ETag>/.exec(body)?.[1] || '').replace(
      /&quot;|"/g,
      '',
    );
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    if (!FILE_NAME.test(name) || !Number.isSafeInteger(size) || size <= 0)
      continue;
    files.push({ key, name, size, etag });
  }
  if (/<IsTruncated>true<\/IsTruncated>/.test(xml))
    throw new Error('The bucket listing is truncated');
  return files;
}

async function listFiles(fetchImpl = fetch) {
  const url = `${OVERTURE_BUCKET}/?list-type=2&prefix=${encodeURIComponent(DIVISIONS.prefix)}`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok)
    throw new Error(`Listing ${DIVISIONS.prefix}: HTTP ${response.status}`);
  const files = parseListing(await response.text());
  if (!files.length)
    throw new Error(`No division files under ${DIVISIONS.prefix}`);
  return files;
}

/** Download a file once (resumable), checked against its listed size. */
async function download(file, target, log) {
  if (fs.existsSync(target) && fs.statSync(target).size === file.size)
    return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const url = `${OVERTURE_BUCKET}/${file.key}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      ...(have && have < file.size ? { Range: `bytes=${have}-` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const append = response.status === 206;
  log(
    `[overture] downloading ${file.name} (${(file.size / 1e6).toFixed(0)} MB${append ? `, from ${(have / 1e6).toFixed(0)} MB` : ''})`,
  );
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(partial, { flags: append ? 'a' : 'w' }),
  );
  const size = fs.statSync(partial).size;
  if (size !== file.size)
    throw new Error(`${file.name}: ${size} bytes, expected ${file.size}`);
  fs.renameSync(partial, target);
  return true;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const text = (bytes) =>
  bytes == null ? '' : Buffer.from(bytes).toString('utf8');
const inBox = (lon, lat, [west, south, east, north]) =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/**
 * The kept points of one divisions file, as columns for writeIndex.
 * @param {string} file
 * @param {{boxes?: number[][], into?: object, log?: Function}} [options]
 */
export function readDivisions(
  file,
  { boxes = [REGIONS.world], into = null, log = () => {} } = {},
) {
  const parquet = openParquet(file);
  const out = into || {
    lon: [],
    lat: [],
    minZoom: [],
    prominence: [],
    kindCode: [],
    population: [],
    country: [],
    text: [],
    bySubtype: {},
    read: 0,
  };
  const keyLeaf = {
    ...parquet.leaf('names.common.key_value.key'),
    elementDef: 3,
  };
  const valueLeaf = {
    ...parquet.leaf('names.common.key_value.value'),
    elementDef: 3,
  };
  try {
    for (let g = 0; g < parquet.rowGroups.length; g++) {
      const flat = (column) =>
        rowsOfFlat(parquet.column(g, column), parquet.leaf(column));
      const subtype = flat('subtype');
      const rows = subtype.length;
      const klass = flat('class');
      const population = flat('population');
      const geometry = flat('geometry');
      const prominence = flat('cartography.prominence');
      const primary = flat('names.primary');
      const wikidata = flat('wikidata');
      const country = flat('country');
      const region = flat('region');
      const keys = rowsOfRepeated(
        parquet.column(g, 'names.common.key_value.key'),
        keyLeaf,
      );
      const values = rowsOfRepeated(
        parquet.column(g, 'names.common.key_value.value'),
        valueLeaf,
      );
      if (
        keys.length !== rows ||
        values.length !== rows ||
        geometry.length !== rows
      )
        throw new Error(
          `${path.basename(file)}: row group ${g} columns disagree`,
        );
      for (let i = 0; i < rows; i++) {
        out.read += 1;
        const sub = text(subtype[i]);
        const pop = Number(population[i]) || 0;
        const kind = overtureKind(sub, text(klass[i]), pop);
        if (!kind) continue;
        const wkb = geometry[i];
        // A WKB point: byte order, type 1, x, y.
        if (!wkb || wkb.length < 21) continue;
        const little = wkb[0] === 1;
        const type = little ? wkb.readUInt32LE(1) : wkb.readUInt32BE(1);
        if (type !== 1) continue;
        const lon = little ? wkb.readDoubleLE(5) : wkb.readDoubleBE(5);
        const lat = little ? wkb.readDoubleLE(13) : wkb.readDoubleBE(13);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (!boxes.some((box) => inBox(lon, lat, box))) continue;
        const common = {};
        keys[i].forEach((key, k) => {
          const language = text(key);
          if (language === 'en' || language === 'es' || language === 'ru')
            common[language] = text(values[i][k]);
        });
        const local = text(primary[i]);
        const name = common.en || local;
        if (!name) continue;
        const p = Number(prominence[i]) || 0;
        out.lon.push(lon);
        out.lat.push(lat);
        out.minZoom.push(
          overtureMinZoom({ kind, prominence: p, population: pop }),
        );
        out.prominence.push(Math.max(0, Math.min(100, p)));
        out.kindCode.push(kind.code);
        out.population.push(Math.max(0, Math.min(0xffffffff, pop)));
        out.country.push(
          /^[A-Z]{2}$/.test(text(country[i])) ? text(country[i]) : '',
        );
        out.text.push(
          [
            name,
            common.es && common.es !== name ? common.es : '',
            common.ru && common.ru !== name ? common.ru : '',
            local && local !== name ? local : '',
            /^Q\d{1,12}$/.test(text(wikidata[i])) ? text(wikidata[i]) : '',
            /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(text(region[i]))
              ? text(region[i])
              : '',
          ]
            .map((value) => value.replace(/\0/g, ''))
            .join('\0'),
        );
        out.bySubtype[kind.kind] = (out.bySubtype[kind.kind] || 0) + 1;
      }
      if (g % 32 === 31)
        log(
          `[overture] ${path.basename(file)}: ${g + 1} of ${parquet.rowGroups.length} row groups, ${out.lon.length.toLocaleString('en')} kept`,
        );
    }
  } finally {
    parquet.close();
  }
  return out;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** The build the server reads now (build/current.json → its manifest), or null. */
export function currentBuild(dir) {
  const current = readJson(path.join(dir, 'build', 'current.json'));
  if (!/^[0-9a-f]{12}$/.test(current?.buildId || '')) return null;
  const manifest = readJson(
    path.join(dir, 'build', current.buildId, 'manifest.json'),
  );
  return manifest
    ? { ...manifest, dir: path.join(dir, 'build', current.buildId) }
    : null;
}

export async function build({
  dir,
  rawDir = null,
  force = false,
  regions = 'world',
  log = console.log,
} = {}) {
  const started = Date.now();
  const { names, boxes } = regionBoxes(regions);
  const files = await listFiles();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > DOWNLOAD_CAP_BYTES)
    throw new Error(
      `The division files add up to ${(total / 1e9).toFixed(2)} GB, past the ${(DOWNLOAD_CAP_BYTES / 1024 ** 3).toFixed(0)} GB cap`,
    );
  const releaseDir = path.join(
    rawDir || path.join(dir, 'raw'),
    DIVISIONS.release,
  );
  checkRawDir(releaseDir);
  const inputs = [];
  for (const file of files) {
    const target = path.join(releaseDir, `${DIVISIONS.type}.${file.name}`);
    const t0 = Date.now();
    const fetched = await download(file, target, log);
    if (fetched)
      log(
        `[overture] ${file.name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`,
      );
    inputs.push({
      file: cachePath(dir, target),
      url: `${OVERTURE_BUCKET}/${file.key}`,
      size: file.size,
      etag: file.etag,
      sha256: await sha256(target),
    });
  }
  const buildId = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        format: INDEX_FORMAT,
        rules: RULES_VERSION,
        kinds: OVERTURE_KINDS,
        regions: names,
        inputs: inputs.map((i) => i.sha256),
      }),
    )
    .digest('hex')
    .slice(0, 12);
  const existing = currentBuild(dir);
  if (!force && existing?.buildId === buildId) {
    log(
      `[overture] build ${buildId} is current (${existing.points.toLocaleString('en')} places); --force to redo it`,
    );
    return existing;
  }
  const t1 = Date.now();
  let columns = null;
  for (const input of inputs)
    columns = readDivisions(path.resolve(dir, input.file), {
      boxes,
      into: columns,
      log,
    });
  const readSeconds = (Date.now() - t1) / 1000;
  log(
    `[overture] read ${columns.read.toLocaleString('en')} division points in ${readSeconds.toFixed(1)} s; kept ${columns.lon.length.toLocaleString('en')}`,
  );
  const t2 = Date.now();
  const buildDir = path.join(dir, 'build', buildId);
  const count = columns.lon.length;
  const written = writeIndex(buildDir, {
    count,
    lon: Float64Array.from(columns.lon),
    lat: Float64Array.from(columns.lat),
    minZoom: Uint8Array.from(columns.minZoom),
    prominence: Uint8Array.from(columns.prominence),
    kindCode: Uint8Array.from(columns.kindCode),
    population: Uint32Array.from(columns.population),
    country: columns.country,
    text: columns.text,
  });
  const byZoom = new Array(OVERTURE_MAX_ZOOM + 1).fill(0);
  for (const z of columns.minZoom) byZoom[z] += 1;
  const manifest = {
    format: INDEX_FORMAT,
    buildId,
    builtAt: new Date().toISOString(),
    release: DIVISIONS.release,
    theme: DIVISIONS.theme,
    type: DIVISIONS.type,
    license: OVERTURE_LICENSE,
    attribution: OVERTURE_ATTRIBUTION,
    regions: names,
    rules: RULES_VERSION,
    cellDegrees: CELL_DEGREES,
    inputs,
    read: columns.read,
    points: written.points,
    cells: written.cells,
    countries: written.countries,
    byKind: columns.bySubtype,
    byZoom,
    bytes: written.bytes,
    seconds: {
      read: readSeconds,
      write: (Date.now() - t2) / 1000,
      total: (Date.now() - started) / 1000,
    },
  };
  fs.writeFileSync(
    path.join(buildDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const pointer = path.join(dir, 'build', 'current.json');
  fs.writeFileSync(`${pointer}.tmp`, `${JSON.stringify({ buildId })}\n`);
  fs.renameSync(`${pointer}.tmp`, pointer);
  // Older builds go when nothing holds them open (a running server may).
  for (const entry of fs.readdirSync(path.join(dir, 'build'), {
    withFileTypes: true,
  }))
    // Only builds of the divisions index: build/boundaries is its own.
    if (
      entry.isDirectory() &&
      entry.name !== buildId &&
      /^[0-9a-f]{12}$/.test(entry.name)
    )
      try {
        fs.rmSync(path.join(dir, 'build', entry.name), { recursive: true });
      } catch {
        /* still open: the next build removes it */
      }
  log(
    `[overture] build ${buildId}: ${written.points.toLocaleString('en')} places in ${written.cells.toLocaleString('en')} cells, ${((written.bytes.points + written.bytes.strings + written.bytes.cells) / 1e6).toFixed(0)} MB, ${manifest.seconds.total.toFixed(1)} s`,
  );
  return { ...manifest, dir: buildDir };
}

export function status(dir, rawDir = path.join(dir, 'raw')) {
  const current = currentBuild(dir);
  const raw = rawDirLabel(rawDir);
  if (!current)
    return {
      built: false,
      dir,
      raw,
      release: DIVISIONS.release,
      buildings: buildingsStatus(dir),
      places: placesStatus(dir),
      infrastructure: placesStatus(dir, 'infrastructure'),
      roads: roadsStatus(roadsDirFor(dir)),
      boundaries: boundariesStatus(boundariesDirFor(dir)),
      areas: areasStatus(areasDirFor(dir)),
    };
  return {
    built: true,
    dir,
    raw,
    buildId: current.buildId,
    builtAt: current.builtAt,
    release: current.release,
    regions: current.regions,
    points: current.points,
    byKind: current.byKind,
    inputs: current.inputs.map(({ file, size }) => ({ file, size })),
    bytes: current.bytes,
    buildings: buildingsStatus(dir),
    places: placesStatus(dir),
    infrastructure: placesStatus(dir, 'infrastructure'),
    roads: roadsStatus(roadsDirFor(dir)),
    boundaries: boundariesStatus(boundariesDirFor(dir)),
    areas: areasStatus(areasDirFor(dir)),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = flags.dir
    ? path.resolve(ROOT, flags.dir)
    : overtureCacheDir(process.env, ROOT);
  if (flags.command === 'build') {
    const rawDir = overtureRawDir(dir);
    await build({
      dir,
      rawDir,
      force: flags.force,
      regions: flags.regions || process.env.OVERTURE_REGIONS || 'world',
    });
    if (flags.buildings || flags.buildingRegions) {
      const names = String(
        flags.buildingRegions ||
          process.env.OVERTURE_BUILDING_REGIONS ||
          BUILDINGS_REGIONS.join(','),
      )
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      if (flags.capGb !== undefined && !(flags.capGb > 0))
        throw new Error('--cap-gb takes a number of GB');
      await buildBuildings({
        dir,
        rawRoot: rawDir,
        regions: names,
        keepRaw: Boolean(flags.keepRaw),
        ...(flags.capGb ? { capBytes: flags.capGb * 1e9 } : {}),
        userAgent: USER_AGENT,
      });
    }
    if (flags.places)
      await buildPlaces({
        dir,
        rawRoot: rawDir,
        keepRaw: !flags.dropRaw,
        force: flags.force,
        ...(flags.capGb ? { capBytes: flags.capGb * 1e9 } : {}),
        userAgent: USER_AGENT,
      });
    if (flags.roads || flags.roadRegions)
      await buildRoads({
        dir,
        roadsDir: roadsDirFor(dir),
        rawRoot: rawDir,
        regions: String(flags.roadRegions || ROADS_REGIONS.join(','))
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
        keepRaw: !flags.dropRaw,
        ...(flags.capGb ? { capBytes: flags.capGb * 1e9 } : {}),
        userAgent: USER_AGENT,
      });
    if (flags.infrastructure)
      await buildInfrastructure({
        dir,
        rawRoot: rawDir,
        keepRaw: !flags.dropRaw,
        force: flags.force,
        ...(flags.capGb ? { capBytes: flags.capGb * 1e9 } : {}),
        userAgent: USER_AGENT,
      });
    return;
  }
  // Personal fork: the buildings' buckets written again from their own
  // footprints with the density levels the build lacks (D19, z 11–14).
  if (flags.command === 'levels') {
    if (flags.workers !== undefined && !(flags.workers >= 1))
      throw new Error('--workers takes a number');
    await relevelBuildings({ dir, workers: flags.workers || 2 });
    return;
  }
  // Personal fork: the Administrative boundaries layer's country, region
  // and county lines.
  if (flags.command === 'boundaries') {
    const inputs = flags.input
      ? [
          {
            file: path.resolve(flags.input),
            name: path.basename(flags.input),
            bytes: fs.statSync(path.resolve(flags.input)).size,
          },
        ]
      : findBoundaryInputs([overtureRawDir(dir), path.join(dir, 'raw')]);
    const outDir = boundariesDirFor(dir);
    const { skipped, manifest } = runBoundariesBuild({
      outDir,
      inputs,
      force: flags.force,
      log: (line) => console.log(`[overture] boundaries: ${line}`),
    });
    if (!skipped)
      console.log(
        `[overture] boundaries ${manifest.buildId}: ${manifest.lines} lines (${manifest.disputed} disputed), ${(manifest.bytes / 1e6).toFixed(1)} MB in ${outDir}, ${(manifest.timings.totalMs / 1000).toFixed(1)} s`,
      );
    return;
  }
  // Personal fork: the Administrative boundaries layer's division areas.
  if (flags.command === 'areas') {
    const outDir = areasDirFor(dir);
    let peak = 0;
    let calls = 0;
    const { skipped, manifest } = runAreasBuild({
      outDir,
      inputs: findAreaInputs([overtureRawDir(dir), path.join(dir, 'raw')]),
      force: flags.force,
      log: (line) => console.log(`[overture] areas: ${line}`),
      onMemory: () => {
        if (++calls % 200 === 0)
          peak = Math.max(peak, process.memoryUsage().rss);
      },
    });
    if (!skipped)
      console.log(
        `[overture] areas ${manifest.buildId}: ${manifest.units} units from ${manifest.sources.length} files, ${(manifest.bytes / 1e6).toFixed(1)} MB in ${outDir}, ${(manifest.timings.totalMs / 1000).toFixed(1)} s, peak RSS ${Math.round(peak / 1048576)} MB`,
      );
    return;
  }
  if (flags.command === 'status') {
    const answer = status(dir);
    if (flags.json) return console.log(JSON.stringify(answer, null, 2));
    if (!answer.built)
      return console.log(
        `Overture divisions: not built (${dir}; raw ${answer.raw}). Run npm run overture:build.`,
      );
    console.log(
      `Overture divisions ${answer.release}: build ${answer.buildId} of ${answer.builtAt}, ${answer.points.toLocaleString('en')} places (${answer.regions.join(', ')})`,
    );
    console.log(`  raw downloads: ${answer.raw}`);
    for (const [kind, n] of Object.entries(answer.byKind))
      console.log(`  ${kind}: ${n.toLocaleString('en')}`);
    for (const input of answer.inputs)
      console.log(`  ${input.file}: ${(input.size / 1e6).toFixed(0)} MB`);
    const { buildings } = answer;
    if (!buildings.built)
      console.log(
        'Overture buildings: not built. Run npm run overture:build -- --buildings.',
      );
    else
      console.log(
        `Overture buildings ${buildings.version} of ${buildings.builtAt}: ${buildings.buildings.toLocaleString('en')} buildings (${buildings.regions.join(', ')}), ${(buildings.bytes / 1e9).toFixed(2)} GB in ${buildings.buckets} buckets; ${buildings.withHeight.toLocaleString('en')} with a height`,
      );
    const { places } = answer;
    console.log(
      places.built
        ? `Overture places ${places.version} of ${places.builtAt}: ${places.places.toLocaleString('en')} places, ${(places.bytes / 1e9).toFixed(2)} GB in ${places.buckets} buckets; raw ${places.rawDir}`
        : 'Overture places: not built. Run npm run overture:build -- --places.',
    );
    const { infrastructure } = answer;
    console.log(
      infrastructure.built
        ? `Overture infrastructure ${infrastructure.version} of ${infrastructure.builtAt}: ${infrastructure.places.toLocaleString('en')} features, ${(infrastructure.bytes / 1e9).toFixed(2)} GB in ${infrastructure.buckets} buckets; raw ${infrastructure.rawDir}`
        : 'Overture infrastructure: not built. Run npm run overture:build -- --infrastructure.',
    );
    for (const [name, n] of Object.entries(infrastructure.byClass || {}))
      console.log(`  ${name}: ${n.toLocaleString('en')}`);
    const { roads } = answer;
    console.log(
      roads.built
        ? `Overture roads ${roads.version} of ${roads.builtAt}: ${roads.segments.toLocaleString('en')} segments (${roads.regions.join(', ')}), ${(roads.bytes / 1e9).toFixed(2)} GB in ${roads.containers} containers`
        : 'Overture roads: not built. Run npm run overture:build -- --roads.',
    );
    const { boundaries } = answer;
    const subtypes = boundaries.bySubtype
      ? ` (${Object.entries(boundaries.bySubtype)
          .map(([name, { lines }]) => `${lines.toLocaleString('en')} ${name}`)
          .join(', ')})`
      : ' (country lines only: run npm run overture:boundaries -- --force for the region and county lines)';
    console.log(
      boundaries.built
        ? `Overture boundary lines ${boundaries.release} of ${boundaries.builtAt}: ${boundaries.lines.toLocaleString('en')} lines${subtypes}, ${boundaries.disputed} disputed, ${(boundaries.bytes / 1e6).toFixed(1)} MB`
        : 'Overture boundary lines: not built. Run npm run overture:boundaries.',
    );
    const { areas } = answer;
    console.log(
      areas.built
        ? `Overture division areas ${areas.release} of ${areas.builtAt}: ${areas.units.toLocaleString('en')} units from ${areas.inputs} files, ${(areas.bytes / 1e6).toFixed(1)} MB`
        : 'Overture division areas: not built. Run npm run overture:areas.',
    );
    return;
  }
  throw new Error(
    `unknown command ${flags.command} (build, levels, boundaries, areas, status)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[overture] ${error?.message || error}`);
    process.exitCode = 1;
  });
