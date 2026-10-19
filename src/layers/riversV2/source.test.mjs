// Personal fork: the client helper for the self-hosted HydroSHEDS v2 rivers
// (src/layers/riversV2/source.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RIVERS_V2_ENDPOINT,
  STATUS_TTL_MS,
  createRiversV2Source,
  riversV2ImageryOptions,
  riversV2Ready,
  riversV2TileTemplate,
  toRiversV2Status,
} from './source.js';

const BUILT = {
  configured: true,
  builtAt: '2026-10-19T03:22:02.944Z',
  attribution:
    'HydroSHEDS v2 (Lehner et al. 2022; WWF, DLR, Confluvio), CC BY 4.0',
  minZoom: 0,
  maxZoom: 14,
  versions: {
    light: 'edca494f7c57',
    dark: '9a802c9481d4',
    blue: 'aaaaaaaaaaaa',
  },
  extent: { west: -169.72, south: -55.96, east: -32.41, north: 83.13 },
  bands: [
    { minZoom: 0, maxZoom: 2, maxOrder: 3, minUplandKm2: 100000 },
    { minZoom: 'x', maxZoom: 4, maxOrder: 4 },
  ],
};

test('the status is checked on the way in', () => {
  const status = toRiversV2Status(BUILT);
  assert.equal(status.configured, true);
  assert.deepEqual(status.versions, {
    light: 'edca494f7c57',
    dark: '9a802c9481d4',
  });
  assert.deepEqual(status.bands, [
    { minZoom: 0, maxZoom: 2, maxOrder: 3, minUplandKm2: 100000 },
  ]);
  assert.equal(status.extent.north, 83.13);
  const odd = toRiversV2Status({
    configured: 'yes',
    versions: { light: 'not-a-hash' },
    extent: { west: 1 },
    maxZoom: 40,
  });
  assert.equal(odd.configured, false);
  assert.deepEqual(odd.versions, {});
  assert.equal(odd.extent, null);
  assert.equal(odd.maxZoom, 18);
  assert.equal(toRiversV2Status(null).configured, false);
});

test('ready means built with a version for the ink', () => {
  const status = toRiversV2Status(BUILT);
  assert.equal(riversV2Ready(status, 'light'), true);
  assert.equal(riversV2Ready(status, 'dark'), true);
  assert.equal(
    riversV2Ready(status, 'auto'),
    false,
    'AUTO resolves to light or dark first',
  );
  assert.equal(
    riversV2Ready(toRiversV2Status({ configured: false }), 'light'),
    false,
  );
  assert.equal(riversV2Ready({ ...status, versions: {} }, 'light'), false);
  assert.equal(riversV2Ready(null), false);
});

test('the tile template names the ink and carries the version', () => {
  assert.equal(
    riversV2TileTemplate('dark', '9a802c9481d4'),
    '/api/rivers/v2/tile/dark/{z}/{x}/{y}?v=9a802c9481d4',
  );
  assert.equal(
    riversV2TileTemplate('light'),
    '/api/rivers/v2/tile/light/{z}/{x}/{y}',
  );
  assert.equal(
    riversV2TileTemplate('light', '../x'),
    '/api/rivers/v2/tile/light/{z}/{x}/{y}',
  );
  assert.throws(() => riversV2TileTemplate('blue'), /No rivers ink/);
  assert.equal(RIVERS_V2_ENDPOINT, '/api/rivers/v2');
});

test('imagery options for UrlTemplateImageryProvider, or null when not ready', () => {
  const status = toRiversV2Status(BUILT);
  assert.deepEqual(riversV2ImageryOptions(status, 'light'), {
    url: '/api/rivers/v2/tile/light/{z}/{x}/{y}?v=edca494f7c57',
    minimumLevel: 0,
    maximumLevel: 14,
    tileWidth: 256,
    tileHeight: 256,
    hasAlphaChannel: true,
    credit: BUILT.attribution,
    rectangleDegrees: BUILT.extent,
  });
  assert.equal(riversV2ImageryOptions(toRiversV2Status({}), 'light'), null);
});

test('the status is fetched once, kept, and a failure reads as not ready', async () => {
  let clock = 0;
  const calls = [];
  const source = createRiversV2Source({
    now: () => clock,
    fetchImpl: async (url, options) => {
      calls.push([url, options.credentials]);
      return new Response(JSON.stringify(BUILT), { status: 200 });
    },
  });
  const [a, b] = await Promise.all([source.status(), source.status()]);
  assert.equal(a, b, 'one request for concurrent callers');
  assert.deepEqual(calls, [['/api/rivers/v2/layers', 'same-origin']]);
  assert.equal(riversV2Ready(a, 'dark'), true);
  clock += STATUS_TTL_MS - 1;
  await source.status();
  assert.equal(calls.length, 1, 'kept');
  clock += 2;
  await source.status();
  assert.equal(calls.length, 2, 'asked again');
  await source.status({ refresh: true });
  assert.equal(calls.length, 3);
  assert.equal(source.last().configured, true);

  const down = createRiversV2Source({
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });
  const failed = await down.status();
  assert.equal(riversV2Ready(failed), false);
  assert.match(failed.message, /connection refused/);
  const unbuilt = createRiversV2Source({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: 'Run npm run rivers:build' }), {
        status: 503,
      }),
  });
  const status = await unbuilt.status();
  assert.equal(status.configured, false);
  assert.match(status.message, /rivers:build/);
});
