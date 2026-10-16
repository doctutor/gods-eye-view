// Personal fork: the Google indoor-views Street Level provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGoogleIndoorProvider } from './index.js';
import { createGoogleIndoorSource } from './source.js';
import { createGoogleIndoorViewer } from './viewer.js';
import { fetchRadiusM, shouldProbe } from './coverage.js';
import {
  COVERAGE_DEBOUNCE_MS,
  PICK_PREFIX,
  embedUrl,
  isPanoId,
  panoDateMs,
  panoExternalUrl,
} from './policy.js';
import { createMapillaryProvider } from '../mapillary/index.js';
import { validateProviders } from '../../registry.js';
import { PROVIDER_COLORS } from '../../policy.js';
import { createStreetLevelLayer } from '../../index.js';
import { rayCamera } from '../../../../testSupport/streetLevelFakes.mjs';

const PANO = 'CAoSLEFGMVFpcE1abc_-123';
const BALTIMORE = { lat: 39.2904, lon: -76.6122 };

function hit(overrides = {}) {
  return {
    panoId: PANO,
    placeId: 'p1',
    name: 'Peabody Library',
    lat: BALTIMORE.lat,
    lon: BALTIMORE.lon,
    panoDate: '2019-05',
    copyright: '© A Photographer',
    checkedAt: 1,
    ...overrides,
  };
}

function fakeSource({
  status = { configured: true, remainingToday: 100 },
  near = { hits: [], unprobedCells: 0 },
  probe = { ok: true, hits: [], newHits: [] },
  key = 'browser-key',
} = {}) {
  const calls = { status: 0, near: [], probe: [] };
  return {
    calls,
    embedKey: () => key,
    getStatus: async () => {
      calls.status++;
      if (status instanceof Error) throw status;
      return status;
    },
    hitsNear: async (query) => {
      calls.near.push(query);
      return typeof near === 'function' ? near(query) : near;
    },
    probe: async (query) => {
      calls.probe.push(query);
      return typeof probe === 'function' ? probe(query) : probe;
    },
  };
}

function fakeContext({ filter = { pano: 'all', sinceMs: null } } = {}) {
  const opened = [];
  let notified = 0;
  return {
    opened,
    notified: () => notified,
    services: {},
    getFilter: () => filter,
    isActive: () => true,
    notify: () => notified++,
    actions: {
      openImage: (id) => opened.push(id),
      reportError() {},
    },
  };
}

