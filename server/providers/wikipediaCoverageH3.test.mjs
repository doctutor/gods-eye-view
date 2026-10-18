// Personal fork: the Wikipedia coverage layer's H3 hexagon tables and route
// (server/providers/wikipediaCoverage/h3.js, server/providers/wikipediaCoverage.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as h3 from 'h3-js';

import {
  H3_BASE_RES,
  RESOLUTIONS,
  buildResolutions,
  cellKey,
  createH3Accumulator,
  keyToIndex,
  lonInside,
  openH3File,
  parseBbox,
  queryCells,
  tableDomains,
  writeH3File,
} from './wikipediaCoverage/h3.js';
import {
  H3_MAX_CELLS,
  NEEDS_H3,
  createWikipediaCoverageHandler,
  createWikipediaCoverageService,
} from './wikipediaCoverage.js';
import {
  addPageSizes,
  binGeoTags,
  runBuild,
  writeCoverageH3,
} from '../../scripts/wikipedia/build.mjs';
import { h3StatusOf, statusOf } from '../../scripts/wikipedia/index.mjs';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/wikipedia/fixtures',
);
const GEO_SQL = fs.readFileSync(
  path.join(FIXTURES, 'geo_tags-sample.sql'),
  'utf8',
);
const PAGE_SQL = fs.readFileSync(
  path.join(FIXTURES, 'page-sample.sql'),
  'utf8',
);
const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'geo_tags-sample.expected.json'), 'utf8'),
);

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-wh3-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

const gzipStream = (text) =>
  Readable.from([zlib.gzipSync(Buffer.from(text))]).pipe(zlib.createGunzip());

/** Four hand-placed articles: two in one Baltimore hexagon, Sydney, and two at the antimeridian. */
const POINTS = [
  [39.29, -76.61, 1000],
  [39.2819, -76.6075, 2000], // the centre of the same resolution-7 cell
  [-33.87, 151.21, 300],
  [0.01, 179.9, 10],
  [0.01, -179.9, 20],
];
const BALTIMORE_7 = '872aa8c76ffffff';
/**
 * The distinct cells the points fall in at a resolution, by the parent
 * chain of their resolution-7 cell, as the build counts them. H3's nesting
 * is approximate: latLngToCell at a coarse resolution can name a different
 * cell than the parent of the point's fine cell (the two Baltimore points
 * do at resolution 6), and the parent chain is what keeps every
 * resolution's totals equal.
 */
const distinct = (res) =>
  new Set(
    POINTS.map(([lat, lon]) =>
      h3.cellToParent(h3.latLngToCell(lat, lon, H3_BASE_RES), res),
    ),
  ).size;

function tablesOf(points, { text = true } = {}) {
  const hexes = createH3Accumulator({ text });
  for (const [lat, lon, bytes] of points)
    hexes.addBytes(hexes.add(lat, lon), bytes);
  return { hexes, tables: buildResolutions(hexes) };
}

const sum = (array) => {
  let total = 0;
  for (const value of array) total += value;
  return total;
};

test('a cell key is the index without its mode and resolution, and comes back as the index', () => {
  assert.equal(h3.latLngToCell(39.29, -76.61, 7), BALTIMORE_7);
  const key = cellKey(BALTIMORE_7);
  assert.ok(Number.isSafeInteger(key));
  assert.equal(keyToIndex(key, 7), BALTIMORE_7);
  for (const res of RESOLUTIONS) {
    const parent = h3.cellToParent(BALTIMORE_7, res);
    assert.equal(keyToIndex(cellKey(parent), res), parent, `resolution ${res}`);
  }
  assert.equal(keyToIndex(cellKey('802bfffffffffff'), 0), '802bfffffffffff');
  // Keys sort as the full indexes do within one resolution.
  const cells = [
    [39.29, -76.61],
    [-33.87, 151.21],
    [51.5, -0.12],
    [0.01, 179.9],
  ].map(([lat, lon]) => h3.latLngToCell(lat, lon, 7));
  const byKey = cells.slice().sort((a, b) => cellKey(a) - cellKey(b));
  const byIndex = cells
    .slice()
    .sort((a, b) => (BigInt(`0x${a}`) < BigInt(`0x${b}`) ? -1 : 1));
  assert.deepEqual(byKey, byIndex);
});

