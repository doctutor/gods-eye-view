// Personal fork: featured cams aboard a ship, pinned at its position fix
// (server/providers/cctv/vessels.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  VESSEL_MAX_FIX_AGE_MS,
  VESSEL_POLL_MS,
  VESSEL_RETRY_MS,
  VESSEL_TRACKERS,
  createVesselTracker,
  parseVesselFix,
} from '../../server/providers/cctv/vessels.js';
import {
  featuredToSource,
  parseFeaturedCatalog,
  readFeaturedCatalog,
} from '../../server/providers/cctv/featured.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { embedMetaText, vesselFixText } from '../ui/cctvEmbed.js';
import { plainCameraSummary } from '../ui/cctvPanelKind.js';

const FIXTURE = JSON.parse(
  await fs.readFile(
    new URL('./fixtures/noaa-okeanos-explorer-position.json', import.meta.url),
    'utf8',
  ),
);
const FIX_AT = Date.parse('2026-10-18T08:54:57Z');

test('the NOAA position stream parses to one fix: where, when, course and speed', () => {
  assert.deepEqual(parseVesselFix(FIXTURE), {
    lat: 19.42035,
    lon: -159.30852,
    at: FIX_AT,
    courseDeg: 31.8,
    speedKn: 7,
    inPort: false,
    cruiseId: 'EX2607',
  });
  // The newest of several; implausible rows are dropped.
  const older = structuredClone(FIXTURE.features[0]);
  older.attributes.dateTime = FIX_AT - 3_600_000;
  older.attributes.lat = 18;
  const nowhere = structuredClone(FIXTURE.features[0]);
  nowhere.attributes.lat = 0;
  nowhere.attributes.lon = 0;
  nowhere.attributes.dateTime = FIX_AT + 1;
  assert.equal(
    parseVesselFix({ features: [older, FIXTURE.features[0], nowhere] }).at,
    FIX_AT,
  );
  assert.equal(parseVesselFix({ error: { code: 400 } }), null);
  assert.equal(
    VESSEL_TRACKERS['okeanos-explorer'].url.startsWith(
      'https://services2.arcgis.com/',
    ),
    true,
  );
});

test('the tracker asks once per 10 minutes, keeps the last fix through a failure, and drops a stale one', async () => {
  let clock = FIX_AT + 60_000;
  const urls = [];
  let fail = false;
  const tracker = createVesselTracker({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(url);
      if (fail) throw new Error('offline');
      return Response.json(FIXTURE);
    },
  });
  const fix = await tracker.fixFor('okeanos-explorer');
  assert.deepEqual(
    [fix.lat, fix.lon, fix.vesselName],
    [19.42035, -159.30852, 'NOAA Ship Okeanos Explorer'],
  );
  const asked = new URL(urls[0]);
  assert.equal(asked.searchParams.get('f'), 'json');
  assert.equal(asked.searchParams.get('outSR'), '4326');
  // Concurrent and repeated asks inside the window share one request.
  await Promise.all([
    tracker.fixFor('okeanos-explorer'),
    tracker.fixFor('okeanos-explorer'),
  ]);
  clock += VESSEL_POLL_MS - 1;
  await tracker.fixFor('okeanos-explorer');
  assert.equal(urls.length, 1);
  // Past the window: asked again; a failure keeps the last fix.
  clock += 2;
  fail = true;
  assert.equal((await tracker.fixFor('okeanos-explorer')).at, FIX_AT);
  assert.equal(urls.length, 2);
  // A fix older than a day places nothing.
  clock = FIX_AT + VESSEL_MAX_FIX_AGE_MS + 1;
  assert.equal(await tracker.fixFor('okeanos-explorer'), null);
  assert.equal(await tracker.fixFor('no-such-ship'), null);
  assert.equal(urls.length, 3);
});

test('a failed first ask is retried after a minute, not ten', async () => {
  let clock = FIX_AT + 60_000;
  let fail = true;
  let asks = 0;
  const tracker = createVesselTracker({
    now: () => clock,
    fetchImpl: async () => {
      asks++;
      if (fail) throw new Error('offline');
      return Response.json(FIXTURE);
    },
  });
  assert.equal(await tracker.fixFor('okeanos-explorer'), null);
  clock += VESSEL_RETRY_MS - 1;
  assert.equal(await tracker.fixFor('okeanos-explorer'), null);
  assert.equal(asks, 1, 'inside the retry window nothing is asked');
  clock += 2;
  fail = false;
  assert.equal((await tracker.fixFor('okeanos-explorer')).at, FIX_AT);
  assert.equal(asks, 2);
  // With a fix held, the full poll window applies again.
  clock += VESSEL_RETRY_MS + 1;
  await tracker.fixFor('okeanos-explorer');
  assert.equal(asks, 2);
});