function fakeViewer(altitude) {
  const added = [];
  return {
    added,
    camera: Object.assign(rayCamera({ ...BALTIMORE, altitude, pitch: -90 }), {
      moveEnd: new Cesium.Event(),
      changed: new Cesium.Event(),
    }),
    scene: {
      canvas: { clientWidth: 1600, clientHeight: 900 },
      primitives: {
        add: (p) => added.push(p),
        remove: (p) => added.splice(added.indexOf(p), 1),
      },
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('the definition satisfies the contract next to Mapillary and starts off', () => {
  const def = createGoogleIndoorProvider({ source: fakeSource() });
  const mapillary = createMapillaryProvider({
    source: {
      hasToken: () => true,
      getStatus: async () => ({ configured: true }),
      getTile: async () => new Uint8Array(0),
      getSequenceImages: async () => [],
      nearestImages: async () => [],
    },
  });
  assert.doesNotThrow(() => validateProviders([mapillary, def]));
  assert.equal(def.id, 'gsv-indoor');
  assert.equal(def.name, 'Google indoor views');
  assert.equal(def.pickPrefix, 'gsv-indoor:');
  assert.equal(def.requiresKeyId, 'google-maps');
  assert.equal(def.credit.html, 'Street View imagery © Google');
  assert.equal(def.colors.coverage, PROVIDER_COLORS['gsv-indoor']);
  assert.notEqual(def.colors.coverage, PROVIDER_COLORS.mapillary);
  assert.equal(def.defaultOn, false);
  assert.throws(() => createGoogleIndoorProvider({ source: {} }), /source/);

  const layer = createStreetLevelLayer({ providers: [mapillary, def] });
  const switches = Object.fromEntries(
    layer.getUIState().providers.map((p) => [p.id, p.on]),
  );
  assert.deepEqual(switches, { mapillary: true, 'gsv-indoor': false });
  layer.setParams({ providerSwitches: 'gsv-indoor-1' });
  assert.equal(
    layer.getUIState().providers.find((p) => p.id === 'gsv-indoor').on,
    true,
  );
});

test('the viewer frames only the Maps Embed URL for a valid panorama id', () => {
  assert.equal(
    embedUrl('k ey', PANO),
    `https://www.google.com/maps/embed/v1/streetview?key=k%20ey&pano=${PANO}`,
  );
  for (const bad of [
    '',
    'short',
    '../../../maps',
    `${PANO}&q=x`,
    `${PANO}#`,
    'a'.repeat(65),
    null,
    42,
  ]) {
    assert.equal(isPanoId(bad), false, String(bad));
    assert.equal(embedUrl('key', bad), null, String(bad));
  }
  assert.equal(embedUrl('', PANO), null);
  assert.equal(
    panoExternalUrl(PANO),
    `https://www.google.com/maps/@?api=1&map_action=pano&pano=${PANO}`,
  );
  assert.equal(panoExternalUrl('bad id'), 'https://www.google.com/maps');
  assert.equal(panoDateMs('2019-05'), Date.UTC(2019, 4, 1));
  assert.equal(panoDateMs(null), null);
});

test('status maps the server answer and the browser key', async () => {
  const ready = createGoogleIndoorProvider({ source: fakeSource() }).create(
    fakeContext(),
  );
  assert.deepEqual(await ready.status(), { configured: true });

  const denied = createGoogleIndoorProvider({
    source: fakeSource({
      status: {
        configured: false,
        message: 'enable "Street View Static API"',
      },
    }),
  }).create(fakeContext());
  assert.deepEqual(await denied.status(), { configured: false });
  assert.match(denied.coverageStats().error, /Street View Static API/);

  const keyless = createGoogleIndoorProvider({
    source: fakeSource({ key: '' }),
  }).create(fakeContext());
  await keyless.status();
  assert.equal(keyless.coverageStats().keyRequired, true);

  const offline = createGoogleIndoorProvider({
    source: fakeSource({ status: new Error('offline') }),
  }).create(fakeContext());
  assert.deepEqual(await offline.status(), { configured: false });
});

test('coverage draws database hits and probes unexplored ground when zoomed in', async () => {
  const source = fakeSource({
    near: { hits: [hit()], unprobedCells: 4 },
    probe: {
      ok: true,
      hits: [hit(), hit({ panoId: 'second_pano_id_1234', name: 'Hall' })],
      newHits: [hit({ panoId: 'second_pano_id_1234' })],
      usage: { remainingToday: 90 },
    },
  });
  const context = fakeContext();
  const provider = createGoogleIndoorProvider({ source }).create(context);
  const viewer = fakeViewer(1200);
  provider.init(viewer);
  provider.activate(viewer);
  await provider.status();
  await settle();
  assert.equal(source.calls.near.length >= 1, true);
  const query = source.calls.near.at(-1);
  assert.ok(Math.abs(query.lat - BALTIMORE.lat) < 0.01);
  assert.equal(query.radiusKm, fetchRadiusM(1200) / 1000);
  assert.equal(source.calls.probe.length, 1, 'one probe for the view centre');
  assert.equal(source.calls.probe[0].radiusKm, 0.5);
  assert.equal(provider.coverageStats().count, 2);
  const collection = viewer.added.at(-1);
  assert.ok(collection instanceof Cesium.PointPrimitiveCollection);
  const ids = Array.from(
    { length: collection.length },
    (_, i) => collection.get(i).id,
  );
  assert.deepEqual(ids.sort(), [
    `${PICK_PREFIX.pano}${PANO}`,
    `${PICK_PREFIX.pano}second_pano_id_1234`,
  ]);

  // Switched off: the pins go.
  provider.deactivate();
  assert.equal(viewer.added.length, 0);
});

test('coverage does not probe from high up, and never two at once', async () => {
  const high = fakeSource({ near: { hits: [], unprobedCells: 9 } });
  const provider = createGoogleIndoorProvider({ source: high }).create(
    fakeContext(),
  );
  const viewer = fakeViewer(8000);
  provider.activate(viewer);
  await provider.status();
  await settle();
  assert.ok(high.calls.near.length >= 1);
  assert.equal(high.calls.probe.length, 0);

  let release;
  const slow = fakeSource({
    near: { hits: [], unprobedCells: 3 },
    probe: () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, hits: [] });
      }),
  });
  const low = createGoogleIndoorProvider({ source: slow }).create(
    fakeContext(),
  );
  const lowViewer = fakeViewer(800);
  low.activate(lowViewer);
  await low.status();
  await settle();
  await low.refreshCoverage();
  await settle();
  assert.equal(slow.calls.probe.length, 1);
  assert.equal(low.coverageStats().loading, true);
  release();
  await settle();
  assert.equal(low.coverageStats().loading, false);
  low.deactivate();
});

