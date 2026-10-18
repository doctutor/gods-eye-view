// Personal fork: the Recorded Video layer's landmark half
// (server/providers/recordedVideo/landmarks.js and its routes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOOSTS,
  FILMOT_DAILY_CAP,
  LANDMARKS_PER_CELL,
  LANDMARK_QUERY_COST,
  LANDMARK_TTL_MS,
  cellsAround,
  clockText,
  createLandmarkService,
  isIncidentalTitle,
  kindOf,
  landmarkCell,
  landmarkNames,
  landmarksQuery,
  misplacedLandmarks,
  parseFilmotHits,
  parseLandmarkCell,
  samePlaceLandmarks,
  parseLandmarkDetail,
  parseLandmarks,
  rankLandmarkVideos,
  titleNamesLandmark,
} from '../../server/providers/recordedVideo/landmarks.js';
import { SEARCH_TTL_MS } from '../../server/providers/recordedVideo/videos.js';
import { createLandmarkHandler } from '../../server/providers/recordedVideo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILMOT_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'filmot-fort-mchenry-subtitles.json',
);
const CELLS_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'wikidata-landmark-cells.json',
);
const WD = 'http://www.wikidata.org/entity/';

const cellRow = (qid, label, sitelinks, cls, lat = 39.25, lon = -76.65) => ({
  item: { value: `${WD}${qid}` },
  itemLabel: { value: label },
  lat: { value: String(lat) },
  lon: { value: String(lon) },
  sitelinks: { value: String(sitelinks) },
  ...(cls ? { class: { value: `${WD}${cls}` } } : {}),
});

/** Fort McHenry's detail rows: label, two aliases, Baltimore (a city) then Maryland. */
const fortDetail = [
  {
    label: { value: 'Fort McHenry' },
    alias: { value: 'Fort McHenry National Monument and Historic Shrine' },
    lat: { value: '39.2633' },
    lon: { value: '-76.5797' },
    p1Label: { value: 'Baltimore' },
    p1Class: { value: `${WD}Q1266818` },
    p2Label: { value: 'Maryland' },
    p2Class: { value: `${WD}Q35657` },
    p3Label: { value: 'United States' },
  },
  {
    label: { value: 'Fort McHenry' },
    alias: { value: 'Fort Whetstone' },
    lat: { value: '39.2633' },
    lon: { value: '-76.5797' },
    p1Label: { value: 'Baltimore' },
    p1Class: { value: `${WD}Q1093829` },
  },
];

test('a cell’s landmarks: one per item, unlabelled ones out, most sitelinks first, capped', () => {
  const cell = landmarkCell(39.29, -76.61);
  assert.deepEqual(cell, {
    key: '392_-767',
    south: 39.2,
    west: -76.7,
    north: 39.3,
    east: -76.6,
  });
  const query = landmarksQuery(cell);
  assert.match(query, /cornerSouthWest "Point\(-76\.7 39\.2\)"/);
  assert.match(query, /cornerNorthEast "Point\(-76\.6 39\.3\)"/);
  assert.match(query, /wd:Q2281788/, 'aquariums are a landmark class');
  assert.match(query, /\?sitelinks >= 5/);
  assert.match(
    query,
    /OPTIONAL \{ \?item wdt:P17 \?country \. OPTIONAL \{ \?item wdt:P131\/wdt:P625 \?adminLoc \} \}/,
  );
  assert.match(query, /\(MIN\(\?adminKm\) AS \?adminDist\)/);
  const rows = [
    cellRow('Q1000257', 'National Aquarium', 10, 'Q2281788'),
    cellRow('Q1000257', 'National Aquarium', 10, 'Q43501'),
    cellRow('Q1141336', 'M&T Bank Stadium', 27, 'Q483110'),
    cellRow('Q99', 'Q99', 30),
    cellRow('Q5', 'Somewhere', 6, null, 95, 0),
    cellRow('Q3683526', 'Washington Monument', 10),
  ];
  const parsed = parseLandmarks(rows);
  assert.deepEqual(
    parsed.map((l) => [l.qid, l.kind]),
    [
      ['Q1141336', 'stadium'],
      ['Q1000257', 'aquarium'],
      ['Q3683526', 'notable'],
    ],
  );
  const many = Array.from({ length: 70 }, (_, i) =>
    cellRow(`Q${1000 + i}`, `Place ${i}`, i),
  );
  const capped = parseLandmarks(many);
  assert.equal(capped.length, LANDMARKS_PER_CELL);
  assert.equal(capped[0].sitelinks, 69, 'the most linked are kept');
  // The cells around a point: its own first, never more than 3×3.
  const around = cellsAround(39.29, -76.61, 8);
  assert.equal(around[0].key, cell.key);
  assert.ok(around.length > 1 && around.length <= 9);
  assert.equal(cellsAround(39.25, -76.65, 0.5).length, 1);
});

