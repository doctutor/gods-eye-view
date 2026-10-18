// Personal fork: the Wikipedia coverage layer in the scene and its panel row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  DEFAULT_OPACITY,
  LAYER_ID,
  OPACITY_STORAGE_KEY,
  attributionCredit,
  createWikipediaCoverageLayer,
  readOpacity,
} from './index.js';
import {
  CATALOG_TTL_MS,
  createWikipediaCoverageSource,
  decodeTile,
  tileUrl,
  toCatalog,
  toCatalogVariant,
} from './source.js';
import {
  MIN_ALPHA,
  formatValue,
  legendStops,
  paintTile,
  rampColor,
  rampHex,
  rampPosition,
} from './ramp.js';
import { createCoverageImageryProvider } from './provider.js';
import { DEFAULT_VARIANT, VARIANTS, statusText } from './presentation.js';

/** A tile's bytes as the server writes them. */
function encodeTile(values, size = 256) {
  const buffer = new ArrayBuffer(16 + size * size * 4);
  const view = new DataView(buffer);
  'WCT1'.split('').forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, size, true);
  view.setUint32(8, size, true);
  view.setUint32(12, 1, true);
  new Float32Array(buffer, 16, size * size).set(values);
  return buffer;
}

/** A canvas stub: records what was painted. */
function stubCanvasFactory() {
  const made = [];
  return {
    made,
    createCanvas(width, height) {
      const canvas = { width, height, painted: null };
      canvas.getContext = () => ({
        createImageData: (w, h) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
        }),
        putImageData: (image, x, y) => {
          canvas.painted = { image, x, y };
        },
      });
      made.push(canvas);
      return canvas;
    },
  };
}

