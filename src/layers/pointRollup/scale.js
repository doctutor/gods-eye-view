// Personal fork: the point rollup's colour scale (src/maps/colourScale.js).
// A rollup hex is its layer's accent at an alpha from its count, on a log
// ramp up to the fullest cell (rollup.js cellAlpha). With a scale the count
// window is the user's: a floor and a ceiling in cameras (places, assets)
// per hex, log or linear, the alpha running from ROLLUP_ALPHA_MIN at the
// floor to ROLLUP_ALPHA_MAX at the ceiling, and optionally a palette in
// place of the accent; HIDE OUTSIDE drops the hexes (and their counts)
// outside the window. Until a user changes it the rollup draws as before.

import {
  colourAtPosition,
  defineScaleDefaults,
  formatScaleValue,
  isDefaultScale,
  scaleKey,
  scalePosition,
} from '../../maps/colourScale.js';
import { ROLLUP_ALPHA_MAX, ROLLUP_ALPHA_MIN, countLabel } from './rollup.js';

/** The mode a rollup's scale is kept under: `<layer id>:rollup`. */
export const ROLLUP_SCALE_MODE = 'rollup';
const FALLBACK_ACCENT = '#39d5ff';

/** A layer's rollup scale key. */
export const rollupScaleKey = (layerId) => scaleKey(layerId, ROLLUP_SCALE_MODE);

/** The alpha at a position on the count window, 0 to 1. */
export const rollupAlphaAt = (t) =>
  ROLLUP_ALPHA_MIN + (ROLLUP_ALPHA_MAX - ROLLUP_ALPHA_MIN) * t;

/** The automatic count window: one point to the fullest cell. */
export const rollupAuto = (maxCount) => ({
  min: 1,
  max: Math.max(2, Number(maxCount) || 0),
});

const hexRgb = (hex) =>
  [1, 3, 5].map((at) => parseInt(String(hex).slice(at, at + 2), 16) || 0);

// The accent each layer's rollup draws in now (a layer's category or asset
// type changes it); the 'default' palette reads it when it paints.
const accents = new Map();
const registered = new Map();

/** Record the accent a layer's rollup is drawing in. */
export function setRollupAccent(layerId, accent) {
  if (/^#[0-9a-f]{6}$/i.test(String(accent)))
    accents.set(rollupScaleKey(layerId), accent);
}

/**
 * A layer's rollup scale defaults: log, the layer's accent at the alpha
 * ramp as its own palette, counts as the units' numbers.
 */
export function rollupScaleDefaults(layerId) {
  const key = rollupScaleKey(layerId);
  if (!registered.has(key))
    registered.set(
      key,
      defineScaleDefaults({
        scale: 'log',
        colourAt: (t) => [
          ...hexRgb(accents.get(key) || FALLBACK_ACCENT),
          Math.round(255 * rollupAlphaAt(t)),
        ],
        format: (value) =>
          value >= 1000
            ? countLabel(Math.round(value))
            : formatScaleValue(value),
      }),
    );
  return registered.get(key);
}

/**
 * A count's fill under a changed scale: [r, g, b] and an alpha (0 to 1) from
 * where the count sits on the window, or null when it is hidden (outside
 * the window with HIDE OUTSIDE). Inverting flips the colour, not the alpha:
 * a fuller hex stays the more opaque.
 */
export function rollupFill(model, defaults, count, maxCount) {
  const t = scalePosition(model, count, rollupAuto(maxCount));
  if (!Number.isFinite(t)) return null;
  const [r, g, b] = colourAtPosition(model, defaults, t);
  return { rgb: [r, g, b], alpha: rollupAlphaAt(model.invert ? 1 - t : t) };
}

/** A layer's rollup scale when a user has changed it, else null. */
export function rollupScaleModel(store, layerId) {
  if (!store) return null;
  const key = rollupScaleKey(layerId);
  const defaults = rollupScaleDefaults(layerId);
  const model = store.get(key, defaults);
  return isDefaultScale(model, defaults) ? null : model;
}
