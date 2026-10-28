// Personal fork: the targeted block (src/navigation/target.js,
// targeting.js, src/hud/blockTarget.js): the facts about a block a ray
// meets, the HUD's BLOCK line for them, and the live targeting on a fake
// scene: the mouse pointer in Spectator, the crosshair in Walk, the depth
// pick where the ray starts outside the loaded chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  CHUNK_COLUMNS,
  columnIndex,
  createRegion,
} from '../layers/blocks/grid.js';
import { MATERIALS, NONE, createChunk } from '../layers/blocks/store.js';
import { blockFacts, sameBlock, snapToBlock } from './target.js';
import {
  createBlockTargeting,
  regionFrame,
  targetAlongRay,
} from './targeting.js';
import { blockDegreeDecimals, formatBlockTarget } from '../hud/blockTarget.js';
import { createNavigationStore } from './store.js';

const N = CHUNK_COLUMNS;
const GEOID_M = -33;

/**
 * A Blocks world of 1 m blocks at Baltimore: one chunk flat at level 30,
 * a raised column at (10, 20) to level 33, a building on (12, 20) to 40
 * and a pond at (30, 30).
 */
function world({ blockM = 1 } = {}) {
  const region = createRegion({ lon0: -76.6122, lat0: 39.2904, blockM });
  const top = new Int32Array(N * N).fill(30);
  const water = new Int32Array(N * N).fill(NONE);
  top[columnIndex(10, 20)] = 33;
  top[columnIndex(30, 30)] = 27;
  water[columnIndex(30, 30)] = 30;
  const chunk = createChunk({ ci: 0, cj: 0, top, water });
  chunk.setStructure(12, 20, 40);
  return {
    region,
    geoidM: GEOID_M,
    sourceName: '3DEP 1 m',
    chunk,
    chunkAt: (ci, cj) => (ci === 0 && cj === 0 ? chunk : null),
  };
}

/** A region point (metres, z above sea level) as a world point. */
function toWorld(w, x, y, z) {
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(w.region.lon0, w.region.lat0, 0),
  );
  const chunkM = N * w.region.blockM;
  const drop = w.region.chunkOrigin(
    Math.floor(x / chunkM),
    Math.floor(y / chunkM),
  ).z;
  return Cesium.Matrix4.multiplyByPoint(
    frame,
    new Cesium.Cartesian3(x, y, z + w.geoidM + drop),
    new Cesium.Cartesian3(),
  );
}

