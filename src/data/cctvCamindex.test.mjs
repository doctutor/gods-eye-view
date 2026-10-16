import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  camindexCatalogPath,
  catalogCameraToSource,
  createCamindexLoader,
  isPublicHost,
  validTimeZone,
} from '../../server/providers/cctv/camindex.js';
import {
  createCctvCatalog,
  interestFactor,
} from '../../server/providers/cctv/catalog.js';
import {
  FRAME_CACHE_MAX_TTL_MS,
  createFrameCache,
  freshnessMs,
} from '../../server/providers/cctv/frameCache.js';
import { fetchCctvImageFromUpstream } from '../../server/providers/cctv/media.js';
import { cameraTag } from '../ui/cctvCameraList.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

// Personal fork: the camindex pack (server/providers/cctv/camindex.js) and
// the upstream frame cache (frameCache.js).

const PAGE =
  'https://opencctv.org/cameras/united-states/maryland/baltimore/peregrine-falcons-212832';
const camera = (over = {}) => ({
  id: 'opencctv-212832',
  name: 'Peregrine Falcons',
  city: 'Baltimore, Maryland, US',
  cityId: 'opencctv',
  provider: 'OpenCCTV',
  credit: 'opencctv.org',
  lat: 39.2867,
  lon: -76.6122,
  headingConfidence: 'low',
  rangeM: 150,
  sourceKind: 'opencctv',
  license: 'Listed by opencctv.org',
  category: 'nature',
  coordinatesQuality: 'site',
  operatorUrl: PAGE,
  publishSignal: 'directory-still',
  licenseClass: 'display-only',
  feedType: 'image',
  url: 'https://opencctv.org/still/212832.jpg',
  snapshotUrl: 'https://opencctv.org/still/212832.jpg',
  liveStatus: 'live',
  ...over,
});

async function catalogDir(t, cameras) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-camindex-pack-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.gev-cache', 'camindex'), { recursive: true });
  const file = path.join(dir, '.gev-cache', 'camindex', 'catalog.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      generatedAt: '2026-10-16T00:00:00Z',
      sources: {},
      cameras,
    }),
  );
  return { dir, file };
}

test('catalog cameras are checked again on the way in', () => {
  const source = catalogCameraToSource(camera());
  assert.equal(source.id, 'opencctv-212832');
  assert.ok(Number.isNaN(source.headingDeg));
  assert.equal(source.feedType, 'image');
  assert.equal(source.snapshotUrl, 'https://opencctv.org/still/212832.jpg');
  assert.equal(source.embed, undefined);
  for (const bad of [
    { id: 'Bad Id!' },
    { lat: 0, lon: 0 },
    { lat: 95 },
    { snapshotUrl: 'http://opencctv.org/still/1.jpg' },
    { snapshotUrl: 'javascript:alert(1)' },
    { feedType: 'hls' },
    { liveStatus: 'offline' },
  ])
    assert.equal(catalogCameraToSource(camera(bad)), null, JSON.stringify(bad));
  assert.equal(
    catalogCameraToSource(camera({ operatorUrl: 'javascript:x' })).operatorUrl,
    '',
  );
  assert.equal(
    catalogCameraToSource(camera({ category: '<b>' })).category,
    'webcam',
  );
});

test('the catalog path follows CAMINDEX_DIR', () => {
  assert.equal(
    camindexCatalogPath('/repo', {}),
    path.join('/repo', '.gev-cache', 'camindex', 'catalog.json'),
  );
  assert.equal(
    camindexCatalogPath('/repo', { CAMINDEX_DIR: '/data/cams' }),
    path.join(path.resolve('/data/cams'), 'catalog.json'),
  );
});

