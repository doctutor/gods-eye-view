// A Node.js crash: terminating a worker_threads Worker that has run
// WebAssembly. One process runs CYCLES worker lifecycles in turn: start the
// worker, run its WebAssembly until it is hot, terminate it.
//
//   node repro.mjs [variant] [cycles]
//
// Variants:
//   inline   a small WebAssembly module built here (no dependencies): a hot
//            loop of float maths and stores into linear memory
//   signals  @jtarrio/signals' WebAssembly FFT (npm i @jtarrio/signals),
//            the library where it was first seen
//   plain    a worker with no WebAssembly (the control)
//
// Exit 0 when every cycle completed. A crash ends the process at once with
// the operating system's code (on Windows 3221225477, 0xC0000005).
// No dependency for `inline` and `plain`; Node 24.
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const [variant = 'inline', cycles = '50'] = process.argv.slice(2);

/** The inline variant's module: work(n) loops n times over 1,024 f64 cells. */
function inlineModule() {
  const leb = (value) => {
    const out = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value) byte |= 0x80;
      out.push(byte);
    } while (value);
    return out;
  };
  const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
  const f64 = (value) => [...new Uint8Array(new Float64Array([value]).buffer)];
  const name = [...Buffer.from('work')];
  const body = [
    ...[0x02, 0x01, 0x7f, 0x01, 0x7c], // locals: i32 i, f64 acc
    ...[0x02, 0x40, 0x03, 0x40], // block, loop
    ...[0x20, 0x01, 0x20, 0x00, 0x4e, 0x0d, 0x01], // i >= n → out
    ...[0x20, 0x01, 0x41, 0xff, 0x07, 0x71, 0x41, 0x03, 0x74], // (i & 1023) << 3
    ...[0x20, 0x02, 0x44, ...f64(1.0000001), 0xa2], // acc × 1.0000001
    ...[0x20, 0x01, 0xb7, 0xa0, 0x22, 0x02], // + i, acc = that
    ...[0x39, 0x03, 0x00], // f64.store
    ...[0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01], // i += 1
    ...[0x0c, 0x00, 0x0b, 0x0b], // br loop, end loop, end block
    ...[0x20, 0x02, 0x0b], // acc
  ];
  const bytes = new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7c]), // (i32) → f64
    ...section(3, [0x01, 0x00]),
    ...section(5, [0x01, 0x00, 0x01]), // one page of memory
    ...section(7, [0x01, ...leb(name.length), ...name, 0x00, 0x00]),
    ...section(10, [0x01, ...leb(body.length), ...body]),
  ]);
  if (!WebAssembly.validate(bytes))
    throw new Error('the inline module is invalid');
  return bytes;
}

const sources = {
  plain: `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', () => parentPort.postMessage('done'));
    parentPort.postMessage('ready');`,
  inline: `
    const { parentPort, workerData } = require('node:worker_threads');
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(workerData));
    parentPort.on('message', () => {
      let sum = 0;
      for (let k = 0; k < 40; k++) sum += exports.work(50_000);
      parentPort.postMessage('done');
    });
    parentPort.postMessage('ready');`,
  signals: `
    const { parentPort } = require('node:worker_threads');
    import('@jtarrio/signals/dsp/fft.js').then(({ FFT }) => {
      const fft = FFT.ofLength(2048);
      const real = new Float32Array(2048).map((_, i) => Math.cos(i / 7));
      const imag = new Float32Array(2048);
      parentPort.on('message', () => {
        for (let k = 0; k < 60; k++) fft.transform(real, imag);
        parentPort.postMessage('done');
      });
      parentPort.postMessage('ready');
    });`,
  // The wide-band FM demodulator (its FIR convolver and FFT), two blocks
  // of a 100 kHz tone at 2.048 MS/s; with `-transfer`, each block's
  // samples arrive in a transferred ArrayBuffer and the audio leaves in one.
  demod: demodSource(false),
  'demod-transfer': demodSource(true),
  // An FM receiver's decoder as an application runs it (God's Eye View's
  // sdr.worker.js, its FM path inline): a browser-like `self`, configure
  // builds the demodulator, each block of 8-bit IQ arrives transferred and
  // is demodulated, its audio is posted back transferred, then an ack.
  receiver: `
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
    parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
    Promise.all([
      import('@jtarrio/signals/demod/demodulator.js'),
      import('@jtarrio/signals/demod/modes.js'),
    ]).then(([, { getDemod, getMode }]) => {
      let demodulator = null;
      self.onmessage = ({ data: message }) => {
        if (message.type === 'configure') {
          demodulator = getDemod(message.sampleRate, 48_000, { ...getMode('WBFM'), stereo: false });
          return;
        }
        if (message.type !== 'samples') return;
        const bytes = new Uint8Array(message.buffer);
        const length = bytes.length / 2;
        const i = new Float32Array(length);
        const q = new Float32Array(length);
        for (let n = 0; n < length; n++) {
          i[n] = (bytes[2 * n] - 127.5) / 128;
          q[n] = (bytes[2 * n + 1] - 127.5) / 128;
        }
        const samples = new Float32Array(demodulator.demodulate(i, q, 0).left);
        self.postMessage({ type: 'fm', samples }, [samples.buffer]);
        self.postMessage({ type: 'ack', id: message.id });
      };
      self.postMessage({ type: 'ready' });
    });`,
};

