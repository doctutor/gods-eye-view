import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDumpStream } from './dump.mjs';
import {
  FLAG_SECONDARY,
  thinPoints,
  unitX,
  unitY,
  writePointsFiles,
} from '../../server/providers/wikipediaCoverage/pointsFile.js';
import {
  WIKIPEDIA_POINTS_FULL_ZOOM,
  WIKIPEDIA_POINTS_PER_TILE,
  WIKIPEDIA_POINT_WIKIS,
  pointClassOf,
  wikiBit,
} from '../../src/data/wikipediaPoints.js';

/**
 * The Wikipedia build's points step (`--points`): one dot per geotagged
 * article, for the Wikipedia layer's Articles mode.
 *
 * 1. geo_tags (already on disk): every Earth coordinate, the primary ones
 *    (one per article) and, with `--secondary`, the secondary ones (an
 *    article's other places), with GeoData's type and dim.
 * 2. page (streamed, as --text does): title, size, namespace; articles
 *    only (namespace 0, not redirects).
 * 3. page_props (enwiki-latest-page_props.sql.gz, kept with geo_tags):
 *    each article's Wikidata item (`wikibase_item`), the key the wikis
 *    are unioned by, so an article is never counted twice.
 * 4. With `--wikis enwiki,dewiki,…`, the same three for each other wiki
 *    (raw/<wiki>/, wikiFiles), then one dot an item (unionWikis): enwiki's
 *    article, else the first listed wiki's; each record carries the mask
 *    of the wikis with an article on its item, and a langs file their
 *    pages and sizes.
 * 5. Ranked (primary first, then the type class, article bytes and
 *    languages, dim) and thinned per tile below z 12 (pointsFile.js),
 *    written under points/.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const PAGE_PROPS_FILE = 'enwiki-latest-page_props.sql.gz';
/**
 * 2: ranked by article bytes before dim, list and period titles as other.
 * 3: several wikis unioned by Wikidata item: a record carries the mask of
 * the wikis with an article on its item, ranks by it too, and a langs
 * file lists each item's page and size per wiki.
 */
export const POINTS_FORMAT = 3;

/** The wikis a build reads (`--wikis`, comma-separated, enwiki first by default). */
export function parseWikis(spec = 'enwiki') {
  const names = String(spec || 'enwiki')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const wikis = [];
  for (const name of names) {
    const wiki = WIKIPEDIA_POINT_WIKIS.find((entry) => entry.key === name);
    if (!wiki)
      throw new Error(
        `--wikis ${name}: not one of ${WIKIPEDIA_POINT_WIKIS.map((w) => w.key).join(', ')}`,
      );
    if (!wikis.includes(wiki)) wikis.push(wiki);
  }
  if (!wikis.length) throw new Error('--wikis names no wiki');
  return wikis;
}

/** A wiki's dump on dumps.wikimedia.org. */
export const wikiDumpUrl = (wiki, table) =>
  `https://dumps.wikimedia.org/${wiki.key}/latest/${wiki.key}-latest-${table}.sql.gz`;

/**
 * A wiki's three dumps under the raw directory: raw/<wiki>/<wiki>-latest-
 * {geo_tags,page,page_props}.sql.gz with their .meta.json. enwiki's sit
 * in raw/ itself, as the grid's build has always kept them, unless
 * raw/enwiki/ holds them.
 */
export function wikiFiles(raw, wiki) {
  const nested = path.join(raw, wiki.key);
  const flat =
    wiki.key === 'enwiki' &&
    !fs.existsSync(path.join(nested, `${wiki.key}-latest-geo_tags.sql.gz`));
  const at = flat ? raw : nested;
  const file = (table) => path.join(at, `${wiki.key}-latest-${table}.sql.gz`);
  return {
    dir: at,
    geoTags: file('geo_tags'),
    geoTagsMeta: path.join(at, 'geo_tags.meta.json'),
    page: file('page'),
    pageMeta: path.join(at, 'page.meta.json'),
    pageProps: file('page_props'),
    pagePropsMeta: path.join(at, 'page_props.meta.json'),
  };
}

/**
 * The geo_tags dump's Earth coordinates: Map page id → [{lat, lon, type,
 * dim, flags}], primary first.
 * @param {AsyncIterable<string|Uint8Array>} chunks
 * @param {{secondary?: boolean}} [options]
 */
