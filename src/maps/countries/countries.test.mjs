// Personal fork: the Countries basemap — its records and wiring, the pack
// geometry, the palette hook, the tiles it paints (on a recording canvas),
// and the renderer's imagery layer on a fake viewer. No network: the geometry comes from the
// committed fixture (src/data/fixtures/countries-basemap.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../catalog.js';
import { createDefaultMapSources } from '../defaultSources.js';
import { MapSourceController } from '../controller.js';
import { CABLE_GLOBE_STACK_IDS } from '../../layers/submarineCables/policy.js';
import { VIEW_MAPS } from '../../view/index.js';
import {
  COUNTRIES_BASEMAPS,
  COUNTRIES_BASEMAP_IDS,
  SUBDIVISIONS_MAX_HEIGHT_M,
  countriesBasemapRecord,
} from './catalog.js';
import {
  decodePack,
  featureAt,
  featureContains,
  featuresInRectangle,
  partsInRectangle,
  pointInRing,
} from './geometry.js';
import { latLngToCell } from 'h3-js';
import {
  COUNTRY_FILL_OVERRIDES,
  COUNTRY_THEMES,
  fillFor,
  onCountryFillChange,
  setCountryFill,
  setCountryFills,
} from './palette.js';
import {
  NATURAL_EARTH_CREDIT,
  OPACITY_STORAGE_KEY,
  readOpacity,
} from './renderer.js';
import {
  LEVEL0_HEIGHT_M,
  MIN_HEX_PX,
  TILE_SIZE,
  createHexLand,
  hexResolutionForLevel,
  levelHeightM,
  paintCountriesTile,
  paintHexTile,
  seamEdge,
  subdivisionsAtLevel,
  withAlpha,
} from './tiles.js';
import { attachCountriesBasemap, countriesBasemapSource } from './index.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../data/fixtures/countries-basemap.json', import.meta.url),
    'utf8',
  ),
);
const EXPECTED_IDS = [
  'countries-simple-dark',
  'countries-simple-light',
  'countries-subdivisions-dark',
  'countries-subdivisions-light',
  'countries-hex-dark',
  'countries-hex-light',
];
const REYKJAVIK = [-21.9, 64.1];
const MASERU = [27.5, -29.3];
const PRETORIA = [28.2, -25.7];

test('six styles follow the keyless records in MAP_STACKS, and every id list knows them', () => {
  assert.deepEqual(COUNTRIES_BASEMAP_IDS, EXPECTED_IDS);
  assert.deepEqual(
    MAP_STACKS.slice(-6).map((stack) => stack.id),
    EXPECTED_IDS,
  );
  for (const record of COUNTRIES_BASEMAPS) {
    const descriptor = MAP_STACKS.find((stack) => stack.id === record.id);
    assert.equal(descriptor.kind, 'countries-basemap');
    assert.equal(descriptor.group, 'countries');
    assert.equal(descriptor.note, record.note);
    assert.ok(['simple', 'subdivisions', 'hex'].includes(record.style));
    assert.ok(['dark', 'light'].includes(record.theme));
    assert.ok(CABLE_GLOBE_STACK_IDS.has(record.id), `cables: ${record.id}`);
    assert.ok(VIEW_MAPS.includes(record.id), `share links: ${record.id}`);
    assert.equal(countriesBasemapRecord(record.id), record);
  }
  assert.equal(countriesBasemapRecord('osm'), null);
  assert.equal(SUBDIVISIONS_MAX_HEIGHT_M, 5_000_000);
});

