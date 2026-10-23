// Personal fork: Cottereau's video labels against Cliopatria
// (scripts/cottereau/): stacked lines joined, the year box dropped, cuts of
// the framing found, the projection fit, labels tracked through time, and
// the matches: by name, by place and time for abbreviations, and never a
// same-name polity far away. Synthetic frames and a mini Cliopatria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  cleanFrame,
  isLabel,
  stacked,
} from '../../scripts/cottereau/labels.mjs';
import {
  afterCut,
  detectCuts,
  fitControlPoints,
  lonLatToPixel,
  millerForward,
  millerInverse,
  pixelToLonLat,
  viewChange,
} from '../../scripts/cottereau/framings.mjs';
import {
  mergeTracks,
  textSimilarity,
  trackLabels,
} from '../../scripts/cottereau/tracks.mjs';
import {
  contains,
  distanceKm,
  readFeatureLines,
  recordOf,
} from '../../scripts/cottereau/cliopatria.mjs';
import {
  abbreviates,
  matchTrack,
  nameScore,
  periodsOf,
} from '../../scripts/cottereau/match.mjs';

const box = (cx, cy, w, h, text) => ({ cx, cy, w, h, text, conf: 0.8 });

test('a frame’s labels: the year box and crumbs dropped, a two-line label joined, neighbours kept apart', () => {
  assert.equal(
    isLabel(box(1922, 1764, 372, 77, '2500 BC')),
    false,
    'the year box',
  );
  assert.equal(isLabel(box(422, 636, 21, 15, '00')), false, 'digits');
  assert.equal(
    isLabel(box(1000, 500, 60, 30, 'Se.')),
    true,
    'an abbreviation stays',
  );
  // Line pitch about 1.2 heights, centred: one label.
  assert.equal(
    stacked(
      box(1946, 1038, 108, 39, 'Indus'),
      box(1944, 1094, 122, 55, 'Valley'),
    ),
    true,
  );
  assert.equal(
    stacked(box(710, 563, 67, 30, 'West'), box(708, 598, 90, 29, 'Francia')),
    true,
  );
  // Two labels one above the other: further apart, or off centre.
  assert.equal(
    stacked(
      box(666, 751, 183, 42, 'Phoenicia'),
      box(683, 815, 98, 38, 'Israel'),
    ),
    false,
  );
  assert.equal(
    stacked(box(979, 788, 84, 40, 'Kish'), box(1002, 843, 97, 42, 'Uruk')),
    false,
  );
  const labels = cleanFrame({
    t: 1,
    year: 900,
    boxes: [
      box(870, 492, 63, 35, 'Holy'),
      box(872, 526, 89, 30, 'Roman'),
      box(872, 560, 88, 28, 'Empire'),
      box(1500, 700, 60, 30, 'Syro-'),
      box(1502, 735, 110, 30, 'Hittites'),
      box(979, 788, 84, 40, 'Kish'),
      box(1002, 843, 97, 42, 'Uruk'),
      box(1922, 1764, 372, 77, '900'),
    ],
  });
  assert.deepEqual(labels.map((l) => l.text).sort(), [
    'Holy Roman Empire',
    'Kish',
    'Syro-Hittites',
    'Uruk',
  ]);
  const holy = labels.find((l) => l.text === 'Holy Roman Empire');
  assert.equal(holy.lines, 3);
  assert.ok(Math.abs(holy.y - 526) < 2, 'centred on its lines');
});

const FRAMING = {
  id: 1,
  fromT: 0,
  sx: 1945.8,
  tx: -439.4,
  sy: 1945.8,
  ty: 1952.7,
};

