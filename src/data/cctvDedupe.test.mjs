import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createGrid,
  dedupeSources,
  distanceM,
  feedKeys,
  namesAgree,
  nameTokens,
  normalizeFeedUrl,
  normalizeOperatorUrl,
  sourceRank,
} from '../../server/providers/cctv/dedupe.js';
import {
  applyDedupe,
  createCctvCatalog,
} from '../../server/providers/cctv/catalog.js';

/** A point `north`/`east` metres from a base. */
function offset(base, north = 0, east = 0) {
  return {
    lat: base.lat + north / 110_574,
    lon: base.lon + east / (111_320 * Math.cos((base.lat * Math.PI) / 180)),
  };
}
const BALTIMORE = { lat: 39.28736, lon: -76.61446 };

let n = 0;
/** A normalized source of a pack. */
const cam = (pack, extra = {}) => ({
  id: `${pack}-${++n}`,
  name: `Camera ${n}`,
  pack,
  feedType: 'image',
  url: `https://${pack}.example/${n}.jpg`,
  snapshotUrl: `https://${pack}.example/${n}.jpg`,
  operatorUrl: '',
  ...BALTIMORE,
  ...extra,
});
const ids = (result) => result.sources.map((s) => s.id);

test('feed URLs compare without scheme, host case or cache-busters', () => {
  assert.equal(
    normalizeFeedUrl(
      'HTTP://WWW.Cams.Example.org/live/cam1.jpg?t=1729100000&id=7',
    ),
    normalizeFeedUrl('https://cams.example.org/live/cam1.jpg?id=7&_=99'),
  );
  assert.equal(
    normalizeFeedUrl('https://cams.example.org/a.jpg?1729100000000=x&v=3'),
    'cams.example.org/a.jpg?1729100000000=x',
  );
  assert.notEqual(
    normalizeFeedUrl('https://cams.example.org/a.jpg?id=1'),
    normalizeFeedUrl('https://cams.example.org/a.jpg?id=2'),
  );
  assert.equal(normalizeFeedUrl('ftp://x.example/a.jpg'), '');
  assert.equal(normalizeFeedUrl(''), '');
  assert.equal(
    normalizeOperatorUrl(
      'https://www.NPS.gov/crla/learn/photosmultimedia/webcams.htm#top',
    ),
    'nps.gov/crla/learn/photosmultimedia/webcams.htm',
  );
  assert.equal(
    normalizeOperatorUrl('https://explore.org/'),
    '',
    'a front page',
  );
});

test('YouTube streams match by video, whatever URL or thumbnail names it', () => {
  assert.deepEqual(
    feedKeys({
      url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
      snapshotUrl: 'https://i.ytimg.com/vi/1_BdSTneH3s/hqdefault_live.jpg',
      embed: { provider: 'youtube', videoId: '1_BdSTneH3s' },
    }),
    ['yt:1_BdSTneH3s'],
  );
  assert.deepEqual(feedKeys({ url: 'https://youtu.be/1_BdSTneH3s' }), [
    'yt:1_BdSTneH3s',
  ]);
});

test('names agree on shared distinctive words or containment', () => {
  assert.deepEqual(nameTokens('Crater Lake – Rim Village Webcam'), [
    'crater',
    'lake',
    'rim',
    'village',
  ]);
  assert.ok(
    namesAgree(
      nameTokens('Rim Village, Crater Lake'),
      nameTokens('Crater Lake Rim Village'),
    ),
  );
  assert.ok(
    namesAgree(
      nameTokens('Peregrine Falcons'),
      nameTokens('Peregrine falcon nest (Boh & Barb) Peregrine Falcons'),
    ),
  );
  assert.ok(
    !namesAgree(
      nameTokens('I-95 at MD 43 NB'),
      nameTokens('Harbor Point Marina'),
    ),
  );
  assert.ok(
    !namesAgree(nameTokens('Webcam'), nameTokens('Live Cam')),
    'nothing distinctive',
  );
});

