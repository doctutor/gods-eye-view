// Personal fork: what the camera stands over (src/hud/cameraState.js): the
// surface under it and the distance to the surface at the screen's centre,
// with the misses of the Tahoe field report (2026-10-27, Google 3D tiles,
// 4 m over the lake: AGL read 25,700 m from a sample at -23.8 km, and the
// centre fell back to the camera's height) on a fake scene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  SURFACE_FRESH_MS,
  SURFACE_MAX_M,
  SURFACE_MIN_M,
  SURFACE_NEAR_M,
  SURFACE_RISE_M,
  centreDistanceM,
  plausibleSurfaceM,
  surfaceSampleStands,
  surfaceUnderCamera,
  viewDiagnostics,
} from './cameraState.js';

const TAHOE = { lat: 39.02, lon: -120.12 };
const LAKE_M = 1897;
const at = (heightM, lat = TAHOE.lat, lon = TAHOE.lon) =>
  Cesium.Cartesian3.fromDegrees(lon, lat, heightM);

/**
 * A camera 4 m over the lake looking 3° down, heading 300°, and a scene whose
 * picks answer as told: `pickPosition`, `pickFromRay` (by direction and
 * origin: down from the camera, down from 9 km as sampleHeight casts, or
 * along the centre ray; a handler answers a position or a whole pick
 * result), `sampleHeight`, and a hidden or shown globe.
 */
function fakeViewer({
  pickPosition = () => undefined,
  rayDown = () => undefined,
  rayAbove = () => undefined,
  rayCentre = () => undefined,
  sampleHeight = () => undefined,
  globe = null,
  cameraHeightM = LAKE_M + 4,
  lat = TAHOE.lat,
  lon = TAHOE.lon,
} = {}) {
  const positionWC = at(cameraHeightM, lat, lon);
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
      const fromAbove =
        down && Cesium.Cartographic.fromCartesian(ray.origin).height > 8000;
      const name = fromAbove ? 'rayAbove' : down ? 'rayDown' : 'rayCentre';
      asked.push([name]);
      const answer = { rayAbove, rayDown, rayCentre }[name](ray);
      if (!answer) return undefined;
      return answer.position ? answer : { position: answer };
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
  // The ray down misses too, the ray from above meets the chord: nothing sane.
  const missed = fakeViewer({ rayAbove: () => at(-23_800) });
  assert.ok(Number.isNaN(surfaceUnderCamera(missed.viewer).heightM));
  // A shown globe with its terrain loaded answers instead.
  const terrain = fakeViewer({
    rayDown: () => at(-23_800),
    rayAbove: () => at(-23_800),
    globe: { show: true, getHeight: () => LAKE_M + 0.4 },
  });
  const surface = surfaceUnderCamera(terrain.viewer);
  assert.equal(surface.via, 'globe');
  assert.ok(Math.abs(surface.heightM - (LAKE_M + 0.4)) < 1e-9);
  // The ray from above is used when it is sane; sampleHeight is not asked
  // where the scene can pick from a ray (it cannot say which tile it met).
  const sampled = fakeViewer({
    rayAbove: () => at(LAKE_M),
    sampleHeight: () => -23_800,
  });
  assert.equal(surfaceUnderCamera(sampled.viewer).via, 'above');
  assert.ok(!sampled.asked.some(([name]) => name === 'sampleHeight'));
});

/** A pick result on a Google tile of a geometric error, as Cesium gives it. */
const onTile = (position, geometricError) => ({
  position,
  object: {
    content: { tile: { geometricError } },
    primitive: { isCesium3DTileset: true, maximumScreenSpaceError: 16 },
  },
});

const BALTIMORE = { lat: 39.321451, lon: -76.629219 };

