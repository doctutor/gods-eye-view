// Personal fork: Blocks buildings (src/layers/blocks/structures.js) and the
// store's structures layer: heights from tags, footprints filled onto the
// column grid (a square, an L, a courtyard, a relation's joined rings),
// one Overpass query per group, applied over the terrain, layered under
// edits, and meshed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_COLUMNS, columnIndex, createRegion } from './grid.js';
import { MATERIALS, NONE, createChunk } from './store.js';
import { buildChunkMesh } from './mesh.js';
import { MATERIAL_COLORS } from './lighting.js';
import { sanitizeOverpassBody } from '../../../server/providers/overpass/query.js';
import { GROUP_COLUMNS, groupBounds } from './source.js';
import {
  BUILDING,
  applyStructures,
  assembleRings,
  buildingHeightBlocks,
  buildingHeightM,
  groupQuery,
  lineHalfWidthM,
  lineWidthM,
  parseFeatures,
  surfaceMaterial,
  surfaceMaterials,
  createStructuresSource,
  fillFootprint,
  parseFootprints,
  parseLengthM,
  buildingMinHeightM,
  structureLevels,
} from './structures.js';
import {
  restoreChunk,
  restoreNeighbour,
  snapshotChunk,
  snapshotNeighbour,
} from './meshJob.js';

const COLUMNS = CHUNK_COLUMNS * CHUNK_COLUMNS;
const ring = (points) => points.map(([x, y]) => ({ x, y }));

/** The filled columns of a size × size grid, as 'i,j'. */
function filled(out, size) {
  const set = [];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) if (out[j * size + i]) set.push(`${i},${j}`);
  return set;
}

test('heights from tags: height in metres or feet, else levels × 3.2 m, else 6.4 m', () => {
  assert.equal(parseLengthM('12'), 12);
  assert.equal(parseLengthM('12.5 m'), 12.5);
  assert.equal(parseLengthM('7,5m'), 7.5);
  assert.ok(Math.abs(parseLengthM('40 ft') - 12.192) < 1e-9);
  assert.ok(Math.abs(parseLengthM(`12'6"`) - 3.81) < 1e-9);
  assert.ok(Number.isNaN(parseLengthM('tall')));
  assert.equal(buildingHeightM({ height: '30', 'building:levels': '3' }), 30);
  assert.ok(Math.abs(buildingHeightM({ 'building:levels': '5' }) - 16) < 1e-9);
  assert.equal(
    buildingHeightM({ height: 'unknown', 'building:levels': '2' }),
    6.4,
  );
  assert.equal(buildingHeightM({ building: 'yes' }), 6.4);
  // In blocks: rounded, at least one.
  assert.equal(buildingHeightBlocks({ height: '30' }, 1), 30);
  assert.equal(buildingHeightBlocks({ 'building:levels': '5' }, 1), 16);
  assert.equal(buildingHeightBlocks({ building: 'yes' }, 2), 3); // 6.4 / 2 = 3.2
  assert.equal(buildingHeightBlocks({ 'building:levels': '5' }, 10), 2); // 1.6
  assert.equal(buildingHeightBlocks({ building: 'shed', height: '2' }, 30), 1);
});

test('fillFootprint: a square takes the columns whose centres are inside', () => {
  const out = new Uint16Array(100);
  const set = fillFootprint(
    [
      ring([
        [2, 1],
        [6, 1],
        [6, 4],
        [2, 4],
      ]),
    ],
    { blockM: 1, i0: 0, j0: 0, size: 10, out, value: 7 },
  );
  // Centres 2.5 … 5.5 east, 1.5 … 3.5 north: 4 × 3.
  assert.equal(set, 12);
  const cols = filled(out, 10);
  assert.deepEqual(cols, [
    '2,1',
    '3,1',
    '4,1',
    '5,1',
    '2,2',
    '3,2',
    '4,2',
    '5,2',
    '2,3',
    '3,3',
    '4,3',
    '5,3',
  ]);
  assert.equal(out[2 * 10 + 3], 7);
  // A taller building over it keeps the higher; a lower one changes nothing.
  fillFootprint(
    [
      ring([
        [3, 1],
        [5, 1],
        [5, 3],
        [3, 3],
      ]),
    ],
    { blockM: 1, i0: 0, j0: 0, size: 10, out, value: 9 },
  );
  assert.equal(out[1 * 10 + 3], 9);
  assert.equal(out[1 * 10 + 2], 7);
  assert.equal(
    fillFootprint(
      [
        ring([
          [2, 1],
          [6, 1],
          [6, 4],
          [2, 4],
        ]),
      ],
      { blockM: 1, i0: 0, j0: 0, size: 10, out, value: 3 },
    ),
    0,
  );
});

