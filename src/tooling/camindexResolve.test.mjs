// Personal fork: OpenCCTV cameras resolved to their operators' own feeds
// (scripts/camindex/resolve.mjs, adapters/opencctv.mjs parsePrimary,
// catalog.mjs primaryFeedFields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFetcher } from '../../scripts/camindex/fetch.mjs';
import {
  operatorFeedUrl,
  parseCameraPage,
  parsePrimary,
} from '../../scripts/camindex/adapters/opencctv.mjs';
import {
  LIVENESS_DAILY_UNITS,
  LIVENESS_FEATURE,
  RESOLVE_MAX_AGE_MS,
  checkYoutubeLiveness,
  judgePage,
  resolveCandidates,
  resolveDue,
  resolveQueue,
  youtubeStatus,
} from '../../scripts/camindex/resolve.mjs';
import {
  buildCatalog,
  foldObserved,
  openCctvToSource,
  primaryFeedFields,
} from '../../scripts/camindex/catalog.mjs';
import { livenessCommand, nearOf } from '../../scripts/camindex/index.mjs';
import {
  createYoutubeClient,
  createYoutubeQuota,
} from '../../server/providers/cctv/featuredChannels.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/camindex/fixtures',
);
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), 'utf8');
const MONTEREY =
  'https://opencctv.org/cameras/united-states/california/monterey-bay-aquarium-411073';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-resolve-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a camera page names its operator feed: YouTube, HLS, an image; never the directory’s proxy', async () => {
  const youtube = await fixture('opencctv-camera-youtube.html');
  assert.deepEqual(parsePrimary(youtube), {
    kind: 'youtube',
    videoId: 'fVa6-zCBR7A',
  });
  // The page is a VideoObject: it parses, with its feed, and no still.
  const page = parseCameraPage(youtube, MONTEREY);
  assert.equal(page.id, '411073');
  assert.equal(page.name, 'Monterey Bay Aquarium');
  assert.ok(Math.abs(page.lat - 36.6187) < 1e-3);
  assert.deepEqual(page.primary, { kind: 'youtube', videoId: 'fVa6-zCBR7A' });
  assert.deepEqual(page.categories, ['nature']);
  assert.deepEqual(parsePrimary(await fixture('opencctv-camera-hls.html')), {
    kind: 'hls',
    url: 'https://video-auth1.iol.pt/beachcam/bcfigueiradois/playlist.m3u8',
  });
  assert.deepEqual(parsePrimary(await fixture('opencctv-camera-image.html')), {
    kind: 'image',
    url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg',
  });
  // OpenCCTV's own /api/hls proxy (robots-disallowed) is not a feed.
  assert.equal(
    parsePrimary(await fixture('opencctv-camera-proxied.html')),
    null,
  );
  // A still camera's page names nothing.
  assert.equal(parsePrimary(await fixture('opencctv-camera-984.html')), null);
});

test('only https feeds on named operator hosts are taken', () => {
  const container = (attrs) => `<div id="feed-container" ${attrs}></div>`;
  assert.equal(operatorFeedUrl('https://opencctv.org/api/hls/x'), '');
  assert.equal(operatorFeedUrl('http://cams.example.org/a.m3u8'), '');
  assert.equal(operatorFeedUrl('https://10.0.0.5/a.jpg'), '');
  assert.equal(operatorFeedUrl('https://cams.local/a.jpg'), '');
  assert.equal(operatorFeedUrl('https://user:pw@cams.example.org/a.jpg'), '');
  assert.equal(
    operatorFeedUrl('https://cams.example.org/a.jpg?x=1&amp;y=2#f'),
    'https://cams.example.org/a.jpg?x=1&y=2',
    'entities decoded, fragment dropped',
  );
  assert.deepEqual(
    parsePrimary(
      container(
        'data-type="mjpeg" data-stream="https://cams.example.org/video.mjpg"',
      ),
    ),
    { kind: 'mjpeg', url: 'https://cams.example.org/video.mjpg' },
  );
  assert.equal(
    parsePrimary(
      container('data-type="m3u8" data-src="https://cams.example.org/live"'),
    ),
    null,
    'an HLS feed is a .m3u8 playlist',
  );
  // Another operator's player page in the iframe is only a link.
  assert.deepEqual(
    parsePrimary(
      '<div id="feed-container" data-type="iframe"><iframe id="camera-feed" src="https://player.brownrice.com/embed/x"></iframe></div>',
    ),
    { kind: 'link', url: 'https://player.brownrice.com/embed/x' },
  );
  // The JSON-LD embedUrl is read when the iframe is missing.
  assert.deepEqual(
    parsePrimary(
      '<script type="application/ld+json">{"@type":"VideoObject","embedUrl":"https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1"}</script>',
    ),
    { kind: 'youtube', videoId: 'abcdefghijk' },
  );
  assert.equal(
    parsePrimary(
      '<iframe id="camera-feed" src="https://www.youtube.com/embed/short"></iframe>',
    ),
    null,
  );
});

