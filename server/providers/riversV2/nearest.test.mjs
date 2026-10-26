// Personal fork: the HydroSHEDS v2 line nearest a click
// (server/providers/riversV2/nearest.js), on pieces read from the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePiece } from './levelFile.js';
import {
  MAX_CELLS,
  bandForOrder,
  nearestV2Line,
  sharedPoints,
} from './nearest.js';
import { cellKey } from './tileMath.js';

// The z11 level's layout (2^24 units a side, cells of zoom 11).
const QUANT_BITS = 24;
const GRID_ZOOM = 11;
const CELL_UNITS = 2 ** (QUANT_BITS - GRID_ZOOM);
// Stony Run's cell, Baltimore.
const CX = 588;
const CY = 780;

// From the build of 2026-10-19 (D:/gev-cache/rivers/v2, level-z11.bin):
// Stony Run as v2 draws it, order 8, running south from Roland Park to the
// Jones Falls; the order-6 reach that meets it there; and a reach crossing
// the cell's east edge, with its run in the next cell (the two share the
// segments within the level's margin of the edge).
const STONY_RUN = [
  4817618, 6391556, 4817579, 6391590, 4817579, 6391640, 4817566, 6391657,
  4817618, 6391741, 4817631, 6391724, 4817669, 6391757, 4817695, 6391874,
  4817669, 6391891, 4817644, 6391958, 4817618, 6391958, 4817579, 6392025,
  4817605, 6392059, 4817605, 6392126, 4817631, 6392159, 4817644, 6392159,
  4817644, 6392243, 4817592, 6392310, 4817566, 6392377, 4817579, 6392393,
  4817579, 6392510, 4817527, 6392594, 4817540, 6392661, 4817488, 6392711,
];
const JONES_FALLS = [
  4816802, 6391925, 4816854, 6392008, 4816828, 6392042, 4816841, 6392059,
  4816828, 6392126, 4816854, 6392192, 4816880, 6392192, 4816893, 6392176,
  4816996, 6392276, 4817126, 6392276, 4817139, 6392293, 4817178, 6392293,
  4817216, 6392360, 4817268, 6392377, 4817320, 6392427, 4817320, 6392443,
  4817359, 6392494, 4817359, 6392527, 4817346, 6392544, 4817359, 6392577,
  4817385, 6392611, 4817411, 6392611, 4817436, 6392661, 4817449, 6392661,
  4817462, 6392694, 4817488, 6392711,
];
const EDGE_WEST = [
  4825204, 6397595, 4825152, 6397661, 4825139, 6397661, 4825087, 6397595,
  4825035, 6397578, 4824997, 6397528, 4824932, 6397528, 4824919, 6397511,
  4824893, 6397511, 4824802, 6397611, 4824815, 6397678, 4824789, 6397762,
  4824764, 6397778, 4824738, 6397762, 4824686, 6397778, 4824673, 6397762,
  4824621, 6397795, 4824608, 6397778, 4824582, 6397778, 4824543, 6397829,
  4824518, 6397795, 4824440, 6397829, 4824401, 6397929, 4824401, 6398029,
  4824388, 6398046, 4824362, 6398046, 4824336, 6398079,
];
const EDGE_EAST = [
  4825327, 6397536, 4825281, 6397611, 4825217, 6397611, 4825204, 6397595,
  4825152, 6397661, 4825139, 6397661, 4825087, 6397595, 4825035, 6397578,
  4824997, 6397528, 4824932, 6397528,
];

/** A level of cells {"cx,cy": [{order, coords}]}, as openLevel gives one. */
function fakeLevel(cells) {
  const keys = [];
  const bytes = [];
  const reads = [];
  for (const [at, pieces] of Object.entries(cells)) {
    const [cx, cy] = at.split(',').map(Number);
    keys.push(cellKey(cx, cy, GRID_ZOOM));
    bytes.push(
      Buffer.concat(
        pieces.map(({ order, coords }) =>
          encodePiece(order, coords, cx * CELL_UNITS, cy * CELL_UNITS),
        ),
      ),
    );
  }
  const level = {
    header: { quantBits: QUANT_BITS, gridZoom: GRID_ZOOM },
    find: (key) => keys.indexOf(key),
    readCell(i) {
      reads.push(i);
      return bytes[i];
    },
    reads,
  };
  return new Map([['z11', level]]);
}