test('the fixture decodes: four countries, the Lesotho hole, nineteen first-level units', () => {
  const countries = decodePack(fixture.countries);
  assert.deepEqual(
    countries.map((feature) => feature.name),
    ['Iceland', 'Lesotho', 'South Africa', 'Switzerland'],
  );
  const southAfrica = countries[2];
  assert.equal(southAfrica.iso2, 'ZA');
  assert.equal(
    southAfrica.polygons.filter((polygon) => polygon.holes.length).length,
    1,
    'the mainland carries Lesotho as a hole',
  );
  assert.equal(featureAt(countries, ...REYKJAVIK).name, 'Iceland');
  assert.equal(featureAt(countries, ...MASERU).name, 'Lesotho');
  assert.equal(featureAt(countries, ...PRETORIA).name, 'South Africa');
  assert.equal(featureContains(southAfrica, ...MASERU), false, 'the hole');
  assert.equal(featureAt(countries, 0, 0), null, 'the sea');
  assert.ok(countries[0].box.west < -24 && countries[0].box.north > 66);

  const units = decodePack(fixture.admin1);
  assert.equal(units.length, 19);
  const aroundIceland = { west: -26, south: 62, east: -12, north: 68 };
  const parts = partsInRectangle(units, aroundIceland);
  assert.ok(parts.length >= 9);
  assert.ok(parts.every(({ feature }) => feature.country === 'Iceland'));
  assert.equal(
    featuresInRectangle(units, { west: 170, south: -40, east: -170, north: 40 })
      .length,
    0,
    'a rectangle across the antimeridian is tested as two halves',
  );
  assert.equal(
    featuresInRectangle(countries, {
      west: 20,
      south: -40,
      east: -150,
      north: 0,
    }).length,
    2,
    'Lesotho and South Africa fall in the eastern half',
  );
});

test('the palette: one fill for simple maps, a stable varied fill for hexes, and overrides that win', () => {
  const countries = decodePack(fixture.countries);
  const [iceland, lesotho] = countries;
  COUNTRY_FILL_OVERRIDES.clear();
  assert.equal(
    fillFor(iceland, { theme: 'dark', style: 'simple' }),
    COUNTRY_THEMES.dark.fill,
  );
  assert.equal(
    fillFor(lesotho, { theme: 'light', style: 'subdivisions' }),
    COUNTRY_THEMES.light.fill,
  );
  const hex = fillFor(iceland, { theme: 'dark', style: 'hex' });
  assert.ok(COUNTRY_THEMES.dark.varied.includes(hex));
  assert.equal(fillFor(iceland, { theme: 'dark', style: 'hex' }), hex);
  const heard = [];
  const off = onCountryFillChange((iso2) => heard.push(iso2));
  setCountryFill('is', '#ff0000');
  assert.equal(fillFor(iceland, { theme: 'dark', style: 'simple' }), '#ff0000');
  assert.equal(fillFor(iceland, { theme: 'light', style: 'hex' }), '#ff0000');
  assert.equal(
    fillFor(lesotho, { theme: 'dark', style: 'simple' }),
    COUNTRY_THEMES.dark.fill,
  );
  setCountryFill('is', null);
  assert.equal(
    fillFor(iceland, { theme: 'dark', style: 'simple' }),
    COUNTRY_THEMES.dark.fill,
  );
  setCountryFills({ ls: '#00ff00' });
  assert.equal(fillFor(lesotho, { theme: 'dark', style: 'simple' }), '#00ff00');
  assert.deepEqual(heard, ['IS', 'IS', null]);
  off();
  setCountryFills({});
  assert.deepEqual(heard, ['IS', 'IS', null], 'unsubscribed');
  assert.equal(COUNTRY_FILL_OVERRIDES.size, 0);
});

