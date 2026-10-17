import * as Cesium from 'cesium';
import { variantForHeight } from '../../data/earthEngineLayers.js';
import { rowControls } from './presentation.js';
import { tileTemplate } from './source.js';

/**
 * Personal fork: one Earth Engine overlay (src/data/earthEngineLayers.js) as
 * a Cesium imagery layer over the globe, drawn from the local server's tile
 * proxy (server/providers/earthEngine.js) so the browser never holds Earth
 * Engine's token. Its row in the DATA LAYERS panel (ANALYSIS) carries the
 * legend, an opacity slider (kept per layer in this browser) and the
 * server's status. A layer with variants (administrative levels) changes
 * variant with the camera's height.
 */

export const OPACITY_STORAGE_PREFIX = 'gev.earthEngine.opacity.';
export const DEFAULT_OPACITY = 0.7;
/** The catalog (map expiry, tiles used) is read again this often while on. */
export const CATALOG_REFRESH_MS = 10 * 60 * 1000;

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The opacity stored for a layer, else the default. */
export function readOpacity(storage, id) {
  try {
    const raw = storage?.getItem(`${OPACITY_STORAGE_PREFIX}${id}`);
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

/** The data-attribution popover's entry for a layer (Earth Engine, then the dataset). */
export function attributionCredit(record) {
  return {
    key: `earth-engine-${record.id}`,
    html: `${escapeHtml(record.name)}: <a href="https://earthengine.google.com/" target="_blank" rel="noopener">Google Earth Engine</a> · ${escapeHtml(record.attribution)}`,
  };
}

/**
 * @param {{record: object, source: {catalog: Function, last?: Function},
 *   cesium?: object, requestRender?: (reason: string) => void,
 *   storage?: Storage|null, credits?: {register?: Function}}} options
 */
export function createEarthEngineLayer({
  record,
  source,
  cesium = Cesium,
  requestRender = () => {},
  storage,
  credits,
}) {
  const store = storageOf(storage);
  let _viewer = null;
  let _enabled = false;
  let _imagery = null;
  let _mountedKey = '';
  let _catalog = null;
  let _loading = false;
  let _failure = null;
  let _opacity = readOpacity(store, record.id);
  let _removeMoveListener = null;
  let _rowListener = null;
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

  function wantedVariant() {
    return variantForHeight(record, cameraHeight()).key;
  }

  function unmount() {
    if (!_imagery) return;
    try {
      _viewer?.imageryLayers?.remove(_imagery, true);
    } catch {
      /* already gone with the viewer */
    }
    _imagery = null;
    _mountedKey = '';
    requestRender('earth-engine-hide');
  }

  /** Drape the variant the camera wants, when the server can draw it. */
  function sync() {
    const layer = _catalog?.layers?.get?.(record.id);
    const drawable =
      _enabled && _viewer?.imageryLayers && _catalog?.configured && layer;
    if (!drawable) {
      unmount();
      return;
    }
    const variant = wantedVariant();
    if (_imagery && _mountedKey === variant) return;
    unmount();
    const provider = new cesium.UrlTemplateImageryProvider({
      url: tileTemplate(record.id, variant),
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      minimumLevel: 0,
      maximumLevel: layer.maxZoom ?? record.maxZoom ?? 12,
      credit: layer.attribution || record.attribution,
      hasAlphaChannel: true,
    });
    _imagery = _viewer.imageryLayers.addImageryProvider(provider);
    _imagery.alpha = _opacity;
    _mountedKey = variant;
    requestRender('earth-engine-show');
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
    if (_enabled && record.variants?.length) {
      const before = _mountedKey;
      sync();
      if (before !== _mountedKey) notify();
    }
  }

  function setOpacity(value) {
    _opacity = Math.min(1, Math.max(0, Number(value) || 0));
    try {
      store?.setItem(`${OPACITY_STORAGE_PREFIX}${record.id}`, String(_opacity));
    } catch {
      /* private mode: kept for this page only */
    }
    if (_imagery) {
      _imagery.alpha = _opacity;
      requestRender('earth-engine-opacity');
    }
    notify();
  }

  return {
    id: record.id,
    name: record.name,
    icon: '◩',
    source: 'Google Earth Engine',
    updateInterval: CATALOG_REFRESH_MS,

    init(viewer) {
      _viewer = viewer;
    },

    enable(viewer) {
      _viewer = viewer || _viewer;
      _enabled = true;
      credits?.register?.(_viewer, attributionCredit(record));
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
      _viewer = null;
      _catalog = null;
      _rowListener = null;
    },

    getStats() {
      const layer = _catalog?.layers?.get?.(record.id);
      return {
        count: _imagery ? 1 : 0,
        countLabel: _imagery ? `${Math.round(_opacity * 100)}%` : '—',
        error: _failure || layer?.error || null,
      };
    },

    getRowControls() {
      return rowControls({
        record,
        catalog: _catalog,
        variant:
          _mountedKey || (record.variants?.length ? wantedVariant() : ''),
        opacity: _opacity,
        onOpacity: setOpacity,
        loading: _loading,
        failure: _failure,
      });
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests and the panel: the variant drawn and the opacity. */
    _state: () => ({
      mounted: Boolean(_imagery),
      variant: _mountedKey,
      opacity: _opacity,
    }),
  };
}
