// Personal fork: the owner's placement rule for streams the featured-cam
// watcher finds (server/providers/cctv/featuredTriage.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createChannelWatcher,
  createYoutubeClient,
  createYoutubeQuota,
  parseChannels,
  pendingFile,
  skippedFile,
} from '../../server/providers/cctv/featuredChannels.js';
import {
  DEFAULT_DAILY_CAP,
  TRIAGE_CODES,
  createFeaturedTriage,
  triageDecision,
  triageLogFile,
} from '../../server/providers/cctv/featuredTriage.js';
import {
  deriveTitleMatch,
  skipPending,
} from '../../server/providers/cctv/featuredQueue.js';
import { parseFeaturedCatalog } from '../../server/providers/cctv/featured.js';

const MONTEREY = 'UCnM5iMGiKsZg-iOlIO2ZkdQ';
const SDZOO = 'UCC5NfQ6Mf0dq_eEwv4P_hWA';
const WILDEARTH = 'UCV6HJBZD_hZcIX9JVJ3dCXQ';
const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ';
const EXPLORE = 'UCv0In2Sw_YabIhMHHOoTSkA';
const TOWN = 'UC8NnosPOvXnm0O1u5YnLQiw';
const uploadsOf = (channelId) => `UU${channelId.slice(2)}`;

/** The channel list the tests use: the shipped shapes, and a town-area channel. */
const CHANNELS = parseChannels({
  channels: [
    {
      channelId: MONTEREY,
      operator: 'Monterey Bay Aquarium',
      defaultCategory: 'marine',
      defaultPlace: {
        lat: 36.61826,
        lon: -121.90195,
        coordinatesQuality: 'site',
        label: 'Monterey Bay Aquarium, Monterey, California',
      },
    },
    {
      channelId: SDZOO,
      operator: 'San Diego Zoo Wildlife Alliance',
      defaultCategory: 'wildlife',
      defaultPlace: {
        lat: 32.73604,
        lon: -117.15098,
        coordinatesQuality: 'area',
        label: 'San Diego Zoo, Balboa Park, San Diego, California',
        campus: true,
      },
      autoTriage: {
        maxPerDay: 2,
        locations: [
          {
            titleMatch: ['safari park'],
            lat: 33.0975,
            lon: -116.996,
            coordinatesQuality: 'area',
            label: 'San Diego Zoo Safari Park, Escondido, California',
          },
        ],
      },
    },
    {
      channelId: WILDEARTH,
      operator: 'WildEarth',
      defaultCategory: 'wildlife',
    },
    {
      channelId: NASA,
      operator: 'NASA',
      defaultCategory: 'space',
      autoTriage: { accept: 'never' },
    },
    { channelId: EXPLORE, operator: 'explore.org', defaultCategory: 'birds' },
    {
      channelId: TOWN,
      operator: 'Town Cams',
      defaultCategory: 'city',
      defaultPlace: {
        lat: 44.5,
        lon: -110.5,
        coordinatesQuality: 'area',
        label: 'Somewhere, Montana',
      },
      autoTriage: { accept: 'site' },
    },
  ],
});
const channel = (id) => CHANNELS.find((c) => c.channelId === id);
const item = (videoId, channelId, title, extra = {}) => ({
  videoId,
  channelId,
  operator: channel(channelId)?.operator,
  defaultCategory: channel(channelId)?.defaultCategory,
  title,
  suggestion: { kind: 'none' },
  status: 'live',
  ...extra,
});

test('the shipped channel settings parse: campus areas, location rules, never', () => {
  assert.equal(channel(SDZOO).defaultPlace.campus, true);
  assert.deepEqual(channel(SDZOO).autoTriage.locations[0].titleMatch, [
    'safari park',
  ]);
  assert.equal(channel(NASA).autoTriage.accept, 'never');
  assert.equal(channel(MONTEREY).autoTriage, undefined);
  assert.deepEqual(
    parseChannels({
      channels: [
        {
          channelId: EXPLORE,
          autoTriage: {
            accept: 'sometimes',
            maxPerDay: 500,
            locations: [{ titleMatch: [], lat: 1, lon: 1 }],
          },
        },
      ],
    })[0].autoTriage,
    {},
    'unknown settings are dropped one by one',
  );
});

