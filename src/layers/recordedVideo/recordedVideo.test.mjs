import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  SEARCH_MAX_HEIGHT_M,
  createRecordedVideoLayer,
  toRecord,
  viewQuery,
} from './index.js';
import { captionFor } from './player.js';

const wikidata = {
  videoId: 'aBcDeFgHiJk',
  title: 'Francis Scott Key Bridge collapse',
  place: 'Francis Scott Key Bridge collapse',
  wikidataId: 'Q125145943',
  lat: 39.2156,
  lon: -76.5302,
  coordinatesQuality: 'site',
  source: 'wikidata',
};
const geotag = (videoId, coordinatesQuality = 'site', extra = {}) => ({
  videoId,
  title: `Video ${videoId}`,
  channelTitle: 'Channel',
  publishedAt: '2026-10-01T00:00:00Z',
  lat: 39.29,
  lon: -76.61,
  coordinatesQuality,
  sharedBy: coordinatesQuality === 'site' ? 0 : 8,
  source: 'youtube-geotag',
  ...extra,
});

test('server videos become layer records, re-checked on the way in', () => {
  assert.equal(toRecord(wikidata).id, 'wd-Q125145943-aBcDeFgHiJk');
  assert.equal(toRecord(geotag('bbbbbbbbbbb')).id, 'yt-bbbbbbbbbbb');
  assert.equal(
    toRecord(geotag('bbbbbbbbbbb', 'exact')).coordinatesQuality,
    'region',
    'unknown precision is the faintest',
  );
  assert.equal(toRecord({ ...wikidata, videoId: 'bad' }), null);
  assert.equal(toRecord({ ...wikidata, lat: 95 }), null);
  assert.equal(
    toRecord({ ...wikidata, source: 'elsewhere' }).source,
    'youtube-geotag',
  );
});

test('a settled view asks for its centre with a radius from its height', () => {
  assert.equal(viewQuery(39.29, -76.61, 60_000), null, 'too high');
  assert.equal(viewQuery(39.29, -76.61, -5), null);
  assert.deepEqual(viewQuery(39.29, -76.61, 25_000), {
    lat: 39.29,
    lon: -76.61,
    radiusKm: 25,
    cell: '786,-1532,25',
  });
  assert.equal(viewQuery(39.29, -76.61, 800).radiusKm, 2);
  assert.equal(viewQuery(39.29, -76.61, 49_900).radiusKm, 50);
  assert.equal(
    viewQuery(39.29, -76.61, 21_000).cell,
    viewQuery(39.291, -76.611, 24_000).cell,
    'same cell and band',
  );
});

test('the caption says where, how precisely and when', () => {
  assert.equal(
    captionFor(toRecord(wikidata)),
    'Francis Scott Key Bridge collapse · Wikidata · SITE',
  );
  assert.equal(
    captionFor(
      toRecord(
        geotag('ccccccccccc', 'region', {
          place: 'Baltimore',
          recordedAt: '2026-09-30T12:00:00Z',
        }),
      ),
    ),
    'Baltimore · geotag · REGION (shared by 8) · Channel · 2026-09-30',
  );
});

/** A viewer with real Cesium data sources and a scriptable camera. */
function fakeViewer() {
  const dataSources = [];
  const listeners = [];
  let height = 2_000_000;
  const viewer = {
    dataSources: {
      add: (ds) => dataSources.push(ds),
      remove: (ds) => {
        const i = dataSources.indexOf(ds);
        if (i >= 0) dataSources.splice(i, 1);
      },
    },
    scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(-76.61, 39.29, height);
      },
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-76.61, 39.29),
      moveEnd: {
        addEventListener(fn) {
          listeners.push(fn);
          return () => listeners.splice(listeners.indexOf(fn), 1);
        },
      },
    },
  };
  return {
    viewer,
    dataSources,
    listeners,
    setHeight: (h) => (height = h),
    settle: () => listeners.forEach((fn) => fn()),
  };
}

