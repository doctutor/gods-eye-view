// Personal fork: the Localities layer (src/layers/localities/): the
// thinning rule on the real Natural Earth pack, the Overpass query for
// OpenStreetMap's places, the merge, and the label and card entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';

import {
  MAX_PLACE_LABELS,
  OSM_MAX_HEIGHT_M,
  boxCovers,
  buildPlacesQuery,
  mergePlaces,
  normalizeOsmPlace,
  osmPlaceKindsForHeight,
  osmQueryBox,
  parsePopulation,
  pickNaturalEarthPlaces,
  placeCardEntry,
  placeLabelEntry,
  placeName,
  placeZoomForHeight,
} from './places.js';
import { osmStatusText, placeCardDetails, placeKind } from './presentation.js';
import { createLocalitiesLayer, LOCALITIES_SOURCE } from './index.js';
import { OverpassViewError } from '../../sources/overpassView.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { setLocale } from '../../i18n/index.js';

const PACK = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/natural_earth/populated_places.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const names = (picked) => picked.map(({ place }) => place.name);

test('the pack: Natural Earth 10m populated places, pinned, three languages', () => {
  assert.equal(PACK.places.length, 7342);
  assert.match(PACK.meta.license, /Public domain/);
  assert.match(PACK.meta.sha256, /^[0-9a-f]{64}$/);
  const moscow = PACK.places.find((place) => place.name === 'Moscow');
  assert.deepEqual(
    [moscow.ru, moscow.es, moscow.cap, PACK.countries[moscow.c]],
    ['Москва', 'Moscú', 'country', 'Russia'],
  );
  assert.ok(moscow.pop > 10_000_000);
  // Most prominent first.
  assert.ok(PACK.places[0].z <= PACK.places.at(-1).z);
});

test('the zoom a height drapes, and the thinning by Natural Earth’s min_zoom', () => {
  assert.equal(placeZoomForHeight(20_000_000), 3);
  assert.equal(placeZoomForHeight(3_000_000), 6);
  assert.equal(placeZoomForHeight(50_000), 12);
  // Orbit: only the places Natural Earth labels by z 3.
  const orbit = pickNaturalEarthPlaces(PACK.places, {
    lat: 50,
    lon: 10,
    height: 20_000_000,
  });
  assert.ok(orbit.length > 10 && orbit.length < 80, `${orbit.length} at orbit`);
  assert.ok(orbit.every(({ place }) => place.z <= 3));
  assert.ok(names(orbit).includes('Moscow'));
  assert.ok(!names(orbit).includes('Baltimore'));
  // Europe from 3,000 km: capped, capitals first.
  const europe = pickNaturalEarthPlaces(PACK.places, {
    lat: 50,
    lon: 10,
    height: 3_000_000,
  });
  assert.equal(europe.length, MAX_PLACE_LABELS);
  for (const city of ['Paris', 'Berlin', 'Rome', 'Madrid', 'Warsaw'])
    assert.ok(names(europe).includes(city), city);
  assert.ok(europe.every(({ place }) => place.z <= 6));
  assert.equal(europe[0].place.cap, 'country');
  // A city from 50 km: every Natural Earth place near it.
  const baltimore = pickNaturalEarthPlaces(PACK.places, {
    lat: 39.29,
    lon: -76.61,
    height: 50_000,
  });
  assert.ok(names(baltimore).includes('Baltimore'));
  assert.ok(names(baltimore).includes('Annapolis'));
  assert.ok(baltimore.length < 40);
  assert.ok(
    baltimore.every(
      ({ lat, lon }) => Math.abs(lat - 39.29) < 2 && Math.abs(lon + 76.61) < 3,
    ),
  );
});

test('OpenStreetMap close in: the kinds widen as the camera comes in', () => {
  assert.deepEqual(osmPlaceKindsForHeight(OSM_MAX_HEIGHT_M), []);
  assert.deepEqual(osmPlaceKindsForHeight(59_000), ['city', 'town']);
  assert.deepEqual(osmPlaceKindsForHeight(15_000), [
    'city',
    'town',
    'village',
    'suburb',
  ]);
  assert.deepEqual(osmPlaceKindsForHeight(2_000), [
    'city',
    'town',
    'village',
    'suburb',
    'hamlet',
    'neighbourhood',
  ]);
  assert.deepEqual(osmPlaceKindsForHeight(NaN), []);
});