test('hexagons roll up: each resolution sums its children, hand-checked for five points', () => {
  const { hexes, tables } = tablesOf(POINTS);
  assert.equal(hexes.add(91, 0), -1);
  assert.equal(hexes.add(0, NaN), -1);
  assert.deepEqual(
    tables.map((table) => table.res),
    RESOLUTIONS,
  );
  const fine = tables[7];
  assert.equal(distinct(7), 4, 'two articles share one resolution-7 cell');
  assert.equal(fine.keys.length, 4);
  const at = (table, index) => {
    const key = cellKey(index);
    const i = table.keys.indexOf(key);
    return i < 0
      ? null
      : {
          articles: table.articles[i],
          bytes: table.bytes[i],
          area: table.area[i],
        };
  };
  assert.deepEqual(at(fine, BALTIMORE_7).articles, 2);
  assert.equal(at(fine, BALTIMORE_7).bytes, 3000);
  assert.ok(
    Math.abs(at(fine, BALTIMORE_7).area - h3.cellArea(BALTIMORE_7, 'km2')) <
      1e-3,
  );
  assert.equal(at(fine, h3.latLngToCell(-33.87, 151.21, 7)).articles, 1);
  // Every resolution keeps the total, and each parent is the sum of its children.
  for (const table of tables) {
    assert.equal(sum(table.articles), 5, `resolution ${table.res}`);
    assert.equal(sum(table.bytes), 3330, `resolution ${table.res} bytes`);
    const sorted = Array.from(table.keys);
    assert.deepEqual(
      sorted,
      sorted.slice().sort((a, b) => a - b),
      'sorted by key',
    );
  }
  for (let res = 1; res <= H3_BASE_RES; res++) {
    const child = tables[res];
    const parent = tables[res - 1];
    const sums = new Map();
    for (let i = 0; i < child.keys.length; i++) {
      const up = cellKey(
        h3.cellToParent(keyToIndex(child.keys[i], res), res - 1),
      );
      sums.set(up, (sums.get(up) || 0) + child.articles[i]);
    }
    assert.equal(
      sums.size,
      parent.keys.length,
      `resolution ${res - 1} has one cell per parent`,
    );
    for (const [key, count] of sums)
      assert.equal(parent.articles[parent.keys.indexOf(key)], count);
  }
  // Baltimore's parents, by hand (h3-js, checked 2026-10-18).
  const parents = {
    0: '802bfffffffffff',
    3: '832aa8fffffffff',
    5: '852aa8c7fffffff',
    6: '862aa8c77ffffff',
  };
  for (const [res, index] of Object.entries(parents))
    assert.equal(
      at(tables[Number(res)], index).articles,
      2,
      `resolution ${res}`,
    );
  // The antimeridian pair, 22 km apart, sit in different fine cells; their
  // base cell holds both when they share it, one each otherwise.
  const east = h3.latLngToCell(0.01, 179.9, 7);
  const west = h3.latLngToCell(0.01, -179.9, 7);
  assert.notEqual(east, west);
  const sameBase = h3.cellToParent(east, 0) === h3.cellToParent(west, 0);
  assert.equal(
    at(tables[0], h3.cellToParent(east, 0)).articles,
    sameBase ? 2 : 1,
  );
  assert.equal(tables[0].keys.length, distinct(0));
  // Domains: per-km² from cellArea, nearest-rank quantiles.
  const domains = tableDomains(fine);
  assert.equal(domains.count.cells, 4);
  assert.equal(domains.count.max, 2);
  assert.equal(domains.count.min, 1);
  assert.ok(
    Math.abs(domains.articles.max - 2 / h3.cellArea(BALTIMORE_7, 'km2')) <
      1e-6 * domains.articles.max,
    'Float32 area',
  );
  assert.ok(domains.text.max > domains.text.min);
  assert.equal(tablesOf(POINTS, { text: false }).tables[0].bytes, null);
});

