import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  NPS_MAX_PAGES,
  NPS_PAGE_SIZE,
  NPS_PLACEHOLDER_TITLE,
  NPS_WEBCAMS_URL,
  createNpsLoader,
  npsCategory,
  npsToSources,
} from '../../server/providers/cctv/nps.js';
import { DAILY_TTL_MS } from '../../server/providers/cctv/dailyCache.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

/** One NPS API webcam record, active and placed unless overridden. */
const webcam = (id, extra = {}) => ({
  id,
  url: `https://www.nps.gov/media/webcam/view.htm?id=${id}`,
  title: `Webcam ${id}`,
  description: '',
  images: [],
  relatedParks: [{ fullName: 'Acadia National Park', parkCode: 'acad' }],
  status: 'Active',
  statusMessage: '',
  isStreaming: false,
  tags: [],
  latitude: 44.35,
  longitude: -68.21,
  ...extra,
});

test('NPS webcams become park pins, classified like linked webcams', () => {
  const sources = npsToSources([
    webcam('A1B2-page', { title: 'Cadillac Mountain Summit' }),
    webcam('img-1', {
      title: 'Old Faithful',
      url: 'https://www.nps.gov/webcams-yell/oldfaithfulcam.jpg',
      latitude: '44.4605',
      longitude: '-110.8281',
      relatedParks: [{ fullName: 'Yellowstone National Park' }],
    }),
    webcam('hls-1', {
      title: 'Kīlauea Overlook',
      url: 'https://stream.example.gov/live/index.m3u8',
      isStreaming: true,
    }),
    webcam('yt-1', {
      title: 'Brown Bear Cam',
      url: 'https://www.youtube.com/watch?v=1_BdSTneH3s',
    }),
    webcam('inactive', { status: 'Inactive' }),
    webcam('no-coords', { latitude: '', longitude: '' }),
    webcam('one-coord', { latitude: '', longitude: -68.2 }),
    webcam('null-island', { latitude: 0, longitude: 0 }),
    webcam('no-url', { url: '' }),
    webcam('bad id!'),
    webcam('A1B2-page', { title: 'duplicate' }),
  ]);
  assert.deepEqual(
    sources.map((s) => [s.id, s.feedType, s.category]),
    [
      ['nps-webcam-A1B2-page', 'link', 'mountain'],
      ['nps-webcam-img-1', 'image', 'nature'],
      ['nps-webcam-hls-1', 'hls', 'volcano'],
      ['nps-webcam-yt-1', 'youtube', 'wildlife'],
    ],
  );
  const [page, still, , youtube] = sources;
  assert.equal(page.url, '', 'a page is a pin, never fetched as a frame');
  assert.equal(
    page.operatorUrl,
    'https://www.nps.gov/media/webcam/view.htm?id=A1B2-page',
  );
  assert.equal(page.city, 'Acadia National Park');
  assert.equal(page.provider, 'National Park Service');
  assert.equal(page.credit, 'NPS (public domain)');
  assert.equal(page.coordinatesQuality, 'site');
  assert.equal(page.licenseClass, 'public-domain');
  assert.equal(still.lat, 44.4605);
  assert.equal(still.lon, -110.8281);
  assert.equal(still.snapshotUrl, still.url);
  assert.equal(still.city, 'Yellowstone National Park');
  assert.deepEqual(youtube.embed, {
    provider: 'youtube',
    videoId: '1_BdSTneH3s',
  });
  assert.equal(youtube.licenseClass, 'embed-only');
  const normalized = normalizeSourceItem(page);
  assert.equal(normalized.feedType, 'link');
  assert.equal(normalized.operatorUrl, page.operatorUrl);
  assert.equal(normalized.category, 'mountain');
  assert.deepEqual(npsToSources(undefined), []);
});

test('NPS categories come from the title, nature by default', () => {
  assert.equal(npsCategory('Halemaʻumaʻu Crater'), 'volcano');
  assert.equal(npsCategory('Cape Hatteras Lighthouse'), 'beach');
  assert.equal(npsCategory('Mt. Rainier from Paradise'), 'mountain');
  assert.equal(npsCategory('Osprey nest'), 'wildlife');
  assert.equal(npsCategory('Visitor Center'), 'nature');
  assert.equal(npsCategory(undefined), 'nature');
});

/** NPS pages from a full list, honouring limit and start. */
function npsApi(all, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (href, init) => {
    calls.push({ href, init });
    if (status !== 200) return Response.json({ error: {} }, { status });
    const url = new URL(href);
    const limit = Number(url.searchParams.get('limit'));
    const start = Number(url.searchParams.get('start'));
    return Response.json({
      total: String(all.length),
      limit: String(limit),
      start: String(start),
      data: all.slice(start, start + limit),
    });
  };
  return { fetchImpl, calls };
}

