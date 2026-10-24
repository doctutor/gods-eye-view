// Personal fork: the World history layer against stubs: tiles painted from
// the served polygons, the year's and the list's imagery layers on the host
// (the list above, its alpha the opacity), names thinned by size, a click's
// card, the store and its `wh` value, and everything off on disable; the
// private Cottereau borders overlay: absent without its route, drawn above
// both, its cards, and a second click's card of what lies under.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIST_FILL_ALPHA,
  WORLD_HISTORY_OVERLAY,
  YEAR_FILL_ALPHA,
  createWorldHistoryLayer,
} from './index.js';
import {
  createWorldHistoryImageryProvider,
  lodForLevel,
  paintShapes,
} from './painter.js';
import { decodeRecord } from './source.js';
import { decodeSample } from './borders.js';
import { createWorldHistoryStore } from './store.js';
import {
  LIST_PALETTE,
  decodeWorldHistoryParam,
  encodePolygons,
  polityColor,
} from '../../data/worldHistory.js';
import { resetPointerOwnership } from '../../data/inputOwnership.js';

const square = (x, y, s) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
const served = (id, name, from, to, area, polygons, extra = {}) =>
  decodeRecord({
    id,
    name,
    from,
    to,
    area,
    wikipedia: name,
    label: [polygons[0][0][0][0] + 0.5, polygons[0][0][0][1] + 0.5],
    polygons: JSON.parse(encodePolygons(polygons)),
    ...extra,
  });

function recordingContext() {
  const calls = [];
  const context = {};
  for (const name of [
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
  ])
    context[name] = (...args) => calls.push([name, ...args, context.fillStyle]);
  return { context, calls };
}

function fakeCesium() {
  const handlers = [];
  class ImageryLayer {
    constructor(provider, { alpha = 1 } = {}) {
      this.provider = provider;
      this.alpha = alpha;
    }
  }
  return {
    handlers,
    ImageryLayer,
    Event: class {},
    GeographicTilingScheme: class {
      constructor() {
        this.rectangle = {
          west: -Math.PI,
          south: -Math.PI / 2,
          east: Math.PI,
          north: Math.PI / 2,
        };
      }
      tileXYToRectangle(x, y, level) {
        const span = Math.PI / 2 ** level;
        return {
          west: -Math.PI + x * span,
          east: -Math.PI + (x + 1) * span,
          north: Math.PI / 2 - y * span,
          south: Math.PI / 2 - (y + 1) * span,
        };
      }
    },
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartographic: {
      fromCartesian: ({ lon, lat }) => ({
        longitude: (lon * Math.PI) / 180,
        latitude: (lat * Math.PI) / 180,
      }),
    },
    Math: { toDegrees: (r) => (r * 180) / Math.PI },
    ScreenSpaceEventHandler: class {
      constructor() {
        this.actions = new Map();
        this.destroyed = false;
        handlers.push(this);
      }
      setInputAction(action, type) {
        this.actions.set(type, action);
      }
      destroy() {
        this.destroyed = true;
      }
    },
    ScreenSpaceEventType: { LEFT_CLICK: 'click' },
  };
}

function fakeViewer() {
  const list = [];
  return {
    imageryLayers: {
      list,
      add(layer, index) {
        if (index === undefined) list.push(layer);
        else list.splice(index, 0, layer);
      },
      remove(layer) {
        const at = list.indexOf(layer);
        if (at >= 0) list.splice(at, 1);
      },
      indexOf: (layer) => list.indexOf(layer),
    },
    camera: {
      positionCartographic: { height: 2e7 },
      // A click at (x, y) px is at lon x/10, lat y/10.
      pickEllipsoid: ({ x, y }) => ({ lon: x / 10, lat: y / 10 }),
      moveEnd: {
        listeners: new Set(),
        addEventListener(fn) {
          this.listeners.add(fn);
          return () => this.listeners.delete(fn);
        },
      },
    },
    scene: { canvas: { clientWidth: 1000, clientHeight: 1000 } },
  };
}

