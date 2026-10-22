// Personal fork: a chosen colour scale on the Earth Engine layers
// (src/data/earthEngineScale.js, server/providers/earthEngine.js and
// src/layers/earthEngine/): the defaults, the token, the expressions and
// visualizations a window makes, the cache keys, no new map for a scale
// already made, and one layer end to end through the real route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';

import {
  EE_SCALE_DEFAULTS,
  MAX_PALETTE_STOPS,
  concreteScale,
  decodeScaleToken,
  defaultScale,
  drawnScaleKey,
  drawnWindow,
  eeScaleDefaults,
  encodeScaleToken,
  normalizeDrawnScale as normalizeScale,
  takesScale,
} from './earthEngineScale.js';
import {
  isDefaultScale,
  paletteById,
  rgbHex,
  scaleKey,
} from '../maps/colourScale.js';
import { createColourScaleStore } from '../maps/colourScaleStore.js';
import { EARTH_ENGINE_LAYERS, layerVariants } from './earthEngineLayers.js';
import {
  SCALED_MAPS_KEPT,
  TRANSPARENT_TILE,
  createEarthEngineHandler,
  createEarthEngineService,
  mapKey,
  mapRequestFor,
  mapRequestHash,
} from '../../server/providers/earthEngine.js';
import {
  SCALE_DEBOUNCE_MS,
  createEarthEngineLayer,
} from '../layers/earthEngine/index.js';
import {
  createEarthEngineSource,
  tileTemplate,
} from '../layers/earthEngine/source.js';

const byId = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const json = (value) => JSON.stringify(value);
const functionsIn = (request) =>
  [...json(request).matchAll(/"functionName":"([\w.]+)"/g)].map((m) => m[1]);

/** A concrete scale (what the provider draws). */
const WARM = {
  floor: 10,
  ceiling: 5000,
  scale: 'linear',
  palette: ['#000004', '#bb3754', '#fcffa4'],
  invert: false,
  outside: 'hide',
};
/** The shared model's choice (src/maps/colourScale.js): inferno, 10–5,000, hide outside. */
const MODEL = {
  palette: 'inferno',
  floor: 10,
  ceiling: 5000,
  scale: 'linear',
  invert: false,
  outside: 'hide',
};
const INFERNO = paletteById('inferno').stops.map((rgb) => rgbHex(rgb).slice(1));
const CODE = paletteById('inferno').code;
const canopyToken = (model) =>
  encodeScaleToken('ee-tree-canopy', 'meta', model);

test('defaults: every windowable layer in its own units; categorical and ink layers have none', () => {
  assert.deepEqual(
    (({ floor, ceiling, scale, units }) => ({ floor, ceiling, scale, units }))(
      defaultScale('ee-elevation'),
    ),
    { floor: 0, ceiling: 6400, scale: 'sqrt', units: 'm' },
  );
  assert.deepEqual(
    [
      defaultScale('ee-population', 'density-2020').floor,
      defaultScale('ee-population', 'density-2020').ceiling,
      defaultScale('ee-population', 'density-2020').scale,
    ],
    [1, 10000, 'log'],
  );
  assert.equal(defaultScale('ee-surface-water', 'change').diverging, true);
  assert.equal(defaultScale('ee-surface-water', 'change').centre, 0);
  assert.equal(defaultScale('ee-terrain-aspect').circular, true);
  assert.equal(defaultScale('ee-inundation', 'duration').ceiling, 316.228);
  for (const [id, mode] of [
    ['ee-forest-types', ''],
    ['ee-land-cover', 'v200'],
    ['ee-rivers', 'pressure'],
    ['ee-elevation-contours', ''],
    ['ee-census-tracts', 'income'],
  ])
    assert.equal(takesScale(id, mode), false, `${id} ${mode}`);
  assert.equal(Object.keys(EE_SCALE_DEFAULTS).length, 19);
  // The shared model's defaults are built from this table: the layer's own
  // ramp, scale kind and fixed range; an untouched model is the default.
  const elevation = eeScaleDefaults('ee-elevation');
  assert.equal(elevation.model.scale, 'sqrt');
  assert.deepEqual(elevation.range, { min: 0, max: 6400 });
  assert.equal(rgbHex(elevation.stops[0]), '#2b6a2e');
  assert.ok(isDefaultScale(elevation.model, elevation));
  assert.equal(eeScaleDefaults('ee-land-cover', 'v200'), null);
  assert.equal(encodeScaleToken('ee-elevation', '', elevation.model), '');
  assert.equal(concreteScale('ee-elevation', '', elevation.model), null);
});

