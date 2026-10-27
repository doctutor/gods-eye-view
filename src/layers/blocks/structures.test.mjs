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
import { GROUP_COLUMNS, groupBounds } from './source.js';
import {
  BUILDING,
  applyStructures,
  assembleRings,
  buildingHeightBlocks,
  buildingHeightM,
  buildingsQuery,
  createStructuresSource,
  fillFootprint,
  parseFootprints,
  parseLengthM,
  rasteriseGroup,
} from './structures.js';

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

test('buildingsQuery: ways and relations tagged building, not building=no, in the box', () => {
  const ql = buildingsQuery({
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
  assert.match(ql, /out geom qt;$/);
});

/** A footprint in lon/lat from region metres. */
const footprintAt = (region, tags, points) => ({
  id: 'test',
  tags,
  rings: [points.map(([x, y]) => region.toLonLat(x, y))],
});

test('rasteriseGroup: a footprint from lon/lat lands on its columns in the group grid', () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  // 10 × 4 m at 300 m east, 100 m north: group (1, 0) starts at 256 m.
  const heights = rasteriseGroup(region, 1, 0, [
    footprintAt(region, { 'building:levels': '3' }, [
      [300, 100],
      [310, 100],
      [310, 104],
      [300, 104],
    ]),
  ]);
  assert.equal(heights.length, GROUP_COLUMNS * GROUP_COLUMNS);
  const set = filled(heights, GROUP_COLUMNS);
  assert.equal(set.length, 40);
  assert.equal(set[0], '44,100'); // column 300 − 256
  assert.equal(heights[100 * GROUP_COLUMNS + 44], 10); // 9.6 m → 10 blocks
  assert.equal(heights[100 * GROUP_COLUMNS + 54], 0);
});

test('createStructuresSource: one query per group, chunks split from it, failures retried', async () => {
  const region = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  const queries = [];
  let fail = 1;
  const building = footprintAt(region, { height: '12' }, [
    [70, 10],
    [80, 10],
    [80, 20],
    [70, 20],
  ]); // in chunk (1, 0) of group (0, 0)
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
  const source = createStructuresSource({ query });
  await assert.rejects(source.loadChunkStructures(region, 1, 0), /504/);
  assert.equal(source.size(), 0);
  // Two chunks of one group at once: one query, over the group's box.
  const [withBuilding, without] = await Promise.all([
    source.loadChunkStructures(region, 1, 0),
    source.loadChunkStructures(region, 3, 2),
  ]);
  assert.equal(queries.length, 2);
  assert.equal(queries[1], buildingsQuery(groupBounds(region, 0, 0)));
  assert.equal(without, null);
  assert.ok(withBuilding instanceof Uint16Array);
  assert.equal(withBuilding.length, COLUMNS);
  // Column 70 east is chunk 1's column 6; 12 m is 12 blocks.
  assert.equal(withBuilding[columnIndex(6, 10)], 12);
  assert.equal(withBuilding[columnIndex(16, 10)], 0);
  // Every chunk of the group is free now; another group asks again.
  for (let ci = 0; ci < 4; ci++)
    for (let cj = 0; cj < 4; cj++)
      await source.loadChunkStructures(region, ci, cj);
  assert.equal(queries.length, 2);
  await source.loadChunkStructures(region, 4, 0);
  assert.equal(queries.length, 3);
});

test('applyStructures: a building stands its height over the terrain, or the water', () => {
  const top = new Int32Array(COLUMNS).fill(5);
  const water = new Int32Array(COLUMNS).fill(NONE);
  top[columnIndex(2, 0)] = NONE; // no data
  top[columnIndex(3, 0)] = -2; // under the sea
  water[columnIndex(3, 0)] = 0;
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  const heights = new Uint16Array(COLUMNS);
  for (const i of [0, 1, 2, 3]) heights[columnIndex(i, 0)] = 4;
  const before = chunk.version;
  assert.equal(applyStructures(chunk, heights), 3);
  assert.ok(chunk.version > before);
  assert.equal(chunk.structureTop(0, 0), 9);
  assert.equal(chunk.structureTop(2, 0), NONE);
  assert.equal(chunk.structureTop(3, 0), 4); // the water's level 0 + 4
  assert.equal(chunk.structureTop(5, 5), NONE);
  // Applying again changes nothing.
  const after = chunk.version;
  applyStructures(chunk, heights);
  assert.equal(chunk.version, after);
  assert.equal(applyStructures(chunk, null), 0);
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
