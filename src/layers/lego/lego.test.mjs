// Personal fork: the Lego rendering mode (src/layers/lego/): brick
// quantisation, colour snapping, the cell budget, columns and their mesh,
// the card, the stored mode, the values client and the controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  COLUMN_BUDGET,
  LEGO_PALETTE,
  MAX_CELLS_PER_SIDE,
  boxSizeM,
  brickHeightM,
  cellsForWindow,
  legoViewMoved,
  legoWindow,
  columnCardEntry,
  columnColor,
  elevationBricks,
  gridColumns,
  snapToLego,
  valueBricks,
} from './model.js';
import { buildBrickMesh } from './bricks.js';
import {
  LEGO_LAYER_IDS,
  currentMode,
  isLegoLayer,
  layerSpec,
  withHeader,
} from './layerSpecs.js';
import {
  EXAGGERATION_STORAGE_KEY,
  RENDER_MODE_STORAGE_KEY,
  createRenderModeStore,
  readExaggeration,
  readRenderMode,
} from './renderMode.js';
import { columnCardDetails, legoStatusText } from './presentation.js';
import { LEGO_CARD_SOURCE, createLegoController } from './index.js';
import {
  RasterValuesError,
  createRasterValuesClient,
  decodeRasterValues,
  encodeRasterValues,
  rasterValuesUrl,
} from '../../data/rasterValues.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { setLocale } from '../../i18n/index.js';

const memoryStorage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test('a 2×2 brick: 0.6 of its width tall; heights to the nearest whole brick', () => {
  assert.equal(brickHeightM(30), 18);
  assert.equal(brickHeightM(10), 6);
  assert.equal(elevationBricks(1000, 30), 56); // 1000 / 18 = 55.6
  assert.equal(elevationBricks(1000, 30, 2), 111);
  assert.equal(elevationBricks(8, 30), 0); // under half a brick
  assert.equal(elevationBricks(10, 30), 1);
  assert.equal(elevationBricks(0, 30), 0);
  assert.equal(elevationBricks(-20, 30), 0);
  assert.equal(elevationBricks(NaN, 30), 0);
  // Other rasters: the legend range onto 1–40 bricks; nodata and zero none.
  assert.equal(valueBricks(0.0001, 0, 100), 1);
  assert.equal(valueBricks(100, 0, 100), 40);
  assert.equal(valueBricks(500, 0, 100), 40);
  assert.equal(valueBricks(50, 0, 100), 21);
  assert.equal(valueBricks(0, 0, 100), 0);
  assert.equal(valueBricks(NaN, 0, 100), 0);
  // A log legend: 1 to 10,000 per km², 100 in the middle.
  assert.equal(valueBricks(100, 1, 10000, 'log'), 21);
  assert.equal(valueBricks(-5, 1, 10000, 'log'), 0);
});

test('colours snap to the classic Lego palette (CIE L*a*b*)', () => {
  assert.equal(LEGO_PALETTE.length, 16);
  for (const entry of LEGO_PALETTE) assert.equal(snapToLego(entry.hex), entry);
  assert.equal(snapToLego('#ff0000').name, 'Bright red');
  assert.equal(snapToLego('#0000ff').name, 'Bright blue');
  assert.equal(snapToLego('#fafafa').name, 'White');
  assert.equal(snapToLego('#2b6a2e').name, 'Dark green'); // elevation's lowlands
  assert.equal(snapToLego('#f0e030').name, 'Bright yellow');
  // The elevation ramp from sea level to the snow line.
  const spec = layerSpec('ee-elevation');
  const names = [0, 400, 1600, 3600, 6400].map(
    (m) => columnColor(spec, m).name,
  );
  assert.equal(names[0], 'Dark green');
  assert.equal(names.at(-1), 'White');
  assert.ok(new Set(names).size >= 4, names.join(', '));
});

