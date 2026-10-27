// Personal fork: the embodied navigation model (src/navigation/movement.js)
// and its worlds (worlds.js): gravity, jump height, the step up, speeds,
// swimming, flight, hovering where nothing is known, mouse look and the
// field of view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_HEIGHT_M,
  EYE_HEIGHT_M,
  FLY_SPEED_M_S,
  FLY_VERTICAL_M_S,
  GRAVITY_M_S2,
  JUMP_HEIGHT_M,
  LOOK_RAD_PER_PX,
  MAX_DT_S,
  PITCH_LIMIT_RAD,
  SINK_M_S,
  SPRINT_SPEED_M_S,
  SWIM_SPEED_M_S,
  SWIM_UP_M_S,
  WALK_SPEED_M_S,
  cesiumFovRad,
  createNavState,
  look,
  step,
  wishDirection,
} from './movement.js';
import { createBlockWorld, createHeightfieldWorld } from './worlds.js';
import {
  createRegion,
  columnIndex,
  CHUNK_COLUMNS,
} from '../layers/blocks/grid.js';
import { MATERIALS, NONE, createChunk } from '../layers/blocks/store.js';

const DT = 1 / 60;
const N = CHUNK_COLUMNS;

/** A heightfield world from a function of x and y (no cache delay). */
const field = (surface, options = {}) =>
  createHeightfieldWorld({
    sample: surface,
    cellM: 0.01,
    ttlMs: 0,
    ...options,
  });

/** A one-chunk Blocks world (1 m blocks) flat at a level, with changes. */
function blocks(level, { tops = [], waters = [], blockM = 1 } = {}) {
  const top = new Int32Array(N * N).fill(level);
  const water = new Int32Array(N * N).fill(NONE);
  for (const [i, j, y] of tops) top[columnIndex(i, j)] = y;
  for (const [i, j, y] of waters) water[columnIndex(i, j)] = y;
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  const region = createRegion({ lon0: -76.6, lat0: 39.3, blockM });
  return {
    chunk,
    world: createBlockWorld({
      region,
      chunkAt: (ci, cj) => (ci === 0 && cj === 0 ? chunk : null),
    }),
  };
}

/** Run the model for `seconds` with keys held; every state on the way. */
function run(state, input, seconds, world, mode = 'walk', dt = DT) {
  const states = [state];
  for (let t = 0; t < seconds - 1e-9; t += dt)
    states.push(step(states.at(-1), input, dt, world, mode));
  return states;
}

const standingOn = (heightM, x = 10.5, y = 10.5, yaw = 0) => ({
  ...createNavState({ x, y, z: heightM + EYE_HEIGHT_M, yaw }),
  onGround: true,
});

test('walking on flat ground keeps the eye 1.62 m up, at 4.3 m/s; sprint 5.6', () => {
  const world = field(() => 10);
  const walked = run(standingOn(10), { forward: true }, 2, world);
  for (const s of walked) assert.ok(Math.abs(s.z - 11.62) < 1e-9, `${s.z}`);
  const last = walked.at(-1);
  assert.ok(Math.abs(last.y - 10.5 - 2 * WALK_SPEED_M_S) < 1e-6, `${last.y}`);
  assert.ok(Math.abs(last.x - 10.5) < 1e-9, 'north at yaw 0');
  const sprinted = run(
    standingOn(10),
    { forward: true, sprint: true },
    1,
    world,
  ).at(-1);
  assert.ok(Math.abs(sprinted.y - 10.5 - SPRINT_SPEED_M_S) < 1e-6);
  // Diagonals are no faster; yaw 90° walks east.
  const diagonal = run(
    standingOn(10),
    { forward: true, right: true },
    1,
    world,
  ).at(-1);
  assert.ok(
    Math.abs(
      Math.hypot(diagonal.x - 10.5, diagonal.y - 10.5) - WALK_SPEED_M_S,
    ) < 1e-6,
  );
  const east = run(
    standingOn(10, 10.5, 10.5, Math.PI / 2),
    { forward: true },
    1,
    world,
  ).at(-1);
  assert.ok(Math.abs(east.x - 10.5 - WALK_SPEED_M_S) < 1e-6);
  assert.deepEqual(wishDirection({ forward: true, back: true }, 0), {
    x: 0,
    y: 0,
  });
});

