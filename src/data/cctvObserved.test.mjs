import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OBSERVED_FILE,
  OBSERVED_WRITE_INTERVAL_MS,
  classifyAnswer,
  createFrameObserver,
  createViewLog,
  applyObservations,
  isObservable,
  mergeObserved,
  readObserved,
  readPlaceholders,
  readViews,
  trimViews,
  withObservations,
  withObservedNear,
} from '../../server/providers/cctv/observed.js';
import { createCamindexLoader } from '../../server/providers/cctv/camindex.js';
import {
  createLinkedLoader,
  osmToSources,
} from '../../server/providers/cctv/linked.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

// Personal fork: lazy verification (server/providers/cctv/observed.js).

const jpeg = (size, fill = 7) => Buffer.alloc(size, fill);
const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex');

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-observed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('an upstream answer becomes live, dead, placeholder or error', () => {
  const placeholder = jpeg(5000, 9);
  const known = new Set([sha1(placeholder)]);
  const answer = (over) => ({
    status: 200,
    contentType: 'image/jpeg',
    body: jpeg(5000),
    ...over,
  });
  assert.deepEqual(classifyAnswer(answer(), known, 10), {
    at: 10,
    httpStatus: 200,
    status: 'live',
    bytes: 5000,
  });
  assert.equal(
    classifyAnswer(answer({ body: placeholder }), known, 10).status,
    'placeholder',
  );
  assert.equal(
    classifyAnswer(answer({ body: jpeg(900) }), known, 10).status,
    'dead',
  );
  assert.equal(
    classifyAnswer(
      { status: 404, contentType: 'text/plain', body: null },
      known,
      10,
    ).status,
    'dead',
  );
  assert.equal(
    classifyAnswer(
      { status: 200, contentType: 'text/html', body: null },
      known,
      10,
    ).status,
    'dead',
  );
  for (const status of [0, 403, 429, 500, 503])
    assert.equal(
      classifyAnswer({ status, contentType: '', body: null }, known, 10).status,
      'error',
      String(status),
    );
});

test('the placeholder list is read from scripts/camindex/placeholders.json', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, 'placeholders.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      hashes: { opencctv: ['a'.repeat(40), 'nope'], other: ['b'.repeat(40)] },
    }),
  );
  assert.deepEqual([...readPlaceholders(file)].sort(), [
    'a'.repeat(40),
    'b'.repeat(40),
  ]);
  assert.equal(readPlaceholders(path.join(root, 'missing.json')).size, 0);
  // The shipped list parses.
  const shipped = JSON.parse(
    readFileSync(
      new URL('../../scripts/camindex/placeholders.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(Array.isArray(shipped.hashes.opencctv));
});

test('only display-only image cameras are observed', () => {
  assert.equal(
    isObservable({
      id: 'opencctv-1',
      licenseClass: 'embed-only',
      feedType: 'image',
    }),
    true,
  );
  assert.equal(
    isObservable({
      id: 'windy-1',
      licenseClass: 'display-only',
      feedType: 'image',
    }),
    true,
  );
  assert.equal(isObservable({ id: 'mdot-1', feedType: 'image' }), false);
  assert.equal(
    isObservable({ id: 'yt', licenseClass: 'embed-only', feedType: 'youtube' }),
    false,
  );
});

test('observations are batched into one atomic write per 30 s', async (t) => {
  const root = await tempRoot(t);
  let clock = 1_000;
  const timers = [];
  const answers = {
    'https://x/live.jpg': {
      status: 200,
      contentType: 'image/jpeg',
      body: jpeg(4000),
    },
    'https://x/dead.jpg': {
      status: 404,
      contentType: 'text/plain',
      body: null,
    },
  };
  const observer = createFrameObserver({
    sourceRoot: root,
    env: {},
    now: () => clock,
    setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }),
    flushOnExit: false,
    fetchFrame: async (url, { onAnswer } = {}) => {
      const answer = answers[url];
      onAnswer?.(answer);
      return answer.status === 200 ? { ok: true, body: answer.body } : null;
    },
  });
  const cam = (id) => ({ id, licenseClass: 'embed-only', feedType: 'image' });
  await observer.fetch(cam('opencctv-1'), 'https://x/live.jpg');
  await observer.fetch(cam('opencctv-2'), 'https://x/dead.jpg');
  // A camera that is not display-only is fetched but not recorded.
  await observer.fetch(
    { id: 'mdot-9', feedType: 'image' },
    'https://x/live.jpg',
  );
  assert.equal(timers.length, 1, 'one timer for the batch');
  assert.equal(timers[0].at - 1_000, OBSERVED_WRITE_INTERVAL_MS);
  const file = path.join(root, '.gev-cache', 'camindex', OBSERVED_FILE);
  await assert.rejects(fs.stat(file), 'nothing written before the timer');

  // An entry already on disk (from another writer) survives the merge.
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ 'opencctv-7': { status: 'live', at: 500 } }),
  );
  clock = timers[0].at;
  timers.shift().fn();
  const written = readObserved(file);
  assert.deepEqual(Object.keys(written).sort(), [
    'opencctv-1',
    'opencctv-2',
    'opencctv-7',
  ]);
  assert.equal(written['opencctv-1'].status, 'live');
  assert.equal(written['opencctv-1'].bytes, 4000);
  assert.equal(written['opencctv-2'].status, 'dead');
  const leftovers = (await fs.readdir(path.dirname(file))).filter((name) =>
    name.endsWith('.tmp'),
  );
  assert.deepEqual(leftovers, [], 'written atomically');

  // The next observation waits out the rest of the 30 s since the write.
  clock += 10_000;
  await observer.fetch(cam('opencctv-3'), 'https://x/live.jpg');
  assert.equal(timers[0].at - clock, 20_000);
});