test('sources rank featured, agency, USGS/NPS, Windy, linked, directory', () => {
  assert.deepEqual(
    [
      'featured',
      'mdot',
      'file',
      'usgs-volcano',
      'nps',
      'windy',
      'linked',
      'camindex',
    ].map((pack) => sourceRank({ pack })),
    [0, 1, 1, 2, 2, 3, 4, 5],
  );
  assert.equal(
    sourceRank({ pack: 'nps', feedType: 'hls' }),
    1,
    'an HLS feed is agency-grade',
  );
  assert.equal(sourceRank({ pack: 'featured', feedType: 'hls' }), 0);
});

test('rule a: the same feed, within 25 km, wherever each pack places it', () => {
  const mdot = cam('mdot', {
    feedType: 'hls',
    url: 'https://strmr5.sha.maryland.gov/rtplive/abc/playlist.m3u8',
  });
  const copy = cam('camindex', {
    url: 'http://STRMR5.sha.maryland.gov/rtplive/abc/playlist.m3u8?t=1729100000',
    snapshotUrl: 'https://opencctv.org/still/1.jpg',
    ...offset(BALTIMORE, 4000),
  });
  const far = cam('windy', { url: mdot.url, ...offset(BALTIMORE, 40_000) });
  const featured = cam('featured', {
    feedType: 'youtube',
    url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
    embed: { provider: 'youtube', videoId: '1_BdSTneH3s' },
  });
  const linked = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'youtube',
    url: 'https://youtu.be/1_BdSTneH3s',
    ...offset(BALTIMORE, 900),
  });
  const result = dedupeSources([copy, linked, mdot, featured, far], {
    record: true,
  });
  assert.deepEqual(
    ids(result),
    [mdot.id, featured.id, far.id].sort(
      (a, b) =>
        [copy, linked, mdot, featured, far].findIndex((s) => s.id === a) -
        [copy, linked, mdot, featured, far].findIndex((s) => s.id === b),
    ),
  );
  assert.equal(result.byRule.url, 2);
  assert.deepEqual(
    result.merges.map((m) => [m.winner.id, m.loser.id, m.rule]),
    [
      [featured.id, linked.id, 'url'],
      [mdot.id, copy.id, 'url'],
    ],
  );
  assert.equal(result.winnerOf.get(copy.id), mdot.id);
});

test('rule a ignores a placeholder image a pack uses for many cameras', () => {
  const placeholder = 'https://cams.example.gov/offline.jpg';
  const pack = [1, 2, 3].map((i) =>
    cam('deldot', {
      snapshotUrl: placeholder,
      url: placeholder,
      ...offset(BALTIMORE, i * 2000),
    }),
  );
  const elsewhere = cam('windy', {
    snapshotUrl: placeholder,
    url: placeholder,
    ...offset(BALTIMORE, 9000),
  });
  assert.equal(dedupeSources([...pack, elsewhere]).removed, 0);
  // Two records of one camera in one pack are still one camera.
  const twice = [
    cam('caltrans', { url: 'https://cwwp2.example/a.jpg' }),
    cam('caltrans', {
      url: 'https://cwwp2.example/a.jpg',
      ...offset(BALTIMORE, 10),
    }),
  ];
  assert.equal(dedupeSources(twice).removed, 1);
});

