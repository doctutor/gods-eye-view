// Personal fork: the Wikipedia coverage build (scripts/wikipedia/), on the
// committed fixture in the shape of Wikimedia's dumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  createDumpParser,
  parseColumns,
  parseDumpStream,
  parseTupleValues,
  unescapeSql,
} from '../../scripts/wikipedia/dump.mjs';
import {
  GEO_TAGS_URL,
  PAGE_URL,
  USER_AGENT,
  addPageSizes,
  binGeoTags,
  download,
  dumpDate,
  runBuild,
  writeCoverageGrid,
} from '../../scripts/wikipedia/build.mjs';
import {
  parseArgs,
  statusOf,
  wikipediaDir,
} from '../../scripts/wikipedia/index.mjs';
import {
  BASE_WIDTH,
  openGrid,
  quantile,
  rowAreaKm2,
} from '../../server/providers/wikipediaCoverage/grid.js';

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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-wiki-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** The text in chunks of a size, as an async iterable. */
async function* chunked(text, size) {
  for (let at = 0; at < text.length; at += size)
    yield text.slice(at, at + size);
}

/** A gzip of the text, streamed in small pieces as a dump download would be. */
function gzipStream(text, pieces = 7) {
  const gz = zlib.gzipSync(Buffer.from(text));
  const size = Math.ceil(gz.length / pieces);
  const parts = [];
  for (let at = 0; at < gz.length; at += size)
    parts.push(gz.subarray(at, at + size));
  return Readable.from(parts).pipe(zlib.createGunzip());
}

test('tuple values: NULL, numbers, escaped strings, _binary and hex literals', () => {
  assert.equal(
    unescapeSql(String.raw`O\'Brien\\s \"x\" \n`),
    `O'Brien\\s "x" \n`,
  );
  assert.deepEqual(
    parseTupleValues(
      String.raw`1,1000,'earth',1,39.29000000,-76.61000000,NULL,'city','O\'Brien\'s Pub','US','MD'`,
    ),
    [
      1,
      1000,
      'earth',
      1,
      39.29,
      -76.61,
      null,
      'city',
      "O'Brien's Pub",
      'US',
      'MD',
    ],
  );
  assert.deepEqual(parseTupleValues(`_binary 'earth',0x6d6f6f6e,'a,b',''`), [
    'earth',
    'moon',
    'a,b',
    '',
  ]);
  assert.deepEqual(
    parseColumns(
      '  `gt_id` int(10) unsigned NOT NULL,\n  `gt_lat` decimal(11,8) DEFAULT NULL,\n  PRIMARY KEY (`gt_id`),\n  KEY `x` (`gt_lat`)',
    ),
    ['gt_id', 'gt_lat'],
  );
});

test('the dump parser reads the same rows whatever the chunk size', async () => {
  const columns = [
    'gt_id',
    'gt_page_id',
    'gt_globe',
    'gt_primary',
    'gt_lat',
    'gt_lon',
    'gt_dim',
    'gt_type',
    'gt_name',
    'gt_country',
    'gt_region',
  ];
  let reference = null;
  for (const size of [1, 7, 1000, GEO_SQL.length]) {
    const rows = [];
    let seenColumns = null;
    const result = await parseDumpStream(chunked(GEO_SQL, size), {
      table: 'geo_tags',
      onColumns: (names) => (seenColumns = names),
      onRow: (values) => rows.push(values),
    });
    assert.deepEqual(seenColumns, columns, `columns at ${size}`);
    assert.equal(result.rows, EXPECTED.rows, `rows at ${size}`);
    assert.equal(result.inserts, 4);
    assert.ok(rows.every((row) => row.length === 11));
    if (reference) assert.deepEqual(rows, reference, `rows differ at ${size}`);
    reference = rows;
  }
  const pub = reference.find((row) => row[8] === "O'Brien's Pub");
  assert.ok(pub, 'an escaped quote is undone');
  assert.ok(reference.some((row) => row[8] === 'Café "Zed"'));
  assert.ok(reference.some((row) => row[8] === 'a\\b'));
  assert.ok(
    reference.some((row) => row[8] === '東京'),
    'UTF-8 split across chunks survives',
  );
  assert.ok(reference.some((row) => row[2] === 'moon' && row[7] === null));
});

