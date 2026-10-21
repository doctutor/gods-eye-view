import * as Cesium from 'cesium';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { viewMoved, viewRectangleDegrees } from '../earthEngine/index.js';
import {
  DEFAULT_VARIANT,
  POINTS_VARIANT,
  VARIANTS,
  rowControls,
} from './presentation.js';
// The Articles mode: one dot per article (points.js).
import { createPointsMode } from './points.js';
import { createCoverageImageryProvider } from './provider.js';
// The Hexes mode: H3 cells at the camera's resolution instead of the raster.
import { createHexSurface, fallbackResolution } from './hexes.js';
import { encodeScaleFields } from '../../maps/colourScale.js';
import { colourScales } from '../../maps/colourScaleStore.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';
import {
  WIKIPEDIA_SCALE_LAYER,
  wikipediaColouring,
  wikipediaScaleDefaults,
  wikipediaScaleKey,
} from './scale.js';
import { h3ResolutionForHeight } from '../../maps/h3Resolution.js';
import { viewMoved as hexViewMoved, viewWindow } from '../../maps/h3Cells.js';

/**
 * Personal fork: the Wikipedia layer (REFERENCE in the DATA LAYERS panel):
 * where English Wikipedia has written about the Earth. Its Articles mode
 * (the default; points.js) draws one dot per geotagged article, like
 * wikimap.wiki, coloured by its type, with titles close in and a card on
 * click; the other modes are the coverage rasters, in the spirit of the
 * Oxford Internet Institute's maps of the geographies of Wikipedia. The
 * local server (server/providers/wikipediaCoverage.js) serves the dots
 * from the points index and the cell values from a grid, both built by
 * `npm run wikipedia:build`; the browser paints the rasters with a log
 * colour ramp (provider.js, ramp.js).
 *
 * The modes, switched with the row's chips and kept as gev.wikipedia.mode:
 * Articles, density per km², bytes of article text per km² when the build
 * included the page table, and the two per-capita ones. The row also
 * carries the type classes or the ramp as a legend, an opacity slider for
 * the rasters (kept as gev.wikipediaCoverage.opacity) and a status line.
 *
 * It drapes where the map stack can take imagery (maps/imageryHost.js), as
 * the Earth Engine overlays do, and like them covers only the view's
 * neighbourhood on a photoreal tileset (the rectangle and its rebuild rule
 * are the Earth Engine layer's). Its minimum level is 0, on purpose: Cesium
 * clamps a primitive's level up to it.
 */