// The year: Big (2,000,000 km²) and Small (100 km²) overlapping; the list:
// two polities overlapping each other and Big.
const YEAR = {
  year: -500,
  cliopatriaYear: -500,
  polities: [
    served(0, 'Big Empire', -600, -400, 2_000_000, [[square(10, 40, 10)]], {
      title: 'Big',
    }),
    served(1, 'Small Kingdom', -550, -450, 100, [[square(12, 42, 1)]]),
  ],
};
const POLITIES = {
  'Roman Empire': served(5, 'Roman Empire', -27, 476, 5_000_000, [
    [square(0, 30, 20)],
  ]),
  'Han Dynasty': served(6, 'Han Dynasty', -202, 220, 6_000_000, [
    [square(15, 35, 20)],
  ]),
};

function fixture({ list = [], borders = null, initial = {} } = {}) {
  resetPointerOwnership();
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const asked = [];
  const source = {
    year: async (year, options) => {
      asked.push(['year', year, options.mode, options.places, options.lod]);
      return { ...YEAR, year };
    },
    polity: async (name, options) => {
      asked.push(['polity', name, options.extent, options.lod]);
      const record = POLITIES[name];
      if (!record) return null;
      if (
        options.extent !== 'max' &&
        (options.extent < record.from || options.extent > record.to)
      )
        return null;
      return { record, from: record.from, to: record.to };
    },
    names: async () => [],
  };
  const drawn = [];
  const overlayHost = {
    setEntries: (sourceId, entries) => drawn.push({ sourceId, entries }),
    setVisible: () => {},
    clearSource: (sourceId) =>
      drawn.push({ sourceId, entries: [], cleared: true }),
  };
  const timers = [];
  const store = createWorldHistoryStore({
    initial: { ...decodeWorldHistoryParam(''), year: -500, list, ...initial },
  });
  const layer = createWorldHistoryLayer({
    store,
    source,
    borders,
    cesium,
    overlayHost,
    createCanvas: () => ({ getContext: () => recordingContext().context }),
    setTimeoutImpl: (fn) => timers.push(fn) && timers.length,
    clearTimeoutImpl: () => {},
  });
  layer.init(viewer);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const runTimers = () => {
    while (timers.length) timers.shift()();
  };
  return { cesium, viewer, store, layer, asked, drawn, settle, runTimers };
}

test('tiles: shapes crossing the tile painted in order, translucent, holes by even-odd; others skipped', async () => {
  const shapes = [
    {
      polygons: YEAR.polities[0].polygons,
      box: YEAR.polities[0].box,
      fill: [255, 0, 0],
      fillAlpha: 0.5,
      stroke: [255, 0, 0],
      strokeAlpha: 1,
      strokeWidth: 2,
    },
    {
      polygons: YEAR.polities[1].polygons,
      box: YEAR.polities[1].box,
      fill: [0, 0, 255],
      fillAlpha: 0.5,
      strokeWidth: 0,
    },
    {
      polygons: POLITIES['Roman Empire'].polygons,
      box: [-170, -80, -160, -70],
      fill: [0, 255, 0],
      fillAlpha: 0.5,
    },
  ];
  const { context, calls } = recordingContext();
  const painted = paintShapes(context, shapes, {
    west: 0,
    south: 30,
    east: 30,
    north: 60,
  });
  assert.equal(painted, 2, 'the far shape is not painted');
  const fills = calls.filter((c) => c[0] === 'fill');
  assert.deepEqual(
    fills.map((c) => [c[1], c[2]]),
    [
      ['evenodd', 'rgba(255, 0, 0, 0.5)'],
      ['evenodd', 'rgba(0, 0, 255, 0.5)'],
    ],
    'both overlapping fills composited, red first',
  );
  assert.equal(
    calls.filter((c) => c[0] === 'stroke').length,
    1,
    'only the outlined one stroked',
  );
  const move = calls.find((c) => c[0] === 'moveTo');
  assert.deepEqual(
    move.slice(1, 3),
    [(10 / 30) * 256, (20 / 30) * 256],
    'lon, lat to pixels',
  );

  assert.deepEqual([0, 2, 3, 4, 5, 9].map(lodForLevel), [0, 0, 1, 1, 2, 2]);
  const levels = [];
  const provider = createWorldHistoryImageryProvider({
    cesium: fakeCesium(),
    shapes: async (lod) => {
      levels.push(lod);
      return shapes;
    },
    createCanvas: (w, h) => ({
      w,
      h,
      getContext: () => recordingContext().context,
    }),
  });
  assert.equal(provider.hasAlphaChannel, true);
  // Level 2, x 4, y 0: lon 0..45, lat 45..90, which Big crosses.
  const tile = await provider.requestImage(4, 1, 2);
  assert.deepEqual([tile.w, tile.h], [256, 256]);
  const empty = await provider.requestImage(7, 3, 2);
  assert.deepEqual([empty.w, empty.h], [1, 1], 'a blank tile is one pixel');
  assert.equal(await provider.requestImage(7, 3, 2), empty, 'and shared');
  assert.deepEqual(levels, [0, 0, 0]);
  assert.deepEqual(provider.stats, {
    requested: 3,
    painted: 1,
    empty: 2,
    failed: 0,
  });
});