test('a choice travels as the model’s hash fields and resolves to a concrete scale on the server', () => {
  const token = canopyToken({ ...MODEL, invert: true });
  assert.equal(token, `${CODE}.10.5000.nih`);
  assert.deepEqual(decodeScaleToken('ee-tree-canopy', 'meta', token), {
    floor: 10,
    ceiling: 5000,
    scale: 'linear',
    palette: INFERNO,
    invert: true,
    outside: 'hide',
  });
  // 'default' is the layer's own ramp; an automatic end is the layer's range.
  assert.deepEqual(
    concreteScale('ee-tree-canopy', 'meta', {
      palette: 'default',
      floor: null,
      ceiling: 20,
      scale: 'linear',
      invert: false,
      outside: 'clamp',
    }),
    {
      floor: 0,
      ceiling: 20,
      scale: 'linear',
      palette: ['f7fcb9', 'addd8e', '41ab5d', '006837', '00321a'],
      invert: false,
      outside: 'clamp',
    },
  );
  // Log over a range from zero starts three decades below the ceiling.
  assert.equal(
    concreteScale('ee-tree-canopy', 'meta', {
      ...MODEL,
      floor: null,
      ceiling: null,
      scale: 'log',
    }).floor,
    0.04,
  );
  for (const bad of [
    '',
    'nope',
    'zz.1.5.n', // no such palette
    `${CODE}.1.5.q`,
    `${CODE}.1.5.n&x=1`,
    `${CODE}.1.5`,
  ])
    assert.equal(decodeScaleToken('ee-tree-canopy', 'meta', bad), null, bad);
  // A layer without a window takes none.
  assert.equal(encodeScaleToken('ee-land-cover', 'v200', MODEL), '');
  // The concrete scale: checked, its window drawn in the transform's space.
  assert.equal(normalizeScale({ ...WARM, scale: 'log', floor: -1 }), null);
  assert.equal(
    normalizeScale({
      ...WARM,
      palette: Array(MAX_PALETTE_STOPS + 1).fill('ffffff'),
    }),
    null,
  );
  assert.deepEqual(drawnWindow({ ...WARM, scale: 'log', invert: true }), {
    min: 1,
    max: 3.69897,
    palette: ['fcffa4', 'bb3754', '000004'],
    transform: 'log',
    hide: true,
  });
});