test('the H3 file round-trips its tables and reads a resolution only when asked', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'h3.bin');
  const { tables } = tablesOf(POINTS);
  const { bytes, header } = writeH3File(file, {
    header: {
      builtAt: '2026-10-18T00:00:00.000Z',
      dump: { date: '2026-10-08' },
    },
    tables,
  });
  assert.equal(fs.statSync(file).size, bytes);
  assert.equal(header.resolutions.length, 8);
  assert.equal(header.resolutions[7].cells, 4);
  assert.equal(header.resolutions[0].cells, distinct(0));
  assert.ok(header.resolutions[7].domains.articles);
  const open = openH3File(file);
  assert.deepEqual(open.resolutions, RESOLUTIONS);
  assert.equal(open.hasText, true);
  assert.deepEqual(open.loaded(), []);
  const fine = open.table(7);
  assert.deepEqual(open.loaded(), [7]);
  assert.equal(fine.cells, 4);
  const i = Array.from(fine.indexLo).findIndex(
    (lo, at) => h3.splitLongToH3Index(lo, fine.indexHi[at]) === BALTIMORE_7,
  );
  assert.ok(i >= 0, 'the index halves come back as the index');
  assert.equal(fine.articles[i], 2);
  assert.equal(fine.bytes[i], 3000);
  assert.ok(Math.abs(fine.lat[i] - 39.2819) < 1e-3);
  assert.equal(open.table(7), fine, 'kept once read');
  assert.throws(() => open.table(8), RangeError);
  fs.writeFileSync(path.join(root, 'junk.bin'), 'WGRD');
  assert.throws(
    () => openH3File(path.join(root, 'junk.bin')),
    /Not a WH3G file/,
  );
});

test('cells are chosen by their centre in the box, across the antimeridian too', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'h3.bin');
  const { tables } = tablesOf(POINTS);
  writeH3File(file, { header: {}, tables });
  const open = openH3File(file);
  assert.equal(lonInside(0, -10, 10), true);
  assert.equal(lonInside(20, -10, 10), false);
  assert.equal(lonInside(179.5, 170, -170), true);
  assert.equal(lonInside(-179.5, 170, -170), true);
  assert.equal(lonInside(0, 170, -170), false);
  assert.deepEqual(
    parseBbox({ west: '-77', south: '39', east: '-76', north: '40' }),
    {
      west: -77,
      south: 39,
      east: -76,
      north: 40,
    },
  );
  assert.equal(
    parseBbox({ west: '-77', south: '40', east: '-76', north: '39' }),
    null,
  );
  assert.equal(
    parseBbox({ west: 'x', south: '39', east: '-76', north: '40' }),
    null,
  );
  assert.equal(parseBbox({ west: '-77', south: '39', east: '-76' }), null);
  assert.equal(
    parseBbox({ west: '-181', south: '39', east: '-76', north: '40' }),
    null,
  );

  const baltimore = { west: -77, south: 39, east: -76, north: 40 };
  const five = queryCells(open.table(5), 'articles', baltimore);
  assert.equal(five.cells.length, 1);
  const [index, value] = five.cells[0];
  assert.equal(index, '852aa8c7fffffff');
  assert.ok(
    Math.abs(value - 2 / h3.cellArea(index, 'km2')) < 1e-6 * value,
    'Float32 area',
  );
  assert.deepEqual(queryCells(open.table(5), 'count', baltimore).cells, [
    [index, 2],
  ]);
  assert.ok(
    Math.abs(
      queryCells(open.table(5), 'text', baltimore).cells[0][1] -
        3000 / h3.cellArea(index, 'km2'),
    ) < 1e-6,
  );
  // Across the antimeridian: the cells there (two at resolution 7), not Baltimore or Sydney.
  const dateline = queryCells(open.table(7), 'count', {
    west: 170,
    south: -5,
    east: -170,
    north: 5,
  });
  assert.equal(dateline.cells.length, 2);
  assert.deepEqual(
    dateline.cells.map(([cell]) => cell).sort(),
    [h3.latLngToCell(0.01, 179.9, 7), h3.latLngToCell(0.01, -179.9, 7)].sort(),
  );
  assert.equal(sum(dateline.cells.map(([, value]) => value)), 2);
  assert.equal(
    queryCells(open.table(7), 'count', {
      west: -170,
      south: -5,
      east: 170,
      north: 5,
    }).cells.length,
    0,
  );
  // The world at resolution 0, capped.
  const world = { west: -180, south: -90, east: 180, north: 90 };
  const base = distinct(0);
  assert.equal(queryCells(open.table(0), 'count', world).cells.length, base);
  assert.deepEqual(
    queryCells(open.table(0), 'count', world, { maxCells: base - 1 }),
    { tooMany: base },
  );
  assert.throws(() => queryCells(open.table(0), 'pages', world), /No variant/);
  const plain = tablesOf(POINTS, { text: false }).tables;
  writeH3File(path.join(root, 'plain.bin'), { header: {}, tables: plain });
  assert.throws(
    () =>
      queryCells(
        openH3File(path.join(root, 'plain.bin')).table(0),
        'text',
        world,
      ),
    /without article sizes/,
  );
});