function demodSource(transfer) {
  return `
    const { parentPort } = require('node:worker_threads');
    Promise.all([
      import('@jtarrio/signals/demod/demodulator.js'),
      import('@jtarrio/signals/demod/modes.js'),
    ]).then(([, { getDemod, getMode }]) => {
      const demod = getDemod(2_048_000, 48_000, { ...getMode('WBFM'), stereo: false });
      const tone = () => {
        const i = new Float32Array(32_768), q = new Float32Array(32_768);
        for (let n = 0; n < 32_768; n++) {
          const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
          i[n] = 0.47 * Math.cos(phase);
          q[n] = 0.47 * Math.sin(phase);
        }
        return [i, q];
      };
      parentPort.on('message', (message) => {
        for (let k = 0; k < 2; k++) {
          const [i, q] = ${transfer} && message?.buffers
            ? [new Float32Array(message.buffers[2 * k]), new Float32Array(message.buffers[2 * k + 1])]
            : tone();
          const out = new Float32Array(demod.demodulate(i, q, 0).left);
          ${transfer} ? parentPort.postMessage({ audio: out }, [out.buffer]) : null;
        }
        parentPort.postMessage('done');
      });
      parentPort.postMessage('ready');
    });`;
}
if (!sources[variant] && variant !== 'app')
  throw new Error(`no variant ${variant}`);
const workerData = variant === 'inline' ? inlineModule() : undefined;

// `app`: the application's own decoder module (APP_DECODER, a path to
// God's Eye View's src/sdr/sdr.worker.js), driven the same way.
if (variant === 'app') {
  const url = pathToFileURL(String(process.env.APP_DECODER || '')).href;
  sources.app = `
    const { parentPort } = require('node:worker_threads');
    globalThis.self = globalThis;
    self.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
    parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));
    import(${JSON.stringify(url)});`;
}

/** The receiver (or app) variant's cycle: as the application's tests drove it. */
async function receiverCycle() {
  const worker = new Worker(sources[variant], { eval: true });
  const inbox = [];
  worker.on('message', (message) => inbox.push(message));
  worker.on('error', (error) => {
    console.error('worker error:', error);
    process.exitCode = 2;
  });
  const until = (check) =>
    new Promise((resolve) => {
      const poll = () => (check() ? resolve() : setTimeout(poll, 1));
      poll();
    });
  await until(() => inbox.some((m) => m.type === 'ready'));
  worker.postMessage({ type: 'configure', sampleRate: 2_048_000 });
  for (let id = 0; id < 2; id++) {
    const bytes = new Uint8Array(32_768 * 2);
    for (let n = 0; n < 32_768; n++) {
      const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
      bytes[2 * n] = Math.round(127.5 + 60 * Math.cos(phase));
      bytes[2 * n + 1] = Math.round(127.5 + 60 * Math.sin(phase));
    }
    worker.postMessage({ type: 'samples', buffer: bytes.buffer, id }, [
      bytes.buffer,
    ]);
  }
  await until(() => inbox.filter((m) => m.type === 'ack').length === 2);
  await worker.terminate();
}

for (let i = 0; i < Number(cycles); i++) {
  if (variant === 'receiver' || variant === 'app') {
    await receiverCycle();
    continue;
  }
  const worker = new Worker(sources[variant], { eval: true, workerData });
  const next = () => new Promise((resolve) => worker.once('message', resolve));
  worker.on('error', (error) => {
    console.error('worker error:', error);
    process.exitCode = 2;
  });
  await next(); // ready
  if (variant === 'demod-transfer') {
    const buffers = [];
    for (let k = 0; k < 2; k++) {
      const i = new Float32Array(32_768);
      const q = new Float32Array(32_768);
      for (let n = 0; n < 32_768; n++) {
        const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
        i[n] = 0.47 * Math.cos(phase);
        q[n] = 0.47 * Math.sin(phase);
      }
      buffers.push(i.buffer, q.buffer);
    }
    worker.postMessage({ buffers }, buffers);
  } else worker.postMessage('run');
  // The audio (with -transfer), then done: the WebAssembly is hot.
  while ((await next()) !== 'done');
  await worker.terminate();
}
