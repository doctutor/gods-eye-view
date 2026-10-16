import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ageText,
  formatBytes,
  formatCount,
  quotaLine,
  sourceRows,
} from './cctvSources.js';

const NOW = Date.parse('2026-10-16T20:00:00Z');

const status = {
  refreshedAt: '2026-10-16T19:58:00Z',
  packs: [
    {
      name: 'mdot',
      enabled: true,
      proximityOnly: false,
      available: 519,
      servedCapped: 300,
      inIndex: 519,
      dedupedAway: 0,
      lastRefreshAt: '2026-10-16T19:56:00Z',
      lastError: null,
    },
    {
      name: 'camindex',
      enabled: true,
      proximityOnly: true,
      available: 29980,
      servedCapped: 0,
      inIndex: 28267,
      dedupedAway: 1713,
      lastRefreshAt: '2026-10-16T19:56:00Z',
      lastError: null,
    },
    {
      name: 'vegvesen',
      enabled: true,
      proximityOnly: false,
      available: 0,
      servedCapped: 0,
      inIndex: 0,
      dedupedAway: 0,
      lastRefreshAt: null,
      lastError: { at: '2026-10-16T19:56:00Z', message: 'empty' },
    },
  ],
  dynamic: [
    {
      name: 'windy',
      enabled: true,
      configured: true,
      requestsLastMinute: 12,
      budgetPerMinute: 60,
      cacheEntries: 4,
      knownCameras: 80,
      lastError: null,
    },
  ],
  camindex: {
    catalog: {
      generatedAt: '2026-10-16T17:00:00Z',
      cameras: 29980,
      sources: {},
    },
    verified: { live: 61, dead: 5, unknown: 0, total: 66, lastAt: 1 },
  },
  featured: {
    listed: 41,
    liveNow: 16,
    pending: 14,
    youtube: { day: '2026-10-16', units: 318, budget: 1500, geocodes: 6 },
  },
  audio: { audio: 2, silent: 9, likely: 1, unknown: 0 },
  frameCache: {
    entries: 120,
    bytes: 12 * 1024 * 1024,
    hits: 300,
    misses: 100,
    hitRate: 0.75,
  },
};
const streetview = {
  configured: true,
  dailyCap: 3000,
  usedToday: 1331,
  counts: { places: 40, panos: 212, cells: 9 },
};

test('counts, sizes and ages are short', () => {
  assert.deepEqual([0, 999, 1234, 9950, 29980].map(formatCount), [
    '0',
    '999',
    '1.2k',
    '9.9k',
    '30k',
  ]);
  assert.equal(formatCount(undefined), '–');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
  assert.equal(ageText('2026-10-16T19:59:30Z', NOW), '30s ago');
  assert.equal(ageText('2026-10-16T19:56:00Z', NOW), '4m ago');
  assert.equal(ageText('2026-10-16T17:00:00Z', NOW), '3h ago');
  assert.equal(ageText(null, NOW), '');
});

test('the quota line names each paid budget', () => {
  assert.equal(
    quotaLine(status, streetview),
    'YouTube 318 / 1500 units today · Windy 12 / 60 req/min · Street View 1331 / 3000',
  );
  assert.equal(
    quotaLine(
      {
        ...status,
        dynamic: [{ name: 'windy', enabled: true, configured: false }],
      },
      null,
    ),
    'YouTube 318 / 1500 units today',
  );
  assert.equal(quotaLine(null, null), '');
});

test('one row per source, with its counts, age and last error', () => {
  const rows = sourceRows(status, streetview, NOW);
  assert.deepEqual(
    rows.map((r) => [r.label, r.counts, r.age, r.error, r.state]),
    [
      ['MDOT', '519 indexed · 300 on map', '4m ago', null, 'ok'],
      ['OPENCCTV', '28k indexed · 1.7k folded', '4m ago', null, 'ok'],
      ['VEGVESEN', '0 indexed · 0 on map', '', 'empty', 'error'],
      ['WINDY', '4 areas cached · 80 cams', '', null, 'ok'],
      [
        'OPENCCTV FILE',
        '30k cams · checked 61 live / 5 dead',
        '3h ago',
        null,
        'ok',
      ],
      ['YOUTUBE', '41 listed · 16 live · 14 pending', '', null, 'ok'],
      ['AUDIO', '2 sound · 9 silent · 1 likely · 0 ?', '', null, 'ok'],
      ['FRAME CACHE', '120 frames · 12 MB · 75% hits', '', null, 'ok'],
      ['STREET VIEW', '40 places · 212 panos', '', null, 'ok'],
    ],
  );
  const offline = sourceRows(
    { dynamic: [{ name: 'windy', enabled: true, configured: false }] },
    {
      configured: false,
      reason: 'no-key',
      message: 'No Google server key',
      counts: { places: 0, panos: 0 },
    },
    NOW,
  );
  assert.deepEqual(
    offline.map((r) => [r.label, r.counts, r.error, r.state]),
    [
      ['WINDY', 'no key', null, 'off'],
      ['STREET VIEW', '0 places · 0 panos', 'No Google server key', 'off'],
    ],
  );
  assert.deepEqual(sourceRows(null, null, NOW), []);
});