test('a landmark’s detail: aliases, and the city from the enclosing places', () => {
  const detail = parseLandmarkDetail(fortDetail, 'Q1438634');
  assert.deepEqual(detail, {
    qid: 'Q1438634',
    label: 'Fort McHenry',
    aliases: [
      'Fort McHenry National Monument and Historic Shrine',
      'Fort Whetstone',
    ],
    lat: 39.2633,
    lon: -76.5797,
    city: 'Baltimore',
    terms: ['Baltimore', 'Maryland', 'United States'],
  });
  assert.equal(parseLandmarkDetail([], 'Q1'), null);
  // No city among the enclosing places: the nearest one names it.
  const county = parseLandmarkDetail(
    [{ label: { value: 'Old Mill' }, p1Label: { value: 'Some County' } }],
    'Q2',
  );
  assert.equal(county.city, 'Some County');
});

test('the title gate: label or alias, accents and case ignored, possessive and plural allowed', () => {
  const names = landmarkNames({
    label: 'The Walters Art Museum',
    aliases: ['Walters', 'Musée Walters', 'WAM'],
  });
  assert.ok(names.includes('the walters art museum'));
  assert.ok(
    names.includes('walters art museum'),
    'a leading "the" is optional',
  );
  assert.ok(!names.includes('wam'), 'names under four letters are too loose');
  const gate = (title) => titleNamesLandmark(title, names);
  assert.equal(gate('Inside the WALTERS ART MUSEUM, Baltimore'), true);
  assert.equal(gate('A day at the Walters'), true, 'an alias');
  assert.equal(gate('Visite du musee Walters'), true, 'accents ignored');
  assert.equal(gate("The Walters's new wing"), true, 'possessive');
  assert.equal(gate('Walterss'), true, 'plural');
  assert.equal(gate('Waltersville parade'), false, 'not a longer word');
  assert.equal(gate('Baltimore art tour'), false);
  const fort = landmarkNames(parseLandmarkDetail(fortDetail, 'Q1438634'));
  assert.equal(titleNamesLandmark("Fort McHenry's ramparts", fort), true);
  assert.equal(titleNamesLandmark('Fort Mchenry Full Tour', fort), true);
  assert.equal(titleNamesLandmark('Fort Whetstone in 1798', fort), true);
  assert.equal(titleNamesLandmark('McHenry Row condos', fort), false);
});