const rayBetween = (from, to) =>
  new Cesium.Ray(
    from,
    Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(to, from, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
  );

test('snap: a picked point on a face belongs to the block behind it along the ray', () => {
  // The top of level 30 (31 m), looked at from above: block 30.
  assert.deepEqual(
    snapToBlock({ x: 5.2, y: 7.9, z: 31 }, { x: 0, y: 0, z: -1 }, 1),
    {
      i: 5,
      j: 7,
      y: 30,
    },
  );
  // A south face at y = 20 m, looked at from the south: block j = 20.
  assert.deepEqual(
    snapToBlock({ x: 10.5, y: 20, z: 32.5 }, { x: 0, y: 1, z: 0 }, 1),
    { i: 10, j: 20, y: 32 },
  );
  // 30 m blocks.
  assert.deepEqual(
    snapToBlock({ x: 95, y: -1, z: 60 }, { x: 0, y: 0, z: -1 }, 30),
    {
      i: 3,
      j: -1,
      y: 1,
    },
  );
});

test('the facts: column centre, level and height, material, chunk; air or unloaded is none', () => {
  const w = world();
  const facts = blockFacts(
    w,
    { i: 10, j: 20, y: 33, face: [0, -1, 0] },
    w.sourceName,
  );
  const centre = w.region.columnCentre(10, 20);
  assert.equal(facts.lon, centre.lon);
  assert.equal(facts.lat, centre.lat);
  assert.equal(facts.level, 33);
  assert.equal(facts.baseM, 33);
  assert.equal(facts.topM, 34);
  assert.equal(facts.materialName, 'terrain');
  assert.equal(facts.chunkKey, '0:0');
  assert.deepEqual(facts.face, [0, -1, 0]);
  assert.equal(blockFacts(w, { i: 12, j: 20, y: 38 }).materialName, 'building');
  assert.equal(blockFacts(w, { i: 30, j: 30, y: 27 }).materialName, 'terrain');
  assert.equal(blockFacts(w, { i: 10, j: 20, y: 34 }), null, 'air');
  assert.equal(
    blockFacts(w, { i: 30, j: 30, y: 29 }),
    null,
    'water is not a block to target',
  );
  assert.equal(blockFacts(w, { i: -1, j: 5, y: 30 }), null, 'not loaded');
  assert.ok(sameBlock(facts, { ...facts }));
  assert.ok(!sameBlock(facts, { ...facts, y: 32 }));
});

test('the BLOCK line: the place to half a block, level and height, material, source; the chunk in the tooltip', () => {
  const w = world();
  const facts = blockFacts(w, { i: 10, j: 20, y: 33 }, '3DEP 1 m');
  const line = formatBlockTarget(facts);
  assert.equal(blockDegreeDecimals(1), 6);
  assert.equal(blockDegreeDecimals(30), 4);
  assert.equal(
    line.text,
    `${facts.lat.toFixed(6)} ${facts.lon.toFixed(6)} · L33 (33 m) · terrain · 3DEP 1 m`,
  );
  assert.equal(line.title, 'Chunk 0:0, column 10 20, level 33: 1 m blocks');
  const building = formatBlockTarget(blockFacts(w, { i: 12, j: 20, y: 40 }));
  assert.match(building.text, / · L40 \(40 m\) · building$/);
  // 30 m blocks: four decimals, the base of level 47 at 1,410 m.
  const coarse = formatBlockTarget({
    ...facts,
    blockM: 30,
    level: 47,
    baseM: 1410,
    sourceName: 'GLO-30',
  });
  assert.equal(
    coarse.text,
    `${facts.lat.toFixed(4)} ${facts.lon.toFixed(4)} · L47 (1,410 m) · terrain · GLO-30`,
  );
  assert.equal(formatBlockTarget(null), null);
});

test('along a ray: through occupancy to the first solid block; the depth pick when the ray starts outside', () => {
  const w = world();
  // From (10.5, 5.5) at 40 m towards the raised column's south face.
  const eye = toWorld(w, 10.5, 5.5, 40);
  const facts = targetAlongRay(
    w,
    rayBetween(eye, toWorld(w, 10.5, 20.5, 33.5)),
  );
  assert.deepEqual([facts.i, facts.j, facts.y], [10, 20, 33]);
  assert.deepEqual(facts.face, [0, -1, 0]);
  // The frame round-trips a region point.
  const local = regionFrame(w).toLocal(toWorld(w, 3.25, 7.5, 31));
  assert.ok(Math.abs(local.x - 3.25) < 1e-6 && Math.abs(local.z - 31) < 1e-6);
  // From outside the loaded chunk: occupancy is unknown at the start, so
  // the depth pick there (the top of (5, 5)), snapped.
  const outside = toWorld(w, -40, 5.5, 60);
  const ground = toWorld(w, 5.5, 5.5, 31);
  const picked = targetAlongRay(w, rayBetween(outside, ground), {
    pickPosition: () => ground,
  });
  assert.deepEqual([picked.i, picked.j, picked.y], [5, 5, 30]);
  assert.equal(
    targetAlongRay(w, rayBetween(outside, ground)),
    null,
    'no depth pick: nothing',
  );
});

/** A fake viewer: a camera, a canvas with pointer events, postRender. */
function fakeViewer(w) {
  const listeners = {};
  const renders = new Set();
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    addEventListener: (type, f) => (listeners[type] = f),
    removeEventListener: (type) => delete listeners[type],
  };
  const camera = {
    positionWC: toWorld(w, 10.5, 5.5, 40),
    directionWC: new Cesium.Cartesian3(),
    pickRays: [],
    // The pick ray through a pointer: towards whatever the test aimed at.
    aim: null,
    getPickRay(at) {
      this.pickRays.push([at.x, at.y]);
      return this.aim ? rayBetween(this.positionWC, this.aim) : undefined;
    },
  };
  const scene = {
    canvas,
    pickPositionSupported: true,
    picked: undefined,
    pickPosition() {
      return this.picked;
    },
    postRender: {
      addEventListener(f) {
        renders.add(f);
        return () => renders.delete(f);
      },
    },
  };
  return {
    viewer: { scene, camera },
    camera,
    scene,
    fire: (type, event) => listeners[type]?.(event),
    render: () => [...renders].forEach((f) => f()),
    listeners,
    renders,
  };
}

