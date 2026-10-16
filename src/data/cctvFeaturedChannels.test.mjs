import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import {
  createChannelWatcher,
  createYoutubeClient,
  createYoutubeQuota,
  extractPlaceCandidates,
  geocodePrecision,
  parseChannels,
  pendingFile,
  quotaDay,
  readChannels,
  roundForPrecision,
  skippedFile,
  suggestPosition,
  textPrecision,
} from '../../server/providers/cctv/featuredChannels.js';
import {
  createFeaturedQueueRoutes,
  deriveTitleMatch,
  entryFromPending,
  entryIdFor,
  nameFromTitle,
} from '../../server/providers/cctv/featuredQueue.js';
import {
  createFeaturedLoader,
  parseFeaturedCatalog,
} from '../../server/providers/cctv/featured.js';

const CHANNEL = 'UCv0In2Sw_YabIhMHHOoTSkA';
const OTHER = 'UC8NnosPOvXnm0O1u5YnLQiw';
const uploadsOf = (channelId) => `UU${channelId.slice(2)}`;

/** One videos.list item. */
function video(id, title, broadcast = 'live', extra = {}) {
  return {
    id,
    snippet: {
      title,
      description: extra.description || '',
      channelId: extra.channelId || CHANNEL,
      channelTitle: 'Explore Osprey & Peregrine Falcon Cams',
      publishedAt: '2026-10-15T12:00:00Z',
      liveBroadcastContent: broadcast,
    },
    status: {
      privacyStatus: 'public',
      embeddable: true,
      ...(extra.status || {}),
    },
    ...(extra.location
      ? { recordingDetails: { location: extra.location } }
      : {}),
  };
}

/** A fake YouTube Data API, counting calls per resource. */
function fakeYouTube({ videos = {}, uploads = {} } = {}) {
  const calls = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    const resource = url.pathname.split('/').pop();
    calls.push({ resource, url });
    if (resource === 'videos') {
      const ids = url.searchParams.get('id').split(',');
      return Response.json({
        items: ids.map((id) => videos[id]).filter(Boolean),
      });
    }
    if (resource === 'playlistItems')
      return Response.json({
        items: (uploads[url.searchParams.get('playlistId')] || []).map(
          (videoId) => ({ contentDetails: { videoId } }),
        ),
      });
    return new Response('not found', { status: 404 });
  };
  return {
    fetchImpl,
    calls,
    count: (r) => calls.filter((c) => c.resource === r).length,
  };
}

const quiet = (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  t.mock.method(console, 'warn', (...a) => logs.push(a.join(' ')));
  return logs;
};

const channelRow = (channelId, extra = {}) => ({
  channelId,
  operator: 'explore.org',
  operatorUrl: 'https://explore.org/livecams',
  defaultCategory: 'birds',
  ...extra,
});

test('the watched-channel list keeps valid channels and default places', () => {
  const channels = parseChannels({
    channels: [
      channelRow(CHANNEL),
      channelRow(CHANNEL),
      channelRow('not-a-channel'),
      channelRow(OTHER, {
        defaultCategory: 'Marine Life!',
        operatorUrl: 'http://plain.example/',
        defaultPlace: {
          lat: 36.61826,
          lon: -121.90195,
          coordinatesQuality: 'site',
          label: 'Monterey Bay Aquarium',
        },
      }),
      channelRow('UC-2KSeUU5SMCX6XLRD-AEvw', {
        defaultPlace: { lat: 0, lon: 0, coordinatesQuality: 'site' },
      }),
    ],
  });
  assert.deepEqual(
    channels.map((c) => c.channelId),
    [CHANNEL, OTHER, 'UC-2KSeUU5SMCX6XLRD-AEvw'],
  );
  assert.equal(channels[1].defaultCategory, 'marinelife');
  assert.equal(channels[1].operatorUrl, '');
  assert.equal(channels[1].defaultPlace.coordinatesQuality, 'site');
  assert.equal(channels[2].defaultPlace, null, 'null island is no place');
});

