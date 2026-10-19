// Personal fork: the Rivers layer (src/data/earthEngineLayers.js `ee-rivers`):
// its RIV_ORD bands by height, the mode expressions, the Americas switch,
// the names and the row's chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Cesium from 'cesium';

import {
  AMERICAS_CON_IDS,
  EARTH_ENGINE_LAYERS,
  RIVER_BANDS,
  layerInks,
  layerModes,
  modeRecord,
  variantForHeight,
} from '../../data/earthEngineLayers.js';
import {
  createEarthEngineService,
  featureFilter,
  mapRequestFor,
  mapRequestHash,
} from '../../../server/providers/earthEngine.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { createEarthEngineLayer, readMode } from './index.js';
import { MODE_CHIPS, rowControls } from './presentation.js';
import {
  MAX_NAME_LABELS,
  NAMES_MIN_HEIGHT_M,
  NAME_BANDS,
  RIVER_NAMES_SOURCE,
  createRiverNames,
  loadRiverNames,
  maxRankForHeight,
  pickRiverNames,
  riverNameText,
} from './riverNames.js';
import { createEarthEngineSource, tileTemplate } from './source.js';

const RIVERS = EARTH_ENGINE_LAYERS.find((layer) => layer.id === 'ee-rivers');
const band = (key) => RIVERS.variants.find((variant) => variant.key === key);
const root = (request) => request.expression.values['0'];
const styleFn = (request) => request.expression.values['1'];
const json = (value) => JSON.stringify(value);

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('detail follows the camera: RIV_ORD bands by height, each from a level Earth Engine draws in time', () => {
  const at = (height) => variantForHeight(RIVERS, height).key;
  assert.equal(at(20_000_000), 'o3', 'orbit: orders 1 to 3');
  assert.equal(at(6_000_000), 'o3');
  assert.equal(at(5_999_999), 'o4');
  assert.equal(at(1_600_000), 'o4');
  assert.equal(at(1_599_999), 'o5');
  assert.equal(at(700_000), 'o5');
  assert.equal(at(699_999), 'o6');
  assert.equal(at(250_000), 'o6');
  assert.equal(at(249_999), 'o7');
  assert.equal(at(80_000), 'o7');
  assert.equal(at(79_999), 'all');
  assert.equal(at(500), 'all');
  // More orders as the view comes in.
  const orders = RIVER_BANDS.map((v) => v.maxOrder ?? 10);
  assert.deepEqual(orders, [3, 4, 5, 6, 7, 10]);
  // Every band is on AUTO, and the bands tile the heights without a gap.
  for (let i = 0; i < RIVER_BANDS.length; i++) {
    assert.equal(RIVER_BANDS[i].auto, true);
    if (i)
      assert.equal(RIVER_BANDS[i].maxHeightM, RIVER_BANDS[i - 1].minHeightM);
  }
  // A band drawn where the view square is the whole world (above 1,667 km)
  // starts no deeper than z 3: the client asks for every tile of its first
  // level there (64 at z 3).
  for (const variant of RIVER_BANDS)
    if ((variant.maxHeightM ?? Infinity) > 1_666_667)
      assert.ok(variant.minZoom <= 3, variant.key);
  assert.deepEqual(
    RIVER_BANDS.map((v) => v.minZoom),
    [2, 3, 4, 5, 6, 7],
  );
  assert.equal(RIVERS.maxZoom, 11);
});

