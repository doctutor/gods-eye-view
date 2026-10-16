import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HostBlockedError,
  RobotsDisallowedError,
  createFetcher,
  parseRobots,
  robotsAllows,
} from '../../scripts/camindex/fetch.mjs';
import {
  cameraPageId,
  categoryFromText,
  decodeEntities,
  discover,
  listingRoots,
  parseCameraPage,
  parseListingPage,
  parseSitemap,
  primaryCategory,
  warcHtmlBody,
} from '../../scripts/camindex/adapters/opencctv.mjs';
import {
  NEAR_VIEW_KM,
  ROLLING_LIMIT,
  judgeStill,
  knownPlaceholders,
  markSharedPlaceholders,
  rollingQueue,
  stillPacing,
  verifyCandidates,
} from '../../scripts/camindex/verify.mjs';
import {
  feedKey,
  mergeCameras,
  nameSimilarity,
} from '../../scripts/camindex/merge.mjs';
import {
  buildCatalog,
  foldObserved,
  openCctvToSource,
  recordsToObserved,
} from '../../scripts/camindex/catalog.mjs';
import {
  DISCOVER_EVERY_MS,
  ROLLING_EVERY_MS,
  dueJobs,
  parseArgs,
} from '../../scripts/camindex/index.mjs';

// Personal fork: camindex crawler tooling (scripts/camindex/).

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/camindex/fixtures',
);
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), 'utf8');
const CAMERA_984 =
  'https://opencctv.org/cameras/united-states/alaska/kenai-peninsula-borough/beluga-lake-homer-984';
const ROBOTS = `User-agent: *
Allow: /cameras/
Allow: /livetraffic/
Disallow: /api/
Disallow: /admin

Sitemap: https://opencctv.org/sitemap.xml
`;

test('a saved camera page parses to one candidate from its JSON-LD', async () => {
  const candidate = parseCameraPage(
    await fixture('opencctv-camera-984.html'),
    CAMERA_984,
  );
  assert.deepEqual(candidate, {
    id: '984',
    name: 'Beluga Lake, Homer',
    pageUrl: CAMERA_984,
    lat: 59.641592,
    lon: -151.52127,
    place: 'Kenai Peninsula Borough',
    region: 'Alaska',
    country: 'United States',
    caption: candidate.caption,
    categories: ['traffic'],
    stillUrl: 'https://opencctv.org/still/984.jpg',
  });
  assert.match(candidate.caption, /^Live traffic camera on Beluga Lake/);
  assert.equal(parseCameraPage('<html></html>', CAMERA_984), null);
  assert.equal(
    parseCameraPage(
      await fixture('opencctv-camera-984.html'),
      'https://evil.example/cameras/x-984',
    ),
    null,
  );
});

test('a saved listing page yields its cards and page count, never feed URLs', async () => {
  const listing = parseListingPage(
    await fixture('opencctv-listing-nature.html'),
    { category: 'nature' },
  );
  assert.equal(listing.pages, 357);
  assert.equal(listing.items.length, 3);
  const [first] = listing.items;
  assert.equal(first.id, '399305');
  assert.equal(first.lat, 37.6504);
  assert.equal(first.lon, -3.7245);
  assert.equal(first.place, 'Jaén, ES');
  assert.deepEqual(first.categories, ['nature']);
  assert.equal(first.stillUrl, 'https://opencctv.org/still/399305.jpg');
  assert.ok(!JSON.stringify(listing).includes('/api/'));
});