test('the registry entries: no controller imagery, a painted ocean, flat terrain, a Natural Earth credit', async () => {
  const registry = createDefaultMapSources();
  for (const record of COUNTRIES_BASEMAPS) {
    const source = registry.sources.find((s) => s.descriptor.id === record.id);
    assert.ok(source, record.id);
    assert.equal(source.available, true);
    assert.equal(await source.imagery(), null, 'no imagery layer');
    assert.ok(
      Cesium.Color.equals(
        source.globeBaseColor,
        Cesium.Color.fromCssColorString(COUNTRY_THEMES[record.theme].ocean),
      ),
    );
    assert.equal(source.terrain.id, 'flat');
    const { provider } = await source.terrain.create();
    assert.ok(provider instanceof Cesium.EllipsoidTerrainProvider);
    assert.equal(source.credit, NATURAL_EARTH_CREDIT);
    assert.match(source.credit, /Natural Earth/);
    assert.equal(source.constructionFallback, undefined);
  }
  assert.throws(
    () => countriesBasemapSource({ id: 'osm', kind: 'countries-basemap' }),
    /Unknown countries basemap/,
  );
  assert.doesNotThrow(() =>
    new MapSourceController(
      {
        scene: { globe: {}, primitives: { add() {}, remove() {} } },
        imageryLayers: { add() {}, remove() {} },
      },
      { registry },
    ).destroy(),
  );
});

test('opacity is read from storage and clamped', () => {
  assert.equal(readOpacity({ getItem: () => '0.4' }), 0.4);
  assert.equal(readOpacity({ getItem: () => '7' }), 1);
  assert.equal(readOpacity({ getItem: () => 'abc' }), 1);
  assert.equal(readOpacity({ getItem: () => null }), 1);
  assert.equal(readOpacity(null), 1);
});

/** A context that records each subpath (in tile pixels) and what was filled or stroked. */
function recordingContext() {
  const ctx = {
    subpaths: [],
    fills: [],
    strokes: [],
    current: [],
    path: [],
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    lineJoin: 'miter',
    beginPath() {
      this.path = [];
      this.current = [];
    },
    moveTo(x, y) {
      // An open subpath (an outline broken at a seam) ends here.
      if (this.current.length > 1) this.path.push(this.current);
      this.current = [[x, y]];
    },
    lineTo(x, y) {
      this.current.push([x, y]);
    },
    closePath() {
      this.path.push(this.current);
      this.subpaths.push(this.current);
      this.current = [];
    },
    fill(rule) {
      this.fills.push({ style: this.fillStyle, rule, rings: [...this.path] });
    },
    stroke() {
      if (this.current.length > 1) this.path.push(this.current);
      this.current = [];
      this.strokes.push({
        style: this.strokeStyle,
        width: this.lineWidth,
        rings: [...this.path],
      });
    },
  };
  return ctx;
}

function recordingCanvas(width, height) {
  const context = recordingContext();
  return { width, height, context, getContext: () => context };
}

const toDegrees = (radians) => (radians * 180) / Math.PI;
/** A tile's rectangle in degrees (geographic tiling). */
function tileRect(x, y, level) {
  const r = new Cesium.GeographicTilingScheme().tileXYToRectangle(x, y, level);
  return {
    west: toDegrees(r.west),
    south: toDegrees(r.south),
    east: toDegrees(r.east),
    north: toDegrees(r.north),
  };
}
/** A lon/lat point in a tile's pixels. */
function pixelOf(rect, lon, lat) {
  return [
    ((lon - rect.west) / (rect.east - rect.west)) * TILE_SIZE,
    ((rect.north - lat) / (rect.north - rect.south)) * TILE_SIZE,
  ];
}
const filledAt = (fill, [x, y]) =>
  fill.rings.filter((ring) => pointInRing(ring, x, y)).length % 2 === 1;

