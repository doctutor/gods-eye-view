// Personal fork: the river names' matching (scripts/rivers/namesMatch.mjs)
// on made-up geometry: which OSM waterway a reach follows, and the names
// carried down the main stem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRiverNames,
  osmiumExtractCommands,
  parseWaterway,
  piecesOf,
} from '../../scripts/rivers/names.mjs';
import { createRiverNamesIndex } from '../../server/providers/riverNames/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_COVERAGE,
  createWayIndex,
  inheritNames,
  localProjector,
  matchReach,
  nameKey,
  sampleLine,
  toleranceForOrder,
} from '../../scripts/rivers/namesMatch.mjs';

const LAT = 40;
const project = localProjector(LAT);
/** Degrees of latitude for a northward offset in metres. */
const north = (m) => m / 110_574;
/** A west–east line at an offset (m) from lat 40, from lon a to lon b. */
const line = (offsetM, a, b, steps = 10) => {
  const coords = [];
  for (let i = 0; i <= steps; i++)
    coords.push(a + ((b - a) * i) / steps, LAT + north(offsetM));
  return coords;
};

test('tolerances by Strahler order, and how names group', () => {
  assert.deepEqual(
    [1, 2, 3, 5, 6, 9].map(toleranceForOrder),
    [30, 30, 100, 100, 250, 250],
  );
  assert.equal(nameKey({ name: 'Big  River', wikidata: '' }), 'n:big river');
  assert.equal(nameKey({ name: 'Big River', wikidata: 'Q1' }), 'Q1');
  assert.equal(nameKey({ name: '' }), '');
  const { samples, length } = sampleLine(line(0, 0, 0.01), project, 15);
  assert.ok(Math.abs(length - 853) < 2, `${length} m`);
  assert.ok(samples.length >= 50 && samples.length <= 60);
});

test('a reach takes the parallel waterway near it, not the one crossing it', () => {
  const index = createWayIndex(
    [
      { group: 0, coords: line(20, -0.001, 0.011) }, // Big River, 20 m north
      { group: 1, coords: [0.005, LAT - north(500), 0.005, LAT + north(500)] }, // a crossing creek
      { group: 2, coords: line(-60, -0.001, 0.011) }, // a side stream, 60 m south
    ],
    { project },
  );
  const reach = line(0, 0, 0.01);
  const small = matchReach(reach, index, { tolerance: toleranceForOrder(2) });
  assert.equal(small.group, 0);
  assert.ok(small.coverage > 0.95);
  assert.ok(Math.abs(small.distance - 20) < 1);
  // Wider (order 3): the side stream is in reach too, the nearer one wins.
  const larger = matchReach(reach, index, { tolerance: toleranceForOrder(3) });
  assert.equal(larger.group, 0);
  // A reach going the other way matches the same (direction is not required).
  const reversed = [];
  for (let i = reach.length - 2; i >= 0; i -= 2)
    reversed.push(reach[i], reach[i + 1]);
  assert.equal(matchReach(reversed, index, { tolerance: 30 }).group, 0);
  // Nothing parallel within the tolerance: no name.
  const far = createWayIndex([{ group: 0, coords: line(80, 0, 0.01) }], {
    project,
  });
  assert.equal(matchReach(reach, far, { tolerance: 30 }), null);
});

test(`a name needs ${MIN_COVERAGE * 100}% of the reach, counted by group across ways`, () => {
  const reach = line(0, 0, 0.01);
  const third = createWayIndex([{ group: 0, coords: line(10, 0, 0.003) }], {
    project,
  });
  assert.equal(matchReach(reach, third, { tolerance: 30 }), null);
  const half = createWayIndex([{ group: 0, coords: line(10, 0, 0.0055) }], {
    project,
  });
  const match = matchReach(reach, half, { tolerance: 30 });
  assert.equal(match.group, 0);
  assert.ok(match.coverage > 0.5 && match.coverage < 0.6);
  // Two ways of one river (the same Wikidata item), each a third: together.
  const split = createWayIndex(
    [
      { group: 7, coords: line(10, 0, 0.0035) },
      { group: 7, coords: line(10, 0.0065, 0.01) },
    ],
    { project },
  );
  assert.equal(matchReach(reach, split, { tolerance: 30 }).group, 7);
});

test('names run down the main stem until the order changes or a name of its own', () => {
  // 0 → 1 → 2 → 3 → 4, and a tributary 5 → 1; 6 → 7 a second stem.
  //   0: "Big" (order 3)   1: order 3   2: order 3, "Other"   3: order 3
  //   4: order 4           5: "Trib" (order 2)   6: "Alone" (3) → 7 (4)
  const down = Int32Array.from([1, 2, 3, 4, -1, 1, 7, -1]);
  const order = Uint8Array.from([3, 3, 3, 3, 4, 2, 3, 4]);
  const upland = Float32Array.from([100, 120, 150, 160, 900, 5, 50, 60]);
  const direct = Int32Array.from([0, -1, 1, -1, -1, 2, 3, -1]);
  const { names, inherited } = inheritNames({ down, order, upland, direct });
  assert.deepEqual([...names], [0, 0, 1, 1, -1, 2, 3, -1]);
  assert.deepEqual([...inherited], [0, 1, 0, 1, 0, 0, 0, 0]);
});

test('where two named stems of one order meet, the larger keeps the name', () => {
  // A (upland 500) and B (upland 50) both run into reach 2, all order 4,
  // listed both ways round.
  const order = Uint8Array.from([4, 4, 4]);
  const first = inheritNames({
    down: Int32Array.from([2, 2, -1]),
    order,
    upland: Float32Array.from([500, 50, 600]),
    direct: Int32Array.from([0, 1, -1]),
  });
  assert.equal(first.names[2], 0);
  const second = inheritNames({
    down: Int32Array.from([2, 2, -1]),
    order,
    upland: Float32Array.from([50, 500, 600]),
    direct: Int32Array.from([1, 0, -1]),
  });
  assert.equal(second.names[2], 0);
});