test('gravity: a drop of 20 m lands in sqrt(2h/g), on the ground', () => {
  const world = field(() => 0);
  const start = createNavState({ x: 0, y: 0, z: 20 + EYE_HEIGHT_M });
  const states = run(start, {}, 2, world);
  const landed = states.findIndex((s) => s.onGround);
  const expected = Math.sqrt((2 * 20) / GRAVITY_M_S2);
  assert.ok(
    Math.abs(landed * DT - expected) < 3 * DT,
    `${landed * DT} vs ${expected}`,
  );
  assert.ok(Math.abs(states.at(-1).z - EYE_HEIGHT_M) < 1e-9);
  assert.equal(states.at(-1).vz, 0);
});

test('a jump rises 1.25 m and comes back down', () => {
  const world = field(() => 5);
  const first = step(standingOn(5), { jump: true }, DT, world);
  const states = run(first, {}, 1.2, world);
  const apex = Math.max(...states.map((s) => s.z - EYE_HEIGHT_M - 5));
  assert.ok(Math.abs(apex - JUMP_HEIGHT_M) < 0.03, `apex ${apex}`);
  assert.ok(states.at(-1).onGround);
  assert.ok(Math.abs(states.at(-1).z - (5 + EYE_HEIGHT_M)) < 1e-9);
  // No jumping in mid-air.
  const air = { ...createNavState({ z: 30 }), vz: -3 };
  assert.ok(step(air, { jump: true }, DT, world).vz < -3);
});

test('the step up: one block climbed by walking into it, two blocks stop it', () => {
  // A one-block step up to a terrace from j = 12 north, a two-block wall
  // at i = 14.
  const terrace = [];
  for (let i = 0; i < N; i += 1)
    for (let j = 12; j < N; j += 1) terrace.push([i, j, 6]);
  const { world } = blocks(5, {
    tops: [...terrace, ...Array.from({ length: N }, (_, j) => [14, j, 7])],
  });
  // Standing on level 5: the top at 6 m.
  const climbed = run(
    standingOn(6, 10.5, 10.5),
    { forward: true },
    1,
    world,
  ).at(-1);
  assert.ok(climbed.y > 12.5, `${climbed.y}`);
  assert.ok(Math.abs(climbed.z - (7 + EYE_HEIGHT_M)) < 1e-9, `${climbed.z}`);
  // East into the wall (two blocks above the ground at i = 13): stopped.
  const walled = run(
    standingOn(6, 12.5, 5.5, Math.PI / 2),
    { forward: true },
    1,
    world,
  ).at(-1);
  assert.ok(walled.x < 14, `${walled.x}`);
  assert.ok(walled.x > 13.9);
  assert.ok(Math.abs(walled.z - (6 + EYE_HEIGHT_M)) < 1e-9);
  // Off the blocks the step is a kerb: 0.5 m climbed, 0.7 m not.
  const kerb = (h) => field((x, y) => (y > 11 ? h : 0));
  assert.ok(run(standingOn(0), { forward: true }, 1, kerb(0.5)).at(-1).y > 12);
  assert.ok(
    run(standingOn(0), { forward: true }, 1, kerb(0.7)).at(-1).y < 11.01,
  );
});

test('sliding along a wall: the clear part of a diagonal step is taken', () => {
  const world = field((x) => (x > 12 ? 50 : 0));
  const end = run(standingOn(0), { forward: true, right: true }, 2, world).at(
    -1,
  );
  assert.ok(end.x <= 12 && end.x > 11.9, `${end.x}`);
  assert.ok(end.y > 10.5 + 2, 'still going north');
});

test('a walk off a ledge falls; a gentle slope is followed', () => {
  const ledge = field((x, y) => (y > 12 ? 0 : 5));
  const fell = run(standingOn(5), { forward: true }, 1.2, ledge);
  assert.ok(fell.some((s) => !s.onGround && s.y > 12));
  assert.ok(Math.abs(fell.at(-1).z - EYE_HEIGHT_M) < 0.5);
  const slope = field((x, y) => -0.2 * y);
  const down = run(standingOn(-0.2 * 10.5), { forward: true }, 2, slope);
  for (const s of down.slice(1))
    assert.ok(
      Math.abs(s.z - EYE_HEIGHT_M + 0.2 * s.y) < 0.02,
      `${s.z} at ${s.y}`,
    );
});