test('fillFootprint: an L-shape, a courtyard, blockM and an offset grid', () => {
  const out = new Uint16Array(64);
  const l = ring([
    [0, 0],
    [6, 0],
    [6, 2],
    [2, 2],
    [2, 6],
    [0, 6],
  ]);
  assert.equal(
    fillFootprint([l], { blockM: 1, i0: 0, j0: 0, size: 8, out, value: 1 }),
    12 + 8,
  );
  assert.deepEqual(filled(out, 8), [
    '0,0',
    '1,0',
    '2,0',
    '3,0',
    '4,0',
    '5,0',
    '0,1',
    '1,1',
    '2,1',
    '3,1',
    '4,1',
    '5,1',
    '0,2',
    '1,2',
    '0,3',
    '1,3',
    '0,4',
    '1,4',
    '0,5',
    '1,5',
  ]);
  // A courtyard: the inner ring's columns stay open (even-odd).
  const yard = new Uint16Array(64);
  fillFootprint(
    [
      ring([
        [0, 0],
        [6, 0],
        [6, 6],
        [0, 6],
      ]),
      ring([
        [2, 2],
        [4, 2],
        [4, 4],
        [2, 4],
      ]),
    ],
    { blockM: 1, i0: 0, j0: 0, size: 8, out: yard, value: 1 },
  );
  assert.equal(filled(yard, 8).length, 36 - 4);
  assert.equal(yard[2 * 8 + 2], 0);
  assert.equal(yard[1 * 8 + 1], 1);
  // 2 m blocks over a grid starting at column (10, -4): the same square in
  // metres 20…28 east, -8…-2 north is 4 × 3 columns at (0…3, 0…2).
  const coarse = new Uint16Array(64);
  fillFootprint(
    [
      ring([
        [20, -8],
        [28, -8],
        [28, -2],
        [20, -2],
      ]),
    ],
    {
      blockM: 2,
      i0: 10,
      j0: -4,
      size: 8,
      out: coarse,
      value: 1,
    },
  );
  assert.deepEqual(filled(coarse, 8), [
    '0,0',
    '1,0',
    '2,0',
    '3,0',
    '0,1',
    '1,1',
    '2,1',
    '3,1',
    '0,2',
    '1,2',
    '2,2',
    '3,2',
  ]);
});

test('parseFootprints: ways, and a relation whose split outer ways join into a ring', () => {
  const p = (lat, lon) => ({ lat, lon });
  const elements = [
    {
      type: 'way',
      id: 1,
      tags: { building: 'yes', height: '9' },
      geometry: [p(0, 0), p(0, 1), p(1, 1), p(0, 0)],
    },
    {
      type: 'way',
      id: 2,
      tags: { building: 'yes' },
      geometry: [p(0, 0), p(0, 1)],
    }, // too short
    {
      type: 'relation',
      id: 3,
      tags: {
        type: 'multipolygon',
        building: 'office',
        'building:levels': '4',
      },
      members: [
        { type: 'way', role: 'outer', geometry: [p(0, 0), p(0, 2)] },
        { type: 'way', role: 'outer', geometry: [p(2, 2), p(0, 2)] }, // reversed
        { type: 'way', role: 'outer', geometry: [p(2, 2), p(2, 0), p(0, 0)] },
        {
          type: 'way',
          role: 'inner',
          geometry: [p(0.5, 0.5), p(0.5, 1), p(1, 1), p(0.5, 0.5)],
        },
        { type: 'node', role: 'label' },
      ],
    },
  ];
  const footprints = parseFootprints(elements);
  assert.deepEqual(
    footprints.map((f) => f.id),
    ['way/1', 'relation/3'],
  );
  const rel = footprints[1];
  assert.equal(rel.rings.length, 2);
  const outer = rel.rings[0];
  assert.deepEqual(outer[0], outer[outer.length - 1]);
  assert.equal(outer.length, 5); // four corners, closed
  assert.equal(rel.tags['building:levels'], '4');
  assert.equal(
    assembleRings([
      [p(0, 0), p(0, 1)],
      [p(5, 5), p(6, 6)],
    ]).length,
    0,
  ); // nothing closes
});

