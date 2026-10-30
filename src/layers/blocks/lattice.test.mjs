// Personal fork: the Blocks pyramid's request lattice
// (src/layers/blocks/lattice.js): tiles of 512 cells of a level (256 at
// 480 and 1,920 m), a global
// equal-angle grid from 180° W and 90° S, the same box for every view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HALF_LATTICE_M,
  LATTICE_CELLS,
  latticeBox,
  latticeCells,
  latticeWeight,
  latticeIndex,
  latticeKey,
  latticeSideDeg,
  latticeSpan,
  latticeTilesOver,
} from './lattice.js';

const M_PER_DEG = 111_319.49;

test('a tile is 512 cells of its level a side (256 at 480 and 1,920 m), in degrees of latitude', () => {
  assert.equal(LATTICE_CELLS, 512);
  assert.deepEqual(HALF_LATTICE_M, [480, 1920]);
  for (const [blockM, cells] of [
    [1, 512],
    [30, 512],
    [120, 512],
    [480, 256],
    [1920, 256],
    [7680, 512],
    [30720, 512],
  ]) {
    assert.equal(latticeCells(blockM), cells);
    assert.equal(latticeWeight(blockM), (cells / 512) ** 2);
    assert.ok(
      Math.abs(latticeSideDeg(blockM) * M_PER_DEG - cells * blockM) < 1e-6,
    );
  }
  // The top level: 141° tiles, three across the longitudes, two over the latitudes.
  assert.deepEqual(latticeSpan(30720), { cols: 3, rows: 2 });
});

test('latticeIndex and latticeBox: a place lies in its tile; boxes are cut at the antimeridian and poles', () => {
  for (const [blockM, lon, lat] of [
    [1, -76.6123, 39.2987],
    [30, 0.5, 51.5],
    [1920, 179.99, -89.99],
    [30720, -180, 90],
  ]) {
    const { ti, tj } = latticeIndex(blockM, lon, lat);
    const box = latticeBox(blockM, ti, tj);
    assert.ok(box.west <= lon && lon <= box.east, `${blockM} ${lon}`);
    assert.ok(box.south <= lat && lat <= box.north, `${blockM} ${lat}`);
    assert.ok(box.west >= -180 && box.east <= 180);
    assert.ok(box.south >= -90 && box.north <= 90);
  }
  // Neighbours share an edge exactly.
  const a = latticeBox(30, 100, 200);
  const b = latticeBox(30, 101, 200);
  assert.equal(a.east, b.west);
  assert.equal(latticeKey(30, 100, 200), '30|100:200');
});

test('latticeTilesOver: the tiles a box overlaps, south-west first', () => {
  const side = latticeSideDeg(30);
  const box = {
    west: -180 + 2.5 * side,
    south: -90 + 7.2 * side,
    east: -180 + 4.1 * side,
    north: -90 + 7.9 * side,
  };
  assert.deepEqual(latticeTilesOver(box, 30), [
    { ti: 2, tj: 7 },
    { ti: 3, tj: 7 },
    { ti: 4, tj: 7 },
  ]);
});