test('the incidental-title guard and the kind tags', () => {
  for (const title of [
    'Hotel near Fort McHenry',
    'Fort McHenry Inn review',
    'Apartments by the National Aquarium',
    'New listings: Inner Harbor',
    'Federal Hill neighborhood guide',
    'Living in Baltimore near Fort McHenry',
    'Moving to Baltimore',
    'Relocating to Baltimore',
    'Shooting near the Inner Harbor',
    'Man shot by Camden Yards',
    'Police respond at the aquarium',
    'Two killed near the stadium',
    'Voted best aquarium',
    'Ranked: Baltimore’s museums',
  ])
    assert.equal(isIncidentalTitle(title), true, title);
  for (const title of [
    'Fort McHenry Full Tour',
    'Inner Harbor at night',
    'The Battle of Fort McHenry',
  ])
    assert.equal(isIncidentalTitle(title), false, title);
  assert.equal(kindOf('Fort McHenry update', 'WBAL-TV 11 Baltimore'), 'news');
  assert.equal(kindOf('Fort McHenry Full Tour', 'Someone'), 'tour');
  assert.equal(kindOf('Orioles vs. Yankees highlights', 'MLB'), 'event');
  assert.equal(kindOf('Our weekend in Baltimore', 'Us'), 'vlog');
  assert.equal(kindOf('Song (Official Music Video)', 'x'), 'music');
  assert.equal(kindOf('The Battle of Fort McHenry', 'Trust'), 'other');
});

const ytItem = (id, title, extra = {}) => ({
  id,
  snippet: {
    title,
    channelId: extra.channelId || 'UCother',
    channelTitle: extra.channelTitle || 'Someone',
    publishedAt: '2026-01-01T00:00:00Z',
    liveBroadcastContent: extra.live || 'none',
    description: extra.description || '',
  },
  contentDetails: { duration: extra.duration || 'PT6M' },
  recordingDetails: extra.location ? { location: extra.location } : {},
  statistics: { viewCount: '1000' },
});

test('ranking keeps YouTube’s order with small boosts, after the gate and the guard', () => {
  const detail = parseLandmarkDetail(fortDetail, 'Q1438634');
  const ids = [
    'aaaaaaaaaaa',
    'bbbbbbbbbbb',
    'fffffffffff',
    'ccccccccccc',
    'ddddddddddd',
    'eeeeeeeeeee',
    'ggggggggggg',
    'hhhhhhhhhhh',
  ];
  const items = [
    ytItem('aaaaaaaaaaa', 'Fort McHenry Full Tour'),
    ytItem('bbbbbbbbbbb', 'Fort McHenry #shorts', { duration: 'PT40S' }),
    ytItem('ccccccccccc', 'Fort McHenry live', { live: 'live' }),
    ytItem('ddddddddddd', 'Baltimore harbor at night'),
    ytItem('eeeeeeeeeee', 'Hotel near Fort McHenry'),
    ytItem('fffffffffff', 'Five Minute Histories: Fort McHenry', {
      channelId: 'UClocal',
      location: { latitude: 39.264, longitude: -76.58 },
      description: '0:00 Intro\n1:30 The fort\n3:10 The flag',
    }),
    ytItem('ggggggggggg', 'The Battle of Fort McHenry', {
      location: { latitude: 39.4, longitude: -76.58 },
    }),
  ];
  const channels = new Map([
    ['UClocal', { title: 'Baltimore Heritage', description: '' }],
  ]);
  const { videos, skipped } = rankLandmarkVideos({
    ids,
    items,
    channels,
    detail,
  });
  assert.deepEqual(skipped, {
    short: 1,
    live: 1,
    untitled: 1,
    incidental: 1,
    missing: 1,
  });
  assert.deepEqual(
    videos.map((v) => [v.videoId, v.youtubeRank, v.boosts]),
    [
      ['fffffffffff', 3, ['local channel', 'geotag within 1 km', 'chapters']],
      ['aaaaaaaaaaa', 1, []],
      ['ggggggggggg', 7, []],
    ],
    'all three boosts lift the third past the first; a far geotag is no boost',
  );
  assert.equal(
    videos[0].score,
    Math.round(
      (1 - 2 / 25 + BOOSTS.local + BOOSTS.geotag + BOOSTS.chapters) * 1000,
    ) / 1000,
  );
  const record = videos[1];
  assert.equal(record.id, 'lm-Q1438634-aaaaaaaaaaa');
  assert.equal(record.coordinatesQuality, 'about');
  assert.equal(record.source, 'landmark');
  assert.equal(record.kind, 'tour');
  assert.deepEqual([record.lat, record.lon], [39.2633, -76.5797]);
  assert.equal(record.place, 'Fort McHenry');
});

