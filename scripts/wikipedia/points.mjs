import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDumpStream } from './dump.mjs';
import {
  FLAG_SECONDARY,
  OVERVIEW_MAX_ZOOM,
  POINTS_BUCKET_ZOOM,
  blockKey,
  encodeBlock,
  rankWeight,
  tileAt,
  unitX,
  unitY,
  writeBlocksFile,
} from '../../server/providers/wikipediaCoverage/pointsFile.js';
import { checkpointDir, listCheckpoints } from './checkpoints.mjs';
import {
  Column,
  Interned,
  TextPool,
  WikiCoordinates,
  stableSortByKey,
} from './pointStore.mjs';
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
 *    (raw/<wiki>/, wikiFiles). Each wiki is folded into one union as soon
 *    as it is read (createPointsUnion), one dot an item: enwiki's article,
 *    else the first listed wiki's; each record carries the mask of the
 *    wikis with an article on its item, and a langs file their pages and
 *    sizes. Then the wiki's coordinates go, before the next is read.
 * 5. Ranked (primary first, then the type class, article bytes and
 *    languages, dim) and thinned per tile below z 12 (pointsFile.js),
 *    written under points/ bucket by bucket (writeUnionFiles).
 *
 * Memory: coordinates and records are columns of typed arrays and titles
 * bytes in one pool (pointStore.mjs), so eleven wikis fit Node's default
 * heap; nothing the dump parser hands out is kept as it came (a kept
 * slice keeps the dump text it was cut from).
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
 * The geo_tags dump's Earth coordinates, as a WikiCoordinates
 * (pointStore.mjs): page by page, the primary first, with GeoData's type
 * and dim.
 * @param {AsyncIterable<string|Uint8Array>} chunks
 * @param {{secondary?: boolean}} [options]
 * @returns {Promise<{coordinates: WikiCoordinates, stats: object}>}
 */
export async function collectGeoPoints(chunks, { secondary = false } = {}) {
  const coordinates = new WikiCoordinates();
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
      // One primary coordinate an article: a second is GeoData's duplicate.
      if (isPrimary && coordinates.hasPrimary(page))
        return void (stats.skipped += 1);
      const dim = fields.dim >= 0 ? Number(values[fields.dim]) : NaN;
      coordinates.add(page, {
        x: unitX(lon),
        y: unitY(lat),
        dim: Number.isFinite(dim) && dim > 0 ? dim : 0,
        type: fields.type >= 0 ? values[fields.type] || '' : '',
        flags: isPrimary ? 0 : FLAG_SECONDARY,
        primary: isPrimary,
      });
      if (isPrimary) stats.primary += 1;
      else stats.secondary += 1;
    },
  });
  return { coordinates, stats };
}

/**
 * The page table's row handler for the points: an article's title and
 * size, for the pages geo_tags named (namespace 0, not redirects), kept on
 * the coordinates. Returns {onRow(values, fields), stats}; `fields` the
 * page table's column indexes (id, namespace, title, redirect, len).
 */
export function pageRowsForPoints(coordinates) {
  const stats = { matched: 0, notArticle: 0, redirects: 0 };
  return {
    stats,
    onRow(values, fields) {
      const page = Number(values[fields.id]);
      if (!coordinates.heads.has(page)) return;
      if (fields.namespace >= 0 && Number(values[fields.namespace]) !== 0)
        return void (stats.notArticle += 1);
      if (fields.redirect >= 0 && Number(values[fields.redirect]) === 1)
        return void (stats.redirects += 1);
      const title = String(values[fields.title] ?? '').replace(/_/g, ' ');
      if (!title) return;
      const bytes = Number(values[fields.len]);
      coordinates.setArticle(
        page,
        title,
        Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
      );
      stats.matched += 1;
    },
  };
}

/** The page_props dump's Wikidata items, kept on the coordinates (item number, 0 for none). */
export async function collectWikidataItems(chunks, coordinates) {
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
      if (!coordinates.heads.has(page)) return;
      const match = /^Q(\d{1,10})$/.exec(String(values[fields.value] || ''));
      if (!match) return;
      coordinates.setItem(page, Number(match[1]));
      stats.matched += 1;
    },
  });
  return { stats };
}