function fakeViewer(height = 5_000_000) {
  const layers = [];
  const listeners = [];
  let lat = 39.29;
  let lon = -76.61;
  return {
    layers,
    listeners,
    setHeight: (h) => (height = h),
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

const serverCatalog = (extra = {}) => ({
  configured: true,
  builtAt: '2026-10-18T03:28:51.999Z',
  dump: { date: '2026-10-08', lastModified: 'Thu, 08 Oct 2026 03:30:29 GMT' },
  rows: { kept: 1_259_442, read: 2_814_713 },
  text: false,
  tileUrl: '/api/wikipedia-coverage/tile/{variant}/{z}/{x}/{y}',
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

test('the ramp: zero is transparent, the floor dark and half-seen, the ceiling pale and opaque', () => {
  const domain = { min: 0.01, max: 100 };
  assert.ok(Number.isNaN(rampPosition(0, domain)));
  assert.ok(Number.isNaN(rampPosition(-1, domain)));
  assert.equal(rampPosition(0.01, domain), 0);
  assert.ok(
    Math.abs(rampPosition(1, domain) - 0.5) < 1e-12,
    'log scale: the geometric middle',
  );
  assert.equal(rampPosition(100, domain), 1);
  assert.equal(rampPosition(1e9, domain), 1, 'clamped above');
  assert.equal(rampPosition(1e-9, domain), 0, 'clamped below');
  assert.ok(
    Number.isNaN(rampPosition(1, { min: 0, max: 1 })),
    'a bad domain draws nothing',
  );
  assert.deepEqual(rampColor(NaN), [0, 0, 0, 0]);
  const floor = rampColor(0);
  assert.deepEqual(floor.slice(0, 3), [20, 11, 52]);
  assert.equal(floor[3], Math.round(MIN_ALPHA * 255));
  const ceiling = rampColor(1);
  assert.deepEqual(ceiling, [252, 255, 164, 255]);
  assert.equal(rampColor(0.5)[3], 255, 'opaque from a third of the way up');
  assert.equal(rampHex(1), '#fcffa4');
  assert.equal(rampHex(0), '#140b34');
  // Monotone brightness.
  let last = -1;
  for (let i = 0; i <= 10; i++) {
    const [r, g, b] = rampColor(i / 10);
    const brightness = r + g + b;
    assert.ok(brightness > last, `brighter at ${i / 10}`);
    last = brightness;
  }
});

test('painting a tile: one pixel per value, transparent where there is nothing', () => {
  const values = new Float32Array(4 * 4);
  values[0] = 0.01; // the floor
  values[5] = 100; // the ceiling
  values[10] = 1; // the middle
  values[15] = 1e6; // above the ceiling
  const out = new Uint8ClampedArray(4 * 4 * 4);
  const painted = paintTile(values, { min: 0.01, max: 100 }, out);
  assert.equal(painted, 4);
  assert.deepEqual([...out.slice(0, 4)], rampColor(0));
  assert.deepEqual([...out.slice(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...out.slice(20, 24)], rampColor(1));
  // The middle goes through a 256-step lookup: within a count of the exact colour.
  const middle = [...out.slice(40, 44)];
  assert.ok(
    middle.every((c, i) => Math.abs(c - rampColor(0.5)[i]) <= 2),
    `${middle} ≈ ${rampColor(0.5)}`,
  );
  assert.deepEqual(
    [...out.slice(60, 64)],
    rampColor(1),
    'clamped to the ceiling',
  );
  assert.throws(
    () => paintTile(values, { min: 0.01, max: 100 }, new Uint8ClampedArray(8)),
    RangeError,
  );
});

test('legend stops and value labels', () => {
  assert.equal(formatValue(0.033), '0.033');
  assert.equal(formatValue(0.0834), '0.083');
  assert.equal(formatValue(1.35), '1.4');
  assert.equal(formatValue(12.8), '13');
  assert.equal(formatValue(30), '30');
  assert.equal(formatValue(251.4), '251');
  assert.equal(formatValue(1234), '1234');
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(NaN), '—');
  assert.equal(formatValue(950, { bytes: true }), '950 B');
  assert.equal(formatValue(12_345, { bytes: true }), '12 kB');
  assert.equal(formatValue(31_623, { bytes: true }), '32 kB');
  assert.equal(formatValue(2.5e6, { bytes: true }), '2.5 MB');
  assert.equal(formatValue(3e9, { bytes: true }), '3 GB');
  const stops = legendStops({ min: 0.01, max: 100 });
  assert.deepEqual(
    stops.map((stop) => stop.label),
    ['0.01', '0.1', '1', '10', '100+'],
  );
  assert.equal(stops[0].color, rampHex(0));
  assert.equal(stops[4].color, rampHex(1));
  assert.deepEqual(legendStops(null), []);
  assert.deepEqual(legendStops({ min: 0, max: 1 }), []);
  assert.deepEqual(
    legendStops({ min: 1000, max: 1e7 }, { bytes: true }).map((s) => s.label),
    ['1 kB', '10 kB', '100 kB', '1 MB', '10 MB+'],
  );
});

test('the catalog and tiles are checked on the way in', () => {
  assert.equal(toCatalogVariant({ key: 'pages', available: true }), null);
  assert.deepEqual(toCatalogVariant({ key: 'text', available: true }), {
    key: 'text',
    available: false,
  });
  assert.deepEqual(
    toCatalogVariant({
      key: 'count',
      available: true,
      domain: { min: 1, max: 30, median: 2 },
    }),
    { key: 'count', available: true, domain: { min: 1, max: 30, median: 2 } },
  );
  assert.equal(
    toCatalogVariant({
      key: 'count',
      available: true,
      domain: { min: 0, max: 30 },
    }).available,
    false,
    'a log ramp needs a positive floor',
  );
  const catalog = toCatalog(
    serverCatalog({ maxZoom: 40, dump: { date: 'soon' } }),
  );
  assert.equal(catalog.configured, true);
  assert.equal(catalog.dumpDate, '');
  assert.equal(catalog.maxZoom, 14);
  assert.equal(catalog.articles, 1_259_442);
  assert.deepEqual([...catalog.variants.keys()], ['articles', 'text', 'count']);
  assert.equal(catalog.variants.get('text').available, false);
  const empty = toCatalog({
    configured: false,
    message: 'Run npm run wikipedia:build…',
  });
  assert.equal(empty.configured, false);
  assert.equal(
    empty.variants.size,
    3,
    'every variant is listed, none available',
  );
  assert.equal(
    tileUrl('articles', 3, 2, 1),
    '/api/wikipedia-coverage/tile/articles/3/2/1',
  );

  const values = new Float32Array(256 * 256);
  values[7] = 0.5;
  const decoded = decodeTile(encodeTile(values));
  assert.equal(decoded.width, 256);
  assert.equal(decoded.values[7], 0.5);
  assert.throws(() => decodeTile(new ArrayBuffer(8)), /Not a coverage tile/);
  assert.throws(
    () => decodeTile(encodeTile(values).slice(0, 100)),
    /truncated/,
  );
  const wrong = encodeTile(values);
  new DataView(wrong).setUint8(0, 'X'.charCodeAt(0));
  assert.throws(() => decodeTile(wrong), /Not a coverage tile/);
});

test('the catalog source shares one request and keeps it a few minutes', async () => {
  let clock = 0;
  const server = fakeServer(serverCatalog());
  const source = createWikipediaCoverageSource({
    fetchImpl: server.fetchImpl,
    now: () => clock,
  });
  const [a, b] = await Promise.all([source.catalog(), source.catalog()]);
  assert.equal(a, b);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0], '/api/wikipedia-coverage/layers');
  assert.equal(a.dumpDate, '2026-10-08');
  clock += CATALOG_TTL_MS + 1;
  await source.catalog();
  assert.equal(server.calls.length, 2);
  assert.equal(source.last().at, clock);
  const down = createWikipediaCoverageSource({
    fetchImpl: async () => new Response('{"error":"boom"}', { status: 500 }),
  });
  await assert.rejects(down.catalog(), /boom/);
});

test('the imagery provider paints fetched values on a canvas and defers a throttled request', async () => {
  const canvases = stubCanvasFactory();
  const requests = [];
  const values = new Float32Array(256 * 256);
  values[0] = 0.033; // the floor: dark, half-seen
  values[1] = 1.35; // the ceiling
  values[256] = 0.21; // the geometric middle of the domain
  let throttle = false;
  const provider = createCoverageImageryProvider({
    variant: 'articles',
    domain: { min: 0.033, max: 1.35 },
    maximumLevel: 9,
    credit: 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData <b>',
    fetchTile: (url, request) => {
      requests.push({ url, request });
      if (throttle) return undefined;
      return Promise.resolve(encodeTile(values));
    },
    createCanvas: canvases.createCanvas,
  });
  assert.ok(provider.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.equal(provider.rectangle, provider.tilingScheme.rectangle);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.minimumLevel, 0);
  assert.equal(provider.maximumLevel, 9);
  assert.equal(provider.ready, true);
  assert.equal(provider.hasAlphaChannel, true);
  assert.ok(provider.errorEvent instanceof Cesium.Event);
  assert.equal(provider.getTileCredits(0, 0, 0), undefined);
  assert.match(provider.credit.html, /&lt;b&gt;$/, 'the credit is escaped');
  const request = { marker: true };
  const canvas = await provider.requestImage(2, 1, 3, request);
  assert.deepEqual(requests[0], {
    url: '/api/wikipedia-coverage/tile/articles/3/2/1',
    request,
  });
  assert.equal(canvas, canvases.made[0]);
  assert.equal(canvas.width, 256);
  const data = canvas.painted.image.data;
  assert.deepEqual([...data.slice(0, 4)], rampColor(0), 'the floor');
  assert.deepEqual([...data.slice(4, 8)], rampColor(1), 'the ceiling');
  assert.deepEqual(
    [...data.slice(8, 12)],
    [0, 0, 0, 0],
    'nothing is transparent',
  );
  const middle = [...data.slice(256 * 4, 256 * 4 + 4)];
  const expected = rampColor(rampPosition(0.21, { min: 0.033, max: 1.35 }));
  assert.ok(
    middle.every((c, i) => Math.abs(c - expected[i]) <= 2),
    `${middle} ≈ ${expected}`,
  );
  assert.deepEqual(provider.stats, {
    requested: 1,
    painted: 1,
    empty: 0,
    failed: 0,
  });
  throttle = true;
  assert.equal(
    provider.requestImage(0, 0, 0, request),
    undefined,
    'throttled: Cesium asks again',
  );
  throttle = false;
  const failing = createCoverageImageryProvider({
    variant: 'count',
    domain: { min: 1, max: 30 },
    fetchTile: () => Promise.reject(new Error('503')),
    createCanvas: canvases.createCanvas,
  });
  await assert.rejects(failing.requestImage(0, 0, 0), /503/);
  assert.equal(failing.stats.failed, 1);
  assert.equal(failing.credit, undefined);
});

test('the layer drapes the chosen variant at its stored opacity; chips switch it, the slider keeps it', async () => {
  const fake = fakeViewer(3_000_000);
  const server = fakeServer(serverCatalog());
  const source = createWikipediaCoverageSource({ fetchImpl: server.fetchImpl });
  const storage = memoryStorage({ [OPACITY_STORAGE_KEY]: '0.4' });
  const renders = [];
  const credits = [];
  const canvases = stubCanvasFactory();
  const layer = createWikipediaCoverageLayer({
    source,
    storage,
    requestRender: (reason) => renders.push(reason),
    credits: { register: (_viewer, credit) => credits.push(credit) },
    fetchTile: () => Promise.resolve(encodeTile(new Float32Array(256 * 256))),
    createCanvas: canvases.createCanvas,
  });
  let heard = 0;
  layer.setRowControlsListener(() => heard++);
  assert.equal(layer.id, LAYER_ID);
  assert.equal(layer.name, 'Wikipedia coverage');
  assert.equal(layer.source, 'Wikimedia GeoData');
  layer.init(fake.viewer);
  // Off: nothing is draped and the row is quiet.
  assert.equal(layer.getRowControls().info, '');
  assert.equal(layer.getStats().countLabel, '—');
  layer.enable(fake.viewer);
  assert.match(layer.getRowControls().info, /^Asking the server…$/);
  await flush();
  assert.equal(fake.layers.length, 1);
  const [imagery] = fake.layers;
  assert.ok(imagery instanceof Cesium.ImageryLayer);
  assert.equal(imagery.alpha, 0.4, 'the stored opacity');
  assert.equal(imagery.imageryProvider.variant, 'articles');
  assert.equal(imagery.imageryProvider.maximumLevel, 9);
  assert.equal(imagery.imageryProvider.minimumLevel, 0);
  assert.ok(imagery.rectangle, 'a view-sized rectangle at 3,000 km');
  assert.ok(renders.includes('wikipedia-coverage-show'));
  assert.ok(heard > 0);
  assert.equal(credits[0].key, 'wikipedia-coverage');
  // The provider fetches through the layer's tile fetcher and paints.
  const canvas = await imagery.imageryProvider.requestImage(0, 0, 0, {});
  assert.equal(canvas, canvases.made[0]);

  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => [chip.id, chip.active, chip.state]),
    [
      ['articles', true, undefined],
      ['text', false, 'error'],
      ['count', false, undefined],
    ],
  );
  assert.equal(controls.chips[0].label, 'Articles per km²');
  assert.deepEqual(
    controls.legend.map((stop) => stop.label),
    ['0.033', '0.083', '0.21', '0.53', '1.4+'],
  );
  assert.equal(controls.slider.value, 40);
  assert.equal(
    controls.info,
    'Dump of 2026-10-08 · 1259442 geotagged articles',
  );
  assert.equal(
    controls.infoTitle,
    'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData',
  );

  // A chip switches the variant: a new provider, the same opacity.
  controls.chips[2].onClick();
  assert.equal(fake.layers.length, 1, 'one variant at a time');
  assert.notEqual(fake.layers[0], imagery);
  assert.equal(fake.layers[0].imageryProvider.variant, 'count');
  assert.equal(fake.layers[0].alpha, 0.4);
  assert.equal(layer._state().variant, 'count');
  assert.deepEqual(
    layer.getRowControls().legend.map((stop) => stop.label),
    ['1', '2.3', '5.5', '13', '30+'],
  );
  // The text variant is not built: the chip says what to run, nothing drapes.
  layer.getRowControls().chips[1].onClick();
  assert.equal(fake.layers.length, 0);
  assert.match(
    layer.getRowControls().info,
    /^Article sizes are not built: run npm run wikipedia:build -- --text · Dump of/,
  );
  assert.deepEqual(layer.getRowControls().legend, []);
  layer.getRowControls().chips[0].onClick();
  assert.equal(fake.layers.length, 1);

  // The slider sets and keeps the opacity.
  layer.getRowControls().slider.onInput(85);
  assert.equal(fake.layers[0].alpha, 0.85);
  assert.equal(storage.map.get(OPACITY_STORAGE_KEY), '0.85');
  assert.ok(renders.includes('wikipedia-coverage-opacity'));
  assert.equal(layer.getStats().countLabel, '85%');

  // Far out, the whole world; the rectangle goes.
  fake.setHeight(20_000_000);
  fake.settle();
  assert.equal(fake.layers.length, 1);
  assert.equal(
    fake.layers[0].rectangle.west,
    -Math.PI,
    'the whole world from orbit',
  );

  layer.disable();
  assert.equal(fake.layers.length, 0, 'off: nothing draped');
  assert.equal(fake.listeners.length, 0);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});

