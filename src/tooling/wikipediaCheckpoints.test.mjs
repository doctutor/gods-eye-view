// Personal fork: the Wikipedia points build survives a restart
// (scripts/wikipedia/checkpoints.mjs): each wiki's joined articles kept as
// a checkpoint keyed by its dumps, a rerun reading them instead of the
// dumps and writing the same index byte for byte, --force reading the
// dumps again, and the index's switch-over that a stopped write never
// leaves half done.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  checkpointDir,
  checkpointKey,
  listCheckpoints,
  readCheckpoint,
  writeCheckpoint,
} from '../../scripts/wikipedia/checkpoints.mjs';
import {
  WikiArticles,
  WikiCoordinates,
} from '../../scripts/wikipedia/pointStore.mjs';
import {
  POINTS_FORMAT,
  createPointsUnion,
  pointsStatusOf,
  writePointsIndex,
} from '../../scripts/wikipedia/points.mjs';
import { runBuild } from '../../scripts/wikipedia/build.mjs';
import { createPointsIndex } from '../../server/providers/wikipediaCoverage/pointsIndex.js';
import { FLAG_SECONDARY } from '../../server/providers/wikipediaCoverage/pointsFile.js';
import { pointWikiOfKey } from '../../src/data/wikipediaPoints.js';

const en = pointWikiOfKey('enwiki');
const de = pointWikiOfKey('dewiki');
const meta = (day, etag = null) => ({
  lastModified: `Thu, ${day} Oct 2026 03:30:29 GMT`,
  etag,
});
const dumps = {
  geo_tags: meta('01', '"g"'),
  page: meta('01'),
  page_props: meta('01', '"p"'),
};

test('a checkpoint is keyed by its wiki’s three dumps, the format and the secondary flag', () => {
  const key = checkpointKey({
    wiki: de,
    dumps,
    pointsFormat: POINTS_FORMAT,
    secondary: false,
  });
  assert.match(key.file, /^dewiki\.[0-9a-f]{16}\.bin$/);
  const same = checkpointKey({
    wiki: de,
    dumps: structuredClone(dumps),
    pointsFormat: POINTS_FORMAT,
    secondary: false,
  });
  assert.equal(same.hash, key.hash);
  const differs = (change) =>
    assert.notEqual(
      checkpointKey({
        wiki: de,
        dumps,
        pointsFormat: POINTS_FORMAT,
        secondary: false,
        ...change,
      }).hash,
      key.hash,
    );
  differs({ dumps: { ...dumps, page: meta('08') } });
  differs({ dumps: { ...dumps, page_props: meta('01', '"q"') } });
  differs({ secondary: true });
  differs({ pointsFormat: POINTS_FORMAT + 1 });
  differs({ wiki: en });
  // A dump with neither Last-Modified nor ETag: nothing to key on.
  assert.equal(
    checkpointKey({
      wiki: de,
      dumps: { ...dumps, page: {} },
      pointsFormat: POINTS_FORMAT,
      secondary: false,
    }),
    null,
  );
});

/** A wiki's articles with secondaries, items and titles in several scripts. */
function sampleArticles() {
  const c = new WikiCoordinates();
  const add = (page, x, y, type, primary) =>
    c.add(page, {
      x,
      y,
      dim: primary ? 1000.5 : 0,
      type,
      flags: primary ? 0 : FLAG_SECONDARY,
      primary,
    });
  add(10, 100, 200, 'city', true);
  add(10, 101, 201, 'landmark', false);
  add(11, 300, 400, 'landmark', true);
  add(12, 500, 600, 'mountain', true);
  add(13, 700, 800, 'city', true); // not an article
  c.setArticle(10, 'Paris', 300000);
  c.setArticle(11, 'Tour Eiffel', 150000);
  c.setArticle(12, '富士山 Москва', 90000);
  c.setItem(10, 90);
  c.setItem(11, 243);
  return WikiArticles.fromCoordinates(c);
}

