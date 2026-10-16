import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_RESCAN_MS,
  COORDINATE_QUALITIES,
  createLiveResolver,
  featuredToSource,
  parseFeaturedCatalog,
  readFeaturedCatalog,
  titleMatches,
} from '../../server/providers/cctv/featured.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  embedBadgeText,
  embedMetaText,
  youtubeEmbedUrl,
} from '../ui/cctvEmbed.js';

const CHANNEL = 'UCv0In2Sw_YabIhMHHOoTSkA';
const FALCONS = '1_BdSTneH3s';
const RESTARTED = 'Zz9_restart';

const entry = (fields = {}) => ({
  id: 'baltimore-peregrine-falcons',
  name: 'Peregrine falcon nest',
  place: '100 Light Street, Baltimore',
  category: 'birds',
  lat: 39.28736,
  lon: -76.61446,
  coordinatesQuality: 'site',
  operator: 'Chesapeake Conservancy',
  operatorUrl: 'https://www.chesapeakeconservancy.org/webcams/peregrine-falcon',
  youtube: {
    videoId: FALCONS,
    channelId: CHANNEL,
    titleMatch: ['Peregrine', 'Chesapeake'],
  },
  ...fields,
});

/** One videos.list item. */
const video = (id, title, broadcast = 'live', status = {}) => ({
  id,
  snippet: { title, liveBroadcastContent: broadcast },
  status: { privacyStatus: 'public', embeddable: true, ...status },
});

