// Personal fork: the Countries basemap — its records and wiring, the pack
// geometry, the equal-area hex grid, the palette hook, and the renderer's
// lifecycle on a fake viewer. No network: the geometry comes from the
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
} from './geometry.js';
import {
  EARTH_RADIUS_KM,
  azimuthalEqualArea,
  cylindricalEqualArea,
  hexAreaKm2,
  hexCells,
  hexCellsForView,
  hexTierForHeight,
  localGridStale,
} from './hexGrid.js';
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
  viewRectangleDegrees,
} from './renderer.js';
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

/** Spherical ring area, km² (the packs' own formula). */
function ringAreaKm2(ring) {
  const toRad = (d) => (d * Math.PI) / 180;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

test('the hex lattice is equal-area on both projections and tiles its bounds', () => {
  const cylindrical = cylindricalEqualArea();
  for (const [lon, lat] of [
    [0, 0],
    [100, 45],
    [-170, -60],
    [30, 80],
  ]) {
    const [x, y] = cylindrical.forward(lon, lat);
    const back = cylindrical.inverse(x, y);
    assert.ok(Math.abs(back[0] - lon) < 1e-9 && Math.abs(back[1] - lat) < 1e-9);
  }
  const azimuthal = azimuthalEqualArea(-20, 64);
  for (const [lon, lat] of [
    [-20, 64],
    [-15, 60],
    [-30, 70],
    [10, 50],
  ]) {
    const [x, y] = azimuthal.forward(lon, lat);
    const back = azimuthal.inverse(x, y);
    assert.ok(
      Math.abs(back[0] - lon) < 1e-7 && Math.abs(back[1] - lat) < 1e-7,
      `round trip ${lon},${lat}`,
    );
  }
  assert.deepEqual(azimuthal.inverse(0, 0), [-20, 64]);

  // Cells tile the bounds: about area / cell area of them, six corners each.
  const bounds = { xmin: -1000, xmax: 1000, ymin: -800, ymax: 800 };
  const cells = hexCells({ projection: azimuthal, bounds, sizeKm: 50 });
  const expected = (2000 * 1600) / hexAreaKm2(50);
  assert.ok(
    Math.abs(cells.length - expected) / expected < 0.15,
    `${cells.length} cells for ${expected.toFixed(0)} expected`,
  );
  assert.ok(cells.every((cell) => cell.ring.length === 6));
  assert.equal(new Set(cells.map((cell) => cell.key)).size, cells.length);
  // Each cell's ground area is the lattice's: equal area, within 2%.
  for (const cell of cells.slice(0, 50)) {
    const area = ringAreaKm2(cell.ring);
    assert.ok(
      Math.abs(area - hexAreaKm2(50)) / hexAreaKm2(50) < 0.02,
      `cell ${cell.key} covers ${area.toFixed(0)} km²`,
    );
  }
  // The planet-wide lattice, stretched towards the poles, stays equal-area.
  const global = hexCells({
    projection: cylindrical,
    bounds: { xmin: -500, xmax: 500, ymin: 5500, ymax: 6000 },
    sizeKm: 100,
  });
  assert.ok(global.length > 10);
  for (const cell of global) {
    const area = ringAreaKm2(cell.ring);
    assert.ok(
      Math.abs(area - hexAreaKm2(100)) / hexAreaKm2(100) < 0.05,
      `polar cell ${cell.key} covers ${area.toFixed(0)} km²`,
    );
  }
  // The lattice cannot run away: cells are capped.
  assert.equal(
    hexCells({ projection: azimuthal, bounds, sizeKm: 5, maxCells: 100 })
      .length,
    100,
  );

  assert.equal(hexTierForHeight(1e7).scope, 'global');
  assert.equal(hexTierForHeight(Infinity).sizeKm, 150);
  assert.deepEqual(hexTierForHeight(3e6), {
    minHeightM: 1_500_000,
    sizeKm: 60,
    scope: 'local',
  });
  assert.equal(hexTierForHeight(1e5).sizeKm, 25);
});

test('the view grid keeps only land cells, carries their country, and coarsens past the budget', () => {
  const countries = decodePack(fixture.countries);
  const landAt = (lon, lat) => featureAt(countries, lon, lat);
  const overIceland = { lon: -19, lat: 65, heightM: 3e6 };
  const local = hexCellsForView(overIceland, landAt);
  assert.equal(local.scope, 'local');
  assert.equal(local.sizeKm, 60);
  assert.ok(local.cells.length > 5, `${local.cells.length} land cells`);
  // The 10,000 km square around Iceland reaches Switzerland, not Lesotho.
  assert.ok(
    local.cells.every((cell) =>
      ['Iceland', 'Switzerland'].includes(cell.feature.name),
    ),
  );
  assert.ok(local.cells.some((cell) => cell.feature.name === 'Iceland'));
  assert.ok(
    local.cells.every((cell) => featureContains(cell.feature, ...cell.centre)),
  );
  assert.deepEqual(local.made, {
    lon: -19,
    lat: 65,
    heightM: 3e6,
    halfSideKm: 5000,
  });
  // The same grid serves a small move; a far move or a tier change does not.
  assert.equal(
    localGridStale(local.made, { lon: -18, lat: 64, heightM: 3e6 }),
    false,
  );
  assert.equal(
    localGridStale(local.made, { lon: 28, lat: -29, heightM: 3e6 }),
    true,
  );
  assert.equal(
    localGridStale(local.made, { lon: -19, lat: 65, heightM: 1e5 }),
    true,
  );
  assert.equal(localGridStale(null, overIceland), true);

  const global = hexCellsForView({ lon: 0, lat: 0, heightM: 1e7 }, landAt);
  assert.equal(global.scope, 'global');
  assert.equal(global.sizeKm, 150, 'the planet fits the default budget');
  assert.equal(global.made.halfSideKm, null);
  const names = new Set(global.cells.map((cell) => cell.feature.name));
  // Iceland is missed: at 65°N the planet-wide lattice's rows are 4° apart.
  assert.ok(names.has('South Africa'), [...names].join(','));
  assert.ok(global.cells.every((cell) => cell.feature));
  const fourNames = ['Iceland', 'Lesotho', 'South Africa', 'Switzerland'];
  assert.ok(
    global.cells.every((cell) => fourNames.includes(cell.feature.name)),
  );

  const capped = hexCellsForView({ lon: 0, lat: 0, heightM: 1e7 }, landAt, {
    maxCells: 500,
  });
  assert.ok(capped.sizeKm > 150, 'coarsened to fit a small budget');
  assert.ok(capped.cells.length < global.cells.length);
  assert.ok(capped.cells.length <= 500);
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

test('the registry entries: no imagery, a painted ocean, flat terrain, a Natural Earth credit', async () => {
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

test('opacity is read from storage and clamped; the view rectangle wraps at the antimeridian', () => {
  assert.equal(readOpacity({ getItem: () => '0.4' }), 0.4);
  assert.equal(readOpacity({ getItem: () => '7' }), 1);
  assert.equal(readOpacity({ getItem: () => 'abc' }), 1);
  assert.equal(readOpacity({ getItem: () => null }), 1);
  assert.equal(readOpacity(null), 1);
  const near = viewRectangleDegrees(64, -20, 1e5);
  assert.ok(
    near.west > -27 && near.east < -13 && near.south > 61 && near.north < 67,
  );
  const wide = viewRectangleDegrees(60, 179, 2e6);
  assert.ok(wide.west > wide.east, 'crosses the antimeridian');
  const capped = viewRectangleDegrees(0, 0, 1e8);
  assert.ok(
    capped.west > -46 && capped.east < 46,
    'the square caps at 10,000 km',
  );
  assert.deepEqual(viewRectangleDegrees(85, 0, 2e6), {
    west: -180,
    east: 180,
    south: -90,
    north: 90,
  });
});

/** Cesium stand-in: records every geometry instance and primitive. */
function fakeCesium() {
  const toRad = (d) => (d * Math.PI) / 180;
  const Color = {
    fromCssColorString: (css) => ({
      css,
      alpha: 1,
      withAlpha(alpha) {
        return { css, alpha, withAlpha: this.withAlpha };
      },
    }),
  };
  class Primitive {
    constructor(options) {
      this.options = options;
      this.instances = options.geometryInstances;
    }
  }
  class EllipsoidTerrainProvider {}
  return {
    Primitive,
    EllipsoidTerrainProvider,
    Color,
    Cartesian2: class {
      constructor(x, y) {
        Object.assign(this, { x, y });
      }
    },
    Cartesian3: { fromDegreesArray: (flat) => flat },
    Cartographic: { fromCartesian: (value) => value },
    Math: {
      toDegrees: (radians) => (radians * 180) / Math.PI,
      toRadians: toRad,
    },
    GeometryInstance: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    PolygonGeometry: class {
      constructor(options) {
        Object.assign(this, { kind: 'polygon', ...options });
      }
    },
    PolygonHierarchy: class {
      constructor(positions, holes = []) {
        Object.assign(this, { positions, holes });
      }
    },
    PolylineGeometry: class {
      constructor(options) {
        Object.assign(this, { kind: 'polyline', ...options });
      }
    },
    PerInstanceColorAppearance: Object.assign(
      class {
        constructor(options) {
          Object.assign(this, { kind: 'fill', ...options });
        }
      },
      { VERTEX_FORMAT: 'fill-format' },
    ),
    PolylineColorAppearance: class {
      constructor(options) {
        Object.assign(this, { kind: 'line', ...options });
      }
    },
    ColorGeometryInstanceAttribute: { fromColor: (color) => color },
    ArcType: { GEODESIC: 'geodesic' },
  };
}

function fakeViewer({ lon, lat, heightM }) {
  const toRad = (d) => (d * Math.PI) / 180;
  const primitives = [];
  const removed = [];
  const moveListeners = new Set();
  const viewer = {
    scene: {
      primitives: {
        add: (p) => primitives.push(p),
        remove: (p) => {
          const at = primitives.indexOf(p);
          if (at >= 0) primitives.splice(at, 1);
          removed.push(p);
        },
      },
    },
    camera: {
      positionCartographic: {
        longitude: toRad(lon),
        latitude: toRad(lat),
        height: heightM,
      },
      moveEnd: {
        addEventListener(fn) {
          moveListeners.add(fn);
          return () => moveListeners.delete(fn);
        },
      },
    },
  };
  const moveTo = ({ lon: nlon, lat: nlat, heightM: h }) => {
    viewer.camera.positionCartographic = {
      longitude: toRad(nlon),
      latitude: toRad(nlat),
      height: h,
    };
    for (const fn of [...moveListeners]) fn();
  };
  return { viewer, primitives, removed, moveTo, moveListeners };
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

function attach(view, { storage = fakeStorage(), loads = [] } = {}) {
  const env = fakeViewer(view);
  const controller = fakeController();
  const renders = [];
  const basemap = attachCountriesBasemap(controller, env.viewer, {
    cesium: fakeCesium(),
    loadPack: async (name) => {
      loads.push(name);
      return fixture[name];
    },
    storage,
    requestRender: (reason) => renders.push(reason),
  });
  return { ...env, controller, basemap, renders, storage, loads };
}

const fills = (primitive) =>
  primitive.instances.filter((i) => i.geometry.kind === 'polygon');
const lines = (primitive) =>
  primitive.instances.filter((i) => i.geometry.kind === 'polyline');

test('the simple style draws every country once, redraws for a theme or opacity change, and clears when the stack leaves', async () => {
  const env = attach({ lon: -19, lat: 65, heightM: 1e7 });
  const { controller, basemap, primitives, removed, loads } = env;
  assert.equal(primitives.length, 0, 'nothing until a countries style settles');

  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.deepEqual(loads, ['countries'], 'the admin-1 pack is not loaded');
  assert.equal(
    primitives.length,
    2,
    'one fill primitive, one outline primitive',
  );
  const [fillPrimitive, linePrimitive] = primitives;
  assert.equal(
    fills(fillPrimitive).length,
    5,
    'Iceland, Lesotho, South Africa ×2, Switzerland',
  );
  assert.equal(lines(linePrimitive).length, 5);
  assert.equal(fillPrimitive.options.appearance.kind, 'fill');
  assert.equal(fillPrimitive.options.appearance.flat, true);
  assert.equal(fillPrimitive.options.appearance.translucent, false);
  assert.equal(fillPrimitive.options.allowPicking, false);
  assert.ok(
    fills(fillPrimitive).every(
      (i) =>
        i.attributes.color.css === COUNTRY_THEMES.dark.fill &&
        i.attributes.color.alpha === 1,
    ),
  );
  const southAfrica = fills(fillPrimitive).find((i) => i.id === 'ZAF/0');
  assert.equal(
    southAfrica.geometry.polygonHierarchy.holes.length,
    1,
    'Lesotho is a hole',
  );
  assert.ok(
    lines(linePrimitive).every(
      (i) =>
        i.geometry.width === COUNTRY_THEMES.dark.outlineWidth &&
        i.attributes.color.css === COUNTRY_THEMES.dark.outline,
    ),
  );
  assert.ok(
    lines(linePrimitive).every(
      (i) => i.geometry.positions.at(-1) === i.geometry.positions[1],
    ),
    'rings close',
  );
  const state = basemap.getState();
  assert.equal(state.activeId, 'countries-simple-dark');
  assert.deepEqual(state.world, { fills: true, outlines: true });
  assert.deepEqual(state.local, {
    fills: false,
    outlines: false,
    admin1: false,
  });
  assert.equal(state.hex, null);
  assert.ok(env.renders.includes('countries-basemap'));

  // The same style again: nothing is rebuilt.
  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.equal(primitives[0], fillPrimitive);
  assert.equal(removed.length, 0);

  // The light theme: rebuilt with its colours.
  controller.emit('countries-simple-light');
  await basemap.settled();
  assert.equal(removed.length, 2);
  assert.equal(primitives.length, 2);
  assert.equal(
    fills(primitives[0])[0].attributes.color.css,
    COUNTRY_THEMES.light.fill,
  );

  // Opacity: stored, applied as alpha, the appearance turns translucent.
  basemap.setOpacity(0.5);
  await basemap.settled();
  assert.equal(env.storage.map.get(OPACITY_STORAGE_KEY), '0.5');
  assert.equal(basemap.getOpacity(), 0.5);
  assert.equal(primitives[0].options.appearance.translucent, true);
  assert.ok(
    fills(primitives[0]).every((i) => i.attributes.color.alpha === 0.5),
  );
  assert.equal(
    lines(primitives[1])[0].attributes.color.alpha,
    1,
    'outlines stay solid',
  );

  // A per-country colour repaints.
  basemap.setCountryFill('CH', '#123456');
  await basemap.settled();
  assert.equal(
    fills(primitives[0]).find((i) => i.id === 'CHE/0').attributes.color.css,
    '#123456',
  );
  basemap.setCountryFill('CH', null);

  // Another stack: everything is cleared.
  controller.emit('osm');
  await basemap.settled();
  assert.equal(primitives.length, 0);
  assert.equal(basemap.getState().activeId, null);
  assert.equal(env.moveListeners.size, 0, 'the camera listener is released');

  basemap.destroy();
  assert.equal(controller.size, 0, 'unsubscribed from the controller');
  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.equal(primitives.length, 0, 'a destroyed renderer draws nothing');
});

test('the stored opacity is read at attach time', async () => {
  const storage = fakeStorage();
  storage.setItem(OPACITY_STORAGE_KEY, '0.25');
  const env = attach({ lon: -19, lat: 65, heightM: 1e7 }, { storage });
  assert.equal(env.basemap.getOpacity(), 0.25);
  env.controller.emit('countries-simple-dark');
  await env.basemap.settled();
  assert.ok(
    fills(env.primitives[0]).every((i) => i.attributes.color.alpha === 0.25),
  );
  env.basemap.destroy();
});

test('subdivisions draw first-level units only below the ceiling and only around the view', async () => {
  const env = attach({ lon: -19, lat: 65, heightM: 1e7 });
  const { controller, basemap, primitives, loads } = env;
  controller.emit('countries-subdivisions-dark');
  await basemap.settled();
  assert.deepEqual(loads, ['countries', 'admin1']);
  assert.equal(
    primitives.length,
    2,
    'country fills and outlines only, from orbit',
  );
  assert.equal(basemap.getState().local.admin1, false);

  env.moveTo({ lon: -19, lat: 65, heightM: 2e6 });
  await basemap.settled();
  assert.equal(primitives.length, 3);
  const iceland = primitives[2];
  assert.ok(
    lines(iceland).length >= 9,
    `${lines(iceland).length} Icelandic unit outlines`,
  );
  assert.ok(lines(iceland).every((i) => i.id.startsWith('IS-')));
  assert.ok(
    lines(iceland).every(
      (i) =>
        i.geometry.width === COUNTRY_THEMES.dark.admin1OutlineWidth &&
        i.attributes.color.css === COUNTRY_THEMES.dark.admin1Outline,
    ),
  );
  assert.equal(basemap.getState().local.admin1, true);
  const worldFills = primitives[0];

  // A small move keeps the units; a move to Lesotho swaps them.
  env.moveTo({ lon: -18, lat: 64.5, heightM: 2e6 });
  await basemap.settled();
  assert.equal(primitives[2], iceland);
  env.moveTo({ lon: 27.5, lat: -29.3, heightM: 2e6 });
  await basemap.settled();
  assert.equal(primitives.length, 3);
  assert.notEqual(primitives[2], iceland);
  assert.equal(primitives[0], worldFills, 'the world group survives the move');
  assert.ok(lines(primitives[2]).every((i) => i.id.startsWith('LS-')));
  assert.equal(
    new Set(lines(primitives[2]).map((i) => i.id)).size,
    10,
    'the ten districts (one of them in two parts)',
  );

  // Back above the ceiling: the units go, the countries stay.
  env.moveTo({ lon: 27.5, lat: -29.3, heightM: 8e6 });
  await basemap.settled();
  assert.equal(primitives.length, 2);
  assert.equal(basemap.getState().local.admin1, false);
  basemap.destroy();
});

test('the hex style draws land cells, from a planet-wide lattice far out to a local one nearer, rebuilt on far moves', async () => {
  const env = attach({ lon: 0, lat: 0, heightM: 1e7 });
  const { controller, basemap, primitives } = env;
  controller.emit('countries-hex-light');
  await basemap.settled();
  assert.equal(
    primitives.length,
    2,
    'hex fills and hex outlines, no country polygons',
  );
  let state = basemap.getState();
  assert.deepEqual(state.world, { fills: false, outlines: false });
  assert.equal(state.hex.scope, 'global');
  assert.equal(state.hex.sizeKm, 150);
  assert.ok(state.hex.cells > 10, `${state.hex.cells} land hexes`);
  assert.equal(fills(primitives[0]).length, state.hex.cells);
  assert.equal(lines(primitives[1]).length, state.hex.cells);
  assert.ok(
    fills(primitives[0]).every((i) =>
      COUNTRY_THEMES.light.varied.includes(i.attributes.color.css),
    ),
  );
  assert.ok(
    lines(primitives[1]).every(
      (i) => i.attributes.color.css === COUNTRY_THEMES.light.hexOutline,
    ),
  );
  const globalFills = primitives[0];

  // Moving across the planet far out keeps the planet-wide lattice.
  env.moveTo({ lon: 100, lat: 30, heightM: 1.2e7 });
  await basemap.settled();
  assert.equal(primitives[0], globalFills);

  // Closer: a local lattice around the view, finer cells.
  env.moveTo({ lon: -19, lat: 65, heightM: 3e6 });
  await basemap.settled();
  state = basemap.getState();
  assert.equal(state.hex.scope, 'local');
  assert.equal(state.hex.sizeKm, 60);
  assert.notEqual(primitives[0], globalFills);
  assert.ok(state.hex.cells > 5);
  assert.deepEqual(state.madeFor, {
    lon: -19,
    lat: 65,
    heightM: 3e6,
    halfSideKm: 5000,
  });
  const localFills = primitives[0];
  env.moveTo({ lon: -18, lat: 64, heightM: 3e6 });
  await basemap.settled();
  assert.equal(primitives[0], localFills, 'a small move keeps the lattice');
  env.moveTo({ lon: 27, lat: -29, heightM: 3e6 });
  await basemap.settled();
  assert.notEqual(primitives[0], localFills, 'a far move remakes it');
  assert.equal(primitives.length, 2);

  // The dark theme redraws with its palette; nothing from the light one stays.
  controller.emit('countries-hex-dark');
  await basemap.settled();
  assert.equal(primitives.length, 2);
  assert.ok(
    fills(primitives[0]).every((i) =>
      COUNTRY_THEMES.dark.varied.includes(i.attributes.color.css),
    ),
  );
  basemap.destroy();
  assert.equal(primitives.length, 0);
});

test('a pack that fails to load is retried on the next activation, and a late load cannot draw a left stack', async () => {
  let fail = true;
  const loads = [];
  const env = fakeViewer({ lon: 0, lat: 0, heightM: 1e7 });
  const controller = fakeController();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const basemap = attachCountriesBasemap(controller, env.viewer, {
      cesium: fakeCesium(),
      loadPack: async (name) => {
        loads.push(name);
        if (fail) throw new Error('offline');
        return fixture[name];
      },
      storage: fakeStorage(),
    });
    controller.emit('countries-simple-dark');
    await basemap.settled();
    assert.equal(env.primitives.length, 0);
    assert.match(warnings.join('\n'), /could not draw/);
    fail = false;
    controller.emit('countries-simple-light');
    await basemap.settled();
    assert.deepEqual(loads, ['countries', 'countries']);
    assert.equal(env.primitives.length, 2);

    // Leave while a slow (re)build is pending: nothing lands afterwards.
    let release;
    const slow = attachCountriesBasemap(
      fakeController(),
      fakeViewer({ lon: 0, lat: 0, heightM: 1e7 }).viewer,
      {
        cesium: fakeCesium(),
        loadPack: () =>
          new Promise(
            (resolve) => (release = () => resolve(fixture.countries)),
          ),
        storage: fakeStorage(),
      },
    );
    slow.renderer.show(countriesBasemapRecord('countries-simple-dark'));
    slow.renderer.hide();
    for (let i = 0; i < 5 && !release; i++) await Promise.resolve();
    release();
    await slow.settled();
    assert.equal(slow.getState().activeId, null);
    assert.deepEqual(slow.getState().world, { fills: false, outlines: false });
    slow.destroy();
    basemap.destroy();
  } finally {
    console.warn = originalWarn;
  }
});

test('a camera move that supersedes a style switch still clears the old style (seen in headless Chrome)', async () => {
  // Switching to a countries style fires a moveEnd in the app; the move's
  // view-group build used to win the race and leave the previous style's
  // planet-wide polygons on the globe under the new hexes.
  const env = attach({ lon: 10, lat: 30, heightM: 2.2e7 });
  const { controller, basemap, primitives } = env;
  controller.emit('countries-simple-dark');
  await basemap.settled();
  assert.equal(primitives.length, 2);

  controller.emit('countries-hex-dark');
  env.moveTo({ lon: 10, lat: 30, heightM: 2.2e7 }); // before the switch settles
  await basemap.settled();
  let state = basemap.getState();
  assert.deepEqual(state.world, { fills: false, outlines: false });
  assert.deepEqual(state.local, { fills: true, outlines: true, admin1: false });
  assert.equal(primitives.length, 2, 'hex fills and outlines only');
  assert.ok(
    fills(primitives[0]).every((i) => i.id.includes(',')),
    'hex keys',
  );

  controller.emit('countries-subdivisions-light');
  env.moveTo({ lon: 10, lat: 50, heightM: 2.5e6 });
  await basemap.settled();
  state = basemap.getState();
  assert.deepEqual(state.world, { fills: true, outlines: true });
  assert.equal(state.local.admin1, true);
  assert.equal(primitives.length, 3);
  assert.ok(
    fills(primitives[0]).every(
      (i) => i.attributes.color.css === COUNTRY_THEMES.light.fill,
    ),
    'the light fills, not the dark ones',
  );
  basemap.destroy();
});
