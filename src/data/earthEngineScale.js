// Personal fork: a colour scale for an Earth Engine raster layer (the shared
// colour-scale model's choice, src/maps/colourScale.js: palette, floor and
// ceiling, log, linear or sqrt, invert, outside clamp or hide), as the Earth
// Engine side needs it: each layer's default scale in its own units (and
// the model's defaults built from it), the URL token that carries a choice
// to the server's tile route (the model's hash fields), the concrete scale
// it resolves to there, and its window in the space the provider draws in.
// Shared by the client (src/layers/earthEngine/) and the server
// (server/providers/earthEngine.js); no Cesium, no DOM.
// docs/colour-scales.md has the table.

import { EARTH_ENGINE_LAYERS, modeRecord } from './earthEngineLayers.js';
import {
  decodeScaleFields,
  defineScaleDefaults,
  encodeScaleFields,
  isDefaultScale,
  normalizeScale,
  paletteStopsHex,
  resolveWindow,
} from '../maps/colourScale.js';

export const SCALE_KINDS = Object.freeze(['linear', 'log', 'sqrt']);
export const OUTSIDE_MODES = Object.freeze(['clamp', 'hide']);
/** The most palette stops a scale may carry. */
export const MAX_PALETTE_STOPS = 32;

/** Each windowable layer's units (the floor and ceiling are in these). */
const UNITS = Object.freeze({
  'ee-elevation': 'm',
  'ee-terrain-slope': '°',
  'ee-terrain-aspect': '° from north',
  'ee-terrain-hillshade': 'brightness 0–255',
  'ee-forest-loss': 'year − 2000',
  'ee-population': 'people/km²',
  'ee-surface-water|occurrence': '% of months',
  'ee-surface-water|change': 'percentage points',
  'ee-surface-water|seasonality': 'months a year',
  'ee-buildings|count': 'buildings/km²',
  'ee-buildings|cover': 'share built (0–1)',
  'ee-buildings|height': 'm',
  'ee-tree-canopy': 'm',
  'ee-inundation|count': 'floods',
  'ee-inundation|duration': 'days',
});
/** Ramps centred on zero (the model keeps 0 in the middle unless both ends move). */
const DIVERGING = new Set(['ee-surface-water|change']);
/** Circular palettes: a window cuts the circle. */
const CIRCULAR = new Set(['ee-terrain-aspect']);

/**
 * Slider bounds wider than the default window, where the data runs past
 * it (in the layer's units); else the slider spans the default window.
 */
const SLIDER_BOUNDS = Object.freeze({
  'ee-elevation': { min: 0, max: 8850 },
  'ee-terrain-slope': { min: 0, max: 90 },
  'ee-surface-water|change': { min: -100, max: 100 },
  'ee-surface-water|occurrence': { min: 0, max: 100 },
  'ee-surface-water|seasonality': { min: 0, max: 12 },
  'ee-buildings|cover': { min: 0, max: 1 },
  'ee-buildings|height': { min: 0, max: 100 },
  'ee-tree-canopy': { min: 0, max: 60 },
  'ee-population': { min: 0.1, max: 100000 },
  'ee-buildings|count': { min: 0.1, max: 100000 },
  'ee-inundation|duration': { min: 0.1, max: 1000 },
});

const scaleKey = (layerId, modeKey) =>
  modeKey && modeKey !== 'default' ? `${layerId}|${modeKey}` : layerId;

/** The transform a layer (mode) is drawn with natively. */
function nativeScale(layer, mode) {
  const steps = { ...layer, ...(mode || {}) };
  if (steps.log10) return 'log';
  if (layer.transform === 'sqrt') return 'sqrt';
  return 'linear';
}

/** A drawn-space value back in the layer's units. */
function fromDrawn(value, scale) {
  if (scale === 'log') return 10 ** value;
  if (scale === 'sqrt') return value * value;
  return value;
}

const round = (value) => Number(Number(value).toPrecision(6));

/** Whether a layer (mode) has a continuous ramp a window can apply to. */
export function isWindowable(layer, mode) {
  if (!layer || layer.kind === 'features' || layer.contour) return false;
  const steps = { ...layer, ...(mode || {}) };
  if (steps.remap || mode?.local) return false;
  const vis = mode?.vis || layer.vis;
  return Boolean(vis && vis.palette?.length >= 2 && vis.max > vis.min);
}