test('the layer: the year mounted on the host, the list above it, the opacity its alpha; names thinned', async () => {
  const f = fixture();
  f.layer.enable(f.viewer);
  await f.settle();
  const layers = f.viewer.imageryLayers.list;
  assert.equal(layers.length, 1, 'the year');
  assert.equal(layers[0].alpha, 1);
  assert.deepEqual(f.asked[0], ['year', -500, 'cottereau', false, 0]);
  // Its tiles paint the year's shapes in their stable colours.
  const yearShapes = await f.layer
    ._state()
    .yearLayer.provider.requestImage(0, 0, 0)
    .then(() => true);
  assert.ok(yearShapes);
  const names = f.drawn.at(-1).entries.filter((e) => e.id.startsWith('y:'));
  assert.deepEqual(
    names.map((e) => e.title),
    ['Big'],
    'Small is too small from 20,000 km',
  );
  assert.equal(f.drawn.at(-1).sourceId, WORLD_HISTORY_OVERLAY);
  f.viewer.camera.positionCartographic.height = 1e4;
  for (const listener of f.viewer.camera.moveEnd.listeners) listener();
  assert.deepEqual(
    f.drawn
      .at(-1)
      .entries.filter((e) => e.id.startsWith('y:'))
      .map((e) => e.title),
    ['Big', 'Small Kingdom'],
    'closer in, both',
  );

  f.layer.add('Roman Empire');
  f.layer.add('Han Dynasty');
  await f.settle();
  assert.equal(layers.length, 2);
  const listLayer = f.layer._state().listLayer;
  assert.equal(layers[1], listLayer, 'the list above the year');
  assert.equal(listLayer.alpha, 0.6);
  f.layer.setOpacity(0.25);
  assert.equal(
    f.layer._state().listLayer,
    listLayer,
    'no repaint for the opacity',
  );
  assert.equal(listLayer.alpha, 0.25);
  // Each entry its own strong colour, translucent, outlined.
  const view = f.layer.view();
  assert.deepEqual(
    view.list.map((e) => [e.name, e.color, e.state]),
    [
      ['Roman Empire', 0, 'ready'],
      ['Han Dynasty', 1, 'ready'],
    ],
  );
  const listNames = f.drawn.at(-1).entries.filter((e) => e.id.startsWith('l:'));
  assert.deepEqual(
    listNames.map((e) => e.accent),
    ['#ff3b30', '#007aff'],
  );
  assert.deepEqual(LIST_PALETTE[0], [255, 59, 48]);
  assert.ok(LIST_FILL_ALPHA < 1 && YEAR_FILL_ALPHA < LIST_FILL_ALPHA);

  // At the slider year: Han is alive in 500 BC? No: absent, said so.
  f.layer.setExtent('Han Dynasty', 'year');
  await f.settle();
  assert.equal(f.layer.view().list[1].state, 'absent');
  assert.ok(
    f.asked.some(
      (a) => a[0] === 'polity' && a[1] === 'Han Dynasty' && a[2] === -500,
    ),
  );
  // Hidden: off the list layer; cleared: no list layer.
  const before = f.layer._state().listKey;
  f.layer.setVisible('Roman Empire', false);
  assert.notEqual(f.layer._state().listKey, before);
  f.layer.clear();
  assert.equal(f.layer._state().listLayer, null);
  assert.equal(layers.length, 1);
});