test('malformed JSON-LD and foreign links are skipped, not trusted', () => {
  const html = `
    <script type="application/ld+json">{not json</script>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[
      {"item":{"name":"Elsewhere","url":"https://evil.example/cameras/a-1","contentLocation":{"geo":{"latitude":1,"longitude":1}}}},
      {"item":{"name":"No geo","url":"https://opencctv.org/cameras/x/no-geo-7"}},
      {"item":{"name":"Zero","url":"/cameras/x/zero-8","contentLocation":{"geo":{"latitude":0,"longitude":0}}}}
    ]}</script>`;
  const { items, pages } = parseListingPage(html);
  assert.equal(pages, 1);
  assert.deepEqual(
    items.map((item) => [item.id, item.lat]),
    [
      ['7', null],
      ['8', null],
    ],
  );
  assert.equal(cameraPageId('http://opencctv.org/cameras/a-1'), null);
  assert.equal(cameraPageId('https://opencctv.org/api/feed/1'), null);
  assert.deepEqual(cameraPageId('/cameras/us/md/a-12/'), {
    id: '12',
    url: 'https://opencctv.org/cameras/us/md/a-12',
  });
});

test('character references in names become text', () => {
  assert.equal(
    decodeEntities(
      'Airport.net &raquo; Blog &amp; Cam &#8211; &#x2014; &bogus;',
    ),
    'Airport.net » Blog & Cam – — &bogus;',
  );
  assert.equal(decodeEntities('&#0; &#xD800;'), '&#0; &#xD800;');
  assert.equal(
    decodeEntities(
      'L&oslash;ten &Ouml;sterreich S&atilde;o Ni&ccedil;a &AElig;',
    ),
    'Løten Österreich São Niça Æ',
  );
});

test('categories come from the caption, scenic ahead of traffic', () => {
  assert.equal(categoryFromText('Live traffic camera on I-95'), 'traffic');
  assert.equal(
    categoryFromText('Live view of the beach at Ocean City'),
    'beach',
  );
  assert.equal(categoryFromText('Bald eagle nest'), 'nature');
  assert.equal(categoryFromText('Something else'), '');
  assert.equal(primaryCategory(['traffic', 'weather']), 'weather');
  assert.equal(primaryCategory(['traffic', 'beach']), 'beach');
  assert.equal(primaryCategory([]), 'webcam');
});

test('scopes start small: scenic categories plus Maryland', () => {
  const paths = (scope) => listingRoots(scope).map((root) => root.path);
  assert.ok(!paths('default').includes('/cameras/category/traffic'));
  assert.ok(paths('default').includes('/cameras/category/nature'));
  assert.ok(
    paths('default').includes(
      '/cameras/united-states/maryland/category/traffic',
    ),
  );
  assert.ok(paths('all').includes('/cameras/category/traffic'));
  assert.ok(!paths('non-traffic').some((p) => p.includes('maryland')));
  assert.throws(() => listingRoots('everything'));
});

test('robots.txt rules: longest match wins, allow wins ties', () => {
  const rules = parseRobots(ROBOTS);
  assert.equal(robotsAllows(rules, 'https://opencctv.org/cameras/x-1'), true);
  assert.equal(robotsAllows(rules, 'https://opencctv.org/api/feed/x'), false);
  assert.equal(robotsAllows(rules, 'https://opencctv.org/admin/x'), false);
  assert.equal(robotsAllows(rules, 'https://opencctv.org/still/1.jpg'), true);
  const wild = parseRobots('User-agent: *\nDisallow: /*.php$\nAllow: /a.php$');
  assert.equal(robotsAllows(wild, 'https://h/x.php'), false);
  assert.equal(robotsAllows(wild, 'https://h/x.php?q'), true);
  assert.equal(robotsAllows(wild, 'https://h/a.php'), true);
  const named = parseRobots(
    'User-agent: camindex\nDisallow: /\n\nUser-agent: *\nAllow: /',
    'gods-eye-view camindex',
  );
  assert.equal(robotsAllows(named, 'https://h/x'), false);
});