/**
 * Every windowable layer's default scale, keyed by "<layer>" or
 * "<layer>|<mode>": {layerId, modeKey, units, floor, ceiling, scale,
 * palette: ['#rrggbb'], invert: false, outside: 'clamp', diverging?,
 * centre?, circular?}, in the layer's units.
 */
export const EE_SCALE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    EARTH_ENGINE_LAYERS.flatMap((layer) => {
      const modes = layer.modes?.length ? layer.modes : [null];
      return modes
        .filter((mode) => isWindowable(layer, mode))
        .map((mode) => {
          const key = scaleKey(layer.id, mode?.key);
          const vis = mode?.vis || layer.vis;
          const scale = nativeScale(layer, mode);
          return [
            key,
            Object.freeze({
              layerId: layer.id,
              modeKey: mode?.key || '',
              units: UNITS[key] || UNITS[layer.id] || '',
              floor: round(fromDrawn(vis.min, scale)),
              ceiling: round(fromDrawn(vis.max, scale)),
              scale,
              palette: Object.freeze(
                vis.palette.map((hex) => `#${String(hex).slice(0, 6)}`),
              ),
              invert: false,
              outside: 'clamp',
              ...(DIVERGING.has(key) ? { diverging: true, centre: 0 } : {}),
              ...(CIRCULAR.has(key) ? { circular: true } : {}),
            }),
          ];
        });
    }),
  ),
);

/** A layer (mode)'s default scale, or null when it has no window. */
export function defaultScale(layerId, modeKey = '') {
  return (
    EE_SCALE_DEFAULTS[scaleKey(layerId, modeKey)] ||
    EE_SCALE_DEFAULTS[layerId] ||
    null
  );
}

const HEX = /^#?([0-9a-f]{6})$/i;

/**
 * A concrete scale (the window and stops resolved) checked and made
 * canonical, or null: finite floor below ceiling (positive on a log scale,
 * not negative on sqrt), a known scale kind, 2 to 32 hex stops (lower-case,
 * no '#'), invert a boolean, outside clamp or hide.
 * @returns {{floor: number, ceiling: number, scale: string,
 *   palette: string[], invert: boolean, outside: string}|null}
 */
export function normalizeDrawnScale(input) {
  if (!input || typeof input !== 'object') return null;
  const floor = Number(input.floor);
  const ceiling = Number(input.ceiling);
  const scale = SCALE_KINDS.includes(input.scale) ? input.scale : null;
  if (!scale || !Number.isFinite(floor) || !Number.isFinite(ceiling))
    return null;
  if (!(floor < ceiling)) return null;
  if (scale === 'log' && !(floor > 0)) return null;
  if (scale === 'sqrt' && floor < 0) return null;
  const stops = Array.isArray(input.palette) ? input.palette : [];
  if (stops.length < 2 || stops.length > MAX_PALETTE_STOPS) return null;
  const palette = [];
  for (const stop of stops) {
    const match = HEX.exec(String(stop));
    if (!match) return null;
    palette.push(match[1].toLowerCase());
  }
  return {
    floor: round(floor),
    ceiling: round(ceiling),
    scale,
    palette,
    invert: input.invert === true,
    outside: input.outside === 'hide' ? 'hide' : 'clamp',
  };
}

/**
 * A concrete scale's cache key (the server's map key and nothing else):
 * floor~ceiling~scale~invert~outside~stop.stop.…; '' for none.
 */
export function drawnScaleKey(input) {
  const scale = normalizeDrawnScale(input);
  if (!scale) return '';
  return [
    scale.floor,
    scale.ceiling,
    scale.scale,
    scale.invert ? 1 : 0,
    scale.outside === 'hide' ? 'h' : 'c',
    scale.palette.join('.'),
  ].join('~');
}

const modelDefaults = new Map();
/**
 * The shared model's defaults for a layer (mode) (defineScaleDefaults:
 * its scale kind, units, stops and fixed range), or null when it has no
 * window. The panel and the store register these.
 */