test('the Overpass query: a snapped box, named place nodes, a limit', () => {
  const box = osmQueryBox({ lat: 39.29, lon: -76.61, height: 50_000 });
  assert.deepEqual(box, {
    south: 38.8,
    west: -77.2,
    north: 39.75,
    east: -76.0,
  });
  // A little pan stays inside the same box.
  assert.ok(
    boxCovers(box, osmQueryBox({ lat: 39.3, lon: -76.62, height: 45_000 })),
  );
  // Well inside the proxy's 12° limit even at the top band.
  const top = osmQueryBox({ lat: 60, lon: 10, height: OSM_MAX_HEIGHT_M });
  assert.ok(top.north - top.south < 12 && top.east - top.west < 12);
  assert.equal(
    buildPlacesQuery(box, ['city', 'town'], 800),
    '[out:json][timeout:25];node["place"~"^(city|town)$"]["name"](38.8,-77.2,39.75,-76);out body qt 800;',
  );
  assert.throws(() => buildPlacesQuery(box, ['x"]']), TypeError);
});

test('OpenStreetMap place nodes as places: names, kind, population', () => {
  assert.equal(parsePopulation('1 234 567'), 1234567);
  assert.equal(parsePopulation('12,000'), 12000);
  assert.equal(parsePopulation('about 300'), 0);
  assert.deepEqual(
    normalizeOsmPlace({
      type: 'node',
      id: 158368533,
      lat: 39.2905,
      lon: -76.6104,
      tags: {
        place: 'city',
        name: 'Baltimore',
        'name:ru': 'Балтимор',
        population: '585708',
      },
    }),
    {
      id: 'osm:158368533',
      name: 'Baltimore',
      ru: 'Балтимор',
      kind: 'city',
      pop: 585708,
      at: [-76.6104, 39.2905],
    },
  );
  const munich = normalizeOsmPlace({
    type: 'node',
    id: 1,
    lat: 48.1,
    lon: 11.6,
    tags: { place: 'city', name: 'München', 'name:en': 'Munich' },
  });
  assert.equal(munich.name, 'Munich');
  assert.equal(munich.local, 'München');
  assert.equal(
    normalizeOsmPlace({ type: 'node', id: 2, lat: 1, lon: 1, tags: {} }),
    null,
  );
  assert.equal(
    normalizeOsmPlace({
      type: 'way',
      id: 3,
      tags: { place: 'city', name: 'x' },
    }),
    null,
  );
});

test('merge: Natural Earth gives way to OpenStreetMap’s place of the same name close by', () => {
  const ne = [
    {
      id: 'ne:1',
      place: { name: 'Baltimore', z: 5.6 },
      lat: 39.302,
      lon: -76.622,
    },
    { id: 'ne:2', place: { name: 'Annapolis', z: 6 }, lat: 38.97, lon: -76.5 },
  ];
  const osm = [
    { id: 'osm:1', name: 'Towson', kind: 'town', at: [-76.6, 39.4] },
    {
      id: 'osm:2',
      name: 'Baltimore',
      kind: 'city',
      pop: 585708,
      at: [-76.61, 39.29],
    },
  ];
  const merged = mergePlaces(ne, osm);
  assert.deepEqual(
    merged.naturalEarth.map((item) => item.id),
    ['ne:2'],
  );
  // Cities before towns.
  assert.deepEqual(
    merged.osm.map((item) => item.id),
    ['osm:2', 'osm:1'],
  );
});

