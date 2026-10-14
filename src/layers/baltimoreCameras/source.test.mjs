import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BALTIMORE_CAMERA_SETS,
  fetchCameraSet,
  parseCameraCollection,
} from './source.js';

const point = (lon, lat, properties) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});

test('enforcement records keep kind, colour and school zone', () => {
  const records = parseCameraCollection(
    {
      features: [
        point(-76.5734, 39.3219, {
          GIS_ID: 1001,
          CamType: 'Red Light Camera',
          Location: 'Bel Air Rd & Erdman Ave SB',
        }),
        point(-76.58, 39.3615, {
          GIS_ID: 4029,
          CamType: 'Speed Camera Fixed',
          Location: '6000 Hillen Rd SB and NB',
          SchlLocation: 'Yorkwood  Elementary School',
        }),
      ],
    },
    'enforcement',
  );
  assert.deepEqual(
    records.map((r) => [r.id, r.title, r.kind]),
    [
      ['atves-1001', 'Bel Air Rd & Erdman Ave SB', 'Red-light camera'],
      ['atves-4029', '6000 Hillen Rd SB and NB', 'Speed camera (fixed)'],
    ],
  );
  assert.equal(records[0].color, '#ff4d4d');
  assert.ok(
    records[1].details.includes('School zone: Yorkwood Elementary School'),
  );
});

test('CitiWatch records are labelled as location-only police cameras', () => {
  const [record] = parseCameraCollection(
    {
      features: [
        point(-76.621, 39.2912, {
          CAM_NUMBER: '1',
          CAM_LOCATION: 'Eutaw and Lexington Market',
        }),
      ],
    },
    'citiwatch',
  );
  assert.equal(record.id, 'citiwatch-1');
  assert.equal(record.title, 'Eutaw and Lexington Market');
  assert.ok(record.details.some((line) => /no public video/.test(line)));
});

test('bad geometry, unknown kinds and far-away points are dropped', () => {
  const records = parseCameraCollection(
    {
      features: [
        point(-77.03, 38.9, { GIS_ID: 1, CamType: 'Red Light Camera' }),
        point(-76.6, 39.3, { GIS_ID: 2, CamType: 'Mystery Camera' }),
        point(-76.6, 39.3, { CamType: 'Red Light Camera' }),
        { geometry: null, properties: { GIS_ID: 3 } },
        point('x', 39.3, { GIS_ID: 4, CamType: 'Red Light Camera' }),
      ],
    },
    'enforcement',
  );
  assert.deepEqual(records, []);
  assert.deepEqual(parseCameraCollection(null, 'citiwatch'), []);
});

test('a set fetches every layer as WGS84 GeoJSON and dedupes', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(new URL(url));
    return Response.json({
      features: [
        point(-76.5734, 39.3219, {
          GIS_ID: 1001,
          CamType: 'Red Light Camera',
          Location: 'Bel Air Rd & Erdman Ave SB',
        }),
      ],
    });
  };
  const records = await fetchCameraSet('enforcement', { fetchImpl });
  assert.equal(requested.length, BALTIMORE_CAMERA_SETS.enforcement.urls.length);
  for (const url of requested) {
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.ok(url.pathname.endsWith('/query'));
  }
  assert.equal(records.length, 1);
});

test('a failing layer fails the whole set', async () => {
  await assert.rejects(
    fetchCameraSet('citiwatch', {
      fetchImpl: async () => new Response('nope', { status: 503 }),
    }),
    /503/,
  );
  await assert.rejects(
    fetchCameraSet('citiwatch', {
      fetchImpl: async () =>
        Response.json({ error: { message: 'Invalid query' } }),
    }),
    /Invalid query/,
  );
  await assert.rejects(fetchCameraSet('nope'), TypeError);
});
