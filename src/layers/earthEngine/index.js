import * as Cesium from 'cesium';
import {
  layerInks,
  layerModes,
  layerVariants,
  riverHeightForCanvas,
  variantForHeight,
} from '../../data/earthEngineLayers.js';
import {
  DEM_BANDS,
  demBand,
  maxZoomInRect,
  sourceNamesAt,
  sourcesInRect,
} from '../../data/demStack.js';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { activeLuminance, readInkSetting, resolveInk } from '../../maps/ink.js';
import {
  SLOW_DISTRICTS_ABOVE_M,
  demSourceText,
  rowControls,
} from './presentation.js';
import { ZOOM_VARIANT, tileTemplate } from './source.js';
// Personal fork: the shared colour-scale model's choice for this layer.
import {
  eeScaleDefaults,
  eeSliderRange,
  encodeScaleToken,
  takesScale,
} from '../../data/earthEngineScale.js';
import { scaleKey } from '../../maps/colourScale.js';
import { scaleRowControl } from '../../ui/colourScaleWidget.js';
import { censusScaleControl, censusTileScaleToken } from '../census/scale.js';

/** Wait this long after a colour scale settles before asking for new tiles. */
export const SCALE_DEBOUNCE_MS = 300;
import { riversV2ImageryOptions, riversV2Ready } from '../riversV2/source.js';
import {
  inOvertureBuildings,
  overtureBuildingsImageryOptions,
} from './overtureBuildings.js';
import { censusImageryOptions, censusModeMessage } from '../census/source.js';
import {
  overtureBoundariesImageryOptions,
  overtureBoundariesReady,
} from './overtureBoundaries.js';

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
 *   planet-sized primitive ask for every tile of that level, and Cesium
 *   1.138 drapes at most 10 textures on one primitive (the rest are
 *   dropped: a hard-edged patch). The Rivers, whose bands name the zooms
 *   they are drawn at, go through the server's `zoom` variant (each tile
 *   drawn by the band of its own zoom, every zoom quick), at minimumLevel 0
 *   on the globe and on a tileset alike; only a band asked for by name
 *   (an older server) keeps its `minZoom` on the globe.
 *
 * The terrain layers (`demStack`: slope, aspect, hillshade, Elevation and
 * Elevation contours) are drawn the same way, through the server's `zoom`
 * variant, each tile by the DEM stack's band for its zoom (src/data/
 * demStack.js; a contour band names its stack band in `stack`). The row names the
 * source under the middle of the view at the band the height picks
 * ("FABDEM 30 m", "USGS 3DEP 10 m", "ArcticDEM 2 m"…); the credit line
 * names the sources the view's square can show (the provider is made again
 * when they change) and each one's notice joins the data-attribution
 * popover the first time it draws (`demCredit`); and the overlay asks as
 * deep as the deepest source in the square goes (FABDEM z 14, 3DEP 1 m
 * z 17: maxZoomInRect).
 *
 * A layer with `modes` (the Rivers: NETWORK, FREE-FLOWING, PRESSURE;
 * Population: one per epoch) draws the mode a chip picks, kept as the
 * record's `modeStorageKey`; a layer
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

/**
 * The data-attribution popover's entry for a layer (Earth Engine, then the
 * dataset). A terrain layer's elevation sources have entries of their own,
 * added as each first draws (`demCredit`).
 */
export function attributionCredit(record) {
  return {
    key: `earth-engine-${record.id}`,
    html: record.demStack
      ? `${escapeHtml(record.name)}: <a href="https://earthengine.google.com/" target="_blank" rel="noopener">Google Earth Engine</a> · elevation from the sources credited below`
      : `${escapeHtml(record.name)}: <a href="https://earthengine.google.com/" target="_blank" rel="noopener">Google Earth Engine</a> · ${escapeHtml(record.attribution)}`,
  };
}

/**
 * The DEM stack band a terrain layer draws at the middle of the view, by
 * its variant's key: the variant's `stack` (a contour band's, 'c100-polar'
 * → 'polar'), else the key itself.
 */
const bandByKey = (record, key) =>
  demBand(
    layerVariants(record).find((variant) => variant.key === key)?.stack ?? key,
  ) || DEM_BANDS[DEM_BANDS.length - 1];

