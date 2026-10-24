import fs from 'node:fs';
import path from 'node:path';

/**
 * A mini Cliopatria (GeoJSON a feature a line, as the release has it) and
 * a mini Cottereau match, for the World history tests:
 *
 * - Alpha Kingdom: 600–301 BC (small), 300 BC–"year 0" (largest), 1–200 AD;
 * - Beta Empire: 100–500 AD, a square with a hole;
 * - (Alliance of Alpha and Beta): a RELATION, 100–150 AD;
 * - Gamma Republic: 1990–2024.
 *
 * Cottereau: "Alpha" (high, by name) 500–10 BC, then nothing to 50 AD;
 * "Beta" (medium, by name) 120–480 AD; "Ebla" (low, place only, inside
 * Beta) 200–300 AD; "Gamma" (high) 1990–2025.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */
const square = (x, y, s) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

const feature = (properties, coordinates, type = 'Polygon') => ({
  type: 'Feature',
  properties: {
    Wikipedia: '',
    Wikidata: '',
    SeshatID: '',
    Components: '',
    MemberOf: '',
    Type: 'POLITY',
    ...properties,
  },
  geometry: { type, coordinates },
});

export const FIXTURE_FEATURES = [
  feature({ Name: 'Alpha Kingdom', FromYear: -600, ToYear: -301, Area: 1000 }, [
    square(10, 40, 1),
  ]),
  feature(
    {
      Name: 'Alpha Kingdom',
      FromYear: -300,
      ToYear: 0,
      Area: 5000,
      Wikipedia: 'Alpha Kingdom',
    },
    [[square(10, 40, 3)], [square(20, 40, 0.5)]],
    'MultiPolygon',
  ),
  feature({ Name: 'Alpha Kingdom', FromYear: 1, ToYear: 200, Area: 3000 }, [
    square(10, 40, 2),
  ]),
  feature(
    {
      Name: 'Beta Empire',
      FromYear: 100,
      ToYear: 500,
      Area: 9000,
      Wikipedia: 'Beta Empire',
      Wikidata: 'Q1',
    },
    [square(30, 30, 5), square(31, 31, 1)],
  ),
  feature(
    {
      Name: '(Alliance of Alpha and Beta)',
      FromYear: 100,
      ToYear: 150,
      Area: 12000,
      Type: 'RELATION',
    },
    [square(10, 30, 25)],
  ),
  feature({ Name: 'Gamma Republic', FromYear: 1990, ToYear: 2024, Area: 700 }, [
    square(-60, -20, 2),
  ]),
];

export const FIXTURE_MATCHES = {
  source: 'fixture',
  matches: [
    {
      track: 0,
      text: 'Alpha',
      years: [-500, 50],
      name: 'Alpha Kingdom',
      confidence: 'high',
      reason: 'name+place',
      periods: [
        { name: 'Alpha Kingdom', from: -500, to: -12, reason: 'name' },
        { name: null, from: -5, to: 50, reason: 'none' },
      ],
    },
    {
      track: 1,
      text: 'Beta',
      years: [120, 480],
      name: 'Beta Empire',
      confidence: 'medium',
      reason: 'abbreviation+place',
      periods: [
        { name: 'Beta Empire', from: 120, to: 470, reason: 'abbreviation' },
      ],
    },
    {
      track: 2,
      text: 'Ebla',
      years: [200, 300],
      name: 'Beta Empire',
      confidence: 'low',
      reason: 'place+time+size',
      periods: [
        { name: 'Beta Empire', from: 200, to: 300, reason: 'main match' },
      ],
    },
    {
      track: 3,
      text: 'Gamma',
      years: [1990, 2025],
      name: 'Gamma Republic',
      confidence: 'high',
      reason: 'name+place',
      periods: [
        { name: 'Gamma Republic', from: 1990, to: 2025, reason: 'name' },
      ],
    },
    {
      track: 4,
      text: 'Xia',
      years: [-2062, -1601],
      name: null,
      reason: 'no polity alive near it',
      periods: [],
    },
  ],
};

export const FIXTURE_TRACKS = {
  tracks: [
    { id: 0, text: 'Alpha', lon: 11.2, lat: 41.1 },
    { id: 1, text: 'Beta', lon: 32.5, lat: 33.5 },
    { id: 2, text: 'Ebla', lon: 33, lat: 34 },
    { id: 3, text: 'Gamma', lon: -59, lat: -19 },
  ],
};

/** Write the fixture into `dir`: {cliopatria, matches, tracks} paths. */
export function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cliopatria = path.join(dir, 'cliopatria.geojson');
  fs.writeFileSync(
    cliopatria,
    `{"type": "FeatureCollection", "features": [\n${FIXTURE_FEATURES.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`,
  );
  const matches = path.join(dir, 'matches.json');
  fs.writeFileSync(matches, JSON.stringify(FIXTURE_MATCHES));
  const tracks = path.join(dir, 'tracks.json');
  fs.writeFileSync(tracks, JSON.stringify(FIXTURE_TRACKS));
  return { cliopatria, matches, tracks };
}
