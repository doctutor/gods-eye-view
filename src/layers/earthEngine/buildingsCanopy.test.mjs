// Personal fork: the Buildings and Tree canopy overlays in the scene and
// their rows (src/data/earthEngineLayers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';

import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineService } from '../../../server/providers/earthEngine.js';
import { createEarthEngineLayer } from './index.js';
import { createEarthEngineSource } from './source.js';
import { statusText, variantLabel } from './presentation.js';

const record = (id) => EARTH_ENGINE_LAYERS.find((layer) => layer.id === id);

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

async function mounted(t, id, { lat, lon, heightM, luminance = 'dark' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createEarthEngineService({
    sourceRoot: dir,
    env: {},
    layers: [record(id)],
    backend: {
      async createMap() {
        return { name: 'projects/p/maps/1' };
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
  const body = await service.layers();
  const list = [];
  const viewer = {
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
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(lon, lat, heightM);
      },
      moveEnd: { addEventListener: () => () => {} },
    },
  };
  const layer = createEarthEngineLayer({
    record: record(id),
    source: createEarthEngineSource({
      fetchImpl: async () => Response.json(body),
    }),
    storage: memoryStorage(),
  });
  layer.init(viewer);
  layer.attachMapStackController({
    getImageryHostTileset: () => null,
    getActiveLuminance: () => luminance,
    subscribe: () => () => {},
  });
  layer.enable(viewer);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return { layer, layers: list };
}

test('outside Open Buildings the row says there is no data here, inside it does not', async (t) => {
  const baltimore = await mounted(t, 'ee-buildings', {
    lat: 39.29,
    lon: -76.61,
    heightM: 50_000,
  });
  assert.match(
    baltimore.layer.getRowControls().info,
    /^No Open Buildings data here · /,
  );
  baltimore.layer.disable();
  const lagos = await mounted(t, 'ee-buildings', {
    lat: 6.455,
    lon: 3.39,
    heightM: 50_000,
  });
  const row = lagos.layer.getRowControls();
  assert.doesNotMatch(row.info, /No Open Buildings data/);
  // Drawn through the zoom variant, light ink on a dark map, COUNT first.
  assert.match(
    lagos.layers[0].imageryProvider.url,
    /\/ee-buildings\/count\/zoom\/light\//,
  );
  assert.equal(lagos.layers[0].imageryProvider.maximumLevel, 17);
  assert.deepEqual(
    row.chips.map((chip) => chip.id),
    [
      'mode-count',
      'mode-cover',
      'mode-height',
      'ink-auto',
      'ink-light',
      'ink-dark',
    ],
  );
  assert.deepEqual(
    row.legend.map((entry) => entry.label),
    ['1', '10', '100', '1,000', '10,000+ per km²'],
  );
  lagos.layer.disable();
  // Close in, the row names the footprints.
  const close = await mounted(t, 'ee-buildings', {
    lat: 6.455,
    lon: 3.39,
    heightM: 3_000,
  });
  assert.match(
    close.layer.getRowControls().info,
    /With building footprints \(Open Buildings v3\)/,
  );
  close.layer.disable();
});

test('the status words: coverage first, then the band', () => {
  assert.equal(
    statusText({
      catalog: { configured: true },
      variant: 'footprints',
      outsideCoverage: 'open-buildings',
    }),
    'No Open Buildings data here · With building footprints (Open Buildings v3)',
  );
  assert.equal(variantLabel('raster'), '');
});

test('Tree canopy: META 1 M and ETH 10 M chips, heights in metres', async (t) => {
  const { layer, layers } = await mounted(t, 'ee-tree-canopy', {
    lat: 46.85,
    lon: -121.75,
    heightM: 2_000_000,
  });
  const row = layer.getRowControls();
  assert.deepEqual(
    row.chips.map((chip) => chip.id),
    ['mode-meta', 'mode-eth'],
  );
  assert.deepEqual(
    row.legend.map((entry) => entry.label),
    ['2', '10', '20', '30', '40+ m'],
  );
  assert.match(layers[0].imageryProvider.url, /\/ee-tree-canopy\/meta\//);
  assert.doesNotMatch(row.info, /No .* data here/);
  layer.disable();
});
