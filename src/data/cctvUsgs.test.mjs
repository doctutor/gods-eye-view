import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  USGS_ASHCAM_URL,
  USGS_FRESH_MS,
  ashcamToSources,
  createUsgsVolcanoLoader,
  observatoryFor,
} from '../../server/providers/cctv/usgs.js';
import {
  DAILY_RETRY_MS,
  DAILY_TTL_MS,
} from '../../server/providers/cctv/dailyCache.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const NOW = Date.parse('2026-10-16T20:00:00Z');
const image = (code) =>
  `https://avo-volcview.wr.usgs.gov/ashcam-api/images/webcams/${code}/current.jpg`;

/** One ashcam API record, fresh and plausible unless overridden. */
const cam = (code, extra = {}) => ({
  webcamCode: code,
  webcamName: code,
  latitude: 54.11047,
  longitude: -165.6969,
  elevationM: 219.5,
  bearingDeg: 350,
  externalUrl: null,
  vName: 'Akutan',
  hasImages: 'Y',
  lastImageTimestamp: Math.floor((NOW - 60 * 60 * 1000) / 1000),
  currentImageUrl: image(code),
  ...extra,
});

const webcams = [
  cam('akutan_aksd', { webcamName: 'Akutan [AKS, 720 ft]' }),
  cam('kilauea-f1-cam', {
    webcamName: 'Kilauea - F1 Cam',
    vName: 'Kilauea',
    latitude: 19.421,
    longitude: -155.287,
    bearingDeg: null,
    elevationM: null,
    externalUrl:
      'https://volcanoes.usgs.gov/observatories/hvo/cams/panorama.php?cam=F1cam',
  }),
  // Bearing 0 and elevation 0 are an unfilled record, not north at sea level.
  cam('ys-bbsn', {
    webcamName: 'Black Diamond Pool',
    vName: 'Yellowstone',
    latitude: 44.48531,
    longitude: -110.85388,
    bearingDeg: 0,
    elevationM: 0,
  }),
  // FAA aviation cam: a government page, but plain http (no operator link).
  cam('akunIsland-N', {
    externalUrl: 'http://avcams.faa.gov/viewsite.php?bookmark=74IBZOLY',
  }),
  // A ski lodge's own image, re-hosted: not public domain.
  cam('hood-palmer', {
    webcamName: 'CVO Hood (Palmer, South)',
    latitude: 45.3313,
    longitude: -121.711,
    externalUrl: 'https://timberlinelodge.com/snowcameras/palmerbottom.jpg',
  }),
  cam('kilauea-ko-cam', { latitude: 0, longitude: 0 }),
  cam('stale', {
    lastImageTimestamp: Math.floor((NOW - USGS_FRESH_MS - 1000) / 1000),
  }),
  cam('no-images', { hasImages: 'N' }),
  cam('off-host', { currentImageUrl: 'https://evil.example/current.jpg' }),
  cam('plain-http', {
    currentImageUrl: image('plain-http').replace('https:', 'http:'),
  }),
  cam('bad code!'),
  cam('akutan_aksd', { webcamName: 'duplicate' }),
];

test('ashcam records become volcano stills; stale, off-host and third-party ones are left out', () => {
  const sources = ashcamToSources(webcams, { now: NOW });
  assert.deepEqual(
    sources.map((s) => s.id),
    [
      'usgs-volcano-akutan_aksd',
      'usgs-volcano-kilauea-f1-cam',
      'usgs-volcano-ys-bbsn',
      'usgs-volcano-akunIsland-N',
    ],
  );
  const [akutan, kilauea, yellowstone, faa] = sources;
  assert.equal(akutan.name, 'Akutan [AKS, 720 ft]');
  assert.equal(akutan.city, 'Akutan');
  assert.equal(akutan.feedType, 'image');
  assert.equal(akutan.snapshotUrl, image('akutan_aksd'));
  assert.equal(akutan.url, akutan.snapshotUrl);
  assert.equal(akutan.headingDeg, 350);
  assert.equal(akutan.headingConfidence, 'high');
  assert.equal(akutan.groundElevationM, 219.5);
  assert.equal(akutan.provider, 'USGS');
  assert.equal(akutan.credit, 'USGS (public domain)');
  assert.equal(akutan.category, 'volcano');
  assert.equal(akutan.coordinatesQuality, 'site');
  assert.match(akutan.license, /Alaska Volcano Observatory/);
  assert.ok(Number.isNaN(kilauea.headingDeg), 'no bearing, no heading');
  assert.equal(kilauea.headingConfidence, 'low');
  assert.equal('groundElevationM' in kilauea, false);
  assert.match(kilauea.license, /Hawaiian Volcano Observatory/);
  assert.equal(
    kilauea.operatorUrl,
    'https://volcanoes.usgs.gov/observatories/hvo/cams/panorama.php?cam=F1cam',
  );
  assert.match(yellowstone.license, /Yellowstone Volcano Observatory/);
  assert.ok(Number.isNaN(yellowstone.headingDeg));
  assert.equal('groundElevationM' in yellowstone, false);
  assert.equal(faa.operatorUrl, '', 'an http page is not offered');

  const normalized = normalizeSourceItem(kilauea);
  assert.equal(normalized.feedType, 'image');
  assert.equal(normalized.category, 'volcano');
  assert.equal(normalized.licenseClass, 'public-domain');
  assert.equal(normalized.operatorUrl, kilauea.operatorUrl);
  assert.deepEqual(ashcamToSources(null), []);
});

