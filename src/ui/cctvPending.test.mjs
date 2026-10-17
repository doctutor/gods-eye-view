import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptPayload,
  parseAdjustInput,
  pendingCardModel,
} from './cctvPending.js';

test('a queued stream card shows its suggestion with its precision and source', () => {
  const model = pendingCardModel({
    videoId: 'NEWLIVE0000',
    title: 'Charlo Osprey Nest',
    channelTitle: 'Explore Osprey & Peregrine Falcon Cams',
    status: 'live',
    thumbnailUrl: 'https://i.ytimg.com/vi/NEWLIVE0000/hqdefault.jpg',
    suggestion: {
      kind: 'text',
      lat: 47.438,
      lon: -114.173,
      coordinatesQuality: 'area',
      label: 'Charlo, Montana',
    },
  });
  assert.equal(model.placeText, 'Charlo, Montana · AREA');
  assert.equal(model.sourceText, 'from the title/description');
  assert.equal(model.status, 'LIVE');
  assert.deepEqual(model.position, {
    lat: 47.438,
    lon: -114.173,
    coordinatesQuality: 'area',
    label: 'Charlo, Montana',
  });

  const none = pendingCardModel({ videoId: 'x', suggestion: { kind: 'none' } });
  assert.equal(none.position, null);
  assert.match(none.placeText, /No position suggested/);
  assert.equal(none.title, 'Untitled stream');
  assert.equal(pendingCardModel(null).position, null);
});

test('the adjust box takes coordinates or a place name', () => {
  assert.deepEqual(parseAdjustInput(' 39.2874, -76.6145 '), {
    kind: 'coords',
    lat: 39.2874,
    lon: -76.6145,
  });
  assert.deepEqual(parseAdjustInput('47.4 -114.2'), {
    kind: 'coords',
    lat: 47.4,
    lon: -114.2,
  });
  assert.match(parseAdjustInput('95, 10').error, /out of range/);
  assert.match(parseAdjustInput('0, 0').error, /out of range/);
  assert.deepEqual(parseAdjustInput('Charlo, Montana'), {
    kind: 'place',
    query: 'Charlo, Montana',
  });
  assert.match(parseAdjustInput('   ').error, /Type a place/);
});

test('an accept carries the chosen position and its precision', () => {
  assert.deepEqual(
    acceptPayload('NEWLIVE0000', {
      lat: 47.438,
      lon: -114.173,
      coordinatesQuality: 'area',
      label: 'Charlo, Montana',
    }),
    {
      videoId: 'NEWLIVE0000',
      lat: 47.438,
      lon: -114.173,
      coordinatesQuality: 'area',
      place: 'Charlo, Montana',
    },
  );
});

test('a card the placement rule left for a person says why', () => {
  assert.equal(
    pendingCardModel({ videoId: 'x', triage: { code: 'area-not-campus' } })
      .whyText,
    'WHY: channel has only area precision',
  );
  assert.equal(
    pendingCardModel({ videoId: 'x', triage: { code: 'geotag' } }).whyText,
    'WHY: position is the operator’s geotag; check it is not a town centre',
  );
  assert.equal(
    pendingCardModel({ videoId: 'x' }).whyText,
    '',
    'no rule, no line',
  );
  assert.equal(
    pendingCardModel({ videoId: 'x', triage: { code: 'unknown' } }).whyText,
    '',
  );
});