test('Baltimore: a coarse tile streaming in is not the ground; the leaves are (2026-10-27)', () => {
  // The camera at 80 m; the coarse ancestor's chord bulges to +535 m, so
  // the ray down from the camera meets nothing and the ray from above meets
  // the coarse tile. AGL read -455.5 m from it.
  const where = { ...BALTIMORE, cameraHeightM: 80 };
  const coarse = fakeViewer({
    ...where,
    rayAbove: () => onTile(at(535, where.lat, where.lon), 1100),
  });
  const surface = surfaceUnderCamera(coarse.viewer);
  assert.ok(Number.isNaN(surface.heightM), `not ${surface.heightM}`);
  // The leaves arrive: the ray down meets a 1.2 m tile at 25.4 m.
  const fine = fakeViewer({
    ...where,
    rayDown: () => onTile(at(25.4, where.lat, where.lon), 1.2),
    rayAbove: () => onTile(at(535, where.lat, where.lon), 1100),
  });
  const leaves = surfaceUnderCamera(fine.viewer);
  assert.equal(leaves.via, 'down');
  assert.ok(Math.abs(leaves.heightM - 25.4) < 0.01);
  // The diagnostics say which tile each way met.
  const report = viewDiagnostics(coarse.viewer);
  assert.equal(report.surface.aboveTileErrorM, 1100);
  assert.equal(report.surface.aboveTrusted, false);
  assert.ok(Math.abs(report.surface.aboveHeightM - 535) < 0.01);
});

test('Baltimore: the centre is not measured on a coarse tile', () => {
  const where = { ...BALTIMORE, cameraHeightM: 80 };
  const coarse = fakeViewer({
    ...where,
    rayCentre: (ray) =>
      onTile(Cesium.Ray.getPoint(ray, 40, new Cesium.Cartesian3()), 1100),
  });
  assert.equal(centreDistanceM(coarse.viewer).via, 'height');
  const fine = fakeViewer({
    ...where,
    rayCentre: (ray) =>
      onTile(Cesium.Ray.getPoint(ray, 1915, new Cesium.Cartesian3()), 1.2),
  });
  const centre = centreDistanceM(fine.viewer);
  assert.equal(centre.via, 'ray');
  assert.ok(Math.abs(centre.distanceM - 1915) < 0.01);
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

test('a surface sample stands only near the camera, at about its height, and fresh', () => {
  const sample = { lat: 39.29, lon: -76.61, cameraM: 63, heightM: 61, at: 0 };
  const view = { lat: 39.29, lon: -76.61, heightM: 63 };
  assert.equal(surfaceSampleStands(sample, view, 500), true);
  // Height: within SURFACE_RISE_M either way.
  assert.equal(
    surfaceSampleStands(sample, { ...view, heightM: 63 + SURFACE_RISE_M }, 0),
    true,
  );
  assert.equal(surfaceSampleStands(sample, { ...view, heightM: 66 }, 0), false);
  assert.equal(surfaceSampleStands(sample, { ...view, heightM: 52 }, 0), false);
  // The C move of worker1's sweep: the camera up at 171 m over the roof.
  assert.equal(
    surfaceSampleStands(sample, { ...view, heightM: 171 }, 100),
    false,
  );
  // Age.
  assert.equal(surfaceSampleStands(sample, view, SURFACE_FRESH_MS - 1), true);
  assert.equal(surfaceSampleStands(sample, view, SURFACE_FRESH_MS), false);
  // Across: ~20 m north stands, ~30 m does not.
  const north = (m) => ({ ...view, lat: view.lat + m / 111_195 });
  assert.equal(surfaceSampleStands(sample, north(20), 0), true);
  assert.equal(
    surfaceSampleStands(sample, north(SURFACE_NEAR_M + 5), 0),
    false,
  );
  // ~20 m east at this latitude stands too (the longitude scaled).
  const east = { ...view, lon: view.lon + 20 / (111_195 * Math.cos(0.6858)) };
  assert.equal(surfaceSampleStands(sample, east, 0), true);
  // No sample, a missed one, no view.
  assert.equal(surfaceSampleStands(null, view, 0), false);
  assert.equal(
    surfaceSampleStands({ ...sample, heightM: Number.NaN }, view, 0),
    false,
  );
  assert.equal(
    surfaceSampleStands({ ...sample, heightM: -23_800 }, view, 0),
    false,
  );
  assert.equal(surfaceSampleStands(sample, null, 0), false);
  assert.equal(
    surfaceSampleStands({ ...sample, cameraM: undefined }, view, 0),
    false,
    'a sample without its camera height is sampled again',
  );
});
