// Personal fork: the TREEMAP window's globe link (treemapGlobe.js): the
// service's outlines (area: MultiPolygons, box: continents) drawn as ground
// lines on hover, and the flight to a tile's extent on double-click.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTreemapGlobeLink,
  ringsOf,
  boundsOf,
  MAX_RINGS,
} from './treemapGlobe.js';
import { boxGeoJson } from '../data/treemapSources.js';

const square = (lon, lat, size, extra = 0) => {
  const ring = [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
  ];
  for (let k = 0; k < extra; k++)
    ring.push([lon, lat + size * (1 - k / extra)]);
  ring.push([lon, lat]);
  return ring;
};

test('rings: a MultiPolygon’s largest rings, at most MAX_RINGS of them', () => {
  const polygons = Array.from({ length: 900 }, (_, k) => [
    square(k % 180, 0, 0.1, k === 7 ? 50 : 0),
  ]);
  const rings = ringsOf({
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: polygons },
  });
  assert.equal(rings.length, MAX_RINGS);
  assert.equal(rings[0].length, 55, 'the largest first');
});

test('bounds: the narrow way round across the antimeridian (w > e), else plain', () => {
  const russia = {
    type: 'MultiPolygon',
    coordinates: [[square(27, 41, 150)], [square(-180, 64, 11)]],
  };
  assert.deepEqual(boundsOf(russia), [27, 41, -169, 191]);
  assert.deepEqual(
    boundsOf(boxGeoJson([25, -11, 180, 82])),
    [25, -11, 180, 82],
  );
  assert.equal(boundsOf({ type: 'FeatureCollection', features: [] }), null);
});

/** A stub of the Cesium parts the link uses, recording what it is given. */
function fakeCesium() {
  const made = [];
  class Thing {
    constructor(options) {
      this.options = options;
      made.push(this);
    }
  }
  return {
    made,
    GroundPolylinePrimitive: class extends Thing {
      static isSupported = () => true;
    },
    Primitive: Thing,
    GroundPolylineGeometry: Thing,
    PolylineGeometry: Thing,
    GeometryInstance: Thing,
    PolylineColorAppearance: Thing,
    ColorGeometryInstanceAttribute: { fromColor: (color) => color },
    Color: { fromCssColorString: () => ({ withAlpha: (a) => ({ a }) }) },
    Cartesian3: {
      fromDegreesArray: (flat) => flat,
      fromDegrees: (...args) => ({ point: args }),
    },
    Rectangle: { fromDegrees: (...args) => ({ rectangle: args }) },
    ArcType: { GEODESIC: 'geodesic', RHUMB: 'rhumb' },
    ClassificationType: { BOTH: 'both' },
  };
}

function fakeViewer() {
  const collection = () => {
    const items = new Set();
    return {
      items,
      add: (item) => (items.add(item), item),
      remove: (item) => items.delete(item),
    };
  };
  const flights = [];
  return {
    flights,
    scene: {
      groundPrimitives: collection(),
      primitives: collection(),
      requestRender() {},
    },
    camera: { flyTo: (options) => flights.push(options) },
  };
}

test('hover outlines the geo once it settles; leaving clears it; double-click flies', async () => {
  const cesium = fakeCesium();
  const viewer = fakeViewer();
  const asked = [];
  const timers = [];
  const link = createTreemapGlobeLink({
    viewer,
    cesium,
    source: {
      geo: async (ref) => {
        asked.push(ref);
        return ref === 'area:ru'
          ? {
              type: 'Feature',
              geometry: {
                type: 'MultiPolygon',
                coordinates: [[square(27, 41, 150)], [square(-180, 64, 11)]],
              },
            }
          : boxGeoJson([25, -11, 180, 82]);
      },
    },
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: (id) => (timers[id - 1] = null),
  });
  // Two quick hovers: only the last is asked.
  link.outline('box:25,-11,180,82');
  link.outline('area:ru');
  for (const fn of timers.splice(0)) fn?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ['area:ru']);
  assert.equal(link.shown(), 'area:ru');
  assert.equal(viewer.scene.groundPrimitives.items.size, 1);
  const instances = [...viewer.scene.groundPrimitives.items][0].options
    .geometryInstances;
  assert.equal(instances.length, 2);
  assert.equal(instances[0].options.geometry.options.arcType, 'rhumb');
  link.outline(null);
  assert.equal(viewer.scene.groundPrimitives.items.size, 0);
  assert.equal(link.shown(), null);
  // The flight: the narrow rectangle across the antimeridian (cached geo).
  assert.equal(await link.flyTo('area:ru'), true);
  assert.deepEqual(
    viewer.flights[0].destination.rectangle,
    [27, 41, -169, 191],
  );
  assert.deepEqual(asked, ['area:ru']);
  assert.equal(await link.flyTo(null), false);
  link.destroy();
});