test('a window becomes the visualization and the expression: min, max, stops, transform, mask', () => {
  const population = byId('ee-population');
  const variant = layerVariants(population)[0];
  // Untouched: exactly today's request (the committed fixture's).
  assert.deepEqual(
    mapRequestFor(population, variant, 'default', 'density-2020', null),
    mapRequestFor(population, variant, 'default', 'density-2020'),
  );
  // Linear 10–5,000 people per km², hide outside.
  const linear = mapRequestFor(
    population,
    variant,
    'default',
    'density-2020',
    normalizeScale(WARM),
  );
  assert.deepEqual(linear.visualizationOptions, {
    ranges: [{ min: 10, max: 5000 }],
    paletteColors: ['000004', 'bb3754', 'fcffa4'],
  });
  const fns = functionsIn(linear);
  assert.ok(!fns.includes('Image.log10'), 'linear drops the native log10');
  assert.ok(
    fns.includes('Image.gte') && fns.includes('Image.lte'),
    'hide masks both ends',
  );
  // Log on a linear layer (tree canopy): log10 of the positive part, the window in log10.
  const canopy = byId('ee-tree-canopy');
  const log = mapRequestFor(
    canopy,
    layerVariants(canopy)[0],
    'default',
    'meta',
    normalizeScale({
      ...WARM,
      floor: 1,
      ceiling: 40,
      scale: 'log',
      outside: 'clamp',
      invert: true,
    }),
  );
  assert.deepEqual(log.visualizationOptions.ranges, [{ min: 0, max: 1.60206 }]);
  assert.deepEqual(log.visualizationOptions.paletteColors, [
    'fcffa4',
    'bb3754',
    '000004',
  ]);
  assert.ok(functionsIn(log).includes('Image.log10'));
  assert.ok(functionsIn(log).includes('Image.gt'));
  assert.ok(!functionsIn(log).includes('Image.lte'), 'clamp masks nothing');
  // Elevation's DEM stack: linear drops the native sqrt.
  const elevation = byId('ee-elevation');
  const stackVariant =
    layerVariants(elevation).find((v) => v.stack) ||
    layerVariants(elevation)[0];
  const flat = mapRequestFor(
    elevation,
    stackVariant,
    'default',
    'default',
    normalizeScale({ ...WARM, floor: 0, ceiling: 3000, outside: 'clamp' }),
  );
  assert.ok(!functionsIn(flat).includes('Image.sqrt'));
  assert.deepEqual(flat.visualizationOptions.ranges, [{ min: 0, max: 3000 }]);
  assert.ok(
    functionsIn(mapRequestFor(elevation, stackVariant)).includes('Image.sqrt'),
  );
});

test('the scale is in the map key, the request hash and so the tile directory', () => {
  const canopy = byId('ee-tree-canopy');
  const variant = layerVariants(canopy)[0];
  const a = normalizeScale(WARM);
  const b = normalizeScale({ ...WARM, ceiling: 6000 });
  assert.equal(
    mapKey(canopy, variant, 'default', 'meta'),
    'ee-tree-canopy/meta/default/default',
  );
  assert.equal(
    mapKey(canopy, variant, 'default', 'meta', drawnScaleKey(a)),
    `ee-tree-canopy/meta/default/default|s=${drawnScaleKey(a)}`,
  );
  const plain = mapRequestHash(canopy, variant, 'default', 'meta');
  assert.notEqual(mapRequestHash(canopy, variant, 'default', 'meta', a), plain);
  assert.notEqual(
    mapRequestHash(canopy, variant, 'default', 'meta', a),
    mapRequestHash(canopy, variant, 'default', 'meta', b),
  );
  assert.equal(
    mapRequestHash(canopy, variant, 'default', 'meta', a),
    mapRequestHash(canopy, variant, 'default', 'meta', normalizeScale(WARM)),
  );
  assert.equal(
    tileTemplate(
      'ee-tree-canopy',
      'default',
      'default',
      'abcdef123456',
      'meta',
      canopyToken(MODEL),
    ),
    `/api/earth-engine/tile/ee-tree-canopy/meta/default/default/{z}/{x}/{y}?v=abcdef123456&s=${canopyToken(MODEL)}`,
  );
});