test('groupQuery: buildings, parts, land cover, highways and railways in the box', () => {
  const box = { west: -76.62, south: 39.28, east: -76.6, north: 39.3 };
  const ql = groupQuery(box, 1);
  assert.match(ql, /^\[out:json\]\[timeout:25\];/);
  for (const filter of [
    '["natural"~"^(water|wood)$"]',
    '["water"]',
    '["waterway"="riverbank"]',
    '["leisure"~"^(park|pitch|garden)$"]',
  ])
    for (const type of ['way', 'relation'])
      assert.ok(
        ql.includes(`${type}${filter}(39.2800000,`),
        `${type}${filter}`,
      );
  assert.ok(ql.includes('way["highway"](39.2800000,'));
  assert.ok(ql.includes('way["area:highway"](39.2800000,'));
  assert.match(
    ql,
    /way\["railway"~"\^\(rail\|tram\|light_rail\|subway\|narrow_gauge\)\$"\]/,
  );
  assert.doesNotMatch(ql, /if:length/);
  // Coarse blocks: big buildings only, and the highways a block can show.
  const coarse = groupQuery(box, 10);
  assert.ok(
    coarse.includes(
      '(39.2800000,-76.6200000,39.3000000,-76.6000000)(if:length()>=80);',
    ),
  );
  assert.doesNotMatch(coarse, /way\["highway"\]\(/);
  assert.match(coarse, /way\["highway"~"\^\(motorway\|trunk/);
  assert.doesNotMatch(coarse, /footway/);
  // The proxy accepts both.
  for (const q of [ql, coarse])
    assert.equal(
      sanitizeOverpassBody(`data=${encodeURIComponent(q)}`).ok,
      true,
    );
});

test('buildings in the group query: ways and relations tagged building or building:part (not no)', () => {
  const ql = groupQuery({
    west: -76.62,
    south: 39.28,
    east: -76.6,
    north: 39.3,
  });
  assert.match(ql, /^\[out:json\]\[timeout:25\];/);
  assert.match(
    ql,
    /way\["building"\]\["building"!="no"\]\(39\.2800000,-76\.6200000,39\.3000000,-76\.6000000\);/,
  );
  assert.match(ql, /relation\["building"\]\["building"!="no"\]\(39\.2800000,/);
  assert.match(
    ql,
    /way\["building:part"\]\["building:part"!="no"\]\(39\.2800000,/,
  );
  assert.match(
    ql,
    /relation\["building:part"\]\["building:part"!="no"\]\(39\.2800000,/,
  );
  assert.match(ql, /out geom qt;$/);
});

/** A footprint in lon/lat from region metres. */
const footprintAt = (region, tags, points) => ({
  id: 'test',
  tags,
  rings: [points.map(([x, y]) => region.toLonLat(x, y))],
});

/** A square footprint, metres [x0, x1) × [y0, y1). */
const squareAt = (region, tags, x0, y0, x1, y1) =>
  footprintAt(region, tags, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);

/** Group (0, 0)'s ground from a level per region column (i, j). */
const groundOf = (levelAt) => {
  const at = (index) =>
    levelAt(index % GROUP_COLUMNS, Math.floor(index / GROUP_COLUMNS));
  return { terrainTop: at, ground: at };
};

const at = (i, j) => j * GROUP_COLUMNS + i;

test('structureLevels: a footprint from lon/lat lands on its columns, walls down to the ground', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  // 10 × 4 m at 30 m east, 100 m north on flat ground at level 2; 3 storeys.
  const { top, bottom } = structureLevels(
    region,
    0,
    0,
    [squareAt(region, { 'building:levels': '3' }, 30, 100, 40, 104)],
    groundOf(() => 2),
  );
  assert.equal(top.length, GROUP_COLUMNS * GROUP_COLUMNS);
  const set = [...top.keys()].filter((index) => top[index] !== NONE);
  assert.equal(set.length, 40);
  assert.equal(set[0], at(30, 100));
  assert.equal(top[at(30, 100)], 2 + 10); // 9.6 m → 10 blocks
  assert.equal(bottom[at(30, 100)], 3);
  assert.equal(top[at(40, 100)], NONE);
});

test('a sloped square gets a level roof; its walls reach down the slope', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  // The ground rises one level every 2 m east: 10 … 14 under x 20 … 30.
  const { top, bottom } = structureLevels(
    region,
    0,
    0,
    [squareAt(region, { building: 'yes' }, 20, 50, 30, 60)],
    groundOf((i) => Math.floor(i / 2)),
  );
  // Base 14 (the highest ground under it) + 6 blocks (6.4 m).
  for (let i = 20; i < 30; i++) {
    assert.equal(top[at(i, 55)], 20, `roof over column ${i}`);
    assert.equal(bottom[at(i, 55)], Math.floor(i / 2) + 1, `wall foot ${i}`);
  }
  assert.equal(top[at(19, 55)], NONE);
  // Applied to a chunk: every column's top solid level is the roof.
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: Int32Array.from({ length: COLUMNS }, (_, k) =>
      Math.floor((k % 64) / 2),
    ),
  });
  const levels = {
    top: new Int32Array(COLUMNS).fill(NONE),
    bottom: new Int32Array(COLUMNS).fill(NONE),
  };
  for (let i = 20; i < 30; i++) {
    levels.top[columnIndex(i, 55)] = top[at(i, 55)];
    levels.bottom[columnIndex(i, 55)] = bottom[at(i, 55)];
  }
  assert.equal(applyStructures(chunk, levels), 10);
  for (let i = 20; i < 30; i++) {
    assert.equal(chunk.topSolid(i, 55), 20);
    assert.equal(chunk.occupancy(i, 55, Math.floor(i / 2) + 1), BUILDING);
  }
});

test('a part on stilts: min_height lifts its bottom and leaves a hollow under it', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  assert.equal(buildingMinHeightM({ min_height: '8' }), 8);
  assert.ok(
    Math.abs(buildingMinHeightM({ 'building:min_level': '2' }) - 6.4) < 1e-9,
  );
  assert.equal(buildingMinHeightM({}), 0);
  const { top, bottom } = structureLevels(
    region,
    0,
    0,
    [
      squareAt(
        region,
        { 'building:part': 'yes', height: '20', min_height: '8' },
        10,
        10,
        16,
        16,
      ),
    ],
    groundOf(() => 2),
  );
  assert.equal(top[at(12, 12)], 22);
  assert.equal(bottom[at(12, 12)], 11);
  // In the store: air under it, the part from 11 to 22.
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(2),
  });
  chunk.setStructure(12, 12, top[at(12, 12)], BUILDING, bottom[at(12, 12)]);
  assert.equal(chunk.structureBottom(12, 12), 11);
  assert.equal(chunk.occupancy(12, 12, 2), MATERIALS.TERRAIN);
  assert.equal(chunk.occupancy(12, 12, 3), MATERIALS.AIR);
  assert.equal(chunk.occupancy(12, 12, 10), MATERIALS.AIR);
  assert.equal(chunk.occupancy(12, 12, 11), BUILDING);
  assert.equal(chunk.occupancy(12, 12, 22), BUILDING);
  assert.equal(chunk.occupancy(12, 12, 23), MATERIALS.AIR);
  assert.equal(chunk.topSolid(12, 12), 22);
  // Breaking the whole part leaves the terrain, through the hollow.
  for (let y = 11; y <= 22; y++) chunk.setBlock(12, 12, y, MATERIALS.AIR);
  assert.equal(chunk.topSolid(12, 12), 2);
  // A block stacked in the hollow is an edit and shows.
  chunk.setBlock(12, 12, 5, MATERIALS.TERRAIN);
  assert.equal(chunk.topSolid(12, 12), 5);
  // The mesher draws the part's underside.
  const stilts = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(2),
  });
  stilts.setStructure(12, 12, 22, BUILDING, 11);
  const mesh = buildChunkMesh(stilts, { blockM: 1 });
  assert.ok(mesh.stats.down >= 1, 'a face looking down under the part');
  // A min height at or above the height leaves at least one block.
  const thin = structureLevels(
    region,
    0,
    0,
    [squareAt(region, { height: '5', min_height: '9' }, 10, 10, 12, 12)],
    groundOf(() => 0),
  );
  assert.equal(thin.top[at(10, 10)], 5);
  assert.equal(thin.bottom[at(10, 10)], 5);
});

