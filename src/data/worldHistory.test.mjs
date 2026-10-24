// Personal fork: the World history model (src/data/worldHistory.js): years
// without a year 0, typed years, the served geometry's text form, the
// colours, the comparison list and the `wh` hash parameter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIOPATRIA_LAST_YEAR,
  DEFAULT_OPACITY,
  LIST_PALETTE,
  MAX_LIST_ENTRIES,
  SLIDER_MAX,
  SLIDER_MIN,
  WORLD_HISTORY_FIRST_YEAR,
  WORLD_HISTORY_LAST_YEAR,
  YEAR_PALETTE,
  addListEntry,
  clampYear,
  cliopatriaYear,
  decodePolygons,
  decodeWorldHistoryParam,
  defaultWorldHistoryState,
  encodePolygons,
  encodeWorldHistoryParam,
  isWorldYear,
  nextColorIndex,
  parseYear,
  polityColor,
  polygonsBox,
  polygonsContain,
  removeListEntry,
  sliderFromYear,
  stepYear,
  updateListEntry,
  yearFromSlider,
  yearParts,
} from './worldHistory.js';

test('typed years: BC and AD in their usual spellings, minus for BCE, never 0', () => {
  const cases = {
    '500 BC': -500,
    '500 bc': -500,
    '500BC': -500,
    '500 BCE': -500,
    '500 b.c.': -500,
    'c. 500 BC': -500,
    '-500': -500,
    '−500': -500,
    '1 AD': 1,
    'AD 1': 1,
    'a.d. 33': 33,
    '476 CE': 476,
    2025: 2025,
    2025: 2025,
    ' 1066 ': 1066,
    '1 BC': -1,
  };
  for (const [text, year] of Object.entries(cases))
    assert.equal(parseYear(text), year, text);
  for (const bad of [
    '0',
    '0 BC',
    '0 AD',
    '-500 BC',
    'BC',
    '',
    'abc',
    '12345',
    '5.5',
    null,
  ])
    assert.equal(parseYear(bad), null, String(bad));
});

test('no year 0: 1 BC is followed by 1 AD, on the slider and in steps', () => {
  assert.equal(stepYear(-1, 1), 1);
  assert.equal(stepYear(1, -1), -1);
  assert.equal(stepYear(-2, 3), 2);
  assert.equal(stepYear(WORLD_HISTORY_LAST_YEAR, 1), WORLD_HISTORY_LAST_YEAR);
  assert.equal(
    stepYear(WORLD_HISTORY_FIRST_YEAR, -1),
    WORLD_HISTORY_FIRST_YEAR,
  );
  assert.equal(
    sliderFromYear(-1) + 1,
    sliderFromYear(1),
    'neighbours on the slider',
  );
  assert.equal(yearFromSlider(SLIDER_MIN), WORLD_HISTORY_FIRST_YEAR);
  assert.equal(yearFromSlider(SLIDER_MAX), WORLD_HISTORY_LAST_YEAR);
  for (let p = SLIDER_MIN; p <= SLIDER_MAX; p += 97) {
    const year = yearFromSlider(p);
    assert.notEqual(year, 0);
    assert.equal(sliderFromYear(year), p);
  }
  assert.equal(clampYear(0), 1);
  assert.equal(clampYear(-9000), WORLD_HISTORY_FIRST_YEAR);
  assert.equal(clampYear(3000), WORLD_HISTORY_LAST_YEAR);
  assert.equal(isWorldYear(0), false);
  assert.equal(isWorldYear(-2500), true);
  assert.equal(isWorldYear(-2501), false);
  assert.deepEqual(yearParts(-500), { n: 500, era: 'BC' });
  assert.deepEqual(yearParts(1), { n: 1, era: 'AD' });
  assert.equal(cliopatriaYear(2025), CLIOPATRIA_LAST_YEAR, '2025 reads 2024');
  assert.equal(cliopatriaYear(1500), 1500);
});

test('the served geometry: deltas at 1e-4°, holes kept, contains and box', () => {
  const square = (x, y, s) => [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ];
  const polygons = [
    [square(10, 40, 4), square(11, 41, 1)],
    [square(-75.5, -10.25, 0.5)],
  ];
  const text = encodePolygons(polygons);
  assert.ok(text.length < 160, text);
  const back = decodePolygons(text);
  assert.equal(back.length, 2);
  assert.equal(back[0].length, 2, 'the hole kept');
  assert.equal(back[0][0].length, 8, 'four corners, not closed');
  assert.deepEqual([...back[1][0].slice(0, 2)], [-75.5, -10.25]);
  assert.deepEqual(polygonsBox(back), [-75.5, -10.25, 14, 44]);
  assert.equal(polygonsContain(back, 10.5, 40.5), true);
  assert.equal(polygonsContain(back, 11.5, 41.5), false, 'inside the hole');
  assert.equal(polygonsContain(back, -75.2, -10), true);
  assert.equal(polygonsContain(back, 0, 0), false);
  // A ring that collapses at 1e-4° goes.
  assert.equal(
    encodePolygons([
      [
        [
          [0, 0],
          [0.00001, 0],
          [0, 0.00001],
        ],
      ],
    ]),
    '[]',
  );
});