function fakeBackend() {
  const made = [];
  return {
    made,
    async createMap(layer, variant, ink, mode, scale) {
      made.push({
        key: mapKey(
          layer,
          variant,
          ink,
          mode || 'default',
          scale ? drawnScaleKey(scale) : '',
        ),
        scale,
      });
      return { name: `projects/p/maps/m${made.length}` };
    },
    async fetchTile() {
      return { status: 200, contentType: 'image/png', body: TRANSPARENT_TILE };
    },
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-ee-scale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a scale already made makes no new map; the route takes `s`, checks it, and keeps scaled maps bounded', async (t) => {
  const root = await tempRoot(t);
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    backend,
  });
  const token = canopyToken(MODEL);
  const ask = (s, x = 0, mode = 'meta') =>
    service.tile('ee-tree-canopy', 'default', 'default', 3, x, 1, mode, s);
  assert.equal((await ask(token, 0)).status, 200);
  assert.equal((await ask(token, 1)).status, 200);
  assert.equal((await ask(token, 0)).cached, true, 'the same tile is on disk');
  assert.equal(
    backend.made.filter((m) => m.scale).length,
    1,
    'one map for one scale',
  );
  // The same window asked for through the other dataset's mode shares nothing.
  assert.equal((await ask(token, 0, 'eth')).status, 200);
  assert.equal(backend.made.filter((m) => m.scale).length, 2);
  // Another scale: another map, its own tiles.
  const other = canopyToken({ ...MODEL, ceiling: 7000 });
  assert.equal((await ask(other, 0)).cached, undefined);
  assert.equal(backend.made.filter((m) => m.scale).length, 3);
  // Malformed, and a layer without a window.
  assert.equal((await ask('nope')).status, 400);
  assert.equal(
    (
      await service.tile(
        'ee-land-cover',
        'default',
        'default',
        3,
        0,
        1,
        'v200',
        token,
      )
    ).status,
    400,
  );
  // The route reads `s`.
  const asked = [];
  const handler = createEarthEngineHandler({
    service: {
      tile: async (...args) => (
        asked.push(args),
        { status: 200, contentType: 'image/png', body: TRANSPARENT_TILE }
      ),
      layers: async () => ({}),
    },
  });
  const res = { headers: {}, setHeader() {}, end() {} };
  await handler(
    {
      url: `/tile/ee-tree-canopy/meta/default/default/3/2/1?v=abcdef123456&s=${token}`,
      method: 'GET',
      headers: { host: 'localhost:4173' },
      socket: {},
    },
    res,
  );
  await handler(
    {
      url: '/tile/ee-tree-canopy/meta/default/default/3/2/1',
      method: 'GET',
      headers: { host: 'localhost:4173' },
      socket: {},
    },
    res,
  );
  assert.deepEqual(asked, [
    ['ee-tree-canopy', 'default', 'default', 3, 2, 1, 'meta', token],
    ['ee-tree-canopy', 'default', 'default', 3, 2, 1, 'meta'],
  ]);
  // Bounded: the oldest scaled map is forgotten, and asked for again makes a new one.
  for (let i = 0; i < SCALED_MAPS_KEPT + 1; i++)
    await ask(canopyToken({ ...MODEL, ceiling: 8000 + i }), 0);
  const before = backend.made.length;
  await ask(token, 5);
  assert.equal(backend.made.length, before + 1, 'the first scale was evicted');
});

