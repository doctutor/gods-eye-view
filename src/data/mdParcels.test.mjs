// Personal fork: Maryland's parcels for the Custom cutouts (src/data/mdParcels.js):
// the upstream query (only the four fields), the answer's rings, the state's
// box, and the source key with its space and letters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MD_PARCEL_FIELDS,
  inMaryland,
  parcelKeyQuery,
  parcelName,
  parcelPointQuery,
  parcelSourceKey,
  parcelsFromGeoJson,
  parseParcelSourceKey,
} from './mdParcels.js';
import {
  CUTOUT_SOURCE_PATTERNS,
  addCutout,
  decodeCutouts,
  encodeCutouts,
  isCutoutSource,
  simplifyRings,
} from './customCutouts.js';

/** MD iMAP's answer at 6204 Sycamore Rd (2026-10-23), the acceptance case. */
const SYCAMORE = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/md-parcel-6204-sycamore.json', import.meta.url),
    'utf8',
  ),
);

test('the upstream query asks for exactly the four fields, as GeoJSON in WGS 84', () => {
  const point = new URLSearchParams(parcelPointQuery(39.3699327, -76.6131013));
  assert.equal(point.get('outFields'), 'ACCTID,ADDRESS,ACRES,JURSCODE');
  assert.deepEqual(MD_PARCEL_FIELDS, [
    'ACCTID',
    'ADDRESS',
    'ACRES',
    'JURSCODE',
  ]);
  assert.equal(point.get('geometry'), '-76.6131013,39.3699327');
  assert.equal(point.get('geometryType'), 'esriGeometryPoint');
  assert.equal(point.get('inSR'), '4326');
  assert.equal(point.get('outSR'), '4326');
  assert.equal(point.get('spatialRel'), 'esriSpatialRelIntersects');
  assert.equal(point.get('f'), 'geojson');
  const byKey = new URLSearchParams(parcelKeyQuery('BACI', '0327665082 008A'));
  assert.equal(
    byKey.get('where'),
    "JURSCODE='BACI' AND ACCTID='0327665082 008A'",
  );
  assert.equal(byKey.get('outFields'), 'ACCTID,ADDRESS,ACRES,JURSCODE');
  // Never owners' fields, never everything.
  for (const query of [point, byKey]) {
    assert.doesNotMatch(query.toString(), /OWN|\*/);
  }
  // The key is checked before it reaches a where clause.
  assert.throws(() => parcelKeyQuery('BACI', "1' OR '1'='1"));
  assert.throws(() => parcelKeyQuery('baci', '1'));
});

test('answers become rings: a Polygon, a MultiPolygon, an empty answer, an error', () => {
  const [parcel] = parcelsFromGeoJson(SYCAMORE);
  assert.deepEqual(
    { ...parcel, rings: parcel.rings.map((ring) => ring.length) },
    {
      acctid: '0327665082 008A',
      jurscode: 'BACI',
      address: '6204 SYCAMORE RD',
      acres: 1.33,
      rings: [11],
    },
  );
  // 11 vertices pass the budget untouched (less the closing repeat).
  assert.equal(simplifyRings(parcel.rings)[0].length, 10);
  // Two parts, one with a hole: one outer ring a part.
  const square = (x, y, d) => [
    [x, y],
    [x + d, y],
    [x + d, y + d],
    [x, y + d],
    [x, y],
  ];
  const multi = parcelsFromGeoJson({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [square(-76.5, 39.2, 0.01), square(-76.499, 39.201, 0.001)],
            [square(-76.4, 39.2, 0.01)],
          ],
        },
        properties: {
          ACCTID: '1234567890',
          ADDRESS: '',
          ACRES: null,
          JURSCODE: 'ANNE',
          OWNNAME1: 'NEVER KEPT',
        },
      },
    ],
  });
  assert.equal(multi.length, 1);
  assert.equal(multi[0].rings.length, 2);
  assert.equal(multi[0].acres, null);
  assert.equal('OWNNAME1' in multi[0], false);
  assert.deepEqual(
    parcelsFromGeoJson({ type: 'FeatureCollection', features: [] }),
    [],
  );
  assert.throws(
    () =>
      parcelsFromGeoJson({ error: { code: 400, message: 'Invalid query' } }),
    /400/,
  );
  assert.throws(() => parcelsFromGeoJson('<html>'), /GeoJSON/);
});

test('Maryland only: the box, with Baltimore in and Washington’s west and Delaware’s east out', () => {
  assert.equal(inMaryland(39.3699327, -76.6131013), true); // Baltimore
  assert.equal(inMaryland(39.64, -79.4), true); // Garrett County
  assert.equal(inMaryland(38.3, -75.1), true); // Ocean City
  assert.equal(inMaryland(40.71, -74.0), false); // New York
  assert.equal(inMaryland(38.9, -77.2), true); // the box takes in DC's edge: MD iMAP answers none there
  assert.equal(inMaryland(Number.NaN, -76.6), false);
});

test('the source key and the URL round-trip an account id with a space and letters', () => {
  const key = parcelSourceKey({ jurscode: 'BACI', acctid: '0327665082 008A' });
  assert.equal(key, 'mdp:BACI-0327665082_008A');
  assert.deepEqual(parseParcelSourceKey(key), {
    jurscode: 'BACI',
    acctid: '0327665082 008A',
  });
  assert.equal(parseParcelSourceKey('mdp:BACI-03 27'), null);
  assert.equal(parseParcelSourceKey('osm:1'), null);
  // The one list both new kinds extend.
  assert.ok(CUTOUT_SOURCE_PATTERNS.length >= 3);
  assert.equal(isCutoutSource(key), true);
  assert.equal(isCutoutSource('mdp:BACI-0327665082 008A'), false);
  const list = addCutout(
    addCutout([], { source: 'osm:133345', name: 'Baltimore' }),
    {
      source: key,
      name: parcelName({
        address: '6204 SYCAMORE RD',
        acctid: '0327665082 008A',
      }),
    },
  );
  assert.equal(list[1].name, '6204 Sycamore Rd');
  const token = encodeCutouts({ plate: 'white', cutouts: list });
  assert.equal(
    token,
    'white~osm:133345*Baltimore~mdp:BACI-0327665082_008A*6204%20Sycamore%20Rd',
  );
  assert.deepEqual(
    decodeCutouts(token).cutouts.map((c) => [c.source, c.name, c.rings]),
    [
      ['osm:133345', 'Baltimore', null],
      ['mdp:BACI-0327665082_008A', '6204 Sycamore Rd', null],
    ],
  );
  assert.equal(
    parcelName({ address: '', acctid: '1234567890' }),
    'Parcel 1234567890',
  );
});
