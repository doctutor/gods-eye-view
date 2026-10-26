import * as Cesium from 'cesium';

/**
 * Personal fork: where the app opens when there is no share link. Baltimore's
 * Inner Harbor: the fly-in starts straight down over the harbour, then the
 * camera settles over Federal Hill park looking north-northwest across the
 * harbour basin to downtown (the view's middle lands on the basin about a
 * kilometre ahead, the skyline beyond it).
 */
export const DEFAULT_VIEW = Object.freeze({
  /** The harbour: where the fly-in starts, straight down from `approachHeight`. */
  target: Object.freeze({ lon: -76.6131, lat: 39.2858 }),
  approachHeight: 25_000,
  /** Where the camera ends, and how it looks. */
  camera: Object.freeze({ lon: -76.6085, lat: 39.2735, height: 450 }),
  heading: 345,
  pitch: -25,
});

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  baltimore: {
    destination: Cesium.Cartesian3.fromDegrees(
      DEFAULT_VIEW.camera.lon,
      DEFAULT_VIEW.camera.lat,
      DEFAULT_VIEW.camera.height,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(DEFAULT_VIEW.heading),
      pitch: Cesium.Math.toRadians(DEFAULT_VIEW.pitch),
      roll: 0.0,
    },
  },
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * The opening view (DEFAULT_VIEW) with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToDefault(viewer, view = DEFAULT_VIEW) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      view.target.lon,
      view.target.lat,
      view.approachHeight,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        view.camera.lon,
        view.camera.lat,
        view.camera.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(view.heading),
        pitch: Cesium.Math.toRadians(view.pitch),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