test('parts override the outline where they overlap; overlapping parts unite', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  const footprints = [
    // The building's outline: 20 × 10 m, 10 m tall.
    squareAt(region, { building: 'yes', height: '10' }, 0, 0, 20, 10),
    // A low part over its west half (it still wins there) …
    squareAt(region, { 'building:part': 'yes', height: '4' }, 0, 0, 10, 10),
    // … and a tower on stilts over the east third, overlapping a podium part.
    squareAt(
      region,
      { 'building:part': 'yes', height: '40', min_height: '12' },
      14,
      0,
      20,
      10,
    ),
    squareAt(region, { 'building:part': 'yes', height: '6' }, 12, 0, 20, 10),
  ];
  const { top, bottom } = structureLevels(
    region,
    0,
    0,
    footprints,
    groundOf(() => 0),
  );
  // West half: the low part, not the outline.
  assert.equal(top[at(5, 5)], 4);
  assert.equal(bottom[at(5, 5)], 1);
  // Between the parts (columns 10 and 11): the outline.
  assert.equal(top[at(10, 5)], 10);
  assert.equal(top[at(11, 5)], 10);
  // Podium alone (12, 13).
  assert.equal(top[at(12, 5)], 6);
  // Tower over the podium: one structure from the podium's bottom to the tower's top.
  assert.equal(top[at(16, 5)], 40);
  assert.equal(bottom[at(16, 5)], 1);
  // Outside everything.
  assert.equal(top[at(25, 5)], NONE);
});

test('createStructuresSource: one query and the group ground per group; failures retried', async () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  const queries = [];
  const chunkAsks = [];
  let fail = 1;
  const building = squareAt(region, { building: 'yes', height: '12' }, 70, 10, 80, 20); // chunk (1, 0)
  const query = async (ql) => {
    queries.push(ql);
    if (fail-- > 0) throw new Error('Overpass 504');
    const geometry = building.rings[0];
    return {
      elements: [
        {
          type: 'way',
          id: 9,
          tags: building.tags,
          geometry: [...geometry, geometry[0]],
        },
      ],
    };
  };
  // The ground: level 3 everywhere (the elevation source's chunks).
  const loadChunk = async (r, ci, cj) => {
    chunkAsks.push(`${ci}:${cj}`);
    return createChunk({ ci, cj, top: new Int32Array(COLUMNS).fill(3) });
  };
  assert.throws(() => createStructuresSource({ query }), TypeError);
  const source = createStructuresSource({ query, loadChunk });
  await assert.rejects(source.loadChunkStructures(region, 1, 0), /504/);
  assert.equal(source.size(), 0);
  // Two chunks of one group at once: one query over the group's box, and the group's 16 chunks of ground.
  const [withBuilding, without] = await Promise.all([
    source.loadChunkStructures(region, 1, 0),
    source.loadChunkStructures(region, 3, 2),
  ]);
  assert.equal(queries.length, 2);
  assert.equal(queries[1], groupQuery(groupBounds(region, 0, 0), 1));
  assert.equal(new Set(chunkAsks).size, 16);
  assert.equal(without, null);
  assert.ok(withBuilding.top instanceof Int32Array);
  assert.equal(withBuilding.top.length, COLUMNS);
  // Column 70 east is chunk 1's column 6: ground 3 + 12 blocks.
  assert.equal(withBuilding.top[columnIndex(6, 10)], 15);
  assert.equal(withBuilding.bottom[columnIndex(6, 10)], 4);
  assert.equal(withBuilding.top[columnIndex(16, 10)], NONE);
  // Every chunk of the group is free now; another group asks again.
  for (let ci = 0; ci < 4; ci++)
    for (let cj = 0; cj < 4; cj++)
      await source.loadChunkStructures(region, ci, cj);
  assert.equal(queries.length, 2);
  await source.loadChunkStructures(region, 4, 0);
  assert.equal(queries.length, 3);
});

