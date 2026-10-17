import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANDMARK_NEARBY_KM,
  LANDMARK_TOP,
  NEARBY_KM,
  budgetLine,
  countsLine,
  landmarkRowModel,
  landmarkVideoSplit,
  landmarkVideoState,
  rankLandmarks,
  rankVideos,
  searchStatus,
  videoRowModel,
  videoSearchText,
} from './recordedVideoPanel.js';

const BALTIMORE = { lat: 39.2904, lon: -76.6122 };
const record = (id, extra = {}) => ({
  id,
  videoId: 'aaaaaaaaaaa',
  title: `Video ${id}`,
  channelTitle: 'Channel',
  place: '',
  publishedAt: '2026-10-01T12:00:00Z',
  lat: BALTIMORE.lat,
  lon: BALTIMORE.lon,
  coordinatesQuality: 'site',
  source: 'youtube-geotag',
  ...extra,
});

const records = [
  record('yt-near', {
    title: 'Woodlawn High parents demand answers',
    channelTitle: 'WBAL-TV 11 Baltimore',
    place: 'Woodlawn High School',
    lat: 39.3154,
    lon: -76.7338,
  }),
  record('yt-closest', {
    title: 'Inner Harbor <walk>',
    place: 'Inner Harbor',
    lat: 39.2856,
    lon: -76.6084,
  }),
  record('yt-columbia', {
    title: 'HUGE Tomato Harvest',
    channelTitle: 'VeryGoodGardening',
    place: 'Columbia',
    lat: 39.20371,
    lon: -76.86105,
    coordinatesQuality: 'region',
  }),
  record('wd-far', {
    title: 'Francis Scott Key Bridge collapse',
    channelTitle: '',
    place: 'Francis Scott Key Bridge collapse',
    lat: 39.2156,
    lon: -76.5302,
    source: 'wikidata',
  }),
  record('wd-dc', {
    title: 'inauguration of Joe Biden',
    channelTitle: '',
    place: 'inauguration of Joe Biden',
    lat: 38.8899,
    lon: -77.0091,
    source: 'wikidata',
  }),
  record('wd-paris', {
    title: 'Notre-Dame de Paris fire',
    channelTitle: '',
    place: 'Notre-Dame de Paris fire',
    lat: 48.853,
    lon: 2.3499,
    source: 'wikidata',
    coordinatesQuality: 'site',
  }),
];

test('videos near the view are listed nearest first; a query searches them all', () => {
  assert.equal(
    videoSearchText(records[0]),
    'Woodlawn High parents demand answers · WBAL-TV 11 Baltimore · Woodlawn High School',
  );
  const nearby = rankVideos(records, BALTIMORE, '');
  assert.deepEqual(
    nearby.map((e) => e.record.id),
    ['yt-closest', 'yt-near', 'wd-far', 'yt-columbia', 'wd-dc'],
  );
  assert.ok(
    nearby.every((e) => e.distanceKm <= NEARBY_KM),
    'Paris is not near Baltimore',
  );
  // A query reaches beyond the view, and every token must match.
  assert.deepEqual(
    rankVideos(records, BALTIMORE, 'notre fire').map((e) => e.record.id),
    ['wd-paris'],
  );
  assert.deepEqual(
    rankVideos(records, BALTIMORE, 'gardening').map((e) => e.record.id),
    ['yt-columbia'],
    'channel is searched',
  );
  assert.deepEqual(
    rankVideos(records, BALTIMORE, 'woodlawn school').map((e) => e.record.id),
    ['yt-near'],
    'place is searched',
  );
  assert.deepEqual(rankVideos(records, BALTIMORE, 'nothing like this'), []);
  // Without a centre: everything, by title.
  assert.equal(rankVideos(records, null, '').length, records.length);
  assert.equal(rankVideos(records, BALTIMORE, '', { limit: 2 }).length, 2);
});

test('a row shows the marked title, details and the precision and source tags', () => {
  const [closest] = rankVideos(records, BALTIMORE, 'harbor');
  const row = videoRowModel(closest);
  assert.equal(row.id, 'yt-closest');
  assert.equal(
    row.titleHtml,
    'Inner <mark>Harbor</mark> &lt;walk&gt;',
    'escaped, title-only marks',
  );
  assert.equal(row.details, 'Channel · 2026-10-01 · Inner Harbor · 626 m');
  assert.equal(row.precision, 'SITE');
  assert.equal(row.source, 'GEOTAG');
  const wikidata = videoRowModel(
    rankVideos(records, BALTIMORE, 'key bridge')[0],
  );
  assert.equal(wikidata.source, 'WIKIDATA');
  assert.equal(
    wikidata.details,
    '2026-10-01 · Francis Scott Key Bridge collapse · 10.9 km',
  );
  const region = videoRowModel(rankVideos(records, BALTIMORE, 'tomato')[0]);
  assert.equal(region.precision, 'REGION');
  assert.equal(
    videoRowModel({
      record: record('x', {
        recordedAt: '2025-01-02T00:00:00Z',
        coordinatesQuality: 'odd',
      }),
      ranges: [],
      distanceKm: NaN,
    }).details,
    'Channel · 2025-01-02',
  );
});