test('the shipped channel list is valid and covers every channel in live-cams.json', async () => {
  const channels = readChannels(process.cwd());
  assert.ok(channels.length >= 10);
  const raw = JSON.parse(
    await fs.readFile(
      'src/data/local_data/cctv_featured/channels.json',
      'utf8',
    ),
  );
  assert.equal(channels.length, raw.channels.length, 'no entry dropped');
  const cams = JSON.parse(
    await fs.readFile(
      'src/data/local_data/cctv_featured/live-cams.json',
      'utf8',
    ),
  ).cams;
  const watched = new Set(channels.map((c) => c.channelId));
  for (const cam of cams) assert.ok(watched.has(cam.youtube.channelId), cam.id);
});

test('place names come from title segments and description phrases', () => {
  assert.deepEqual(
    extractPlaceCandidates(
      'Charlo Osprey Nest – Charlo, Montana | explore.org',
      '',
    ),
    ['Charlo, Montana'],
  );
  assert.deepEqual(
    extractPlaceCandidates(
      'Brown Bear Cam',
      'Watch bears fish for salmon live from Katmai National Park, Alaska. Powered by explore.org.',
    ),
    ['Katmai National Park, Alaska'],
  );
  assert.deepEqual(
    extractPlaceCandidates(
      'Osprey Cam',
      'This pair nests in the Chesapeake Bay in Maryland every spring.',
    ),
    ['Chesapeake Bay in Maryland', 'Maryland'],
    'the coarser name is the fallback',
  );
  assert.deepEqual(extractPlaceCandidates('LIVE Peregrine Falcons', ''), []);
  assert.deepEqual(extractPlaceCandidates('', 'Subscribe for more!'), []);
});

test('a phrase supports a precision before any geocoder', () => {
  assert.equal(textPrecision('100 Light Street, Baltimore'), 'site');
  assert.equal(textPrecision('Brooks Falls, Katmai National Park'), 'site');
  assert.equal(textPrecision('Charlo, Montana'), 'area');
  assert.equal(textPrecision('Katmai National Park'), 'area');
  assert.equal(textPrecision('Maryland'), 'region');
});

test('geocoder precision maps location type and never beats the text', () => {
  const result = (locationType, types, partialMatch = false) => ({
    lat: 1,
    lon: 1,
    locationType,
    types,
    partialMatch,
  });
  assert.equal(
    geocodePrecision(
      result('ROOFTOP', ['street_address']),
      '100 Light Street, Baltimore',
    ),
    'site',
  );
  assert.equal(
    geocodePrecision(
      result('GEOMETRIC_CENTER', ['establishment']),
      'Brooks Falls',
    ),
    'area',
  );
  assert.equal(
    geocodePrecision(
      result('RANGE_INTERPOLATED', ['street_address']),
      '12 Main St, Decorah',
    ),
    'area',
  );
  assert.equal(
    geocodePrecision(
      result('APPROXIMATE', ['locality', 'political']),
      'Charlo, Montana',
    ),
    'region',
  );
  // A town named alone never becomes a site, whatever the geocoder says.
  assert.equal(
    geocodePrecision(
      result('ROOFTOP', ['locality', 'political']),
      'Decorah, Iowa',
    ),
    'area',
  );
  assert.equal(
    geocodePrecision(
      result('GEOMETRIC_CENTER', ['natural_feature']),
      'Chesapeake Bay in Maryland',
    ),
    'region',
  );
  assert.equal(
    geocodePrecision(
      result('ROOFTOP', ['zoo', 'establishment'], true),
      'San Diego Zoo',
    ),
    'area',
    'a partial match is one step coarser',
  );
  assert.equal(roundForPrecision(39.287364, 'site'), 39.28736);
  assert.equal(roundForPrecision(39.287364, 'area'), 39.287);
  assert.equal(roundForPrecision(39.287364, 'region'), 39.29);
});

