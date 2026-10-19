// Personal fork: the Earth Engine overlays in the scene and their panel rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import {
  DEFAULT_OPACITY,
  INK_STORAGE_PREFIX,
  LEVEL_STORAGE_PREFIX,
  OPACITY_STORAGE_PREFIX,
  attributionCredit,
  createEarthEngineLayer,
  readLevel,
  readMode,
  readOpacity,
  viewMoved,
  viewRectangleDegrees,
} from './index.js';
import {
  CATALOG_TTL_MS,
  createEarthEngineSource,
  tileTemplate,
  toCatalogLayer,
} from './source.js';
import { legendLabel, rowControls, statusText } from './presentation.js';
import { demSourceCredit } from '../../data/dataCredits.js';

const record = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);

function fakeViewer(height = 5_000_000) {
  const layers = [];
  const listeners = [];
  let lat = 39.29;
  let lon = -76.61;
  return {
    layers,
    listeners,
    setHeight: (h) => (height = h),
    setCentre: (nextLat, nextLon) => ((lat = nextLat), (lon = nextLon)),
    settle: () => listeners.forEach((fn) => fn()),
    viewer: {
      imageryLayers: {
        add(layer) {
          layers.push(layer);
          return layer;
        },
        remove(layer) {
          const i = layers.indexOf(layer);
          if (i >= 0) layers.splice(i, 1);
          return i >= 0;
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
    },
  };
}

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

const serverLayer = (id, extra = {}) => ({
  id,
  name: record(id).name,
  kind: record(id).kind,
  tileUrl: `/api/earth-engine/tile/${id}/{variant}/{ink}/{z}/{x}/{y}`,
  inks: record(id).inks ? Object.keys(record(id).inks) : ['default'],
  maxZoom: record(id).maxZoom,
  variants: (record(id).variants || [{ key: 'default' }]).map((v) => ({
    key: v.key,
    ready: true,
    ...(v.auto ? { auto: true } : {}),
    ...(v.minHeightM !== undefined ? { minHeightM: v.minHeightM } : {}),
    ...(v.maxHeightM !== undefined ? { maxHeightM: v.maxHeightM } : {}),
  })),
  legend: record(id).legend,
  attribution: `Google Earth Engine · ${record(id).attribution}`,
  error: null,
  ...extra,
});

function fakeServer(body) {
  const calls = [];
  return {
    calls,
    set: (next) => (body = next),
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json(body);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

test('the catalog is checked on the way in, shared, and kept a few minutes', async () => {
  assert.equal(toCatalogLayer({ id: '../etc' }), null);
  assert.deepEqual(
    toCatalogLayer({
      id: 'ee-forest-loss',
      maxZoom: 40,
      variants: [{ key: 'default', ready: true }, { key: 'bad key!' }],
      legend: [
        { label: '2001', color: '#ffff00' },
        { label: 'x', color: 'red' },
      ],
      error: null,
    }),
    {
      id: 'ee-forest-loss',
      attribution: '',
      maxZoom: 18,
      variants: [{ key: 'default', ready: true }],
      inks: ['default'],
      legend: [{ label: '2001', color: '#ffff00' }],
      error: null,
    },
  );
  assert.deepEqual(
    toCatalogLayer({ id: 'ee-x', inks: ['light', 'dark', 'bad ink'] }).inks,
    ['light', 'dark'],
  );
  assert.equal(
    tileTemplate('ee-forest-loss', 'default'),
    '/api/earth-engine/tile/ee-forest-loss/default/default/{z}/{x}/{y}',
  );
  assert.equal(
    tileTemplate('ee-admin-boundaries', 'level1', 'dark'),
    '/api/earth-engine/tile/ee-admin-boundaries/level1/dark/{z}/{x}/{y}',
  );
  // The map request's hash rides along, so a changed expression is a new
  // URL to the browser's cache; anything else is dropped.
  assert.equal(
    tileTemplate('ee-admin-boundaries', 'level0', 'dark', '0123456789ab'),
    '/api/earth-engine/tile/ee-admin-boundaries/level0/dark/{z}/{x}/{y}?v=0123456789ab',
  );
  assert.equal(
    tileTemplate('ee-admin-boundaries', 'level0', 'dark', '../x'),
    '/api/earth-engine/tile/ee-admin-boundaries/level0/dark/{z}/{x}/{y}',
  );
  assert.deepEqual(
    toCatalogLayer({
      id: 'ee-admin-boundaries',
      variants: [
        {
          key: 'level0',
          ready: true,
          versions: { light: '0123456789ab', dark: 'nothex', 'x y': 'ab' },
        },
      ],
    }).variants[0].versions,
    { light: '0123456789ab' },
  );
  let clock = 0;
  const server = fakeServer({
    configured: true,
    tiles: { used: 12, budget: 20000 },
    layers: [serverLayer('ee-forest-loss')],
  });
  const source = createEarthEngineSource({
    fetchImpl: server.fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([source.catalog(), source.catalog()]);
  assert.equal(a, b);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0], '/api/earth-engine/layers');
  assert.equal(a.layers.get('ee-forest-loss').maxZoom, 12);
  assert.deepEqual(a.tiles, { used: 12, budget: 20000 });
  clock += CATALOG_TTL_MS + 1;
  await source.catalog();
  assert.equal(server.calls.length, 2);
  assert.equal(source.last().at, clock);
});

test('an overlay drapes the proxy’s tiles at its stored opacity, and its row carries legend, slider and status', async () => {
  const fake = fakeViewer(3_000_000);
  const server = fakeServer({
    configured: true,
    tiles: { used: 40, budget: 20000 },
    layers: EARTH_ENGINE_LAYERS.map((layer) => serverLayer(layer.id)),
  });
  const source = createEarthEngineSource({ fetchImpl: server.fetchImpl });
  const storage = memoryStorage({
    [`${OPACITY_STORAGE_PREFIX}ee-forest-loss`]: '0.4',
  });
  const renders = [];
  const layer = createEarthEngineLayer({
    record: record('ee-forest-loss'),
    source,
    storage,
    requestRender: (reason) => renders.push(reason),
  });
  let heard = 0;
  layer.setRowControlsListener(() => heard++);
  assert.equal(layer.id, 'ee-forest-loss');
  assert.equal(layer.name, 'Forest loss');
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 1);
  const [imagery] = fake.layers;
  assert.ok(
    imagery.imageryProvider instanceof Cesium.UrlTemplateImageryProvider,
  );
  assert.equal(imagery.alpha, 0.4, 'the stored opacity');
  assert.equal(imagery.imageryProvider.maximumLevel, 12);
  assert.match(
    imagery.imageryProvider.url,
    /\/api\/earth-engine\/tile\/ee-forest-loss\/default\/default\/\{z\}\/\{x\}\/\{y\}$/,
  );
  assert.match(
    imagery.imageryProvider.credit.html,
    /Google Earth Engine · Hansen\/UMD/,
  );
  assert.ok(renders.includes('earth-engine-show'));
  assert.ok(heard > 0);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['2001', '2009', '2017', '2025'],
  );
  assert.equal(controls.slider.value, 40);
  assert.equal(controls.info, '40 of 20000 tiles today');
  assert.match(controls.infoTitle, /CC BY 4\.0/);
  // The slider sets and keeps the opacity.
  controls.slider.onInput(85);
  assert.equal(imagery.alpha, 0.85);
  assert.equal(
    storage.map.get(`${OPACITY_STORAGE_PREFIX}ee-forest-loss`),
    '0.85',
  );
  assert.ok(renders.includes('earth-engine-opacity'));
  assert.equal(layer.getStats().countLabel, '85%');
  layer.disable();
  assert.equal(fake.layers.length, 0, 'off: nothing draped');
  assert.equal(fake.listeners.length, 0);
  layer.destroy();
});

test('the boundaries change level with the camera, and a broken store falls back', async () => {
  const fake = fakeViewer(3_000_000);
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 0 },
    layers: [serverLayer('ee-admin-boundaries')],
  });
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readOpacity(throwing, 'x'), DEFAULT_OPACITY);
  const layer = createEarthEngineLayer({
    record: record('ee-admin-boundaries'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: throwing,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().variant, 'level1');
  assert.match(
    fake.layers[0].imageryProvider.url,
    /ee-admin-boundaries\/level1\/light\//,
    'light ink without a map stack (a dark basemap is assumed)',
  );
  assert.equal(layer._state().ink, 'light');
  assert.equal(layer.getRowControls().info, 'First-level units');
  fake.setHeight(200_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level2');
  assert.equal(fake.layers.length, 1, 'one level at a time');
  assert.match(
    fake.layers[0].imageryProvider.url,
    /ee-admin-boundaries\/level2\/light\//,
  );
  layer.getRowControls().slider.onInput(50);
  assert.equal(
    fake.layers[0].alpha,
    0.5,
    'kept for the page when the store refuses',
  );
  layer.destroy();
});

test('without a key, or with an Earth Engine error, the row says so and nothing is draped', async () => {
  const fake = fakeViewer();
  const server = fakeServer({
    configured: false,
    message:
      'Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to draw the Earth Engine layers',
    tiles: { used: 0, budget: 20000 },
    layers: [
      serverLayer('ee-terrain-slope', { error: 'Set EARTH_ENGINE_KEY_FILE…' }),
    ],
  });
  const source = createEarthEngineSource({ fetchImpl: server.fetchImpl });
  const layer = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source,
    storage: memoryStorage(),
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Set EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to draw the Earth Engine layers',
  );
  // Configured, but Earth Engine refused the map: its words, verbatim.
  server.set({
    configured: true,
    tiles: { used: 0, budget: 20000 },
    layers: [
      serverLayer('ee-terrain-slope', {
        error: 'Earth Engine 400: Image.setDefaultProjection: Unknown argument',
      }),
    ],
  });
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Earth Engine: Earth Engine 400: Image.setDefaultProjection: Unknown argument',
  );
  assert.equal(
    layer.getStats().error,
    'Earth Engine 400: Image.setDefaultProjection: Unknown argument',
  );
  layer.destroy();
  // The server unreachable.
  const down = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({
      fetchImpl: async () => new Response('{}', { status: 500 }),
    }),
    storage: memoryStorage(),
  });
  down.init(fake.viewer);
  down.enable(fake.viewer);
  await flush();
  assert.equal(
    down.getRowControls().info,
    'Earth Engine unavailable: HTTP 500',
  );
  down.destroy();
});