test('Miller: forward and back, and pixels to places in a framing', () => {
  for (const [lon, lat] of [
    [0, 0],
    [30, 45],
    [-120, -33],
    [140, 70],
  ]) {
    const [u, v] = millerForward(lon, lat);
    const [lon2, lat2] = millerInverse(u, v);
    assert.ok(Math.abs(lon2 - lon) < 1e-9 && Math.abs(lat2 - lat) < 1e-9);
    const [x, y] = lonLatToPixel(FRAMING, lon, lat);
    const [lon3, lat3] = pixelToLonLat(FRAMING, x, y);
    assert.ok(Math.abs(lon3 - lon) < 1e-9 && Math.abs(lat3 - lat) < 1e-9);
  }
  // Crete in the first framing sits about where the video draws Minoa.
  const [x, y] = lonLatToPixel(FRAMING, 24.9, 35.2);
  assert.ok(Math.abs(x - 398) < 40 && Math.abs(y - 743) < 40, `${x}, ${y}`);
});

test('the projection fit: Miller’s own points fit Miller, not the other cylinders', () => {
  const points = [];
  for (const lon of [-10, 20, 50, 80, 110])
    for (const lat of [-10, 10, 30, 50, 65]) {
      const [x, y] = lonLatToPixel(FRAMING, lon, lat);
      points.push({ lon, lat, x, y });
    }
  const miller = fitControlPoints(points, 'miller');
  assert.ok(miller.residualKm.max < 0.01);
  assert.ok(Math.abs(miller.aspect - 1) < 1e-6);
  assert.ok(
    Math.abs(miller.sx - FRAMING.sx) < 1e-6 &&
      Math.abs(miller.ty - FRAMING.ty) < 1e-6,
  );
  const plate = fitControlPoints(points, 'equirectangular');
  const mercator = fitControlPoints(points, 'mercator');
  assert.ok(
    plate.residualKm.median > 50,
    `equirectangular ${plate.residualKm.median} km`,
  );
  assert.ok(
    mercator.residualKm.median > 20,
    `Mercator ${mercator.residualKm.median} km`,
  );
});

/** A frame of labels at a framing's pixels. */
const frameAt = (t, year, framing, places) => ({
  t,
  year,
  boxes: places.map(([text, lon, lat]) => {
    const [x, y] = lonLatToPixel(framing, lon, lat);
    return box(x, y, 20 * text.length, 40, text);
  }),
});
const PLACES = [
  ['Egypt', 31, 26.5],
  ['Babylon', 44.4, 32.5],
  ['Assyria', 43.1, 36.3],
  ['Elam', 48.3, 32.2],
  ['Hittites', 33.5, 39.5],
  ['Minoa', 24.9, 35.2],
  ['Mitanni', 40.5, 36.8],
  ['Shang', 114, 35],
];

test('a cut of the framing is found from the labels; one label moving on its own is not one', () => {
  const zoomed = {
    ...afterCut(FRAMING, { ax: 0.75, bx: 660, ay: 0.75, by: 320 }),
    id: 2,
  };
  const frames = [
    frameAt(1, -1000, FRAMING, PLACES),
    frameAt(
      2,
      -999,
      FRAMING,
      PLACES.map(([n, lon, lat]) =>
        n === 'Egypt' ? [n, lon + 3, lat] : [n, lon, lat],
      ),
    ),
    frameAt(3, -998, zoomed, PLACES),
    frameAt(4, -997, zoomed, PLACES),
  ];
  const cuts = detectCuts(frames);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].t, 3);
  assert.ok(
    Math.abs(cuts[0].change.ax - 0.75) < 1e-3 &&
      Math.abs(cuts[0].change.bx - 660) < 1,
  );
  // Carried across the cut, the old framing is the new one.
  const carried = afterCut(FRAMING, cuts[0].change);
  const [lon, lat] = pixelToLonLat(
    carried,
    ...lonLatToPixel(zoomed, 44.4, 32.5),
  );
  assert.ok(Math.abs(lon - 44.4) < 0.01 && Math.abs(lat - 32.5) < 0.01);
  assert.equal(viewChange(cleanFrame(frames[0]), cleanFrame(frames[1])), null);
});

const sample = (t, year, labels) => ({
  t,
  year,
  labels: labels.map(([text, lon, lat]) => ({
    text,
    lon,
    lat,
    size: 20,
    framing: 1,
  })),
});

