// Personal fork: which layers the Lego mode builds, and how: each raster
// layer's colour ramp (its own palette, on its own scale), its native cell
// size and the mode it is drawn in. Vector and point layers have no spec
// and are left alone.

import {
  EARTH_ENGINE_LAYERS,
  modeRecord,
} from '../../data/earthEngineLayers.js';
import { RAMP_STOPS } from '../wikipediaCoverage/ramp.js';
import { rgbToHex } from './model.js';

/** The layer whose values are heights: its columns are true height. */
export const ELEVATION_LAYER_ID = 'ee-elevation';
export const WIKIPEDIA_LAYER_ID = 'wikipedia-coverage';
export const CENSUS_LAYER_ID = 'ee-census-tracts';

/**
 * Native cell sizes (m) where they are known; the rest from the layer's
 * deepest tile level. The values service never needs to be asked finer.
 */
const NATIVE_M = Object.freeze({
  'ee-elevation': 30, // FABDEM 1″ (3DEP's 10 m only in the US)
  'ee-terrain-slope': 30,
  'ee-terrain-aspect': 30,
  'ee-terrain-hillshade': 30,
  'ee-forest-loss': 30,
  'ee-forest-types': 10,
  'ee-population': 100,
  'ee-surface-water': 30,
  'ee-land-cover': 10,
  'ee-buildings': 10,
  'ee-tree-canopy': 10,
  'ee-inundation': 250,
  'ee-census-tracts': 100,
  'wikipedia-coverage': 5_000,
});

/** The ground size (m) of a pixel at a Web Mercator zoom, at the equator. */
const pixelAtZoomM = (z) => 156_543.03 / 2 ** z;

const isRasterRecord = (record) => record?.kind === 'image' && !record.contour;

/** The ids the Lego mode can build, in the panel's order. */
export const LEGO_LAYER_IDS = Object.freeze([
  ...EARTH_ENGINE_LAYERS.filter(isRasterRecord).map((record) => record.id),
  CENSUS_LAYER_ID,
  WIKIPEDIA_LAYER_ID,
]);

export function isLegoLayer(id) {
  return LEGO_LAYER_IDS.includes(id);
}

function storedMode(storage, key) {
  if (!key) return '';
  try {
    return storage?.getItem(key) || '';
  } catch {
    return '';
  }
}

/** The mode a layer is drawn in now (its own storage key), or ''. */
export function currentMode(layerId, storage) {
  const record = EARTH_ENGINE_LAYERS.find((entry) => entry.id === layerId);
  if (!record?.modes?.length) return '';
  const stored = storedMode(storage, record.modeStorageKey);
  return modeRecord(record, stored)?.key || record.modes[0].key;
}

/**
 * How a layer's columns are coloured and scaled: {palette, scale, min,
 * max, nativeM, elevation}. `min` and `max` default to the values header's
 * legend range (`withHeader`); elevation uses its own hypsometric ramp,
 * shown by the square root of the height (the layer's `transform`).
 */
export function layerSpec(layerId, modeKey = '') {
  if (layerId === WIKIPEDIA_LAYER_ID)
    return {
      palette: RAMP_STOPS.map(rgbToHex),
      scale: 'log',
      nativeM: NATIVE_M[layerId],
      elevation: false,
    };
  const record = EARTH_ENGINE_LAYERS.find((entry) => entry.id === layerId);
  if (!record) return null;
  const mode = record.modes?.length ? modeRecord(record, modeKey) : null;
  const vis = mode?.vis || record.vis || null;
  const legend = mode?.legend || record.legend || [];
  const palette = vis?.palette?.length
    ? vis.palette.map((hex) => `#${String(hex).slice(0, 6)}`)
    : legend.map((entry) => entry.color);
  const nativeM =
    NATIVE_M[layerId] ?? pixelAtZoomM(Number(record.maxZoom) || 12);
  if (layerId === ELEVATION_LAYER_ID)
    return {
      palette,
      // The stops sit on the square root of the height: 0 to 6,400 m.
      scale: 'sqrt',
      min: 0,
      max: (vis?.max ?? 80) ** 2,
      nativeM,
      elevation: true,
    };
  const log = Boolean(mode?.log10 || record.log10);
  return {
    palette,
    scale: log ? 'log' : record.transform === 'sqrt' ? 'sqrt' : 'linear',
    nativeM,
    elevation: false,
  };
}

/** A spec with the values header's legend range filled in where it has none. */
export function withHeader(spec, header) {
  const min = Number.isFinite(spec.min) ? spec.min : Number(header.legendMin);
  const max = Number.isFinite(spec.max) ? spec.max : Number(header.legendMax);
  // A header may say its own scale (a log legend).
  const scale = header.scale || spec.scale;
  return { ...spec, min, max, scale };
}
