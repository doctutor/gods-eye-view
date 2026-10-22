// Personal fork: the Wikipedia points step (scripts/wikipedia/points.mjs):
// the three dumps' joins, the ranking, the thinning per tile, the index and
// its answers, and the whole build on dumps made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  collectGeoPoints,
  collectWikidataItems,
  joinPoints,
  pageRowsForPoints,
  parseWikis,
  pointsStatusOf,
  writePointsIndex,
} from '../../scripts/wikipedia/points.mjs';
import { addPageSizes, runBuild } from '../../scripts/wikipedia/build.mjs';
import {
  FLAG_SECONDARY,
  rankCompare,
  thinPoints,
  unitX,
  unitY,
} from '../../server/providers/wikipediaCoverage/pointsFile.js';
import { createPointsIndex } from '../../server/providers/wikipediaCoverage/pointsIndex.js';
import {
  NOT_A_PLACE_TITLE,
  pointClassOf,
  pointClassOfType,
  pointZoomForHeight,
} from '../../src/data/wikipediaPoints.js';

/** A dump's text: its CREATE TABLE and one INSERT of the rows. */
function sql(table, columns, rows) {
  const quote = (v) =>
    v === null
      ? 'NULL'
      : typeof v === 'number'
        ? String(v)
        : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return [
    `CREATE TABLE \`${table}\` (`,
    ...columns.map((c) => `  \`${c}\` varbinary(255) DEFAULT NULL,`),
    '  PRIMARY KEY (`x`)',
    ') ENGINE=InnoDB;',
    `INSERT INTO \`${table}\` VALUES ${rows.map((r) => `(${r.map(quote).join(',')})`).join(',')};`,
    '',
  ].join('\n');
}
const GEO = [
  'gt_id',
  'gt_page_id',
  'gt_globe',
  'gt_primary',
  'gt_lat',
  'gt_lon',
  'gt_dim',
  'gt_type',
];
const PAGE = [
  'page_id',
  'page_namespace',
  'page_title',
  'page_is_redirect',
  'page_len',
];
const PROPS = ['pp_page', 'pp_propname', 'pp_value', 'pp_sortkey'];

const geoText = () =>
  sql('geo_tags', GEO, [
    [1, 10, 'earth', 1, 48.8566, 2.3522, 10000, 'city'],
    [2, 10, 'earth', 0, 48.86, 2.34, 100, 'landmark'],
    [3, 11, 'earth', 1, 48.8584, 2.2945, 300, 'landmark'],
    [4, 12, 'moon', 1, 0.67, 23.47, null, null],
    [5, 13, 'earth', 1, 45.8326, 6.8652, 2000, 'mountain'],
    [6, 13, 'earth', 1, 45.0, 6.0, null, null], // a second primary: GeoData's duplicate
    [7, 14, 'earth', 1, 48.85, 2.35, null, null],
    [8, 15, 'earth', 1, 91, 2.35, null, null], // out of range
    [9, 16, 'earth', 1, 48.857, 2.352, null, 'city'], // a talk page
  ]);
const pageText = () =>
  sql('page', PAGE, [
    [10, 0, 'Paris', 0, 300000],
    [11, 0, 'Eiffel_Tower', 0, 150000],
    [13, 0, 'Mont_Blanc', 0, 90000],
    [14, 0, 'Some_Redirect', 1, 40],
    [16, 1, 'Paris', 0, 5000],
    [99, 0, 'Elsewhere', 0, 1],
  ]);
const propsText = () =>
  sql('page_props', PROPS, [
    [10, 'wikibase_item', 'Q90', null],
    [10, 'page_image_free', 'Paris.jpg', null],
    [11, 'wikibase_item', 'Q243', null],
    [13, 'wikibase_item', 'Q583', null],
  ]);

