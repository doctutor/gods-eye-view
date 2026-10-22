// Personal fork: the Wikipedia layer's Articles mode: the dots for a view,
// the nearest titles, the card on click with its summary asked only then.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWikipediaCoverageLayer } from './index.js';
import { createWikipediaCoverageSource, pointsUrl, toPoint } from './source.js';
import {
  LABEL_LIMIT,
  articleUrl,
  cardDetails,
  labelCohort,
  pointColor,
  preferredWiki,
} from './points.js';
import { pointsLegend } from './presentation.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const point = (i, extra = {}) =>
  toPoint({
    id: `wp:1:${100 + i}:p:${i}:${i}`,
    page: 100 + i,
    qid: `Q${1000 + i}`,
    title: `Article ${i}`,
    type: 'landmark',
    class: 'landmark',
    bytes: 12_400,
    at: [2.35 + i * 0.0005, 48.85],
    ...extra,
  });

test('titles go to the nearest of the best ranked, close in only', () => {
  const points = Array.from({ length: 50 }, (_, i) => point(i));
  const view = { lat: 48.85, lon: 2.35, height: 2_000 };
  const cohort = labelCohort(points, view);
  assert.equal(cohort.length, LABEL_LIMIT);
  assert.equal(cohort[0].point.title, 'Article 0', 'the nearest first');
  assert.deepEqual(labelCohort(points, { ...view, height: 80_000 }), []);
  assert.equal(pointColor({ class: 'nature' }), '#06d6a0');
  assert.equal(pointColor({ class: 'nature', secondary: true }), '#b0b0b0');
  assert.equal(articleUrl({ page: 11 }), 'https://en.wikipedia.org/?curid=11');
});

test('a card says the type, the summary, the size, the item and the dump', () => {
  assert.deepEqual(
    cardDetails(point(1), {
      dumpDate: '2026-10-08',
      summary: { description: 'Tower in Paris', extract: 'A lattice tower.' },
    }),
    [
      'Landmarks · landmark',
      'Tower in Paris',
      'A lattice tower.',
      '12 kB of wikitext · Q1001',
      '48.85000, 2.35050',
      'Wikipedia, CC BY-SA 4.0 · dump of 2026-10-08 · click to open',
    ],
  );
  assert.match(
    cardDetails(point(2, { secondary: true }))[0],
    /secondary coordinate$/,
  );
  assert.deepEqual(
    pointsLegend({ secondary: true }).map((entry) => entry.label),
    [
      'Places',
      'Landmarks',
      'Nature',
      'Other articles',
      'Secondary coordinates',
    ],
  );
  assert.equal(
    pointsUrl({
      box: { west: 1, south: 2, east: 3, north: 4 },
      zoom: 9,
      secondary: true,
      version: 'abc',
    }),
    '/api/wikipedia-coverage/points?west=1&south=2&east=3&north=4&zoom=9&secondary=1&v=abc',
  );
  assert.equal(toPoint({ id: 'nope', page: 1, title: 'x', at: [0, 0] }), null);
});

function fakeViewer(height) {
  const primitives = [];
  return {
    primitives,
    viewer: {
      imageryLayers: { add() {}, remove() {} },
      scene: {
        primitives: {
          add: (p) => (primitives.push(p), p),
          remove: (p) => {
            const i = primitives.indexOf(p);
            if (i >= 0) primitives.splice(i, 1);
            return i >= 0;
          },
        },
        pick: () => ({ id: 'wikipedia-point:wp:1:101:p:1:1' }),
      },
      camera: {
        positionCartographic: Cesium.Cartographic.fromDegrees(
          2.35,
          48.85,
          height,
        ),
        moveEnd: { addEventListener: () => () => {} },
      },
    },
  };
}

/** A server: the catalog with points built, the dots, the summaries. */
function fakeServer({ secondary = 2 } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.startsWith('/api/wikipedia-coverage/layers'))
      return Response.json({
        configured: true,
        builtAt: '2026-10-18T03:28:51.999Z',
        dump: { date: '2026-10-08' },
        rows: { kept: 3 },
        maxZoom: 9,
        attribution: 'Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData',
        variants: [],
        points: {
          built: true,
          version: 'abcdef012345',
          points: 3,
          secondary,
          dump: { date: '2026-10-08' },
        },
      });
    if (url.startsWith('/api/wikipedia-coverage/points'))
      return Response.json({
        version: 'abcdef012345',
        zoom: 12,
        saturated: false,
        points: [0, 1, 2].map((i) => ({
          id: `wp:1:${100 + i}:p:${i}:${i}`,
          page: 100 + i,
          qid: `Q${1000 + i}`,
          title: `Article ${i}`,
          class: 'landmark',
          bytes: 12_400,
          at: [2.35 + i * 0.0005, 48.85],
        })),
      });
    if (url.startsWith('/api/wikipedia-coverage/summary'))
      return Response.json({
        description: 'A place',
        extract: 'Its extract.',
        thumbnail: { source: 'https://upload.wikimedia.org/a.jpg' },
      });
    return new Response('{}', { status: 404 });
  };
  return { asked, fetchImpl };
}

