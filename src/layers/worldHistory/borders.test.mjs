// Personal fork: the PRIVATE Cottereau borders overlay's client side
// (./borders.js) on synthetic samples (no data of the video): the route
// present or absent, the sample a year shows, the overlay's field in `wh`
// written only where the route answers, the shapes for each mode, the
// differences painted on the tile, and the card's and the panel's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDERS_FILL_ALPHA,
  CLIOPATRIA_ONLY,
  COTTEREAU_ONLY,
  bordersShapes,
  createCottereauBordersSource,
  decodeSample,
  differencePairs,
  hexColour,
  labelPoint,
  matchesFor,
  regionAt,
} from './borders.js';
import { paintDifferences } from './painter.js';
import { bordersCardDetails, matchLines, regionTitle } from './presentation.js';
import { createWorldHistoryStore } from './store.js';
import { decodeRecord } from './source.js';
import {
  decodeWorldHistoryParam,
  encodePolygons,
  encodeWorldHistoryParam,
} from '../../data/worldHistory.js';
import { bordersNote, bordersModeText } from '../../ui/worldHistoryPanel.js';

const square = (x, y, s) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
const served = (polygons) => JSON.parse(encodePolygons(polygons));

/** A sample as the route serves it: two polities and an unlabelled region. */
const SAMPLE_BODY = Object.freeze({
  format: 1,
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
      regions: 2,
      iou: 0.7234,
      polygons: served([[square(11, 41, 5)], [square(30, 30, 1)]]),
    },
    {
      track: 2,
      label: 'Lydia',
      cliopatria: null,
      colour: '#3366cc',
      areaKm2: 20_000,
      flags: ['split'],
      regions: 1,
      polygons: served([[square(12, 42, 1)]]),
    },
  ],
  unlabelled: [
    {
      colour: '#00ff00',
      areaKm2: 50,
      px: 10,
      lon: 50.5,
      lat: 50.5,
      polygons: served([[square(50, 50, 1)]]),
    },
  ],
});

function response(status, body, type = 'application/json') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name === 'content-type' ? type : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

test('the route: present only when it answers its own JSON status', async () => {
  const sourceFor = (answer) =>
    createCottereauBordersSource({ fetchImpl: async () => answer() });
  assert.deepEqual(
    await sourceFor(() =>
      response(200, { built: true, years: [-2500, 2025] }),
    ).status(),
    { available: true, built: true, years: [-2500, 2025] },
  );
  assert.equal(
    (await sourceFor(() => response(200, { built: false })).status()).built,
    false,
    'there, not built yet',
  );
  assert.deepEqual(
    await sourceFor(() =>
      response(200, '<!doctype html>', 'text/html'),
    ).status(),
    { available: false },
    'the dev server’s page for an unknown path is no route',
  );
  assert.deepEqual(
    await sourceFor(() => response(404, { error: 'x' })).status(),
    { available: false },
  );
  assert.deepEqual(
    await sourceFor(() => response(200, { other: 1 })).status(),
    { available: false },
    'JSON, but not its status',
  );
  assert.deepEqual(
    await sourceFor(() => {
      throw new Error('offline');
    }).status(),
    { available: false },
  );
});

test('a year asks for its sample once; before the first sample, none; the same sample decoded once', async () => {
  const asked = [];
  const source = createCottereauBordersSource({
    fetchImpl: async (url) => {
      asked.push(url);
      const year = Number(url.split('/').at(-1));
      if (year < -600) return response(404, { error: 'none' });
      if (year === 99) return response(500, { error: 'x' });
      return response(200, SAMPLE_BODY);
    },
  });
  const a = await source.year(-500);
  assert.equal(a.year, -520, 'the latest sample at or before the year');
  assert.equal(a.index, 7);
  assert.equal(await source.year(-500), a);
  const b = await source.year(-510);
  assert.equal(b, a, 'another year in the same sample: decoded once');
  assert.equal(await source.year(-700), null);
  await assert.rejects(source.year(99), /HTTP 500/);
  assert.deepEqual(asked, [
    '/api/cottereau-borders/year/-500',
    '/api/cottereau-borders/year/-510',
    '/api/cottereau-borders/year/-700',
    '/api/cottereau-borders/year/99',
  ]);
  await assert.rejects(source.year(99), /HTTP 500/, 'a failure is asked again');
  assert.equal(asked.length, 5);
});

