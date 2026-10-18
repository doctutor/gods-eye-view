// Personal fork: the Wikipedia coverage layer's Hexes mode — the ground
// hex surface, the hex endpoint contract, and the mode's lifecycle on a
// fake viewer against the committed fixture (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createWikipediaCoverageLayer } from './index.js';
import { HexRequestError, hexUrl, toCatalog, toHexCells } from './source.js';
import { cellColor, createHexSurface, fallbackResolution } from './hexes.js';
import { legendStops, rampColor, rampPosition } from './ramp.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../data/fixtures/wikipedia-coverage-h3-europe.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const serverCatalog = () => ({
  configured: true,
  builtAt: '2026-10-18T03:28:51.999Z',
  dump: { date: '2026-10-08' },
  rows: { kept: 1_259_442 },
  text: false,
  maxZoom: 9,
  attribution: 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData',
  variants: [
    {
      key: 'articles',
      available: true,
      domain: { min: 0.033, max: 1.35, median: 0.052 },
    },
    { key: 'text', available: false },
    { key: 'count', available: true, domain: { min: 1, max: 30, median: 1 } },
  ],
});

function fakeViewer({ lat = 50, lon = 10, height = 8e6 } = {}) {
  const layers = [];
  const primitives = [];
  const listeners = [];
  const viewer = {
    imageryLayers: {
      add: (layer) => (layers.push(layer), layer),
      remove: (layer) => {
        const i = layers.indexOf(layer);
        if (i >= 0) layers.splice(i, 1);
        return i >= 0;
      },
    },
    scene: {
      primitives: {
        add: (p) => (primitives.push(p), p),
        remove: (p) => {
          const i = primitives.indexOf(p);
          if (i >= 0) primitives.splice(i, 1);
          return i >= 0;
        },
      },
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(lon, lat, height);
      },
      moveEnd: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
  };
  return {
    viewer,
    layers,
    primitives,
    moveTo(next) {
      ({ lat = lat, lon = lon, height = height } = next);
      listeners.forEach((fn) => fn());
    },
  };
}