/**
 * The elevation sources a terrain view can show: those of the band at the
 * middle of the view and of each finer band down to the deepest level asked
 * for (a tilted view drapes finer tiles in front), inside the view's square
 * (null: the world), bottom first.
 */
export function demSourcesInView(record, bandKey, box, maximumLevel) {
  const from = DEM_BANDS.indexOf(bandByKey(record, bandKey));
  const seen = new Set();
  const out = [];
  for (const band of DEM_BANDS.slice(Math.max(0, from)))
    if (band.zooms[0] <= maximumLevel || band === DEM_BANDS[from])
      for (const entry of sourcesInRect(box, band, {
        heights: record.variants?.some?.((variant) => variant.heights),
      }))
        if (!seen.has(entry.key)) {
          seen.add(entry.key);
          out.push(entry);
        }
  return out;
}

/** A terrain view's credit line: Earth Engine, then each source's notice. */
export const demCreditText = (sources) =>
  ['Google Earth Engine', ...sources.map((s) => `${s.name}: ${s.credit}`)].join(
    ' · ',
  );

/**
 * @param {{record: object, source: {catalog: Function, last?: Function},
 *   cesium?: object, requestRender?: (reason: string) => void,
 *   storage?: Storage|null, credits?: {register?: Function},
 *   names?: {enable: Function, update: Function, disable: Function}|null,
 *   clicks?: {enable: Function, disable: Function}|null,
 *   v2Source?: {status: Function, last?: Function}|null,
 *   v2Credit?: {key: string, html: string}|null,
 *   demCredit?: ((source: object) => {key: string, html: string})|null}} options
 *   `names`: the record's names companion (riverNames.js), if it has one;
 *   `clicks`: its click companion (riverClicks.js), attached while it is
 *   on; `v2Source`: for a record with `americasV2`, the HydroSHEDS v2
 *   status (src/layers/riversV2/source.js): while it is ready, NETWORK draws
 *   the Americas from v2's tiles and the rest from Earth Engine's
 *   `network-rest` maps, and `v2Credit` is registered; `demCredit`: for a
 *   terrain layer, a DEM source's popover entry (src/data/dataCredits.js
 *   demSourceCredit), registered when the source first draws;
 *   `countriesSource`: for a record whose variant is `local:
 *   'overture-boundaries'`, the Overture country lines' status
 *   (./overtureBoundaries.js): while they are built, that variant (and
 *   AUTO from its `localAutoAboveM` up) draws their tiles in place of
 *   Earth Engine's, and `countriesCredit` is registered.
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
  localSource = null,
  demCredit = null,
  overtureSource = null,
  overtureCredit = null,
  countriesSource = null,
  countriesCredit = null,
  colourScales = null,
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = (...args) => clearTimeout(...args),
}) {
  const store = storageOf(storage);
  /** The colour-scale model's subscription and the pending rebuild. */
  let _offScales = null;
  let _scaleTimer = null;
  /**
   * The token of the colour scale chosen for a mode ('' for the layer's own
   * look: no model, a layer without a window, or the default scale), so an
   * untouched layer keeps its map, its hash and its tiles.
   */
  function scaleTokenFor(mode) {
    if (!colourScales?.getScale) return '';
    const modeKey = mode === 'default' ? '' : mode;
    if (!takesScale(record.id, modeKey)) return '';
    let model = null;
    try {
      // The store learns this layer (mode)'s defaults before it is asked.
      colourScales.get?.(
        scaleKey(record.id, modeKey),
        eeScaleDefaults(record.id, modeKey),
      );
      model = colourScales.getScale(record.id, modeKey);
    } catch {
      model = null;
    }
    return model ? encodeScaleToken(record.id, modeKey, model) : '';
  }
  /**
   * The row's colour-scale widget for the mode drawn: the Earth Engine
   * window, or a local mode's (the Census tracts' income and LST); null
   * without the app's store or a window.
   */
  function scaleControl() {
    if (!colourScales?.get) return null;
    if (localMode()) return censusScaleControl(_mode, colourScales);
    const mode = record.modes?.length ? _mode : '';
    const defaults = eeScaleDefaults(record.id, mode);
    if (!defaults || !takesScale(record.id, mode)) return null;
    return scaleRowControl({
      store: colourScales,
      key: scaleKey(record.id, mode),
      defaults,
      auto: defaults.range,
      range: eeSliderRange(record.id, mode),
    });
  }
  /** A scale changed: draw it once it has settled (only this layer's keys). */
  function onScaleChange(key) {
    if (
      typeof key === 'string' &&
      key !== record.id &&
      !key.startsWith(`${record.id}:`)
    )
      return;
    clearTimeoutImpl(_scaleTimer);
    _scaleTimer = setTimeoutImpl(() => {
      _scaleTimer = null;
      if (_enabled) sync();
    }, SCALE_DEBOUNCE_MS);
  }
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
  const zoomBands = layerVariants(record).every((variant) => variant.zooms);
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
  /** A terrain layer: the elevation sources the mounted overlay credits. */
  let _demSources = [];
  /** HydroSHEDS v2's status, and its imagery over the Americas when drawn. */
  let _v2Status = null;
  /** A local mode's server status (the Census tracts' income), when asked. */
  let _localStatus = null;
  let _v2Imagery = null;
  /** Overture's buildings (the Buildings layer, outside Open Buildings). */
  let _overtureStatus = null;
  let _overtureImagery = null;
  /** Overture's country lines (COUNTRIES, and AUTO from orbit). */
  let _countriesStatus = null;
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

  /** Whether the point under the view lies in the layer's `coverage` boxes. */
  function viewInCoverage() {
    const { lat, lon } = viewNow();
    return record.coverage.boxes.some(
      ([west, south, east, north]) =>
        lat >= south && lat <= north && lon >= west && lon <= east,
    );
  }

  /** The variant to draw: the forced level, else the height rule. */
  function wantedVariant() {
    if (
      _level !== 'auto' &&
      layerVariants(record).some((variant) => variant.key === _level)
    )
      return _level;
    // A variant with local tiles joins AUTO from its height up while they
    // are built (the Overture country lines from orbit).
    const height = bandHeight();
    const local = layerVariants(record).find(
      (variant) =>
        Number.isFinite(variant.localAutoAboveM) &&
        height >= variant.localAutoAboveM &&
        localVariantReady(variant),
    );
    return local ? local.key : variantForHeight(record, height).key;
  }

  /** Whether a variant's local tiles are built (in the ink drawn now). */
  function localVariantReady(variant, ink = wantedInk()) {
    return Boolean(
      variant?.local === 'overture-boundaries' &&
      countriesSource &&
      overtureBoundariesReady(_countriesStatus, ink),
    );
  }

  /** The variant drawn now, when its local tiles draw it; else null. */
  function localVariant() {
    const key = wantedVariant();
    const variant = layerVariants(record).find((entry) => entry.key === key);
    return localVariantReady(variant) ? variant : null;
  }

  /**
   * The height the bands are picked by: the camera's, or for bands matched
   * to Cesium's zooms (the Rivers' `zooms`) the height a 1,600 px canvas
   * would drape this canvas's zoom at (riverHeightForCanvas).
   */
  function bandHeight() {
    const height = cameraHeight();
    if (!zoomBands) return height;
    const canvas = _viewer?.scene?.canvas;
    return riverHeightForCanvas(
      height,
      canvas?.clientWidth,
      canvas?.clientHeight,
    );
  }

  /** A terrain layer: what the row calls the elevation under the view. */
  function demSourceName() {
    const view = viewNow();
    return demSourceText(
      sourceNamesAt(view.lat, view.lon, bandByKey(record, wantedVariant()), {
        heights: layerVariants(record).some((variant) => variant.heights),
      }),
    );
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
      if (_overtureImagery) _collection?.remove(_overtureImagery, true);
    } catch {
      /* already gone with its tileset or the viewer */
    }
    _imagery = null;
    _v2Imagery = null;
    _overtureImagery = null;
    _collection = null;
    _mountedKey = '';
    _madeFor = null;
    requestRender('earth-engine-hide');
  }

  /** Drape the variant the camera wants, on the stack's host, when the server can draw it. */
  /** The mode drawn by a local server (`local`), or null. */
  function localMode() {
    const entry = (record.modes || []).find((mode) => mode.key === _mode);
    return entry?.local && localSource ? entry : null;
  }

  /** A local mode: its server's tiles in place of Earth Engine's. */
  function syncLocal(host, view) {
    // A changed census scale rides on the URL, so the mount key changes.
    const options = censusImageryOptions(_localStatus, _mode, {
      scaleToken: colourScales?.get
        ? censusTileScaleToken(_mode, colourScales)
        : '',
    });
    if (!options) {
      unmount();
      notify();
      return;
    }
    mountLocal(host, view, options, `local|${_mode}|${options.url}`);
  }

  /** A local variant (the Overture country lines) in the ink drawn now. */
  function syncLocalVariant(host, view, variant) {
    const ink = wantedInk();
    const options = overtureBoundariesImageryOptions(_countriesStatus, ink);
    if (!options) {
      unmount();
      notify();
      return;
    }
    // Keyed as Earth Engine's are (variant, ink, …, mode) for the row.
    mountLocal(
      host,
      view,
      options,
      `${variant.key}|${ink}|local|default|${options.url}`,
    );
    if (countriesCredit) credits?.register?.(_viewer, countriesCredit);
  }

  /** A local server's tiles over the view's square, under `key`. */
  function mountLocal(host, view, options, key) {
    if (
      _imagery &&
      _mountedKey === key &&
      _collection === host.collection &&
      !viewMoved(_madeFor, view)
    )
      return;
    unmount();
    const box = viewRectangleDegrees(view.lat, view.lon, view.height);
    const { url, credit, ...levels } = options;
    const provider = new cesium.UrlTemplateImageryProvider({
      url,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      ...levels,
      // On a tileset Cesium drapes each primitive at the level that spans
      // it: the server answers a coarser tile with a transparent one.
      minimumLevel: host.kind === 'tileset' ? 0 : levels.minimumLevel,
      credit,
    });
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
    requestRender('earth-engine-show');
    notify();
  }

  function sync() {
    const layer = _catalog?.layers?.get?.(record.id);
    const host = imageryHost();
    _hostKind = host.kind;
    const view = viewNow();
    _aboveCeiling = view.height > (record.maxHeightM ?? Infinity);
    if (localMode()) {
      if (_enabled && host.collection && !_aboveCeiling) syncLocal(host, view);
      else unmount();
      return;
    }
    // Earth Engine is not asked: the local tiles draw without it.
    const local = localVariant();
    if (local) {
      if (_enabled && host.collection && !_aboveCeiling)
        syncLocalVariant(host, view, local);
      else unmount();
      return;
    }
    const drawable =
      _enabled &&
      host.collection &&
      _catalog?.configured &&
      layer &&
      !_aboveCeiling;
    if (_enabled) names?.update(view, wantedInk());
    const overtureOptions =
      _enabled && host.collection && !_aboveCeiling
        ? overtureOptionsNow()
        : null;
    if (!drawable) {
      // Earth Engine not set up: Overture's buildings still draw.
      if (overtureOptions) mountOvertureOnly(host, view, overtureOptions);
      else unmount();
      return;
    }
    const ink = wantedInk();
    const useV2 = v2Drawn(ink);
    // While v2 draws the Americas, Earth Engine draws the rest of the world.
    const mode = hasModes ? (useV2 ? 'network-rest' : _mode) : 'default';
    const v2Version = useV2 ? _v2Status.versions[ink] : '';
    // Bands matched to zooms (the Rivers) are drawn through the server's
    // `zoom` variant: each tile by the band of its own zoom, as v2's are,
    // so the two agree tile by tile on any canvas and on a 3D tileset
    // (which drapes each primitive at the level that spans it, not the
    // view's). The band by height still names the orders in the row.
    const byZoom =
      zoomBands &&
      layer.variants?.some?.((entry) => entry.key === ZOOM_VARIANT) &&
      !layerVariants(record).some((entry) => entry.key === _level);
    const variant = byZoom ? ZOOM_VARIANT : wantedVariant();
    const served = layer.variants?.find?.((entry) => entry.key === variant);
    const version =
      (hasModes
        ? served?.modeVersions?.[mode]?.[ink]
        : served?.versions?.[ink]) || '';
    const box = viewRectangleDegrees(view.lat, view.lon, view.height);
    const layerMax = layer.maxZoom ?? record.maxZoom ?? 12;
    // A terrain layer asks as deep as the deepest elevation source in the
    // view's square goes, and credits the sources the square can show.
    const maximumLevel = record.demStack
      ? Math.min(layerMax, maxZoomInRect(box, record.maxZoom ?? layerMax))
      : layerMax;
    const demSources = record.demStack
      ? demSourcesInView(record, wantedVariant(), box, maximumLevel)
      : [];
    const scaleToken = scaleTokenFor(mode);
    const key = `${variant}|${ink}|${version}|${mode}|${v2Version}|${maximumLevel}|${demSources.map((entry) => entry.key).join(',')}|${overtureOptions?.url || ''}|${scaleToken}`;
    if (
      _imagery &&
      _mountedKey === key &&
      _collection === host.collection &&
      !viewMoved(_madeFor, view)
    )
      return;
    unmount();
    // The levels Cesium asks for. On a 3D tileset it drapes about one
    // imagery tile on each loaded primitive at the level that spans it,
    // clamped up to minimumLevel, and keeps at most 10 draped textures per
    // primitive (Cesium 1.138's ImageryPipelineStage truncates the rest):
    // a raised minimum made a continent-sized primitive at orbit need 16 to
    // 33 tiles and draw only the first 10, a hard-edged patch. So on a
    // tileset, and for the zoom variant (whose every zoom is quick), the
    // level is Cesium's own; a band by height on the globe keeps its first
    // level (bounded by the view's square), and the server answers any
    // coarser tile with the band of that zoom (coarseVariant).
    const minimumLevel =
      host.kind === 'tileset' || variant === ZOOM_VARIANT
        ? 0
        : (served?.minZoom ??
          layerVariants(record).find((entry) => entry.key === variant)
            ?.minZoom ??
          0);
    const provider = new cesium.UrlTemplateImageryProvider({
      url: tileTemplate(record.id, variant, ink, version, mode, scaleToken),
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      minimumLevel,
      maximumLevel,
      credit: record.demStack
        ? demCreditText(demSources)
        : layer.attribution || record.attribution,
      hasAlphaChannel: true,
    });
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
    if (useV2)
      mountV2(host.collection, ink, box, { minimumLevel, maximumLevel });
    if (overtureOptions)
      _overtureImagery = overtureLayer(
        host.collection,
        overtureOptions,
        box,
        minimumLevel,
      );
    _demSources = demSources;
    if (demCredit)
      for (const entry of demSources)
        credits?.register?.(_viewer, demCredit(entry));
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
  function mountV2(collection, ink, box, levels) {
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
      // The Earth Engine side's levels, so v2 is no sharper or blurrier.
      ...levels,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      ...(extentRectangle ? { rectangle: extentRectangle } : {}),
    });
    if (!provider.rectangle) return;
    _v2Imagery = new cesium.ImageryLayer(provider, {
      alpha: _opacity,
      ...(clip ? { rectangle: clip } : {}),
    });
    collection.add(_v2Imagery);
    if (v2Credit) credits?.register?.(_viewer, v2Credit);
  }

  /** Overture's buildings for the mode and ink drawn now, or null. */
  function overtureOptionsNow() {
    if (!record.overture || !overtureSource) return null;
    return overtureBuildingsImageryOptions(
      _overtureStatus,
      hasModes ? _mode : 'count',
      wantedInk(),
    );
  }

  /**
   * Overture's buildings over the build's regions that meet the view's
   * square, at the layer's opacity. They hold nothing inside an Open
   * Buildings box, so they sit beside Earth Engine's tiles, never over
   * them. Returns the imagery layer, or null when no region is in view.
   */
  function overtureLayer(collection, options, box, minimumLevel = 0) {
    const { boxes, ...rest } = options;
    const meets = boxes.filter(
      ([west, south, east, north]) =>
        !box ||
        (west <= box.east &&
          east >= box.west &&
          south <= box.north &&
          north >= box.south),
    );
    if (!meets.length) return null;
    const extent = [
      Math.min(...meets.map((b) => b[0])),
      Math.min(...meets.map((b) => b[1])),
      Math.max(...meets.map((b) => b[2])),
      Math.max(...meets.map((b) => b[3])),
    ];
    const clip = box
      ? [
          Math.max(extent[0], box.west),
          Math.max(extent[1], box.south),
          Math.min(extent[2], box.east),
          Math.min(extent[3], box.north),
        ]
      : extent;
    if (!(clip[0] < clip[2] && clip[1] < clip[3])) return null;
    const provider = new cesium.UrlTemplateImageryProvider({
      ...rest,
      minimumLevel,
      tilingScheme: new cesium.WebMercatorTilingScheme(),
      rectangle: cesium.Rectangle.fromDegrees(...extent),
    });
    // A provider rectangle that misses Web Mercator's is undefined, and a
    // layer over it throws in every frame (src/maps/imageryHost.js).
    if (!provider.rectangle) return null;
    const layer = new cesium.ImageryLayer(provider, {
      alpha: _opacity,
      rectangle: cesium.Rectangle.fromDegrees(...clip),
    });
    collection.add(layer);
    if (overtureCredit) credits?.register?.(_viewer, overtureCredit);
    return layer;
  }

  /** Earth Engine is not set up: Overture's buildings alone. */
  function mountOvertureOnly(host, view, options) {
    const key = `overture|${options.url}`;
    if (
      _imagery &&
      _mountedKey === key &&
      _collection === host.collection &&
      !viewMoved(_madeFor, view)
    )
      return;
    unmount();
    const box = viewRectangleDegrees(view.lat, view.lon, view.height);
    _imagery = overtureLayer(host.collection, options, box);
    if (!_imagery) {
      notify();
      return;
    }
    _collection = host.collection;
    _mountedKey = key;
    _madeFor = view;
    requestRender('earth-engine-show');
    notify();
  }

  /** Overture's buildings status: a failure reads as not built. */
  async function loadOverture({ refresh = false } = {}) {
    if (!record.overture || !overtureSource) return;
    try {
      _overtureStatus = await overtureSource.status({ refresh });
    } catch {
      _overtureStatus = null;
    }
    if (_enabled) sync();
    notify();
  }

  /** Whether Overture's buildings speak for the view (outside Open Buildings). */
  function overtureHere() {
    if (!overtureOptionsNow()) return false;
    const { lat, lon } = viewNow();
    return inOvertureBuildings(_overtureStatus, lat, lon);
  }

  /** A local mode's server status: a failure reads as not built. */
  async function loadLocal({ refresh = false } = {}) {
    if (!localSource) return;
    try {
      _localStatus = await localSource.status({ refresh });
    } catch {
      _localStatus = null;
    }
    if (_enabled) sync();
    notify();
  }

  /** The country lines' status: a failure reads as not built (LSIB). */
  async function loadCountries({ refresh = false } = {}) {
    if (!countriesSource) return;
    try {
      _countriesStatus = await countriesSource.status({ refresh });
    } catch {
      _countriesStatus = null;
    }
    if (_enabled) sync();
    notify();
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
    if (_overtureImagery) _overtureImagery.alpha = _opacity;
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
      _localStatus = localSource?.last?.() || _localStatus;
      _overtureStatus = overtureSource?.last?.() || _overtureStatus;
      _countriesStatus = countriesSource?.last?.() || _countriesStatus;
      names?.enable();
      clicks?.enable(_viewer);
      if (colourScales?.subscribe && !_offScales) {
        const off = colourScales.subscribe(onScaleChange);
        _offScales = typeof off === 'function' ? off : null;
      }
      sync();
      void loadCatalog();
      void loadV2();
      void loadLocal();
      void loadOverture();
      void loadCountries();
    },

    disable() {
      _enabled = false;
      _offScales?.();
      _offScales = null;
      clearTimeoutImpl(_scaleTimer);
      _scaleTimer = null;
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
      void loadOverture({ refresh: true });
      void loadCountries({ refresh: true });
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
        // The band the camera's height picks names the orders, also when
        // the tiles come through the zoom variant.
        variant:
          _mountedKey && _mountedKey.split('|')[0] !== ZOOM_VARIANT
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
        // A local mode not built (no build, no CENSUS_API_KEY): what to do.
        localMessage:
          _enabled && localMode()
            ? censusModeMessage(_localStatus, _mode) ||
              (_localStatus ? '' : 'Asking the local census server…')
            : '',
        demSource: _enabled && record.demStack ? demSourceName() : '',
        // Personal fork: outside where the data is (Buildings), the row says
        // so, or that Overture's buildings are drawn there.
        outsideCoverage:
          _enabled && record.coverage && !viewInCoverage()
            ? overtureHere()
              ? 'overture-buildings'
              : record.coverage.key
            : '',
        creditTitle:
          record.demStack && _demSources.length
            ? demCreditText(_demSources)
            : '',
        scale: scaleControl(),
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