test('suggestions prefer the geotag, then the text, then the channel default', async () => {
  const geocoded = [];
  const geocode = async (address) => {
    geocoded.push(address);
    if (address === 'Chesapeake Bay in Maryland')
      return {
        lat: 38.5512345,
        lon: -76.4123456,
        locationType: 'APPROXIMATE',
        types: ['natural_feature'],
        formatted: 'Chesapeake Bay',
      };
    if (address === 'Charlo, Montana')
      return {
        lat: 47.4381234,
        lon: -114.1734567,
        locationType: 'APPROXIMATE',
        types: ['locality', 'political'],
        formatted: 'Charlo, MT, USA',
      };
    return null;
  };
  const channel = parseChannels({
    channels: [
      channelRow(CHANNEL, {
        defaultPlace: {
          lat: 36.61826,
          lon: -121.90195,
          coordinatesQuality: 'site',
          label: 'Monterey Bay Aquarium',
        },
      }),
    ],
  })[0];
  const bare = parseChannels({ channels: [channelRow(OTHER)] })[0];

  const geotag = await suggestPosition(
    {
      title: 'Osprey – Charlo, Montana',
      location: { latitude: 47.43812345, longitude: -114.17345678 },
    },
    channel,
    { geocode },
  );
  assert.deepEqual(geotag, {
    kind: 'geotag',
    lat: 47.43812,
    lon: -114.17346,
    coordinatesQuality: 'operator-geotag',
    label: 'Operator geotag',
  });
  assert.deepEqual(geocoded, [], 'a geotag needs no geocoding');

  const bay = await suggestPosition(
    {
      title: 'Osprey Cam',
      description: 'This pair nests in the Chesapeake Bay in Maryland.',
    },
    bare,
    { geocode },
  );
  assert.equal(bay.kind, 'text');
  assert.equal(bay.coordinatesQuality, 'region');
  assert.equal(bay.lat, 38.55, 'rounded to what a region claims');
  assert.equal(bay.label, 'Chesapeake Bay in Maryland');

  const town = await suggestPosition(
    { title: 'Charlo Osprey Nest – Charlo, Montana' },
    bare,
    { geocode },
  );
  assert.equal(town.kind, 'text');
  assert.equal(town.coordinatesQuality, 'region');

  const fallback = await suggestPosition(
    { title: 'Sea Otter Cam', description: 'Watch otters!' },
    channel,
    { geocode },
  );
  assert.equal(fallback.kind, 'default');
  assert.equal(fallback.coordinatesQuality, 'site');

  const unknown = await suggestPosition(
    { title: 'Mystery Nest – Nowhere Land' },
    bare,
    { geocode },
  );
  assert.deepEqual(unknown, { kind: 'none' });
});

