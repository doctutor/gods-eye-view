#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { listZipEntries, readZipEntry } from '../rivers/zip.mjs';
import { readDbf, readPolygons } from './shapefile.mjs';
import { writeTracts } from '../../server/providers/census/tractsFile.js';
import {
  ACS,
  BOUNDARIES,
  CENSUS_KEY_ENV,
  NEEDS_KEY,
  censusCacheDir,
} from '../../server/providers/census/sources.js';

/**
 * US census tracts for the Census tracts layer's HOUSEHOLD INCOME mode:
 * the tracts drawn by the local server (server/providers/census.js),
 * coloured by the ACS median household income.
 *
 *   node scripts/census/index.mjs build [--force] [--dir DIR]
 *   node scripts/census/index.mjs status [--json] [--dir DIR]
 *
 * `build` has two steps:
 *   1. boundaries: the Census Bureau's 2024 cartographic boundary tracts
 *      (cb_2024_us_tract_500k.zip, 58 MB, public domain), downloaded once
 *      and read straight out of the ZIP into tract files. No key.
 *   2. income: ACS 5-year 2020–2024 B19013_001E (median household income)
 *      for every tract, one request per state. This step needs a free
 *      Census API key (CENSUS_API_KEY in .env; api.census.gov/data/
 *      key_signup.html): without one it is skipped, and the build says so.
 * The manifest names what each step produced, so the server can say which
 * mode is ready. A later value (land surface temperature per tract) is one
 * more column of values.json.
 *
 * Everything lives in CENSUS_CACHE_DIR (default .gev-cache/census in the
 * repository): raw/ the download, build/ the tract files, values and
 * manifest, tiles/ the server's tile cache. Nothing there is committed.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 census:build (+https://github.com/doctutor/gods-eye-view)';
/** The ACS is asked once a second at most. */
const ACS_PACE_MS = 1000;
/** The Census API's code for a value it cannot estimate (and kin). */
const isEstimate = (value) => Number.isFinite(value) && value >= 0;

export function parseArgs(argv) {
  const flags = { command: argv[0] || 'status', force: false, json: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--force') flags.force = true;
    else if (argv[i] === '--json') flags.json = true;
    else if (argv[i] === '--dir') flags.dir = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return flags;
}

/** The key, from the environment or the repository's .env (never printed). */
export async function censusKey(env = process.env, root = ROOT) {
  const own = String(env[CENSUS_KEY_ENV] || '').trim();
  if (own) return own;
  try {
    const { loadEnv } = await import('vite');
    return String(
      loadEnv('development', root, '')[CENSUS_KEY_ENV] || '',
    ).trim();
  } catch {
    return '';
  }
}

async function download(url, file) {
  const head = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT },
  });
  const size = Number(head.headers.get('content-length'));
  if (fs.existsSync(file) && fs.statSync(file).size === size) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const temporary = `${file}.part`;
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(temporary),
  );
  fs.renameSync(temporary, file);
  return true;
}

/** Step 1: the boundaries ZIP → tract files. */
export async function buildBoundaries(zipFile, buildDir) {
  const entries = listZipEntries(zipFile);
  const find = (ext) =>
    entries.find((entry) => entry.name.toLowerCase().endsWith(ext));
  const shp = await readZipEntry(zipFile, find('.shp'));
  const dbf = await readZipEntry(zipFile, find('.dbf'));
  const shapes = readPolygons(shp);
  const records = readDbf(dbf, ['GEOID']);
  if (shapes.length !== records.length)
    throw new Error(`${shapes.length} shapes but ${records.length} records`);
  const tracts = shapes.map((shape, i) => ({
    geoid: records[i].GEOID,
    rings: shape.rings,
  }));
  return writeTracts(buildDir, tracts);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Step 2: the ACS median household income by tract, per state. */
export async function fetchIncome(
  states,
  key,
  { fetchImpl = fetch, pace = ACS_PACE_MS } = {},
) {
  const values = {};
  for (const state of states) {
    const url = new URL(
      `https://api.census.gov/data/${ACS.year}/${ACS.dataset}`,
    );
    url.searchParams.set('get', ACS.variable);
    url.searchParams.set('for', 'tract:*');
    url.searchParams.set('in', `state:${state}`);
    url.searchParams.set('key', key);
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        'The Census API refused the key (it redirected to its key page)',
      );
    if (!response.ok)
      throw new Error(`ACS state ${state}: HTTP ${response.status}`);
    const [header, ...rows] = await response.json();
    const column = (name) => header.indexOf(name);
    const [v, s, c, t] = [ACS.variable, 'state', 'county', 'tract'].map(column);
    for (const row of rows) {
      const value = Number(row[v]);
      values[`${row[s]}${row[c]}${row[t]}`] = isEstimate(value) ? value : null;
    }
    await sleep(pace);
  }
  return values;
}