test('a refused probe surfaces the reason and holds further probes', async () => {
  const source = fakeSource({
    near: { hits: [], unprobedCells: 3 },
    probe: {
      ok: false,
      configured: false,
      reason: 'not_enabled',
      error: 'enable "Street View Static API"',
      hits: [],
    },
  });
  const provider = createGoogleIndoorProvider({ source }).create(fakeContext());
  provider.activate(fakeViewer(900));
  await provider.status();
  await settle();
  assert.equal(source.calls.probe.length, 1);
  assert.match(provider.coverageStats().error, /Street View Static API/);
  await provider.refreshCoverage();
  await settle();
  assert.equal(source.calls.probe.length, 1, 'held back');
  provider.deactivate();
});

test('the probe decision and fetch radius', () => {
  const base = {
    heightM: 1000,
    unprobedCells: 2,
    probing: false,
    holdUntil: 0,
    now: 10,
    remainingToday: 5,
  };
  assert.equal(shouldProbe(base), true);
  assert.equal(shouldProbe({ ...base, heightM: 3500 }), false);
  assert.equal(shouldProbe({ ...base, unprobedCells: 0 }), false);
  assert.equal(shouldProbe({ ...base, probing: true }), false);
  assert.equal(shouldProbe({ ...base, holdUntil: 20 }), false);
  assert.equal(shouldProbe({ ...base, remainingToday: 0 }), false);
  assert.equal(shouldProbe({ ...base, remainingToday: undefined }), true);
  assert.equal(fetchRadiusM(100), 400);
  assert.equal(fetchRadiusM(2000), 3000);
  assert.equal(fetchRadiusM(1e6), 8000);
  assert.ok(COVERAGE_DEBOUNCE_MS > 0);
});

test('picks open panoramas; nearestImage finds the closest hit that passes the filter', async () => {
  const context = fakeContext();
  const source = fakeSource({
    near: {
      hits: [
        hit({ panoId: 'near_pano_id_0001', lat: BALTIMORE.lat + 0.0005 }),
        hit({ panoId: 'far_pano_id_00002', lat: BALTIMORE.lat + 0.01 }),
      ],
      unprobedCells: 0,
    },
  });
  const provider = createGoogleIndoorProvider({ source }).create(context);
  provider.activate(fakeViewer(1500));
  await provider.status();
  await settle();
  assert.equal(provider.handlePick(`${PICK_PREFIX.pano}${PANO}`), true);
  assert.equal(provider.handlePick(`${PICK_PREFIX.pano}bad id`), false);
  assert.equal(provider.handlePick('mly:img:1'), false);
  assert.deepEqual(context.opened, [PANO]);
  assert.equal(await provider.nearestImage(BALTIMORE), 'near_pano_id_0001');
  assert.equal(
    await provider.nearestImage({ ...BALTIMORE, lat: BALTIMORE.lat - 0.02 }),
    null,
  );

  const flat = fakeContext({ filter: { pano: 'flat', sinceMs: null } });
  const flatProvider = createGoogleIndoorProvider({ source }).create(flat);
  flatProvider.activate(fakeViewer(1500));
  await flatProvider.status();
  await settle();
  assert.equal(await flatProvider.nearestImage(BALTIMORE), null);
  assert.equal(flatProvider.coverageStats().count, 0);
  const recent = fakeContext({
    filter: { pano: 'all', sinceMs: Date.UTC(2020, 0, 1) },
  });
  const recentProvider = createGoogleIndoorProvider({ source }).create(recent);
  recentProvider.activate(fakeViewer(1500));
  await recentProvider.status();
  await settle();
  assert.equal(await recentProvider.nearestImage(BALTIMORE), null);
});

