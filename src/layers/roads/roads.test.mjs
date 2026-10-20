// Personal fork: the Roads layer (src/layers/roads/): its tiles on the map
// stack's host, its chips and legends, the click's card, and Street
// assets' bike lanes from the roads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createRoadsLayer } from './index.js';
import {
  createRoadsSource,
  roadsImageryOptions,
  toRoadSegment,
  toRoadsStatus,
} from './source.js';
import {
  legendFor,
  roadCardDetails,
  roadCardTitle,
  statusText,
} from './presentation.js';
import { createStreetAssetsLayer } from '../streetAssets/index.js';

const STATUS = {
  configured: true,
  version: 'abcdef123456',
  segments: 1234567,
  regions: ['conterminous-us', 'europe'],
  regionBoxes: {
    'conterminous-us': [-125, 24.4, -66.8, 49.5],
    europe: [-32, 34, 45, 72],
  },
  maxZoom: 17,
  attribution: 'test',
};
const SEGMENT = {
  name: 'East Lombard Street',
  class: 'residential',
  subclass: '',
  speed: 25,
  speedUnit: 'mph',
  surface: 'paved',
  bridge: false,
  tunnel: false,
  link: false,
  construction: false,
  bicycle: 'allowed',
  source: 'OpenStreetMap',
  distanceM: 1.2,
  line: [
    [-76.61, 39.29],
    [-76.6, 39.29],
  ],
};

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function fakeViewer({ lon = -76.61, lat = 39.29, heightM = 5_000 } = {}) {
  const list = [];
  return {
    list,
    imageryLayers: {
      add: (layer) => (list.push(layer), layer),
      remove: (layer) => {
        const i = list.indexOf(layer);
        if (i >= 0) list.splice(i, 1);
        return i >= 0;
      },
    },
    scene: {
      globe: { show: true },
      canvas: { clientWidth: 1600, clientHeight: 900 },
      pick: () => undefined,
      pickPositionSupported: false,
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(lon, lat, heightM);
      },
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      moveEnd: { addEventListener: () => () => {} },
    },
  };
}

