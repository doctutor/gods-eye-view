// Personal fork: OpenCCTV cameras resolved to their operators' own feeds, as
// the server serves them (camindex.js, normalize.js, observed.js, dedupe.js,
// and the /frame route's directory-still rule in cctv.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { catalogCameraToSource } from '../../server/providers/cctv/camindex.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { applyObservations } from '../../server/providers/cctv/observed.js';
import { dedupeSources } from '../../server/providers/cctv/dedupe.js';
import { featuredToSource } from '../../server/providers/cctv/featured.js';
import { cctvProxy } from '../../server/providers/cctv.js';

/** The Monterey Bay Aquarium cam as the catalog carries its OpenCCTV copy. */
const RESOLVED = {
  id: 'opencctv-411073',
  name: 'Monterey Bay Aquarium',
  city: 'California',
  cityId: 'opencctv',
  provider: 'OpenCCTV',
  credit: 'opencctv.org',
  lat: 36.6187408368904,
  lon: -121.902537288511,
  sourceKind: 'opencctv',
  license:
    'Operator stream, shown in the embedded YouTube player; found through opencctv.org',
  category: 'nature',
  coordinatesQuality: 'site',
  operatorUrl:
    'https://opencctv.org/cameras/united-states/california/monterey-bay-aquarium-411073',
  publishSignal: 'directory-still',
  licenseClass: 'embed-only',
  feedType: 'youtube',
  url: 'https://www.youtube.com/watch?v=fVa6-zCBR7A',
  snapshotUrl: 'https://i.ytimg.com/vi/fVa6-zCBR7A/hqdefault.jpg',
  embed: { provider: 'youtube', videoId: 'fVa6-zCBR7A' },
  liveStatus: 'unknown',
  primary: { kind: 'youtube', videoId: 'fVa6-zCBR7A' },
  primaryVia: 'opencctv',
  resolvedAt: '2026-10-17T17:05:15.781Z',
};

test('a resolved YouTube camera is served in the featured shape, with its provenance', () => {
  const source = catalogCameraToSource(RESOLVED);
  assert.equal(source.feedType, 'youtube');
  assert.deepEqual(source.embed, {
    provider: 'youtube',
    videoId: 'fVa6-zCBR7A',
  });
  assert.equal(
    source.snapshotUrl,
    'https://i.ytimg.com/vi/fVa6-zCBR7A/hqdefault.jpg',
    'the scene shows YouTube’s thumbnail',
  );
  assert.equal(source.publishSignal, 'directory-still');
  assert.equal(source.licenseClass, 'embed-only');
  assert.equal(source.primaryVia, 'opencctv');
  assert.equal(source.resolvedAt, '2026-10-17T17:05:15.781Z');
  // Through the catalog's normalizer, as every pack is.
  const normalized = normalizeSourceItem(source);
  assert.equal(normalized.primaryVia, 'opencctv');
  assert.equal(normalized.resolvedAt, '2026-10-17T17:05:15.781Z');
  assert.deepEqual(normalized.embed, source.embed);
  // An operator image with the directory still behind it; only https.
  const image = catalogCameraToSource({
    ...RESOLVED,
    feedType: 'image',
    url: 'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg',
    snapshotUrl:
      'https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg',
    fallbackSnapshotUrl: 'https://opencctv.org/still/118183.jpg',
    embed: undefined,
    licenseClass: 'display-only',
  });
  assert.equal(
    image.fallbackSnapshotUrl,
    'https://opencctv.org/still/118183.jpg',
  );
  assert.equal(
    normalizeSourceItem(image).fallbackSnapshotUrl,
    'https://opencctv.org/still/118183.jpg',
  );
  assert.equal(
    catalogCameraToSource({
      ...RESOLVED,
      feedType: 'image',
      snapshotUrl: 'https://cams.example.org/a.jpg',
      fallbackSnapshotUrl: 'http://opencctv.org/still/1.jpg',
    }).fallbackSnapshotUrl,
    undefined,
  );
  // A playlist is a playlist.
  assert.equal(
    catalogCameraToSource({
      ...RESOLVED,
      feedType: 'hls',
      url: 'https://video-auth1.iol.pt/beachcam/bcfigueiradois/playlist.m3u8',
    }).feedType,
    'hls',
  );
});

test('the liveness check judges a YouTube camera; a still’s observation does not', () => {
  const youtube = catalogCameraToSource(RESOLVED);
  const ended = { ...youtube, id: 'opencctv-2' };
  const gone = { ...youtube, id: 'opencctv-3' };
  const unjudged = { ...youtube, id: 'opencctv-4' };
  const still = {
    ...catalogCameraToSource({
      ...RESOLVED,
      id: 'opencctv-5',
      feedType: 'image',
      snapshotUrl: 'https://opencctv.org/still/5.jpg',
    }),
  };
  const out = applyObservations([youtube, ended, gone, unjudged, still], {
    'opencctv-411073': { status: 'live', at: 1000, by: 'youtube' },
    'opencctv-2': { status: 'offline', at: 1000, by: 'youtube' },
    'opencctv-3': { status: 'dead', at: 1000, by: 'youtube' },
    // A frame fetch said nothing about a stream.
    'opencctv-4': { status: 'dead', at: 1000 },
    // A stream check says nothing about a still.
    'opencctv-5': { status: 'dead', at: 1000, by: 'youtube' },
  });
  assert.deepEqual(
    out.map((s) => [s.id, s.liveStatus]),
    [
      ['opencctv-411073', 'live'],
      ['opencctv-2', 'offline'],
      ['opencctv-4', 'unknown'],
      ['opencctv-5', 'unknown'],
    ],
  );
  assert.equal(out[0].observedAt, new Date(1000).toISOString());
});