test('Filmot caption hits become "mentioned at" moments (a real answer, trimmed)', async () => {
  const body = JSON.parse(await fs.readFile(FILMOT_FIXTURE, 'utf8'));
  const hits = parseFilmotHits({
    ...body,
    result: [...body.result, { id: 'not-an-id', hits: [{ start: 1 }] }],
  });
  assert.deepEqual(Object.keys(hits).sort(), ['N20k3ix_RLI', 'Umg8v6DLZjs']);
  const battle = hits.N20k3ix_RLI;
  assert.equal(battle.title, 'The Battle of Fort McHenry: War of 1812');
  assert.deepEqual(
    battle.hits.map((h) => h.start),
    [33.7, 50.5, 93.4],
  );
  assert.equal(
    battle.hits[0].text,
    'next they set their sights on Fort McHenry the star-shaped stronghold',
    'a hit’s caption lines, joined',
  );
  assert.equal(clockText(221), '3:41');
  assert.equal(clockText(33.7), '0:33');
  assert.equal(clockText(3725), '1:02:05');
  assert.deepEqual(parseFilmotHits({}), {});
});

/** A fake Wikidata + YouTube + Filmot upstream. */
function upstream({ searchIds = null } = {}) {
  const calls = [];
  let filmotBody = null;
  const ids = searchIds || ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'N20k3ix_RLI'];
  const fetchImpl = async (href, options = {}) => {
    const url = new URL(href);
    calls.push({ url, headers: options.headers || {} });
    if (url.hostname === 'query.wikidata.org') {
      const query = url.searchParams.get('query');
      if (query.includes('wikibase:box')) {
        const [, lon, lat] = /cornerSouthWest "Point\(([^ ]+) ([^)]+)\)"/
          .exec(query)
          .map(Number);
        const qid = `Q${Math.round((lat + 90) * 10)}${Math.round((lon + 180) * 10)}`;
        return Response.json({
          results: {
            bindings: [
              cellRow(
                qid,
                `Landmark ${qid}`,
                9,
                'Q33506',
                lat + 0.05,
                lon + 0.05,
              ),
            ],
          },
        });
      }
      return Response.json({
        results: { bindings: query.includes('wd:Q1438634 ') ? fortDetail : [] },
      });
    }
    if (url.hostname.endsWith('rapidapi.com')) {
      filmotBody ||= JSON.parse(await fs.readFile(FILMOT_FIXTURE, 'utf8'));
      return Response.json(filmotBody);
    }
    const resource = url.pathname.split('/').pop();
    if (resource === 'search')
      return Response.json({
        items: ids.map((videoId) => ({ id: { videoId } })),
      });
    if (resource === 'videos')
      return Response.json({
        items: url.searchParams
          .get('id')
          .split(',')
          .map((id, i) =>
            ytItem(id, i === 1 ? 'Fort McHenry #shorts' : `Fort McHenry ${i}`, {
              duration: i === 1 ? 'PT30S' : 'PT5M',
            }),
          ),
      });
    if (resource === 'channels') return Response.json({ items: [] });
    return new Response('?', { status: 404 });
  };
  const count = (pred) => calls.filter(({ url }) => pred(url)).length;
  return {
    fetchImpl,
    calls,
    youtube: (resource) =>
      count((u) => u.pathname.endsWith(`/youtube/v3/${resource}`)),
    sparql: () => count((u) => u.hostname === 'query.wikidata.org'),
    filmot: () => count((u) => u.hostname.endsWith('rapidapi.com')),
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-landmarks-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a landmark’s videos: one search for "label" city, 102 units, kept a week, refused past the budget', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  let clock = Date.parse('2026-10-16T18:00:00Z');
  const service = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => 'test-key',
    filmotKey: () => '',
    now: () => clock,
    env: { RECORDED_VIDEO_DAILY_BUDGET: '250' },
  });
  assert.equal((await service.videos('nope')).status, 400);
  const first = await service.videos('Q1438634');
  assert.equal(first.status, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.query, '"Fort McHenry" Baltimore');
  assert.deepEqual(
    first.body.videos.map((v) => v.videoId),
    ['aaaaaaaaaaa', 'N20k3ix_RLI'],
    'the Short is dropped',
  );
  assert.equal(first.body.skipped.short, 1);
  assert.deepEqual(first.body.quota, {
    used: LANDMARK_QUERY_COST,
    budget: 250,
    remaining: 250 - LANDMARK_QUERY_COST,
  });
  const search = api.calls.find(({ url }) =>
    url.pathname.endsWith('/search'),
  ).url;
  assert.equal(search.searchParams.get('q'), '"Fort McHenry" Baltimore');
  assert.equal(search.searchParams.get('order'), 'relevance');
  assert.equal(search.searchParams.get('videoDuration'), 'any');
  assert.equal(search.searchParams.get('maxResults'), '25');
  // Stored a week: no units the second time.
  const again = await service.videos('Q1438634');
  assert.equal(again.body.cached, true);
  assert.equal(api.youtube('search'), 1);
  // An unknown item: 404, after one detail query.
  const unknown = await service.videos('Q42');
  assert.equal(unknown.status, 404);
  // 2 × 102 + another would pass 250: refused before anything is asked.
  assert.equal(unknown.body.quota.used, LANDMARK_QUERY_COST, 'and no units');
  const refreshed = await service.videos('Q1438634', { refresh: true });
  assert.equal(refreshed.body.cached, false);
  assert.equal(refreshed.body.quota.used, 2 * LANDMARK_QUERY_COST);
  const refused = await service.videos('Q1438634', { refresh: true });
  assert.equal(refused.status, 429);
  assert.equal(api.youtube('search'), 2);
  // The stored answer is still served past the budget.
  assert.equal((await service.videos('Q1438634')).body.cached, true);
  // A week later the answer is asked again (on a new day's budget).
  clock += SEARCH_TTL_MS + 1;
  const later = await service.videos('Q1438634');
  assert.equal(later.body.cached, false);
});

