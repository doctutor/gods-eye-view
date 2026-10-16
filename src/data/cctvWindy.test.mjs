import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WINDY_MAX_PER_QUERY,
  WINDY_CACHE_MS,
  WINDY_CREDIT,
  createWindySource,
  windyCacheKey,
  windyToSource,
} from '../../server/providers/cctv/windy.js';
import { interestFactor } from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

/** One v3 webcam record, shaped like the live payload (2026-10-16). */
const webcam = (fields = {}) => ({
  title: 'Wynnewood › North-east: Halethorpe Weather-Watch',
  webcamId: 1361567050,
  status: 'active',
  categories: [
    { id: 'city', name: 'City' },
    { id: 'meteo', name: 'Weather' },
  ],
  images: {
    current: {
      icon: 'https://imgproxy.windy.com/_/icon/plain/current/1361567050/original.jpg?v=2',
      thumbnail:
        'https://imgproxy.windy.com/_/thumbnail/plain/current/1361567050/original.jpg?v=2',
      preview:
        'https://imgproxy.windy.com/_/preview/plain/current/1361567050/original.jpg?v=2',
    },
  },
  location: {
    city: 'Wynnewood',
    region: 'Oklahoma',
    country_code: 'US',
    latitude: 39.23677,
    longitude: -76.69702,
  },
  urls: {
    detail: 'https://windy.com/webcams/1361567050',
    provider: 'https://www.halethorpeweather.com/wx11.php',
  },
  ...fields,
});

test('a Windy webcam becomes a display-only image source linked to its Windy page', () => {
  const source = windyToSource(webcam());
  assert.equal(source.id, 'windy-1361567050');
  assert.equal(source.feedType, 'image');
  assert.equal(source.snapshotUrl, webcam().images.current.preview);
  assert.equal(source.provider, 'Windy.com');
  assert.equal(source.credit, WINDY_CREDIT);
  assert.equal(source.operatorUrl, 'https://windy.com/webcams/1361567050');
  assert.equal(source.licenseClass, 'display-only');
  assert.equal(source.category, 'city', 'the scenic category, not weather');
  assert.equal(source.city, 'Wynnewood, Oklahoma');
  const normalized = normalizeSourceItem(source);
  assert.equal(normalized.licenseClass, 'display-only');
  assert.equal(normalized.operatorUrl, source.operatorUrl);
  assert.equal('embed' in normalized, false);
});

test('inactive, misplaced or off-host records are dropped', () => {
  for (const fields of [
    { status: 'inactive' },
    { webcamId: 'x' },
    { location: { latitude: 0, longitude: 0 } },
    { images: { current: { preview: 'https://evil.example/a.jpg' } } },
    { images: { current: { preview: 'http://imgproxy.windy.com/a.jpg' } } },
  ])
    assert.equal(windyToSource(webcam(fields)), null, JSON.stringify(fields));
  assert.equal(windyToSource(null), null);
});

test('scenic webcams rank nearer than traffic, and featured streams nearer still', () => {
  assert.equal(interestFactor(windyToSource(webcam())), 0.5);
  assert.equal(
    interestFactor(windyToSource(webcam({ categories: [{ id: 'traffic' }] }))),
    1,
  );
  assert.equal(interestFactor({ embed: { provider: 'youtube' } }), 0.25);
  assert.equal(interestFactor({ pack: 'mdot' }), 1);
});

function fakeWindy({ total = 3, fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (href, init) => {
    const url = new URL(href);
    calls.push({ url, key: init?.headers?.['x-windy-api-key'] });
    if (fail) return Response.json(fail.body, { status: fail.status });
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const webcams = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++)
      webcams.push(webcam({ webcamId: 1000000 + i, title: `Cam ${i}` }));
    return Response.json({ total, webcams });
  };
  return { fetchImpl, calls };
}

test('near pages through results, caches by cell, and remembers cameras for lookup', async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = fakeWindy({ total: 120 });
  const windy = createWindySource({
    fetchImpl,
    apiKey: () => 'k',
    now: () => clock,
  });
  const first = await windy.near(39.2904, -76.6122, 30);
  assert.equal(first.length, 120);
  assert.equal(calls.length, 3, 'three pages of 50');
  assert.ok(calls.every((c) => c.key === 'k'));
  assert.equal(calls[0].url.searchParams.get('nearby'), '39.3,-76.6,30');
  assert.equal(calls[0].url.searchParams.get('limit'), '50');
  assert.equal(calls[2].url.searchParams.get('offset'), '100');

  // Same cell, slightly different point and radius: served from cache.
  const again = await windy.near(39.2914, -76.6132, 28);
  assert.equal(again, first);
  assert.equal(calls.length, 3);

  // The cache expires.
  clock += WINDY_CACHE_MS + 1;
  await windy.near(39.2904, -76.6122, 30);
  assert.equal(calls.length, 6);

  assert.equal(windy.lookup('windy-1000007')?.name, 'Cam 7');
  assert.equal(windy.lookup('windy-9'), null);
});

test('the per-query cap and the request budget bound Windy traffic', async () => {
  let clock = 0;
  const { fetchImpl, calls } = fakeWindy({ total: 5000 });
  const windy = createWindySource({
    fetchImpl,
    apiKey: () => 'k',
    now: () => clock,
    maxPerQuery: () => DEFAULT_WINDY_MAX_PER_QUERY,
  });
  const result = await windy.near(0, 0, 250);
  assert.equal(result.length, DEFAULT_WINDY_MAX_PER_QUERY);
  assert.equal(calls.length, 3);
  // Many distinct cells in one minute: requests stop at the budget.
  for (let i = 0; i < 60; i++) await windy.near(10 + i, 10, 10);
  assert.ok(windy.requestsLastMinute() <= 120);
  assert.ok(calls.length < 63 * 3);
});

test('without a key, or when Windy fails, near yields nothing and never throws', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const quiet = createWindySource({
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
    apiKey: () => '',
  });
  assert.deepEqual(await quiet.near(39.29, -76.61, 10), []);

  const { fetchImpl } = fakeWindy({
    fail: { status: 401, body: { message: 'Unauthorized' } },
  });
  const broken = createWindySource({
    fetchImpl,
    apiKey: () => 'secret-windy-key',
  });
  assert.deepEqual(await broken.near(39.29, -76.61, 10), []);
  assert.ok(warnings.some((w) => w.includes('401')));
  assert.ok(warnings.every((w) => !w.includes('secret-windy-key')));
});

test('cache keys group nearby points and radius bands', () => {
  assert.equal(windyCacheKey(39.2904, -76.6122, 28), '39.3,-76.6,30');
  assert.equal(windyCacheKey(39.2904, -76.6122, 31), '39.3,-76.6,35');
  assert.notEqual(
    windyCacheKey(39.2904, -76.6122, 28),
    windyCacheKey(39.4, -76.6122, 28),
  );
});
