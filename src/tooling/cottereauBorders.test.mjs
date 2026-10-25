// Personal fork: Cottereau's borders, a PRIVATE layer (personal use only):
// the year lookup and the years each sample covers, the extraction refusing
// to write inside the repository, the quality report, the route absent
// without COTTEREAU_BORDERS_DIR and serving with it, a guard that no
// extracted file is ever tracked, and the extractor's own tests (Python, on
// synthetic frames) when its environment is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  carriesOver,
  cliopatriaPixels,
  extractorVersion,
  insideRepository,
  manifestSamples,
  maxClaim,
  placeOnlyPairs,
  polygonsPixels,
  printReport,
  qualityReport,
  reuseSamples,
  sampleForYear,
  withSpans,
} from '../../scripts/cottereau/borders.mjs';
import {
  cottereauBordersDir,
  cottereauBordersProxy,
  createCottereauBordersHandler,
  createCottereauBordersService,
} from '../../server/providers/cottereauBorders.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('a year shows the latest sample at or before it; each sample covers the years to the next', () => {
  const samples = withSpans(
    [
      { index: 0, year: -2500 },
      { index: 1, year: -2496 },
      { index: 2, year: -2496 },
      { index: 3, year: 800 },
    ],
    2025,
  );
  assert.deepEqual(
    samples.map((s) => s.untilYear),
    [-2497, -2496, 799, 2025],
  );
  assert.equal(sampleForYear(samples, -2501), null);
  assert.equal(sampleForYear(samples, -2500).index, 0);
  assert.equal(sampleForYear(samples, -2497).index, 0);
  assert.equal(sampleForYear(samples, -2496).index, 2, 'the last of a year');
  assert.equal(sampleForYear(samples, 799).index, 2);
  assert.equal(sampleForYear(samples, 2025).index, 3);
});

test('the extraction never writes inside the repository', () => {
  assert.equal(
    insideRepository(path.join(ROOT, 'data', 'cottereau', 'borders')),
    true,
  );
  assert.equal(insideRepository(ROOT), true);
  assert.equal(insideRepository(path.join(os.tmpdir(), 'borders')), false);
  assert.equal(
    insideRepository('E:/gev-data/cottereau/borders', 'C:/repo'),
    false,
  );
});

test('the quality report: labelled shares, merged and split cases, IoU by century and the worst', () => {
  const sample = (year, labelled, polygons) => ({
    year,
    stats: { landPx: 1000, unclaimedPx: 200, labelledPx: labelled },
    unlabelled: [{ colour: '#ff0000', areaKm2: 50, lon: 1, lat: 2 }],
    polygons,
  });
  const report = qualityReport([
    sample(-550, 700, [
      {
        track: 1,
        label: 'Persia',
        cliopatria: 'Achaemenid Empire',
        flags: [],
        regions: 1,
        iou: 0.8,
        areaKm2: 3000,
      },
      {
        track: 2,
        label: 'Lydia',
        cliopatria: 'Lydia',
        flags: ['split'],
        regions: 1,
        iou: 0.1,
        areaKm2: 100,
      },
    ]),
    sample(-520, 800, [
      {
        track: 1,
        label: 'Persia',
        cliopatria: 'Achaemenid Empire',
        flags: ['joined'],
        regions: 2,
        iou: 0.9,
        areaKm2: 4000,
      },
    ]),
  ]);
  assert.equal(report.perCentury.length, 1);
  const c = report.perCentury[0];
  assert.equal(c.century, -6);
  assert.equal(c.labelledOfClaimed, Math.round((1000 * 1500) / 1600) / 1000);
  assert.equal(c.iou.n, 3);
  assert.equal(c.iou.median, 0.8);
  assert.ok(c.iouByArea > 0.8, 'the large polity counts for more');
  assert.equal(report.merged.split, 1);
  assert.equal(report.merged.joined, 1);
  assert.equal(report.unlabelled.count, 2);
  assert.deepEqual(report.iou.worst[0], {
    year: -550,
    track: 2,
    label: 'Lydia',
    cliopatria: 'Lydia',
    iou: 0.1,
    areaKm2: 100,
  });
  // Without matches, every pair is in the summary.
  assert.equal(report.placeOnly.count, 0);
  assert.equal(report.iouAll.count, 3);
});

