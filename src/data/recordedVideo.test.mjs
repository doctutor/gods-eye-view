import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_STORE_MS,
  QUERY_COST,
  SEARCH_TTL_MS,
  assignPrecision,
  createEntryStore,
  createRecordedVideoService,
  durationSeconds,
  isChannelDefault,
  searchCacheKey,
  wikidataToVideos,
  youtubeItemToVideo,
} from '../../server/providers/recordedVideo/videos.js';
import { createRecordedVideoHandler } from '../../server/providers/recordedVideo.js';
import { createYoutubeQuota } from '../../server/providers/cctv/featuredChannels.js';

const row = (q, video, coord, label = `Item ${q}`) => ({
  item: { value: `http://www.wikidata.org/entity/${q}` },
  itemLabel: { value: label },
  video: { value: video },
  coord: { value: coord },
});

test('Wikidata items with a video and Earth coordinates become exact pins', () => {
  const videos = wikidataToVideos([
    row(
      'Q125145943',
      'aBcDeFgHiJk',
      'Point(-76.5302 39.2156)',
      'Francis Scott Key Bridge collapse',
    ),
    row('Q125145943', 'aBcDeFgHiJk', 'Point(-76.5302 39.2156)'),
    row('Q2', 'bad id', 'Point(1 1)'),
    row(
      'Q3',
      'ZZZZZZZZZZZ',
      '<http://www.wikidata.org/entity/Q405> Point(23.47 0.67)',
      'Apollo 11 landing site',
    ),
    row('Q4', 'YYYYYYYYYYY', 'Point(0 0)'),
    row('bad', 'XXXXXXXXXXX', 'Point(1 1)'),
  ]);
  assert.deepEqual(videos, [
    {
      id: 'wd-Q125145943-aBcDeFgHiJk',
      videoId: 'aBcDeFgHiJk',
      title: 'Francis Scott Key Bridge collapse',
      place: 'Francis Scott Key Bridge collapse',
      wikidataId: 'Q125145943',
      lat: 39.2156,
      lon: -76.5302,
      coordinatesQuality: 'site',
      source: 'wikidata',
      licenseClass: 'embed-only',
      thumbnailUrl: 'https://i.ytimg.com/vi/aBcDeFgHiJk/hqdefault.jpg',
    },
  ]);
});

const item = (id, extra = {}) => ({
  id,
  snippet: {
    title: `Video ${id}`,
    channelTitle: 'Channel',
    publishedAt: '2026-10-01T00:00:00Z',
    liveBroadcastContent: 'none',
    ...(extra.snippet || {}),
  },
  contentDetails: { duration: extra.duration ?? 'PT4M10S' },
  recordingDetails:
    extra.location === null
      ? {}
      : {
          location: extra.location || {
            latitude: 39.2905,
            longitude: -76.6104,
          },
          ...(extra.place ? { locationDescription: extra.place } : {}),
        },
  statistics: { viewCount: '1200' },
});

test('Shorts, live streams and videos without a recording location are left out', () => {
  assert.equal(durationSeconds('PT4M10S'), 250);
  assert.equal(durationSeconds('PT1H'), 3600);
  assert.equal(durationSeconds('P1DT2S'), 86402);
  assert.ok(Number.isNaN(durationSeconds('P')));
  assert.ok(Number.isNaN(durationSeconds('4:10')));
  const kept = youtubeItemToVideo(
    item('aaaaaaaaaaa', { place: 'Fells Point' }),
  );
  assert.equal(kept.video.durationS, 250);
  assert.equal(kept.video.views, 1200);
  assert.equal(kept.video.place, 'Fells Point');
  assert.equal(kept.video.source, 'youtube-geotag');
  assert.deepEqual(
    youtubeItemToVideo(item('bbbbbbbbbbb', { duration: 'PT59S' })),
    { skip: 'short' },
  );
  assert.deepEqual(
    youtubeItemToVideo(item('ccccccccccc', { duration: 'PT1M' })),
    { skip: 'short' },
    '60 s is a Short',
  );
  assert.ok(
    youtubeItemToVideo(item('ddddddddddd', { duration: 'PT1M1S' })).video,
  );
  assert.ok(
    youtubeItemToVideo(item('ddddddddddd', { duration: 'PT30S' }), {
      keepShorts: true,
    }).video,
  );
  assert.deepEqual(
    youtubeItemToVideo(
      item('eeeeeeeeeee', { snippet: { liveBroadcastContent: 'live' } }),
    ),
    { skip: 'live' },
  );
  assert.deepEqual(
    youtubeItemToVideo(item('fffffffffff', { location: null })),
    { skip: 'no-location' },
  );
  assert.deepEqual(
    youtubeItemToVideo(
      item('ggggggggggg', { location: { latitude: 0, longitude: 0 } }),
    ),
    { skip: 'no-location' },
  );
  assert.deepEqual(youtubeItemToVideo({ id: 'short' }), { skip: 'invalid' });
});

