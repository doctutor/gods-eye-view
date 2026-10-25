import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { summarizePacks } from '../../server/providers/cctv/catalog.js';
import {
  createCctvStatus,
  summarizeAudio,
  summarizeObservations,
  youtubeQuota,
} from '../../server/providers/cctv/status.js';
import { createWindySource } from '../../server/providers/cctv/windy.js';
import { cctvProxy } from '../../server/providers/cctv.js';

const pack = (
  name,
  { available, everything = [], proximityOnly = false } = {},
) => ({
  name,
  available: available ?? everything.length,
  proximityOnly,
  everything,
});
const cams = (packName, count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${packName}-${i}`,
    pack: packName,
  }));

test('each pack reports what it offers, serves, keeps and folds, and its last refresh', () => {
  const history = new Map();
  const packs = [
    pack('mdot', { everything: cams('mdot', 4) }),
    pack('camindex', { everything: cams('camindex', 5), proximityOnly: true }),
    pack('vegvesen', { everything: [] }),
    pack('nps'),
    pack('file'),
  ];
  const before = [...cams('mdot', 4), ...cams('camindex', 5)];
  const after = [...cams('mdot', 4), ...cams('camindex', 3)];
  const camindexValue = Object.assign([], { everything: cams('camindex', 5) });
  const first = summarizePacks({
    packs,
    results: [
      { status: 'fulfilled', value: cams('mdot', 4) },
      { status: 'fulfilled', value: camindexValue },
      { status: 'rejected', reason: new Error('vegvesen 503') },
      { status: 'fulfilled', value: [] },
    ],
    enabled: [true, true, true, false],
    capped: cams('mdot', 2),
    before,
    after,
    history,
    now: 1000,
  });
  assert.deepEqual(first, [
    {
      name: 'mdot',
      enabled: true,
      proximityOnly: false,
      available: 4,
      servedCapped: 2,
      inIndex: 4,
      dedupedAway: 0,
      lastRefreshAt: 1000,
      lastError: null,
    },
    {
      name: 'camindex',
      enabled: true,
      proximityOnly: true,
      available: 5,
      servedCapped: 0,
      inIndex: 3,
      dedupedAway: 2,
      lastRefreshAt: 1000,
      lastError: null,
    },
    {
      name: 'vegvesen',
      enabled: true,
      proximityOnly: false,
      available: 0,
      servedCapped: 0,
      inIndex: 0,
      dedupedAway: 0,
      lastRefreshAt: null,
      lastError: { at: 1000, message: 'vegvesen 503' },
    },
  ]);
  // Next refresh mdot comes back empty: its last good refresh is kept.
  const second = summarizePacks({
    packs: [pack('mdot')],
    results: [{ status: 'fulfilled', value: [] }],
    enabled: [true],
    capped: [],
    before: [],
    after: [],
    history,
    now: 2000,
  });
  assert.equal(second[0].lastRefreshAt, 1000);
  assert.deepEqual(second[0].lastError, { at: 2000, message: 'empty' });
});

test('file summaries count observations, audio answers and today’s YouTube units', () => {
  assert.deepEqual(
    summarizeObservations({
      a: { status: 'live', at: 5 },
      b: { status: 'dead', at: 9 },
      c: { status: 'live', at: 7 },
      d: { status: 'weird' },
    }),
    { live: 2, dead: 1, unknown: 1, total: 4, lastAt: 9 },
  );
  assert.deepEqual(summarizeObservations(null), {
    live: 0,
    dead: 0,
    unknown: 0,
    total: 0,
    lastAt: null,
  });
  assert.deepEqual(
    summarizeAudio({
      cameras: [
        { audio: 'silent' },
        { audio: 'audio' },
        { audio: 'silent' },
        { audio: 'loud' },
      ],
    }),
    { audio: 1, silent: 2, likely: 0, unknown: 0 },
  );
  const now = Date.parse('2026-10-16T20:00:00Z');
  assert.deepEqual(
    youtubeQuota(
      { day: '2026-10-16', units: 318, geocodes: 6 },
      { now, env: {} },
    ),
    {
      day: '2026-10-16',
      units: 318,
      budget: 1500,
      geocodes: 6,
    },
  );
  assert.equal(
    youtubeQuota({ day: '2026-10-15', units: 900 }, { now, env: {} }).units,
    0,
    'yesterday’s count is not today’s',
  );
  assert.equal(
    youtubeQuota(null, { now, env: { YOUTUBE_DAILY_BUDGET: '800' } }).budget,
    800,
  );
});

test('the status reads the cache files once per change and reports every source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (rel, value) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), JSON.stringify(value));
  };
  await write('.gev-cache/camindex/catalog.json', {
    generatedAt: '2026-10-16T22:38:31.443Z',
    sources: {
      opencctv: {
        found: 30176,
        verified: 66,
        live: 61,
        dead: 5,
        served: 29980,
      },
      'bad name!': {},
    },
    cameras: [{ id: 'x' }, { id: 'y' }],
  });
  await write('.gev-cache/camindex/observed.json', {
    a: { status: 'live', at: 1 },
    b: { status: 'dead', at: 2 },
  });
  await write('.gev-cache/cctv-featured/pending.json', { items: [{}, {}, {}] });
  await write('.gev-cache/cctv-featured/quota.json', {
    day: '2026-10-16',
    units: 318,
    geocodes: 2,
  });
  await write('audio/cctv-audio.json', { cameras: [{ audio: 'silent' }] });
  const getCctvSources = {
    status: () => ({
      refreshedAt: 1_792_190_000_000,
      packs: [
        {
          name: 'mdot',
          enabled: true,
          available: 519,
          servedCapped: 300,
          inIndex: 519,
          dedupedAway: 0,
          lastRefreshAt: 1_792_190_000_000,
          lastError: null,
        },
        {
          name: 'linked',
          enabled: true,
          proximityOnly: true,
          available: 2,
          servedCapped: 0,
          inIndex: 2,
          dedupedAway: 0,
          lastRefreshAt: 1_792_190_000_000,
          lastError: null,
          // Asked when the status is: the lists as they are now.
          upstream: () => ({
            lists: [
              { name: 'osm', at: '2026-10-09T20:00:00.000Z', refreshing: true },
            ],
          }),
        },
      ],
      dynamic: [
        {
          name: 'windy',
          enabled: true,
          configured: true,
          requestsLastMinute: 12,
          budgetPerMinute: 60,
          cacheEntries: 4,
          knownCameras: 80,
          lastError: {
            at: 1_792_190_000_000,
            message: 'Windy webcams 429: slow down',
          },
        },
      ],
    }),
    index: () => [
      { pack: 'featured', liveStatus: 'live' },
      { pack: 'featured', liveStatus: 'offline' },
      { pack: 'mdot' },
    ],
  };
  const status = createCctvStatus({
    sourceRoot: root,
    getCctvSources,
    frameCache: {
      stats: () => ({ entries: 20, bytes: 2048, hits: 30, misses: 10 }),
    },
    audioCachePath: path.join(root, 'audio/cctv-audio.json'),
    now: () => Date.parse('2026-10-16T20:00:00Z'),
    env: {},
  });
  const body = status();
  assert.deepEqual(Object.keys(body).sort(), [
    'audio',
    'camindex',
    'dynamic',
    'featured',
    'frameCache',
    'generatedAt',
    'packs',
    'refreshedAt',
  ]);
  assert.equal(
    body.packs[0].lastRefreshAt,
    new Date(1_792_190_000_000).toISOString(),
  );
  assert.equal(
    body.dynamic[0].lastError.message,
    'Windy webcams 429: slow down',
  );
  assert.deepEqual(body.packs[1].upstream, {
    lists: [{ name: 'osm', at: '2026-10-09T20:00:00.000Z', refreshing: true }],
  });
  assert.equal('upstream' in body.packs[0], false, 'only a pack that has one');
  assert.doesNotThrow(() => JSON.stringify(body), 'no function in the answer');
  assert.deepEqual(body.camindex.catalog, {
    generatedAt: '2026-10-16T22:38:31.443Z',
    cameras: 29980,
    sources: {
      opencctv: {
        found: 30176,
        verified: 66,
        live: 61,
        dead: 5,
        served: 29980,
      },
    },
  });
  assert.deepEqual(body.camindex.verified, {
    live: 1,
    dead: 1,
    unknown: 0,
    total: 2,
    lastAt: 2,
  });
  assert.deepEqual(body.featured, {
    listed: 2,
    liveNow: 1,
    pending: 3,
    youtube: { day: '2026-10-16', units: 318, budget: 1500, geocodes: 2 },
  });
  assert.deepEqual(body.audio, { audio: 0, silent: 1, likely: 0, unknown: 0 });
  assert.deepEqual(body.frameCache, {
    entries: 20,
    bytes: 2048,
    hits: 30,
    misses: 10,
    hitRate: 0.75,
  });

  // The camera list itself is never parsed while the summary comes first;
  // a file in another layout is read whole.
  await write('.gev-cache/camindex/catalog.json', {
    cameras: [{ id: 'x' }, { id: 'y' }, { id: 'z' }],
    generatedAt: '2026-10-17T01:00:00Z',
  });
  assert.equal(status().camindex.catalog.cameras, 3);
  // A changed file is read again; an unchanged one is not.
  await write('.gev-cache/cctv-featured/pending.json', { items: [{}] });
  assert.equal(status().featured.pending, 1);
  // Missing files are absent, not errors.
  const empty = createCctvStatus({
    sourceRoot: path.join(root, 'nowhere'),
    getCctvSources: {
      status: () => ({ refreshedAt: null, packs: [], dynamic: [] }),
      index: () => [],
    },
    audioCachePath: path.join(root, 'nowhere/a.json'),
    env: {},
  })();
  assert.equal(empty.camindex.catalog, null);
  assert.equal(empty.featured.pending, 0);
  assert.equal(empty.audio, null);
  assert.equal(empty.frameCache, null);
  assert.ok(
    !JSON.stringify(body).match(/key=|api[_-]?key/i),
    'no keys in the payload',
  );
});

test('Windy reports its requests, cache and last failure', async () => {
  let clock = 1_000_000;
  const windy = createWindySource({
    apiKey: () => 'test-key',
    now: () => clock,
    fetchImpl: async () =>
      Response.json({ message: 'slow down' }, { status: 429 }),
  });
  assert.deepEqual(await windy.near(39.29, -76.61, 10), []);
  const stats = windy.stats();
  assert.equal(stats.configured, true);
  assert.equal(stats.requestsLastMinute, 1);
  assert.equal(stats.cacheEntries, 0);
  assert.match(stats.lastError.message, /429/);
  assert.ok(!JSON.stringify(stats).includes('test-key'));
  clock += 61_000;
  assert.equal(windy.stats().requestsLastMinute, 0);
});

/** A response recorder for the mounted middleware. */
function recorder() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v;
    },
    end(text = '') {
      this.body = String(text);
      resolve();
    },
  };
  return { res, done };
}

test('GET /api/cctv/status is served same-site only', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    {
      id: 'one',
      name: 'One',
      lat: 39.29,
      lon: -76.61,
      feedType: 'image',
      url: 'https://cams.example/one.jpg',
    },
  ]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const handlers = new Map();
  cctvProxy({
    sourceRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'gev-status-route-')),
  }).configureServer({
    middlewares: { use: (route, fn) => handlers.set(route, fn) },
    httpServer: { on() {} },
  });
  const handler = handlers.get('/api/cctv');
  const call = async (headers) => {
    const { res, done } = recorder();
    await handler(
      {
        url: '/status',
        method: 'GET',
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
        on() {},
      },
      res,
    );
    await done;
    return res;
  };
  const crossSite = await call({ origin: 'https://evil.example' });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(
    (await call({ 'sec-fetch-site': 'cross-site' })).statusCode,
    403,
  );
  const ok = await call({ 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  const body = JSON.parse(ok.body);
  assert.ok(Array.isArray(body.packs));
  assert.deepEqual(
    body.packs.find((p) => p.name === 'env'),
    {
      name: 'env',
      enabled: true,
      proximityOnly: false,
      available: 1,
      servedCapped: 1,
      inIndex: 1,
      dedupedAway: 0,
      lastRefreshAt: body.packs.find((p) => p.name === 'env').lastRefreshAt,
      lastError: null,
    },
  );
  assert.ok(body.frameCache && 'hitRate' in body.frameCache);
});
