// Personal fork: Blocks under the Relief control (src/layers/blocks/
// relief.js): a true height drawn as Cesium draws the globe, and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NO_RELIEF, drawnHeightM, reliefOf, trueHeightM } from './relief.js';

test('Relief ×3 about 50 m: drawn and back; ×1 and nothing are true heights', () => {
  const relief = { factor: 3, relativeM: 50 };
  assert.equal(drawnHeightM(-33, relief), -199);
  assert.equal(drawnHeightM(150, relief), 350);
  assert.equal(drawnHeightM(50, relief), 50, 'the relative height stays');
  for (const h of [-33, 0, 12.4, 150, 4000])
    assert.ok(
      Math.abs(trueHeightM(drawnHeightM(h, relief), relief) - h) < 1e-9,
    );
  assert.equal(drawnHeightM(150, { factor: 1, relativeM: 50 }), 150);
  assert.equal(trueHeightM(150), 150);
  assert.deepEqual(reliefOf({ factor: 3, relativeM: 50 }), relief);
  assert.equal(reliefOf({ factor: 0.5, relativeM: 50 }), NO_RELIEF);
  assert.equal(reliefOf(null), NO_RELIEF);
  assert.deepEqual(reliefOf({ factor: 3 }), { factor: 3, relativeM: 0 });
});