const candidate = (id, lat, lon, categories = ['nature'], extra = {}) => ({
  id,
  name: `Camera ${id}`,
  pageUrl: `https://opencctv.org/cameras/somewhere/camera-${id}`,
  lat,
  lon,
  categories,
  stillUrl: `https://opencctv.org/still/${id}.jpg`,
  ...extra,
});

test('resolve goes near recent views first, then scenic, then the rest, and skips what it read this week', () => {
  const now = Date.UTC(2026, 9, 17);
  const candidates = [
    candidate('1', 10, 10, ['traffic']),
    candidate('2', 39.3, -76.6, ['traffic']),
    candidate('3', 20, 20, ['beach']),
    candidate('4', 39.29, -76.61, ['traffic']),
    candidate('5', 30, 30, ['ski']),
    candidate('6', 30, 31, ['ski']),
    candidate('7', NaN, NaN),
  ];
  const records = {
    5: { status: 'none', resolvedAt: now - 60_000 },
    6: { status: 'error', resolvedAt: now - 60_000 },
  };
  const queue = resolveQueue({
    candidates,
    records,
    views: [{ lat: 39.29, lon: -76.61 }],
    now,
  });
  assert.deepEqual(
    queue.map((c) => c.id),
    ['4', '2', '3', '6', '1'],
    'near the view (nearest first), scenic, the rest; a fresh read skipped, an error retried',
  );
  assert.equal(resolveDue({ resolvedAt: now - RESOLVE_MAX_AGE_MS }, now), true);
  assert.deepEqual(
    resolveQueue({
      candidates,
      records,
      near: nearOf('39.29,-76.61'),
      radiusKm: 20,
      now,
    })
      .map((c) => c.id)
      .sort(),
    ['2', '4'],
    'only those within the radius',
  );
  assert.throws(() => nearOf('nowhere'), /lat,lon/);
});

function fakeWeb(routes) {
  let clock = 1_000_000;
  const calls = [];
  return {
    calls,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    transport: async (url) => {
      calls.push(url);
      const route = routes[url];
      if (route === undefined) return new Response('missing', { status: 404 });
      const [status, body] = route;
      return new Response(body, {
        status,
        headers: { 'content-type': 'text/html' },
      });
    },
  };
}

test('a resolve run records each page, paces them, and stops at its limit, its clock or a block', async (t) => {
  const dir = await tempDir(t);
  const youtube = await fixture('opencctv-camera-youtube.html');
  const still = await fixture('opencctv-camera-984.html');
  const cams = [
    candidate('411073', 36.6, -121.9),
    candidate('984', 59.6, -151.5),
    candidate('5', 1, 1),
    candidate('6', 2, 2),
  ];
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': [
      200,
      'User-agent: *\nAllow: /cameras/\nDisallow: /api/\n',
    ],
    [cams[0].pageUrl]: [200, youtube],
    [cams[1].pageUrl]: [200, still],
    [cams[2].pageUrl]: [503, 'busy'],
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
    minIntervalMs: 2000,
  });
  const records = {};
  const seen = [];
  const run = await resolveCandidates(fetcher, cams, records, {
    now: web.now,
    onRecord: (c) => seen.push(c.id),
  });
  assert.deepEqual(records['411073'].primary, {
    kind: 'youtube',
    videoId: 'fVa6-zCBR7A',
  });
  assert.equal(records['411073'].status, 'resolved');
  assert.equal(records['984'].status, 'none');
  assert.equal(records['5'].status, 'error', 'a busy answer is retried later');
  assert.equal(records['6'].status, 'gone');
  assert.deepEqual(seen, ['411073', '984', '5', '6']);
  assert.deepEqual(run.byKind, { youtube: 1 });
  assert.equal(run.resolved, 1);
  assert.equal(run.stoppedBy, 'complete');
  // Cached a week: a second run reads nothing new.
  const before = web.calls.length;
  await resolveCandidates(fetcher, cams.slice(0, 2), {}, { now: web.now });
  assert.equal(web.calls.length, before);
  // A limit, and a wall-clock cap.
  assert.equal(
    (await resolveCandidates(fetcher, cams, {}, { limit: 1, now: web.now }))
      .stoppedBy,
    'limit',
  );
  let clock = 0;
  const time = await resolveCandidates(
    fetcher,
    cams,
    {},
    {
      maxMs: 1,
      now: () => (clock += 5),
    },
  );
  assert.equal(time.stoppedBy, 'time');
  assert.deepEqual(judgePage(null, null, 7), {
    resolvedAt: 7,
    status: 'error',
    reason: 'no answer',
  });
});