/**
 * The index's points, one wiki at a time: one dot an item. add(wiki,
 * coordinates) joins a wiki's three dumps (articles only, each coordinate
 * a record with the article's title, size, item and type class) and folds
 * them in, so a wiki's coordinates can go before the next is read. enwiki
 * must come first when it is there: its record is the one kept for an
 * item it has (its title, type, class and bytes), else the first added
 * wiki's. Another wiki's article on a kept item adds no dot, only its bit
 * in the kept records' `wikis` mask and a langs entry (its page and
 * bytes), so the card can open every language. An article without an item
 * stays its wiki's own dot. Records are columns (`at(i)` an object of the
 * fields pointsFile.js writes); finish() sets each item's records' mask
 * and returns the langs, sorted by item, then wiki.
 */
export function createPointsUnion() {
  const columns = {
    x: new Column(Uint32Array),
    y: new Column(Uint32Array),
    page: new Column(Uint32Array),
    qid: new Column(Float64Array),
    bytes: new Column(Float64Array),
    dim: new Column(Float64Array),
    cls: new Column(Uint8Array),
    flags: new Column(Uint8Array),
    wiki: new Column(Uint8Array),
    wikis: new Column(Uint32Array),
    title: new Column(Uint32Array),
    type: new Column(Uint16Array),
    // At an article's first record: how many it has (its coordinates).
    run: new Column(Uint32Array),
  };
  const titles = new TextPool();
  const types = new Interned();
  // Item → its kept article's first record.
  const items = new Map();
  const langs = {
    qid: new Column(Float64Array),
    wiki: new Column(Uint8Array),
    page: new Column(Uint32Array),
    bytes: new Column(Float64Array),
  };
  const addLang = (qid, wiki, page, bytes) => {
    langs.qid.push(qid);
    langs.wiki.push(wiki);
    langs.page.push(page);
    langs.bytes.push(bytes);
  };
  const byWiki = {};
  let finished = null;

  return {
    columns,
    byWiki,
    get count() {
      return columns.x.length;
    },
    /**
     * Fold a wiki's articles in (WikiArticles: read from its dumps, or a
     * checkpoint's); returns its records by type class.
     */
    add(wiki, articles) {
      if (finished) throw new Error('The points union is finished');
      if (wiki.key === 'enwiki' && columns.x.length)
        throw new Error('enwiki must be the first wiki added');
      const bit = wikiBit(wiki.code);
      const stats = (byWiki[wiki.key] = {
        articles: 0,
        kept: 0,
        onAnItemKept: 0,
        withoutItem: 0,
      });
      const byClass = {};
      const a = articles;
      const coordinateType = (at) => a.types[a.type.array[at]];
      for (let i = 0; i < a.articles; i++) {
        const page = a.page.array[i];
        const title = a.titles.get(i);
        const bytes = a.bytes.array[i];
        const qid = a.qid.array[i];
        const first = a.first.array[i];
        const end = first + a.count.array[i];
        stats.articles += 1;
        // Every coordinate of an article, by class (as the record would be).
        const classes = [];
        for (let at = first; at < end; at++) {
          const cls = pointClassOf(coordinateType(at), title);
          byClass[cls.key] = (byClass[cls.key] || 0) + 1;
          classes.push(cls.code);
        }
        let start = qid ? items.get(qid) : undefined;
        if (start !== undefined) {
          // A second page of this wiki on one item adds nothing.
          if (columns.wikis.array[start] & bit) continue;
          stats.onAnItemKept += 1;
          // The first other wiki on the item: the kept article's entry too.
          if (columns.wikis.array[start] === wikiBit(columns.wiki.array[start]))
            addLang(
              qid,
              columns.wiki.array[start],
              columns.page.array[start],
              columns.bytes.array[start],
            );
          addLang(qid, wiki.code, page, bytes);
          columns.wikis.array[start] |= bit;
          continue;
        }
        if (qid) items.set(qid, columns.x.length);
        else stats.withoutItem += 1;
        stats.kept += 1;
        start = columns.x.length;
        const titleKept = titles.add(title);
        for (let at = first; at < end; at++) {
          columns.x.push(a.x.array[at]);
          columns.y.push(a.y.array[at]);
          columns.page.push(page);
          columns.qid.push(qid);
          columns.bytes.push(bytes);
          columns.dim.push(a.dim.array[at]);
          columns.cls.push(classes[at - first]);
          columns.flags.push(a.flags.array[at]);
          columns.wiki.push(wiki.code);
          columns.wikis.push(bit);
          columns.title.push(titleKept);
          columns.type.push(types.id(coordinateType(at)));
          columns.run.push(0);
        }
        columns.run.array[start] = end - first;
      }
      return byClass;
    },
    /**
     * One record as it is (an index written from records already made,
     * as the route's tests do): its fields as pointsFile.js reads them,
     * its `wikis` its own wiki's when not given; no item bookkeeping.
     */
    addRecord(record) {
      if (finished) throw new Error('The points union is finished');
      const wiki = record.wiki || 1;
      columns.x.push(record.x);
      columns.y.push(record.y);
      columns.page.push(record.page);
      columns.qid.push(record.qid || 0);
      columns.bytes.push(record.bytes || 0);
      columns.dim.push(record.dim || 0);
      columns.cls.push(record.cls);
      columns.flags.push(record.flags || 0);
      columns.wiki.push(wiki);
      columns.wikis.push(record.wikis || wikiBit(wiki));
      columns.title.push(titles.add(record.title || ''));
      columns.type.push(types.id(record.type || ''));
      columns.run.push(1);
    },
    /**
     * Every item's records take its mask; the langs (each item more than
     * one wiki has, every wiki's page and bytes) in order of item, then
     * wiki: {count, qid, wiki, page, bytes} columns.
     */
    finish() {
      if (finished) return finished;
      for (const start of items.values()) {
        const mask = columns.wikis.array[start];
        const end = start + columns.run.array[start];
        for (let at = start + 1; at < end; at++) columns.wikis.array[at] = mask;
      }
      items.clear();
      const qid = langs.qid.view();
      const wiki = langs.wiki.view();
      const order = new Uint32Array(qid.length);
      for (let i = 0; i < order.length; i++) order[i] = i;
      order.sort((a, b) => qid[a] - qid[b] || wiki[a] - wiki[b]);
      const take = (column, Type) => {
        const out = new Type(order.length);
        for (let i = 0; i < order.length; i++) out[i] = column[order[i]];
        return out;
      };
      finished = {
        count: order.length,
        qid: take(qid, Float64Array),
        wiki: take(wiki, Uint8Array),
        page: take(langs.page.view(), Uint32Array),
        bytes: take(langs.bytes.view(), Float64Array),
      };
      for (const column of Object.values(langs)) column.array = null;
      return finished;
    },
    /** Record i as the object pointsFile.js encodes. */
    at(i) {
      return {
        x: columns.x.array[i],
        y: columns.y.array[i],
        page: columns.page.array[i],
        qid: columns.qid.array[i],
        bytes: columns.bytes.array[i],
        dim: columns.dim.array[i],
        cls: columns.cls.array[i],
        flags: columns.flags.array[i],
        wiki: columns.wiki.array[i],
        wikis: columns.wikis.array[i],
        title: titles.get(columns.title.array[i]),
        type: types.get(columns.type.array[i]),
      };
    },
  };
}