/** A source whose hex endpoint answers from a script of responses. */
function fakeSource({ refuse = () => false, text = false } = {}) {
  const calls = [];
  let held = null;
  return {
    calls,
    async catalog() {
      const body = serverCatalog();
      if (text)
        body.variants[1] = {
          key: 'text',
          available: true,
          domain: { min: 58, max: 15000, median: 258 },
        };
      held = { ...toCatalog(body), at: Date.now() };
      return held;
    },
    last: () => held,
    async hexCells({ res, variant, box }) {
      calls.push({ res, variant, box });
      if (variant === 'text')
        throw new HexRequestError(404, 'The hex grid was built without --text');
      if (refuse(res))
        throw new HexRequestError(
          413,
          'Too many cells: zoom in or lower the resolution',
        );
      return toHexCells({ ...fixture, res, variant }, { res, variant });
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
};

test('the hex endpoint contract: the URL, the checked body, the refusal', () => {
  assert.equal(
    hexUrl(3, 'articles', {
      west: 170.12345,
      south: 55,
      east: -170,
      north: 65,
    }),
    '/api/wikipedia-coverage/h3/3/articles?west=170.1235&south=55&east=-170&north=65',
  );
  const parsed = toHexCells(
    {
      res: 2,
      variant: 'count',
      dump: { date: '2026-10-08' },
      domain: { min: 1, max: 30, median: 2 },
      cells: [
        ['82075ffffffffff', 3],
        ['82075FFFFFFFFFF', 4],
        ['not-a-cell', 1],
        ['82075ffffffffff', 'x'],
        'junk',
      ],
    },
    { res: 3, variant: 'articles' },
  );
  assert.deepEqual(parsed, {
    res: 2,
    variant: 'count',
    dumpDate: '2026-10-08',
    domain: { min: 1, max: 30, median: 2 },
    cells: [
      ['82075ffffffffff', 3],
      ['82075ffffffffff', 4],
    ],
  });
  const fallback = toHexCells(
    { domain: { min: 0, max: 1 } },
    { res: 3, variant: 'text' },
  );
  assert.deepEqual(fallback, {
    res: 3,
    variant: 'text',
    dumpDate: '',
    domain: null,
    cells: [],
  });
  const error = new HexRequestError(413, 'Too many cells');
  assert.equal(error.status, 413);
  assert.equal(error.name, 'HexRequestError');
  assert.equal(fallbackResolution(3), 2);
  assert.equal(fallbackResolution(0), null);
  assert.equal(fixture.res, 2);
  assert.equal(fixture.cells.length, 170);
});

test('the hex surface: ramp colours at the layer opacity on a ground primitive classifying both surfaces', () => {
  const domain = fixture.domain;
  const faint = cellColor(domain.min / 10, domain, 1);
  const [, , , floorAlpha] = rampColor(0);
  assert.ok(
    Math.abs(faint.alpha - floorAlpha / 255) < 1e-6,
    'below the floor: the floor colour',
  );
  const top = cellColor(domain.max * 10, domain, 0.5);
  assert.ok(Math.abs(top.alpha - 0.5) < 1e-6, 'opaque ramp × opacity');
  assert.equal(cellColor(0, domain, 1), null, 'nothing draws nothing');
  const mid = cellColor(domain.median, domain, 1);
  const expected = rampColor(rampPosition(domain.median, domain));
  assert.ok(Math.abs(mid.red * 255 - expected[0]) < 1);

  const surface = createHexSurface({
    cells: fixture.cells,
    domain,
    opacity: 0.75,
  });
  assert.equal(surface.count, 170);
  assert.ok(surface.primitive instanceof Cesium.GroundPrimitive);
  assert.equal(
    surface.primitive.classificationType,
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(surface.primitive.allowPicking, false);
  const instances = surface.primitive.geometryInstances;
  assert.equal(instances.length, 170);
  assert.ok(instances.every((i) => /^[0-9a-f]{15}$/.test(i.id)));
  assert.ok(
    instances.every((i) => i.geometry instanceof Cesium.PolygonGeometry),
  );
  assert.equal(surface.getOpacity(), 0.75);
  assert.equal(
    surface.setOpacity(0.5),
    false,
    'not ready yet: the caller rebuilds',
  );
  const empty = createHexSurface({
    cells: [['82075ffffffffff', 0]],
    domain,
    opacity: 1,
  });
  assert.equal(empty.primitive, null);
  assert.equal(empty.setOpacity(0.2), true);
});

test("the Hexes chip switches the layer from the raster to H3 cells at the camera's resolution, with the legend and status to match", async () => {
  const env = fakeViewer({ height: 8e6 });
  const source = fakeSource();
  const storage = memoryStorage();
  const layer = createWikipediaCoverageLayer({
    source,
    storage,
    createCanvas: () => ({ getContext: () => null }),
    fetchTile: async () => new ArrayBuffer(0),
  });
  layer.init(env.viewer);
  layer.enable(env.viewer);
  await flush();
  assert.equal(env.layers.length, 1, 'the raster drapes first');
  let controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    ['articles', 'text', 'count', 'hexes'],
  );
  assert.equal(controls.chips[3].active, false);
  assert.equal(controls.chips[3].label, 'Hexes');

  controls.chips[3].onClick();
  await flush();
  assert.equal(env.layers.length, 0, 'the raster leaves');
  assert.equal(env.primitives.length, 1, 'the hex surface arrives');
  assert.ok(env.primitives[0] instanceof Cesium.GroundPrimitive);
  assert.deepEqual(source.calls, [
    {
      res: 2,
      variant: 'articles',
      box: { west: -180, south: -85, east: 180, north: 85 },
    },
  ]);
  let state = layer._state();
  assert.equal(state.mounted, false);
  assert.deepEqual(
    {
      on: state.hexes.on,
      res: state.hexes.res,
      count: state.hexes.count,
      failure: state.hexes.failure,
    },
    { on: true, res: 2, count: 170, failure: null },
  );
  controls = layer.getRowControls();
  assert.equal(controls.chips[3].active, true);
  assert.deepEqual(
    controls.legend,
    legendStops(fixture.domain),
    "the resolution's own domain",
  );
  assert.match(controls.info, /^Hexes: resolution 2, 170 cells · /);
  assert.deepEqual(layer.getStats(), {
    count: 170,
    countLabel: '75%',
    error: null,
  });

  // A small move keeps the surface; the variant refetches.
  env.moveTo({ lat: 51, lon: 11 });
  await flush();
  assert.equal(source.calls.length, 1);
  layer.getRowControls().chips[2].onClick();
  await flush();
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[1].variant, 'count');
  assert.equal(env.primitives.length, 1);

  // Opacity: the surface is drawn again from the held data (not ready yet).
  const before = env.primitives[0];
  layer.getRowControls().slider.onInput(50);
  await flush();
  assert.equal(storage.map.get('gev.wikipediaCoverage.opacity'), '0.5');
  assert.notEqual(env.primitives[0], before);
  assert.equal(env.primitives.length, 1);
  assert.equal(layer.getStats().countLabel, '50%');
  assert.equal(source.calls.length, 2, 'no refetch for opacity');

  // Back to the raster, and off.
  layer.getRowControls().chips[3].onClick();
  await flush();
  assert.equal(env.primitives.length, 0);
  assert.equal(env.layers.length, 1);
  assert.equal(layer._state().hexes.on, false);
  layer.setHexes(true);
  await flush();
  assert.equal(env.primitives.length, 1);
  layer.disable();
  assert.equal(env.primitives.length, 0);
  assert.equal(env.layers.length, 0);
  layer.destroy();
});

test('a camera move to another resolution refetches; a 413 steps the resolution down once, twice is a failure', async () => {
  const env = fakeViewer({ height: 8e6 });
  let refused = new Set();
  const source = fakeSource({ refuse: (res) => refused.has(res) });
  const layer = createWikipediaCoverageLayer({
    source,
    storage: memoryStorage(),
  });
  layer.init(env.viewer);
  layer.enable(env.viewer);
  layer.setHexes(true);
  await flush();
  assert.equal(source.calls.at(-1).res, 2);

  // Nearer, still the planet (a 9,000 km half-side): resolution 3.
  env.moveTo({ lat: 50, lon: 10, height: 3e6 });
  await flush();
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls.at(-1).res, 3);
  assert.deepEqual(source.calls.at(-1).box, {
    west: -180,
    south: -85,
    east: 180,
    north: 85,
  });

  // Nearer again: resolution 4 in a window around Europe.
  env.moveTo({ lat: 50, lon: 10, height: 1e6 });
  await flush();
  assert.equal(source.calls.length, 3);
  const [call] = source.calls.slice(-1);
  assert.equal(call.res, 4);
  assert.ok(
    call.box.west < 10 &&
      call.box.east > 10 &&
      call.box.south < 50 &&
      call.box.north > 50,
  );
  assert.ok(call.box.east - call.box.west < 120);

  // A 413 at resolution 5: once more at 4, which answers.
  refused = new Set([5]);
  env.moveTo({ lat: 50, lon: 10, height: 4e5 });
  await flush();
  assert.deepEqual(
    source.calls.slice(-2).map((c) => c.res),
    [5, 4],
  );
  let state = layer._state().hexes;
  assert.equal(state.failure, null);
  assert.equal(state.count, 170);
  assert.equal(env.primitives.length, 1);

  // Refused twice: the failure is shown and nothing is drawn.
  refused = new Set([6, 5]);
  env.moveTo({ lat: 50, lon: 10, height: 1.5e5 });
  await flush();
  assert.deepEqual(
    source.calls.slice(-2).map((c) => c.res),
    [6, 5],
  );
  state = layer._state().hexes;
  assert.match(state.failure, /Too many cells/);
  assert.equal(state.count, 0);
  assert.equal(env.primitives.length, 0);
  assert.match(
    layer.getRowControls().info,
    /Wikipedia coverage unavailable: Too many cells/,
  );
  assert.equal(layer.getStats().error, state.failure);

  // Across the antimeridian the window is one box with west > east.
  refused = new Set();
  env.moveTo({ lat: 60, lon: 179.8, height: 8e5 });
  await flush();
  const dateline = source.calls.at(-1);
  assert.equal(dateline.res, 4);
  assert.ok(dateline.box.west > 0 && dateline.box.east < 0);
  assert.equal(env.primitives.length, 1);
  layer.destroy();
  assert.equal(env.primitives.length, 0);
});