test('tracking: one label through its years, an OCR slip kept as a variant, a namesake far away its own track', () => {
  const samples = [];
  for (let i = 0; i < 10; i++)
    samples.push(
      sample(i, 800 + i * 10, [
        [i === 4 ? 'Bur.s' : 'Bur.', 4.8 + i * 0.05, 47],
        ['Georgia', 43.5, 42],
        ...(i < 6 ? [['West Francia', 2, 48.5]] : []),
      ]),
    );
  // The same text 7,000 km away: not the same label.
  samples[5].labels.push({
    text: 'Georgia',
    lon: -83.5,
    lat: 32.5,
    size: 20,
    framing: 1,
  });
  const tracks = mergeTracks(trackLabels(samples));
  const bur = tracks.find((t) => t.text === 'Bur.');
  assert.equal(bur.samples, 10);
  assert.deepEqual(bur.variants, [
    { text: 'Bur.', n: 9 },
    { text: 'Bur.s', n: 1 },
  ]);
  assert.deepEqual([bur.firstYear, bur.lastYear], [800, 890]);
  const georgias = tracks.filter((t) => t.text === 'Georgia');
  assert.equal(georgias.length, 2);
  assert.equal(tracks.find((t) => t.text === 'West Francia').lastYear, 850);
  assert.ok(textSimilarity('Leon', 'León') === 1, 'accents folded');
});

/** A square polygon feature for the mini Cliopatria. */
const square = (name, from, to, lon, lat, half, extra = {}) => ({
  type: 'Feature',
  properties: {
    Name: name,
    FromYear: from,
    ToYear: to,
    Area: (half * 2 * 111) ** 2,
    Type: 'POLITY',
    Wikipedia: extra.wikipedia || name,
    Wikidata: extra.wikidata || '',
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [lon - half, lat - half],
        [lon + half, lat - half],
        [lon + half, lat + half],
        [lon - half, lat + half],
        [lon - half, lat - half],
      ],
    ],
  },
});

async function miniCliopatria() {
  const features = [
    square('Kingdom of Georgia', 1008, 1490, 43.5, 42, 2, { wikidata: 'Q1' }),
    square('Georgia', 1732, 1776, -83.5, 32.5, 3, {
      wikipedia: 'Province of Georgia',
    }),
    square('Seljuk Empire', 1037, 1194, 52, 35, 8, { wikidata: 'Q2' }),
    square('Abbasid Caliphate', 750, 1258, 44, 33, 6),
    square('Rus Khaganate', 830, 1240, 31, 51, 6, {
      wikipedia: "Kievan Rus'",
      wikidata: 'Q3',
    }),
    square('Kingdom of England', 927, 1707, -1.5, 52.5, 2.5),
    square('Duchy of Burgundy', 1032, 1477, 4.8, 47, 1),
  ];
  const text = [
    '{',
    '"type": "FeatureCollection",',
    '"features": [',
    ...features.map(
      (f, i) => `${JSON.stringify(f)}${i + 1 < features.length ? ',' : ''}`,
    ),
    ']',
    '}',
  ].join('\n');
  return readFeatureLines(Readable.from([text]));
}

const track = (text, firstYear, lastYear, lon, lat, extra = {}) => ({
  id: 0,
  text,
  variants: [{ text, n: 10 }],
  firstYear,
  lastYear,
  lon,
  lat,
  size: 20,
  samples: 10,
  ...extra,
});

test('the mini Cliopatria reads a feature a line; points inside, near and far', async () => {
  const records = await miniCliopatria();
  assert.equal(records.length, 7);
  const georgia = records.find((r) => r.name === 'Kingdom of Georgia');
  assert.equal(contains(georgia, 43.5, 42), true);
  assert.equal(distanceKm(georgia, 43.5, 42), 0);
  const km = distanceKm(georgia, 47.5, 42);
  assert.ok(km > 150 && km < 180, `${km} km`);
  const holey = recordOf({
    type: 'Feature',
    properties: { Name: 'Ring', FromYear: 0, ToYear: 1 },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    },
  });
  assert.equal(contains(holey, 5, 5), false, 'in its hole');
  assert.equal(contains(holey, 2, 2), true);
});

