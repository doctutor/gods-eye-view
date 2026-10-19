import * as Cesium from 'cesium';
import { attachPointRollup } from '../pointRollup/index.js';
import { viewWindow } from '../../maps/h3Cells.js';
import { h3ResolutionForHeight } from '../../maps/h3Resolution.js';
import { PLACE_CONFIDENCE_CHOICES } from '../../data/overturePlaces.js';
import { PlacesError, createPlacesSource } from './source.js';
import {
  CATEGORY_COLORS,
  CATEGORY_KEYS,
  PLACE_PINS_BELOW_M,
  boxCovers,
  pinQueryBox,
  placeCardEntry,
} from './places.js';
import { placeCardDetails, rowControls } from './presentation.js';

/**
 * Personal fork: the Places layer (ANALYSIS in the DATA LAYERS panel):
 * Overture Maps' points of interest from the local index (/api/overture/
 * places, built by `npm run overture:build -- --places`). One category at a
 * time (ALL by default, kept as gev.places.category) and a confidence floor
 * (≥ 80% by default, or ≥ 50%; gev.places.confidence). Below
 * PLACE_PINS_BELOW_M the view's places as pins, the most confident first,
 * at most 1,500; above it the same places counted per H3 cell (the shared
 * point rollup, fed the server's counts), whose hexes fly the camera in. A
 * click on a pin opens its card (category, Overture's own kind, brand,
 * website and phone as text, source, confidence); a click elsewhere closes
 * it. Rebuilt when the camera settles.
 */

export const PLACES_LAYER_ID = 'places';
export const PLACES_SOURCE = 'places';
export const CATEGORY_STORAGE_KEY = 'gev.places.category';
export const CONFIDENCE_STORAGE_KEY = 'gev.places.confidence';
export const PLACES_DEBOUNCE_MS = 200;
const PIN_PREFIX = 'place:';