const CLICK = { lat: 39.3268, lon: -76.6268 };

test('Stony Run: the click finds the line v2 draws, 132 m off, running north to south', () => {
  const levels = fakeLevel({
    [`${CX},${CY}`]: [
      { order: 6, coords: JONES_FALLS },
      { order: 8, coords: STONY_RUN },
    ],
  });
  const line = nearestV2Line(levels, {
    ...CLICK,
    toleranceM: 400,
    maxOrder: 10,
  });
  assert.equal(line.order, 8);
  assert.equal(line.distanceM, 132);
  assert.equal(line.level, 'z11');
  assert.equal(line.cells, 1);
  const points = line.geometry.coordinates;
  assert.equal(points.length, 24);
  assert.deepEqual(points[0], [-76.62513, 39.33848]);
  assert.deepEqual(points.at(-1), [-76.62792, 39.31931]);
  // North to south, not HydroRIVERS v1's diagonal 245 m off.
  assert.ok(Math.abs(points[0][0] - points.at(-1)[0]) < 0.005);
  assert.ok(points[0][1] - points.at(-1)[1] > 0.015);
  // Within 100 m, nothing; the Jones Falls reach, 510 m off, only when the
  // click may pick no order smaller than 6.
  assert.equal(
    nearestV2Line(levels, { ...CLICK, toleranceM: 100, maxOrder: 10 }),
    null,
  );
  // A click from higher up, which may pick only larger rivers, reads the
  // coarser level that holds them (absent here).
  assert.equal(
    nearestV2Line(levels, { ...CLICK, toleranceM: 600, maxOrder: 7 }),
    null,
  );
  assert.equal(bandForOrder(10).level, 'z11');
  assert.equal(bandForOrder(7).level, 'z9');
  assert.equal(bandForOrder(3).level, 'z0');
  // The two meet at the confluence but are never joined: one point shared.
  assert.equal(sharedPoints(STONY_RUN, JONES_FALLS), 0);
});

test('a reach crossing a cell edge is put back together from both cells', () => {
  const levels = fakeLevel({
    [`${CX},${CY}`]: [
      { order: 8, coords: STONY_RUN },
      { order: 8, coords: EDGE_WEST },
    ],
    [`${CX + 1},${CY}`]: [{ order: 8, coords: EDGE_EAST }],
  });
  const east = (CX + 1) * CELL_UNITS;
  // A click on the west run's vertex nearest the edge, inside the cell.
  let k = -1;
  for (let i = 0; i < EDGE_WEST.length; i += 2)
    if (EDGE_WEST[i] < east && (k < 0 || EDGE_WEST[i] > EDGE_WEST[k])) k = i;
  const x = EDGE_WEST[k];
  const y = EDGE_WEST[k + 1];
  const lon = (x / 2 ** QUANT_BITS) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** QUANT_BITS))) * 180) /
    Math.PI;
  const line = nearestV2Line(levels, {
    lat,
    lon,
    toleranceM: 50,
    maxOrder: 10,
  });
  assert.equal(line.order, 8);
  assert.equal(line.distanceM, 0);
  // Both cells, and the one the joined line's far end lies in (empty).
  assert.equal(line.cells, 3);
  // It flows west: the east run ends with the 7 points the west run
  // begins with.
  assert.equal(sharedPoints(EDGE_WEST, EDGE_EAST), 0);
  const overlap = sharedPoints(EDGE_EAST, EDGE_WEST);
  assert.equal(overlap, 7);
  assert.equal(
    line.geometry.coordinates.length,
    (EDGE_WEST.length + EDGE_EAST.length) / 2 - overlap,
  );
  // No point twice in a row where the runs were joined.
  const points = line.geometry.coordinates;
  for (let i = 1; i < points.length; i++)
    assert.notDeepEqual(points[i], points[i - 1]);
});

test('a click reads at most a few cells, however wide its tolerance', () => {
  const cells = {};
  for (let dx = -3; dx <= 3; dx++)
    for (let dy = -3; dy <= 3; dy++) cells[`${CX + dx},${CY + dy}`] = [];
  cells[`${CX},${CY}`] = [{ order: 8, coords: STONY_RUN }];
  const levels = fakeLevel(cells);
  nearestV2Line(levels, { ...CLICK, toleranceM: 50_000, maxOrder: 10 });
  assert.ok(levels.get('z11').reads.length <= MAX_CELLS);
});
