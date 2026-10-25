// Personal fork: a clicked reach named live from the local Overpass
// (server/providers/riverNames/live.js): which waterway follows the reach
// (parallel against crossing, two at a confluence, none in range), the
// query, and a failed or slow Overpass. RIVER_NAMES_LIVE=1 adds the five
// Baltimore reaches against the local Overpass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  LIVE_TIMEOUT_MS,
  chooseWaterway,
  createLiveRiverNames,
  liveNameQuery,
  liveToleranceM,
} from './live.js';

// A reach running east along 39.30° N for about 4.3 km, stepped like v1's grid.
const REACH = [
  [-76.7, 39.3],
  [-76.68333, 39.3],
  [-76.67917, 39.30417],
  [-76.65, 39.30417],
];
/** An Overpass way: a name and [lon, lat] points. */
const way = (name, points, tags = {}) => ({
  type: 'way',
  id: Math.floor(Math.random() * 1e9),
  tags: { waterway: 'stream', name, ...tags },
  geometry: points.map(([lon, lat]) => ({ lat, lon })),
});
/** A line beside the reach, `dLat` degrees north of it (0.001° ≈ 111 m). */
const beside = (dLat, from = -76.701, to = -76.649) => [
  [from, 39.3 + dLat],
  [-76.68, 39.3 + dLat],
  [-76.679, 39.30417 + dLat],
  [to, 39.30417 + dLat],
];

test('the waterway that runs along the reach names it; one crossing it does not', () => {
  const along = way('Gwynns Falls', beside(0.0008)); // ≈ 90 m off
  const crossing = way('Dead Run', [
    [-76.67, 39.29],
    [-76.67, 39.32],
  ]);
  const chosen = chooseWaterway(REACH, [crossing, along], { toleranceM: 250 });
  assert.equal(chosen.name, 'Gwynns Falls');
  assert.ok(chosen.coverage > 0.9);
  assert.ok(chosen.distanceM > 60 && chosen.distanceM < 120);
  // The crossing stream alone is near at one point, across: no name.
  assert.equal(chooseWaterway(REACH, [crossing], { toleranceM: 250 }), null);
});

test('at a confluence the river the reach follows wins over the tributary joining it', () => {
  // The tributary comes in from the north and runs beside the reach's last
  // kilometre (as Gwynns Run does Gwynns Falls).
  const main = way('Gwynns Falls', beside(-0.0006));
  const tributary = way('Gwynns Run', [
    [-76.66, 39.33],
    [-76.66, 39.3055],
    [-76.649, 39.3055],
  ]);
  const chosen = chooseWaterway(REACH, [tributary, main], { toleranceM: 250 });
  assert.equal(chosen.name, 'Gwynns Falls');
  // Ways of one river are one name, with or without its Wikidata item.
  const split = [
    way('Jones Falls', beside(0.0005, -76.701, -76.68), {
      wikidata: 'Q14692074',
    }),
    way('Jones Falls', beside(0.0005, -76.68, -76.649)),
    way('Stony Run', beside(0.0012, -76.66, -76.649)),
  ];
  const jones = chooseWaterway(REACH, split, { toleranceM: 250 });
  assert.equal(jones.name, 'Jones Falls');
  assert.equal(jones.wikidata, 'Q14692074');
  assert.ok(jones.coverage > 0.9);
});

test('nothing in range, too little of the reach, or no ways: no name', () => {
  assert.equal(
    chooseWaterway(REACH, [way('Far Creek', beside(0.004))], {
      toleranceM: 250,
    }),
    null,
  );
  // A stream beside only the first fifth of the reach.
  assert.equal(
    chooseWaterway(
      REACH,
      [
        way('Short Run', [
          [-76.7, 39.3008],
          [-76.691, 39.3008],
        ]),
      ],
      { toleranceM: 250 },
    ),
    null,
  );
  assert.equal(chooseWaterway(REACH, [], { toleranceM: 250 }), null);
  assert.equal(
    chooseWaterway(REACH, [way('', beside(0.0005))], { toleranceM: 250 }),
    null,
  );
  // The big rivers get a wider tolerance (v1's lines sit further off).
  assert.equal(liveToleranceM(2), 2000);
  assert.equal(liveToleranceM(3), 1500);
  assert.equal(liveToleranceM(4), 700);
  assert.equal(liveToleranceM(5), 400);
  assert.equal(liveToleranceM(6), 250);
  assert.equal(liveToleranceM(undefined), 250);
});