test('the pack reads the catalog once per change and serves only proximity', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { dir, file } = await catalogDir(t, [
    camera(),
    camera({ id: 'opencctv-2', snapshotUrl: 'ftp://x' }),
  ]);
  const load = createCamindexLoader({ env: {} });
  const first = await load({ sourceRoot: dir });
  assert.equal(first.length, 0);
  assert.equal(first.proximityOnly, true);
  assert.deepEqual(
    first.everything.map((s) => s.id),
    ['opencctv-212832'],
  );
  assert.equal(
    await load({ sourceRoot: dir }).then((l) => l.everything),
    first.everything,
  );
  await fs.writeFile(
    file,
    JSON.stringify({ cameras: [camera(), camera({ id: 'opencctv-3' })] }),
  );
  const later = new Date(Date.now() + 5000);
  await fs.utimes(file, later, later);
  assert.equal((await load({ sourceRoot: dir })).everything.length, 2);
  await fs.writeFile(file, '{broken');
  const evenLater = new Date(Date.now() + 10000);
  await fs.utimes(file, evenLater, evenLater);
  assert.equal(
    (await load({ sourceRoot: dir })).everything.length,
    2,
    'an unreadable file keeps the last good list',
  );
  assert.equal(
    (await createCamindexLoader({ env: {} })({ sourceRoot: os.tmpdir() }))
      .everything.length,
    0,
    'no catalog, no cameras',
  );
});

test('camindex cameras reach proximity queries with their provenance', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { dir } = await catalogDir(t, [camera()]);
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^OVERPASS_|^WINDY|^YOUTUBE|^CAMINDEX_/.test(key))
        delete process.env[key];
    process.env.CCTV_WINDY_ENABLED = '0';
    process.env.CCTV_FEATURED_ENABLED = '0';
    process.env.CCTV_LINKED_ENABLED = '0';
    t.mock.method(globalThis, 'fetch', async () => Response.json([]));
    const getSources = createCctvCatalog({ sourceRoot: dir });
    const capped = await getSources();
    assert.equal(
      capped.some((s) => s.pack === 'camindex'),
      false,
    );
    const [near] = await getSources.near(39.28, -76.6, { radiusKm: 5 });
    assert.equal(near.id, 'opencctv-212832');
    assert.equal(near.pack, 'camindex');
    assert.equal(near.feedType, 'image');
    assert.equal(near.category, 'nature');
    assert.equal(near.operatorUrl, PAGE);
    assert.equal(near.publishSignal, 'directory-still');
    assert.equal(near.licenseClass, 'display-only');
    assert.equal(near.coordinatesQuality, 'site');
    assert.equal(near.embed, undefined);
    assert.equal(interestFactor(near), 0.5, 'scenic, not featured');
    assert.equal(cameraTag(near), 'OPENCCTV');

    process.env.CCTV_CAMINDEX_ENABLED = '0';
    const off = createCctvCatalog({ sourceRoot: dir });
    await off();
    assert.deepEqual(await off.near(39.28, -76.6, { radiusKm: 5 }), []);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('freshness comes from Cache-Control as a shared cache reads it', () => {
  assert.equal(freshnessMs('public, max-age=14400, s-maxage=600'), 600_000);
  assert.equal(freshnessMs('max-age=150'), 150_000);
  assert.equal(freshnessMs('max-age=86400'), FRAME_CACHE_MAX_TTL_MS);
  for (const header of [
    '',
    'no-store',
    'max-age=60, no-cache',
    'private, max-age=60',
    'max-age=0',
    'max-age=soon',
  ])
    assert.equal(freshnessMs(header), 0, header);
});

test('a frame is fetched once per freshness period and shared by concurrent misses', async () => {
  let clock = 0;
  const cache = createFrameCache({ now: () => clock });
  let loads = 0;
  const frame =
    (cacheControl, size = 10) =>
    async () => {
      loads += 1;
      return {
        ok: true,
        body: Buffer.alloc(size),
        contentType: 'image/jpeg',
        cacheControl,
      };
    };
  const url = 'https://opencctv.org/still/1.jpg';
  const [a, b] = await Promise.all([
    cache.get(url, frame('max-age=150')),
    cache.get(url, frame('max-age=150')),
  ]);
  assert.equal(a, b);
  assert.equal(loads, 1);
  clock += 149_000;
  await cache.get(url, frame('max-age=150'));
  assert.equal(loads, 1);
  clock += 2_000;
  await cache.get(url, frame('max-age=150'));
  assert.equal(loads, 2, 'refetched once stale');

  await cache.get('https://x/a.jpg', frame('no-store'));
  await cache.get('https://x/a.jpg', frame('no-store'));
  assert.equal(loads, 4, 'no-store is never kept');
  await cache.get('https://x/miss.jpg', async () => null);
  assert.equal(cache.stats().entries, 1, 'misses are not kept');
});