test('the cell budget: native resolution close in, ≤512 a side and ≤200,000 in all', () => {
  // 120 km square: the budget decides (√200,000 ≈ 447 a side).
  const wide = cellsForWindow({
    widthM: 120_000,
    heightM: 120_000,
    nativeM: 30,
  });
  assert.deepEqual([wide.cols, wide.rows], [447, 447]);
  assert.ok(wide.cols * wide.rows <= COLUMN_BUDGET);
  // 9 km square of 30 m data: native cells, 300 a side.
  const near = cellsForWindow({ widthM: 9_000, heightM: 9_000, nativeM: 30 });
  assert.deepEqual([near.cols, near.rows], [300, 300]);
  assert.equal(Math.round(near.cellSizeM), 30);
  // A long window: never more than 512 a side.
  const long = cellsForWindow({ widthM: 2_000_000, heightM: 100_000 });
  assert.ok(
    long.cols <= MAX_CELLS_PER_SIDE && long.cols * long.rows <= COLUMN_BUDGET,
  );
  // Coarser as the window grows.
  const far = cellsForWindow({
    widthM: 2_000_000,
    heightM: 2_000_000,
    nativeM: 30,
  });
  assert.ok(far.cellSizeM > wide.cellSizeM);
});

const grid = (values, extra = {}) => ({
  header: {
    cols: 3,
    rows: 2,
    west: 0,
    south: 0,
    east: 0.03,
    north: 0.02,
    cellSizeM: 1000,
    units: 'm',
    legendMin: 0,
    legendMax: 100,
    source: 'test',
    ...extra,
  },
  values: Float32Array.from(values),
});

test('columns: one per cell with bricks, north row first, on a base when asked', () => {
  const elevation = gridColumns(grid([600, 0, NaN, 1200, -5, 300]), {
    spec: layerSpec('ee-elevation'),
    elevation: true,
  });
  // 600 m on 1 km cells (600 m bricks) = 1 brick; 1200 = 2; 300 = 1 (0.5 → 1).
  assert.deepEqual(
    elevation.map((c) => [c.col, c.row, c.bricks]),
    [
      [0, 0, 1],
      [0, 1, 2],
      [2, 1, 1],
    ],
  );
  assert.deepEqual(
    [elevation[0].west, elevation[0].north, elevation[1].south],
    [0, 0.02, 0],
  );
  // Another layer on photoreal stands on the elevation grid's heights.
  const base = { values: Float32Array.from([10, 20, 30, 40, 50, 60]) };
  const spec = withHeader(layerSpec('ee-tree-canopy'), grid([]).header);
  const tops = gridColumns(grid([50, 0, 100, NaN, 25, 1]), { spec, base });
  assert.deepEqual(
    tops.map((c) => [c.bricks, c.baseM]),
    [
      [21, 10],
      [40, 30],
      [11, 50],
      [1, 60],
    ],
  );
  // Elevation's own columns never stand on a base.
  const own = gridColumns(grid([600, 0, 0, 0, 0, 0]), {
    spec: layerSpec('ee-elevation'),
    elevation: true,
    base,
  });
  assert.equal(own[0].baseM, 0);
});

test('the mesh: tops, and only the sides a neighbour does not hide', () => {
  const column = (col, row, bricks, baseM = 0) => ({
    col,
    row,
    bricks,
    baseM,
    west: col * 0.01,
    east: (col + 1) * 0.01,
    north: 0.02 - row * 0.01,
    south: 0.02 - (row + 1) * 0.01,
    color: { hex: '#c91a09' },
  });
  const frame = {
    cols: 2,
    rows: 2,
    cellSizeM: 1000,
    centerLon: 0.01,
    centerLat: 0.01,
  };
  // A flat 2 × 2 block: 4 tops and the 8 outer sides.
  const flat = buildBrickMesh(
    [column(0, 0, 3), column(1, 0, 3), column(0, 1, 3), column(1, 1, 3)],
    frame,
  );
  assert.equal(flat.faces, 12);
  assert.equal(flat.vertexCount, 48);
  assert.equal(flat.indices.length, 72);
  // A taller corner shows its two inner sides above its neighbours.
  const step = buildBrickMesh(
    [column(0, 0, 5), column(1, 0, 3), column(0, 1, 3), column(1, 1, 3)],
    frame,
  );
  assert.equal(step.faces, 14);
  assert.deepEqual([...step.boxes.slice(0, 2)], [0, 3000]); // 5 × 600 m
  // Every index is a vertex.
  assert.ok(Math.max(...step.indices) < step.vertexCount);
  assert.ok(step.radius > 1000 && step.radius < 5000);
});