function fakeSource({ status = STATUS, segment = SEGMENT } = {}) {
  const asked = [];
  return {
    asked,
    status: async () => toRoadsStatus(status),
    last: () => toRoadsStatus(status),
    nearest: async (query) => {
      asked.push(query);
      return segment;
    },
    abort: () => {},
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

test('the tiles drape on the globe in the mode and ink; chips switch them', async () => {
  const viewer = fakeViewer();
  const storage = memoryStorage();
  const layer = createRoadsLayer({ source: fakeSource(), storage });
  layer.init(viewer);
  let luminance = 'dark';
  layer.attachMapStackController({
    getImageryHostTileset: () => null,
    getActiveLuminance: () => luminance,
    subscribe: () => () => {},
  });
  layer.enable(viewer);
  await settle();
  assert.equal(viewer.list.length, 1);
  assert.match(
    viewer.list[0].imageryProvider.url,
    /^\/api\/roads\/tile\/network\/light\/\{z\}\/\{x\}\/\{y\}\?v=abcdef123456$/,
  );
  assert.equal(viewer.list[0].imageryProvider.maximumLevel, 17);
  const row = layer.getRowControls();
  assert.deepEqual(
    row.chips.map((chip) => chip.id),
    [
      'mode-network',
      'mode-speed',
      'mode-surface',
      'ink-auto',
      'ink-light',
      'ink-dark',
    ],
  );
  assert.equal(row.legend[0].label, 'Motorway');
  assert.match(
    row.info,
    /^1,234,567 road segments · click a road for its card$/,
  );
  // SPEED: the tiles and the legend follow, and the choice is kept.
  row.chips.find((chip) => chip.id === 'mode-speed').onClick();
  assert.equal(viewer.list.length, 1);
  assert.match(viewer.list[0].imageryProvider.url, /\/speed\/light\//);
  assert.equal(storage.getItem('gev.roads.mode'), 'speed');
  assert.match(layer.getRowControls().legend[0].label, /^30 km\/h \(20 mph\)$/);
  // DARK ink by hand; AUTO again follows a light basemap.
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'ink-dark')
    .onClick();
  assert.match(viewer.list[0].imageryProvider.url, /\/speed\/dark\//);
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'ink-auto')
    .onClick();
  luminance = 'light';
  layer.attachMapStackController({
    getImageryHostTileset: () => null,
    getActiveLuminance: () => luminance,
    subscribe: () => () => {},
  });
  assert.match(viewer.list[0].imageryProvider.url, /\/speed\/dark\//);
  layer.disable();
  assert.equal(viewer.list.length, 0);
});

test('a click on a road opens its card; a miss closes it', async () => {
  const viewer = fakeViewer({ heightM: 2_000 });
  const entries = [];
  const overlayHost = {
    setEntries: (source, list) => entries.push({ source, list }),
    setVisible: () => {},
    clearSource: () => {},
  };
  let segment = SEGMENT;
  const source = fakeSource();
  source.nearest = async (query) => {
    source.asked.push(query);
    return segment;
  };
  const layer = createRoadsLayer({
    source,
    overlayHost,
    storage: memoryStorage(),
  });
  layer.init(viewer);
  layer.enable(viewer);
  await settle();
  await layer._onClick({ x: 800, y: 450 });
  // The zoom Cesium drapes at 2 km.
  assert.equal(source.asked[0].zoom, 16);
  assert.ok(Math.abs(source.asked[0].lon + 76.61) < 1e-9);
  const card = entries.at(-1).list[0];
  assert.equal(entries.at(-1).source, 'roads');
  assert.equal(card.title, 'East Lombard Street');
  assert.deepEqual(card.details, [
    'Residential street',
    'Speed limit 25 mph',
    'Surface: Paved',
    'Bicycles: allowed',
    'Source: Overture Maps · OpenStreetMap',
  ]);
  segment = null;
  await layer._onClick({ x: 10, y: 10 });
  assert.deepEqual(entries.at(-1).list, []);
  layer.disable();
});

test('the words: not built, outside the regions, a ramp on a bridge, the legends', () => {
  assert.equal(
    statusText({ status: toRoadsStatus({ configured: false }) }),
    'Run npm run overture:build -- --roads for the Roads layer',
  );
  assert.match(
    statusText({ status: toRoadsStatus(STATUS), inRegions: false }),
    /built for the United States and Europe; none here$/,
  );
  const ramp = toRoadSegment({
    segment: {
      ...SEGMENT,
      name: '',
      class: 'motorway',
      subclass: 'link',
      bridge: true,
      speed: 0,
      surface: '',
      bicycle: '',
      source: 'TomTom',
    },
  });
  assert.equal(roadCardTitle(ramp), 'Motorway · Ramp');
  assert.deepEqual(roadCardDetails(ramp), [
    'Motorway · Ramp · bridge',
    'Source: Overture Maps · TomTom',
  ]);
  assert.deepEqual(
    legendFor('surface', 'dark').map((entry) => entry.color),
    ['#4d4d4d', '#a0521a', '#b3b3b3'],
  );
  assert.equal(legendFor('speed', 'light').at(-1).label, 'No limit mapped');
  assert.equal(toRoadSegment({ segment: { line: [[0, 0]] } }), null);
  assert.equal(
    roadsImageryOptions(toRoadsStatus({}), 'network', 'light'),
    null,
  );
  assert.equal(
    roadsImageryOptions(toRoadsStatus(STATUS), 'nope', 'light'),
    null,
  );
});

test('the source asks the server and checks its answers', async () => {
  const urls = [];
  const source = createRoadsSource({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/layers')) return Response.json(STATUS);
      if (url.includes('/nearest')) return Response.json({ segment: SEGMENT });
      if (url.includes('points=1'))
        return Response.json({ points: [[1, 2], 'bad'], saturated: true });
      return Response.json({
        lines: [
          {
            kind: 'cycleway',
            name: 'Trail',
            line: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
      });
    },
  });
  const status = await source.status();
  assert.equal(status.configured, true);
  assert.equal(status.boxes.length, 2);
  await source.status();
  assert.equal(urls.length, 1);
  const segment = await source.nearest({ lon: -76.61, lat: 39.29, zoom: 15.6 });
  assert.equal(segment.name, 'East Lombard Street');
  assert.match(
    urls[1],
    /\/api\/roads\/nearest\?lon=-76\.610000&lat=39\.290000&zoom=16$/,
  );
  const lines = await source.bikeLines({
    west: 1,
    south: 2,
    east: 3,
    north: 4,
  });
  assert.equal(lines.lines[0].kind, 'cycleway');
  const points = await source.bikeLines(
    { west: 1, south: 2, east: 3, north: 4 },
    { points: true },
  );
  assert.deepEqual(points, { points: [[1, 2]], saturated: true });
});

test('Street assets: BIKE LANES from the roads when built, lines close in', async () => {
  const viewer = fakeViewer({ heightM: 3_000 });
  viewer.scene.primitives = { add: (p) => p, remove: () => true };
  const asked = [];
  const roads = {
    status: async () => toRoadsStatus(STATUS),
    bikeLines: async (box, options = {}) => {
      asked.push({ box, options });
      return {
        lines: [
          {
            kind: 'cycleway',
            name: 'Trail',
            line: [
              [-76.61, 39.29],
              [-76.6, 39.29],
            ],
          },
          {
            kind: 'cycleway',
            name: 'Trail',
            line: [
              [-76.6, 39.29],
              [-76.59, 39.29],
            ],
          },
          {
            kind: 'shared-path',
            name: '',
            line: [
              [-76.6, 39.3],
              [-76.59, 39.3],
            ],
          },
        ],
        saturated: false,
      };
    },
  };
  const overpass = {
    query: async () => {
      throw new Error('Overpass should not be asked');
    },
    abort: () => {},
  };
  let timer = null;
  const layer = createStreetAssetsLayer({
    roads,
    overpass,
    storage: memoryStorage({ 'gev.streetAssets.type': 'bike' }),
    attachRollup: () => ({ detach() {}, refresh() {}, isActive: () => false }),
    setTimeoutImpl: (fn) => ((timer = fn), 1),
    clearTimeoutImpl: () => {},
  });
  layer.init(viewer);
  layer.enable(viewer);
  await settle();
  timer?.();
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].options.points, false);
  const span = asked[0].box.east - asked[0].box.west;
  assert.ok(span <= 1, String(span));
  layer.disable();
});

// Personal fork (roads-card-fixes): the zoom of what is drawn on a small
// canvas, the row's word for a click, the card through the world overlay,
// and no imagery layer over a provider without a rectangle.
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { imageryRectangleDegrees } from '../../maps/imageryHost.js';

test('a click asks at the zoom drawn on this canvas, and the row says what it found', async () => {
  const paris = (width, height) => {
    const viewer = fakeViewer({ lon: 2.35, lat: 48.86, heightM: 20_000 });
    viewer.scene.canvas = { clientWidth: width, clientHeight: height };
    return viewer;
  };
  const entries = [];
  const overlayHost = {
    setEntries: (source, list) => entries.push({ source, list }),
    setVisible: () => {},
    clearSource: () => {},
  };
  let answer = () => SEGMENT;
  const source = fakeSource();
  source.nearest = async (query) => {
    source.asked.push(query);
    return answer();
  };
  // A 1,600 px canvas drapes z 13 at 20 km; the live 717 × 472 pane z 12.
  for (const [width, height, zoom] of [
    [1600, 900, 13],
    [717, 472, 12],
  ]) {
    const viewer = paris(width, height);
    const layer = createRoadsLayer({
      source,
      overlayHost,
      storage: memoryStorage(),
    });
    layer.init(viewer);
    layer.enable(viewer);
    await settle();
    await layer._onClick({ x: 300, y: 200 });
    assert.equal(source.asked.at(-1).zoom, zoom, `${width} px`);
    assert.match(layer.getRowControls().info, /Clicked: East Lombard Street$/);
    // The card reaches the world overlay as a valid entry.
    const card = entries.at(-1).list[0];
    const normalized = normalizeOverlayEntry('roads', card);
    assert.equal(normalized.variant, 'card');
    assert.equal(normalized.title, 'East Lombard Street');
    // A miss says so, and closes the card.
    answer = () => null;
    await layer._onClick({ x: 10, y: 10 });
    assert.match(layer.getRowControls().info, /No road here$/);
    assert.deepEqual(entries.at(-1).list, []);
    // A failed lookup says so too.
    answer = () => {
      throw new Error('HTTP 500');
    };
    await layer._onClick({ x: 10, y: 10 });
    assert.match(layer.getRowControls().info, /Road lookup failed$/);
    answer = () => SEGMENT;
    layer.disable();
    assert.match(layer.getRowControls().info, /^$/);
  }
});

test('an extent that misses Web Mercator is never mounted (no undefined provider rectangle)', async () => {
  assert.deepEqual(
    imageryRectangleDegrees([
      [-125, 24.4, -66.8, 49.5],
      [-32, 34, 45, 72],
    ]),
    [-125, 24.4, 45, 72],
  );
  assert.deepEqual(
    imageryRectangleDegrees([[-200, -95, 200, 95]]),
    [-180, -85.05112878, 180, 85.05112878],
  );
  assert.equal(imageryRectangleDegrees([]), null);
  assert.equal(imageryRectangleDegrees([[0, 86, 10, 90]]), null); // above Web Mercator
  assert.equal(
    imageryRectangleDegrees([
      [NaN, 0, 1, 1],
      [1, 1, 0, 2],
    ]),
    null,
  );
  // A build whose only region lies beyond 85.05° N: the row stays, no layer.
  const viewer = fakeViewer();
  const layer = createRoadsLayer({
    source: fakeSource({
      status: { ...STATUS, regionBoxes: { arctic: [0, 86, 10, 89] } },
    }),
    storage: memoryStorage(),
  });
  layer.init(viewer);
  layer.enable(viewer);
  await settle();
  assert.equal(viewer.list.length, 0);
  assert.equal(layer._state().mounted, false);
  // Real regions mount, with a provider rectangle.
  const ok = fakeViewer();
  const roads = createRoadsLayer({
    source: fakeSource(),
    storage: memoryStorage(),
  });
  roads.init(ok);
  roads.enable(ok);
  await settle();
  assert.equal(ok.list.length, 1);
  assert.ok(ok.list[0].imageryProvider.rectangle);
});