const at = (lat, lon, n, prefix) =>
  Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${i}`, lat, lon }));

test('precision: shared geotags are a place list’s pin, a town centre is a region', async () => {
  const videos = [
    ...at(39.28351, -76.62191, 1, 'solo'),
    ...at(39.17, -76.66, 3, 'three'),
    ...at(39.29, -76.61, 4, 'four'),
    ...at(39.20371, -76.86105, 10, 'columbia'),
  ];
  const asked = [];
  const result = await assignPrecision(videos, {
    isLocality: async (lat, lon) => {
      asked.push(`${lat},${lon}`);
      return lat === 39.20371;
    },
  });
  const quality = (prefix) => [
    ...new Set(
      result
        .filter((v) => v.videoId.startsWith(prefix))
        .map((v) => v.coordinatesQuality),
    ),
  ];
  assert.deepEqual(quality('solo'), ['site']);
  assert.deepEqual(
    quality('three'),
    ['site'],
    'two others sharing: still a site',
  );
  assert.deepEqual(
    quality('four'),
    ['area'],
    'three others sharing: a place list pin',
  );
  assert.deepEqual(quality('columbia'), ['region']);
  assert.equal(result.find((v) => v.videoId === 'four0').sharedBy, 3);
  assert.deepEqual(
    asked.sort(),
    [
      '39.17,-76.66',
      '39.20371,-76.86105',
      '39.28351,-76.62191',
      '39.29,-76.61',
    ],
    'shared coordinates, and the lone one too',
  );
  // Without a locality check, sharing alone decides.
  assert.equal(
    (await assignPrecision(at(1, 1, 5, 'x')))[0].coordinatesQuality,
    'area',
  );
});

test('the search cache key groups nearby views and radius bands', () => {
  assert.equal(
    searchCacheKey(39.2904, -76.6122, 25, 'relevance'),
    '39.30,-76.60,25,relevance',
  );
  assert.equal(
    searchCacheKey(39.31, -76.62, 22, 'relevance'),
    searchCacheKey(39.29, -76.61, 25, 'relevance'),
  );
  assert.notEqual(
    searchCacheKey(39.29, -76.61, 26, 'relevance'),
    searchCacheKey(39.29, -76.61, 25, 'relevance'),
  );
});

/** A fake YouTube + Wikidata + Geocoding upstream. */
function upstream({
  searchIds = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'],
  items = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    calls.push(url);
    if (url.hostname === 'query.wikidata.org')
      return Response.json({
        results: {
          bindings: [row('Q1', 'aBcDeFgHiJk', 'Point(-76.53 39.21)')],
        },
      });
    if (url.hostname === 'maps.googleapis.com')
      return Response.json({ status: 'ZERO_RESULTS', results: [] });
    const resource = url.pathname.split('/').pop();
    if (resource === 'search')
      return Response.json({
        items: searchIds.map((videoId) => ({
          id: { kind: 'youtube#video', videoId },
        })),
      });
    if (resource === 'videos') {
      const ids = url.searchParams.get('id').split(',');
      return Response.json({
        items:
          items ||
          ids.map((id, i) =>
            item(id, {
              duration: i === 2 ? 'PT45S' : 'PT3M',
              location: { latitude: 39.29 + i / 100, longitude: -76.61 },
            }),
          ),
      });
    }
    return new Response('?', { status: 404 });
  };
  return {
    fetchImpl,
    calls,
    count: (r) => calls.filter((u) => u.pathname.endsWith(`/${r}`)).length,
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-recorded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a search costs 101 units, is reused for a week and refused past the daily budget', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  let clock = Date.parse('2026-10-16T18:00:00Z');
  const service = createRecordedVideoService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => 'test-key',
    now: () => clock,
    env: { RECORDED_VIDEO_DAILY_BUDGET: '250' },
    isLocality: null,
  });
  const first = await service.near(39.2904, -76.6122, 25);
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.returned, 3);
  assert.deepEqual(first.body.skipped, {
    short: 1,
    live: 0,
    'no-location': 0,
    invalid: 0,
  });
  assert.deepEqual(
    first.body.videos.map((v) => v.videoId),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
  );
  assert.deepEqual(first.body.quota, {
    used: QUERY_COST,
    budget: 250,
    remaining: 250 - QUERY_COST,
  });
  const search = api.calls.find((u) => u.pathname.endsWith('/search'));
  assert.equal(search.searchParams.get('type'), 'video');
  assert.equal(search.searchParams.get('locationRadius'), '25km');
  assert.equal(search.searchParams.get('maxResults'), '50');
  assert.equal(search.searchParams.get('order'), 'relevance');
  assert.match(
    api.calls
      .find((u) => u.pathname.endsWith('/videos'))
      .searchParams.get('part'),
    /recordingDetails/,
  );
  // The same cell and band: answered from the store, no units.
  const again = await service.near(39.31, -76.62, 22);
  assert.equal(again.body.cached, true);
  assert.equal(api.count('search'), 1);
  // Radius is clamped to 50 km.
  await service.near(40.5, -75, 400);
  assert.equal(
    api.calls
      .filter((u) => u.pathname.endsWith('/search'))
      .at(-1)
      .searchParams.get('locationRadius'),
    '50km',
  );
  assert.equal(service.quota().used, 2 * QUERY_COST);
  // A third distinct search would pass 250 units: refused, nothing fetched.
  const refused = await service.near(10, 10, 10);
  assert.equal(refused.status, 429);
  assert.equal(api.count('search'), 2);
  // The shared quota file carries this feature's share for the featured watcher too.
  const shared = createYoutubeQuota({
    now: () => clock,
    file: path.join(root, '.gev-cache', 'cctv-featured', 'quota.json'),
  });
  assert.equal(shared.used(), 2 * QUERY_COST);
  assert.equal(shared.usedBy('recordedVideo'), 2 * QUERY_COST);
  shared.spend(3);
  assert.equal(
    service.quota().used,
    2 * QUERY_COST,
    'other features’ units are not this budget',
  );
  assert.equal(shared.used(), 2 * QUERY_COST + 3);
  // After a week the answer is asked again (and the next day has a fresh budget).
  clock += SEARCH_TTL_MS + 1;
  const later = await service.near(39.2904, -76.6122, 25);
  assert.equal(later.body.cached, false);
  assert.equal(api.count('search'), 3);
});

test('without a key the search says so and spends nothing', async (t) => {
  const root = await tempRoot(t);
  const api = upstream();
  const service = createRecordedVideoService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
    env: {},
    isLocality: null,
  });
  const result = await service.near(39.29, -76.61, 10);
  assert.deepEqual(result.body.videos, []);
  assert.equal(result.body.configured, false);
  assert.equal(api.calls.length, 0);
  assert.equal((await service.near(999, 0, 10)).status, 400);
});

test('stored answers are swept by age: a week for searches, 30 days for anything', async (t) => {
  const root = await tempRoot(t);
  let clock = 1_000_000_000;
  const file = path.join(root, 'store.json');
  const store = createEntryStore(file, {
    maxAgeMs: SEARCH_TTL_MS,
    now: () => clock,
  });
  store.set('a', { result: 1 });
  clock += SEARCH_TTL_MS - 1000;
  store.set('b', { result: 2 });
  assert.equal(store.size(), 2);
  clock += 2000;
  assert.equal(store.get('a'), null, 'past its age it is gone');
  assert.equal(store.sweep(), 1);
  assert.deepEqual(
    Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).entries),
    ['b'],
  );
  // The service sweeps both of its stores (two videos share a point, so
  // that point is looked up as a possible town centre).
  const api = upstream({
    searchIds: ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
    items: ['aaaaaaaaaaa', 'bbbbbbbbbbb'].map((id) => item(id)),
  });
  clock = Date.parse('2026-10-16T18:00:00Z');
  const service = createRecordedVideoService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => 'k',
    now: () => clock,
    env: {},
    googleApiKey: () => 'g-key',
  });
  await service.near(39.29, -76.61, 10);
  const dir = path.join(root, '.gev-cache', 'recorded-video');
  assert.ok((await fs.readdir(dir)).includes('searches.json'));
  assert.ok(
    (await fs.readdir(dir)).includes('localities.json'),
    'shared coordinates were looked up',
  );
  clock += MAX_STORE_MS + 1;
  assert.ok(service.sweep() >= 2);
  for (const name of ['searches.json', 'localities.json'])
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')).entries,
      {},
    );
});

test('Wikidata videos are fetched once a week and kept on disk', async (t) => {
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  const service = createRecordedVideoService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
    env: {},
  });
  assert.equal((await service.wikidataVideos()).length, 1);
  assert.equal((await service.wikidataVideos()).length, 1);
  assert.equal(
    api.calls.filter((u) => u.hostname === 'query.wikidata.org').length,
    1,
  );
  assert.ok(
    (
      await fs.readdir(path.join(root, '.gev-cache', 'recorded-video'))
    ).includes('recorded-video-wikidata.json'),
  );
});

test('the routes are same-site only, GET only, and check their input', async () => {
  const service = {
    wikidataVideos: async () => [{ videoId: 'aBcDeFgHiJk' }],
    near: async (lat, lon, radiusKm, options) => ({
      status: 200,
      body: { lat, lon, radiusKm, refresh: options.refresh, videos: [] },
    }),
  };
  const handler = createRecordedVideoHandler({ service });
  const call = async (url, { method = 'GET', headers = {} } = {}) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(n, v) {
        this.headers[n.toLowerCase()] = v;
      },
      end(text) {
        this.body = JSON.parse(text);
      },
    };
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4176', ...headers },
        socket: {},
      },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  assert.equal(
    (await call('/wikidata', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  assert.equal(
    (await call('/?near=1,1', { headers: { 'sec-fetch-site': 'cross-site' } }))
      .statusCode,
    403,
  );
  assert.equal((await call('/wikidata', { method: 'POST' })).statusCode, 405);
  assert.equal((await call('/')).statusCode, 400);
  assert.equal((await call('/?near=nope')).statusCode, 400);
  assert.deepEqual((await call('/?near=39.29,-76.61&radiusKm=12')).body, {
    lat: 39.29,
    lon: -76.61,
    radiusKm: 12,
    refresh: false,
    videos: [],
  });
  assert.equal(
    (await call('/?near=39.29,-76.61&radiusKm=12&refresh=1')).body.refresh,
    true,
  );
  assert.equal((await call('/wikidata')).body.videos.length, 1);
  assert.equal((await call('/other')).nexted, true);
});

test('a town centre already known needs no lookup; lone geotags get at most five, nearest first', async () => {
  const columbia = { lat: 39.20371, lon: -76.86105 };
  const asked = [];
  const isLocality = async (lat, lon) => {
    asked.push(`${lat.toFixed(3)},${lon.toFixed(3)}`);
    return lat > 39.4;
  };
  const videos = [
    { videoId: 'nearCentre0', ...columbia, lat: columbia.lat + 0.0005 },
    ...Array.from({ length: 8 }, (_, i) => ({
      videoId: `lone${i}`,
      lat: 39.3 + i * 0.03,
      lon: -76.6,
    })),
  ];
  const result = await assignPrecision(videos, {
    isLocality,
    knownCentres: () => [columbia],
    centre: { lat: 39.3, lon: -76.6 },
  });
  const byId = Object.fromEntries(
    result.map((v) => [v.videoId, v.coordinatesQuality]),
  );
  assert.equal(byId.nearCentre0, 'region', 'within 300 m of a known centre');
  assert.equal(asked.length, 5, 'five lone lookups at most');
  assert.deepEqual(asked, [
    '39.300,-76.600',
    '39.330,-76.600',
    '39.360,-76.600',
    '39.390,-76.600',
    '39.420,-76.600',
  ]);
  assert.equal(byId.lone4, 'region');
  assert.equal(byId.lone7, 'site', 'beyond the five: not looked up');
  // A centre learned during the answer covers a neighbour in the same answer.
  const learned = [];
  const second = await assignPrecision(
    [
      { videoId: 'a', lat: 40, lon: -76 },
      { videoId: 'b', lat: 40.0008, lon: -76 },
    ],
    {
      isLocality: async (lat, lon) => {
        learned.push({ lat, lon });
        return true;
      },
      knownCentres: () => learned,
      maxSingletonLookups: 1,
    },
  );
  assert.deepEqual(
    second.map((v) => v.coordinatesQuality),
    ['region', 'region'],
  );
});

test('a coordinate one channel uses on different days is its default: area at best', async () => {
  const pin = { lat: 39.1, lon: -76.7 };
  const video = (videoId, channelTitle, publishedAt) => ({
    videoId,
    channelTitle,
    publishedAt,
    ...pin,
  });
  assert.ok(
    isChannelDefault([
      video('a', 'Gardens', '2026-05-01T10:00:00Z'),
      video('b', 'Gardens', '2026-06-01T10:00:00Z'),
    ]),
  );
  assert.ok(
    !isChannelDefault([
      video('a', 'Gardens', '2026-05-01T10:00:00Z'),
      video('b', 'Gardens', '2026-05-01T18:00:00Z'),
    ]),
    'one day: one shoot',
  );
  assert.ok(
    !isChannelDefault([
      video('a', 'Gardens', '2026-05-01T10:00:00Z'),
      video('b', 'News', '2026-06-01T10:00:00Z'),
    ]),
  );
  const result = await assignPrecision([
    video('a', 'Gardens', '2026-05-01T10:00:00Z'),
    video('b', 'Gardens', '2026-06-01T10:00:00Z'),
  ]);
  assert.deepEqual(
    result.map((v) => v.coordinatesQuality),
    ['area', 'area'],
  );
  // A town centre still wins.
  const town = await assignPrecision(
    [
      video('a', 'Gardens', '2026-05-01T10:00:00Z'),
      video('b', 'Gardens', '2026-06-01T10:00:00Z'),
    ],
    { knownCentres: () => [pin] },
  );
  assert.deepEqual(
    town.map((v) => v.coordinatesQuality),
    ['region', 'region'],
  );
});

test('SEARCH AGAIN asks YouTube again for the cell, within the budget', async (t) => {
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  const service = createRecordedVideoService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => 'k',
    env: { RECORDED_VIDEO_DAILY_BUDGET: '210' },
    isLocality: null,
  });
  await service.near(39.29, -76.61, 10);
  assert.equal((await service.near(39.29, -76.61, 10)).body.cached, true);
  const again = await service.near(39.29, -76.61, 10, { refresh: true });
  assert.equal(again.body.cached, false);
  assert.equal(api.count('search'), 2);
  assert.equal(again.body.quota.remaining, 210 - 2 * QUERY_COST);
  // The refreshed answer is what the cell serves now; past the budget a refresh is refused.
  assert.equal(
    (await service.near(39.29, -76.61, 10, { refresh: true })).status,
    429,
  );
  assert.equal((await service.near(39.29, -76.61, 10)).body.cached, true);
});