test('the card: N bricks = the value, the cell, the centre, the source; through the world overlay', () => {
  const header = grid([]).header;
  const [column] = gridColumns(grid([2700, 0, 0, 0, 0, 0]), {
    spec: layerSpec('ee-elevation'),
    elevation: true,
  });
  const details = columnCardDetails(column, header, { sourceName: 'FABDEM' });
  assert.deepEqual(details, [
    '5 bricks = 2,700 m',
    'Cell 1,000 m',
    '0.0150° N, 0.0050° E',
    'Source: FABDEM',
  ]);
  const entry = normalizeOverlayEntry(
    LEGO_CARD_SOURCE,
    columnCardEntry({
      column,
      title: 'Elevation',
      details,
      cesium: Cesium,
      topM: 3000,
    }),
  );
  assert.equal(entry.variant, 'card');
  assert.equal(entry.id, 'lego-card');
  assert.equal(entry.title, 'Elevation');
  assert.deepEqual(entry.details, details);
  assert.equal(entry.accent, column.color.hex);
  setLocale('ru');
  try {
    assert.equal(columnCardDetails(column, header)[0], '5 кубиков = 2,700 m');
  } finally {
    setLocale('en');
  }
});

test('the render mode and exaggeration are kept in this browser', () => {
  const storage = memoryStorage();
  assert.equal(readRenderMode(storage), 'colour');
  const store = createRenderModeStore({ storage });
  const seen = [];
  store.subscribe((state) => seen.push(state));
  store.setMode('lego');
  store.setMode('plasma');
  store.setExaggeration(2);
  store.setExaggeration(9);
  assert.equal(storage.map.get(RENDER_MODE_STORAGE_KEY), 'lego');
  assert.equal(storage.map.get(EXAGGERATION_STORAGE_KEY), '2');
  assert.deepEqual(seen, [
    { mode: 'lego', exaggeration: null },
    { mode: 'lego', exaggeration: 2 },
  ]);
  const again = createRenderModeStore({ storage });
  assert.equal(again.getMode(), 'lego');
  assert.equal(again.getExaggeration(), 2);
});

test('raster layers only: Earth Engine images, Census rasters, Wikipedia coverage', () => {
  for (const id of [
    'ee-elevation',
    'ee-population',
    'ee-tree-canopy',
    'wikipedia-coverage',
    'ee-census-tracts',
  ])
    assert.ok(isLegoLayer(id), id);
  for (const id of [
    'ee-rivers',
    'ee-admin-boundaries',
    'ee-elevation-contours',
    'localities',
    'street-assets',
  ])
    assert.ok(!isLegoLayer(id), id);
  assert.ok(LEGO_LAYER_IDS.length > 10);
  assert.deepEqual(
    (({ scale, min, max, elevation }) => ({ scale, min, max, elevation }))(
      layerSpec('ee-elevation'),
    ),
    { scale: 'sqrt', min: 0, max: 6400, elevation: true },
  );
  assert.equal(layerSpec('wikipedia-coverage').scale, 'log');
  assert.equal(layerSpec('ee-population', 'density-2020').scale, 'log');
  // The mode a layer is drawn in, from its own storage key.
  assert.equal(
    currentMode(
      'ee-population',
      memoryStorage({ 'gev.population.mode': 'density-1990' }),
    ),
    'density-1990',
  );
  assert.equal(currentMode('ee-elevation', memoryStorage()), '');
});