test('the query follows the reach’s line: around it, named rivers, streams and canals', () => {
  const long = Array.from({ length: 200 }, (_, i) => [
    -76.7 + i * 0.0002,
    39.3,
  ]);
  const text = liveNameQuery(long, 250);
  assert.match(
    text,
    /^\[out:json\]\[timeout:10\];way\(around:250,39\.30000,-76\.70000,/,
  );
  assert.match(
    text,
    /\)\["waterway"~"\^\(river\|stream\|canal\)\$"\]\["name"\];out tags geom;$/,
  );
  // Thinned to about 40 points, the last kept.
  const points = /around:250,([^)]*)\)/.exec(text)[1].split(',').length / 2;
  assert.ok(points <= 41 && points >= 30, String(points));
  assert.match(text, /39\.30000,-76\.66020\)/);
});

const overpassAnswer = (elements) => ({
  status: 200,
  body: JSON.stringify({ elements }),
});
const reachOf = (coordinates, RIV_ORD = 6) => ({
  id: 1,
  properties: { RIV_ORD },
  geometry: { type: 'LineString', coordinates },
});

test('the lookup: a name, none, a failed or slow Overpass (nothing shown, never an error)', async () => {
  const asked = [];
  const named = createLiveRiverNames({
    fetchPayload: async (body, bytes, options) => {
      asked.push({ body, options });
      return overpassAnswer([way('Patapsco River', beside(0.0005))]);
    },
  });
  assert.deepEqual(await named.name(reachOf(REACH, 5)), {
    status: 'named',
    osmName: {
      name: 'Patapsco River',
      coverage: 1,
      distanceM: 57,
      confidence: 'live',
    },
  });
  assert.equal(asked.length, 1, 'one request');
  assert.match(
    decodeURIComponent(asked[0].body),
    /around:400,/,
    'RIV_ORD 5 is a mid-size river',
  );
  // The transport's own wait is cut to the click's.
  assert.equal(typeof asked[0].options.fetchImpl, 'function');
  assert.equal(LIVE_TIMEOUT_MS, 10_000);

  const none = createLiveRiverNames({
    fetchPayload: async () => overpassAnswer([]),
  });
  assert.deepEqual(await none.name(reachOf(REACH)), { status: 'none' });

  for (const failure of [
    async () => ({ status: 503, body: '{}' }),
    async () => ({ status: 200, body: '{}', runtimeError: true }),
    async () => ({ status: 429, rateLimited: true, body: '' }),
    async () => ({ status: 200, body: 'not json' }),
    async () => {
      throw new Error('ECONNREFUSED');
    },
  ])
    assert.deepEqual(
      await createLiveRiverNames({ fetchPayload: failure }).name(
        reachOf(REACH),
      ),
      { status: 'failed' },
    );

  // An Overpass that never answers: failed after the timeout.
  const started = Date.now();
  const slow = createLiveRiverNames({
    fetchPayload: () => new Promise(() => {}),
    timeoutMs: 40,
  });
  assert.deepEqual(await slow.name(reachOf(REACH)), { status: 'failed' });
  assert.ok(Date.now() - started < 2000);
  // The timeout reaches the request itself too.
  let signal = null;
  const cut = createLiveRiverNames({
    timeoutMs: 30,
    fetchImpl: (url, init) => {
      signal = init.signal;
      return new Promise((_, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        ),
      );
    },
    fetchPayload: (body, bytes, { fetchImpl }) =>
      fetchImpl('http://localhost:12345/api/interpreter', { body }).then(() =>
        overpassAnswer([]),
      ),
  });
  assert.deepEqual(await cut.name(reachOf(REACH)), { status: 'failed' });
  assert.equal(signal.aborted, true);
  // A reach without a line asks nothing.
  assert.deepEqual(await none.name({ id: 2, properties: {} }), {
    status: 'none',
  });
});

const MAIN_CACHE = 'C:/Users/nospa/Desktop/godseye/.gev-cache/rivers/reach';
test(
  'live: the five Baltimore reaches by name from the local Overpass (RIVER_NAMES_LIVE=1)',
  { skip: process.env.RIVER_NAMES_LIVE !== '1' },
  async () => {
    const live = createLiveRiverNames();
    const expected = {
      7617971: 'Gwynns Falls',
      7619123: 'Patapsco River',
      7617765: 'Jones Falls',
      7617526: 'Gwynns Falls',
      7616599: 'Gwynns Falls',
    };
    const dir = process.env.RIVER_REACH_CACHE || MAIN_CACHE;
    for (const [id, name] of Object.entries(expected)) {
      const { reach } = JSON.parse(
        fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'),
      );
      const found = await live.name(reach);
      assert.equal(found.status, 'named', `${id}: ${found.status}`);
      assert.equal(found.osmName.name, name, String(id));
    }
  },
);