/** A fake web with a fake clock: sleeping advances time. */
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
    advance: (ms) => {
      clock += ms;
    },
    transport,
  };
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-camindex-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the fetcher checks robots, paces per host and caches on disk', async (t) => {
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': new Response('<html>page</html>', {
      headers: { 'content-type': 'text/html' },
    }),
  });
  const make = () =>
    createFetcher({
      cacheDir: dir,
      transport: web.transport,
      now: web.now,
      sleep: web.sleep,
    });
  const fetcher = make();
  const a = await fetcher.get('https://opencctv.org/cameras/a-1');
  const b = await fetcher.get('https://opencctv.org/cameras/b-2');
  assert.equal(a.body.toString(), '<html>page</html>');
  assert.equal(a.fromCache, false);
  await assert.rejects(
    fetcher.get('https://opencctv.org/api/feed/1'),
    RobotsDisallowedError,
  );
  assert.deepEqual(
    web.calls.map((call) => new URL(call.url).pathname),
    ['/robots.txt', '/cameras/a-1', '/cameras/b-2'],
    'a disallowed path is never requested',
  );
  for (let i = 1; i < web.calls.length; i++)
    assert.ok(web.calls[i].at - web.calls[i - 1].at >= 1500, 'paced');
  assert.match(web.calls[1].headers['User-Agent'], /camindex/);
  assert.equal(b.ok, true);

  // A new run reads the disk copy without the network, until a week passes.
  const again = make();
  const cached = await again.get('https://opencctv.org/cameras/a-1');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.body.toString(), '<html>page</html>');
  assert.equal(web.calls.length, 3);
  web.advance(8 * 24 * 60 * 60 * 1000);
  const stale = await again.get('https://opencctv.org/cameras/a-1');
  assert.equal(stale.fromCache, false);
  assert.equal(
    await again.get('https://opencctv.org/cameras/zz-9', { offline: true }),
    null,
    'offline never touches the network',
  );
});

test('the fetcher caps size, keeps only metadata when asked, and stays on host', async (t) => {
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    'https://opencctv.org/cameras/big-1': new Response('x'.repeat(5000)),
    'https://opencctv.org/still/1.jpg': new Response(Buffer.alloc(2048, 7), {
      headers: { 'content-type': 'image/jpeg' },
    }),
    'https://opencctv.org/cameras/away-2': new Response('', {
      status: 302,
      headers: { location: 'https://elsewhere.example/x' },
    }),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
    maxBytes: 4096,
  });
  await assert.rejects(
    fetcher.get('https://opencctv.org/cameras/big-1'),
    /larger than 4096/,
  );
  const still = await fetcher.get('https://opencctv.org/still/1.jpg', {
    store: false,
  });
  assert.equal(still.body, null);
  assert.equal(still.bytes, 2048);
  assert.equal(still.contentType, 'image/jpeg');
  assert.match(still.sha1, /^[0-9a-f]{40}$/);
  const away = await fetcher.get('https://opencctv.org/cameras/away-2');
  assert.equal(away.status, 302);
  assert.ok(!web.calls.some((call) => call.url.includes('elsewhere')));
  await assert.rejects(fetcher.get('file:///etc/passwd'), /refusing/);
});

test('rate limits pause the host, and repeated failures stop the run', async (t) => {
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': () =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
  });
  const first = await fetcher.get('https://opencctv.org/cameras/a-1');
  assert.equal(first.status, 429);
  await fetcher.get('https://opencctv.org/cameras/a-1');
  const [, one, two] = web.calls;
  assert.ok(two.at - one.at >= 120_000, 'Retry-After honoured');
  for (let i = 0; i < 3; i++)
    await fetcher.get('https://opencctv.org/cameras/a-1');
  await assert.rejects(
    fetcher.get('https://opencctv.org/cameras/a-1'),
    HostBlockedError,
  );
});

