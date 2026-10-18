import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { parseDumpStream } from './dump.mjs';
import {
  buildPyramid,
  createAccumulator,
  variantDomains,
  writeGrid,
} from '../../server/providers/wikipediaCoverage/grid.js';

/**
 * The steps of a Wikipedia coverage build (scripts/wikipedia/index.mjs):
 * fetch Wikimedia's GeoData dump only when it has changed, count its
 * primary Earth coordinates into the grid, optionally stream the page table
 * once for each article's size (never kept on disk), and write the grid.
 *
 * Wikimedia asks that bots name themselves with a way to reach them, and
 * that dump downloads stay to a couple of connections: one is used here,
 * with a pause between the two files.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const DUMPS = 'https://dumps.wikimedia.org/enwiki/latest/';
export const GEO_TAGS_URL = `${DUMPS}enwiki-latest-geo_tags.sql.gz`;
export const PAGE_URL = `${DUMPS}enwiki-latest-page.sql.gz`;
export const USER_AGENT =
  'gods-eye-view-personal-fork/0.1 wikipedia-coverage (+https://github.com/doctutor/gods-eye-view)';
export const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
/** The pause before a second download from the same host. */
export const DOWNLOAD_GAP_MS = 2000;
/** The GeoData dump is published about twice a month; a build a month keeps up. */
export const REFRESH_EVERY_DAYS = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Download a dump unless the server says it is unchanged (ETag or
 * Last-Modified from the last run). The answer is written beside its
 * metadata, atomically.
 * @param {{url: string, file: string, metaFile: string, fetchImpl?: typeof fetch,
 *   now?: () => number, log?: (line: string) => void, force?: boolean}} options
 * @returns {Promise<{changed: boolean, meta: object}>}
 */