test('the joins keep articles with their title, size and Wikidata item', async () => {
  const primary = await collectGeoPoints([geoText()]);
  assert.deepEqual([...primary.pages.keys()].sort(), [10, 11, 13, 14, 16]);
  assert.equal(
    primary.pages.get(10).length,
    1,
    'no secondary without the flag',
  );
  assert.equal(primary.pages.get(13).length, 1, 'one primary an article');
  const geo = await collectGeoPoints([geoText()], { secondary: true });
  assert.equal(geo.pages.get(10).length, 2);
  assert.equal(geo.pages.get(10)[1].flags, FLAG_SECONDARY);
  assert.deepEqual(geo.stats, {
    rows: 9,
    primary: 5,
    secondary: 1,
    skipped: 3,
  });

  const page = pageRowsForPoints(geo.pages);
  await addPageSizes([pageText()], { onRow: page.onRow });
  assert.deepEqual(page.articles.get(11), {
    title: 'Eiffel Tower',
    bytes: 150000,
  });
  assert.equal(page.articles.has(14), false, 'a redirect');
  assert.equal(page.articles.has(16), false, 'not an article');
  assert.equal(page.articles.has(99), false, 'not geotagged');

  const { items, stats } = await collectWikidataItems([propsText()], geo.pages);
  assert.deepEqual(
    [...items],
    [
      [10, 90],
      [11, 243],
      [13, 583],
    ],
  );
  assert.equal(stats.rows, 4);

  const { points, byClass } = joinPoints({
    pages: geo.pages,
    articles: page.articles,
    items,
  });
  assert.equal(points.length, 4);
  assert.deepEqual(byClass, { place: 1, landmark: 2, nature: 1 });
  const paris = points.find((p) => p.page === 10 && !p.flags);
  assert.equal(paris.qid, 90);
  assert.equal(paris.title, 'Paris');
  assert.equal(paris.cls, pointClassOfType('city').code);
});

test('ranking: primary, then type class, dim, article size; thinning keeps the best per tile', () => {
  const at = (lat, lon) => ({ x: unitX(lon), y: unitY(lat) });
  const points = [
    { ...at(10, 10), page: 1, cls: 4, dim: 0, bytes: 900 },
    { ...at(10.001, 10), page: 2, cls: 1, dim: 50, bytes: 10 },
    { ...at(10.002, 10), page: 3, cls: 1, dim: 5000, bytes: 10 },
    { ...at(10.003, 10), page: 4, cls: 1, dim: 5000, bytes: 20 },
    {
      ...at(10.004, 10),
      page: 5,
      cls: 1,
      dim: 9e6,
      bytes: 1,
      flags: FLAG_SECONDARY,
    },
    { ...at(-30, 100), page: 6, cls: 3, dim: 0, bytes: 1 },
  ];
  assert.deepEqual(
    [...points].sort(rankCompare).map((p) => p.page),
    [4, 3, 2, 6, 1, 5],
  );
  const levels = thinPoints(points, { fullZoom: 12, perTile: 2 });
  // The world tile keeps the two best; z 12 keeps every one.
  assert.deepEqual(
    levels
      .get(0)
      .get(0)
      .map((p) => p.page),
    [4, 3],
  );
  const full = [...levels.get(12).values()]
    .flat()
    .map((p) => p.page)
    .sort();
  assert.deepEqual(full, [1, 2, 3, 4, 5, 6]);
  // At z 4 the two places are apart: each tile its own best two.
  assert.equal(levels.get(4).size, 2);
});