test('applyStructures: levels into the store, skipping columns without data', () => {
  const top = new Int32Array(COLUMNS).fill(5);
  const water = new Int32Array(COLUMNS).fill(NONE);
  top[columnIndex(2, 0)] = NONE; // no data
  top[columnIndex(3, 0)] = -2; // under the sea
  water[columnIndex(3, 0)] = 0;
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  const levels = {
    top: new Int32Array(COLUMNS).fill(NONE),
    bottom: new Int32Array(COLUMNS).fill(NONE),
  };
  for (const i of [0, 1, 2]) {
    levels.top[columnIndex(i, 0)] = 9;
    levels.bottom[columnIndex(i, 0)] = 6;
  }
  levels.top[columnIndex(3, 0)] = 4; // over the water, walls to the seabed
  levels.bottom[columnIndex(3, 0)] = -1;
  const before = chunk.version;
  assert.equal(applyStructures(chunk, levels), 3);
  assert.ok(chunk.version > before);
  assert.equal(chunk.structureTop(0, 0), 9);
  assert.equal(chunk.structureBottom(0, 0), 6);
  assert.equal(chunk.structureTop(2, 0), NONE);
  assert.equal(chunk.structureTop(3, 0), 4);
  assert.equal(chunk.occupancy(3, 0, 0), BUILDING);
  // Applying again changes nothing.
  const after = chunk.version;
  applyStructures(chunk, levels);
  assert.equal(chunk.version, after);
  assert.equal(applyStructures(chunk, null), 0);
});

test('setStructure bottoms: at least just above the top; a top under the bottom clears', () => {
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(4),
  });
  chunk.setStructure(0, 0, 9, BUILDING, 2); // a bottom inside the ground lifts to 5
  assert.equal(chunk.structureBottom(0, 0), 5);
  chunk.setStructure(0, 0, 9); // the default bottom
  assert.equal(chunk.structureBottom(0, 0), 5);
  const v = chunk.version;
  chunk.setStructure(0, 0, 9, BUILDING, 7); // a new bottom is a change
  assert.ok(chunk.version > v);
  assert.equal(chunk.occupancy(0, 0, 6), MATERIALS.AIR);
  chunk.setStructure(0, 0, 6, BUILDING, 7); // the top under the bottom
  assert.equal(chunk.structureTop(0, 0), NONE);
  assert.equal(chunk.structureBottom(0, 0), NONE);
  assert.throws(() => chunk.setStructure(0, 0, 9, BUILDING, 1.5), RangeError);
});

test('the mesh worker snapshot keeps structure bottoms', () => {
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(1),
  });
  chunk.setStructure(3, 4, 12, BUILDING, 6);
  chunk.setStructure(5, 4, 8);
  const again = restoreChunk(snapshotChunk(chunk));
  assert.equal(again.structureTop(3, 4), 12);
  assert.equal(again.structureBottom(3, 4), 6);
  assert.equal(again.structureBottom(5, 4), 2);
  assert.equal(again.occupancy(3, 4, 5), MATERIALS.AIR);
  // A neighbour's edge columns too (column 0 faces a west neighbour's east edge).
  const edge = createChunk({
    ci: -1,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(1),
  });
  edge.setStructure(63, 4, 10, BUILDING, 7);
  const neighbour = restoreNeighbour(snapshotNeighbour(edge, 'w'));
  assert.equal(neighbour.structureBottom(63, 4), 7);
});

test('store layering: structure over terrain, an edit over a structure', () => {
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(3),
  });
  assert.equal(chunk.structure, null);
  chunk.setStructure(1, 1, 8);
  assert.equal(chunk.occupancy(1, 1, 3), MATERIALS.TERRAIN);
  assert.equal(chunk.occupancy(1, 1, 4), BUILDING);
  assert.equal(chunk.occupancy(1, 1, 8), BUILDING);
  assert.equal(chunk.occupancy(1, 1, 9), MATERIALS.AIR);
  assert.equal(chunk.occupancy(2, 1, 4), MATERIALS.AIR);
  assert.equal(chunk.topSolid(1, 1), 8);
  // Breaking the roof block is an edit; the structure stays as data.
  chunk.setBlock(1, 1, 8, MATERIALS.AIR);
  assert.equal(chunk.occupancy(1, 1, 8), MATERIALS.AIR);
  assert.equal(chunk.topSolid(1, 1), 7);
  assert.equal(chunk.structureTop(1, 1), 8);
  assert.deepEqual(
    [...chunk.edits],
    [{ i: 1, j: 1, y: 8, material: MATERIALS.AIR }],
  );
  // Stacking on top is an edit too; breaking the whole building leaves the terrain.
  chunk.setBlock(1, 1, 10, MATERIALS.TERRAIN);
  assert.equal(chunk.topSolid(1, 1), 10);
  chunk.setBlock(1, 1, 10, MATERIALS.AIR);
  for (let y = 4; y <= 7; y++) chunk.setBlock(1, 1, y, MATERIALS.AIR);
  assert.equal(chunk.topSolid(1, 1), 3);
  // An edit made before the buildings arrive still wins over them.
  chunk.setBlock(2, 2, 5, MATERIALS.TERRAIN); // a block stacked in the air
  chunk.setStructure(2, 2, 6);
  assert.equal(chunk.occupancy(2, 2, 5), MATERIALS.TERRAIN);
  assert.equal(chunk.occupancy(2, 2, 6), BUILDING);
  // An edit that matches the structure is no edit.
  chunk.setBlock(2, 2, 4, BUILDING);
  assert.deepEqual(chunk.columnEdits(2, 2), [[5, MATERIALS.TERRAIN]]);
  // Clearing: a top at or below the terrain, or NONE, removes it.
  chunk.setStructure(2, 2, 3);
  assert.equal(chunk.structureTop(2, 2), NONE);
  chunk.setStructure(1, 1, NONE);
  assert.equal(chunk.structureTop(1, 1), NONE);
  chunk.setStructure(3, 3, 6);
  chunk.clearStructures();
  assert.equal(chunk.structure, null);
  assert.equal(chunk.occupancy(3, 3, 5), MATERIALS.AIR);
  assert.throws(() => chunk.setStructure(64, 0, 5), RangeError);
});

