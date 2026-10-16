// Personal fork: camindex adapters for Open-Eagle-Eye and PocketWorld.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFetcher } from '../../scripts/camindex/fetch.mjs';
import * as openeagleeye from '../../scripts/camindex/adapters/openeagleeye.mjs';
import * as pocketworld from '../../scripts/camindex/adapters/pocketworld.mjs';
import { buildCatalog } from '../../scripts/camindex/catalog.mjs';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/camindex/fixtures',
);
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), 'utf8');

/** A transport over URL → Response (or a function), with a fake clock. */
function fakeWeb(routes) {
  let clock = 1_000_000;
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, at: clock, headers: init.headers });
    const route = routes[url] ?? routes['*'];
    if (!route) return new Response('missing', { status: 404 });
    return typeof route === 'function' ? route(url, init) : route.clone();
  };
  return {
    calls,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    transport,
  };
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-camindex-src-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// ── Open-Eagle-Eye ──────────────────────────────────────────────────────

test('Open-Eagle-Eye: rows with credentials, without coordinates or https are dropped', async () => {
  const { candidates, dropped, rows } = openeagleeye.parseRegistry(
    await fixture('openeagleeye-cameras.json'),
  );
  assert.equal(rows, 10);
  assert.deepEqual(dropped, {
    auth: 2,
    coordinates: 1,
    url: 1,
    duplicate: 1,
    id: 0,
  });
  assert.deepEqual(
    candidates.map((c) => [c.name, c.categories[0]]),
    [
      ['I-95 at NW 62nd St', 'traffic'],
      ['Boardwalk at 9th St', 'beach'],
      ['Kilauea summit', 'volcano'],
      ['Bear cam', 'nature'],
      ['Inner Harbor', 'port'],
    ],
  );
  const [fl, oc, kilauea, bears] = candidates;
  assert.equal(fl.provider, 'fl511.com');
  assert.equal(fl.operatorUrl, 'https://www.fl511.com/');
  assert.equal(fl.stillUrl, 'https://www.fl511.com/map/Cctv/1001');
  assert.equal(fl.timeZone, 'America/New_York');
  // An auth object without requirements means no auth.
  assert.equal(oc.upstreamVerified, false);
  // Ids become catalog-safe slugs; a changed id gets a hash.
  assert.match(kilauea.id, /^hvo-k2cam-[0-9a-f]{6}$/);
  assert.match(fl.id, /^fl-511-i95-001-[0-9a-f]{6}$/);
  assert.equal(openeagleeye.slugId('bears-1'), 'bears-1');
  // An unknown zone is dropped rather than passed on.
  assert.equal(bears.timeZone, '');
  assert.equal(openeagleeye.needsAuth({}), false);
  assert.equal(openeagleeye.needsAuth(null), false);
  assert.equal(openeagleeye.needsAuth({ required: 'x' }), true);
  assert.equal(openeagleeye.needsAuth(true), true);
  assert.deepEqual(openeagleeye.parseRegistry('not json').candidates, []);
});

test('Open-Eagle-Eye: a candidate becomes a display-only still with provenance', async () => {
  const { candidates } = openeagleeye.parseRegistry(
    await fixture('openeagleeye-cameras.json'),
  );
  const camera = openeagleeye.toSource(candidates[0]);
  assert.equal(camera.id, `openeagleeye-${candidates[0].id}`);
  assert.equal(camera.provider, 'fl511.com');
  assert.equal(camera.credit, 'via Open-Eagle-Eye (MIT)');
  assert.equal(camera.operatorUrl, 'https://www.fl511.com/');
  assert.equal(camera.publishSignal, 'operator-page');
  assert.equal(camera.licenseClass, 'display-only');
  assert.equal(camera.coordinatesQuality, 'site');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.snapshotUrl, candidates[0].stillUrl);
  assert.equal(camera.timeZone, 'America/New_York');
  assert.equal(camera.category, 'traffic');
  assert.equal(camera.liveStatus, 'unknown');
  assert.equal(
    openeagleeye.toSource(candidates[0], { status: 'live' }).liveStatus,
    'live',
  );
  assert.ok(!('timeZone' in openeagleeye.toSource(candidates[3])));
});

