// Personal fork: draws the Countries basemap as a globe imagery layer at the
// bottom of viewer.imageryLayers, the slot a tile basemap's imagery takes,
// so every draped overlay (World history, Administrative boundaries, Rivers,
// the Earth Engine layers) lies over it as it does over Toner. The tiles are
// painted here from the bundled Natural Earth packs (tiles.js): country
// fills and outlines, the first-level units on tiles fine enough for the
// subdivisions style, and H3 land cells for the hex style, at the
// resolution of the camera height (one hex size on the screen). The ocean
// is the globe's base colour (index.js) showing through.
//
// Imagery tiles cannot be repainted in place, so a change of style, theme,
// opacity or colours, or of the hex resolution as the camera climbs or
// descends, swaps in a new provider and layer at the same index.

import * as Cesium from 'cesium';
import { loadBundledJson } from '../../data/bundledJson.js';
import { h3ResolutionForHeight } from '../h3Resolution.js';
import { decodePack } from './geometry.js';
import { onCountryFillChange } from './palette.js';
import {
  MAXIMUM_LEVEL,
  TILE_SIZE,
  createHexLand,
  paintCountriesTile,
  paintHexTile,
} from './tiles.js';

/** The fill opacity kept in this browser. */
export const OPACITY_STORAGE_KEY = 'gev.countries.opacity';

/** The credit line every countries style shows. */
export const NATURAL_EARTH_CREDIT =
  'Made with <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>';

const PACKS = {
  countries: new URL(
    '../../data/local_data/natural_earth/countries.json',
    import.meta.url,
  ),
  admin1: new URL(
    '../../data/local_data/natural_earth/states_provinces.json',
    import.meta.url,
  ),
};

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** The opacity stored for the basemap, else 1. */
export function readOpacity(storage) {
  try {
    const raw = storage?.getItem?.(OPACITY_STORAGE_KEY);
    const value = Number(raw);
    return raw !== null && raw !== undefined && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 1;
  } catch {
    return 1;
  }
}

function documentCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * The imagery provider of one countries look: what ImageryLayer reads of a
 * provider in Cesium 1.138 (as the World history painter), each tile
 * painted on request.
 * @param {{ cesium?: object, record: object, features: object[],
 *   units?: object[] | null, land?: object | null, hexRes?: number,
 *   opacity: number,
 *   cellFills?: Map<string, string>, createCanvas?: Function,
 *   maximumLevel?: number, now?: () => number }} options
 */
export function createCountriesImageryProvider({
  cesium = Cesium,
  record,
  features,
  units = null,
  land = null,
  hexRes,
  opacity,
  cellFills = new Map(),
  createCanvas = documentCanvas,
  maximumLevel = MAXIMUM_LEVEL,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
}) {
  const tilingScheme = new cesium.GeographicTilingScheme();
  const stats = { requested: 0, painted: 0, empty: 0, ms: 0 };
  let blank = null;
  const degrees = (radians) => (radians * 180) / Math.PI;

  /** Paint one tile on a context; the parts or cells painted. */
  function paintTile(context, x, y, level) {
    const r = tilingScheme.tileXYToRectangle(x, y, level);
    const rect = {
      west: degrees(r.west),
      south: degrees(r.south),
      east: degrees(r.east),
      north: degrees(r.north),
    };
    const options = {
      rect,
      level,
      theme: record.theme,
      opacity,
      size: TILE_SIZE,
    };
    return record.style === 'hex'
      ? paintHexTile(context, { ...options, res: hexRes, land, cellFills })
      : paintCountriesTile(context, {
          ...options,
          features,
          units,
          style: record.style,
        });
  }

  return {
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    credit: undefined,
    hasAlphaChannel: true,
    errorEvent: new cesium.Event(),
    proxy: undefined,
    tileDiscardPolicy: undefined,
    stats,
    record,
    opacity,
    hexRes,
    paintTile,

    getTileCredits() {
      return undefined;
    },

    requestImage(x, y, level) {
      stats.requested += 1;
      const started = now();
      const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
      const painted = paintTile(canvas.getContext('2d'), x, y, level);
      stats.ms += now() - started;
      if (!painted) {
        stats.empty += 1;
        blank ||= createCanvas(1, 1);
        return Promise.resolve(blank);
      }
      stats.painted += 1;
      return Promise.resolve(canvas);
    },

    pickFeatures() {
      return undefined;
    },
  };
}

/**
 * Create the renderer for one viewer.
 * @param {{ viewer: object, cesium?: object, loadPack?: (name: 'countries' | 'admin1') => Promise<object>, requestRender?: (reason: string) => void, storage?: object | null, createCanvas?: Function }} options
 */