test('a structure over water fills the water levels it stands in', () => {
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(-3),
    water: new Int32Array(COLUMNS).fill(0),
  });
  chunk.setStructure(4, 4, 2);
  assert.equal(chunk.occupancy(4, 4, -1), BUILDING);
  assert.equal(chunk.occupancy(4, 4, 0), BUILDING);
  assert.equal(chunk.occupancy(4, 4, 3), MATERIALS.AIR);
  assert.equal(chunk.occupancy(5, 4, 0), MATERIALS.WATER);
  assert.equal(chunk.topSolid(4, 4), 2);
});

test('the mesher draws a structure: building-coloured walls and roof over flat ground', () => {
  const flat = () =>
    createChunk({ ci: 0, cj: 0, top: new Int32Array(COLUMNS).fill(0) });
  const ground = buildChunkMesh(flat(), { blockM: 1 });
  const chunk = flat();
  for (let i = 10; i < 14; i++)
    for (let j = 10; j < 13; j++) chunk.setStructure(i, j, 6);
  const mesh = buildChunkMesh(chunk, { blockM: 1 });
  assert.ok(mesh.faces > ground.faces);
  // The roof at z = 7 (level 6's top), and walls rising to it.
  let roofVertices = 0;
  let buildingTinted = 0;
  const [r, g, b] = MATERIAL_COLORS[MATERIALS.BUILDING];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    if (Math.abs(mesh.positions[v * 3 + 2] - 7) < 1e-6) roofVertices++;
    // A building colour is the material's × light: its channels keep the material's order.
    const c = mesh.colors.subarray(v * 4, v * 4 + 3);
    if (
      c[0] > c[1] &&
      c[1] > c[2] &&
      Math.abs(c[0] / c[2] - r / b) < 0.08 &&
      Math.abs(c[1] / c[2] - g / b) < 0.08
    )
      buildingTinted++;
  }
  assert.ok(roofVertices >= 4);
  assert.ok(
    buildingTinted >= 4 * 5,
    `building-coloured vertices ${buildingTinted}`,
  );
});

test('surfaceMaterial and lineWidthM: the classes from tags', () => {
  const { WATER, GRASS, FOREST, ROAD } = MATERIALS;
  assert.equal(surfaceMaterial({ natural: 'water' }), WATER);
  assert.equal(surfaceMaterial({ water: 'river' }), WATER);
  assert.equal(surfaceMaterial({ waterway: 'riverbank' }), WATER);
  assert.equal(surfaceMaterial({ landuse: 'grass' }), GRASS);
  assert.equal(surfaceMaterial({ landuse: 'meadow' }), GRASS);
  assert.equal(surfaceMaterial({ leisure: 'park' }), GRASS);
  assert.equal(surfaceMaterial({ leisure: 'pitch' }), GRASS);
  assert.equal(surfaceMaterial({ landuse: 'forest' }), FOREST);
  assert.equal(surfaceMaterial({ natural: 'wood' }), FOREST);
  assert.equal(surfaceMaterial({ 'area:highway': 'primary' }), ROAD);
  assert.equal(surfaceMaterial({ highway: 'pedestrian', area: 'yes' }), ROAD);
  assert.equal(surfaceMaterial({ highway: 'residential' }), 0);
  assert.equal(surfaceMaterial({ landuse: 'residential' }), 0);
  assert.equal(lineWidthM({ highway: 'residential' }), 6);
  assert.equal(lineWidthM({ highway: 'footway' }), 2);
  assert.equal(lineWidthM({ highway: 'service' }), 4);
  assert.equal(lineWidthM({ highway: 'primary', width: '12' }), 12);
  assert.equal(lineWidthM({ railway: 'rail' }), 3);
  assert.equal(lineWidthM({ highway: 'primary', tunnel: 'yes' }), 0);
  assert.equal(lineWidthM({ highway: 'proposed' }), 0);
  assert.equal(lineWidthM({ highway: 'pedestrian', area: 'yes' }), 0);
  assert.equal(lineWidthM({ railway: 'abandoned' }), 0);
});

