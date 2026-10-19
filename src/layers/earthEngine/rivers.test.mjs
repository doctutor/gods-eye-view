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
  AMERICAS_KEEP,
  EARTH_ENGINE_LAYERS,
  RIVER_BANDS,
  RIVER_INKS,
  layerInks,
  layerModes,
  modeRecord,
  riverHeightForCanvas,
  riverLineWidth,
  riverOrdersAt,
  riverZoomForHeight,
  scaleAlpha,
  variantForHeight,
} from '../../data/earthEngineLayers.js';
import {
  INKS as V2_INKS,
  bandForZoom,
  widthFor,
} from '../../../server/providers/riversV2/bands.js';
import {
  createEarthEngineService,
  featureFilter,
  mapRequestFor,
  mapRequestHash,
} from '../../../server/providers/earthEngine.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { createEarthEngineLayer, readMode } from './index.js';
import { MODE_CHIPS, rowControls } from './presentation.js';
import { createRiverClicks } from './riverClicks.js';
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
  assert.equal(at(6_675_000), 'o3');
  assert.equal(at(6_674_999), 'o4');
  assert.equal(at(1_666_000), 'o4');
  assert.equal(at(1_665_999), 'o5');
  assert.equal(at(834_375), 'o5');
  assert.equal(at(834_374), 'o6');
  assert.equal(at(417_187.5), 'o6');
  assert.equal(at(417_187), 'o7');
  assert.equal(at(104_296.875), 'o7');
  assert.equal(at(104_296), 'all');
  assert.equal(at(500), 'all');
  // More orders as the view comes in.
  const orders = RIVER_BANDS.map((v) => v.maxOrder ?? 10);
  assert.deepEqual(orders, [3, 4, 5, 6, 7, 10]);
  assert.equal(riverOrdersAt(20_000_000), 3);
  assert.equal(riverOrdersAt(1_000_000), 5);
  assert.equal(riverOrdersAt(50_000), 10);
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

test('the bands switch where Cesium’s imagery level steps, and HydroSHEDS v2 draws the same orders at those zooms', () => {
  // Cesium's level at the middle of the view (a 1,600 px wide canvas).
  assert.equal(riverZoomForHeight(20_000_000), 3);
  assert.equal(riverZoomForHeight(6_675_000), 4);
  assert.equal(riverZoomForHeight(6_674_000), 5);
  assert.equal(riverZoomForHeight(1_670_000), 6);
  assert.equal(riverZoomForHeight(1_660_000), 7);
  assert.equal(riverZoomForHeight(834_375), 7);
  assert.equal(riverZoomForHeight(834_000), 8);
  assert.equal(riverZoomForHeight(417_187.5), 8);
  assert.equal(riverZoomForHeight(417_000), 9);
  assert.equal(riverZoomForHeight(104_296.875), 10);
  assert.equal(riverZoomForHeight(104_000), 11);
  // Each band's zooms are the ones its heights give…
  for (const variant of RIVER_BANDS) {
    const top = Math.min(variant.maxHeightM ?? 40_000_000, 40_000_000);
    const bottom = variant.minHeightM ?? 1_000;
    const [from, to] = variant.zooms;
    // (o4's floor is 1,666 km, a hair under the z 6/7 step at 1,669 km.)
    if (variant.minHeightM)
      assert.equal(riverZoomForHeight(bottom * 1.003), to, variant.key);
    if (variant.maxHeightM)
      assert.equal(riverZoomForHeight(top * 0.999), from, variant.key);
  }
  // …and v2's band at each of those zooms draws the same orders (v2 has no
  // order past 8, its 1 km² streams).
  for (const variant of RIVER_BANDS)
    for (let z = variant.zooms[0]; z <= variant.zooms[1]; z++)
      assert.equal(
        bandForZoom(z).maxOrder,
        Math.min(8, variant.maxOrder ?? 10),
        `${variant.key} at z ${z}`,
      );
  // Height by height, the orders drawn are the same on both sides.
  for (let height = 50_000; height < 30_000_000; height *= 1.07) {
    const v1 = Math.min(8, riverOrdersAt(height));
    const v2 = bandForZoom(Math.min(14, riverZoomForHeight(height))).maxOrder;
    if (Math.abs(height - 1_667_500) > 3_000)
      assert.equal(v2, v1, `${Math.round(height / 1000)} km`);
  }
});

