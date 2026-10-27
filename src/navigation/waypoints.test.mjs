// Personal fork: home, waypoints and their keys (src/navigation/waypoints.js),
// the entry with a pose (store.js), and the controls beside Move.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOME_STORAGE_KEY,
  MAX_WAYPOINTS,
  WAYPOINTS_STORAGE_KEY,
  attachWayfindingKeys,
  createWayfinding,
  createWaypointStore,
  normalizePlace,
  placeText,
  poseFor,
} from './waypoints.js';
import { createNavigationStore } from './store.js';
import { createViewStore } from './view.js';

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const PLACE = {
  lon: -76.6292,
  lat: 39.3214,
  heightM: 38.62,
  level: 36,
  blockM: 1,
  headingDeg: 370,
};

test('places are checked and rounded; their line says where and the level', () => {
  assert.deepEqual(normalizePlace(PLACE), {
    lon: -76.6292,
    lat: 39.3214,
    heightM: 38.62,
    level: 36,
    blockM: 1,
    headingDeg: 10,
  });
  assert.equal(normalizePlace(null), null);
  assert.equal(normalizePlace({ lon: 'x', lat: 1 }), null);
  assert.equal(normalizePlace({ lon: 0, lat: 91 }), null);
  assert.equal(normalizePlace({ lon: 1, lat: 2 }).level, null);
  assert.equal(
    placeText(normalizePlace(PLACE)),
    '39.32140, -76.62920 · level 36',
  );
  assert.equal(
    placeText(normalizePlace({ lon: 1, lat: 2, heightM: 40.4 })),
    '2.00000, 1.00000 · 40 m',
  );
});

test('home and waypoints are kept in this browser and read back; at most 50 waypoints', () => {
  const storage = memoryStorage();
  const store = createWaypointStore({ storage, now: () => 1000 });
  assert.equal(store.home(), null);
  const changes = [];
  store.subscribe(() => changes.push('x'));
  assert.equal(store.setHome(PLACE), true);
  assert.equal(store.setHome({ lat: 'no' }), false);
  const a = store.add(PLACE, ' Ridge  ');
  const b = store.add({ ...PLACE, lon: -76.62 });
  assert.equal(a.name, 'Ridge');
  assert.equal(b.name, 'Waypoint 2');
  assert.notEqual(a.id, b.id);
  assert.equal(changes.length, 3);
  // Read back by a new store (another page).
  const again = createWaypointStore({ storage });
  assert.equal(again.home().level, 36);
  assert.deepEqual(
    again.list().map((w) => w.name),
    ['Ridge', 'Waypoint 2'],
  );
  assert.equal(again.remove(a.id), true);
  assert.equal(again.remove('nope'), false);
  assert.deepEqual(
    JSON.parse(storage.map.get(WAYPOINTS_STORAGE_KEY)).map((w) => w.id),
    [b.id],
  );
  again.clearHome();
  assert.equal(storage.map.has(HOME_STORAGE_KEY), false);
  // The oldest go past 50.
  const many = createWaypointStore({ storage: memoryStorage() });
  for (let n = 0; n < MAX_WAYPOINTS + 5; n++) many.add(PLACE, `w${n}`);
  assert.equal(many.list().length, MAX_WAYPOINTS);
  assert.equal(many.list()[0].name, 'w5');
  // Bad storage reads as nothing.
  const broken = memoryStorage();
  broken.map.set(WAYPOINTS_STORAGE_KEY, '{not json');
  broken.map.set(HOME_STORAGE_KEY, '"x"');
  const fresh = createWaypointStore({ storage: broken });
  assert.deepEqual(fresh.list(), []);
  assert.equal(fresh.home(), null);
});

test('going: Walk from Spectator, the mode kept in Walk or Fly, through the store’s entry with a pose', () => {
  const asked = [];
  const navStore = createNavigationStore({ initial: 'spectator' });
  navStore.onEntry((mode, pose) => asked.push([mode, pose]));
  let walker = null;
  const wayfinding = createWayfinding({
    navStore,
    waypoints: createWaypointStore({ storage: memoryStorage() }),
    walker: () => walker,
  });
  // Nowhere to set from in Spectator.
  assert.equal(wayfinding.setHome(), false);
  walker = PLACE;
  assert.equal(wayfinding.setHome(), true);
  const added = wayfinding.addWaypoint('Bench');
  // From Spectator: walk home.
  assert.equal(wayfinding.goHome(), true);
  assert.deepEqual(asked.at(-1), ['walk', poseFor(normalizePlace(PLACE))]);
  assert.deepEqual(poseFor(normalizePlace(PLACE)), {
    lon: -76.6292,
    lat: 39.3214,
    heightM: 38.62,
    headingDeg: 10,
    pitchDeg: 0,
  });
  // Flying: fly to the waypoint.
  navStore.set('fly');
  assert.equal(wayfinding.goTo(added.id), true);
  assert.equal(asked.at(-1)[0], 'fly');
  assert.equal(wayfinding.goTo('missing'), false);
  // No home: nothing asked.
  wayfinding.waypoints.clearHome();
  const before = asked.length;
  assert.equal(wayfinding.goHome(), false);
  assert.equal(asked.length, before);
});

test('the store passes an entry’s pose on; without one, the entry is G’s', () => {
  const store = createNavigationStore({ initial: 'spectator' });
  const heard = [];
  store.onEntry((mode, pose) => heard.push([mode, pose]));
  store.requestEntry('walk');
  store.requestEntry('fly', { lon: 1, lat: 2, heightM: 3 });
  assert.equal(store.requestEntry('swim', { lon: 1 }), false);
  assert.deepEqual(heard, [
    ['walk', null],
    ['fly', { lon: 1, lat: 2, heightM: 3 }],
  ]);
});

test('the keys, in Walk and Fly only: T cycles the view, B sets home, Shift+B goes home; not in fields or with modifiers', () => {
  const listeners = new Map();
  const documentRef = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const navStore = createNavigationStore({ initial: 'spectator' });
  const view = createViewStore({ storage: memoryStorage() });
  const calls = [];
  const wayfinding = {
    setHome: () => calls.push('set'),
    goHome: () => calls.push('go'),
  };
  const detach = attachWayfindingKeys({
    documentRef,
    navStore,
    view,
    wayfinding,
  });
  const press = (code, extra = {}) => {
    let prevented = false;
    listeners.get('keydown')({
      code,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      target: null,
      preventDefault: () => (prevented = true),
      ...extra,
    });
    return prevented;
  };
  // Spectator: GEV's keys, nothing taken.
  assert.equal(press('KeyT'), false);
  assert.equal(view.get(), 'first');
  navStore.set('walk');
  assert.equal(press('KeyT'), true);
  assert.equal(view.get(), 'back');
  press('KeyT');
  press('KeyT');
  assert.equal(view.get(), 'first');
  press('KeyB');
  press('KeyB', { shiftKey: true });
  assert.deepEqual(calls, ['set', 'go']);
  // Modifiers, repeats and form fields are left alone.
  press('KeyB', { ctrlKey: true });
  press('KeyB', { repeat: true });
  press('KeyB', { target: { closest: () => ({}) } });
  assert.deepEqual(calls, ['set', 'go']);
  detach();
  assert.equal(listeners.has('keydown'), false);
});