test('a new year swaps the year layer once its answer is here, below the list; All mode asked as such', async () => {
  const f = fixture({
    list: [{ name: 'Roman Empire', extent: 'max', visible: true, color: 0 }],
  });
  f.layer.enable(f.viewer);
  await f.settle();
  const first = f.layer._state().yearLayer;
  f.layer.setYear(-400);
  f.layer.setMode('all');
  f.runTimers();
  await f.settle();
  const second = f.layer._state().yearLayer;
  assert.notEqual(second, first);
  assert.deepEqual(f.viewer.imageryLayers.list, [
    second,
    f.layer._state().listLayer,
  ]);
  assert.ok(
    f.asked.some((a) => a[0] === 'year' && a[1] === -400 && a[2] === 'all'),
  );
  assert.equal(f.layer.getStats().count, 2);
});

test('a click opens the card of what is on top (a list entry before the year), elsewhere closes it', async () => {
  const f = fixture({
    list: [{ name: 'Roman Empire', extent: 'max', visible: true, color: 0 }],
  });
  f.layer.enable(f.viewer);
  await f.settle();
  // (125, 425) px is 12.5°E 42.5°N: in Roman, Big and Small.
  f.layer._onClick({ x: 125, y: 425 });
  let card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.equal(card.title, 'Roman Empire');
  assert.equal(f.layer.view().selected.wikipedia, 'Roman Empire');
  f.layer.setVisible('Roman Empire', false);
  f.layer._onClick({ x: 125, y: 425 });
  card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.equal(
    card.title,
    'Small Kingdom',
    'the smallest polity under the click',
  );
  assert.ok(card.details.some((line) => /550 BC/.test(line)));
  assert.ok(card.details.some((line) => /Cliopatria .*CC BY 4\.0/.test(line)));
  f.layer._onClick({ x: 1500, y: -100 });
  assert.equal(
    f.drawn.at(-1).entries.find((e) => e.id === 'card'),
    undefined,
  );
  assert.equal(f.layer.view().selected, null);
});

test('off: the imagery, the names, the card and the click handler all go; the store says off', async () => {
  const f = fixture();
  f.layer.enable(f.viewer);
  await f.settle();
  assert.equal(f.store.get().enabled, true);
  f.layer.disable();
  assert.equal(f.viewer.imageryLayers.list.length, 0);
  assert.equal(f.drawn.at(-1).cleared, true);
  assert.ok(f.cesium.handlers.every((h) => h.destroyed));
  assert.equal(f.viewer.camera.moveEnd.listeners.size, 0);
  assert.equal(f.store.get().enabled, false);
  assert.equal(f.layer.getStats().countLabel, '—');
});

