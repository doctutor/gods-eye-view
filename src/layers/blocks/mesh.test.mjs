// Personal fork: the Blocks mesher and lighting (src/layers/blocks/mesh.js,
// lighting.js): which faces a chunk emits, how greedy merging joins them,
// ambient occlusion at an inside corner, the sun term's floor, and culling
// across chunk borders.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, createChunk } from './store.js';
import { buildChunkMesh } from './mesh.js';
import {
  AO,
  FACE_SHADE,
  MATERIAL_COLORS,
  STUDY_SUN_DIR,
  SUN_FLOOR,
  aoCount,
  sunDirection,
  sunTerm,
} from './lighting.js';

const N = CHUNK_COLUMNS;

/** A chunk flat at a level, with some columns' tops and water changed. */
function chunkAt(level, { tops = [], waters = [], ci = 0, cj = 0 } = {}) {
  const top = new Int32Array(N * N).fill(level);
  const water = new Int32Array(N * N).fill(NONE);
  for (const [i, j, y] of tops) top[columnIndex(i, j)] = y;
  for (const [i, j, y] of waters) water[columnIndex(i, j)] = y;
  return createChunk({ ci, cj, top, water });
}

/** Eight flat neighbours at a level. */
const flatAround = (level) =>
  Object.fromEntries(
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((k) => [
      k,
      chunkAt(level),
    ]),
  );

/** The quads of a mesh: four corners each, with colour and normal. */
function quadsOf(mesh) {
  const quads = [];
  for (let n = 0; n < mesh.faces; n += 1) {
    const corners = [];
    for (let c = 0; c < 4; c += 1) {
      const at = n * 4 + c;
      corners.push({
        p: [...mesh.positions.subarray(at * 3, at * 3 + 3)],
        color: [...mesh.colors.subarray(at * 4, at * 4 + 4)],
      });
    }
    quads.push({
      corners,
      normal: [...mesh.normals.subarray(n * 12, n * 12 + 3)],
    });
  }
  return quads;
}

/** Every triangle winds counter-clockwise seen from outside. */
function assertOutwardWinding(mesh) {
  const { positions: p, indices, normals } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const dot = [0, 1, 2].reduce(
      (s, k) => s + cross[k] * normals[a * 3 + k],
      0,
    );
    assert.ok(dot > 0, `triangle ${t / 3} faces inward`);
  }
}

test('a flat chunk among flat neighbours: only tops, one per column', () => {
  const mesh = buildChunkMesh(chunkAt(5), {
    neighbours: flatAround(5),
    greedy: false,
  });
  assert.equal(mesh.faces, N * N);
  assert.equal(mesh.stats.up, N * N);
  for (const side of ['north', 'south', 'east', 'west', 'down'])
    assert.equal(mesh.stats[side], 0, side);
  assert.equal(mesh.positions.length, N * N * 12);
  assert.equal(mesh.colors.length, N * N * 16);
  assert.equal(mesh.indices.length, N * N * 6);
  assert.equal(mesh.opaqueIndexCount, mesh.indices.length);
  // An open edge (no neighbours) has no walls either.
  const open = buildChunkMesh(chunkAt(5), { greedy: false });
  assert.equal(open.faces, N * N);
  assertOutwardWinding(open);
});

test('greedy merging reduces a flat 64 × 64 top to one quad, in metres', () => {
  const mesh = buildChunkMesh(chunkAt(5), {
    neighbours: flatAround(5),
    blockM: 30,
  });
  assert.equal(mesh.faces, 1);
  const [quad] = quadsOf(mesh);
  const xs = quad.corners.map((c) => c.p[0]);
  const ys = quad.corners.map((c) => c.p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 64 * 30]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 64 * 30]);
  // The top of level 5 is 6 blocks above mean sea level.
  assert.ok(quad.corners.every((c) => c.p[2] === 6 * 30));
  assert.deepEqual(quad.normal, [0, 0, 1]);
  assertOutwardWinding(mesh);
});

