// Personal fork: the Wikipedia points build's compact storage
// (scripts/wikipedia/pointStore.mjs) and the writer over it
// (points.mjs writeUnionFiles): the columns, the title pool, the per-page
// chains, the stable sort, and the index written from columns byte for
// byte as pointsFile.js writes it from objects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Column,
  Interned,
  TextPool,
  WikiCoordinates,
  stableSortByKey,
} from '../../scripts/wikipedia/pointStore.mjs';
import {
  createPointsUnion,
  rankedRecords,
  writeUnionFiles,
} from '../../scripts/wikipedia/points.mjs';
import {
  FLAG_SECONDARY,
  rankCompare,
  thinPoints,
  unitX,
  unitY,
  writePointsFiles,
} from '../../server/providers/wikipediaCoverage/pointsFile.js';

test('a column grows as it is pushed to and keeps what it held', () => {
  const column = new Column(Uint32Array, 2);
  for (let i = 0; i < 100; i++) assert.equal(column.push(i * 3), i);
  assert.equal(column.length, 100);
  assert.ok(column.array.length >= 100);
  assert.deepEqual([...column.view().subarray(0, 4)], [0, 3, 6, 9]);
  assert.equal(column.view()[99], 297);
});

test('the title pool keeps text as UTF-8 and gives it back; types are interned', () => {
  const pool = new TextPool(4);
  const titles = [
    'Paris',
    'Église Saint-Sulpice',
    '東京タワー',
    'Москва',
    '',
    '🗼 x',
  ];
  const ids = titles.map((title) => pool.add(title));
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(
    ids.map((id) => pool.get(id)),
    titles,
  );
  assert.equal(pool.size, 6);
  // A long one after the pool is full: it grows.
  const long = 'Ä'.repeat(5000);
  assert.equal(pool.get(pool.add(long)), long);
  const types = new Interned();
  assert.equal(types.id('city'), 0);
  assert.equal(types.id('landmark'), 1);
  assert.equal(types.id('city'), 0);
  assert.equal(types.id(null), 2);
  assert.equal(types.get(2), '');
});

test('a page’s coordinates chain with the primary first, whenever it came', () => {
  const c = new WikiCoordinates();
  const at = { x: 1, y: 2, dim: 0, type: 'landmark' };
  c.add(7, { ...at, flags: FLAG_SECONDARY, primary: false });
  c.add(7, { ...at, dim: 5, flags: FLAG_SECONDARY, primary: false });
  assert.equal(c.hasPrimary(7), false);
  c.add(7, { ...at, type: 'city', flags: 0, primary: true });
  assert.equal(c.hasPrimary(7), true);
  c.add(7, { ...at, dim: 9, flags: FLAG_SECONDARY, primary: false });
  c.add(8, { ...at, flags: 0, primary: true });
  const chain = [];
  for (let i = c.heads.get(7); i >= 0; i = c.next.array[i])
    chain.push([c.flags.array[i], c.dim.array[i]]);
  assert.deepEqual(chain, [
    [0, 0],
    [FLAG_SECONDARY, 0],
    [FLAG_SECONDARY, 5],
    [FLAG_SECONDARY, 9],
  ]);
  assert.deepEqual(
    [...c.heads.keys()],
    [7, 8],
    'pages in the order first named',
  );
  // The article and its item ride on the page's first row.
  c.setArticle(7, 'Eiffel Tower', 150000);
  c.setItem(7, 243);
  c.setArticle(99, 'Not geotagged', 1);
  const head = c.heads.get(7);
  assert.equal(c.titles.get(c.title.array[head]), 'Eiffel Tower');
  assert.equal(c.bytes.array[head], 150000);
  assert.equal(c.qid.array[head], 243);
  assert.equal(c.title.array[c.heads.get(8)], -1);
  assert.equal(c.titles.size, 1);
});

test('the stable sort by key keeps equal keys in their order', () => {
  const order = Uint32Array.from([5, 1, 4, 2, 3, 0]);
  const key = [1, 0, 1, 0, 2, 1];
  assert.deepEqual(
    [...stableSortByKey(order, (i) => key[i], 3)],
    [1, 3, 5, 2, 0, 4],
  );
});

/** Records like the build's: clustered, with ties, secondaries and several wikis. */
function syntheticRecords(n) {
  let seed = 99;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const records = [];
  for (let i = 0; i < n; i++) {
    const cluster = Math.floor(random() * 12);
    const tie = random() < 0.1;
    records.push({
      x: unitX(tie ? 2.35 : -150 + (cluster % 4) * 90 + random() * 4),
      y: unitY(tie ? 48.85 : -50 + Math.floor(cluster / 4) * 40 + random() * 4),
      page: tie ? 1 + (i % 3) : i + 1,
      qid: random() < 0.8 ? 1000 + i : 0,
      bytes: tie ? 500 : Math.floor(random() * 100000),
      dim: tie ? 0 : random() < 0.5 ? 0 : random() * 3000,
      cls: 1 + Math.floor(random() * 4),
      flags: random() < 0.15 ? FLAG_SECONDARY : 0,
      wiki: 1 + Math.floor(random() * 3),
      wikis: 1 + Math.floor(random() * 7),
      title: `Place ${i % 50} é東`,
      type: random() < 0.5 ? 'city' : 'landmark',
    });
  }
  return records;
}

test('the ranking over columns is rankCompare’s over the objects', () => {
  const records = syntheticRecords(2000);
  const union = createPointsUnion();
  for (const record of records) union.addRecord(record);
  const expected = records
    .map((record, index) => ({ ...record, index }))
    .sort(rankCompare)
    .map((record) => record.index);
  assert.deepEqual([...rankedRecords(union)], expected);
});

test('the index written from columns is the index written from objects, byte for byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-wiki-store-'));
  try {
    const records = syntheticRecords(6000);
    const union = createPointsUnion();
    for (const record of records) union.addRecord(record);
    union.finish();
    const files = (name) => ({
      overviewFile: path.join(dir, `${name}-overview.bin`),
      fileOf: (bucket) => path.join(dir, `${name}-${bucket}.bin`),
    });
    const expected = writePointsFiles(thinPoints(records), files('objects'));
    const written = writeUnionFiles(union, files('columns'));
    assert.equal(written.overview, expected.overview);
    assert.deepEqual([...written.buckets.keys()], [...expected.buckets.keys()]);
    assert.ok(written.buckets.size > 4, 'several buckets');
    for (const [bucket, entry] of expected.buckets) {
      assert.deepEqual(written.buckets.get(bucket), entry);
      assert.ok(
        fs
          .readFileSync(path.join(dir, `columns-${bucket}.bin`))
          .equals(fs.readFileSync(path.join(dir, `objects-${bucket}.bin`))),
        `bucket ${bucket}`,
      );
    }
    assert.ok(
      fs
        .readFileSync(path.join(dir, 'columns-overview.bin'))
        .equals(fs.readFileSync(path.join(dir, 'objects-overview.bin'))),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
