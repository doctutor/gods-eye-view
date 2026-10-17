#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MIN_INTERVAL_MS, createFetcher } from './fetch.mjs';
import * as opencctv from './adapters/opencctv.mjs';
import * as openeagleeye from './adapters/openeagleeye.mjs';
import * as pocketworld from './adapters/pocketworld.mjs';
import {
  ROLLING_LIMIT,
  VERIFY_PARALLEL,
  inBox,
  rollingQueue,
  stillPacing,
  verifyCandidates,
} from './verify.mjs';
import {
  CATALOG_FILE,
  buildCatalog,
  foldObserved,
  readJson,
  recordsToObserved,
  writeJsonAtomic,
} from './catalog.mjs';
import {
  OBSERVED_FILE,
  VIEWS_FILE,
  mergeObserved,
  readObserved,
  readViews,
} from '../../server/providers/cctv/observed.js';
import {
  LIVENESS_DAILY_UNITS,
  LIVENESS_FEATURE,
  RESOLVE_FILE,
  RESOLVE_GAP_MS,
  RESOLVE_MAX_MINUTES,
  checkYoutubeLiveness,
  resolveCandidates,
  resolveQueue,
} from './resolve.mjs';
import {
  createYoutubeClient,
  createYoutubeQuota,
} from '../../server/providers/cctv/featuredChannels.js';

/**
 * camindex: find public webcams in directories, check that they publish a
 * picture, and write the catalog the app's camindex pack serves.
 *
 *   node scripts/camindex/index.mjs discover --source opencctv
 *        [--scope default|maryland|non-traffic|all] [--limit N]
 *        [--via listings|sitemap|commoncrawl] [--cc-index CC-MAIN-…]
 *        [--page-details] [--gap-ms MS]
 *   node scripts/camindex/index.mjs verify [--source S] [--rolling] [--limit N]
 *        [--gap-ms MS] [--parallel N]
 *   node scripts/camindex/index.mjs resolve [--limit N] [--max-minutes M]
 *        [--near "lat,lon;lat,lon" --radius-km 20]
 *   node scripts/camindex/index.mjs liveness [--cap UNITS]
 *   node scripts/camindex/index.mjs build [--only-verified]
 *   node scripts/camindex/index.mjs status [--json] [--write-doc]
 *   node scripts/camindex/index.mjs schedule [--once] [--every-min 60]
 *
 * Everything lives in CAMINDEX_DIR (default .gev-cache/camindex in the
 * repository): http/ (every page read, on disk), <source>/candidates.json,
 * <source>/verify.json, opencctv/resolve.json (the operator feed each
 * OpenCCTV camera page names), catalog.json, runs.jsonl, and the server's
 * observed.json (what viewers' frame fetches saw) and views.log (where they
 * looked). The rules each source is read under are in SOURCES.md.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SOURCES = { opencctv, openeagleeye, pocketworld };
/** A candidate's category in run summaries, by its source's own rule. */
const categoryOf = (source, item) =>
  SOURCES[source]?.categoryOf
    ? SOURCES[source].categoryOf(item)
    : opencctv.primaryCategory(item.categories || []);

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

export function camindexDir(env = process.env, flags = {}) {
  const configured = flags.dir || env.CAMINDEX_DIR;
  return configured
    ? path.resolve(ROOT, configured)
    : path.join(ROOT, '.gev-cache', 'camindex');
}

/** --gap-ms: a slower pace than the 1.5 s floor, never a faster one. */
const gapOf = (value) => {
  if (value === undefined) return DEFAULT_MIN_INTERVAL_MS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < DEFAULT_MIN_INTERVAL_MS)
    throw new Error(`--gap-ms must be at least ${DEFAULT_MIN_INTERVAL_MS}`);
  return number;
};

const limitOf = (value, fallback = Infinity) => {
  if (value === undefined || value === true) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`--limit must be a positive integer`);
  return number;
};