test('counts, budget and the last search read short', () => {
  assert.equal(countsLine(records.slice(0, 5)), '5 videos · 4 site · 1 region');
  assert.equal(
    countsLine([record('a', { coordinatesQuality: 'area' })]),
    '1 video · 1 area',
  );
  assert.equal(countsLine([]), '0 videos');
  assert.equal(
    budgetLine({ used: 202, budget: 1000, remaining: 798 }),
    'Search budget 798 / 1000 units left today',
  );
  assert.equal(
    budgetLine({ used: 1010, budget: 1000 }),
    'Search budget 0 / 1000 units left today',
  );
  assert.equal(budgetLine(null), '');
  assert.equal(searchStatus(null), '');
  assert.equal(searchStatus({ cached: true }), 'This view: stored answer');
  assert.equal(searchStatus({ cached: false }), 'This view: just asked');
  assert.equal(
    searchStatus({ refused: true }),
    'Search budget used up for today',
  );
  assert.equal(
    searchStatus({ configured: false }),
    'No YouTube key: Wikidata only',
  );
});

const landmark = (qid, label, lat, lon, extra = {}) => ({
  qid,
  label,
  lat,
  lon,
  sitelinks: 10,
  kind: 'museum',
  loading: false,
  refused: false,
  configured: true,
  error: null,
  videoCount: null,
  ...extra,
});
const landmarks = [
  landmark('Q1438634', 'Fort McHenry', 39.2633, -76.5797, {
    kind: 'historic site',
  }),
  landmark('Q1000257', 'National Aquarium', 39.2853, -76.6083, {
    kind: 'aquarium',
    videoCount: 19,
  }),
  landmark('Q210081', 'Walters Art Museum', 39.2966, -76.6158),
  landmark('Q1', 'Far Away Monument', 40.5, -74.0),
];

test('LANDMARKS NEARBY: nearest first within reach; a query matches names anywhere', () => {
  assert.deepEqual(
    rankLandmarks(landmarks, BALTIMORE, '').map((e) => e.landmark.qid),
    ['Q1000257', 'Q210081', 'Q1438634'],
  );
  assert.ok(
    rankLandmarks(landmarks, BALTIMORE, '').every(
      (e) => e.distanceKm <= LANDMARK_NEARBY_KM,
    ),
  );
  assert.deepEqual(
    rankLandmarks(landmarks, BALTIMORE, 'monument').map((e) => e.landmark.qid),
    ['Q1'],
  );
  assert.equal(rankLandmarks(landmarks, BALTIMORE, '', { limit: 1 }).length, 1);
  assert.deepEqual(rankLandmarks(null, BALTIMORE, ''), []);
});

test('a landmark row says what is known of its videos', () => {
  const [aquarium, walters] = rankLandmarks(landmarks, BALTIMORE, '');
  assert.deepEqual(landmarkRowModel(aquarium), {
    qid: 'Q1000257',
    labelHtml: 'National Aquarium',
    details: 'aquarium · 659 m',
    state: '19 VIDEOS',
    asked: true,
  });
  assert.equal(landmarkRowModel(walters).state, 'FIND VIDEOS');
  assert.equal(landmarkRowModel(walters).asked, false);
  assert.equal(
    landmarkRowModel(rankLandmarks(landmarks, BALTIMORE, 'fort')[0]).labelHtml,
    '<mark>Fort</mark> McHenry',
  );
  assert.equal(landmarkVideoState({ loading: true }), 'ASKING…');
  assert.equal(landmarkVideoState({ refused: true }), 'BUDGET USED');
  assert.equal(landmarkVideoState({ configured: false }), 'NO KEY');
  assert.equal(landmarkVideoState({ error: 'x' }), 'FAILED');
  assert.equal(landmarkVideoState({ videoCount: 1 }), '1 VIDEO');
  assert.equal(landmarkVideoState({ videoCount: 0 }), '0 VIDEOS');
});

test('a landmark shows its top five, the rest behind MORE', () => {
  const list = Array.from({ length: 8 }, (_, i) => record(`lm-${i}`));
  const top = landmarkVideoSplit(list);
  assert.equal(top.shown.length, LANDMARK_TOP);
  assert.equal(top.more, 3);
  assert.deepEqual(
    top.shown.map((r) => r.id),
    ['lm-0', 'lm-1', 'lm-2', 'lm-3', 'lm-4'],
    'in the ranked order',
  );
  const all = landmarkVideoSplit(list, { expanded: true });
  assert.equal(all.shown.length, 8);
  assert.equal(all.more, 0);
  assert.deepEqual(landmarkVideoSplit(null), { shown: [], more: 0 });
});

test('a landmark’s video row is tagged ABOUT, LANDMARK and its kind, and counted', () => {
  const about = record('lm-Q1438634-aaaaaaaaaaa', {
    title: 'Fort McHenry Full Tour',
    place: 'Fort McHenry',
    coordinatesQuality: 'about',
    source: 'landmark',
    kind: 'tour',
    landmarkQid: 'Q1438634',
  });
  const row = videoRowModel({ record: about, ranges: [], distanceKm: NaN });
  assert.equal(row.precision, 'ABOUT');
  assert.equal(row.source, 'LANDMARK');
  assert.equal(row.kind, 'tour');
  assert.equal(videoRowModel({ record: records[0], ranges: [] }).kind, '');
  assert.equal(countsLine([about, records[0]]), '2 videos · 1 site · 1 about');
});