test('site precision passes; a campus area passes; a town area waits for a person', () => {
  const site = triageDecision(
    item('aaaaaaaaaaa', MONTEREY, 'Kelp Forest Cam'),
    channel(MONTEREY),
  );
  assert.equal(site.action, 'accept');
  assert.equal(site.code, 'site-default');
  assert.deepEqual(site.position, {
    lat: 36.61826,
    lon: -121.90195,
    coordinatesQuality: 'site',
    label: 'Monterey Bay Aquarium, Monterey, California',
  });
  const campus = triageDecision(
    item('bbbbbbbbbbb', SDZOO, 'Koala Cam'),
    channel(SDZOO),
  );
  assert.deepEqual([campus.action, campus.code], ['accept', 'campus-default']);
  // A title the channel places elsewhere: the Safari Park is no campus.
  assert.deepEqual(
    triageDecision(
      item('ccccccccccc', SDZOO, 'Elephant Cam | San Diego Zoo Safari Park'),
      channel(SDZOO),
    ),
    { action: 'hold', code: 'area-not-campus' },
  );
  assert.deepEqual(
    triageDecision(item('ddddddddddd', TOWN, 'Main Street'), channel(TOWN)),
    { action: 'hold', code: 'area-not-campus' },
  );
  // A campus area on a channel that takes only sites waits too.
  const strict = {
    ...channel(SDZOO),
    autoTriage: { ...channel(SDZOO).autoTriage, accept: 'site' },
  };
  assert.deepEqual(
    triageDecision(item('eeeeeeeeeee', SDZOO, 'Koala Cam'), strict),
    { action: 'hold', code: 'site-only' },
  );
  // A region default is never a pin.
  assert.deepEqual(
    triageDecision(item('fffffffffff', EXPLORE, 'Bay cam'), {
      ...channel(EXPLORE),
      defaultPlace: {
        lat: 38,
        lon: -76,
        coordinatesQuality: 'region',
        label: 'Chesapeake Bay',
      },
    }),
    { action: 'skip', code: 'region-only' },
  );
});

test('never channels, event titles and unplaced streams are skipped; scan suggestions wait', () => {
  assert.deepEqual(
    triageDecision(item('aaaaaaaaaaa', NASA, 'ISS Earth views'), channel(NASA)),
    { action: 'skip', code: 'never' },
  );
  for (const title of [
    'Monterey Bay Aquarium press conference',
    'News Conference: new exhibit',
    'Morning Briefing',
    'Launch of the new kelp tank',
    'Webinar: Ocean futures',
  ])
    assert.deepEqual(
      triageDecision(item('bbbbbbbbbbb', MONTEREY, title), channel(MONTEREY)),
      { action: 'skip', code: 'event' },
      title,
    );
  assert.deepEqual(
    triageDecision(
      item('ccccccccccc', WILDEARTH, 'SafariLIVE Sunrise - 17 October 2026'),
      channel(WILDEARTH),
    ),
    { action: 'skip', code: 'no-location' },
  );
  const suggested = (kind, coordinatesQuality) =>
    triageDecision(
      item('ddddddddddd', EXPLORE, 'Osprey Nest – Charlo, Montana', {
        suggestion: { kind, lat: 47.4, lon: -114.2, coordinatesQuality },
      }),
      channel(EXPLORE),
    );
  assert.deepEqual(suggested('geotag', 'operator-geotag'), {
    action: 'hold',
    code: 'geotag',
  });
  assert.deepEqual(suggested('text', 'area'), {
    action: 'hold',
    code: 'text-place',
  });
  assert.deepEqual(suggested('text', 'region'), {
    action: 'skip',
    code: 'region-only',
  });
});

