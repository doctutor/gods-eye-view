// Personal fork: what the camera stands over (src/hud/cameraState.js): the
// surface under it and the distance to the surface at the screen's centre,
// with the misses of the Tahoe field report (2026-10-27, Google 3D tiles,
// 4 m over the lake: AGL read 25,700 m from a sample at -23.8 km, and the
// centre fell back to the camera's height) on a fake scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  SURFACE_MAX_M,
  SURFACE_MIN_M,
  centreDistanceM,
  plausibleSurfaceM,
  surfaceUnderCamera,
  viewDiagnostics,
} from './cameraState.js';

const TAHOE = { lat: 39.02, lon: -120.12 };
const LAKE_M = 1897;
const at = (heightM, lat = TAHOE.lat, lon = TAHOE.lon) =>
  Cesium.Cartesian3.fromDegrees(lon, lat, heightM);

/**
 * A camera 4 m over the lake looking 3° down, heading 300°, and a scene whose
 * picks answer as told: `pickPosition`, `pickFromRay` (by direction: down
 * or along the centre ray), `sampleHeight`, and a hidden or shown globe.
 */
function fakeViewer({
  pickPosition = () => undefined,
  rayDown = () => undefined,
  rayCentre = () => undefined,
  sampleHeight = () => undefined,
  globe = null,
} = {}) {
  const positionWC = at(LAKE_M + 4);
  const camera = new Cesium.Camera({
    canvas: { clientWidth: 1017, clientHeight: 640 },
    drawingBufferWidth: 1017,
    drawingBufferHeight: 640,
    mapProjection: new Cesium.GeographicProjection(),
  });
  camera.setView({
    destination: positionWC,
    orientation: {
      heading: Cesium.Math.toRadians(300),
      pitch: Cesium.Math.toRadians(-3),
      roll: 0,
    },
  });
  const asked = [];
  const scene = {
    canvas: { clientWidth: 1017, clientHeight: 640 },
    drawingBufferWidth: 2034,
    pixelRatio: 2,
    pickPositionSupported: true,
    sampleHeightSupported: true,
    pickPosition: (windowPosition) => {
      asked.push(['pickPosition', windowPosition.x, windowPosition.y]);
      return pickPosition();
    },
    pickFromRay: (ray) => {
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
        ray.origin,
        new Cesium.Cartesian3(),
      );
      const down = Cesium.Cartesian3.dot(ray.direction, up) < -0.999;
      asked.push([down ? 'rayDown' : 'rayCentre']);
      const position = down ? rayDown(ray) : rayCentre(ray);
      return position ? { position } : undefined;
    },
    sampleHeight: () => {
      asked.push(['sampleHeight']);
      return sampleHeight();
    },
    globe: globe || { show: false },
  };
  return { viewer: { camera, scene }, asked };
}

test('a plausible surface lies between -500 m and 9,000 m', () => {
  assert.equal(SURFACE_MIN_M, -500);
  assert.equal(SURFACE_MAX_M, 9000);
  for (const ok of [-430, 0, LAKE_M, 8849]) assert.ok(plausibleSurfaceM(ok));
  for (const bad of [-23_800, -30_000, 9001, NaN, Infinity])
    assert.ok(!plausibleSurfaceM(bad), String(bad));
});

test('Tahoe: the ray down from the camera finds the lake, and wins', () => {
  const { viewer, asked } = fakeViewer({
    rayDown: () => at(LAKE_M),
    sampleHeight: () => -23_800,
  });
  const surface = surfaceUnderCamera(viewer);
  assert.ok(Math.abs(surface.heightM - LAKE_M) < 0.01);
  assert.equal(surface.via, 'down');
  assert.deepEqual(asked, [['rayDown']], 'sampleHeight not needed');
});

test('Tahoe: a sample at -23.8 km is a miss, not the ground; the next way, or NaN', () => {
  // The ray down misses too, sampleHeight answers the chord: nothing sane.
  const missed = fakeViewer({ sampleHeight: () => -23_800 });
  assert.ok(Number.isNaN(surfaceUnderCamera(missed.viewer).heightM));
  // A shown globe with its terrain loaded answers instead.
  const terrain = fakeViewer({
    rayDown: () => at(-23_800),
    sampleHeight: () => -23_800,
    globe: { show: true, getHeight: () => LAKE_M + 0.4 },
  });
  const surface = surfaceUnderCamera(terrain.viewer);
  assert.equal(surface.via, 'globe');
  assert.ok(Math.abs(surface.heightM - (LAKE_M + 0.4)) < 1e-9);
  // sampleHeight is still used when it is sane.
  const sampled = fakeViewer({ sampleHeight: () => LAKE_M });
  assert.equal(surfaceUnderCamera(sampled.viewer).via, 'sample');
});

test('Tahoe: the centre is found by a ray through the tileset when the depth pick misses', () => {
  // 3° down from 4 m: the water 76 m out.
  const water = (ray) =>
    Cesium.Ray.getPoint(ray, 76.4, new Cesium.Cartesian3());
  const { viewer, asked } = fakeViewer({ rayCentre: water });
  const centre = centreDistanceM(viewer);
  assert.equal(centre.via, 'ray');
  assert.ok(Math.abs(centre.distanceM - 76.4) < 0.01, `${centre.distanceM}`);
  // The depth pick was asked at the centre in CSS pixels, not device pixels.
  assert.deepEqual(asked[0], ['pickPosition', 1017 / 2, 640 / 2]);
  // A depth hit is taken first; a hit far below any surface is not.
  const depth = fakeViewer({
    pickPosition: () => at(LAKE_M, 39.0203, -120.1207),
  });
  assert.equal(centreDistanceM(depth.viewer).via, 'depth');
  const deep = fakeViewer({
    pickPosition: () => at(-23_800),
    rayCentre: () => at(-23_800),
  });
  const fallback = centreDistanceM(deep.viewer);
  assert.equal(fallback.via, 'height');
  assert.equal(fallback.hit, false);
  assert.ok(Math.abs(fallback.distanceM - (LAKE_M + 4)) < 0.01);
});

test('the live diagnostics: every way raw, beside the ones used', () => {
  const { viewer } = fakeViewer({
    rayDown: () => at(LAKE_M),
    rayCentre: (ray) => Cesium.Ray.getPoint(ray, 76.4, new Cesium.Cartesian3()),
    sampleHeight: () => -23_800,
  });
  const report = viewDiagnostics(viewer);
  assert.equal(report.surface.sampleHeightM, -23_800);
  assert.ok(Math.abs(report.surface.downHeightM - LAKE_M) < 0.01);
  assert.equal(report.centre.pickPositionM, null);
  assert.ok(Math.abs(report.centre.rayM - 76.4) < 0.01);
  assert.equal(report.used.surface.via, 'down');
  assert.equal(report.used.centre.via, 'ray');
  assert.equal(report.canvas.cssWidth, 1017);
  assert.equal(report.globeShown, false);
});