test('without a YouTube key a landmark says so and spends nothing', async (t) => {
  const root = await tempRoot(t);
  const api = upstream();
  const service = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
    filmotKey: () => '',
  });
  const result = await service.videos('Q1438634');
  assert.equal(result.body.configured, false);
  assert.equal(api.calls.length, 0);
});

test('landmarks near a point: two uncached cells per request, kept 30 days', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  let clock = Date.parse('2026-10-16T18:00:00Z');
  const service = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
    now: () => clock,
  });
  const around = cellsAround(39.25, -76.65, 8).length;
  const first = await service.near(39.25, -76.65, 8);
  assert.equal(first.body.cells, around);
  assert.equal(first.body.landmarks.length, 2);
  assert.equal(first.body.pending, around - 2);
  assert.equal(api.sparql(), 2);
  let asked = 2;
  while (asked < around) {
    await service.near(39.25, -76.65, 8);
    asked = Math.min(around, asked + 2);
    assert.equal(api.sparql(), asked);
  }
  const full = await service.near(39.25, -76.65, 8);
  assert.equal(full.body.pending, 0);
  assert.equal(api.sparql(), around, 'all cells stored');
  assert.equal(
    new Set(full.body.landmarks.map((l) => l.qid)).size,
    full.body.landmarks.length,
  );
  clock += LANDMARK_TTL_MS + 1;
  await service.near(39.25, -76.65, 8);
  assert.equal(api.sparql(), around + 2, 'asked again after 30 days');
  assert.equal((await service.near(95, 0, 8)).status, 400);
});