function fakeApi() {
  const calls = [];
  let near = {
    videos: [
      geotag('ddddddddddd', 'site'),
      geotag('eeeeeeeeeee', 'area'),
      geotag('aBcDeFgHiJk', 'region'),
      geotag('fffffffffff', 'region'),
    ],
  };
  let hold = null;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/wikidata'))
      return Response.json({ videos: [wikidata] });
    if (hold) await hold;
    return Response.json(near);
  };
  return {
    fetchImpl,
    calls,
    nearCalls: () => calls.filter((u) => u.includes('near=')),
    setNear: (body) => (near = body),
    holdNear: () => {
      let release;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

function fakeOverlay() {
  const state = { visible: {}, entries: {} };
  return {
    state,
    setVisible: (id, v) => (state.visible[id] = v),
    clearSource: (id) => (state.entries[id] = []),
    setEntries: (id, entries) => (state.entries[id] = entries),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the layer loads Wikidata on enable, searches settled low views once per cell, and plays a picked pin', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { viewer, dataSources, listeners, setHeight, settle } = fakeViewer();
  const api = fakeApi();
  const overlay = fakeOverlay();
  const opened = [];
  let closed = 0;
  const player = {
    open: (record) => opened.push(record),
    close: () => closed++,
    isOpen: () => opened.length > 0,
  };
  let pick = null;
  let clickRemoved = 0;
  const timers = [];
  const layer = createRecordedVideoLayer({
    overlayHost: overlay,
    fetchImpl: api.fetchImpl,
    player,
    createClickHandler: (v, onPick) => {
      assert.equal(v, viewer);
      pick = onPick;
      return () => clickRemoved++;
    },
    setTimeoutImpl: (fn) => (timers.push(fn), fn),
    clearTimeoutImpl: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const runTimers = async () => {
    while (timers.length) timers.shift()();
    await flush();
    await flush();
  };
  assert.equal(layer.id, 'recorded-video');
  layer.init(viewer);
  assert.equal(dataSources.length, 1);
  assert.equal(dataSources[0].show, false);
  assert.equal(await layer.update(), false, 'nothing loads while off');

  layer.enable(viewer);
  assert.equal(dataSources[0].show, true);
  assert.equal(listeners.length, 1);
  assert.equal(overlay.state.visible['recorded-video'], true);
  assert.equal(await layer.update(), true);
  assert.equal(
    await layer.update(),
    false,
    'Wikidata is loaded once a day at most',
  );
  assert.equal(dataSources[0].entities.values.length, 1);

  // High above: no search.
  await runTimers();
  assert.equal(api.nearCalls().length, 0);
  // Below 50 km: one search for the view, merged into the pins.
  setHeight(SEARCH_MAX_HEIGHT_M / 2);
  settle();
  await runTimers();
  assert.equal(api.nearCalls().length, 1);
  assert.match(api.nearCalls()[0], /near=39\.2900,-76\.6100&radiusKm=25/);
  const entities = dataSources[0].entities.values;
  assert.equal(
    entities.length,
    4,
    'the geotag of a Wikidata video is not a second pin',
  );
  const point = (videoId) =>
    entities.find((e) => e.properties.videoId.getValue() === videoId).point;
  const alpha = (videoId) => point(videoId).color.getValue().alpha;
  assert.equal(alpha('ddddddddddd'), 1, 'site: solid');
  assert.equal(alpha('eeeeeeeeeee'), 0, 'area: hollow');
  assert.ok(
    alpha('fffffffffff') > 0 && alpha('fffffffffff') < 0.5,
    'region: faint',
  );
  assert.equal(
    overlay.state.entries['recorded-video'].length,
    0,
    'no labels from 25 km',
  );
  setHeight(5000);
  settle();
  assert.ok(
    overlay.state.entries['recorded-video'].length > 0,
    'labels when this close',
  );
  await runTimers();
  setHeight(SEARCH_MAX_HEIGHT_M / 2);
  assert.deepEqual(layer.getStats(), {
    count: 4,
    wikidata: 1,
    'youtube-geotag': 3,
    refused: false,
    error: null,
  });

  // The same cell again: no new search.
  settle();
  await runTimers();
  assert.equal(api.nearCalls().length, 2, 'the 5 km view was its own cell');

  // One request in flight; the newest settled view goes next.
  const release = api.holdNear();
  viewer.camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(-76.3, 39.5);
  settle();
  await runTimers();
  viewer.camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(-76.0, 39.7);
  settle();
  await runTimers();
  assert.equal(api.nearCalls().length, 3);
  release();
  await flush();
  await flush();
  await flush();
  assert.equal(api.nearCalls().length, 4);

  // A pick on one of our pins plays it; anything else is ignored.
  pick({ id: 'cctv:somewhere' });
  assert.equal(opened.length, 0);
  pick({ id: 'recorded-video:yt-ddddddddddd' });
  assert.equal(opened[0].videoId, 'ddddddddddd');

  layer.disable();
  assert.equal(dataSources[0].show, false);
  assert.equal(listeners.length, 0);
  assert.equal(clickRemoved, 1);
  assert.equal(closed, 1, 'the player closes with the layer');
  pick?.({ id: 'recorded-video:yt-ddddddddddd' });
  assert.equal(opened.length, 1, 'no playback while off');

  layer.destroy(viewer);
  assert.equal(dataSources.length, 0);
  assert.equal(layer.getStats().count, 0);
});

test('a refused or failed search can be asked again later', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { viewer, setHeight, settle } = fakeViewer();
  const api = fakeApi();
  const timers = [];
  const layer = createRecordedVideoLayer({
    fetchImpl: async (url) =>
      String(url).includes('near=')
        ? (api.calls.push(String(url)),
          Response.json({ error: 'budget', videos: [] }, { status: 429 }))
        : api.fetchImpl(url),
    player: { open() {}, close() {} },
    createClickHandler: () => () => {},
    setTimeoutImpl: (fn) => (timers.push(fn), fn),
    clearTimeoutImpl: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  setHeight(10_000);
  for (let i = 0; i < 2; i++) {
    settle();
    while (timers.length) timers.shift()();
    await flush();
    await flush();
  }
  assert.equal(api.nearCalls().length, 2);
  assert.equal(layer.getStats().refused, true);
  layer.destroy(viewer);
});

test('the panel hears of changes, focuses a record and asks for the view again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { viewer, setHeight, settle } = fakeViewer();
  const flights = [];
  viewer.camera.flyTo = (options) => flights.push(options);
  const api = fakeApi();
  const opened = [];
  const timers = [];
  const layer = createRecordedVideoLayer({
    fetchImpl: api.fetchImpl,
    player: { open: (r) => opened.push(r), close() {} },
    createClickHandler: () => () => {},
    setTimeoutImpl: (fn) => (timers.push(fn), fn),
    clearTimeoutImpl: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const runTimers = async () => {
    while (timers.length) timers.shift()();
    await flush();
    await flush();
  };
  let heard = 0;
  const unsubscribe = layer.subscribe(() => heard++);
  layer.init(viewer);
  assert.equal(layer.isEnabled(), false);
  assert.equal(layer.viewCentre(), null);
  assert.equal(layer.searchAgain(), false, 'off: nothing to search');
  layer.enable(viewer);
  await flush();
  assert.ok(heard >= 1, 'enable is heard');
  await layer.update();
  setHeight(20_000);
  settle();
  await runTimers();
  assert.equal(api.nearCalls().length, 1);
  assert.deepEqual(layer.quota(), null, 'the fake answer carries no budget');
  assert.equal(layer.lastSearch().cached, false);
  const before = heard;

  // SEARCH AGAIN: the same cell, asked with refresh=1; its geotags replaced.
  api.setNear({
    videos: [geotag('ggggggggggg', 'site')],
    cached: false,
    quota: { used: 303, budget: 1000, remaining: 697 },
  });
  assert.equal(layer.searchAgain(), true);
  await flush();
  await flush();
  assert.equal(api.nearCalls().length, 2);
  assert.match(api.nearCalls()[1], /&refresh=1$/);
  assert.deepEqual(
    layer
      .records()
      .map((r) => r.videoId)
      .sort(),
    ['aBcDeFgHiJk', 'ggggggggggg'],
    'the old geotags of this view went; Wikidata stays',
  );
  assert.deepEqual(layer.quota(), { used: 303, budget: 1000, remaining: 697 });
  assert.ok(heard > before);
  // Too high to search: SEARCH AGAIN says no.
  setHeight(80_000);
  assert.equal(layer.searchAgain(), false);

  // A row's record: fly to the pin and play it.
  const record = layer.records().find((r) => r.videoId === 'ggggggggggg');
  layer.focus(record);
  assert.equal(opened[0], record);
  assert.equal(flights.length, 1);
  const carto = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(carto.latitude) - record.lat) < 1e-6,
  );
  unsubscribe();
  layer.disable();
  layer.focus(record);
  assert.equal(opened.length, 1, 'nothing plays while off');
  layer.destroy(viewer);
});