test('each mode is one style per reach: a colour by its property in the ink, a width by RIV_ORD', () => {
  assert.deepEqual(layerModes(RIVERS), ['network', 'free-flowing', 'pressure']);
  assert.deepEqual(layerInks(RIVERS), ['light', 'dark']);
  for (const mode of layerModes(RIVERS))
    for (const ink of layerInks(RIVERS)) {
      const request = mapRequestFor(RIVERS, band('o4'), ink, mode);
      assert.equal(request.fileFormat, 'PNG');
      assert.equal(request.visualizationOptions, undefined, 'styled: RGB');
      const style = root(request).functionInvocationValue;
      assert.equal(style.functionName, 'Collection.style');
      assert.equal(style.arguments.styleProperty.constantValue, 'style');
      const mapped = style.arguments.collection.functionInvocationValue;
      assert.equal(mapped.functionName, 'Collection.map');
      assert.deepEqual(mapped.arguments.baseAlgorithm.functionDefinitionValue, {
        argumentNames: ['_reach'],
        body: '1',
      });
      const set = styleFn(request).functionInvocationValue;
      assert.equal(set.functionName, 'Element.set');
      assert.equal(set.arguments.key.constantValue, 'style');
      // A whole style ({color, width}) from constant tables: by RIV_ORD last.
      const outer = set.arguments.value.functionInvocationValue;
      assert.equal(outer.functionName, 'List.get');
      assert.match(json(outer.arguments.index), /"RIV_ORD"/);
      assert.doesNotMatch(json(request), /Number\.format|"Dictionary"/);
      const record = modeRecord(RIVERS, mode);
      const tables =
        mode === 'network'
          ? [outer.arguments.list.constantValue]
          : (() => {
              const inner = outer.arguments.list.functionInvocationValue;
              assert.match(json(inner), new RegExp(`"${record.property}"`));
              const table = inner.arguments.list?.constantValue ?? {
                ...inner.arguments.dictionary.constantValue,
              };
              return Object.values(table);
            })();
      for (const styles of tables) {
        assert.equal(styles.length, 10, 'one style per RIV_ORD');
        // Wider the larger the flow.
        for (let i = 1; i < 10; i++)
          assert.ok(styles[i].width <= styles[i - 1].width);
      }
      const colours = new Set(tables.flat().map((style) => style.color));
      for (const colour of Object.values(record.colors[ink]))
        assert.ok(colours.has(colour), colour);
    }
  // NETWORK: the ink, more opaque the larger the flow.
  const network = modeRecord(RIVERS, 'network').colors;
  assert.equal(network.light[1], '9fd8ffff');
  assert.equal(network.dark[1], '08519cff');
  assert.ok(
    parseInt(network.light[10].slice(6), 16) <
      parseInt(network.light[4].slice(6), 16),
  );
  // FREE-FLOWING: three colours by CSI_FF2 (a number: a list by its value).
  const free = modeRecord(RIVERS, 'free-flowing');
  assert.equal(free.property, 'CSI_FF2');
  assert.equal(free.numeric, true);
  assert.deepEqual(Object.keys(free.colors.light), ['1', '2', '3']);
  const freeInner = styleFn(
    mapRequestFor(RIVERS, band('o4'), 'light', 'free-flowing'),
  ).functionInvocationValue.arguments.value.functionInvocationValue.arguments
    .list.functionInvocationValue;
  assert.equal(freeInner.functionName, 'List.get');
  assert.deepEqual(
    freeInner.arguments.list.constantValue.map((styles) => styles[0].color),
    ['56b4e9e6', 'f0e442e6', 'ff7a3de6'],
  );
  // PRESSURE: six categorical colours by CSI_D, the rest faint.
  const pressure = modeRecord(RIVERS, 'pressure');
  assert.equal(pressure.property, 'CSI_D');
  assert.deepEqual(Object.keys(pressure.colors.dark), [
    'DOF',
    'DOR',
    'SED',
    'USE',
    'RDD',
    'URB',
    'NAN',
  ]);
  for (const ink of ['light', 'dark']) {
    const hues = Object.values(pressure.colors[ink]).map((c) => c.slice(0, 6));
    assert.equal(new Set(hues).size, 7, 'seven distinct colours');
    assert.equal(pressure.colors[ink].NAN.slice(6), '59', 'faint');
  }
  const pressureLookup = styleFn(
    mapRequestFor(RIVERS, band('o4'), 'light', 'pressure'),
  ).functionInvocationValue.arguments.value.functionInvocationValue.arguments
    .list.functionInvocationValue;
  assert.equal(pressureLookup.functionName, 'Dictionary.get');
  assert.equal(
    pressureLookup.arguments.defaultValue.constantValue[0].color,
    pressure.fallback.light,
    'anything else: faint',
  );
  assert.equal(
    pressureLookup.arguments.key.functionInvocationValue.functionName,
    'Element.get',
    'CSI_D is text: looked up as it is',
  );
  // Each (band, ink, mode) is its own map and its own tile cache.
  const hashes = new Set();
  for (const variant of RIVER_BANDS)
    for (const mode of layerModes(RIVERS))
      for (const ink of layerInks(RIVERS))
        hashes.add(mapRequestHash(RIVERS, variant, ink, mode));
  assert.equal(hashes.size, 6 * 3 * 2);
});