test('a newer observation on disk is not overwritten by an older one', async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, OBSERVED_FILE);
  mergeObserved(file, { a: { status: 'dead', at: 20 } });
  mergeObserved(file, {
    a: { status: 'live', at: 10 },
    b: { status: 'live', at: 5 },
  });
  assert.deepEqual(readObserved(file), {
    a: { status: 'dead', at: 20 },
    b: { status: 'live', at: 5 },
  });
  await fs.writeFile(file, '{"x":{"status":"bogus","at":1},"y":[1]}');
  assert.deepEqual(readObserved(file), {});
});

test('the view log keeps distinct centres, at most the last 1,000', async (t) => {
  const root = await tempRoot(t);
  let clock = 0;
  const views = createViewLog({
    sourceRoot: root,
    env: {},
    now: () => ++clock,
  });
  views.record(39.29, -76.61, 25);
  views.record(39.2901, -76.6102, 25);
  views.record(NaN, 1, 25);
  views.record(40.71, -74.0, 300.4);
  const read = readViews(views.file);
  assert.deepEqual(
    read.map((v) => [v.lat, v.lon, v.radiusKm]),
    [
      [39.29, -76.61, 25],
      [40.71, -74, 300],
    ],
  );
  const many = Array.from({ length: 1200 }, (_, i) => `${i} 1 1 5`).join('\n');
  await fs.writeFile(views.file, `${many}\n`);
  trimViews(views.file, 1000);
  const kept = readViews(views.file);
  assert.equal(kept.length, 1000);
  assert.equal(kept[0].at, 200);
});

test('proximity queries leave their centre in the view log', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const root = await tempRoot(t);
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^CAMINDEX_/.test(key)) delete process.env[key];
    process.env.CCTV_WINDY_ENABLED = '0';
    t.mock.method(globalThis, 'fetch', async () => Response.json([]));
    const getSources = createCctvCatalog({ sourceRoot: root });
    await getSources.near(39.29, -76.61, { radiusKm: 30 });
    const read = readViews(
      path.join(root, '.gev-cache', 'camindex', 'views.log'),
    );
    assert.deepEqual(
      read.map((v) => [v.lat, v.lon, v.radiusKm]),
      [[39.29, -76.61, 30]],
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the pack drops cameras seen dead and marks those seen live', async (t) => {
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const dir = path.join(root, '.gev-cache', 'camindex');
  await fs.mkdir(dir, { recursive: true });
  const camera = (id) => ({
    id,
    name: id,
    lat: 39.3,
    lon: -76.6,
    feedType: 'image',
    snapshotUrl: `https://opencctv.org/still/${id}.jpg`,
    licenseClass: 'embed-only',
    liveStatus: 'unknown',
  });
  await fs.writeFile(
    path.join(dir, 'catalog.json'),
    JSON.stringify({
      cameras: ['opencctv-1', 'opencctv-2', 'opencctv-3', 'opencctv-4'].map(
        camera,
      ),
    }),
  );
  const at = Date.UTC(2026, 9, 17, 3);
  await fs.writeFile(
    path.join(dir, OBSERVED_FILE),
    JSON.stringify({
      'opencctv-1': { status: 'live', at },
      'opencctv-2': { status: 'dead', at },
      'opencctv-3': { status: 'placeholder', at },
      'opencctv-4': { status: 'error', at },
    }),
  );
  const load = createCamindexLoader({ env: {} });
  const first = (await load({ sourceRoot: root })).everything;
  assert.deepEqual(
    first.map((s) => [s.id, s.liveStatus]),
    [
      ['opencctv-1', 'live'],
      ['opencctv-4', 'unknown'],
    ],
  );
  assert.equal(first[0].observedAt, '2026-10-17T03:00:00.000Z');
  assert.equal(
    normalizeSourceItem(first[0]).observedAt,
    '2026-10-17T03:00:00.000Z',
    'the observed time reaches the index',
  );
  assert.equal(
    (await load({ sourceRoot: root })).everything,
    first,
    'unchanged files are not re-applied',
  );
  // A later observation brings a camera back.
  await fs.writeFile(
    path.join(dir, OBSERVED_FILE),
    JSON.stringify({ 'opencctv-2': { status: 'live', at: at + 1 } }),
  );
  const later = new Date(Date.now() + 5000);
  await fs.utimes(path.join(dir, OBSERVED_FILE), later, later);
  assert.equal((await load({ sourceRoot: root })).everything.length, 4);
  assert.deepEqual(applyObservations([{ id: 'a' }], {}), [{ id: 'a' }]);
});