test('the frame cache is bounded by entries and bytes, oldest use first out', async () => {
  const cache = createFrameCache({ maxEntries: 2, maxBytes: 100 });
  const load = (size) => async () => ({
    ok: true,
    body: Buffer.alloc(size),
    contentType: 'image/jpeg',
    cacheControl: 'max-age=600',
  });
  await cache.get('a', load(10));
  await cache.get('b', load(10));
  await cache.get('a', load(10));
  await cache.get('c', load(10));
  let reloaded = false;
  await cache.get('a', async () => {
    reloaded = true;
    return null;
  });
  assert.equal(reloaded, false, 'a was used recently and stayed');
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 20 });
  await cache.get('big', load(95));
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 95 });
  await cache.get('huge', load(101));
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 95 });
});

test('upstream frames carry their Cache-Control to the cache', async () => {
  const frame = await fetchCctvImageFromUpstream(
    'https://opencctv.org/still/1.jpg',
    {
      fetchImpl: async () =>
        new Response(Buffer.alloc(2048), {
          headers: {
            'content-type': 'image/jpeg',
            'cache-control': 'public, max-age=14400, s-maxage=600',
          },
        }),
    },
  );
  assert.equal(frame.cacheControl, 'public, max-age=14400, s-maxage=600');
  assert.equal(frame.body.length, 2048);
});

// Every feed kind the camindex adapters write (pocketworld.mjs and
// openeagleeye.mjs), in linked.js's shapes.
const listed = (over = {}) =>
  camera({
    id: 'pocketworld-pw-abc123',
    sourceKind: 'pocketworld',
    publishSignal: 'directory-link',
    licenseClass: 'display-only',
    operatorUrl: 'https://operator.example.org/cams/',
    snapshotUrl: '',
    url: '',
    ...over,
  });

test('a YouTube camera keeps its embed, rebuilt from a valid id only', () => {
  const source = catalogCameraToSource(
    listed({
      feedType: 'youtube',
      licenseClass: 'embed-only',
      url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
      snapshotUrl: 'https://evil.example/thumb.jpg',
      embed: { provider: 'youtube', videoId: '1_BdSTneH3s' },
      liveStatus: 'live',
    }),
  );
  assert.equal(source.feedType, 'youtube');
  assert.deepEqual(source.embed, {
    provider: 'youtube',
    videoId: '1_BdSTneH3s',
  });
  assert.equal(source.url, 'https://www.youtube.com/watch?v=1_BdSTneH3s');
  assert.equal(
    source.snapshotUrl,
    'https://i.ytimg.com/vi/1_BdSTneH3s/hqdefault.jpg',
    'the thumbnail comes from the id, not the catalog',
  );
  assert.equal(source.liveStatus, 'unknown');
  assert.equal(source.licenseClass, 'embed-only');
  assert.deepEqual(normalizeSourceItem(source).embed, {
    provider: 'youtube',
    videoId: '1_BdSTneH3s',
  });
  // A non-YouTube url is replaced by the watch URL for the id.
  assert.equal(
    catalogCameraToSource(
      listed({
        feedType: 'youtube',
        url: 'https://evil.example/watch',
        embed: { provider: 'youtube', videoId: '1_BdSTneH3s' },
      }),
    ).url,
    'https://www.youtube.com/watch?v=1_BdSTneH3s',
  );
  for (const embed of [
    { provider: 'youtube', videoId: 'short' },
    { provider: 'youtube', videoId: '1_BdSTneH3s&x=1' },
    { provider: 'vimeo', videoId: '1_BdSTneH3s' },
    undefined,
  ])
    assert.equal(
      catalogCameraToSource(listed({ feedType: 'youtube', embed })),
      null,
      JSON.stringify(embed),
    );
});