test('Spectator: the block under the mouse pointer, through the pick ray there; leaving the canvas clears it', () => {
  const w = world();
  const store = createNavigationStore({ initial: 'spectator' });
  const fake = fakeViewer(w);
  const heard = [];
  let time = 0;
  const targeting = createBlockTargeting({
    viewer: fake.viewer,
    store,
    blocks: () => w,
    onTarget: (facts) => heard.push(facts),
    now: () => time,
  });
  // No pointer yet: nothing targeted, nothing said.
  fake.render();
  assert.deepEqual(heard, []);
  fake.camera.aim = toWorld(w, 10.5, 20.5, 33.5);
  fake.fire('pointermove', { clientX: 500, clientY: 350 });
  assert.deepEqual(fake.camera.pickRays.at(-1), [400, 300], 'canvas pixels');
  assert.equal(heard.length, 1);
  assert.deepEqual([heard[0].i, heard[0].j, heard[0].level], [10, 20, 33]);
  assert.equal(heard[0].sourceName, '3DEP 1 m');
  // The same block again: not said twice.
  time += 500;
  fake.render();
  assert.equal(heard.length, 1);
  // Onto the building.
  fake.camera.aim = toWorld(w, 12.5, 20.5, 36.5);
  fake.fire('pointermove', { clientX: 520, clientY: 340 });
  assert.equal(heard.at(-1).materialName, 'building');
  // Off the canvas: none.
  fake.fire('pointerleave', {});
  assert.equal(heard.at(-1), null);
  assert.equal(targeting.target, null);
  targeting.destroy();
  assert.equal(fake.renders.size, 0);
  assert.equal(fake.listeners.pointermove, undefined);
});

test('Walk: the block under the crosshair (the camera’s direction); Blocks off: none', () => {
  const w = world();
  const store = createNavigationStore({ initial: 'walk' });
  const fake = fakeViewer(w);
  // Straight down at (3.5, 3.5): the ground block (3, 3, 30).
  fake.camera.positionWC = toWorld(w, 3.5, 3.5, 32.62);
  Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(
      toWorld(w, 3.5, 3.5, 20),
      fake.camera.positionWC,
      new Cesium.Cartesian3(),
    ),
    fake.camera.directionWC,
  );
  let on = true;
  const heard = [];
  const targeting = createBlockTargeting({
    viewer: fake.viewer,
    store,
    blocks: () => (on ? w : null),
    onTarget: (facts) => heard.push(facts),
    now: () => 0,
  });
  targeting.update();
  assert.deepEqual([heard[0].i, heard[0].j, heard[0].y], [3, 3, 30]);
  assert.deepEqual(heard[0].face, [0, 0, 1]);
  assert.equal(fake.camera.pickRays.length, 0, 'no pointer in Walk');
  on = false;
  targeting.update();
  assert.equal(heard.at(-1), null);
  targeting.destroy();
});

test('a 120 m block on 30 m levels: the targeted block’s base and top in metres, the BLOCK line names both', () => {
  const region = createRegion({
    lon0: -76.6122,
    lat0: 39.2904,
    blockM: 120,
    levelM: 30,
  });
  const top = new Int32Array(N * N).fill(2);
  top[columnIndex(5, 5)] = 3;
  const chunk = createChunk({
    ci: 0,
    cj: 0,
    top,
    water: new Int32Array(N * N).fill(NONE),
  });
  const w = {
    region,
    chunkAt: (ci, cj) => (ci === 0 && cj === 0 ? chunk : null),
    sourceName: 'Pyramid 120 m',
  };
  const facts = blockFacts(
    w,
    { i: 5, j: 5, y: 3, face: [0, 0, 1] },
    w.sourceName,
  );
  assert.equal(facts.baseM, 90);
  assert.equal(facts.topM, 120);
  assert.equal(facts.blockM, 120);
  assert.equal(facts.levelM, 30);
  const line = formatBlockTarget(facts);
  assert.match(line.text, / · L3 \(90 m\) · terrain · Pyramid 120 m$/);
  assert.equal(
    line.title,
    'Chunk 0:0, column 5 5, level 3: 120 m blocks on 30 m levels',
  );
  // A cube's title as before.
  const cubeFacts = blockFacts(world(), { i: 10, j: 20, y: 33 });
  assert.equal(
    formatBlockTarget(cubeFacts).title,
    'Chunk 0:0, column 10 20, level 33: 1 m blocks',
  );
  // A picked point snaps by levels of 30 m: 95 m is level 3.
  assert.deepEqual(
    snapToBlock({ x: 660, y: 660, z: 95 }, { x: 0, y: 0, z: -1 }, 120, 30),
    { i: 5, j: 5, y: 3 },
  );
  // Not the same block as a cube's at the same indices.
  assert.equal(sameBlock(facts, { ...facts, levelM: 120 }), false);
});