test('a checkpoint reads back as the articles it was written from, folded the same', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-ckpt-'));
  try {
    const key = checkpointKey({
      wiki: de,
      dumps,
      pointsFormat: POINTS_FORMAT,
      secondary: true,
    });
    const articles = sampleArticles();
    assert.equal(articles.articles, 3, 'articles only');
    assert.equal(articles.coordinates, 4);
    const stats = { geo: { rows: 5 }, page: { matched: 3 }, wikidata: {} };
    // An older checkpoint of the same wiki goes when a new one is written.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dewiki.0000000000000000.bin'), 'old');
    writeCheckpoint(dir, key, articles, stats);
    assert.deepEqual(fs.readdirSync(dir), [key.file]);
    const saved = readCheckpoint(dir, key);
    assert.deepEqual(saved.stats, stats);
    const back = saved.articles;
    for (const name of [
      'page',
      'bytes',
      'qid',
      'first',
      'count',
      'x',
      'y',
      'dim',
      'type',
      'flags',
    ])
      assert.deepEqual(
        [...back[name].view()],
        [...articles[name].view()],
        name,
      );
    assert.deepEqual(back.types, articles.types);
    assert.deepEqual(
      [0, 1, 2].map((i) => back.titles.get(i)),
      ['Paris', 'Tour Eiffel', '富士山 Москва'],
    );
    // Folded into a union, the same records as from the articles themselves.
    const records = (a) => {
      const union = createPointsUnion();
      union.add(de, a);
      union.finish();
      return Array.from({ length: union.count }, (_, i) => union.at(i));
    };
    assert.deepEqual(records(back), records(sampleArticles()));
    // Another key (a changed dump): no checkpoint.
    const other = checkpointKey({
      wiki: de,
      dumps: { ...dumps, page: meta('08') },
      pointsFormat: POINTS_FORMAT,
      secondary: true,
    });
    assert.equal(readCheckpoint(dir, other), null);
    // A torn file (a write cut short): not a checkpoint.
    const file = path.join(dir, key.file);
    const whole = fs.readFileSync(file);
    fs.writeFileSync(file, whole.subarray(0, whole.length - 3));
    assert.equal(readCheckpoint(dir, key), null);
    assert.deepEqual(listCheckpoints(dir), []);
    fs.writeFileSync(file, whole);
    assert.deepEqual(
      listCheckpoints(dir).map((c) => [c.wiki, c.articles, c.secondary]),
      [['dewiki', 3, true]],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

/** enwiki (flat in raw/, its page table elsewhere) and dewiki (raw/dewiki/), offline. */
function writeDumps(raw) {
  const gz = (file, text) =>
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text)));
  const metas = (at, day) => {
    for (const table of ['geo_tags', 'page', 'page_props'])
      fs.writeFileSync(
        path.join(at, `${table}.meta.json`),
        JSON.stringify(meta(day, `"${table}"`)),
      );
  };
  fs.mkdirSync(raw, { recursive: true });
  gz(
    path.join(raw, 'enwiki-latest-geo_tags.sql.gz'),
    sql('geo_tags', GEO, [
      [1, 10, 'earth', 1, 48.8566, 2.3522, 10000, 'city'],
      [2, 10, 'earth', 0, 48.86, 2.34, 100, 'landmark'],
      [3, 11, 'earth', 1, 48.8584, 2.2945, 300, 'landmark'],
      [4, 13, 'earth', 1, 45.8326, 6.8652, 2000, 'mountain'],
    ]),
  );
  gz(
    path.join(raw, 'enwiki-latest-page_props.sql.gz'),
    sql('page_props', PROPS, [
      [10, 'wikibase_item', 'Q90', null],
      [11, 'wikibase_item', 'Q243', null],
    ]),
  );
  const pageDir = path.join(raw, 'page');
  fs.mkdirSync(pageDir);
  gz(
    path.join(pageDir, 'enwiki-latest-page.sql.gz'),
    sql('page', PAGE, [
      [10, 0, 'Paris', 0, 300000],
      [11, 0, 'Eiffel_Tower', 0, 150000],
      [13, 0, 'Mont_Blanc', 0, 90000],
    ]),
  );
  metas(raw, '08');
  metas(pageDir, '08');
  const deDir = path.join(raw, 'dewiki');
  fs.mkdirSync(deDir);
  gz(
    path.join(deDir, 'dewiki-latest-geo_tags.sql.gz'),
    sql('geo_tags', GEO, [
      [1, 500, 'earth', 1, 48.8567, 2.3508, 10000, 'city'],
      [2, 501, 'earth', 1, 52.5163, 13.3777, 200, 'landmark'],
    ]),
  );
  gz(
    path.join(deDir, 'dewiki-latest-page.sql.gz'),
    sql('page', PAGE, [
      [500, 0, 'Paris', 0, 200000],
      [501, 0, 'Brandenburger_Tor', 0, 80000],
    ]),
  );
  gz(
    path.join(deDir, 'dewiki-latest-page_props.sql.gz'),
    sql('page_props', PROPS, [
      [500, 'wikibase_item', 'Q90', null],
      [501, 'wikibase_item', 'Q82425', null],
    ]),
  );
  metas(deDir, '01');
  return path.join(pageDir, 'enwiki-latest-page.sql.gz');
}

/** Every file of the current index, by its name less the build's stamp. */
function indexBytes(pointsDir) {
  const { manifest } = JSON.parse(
    fs.readFileSync(path.join(pointsDir, 'current.json'), 'utf8'),
  );
  const m = JSON.parse(fs.readFileSync(path.join(pointsDir, manifest), 'utf8'));
  const out = {
    overview: fs.readFileSync(path.join(pointsDir, m.overview.file)),
    langs: fs.readFileSync(path.join(pointsDir, m.langs.file)),
  };
  for (const [bucket, entry] of Object.entries(m.buckets))
    out[`bucket ${bucket}`] = fs.readFileSync(
      path.join(pointsDir, 'buckets', entry.file),
    );
  return out;
}

