import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BALTIMORE_CAMERA_SETS,
  fetchCameraSet,
  parseCameraCollection,
} from './source.js';
import { cameraSetNote } from './index.js';

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
  const result = await fetchCameraSet('enforcement', { fetchImpl });
  assert.equal(requested.length, BALTIMORE_CAMERA_SETS.enforcement.urls.length);
  for (const url of requested) {
    assert.equal(url.searchParams.get('f'), 'geojson');
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.ok(url.pathname.endsWith('/query'));
  }
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(result.loaded, 4);
});

const enforcementPoint = (id) =>
  point(-76.5734, 39.3219, {
    GIS_ID: id,
    CamType: 'Red Light Camera',
    Location: `Camera ${id}`,
  });

/** A fetch answering each layer by its URL's position in the set. */
function layerFetch(answers) {
  const calls = [];
  const urls = BALTIMORE_CAMERA_SETS.enforcement.urls;
  const fetchImpl = async (url) => {
    const index = urls.findIndex((base) => url.startsWith(`${base}/query`));
    calls.push(index);
    const queue = answers[index];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next();
  };
  return { fetchImpl, calls };
}

test('a layer that fails once is asked again and its records kept', async () => {
  const { fetchImpl, calls } = layerFetch([
    [
      () => new Response('busy', { status: 503 }),
      () => Response.json({ features: [enforcementPoint(1)] }),
    ],
    [
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json({ features: [enforcementPoint(2)] }),
    ],
    [
      () => Response.json({ error: { message: 'Timed out' } }),
      () => Response.json({ features: [enforcementPoint(3)] }),
    ],
    [
      () => new Response('slow down', { status: 429 }),
      () => Response.json({ features: [enforcementPoint(4)] }),
    ],
  ]);
  const result = await fetchCameraSet('enforcement', {
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.deepEqual(result.records.map((r) => r.id).sort(), [
    'atves-1',
    'atves-2',
    'atves-3',
    'atves-4',
  ]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(calls.sort(), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('a failed layer leaves the others: the set loads, saying what is missing', async () => {
  const { fetchImpl, calls } = layerFetch([
    [
      () =>
        Response.json({ features: [enforcementPoint(1), enforcementPoint(1)] }),
    ],
    [() => Response.json({ features: [enforcementPoint(2)] })],
    [() => new Response('down', { status: 502 })],
    [() => Response.json({ features: [enforcementPoint(4)] })],
  ]);
  const result = await fetchCameraSet('enforcement', {
    fetchImpl,
    retryDelayMs: 0,
  });
  // Deduped by record id.
  assert.deepEqual(result.records.map((r) => r.id).sort(), [
    'atves-1',
    'atves-2',
    'atves-4',
  ]);
  assert.deepEqual(result.failed, ['portable speed cameras']);
  assert.equal(result.loaded, 3);
  assert.equal(result.total, 4);
  // The failing layer was tried twice; the others once.
  assert.equal(calls.filter((i) => i === 2).length, 2);
  assert.equal(
    cameraSetNote(result),
    '3 of 4 sets loaded; portable speed cameras unavailable',
  );
  assert.equal(cameraSetNote({ ...result, failed: [], loaded: 4 }), '');
});

test('when every layer fails, the set fails cleanly', async () => {
  await assert.rejects(
    fetchCameraSet('citiwatch', {
      fetchImpl: async () => new Response('nope', { status: 503 }),
      retryDelayMs: 0,
    }),
    /503/,
  );
  await assert.rejects(
    fetchCameraSet('citiwatch', {
      fetchImpl: async () =>
        Response.json({ error: { message: 'Invalid query' } }),
      retryDelayMs: 0,
    }),
    /Invalid query/,
  );
  await assert.rejects(fetchCameraSet('nope'), TypeError);
});

test('a 4xx other than 429 is not asked again', async () => {
  let calls = 0;
  await assert.rejects(
    fetchCameraSet('citiwatch', {
      fetchImpl: async () => {
        calls += 1;
        return new Response('gone', { status: 404 });
      },
      retryDelayMs: 0,
    }),
    /404/,
  );
  assert.equal(calls, 1);
});

test('an abort is not retried and fails the set', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = fetchCameraSet('citiwatch', {
    signal: controller.signal,
    retryDelayMs: 10_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response('busy', { status: 503 });
    },
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending);
  assert.equal(calls, 1);
});
