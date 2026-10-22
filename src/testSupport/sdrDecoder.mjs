// Personal fork: the real FM/ADS-B decoder (src/sdr/sdr.worker.js) for
// tests, in the test's own thread rather than a node:worker_threads Worker.
//
// Its messages cross as a worker's do: copied by structuredClone, with
// transferred buffers detached, both ways. The tests are about the
// decoder's output; a Worker running its WebAssembly DSP (@jtarrio/signals'
// FFT and convolver) crashed Node 24.21 on Windows natively when it was
// terminated, now and then under load: an access violation, exit
// 0xC0000005, which the test runner reports only as a file-level 'test
// failed'. Measured 2026-10-22: 7 of 12,800 decode-and-terminate cycles,
// and the test file 1 to 2 of 2,560 runs even with WebAssembly tier-up
// off. A plain Worker, or one that only imported the decoder, never
// crashed. The browser runs the decoder in a Web Worker, where none of
// this applies. Not part of upstream God's Eye View.

let instances = 0;

/**
 * A fresh instance of the decoder module (its own state) behind a `self`
 * stand-in. Returns {thread: {postMessage(message, transfer)}, inbox,
 * failures}: the decoder's messages in order, and any error its handler
 * threw (a worker's 'error'), for the test to fail on.
 * @param {import('node:test').TestContext} t
 */
export async function realDecoder(t) {
  const module = new URL('../sdr/sdr.worker.js', import.meta.url).href;
  const inbox = [];
  const failures = [];
  const prior = globalThis.self;
  const self = {
    onmessage: null,
    postMessage: (message, transfer = []) =>
      inbox.push(structuredClone(message, { transfer })),
  };
  globalThis.self = self;
  t.after(() => {
    globalThis.self = prior;
  });
  await import(`${module}?instance=${(instances += 1)}`);
  const thread = {
    postMessage(message, transfer = []) {
      const data = structuredClone(message, { transfer });
      try {
        self.onmessage?.({ data });
      } catch (error) {
        failures.push(error);
      }
    },
  };
  return { thread, inbox, failures };
}
