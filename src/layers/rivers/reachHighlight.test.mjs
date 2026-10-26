// Personal fork: the clicked river reach's drawing and card
// (src/layers/rivers/reachHighlight.js, reachCard.js) on a fake viewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  NOTICE_MS,
  REACH_OVERLAY_SOURCE,
  REACH_PICK_PREFIX,
  attachReachClicks,
  attachReachHighlight,
  nearestPoint,
  resolveLink,
  upstreamWidth,
} from './reachHighlight.js';
import {
  distanceText,
  flowText,
  pressureText,
  reachCardDetails,
  reachTitle,
  sizeClass,
  statusText,
} from './reachCard.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';
import { RIVER_REACH_SCHEMA } from '../../data/riverReach.js';
import { setLocale } from '../../i18n/index.js';
import * as pickRegistry from '../../data/pickRegistry.js';

/** Cesium with its scene primitives recorded (no WebGL in Node). */
class GroundPrimitive {
  constructor(options) {
    Object.assign(this, options);
  }
  static isSupported(scene) {
    return scene.frameState.context.depthTexture === true;
  }
}
class FlatPrimitive {
  constructor(options) {
    Object.assign(this, options);
  }
}
const handlers = [];
class FakeHandler {
  constructor(canvas) {
    this.canvas = canvas;
    this.destroyed = false;
    handlers.push(this);
  }
  setInputAction(fn, type) {
    this.action = fn;
    this.type = type;
  }
  destroy() {
    this.destroyed = true;
  }
}
// Cesium's materials need a canvas, which Node has none of.
class MaterialAppearance {
  constructor(options) {
    Object.assign(this, options);
  }
}
const cesium = {
  ...Cesium,
  GroundPolylinePrimitive: GroundPrimitive,
  Primitive: FlatPrimitive,
  ScreenSpaceEventHandler: FakeHandler,
  PolylineMaterialAppearance: MaterialAppearance,
  Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
};

function fakeViewer({ depthTexture = true, pick = null, ground = null } = {}) {
  const collection = () => {
    const items = [];
    return {
      items,
      add: (item) => (items.push(item), item),
      remove: (item) => {
        const i = items.indexOf(item);
        if (i >= 0) items.splice(i, 1);
        return i >= 0;
      },
    };
  };
  return {
    scene: {
      canvas: {},
      groundPrimitives: collection(),
      primitives: collection(),
      frameState: { context: { depthTexture } },
      pick: () => pick,
      pickPositionSupported: false,
    },
    camera: {
      positionCartographic: { height: 50_000 },
      pickEllipsoid: () => ground,
    },
  };
}

function fakeOverlays() {
  const sources = new Map();
  const visible = new Map();
  return {
    sources,
    visible,
    setEntries: (id, entries) => sources.set(id, entries),
    clearSource: (id) => sources.delete(id),
    setVisible: (id, on) => visible.set(id, on),
  };
}

function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    key: (key) => listeners.get('keydown')?.({ key }),
  };
}