async function tempRoot(t, cams = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-featured-q-'));
  const catalog = path.join(root, 'live-cams.json');
  await fs.writeFile(catalog, JSON.stringify({ version: 1, cams }, null, 2));
  const saved = process.env.CCTV_FEATURED_FILE;
  process.env.CCTV_FEATURED_FILE = catalog;
  t.after(async () => {
    if (saved === undefined) delete process.env.CCTV_FEATURED_FILE;
    else process.env.CCTV_FEATURED_FILE = saved;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, catalog };
}

const listed = {
  id: 'baltimore-peregrine-falcons',
  name: 'Peregrine falcon nest',
  place: 'Baltimore, Maryland',
  category: 'birds',
  lat: 39.28736,
  lon: -76.61446,
  coordinatesQuality: 'site',
  operator: 'explore.org',
  youtube: {
    videoId: 'LISTED00000',
    channelId: CHANNEL,
    titleMatch: ['peregrine', 'chesapeake'],
  },
};

test('a scan queues new live and upcoming streams once, and nothing it already knows', async (t) => {
  const logs = quiet(t);
  const { root } = await tempRoot(t);
  await fs.mkdir(path.dirname(skippedFile(root)), { recursive: true });
  await fs.writeFile(
    skippedFile(root),
    JSON.stringify({ videoIds: ['SKIPPED0000'] }),
  );
  const api = fakeYouTube({
    uploads: {
      [uploadsOf(CHANNEL)]: [
        'NEWLIVE0000',
        'UPCOMING000',
        'OFFLINE0000',
        'NOEMBED0000',
        'PRIVATE0000',
        'LISTED00000',
        'RESTART0000',
        'SKIPPED0000',
        'GONE0000000',
      ],
    },
    videos: {
      NEWLIVE0000: video(
        'NEWLIVE0000',
        'Charlo Osprey Nest – Charlo, Montana',
        'live',
        {
          description: 'x'.repeat(900),
          location: { latitude: 47.4381, longitude: -114.1734 },
        },
      ),
      UPCOMING000: video('UPCOMING000', 'Hellgate Osprey Nest', 'upcoming'),
      OFFLINE0000: video('OFFLINE0000', 'Last season highlights', 'none'),
      NOEMBED0000: video('NOEMBED0000', 'Members stream', 'live', {
        status: { embeddable: false },
      }),
      PRIVATE0000: video('PRIVATE0000', 'Test stream', 'live', {
        status: { privacyStatus: 'unlisted' },
      }),
      LISTED00000: video('LISTED00000', 'Peregrine Falcons Chesapeake', 'live'),
      RESTART0000: video(
        'RESTART0000',
        'LIVE Peregrine Falcons - Chesapeake',
        'live',
      ),
      SKIPPED0000: video('SKIPPED0000', 'Some other cam', 'live'),
    },
  });
  let clock = Date.parse('2026-10-16T18:00:00Z');
  const quota = createYoutubeQuota({ now: () => clock });
  const youtube = createYoutubeClient({
    fetchImpl: api.fetchImpl,
    apiKey: () => 'test-key',
    quota,
  });
  const watcher = createChannelWatcher({
    youtube,
    quota,
    now: () => clock,
    geocode: async () => null,
  });
  const entries = parseFeaturedCatalog({ cams: [listed] });
  const channels = parseChannels({ channels: [channelRow(CHANNEL)] });

  const first = await watcher.scanAll({ sourceRoot: root, entries, channels });
  assert.deepEqual(first, { scanned: 1, queued: 2 });
  assert.equal(api.count('playlistItems'), 1);
  assert.equal(api.count('videos'), 1, 'one batch of up to 50');
  assert.equal(api.count('search'), 0);
  const parts = new URL(
    api.calls.find((c) => c.resource === 'videos').url,
  ).searchParams.get('part');
  assert.match(parts, /recordingDetails/);
  assert.equal(quota.used(), 2);

  const pending = JSON.parse(await fs.readFile(pendingFile(root), 'utf8'));
  assert.deepEqual(
    pending.items.map((i) => [i.videoId, i.status, i.suggestion.kind]),
    [
      ['NEWLIVE0000', 'live', 'geotag'],
      ['UPCOMING000', 'upcoming', 'none'],
    ],
  );
  const [item] = pending.items;
  assert.equal(item.description.length, 600);
  assert.equal(item.channelId, CHANNEL);
  assert.equal(item.operator, 'explore.org');
  assert.equal(item.publishedAt, '2026-10-15T12:00:00Z');
  assert.deepEqual(item.location, { latitude: 47.4381, longitude: -114.1734 });
  assert.ok(logs.some((l) => /queued 2 new stream/.test(l)));

  // Within the interval: no calls. After it: only unseen uploads are asked about.
  clock += 30 * 60 * 1000;
  assert.deepEqual(
    await watcher.scanAll({ sourceRoot: root, entries, channels }),
    { scanned: 0, queued: 0 },
  );
  assert.equal(api.calls.length, 2);
  clock += 2 * 60 * 60 * 1000;
  const third = await watcher.scanAll({ sourceRoot: root, entries, channels });
  assert.deepEqual(third, { scanned: 1, queued: 0 }, 'already queued');
  assert.equal(api.count('playlistItems'), 2);
  assert.equal(api.count('videos'), 1, 'nothing new to ask about');
});

test('the daily budget stops channel scans and says so', async (t) => {
  const logs = quiet(t);
  const { root } = await tempRoot(t);
  const api = fakeYouTube({
    uploads: {
      [uploadsOf(CHANNEL)]: ['NEWLIVE0000'],
      [uploadsOf(OTHER)]: ['NEWLIVE0001'],
    },
    videos: {
      NEWLIVE0000: video('NEWLIVE0000', 'Hellgate Osprey Nest'),
      NEWLIVE0001: video('NEWLIVE0001', 'Decorah Eagles', 'live', {
        channelId: OTHER,
      }),
    },
  });
  let clock = Date.parse('2026-10-16T18:00:00Z');
  const quotaPath = path.join(root, 'quota.json');
  const quota = createYoutubeQuota({
    now: () => clock,
    budget: () => 2,
    file: quotaPath,
  });
  const youtube = createYoutubeClient({
    fetchImpl: api.fetchImpl,
    apiKey: () => 'k',
    quota,
  });
  const watcher = createChannelWatcher({ youtube, quota, now: () => clock });
  const channels = parseChannels({
    channels: [channelRow(CHANNEL), channelRow(OTHER)],
  });
  const result = await watcher.scanAll({
    sourceRoot: root,
    entries: [],
    channels,
  });
  assert.deepEqual(result, { scanned: 1, queued: 1 });
  assert.equal(api.count('playlistItems'), 1, 'the second channel waits');
  assert.ok(
    logs.some((l) =>
      /YouTube budget reached \(2 of 2 units on 2026-10-16\); channel scans stop until tomorrow/.test(
        l,
      ),
    ),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(quotaPath, 'utf8')), {
    day: '2026-10-16',
    units: 2,
    geocodes: 0,
  });
  // A restart keeps the count.
  const reloaded = createYoutubeQuota({
    now: () => clock,
    budget: () => 2,
    file: quotaPath,
  });
  assert.equal(reloaded.used(), 2);
  // The next Pacific day starts at zero and logs the day's total.
  clock = Date.parse('2026-10-17T08:00:00Z');
  assert.equal(quotaDay(clock), '2026-10-17');
  assert.equal(reloaded.exhausted(), false);
  assert.ok(
    logs.some((l) => l === '[CCTV] YouTube units used on 2026-10-16: 2'),
  );
});

