// Personal fork: the ground an arrival is lifted to while Render: Blocks
// hides the globe (src/app/blocks.js pointGroundM, the camera guard's
// fallback): one values probe, its plausible heights' mean, on the
// region's datum.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pointGroundM } from './blocks.js';

const valuesAnswering = (heights) => {
  const asked = [];
  return {
    asked,
    get: async (request) => {
      asked.push(request);
      return { header: {}, values: Float32Array.from(heights) };
    },
  };
};

test('the point probe: one 4-cell request about the point, the mean of its plausible heights, plus the geoid on terrain', async () => {
  const values = valuesAnswering([1890, 1900, Number.NaN, -9999]);
  const terrain = { flat: () => false, undulation: async () => -30 };
  const groundM = await pointGroundM(
    { values, datum: terrain },
    39.0885,
    -120.0504,
  );
  assert.equal(groundM, 1895 - 30);
  assert.equal(values.asked.length, 1);
  assert.equal(values.asked[0].layer, 'ee-elevation');
  assert.equal(values.asked[0].cells, 4);
  const { west, east, south, north } = values.asked[0].box;
  assert.ok(
    west < -120.0504 && east > -120.0504 && south < 39.0885 && north > 39.0885,
  );
  // Flat ground: the blocks stand on the ellipsoid, no geoid.
  const flat = { flat: () => true, undulation: async () => -30 };
  assert.equal(
    await pointGroundM({ values, datum: flat }, 39.0885, -120.0504),
    1895,
  );
  // Nothing plausible: unknown.
  const empty = valuesAnswering([Number.NaN, -9999]);
  assert.ok(
    Number.isNaN(await pointGroundM({ values: empty, datum: flat }, 0, 0)),
  );
});