test('each overlay credits Earth Engine and its dataset, escaped', () => {
  const credit = attributionCredit(record('ee-admin-boundaries'));
  assert.equal(credit.key, 'earth-engine-ee-admin-boundaries');
  assert.match(
    credit.html,
    /^Administrative boundaries: <a href="https:\/\/earthengine\.google\.com\/"[^>]*>Google Earth Engine<\/a> · FAO GAUL 2025/,
  );
  assert.equal(
    attributionCredit({
      id: 'ee-x',
      name: '<b>',
      attribution: 'a & b',
    }).html.includes('&lt;b&gt;'),
    true,
  );
});

test('legend words and status lines read in English by default', () => {
  assert.equal(legendLabel('N'), 'N');
  assert.equal(legendLabel('Shade'), 'Shade');
  assert.equal(legendLabel('2001'), '2001');
  assert.equal(statusText({ loading: true }), 'Asking Earth Engine…');
  assert.equal(statusText({}), '');
});

/** An imagery collection like Cesium's (a viewer's or a tileset's). */
function fakeCollection() {
  const layers = [];
  let destroyed = false;
  return {
    layers,
    destroy: () => (destroyed = true),
    add(layer) {
      if (destroyed) throw new Error('destroyed');
      layers.push(layer);
      return layer;
    },
    addImageryProvider(provider) {
      if (destroyed) throw new Error('destroyed');
      const layer = { provider, alpha: 1 };
      layers.push(layer);
      return layer;
    },
    remove(layer) {
      if (destroyed) throw new Error('destroyed');
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      return i >= 0;
    },
  };
}