test('Open-Eagle-Eye: the registry is read once and replayed from disk for a week', async (t) => {
  const dir = await tempDir(t);
  const body = await fixture('openeagleeye-cameras.json');
  const web = fakeWeb({
    'https://raw.githubusercontent.com/robots.txt': new Response('404', {
      status: 404,
    }),
    [openeagleeye.REGISTRY_URL]: new Response(body, {
      headers: { 'content-type': 'text/plain' },
    }),
  });
  const make = () =>
    createFetcher({
      cacheDir: dir,
      transport: web.transport,
      now: web.now,
      sleep: web.sleep,
    });
  const first = await openeagleeye.discover(make());
  assert.equal(first.found.size, 5);
  assert.equal(first.fromNetwork, 1);
  assert.equal(first.dropped.auth, 2);
  assert.deepEqual(
    web.calls.map((call) => new URL(call.url).pathname),
    ['/robots.txt', '/stuchapin909/Open-Eagle-Eye/master/cameras.json'],
  );
  const again = await openeagleeye.discover(make(), { limit: 2 });
  assert.equal(again.fromNetwork, 0);
  assert.equal(again.found.size, 2);
  assert.equal(again.stoppedBy, 'limit');
  assert.equal(web.calls.length, 2);
});

// ── PocketWorld ─────────────────────────────────────────────────────────

test('PocketWorld: cards parse with coordinates, format and operator; foreign and incomplete ones are skipped', async () => {
  const cards = pocketworld.parseCards(
    await fixture('pocketworld-type-nature.html'),
    { category: 'nature' },
  );
  assert.deepEqual(
    cards.map((card) => [card.name, card.feedType]),
    [
      ['Texas Bird Cams', 'youtube'],
      ['Carlsbad Cavern entrance', 'youtube'],
      ['Harbor Seals & Friends', 'hls'],
      ['Brigooda - Proston Road at McConnel Bridge', 'image'],
      ['Eagle nest', 'link'],
      ['Snapshot without extension', 'image'],
      ['Motion cam', 'mjpeg'],
      ['Same feed as the seals', 'hls'],
    ],
  );
  const [bird, cavern, seals, road, eagle, snap] = cards;
  assert.equal(bird.lat, 30.2216);
  assert.equal(bird.lon, -97.8419);
  assert.equal(bird.place, 'Austin');
  assert.deepEqual(bird.embed, { provider: 'youtube', videoId: '13ABWWKvJZo' });
  assert.equal(
    bird.snapshotUrl,
    'https://i.ytimg.com/vi/13ABWWKvJZo/hqdefault.jpg',
  );
  assert.equal(cavern.place, 'Eddy County, New Mexico');
  // A case-sensitive YouTube id keeps a unique slug.
  assert.match(cavern.id, /^yt-bwiisjxt3ki-[0-9a-f]{6}$/);
  assert.equal(seals.url, 'https://stream.example.org/seals/index.m3u8');
  assert.equal(
    road.snapshotUrl,
    'https://cameras.qldtraffic.qld.gov.au/resized/2ff511e6.jpg',
  );
  assert.equal(road.operatorUrl, 'https://cameras.qldtraffic.qld.gov.au/');
  assert.equal(eagle.url, '');
  assert.equal(eagle.operatorUrl, 'https://www.explore.example.org/eagles');
  // "Updating image" wins over a missing file extension.
  assert.equal(snap.snapshotUrl, 'https://webcam.example.no/snap?id=4');
  assert.deepEqual(bird.categories, ['nature']);
});

