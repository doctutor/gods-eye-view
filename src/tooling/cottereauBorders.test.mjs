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
  insideRepository,
  qualityReport,
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