/** A map stack controller like src/maps/controller.js, for draping. */
function fakeMapStack(viewer) {
  const listeners = new Set();
  let tileset = null;
  return {
    getImageryHostTileset: () => tileset,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listeners,
    /** Settle on a stack: photoreal shows a tileset and hides the globe. */
    settle(next) {
      tileset = next.tileset ?? null;
      viewer.scene.globe.show = next.globe === true;
      for (const listener of [...listeners]) listener({ activeId: next.id });
    },
  };
}

test('in photoreal the overlay drapes on the Google tileset, follows map switches, and keeps its opacity', async () => {
  const fake = fakeViewer(60_000);
  fake.viewer.scene = { globe: { show: false } };
  const globe = fakeCollection();
  fake.viewer.imageryLayers = globe;
  const stack = fakeMapStack(fake.viewer);
  const photoreal = {
    show: true,
    imageryLayers: fakeCollection(),
    isDestroyed: () => false,
  };
  stack.settle({ id: 'photoreal', tileset: photoreal });
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 20000 },
    layers: [serverLayer('ee-terrain-slope')],
  });
  const layer = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
  });
  layer.init(fake.viewer);
  layer.attachMapStackController(stack);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(photoreal.imageryLayers.layers.length, 1, 'on the tileset');
  assert.equal(globe.layers.length, 0, 'not asked for twice');
  assert.equal(layer._state().host, 'tileset');
  layer.getRowControls().slider.onInput(40);
  assert.equal(photoreal.imageryLayers.layers[0].alpha, 0.4);
  // To a globe map: it moves to the globe, at the same opacity.
  stack.settle({ id: 'esri-imagery', globe: true });
  assert.equal(photoreal.imageryLayers.layers.length, 0);
  assert.equal(globe.layers.length, 1);
  assert.equal(globe.layers[0].alpha, 0.4);
  assert.equal(layer._state().host, 'globe');
  // Back to photoreal, on a tileset made anew; the old one is gone.
  photoreal.imageryLayers.destroy();
  const again = {
    show: true,
    imageryLayers: fakeCollection(),
    isDestroyed: () => false,
  };
  stack.settle({ id: 'photoreal', tileset: again });
  assert.equal(
    again.imageryLayers.layers.length,
    1,
    're-draped on the new tileset',
  );
  assert.equal(globe.layers.length, 0);
  assert.equal(again.imageryLayers.layers[0].alpha, 0.4);
  // A tileset destroyed under the overlay: the next switch still re-drapes.
  const third = {
    show: true,
    imageryLayers: fakeCollection(),
    isDestroyed: () => false,
  };
  again.imageryLayers.destroy();
  stack.settle({ id: 'photoreal', tileset: third });
  assert.equal(third.imageryLayers.layers.length, 1);
  // Off: gone from the host; destroyed: no longer listening.
  layer.disable();
  assert.equal(third.imageryLayers.layers.length, 0);
  assert.equal(globe.layers.length, 0);
  layer.destroy();
  assert.equal(stack.listeners.size, 0);
});