test('the values client: URL, decode, LRU, and a 404 said as such', async () => {
  const header = {
    layer: 'x',
    cols: 2,
    rows: 1,
    west: 0,
    south: 0,
    east: 1,
    north: 1,
    cellSizeM: 30,
  };
  const decoded = decodeRasterValues(
    encodeRasterValues(header, Float32Array.from([1.5, NaN])),
  );
  assert.equal(decoded.header.schema, 'raster-values/1');
  assert.equal(decoded.values[0], 1.5);
  assert.ok(Number.isNaN(decoded.values[1]));
  assert.throws(
    () => decodeRasterValues(new ArrayBuffer(2)),
    RasterValuesError,
  );
  assert.equal(
    rasterValuesUrl({
      layer: 'ee-elevation',
      box: { west: 1, south: 2, east: 3, north: 4 },
      cells: 900,
    }),
    '/api/raster/values?layer=ee-elevation&mode=&west=1&south=2&east=3&north=4&cells=512',
  );
  let calls = 0;
  const client = createRasterValuesClient({
    limit: 1,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('layer=missing'))
        return new Response('{}', { status: 404 });
      return new Response(
        encodeRasterValues(header, Float32Array.from([1, 2])),
      );
    },
  });
  const box = { west: 0, south: 0, east: 1, north: 1 };
  await client.fetch({ layer: 'a', box, cells: 2 });
  await client.fetch({ layer: 'a', box, cells: 2 });
  assert.equal(calls, 1);
  await client.fetch({ layer: 'b', box, cells: 2 });
  await client.fetch({ layer: 'a', box, cells: 2 });
  assert.equal(calls, 3, 'the LRU keeps one');
  await assert.rejects(
    client.fetch({ layer: 'missing', box, cells: 2 }),
    (error) => error.status === 404,
  );
});

