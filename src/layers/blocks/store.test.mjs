// Personal fork: the Blocks chunk store (src/layers/blocks/store.js): what
// occupies a point, with and without the edits overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK_COLUMNS, columnIndex } from './grid.js';
import { MATERIALS, NONE, applyEdits, createChunk, isSolid } from './store.js';

const { AIR, TERRAIN, WATER } = MATERIALS;
const COLUMNS = CHUNK_COLUMNS ** 2;

/** A chunk flat at a level, with optional per-column changes. */
function flatChunk(level, { tops = {}, waters = {} } = {}) {
  const top = new Int32Array(COLUMNS).fill(level);
  const water = new Int32Array(COLUMNS).fill(NONE);
  for (const [k, v] of Object.entries(tops)) top[Number(k)] = v;
  for (const [k, v] of Object.entries(waters)) water[Number(k)] = v;
  return createChunk({ ci: 0, cj: 0, top, water });
}

test('a filled column: its material up to the top, air above', () => {
  const chunk = flatChunk(5);
  assert.equal(chunk.occupancy(3, 4, 5), TERRAIN);
  assert.equal(
    chunk.occupancy(3, 4, -1000),
    TERRAIN,
    'filled all the way down',
  );
  assert.equal(chunk.occupancy(3, 4, 6), AIR);
  assert.equal(chunk.topSolid(3, 4), 5);
  assert.equal(chunk.version, 0);
  assert.deepEqual([...chunk.edits], []);
  assert.ok(isSolid(TERRAIN) && !isSolid(WATER) && !isSolid(AIR));
  assert.throws(() => chunk.occupancy(64, 0, 0), RangeError);
  assert.throws(() => createChunk({ top: new Int32Array(3) }), TypeError);
});

test('a block set above the top is solid there, and becomes the top', () => {
  const chunk = flatChunk(5);
  chunk.setBlock(10, 10, 8, TERRAIN);
  assert.equal(chunk.occupancy(10, 10, 8), TERRAIN);
  assert.equal(chunk.occupancy(10, 10, 7), AIR, 'floating: air beneath it');
  assert.equal(chunk.topSolid(10, 10), 8);
  assert.equal(chunk.topSolid(11, 10), 5, 'the neighbour is untouched');
  assert.equal(chunk.version, 1);
  assert.deepEqual(
    [...chunk.edits],
    [{ i: 10, j: 10, y: 8, material: TERRAIN }],
  );
  assert.deepEqual(chunk.columnEdits(10, 10), [[8, TERRAIN]]);
});

test('the top block removed: air there, the top one lower; put back, no edit left', () => {
  const chunk = flatChunk(5);
  chunk.setBlock(2, 3, 5, AIR);
  assert.equal(chunk.occupancy(2, 3, 5), AIR);
  assert.equal(chunk.topSolid(2, 3), 4);
  chunk.setBlock(2, 3, 4, AIR);
  assert.equal(chunk.topSolid(2, 3), 3);
  assert.equal(chunk.version, 2);
  // Putting the heightfield's own block back drops the edit.
  chunk.setBlock(2, 3, 5, TERRAIN);
  chunk.setBlock(2, 3, 4, TERRAIN);
  assert.deepEqual([...chunk.edits], []);
  assert.equal(chunk.topSolid(2, 3), 5);
  assert.equal(chunk.version, 4);
  // An edit that changes nothing does not bump the version.
  chunk.setBlock(2, 3, 9, AIR);
  assert.equal(chunk.version, 4);
});

test('a water column: water from above the bed to the surface, air above', () => {
  const index = columnIndex(7, 7);
  const chunk = flatChunk(5, { tops: { [index]: 2 }, waters: { [index]: 5 } });
  assert.equal(chunk.occupancy(7, 7, 2), TERRAIN);
  for (const y of [3, 4, 5]) assert.equal(chunk.occupancy(7, 7, y), WATER);
  assert.equal(chunk.occupancy(7, 7, 6), AIR);
  assert.equal(chunk.topSolid(7, 7), 2, 'water is not solid');
  // A block dropped into the water displaces it.
  chunk.setBlock(7, 7, 3, TERRAIN);
  assert.equal(chunk.topSolid(7, 7), 3);
  assert.equal(chunk.occupancy(7, 7, 4), WATER);
  // Sea: the bed below level 0, water at level 0.
  const sea = flatChunk(-3, { waters: { [columnIndex(0, 0)]: 0 } });
  assert.equal(sea.occupancy(0, 0, 0), WATER);
  assert.equal(sea.occupancy(0, 0, -3), TERRAIN);
  assert.equal(sea.occupancy(1, 0, 0), AIR);
});

test('a column without data is air, and an edit there is its top', () => {
  const index = columnIndex(0, 63);
  const chunk = flatChunk(5, { tops: { [index]: NONE } });
  assert.equal(chunk.occupancy(0, 63, 0), AIR);
  assert.equal(chunk.topSolid(0, 63), NONE);
  chunk.setBlock(0, 63, 1, TERRAIN);
  assert.equal(chunk.topSolid(0, 63), 1);
});

test('edits serialise per chunk and apply again', () => {
  const chunk = flatChunk(5);
  chunk.setBlock(1, 1, 6, TERRAIN);
  chunk.setBlock(2, 2, 5, AIR);
  const saved = JSON.parse(JSON.stringify(chunk));
  assert.equal(saved.edits.length, 2);
  const again = applyEdits(flatChunk(5), saved.edits);
  assert.equal(again.occupancy(1, 1, 6), TERRAIN);
  assert.equal(again.occupancy(2, 2, 5), AIR);
});