test('a single raised block: its top and four sides, and the tops around it', () => {
  const chunk = chunkAt(5, { tops: [[30, 30, 6]] });
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
  });
  assert.equal(mesh.faces, N * N + 4);
  assert.equal(mesh.stats.up, N * N);
  for (const side of ['north', 'south', 'east', 'west'])
    assert.equal(mesh.stats[side], 1, side);
  assert.equal(mesh.stats.down, 0);
  assertOutwardWinding(mesh);
  // Merged, the flat around it splits only where the block darkens it.
  const merged = buildChunkMesh(chunk, { neighbours: flatAround(5) });
  assert.ok(merged.faces <= 20, `${merged.faces} quads`);
  assert.ok(merged.faces >= 5 + 1);
  assertOutwardWinding(merged);
  // An edit does the same as the heightfield.
  const edited = chunkAt(5);
  edited.setBlock(30, 30, 6, MATERIALS.TERRAIN);
  assert.deepEqual(
    buildChunkMesh(edited, { neighbours: flatAround(5) }).positions,
    merged.positions,
  );
});

test('a water column: a translucent surface over the bed, drawn after the opaque', () => {
  const chunk = chunkAt(5, { tops: [[7, 7, 2]], waters: [[7, 7, 5]] });
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
    blockM: 2,
  });
  // The bed's top under the water, the four banks' sides in it (levels
  // 3 … 5), and one water surface; the water's sides meet solid banks.
  assert.equal(mesh.stats.water, 1);
  assert.equal(mesh.stats.up, N * N);
  for (const side of ['north', 'south', 'east', 'west'])
    assert.equal(mesh.stats[side], 3, side);
  assert.equal(mesh.faces, N * N + 12 + 1);
  assert.equal(mesh.opaqueIndexCount, (mesh.faces - 1) * 6);
  const water = quadsOf(mesh).at(-1);
  assert.ok(
    water.corners.every((c) => c.p[2] === 6 * 2),
    'at the top of level 5',
  );
  assert.ok(
    water.corners.every(
      (c) => c.color[3] === MATERIAL_COLORS[MATERIALS.WATER][3],
    ),
  );
  assert.ok(water.corners.every((c) => c.color[3] < 255));
  assert.deepEqual(water.normal, [0, 0, 1]);
  // Every opaque vertex is opaque.
  for (let k = 3; k < (mesh.opaqueIndexCount / 6) * 16; k += 4)
    assert.equal(mesh.colors[k], 255);
  // Sea at level 0 over a bed at -3: one surface per column, merged to one.
  const sea = chunkAt(-3, {
    waters: Array.from({ length: N * N }, (_, k) => [
      k % N,
      Math.floor(k / N),
      0,
    ]),
  });
  const seaNeighbours = Object.fromEntries(
    Object.keys(flatAround(0)).map((k) => [k, sea]),
  );
  const seaMesh = buildChunkMesh(sea, { neighbours: seaNeighbours });
  assert.equal(seaMesh.stats.water, N * N);
  assert.equal(seaMesh.faces, 2, 'one bed, one surface');
});

test('ambient occlusion at an inside corner: both sides occlude, 0.5', () => {
  // Three raised columns around (10, 10)'s north-east corner.
  const chunk = chunkAt(5, {
    tops: [
      [11, 10, 6],
      [10, 11, 6],
      [11, 11, 6],
    ],
  });
  const sunDir = STUDY_SUN_DIR;
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
    sunDir,
  });
  const top = quadsOf(mesh).find(
    (q) =>
      q.normal[2] === 1 &&
      q.corners.every((c) => c.p[2] === 6) &&
      Math.min(...q.corners.map((c) => c.p[0])) === 10 &&
      Math.min(...q.corners.map((c) => c.p[1])) === 10,
  );
  assert.ok(top, 'the top of (10, 10)');
  const at = (x, y) => top.corners.find((c) => c.p[0] === x && c.p[1] === y);
  const base = MATERIAL_COLORS[MATERIALS.TERRAIN][0];
  const lit = (ao) =>
    Math.round(base * FACE_SHADE.up * ao * sunTerm([0, 0, 1], sunDir));
  assert.equal(at(11, 11).color[0], lit(AO[3]), 'inside corner');
  assert.equal(AO[3], 0.5);
  assert.equal(at(10, 10).color[0], lit(AO[0]), 'open corner');
  assert.equal(at(11, 10).color[0], lit(AO[1]), 'one side');
  assert.equal(at(10, 11).color[0], lit(AO[1]), 'one side');
  // The rule itself.
  assert.equal(aoCount(true, true, false), 3);
  assert.equal(aoCount(false, false, true), 1);
  assert.equal(aoCount(true, false, true), 2);
  assert.equal(aoCount(false, false, false), 0);
});

