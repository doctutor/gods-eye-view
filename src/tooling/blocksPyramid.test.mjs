// Personal fork: the Blocks pyramid warm-up (scripts/blocks-pyramid.mjs):
// its arguments, the lattice tiles it asks (the Blocks source's boxes),
// the count and budget checks, and the run with a stand-in service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REQUESTS,
  landRequests,
  main,
  parseArgs,
  planRequests,
  serverService,
} from '../../scripts/blocks-pyramid.mjs';
import { encodeRasterValues } from '../data/rasterValues.js';
import {
  LATTICE_CELLS,
  latticeBox,
  latticeCells,
  latticeIndex,
} from '../layers/blocks/lattice.js';

const ARGS = ['--bbox', '-80,36,-74,41', '--levels', '1920,7680'];

test('parseArgs: the box, pyramid levels coarsest first, the pace; errors said', () => {
  const args = parseArgs([...ARGS, '--pace', '100']);
  assert.deepEqual(args.bbox, { west: -80, south: 36, east: -74, north: 41 });
  assert.deepEqual(args.levels, [7680, 1920]);
  assert.equal(args.paceMs, 100);
  assert.equal(args.dryRun, false);
  assert.equal(parseArgs([...ARGS, '--dry-run']).dryRun, true);
  assert.match(parseArgs(['--levels', '1920']).error, /--bbox/);
  assert.match(
    parseArgs(['--bbox', '10,0,5,1', '--levels', '1920']).error,
    /west < east/,
  );
  assert.match(parseArgs(['--bbox', '-80,36,-74,41']).error, /--levels/);
  assert.match(
    parseArgs(['--bbox', '-80,36,-74,41', '--levels', '1000']).error,
    /not 1000/,
  );
});

test('planRequests: the lattice tiles over the box, the boxes the Blocks source asks', () => {
  const requests = planRequests(
    { west: -80, south: 36, east: -74, north: 41 },
    [1920],
  );
  // 1,920 m tiles are 256 cells, 4.42° a side: the box lies in two or
  // three each way.
  assert.ok(requests.length >= 4 && requests.length <= 9);
  for (const { level, query } of requests) {
    assert.equal(level, 1920);
    assert.equal(query.layer, 'ee-elevation');
    assert.equal(query.cells, String(latticeCells(1920)));
    assert.equal(query.cells, String(LATTICE_CELLS / 2));
    // With the water plane, as the Blocks source asks a coarse level.
    assert.equal(query.water, '1');
    const { ti, tj } = latticeIndex(
      1920,
      (Number(query.west) + Number(query.east)) / 2,
      (Number(query.south) + Number(query.north)) / 2,
    );
    const box = latticeBox(1920, ti, tj);
    assert.equal(query.west, String(box.west));
    assert.equal(query.north, String(box.north));
  }
});

test('main: counts first, stops past MAX_REQUESTS or the day, asks each in turn, a 429 stops', async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  // A continent at 120 m is far too many.
  assert.equal(
    await main({
      argv: ['--bbox', '-125,25,-66,49', '--levels', '120'],
      log,
      service: { values: () => assert.fail('asked') },
    }),
    1,
  );
  assert.match(lines.at(-1), new RegExp(`more than ${MAX_REQUESTS}`));
  // A dry run asks nothing.
  assert.equal(
    await main({
      argv: [...ARGS, '--dry-run'],
      log,
      service: { values: () => assert.fail('asked') },
    }),
    0,
  );
  const count = planRequests(parseArgs(ARGS).bbox, [7680, 1920]).length;
  // More than the day has left: stopped.
  let closed = 0;
  assert.equal(
    await main({
      argv: ARGS,
      log,
      service: { values: () => assert.fail('asked'), close: () => closed++ },
      budget: () => ({ dailyTiles: 20000, total: 20000 - count + 1 }),
    }),
    1,
  );
  assert.equal(closed, 1);
  // A run: one at a time, paced after each fresh tile only.
  const asked = [];
  const slept = [];
  assert.equal(
    await main({
      argv: [...ARGS, '--pace', '7'],
      log,
      service: {
        values: async (query) => {
          asked.push(query);
          return { status: 200, cached: asked.length === 1 };
        },
      },
      budget: () => ({ dailyTiles: 20000, total: 0 }),
      sleep: async (ms) => slept.push(ms),
    }),
    0,
  );
  assert.equal(asked.length, count);
  assert.ok(slept.every((ms) => ms === 7));
  assert.ok(slept.length <= count - 1);
  // A 429 stops the run.
  let n = 0;
  assert.equal(
    await main({
      argv: ARGS,
      log,
      service: { values: async () => ({ status: n++ ? 429 : 200 }) },
      budget: () => ({ dailyTiles: 20000, total: 0 }),
      sleep: async () => {},
    }),
    1,
  );
  assert.equal(n, 2);
  assert.match(lines.at(-1), /budget is used/);
});