test('swimming: sink slowly, Space swims up, slower across; out onto the bank', () => {
  // A pool: bed at level 2, water to level 5, banks at 5 around it.
  const pool = [];
  for (let i = 5; i < 20; i += 1)
    for (let j = 5; j < 20; j += 1) pool.push([i, j]);
  const { world } = blocks(5, {
    tops: pool.map(([i, j]) => [i, j, 2]),
    waters: pool.map(([i, j]) => [i, j, 5]),
  });
  const floating = createNavState({ x: 10.5, y: 10.5, z: 5 + EYE_HEIGHT_M });
  const sunk = step(floating, {}, 0.1, world);
  assert.ok(sunk.inWater);
  assert.ok(Math.abs(sunk.z - (floating.z - SINK_M_S * 0.1)) < 1e-9);
  const rising = step(floating, { jump: true }, 0.1, world);
  assert.ok(Math.abs(rising.z - (floating.z + SWIM_UP_M_S * 0.1)) < 1e-9);
  const across = step(floating, { forward: true }, 0.1, world);
  assert.ok(Math.abs(across.y - 10.5 - SWIM_SPEED_M_S * 0.1) < 1e-9);
  // On the bed, still in water.
  const bed = run(floating, {}, 6, world).at(-1);
  assert.ok(Math.abs(bed.z - (3 + EYE_HEIGHT_M)) < 1e-9);
  assert.equal(world.waterAt(10.5, 10.5, 4.5), true);
});

test('fly: no gravity, 10.8 m/s, Space up and Shift down at 7.5 m/s, the ground and blocks stop it', () => {
  const { world } = blocks(5, {
    tops: Array.from({ length: N }, (_, i) => [i, 30, 40]),
  });
  const air = createNavState({ x: 10.5, y: 10.5, z: 20 });
  assert.equal(run(air, {}, 1, world, 'fly').at(-1).z, 20);
  const ahead = run(air, { forward: true }, 1, world, 'fly').at(-1);
  assert.ok(Math.abs(ahead.y - 10.5 - FLY_SPEED_M_S) < 1e-6);
  const up = run(air, { up: true }, 1, world, 'fly').at(-1);
  assert.ok(Math.abs(up.z - 20 - FLY_VERTICAL_M_S) < 1e-6);
  const down = run(air, { down: true }, 3, world, 'fly').at(-1);
  assert.ok(
    Math.abs(down.z - (6 + EYE_HEIGHT_M)) < 1e-9,
    'stops on the ground',
  );
  const wall = run(air, { forward: true }, 3, world, 'fly').at(-1);
  assert.ok(wall.y < 30 && wall.y > 29.9, `${wall.y}`);
});

test('nothing known under the body: hover in place, never fall through', () => {
  const unknown = field(() => Number.NaN);
  const start = createNavState({ x: 0, y: 0, z: 100 });
  const states = run(start, { forward: true }, 2, unknown);
  for (const s of states.slice(1)) {
    assert.equal(s.z, 100);
    assert.equal(s.hovering, true);
  }
  // An unloaded chunk under Blocks is unknown too.
  const { world } = blocks(5);
  const outside = createNavState({ x: -10, y: -10, z: 50 });
  assert.equal(step(outside, {}, DT, world).z, 50);
});

test('a ceiling stops a jump', () => {
  const { world, chunk } = blocks(5);
  chunk.setBlock(10, 10, 8, MATERIALS.TERRAIN);
  // Feet at 6 m; the head at 7.8 m; the block above spans 8 … 9 m.
  const first = step(standingOn(6), { jump: true }, DT, world);
  const states = run(first, {}, 1, world);
  const apex = Math.max(...states.map((s) => s.z - EYE_HEIGHT_M));
  assert.ok(
    apex + BODY_HEIGHT_M <= 8 + 1e-6,
    `head at ${apex + BODY_HEIGHT_M}`,
  );
});

test('a stalled frame is clamped, so it does not tunnel through a wall', () => {
  const world = field((x, y) => (y > 11 && y < 11.2 ? 50 : 0));
  const after = step(standingOn(0), { forward: true }, 5, world);
  assert.ok(after.y - 10.5 <= WALK_SPEED_M_S * MAX_DT_S + 1e-9);
});

test('mouse look: yaw and pitch only, pitch clamped, yaw wrapped', () => {
  const s = createNavState({});
  const turned = look(s, 100, 0);
  assert.ok(Math.abs(turned.yaw - 100 * LOOK_RAD_PER_PX) < 1e-12);
  assert.ok(
    Math.abs(look(s, -100, 0).yaw - (2 * Math.PI - 100 * LOOK_RAD_PER_PX)) <
      1e-12,
  );
  assert.ok(look(s, 0, 100).pitch < 0, 'mouse down looks down');
  assert.equal(look(s, 0, -1e6).pitch, PITCH_LIMIT_RAD);
  assert.equal(look(s, 0, 1e6).pitch, -PITCH_LIMIT_RAD);
  assert.equal('roll' in turned, false);
});