export async function download({
  url,
  file,
  metaFile,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  log = () => {},
  force = false,
}) {
  const previous = readJson(metaFile, null);
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' };
  if (!force && previous && fs.existsSync(file)) {
    if (previous.etag) headers['If-None-Match'] = previous.etag;
    if (previous.lastModified)
      headers['If-Modified-Since'] = previous.lastModified;
  }
  const response = await fetchImpl(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.status === 304) {
    response.body?.cancel?.().catch?.(() => {});
    log(
      `${path.basename(url)}: unchanged since ${previous.lastModified || previous.fetchedAt}`,
    );
    return { changed: false, meta: previous };
  }
  if (!response.ok || !response.body)
    throw new Error(`${url} answered ${response.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  let bytes = 0;
  const sink = fs.createWriteStream(temporary);
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    bytes += chunk.length;
  });
  await new Promise((resolve, reject) => {
    body.on('error', reject);
    sink.on('error', reject);
    sink.on('finish', resolve);
    body.pipe(sink);
  });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== bytes) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`${url}: ${bytes} of ${declared} bytes arrived`);
  }
  fs.renameSync(temporary, file);
  const meta = {
    url,
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
    bytes,
    fetchedAt: new Date(now()).toISOString(),
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  log(
    `${path.basename(url)}: ${bytes} bytes, last modified ${meta.lastModified}`,
  );
  return { changed: true, meta };
}

/** A gzip file's text, as an async iterable of chunks. */
export function gunzipFile(file) {
  return fs.createReadStream(file).pipe(zlib.createGunzip());
}

/**
 * Open a gzip dump over the network as a stream of its text, never writing
 * it to disk (the page table is 2 GB compressed).
 */
export async function gunzipUrl(
  url,
  { fetchImpl = (...args) => fetch(...args) } = {},
) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body)
    throw new Error(`${url} answered ${response.status}`);
  return {
    chunks: Readable.fromWeb(response.body).pipe(zlib.createGunzip()),
    lastModified: response.headers.get('last-modified') || null,
  };
}

/** The dump date (YYYYMMDD) a Last-Modified header implies, else null. */
export function dumpDate(lastModified) {
  const at = Date.parse(lastModified || '');
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : null;
}

/**
 * Count the geo_tags dump into a fresh accumulator: Earth, primary tags
 * only. Every page id kept is remembered with its cell for the page pass.
 * @param {AsyncIterable<string|Uint8Array>} chunks the dump's text
 * @param {{text?: boolean, limit?: number, onProgress?: (rows: number) => void}} [options]
 */
export async function binGeoTags(
  chunks,
  { text = false, limit = Infinity, onProgress = () => {} } = {},
) {
  const accumulator = createAccumulator({ text });
  /** page id → base cell index, for the page pass. */
  const pageCells = new Map();
  const stats = {
    rows: 0,
    kept: 0,
    otherGlobe: 0,
    secondary: 0,
    invalid: 0,
    duplicatePage: 0,
    byType: {},
    byCountry: {},
  };
  let fields = null;
  const result = await parseDumpStream(chunks, {
    table: 'geo_tags',
    onColumns(columns) {
      const index = (name) => columns.indexOf(name);
      fields = {
        page: index('gt_page_id'),
        globe: index('gt_globe'),
        primary: index('gt_primary'),
        lat: index('gt_lat'),
        lon: index('gt_lon'),
        type: index('gt_type'),
        country: index('gt_country'),
      };
      for (const [name, at] of Object.entries(fields))
        if (at < 0 && name !== 'type' && name !== 'country')
          throw new Error(`The geo_tags table has no gt_${name} column`);
    },
    onRow(values) {
      stats.rows += 1;
      if (stats.rows % 100_000 === 0) onProgress(stats.rows);
      if (stats.rows > limit) return;
      if (values[fields.globe] !== 'earth') {
        stats.otherGlobe += 1;
        return;
      }
      if (Number(values[fields.primary]) !== 1) {
        stats.secondary += 1;
        return;
      }
      // A NULL coordinate is not the origin.
      const lat =
        values[fields.lat] === null ? NaN : Number(values[fields.lat]);
      const lon =
        values[fields.lon] === null ? NaN : Number(values[fields.lon]);
      const index = accumulator.add(lat, lon);
      if (index < 0) {
        stats.invalid += 1;
        return;
      }
      stats.kept += 1;
      const page = Number(values[fields.page]);
      if (pageCells.has(page)) stats.duplicatePage += 1;
      else pageCells.set(page, index);
      if (fields.type >= 0) {
        const type = values[fields.type] || '(none)';
        stats.byType[type] = (stats.byType[type] || 0) + 1;
      }
      if (fields.country >= 0 && values[fields.country]) {
        const country = values[fields.country];
        stats.byCountry[country] = (stats.byCountry[country] || 0) + 1;
      }
    },
  });
  return {
    accumulator,
    pageCells,
    stats: { ...stats, inserts: result.inserts },
  };
}

/**
 * Add each kept page's wikitext size (page_len) to its cell, from the page
 * table's stream. Only pages the geo pass kept are read; everything else
 * is dropped as it passes.
 */
export async function addPageSizes(
  chunks,
  { accumulator, pageCells, onProgress = () => {} },
) {
  const stats = { rows: 0, matched: 0, bytes: 0, redirects: 0 };
  let fields = null;
  await parseDumpStream(chunks, {
    table: 'page',
    onColumns(columns) {
      fields = {
        id: columns.indexOf('page_id'),
        len: columns.indexOf('page_len'),
        redirect: columns.indexOf('page_is_redirect'),
      };
      if (fields.id < 0 || fields.len < 0)
        throw new Error('The page table has no page_id / page_len columns');
    },
    onRow(values) {
      stats.rows += 1;
      if (stats.rows % 1_000_000 === 0) onProgress(stats.rows);
      const cell = pageCells.get(Number(values[fields.id]));
      if (cell === undefined) return;
      if (fields.redirect >= 0 && Number(values[fields.redirect]) === 1) {
        stats.redirects += 1;
        return;
      }
      const size = Number(values[fields.len]);
      if (!(size > 0)) return;
      stats.matched += 1;
      stats.bytes += size;
      accumulator.addBytes(cell, size);
    },
  });
  return stats;
}

/**
 * Build the pyramid from an accumulator and write the grid file.
 * @param {{accumulator: object, file: string, dump: object, geo: object,
 *   page?: object|null, now?: () => number}} options
 * @returns {{header: object, bytes: number}}
 */
export function writeCoverageGrid({
  accumulator,
  file,
  dump,
  geo,
  page = null,
  now = () => Date.now(),
}) {
  const levels = buildPyramid({
    counts: accumulator.counts,
    bytes: page ? accumulator.bytes : null,
  });
  const domains = variantDomains(levels[0]);
  const top = (table, n) =>
    Object.entries(table || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, count]) => ({ key, count }));
  const header = {
    builtAt: new Date(now()).toISOString(),
    source: 'Wikimedia GeoData (enwiki geo_tags)',
    dump: {
      url: dump?.url || GEO_TAGS_URL,
      etag: dump?.etag || null,
      lastModified: dump?.lastModified || null,
      date: dumpDate(dump?.lastModified),
      bytes: dump?.bytes ?? null,
    },
    rows: {
      read: geo.rows,
      kept: geo.kept,
      otherGlobe: geo.otherGlobe,
      secondary: geo.secondary,
      invalid: geo.invalid,
      duplicatePage: geo.duplicatePage,
    },
    types: top(geo.byType, 12),
    countries: top(geo.byCountry, 12),
    text: page
      ? {
          included: true,
          pagesMatched: page.matched,
          bytes: page.bytes,
          redirects: page.redirects,
          lastModified: page.lastModified || null,
        }
      : { included: false },
    domains,
  };
  const { bytes } = writeGrid(file, { header, levels });
  return { header, bytes };
}

/** The files a build directory holds. */
export function buildFiles(dir) {
  return {
    dir,
    geoTags: path.join(dir, 'enwiki-latest-geo_tags.sql.gz'),
    geoTagsMeta: path.join(dir, 'geo_tags.meta.json'),
    grid: path.join(dir, 'grid.bin'),
    runs: path.join(dir, 'runs.jsonl'),
  };
}

/**
 * The whole build: download (or reuse) the geo_tags dump, bin it, add the
 * page sizes when asked, write the grid, log the run.
 * @param {{dir: string, text?: boolean, force?: boolean, offline?: boolean,
 *   limit?: number, fetchImpl?: typeof fetch, now?: () => number,
 *   log?: (line: string) => void, sleepImpl?: (ms: number) => Promise<void>,
 *   currentHeader?: object|null}} options
 * @returns {Promise<{skipped: boolean, reason?: string, header?: object}>}
 */
export async function runBuild({
  dir,
  text = false,
  force = false,
  offline = false,
  limit = Infinity,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  log = () => {},
  sleepImpl = sleep,
  currentHeader = null,
}) {
  const files = buildFiles(dir);
  fs.mkdirSync(dir, { recursive: true });
  let dump;
  let changed = true;
  if (offline) {
    if (!fs.existsSync(files.geoTags))
      throw new Error(`offline, and ${files.geoTags} is not there`);
    dump = readJson(files.geoTagsMeta, { url: GEO_TAGS_URL });
    changed = false;
  } else {
    const answer = await download({
      url: GEO_TAGS_URL,
      file: files.geoTags,
      metaFile: files.geoTagsMeta,
      fetchImpl,
      now,
      log,
      force,
    });
    dump = answer.meta;
    changed = answer.changed;
  }
  const wantsText = text;
  const upToDate =
    !force &&
    !changed &&
    currentHeader &&
    currentHeader.dump?.etag === dump.etag &&
    currentHeader.dump?.lastModified === dump.lastModified &&
    (!wantsText || currentHeader.text?.included);
  if (upToDate) {
    log(
      'grid.bin is built from this dump already; nothing to do (--force rebuilds)',
    );
    return { skipped: true, reason: 'up to date', header: currentHeader };
  }
  const started = now();
  log('reading geo_tags…');
  const geo = await binGeoTags(gunzipFile(files.geoTags), {
    text: wantsText,
    limit,
    onProgress: (rows) => log(`  ${rows.toLocaleString('en-US')} rows`),
  });
  log(
    `geo_tags: ${geo.stats.rows.toLocaleString('en-US')} rows, ${geo.stats.kept.toLocaleString('en-US')} primary Earth coordinates kept`,
  );
  let page = null;
  if (wantsText) {
    if (offline)
      throw new Error(
        '--text needs the network: the page table is streamed, never kept',
      );
    await sleepImpl(DOWNLOAD_GAP_MS);
    log('streaming the page table for article sizes (about 2 GB, not kept)…');
    const stream = await gunzipUrl(PAGE_URL, { fetchImpl });
    page = await addPageSizes(stream.chunks, {
      accumulator: geo.accumulator,
      pageCells: geo.pageCells,
      onProgress: (rows) => log(`  ${rows.toLocaleString('en-US')} pages`),
    });
    page.lastModified = stream.lastModified;
    log(
      `page: ${page.matched.toLocaleString('en-US')} articles sized, ${page.bytes.toLocaleString('en-US')} bytes of wikitext`,
    );
  }
  const { header, bytes } = writeCoverageGrid({
    accumulator: geo.accumulator,
    file: files.grid,
    dump,
    geo: geo.stats,
    page,
    now,
  });
  log(`wrote ${files.grid} (${(bytes / 1_048_576).toFixed(1)} MB)`);
  fs.appendFileSync(
    files.runs,
    `${JSON.stringify({
      at: header.builtAt,
      seconds: Math.round((now() - started) / 1000),
      dump: header.dump.date,
      kept: header.rows.kept,
      text: header.text.included,
    })}\n`,
  );
  return { skipped: false, header };
}