test('parseArgs: --concurrency 1 to 4 (1 by default), --server an origin, --land-only', () => {
  const plain = parseArgs(ARGS);
  assert.equal(plain.concurrency, 1);
  assert.equal(plain.server, undefined);
  assert.equal(plain.landOnly, false);
  const args = parseArgs([
    ...ARGS,
    '--concurrency',
    '2',
    '--server',
    'http://localhost:4173',
    '--land-only',
  ]);
  assert.equal(args.concurrency, 2);
  assert.equal(args.server, 'http://localhost:4173');
  assert.equal(args.landOnly, true);
  assert.match(parseArgs([...ARGS, '--concurrency', '5']).error, /1 to 4/);
  assert.match(parseArgs([...ARGS, '--concurrency', '0']).error, /1 to 4/);
  assert.match(
    parseArgs([...ARGS, '--server', 'localhost:4173']).error,
    /origin/,
  );
  assert.match(
    parseArgs([...ARGS, '--server', 'http://localhost:4173/api']).error,
    /origin/,
  );
});

test('main: --concurrency 2 keeps two in flight, asks each once; ten failures in the last forty stop it', async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const count = planRequests(parseArgs(ARGS).bbox, [7680, 1920]).length;
  const asked = new Set();
  let inFlight = 0;
  let most = 0;
  assert.equal(
    await main({
      argv: [...ARGS, '--concurrency', '2'],
      log,
      service: {
        values: async (query) => {
          asked.add(JSON.stringify(query));
          most = Math.max(most, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight--;
          return { status: 200, cached: false };
        },
      },
      budget: () => ({ dailyTiles: 20000, total: 0 }),
      sleep: async () => {},
    }),
    0,
  );
  assert.equal(asked.size, count);
  assert.equal(most, 2);
  assert.match(lines.at(-1), new RegExp(`^done: ${count} asked`));
  // Every answer a 503: stopped once ten have failed, not the whole plan.
  const many = ['--bbox', '-80,36,-74,41', '--levels', '480'];
  const planned = planRequests(parseArgs(many).bbox, [480]).length;
  assert.ok(planned > 20);
  let calls = 0;
  assert.equal(
    await main({
      argv: [...many, '--concurrency', '2'],
      log,
      service: {
        values: async () => {
          calls++;
          return { status: 503, error: 'no answer' };
        },
      },
      budget: () => ({ dailyTiles: 20000, total: 0 }),
      sleep: async () => {},
    }),
    1,
  );
  assert.ok(calls >= 10 && calls <= 11, String(calls));
  assert.match(lines.at(-1), /10 of the last 10 answers failed: stopped/);
});