test('a resolved camera is emitted in its feed’s shape, with provenance; a link keeps the still', () => {
  const still = 'https://opencctv.org/still/411073.jpg';
  const cam = candidate('411073', 36.6187, -121.9025, ['nature'], {
    stillUrl: still,
  });
  const at = Date.UTC(2026, 9, 17, 17);
  const youtube = openCctvToSource(
    cam,
    { status: 'dead' },
    {
      status: 'resolved',
      resolvedAt: at,
      primary: { kind: 'youtube', videoId: 'fVa6-zCBR7A' },
    },
  );
  assert.equal(youtube.id, 'opencctv-411073');
  assert.equal(youtube.feedType, 'youtube');
  assert.deepEqual(youtube.embed, {
    provider: 'youtube',
    videoId: 'fVa6-zCBR7A',
  });
  assert.equal(youtube.url, 'https://www.youtube.com/watch?v=fVa6-zCBR7A');
  assert.equal(
    youtube.snapshotUrl,
    'https://i.ytimg.com/vi/fVa6-zCBR7A/hqdefault.jpg',
  );
  assert.equal(youtube.publishSignal, 'directory-still');
  assert.equal(youtube.primaryVia, 'opencctv');
  assert.equal(youtube.licenseClass, 'embed-only');
  assert.equal(youtube.resolvedAt, '2026-10-17T17:00:00.000Z');
  assert.equal(
    youtube.liveStatus,
    'unknown',
    'a still’s verdict is not the stream’s',
  );
  assert.equal(youtube.operatorUrl, cam.pageUrl);
  assert.deepEqual(
    primaryFeedFields(
      { kind: 'hls', url: 'https://cams.example.org/live.m3u8' },
      still,
    ),
    {
      feedType: 'hls',
      url: 'https://cams.example.org/live.m3u8',
      snapshotUrl: '',
    },
  );
  assert.deepEqual(
    primaryFeedFields(
      { kind: 'image', url: 'https://cams.example.org/a.jpg' },
      still,
    ),
    {
      feedType: 'image',
      url: 'https://cams.example.org/a.jpg',
      snapshotUrl: 'https://cams.example.org/a.jpg',
      fallbackSnapshotUrl: still,
    },
    'the operator image, the directory still behind it',
  );
  assert.deepEqual(
    primaryFeedFields(
      { kind: 'mjpeg', url: 'https://cams.example.org/v.mjpg' },
      still,
    ),
    {
      feedType: 'mjpeg',
      url: 'https://cams.example.org/v.mjpg',
      snapshotUrl: still,
    },
  );
  const link = openCctvToSource(cam, null, {
    primary: { kind: 'link', url: 'https://player.brownrice.com/x' },
  });
  assert.equal(link.feedType, 'image');
  assert.equal(link.url, still);
  assert.equal(link.primaryVia, undefined);
  // The page's primary from discover counts when resolve has none.
  assert.equal(
    openCctvToSource({
      ...cam,
      primary: { kind: 'youtube', videoId: 'fVa6-zCBR7A' },
    }).feedType,
    'youtube',
  );
});

test('the catalog serves a resolved stream whatever the directory still’s verdict, and counts it', () => {
  const catalog = buildCatalog(
    {
      opencctv: {
        candidates: [
          candidate('1', 36.6, -121.9),
          candidate('2', 36.7, -121.9),
          candidate('3', 36.8, -121.9, ['nature'], { stillUrl: '' }),
        ],
        records: { 1: { status: 'dead' }, 2: { status: 'dead' } },
        resolved: {
          1: {
            status: 'resolved',
            resolvedAt: 5,
            primary: { kind: 'youtube', videoId: 'fVa6-zCBR7A' },
          },
          3: {
            status: 'resolved',
            resolvedAt: 5,
            primary: { kind: 'hls', url: 'https://cams.example.org/a.m3u8' },
          },
        },
      },
    },
    { now: () => 0 },
  );
  assert.deepEqual(
    catalog.cameras.map((c) => [c.id, c.feedType]),
    [
      ['opencctv-1', 'youtube'],
      ['opencctv-3', 'hls'],
    ],
    'a dead still without a feed goes; a camera with no still but a feed stays',
  );
  assert.equal(catalog.sources.opencctv.resolved, 2);
});