test('the quality report keeps the place-only pairs apart from the IoU summary', () => {
  const placeOnly = placeOnlyPairs([
    {
      track: 1,
      confidence: 'high',
      reason: 'name+place',
      periods: [
        { name: 'Achaemenid Empire', from: -550, to: -330, reason: 'name' },
        { name: 'Macedonia', from: -329, to: -320, reason: 'place' },
      ],
    },
    {
      track: 2,
      confidence: 'low',
      reason: 'place+time+size',
      periods: [
        { name: 'Lydia', from: -560, to: -547, reason: 'main match' },
        { name: 'Lydian Kingdom', from: -546, to: -540, reason: 'name' },
      ],
    },
  ]);
  assert.equal(placeOnly(1, -500, 'Achaemenid Empire'), false, 'by name');
  assert.equal(placeOnly(1, -325, 'Macedonia'), true, 'a place period');
  assert.equal(placeOnly(2, -550, 'Lydia'), true, 'a low match by place');
  assert.equal(
    placeOnly(2, -545, 'Lydian Kingdom'),
    false,
    "a low match's name period",
  );
  assert.equal(placeOnly(9, -545, 'Elam'), false, 'no match: kept');
  const pair = (track, cliopatria, iou, areaKm2) => ({
    track,
    label: cliopatria,
    cliopatria,
    flags: [],
    regions: 1,
    iou,
    areaKm2,
  });
  const report = qualityReport(
    [
      {
        year: -550,
        stats: { landPx: 1000, unclaimedPx: 0, labelledPx: 900 },
        unlabelled: [],
        polygons: [
          pair(1, 'Achaemenid Empire', 0.8, 3000),
          pair(2, 'Lydia', 0, 500),
        ],
      },
      {
        year: -325,
        stats: { landPx: 1000, unclaimedPx: 0, labelledPx: 900 },
        unlabelled: [],
        polygons: [pair(1, 'Macedonia', 0.2, 1000)],
      },
    ],
    { placeOnly },
  );
  assert.equal(report.iou.count, 1);
  assert.equal(report.iou.median, 0.8);
  assert.equal(report.iou.byArea, 0.8);
  assert.deepEqual(
    report.iou.worst.map((w) => w.cliopatria),
    ['Achaemenid Empire'],
  );
  assert.equal(report.placeOnly.count, 2);
  assert.deepEqual(
    report.placeOnly.worst.map((w) => w.cliopatria),
    ['Lydia', 'Macedonia'],
  );
  assert.equal(report.placeOnly.byArea, Math.round((1000 * 200) / 1500) / 1000);
  assert.equal(report.iouAll.count, 3);
  assert.equal(report.iouAll.byArea, Math.round((1000 * 2600) / 4500) / 1000);
  const [bc6, bc4] = report.perCentury;
  assert.deepEqual([bc6.iou.n, bc6.placeOnly.n], [1, 1]);
  assert.deepEqual([bc4.iou.n, bc4.placeOnly.n, bc4.iouByArea], [0, 1, null]);
  // The printed report gives both, and a manifest from before gives one.
  const lines = [];
  printReport(
    { complete: true, counts: { samples: 2, polities: 3 }, quality: report },
    (line) => lines.push(line),
  );
  const text = lines.join('\n');
  assert.match(
    text,
    /matched by name or abbreviation: median 0\.8, by area 0\.8, over 1/,
  );
  assert.match(
    text,
    /place-only pairs \(low confidence, not in the summary\): median 0\.2.*over 2/,
  );
  assert.match(text, /every pair: .*over 3/);
  assert.match(
    text,
    /largest place-only disagreements[^\n]*\n {4}-550 Lydia ↔ Lydia: IoU 0/,
  );
  const before = [];
  const { placeOnly: _apart, iouAll: _all, ...old } = report;
  printReport(
    { complete: true, counts: { samples: 2, polities: 3 }, quality: old },
    (line) => before.push(line),
  );
  assert.match(
    before.join('\n'),
    /IoU with Cliopatria, every pair: median 0\.8/,
  );
});

