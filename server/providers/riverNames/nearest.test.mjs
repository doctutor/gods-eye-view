// Personal fork: a point's river name sized by the river (riverNames/index.js
// chooseNearest, nearestRadiusM): a wide river's centreline far off names a
// point on its water, a creek only close by; deltas, braids and confluences;
// a v2 reach before OSM's own line. RIVER_NAMES_SIDECAR=1 checks the spot
// points against the built sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEAREST_MAX_M,
  NEAREST_SEARCH_M,
  chooseNearest,
  createRiverNamesIndex,
  nearestRadiusM,
  riverNamesDir,
} from './index.js';
import { SOURCE } from './namesFile.js';

const reach = (group, d, strahler, source = SOURCE.direct) => ({
  group,
  d,
  source,
  strahler,
});
const osm = (group, d, waterway = 'river') => ({
  group,
  d,
  source: SOURCE.osm,
  strahler: 0,
  waterway,
});

test('the radius grows with the river: 150 m for streams, 2 km for the largest', () => {
  assert.deepEqual(
    [1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(nearestRadiusM),
    [150, 150, 150, 400, 400, 700, 1000, 1000, 1500, 2000, 2000],
  );
  assert.equal(nearestRadiusM(undefined), NEAREST_MAX_M);
  assert.equal(NEAREST_SEARCH_M, 2000);
});

test('a wide river: its centreline 823 m off names the point, not the creek 503 m off (the Rio Negro at Manaus)', () => {
  const chosen = chooseNearest([
    reach(1, 503, 3, SOURCE.inherited), // Igarapé do Quarenta
    reach(2, 823, 9), // Río Negro
    osm(2, 840),
    reach(3, 1244, 1), // Igarapé de Manaus
  ]);
  assert.deepEqual(chosen, {
    group: 2,
    d: 823,
    source: SOURCE.direct,
    strahler: 9,
    radiusM: 1000,
  });
  // A creek's own line still names a point beside it.
  assert.equal(chooseNearest([reach(1, 90, 3), reach(2, 900, 9)]).group, 1);
  // Past every radius: no name.
  assert.equal(chooseNearest([reach(1, 160, 3), reach(2, 1100, 9)]), null);
  assert.equal(chooseNearest([]), null);
});

test('a delta: each distributary names its own water, the nearer for its size winning', () => {
  // On the Paraná de las Palmas (order 7), the Paraná Guazú (10) 2 km off.
  assert.equal(chooseNearest([reach(1, 5, 7), reach(2, 1900, 10)]).group, 1);
  // Mid-channel in a pass the main stem's line might reach: the pass's
  // line 120 m off (order 6: 0.3 of its radius) beats the trunk 1,200 m
  // off (order 11: 0.8 of 1.5 km).
  assert.equal(chooseNearest([reach(1, 120, 6), reach(2, 1200, 11)]).group, 1);
  // Two braids of one order: the nearer.
  assert.equal(chooseNearest([reach(1, 300, 8), reach(2, 250, 8)]).group, 2);
});

test('a confluence: on the main river beside a tributary’s mouth, the main river; on the tributary, the tributary', () => {
  // On the Missouri 300 m from its line, a creek's last reach 100 m off.
  assert.equal(
    chooseNearest([reach(1, 100, 2), reach(2, 300, 9)]).group,
    2,
    '0.30 of 1 km beats 0.67 of 150 m',
  );
  // In the creek, 20 m from it, the Missouri 600 m off.
  assert.equal(chooseNearest([reach(1, 20, 2), reach(2, 600, 9)]).group, 1);
});

test('OSM’s own lines: sized by their name’s v2 reaches nearby, else 400 m for a river and 150 m for the rest; a v2 reach speaks first', () => {
  // The Hudson: OSM's line 522 m, v2's 584 m (order 8: 700 m).
  const hudson = chooseNearest([osm(1, 522), reach(1, 584, 8)]);
  assert.equal(hudson.source, SOURCE.direct);
  assert.equal(hudson.d, 584);
  assert.equal(hudson.radiusM, 700);
  // Only OSM's line within reach: it names the point.
  const only = chooseNearest([osm(1, 300), reach(1, 2500, 8)]);
  assert.equal(only.source, SOURCE.osm);
  // No v2 reach: a river 350 m off names it, a canal 350 m off does not.
  assert.equal(chooseNearest([osm(1, 350, 'river')]).radiusM, 400);
  assert.equal(chooseNearest([osm(1, 350, 'canal')]), null);
  assert.equal(chooseNearest([osm(1, 140, 'canal')]).radiusM, 150);
  // A smaller search caps every radius.
  assert.equal(chooseNearest([reach(1, 600, 9)], { maxM: 500 }), null);
});

const SPOTS = [
  ['Mississippi at St. Louis', 38.625, -90.179, 'Mississippi River'],
  ['Potomac at Georgetown', 38.90506, -77.08775, 'Potomac River'],
  ['Jones Falls', 39.29705, -76.61029, 'Jones Falls'],
  ['Gwynns Falls', 39.2687, -76.6437, 'Gwynns Falls'],
  ['Mississippi at New Orleans', 29.953, -90.056, 'Mississippi River'],
  ['Rio Negro at Manaus', -3.145, -60.025, 'Río Negro'],
  ['Missouri at St. Charles', 38.783, -90.479, 'Missouri River'],
  ['Hudson off Manhattan', 40.759, -74.006, 'Hudson River'],
  [
    'delta: Paraná de las Palmas',
    -34.20881,
    -58.82321,
    'Río Paraná de las Palmas',
  ],
  ['delta: Paraná Guazú', -33.95068, -58.75262, 'Río Paraná Guazú'],
  ['delta: Southwest Pass', 29.04296, -89.31979, 'Southwest Pass'],
  ['delta: South Pass', 29.04585, -89.19641, 'South Pass'],
  ['confluence: the Missouri above it', 38.82543, -90.16506, 'Missouri River'],
  [
    'confluence: the Mississippi above it',
    38.85862,
    -90.13093,
    'Mississippi River',
  ],
];

test(
  'the built sidecar names the spot points, deltas and the confluence (RIVER_NAMES_SIDECAR=1)',
  { skip: process.env.RIVER_NAMES_SIDECAR !== '1' },
  () => {
    const index = createRiverNamesIndex({
      dir: riverNamesDir(
        process.env,
        process.env.RIVER_NAMES_ROOT || 'C:/Users/nospa/Desktop/godseye',
      ),
    });
    try {
      assert.equal(index.status().built, true);
      for (const [label, lat, lon, name] of SPOTS)
        assert.equal(index.nearest({ lat, lon })?.name, name, label);
    } finally {
      index.close();
    }
  },
);
