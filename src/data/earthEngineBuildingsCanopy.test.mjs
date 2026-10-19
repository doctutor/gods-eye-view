// Personal fork: the Buildings and Tree canopy Earth Engine layers
// (src/data/earthEngineLayers.js) and their expressions
// (server/providers/earthEngine.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ZOOM_VARIANT,
  createEarthEngineService,
  mapKey,
  mapRequestFor,
  variantForZoom,
  zoomMatched,
} from '../../server/providers/earthEngine.js';
import {
  BUILDINGS_BANDS,
  BUILDINGS_FOOTPRINT_ZOOM,
  BUILDINGS_PER_KM2,
  EARTH_ENGINE_LAYERS,
  OPEN_BUILDINGS_YEAR,
  layerInks,
  layerModes,
  layerVariants,
  variantForHeight,
} from './earthEngineLayers.js';
import {
  OPEN_BUILDINGS_BOXES,
  inOpenBuildings,
} from './openBuildingsCoverage.js';

const byId = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const BUILDINGS = byId('ee-buildings');
const CANOPY = byId('ee-tree-canopy');

/** Every functionInvocationValue in a node, depth first. */
function invocations(node, out = []) {
  if (Array.isArray(node)) node.forEach((entry) => invocations(entry, out));
  else if (node && typeof node === 'object') {
    if (node.functionInvocationValue) out.push(node.functionInvocationValue);
    for (const value of Object.values(node)) invocations(value, out);
  }
  return out;
}
const named = (request, name) =>
  invocations(request.expression).filter((call) => call.functionName === name);
const band = (key) => BUILDINGS_BANDS.find((entry) => entry.key === key);

test('Buildings: COUNT, COVER and HEIGHT, the raster to z 14 and footprints over it from z 15', () => {
  assert.equal(BUILDINGS.kind, 'image');
  assert.deepEqual(layerModes(BUILDINGS), ['count', 'cover', 'height']);
  assert.deepEqual(layerInks(BUILDINGS), ['light', 'dark']);
  assert.equal(BUILDINGS.lazyMaps, true);
  assert.equal(BUILDINGS.maxZoom, 17);
  assert.equal(BUILDINGS.maxHeightM, undefined, 'drawn from orbit');
  assert.equal(zoomMatched(BUILDINGS), true);
  assert.equal(BUILDINGS_FOOTPRINT_ZOOM, 15);
  assert.deepEqual(
    layerVariants(BUILDINGS).map((variant) => [variant.key, variant.zooms]),
    [
      ['raster', [0, 14]],
      ['footprints', [15, 17]],
    ],
  );
  for (const [z, key] of [
    [0, 'raster'],
    [14, 'raster'],
    [15, 'footprints'],
    [17, 'footprints'],
  ])
    assert.equal(variantForZoom(BUILDINGS, z).key, key, String(z));
  // The row's words follow the height at which a 1,600 px view drapes z 15.
  assert.equal(variantForHeight(BUILDINGS, 7_000).key, 'raster');
  assert.equal(variantForHeight(BUILDINGS, 6_000).key, 'footprints');
  assert.match(BUILDINGS.attribution, /Open Buildings 2\.5D Temporal v1, 2023/);
  assert.match(BUILDINGS.attribution, /CC BY 4\.0/);
  assert.match(BUILDINGS.attribution, /Copernicus Sentinel-2/);
  assert.match(BUILDINGS.attribution, /Open Buildings v3 polygons/);
});

test('Buildings: one year of the temporal collection, each mode the same quantity at every zoom', () => {
  for (const mode of layerModes(BUILDINGS)) {
    const request = mapRequestFor(BUILDINGS, band('raster'), 'light', mode);
    const filter = named(request, 'Filter.calendarRange')[0];
    assert.deepEqual(
      [filter.arguments.start, filter.arguments.end, filter.arguments.field],
      [
        { constantValue: OPEN_BUILDINGS_YEAR },
        { constantValue: OPEN_BUILDINGS_YEAR },
        { constantValue: 'year' },
      ],
      mode,
    );
    assert.match(
      JSON.stringify(request),
      /GOOGLE\/Research\/open-buildings-temporal\/v1/,
    );
    assert.ok(request.visualizationOptions, `${mode}: a palette`);
  }
  // COUNT: the fractional count per 0.25 m² pixel × 4,000,000 per km², log.
  const count = mapRequestFor(BUILDINGS, band('raster'), 'light', 'count');
  assert.equal(BUILDINGS_PER_KM2, 4_000_000);
  assert.equal(
    named(count, 'Image.multiply')[0].arguments.image2.functionInvocationValue
      .arguments.value.constantValue,
    4_000_000,
  );
  assert.equal(named(count, 'Image.log10').length, 1);
  assert.deepEqual(count.visualizationOptions.ranges, [{ min: 0, max: 4 }]);
  // COVER: the presence band, 2% and more.
  const cover = mapRequestFor(BUILDINGS, band('raster'), 'light', 'cover');
  assert.match(JSON.stringify(cover), /"building_presence"/);
  assert.deepEqual(cover.visualizationOptions.ranges, [{ min: 0, max: 0.5 }]);
  // HEIGHT: height ÷ presence (both MEAN pyramids), masked under 5% built.
  const height = mapRequestFor(BUILDINGS, band('raster'), 'light', 'height');
  const divide = named(height, 'Image.divide')[0];
  assert.match(JSON.stringify(divide.arguments.image1), /"building_height"/);
  assert.match(JSON.stringify(divide.arguments.image2), /"building_presence"/);
  assert.ok(
    named(height, 'Image.gte').some(
      (call) =>
        call.arguments.image2.functionInvocationValue.arguments.value
          .constantValue === 0.05,
    ),
  );
  assert.deepEqual(height.visualizationOptions.ranges, [{ min: 0, max: 30 }]);
});