test('serverService: GETs the values and the budget; X-Raster-Values-Cache, else a quick answer, says cached', async () => {
  const urls = [];
  let header = 'hit';
  let clock = 0;
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith('/api/earth-engine/budget'))
      return Response.json({ dailyTiles: 20000, total: 7 });
    if (url.includes('cells=0'))
      return Response.json({ error: 'Bad cells' }, { status: 400 });
    if (url.includes('cells=1&')) throw new Error('fetch failed');
    clock += header ? 10 : 5000;
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: header ? { 'x-raster-values-cache': header } : {},
    });
  };
  const remote = serverService('http://localhost:4173', fetchImpl, () => clock);
  const query = { layer: 'ee-elevation', mode: '', cells: '256', water: '1' };
  const hit = await remote.values(query);
  assert.equal(hit.status, 200);
  assert.equal(hit.cached, true);
  assert.equal(hit.body.length, 3);
  assert.match(urls[0], /^http:\/\/localhost:4173\/api\/raster\/values\?/);
  assert.match(urls[0], /water=1/);
  header = 'miss';
  assert.equal((await remote.values(query)).cached, false);
  // No header: answered in 5 s is fresh, not the cache's.
  header = null;
  assert.equal((await remote.values(query)).cached, false);
  assert.deepEqual(await remote.values({ ...query, cells: '0' }), {
    status: 400,
    error: 'Bad cells',
  });
  const lost = await remote.values({ ...query, cells: '1' });
  assert.equal(lost.status, 0);
  assert.match(lost.error, /fetch failed/);
  assert.deepEqual(await remote.budget(), { dailyTiles: 20000, total: 7 });
});

test('--land-only: a 120 m tile is skipped when the 480 m tiles under it are all sea, kept with any land or when they cannot be read', async () => {
  // Land (100 m) west of 77° W, sea (0 m) east of it, in every 480 m tile.
  const COAST = -77;
  const tile480 = (query) => {
    const header = {
      west: Number(query.west),
      south: Number(query.south),
      east: Number(query.east),
      north: Number(query.north),
      cols: 256,
      rows: 256,
    };
    const values = new Float32Array(256 * 256);
    for (let c = 0; c < 256; c++) {
      const lon = header.west + ((c + 0.5) / 256) * (header.east - header.west);
      for (let r = 0; r < 256; r++) values[r * 256 + c] = lon < COAST ? 100 : 0;
    }
    return { header, values };
  };
  const requests = planRequests(
    { west: -80, south: 36, east: -74, north: 41 },
    [480, 120],
  );
  const asked = [];
  const {
    kept,
    skipped,
    asked: read,
  } = await landRequests(requests, async (query) => {
    asked.push(query);
    assert.equal(Number(query.cells), latticeCells(480));
    return tile480(query);
  });
  // Each 480 m tile read once; every 480 m request kept.
  assert.equal(new Set(asked.map((q) => JSON.stringify(q))).size, asked.length);
  assert.equal(read, asked.length);
  const at480 = requests.filter((r) => r.level === 480).length;
  assert.equal(kept.filter((r) => r.level === 480).length, at480);
  const fine = requests.filter((r) => r.level === 120);
  assert.equal(kept.length + skipped, requests.length);
  assert.ok(skipped > 0 && skipped < fine.length);
  for (const r of fine) {
    const west = Number(r.query.west);
    const east = Number(r.query.east);
    const isKept = kept.includes(r);
    if (east < COAST) assert.ok(isKept, `land at ${west}`);
    if (west > COAST + 0.01) assert.ok(!isKept, `sea at ${west}`);
  }
  // A 480 m tile that cannot be read keeps the tiles over it.
  const unread = await landRequests(requests, async () => null);
  assert.equal(unread.kept.length, requests.length);
  assert.equal(unread.skipped, 0);
});

test('main --land-only: filters before the count, needs a service, and a dry run says what is left', async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const argv = ['--bbox', '-80,36,-74,41', '--levels', '120', '--land-only'];
  assert.equal(await main({ argv, log }), 2);
  assert.match(lines.at(-1), /--land-only needs --server/);
  // All sea: everything skipped, nothing left to ask.
  const sea = {
    values: async (query) => ({
      status: 200,
      cached: true,
      body: encodeRasterValues(
        {
          layer: 'ee-elevation',
          mode: '',
          cols: 2,
          rows: 2,
          west: Number(query.west),
          south: Number(query.south),
          east: Number(query.east),
          north: Number(query.north),
        },
        new Float32Array(4),
      ),
    }),
  };
  assert.equal(
    await main({ argv: [...argv, '--dry-run'], log, service: sea }),
    0,
  );
  assert.match(lines.at(-1), /all-sea tiles skipped .* 0 left/);
});