const realPack = (name) =>
  decodePack(
    JSON.parse(
      readFileSync(
        new URL(`../../data/local_data/natural_earth/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  );

test('the level a tile stands for: subdivisions from level 4, hex resolutions by level', () => {
  assert.equal(levelHeightM(0), LEVEL0_HEIGHT_M);
  assert.equal(subdivisionsAtLevel(3), false, '6,850 km: above the ceiling');
  assert.equal(subdivisionsAtLevel(4), true, '3,425 km: below it');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map(hexResolutionForLevel),
    [0, 0, 1, 2, 3, 3, 4, 5, 6, 6, 7, 7],
  );
  assert.equal(withAlpha('#2f3a47', 0.5), 'rgba(47, 58, 71, 0.5)');
});

test('a tile over France at level 3: the country filled in the theme colour, outlined, Paris inside', () => {
  const features = realPack('countries.json');
  const rect = tileRect(8, 1, 3); // 0–22.5° E, 45–67.5° N
  assert.deepEqual(rect, { west: 0, south: 45, east: 22.5, north: 67.5 });
  const context = recordingContext();
  const painted = paintCountriesTile(context, {
    features,
    rect,
    level: 3,
    theme: 'dark',
    style: 'simple',
    opacity: 1,
  });
  assert.ok(painted > 10, `${painted} parts`);
  assert.equal(context.fills.length, 1, 'one fill for the one colour');
  const [fill] = context.fills;
  assert.equal(fill.rule, 'evenodd');
  assert.equal(fill.style, withAlpha(COUNTRY_THEMES.dark.fill, 1));
  assert.ok(filledAt(fill, pixelOf(rect, 2.35, 48.86)), 'Paris is land');
  assert.ok(!filledAt(fill, pixelOf(rect, 3, 54.5)), 'the North Sea is not');
  assert.equal(context.strokes.length, 1, 'the outlines, over the fills');
  assert.equal(context.strokes[0].style, COUNTRY_THEMES.dark.outline);
  assert.equal(context.strokes[0].width, COUNTRY_THEMES.dark.outlineWidth);
  // Simple: no first-level units, even this deep.
  const units = realPack('states_provinces.json');
  const deeper = recordingContext();
  paintCountriesTile(deeper, {
    features,
    units,
    rect: tileRect(32, 6, 5),
    level: 5,
    theme: 'light',
    style: 'simple',
    opacity: 0.4,
  });
  assert.equal(deeper.strokes.length, 1);
  assert.equal(
    deeper.fills[0].style,
    withAlpha(COUNTRY_THEMES.light.fill, 0.4),
  );
});

test('Fiji across the antimeridian: each side painted on its own tile, nothing smeared across', () => {
  const features = realPack('countries.json');
  for (const [x, y] of [
    [15, 4],
    [0, 4],
  ]) {
    const rect = tileRect(x, y, 3); // 157.5–180° E or 180–157.5° W, 0–22.5° S
    const context = recordingContext();
    assert.ok(
      paintCountriesTile(context, {
        features,
        rect,
        level: 3,
        theme: 'dark',
        style: 'simple',
        opacity: 1,
      }) > 0,
    );
    const fiji = pixelOf(rect, x === 15 ? 178.4 : -179.9, -17.8);
    assert.ok(
      context.fills.some((fill) => filledAt(fill, fiji)) ||
        context.subpaths.some(
          (ring) =>
            ring.some(([px]) => Math.abs(px - fiji[0]) < 3) &&
            ring.some(([, py]) => Math.abs(py - fiji[1]) < 12),
        ),
      `Fiji on tile ${x}`,
    );
    for (const ring of context.subpaths) {
      const xs = ring.map(([px]) => px);
      assert.ok(
        Math.max(...xs) - Math.min(...xs) < TILE_SIZE * 0.9,
        'no ring runs across the tile',
      );
    }
  }
  // The cuts Natural Earth makes at ±180° and along the pole are no border.
  assert.equal(seamEdge([180, 66], [180, 64]), true);
  assert.equal(seamEdge([-180, -89], [-180, -90]), true);
  assert.equal(seamEdge([-170, -90], [170, -90]), true);
  assert.equal(seamEdge([179, 66], [180, 64]), false);
  const russia = features.find((f) => f.iso2 === 'RU');
  const chukotka = tileRect(0, 1, 3); // 180–157.5° W, 45–67.5° N
  const russiaOnly = recordingContext();
  paintCountriesTile(russiaOnly, {
    features: [russia],
    rect: chukotka,
    level: 3,
    theme: 'dark',
    style: 'simple',
    opacity: 1,
  });
  const pieces = russiaOnly.strokes[0].rings;
  assert.ok(pieces.flat().length > 20, 'Chukotka is outlined');
  for (const piece of pieces)
    for (let i = 1; i < piece.length; i++) {
      const [ax, ay] = piece[i - 1];
      const [bx, by] = piece[i];
      assert.ok(
        !(ax < 0.5 && bx < 0.5 && Math.abs(ay - by) > 2),
        'no outline runs down the antimeridian',
      );
    }
  // Antarctica reaches the south pole on the bottom row.
  const pole = recordingContext();
  paintCountriesTile(pole, {
    features,
    rect: tileRect(0, 1, 1),
    level: 1,
    theme: 'dark',
    style: 'simple',
    opacity: 1,
  });
  assert.ok(filledAt(pole.fills[0], pixelOf(tileRect(0, 1, 1), -135, -89)));
});

test("Iceland's hex at level 0, by the cell of a point inside it; a cell fill wins; a hex across ±180 lands on both tiles", () => {
  const countries = decodePack(fixture.countries);
  const land = createHexLand(countries);
  const rect = tileRect(0, 0, 0); // the western hemisphere
  const context = recordingContext();
  const iceland = latLngToCell(64.9, -18.5, 0);
  const cells = paintHexTile(context, {
    land,
    rect,
    level: 0,
    theme: 'light',
    opacity: 1,
    cellFills: new Map([[iceland, '#abcdef']]),
  });
  assert.ok(cells >= 1, `${cells} cells`);
  const reykjavik = pixelOf(rect, ...REYKJAVIK);
  const hit = context.fills.find((fill) => filledAt(fill, reykjavik));
  assert.ok(hit, 'Reykjavík lies in a painted hex');
  assert.equal(hit.style, withAlpha('#abcdef', 1), 'the cell fill wins');
  assert.equal(context.strokes[0].style, COUNTRY_THEMES.light.hexOutline);
  assert.equal(land.extrasAt(0).get(iceland)?.name, 'Iceland');
  // Resolution 3 on a level 0 tile: hexes of 2 px. The countries are
  // painted in their hex colours instead, without the hex outlines.
  const coarse = recordingContext();
  assert.ok(
    paintHexTile(coarse, {
      land,
      rect,
      level: 0,
      res: 3,
      theme: 'light',
      opacity: 1,
    }) > 0,
  );
  assert.equal(coarse.strokes.length, 0);
  const icelandFill = coarse.fills.find((fill) => filledAt(fill, reykjavik));
  assert.equal(
    icelandFill.style,
    withAlpha(fillFor(countries[0], { theme: 'light', style: 'hex' }), 1),
  );
  assert.ok(MIN_HEX_PX >= 4);

  // A real-pack cell on the antimeridian (Fiji's, resolution 2) lands on both sides.
  const features = realPack('countries.json');
  const fijiLand = createHexLand(features);
  const sides = [tileRect(15, 4, 3), tileRect(0, 4, 3)].map((r) => {
    const c = recordingContext();
    paintHexTile(c, {
      land: fijiLand,
      rect: r,
      level: 3,
      theme: 'dark',
      opacity: 1,
    });
    return c.subpaths.length;
  });
  assert.ok(
    sides.every((n) => n > 0),
    `cells on each side: ${sides}`,
  );
});

/** A Cesium stand-in: the real tiling scheme and events, a layer that keeps its provider. */
function fakeCesium() {
  class ImageryLayer {
    constructor(provider) {
      this.imageryProvider = provider;
    }
  }
  return {
    ...Cesium,
    ImageryLayer,
    Color: Cesium.Color,
    GeographicTilingScheme: Cesium.GeographicTilingScheme,
    Event: Cesium.Event,
  };
}

function fakeViewer() {
  const list = [];
  const removed = [];
  const imageryLayers = {
    add(layer, index) {
      if (index === undefined || index >= list.length) list.push(layer);
      else list.splice(Math.max(0, index), 0, layer);
    },
    remove(layer) {
      const at = list.indexOf(layer);
      if (at >= 0) list.splice(at, 1);
      removed.push(layer);
      return at >= 0;
    },
    indexOf: (layer) => list.indexOf(layer),
    get: (i) => list[i],
    get length() {
      return list.length;
    },
  };
  return { viewer: { imageryLayers, scene: {} }, list, removed };
}

function fakeController() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(activeId) {
      for (const fn of [...listeners]) fn({ activeId, status: 'ready' });
    },
    get size() {
      return listeners.size;
    },
  };
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

function attach({ storage = fakeStorage(), loads = [], loadPack } = {}) {
  const env = fakeViewer();
  const controller = fakeController();
  const renders = [];
  const basemap = attachCountriesBasemap(controller, env.viewer, {
    cesium: fakeCesium(),
    loadPack:
      loadPack ||
      (async (name) => {
        loads.push(name);
        return fixture[name];
      }),
    storage,
    createCanvas: recordingCanvas,
    requestRender: (reason) => renders.push(reason),
  });
  return { ...env, controller, basemap, renders, storage, loads };
}

const providerOf = (layer) => layer.imageryProvider;
/** Paint a tile of the layer's provider on a recording canvas. */
async function tile(layer, x, y, level) {
  const canvas = await providerOf(layer).requestImage(x, y, level);
  return canvas.context || null;
}

test('a countries style is one imagery layer at the bottom: overlays before and after it lie over it', async () => {
  const env = attach();
  const { controller, basemap, list, loads } = env;
  const before = { name: 'world history (added first)' };
  env.viewer.imageryLayers.add(before);
  assert.equal(list.length, 1, 'nothing until a countries style settles');

  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.deepEqual(loads, ['countries'], 'the admin-1 pack is not loaded');
  const layer = basemap.renderer.getLayer();
  assert.equal(list[0], layer, 'the basemap slot: index 0');
  assert.equal(list[1], before);
  const after = { name: 'rivers (added later)' };
  env.viewer.imageryLayers.add(after);
  assert.deepEqual(list, [layer, before, after]);
  const state = basemap.getState();
  assert.equal(state.activeId, 'countries-simple-dark');
  assert.equal(state.layer, true);
  assert.equal(state.layerIndex, 0);
  assert.ok(env.renders.includes('countries-basemap'));

  const provider = providerOf(layer);
  assert.ok(provider.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.hasAlphaChannel, true, 'the ocean shows through');
  // The southern-hemisphere tile holds Lesotho as South Africa's hole.
  const south = await tile(layer, 2, 1, 1);
  const rect = tileRect(2, 1, 1);
  assert.ok(filledAt(south.fills[0], pixelOf(rect, ...PRETORIA)));
  assert.ok(
    filledAt(south.fills[0], pixelOf(rect, ...MASERU)),
    "Lesotho is land too: South Africa's hole, filled as its own country",
  );
  // An empty tile is a 1 × 1 blank.
  const blank = await providerOf(layer).requestImage(0, 1, 1);
  assert.equal(blank.width, 1);

  // The same style again: the layer stays.
  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.equal(basemap.renderer.getLayer(), layer);

  // Another stack: the layer goes, the overlays stay.
  controller.emit('osm');
  await basemap.settled();
  assert.deepEqual(list, [before, after]);
  assert.equal(basemap.getState().layer, false);

  basemap.destroy();
  assert.equal(controller.size, 0, 'unsubscribed from the controller');
  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.deepEqual(list, [before, after], 'a destroyed renderer draws nothing');
});

test('a theme, opacity, country colour or cell colour change swaps in a fresh layer at the same index', async () => {
  const env = attach();
  const { controller, basemap, list } = env;
  controller.emit('countries-simple-dark');
  await basemap.settled();
  const overlay = { name: 'overlay' };
  env.viewer.imageryLayers.add(overlay);
  const first = basemap.renderer.getLayer();

  controller.emit('countries-simple-light');
  await basemap.settled();
  const light = basemap.renderer.getLayer();
  assert.notEqual(light, first);
  assert.deepEqual(
    list,
    [light, overlay],
    'the old layer removed, the new one at 0',
  );
  const rect = tileRect(1, 0, 0);
  let painted = await tile(light, 1, 0, 0);
  assert.equal(painted.fills[0].style, withAlpha(COUNTRY_THEMES.light.fill, 1));

  basemap.setOpacity(0.5);
  await basemap.settled();
  assert.equal(env.storage.map.get(OPACITY_STORAGE_KEY), '0.5');
  assert.equal(basemap.getOpacity(), 0.5);
  const half = basemap.renderer.getLayer();
  assert.notEqual(half, light);
  assert.equal(list[0], half);
  painted = await tile(half, 1, 0, 0);
  assert.equal(
    painted.fills[0].style,
    withAlpha(COUNTRY_THEMES.light.fill, 0.5),
  );
  assert.equal(
    painted.strokes[0].style,
    COUNTRY_THEMES.light.outline,
    'outlines stay solid',
  );

  basemap.setCountryFill('CH', '#123456');
  await basemap.settled();
  painted = await tile(basemap.renderer.getLayer(), 1, 0, 0);
  const swiss = painted.fills.find(
    (fill) => fill.style === withAlpha('#123456', 0.5),
  );
  assert.ok(
    swiss && filledAt(swiss, pixelOf(rect, 8.2, 46.8)),
    'Switzerland repainted',
  );
  basemap.setCountryFill('CH', null);
  await basemap.settled();

  controller.emit('countries-hex-light');
  await basemap.settled();
  const hex = basemap.renderer.getLayer();
  const cell = latLngToCell(64.9, -18.5, 0);
  basemap.setCellFills({ [cell.toUpperCase()]: '#abcdef' });
  await basemap.settled();
  assert.notEqual(basemap.renderer.getLayer(), hex);
  painted = await tile(basemap.renderer.getLayer(), 0, 0, 0);
  assert.ok(
    painted.fills.some((fill) => fill.style === withAlpha('#abcdef', 0.5)),
  );
  assert.equal(list.length, 2, 'never two countries layers');
  basemap.destroy();
  assert.deepEqual(list, [overlay]);
});

test('the stored opacity is read at attach time', async () => {
  const storage = fakeStorage();
  storage.setItem(OPACITY_STORAGE_KEY, '0.25');
  const env = attach({ storage });
  assert.equal(env.basemap.getOpacity(), 0.25);
  env.controller.emit('countries-simple-dark');
  await env.basemap.settled();
  const painted = await tile(env.basemap.renderer.getLayer(), 1, 0, 0);
  assert.equal(
    painted.fills[0].style,
    withAlpha(COUNTRY_THEMES.dark.fill, 0.25),
  );
  env.basemap.destroy();
});

test('subdivisions: first-level units on tiles from level 4, none coarser', async () => {
  const env = attach();
  const { controller, basemap, loads } = env;
  controller.emit('countries-subdivisions-dark');
  await basemap.settled();
  assert.deepEqual(loads, ['countries', 'admin1']);
  const layer = basemap.renderer.getLayer();
  const admin1Strokes = (context) =>
    context.strokes.filter(
      (s) => s.style === COUNTRY_THEMES.dark.admin1Outline,
    );
  // Iceland at level 3 (6,850 km): countries only.
  let painted = await tile(layer, 7, 1, 3);
  assert.equal(admin1Strokes(painted).length, 0);
  assert.equal(painted.strokes.at(-1).style, COUNTRY_THEMES.dark.outline);
  // Level 4: Iceland's units, under the country outline.
  painted = await tile(layer, 14, 2, 4);
  const units = admin1Strokes(painted);
  assert.equal(units.length, 1);
  assert.ok(units[0].rings.length >= 9, `${units[0].rings.length} unit rings`);
  assert.equal(units[0].width, COUNTRY_THEMES.dark.admin1OutlineWidth);
  assert.equal(
    painted.strokes.at(-1).style,
    COUNTRY_THEMES.dark.outline,
    'countries on top',
  );
  basemap.destroy();
});

test('a pack that fails to load is retried on the next activation, and a late load cannot draw a left stack', async () => {
  let fail = true;
  const loads = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const env = attach({
      loadPack: async (name) => {
        loads.push(name);
        if (fail) throw new Error('offline');
        return fixture[name];
      },
    });
    env.controller.emit('countries-simple-dark');
    await env.basemap.settled();
    assert.equal(env.list.length, 0);
    assert.match(warnings.join('\n'), /could not draw/);
    fail = false;
    env.controller.emit('countries-simple-light');
    await env.basemap.settled();
    assert.deepEqual(loads, ['countries', 'countries']);
    assert.equal(env.list.length, 1);

    // Leave while a slow build is pending: nothing lands afterwards.
    let release;
    const slow = attach({
      loadPack: () =>
        new Promise((resolve) => (release = () => resolve(fixture.countries))),
    });
    slow.basemap.renderer.show(countriesBasemapRecord('countries-simple-dark'));
    slow.basemap.renderer.hide();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    release();
    await slow.basemap.settled();
    assert.equal(slow.basemap.getState().activeId, null);
    assert.equal(slow.list.length, 0);
    // A style switch while a build is pending: the last style wins, once.
    const quick = attach();
    quick.controller.emit('countries-simple-dark');
    quick.controller.emit('countries-hex-dark');
    await quick.basemap.settled();
    assert.equal(quick.list.length, 1);
    assert.equal(providerOf(quick.list[0]).record.style, 'hex');
    quick.basemap.destroy();
    slow.basemap.destroy();
    env.basemap.destroy();
  } finally {
    console.warn = originalWarn;
  }
});

test('the hex style paints one resolution on every tile, the camera height’s, and repaints when a move changes it', async () => {
  const env = attach();
  const moves = new Set();
  env.viewer.camera = {
    positionCartographic: { longitude: 0, latitude: 0, height: 2.2e7 },
    moveEnd: {
      addEventListener(fn) {
        moves.add(fn);
        return () => moves.delete(fn);
      },
    },
  };
  const moveTo = (height) => {
    env.viewer.camera.positionCartographic = {
      longitude: 0,
      latitude: 0,
      height,
    };
    for (const fn of [...moves]) fn();
  };
  env.controller.emit('countries-hex-dark');
  await env.basemap.settled();
  assert.equal(env.basemap.getState().hexRes, 0, 'orbit: resolution 0');
  const orbit = env.basemap.renderer.getLayer();
  // Level 3 and level 0 tiles alike paint resolution 0 cells: Iceland's
  // cell is eight times as many pixels across on the level 3 tile.
  const icelandRing = async (x, y, level) => {
    const context = await tile(orbit, x, y, level);
    const at = pixelOf(tileRect(x, y, level), ...REYKJAVIK);
    const ring = context.subpaths.find((r) => pointInRing(r, ...at));
    const xs = ring.map(([px]) => px);
    return Math.max(...xs) - Math.min(...xs);
  };
  const ratio = (await icelandRing(7, 1, 3)) / (await icelandRing(0, 0, 0));
  assert.ok(Math.abs(ratio - 8) < 0.5, `${ratio.toFixed(2)} times`);
  moveTo(1.8e7); // still resolution 0
  await env.basemap.settled();
  assert.equal(env.basemap.renderer.getLayer(), orbit, 'no repaint');
  moveTo(8e6); // resolution 2
  await env.basemap.settled();
  assert.equal(env.basemap.getState().hexRes, 2);
  assert.notEqual(env.basemap.renderer.getLayer(), orbit);
  assert.equal(env.list.length, 1);
  env.controller.emit('osm');
  await env.basemap.settled();
  assert.equal(moves.size, 0, 'the camera listener is released');
  env.basemap.destroy();
});
