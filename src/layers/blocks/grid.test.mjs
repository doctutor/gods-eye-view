// Personal fork: the Blocks grid (src/layers/blocks/grid.js): the region's
// tangent frame round-trips places, and columns and chunks index the same
// way at 1 m and 30 m blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHUNK_COLUMNS,
  chunkKey,
  columnIndex,
  createRegion,
  levelOf,
  metresPerDegree,
  parseChunkKey,
  snapOrigin,
} from './grid.js';

const BALTIMORE = { lon: -76.6122, lat: 39.2904 };

for (const blockM of [1, 30]) {
  test(`${blockM} m: the origin sits on the block graticule, and places round-trip`, () => {
    const region = createRegion({
      lon0: BALTIMORE.lon,
      lat0: BALTIMORE.lat,
      blockM,
    });
    assert.equal(region.blockM, blockM);
    // Snapped by less than half a block, and the same for any place nearby.
    const perDegree = metresPerDegree(39);
    assert.ok(
      Math.abs(region.lat0 - BALTIMORE.lat) * perDegree.lat <=
        blockM / 2 + 1e-6,
    );
    assert.ok(
      Math.abs(region.lon0 - BALTIMORE.lon) * perDegree.lon <=
        blockM / 2 + 1e-6,
    );
    const again = snapOrigin(
      region.lon0 + 0.1 * (blockM / perDegree.lon),
      region.lat0 - 0.1 * (blockM / perDegree.lat),
      blockM,
    );
    assert.ok(Math.abs(again.lon0 - region.lon0) < 1e-12);
    assert.ok(Math.abs(again.lat0 - region.lat0) < 1e-12);
    // The origin is (0, 0); places 15 km out come back to a millimetre.
    const origin = region.toLocal(region.lon0, region.lat0);
    assert.ok(Math.hypot(origin.x, origin.y) < 1e-6);
    for (const [x, y] of [
      [0, 0],
      [blockM * 3.5, -blockM * 7.25],
      [15_000, 15_000],
      [-12_345.6, 8_765.4],
    ]) {
      const place = region.toLonLat(x, y);
      const back = region.toLocal(place.lon, place.lat);
      assert.ok(Math.abs(back.x - x) < 1e-3, `x ${x} → ${back.x}`);
      assert.ok(Math.abs(back.y - y) < 1e-3, `y ${y} → ${back.y}`);
    }
    // East is east and north is north: a degree's metres, near the origin.
    const east = region.toLocal(region.lon0 + 0.001, region.lat0);
    assert.ok(Math.abs(east.x - 0.001 * perDegree.lon) < 0.5);
    assert.ok(Math.abs(east.y) < 0.01);
    const north = region.toLocal(region.lon0, region.lat0 + 0.001);
    assert.ok(Math.abs(north.y - 0.001 * perDegree.lat) < 0.5);
    assert.ok(region.within(BALTIMORE.lon, BALTIMORE.lat));
    assert.ok(!region.within(BALTIMORE.lon + 1, BALTIMORE.lat));
  });

  test(`${blockM} m: columns, chunks and their corners index alike`, () => {
    const region = createRegion({
      lon0: BALTIMORE.lon,
      lat0: BALTIMORE.lat,
      blockM,
    });
    const chunkM = CHUNK_COLUMNS * blockM;
    assert.deepEqual(region.columnOf(0, 0), { i: 0, j: 0 });
    assert.deepEqual(region.columnOf(blockM - 1e-9, -1e-9), { i: 0, j: -1 });
    assert.deepEqual(region.columnOf(-blockM * 64.5, blockM * 63.99), {
      i: -65,
      j: 63,
    });
    assert.deepEqual(region.chunkOf(63, 64), { ci: 0, cj: 1 });
    assert.deepEqual(region.chunkOf(-1, -64), { ci: -1, cj: -1 });
    assert.deepEqual(region.chunkOf(-65, 128), { ci: -2, cj: 2 });
    assert.deepEqual(region.localColumn(-1, 64), { li: 63, lj: 0 });
    assert.deepEqual(region.localColumn(-65, 130), { li: 63, lj: 2 });
    // A column's chunk origin plus its local column is the column again.
    for (const [i, j] of [
      [0, 0],
      [-1, -1],
      [200, -130],
    ]) {
      const { ci, cj } = region.chunkOf(i, j);
      const { li, lj } = region.localColumn(i, j);
      const origin = region.chunkOrigin(ci, cj);
      assert.deepEqual(
        region.columnOf(
          origin.x + (li + 0.5) * blockM,
          origin.y + (lj + 0.5) * blockM,
        ),
        { i, j },
      );
    }
    const origin = region.chunkOrigin(-2, 3);
    assert.equal(origin.x, -2 * chunkM);
    assert.equal(origin.y, 3 * chunkM);
    // The ellipsoid falls away from the tangent plane: about d²/2R.
    const d = Math.hypot(origin.x, origin.y);
    assert.ok(
      Math.abs(origin.z + (d * d) / (2 * 6_371_000)) <
        (0.05 * (d * d)) / 6e6 + 1e-3,
    );
    assert.equal(region.chunkOrigin(0, 0).z, 0);
    // A chunk's bounds hold its corners and its columns' centres.
    const bounds = region.chunkBounds(1, -1);
    for (const [i, j] of [
      [64, -64],
      [127, -1],
    ]) {
      const centre = region.columnCentre(i, j);
      assert.ok(centre.lon > bounds.west && centre.lon < bounds.east);
      assert.ok(centre.lat > bounds.south && centre.lat < bounds.north);
    }
    const widthM =
      (bounds.east - bounds.west) * metresPerDegree(region.lat0).lon;
    assert.ok(Math.abs(widthM - chunkM) < chunkM * 0.01, `${widthM}`);
  });
}