export async function collectGeoPoints(chunks, { secondary = false } = {}) {
  const pages = new Map();
  const stats = { rows: 0, primary: 0, secondary: 0, skipped: 0 };
  let fields = null;
  await parseDumpStream(chunks, {
    table: 'geo_tags',
    onColumns(columns) {
      const index = (name) => columns.indexOf(name);
      fields = {
        page: index('gt_page_id'),
        globe: index('gt_globe'),
        primary: index('gt_primary'),
        lat: index('gt_lat'),
        lon: index('gt_lon'),
        dim: index('gt_dim'),
        type: index('gt_type'),
      };
      for (const name of ['page', 'globe', 'primary', 'lat', 'lon'])
        if (fields[name] < 0)
          throw new Error(`The geo_tags table has no gt_${name} column`);
    },
    onRow(values) {
      stats.rows += 1;
      if (values[fields.globe] !== 'earth') return void (stats.skipped += 1);
      const isPrimary = Number(values[fields.primary]) === 1;
      if (!isPrimary && !secondary) return void (stats.skipped += 1);
      const lat =
        values[fields.lat] === null ? NaN : Number(values[fields.lat]);
      const lon =
        values[fields.lon] === null ? NaN : Number(values[fields.lon]);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        return void (stats.skipped += 1);
      const page = Number(values[fields.page]);
      let list = pages.get(page);
      if (!list) pages.set(page, (list = []));
      // One primary coordinate an article: a second is GeoData's duplicate.
      if (isPrimary && list.some((p) => !(p.flags & FLAG_SECONDARY)))
        return void (stats.skipped += 1);
      const dim = fields.dim >= 0 ? Number(values[fields.dim]) : NaN;
      const point = {
        lat,
        lon,
        type: fields.type >= 0 ? String(values[fields.type] || '') : '',
        dim: Number.isFinite(dim) && dim > 0 ? dim : 0,
        flags: isPrimary ? 0 : FLAG_SECONDARY,
      };
      if (isPrimary) {
        list.unshift(point);
        stats.primary += 1;
      } else {
        list.push(point);
        stats.secondary += 1;
      }
    },
  });
  return { pages, stats };
}

/**
 * The page table's row handler for the points: an article's title and
 * size, for the pages geo_tags named (namespace 0, not redirects).
 * Returns {onRow(values, fields), articles: Map page → {title, bytes},
 * stats}; `fields` the page table's column indexes (id, namespace, title,
 * redirect, len).
 */
export function pageRowsForPoints(pages) {
  const articles = new Map();
  const stats = { matched: 0, notArticle: 0, redirects: 0 };
  return {
    articles,
    stats,
    onRow(values, fields) {
      const page = Number(values[fields.id]);
      if (!pages.has(page)) return;
      if (fields.namespace >= 0 && Number(values[fields.namespace]) !== 0)
        return void (stats.notArticle += 1);
      if (fields.redirect >= 0 && Number(values[fields.redirect]) === 1)
        return void (stats.redirects += 1);
      const title = String(values[fields.title] ?? '').replace(/_/g, ' ');
      if (!title) return;
      const bytes = Number(values[fields.len]);
      articles.set(page, {
        title,
        bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
      });
      stats.matched += 1;
    },
  };
}

/** The page_props dump's Wikidata items: Map page id → item number. */
export async function collectWikidataItems(chunks, pages) {
  const items = new Map();
  const stats = { rows: 0, matched: 0 };
  let fields = null;
  await parseDumpStream(chunks, {
    table: 'page_props',
    onColumns(columns) {
      fields = {
        page: columns.indexOf('pp_page'),
        name: columns.indexOf('pp_propname'),
        value: columns.indexOf('pp_value'),
      };
      if (Object.values(fields).some((at) => at < 0))
        throw new Error(
          'The page_props table has no pp_page / pp_propname / pp_value',
        );
    },
    onRow(values) {
      stats.rows += 1;
      if (values[fields.name] !== 'wikibase_item') return;
      const page = Number(values[fields.page]);
      if (!pages.has(page)) return;
      const match = /^Q(\d{1,10})$/.exec(String(values[fields.value] || ''));
      if (!match) return;
      items.set(page, Number(match[1]));
      stats.matched += 1;
    },
  });
  return { items, stats };
}

/**
 * The index's points from the three joins: articles only, each
 * coordinate one point carrying the article's title, size and item.
 */
