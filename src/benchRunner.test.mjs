// Personal fork: the wall-clock budgets `npm test` reports and `npm run bench`
// enforces (scripts/bench.mjs). Not part of upstream God's Eye View.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  BENCH_ENV,
  benchEnabled,
  discoverBenchFiles,
  withinBudget,
} from '../scripts/bench.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('a missed budget is reported in npm test and fails only under bench', () => {
  const lines = [];
  const report = (line) => lines.push(line);
  assert.equal(withinBudget(50, 100, 'fast', { env: {}, report }), true);
  assert.equal(withinBudget(150, 100, 'slow', { env: {}, report }), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /150 ms of 100 ms: slow/);

  const bench = { env: { [BENCH_ENV]: '1' }, report };
  assert.equal(withinBudget(50, 100, 'fast', bench), true);
  assert.throws(
    () => withinBudget(150, 100, 'slow', bench),
    /150 ms of 100 ms: slow/,
  );
  assert.equal(
    benchEnabled({ [BENCH_ENV]: 'true' }),
    false,
    'only 1 turns it on',
  );
});

test('npm run bench finds the tests that time their own work', () => {
  const files = discoverBenchFiles(repositoryRoot);
  for (const file of [
    'src/data/analystEngine.test.mjs',
    'src/data/cctvDedupe.test.mjs',
    'src/layers/streetLevel/providers/kartaview/decode.test.mjs',
    'src/layers/streetLevel/providers/panoramax/policy.test.mjs',
    'src/tools/tool-schema-codepoints.test.mjs',
  ])
    assert.ok(files.includes(file), file);
  assert.equal(files.includes('src/unitTestRunner.test.mjs'), false);
});
