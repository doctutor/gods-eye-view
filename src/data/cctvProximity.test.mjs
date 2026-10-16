import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEAR_MAX_LIMIT,
  NEAR_MAX_RADIUS_KM,
  nearSources,
} from '../../server/providers/cctv/catalog.js';
import { prioritizeSources } from '../../server/providers/cctv/normalize.js';
import {
  PROXIMITY_WORKING_SET,
  needsRefetch,
  proximityRadiusKm,
  recordsToEvict,
} from '../layers/cctv/proximity.js';

const BALTIMORE = { lat: 39.2904, lon: -76.6122 };
const at = (id, lat, lon, extra = {}) => ({ id, lat, lon, ...extra });

test('near returns cameras inside the radius, nearest first', () => {
  const sources = [
    at('far', 39.9526, -75.1652), // Philadelphia, ~145 km
    at('mid', 39.33, -76.6122),
    at('close', 39.2914, -76.6122),
  ];
  assert.deepEqual(
    nearSources(sources, BALTIMORE.lat, BALTIMORE.lon, { radiusKm: 25 }).map(
      (s) => s.id,
    ),
    ['close', 'mid'],
  );
});

test('a featured stream outranks a closer traffic camera when the limit binds', () => {
  const sources = [
    at('traffic', 39.2914, -76.6122), // ~0.1 km
    at('falcons', 39.2934, -76.6122, { embed: { provider: 'youtube' } }), // ~0.33 km
  ];
  assert.deepEqual(
    nearSources(sources, BALTIMORE.lat, BALTIMORE.lon, { limit: 1 }).map(
      (s) => s.id,
    ),
    ['falcons'],
  );
});

test('near clamps its bounds and refuses a bad point', () => {
  const many = Array.from({ length: NEAR_MAX_LIMIT + 50 }, (_, i) =>
    at(`c${i}`, BALTIMORE.lat, BALTIMORE.lon),
  );
  assert.equal(
    nearSources(many, BALTIMORE.lat, BALTIMORE.lon, { limit: 10_000 }).length,
    NEAR_MAX_LIMIT,
  );
  const london = [at('london', 51.5074, -0.1278)];
  assert.deepEqual(
    nearSources(london, BALTIMORE.lat, BALTIMORE.lon, { radiusKm: 1e9 }),
    [],
    `radius is capped at ${NEAR_MAX_RADIUS_KM} km`,
  );
  assert.deepEqual(nearSources(many, NaN, 0), []);
  assert.deepEqual(nearSources(many, 91, 0), []);
});

test('a capped pack still offers every camera to the proximity index', () => {
  const cameras = Array.from({ length: 10 }, (_, i) =>
    at(`c${i}`, 39 + i * 0.1, -76.6),
  );
  const kept = prioritizeSources(cameras, 3, [{ lat: 39, lon: -76.6 }]);
  assert.equal(kept.length, 3);
  assert.equal(kept.everything.length, 10);
  assert.deepEqual(Object.keys(kept), ['0', '1', '2'], 'not enumerable');
});

test('the search radius follows altitude within neighbourhood-to-region bounds', () => {
  assert.equal(proximityRadiusKm(500), 3);
  assert.equal(proximityRadiusKm(20_000), 30);
  assert.equal(proximityRadiusKm(1_000_000), 200);
  assert.equal(proximityRadiusKm(NaN), 3);
});

test('a refetch happens only after a real move or zoom', () => {
  const last = { ...BALTIMORE, radiusKm: 30 };
  assert.equal(needsRefetch(null, last), true);
  assert.equal(needsRefetch(last, { ...last, lat: last.lat + 0.01 }), false);
  assert.equal(needsRefetch(last, { ...last, lat: last.lat + 0.2 }), true);
  assert.equal(needsRefetch(last, { ...last, radiusKm: 10 }), true);
  assert.equal(needsRefetch(last, { ...last, radiusKm: 70 }), true);
  assert.equal(needsRefetch(last, { ...last, radiusKm: 40 }), false);
});

test('only the farthest cameras beyond the working set are dropped', () => {
  const record = (id, lat) => ({ camera: { id, lat, lon: BALTIMORE.lon } });
  const records = [record('near', 39.3), record('far', 45), record('mid', 41)];
  assert.deepEqual(recordsToEvict(records, BALTIMORE, 3), []);
  assert.deepEqual(
    recordsToEvict(records, BALTIMORE, 1).map((r) => r.camera.id),
    ['far', 'mid'],
  );
  assert.ok(PROXIMITY_WORKING_SET >= 1000);
});