test('a map that can drape nothing says so in the row', async () => {
  const fake = fakeViewer(3_000_000);
  fake.viewer.scene = { globe: { show: false } };
  fake.viewer.imageryLayers = fakeCollection();
  const stack = fakeMapStack(fake.viewer);
  // A tileset without imagery layers (an older Cesium, a non-draping stack).
  stack.settle({ id: 'photoreal', tileset: { show: true } });
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 20000 },
    layers: [serverLayer('ee-forest-loss')],
  });
  const layer = createEarthEngineLayer({
    record: record('ee-forest-loss'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
  });
  layer.init(fake.viewer);
  layer.attachMapStackController(stack);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().mounted, false);
  assert.equal(fake.viewer.imageryLayers.layers.length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Hidden by this map source · choose a globe map',
  );
  // A globe map later: it draws, and the row says the usual.
  stack.settle({ id: 'esri-imagery', globe: true });
  assert.equal(fake.viewer.imageryLayers.layers.length, 1);
  assert.equal(layer.getRowControls().info, '0 of 20000 tiles today');
  layer.destroy();
});

test('an overlay covers only the view’s neighbourhood, rebuilt as the view moves', async () => {
  // A square of 6 × the camera height (at least 40 km), the world past 5,000 km.
  const box = viewRectangleDegrees(39.29, -76.61, 60_000);
  assert.ok(
    Math.abs(
      box.north - box.south - 2 * (180_000 / 6_378_137) * (180 / Math.PI),
    ) < 1e-9,
  );
  assert.ok(
    box.east - box.west > box.north - box.south,
    'wider in longitude at 39°N',
  );
  const close = viewRectangleDegrees(39.29, -76.61, 500);
  assert.ok(close.north - close.south > 0.35, 'never under 40 km');
  assert.equal(
    viewRectangleDegrees(39.29, -76.61, 2_000_000),
    null,
    'the planet',
  );
  const made = { lat: 39.29, lon: -76.61, height: 60_000 };
  assert.equal(viewMoved(null, made), true);
  assert.equal(
    viewMoved(made, { ...made, lon: -76.0 }),
    false,
    '50 km: inside',
  );
  assert.equal(
    viewMoved(made, { ...made, lon: -75.3 }),
    true,
    '110 km: past half',
  );
  assert.equal(
    viewMoved(made, { ...made, height: 130_000 }),
    true,
    'twice as high',
  );
  assert.equal(
    viewMoved(made, { ...made, height: 25_000 }),
    true,
    'under half',
  );

  const fake = fakeViewer(60_000);
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 20000 },
    layers: [serverLayer('ee-terrain-slope')],
  });
  const layer = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  const [first] = fake.layers;
  assert.ok(first instanceof Cesium.ImageryLayer);
  assert.equal(
    first.imageryProvider.minimumLevel,
    0,
    'a raised minimum would fan out on tilesets',
  );
  assert.equal(
    first.imageryProvider.maximumLevel,
    17,
    'over the United States: as deep as 3DEP 1 m goes',
  );
  const rect = first.rectangle;
  const deg = (r) => Cesium.Math.toDegrees(r);
  assert.ok(deg(rect.south) < 39.29 && deg(rect.north) > 39.29);
  assert.ok(
    deg(rect.north) - deg(rect.south) < 3.5,
    'about 360 km, not the planet',
  );
  // A small move keeps it; a long one rebuilds it around the new view.
  fake.setCentre(39.3, -76.5);
  fake.settle();
  assert.equal(fake.layers[0], first);
  // 135 km north: past half the way to the edge (90 km at 60 km up).
  fake.setCentre(40.5, -76.61);
  fake.settle();
  assert.equal(fake.layers.length, 1);
  assert.notEqual(fake.layers[0], first);
  assert.ok(deg(fake.layers[0].rectangle.north) > 40.5);
  const moved = fake.layers[0].rectangle;
  assert.ok(
    Math.abs((deg(moved.north) + deg(moved.south)) / 2 - 40.5) < 1e-6,
    'centred on the new view',
  );
  layer.destroy();
});