test('without a grid the row says what to run, and a rebuild with sizes is picked up', async () => {
  const fake = fakeViewer();
  const server = fakeServer({
    configured: false,
    message: 'Run npm run wikipedia:build to build the Wikipedia coverage grid',
    attribution: 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData',
    variants: [
      { key: 'articles', available: false },
      { key: 'text', available: false },
      { key: 'count', available: false },
    ],
  });
  const source = createWikipediaCoverageSource({ fetchImpl: server.fetchImpl });
  const layer = createWikipediaCoverageLayer({
    source,
    storage: memoryStorage(),
    createCanvas: stubCanvasFactory().createCanvas,
    fetchTile: () => assert.fail('no tile is asked for'),
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(fake.layers.length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Run npm run wikipedia:build to build the Wikipedia coverage grid',
  );
  assert.ok(
    layer.getRowControls().chips.every((chip) => chip.state === undefined),
  );
  server.set(
    serverCatalog({
      text: true,
      variants: [
        { key: 'articles', available: true, domain: { min: 0.033, max: 1.35 } },
        { key: 'text', available: true, domain: { min: 500, max: 2e6 } },
        { key: 'count', available: true, domain: { min: 1, max: 30 } },
      ],
    }),
  );
  await layer.update();
  assert.equal(fake.layers.length, 1);
  layer.getRowControls().chips[1].onClick();
  assert.equal(fake.layers[0].imageryProvider.variant, 'text');
  assert.deepEqual(
    layer.getRowControls().legend.map((stop) => stop.label),
    ['500 B', '4 kB', '32 kB', '251 kB', '2 MB+'],
  );
  assert.equal(
    layer.getRowControls().info,
    'Dump of 2026-10-08 · 1259442 geotagged articles',
  );
  layer.destroy();

  // The server unreachable.
  const down = createWikipediaCoverageLayer({
    source: createWikipediaCoverageSource({
      fetchImpl: async () => new Response('{}', { status: 500 }),
    }),
    storage: memoryStorage(),
  });
  down.init(fake.viewer);
  down.enable(fake.viewer);
  await flush();
  assert.equal(
    down.getRowControls().info,
    'Wikipedia coverage unavailable: HTTP 500',
  );
  assert.equal(down.getStats().error, 'HTTP 500');
  down.destroy();
});

test('the layer follows the map stack: the globe, a photoreal tileset, or nowhere', async () => {
  const fake = fakeViewer(3_000_000);
  fake.viewer.scene = { globe: { show: true } };
  const server = fakeServer(serverCatalog());
  const layer = createWikipediaCoverageLayer({
    source: createWikipediaCoverageSource({ fetchImpl: server.fetchImpl }),
    storage: memoryStorage(),
    createCanvas: stubCanvasFactory().createCanvas,
    fetchTile: () => Promise.resolve(encodeTile(new Float32Array(256 * 256))),
  });
  const tilesetLayers = [];
  const tileset = {
    imageryLayers: {
      add: (l) => tilesetLayers.push(l),
      remove: (l) => tilesetLayers.splice(tilesetLayers.indexOf(l), 1),
    },
    isDestroyed: () => false,
  };
  let host = 'globe';
  const listeners = new Set();
  const controller = {
    getImageryHostTileset: () => (host === 'tileset' ? tileset : null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  layer.init(fake.viewer);
  layer.attachMapStackController(controller);
  layer.enable(fake.viewer);
  await flush();
  assert.equal(layer._state().host, 'globe');
  assert.equal(fake.layers.length, 1);
  // The globe hides for a photoreal tileset: re-draped on it.
  fake.viewer.scene.globe.show = false;
  host = 'tileset';
  listeners.forEach((fn) => fn());
  assert.equal(layer._state().host, 'tileset');
  assert.equal(fake.layers.length, 0);
  assert.equal(tilesetLayers.length, 1);
  // Nowhere to drape: the row says so.
  host = 'none';
  listeners.forEach((fn) => fn());
  assert.equal(layer._state().mounted, false);
  assert.equal(tilesetLayers.length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Hidden by this map source · choose a globe map',
  );
  fake.viewer.scene.globe.show = true;
  host = 'globe';
  listeners.forEach((fn) => fn());
  assert.equal(layer._state().host, 'globe');
  layer.destroy();
  assert.equal(listeners.size, 0);
});

test('the opacity store, the credit and the status words', () => {
  assert.equal(readOpacity(memoryStorage()), DEFAULT_OPACITY);
  assert.equal(
    readOpacity(memoryStorage({ [OPACITY_STORAGE_KEY]: '2' })),
    DEFAULT_OPACITY,
  );
  assert.equal(
    readOpacity(memoryStorage({ [OPACITY_STORAGE_KEY]: '0.3' })),
    0.3,
  );
  assert.equal(
    readOpacity({
      getItem() {
        throw new Error('denied');
      },
    }),
    DEFAULT_OPACITY,
  );
  const credit = attributionCredit(
    'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData <b>',
  );
  assert.equal(credit.key, 'wikipedia-coverage');
  assert.match(
    credit.html,
    /^Wikipedia coverage: <a href="https:\/\/www\.mediawiki\.org\/wiki\/Extension:GeoData"/,
  );
  assert.match(credit.html, /&lt;b&gt;$/);
  assert.equal(DEFAULT_VARIANT, 'articles');
  assert.deepEqual(
    VARIANTS.map((v) => v.key),
    ['articles', 'text', 'count'],
  );
  assert.equal(
    statusText({ failure: 'HTTP 500' }),
    'Wikipedia coverage unavailable: HTTP 500',
  );
  assert.equal(statusText({ loading: true }), 'Asking the server…');
  assert.equal(statusText({}), '');
  assert.equal(
    statusText({ catalog: { configured: false, message: '' } }),
    'Run npm run wikipedia:build to build the Wikipedia coverage grid',
  );
  const catalog = toCatalog(serverCatalog({ rows: { kept: 1 } }));
  assert.equal(
    statusText({ catalog }),
    'Dump of 2026-10-08 · 1 geotagged article',
  );
  assert.equal(
    statusText({ catalog, hostless: true }),
    'Hidden by this map source · choose a globe map',
  );
});
