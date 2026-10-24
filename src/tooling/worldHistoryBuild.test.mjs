// Personal fork: the World history build (scripts/worldHistory/) on a mini
// Cliopatria: records at three levels, the year index, each polity's
// largest record, BCE years and no year 0, Cottereau's spans and modes,
// the atomic switch-over and status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LODS,
  bucketOf,
  buildWorldHistory,
  readCurrent,
  simplifyPolygons,
  worldHistoryStatus,
} from '../../scripts/worldHistory/build.mjs';
import { cottereauSpans } from '../../scripts/worldHistory/cottereau.mjs';
import { parseArgs } from '../../scripts/worldHistory/index.mjs';
import {
  FIXTURE_MATCHES,
  FIXTURE_TRACKS,
  writeFixture,
} from '../../scripts/worldHistory/testFixture.mjs';
import {
  createWorldHistoryIndex,
  yearPolities,
} from '../../server/providers/worldHistory/index.js';
import { decodePolygons } from '../../src/data/worldHistory.js';

function fixtureBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-world-history-'));
  const inputs = writeFixture(path.join(root, 'in'));
  return { root, inputs, dir: path.join(root, 'out') };
}

test('the build: records at every level, polities and their largest, a year index, a switch-over', async () => {
  const { root, inputs, dir } = fixtureBuild();
  try {
    const lines = [];
    const manifest = await buildWorldHistory({
      ...inputs,
      dir,
      log: (line) => lines.push(line),
      now: () => new Date('2026-10-23T00:00:00Z'),
    });
    assert.equal(manifest.records, 6);
    assert.equal(manifest.polities, 4);
    assert.equal(manifest.lods.length, LODS.length);
    assert.equal(manifest.source.vertices, 40);
    const current = readCurrent(dir);
    assert.equal(current.id, manifest.id);
    const index = JSON.parse(
      fs.readFileSync(path.join(dir, manifest.index), 'utf8'),
    );
    const alpha = index.polities.find((p) => p.name === 'Alpha Kingdom');
    assert.deepEqual(alpha.records, [0, 1, 2]);
    assert.equal(alpha.max, 1, 'the largest by Area');
    assert.equal(alpha.from, -600);
    assert.equal(alpha.to, 200);
    assert.equal(index.records[1].type, 'polity');
    assert.equal(index.records[4].type, 'relation');
    // Each level's text decodes to the record's polygons, hole and all.
    const fd = fs.openSync(path.join(dir, manifest.lods[2].file), 'r');
    const [offset, length] = index.records[3].geom[2];
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    const beta = decodePolygons(buffer.toString('utf8'));
    assert.equal(beta.length, 1);
    assert.equal(beta[0].length, 2, 'the hole');
    assert.deepEqual(index.records[3].box, [30, 30, 35, 35]);
    assert.ok(index.records[3].label, 'a label point');
    // The year index: a record is in every bucket its years touch.
    for (const [i, r] of index.records.entries())
      for (let b = bucketOf(r.from); b <= bucketOf(r.to); b++)
        assert.ok(index.buckets[b].includes(i));
    // Unchanged inputs: nothing done; forced: a new build, the old files gone.
    const again = await buildWorldHistory({ ...inputs, dir });
    assert.equal(again.skipped, true);
    fs.utimesSync(inputs.matches, new Date(), new Date(Date.now() + 5000));
    const next = await buildWorldHistory({ ...inputs, dir });
    assert.notEqual(next.id, manifest.id);
    const files = fs.readdirSync(dir);
    assert.ok(
      !files.some((f) => f.includes(manifest.id)),
      'the old build removed',
    );
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
    const status = worldHistoryStatus(dir);
    assert.equal(status.built, true);
    assert.equal(status.id, next.id);
    assert.deepEqual(worldHistoryStatus(path.join(root, 'none')), {
      dir: path.join(root, 'none'),
      built: false,
    });
    assert.ok(lines.some((line) => /6 records, 4 polities/.test(line)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('years: BCE negative, no year 0, Cliopatria to 2024; Cottereau mode and All', async () => {
  const { root, inputs, dir } = fixtureBuild();
  try {
    await buildWorldHistory({ ...inputs, dir });
    const history = createWorldHistoryIndex({ dir });
    assert.equal(history.status().built, true);
    // The loaded index the routes use.
    const year = (y, options) => JSON.parse(history.year(y, options));
    const names = (y, options) => year(y, options).polities.map((p) => p.title);

    assert.deepEqual(names(-450, { mode: 'all' }), ['Alpha Kingdom']);
    assert.equal(
      year(-450, { mode: 'all' }).polities[0].area,
      1000,
      '600–301 BC record',
    );
    assert.equal(year(-300, { mode: 'all' }).polities[0].area, 5000);
    assert.equal(
      year(-1, { mode: 'all' }).polities[0].area,
      5000,
      '1 BC is in the record ending at "0"',
    );
    assert.equal(
      year(1, { mode: 'all' }).polities[0].area,
      3000,
      '1 AD is the next one',
    );
    assert.deepEqual(
      names(120, { mode: 'all' }),
      ['Beta Empire', 'Alpha Kingdom'],
      'largest first, RELATION left out',
    );

    // Cottereau: his labels, his years.
    assert.deepEqual(names(-450), ['Alpha'], 'labelled as Cottereau names it');
    assert.equal(year(-450).polities[0].name, 'Alpha Kingdom');
    assert.deepEqual(
      year(-450).polities[0].at,
      [11.2, 41.1],
      'where the video set the label',
    );
    assert.deepEqual(
      names(-8),
      ['Alpha'],
      'the period runs on to the next one',
    );
    assert.deepEqual(names(20), [], 'a period without a polity');
    assert.deepEqual(names(-550), [], 'before his track');
    assert.deepEqual(names(250), ['Beta']);
    assert.deepEqual(
      names(250, { places: true }),
      ['Beta'],
      'the better match keeps the label',
    );
    assert.deepEqual(names(475), ['Beta'], 'to the track’s last year');
    // 2025 shows Cliopatria's 2024.
    const late = year(2025);
    assert.equal(late.cliopatriaYear, 2024);
    assert.deepEqual(
      late.polities.map((p) => p.title),
      ['Gamma'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cottereau spans: name matches keep his label, place-only ones Cliopatria’s; the low ones on request', () => {
  const spans = cottereauSpans(FIXTURE_MATCHES, FIXTURE_TRACKS);
  assert.deepEqual(
    spans.map((s) => [s.label, s.name, s.from, s.to, s.confidence, s.byName]),
    [
      ['Alpha', 'Alpha Kingdom', -500, -6, 'high', true],
      ['Beta', 'Beta Empire', 120, 480, 'medium', true],
      ['Beta Empire', 'Beta Empire', 200, 300, 'low', false],
      ['Gamma', 'Gamma Republic', 1990, 2025, 'high', true],
    ],
  );
  const index = {
    records: [{ name: 'Beta Empire', from: 100, to: 500, area: 9000 }],
    byName: new Map([['Beta Empire', { name: 'Beta Empire', records: [0] }]]),
    spans: spans.filter((s) => s.confidence === 'low'),
    buckets: [],
    yearOrigin: -3400,
    yearBucket: 50,
    lastYear: 2024,
  };
  assert.deepEqual(yearPolities(index, 250), [], 'place-only off by default');
  assert.deepEqual(
    yearPolities(index, 250, { places: true }).map((p) => [
      p.label,
      p.confidence,
    ]),
    [['Beta Empire', 'low']],
  );
});

test('simplification keeps something of every record; the CLI parses its flags', () => {
  const tiny = [
    [
      [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [0, 0],
      ],
    ],
  ];
  assert.equal(simplifyPolygons(tiny, 0.25).length, 1, 'the largest stays');
  const big = [
    [
      [
        [0, 0],
        [5, 0],
        [5, 0.001],
        [5, 5],
        [0, 5],
        [0, 0],
      ],
    ],
  ];
  assert.equal(
    simplifyPolygons(big, 0.25)[0][0].length,
    5,
    'a near-straight corner goes',
  );
  assert.deepEqual(parseArgs(['build', '--file', 'x.zip', '--force']), {
    command: 'build',
    file: 'x.zip',
    force: true,
  });
  assert.throws(() => parseArgs(['make']), /unknown command/);
  assert.throws(() => parseArgs(['status', '--fast']), /unknown option/);
});
