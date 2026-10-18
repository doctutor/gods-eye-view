// Personal fork: the Grid layer (graticule and Tissot's indicatrix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  GRID_STEPS_DEG,
  MAX_CIRCLES,
  MAX_LINES,
  MAX_LINES_PER_AXIS,
  MIN_LINES,
  POLAR_CIRCLE_LAT,
  TROPIC_LAT,
  geodesicCircle,
  geodesicDestination,
  gridLines,
  gridViewMoved,
  labelPlacements,
  labelText,
  normalizeLon,
  stepForHeight,
  tissotCircles,
  viewHalfDegrees,
} from './model.js';
import {
  DEFAULT_OPACITY,
  MODE_STORAGE_KEY,
  OPACITY_STORAGE_KEY,
  createGridLayer,
  readGridMode,
  readGridOpacity,
} from './index.js';
import { rowControls, spacingText } from './presentation.js';
import { formatDms } from '../../ui/dms.js';
import { normalizeOverlayEntry } from '../../overlays/worldOverlay.js';

test('the spacing keeps 4 to 12 lines across the view from orbit to the street', () => {
  for (const height of [20e6, 8e6, 3e6, 1e6, 300e3, 100e3, 30e3, 10e3]) {
    const lines = (2 * viewHalfDegrees(height)) / stepForHeight(height);
    assert.ok(
      lines >= MIN_LINES && lines <= MAX_LINES,
      `${height} m: ${lines.toFixed(1)} lines`,
    );
  }
  assert.equal(stepForHeight(20e6), 30);
  assert.equal(stepForHeight(1e6), 2);
  assert.equal(stepForHeight(300e3), 1);
  assert.equal(stepForHeight(100e3), 1 / 6, "10'");
  assert.equal(stepForHeight(10e3), 1 / 60, "1'");
  assert.equal(stepForHeight(500), 1 / 60, 'never finer than a minute');
  assert.equal(GRID_STEPS_DEG.length, 9);
});

test('only the lines around the view are made, with the equator, tropics, circles and prime meridian marked', () => {
  const baltimore = gridLines({ lat: 39.29, lon: -76.61, heightM: 60_000 });
  assert.equal(baltimore.latStep, 1 / 6);
  assert.ok(baltimore.parallels.length <= MAX_LINES_PER_AXIS);
  assert.ok(baltimore.meridians.length <= MAX_LINES_PER_AXIS);
  assert.ok(baltimore.window.west > -80 && baltimore.window.east < -73);
  assert.ok(baltimore.parallels.every((p) => p.kind === 'grid'));
  const world = gridLines({ lat: 0, lon: 0, heightM: 20e6 });
  assert.deepEqual(world.window, {
    south: -85,
    north: 85,
    west: -180,
    east: 180,
  });
  const kinds = (list, key) =>
    list
      .filter((l) => l.kind !== 'grid')
      .map((l) => `${l.kind}:${+l[key].toFixed(4)}`);
  assert.deepEqual(kinds(world.parallels, 'lat'), [
    `polar-circle:${-POLAR_CIRCLE_LAT}`,
    `tropic:${-TROPIC_LAT}`,
    'equator:0',
    `tropic:${TROPIC_LAT}`,
    `polar-circle:${POLAR_CIRCLE_LAT}`,
  ]);
  assert.deepEqual(kinds(world.meridians, 'lon'), ['prime-meridian:0']);
  assert.equal(world.meridians.length, 12, 'the whole circle at 30°, once');
});

test('across the antimeridian and near a pole the window stays bounded', () => {
  const fiji = gridLines({ lat: -17, lon: 179.5, heightM: 400_000 });
  assert.ok(fiji.window.west < 180 && fiji.window.east > 180, 'unwrapped');
  assert.ok(
    fiji.meridians.some((m) => m.lon > 180),
    'past 180 in the window',
  );
  assert.ok(fiji.meridians.every((m) => m.kind === 'grid'));
  const labels = labelPlacements(fiji, {
    lat: -17,
    lon: 179.5,
    heightM: 400_000,
  })
    .filter((l) => l.axis === 'lon')
    .map((l) => l.text);
  assert.ok(labels.includes('180°'));
  assert.ok(labels.includes('179°W'));
  assert.ok(labels.includes('178°E'));
  const arctic = gridLines({ lat: 84, lon: 20, heightM: 500_000 });
  assert.equal(arctic.window.north, 85, 'parallels stop short of the pole');
  assert.ok(arctic.meridians.length <= MAX_LINES_PER_AXIS);
  assert.ok(
    arctic.lonStep > arctic.latStep,
    'meridians thin out near the pole',
  );
  assert.equal(normalizeLon(190), -170);
  assert.equal(normalizeLon(180), 180);
  assert.equal(normalizeLon(-540), -180);
});

