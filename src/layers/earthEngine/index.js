import * as Cesium from 'cesium';
import {
  layerInks,
  layerModes,
  layerVariants,
  variantForHeight,
} from '../../data/earthEngineLayers.js';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { activeLuminance, readInkSetting, resolveInk } from '../../maps/ink.js';
import { SLOW_DISTRICTS_ABOVE_M, rowControls } from './presentation.js';
import { tileTemplate } from './source.js';
import { riversV2ImageryOptions, riversV2Ready } from '../riversV2/source.js';

/**
 * Personal fork: one Earth Engine overlay (src/data/earthEngineLayers.js) as
 * a Cesium imagery layer over the globe, drawn from the local server's tile
 * proxy (server/providers/earthEngine.js) so the browser never holds Earth
 * Engine's token. Its row in the DATA LAYERS panel (ANALYSIS) carries the
 * legend, an opacity slider (kept per layer in this browser) and the
 * server's status. A layer with variants (administrative levels) changes
 * variant with the camera's height on AUTO, or draws the level a chip
 * forces (kept as gev.earthEngine.level.<id>). A features layer with inks
 * is drawn in the ink the basemap wants (src/maps/ink.js: light lines on a
 * dark map, dark lines on a light one) unless a chip forces one (kept as
 * gev.earthEngine.ink.<id>); each settled map switch re-picks it, and the
 * server has one map per (variant, ink).
 *
 * It drapes where the map stack can take imagery (maps/imageryHost.js, as
 * Recent Imagery and the weather layers do): the globe's imagery layers on
 * a globe map, the photoreal tileset's own imagery layers (Cesium 1.131+)
 * when the globe is hidden. Each settled map switch re-drapes it on the new
 * host; a stack with neither says so in the row.
 *
 * Tile budget. On a 3D tileset Cesium drapes about one imagery tile (up to
 * nine) on every loaded primitive, at the level that spans it, and the
 * tileset loads every ancestor from the planet-wide root down: unbounded, a
 * 60 km view over Baltimore asked for about 1,200 tiles, mostly coarse ones
 * far from the view, where the globe asks for under 150. So each overlay:
 * - covers only the view's neighbourhood (an ImageryLayer rectangle, a
 *   square of 6 × the camera height around the point under the view,
 *   rebuilt when the view leaves it or the height doubles or halves; the
 *   browser and the server's disk keep the tiles, so a rebuild costs no
 *   Earth Engine tiles);
 * - draws nothing above its record's maxHeightM (terrain says nothing from
 *   orbit);
 * - asks no deeper than its maxZoom. Its minimumLevel stays 0: Cesium
 *   clamps a primitive's level up to it, so a raised minimum would make a
 *   planet-sized primitive ask for every tile of that level. The exception
 *   is a variant with a `minZoom` (the Rivers bands, whose coarse tiles
 *   Earth Engine cannot draw in time): it asks for nothing coarser, which
 *   is at most the 64 tiles of z 3 from orbit, and inside the view's square
 *   below that.
 *
 * A layer with `modes` (the Rivers: NETWORK, FREE-FLOWING, PRESSURE) draws
 * the mode a chip picks, kept as the record's `modeStorageKey`; a layer
 * with `names` gets a names companion (`names`, src/layers/earthEngine/
 * riverNames.js) that it shows, updates on each settled view and ink, and
 * hides with it.
 */

export const OPACITY_STORAGE_PREFIX = 'gev.earthEngine.opacity.';
export const INK_STORAGE_PREFIX = 'gev.earthEngine.ink.';
export const LEVEL_STORAGE_PREFIX = 'gev.earthEngine.level.';
/** The overlay's rectangle: half its side is this many camera heights… */
export const VIEW_HALF_FACTOR = 3;
/** …and at least this many metres. */
export const MIN_VIEW_HALF_M = 20_000;
/** Past this half-side, the whole world (the view is the planet). */
const WORLD_HALF_M = 5_000_000;
const EARTH_RADIUS_M = 6_378_137;

/**
 * The view's neighbourhood: a square of 2 × VIEW_HALF_FACTOR camera heights
 * around a point, in degrees, or null for the whole world.
 */