test('a recurring stream is decided once: a listed cam, a queued one or a skipped one', () => {
  const sunrise = (day, id) =>
    item(id, WILDEARTH, `SafariLIVE Sunrise - ${day} October 2026`);
  // Dates are not match words, so tomorrow's stream matches today's.
  assert.deepEqual(
    deriveTitleMatch('LIVE at the waterhole - 17 October 2026', 'WildEarth'),
    ['waterhole'],
  );
  assert.deepEqual(
    deriveTitleMatch('SafariLIVE Sunrise - 17 October 2026', 'WildEarth'),
    ['safarilive', 'sunrise'],
  );
  const [entry] = parseFeaturedCatalog({
    cams: [
      {
        id: 'safarilive-sunrise',
        name: 'SafariLIVE Sunrise',
        place: 'Djuma, South Africa',
        lat: -24.8,
        lon: 31.5,
        coordinatesQuality: 'area',
        youtube: {
          videoId: 'LISTED00000',
          channelId: WILDEARTH,
          titleMatch: ['safarilive', 'sunrise'],
        },
      },
    ],
  });
  assert.deepEqual(
    triageDecision(sunrise(18, 'aaaaaaaaaaa'), channel(WILDEARTH), {
      entries: [entry],
    }),
    { action: 'skip', code: 'recurring-entry' },
  );
  assert.deepEqual(
    triageDecision(sunrise(18, 'aaaaaaaaaaa'), channel(WILDEARTH), {
      skippedMatches: [
        { channelId: WILDEARTH, titleMatch: ['safarilive', 'sunrise'] },
      ],
    }),
    { action: 'skip', code: 'recurring-skipped' },
  );
  // Queued before it: the earlier one stays, this one goes.
  const held = {
    ...item('bbbbbbbbbbb', EXPLORE, 'Osprey Nest - 17 October 2026', {
      suggestion: { kind: 'geotag', lat: 47, lon: -114 },
    }),
  };
  assert.deepEqual(
    triageDecision(
      {
        ...held,
        videoId: 'ccccccccccc',
        title: 'Osprey Nest - 18 October 2026',
      },
      channel(EXPLORE),
      { earlier: [held] },
    ),
    { action: 'skip', code: 'recurring-pending' },
  );
  // Another channel's match is not this one's.
  assert.equal(
    triageDecision(sunrise(18, 'aaaaaaaaaaa'), channel(WILDEARTH), {
      skippedMatches: [
        { channelId: EXPLORE, titleMatch: ['safarilive', 'sunrise'] },
      ],
    }).code,
    'no-location',
  );
});

test('a channel is accepted at most its daily cap', () => {
  assert.equal(DEFAULT_DAILY_CAP, 6);
  const kelp = item('aaaaaaaaaaa', MONTEREY, 'Kelp Forest Cam');
  assert.equal(
    triageDecision(kelp, channel(MONTEREY), { acceptedToday: 5 }).action,
    'accept',
  );
  assert.deepEqual(
    triageDecision(kelp, channel(MONTEREY), { acceptedToday: 6 }),
    { action: 'hold', code: 'cap' },
  );
  assert.deepEqual(
    triageDecision(item('bbbbbbbbbbb', SDZOO, 'Koala Cam'), channel(SDZOO), {
      acceptedToday: 2,
    }),
    { action: 'hold', code: 'cap' },
    'a channel’s own cap',
  );
  // Every code the rule can give is one the card or the journal knows.
  const all = Object.values(TRIAGE_CODES).flat();
  assert.equal(new Set(all).size, all.length);
});

// --- the rule in the watcher ------------------------------------------------

function video(id, channelId, title, broadcast = 'live') {
  return {
    id,
    snippet: {
      title,
      description: '',
      channelId,
      channelTitle: channel(channelId)?.operator,
      publishedAt: '2026-10-17T05:00:00Z',
      liveBroadcastContent: broadcast,
    },
    status: { privacyStatus: 'public', embeddable: true },
  };
}

