#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MIN_INTERVAL_MS, createFetcher } from './fetch.mjs';
import * as opencctv from './adapters/opencctv.mjs';
import { inBox, verifyCandidates } from './verify.mjs';
import {
  CATALOG_FILE,
  buildCatalog,
  readJson,
  writeJsonAtomic,
} from './catalog.mjs';

/**
 * camindex: find public webcams in directories, check that they publish a
 * picture, and write the catalog the app's camindex pack serves.
 *
 *   node scripts/camindex/index.mjs discover --source opencctv
 *        [--scope default|maryland|non-traffic|all] [--limit N]
 *        [--via listings|sitemap|commoncrawl] [--cc-index CC-MAIN-…]
 *        [--page-details] [--gap-ms MS]
 *   node scripts/camindex/index.mjs verify [--limit N] [--gap-ms MS]
 *   node scripts/camindex/index.mjs build [--only-verified]
 *   node scripts/camindex/index.mjs status
 *
 * Everything lives in CAMINDEX_DIR (default .gev-cache/camindex in the
 * repository): http/ (every page read, on disk), <source>/candidates.json,
 * <source>/verify.json, catalog.json and runs.jsonl. The rules each source is
 * read under are in SOURCES.md.
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
    minIntervalMs: gapOf(flags['gap-ms']),
    log,
  });
  let unsaved = 0;
  const result = await verifyCandidates(fetcher, candidates, records, {
    limit: limitOf(flags.limit),
    source,
    log,
    onRecord: () => {
      // Resumable: progress is saved every 25 checks.
      if (++unsaved >= 25) {
        writeJsonAtomic(files.verify, records);
        unsaved = 0;
      }
    },
  });
  writeJsonAtomic(files.verify, records);
  const summary = {
    command: 'verify',
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
  const catalog = buildCatalog(
    {
      opencctv: {
        candidates: [...loadCandidates(files.candidates).values()],
        records: readJson(files.verify, {}) || {},
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { command, flags } = parseArgs(argv);
  const dir = camindexDir(env, flags);
  if (command === 'discover') return discoverCommand(dir, flags);
  if (command === 'verify') return verifyCommand(dir, flags);
  if (command === 'build') return buildCommand(dir, flags);
  if (command === 'status') return statusCommand(dir);
  throw new Error(
    `unknown command ${command} (discover, verify, build, status)`,
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
