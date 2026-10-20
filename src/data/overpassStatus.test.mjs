// Personal fork: `npm run overpass:status` (scripts/overpass-status.mjs),
// the local Overpass API's status text, the data's age and the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAge,
  parseStatusText,
  summarize,
} from '../../scripts/overpass-status.mjs';

// /api/status as Overpass answers it (overpass-api.de, 2026-10-20).
const STATUS = [
  'Connected as: 1238712214',
  'Current time: 2026-10-20T14:41:53Z',
  'Announced endpoint: none',
  'Rate limit: 8',
  '7 slots available now.',
  'Currently running queries (pid, space limit, time limit, start time):',
  '4242\t536870912\t30\t2026-10-20T14:41:50Z',
  '',
].join('\n');

test('the status text: rate limit, free slots, queries running', () => {
  assert.deepEqual(parseStatusText(STATUS), {
    rateLimit: 8,
    slotsFree: 7,
    running: 1,
  });
  assert.deepEqual(parseStatusText(''), {
    rateLimit: null,
    slotsFree: null,
    running: null,
  });
});

test('ages in words', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.equal(describeAge('2026-10-20T11:48:00Z', now), '12 min');
  assert.equal(describeAge('2026-10-20T07:00:00Z', now), '5 h');
  assert.equal(describeAge('2026-10-12T00:00:00Z', now), '8.5 days');
  assert.equal(describeAge('not a date', now), null);
});

test('the report: answering with its dates, or not answering', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const up = summarize({
    url: 'http://localhost:12345/api',
    status: parseStatusText(STATUS),
    base: '2026-10-20T11:00:00Z',
    areas: null,
    container: { state: 'running', health: 'healthy' },
    now,
  });
  assert.deepEqual(up, [
    'Container gev-overpass: running (healthy)',
    'Overpass at http://localhost:12345/api: answering; data as of 2026-10-20T11:00:00Z (60 min old)',
    '  areas: not built yet (is_in answers nothing until the first rules pass ends)',
    '  rate limit 8, 7 slots free, 1 running',
  ]);
  const down = summarize({
    url: 'http://localhost:12345/api',
    error: 'ECONNREFUSED',
    container: { state: 'running', health: 'starting' },
    lastLog:
      '2026-10-20T11:50:00Z [import] read 40 of 95 GB of the planet (42%)',
    now,
  });
  assert.match(down[1], /not answering \(ECONNREFUSED\)/);
  assert.match(down[2], /42%/);
  assert.match(summarize({ url: 'x', error: 'ECONNREFUSED' })[0], /not found/);
});
