#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MIN_INTERVAL_MS, createFetcher } from './fetch.mjs';
import * as opencctv from './adapters/opencctv.mjs';
import {
  ROLLING_LIMIT,
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

/**
 * camindex: find public webcams in directories, check that they publish a
 * picture, and write the catalog the app's camindex pack serves.
 *
 *   node scripts/camindex/index.mjs discover --source opencctv
 *        [--scope default|maryland|non-traffic|all] [--limit N]
 *        [--via listings|sitemap|commoncrawl] [--cc-index CC-MAIN-…]
 *        [--page-details] [--gap-ms MS]
 *   node scripts/camindex/index.mjs verify [--rolling] [--limit N] [--gap-ms MS]
 *   node scripts/camindex/index.mjs build [--only-verified]
 *   node scripts/camindex/index.mjs status
 *   node scripts/camindex/index.mjs schedule [--once] [--every-min 60]
 *
 * Everything lives in CAMINDEX_DIR (default .gev-cache/camindex in the
 * repository): http/ (every page read, on disk), <source>/candidates.json,
 * <source>/verify.json, catalog.json, runs.jsonl, and the server's
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
const SOURCES = { opencctv };

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
    minIntervalMs: gapOf(flags['gap-ms']),
    log,
  });
  const scope = String(flags.scope || 'default');
  const result = await adapter.discover(fetcher, {
    scope,
    limit: limitOf(flags.limit),
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
    byCategory: countBy(thisRun, (item) =>
      opencctv.primaryCategory(item.categories || []),
    ),
    stoppedBy: result.stoppedBy,
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

async function verifyCommand(dir, flags) {
  const source = String(flags.source || 'opencctv');
  const files = sourceFiles(dir, source);
  const candidates = [...loadCandidates(files.candidates).values()];
  const records = readJson(files.verify, {}) || {};
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
      })
    : undefined;
  let checked = [];
  // Results go to verify.json and, so the app applies them at once, to
  // observed.json; both are saved every 25 checks, so a stopped run resumes.
  const save = () => {
    writeJsonAtomic(files.verify, records);
    mergeObserved(observedFile, recordsToObserved(records, checked));
    checked = [];
  };
  const result = await verifyCandidates(fetcher, candidates, records, {
    limit: limitOf(flags.limit, rolling ? ROLLING_LIMIT : Infinity),
    source,
    log,
    queue,
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

function buildCommand(dir, flags) {
  const files = sourceFiles(dir, 'opencctv');
  const records = readJson(files.verify, {}) || {};
  // What viewers' frame fetches saw since the last build.
  const folded = foldObserved(
    records,
    readObserved(path.join(dir, OBSERVED_FILE)),
  );
  if (folded) writeJsonAtomic(files.verify, records);
  const catalog = buildCatalog(
    {
      opencctv: {
        candidates: [...loadCandidates(files.candidates).values()],
        records,
      },
    },
    { onlyVerified: flags['only-verified'] === true },
  );
  const file = path.join(dir, CATALOG_FILE);
  writeJsonAtomic(file, catalog);
  const summary = {
    command: 'build',
    at: catalog.generatedAt,
    file,
    foldedObservations: folded,
    cameras: catalog.cameras.length,
    bytes: fs.statSync(file).size,
    sources: catalog.sources,
  };
  appendRun(dir, summary);
  console.log(JSON.stringify(summary, null, 2));
}

function statusCommand(dir) {
  const report = { dir, sources: {} };
  for (const source of Object.keys(SOURCES)) {
    const files = sourceFiles(dir, source);
    const candidates = [...loadCandidates(files.candidates).values()];
    const records = readJson(files.verify, {}) || {};
    report.sources[source] = {
      candidates: candidates.length,
      byCategory: countBy(candidates, (item) =>
        opencctv.primaryCategory(item.categories || []),
      ),
      inMaryland: candidates.filter((item) => inBox(item)).length,
      verification: countBy(Object.values(records), (record) => record.status),
    };
  }
  const catalog = readJson(path.join(dir, CATALOG_FILE), null);
  report.catalog = catalog
    ? {
        generatedAt: catalog.generatedAt,
        cameras: catalog.cameras?.length ?? 0,
        sources: catalog.sources,
      }
    : null;
  console.log(JSON.stringify(report, null, 2));
}

export const DISCOVER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** "Nightly": a rolling verify runs when the last one is this old. */
export const ROLLING_EVERY_MS = 20 * 60 * 60 * 1000;

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
 * finished), a rolling verify nightly.
 * @returns {{discover: boolean, verify: boolean}}
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
  };
}

async function scheduleCommand(dir, flags) {
  const every = Math.max(5, Number(flags['every-min']) || 60) * 60 * 1000;
  for (;;) {
    const due = dueJobs(readRuns(dir));
    log(
      `${new Date().toISOString()} schedule: discover ${due.discover ? 'due' : 'not due'}, rolling verify ${due.verify ? 'due' : 'not due'}`,
    );
    try {
      if (due.discover)
        await discoverCommand(dir, { source: 'opencctv', scope: 'default' });
      if (due.verify) await verifyCommand(dir, { rolling: true });
      if (due.discover || due.verify) buildCommand(dir, {});
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
  if (command === 'build') return buildCommand(dir, flags);
  if (command === 'status') return statusCommand(dir);
  if (command === 'schedule') return scheduleCommand(dir, flags);
  throw new Error(
    `unknown command ${command} (discover, verify, build, status, schedule)`,
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