function fakeYouTube(byChannel) {
  const videos = {};
  const uploads = {};
  for (const [channelId, rows] of Object.entries(byChannel)) {
    uploads[uploadsOf(channelId)] = rows.map(([id]) => id);
    for (const [id, title] of rows) videos[id] = video(id, channelId, title);
  }
  const fetchImpl = async (href) => {
    const url = new URL(href);
    const resource = url.pathname.split('/').pop();
    if (resource === 'videos')
      return Response.json({
        items: url.searchParams
          .get('id')
          .split(',')
          .map((id) => videos[id])
          .filter(Boolean),
      });
    if (resource === 'playlistItems')
      return Response.json({
        items: (uploads[url.searchParams.get('playlistId')] || []).map(
          (videoId) => ({ contentDetails: { videoId } }),
        ),
      });
    return new Response('?', { status: 404 });
  };
  return {
    fetchImpl,
    add(channelId, id, title) {
      uploads[uploadsOf(channelId)].unshift(id);
      videos[id] = video(id, channelId, title);
    },
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-triage-'));
  const catalog = path.join(root, 'live-cams.json');
  await fs.writeFile(catalog, JSON.stringify({ version: 1, cams: [] }));
  const saved = process.env.CCTV_FEATURED_FILE;
  process.env.CCTV_FEATURED_FILE = catalog;
  t.after(async () => {
    if (saved === undefined) delete process.env.CCTV_FEATURED_FILE;
    else process.env.CCTV_FEATURED_FILE = saved;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, catalog };
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('in the watcher: accepts, skips and holds are written, journaled, capped and not re-queued', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { root, catalog } = await tempRoot(t);
  // Yesterday's queue, from before the rule: two WildEarth streams.
  await fs.mkdir(path.dirname(pendingFile(root)), { recursive: true });
  await fs.writeFile(
    pendingFile(root),
    JSON.stringify({
      version: 1,
      items: [
        item('OLDWILD0001', WILDEARTH, 'SafariLIVE Sunset - 16 October 2026'),
        item('OLDGEO00001', EXPLORE, 'Osprey Nest – Charlo, Montana', {
          suggestion: {
            kind: 'geotag',
            lat: 47.4381,
            lon: -114.1734,
            coordinatesQuality: 'operator-geotag',
            label: 'Charlo',
          },
        }),
      ],
    }),
  );
  const api = fakeYouTube({
    [MONTEREY]: [
      ['MBAKELP0001', 'Kelp Forest Cam'],
      ['MBAPRESS001', 'Press conference: sea otter program'],
    ],
    [SDZOO]: [
      ['SDZKOALA001', 'Koala Cam'],
      ['SDZAPE00001', 'Ape Cam'],
      ['SDZPOLAR001', 'Polar Cam'],
      ['SDZSAFARI01', 'Elephant Cam | San Diego Zoo Safari Park'],
    ],
    [WILDEARTH]: [
      ['WESUNRISE17', 'SafariLIVE Sunrise - 17 October 2026'],
      ['WEHOLE00017', 'LIVE at the waterhole - 17 October 2026'],
    ],
    [NASA]: [['NASAISS0001', 'Live Views of Earth from Space']],
  });
  let clock = Date.parse('2026-10-17T15:00:00Z');
  const quota = createYoutubeQuota({ now: () => clock });
  const youtube = createYoutubeClient({
    fetchImpl: api.fetchImpl,
    apiKey: () => 'test-key',
    quota,
  });
  let enabled = true;
  const watcher = createChannelWatcher({
    youtube,
    quota,
    now: () => clock,
    geocode: async () => null,
    triage: createFeaturedTriage({ now: () => clock, enabled: () => enabled }),
  });
  const scan = async () =>
    watcher.scanAll({
      sourceRoot: root,
      entries: parseFeaturedCatalog(await readJson(catalog)),
      channels: CHANNELS,
    });

  const first = await scan();
  assert.equal(first.scanned, CHANNELS.length);
  const cams = (await readJson(catalog)).cams;
  assert.deepEqual(
    cams.map((c) => [c.youtube.videoId, c.coordinatesQuality, c.category]),
    [
      ['MBAKELP0001', 'site', 'marine'],
      ['SDZKOALA001', 'area', 'wildlife'],
      ['SDZAPE00001', 'area', 'wildlife'],
    ],
    'site and campus accepted, the zoo capped at 2',
  );
  assert.equal(cams[0].name, 'Kelp Forest Cam');
  assert.deepEqual(cams[0].youtube.titleMatch, ['kelp', 'forest']);
  assert.deepEqual([cams[0].lat, cams[0].lon], [36.61826, -121.90195]);
  const pending = (await readJson(pendingFile(root))).items;
  assert.deepEqual(
    pending.map((i) => [i.videoId, i.triage?.code]),
    [
      ['OLDGEO00001', 'geotag'],
      ['SDZPOLAR001', 'cap'],
      ['SDZSAFARI01', 'area-not-campus'],
    ],
    'only exceptions wait, each with its reason',
  );
  const skipped = (await readJson(skippedFile(root))).videoIds;
  assert.deepEqual(skipped.sort(), [
    'MBAPRESS001',
    'NASAISS0001',
    'OLDWILD0001',
    'WEHOLE00017',
    'WESUNRISE17',
  ]);
  const log = (await fs.readFile(triageLogFile(root), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    log
      .filter((l) => l.action === 'accept')
      .map((l) => [l.videoId, l.code, l.entryId]),
    [
      ['MBAKELP0001', 'site-default', 'kelp-forest-cam'],
      ['SDZKOALA001', 'campus-default', 'koala-cam'],
      ['SDZAPE00001', 'campus-default', 'ape-cam'],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(
      log.filter((l) => l.action === 'skip').map((l) => [l.videoId, l.code]),
    ),
    {
      OLDWILD0001: 'no-location',
      MBAPRESS001: 'event',
      WESUNRISE17: 'no-location',
      WEHOLE00017: 'no-location',
      NASAISS0001: 'never',
    },
  );
  assert.equal(log.filter((l) => l.action === 'hold').length, 3);

  // Later the same day: nothing new is journaled, the capped cam still waits.
  clock += 3 * 60 * 60 * 1000;
  await scan();
  const again = (await fs.readFile(triageLogFile(root), 'utf8'))
    .trim()
    .split('\n');
  assert.equal(again.length, log.length, 'a hold is journaled once');

  // Tomorrow (a new quota day): the capped cam goes in, and a restart of a
  // listed cam is not queued again.
  clock += 24 * 60 * 60 * 1000;
  api.add(SDZOO, 'SDZKOALA002', 'Koala Cam');
  await scan();
  const tomorrow = (await readJson(catalog)).cams.map((c) => c.youtube.videoId);
  assert.ok(tomorrow.includes('SDZPOLAR001'), 'the cap is a day’s');
  assert.ok(
    !tomorrow.includes('SDZKOALA002'),
    'a restart is followed, not added',
  );
  assert.ok(
    !(await readJson(pendingFile(root))).items.some(
      (i) => i.videoId === 'SDZKOALA002',
    ),
  );

  // A person skips the Safari Park cam; its next-day restart is skipped on its own.
  await skipPending(root, { videoId: 'SDZSAFARI01' });
  const matches = (await readJson(skippedFile(root))).matches;
  assert.deepEqual(matches, [
    { channelId: SDZOO, titleMatch: ['elephant', 'safari'] },
  ]);
  clock += 24 * 60 * 60 * 1000;
  api.add(SDZOO, 'SDZSAFARI02', 'Elephant Cam | San Diego Zoo Safari Park');
  await scan();
  assert.ok(
    (await readJson(skippedFile(root))).videoIds.includes('SDZSAFARI02'),
  );
  const last = (await fs.readFile(triageLogFile(root), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.deepEqual(
    [last.videoId, last.code],
    ['SDZSAFARI02', 'recurring-skipped'],
  );

  // With the rule off, a new stream waits for a person again.
  enabled = false;
  clock += 3 * 60 * 60 * 1000;
  api.add(MONTEREY, 'MBAJELLY001', 'Jelly Cam');
  await scan();
  assert.ok(
    (await readJson(pendingFile(root))).items.some(
      (i) => i.videoId === 'MBAJELLY001' && !i.triage,
    ),
  );
});