function sourceFiles(dir, source) {
  return {
    candidates: path.join(dir, source, 'candidates.json'),
    verify: path.join(dir, source, 'verify.json'),
  };
}

function loadCandidates(file) {
  const saved = readJson(file, null);
  return new Map(
    (Array.isArray(saved?.candidates) ? saved.candidates : []).map((item) => [
      item.id,
      item,
    ]),
  );
}

function appendRun(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`);
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

const log = (line) => console.log(`[camindex] ${line}`);

async function discoverCommand(dir, flags) {
  const source = String(flags.source || 'opencctv');
  const adapter = SOURCES[source];
  if (!adapter) throw new Error(`unknown --source ${source}`);
  const files = sourceFiles(dir, source);
  const started = Date.now();
  const fetcher = createFetcher({
    cacheDir: path.join(dir, 'http'),
    // A source may ask for a slower pace than the floor (pocketworld: 2 s).
    minIntervalMs: Math.max(
      gapOf(flags['gap-ms']),
      adapter.MIN_INTERVAL_MS || 0,
    ),
    log,
  });
  const scope = String(flags.scope || adapter.DEFAULT_SCOPE || 'default');
  const result = await adapter.discover(fetcher, {
    scope,
    limit: limitOf(flags.limit, adapter.DEFAULT_LIMIT),
    via: String(flags.via || 'listings'),
    known: loadCandidates(files.candidates),
    pageDetails: flags['page-details'] === true,
    commonCrawlIndex:
      typeof flags['cc-index'] === 'string' ? flags['cc-index'] : undefined,
    log,
  });
  const candidates = [...result.candidates.values()];
  writeJsonAtomic(files.candidates, {
    source,
    updatedAt: new Date().toISOString(),
    candidates,
  });
  const thisRun = candidates.filter((item) => result.found.has(item.id));
  const summary = {
    command: 'discover',
    source,
    scope,
    at: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    pagesRead: result.pagesRead,
    fromNetwork: result.fromNetwork,
    skipped: result.skipped?.length ?? 0,
    found: thisRun.length,
    known: candidates.length,
    byCategory: countBy(thisRun, (item) => categoryOf(source, item)),
    stoppedBy: result.stoppedBy,
    ...(result.api ? { api: result.api } : {}),
    ...(result.dropped ? { dropped: result.dropped } : {}),
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

async function verifyCommand(dir, flags) {
  const source = String(flags.source || 'opencctv');
  const files = sourceFiles(dir, source);
  const records = readJson(files.verify, {}) || {};
  // Cards a source has reclassified (PocketWorld's link hosts) have no still.
  const loaded = [...loadCandidates(files.candidates).values()];
  const candidates =
    SOURCES[source]?.adjustCandidates?.(dir, loaded, records)?.candidates ||
    loaded;
  const started = Date.now();
  const fetcher = createFetcher({
    cacheDir: path.join(dir, 'http'),
    minIntervalMs: stillPacing(gapOf(flags['gap-ms'])),
    log,
  });
  const observedFile = path.join(dir, OBSERVED_FILE);
  const rolling = flags.rolling === true;
  const queue = rolling
    ? rollingQueue({
        candidates,
        records,
        observed: readObserved(observedFile),
        views: readViews(path.join(dir, VIEWS_FILE)),
        now: started,
        observedId: (candidate) => `${source}-${candidate.id}`,
      })
    : undefined;
  let checked = [];
  // Results go to verify.json and, so the app applies them at once, to
  // observed.json; both are saved every 25 checks, so a stopped run resumes.
  const save = () => {
    writeJsonAtomic(files.verify, records);
    mergeObserved(
      observedFile,
      recordsToObserved(records, checked, `${source}-`),
    );
    checked = [];
  };
  const result = await verifyCandidates(fetcher, candidates, records, {
    limit: limitOf(flags.limit, rolling ? ROLLING_LIMIT : Infinity),
    source,
    log,
    queue,
    // Several hosts at once; each host keeps its own floor (stillPacing).
    parallel: limitOf(flags.parallel, VERIFY_PARALLEL),
    onRecord: (candidate) => {
      checked.push(candidate.id);
      if (checked.length >= 25) save();
    },
  });
  // Shared-placeholder marks can change earlier records too.
  checked = [
    ...new Set([
      ...checked,
      ...Object.keys(records).filter(
        (id) => records[id].status === 'placeholder',
      ),
    ]),
  ];
  save();
  const summary = {
    command: 'verify',
    rolling,
    ...(queue ? { queued: queue.length } : {}),
    source,
    at: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    ...result,
    states: countBy(Object.values(records), (record) => record.status),
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

/** --near "lat,lon;lat,lon" to points. */
export function nearOf(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(';')
    .map((pair) => pair.split(',').map(Number))
    .map(([lat, lon]) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        throw new Error('--near takes "lat,lon;lat,lon"');
      return { lat, lon };
    });
}

/**
 * Read OpenCCTV camera pages for the operator feed they name (resolve.mjs),
 * near the places viewed first, saved every 25 pages so a stopped run
 * resumes.
 */
async function resolveCommand(dir, flags) {
  const files = sourceFiles(dir, 'opencctv');
  const resolveFile = path.join(dir, 'opencctv', RESOLVE_FILE);
  const records = readJson(resolveFile, {}) || {};
  const candidates = [...loadCandidates(files.candidates).values()];
  const started = Date.now();
  const fetcher = createFetcher({
    cacheDir: path.join(dir, 'http'),
    minIntervalMs: Math.max(gapOf(flags['gap-ms']), RESOLVE_GAP_MS),
    log,
  });
  const near = nearOf(flags.near);
  const radius = Number(flags['radius-km']);
  const queue = resolveQueue({
    candidates,
    records,
    views: readViews(path.join(dir, VIEWS_FILE)),
    now: started,
    near,
    radiusKm: Number.isFinite(radius) && radius > 0 ? radius : 20,
  });
  const minutes = Number(flags['max-minutes']);
  let unsaved = 0;
  const result = await resolveCandidates(fetcher, queue, records, {
    limit: limitOf(flags.limit),
    maxMs:
      (Number.isFinite(minutes) && minutes > 0
        ? minutes
        : RESOLVE_MAX_MINUTES) *
      60 *
      1000,
    log,
    onRecord: () => {
      if (++unsaved >= 25) {
        writeJsonAtomic(resolveFile, records);
        unsaved = 0;
      }
    },
  });
  writeJsonAtomic(resolveFile, records);
  const summary = {
    command: 'resolve',
    source: 'opencctv',
    at: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    queued: queue.length,
    ...(near.length ? { near: near.length } : {}),
    ...result,
    states: countBy(Object.values(records), (record) => record.status),
    kinds: countBy(
      Object.values(records).filter((record) => record.primary),
      (record) => record.primary.kind,
    ),
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

/** The shared YouTube key and quota file, for the liveness check. */
async function youtubeParts(env = process.env) {
  // The .env reader loads Vite: only the liveness check needs it.
  const { readDotenvValue } = await import('../read-dotenv-value.mjs');
  const key = String(
    env.YOUTUBE_API_KEY || readDotenvValue('YOUTUBE_API_KEY', ROOT) || '',
  ).trim();
  const apiKey = () => key;
  const quota = createYoutubeQuota({
    file:
      env.CAMINDEX_QUOTA_FILE ||
      path.join(ROOT, '.gev-cache', 'cctv-featured', 'quota.json'),
  });
  return {
    quota,
    youtube: createYoutubeClient({
      apiKey,
      quota,
      feature: LIVENESS_FEATURE,
    }),
  };
}

/**
 * Whether the YouTube streams the catalog resolved are still live (50 a
 * call, LIVENESS_DAILY_UNITS a day at most); the answers go to
 * observed.json, which the app applies at once.
 */
export async function livenessCommand(dir, flags = {}, parts = null) {
  parts ||= await youtubeParts();
  const started = Date.now();
  const catalog = readJson(path.join(dir, CATALOG_FILE), null);
  const cameras = (catalog?.cameras || []).filter(
    (camera) => camera.primaryVia === 'opencctv',
  );
  const cap = Number(flags.cap);
  const result = await checkYoutubeLiveness({
    cameras,
    ...parts,
    cap:
      Number.isFinite(cap) && cap >= 0
        ? Math.min(cap, LIVENESS_DAILY_UNITS)
        : LIVENESS_DAILY_UNITS,
    log,
  });
  if (Object.keys(result.observations).length)
    mergeObserved(path.join(dir, OBSERVED_FILE), result.observations);
  const summary = {
    command: 'liveness',
    at: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    checked: result.checked,
    units: result.units,
    stoppedBy: result.stoppedBy,
    states: countBy(
      Object.values(result.observations),
      (observation) => observation.status,
    ),
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function buildCommand(dir, flags) {
  // What viewers' frame fetches saw since the last build, per source (catalog
  // ids are "<source>-<candidate id>").
  const observed = readObserved(path.join(dir, OBSERVED_FILE));
  const inputs = {};
  const adjustments = {};
  let folded = 0;
  for (const source of Object.keys(SOURCES)) {
    const files = sourceFiles(dir, source);
    if (!fs.existsSync(files.candidates)) continue;
    const records = readJson(files.verify, {}) || {};
    const changed = foldObserved(records, observed, `${source}-`);
    if (changed) writeJsonAtomic(files.verify, records);
    folded += changed;
    const candidates = [...loadCandidates(files.candidates).values()];
    // A source may reclassify its candidates from what verify learned
    // (PocketWorld's link hosts).
    const adjusted = SOURCES[source].adjustCandidates?.(
      dir,
      candidates,
      records,
    );
    if (adjusted)
      adjustments[source] = {
        converted: adjusted.converted,
        linkHosts: adjusted.linkHosts,
      };
    inputs[source] = adjusted
      ? { candidates: adjusted.candidates, records: adjusted.records }
      : { candidates, records };
    // The operator feeds OpenCCTV camera pages name (resolve).
    if (source === 'opencctv')
      inputs[source].resolved =
        readJson(path.join(dir, source, RESOLVE_FILE), {}) || {};
  }
  const catalog = buildCatalog(inputs, {
    onlyVerified: flags['only-verified'] === true,
  });
  const file = path.join(dir, CATALOG_FILE);
  writeJsonAtomic(file, catalog);
  const summary = {
    command: 'build',
    at: catalog.generatedAt,
    file,
    foldedObservations: folded,
    ...(Object.keys(adjustments).length ? { adjustments } : {}),
    cameras: catalog.cameras.length,
    bytes: fs.statSync(file).size,
    sources: catalog.sources,
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

/** Where `status --write-doc` keeps the counts table. */
export const STATUS_DOC = path.join(ROOT, 'scripts', 'camindex', 'SOURCES.md');
const DOC_START = '<!-- camindex-status:start -->';
const DOC_END = '<!-- camindex-status:end -->';

/**
 * Per-source counts: candidates found, cameras in the catalog (after the
 * cross-source merge), and verification verdicts (verify runs and viewers'
 * frames folded in at build).
 */
export function statusRows(sources, catalog) {
  const inCatalog = countBy(catalog?.cameras || [], (camera) =>
    String(camera.id || '').replace(/-.*$/, ''),
  );
  return Object.entries(sources).map(
    ([source, { candidates, records, links = 0 }]) => {
      const states = countBy(Object.values(records), (record) => record.status);
      return {
        source,
        found: candidates,
        served: inCatalog[source] || 0,
        verified: Object.keys(records).length,
        live: states.live || 0,
        dead: states.dead || 0,
        placeholder: states.placeholder || 0,
        links,
      };
    },
  );
}

/** The counts as a Markdown table, with the build it describes. */
export function statusTable(rows, generatedAt) {
  const number = (value) => value.toLocaleString('en-US');
  const lines = [
    `Counts from the build of ${generatedAt || '(no build yet)'}; regenerate with \`npm run camindex:status -- --write-doc\`.`,
    '',
    '| Source | Found | In catalog | Checked | Live | Dead | Placeholder | Became links |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.source} | ${number(row.found)} | ${number(row.served)} | ${number(row.verified)} | ${number(row.live)} | ${number(row.dead)} | ${number(row.placeholder)} | ${number(row.links)} |`,
    ),
  ];
  return lines.join('\n');
}

