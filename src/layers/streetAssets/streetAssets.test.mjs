// Personal fork: the Street assets layer (src/layers/streetAssets/): the
// caps per type, the Overpass queries, the answers as features, the layer's
// pins / counts / nothing by height, and the paced Overpass client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  ASSET_KEYS,
  ASSET_TYPES,
  assetFeatures,
  assetModeForHeight,
  assetQueryBox,
  assetTypeOf,
  buildAssetQuery,
} from './assets.js';
import { rowControls, statusText } from './presentation.js';
import { createStreetAssetsLayer, readAssetType } from './index.js';
import {
  OVERPASS_MIN_GAP_MS,
  OverpassViewError,
  createOverpassViewClient,
} from '../../sources/overpassView.js';
import { setLocale } from '../../i18n/index.js';

test('five types, each with a pin height below its count height and sane limits', () => {
  assert.deepEqual(ASSET_KEYS, [
    'charging',
    'bike',
    'hydrant',
    'lamp',
    'signals',
  ]);
  for (const type of ASSET_TYPES) {
    assert.ok(type.pinsBelowM < type.countsBelowM, type.key);
    assert.ok(type.pinLimit <= type.countLimit, type.key);
    assert.ok(type.countLimit <= 12_000, type.key);
    // The widest box a type asks for stays inside the proxy's 12° bound,
    // even at 70° N.
    const box = assetQueryBox({ lat: 70, lon: 20, height: type.countsBelowM });
    assert.ok(box.north - box.south < 12 && box.east - box.west < 12, type.key);
  }
  // The densest go first: street lights are capped lowest.
  assert.equal(assetTypeOf('lamp').pinsBelowM, 3_000);
  assert.equal(assetTypeOf('lamp').countsBelowM, 15_000);
  assert.equal(assetTypeOf('nope').key, 'charging');
});

test('pins, counts or nothing by height', () => {
  const lamp = assetTypeOf('lamp');
  assert.equal(assetModeForHeight(lamp, 2_999), 'pins');
  assert.equal(assetModeForHeight(lamp, 3_000), 'counts');
  assert.equal(assetModeForHeight(lamp, 14_999), 'counts');
  assert.equal(assetModeForHeight(lamp, 15_000), 'none');
  assert.equal(assetModeForHeight(lamp, NaN), 'none');
  const charging = assetTypeOf('charging');
  assert.equal(assetModeForHeight(charging, 30_000), 'pins');
  assert.equal(assetModeForHeight(charging, 100_000), 'counts');
});

test('the Overpass queries: pins with tags or geometry, counts as bare points', () => {
  const box = assetQueryBox({ lat: 39.29, lon: -76.61, height: 2_000 });
  assert.deepEqual(box, {
    south: 39.25,
    west: -76.65,
    north: 39.35,
    east: -76.55,
  });
  assert.equal(
    buildAssetQuery(assetTypeOf('hydrant'), box, 'pins'),
    '[out:json][timeout:25];(node["emergency"="fire_hydrant"](39.25,-76.65,39.35,-76.55););out center qt 2000;',
  );
  assert.equal(
    buildAssetQuery(assetTypeOf('lamp'), box, 'counts'),
    '[out:json][timeout:25];(node["highway"="street_lamp"](39.25,-76.65,39.35,-76.55););out skel qt 12000;',
  );
  // Charging stations are nodes and areas: centres.
  assert.match(
    buildAssetQuery(assetTypeOf('charging'), box, 'counts'),
    /\(nwr\["amenity"="charging_station"\]\(.*\);\);out center qt 8000;$/,
  );
  // Bike lanes: every cycleway tagging, ways with geometry as pins.
  const bike = buildAssetQuery(assetTypeOf('bike'), box, 'pins');
  assert.match(bike, /way\["highway"="cycleway"\]/);
  assert.match(bike, /way\["cycleway:right"~"\^\(lane\|track\)\$"\]/);
  assert.match(bike, /out geom qt 2500;$/);
  assert.match(
    buildAssetQuery(assetTypeOf('bike'), box, 'counts'),
    /out center qt 10000;$/,
  );
});