test('wh: the overlay’s field rides only where the route answers, and round-trips', () => {
  const on = {
    ...decodeWorldHistoryParam(''),
    enabled: true,
    year: -500,
    borders: { on: true, mode: 'fills', labels: false, opacity: 0.7 },
  };
  assert.equal(encodeWorldHistoryParam(on), '1.-500.c.60', 'not asked for');
  const token = encodeWorldHistoryParam(on, { borders: true });
  assert.equal(token, '1.-500.c.60~@1f0.70');
  assert.deepEqual(decodeWorldHistoryParam(token), on);
  assert.equal(
    encodeWorldHistoryParam(decodeWorldHistoryParam(''), { borders: true }),
    '',
    'at its defaults: nothing',
  );
  assert.equal(
    encodeWorldHistoryParam(
      {
        ...decodeWorldHistoryParam(''),
        borders: { on: true, mode: 'differences', labels: true, opacity: 1 },
      },
      { borders: true },
    ),
    '0.1.c.60~@1d1.100',
    'off, but the overlay set: written',
  );
  // An old reader's token, and junk, leave it at its defaults.
  assert.equal(decodeWorldHistoryParam('1.5.c.60~@9z0.50').borders.on, false);
  // With a list: the field rides last.
  assert.equal(
    encodeWorldHistoryParam(
      { ...on, list: [{ name: 'A', extent: 'max', visible: true, color: 0 }] },
      { borders: true },
    ),
    '1.-500.c.60~*mA~@1f0.70',
  );

  // The store: a hash's field kept while unknown, dropped once the route is absent.
  const store = createWorldHistoryStore({ initial: on });
  let heard = 0;
  store.subscribe(() => heard++);
  assert.equal(store.bordersAvailable(), null);
  assert.match(store.param(), /~@1f0\.70$/);
  store.setBordersAvailable(false);
  assert.equal(heard, 1, 'the share link hears it');
  assert.equal(store.param(), '1.-500.c.60');
  store.setBordersAvailable(true);
  assert.match(store.param(), /~@1f0\.70$/);
  store.setBorders({ mode: 'outlines', opacity: 2 });
  assert.deepEqual(store.get().borders, {
    on: true,
    mode: 'outlines',
    labels: false,
    opacity: 1,
  });
  store.setBorders({ mode: 'nonsense' });
  assert.equal(store.get().borders.mode, 'outlines');
  const before = heard;
  store.setBorders({ on: true });
  assert.equal(heard, before, 'unchanged: unheard');
});

test('decoded: polygons, boxes, label points; outlines in the light ink over a halo, fills in his colours', () => {
  const sample = decodeSample(SAMPLE_BODY);
  assert.equal(sample.polities.length, 2);
  assert.equal(sample.unlabelled.length, 1);
  const persia = sample.polities[0];
  assert.deepEqual(persia.box, [11, 30, 31, 46]);
  assert.deepEqual(persia.at, [13.5, 43.5], 'the largest part’s centroid');
  assert.deepEqual(sample.unlabelled[0].flags, ['unlabelled']);
  assert.deepEqual(hexColour('#aa3300'), [170, 51, 0]);
  assert.deepEqual(hexColour('junk'), [128, 128, 128]);
  // A C shape's centroid is outside it: the box's middle instead.
  const c = labelPoint([
    [Float64Array.from([0, 0, 10, 0, 10, 1, 1, 1, 1, 9, 10, 9, 10, 10, 0, 10])],
  ]);
  assert.deepEqual(c, [5, 5]);

  const outlines = bordersShapes(sample, 'outlines');
  assert.equal(outlines.length, 3, 'his polities and the unlabelled region');
  assert.equal(outlines[0].fillAlpha, 0);
  assert.deepEqual(outlines[0].stroke, [255, 255, 255]);
  assert.ok(outlines[0].halo.width > outlines[0].strokeWidth);
  const fills = bordersShapes(sample, 'fills');
  assert.equal(fills[0].fillAlpha, BORDERS_FILL_ALPHA);
  assert.deepEqual(fills[1].fill, [51, 102, 204]);
});