test('rule b: the same operator page within 500 m, across families only', () => {
  const page = 'https://www.nps.gov/crla/learn/photosmultimedia/webcams.htm';
  const crater = { lat: 42.9112, lon: -122.1435 };
  const nps = cam('nps', { operatorUrl: page, ...crater });
  const usgs = cam('usgs-volcano', {
    operatorUrl: page,
    ...offset(crater, 300),
  });
  const farUsgs = cam('usgs-volcano', {
    operatorUrl: page,
    ...offset(crater, 700),
  });
  const result = dedupeSources([nps, usgs, farUsgs], { record: true });
  assert.deepEqual(ids(result), [nps.id, farUsgs.id]);
  assert.equal(result.merges[0].rule, 'operator');
  assert.equal(result.merges[0].distanceM, 300);
  // Same family: two cams on one park page stay two.
  assert.equal(
    dedupeSources([
      cam('nps', { operatorUrl: page, ...crater }),
      cam('nps', { operatorUrl: page, ...offset(crater, 100) }),
    ]).removed,
    0,
  );
  // A hub page shared by many cams of a family is no evidence.
  const hub = 'https://explore.org/livecams';
  const katmai = { lat: 58.5552, lon: -155.7787 };
  const featured = [0, 1, 2].map((i) =>
    cam('featured', { operatorUrl: hub, ...offset(katmai, i * 150) }),
  );
  const linked = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    operatorUrl: hub,
    ...offset(katmai, 400),
  });
  assert.equal(dedupeSources([...featured, linked]).removed, 0);
});

test('rule c: within 30 m and the names agree, across families only', () => {
  const windy = cam('windy', { name: 'Crater Lake Rim Village' });
  const linked = cam('linked', {
    sourceKind: 'wikidata-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'Rim Village, Crater Lake',
    ...offset(BALTIMORE, 20),
  });
  const otherName = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'Harbor Marina',
    ...offset(BALTIMORE, 10),
  });
  const tooFar = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'Crater Lake Rim Village',
    ...offset(BALTIMORE, 0, 45),
  });
  const result = dedupeSources([linked, otherName, tooFar, windy], {
    record: true,
  });
  assert.deepEqual(ids(result), [otherName.id, tooFar.id, windy.id]);
  assert.deepEqual(
    result.merges.map((m) => [m.loser.id, m.rule]),
    [[linked.id, 'name']],
  );
  // Two views on one pole of one agency pack stay two cameras.
  const pole = [
    cam('mdot', { name: 'I-95 at MD 43 NB' }),
    cam('mdot', { name: 'I-95 at MD 43 SB', ...offset(BALTIMORE, 5) }),
  ];
  assert.equal(dedupeSources(pole).removed, 0);
});

test('rule d: a directory camera within 60 m of a camera with its own feed', () => {
  const featured = cam('featured', {
    name: 'Peregrine falcon nest (Boh & Barb)',
    feedType: 'youtube',
    url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
  });
  const opencctv = cam('camindex', {
    name: 'Peregrine Falcons',
    lat: 39.287291,
    lon: -76.614449,
  });
  // Re-hosted under another name: taken, whatever its name...
  const traffic = cam('mdot', {
    name: 'I-83 AT PRATT ST',
    feedType: 'hls',
    ...offset(BALTIMORE, -3000),
  });
  const unrelatedName = cam('camindex', {
    name: 'Baltimore: Inner Harbor',
    ...offset(BALTIMORE, -3000, -50),
  });
  // ...but only once: a second unnamed view next to it is another camera,
  // and so is one next to the falcon cam its named copy already claimed.
  const secondView = cam('camindex', {
    name: 'Baltimore: Jones Falls',
    ...offset(BALTIMORE, -3000, 40),
  });
  const besideFalcons = cam('camindex', {
    name: 'Baltimore: Light Street',
    ...offset(BALTIMORE, 0, -50),
  });
  const beyond = cam('camindex', {
    name: 'Baltimore: Downtown',
    ...offset(BALTIMORE, 70),
  });
  const pageOnly = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'Harbor page',
    ...offset(BALTIMORE, 2000),
  });
  const nearPage = cam('camindex', {
    name: 'Fells Point',
    ...offset(BALTIMORE, 2040),
  });
  const directoryPair = [
    cam('camindex', { name: 'A', ...offset(BALTIMORE, 5000) }),
    cam('camindex', { name: 'B', ...offset(BALTIMORE, 5010) }),
  ];
  const result = dedupeSources(
    [
      opencctv,
      unrelatedName,
      secondView,
      besideFalcons,
      beyond,
      nearPage,
      pageOnly,
      ...directoryPair,
      featured,
      traffic,
    ],
    { record: true },
  );
  assert.deepEqual(
    ids(result).sort(),
    [
      secondView.id,
      besideFalcons.id,
      traffic.id,
      beyond.id,
      nearPage.id,
      pageOnly.id,
      ...directoryPair.map((s) => s.id),
      featured.id,
    ].sort(),
  );
  assert.equal(result.byRule.directory, 2);
  const falcon = result.merges.find((m) => m.loser.id === opencctv.id);
  assert.equal(falcon.winner.id, featured.id);
  assert.ok(falcon.distanceM <= 10);
});