const shipEntry = (fields = {}) =>
  parseFeaturedCatalog({
    cams: [
      {
        id: 'okeanos-explorer-camera-1',
        name: 'NOAA Ship Okeanos Explorer, camera 1',
        place: 'NOAA Ship Okeanos Explorer (at sea)',
        category: 'marine',
        placement: 'vessel',
        vessel: 'okeanos-explorer',
        coordinatesQuality: 'site',
        operator: 'NOAA Ocean Exploration',
        youtube: {
          videoId: 'EZZDZtCitH8',
          channelId: 'UCe_3CoEeinvPMze2u_aENBg',
          titleMatch: ['camera 1:', '(ex'],
        },
        ...fields,
      },
    ],
  });

test('a cam aboard is pinned at the fix, marked as moving, and left out without one', () => {
  const [entry] = shipEntry();
  assert.equal(entry.placement, 'vessel');
  assert.ok(Number.isNaN(entry.lat), 'its own lat/lon is not used');
  assert.deepEqual(shipEntry({ vessel: 'unknown-ship' }), []);
  const resolved = { videoId: 'EZZDZtCitH8', status: 'live' };
  assert.equal(featuredToSource(entry, resolved, null), null);
  const fix = {
    ...parseVesselFix(FIXTURE),
    vesselId: 'okeanos-explorer',
    vesselName: 'NOAA Ship Okeanos Explorer',
  };
  const source = featuredToSource(entry, resolved, fix);
  assert.deepEqual(
    [source.lat, source.lon, source.coordinatesQuality, source.moving],
    [19.42035, -159.30852, 'vessel', true],
  );
  // Through the server's normalizer, as the client receives it.
  const normalized = normalizeSourceItem(source);
  assert.deepEqual(normalized.vessel, {
    id: 'okeanos-explorer',
    name: 'NOAA Ship Okeanos Explorer',
    fixAt: '2026-10-18T08:54:57.000Z',
    courseDeg: 31.8,
    speedKn: 7,
    inPort: false,
  });
  assert.equal(normalized.moving, true);
  // A fixed cam's shape is unchanged.
  assert.equal(
    normalizeSourceItem({ ...source, moving: false }).vessel,
    undefined,
  );
  // The panel's meta line says when the ship was last fixed.
  const camera = {
    ...normalized,
    city: normalized.city,
    provider: 'NOAA Ocean Exploration',
  };
  assert.equal(vesselFixText(camera), 'SHIP FIX 2026-10-18 08:54 UTC');
  assert.equal(
    embedMetaText(camera),
    'NOAA Ship Okeanos Explorer (at sea) · MARINE · SHIP FIX 2026-10-18 08:54 UTC · NOAA Ocean Exploration',
  );
  assert.equal(
    vesselFixText({ ...camera, vessel: { ...camera.vessel, inPort: true } }),
    'SHIP FIX 2026-10-18 08:54 UTC · IN PORT',
  );
  assert.match(
    plainCameraSummary(camera, FIX_AT) || '',
    /ship's last position fix/,
  );
});

test('the shipped list carries the two Okeanos Explorer cams as vessel placements', () => {
  const ships = readFeaturedCatalog().filter(
    (entry) => entry.placement === 'vessel',
  );
  // The featured-cam pack rotates the YouTube ids as NOAA's live streams
  // change (an atomic rewrite of live-cams.json), so the ids aren't pinned:
  // only the placement, the vessel and the presence of a stream are.
  assert.deepEqual(
    ships.map((entry) => [entry.id, entry.vessel]),
    [
      ['okeanos-explorer-camera-1', 'okeanos-explorer'],
      ['okeanos-explorer-camera-3', 'okeanos-explorer'],
    ],
  );
  for (const entry of ships)
    assert.match(entry.youtube?.videoId || '', /^[A-Za-z0-9_-]{11}$/);
});
