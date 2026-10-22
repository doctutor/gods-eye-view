// The loop runner: repro.mjs in PARALLEL processes at a time for ROUNDS
// rounds, with BURN busy threads beside them (the crash is rare on an
// idle machine), and the processes that did not exit 0, by exit code.
//
//   node run.mjs [variant] [cycles] [rounds] [parallel] [burn] [-- node flags…]
//   node run.mjs receiver 50 8 32 p16
//   node run.mjs receiver 50 8 32 p16 -- --no-wasm-tier-up
//
// `burn` is busy threads in this process (16), or in a separate process
// (p16), which reproduces the crash more often here.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const flags = dash >= 0 ? argv.slice(dash + 1) : [];
const [
  variant = 'inline',
  cycles = '50',
  rounds = '8',
  parallel = '32',
  burn = String(os.availableParallelism()),
] = dash >= 0 ? argv.slice(0, dash) : argv;
const here = path.dirname(fileURLToPath(import.meta.url));

// Load: busy threads, here or in a process of their own, for the run.
const external = String(burn).startsWith('p');
const threads = Number(String(burn).replace(/^p/, ''));
const spinner = `const { parentPort } = require('node:worker_threads');
       let stop = false, x = 0;
       parentPort?.on('message', () => (stop = true));
       (function spin() {
         const until = Date.now() + 50;
         while (Date.now() < until) x += Math.sqrt(x + 1);
         if (!stop) setImmediate(spin);
       })();`;
const burnerProcess = external
  ? spawn(
      process.execPath,
      [
        '-e',
        `const { Worker } = require('node:worker_threads');
         for (let i = 0; i < ${threads}; i++) new Worker(${JSON.stringify(spinner)}, { eval: true });`,
      ],
      { stdio: 'ignore' },
    )
  : null;
const burners = Array.from(
  { length: external ? 0 : threads },
  () =>
    new Worker(
      `const { parentPort } = require('node:worker_threads');
       let stop = false, x = 0;
       parentPort.on('message', () => (stop = true));
       (function spin() {
         const until = Date.now() + 50;
         while (Date.now() < until) x += Math.sqrt(x + 1);
         if (!stop) setImmediate(spin);
       })();`,
      { eval: true },
    ),
);

const run = () =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...flags, path.join(here, 'repro.mjs'), variant, cycles],
      { stdio: ['ignore', 'ignore', 'pipe'], cwd: here },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });

const started = Date.now();
const failed = {};
for (let r = 0; r < Number(rounds); r++)
  for (const { code, signal, stderr } of await Promise.all(
    Array.from({ length: Number(parallel) }, run),
  ))
    if (code !== 0) {
      const key =
        code === null
          ? `signal ${signal}`
          : `${code} (0x${(code >>> 0).toString(16).toUpperCase()})`;
      failed[key] = (failed[key] || 0) + 1;
      if (stderr.trim()) console.error(stderr.trim().slice(0, 400));
    }
for (const burner of burners) burner.terminate();
burnerProcess?.kill();
console.log(
  JSON.stringify({
    variant,
    flags: flags.join(' '),
    burn,
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.availableParallelism(),
    processes: Number(rounds) * Number(parallel),
    cycles: Number(rounds) * Number(parallel) * Number(cycles),
    failed,
    seconds: Math.round((Date.now() - started) / 1000),
  }),
);
