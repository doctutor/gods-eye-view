import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { checkRawDir } from '../rawDir.mjs';
import { parseDumpStream } from './dump.mjs';
import {
  buildPyramid,
  createAccumulator,
  variantDomains,
  writeGrid,
} from '../../server/providers/wikipediaCoverage/grid.js';
import {
  buildResolutions,
  createH3Accumulator,
  writeH3File,
} from '../../server/providers/wikipediaCoverage/h3.js';
import {
  PAGE_PROPS_FILE,
  POINTS_FORMAT,
  collectGeoPoints,
  collectWikidataItems,
  joinPoints,
  pageRowsForPoints,
  parseWikis,
  pointsStatusOf,
  unionWikis,
  wikiDumpUrl,
  wikiFiles,
  writePointsIndex,
} from './points.mjs';
import { pointClassOfCode } from '../../src/data/wikipediaPoints.js';

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
/** Each article's Wikidata item, for the points (484 MB, kept like geo_tags). */
export const PAGE_PROPS_URL = `${DUMPS}${PAGE_PROPS_FILE}`;
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
  /** The same articles in H3 hexagons (resolution 7; coarser ones are summed later). */
  const hexes = createH3Accumulator({ text });
  /** page id → base cell index, and → resolution-7 hexagon key, for the page pass. */
  const pageCells = new Map();
  const pageHexes = new Map();
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
      const hex = hexes.add(lat, lon);
      const page = Number(values[fields.page]);
      if (pageCells.has(page)) stats.duplicatePage += 1;
      else {
        pageCells.set(page, index);
        pageHexes.set(page, hex);
      }
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
    hexes,
    pageCells,
    pageHexes,
    stats: { ...stats, inserts: result.inserts },
  };
}

/**
 * Add each kept page's wikitext size (page_len) to its cell, from the page
 * table's stream. Only pages the geo pass kept are read; everything else
 * is dropped as it passes. `onRow` sees every row too (the points step's
 * titles, read from the same stream); without an accumulator only it runs.
 */
