// Personal fork: the Census tracts layer in the scene: TRACTS from Earth
// Engine, HOUSEHOLD INCOME from the local census server (src/layers/census/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';

import { EARTH_ENGINE_LAYERS } from '../../data/earthEngineLayers.js';
import { createEarthEngineService } from '../../../server/providers/earthEngine.js';
import { NEEDS_KEY } from '../../../server/providers/census/sources.js';
import { createEarthEngineLayer } from './index.js';
import { createEarthEngineSource } from './source.js';
import {
  censusImageryOptions,
  createCensusSource,
  toCensusStatus,
} from '../census/source.js';

const TRACTS = EARTH_ENGINE_LAYERS.find((l) => l.id === 'ee-census-tracts');
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

async function mounted(t, { census, mode = 'income', heightM = 100_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-census-layer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createEarthEngineService({
    sourceRoot: dir,
    env: {},
    layers: [TRACTS],
    backend: {
      async createMap() {
        return { name: 'projects/p/maps/tracts' };
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
    imageryLayers: collection,
    scene: {
      globe: { show: true },
      canvas: { clientWidth: 1600, clientHeight: 900 },
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(-74.0, 40.75, heightM);
      },
      moveEnd: { addEventListener: () => () => {} },
    },
  };
  const layer = createEarthEngineLayer({
    record: TRACTS,
    source: createEarthEngineSource({
      fetchImpl: async () => Response.json(body),
    }),
    storage: memoryStorage({ 'gev.censusTracts.mode': mode }),
    localSource: createCensusSource({
      fetchImpl: async () => Response.json(census),
    }),
  });
  layer.init(viewer);
  layer.attachMapStackController({
    getImageryHostTileset: () => null,
    getActiveLuminance: () => 'dark',
    subscribe: () => () => {},
  });
  layer.enable(viewer);
  await flush();
  return { layer, layers: list };
}

const BUILT = {
  configured: true,
  attribution: 'U.S. Census Bureau',
  minZoom: 7,
  maxZoom: 14,
  modes: { income: { ready: true, version: '0123456789ab', message: '' } },
};

test('HOUSEHOLD INCOME draws the local server’s tiles; TRACTS draws Earth Engine’s', async (t) => {
  const { layer, layers } = await mounted(t, { census: BUILT });
  assert.equal(layers.length, 1);
  const provider = layers[0].imageryProvider;
  assert.match(
    provider.url,
    /^\/api\/census\/tile\/income\/\{z\}\/\{x\}\/\{y\}\?v=0123456789ab$/,
  );
  assert.equal(provider.minimumLevel, 7);
  assert.equal(provider.maximumLevel, 14);
  const row = layer.getRowControls();
  assert.deepEqual(
    row.chips
      .filter((c) => c.id.startsWith('mode-'))
      .map((c) => [c.id, c.active]),
    [
      ['mode-tracts', false],
      ['mode-income', true],
      ['mode-lst', false],
    ],
  );
  assert.equal(row.legend.length, 7);
  assert.equal(row.legend[0].color, '#ffffcc');
  // TRACTS: back to Earth Engine.
  row.chips.find((c) => c.id === 'mode-tracts').onClick();
  await flush();
  assert.equal(layers.length, 1);
  assert.match(
    layers[0].imageryProvider.url,
    /\/api\/earth-engine\/tile\/ee-census-tracts\/tracts\/tracts\/light\//,
  );
  layer.disable();
});

test('without the incomes the row says to set CENSUS_API_KEY, and nothing is drawn', async (t) => {
  const { layer, layers } = await mounted(t, {
    census: {
      configured: true,
      modes: { income: { ready: false, message: NEEDS_KEY } },
    },
  });
  assert.equal(layers.length, 0);
  assert.match(layer.getRowControls().info, /^Set CENSUS_API_KEY in \.env/);
  layer.disable();
  // Above the ceiling the row says to come lower instead.
  const high = await mounted(t, { census: BUILT, heightM: 2_000_000 });
  assert.equal(high.layers.length, 0);
  assert.match(high.layer.getRowControls().info, /Zoom in below 417 km/);
  high.layer.disable();
});

test('the census status is checked on the way in', () => {
  const status = toCensusStatus({
    ...BUILT,
    modes: {
      income: { ready: true, version: 'not-a-hash' },
      other: { ready: true },
    },
  });
  assert.equal(status.modes.income.ready, false, 'no version, not ready');
  assert.equal(status.modes.other, undefined);
  assert.equal(censusImageryOptions(status, 'income'), null);
  assert.ok(censusImageryOptions(toCensusStatus(BUILT), 'income'));
});
