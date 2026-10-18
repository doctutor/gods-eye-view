// Personal fork: the Grid layer's MGRS mode (UTM arithmetic, lettering, lines, labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MGRS_LABELS,
  MAX_MGRS_LINES,
  lineDigits,
  mgrsLabelPlacements,
  mgrsLevelChanged,
  mgrsLevelForHeight,
  mgrsLines,
  viewReference,
  zoneBoundaries,
} from './mgrs.js';
import { MAX_LINES_PER_AXIS, gridWindow } from './model.js';
import {
  bandLetter,
  centralMeridian,
  fromUtm,
  squareLetters,
  toMgrs,
  toUtm,
  zoneOf,
} from './utm.js';
import { mgrsSpacingText } from './presentation.js';

const groundMetres = (a, b) =>
  Math.hypot(
    (a.lat - b.lat) * 111_320,
    (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180),
  );

test('UTM is exact on the central meridian and round-trips to the nanometre', () => {
  const origin = toUtm(0, 3, 31);
  assert.ok(Math.abs(origin.easting - 500_000) < 1e-6);
  assert.ok(Math.abs(origin.northing) < 1e-6);
  // Veness's published example: the Eiffel Tower.
  const eiffel = toUtm(
    48 + 51 / 60 + 29.5 / 3600,
    2 + 17 / 60 + 40.2 / 3600,
    31,
  );
  assert.equal(Math.floor(eiffel.easting), 448_251);
  assert.equal(Math.floor(eiffel.northing), 5_411_932);
  let worst = 0;
  for (let i = 0; i < 2000; i += 1) {
    const lat = -80 + ((i * 37) % 164) + (i % 7) / 10;
    const zone = 1 + (i % 60);
    const lon = centralMeridian(zone) - 3 + ((i * 13) % 60) / 10;
    const grid = toUtm(lat, lon, zone);
    worst = Math.max(
      worst,
      groundMetres({ lat, lon }, fromUtm(grid.easting, grid.northing, zone)),
    );
  }
  assert.ok(worst < 1e-6, `round trip within a micrometre (${worst} m)`);
});

test('references letter zones, bands and 100 km squares as MGRS does', () => {
  assert.equal(
    toMgrs(48 + 51 / 60 + 29.5 / 3600, 2 + 17 / 60 + 40.2 / 3600),
    '31U DQ 48251 11932',
  );
  assert.equal(toMgrs(0, 3), '31N EA 00000 00000');
  assert.equal(toMgrs(38.8895, -77.0353, 100_000), '18S UJ');
  assert.equal(toMgrs(38.8895, -77.0353, 1_000), '18S UJ 23 06');
  // Norway and Svalbard.
  assert.equal(zoneOf(60, 5), 32);
  assert.equal(zoneOf(60, 2.9), 31);
  assert.equal(zoneOf(78, 8.9), 31);
  assert.equal(zoneOf(78, 15.6), 33);
  assert.equal(zoneOf(78, 40), 37);
  assert.equal(bandLetter(84), 'X');
  assert.equal(bandLetter(-80), 'C');
  assert.equal(toMgrs(84.1, 0), null, 'UPS beyond 84°N');
  assert.equal(toMgrs(-80.1, 0), null, 'UPS beyond 80°S');
  // Row letters run on across the equator: just south is the letter before.
  const rows = 'ABCDEFGHJKLMNPQRSTUV';
  for (const zone of [31, 32]) {
    const north = squareLetters(zone, 500_000, 1)[1];
    const south = squareLetters(zone, 500_000, -1)[1];
    assert.equal(
      (rows.indexOf(south) + 1) % 20,
      rows.indexOf(north),
      `zone ${zone}`,
    );
  }
});

test('the level keeps 4 to 12 lines across the view, from zones to kilometres', () => {
  assert.equal(mgrsLevelForHeight(20e6).id, 'gzd');
  assert.equal(mgrsLevelForHeight(2e6).id, 'gzd');
  assert.equal(mgrsLevelForHeight(400e3).id, '100km');
  assert.equal(mgrsLevelForHeight(40e3).id, '10km');
  assert.equal(mgrsLevelForHeight(4e3).id, '1km');
  assert.equal(mgrsLevelForHeight(500).id, '1km');
  assert.equal(mgrsSpacingText(mgrsLevelForHeight(4e3)), 'Lines every 1 km');
  assert.equal(
    mgrsSpacingText(mgrsLevelForHeight(20e6)),
    'Grid zones, 6° by 8°',
  );
  assert.ok(mgrsLevelChanged(null, { heightM: 1 }));
  assert.ok(!mgrsLevelChanged({ heightM: 40e3 }, { heightM: 50e3 }));
  assert.ok(mgrsLevelChanged({ heightM: 40e3 }, { heightM: 4e3 }));
});

