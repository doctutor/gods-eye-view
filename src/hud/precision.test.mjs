// Personal fork: the HUD camera readout's precision rule (src/hud/precision.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DATA_FLOORS,
  dataFloor,
  degreeDecimals,
  dmsSecondDecimals,
  formatFootprint,
  formatLength,
  lengthDecimals,
  lengthStepM,
  mgrsDigits,
  pixelFootprintM,
  viewPrecision,
} from './precision.js';

const FOV_60 = Math.PI / 3;

test('a pixel’s footprint: 2·d·tan(fov/2) / width', () => {
  // 1,000 m away, 60°, 1,155 px wide: 1 m a pixel.
  const px = pixelFootprintM({
    distanceM: 1000,
    fovRad: FOV_60,
    widthPx: 1155,
  });
  assert.ok(Math.abs(px - 1) < 0.001, `${px}`);
  // Twice as far, twice the footprint; a narrower view, a smaller one.
  assert.ok(
    Math.abs(
      pixelFootprintM({ distanceM: 2000, fovRad: FOV_60, widthPx: 1155 }) - 2,
    ) < 0.002,
  );
  assert.ok(
    pixelFootprintM({ distanceM: 1000, fovRad: FOV_60 / 2, widthPx: 1155 }) <
      0.5,
  );
  // Nothing to measure: NaN, never 0 or Infinity.
  for (const bad of [
    { distanceM: 0, fovRad: FOV_60, widthPx: 1000 },
    { distanceM: 1000, fovRad: 0, widthPx: 1000 },
    { distanceM: 1000, fovRad: FOV_60, widthPx: 0 },
    { distanceM: NaN, fovRad: FOV_60, widthPx: 1000 },
  ])
    assert.ok(Number.isNaN(pixelFootprintM(bad)));
});

test('lengths: the footprint rounded down to a power of ten, 1 mm to 10 km', () => {
  assert.equal(lengthStepM(37_000), 10_000);
  assert.equal(lengthStepM(4_200), 1_000);
  assert.equal(lengthStepM(1_000), 1_000);
  assert.equal(lengthStepM(999), 100);
  assert.equal(lengthStepM(23), 10);
  assert.equal(lengthStepM(1), 1);
  assert.equal(lengthStepM(0.42), 0.1);
  assert.equal(lengthStepM(0.0042), 0.001);
  assert.equal(lengthStepM(0.00001), 0.001, 'never finer than 1 mm');
  assert.equal(lengthStepM(9e7), 10_000, 'never coarser than 10 km');
  assert.equal(lengthDecimals(10_000), 0);
  assert.equal(lengthDecimals(1), 0);
  assert.equal(lengthDecimals(0.1), 1);
  assert.equal(lengthDecimals(0.001), 3);
});

test('the data floor caps the precision at its own decimal place', () => {
  // Google's 0.5 m tiles: 0.1 m at best, however close the camera.
  assert.equal(lengthStepM(0.004, DATA_FLOORS.google.floorM), 0.1);
  // Cesium World Terrain's 10 m: 10 m at best; Re:Earth's 30 m likewise.
  assert.equal(lengthStepM(0.4, DATA_FLOORS.world.floorM), 10);
  assert.equal(lengthStepM(0.4, DATA_FLOORS.keyless.floorM), 10);
  // From high up the footprint, not the floor, decides.
  assert.equal(lengthStepM(4_200, DATA_FLOORS.google.floorM), 1_000);
  // An unmeasured view (no hit, no width) takes the floor's step.
  assert.equal(lengthStepM(NaN, DATA_FLOORS.world.floorM), 10);
  const close = viewPrecision({ footprintM: 0.03, floor: DATA_FLOORS.google });
  assert.equal(close.stepM, 0.1);
  assert.equal(close.lengthDecimals, 1);
  assert.equal(close.degreeDecimals, 6, '0.5 m needs 0.000001°');
  const terrain = viewPrecision({ footprintM: 0.03, floor: DATA_FLOORS.world });
  assert.equal(terrain.stepM, 10);
  assert.equal(terrain.lengthDecimals, 0);
  assert.equal(terrain.degreeDecimals, 5, '0.0001° is 11 m: 10 m needs 5');
  assert.equal(
    viewPrecision({ footprintM: 0.03, floor: DATA_FLOORS.keyless })
      .degreeDecimals,
    4,
    '30 m: 0.0001°',
  );
});

test('which surface is under the camera, and its floor', () => {
  assert.equal(
    dataFloor({ tilesetShown: true, terrainId: 'world' }).id,
    'google',
  );
  assert.equal(dataFloor({ terrainId: 'world' }).floorM, 10);
  assert.equal(dataFloor({ terrainId: 'keyless' }).floorM, 30);
  assert.equal(dataFloor({ terrainId: '3dep-1m' }).floorM, 1);
  assert.equal(dataFloor({ terrainId: null }).id, 'flat');
  assert.equal(dataFloor({ terrainId: 'unknown' }).id, 'flat');
  assert.equal(dataFloor().id, 'flat');
});