test('the index answers a sparse splatter from afar and every article close in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-points-'));
  try {
    const points = [];
    // 60 articles around Paris, ranked by size; one secondary coordinate.
    for (let i = 0; i < 60; i++)
      points.push({
        x: unitX(2.35 + (i % 10) * 0.001),
        y: unitY(48.85 + Math.floor(i / 10) * 0.001),
        page: 100 + i,
        qid: 1000 + i,
        bytes: 1000 * (i + 1),
        dim: 0,
        cls: 4,
        flags: 0,
        wiki: 1,
        title: `Article ${i}`,
        type: '',
      });
    points.push({
      ...points[0],
      page: 999,
      flags: FLAG_SECONDARY,
      title: 'Second place',
    });
    // One across the antimeridian.
    points.push({
      ...points[0],
      x: unitX(179.9),
      y: unitY(-17),
      page: 5,
      title: 'Fiji',
    });
    const manifest = writePointsIndex({
      points,
      dir,
      dump: {
        date: '2026-10-08',
        lastModified: 'Thu, 08 Oct 2026 03:30:29 GMT',
      },
    });
    assert.equal(manifest.points, 61);
    assert.equal(manifest.secondary, 1);
    const index = createPointsIndex({ dir });
    assert.equal(index.status().points, 61);
    const box = { west: 2.3, south: 48.8, east: 2.4, north: 48.9 };
    const far = index.points({ ...box, zoom: 3 });
    assert.equal(far.body.count, 24, 'a tile’s best 24');
    assert.equal(far.body.points[0].title, 'Article 59', 'the largest first');
    const near = index.points({ ...box, zoom: 14 });
    assert.equal(near.body.count, 60);
    assert.equal(near.body.zoom, 12);
    const withSecondary = index.points({ ...box, zoom: 14, secondary: true });
    assert.equal(withSecondary.body.count, 61);
    assert.equal(withSecondary.body.points.at(-1).secondary, true);
    const capped = index.points({ ...box, zoom: 14, limit: 5 });
    assert.equal(capped.body.saturated, true);
    assert.equal(capped.body.points.length, 5);
    const first = near.body.points[0];
    assert.equal(first.qid, 'Q1059');
    assert.ok(Math.abs(first.at[0] - (2.35 + 9 * 0.001)) < 1e-5);
    const fiji = index.points({
      west: 179,
      south: -18,
      east: -179,
      north: -16,
      zoom: 8,
    });
    assert.deepEqual(
      fiji.body.points.map((p) => p.title),
      ['Fiji'],
    );
    index.close();
    assert.equal(pointsStatusOf(dir).built, true);
    assert.equal(pointsStatusOf(path.join(dir, 'none')).built, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only enwiki is built so far, and the zoom follows the camera height', () => {
  assert.deepEqual(
    parseWikis('enwiki').map((w) => w.key),
    ['enwiki'],
  );
  assert.throws(() => parseWikis('enwiki,dewiki'), /only enwiki/);
  assert.equal(pointZoomForHeight(1e4), 12);
  assert.equal(pointZoomForHeight(2e7), 1);
  assert.equal(pointZoomForHeight(NaN), 1);
});

