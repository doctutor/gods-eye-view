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
  // The water surface's two triangles come last.
  assert.equal(mesh.indices.length - mesh.opaqueIndexCount, 6);
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
  for (let k = 0; k < mesh.opaqueIndexCount; k += 1)
    assert.equal(mesh.colors[mesh.indices[k] * 4 + 3], 255);
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

/**
 * A round hill in 10 m terraces over nine chunks (the manager's field
 * report, 2026-10-27: dark slivers at step corners, 10 m blocks, alt 300,
 * pitch -30), a chunk's tops by a function of region columns.
 */
function terracedHill(ci, cj) {
  const top = new Int32Array(N * N);
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const x = ci * N + i - 40;
      const y = cj * N + j - 30;
      top[columnIndex(i, j)] = Math.floor(
        Math.max(0, 120 - Math.hypot(x, y) * 4) / 10,
      );
    }
  return createChunk({ ci, cj, top });
}

test('mesh validator: on a terraced hill, no zero-area or inward triangle, no overlap, every riser spans its step', () => {
  const chunk = terracedHill(0, 0);
  const neighbours = {};
  for (const [key, dx, dy] of [
    ['n', 0, 1],
    ['s', 0, -1],
    ['e', 1, 0],
    ['w', -1, 0],
    ['ne', 1, 1],
    ['nw', -1, 1],
    ['se', 1, -1],
    ['sw', -1, -1],
  ])
    neighbours[key] = terracedHill(dx, dy);
  const topAt = (i, j) => {
    const dx = Math.floor(i / N);
    const dy = Math.floor(j / N);
    const owner = dx === 0 && dy === 0 ? chunk : terracedHill(dx, dy);
    return owner.top[columnIndex(i - dx * N, j - dy * N)];
  };
  // What must be covered: every top, and each side from the lower
  // neighbour's top to this column's.
  const expected = new Set();
  const sides = [
    ['east', 1, 0],
    ['west', -1, 0],
    ['north', 0, 1],
    ['south', 0, -1],
  ];
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const top = topAt(i, j);
      expected.add(`up|${i}|${j}|${top}`);
      for (const [name, dx, dy] of sides)
        for (let y = topAt(i + dx, j + dy) + 1; y <= top; y += 1)
          expected.add(`${name}|${i}|${j}|${y}`);
    }
  const blockM = 10;
  for (const greedy of [false, true]) {
    const mesh = buildChunkMesh(chunk, { neighbours, blockM, greedy });
    assertOutwardWinding(mesh);
    const { positions: p, indices, normals } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
      const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
      const e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
      const area = Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      );
      assert.ok(area > 1e-6, `zero-area triangle ${t / 3}`);
    }
    // Rasterise each quad back into block faces: each covered once, and
    // exactly the faces expected.
    const covered = new Set();
    const name = {
      '0,0,1': 'up',
      '1,0,0': 'east',
      '-1,0,0': 'west',
      '0,1,0': 'north',
      '0,-1,0': 'south',
    };
    for (let q = 0; q < mesh.faces; q += 1) {
      const normal = [
        normals[q * 12],
        normals[q * 12 + 1],
        normals[q * 12 + 2],
      ];
      const axis = normal.findIndex((v) => v !== 0);
      const corners = [0, 1, 2, 3].map((c) =>
        [0, 1, 2].map((k) => p[(q * 4 + c) * 3 + k] / blockM),
      );
      assert.equal(new Set(corners.map((c) => c[axis])).size, 1, 'planar');
      const lo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k])));
      const hi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])));
      // The block behind the face: inside along the normal.
      const base = lo.map((v, k) =>
        k === axis ? v - (normal[k] > 0 ? 1 : 0) : v,
      );
      const span = hi.map((v, k) => (k === axis ? base[k] + 1 : v));
      for (let x = base[0]; x < span[0]; x += 1)
        for (let y = base[1]; y < span[1]; y += 1)
          for (let z = base[2]; z < span[2]; z += 1) {
            const key = `${name[normal.join(',')]}|${x}|${y}|${z}`;
            assert.ok(!covered.has(key), `overlap at ${key}`);
            covered.add(key);
          }
    }
    assert.deepEqual(
      [...covered].filter((key) => !expected.has(key)),
      [],
      'no face where none belongs',
    );
    assert.equal(covered.size, expected.size, `greedy ${greedy}`);
  }
});