test('discovery walks listing pages to the limit, resumable from the cache', async (t) => {
  const dir = await tempDir(t);
  const listing = await fixture('opencctv-listing-nature.html');
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': (url) =>
      url.includes('/category/nature')
        ? new Response(
            // Each page shows the same three cards with distinct ids.
            listing.replace(/-(39930\d)"/g, (_, id) => {
              const page = Number(new URL(url).searchParams.get('page') || 1);
              return `-${id}${page}"`;
            }),
          )
        : new Response('<html></html>'),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
  });
  const result = await discover(fetcher, { scope: 'non-traffic', limit: 7 });
  assert.equal(result.found.size, 7);
  assert.equal(result.stoppedBy, 'limit');
  assert.equal(result.pagesRead, 3);
  const ids = [...result.candidates.keys()];
  assert.deepEqual(ids.slice(0, 4), [
    '3993051',
    '3993061',
    '3993081',
    '3993052',
  ]);
  const network = web.calls.length;
  const resumed = await discover(
    createFetcher({
      cacheDir: dir,
      transport: web.transport,
      now: web.now,
      sleep: web.sleep,
    }),
    { scope: 'non-traffic', limit: 7 },
  );
  assert.equal(resumed.fromNetwork, 0);
  assert.equal(web.calls.length, network);
});

test('sitemaps and Common Crawl WARC records parse', () => {
  assert.deepEqual(
    parseSitemap(
      '<urlset><url><loc>https://opencctv.org/cameras/a-1</loc></url><url><loc> https://opencctv.org/x?a=1&amp;b=2 </loc></url></urlset>',
    ),
    ['https://opencctv.org/cameras/a-1', 'https://opencctv.org/x?a=1&b=2'],
  );
  const record =
    'WARC/1.0\r\nWARC-Type: response\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>ok</html>';
  assert.equal(warcHtmlBody(record), '<html>ok</html>');
  assert.equal(warcHtmlBody(record.replace('200 OK', '404 Not Found')), null);
});

test('verification wants a real image and spots shared placeholders', async (t) => {
  const answer = (over) => ({
    ok: true,
    status: 200,
    contentType: 'image/jpeg',
    bytes: 50_000,
    sha1: 'a'.repeat(40),
    fetchedAt: 5,
    ...over,
  });
  assert.equal(judgeStill(answer()).status, 'live');
  assert.equal(judgeStill(answer({ ok: false, status: 404 })).status, 'dead');
  assert.equal(judgeStill(answer({ ok: false, status: 503 })).status, 'error');
  assert.equal(judgeStill(answer({ ok: false, status: 429 })).status, 'error');
  assert.equal(judgeStill(answer({ contentType: 'text/html' })).status, 'dead');
  assert.equal(judgeStill(answer({ bytes: 900 })).status, 'dead');
  assert.equal(
    judgeStill(answer(), { placeholders: ['a'.repeat(40)] }).status,
    'placeholder',
  );
  const records = {
    1: { status: 'live', sha1: 'p' },
    2: { status: 'live', sha1: 'p' },
    3: { status: 'live', sha1: 'p' },
    4: { status: 'live', sha1: 'q' },
  };
  assert.deepEqual(markSharedPlaceholders(records), ['p']);
  assert.deepEqual(
    Object.values(records).map((record) => record.status),
    ['placeholder', 'placeholder', 'placeholder', 'live'],
  );

  // Maryland is checked first, and a still is fetched without being kept.
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': () =>
      new Response(Buffer.alloc(3000, 1), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
  });
  const found = {};
  const run = await verifyCandidates(
    fetcher,
    [
      {
        id: 'far',
        lat: 59.6,
        lon: -151.5,
        categories: ['nature'],
        stillUrl: 'https://opencctv.org/still/1.jpg',
      },
      {
        id: 'md',
        lat: 39.28,
        lon: -76.6,
        categories: ['traffic'],
        stillUrl: 'https://opencctv.org/still/2.jpg',
      },
    ],
    found,
    { limit: 1, now: web.now },
  );
  assert.equal(run.checked, 1);
  assert.equal(run.stoppedBy, 'limit');
  assert.deepEqual(Object.keys(found), ['md']);
  assert.equal(found.md.status, 'live');
});