test('"mentioned at": one Filmot search per landmark, kept, capped, skipped without a key', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  let key = '';
  const service = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
    filmotKey: () => key,
  });
  const none = await service.mentions('Q1438634', 'N20k3ix_RLI');
  assert.deepEqual(none.body, { mentions: [], configured: false });
  assert.equal(api.filmot(), 0, 'no key: nothing asked');
  key = 'test-filmot-key';
  assert.equal((await service.mentions('Q1438634', 'bad')).status, 400);
  const found = await service.mentions('Q1438634', 'N20k3ix_RLI');
  assert.equal(found.status, 200);
  assert.deepEqual(
    found.body.mentions.map((m) => [m.start, m.at]),
    [
      [33.7, '0:33'],
      [50.5, '0:50'],
      [93.4, '1:33'],
    ],
  );
  const call = api.calls.find(({ url }) =>
    url.hostname.endsWith('rapidapi.com'),
  );
  assert.equal(call.url.pathname, '/getsearchsubtitles');
  assert.equal(call.url.searchParams.get('query'), '"Fort McHenry"');
  assert.equal(call.headers['x-rapidapi-key'], 'test-filmot-key');
  // Another video of the same landmark: the stored answer, no second search.
  const other = await service.mentions('Q1438634', 'Umg8v6DLZjs');
  assert.equal(other.body.mentions.length, 2);
  const missing = await service.mentions('Q1438634', 'aaaaaaaaaaa');
  assert.deepEqual(missing.body.mentions, []);
  assert.equal(api.filmot(), 1);
  // The day's cap: past it, nothing more is asked.
  await fs.writeFile(
    path.join(root, '.gev-cache', 'recorded-video', 'filmot-usage.json'),
    JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      count: FILMOT_DAILY_CAP,
    }),
  );
  const capped = await service.mentions('Q1000257', 'aaaaaaaaaaa');
  assert.equal(capped.body.refused, true);
  assert.equal(api.filmot(), 1);
});

test('the landmark routes are same-site only, GET only, and check their input', async () => {
  const seen = [];
  const landmarks = {
    videos: async (qid, options) => (
      seen.push(['videos', qid, options.refresh]),
      { status: 200, body: { videos: [] } }
    ),
    near: async (lat, lon, radiusKm) => (
      seen.push(['near', lat, lon, radiusKm]),
      { status: 200, body: { landmarks: [] } }
    ),
    mentions: async (qid, videoId) => (
      seen.push(['mentions', qid, videoId]),
      { status: 200, body: { mentions: [] } }
    ),
  };
  const handler = createLandmarkHandler({ landmarks });
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
    (await call('/?qid=Q1', { headers: { origin: 'https://evil.example' } }))
      .statusCode,
    403,
  );
  assert.equal((await call('/?qid=Q1', { method: 'POST' })).statusCode, 405);
  assert.equal((await call('/near?near=nope')).statusCode, 400);
  await call('/?qid=Q1438634&refresh=1');
  await call('/near?near=39.29,-76.61&radiusKm=8');
  await call('/mentions?qid=Q1438634&videoId=N20k3ix_RLI');
  assert.deepEqual(seen, [
    ['videos', 'Q1438634', true],
    ['near', 39.29, -76.61, 8],
    ['mentions', 'Q1438634', 'N20k3ix_RLI'],
  ]);
  assert.equal((await call('/other')).nexted, true);
});