export function viewRectangleDegrees(lat, lon, heightM) {
  const half = Math.max(MIN_VIEW_HALF_M, VIEW_HALF_FACTOR * heightM);
  if (!Number.isFinite(half) || half >= WORLD_HALF_M) return null;
  const dLat = (half / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return {
    west: Math.max(-180, lon - dLon),
    south: Math.max(-85, lat - dLat),
    east: Math.min(180, lon + dLon),
    north: Math.min(85, lat + dLat),
  };
}

/** Whether a view has left the one an overlay's rectangle was made for. */
export function viewMoved(made, now) {
  if (!made) return true;
  if (!Number.isFinite(now.height) || !Number.isFinite(made.height))
    return true;
  const ratio = now.height / made.height;
  if (ratio > 2 || ratio < 0.5) return true;
  const half = Math.max(MIN_VIEW_HALF_M, VIEW_HALF_FACTOR * made.height);
  const dy = ((now.lat - made.lat) * Math.PI * EARTH_RADIUS_M) / 180;
  const dx =
    ((now.lon - made.lon) *
      Math.PI *
      EARTH_RADIUS_M *
      Math.cos((made.lat * Math.PI) / 180)) /
    180;
  // Half the way to the edge: rebuilt before the view reaches it.
  return Math.max(Math.abs(dx), Math.abs(dy)) > half / 2;
}
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

/** The level stored for a layer ('auto' or one of its variant keys), else 'auto'. */
export function readLevel(storage, record) {
  try {
    const value = storage?.getItem(`${LEVEL_STORAGE_PREFIX}${record.id}`);
    return (record.variants || []).some((variant) => variant.key === value)
      ? value
      : 'auto';
  } catch {
    return 'auto';
  }
}

/** A layer's modes a chip can pick: all but the hidden ones (network-rest). */
export function chipModes(record) {
  const shown = (record?.modes || []).filter((mode) => !mode.hidden);
  return shown.length ? shown.map((mode) => mode.key) : layerModes(record);
}

/** The mode stored for a layer with modes (one a chip can pick), else its first. */
export function readMode(storage, record) {
  const modes = chipModes(record);
  try {
    const value = record.modeStorageKey
      ? storage?.getItem(record.modeStorageKey)
      : null;
    return modes.includes(value) ? value : modes[0];
  } catch {
    return modes[0];
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
 *   storage?: Storage|null, credits?: {register?: Function},
 *   names?: {enable: Function, update: Function, disable: Function}|null,
 *   clicks?: {enable: Function, disable: Function}|null,
 *   v2Source?: {status: Function, last?: Function}|null,
 *   v2Credit?: {key: string, html: string}|null}} options
 *   `names`: the record's names companion (riverNames.js), if it has one;
 *   `clicks`: its click companion (riverClicks.js), attached while it is
 *   on; `v2Source`: for a record with `americasV2`, the HydroSHEDS v2
 *   status (src/layers/riversV2/source.js): while it is ready, NETWORK draws
 *   the Americas from v2's tiles and the rest from Earth Engine's
 *   `network-rest` maps, and `v2Credit` is registered.
 */
export function createEarthEngineLayer({
  record,
  source,
  cesium = Cesium,
  requestRender = () => {},
  storage,
  credits,
  names = null,
  clicks = null,
  v2Source = null,
  v2Credit = null,
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
  /** 'auto' or a variant key; 'auto' or an ink. */
  let _level = readLevel(store, record);
  let _inkSetting = readInkSetting(store, `${INK_STORAGE_PREFIX}${record.id}`);
  const hasInks = layerInks(record)[0] !== 'default';
  const hasModes = layerModes(record)[0] !== 'default';
  /** The mode drawn ('default' for a layer without modes). */
  let _mode = readMode(store, record);
  let _removeMoveListener = null;
  let _rowListener = null;
  /** The map stack controller (src/maps/controller.js), when attached. */
  let _controller = null;
  let _unsubscribeMap = null;
  /** The collection the overlay is draped on, and what kind of host it is. */
  let _collection = null;
  let _hostKind = 'globe';
  /** The view the mounted rectangle was made for. */
  let _madeFor = null;
  let _aboveCeiling = false;
  /** HydroSHEDS v2's status, and its imagery over the Americas when drawn. */
  let _v2Status = null;
  let _v2Imagery = null;
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

  /** The variant to draw: the forced level, else the height rule. */
  function wantedVariant() {
    if (
      _level !== 'auto' &&
      layerVariants(record).some((variant) => variant.key === _level)
    )
      return _level;
    return variantForHeight(record, cameraHeight()).key;
  }

  /** The ink to draw: the forced one, else what the basemap wants. */
  function wantedInk() {
    if (!hasInks) return 'default';
    return resolveInk(_inkSetting, activeLuminance(_controller));
  }

  /** Districts forced from far out: the row warns that tiles are slow. */
  function slowDistricts() {
    return (
      _level === 'level2' &&
      cameraHeight() > SLOW_DISTRICTS_ABOVE_M &&
      _mountedKey.startsWith('level2|')
    );
  }

  /** Where imagery can be draped on the current map stack. */
  function imageryHost() {
    // Without a controller (tests, an older shell), the globe's collection.
    if (!_controller)
      return _viewer?.imageryLayers
        ? { collection: _viewer.imageryLayers, kind: 'globe' }
        : { collection: null, kind: 'none' };
    return resolveImageryHost({
      viewer: _viewer,
      tileset: _controller.getImageryHostTileset?.() || null,
    });
  }

  /** Whether NETWORK draws the Americas from HydroSHEDS v2 in an ink. */
  function v2Drawn(ink) {
    return Boolean(
      record.americasV2 &&
      v2Source &&
      hasModes &&
      _mode === 'network' &&
      riversV2Ready(_v2Status, ink),
    );
  }

  function unmount() {
    if (!_imagery) return;
    try {
      _collection?.remove(_imagery, true);
      if (_v2Imagery) _collection?.remove(_v2Imagery, true);
    } catch {
      /* already gone with its tileset or the viewer */
    }
    _imagery = null;
    _v2Imagery = null;
    _collection = null;
    _mountedKey = '';
    _madeFor = null;
    requestRender('earth-engine-hide');
  }

  /** Drape the variant the camera wants, on the stack's host, when the server can draw it. */
  function sync() {
    const layer = _catalog?.layers?.get?.(record.id);
    const host = imageryHost();
    _hostKind = host.kind;
    const view = viewNow();
    _aboveCeiling = view.height > (record.maxHeightM ?? Infinity);
    const drawable =
      _enabled &&
      host.collection &&
      _catalog?.configured &&
      layer &&
      !_aboveCeiling;
    if (_enabled) names?.update(view, wantedInk());
    if (!drawable) {
      unmount();
      return;
    }
    const variant = wantedVariant();
    const ink = wantedInk();
    const useV2 = v2Drawn(ink);
    // While v2 draws the Americas, Earth Engine draws the rest of the world.
    const mode = hasModes ? (useV2 ? 'network-rest' : _mode) : 'default';
    const v2Version = useV2 ? _v2Status.versions[ink] : '';
    const served = layer.variants?.find?.((entry) => entry.key === variant);
    const version =
      (hasModes
        ? served?.modeVersions?.[mode]?.[ink]
        : served?.versions?.[ink]) || '';
    const key = `${variant}|${ink}|${version}|${mode}|${v2Version}`;
    if (
      _imagery &&
      _mountedKey === key &&
      _collection === host.collection &&
      !viewMoved(_madeFor, view)
    )
      return;
    unmount();
    const minimumLevel =
      served?.minZoom ??
      layerVariants(record).find((entry) => entry.key === variant)?.minZoom ??
      0;
    const provider = new cesium.UrlTemplateImageryProvider({
      url: tileTemplate(record.id, variant, ink, version, mode),
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      minimumLevel,
      maximumLevel: layer.maxZoom ?? record.maxZoom ?? 12,
      credit: layer.attribution || record.attribution,
      hasAlphaChannel: true,
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
    if (useV2) mountV2(host.collection, ink, box);
    _collection = host.collection;
    _mountedKey = key;
    _madeFor = view;
    requestRender('earth-engine-show');
    notify();
  }

  /**
   * HydroSHEDS v2 over the Americas: its tiles in the ink, inside its
   * extent (and the view's square, as the Earth Engine overlay), at the
   * same opacity, above the Earth Engine overlay.
   */
  function mountV2(collection, ink, box) {
    const options = riversV2ImageryOptions(_v2Status, ink);
    if (!options) return;
    const { rectangleDegrees: extent, ...rest } = options;
    const extentRectangle = extent
      ? cesium.Rectangle.fromDegrees(
          extent.west,
          extent.south,
          extent.east,
          extent.north,
        )
      : undefined;
    const viewRectangle = box
      ? cesium.Rectangle.fromDegrees(box.west, box.south, box.east, box.north)
      : undefined;
    const clip =
      extentRectangle && viewRectangle
        ? cesium.Rectangle.intersection(extentRectangle, viewRectangle)
        : extentRectangle || viewRectangle;
    // The view is away from the Americas: nothing of v2 to drape.
    if (extentRectangle && viewRectangle && !clip) return;
    const provider = new cesium.UrlTemplateImageryProvider({
      ...rest,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      ...(extentRectangle ? { rectangle: extentRectangle } : {}),
    });
    _v2Imagery = new cesium.ImageryLayer(provider, {
      alpha: _opacity,
      ...(clip ? { rectangle: clip } : {}),
    });
    collection.add(_v2Imagery);
    if (v2Credit) credits?.register?.(_viewer, v2Credit);
  }

  /** HydroSHEDS v2's status: a failure reads as not built (v1 everywhere). */
  async function loadV2({ refresh = false } = {}) {
    if (!record.americasV2 || !v2Source) return;
    try {
      _v2Status = await v2Source.status({ refresh });
    } catch {
      _v2Status = null;
    }
    if (_enabled) sync();
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

  /** A settled camera: a new level, a new neighbourhood, or past the ceiling. */
  function onMoved() {
    if (!_enabled) return;
    const before = `${_mountedKey}|${_aboveCeiling}`;
    sync();
    if (before !== `${_mountedKey}|${_aboveCeiling}`) notify();
  }

  /**
   * A settled map switch: the host may have changed (a new tileset, the
   * globe), and so may the ink the basemap wants.
   */
  function onMapSettled() {
    if (!_enabled) return;
    const before = _collection;
    const kind = _hostKind;
    const key = _mountedKey;
    sync();
    if (before !== _collection || kind !== _hostKind || key !== _mountedKey)
      notify();
  }

  function setLevel(key) {
    const known =
      key === 'auto' ||
      layerVariants(record).some((variant) => variant.key === key);
    if (!known || key === _level) return;
    _level = key;
    try {
      store?.setItem(`${LEVEL_STORAGE_PREFIX}${record.id}`, key);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled) sync();
    notify();
  }

  function setInk(key) {
    if (!['auto', 'light', 'dark'].includes(key) || key === _inkSetting) return;
    _inkSetting = key;
    try {
      store?.setItem(`${INK_STORAGE_PREFIX}${record.id}`, key);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled) sync();
    notify();
  }

  /** A mode chip: kept as the record's modeStorageKey, drawn at once. */
  function setMode(key) {
    if (!hasModes || !chipModes(record).includes(key) || key === _mode) return;
    _mode = key;
    try {
      if (record.modeStorageKey) store?.setItem(record.modeStorageKey, key);
    } catch {
      /* private mode: kept for this page only */
    }
    if (_enabled) sync();
    notify();
  }

  function setOpacity(value) {
    _opacity = Math.min(1, Math.max(0, Number(value) || 0));
    try {
      store?.setItem(`${OPACITY_STORAGE_PREFIX}${record.id}`, String(_opacity));
    } catch {
      /* private mode: kept for this page only */
    }
    if (_v2Imagery) _v2Imagery.alpha = _opacity;
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
      _v2Status = v2Source?.last?.() || _v2Status;
      names?.enable();
      clicks?.enable(_viewer);
      sync();
      void loadCatalog();
      void loadV2();
    },

    disable() {
      _enabled = false;
      _removeMoveListener?.();
      _removeMoveListener = null;
      unmount();
      names?.disable();
      clicks?.disable();
      notify();
    },

    async update() {
      if (!_enabled) return false;
      void loadV2({ refresh: true });
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
        variant: _mountedKey
          ? _mountedKey.split('|')[0]
          : record.variants?.length
            ? wantedVariant()
            : '',
        opacity: _opacity,
        onOpacity: setOpacity,
        loading: _loading,
        failure: _failure,
        hostless: _enabled && _hostKind === 'none',
        ceilingM: _enabled && _aboveCeiling ? record.maxHeightM : null,
        level: _level,
        onLevel: setLevel,
        ink: _inkSetting,
        onInk: setInk,
        inkDrawn: wantedInk(),
        slowDistricts: _enabled && slowDistricts(),
        mode: _mode,
        onMode: setMode,
        americasV2: _enabled && Boolean(_v2Imagery),
      });
    },

    /**
     * The map stack controller (src/app/data.js hands it to every layer):
     * where to drape, and every settled switch.
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

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** For tests and the panel: the variant and ink drawn, and the opacity. */
    _state: () => ({
      mounted: Boolean(_imagery),
      variant: _mountedKey ? _mountedKey.split('|')[0] : '',
      ink: _mountedKey ? _mountedKey.split('|')[1] : '',
      mode: _mountedKey ? _mountedKey.split('|')[3] : '',
      modeSetting: _mode,
      minimumLevel: _imagery?.imageryProvider?.minimumLevel ?? null,
      v2: _v2Imagery
        ? {
            url: _v2Imagery.imageryProvider.url,
            rectangle: _v2Imagery.rectangle,
            alpha: _v2Imagery.alpha,
          }
        : null,
      level: _level,
      inkSetting: _inkSetting,
      opacity: _opacity,
      host: _imagery ? _hostKind : 'none',
      collection: _collection,
      rectangle: _imagery?.rectangle || null,
      aboveCeiling: _aboveCeiling,
    }),
  };
}