test('Buildings: from z 15 the mode is visualized and the v3 footprints are blended over it in the ink', () => {
  for (const [ink, color] of [
    ['light', 'ffffffcc'],
    ['dark', '1a1a1acc'],
  ]) {
    const request = mapRequestFor(BUILDINGS, band('footprints'), ink, 'height');
    const root = request.expression.values['0'].functionInvocationValue;
    assert.equal(root.functionName, 'Image.blend');
    const bottom = root.arguments.bottom.functionInvocationValue;
    assert.equal(bottom.functionName, 'Image.visualize');
    assert.equal(bottom.arguments.max.constantValue, 30);
    assert.equal(bottom.arguments.palette.constantValue.length, 5);
    const top = root.arguments.top.functionInvocationValue;
    assert.equal(top.functionName, 'Collection.style');
    assert.equal(top.arguments.color.constantValue, color);
    assert.equal(top.arguments.fillColor.constantValue, '00000000');
    const filter = named(request, 'Filter.gte')[0];
    assert.equal(filter.arguments.leftField.constantValue, 'confidence');
    assert.equal(filter.arguments.rightValue.constantValue, 0.7);
    assert.match(
      JSON.stringify(request),
      /GOOGLE\/Research\/open-buildings\/v3\/polygons/,
    );
    // RGB already: the map has no visualization of its own.
    assert.equal(request.visualizationOptions, undefined);
  }
});

test('Buildings: the zoom variant draws the raster to z 14 and the footprints from z 15, maps made as tiles ask', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-buildings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const made = [];
  const service = createEarthEngineService({
    sourceRoot: root,
    env: {},
    layers: [BUILDINGS],
    backend: {
      async createMap(layer, variant, ink, mode) {
        made.push(mapKey(layer, variant, ink, mode));
        return { name: `projects/p/maps/${variant.key}-${mode}-${ink}` };
      },
      async fetchTile(name, z, x, y) {
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from(`${name}/${z}/${x}/${y}`),
        };
      },
    },
  });
  const catalog = await service.layers();
  assert.deepEqual(made, [], 'lazy: the catalog makes no map');
  assert.deepEqual(catalog.layers[0].modes, ['count', 'cover', 'height']);
  for (const [z, key] of [
    [3, 'raster'],
    [14, 'raster'],
    [15, 'footprints'],
    [17, 'footprints'],
  ]) {
    const tile = await service.tile(
      BUILDINGS.id,
      ZOOM_VARIANT,
      'dark',
      z,
      0,
      0,
      'count',
    );
    assert.equal(
      String(tile.body),
      `projects/p/maps/${key}-count-dark/${z}/0/0`,
    );
  }
  assert.equal(
    (await service.tile(BUILDINGS.id, ZOOM_VARIANT, 'dark', 18, 0, 0, 'count'))
      .status,
    400,
  );
});

test('Buildings: where Open Buildings has data, and where it surely has none', () => {
  assert.equal(OPEN_BUILDINGS_BOXES.length, 46);
  for (const box of OPEN_BUILDINGS_BOXES) {
    assert.equal(box.length, 4);
    assert.ok(box[0] < box[2] && box[1] < box[3], JSON.stringify(box));
  }
  assert.equal(BUILDINGS.coverage.key, 'open-buildings');
  assert.equal(BUILDINGS.coverage.boxes, OPEN_BUILDINGS_BOXES);
  for (const [name, lat, lon] of [
    ['Lagos', 6.455, 3.39],
    ['Jakarta', -6.2, 106.82],
    ['São Paulo', -23.55, -46.635],
    ['Mumbai', 19.08, 72.88],
  ])
    assert.equal(inOpenBuildings(lat, lon), true, name);
  for (const [name, lat, lon] of [
    ['Baltimore', 39.29, -76.61],
    ['Paris', 48.85, 2.35],
    ['Beijing', 39.9, 116.4],
    ['Sydney', -33.87, 151.21],
  ])
    assert.equal(inOpenBuildings(lat, lon), false, name);
});

test('Tree canopy: Meta 1 m and ETH 10 m heights from orbit, zero clear, no cover mode', () => {
  assert.equal(CANOPY.kind, 'image');
  assert.deepEqual(layerModes(CANOPY), ['meta', 'eth']);
  assert.equal(CANOPY.maxHeightM, undefined, 'drawn from orbit');
  assert.equal(CANOPY.lazyMaps, true);
  assert.equal(CANOPY.maxZoom, 16);
  const meta = mapRequestFor(
    CANOPY,
    layerVariants(CANOPY)[0],
    'default',
    'meta',
  );
  assert.match(
    JSON.stringify(meta),
    /projects\/meta-forest-monitoring-okw37\/assets\/CanopyHeight/,
  );
  assert.equal(named(meta, 'ImageCollection.mosaic').length, 1);
  assert.match(JSON.stringify(meta), /"cover_code"/);
  assert.equal(named(meta, 'Image.selfMask').length, 1);
  assert.deepEqual(meta.visualizationOptions.ranges, [{ min: 0, max: 40 }]);
  const eth = mapRequestFor(CANOPY, layerVariants(CANOPY)[0], 'default', 'eth');
  assert.match(
    JSON.stringify(eth),
    /users\/nlang\/ETH_GlobalCanopyHeight_2020_10m_v1/,
  );
  assert.match(JSON.stringify(eth), /"b1"/);
  assert.equal(named(eth, 'Image.selfMask').length, 1);
  assert.match(CANOPY.attribution, /Meta and World Resources Institute/);
  assert.match(CANOPY.attribution, /ETH/);
  assert.match(CANOPY.attribution, /CC BY 4\.0/);
});