test('lines match HydroSHEDS v2’s: 0.75 px for the smallest order a band draws, 0.55 px more per order, 4 px at most, in the same inks', () => {
  assert.deepEqual({ ...RIVER_INKS }, { light: 'ffffffcc', dark: '1a1a1acc' });
  assert.equal(V2_INKS, RIVER_INKS, 'one table');
  assert.equal(riverLineWidth(4, 4), 0.75);
  assert.equal(riverLineWidth(3, 4), 1.3);
  assert.equal(riverLineWidth(1, 4), 2.4);
  assert.equal(riverLineWidth(1, 10), 4, 'capped');
  assert.equal(riverLineWidth(9, 10), 0.75, 'v1 orders 9 and 10 draw as 8');
  for (let z = 0; z <= 14; z++) {
    const top = bandForZoom(z).maxOrder;
    for (let order = 1; order <= top; order++)
      assert.equal(widthFor(order, z), riverLineWidth(order, top));
  }
  // The NETWORK styles Earth Engine draws: the ink, a 1 px line at the
  // width's share of the ink's alpha under a pixel, the width above it.
  for (const variant of RIVER_BANDS)
    for (const ink of ['light', 'dark']) {
      const styles = styleFn(mapRequestFor(RIVERS, variant, ink, 'network'))
        .functionInvocationValue.arguments.value.functionInvocationValue
        .arguments.list.constantValue;
      assert.equal(styles.length, 10);
      styles.forEach((style, i) => {
        const width = riverLineWidth(i + 1, variant.maxOrder ?? 10);
        assert.equal(style.color.slice(0, 6), RIVER_INKS[ink].slice(0, 6));
        if (width < 1) {
          assert.equal(style.width, 1);
          assert.equal(style.color, scaleAlpha(RIVER_INKS[ink], width));
        } else {
          assert.equal(style.width, Math.round(width * 100) / 100);
          assert.equal(style.color, RIVER_INKS[ink]);
        }
      });
    }
  assert.equal(scaleAlpha('1a1a1acc', 0.75), '1a1a1a99');
});

test('each mode is one style per reach: a colour by its property in the ink, a width by RIV_ORD', () => {
  assert.deepEqual(layerModes(RIVERS), [
    'network',
    'network-rest',
    'free-flowing',
    'pressure',
  ]);
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
      const tables = record.inInk
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
      const colours = new Set(
        tables.flat().map((style) => style.color.slice(0, 6)),
      );
      for (const colour of Object.values(
        record.inInk ? { ink: RIVER_INKS[ink] } : record.colors[ink],
      ))
        assert.ok(colours.has(colour.slice(0, 6)), colour);
    }
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
  assert.equal(hashes.size, 6 * 4 * 2);
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
  assert.equal(entry.accent, '#1a1a1a', 'dark ink on a light map');
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
  assert.equal(closer.entries[0].accent, '#ffffff');
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
  assert.deepEqual(row.modes, [
    'network',
    'network-rest',
    'free-flowing',
    'pressure',
  ]);
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
    /\/tile\/ee-rivers\/pressure\/zoom\/light\/\{z\}\/\{x\}\/\{y\}\?v=[0-9a-f]{12}$/,
  );
  assert.equal(
    provider.minimumLevel,
    0,
    'by zoom: every level Cesium asks for',
  );
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
    /\/ee-rivers\/free-flowing\/zoom\/light\//,
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
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/zoom\/dark\//);
  assert.equal(layer.getRowControls().legend[0].color, '#0072b2');
  assert.equal(named.at(-1), 'update 20000 dark');

  // In: a band with more orders, from its own first level.
  height = 600_000;
  listeners.forEach((fn) => fn());
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/zoom\/dark\//);
  assert.equal(layers[0].imageryProvider.minimumLevel, 0);
  assert.match(layer.getRowControls().info, /Rivers of flow orders 1 to 6/);
  assert.ok(layers[0].rectangle, 'inside the view square');
  height = 50_000;
  listeners.forEach((fn) => fn());
  assert.match(layers[0].imageryProvider.url, /\/free-flowing\/zoom\/dark\//);
  assert.match(layer.getRowControls().info, /Rivers of every flow order/);
  assert.equal(layer._state().mode, 'free-flowing');

  layer.disable();
  assert.equal(layers.length, 0);
  assert.equal(named.at(-1), 'disable');
});