test('the best source wins, keeps its own record and learns where else it is listed', () => {
  const page = 'https://cams.example.org/harbor';
  const linked = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'Harbor Cam',
    operatorUrl: page,
    category: 'port',
  });
  const windy = cam('windy', {
    name: 'Harbor Cam',
    operatorUrl: page,
    category: 'city',
    ...offset(BALTIMORE, 10),
  });
  const nps = cam('nps', {
    name: 'Harbor Cam',
    operatorUrl: '',
    category: 'nature',
    ...offset(BALTIMORE, 5),
  });
  const camindex = cam('camindex', {
    name: 'Harbor',
    ...offset(BALTIMORE, 20),
    operatorUrl: 'https://opencctv.org/cameras/x',
  });
  const result = dedupeSources([linked, windy, camindex, nps]);
  assert.equal(result.sources.length, 1);
  const [winner] = result.sources;
  assert.equal(winner.id, nps.id);
  assert.equal(winner.category, 'nature', 'categories are the winner’s');
  assert.deepEqual(winner.alsoListedIn, ['camindex', 'linked', 'windy']);
  assert.equal(winner.operatorUrl, page, 'an empty operator page is filled');
  assert.equal(nps.alsoListedIn, undefined, 'inputs are not changed');
  // A winner with its own operator page keeps it.
  const own = cam('usgs-volcano', {
    operatorUrl: 'https://volcanoes.usgs.gov/x',
    name: 'Harbor Cam',
    ...offset(BALTIMORE, 5),
  });
  assert.equal(
    dedupeSources([own, windy]).sources[0].operatorUrl,
    own.operatorUrl,
  );
});

test('the grid finds neighbours across cell edges and at high latitude', () => {
  for (const base of [
    BALTIMORE,
    { lat: 69.65, lon: 18.95 },
    { lat: -54.8, lon: -68.3 },
    { lat: 51.4, lon: 179.9995 },
  ]) {
    const grid = createGrid();
    const points = [];
    for (let i = 0; i < 40; i++) {
      const p = offset(base, (i % 7) * 37 - 100, Math.floor(i / 7) * 41 - 100);
      points.push(p);
      grid.add({ lat: p.lat, lon: p.lon, source: p });
    }
    for (const p of points) {
      const found = new Set(
        [...grid.around(p.lat, p.lon)].map((e) => e.source),
      );
      for (const q of points)
        if (distanceM(p, q) <= 60)
          assert.ok(found.has(q), `${base.lat}: a point within 60 m is found`);
    }
  }
});

test('the capped catalog gives way to the winner without losing a camera', () => {
  const agency = cam('mdot', {
    feedType: 'hls',
    url: 'https://s.example/a.m3u8',
  });
  const nps = cam('nps', { url: 'https://s.example/a.m3u8' });
  const other = cam('nps');
  const deduped = dedupeSources([agency, nps, other]);
  // Both served: the duplicate is dropped, the winner carries provenance.
  assert.deepEqual(
    applyDedupe([nps, agency, other], deduped).map((s) => [
      s.id,
      s.alsoListedIn,
    ]),
    [
      [agency.id, ['nps']],
      [other.id, undefined],
    ],
  );
  // The winner trimmed by the cap: it takes the duplicate's place.
  assert.deepEqual(
    applyDedupe([nps, other], deduped).map((s) => s.id),
    [agency.id, other.id],
  );
});