/** A fake YouTube Data API: videos by id, uploads by playlist. */
function fakeYouTube({ videos = {}, uploads = {}, fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (href) => {
    const url = new URL(href);
    calls.push(url);
    if (fail) return Response.json(fail.body, { status: fail.status });
    const resource = url.pathname.split('/').pop();
    if (resource === 'videos') {
      const ids = url.searchParams.get('id').split(',');
      return Response.json({
        items: ids.map((id) => videos[id]).filter(Boolean),
      });
    }
    if (resource === 'playlistItems') {
      const ids = uploads[url.searchParams.get('playlistId')] || [];
      return Response.json({
        items: ids.map((videoId) => ({ contentDetails: { videoId } })),
      });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('the list keeps valid entries and drops each malformed one alone', () => {
  const entries = parseFeaturedCatalog({
    cams: [
      entry(),
      entry(), // duplicate id
      entry({ id: 'Bad Id' }),
      entry({ id: 'null-island', lat: 0, lon: 0 }),
      entry({ id: 'bad-video', youtube: { videoId: 'short' } }),
      entry({
        id: 'no-channel',
        coordinatesQuality: 'exact-to-the-nest',
        youtube: { videoId: FALCONS, titleMatch: ['falcon'] },
      }),
    ],
  });
  assert.deepEqual(
    entries.map((e) => e.id),
    ['baltimore-peregrine-falcons', 'no-channel'],
  );
  assert.deepEqual(entries[0].youtube.titleMatch, ['peregrine', 'chesapeake']);
  // Unknown precision falls back to area; a match needs its channel.
  assert.equal(entries[1].coordinatesQuality, 'area');
  assert.deepEqual(entries[1].youtube.titleMatch, []);
  assert.deepEqual(parseFeaturedCatalog(null), []);
});

test('the shipped list is valid, unique and can follow every restart', async () => {
  const raw = JSON.parse(
    await fs.readFile(
      new URL(
        '../data/local_data/cctv_featured/live-cams.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const entries = readFeaturedCatalog(
    fileURLToPath(new URL('../..', import.meta.url)),
  );
  assert.ok(entries.length >= 40);
  assert.equal(entries.length, raw.cams.length, 'no entry was dropped');
  assert.equal(
    new Set(entries.map((e) => e.youtube.videoId)).size,
    entries.length,
  );
  for (const e of entries) {
    assert.ok(COORDINATE_QUALITIES.includes(e.coordinatesQuality), e.id);
    assert.ok(e.youtube.channelId && e.youtube.titleMatch.length, e.id);
  }
  const falcons = entries.find((e) => e.id === 'baltimore-peregrine-falcons');
  assert.equal(falcons.youtube.videoId, FALCONS);
  assert.equal(falcons.coordinatesQuality, 'site');
});

test('without a key every cam is served on its configured id, status unknown', async () => {
  const { fetchImpl, calls } = fakeYouTube();
  const resolver = createLiveResolver({ fetchImpl, apiKey: () => '' });
  const [e] = parseFeaturedCatalog({ cams: [entry()] });
  const result = await resolver.resolve([e]);
  assert.deepEqual(result.get(e.id), {
    videoId: FALCONS,
    status: 'unknown',
    title: '',
  });
  assert.equal(calls.length, 0);
});

test('liveness maps live, upcoming and offline, and drops unembeddable videos', async () => {
  const entries = parseFeaturedCatalog({
    cams: [
      entry({ id: 'live', youtube: { videoId: 'aaaaaaaaaaa' } }),
      entry({ id: 'soon', youtube: { videoId: 'bbbbbbbbbbb' } }),
      entry({ id: 'over', youtube: { videoId: 'ccccccccccc' } }),
      entry({ id: 'locked', youtube: { videoId: 'ddddddddddd' } }),
    ],
  });
  const { fetchImpl, calls } = fakeYouTube({
    videos: {
      aaaaaaaaaaa: video('aaaaaaaaaaa', 'Nest', 'live'),
      bbbbbbbbbbb: video('bbbbbbbbbbb', 'Nest', 'upcoming'),
      ccccccccccc: video('ccccccccccc', 'Nest', 'none'),
      ddddddddddd: video('ddddddddddd', 'Nest', 'live', { embeddable: false }),
    },
  });
  const result = await createLiveResolver({
    fetchImpl,
    apiKey: () => 'test-key',
  }).resolve(entries);
  assert.equal(result.get('live').status, 'live');
  assert.equal(result.get('soon').status, 'upcoming');
  assert.equal(result.get('over').status, 'offline');
  assert.equal(result.has('locked'), false);
  // One batched lookup, no channel scans (none of these has a channel).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('part'), 'snippet,status');
  assert.equal(featuredToSource(entries[3], result.get('locked')), null);
});

test('an ended stream is found again on its channel, then remembered', async () => {
  let clock = 1_000_000;
  const [e] = parseFeaturedCatalog({ cams: [entry()] });
  const { fetchImpl, calls } = fakeYouTube({
    videos: {
      [FALCONS]: video(FALCONS, 'LIVE Peregrine Falcons Nest', 'none'),
      [RESTARTED]: video(
        RESTARTED,
        'LIVE Peregrine Falcons Nest - Chesapeake Conservancy',
      ),
      osprey00000: video('osprey00000', 'LIVE Osprey Nest - Chesapeake'),
    },
    uploads: { [`UU${CHANNEL.slice(2)}`]: ['osprey00000', RESTARTED] },
  });
  const resolver = createLiveResolver({
    fetchImpl,
    apiKey: () => 'test-key',
    now: () => clock,
  });
  const first = await resolver.resolve([e]);
  assert.equal(first.get(e.id).videoId, RESTARTED);
  assert.equal(first.get(e.id).status, 'live');
  assert.ok(calls.some((u) => u.pathname.endsWith('/playlistItems')));
  assert.ok(calls.every((u) => !u.pathname.endsWith('/search')));

  // Next refresh starts from the remembered id: one lookup, no scan.
  calls.length = 0;
  clock += 60_000;
  const second = await resolver.resolve([e]);
  assert.equal(second.get(e.id).videoId, RESTARTED);
  assert.equal(calls.length, 1);
});

test('a channel is rescanned at most once an hour', async () => {
  let clock = 5_000_000;
  const [e] = parseFeaturedCatalog({ cams: [entry()] });
  const { fetchImpl, calls } = fakeYouTube({
    videos: { [FALCONS]: video(FALCONS, 'Peregrine Chesapeake', 'none') },
    uploads: {},
  });
  const resolver = createLiveResolver({
    fetchImpl,
    apiKey: () => 'test-key',
    now: () => clock,
  });
  const scans = () =>
    calls.filter((u) => u.pathname.endsWith('/playlistItems')).length;
  await resolver.resolve([e]);
  assert.equal(scans(), 1);
  clock += CHANNEL_RESCAN_MS - 1;
  const quiet = await resolver.resolve([e]);
  assert.equal(scans(), 1);
  assert.equal(quiet.get(e.id).status, 'offline', 'still listed, as offline');
  clock += 1;
  await resolver.resolve([e]);
  assert.equal(scans(), 2);
});

test('an API failure keeps every cam on its last id and never logs the key', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const [e] = parseFeaturedCatalog({ cams: [entry()] });
  const { fetchImpl } = fakeYouTube({
    fail: {
      status: 403,
      body: { error: { errors: [{ reason: 'quotaExceeded' }] } },
    },
  });
  const result = await createLiveResolver({
    fetchImpl,
    apiKey: () => 'secret-test-key',
  }).resolve([e]);
  assert.deepEqual(result.get(e.id), {
    videoId: FALCONS,
    status: 'unknown',
    title: '',
  });
  assert.ok(warnings.some((w) => w.includes('quotaExceeded')));
  assert.ok(warnings.every((w) => !w.includes('secret-test-key')));
});

test('a featured cam becomes a YouTube source the normalizer keeps intact', () => {
  const [e] = parseFeaturedCatalog({ cams: [entry()] });
  const source = featuredToSource(e, {
    videoId: FALCONS,
    status: 'live',
    title: '',
  });
  assert.equal(source.id, 'yt-baltimore-peregrine-falcons');
  assert.equal(source.feedType, 'youtube');
  assert.equal(
    source.snapshotUrl,
    `https://i.ytimg.com/vi/${FALCONS}/hqdefault_live.jpg`,
  );
  const normalized = normalizeSourceItem(source);
  assert.equal(normalized.feedType, 'youtube');
  assert.deepEqual(normalized.embed, { provider: 'youtube', videoId: FALCONS });
  assert.equal(normalized.liveStatus, 'live');
  assert.equal(normalized.coordinatesQuality, 'site');
  assert.equal(normalized.licenseClass, 'embed-only');
  // Every other source keeps its old shape.
  const plain = normalizeSourceItem({ id: 'x', lat: 1, lon: 1 });
  assert.equal('embed' in plain, false);
  assert.equal('liveStatus' in plain, false);
  // A malformed embed is not passed through.
  assert.equal(
    'embed' in
      normalizeSourceItem({
        ...source,
        embed: { provider: 'youtube', videoId: '../x' },
      }),
    false,
  );
});

test('titles match only when every token is present', () => {
  assert.equal(
    titleMatches('LIVE Osprey Nest - Charlo, Montana', [
      'osprey nest - charlo',
    ]),
    true,
  );
  assert.equal(
    titleMatches('LIVE Osprey & Canada Goose Nest at Rogers Place - Charlo', [
      'osprey nest - charlo',
    ]),
    false,
  );
  assert.equal(titleMatches('anything', []), false);
});

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    for (const key of [
      'CCTV_SOURCES_FILE',
      'CCTV_SOURCES_JSON',
      'CCTV_FEATURED_ENABLED',
      'CCTV_FEATURED_FILE',
      'YOUTUBE_API_KEY',
    ])
      delete process.env[key];
    // The linked-webcam pack would reach QLever (node:https, not fetch).
    process.env.CCTV_LINKED_ENABLED = '0';
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
};

test('the catalog serves featured cams from the app root, and the switch removes them', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-featured-'));
  try {
    const file = path.join(
      root,
      'src/data/local_data/cctv_featured/live-cams.json',
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ cams: [entry()] }));
    await withEnv({}, async () => {
      const sources = await createCctvCatalog({ sourceRoot: root })();
      const featured = sources.filter((s) => s.pack === 'featured');
      assert.deepEqual(
        featured.map((s) => [s.id, s.feedType, s.liveStatus]),
        [['yt-baltimore-peregrine-falcons', 'youtube', 'unknown']],
      );
    });
    await withEnv({ CCTV_FEATURED_ENABLED: '0' }, async () => {
      const sources = await createCctvCatalog({ sourceRoot: root })();
      assert.equal(
        sources.some((s) => s.pack === 'featured'),
        false,
      );
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the panel player is YouTube’s privacy-enhanced embed, muted', () => {
  const url = new URL(youtubeEmbedUrl(FALCONS));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, `/embed/${FALCONS}`);
  assert.equal(url.searchParams.get('mute'), '1');
  assert.equal(url.searchParams.get('autoplay'), '1');
  assert.equal(youtubeEmbedUrl('../../evil'), '');
  assert.equal(embedBadgeText({ liveStatus: 'live' }), 'YOUTUBE · LIVE');
  assert.equal(embedBadgeText({}), 'YOUTUBE · STATUS UNKNOWN');
  assert.equal(
    embedMetaText({
      city: 'Decorah, Iowa',
      category: 'birds',
      coordinatesQuality: 'area',
      provider: 'Raptor Resource Project · explore.org',
    }),
    'Decorah, Iowa · BIRDS · PIN AT AREA · Raptor Resource Project · explore.org',
  );
});