test('a landmark whose country is none of the cell’s is dropped (real Baltimore and Detroit cells)', async () => {
  const { cells } = JSON.parse(await fs.readFile(CELLS_FIXTURE, 'utf8'));
  // Baltimore: Gatchina Palace (near St Petersburg; P17 Russian Empire) has
  // coordinates in Baltimore, the one item of 79 naming that country.
  const baltimore = parseLandmarkCell(cells.baltimore.rows);
  assert.deepEqual(baltimore.dropped, [
    { qid: 'Q636696', label: 'Gatchina Palace', countries: ['Q34266'] },
  ]);
  assert.equal(baltimore.landmarks.length, LANDMARKS_PER_CELL);
  assert.ok(!baltimore.landmarks.some((l) => l.qid === 'Q636696'));
  assert.ok(baltimore.landmarks.some((l) => l.qid === 'Q1000257'));
  assert.deepEqual(
    Object.keys(baltimore.landmarks[0]).sort(),
    ['kind', 'label', 'lat', 'lon', 'qid', 'sitelinks'],
    'the check’s fields are not stored with the landmark',
  );
  // An item without a country (Mr. Trash Wheel) is not a misplaced one.
  assert.ok(
    parseLandmarkCell(cells.baltimore.rows, { cap: 80 }).landmarks.some(
      (l) => l.qid === 'Q29033855',
    ),
  );
  // Detroit: Windsor's Canadian items are one of the cell's countries.
  const detroit = parseLandmarkCell(cells.detroit.rows, { cap: 80 });
  assert.deepEqual(detroit.dropped, []);
  assert.ok(detroit.landmarks.some((l) => l.qid === 'Q3098087'));
  assert.ok(
    detroit.landmarks.some((l) => l.qid === 'Q12575'),
    'two countries',
  );
});

test('the check spares a lone item over a border when its own place is near, and small cells', () => {
  const item = (qid, countries, adminKm = NaN) => ({ qid, countries, adminKm });
  const us = Array.from({ length: 30 }, (_, i) => item(`Q${i + 100}`, ['Q30']));
  assert.deepEqual(
    [
      ...misplacedLandmarks([
        ...us,
        item('Q1', ['Q16'], 2),
        item('Q2', ['Q96'], 600),
        item('Q3', ['Q159']),
        item('Q4', []),
        item('Q5', ['Q30', 'Q16']),
      ]),
    ].sort(),
    ['Q2', 'Q3'],
    'near its own place: kept; far or unknown: dropped',
  );
  // 2 items name a country, but under 5% of 60: still not the cell's.
  const many = Array.from({ length: 58 }, (_, i) =>
    item(`Q${i + 100}`, ['Q30']),
  );
  assert.deepEqual(
    [
      ...misplacedLandmarks([
        ...many,
        item('Q1', ['Q16']),
        item('Q2', ['Q16']),
      ]),
    ],
    ['Q1', 'Q2'],
  );
  // Too few items name a country to know the cell's: nothing is dropped.
  assert.deepEqual(
    [
      ...misplacedLandmarks([
        item('Q1', ['Q30']),
        item('Q2', ['Q30']),
        item('Q3', ['Q30']),
        item('Q4', ['Q159']),
        item('Q5', []),
      ]),
    ],
    [],
  );
  // One item on two rows: its countries and nearest place are pooled.
  const row = (country, adminKm) => ({
    item: { value: `${WD}Q9` },
    itemLabel: { value: 'Twice' },
    lat: { value: '39.25' },
    lon: { value: '-76.65' },
    sitelinks: { value: '5' },
    countries: { value: country },
    ...(adminKm === undefined ? {} : { adminDist: { value: String(adminKm) } }),
  });
  const pooled = parseLandmarkCell([
    ...us.map((u) => ({
      ...row('Q30', 1),
      item: { value: `${WD}${u.qid}` },
    })),
    row('Q16', 3),
    row('Q16'),
  ]);
  assert.deepEqual(
    pooled.dropped,
    [],
    'its 3 km place is kept from the first row',
  );
});