test('a rerun reads the checkpoints, not the dumps, and writes the same index; --force reads the dumps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-resume-'));
  try {
    const raw = path.join(dir, 'raw');
    const pageFile = writeDumps(raw);
    const lines = [];
    const build = (options = {}) =>
      runBuild({
        dir,
        rawDir: raw,
        points: true,
        pointsOnly: true,
        offline: true,
        wikis: 'enwiki,dewiki',
        pageFile,
        fetchImpl: () => assert.fail('offline'),
        sleepImpl: async () => {},
        log: (line) => lines.push(line),
        ...options,
      });
    const first = await build();
    const pointsDir = path.join(dir, 'points');
    const fresh = indexBytes(pointsDir);
    assert.deepEqual(
      listCheckpoints(checkpointDir(pointsDir)).map((c) => c.wiki),
      ['dewiki', 'enwiki'],
    );
    assert.deepEqual(
      pointsStatusOf(pointsDir).checkpoints.map((c) => [c.wiki, c.articles]),
      [
        ['dewiki', 2],
        ['enwiki', 3],
      ],
    );
    // The dumps unreadable now: a rerun must not open them.
    for (const file of [
      path.join(raw, 'enwiki-latest-geo_tags.sql.gz'),
      path.join(raw, 'enwiki-latest-page_props.sql.gz'),
      pageFile,
      path.join(raw, 'dewiki', 'dewiki-latest-geo_tags.sql.gz'),
      path.join(raw, 'dewiki', 'dewiki-latest-page.sql.gz'),
      path.join(raw, 'dewiki', 'dewiki-latest-page_props.sql.gz'),
    ])
      fs.writeFileSync(file, 'not gzip');
    lines.length = 0;
    const second = await build();
    assert.ok(
      lines.some((l) =>
        /^enwiki: its dumps are those of its checkpoint/.test(l),
      ),
    );
    assert.ok(
      lines.some((l) =>
        /^dewiki: its dumps are those of its checkpoint/.test(l),
      ),
    );
    assert.deepEqual(indexBytes(pointsDir), fresh, 'byte for byte');
    assert.equal(second.points.points, first.points.points);
    assert.deepEqual(second.points.stats, first.points.stats);
    const unstamped = ({ file, ...rest }) => rest;
    assert.deepEqual(
      unstamped(second.points.langs),
      unstamped(first.points.langs),
    );
    // --force reads the dumps (here unreadable): it does not use the checkpoints.
    await assert.rejects(build({ force: true }));
    // A changed dump (dewiki's page table re-dated): that wiki is read again.
    fs.writeFileSync(
      path.join(raw, 'dewiki', 'page.meta.json'),
      JSON.stringify(meta('09', '"page2"')),
    );
    await assert.rejects(
      build(),
      /incorrect header check|unexpected end|not gzip|Z_DATA_ERROR/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write stopped half way leaves the earlier index current and whole; the next clears what it left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-atomic-'));
  try {
    const pointsDir = path.join(dir, 'points');
    const records = Array.from({ length: 400 }, (_, i) => ({
      x: ((i * 7919) % 4096) << 16,
      y: ((i * 104729) % 4096) << 16,
      page: i + 1,
      qid: i + 1,
      bytes: 1000 + i,
      dim: 0,
      cls: 1,
      flags: 0,
      wiki: 1,
      title: `Place ${i}`,
      type: 'city',
    }));
    writePointsIndex({ dir: pointsDir, points: records });
    const before = fs.readFileSync(
      path.join(pointsDir, 'current.json'),
      'utf8',
    );
    const answer = () => {
      const index = createPointsIndex({ dir: pointsDir });
      try {
        return index.points({
          west: -180,
          south: -85,
          east: 180,
          north: 85,
          zoom: 2,
        }).body.points.length;
      } finally {
        index.close();
      }
    };
    const served = answer();
    assert.ok(served > 0);
    // The next build dies after a few blocks (a restart, a crash).
    const union = createPointsUnion();
    for (const record of records)
      union.addRecord({ ...record, bytes: record.bytes + 1 });
    const at = union.at.bind(union);
    let made = 0;
    union.at = (i) => {
      if (++made > 300) throw new Error('the power went');
      return at(i);
    };
    assert.throws(
      () => writePointsIndex({ dir: pointsDir, union }),
      /the power went/,
    );
    assert.equal(
      fs.readFileSync(path.join(pointsDir, 'current.json'), 'utf8'),
      before,
    );
    assert.equal(answer(), served, 'the earlier index still answers');
    // The next whole build switches over and clears every leftover.
    const manifest = writePointsIndex({ dir: pointsDir, points: records });
    const keep = new Set(Object.values(manifest.buckets).map((b) => b.file));
    assert.deepEqual(
      fs
        .readdirSync(path.join(pointsDir, 'buckets'))
        .filter((name) => !keep.has(name)),
      [],
    );
    assert.deepEqual(
      fs
        .readdirSync(pointsDir)
        .filter(
          (name) =>
            ![
              'buckets',
              'current.json',
              `manifest-${manifest.version}.json`,
              manifest.overview.file,
              manifest.langs.file,
            ].includes(name),
        ),
      [],
    );
    assert.equal(answer(), served);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