/** Replace the marked block in a document with `table`. */
export function replaceStatusBlock(text, table) {
  const start = text.indexOf(DOC_START);
  const end = text.indexOf(DOC_END);
  if (start < 0 || end < start) throw new Error('status block markers missing');
  return `${text.slice(0, start + DOC_START.length)}\n${table}\n${text.slice(end)}`;
}

function statusCommand(dir, flags = {}) {
  const report = { dir, sources: {} };
  const counts = {};
  for (const source of Object.keys(SOURCES)) {
    const files = sourceFiles(dir, source);
    const candidates = [...loadCandidates(files.candidates).values()];
    const records = readJson(files.verify, {}) || {};
    report.sources[source] = {
      candidates: candidates.length,
      byCategory: countBy(candidates, (item) => categoryOf(source, item)),
      inMaryland: candidates.filter((item) => inBox(item)).length,
      verification: countBy(Object.values(records), (record) => record.status),
    };
    if (candidates.length) {
      // As build sees them: cards that proved to be pages count as links,
      // not dead (PocketWorld's link hosts; nothing is written here).
      const adapter = SOURCES[source];
      const adjusted = adapter.learnLinkHosts
        ? adapter.applyLinkHosts(
            candidates,
            records,
            adapter.learnLinkHosts(candidates, records),
          )
        : null;
      counts[source] = {
        candidates: candidates.length,
        records: adjusted?.records || records,
        links: adjusted?.converted || 0,
      };
    }
  }
  const resolved = Object.values(
    readJson(path.join(dir, 'opencctv', RESOLVE_FILE), {}) || {},
  );
  report.resolve = {
    read: resolved.length,
    states: countBy(resolved, (record) => record.status),
    kinds: countBy(
      resolved.filter((record) => record.primary),
      (record) => record.primary.kind,
    ),
  };
  const catalog = readJson(path.join(dir, CATALOG_FILE), null);
  report.catalog = catalog
    ? {
        generatedAt: catalog.generatedAt,
        cameras: catalog.cameras?.length ?? 0,
        sources: catalog.sources,
      }
    : null;
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const table = statusTable(statusRows(counts, catalog), catalog?.generatedAt);
  console.log(`camindex in ${dir}\n`);
  console.log(table);
  console.log(
    `\nCatalog: ${report.catalog ? `${report.catalog.cameras.toLocaleString('en-US')} cameras` : 'not built'}.`,
  );
  if (report.resolve.read)
    console.log(
      `Resolved: ${report.resolve.read.toLocaleString('en-US')} OpenCCTV camera pages read; operator feeds ${
        Object.entries(report.resolve.kinds)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(', ') || 'none'
      }.`,
    );
  // The last run of each command, from runs.jsonl.
  const last = {};
  for (const run of readRuns(dir))
    last[run.rolling ? 'verify --rolling' : run.command] = run;
  for (const [name, run] of Object.entries(last))
    console.log(
      `Last ${name}: ${run.at}${run.source ? ` (${run.source})` : ''}${run.seconds !== undefined ? `, ${run.seconds} s` : ''}${run.stoppedBy ? `, ${run.stoppedBy}` : ''}${run.error ? `, error: ${run.error}` : ''}`,
    );
  if (flags['write-doc'] === true) {
    const doc = fs.readFileSync(STATUS_DOC, 'utf8');
    fs.writeFileSync(STATUS_DOC, replaceStatusBlock(doc, table));
    console.log(`\nWrote the table to ${STATUS_DOC}.`);
  }
}