export const PLACES_CREDIT = Object.freeze({
  key: 'places',
  html:
    'Places: <a href="https://docs.overturemaps.org/attribution/" target="_blank" rel="noopener">Overture Maps Foundation</a>, ' +
    'from Meta, Microsoft, Foursquare, AllThePlaces and others (CDLA-Permissive 2.0, Apache 2.0, CC0)',
});

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
const read = (store, key, ok, fallback) => {
  try {
    const value = store?.getItem(key);
    return ok(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

/**
 * @param {{overlayHost?: object|null, cesium?: object,
 *   requestRender?: (reason: string) => void, credits?: {register?: Function},
 *   source?: object, storage?: Storage|null, picking?: object|null,
 *   attachRollup?: typeof attachPointRollup,
 *   setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout}} [options]
 */
export function createPlacesLayer({
  overlayHost = null,
  cesium = Cesium,
  requestRender = () => {},
  credits = null,
  source = createPlacesSource(),
  storage,
  picking = null,
  attachRollup = attachPointRollup,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
} = {}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _category = read(
    store,
    CATEGORY_STORAGE_KEY,
    (v) => CATEGORY_KEYS.includes(v),
    'all',
  );
  let _confidence = Number(
    read(
      store,
      CONFIDENCE_STORAGE_KEY,
      (v) => PLACE_CONFIDENCE_CHOICES.includes(Number(v)),
      PLACE_CONFIDENCE_CHOICES[0],
    ),
  );
  let _index = null; // the server's status
  let _removeMove = null;
  let _handler = null;
  let _rollup = null;
  let _points = null;
  let _debounce = null;
  let _rowListener = null;
  /** Pins held: {box, key, places, saturated}; counts held: {res, window, key, cells}. */
  let _pins = null;
  let _counts = null;
  let _status = null;
  let _selected = null;
  let _view = null;

  const notify = () => _rowListener?.();
  const filterKey = () => `${_category}|${_confidence}`;

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

  function removePoints() {
    if (!_points) return;
    try {
      _viewer?.scene?.primitives?.remove(_points);
    } catch {
      /* gone with the scene */
    }
    _points = null;
  }

  function drawCard() {
    const entries = [];
    if (_selected)
      entries.push(
        placeCardEntry({
          place: _selected,
          title: _selected.name,
          details: placeCardDetails(_selected),
          accent: CATEGORY_COLORS[_selected.category] || CATEGORY_COLORS.all,
          cesium,
        }),
      );
    try {
      overlayHost?.setEntries?.(PLACES_SOURCE, entries, { moving: false });
    } catch (error) {
      console.warn('[Places] card not drawn:', error?.message);
    }
  }

  function drawPins() {
    removePoints();
    if (!_pins?.places?.length || !cesium.PointPrimitiveCollection) return;
    _points = new cesium.PointPrimitiveCollection();
    const outline = cesium.Color.fromCssColorString('#1a1a1a').withAlpha(0.7);
    for (const place of _pins.places)
      _points.add({
        id: `${PIN_PREFIX}${place.id}`,
        position: cesium.Cartesian3.fromDegrees(place.at[0], place.at[1], 0),
        pixelSize: 6,
        color: cesium.Color.fromCssColorString(
          CATEGORY_COLORS[place.category] || CATEGORY_COLORS.other,
        ),
        outlineColor: outline,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    _viewer?.scene?.primitives?.add(_points);
  }

  function startRollup() {
    stopRollup();
    if (!_viewer) return;
    _rollup = attachRollup(
      {
        id: PLACES_LAYER_ID,
        viewer: _viewer,
        overlays: overlayHost,
        picking,
        requestRender,
        cesium,
      },
      {
        getCounts: (res) =>
          _counts && _counts.res === res && _counts.key === filterKey()
            ? _counts.cells
            : null,
        accent: CATEGORY_COLORS[_category] || CATEGORY_COLORS.all,
        // The height alone decides: counts above the pins' height.
        threshold: {
          enter: Number.MAX_SAFE_INTEGER,
          exit: Number.MAX_SAFE_INTEGER,
          enterHeightM: PLACE_PINS_BELOW_M,
          exitHeightM: PLACE_PINS_BELOW_M * 0.9,
          minHeightM: 0,
        },
        onModeChange: (active) => {
          if (_points) _points.show = !active;
        },
        onUpdate: notify,
      },
    );
  }

  function stopRollup() {
    _rollup?.detach?.();
    _rollup = null;
  }

  function failed(error, mode) {
    if (error?.name === 'AbortError') return;
    const code = error instanceof PlacesError ? error.code : 'failed';
    if (code === 'unconfigured') _index = { configured: false };
    _status = { mode, state: code, count: 0 };
    notify();
  }

  async function fetchPins(box) {
    _status = { mode: 'pins', state: 'loading', count: 0 };
    notify();
    const key = filterKey();
    try {
      const answer = await source.pins({
        box,
        category: _category,
        minConfidence: _confidence,
        version: _index.version,
      });
      if (!_enabled || key !== filterKey()) return;
      _pins = { box, key, places: answer.places, saturated: answer.saturated };
      _status = {
        mode: 'pins',
        state: 'ready',
        count: answer.count,
        saturated: answer.saturated,
      };
      drawPins();
      _rollup?.refresh?.({ force: true });
      requestRender('places');
      notify();
    } catch (error) {
      failed(error, 'pins');
    }
  }

  async function fetchCounts(res, window) {
    _status = { mode: 'counts', state: 'loading', count: 0 };
    notify();
    const key = filterKey();
    try {
      const cells = await source.counts({
        res,
        bounds: window,
        category: _category,
        minConfidence: _confidence,
        version: _index.version,
      });
      if (!_enabled || key !== filterKey()) return;
      _counts = { res, window, key, cells, view: _view };
      let total = 0;
      for (const count of cells.values()) total += count;
      _status = { mode: 'counts', state: 'ready', count: total };
      _rollup?.refresh?.({ force: true });
      requestRender('places');
      notify();
    } catch (error) {
      failed(error, 'counts');
    }
  }

  const countsCover = (window) =>
    !_counts?.window || (window && boxCovers(_counts.window, window));

  /** The camera settled: pins or counts for the view. */
  function settle() {
    if (!_enabled) return;
    clearTimeoutImpl(_debounce);
    _debounce = null;
    if (!_index) {
      source.status().then((status) => {
        _index = status;
        if (!status.configured) {
          _status = { state: 'unconfigured', count: 0 };
          notify();
          return;
        }
        if (_enabled) settle();
      });
      return;
    }
    if (!_index.configured) {
      _status = { state: 'unconfigured', count: 0 };
      notify();
      return;
    }
    _view = viewNow();
    if (_view.height < PLACE_PINS_BELOW_M) {
      const box = pinQueryBox(_view);
      if (
        _pins &&
        _pins.key === filterKey() &&
        boxCovers(_pins.box, box) &&
        !_pins.saturated
      ) {
        _status = {
          mode: 'pins',
          state: 'ready',
          count: _pins.places.length,
          saturated: false,
        };
        _rollup?.refresh?.();
        return notify();
      }
      _debounce = setTimeoutImpl(() => {
        _debounce = null;
        fetchPins(box);
      }, PLACES_DEBOUNCE_MS);
      return;
    }
    removePoints();
    _pins = null;
    const res = h3ResolutionForHeight(_view.height);
    const window = viewWindow(_view.lat, _view.lon, _view.height);
    if (
      _counts &&
      _counts.key === filterKey() &&
      _counts.res === res &&
      countsCover(window)
    ) {
      _rollup?.refresh?.();
      return notify();
    }
    // Ask for a window twice the view's, so a pan reuses the answer.
    const wide = window
      ? viewWindow(_view.lat, _view.lon, _view.height * 2)
      : null;
    _debounce = setTimeoutImpl(() => {
      _debounce = null;
      fetchCounts(res, wide);
    }, PLACES_DEBOUNCE_MS);
  }

  function select(id) {
    const place = id ? _pins?.places?.find((p) => p.id === id) : null;
    _selected = place && _selected?.id !== place.id ? place : null;
    drawCard();
    requestRender('places-card');
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
    if (pickedId.startsWith(PIN_PREFIX))
      return select(pickedId.slice(PIN_PREFIX.length));
    if (_selected) select(null);
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

  function refilter() {
    source.abort?.();
    _pins = null;
    _counts = null;
    _selected = null;
    removePoints();
    drawCard();
    if (_enabled) {
      startRollup();
      settle();
    }
    notify();
  }

  function setCategory(key) {
    if (!CATEGORY_KEYS.includes(key) || key === _category) return;
    _category = key;
    try {
      store?.setItem(CATEGORY_STORAGE_KEY, key);
    } catch {
      /* private mode */
    }
    refilter();
  }

  function setConfidence(value) {
    if (!PLACE_CONFIDENCE_CHOICES.includes(value) || value === _confidence)
      return;
    _confidence = value;
    try {
      store?.setItem(CONFIDENCE_STORAGE_KEY, String(value));
    } catch {
      /* private mode */
    }
    refilter();
  }

  return {
    id: PLACES_LAYER_ID,
    name: 'Places',
    icon: '⌖',
    source: 'Overture Maps',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      if (_enabled) return;
      _enabled = true;
      overlayHost?.setVisible?.(PLACES_SOURCE, true);
      overlayHost?.setVisible?.(`${PLACES_LAYER_ID}-rollup`, true);
      credits?.register?.(_viewer, PLACES_CREDIT);
      if (_viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = _viewer.camera.moveEnd.addEventListener(settle);
      attachClick();
      startRollup();
      settle();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
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
      stopRollup();
      removePoints();
      _pins = null;
      _counts = null;
      _selected = null;
      _status = null;
      _index = null;
      overlayHost?.clearSource?.(PLACES_SOURCE);
      overlayHost?.setVisible?.(PLACES_SOURCE, false);
      requestRender('places-hide');
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
        category: _category,
        onCategory: setCategory,
        minConfidence: _confidence,
        onConfidence: setConfidence,
        status: _status,
        enabled: _enabled,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests. */
    _state: () => ({
      category: _category,
      confidence: _confidence,
      index: _index,
      pins: _pins,
      counts: _counts,
      status: _status,
      selected: _selected,
      points: _points,
      rollup: _rollup,
    }),
    _settle: settle,
    _onClick: onClick,
  };
}