export function joinPoints({
  pages,
  articles,
  items,
  wiki = WIKIPEDIA_POINT_WIKIS[0],
}) {
  const points = [];
  const byClass = {};
  for (const [page, coordinates] of pages) {
    const article = articles.get(page);
    if (!article) continue;
    for (const c of coordinates) {
      const cls = pointClassOf(c.type, article.title);
      byClass[cls.key] = (byClass[cls.key] || 0) + 1;
      points.push({
        x: unitX(c.lon),
        y: unitY(c.lat),
        page,
        qid: items?.get(page) || 0,
        bytes: article.bytes,
        dim: c.dim,
        cls: cls.code,
        flags: c.flags,
        wiki: wiki.code,
        wikis: wikiBit(wiki.code),
        title: article.title,
        type: c.type,
      });
    }
  }
  return { points, byClass };
}

/**
 * Several wikis' points as one: one article an item. Each wiki's points
 * (joinPoints') in `perWiki`, in the order asked; enwiki's record is the
 * one kept for an item it has (its title, type, class and bytes), else the
 * first wiki's in the list that has one. Another wiki's article on a kept
 * item adds no dot, only its bit in the kept record's `wikis` mask and a
 * langs entry (its page and bytes), so the card can open every language.
 * An article without an item stays its wiki's own dot.
 * @param {Array<{wiki: object, points: object[]}>} perWiki
 * @returns {{points: object[], langs: Array<{qid, wiki, page, bytes}>,
 *   byWiki: object}}
 */
export function unionWikis(perWiki) {
  const order = [
    ...perWiki.filter(({ wiki }) => wiki.key === 'enwiki'),
    ...perWiki.filter(({ wiki }) => wiki.key !== 'enwiki'),
  ];
  const items = new Map(); // qid → {wiki code, page, masks, entries}
  const kept = [];
  const byWiki = {};
  for (const { wiki, points } of order) {
    const stats = (byWiki[wiki.key] = {
      articles: 0,
      kept: 0,
      onAnItemKept: 0,
      withoutItem: 0,
    });
    // An article's coordinates (primary, secondary) arrive together.
    const pages = new Map();
    for (const point of points) {
      let list = pages.get(point.page);
      if (!list) pages.set(point.page, (list = []));
      list.push(point);
    }
    for (const [page, list] of pages) {
      stats.articles += 1;
      const qid = list[0].qid || 0;
      if (!qid) {
        stats.withoutItem += 1;
        stats.kept += 1;
        for (const point of list)
          kept.push({ ...point, wikis: wikiBit(wiki.code) });
        continue;
      }
      let item = items.get(qid);
      if (item?.wikis.has(wiki.code)) continue; // a second page on one item
      if (!item) {
        item = { records: [], wikis: new Map() };
        items.set(qid, item);
        stats.kept += 1;
        for (const point of list) {
          const record = { ...point };
          item.records.push(record);
          kept.push(record);
        }
      } else stats.onAnItemKept += 1;
      item.wikis.set(wiki.code, { page, bytes: list[0].bytes || 0 });
    }
  }
  const langs = [];
  for (const [qid, item] of items) {
    let mask = 0;
    for (const code of item.wikis.keys()) mask += wikiBit(code);
    for (const record of item.records) record.wikis = mask;
    if (item.wikis.size > 1)
      for (const [code, { page, bytes }] of item.wikis)
        langs.push({ qid, wiki: code, page, bytes });
  }
  langs.sort((a, b) => a.qid - b.qid || a.wiki - b.wiki);
  return { points: kept, langs, byWiki };
}

/** A langs file's entry: Uint32 item, Uint32 page, Uint32 bytes, Uint8 wiki, three unused. */
export const LANG_BYTES = 16;

/** The langs file's bytes from unionWikis' langs (sorted by item, then wiki). */
export function encodeLangs(langs) {
  const out = Buffer.alloc(langs.length * LANG_BYTES);
  langs.forEach(({ qid, wiki, page, bytes }, i) => {
    const at = i * LANG_BYTES;
    out.writeUInt32LE(qid >>> 0, at);
    out.writeUInt32LE(page >>> 0, at + 4);
    out.writeUInt32LE(Math.min(4294967295, bytes || 0), at + 8);
    out.writeUInt8(wiki, at + 12);
  });
  return out;
}

/**
 * Write the points index under `dir` (the build's points/): files, a
 * manifest and current.json naming it; the earlier build's files go.
 */
