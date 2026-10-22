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
 *    each article's Wikidata item (`wikibase_item`), the key a later build
 *    of other wikis unions by, so an article is never counted twice.
 * 4. Ranked (primary first, then the type class, article bytes, dim) and
 *    thinned per tile below z 12 (pointsFile.js), written under points/.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const PAGE_PROPS_FILE = 'enwiki-latest-page_props.sql.gz';
/** 2: ranked by article bytes before dim, list and period titles as other. */
export const POINTS_FORMAT = 2;

/** The wikis a build reads (`--wikis`): only enwiki is built today. */
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
        `--wikis ${name}: only enwiki is built so far (docs/PERSONAL-FORK.md, Wikipedia: more languages)`,
      );
    if (!wikis.includes(wiki)) wikis.push(wiki);
  }
  return wikis;
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
        title: article.title,
        type: c.type,
      });
    }
  }
  return { points, byClass };
}

/**
 * Write the points index under `dir` (the build's points/): files, a
 * manifest and current.json naming it; the earlier build's files go.
 */
export function writePointsIndex({
  points,
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
      (/^overview\.[0-9a-f]{8}\.bin$/.test(name) && name !== overviewName)
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