test('without NPS_API_KEY the pack is skipped and says so once', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const api = npsApi([webcam('a')]);
  const load = createNpsLoader({ fetchImpl: api.fetchImpl, env: {} });
  const skipped = await load();
  assert.equal(skipped.length, 0);
  assert.equal(
    skipped.skipped,
    'NPS_API_KEY is not set',
    'says why, for the status readout',
  );
  assert.equal((await load()).length, 0);
  assert.equal(api.calls.length, 0);
  assert.deepEqual(
    logs.filter((l) => /NPS/.test(l)),
    ['[CCTV] NPS webcams skipped: NPS_API_KEY is not set'],
  );
});

test('with a key, every page is read once a day and a failure serves the disk copy', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-nps-'));
  let clock = 1_000_000;
  try {
    const all = Array.from({ length: 120 }, (_, i) => webcam(`cam-${i}`));
    const api = npsApi(all);
    const env = { NPS_API_KEY: 'test-key' };
    const load = createNpsLoader({
      fetchImpl: api.fetchImpl,
      now: () => clock,
      cacheDir: dir,
      env,
    });
    const first = await load();
    assert.equal(first.length, 120);
    assert.deepEqual(
      api.calls.map((c) => c.href),
      [0, 50, 100].map(
        (start) => `${NPS_WEBCAMS_URL}?limit=${NPS_PAGE_SIZE}&start=${start}`,
      ),
    );
    assert.equal(api.calls[0].init.headers['X-Api-Key'], 'test-key');
    assert.ok(
      !logs.concat(warnings).some((l) => l.includes('test-key')),
      'the key is never logged',
    );

    // The next day the API refuses the key: the disk copy is served.
    clock += DAILY_TTL_MS + 1;
    const refused = npsApi(all, { status: 403 });
    const second = createNpsLoader({
      fetchImpl: refused.fetchImpl,
      now: () => clock,
      cacheDir: dir,
      env,
    });
    assert.equal((await second()).length, 120);
    assert.equal(refused.calls.length, 1);
    assert.ok(warnings.some((w) => /NPS 403\); serving 120 cached/.test(w)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('paging stops at the page cap and on an empty page; bad pages fail the refresh', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-nps-pages-'));
  try {
    // An API that always claims more: the cap ends it.
    let calls = 0;
    const endless = createNpsLoader({
      fetchImpl: async (href) => {
        calls++;
        const start = Number(new URL(href).searchParams.get('start'));
        return Response.json({
          total: '999999',
          data: [webcam(`c${start}`)],
        });
      },
      cacheDir: path.join(dir, 'a'),
      env: { NPS_API_KEY: 'k' },
    });
    assert.equal((await endless()).length, NPS_MAX_PAGES);
    assert.equal(calls, NPS_MAX_PAGES);

    // No total, then an empty page.
    let pages = 0;
    const untotalled = createNpsLoader({
      fetchImpl: async () =>
        Response.json({ data: pages++ ? [] : [webcam('only')] }),
      cacheDir: path.join(dir, 'b'),
      env: { NPS_API_KEY: 'k' },
    });
    assert.equal((await untotalled()).length, 1);
    assert.equal(pages, 2);

    for (const [i, [reply, expected]] of [
      [() => new Response('nope'), /malformed JSON/],
      [() => Response.json({ error: 'x' }), /no data/],
      [() => Response.json({ total: '0', data: [] }), /no webcams/],
    ].entries()) {
      warnings.length = 0;
      const load = createNpsLoader({
        fetchImpl: async () => reply(),
        cacheDir: path.join(dir, `bad-${i}`),
        env: { NPS_API_KEY: 'k' },
      });
      assert.deepEqual(await load(), []);
      assert.ok(
        warnings.some((w) => expected.test(w)),
        String(expected),
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('content-system placeholders ("Question 5", "Test") are not webcams', () => {
  // As the API lists them: Active, placed, no park, a webcam page link.
  const placeholder = (id, title) =>
    webcam(id, {
      title,
      relatedParks: [],
      latitude: 37.8383903503418,
      longitude: -80.9935302734375,
    });
  const sources = npsToSources([
    placeholder('CF8669EB-9852-5AAD-705D2BE551AA032E', 'Question 5'),
    placeholder('CEFC65FC-0BDC-6689-27F5F886BE7065F9', 'Question 4'),
    placeholder('4D3B21FF-0018-C37A-B6C8D836DBE7D4EB', 'Test'),
    placeholder('q-spaced', '  question 12 '),
    webcam('real-1', { title: 'Questions Answered at the Visitor Center' }),
    webcam('real-2', { title: 'Test Site Overlook' }),
  ]);
  assert.deepEqual(
    sources.map((s) => s.name),
    ['Questions Answered at the Visitor Center', 'Test Site Overlook'],
  );
  assert.ok(NPS_PLACEHOLDER_TITLE.test('Question 5'));
  assert.ok(!NPS_PLACEHOLDER_TITLE.test('Old Faithful'));
});