test('one layer end to end: the store’s scale reaches the tile URL 300 ms after it settles, and its map', async (t) => {
  const root = await tempRoot(t);
  const backend = fakeBackend();
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    backend,
  });
  const handler = createEarthEngineHandler({ service });
  // The browser's fetch, answered by the real route.
  const fetchImpl = async (url) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(body) {
          resolve(
            new Response(body, {
              status: this.statusCode,
              headers: this.headers,
            }),
          );
        },
      };
      handler(
        {
          url: String(url).replace('/api/earth-engine', ''),
          method: 'GET',
          headers: { host: 'localhost:4173' },
          socket: {},
        },
        res,
      );
    });
  const imagery = [];
  const viewer = {
    imageryLayers: {
      add: (l) => (imagery.push(l), l),
      remove: (l) => (imagery.splice(imagery.indexOf(l), 1), true),
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -76.61,
        39.29,
        20_000,
      ),
      moveEnd: { addEventListener: () => () => {} },
    },
  };
  // The app's store (src/maps/colourScale.js), without storage or a hash.
  const colourScales = createColourScaleStore({
    storage: null,
    hashScales: {},
  });
  const key = scaleKey('ee-tree-canopy', 'meta');
  const told = [];
  colourScales.subscribe((changed) => told.push(changed));
  const timers = [];
  const layer = createEarthEngineLayer({
    record: byId('ee-tree-canopy'),
    source: createEarthEngineSource({ fetchImpl }),
    storage: null,
    colourScales,
    setTimeoutImpl: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeoutImpl: () => {},
  });
  layer.init(viewer);
  layer.enable(viewer);
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(imagery.length, 1);
  assert.doesNotMatch(
    imagery[0].imageryProvider.url,
    /[?&]s=/,
    'untouched: no scale',
  );
  // The layer registered its defaults with the store.
  assert.ok(colourScales.defaultsOf(key));
  // The user moves the window (the panel's set): nothing until it has settled.
  colourScales.set(key, MODEL);
  assert.deepEqual(told, [key]);
  assert.doesNotMatch(imagery[0].imageryProvider.url, /[?&]s=/);
  assert.equal(timers.at(-1).ms, SCALE_DEBOUNCE_MS);
  timers.at(-1).fn();
  const url = imagery[0].imageryProvider.url;
  assert.ok(url.endsWith(`&s=${canopyToken(MODEL)}`), url);
  // Its tile through the route makes the scaled map.
  const tile = await fetchImpl(
    url.replace('{z}', '3').replace('{x}', '2').replace('{y}', '3'),
  );
  assert.equal(tile.status, 200);
  assert.deepEqual(backend.made.at(-1).scale, {
    floor: 10,
    ceiling: 5000,
    scale: 'linear',
    palette: INFERNO,
    invert: false,
    outside: 'hide',
  });
  // Reset: the plain URL again.
  colourScales.reset(key);
  timers.at(-1).fn();
  assert.doesNotMatch(imagery[0].imageryProvider.url, /[?&]s=/);
  // Off: no longer told.
  layer.disable();
  const pending = timers.length;
  colourScales.set(key, MODEL);
  assert.equal(timers.length, pending, 'unsubscribed');
});

test('the row carries the scale widget; its legend follows a chosen scale; census local modes get theirs', () => {
  const colourScales = createColourScaleStore({
    storage: null,
    hashScales: {},
  });
  const make = (id, extra = {}) =>
    createEarthEngineLayer({
      ...extra,
      record: byId(id),
      source: createEarthEngineSource({
        fetchImpl: async () => new Response('{}'),
      }),
      storage: null,
      colourScales,
    });
  const canopy = make('ee-tree-canopy');
  const untouched = canopy.getRowControls();
  assert.equal(untouched.scale.key, 'ee-tree-canopy:meta');
  assert.deepEqual(untouched.scale.range, { min: 0, max: 60 });
  const ownLegend = untouched.legend;
  colourScales.set('ee-tree-canopy:meta', MODEL);
  const chosen = canopy.getRowControls();
  assert.notDeepEqual(chosen.legend, ownLegend);
  assert.equal(chosen.legend.length > 1, true);
  colourScales.reset('ee-tree-canopy:meta');
  assert.deepEqual(canopy.getRowControls().legend, ownLegend);
  // No window, no widget; no store, no widget.
  assert.equal(make('ee-land-cover').getRowControls().scale, undefined);
  const bare = createEarthEngineLayer({
    record: byId('ee-tree-canopy'),
    source: createEarthEngineSource({
      fetchImpl: async () => new Response('{}'),
    }),
    storage: null,
  });
  assert.equal(bare.getRowControls().scale, undefined);
  // Census tracts: the income mode's widget is the census server's scale.
  const tracts = make('ee-census-tracts', {
    localSource: { status: async () => null },
  });
  tracts
    .getRowControls()
    .chips.find((chip) => chip.id === 'mode-income')
    ?.onClick();
  assert.match(
    tracts.getRowControls().scale?.key || '',
    /^ee-census-tracts:income/,
  );
});