test('labels use the HUD’s notation, at each line near the view’s west and south edges', () => {
  assert.equal(labelText(38, 'lat', 1), '38°N');
  assert.equal(labelText(-38.5, 'lat', 0.5), "38°30'S");
  assert.equal(labelText(-76 - 1 / 6, 'lon', 1 / 6), "76°10'W");
  assert.equal(labelText(0, 'lat', 10), '0°');
  assert.equal(labelText(-180, 'lon', 30), '180°');
  assert.equal(labelText(59.99999, 'lat', 1 / 60), "60°00'N", 'never 59°60');
  // The HUD's own readout is unchanged (src/hud.js now calls formatDms).
  assert.equal(formatDms(38.88975, 'lat'), `38°53'23.10"N`);
  assert.equal(formatDms(-76.61234, 'lon'), `076°36'44.42"W`);
  const view = { lat: 39.29, lon: -76.61, heightM: 60_000 };
  const placements = labelPlacements(gridLines(view), view);
  const lat = placements.filter((p) => p.axis === 'lat');
  const lon = placements.filter((p) => p.axis === 'lon');
  assert.ok(lat.length >= MIN_LINES && lat.length <= MAX_LINES);
  assert.ok(
    lat.every((p) => p.lon < view.lon),
    'west of the centre',
  );
  assert.ok(
    lon.every((p) => p.lat < view.lat),
    'south of the centre',
  );
  assert.equal(lat.find((p) => Math.abs(p.lat - 39.5) < 1e-9).text, "39°30'N");
});

test('a settled view is rebuilt once it leaves its lines or changes spacing', () => {
  const made = { lat: 39.29, lon: -76.61, heightM: 60_000 };
  assert.equal(gridViewMoved(null, made), true);
  assert.equal(gridViewMoved(made, { ...made, lon: -76.3 }), false);
  assert.equal(gridViewMoved(made, { ...made, lat: 40.0 }), true);
  assert.equal(gridViewMoved(made, { ...made, heightM: 400_000 }), true);
});

test('indicatrix circles are true circles on the ellipsoid, one radius, at the crossings', () => {
  const geodesic = new Cesium.EllipsoidGeodesic();
  for (const [lat, lon, radius] of [
    [39.29, -76.61, 5_000],
    [0, 179.9, 100_000],
    [84, 20, 30_000],
    [-60, -179.99, 50_000],
  ]) {
    const points = geodesicCircle(lat, lon, radius, 48);
    assert.equal(points.length, 49, 'closed');
    assert.deepEqual(points[0], points[48]);
    for (const point of points) {
      geodesic.setEndPoints(
        Cesium.Cartographic.fromDegrees(lon, lat),
        Cesium.Cartographic.fromDegrees(point.lon, point.lat),
      );
      assert.ok(Math.abs(geodesic.surfaceDistance - radius) / radius < 1e-8);
    }
    // Across the antimeridian the ring stays continuous (unwrapped longitudes).
    const lons = points.map((p) => p.lon);
    for (let i = 1; i < lons.length; i++)
      assert.ok(Math.abs(lons[i] - lons[i - 1]) < 10);
  }
  const north = geodesicDestination(0, 0, 0, 111_319.49);
  assert.ok(
    Math.abs(north.lat - 1.0067) < 0.0005,
    'a degree of latitude is a little over 110.6 km',
  );
  const view = { lat: 39.29, lon: -76.61, heightM: 60_000 };
  const lines = gridLines(view);
  const { radiusM, circles } = tissotCircles(lines, view);
  assert.ok(Math.abs(radiusM - 111_320 / 6 / 3) < 1e-6, "a third of 10'");
  assert.equal(circles.length, MAX_CIRCLES, 'capped');
  assert.ok(
    Math.hypot(circles[0].lat - view.lat, circles[0].lon - view.lon) <
      Math.hypot(circles.at(-1).lat - view.lat, circles.at(-1).lon - view.lon),
    'nearest the view first',
  );
  // Near a pole: no circle reaches it.
  const arctic = { lat: 84, lon: 20, heightM: 500_000 };
  const polar = tissotCircles(gridLines(arctic), arctic);
  assert.ok(
    polar.circles.every((c) => Math.abs(c.lat) + polar.radiusM / 111_320 <= 89),
  );
  assert.ok(polar.circles.length > 0);
});

