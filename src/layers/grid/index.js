import * as Cesium from 'cesium';
import {
  MAX_LAT,
  geodesicCircle,
  gridLines,
  gridViewMoved,
  labelPlacements,
  stepForHeight,
  tissotCircles,
} from './model.js';
import {
  mgrsLabelPlacements,
  mgrsLevelChanged,
  mgrsLines,
  viewReference,
} from './mgrs.js';
import { MGRS_NORTH, MGRS_SOUTH } from './utm.js';
import { rowControls } from './presentation.js';
import { activeLuminance, readInkSetting, resolveInk } from '../../maps/ink.js';

/**
 * Personal fork: the Grid layer (REFERENCE in the DATA LAYERS panel), a
 * latitude–longitude graticule clamped to the ground, so it lies on terrain
 * and on the photoreal 3D tiles alike. The lines around the view are one
 * GroundPolylinePrimitive (classificationType BOTH: terrain and 3D Tiles),
 * the tropics and polar circles a dashed second one. The labels go through
 * the app's world-overlay host (all world text does; src/noCesiumLabels.test.mjs),
 * as screen-space labels at the lines' crossings near the view's edges, in
 * the overlay's mono font and the HUD's colours. It
 * is rebuilt only when the camera settles somewhere the current lines no
 * longer cover; nothing runs per frame.
 *
 * Modes: 'latlon' (the graticule) and 'tissot' (Tissot's indicatrix: the
 * graticule faint, and at each of its intersections a circle of the same
 * real radius on the ellipsoid, a third of the spacing, so the view's
 * foreshortening shows as unequal ellipses), and 'mgrs' (the Military Grid
 * Reference System, src/layers/grid/mgrs.js: grid-zone boundaries in amber,
 * then 100 km squares, 10 km and 1 km lines traced in each zone's UTM grid,
 * in place of the graticule).
 *
 * Ink: on a dark basemap the lines are the HUD's cyan and amber; on a light
 * one (the white globe, Positron, the light Stamen and Countries styles)
 * they are a dark blue-grey and a brown, and the labels follow
 * (src/maps/ink.js). AUTO follows the active basemap's luminance through
 * the map stack controller; LIGHT and DARK force one (kept as
 * gev.grid.ink).
 *
 * Draping needs depth textures (GroundPolylinePrimitive.isSupported): on a
 * display without them the lines are drawn at sea level and the row says
 * so. Ground primitives are made asynchronously, which loads Cesium's
 * approximate terrain heights the first time.
 */

export const GRID_LAYER_ID = 'grid';
export const OPACITY_STORAGE_KEY = 'gev.grid.opacity';
export const MODE_STORAGE_KEY = 'gev.grid.mode';
export const INK_STORAGE_KEY = 'gev.grid.ink';
export const GRID_MODES = Object.freeze(['latlon', 'tissot', 'mgrs']);
export const DEFAULT_OPACITY = 0.6;
/**
 * The lines' colours per ink: the HUD's cyan and amber
 * (src/ui/styles/overlays.css: --hud-color) for a dark basemap; a dark
 * blue-grey and a brown that read on a light one.
 */
export const INK_COLORS = Object.freeze({
  light: Object.freeze({ primary: '#00ffff', accent: '#ffd166' }),
  dark: Object.freeze({ primary: '#2f4f6f', accent: '#8a5a00' }),
});