test('an HLS camera needs an https .m3u8 on a public host', () => {
  const source = catalogCameraToSource(
    listed({ feedType: 'hls', url: 'https://cdn.example.org/live/index.m3u8' }),
  );
  assert.equal(source.feedType, 'hls');
  assert.equal(source.url, 'https://cdn.example.org/live/index.m3u8');
  assert.equal(source.snapshotUrl, '');
  for (const url of [
    'http://cdn.example.org/live/index.m3u8',
    'https://cdn.example.org/live/index.mp4',
    'https://192.168.1.20/live/index.m3u8',
    'https://user:pw@cdn.example.org/live/index.m3u8',
  ])
    assert.equal(
      catalogCameraToSource(listed({ feedType: 'hls', url })),
      null,
      url,
    );
});

test('image and MJPEG cameras need https stills on public hosts', () => {
  const image = catalogCameraToSource(
    listed({
      feedType: 'image',
      url: 'https://cam.example.org/latest.jpg',
      snapshotUrl: 'https://cam.example.org/latest.jpg',
    }),
  );
  assert.equal(image.feedType, 'image');
  assert.equal(image.url, image.snapshotUrl);
  const mjpeg = catalogCameraToSource(
    listed({ feedType: 'mjpeg', url: 'https://cam.example.org/video.cgi' }),
  );
  assert.equal(mjpeg.feedType, 'mjpeg');
  assert.equal(mjpeg.url, 'https://cam.example.org/video.cgi');
  assert.equal(mjpeg.snapshotUrl, '');
  for (const url of [
    'http://cam.example.org/a.jpg',
    'https://localhost/a.jpg',
    'https://10.0.0.5/a.jpg',
    'https://cam.local/a.jpg',
    'https://[::1]/a.jpg',
  ]) {
    assert.equal(
      catalogCameraToSource(listed({ feedType: 'image', snapshotUrl: url })),
      null,
      url,
    );
    assert.equal(
      catalogCameraToSource(listed({ feedType: 'mjpeg', url })),
      null,
      url,
    );
  }
  assert.equal(
    catalogCameraToSource(listed({ feedType: 'rtsp', url: 'rtsp://x' })),
    null,
  );
});

test('a link camera shows no picture and needs an https operator page', () => {
  const source = catalogCameraToSource(
    listed({ feedType: 'link', url: 'https://ignored.example/x' }),
  );
  assert.equal(source.feedType, 'link');
  assert.equal(source.url, '');
  assert.equal(source.snapshotUrl, '');
  assert.equal(source.operatorUrl, 'https://operator.example.org/cams/');
  assert.equal(source.publishSignal, 'directory-link');
  assert.equal(
    catalogCameraToSource(
      listed({ feedType: 'link', operatorUrl: 'http://x.example/' }),
    ),
    null,
  );
});

test('an IANA time zone rides along to the public state', () => {
  const source = catalogCameraToSource(
    camera({
      id: 'openeagleeye-12',
      sourceKind: 'openeagleeye',
      publishSignal: 'operator-page',
      timeZone: 'Europe/Oslo',
    }),
  );
  assert.equal(source.timeZone, 'Europe/Oslo');
  assert.equal(source.publishSignal, 'operator-page');
  assert.equal(normalizeSourceItem(source).timeZone, 'Europe/Oslo');
  for (const zone of [
    'Mars/Olympus_Mons',
    '../etc/passwd',
    'Europe/Oslo; x',
    42,
  ])
    assert.equal(validTimeZone(zone), '', String(zone));
  assert.equal(
    validTimeZone('America/Argentina/Buenos_Aires'),
    'America/Argentina/Buenos_Aires',
  );
  assert.equal(validTimeZone('UTC'), 'UTC');
  assert.equal(
    catalogCameraToSource(camera({ timeZone: 'Nowhere/Land' })).timeZone,
    undefined,
  );
});

test('only public hosts are accepted', () => {
  for (const host of [
    'opencctv.org',
    'cam.example.co.uk',
    '8.8.8.8',
    '172.32.0.1',
  ])
    assert.equal(isPublicHost(host), true, host);
  for (const host of [
    'localhost',
    'a.localhost',
    'printer.local',
    'nas.lan',
    'intranet',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '[::1]',
    '999.1.1.1',
  ])
    assert.equal(isPublicHost(host), false, host);
});