test('answers as features: points (centres too), lines, no duplicates', () => {
  const lamp = assetTypeOf('lamp');
  assert.deepEqual(
    assetFeatures(lamp, 'counts', [
      { type: 'node', id: 1, lat: 39.3, lon: -76.6 },
      { type: 'node', id: 1, lat: 39.3, lon: -76.6 },
      { type: 'node', id: 2 },
    ]),
    [{ id: 'node/1', lat: 39.3, lon: -76.6 }],
  );
  assert.deepEqual(
    assetFeatures(assetTypeOf('charging'), 'pins', [
      {
        type: 'way',
        id: 7,
        center: { lat: 39.2, lon: -76.5 },
        tags: { amenity: 'charging_station' },
      },
    ]),
    [
      {
        id: 'way/7',
        lat: 39.2,
        lon: -76.5,
        tags: { amenity: 'charging_station' },
      },
    ],
  );
  const bike = assetTypeOf('bike');
  assert.deepEqual(
    assetFeatures(bike, 'pins', [
      {
        type: 'way',
        id: 3,
        geometry: [
          { lat: 1, lon: 2 },
          { lat: 1.1, lon: 2.1 },
        ],
      },
      { type: 'way', id: 4, geometry: [{ lat: 1, lon: 2 }] },
    ]),
    [
      {
        id: 'way/3',
        coords: [
          [2, 1],
          [2.1, 1.1],
        ],
      },
    ],
  );
  // Bike lanes counted: their centres.
  assert.deepEqual(
    assetFeatures(bike, 'counts', [
      { type: 'way', id: 5, center: { lat: 1, lon: 2 } },
    ]),
    [{ id: 'way/5', lat: 1, lon: 2 }],
  );
});