test('the mode chips exist only on a layer with modes', () => {
  assert.deepEqual(
    MODE_CHIPS.map((chip) => chip.key),
    [
      'network',
      'free-flowing',
      'pressure',
      // Surface water and Land cover (image layers with modes).
      'occurrence',
      'change',
      'seasonality',
      // Census tracts (TRACTS in Earth Engine, INCOME local) and Inundation.
      'tracts',
      'income',
      'count',
      'duration',
      'v200',
      'v100',
      // Population's epochs (src/data/forestPopulation.test.mjs).
      'density-2020',
      'density-2000',
      'density-1990',
      'density-1975',
    ],
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

test('network-rest leaves out the Americas but where HydroSHEDS v2 has no data: Greenland, west of 169.72° W, north of 83.13° N', () => {
  const rest = modeRecord(RIVERS, 'network-rest');
  assert.equal(rest.omitAmericas, true);
  assert.equal(rest.hidden, true);
  assert.deepEqual(
    AMERICAS_KEEP.map((place) => place.equals || place.box.join(',')),
    ['Greenland', '-180,-90,-169.72,90', '-180,83.13,180,90'],
  );
  for (const variant of RIVER_BANDS) {
    const filter = featureFilter(RIVERS, variant, 'network-rest');
    const nodes =
      filter.functionInvocationValue.functionName === 'Filter.and'
        ? filter.functionInvocationValue.arguments.filters.arrayValue.values
        : [filter];
    const americas = nodes.at(-1).functionInvocationValue;
    // Drawn: outside the Americas, or in Greenland, or in one of the boxes.
    assert.equal(americas.functionName, 'Filter.or');
    const [outside, greenland, west, north] =
      americas.arguments.filters.arrayValue.values.map(
        (node) => node.functionInvocationValue,
      );
    assert.equal(outside.functionName, 'Filter.not', 'cheap test first');
    assert.match(json(outside), /"CON_ID".*"CON_ID"/);
    assert.deepEqual(
      [
        greenland.functionName,
        greenland.arguments.leftField.constantValue,
        greenland.arguments.rightValue.constantValue,
      ],
      ['Filter.eq', 'COUNTRY', 'Greenland'],
    );
    for (const [box, expected] of [
      [west, [-180, -90, -169.72, 90]],
      [north, [-180, 83.13, 180, 90]],
    ]) {
      assert.equal(box.functionName, 'Filter.intersects');
      assert.equal(box.arguments.leftField.constantValue, '.geo');
      const bbox = box.arguments.rightValue.functionInvocationValue;
      assert.equal(bbox.functionName, 'GeometryConstructors.BBox');
      assert.deepEqual(
        ['west', 'south', 'east', 'north'].map(
          (side) => bbox.arguments[side].constantValue,
        ),
        expected,
      );
    }
  }
  // Only network-rest omits: NETWORK, FREE-FLOWING and PRESSURE draw v1
  // everywhere (their scores exist only for v1).
  for (const mode of ['network', 'free-flowing', 'pressure'])
    assert.doesNotMatch(
      json(mapRequestFor(RIVERS, band('o4'), 'light', mode)),
      /CON_ID|Greenland/,
      mode,
    );
  // Its styles are NETWORK's.
  assert.deepEqual(
    styleFn(mapRequestFor(RIVERS, band('o5'), 'dark', 'network-rest')),
    styleFn(mapRequestFor(RIVERS, band('o5'), 'dark', 'network')),
  );
  assert.notEqual(
    mapRequestHash(RIVERS, band('o5'), 'dark', 'network-rest'),
    mapRequestHash(RIVERS, band('o5'), 'dark', 'network'),
  );
});

const V2_EXTENT = { west: -169.72, south: -55.96, east: -32.41, north: 83.13 };
const v2Ready = () => ({
  configured: true,
  attribution:
    'HydroSHEDS v2 (Lehner et al. 2022; WWF, DLR, Confluvio), CC BY 4.0',
  minZoom: 0,
  maxZoom: 14,
  versions: { light: '00000000000a', dark: '00000000000b' },
  extent: V2_EXTENT,
  bands: [],
});

/** A Rivers layer on a fake viewer with the real catalog and a v2 status. */
async function riversLayer(
  t,
  { v2 = v2Ready(), mode = 'network', lon = -90 } = {},
) {
  const { body } = await riversCatalog(t);
  const source = createEarthEngineSource({
    fetchImpl: async () => Response.json(body),
  });
  const layers = [];
  const listeners = [];
  const state = { height: 20_000_000, lat: 35, lon };
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
        return Cesium.Cartographic.fromDegrees(
          state.lon,
          state.lat,
          state.height,
        );
      },
      moveEnd: { addEventListener: (fn) => (listeners.push(fn), () => {}) },
    },
  };
  const credited = [];
  const asked = [];
  const layer = createEarthEngineLayer({
    record: RIVERS,
    source,
    storage: memoryStorage({ 'gev.rivers.mode': mode }),
    credits: { register: (_, credit) => credited.push(credit.key) },
    v2Source: {
      status: async ({ refresh } = {}) => {
        asked.push(refresh ? 'refresh' : 'status');
        if (v2 instanceof Error) throw v2;
        return v2;
      },
      last: () => null,
    },
    v2Credit: { key: 'hydrosheds-v2', html: 'HydroSHEDS v2' },
  });
  layer.init(viewer);
  layer.enable(viewer);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const move = (next) => {
    Object.assign(state, next);
    listeners.forEach((fn) => fn());
  };
  return { layer, layers, credited, asked, move };
}

