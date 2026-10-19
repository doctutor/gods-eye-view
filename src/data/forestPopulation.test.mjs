// Personal fork: the Forest types and Population Earth Engine layers
// (src/data/earthEngineLayers.js): their expressions, the population
// dataset helper, the epoch modes through the server and the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createEarthEngineHandler,
  createEarthEngineService,
  mapKey,
  mapRequestFor,
} from '../../server/providers/earthEngine.js';
import {
  EARTH_ENGINE_LAYERS,
  FOREST_TYPE_COLORS,
  POPULATION_EPOCH,
  POPULATION_EPOCHS,
  POPULATION_MODES,
  layerModes,
  layerVariants,
  populationDataset,
  variantForHeight,
} from './earthEngineLayers.js';
import { toCatalogLayer } from '../layers/earthEngine/source.js';
import {
  MODE_CHIPS,
  legendLabel,
  modeLabel,
  rowControls,
  statusText,
} from '../layers/earthEngine/presentation.js';
import { setLocale } from '../i18n/index.js';

const byId = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);
const FOREST = byId('ee-forest-types');
const POPULATION = byId('ee-population');
const call = (node) => node.functionInvocationValue;
const root = (request) => call(request.expression.values['0']);

test('forest types: the class codes remapped to a three-colour palette', () => {
  assert.deepEqual(layerModes(FOREST), ['default']);
  const request = mapRequestFor(FOREST, layerVariants(FOREST)[0]);
  const remap = root(request);
  assert.equal(remap.functionName, 'Image.remap');
  assert.deepEqual(remap.arguments.from.constantValue, [1, 10, 20]);
  assert.deepEqual(remap.arguments.to.constantValue, [1, 2, 3]);
  const select = call(remap.arguments.image);
  assert.equal(select.functionName, 'Image.select');
  assert.deepEqual(select.arguments.bandSelectors.constantValue, ['Map']);
  assert.equal(
    call(select.arguments.input).arguments.id.constantValue,
    'JRC/GFC2020_subtypes/V1',
  );
  assert.deepEqual(request.visualizationOptions, {
    ranges: [{ min: 1, max: 3 }],
    paletteColors: [
      FOREST_TYPE_COLORS.natural,
      FOREST_TYPE_COLORS.primary,
      FOREST_TYPE_COLORS.planted,
    ],
  });
  assert.deepEqual(
    FOREST.legend.map((entry) => entry.label),
    ['Naturally regenerating forest', 'Primary forest', 'Planted forest'],
  );
  assert.match(FOREST.attribution, /EC JRC.*forest types 2020 v1/);
});

test('both draw from orbit: one variant at every height, no ceiling', () => {
  for (const layer of [FOREST, POPULATION]) {
    assert.equal(layer.maxHeightM, undefined, layer.id);
    for (const height of [500, 3_000_000, 20_000_000])
      assert.equal(variantForHeight(layer, height).key, 'default');
  }
  assert.equal(FOREST.maxZoom, 14); // 10 m pixels
  assert.equal(POPULATION.maxZoom, 12); // 100 m cells
});

test('populationDataset names the GHSL image, band and density factor of an epoch', () => {
  assert.deepEqual(populationDataset(), {
    collection: 'JRC/GHSL/P2023A/GHS_POP',
    image: 'JRC/GHSL/P2023A/GHS_POP/2020',
    band: 'population_count',
    epoch: 2020,
    projected: false,
    cellM: 100,
    perKm2: 100,
  });
  assert.equal(POPULATION_EPOCH, 2020);
  assert.equal(populationDataset('1975').image, 'JRC/GHSL/P2023A/GHS_POP/1975');
  assert.equal(populationDataset(2030).projected, true);
  // 100 m cells of an equal-area grid: 0.01 km², so count × 100 per km².
  assert.equal(
    populationDataset().perKm2,
    1e6 / populationDataset().cellM ** 2,
  );
  for (const bad of [1970, 2021, 2035, 'x', null])
    assert.throws(() => populationDataset(bad), RangeError, String(bad));
});