test('parseFeatures sorts buildings, land cover areas and road lines', () => {
  const p = (lat, lon) => ({ lat, lon });
  const square = [p(0, 0), p(0, 1), p(1, 1), p(1, 0), p(0, 0)];
  const { footprints, areas, lines } = parseFeatures([
    { type: 'way', id: 1, tags: { building: 'yes' }, geometry: square },
    { type: 'way', id: 2, tags: { natural: 'water' }, geometry: square },
    {
      type: 'way',
      id: 3,
      tags: { highway: 'primary' },
      geometry: [p(0, 0), p(1, 1)],
    },
    {
      type: 'way',
      id: 4,
      tags: { highway: 'pedestrian', area: 'yes' },
      geometry: square,
    },
    // An open forest way is no area.
    {
      type: 'way',
      id: 5,
      tags: { landuse: 'forest' },
      geometry: [p(0, 0), p(0, 1), p(1, 1)],
    },
    // A closed footway is still a line.
    { type: 'way', id: 6, tags: { highway: 'footway' }, geometry: square },
    {
      type: 'relation',
      id: 7,
      tags: { type: 'multipolygon', leisure: 'park' },
      members: [{ type: 'way', role: 'outer', geometry: square }],
    },
  ]);
  assert.deepEqual(
    footprints.map((f) => f.id),
    ['way/1'],
  );
  assert.deepEqual(
    areas.map((a) => [a.id, a.material]),
    [
      ['way/2', MATERIALS.WATER],
      ['way/4', MATERIALS.ROAD],
      ['relation/7', MATERIALS.GRASS],
    ],
  );
  assert.deepEqual(
    lines.map((l) => [l.id, l.widthM]),
    [
      ['way/3', 6],
      ['way/6', 2],
    ],
  );
});

/** A line in lon/lat from region metres. */
const lineAt = (region, points, widthM) => ({
  id: 'line',
  points: points.map(([x, y]) => region.toLonLat(x, y)),
  widthM,
});
const areaAt = (region, material, x0, y0, x1, y1) => ({
  id: 'area',
  material,
  rings: squareAt(region, {}, x0, y0, x1, y1).rings,
});

test('surfaceMaterials: each class on its polygon, and precedence where they meet', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  const { WATER, GRASS, FOREST, ROAD } = MATERIALS;
  const out = surfaceMaterials(region, 0, 0, {
    areas: [
      areaAt(region, GRASS, 0, 0, 40, 40), // a park
      areaAt(region, FOREST, 20, 0, 40, 20), // a wood in its south-east
      areaAt(region, WATER, 30, 10, 50, 30), // a pond across both and beyond
    ],
    lines: [
      lineAt(
        region,
        [
          [0, 35.5],
          [60, 35.5],
        ],
        2,
      ),
    ], // a path along y 35.5
  });
  assert.equal(out[at(5, 5)], GRASS);
  assert.equal(out[at(25, 5)], FOREST); // forest over grass
  assert.equal(out[at(35, 15)], WATER); // water over forest
  assert.equal(out[at(35, 25)], WATER); // water over grass
  assert.equal(out[at(45, 25)], WATER); // water alone
  assert.equal(out[at(5, 35)], ROAD); // road over grass
  assert.equal(out[at(45, 35)], ROAD); // road alone
  assert.equal(out[at(55, 5)], 0); // the terrain
  // A road through the pond stays water.
  const pond = surfaceMaterials(region, 0, 0, {
    areas: [areaAt(region, WATER, 0, 0, 20, 20)],
    lines: [
      lineAt(
        region,
        [
          [0, 10],
          [20, 10],
        ],
        6,
      ),
    ],
  });
  assert.equal(pond[at(10, 10)], WATER);
});

test('road buffers: width in blocks at 1 m and 10 m', () => {
  const rows = (blockM, y, widthM) => {
    const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM });
    const out = surfaceMaterials(region, 0, 0, {
      lines: [
        lineAt(
          region,
          [
            [0, y],
            [100 * blockM, y],
          ],
          widthM,
        ),
      ],
    });
    const set = new Set();
    for (let index = 0; index < out.length; index++)
      if (out[index] && index % GROUP_COLUMNS === 50)
        set.add(Math.floor(index / GROUP_COLUMNS));
    return [...set].sort((a, b) => a - b);
  };
  // 1 m blocks: a 6 m road on y = 50 covers the 6 rows whose centres are within 3 m.
  assert.deepEqual(rows(1, 50, 6), [47, 48, 49, 50, 51, 52]);
  // A 2 m footway: 2 rows.
  assert.deepEqual(rows(1, 50, 2), [49, 50]);
  // 10 m blocks: a 6 m road is still one block wide (half-width at least a half-diagonal),
  assert.deepEqual(rows(10, 505, 6), [50]);
  // and a 25 m avenue three.
  assert.deepEqual(rows(10, 505, 25), [49, 50, 51]);
  assert.ok(Math.abs(lineHalfWidthM(6, 10) - 7.0710678) < 1e-6);
  assert.equal(lineHalfWidthM(6, 1), 3);
  // A diagonal line at 10 m leaves no gaps: every column it crosses is in.
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 10 });
  const diagonal = surfaceMaterials(region, 0, 0, {
    lines: [
      lineAt(
        region,
        [
          [0, 0],
          [500, 500],
        ],
        6,
      ),
    ],
  });
  for (let k = 0; k < 50; k++)
    assert.equal(diagonal[at(k, k)], MATERIALS.ROAD, `column ${k}`);
});