test('differences: his polities against Cliopatria’s of the same name, each side cut by the other', () => {
  const sample = decodeSample(SAMPLE_BODY);
  const cliopatria = [
    decodeRecord({
      name: 'Big Empire',
      polygons: served([[square(10, 40, 10)]]),
    }),
    decodeRecord({ name: 'Other', polygons: served([[square(0, 0, 1)]]) }),
  ];
  const pairs = differencePairs(sample, cliopatria);
  assert.deepEqual(
    pairs.map((p) => [p.name, p.a.length, p.b.length, p.box]),
    [['Big Empire', 2, 1, [10, 30, 31, 50]]],
    'only the matched; his two parts against its one',
  );

  const log = [];
  const ctx = (name) => {
    const c = { name };
    for (const m of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'clearRect'])
      c[m] = () => {};
    c.fill = (rule) =>
      log.push([name, 'fill', rule, c.fillStyle, c.globalCompositeOperation]);
    c.drawImage = (canvas) =>
      log.push([name, 'draw', canvas.name, c.globalAlpha]);
    return c;
  };
  const scratch = { name: 'scratch', context: ctx('scratch') };
  scratch.getContext = () => scratch.context;
  const tile = ctx('tile');
  const painted = paintDifferences(
    tile,
    pairs,
    { west: 0, south: 30, east: 40, north: 70 },
    {
      onlyA: COTTEREAU_ONLY,
      onlyB: CLIOPATRIA_ONLY,
      alpha: 0.7,
      createCanvas: () => scratch,
    },
  );
  assert.equal(painted, 1);
  assert.deepEqual(log, [
    ['scratch', 'fill', 'evenodd', 'rgba(255, 140, 0, 1)', 'source-over'],
    ['scratch', 'fill', 'evenodd', 'rgba(0, 0, 0, 1)', 'destination-out'],
    ['tile', 'draw', 'scratch', 0.7],
    ['scratch', 'fill', 'evenodd', 'rgba(0, 114, 255, 1)', 'source-over'],
    ['scratch', 'fill', 'evenodd', 'rgba(0, 0, 0, 1)', 'destination-out'],
    ['tile', 'draw', 'scratch', 0.7],
  ]);
  assert.equal(tile.globalAlpha, 1);
  assert.equal(
    paintDifferences(
      tile,
      pairs,
      { west: 100, south: 0, east: 110, north: 10 },
      {
        onlyA: [0, 0, 0],
        onlyB: [0, 0, 0],
        alpha: 1,
        createCanvas: () => scratch,
      },
    ),
    0,
    'a tile it does not cross',
  );
});

test('a click’s region and the cards’ words: his label, the match, the IoU, the flags, the sample’s year', () => {
  const sample = decodeSample(SAMPLE_BODY);
  assert.equal(regionAt(sample, 12.5, 42.5).label, 'Lydia', 'the smaller');
  assert.equal(regionAt(sample, 14, 44).label, 'Persia');
  assert.equal(regionAt(sample, 50.5, 50.5).unlabelled, true);
  assert.equal(regionAt(sample, -50, 0), null);

  const [persia, lydia] = sample.polities;
  assert.deepEqual(bordersCardDetails(persia, { sampleYear: -520 }), [
    'Cliopatria: Big Empire',
    'IoU with Cliopatria: 0.72',
    'Flags: joined parts of one colour',
    'Sample year 520 BC',
    '1,000,000 km²',
    'Cottereau borders (private)',
  ]);
  assert.deepEqual(
    bordersCardDetails(lydia, { sampleYear: -520 }).slice(0, 2),
    ['No Cliopatria match', 'Flags: split from a shared fill'],
  );
  const blank = sample.unlabelled[0];
  assert.equal(regionTitle(blank), 'Unlabelled region');
  assert.equal(
    bordersCardDetails(blank, { sampleYear: -520 })[0],
    'Flags: unlabelled',
  );
  assert.deepEqual(matchesFor(sample, 'Big Empire'), [
    { label: 'Persia', iou: 0.7234 },
  ]);
  assert.deepEqual(matchesFor(sample, 'Nobody'), []);
  assert.deepEqual(matchLines(matchesFor(sample, 'Big Empire')), [
    'IoU with Cottereau’s Persia: 0.72',
  ]);
  assert.deepEqual(matchesFor(null, 'Big Empire'), []);
});

test('the panel’s words for the overlay: its state, and the sample’s year when not the slider’s', () => {
  const b = (patch) => ({
    status: 'ready',
    sampleYear: -500,
    error: '',
    ...patch,
  });
  assert.equal(bordersNote(b({}), -500), '');
  assert.equal(
    bordersNote(b({ sampleYear: -520 }), -500),
    'Sample year 520 BC',
  );
  assert.equal(
    bordersNote(b({ status: 'none' }), -2600),
    'No Cottereau sample at or before 2600 BC',
  );
  assert.match(
    bordersNote(b({ status: 'not-built' }), 1),
    /borders\.mjs extract/,
  );
  assert.match(
    bordersNote(b({ status: 'failed', error: 'HTTP 500' }), 1),
    /HTTP 500/,
  );
  assert.equal(
    bordersNote(b({ status: 'loading' }), 1),
    'Loading Cottereau’s borders…',
  );
  assert.equal(bordersNote(b({ status: 'off' }), 1), '');
  assert.deepEqual(['outlines', 'fills', 'differences'].map(bordersModeText), [
    'OUTLINES',
    'FILLS',
    'DIFFERENCES',
  ]);
});