test('the parser refuses rows before their CREATE TABLE and a dump cut inside an INSERT', () => {
  const parser = createDumpParser({ table: 'geo_tags', onRow: () => {} });
  assert.throws(
    () => parser.write("INSERT INTO `geo_tags` VALUES (1,2,'earth');"),
    /No CREATE TABLE/,
  );
  const cut = createDumpParser({ table: 'page', onRow: () => {} });
  cut.write(
    'CREATE TABLE `page` (\n  `page_id` int,\n  `page_len` int\n) ENGINE=InnoDB;\n',
  );
  cut.write('INSERT INTO `page` VALUES (1,10),(2,');
  assert.throws(() => cut.end(), /ended inside an INSERT/);
  assert.throws(
    () => createDumpParser({ table: 'a b', onRow: () => {} }),
    /bare name/,
  );
});

test('geo_tags are binned: Earth and primary only, poles and the antimeridian in the last cells', async () => {
  const { accumulator, pageCells, stats } = await binGeoTags(
    gzipStream(GEO_SQL),
    {
      text: true,
    },
  );
  assert.equal(stats.rows, EXPECTED.rows);
  assert.equal(stats.kept, EXPECTED.kept);
  assert.equal(stats.otherGlobe, EXPECTED.otherGlobe);
  assert.equal(stats.secondary, EXPECTED.secondary);
  assert.equal(stats.invalid, EXPECTED.invalid);
  assert.equal(stats.duplicatePage, EXPECTED.duplicatePage);
  assert.equal(pageCells.size, EXPECTED.pagesKept);
  assert.deepEqual(stats.byType, EXPECTED.byType);
  let total = 0;
  for (const count of accumulator.counts) total += count;
  assert.equal(total, EXPECTED.kept, 'every kept row is in exactly one cell');
  for (const [key, count] of Object.entries(EXPECTED.cells)) {
    const [row, col] = key.split(':').map(Number);
    assert.equal(
      accumulator.counts[row * BASE_WIDTH + col],
      count,
      `cell ${key}`,
    );
  }
  // The eight edge rows: (90, 0) is row 0; (-90, 0) the last row; 180° E
  // the last column; 180° W the first.
  assert.ok(EXPECTED.cells['0:3600'] >= 1, 'the north pole');
  assert.ok(EXPECTED.cells['3599:3600'] >= 1, 'the south pole');
  assert.ok(EXPECTED.cells['1800:7199'] >= 1, '180° E');
  assert.ok(EXPECTED.cells['1800:0'] >= 1, '180° W');
  assert.ok(EXPECTED.cells['0:7199'] >= 1, 'the north-east corner');
  assert.ok(EXPECTED.cells['3599:0'] >= 1, 'the south-west corner');
  assert.equal(EXPECTED.cells['1014:2067'], 51, 'the Baltimore cell');
  assert.equal(EXPECTED.cells['770:3597'], 40, 'the London cell');
  assert.ok(accumulator.bytes, 'bytes are kept when asked');

  // The page pass sizes only pages the geo pass kept, skipping redirects.
  const page = await addPageSizes(gzipStream(PAGE_SQL), {
    accumulator,
    pageCells,
  });
  assert.equal(page.rows, 60);
  assert.equal(page.matched, EXPECTED.text.matched);
  assert.equal(page.bytes, EXPECTED.text.bytes);
  assert.equal(page.redirects, EXPECTED.text.redirects);
  for (const [key, bytes] of Object.entries(EXPECTED.text.cellBytes)) {
    const [row, col] = key.split(':').map(Number);
    assert.equal(
      accumulator.bytes[row * BASE_WIDTH + col],
      bytes,
      `bytes in ${key}`,
    );
  }
});

test('a build without --text keeps counts only and a limit stops the read', async () => {
  const { accumulator, stats } = await binGeoTags(chunked(GEO_SQL, 4096), {
    text: false,
    limit: 100,
  });
  assert.equal(accumulator.bytes, null);
  assert.equal(
    stats.rows,
    EXPECTED.rows,
    'rows past the limit are still counted as read',
  );
  let total = 0;
  for (const count of accumulator.counts) total += count;
  assert.ok(total <= 100 && total > 50, `${total} kept of the first 100`);
});