function fakeViewer({ terrain = false } = {}) {
  const added = [];
  return {
    added,
    camera: {
      positionCartographic: {
        latitude: Cesium.Math.toRadians(46.5),
        longitude: Cesium.Math.toRadians(9.8),
        height: 20_000,
      },
      moveEnd: { addEventListener: () => () => {} },
    },
    terrainProvider: terrain ? {} : new Cesium.EllipsoidTerrainProvider(),
    scene: {
      canvas: null,
      primitives: {
        add: (p) => added.push(p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
    },
  };
}

test('the controller: off in colour, bricks for the last raster layer on, a base on terrain, unavailable without the service', async () => {
  const asked = [];
  const values = {
    fetch: async ({ layer, cells, box }) => {
      asked.push(layer);
      if (layer === 'wikipedia-coverage')
        throw new RasterValuesError('Raster values 404', 404);
      const cols = 4;
      const rows = 4;
      return {
        header: {
          cols,
          rows,
          ...box,
          cellSizeM: 300,
          units: layer === 'ee-elevation' ? 'm' : '%',
          legendMin: 0,
          legendMax: 100,
          source: 'test',
          cells,
        },
        values: Float32Array.from({ length: 16 }, (_, i) =>
          i % 5 ? 40 + i * 10 : NaN,
        ),
      };
    },
  };
  const enabled = new Set(['ee-tree-canopy']);
  let activity = null;
  const storage = memoryStorage();
  const store = createRenderModeStore({ storage });
  const viewer = fakeViewer({ terrain: true });
  const lego = createLegoController({
    viewer,
    layers: {
      getAll: () => [...enabled].map((id) => ({ id })),
      isEnabled: (id) => enabled.has(id),
      subscribeActivity: (fn) => ((activity = fn), () => {}),
    },
    store,
    values,
    storage,
    setTimeoutImpl: (fn) => (fn(), 0),
    clearTimeoutImpl: () => {},
  });
  await lego.rebuild({ force: true });
  assert.equal(lego.getStatus().state, 'off');
  store.setMode('lego');
  await lego.rebuild({ force: true });
  const status = lego.getStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.layer, 'ee-tree-canopy');
  assert.equal(status.columns, 12);
  assert.deepEqual(asked, [
    'ee-tree-canopy',
    'ee-elevation',
    'ee-tree-canopy',
    'ee-elevation',
  ]);
  assert.equal(viewer.added.length, 1);
  // The last raster layer turned on wins.
  enabled.add('wikipedia-coverage');
  activity({ type: 'visibility-settled', layerId: 'wikipedia-coverage' });
  await lego.rebuild({ force: true });
  assert.equal(lego.getStatus().state, 'unavailable');
  assert.match(legoStatusText(lego.getStatus()), /raster values service/);
  assert.equal(viewer.added.length, 0);
  // Back to colour: nothing drawn.
  store.setMode('colour');
  await lego.rebuild({ force: true });
  assert.equal(lego.getStatus().state, 'off');
  lego.destroy();
});

test('the exaggeration defaults to 2× on a flat basemap and 1× on terrain until chosen', () => {
  const storage = memoryStorage();
  assert.equal(readExaggeration(storage), null);
  const store = createRenderModeStore({ storage });
  assert.equal(store.isExaggerationSet(), false);
  assert.equal(store.getExaggeration(true), 2);
  assert.equal(store.getExaggeration(false), 1);
  // Choosing the default still counts as a choice, kept on every ground.
  store.setExaggeration(1);
  assert.equal(store.isExaggerationSet(), true);
  assert.equal(store.getExaggeration(true), 1);
  assert.equal(storage.map.get(EXAGGERATION_STORAGE_KEY), '1');
  const chosen = createRenderModeStore({
    storage: memoryStorage({ [EXAGGERATION_STORAGE_KEY]: '3' }),
  });
  assert.equal(chosen.getExaggeration(true), 3);
  assert.equal(chosen.getExaggeration(false), 3);
});

test('the window fits the ground in view: 2.5 camera heights, at least 10 km', () => {
  const bricksAt = (heightM) => {
    const size = boxSizeM(legoWindow(39.29, -76.61, heightM));
    const { cellSizeM } = cellsForWindow({ ...size, nativeM: 30 });
    return { widthKm: size.widthM / 1000, brickM: brickHeightM(cellSizeM) };
  };
  const at40 = bricksAt(40_000);
  assert.ok(Math.abs(at40.widthKm - 100) < 0.5, String(at40.widthKm));
  assert.ok(Math.abs(at40.brickM - 134) < 2, String(at40.brickM));
  assert.ok(Math.abs(bricksAt(10_000).brickM - 34) < 1);
  // Below about 5 km the 30 m elevation cells are native: 18 m bricks.
  assert.equal(Math.round(bricksAt(5_000).brickM), 18);
  assert.equal(Math.round(bricksAt(2_000).brickM), 18);
  assert.ok(Math.abs(bricksAt(2_000).widthKm - 10) < 0.1);
  // A planet-wide height has no window of its own.
  assert.equal(legoWindow(0, 0, 10_000_000), null);
  // Rebuilt past the window's middle half, or at twice or half the height.
  const made = { lat: 39.29, lon: -76.61, height: 40_000 };
  assert.equal(legoViewMoved(made, { ...made, height: 70_000 }), false);
  assert.equal(legoViewMoved(made, { ...made, height: 90_000 }), true);
  assert.equal(legoViewMoved(made, { ...made, height: 19_000 }), true);
  // 25 km is half of the 50 km half-side: 20 km stays, 30 km rebuilds.
  assert.equal(
    legoViewMoved(made, { ...made, lat: 39.29 + 20 / 111.2 }),
    false,
  );
  assert.equal(legoViewMoved(made, { ...made, lat: 39.29 + 30 / 111.2 }), true);
});
