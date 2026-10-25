import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import {
  LINKED_RETRY_MS,
  LINKED_TTL_MS,
  QLEVER_OSM_ENDPOINT,
  QLEVER_TAG_KEYS,
  QLEVER_WEBCAM_QUERY,
  classifyWebcamUrl,
  createLinkedLoader,
  osmCategory,
  osmToSources,
  overpassEndpoints,
  postForm,
  qleverToElements,
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

test('Overpass goes to the configured chain only (as the Overpass proxy reads it), else straight to QLever', () => {
  assert.deepEqual(overpassEndpoints({}), [], 'no public mirror of its own');
  assert.deepEqual(
    overpassEndpoints({
      OVERPASS_UPSTREAMS:
        'https://a.example/api, nope, http://localhost:12345/api/interpreter, https://a.example/api',
    }),
    ['https://a.example/api', 'http://localhost:12345/api/interpreter'],
  );
});

/** The configured Overpass in the loader tests (the local instance, say). */
const LOCAL = 'http://localhost:12345/api/interpreter';
const localEnv = { OVERPASS_UPSTREAMS: LOCAL };

/** A load, its background refresh run to the end, and the load after it. */
async function loadSettled(load) {
  await load();
  await load.settled();
  return load();
}

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

/** A QLever transport that answers every request with one fixed reply. */
function fakeQlever(reply) {
  const calls = [];
  const request = async (url, body, options) => {
    calls.push({ url, body, options });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { request, calls };
}

/** QLever rows for one object: one per tag, each with the centroid. */
function qleverRows(iri, centroid, tags) {
  return Object.entries(tags).map(([key, value]) => {
    const row = {
      osm: { type: 'uri', value: iri },
      key: {
        type: 'uri',
        value: `https://www.openstreetmap.org/wiki/Key:${key}`,
      },
      value: { type: 'literal', value },
    };
    if (centroid)
      row.centroid = {
        type: 'literal',
        datatype: 'http://www.opengis.net/ont/geosparql#wktLiteral',
        value: centroid,
      };
    return row;
  });
}
const qleverBody = {
  head: { vars: ['osm', 'centroid', 'key', 'value'] },
  results: {
    bindings: [
      ...qleverRows(
        'https://www.openstreetmap.org/node/1',
        'POINT(-76.6085 39.2855)',
        { 'contact:webcam': 'https://example.org/h.jpg', name: 'Harbor' },
      ),
      ...qleverRows(
        'https://www.openstreetmap.org/way/1012900648',
        'POINT(9.183784 48.784407)',
        {
          'contact:webcam': 'https://ski.example.org/cams',
          aerialway: 'gondola',
          'addr:city': 'Stuttgart',
        },
      ),
      // The same object again, and a key the query did not ask for: the
      // first value and the first centroid win; the stray key is ignored.
      ...qleverRows('https://www.openstreetmap.org/node/1', 'POINT(0 0)', {
        'contact:webcam': 'https://other.example.org/',
        'surveillance:type': 'camera',
      }),
      // No centroid: dropped by osmToSources.
      ...qleverRows('https://www.openstreetmap.org/relation/7', null, {
        'contact:webcam': 'https://r.example.org/',
      }),
      // Not an OSM object IRI.
      ...qleverRows('https://example.org/node/9', 'POINT(1 1)', {
        'contact:webcam': 'https://n.example.org/',
      }),
    ],
  },
};

test('the loader fetches once a week in the background, keeps copies on disk, and serves stale on failure', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-'));
  let clock = 1_000_000;
  try {
    const good = fakeFetch();
    const qlever = fakeQlever({ status: 503, text: 'down' });
    const load = createLinkedLoader({
      fetchImpl: good.fetchImpl,
      qleverRequest: qlever.request,
      now: () => clock,
      cacheDir: dir,
      env: localEnv,
    });
    const before = await load();
    assert.deepEqual(
      before.everything,
      [],
      'nothing held yet: answered at once',
    );
    await load.settled();
    const first = await load();
    assert.deepEqual(first, [], 'nothing for the capped catalog');
    assert.equal(first.everything.length, 2);
    assert.equal(first.proximityOnly, true);
    assert.deepEqual(
      good.calls.sort(),
      [LOCAL, good.calls.find((c) => c.includes('wikidata'))].sort(),
    );

    // Within the week: no fetch, even from a new loader (disk copy).
    clock += LINKED_TTL_MS - 1;
    const bad = fakeFetch({ osmStatus: 502, wikidataStatus: 502 });
    const second = createLinkedLoader({
      fetchImpl: bad.fetchImpl,
      qleverRequest: qlever.request,
      now: () => clock,
      cacheDir: dir,
      env: localEnv,
    });
    assert.equal((await second()).everything.length, 2);
    await second.settled();
    assert.equal(bad.calls.length, 0);

    // After the week, a failed refresh keeps serving the old copy and
    // waits LINKED_RETRY_MS before trying again.
    clock += 2;
    assert.equal((await second()).everything.length, 2, 'stale, at once');
    await second.settled();
    assert.equal(bad.calls.length, 2, 'the configured Overpass and Wikidata');
    assert.equal((await second()).everything.length, 2);
    await second.settled();
    assert.equal(bad.calls.length, 2, 'backing off');
    const failed = second.status().lists.find((l) => l.name === 'osm');
    assert.equal(failed.refreshing, false);
    assert.equal(failed.lastFailedAt, new Date(clock).toISOString());
    assert.match(failed.lastError, /Overpass 502; QLever: QLever 503/);
    assert.equal(
      failed.nextAttemptAt,
      new Date(clock + LINKED_RETRY_MS).toISOString(),
    );
    clock += LINKED_RETRY_MS;
    await loadSettled(second);
    assert.equal(bad.calls.length, 4);
    assert.equal(qlever.calls.length, 2, 'QLever once per failed refresh');

    const files = (await fs.readdir(dir)).sort();
    assert.deepEqual(files, ['osm.json', 'wikidata.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A fetch that waits for its release, or for its signal's abort. */
function heldFetch() {
  const calls = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const fetchImpl = (href, init) => {
    calls.push({ href, signal: init?.signal });
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(init.signal.reason),
        {
          once: true,
        },
      );
      released.then(() =>
        resolve(
          href.includes('wikidata')
            ? Response.json(wikidataBody)
            : Response.json(osmBody),
        ),
      );
    });
  };
  return { fetchImpl, calls, release: () => release() };
}

/** A cache directory holding both lists, written at `at`. */
async function cacheAt(dir, at) {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, sources] of [
    [
      'osm',
      osmToSources(osmBody.elements).map((s) => ({ ...s, id: `${s.id}-old` })),
    ],
    ['wikidata', wikidataToSources(wikidataBody.results.bindings)],
  ])
    await fs.writeFile(
      path.join(dir, `${name}.json`),
      JSON.stringify({ at, sources }),
    );
}

test('a stale copy is served at once; the refresh runs in the background, one at a time, and the next load has it', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-swr-'));
  let clock = 10 * LINKED_TTL_MS;
  try {
    await cacheAt(dir, clock - LINKED_TTL_MS - 1);
    const held = heldFetch();
    const qlever = fakeQlever(new Error('unused'));
    const load = createLinkedLoader({
      fetchImpl: held.fetchImpl,
      qleverRequest: qlever.request,
      now: () => clock,
      cacheDir: dir,
      env: localEnv,
    });
    const stale = await load();
    assert.deepEqual(
      stale.everything.map((s) => s.id).sort(),
      ['osm-webcam-n1-old', 'wd-webcam-Q9-0'],
      'the stale copy, while the fetch is still waiting',
    );
    assert.equal(held.calls.length, 2);
    const during = load.status().lists;
    assert.deepEqual(
      during.map((l) => [l.name, l.refreshing, l.count]),
      [
        ['osm', true, 1],
        ['wikidata', true, 1],
      ],
    );
    assert.equal(
      during[0].at,
      new Date(clock - LINKED_TTL_MS - 1).toISOString(),
    );
    // Asked again meanwhile: the same copy, no second refresh.
    await load();
    assert.equal(held.calls.length, 2, 'one refresh at a time');
    held.release();
    await load.settled();
    const fresh = await load();
    assert.deepEqual(
      fresh.everything.map((s) => s.id).sort(),
      ['osm-webcam-n1', 'wd-webcam-Q9-0'],
      'the new list',
    );
    assert.deepEqual(
      load.status().lists.map((l) => [l.refreshing, l.at, l.lastFailedAt]),
      [
        [false, new Date(clock).toISOString(), null],
        [false, new Date(clock).toISOString(), null],
      ],
    );
    assert.ok(
      held.calls.every((c) => c.signal.aborted),
      'nothing left listening',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a refresh gives up at its deadline, aborting what it waits on; then it backs off', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-deadline-'));
  let clock = 10 * LINKED_TTL_MS;
  try {
    await cacheAt(dir, clock - LINKED_TTL_MS - 1);
    const held = heldFetch(); // never released
    const qlever = fakeQlever({
      status: 200,
      text: JSON.stringify(qleverBody),
    });
    const load = createLinkedLoader({
      fetchImpl: held.fetchImpl,
      qleverRequest: qlever.request,
      now: () => clock,
      cacheDir: dir,
      env: localEnv,
      deadlineMs: 30,
    });
    const started = Date.now();
    assert.equal((await load()).everything.length, 2, 'stale, at once');
    await load.settled();
    assert.ok(
      Date.now() - started < 5000,
      'within the deadline, not the upstream timeouts',
    );
    assert.ok(
      held.calls.every((c) => c.signal.aborted),
      'every request aborted',
    );
    assert.equal(qlever.calls.length, 0, 'no QLever after the deadline');
    const [osm, wikidata] = load.status().lists;
    assert.match(osm.lastError, /no answer within 0 s|no answer within/);
    assert.match(wikidata.lastError, /no answer within/);
    assert.equal(osm.count, 1, 'the stale copy kept');
    // Backing off: no refresh until LINKED_RETRY_MS has passed.
    clock += LINKED_RETRY_MS - 1;
    await load();
    await load.settled();
    assert.equal(held.calls.length, 2);
    clock += 1;
    await load();
    await load.settled();
    assert.equal(held.calls.length, 4, 'and then once more');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('with no copy at all the pack answers empty at once, and holds the list once fetched', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-none-'));
  try {
    const held = heldFetch();
    const load = createLinkedLoader({
      fetchImpl: held.fetchImpl,
      qleverRequest: fakeQlever(new Error('unused')).request,
      cacheDir: dir,
      env: localEnv,
    });
    const empty = await load();
    assert.deepEqual([empty.length, empty.everything.length], [0, 0]);
    assert.deepEqual(
      load.status().lists.map((l) => [l.at, l.refreshing]),
      [
        [null, true],
        [null, true],
      ],
    );
    assert.equal(
      typeof empty.upstream,
      'function',
      'the readout rides with the list',
    );
    held.release();
    await load.settled();
    assert.equal((await load()).everything.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the QLever query names every tag the normalizer reads', () => {
  assert.match(
    QLEVER_WEBCAM_QUERY,
    /\?osm <https:\/\/www\.openstreetmap\.org\/wiki\/Key:contact:webcam> \?webcam \./,
  );
  const values = /VALUES \?key \{([^}]*)\}/.exec(QLEVER_WEBCAM_QUERY)[1];
  const named = [
    ...values.matchAll(
      /<https:\/\/www\.openstreetmap\.org\/wiki\/Key:([^>]+)>/g,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(named, [...QLEVER_TAG_KEYS]);
  for (const key of [
    'contact:webcam',
    'name',
    'addr:city',
    'amenity',
    'tourism',
    'man_made',
    'natural',
    'leisure',
    'highway',
    'place',
    'building',
    'shop',
    'harbour',
    'aeroway',
    'aerialway',
    'historic',
    'sport',
    'landuse',
  ])
    assert.ok(QLEVER_TAG_KEYS.includes(key), key);
  assert.match(QLEVER_WEBCAM_QUERY, /geof:centroid\(\?wkt\) AS \?centroid/);
});

test('QLever rows become the same elements Overpass returns', () => {
  const elements = qleverToElements(qleverBody.results.bindings);
  assert.deepEqual(elements, [
    {
      type: 'node',
      id: 1,
      lat: 39.2855,
      lon: -76.6085,
      tags: { 'contact:webcam': 'https://example.org/h.jpg', name: 'Harbor' },
    },
    {
      type: 'way',
      id: 1012900648,
      lat: 48.784407,
      lon: 9.183784,
      tags: {
        'contact:webcam': 'https://ski.example.org/cams',
        aerialway: 'gondola',
        'addr:city': 'Stuttgart',
      },
    },
    {
      type: 'relation',
      id: 7,
      tags: { 'contact:webcam': 'https://r.example.org/' },
    },
  ]);
  assert.deepEqual(
    osmToSources(elements).map((s) => [s.id, s.category, s.city]),
    [
      ['osm-webcam-n1', 'webcam', 'Linked webcam'],
      ['osm-webcam-w1012900648', 'ski', 'Stuttgart'],
    ],
  );
  assert.deepEqual(qleverToElements(null), []);
  assert.deepEqual(qleverToElements([{ osm: { value: 42 } }, null]), []);
});

test('QLever is asked only after every configured Overpass fails, or at once when none is', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-ql-'));
  try {
    // Overpass answers: QLever is never asked.
    const good = fakeFetch();
    const unused = fakeQlever({
      status: 200,
      text: JSON.stringify(qleverBody),
    });
    const first = createLinkedLoader({
      fetchImpl: good.fetchImpl,
      qleverRequest: unused.request,
      cacheDir: path.join(dir, 'a'),
      env: localEnv,
    });
    assert.equal((await loadSettled(first)).everything.length, 2);
    assert.equal(unused.calls.length, 0);

    // Every mirror fails: each is tried in order, then QLever once.
    const order = [];
    const bad = fakeFetch({ osmStatus: 502 });
    const qlever = fakeQlever({
      status: 200,
      text: JSON.stringify(qleverBody),
    });
    const second = createLinkedLoader({
      fetchImpl: async (href, init) => {
        order.push(href);
        return bad.fetchImpl(href, init);
      },
      qleverRequest: async (...args) => {
        order.push('qlever');
        return qlever.request(...args);
      },
      cacheDir: path.join(dir, 'b'),
      env: { OVERPASS_UPSTREAMS: `${LOCAL},https://b.example/api` },
    });
    const result = await loadSettled(second);
    assert.deepEqual(
      order.filter((href) => !href.includes('wikidata')),
      [LOCAL, 'https://b.example/api', 'qlever'],
    );
    assert.deepEqual(
      result.everything.map((s) => s.id).sort(),
      ['osm-webcam-n1', 'osm-webcam-w1012900648', 'wd-webcam-Q9-0'].sort(),
    );
    const [call] = qlever.calls;
    assert.equal(call.url, QLEVER_OSM_ENDPOINT);
    assert.equal(
      new URLSearchParams(call.body).get('query'),
      QLEVER_WEBCAM_QUERY,
    );
    assert.equal(
      call.options.headers.Accept,
      'application/sparql-results+json',
    );
    assert.ok(call.options.timeoutMs >= 60_000, 'slow connects are allowed');
    assert.equal(call.options.maxBytes, 32 * 1024 * 1024);
    const cached = JSON.parse(
      await fs.readFile(path.join(dir, 'b', 'osm.json'), 'utf8'),
    );
    assert.equal(cached.sources.length, 2);

    // None configured: QLever at once, no public mirror.
    const direct = [];
    const third = createLinkedLoader({
      fetchImpl: async (href, init) => {
        direct.push(href);
        return bad.fetchImpl(href, init);
      },
      qleverRequest: async (...args) => {
        direct.push('qlever');
        return qlever.request(...args);
      },
      cacheDir: path.join(dir, 'c'),
      env: {},
    });
    assert.equal((await loadSettled(third)).everything.length, 3);
    assert.deepEqual(
      direct.filter((href) => !href.includes('wikidata')),
      ['qlever'],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a bad QLever answer leaves the OSM list empty and is reported', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-qlbad-'));
  try {
    const replies = [
      [{ status: 500, text: '{"exception":"boom"}' }, /QLever 500/],
      [{ status: 308, text: '' }, /QLever 308/],
      [{ status: 200, text: '<html>' }, /QLever returned malformed JSON/],
      [{ status: 200, text: '{"results":{}}' }, /QLever returned no rows/],
      [
        { status: 200, text: '{"results":{"bindings":[]}}' },
        /QLever returned no rows/,
      ],
      [
        { status: 200, text: 'x'.repeat(32 * 1024 * 1024 + 1) },
        /QLever: response too large/,
      ],
      [new Error('connect ETIMEDOUT'), /QLever: connect ETIMEDOUT/],
    ];
    for (const [i, [reply, expected]] of replies.entries()) {
      warnings.length = 0;
      const load = createLinkedLoader({
        fetchImpl: fakeFetch({ osmStatus: 502 }).fetchImpl,
        qleverRequest: fakeQlever(reply).request,
        cacheDir: path.join(dir, String(i)),
        env: localEnv,
      });
      const result = await loadSettled(load);
      assert.deepEqual(
        result.everything.map((s) => s.id),
        ['wd-webcam-Q9-0'],
        String(expected),
      );
      const osmWarning = warnings.find((w) => w.includes('osm webcam links'));
      assert.match(osmWarning, /Overpass 502; QLever/);
      assert.match(osmWarning, expected);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('QLever connection failures get a few fresh attempts', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-linked-qlretry-'));
  const timedOut = () =>
    Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), {
      code: 'ETIMEDOUT',
    });
  try {
    // Two timeouts, then an answer.
    let calls = 0;
    const flaky = createLinkedLoader({
      fetchImpl: fakeFetch({ osmStatus: 502 }).fetchImpl,
      qleverRequest: async () => {
        calls++;
        if (calls <= 2) throw timedOut();
        return { status: 200, text: JSON.stringify(qleverBody) };
      },
      cacheDir: path.join(dir, 'a'),
      env: localEnv,
    });
    assert.equal((await loadSettled(flaky)).everything.length, 3);
    assert.equal(calls, 3);

    // Always timing out: a bounded number of attempts.
    const down = fakeQlever(timedOut());
    const never = createLinkedLoader({
      fetchImpl: fakeFetch({ osmStatus: 502 }).fetchImpl,
      qleverRequest: down.request,
      cacheDir: path.join(dir, 'b'),
      env: localEnv,
    });
    assert.equal((await loadSettled(never)).everything.length, 1);
    assert.equal(down.calls.length, 4);
    assert.ok(warnings.some((w) => /QLever: connect ETIMEDOUT/.test(w)));

    // An answer that was read is never retried.
    const refused = fakeQlever({ status: 400, text: '{}' });
    await loadSettled(
      createLinkedLoader({
        fetchImpl: fakeFetch({ osmStatus: 502 }).fetchImpl,
        qleverRequest: refused.request,
        cacheDir: path.join(dir, 'c'),
        env: localEnv,
      }),
    );
    assert.equal(refused.calls.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A stand-in for https.request: replies with the given status and chunks. */
function fakeHttps(t, { status = 200, headers = {}, chunks = [] }) {
  const sent = [];
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const request = new EventEmitter();
    let destroyed = false;
    request.destroy = (error) => {
      destroyed = true;
      queueMicrotask(() => request.emit('error', error));
    };
    request.end = (body) => {
      sent.push({ url, options, body });
      const response = new EventEmitter();
      response.statusCode = status;
      response.headers = headers;
      queueMicrotask(() => {
        onResponse(response);
        for (const chunk of chunks) {
          if (destroyed) return;
          response.emit('data', Buffer.from(chunk));
        }
        if (!destroyed) response.emit('end');
      });
    };
    return request;
  });
  return sent;
}

test('the QLever transport posts a form and caps what it reads', async (t) => {
  const sent = fakeHttps(t, { status: 200, chunks: ['{"a":', '1}'] });
  assert.deepEqual(
    await postForm('https://q.example/api', 'query=x', {
      headers: { Accept: 'application/sparql-results+json' },
      timeoutMs: 1000,
      maxBytes: 100,
    }),
    { status: 200, text: '{"a":1}' },
  );
  assert.equal(sent[0].options.method, 'POST');
  assert.equal(
    sent[0].options.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  assert.equal(sent[0].options.headers['Content-Length'], 7);
  assert.equal(sent[0].body, 'query=x');
  t.mock.restoreAll();

  fakeHttps(t, { chunks: ['x'.repeat(60), 'x'.repeat(60)] });
  await assert.rejects(
    postForm('https://q.example/api', 'query=x', {
      timeoutMs: 1000,
      maxBytes: 100,
    }),
    /response too large/,
  );
  t.mock.restoreAll();

  fakeHttps(t, { headers: { 'content-length': '101' }, chunks: ['{}'] });
  await assert.rejects(
    postForm('https://q.example/api', 'query=x', {
      timeoutMs: 1000,
      maxBytes: 100,
    }),
    /response too large/,
  );
  t.mock.restoreAll();

  // Aborted by the refresh's deadline: before it starts, and while it runs.
  const gone = new AbortController();
  gone.abort(new Error('deadline'));
  await assert.rejects(
    postForm('https://q.example/api', 'query=x', {
      timeoutMs: 1000,
      maxBytes: 100,
      signal: gone.signal,
    }),
    /deadline/,
  );
  t.mock.method(https, 'request', () => {
    const request = new EventEmitter();
    request.destroy = (error) =>
      queueMicrotask(() => request.emit('error', error));
    request.end = () => {};
    return request;
  });
  const cut = new AbortController();
  const pending = postForm('https://q.example/api', 'query=x', {
    timeoutMs: 60_000,
    maxBytes: 100,
    signal: cut.signal,
  });
  cut.abort(new Error('deadline'));
  await assert.rejects(pending, /deadline/);
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
    // The status readout asks the pack how old its lists are.
    const linked = getSources.status().packs.find((p) => p.name === 'linked');
    assert.deepEqual(
      linked.upstream().lists.map((l) => [l.name, l.count, l.refreshing]),
      [
        ['osm', 1, false],
        ['wikidata', 1, false],
      ],
    );
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