test('NETWORK in the Americas is HydroSHEDS v2 while it is built, with Earth Engine’s network-rest for the rest of the world', async (t) => {
  const { layer, layers, credited, move } = await riversLayer(t);
  assert.equal(layers.length, 2, 'Earth Engine, then v2 above it');
  const [ee, v2] = layers;
  assert.match(
    ee.imageryProvider.url,
    /\/ee-rivers\/network-rest\/zoom\/light\//,
  );
  assert.match(
    v2.imageryProvider.url,
    /^\/api\/rivers\/v2\/tile\/light\/\{z\}\/\{x\}\/\{y\}\?v=00000000000a$/,
  );
  // v2 at the Earth Engine side's levels: no sharper, no blurrier.
  assert.equal(
    v2.imageryProvider.maximumLevel,
    ee.imageryProvider.maximumLevel,
  );
  assert.equal(
    v2.imageryProvider.minimumLevel,
    ee.imageryProvider.minimumLevel,
  );
  assert.equal(v2.imageryProvider.maximumLevel, 11);
  // Inside v2's extent (orbit: the whole extent).
  const degrees = (r) => Cesium.Math.toDegrees(r);
  assert.equal(degrees(v2.rectangle.west).toFixed(2), '-169.72');
  assert.equal(degrees(v2.rectangle.north).toFixed(2), '83.13');
  assert.equal(v2.alpha, ee.alpha, 'one opacity');
  assert.ok(credited.includes('hydrosheds-v2'));
  assert.match(layer.getRowControls().info, /The Americas from HydroSHEDS v2/);
  // The chip still says NETWORK.
  assert.deepEqual(
    layer
      .getRowControls()
      .chips.filter((chip) => chip.active)
      .map((chip) => chip.id),
    ['mode-network', 'ink-auto'],
  );
  // DARK INK: v2's own version for the ink.
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'ink-dark')
    .onClick();
  assert.match(
    layers[1].imageryProvider.url,
    /\/tile\/dark\/.*\?v=00000000000b$/,
  );
  assert.match(layers[0].imageryProvider.url, /\/network-rest\/zoom\/dark\//);
  // Opacity moves both.
  layer.getRowControls().slider.onInput(40);
  assert.deepEqual(
    layers.map((l) => l.alpha),
    [0.4, 0.4],
  );
  // Close in over the Americas: v2 inside the view's square.
  move({ height: 300_000, lat: 38.6, lon: -90.2 });
  assert.match(layers[0].imageryProvider.url, /\/network-rest\/zoom\/dark\//);
  assert.ok(
    degrees(layers[1].rectangle.west) > -105 &&
      degrees(layers[1].rectangle.west) < -95,
    'clipped to the view square',
  );
  // Over Europe the view square misses v2's extent: Earth Engine only.
  move({ height: 300_000, lat: 50, lon: 8 });
  assert.equal(layers.length, 1);
  assert.match(layers[0].imageryProvider.url, /\/network-rest\/zoom\/dark\//);
  // FREE-FLOWING and PRESSURE: v1 everywhere, nothing omitted.
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'mode-pressure')
    .onClick();
  move({ height: 20_000_000, lat: 35, lon: -90 });
  assert.equal(layers.length, 1);
  assert.match(
    layers[0].imageryProvider.url,
    /\/ee-rivers\/pressure\/zoom\/dark\//,
  );
  assert.doesNotMatch(layer.getRowControls().info, /HydroSHEDS v2/);
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'mode-network')
    .onClick();
  assert.equal(layers.length, 2);
  layer.disable();
  assert.equal(layers.length, 0);
});