test('a quad whose corners are shaded unalike is four triangles round a centre at the mean; an even one two', () => {
  // The inside corner of the AO test: (10, 10)'s top has one corner at 0.5,
  // two at 0.8 and one at 1.0.
  const chunk = chunkAt(5, {
    tops: [
      [11, 10, 6],
      [10, 11, 6],
      [11, 11, 6],
    ],
  });
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
  });
  const quadOf = (x, y) =>
    quadsOf(mesh).findIndex(
      (q) =>
        q.normal[2] === 1 &&
        q.corners.every((c) => c.p[2] === 6) &&
        Math.min(...q.corners.map((c) => c.p[0])) === x &&
        Math.min(...q.corners.map((c) => c.p[1])) === y,
    );
  /** The triangles (as vertex triples) that use a quad's corners. */
  const trianglesOf = (n) => {
    const found = [];
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const tri = [...mesh.indices.subarray(t, t + 3)];
      if (tri.some((v) => v >= n * 4 && v < n * 4 + 4)) found.push(tri);
    }
    return found;
  };
  const corner = quadOf(10, 10);
  const fan = trianglesOf(corner);
  assert.equal(fan.length, 4);
  const centre = fan[0].find((v) => v >= mesh.faces * 4);
  assert.ok(
    fan.every((tri) => tri.includes(centre)),
    'one shared centre',
  );
  assert.deepEqual(
    [...mesh.positions.subarray(centre * 3, centre * 3 + 3)],
    [10.5, 10.5, 6],
  );
  const base = MATERIAL_COLORS[MATERIALS.TERRAIN][0];
  const mean = (AO[3] + AO[1] + AO[1] + AO[0]) / 4;
  assert.equal(
    mesh.colors[centre * 4],
    Math.round(base * FACE_SHADE.up * mean * sunTerm([0, 0, 1])),
  );
  // An evenly lit top far from the step: two triangles, no centre.
  const even = trianglesOf(quadOf(40, 40));
  assert.equal(even.length, 2);
  assert.ok(even.flat().every((v) => v < mesh.faces * 4));
  // The flat chunk has no centres at all.
  const flat = buildChunkMesh(chunkAt(5), { neighbours: flatAround(5) });
  assert.equal(flat.positions.length, flat.faces * 12);
  assert.equal(flat.indices.length, flat.faces * 6);
});

const SIDE_NAMES = {
  '0,0,1': 'up',
  '0,0,-1': 'down',
  '1,0,0': 'east',
  '-1,0,0': 'west',
  '0,1,0': 'north',
  '0,-1,0': 'south',
};

/**
 * The block faces a mesh covers, as 'direction|i|j|level' keys, checking on
 * the way that no triangle has zero area or faces inward, every quad is
 * planar, and no face is covered twice.
 */