export function writePointsIndex({
  points,
  langs = [],
  dir,
  dump = {},
  wikis = [WIKIPEDIA_POINT_WIKIS[0]],
  stats = {},
  now = () => Date.now(),
  log = () => {},
}) {
  const started = now();
  fs.mkdirSync(path.join(dir, 'buckets'), { recursive: true });
  const stamp = crypto.randomBytes(4).toString('hex');
  const levels = thinPoints(points);
  const overviewName = `overview.${stamp}.bin`;
  const langsName = `langs.${stamp}.bin`;
  const langsBytes = encodeLangs(langs);
  fs.writeFileSync(path.join(dir, langsName), langsBytes);
  const written = writePointsFiles(levels, {
    overviewFile: path.join(dir, overviewName),
    fileOf: (bucket) =>
      path.join(
        dir,
        'buckets',
        `${bucket % 64}-${Math.floor(bucket / 64)}.${stamp}.bin`,
      ),
  });
  const buckets = {};
  for (const [bucket, entry] of written.buckets)
    buckets[bucket] = {
      file: `${bucket % 64}-${Math.floor(bucket / 64)}.${stamp}.bin`,
      ...entry,
    };
  const bytes =
    written.overview +
    Object.values(buckets).reduce((sum, b) => sum + b.bytes, 0);
  const version = crypto
    .createHash('sha256')
    .update(JSON.stringify({ buckets, overviewName }))
    .digest('hex')
    .slice(0, 12);
  const secondary = points.filter((p) => p.flags & FLAG_SECONDARY).length;
  const manifest = {
    format: POINTS_FORMAT,
    version,
    builtAt: new Date(now()).toISOString(),
    dump,
    wikis: wikis.map((wiki) => wiki.key),
    points: points.length - secondary,
    secondary,
    fullZoom: WIKIPEDIA_POINTS_FULL_ZOOM,
    perTile: WIKIPEDIA_POINTS_PER_TILE,
    bytes,
    overview: { file: overviewName, bytes: written.overview },
    langs: {
      file: langsName,
      entries: langs.length,
      items: new Set(langs.map((entry) => entry.qid)).size,
      bytes: langsBytes.length,
    },
    buckets,
    stats,
    seconds: (now() - started) / 1000,
  };
  const manifestName = `manifest-${version}.json`;
  fs.writeFileSync(
    path.join(dir, manifestName),
    `${JSON.stringify(manifest)}\n`,
  );
  const pointer = path.join(dir, 'current.json');
  fs.writeFileSync(
    `${pointer}.tmp`,
    `${JSON.stringify({ manifest: manifestName })}\n`,
  );
  fs.renameSync(`${pointer}.tmp`, pointer);
  const keep = new Set(Object.values(buckets).map((b) => b.file));
  for (const name of fs.readdirSync(path.join(dir, 'buckets')))
    if (!keep.has(name))
      try {
        fs.rmSync(path.join(dir, 'buckets', name));
      } catch {
        /* still open by a server: the next build removes it */
      }
  for (const name of fs.readdirSync(dir))
    if (
      (/^manifest-[0-9a-f]{12}\.json$/.test(name) && name !== manifestName) ||
      (/^overview\.[0-9a-f]{8}\.bin$/.test(name) && name !== overviewName) ||
      (/^langs\.[0-9a-f]{8}\.bin$/.test(name) && name !== langsName)
    )
      try {
        fs.rmSync(path.join(dir, name));
      } catch {
        /* still open */
      }
  log(
    `points ${version}: ${manifest.points.toLocaleString('en-US')} articles${secondary ? ` and ${secondary.toLocaleString('en-US')} secondary coordinates` : ''}, ${(bytes / 1_048_576).toFixed(1)} MB in ${Object.keys(buckets).length} buckets`,
  );
  return manifest;
}

/** What wikipedia:status says about the points. */
export function pointsStatusOf(dir) {
  try {
    const { manifest: name } = JSON.parse(
      fs.readFileSync(path.join(dir, 'current.json'), 'utf8'),
    );
    const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    return {
      built: true,
      format: m.format,
      version: m.version,
      builtAt: m.builtAt,
      dump: m.dump,
      wikis: m.wikis,
      langs: m.langs || null,
      points: m.points,
      secondary: m.secondary,
      bytes: m.bytes,
      buckets: Object.keys(m.buckets).length,
      stats: m.stats,
      seconds: m.seconds,
    };
  } catch {
    return { built: false };
  }
}