test('the grid file carries the dump, the counts and the ramp domains', async (t) => {
  const root = await tempRoot(t);
  const geo = await binGeoTags(gzipStream(GEO_SQL), { text: true });
  const page = await addPageSizes(gzipStream(PAGE_SQL), geo);
  const file = path.join(root, 'grid.bin');
  const { header } = writeCoverageGrid({
    accumulator: geo.accumulator,
    file,
    dump: {
      url: GEO_TAGS_URL,
      etag: '"abc"',
      lastModified: 'Wed, 01 Oct 2026 03:14:15 GMT',
      bytes: 123,
    },
    geo: geo.stats,
    page,
    now: () => Date.parse('2026-10-17T12:00:00Z'),
  });
  assert.equal(header.builtAt, '2026-10-17T12:00:00.000Z');
  assert.equal(header.dump.date, '2026-10-01');
  assert.equal(header.dump.etag, '"abc"');
  assert.deepEqual(header.rows, {
    read: EXPECTED.rows,
    kept: EXPECTED.kept,
    otherGlobe: EXPECTED.otherGlobe,
    secondary: EXPECTED.secondary,
    invalid: EXPECTED.invalid,
    duplicatePage: EXPECTED.duplicatePage,
  });
  assert.equal(header.text.included, true);
  assert.equal(header.text.pagesMatched, EXPECTED.text.matched);
  const commonest = Object.entries(EXPECTED.byType).sort(
    (a, b) => b[1] - a[1],
  )[0];
  assert.deepEqual(header.types[0], { key: commonest[0], count: commonest[1] });
  // Domains: the ramp runs from the 5th to the 99.5th percentile of the
  // non-empty cells (nearest rank); with under 200 cells here the ceiling
  // is the Baltimore cell's 51.
  const counts = Object.values(EXPECTED.cells).sort((a, b) => a - b);
  assert.equal(header.domains.count.cells, counts.length);
  assert.equal(header.domains.count.min, 1);
  assert.equal(header.domains.count.max, quantile(counts, 0.995));
  assert.equal(header.domains.count.max, 51);
  assert.equal(header.domains.count.median, 1);
  const densities = Object.entries(EXPECTED.cells)
    .map(([key, count]) => count / rowAreaKm2(0, Number(key.split(':')[0])))
    .sort((a, b) => a - b);
  assert.equal(header.domains.articles.max, quantile(densities, 0.995));
  assert.equal(header.domains.articles.min, quantile(densities, 0.05));
  assert.ok(header.domains.text.max > header.domains.text.min);
  const grid = openGrid(file);
  assert.equal(grid.header.dump.date, '2026-10-01');
  assert.equal(grid.hasText, true);
  assert.equal(grid.level(0).counts[1014 * BASE_WIDTH + 2067], 51);
  let coarse = 0;
  for (const count of grid.level(4).counts) coarse += count;
  assert.equal(coarse, EXPECTED.kept, 'the coarsest level sums to the same');
  assert.deepEqual(grid.loaded(), [0, 4]);
  assert.equal(dumpDate('nonsense'), null);
});

/** A fake dumps server: the gzipped fixture under both URLs, with an ETag. */
function fakeDumps({
  etag = '"v1"',
  lastModified = 'Wed, 01 Oct 2026 03:14:15 GMT',
} = {}) {
  const calls = [];
  const bodies = {
    [GEO_TAGS_URL]: zlib.gzipSync(Buffer.from(GEO_SQL)),
    [PAGE_URL]: zlib.gzipSync(Buffer.from(PAGE_SQL)),
  };
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url, headers: init.headers });
      const body = bodies[url];
      if (!body) return new Response('no', { status: 404 });
      if (init.headers['If-None-Match'] === etag)
        return new Response(null, { status: 304, headers: { etag } });
      return new Response(body, {
        status: 200,
        headers: {
          etag,
          'last-modified': lastModified,
          'content-length': String(body.length),
        },
      });
    },
  };
}