export async function addPageSizes(
  chunks,
  {
    accumulator = null,
    pageCells = new Map(),
    hexes = null,
    pageHexes = null,
    onProgress = () => {},
    onRow = null,
  },
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
        namespace: columns.indexOf('page_namespace'),
        title: columns.indexOf('page_title'),
      };
      if (fields.id < 0 || fields.len < 0)
        throw new Error('The page table has no page_id / page_len columns');
      if (onRow && fields.title < 0)
        throw new Error('The page table has no page_title column');
    },
    onRow(values) {
      stats.rows += 1;
      if (stats.rows % 1_000_000 === 0) onProgress(stats.rows);
      onRow?.(values, fields);
      if (!accumulator) return;
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
      if (hexes && pageHexes)
        hexes.addBytes(pageHexes.get(Number(values[fields.id])), size);
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

/**
 * Sum the hexagons into every resolution and write the H3 file, with the
 * same provenance as the grid.
 * @param {{hexes: object, file: string, dump: object, geo: object,
 *   page?: object|null, now?: () => number}} options
 * @returns {{header: object, bytes: number}}
 */
export function writeCoverageH3({
  hexes,
  file,
  dump,
  geo,
  page = null,
  now = () => Date.now(),
}) {
  const tables = buildResolutions({
    counts: hexes.counts,
    bytes: page ? hexes.bytes : null,
  });
  return writeH3File(file, {
    header: {
      builtAt: new Date(now()).toISOString(),
      source: 'Wikimedia GeoData (enwiki geo_tags)',
      dump: {
        url: dump?.url || GEO_TAGS_URL,
        etag: dump?.etag || null,
        lastModified: dump?.lastModified || null,
        date: dumpDate(dump?.lastModified),
      },
      rows: { read: geo.rows, kept: geo.kept },
      text: page
        ? { included: true, pagesMatched: page.matched, bytes: page.bytes }
        : { included: false },
    },
    tables,
  });
}

/**
 * Personal fork: one wiki's points other than enwiki's (whose dumps the
 * grid's build reads already): its geo_tags, page and page_props under
 * raw/<wiki>/ (wikiFiles), each fetched once when not offline (kept, so a
 * rebuild asks only whether they changed), then the same joins as
 * enwiki's. Offline, a missing dump is refused by name.
 * @returns {Promise<{wiki: object, points: object[], stats: object,
 *   lastModified: string|null}>}
 */
export async function pointsOfWiki(
  wiki,
  {
    raw,
    offline = false,
    secondary = false,
    force = false,
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    log = () => {},
    sleepImpl = sleep,
  },
) {
  const files = wikiFiles(raw, wiki);
  const dumps = [
    ['geo_tags', files.geoTags, files.geoTagsMeta],
    ['page', files.page, files.pageMeta],
    ['page_props', files.pageProps, files.pagePropsMeta],
  ];
  const metas = {};
  for (const [table, file, metaFile] of dumps) {
    if (offline) {
      if (!fs.existsSync(file))
        throw new Error(
          `offline, and ${file} is not there (${wikiDumpUrl(wiki, table)})`,
        );
      metas[table] = readJson(metaFile, {});
      continue;
    }
    await sleepImpl(DOWNLOAD_GAP_MS);
    const answer = await download({
      url: wikiDumpUrl(wiki, table),
      file,
      metaFile,
      fetchImpl,
      now,
      log,
      force,
    });
    metas[table] = answer.meta;
  }
  log(`${wiki.key}: reading geo_tags…`);
  const geo = await collectGeoPoints(gunzipFile(files.geoTags), { secondary });
  log(`${wiki.key}: reading the page table…`);
  const rows = pageRowsForPoints(geo.pages);
  await addPageSizes(gunzipFile(files.page), {
    onRow: rows.onRow,
    onProgress: (count) => log(`  ${count.toLocaleString('en-US')} pages`),
  });
  log(`${wiki.key}: reading page_props for the Wikidata items…`);
  const wikidata = await collectWikidataItems(
    gunzipFile(files.pageProps),
    geo.pages,
  );
  const joined = joinPoints({
    pages: geo.pages,
    articles: rows.articles,
    items: wikidata.items,
    wiki,
  });
  log(
    `${wiki.key}: ${joined.points.length.toLocaleString('en-US')} coordinates of ${rows.stats.matched.toLocaleString('en-US')} articles, ${wikidata.stats.matched.toLocaleString('en-US')} with an item`,
  );
  return {
    wiki,
    points: joined.points,
    lastModified: metas.geo_tags?.lastModified || null,
    stats: {
      geo: geo.stats,
      page: rows.stats,
      wikidata: wikidata.stats,
      byClass: joined.byClass,
    },
  };
}

/**
 * The files a build directory holds. The dump and its metadata are the
 * build's raw download: in the directory itself unless `rawDir` says
 * otherwise (the CLI's GEV_RAW_DIR/wikipedia/raw, scripts/rawDir.mjs).
 */
export function buildFiles(dir, rawDir = dir) {
  const raw = rawDir;
  return {
    dir,
    raw,
    geoTags: path.join(raw, 'enwiki-latest-geo_tags.sql.gz'),
    geoTagsMeta: path.join(raw, 'geo_tags.meta.json'),
    pageProps: path.join(raw, PAGE_PROPS_FILE),
    pagePropsMeta: path.join(raw, 'page_props.meta.json'),
    grid: path.join(dir, 'grid.bin'),
    h3: path.join(dir, 'h3.bin'),
    points: path.join(dir, 'points'),
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
  rawDir = dir,
  text = false,
  points = false,
  secondary = false,
  wikis = 'enwiki',
  pageFile = '',
  pointsOnly = false,
  force = false,
  offline = false,
  limit = Infinity,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  log = () => {},
  sleepImpl = sleep,
  currentHeader = null,
}) {
  const files = buildFiles(dir, rawDir);
  fs.mkdirSync(dir, { recursive: true });
  if (files.raw !== dir) checkRawDir(files.raw);
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
  const pointWikis = points ? parseWikis(wikis) : [];
  // enwiki's points come from the dumps the grid reads; the others' from
  // their own (pointsOfWiki).
  const enwikiPoints = pointWikis.some((wiki) => wiki.key === 'enwiki');
  const pointsNow = points ? pointsStatusOf(files.points) : null;
  const pointsCurrent =
    !points ||
    (pointsNow.built &&
      pointsNow.format === POINTS_FORMAT &&
      String(pointsNow.wikis) === String(pointWikis.map((wiki) => wiki.key)) &&
      pointsNow.dump?.lastModified === dump.lastModified &&
      (!secondary || pointsNow.secondary > 0));
  const upToDate =
    !force &&
    !changed &&
    currentHeader &&
    currentHeader.dump?.etag === dump.etag &&
    currentHeader.dump?.lastModified === dump.lastModified &&
    (!wantsText || currentHeader.text?.included) &&
    fs.existsSync(files.h3) &&
    pointsCurrent;
  if (upToDate) {
    log(
      'grid.bin and h3.bin are built from this dump already; nothing to do (--force rebuilds)',
    );
    return { skipped: true, reason: 'up to date', header: currentHeader };
  }
  const started = now();
  if (pointsOnly && !points) throw new Error('--points-only needs --points');
  log('reading geo_tags…');
  // The grid's pass (not for --points-only, which leaves the grid be).
  const geo = pointsOnly
    ? null
    : await binGeoTags(gunzipFile(files.geoTags), {
        text: wantsText,
        limit,
        onProgress: (rows) => log(`  ${rows.toLocaleString('en-US')} rows`),
      });
  if (geo)
    log(
      `geo_tags: ${geo.stats.rows.toLocaleString('en-US')} rows, ${geo.stats.kept.toLocaleString('en-US')} primary Earth coordinates kept`,
    );
  // The points: every coordinate kept with its page id, for the joins.
  const geoPoints = enwikiPoints
    ? await collectGeoPoints(gunzipFile(files.geoTags), { secondary })
    : null;
  if (geoPoints)
    log(
      `points: ${geoPoints.stats.primary.toLocaleString('en-US')} primary${secondary ? ` and ${geoPoints.stats.secondary.toLocaleString('en-US')} secondary` : ''} coordinates`,
    );
  const pagePoints = geoPoints ? pageRowsForPoints(geoPoints.pages) : null;
  let page = null;
  if ((wantsText && !pointsOnly) || enwikiPoints) {
    if (offline && !pageFile)
      throw new Error(
        '--text and --points offline need the page table on disk: --page-file',
      );
    let stream;
    if (pageFile) {
      // A page table downloaded beside the other dumps, with its metadata.
      log(`reading the page table from ${pageFile}…`);
      stream = {
        chunks: gunzipFile(pageFile),
        lastModified:
          readJson(path.join(path.dirname(pageFile), 'page.meta.json'), {})
            .lastModified || null,
      };
    } else {
      await sleepImpl(DOWNLOAD_GAP_MS);
      log(
        `streaming the page table for article ${wantsText ? 'sizes' : 'titles'} (about 2 GB, not kept)…`,
      );
      stream = await gunzipUrl(PAGE_URL, { fetchImpl });
    }
    const sized = await addPageSizes(stream.chunks, {
      ...(wantsText && !pointsOnly
        ? {
            accumulator: geo.accumulator,
            pageCells: geo.pageCells,
            hexes: geo.hexes,
            pageHexes: geo.pageHexes,
          }
        : {}),
      onRow: pagePoints?.onRow || null,
      onProgress: (rows) => log(`  ${rows.toLocaleString('en-US')} pages`),
    });
    if (wantsText && !pointsOnly) {
      page = sized;
      page.lastModified = stream.lastModified;
      log(
        `page: ${page.matched.toLocaleString('en-US')} articles sized, ${page.bytes.toLocaleString('en-US')} bytes of wikitext`,
      );
    }
  }
  let pointsManifest = null;
  if (points) {
    // Each wiki's points, enwiki's from the dumps read above, then one dot
    // an item (unionWikis).
    const perWiki = [];
    let props = null;
    if (geoPoints) {
      if (offline) {
        // Offline: the page_props dump already beside geo_tags, no request.
        if (!fs.existsSync(files.pageProps))
          throw new Error(`offline, and ${files.pageProps} is not there`);
        props = {
          meta: readJson(files.pagePropsMeta, { url: PAGE_PROPS_URL }),
        };
      } else {
        await sleepImpl(DOWNLOAD_GAP_MS);
        props = await download({
          url: PAGE_PROPS_URL,
          file: files.pageProps,
          metaFile: files.pagePropsMeta,
          fetchImpl,
          now,
          log,
          force,
        });
      }
      log('reading page_props for the Wikidata items…');
      const wikidata = await collectWikidataItems(
        gunzipFile(files.pageProps),
        geoPoints.pages,
      );
      const joined = joinPoints({
        pages: geoPoints.pages,
        articles: pagePoints.articles,
        items: wikidata.items,
        wiki: pointWikis.find((wiki) => wiki.key === 'enwiki'),
      });
      perWiki.push({
        wiki: pointWikis.find((wiki) => wiki.key === 'enwiki'),
        points: joined.points,
        lastModified: dump.lastModified || null,
        stats: {
          geo: geoPoints.stats,
          page: pagePoints.stats,
          wikidata: wikidata.stats,
          byClass: joined.byClass,
        },
      });
    }
    for (const wiki of pointWikis)
      if (wiki.key !== 'enwiki')
        perWiki.push(
          await pointsOfWiki(wiki, {
            raw: files.raw,
            offline,
            secondary,
            force,
            fetchImpl,
            now,
            log,
            sleepImpl,
          }),
        );
    const union = unionWikis(perWiki);
    const byClass = {};
    // Every coordinate kept, by class (as joinPoints counts a wiki's).
    for (const point of union.points) {
      const key = pointClassOfCode(point.cls).key;
      byClass[key] = (byClass[key] || 0) + 1;
    }
    const only = perWiki.length === 1 ? perWiki[0].stats : null;
    pointsManifest = writePointsIndex({
      points: union.points,
      langs: union.langs,
      dir: files.points,
      dump: {
        date: dumpDate(dump.lastModified),
        lastModified: dump.lastModified || null,
        etag: dump.etag || null,
        pageProps: props?.meta.lastModified || null,
        wikis: Object.fromEntries(
          perWiki.map(({ wiki, lastModified }) => [wiki.key, lastModified]),
        ),
      },
      wikis: pointWikis,
      stats: {
        ...(only
          ? { geo: only.geo, page: only.page, wikidata: only.wikidata }
          : {}),
        byClass,
        byWiki: Object.fromEntries(
          perWiki.map(({ wiki, stats }) => [
            wiki.key,
            { ...stats, ...union.byWiki[wiki.key] },
          ]),
        ),
      },
      now,
      log,
    });
  }
  // --points-only: the grid and the hexagons are left as they are.
  if (pointsOnly)
    return { skipped: false, pointsOnly: true, points: pointsManifest };
  const { header, bytes } = writeCoverageGrid({
    accumulator: geo.accumulator,
    file: files.grid,
    dump,
    geo: geo.stats,
    page,
    now,
  });
  log(`wrote ${files.grid} (${(bytes / 1_048_576).toFixed(1)} MB)`);
  log('summing the hexagons…');
  const h3 = writeCoverageH3({
    hexes: geo.hexes,
    file: files.h3,
    dump,
    geo: geo.stats,
    page,
    now,
  });
  const cells = h3.header.resolutions.map((entry) => entry.cells);
  log(
    `wrote ${files.h3} (${(h3.bytes / 1_048_576).toFixed(1)} MB; cells by resolution ${cells.join(', ')})`,
  );
  fs.appendFileSync(
    files.runs,
    `${JSON.stringify({
      at: header.builtAt,
      seconds: Math.round((now() - started) / 1000),
      dump: header.dump.date,
      kept: header.rows.kept,
      text: header.text.included,
      h3Cells: cells,
    })}\n`,
  );
  return { skipped: false, header, h3: h3.header, points: pointsManifest };
}