test('70° vertical is the fov across the wider side', () => {
  const deg = (rad) => (rad * 180) / Math.PI;
  const wide = deg(cesiumFovRad(70, 1600, 900));
  const expected = deg(
    2 * Math.atan(Math.tan((35 * Math.PI) / 180) * (16 / 9)),
  );
  assert.ok(Math.abs(wide - expected) < 1e-9);
  assert.ok(wide > 100 && wide < 105, `${wide}`);
  assert.ok(Math.abs(deg(cesiumFovRad(70, 600, 900)) - 70) < 1e-9, 'portrait');
  assert.ok(Math.abs(deg(cesiumFovRad(70, 0, 0)) - 70) < 1e-9);
});

test('the looked-at block: a ray through occupancy to the first solid one', () => {
  const { world } = blocks(5, { tops: [[10, 15, 9]] });
  // From (10.5, 10.5) at 7 m looking north: the raised column at j = 15.
  const hit = world.raycast({ x: 10.5, y: 10.5, z: 7 }, { x: 0, y: 1, z: 0 });
  assert.deepEqual([hit.i, hit.j, hit.y], [10, 15, 7]);
  assert.deepEqual(hit.face, [0, -1, 0]);
  assert.ok(Math.abs(hit.distanceM - 4.5) < 1e-9);
  // Looking down: the ground under the feet.
  const ground = world.raycast(
    { x: 3.5, y: 3.5, z: 7.62 },
    { x: 0, y: 0, z: -1 },
  );
  assert.deepEqual(
    [ground.i, ground.j, ground.y, ground.face[2]],
    [3, 3, 5, 1],
  );
  // At the sky: none.
  assert.equal(
    world.raycast({ x: 3.5, y: 3.5, z: 7 }, { x: 0, y: 0, z: 1 }, 20),
    null,
  );
});

test('the heightfield is sampled once per cell and asked again later', () => {
  let asked = 0;
  let time = 0;
  const world = createHeightfieldWorld({
    sample: () => {
      asked += 1;
      return 3;
    },
    cellM: 1,
    ttlMs: 1000,
    now: () => time,
  });
  world.surfaceAt(0.2, 0.2);
  world.surfaceAt(0.9, 0.7);
  assert.equal(asked, 1);
  time = 1500;
  world.surfaceAt(0.5, 0.5);
  assert.equal(asked, 2);
  assert.equal(world.blocked(0, 0, 2.9), true);
  assert.equal(world.blocked(0, 0, 3), false);
});

// ── Buildings (the store's structures layer, src/layers/blocks/structures.js)

/**
 * A one-chunk world flat at level 5 (its top at 6 m) with buildings put by
 * setStructure: `walls` as [i0, i1, j0, j1, height in blocks] boxes.
 */
function withBuildings(walls) {
  const { chunk, world } = blocks(5);
  for (const [i0, i1, j0, j1, height] of walls)
    for (let i = i0; i <= i1; i += 1)
      for (let j = j0; j <= j1; j += 1)
        chunk.setStructure(i, j, 5 + height, MATERIALS.BUILDING);
  return { chunk, world };
}

test('buildings: a 2-block wall stops a walker, who slides along it', () => {
  // A wall two blocks tall along j = 14, from i = 0 to 40.
  const { world } = withBuildings([[0, 40, 14, 14, 2]]);
  assert.equal(world.occupancy(10, 14, 7), MATERIALS.BUILDING);
  // Straight at it: stopped short of j = 14, on the ground.
  const straight = run(standingOn(6), { forward: true }, 2, world).at(-1);
  assert.ok(straight.y < 14 && straight.y > 13.9, `${straight.y}`);
  assert.ok(Math.abs(straight.z - (6 + EYE_HEIGHT_M)) < 1e-9);
  // At 45° (forward and right): along the wall to the east.
  const slid = run(standingOn(6), { forward: true, right: true }, 2, world).at(
    -1,
  );
  assert.ok(slid.y < 14, `${slid.y}`);
  assert.ok(slid.x > 10.5 + 2, `slid east to ${slid.x}`);
});