test('the store: every change heard once, and its wh value round-trips', () => {
  const store = createWorldHistoryStore({
    initial: decodeWorldHistoryParam(''),
  });
  let heard = 0;
  store.subscribe(() => heard++);
  store.setYear(0);
  assert.equal(store.get().year, 1, 'year 0 is 1 AD');
  assert.equal(heard, 0, 'unchanged: unheard');
  store.setYear(-753);
  store.setMode('all');
  store.setMode('other');
  store.setOpacity(1.7);
  store.add('Roman Empire');
  store.add('Roman Empire');
  store.update('Roman Empire', { extent: 'year' });
  assert.equal(heard, 5);
  const back = decodeWorldHistoryParam(store.param());
  assert.deepEqual(back, store.get());
  store.clear();
  assert.deepEqual(store.get().list, []);
  assert.deepEqual(polityColor('x'), polityColor('x'));
});

// ── The private Cottereau borders overlay ───────────────────────────────

/** A sample as the route serves it: Persia over Big's middle, matched to it. */
const BORDERS_SAMPLE = {
  index: 7,
  year: -520,
  polygons: [
    {
      track: 1,
      label: 'Persia',
      cliopatria: 'Big Empire',
      colour: '#aa3300',
      areaKm2: 1_000_000,
      flags: ['joined'],
      regions: 1,
      iou: 0.72,
      polygons: JSON.parse(encodePolygons([[square(11, 41, 5)]])),
    },
  ],
  unlabelled: [],
};

/** A borders source as the route would answer, the year asked recorded. */
function bordersSource({ available = true, built = true } = {}) {
  const asked = [];
  const sample = decodeSample(BORDERS_SAMPLE);
  return {
    asked,
    status: async () => (available ? { available, built } : { available }),
    year: async (year) => {
      asked.push(year);
      return year < -600 ? null : sample;
    },
  };
}

const BORDERS_ON = {
  borders: { on: true, mode: 'outlines', labels: false, opacity: 0.85 },
};

test('borders: absent without the route (no layer, no field in wh), even when the hash asked for it', async () => {
  const f = fixture({ initial: BORDERS_ON });
  f.layer.enable(f.viewer);
  await f.settle();
  assert.equal(f.store.bordersAvailable(), false, 'no borders source');
  assert.equal(f.layer.view().borders.available, false);
  assert.equal(f.layer.view().borders.status, 'absent');
  assert.equal(f.layer._state().bordersLayer, null);
  assert.equal(f.viewer.imageryLayers.list.length, 1, 'the year only');
  assert.doesNotMatch(f.store.param(), /@/);

  const g = fixture({
    initial: BORDERS_ON,
    borders: bordersSource({ available: false }),
  });
  g.layer.enable(g.viewer);
  await g.settle();
  assert.equal(g.layer.view().borders.available, false);
  assert.doesNotMatch(g.store.param(), /@/, 'the route did not answer');
});