test('a band filters RIV_ORD; the widest band draws every reach', () => {
  const filter = featureFilter(RIVERS, band('o5')).functionInvocationValue;
  assert.equal(filter.functionName, 'Filter.lessThanOrEquals');
  assert.equal(filter.arguments.leftField.constantValue, 'RIV_ORD');
  assert.equal(filter.arguments.rightValue.constantValue, 5);
  assert.equal(featureFilter(RIVERS, band('all')), null);
  const all = mapRequestFor(RIVERS, band('all'), 'light', 'network');
  assert.doesNotMatch(json(all), /Collection\.filter/);
  assert.match(
    json(mapRequestFor(RIVERS, band('o7'), 'dark', 'pressure')),
    /"Collection\.filter"/,
  );
  assert.match(json(all), /"WWF\/HydroSHEDS\/v1\/FreeFlowingRivers"/);
});

test('the Americas switch is one flag, off by default, that leaves out CON_ID 1 and 2', () => {
  assert.equal(RIVERS.omitAmericas, false);
  assert.deepEqual([...AMERICAS_CON_IDS], [1, 2]);
  // Off: no CON_ID anywhere in what is sent.
  for (const variant of RIVER_BANDS)
    assert.doesNotMatch(
      json(mapRequestFor(RIVERS, variant, 'light', 'network')),
      /CON_ID/,
    );
  const on = { ...RIVERS, omitAmericas: true };
  // On, with a band: both filters.
  const both = featureFilter(on, band('o4')).functionInvocationValue;
  assert.equal(both.functionName, 'Filter.and');
  const [order, americas] = both.arguments.filters.arrayValue.values.map(
    (node) => node.functionInvocationValue,
  );
  assert.equal(order.functionName, 'Filter.lessThanOrEquals');
  assert.equal(americas.functionName, 'Filter.not');
  // Not (CON_ID = 1 or CON_ID = 2): numeric equality, since CON_ID is a
  // double and Filter.inList [1, 2] matched nothing live.
  const either = americas.arguments.filter.functionInvocationValue;
  assert.equal(either.functionName, 'Filter.or');
  const eqs = either.arguments.filters.arrayValue.values.map(
    (node) => node.functionInvocationValue,
  );
  assert.deepEqual(
    eqs.map((eq) => [
      eq.functionName,
      eq.arguments.leftField.constantValue,
      eq.arguments.rightValue.constantValue,
    ]),
    [
      ['Filter.eq', 'CON_ID', 1],
      ['Filter.eq', 'CON_ID', 2],
    ],
  );
  assert.doesNotMatch(json(featureFilter(on, band('o4'))), /inList/);
  // On, every order: the Americas filter alone.
  assert.equal(
    featureFilter(on, band('all')).functionInvocationValue.functionName,
    'Filter.not',
  );
  // A different request, so a different tile cache.
  assert.notEqual(
    mapRequestHash(on, band('o4'), 'light', 'network'),
    mapRequestHash(RIVERS, band('o4'), 'light', 'network'),
  );
  // The other features layers never filter.
  const boundaries = EARTH_ENGINE_LAYERS.find(
    (layer) => layer.id === 'ee-admin-boundaries',
  );
  assert.equal(featureFilter(boundaries, boundaries.variants[1]), null);
});