test('above its ceiling an overlay asks for nothing and says how low to go', async () => {
  const fake = fakeViewer(4_000_000);
  const server = fakeServer({
    configured: true,
    tiles: { used: 1200, budget: 20000 },
    layers: [serverLayer('ee-forest-loss', { tilesToday: 1158 })],
  });
  const layer = createEarthEngineLayer({
    record: record('ee-forest-loss'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 0, 'forest loss from 4,000 km: nothing');
  assert.equal(
    layer.getRowControls().info,
    'Zoom in below 3000 km to draw it · 1158 tiles today, this layer · 1200 of 20000 tiles today',
  );
  fake.setHeight(60_000);
  fake.settle();
  assert.equal(fake.layers.length, 1, 'below it: drawn');
  assert.equal(
    layer.getRowControls().info,
    '1158 tiles today, this layer · 1200 of 20000 tiles today',
  );
  fake.setHeight(3_500_000);
  fake.settle();
  assert.equal(fake.layers.length, 0, 'and taken off again above it');
  // Only forest loss has a ceiling: its loss years mean nothing averaged
  // down. Terrain pyramids into continental relief and draws from orbit;
  // the boundaries' first level is for far views.
  assert.equal(record('ee-forest-loss').maxHeightM, 3_000_000);
  for (const id of [
    'ee-terrain-slope',
    'ee-terrain-aspect',
    'ee-terrain-hillshade',
    'ee-admin-boundaries',
  ])
    assert.equal(record(id).maxHeightM, undefined, id);
  layer.destroy();
  // Terrain from orbit: drawn.
  const slope = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({
      fetchImpl: fakeServer({
        configured: true,
        tiles: { used: 0, budget: 20000 },
        layers: [
          serverLayer('ee-terrain-slope', {
            variants: [
              {
                key: 'far',
                ready: true,
                auto: true,
                minHeightM: 3_337_500,
                versions: { default: 'aaaaaaaaaaaa' },
              },
              {
                key: 'base',
                ready: true,
                auto: true,
                minHeightM: 104_296.875,
                maxHeightM: 3_337_500,
                versions: { default: 'bbbbbbbbbbbb' },
              },
            ],
          }),
        ],
      }).fetchImpl,
    }),
    storage: memoryStorage(),
  });
  fake.setHeight(20_000_000);
  slope.init(fake.viewer);
  slope.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 1, 'slope from 20,000 km: the planet');
  assert.match(
    fake.layers[0].imageryProvider.url,
    /\/ee-terrain-slope\/far\/default\/\{z\}\/\{x\}\/\{y\}\?v=aaaaaaaaaaaa$/,
    'the far band (GMTED2010), which Earth Engine answers in under a second; the map hash in the URL',
  );
  assert.equal(
    fake.layers[0].rectangle.west,
    -Math.PI,
    'no view rectangle: the whole world',
  );
  // Below 3,337 km FABDEM's band takes over.
  fake.setHeight(1_000_000);
  fake.settle();
  assert.equal(fake.layers.length, 1);
  assert.match(
    fake.layers[0].imageryProvider.url,
    /\/ee-terrain-slope\/base\/default\/\{z\}\/\{x\}\/\{y\}\?v=bbbbbbbbbbbb$/,
  );
  slope.destroy();
});

/** A map stack controller with a luminance, as src/maps/controller.js exposes it. */
function fakeLuminanceStack(luminance = 'dark') {
  const listeners = new Set();
  return {
    listeners,
    getImageryHostTileset: () => null,
    getActiveLuminance: () => luminance,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Settle on a basemap of a luminance. */
    settle(next) {
      luminance = next;
      for (const listener of [...listeners]) listener({ activeId: next });
    },
  };
}