test('merging keeps the operator feed and folds directory copies into it', () => {
  const directory = (over) => ({
    id: 'opencctv-1',
    name: 'Inner Harbor Camera',
    lat: 39.2855,
    lon: -76.6085,
    sourceKind: 'opencctv',
    publishSignal: 'directory-embed',
    snapshotUrl: 'https://opencctv.org/still/1.jpg',
    ...over,
  });
  const operator = {
    id: 'harbor-op',
    name: 'Inner Harbor',
    lat: 39.2857,
    lon: -76.6086,
    sourceKind: 'operator',
    publishSignal: 'operator-page',
    snapshotUrl: 'https://cam.example.org/harbor.jpg',
  };
  const merged = mergeCameras([
    directory(),
    operator,
    // Same feed listed twice.
    directory({ id: 'opencctv-1b', name: 'Other name' }),
    // Same place, same directory, different camera: kept apart.
    directory({
      id: 'opencctv-2',
      snapshotUrl: 'https://opencctv.org/still/2.jpg',
    }),
    // Far away with the same name: kept apart.
    directory({
      id: 'opencctv-3',
      lat: 40,
      snapshotUrl: 'https://opencctv.org/still/3.jpg',
    }),
  ]);
  assert.deepEqual(
    merged.map((camera) => camera.id),
    ['harbor-op', 'opencctv-2', 'opencctv-3'],
  );
  assert.deepEqual(merged[0].alsoListedBy.sort(), [
    'opencctv-1',
    'opencctv-1b',
  ]);
  assert.equal(
    feedKey({ snapshotUrl: 'HTTPS://Cam.Example.org/a.jpg#x' }),
    'cam.example.org/a.jpg',
  );
  assert.equal(nameSimilarity('Inner Harbor', 'Inner Harbor Camera'), 1);
  assert.equal(nameSimilarity('Pier', 'Airport'), 0);
});

test('the catalog carries provenance and leaves out dead cameras', () => {
  const candidate = (id, over) => ({
    id,
    name: `Camera ${id}`,
    pageUrl: `https://opencctv.org/cameras/us/md/camera-${id}`,
    lat: 39 + Number(id) / 100,
    lon: -76.6,
    place: 'Baltimore, Maryland, US',
    categories: ['traffic', 'nature'],
    stillUrl: `https://opencctv.org/still/${id}.jpg`,
    ...over,
  });
  const catalog = buildCatalog(
    {
      opencctv: {
        candidates: [
          candidate('1'),
          candidate('2'),
          candidate('3'),
          candidate('4', { lat: null }),
        ],
        records: {
          1: { status: 'live', verifiedAt: Date.UTC(2026, 9, 16) },
          2: { status: 'dead' },
        },
      },
    },
    { now: () => Date.UTC(2026, 9, 16, 12) },
  );
  assert.equal(catalog.generatedAt, '2026-10-16T12:00:00.000Z');
  assert.deepEqual(catalog.sources.opencctv, {
    found: 4,
    verified: 2,
    live: 1,
    dead: 1,
    served: 2,
  });
  assert.deepEqual(
    catalog.cameras.map((camera) => [camera.id, camera.liveStatus]),
    [
      ['opencctv-1', 'live'],
      ['opencctv-3', 'unknown'],
    ],
  );
  const [first] = catalog.cameras;
  assert.equal(first.category, 'nature');
  assert.equal(first.feedType, 'image');
  assert.equal(first.snapshotUrl, 'https://opencctv.org/still/1.jpg');
  assert.equal(first.publishSignal, 'directory-embed');
  assert.equal(first.licenseClass, 'embed-only');
  assert.equal(first.coordinatesQuality, 'site');
  assert.equal(first.operatorUrl, candidate('1').pageUrl);
  assert.equal(first.embed, undefined, 'no directory player is framed');
  assert.equal(first.verifiedAt, '2026-10-16T00:00:00.000Z');
  assert.equal(
    openCctvToSource(candidate('5'), null).city,
    'Baltimore, Maryland, US',
  );
  assert.equal(
    buildCatalog(
      {
        opencctv: {
          candidates: [candidate('1'), candidate('3')],
          records: { 1: { status: 'live' } },
        },
      },
      { onlyVerified: true },
    ).cameras.length,
    1,
  );
});

