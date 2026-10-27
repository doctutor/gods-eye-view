// Personal fork: which surface hits on 3D tiles are trusted
// (src/surfaceTrust.js), on fake pick objects and a fake tileset: the
// Baltimore field report (2026-10-27, Google tiles, the camera at 80 m: a
// coarse ancestor tile read +535 m, AGL showed -455.5 m and Cesium's camera
// collision lifted the eye to 536 m).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  COLLISION_REFRESH_FRAMES,
  TRUSTED_TILE_ERROR_M,
  allowedTileErrorM,
  columnHit,
  gateCollisionOnRefinedTiles,
  judgeHit,
  pickedTile,
  surfaceAt,
  trustedCollisionHeightM,
} from './surfaceTrust.js';

const BALTIMORE = { lat: 39.321451, lon: -76.629219 };
const at = (heightM) =>
  Cesium.Cartesian3.fromDegrees(BALTIMORE.lon, BALTIMORE.lat, heightM);

/** A camera over Baltimore, 1017 × 640 CSS pixels, 60° across. */
function fakeViewer({ cameraHeightM = 80, scene = {} } = {}) {
  const positionWC = at(cameraHeightM);
  return {
    camera: {
      positionWC,
      positionCartographic: Cesium.Cartographic.fromCartesian(positionWC),
      frustum: { fov: Cesium.Math.toRadians(60) },
    },
    scene: { canvas: { clientWidth: 1017, clientHeight: 640 }, ...scene },
  };
}

/** A pick result on a tile of a geometric error, as Cesium gives it. */
const onTile = (position, geometricError, maximumScreenSpaceError = 16) => ({
  position,
  object: {
    content: { tile: { geometricError } },
    primitive: { isCesium3DTileset: true, maximumScreenSpaceError },
  },
});

test('a hit on a 1,100 m tile is not trusted near the camera; a 1.2 m leaf is', () => {
  const viewer = fakeViewer();
  const coarse = judgeHit(viewer, onTile(at(25), 1100));
  assert.equal(coarse.trusted, false);
  assert.equal(coarse.tileErrorM, 1100);
  const leaf = judgeHit(viewer, onTile(at(25.4), 1.2));
  assert.equal(leaf.trusted, true);
  assert.equal(leaf.tileErrorM, 1.2);
  // Off the tiles (the globe, a model) a hit is trusted as before.
  assert.equal(judgeHit(viewer, { position: at(25) }).trusted, true);
  assert.equal(judgeHit(viewer, undefined), null);
  // A feature's pick object carries its content too.
  assert.equal(
    pickedTile({ content: { tile: { geometricError: 3 } } }).geometricError,
    3,
  );
  assert.equal(pickedTile({ primitive: {} }), null);
});

test('the error trusted grows with distance as Cesium refines: far tiles may be coarse', () => {
  const viewer = fakeViewer();
  assert.equal(allowedTileErrorM(viewer, 1), TRUSTED_TILE_ERROR_M);
  assert.equal(allowedTileErrorM(viewer, 100), TRUSTED_TILE_ERROR_M);
  // 50 km away a pixel is ~57 m: 2 × 16 × 57 ≈ 1.8 km of error is trusted,
  // as Cesium would draw such a tile there itself.
  const far = allowedTileErrorM(viewer, 50_000);
  const pixel = (2 * 50_000 * Math.tan(Math.PI / 6)) / 1017;
  assert.ok(Math.abs(far - 2 * 16 * pixel) < 1e-6, `${far}`);
  assert.equal(judgeHit(viewer, onTile(at(-49_900), 1100)).trusted, true);
  // A tileset that refines harder trusts less.
  assert.ok(
    allowedTileErrorM(viewer, 50_000, { maximumScreenSpaceError: 4 }) < far / 2,
  );
});

