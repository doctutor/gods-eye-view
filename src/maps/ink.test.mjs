// Personal fork: overlays pick an ink from the basemap's luminance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_STACKS } from './catalog.js';
import { KEYLESS_BASEMAPS } from './keylessBasemapCatalog.js';
import { COUNTRIES_BASEMAPS } from './countries/catalog.js';
import { MapSourceController } from './controller.js';
import {
  INKS,
  INK_SETTINGS,
  activeLuminance,
  inkForLuminance,
  readInkSetting,
  resolveInk,
} from './ink.js';

test('every map stack record says whether it reads dark or light', () => {
  const byId = new Map(MAP_STACKS.map((stack) => [stack.id, stack.luminance]));
  for (const stack of MAP_STACKS)
    assert.ok(
      ['dark', 'light'].includes(stack.luminance),
      `${stack.id} has no luminance`,
    );
  // Imagery and the dark styles read dark; OSM, the white globe, Positron,
  // Natural Earth, OpenTopoMap and the light Stamen styles read light.
  for (const id of [
    'photoreal',
    'bing-aerial',
    'bing-labels',
    'esri-imagery',
    'blank-black',
    'carto-dark-matter',
    'carto-dark-matter-nolabels',
    'nasa-black-marble',
    'nasa-blue-marble',
    'stamen-toner',
  ])
    assert.equal(byId.get(id), 'dark', id);
  for (const id of [
    'osm',
    'blank-white',
    'carto-positron',
    'carto-positron-nolabels',
    'natural-earth-ii',
    'opentopomap',
    'stamen-toner-lite',
    'stamen-terrain',
    'stamen-watercolor',
  ])
    assert.equal(byId.get(id), 'light', id);
  for (const record of KEYLESS_BASEMAPS)
    assert.equal(byId.get(record.id), record.luminance, record.id);
  // The Countries styles follow their theme.
  for (const record of COUNTRIES_BASEMAPS)
    assert.equal(byId.get(record.id), record.theme, record.id);
  assert.equal(byId.get('countries-simple-light'), 'light');
  assert.equal(byId.get('countries-hex-dark'), 'dark');
});

test('the ink is the opposite of the basemap, unless forced', () => {
  assert.deepEqual(INKS, ['light', 'dark']);
  assert.deepEqual(INK_SETTINGS, ['auto', 'light', 'dark']);
  assert.equal(inkForLuminance('dark'), 'light');
  assert.equal(inkForLuminance('light'), 'dark');
  assert.equal(inkForLuminance(undefined), 'light');
  assert.equal(resolveInk('auto', 'light'), 'dark');
  assert.equal(resolveInk('auto', 'dark'), 'light');
  assert.equal(resolveInk('light', 'light'), 'light');
  assert.equal(resolveInk('dark', 'dark'), 'dark');
  assert.equal(resolveInk('nonsense', 'light'), 'dark');
  const store = (value) => ({ getItem: () => value });
  assert.equal(readInkSetting(store('dark'), 'k'), 'dark');
  assert.equal(readInkSetting(store('purple'), 'k'), 'auto');
  assert.equal(readInkSetting(store(null), 'k'), 'auto');
  assert.equal(
    readInkSetting(
      {
        getItem() {
          throw new Error('denied');
        },
      },
      'k',
    ),
    'auto',
  );
  assert.equal(activeLuminance(null), 'dark');
  assert.equal(activeLuminance({ getActiveLuminance: () => 'light' }), 'light');
  assert.equal(activeLuminance({ getActiveLuminance: () => 'odd' }), 'dark');
});

test('the controller exposes the active stack’s luminance, dark until one is active', async () => {
  const registry = {
    defaultId: 'dark-one',
    sources: [
      {
        descriptor: {
          id: 'dark-one',
          label: 'd',
          kind: 'imagery',
          luminance: 'dark',
        },
        imagery: async () => ({}),
        terrain: { id: 't', create: async () => ({ provider: {} }) },
      },
      {
        descriptor: {
          id: 'light-one',
          label: 'l',
          kind: 'imagery',
          luminance: 'light',
        },
        imagery: async () => ({}),
        terrain: { id: 't', create: async () => ({ provider: {} }) },
      },
      {
        descriptor: { id: 'unsaid', label: 'u', kind: 'imagery' },
        imagery: async () => ({}),
        terrain: { id: 't', create: async () => ({ provider: {} }) },
      },
    ],
  };
  const viewer = {
    scene: {
      globe: { show: true },
      requestRender() {},
      frameState: {
        creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
      },
      primitives: { add() {}, remove() {} },
    },
    imageryLayers: { add() {}, remove() {} },
  };
  const controller = new MapSourceController(viewer, {
    registry,
    createImageryLayer: (provider) => ({ provider }),
  });
  assert.equal(controller.getActiveLuminance(), 'dark', 'nothing active yet');
  const heard = [];
  controller.subscribe(() => heard.push(controller.getActiveLuminance()));
  await controller.setStack('light-one');
  assert.equal(controller.getActiveLuminance(), 'light');
  await controller.setStack('dark-one');
  assert.equal(controller.getActiveLuminance(), 'dark');
  await controller.setStack('unsaid');
  assert.equal(controller.getActiveLuminance(), 'dark', 'unsaid reads dark');
  assert.deepEqual(
    heard,
    ['light', 'dark', 'dark'],
    'subscribers see the settled luminance',
  );
  controller.destroy();
});