test('the sun term never goes below 0.6, and is 1 facing the sun', () => {
  assert.equal(SUN_FLOOR, 0.6);
  const normals = [
    [0, 0, 1],
    [0, 0, -1],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
  for (let az = 0; az < 360; az += 15)
    for (const el of [-30, 0, 15, 45, 89]) {
      const sun = sunDirection(az, el);
      for (const normal of normals) {
        const term = sunTerm(normal, sun);
        assert.ok(term >= 0.6 && term <= 1, `${term} at ${az}/${el}`);
      }
    }
  // The sun is {east, north, up} in the region's frame.
  const overhead = { east: 0, north: 0, up: 1 };
  assert.equal(sunTerm([0, 0, -1], overhead), 0.6);
  assert.equal(sunTerm([0, 0, 1], overhead), 1);
  assert.equal(sunTerm({ east: 0, north: 0, up: 1 }, overhead), 1);
  assert.equal(
    sunTerm([0, 0, 1], { east: 0, north: 0, up: 5 }),
    1,
    'any length of sun vector',
  );
  const low = sunDirection(90, 30);
  assert.ok(Math.abs(low.east - Math.cos(Math.PI / 6)) < 1e-12);
  assert.ok(Math.abs(low.north) < 1e-12);
  assert.ok(Math.abs(low.up - 0.5) < 1e-12);
  // Without a sun, the study sun from the north-west.
  assert.equal(sunTerm([0, 1, 0]), sunTerm([0, 1, 0], STUDY_SUN_DIR));
  assert.ok(
    STUDY_SUN_DIR.east < 0 && STUDY_SUN_DIR.north > 0 && STUDY_SUN_DIR.up > 0,
  );
  // A mesh lit by an object-shaped sun: an east wall facing it is brightest.
  const wall = buildChunkMesh(chunkAt(5, { tops: [[30, 30, 6]] }), {
    neighbours: flatAround(5),
    greedy: false,
    sunDir: { east: 1, north: 0, up: 0 },
  });
  const eastWall = quadsOf(wall).find((q) => q.normal[0] === 1);
  const westWall = quadsOf(wall).find((q) => q.normal[0] === -1);
  assert.ok(
    eastWall.corners[2].color[0] / FACE_SHADE.east >
      westWall.corners[2].color[0] / FACE_SHADE.west,
  );
});

test('neighbours cull faces across chunk borders', () => {
  const chunk = chunkAt(10);
  // The east column of chunks (e, ne, se) at a level.
  const level = (y) => ({
    ...flatAround(10),
    e: chunkAt(y, { ci: 1 }),
    ne: chunkAt(y, { ci: 1, cj: 1 }),
    se: chunkAt(y, { ci: 1, cj: -1 }),
  });
  // Level with the neighbour: no wall on the east border.
  assert.equal(
    buildChunkMesh(chunk, { neighbours: level(10), greedy: false }).stats.east,
    0,
  );
  // Five levels above it: the east border's sides at levels 6 … 10.
  const cliff = buildChunkMesh(chunk, { neighbours: level(5), greedy: false });
  assert.equal(cliff.stats.east, N * 5);
  assert.equal(cliff.stats.west, 0);
  const eastQuads = quadsOf(cliff).filter((q) => q.normal[0] === 1);
  assert.ok(eastQuads.every((q) => q.corners.every((c) => c.p[0] === N)));
  // Merged: the row against the neighbour's top (occluded below) and the rest.
  const merged = buildChunkMesh(chunk, { neighbours: level(5) });
  assert.equal(merged.stats.east, N * 5, 'stats count block faces');
  assert.ok(quadsOf(merged).filter((q) => q.normal[0] === 1).length <= 2);
  // The neighbour's side of it: its west border faces nothing (it is lower).
  const below = buildChunkMesh(chunkAt(5, { ci: 1 }), {
    neighbours: { ...flatAround(5), w: chunk },
    greedy: false,
  });
  assert.equal(below.stats.west, 0);
  assert.equal(below.faces, N * N);
});

test('a column without data opens down to the lowest ground around it, not forever', () => {
  const chunk = chunkAt(5, { tops: [[20, 20, NONE]] });
  chunk.top[columnIndex(40, 40)] = 2;
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
  });
  // Each of the hole's four banks shows levels 2 … 5 (four faces).
  assert.equal(
    mesh.stats.east + mesh.stats.west + mesh.stats.north + mesh.stats.south,
    4 * 4 + 4 * 3,
  );
  assert.equal(mesh.stats.up, N * N - 1);
});