test('no extracted border is ever tracked: only the code and its tests', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).split('\n');
  } catch {
    return; // not a git checkout
  }
  const forbidden = tracked.filter(
    (file) =>
      /(^|\/)samples\/\d{4}\.json\.gz$/.test(file) ||
      /cliopatria\.f64$/.test(file) ||
      /(^|\/)borders\/(builds|current\.json)/.test(file) ||
      /^data\/cottereau\/borders/.test(file) ||
      /^\.gev-cache\/cottereau\//.test(file) ||
      (/cottereau/i.test(file) &&
        /\.(png|jpe?g|webp|gif|bmp|tiff?|webm|mp4)$/i.test(file)),
  );
  assert.deepEqual(forbidden, []);
  // data/cottereau holds the derived facts only.
  assert.deepEqual(
    tracked.filter((f) => f.startsWith('data/cottereau/')).sort(),
    [
      'data/cottereau/framings.json',
      'data/cottereau/matches.json',
      'data/cottereau/review.md',
      'data/cottereau/tracks.json',
    ],
  );
  // And git ignores where a build could land inside the repository.
  const ignored = (p) =>
    spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT }).status === 0;
  for (const p of [
    'data/cottereau/borders/current.json',
    '.gev-cache/cottereau/borders/x',
    'anywhere/samples/0001.json.gz',
    'anywhere/cliopatria.f64',
  ])
    assert.ok(ignored(p), `${p} is ignored`);
});

/** A build directory as borders.mjs writes it, with two samples. */
function fakeBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-borders-'));
  const build = 'abcdef123456';
  fs.mkdirSync(path.join(dir, 'builds', build, 'samples'), { recursive: true });
  const write = (index, year) => {
    const body = {
      index,
      year,
      polygons: [{ track: 1, label: 'Egypt', polygons: [] }],
    };
    fs.writeFileSync(
      path.join(
        dir,
        'builds',
        build,
        'samples',
        `${String(index).padStart(4, '0')}.json.gz`,
      ),
      zlib.gzipSync(JSON.stringify(body)),
    );
  };
  write(0, -2500);
  write(1, -2400);
  fs.writeFileSync(
    path.join(dir, 'builds', build, 'manifest.json'),
    JSON.stringify({
      buildId: build,
      builtAt: '2026-10-23T00:00:00Z',
      complete: false,
      samples: withSpans(
        [
          { index: 0, year: -2500, file: 'samples/0000.json.gz' },
          { index: 1, year: -2400, file: 'samples/0001.json.gz' },
        ],
        -2301,
      ),
      counts: { samples: 2 },
      framings: [],
      quality: {
        perCentury: [],
        iou: { count: 0, median: null, byArea: null },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ build }));
  return dir;
}

function call(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = body;
        resolve(this);
      },
    };
    handler(
      {
        url,
        method: 'GET',
        headers: { host: 'localhost:5173', ...headers },
        socket: {},
      },
      res,
      () => resolve({ ...res, statusCode: 'next' }),
    );
  });
}

