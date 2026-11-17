// Personal fork: the Recorded Video layer's clicks (index.js): a double-click
// on a pin or diamond never tracks and acts as one click; a diamond click
// plays; a refused search says so at the diamond.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createRecordedVideoLayer, REPEAT_PICK_MS } from './index.js';

const LANDMARK = {
  qid: 'Q1000257',
  label: 'National Aquarium',
  lat: 39.2853,
  lon: -76.6083,
  sitelinks: 10,
  kind: 'aquarium',
};

export const aboutVideo = (videoId, extra = {}) => ({
  id: `lm-Q1000257-${videoId}`,
  videoId,
  title: `National Aquarium ${videoId}`,
  channelTitle: 'Channel',
  lat: 39.2853,
  lon: -76.6083,
  coordinatesQuality: 'about',
  source: 'landmark',
  kind: 'tour',
  landmarkQid: 'Q1000257',
  place: 'National Aquarium',
  youtubeRank: 1,
  ...extra,
});

/** A viewer whose trackedEntity raises its change event as Cesium's does. */
export function fakeViewer() {
  const dataSources = [];
  const moveEnd = [];
  const trackedEntityChanged = new Cesium.Event();
  let tracked;
  const viewer = {
    dataSources: {
      add: (ds) => dataSources.push(ds),
      remove: (ds) => dataSources.splice(dataSources.indexOf(ds), 1),
    },
    scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(-76.61, 39.29, 3000);
      },
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-76.61, 39.29),
      moveEnd: {
        addEventListener(fn) {
          moveEnd.push(fn);
          return () => moveEnd.splice(moveEnd.indexOf(fn), 1);
        },
      },
    },
    trackedEntityChanged,
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(value) {
      if (tracked === value) return;
      tracked = value;
      trackedEntityChanged.raiseEvent(value);
    },
  };
  return {
    viewer,
    dataSources,
    settle: () => moveEnd.forEach((fn) => fn()),
  };
}

/** Fetches for landmarks and their videos; `videos` answers the qid. */
export function fakeFetch({ videos = () => ({ videos: [] }) } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.endsWith('/wikidata')) return Response.json({ videos: [] });
    if (u.startsWith('/api/video/landmark/near'))
      return Response.json({ landmarks: [LANDMARK], pending: 0 });
    if (u.startsWith('/api/video/landmark/mentions'))
      return Response.json({ mentions: [] });
    if (u.startsWith('/api/video/landmark')) {
      const answer = await videos(u);
      return answer instanceof Response ? answer : Response.json(answer);
    }
    return Response.json({ videos: [] });
  };
  return { fetchImpl, calls };
}

export const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A layer, on, over the Inner Harbor with the aquarium's diamond loaded. */
export async function mount({ videos, player, now } = {}) {
  const { viewer, dataSources, settle } = fakeViewer();
  const api = fakeFetch({ videos });
  const timers = [];
  let pick = null;
  const opened = [];
  const layer = createRecordedVideoLayer({
    fetchImpl: api.fetchImpl,
    player: player || {
      open: (record, options) => opened.push([record, options]),
      close() {},
    },
    createClickHandler: (v, onPick) => ((pick = onPick), () => {}),
    setTimeoutImpl: (fn) => (timers.push(fn), fn),
    clearTimeoutImpl: (fn) => {
      const i = timers.indexOf(fn);
      if (i >= 0) timers.splice(i, 1);
    },
    ...(now ? { now } : {}),
  });
  layer.init(viewer);
  layer.enable(viewer);
  settle();
  while (timers.length) timers.shift()();
  await flush();
  const diamond = dataSources[1].entities.values[0];
  return {
    layer,
    viewer,
    dataSources,
    api,
    pick: (e) => pick(e),
    diamond,
    opened,
  };
}

test('a double-click on a diamond or a pin never starts tracking, and acts as one click', async () => {
  let clock = 1000;
  const m = await mount({
    now: () => clock,
    videos: () => ({ videos: [aboutVideo('aaaaaaaaaaa')], cached: true }),
  });
  assert.equal(m.diamond.id, 'recorded-video:landmark:Q1000257');
  // Cesium's stock double-click: two clicks, then trackedEntity = it.
  m.pick(m.diamond);
  clock += 120;
  m.pick(m.diamond);
  m.viewer.trackedEntity = m.diamond;
  assert.equal(m.viewer.trackedEntity, undefined, 'untracked at once');
  await flush();
  assert.equal(
    m.api.calls.filter((u) => u.startsWith('/api/video/landmark?')).length,
    1,
    'one search for the two clicks',
  );
  // A pin the same way.
  const pin = m.dataSources[0].entities.values[0];
  assert.ok(pin, 'an ABOUT pin');
  m.viewer.trackedEntity = pin;
  assert.equal(m.viewer.trackedEntity, undefined);
  // Any other entity keeps the stock tracking.
  const aircraft = new Cesium.Entity({
    id: 'flight:abc123',
    position: Cesium.Cartesian3.fromDegrees(-76.6, 39.3, 3000),
  });
  m.viewer.trackedEntity = aircraft;
  assert.equal(m.viewer.trackedEntity, aircraft);
  // Off, the guard is gone.
  m.layer.disable();
  m.viewer.trackedEntity = undefined;
  m.viewer.trackedEntity = m.diamond;
  assert.equal(m.viewer.trackedEntity, m.diamond);
  // Two picks far enough apart are two actions.
  assert.ok(REPEAT_PICK_MS >= 300 && REPEAT_PICK_MS <= 800);
});