test('without a v2 build (503) or its status, NETWORK is v1 everywhere, quietly', async (t) => {
  for (const v2 of [
    {
      ...v2Ready(),
      configured: false,
      versions: {},
      message: 'Run npm run rivers:build',
    },
    new Error('HTTP 503'),
    { ...v2Ready(), versions: { dark: '00000000000b' } },
  ]) {
    const { layer, layers } = await riversLayer(t, { v2 });
    assert.equal(layers.length, 1, String(v2?.message || 'no light ink'));
    assert.match(
      layers[0].imageryProvider.url,
      /\/ee-rivers\/network\/zoom\/light\//,
    );
    const info = layer.getRowControls().info;
    assert.doesNotMatch(info, /HydroSHEDS|rivers:build|503/);
    layer.disable();
  }
  // A refresh of the layer asks v2 again: a build that lands is drawn.
  const { layer, layers, asked } = await riversLayer(t, {
    v2: { ...v2Ready(), configured: false, versions: {} },
  });
  assert.equal(layers.length, 1);
  await layer.update();
  assert.ok(asked.includes('refresh'));
  layer.disable();
});

test('clicks: attached while the layer is on, at most the orders drawn at the height, gone when it is off', async () => {
  const calls = [];
  const highlight = { detach: () => calls.push('detach highlight') };
  let maxOrder = null;
  const clicks = createRiverClicks({
    overlayHost: { name: 'overlays' },
    picking: { name: 'picking' },
    isPointerFree: () => true,
    credits: { register: (_, credit) => calls.push(`credit ${credit.key}`) },
    credit: { key: 'river-reach', html: 'x' },
    attachHighlight: (services) => {
      calls.push(
        `highlight ${services.overlays.name} ${services.picking.name}`,
      );
      return highlight;
    },
    attachClicks: (options) => {
      assert.equal(options.highlight, highlight);
      maxOrder = options.maxOrder;
      calls.push('clicks');
      return () => calls.push('detach clicks');
    },
  });
  const viewer = { scene: {} };
  clicks.enable(viewer);
  clicks.enable(viewer);
  assert.deepEqual(calls, [
    'highlight overlays picking',
    'clicks',
    'credit river-reach',
  ]);
  assert.equal(clicks.attached(), true);
  // The orders the layer draws there.
  assert.equal(maxOrder(20_000_000), 3);
  assert.equal(maxOrder(3_000_000), 4);
  assert.equal(maxOrder(1_000_000), 5);
  assert.equal(maxOrder(600_000), 6);
  assert.equal(maxOrder(200_000), 7);
  assert.equal(maxOrder(50_000), 10);
  for (let height = 60_000; height < 30_000_000; height *= 1.3)
    assert.equal(
      maxOrder(height),
      variantForHeight(RIVERS, height).maxOrder ?? 10,
    );
  clicks.disable();
  assert.deepEqual(calls.slice(-2), ['detach clicks', 'detach highlight']);
  assert.equal(clicks.attached(), false);
  clicks.disable();
  assert.equal(calls.length, 5);

  // The layer drives it.
  const seen = [];
  const layer = createEarthEngineLayer({
    record: RIVERS,
    source: { catalog: async () => ({ configured: false, layers: new Map() }) },
    clicks: {
      enable: (v) => seen.push(v === viewer ? 'enable' : 'enable?'),
      disable: () => seen.push('disable'),
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  layer.disable();
  assert.deepEqual(seen, ['enable', 'disable']);
});

/** A Rivers layer on a fake globe or 3D-tileset host, with a canvas size. */
async function hostedRivers(
  t,
  { host = 'globe', width = 720, height = 507, catalog } = {},
) {
  const body = catalog || (await riversCatalog(t)).body;
  const source = createEarthEngineSource({
    fetchImpl: async () => Response.json(body),
  });
  const collection = (list) => ({
    add: (layer) => (list.push(layer), layer),
    remove: (layer) => {
      const i = list.indexOf(layer);
      if (i >= 0) list.splice(i, 1);
      return i >= 0;
    },
    get length() {
      return list.length;
    },
  });
  const globeLayers = [];
  const tilesetLayers = [];
  const state = { height: 4_500_000 };
  const viewer = {
    imageryLayers: collection(globeLayers),
    scene: {
      globe: { show: host === 'globe' },
      canvas: { clientWidth: width, clientHeight: height },
    },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(-100, 40, state.height);
      },
      moveEnd: { addEventListener: () => () => {} },
    },
  };
  const tileset = { imageryLayers: collection(tilesetLayers) };
  const layer = createEarthEngineLayer({
    record: RIVERS,
    source,
    storage: memoryStorage({ 'gev.rivers.mode': 'network' }),
  });
  layer.init(viewer);
  layer.attachMapStackController({
    getImageryHostTileset: () => (host === 'tileset' ? tileset : null),
    getActiveLuminance: () => 'dark',
    subscribe: () => () => {},
  });
  layer.enable(viewer);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return {
    layer,
    layers: host === 'tileset' ? tilesetLayers : globeLayers,
    state,
  };
}

test('on a 3D tileset and on the globe the Rivers ask for every level through the zoom variant, so no primitive needs more than Cesium’s 10 draped textures', async (t) => {
  for (const host of ['tileset', 'globe']) {
    const { layer, layers } = await hostedRivers(t, { host });
    assert.equal(layers.length, 1, host);
    const provider = layers[0].imageryProvider;
    assert.match(provider.url, /\/ee-rivers\/network\/zoom\/light\//, host);
    assert.equal(provider.minimumLevel, 0, host);
    assert.equal(provider.maximumLevel, 11, host);
    // The row still names the band of the height (and canvas).
    assert.match(layer.getRowControls().info, /Rivers of flow orders 1 to 3/);
    layer.disable();
  }
});

test('with a server that has no zoom variant, the bands keep their first level on the globe and drop it on a 3D tileset', async (t) => {
  const { body } = await riversCatalog(t);
  const old = structuredClone(body);
  old.layers[0].variants = old.layers[0].variants.filter(
    (variant) => variant.key !== 'zoom',
  );
  const globe = await hostedRivers(t, { host: 'globe', catalog: old });
  assert.match(globe.layers[0].imageryProvider.url, /\/network\/o3\/light\//);
  assert.equal(globe.layers[0].imageryProvider.minimumLevel, 2);
  globe.layer.disable();
  const tileset = await hostedRivers(t, { host: 'tileset', catalog: old });
  assert.match(tileset.layers[0].imageryProvider.url, /\/network\/o3\/light\//);
  assert.equal(
    tileset.layers[0].imageryProvider.minimumLevel,
    0,
    'Cesium’s own level per primitive on a tileset',
  );
  tileset.layer.disable();
});

test('the band follows the zoom this canvas drapes: a 720 px pane at 4,500 km is a 1,600 px canvas at 10,000 km', async (t) => {
  assert.equal(riverHeightForCanvas(4_500_000, 720, 507), 10_000_000);
  assert.equal(riverHeightForCanvas(4_500_000, 1600, 900), 4_500_000);
  assert.equal(
    riverHeightForCanvas(4_500_000, 600, 900),
    8_000_000,
    'portrait: the taller side',
  );
  assert.equal(riverHeightForCanvas(4_500_000, 0, 0), 4_500_000, 'no canvas');
  // 720 px: orders 1 to 3 at 4,500 km (Cesium drapes z 4 there, v2's ≤ 3).
  const small = await hostedRivers(t, { width: 720, height: 507 });
  assert.match(
    small.layer.getRowControls().info,
    /Rivers of flow orders 1 to 3/,
  );
  small.layer.disable();
  // 1,600 px: orders 1 to 4 (z 5).
  const wide = await hostedRivers(t, { width: 1600, height: 900 });
  assert.match(
    wide.layer.getRowControls().info,
    /Rivers of flow orders 1 to 4/,
  );
  wide.layer.disable();
  assert.equal(
    riverZoomForHeight(riverHeightForCanvas(4_500_000, 720, 507)),
    4,
  );
  assert.equal(bandForZoom(4).maxOrder, 3);
});

test('a click asks for the orders drawn on this canvas', () => {
  let maxOrder = null;
  const clicks = createRiverClicks({
    attachHighlight: () => ({ detach() {} }),
    attachClicks: (options) => {
      maxOrder = options.maxOrder;
      return () => {};
    },
  });
  clicks.enable({ scene: { canvas: { clientWidth: 720, clientHeight: 507 } } });
  assert.equal(maxOrder(4_500_000), 3, '720 px pane');
  clicks.disable();
  clicks.enable({
    scene: { canvas: { clientWidth: 1600, clientHeight: 900 } },
  });
  assert.equal(maxOrder(4_500_000), 4, '1,600 px canvas');
  clicks.disable();
});