test('the CLI parses commands and flags', () => {
  assert.deepEqual(
    parseArgs([
      'discover',
      '--source',
      'opencctv',
      '--scope=maryland',
      '--limit',
      '5',
      '--page-details',
    ]),
    {
      command: 'discover',
      flags: {
        source: 'opencctv',
        scope: 'maryland',
        limit: '5',
        'page-details': true,
      },
    },
  );
  assert.throws(() => parseArgs(['discover', 'opencctv']), /unexpected/);
});

test('stills from opencctv.org stay under 40 uncached requests per 10 minutes', async (t) => {
  assert.deepEqual(stillPacing(1500), { '*': 1500, 'opencctv.org': 16_000 });
  assert.equal(stillPacing(20_000)['opencctv.org'], 20_000, 'only ever slower');
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': () =>
      new Response(Buffer.alloc(3000, 1), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
    minIntervalMs: stillPacing(1500),
  });
  const candidates = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    lat: 10,
    lon: 10,
    categories: ['nature'],
    stillUrl: `https://opencctv.org/still/${i}.jpg`,
  }));
  await verifyCandidates(fetcher, candidates, {}, { now: web.now });
  const stills = web.calls.filter((call) => call.url.includes('/still/'));
  assert.equal(stills.length, 60);
  for (let i = 40; i < stills.length; i++)
    assert.ok(
      stills[i].at - stills[i - 40].at >= 10 * 60 * 1000,
      `40 stills span at least 10 minutes (${i})`,
    );
});

const DAY = 24 * 60 * 60 * 1000;

test('a rolling run checks stale observations, then near views, then the oldest', () => {
  const now = 100 * DAY;
  const cam = (id, lat, lon) => ({
    id,
    lat,
    lon,
    stillUrl: `https://opencctv.org/still/${id}.jpg`,
  });
  const candidates = [
    cam('far-never', 10, 10),
    cam('near-never-2', 39.5, -76.6), // ~25 km from the view
    cam('near-never-1', 39.3, -76.6),
    cam('stale-seen', 0, 50),
    cam('stale-seen-older', 0, 51),
    cam('fresh-seen', 0, 52),
    cam('fresh-verified', 0, 53),
    cam('old-verified', 0, 54),
    cam('errored', 0, 55),
    cam('no-place', NaN, NaN),
    { id: 'no-still', lat: 1, lon: 1 },
  ];
  const records = {
    'fresh-verified': { status: 'live', verifiedAt: now - DAY },
    'old-verified': { status: 'live', verifiedAt: now - 30 * DAY },
    errored: { status: 'error', verifiedAt: now - DAY },
  };
  const observed = {
    'opencctv-stale-seen': { status: 'live', at: now - 8 * DAY },
    'opencctv-stale-seen-older': { status: 'dead', at: now - 9 * DAY },
    'opencctv-fresh-seen': { status: 'live', at: now - 2 * DAY },
  };
  const views = [
    { lat: 39.29, lon: -76.61 },
    { lat: 39.29, lon: -76.61 },
  ];
  assert.deepEqual(
    rollingQueue({ candidates, records, observed, views, now }).map(
      (c) => c.id,
    ),
    [
      'stale-seen-older',
      'stale-seen',
      'near-never-1',
      'near-never-2',
      // Then the rest, least recently checked first (never = oldest).
      'far-never',
      'old-verified',
      'errored',
    ],
  );
  // Without views, never-checked cameras simply count as oldest.
  assert.deepEqual(
    rollingQueue({ candidates, records, observed, now })
      .map((c) => c.id)
      .slice(2, 5)
      .sort(),
    ['far-never', 'near-never-1', 'near-never-2'],
  );
  assert.equal(NEAR_VIEW_KM, 50);
  assert.equal(ROLLING_LIMIT, 200);
});