test('matching: by name in place, by place and time for an abbreviation or another name, never a namesake far away', async () => {
  const records = await miniCliopatria();
  // Name and place: "Georgia" in the Caucasus is the Kingdom, not the colony.
  const georgia = matchTrack(track('Georgia', 1100, 1400, 43.6, 42.1), records);
  assert.equal(georgia.name, 'Kingdom of Georgia');
  assert.equal(georgia.reason, 'name+place');
  assert.equal(georgia.confidence, 'high');
  assert.equal(georgia.wikidata, 'Q1');
  // Abbreviations by place and time.
  assert.equal(abbreviates('Se.', 'Seljuk Empire'), true);
  assert.equal(abbreviates('Eng.', 'Kingdom of England'), true);
  assert.equal(abbreviates('Rus', 'Russia'), false, 'a whole word is the word');
  const seljuk = matchTrack(track('Se.', 1100, 1150, 52, 35.5), records);
  assert.equal(seljuk.name, 'Seljuk Empire');
  assert.equal(seljuk.reason, 'abbreviation+place');
  const england = matchTrack(track('Eng.', 1100, 1200, -1.2, 52.2), records);
  assert.equal(england.name, 'Kingdom of England');
  const burgundy = matchTrack(
    track('Bur.', 1100, 1200, 4.8, 47.1, {
      variants: [
        { text: 'Bur.', n: 9 },
        { text: 'Bur.s', n: 1 },
      ],
    }),
    records,
  );
  assert.equal(burgundy.name, 'Duchy of Burgundy');
  // Another name for it: Cottereau's "Kievan Rus'" is Cliopatria's Rus Khaganate (its Wikipedia title).
  assert.ok(nameScore("Kievan Rus'", ['Rus Khaganate', "Kievan Rus'"]) === 1);
  const rus = matchTrack(track("Kievan Rus'", 900, 1200, 30.5, 50.5), records);
  assert.equal(rus.name, 'Rus Khaganate');
  // A namesake far away is refused, even with the name exact.
  const colony = matchTrack(track('Georgia', 1740, 1770, 43.6, 42.1), records);
  assert.equal(colony.name, null);
  assert.deepEqual(
    colony.refused.map((r) => r.name),
    ['Georgia'],
  );
  assert.ok(colony.refused[0].distanceKm > 9000);
});

test('periods: a label named once goes on while Cliopatria renames what is under it; the plain polity before its bracketed twin', async () => {
  const features = [
    square('Kingdom of France', 987, 1791, 2.5, 46.5, 4),
    square('(Kingdom of France)', 987, 1791, 2.5, 46.5, 4),
    square('French First Republic', 1792, 1804, 2.5, 46.5, 4),
    square('First French Empire', 1805, 1814, 2.5, 46.5, 5),
  ];
  const text = [
    '{',
    '"features": [',
    ...features.map(
      (f, i) => `${JSON.stringify(f)}${i + 1 < features.length ? ',' : ''}`,
    ),
    ']',
    '}',
  ].join('\n');
  const records = await readFeatureLines(Readable.from([text]));
  const points = [1700, 1780, 1795, 1800, 1810].map((year) => ({
    year,
    lon: 2.5,
    lat: 46.6,
  }));
  const france = track('France', 1700, 1810, 2.5, 46.6, { points });
  const main = matchTrack(france, records);
  assert.equal(
    main.name,
    'Kingdom of France',
    'the plain polity, not its bracketed twin',
  );
  assert.equal(main.reason, 'name+place');
  assert.deepEqual(
    periodsOf(france, records, main).map((p) => [
      p.name,
      p.from,
      p.to,
      p.reason,
    ]),
    [
      ['Kingdom of France', 1700, 1780, 'name'],
      ['French First Republic', 1795, 1800, 'continued'],
      ['First French Empire', 1810, 1810, 'continued'],
    ],
  );
});
