// Personal fork: third person and the compass (src/navigation/view.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_MARGIN_M,
  MIN_CAMERA_M,
  THIRD_PERSON_M,
  VIEW_STORAGE_KEY,
  bearingDeg,
  clearanceM,
  compassAngles,
  createViewStore,
  lookDirection,
  markerPose,
  nextView,
  thirdPersonPose,
} from './view.js';
import { EYE_HEIGHT_M } from './movement.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test('views cycle first → behind → in front, kept in this browser', () => {
  assert.equal(nextView('first'), 'back');
  assert.equal(nextView('back'), 'front');
  assert.equal(nextView('front'), 'first');
  assert.equal(nextView('nonsense'), 'first');
  const storage = memoryStorage();
  const store = createViewStore({ storage });
  assert.equal(store.get(), 'first');
  const seen = [];
  store.subscribe((view) => seen.push(view));
  store.cycle();
  store.cycle();
  assert.deepEqual(seen, ['back', 'front']);
  assert.equal(storage.map.get(VIEW_STORAGE_KEY), 'front');
  assert.equal(createViewStore({ storage }).get(), 'front');
  assert.equal(store.set('sideways'), false);
  storage.map.set(VIEW_STORAGE_KEY, 'bogus');
  assert.equal(createViewStore({ storage }).get(), 'first');
});

test('third person: 4 m behind the eye looking the same way, or in front looking back; first person is the eye', () => {
  const state = { x: 10, y: 20, z: 31.62, yaw: 0, pitch: 0 };
  assert.deepEqual(thirdPersonPose(state, 'first'), {
    x: 10,
    y: 20,
    z: 31.62,
    yaw: 0,
    pitch: 0,
    distanceM: 0,
  });
  // Facing north, level: behind is 4 m south.
  const back = thirdPersonPose(state, 'back');
  assert.ok(near(back.x, 10) && near(back.y, 16) && near(back.z, 31.62));
  assert.equal(back.yaw, 0);
  assert.equal(back.distanceM, THIRD_PERSON_M);
  // In front: 4 m north, turned round, looking back at the walker.
  const front = thirdPersonPose(state, 'front');
  assert.ok(near(front.y, 24));
  assert.ok(near(Math.abs(front.yaw), Math.PI));
  // Looking 30° down while facing east: behind is west and up.
  const down = { ...state, yaw: Math.PI / 2, pitch: -Math.PI / 6 };
  const b = thirdPersonPose(down, 'back');
  assert.ok(near(b.x, 10 - 4 * Math.cos(Math.PI / 6), 1e-9));
  assert.ok(near(b.z, 31.62 + 4 * Math.sin(Math.PI / 6), 1e-9));
  assert.equal(b.pitch, down.pitch);
  const f = thirdPersonPose(down, 'front');
  assert.ok(near(f.pitch, Math.PI / 6), 'in front it looks up at the face');
  // The look direction is a unit vector.
  const d = lookDirection(0.7, -0.3);
  assert.ok(near(Math.hypot(d.x, d.y, d.z), 1));
});

test('the camera is pulled in short of a block or the surface between it and the eye', () => {
  const state = { x: 0, y: 0, z: 11.62, yaw: 0, pitch: 0 };
  // A block world: a wall 2 m behind the eye.
  const blocks = {
    raycast(origin, direction, maxM) {
      if (direction.y < 0) return { distanceM: 2 };
      return maxM >= 100 ? { distanceM: 100 } : null;
    },
  };
  const pulled = thirdPersonPose(state, 'back', { world: blocks });
  assert.ok(near(pulled.distanceM, 2 - CAMERA_MARGIN_M));
  assert.ok(near(pulled.y, -(2 - CAMERA_MARGIN_M)));
  // Nothing in front: the full 4 m.
  assert.equal(thirdPersonPose(state, 'front', { world: blocks }).distanceM, 4);
  // Inside a wall: never nearer than MIN_CAMERA_M.
  const wall = { raycast: () => ({ distanceM: 0 }) };
  assert.equal(
    thirdPersonPose(state, 'back', { world: wall }).distanceM,
    MIN_CAMERA_M,
  );
  // A heightfield world (no raycast): looking down behind, the ground rises
  // to 12 m (over the 11.62 m eye) at 1 m south and beyond.
  const ground = { surfaceBelow: (x, y) => (y <= -1 ? 12 : 0) };
  const steep = { ...state, pitch: 0 };
  const clear = clearanceM(ground, state, { x: 0, y: -1, z: 0 }, 4);
  assert.ok(clear <= 1 && clear >= 0.75, String(clear));
  const onGround = thirdPersonPose(steep, 'back', { world: ground });
  assert.ok(onGround.distanceM < 1, String(onGround.distanceM));
  assert.equal(
    clearanceM({}, state, { x: 0, y: -1, z: 0 }, 4),
    4,
    'no world: clear',
  );
});

test('the marker stands on the walker’s feet: its centre 0.9 m up, turned to the heading', () => {
  const pose = markerPose({
    x: 3,
    y: 4,
    z: 20 + EYE_HEIGHT_M,
    yaw: 1.2,
    pitch: -0.5,
  });
  assert.equal(pose.x, 3);
  assert.equal(pose.y, 4);
  assert.ok(near(pose.z, 20 + 0.9));
  assert.equal(pose.yaw, 1.2);
});

test('the compass: the rose turned by −heading (N points north), the home tick at its bearing less the heading', () => {
  assert.deepEqual(compassAngles({ headingDeg: 0 }), {
    roseDeg: 0,
    homeDeg: null,
  });
  assert.equal(compassAngles({ headingDeg: 90 }).roseDeg, 270);
  assert.equal(compassAngles({ headingDeg: 370 }).roseDeg, 350);
  const here = { lat: 39.32, lon: -76.63 };
  const east = { lat: 39.32, lon: -76.62 };
  const north = { lat: 39.33, lon: -76.63 };
  assert.ok(near(bearingDeg(here, north), 0, 1e-6));
  assert.ok(Math.abs(bearingDeg(here, east) - 90) < 0.01);
  assert.ok(
    Math.abs(bearingDeg(here, { lat: 39.31, lon: -76.63 }) - 180) < 1e-6,
  );
  // Facing north, home east: the tick at 90° (to the right).
  assert.ok(
    Math.abs(compassAngles({ headingDeg: 0, here, home: east }).homeDeg - 90) <
      0.01,
  );
  // Facing east, home east: straight ahead.
  const ahead = compassAngles({ headingDeg: 90, here, home: east }).homeDeg;
  assert.ok(ahead < 0.01 || ahead > 359.99, String(ahead));
  // Facing south, home north: behind.
  assert.ok(
    Math.abs(
      compassAngles({ headingDeg: 180, here, home: north }).homeDeg - 180,
    ) < 1e-6,
  );
});
