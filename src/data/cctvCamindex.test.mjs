import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  camindexCatalogPath,
  catalogCameraToSource,
  createCamindexLoader,
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
  publishSignal: 'directory-embed',
  licenseClass: 'embed-only',
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
    JSON.stringify({ generatedAt: '2026-10-16T00:00:00Z', sources: {}, cameras }),
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
  assert.equal(await load({ sourceRoot: dir }).then((l) => l.everything), first.everything);
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
  const frame = (cacheControl, size = 10) => async () => {
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