test(
  '50,000 cameras de-duplicate in well under 300 ms',
  { skip: process.env.CI ? 'timing on shared CI' : false },
  () => {
    const packs = [
      'mdot',
      'caltrans',
      'featured',
      'nps',
      'windy',
      'linked',
      'camindex',
    ];
    const sources = [];
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 50_000; i++) {
      const pack = packs[i % packs.length];
      // Clustered like real cameras: cities with many cameras close together.
      const city = Math.floor(random() * 400);
      sources.push({
        id: `${pack}-${i}`,
        pack,
        name: `Camera ${Math.floor(random() * 2000)} Main Street`,
        lat: -40 + (city % 40) * 2 + random() * 0.05,
        lon: -120 + Math.floor(city / 40) * 20 + random() * 0.05,
        feedType: pack === 'linked' ? 'link' : 'image',
        url: `https://${pack}.example/${i % 45_000}.jpg`,
        snapshotUrl: '',
        operatorUrl: `https://${pack}.example/cams/${i % 30_000}`,
        sourceKind:
          pack === 'linked' ? (i % 2 ? 'osm-webcam' : 'wikidata-webcam') : pack,
      });
    }
    dedupeSources(sources.slice(0, 5000)); // warm up
    let result;
    let elapsed = Infinity;
    // Best of three: one pass is what a refresh costs; the rest is noise
    // from whatever else the machine is doing.
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      result = dedupeSources(sources);
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    assert.ok(result.removed > 0);
    // 300 ms on an unloaded machine, where 200,000 Map inserts take under
    // 60 ms; a busier machine (other suites, a browser) gets a budget
    // scaled by how much slower that reference runs right now.
    let reference = Infinity;
    for (let run = 0; run < 3; run++) {
      const map = new Map();
      const started = performance.now();
      for (let i = 0; i < 200_000; i++) map.set(`k${i}`, { i });
      reference = Math.min(reference, performance.now() - started);
    }
    const budget = 300 * Math.max(1, reference / 60);
    assert.ok(
      elapsed < budget,
      `${Math.round(elapsed)} ms, budget ${Math.round(budget)} ms (reference ${Math.round(reference)} ms)`,
    );
  },
);