test('a cell stored before the check is asked again, and what was dropped is kept with it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const root = await tempRoot(t);
  const api = upstream();
  const service = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
  });
  const file = path.join(
    root,
    '.gev-cache',
    'recorded-video',
    'landmarks',
    'cells.json',
  );
  await service.near(39.25, -76.65, 0.5);
  assert.equal(api.sparql(), 1);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  const [entry] = Object.values(stored.entries || stored);
  const value = entry.value || entry;
  assert.equal(value.v, 3);
  assert.deepEqual(value.merged, []);
  assert.deepEqual(value.dropped, []);
  // The same answer without the version, as stored before the check.
  const old = JSON.parse(JSON.stringify(stored));
  const [oldEntry] = Object.values(old.entries || old);
  delete (oldEntry.value || oldEntry).v;
  await fs.writeFile(file, JSON.stringify(old));
  const again = createLandmarkService({
    sourceRoot: root,
    fetchImpl: api.fetchImpl,
    apiKey: () => '',
  });
  await again.near(39.25, -76.65, 0.5);
  assert.equal(api.sparql(), 2, 'asked again');
  await again.near(39.25, -76.65, 0.5);
  assert.equal(api.sparql(), 2, 'then stored');
});

// Personal fork: one landmark per place when Wikidata has two items for it.
test('two Wikidata items for one place become one landmark; close distinct things stay', async () => {
  const { cells } = JSON.parse(
    await fs.readFile(
      new URL('./fixtures/wikidata-landmark-cells.json', import.meta.url),
      'utf8',
    ),
  );
  const baltimore = parseLandmarkCell(cells.baltimore.rows, { cap: 80 });
  const detroit = parseLandmarkCell(cells.detroit.rows, { cap: 80 });
  const merges = [...baltimore.merged, ...detroit.merged].map((m) => [
    m.label,
    m.qid,
    m.into,
  ]);
  for (const [label, qid, into] of [
    ['Lexington Market', 'Q6537835', 'Q6537838'],
    ['Renaissance Center', 'Q7312409', 'Q1541365'],
    ['Huntington Place', 'Q5138942', 'Q1104711'],
  ])
    assert.ok(
      merges.some((m) => m[0] === label && m[1] === qid && m[2] === into),
      `${label}: ${qid} merged into ${into}`,
    );
  const kept = (cell) => new Set(cell.landmarks.map((l) => l.qid));
  assert.ok(
    kept(baltimore).has('Q6537838') && !kept(baltimore).has('Q6537835'),
  );
  // USS Constellation and the museum holding it: 120 m apart, two things.
  assert.ok(kept(baltimore).has('Q1571122'), 'USS Constellation stays');
  assert.ok(
    kept(baltimore).has('Q5773664'),
    'Historic Ships in Baltimore stays',
  );
  // Alike names farther apart, or names that only share words, stay apart.
  assert.ok(kept(detroit).has('Q5472134') && kept(detroit).has('Q5472135'));
  // Fort McHenry's cell (392_-766), as Wikidata answered it on 2026-10-16.
  const row = (qid, label, lat, lon, sitelinks) => ({
    item: { value: `http://www.wikidata.org/entity/${qid}` },
    itemLabel: { value: label },
    lat: { value: String(lat) },
    lon: { value: String(lon) },
    sitelinks: { value: String(sitelinks) },
    countries: { value: 'Q30' },
  });
  const fort = parseLandmarkCell([
    row(
      'Q73122275',
      'Fort McHenry National Monument and Historic Shrine',
      39.263055555,
      -76.579722222,
      4,
    ),
    row('Q1438634', 'Fort McHenry', 39.263333333, -76.58, 17),
    row('Q1', 'Fort McHenry Tunnel', 39.2649, -76.5741, 6),
  ]);
  assert.deepEqual(
    fort.landmarks.map((l) => l.qid),
    ['Q1438634', 'Q1'],
    'the shrine item folds into Fort McHenry; the tunnel, 520 m off, stays',
  );
  assert.deepEqual(fort.merged, [
    {
      qid: 'Q73122275',
      label: 'Fort McHenry National Monument and Historic Shrine',
      into: 'Q1438634',
    },
  ]);
  assert.equal(samePlaceLandmarks([]).size, 0);
});