test('the boundaries take their ink from the basemap, and the chips force and keep an ink', async () => {
  const fake = fakeViewer(3_000_000);
  fake.viewer.scene = { globe: { show: true } };
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 0 },
    layers: [serverLayer('ee-admin-boundaries')],
  });
  const storage = memoryStorage();
  const stack = fakeLuminanceStack('light');
  const layer = createEarthEngineLayer({
    record: record('ee-admin-boundaries'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage,
  });
  layer.init(fake.viewer);
  layer.attachMapStackController(stack);
  layer.enable(fake.viewer);
  await flush();
  // A light basemap (the white globe, Positron): dark ink, a dark swatch.
  assert.equal(layer._state().ink, 'dark');
  assert.match(fake.layers[0].imageryProvider.url, /\/level1\/dark\/\{z\}/);
  const controls = layer.getRowControls();
  assert.deepEqual(controls.legend, [{ label: 'Boundary', color: '#1a1a1a' }]);
  assert.deepEqual(
    controls.chips.map((chip) => [chip.id, chip.active]),
    [
      ['level-auto', true],
      ['level-level0', false],
      ['level-level1', false],
      ['level-level2', false],
      ['ink-auto', true],
      ['ink-light', false],
      ['ink-dark', false],
    ],
  );
  assert.equal(controls.chips[4].label, 'AUTO INK');
  assert.equal(controls.chips[1].label, 'COUNTRIES');
  // The basemap switches to imagery: light ink, re-draped, one layer.
  const before = fake.layers[0];
  stack.settle('dark');
  assert.equal(layer._state().ink, 'light');
  assert.equal(fake.layers.length, 1);
  assert.notEqual(fake.layers[0], before);
  assert.match(fake.layers[0].imageryProvider.url, /\/level1\/light\/\{z\}/);
  assert.deepEqual(layer.getRowControls().legend, [
    { label: 'Boundary', color: '#ffffff' },
  ]);
  // Forced dark on a dark map: kept in the browser, drawn at once.
  layer.getRowControls().chips[6].onClick();
  assert.equal(
    storage.map.get(`${INK_STORAGE_PREFIX}ee-admin-boundaries`),
    'dark',
  );
  assert.equal(layer._state().ink, 'dark');
  assert.match(fake.layers[0].imageryProvider.url, /\/level1\/dark\//);
  assert.equal(layer.getRowControls().chips[6].active, true);
  stack.settle('light');
  assert.equal(
    layer._state().ink,
    'dark',
    'forced: the basemap no longer decides',
  );
  layer.getRowControls().chips[4].onClick();
  assert.equal(
    storage.map.get(`${INK_STORAGE_PREFIX}ee-admin-boundaries`),
    'auto',
  );
  assert.equal(layer._state().ink, 'dark', 'auto on a light map');
  layer.destroy();

  // A stored ink is read back; an unknown one is AUTO.
  const again = createEarthEngineLayer({
    record: record('ee-admin-boundaries'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage({
      [`${INK_STORAGE_PREFIX}ee-admin-boundaries`]: 'light',
    }),
  });
  again.init(fake.viewer);
  again.attachMapStackController(fakeLuminanceStack('light'));
  again.enable(fake.viewer);
  await flush();
  assert.equal(again._state().inkSetting, 'light');
  assert.equal(again._state().ink, 'light');
  again.destroy();
  assert.equal(
    createEarthEngineLayer({
      record: record('ee-admin-boundaries'),
      source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
      storage: memoryStorage({
        [`${INK_STORAGE_PREFIX}ee-admin-boundaries`]: 'purple',
      }),
    })._state().inkSetting,
    'auto',
  );
  // An image layer has no ink chips and a 'default' ink in its URL; its
  // DEM stack bands are no chips either.
  const slope = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({
      fetchImpl: fakeServer({
        configured: true,
        tiles: { used: 0, budget: 0 },
        layers: [serverLayer('ee-terrain-slope')],
      }).fetchImpl,
    }),
    storage: memoryStorage(),
  });
  assert.deepEqual(slope.getRowControls().chips, []);
  fake.setHeight(60_000);
  slope.init(fake.viewer);
  slope.enable(fake.viewer);
  await flush();
  assert.match(fake.layers[0].imageryProvider.url, /\/polar\/default\/\{z\}/);
  assert.equal(slope._state().ink, 'default');
  slope.destroy();
});