test('the row: a chip per type, the swatch, what is drawn at this height', () => {
  let picked = '';
  const row = rowControls({
    asset: 'lamp',
    onAsset: (key) => (picked = key),
    inkColor: '#ffffff',
    enabled: true,
    status: { mode: 'counts', state: 'ready', count: 4200 },
  });
  assert.deepEqual(
    row.chips.map((chip) => [chip.label, chip.active]),
    [
      ['EV CHARGING', false],
      ['BIKE LANES', false],
      ['HYDRANTS', false],
      ['STREET LIGHTS', true],
      ['SIGNALS', false],
    ],
  );
  row.chips[1].onClick();
  assert.equal(picked, 'bike');
  assert.deepEqual(row.legend, [{ label: 'STREET LIGHTS', color: '#ffd166' }]);
  assert.equal(
    row.info,
    '4200 street lights · Counts per hexagon; pins below 3 km',
  );
  assert.equal(
    rowControls({
      asset: 'bike',
      onAsset() {},
      inkColor: '#1a1a1a',
      enabled: true,
      status: null,
    }).legend[0].color,
    '#1a1a1a',
  );
  const lamp = assetTypeOf('lamp');
  assert.equal(
    statusText({ type: lamp, mode: 'none', state: 'idle' }),
    'Zoom in below 15 km to draw them',
  );
  assert.equal(
    statusText({
      type: lamp,
      mode: 'pins',
      state: 'ready',
      count: 2000,
      saturated: true,
    }),
    '2000 street lights · more than the view can show; zoom in for all · Pins',
  );
  assert.match(
    statusText({ type: lamp, mode: 'pins', state: 'unconfigured' }),
    /OVERPASS_UPSTREAMS/,
  );
  setLocale('ru');
  try {
    assert.equal(
      statusText({
        type: assetTypeOf('hydrant'),
        mode: 'pins',
        state: 'ready',
        count: 3,
      }),
      '3 пожарных гидранта · Метки',
    );
  } finally {
    setLocale('en');
  }
  assert.equal(readAssetType({ getItem: () => 'signals' }), 'signals');
  assert.equal(readAssetType({ getItem: () => 'bogus' }), 'charging');
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
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

test('the layer: pins close in, rollup points above, nothing past the cap', async () => {
  const queries = [];
  const overpass = {
    query: async (q) => {
      queries.push(q);
      return {
        elements: [
          { type: 'node', id: 1, lat: 39.29, lon: -76.61, tags: {} },
          { type: 'node', id: 2, lat: 39.3, lon: -76.62, tags: {} },
        ],
      };
    },
    abort: () => {},
  };
  const rollups = [];
  const layer = createStreetAssetsLayer({
    overpass,
    storage: { getItem: () => 'signals', setItem() {} },
    setTimeoutImpl: (fn) => (fn(), 0),
    clearTimeoutImpl: () => {},
    attachRollup: (owner, options) => {
      const rollup = {
        options,
        refreshed: 0,
        refresh() {
          this.refreshed++;
        },
        detach() {},
        isActive: () => false,
      };
      rollups.push(rollup);
      return rollup;
    },
  });
  const viewer = fakeViewer(4_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  // Signals below 5 km: pins, with tags.
  assert.match(
    queries.at(-1),
    /node\["highway"="traffic_signals"\].*out center qt 2000;$/,
  );
  assert.equal(layer._state().held.mode, 'pins');
  assert.equal(viewer.added.length, 1);
  // The rollup takes over above the pin height, or past the pin limit.
  assert.deepEqual(rollups[0].options.threshold, {
    enter: 2000,
    exit: 1700,
    enterHeightM: 5_000,
    exitHeightM: 4_250,
    minHeightM: 0,
  });
  assert.deepEqual(rollups[0].options.getPoints(), []);
  // 20 km: bare points for the rollup.
  viewer.camera.positionCartographic.height = 20_000;
  layer._settle();
  await flush();
  assert.match(queries.at(-1), /out skel qt 12000;$/);
  assert.equal(layer._state().held.mode, 'counts');
  assert.equal(rollups[0].options.getPoints().length, 2);
  assert.ok(rollups[0].refreshed > 0);
  // Past the cap: nothing asked for.
  const asked = queries.length;
  viewer.camera.positionCartographic.height = 60_000;
  layer._settle();
  await flush();
  assert.equal(queries.length, asked);
  assert.match(layer.getRowControls().info, /Zoom in below 40 km/);
  layer.disable();
});

test('the Overpass client: through /api/overpass, paced, Retry-After honoured, not configured said', async () => {
  let clock = 0;
  const waits = [];
  const sent = [];
  let reply = () => Response.json({ elements: [{ type: 'node', id: 1 }] });
  const client = createOverpassViewClient({
    fetchImpl: async (url, init) => {
      sent.push({ url, body: init.body, at: clock });
      return reply();
    },
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  const first = await client.query('[out:json];node(1,2,3,4);out;');
  assert.equal(first.elements.length, 1);
  assert.equal(sent[0].url, '/api/overpass');
  assert.equal(
    sent[0].body,
    `data=${encodeURIComponent('[out:json];node(1,2,3,4);out;')}`,
  );
  await client.query('q2');
  assert.deepEqual(waits, [OVERPASS_MIN_GAP_MS]);
  // A rate limit: nothing more until its Retry-After.
  reply = () =>
    Response.json(
      { code: 'OVERPASS_UNAVAILABLE', retryAfterMs: 30_000 },
      { status: 429 },
    );
  await assert.rejects(
    client.query('q3'),
    (error) =>
      error instanceof OverpassViewError &&
      error.code === 'limited' &&
      error.retryAfterMs === 30_000,
  );
  reply = () => Response.json({ elements: [] });
  waits.length = 0;
  await client.query('q4');
  assert.ok(waits[0] >= 29_000);
  // Not configured: said once, no retry loop.
  reply = () =>
    Response.json(
      { code: 'OVERPASS_NOT_CONFIGURED', retryable: false },
      { status: 503 },
    );
  await assert.rejects(
    client.query('q5'),
    (error) => error.code === 'unconfigured',
  );
  // A partial answer (remark) is a failure, not an empty map.
  reply = () =>
    Response.json({ elements: [], remark: 'runtime error: timeout' });
  await assert.rejects(client.query('q6'), (error) => error.code === 'failed');
});

test('a newer query aborts the one in flight', async () => {
  const signals = [];
  const client = createOverpassViewClient({
    minGapMs: 0,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        signals.push(init.signal);
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
        setTimeout(() => resolve(Response.json({ elements: [] })), 20);
      }),
  });
  const a = client.query('a');
  await new Promise((r) => setTimeout(r, 0));
  const b = client.query('b');
  await assert.rejects(a, (error) => error.name === 'AbortError');
  assert.deepEqual((await b).elements, []);
});

/** A Street assets layer on EV charging with a fake Overpass and places index. */
/** A fake Overture index: built or not, `stations` pins, one cell of `cells`. */
function fakeIndex({ configured, stations, cells, prefix, asked }) {
  return {
    status: async () =>
      configured
        ? { configured: true, version: 'abcdef012345', places: 9 }
        : { configured: false },
    pins: async (q) => {
      asked.push(['pins', q.category, q.minConfidence, q.box]);
      const places = Array.from({ length: stations }, (_, i) => ({
        id: `${prefix}:1:2:${i}`,
        at: [-76.61 + i * 0.001, 39.29],
      }));
      return { places, count: places.length, saturated: false };
    },
    counts: async (q) => {
      asked.push(['counts', q.res, q.category]);
      return new Map(cells ? [['872a1072bffffff', cells]] : []);
    },
    abort: () => {},
  };
}

/**
 * A Street assets layer on `asset`, its Overture index (`source`, places or
 * infrastructure) faked and the other one not built.
 */
function overtureLayer({
  asset = 'charging',
  source = 'places',
  configured = true,
  stations = 3,
  cells = 7,
  overpass,
}) {
  const asked = [];
  const credits = [];
  const index = fakeIndex({
    configured,
    stations,
    cells,
    prefix: source === 'places' ? 'pl' : 'in',
    asked,
  });
  const other = fakeIndex({ configured: false, asked: [] });
  const rollup = {};
  const layer = createStreetAssetsLayer({
    overpass,
    places: source === 'places' ? index : other,
    infrastructure: source === 'infrastructure' ? index : other,
    credits: { register: (_viewer, credit) => credits.push(credit) },
    storage: { getItem: () => asset, setItem() {} },
    setTimeoutImpl: (fn) => (fn(), 0),
    clearTimeoutImpl: () => {},
    attachRollup: (_owner, options) =>
      Object.assign(rollup, {
        options,
        refresh() {},
        detach() {},
        isActive: () => false,
      }),
  });
  return { layer, asked, credits, rollup };
}
const chargingLayer = (options) => overtureLayer(options);

const fakeOverpass = (answer) => {
  const queries = [];
  return {
    queries,
    query: async (q) => {
      queries.push(q);
      if (answer instanceof Error) throw answer;
      return { elements: answer };
    },
    abort: () => {},
  };
};
const OSM_STATIONS = [
  { type: 'node', id: 1, lat: 48.8566, lon: 2.3522, tags: {} },
  { type: 'node', id: 2, lat: 48.86, lon: 2.35, tags: {} },
  { type: 'node', id: 3, lat: 48.85, lon: 2.34, tags: {} },
  { type: 'node', id: 4, lat: 48.853, lon: 2.36, tags: {} },
];

test('EV charging from the Overture places index when it is built, OpenStreetMap when not', async () => {
  const overpass = fakeOverpass([]);
  const { layer, asked, credits, rollup } = chargingLayer({ overpass });
  const viewer = fakeViewer(4_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  assert.equal(overpass.queries.length, 0, 'no Overpass');
  const [kind, category, floor, box] = asked.at(-1);
  assert.deepEqual([kind, category, floor], ['pins', 'charging', 0.5]);
  assert.ok(box.east - box.west < 1 && box.north - box.south < 1);
  assert.equal(layer._state().held.features.length, 3);
  assert.ok(credits.some((credit) => /Overture/.test(JSON.stringify(credit))));
  assert.match(layer.getRowControls().info, /from Overture Maps/);
  // Above the pin height: the server's counts through the rollup.
  viewer.camera.positionCartographic.height = 60_000;
  layer._settle();
  await flush();
  const [, res] = asked.at(-1);
  assert.equal(rollup.options.getCounts(res).get('872a1072bffffff'), 7);
  assert.equal(rollup.options.getCounts(res + 1).size, 0);
  assert.equal(overpass.queries.length, 0);
  layer.disable();
  // Not built: Overpass as before.
  const fallback = chargingLayer({ configured: false, overpass });
  const second = fakeViewer(4_000);
  fallback.layer.init(second);
  fallback.layer.enable(second);
  await flush();
  assert.match(overpass.queries.at(-1), /amenity"="charging_station"/);
  assert.doesNotMatch(fallback.layer.getRowControls().info, /Overture/);
  fallback.layer.disable();
});

test('EV charging where Overture is sparse: OpenStreetMap for the view, said in the row; Overture’s few without Overpass', async () => {
  // Two Overture stations (Paris): the view asks OpenStreetMap, which has four.
  const overpass = fakeOverpass(OSM_STATIONS);
  const sparse = chargingLayer({ stations: 2, cells: 2, overpass });
  const viewer = fakeViewer(4_000);
  sparse.layer.init(viewer);
  sparse.layer.enable(viewer);
  await flush();
  assert.equal(sparse.asked.at(-1)[0], 'pins');
  assert.match(
    overpass.queries.at(-1),
    /amenity"="charging_station".*out center/,
  );
  assert.equal(sparse.layer._state().held.features.length, 4);
  assert.match(
    sparse.layer.getRowControls().info,
    /^4 .* · from OpenStreetMap \(Overture sparse here\)$/,
  );
  // Counts too: Overpass's points through the rollup, not Overture's cells.
  viewer.camera.positionCartographic.height = 60_000;
  sparse.layer._settle();
  await flush();
  assert.equal(sparse.asked.at(-1)[0], 'counts');
  assert.match(overpass.queries.at(-1), /out center qt 8000;$/);
  assert.equal(sparse.rollup.options.getCounts(7), null);
  assert.equal(sparse.rollup.options.getPoints().length, 4);
  assert.match(sparse.layer.getRowControls().info, /Overture sparse here/);
  sparse.layer.disable();

  // Overpass not configured: Overture's two stand, and it is not asked again.
  const missing = fakeOverpass(
    new OverpassViewError('unconfigured', 'Not configured'),
  );
  const alone = chargingLayer({ stations: 2, overpass: missing });
  const third = fakeViewer(4_000);
  alone.layer.init(third);
  alone.layer.enable(third);
  await flush();
  assert.equal(missing.queries.length, 1);
  assert.equal(alone.layer._state().held.features.length, 2);
  assert.match(alone.layer.getRowControls().info, /from Overture Maps$/);
  third.camera.positionCartographic.longitude += 0.01;
  third.camera.positionCartographic.latitude += 0.01;
  alone.layer._settle();
  await flush();
  assert.equal(alone.asked.filter(([kind]) => kind === 'pins').length, 2);
  assert.equal(missing.queries.length, 1, 'Overpass asked once');
  assert.match(alone.layer.getRowControls().info, /from Overture Maps$/);
  alone.layer.disable();
});

test('HYDRANTS, STREET LIGHTS and SIGNALS from Overture’s infrastructure when built: their class, its credit, the chip saying so', async () => {
  for (const [asset, below, pattern] of [
    ['hydrant', 4_000, /emergency"="fire_hydrant/],
    ['lamp', 2_000, /highway"="street_lamp/],
    ['signals', 4_000, /highway"="traffic_signals/],
  ]) {
    const overpass = fakeOverpass([]);
    const { layer, asked, credits, rollup } = overtureLayer({
      asset,
      source: 'infrastructure',
      overpass,
    });
    const viewer = fakeViewer(below);
    layer.init(viewer);
    layer.enable(viewer);
    await flush();
    assert.equal(overpass.queries.length, 0, `${asset}: no Overpass`);
    assert.deepEqual(asked.at(-1).slice(0, 2), ['pins', asset]);
    assert.equal(layer._state().held.features.length, 3);
    assert.ok(
      credits.some((credit) => credit.key === 'overture-infrastructure'),
      `${asset}: the ODbL credit`,
    );
    const controls = layer.getRowControls();
    assert.match(controls.info, /from Overture Maps$/);
    assert.match(
      controls.chips.find((chip) => chip.id === `asset-${asset}`).title,
      /\(Overture Maps\)$/,
    );
    // Above the pin height: the index's counts through the rollup.
    viewer.camera.positionCartographic.height = below * 3;
    layer._settle();
    await flush();
    const [kind, res, category] = asked.at(-1);
    assert.deepEqual([kind, category], ['counts', asset]);
    assert.equal(rollup.options.getCounts(res).get('872a1072bffffff'), 7);
    assert.equal(overpass.queries.length, 0);
    layer.disable();

    // Sparse (two in the view): OpenStreetMap for it, said in the row.
    const osm = fakeOverpass(OSM_STATIONS);
    const sparse = overtureLayer({
      asset,
      source: 'infrastructure',
      stations: 2,
      overpass: osm,
    });
    const second = fakeViewer(below);
    sparse.layer.init(second);
    sparse.layer.enable(second);
    await flush();
    assert.match(osm.queries.at(-1), pattern);
    assert.equal(sparse.layer._state().held.features.length, 4);
    assert.match(
      sparse.layer.getRowControls().info,
      /from OpenStreetMap \(Overture sparse here\)$/,
    );
    sparse.layer.disable();

    // Not built: Overpass as before, the chip says OpenStreetMap.
    const plain = fakeOverpass([]);
    const unbuilt = overtureLayer({
      asset,
      source: 'infrastructure',
      configured: false,
      overpass: plain,
    });
    const third = fakeViewer(below);
    unbuilt.layer.init(third);
    unbuilt.layer.enable(third);
    await flush();
    assert.match(plain.queries.at(-1), pattern);
    assert.match(
      unbuilt.layer
        .getRowControls()
        .chips.find((chip) => chip.id === `asset-${asset}`).title,
      /\(OpenStreetMap\)$/,
    );
    unbuilt.layer.disable();
  }
});

test('BIKE LANES stay on Overpass; a type change asks the other index once', async () => {
  const overpass = fakeOverpass([]);
  const { layer, asked } = overtureLayer({
    asset: 'bike',
    source: 'infrastructure',
    overpass,
  });
  const viewer = fakeViewer(4_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  assert.match(overpass.queries.at(-1), /cycleway/);
  assert.equal(asked.length, 0, 'no Overture index for bike lanes');
  // On to signals: the infrastructure index answers.
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'asset-signals')
    .onClick();
  await flush();
  assert.deepEqual(asked.at(-1).slice(0, 2), ['pins', 'signals']);
  layer.disable();
});
