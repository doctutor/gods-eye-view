// Personal fork: the keyless raster basemaps — their records, the providers
// built from them, the OSM fallbacks, and the blank globe the controller
// paints without an imagery layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_STACKS } from './catalog.js';
import {
  KEYLESS_BASEMAPS,
  KEYLESS_BASEMAP_IDS,
  KEYLESS_BASEMAP_GROUPS,
  keylessBasemapRecord,
} from './keylessBasemapCatalog.js';
import {
  createKeylessBasemapImagery,
  gibsStaticTemplate,
  keylessBasemapSource,
  keylessBasemapUsesNetwork,
  stadiaMapsKey,
  stadiaTemplate,
} from './keylessBasemaps.js';
import { createDefaultMapSources } from './defaultSources.js';
import { MapSourceController } from './controller.js';
import { resolveImageryHost } from './imageryHost.js';
import { CABLE_GLOBE_STACK_IDS } from '../layers/submarineCables/policy.js';
import { VIEW_MAPS } from '../view/index.js';
import { stripKeylessBasemapFromHash } from '../keySetup.js';
import { KEY_SETUP_KEYS } from '../keySetupCore.mjs';

const UPSTREAM_IDS = [
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
];
const EXPECTED_IDS = [
  'blank-black',
  'blank-white',
  'natural-earth-ii',
  'carto-positron',
  'carto-positron-nolabels',
  'carto-dark-matter',
  'carto-dark-matter-nolabels',
  'opentopomap',
  'nasa-black-marble',
  'nasa-blue-marble',
  'stamen-toner',
  'stamen-toner-lite',
  'stamen-terrain',
  'stamen-watercolor',
];

/** A Cesium stand-in that records what each provider was asked to do. */
function fakeCesium() {
  const calls = { urlTemplate: [], tms: [] };
  class UrlTemplateImageryProvider {
    constructor(options) {
      this.options = options;
      calls.urlTemplate.push(options);
    }
  }
  class WebMercatorTilingScheme {}
  class Color {
    constructor(r, g, b, a) {
      Object.assign(this, { red: r, green: g, blue: b, alpha: a });
    }
  }
  const cesium = {
    UrlTemplateImageryProvider,
    WebMercatorTilingScheme,
    Color,
    buildModuleUrl: (path) => `/cesium/${path}`,
    TileMapServiceImageryProvider: {
      fromUrl: async (url, options) => {
        calls.tms.push({ url, options });
        return { tms: url, options };
      },
    },
  };
  return { cesium, calls };
}

test('the records follow the five upstream sources in MAP_STACKS, unchanged', () => {
  assert.deepEqual(
    MAP_STACKS.slice(0, 5).map((stack) => stack.id),
    UPSTREAM_IDS,
  );
  assert.deepEqual(KEYLESS_BASEMAP_IDS, EXPECTED_IDS);
  assert.deepEqual(
    MAP_STACKS.slice(5).map((stack) => stack.id),
    EXPECTED_IDS,
  );
  const groupIds = new Set(KEYLESS_BASEMAP_GROUPS.map((group) => group.id));
  for (const record of KEYLESS_BASEMAPS) {
    const descriptor = MAP_STACKS.find((stack) => stack.id === record.id);
    assert.equal(descriptor.kind, 'keyless-basemap');
    assert.equal(descriptor.requiresIon, false);
    assert.equal(descriptor.label, record.label);
    assert.equal(descriptor.shortLabel, record.shortLabel);
    assert.equal(descriptor.group, record.group);
    assert.ok(groupIds.has(record.group), `${record.id} group ${record.group}`);
    assert.ok(record.label && record.shortLabel, `${record.id} has labels`);
    assert.ok(
      record.shortLabel.length <= 8,
      `${record.id} status text fits the chip`,
    );
    assert.equal(keylessBasemapRecord(record.id), record);
  }
  assert.equal(keylessBasemapRecord('osm'), null);
  assert.equal(new Set(KEYLESS_BASEMAP_IDS).size, EXPECTED_IDS.length);
});