test('the Articles mode draws the dots, the nearest titles, and a card on click', async () => {
  const server = fakeServer();
  const entries = new Map();
  const overlayHost = {
    setEntries: (source, list) => entries.set(source, list),
    setVisible() {},
    clearSource: (source) => entries.delete(source),
  };
  const opened = [];
  const layer = createWikipediaCoverageLayer({
    source: createWikipediaCoverageSource({ fetchImpl: server.fetchImpl }),
    storage: null,
    overlayHost,
    hitTest: () => null,
    openUrl: (url) => opened.push(url),
  });
  const env = fakeViewer(3_000);
  layer.init(env.viewer);
  layer.enable(env.viewer);
  await flush();
  const asked = server.asked.find((url) => url.includes('/points?'));
  assert.ok(asked, 'the dots are asked for');
  assert.match(asked, /zoom=14/);
  assert.match(asked, /v=abcdef012345/);
  assert.doesNotMatch(asked, /secondary/);
  assert.equal(env.primitives.length, 1);
  assert.equal(env.primitives[0].length, 3);
  const labels = entries.get('wikipedia-points');
  assert.equal(labels.length, 3);
  assert.ok(labels.every((entry) => entry.variant === 'label'));
  assert.equal(layer.getStats().count, 3);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((c) => [c.id, c.active]),
    [
      ['points', true],
      ['articles', false],
      ['text', false],
      ['capita', false],
      ['textcapita', false],
      ['secondary', false],
    ],
  );
  assert.equal(controls.legend.length, 4);
  // The dots keep their class colours: no Scale row in this mode.
  assert.equal(controls.scale, undefined);
  assert.equal(controls.info, '3 articles in view · Dump of 2026-10-08');
  // Nothing about the summary until a click.
  assert.equal(
    server.asked.some((url) => url.includes('/summary')),
    false,
  );
  layer._points.onClick({ x: 10, y: 10 });
  await flush();
  const card = entries.get('wikipedia-points').find((e) => e.id === 'card');
  assert.equal(card.title, 'Article 1');
  assert.ok(card.details.includes('Its extract.'));
  assert.equal(
    server.asked.filter((url) => url.includes('/summary')).length,
    1,
  );
  card.activate();
  assert.deepEqual(opened, ['https://en.wikipedia.org/?curid=101']);
  // The same article again closes the card; its summary is not asked again.
  layer._points.onClick({ x: 10, y: 10 });
  layer._points.onClick({ x: 10, y: 10 });
  await flush();
  assert.equal(
    server.asked.filter((url) => url.includes('/summary')).length,
    1,
    'once a session',
  );

  // Secondary coordinates: asked when chosen.
  layer.setSecondary(true);
  await flush();
  assert.match(
    server.asked.filter((url) => url.includes('/points?')).at(-1),
    /secondary=1/,
  );
  assert.equal(layer.getRowControls().legend.length, 5);
  layer.disable();
  assert.equal(env.primitives.length, 0);
  assert.equal(entries.has('wikipedia-points'), false);
});

test('without the points index the Articles mode says what to run', async () => {
  const fetchImpl = async () =>
    Response.json({
      configured: true,
      variants: [],
      points: { built: false, message: 'none' },
    });
  const layer = createWikipediaCoverageLayer({
    source: createWikipediaCoverageSource({ fetchImpl }),
    storage: null,
  });
  const env = fakeViewer(3_000);
  layer.init(env.viewer);
  layer.enable(env.viewer);
  await flush();
  assert.equal(env.primitives.length, 0);
  const controls = layer.getRowControls();
  assert.equal(
    controls.info,
    'Run npm run wikipedia:build -- --points for the Wikipedia articles',
  );
  assert.equal(controls.chips.find((c) => c.id === 'points').state, 'error');
  assert.equal(controls.chips.find((c) => c.id === 'secondary').state, 'error');
  layer.destroy();
});

test('an index of several wikis: the card lists the languages and opens the viewer’s', async () => {
  const shared = point(2, {
    wiki: 'enwiki',
    wikis: ['enwiki', 'dewiki', 'xxwiki'],
  });
  assert.deepEqual(shared.wikis, ['enwiki', 'dewiki'], 'unknown wikis dropped');
  const german = point(3, { wiki: 'dewiki', wikis: ['dewiki'] });
  assert.equal(articleUrl(german), 'https://de.wikipedia.org/?curid=103');
  assert.equal(point(4).wiki, undefined, 'an enwiki-only index says nothing');
  assert.ok(cardDetails(shared).includes('Wikipedia in en · de'));
  assert.ok(
    !cardDetails(point(4)).some((line) => line.startsWith('Wikipedia in')),
  );
  assert.equal(preferredWiki(shared, 'de'), 'dewiki');
  assert.equal(preferredWiki(shared, 'en'), null, 'its own wiki already');
  assert.equal(preferredWiki(shared, 'ru'), null, 'no Russian article');
  // The source asks a wiki's summary by name, and an item's languages once.
  const asked = [];
  const source = createWikipediaCoverageSource({
    fetchImpl: async (url) => {
      asked.push(url);
      return Response.json(
        url.includes('/langs')
          ? {
              qid: 'Q1002',
              langs: [
                { wiki: 'enwiki', page: 102 },
                { wiki: 'dewiki', page: 9 },
                { wiki: 'xxwiki', page: 1 },
              ],
            }
          : { title: 'x', extract: 'y' },
      );
    },
  });
  await source.summary('Brandenburger Tor', 'dewiki');
  const langs = await source.langs('Q1002');
  await source.langs('Q1002');
  assert.deepEqual(
    langs.map((l) => l.url),
    [
      'https://en.wikipedia.org/?curid=102',
      'https://de.wikipedia.org/?curid=9',
    ],
  );
  assert.deepEqual(asked, [
    '/api/wikipedia-coverage/summary?title=Brandenburger+Tor&wiki=dewiki',
    '/api/wikipedia-coverage/langs?qid=Q1002',
  ]);
});