export function createCountriesRenderer({
  viewer,
  cesium = Cesium,
  loadPack = (name) => loadBundledJson(PACKS[name]),
  requestRender = () => {},
  storage,
  createCanvas = documentCanvas,
}) {
  const store = storageOf(storage);
  let _record = null;
  let _opacity = readOpacity(store);
  let _gen = 0;
  let _destroyed = false;
  const _packs = { countries: null, admin1: null };
  const _loading = { countries: null, admin1: null };
  let _land = null; // the hex style's land cells, cached across looks
  let _layer = null;
  let _provider = null;
  let _removeMove = null;
  /** Per-cell fills (H3 index → CSS colour): the data hook. */
  let _cellFills = new Map();

  const offFill = onCountryFillChange(() => {
    if (_record) void build();
  });

  async function pack(name) {
    if (_packs[name]) return _packs[name];
    if (!_loading[name])
      _loading[name] = Promise.resolve()
        .then(() => loadPack(name))
        .then((raw) => {
          _packs[name] = decodePack(raw);
          return _packs[name];
        })
        .catch((error) => {
          _loading[name] = null;
          throw error;
        });
    return _loading[name];
  }

  /** The hex resolution of the camera's height now. */
  function cameraResolution() {
    const height = viewer?.camera?.positionCartographic?.height;
    return h3ResolutionForHeight(Number.isFinite(height) ? height : Infinity);
  }

  /** A camera move that changes the hex resolution repaints at the new one. */
  function onMoved() {
    if (_destroyed || _record?.style !== 'hex' || !_provider) return;
    if (cameraResolution() !== _provider.hexRes) void build();
  }

  function removeLayer() {
    const layer = _layer;
    _layer = null;
    _provider = null;
    if (!layer) return 0;
    const layers = viewer.imageryLayers;
    const index = layers?.indexOf?.(layer) ?? -1;
    try {
      layers?.remove?.(layer, true);
    } catch {
      /* already gone with the viewer */
    }
    return Math.max(0, index);
  }

  /** Swap in a layer painted for the current look, at the old one's index (else the bottom). */
  async function build() {
    const gen = ++_gen;
    const record = _record;
    if (!record) return;
    try {
      const features = await pack('countries');
      const units =
        record.style === 'subdivisions' ? await pack('admin1') : null;
      if (gen !== _gen || _destroyed || _record !== record) return;
      if (record.style === 'hex') _land ||= createHexLand(features);
      const provider = createCountriesImageryProvider({
        cesium,
        record,
        features,
        units,
        land: _land,
        hexRes: record.style === 'hex' ? cameraResolution() : undefined,
        opacity: _opacity,
        cellFills: new Map(_cellFills),
        createCanvas,
      });
      const index = removeLayer();
      _provider = provider;
      _layer = new cesium.ImageryLayer(provider);
      viewer.imageryLayers.add(_layer, index);
      requestRender('countries-basemap');
    } catch (error) {
      if (gen === _gen && !_destroyed)
        console.warn('[CountriesBasemap] could not draw:', error);
    }
  }

  return {
    /** Draw a style; a repeated record is a no-op. */
    show(record) {
      if (_destroyed || !record) return;
      const changed = _record?.id !== record.id;
      _record = record;
      if (viewer?.camera?.moveEnd && !_removeMove)
        _removeMove = viewer.camera.moveEnd.addEventListener(onMoved);
      if (changed) void build();
    },
    hide() {
      _gen++;
      _record = null;
      _removeMove?.();
      _removeMove = null;
      if (_layer) {
        removeLayer();
        requestRender('countries-basemap');
      }
    },
    setOpacity(value) {
      _opacity = Math.min(1, Math.max(0, Number(value) || 0));
      try {
        store?.setItem?.(OPACITY_STORAGE_KEY, String(_opacity));
      } catch {
        /* storage is a convenience */
      }
      if (_record) void build();
    },
    getOpacity: () => _opacity,
    /**
     * Colour individual hexes (H3 index → CSS colour), over the country
     * fills: the hook for data on the basemap. An empty map clears them.
     * @param {Map<string, string> | Record<string, string> | null} fills
     */
    setCellFills(fills) {
      const entries =
        fills instanceof Map ? [...fills] : Object.entries(fills || {});
      _cellFills = new Map(
        entries
          .filter(([cell, css]) => cell && css)
          .map(([cell, css]) => [String(cell).toLowerCase(), String(css)]),
      );
      if (_record?.style === 'hex') void build();
    },
    getCellFills: () => new Map(_cellFills),
    /** For tests and the owner: what is drawn. */
    getState() {
      const layers = viewer?.imageryLayers;
      return {
        activeId: _record?.id || null,
        style: _record?.style || null,
        theme: _record?.theme || null,
        opacity: _opacity,
        layer: Boolean(_layer),
        layerIndex: _layer ? (layers?.indexOf?.(_layer) ?? -1) : -1,
        hexRes: _provider?.hexRes ?? null,
        tiles: _provider ? { ..._provider.stats } : null,
        packs: {
          countries: !!_packs.countries,
          admin1: !!_packs.admin1,
        },
      };
    },
    /** The layer drawn now, for tests and the harness. */
    getLayer: () => _layer,
    /** Settled drawing, for tests: resolves once pending builds finished. */
    async settled() {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    destroy() {
      if (_destroyed) return;
      this.hide();
      _destroyed = true;
      offFill();
    },
  };
}
