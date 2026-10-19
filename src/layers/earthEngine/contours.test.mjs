// Personal fork: the Elevation contours overlay in the scene and its row
// (src/data/earthEngineLayers.js ELEVATION_CONTOURS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';

import {
  CONTOUR_BANDS,
  EARTH_ENGINE_LAYERS,
} from '../../data/earthEngineLayers.js';
import { createEarthEngineService } from '../../../server/providers/earthEngine.js';
import { createEarthEngineLayer } from './index.js';
import { createEarthEngineSource } from './source.js';
import { legendLabel, variantLabel } from './presentation.js';

const CONTOURS = EARTH_ENGINE_LAYERS.find(
  (layer) => layer.id === 'ee-elevation-contours',
);

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

async function contoursCatalog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-contours-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const made = [];
  const service = createEarthEngineService({
    sourceRoot: dir,
    env: {},
    layers: [CONTOURS],
    backend: {
      async createMap(layer, variant, ink) {
        made.push(`${variant.key}/${ink}`);
        return { name: `projects/p/maps/${made.length}` };
      },
      async fetchTile() {
        return {
          status: 200,
          contentType: 'image/png',
          body: Buffer.from('png'),
        };
      },
    },
  });
  return { body: await service.layers(), made };
}

async function mounted(t, { host = 'globe', heightM, luminance = 'dark' }) {
  const { body, made } = await contoursCatalog(t);
  const list = [];
  const collection = {
    add: (layer) => (list.push(layer), layer),
    remove: (layer) => {
      const i = list.indexOf(layer);
      if (i >= 0) list.splice(i, 1);
      return i >= 0;
    },
    get length() {
      return list.length;
    },
  };
  const viewer = {
    imageryLayers: host === 'globe' ? collection : { add() {}, remove() {} },
    scene: {
      globe: { show: host === 'globe' },
      canvas: { clientWidth: 1600, clientHeight: 900 },
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(7.75, 46.0, heightM);
      },
      moveEnd: { addEventListener: () => () => {} },
    },
  };
  const layer = createEarthEngineLayer({
    record: CONTOURS,
    source: createEarthEngineSource({
      fetchImpl: async () => Response.json(body),
    }),
    storage: memoryStorage(),
  });
  layer.init(viewer);
  layer.attachMapStackController({
    getImageryHostTileset: () =>
      host === 'tileset' ? { imageryLayers: collection } : null,
    getActiveLuminance: () => luminance,
    subscribe: () => () => {},
  });
  layer.enable(viewer);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return { layer, layers: list, made };
}

test('the row names the contour step the camera’s height draws', () => {
  assert.equal(variantLabel('c500'), 'Contours every 500 m');
  assert.equal(variantLabel('c20'), 'Contours every 20 m');
  assert.equal(variantLabel('o3'), 'Rivers of flow orders 1 to 3');
  assert.equal(legendLabel('Contour'), 'Contour');
  assert.equal(legendLabel('Index contour'), 'Index contour');
});

test('contours drape through the zoom variant from level 0, in the basemap’s ink, on the globe and the photoreal tiles', async (t) => {
  for (const host of ['globe', 'tileset']) {
    const { layer, layers, made } = await mounted(t, {
      host,
      heightM: 100_000,
    });
    assert.deepEqual(made, [], 'lazy: the catalog makes no contour map');
    assert.equal(layers.length, 1, host);
    const provider = layers[0].imageryProvider;
    // A dark basemap: light lines; every tile drawn with its own zoom's step.
    assert.match(provider.url, /\/ee-elevation-contours\/zoom\/light\//, host);
    assert.equal(provider.minimumLevel, 0, host);
    assert.equal(provider.maximumLevel, 14, host);
    const row = layer.getRowControls();
    assert.match(row.info, /Contours every 100 m/, host);
    // Ink chips, no level chips (the bands are chosen by zoom only).
    assert.deepEqual(
      row.chips.map((chip) => chip.id),
      ['ink-auto', 'ink-light', 'ink-dark'],
    );
    assert.deepEqual(
      row.legend.map((entry) => [entry.label, entry.color]),
      [
        ['Contour', '#ffffff'],
        ['Index contour', '#ffffff'],
      ],
    );
    layer.disable();
  }
  // A light basemap: dark lines.
  const { layer, layers } = await mounted(t, {
    heightM: 10_000_000,
    luminance: 'light',
  });
  assert.match(layers[0].imageryProvider.url, /\/zoom\/dark\//);
  assert.match(layer.getRowControls().info, /Contours every 500 m/);
  layer.disable();
});

test('the bands step at the heights the zooms are draped at', () => {
  // From orbit to the street: 500, 200, 100, 40, 20 m.
  assert.deepEqual(
    CONTOUR_BANDS.map((band) => [band.key, band.zooms]),
    [
      ['c500', [0, 7]],
      ['c200', [8, 9]],
      ['c100', [10, 11]],
      ['c40', [12, 12]],
      ['c20', [13, 14]],
    ],
  );
  // Neighbouring bands meet: each one's ceiling is the next one's floor.
  for (let i = 1; i < CONTOUR_BANDS.length; i++)
    assert.equal(CONTOUR_BANDS[i].maxHeightM, CONTOUR_BANDS[i - 1].minHeightM);
});