export const OPACITY_STORAGE_KEY = 'gev.wikipediaCoverage.opacity';
export const DEFAULT_OPACITY = 0.75;
export const LAYER_ID = 'wikipedia-coverage';
export const LAYER_NAME = 'Wikipedia';
export const MODE_STORAGE_KEY = 'gev.wikipedia.mode';
export const SECONDARY_STORAGE_KEY = 'gev.wikipedia.secondary';
export const SOURCE_NAME = 'Wikimedia GeoData';
/** The catalog is read again this often while on (a rebuild lands). */
export const CATALOG_REFRESH_MS = 10 * 60 * 1000;

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored opacity, else the default. */
export function readOpacity(storage) {
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

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The data-attribution popover's entry. */
export function attributionCredit(attribution) {
  return {
    key: 'wikipedia-coverage',
    html: `${escapeHtml(LAYER_NAME)}: <a href="https://www.mediawiki.org/wiki/Extension:GeoData" target="_blank" rel="noopener">Wikimedia GeoData</a> · ${escapeHtml(attribution || 'Wikipedia, CC BY-SA 4.0')}`,
  };
}

/** The stored mode, else the default (Articles). */
export function readMode(storage) {
  try {
    const value = storage?.getItem(MODE_STORAGE_KEY);
    return VARIANTS.some((variant) => variant.key === value)
      ? value
      : DEFAULT_VARIANT;
  } catch {
    return DEFAULT_VARIANT;
  }
}

/**
 * @param {{source: {catalog: Function, last?: Function}, cesium?: object,
 *   requestRender?: (reason: string) => void, storage?: Storage|null,
 *   credits?: {register?: Function}, fetchTile?: Function,
 *   createCanvas?: Function, overlayHost?: object|null,
 *   hitTest?: Function|null, openUrl?: (url: string) => void}} options
 */
export function createWikipediaCoverageLayer({
  source,
  cesium = Cesium,
  requestRender = () => {},
  storage,
  credits,
  fetchTile,
  createCanvas,
  overlayHost = null,
  hitTest = null,
  openUrl,
  // The colour scales (src/maps/colourScale.js): the app's one store.
  scales = colourScales(),
}) {
  const store = storageOf(storage);
  let _removeScaleListener = null;
  let _viewer = null;
  let _enabled = false;
  let _imagery = null;
  let _mountedKey = '';
  let _catalog = null;
  let _loading = false;
  let _failure = null;
  let _opacity = readOpacity(store);
  let _variant = readMode(store);
  let _removeMoveListener = null;
  let _rowListener = null;
  let _controller = null;
  let _unsubscribeMap = null;
  let _collection = null;
  let _hostKind = 'globe';
  let _madeFor = null;
  /** The Hexes mode: on or off, the drawn surface, its data and its state. */
  let _hexes = false;
  let _hexSurface = null;
  let _hexData = null;
  let _hexState = { res: null, count: 0, domain: null, failure: null };
  let _hexMadeFor = null;
  let _hexAbort = null;
  let _hexGen = 0;
  const notify = () => {
    try {
      _rowListener?.();
    } catch {
      /* the panel's problem */
    }
  };
  const points = createPointsMode({
    source,
    cesium,
    overlayHost,
    hitTest,
    requestRender,
    notify,
    ...(openUrl ? { openUrl } : {}),
  });
  try {
    points.setSecondary(store?.getItem(SECONDARY_STORAGE_KEY) === '1');
  } catch {
    /* no storage */
  }

  function cameraHeight() {
    const height = _viewer?.camera?.positionCartographic?.height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /** The point under the middle of the view (else under the camera), and the height. */
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
    return {
      lat: degrees(point?.latitude),
      lon: degrees(point?.longitude),
      height: cameraHeight(),
    };
  }

  function imageryHost() {
    if (!_controller)
      return _viewer?.imageryLayers
        ? { collection: _viewer.imageryLayers, kind: 'globe' }
        : { collection: null, kind: 'none' };
    return resolveImageryHost({
      viewer: _viewer,
      tileset: _controller.getImageryHostTileset?.() || null,
    });
  }

  function unmount() {
    if (!_imagery) return;
    try {
      _collection?.remove(_imagery, true);
    } catch {
      /* already gone with its tileset or the viewer */
    }
    _imagery = null;
    _collection = null;
    _mountedKey = '';
    _madeFor = null;
    requestRender('wikipedia-coverage-hide');
  }

  /** Take the hex surface off the scene. */
  function unmountHexes() {
    _hexAbort?.abort();
    _hexAbort = null;
    _hexGen += 1;
    if (_hexSurface?.primitive) {
      try {
        _viewer?.scene?.primitives?.remove(_hexSurface.primitive);
      } catch {
        /* already gone with the scene */
      }
    }
    if (_hexSurface) requestRender('wikipedia-coverage-hexes-hide');
    _hexSurface = null;
    _hexMadeFor = null;
    _hexState = { ..._hexState, count: 0 };
  }

  /** Draw the data held for the view at the current opacity. */
  function mountHexes(data, madeFor) {
    if (_hexSurface?.primitive) {
      try {
        _viewer?.scene?.primitives?.remove(_hexSurface.primitive);
      } catch {
        /* already gone */
      }
    }
    const domain = data.domain || { min: 1, max: 2 };
    const colouring = wikipediaColouring(scales, _variant, domain);
    _hexSurface = createHexSurface({
      cells: data.cells,
      domain,
      opacity: _opacity,
      cesium,
      ...(colouring.isDefault ? {} : { colourOf: colouring.colourOf }),
    });
    if (_hexSurface.primitive)
      _viewer?.scene?.primitives?.add(_hexSurface.primitive);
    _hexData = data;
    _hexMadeFor = madeFor;
    _hexState = {
      res: data.res,
      count: _hexSurface.count,
      domain: data.domain,
      failure: null,
    };
    requestRender('wikipedia-coverage-hexes-show');
  }

  /** Ask the server for the view's cells; a 413 steps the resolution down once. */
  async function loadHexes(view) {
    const wanted = h3ResolutionForHeight(view.heightM);
    const window = viewWindow(view.lat, view.lon, view.heightM);
    const box = window || { west: -180, south: -85, east: 180, north: 85 };
    _hexAbort?.abort();
    const abort = new AbortController();
    _hexAbort = abort;
    const gen = ++_hexGen;
    const madeFor = {
      ...view,
      res: wanted,
      variant: _variant,
      scale: scaleToken(),
    };
    _hexMadeFor = madeFor;
    _loading = true;
    notify();
    let res = wanted;
    let retried = false;
    try {
      for (;;) {
        try {
          const data = await source.hexCells({
            res,
            variant: _variant,
            box,
            signal: abort.signal,
          });
          if (gen !== _hexGen || !_enabled || !_hexes) return;
          mountHexes(data, madeFor);
          return;
        } catch (error) {
          if (abort.signal.aborted || gen !== _hexGen) return;
          const next = error?.status === 413 ? fallbackResolution(res) : null;
          if (next !== null && !retried) {
            retried = true;
            res = next;
            continue;
          }
          // 503: the H3 grid is not built; 404: this variant is not in it
          // (text without --text). Either greys the variant's chip with
          // the server's message.
          _hexState = {
            ..._hexState,
            count: 0,
            domain: null,
            failure: String(error?.message || error).slice(0, 200),
            status: Number.isInteger(error?.status) ? error.status : null,
            variant: _variant,
          };
          if (_hexSurface?.primitive) {
            _viewer?.scene?.primitives?.remove(_hexSurface.primitive);
            _hexSurface = null;
          }
          return;
        }
      }
    } finally {
      if (gen === _hexGen) {
        _loading = false;
        if (_hexAbort === abort) _hexAbort = null;
      }
      notify();
    }
  }

  /** Keep the hex surface in step with the view, the variant and the mode. */
  function syncHexes() {
    if (!_enabled || !_hexes || !_viewer?.scene?.primitives) {
      unmountHexes();
      return;
    }
    const now = viewNow();
    const view = { lat: now.lat, lon: now.lon, heightM: now.height };
    const res = h3ResolutionForHeight(view.heightM);
    if (
      _hexMadeFor &&
      _hexMadeFor.res === res &&
      _hexMadeFor.variant === _variant &&
      _hexMadeFor.scale === scaleToken() &&
      !hexViewMoved(_hexMadeFor, view)
    )
      return;
    // A new colour scale over the cells held: repainted, not asked again.
    if (
      _hexMadeFor &&
      _hexData &&
      _hexMadeFor.res === res &&
      _hexMadeFor.variant === _variant &&
      !hexViewMoved(_hexMadeFor, view)
    ) {
      mountHexes(_hexData, { ..._hexMadeFor, scale: scaleToken() });
      return;
    }
    void loadHexes(view);
  }

  /** Drape the chosen variant on the stack's host, when the server has it. */
  function sync() {
    if (_variant === POINTS_VARIANT) {
      unmount();
      unmountHexes();
      if (!_enabled) return points.hide();
      points.show(_viewer);
      const view = viewNow();
      points.sync(
        { lat: view.lat, lon: view.lon, height: view.height },
        _catalog,
      );
      return;
    }
    points.hide();
    if (_hexes) {
      unmount();
      syncHexes();
      return;
    }
    unmountHexes();
    const variant = _catalog?.variants?.get?.(_variant) || null;
    const host = imageryHost();
    _hostKind = host.kind;
    const view = viewNow();
    const drawable =
      _enabled && host.collection && _catalog?.configured && variant?.available;
    if (!drawable) {
      unmount();
      return;
    }
    const colouring = wikipediaColouring(scales, _variant, variant.domain);
    const key = `${_variant}|${variant.domain.min}|${variant.domain.max}|${_catalog.builtAt}|${scaleToken()}`;
    if (
      _imagery &&
      _mountedKey === key &&
      _collection === host.collection &&
      !viewMoved(_madeFor, view)
    )
      return;
    unmount();
    const provider = createCoverageImageryProvider({
      variant: _variant,
      domain: variant.domain,
      maximumLevel: _catalog.maxZoom,
      credit: _catalog.attribution,
      cesium,
      ...(fetchTile ? { fetchTile } : {}),
      ...(createCanvas ? { createCanvas } : {}),
      ...(colouring.isDefault ? {} : { paintValues: colouring.paint }),
    });
    const box = viewRectangleDegrees(view.lat, view.lon, view.height);
    _imagery = new cesium.ImageryLayer(provider, {
      alpha: _opacity,
      ...(box
        ? {
            rectangle: cesium.Rectangle.fromDegrees(
              box.west,
              box.south,
              box.east,
              box.north,
            ),
          }
        : {}),
    });
    host.collection.add(_imagery);
    _collection = host.collection;
    _mountedKey = key;
    _madeFor = view;
    requestRender('wikipedia-coverage-show');
    notify();
  }

  async function loadCatalog({ refresh = false } = {}) {
    _loading = true;
    notify();
    try {
      _catalog = await source.catalog({ refresh });
      _failure = null;
    } catch (error) {
      _failure = String(error?.message || error).slice(0, 200);
    } finally {
      _loading = false;
    }
    if (_enabled) sync();
    notify();
    return Boolean(_catalog);
  }

  function onMoved() {
    if (!_enabled) return;
    const before = _mountedKey;
    sync();
    if (before !== _mountedKey) notify();
  }

  function onMapSettled() {
    if (!_enabled) return;
    const before = _collection;
    const kind = _hostKind;
    sync();
    if (before !== _collection || kind !== _hostKind) notify();
  }

  function setOpacity(value) {
    _opacity = Math.min(1, Math.max(0, Number(value) || 0));
    try {
      store?.setItem(OPACITY_STORAGE_KEY, String(_opacity));
    } catch {
      /* private mode: kept for this page only */
    }
    if (_imagery) {
      _imagery.alpha = _opacity;
      requestRender('wikipedia-coverage-opacity');
    }
    if (_hexSurface) {
      // Repainted in place once the primitive is ready; before that, drawn
      // again from the data held.
      if (_hexSurface.setOpacity(_opacity))
        requestRender('wikipedia-coverage-opacity');
      else if (_hexData) mountHexes(_hexData, _hexMadeFor);
    }
    notify();
  }

  /** Switch between the raster and the H3 hexes. */
  function setHexes(on) {
    const next = Boolean(on);
    if (next === _hexes) return;
    _hexes = next;
    if (_enabled) sync();
    notify();
  }

  /** The variant's colour scale, as its hash fields ('' at the default). */
  function scaleToken() {
    const key = wikipediaScaleKey(_variant);
    const model = scales.get(key, wikipediaScaleDefaults(_variant));
    return scales.isDefault(key) ? '' : encodeScaleFields(model);
  }

  /** The row's Scale controls: the variant's window over its domain. */
  function scaleControl() {
    const domain = _hexes
      ? _hexState.domain
      : _catalog?.variants?.get?.(_variant)?.domain;
    if (!domain) return null;
    return scaleRowControl({
      store: scales,
      key: wikipediaScaleKey(_variant),
      defaults: wikipediaScaleDefaults(_variant),
      auto: { min: domain.min, max: domain.max },
    });
  }

  function setVariant(key) {
    if (!VARIANTS.some((variant) => variant.key === key) || key === _variant)
      return;
    _variant = key;
    try {
      store?.setItem(MODE_STORAGE_KEY, key);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled) sync();
    notify();
  }

  /** The Articles mode's secondary coordinates on or off (kept). */
  function setSecondary(on) {
    points.setSecondary(on);
    try {
      store?.setItem(SECONDARY_STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (_enabled) sync();
    notify();
  }

  return {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '◍',
    source: SOURCE_NAME,
    updateInterval: CATALOG_REFRESH_MS,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      _enabled = true;
      credits?.register?.(
        _viewer,
        attributionCredit(
          _catalog?.attribution || source.last?.()?.attribution,
        ),
      );
      if (_viewer?.camera?.moveEnd && !_removeMoveListener)
        _removeMoveListener = _viewer.camera.moveEnd.addEventListener(onMoved);
      // A changed colour scale for this layer repaints it.
      _removeScaleListener ||= scales.subscribe((key) => {
        if (!String(key).startsWith(`${WIKIPEDIA_SCALE_LAYER}:`)) return;
        if (_enabled) sync();
        notify();
      });
      _catalog = source.last?.() || _catalog;
      sync();
      void loadCatalog();
    },

    disable() {
      _enabled = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      _removeScaleListener?.();
      _removeScaleListener = null;
      unmount();
      unmountHexes();
      points.hide();
      notify();
    },

    async update() {
      if (!_enabled) return false;
      return loadCatalog({ refresh: true });
    },

    destroy() {
      this.disable();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = null;
      _viewer = null;
      _catalog = null;
      _rowListener = null;
    },

    getStats() {
      if (_variant === POINTS_VARIANT) {
        const status = points.status();
        const count = status?.state === 'ready' ? status.count : 0;
        return {
          count,
          countLabel: _enabled ? String(count) : '—',
          error: _failure || null,
        };
      }
      const drawn = _hexes ? _hexState.count > 0 : Boolean(_imagery);
      return {
        count: _hexes ? _hexState.count : _imagery ? 1 : 0,
        countLabel: drawn ? `${Math.round(_opacity * 100)}%` : '—',
        error: (_hexes && _hexState.failure) || _failure || null,
      };
    },

    getRowControls() {
      return rowControls({
        catalog: _catalog,
        variant: _variant,
        onVariant: setVariant,
        opacity: _opacity,
        onOpacity: setOpacity,
        loading: _loading,
        failure: _failure,
        hostless: _enabled && _hostKind === 'none',
        hexes: _hexes,
        onHexes: setHexes,
        hexState: _hexState,
        points: points.status(),
        secondary: points.secondary,
        onSecondary: setSecondary,
        // The dots have their class colours; the scale is the rasters'.
        scale: _enabled && _variant !== POINTS_VARIANT ? scaleControl() : null,
      });
    },

    /** The Hexes mode, for the owner and tests. */
    setHexes,
    /** The mode and the Articles mode's secondary coordinates, likewise. */
    setVariant,
    setSecondary,
    _points: points,

    /**
     * The map stack controller (src/app/data.js hands it to every layer):
     * where to drape, and every settled switch.
     */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _controller = controller || null;
      const off = _controller?.subscribe?.(onMapSettled);
      _unsubscribeMap = typeof off === 'function' ? off : null;
      onMapSettled();
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests and the panel. */
    _state: () => ({
      mounted: Boolean(_imagery),
      variant: _variant,
      opacity: _opacity,
      host: _imagery ? _hostKind : 'none',
      collection: _collection,
      rectangle: _imagery?.rectangle || null,
      provider: _imagery?.imageryProvider || null,
      hexes: {
        on: _hexes,
        ..._hexState,
        primitive: _hexSurface?.primitive || null,
        madeFor: _hexMadeFor,
      },
    }),
  };
}