function coveredFaces(mesh, blockM) {
  assertOutwardWinding(mesh);
  const { positions: p, indices, normals } = mesh;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
    const area = Math.hypot(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    );
    assert.ok(area > 1e-6, `zero-area triangle ${t / 3}`);
  }
  const covered = new Set();
  for (let q = 0; q < mesh.faces; q += 1) {
    const normal = [normals[q * 12], normals[q * 12 + 1], normals[q * 12 + 2]];
    const axis = normal.findIndex((v) => v !== 0);
    const corners = [0, 1, 2, 3].map((c) =>
      [0, 1, 2].map((k) => p[(q * 4 + c) * 3 + k] / blockM),
    );
    assert.equal(new Set(corners.map((c) => c[axis])).size, 1, 'planar');
    const lo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])));
    const base = lo.map((v, k) =>
      k === axis ? v - (normal[k] > 0 ? 1 : 0) : v,
    );
    const span = hi.map((v, k) => (k === axis ? base[k] + 1 : v));
    for (let x = base[0]; x < span[0]; x += 1)
      for (let y = base[1]; y < span[1]; y += 1)
        for (let z = base[2]; z < span[2]; z += 1) {
          const key = `${SIDE_NAMES[normal.join(',')]}|${x}|${y}|${z}`;
          assert.ok(!covered.has(key), `overlap at ${key}`);
          covered.add(key);
        }
  }
  return covered;
}

/** The east-facing faces on the chunk's east border, as 'j|level' keys. */
const eastBorder = (covered) =>
  new Set(
    [...covered]
      .filter((key) => key.startsWith(`east|${N - 1}|`))
      .map((key) => key.split('|').slice(2).join('|')),
  );

const without = (around, ...keys) =>
  Object.fromEntries(
    Object.entries(around).filter(([key]) => !keys.includes(key)),
  );

test('skirt: an open border hangs the edge columns down to the floor; without it, none; a present neighbour ignores it', () => {
  const chunk = chunkAt(5);
  const open = without(flatAround(5), 'e');
  const none = buildChunkMesh(chunk, { neighbours: open, greedy: false });
  assert.equal(none.stats.east, 0);
  assert.equal(none.stats.skirt, 0);
  const skirted = buildChunkMesh(chunk, {
    neighbours: open,
    greedy: false,
    skirt: { e: 2 },
  });
  // Levels 2 to 5 of all 64 edge columns.
  assert.equal(skirted.stats.east, N * 4);
  assert.equal(skirted.stats.skirt, N * 4);
  assert.equal(skirted.faces, N * N + N * 4);
  // Merged: one sheet, shaded as an east side without occlusion.
  const merged = buildChunkMesh(chunk, { neighbours: open, skirt: { e: 2 } });
  const sheet = quadsOf(merged).filter((q) => q.normal[0] === 1);
  assert.equal(sheet.length, 1);
  const zs = sheet[0].corners.map((c) => c.p[2]);
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [2, 6]);
  const base = MATERIAL_COLORS[MATERIALS.TERRAIN][0];
  const lit = Math.round(
    base * FACE_SHADE.east * AO[0] * sunTerm([1, 0, 0], STUDY_SUN_DIR),
  );
  assert.ok(sheet[0].corners.every((c) => c.color[0] === lit));
  assert.equal(merged.faces, 2, 'the top and the skirt');
  // A neighbour there: the option is ignored.
  const closed = buildChunkMesh(chunk, {
    neighbours: flatAround(5),
    greedy: false,
    skirt: { e: 2, w: 2, n: 2, s: 2 },
  });
  assert.equal(closed.stats.skirt, 0);
  assert.equal(closed.faces, N * N);
  // A floor above the top hangs nothing; null is no skirt.
  for (const e of [6, 9, null])
    assert.equal(
      buildChunkMesh(chunk, { neighbours: open, skirt: { e } }).stats.skirt,
      0,
      String(e),
    );
  // A floor on the top itself: the top block's side alone.
  assert.equal(
    buildChunkMesh(chunk, { neighbours: open, greedy: false, skirt: { e: 5 } })
      .stats.skirt,
    N,
  );
});

test('skirt: a floor far below the column makes no face below the floor', () => {
  const blockM = 10;
  const mesh = buildChunkMesh(chunkAt(5), {
    neighbours: without(flatAround(5), 'e'),
    blockM,
    skirt: { e: -10 },
  });
  let lowest = Infinity;
  for (let k = 2; k < mesh.positions.length; k += 3)
    lowest = Math.min(lowest, mesh.positions[k]);
  assert.equal(lowest, -10 * blockM, 'down to the floor, and no further');
  const border = eastBorder(coveredFaces(mesh, blockM));
  assert.equal(border.size, N * 16, 'levels -10 to 5');
});