test('downloads name themselves, send the ETag back, and skip an unchanged dump', async (t) => {
  const root = await tempRoot(t);
  const server = fakeDumps();
  const file = path.join(root, 'geo.sql.gz');
  const metaFile = path.join(root, 'geo.meta.json');
  const first = await download({
    url: GEO_TAGS_URL,
    file,
    metaFile,
    fetchImpl: server.fetchImpl,
    now: () => Date.parse('2026-10-17T12:00:00Z'),
  });
  assert.equal(first.changed, true);
  assert.equal(first.meta.etag, '"v1"');
  assert.equal(first.meta.fetchedAt, '2026-10-17T12:00:00.000Z');
  assert.equal(server.calls[0].headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /\+https:\/\//, 'a contact URL, as Wikimedia asks');
  assert.equal(server.calls[0].headers['If-None-Match'], undefined);
  assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString(), GEO_SQL);
  assert.deepEqual(JSON.parse(fs.readFileSync(metaFile, 'utf8')), first.meta);

  const second = await download({
    url: GEO_TAGS_URL,
    file,
    metaFile,
    fetchImpl: server.fetchImpl,
  });
  assert.equal(second.changed, false);
  assert.equal(server.calls[1].headers['If-None-Match'], '"v1"');
  assert.equal(
    server.calls[1].headers['If-Modified-Since'],
    'Wed, 01 Oct 2026 03:14:15 GMT',
  );

  const forced = await download({
    url: GEO_TAGS_URL,
    file,
    metaFile,
    fetchImpl: server.fetchImpl,
    force: true,
  });
  assert.equal(forced.changed, true);
  assert.equal(server.calls[2].headers['If-None-Match'], undefined);

  // A short body is not kept.
  await assert.rejects(
    download({
      url: GEO_TAGS_URL,
      file: path.join(root, 'short.gz'),
      metaFile: path.join(root, 'short.json'),
      fetchImpl: async () =>
        new Response(Buffer.from('abc'), {
          status: 200,
          headers: { 'content-length': '10' },
        }),
    }),
    /3 of 10 bytes/,
  );
  assert.equal(fs.existsSync(path.join(root, 'short.gz')), false);
});

test('a full build writes the grid, a second run is skipped, and --text adds the page pass', async (t) => {
  const root = await tempRoot(t);
  const server = fakeDumps();
  const log = [];
  let clock = Date.parse('2026-10-17T12:00:00Z');
  const options = {
    dir: root,
    fetchImpl: server.fetchImpl,
    now: () => clock,
    log: (line) => log.push(line),
    sleepImpl: async () => {},
  };
  const first = await runBuild(options);
  assert.equal(first.skipped, false);
  assert.equal(first.header.rows.kept, EXPECTED.kept);
  assert.equal(first.header.text.included, false);
  assert.equal(server.calls.length, 1, 'no page table without --text');
  const status = statusOf(root, () => clock + 3 * 86_400_000);
  assert.equal(status.built, true);
  assert.equal(status.ageDays, 3);
  assert.equal(status.stale, false);
  assert.equal(status.dump.date, '2026-10-01');
  assert.equal(statusOf(root, () => clock + 40 * 86_400_000).stale, true);
  const runs = fs
    .readFileSync(path.join(root, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(runs.length, 1);
  assert.equal(JSON.parse(runs[0]).kept, EXPECTED.kept);

  clock += 1000;
  const again = await runBuild({ ...options, currentHeader: first.header });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'up to date');
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls[1].headers['If-None-Match'], '"v1"');

  clock += 1000;
  const withText = await runBuild({
    ...options,
    text: true,
    currentHeader: first.header,
  });
  assert.equal(
    withText.skipped,
    false,
    'the dump is unchanged but the text was not built',
  );
  assert.equal(withText.header.text.included, true);
  assert.equal(withText.header.text.pagesMatched, EXPECTED.text.matched);
  assert.equal(server.calls.at(-1).url, PAGE_URL);
  assert.ok(log.some((line) => /streaming the page table/.test(line)));
  assert.equal(
    fs.readdirSync(root).filter((name) => /page/.test(name)).length,
    0,
    'the page table is never written to disk',
  );

  const offline = await runBuild({
    ...options,
    offline: true,
    force: true,
    fetchImpl: () => assert.fail('offline'),
  });
  assert.equal(offline.skipped, false);
  assert.equal(statusOf(root).built, true);
  assert.equal(statusOf(path.join(root, 'none')).built, false);
});

test('the command line: build and status, a directory flag or WIKIPEDIA_COVERAGE_DIR', () => {
  assert.deepEqual(parseArgs(['build', '--text', '--limit', '5', '--dir=x']), {
    command: 'build',
    flags: { text: true, limit: '5', dir: 'x' },
  });
  assert.deepEqual(parseArgs([]), { command: 'status', flags: {} });
  assert.throws(() => parseArgs(['build', 'extra']), /unexpected argument/);
  assert.match(
    wikipediaDir({}, {}).replace(/\\/g, '/'),
    /\.gev-cache\/wikipedia$/,
  );
  assert.match(
    wikipediaDir({ WIKIPEDIA_COVERAGE_DIR: 'elsewhere/wiki' }, {}).replace(
      /\\/g,
      '/',
    ),
    /elsewhere\/wiki$/,
  );
  assert.match(wikipediaDir({}, { dir: 'flag' }).replace(/\\/g, '/'), /flag$/);
});
