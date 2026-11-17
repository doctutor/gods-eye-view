// Personal fork: the Recorded Video layer's clicks (index.js): a double-click
// on a pin or diamond never tracks and acts as one click; a diamond click
// plays; a refused search says so at the diamond.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  createRecordedVideoLayer,
  nearestOwnPick,
  LANDMARK_NOTE_MS,
  PICK_BOX_PX,
  REPEAT_PICK_MS,
} from './index.js';

const LANDMARK = {
  qid: 'Q1000257',
  label: 'National Aquarium',
  lat: 39.2853,
  lon: -76.6083,
  sitelinks: 10,
  kind: 'aquarium',
};

const GEOTAG = {
  videoId: 'ddddddddddd',
  title: 'Inner Harbor walk',
  channelTitle: 'Channel',
  publishedAt: '2026-10-01T00:00:00Z',
  lat: 39.29,
  lon: -76.61,
  coordinatesQuality: 'site',
  sharedBy: 0,
  source: 'youtube-geotag',
};

const aboutVideo = (videoId, extra = {}) => ({
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
function fakeViewer() {
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
function fakeFetch({
  videos = () => ({ videos: [] }),
  landmarks = [LANDMARK],
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.endsWith('/wikidata')) return Response.json({ videos: [] });
    if (u.startsWith('/api/video/landmark/near'))
      return Response.json({ landmarks, pending: 0 });
    if (u.startsWith('/api/video/landmark/mentions'))
      return Response.json({ mentions: [] });
    if (u.startsWith('/api/video/landmark')) {
      const answer = await videos(u);
      return answer instanceof Response ? answer : Response.json(answer);
    }
    // The view's geotags: one pin.
    return Response.json({ videos: [GEOTAG] });
  };
  return { fetchImpl, calls };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A layer, on, over the Inner Harbor with the aquarium's diamond loaded. */
async function mount({ videos, player, now, overlayHost, landmarks } = {}) {
  const { viewer, dataSources, settle } = fakeViewer();
  const api = fakeFetch({ videos, landmarks });
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
    overlayHost: overlayHost && {
      setVisible() {},
      clearSource: () => (overlayHost.entries = []),
      setEntries: (id, entries) => (overlayHost.entries = entries),
    },
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
    timers,
    runTimers: () => {
      while (timers.length) timers.shift()();
    },
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
  assert.equal(pin?.id, 'recorded-video:yt-ddddddddddd', 'a geotag pin');
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

/** The overlay host's label for the aquarium's diamond. */
const labelOf = (overlay) =>
  overlay.entries.find((entry) => entry.id === 'landmark:Q1000257');

test('a diamond click shows it is asking, then plays the top video with the others listed', async () => {
  let answer;
  const asked = new Promise((resolve) => (answer = resolve));
  const overlay = { entries: [] };
  const m = await mount({
    videos: () => asked,
    overlayHost: overlay,
  });
  m.pick(m.diamond);
  await flush();
  // Asking: a busy diamond, its label and its panel row say so.
  assert.match(
    decodeURIComponent(
      m.dataSources[1].entities.values[0].billboard.image.getValue(),
    ),
    /stroke-dasharray/,
  );
  assert.equal(labelOf(overlay).details[0], 'ASKING…');
  assert.equal(m.layer.landmarks()[0].loading, true);
  answer({
    videos: [
      aboutVideo('bbbbbbbbbbb', { youtubeRank: 1 }),
      aboutVideo('aaaaaaaaaaa', { youtubeRank: 2, kind: 'news' }),
      aboutVideo('ccccccccccc', { youtubeRank: 3 }),
    ],
    cached: true,
  });
  await flush();
  const [record, options] = m.opened.at(-1);
  assert.equal(record.videoId, 'bbbbbbbbbbb', 'the top video plays');
  assert.deepEqual(
    options.playlist.map((r) => r.videoId),
    ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ccccccccccc'],
    'the others in the server’s order',
  );
  // Choosing another from the list plays it, the list kept.
  options.onSelect(options.playlist[2]);
  assert.equal(m.opened.at(-1)[0].videoId, 'ccccccccccc');
  assert.equal(m.opened.at(-1)[1].playlist.length, 3);
  // The diamond is plain again, its label counts the videos; no dots.
  assert.doesNotMatch(
    decodeURIComponent(
      m.dataSources[1].entities.values[0].billboard.image.getValue(),
    ),
    /stroke-dasharray/,
  );
  assert.equal(labelOf(overlay).details[0], '3 VIDEOS');
  assert.deepEqual(
    m.dataSources[0].entities.values.map((e) => e.id),
    ['recorded-video:yt-ddddddddddd'],
  );
  // Clicked again later: the player opens at once, nothing asked.
  const before = m.api.calls.length;
  await new Promise((r) => setTimeout(r, REPEAT_PICK_MS + 20));
  m.pick(m.diamond);
  assert.equal(m.opened.at(-1)[0].videoId, 'bbbbbbbbbbb');
  await flush();
  assert.equal(
    m.api.calls
      .slice(before)
      .filter((u) => u.startsWith('/api/video/landmark?')).length,
    0,
  );
});

test('a landmark with no usable videos says so at the diamond and in the player’s place, briefly', async () => {
  const overlay = { entries: [] };
  const notices = [];
  const opened = [];
  const m = await mount({
    videos: () => ({ videos: [], cached: true }),
    overlayHost: overlay,
    player: {
      open: (record) => opened.push(record),
      close() {},
      notice: (text) => notices.push(text),
    },
  });
  m.pick(m.diamond);
  await flush();
  assert.deepEqual(opened, []);
  assert.deepEqual(notices, ['No usable videos here']);
  assert.equal(labelOf(overlay).details[0], 'No usable videos here');
  assert.equal(m.layer.landmarks()[0].note, 'No usable videos here');
  // Gone after a while.
  m.runTimers();
  assert.equal(labelOf(overlay).details[0], '0 VIDEOS');
  assert.equal(m.layer.landmarks()[0].note, null);
});

/** Just enough DOM for the player. */
class El extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.className = '';
    this.textContent = '';
    this.attributes = {};
    this.disabled = false;
    const el = this;
    this.classList = { add: (n) => (el.className += ` ${n}`) };
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  after(node) {
    const siblings = this.parent.children;
    node.parent = this.parent;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (!this.parent) return;
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  all(cls) {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(cls) ? [child] : []),
      ...child.all(cls),
    ]);
  }
  querySelector(selector) {
    return this.all(selector.slice(1))[0] || null;
  }
}

test('the player lists a landmark’s videos to switch between, with previous and next, and shows a brief notice', async () => {
  const { createVideoPlayer, NOTICE_MS } = await import('./player.js');
  const body = new El('body');
  const doc = { body, createElement: (tag) => new El(tag) };
  const timers = [];
  const player = createVideoPlayer({
    document: doc,
    setTimeoutImpl: (fn, ms) => (timers.push([fn, ms]), timers.length),
    clearTimeoutImpl: () => {},
  });
  const list = [
    aboutVideo('bbbbbbbbbbb'),
    aboutVideo('aaaaaaaaaaa', { kind: 'news', channelTitle: 'WBAL' }),
    aboutVideo('ccccccccccc'),
  ];
  const chosen = [];
  player.open(list[1], { playlist: list, onSelect: (r) => chosen.push(r) });
  const panel = body.children[0];
  const rows = panel.all('recorded-video-player-item');
  assert.deepEqual(
    rows.map(
      (row) => row.all('recorded-video-player-item-title')[0].textContent,
    ),
    list.map((r) => r.title),
  );
  assert.equal(rows[1].getAttribute('aria-current'), 'true');
  assert.equal(
    rows[1].all('recorded-video-player-item-details')[0].textContent,
    'NEWS · WBAL',
  );
  assert.equal(
    panel.all('recorded-video-player-position')[0].textContent,
    '2 of 3',
  );
  const [prev, next] = panel.all('recorded-video-player-step');
  prev.dispatchEvent(new Event('click'));
  next.dispatchEvent(new Event('click'));
  rows[2].dispatchEvent(new Event('click'));
  rows[1].dispatchEvent(new Event('click')); // the one playing: nothing
  assert.deepEqual(
    chosen.map((r) => r.videoId),
    ['bbbbbbbbbbb', 'ccccccccccc', 'ccccccccccc'],
  );
  // At an end, its step is off.
  player.open(list[0], { playlist: list, onSelect: () => {} });
  assert.equal(
    body.children[0].all('recorded-video-player-step')[0].disabled,
    true,
  );
  // One video: no list.
  player.open(list[0]);
  assert.equal(body.children[0].all('recorded-video-player-list').length, 0);
  // A notice inside the open player, gone after NOTICE_MS; alone otherwise.
  player.notice('No usable videos here');
  assert.equal(
    body.children[0].all('recorded-video-player-notice')[0].textContent,
    'No usable videos here',
  );
  assert.equal(timers.at(-1)[1], NOTICE_MS);
  timers.at(-1)[0]();
  assert.equal(body.children[0].all('recorded-video-player-notice').length, 0);
  player.close();
  player.notice('Search budget used up until 03:00');
  assert.match(
    body.children[0].className,
    /recorded-video-player-notice is-alone/,
  );
});

test('a refused, keyless or failed search says so where it was clicked, with the reset in local time', async () => {
  const { resetClock } = await import('./player.js');
  const resetsAt = Date.parse('2026-11-18T08:00:00Z');
  const cases = [
    [
      () =>
        Response.json(
          {
            error: 'budget',
            videos: [],
            quota: { used: 914, budget: 1000, remaining: 86, resetsAt },
          },
          { status: 429 },
        ),
      `Search budget used up until ${resetClock(resetsAt)}`,
    ],
    [() => ({ videos: [], configured: false }), 'YouTube key not configured'],
    [
      () => Response.json({ error: 'upstream' }, { status: 502 }),
      /^The video search failed: /,
    ],
  ];
  for (const [videos, expected] of cases) {
    const overlay = { entries: [] };
    const notices = [];
    const m = await mount({
      videos,
      overlayHost: overlay,
      player: { open() {}, close() {}, notice: (text) => notices.push(text) },
    });
    m.pick(m.diamond);
    await flush();
    const label = labelOf(overlay).details[0];
    if (expected instanceof RegExp) {
      assert.match(label, expected);
      assert.match(notices[0], expected);
    } else {
      assert.equal(label, expected);
      assert.deepEqual(notices, [expected]);
    }
  }
  // The viewer's clock: two digits each.
  assert.match(resetClock(resetsAt, 'en'), /^\d{2}:\d{2}( [AP]M)?$/);
  assert.equal(resetClock(Number.NaN), '');
});

test('a click anywhere on a diamond, or a few pixels round it, picks it; of two, the nearest centre', () => {
  const aquarium = { id: 'recorded-video:landmark:Q1000257' };
  const torsk = { id: 'recorded-video:landmark:Q7869866' };
  const aircraft = { id: 'flight:abc123' };
  const centres = new Map([
    [aquarium, { x: 400, y: 300 }],
    [torsk, { x: 412, y: 300 }],
  ]);
  const toWindow = (entity) => centres.get(entity) || null;
  const picks = [
    { id: torsk },
    { id: aircraft },
    { id: aquarium },
    { id: torsk },
  ];
  // A click meant for the aquarium (2 px from its centre) is the aquarium's.
  assert.equal(nearestOwnPick(picks, { x: 402, y: 301 }, toWindow), aquarium);
  assert.equal(nearestOwnPick(picks, { x: 411, y: 299 }, toWindow), torsk);
  // Only this layer's entities; none, null.
  assert.equal(
    nearestOwnPick([{ id: aircraft }], { x: 0, y: 0 }, toWindow),
    null,
  );
  assert.equal(nearestOwnPick(undefined, { x: 0, y: 0 }, toWindow), null);
  // The box covers the 22 px diamond and a few pixels round it.
  assert.ok(PICK_BOX_PX >= 24 && PICK_BOX_PX <= 32);
});

test('a refused search’s note shows at a diamond that had no label, holds about 8 s, and ends at the next click', async () => {
  // Fourteen landmarks round the view: the clicked one is the farthest, past
  // the twelve that get labels.
  const many = Array.from({ length: 14 }, (_, k) => ({
    qid: `Q${100 + k}`,
    label: `Landmark ${k}`,
    lat: 39.29 + k * 0.002,
    lon: -76.61,
    kind: 'museum',
  }));
  const overlay = { entries: [] };
  const m = await mount({
    landmarks: many,
    overlayHost: overlay,
    videos: () =>
      Response.json(
        { error: 'budget', videos: [], quota: { used: 914, budget: 1000 } },
        { status: 429 },
      ),
    player: { open() {}, close() {}, notice() {} },
  });
  const far = m.dataSources[1].entities.values.find(
    (e) => e.id === 'recorded-video:landmark:Q113',
  );
  const labelFor = () =>
    overlay.entries.find((entry) => entry.id === 'landmark:Q113');
  assert.equal(labelFor(), undefined, 'not labelled before the click');
  m.pick(far);
  await flush();
  const label = labelFor();
  assert.match(label.details[0], /^Search budget used up/);
  // It outranks every ambient label, so it is drawn whatever else is near.
  for (const other of overlay.entries)
    if (other !== label) assert.ok(label.priority > other.priority, other.id);
  assert.equal(LANDMARK_NOTE_MS, 8000);
  // The next click ends it.
  const near = m.dataSources[1].entities.values.find(
    (e) => e.id === 'recorded-video:landmark:Q100',
  );
  m.pick(near);
  assert.equal(m.layer.landmarks().find((l) => l.qid === 'Q113').note, null);
  assert.doesNotMatch(String(labelFor()?.details?.[0] || ''), /budget/);
});