test('the route is absent without COTTEREAU_BORDERS_DIR, and serves the build with it', async () => {
  assert.equal(cottereauBordersDir({}), null);
  const installed = [];
  const middlewares = { use: (...args) => installed.push(args) };
  cottereauBordersProxy({ env: {} }).configureServer({ middlewares });
  assert.equal(installed.length, 0, 'no route at all');
  const dir = fakeBuild();
  try {
    cottereauBordersProxy({
      env: { COTTEREAU_BORDERS_DIR: dir },
    }).configureServer({ middlewares });
    assert.equal(installed.length, 1);
    assert.equal(installed[0][0], '/api/cottereau-borders');
    const handler = createCottereauBordersHandler({
      service: createCottereauBordersService({ dir }),
    });
    const status = await call(handler, '/status');
    assert.equal(status.statusCode, 200);
    assert.deepEqual(JSON.parse(status.body).years, [-2500, -2301]);
    const year = await call(handler, '/year/-2450', {
      'accept-encoding': 'gzip',
    });
    assert.equal(year.statusCode, 200);
    assert.equal(year.headers['content-encoding'], 'gzip');
    assert.equal(year.headers['x-sample-year'], '-2500');
    assert.equal(JSON.parse(zlib.gunzipSync(year.body)).year, -2500);
    const plain = await call(handler, '/year/-2350');
    assert.equal(JSON.parse(plain.body).year, -2400);
    const again = await call(handler, '/year/-2350', {
      'if-none-match': plain.headers.etag,
    });
    assert.equal(again.statusCode, 304);
    assert.equal(
      (await call(handler, '/year/-2600')).statusCode,
      404,
      'before the first sample',
    );
    const foreign = await call(handler, '/status', {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(foreign.statusCode, 403, 'same-site only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the extractor’s own tests on synthetic frames (Python, when its environment is there)', (t) => {
  const python =
    process.env.COTTEREAU_PYTHON ||
    'D:/gev-tools/cottereau-venv/Scripts/python.exe';
  if (!fs.existsSync(python)) return t.skip(`no ${python}`);
  const run = spawnSync(
    python,
    ['-I', path.join(ROOT, 'scripts/cottereau/test_extractBorders.py')],
    { encoding: 'utf8', timeout: 300_000 },
  );
  assert.equal(run.status, 0, run.stderr.slice(-2000));
});

test('the build is keyed on the declared extractor version; samples an older one wrote carry over where its change leaves them', () => {
  assert.equal(extractorVersion('X = 1\nEXTRACTOR_VERSION = 7\n'), 7);
  assert.throws(() => extractorVersion('nothing'), /EXTRACTOR_VERSION/);
  assert.ok(extractorVersion() >= 2);
  const map = { stats: { landPx: 4_200_000 } };
  const fade = { stats: { landPx: 7_177_800 } };
  // Version 1 (no field) to 2: maps carry over, a frame without sea does not.
  assert.equal(carriesOver(map, 2), true);
  assert.equal(carriesOver(fade, 2), false);
  assert.equal(carriesOver({ ...fade, extractor: 2 }, 2), true, 'its own');
  assert.equal(carriesOver({ ...map, extractor: 3 }, 2), false, 'a newer');
  assert.equal(carriesOver(map, 99), false, 'no rule for a later change');
  assert.equal(
    carriesOver({ ...map, extractor: 3 }, 4),
    false,
    '3 → 4 reorders every sample’s beside labels: none carries over',
  );
});

test('the manifest’s samples leave out the skipped (no map), so a year shows the last real map', () => {
  const r = (index, year, skipped) => ({
    index,
    year,
    t: index,
    framing: 1,
    polygons: [],
    unlabelled: [],
    ...(skipped ? { skipped: 'no-sea' } : {}),
  });
  const samples = manifestSamples([
    r(0, -2500, true),
    r(1, -2500),
    r(2, -2496),
    r(3, 2025),
    r(4, 2025, true),
  ]);
  assert.deepEqual(
    samples.map((s) => s.index),
    [1, 2, 3],
  );
  assert.equal(sampleForYear(samples, 2025).index, 3);
  assert.equal(sampleForYear(samples, -2500).index, 1);
  assert.equal(samples.at(-1).untilYear, 2025);
});

test('--reuse: carries the samples that stand over from a build of the same samples, marked with the version; refuses other samples', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-reuse-'));
  try {
    const prepare = (dir, samples) => {
      fs.mkdirSync(path.join(dir, 'samples'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'samples.json'),
        JSON.stringify({ samples, framings: [{ id: 1 }] }),
      );
    };
    const old = path.join(root, 'old.partial');
    const next = path.join(root, 'new.partial');
    const list = [0, 1, 2].map((index) => ({ index, year: index }));
    prepare(old, list);
    prepare(next, list);
    const write = (index, landPx) =>
      fs.writeFileSync(
        path.join(old, 'samples', `${String(index).padStart(4, '0')}.json.gz`),
        zlib.gzipSync(
          JSON.stringify({ index, stats: { landPx }, polygons: [] }),
        ),
      );
    write(0, 7_177_800); // a fade: extracted again
    write(1, 4_000_000); // a map: carried
    const carried = reuseSamples({
      from: old,
      partial: next,
      indices: [0, 1, 2],
      version: 2,
    });
    assert.deepEqual(carried, [1]);
    const copy = JSON.parse(
      zlib
        .gunzipSync(fs.readFileSync(path.join(next, 'samples', '0001.json.gz')))
        .toString('utf8'),
    );
    assert.equal(copy.extractor, 2);
    assert.equal(
      fs.existsSync(path.join(next, 'samples', '0000.json.gz')),
      false,
    );
    prepare(next, [{ index: 0, year: 5 }]);
    assert.throws(
      () =>
        reuseSamples({ from: old, partial: next, indices: [0], version: 2 }),
      /other samples/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('2 → 3: a sample whose beside or joined polity is near or over MAX_CLAIM times its matched polity is extracted again; the rest stand', () => {
  assert.equal(maxClaim('MAX_CLAIM = 6  # a note\n'), 6);
  assert.ok(maxClaim() >= 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-claim-'));
  try {
    // Cliopatria: "Small", a 1° square at 40-41° E, 40-41° N, alive 1600-1700.
    const square = [40, 40, 41, 40, 41, 41, 40, 41];
    fs.writeFileSync(
      path.join(dir, 'cliopatria.f64'),
      Buffer.from(new Float64Array(square).buffer),
    );
    fs.writeFileSync(
      path.join(dir, 'cliopatria.json'),
      JSON.stringify({
        records: [
          { name: 'Small', from: 1600, to: 1700, polygons: [[[0, 4]]] },
        ],
      }),
    );
    const framing = { id: 1, sx: 1945.8, tx: -439.4, sy: 1945.8, ty: 1952.7 };
    const cliopatria = cliopatriaPixels(dir);
    const own = cliopatria('Small', 1650, framing);
    assert.ok(own > 0);
    assert.equal(cliopatria('Small', 1800, framing), null, 'not alive');
    // A polygon the size of `side` degrees, delta-encoded at 1e-4°.
    const polity = (side, flags) => ({
      cliopatria: 'Small',
      flags,
      polygons: [[[40e4, 40e4, side * 1e4, 0, 0, side * 1e4, -side * 1e4, 0]]],
    });
    const sample = (p) => ({
      extractor: 2,
      year: 1650,
      framing: 1,
      polygons: [p],
    });
    const context = { framing, cliopatria };
    assert.ok(
      Math.abs(polygonsPixels(framing, polity(1, []).polygons) - own) <
        0.02 * own,
      'the same pixels both ways',
    );
    assert.equal(
      carriesOver(sample(polity(1.5, ['beside'])), 3, context),
      true,
    );
    assert.equal(
      carriesOver(sample(polity(3, ['beside'])), 3, context),
      false,
      '9x its polity, beside',
    );
    assert.equal(
      carriesOver(sample(polity(3, ['joined'])), 3, context),
      false,
      'or by joins',
    );
    assert.equal(
      carriesOver(sample(polity(3, [])), 3, context),
      true,
      'a label inside its region is not bounded',
    );
    assert.equal(
      carriesOver({ ...sample(polity(3, ['beside'])), year: 1800 }, 3, context),
      true,
      'no matched polity that year: no bound',
    );
    assert.equal(
      carriesOver(sample(polity(3, ['beside'])), 3, {}),
      false,
      'without the Cliopatria polygons, extracted again',
    );
    assert.equal(
      carriesOver(
        { extractor: 2, skipped: 'no-sea', polygons: [] },
        3,
        context,
      ),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