test('OpenCCTV’s copy of a featured stream folds into it, listed as opencctv', () => {
  const featured = {
    ...featuredToSource(
      {
        id: 'monterey-bay',
        name: 'Monterey Bay cam',
        place: 'Monterey Bay Aquarium, Monterey, California',
        category: 'marine',
        lat: 36.61826,
        lon: -121.90195,
        coordinatesQuality: 'site',
        operator: 'Monterey Bay Aquarium',
        operatorUrl: 'https://www.montereybayaquarium.org/animals/live-cams',
      },
      { videoId: 'fVa6-zCBR7A', status: 'live' },
    ),
    pack: 'featured',
  };
  const copy = {
    ...normalizeSourceItem(catalogCameraToSource(RESOLVED)),
    pack: 'camindex',
  };
  const other = {
    ...copy,
    id: 'opencctv-411066',
    name: 'Jellyfish Aquarium',
    embed: { provider: 'youtube', videoId: 'eQ_foBERmzA' },
    url: 'https://www.youtube.com/watch?v=eQ_foBERmzA',
    snapshotUrl: 'https://i.ytimg.com/vi/eQ_foBERmzA/hqdefault.jpg',
  };
  const result = dedupeSources([featured, copy, other], { record: true });
  assert.deepEqual(
    result.sources.map((s) => s.id),
    ['yt-monterey-bay', 'opencctv-411066'],
    'featured wins; another stream at the aquarium is its own camera',
  );
  assert.deepEqual(result.sources[0].alsoListedIn, ['opencctv']);
  assert.equal(result.merges[0].rule, 'url');
  assert.equal(result.winnerOf.get('opencctv-411073'), 'yt-monterey-bay');
});

/** A minimal upstream Response with a streaming body. */
function upstreamResponse({ status = 200, headers = {}, body = 'payload' }) {
  const store = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => store.get(String(name).toLowerCase()) ?? null },
    body: Readable.toWeb(Readable.from([Buffer.from(String(body))])),
  };
}

function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

const DIRECTORY_STILL = {
  id: 'opencctv-1',
  name: 'Directory still',
  lat: 36.6,
  lon: -121.9,
  feedType: 'image',
  url: 'https://opencctv.org/still/1.jpg',
  snapshotUrl: 'https://opencctv.org/still/1.jpg',
  publishSignal: 'directory-still',
  licenseClass: 'display-only',
  operatorUrl: 'https://opencctv.org/cameras/somewhere/camera-1',
};
const OPERATOR_IMAGE = {
  ...DIRECTORY_STILL,
  id: 'opencctv-2',
  url: 'https://cams.upstream.invalid/operator.jpg',
  snapshotUrl: 'https://cams.upstream.invalid/operator.jpg',
  fallbackSnapshotUrl: 'https://opencctv.org/still/2.jpg',
  primaryVia: 'opencctv',
};

async function mount(t, respond) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-frame-'));
  const saved = {};
  for (const name of [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'CAMINDEX_DIR',
  ])
    saved[name] = process.env[name];
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    DIRECTORY_STILL,
    OPERATOR_IMAGE,
  ]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  // What frame fetches observe goes to a temporary camindex directory.
  process.env.CAMINDEX_DIR = dir;
  // A Street View key, so a fallback would be tried if the rule allowed it.
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-street-view-key';
  delete process.env.GOOGLE_MAPS_API_KEY;
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push(String(url));
    return respond(String(url), init);
  };
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await fs.rm(dir, { recursive: true, force: true });
  });
  let handler = null;
  cctvProxy().configureServer({
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  const call = async (url) => {
    const { res, done } = recordingResponse();
    await handler({ url, headers: {}, method: 'GET', on() {} }, res);
    await done;
    return res;
  };
  return { call, requests };
}

test('a directory camera whose still fails gets no Street View stand-in', async (t) => {
  const app = await mount(t, () =>
    upstreamResponse({ status: 404, body: 'gone' }),
  );
  const res = await app.call(`/frame/${DIRECTORY_STILL.id}`);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'Frame unavailable' });
  assert.ok(
    !app.requests.some((url) => /maps\.googleapis\.com|streetview/.test(url)),
    'no Street View request',
  );
});

test('an operator image that fails falls back to the directory still', async (t) => {
  const app = await mount(t, (url) =>
    url.includes('opencctv.org/still/2.jpg')
      ? upstreamResponse({
          headers: { 'content-type': 'image/jpeg' },
          body: 'x'.repeat(2048),
        })
      : upstreamResponse({ status: 503, body: 'busy' }),
  );
  const res = await app.call(`/frame/${OPERATOR_IMAGE.id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'upstream-image');
  assert.equal(res.body.length, 2048);
  assert.deepEqual(app.requests, [
    'https://cams.upstream.invalid/operator.jpg',
    'https://opencctv.org/still/2.jpg',
  ]);
});
