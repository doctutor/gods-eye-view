# Node.js: access violation terminating a worker that ran WebAssembly

Personal fork of God's Eye View. These files are for a report to
github.com/nodejs/node; nothing in the application uses them. They are
kept here so the user can file the report under their own account, and
nothing has been filed.

`repro.mjs` runs worker lifecycles in one process: start a
`node:worker_threads` Worker, run a WebAssembly DSP workload in it, then
`terminate()` it. Now and then the **whole process** dies with exit code
3221225477 (0xC0000005, `STATUS_ACCESS_VIOLATION`). Nothing is printed: no
JavaScript error, no `'error'` event, no fatal-error report. With
WebAssembly tier-up turned off, it does not happen.

It was found as a God's Eye View unit test file failing about once in 500
to 1,000 runs of the suite, reported by `node:test` only as a file-level
`'test failed'`.

## Running it

Node 24 and `@jtarrio/signals` (`npm i @jtarrio/signals@0.10.1`, Apache
2.0) for the `receiver` variant; `inline` and `plain` need nothing. The
crash is rare on an idle machine, so `run.mjs` runs many processes at
once beside a separate process of busy threads:

```bash
node run.mjs receiver 50 24 32 p16
```

That is 24 rounds of 32 processes, each running 50 worker lifecycles,
beside a process with 16 busy threads. It prints a JSON line with the
counts by exit code.

```bash
node run.mjs receiver 50 24 32 p16 -- --no-wasm-tier-up
```

The arguments after `--` go to each `repro.mjs` process.

## What was measured

Windows 10 Education 22H2 (10.0.19045.6456), AMD Ryzen 7 1800X (8 cores,
16 threads), 16 GB, Node v24.21.0, V8 13.6.233.17-node.53, 2026-10-22.
Each variant is 50 cycles a process, 32 processes at a time, beside the
burner:

| Variant          | What the worker does                                                                                                                                                                                                                                    | Burner                | Cycles | Crashed (0xC0000005) |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ | -------------------- |
| `receiver`       | `@jtarrio/signals`' wide-band FM demodulator (WebAssembly FIR convolver and FFT): a browser-like `self`, `configure` builds it, two 64 KB blocks of 8-bit IQ arrive transferred, each is demodulated and its audio posted back transferred, then an ack | separate process      | 38,400 | 5                    |
| `receiver`       | the same, `--no-wasm-tier-up`                                                                                                                                                                                                                           | separate process      | 38,400 | 0                    |
| `receiver`       | the same                                                                                                                                                                                                                                                | separate process      | 12,800 | 1                    |
| `receiver`       | the same                                                                                                                                                                                                                                                | threads in the runner | 12,800 | 0                    |
| `app`            | the application's own decoder module (`src/sdr/sdr.worker.js`, the same library plus its JavaScript), driven the same way                                                                                                                               | separate process      | 12,800 | 8                    |
| `plain`          | no WebAssembly: says ready, then done                                                                                                                                                                                                                   | separate process      | 12,800 | 0                    |
| `inline`         | a 1-page WebAssembly module built in `repro.mjs`: a hot f64 loop storing to memory, 40 × 50,000 iterations                                                                                                                                              | threads in the runner | 12,800 | 0                    |
| `signals`        | `@jtarrio/signals`' FFT alone, 60 transforms of 2,048                                                                                                                                                                                                   | threads in the runner | 12,800 | 0                    |
| `demod`          | the demodulator with its input made in the worker, nothing transferred                                                                                                                                                                                  | threads in the runner | 12,800 | 0                    |
| `demod-transfer` | the demodulator, input and output transferred                                                                                                                                                                                                           | threads in the runner | 12,800 | 0                    |

Earlier, with the application's decoder and a slightly different driver
(a separate burner process, 32 processes at a time):

- 3 of 6,400, 7 of 12,800, 11 of 12,800, and 9 of 12,800 with its
  spectrum computation off.
- 0 of 6,400 and 0 of 12,800 with `--no-wasm-tier-up`, and 0 of 12,800
  with `v8.setFlagsFromString('--no-wasm-tier-up')` before the first
  worker.
- 0 of 6,400 when it waited 500 ms after the last block before
  `terminate()`.
- 0 of 6,400 for a worker that only imported the decoder and was
  terminated without decoding.

Inside `node --test` the test file still crashed 1 to 2 times in 2,560
runs with the flag set by `v8.setFlagsFromString` at its top, and once in
2,560 with `--no-wasm-tier-up` on the `node --test` command line. That
inheritance was not investigated further. The application's tests now
run the decoder without a worker.

Not tried: Linux or macOS, Node 22, Node 25.

## Draft issue (for github.com/nodejs/node, "Bug report")

**Title:** Process crashes with 0xC0000005 when terminating a worker that ran WebAssembly (Windows, v24.21.0)

**Version:** v24.21.0 (V8 13.6.233.17-node.53)

**Platform:** Microsoft Windows 10 Education 22H2, 10.0.19045.6456, x64 (AMD Ryzen 7 1800X, 16 logical CPUs, 16 GB)

**Subsystem:** worker, wasm

**What steps will reproduce the bug?**

1. `npm i @jtarrio/signals@0.10.1` (Apache 2.0; its DSP is WebAssembly).
2. Save `repro.mjs` and `run.mjs` (attached / gist).
3. Run `node run.mjs receiver 50 24 32 p16`.

`repro.mjs` starts a `worker_threads` Worker (`eval: true`) that
dynamically imports the library's wide-band FM demodulator. It
transfers two ArrayBuffers of IQ samples to the worker, which
demodulates them and posts the audio back with a transfer list. The main
thread then waits for an ack and calls `await worker.terminate()`, 50
times per process. `run.mjs` runs 32 such processes at a time beside a
separate process of 16 busy threads, and counts the exit codes.

**How often does it reproduce? Is there a required condition?**

About 1 in 7,700 worker lifecycles with this standalone script (5 of
38,400), and 1 in 1,600 with the application's fuller decoder (8 of
12,800). It needs load (a separate process of busy threads) and needs the
worker to have run the WebAssembly. A worker without WebAssembly (0 of
12,800), or one that only imported the module (0 of 6,400), never
crashed. With `--no-wasm-tier-up` it did not happen (0 of 38,400), nor
when the main thread waited 500 ms after the last message before
`terminate()` (0 of 6,400 with the fuller decoder).

**What is the expected behavior? Why is that the expected behavior?**

`terminate()` stops the worker, and the process carries on (all 50
lifecycles complete, exit code 0).

**What do you see instead?**

Now and then the whole process exits with code 3221225477
(0xC0000005, an access violation), with nothing on stdout or stderr: no
JavaScript exception, no `'error'` or `'exit'` event observed, no fatal
error report. The crash comes during or just after `terminate()` of a
worker whose WebAssembly is hot. Since turning off tier-up stops it, the
guess is a race between worker isolate teardown and V8's concurrent
WebAssembly tier-up compilation.

**Additional information**

Found through `node:test`, which reports such a death only as a
file-level `'test failed'` (the TAP reporter shows `exitCode:
3221225477`). Not tried on other platforms or Node lines.