/** The opacity stored in this browser, else the default. */
export function readGridOpacity(storage) {
  try {
    const raw = storage?.getItem(OPACITY_STORAGE_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : DEFAULT_OPACITY;
  } catch {
    return DEFAULT_OPACITY;
  }
}

/** The mode stored in this browser, else the graticule. */
export function readGridMode(storage) {
  try {
    const value = storage?.getItem(MODE_STORAGE_KEY);
    return GRID_MODES.includes(value) ? value : 'latlon';
  } catch {
    return 'latlon';
  }
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A line's look by kind and ink: the equator and prime meridian stand out. */
export function lineStyle(kind, ink = 'light') {
  const { primary, accent } = INK_COLORS[ink] || INK_COLORS.light;
  switch (kind) {
    case 'equator':
    case 'prime-meridian':
      return { color: accent, alpha: 0.9, width: 2.5 };
    case 'tissot':
      return { color: primary, alpha: 0.85, width: 1.5, circle: true };
    case 'gzd':
      return { color: accent, alpha: 0.8, width: 2 };
    case 'mgrs-100k':
      return { color: primary, alpha: 0.75, width: 1.5 };
    case 'tropic':
    case 'polar-circle':
      return { color: accent, alpha: 0.7, width: 1.5, dashed: true };
    default:
      return { color: primary, alpha: 0.55, width: 1 };
  }
}

/** The points of a parallel across the window (rhumb segments of ≤ 1°). */
function parallelDegrees(lat, west, east) {
  const out = [];
  const pieces = Math.max(2, Math.ceil(east - west));
  for (let i = 0; i <= pieces; i++)
    out.push(west + ((east - west) * i) / pieces, lat);
  return out;
}

/**
 * @param {{cesium?: object, requestRender?: (reason: string) => void,
 *   storage?: Storage|null, overlayHost?: object}} [options] - `overlayHost`
 *   (src/app/layers/overlayHost.js) draws the labels; without one there are
 *   none.
 */
export function createGridLayer({
  cesium = Cesium,
  requestRender = () => {},
  storage,
  overlayHost = null,
} = {}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _opacity = readGridOpacity(store);
  let _mode = readGridMode(store);
  let _inkSetting = readInkSetting(store, INK_STORAGE_KEY);
  /** The map stack controller, for the basemap's luminance. */
  let _controller = null;
  let _unsubscribeMap = null;
  /** The ink the current lines were drawn in. */
  let _inkDrawn = 'light';
  let _circles = null;
  let _lines = null;
  let _mgrs = null;
  let _primitives = [];
  let _madeFor = null;
  let _removeMoveListener = null;
  let _rowListener = null;
  let _groundless = false;
  const notify = () => {
    try {
      _rowListener?.();
    } catch {
      /* the panel's problem */
    }
  };

  function view() {
    const camera = _viewer?.camera;
    const canvas = _viewer?.scene?.canvas;
    let point = null;
    try {
      const centre =
        canvas && camera?.pickEllipsoid
          ? camera.pickEllipsoid(
              new cesium.Cartesian2(
                canvas.clientWidth / 2,
                canvas.clientHeight / 2,
              ),
            )
          : null;
      if (centre) point = cesium.Cartographic.fromCartesian(centre);
    } catch {
      /* no pick: under the camera */
    }
    point ||= camera?.positionCartographic || null;
    const degrees = (radians) =>
      Number.isFinite(radians) ? cesium.Math.toDegrees(radians) : 0;
    const height = camera?.positionCartographic?.height;
    return {
      lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, degrees(point?.latitude))),
      lon: degrees(point?.longitude),
      heightM: Number.isFinite(height) ? height : 20_000_000,
    };
  }

  function clear() {
    const scene = _viewer?.scene;
    for (const primitive of _primitives) {
      try {
        scene?.groundPrimitives?.remove(primitive);
        scene?.primitives?.remove(primitive);
      } catch {
        /* gone with the scene */
      }
    }
    _primitives = [];
  }

  /** The ink to draw: the forced one, else what the basemap wants. */
  function wantedInk() {
    return resolveInk(_inkSetting, activeLuminance(_controller));
  }

  /** The labels, as world-overlay entries at the crossings near the view's edges. */
  function labelEntries(now) {
    const { primary, accent } = INK_COLORS[_inkDrawn] || INK_COLORS.light;
    const placements = _mgrs
      ? mgrsLabelPlacements(_mgrs, now)
      : labelPlacements(_lines, now);
    const quiet = new Set(['grid', 'mgrs', 'mgrs-100k']);
    const seen = new Set();
    return placements
      .map((placement) => ({
        placement,
        id: placement.key ?? `${placement.axis}:${placement.text}`,
      }))
      .filter(({ id }) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map(({ placement, id }) => ({
        id,
        position: cesium.Cartesian3.fromDegrees(placement.lon, placement.lat),
        variant: 'label',
        title: placement.text,
        details: [],
        accent: quiet.has(placement.kind) ? primary : accent,
        priority: quiet.has(placement.kind) ? 0 : 10,
        collisionGroup: 'grid-label',
        interactive: false,
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 4,
        placement: 'above',
      }));
  }

  function color(style) {
    // Under the indicatrix the graticule is a faint reference.
    const faint = _mode === 'tissot' && !style.circle ? 0.45 : 1;
    return cesium.Color.fromCssColorString(style.color).withAlpha(
      style.alpha * _opacity * faint,
    );
  }

  function instance(degrees, style, arcType) {
    return new cesium.GeometryInstance({
      geometry: _groundless
        ? new cesium.PolylineGeometry({
            positions: cesium.Cartesian3.fromDegreesArray(degrees),
            width: style.width,
            arcType,
          })
        : new cesium.GroundPolylineGeometry({
            positions: cesium.Cartesian3.fromDegreesArray(degrees),
            width: style.width,
            arcType,
          }),
      attributes: {
        color: cesium.ColorGeometryInstanceAttribute.fromColor(color(style)),
      },
    });
  }

  function primitiveOf(instances, appearance) {
    if (_groundless)
      return new cesium.Primitive({
        geometryInstances: instances,
        appearance,
        asynchronous: true,
      });
    return new cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance,
      classificationType: cesium.ClassificationType.BOTH,
      asynchronous: true,
    });
  }

  /** Draw the lines and labels for the view, replacing the old ones. */
  function build(now) {
    clear();
    const scene = _viewer?.scene;
    if (!scene) return;
    _inkDrawn = wantedInk();
    try {
      _groundless = !cesium.GroundPolylinePrimitive.isSupported(scene);
    } catch {
      _groundless = true;
    }
    const solid = [];
    const dashed = [];
    if (_mode === 'mgrs') {
      _lines = null;
      _circles = null;
      _mgrs = mgrsLines(now);
      const flat = (points) => points.flatMap((p) => [p.lon, p.lat]);
      for (const boundary of _mgrs.boundaries) {
        const [from, to] = boundary.points;
        solid.push(
          boundary.axis === 'parallel'
            ? instance(
                parallelDegrees(from.lat, from.lon, to.lon),
                lineStyle('gzd', _inkDrawn),
                cesium.ArcType.RHUMB,
              )
            : instance(
                flat(boundary.points),
                lineStyle('gzd', _inkDrawn),
                cesium.ArcType.GEODESIC,
              ),
        );
      }
      for (const line of _mgrs.lines)
        solid.push(
          instance(
            flat(line.points),
            lineStyle(line.kind, _inkDrawn),
            cesium.ArcType.GEODESIC,
          ),
        );
    } else {
      _mgrs = null;
      _lines = gridLines(now);
    }
    const window = _lines?.window;
    for (const parallel of _lines?.parallels || []) {
      const style = lineStyle(parallel.kind, _inkDrawn);
      (style.dashed ? dashed : solid).push(
        instance(
          parallelDegrees(parallel.lat, window.west, window.east),
          style,
          cesium.ArcType.RHUMB,
        ),
      );
    }
    for (const meridian of _lines?.meridians || [])
      solid.push(
        instance(
          [meridian.lon, window.south, meridian.lon, window.north],
          lineStyle(meridian.kind, _inkDrawn),
          cesium.ArcType.GEODESIC,
        ),
      );
    _circles = _mode === 'tissot' ? tissotCircles(_lines, now) : null;
    for (const centre of _circles?.circles || []) {
      const degrees = [];
      for (const point of geodesicCircle(
        centre.lat,
        centre.lon,
        _circles.radiusM,
      ))
        degrees.push(point.lon, point.lat);
      solid.push(
        instance(
          degrees,
          lineStyle('tissot', _inkDrawn),
          cesium.ArcType.GEODESIC,
        ),
      );
    }
    const collection = _groundless ? scene.primitives : scene.groundPrimitives;
    if (solid.length)
      _primitives.push(
        collection.add(
          primitiveOf(solid, new cesium.PolylineColorAppearance()),
        ),
      );
    if (dashed.length) {
      const dash = lineStyle('tropic', _inkDrawn);
      _primitives.push(
        collection.add(
          primitiveOf(
            dashed,
            new cesium.PolylineMaterialAppearance({
              material: cesium.Material.fromType('PolylineDash', {
                color: color(dash),
                dashLength: 16,
              }),
            }),
          ),
        ),
      );
    }
    try {
      overlayHost?.setEntries(GRID_LAYER_ID, labelEntries(now), {
        moving: false,
      });
    } catch (error) {
      console.warn('[Grid] labels not drawn:', error?.message);
    }
    _madeFor = now;
    requestRender('grid-rebuild');
    notify();
  }

  function onMoved() {
    if (!_enabled) return;
    const now = view();
    if (
      gridViewMoved(_madeFor, now) ||
      (_mode === 'mgrs' && mgrsLevelChanged(_madeFor, now))
    )
      build(now);
  }

  function setMode(mode) {
    if (!GRID_MODES.includes(mode) || mode === _mode) return;
    _mode = mode;
    try {
      store?.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled && _madeFor) build(_madeFor);
    else notify();
  }

  function setOpacity(value) {
    _opacity = Math.min(1, Math.max(0, Number(value) || 0));
    try {
      store?.setItem(OPACITY_STORAGE_KEY, String(_opacity));
    } catch {
      /* private mode: kept for this page only */
    }
    // Colours are baked into the instances: a rebuild of the same lines.
    if (_enabled && _madeFor) build(_madeFor);
    else notify();
  }

  function setInk(key) {
    if (!['auto', 'light', 'dark'].includes(key) || key === _inkSetting) return;
    _inkSetting = key;
    try {
      store?.setItem(INK_STORAGE_KEY, key);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled && _madeFor && wantedInk() !== _inkDrawn) build(_madeFor);
    else notify();
  }

  /** A settled map switch: the basemap, and so the ink AUTO wants, may have changed. */
  function onMapSettled() {
    if (_enabled && _madeFor && wantedInk() !== _inkDrawn) build(_madeFor);
  }

  return {
    id: GRID_LAYER_ID,
    name: 'Grid',
    icon: '#',
    source: 'Latitude and longitude',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      _enabled = true;
      overlayHost?.setVisible(GRID_LAYER_ID, true);
      if (_viewer?.camera?.moveEnd && !_removeMoveListener)
        _removeMoveListener = _viewer.camera.moveEnd.addEventListener(onMoved);
      build(view());
    },

    disable() {
      _enabled = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      clear();
      overlayHost?.clearSource(GRID_LAYER_ID);
      overlayHost?.setVisible(GRID_LAYER_ID, false);
      _madeFor = null;
      _lines = null;
      _mgrs = null;
      _circles = null;
      requestRender('grid-hide');
      notify();
    },

    async update() {
      // Nothing to fetch: the lines follow the camera, not the clock. A
      // `false` here would read as a rejected enable to the lifecycle.
      return _enabled;
    },

    destroy() {
      this.disable();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = null;
      _viewer = null;
      _rowListener = null;
    },

    /**
     * The map stack controller (src/app/data.js hands it to every layer):
     * the basemap's luminance, and every settled switch.
     * @param {object|null} controller
     */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = controller || null;
      const off = _controller?.subscribe?.(onMapSettled);
      _unsubscribeMap = typeof off === 'function' ? off : null;
      onMapSettled();
    },

    getStats() {
      const count = _mgrs
        ? _mgrs.boundaries.length + _mgrs.lines.length
        : _lines
          ? _lines.parallels.length + _lines.meridians.length
          : 0;
      return {
        count,
        countLabel: _enabled ? `${Math.round(_opacity * 100)}%` : '—',
      };
    },

    getRowControls() {
      return rowControls({
        mode: _mode,
        onMode: setMode,
        ink: _inkSetting,
        onInk: setInk,
        opacity: _opacity,
        onOpacity: setOpacity,
        step: _enabled
          ? (_lines?.latStep ?? stepForHeight(view().heightM))
          : null,
        groundless: _enabled && _groundless,
        mgrs:
          _enabled && _mgrs && _madeFor
            ? {
                level: _mgrs.level,
                reference: viewReference(_madeFor, _mgrs.level),
                polar: _madeFor.lat > MGRS_NORTH || _madeFor.lat < MGRS_SOUTH,
              }
            : null,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests: what is drawn. */
    _state: () => ({
      lines: _lines,
      mgrs: _mgrs,
      circles: _circles,
      mode: _mode,
      primitives: [..._primitives],
      opacity: _opacity,
      groundless: _groundless,
      ink: _inkDrawn,
      inkSetting: _inkSetting,
    }),
  };
}
