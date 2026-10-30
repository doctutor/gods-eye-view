// Personal fork: the Blocks pyramid warm-up (scripts/blocks-pyramid.mjs):
// its arguments, the lattice tiles it asks (the Blocks source's boxes),
// the count and budget checks, and the run with a stand-in service.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REQUESTS,
  main,
  parseArgs,
  planRequests,
} from '../../scripts/blocks-pyramid.mjs';
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
