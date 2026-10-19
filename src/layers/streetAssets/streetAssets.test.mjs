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

test('EV charging from the Overture places index when it is built, OpenStreetMap when not', async () => {
  const queries = [];
  const overpass = {
    query: async (q) => (queries.push(q), { elements: [] }),
    abort: () => {},
  };
  const asked = [];
  let configured = true;
  const places = {
    status: async () =>
      configured
        ? { configured: true, version: 'abcdef012345', places: 9 }
        : { configured: false },
    pins: async (q) => {
      asked.push(['pins', q.category, q.minConfidence, q.box]);
      return {
        places: [{ id: 'pl:1:2:3', at: [-76.61, 39.29] }],
        count: 1,
        saturated: false,
      };
    },
    counts: async (q) => {
      asked.push(['counts', q.res, q.category]);
      return new Map([['872a1072bffffff', 7]]);
    },
    abort: () => {},
  };
  const credits = [];
  let rollup = null;
  const make = () =>
    createStreetAssetsLayer({
      overpass,
      places,
      credits: { register: (_viewer, credit) => credits.push(credit) },
      storage: { getItem: () => 'charging', setItem() {} },
      setTimeoutImpl: (fn) => (fn(), 0),
      clearTimeoutImpl: () => {},
      attachRollup: (_owner, options) =>
        (rollup = {
          options,
          refresh() {},
          detach() {},
          isActive: () => false,
        }),
    });
  const layer = make();
  const viewer = fakeViewer(4_000);
  layer.init(viewer);
  layer.enable(viewer);
  await flush();
  assert.equal(queries.length, 0, 'no Overpass');
  const [kind, category, floor, box] = asked.at(-1);
  assert.deepEqual([kind, category, floor], ['pins', 'charging', 0.5]);
  assert.ok(box.east - box.west < 1 && box.north - box.south < 1);
  assert.equal(layer._state().held.features.length, 1);
  assert.ok(credits.some((credit) => /Overture/.test(JSON.stringify(credit))));
  assert.match(layer.getRowControls().info, /from Overture Maps/);
  // Above the pin height: the server's counts through the rollup.
  viewer.camera.positionCartographic.height = 60_000;
  layer._settle();
  await flush();
  const [, res] = asked.at(-1);
  assert.equal(rollup.options.getCounts(res).get('872a1072bffffff'), 7);
  assert.equal(rollup.options.getCounts(res + 1).size, 0);
  layer.disable();
  // Not built: Overpass as before.
  configured = false;
  const fallback = make();
  const second = fakeViewer(4_000);
  fallback.init(second);
  fallback.enable(second);
  await flush();
  assert.match(queries.at(-1), /amenity"="charging_station"/);
  fallback.disable();
});