const feature = (props, coords) =>
  `\x1e${JSON.stringify({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } })}`;
const pairs = (coords) => {
  const out = [];
  for (let k = 0; k < coords.length; k += 2)
    out.push([coords[k], coords[k + 1]]);
  return out;
};

test('the extract runs osmium in the Overpass image, and reads its lines', () => {
  const [filter, exported] = osmiumExtractCommands({
    pbfDir: 'E:/gev-data/osm',
    pbf: 'planet-261012.osm.pbf',
    outDir: 'E:/gev-data/rivers/names',
  });
  assert.deepEqual(filter.slice(0, 6), [
    'docker',
    'run',
    '--rm',
    '-v',
    'E:/gev-data/osm:/osm:ro',
    '-v',
  ]);
  assert.ok(filter.includes('w/waterway=river,stream,canal,drain,ditch'));
  assert.equal(exported.at(-2), '/out/waterways.geojsonseq');
  assert.deepEqual(
    parseWaterway(
      feature(
        {
          name: 'Big River',
          'name:en': 'Big',
          wikidata: 'Q5',
          waterway: 'river',
        },
        [
          [0, 40],
          [1, 40],
        ],
      ),
    ),
    {
      name: 'Big River',
      nameEn: 'Big',
      wikidata: 'Q5',
      waterway: 'river',
      parts: [[0, 40, 1, 40]],
    },
  );
  assert.equal(
    parseWaterway(
      feature({ waterway: 'river' }, [
        [0, 40],
        [1, 40],
      ]),
    ),
    null,
    'unnamed',
  );
  assert.equal(
    parseWaterway(
      feature({ name: 'X', waterway: 'dam' }, [
        [0, 40],
        [1, 40],
      ]),
    ),
    null,
  );
  assert.equal(parseWaterway('not json'), null);
  const pieces = piecesOf(
    Array.from({ length: 200 }, (_, i) => i),
    48,
  );
  assert.equal(pieces[0].length, 96);
  assert.equal(pieces[1][0], pieces[0][94], 'pieces share their ends');
});

test('a build names reaches from OSM, carries them down the stem, and answers clicks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-river-names-'));
  try {
    // A stem 1 → 2 → 3 along lat 40 (Strahler 5, 5, then 6); OSM's "Big
    // River" runs beside reach 1 only. A canal elsewhere has no reach.
    const reaches = [
      {
        id: 1,
        down: 2,
        strahler: 5,
        upland: 5000,
        parts: [Float64Array.from(line(0, 0, 0.01))],
      },
      {
        id: 2,
        down: 3,
        strahler: 5,
        upland: 5100,
        parts: [Float64Array.from(line(0, 0.01, 0.02))],
      },
      {
        id: 3,
        down: -1,
        strahler: 6,
        upland: 9000,
        parts: [Float64Array.from(line(0, 0.02, 0.03))],
      },
    ];
    const waterways = [
      feature(
        { name: 'Big River', wikidata: 'Q5', waterway: 'river' },
        pairs(line(20, -0.001, 0.011)),
      ),
      feature({ name: 'Old Canal', waterway: 'canal' }, [
        [5, 45],
        [5.01, 45],
      ]),
      feature({ waterway: 'stream' }, [
        [0, 40],
        [0.01, 40],
      ]),
    ];
    const manifest = await buildRiverNames({
      waterways,
      regions: [
        {
          name: 'test',
          forEachReach: async (onReach) => {
            for (const reach of reaches) onReach(reach);
          },
        },
      ],
      dir: path.join(dir, 'names'),
      tmpDir: path.join(dir, 'tmp'),
      workers: 1,
    });
    assert.deepEqual(manifest.rates.byOrder, {
      5: { reaches: 2, direct: 1, inherited: 1 },
      6: { reaches: 1, direct: 0, inherited: 0 },
    });
    assert.equal(manifest.rates.namedPercent, 66.7);
    assert.equal(manifest.names.groups, 2);
    assert.equal(fs.existsSync(path.join(dir, 'tmp')), false, 'the spill goes');

    const index = createRiverNamesIndex({ dir: path.join(dir, 'names') });
    assert.equal(index.status().built, true);
    const onTwo = index.nearest({ lat: LAT, lon: 0.015 });
    assert.deepEqual(
      {
        name: onTwo.name,
        wikidata: onTwo.wikidata,
        confidence: onTwo.confidence,
        strahler: onTwo.strahler,
      },
      {
        name: 'Big River',
        wikidata: 'Q5',
        confidence: 'inherited',
        strahler: 5,
      },
    );
    assert.equal(index.nearest({ lat: LAT, lon: 0.005 }).confidence, 'direct');
    // Reach 3 has no name of its own and a new order: no name.
    assert.equal(index.nearest({ lat: LAT, lon: 0.028 }), null);
    // Where no reach is named, the nearest OSM waterway (HydroRIVERS v1's cards).
    const canal = index.nearest({ lat: 45.0005, lon: 5.005 });
    assert.equal(canal.name, 'Old Canal');
    assert.equal(canal.confidence, 'nearest');
    assert.equal(
      index.nearest({ lat: 45.01, lon: 5.005 }),
      null,
      'more than 150 m away',
    );
    const labels = index.labels({ west: -1, south: 39, east: 1, north: 41 });
    assert.deepEqual(
      labels.body.labels.map((l) => [l.name, l.strahler]),
      [['Big River', 5]],
    );
    index.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