test('UTM lines are whole multiples, bounded, and cut at the zone edge', () => {
  const view = { lat: 38.9, lon: -78, heightM: 40_000 };
  const set = mgrsLines(view);
  assert.equal(set.level.stepM, 10_000);
  assert.ok(set.lines.length > 0 && set.lines.length <= MAX_MGRS_LINES);
  const zones = new Set(set.lines.map((line) => line.zone));
  assert.deepEqual([...zones].sort(), [17, 18], 'both zones at their edge');
  for (const line of set.lines) {
    assert.equal(line.value % 10_000, 0);
    const perZone = set.lines.filter(
      (other) => other.zone === line.zone && other.axis === line.axis,
    );
    assert.ok(new Set(perZone.map((l) => l.value)).size <= MAX_LINES_PER_AXIS);
    for (const point of line.points) {
      // 78°W is the 17/18 boundary: neither zone's lines cross it.
      if (line.zone === 17) assert.ok(point.lon <= -78 + 1e-7);
      else assert.ok(point.lon >= -78 - 1e-7);
      // Each point lies on its line in its zone's grid.
      const grid = toUtm(point.lat, point.lon, line.zone);
      const along = line.axis === 'e' ? grid.easting : grid.northing;
      assert.ok(Math.abs(along - line.value) < 1e-3);
    }
  }
  // The pieces end on the edge, not a sample short of it.
  const edges = set.lines
    .filter((line) => line.zone === 18 && line.axis === 'n')
    .map((line) => line.points[0].lon);
  assert.ok(edges.some((lon) => Math.abs(lon + 78) < 1e-6));
});

test('across the antimeridian, at Norway and near the poles the set stays whole', () => {
  const fiji = mgrsLines({ lat: -17, lon: 179.9, heightM: 400_000 });
  const zones = new Set(fiji.lines.map((line) => line.zone));
  assert.ok(zones.has(60) && zones.has(1));
  for (const line of fiji.lines.filter((l) => l.zone === 1))
    for (const point of line.points)
      assert.ok(point.lon >= 180 - 1e-7, 'zone 1 continues east of 180°');
  const fijiLabels = mgrsLabelPlacements(fiji, {
    lat: -17,
    lon: 179.9,
    heightM: 400_000,
  });
  assert.ok(fijiLabels.some((label) => label.text.startsWith('60K')));
  assert.ok(fijiLabels.some((label) => label.text.startsWith('1K')));
  // 32V starts at 3°E, so 31V's lines stop there.
  const norway = mgrsLines({ lat: 60, lon: 4, heightM: 400_000 });
  for (const line of norway.lines.filter((l) => l.zone === 31))
    for (const point of line.points)
      if (point.lat > 56 + 1e-7 && point.lat < 64 - 1e-7)
        assert.ok(point.lon <= 3 + 1e-7);
  assert.ok(
    zoneBoundaries(gridWindow({ lat: 60, lon: 4, heightM: 400_000 })).some(
      (b) => b.axis === 'meridian' && b.points[0].lon === 3,
    ),
  );
  // Past 84°N there is no MGRS, and the view has no reference.
  const north = mgrsLines({ lat: 85, lon: 0, heightM: 40_000 });
  for (const line of north.lines)
    for (const point of line.points) assert.ok(point.lat <= 84 + 1e-7);
  assert.equal(viewReference({ lat: 85, lon: 0, heightM: 40_000 }), null);
  assert.deepEqual(
    mgrsLines({ lat: 85, lon: 0, heightM: 4_000 }).lines,
    [],
    'a 1 km view at 85°N is wholly polar',
  );
});

test('labels name zones, squares and lines in MGRS notation', () => {
  const globe = { lat: 30, lon: -77, heightM: 20e6 };
  const zones = mgrsLabelPlacements(mgrsLines(globe), globe);
  assert.ok(zones.length > 0 && zones.length <= MAX_MGRS_LABELS);
  assert.ok(zones.every((label) => /^\d{1,2}[C-X]$/.test(label.text)));
  assert.ok(zones.some((label) => label.text === '18R'));
  const region = { lat: 38.9, lon: -77, heightM: 400_000 };
  const squares = mgrsLabelPlacements(mgrsLines(region), region);
  assert.ok(squares.some((label) => label.text === '18S UJ'));
  assert.ok(
    squares.every((label) => /^\d{1,2}[C-X] [A-Z]{2}$/.test(label.text)),
  );
  const city = { lat: 38.8895, lon: -77.0353, heightM: 4_000 };
  const lines = mgrsLabelPlacements(mgrsLines(city), city);
  assert.ok(lines.some((label) => label.axis === 'e' && label.text === '23'));
  assert.ok(lines.some((label) => label.axis === 'n' && label.text === '06'));
  assert.ok(lines.some((label) => label.text === '18S UJ'));
  assert.equal(viewReference(city), '18S UJ 23 06');
  assert.equal(viewReference(globe), '18R');
  assert.equal(lineDigits(-1_000), '99', 'south of the equator');
  assert.equal(lineDigits(4_306_479), '06');
});