export function statusOf(dir) {
  const manifestFile = path.join(dir, 'build', 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { built: false };
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  return { built: true, ...manifest };
}

async function build(dir, flags) {
  const zipFile = path.join(dir, 'raw', BOUNDARIES.file);
  const buildDir = path.join(dir, 'build');
  console.log(`[census] boundaries: ${BOUNDARIES.url}`);
  if (await download(BOUNDARIES.url, zipFile))
    console.log('[census] downloaded');
  const previous = statusOf(dir);
  const zipStat = fs.statSync(zipFile);
  const boundariesId = `${BOUNDARIES.file}:${zipStat.size}`;
  let boundaries = previous.boundaries;
  if (flags.force || previous.boundaries?.id !== boundariesId) {
    const counts = await buildBoundaries(zipFile, buildDir);
    boundaries = { id: boundariesId, year: BOUNDARIES.year, ...counts };
    console.log(`[census] ${counts.count} tracts, ${counts.points} points`);
  } else
    console.log(`[census] boundaries unchanged (${boundaries.count} tracts)`);
  const values = { version: 1 };
  const valuesFile = path.join(buildDir, 'values.json');
  try {
    Object.assign(values, JSON.parse(fs.readFileSync(valuesFile, 'utf8')));
  } catch {
    /* none yet */
  }
  const key = await censusKey();
  let income = previous.values?.income || null;
  if (!key) {
    console.log(`[census] income skipped: ${NEEDS_KEY}`);
  } else if (flags.force || !income || income.year !== ACS.year) {
    const geoids = JSON.parse(
      fs.readFileSync(path.join(buildDir, 'tracts.json'), 'utf8'),
    ).geoids;
    const states = [
      ...new Set(geoids.map((geoid) => geoid.slice(0, 2))),
    ].sort();
    console.log(
      `[census] income: ACS ${ACS.year} 5-year, ${states.length} states`,
    );
    values.income = await fetchIncome(states, key);
    const known = Object.values(values.income).filter((v) => v !== null).length;
    income = {
      year: ACS.year,
      variable: ACS.variable,
      tracts: Object.keys(values.income).length,
      known,
    };
    console.log(`[census] income for ${known} of ${income.tracts} tracts`);
  }
  fs.writeFileSync(valuesFile, JSON.stringify(values));
  const manifest = {
    builtAt: new Date().toISOString(),
    buildId: crypto
      .createHash('sha256')
      .update(JSON.stringify({ boundaries, income }))
      .digest('hex')
      .slice(0, 12),
    boundaries,
    values: { income },
  };
  fs.writeFileSync(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dir = flags.dir
    ? path.resolve(flags.dir)
    : censusCacheDir(process.env, ROOT);
  if (flags.command === 'build') {
    const manifest = await build(dir, flags);
    console.log(
      manifest.values.income
        ? '[census] ready: tracts and income'
        : `[census] tracts ready; income needs ${CENSUS_KEY_ENV}`,
    );
  } else if (flags.command === 'status') {
    const status = statusOf(dir);
    const key = Boolean(await censusKey());
    if (flags.json)
      console.log(JSON.stringify({ ...status, keySet: key }, null, 2));
    else if (!status.built)
      console.log(`[census] not built: run npm run census:build (${dir})`);
    else
      console.log(
        `[census] built ${status.builtAt}: ${status.boundaries?.count} tracts (${status.boundaries?.year}); income ${
          status.values?.income
            ? `ACS ${status.values.income.year}, ${status.values.income.known} tracts`
            : `not fetched (${CENSUS_KEY_ENV} ${key ? 'is set: run the build again' : 'is not set'})`
        }`,
      );
  } else throw new Error(`unknown command ${flags.command}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`[census] ${error.message}`);
    process.exit(1);
  });
