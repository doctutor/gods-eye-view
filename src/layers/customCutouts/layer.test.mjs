// Personal fork: the Custom cutouts layer against stubs (a map controller
// with a tileset, a clipping recorder, an Overpass transport answering the
// is_in and relation queries): the user's acceptance steps as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OSM_AREA_OFFSET } from '../../data/customCutouts.js';
import { createCutoutSource, packKey } from './source.js';
import {
  createCutoutStore,
  decodeCutoutsParam,
  encodeCutoutsParam,
} from './store.js';
import { CUSTOM_CUTOUTS_LAYER_ID, createCustomCutoutsLayer } from './index.js';

const square = (lon, lat, d) => [
  { lon, lat },
  { lon: lon + d, lat },
  { lon: lon + d, lat: lat + d },
  { lon, lat: lat + d },
  { lon, lat },
];

/** An Overpass transport answering is_in at Cedarcroft and two relations. */
function fakeOverpass({ down = false } = {}) {
  const asked = [];
  const relations = {
    133345: { name: 'Baltimore', level: '6', ring: square(-76.71, 39.19, 0.2) },
    12744748: {
      name: 'Cedarcroft',
      level: '10',
      ring: square(-76.62, 39.36, 0.01),
    },
  };
  return {
    asked,
    async query(text) {
      asked.push(text);
      if (down) return { unavailable: true, code: 'OVERPASS_NOT_CONFIGURED' };
      if (/is_in\(/.test(text))
        return Object.entries(relations).map(([id, r]) => ({
          type: 'area',
          id: OSM_AREA_OFFSET + Number(id),
          tags: {
            name: r.name,
            admin_level: r.level,
            boundary: 'administrative',
          },
        }));
      const area = Number(/area\((\d+)\)/.exec(text)?.[1]);
      const relation = relations[area - OSM_AREA_OFFSET];
      if (!relation) return [];
      return [
        {
          type: 'relation',
          id: area - OSM_AREA_OFFSET,
          tags: { name: relation.name, admin_level: relation.level },
          members: [{ type: 'way', role: 'outer', geometry: relation.ring }],
        },
      ];
    },
  };
}

/** A map controller with Google 3D's tileset shown (or a globe map). */
function fakeController({ tileset = { show: true } } = {}) {
  const listeners = new Set();
  const plates = [];
  return {
    plates,
    tileset,
    getImageryHostTileset: () => tileset,
    setPlate(color) {
      if (plates.at(-1) === color) return;
      plates.push(color);
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    settle: () => [...listeners].forEach((fn) => fn()),
  };
}

function fakeClipping({ supported = true } = {}) {
  const calls = [];
  let current = { tileset: null, rings: [], plate: null };
  return {
    calls,
    supported: () => supported,
    apply(scene, tileset, rings, plate) {
      calls.push('apply');
      current = { tileset, rings, plate };
    },
    clear() {
      calls.push('clear');
      current = { tileset: null, rings: [], plate: null };
    },
    state: () => current,
  };
}

const fakeCesium = {
  Color: class {
    constructor(...rgba) {
      this.rgba = rgba;
    }
  },
};

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup({
  initial,
  overpass = fakeOverpass(),
  controller = fakeController(),
  clipping = fakeClipping(),
} = {}) {
  const store = createCutoutStore({
    initial: initial || { enabled: false, plate: 'black', cutouts: [] },
  });
  const source = createCutoutSource({
    boundaries: overpass,
    findAdminArea: async (query) =>
      /baltimore city/i.test(query)
        ? {
            kind: 'county',
            name: 'Baltimore city',
            polygons: [
              [
                [
                  [-76.7, 39.2],
                  [-76.5, 39.2],
                  [-76.5, 39.37],
                  [-76.7, 39.37],
                ],
              ],
            ],
          }
        : null,
  });
  const viewer = { scene: {} };
  const shown = [];
  const layer = createCustomCutoutsLayer({
    store,
    source,
    cesium: fakeCesium,
    clipping,
    placeSearch: {
      geocode: async (q) => ({
        place: /cedarcroft|baltimore/i.test(q)
          ? { lat: 39.3699, lng: -76.6131, name: q }
          : null,
      }),
    },
    osmCredit: { show: () => shown.push(true), hide: () => shown.push(false) },
    setTimeoutImpl: (fn) => fn(),
  });
  layer.init(viewer);
  layer.attachMapStackController(controller);
  return { store, layer, controller, clipping, overpass, viewer, shown };
}

test('the acceptance steps: Baltimore as a cookie on a black plate, hidden, Cedarcroft too, renamed, deleted, off', async () => {
  const { store, layer, controller, clipping, shown } = setup();
  assert.equal(layer.id, CUSTOM_CUTOUTS_LAYER_ID);
  layer.enable();
  assert.equal(layer.view().reason, 'empty');
  assert.equal(
    controller.plates.at(-1) ?? null,
    null,
    'no plate before a cutout',
  );

  // ADD AT VIEW CENTRE at Cedarcroft lists both, the most local first.
  const listed = await layer.areasByName('Cedarcroft');
  assert.deepEqual(
    listed.areas.map((a) => [a.source, a.name, a.level]),
    [
      ['osm:12744748', 'Cedarcroft', 10],
      ['osm:133345', 'Baltimore', 6],
    ],
  );
  layer.add(listed.areas.find((a) => a.name === 'Baltimore'));
  await settle();
  let view = layer.view();
  assert.equal(view.cutouts[0].status, 'ready');
  assert.equal(view.reason, '');
  assert.equal(
    clipping.state().tileset,
    controller.tileset,
    'Google 3D clipped',
  );
  assert.equal(clipping.state().rings.length, 1);
  assert.deepEqual(
    controller.plates.at(-1).rgba,
    [0, 0, 0, 1],
    'on a black plate',
  );
  assert.equal(shown.at(-1), true, 'OpenStreetMap credited');

  // Hide: full tiles again, no plate.
  layer.setVisible('osm:133345', false);
  assert.equal(layer.view().reason, 'none-visible');
  assert.equal(clipping.state().tileset, null);
  assert.equal(controller.plates.at(-1), null);
  layer.setVisible('osm:133345', true);

  // A second cutout: both clip (a union).
  layer.add(listed.areas[0]);
  await settle();
  assert.equal(clipping.state().rings.length, 2);
  layer.rename('osm:12744748', 'My street');
  assert.equal(layer.view().cutouts[1].name, 'My street');
  layer.setPlate('white');
  assert.deepEqual(controller.plates.at(-1).rgba, [1, 1, 1, 1]);
  assert.equal(clipping.state().plate, 'white');

  // The URL: sources, names, visibility, plate, on; no rings.
  const param = store.param();
  assert.equal(param, '1.white~osm:133345*Baltimore~osm:12744748*My%20street');
  layer.remove('osm:133345');
  assert.equal(clipping.state().rings.length, 1);
  assert.equal(layer.getStats().countLabel, '1/1');

  // Off: the tiles exactly as before.
  layer.disable();
  assert.equal(clipping.state().tileset, null);
  assert.equal(controller.plates.at(-1), null);
  assert.equal(shown.at(-1), false);
  assert.equal(store.get().enabled, false);
  layer.reset();
  assert.equal(store.param(), '', 'off and empty: nothing in the URL');
});

test('a reload: the list and the toggle come back from the URL and the rings are fetched again', async () => {
  const initial = decodeCutoutsParam(
    '1.black~osm:133345*Baltimore~osm:12744748!Cedarcroft',
  );
  const manager = { calls: [] };
  manager.setEnabled = (id, on, options) =>
    manager.calls.push([id, on, options.origin]);
  const { layer, clipping, overpass } = setup({ initial });
  layer.attachDataManager(manager);
  assert.deepEqual(
    manager.calls,
    [[CUSTOM_CUTOUTS_LAYER_ID, true, 'programmatic']],
    'turned on from the URL',
  );
  layer.enable();
  assert.equal(layer.view().cutouts[0].status, 'loading');
  await settle();
  const view = layer.view();
  assert.deepEqual(
    view.cutouts.map((c) => [c.name, c.visible, c.status]),
    [
      ['Baltimore', true, 'ready'],
      ['Cedarcroft', false, 'ready'],
    ],
  );
  assert.equal(clipping.state().rings.length, 1, 'only the visible one clips');
  assert.equal(overpass.asked.filter((q) => /pivot/.test(q)).length, 2);
  // A layer that the URL left off is not turned on.
  const off = setup();
  const quiet = { calls: [], setEnabled: (...a) => quiet.calls.push(a) };
  off.layer.attachDataManager(quiet);
  assert.equal(quiet.calls.length, 0);
});

test('a globe map, no WebGL2, or Overpass down: the panel says why and nothing is clipped', async () => {
  const globe = fakeController({ tileset: null });
  const initial = decodeCutoutsParam('1.black~osm:133345*Baltimore');
  const onGlobe = setup({ initial, controller: globe });
  onGlobe.layer.enable();
  await settle();
  assert.equal(onGlobe.layer.view().reason, 'needs-3d');
  assert.equal(onGlobe.clipping.state().tileset, null);
  // Switching to Google 3D clips at the settle.
  globe.tileset = { show: true };
  globe.getImageryHostTileset = () => globe.tileset;
  globe.settle();
  assert.equal(onGlobe.clipping.state().tileset, globe.tileset);

  const old = setup({ initial, clipping: fakeClipping({ supported: false }) });
  old.layer.enable();
  await settle();
  assert.equal(old.layer.view().reason, 'no-webgl2');
  assert.equal(old.controller.plates.at(-1) ?? null, null);

  // Overpass down: at the view centre says so; by name, the packs answer.
  const down = setup({ overpass: fakeOverpass({ down: true }) });
  down.layer.enable();
  assert.deepEqual(await down.layer.areasByName('nowhere'), {
    areas: [],
    from: 'none',
  });
  const byName = await down.layer.areasByName('Baltimore city');
  assert.equal(byName.from, 'packs');
  assert.equal(byName.areas[0].source, `pack:${packKey('Baltimore city')}`);
  assert.equal(byName.areas[0].source, 'pack:baltimore-city');
  down.layer.add(byName.areas[0]);
  await settle();
  assert.equal(down.layer.view().cutouts[0].status, 'ready');
  assert.equal(down.clipping.state().rings.length, 1);
  // The pack cutout comes back from its key alone (a reload).
  const again = createCutoutSource({
    boundaries: fakeOverpass({ down: true }),
    findAdminArea: async (q) =>
      q === 'baltimore city'
        ? {
            kind: 'county',
            name: 'Baltimore city',
            polygons: [
              [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                ],
              ],
            ],
          }
        : null,
  });
  assert.equal((await again.cutout('pack:baltimore-city')).level, 6);
});

test('the store and its URL value round-trip', () => {
  const store = createCutoutStore({
    initial: { enabled: true, plate: 'white', cutouts: [] },
  });
  let heard = 0;
  store.subscribe(() => heard++);
  store.add({
    source: 'osm:1',
    name: 'One',
    rings: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ],
  });
  store.add({ source: 'osm:2', name: 'Two' });
  store.update('osm:2', { visible: false });
  assert.equal(heard, 3);
  const value = encodeCutoutsParam(store.get());
  assert.equal(value, '1.white~osm:1*One~osm:2!Two');
  const back = decodeCutoutsParam(value);
  assert.equal(back.enabled, true);
  assert.equal(back.plate, 'white');
  assert.deepEqual(
    back.cutouts.map((c) => [c.source, c.visible]),
    [
      ['osm:1', true],
      ['osm:2', false],
    ],
  );
  assert.deepEqual(decodeCutoutsParam('garbage'), {
    enabled: false,
    plate: 'black',
    cutouts: [],
  });
  store.reset();
  assert.equal(store.get().cutouts.length, 0);
  assert.equal(store.get().plate, 'white', 'reset keeps the plate');
});
