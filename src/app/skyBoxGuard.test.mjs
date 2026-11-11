// Personal fork: the sky box guard (skyBoxGuard.js) on Cesium's own SkyBox.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { guardSkyBox, SKY_BOX_RETRIES } from './skyBoxGuard.js';

const FACES = {
  positiveX: 'px.jpg',
  negativeX: 'nx.jpg',
  positiveY: 'py.jpg',
  negativeY: 'ny.jpg',
  positiveZ: 'pz.jpg',
  negativeZ: 'nz.jpg',
};
const FRAME = {
  mode: Cesium.SceneMode.SCENE3D,
  passes: { render: true },
  context: {},
};

/** A face image that would not decode, as loadCubeMap's rejection leaves it. */
function failLoad(skyBox) {
  const error = new Error('The source image could not be decoded.');
  error.name = 'InvalidStateError';
  skyBox._sources = skyBox.sources;
  skyBox._hasError = true;
  skyBox._error = error;
  return error;
}

test('Cesium’s SkyBox throws a failed face load from its next update (inside Scene.render: rendering stops)', () => {
  const skyBox = new Cesium.SkyBox({ sources: FACES });
  const error = failLoad(skyBox);
  assert.throws(
    () => skyBox.update(FRAME, false),
    (thrown) => thrown === error,
  );
});

test('guarded: a failed face load is taken, not thrown; the faces are asked again twice, then the stars are left off; the page keeps rendering', () => {
  assert.equal(SKY_BOX_RETRIES, 2);
  const skyBox = new Cesium.SkyBox({ sources: FACES });
  const renders = [];
  const warnings = [];
  const scene = { skyBox, requestRender: () => renders.push(1) };
  const undo = guardSkyBox(scene, { warn: (text) => warnings.push(text) });
  for (let attempt = 1; attempt <= SKY_BOX_RETRIES; attempt++) {
    failLoad(skyBox);
    assert.equal(skyBox.update(FRAME, false), undefined, 'no stars this frame');
    assert.equal(skyBox._hasError, false);
    assert.equal(skyBox._error, undefined);
    assert.equal(skyBox._sources, undefined, 'the next update loads anew');
    assert.equal(skyBox.show, true);
    assert.match(
      warnings.at(-1),
      /could not be decoded.*asking again \(\d of 2\)/,
    );
  }
  // The third failure: the stars go.
  failLoad(skyBox);
  assert.equal(skyBox.update(FRAME, false), undefined);
  assert.equal(skyBox.show, false);
  assert.match(warnings.at(-1), /the stars are left off/);
  assert.equal(renders.length, SKY_BOX_RETRIES + 1, 'a frame asked each time');
  // Hidden, Cesium's own update draws nothing and throws nothing.
  assert.equal(skyBox.update(FRAME, false), undefined);
  // Undone: Cesium's update again.
  undo();
  assert.equal(skyBox.update, Cesium.SkyBox.prototype.update);
  skyBox.show = true;
  const error = failLoad(skyBox);
  assert.throws(
    () => skyBox.update(FRAME, false),
    (thrown) => thrown === error,
  );
});

test('guarded: without a failed load, every update is Cesium’s own', () => {
  const calls = [];
  const skyBox = {
    _hasError: false,
    update(frameState, useHdr) {
      calls.push([this, frameState, useHdr]);
      return 'command';
    },
  };
  guardSkyBox({ skyBox });
  assert.equal(skyBox.update(FRAME, true), 'command');
  assert.deepEqual(calls, [[skyBox, FRAME, true]]);
  // No sky box, or not one with an update: nothing to guard.
  assert.equal(typeof guardSkyBox({}), 'function');
  assert.equal(typeof guardSkyBox(null), 'function');
});