test('label and card entries pass the world overlay’s normalisation', () => {
  const place = {
    name: 'Moscow',
    ru: 'Москва',
    cap: 'country',
    z: 1.7,
    pop: 10452000,
    c: 0,
  };
  const label = normalizeOverlayEntry(
    LOCALITIES_SOURCE,
    placeLabelEntry({
      id: 'ne:0',
      place,
      lon: 37.61,
      lat: 55.75,
      title: placeName(place, 'ru'),
      accent: '#ffffff',
      cesium: Cesium,
    }),
  );
  assert.equal(label.variant, 'label');
  assert.equal(label.title, 'Москва');
  assert.equal(label.interactive, true);
  assert.equal(label.collisionGroup, 'locality-name');
  const card = normalizeOverlayEntry(
    LOCALITIES_SOURCE,
    placeCardEntry({
      place,
      lon: 37.61,
      lat: 55.75,
      title: 'Moscow',
      details: placeCardDetails(place, ['Russia']),
      accent: '#ffffff',
      cesium: Cesium,
    }),
  );
  assert.equal(card.variant, 'card');
  assert.equal(card.id, 'card');
  assert.deepEqual(card.details, [
    'National capital · Russia',
    'Population 10,452,000',
    'Natural Earth',
  ]);
  assert.deepEqual(
    placeCardDetails({ name: 'Towson', kind: 'town', pop: 55000 }),
    ['Town', 'Population 55,000', 'OpenStreetMap'],
  );
  setLocale('es');
  try {
    assert.equal(placeKind({ kind: 'village' }), 'Aldea');
    assert.equal(placeName(place, 'es'), 'Moscow');
  } finally {
    setLocale('en');
  }
});

function fakeViewer(height) {
  const added = [];
  return {
    added,
    camera: {
      positionCartographic: {
        latitude: Cesium.Math.toRadians(39.29),
        longitude: Cesium.Math.toRadians(-76.61),
        height,
      },
      moveEnd: { addEventListener: () => () => {} },
    },
    scene: {
      canvas: null,
      primitives: { add: (p) => added.push(p), remove: () => {} },
    },
  };
}

function fakeHost() {
  const sources = new Map();
  return {
    sources,
    setEntries: (id, entries) => sources.set(id, entries),
    setVisible: () => {},
    clearSource: (id) => sources.delete(id),
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

test('the layer: Natural Earth from far out, Overpass below 60 km, the row says why not', async () => {
  const queries = [];
  let answer = () => ({
    elements: [
      {
        type: 'node',
        id: 9,
        lat: 39.4,
        lon: -76.6,
        tags: { place: 'town', name: 'Towson' },
      },
    ],
  });
  const overpass = {
    query: async (q) => {
      queries.push(q);
      return answer();
    },
    abort: () => {},
  };
  const host = fakeHost();
  const layer = createLocalitiesLayer({
    overlayHost: host,
    overpass,
    load: async () => ({ countries: PACK.countries, places: PACK.places }),
    storage: null,
    setTimeoutImpl: (fn) => (fn(), 0),
    clearTimeoutImpl: () => {},
    locale: () => 'en',
  });
  // Far out: no Overpass.
  let viewer = fakeViewer(3_000_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  assert.equal(queries.length, 0);
  assert.equal(layer._state().osm.state, 'above');
  assert.ok(host.sources.get(LOCALITIES_SOURCE).length > 50);
  assert.match(
    layer.getRowControls().info,
    /Natural Earth places · OpenStreetMap places below 60 km/,
  );
  // Close in: Overpass for the view; OSM's town is named.
  viewer.camera.positionCartographic.height = 30_000;
  layer._settle();
  await flush();
  assert.equal(queries.length, 1);
  assert.match(queries[0], /node\["place"~"\^\(city\|town\)\$"\]/);
  const titles = host.sources
    .get(LOCALITIES_SOURCE)
    .map((entry) => entry.title);
  assert.ok(titles.includes('Towson'));
  assert.ok(titles.includes('Baltimore'));
  // Not configured: Natural Earth keeps naming, the row names the variable.
  answer = () => {
    throw new OverpassViewError('unconfigured', 'not configured');
  };
  viewer.camera.positionCartographic.height = 4_000;
  layer._settle();
  await flush();
  assert.equal(layer._state().osm.state, 'unconfigured');
  assert.match(layer.getRowControls().info, /OVERPASS_UPSTREAMS/);
  layer.disable();
  assert.equal(host.sources.has(LOCALITIES_SOURCE), false);
});

test('the row’s OpenStreetMap words', () => {
  assert.equal(
    osmStatusText({ state: 'ready', count: 3 }),
    '3 OpenStreetMap places',
  );
  assert.equal(
    osmStatusText({ state: 'ready', count: 800, saturated: true }),
    '800+ OpenStreetMap places',
  );
  assert.equal(
    osmStatusText({ state: 'limited' }),
    'OpenStreetMap is busy; trying again shortly',
  );
});