test('buildings: a 1-block ledge is stepped up; a 2-block one is not, even jumping; a jump lands on a 1-block one', () => {
  // A 1-block plinth from j = 12 north, a 2-block one from i = 14 east.
  const { world } = withBuildings([
    [0, 13, 12, 40, 1],
    [14, 40, 0, 40, 2],
  ]);
  const stepped = run(standingOn(6), { forward: true }, 1, world).at(-1);
  assert.ok(stepped.y > 12.5, `${stepped.y}`);
  assert.ok(Math.abs(stepped.z - (7 + EYE_HEIGHT_M)) < 1e-9, 'on the plinth');
  // East at the 2-block one, walking and jumping: never up on it, and
  // back on the ground once the keys are let go.
  const east = standingOn(6, 12.5, 5.5, Math.PI / 2);
  for (const input of [{ forward: true }, { forward: true, jump: true }]) {
    const states = run(east, input, 2, world);
    assert.ok(
      states.every((s) => s.x < 14),
      JSON.stringify(input),
    );
    const end = run(states.at(-1), {}, 1, world).at(-1);
    assert.ok(end.onGround && Math.abs(end.z - (6 + EYE_HEIGHT_M)) < 1e-9);
    assert.ok(end.x > 13.99, `at the wall: ${end.x}`);
  }
  // A jump (1.25 m) clears a 1-block ledge in mid-air and lands on it.
  const { world: ledge } = withBuildings([[0, 40, 11, 40, 1]]);
  // One jump, then walking on: up in mid-air, down on the ledge.
  const takeoff = step(
    standingOn(6, 10.5, 10.2),
    { jump: true, forward: true },
    DT,
    ledge,
  );
  const leap = run(takeoff, { forward: true }, 0.8, ledge);
  assert.ok(
    leap.some((s) => !s.onGround),
    'airborne',
  );
  const landed = leap.at(-1);
  assert.ok(landed.y > 11 && landed.onGround, `${landed.y}`);
  assert.ok(Math.abs(landed.z - (7 + EYE_HEIGHT_M)) < 1e-9);
});

test('buildings: inside a hollow building the ceiling stops a jump', () => {
  // A 6-block building over (5…15, 5…15); a room 3 blocks tall carved out
  // of it (levels 6 to 8), as a structure with a bottom would leave it.
  const { chunk, world } = withBuildings([[5, 15, 5, 15, 6]]);
  for (let i = 6; i <= 14; i += 1)
    for (let j = 6; j <= 14; j += 1)
      for (let y = 6; y <= 8; y += 1) chunk.setBlock(i, j, y, MATERIALS.AIR);
  // Standing on the floor (6 m): the head at 7.8 m, the ceiling at 9 m.
  const floor = world.surfaceBelow(10.5, 10.5, 6.1);
  assert.equal(floor, 6, 'the floor, not the roof');
  const first = step(standingOn(6), { jump: true }, DT, world);
  const states = run(first, {}, 1, world);
  const apex = Math.max(...states.map((s) => s.z - EYE_HEIGHT_M));
  assert.ok(
    apex + BODY_HEIGHT_M <= 9 + 1e-6,
    `head at ${apex + BODY_HEIGHT_M}`,
  );
  assert.ok(apex > 6.9, 'it did jump');
  assert.ok(states.at(-1).onGround);
  // Walking at the inner wall stops there too.
  const wall = run(standingOn(6), { forward: true }, 2, world).at(-1);
  assert.ok(wall.y < 15 && wall.y > 14.9, `${wall.y}`);
});

test('buildings: Fly collides with a building and comes to rest on its roof', () => {
  const { world } = withBuildings([[5, 15, 14, 24, 10]]);
  // Flying north at 10 m (inside the building's height): stopped at its wall.
  const air = createNavState({ x: 10.5, y: 8.5, z: 10 + EYE_HEIGHT_M });
  const wall = run(air, { forward: true }, 2, world, 'fly').at(-1);
  assert.ok(wall.y < 14 && wall.y > 13.9, `${wall.y}`);
  // Above the roof (16 m) and descending: it rests on the roof.
  const above = createNavState({ x: 10.5, y: 18.5, z: 25 });
  const roof = run(above, { down: true }, 3, world, 'fly').at(-1);
  assert.ok(Math.abs(roof.z - (16 + EYE_HEIGHT_M)) < 1e-9, `${roof.z}`);
  assert.equal(roof.onGround, true);
  assert.equal(roof.hovering, false);
  // And holds there with nothing pressed.
  assert.equal(run(roof, {}, 1, world, 'fly').at(-1).z, roof.z);
});

test('buildings: the looked-at block is the wall, a building block', () => {
  const { world } = withBuildings([[0, 40, 14, 14, 3]]);
  // From the eye (10.5, 10.5, 7.62) looking north: the wall at j = 14.
  const hit = world.raycast(
    { x: 10.5, y: 10.5, z: 7.62 },
    { x: 0, y: 1, z: 0 },
  );
  assert.deepEqual([hit.i, hit.j, hit.y], [10, 14, 7]);
  assert.deepEqual(hit.face, [0, -1, 0]);
  assert.equal(world.occupancy(hit.i, hit.j, hit.y), MATERIALS.BUILDING);
});
