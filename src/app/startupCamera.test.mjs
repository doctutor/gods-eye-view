import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CAMERA_PRESETS, DEFAULT_VIEW, flyToDefault } from '../camera.js';

const camera = (calls) => ({
  isDestroyed: () => false,
  camera: {
    setView(options) {
      calls.setView.push(options);
    },
    flyTo(options) {
      calls.flyTo.push(options);
    },
    cancelFlight() {
      calls.cancelled++;
    },
  },
});
const degrees = (cartesian) => {
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lon: Number(Cesium.Math.toDegrees(c.longitude).toFixed(4)),
    lat: Number(Cesium.Math.toDegrees(c.latitude).toFixed(4)),
    height: Math.round(c.height),
  };
};

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = { setView: [], flyTo: [], cancelled: 0 };
  const stop = flyToDefault(camera(calls));
  stop();
  t.mock.timers.tick(1000);
  assert.equal(calls.flyTo.length, 0);
  assert.equal(calls.cancelled, 1);
});

test("the opening view: straight down over Baltimore's Inner Harbor, then across the harbour to downtown", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = { setView: [], flyTo: [], cancelled: 0 };
  flyToDefault(camera(calls));
  assert.deepEqual(degrees(calls.setView[0].destination), {
    lon: -76.6131,
    lat: 39.2858,
    height: 25000,
  });
  assert.equal(calls.setView[0].orientation.pitch, Cesium.Math.toRadians(-90));
  t.mock.timers.tick(500);
  const flight = calls.flyTo[0];
  assert.deepEqual(degrees(flight.destination), {
    lon: -76.6085,
    lat: 39.2735,
    height: 450,
  });
  assert.equal(flight.orientation.heading, Cesium.Math.toRadians(345));
  assert.equal(flight.orientation.pitch, Cesium.Math.toRadians(-25));
  // The view's middle lands on the harbour basin, about a kilometre ahead.
  const ahead =
    DEFAULT_VIEW.camera.height /
    Math.tan((-DEFAULT_VIEW.pitch * Math.PI) / 180);
  const lat =
    DEFAULT_VIEW.camera.lat +
    (ahead * Math.cos((DEFAULT_VIEW.heading * Math.PI) / 180)) / 110_574;
  const lon =
    DEFAULT_VIEW.camera.lon +
    (ahead * Math.sin((DEFAULT_VIEW.heading * Math.PI) / 180)) /
      (111_320 * Math.cos((DEFAULT_VIEW.camera.lat * Math.PI) / 180));
  assert.ok(lat > 39.28 && lat < 39.288, String(lat));
  assert.ok(lon > -76.615 && lon < -76.608, String(lon));
  // The preset is the same view; Austin's stays.
  assert.deepEqual(
    degrees(CAMERA_PRESETS.baltimore.destination),
    degrees(flight.destination),
  );
  assert.ok(CAMERA_PRESETS.austin);
});