/** A langs file's entry: Uint32 item, Uint32 page, Uint32 bytes, Uint8 wiki, three unused. */
export const LANG_BYTES = 16;

/** The langs file's bytes from the union's finished langs (sorted by item, then wiki). */
export function encodeLangs(langs) {
  const out = Buffer.alloc(langs.count * LANG_BYTES);
  for (let i = 0; i < langs.count; i++) {
    const at = i * LANG_BYTES;
    out.writeUInt32LE(langs.qid[i] >>> 0, at);
    out.writeUInt32LE(langs.page[i] >>> 0, at + 4);
    out.writeUInt32LE(Math.min(4294967295, langs.bytes[i] || 0), at + 8);
    out.writeUInt8(langs.wiki[i], at + 12);
  }
  return out;
}

/**
 * The union's records in rank order (pointsFile.js rankCompare, the same
 * order its thinPoints sorts objects into): a Uint32Array of indexes.
 */
export function rankedRecords(union) {
  const { columns } = union;
  const n = union.count;
  const flags = columns.flags.array;
  const cls = columns.cls.array;
  const dim = columns.dim.array;
  const page = columns.page.array;
  const x = columns.x.array;
  const y = columns.y.array;
  const weight = new Float64Array(n);
  const scratch = { bytes: 0, wikis: 0 };
  for (let i = 0; i < n; i++) {
    scratch.bytes = columns.bytes.array[i];
    scratch.wikis = columns.wikis.array[i];
    weight[i] = rankWeight(scratch);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  return order.sort(
    (a, b) =>
      (flags[a] & FLAG_SECONDARY) - (flags[b] & FLAG_SECONDARY) ||
      cls[a] - cls[b] ||
      weight[b] - weight[a] ||
      dim[b] - dim[a] ||
      page[a] - page[b] ||
      x[a] - x[b] ||
      y[a] - y[b],
  );
}

/**
 * thinPoints' blocks for the zooms `from`–`to`, over `ranked` (record
 * indexes, best first): [{zoom, key, list}] (key: the block's key in its
 * file) in its order (zoom, then the tile's first record), a tile below
 * the full zoom keeping its best `perTile`.
 */
export function thinRanked(
  union,
  ranked,
  {
    from,
    to,
    fullZoom = WIKIPEDIA_POINTS_FULL_ZOOM,
    perTile = WIKIPEDIA_POINTS_PER_TILE,
  },
) {
  const x = union.columns.x.array;
  const y = union.columns.y.array;
  const blocks = [];
  for (let zoom = from; zoom <= to; zoom++) {
    const tiles = new Map();
    const cap = zoom === fullZoom ? Infinity : perTile;
    for (let i = 0; i < ranked.length; i++) {
      const index = ranked[i];
      const [tx, ty] = tileAt(x[index], y[index], zoom);
      const key = ty * 2 ** zoom + tx;
      let block = tiles.get(key);
      if (!block) {
        block = { zoom, key: blockKey(tx, ty, zoom), list: [] };
        tiles.set(key, block);
        blocks.push(block);
      }
      if (block.list.length < cap) block.list.push(index);
    }
  }
  return blocks;
}

/**
 * The index's files from the union, as writePointsFiles writes them from
 * thinPoints' levels (same blocks, same order, same bytes) without a
 * second copy of the records: the overview (zooms 0–6) from the ranked
 * records, then each bucket (a z 6 tile; zooms 7–12) from its own records
 * alone, its records made objects only while its blocks are encoded.
 */
export function writeUnionFiles(
  union,
  { overviewFile, fileOf, fullZoom = WIKIPEDIA_POINTS_FULL_ZOOM },
) {
  const ranked = rankedRecords(union);
  const encode = (list) => encodeBlock(list.map((index) => union.at(index)));
  const overview = writeBlocksFile(
    overviewFile,
    thinRanked(union, ranked, { from: 0, to: OVERVIEW_MAX_ZOOM, fullZoom }),
    encode,
  );
  // Each record's bucket; the buckets in order of their best record (as
  // writePointsFiles meets them), each bucket's records in rank order.
  const x = union.columns.x.array;
  const y = union.columns.y.array;
  const bucketOf = (index) => {
    const [tx, ty] = tileAt(x[index], y[index], POINTS_BUCKET_ZOOM);
    return ty * 2 ** POINTS_BUCKET_ZOOM + tx;
  };
  const range = 4 ** POINTS_BUCKET_ZOOM;
  const byBucket = stableSortByKey(ranked, bucketOf, range);
  const starts = new Uint32Array(range + 1);
  for (let i = 0; i < byBucket.length; i++) starts[bucketOf(byBucket[i]) + 1]++;
  for (let b = 0; b < range; b++) starts[b + 1] += starts[b];
  const seen = new Uint8Array(range);
  const order = [];
  for (let i = 0; i < ranked.length; i++) {
    const bucket = bucketOf(ranked[i]);
    if (!seen[bucket]) {
      seen[bucket] = 1;
      order.push(bucket);
    }
  }
  const buckets = new Map();
  for (const bucket of order) {
    const records = byBucket.subarray(starts[bucket], starts[bucket + 1]);
    const blocks = thinRanked(union, records, {
      from: OVERVIEW_MAX_ZOOM + 1,
      to: fullZoom,
      fullZoom,
    });
    const points = blocks
      .filter((block) => block.zoom === fullZoom)
      .reduce((sum, block) => sum + block.list.length, 0);
    buckets.set(bucket, {
      bytes: writeBlocksFile(fileOf(bucket), blocks, encode),
      points,
    });
  }
  return { overview, buckets };
}

/** Write a file and sync it to disk (a crash leaves it whole or absent once renamed). */
function writeDurable(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write the points index under `dir` (the build's points/) from a points
 * union (createPointsUnion, finished here), or from `points` already made
 * as records: files, a manifest and current.json naming it; the earlier
 * build's files go.
 */
export function writePointsIndex({
  union: given = null,
  points = [],
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
  const union = given || createPointsUnion();
  if (!given) for (const record of points) union.addRecord(record);
  const langs = union.finish();
  const overviewName = `overview.${stamp}.bin`;
  const langsName = `langs.${stamp}.bin`;
  const langsBytes = encodeLangs(langs);
  writeDurable(path.join(dir, langsName), langsBytes);
  const written = writeUnionFiles(union, {
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
  let secondary = 0;
  const flags = union.columns.flags.view();
  for (let i = 0; i < flags.length; i++)
    if (flags[i] & FLAG_SECONDARY) secondary += 1;
  let items = 0;
  for (let i = 0; i < langs.count; i++)
    if (i === 0 || langs.qid[i] !== langs.qid[i - 1]) items += 1;
  const manifest = {
    format: POINTS_FORMAT,
    version,
    builtAt: new Date(now()).toISOString(),
    dump,
    wikis: wikis.map((wiki) => wiki.key),
    points: union.count - secondary,
    secondary,
    fullZoom: WIKIPEDIA_POINTS_FULL_ZOOM,
    perTile: WIKIPEDIA_POINTS_PER_TILE,
    bytes,
    overview: { file: overviewName, bytes: written.overview },
    langs: {
      file: langsName,
      entries: langs.count,
      items,
      bytes: langsBytes.length,
    },
    buckets,
    stats,
    seconds: (now() - started) / 1000,
  };
  const manifestName = `manifest-${version}.json`;
  writeDurable(path.join(dir, manifestName), `${JSON.stringify(manifest)}\n`);
  // The switch: every file above is whole on disk; current.json moves to
  // the new manifest in one rename. A build stopped before this leaves the
  // earlier index current and whole (its files go only after the switch);
  // the next build clears what this one left half-written.
  const pointer = path.join(dir, 'current.json');
  writeDurable(
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
      (/^langs\.[0-9a-f]{8}\.bin$/.test(name) && name !== langsName) ||
      // A file a stopped build left half-written (bucketWriter's temporary).
      /\.bin\.\d+\.tmp$/.test(name)
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

/** What wikipedia:status says about the points, and the wikis checkpointed for the next build. */
export function pointsStatusOf(dir) {
  const checkpoints = listCheckpoints(checkpointDir(dir));
  return { ...builtStatusOf(dir), checkpoints };
}

function builtStatusOf(dir) {
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
