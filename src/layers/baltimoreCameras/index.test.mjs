// Personal fork: a Baltimore camera layer through a load where one ArcGIS
// layer is down, and one where all are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { BALTIMORE_CAMERA_SETS, createBaltimoreCameraLayer } from './index.js';

const overlayHost = {
  setVisible() {},
  clearSource() {},
  setEntries() {},
};

function viewer() {
  return {
    dataSources: { add() {}, remove() {} },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(-76.6, 39.3, 5e5),
      moveEnd: { addEventListener: () => () => {} },
      pickEllipsoid: () => undefined,
    },
    scene: { canvas: { clientWidth: 800, clientHeight: 600 } },
  };
}

const camera = (id) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-76.5734, 39.3219] },
  properties: { GIS_ID: id, CamType: 'Red Light Camera', Location: `C${id}` },
});

test('a layer down leaves the others on the map, and the status says so', async () => {
  const portable = BALTIMORE_CAMERA_SETS.enforcement.urls[2];
  const layer = createBaltimoreCameraLayer({
    setKey: 'enforcement',
    overlayHost,
    fetchImpl: async (url) =>
      url.startsWith(portable)
        ? new Response('down', { status: 404 })
        : Response.json({ features: [camera(url.length)] }),
  });
  const v = viewer();
  layer.init(v);
  layer.enable(v);
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.ok(stats.count >= 1);
  assert.equal(
    stats.error,
    '3 of 4 sets loaded; portable speed cameras unavailable',
  );
  layer.destroy(v);
});

test('every layer down: the load fails cleanly', async () => {
  const layer = createBaltimoreCameraLayer({
    setKey: 'citiwatch',
    overlayHost,
    fetchImpl: async () => new Response('gone', { status: 404 }),
  });
  const v = viewer();
  layer.init(v);
  layer.enable(v);
  assert.equal(await layer.update(), false);
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.match(stats.error, /404/);
  layer.destroy(v);
});
