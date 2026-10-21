// Personal fork: the Wikipedia coverage layer's colour scales
// (src/maps/colourScale.js), one per variant: its own inferno-like ramp
// (ramp.js) on a log mapping as the default, so an untouched layer paints
// exactly as before.

import {
  createScalePainter,
  defineScaleDefaults,
  isDefaultScale,
  scaleKey,
} from '../../maps/colourScale.js';
import {
  RAMP_STOPS,
  formatValue,
  paintTile,
  rampColor,
  rampPosition,
} from './ramp.js';

export const WIKIPEDIA_SCALE_LAYER = 'wikipedia-coverage';

/** Each variant's units on the legend and the window's inputs. */
const UNITS = Object.freeze({
  articles: 'per km²',
  text: 'B/km²',
  count: 'articles',
  capita: 'per 100k',
  textcapita: 'B/person',
});
const BYTES = new Set(['text', 'textcapita']);

const cache = new Map();
/** A variant's scale defaults (made once). */
export function wikipediaScaleDefaults(variant) {
  if (!cache.has(variant))
    cache.set(
      variant,
      defineScaleDefaults({
        scale: 'log',
        units: UNITS[variant] || '',
        colourAt: rampColor,
        stops: RAMP_STOPS,
        format: BYTES.has(variant)
          ? (value) => formatValue(value, { bytes: true }).replace(/ B$/, '')
          : (value) => formatValue(value),
      }),
    );
  return cache.get(variant);
}

export const wikipediaScaleKey = (variant) =>
  scaleKey(WIKIPEDIA_SCALE_LAYER, variant);

/**
 * How a variant's values are coloured now: {model, isDefault, paint(values,
 * out) → painted, colourOf(value) → [r, g, b, a] | null}. The default goes
 * through ramp.js itself (byte for byte what it always painted).
 */
export function wikipediaColouring(store, variant, domain) {
  const defaults = wikipediaScaleDefaults(variant);
  const model = store.get(wikipediaScaleKey(variant), defaults);
  if (isDefaultScale(model, defaults))
    return {
      model,
      isDefault: true,
      paint: (values, out) => paintTile(values, domain, out),
      colourOf: (value) => {
        const t = rampPosition(value, domain);
        return Number.isFinite(t) ? rampColor(t) : null;
      },
    };
  const painter = createScalePainter(model, defaults, domain);
  return {
    model,
    isDefault: false,
    paint: painter.paint,
    colourOf: (value) => {
      const colour = painter.colourOf(value);
      return colour[3] > 0 ? colour : null;
    },
  };
}