test('a followed restart is written back to live-cams.json', async (t) => {
  quiet(t);
  const { root, catalog } = await tempRoot(t, [listed]);
  const savedWatch = process.env.CCTV_FEATURED_WATCH;
  process.env.CCTV_FEATURED_WATCH = '0';
  t.after(() => {
    if (savedWatch === undefined) delete process.env.CCTV_FEATURED_WATCH;
    else process.env.CCTV_FEATURED_WATCH = savedWatch;
  });
  const api = fakeYouTube({
    uploads: { [uploadsOf(CHANNEL)]: ['RESTART0000'] },
    videos: {
      LISTED00000: video('LISTED00000', 'Peregrine Falcons Chesapeake', 'none'),
      RESTART0000: video('RESTART0000', 'LIVE Peregrine Falcons - Chesapeake'),
    },
  });
  const load = createFeaturedLoader({
    fetchImpl: api.fetchImpl,
    apiKey: () => 'k',
  });
  const sources = await load({ sourceRoot: root });
  assert.equal(sources[0].embed.videoId, 'RESTART0000');
  for (let i = 0; i < 20; i++) {
    const saved = JSON.parse(await fs.readFile(catalog, 'utf8'));
    if (saved.cams[0].youtube.videoId === 'RESTART0000') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const saved = JSON.parse(await fs.readFile(catalog, 'utf8'));
  assert.equal(saved.cams[0].youtube.videoId, 'RESTART0000');
  assert.deepEqual(saved.cams[0].youtube.titleMatch, [
    'peregrine',
    'chesapeake',
  ]);
  assert.equal(saved.cams[0].lat, listed.lat, 'nothing else changes');
  assert.deepEqual(
    (await fs.readdir(root)).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('accepted entries get a readable name, a unique id and distinctive match words', () => {
  assert.equal(
    nameFromTitle('🔴 LIVE Charlo Osprey Nest – Charlo, Montana | explore.org'),
    'Charlo Osprey Nest – Charlo, Montana',
  );
  assert.deepEqual(
    deriveTitleMatch(
      'LIVE Charlo Osprey Nest Cam | explore.org',
      'explore.org',
    ),
    ['charlo', 'osprey'],
  );
  assert.deepEqual(deriveTitleMatch('LIVE Cam 24/7 HD', ''), []);
  assert.equal(
    entryIdFor('Charlo Osprey Nest – Charlo, Montana', new Set()),
    'charlo-osprey-nest-charlo-montana',
  );
  assert.equal(
    entryIdFor('Osprey', new Set(['osprey', 'osprey-2'])),
    'osprey-3',
  );
});

const queued = {
  videoId: 'NEWLIVE0000',
  channelId: CHANNEL,
  operator: 'explore.org',
  operatorUrl: 'https://explore.org/livecams',
  defaultCategory: 'birds',
  title: 'Charlo Osprey Nest – Charlo, Montana | explore.org',
  description: '',
  status: 'live',
  location: { latitude: 47.4381, longitude: -114.1734 },
  suggestion: {
    kind: 'geotag',
    lat: 47.4381,
    lon: -114.1734,
    coordinatesQuality: 'operator-geotag',
    label: 'Operator geotag',
  },
};

test('an accept is validated against its queued stream', () => {
  const ok = entryFromPending(queued, {
    lat: 47.43812345,
    lon: -114.1734,
    coordinatesQuality: 'area',
    place: 'Charlo, Montana',
  });
  assert.deepEqual(ok.entry, {
    id: 'charlo-osprey-nest-charlo-montana',
    name: 'Charlo Osprey Nest – Charlo, Montana',
    place: 'Charlo, Montana',
    category: 'birds',
    lat: 47.438,
    lon: -114.173,
    coordinatesQuality: 'area',
    operator: 'explore.org',
    operatorUrl: 'https://explore.org/livecams',
    youtube: {
      videoId: 'NEWLIVE0000',
      channelId: CHANNEL,
      titleMatch: ['charlo', 'osprey'],
    },
  });
  assert.equal(parseFeaturedCatalog({ cams: [ok.entry] }).length, 1);
  const bad = (body) => entryFromPending(queued, { place: 'X', ...body }).error;
  assert.match(
    bad({ lat: 'x', lon: 1, coordinatesQuality: 'site' }),
    /latitude/,
  );
  assert.match(bad({ lat: 0, lon: 0, coordinatesQuality: 'site' }), /latitude/);
  assert.match(
    bad({ lat: 1, lon: 1, coordinatesQuality: 'exact' }),
    /coordinatesQuality/,
  );
  assert.match(
    bad({ lat: 40, lon: -100, coordinatesQuality: 'operator-geotag' }),
    /geotag/,
  );
  assert.equal(
    entryFromPending(queued, {
      lat: 47.4381,
      lon: -114.1734,
      coordinatesQuality: 'operator-geotag',
      place: 'Charlo, Montana',
    }).entry.coordinatesQuality,
    'operator-geotag',
  );
  assert.match(
    entryFromPending(queued, {
      lat: 1,
      lon: 1,
      coordinatesQuality: 'site',
      place: ' ',
    }).error,
    /place/,
  );
  assert.match(
    entryFromPending(queued, {
      lat: 1,
      lon: 1,
      coordinatesQuality: 'site',
      place: 'X',
      category: 'Big Cats',
    }).error,
    /category/,
  );
  assert.match(
    entryFromPending(
      { ...queued, title: 'LIVE Cam' },
      { lat: 1, lon: 1, coordinatesQuality: 'site', place: 'X' },
    ).error,
    /distinctive/,
  );
  assert.match(entryFromPending(null, {}).error, /queue/);
});

/** Drive the route middleware with a fake request. */
async function call(routes, method, url, { body, headers = {} } = {}) {
  const raw =
    body === undefined
      ? ''
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  Object.assign(req, {
    method,
    url,
    socket: {},
    headers: {
      host: 'localhost:4176',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
      this.done();
    },
  };
  const finished = new Promise((resolve) => (res.done = resolve));
  let nexted = false;
  await routes(req, res, () => {
    nexted = true;
    res.done();
  });
  await finished;
  return { status: res.statusCode, body: res.body, nexted };
}

test('the review routes list, accept and skip, same-site only, with atomic writes', async (t) => {
  quiet(t);
  const { root, catalog } = await tempRoot(t, [listed]);
  await fs.mkdir(path.dirname(pendingFile(root)), { recursive: true });
  const second = {
    ...queued,
    videoId: 'UPCOMING000',
    title: 'Hellgate Osprey Nest',
    location: null,
    suggestion: { kind: 'none' },
  };
  await fs.writeFile(
    pendingFile(root),
    JSON.stringify({ version: 1, items: [queued, second] }),
  );
  const accepted = [];
  const routes = createFeaturedQueueRoutes({
    sourceRoot: root,
    onAccepted: (entry) => accepted.push(entry.id),
    geocode: async (q) =>
      q === 'Missoula, Montana'
        ? {
            lat: 46.8721234,
            lon: -113.9940123,
            locationType: 'APPROXIMATE',
            types: ['locality'],
            formatted: 'Missoula, MT, USA',
          }
        : null,
  });

  // Cross-site callers are refused before anything else.
  assert.equal(
    (
      await call(routes, 'GET', '/pending', {
        headers: { origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(routes, 'POST', '/skip', {
        body: { videoId: 'UPCOMING000' },
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).status,
    403,
  );

  const list = await call(routes, 'GET', '/pending');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.items.map((i) => i.videoId),
    ['NEWLIVE0000', 'UPCOMING000'],
  );
  assert.equal(
    list.body.items[0].thumbnailUrl,
    'https://i.ytimg.com/vi/NEWLIVE0000/hqdefault.jpg',
  );
  assert.equal((await call(routes, 'POST', '/pending')).status, 405);
  assert.equal((await call(routes, 'GET', '/accept')).status, 405);
  assert.equal(
    (
      await call(routes, 'POST', '/accept', {
        body: 'videoId=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    ).status,
    415,
  );
  assert.equal(
    (await call(routes, 'POST', '/accept', { body: '{nope' })).status,
    400,
  );
  assert.equal(
    (await call(routes, 'POST', '/accept', { body: 'x'.repeat(20000) })).status,
    413,
  );
  assert.equal(
    (
      await call(routes, 'POST', '/accept', {
        body: {
          videoId: 'NOTQUEUED00',
          lat: 1,
          lon: 1,
          coordinatesQuality: 'site',
          place: 'X',
        },
      })
    ).status,
    404,
  );
  const invalid = await call(routes, 'POST', '/accept', {
    body: {
      videoId: 'NEWLIVE0000',
      lat: 999,
      lon: 1,
      coordinatesQuality: 'site',
      place: 'X',
    },
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    JSON.parse(await fs.readFile(catalog, 'utf8')).cams.length,
    1,
    'nothing written',
  );

  const located = await call(routes, 'GET', '/locate?q=Missoula%2C%20Montana');
  assert.deepEqual(located.body, {
    lat: 46.87,
    lon: -113.99,
    coordinatesQuality: 'region',
    label: 'Missoula, Montana',
    geocoded: 'Missoula, MT, USA',
  });
  assert.equal((await call(routes, 'GET', '/locate?q=Atlantis')).status, 404);

  const ok = await call(routes, 'POST', '/accept', {
    body: {
      videoId: 'NEWLIVE0000',
      lat: 47.4381,
      lon: -114.1734,
      coordinatesQuality: 'area',
      place: 'Charlo, Montana',
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.entry.id, 'charlo-osprey-nest-charlo-montana');
  assert.deepEqual(accepted, ['charlo-osprey-nest-charlo-montana']);
  const saved = JSON.parse(await fs.readFile(catalog, 'utf8'));
  assert.deepEqual(
    saved.cams.map((c) => c.id),
    ['baltimore-peregrine-falcons', 'charlo-osprey-nest-charlo-montana'],
  );
  assert.equal(saved.version, 1);
  assert.equal(parseFeaturedCatalog(saved).length, 2, 'featured.js reads both');
  assert.ok((await fs.readFile(catalog, 'utf8')).endsWith('}\n'));
  assert.deepEqual(
    (await fs.readdir(root)).filter((f) => f.endsWith('.tmp')),
    [],
  );
  const afterAccept = JSON.parse(await fs.readFile(pendingFile(root), 'utf8'));
  assert.deepEqual(
    afterAccept.items.map((i) => i.videoId),
    ['UPCOMING000'],
  );

  const skipped = await call(routes, 'POST', '/skip', {
    body: { videoId: 'UPCOMING000' },
  });
  assert.deepEqual(skipped, {
    status: 200,
    body: { skipped: 'UPCOMING000', remaining: 0 },
    nexted: false,
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(skippedFile(root), 'utf8')).videoIds,
    ['UPCOMING000'],
  );
  await call(routes, 'POST', '/skip', { body: { videoId: 'UPCOMING000' } });
  assert.deepEqual(
    JSON.parse(await fs.readFile(skippedFile(root), 'utf8')).videoIds,
    ['UPCOMING000'],
    'recorded once',
  );
  assert.equal(
    (await call(routes, 'POST', '/skip', { body: { videoId: 'bad' } })).status,
    400,
  );
  assert.equal((await call(routes, 'GET', '/elsewhere')).nexted, true);
});

test('a rescan asks again only about streams the resolver could use', async (t) => {
  quiet(t);
  const api = fakeYouTube({
    uploads: {
      [uploadsOf(CHANNEL)]: ['NEWLIVE0000', 'RESTART0000', 'OLDVOD00000'],
    },
    videos: {
      NEWLIVE0000: video('NEWLIVE0000', 'Hellgate Osprey Nest'),
      RESTART0000: video('RESTART0000', 'Peregrine Falcons Chesapeake'),
      OLDVOD00000: video('OLDVOD00000', 'Highlights', 'none'),
    },
  });
  let clock = 1_000_000;
  const quota = createYoutubeQuota({ now: () => clock });
  const youtube = createYoutubeClient({
    fetchImpl: api.fetchImpl,
    apiKey: () => 'k',
    quota,
  });
  const watcher = createChannelWatcher({ youtube, quota, now: () => clock });
  const asked = () =>
    api.calls
      .filter((c) => c.resource === 'videos')
      .map((c) => c.url.searchParams.get('id'));

  await watcher.streamsFor(CHANNEL, { maxAgeMs: 0 });
  assert.deepEqual(asked(), ['NEWLIVE0000,RESTART0000,OLDVOD00000']);
  clock += 1;
  await watcher.streamsFor(CHANNEL, { maxAgeMs: 0 });
  assert.equal(asked().length, 1, 'nothing new: one unit, uploads only');
  assert.equal(quota.used(), 3);
  clock += 1;
  const streams = await watcher.streamsFor(CHANNEL, {
    maxAgeMs: 0,
    recheck: (stream) => /peregrine/i.test(stream.title),
  });
  assert.deepEqual(asked().at(-1), 'RESTART0000');
  assert.deepEqual(
    streams.map((s) => s.videoId),
    ['NEWLIVE0000', 'RESTART0000'],
  );
});