test('the level chips force countries, regions or districts, kept in the browser, and districts far out say the tiles are slow', async () => {
  const fake = fakeViewer(3_000_000);
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 0 },
    layers: [serverLayer('ee-admin-boundaries')],
  });
  const storage = memoryStorage();
  const layer = createEarthEngineLayer({
    record: record('ee-admin-boundaries'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().variant, 'level1', 'AUTO from 3,000 km');
  const chip = (id) => layer.getRowControls().chips.find((c) => c.id === id);
  chip('level-level0').onClick();
  assert.equal(
    storage.map.get(`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`),
    'level0',
  );
  assert.equal(layer._state().variant, 'level0');
  assert.match(fake.layers[0].imageryProvider.url, /\/level0\/light\//);
  assert.equal(layer.getRowControls().info, 'Countries');
  assert.equal(chip('level-level0').active, true);
  assert.equal(chip('level-auto').active, false);
  // Forced levels do not follow the camera.
  fake.setHeight(200_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level0', 'still countries close in');
  chip('level-level2').onClick();
  assert.equal(layer._state().variant, 'level2');
  assert.equal(layer.getRowControls().info, 'Second-level units');
  fake.setHeight(5_000_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level2', 'still districts from orbit');
  assert.equal(
    layer.getRowControls().info,
    'Second-level units · Districts from this height: the tiles arrive slowly',
  );
  chip('level-level1').onClick();
  assert.equal(layer._state().variant, 'level1');
  assert.equal(layer.getRowControls().info, 'First-level units');
  chip('level-auto').onClick();
  assert.equal(
    storage.map.get(`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`),
    'auto',
  );
  fake.setHeight(200_000);
  fake.settle();
  assert.equal(layer._state().variant, 'level2', 'AUTO follows the camera');
  assert.equal(
    layer.getRowControls().info,
    'Second-level units',
    'not slow: AUTO chose it',
  );
  layer.destroy();
  // A stored level is read back; one the layer lacks is AUTO.
  const boundaries = record('ee-admin-boundaries');
  assert.equal(
    readLevel(
      memoryStorage({
        [`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`]: 'level2',
      }),
      boundaries,
    ),
    'level2',
  );
  assert.equal(
    readLevel(
      memoryStorage({
        [`${LEVEL_STORAGE_PREFIX}ee-admin-boundaries`]: 'level9',
      }),
      boundaries,
    ),
    'auto',
  );
  assert.equal(readLevel(memoryStorage(), record('ee-forest-loss')), 'auto');
});

// Personal fork: Surface water and Land cover in the panel.
test('Surface water and Land cover rows: their mode chips, the mode kept, its legend, Land cover’s ceiling', () => {
  const water = EARTH_ENGINE_LAYERS.find((l) => l.id === 'ee-surface-water');
  const cover = EARTH_ENGINE_LAYERS.find((l) => l.id === 'ee-land-cover');
  const storage = (value) => ({ getItem: () => value });
  assert.equal(readMode(storage(null), water), 'occurrence');
  assert.equal(readMode(storage('change'), water), 'change');
  assert.equal(
    readMode(storage('network'), water),
    'occurrence',
    'not its mode',
  );
  assert.equal(readMode(storage('v100'), cover), 'v100');
  const row = rowControls({
    record: water,
    opacity: 0.8,
    onOpacity() {},
    mode: 'change',
  });
  assert.deepEqual(
    row.chips.map((chip) => [chip.id, chip.active]),
    [
      ['mode-occurrence', false],
      ['mode-change', true],
      ['mode-seasonality', false],
    ],
  );
  assert.deepEqual(
    row.legend.map((entry) => [entry.label, entry.color]),
    [
      ['Water lost', '#b2182b'],
      ['Little change', '#f3e4e4'],
      ['Water gained', '#2166ac'],
    ],
  );
  const coverRow = rowControls({
    record: cover,
    opacity: 0.8,
    onOpacity() {},
    mode: 'v200',
    catalog: { configured: true, tiles: {} },
    ceilingM: cover.maxHeightM,
  });
  assert.deepEqual(
    coverRow.chips.map((chip) => chip.label),
    ['2021', '2020'],
  );
  assert.equal(coverRow.legend.length, 11);
  assert.deepEqual(coverRow.legend[0], {
    label: 'Tree cover',
    color: '#006400',
  });
  assert.match(coverRow.info, /Zoom in below 10000 km to draw it/);
});

test('the terrain layers: each tile by the DEM stack band of its zoom, the row naming the source under the view, the credit and the depth following the sources in it', async () => {
  const fake = fakeViewer(20_000);
  fake.setCentre(46.85, -121.76);
  const bands = record('ee-terrain-slope').variants;
  const server = fakeServer({
    configured: true,
    tiles: { used: 0, budget: 20000 },
    layers: [
      serverLayer('ee-terrain-slope', {
        maxZoom: 17,
        variants: [
          ...bands.map((v) => ({
            key: v.key,
            ready: false,
            auto: true,
            ...(v.minHeightM ? { minHeightM: v.minHeightM } : {}),
            ...(v.maxHeightM ? { maxHeightM: v.maxHeightM } : {}),
            versions: { default: '111111111111' },
          })),
          {
            key: 'zoom',
            ready: false,
            minZoom: 0,
            versions: { default: 'abcdefabcdef' },
          },
        ],
      }),
    ],
  });
  const registered = [];
  const layer = createEarthEngineLayer({
    record: record('ee-terrain-slope'),
    source: createEarthEngineSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
    credits: { register: (viewer, credit) => registered.push(credit.key) },
    demCredit: demSourceCredit,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  // Mount Rainier from 20 km: through the zoom variant, as deep as 3DEP 1 m.
  const [rainier] = fake.layers;
  assert.match(
    rainier.imageryProvider.url,
    /\/ee-terrain-slope\/zoom\/default\/\{z\}\/\{x\}\/\{y\}\?v=abcdefabcdef$/,
  );
  assert.equal(rainier.imageryProvider.minimumLevel, 0);
  assert.equal(rainier.imageryProvider.maximumLevel, 17);
  assert.equal(
    layer.getRowControls().info,
    'Elevation: USGS 3DEP 10 m · 0 of 20000 tiles today',
  );
  const creditOf = (imagery) => imagery.imageryProvider.credit.html;
  assert.match(
    creditOf(rainier),
    /^Google Earth Engine · FABDEM 30 m: FABDEM v1-2/,
  );
  assert.match(creditOf(rainier), /USGS 3DEP 10 m: .*USGS 3DEP 1 m: /);
  assert.doesNotMatch(creditOf(rainier), /ArcticDEM|REMA|GMTED/);
  assert.match(layer.getRowControls().infoTitle, /CC BY-NC-SA 4\.0/);
  assert.deepEqual(registered, [
    'earth-engine-ee-terrain-slope',
    'dem-fabdem',
    'dem-3dep10',
    'dem-3dep1',
  ]);
  // Closer: 3DEP 1 m where lidar covers, 10 m between surveys.
  fake.setHeight(5_000);
  fake.settle();
  assert.match(
    layer.getRowControls().info,
    /^Elevation: USGS 3DEP 1 m \/ USGS 3DEP 10 m · /,
  );
  // The Alps: FABDEM, no deeper than z 14, the US sources no longer credited.
  fake.setCentre(46.5, 8.0);
  fake.setHeight(20_000);
  fake.settle();
  const [alps] = fake.layers;
  assert.notEqual(alps, rainier);
  assert.equal(alps.imageryProvider.maximumLevel, 14);
  assert.equal(
    layer.getRowControls().info,
    'Elevation: FABDEM 30 m · 0 of 20000 tiles today',
  );
  assert.doesNotMatch(creditOf(alps), /3DEP/);
  // Tromsø from 60 km: ArcticDEM on top, as deep as z 16.
  fake.setCentre(69.65, 18.96);
  fake.setHeight(60_000);
  fake.settle();
  assert.equal(fake.layers[0].imageryProvider.maximumLevel, 16);
  assert.match(layer.getRowControls().info, /^Elevation: ArcticDEM 2 m · /);
  assert.match(creditOf(fake.layers[0]), /ArcticDEM 2 m: ArcticDEM v4\.1/);
  assert.ok(registered.includes('dem-arcticdem'));
  // From orbit: GMTED2010, the whole world.
  fake.setHeight(20_000_000);
  fake.settle();
  assert.match(layer.getRowControls().info, /^Elevation: GMTED2010 230 m · /);
  assert.equal(fake.layers[0].rectangle.west, -Math.PI);
  layer.destroy();
});

test('Elevation: the same stack, its polar sources only beneath, in its own tint', () => {
  const elevation = record('ee-elevation');
  assert.equal(elevation.demStack, true);
  assert.equal(elevation.transform, 'sqrt');
  assert.ok(elevation.variants.every((v) => v.heights === true));
  assert.deepEqual(
    elevation.legend.map((entry) => entry.label),
    ['0 m', '400 m', '1,600 m', '3,600 m', '6,400 m+'],
  );
  // The legend's stops are the squares of the tint's 0 to 80 range.
  assert.deepEqual(elevation.vis, {
    min: 0,
    max: 80,
    palette: elevation.vis.palette,
  });
  assert.equal(elevation.vis.palette.length, 9);
  assert.equal(`#${elevation.vis.palette[2]}`, elevation.legend[1].color);
  assert.equal(`#${elevation.vis.palette[8]}`, elevation.legend[4].color);
  assert.match(attributionCredit(elevation).html, /^Elevation: <a href=/);
  assert.match(attributionCredit(elevation).html, /credited below$/);
});