test('a rolling run keeps to the host floor and stops at its limit', async (t) => {
  const dir = await tempDir(t);
  const web = fakeWeb({
    'https://opencctv.org/robots.txt': new Response(ROBOTS),
    '*': () =>
      new Response(Buffer.alloc(3000, 1), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  });
  const fetcher = createFetcher({
    cacheDir: dir,
    transport: web.transport,
    now: web.now,
    sleep: web.sleep,
    minIntervalMs: stillPacing(1500),
  });
  const candidates = Array.from({ length: 250 }, (_, i) => ({
    id: String(i),
    lat: 10,
    lon: 10,
    stillUrl: `https://opencctv.org/still/${i}.jpg`,
  }));
  const queue = rollingQueue({ candidates, records: {}, now: web.now() });
  const records = {};
  const run = await verifyCandidates(fetcher, candidates, records, {
    queue,
    limit: ROLLING_LIMIT,
    now: web.now,
  });
  assert.equal(run.checked, 200);
  assert.equal(run.stoppedBy, 'limit');
  const stills = web.calls.filter((call) => call.url.includes('/still/'));
  assert.equal(stills.length, 200);
  for (let i = 40; i < stills.length; i++)
    assert.ok(stills[i].at - stills[i - 40].at >= 10 * 60 * 1000);
});

test('observations fold into verify records, newer wins, errors skipped', () => {
  const records = {
    1: { status: 'live', verifiedAt: 50 },
    2: { status: 'live', verifiedAt: 50 },
  };
  const changed = foldObserved(records, {
    'opencctv-1': { status: 'dead', at: 60, httpStatus: 404 },
    'opencctv-2': { status: 'dead', at: 40 },
    'opencctv-3': { status: 'live', at: 70, bytes: 5000 },
    'opencctv-4': { status: 'error', at: 80 },
    'windy-5': { status: 'dead', at: 90 },
  });
  assert.equal(changed, 2);
  assert.deepEqual(records, {
    1: { status: 'dead', verifiedAt: 60, httpStatus: 404, by: 'observed' },
    2: { status: 'live', verifiedAt: 50 },
    3: { status: 'live', verifiedAt: 70, bytes: 5000, by: 'observed' },
  });
  assert.deepEqual(recordsToObserved(records, ['3', '9']), {
    'opencctv-3': { status: 'live', at: 70, bytes: 5000 },
  });
});

test('the scheduler runs discover weekly and a rolling verify nightly', () => {
  const now = Date.UTC(2026, 9, 20, 3);
  const at = (ms) => new Date(now - ms).toISOString();
  assert.deepEqual(dueJobs([], now), { discover: true, verify: true });
  assert.deepEqual(
    dueJobs(
      [
        { command: 'discover', at: at(DAY), stoppedBy: 'complete' },
        { command: 'verify', at: at(2 * 60 * 60 * 1000), rolling: true },
      ],
      now,
    ),
    { discover: false, verify: false },
  );
  assert.deepEqual(
    dueJobs(
      [
        {
          command: 'discover',
          at: at(DISCOVER_EVERY_MS + 1),
          stoppedBy: 'complete',
        },
        // A discover that died does not count as done.
        {
          command: 'discover',
          at: at(DAY),
          stoppedBy: 'opencctv.org: too many consecutive failures',
        },
        // A plain verify does not count as the nightly run.
        { command: 'verify', at: at(60 * 1000) },
        { command: 'verify', at: at(ROLLING_EVERY_MS), rolling: true },
      ],
      now,
    ),
    { discover: true, verify: true },
  );
});

test('verify reads the shared placeholder list', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'placeholders.json');
  await fs.writeFile(
    file,
    JSON.stringify({ hashes: { opencctv: ['c'.repeat(40), 'short'] } }),
  );
  assert.deepEqual(knownPlaceholders('opencctv', file), ['c'.repeat(40)]);
  assert.deepEqual(knownPlaceholders('other', file), []);
  assert.deepEqual(knownPlaceholders('opencctv', path.join(dir, 'none')), []);
});