test('PocketWorld: classification follows linked.js with the stated format as tiebreak', () => {
  assert.equal(
    pocketworld.classifyCard('YouTube video', 'https://youtu.be/BwiIsjXt3KI')
      .feedType,
    'youtube',
  );
  assert.equal(
    pocketworld.classifyCard('HLS video', 'http://insecure.example/a.m3u8')
      .feedType,
    'link',
    'only https streams play',
  );
  assert.equal(
    pocketworld.classifyCard('Operator player', 'https://a.example/b.jpg')
      .feedType,
    'link',
  );
  assert.equal(pocketworld.classifyCard('Video', 'javascript:alert(1)'), null);
  assert.equal(
    pocketworld.looksLikeTraffic('https://cameras.qldtraffic.qld.gov.au/x.jpg'),
    true,
  );
  assert.equal(pocketworld.looksLikeTraffic('https://www.511pa.com/x'), true);
  assert.equal(
    pocketworld.looksLikeTraffic('https://www.explore.org/eagles'),
    false,
  );
  // City pages carry no category: road agencies count as traffic.
  const html = `<article class="webcam-seo-card"><h3><a href="/?mode=webcams&amp;webcam=pw-zz99&amp;lang=en">Road</a></h3><p>Location: X. Coordinates: 1.5°, 2.5°.</p><p>Format: Updating image. Camera operator: <a href="https://cams.dot.example.gov/a.jpg">d</a>.</p></article>`;
  assert.deepEqual(pocketworld.parseCards(html)[0].categories, ['traffic']);
});

test('PocketWorld: discovery asks the API, reads type pages then sitemap pages at 2 s, to the limit', async (t) => {
  const dir = await tempDir(t);
  const nature = await fixture('pocketworld-type-nature.html');
  const city = `<article class="webcam-seo-card"><h3><a href="/?mode=webcams&amp;webcam=pw-city1&amp;lang=en">Plaza</a></h3><p>Location: Bergen. Coordinates: 60.39°, 5.32°.</p><p>Format: Updating image. Camera operator: <a href="https://plaza.example.no/a.jpg">p</a>.</p></article>
  <article class="webcam-seo-card"><h3><a href="/?mode=webcams&amp;webcam=pw-road1&amp;lang=en">E39</a></h3><p>Location: Bergen. Coordinates: 60.38°, 5.31°.</p><p>Format: Updating image. Camera operator: <a href="https://kamera.vegvesen.no/a.jpg">v</a>.</p></article>`;
  const sitemap = `<urlset>
    <url><loc>https://pocketworld.org/webcams/city/no/bergen</loc></url>
    <url><loc>https://pocketworld.org/de/webcams/city/no/bergen</loc></url>
    <url><loc>https://pocketworld.org/webcams/country/no</loc></url>
    <url><loc>https://evil.example/webcams/city/no/x</loc></url>
  </urlset>`;
  const web = fakeWeb({
    'https://pocketworld.org/robots.txt': new Response(
      'User-agent: *\nAllow: /\nCrawl-delay: 1\n',
    ),
    [pocketworld.API_PROBE_URL]: new Response('error code: 502', {
      status: 502,
    }),
    'https://pocketworld.org/webcams/type/nature': new Response(nature),
    [pocketworld.MEDIA_SITEMAP]: new Response(sitemap),
    'https://pocketworld.org/webcams/city/no/bergen': new Response(city),
    '*': new Response('<html></html>'),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
    minIntervalMs: pocketworld.MIN_INTERVAL_MS,
  });
  const result = await pocketworld.discover(fetcher, { limit: 100 });
  assert.match(result.api, /^502/);
  const paths = web.calls.map((call) => new URL(call.url).pathname);
  assert.equal(paths[0], '/robots.txt');
  assert.equal(paths[1], '/api/webcams/US');
  assert.ok(paths.includes('/webcams/type/nature'));
  assert.ok(!paths.includes('/webcams/type/traffic'), 'non-traffic scope');
  assert.ok(paths.includes('/webcams/city/no/bergen'));
  assert.ok(!paths.includes('/de/webcams/city/no/bergen'));
  for (let i = 1; i < web.calls.length; i++)
    assert.ok(web.calls[i].at - web.calls[i - 1].at >= 2000, 'paced at 2 s');
  const names = [...result.candidates.values()].map((c) => c.name);
  assert.ok(names.includes('Plaza'));
  assert.ok(!names.includes('E39'), 'road-agency cards left out');
  // The two seal cards share a feed: kept once.
  assert.equal(names.filter((n) => /seal/i.test(n)).length, 1);
  assert.equal(result.stoppedBy, 'complete');

  const capped = await pocketworld.discover(
    createFetcher({
      cacheDir: dir,
      transport: web.transport,
      now: web.now,
      sleep: web.sleep,
    }),
    { limit: 3 },
  );
  assert.equal(capped.found.size, 3);
  assert.equal(capped.stoppedBy, 'limit');
  assert.equal(pocketworld.DEFAULT_LIMIT, 2000);
  assert.deepEqual(pocketworld.listingPagesFromSitemap(sitemap), [
    'https://pocketworld.org/webcams/city/no/bergen',
    'https://pocketworld.org/webcams/country/no',
  ]);
});

