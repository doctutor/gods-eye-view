import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  LANDMARK_MAX_HEIGHT_M,
  SEARCH_MAX_HEIGHT_M,
  createRecordedVideoLayer,
  toRecord,
  viewQuery,
} from './index.js';
import { captionFor, embedAt } from './player.js';

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
  let landmarks = { landmarks: [], pending: 0 };
  let landmarkVideos = { videos: [] };
  let mentions = { mentions: [] };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/wikidata'))
      return Response.json({ videos: [wikidata] });
    if (String(url).startsWith('/api/video/landmark/near'))
      return Response.json(landmarks);
    if (String(url).startsWith('/api/video/landmark/mentions'))
      return Response.json(mentions);
    if (String(url).startsWith('/api/video/landmark'))
      return typeof landmarkVideos === 'function'
        ? landmarkVideos(String(url))
        : Response.json(landmarkVideos);
    if (hold) await hold;
    return Response.json(near);
  };
  return {
    fetchImpl,
    calls,
    nearCalls: () =>
      calls.filter((u) => u.startsWith('/api/video/recorded?near=')),
    landmarkCalls: () =>
      calls.filter((u) => u.startsWith('/api/video/landmark')),
    setNear: (body) => (near = body),
    setLandmarks: (body) => (landmarks = body),
    setLandmarkVideos: (body) => (landmarkVideos = body),
    setMentions: (body) => (mentions = body),
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
  assert.equal(dataSources.length, 2, 'video pins and landmark diamonds');
  assert.equal(dataSources[0].show, false);
  assert.equal(dataSources[1].show, false);
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
    landmark: 0,
    landmarks: 0,
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
      String(url).startsWith('/api/video/recorded?near=')
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

const aboutVideo = (videoId, qid = 'Q1000257', extra = {}) => ({
  id: `lm-${qid}-${videoId}`,
  videoId,
  title: `National Aquarium ${videoId}`,
  channelTitle: 'Channel',
  lat: 39.2853,
  lon: -76.6083,
  coordinatesQuality: 'about',
  source: 'landmark',
  kind: 'tour',
  landmarkQid: qid,
  place: 'National Aquarium',
  youtubeRank: 1,
  ...extra,
});

test('landmarks: diamonds below 20 km, videos on a click, ABOUT pins and "mentioned at" moments', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { viewer, dataSources, setHeight, settle } = fakeViewer();
  const api = fakeApi();
  api.setNear({ videos: [geotag('ddddddddddd', 'site')] });
  api.setLandmarks({
    landmarks: [
      {
        qid: 'Q1000257',
        label: 'National Aquarium',
        lat: 39.2853,
        lon: -76.6083,
        sitelinks: 10,
        kind: 'aquarium',
      },
      {
        qid: 'Q210081',
        label: 'Walters Art Museum',
        lat: 39.2966,
        lon: -76.6158,
      },
      { qid: 'bad', label: 'Not an item', lat: 1, lon: 1 },
    ],
    pending: 0,
  });
  api.setLandmarkVideos((url) =>
    url.includes('Q210081')
      ? Response.json(
          { error: 'budget', videos: [], quota: { used: 1000, budget: 1000 } },
          { status: 429 },
        )
      : Response.json({
          videos: [
            aboutVideo('bbbbbbbbbbb', 'Q1000257', { youtubeRank: 2 }),
            aboutVideo('aaaaaaaaaaa'),
            // Not this landmark's video: left out.
            geotag('ccccccccccc', 'about'),
            aboutVideo('eeeeeeeeeee', 'Q210081'),
          ],
          cached: false,
          quota: { used: 102, budget: 1000, remaining: 898 },
        }),
  );
  api.setMentions({
    mentions: [
      {
        start: 221.4,
        at: '3:41',
        text: 'the National Aquarium opened in 1981',
      },
    ],
  });
  const opened = [];
  const mentioned = [];
  const player = {
    open: (record) => opened.push(record),
    close() {},
    showMentions: (record, mentions) => mentioned.push([record.id, mentions]),
  };
  const timers = [];
  let pick = null;
  const layer = createRecordedVideoLayer({
    fetchImpl: api.fetchImpl,
    player,
    createClickHandler: (v, onPick) => ((pick = onPick), () => {}),
    setTimeoutImpl: (fn) => (timers.push(fn), fn),
    clearTimeoutImpl: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const runTimers = async () => {
    while (timers.length) timers.shift()();
    for (let i = 0; i < 4; i++) await flush();
  };
  layer.init(viewer);
  const landmarkSource = dataSources[1];
  layer.enable(viewer);
  // 30 km up: no landmarks asked for, none shown.
  setHeight(30_000);
  settle();
  await runTimers();
  assert.equal(api.landmarkCalls().length, 0);
  assert.equal(landmarkSource.show, false);

  // Below 20 km: the landmarks around the view, as diamonds.
  setHeight(LANDMARK_MAX_HEIGHT_M / 2);
  settle();
  assert.equal(landmarkSource.show, true);
  await runTimers();
  assert.match(
    api.landmarkCalls()[0],
    /^\/api\/video\/landmark\/near\?near=39\.2900,-76\.6100&radiusKm=8$/,
  );
  const diamonds = landmarkSource.entities.values;
  assert.deepEqual(
    diamonds.map((e) => e.id),
    ['recorded-video:landmark:Q1000257', 'recorded-video:landmark:Q210081'],
    'a bad row is dropped',
  );
  assert.ok(diamonds[0].billboard, 'a billboard, not a round pin');
  assert.equal(diamonds[0].point, undefined);
  assert.equal(dataSources[0].entities.values.length, 1, 'the geotag pin');
  assert.equal(
    layer.landmarks().find((l) => l.qid === 'Q1000257').videoCount,
    null,
    'not asked yet',
  );
  // The same area again: answered in full, not asked again.
  settle();
  await runTimers();
  assert.equal(api.landmarkCalls().length, 1);

  // Higher again: the diamonds hide, and come back below 20 km.
  setHeight(25_000);
  settle();
  assert.equal(landmarkSource.show, false);
  setHeight(5_000);
  settle();
  assert.equal(landmarkSource.show, true);
  await runTimers();

  // A click on a diamond asks for its videos; they pin at it, tagged ABOUT.
  let heard = 0;
  layer.subscribe(() => heard++);
  pick({ id: 'recorded-video:landmark:Q1000257' });
  assert.equal(layer.landmarks()[0].loading, true);
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(api.landmarkCalls().filter((u) => u.includes('qid=')).length, 1);
  assert.equal(layer.selectedLandmark(), 'Q1000257');
  assert.deepEqual(
    layer.landmarkVideos('Q1000257').map((r) => r.videoId),
    ['bbbbbbbbbbb', 'aaaaaaaaaaa'],
    'in the server’s ranked order; a non-landmark record is not one of them',
  );
  const about = layer.landmarkVideos('Q1000257')[1];
  assert.equal(about.coordinatesQuality, 'about');
  assert.deepEqual([about.lat, about.lon], [39.2853, -76.6083]);
  assert.deepEqual(
    layer
      .records()
      .filter((r) => ['ccccccccccc', 'eeeeeeeeeee'].includes(r.videoId)),
    [],
    'nothing but this landmark’s own videos',
  );
  assert.equal(layer.landmarks()[0].videoCount, 2);
  assert.deepEqual(layer.quota(), { used: 102, budget: 1000, remaining: 898 });
  assert.ok(heard >= 2, 'loading and loaded are heard');
  assert.equal(
    dataSources[0].entities.values.filter(
      (e) => e.properties.coordinatesQuality.getValue() === 'about',
    ).length,
    2,
  );
  // Clicked again: nothing more is asked.
  pick({ id: 'recorded-video:landmark:Q1000257' });
  await flush();
  assert.equal(api.landmarkCalls().filter((u) => u.includes('qid=')).length, 1);

  // Playing a landmark's video asks for its moments and shows them.
  layer.focus(about);
  assert.equal(opened.at(-1), about);
  for (let i = 0; i < 4; i++) await flush();
  assert.match(
    api.landmarkCalls().at(-1),
    /\/mentions\?qid=Q1000257&videoId=aaaaaaaaaaa$/,
  );
  assert.deepEqual(mentioned, [
    [
      about.id,
      [
        {
          start: 221,
          at: '3:41',
          text: 'the National Aquarium opened in 1981',
        },
      ],
    ],
  ]);
  // A geotag pin asks for no moments.
  pick({ id: 'recorded-video:yt-ddddddddddd' });
  assert.equal(opened.at(-1).videoId, 'ddddddddddd');
  await flush();
  assert.equal(
    api.landmarkCalls().filter((u) => u.includes('/mentions')).length,
    1,
  );

  // Past the budget: refused, nothing pinned, the budget shown.
  const state = await layer.openLandmark('Q210081');
  assert.equal(state.refused, true);
  const walters = layer.landmarks().find((l) => l.qid === 'Q210081');
  assert.equal(walters.refused, true);
  assert.equal(walters.videoCount, null);
  assert.equal(layer.quota().remaining, 0);
  assert.equal(await layer.openLandmark('Q404'), null, 'unknown landmark');
  assert.equal(layer.getStats().landmarks, 2);
  assert.equal(layer.getStats().landmark, 2);

  layer.disable();
  assert.equal(landmarkSource.show, false);
  assert.equal(await layer.openLandmark('Q1000257'), null, 'off');
  layer.destroy(viewer);
  assert.equal(dataSources.length, 0, 'both data sources removed');
  assert.deepEqual(layer.landmarks(), []);
});

test('a landmark video’s caption says ABOUT and its kind; a moment restarts the embed there', () => {
  const record = toRecord(aboutVideo('aaaaaaaaaaa'));
  assert.equal(record.id, 'lm-Q1000257-aaaaaaaaaaa');
  assert.equal(
    captionFor(record),
    'National Aquarium · ABOUT · TOUR · Channel',
  );
  assert.equal(
    toRecord({ ...aboutVideo('aaaaaaaaaaa'), landmarkQid: '' }),
    null,
  );
  assert.equal(
    toRecord({ ...aboutVideo('aaaaaaaaaaa'), kind: 'weird' }).kind,
    'other',
  );
  assert.match(embedAt('aaaaaaaaaaa', 221.4), /[?&]start=221(&|$)/);
  assert.doesNotMatch(embedAt('aaaaaaaaaaa', 0), /start=/);
  assert.equal(embedAt('bad', 10), '');
});
