import * as Cesium from 'cesium';
import { createHexSurface } from '../../maps/h3Surface.js';
import { viewWindow } from '../../maps/h3Cells.js';
import { h3ResolutionForHeight } from '../../maps/h3Resolution.js';
import {
  DEFAULT_PROPERTY_METRIC,
  PROPERTY_LAYER_ID,
  PROPERTY_METRIC_KEYS,
  PROPERTY_POINTS_BELOW_M,
} from '../../data/propertySales.js';
import { placeCardEntry } from '../places/places.js';
import { PropertyError, createPropertySource } from './source.js';
import {
  boxCovers,
  buildingValue,
  metricColor,
  pinQueryBox,
} from './property.js';
import { buildingCard, rowControls } from './presentation.js';
import { colourScales } from '../../maps/colourScaleStore.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';
import {
  PROPERTY_SCALE_LAYER,
  propertyColouring,
  propertyScaleDefaults,
  propertyScaleKey,
} from './scale.js';

/**
 * Personal fork: the Property sales layer (ANALYSIS in the DATA LAYERS
 * panel): US property records from realestatedataset.com, their public-
 * record fields only, from the local index (/api/property, built by `npm
 * run property:build`). Above PROPERTY_POINTS_BELOW_M, H3 hexagons coloured
 * by one metric (median sale price since 2015 by default, or price per
 * sqft, year built, sales, properties; kept as gev.property.metric) at the
 * resolution the camera height picks; below it the view's buildings as
 * points in the same colours, units collapsed into their building. A click
 * on a point opens its card (address, type, beds, baths, sqft, lot, year,
 * last sale, assessments as a sparkline, parcel, county); a click elsewhere
 * closes it. The Lego mode draws the same hexagons as columns.
 */

export { PROPERTY_LAYER_ID };
export const PROPERTY_SOURCE = 'property';
export const METRIC_STORAGE_KEY = 'gev.property.metric';
export const OPACITY_STORAGE_KEY = 'gev.property.opacity';
export const DEFAULT_OPACITY = 0.7;
export const PROPERTY_DEBOUNCE_MS = 200;
const POINT_PREFIX = 'property:';