test('the build writes h3.bin from the fixture beside the grid, and status reports it', async (t) => {
  const root = await tempRoot(t);
  const geo = await binGeoTags(gzipStream(GEO_SQL), { text: true });
  assert.equal(geo.pageHexes.size, EXPECTED.pagesKept);
  const page = await addPageSizes(gzipStream(PAGE_SQL), geo);
  const file = path.join(root, 'h3.bin');
  const { header } = writeCoverageH3({
    hexes: geo.hexes,
    file,
    dump: { lastModified: 'Wed, 01 Oct 2026 03:14:15 GMT', etag: '"abc"' },
    geo: geo.stats,
    page,
    now: () => Date.parse('2026-10-17T12:00:00Z'),
  });
  assert.equal(header.dump.date, '2026-10-01');
  assert.equal(header.text.included, true);
  const open = openH3File(file);
  for (const res of RESOLUTIONS) {
    const table = open.table(res);
    assert.equal(sum(table.articles), EXPECTED.kept, `resolution ${res}`);
    assert.equal(
      sum(table.bytes),
      EXPECTED.text.bytes,
      `resolution ${res} bytes`,
    );
  }
  assert.ok(open.table(0).cells <= 122, 'at most the 122 base cells');
  assert.ok(open.table(7).cells > open.table(0).cells);
  // The Baltimore cell of the fixture (51 articles within 0.03° × 0.02°) at resolution 5.
  const five = queryCells(open.table(5), 'count', {
    west: -77,
    south: 39,
    east: -76,
    north: 40,
  });
  assert.equal(sum(five.cells.map(([, value]) => value)), 51);
  const status = h3StatusOf(file);
  assert.equal(status.built, true);
  assert.equal(status.text, true);
  assert.equal(status.resolutions.length, 8);
  assert.equal(h3StatusOf(path.join(root, 'none.bin')).built, false);

  // The whole build writes both files; a second run is skipped only when both exist.
  const server = async (url, init) => {
    const body = zlib.gzipSync(
      Buffer.from(url.includes('page') ? PAGE_SQL : GEO_SQL),
    );
    if (init.headers['If-None-Match'] === '"v1"')
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    return new Response(body, {
      status: 200,
      headers: {
        etag: '"v1"',
        'last-modified': 'Wed, 01 Oct 2026 03:14:15 GMT',
      },
    });
  };
  const dir = path.join(root, 'build');
  const first = await runBuild({
    dir,
    fetchImpl: server,
    sleepImpl: async () => {},
  });
  assert.equal(first.skipped, false);
  assert.equal(first.h3.resolutions.length, 8);
  assert.equal(first.h3.text.included, false);
  assert.equal(statusOf(dir).h3.built, true);
  const again = await runBuild({
    dir,
    fetchImpl: server,
    currentHeader: first.header,
  });
  assert.equal(again.skipped, true);
  fs.rmSync(path.join(dir, 'h3.bin'));
  const rebuilt = await runBuild({
    dir,
    fetchImpl: server,
    currentHeader: first.header,
  });
  assert.equal(rebuilt.skipped, false, 'a missing h3.bin is built again');
  assert.ok(fs.existsSync(path.join(dir, 'h3.bin')));
  const runs = fs
    .readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(JSON.parse(runs.at(-1)).h3Cells.length, 8);
});