test('population: log10 of people per km², under one left clear, one map per epoch', () => {
  assert.deepEqual(POPULATION_EPOCHS, [2020, 2000, 1990, 1975]);
  assert.deepEqual(layerModes(POPULATION), [
    'density-2020',
    'density-2000',
    'density-1990',
    'density-1975',
  ]);
  for (const mode of POPULATION_MODES) {
    const request = mapRequestFor(
      POPULATION,
      layerVariants(POPULATION)[0],
      'default',
      mode.key,
    );
    const log = root(request);
    assert.equal(log.functionName, 'Image.log10');
    const masked = call(log.arguments.value);
    assert.equal(masked.functionName, 'Image.updateMask');
    const density = call(masked.arguments.image);
    assert.equal(density.functionName, 'Image.multiply');
    assert.equal(
      call(density.arguments.image2).arguments.value.constantValue,
      100,
    );
    const gte = call(masked.arguments.mask);
    assert.equal(gte.functionName, 'Image.gte');
    assert.equal(call(gte.arguments.image2).arguments.value.constantValue, 1);
    const select = call(density.arguments.image1);
    assert.deepEqual(select.arguments.bandSelectors.constantValue, [
      'population_count',
    ]);
    assert.equal(
      call(select.arguments.input).arguments.id.constantValue,
      `JRC/GHSL/P2023A/GHS_POP/${mode.epoch}`,
    );
    assert.deepEqual(request.visualizationOptions.ranges, [{ min: 0, max: 4 }]);
    assert.equal(request.visualizationOptions.paletteColors.length, 5);
  }
  assert.match(
    POPULATION.attribution,
    /GHSL.*European Commission, Joint Research Centre/,
  );
});

test('an epoch mode goes through the tile route and the server makes its own map', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-ee-pop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const made = [];
  const backend = {
    async createMap(layer, variant, ink, mode) {
      made.push(mapKey(layer, variant, ink, mode));
      return { name: `projects/p/maps/${layer.id}-${mode}` };
    },
    async fetchTile(name, z, x, y) {
      return {
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(`${name}:${z}/${x}/${y}`),
      };
    },
  };
  const service = createEarthEngineService({
    sourceRoot: dir,
    env: {},
    layers: [POPULATION],
    backend,
  });
  const handler = createEarthEngineHandler({ service });
  const get = async (url) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body) {
        this.body = Buffer.isBuffer(body) ? body.toString() : JSON.parse(body);
      },
    };
    await handler(
      { url, method: 'GET', headers: { host: 'localhost:4176' }, socket: {} },
      res,
      () => (res.nexted = true),
    );
    return res;
  };
  const tile = await get(
    '/tile/ee-population/density-1990/default/default/3/2/1',
  );
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.body, 'projects/p/maps/ee-population-density-1990:3/2/1');
  assert.deepEqual(made, ['ee-population/density-1990/default/default']);
  assert.equal(
    (await get('/tile/ee-population/density-1985/default/default/3/2/1'))
      .statusCode,
    404,
  );
  // The catalog names the epochs, and the client keeps them.
  const listed = (await service.layers()).layers[0];
  assert.deepEqual(listed.modes, layerModes(POPULATION));
  const kept = toCatalogLayer(listed);
  assert.deepEqual(kept.modes, layerModes(POPULATION));
  assert.deepEqual(
    Object.keys(kept.variants[0].modeVersions),
    layerModes(POPULATION),
  );
});

test('the Population row: a chip per epoch, the log legend and the epoch in the status line', () => {
  const chips = MODE_CHIPS.filter((chip) => chip.key.startsWith('density-'));
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['2020', '2000', '1990', '1975'],
  );
  let picked = '';
  const controls = rowControls({
    record: POPULATION,
    opacity: 0.7,
    onOpacity() {},
    mode: 'density-1990',
    onMode: (key) => (picked = key),
  });
  const modeChips = controls.chips.filter((chip) =>
    chip.id.startsWith('mode-'),
  );
  assert.deepEqual(
    modeChips.map((chip) => [chip.label, chip.active]),
    [
      ['2020', false],
      ['2000', false],
      ['1990', true],
      ['1975', false],
    ],
  );
  assert.equal(modeChips[0].title, 'People per km² in 2020 (GHSL)');
  modeChips[3].onClick();
  assert.equal(picked, 'density-1975');
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['1', '10', '100', '1,000', '10,000+ per km²'],
  );
  assert.equal(modeLabel('density-1990'), 'People per km² in 1990 (GHSL)');
  assert.equal(modeLabel('network'), '');
  assert.equal(
    statusText({
      catalog: { configured: true },
      layer: { tilesToday: 3 },
      mode: 'density-2000',
    }),
    'People per km² in 2000 (GHSL) · 3 tiles today, this layer',
  );
  // The Rivers and Forest types get no epoch chips.
  const forest = rowControls({ record: FOREST, opacity: 0.7, onOpacity() {} });
  assert.ok(forest.chips.every((chip) => !chip.id.startsWith('mode-')));
});

test('the new legend words and the epoch title are translated', () => {
  setLocale('es');
  try {
    assert.equal(legendLabel('Primary forest'), 'Bosque primario');
    assert.equal(legendLabel('10,000+ per km²'), '10 000+ por km²');
    assert.equal(legendLabel('100'), '100');
    assert.equal(
      modeLabel('density-1975'),
      'Habitantes por km² en 1975 (GHSL)',
    );
  } finally {
    setLocale('en');
  }
  setLocale('ru');
  try {
    assert.equal(legendLabel('Planted forest'), 'Лесные культуры');
    assert.equal(legendLabel('1,000'), '1 000');
  } finally {
    setLocale('en');
  }
});
