import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_STAMP_META,
  BUILD_STAMP_PATH,
  RELOAD_KEY,
  createBuildStampWatcher,
  readBuildStamp,
  startBuildStampWatcher,
} from './buildStamp.js';

/** A page: document, window, storage, clock and timers under test control. */
function page({
  stamp = 'A',
  hidden = false,
  server = 'A',
  status = 200,
} = {}) {
  const listeners = new Map();
  const on = (target) => ({
    addEventListener(type, fn) {
      listeners.set(`${target}:${type}`, fn);
    },
    removeEventListener(type) {
      listeners.delete(`${target}:${type}`);
    },
  });
  const fire = (target, type) => listeners.get(`${target}:${type}`)?.();
  const store = new Map();
  const state = {
    hidden,
    server,
    status,
    body: null,
    time: 100_000,
    reloads: 0,
    fetches: 0,
    timeouts: [],
    intervals: [],
    warnings: [],
  };
  const document = {
    ...on('document'),
    get hidden() {
      return state.hidden;
    },
    querySelector: (selector) =>
      selector === `meta[name="${BUILD_STAMP_META}"]` && stamp
        ? { getAttribute: () => stamp }
        : null,
  };
  const window = { ...on('window') };
  const fetch = async (path, init) => {
    state.fetches++;
    assert.equal(path, BUILD_STAMP_PATH);
    assert.equal(init.cache, 'no-store');
    if (state.status === 'network') throw new TypeError('Failed to fetch');
    return {
      ok: state.status === 200,
      json: async () =>
        state.body !== null ? state.body : { stamp: state.server },
    };
  };
  const timers = {
    setTimeout: (fn, ms) =>
      state.timeouts.push({ fn, ms }) && state.timeouts.length,
    clearTimeout: () => {},
    setInterval: (fn, ms) => state.intervals.push({ fn, ms }) && 1,
    clearInterval: () => state.intervals.splice(0),
  };
  const watcher = createBuildStampWatcher({
    stamp,
    fetch,
    document,
    window,
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
    now: () => state.time,
    timers,
    interval: 60_000,
    retry: 5_000,
    idleMs: 15_000,
    reload: () => state.reloads++,
    log: { info() {}, warn: (m) => state.warnings.push(m) },
  });
  return { watcher, state, store, fire, listeners, document };
}

test('the document’s meta tag carries the stamp', () => {
  const { document } = page({ stamp: '2026-10-29T12:00:00.000Z-ab12' });
  assert.equal(readBuildStamp(document), '2026-10-29T12:00:00.000Z-ab12');
  assert.equal(
    readBuildStamp({ querySelector: () => ({ getAttribute: () => '' }) }),
    null,
  );
  assert.equal(readBuildStamp({}), null);
  assert.equal(readBuildStamp(undefined), null);
});

test('a page whose stamp the server still answers stays', async () => {
  const { watcher, state } = page();
  assert.equal(watcher.start(), true);
  assert.equal(await watcher.check(), 'current');
  assert.equal(state.reloads, 0);
  assert.equal(state.intervals[0].ms, 60_000);
});

test('a hidden page reloads at once for a newer stamp, remembering it', async () => {
  const { watcher, state, store } = page({ hidden: true, server: 'B' });
  watcher.start();
  assert.equal(await watcher.check(), 'reloading');
  assert.equal(state.reloads, 1);
  assert.equal(store.get(RELOAD_KEY), 'B');
});

test('a visible page waits until its user has been idle, then reloads', async () => {
  const { watcher, state, fire } = page({ server: 'B' });
  watcher.start();
  state.time += 1_000;
  fire('window', 'pointerdown');
  assert.equal(await watcher.check(), 'deferred');
  assert.equal(state.reloads, 0);
  assert.equal(state.timeouts.length, 1);
  assert.equal(state.timeouts[0].ms, 5_000);
  // Still busy: deferred again, and a second check does not pile up.
  state.time += 5_000;
  fire('window', 'keydown');
  assert.equal(state.timeouts[0].fn(), 'deferred');
  assert.equal(await watcher.check(), 'deferred');
  assert.equal(state.timeouts.length, 2);
  // Idle long enough: the deferred attempt reloads.
  state.time += 15_000;
  assert.equal(state.timeouts[1].fn(), 'reloading');
  assert.equal(state.reloads, 1);
});

test('an answer that is missing, not JSON or not a stamp never reloads', async () => {
  for (const setup of [
    (state) => (state.status = 404),
    (state) => (state.status = 'network'),
    (state) => (state.body = { nothing: true }),
    (state) => (state.body = { stamp: 7 }),
  ]) {
    const { watcher, state } = page({ hidden: true, server: 'B' });
    setup(state);
    watcher.start();
    assert.equal(await watcher.check(), 'unavailable');
    assert.equal(state.reloads, 0);
  }
});

test('a reload that brought the newer stamp clears the memory of it', () => {
  const { watcher, store, state } = page({ stamp: 'B' });
  store.set(RELOAD_KEY, 'B');
  assert.equal(watcher.start(), true);
  assert.equal(store.has(RELOAD_KEY), false);
  assert.equal(state.warnings.length, 0);
});

test('a reload that did not bring the newer stamp is not repeated', () => {
  const { watcher, store, state } = page({ stamp: 'A' });
  store.set(RELOAD_KEY, 'B');
  assert.equal(watcher.start(), false);
  assert.equal(store.has(RELOAD_KEY), false);
  assert.match(state.warnings[0], /not reloading again/);
  assert.equal(state.intervals.length, 0);
});

test('coming back into view or gaining focus asks the server', async () => {
  const { watcher, state, fire } = page();
  watcher.start();
  fire('document', 'visibilitychange');
  await new Promise((resolve) => setImmediate(resolve));
  fire('window', 'focus');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.fetches, 2);
  state.hidden = true;
  fire('document', 'visibilitychange');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.fetches, 2);
});

test('stop removes every listener and timer', () => {
  const { watcher, listeners, state } = page();
  watcher.start();
  assert.equal(listeners.size, 5);
  watcher.stop();
  assert.equal(listeners.size, 0);
  assert.equal(state.intervals.length, 0);
});

test('startBuildStampWatcher needs a stamped document', () => {
  assert.equal(startBuildStampWatcher({ document: {} }), null);
  const { document } = page({ stamp: 'A' });
  const watcher = startBuildStampWatcher({
    document,
    window: { addEventListener() {}, removeEventListener() {} },
    storage: null,
    timers: { setInterval: () => 1, clearInterval() {} },
    fetch: async () => ({ ok: false }),
  });
  assert.equal(typeof watcher?.check, 'function');
  watcher.stop();
});
