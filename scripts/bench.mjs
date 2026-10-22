// Personal fork: wall-clock budgets out of `npm test`'s pass/fail.
// Not part of upstream God's Eye View.
//
// A test that times its own work asserts the result with withinBudget(): in
// `npm test` the budget is only reported, since a loaded machine (another
// suite, a build, an import) misses it with nothing wrong; `npm run bench`
// (GEV_BENCH=1) runs those files one at a time and fails on a miss. The
// correctness assertions around the timing run in both.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverUnitTestFiles } from './run-unit-tests.mjs';

export const BENCH_ENV = 'GEV_BENCH';
export const benchEnabled = (env = process.env) => env[BENCH_ENV] === '1';

/**
 * Assert `ms < budgetMs` under `npm run bench`; otherwise only report it.
 * @param {number} ms
 * @param {number} budgetMs
 * @param {string} [message]
 * @param {{ env?: object, report?: (line: string) => void }} [options]
 * @returns {boolean} whether the budget held
 */
export function withinBudget(
  ms,
  budgetMs,
  message = '',
  {
    env = process.env,
    report = (line) => process.stderr.write(`[bench] ${line}\n`),
  } = {},
) {
  const held = ms < budgetMs;
  const line = `${Math.round(ms)} ms of ${Math.round(budgetMs)} ms${message ? `: ${message}` : ''}`;
  if (benchEnabled(env)) assert.ok(held, line);
  else if (!held)
    report(`over budget (not a failure outside npm run bench): ${line}`);
  return held;
}

/** The unit test files that hold a wall-clock budget. */
export function discoverBenchFiles(root = process.cwd(), read = readFileSync) {
  return discoverUnitTestFiles(root).filter((file) =>
    /\bwithinBudget\(/.test(read(path.join(root, file), 'utf8')),
  );
}

export function runBench(root = process.cwd()) {
  const files = discoverBenchFiles(root);
  if (!files.length) {
    console.error('[bench] no test file calls withinBudget()');
    return 1;
  }
  console.log(`[bench] ${files.length} files, one at a time`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, [BENCH_ENV]: '1' },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = runBench();