test('the route answers 200 with the cells, 400, 404, 413 and 503, cached and gzip like the tiles', async (t) => {
  const root = await tempRoot(t);
  const { tables } = tablesOf(POINTS);
  const h3File = path.join(root, 'h3.bin');
  writeH3File(h3File, { header: { dump: { date: '2026-10-08' } }, tables });
  const service = createWikipediaCoverageService({
    sourceRoot: root,
    env: {},
    gridFile: path.join(root, 'grid.bin'),
    h3File,
    h3MaxCells: distinct(0),
  });
  assert.equal(H3_MAX_CELLS, 20_000);
  const handler = createWikipediaCoverageHandler({ service });
  const call = async (url, headers = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.raw = body;
        this.body = JSON.parse(
          this.headers['content-encoding'] === 'gzip'
            ? zlib.gunzipSync(body)
            : body,
        );
      },
    };
    await handler(
      {
        url,
        method: 'GET',
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
      },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  // /layers reports the hexagons even without a grid.
  const layers = await call('/layers');
  assert.equal(layers.body.configured, false);
  assert.deepEqual(layers.body.h3, {
    built: true,
    resolutions: RESOLUTIONS,
    cells: Object.fromEntries(RESOLUTIONS.map((res) => [res, distinct(res)])),
    text: true,
    maxCells: distinct(0),
  });

  const ok = await call('/h3/5/articles?west=-77&south=39&east=-76&north=40');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(ok.headers['cache-control'], 'private, max-age=86400');
  assert.equal(ok.headers['vary'], 'Accept-Encoding');
  assert.equal(ok.headers['content-encoding'], undefined);
  assert.equal(ok.body.res, 5);
  assert.equal(ok.body.variant, 'articles');
  assert.deepEqual(ok.body.dump, { date: '2026-10-08' });
  assert.ok(ok.body.domain.max >= ok.body.domain.min);
  assert.equal(ok.body.cells.length, 1);
  assert.equal(ok.body.cells[0][0], '852aa8c7fffffff');
  assert.ok(
    Math.abs(ok.body.cells[0][1] - 2 / h3.cellArea('852aa8c7fffffff', 'km2')) <
      1e-6 * ok.body.cells[0][1],
  );

  const zipped = await call('/h3/5/count?west=-77&south=39&east=-76&north=40', {
    'accept-encoding': 'gzip, br',
  });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.deepEqual(zipped.body.cells, [['852aa8c7fffffff', 2]]);

  const dateline = await call(
    '/h3/7/count?west=170&south=-5&east=-170&north=5',
  );
  assert.equal(dateline.body.cells.length, 2);

  const bad = await call('/h3/8/articles?west=-77&south=39&east=-76&north=40');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body.message, /0 to 7/);
  assert.equal(
    (await call('/h3/5/pages?west=-77&south=39&east=-76&north=40')).statusCode,
    400,
  );
  const box = await call('/h3/5/articles?west=-77&south=39&east=-76');
  assert.equal(box.statusCode, 400);
  assert.match(box.body.message, /degrees/);
  assert.equal(
    (await call('/h3/5/articles?west=-77&south=41&east=-76&north=40'))
      .statusCode,
    400,
  );
  assert.equal(
    (await call('/h3/x/articles?west=0&south=0&east=1&north=1')).nexted,
    true,
  );

  const many = await call('/h3/7/count?west=-180&south=-90&east=180&north=90');
  assert.equal(many.statusCode, 413);
  assert.match(
    many.body.message,
    new RegExp(`More than ${distinct(0)} cells at resolution 7`),
  );
  assert.equal(
    (await call('/h3/0/count?west=-180&south=-90&east=180&north=90')).body.cells
      .length,
    distinct(0),
  );

  // Without sizes the text variant is a 404; without the file a 503.
  writeH3File(h3File, {
    header: {},
    tables: tablesOf(POINTS, { text: false }).tables,
  });
  const later = createWikipediaCoverageService({
    sourceRoot: root,
    env: {},
    gridFile: path.join(root, 'grid.bin'),
    h3File,
  });
  const text = await later.h3(5, 'text', {
    west: -77,
    south: 39,
    east: -76,
    north: 40,
  });
  assert.equal(text.status, 404);
  assert.match(text.message, /--text/);
  const none = createWikipediaCoverageHandler({
    service: createWikipediaCoverageService({
      sourceRoot: root,
      env: {},
      gridFile: path.join(root, 'grid.bin'),
      h3File: path.join(root, 'missing.bin'),
    }),
  });
  const res = {
    headers: {},
    setHeader(n, v) {
      this.headers[n] = v;
    },
    end(b) {
      this.body = JSON.parse(b);
    },
  };
  await none(
    {
      url: '/h3/5/articles?west=-77&south=39&east=-76&north=40',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {},
    },
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.message, NEEDS_H3);
  const layersNone = {
    headers: {},
    setHeader(n, v) {
      this.headers[n] = v;
    },
    end(b) {
      this.body = JSON.parse(b);
    },
  };
  await none(
    {
      url: '/layers',
      method: 'GET',
      headers: { host: 'localhost' },
      socket: {},
    },
    layersNone,
  );
  assert.deepEqual(layersNone.body.h3, { built: false });
});