test('names thin by scalerank with the height, and go below regional scale', () => {
  assert.equal(maxRankForHeight(20_000_000), 2);
  assert.equal(maxRankForHeight(8_000_000), 2);
  assert.equal(maxRankForHeight(7_999_999), 4);
  assert.equal(maxRankForHeight(2_500_000), 5);
  assert.equal(maxRankForHeight(1_200_000), 7);
  assert.equal(maxRankForHeight(500_000), 9);
  assert.equal(maxRankForHeight(NAMES_MIN_HEIGHT_M), 12);
  assert.equal(maxRankForHeight(NAMES_MIN_HEIGHT_M - 1), null);
  for (let i = 1; i < NAME_BANDS.length; i++)
    assert.ok(NAME_BANDS[i].maxRank > NAME_BANDS[i - 1].maxRank);
  const features = [
    {
      name: 'Amazon',
      es: 'Amazonas',
      ru: 'Амазонка',
      rank: 1,
      at: [
        [-54, -2],
        [-69, -3.4],
      ],
    },
    { name: 'Rhine', es: 'Rin', rank: 4, at: [[7.1, 50.7]] },
    { name: 'Lahn', rank: 9, at: [[8.6, 50.4]] },
  ];
  const ids = (view) =>
    pickRiverNames(features, view).map((p) => p.feature.name);
  // Orbit: the planet's window, the largest rivers only.
  assert.deepEqual(ids({ lat: 0, lon: -60, height: 20_000_000 }), [
    'Amazon',
    'Amazon',
  ]);
  // Over Germany at 3,000 km: the window is the planet still, ranks to 5,
  // but only the side the camera sees (the Amazon is behind the horizon).
  assert.deepEqual(ids({ lat: 50, lon: 8, height: 3_000_000 }), ['Rhine']);
  assert.deepEqual(ids({ lat: 0, lon: -150, height: 3_000_000 }), []);
  assert.deepEqual(ids({ lat: 0, lon: -50, height: 3_000_000 }), [
    'Amazon',
    'Amazon',
  ]);
  // At 300 km: the window (1,800 km across) and every rank.
  assert.deepEqual(ids({ lat: 50, lon: 8, height: 300_000 }), [
    'Rhine',
    'Lahn',
  ]);
  assert.deepEqual(ids({ lat: 50, lon: 8, height: 100_000 }), []);
  // Larger rivers first, at most the limit.
  const many = Array.from({ length: 400 }, (_, i) => ({
    name: `R${i}`,
    rank: i % 3,
    at: [[(i % 360) - 180, 0]],
  }));
  const picked = pickRiverNames(many, { lat: 0, lon: 0, height: 20_000_000 });
  assert.equal(picked.length, MAX_NAME_LABELS);
  assert.ok(
    picked.every((p, i) => !i || picked[i - 1].feature.rank <= p.feature.rank),
  );
  // The page's language when the pack has it.
  assert.equal(riverNameText(features[0], 'es'), 'Amazonas');
  assert.equal(riverNameText(features[0], 'ru'), 'Амазонка');
  assert.equal(riverNameText(features[2], 'ru'), 'Lahn');
  assert.equal(riverNameText(features[1], 'en'), 'Rhine');
});