export function eeScaleDefaults(layerId, modeKey = '') {
  const base = defaultScale(layerId, modeKey);
  if (!base) return null;
  const key = scaleKey(base.layerId, base.modeKey);
  if (!modelDefaults.has(key))
    modelDefaults.set(
      key,
      defineScaleDefaults({
        scale: base.scale,
        units: base.units,
        stops: base.palette,
        range: { min: base.floor, max: base.ceiling },
        outside: base.outside,
      }),
    );
  return modelDefaults.get(key);
}

/** A layer (mode)'s slider bounds for the colour-scale widget, or null. */
export function eeSliderRange(layerId, modeKey = '') {
  const base = defaultScale(layerId, modeKey);
  if (!base) return null;
  const bounds =
    SLIDER_BOUNDS[scaleKey(base.layerId, base.modeKey)] ||
    SLIDER_BOUNDS[base.layerId];
  return bounds ? { ...bounds } : { min: base.floor, max: base.ceiling };
}

/**
 * A model's choice resolved for the provider: the window (its floor and
 * ceiling, else the layer's fixed range; a log window over a range that
 * starts at zero starts three decades below the ceiling) and its stops;
 * null for a layer without a window or a default (untouched) choice.
 */
export function concreteScale(layerId, modeKey, model) {
  const defaults = eeScaleDefaults(layerId, modeKey);
  if (!defaults || !model || !takesScale(layerId, modeKey)) return null;
  const chosen = normalizeScale(model, defaults);
  if (isDefaultScale(chosen, defaults)) return null;
  let auto = defaults.range;
  if (chosen.scale === 'log' && !(auto.min > 0))
    auto = { min: auto.max / 1000, max: auto.max };
  const window = resolveWindow(chosen, auto);
  if (!window) return null;
  return normalizeDrawnScale({
    floor: window.floor,
    ceiling: window.ceiling,
    scale: chosen.scale,
    palette: paletteStopsHex(chosen, defaults),
    invert: chosen.invert,
    outside: chosen.outside,
  });
}

/**
 * The tile route's `s` for a model's choice: the model's own hash fields
 * (palette.floor.ceiling.flags, URL-safe); '' for the layer's own look
 * (no window, no choice, the default).
 */
export function encodeScaleToken(layerId, modeKey, model) {
  const defaults = eeScaleDefaults(layerId, modeKey);
  if (!defaults || !model || !takesScale(layerId, modeKey)) return '';
  const chosen = normalizeScale(model, defaults);
  if (isDefaultScale(chosen, defaults)) return '';
  return encodeScaleFields(chosen);
}

/** A route token back to a concrete scale for the layer (mode), or null for anything malformed. */
export function decodeScaleToken(layerId, modeKey, token) {
  const text = String(token ?? '');
  if (!text || text.length > 200 || !/^[a-z0-9.p-]+$/i.test(text)) return null;
  const raw = decodeScaleFields(text.split('.'));
  return raw ? concreteScale(layerId, modeKey, raw) : null;
}

/**
 * The window in the space the provider draws in, and the stops in order:
 * {min, max, palette, transform, hide}. Log → log10 of the ends, sqrt →
 * their roots; invert reverses the stops.
 */
export function drawnWindow(input) {
  const scale = normalizeDrawnScale(input);
  if (!scale) return null;
  const to = (value) =>
    scale.scale === 'log'
      ? Math.log10(value)
      : scale.scale === 'sqrt'
        ? Math.sqrt(value)
        : value;
  return {
    min: round(to(scale.floor)),
    max: round(to(scale.ceiling)),
    palette: scale.invert ? [...scale.palette].reverse() : [...scale.palette],
    transform: scale.scale,
    hide: scale.outside === 'hide',
  };
}

/** The layer record for an id (server and client both resolve through this). */
export function scaleLayerRecord(layerId) {
  return EARTH_ENGINE_LAYERS.find((layer) => layer.id === layerId) || null;
}

/** Whether a layer (mode) takes a chosen scale at all. */
export function takesScale(layerId, modeKey = '') {
  const layer = scaleLayerRecord(layerId);
  if (!layer) return false;
  const mode = layer.modes?.length ? modeRecord(layer, modeKey) : null;
  return isWindowable(layer, mode);
}