/** Timers run by hand. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimer: (fn, ms) => (pending.set(next, { fn, ms }), next++),
    clearTimer: (id) => pending.delete(id),
    runAll() {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

const ANSWER = Object.freeze({
  schema: RIVER_REACH_SCHEMA,
  source: { id: 'hydrorivers-v1' },
  reach: {
    id: 7635839,
    distanceM: 231,
    properties: {
      RIV_ORD: 5,
      DIS_AV_CMS: 75.46,
      LENGTH_KM: 1.812,
      UPLAND_SKM: 9921,
      CSI: 97.04,
      CSI_FF2: 1,
      CSI_D: 'URB',
      BB_NAME: 'Meramec',
      BAS_NAME: 'Mississippi',
      COUNTRY: 'United States',
    },
    geometry: {
      type: 'LineString',
      coordinates: [
        [-90.5, 38.55],
        [-90.49, 38.551],
      ],
    },
  },
  downstream: {
    complete: true,
    terminal: 'ocean',
    reaches: 462,
    lengthKm: 1889.4,
    distanceToMouthKm: 1890.2,
    mouth: [-89.26, 29.11],
    segments: [
      {
        backboneId: 1,
        name: 'Meramec',
        order: 5,
        lengthKm: 41,
        coordinates: [
          [-90.49, 38.551],
          [-90.3, 38.4],
        ],
      },
      {
        backboneId: 2,
        name: 'Missouri',
        order: 2,
        lengthKm: 1848,
        coordinates: [
          [-90.3, 38.4],
          [-89.26, 29.11],
        ],
      },
    ],
  },
  upstream: null,
  links: {
    self: '/api/rivers/reach/hydrorivers-v1/7635839',
    upstream: '/api/rivers/reach/hydrorivers-v1/7635839/upstream',
  },
});
const UPSTREAM = Object.freeze({
  schema: RIVER_REACH_SCHEMA,
  reachId: 7635839,
  upstream: {
    reaches: 3,
    lengthKm: 12,
    maxOrder: 7,
    levels: 4,
    truncated: false,
    lines: [
      {
        backboneId: 1,
        name: 'Meramec',
        order: 5,
        coordinates: [
          [-91, 38],
          [-90.5, 38.55],
        ],
      },
      {
        backboneId: 3,
        name: 'Bourbeuse',
        order: 6,
        coordinates: [
          [-91.2, 38.3],
          [-90.9, 38.2],
        ],
      },
    ],
  },
});

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function fakeFetch(routes) {
  const asked = [];
  const impl = async (url) => {
    asked.push(url);
    for (const [pattern, reply] of routes)
      if (pattern.test(url))
        return typeof reply === 'function' ? reply(url) : reply();
    return json(404, { error: 'Not found' });
  };
  return { asked, impl };
}

function setup({ routes, viewer = fakeViewer(), options = {} } = {}) {
  const overlays = fakeOverlays();
  const documentRef = fakeDocument();
  const timers = fakeTimers();
  const renders = [];
  const fetch = fakeFetch(
    routes || [
      [/\/upstream$/, () => json(200, UPSTREAM)],
      [/\?lat=/, () => json(200, ANSWER)],
    ],
  );
  const picking = {
    owners: new Map(),
    registerPickOwner(id, fn) {
      this.owners.set(id, fn);
    },
    unregisterPickOwner(id) {
      this.owners.delete(id);
    },
  };
  const highlight = attachReachHighlight(
    {
      viewer,
      overlays,
      cesium,
      picking,
      requestRender: (reason) => renders.push(reason),
      fetchImpl: fetch.impl,
      documentRef,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    },
    { debounceMs: 0, ...options },
  );
  return {
    highlight,
    viewer,
    overlays,
    documentRef,
    timers,
    renders,
    fetch,
    picking,
  };
}

const instancesOf = (primitive) => primitive.geometryInstances || [];

test('a click draws the reach and its path to the sea on the ground, then the network above it', async () => {
  const { highlight, viewer, overlays, fetch, picking, renders } = setup();
  assert.equal(overlays.visible.get(REACH_OVERLAY_SOURCE), true);
  assert.ok(
    picking.owners.get(REACH_OVERLAY_SOURCE)(`${REACH_PICK_PREFIX}reach:1`),
  );
  assert.ok(!picking.owners.get(REACH_OVERLAY_SOURCE)('flight:abc'));

  const answer = await highlight.select(38.5501, -90.4901, 50_000);
  assert.equal(answer.reach.id, 7635839);
  const [first] = fetch.asked;
  assert.match(
    first,
    /^\/api\/rivers\/reach\?lat=38\.550100&lon=-90\.490100&heightM=50000$/,
  );
  assert.equal(
    fetch.asked[1],
    '/api/rivers/reach/hydrorivers-v1/7635839/upstream',
  );

  const drawn = viewer.scene.groundPrimitives.items;
  // upstream dashes, casing, downstream, reach: bottom to top.
  assert.equal(drawn.length, 4);
  assert.equal(viewer.scene.primitives.items.length, 0);
  for (const primitive of drawn) {
    assert.ok(primitive instanceof GroundPrimitive);
    assert.equal(primitive.classificationType, Cesium.ClassificationType.BOTH);
  }
  const [up, casing, down, reach] = drawn;
  assert.equal(instancesOf(up).length, 2);
  assert.equal(up.appearance.material.type, 'PolylineDash');
  assert.equal(instancesOf(casing).length, 3, 'two segments and the reach');
  assert.equal(instancesOf(down).length, 2);
  assert.equal(instancesOf(reach).length, 1);
  assert.equal(instancesOf(reach)[0].id, `${REACH_PICK_PREFIX}reach:7635839`);
  assert.ok(
    instancesOf(reach)[0].geometry instanceof Cesium.GroundPolylineGeometry,
  );
  // Width tells them apart as well as colour.
  const width = (primitive) => instancesOf(primitive)[0].geometry.width;
  assert.ok(width(reach) > width(down));
  assert.ok(width(casing) > width(down));
  assert.ok(width(down) >= width(up));
  assert.ok(renders.includes('river-reach-draw'));

  const entries = overlays.sources.get(REACH_OVERLAY_SOURCE);
  assert.deepEqual(
    entries.map((e) => e.id),
    ['card', 'mouth'],
  );
  for (const entry of entries)
    assert.doesNotThrow(() =>
      normalizeOverlayEntry(REACH_OVERLAY_SOURCE, entry),
    );
  const card = entries[0];
  assert.equal(card.variant, 'card');
  assert.equal(card.title, 'Meramec');
  assert.deepEqual(card.details, [
    'Mississippi basin · United States',
    'Small river · 75.5 m³/s average flow',
    'Free-flowing (connectivity 97%)',
    'Slight pressure: urban areas',
    '1,890 km to the sea',
  ]);
  // The card stands on the reach, not at the click.
  const at = Cesium.Cartographic.fromCartesian(card.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.longitude) + 90.49) < 1e-6);
  assert.equal(entries[1].title, 'Mouth');
});

test('Escape, another click and detaching clear it; a stale answer is dropped', async () => {
  const { highlight, viewer, overlays, documentRef, picking } = setup();
  await highlight.select(38.55, -90.49, 50_000);
  assert.ok(viewer.scene.groundPrimitives.items.length > 0);
  documentRef.key('Enter');
  assert.ok(viewer.scene.groundPrimitives.items.length > 0);
  documentRef.key('Escape');
  assert.equal(viewer.scene.groundPrimitives.items.length, 0);
  assert.equal(overlays.sources.has(REACH_OVERLAY_SOURCE), false);
  assert.equal(highlight.state().answer, null);

  // Two clicks in a row: only the second's answer is drawn.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = setup({
    routes: [
      [/lat=1\./, async () => (await gate, json(200, ANSWER))],
      [
        /lat=2\./,
        () => json(200, { ...ANSWER, reach: { ...ANSWER.reach, id: 2 } }),
      ],
    ],
    options: { upstream: false },
  });
  const first = slow.highlight.select(1.5, 1, 1000);
  const second = slow.highlight.select(2.5, 1, 1000);
  release();
  assert.equal(await first, null);
  assert.equal((await second).reach.id, 2);
  assert.equal(slow.highlight.state().answer.reach.id, 2);
  assert.equal(slow.viewer.scene.groundPrimitives.items.length, 3);

  highlight.detach();
  assert.equal(documentRef.listeners.has('keydown'), false);
  assert.equal(picking.owners.has(REACH_OVERLAY_SOURCE), false);
  assert.equal(overlays.visible.get(REACH_OVERLAY_SOURCE), false);
  assert.equal(await highlight.select(1, 1, 1), null, 'detached');
});

test('clicks closer together than the debounce ask only once', async () => {
  const { highlight, timers, fetch } = setup({
    options: { debounceMs: 150, upstream: false },
  });
  const a = highlight.select(1, 1, 1000);
  const b = highlight.select(1.1, 1, 1000);
  assert.equal(timers.pending.size, 1);
  assert.equal(await a, null);
  timers.runAll();
  assert.equal((await b).reach.id, ANSWER.reach.id);
  assert.equal(fetch.asked.length, 1);
  assert.match(fetch.asked[0], /lat=1\.100000/);
});

test('no river here, or a failed lookup, says so on the card and then clears', async () => {
  const miss = setup({
    routes: [[/\?lat=/, () => json(404, { error: 'none' })]],
  });
  assert.equal(await miss.highlight.select(5, 5, 1000), null);
  const [card] = miss.overlays.sources.get(REACH_OVERLAY_SOURCE);
  assert.equal(card.title, 'No river here');
  assert.doesNotThrow(() => normalizeOverlayEntry(REACH_OVERLAY_SOURCE, card));
  assert.equal([...miss.timers.pending.values()][0].ms, NOTICE_MS);
  miss.timers.runAll();
  assert.equal(miss.overlays.sources.has(REACH_OVERLAY_SOURCE), false);

  const down = setup({ routes: [[/\?lat=/, () => json(503, { error: 'x' })]] });
  await down.highlight.select(5, 5, 1000);
  assert.equal(
    down.overlays.sources.get(REACH_OVERLAY_SOURCE)[0].title,
    'River lookups need Earth Engine on the server',
  );
  assert.equal(down.viewer.scene.groundPrimitives.items.length, 0);

  const partial = setup({
    routes: [
      [/\/upstream$/, () => json(502, { error: 'x' })],
      [/\?lat=/, () => json(200, ANSWER)],
    ],
  });
  await partial.highlight.select(5, 5, 1000);
  assert.equal(partial.highlight.state().upstream, 'failed');
  assert.equal(partial.viewer.scene.groundPrimitives.items.length, 3);
  assert.equal(
    partial.overlays.sources.get(REACH_OVERLAY_SOURCE)[0].details.at(-1),
    'The rivers upstream could not be traced',
  );
});

test('without depth textures the lines are drawn flat; another source’s links are followed', async () => {
  const flat = setup({ viewer: fakeViewer({ depthTexture: false }) });
  await flat.highlight.select(1, 1, 1000);
  assert.equal(flat.viewer.scene.groundPrimitives.items.length, 0);
  assert.equal(flat.viewer.scene.primitives.items.length, 4);
  assert.ok(
    flat.viewer.scene.primitives.items.every((p) => p instanceof FlatPrimitive),
  );

  // A local v2 endpoint: its answer's upstream link is on that server.
  const v2 = setup({
    routes: [
      [
        /^http:\/\/127\.0\.0\.1:8790\/reach\/v2\/7\/upstream$/,
        () => json(200, UPSTREAM),
      ],
      [
        /^http:\/\/127\.0\.0\.1:8790\/reach\?lat=/,
        () =>
          json(200, {
            ...ANSWER,
            source: { id: 'hydrosheds-v2' },
            links: { upstream: '/reach/v2/7/upstream' },
          }),
      ],
    ],
    options: { endpoint: 'http://127.0.0.1:8790/reach' },
  });
  await v2.highlight.select(1, 1, 1000);
  assert.equal(v2.fetch.asked.length, 2);
  assert.equal(v2.highlight.state().answer.upstream.reaches, 3);
  assert.equal(resolveLink('/a', '/api/x'), '/a');
  assert.equal(resolveLink('https://h/a', '/api/x'), 'https://h/a');
  assert.equal(resolveLink(null, '/api/x'), null);
});

test('map clicks select there, leave other layers’ objects alone, and clear on the sky', async () => {
  handlers.length = 0;
  const ground = Cesium.Cartesian3.fromDegrees(-90.49, 38.55);
  const selected = [];
  let cleared = 0;
  const highlight = {
    select: (...args) => selected.push(args),
    clear: () => (cleared += 1),
  };
  const viewer = fakeViewer({ ground });
  pickRegistry.registerPickOwner('test-flights', (id) =>
    id.startsWith('flight:'),
  );
  try {
    const detach = attachReachClicks({
      viewer,
      highlight,
      cesium,
      picking: pickRegistry,
      maxOrder: () => 6,
    });
    const [handler] = handlers;
    assert.equal(handler.type, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.action({ position: { x: 1, y: 1 } });
    assert.equal(selected.length, 1);
    const [lat, lon, height, options] = selected[0];
    assert.ok(Math.abs(lat - 38.55) < 1e-6 && Math.abs(lon + 90.49) < 1e-6);
    assert.equal(height, 50_000);
    assert.deepEqual(options, { maxOrder: 6 });

    viewer.scene.pick = () => ({ id: 'flight:abc' });
    handler.action({ position: { x: 1, y: 1 } });
    assert.equal(selected.length, 1, 'a flight is the flights layer’s');
    viewer.scene.pick = () => ({ id: `${REACH_PICK_PREFIX}reach:1` });
    handler.action({ position: { x: 1, y: 1 } });
    assert.equal(selected.length, 2, 'our own line selects again');
    viewer.scene.pick = () => null;
    viewer.camera.pickEllipsoid = () => null;
    handler.action({ position: { x: 1, y: 1 } });
    assert.equal(cleared, 1, 'the sky clears');
    detach();
    assert.equal(handler.destroyed, true);
  } finally {
    pickRegistry.unregisterPickOwner('test-flights');
  }
});

test('the card speaks plainly, and in Spanish and Russian too', () => {
  assert.equal(sizeClass(2), 'Very large river');
  assert.equal(sizeClass(9), 'Brook');
  assert.equal(sizeClass(null), 'River');
  assert.equal(statusText(3), 'Impacted');
  assert.equal(statusText(0), null);
  assert.equal(pressureText('dof'), 'fragmentation by dams');
  assert.equal(pressureText('XYZ'), null);
  assert.equal(flowText(0.134), '0.134 m³/s average flow');
  assert.equal(flowText(2311.03), '2,311 m³/s average flow');
  assert.equal(flowText(-1), null);
  assert.equal(
    distanceText({ terminal: 'inland', distanceToMouthKm: 1137.6 }),
    '1,138 km to an inland sink',
  );
  assert.match(
    distanceText({ terminal: 'unknown', distanceToMouthKm: 10 }),
    /not yet to the end/,
  );
  const unnamed = {
    ...ANSWER,
    reach: {
      ...ANSWER.reach,
      properties: { ...ANSWER.reach.properties, BB_NAME: null },
    },
  };
  assert.equal(reachTitle(unnamed), 'Tributary of Meramec');
  assert.equal(
    reachTitle({ reach: { properties: {} }, downstream: { segments: [] } }),
    'Unnamed river',
  );
  assert.equal(
    reachTitle({
      reach: { properties: { BAS_NAME: 'Volga' } },
      downstream: { segments: [{ name: null }] },
    }),
    'A river of the Volga basin',
  );
  const impacted = {
    ...ANSWER,
    reach: {
      ...ANSWER.reach,
      properties: {
        ...ANSWER.reach.properties,
        CSI: 63.3,
        CSI_FF2: 3,
        CSI_D: 'DOF',
      },
    },
  };
  assert.ok(
    reachCardDetails(impacted).includes('Main pressure: fragmentation by dams'),
  );
  assert.ok(
    reachCardDetails(ANSWER, { upstream: 'loading' })
      .at(-1)
      .startsWith('Tracing'),
  );
  assert.ok(
    reachCardDetails({
      ...ANSWER,
      upstream: { truncated: true, reaches: 2500 },
    })
      .at(-1)
      .includes('2,500'),
  );
  try {
    setLocale('es');
    assert.equal(sizeClass(3), 'Río grande');
    assert.equal(reachTitle(unnamed), 'Afluente del río Meramec');
    setLocale('ru');
    assert.equal(statusText(1), 'Свободнотекущая');
    assert.match(
      distanceText({ terminal: 'ocean', distanceToMouthKm: 5 }),
      /км до моря/,
    );
  } finally {
    setLocale('en');
  }
});

test('helpers: the nearest point and upstream widths', () => {
  assert.deepEqual(
    nearestPoint(
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      1.2,
      0.9,
    ),
    [1, 1],
  );
  assert.equal(nearestPoint([], 0, 0), null);
  assert.equal(upstreamWidth(5, 5), 3);
  assert.ok(upstreamWidth(7, 5) < upstreamWidth(6, 5));
  assert.equal(upstreamWidth(10, 1), 1.5);
});

test('a name-only answer: the waterway’s name on the card at the click, nothing drawn or traced', async () => {
  // Stony Run, Baltimore: no HydroRIVERS reach within 400 m, OSM's stream 131 m off.
  const NAME_ONLY = {
    schema: RIVER_REACH_SCHEMA,
    source: { id: 'hydrorivers-v1', name: 'HydroRIVERS', attribution: '' },
    query: {
      lat: 39.3268,
      lon: -76.6268,
      heightM: 3000,
      toleranceM: 400,
      maxOrder: 10,
    },
    nameOnly: true,
    reach: null,
    osmName: {
      name: 'Stony Run',
      waterway: 'stream',
      confidence: 'direct',
      distanceM: 131,
      radiusM: 150,
    },
    downstream: null,
    upstream: null,
    links: null,
  };
  const s = setup({ routes: [[/\?lat=/, () => json(200, NAME_ONLY)]] });
  const answer = await s.highlight.select(39.3268, -76.6268, 3000);
  assert.equal(answer.nameOnly, true);
  const entries = s.overlays.sources.get(REACH_OVERLAY_SOURCE);
  assert.equal(entries.length, 1, 'the card, no mouth label');
  const [card] = entries;
  assert.equal(card.title, 'Stony Run');
  assert.deepEqual(card.details, [
    'Name only: no HydroRIVERS reach within 400 m to trace',
    'The waterway is 131 m from the click',
    'Name from OpenStreetMap (© OpenStreetMap contributors, ODbL)',
  ]);
  assert.doesNotThrow(() => normalizeOverlayEntry(REACH_OVERLAY_SOURCE, card));
  assert.equal(s.viewer.scene.groundPrimitives.items.length, 0, 'no highlight');
  assert.equal(s.fetch.asked.length, 1, 'no upstream asked for');
  assert.equal(s.timers.pending.size, 0, 'a card that stays, not a notice');
  // Live names say they are a nearby waterway's; and in Spanish and Russian.
  assert.deepEqual(
    reachCardDetails({
      ...NAME_ONLY,
      osmName: { ...NAME_ONLY.osmName, confidence: 'live' },
    }).at(-1),
    'Name from OpenStreetMap (nearby waterway), © OpenStreetMap contributors, ODbL',
  );
  assert.equal(
    reachCardDetails({ nameOnly: true, osmName: { name: 'X' } })[0],
    'Name only: no HydroRIVERS reach near enough to trace',
  );
  try {
    setLocale('es');
    assert.match(reachCardDetails(NAME_ONLY)[0], /^Solo el nombre: .*400 m/);
    setLocale('ru');
    assert.match(reachCardDetails(NAME_ONLY)[0], /^Только название: .*400 м/);
  } finally {
    setLocale('en');
  }
});
