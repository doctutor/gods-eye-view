/**
 * Personal fork: the Census tracts layer's colour scales for the modes the
 * local server draws (HOUSEHOLD INCOME, SURFACE TEMPERATURE), shared by the
 * client (the tile URL carries a changed scale) and the server (which
 * draws the tracts in it). The default is the classed colours of
 * censusTracts.js, unchanged; a changed scale colours each tract by its
 * value on the scale, at the classes' 78% opacity. Pure.
 */

import {
  decodeScaleFields,
  defineScaleDefaults,
  encodeScaleFields,
  isDefaultScale,
  normalizeScale,
  scaleColour,
  scaleKey,
} from '../maps/colourScale.js';
import {
  CENSUS_MODE_STYLES,
  INCOME_ALPHA,
  INCOME_CLASSES,
  LST_CLASSES,
  NO_ESTIMATE_COLOR,
} from './censusTracts.js';

export const CENSUS_SCALE_LAYER = 'ee-census-tracts';

/**
 * Each mode's fixed window (the classes' first and last breaks, with room
 * for the open ends) and the slider's bounds (the tracts' values).
 */
const MODES = Object.freeze({
  income: Object.freeze({
    units: 'USD',
    classes: INCOME_CLASSES,
    range: Object.freeze({ min: 20_000, max: 170_000 }),
    bounds: Object.freeze({ min: 0, max: 250_000 }),
    format: (value) =>
      value >= 1000 ? `$${Math.round(value / 1000)}k` : `$${Math.round(value)}`,
  }),
  lst: Object.freeze({
    units: '°C',
    classes: LST_CLASSES,
    range: Object.freeze({ min: 20, max: 55 }),
    bounds: Object.freeze({ min: 0, max: 70 }),
    format: (value) => String(Math.round(value * 10) / 10),
  }),
});

const cache = new Map();
/** A local mode's scale defaults (made once), or null for another mode. */
export function censusScaleDefaults(mode) {
  const spec = MODES[mode];
  if (!spec) return null;
  if (!cache.has(mode)) {
    const { color } = CENSUS_MODE_STYLES[mode];
    const { min, max } = spec.range;
    const rgba = (hex) =>
      [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
    cache.set(
      mode,
      defineScaleDefaults({
        scale: 'linear',
        units: spec.units,
        range: spec.range,
        // The classes along the window: what 'default' paints when the
        // window or mapping changes.
        colourAt: (t) => rgba(color(min + t * (max - min))),
        stops: spec.classes.map((entry) => `#${entry.color}`),
        format: spec.format,
      }),
    );
  }
  return cache.get(mode);
}

/** The slider's bounds for a mode (the tracts' values). */
export const censusScaleBounds = (mode) => MODES[mode]?.bounds || null;

export const censusScaleKey = (mode) => scaleKey(CENSUS_SCALE_LAYER, mode);

/**
 * The tile request's scale token for a mode's scale, '' at the default
 * (the classed tiles, cached as before).
 */
export function censusScaleToken(model, mode) {
  const defaults = censusScaleDefaults(mode);
  if (!defaults || !model || isDefaultScale(model, defaults)) return '';
  return encodeScaleFields(model);
}

/** A tile request's token back to a checked scale, or null (the default). */
export function censusScaleFromToken(token, mode) {
  const defaults = censusScaleDefaults(mode);
  if (!defaults || !token || !/^[a-z0-9.p-]{1,80}$/.test(token)) return null;
  const raw = decodeScaleFields(String(token).split('.'));
  if (!raw) return null;
  const model = normalizeScale(raw, defaults);
  return isDefaultScale(model, defaults) ? null : model;
}

const alpha = parseInt(INCOME_ALPHA, 16);
/**
 * A tract's fill (RRGGBBAA) on a scale: the class colours' 78% opacity,
 * the no-estimate grey for a tract without a value, null (not drawn)
 * where the window hides it.
 */
export function censusScaleColor(model, mode, value) {
  if (!Number.isFinite(value)) return NO_ESTIMATE_COLOR;
  const defaults = censusScaleDefaults(mode);
  const [r, g, b, a] = scaleColour(model, defaults, value, defaults.range);
  if (!a) return null;
  return [r, g, b, Math.round((a / 255) * alpha)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('');
}