test('skirt: a corner chunk hangs both borders; a hole in an edge column leaves a gap', () => {
  const chunk = chunkAt(5);
  chunk.setBlock(N - 1, 10, 4, MATERIALS.AIR);
  const neighbours = without(flatAround(5), 'e', 'n', 'ne');
  const mesh = buildChunkMesh(chunk, {
    neighbours,
    greedy: false,
    skirt: { e: 2, n: 2 },
  });
  assert.equal(mesh.stats.skirt, N * 4 + N * 4 - 1);
  const covered = coveredFaces(mesh, 1);
  const border = eastBorder(covered);
  assert.equal(border.has('10|4'), false, 'the hole');
  assert.ok(border.has('10|3') && border.has('10|5'));
  assert.equal(border.size, N * 4 - 1);
  const north = [...covered].filter((key) =>
    new RegExp(`^north\\|\\d+\\|${N - 1}\\|`).test(key),
  );
  assert.equal(north.length, N * 4);
  // The merged mesh covers the same faces.
  const merged = buildChunkMesh(chunk, { neighbours, skirt: { e: 2, n: 2 } });
  assert.deepEqual([...coveredFaces(merged, 1)].sort(), [...covered].sort());
});

test('mesh validator with skirts: a terraced hill open to the east and north, skirted to a floor', () => {
  const chunk = terracedHill(0, 0);
  const neighbours = {
    s: terracedHill(0, -1),
    w: terracedHill(-1, 0),
    sw: terracedHill(-1, -1),
  };
  const floor = -3;
  // An absent neighbour reads as the edge column repeated.
  const topAt = (i, j) => {
    let ci = Math.floor(i / N);
    let cj = Math.floor(j / N);
    if (ci > 0) {
      ci = 0;
      i = N - 1;
    }
    if (cj > 0) {
      cj = 0;
      j = N - 1;
    }
    const owner = ci === 0 && cj === 0 ? chunk : terracedHill(ci, cj);
    return owner.top[columnIndex(i - ci * N, j - cj * N)];
  };
  const expected = new Set();
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const top = topAt(i, j);
      expected.add(`up|${i}|${j}|${top}`);
      for (const [name, dx, dy] of [
        ['east', 1, 0],
        ['west', -1, 0],
        ['north', 0, 1],
        ['south', 0, -1],
      ]) {
        const skirted =
          (name === 'east' && i === N - 1) || (name === 'north' && j === N - 1);
        const from = skirted ? floor : topAt(i + dx, j + dy) + 1;
        for (let y = from; y <= top; y += 1)
          expected.add(`${name}|${i}|${j}|${y}`);
      }
    }
  for (const greedy of [false, true]) {
    const mesh = buildChunkMesh(chunk, {
      neighbours,
      blockM: 10,
      greedy,
      skirt: { e: floor, n: floor, w: floor, s: floor },
    });
    const covered = coveredFaces(mesh, 10);
    assert.deepEqual(
      [...covered].filter((key) => !expected.has(key)),
      [],
      'no face where none belongs',
    );
    assert.equal(covered.size, expected.size, `greedy ${greedy}`);
  }
});