test('YouTube liveness: 50 ids a call, within the day’s 200 units, answers as observations', async (t) => {
  const dir = await tempDir(t);
  const quotaFile = path.join(dir, 'quota.json');
  const calls = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    calls.push(url);
    const ids = url.searchParams.get('id').split(',');
    return Response.json({
      items: ids
        .filter((id) => !id.startsWith('gone'))
        .map((id) => ({
          id,
          snippet: {
            liveBroadcastContent: id.startsWith('live')
              ? 'live'
              : id.startsWith('soon')
                ? 'upcoming'
                : 'none',
          },
          status: {
            privacyStatus: id.startsWith('priv') ? 'private' : 'public',
            embeddable: true,
          },
        })),
    });
  };
  const quota = createYoutubeQuota({ file: quotaFile });
  const youtube = createYoutubeClient({
    fetchImpl,
    apiKey: () => 'test-key',
    quota,
    feature: LIVENESS_FEATURE,
  });
  const id = (prefix, n) =>
    `${prefix}${String(n).padStart(11 - prefix.length, '0')}`;
  const cameras = [
    ...Array.from({ length: 60 }, (_, n) => ({
      id: `opencctv-${n}`,
      feedType: 'youtube',
      embed: { provider: 'youtube', videoId: id('live', n) },
    })),
    {
      id: 'opencctv-a',
      feedType: 'youtube',
      embed: { videoId: id('gone', 1) },
    },
    {
      id: 'opencctv-b',
      feedType: 'youtube',
      embed: { videoId: id('priv', 1) },
    },
    {
      id: 'opencctv-c',
      feedType: 'youtube',
      embed: { videoId: id('soon', 1) },
    },
    {
      id: 'opencctv-d',
      feedType: 'youtube',
      embed: { videoId: id('ended', 1) },
    },
    // The same stream listed twice: one id asked, both answered.
    {
      id: 'opencctv-e',
      feedType: 'youtube',
      embed: { videoId: id('ended', 1) },
    },
    { id: 'opencctv-f', feedType: 'image' },
  ];
  const result = await checkYoutubeLiveness({
    cameras,
    youtube,
    quota,
    now: () => 42,
  });
  assert.equal(calls.length, 2, '64 ids: two calls of up to 50');
  assert.equal(result.units, 2);
  assert.equal(result.checked, 64);
  assert.equal(quota.usedBy(LIVENESS_FEATURE), 2, 'counted in the shared file');
  assert.equal(calls[0].searchParams.get('part'), 'snippet,status');
  assert.deepEqual(result.observations['opencctv-a'], {
    status: 'dead',
    at: 42,
    by: 'youtube',
  });
  assert.equal(result.observations['opencctv-b'].status, 'dead');
  assert.equal(result.observations['opencctv-c'].status, 'upcoming');
  assert.equal(result.observations['opencctv-d'].status, 'offline');
  assert.equal(result.observations['opencctv-e'].status, 'offline');
  assert.equal(result.observations['opencctv-0'].status, 'live');
  assert.equal(result.observations['opencctv-f'], undefined);
  // The day's cap: nothing past it.
  const capped = await checkYoutubeLiveness({
    cameras,
    youtube,
    quota,
    cap: 3,
  });
  assert.equal(capped.units, 1);
  assert.equal(capped.stoppedBy, 'daily cap');
  assert.equal(LIVENESS_DAILY_UNITS, 200);
  assert.equal(youtubeStatus(undefined), 'dead');
  // Without a key nothing is asked.
  const none = await checkYoutubeLiveness({
    cameras,
    youtube: { hasKey: () => false, call: () => assert.fail('no call') },
    quota,
  });
  assert.equal(none.stoppedBy, 'no key');
  // The command writes them to observed.json, where build does not fold them
  // into the still's verify records.
  await fs.writeFile(
    path.join(dir, 'catalog.json'),
    JSON.stringify({
      cameras: cameras.slice(60).map((c) => ({ ...c, primaryVia: 'opencctv' })),
    }),
  );
  t.mock.method(console, 'log', () => {});
  const summary = await livenessCommand(dir, {}, { youtube, quota });
  assert.equal(summary.checked, 4);
  const observed = JSON.parse(
    await fs.readFile(path.join(dir, 'observed.json'), 'utf8'),
  );
  assert.equal(observed['opencctv-a'].by, 'youtube');
  const records = {};
  assert.equal(foldObserved(records, observed), 0);
  assert.deepEqual(records, {});
});