test('chunk keys, column indices and levels', () => {
  assert.equal(chunkKey(-3, 12), '-3:12');
  assert.deepEqual(parseChunkKey('-3:12'), { ci: -3, cj: 12 });
  assert.equal(parseChunkKey('nope'), null);
  assert.equal(columnIndex(0, 0), 0);
  assert.equal(columnIndex(63, 0), 63);
  assert.equal(columnIndex(0, 1), 64);
  assert.equal(columnIndex(63, 63), CHUNK_COLUMNS ** 2 - 1);
  // y = 0 is the block whose base is mean sea level.
  assert.equal(levelOf(0, 1), 0);
  assert.equal(levelOf(0.99, 1), 0);
  assert.equal(levelOf(-0.01, 1), -1);
  assert.equal(levelOf(29.9, 30), 0);
  assert.equal(levelOf(30, 30), 1);
  assert.equal(levelOf(-30.5, 30), -2);
  assert.throws(
    () => createRegion({ lon0: 0, lat0: 0, blockM: 0 }),
    RangeError,
  );
});

test('a region’s level height: blockM unless given; a 120 m block on 30 m levels', () => {
  const cube = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 1 });
  assert.equal(cube.levelM, 1, 'a cube at native cells');
  assert.equal(cube.levelOf(47.9), 47);
  const flat = createRegion({
    lon0: -76.61,
    lat0: 39.29,
    blockM: 120,
    levelM: 30,
  });
  assert.equal(flat.blockM, 120);
  assert.equal(flat.levelM, 30);
  // Levels by levelM, columns by blockM.
  assert.equal(flat.levelOf(0), 0);
  assert.equal(flat.levelOf(29.9), 0);
  assert.equal(flat.levelOf(95), 3);
  assert.equal(flat.levelOf(-0.5), -1);
  assert.deepEqual(flat.columnOf(239, 241), { i: 1, j: 2 });
  assert.equal(levelOf(95, 30), 3);
  // The origin snaps to the block's graticule, not the level's.
  const same = createRegion({ lon0: -76.61, lat0: 39.29, blockM: 120 });
  assert.equal(flat.lon0, same.lon0);
  assert.equal(flat.lat0, same.lat0);
  assert.throws(
    () => createRegion({ lon0: 0, lat0: 0, blockM: 120, levelM: 0 }),
    RangeError,
  );
});