test('the source: one group query brings surfaces; buildings win over them', async () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  const closed = (x0, y0, x1, y1) => {
    const r = squareAt(region, {}, x0, y0, x1, y1).rings[0];
    return [...r, r[0]];
  };
  const elements = [
    {
      type: 'way',
      id: 1,
      tags: { natural: 'water' },
      geometry: closed(0, 0, 30, 30),
    },
    // A building in the pond.
    {
      type: 'way',
      id: 2,
      tags: { building: 'yes', height: '9' },
      geometry: closed(10, 10, 20, 20),
    },
    {
      type: 'way',
      id: 3,
      tags: { leisure: 'park' },
      geometry: closed(30, 0, 60, 30),
    },
  ];
  let queries = 0;
  const source = createStructuresSource({
    query: async () => {
      queries++;
      return { elements };
    },
    loadChunk: async (r, ci, cj) =>
      createChunk({ ci, cj, top: new Int32Array(COLUMNS).fill(4) }),
  });
  const levels = await source.loadChunkStructures(region, 0, 0);
  assert.equal(queries, 1);
  assert.ok(levels.material instanceof Uint8Array);
  assert.equal(levels.material[columnIndex(5, 5)], MATERIALS.WATER);
  assert.equal(levels.material[columnIndex(15, 15)], 0); // under the building
  assert.equal(levels.top[columnIndex(15, 15)], 4 + 9);
  assert.equal(levels.material[columnIndex(45, 5)], MATERIALS.GRASS);
  assert.equal(levels.material[columnIndex(62, 5)], 0);
  // Nothing north of 64 m: no chunk levels.
  assert.equal(await source.loadChunkStructures(region, 0, 1), null);
});

test('applyStructures writes surfaces: grass as the column material, water at the top', () => {
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top: new Int32Array(COLUMNS).fill(7),
  });
  const levels = {
    top: new Int32Array(COLUMNS).fill(NONE),
    bottom: new Int32Array(COLUMNS).fill(NONE),
    material: new Uint8Array(COLUMNS),
  };
  levels.material[columnIndex(1, 1)] = MATERIALS.GRASS;
  levels.material[columnIndex(2, 1)] = MATERIALS.WATER;
  levels.material[columnIndex(3, 1)] = MATERIALS.ROAD;
  levels.top[columnIndex(4, 1)] = 12; // a building, terrain under it
  levels.bottom[columnIndex(4, 1)] = 8;
  assert.equal(applyStructures(chunk, levels), 1);
  assert.equal(chunk.material[columnIndex(1, 1)], MATERIALS.GRASS);
  assert.equal(chunk.occupancy(1, 1, 7), MATERIALS.GRASS);
  assert.equal(chunk.material[columnIndex(3, 1)], MATERIALS.ROAD);
  // The river: its top block is water, the ground under it.
  assert.equal(chunk.top[columnIndex(2, 1)], 6);
  assert.equal(chunk.water[columnIndex(2, 1)], 7);
  assert.equal(chunk.occupancy(2, 1, 7), MATERIALS.WATER);
  assert.equal(chunk.occupancy(2, 1, 6), MATERIALS.TERRAIN);
  assert.equal(chunk.topSolid(2, 1), 6);
  assert.equal(chunk.occupancy(4, 1, 7), MATERIALS.TERRAIN);
  assert.equal(chunk.occupancy(4, 1, 8), BUILDING);
  // Again: nothing changes (the river is not lowered twice).
  const version = chunk.version;
  applyStructures(chunk, levels);
  assert.equal(chunk.version, version);
  assert.equal(chunk.top[columnIndex(2, 1)], 6);
});

test('setSurface: the sea and columns without data are left alone; air is no surface', () => {
  const top = new Int32Array(COLUMNS).fill(-2);
  const water = new Int32Array(COLUMNS).fill(0);
  top[1] = NONE;
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  assert.equal(chunk.setSurface(0, 0, MATERIALS.WATER), false); // already the sea
  assert.equal(chunk.setSurface(1, 0, MATERIALS.GRASS), false); // no data
  assert.equal(chunk.setSurface(2, 0, MATERIALS.GRASS), true); // the seabed takes it
  assert.throws(() => chunk.setSurface(0, 0, MATERIALS.AIR), RangeError);
});

test('the mesher colours grass, forest and road tops by their materials', () => {
  const tops = new Int32Array(COLUMNS).fill(0);
  const material = new Uint8Array(COLUMNS).fill(MATERIALS.TERRAIN);
  for (let j = 0; j < 64; j++)
    for (let i = 0; i < 64; i++)
      material[columnIndex(i, j)] =
        i < 20 ? MATERIALS.GRASS : i < 40 ? MATERIALS.FOREST : MATERIALS.ROAD;
  const mesh = buildChunkMesh(
    createChunk({ ci: 0, cj: 0, top: tops, material }),
    {
      blockM: 1,
    },
  );
  const tint = (m) => {
    const [r, g, b] = MATERIAL_COLORS[m];
    return [r / g, b / g];
  };
  const found = new Set();
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    if (mesh.normals[v * 3 + 2] < 0.5) continue; // tops only
    const [r, g, b] = mesh.colors.subarray(v * 4, v * 4 + 3);
    for (const m of [MATERIALS.GRASS, MATERIALS.FOREST, MATERIALS.ROAD]) {
      const [rg, bg] = tint(m);
      if (Math.abs(r / g - rg) < 0.05 && Math.abs(b / g - bg) < 0.05)
        found.add(m);
    }
  }
  assert.deepEqual(
    [...found].sort(),
    [MATERIALS.GRASS, MATERIALS.FOREST, MATERIALS.ROAD].sort(),
  );
  // Grass is green, the forest a deeper green.
  assert.ok(
    MATERIAL_COLORS[MATERIALS.GRASS][1] > MATERIAL_COLORS[MATERIALS.GRASS][0],
  );
  assert.ok(
    MATERIAL_COLORS[MATERIALS.FOREST][1] < MATERIAL_COLORS[MATERIALS.GRASS][1],
  );
});