test('a variant the hex grid lacks (404) greys its chip with the message, like an unbuilt grid (503)', async () => {
  const env = fakeViewer({ height: 8e6 });
  // The raster has text sizes; the hex grid was built without them.
  const source = fakeSource({ text: true });
  const layer = createWikipediaCoverageLayer({
    source,
    storage: memoryStorage(),
  });
  layer.init(env.viewer);
  layer.enable(env.viewer);
  layer.setHexes(true);
  await flush();
  assert.equal(env.primitives.length, 1);
  assert.ok(
    layer.getRowControls().chips.every((chip) => chip.state === undefined),
    'every chip offered while the grid has the variant',
  );
  layer.getRowControls().chips[1].onClick(); // text
  await flush();
  assert.equal(source.calls.at(-1).variant, 'text');
  assert.equal(
    env.primitives.length,
    0,
    'nothing drawn for the missing variant',
  );
  const state = layer._state().hexes;
  assert.deepEqual(
    { status: state.status, variant: state.variant, count: state.count },
    { status: 404, variant: 'text', count: 0 },
  );
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => [chip.id, chip.state]),
    [
      ['articles', undefined],
      ['text', 'error'],
      ['count', undefined],
      ['hexes', undefined],
    ],
  );
  assert.match(controls.info, /built without --text/);
  assert.deepEqual(controls.legend, [], 'no domain, no legend');
  // Back to a variant the grid has: drawn again, nothing greyed.
  controls.chips[0].onClick();
  await flush();
  assert.equal(env.primitives.length, 1);
  assert.ok(
    layer.getRowControls().chips.every((chip) => chip.state === undefined),
  );
  layer.destroy();
});
