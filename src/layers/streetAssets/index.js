import * as Cesium from 'cesium';
import { activeLuminance, resolveInk } from '../../maps/ink.js';
import { attachPointRollup } from '../pointRollup/index.js';
import {
  OverpassViewError,
  createOverpassViewClient,
} from '../../sources/overpassView.js';
import {
  ASSET_KEYS,
  assetFeatures,
  assetModeForHeight,
  assetQueryBox,
  assetTypeOf,
  boxCovers,
  buildAssetQuery,
} from './assets.js';
import { rowControls } from './presentation.js';

/**
 * Personal fork: the Street assets layer (ANALYSIS in the DATA LAYERS
 * panel): the infrastructure Google Earth shows, from OpenStreetMap: EV
 * charging stations, bike lanes, fire hydrants, street lights and traffic
 * signals, one type at a time (a chip each, kept as gev.streetAssets.type).
 * Overpass answers for the view through the app's /api/overpass proxy
 * (which needs OVERPASS_UPSTREAMS; without it the row says so). Each type
 * draws pins (lines for bike lanes, in the ink) below its pin height, H3
 * counts of the same features up to its count height, and nothing above
 * (assets.js, "Level of detail"); the counts are the shared point rollup
 * (src/layers/pointRollup/), whose hexes fly the camera in on a click.
 * The pins are point primitives (no Cesium labels); the lines are clamped
 * to the ground and the 3D tiles. Rebuilt when the camera settles.
 */

export const STREET_ASSETS_LAYER_ID = 'street-assets';
export const TYPE_STORAGE_KEY = 'gev.streetAssets.type';
/** Wait this long after the camera settles before asking Overpass. */
export const ASSET_DEBOUNCE_MS = 400;
/** The lines' colour per ink. */
export const LINE_COLORS = Object.freeze({ light: '#ffffff', dark: '#1a1a1a' });

export const STREET_ASSETS_CREDIT = Object.freeze({
  key: 'street-assets',
  html: 'Street assets: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL)',
});

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The asset type stored in this browser, else charging stations. */
export function readAssetType(storage) {
  try {
    const value = storage?.getItem(TYPE_STORAGE_KEY);
    return ASSET_KEYS.includes(value) ? value : ASSET_KEYS[0];
  } catch {
    return ASSET_KEYS[0];
  }
}

/**
 * @param {{overlayHost?: object|null, cesium?: object,
 *   requestRender?: (reason: string) => void, credits?: {register?: Function},
 *   overpass?: {query: Function, abort: Function}, storage?: Storage|null,
 *   picking?: object|null, attachRollup?: typeof attachPointRollup,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} [options]
 */