test('borders: the sample at or before the year drawn above the year fills and the list; its own opacity', async () => {
  const borders = bordersSource();
  const f = fixture({ initial: BORDERS_ON, borders });
  f.layer.enable(f.viewer);
  await f.settle();
  const layers = f.viewer.imageryLayers.list;
  const { yearLayer, bordersLayer } = f.layer._state();
  assert.deepEqual(layers, [yearLayer, bordersLayer]);
  assert.equal(bordersLayer.alpha, 0.85);
  assert.deepEqual(borders.asked, [-500]);
  const view = f.layer.view();
  assert.equal(view.borders.available, true);
  assert.equal(view.borders.status, 'ready');
  assert.equal(
    view.borders.sampleYear,
    -520,
    'the sample before the slider year',
  );
  assert.match(f.store.param(), /~@1o0\.85$/);

  // The list goes under the overlay; the overlay stays on top.
  f.layer.add('Roman Empire');
  await f.settle();
  assert.deepEqual(layers, [
    yearLayer,
    f.layer._state().listLayer,
    bordersLayer,
  ]);
  // A new year: its fills at the bottom; the same sample, the same layer.
  f.layer.setYear(-510);
  f.runTimers();
  await f.settle();
  assert.deepEqual(layers, [
    f.layer._state().yearLayer,
    f.layer._state().listLayer,
    bordersLayer,
  ]);
  assert.notEqual(f.layer._state().yearLayer, yearLayer);
  assert.deepEqual(borders.asked, [-500, -510]);
  // Its opacity is its alpha; a new mode repaints it, still on top.
  f.layer.setBorders({ opacity: 0.4 });
  assert.equal(bordersLayer.alpha, 0.4);
  assert.equal(f.layer._state().bordersLayer, bordersLayer);
  f.layer.setBorders({ mode: 'fills' });
  const filled = f.layer._state().bordersLayer;
  assert.notEqual(filled, bordersLayer);
  assert.equal(layers.at(-1), filled);
  // Its tiles paint his region.
  const tile = await filled.provider.requestImage(4, 1, 2);
  assert.ok(tile);
  // Before the first sample: none drawn, and said so.
  f.layer.setYear(-700);
  f.runTimers();
  await f.settle();
  assert.equal(f.layer._state().bordersLayer, null);
  assert.equal(f.layer.view().borders.status, 'none');
  // Off: gone, the switch remembered in wh.
  f.layer.setYear(-500);
  f.runTimers();
  await f.settle();
  f.layer.setBorders({ on: false });
  assert.equal(f.layer._state().bordersLayer, null);
  assert.equal(f.layer.view().borders.status, 'off');
  assert.match(f.store.param(), /~@0f0\.40$/);
});

test('borders: his labels only on request; a click on his region gives its card, again the one under it', async () => {
  const f = fixture({ initial: BORDERS_ON, borders: bordersSource() });
  f.layer.enable(f.viewer);
  await f.settle();
  const his = () => f.drawn.at(-1).entries.filter((e) => e.id.startsWith('c:'));
  assert.deepEqual(his(), [], 'labels off by default');
  f.layer.setBorders({ labels: true });
  assert.deepEqual(
    his().map((e) => e.title),
    ['Persia'],
  );

  // 12.5°E 42.5°N: in Persia, Big and Small.
  f.layer._onClick({ x: 125, y: 425 });
  let card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.equal(card.title, 'Persia');
  assert.deepEqual(card.details, [
    'Cliopatria: Big Empire',
    'IoU with Cliopatria: 0.72',
    'Flags: joined parts of one colour',
    'Sample year 520 BC',
    '1,000,000 km²',
    'Cottereau borders (private)',
  ]);
  assert.equal(f.layer.view().selected.kind, 'cottereau');
  assert.equal(f.layer.view().selected.name, 'Big Empire');
  // The same spot again: what lies under it.
  f.layer._onClick({ x: 125, y: 425 });
  card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.equal(card.title, 'Small Kingdom');

  // A Cliopatria polity he is matched to: its card gives his IoU.
  f.layer._onClick({ x: 185, y: 475 });
  card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.equal(card.title, 'Big');
  assert.ok(card.details.includes('IoU with Cottereau’s Persia: 0.72'));
  assert.match(card.details.at(-1), /CC BY 4\.0/, 'the credit stays last');
  assert.deepEqual(f.layer.view().selected.matches, [
    { label: 'Persia', iou: 0.72 },
  ]);
  // With the overlay off, no IoU line.
  f.layer.setBorders({ on: false });
  f.layer._onClick({ x: 500, y: 0 });
  f.layer._onClick({ x: 185, y: 475 });
  card = f.drawn.at(-1).entries.find((e) => e.id === 'card');
  assert.ok(!card.details.some((line) => /IoU/.test(line)));
});

test('borders: not built yet, the switch is there but nothing draws', async () => {
  const f = fixture({
    initial: BORDERS_ON,
    borders: bordersSource({ built: false }),
  });
  f.layer.enable(f.viewer);
  await f.settle();
  assert.equal(f.layer.view().borders.available, true);
  assert.equal(f.layer.view().borders.status, 'not-built');
  assert.equal(f.layer._state().bordersLayer, null);
});
