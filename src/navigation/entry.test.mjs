// Personal fork: the way into Walk or Fly and back out
// (src/navigation/entry.js): the walker's pose on a targeted block and the
// view leaving lifts to.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT_BACK_M,
  EXIT_UP_M,
  entryPose,
  exitView,
  standingLevel,
} from './entry.js';
import { EYE_HEIGHT_M, PITCH_LIMIT_RAD } from './movement.js';
import { MATERIALS } from '../layers/blocks/store.js';

/** Ground at level 30 everywhere; a wall at j = 20 up to level 35. */
const occupancy = (i, j, y) => {
  if (i < 0) return null;
  if (y <= 30) return MATERIALS.TERRAIN;
  if (j === 20 && y <= 35) return MATERIALS.BUILDING;
  return MATERIALS.AIR;
};
const facts = (i, j, y, blockM = 1) => ({ i, j, y, blockM });

test('walk here on a ground block: its column centre, the eye 1.62 m over its top, the heading and pitch kept', () => {
  const pose = entryPose({
    facts: facts(10, 5, 30),
    occupancy,
    headingRad: 1.2,
    pitchRad: -0.4,
  });
  assert.equal(pose.x, 10.5);
  assert.equal(pose.y, 5.5);
  assert.equal(pose.z, 31 + EYE_HEIGHT_M);
  assert.equal(pose.yaw, 1.2);
  assert.equal(pose.pitch, -0.4);
  assert.equal(pose.level, 30);
});

test('walk here on a wall face: on top of the wall; at 30 m blocks; the pitch kept inside the limit', () => {
  // The wall's face at level 32: the walker stands on its top (level 35).
  assert.equal(standingLevel(occupancy, facts(10, 20, 32)), 35);
  const onWall = entryPose({ facts: facts(10, 20, 32), occupancy });
  assert.equal(onWall.z, 36 + EYE_HEIGHT_M);
  // An unloaded block above stops the climb where it is.
  assert.equal(
    standingLevel(() => null, facts(-5, 0, 3)),
    3,
  );
  // 30 m blocks: metres scale.
  const coarse = entryPose({ facts: facts(2, 3, 30, 30), occupancy });
  assert.deepEqual(
    [coarse.x, coarse.y, coarse.z],
    [75, 105, 31 * 30 + EYE_HEIGHT_M],
  );
  // A camera looking straight down: the walker's pitch stops at the limit.
  assert.equal(
    entryPose({ facts: facts(0, 0, 30), occupancy, pitchRad: -Math.PI / 2 })
      .pitch,
    -PITCH_LIMIT_RAD,
  );
});

test('leaving: 60 m back along the heading and 60 m up, looking at where the feet stood', () => {
  assert.equal(EXIT_BACK_M, 60);
  assert.equal(EXIT_UP_M, 60);
  const north = exitView({ yaw: 0 });
  assert.ok(Math.abs(north.east) < 1e-12);
  assert.equal(north.north, -60);
  assert.equal(north.up, 60);
  assert.equal(north.heading, 0);
  // The feet are EYE_HEIGHT_M below the eye: the view looks down at them.
  const toFeet = Math.atan2(60 + EYE_HEIGHT_M, 60);
  assert.ok(Math.abs(north.pitch + toFeet) < 1e-12);
  assert.ok(north.pitch < -Math.PI / 4, 'a little steeper than 45°');
  // Facing east: the view is west of the walker.
  const east = exitView({ yaw: Math.PI / 2 });
  assert.ok(Math.abs(east.east + 60) < 1e-9 && Math.abs(east.north) < 1e-9);
  // The line of sight from the view passes through the feet.
  const view = exitView({ yaw: 0.7 });
  const along = Math.hypot(view.east, view.north);
  const drop = Math.tan(-view.pitch) * along;
  assert.ok(Math.abs(drop - (view.up + EYE_HEIGHT_M)) < 1e-9);
});

test('walking onto a 120 m block on 30 m levels: the eye 1.62 m over its top at (level + 1) × 30 m', () => {
  const occupancy = (i, j, y) => (y <= 3 ? MATERIALS.TERRAIN : MATERIALS.AIR);
  const pose = entryPose({
    facts: { i: 5, j: 5, y: 3, blockM: 120, levelM: 30 },
    occupancy,
  });
  assert.equal(pose.x, 5.5 * 120);
  assert.equal(pose.y, 5.5 * 120);
  assert.ok(Math.abs(pose.z - (120 + EYE_HEIGHT_M)) < 1e-9);
  assert.equal(pose.level, 3);
});