test('a 120 m block on 30 m levels: tops at (level + 1) × 30 m, sides 120 m wide and 30 m high', () => {
  // Flat at level 2 (its top at 90 m), one column raised to level 3.
  const chunk = chunkAt(2, { tops: [[5, 5, 3]] });
  const mesh = buildChunkMesh(chunk, {
    neighbours: flatAround(2),
    blockM: 120,
    levelM: 30,
    greedy: false,
  });
  assertOutwardWinding(mesh);
  const quads = quadsOf(mesh);
  const tops = quads.filter((q) => q.normal[2] === 1);
  assert.equal(tops.length, N * N, 'one top a column');
  const raised = tops.find(
    (q) => q.corners[0].p[0] === 600 && q.corners[0].p[1] === 600,
  );
  assert.ok(raised, 'the raised column’s top at x, y = 5 × 120');
  for (const c of raised.corners) assert.equal(c.p[2], 120, '(3 + 1) × 30 m');
  const xs = raised.corners.map((c) => c.p[0]);
  assert.deepEqual(
    [Math.min(...xs), Math.max(...xs)],
    [600, 720],
    '120 m wide',
  );
  for (const q of tops.filter((q) => q !== raised))
    for (const c of q.corners) assert.equal(c.p[2], 90);
  const sides = quads.filter((q) => q.normal[2] === 0);
  assert.equal(sides.length, 4, 'its four sides');
  for (const side of sides) {
    const zs = side.corners.map((c) => c.p[2]);
    assert.deepEqual(
      [Math.min(...zs), Math.max(...zs)],
      [90, 120],
      '30 m high',
    );
    const across =
      side.normal[0] === 0
        ? side.corners.map((c) => c.p[0])
        : side.corners.map((c) => c.p[1]);
    assert.equal(Math.max(...across) - Math.min(...across), 120, '120 m wide');
  }
  // The greedy top: one quad 64 × 120 m a side at 90 m, the raised one apart.
  const greedy = quadsOf(
    buildChunkMesh(chunkAt(2), {
      neighbours: flatAround(2),
      blockM: 120,
      levelM: 30,
    }),
  );
  assert.equal(greedy.length, 1);
  const xs2 = greedy[0].corners.map((c) => c.p[0]);
  assert.equal(Math.max(...xs2) - Math.min(...xs2), N * 120);
  for (const c of greedy[0].corners) assert.equal(c.p[2], 90);
  // levelM left out: a cube, as before.
  const cube = quadsOf(
    buildChunkMesh(chunk, {
      neighbours: flatAround(2),
      blockM: 120,
      greedy: false,
    }),
  );
  const cubeTop = cube.find(
    (q) =>
      q.normal[2] === 1 &&
      q.corners[0].p[0] === 600 &&
      q.corners[0].p[1] === 600,
  );
  assert.equal(cubeTop.corners[0].p[2], 480, '(3 + 1) × 120 m');
});

test('30 m levels: a skirt hangs in levels of 30 m, and a water surface sits on its level', () => {
  // Flat at level 4 (top 150 m), no east neighbour, a skirt to level 1.
  const chunk = chunkAt(4);
  const neighbours = { ...flatAround(4) };
  delete neighbours.e;
  delete neighbours.ne;
  delete neighbours.se;
  const mesh = buildChunkMesh(chunk, {
    neighbours,
    blockM: 120,
    levelM: 30,
    skirt: { e: 1 },
  });
  const east = quadsOf(mesh).filter((q) => q.normal[0] === 1);
  assert.ok(east.length > 0, 'the skirt');
  const zs = east.flatMap((q) => q.corners.map((c) => c.p[2]));
  assert.deepEqual(
    [Math.min(...zs), Math.max(...zs)],
    [30, 150],
    'from level 1’s base to the top',
  );
  for (const q of east)
    for (const c of q.corners) assert.equal(c.p[0], N * 120);
  // A pond: bed at level 1, water to level 3 → its surface at 120 m.
  const pond = chunkAt(4, { tops: [[10, 10, 1]], waters: [[10, 10, 3]] });
  const wet = buildChunkMesh(pond, {
    neighbours: flatAround(4),
    blockM: 120,
    levelM: 30,
  });
  // The water's quad: its top, translucent.
  const waterTop = quadsOf(wet).find(
    (q) => q.normal[2] === 1 && q.corners[0].color[3] < 255,
  );
  assert.ok(waterTop, 'a water surface');
  for (const c of waterTop.corners) assert.equal(c.p[2], 120);
});