test('the row offers the graticule, Tissot and a disabled MGRS', () => {
  let chosen = null;
  const controls = rowControls({
    mode: 'tissot',
    onMode: (mode) => (chosen = mode),
    opacity: 0.6,
    onOpacity: () => {},
    step: 1 / 6,
  });
  assert.deepEqual(
    controls.chips.map((chip) => [
      chip.id,
      chip.active,
      Boolean(chip.disabled),
    ]),
    [
      ['latlon', false, false],
      ['tissot', true, false],
      ['mgrs', false, true],
    ],
  );
  assert.equal(controls.chips[2].label, 'MGRS · SOON');
  controls.chips[0].onClick();
  assert.equal(chosen, 'latlon');
  assert.equal(controls.slider.value, 60);
  assert.match(controls.info, /^Lines every 10' · Equal circles/);
  assert.equal(spacingText(30), 'Lines every 30°');
  assert.equal(spacingText(1 / 60), "Lines every 1'");
  assert.match(
    rowControls({ opacity: 1, onOpacity: () => {}, step: 1, groundless: true })
      .info,
    /Drawn at sea level/,
  );
});

/** A scene with the collections the Grid uses, and a settable camera. */
function fakeViewer({ depthTexture = true } = {}) {
  const collection = () => {
    const items = [];
    return {
      items,
      add: (item) => (items.push(item), item),
      remove: (item) => {
        const i = items.indexOf(item);
        if (i >= 0) items.splice(i, 1);
        return i >= 0;
      },
    };
  };
  const listeners = [];
  let lat = 39.29;
  let lon = -76.61;
  let height = 60_000;
  const scene = {
    groundPrimitives: collection(),
    primitives: collection(),
    frameState: { context: { depthTexture } },
  };
  return {
    scene,
    move: (next) => {
      ({ lat = lat, lon = lon, height = height } = next);
      listeners.forEach((fn) => fn());
    },
    listeners,
    viewer: {
      scene,
      camera: {
        get positionCartographic() {
          return Cesium.Cartographic.fromDegrees(lon, lat, height);
        },
        moveEnd: {
          addEventListener(fn) {
            listeners.push(fn);
            return () => listeners.splice(listeners.indexOf(fn), 1);
          },
        },
      },
    },
  };
}

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

const instancesOf = (primitive) => primitive.geometryInstances || [];

/**
 * Cesium with its scene primitives recorded instead of built: their
 * constructors need a WebGL context, which Node has none of. Geometry,
 * colours and every option passed stay Cesium's own.
 */
class GroundPrimitive {
  constructor(options) {
    Object.assign(this, options);
  }
  static isSupported(scene) {
    return scene.frameState.context.depthTexture === true;
  }
}
class FlatPrimitive {
  constructor(options) {
    Object.assign(this, options);
  }
}
const cesium = {
  ...Cesium,
  GroundPolylinePrimitive: GroundPrimitive,
  Primitive: FlatPrimitive,
};

/** The world-overlay host's interface (src/app/layers/overlayHost.js), recorded. */
function fakeOverlayHost() {
  const sources = new Map();
  const visible = new Map();
  return {
    sources,
    visible,
    setEntries: (id, entries) => sources.set(id, entries),
    clearSource: (id) => sources.delete(id),
    setVisible: (id, on) => visible.set(id, on),
  };
}

test('the grid drapes ground lines, labels them through the overlay host, follows the camera, and keeps opacity and mode', () => {
  const fake = fakeViewer();
  const storage = memoryStorage({ [OPACITY_STORAGE_KEY]: '0.5' });
  const renders = [];
  const overlayHost = fakeOverlayHost();
  const layer = createGridLayer({
    cesium,
    storage,
    overlayHost,
    requestRender: (r) => renders.push(r),
  });
  assert.equal(layer.id, 'grid');
  layer.init(fake.viewer);
  assert.equal(fake.scene.groundPrimitives.items.length, 0, 'off by default');
  layer.enable(fake.viewer);
  const [lines] = fake.scene.groundPrimitives.items;
  assert.ok(lines instanceof GroundPrimitive);
  assert.ok(
    instancesOf(lines)[0].geometry instanceof Cesium.GroundPolylineGeometry,
  );
  assert.equal(
    lines.asynchronous,
    true,
    'made in a worker; loads terrain heights first',
  );
  assert.equal(
    lines.classificationType,
    Cesium.ClassificationType.BOTH,
    'terrain and 3D Tiles',
  );
  const state = layer._state();
  assert.equal(
    instancesOf(lines).length,
    state.lines.parallels.length + state.lines.meridians.length,
  );
  // Labels: world-overlay entries, never Cesium labels.
  assert.equal(overlayHost.visible.get('grid'), true);
  const labels = overlayHost.sources.get('grid');
  assert.ok(labels.length > 0);
  assert.equal(fake.scene.primitives.items.length, 0, 'no Cesium labels');
  for (const entry of labels) {
    assert.equal(entry.variant, 'label');
    assert.equal(entry.interactive, false);
    assert.ok(entry.position instanceof Cesium.Cartesian3);
    assert.doesNotThrow(() => normalizeOverlayEntry('grid', entry));
    assert.match(entry.title, /^\d+°(\d+')?[NSEW]?$/);
  }
  assert.equal(new Set(labels.map((e) => e.id)).size, labels.length);
  assert.equal(state.opacity, 0.5);
  const alpha = instancesOf(lines)[0].attributes.color.value[3] / 255;
  assert.ok(Math.abs(alpha - 0.55 * 0.5) < 0.01, 'the stored opacity');
  assert.ok(renders.includes('grid-rebuild'));
  // A small move keeps the lines; a long one rebuilds them.
  fake.move({ lon: -76.5 });
  assert.equal(fake.scene.groundPrimitives.items[0], lines);
  fake.move({ lat: 41.5 });
  assert.notEqual(fake.scene.groundPrimitives.items[0], lines);
  assert.equal(
    fake.scene.groundPrimitives.items.length,
    1,
    'the old ones went',
  );
  // Opacity: kept in the browser and redrawn.
  layer.getRowControls().slider.onInput(80);
  assert.equal(storage.map.get(OPACITY_STORAGE_KEY), '0.8');
  const brighter = instancesOf(fake.scene.groundPrimitives.items[0])[0];
  assert.ok(
    Math.abs(brighter.attributes.color.value[3] / 255 - 0.55 * 0.8) < 0.01,
  );
  // Tissot: the circles join the lines, and the choice is kept.
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'tissot')
    .onClick();
  assert.equal(storage.map.get(MODE_STORAGE_KEY), 'tissot');
  const withCircles = layer._state();
  assert.equal(withCircles.mode, 'tissot');
  assert.equal(withCircles.circles.circles.length, MAX_CIRCLES);
  assert.equal(
    instancesOf(fake.scene.groundPrimitives.items[0]).length,
    withCircles.lines.parallels.length +
      withCircles.lines.meridians.length +
      MAX_CIRCLES,
  );
  assert.equal(readGridMode(storage), 'tissot');
  assert.equal(
    readGridMode(memoryStorage({ [MODE_STORAGE_KEY]: 'mgrs' })),
    'latlon',
  );
  layer
    .getRowControls()
    .chips.find((c) => c.id === 'latlon')
    .onClick();
  assert.equal(layer._state().circles, null);
  // Off: nothing left in the scene, and no camera listener.
  layer.disable();
  assert.equal(fake.scene.groundPrimitives.items.length, 0);
  assert.equal(fake.scene.primitives.items.length, 0);
  assert.equal(fake.listeners.length, 0);
  assert.equal(overlayHost.sources.has('grid'), false, 'labels cleared');
  assert.equal(overlayHost.visible.get('grid'), false);
  layer.destroy();
});

test('without depth textures the grid is drawn at sea level and says so', () => {
  const fake = fakeViewer({ depthTexture: false });
  const overlayHost = fakeOverlayHost();
  const layer = createGridLayer({
    cesium,
    storage: memoryStorage(),
    overlayHost,
  });
  layer.init(fake.viewer);
  layer.enable(fake.viewer);
  assert.equal(fake.scene.groundPrimitives.items.length, 0);
  assert.ok(
    fake.scene.primitives.items.some((p) => p instanceof FlatPrimitive),
  );
  const flat = fake.scene.primitives.items.find(
    (p) => p instanceof FlatPrimitive,
  );
  assert.ok(instancesOf(flat)[0].geometry instanceof Cesium.PolylineGeometry);
  assert.ok(overlayHost.sources.get('grid').length > 0, 'labels still drawn');
  assert.match(layer.getRowControls().info, /Drawn at sea level/);
  assert.equal(
    readGridOpacity({
      getItem: () => {
        throw new Error('no');
      },
    }),
    DEFAULT_OPACITY,
  );
  layer.destroy();
});