test('Render: Blocks names its block size as the floor, over whatever is beneath', () => {
  const floor = dataFloor({
    tilesetShown: true,
    terrainId: 'world',
    blocksM: 1,
  });
  assert.deepEqual(
    { ...floor },
    { id: 'blocks', name: 'Blocks 1 m', floorM: 1 },
  );
  assert.equal(dataFloor({ blocksM: 30 }).name, 'Blocks 30 m');
  assert.equal(dataFloor({ blocksM: null, terrainId: 'world' }).id, 'world');
  assert.equal(dataFloor({ blocksM: 0 }).id, 'flat');
  // 1 m blocks: lengths to the metre at most, as on 3DEP 1 m.
  assert.equal(
    viewPrecision({ footprintM: 0.05, floor: dataFloor({ blocksM: 1 }) }).stepM,
    1,
  );
});

test('latitude and longitude: the decimals that resolve the footprint', () => {
  // 1 decimal ≈ 11 km, 2 ≈ 1.1 km, 3 ≈ 110 m, 4 ≈ 11 m, 5 ≈ 1.1 m, 6 ≈ 0.11 m.
  assert.equal(degreeDecimals(200_000), 0);
  assert.equal(degreeDecimals(12_000), 1);
  assert.equal(degreeDecimals(11_000), 2);
  assert.equal(degreeDecimals(2_000), 2);
  assert.equal(degreeDecimals(500), 3);
  assert.equal(degreeDecimals(30), 4);
  assert.equal(degreeDecimals(1.2), 5);
  assert.equal(degreeDecimals(0.5), 6);
  assert.equal(degreeDecimals(0.005), 7);
  // From orbit, few; near the ground on Google, six.
  assert.equal(viewPrecision({ footprintM: 9_000 }).degreeDecimals, 2);
  assert.equal(
    viewPrecision({ footprintM: 0.2, floor: DATA_FLOORS.google })
      .degreeDecimals,
    6,
  );
});

test('angles keep 2 decimals at any height', () => {
  for (const footprintM of [0.01, 1, 100, 1e6])
    assert.equal(viewPrecision({ footprintM }).angleDecimals, 2);
});

test('MGRS digits step 1 km, 100 m, 10 m, 1 m with the footprint', () => {
  assert.equal(mgrsDigits(10_000), 2);
  assert.equal(mgrsDigits(1_000), 2);
  assert.equal(mgrsDigits(100), 3);
  assert.equal(mgrsDigits(10), 4);
  assert.equal(mgrsDigits(1), 5);
  assert.equal(mgrsDigits(0.1), 5, 'MGRS stops at the metre');
  assert.equal(viewPrecision({ footprintM: 40 }).mgrsDigits, 4);
  assert.equal(
    viewPrecision({ footprintM: 0.3, floor: DATA_FLOORS.world }).mgrsDigits,
    4,
    'the floor caps MGRS too',
  );
});

test('DMS seconds follow the footprint: an arcsecond is about 31 m', () => {
  assert.equal(dmsSecondDecimals(100), 0);
  assert.equal(dmsSecondDecimals(5), 1);
  assert.equal(dmsSecondDecimals(0.5), 2);
  assert.equal(dmsSecondDecimals(0.01), 3);
});

test('lengths and the footprint as written', () => {
  assert.equal(formatLength(1234.56, 1), '1235');
  assert.equal(formatLength(1234.56, 10), '1230');
  assert.equal(formatLength(4.23, 0.1), '4.2');
  assert.equal(formatLength(-3.14159, 0.01), '-3.14');
  assert.equal(formatLength(NaN, 1), '—');
  assert.equal(formatFootprint(0.4236), '0.42 m');
  assert.equal(formatFootprint(12.7), '13 m');
  assert.equal(formatFootprint(1234), '1.2 km');
  assert.equal(formatFootprint(NaN), '—');
});

test('Render: Blocks: the floor names the blocks drawn, else the Elevation layer’s Blocks style draped ("Blocks style 31 km"), else the ground', () => {
  assert.equal(
    dataFloor({ blocksM: 7680, blocksStyleM: 30_720 }).name,
    'Blocks 7.7 km',
  );
  const style = dataFloor({ blocksStyleM: 30_720, terrainId: 'world' });
  assert.equal(style.id, 'blocks-style');
  assert.equal(style.name, 'Blocks style 31 km');
  assert.equal(style.floorM, 30_720);
  assert.equal(
    dataFloor({ blocksStyleM: null, terrainId: 'world' }).id,
    'world',
  );
});