export const PROPERTY_CREDIT = Object.freeze({
  key: 'property-sales',
  html: 'Property sales: <a href="https://realestatedataset.com/" target="_blank" rel="noopener">realestatedataset.com</a> (Straply), CC0; public-record fields only',
});

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const read = (store, key) => {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (store, key, value) => {
  try {
    store?.setItem(key, value);
  } catch {
    /* private mode: kept for this page */
  }
};

/** The stored metric, else the default. */
export function readMetric(storage) {
  const value = read(storageOf(storage), METRIC_STORAGE_KEY);
  return PROPERTY_METRIC_KEYS.includes(value) ? value : DEFAULT_PROPERTY_METRIC;
}

/**
 * @param {{overlayHost?: object|null, cesium?: object,
 *   requestRender?: (reason: string) => void, credits?: {register?: Function},
 *   source?: object, storage?: Storage|null,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} [options]
 */
export function createPropertyLayer({
  overlayHost = null,
  cesium = Cesium,
  requestRender = () => {},
  credits = null,
  source = createPropertySource(),
  storage,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
  // The colour scales (src/maps/colourScale.js): the app's one store.
  scales = colourScales(),
} = {}) {
  let _removeScaleListener = null;
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _metric = readMetric(store);
  let _opacity = (() => {
    const value = Number(read(store, OPACITY_STORAGE_KEY));
    return read(store, OPACITY_STORAGE_KEY) !== null && value >= 0 && value <= 1
      ? value
      : DEFAULT_OPACITY;
  })();
  let _index = null;
  let _removeMove = null;
  let _handler = null;
  let _debounce = null;
  let _rowListener = null;
  /** Hexes held: {res, metric, window, domain, cells}; points: {box, buildings, saturated}. */
  let _hexes = null;
  let _surface = null;
  let _points = null;
  let _pointsData = null;
  let _status = null;
  let _selected = null;
  let _generation = 0;

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

  /** The domain the points and the legend use: the hexagons' when drawn, else resolution 7's. */
  const domainNow = () =>
    (_surface && _hexes?.metric === _metric ? _hexes.domain : null) ||
    _index?.domains?.[7]?.[_metric] ||
    null;

  function removeSurface() {
    if (_surface?.primitive)
      try {
        _viewer?.scene?.primitives?.remove(_surface.primitive);
      } catch {
        /* gone with the scene */
      }
    _surface = null;
  }

  function removePoints() {
    if (_points)
      try {
        _viewer?.scene?.primitives?.remove(_points);
      } catch {
        /* gone with the scene */
      }
    _points = null;
  }

  function colour([r, g, b, a]) {
    return new cesium.Color(r / 255, g / 255, b / 255, a / 255);
  }

  function drawHexes() {
    removeSurface();
    if (!_hexes?.cells?.size) return;
    const coloured = [];
    const { colourOf } = propertyColouring(
      scales,
      _hexes.metric,
      _hexes.domain,
    );
    for (const [cell, value] of _hexes.cells) {
      const rgba = colourOf(value);
      if (rgba[3]) coloured.push([cell, colour(rgba)]);
    }
    _surface = createHexSurface({ cells: coloured, opacity: _opacity, cesium });
    if (_surface.primitive) _viewer?.scene?.primitives?.add(_surface.primitive);
  }

  function drawPoints() {
    removePoints();
    if (!_pointsData?.buildings?.length || !cesium.PointPrimitiveCollection)
      return;
    _points = new cesium.PointPrimitiveCollection();
    const domain = domainNow();
    const { colourOf } = propertyColouring(scales, _metric, domain);
    const none = cesium.Color.fromCssColorString('#9e9e9e').withAlpha(0.8);
    const outline = cesium.Color.fromCssColorString('#1a1a1a').withAlpha(0.7);
    for (const building of _pointsData.buildings) {
      const rgba = colourOf(buildingValue(_metric, building));
      _points.add({
        id: `${POINT_PREFIX}${building.id}`,
        position: cesium.Cartesian3.fromDegrees(
          building.at[0],
          building.at[1],
          0,
        ),
        pixelSize: 5 + Math.min(6, Math.log2(building.units)),
        color: rgba[3] ? colour([rgba[0], rgba[1], rgba[2], 255]) : none,
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    _viewer?.scene?.primitives?.add(_points);
  }

  function drawCard() {
    const entries = [];
    if (_selected?.detail) {
      const card = buildingCard(_selected.detail);
      entries.push(
        placeCardEntry({
          place: _selected.detail,
          title: card.title,
          details: card.details,
          accent: '#fc9d2c',
          cesium,
        }),
      );
    }
    try {
      overlayHost?.setEntries?.(PROPERTY_SOURCE, entries, { moving: false });
    } catch (error) {
      console.warn('[Property] card not drawn:', error?.message);
    }
  }

  function failed(error, mode) {
    if (error?.name === 'AbortError') return;
    const code = error instanceof PropertyError ? error.code : 'failed';
    if (code === 'unconfigured') _index = { configured: false };
    _status = { mode, state: code, count: 0 };
    notify();
  }

  async function fetchHexes(res, window) {
    const generation = ++_generation;
    _status = { mode: 'hexes', state: 'loading', count: 0 };
    notify();
    const box = window || { west: -180, south: -85, east: 180, north: 85 };
    let ask = res;
    for (;;) {
      try {
        const answer = await source.hexes({
          res: ask,
          metric: _metric,
          box,
          version: _index.version,
        });
        if (!_enabled || generation !== _generation) return;
        _hexes = { ...answer, window, asked: res };
        drawHexes();
        _status = {
          mode: 'hexes',
          state: 'ready',
          res: ask,
          count: answer.cells.size,
        };
        requestRender('property-hexes');
        notify();
        return;
      } catch (error) {
        // Too many hexagons for the window: one step coarser.
        if (error?.code === 'tooMany' && ask > 0) {
          ask -= 1;
          continue;
        }
        if (generation === _generation) failed(error, 'hexes');
        return;
      }
    }
  }

  async function fetchPoints(box) {
    const generation = ++_generation;
    _status = { mode: 'points', state: 'loading', count: 0 };
    notify();
    try {
      const answer = await source.buildings({ box, version: _index.version });
      if (!_enabled || generation !== _generation) return;
      _pointsData = { box, ...answer, metric: _metric };
      drawPoints();
      _status = {
        mode: 'points',
        state: 'ready',
        count: answer.count,
        saturated: answer.saturated,
      };
      requestRender('property-points');
      notify();
    } catch (error) {
      if (generation === _generation) failed(error, 'points');
    }
  }

  /** The camera settled: hexagons or points for the view. */
  function settle() {
    if (!_enabled) return;
    clearTimeoutImpl(_debounce);
    _debounce = null;
    if (!_index) {
      source.status().then((status) => {
        _index = status;
        if (_enabled) settle();
      });
      return;
    }
    if (!_index.configured) {
      removeSurface();
      removePoints();
      _status = { state: 'unconfigured', count: 0 };
      notify();
      return;
    }
    const view = viewNow();
    if (view.height < PROPERTY_POINTS_BELOW_M) {
      removeSurface();
      _hexes = null;
      const box = pinQueryBox(view);
      if (
        _pointsData &&
        _pointsData.metric === _metric &&
        boxCovers(_pointsData.box, box) &&
        !_pointsData.saturated
      )
        return notify();
      _debounce = setTimeoutImpl(() => {
        _debounce = null;
        fetchPoints(box);
      }, PROPERTY_DEBOUNCE_MS);
      return;
    }
    removePoints();
    _pointsData = null;
    const res = h3ResolutionForHeight(view.height);
    const window = viewWindow(view.lat, view.lon, view.height);
    if (
      _hexes &&
      _hexes.metric === _metric &&
      _hexes.asked === res &&
      (!_hexes.window || (window && boxCovers(_hexes.window, window)))
    )
      return notify();
    // Ask for a window twice the view's, so a pan reuses the answer.
    const wide = window
      ? viewWindow(view.lat, view.lon, view.height * 2)
      : null;
    _debounce = setTimeoutImpl(() => {
      _debounce = null;
      fetchHexes(res, wide);
    }, PROPERTY_DEBOUNCE_MS);
  }

  async function select(id) {
    if (!id || _selected?.id === id) {
      _selected = null;
      drawCard();
      requestRender('property-card');
      return;
    }
    _selected = { id, detail: null };
    try {
      const detail = await source.building({ id, version: _index?.version });
      if (_selected?.id !== id) return;
      _selected = detail ? { id, detail } : null;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      _selected = null;
    }
    drawCard();
    requestRender('property-card');
  }

  function onClick(position) {
    if (!_enabled) return;
    let picked = null;
    try {
      picked = _viewer?.scene?.pick?.(position);
    } catch {
      picked = null;
    }
    const pickedId = String(picked?.id ?? '');
    if (pickedId.startsWith(POINT_PREFIX))
      return select(pickedId.slice(POINT_PREFIX.length));
    if (_selected) return select(null);
    return undefined;
  }

  function attachClick() {
    if (_handler || !cesium.ScreenSpaceEventHandler || !_viewer?.scene?.canvas)
      return;
    try {
      _handler = new cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
      _handler.setInputAction(
        (movement) => onClick(movement.position),
        cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    } catch {
      _handler = null;
    }
  }

  function setMetric(key) {
    if (!PROPERTY_METRIC_KEYS.includes(key) || key === _metric) return;
    _metric = key;
    write(store, METRIC_STORAGE_KEY, key);
    _hexes = null;
    removeSurface();
    if (_pointsData) drawPoints();
    if (_enabled) settle();
    requestRender('property-metric');
    notify();
  }

  function setOpacity(value) {
    _opacity = Math.min(1, Math.max(0, Number(value) || 0));
    write(store, OPACITY_STORAGE_KEY, String(_opacity));
    if (_surface && !_surface.setOpacity(_opacity)) drawHexes();
    requestRender('property-opacity');
    notify();
  }

  return {
    id: PROPERTY_LAYER_ID,
    name: 'Property sales',
    icon: '⌂',
    source: 'realestatedataset.com',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_enabled) return;
      _enabled = true;
      // A changed colour scale for this layer repaints what is drawn.
      _removeScaleListener ||= scales.subscribe((key) => {
        if (
          key !== PROPERTY_SCALE_LAYER &&
          !String(key).startsWith(`${PROPERTY_SCALE_LAYER}:`)
        )
          return;
        if (_hexes) drawHexes();
        if (_pointsData) drawPoints();
        requestRender('property-scale');
        notify();
      });
      overlayHost?.setVisible?.(PROPERTY_SOURCE, true);
      credits?.register?.(_viewer, PROPERTY_CREDIT);
      if (_viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = _viewer.camera.moveEnd.addEventListener(settle);
      attachClick();
      settle();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _removeScaleListener?.();
      _removeScaleListener = null;
      _generation += 1;
      clearTimeoutImpl(_debounce);
      _debounce = null;
      source.abort?.();
      _removeMove?.();
      _removeMove = null;
      try {
        _handler?.destroy?.();
      } catch {
        /* gone */
      }
      _handler = null;
      removeSurface();
      removePoints();
      _hexes = null;
      _pointsData = null;
      _selected = null;
      _status = null;
      _index = null;
      overlayHost?.clearSource?.(PROPERTY_SOURCE);
      overlayHost?.setVisible?.(PROPERTY_SOURCE, false);
      requestRender('property-hide');
      notify();
    },

    async update() {
      return _enabled;
    },

    destroy() {
      this.disable();
      _viewer = null;
      _rowListener = null;
    },

    getStats() {
      const count = _status?.state === 'ready' ? _status.count : 0;
      return { count, countLabel: _enabled ? String(count) : '—' };
    },

    getRowControls() {
      return rowControls({
        metric: _metric,
        onMetric: setMetric,
        domain: domainNow(),
        status: _status,
        index: _index,
        enabled: _enabled,
        opacity: _opacity,
        onOpacity: setOpacity,
        scale:
          _enabled && domainNow()
            ? scaleRowControl({
                store: scales,
                key: propertyScaleKey(_metric),
                defaults: propertyScaleDefaults(_metric),
                auto: { min: domainNow().min, max: domainNow().max },
              })
            : null,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests. */
    _state: () => ({
      metric: _metric,
      opacity: _opacity,
      index: _index,
      hexes: _hexes,
      surface: _surface,
      points: _points,
      pointsData: _pointsData,
      status: _status,
      selected: _selected,
    }),
    _settle: settle,
    _onClick: onClick,
    setMetric,
  };
}