export const DISCOVER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** "Nightly": a rolling verify runs when the last one is this old. */
export const ROLLING_EVERY_MS = 20 * 60 * 60 * 1000;
/** A resolve slice and a liveness check, as often. */
export const RESOLVE_EVERY_MS = ROLLING_EVERY_MS;

function readRuns(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Which scheduled jobs are due: discover weekly (counting runs that
 * finished), a rolling verify, a resolve slice and a YouTube liveness check
 * nightly.
 * @returns {{discover: boolean, verify: boolean, resolve: boolean,
 *   liveness: boolean}}
 */
export function dueJobs(runs, now = Date.now()) {
  const last = (match) =>
    Math.max(
      -Infinity,
      ...runs.filter(match).map((run) => Date.parse(run.at) || -Infinity),
    );
  return {
    discover:
      now -
        last(
          (run) =>
            run.command === 'discover' &&
            ['complete', 'limit'].includes(run.stoppedBy),
        ) >=
      DISCOVER_EVERY_MS,
    verify:
      now - last((run) => run.command === 'verify' && run.rolling) >=
      ROLLING_EVERY_MS,
    resolve: now - last((run) => run.command === 'resolve') >= RESOLVE_EVERY_MS,
    liveness:
      now - last((run) => run.command === 'liveness') >= RESOLVE_EVERY_MS,
  };
}

async function scheduleCommand(dir, flags) {
  const every = Math.max(5, Number(flags['every-min']) || 60) * 60 * 1000;
  for (;;) {
    const due = dueJobs(readRuns(dir));
    log(
      `${new Date().toISOString()} schedule: discover ${due.discover ? 'due' : 'not due'}, rolling verify ${due.verify ? 'due' : 'not due'}, resolve ${due.resolve ? 'due' : 'not due'}, liveness ${due.liveness ? 'due' : 'not due'}`,
    );
    try {
      if (due.discover)
        await discoverCommand(dir, { source: 'opencctv', scope: 'default' });
      // Every source with candidates; those without stills check nothing.
      if (due.verify)
        for (const source of Object.keys(SOURCES))
          if (fs.existsSync(sourceFiles(dir, source).candidates))
            await verifyCommand(dir, { rolling: true, source });
      // A slice of the camera pages a night, within its wall-clock cap.
      if (due.resolve && fs.existsSync(sourceFiles(dir, 'opencctv').candidates))
        await resolveCommand(dir, {});
      if (due.discover || due.verify || due.resolve) buildCommand(dir, {});
      // After the build, so newly resolved streams are checked too.
      if (due.liveness) await livenessCommand(dir, {});
    } catch (error) {
      log(`schedule: ${error?.message || error}`);
      appendRun(dir, {
        command: 'schedule',
        at: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 200),
      });
    }
    if (flags.once === true) return;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, flags } = parseArgs(argv);
  const dir = camindexDir(env, flags);
  if (command === 'discover') return discoverCommand(dir, flags);
  if (command === 'verify') return verifyCommand(dir, flags);
  if (command === 'resolve') return resolveCommand(dir, flags);
  if (command === 'liveness') return livenessCommand(dir, flags);
  if (command === 'build') return buildCommand(dir, flags);
  if (command === 'status') return statusCommand(dir, flags);
  if (command === 'schedule') return scheduleCommand(dir, flags);
  throw new Error(
    `unknown command ${command} (discover, verify, resolve, liveness, build, status, schedule)`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`[camindex] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