test('every surface that names basemaps knows the keyless ids', () => {
  for (const id of KEYLESS_BASEMAP_IDS) {
    assert.ok(CABLE_GLOBE_STACK_IDS.has(id), `cables classify ${id} as globe`);
    assert.ok(VIEW_MAPS.includes(id), `share links accept map=${id}`);
    assert.equal(
      stripKeylessBasemapFromHash(`lat=1&map=${id}&style=flir`),
      'lat=1&style=flir',
      `a first Google key boots photoreal over map=${id}`,
    );
  }
  assert.deepEqual(
    [...VIEW_MAPS].sort(),
    MAP_STACKS.map((stack) => stack.id).sort(),
    'VIEW_MAPS and MAP_STACKS name the same basemaps',
  );
  assert.equal(stripKeylessBasemapFromHash('map=photoreal&lat=1'), null);
  const stadia = KEY_SETUP_KEYS.find((key) => key.id === 'stadia-maps');
  assert.deepEqual(stadia.envVars, ['STADIA_MAPS_API_KEY']);
  assert.equal(stadia.hidden, true, 'optional: outside the missing-key count');
  assert.equal(stadia.clientExposed, true);
});

test('each tile type builds its provider, with the right limits and credits', async () => {
  const { cesium, calls } = fakeCesium();
  const built = new Map();
  for (const record of KEYLESS_BASEMAPS) {
    built.set(
      record.id,
      await createKeylessBasemapImagery(record, { cesium, stadiaKey: '' }),
    );
  }
  // Blank: no provider at all.
  assert.equal(built.get('blank-black'), null);
  assert.equal(built.get('blank-white'), null);
  // Bundled Natural Earth II: Cesium's own asset, three levels.
  assert.deepEqual(calls.tms, [
    {
      url: '/cesium/Assets/Textures/NaturalEarthII',
      options: {
        maximumLevel: 2,
        credit: keylessBasemapRecord('natural-earth-ii').credit,
      },
    },
  ]);
  assert.match(calls.tms[0].options.credit, /Natural Earth/);
  // CARTO: four subdomains, OSM + CARTO attribution.
  const positron = built.get('carto-positron').options;
  assert.equal(
    positron.url,
    'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
  );
  assert.deepEqual(positron.subdomains, ['a', 'b', 'c', 'd']);
  assert.equal(positron.maximumLevel, 20);
  assert.equal(positron.hasAlphaChannel, false);
  assert.ok(positron.tilingScheme instanceof cesium.WebMercatorTilingScheme);
  assert.match(positron.credit, /OpenStreetMap contributors/);
  assert.match(positron.credit, /CARTO/);
  for (const [id, style] of [
    ['carto-positron-nolabels', 'light_nolabels'],
    ['carto-dark-matter', 'dark_all'],
    ['carto-dark-matter-nolabels', 'dark_nolabels'],
  ]) {
    assert.equal(
      built.get(id).options.url,
      `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png`,
    );
    assert.equal(built.get(id).options.credit, positron.credit);
  }
  // OpenTopoMap: 17 levels, their own attribution line.
  const topo = built.get('opentopomap').options;
  assert.equal(topo.url, 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png');
  assert.deepEqual(topo.subdomains, ['a', 'b', 'c']);
  assert.equal(topo.maximumLevel, 17);
  assert.match(topo.credit, /OpenTopoMap/);
  assert.match(topo.credit, /OpenStreetMap contributors/);
  assert.match(topo.credit, /CC-BY-SA/);
  // GIBS: the Recent Imagery host, y before x, Level8, no time dimension.
  const night = built.get('nasa-black-marble').options;
  assert.equal(
    night.url,
    'https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  );
  assert.deepEqual(night.subdomains, ['a', 'b', 'c']);
  assert.equal(night.maximumLevel, 8);
  assert.equal(night.hasAlphaChannel, true);
  assert.match(night.credit, /NASA GIBS/);
  const blue = built.get('nasa-blue-marble').options;
  assert.equal(
    blue.url,
    gibsStaticTemplate('BlueMarble_NextGeneration', 'jpeg', 8),
  );
  assert.equal(blue.hasAlphaChannel, false);
  // Stadia: keyless template, Stadia + Stamen + OSM attribution.
  const toner = built.get('stamen-toner').options;
  assert.equal(
    toner.url,
    'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png',
  );
  assert.equal(toner.subdomains, undefined);
  assert.equal(toner.maximumLevel, 20);
  assert.match(toner.credit, /Stadia Maps/);
  assert.match(toner.credit, /Stamen Design/);
  assert.match(toner.credit, /OpenStreetMap contributors/);
  assert.equal(
    built.get('stamen-toner-lite').options.url,
    'https://tiles.stadiamaps.com/tiles/stamen_toner_lite/{z}/{x}/{y}.png',
  );
  assert.equal(built.get('stamen-terrain').options.maximumLevel, 18);
  const water = built.get('stamen-watercolor').options;
  assert.equal(
    water.url,
    'https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg',
  );
  assert.equal(water.maximumLevel, 16, 'a z=17 watercolor tile is empty');
  for (const options of calls.urlTemplate) {
    assert.equal(options.minimumLevel, 0);
    assert.ok(options.maximumLevel >= 8 && options.maximumLevel <= 20);
    assert.doesNotMatch(options.url, /api_key/, 'no key when none is set');
  }
  await assert.rejects(
    createKeylessBasemapImagery(
      { id: 'odd', tiles: { type: 'wms' }, credit: null },
      { cesium },
    ),
    /Unknown keyless basemap tiles/,
  );
});

test('a Stadia key is appended only when set, and only read from its own variable', async () => {
  assert.equal(stadiaMapsKey(undefined), '');
  assert.equal(stadiaMapsKey({}), '');
  assert.equal(stadiaMapsKey({ MAPILLARY_CLIENT_TOKEN: 'other' }), '');
  assert.equal(stadiaMapsKey({ STADIA_MAPS_API_KEY: '  key-1 ' }), 'key-1');
  assert.equal(
    stadiaTemplate('stamen_toner', 'png', 'a b'),
    'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png?api_key=a%20b',
  );
  const { cesium } = fakeCesium();
  const keyed = await createKeylessBasemapImagery(
    keylessBasemapRecord('stamen-watercolor'),
    { cesium, stadiaKey: 'key-1' },
  );
  assert.equal(
    keyed.options.url,
    'https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg?api_key=key-1',
  );
  // Only Stadia styles carry the key.
  const carto = await createKeylessBasemapImagery(
    keylessBasemapRecord('carto-positron'),
    { cesium, stadiaKey: 'key-1' },
  );
  assert.doesNotMatch(carto.options.url, /key-1/);
});

test('network styles fall back to OSM like Esri; blank and bundled styles do not watch tiles', () => {
  const registry = createDefaultMapSources();
  const esri = registry.sources.find((s) => s.descriptor.id === 'esri-imagery');
  for (const record of KEYLESS_BASEMAPS) {
    const source = registry.sources.find((s) => s.descriptor.id === record.id);
    assert.ok(source, `${record.id} is in the registry`);
    assert.equal(source.available, true);
    assert.equal(source.terrain, esri.terrain, 'the 2D stacks share terrain');
    assert.equal(source.credit, record.credit);
    assert.equal(typeof source.imagery, 'function');
    if (keylessBasemapUsesNetwork(record)) {
      assert.equal(source.constructionFallback.id, 'osm');
      assert.equal(
        source.constructionFallback.message,
        `${record.label} is unavailable; using OSM`,
      );
      assert.deepEqual(source.tileFailureFallback, {
        id: 'osm',
        threshold: 2,
        message: `${record.label} tile requests failed; using OSM`,
      });
      assert.equal(source.globeBaseColor, undefined);
    } else if (record.tiles.type === 'bundled') {
      assert.equal(source.constructionFallback.id, 'osm');
      assert.equal(source.tileFailureFallback, undefined);
    } else {
      assert.equal(source.constructionFallback, undefined);
      assert.equal(source.tileFailureFallback, undefined);
      assert.ok(source.globeBaseColor instanceof Cesium.Color);
    }
  }
  const black = registry.sources.find((s) => s.descriptor.id === 'blank-black');
  const white = registry.sources.find((s) => s.descriptor.id === 'blank-white');
  assert.ok(Cesium.Color.equals(black.globeBaseColor, Cesium.Color.BLACK));
  assert.ok(Cesium.Color.equals(white.globeBaseColor, Cesium.Color.WHITE));
  assert.throws(
    () =>
      keylessBasemapSource(
        { id: 'osm', kind: 'keyless-basemap' },
        { terrain: esri.terrain },
      ),
    /Unknown keyless basemap/,
  );
  // The registry's fallback graph is acyclic (the controller indexes it).
  assert.doesNotThrow(() =>
    new MapSourceController(fakeViewer().viewer, { registry }).destroy(),
  );
});

function fakeViewer() {
  const imagery = [];
  const credits = new Set();
  const viewer = {
    scene: {
      globe: { show: true, baseColor: 'cesium-default-blue' },
      requestRender() {},
      frameState: {
        creditDisplay: {
          addStaticCredit: (value) => credits.add(value),
          removeStaticCredit: (value) => credits.delete(value),
        },
      },
      primitives: { add() {}, remove() {} },
    },
    imageryLayers: {
      add: (layer) => imagery.push(layer),
      remove: (layer) => imagery.splice(imagery.indexOf(layer), 1),
    },
  };
  return { viewer, imagery, credits };
}

/** The keyless registry with fake providers, so no network is touched. */
function controllerFixture({ failing = new Set() } = {}) {
  const registry = createDefaultMapSources();
  const providers = new Map();
  const events = new Map();
  for (const source of registry.sources) {
    if (!source.imagery) continue;
    const id = source.descriptor.id;
    const listeners = new Set();
    const errorEvent = {
      addEventListener(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      raise: (value) => [...listeners].forEach((fn) => fn(value)),
    };
    events.set(id, errorEvent);
    const record = keylessBasemapRecord(id);
    const provider = record?.tiles.type === 'blank' ? null : { id, errorEvent };
    providers.set(id, provider);
    source.imagery = async () => {
      if (failing.has(id)) throw new Error(`${id} refused`);
      return provider;
    };
    source.terrain = {
      id: 'keyless',
      create: async () => ({ provider: { id: 'terrain' } }),
    };
  }
  const env = fakeViewer();
  const errors = [];
  const controller = new MapSourceController(env.viewer, {
    registry,
    createImageryLayer: (provider) => ({ provider }),
    onError: (message) => errors.push(message),
  });
  return { ...env, registry, providers, events, controller, errors };
}

test('a blank style paints the globe with no imagery layer, and the next style restores it', async () => {
  const env = controllerFixture();
  const { controller, viewer, imagery, credits } = env;
  await controller.setStack('blank-black');
  assert.equal(controller.getActiveId(), 'blank-black');
  assert.equal(imagery.length, 0, 'no imagery layer for a blank globe');
  assert.equal(viewer.scene.globe.show, true);
  assert.ok(
    Cesium.Color.equals(viewer.scene.globe.baseColor, Cesium.Color.BLACK),
  );
  assert.equal(credits.size, 0, 'nothing to credit');
  assert.equal(viewer.terrainProvider.id, 'terrain', 'terrain still applies');
  // Overlays (Earth Engine, the grid) still find the globe to drape on.
  assert.equal(resolveImageryHost({ viewer, tileset: null }).kind, 'globe');
  assert.equal(controller.getImageryHostTileset(), null);

  await controller.setStack('blank-white');
  assert.ok(
    Cesium.Color.equals(viewer.scene.globe.baseColor, Cesium.Color.WHITE),
  );
  assert.equal(imagery.length, 0);

  await controller.setStack('osm');
  assert.equal(controller.getActiveId(), 'osm');
  assert.equal(imagery.length, 1);
  assert.equal(imagery[0].provider.id, 'osm');
  assert.equal(
    viewer.scene.globe.baseColor,
    'cesium-default-blue',
    'the original colour comes back under imagery',
  );

  await controller.setStack('blank-black');
  assert.equal(imagery.length, 0, 'the OSM layer is removed again');
  assert.ok(
    Cesium.Color.equals(viewer.scene.globe.baseColor, Cesium.Color.BLACK),
  );
  controller.destroy();
});

test('a keyless style credits its source, and falls back to OSM when it cannot be built or its tiles fail', async () => {
  const env = controllerFixture({ failing: new Set(['opentopomap']) });
  const { controller, imagery, credits, events, errors } = env;
  await controller.setStack('carto-dark-matter');
  assert.equal(controller.getActiveId(), 'carto-dark-matter');
  assert.equal(imagery[0].provider.id, 'carto-dark-matter');
  assert.equal(credits.size, 1);
  assert.match([...credits][0].html, /CARTO/);

  // Two tile failures: OSM takes over, the row hears why.
  events.get('carto-dark-matter').raise({ timesRetried: 0 });
  assert.equal(controller.getActiveId(), 'carto-dark-matter');
  events.get('carto-dark-matter').raise({ timesRetried: 1 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(controller.getActiveId(), 'osm');
  assert.ok(
    errors.includes('CARTO Dark Matter tile requests failed; using OSM'),
  );
  assert.equal(imagery[0].provider.id, 'osm');

  // Construction failure: the registry's OSM stand-in, attributed as OSM.
  await controller.setStack('opentopomap');
  assert.equal(controller.getActiveId(), 'osm');
  assert.equal(
    controller.getState().lastError,
    'OpenTopoMap is unavailable; using OSM',
  );
  assert.equal(credits.size, 0, 'OSM carries its own provider credit');
  controller.destroy();
});
