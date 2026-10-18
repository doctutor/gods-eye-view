// Personal fork: the shared H3 resolution table and the cells a hex surface
// draws for a view, including windows across the antimeridian and over a
// pole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellToLatLng, getResolution, isValidCell } from 'h3-js';
import {
  H3_HEX_ACROSS_KM,
  H3_MAX_RESOLUTION,
  H3_RESOLUTION_TABLE,
  clampH3Resolution,
  h3ResolutionForHeight,
  hexPixelsAcross,
} from './h3Resolution.js';
import {
  DEFAULT_MAX_CELLS,
  GLOBAL_MAX_RESOLUTION,
  allCells,
  cellCentre,
  cellRing,
  cellsForView,
  diskRadius,
  diskRadiusWithin,
  viewMoved,
  viewWindow,
} from './h3Cells.js';

test('the resolution table runs 0 at orbit to 7 at city scale, one band per resolution, hexes 20–60 px across', () => {
  assert.deepEqual(
    H3_RESOLUTION_TABLE.map((row) => row.res),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  for (let i = 1; i < H3_RESOLUTION_TABLE.length; i++)
    assert.ok(
      H3_RESOLUTION_TABLE[i].minHeightM < H3_RESOLUTION_TABLE[i - 1].minHeightM,
      'bands descend',
    );
  assert.equal(H3_RESOLUTION_TABLE.at(-1).minHeightM, 0);
  assert.equal(H3_MAX_RESOLUTION, 7);
  assert.equal(h3ResolutionForHeight(2.2e7), 0, 'orbit');
  assert.equal(h3ResolutionForHeight(Infinity), 0);
  assert.equal(h3ResolutionForHeight(NaN), 0);
  assert.equal(h3ResolutionForHeight(1.5e7), 1);
  assert.equal(h3ResolutionForHeight(8e6), 2);
  assert.equal(h3ResolutionForHeight(3e6), 3);
  assert.equal(h3ResolutionForHeight(1e6), 4);
  assert.equal(h3ResolutionForHeight(4e5), 5);
  assert.equal(h3ResolutionForHeight(1.5e5), 6);
  assert.equal(h3ResolutionForHeight(3e4), 7, 'city scale');
  assert.equal(h3ResolutionForHeight(0), 7);
  // Inside every band below orbit the hexes stay about 20 to 60 px across
  // (resolution 1's band reaches up to the orbit exception, so it starts
  // a little wider).
  for (const [i, row] of H3_RESOLUTION_TABLE.entries()) {
    if (row.res === 0) continue;
    const top = H3_RESOLUTION_TABLE[i - 1].minHeightM - 1;
    const bottom = Math.max(row.minHeightM, 20_000);
    assert.ok(
      hexPixelsAcross(row.res, top) >= 19 &&
        hexPixelsAcross(row.res, top) <= 35,
      `res ${row.res} at ${top} m: ${hexPixelsAcross(row.res, top).toFixed(0)} px`,
    );
    // Resolution 7 is the finest: below its band's start it only grows.
    if (row.res < H3_MAX_RESOLUTION)
      assert.ok(
        hexPixelsAcross(row.res, bottom) <= 65,
        `res ${row.res} at ${bottom} m: ${hexPixelsAcross(row.res, bottom).toFixed(0)} px`,
      );
  }
  assert.ok(hexPixelsAcross(0, 2e7) > 60, 'orbit shows the 122 big cells');
  assert.equal(H3_HEX_ACROSS_KM.length, 8);
  assert.equal(clampH3Resolution(9), 7);
  assert.equal(clampH3Resolution(-1), 0);
  assert.equal(clampH3Resolution('x'), 0);
});

test('the view window: the Earth Engine rule, wrapping at the antimeridian, every longitude round a pole, the planet far out', () => {
  assert.equal(viewWindow(40, 0, 2e6), null, 'past 5,000 km: the planet');
  const near = viewWindow(64, -20, 1e5);
  assert.ok(
    near.west < -20 && near.east > -20 && near.south < 64 && near.north > 64,
  );
  assert.ok(near.east - near.west < 15);
  const crossing = viewWindow(60, 179, 8e5);
  assert.ok(crossing.west > 0 && crossing.east < 0, 'west > east across ±180');
  const polar = viewWindow(88, 30, 3e5);
  assert.deepEqual([polar.west, polar.east, polar.north], [-180, 180, 85]);
  const south = viewWindow(-84, 30, 5e5);
  assert.deepEqual([south.west, south.east, south.south], [-180, 180, -85]);
  // The rebuild rule: half way to the edge, or the height doubled/halved.
  const made = { lat: 50, lon: 10, heightM: 1e6 };
  assert.equal(viewMoved(made, { lat: 50.5, lon: 10.5, heightM: 1e6 }), false);
  assert.equal(viewMoved(made, { lat: 50, lon: 40, heightM: 1e6 }), true);
  assert.equal(viewMoved(made, { lat: 50, lon: 10, heightM: 2.1e6 }), true);
  assert.equal(viewMoved(made, { lat: 50, lon: 10, heightM: 4e5 }), true);
  assert.equal(viewMoved(null, made), true);
  assert.equal(
    viewMoved(
      { lat: 60, lon: 179.5, heightM: 1e6 },
      { lat: 60, lon: -179.5, heightM: 1e6 },
    ),
    false,
    'a step across the antimeridian is a small move',
  );
});

test('cells for a view: every cell of the resolution from orbit, a disk around the view nearer, polar and antimeridian views included', () => {
  const orbit = cellsForView({ lat: 0, lon: 0, heightM: 2.2e7 }, 0);
  assert.equal(orbit.scope, 'global');
  assert.equal(orbit.cells.length, 122);
  assert.equal(allCells(2).length, 5882);
  assert.equal(GLOBAL_MAX_RESOLUTION, 2);
  assert.ok(allCells(1).every((cell) => getResolution(cell) === 1));

  const europe = cellsForView({ lat: 50, lon: 10, heightM: 3e6 }, 3);
  assert.equal(europe.scope, 'window');
  assert.equal(europe.res, 3);
  assert.ok(europe.k >= 30 && europe.k <= 60, `k ${europe.k}`);
  assert.ok(europe.cells.length < DEFAULT_MAX_CELLS);
  assert.ok(
    europe.cells.every(
      (cell) => isValidCell(cell) && getResolution(cell) === 3,
    ),
  );
  const centre = europe.cells.find((cell) => {
    const [lat, lon] = cellToLatLng(cell);
    return Math.abs(lat - 50) < 1 && Math.abs(lon - 10) < 1.5;
  });
  assert.ok(centre, 'the cell under the view is in the disk');
  assert.equal(
    new Set(europe.cells).size,
    europe.cells.length,
    'no duplicates',
  );
  // A disk of radius k holds 3k² + 3k + 1 cells, a few fewer near a pentagon.
  const full = 3 * europe.k * europe.k + 3 * europe.k + 1;
  assert.ok(europe.cells.length <= full && europe.cells.length > 0.9 * full);

  // A window that would need more than the budget is capped at the budget.
  assert.equal(diskRadiusWithin(DEFAULT_MAX_CELLS), 81);
  assert.equal(diskRadiusWithin(7), 1);
  const dense = cellsForView({ lat: 50, lon: 10, heightM: 1.6e6 }, 6, {
    maxCells: 1000,
  });
  assert.ok(dense.cells.length <= 1000, `${dense.cells.length} cells`);
  assert.equal(dense.k, diskRadiusWithin(1000));
  assert.ok(diskRadius(3, 5e6) > diskRadius(2, 5e6));

  // Across the antimeridian and over the pole, cells still come and their
  // rings stay continuous.
  const dateline = cellsForView({ lat: 60, lon: 179.8, heightM: 8e5 }, 4);
  assert.ok(dateline.cells.length > 100);
  const sides = new Set(
    dateline.cells.map((cell) => Math.sign(cellToLatLng(cell)[1])),
  );
  assert.deepEqual([...sides].sort(), [-1, 1], 'cells on both sides of ±180');
  for (const cell of dateline.cells) {
    const ring = cellRing(cell);
    assert.ok(ring.length >= 5);
    const lons = ring.map(([lon]) => lon);
    assert.ok(
      Math.max(...lons) - Math.min(...lons) < 10,
      `${cell} ring is continuous`,
    );
  }
  const pole = cellsForView({ lat: 89.5, lon: 0, heightM: 3e5 }, 5);
  assert.ok(pole.cells.length > 50);
  assert.ok(
    pole.cells.some((cell) => cellToLatLng(cell)[0] > 89.8),
    'a cell at the pole',
  );
  for (const cell of pole.cells.slice(0, 200)) {
    const ring = cellRing(cell);
    const lons = ring.map(([lon]) => lon);
    // The one cell holding the pole legitimately spans every longitude.
    const holdsPole = ring.some(([, lat]) => lat > 89.8);
    assert.ok(
      holdsPole || Math.max(...lons) - Math.min(...lons) < 181,
      `${cell} polar ring`,
    );
  }
  // A ring is open (no repeated closing vertex) and its centre is inside it.
  const [lon, lat] = cellCentre(centre);
  assert.ok(Math.abs(lat - 50) < 1 && Math.abs(lon - 10) < 1.5);
  const ring = cellRing(centre);
  assert.equal(ring.length, 6);
  assert.notDeepEqual(ring[0], ring.at(-1));
});