test('cameras are assigned to their observatory', () => {
  assert.equal(observatoryFor({ webcamCode: 'ys-x' }), 'YVO');
  assert.equal(observatoryFor({ webcamName: 'CVO Rainier (Elbe)' }), 'CVO');
  assert.equal(observatoryFor({ latitude: 19.4, longitude: -155.3 }), 'HVO');
  assert.equal(observatoryFor({ latitude: 51.4, longitude: 179.3 }), 'AVO');
  assert.equal(observatoryFor({ latitude: 61.2, longitude: -152.3 }), 'AVO');
  assert.equal(observatoryFor({ latitude: 17.3, longitude: 145.8 }), 'USGS');
});

/** A fetch double; `reply` builds a fresh Response for every call. */
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (href, init) => {
    calls.push({ href, init });
    return reply();
  };
  return { fetchImpl, calls };
}

test('the loader fetches once a day, keeps a disk copy and serves it when the API fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-usgs-'));
  let clock = NOW;
  try {
    const good = fakeFetch(() => Response.json({ webcams, meta: {} }));
    const load = createUsgsVolcanoLoader({
      fetchImpl: good.fetchImpl,
      now: () => clock,
      cacheDir: dir,
    });
    const [first, again] = await Promise.all([load(), load()]);
    assert.equal(first.length, 4);
    assert.equal(again, first, 'concurrent loads share one fetch');
    assert.equal(good.calls.length, 1);
    assert.equal(good.calls[0].href, USGS_ASHCAM_URL);
    assert.equal(good.calls[0].init.redirect, 'error');

    // Within the day, a new loader reads the disk copy without fetching.
    clock += DAILY_TTL_MS - 1;
    const bad = fakeFetch(() => new Response('busy', { status: 503 }));
    const second = createUsgsVolcanoLoader({
      fetchImpl: bad.fetchImpl,
      now: () => clock,
      cacheDir: dir,
    });
    assert.equal((await second()).length, 4);
    assert.equal(bad.calls.length, 0);

    // After the day, a failed refresh serves the old copy and backs off.
    clock += 2;
    assert.equal((await second()).length, 4);
    assert.equal(bad.calls.length, 1);
    assert.ok(
      warnings.some((w) => /USGS ashcam 503\); serving 4 cached/.test(w)),
    );
    assert.equal((await second()).length, 4);
    assert.equal(bad.calls.length, 1);
    clock += DAILY_RETRY_MS;
    await second();
    assert.equal(bad.calls.length, 2);
    assert.deepEqual(await fs.readdir(dir), ['usgs-volcano.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('malformed, empty and oversized ashcam answers are failures, not empty lists', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-usgs-bad-'));
  try {
    const cases = [
      [() => new Response('<html>', { status: 200 }), /malformed JSON/],
      [() => Response.json({ webcams: [] }), /no webcams/],
      [() => Response.json([]), /no webcams/],
      [
        () =>
          new Response('x', {
            status: 200,
            headers: { 'content-length': String(9 * 1024 * 1024) },
          }),
        /response too large/,
      ],
    ];
    for (const [i, [reply, expected]] of cases.entries()) {
      warnings.length = 0;
      const load = createUsgsVolcanoLoader({
        fetchImpl: fakeFetch(reply).fetchImpl,
        now: () => NOW,
        cacheDir: path.join(dir, String(i)),
      });
      assert.deepEqual(await load(), []);
      assert.ok(
        warnings.some((w) => expected.test(w) && /none cached/.test(w)),
        String(expected),
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the catalog serves USGS volcano cams, and CCTV_USGS_ENABLED=0 skips the request', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { createCctvCatalog } =
    await import('../../server/providers/cctv/catalog.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-usgs-cat-'));
  const saved = { ...process.env };
  const requested = [];
  const fresh = Math.floor(Date.now() / 1000) - 600;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (String(url) === USGS_ASHCAM_URL)
      return Response.json({
        webcams: [cam('akutan_aksd', { lastImageTimestamp: fresh })],
      });
    return Response.json([]);
  });
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^NPS_|^OVERPASS_|^WINDY|^YOUTUBE/.test(key))
        delete process.env[key];
    process.env.CCTV_LINKED_ENABLED = '0';
    process.env.CCTV_FEATURED_ENABLED = '0';
    process.env.CCTV_WINDY_ENABLED = '0';
    const sources = await createCctvCatalog({ sourceRoot: root })();
    assert.deepEqual(
      sources
        .filter((s) => s.pack === 'usgs-volcano')
        .map((s) => [s.id, s.feedType, s.category]),
      [['usgs-volcano-akutan_aksd', 'image', 'volcano']],
    );
    assert.equal(
      sources.some((s) => s.pack === 'nps'),
      false,
      'no NPS key, no NPS cams',
    );

    requested.length = 0;
    process.env.CCTV_USGS_ENABLED = '0';
    const without = await createCctvCatalog({ sourceRoot: root })();
    assert.equal(
      without.some((s) => s.pack === 'usgs-volcano'),
      false,
    );
    assert.equal(requested.includes(USGS_ASHCAM_URL), false);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
});