test('the bundled pack is Natural Earth’s names and label points, small', async () => {
  const file = new URL(
    '../../data/local_data/natural_earth/river_names.json',
    import.meta.url,
  );
  const bytes = fs.statSync(file).size;
  assert.ok(bytes < 150_000, `${bytes} bytes`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(pack.meta.source, /ne_10m_rivers_lake_centerlines/);
  assert.match(pack.meta.url, /^https:\/\/naciscdn\.org\/naturalearth\//);
  assert.match(pack.meta.license, /Public domain/);
  const features = await loadRiverNames();
  assert.equal(features.length, pack.features.length);
  const byName = new Map(features.map((f) => [f.name, f]));
  for (const name of [
    'Amazon',
    'Nile',
    'Mississippi',
    'Lena',
    'Danube',
    'Rhine',
  ])
    assert.ok(byName.has(name), name);
  assert.equal(byName.get('Danube').es, 'Danubio');
  for (const feature of features) {
    assert.ok(
      Number.isInteger(feature.rank) && feature.rank >= 0 && feature.rank <= 12,
    );
    assert.ok(feature.at.length >= 1);
    for (const [lon, lat] of feature.at)
      assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90);
    assert.deepEqual(
      Object.keys(feature).filter(
        (k) => !['name', 'es', 'ru', 'rank', 'at'].includes(k),
      ),
      [],
    );
  }
  // Orbit shows tens of names, not hundreds.
  const orbit = pickRiverNames(features, {
    lat: 20,
    lon: 0,
    height: 20_000_000,
  });
  assert.ok(orbit.length > 20 && orbit.length < 120, `${orbit.length}`);
});

test('names are world-overlay labels in the ink, published on each view and cleared off', async () => {
  const calls = [];
  const overlayHost = {
    setEntries: (source, entries, options) =>
      calls.push({ op: 'set', source, entries, options }),
    setVisible: (source, visible) =>
      calls.push({ op: 'visible', source, visible }),
    clearSource: (source) => calls.push({ op: 'clear', source }),
  };
  const names = createRiverNames({
    overlayHost,
    load: async () => [
      { name: 'Amazon', es: 'Amazonas', rank: 1, at: [[-54, -2]] },
      { name: 'Lahn', rank: 9, at: [[8.6, 50.4]] },
    ],
    locale: () => 'es',
  });
  names.enable();
  names.update({ lat: 0, lon: -60, height: 20_000_000 }, 'dark');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const set = calls.filter((c) => c.op === 'set').at(-1);
  assert.equal(set.source, RIVER_NAMES_SOURCE);
  assert.equal(set.entries.length, 1);
  const [entry] = set.entries;
  assert.equal(entry.variant, 'label');
  assert.equal(entry.title, 'Amazonas');
  assert.equal(entry.accent, '#08519c', 'dark ink on a light map');
  assert.equal(entry.interactive, false);
  // The overlay host takes it as it is.
  const normalized = normalizeOverlayEntry(RIVER_NAMES_SOURCE, entry);
  assert.equal(normalized.variant, 'label');
  assert.equal(normalized.collisionGroup, 'river-name');
  assert.equal(names.count(), 1);
  names.update({ lat: 50, lon: 8, height: 300_000 }, 'light');
  const closer = calls.filter((c) => c.op === 'set').at(-1);
  assert.deepEqual(
    closer.entries.map((e) => e.title),
    ['Lahn'],
  );
  assert.equal(closer.entries[0].accent, '#9fd8ff');
  names.disable();
  assert.deepEqual(calls.slice(-2), [
    { op: 'clear', source: RIVER_NAMES_SOURCE },
    { op: 'visible', source: RIVER_NAMES_SOURCE, visible: false },
  ]);
  assert.equal(names.count(), 0);
});

/** The real server catalog (fake Earth Engine), as the browser gets it. */
async function riversCatalog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-rivers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const made = [];
  const service = createEarthEngineService({
    sourceRoot: dir,
    env: {},
    layers: [RIVERS],
    backend: {
      async createMap(layer, variant, ink, mode) {
        made.push(`${mode}/${variant.key}/${ink}`);
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
  return { body: await service.layers(), made, service };
}

test('the row: mode and ink chips, the mode kept as gev.rivers.mode, the legend in the ink drawn', async (t) => {
  const { body, made } = await riversCatalog(t);
  assert.deepEqual(made, [], 'lazy: the catalog makes no Rivers map');
  const row = body.layers[0];
  assert.deepEqual(row.modes, ['network', 'free-flowing', 'pressure']);
  assert.match(
    row.tileUrl,
    /\/tile\/ee-rivers\/\{mode\}\/\{variant\}\/\{ink\}\//,
  );
  assert.equal(row.variants[0].minZoom, 2);
  assert.match(row.variants[0].modeVersions.pressure.dark, /^[0-9a-f]{12}$/);

  const source = createEarthEngineSource({
    fetchImpl: async () => Response.json(body),
  });
  const layers = [];
  let height = 20_000_000;
  const listeners = [];
  const viewer = {
    imageryLayers: {
      add: (layer) => (layers.push(layer), layer),
      remove: (layer) => {
        const i = layers.indexOf(layer);
        if (i >= 0) layers.splice(i, 1);
        return i >= 0;
      },
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(10, 48, height);
      },
      moveEnd: {
        addEventListener: (fn) => (listeners.push(fn), () => {}),
      },
    },
  };
  const storage = memoryStorage({ 'gev.rivers.mode': 'pressure' });
  assert.equal(readMode(storage, RIVERS), 'pressure');
  assert.equal(
    readMode(memoryStorage({ 'gev.rivers.mode': 'bogus' }), RIVERS),
    'network',
  );
  const named = [];
  const layer = createEarthEngineLayer({
    record: RIVERS,
    source,
    storage,
    names: {
      enable: () => named.push('enable'),
      update: (view, ink) =>
        named.push(`update ${Math.round(view.height / 1000)} ${ink}`),
      disable: () => named.push('disable'),
    },
  });
  let repaints = 0;
  layer.setRowControlsListener(() => repaints++);
  layer.init(viewer);
  layer.enable(viewer);
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(layers.length, 1);
  const provider = layers[0].imageryProvider;
  assert.match(
    provider.url,
    /\/tile\/ee-rivers\/pressure\/o3\/light\/\{z\}\/\{x\}\/\{y\}\?v=[0-9a-f]{12}$/,
  );
  assert.equal(provider.minimumLevel, 2, 'orbit starts at z 2');
  assert.equal(provider.maximumLevel, 11);
  assert.equal(named[0], 'enable');
  assert.ok(named.includes('update 20000 light'));

  // The chips: three modes, the inks; no level chips for the bands.
  let controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    [
      'mode-network',
      'mode-free-flowing',
      'mode-pressure',
      'ink-auto',
      'ink-light',
      'ink-dark',
    ],
  );
  assert.deepEqual(
    controls.chips.filter((chip) => chip.active).map((chip) => chip.id),
    ['mode-pressure', 'ink-auto'],
  );
  assert.equal(controls.legend.length, 7);
  assert.equal(controls.legend[0].label, 'Dams (fragmentation)');
  assert.equal(controls.legend[0].color, '#ff7a3d');
  assert.match(controls.info, /Rivers of flow orders 1 to 3/);

  // A chip: kept, drawn at once, and the row repaints.
  const before = repaints;
  controls.chips.find((chip) => chip.id === 'mode-free-flowing').onClick();
  assert.equal(storage.map.get('gev.rivers.mode'), 'free-flowing');
  assert.ok(repaints > before, 'the row repaints');
  assert.equal(layers.length, 1);
  assert.match(
    layers[0].imageryProvider.url,
    /\/ee-rivers\/free-flowing\/o3\/light\//,
  );
  controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.filter((chip) => chip.active).map((chip) => chip.id),
    ['mode-free-flowing', 'ink-auto'],
  );
  assert.deepEqual(
    controls.legend.map((entry) => entry.label),
    ['Free-flowing', 'Good connectivity', 'Impacted'],
  );
  // DARK INK: the legend's swatches follow.
  controls.chips.find((chip) => chip.id === 'ink-dark').onClick();
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/o3\/dark\//);
  assert.equal(layer.getRowControls().legend[0].color, '#0072b2');
  assert.equal(named.at(-1), 'update 20000 dark');

  // In: a band with more orders, from its own first level.
  height = 300_000;
  listeners.forEach((fn) => fn());
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/o6\/dark\//);
  assert.equal(layers[0].imageryProvider.minimumLevel, 5, 'o6 from z 5');
  assert.ok(layers[0].rectangle, 'inside the view square');
  height = 50_000;
  listeners.forEach((fn) => fn());
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/all\/dark\//);
  assert.equal(layer._state().mode, 'free-flowing');

  layer.disable();
  assert.equal(layers.length, 0);
  assert.equal(named.at(-1), 'disable');
});

test('the mode chips exist only on a layer with modes', () => {
  assert.deepEqual(
    MODE_CHIPS.map((chip) => chip.key),
    ['network', 'free-flowing', 'pressure'],
  );
  const boundaries = EARTH_ENGINE_LAYERS.find(
    (layer) => layer.id === 'ee-admin-boundaries',
  );
  const controls = rowControls({
    record: boundaries,
    opacity: 0.7,
    onOpacity() {},
  });
  assert.ok(controls.chips.every((chip) => !chip.id.startsWith('mode-')));
  assert.equal(
    tileTemplate('ee-rivers', 'o5', 'dark', '0123456789ab', 'pressure'),
    '/api/earth-engine/tile/ee-rivers/pressure/o5/dark/{z}/{x}/{y}?v=0123456789ab',
  );
  assert.equal(
    tileTemplate('ee-forest-loss', 'default', 'default', undefined, 'default'),
    '/api/earth-engine/tile/ee-forest-loss/default/default/{z}/{x}/{y}',
  );
});
