// Personal fork: the real FM decoder (sdr.worker.js), its timings and its
// spectra, apart from decoderDiagnostics.test.mjs's stand-in decoder. It
// runs in this thread (src/testSupport/sdrDecoder.mjs says why).
import assert from 'node:assert/strict';
import test from 'node:test';
import { realDecoder } from '../testSupport/sdrDecoder.mjs';

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 1_000, failures = []) {
  const deadline = Date.now() + ms;
  while (!check()) {
    // A decoder thread that failed: this test fails with its reason.
    if (failures.length) throw failures[0];
    if (Date.now() > deadline) throw new Error('condition not reached');
    await pause(2);
  }
}

test('the real decoder returns timings only for stamped blocks', async (t) => {
  const { thread, inbox, failures } = await realDecoder(t);
  await until(() => inbox.some((m) => m.type === 'ready'), 5_000, failures);
  thread.postMessage({
    type: 'configure',
    mode: 'fm',
    sampleRate: 2_048_000,
    tune: 1,
  });
  const block = () => {
    const bytes = new Uint8Array(32_768 * 2).fill(128);
    return bytes.buffer;
  };
  const stamped = block();
  const postedAt = performance.timeOrigin + performance.now();
  thread.postMessage({ type: 'samples', buffer: stamped, id: 0, postedAt }, [
    stamped,
  ]);
  const plain = block();
  thread.postMessage({ type: 'samples', buffer: plain, id: 1 }, [plain]);
  await until(
    () => inbox.filter((m) => m.type === 'ack').length === 2,
    5_000,
    failures,
  );
  const [timed, untimed] = inbox.filter((m) => m.type === 'ack');
  assert.ok(
    timed.receivedAt >= postedAt - 5,
    'receipt after posting (clock skew tolerance)',
  );
  assert.ok(timed.computeMs >= 0 && timed.computeMs < 5_000);
  assert.ok(timed.ackPostedAt >= timed.receivedAt);
  assert.deepEqual(Object.keys(untimed).sort(), ['id', 'type']);
  const fm = inbox.filter((m) => m.type === 'fm');
  assert.ok(Number.isFinite(fm[0].workerPostedAt));
  assert.equal(fm[1].workerPostedAt, undefined);
});

test('the real decoder computes spectra only when requested, with audio unchanged', async (t) => {
  const { thread, inbox, failures } = await realDecoder(t);
  await until(() => inbox.some((m) => m.type === 'ready'), 5_000, failures);
  const tone = () => {
    const bytes = new Uint8Array(32_768 * 2);
    for (let n = 0; n < 32_768; n += 1) {
      const phase = (2 * Math.PI * 100_000 * n) / 2_048_000;
      bytes[2 * n] = Math.round(127.5 + 60 * Math.cos(phase));
      bytes[2 * n + 1] = Math.round(127.5 + 60 * Math.sin(phase));
    }
    return bytes.buffer;
  };
  const run = async (spectrum, firstId) => {
    // A reset starts each run at block 0 with identical decoder state.
    thread.postMessage({ type: 'reset', tune: 1 });
    thread.postMessage({
      type: 'configure',
      mode: 'fm',
      sampleRate: 2_048_000,
      tune: 1,
    });
    for (let index = 0; index < 6; index += 1) {
      const buffer = tone();
      thread.postMessage(
        { type: 'samples', buffer, id: firstId + index, spectrum },
        [buffer],
      );
    }
    await until(
      () =>
        inbox.filter((m) => m.type === 'ack' && m.id >= firstId).length === 6,
      5_000,
      failures,
    );
    return inbox.filter((m) => m.type === 'fm').splice(-6);
  };
  const listening = await run(false, 0);
  const seeking = await run(true, 100);
  assert.ok(
    listening.every((m) => m.bins === null),
    'no FFT while listening',
  );
  assert.equal(
    seeking.filter((m) => m.bins instanceof Float32Array).length,
    2,
    'every third block',
  );
  assert.deepEqual(
    listening.map((m) => m.samples.length),
    seeking.map((m) => m.samples.length),
    'audio output unchanged',
  );
  assert.deepEqual(
    Array.from(listening[5].samples),
    Array.from(seeking[5].samples),
  );
});