test('the catalog and near() serve one pin per camera, including dynamic Windy results', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-dedupe-cat-'));
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^OVERPASS_|^WINDY|^YOUTUBE|^CAMINDEX_|^NPS_/.test(key))
        delete process.env[key];
    for (const pack of ['FEATURED', 'LINKED', 'USGS', 'NPS'])
      process.env[`CCTV_${pack}_ENABLED`] = '0';
    process.env.WINDY_WEBCAMS_API_KEY = 'test-key';
    // The directory lists the falcon nest twice over: next to a Windy cam.
    await fs.mkdir(path.join(dir, '.gev-cache', 'camindex'), {
      recursive: true,
    });
    const directory = (id, name, at) => ({
      id,
      name,
      city: 'Baltimore',
      lat: at.lat,
      lon: at.lon,
      feedType: 'image',
      snapshotUrl: `https://opencctv.org/still/${id}.jpg`,
      operatorUrl: `https://opencctv.org/cameras/${id}`,
      category: 'nature',
    });
    await fs.writeFile(
      path.join(dir, '.gev-cache', 'camindex', 'catalog.json'),
      JSON.stringify({
        cameras: [
          directory('opencctv-1', 'Harbor East', offset(BALTIMORE, 20)),
          directory('opencctv-2', 'Federal Hill', offset(BALTIMORE, 3000)),
        ],
      }),
    );
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (String(url).startsWith('https://api.windy.com/'))
        return Response.json({
          webcams: [
            {
              webcamId: 1234567890,
              title: 'Baltimore Harbor East',
              status: 'active',
              location: {
                latitude: offset(BALTIMORE, 10).lat,
                longitude: BALTIMORE.lon,
                city: 'Baltimore',
              },
              images: {
                current: {
                  preview:
                    'https://imgproxy.windy.com/_/preview/1234567890.jpg',
                },
              },
              urls: { detail: 'https://www.windy.com/webcams/1234567890' },
              categories: [{ id: 'city' }],
            },
          ],
        });
      return Response.json([]);
    });
    const getSources = createCctvCatalog({ sourceRoot: dir });
    await getSources();
    const before = getSources
      .index()
      .filter((s) => s.pack === 'camindex')
      .map((s) => s.id);
    assert.deepEqual(
      before.sort(),
      ['opencctv-1', 'opencctv-2'],
      'nothing in the index to fold yet',
    );
    const near = await getSources.near(BALTIMORE.lat, BALTIMORE.lon, {
      radiusKm: 10,
    });
    assert.deepEqual(near.map((s) => s.id).sort(), [
      'opencctv-2',
      'windy-1234567890',
    ]);
    const windy = near.find((s) => s.id === 'windy-1234567890');
    assert.deepEqual(windy.alsoListedIn, ['camindex']);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a site with several directory views keeps all but the one it re-hosts', () => {
  // USGS's PAUL station: one camera of ours, five OpenCCTV views at one spot.
  const station = { lat: 46.92756, lon: -122.07961 };
  const usgs = cam('usgs-volcano', {
    name: 'CVO Baker (PAUL, Easton Glacier)',
    ...station,
  });
  const views = [
    'Easton Glacier',
    'Mowich Face',
    'Puyallup River',
    'Observation Rock',
  ].map((view) =>
    cam('camindex', { name: `CVO Rainier (PAUL, ${view})`, ...station }),
  );
  const result = dedupeSources([...views, usgs], { record: true });
  assert.deepEqual(
    result.merges.map((m) => m.loser.name),
    ['CVO Rainier (PAUL, Easton Glacier)'],
  );
  assert.equal(result.sources.length, 4);
  // Without agreeing names, only the nearest one is taken as the re-host.
  const highway = cam('drivebc', { name: 'Radium Hot Springs northbound' });
  const resort = ['N', 'S'].map((side) =>
    cam('camindex', {
      name: `Panorama Mountain Resort - ${side}`,
      ...offset(BALTIMORE, 54),
    }),
  );
  assert.equal(dedupeSources([highway, ...resort]).removed, 1);
});

test('two agencies’ cameras at one junction stay two', () => {
  const city = cam('austin', { name: 'IH 35 SVRD / 6TH ST' });
  const state = cam('txdot', { name: 'IH-35 @ 6th', ...offset(BALTIMORE, 22) });
  assert.equal(dedupeSources([city, state]).removed, 0);
  // An agency feed still absorbs a webcam listing of it.
  const listing = cam('linked', {
    sourceKind: 'osm-webcam',
    feedType: 'link',
    url: '',
    snapshotUrl: '',
    name: 'IH 35 at 6th St',
    ...offset(BALTIMORE, 10),
  });
  assert.equal(dedupeSources([city, listing]).removed, 1);
});

test('a dynamic Windy result ranks as Windy even without a pack', () => {
  assert.equal(sourceRank({ sourceKind: 'windy', feedType: 'image' }), 3);
  const windy = {
    ...cam('x'),
    pack: undefined,
    sourceKind: 'windy',
    name: 'Harbor East',
  };
  const listing = cam('camindex', {
    name: 'Harbor East',
    ...offset(BALTIMORE, 10),
  });
  const agency = cam('mdot', { name: 'Harbor East', ...offset(BALTIMORE, 5) });
  assert.deepEqual(ids(dedupeSources([windy, listing, agency])), [agency.id]);
});