export function createStreetAssetsLayer({
  overlayHost = null,
  cesium = Cesium,
  requestRender = () => {},
  credits = null,
  overpass = createOverpassViewClient(),
  storage,
  picking = null,
  attachRollup = attachPointRollup,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
} = {}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _asset = readAssetType(store);
  let _controller = null;
  let _unsubscribeMap = null;
  let _rowListener = null;
  let _removeMove = null;
  let _debounce = null;
  let _rollup = null;
  let _points = null;
  let _lines = null;
  /** What is held: {type, mode, box, features, saturated}. */
  let _held = null;
  /** {mode, state, count, saturated} for the row. */
  let _status = null;

  const notify = () => _rowListener?.();

  function viewNow() {
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
      lat: degrees(point?.latitude),
      lon: degrees(point?.longitude),
      height: Number.isFinite(height) ? height : 2e7,
    };
  }

  function ink() {
    return resolveInk('auto', activeLuminance(_controller));
  }

  function removePrimitive(primitive) {
    if (!primitive) return;
    try {
      _viewer?.scene?.primitives?.remove(primitive);
    } catch {
      /* gone with the scene */
    }
  }

  function clearDrawn() {
    removePrimitive(_points);
    removePrimitive(_lines);
    _points = null;
    _lines = null;
  }

  /** The rollup for the current type: counts above its pin height. */
  function startRollup() {
    stopRollup();
    if (!_viewer) return;
    const type = assetTypeOf(_asset);
    _rollup = attachRollup(
      {
        id: STREET_ASSETS_LAYER_ID,
        viewer: _viewer,
        overlays: overlayHost,
        picking,
        requestRender,
        cesium,
      },
      {
        getPoints: () => (_held?.mode === 'counts' ? _held.features : []),
        accent: type.color || LINE_COLORS.light,
        threshold: {
          enter: type.pinLimit,
          exit: Math.round(type.pinLimit * 0.85),
          enterHeightM: type.pinsBelowM,
          exitHeightM: type.pinsBelowM * 0.85,
          minHeightM: 0,
        },
        onModeChange: (active) => {
          if (_points) _points.show = !active;
          if (_lines) _lines.show = !active;
        },
        onUpdate: notify,
      },
    );
  }

  function stopRollup() {
    _rollup?.detach?.();
    _rollup = null;
  }

  function drawPins() {
    clearDrawn();
    if (!_held || _held.mode !== 'pins') return;
    const type = _held.type;
    const inkNow = ink();
    if (type.geometry === 'line') {
      if (!cesium.GroundPolylinePrimitive || !_held.features.length) return;
      const color = cesium.Color.fromCssColorString(
        LINE_COLORS[inkNow] || LINE_COLORS.light,
      ).withAlpha(0.85);
      const instances = _held.features.map(
        (line) =>
          new cesium.GeometryInstance({
            id: `street-asset:${line.id}`,
            geometry: new cesium.GroundPolylineGeometry({
              positions: cesium.Cartesian3.fromDegreesArray(line.coords.flat()),
              width: 2,
            }),
            attributes: {
              color: cesium.ColorGeometryInstanceAttribute.fromColor(color),
            },
          }),
      );
      _lines = new cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new cesium.PolylineColorAppearance(),
        classificationType: cesium.ClassificationType?.BOTH,
        asynchronous: true,
      });
      _viewer?.scene?.primitives?.add(_lines);
    } else {
      if (!cesium.PointPrimitiveCollection || !_held.features.length) return;
      _points = new cesium.PointPrimitiveCollection();
      const fill = cesium.Color.fromCssColorString(type.color);
      const outline = cesium.Color.fromCssColorString(
        inkNow === 'dark' ? '#1a1a1a' : '#ffffff',
      );
      for (const point of _held.features)
        _points.add({
          id: `street-asset:${point.id}`,
          position: cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0),
          pixelSize: 6,
          color: fill,
          outlineColor: outline,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      _viewer?.scene?.primitives?.add(_points);
    }
    if (_rollup?.isActive?.()) {
      if (_points) _points.show = false;
      if (_lines) _lines.show = false;
    }
  }

  async function fetchFor(type, mode, box) {
    _status = { mode, state: 'loading', count: 0 };
    notify();
    try {
      const limit = mode === 'pins' ? type.pinLimit : type.countLimit;
      const { elements } = await overpass.query(
        buildAssetQuery(type, box, mode),
      );
      if (!_enabled || type.key !== _asset) return;
      const features = assetFeatures(type, mode, elements);
      _held = {
        type,
        mode,
        box,
        features,
        saturated: elements.length >= limit,
      };
      _status = {
        mode,
        state: 'ready',
        count: features.length,
        saturated: _held.saturated,
      };
      drawPins();
      _rollup?.refresh?.({ force: true });
      requestRender('street-assets');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      const code = error instanceof OverpassViewError ? error.code : 'failed';
      _status = { mode, state: code, count: 0 };
      if (code === 'limited' && error.retryAfterMs)
        _debounce = setTimeoutImpl(
          () => _enabled && settle(),
          error.retryAfterMs,
        );
    }
    notify();
  }

  /** The camera settled: ask for the type's features or counts for the view. */
  function settle() {
    if (!_enabled) return;
    clearTimeoutImpl(_debounce);
    _debounce = null;
    const type = assetTypeOf(_asset);
    const view = viewNow();
    const mode = assetModeForHeight(type, view.height);
    if (mode === 'none') {
      overpass.abort?.();
      _held = null;
      clearDrawn();
      _rollup?.refresh?.({ force: true });
      _status = { mode, state: 'idle', count: 0 };
      requestRender('street-assets');
      notify();
      return;
    }
    if (_status?.state === 'unconfigured') return notify();
    const box = assetQueryBox(view);
    if (
      _held &&
      _held.type === type &&
      _held.mode === mode &&
      boxCovers(_held.box, box)
    ) {
      _status = {
        mode,
        state: 'ready',
        count: _held.features.length,
        saturated: _held.saturated,
      };
      notify();
      return;
    }
    _debounce = setTimeoutImpl(() => {
      _debounce = null;
      fetchFor(type, mode, box);
    }, ASSET_DEBOUNCE_MS);
  }

  function setAsset(key) {
    if (!ASSET_KEYS.includes(key) || key === _asset) return;
    _asset = key;
    try {
      store?.setItem(TYPE_STORAGE_KEY, key);
    } catch {
      /* private mode: kept for this page only */
    }
    overpass.abort?.();
    _held = null;
    _status = null;
    clearDrawn();
    if (_enabled) {
      startRollup();
      settle();
    }
    notify();
  }

  return {
    id: STREET_ASSETS_LAYER_ID,
    name: 'Street assets',
    icon: '⚡',
    source: 'OpenStreetMap',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_enabled) return;
      _enabled = true;
      overlayHost?.setVisible?.(`${STREET_ASSETS_LAYER_ID}-rollup`, true);
      credits?.register?.(_viewer, STREET_ASSETS_CREDIT);
      if (_viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = _viewer.camera.moveEnd.addEventListener(settle);
      startRollup();
      settle();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      clearTimeoutImpl(_debounce);
      _debounce = null;
      overpass.abort?.();
      _removeMove?.();
      _removeMove = null;
      stopRollup();
      clearDrawn();
      _held = null;
      _status = null;
      requestRender('street-assets-hide');
      notify();
    },

    async update() {
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

    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _controller = controller || null;
      const off = _controller?.subscribe?.(() => drawPins());
      _unsubscribeMap = typeof off === 'function' ? off : null;
    },

    getStats() {
      const count = _held?.features?.length ?? 0;
      return { count, countLabel: _enabled ? String(count) : '—' };
    },

    getRowControls() {
      return rowControls({
        asset: _asset,
        onAsset: setAsset,
        inkColor: LINE_COLORS[ink()] || LINE_COLORS.light,
        status: _status,
        enabled: _enabled,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests. */
    _state: () => ({
      asset: _asset,
      held: _held,
      status: _status,
      rollup: _rollup,
      points: _points,
      lines: _lines,
    }),
    _settle: settle,
  };
}
