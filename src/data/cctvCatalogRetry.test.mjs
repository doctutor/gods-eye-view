import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  CCTV_SOURCE_CACHE_MS,
  CCTV_SOURCE_RETRY_MS,
  DEFAULT_MDOT_CCTV_URL,
} from '../../server/providers/cctv/constants.js';

/** One CHART record, enough for the MDOT loader to keep it. */
const chartRow = {
  cameraCategories: ['Baltimore'],
  cctvIp: 'strmr5.sha.maryland.gov',
  commMode: 'ONLINE',
  description: 'I-95 AT I-395',
  id: '00012848007300bc004c823633235daa',
  lat: 39.27,
  lon: -76.63,
  name: '502021',
  opStatus: 'OK',
  publicVideoURL: 'https://chart.maryland.gov/Video/GetVideo/x',
};

test('a pack that came back empty is refetched after the short retry, not the full TTL', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = { ...process.env };
  let now = 1_000_000_000;
  t.mock.method(Date, 'now', () => now);
  // Every pack but MDOT answers empty; MDOT times out the first time only.
  let mdotCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === DEFAULT_MDOT_CCTV_URL) {
      mdotCalls += 1;
      if (mdotCalls === 1)
        throw new Error('The operation was aborted due to timeout');
      return Response.json([chartRow]);
    }
    return Response.json([]);
  });
  try {
    for (const key of Object.keys(process.env))
      if (/^CCTV_|^WINDY|^YOUTUBE|^OVERPASS/.test(key)) delete process.env[key];
    process.env.CCTV_LINKED_ENABLED = '0';
    process.env.CCTV_FEATURED_ENABLED = '0';
    process.env.CCTV_WINDY_ENABLED = '0';
    // A configured camera keeps the catalog non-empty (an empty catalog is
    // always refetched anyway); the live packs still load alongside it.
    process.env.CCTV_FORCE_AUSTIN = '1';
    process.env.CCTV_SOURCES_JSON = JSON.stringify([
      {
        id: 'cfg-1',
        name: 'Configured',
        lat: 1,
        lon: 1,
        url: 'https://a.b/c.jpg',
      },
    ]);
    const getSources = createCctvCatalog({ sourceRoot: '/nonexistent' });

    const first = await getSources();
    assert.equal(
      first.some((s) => s.pack === 'mdot'),
      false,
      'MDOT timed out',
    );
    assert.equal(mdotCalls, 1);

    // One minute later: still inside the retry window, served from cache.
    now += 60_000;
    await getSources();
    assert.equal(mdotCalls, 1);

    // Past the short retry (but well inside the 15-minute TTL): refetched.
    now += CCTV_SOURCE_RETRY_MS;
    const second = await getSources();
    assert.equal(mdotCalls, 2);
    assert.equal(
      second.some((s) => s.pack === 'mdot'),
      true,
      'MDOT is back',
    );

    // The other packs are still empty here, so the short retry keeps
    // applying until every enabled pack answers.
    now += CCTV_SOURCE_RETRY_MS + 1;
    await getSources();
    assert.equal(mdotCalls, 3, 'still retrying while packs are empty');
    now += 60_000;
    await getSources();
    assert.equal(mdotCalls, 3, 'inside the retry window: served from cache');
    assert.ok(CCTV_SOURCE_RETRY_MS < CCTV_SOURCE_CACHE_MS);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
