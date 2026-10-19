#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openParquet, rowsOfFlat, rowsOfRepeated } from './parquet.mjs';
import {
  INDEX_FORMAT,
  CELL_DEGREES,
  writeIndex,
} from '../../server/providers/overture/divisionsFile.js';
import {
  DIVISIONS,
  DOWNLOAD_CAP_BYTES,
  OVERTURE_BUCKET,
  REGIONS,
  overtureCacheDir,
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
 *   node scripts/overture/index.mjs status [--json] [--dir DIR]
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
 * Everything lives in OVERTURE_CACHE_DIR (default .gev-cache/overture in
 * the repository; a worktree can point --dir at the main checkout's):
 * raw/<release>/ the downloads, build/ the index. Nothing is committed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

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
  const rawDir = path.join(dir, 'raw', DIVISIONS.release);
  const inputs = [];
  for (const file of files) {
    const target = path.join(rawDir, `${DIVISIONS.type}.${file.name}`);
    const t0 = Date.now();
    const fetched = await download(file, target, log);
    if (fetched)
      log(
        `[overture] ${file.name}: ${((Date.now() - t0) / 1000).toFixed(0)} s`,
      );
    inputs.push({
      file: path.relative(dir, target).split(path.sep).join('/'),
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
    columns = readDivisions(path.join(dir, input.file), {
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
    if (entry.isDirectory() && entry.name !== buildId)
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

export function status(dir) {
  const current = currentBuild(dir);
  if (!current) return { built: false, dir, release: DIVISIONS.release };
  return {
    built: true,
    dir,
    buildId: current.buildId,
    builtAt: current.builtAt,
    release: current.release,
    regions: current.regions,
    points: current.points,
    byKind: current.byKind,
    inputs: current.inputs.map(({ file, size }) => ({ file, size })),
    bytes: current.bytes,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = flags.dir
    ? path.resolve(ROOT, flags.dir)
    : overtureCacheDir(process.env, ROOT);
  if (flags.command === 'build') {
    await build({
      dir,
      force: flags.force,
      regions: flags.regions || process.env.OVERTURE_REGIONS || 'world',
    });
    return;
  }
  if (flags.command === 'status') {
    const answer = status(dir);
    if (flags.json) return console.log(JSON.stringify(answer, null, 2));
    if (!answer.built)
      return console.log(
        `Overture divisions: not built (${dir}). Run npm run overture:build.`,
      );
    console.log(
      `Overture divisions ${answer.release}: build ${answer.buildId} of ${answer.builtAt}, ${answer.points.toLocaleString('en')} places (${answer.regions.join(', ')})`,
    );
    for (const [kind, n] of Object.entries(answer.byKind))
      console.log(`  ${kind}: ${n.toLocaleString('en')}`);
    for (const input of answer.inputs)
      console.log(`  ${input.file}: ${(input.size / 1e6).toFixed(0)} MB`);
    return;
  }
  throw new Error(`unknown command ${flags.command} (build, status)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[overture] ${error?.message || error}`);
    process.exitCode = 1;
  });