/** Just enough DOM for the iframe adapter: setting `src` fires `load`. */
function fakeDom() {
  const make = (tag) => {
    const listeners = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      style: {},
      attributes: {},
      children: [],
      parent: null,
      isConnected: true,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      appendChild(child) {
        child.parent = this;
        this.children.push(child);
      },
      remove() {
        this.parent?.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
        this.isConnected = false;
      },
      addEventListener: (type, fn) => type === 'load' && listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
    };
    let src = '';
    Object.defineProperty(el, 'src', {
      get: () => src,
      set(value) {
        src = value;
        queueMicrotask(() => [...listeners].forEach((fn) => fn()));
      },
    });
    return el;
  };
  const doc = {
    createElement: make,
    defaultView: { getComputedStyle: () => ({ position: 'static' }) },
  };
  const host = make('div');
  host.ownerDocument = doc;
  return { host };
}

test('the iframe adapter opens the embed and emits a pose from the hit', async () => {
  const { host } = fakeDom();
  const viewer = createGoogleIndoorViewer({
    source: { embedKey: () => 'browser-key' },
    lookup: (id) => (id === PANO ? hit() : null),
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  await assert.rejects(viewer.open(PANO), /not mounted/);
  await viewer.mount(host);
  await viewer.mount(host);
  assert.equal(host.children.length, 1, 'mount is idempotent');
  assert.equal(host.style.position, 'relative');
  const frame = host.children[0].children[0];
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(
    frame.attributes.referrerpolicy,
    'strict-origin-when-cross-origin',
  );
  await viewer.open(PANO);
  assert.equal(frame.src, embedUrl('browser-key', PANO));
  assert.equal(poses.length, 1);
  assert.deepEqual(poses[0], {
    providerId: 'gsv-indoor',
    imageId: PANO,
    position: { lon: BALTIMORE.lon, lat: BALTIMORE.lat },
    bearing: null,
    tilt: 0,
    altitude: null,
    isPano: true,
    capturedAt: Date.UTC(2019, 4, 1),
    creator: 'A Photographer',
    sequenceId: null,
    externalUrl: panoExternalUrl(PANO),
  });
  await assert.rejects(viewer.open('javascript:alert(1)'), /panorama id/);
  assert.equal(frame.src, embedUrl('browser-key', PANO));
  viewer.close();
  assert.equal(frame.src, 'about:blank');
  viewer.unmount();
  assert.equal(host.children.length, 0);
  assert.ok(!host.style.position, 'the host position is restored');

  const keyless = createGoogleIndoorViewer({ source: { embedKey: () => '' } });
  await keyless.mount(fakeDom().host);
  await assert.rejects(keyless.open(PANO), /GOOGLE_MAPS_API_KEY/);
});

test('the source calls the local routes', async () => {
  const requests = [];
  const source = createGoogleIndoorSource({
    apiKey: ' key ',
    fetchImpl: async (url, init = {}) => {
      requests.push([url, init.method || 'GET', init.body || null]);
      if (url.endsWith('/probe'))
        return { ok: false, status: 409, json: async () => ({ busy: true }) };
      if (url.includes('fail'))
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'boom' }),
        };
      return { ok: true, status: 200, json: async () => ({ hits: [] }) };
    },
  });
  assert.equal(source.embedKey(), 'key');
  await source.getStatus();
  await source.hitsNear({ lat: 39.29041234, lon: -76.6122, radiusKm: 1.23456 });
  assert.deepEqual(await source.probe({ lat: 1, lon: 2, radiusKm: 0.5 }), {
    busy: true,
  });
  assert.deepEqual(requests, [
    ['/api/streetview/indoor/status', 'GET', null],
    [
      '/api/streetview/indoor?near=39.290412%2C-76.612200&radiusKm=1.235',
      'GET',
      null,
    ],
    [
      '/api/streetview/indoor/probe',
      'POST',
      '{"lat":1,"lon":2,"radiusKm":0.5}',
    ],
  ]);
  const failing = createGoogleIndoorSource({
    route: '/fail',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }),
  });
  await assert.rejects(failing.getStatus(), /boom/);
});
