import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_OVERPASS_MIRRORS,
  LINKED_RETRY_MS,
  LINKED_TTL_MS,
  classifyWebcamUrl,
  createLinkedLoader,
  osmCategory,
  osmToSources,
  overpassEndpoints,
  wikidataToSources,
} from '../../server/providers/cctv/linked.js';
import {
  createCctvCatalog,
  interestFactor,
} from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { operatorLinkFor } from '../ui/cctvEmbed.js';

test('webcam links are classified by what the app can do with them', () => {
  assert.deepEqual(classifyWebcamUrl('https://cam.example.org/latest.jpg'), {
    kind: 'image',
    url: 'https://cam.example.org/latest.jpg',
  });
  assert.equal(
    classifyWebcamUrl('https://stream.example.org/live/playlist.m3u8').kind,
    'hls',
  );
  assert.equal(
    classifyWebcamUrl('http://stream.example.org/live/playlist.m3u8').kind,
    'link',
    'plain-http HLS is not relayed',
  );
  assert.deepEqual(
    classifyWebcamUrl('https://www.youtube.com/watch?v=1_BdSTneH3s'),
    {
      kind: 'youtube',
      url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
      videoId: '1_BdSTneH3s',
    },
  );
  assert.equal(
    classifyWebcamUrl('https://youtu.be/1_BdSTneH3s').videoId,
    '1_BdSTneH3s',
  );
  assert.equal(
    classifyWebcamUrl('https://www.youtube.com/@ExploreBirds/live').kind,
    'link',
  );
  assert.equal(
    classifyWebcamUrl('https://www.hongwanji.kyoto/see/livecam.html; https://b')
      .url,
    'https://www.hongwanji.kyoto/see/livecam.html',
  );
  assert.equal(classifyWebcamUrl('https://windy.com/webcams/1361567050'), null);
  assert.equal(classifyWebcamUrl('ftp://cam.example.org/a.jpg'), null);
  assert.equal(
    classifyWebcamUrl('https://user:pw@cam.example.org/a.jpg'),
    null,
  );
  assert.equal(classifyWebcamUrl(''), null);
});

test('OSM objects become site-precise pins with a category from their tags', () => {
  const sources = osmToSources([
    {
      type: 'node',
      id: 101,
      lat: 39.2855,
      lon: -76.6085,
      tags: {
        name: 'Inner Harbor',
        tourism: 'viewpoint',
        'contact:webcam': 'https://example.org/harbor.jpg',
      },
    },
    {
      type: 'way',
      id: 202,
      center: { lat: 47.0, lon: 11.0 },
      tags: {
        aerialway: 'gondola',
        'contact:webcam': 'https://ski.example.org/cams',
      },
    },
    {
      type: 'node',
      id: 303,
      lat: 0,
      lon: 0,
      tags: { 'contact:webcam': 'https://x.y/' },
    },
    {
      type: 'node',
      id: 404,
      lat: 1,
      lon: 1,
      tags: { 'contact:webcam': 'not a url' },
    },
  ]);
  assert.deepEqual(
    sources.map((s) => [s.id, s.feedType, s.category, s.operatorUrl]),
    [
      [
        'osm-webcam-n101',
        'image',
        'viewpoint',
        'https://example.org/harbor.jpg',
      ],
      ['osm-webcam-w202', 'link', 'ski', 'https://ski.example.org/cams'],
    ],
  );
  assert.equal(sources[0].snapshotUrl, 'https://example.org/harbor.jpg');
  assert.equal(sources[1].url, '', 'a page link is never fetched as a frame');
  assert.equal(sources[1].name, 'OpenStreetMap way 202');
  assert.equal(sources[0].sourceKind, 'osm-webcam');
  const normalized = normalizeSourceItem(sources[1]);
  assert.equal(normalized.feedType, 'link');
  assert.equal(normalized.operatorUrl, 'https://ski.example.org/cams');
  assert.equal(interestFactor(normalized), 0.5);
  assert.equal(
    interestFactor(
      normalizeSourceItem(
        osmToSources([
          {
            type: 'node',
            id: 1,
            lat: 1,
            lon: 1,
            tags: { highway: 'motorway', 'contact:webcam': 'https://a.b/' },
          },
        ])[0],
      ),
    ),
    1,
  );
  assert.equal(osmCategory({ natural: 'beach' }), 'beach');
  assert.equal(osmCategory({ harbour: 'yes' }), 'port');
  assert.equal(osmCategory({}), 'webcam');
});