test('a build with --points writes the index from the three dumps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-build-'));
  try {
    const gz = (text) => zlib.gzipSync(Buffer.from(text));
    const bodies = {
      'enwiki-latest-geo_tags.sql.gz': gz(geoText()),
      'enwiki-latest-page.sql.gz': gz(pageText()),
      'enwiki-latest-page_props.sql.gz': gz(propsText()),
    };
    const asked = [];
    const fetchImpl = async (url) => {
      const name = url.split('/').pop();
      asked.push(name);
      return new Response(bodies[name], {
        headers: {
          'content-length': String(bodies[name].length),
          'last-modified': 'Thu, 08 Oct 2026 03:30:29 GMT',
          etag: `"${name}"`,
        },
      });
    };
    const result = await runBuild({
      dir,
      points: true,
      secondary: true,
      fetchImpl,
      sleepImpl: async () => {},
    });
    assert.deepEqual(asked, [
      'enwiki-latest-geo_tags.sql.gz',
      'enwiki-latest-page.sql.gz',
      'enwiki-latest-page_props.sql.gz',
    ]);
    assert.equal(result.points.points, 3);
    assert.equal(result.points.secondary, 1);
    assert.equal(result.points.dump.date, '2026-10-08');
    assert.deepEqual(result.points.stats.wikidata, { rows: 4, matched: 3 });
    const index = createPointsIndex({ dir: path.join(dir, 'points') });
    const answer = index.points({
      west: 2,
      south: 48,
      east: 7,
      north: 46.5 + 3,
      zoom: 14,
    });
    assert.deepEqual(answer.body.points.map((p) => p.title).sort(), [
      'Eiffel Tower',
      'Paris',
    ]);
    index.close();
    // The page_props dump is kept beside geo_tags; the page table is not.
    assert.ok(fs.existsSync(path.join(dir, 'enwiki-latest-page_props.sql.gz')));
    assert.equal(
      fs.existsSync(path.join(dir, 'enwiki-latest-page.sql.gz')),
      false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('offline, with the page table on disk, the points build asks nothing of the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-offline-'));
  try {
    const gz = (text) => zlib.gzipSync(Buffer.from(text));
    fs.writeFileSync(
      path.join(dir, 'enwiki-latest-geo_tags.sql.gz'),
      gz(geoText()),
    );
    fs.writeFileSync(
      path.join(dir, 'geo_tags.meta.json'),
      JSON.stringify({
        lastModified: 'Thu, 08 Oct 2026 03:30:29 GMT',
        etag: '"g"',
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'enwiki-latest-page_props.sql.gz'),
      gz(propsText()),
    );
    fs.writeFileSync(
      path.join(dir, 'page_props.meta.json'),
      JSON.stringify({ lastModified: 'Thu, 08 Oct 2026 03:28:48 GMT' }),
    );
    const pageDir = path.join(dir, 'elsewhere');
    fs.mkdirSync(pageDir);
    const pageFile = path.join(pageDir, 'enwiki-latest-page.sql.gz');
    fs.writeFileSync(pageFile, gz(pageText()));
    fs.writeFileSync(
      path.join(pageDir, 'page.meta.json'),
      JSON.stringify({ lastModified: 'Thu, 08 Oct 2026 03:27:22 GMT' }),
    );
    const result = await runBuild({
      dir,
      points: true,
      offline: true,
      pageFile,
      fetchImpl: () => assert.fail('nothing is fetched offline'),
      sleepImpl: async () => {},
    });
    assert.equal(result.points.points, 3);
    assert.equal(result.points.dump.pageProps, 'Thu, 08 Oct 2026 03:28:48 GMT');
    // Offline without the page table on disk: refused.
    await assert.rejects(
      runBuild({
        dir,
        points: true,
        offline: true,
        force: true,
        sleepImpl: async () => {},
      }),
      /--page-file/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list, history, period and event titles are not places, whatever GeoData types them', () => {
  for (const title of [
    'List of highest U.S. county high points',
    'Lists of rivers',
    'History of Île-de-France',
    'Timeline of Paris',
    'Outline of France',
    'Index of Belize-related articles',
    'Geography of Belize',
    'Battle of Hastings',
    'Siege of Paris',
    'Treaty of Versailles',
    'Preclassic period',
    'Heian era',
    'Ming dynasty',
    'Second French Empire',
    'French Third Republic',
    'Gallipoli campaign',
    'Tet Offensive',
    'Taiping Rebellion',
    'Warsaw Uprising',
    'Velvet Revolution',
  ])
    assert.equal(pointClassOf('country', title).key, 'other', title);
  for (const title of [
    'Paris',
    'Czech Republic',
    'Dominican Republic',
    'Central African Republic',
    'Republic of Ireland',
    'Empire State Building',
    'Revolution Square',
  ])
    assert.equal(pointClassOf('city', title).key, 'place', title);
  assert.ok(NOT_A_PLACE_TITLE instanceof RegExp);
});

test('within a class the larger article ranks first, the object size breaks ties', () => {
  const big = { page: 1, cls: 1, bytes: 90_000, dim: 10, x: 0, y: 0 };
  const vast = { page: 2, cls: 1, bytes: 5_000, dim: 2_000_000, x: 0, y: 0 };
  const twin = { page: 3, cls: 1, bytes: 5_000, dim: 3_000_000, x: 0, y: 0 };
  assert.deepEqual(
    [vast, big, twin].sort(rankCompare).map((p) => p.page),
    [1, 3, 2],
  );
});

test('--points-only rebuilds the points and leaves the grid and hexagons as they are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-points-only-'));
  try {
    const gz = (text) => zlib.gzipSync(Buffer.from(text));
    fs.writeFileSync(
      path.join(dir, 'enwiki-latest-geo_tags.sql.gz'),
      gz(geoText()),
    );
    fs.writeFileSync(
      path.join(dir, 'geo_tags.meta.json'),
      JSON.stringify({ lastModified: 'Thu, 08 Oct 2026 03:30:29 GMT' }),
    );
    fs.writeFileSync(
      path.join(dir, 'enwiki-latest-page_props.sql.gz'),
      gz(propsText()),
    );
    const pageFile = path.join(dir, 'page.sql.gz');
    fs.writeFileSync(pageFile, gz(pageText()));
    fs.writeFileSync(path.join(dir, 'grid.bin'), 'the grid as it was');
    const result = await runBuild({
      dir,
      points: true,
      pointsOnly: true,
      text: true,
      offline: true,
      pageFile,
      sleepImpl: async () => {},
    });
    assert.equal(result.pointsOnly, true);
    assert.equal(result.points.points, 3);
    assert.equal(result.points.format, 2);
    assert.equal(
      fs.readFileSync(path.join(dir, 'grid.bin'), 'utf8'),
      'the grid as it was',
    );
    assert.equal(fs.existsSync(path.join(dir, 'h3.bin')), false);
    assert.equal(pointsStatusOf(path.join(dir, 'points')).format, 2);
    await assert.rejects(
      runBuild({
        dir,
        pointsOnly: true,
        offline: true,
        pageFile,
        sleepImpl: async () => {},
      }),
      /--points-only needs --points/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