test('PocketWorld: cards stacked on one point are pinned to the area, not the site', () => {
  const candidates = new Map(
    [
      ['a', 38.33, -75.09],
      ['b', 38.33, -75.09],
      ['c', 38.33, -75.09],
      ['d', 38.327, -75.087],
    ].map(([id, lat, lon]) => [
      id,
      { id, name: id, lat, lon, feedType: 'hls', url: `https://x/${id}.m3u8` },
    ]),
  );
  pocketworld.markSharedPoints(candidates);
  assert.deepEqual(
    [...candidates.values()].map(
      (c) => pocketworld.toSource(c).coordinatesQuality,
    ),
    ['area', 'area', 'area', 'site'],
  );
});

test('PocketWorld: robots.txt that disallows the listings stops the run', async (t) => {
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://pocketworld.org/robots.txt': new Response(
      'User-agent: *\nDisallow: /\n',
    ),
  });
  const result = await pocketworld.discover(
    createFetcher({
      cacheDir: dir,
      transport: web.transport,
      now: web.now,
      sleep: web.sleep,
    }),
  );
  assert.match(result.stoppedBy, /robots\.txt disallows/);
  assert.equal(web.calls.length, 1);
});

test('the catalog takes both adapters with their provenance', async () => {
  const oee = openeagleeye.parseRegistry(
    await fixture('openeagleeye-cameras.json'),
  ).candidates;
  const pw = pocketworld.parseCards(
    await fixture('pocketworld-type-nature.html'),
    { category: 'nature' },
  );
  const catalog = buildCatalog(
    {
      openeagleeye: { candidates: oee, records: {} },
      pocketworld: {
        candidates: pw,
        records: { [pw[0].id]: { status: 'dead' } },
      },
    },
    { now: () => Date.UTC(2026, 9, 16) },
  );
  assert.deepEqual(catalog.sources.openeagleeye, {
    found: 5,
    verified: 0,
    served: 5,
  });
  assert.equal(catalog.sources.pocketworld.served, pw.length - 1);
  const bird = catalog.cameras.find(
    (c) => c.name === 'Carlsbad Cavern entrance',
  );
  assert.equal(bird.licenseClass, 'embed-only');
  assert.equal(bird.publishSignal, 'directory-link');
  assert.equal(bird.credit, 'via PocketWorld (pocketworld.org)');
  assert.equal(bird.provider, 'youtube.com');
  assert.equal(bird.category, 'nature');
  const harbor = catalog.cameras.find((c) => c.name === 'Inner Harbor');
  assert.equal(harbor.sourceKind, 'openeagleeye');
  assert.equal(harbor.timeZone, 'America/New_York');
  assert.ok(catalog.cameras.every((c) => /^[a-z][a-z0-9-]{1,80}$/.test(c.id)));
});
