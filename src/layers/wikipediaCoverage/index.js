import * as Cesium from 'cesium';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { viewMoved, viewRectangleDegrees } from '../earthEngine/index.js';
import { DEFAULT_VARIANT, VARIANTS, rowControls } from './presentation.js';
import { createCoverageImageryProvider } from './provider.js';

/**
 * Personal fork: the Wikipedia coverage layer (ANALYSIS in the DATA LAYERS
 * panel): where English Wikipedia has written about the Earth, as a heat
 * raster draped on the globe, in the spirit of the Oxford Internet
 * Institute's maps of the geographies of Wikipedia. The local server
 * (server/providers/wikipediaCoverage.js) serves cell values from a grid
 * built by `npm run wikipedia:build`; the browser paints them with a log
 * colour ramp (provider.js, ramp.js).
 *
 * Three variants, switched with the row's chips: articles per km² (the
 * default), bytes of article text per km² when the build included the page
 * table, and raw article counts. The row also carries the ramp as a legend
 * with the variant's floor and ceiling, an opacity slider (kept in this
 * browser as gev.wikipediaCoverage.opacity) and a status line.
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
export const LAYER_NAME = 'Wikipedia coverage';
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

/**
 * @param {{source: {catalog: Function, last?: Function}, cesium?: object,
 *   requestRender?: (reason: string) => void, storage?: Storage|null,
 *   credits?: {register?: Function}, fetchTile?: Function,
 *   createCanvas?: Function}} options
 */
export function createWikipediaCoverageLayer({
  source,
  cesium = Cesium,
  requestRender = () => {},
  storage,
  credits,
  fetchTile,
  createCanvas,
}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _imagery = null;
  let _mountedKey = '';
  let _catalog = null;
  let _loading = false;
  let _failure = null;
  let _opacity = readOpacity(store);
  let _variant = DEFAULT_VARIANT;
  let _removeMoveListener = null;
  let _rowListener = null;
  let _controller = null;
  let _unsubscribeMap = null;
  let _collection = null;
  let _hostKind = 'globe';
  let _madeFor = null;
  const notify = () => {
    try {
      _rowListener?.();
    } catch {
      /* the panel's problem */
    }
  };

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

  /** Drape the chosen variant on the stack's host, when the server has it. */
  function sync() {
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
    const key = `${_variant}|${variant.domain.min}|${variant.domain.max}|${_catalog.builtAt}`;
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
    notify();
  }

  function setVariant(key) {
    if (!VARIANTS.some((variant) => variant.key === key) || key === _variant)
      return;
    _variant = key;
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
      _catalog = source.last?.() || _catalog;
      sync();
      void loadCatalog();
    },

    disable() {
      _enabled = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      unmount();
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
      return {
        count: _imagery ? 1 : 0,
        countLabel: _imagery ? `${Math.round(_opacity * 100)}%` : '—',
        error: _failure || null,
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
      });
    },

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
    }),
  };
}