test('the surface from above: a coarse tile is NaN, a leaf its height; sampleHeight only without ray picks', () => {
  let answer = onTile(at(535), 1100);
  const viewer = fakeViewer({
    scene: { pickFromRay: () => answer, sampleHeight: () => 535 },
  });
  const coarse = surfaceAt(viewer, BALTIMORE.lat, BALTIMORE.lon);
  assert.ok(Number.isNaN(coarse.heightM));
  assert.equal(coarse.via, 'above');
  assert.equal(coarse.trusted, false);
  assert.ok(Math.abs(coarse.rawHeightM - 535) < 0.01);
  answer = onTile(at(25.4), 1.2);
  const leaf = surfaceAt(viewer, BALTIMORE.lat, BALTIMORE.lon);
  assert.ok(Math.abs(leaf.heightM - 25.4) < 0.01);
  assert.equal(leaf.trusted, true);
  const older = fakeViewer({ scene: { sampleHeight: () => 25 } });
  assert.deepEqual(
    [
      surfaceAt(older, BALTIMORE.lat, BALTIMORE.lon).via,
      surfaceAt(older, 0, 0).heightM,
    ],
    ['sample', 25],
  );
});

/**
 * A Google-like tileset drawing one tile over Baltimore, its surface at
 * `heightM` with `geometricError`; and a scene whose own globeHeight (the
 * Scene.prototype getter) reads what Cesium measured.
 */
function collisionScene({ heightM, geometricError, cesiumHeightM }) {
  const tile = {
    geometricError,
    contentBoundingVolume: {
      boundingSphere: new Cesium.BoundingSphere(at(0), 5000),
    },
    content: { pick: () => at(heightM) },
  };
  const tileset = {
    isCesium3DTileset: true,
    show: true,
    enableCollision: true,
    maximumScreenSpaceError: 16,
    _selectedTiles: [tile],
  };
  class FakeScene {
    get globeHeight() {
      return this._globeHeight;
    }
  }
  const scene = Object.assign(new FakeScene(), {
    _globeHeight: cesiumHeightM,
    frameState: { frameNumber: 1 },
    primitives: { length: 1, get: () => tileset },
    globe: { show: false },
    canvas: { clientWidth: 1017, clientHeight: 640 },
  });
  return { scene, tileset, tile };
}

test("Cesium's camera collision is not lifted by a coarse tile; it is by the leaves", () => {
  const { scene, tile } = collisionScene({
    heightM: 535,
    geometricError: 1100,
    cesiumHeightM: 535,
  });
  const viewer = fakeViewer({ cameraHeightM: 80 });
  viewer.scene = scene;
  const hit = columnHit(
    scene.primitives.get(0),
    viewer.camera.positionCartographic,
    scene,
  );
  assert.equal(hit.tile, tile);
  assert.equal(trustedCollisionHeightM(viewer), undefined);
  const undo = gateCollisionOnRefinedTiles(viewer);
  // What ScreenSpaceCameraController reads: nothing to keep the eye above.
  assert.equal(scene.globeHeight, undefined);
  // The leaves arrive: a still camera keeps its answer a few frames, then
  // the collision sees them.
  tile.geometricError = 1.2;
  tile.content.pick = () => at(25.4);
  scene._globeHeight = 25.4;
  scene.frameState.frameNumber = 2;
  assert.equal(scene.globeHeight, undefined, 'held while the camera is still');
  scene.frameState.frameNumber = 1 + COLLISION_REFRESH_FRAMES;
  assert.ok(Math.abs(scene.globeHeight - 25.4) < 0.01);
  // A camera that moves is measured again at once.
  tile.content.pick = () => at(30);
  viewer.camera.positionWC = at(81);
  scene.frameState.frameNumber += 1;
  assert.ok(Math.abs(scene.globeHeight - 30) < 0.01);
  // Nothing measured by Cesium: nothing measured here either.
  scene._globeHeight = undefined;
  scene.frameState.frameNumber += 1;
  assert.equal(scene.globeHeight, undefined);
  undo();
  scene._globeHeight = 535;
  assert.equal(scene.globeHeight, 535, 'the undo restores Cesium');
});

test('the collision still meets a shown globe under coarse tiles', () => {
  const { scene } = collisionScene({
    heightM: 535,
    geometricError: 1100,
    cesiumHeightM: 535,
  });
  scene.globe = { show: true, getHeight: () => 20 };
  const viewer = fakeViewer({ cameraHeightM: 80 });
  viewer.scene = scene;
  gateCollisionOnRefinedTiles(viewer);
  assert.equal(scene.globeHeight, 20);
});