test('Wikidata rows become landmark pins, one per distinct link', () => {
  const row = (q, label, url, coord) => ({
    item: { value: `http://www.wikidata.org/entity/${q}` },
    itemLabel: { value: label },
    url: { value: url },
    coord: { value: coord },
  });
  const sources = wikidataToSources([
    row(
      'Q1',
      'Nishi Hongan-ji',
      'https://www.hongwanji.kyoto/see/livecam.html',
      'Point(135.751611 34.992047)',
    ),
    row(
      'Q1',
      'Nishi Hongan-ji',
      'https://www.hongwanji.or.jp/english/camera.html',
      'Point(135.751611 34.992047)',
    ),
    row(
      'Q1',
      'Nishi Hongan-ji',
      'https://www.hongwanji.kyoto/see/livecam.html',
      'Point(135.751611 34.992047)',
    ),
    row(
      'Q2',
      'Falcons',
      'https://www.youtube.com/watch?v=1_BdSTneH3s',
      'Point(-76.61446 39.28736)',
    ),
    row('Q3', 'Bad', 'https://x.y/', 'somewhere'),
  ]);
  assert.equal(sources.length, 3);
  assert.equal(sources[0].lat, 34.992047);
  assert.equal(sources[0].lon, 135.751611);
  assert.equal(sources[0].feedType, 'link');
  assert.equal(sources[0].provider, 'Wikidata');
  assert.deepEqual(sources[2].embed, {
    provider: 'youtube',
    videoId: '1_BdSTneH3s',
  });
  assert.equal(sources[2].licenseClass, 'embed-only');
  assert.equal(normalizeSourceItem(sources[2]).embed.videoId, '1_BdSTneH3s');
});

test('Overpass goes to the configured chain, else public mirrors', () => {
  assert.deepEqual(overpassEndpoints({}), [...DEFAULT_OVERPASS_MIRRORS]);
  assert.deepEqual(
    overpassEndpoints({
      OVERPASS_UPSTREAMS: 'https://a.example/api, nope, https://b.example/api',
    }),
    ['https://a.example/api', 'https://b.example/api'],
  );
});

const osmBody = {
  elements: [
    {
      type: 'node',
      id: 1,
      lat: 39.2855,
      lon: -76.6085,
      tags: { name: 'Harbor', 'contact:webcam': 'https://example.org/h.jpg' },
    },
  ],
};
const wikidataBody = {
  results: {
    bindings: [
      {
        item: { value: 'http://www.wikidata.org/entity/Q9' },
        itemLabel: { value: 'Fort' },
        url: { value: 'https://fort.example.org/cam' },
        coord: { value: 'Point(-76.58 39.26)' },
      },
    ],
  },
};

