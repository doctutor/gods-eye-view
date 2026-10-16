import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_LIST_DEFAULT_LIMIT,
  cameraTag,
  formatDistance,
  markedHtml,
  matchRanges,
  nearestFirstIds,
  queryTokens,
  rankCameras,
  stepHighlight,
} from './cctvCameraList.js';

const BALTIMORE = { lat: 39.2904, lon: -76.6122 };
const cam = (id, name, city, lat, lon, extra = {}) => ({
  id,
  name,
  city,
  lat,
  lon,
  feedType: 'image',
  sourceKind: 'configured',
  ...extra,
});
const CAMERAS = [
  cam('austin', '5TH ST / CONGRESS AVE', 'Austin', 30.27, -97.74),
  cam(
    'falcons',
    'Peregrine falcon nest',
    '100 Light Street, Baltimore',
    39.2874,
    -76.6145,
    {
      embed: { provider: 'youtube', videoId: '1_BdSTneH3s' },
    },
  ),
  cam('i95', 'I-95 AT I-395', 'Baltimore', 39.27, -76.63),
  cam(
    'windy',
    'Halethorpe Weather-Watch',
    'Wynnewood, Oklahoma',
    39.237,
    -76.697,
    {
      sourceKind: 'windy',
    },
  ),
  cam('temple', 'Nishi Hongan-ji Temple', 'Linked webcam', 34.99, 135.75, {
    feedType: 'link',
  }),
];

test('cameras list nearest the view first, with distances', () => {
  const ranked = rankCameras(CAMERAS, BALTIMORE, '');
  assert.deepEqual(
    ranked.map((e) => e.camera.id),
    ['falcons', 'i95', 'windy', 'austin', 'temple'],
  );
  assert.equal(formatDistance(ranked[0].distanceKm), '388 m');
  assert.equal(formatDistance(ranked[1].distanceKm), '2.7 km');
  assert.equal(formatDistance(ranked[4].distanceKm), '11112 km');
  assert.equal(formatDistance(NaN), '');
});

test('without a centre the catalog order stands', () => {
  assert.deepEqual(
    rankCameras(CAMERAS, null, '').map((e) => e.camera.id),
    CAMERAS.map((c) => c.id).sort((a, b) => {
      const text = (id) => {
        const c = CAMERAS.find((x) => x.id === id);
        return `${c.city} · ${c.name}`;
      };
      return text(a).localeCompare(text(b));
    }),
  );
  assert.deepEqual(
    nearestFirstIds(CAMERAS, null),
    CAMERAS.map((c) => c.id),
  );
});

test('every typed word must match, anywhere in place, name, tag or category', () => {
  const ids = (q) => rankCameras(CAMERAS, BALTIMORE, q).map((e) => e.camera.id);
  assert.deepEqual(ids('balt'), ['falcons', 'i95']);
  assert.deepEqual(ids('balt falcon'), ['falcons']);
  assert.deepEqual(ids('WINDY'), ['windy']);
  assert.deepEqual(ids('youtube'), ['falcons']);
  assert.deepEqual(ids('link'), ['temple']);
  assert.deepEqual(ids('nothing here'), []);
  assert.deepEqual(queryTokens('  Two   words '), ['two', 'words']);
});

test('matched letters are marked and everything else escaped', () => {
  const ranges = matchRanges('London · Trafalgar <Square>', ['lon', 'square']);
  assert.deepEqual(ranges, [
    [0, 3],
    [20, 26],
  ]);
  assert.equal(
    markedHtml('London · Trafalgar <Square>', ranges),
    '<mark>Lon</mark>don · Trafalgar &lt;<mark>Square</mark>&gt;',
  );
  assert.deepEqual(
    matchRanges('abcabc', ['abc', 'bca']),
    [[0, 4]],
    'overlaps merge',
  );
  assert.equal(matchRanges('abc', ['x']), null);
});

test('tags say what kind of feed a camera is', () => {
  assert.equal(cameraTag(CAMERAS[0]), 'CCTV');
  assert.equal(cameraTag(CAMERAS[1]), 'YOUTUBE');
  assert.equal(cameraTag(CAMERAS[3]), 'WINDY');
  assert.equal(cameraTag(CAMERAS[4]), 'LINK');
  assert.equal(cameraTag({ feedType: 'hls' }), 'VIDEO');
});

test('the default list is capped, a query searches everything', () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    cam(
      `c${i}`,
      i === 399 ? 'Needle' : `Cam ${i}`,
      'Far',
      39.3 + i * 0.01,
      -76.6,
    ),
  );
  assert.equal(
    rankCameras(many, BALTIMORE, '').length,
    CAMERA_LIST_DEFAULT_LIMIT,
  );
  assert.deepEqual(
    rankCameras(many, BALTIMORE, 'needle').map((e) => e.camera.id),
    ['c399'],
  );
});

test('PREV/NEXT order is nearest first, and arrow keys wrap', () => {
  const order = nearestFirstIds(CAMERAS, BALTIMORE);
  assert.deepEqual(order, ['falcons', 'i95', 'windy', 'austin', 'temple']);
  assert.equal(stepHighlight(order, null, 1), 'falcons');
  assert.equal(stepHighlight(order, null, -1), 'temple');
  assert.equal(stepHighlight(order, 'temple', 1), 'falcons');
  assert.equal(stepHighlight(order, 'falcons', -1), 'temple');
  assert.equal(stepHighlight([], 'x', 1), null);
});