/** A temp source root holding an observed.json. */
async function observedRoot(t, observed) {
  const root = await tempRoot(t);
  const dir = path.join(root, '.gev-cache', 'camindex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, OBSERVED_FILE), JSON.stringify(observed));
  return root;
}

test('a pack list keeps its properties, with everything filtered too', async (t) => {
  const at = Date.UTC(2026, 9, 17, 2);
  const root = await observedRoot(t, {
    'osm-webcam-n1': { status: 'dead', at },
    'osm-webcam-n2': { status: 'live', at },
    'usgs-3': { status: 'placeholder', at },
  });
  const cams = ['osm-webcam-n1', 'osm-webcam-n2', 'usgs-3', 'usgs-4'].map(
    (id) => ({ id, liveStatus: 'unknown' }),
  );
  const list = Object.assign(cams.slice(2), { skipped: '' });
  Object.defineProperty(list, 'everything', { value: cams });
  Object.defineProperty(list, 'available', { value: 4 });
  Object.defineProperty(list, 'proximityOnly', { value: true });
  const out = withObservations(list, root, {});
  assert.deepEqual(
    out.map((s) => s.id),
    ['usgs-4'],
  );
  assert.deepEqual(
    out.everything.map((s) => [s.id, s.liveStatus]),
    [
      ['osm-webcam-n2', 'live'],
      ['usgs-4', 'unknown'],
    ],
  );
  assert.equal(out.everything[0].observedAt, '2026-10-17T02:00:00.000Z');
  assert.equal(out.available, 4);
  assert.equal(out.proximityOnly, true);
  assert.equal(out.skipped, '');
  assert.equal(
    Object.keys(out).includes('everything'),
    false,
    'everything stays non-enumerable',
  );
  // Nothing observed: the very same list comes back.
  const empty = await tempRoot(t);
  assert.equal(withObservations(list, empty, {}), list);
  assert.equal(withObservations(null, root, {}), null);
});

test('the linked pack drops webcams viewers saw dead', async (t) => {
  t.mock.method(console, 'log', () => {});
  const at = Date.UTC(2026, 9, 17, 2);
  const root = await observedRoot(t, {
    'osm-webcam-n1': { status: 'dead', at },
    'osm-webcam-n2': { status: 'live', at },
  });
  const cacheDir = path.join(root, '.gev-cache', 'cctv-linked');
  await fs.mkdir(cacheDir, { recursive: true });
  const element = (id, lat) => ({
    type: 'node',
    id,
    lat,
    lon: -76.6,
    tags: {
      name: `Cam ${id}`,
      'contact:webcam': `https://cam${id}.example/a.jpg`,
    },
  });
  await fs.writeFile(
    path.join(cacheDir, 'osm.json'),
    JSON.stringify({
      at: Date.now(),
      sources: osmToSources([
        element(1, 39.1),
        element(2, 39.2),
        element(3, 39.3),
      ]),
    }),
  );
  await fs.writeFile(
    path.join(cacheDir, 'wikidata.json'),
    JSON.stringify({ at: Date.now(), sources: [] }),
  );
  const load = createLinkedLoader({ fetchImpl: async () => Response.json({}) });
  const loaded = await load({ sourceRoot: root });
  assert.equal(loaded.proximityOnly, true);
  assert.deepEqual(
    loaded.everything.map((s) => [s.id, s.liveStatus ?? '']),
    [
      ['osm-webcam-n2', 'live'],
      ['osm-webcam-n3', ''],
    ],
  );
});

test('a per-query source answers through the observations', async (t) => {
  const root = await observedRoot(t, {
    'windy-1': { status: 'dead', at: 5 },
    'windy-2': { status: 'live', at: 5 },
  });
  const windy = {
    name: 'windy',
    near: async () => [{ id: 'windy-1' }, { id: 'windy-2' }, { id: 'windy-3' }],
    lookup: (id) => ({ id }),
  };
  const wrapped = withObservedNear(windy, root);
  assert.equal(wrapped.name, 'windy');
  assert.deepEqual(wrapped.lookup('windy-9'), { id: 'windy-9' });
  assert.deepEqual(
    (await wrapped.near(1, 2, 3)).map((s) => [s.id, s.liveStatus ?? '']),
    [
      ['windy-2', 'live'],
      ['windy-3', ''],
    ],
  );
});