function fakeFetch({ osmStatus = 200, wikidataStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (href) => {
    calls.push(href);
    if (href.includes('query.wikidata.org'))
      return Response.json(wikidataBody, { status: wikidataStatus });
    if (osmStatus !== 200) return new Response('busy', { status: osmStatus });
    return Response.json(osmBody);
  };
  return { fetchImpl, calls };
}

test('the loader fetches once a week, keeps copies on disk, and serves stale on failure', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-'));
  let clock = 1_000_000;
  try {
    const good = fakeFetch();
    const load = createLinkedLoader({
      fetchImpl: good.fetchImpl,
      now: () => clock,
      cacheDir: dir,
      env: {},
    });
    const first = await load();
    assert.deepEqual(first, [], 'nothing for the capped catalog');
    assert.equal(first.everything.length, 2);
    assert.equal(first.proximityOnly, true);
    assert.equal(good.calls.length, 2);
    assert.ok(
      good.calls.some((c) => c === DEFAULT_OVERPASS_MIRRORS[0]),
      'first public mirror',
    );

    // Within the week: no fetch, even from a new loader (disk copy).
    clock += LINKED_TTL_MS - 1;
    const bad = fakeFetch({ osmStatus: 502, wikidataStatus: 502 });
    const second = createLinkedLoader({
      fetchImpl: bad.fetchImpl,
      now: () => clock,
      cacheDir: dir,
      env: {},
    });
    assert.equal((await second()).everything.length, 2);
    assert.equal(bad.calls.length, 0);

    // After the week, a failed refresh keeps serving the old copy and
    // waits before trying again.
    clock += 2;
    assert.equal((await second()).everything.length, 2);
    assert.equal(bad.calls.length, DEFAULT_OVERPASS_MIRRORS.length + 1);
    assert.equal((await second()).everything.length, 2);
    assert.equal(bad.calls.length, DEFAULT_OVERPASS_MIRRORS.length + 1);
    clock += LINKED_RETRY_MS;
    await second();
    assert.equal(bad.calls.length, 2 * (DEFAULT_OVERPASS_MIRRORS.length + 1));

    const files = (await fs.readdir(dir)).sort();
    assert.deepEqual(files, ['osm.json', 'wikidata.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('linked webcams reach proximity queries but not the capped catalog', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-cat-'));
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^OVERPASS_|^WINDY|^YOUTUBE/.test(key))
        delete process.env[key];
    process.env.CCTV_WINDY_ENABLED = '0';
    process.env.CCTV_FEATURED_ENABLED = '0';
    await fs.mkdir(path.join(dir, '.gev-cache', 'cctv-linked'), {
      recursive: true,
    });
    for (const [name, sources] of [
      ['osm', osmToSources(osmBody.elements)],
      ['wikidata', wikidataToSources(wikidataBody.results.bindings)],
    ])
      await fs.writeFile(
        path.join(dir, '.gev-cache', 'cctv-linked', `${name}.json`),
        JSON.stringify({ at: Date.now(), sources }),
      );
    t.mock.method(globalThis, 'fetch', async () => Response.json([]));
    const getSources = createCctvCatalog({ sourceRoot: dir });
    const capped = await getSources();
    assert.equal(
      capped.some((s) => s.pack === 'linked'),
      false,
    );
    assert.equal(
      getSources.trimmedPacks().some((p) => p.pack === 'linked'),
      false,
      'a proximity-only pack is not reported as trimmed',
    );
    const near = await getSources.near(39.28, -76.6, { radiusKm: 10 });
    assert.deepEqual(near.map((s) => [s.id, s.pack, s.feedType]).sort(), [
      ['osm-webcam-n1', 'linked', 'image'],
      ['wd-webcam-Q9-0', 'linked', 'link'],
    ]);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the panel offers the operator page only for https provenance links', () => {
  assert.deepEqual(
    operatorLinkFor({
      operatorUrl: 'https://www.hongwanji.kyoto/see/livecam.html',
      feedType: 'link',
    }),
    {
      href: 'https://www.hongwanji.kyoto/see/livecam.html',
      text: 'WATCH ON HONGWANJI.KYOTO ↗',
    },
  );
  assert.equal(
    operatorLinkFor({
      operatorUrl: 'https://windy.com/webcams/1',
      feedType: 'image',
    }).text,
    'OPEN ON WINDY.COM ↗',
  );
  assert.equal(operatorLinkFor({ operatorUrl: 'http://plain.example/' }), null);
  assert.equal(operatorLinkFor({ operatorUrl: 'javascript:alert(1)' }), null);
  assert.equal(operatorLinkFor(null), null);
});