test('colours: a polity keeps its colour; list entries take the first free one, in order', () => {
  assert.deepEqual(polityColor('Roman Empire'), polityColor('Roman Empire'));
  assert.ok(YEAR_PALETTE.includes(polityColor('Han Dynasty')));
  const used = new Set(
    [
      'Roman Empire',
      'Han Dynasty',
      'Inca Empire',
      'Mali Empire',
      'Mughal Empire',
      'Tang Dynasty',
    ].map((n) => YEAR_PALETTE.indexOf(polityColor(n))),
  );
  assert.ok(used.size >= 3, 'names spread over the palette');
  for (const [r, g, b] of YEAR_PALETTE) {
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    assert.ok(lightness > 40 && lightness < 215, 'reads on black and on white');
  }
  assert.equal(new Set(LIST_PALETTE.map(String)).size, LIST_PALETTE.length);

  let list = [];
  for (const name of ['A', 'B', 'C']) list = addListEntry(list, name);
  assert.deepEqual(
    list.map((e) => e.color),
    [0, 1, 2],
  );
  list = removeListEntry(list, 'B');
  assert.equal(nextColorIndex(list), 1, 'a freed colour is given again');
  list = addListEntry(list, 'D');
  assert.deepEqual(
    list.map((e) => [e.name, e.color]),
    [
      ['A', 0],
      ['C', 2],
      ['D', 1],
    ],
  );
});

test('the list: add once, at most MAX_LIST_ENTRIES, shown or hidden, max or at the year', () => {
  let list = addListEntry([], '  Roman   Empire ');
  assert.deepEqual(list, [
    { name: 'Roman Empire', extent: 'max', visible: true, color: 0 },
  ]);
  assert.equal(addListEntry(list, 'Roman Empire'), list, 'once');
  assert.equal(addListEntry(list, '   '), list);
  list = updateListEntry(list, 'Roman Empire', {
    visible: false,
    extent: 'year',
  });
  assert.deepEqual(list[0], {
    name: 'Roman Empire',
    extent: 'year',
    visible: false,
    color: 0,
  });
  assert.equal(
    updateListEntry(list, 'Roman Empire', { extent: 'wide' })[0].extent,
    'year',
  );
  let full = [];
  for (let i = 0; i < MAX_LIST_ENTRIES + 3; i++)
    full = addListEntry(full, `P${i}`);
  assert.equal(full.length, MAX_LIST_ENTRIES);
});

test('the wh token round-trips: year, mode, opacity and a list with awkward names', () => {
  const names = [
    'Roman Empire',
    '(Alliance between Elam and Babylonia)',
    "Kingdom of Ma'in ~*! dots.and.more",
    'Ḥimyar — Ẓafār',
    'Ōuchi 100%',
  ];
  let list = [];
  for (const name of names) list = addListEntry(list, name);
  list = updateListEntry(list, names[1], { visible: false });
  list = updateListEntry(list, names[2], { extent: 'year' });
  const state = {
    enabled: true,
    year: -500,
    mode: 'cottereau',
    places: true,
    opacity: 0.35,
    list,
  };
  const token = encodeWorldHistoryParam(state);
  assert.match(token, /^1\.-500\.cp\.35~/);
  for (const part of token.split('~').slice(1))
    assert.doesNotMatch(part.slice(2), /[~*!.]/, 'no separator in a name');
  const back = decodeWorldHistoryParam(token);
  assert.deepEqual(back, state);
  // Through the hash as the share link writes it.
  const params = new URLSearchParams();
  params.set('wh', token);
  assert.deepEqual(
    decodeWorldHistoryParam(new URLSearchParams(params.toString()).get('wh')),
    state,
  );

  const all = {
    ...defaultWorldHistoryState(),
    enabled: false,
    year: 2025,
    mode: 'all',
  };
  assert.equal(encodeWorldHistoryParam(all), '0.2025.a.60');
  assert.deepEqual(decodeWorldHistoryParam('0.2025.a.60'), all);
  assert.equal(
    encodeWorldHistoryParam(defaultWorldHistoryState()),
    '',
    'nothing set: no param',
  );
  assert.deepEqual(decodeWorldHistoryParam(''), defaultWorldHistoryState());
  assert.deepEqual(decodeWorldHistoryParam('junk~*mA'), {
    ...defaultWorldHistoryState(),
    list: [{ name: 'A', extent: 'max', visible: true, color: 0 }],
  });
  assert.equal(
    decodeWorldHistoryParam('1.0.c.60').year,
    1,
    'year 0 read as 1 AD',
  );
  assert.equal(
    decodeWorldHistoryParam('1.-9999.c.60').year,
    WORLD_HISTORY_FIRST_YEAR,
  );
  assert.equal(DEFAULT_OPACITY, 0.6);
});
