// Personal fork: the Blocks pyramid (src/layers/blocks/pyramid.js): the
// block sizes, the level a native cell and a wanted block pick, and the
// level heights.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BLOCK_PYRAMID_M, levelMFor, pyramidLevelM } from './pyramid.js';

test('BLOCK_PYRAMID_M: the native cells, then ×4 from 30 m', () => {
  assert.deepEqual(
    [...BLOCK_PYRAMID_M],
    [1, 2, 8, 10, 30, 120, 480, 1920, 7680, 30720],
  );
  assert.ok(Object.isFrozen(BLOCK_PYRAMID_M));
});

test('pyramidLevelM: the smallest level at least both; NaN wanted is the native cell; off-pyramid snaps up; capped at the top', () => {
  assert.equal(pyramidLevelM(1, 0.4), 1);
  assert.equal(pyramidLevelM(1, 3), 8);
  assert.equal(pyramidLevelM(30, 31), 120);
  assert.equal(pyramidLevelM(30, 1920), 1920);
  assert.equal(pyramidLevelM(10, 2000), 7680);
  for (const wanted of [NaN, undefined, null, 0, -5, Infinity, '12'])
    assert.equal(pyramidLevelM(10, wanted), 10, String(wanted));
  assert.equal(pyramidLevelM(231, NaN), 480); // the ocean's cell
  assert.equal(pyramidLevelM(231, 100), 480);
  assert.equal(pyramidLevelM(4, NaN), 8);
  assert.equal(pyramidLevelM(30, 1e9), 30720);
  assert.equal(pyramidLevelM(1e6, NaN), 30720);
});

test('levelMFor: a cube to 30 m, then max(30 m, blockM / 32)', () => {
  for (const blockM of [1, 2, 8, 10, 30])
    assert.equal(levelMFor(blockM), blockM);
  assert.equal(levelMFor(120), 30);
  assert.equal(levelMFor(480), 30);
  assert.equal(levelMFor(1920), 60);
  assert.equal(levelMFor(7680), 240);
  assert.equal(levelMFor(30720), 960);
});
