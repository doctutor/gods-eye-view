// Personal fork: the Custom cutouts clipping against a tileset stub: attach
// with inverse mode, one polygon a ring, outlines, re-apply, detach.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCutoutClipping } from './clipping.js';

function fakeCesium({ supported = true } = {}) {
  class ClippingPolygon {
    constructor({ positions }) {
      this.positions = positions;
    }
  }
  class ClippingPolygonCollection {
    constructor({ polygons, inverse }) {
      this.polygons = polygons;
      this.inverse = inverse;
    }
    static isSupported() {
      return supported;
    }
  }
  class PolylineCollection {
    constructor() {
      this.lines = [];
    }
    add(line) {
      this.lines.push(line);
    }
    get length() {
      return this.lines.length;
    }
  }
  return {
    ClippingPolygon,
    ClippingPolygonCollection,
    PolylineCollection,
    Cartesian3: { fromDegreesArray: (flat) => ({ flat }) },
    Color: class {
      constructor(...rgba) {
        this.rgba = rgba;
      }
    },
    Material: { fromType: (type, uniforms) => ({ type, uniforms }) },
  };
}

function fakeScene() {
  const primitives = [];
  return {
    globe: { isDestroyed: () => false },
    primitives: {
      list: primitives,
      add: (p) => primitives.push(p),
      remove: (p) => primitives.splice(primitives.indexOf(p), 1),
    },
  };
}

const square = (x) => [
  [x, 0],
  [x + 1, 0],
  [x + 1, 1],
  [x, 1],
];

test('the tileset keeps only the inside of every ring: inverse, one polygon a ring, outlined', () => {
  const clipping = createCutoutClipping({ cesium: fakeCesium() });
  const scene = fakeScene();
  const tileset = { isDestroyed: () => false };
  clipping.apply(scene, tileset, [square(0), square(5)], 'black');
  const collection = tileset.clippingPolygons;
  assert.equal(collection.inverse, true);
  assert.equal(collection.polygons.length, 2);
  // The plate is cut the other way: away inside the cutouts.
  assert.equal(scene.globe.clippingPolygons.inverse, false);
  assert.equal(scene.globe.clippingPolygons.polygons.length, 2);
  assert.notEqual(scene.globe.clippingPolygons, collection, 'one owner each');
  assert.deepEqual(
    collection.polygons[0].positions.flat,
    [0, 0, 1, 0, 1, 1, 0, 1],
  );
  assert.equal(scene.primitives.list.length, 1);
  const outline = scene.primitives.list[0];
  assert.equal(outline.length, 2);
  assert.deepEqual(
    outline.lines[0].positions.flat.slice(-2),
    [0, 0],
    'outlines close their ring',
  );
  assert.deepEqual(
    outline.lines[0].material.uniforms.color.rgba,
    [1, 1, 1, 0.85],
    'white on black',
  );
  assert.deepEqual(clipping.state(), {
    tileset,
    globe: scene.globe,
    polygons: 2,
    outlines: 2,
  });

  // The same again: untouched.
  clipping.apply(scene, tileset, [square(0), square(5)], 'black');
  assert.equal(tileset.clippingPolygons, collection);
  // A white plate: dark outlines.
  clipping.apply(scene, tileset, [square(0)], 'white');
  assert.notEqual(tileset.clippingPolygons, collection);
  assert.equal(scene.primitives.list.length, 1);
  assert.deepEqual(
    scene.primitives.list[0].lines[0].material.uniforms.color.rgba,
    [0, 0, 0, 0.85],
  );

  clipping.clear();
  assert.equal(
    tileset.clippingPolygons,
    undefined,
    'the tiles exactly as before',
  );
  assert.equal(scene.globe.clippingPolygons, undefined, 'and the globe');
  assert.equal(scene.primitives.list.length, 0);
  assert.deepEqual(clipping.state(), {
    tileset: null,
    globe: null,
    polygons: 0,
    outlines: 0,
  });
});

test('no rings, no tileset, a new tileset, or no WebGL2: nothing left clipped', () => {
  const scene = fakeScene();
  const one = { isDestroyed: () => false };
  const two = { isDestroyed: () => false };
  const clipping = createCutoutClipping({ cesium: fakeCesium() });
  clipping.apply(scene, one, [square(0)]);
  clipping.apply(scene, two, [square(0)]);
  assert.equal(one.clippingPolygons, undefined, 'the old tileset let go');
  assert.equal(two.clippingPolygons.polygons.length, 1);
  clipping.apply(scene, two, []);
  assert.equal(two.clippingPolygons, undefined);
  assert.equal(scene.primitives.list.length, 0);
  clipping.apply(scene, null, [square(0)]);
  assert.equal(scene.primitives.list.length, 0);

  const destroyed = { isDestroyed: () => true, clippingPolygons: 'kept' };
  clipping.apply(scene, destroyed, [square(0)]);
  // A destroyed tileset is never written to on the way out.
  destroyed.isDestroyed = () => true;
  clipping.clear();

  const old = createCutoutClipping({
    cesium: fakeCesium({ supported: false }),
  });
  assert.equal(old.supported(scene), false);
  const tileset = {};
  old.apply(scene, tileset, [square(0)]);
  assert.equal(
    tileset.clippingPolygons,
    undefined,
    'without WebGL2 the tiles stay whole',
  );
});

test('where the scene drapes lines, the outlines lie on the ground (the plate and the cut edge)', () => {
  const cesium = fakeCesium();
  cesium.GroundPolylinePrimitive = class {
    constructor({ geometryInstances, appearance }) {
      this.geometryInstances = geometryInstances;
      this.appearance = appearance;
    }
    static isSupported() {
      return true;
    }
  };
  cesium.GeometryInstance = class {
    constructor(options) {
      Object.assign(this, options);
    }
  };
  cesium.GroundPolylineGeometry = class {
    constructor(options) {
      Object.assign(this, options);
    }
  };
  cesium.ColorGeometryInstanceAttribute = { fromColor: (color) => ({ color }) };
  cesium.PolylineColorAppearance = class {};
  const clipping = createCutoutClipping({ cesium });
  const scene = fakeScene();
  clipping.apply(
    scene,
    { isDestroyed: () => false },
    [square(0), square(3)],
    'white',
  );
  const ground = scene.primitives.list[0];
  assert.ok(ground instanceof cesium.GroundPolylinePrimitive);
  assert.equal(ground.geometryInstances.length, 2);
  assert.equal(ground.geometryInstances[0].geometry.width, 2);
  assert.deepEqual(
    ground.geometryInstances[0].attributes.color.color.rgba,
    [0, 0, 0, 0.85],
  );
  assert.equal(clipping.state().outlines, 2);
});
